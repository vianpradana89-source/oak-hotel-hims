import { Router } from 'express';
import type { Pool, PoolClient } from 'pg';
import {
  assertPropertyExists,
  assertRoomTypeCodeAvailable,
  assertRoomTypeBelongsToProperty,
  countActivePhysicalRooms,
  getFutureReservedPeak,
  getFutureReservedPeaks,
  httpError,
  lockRoomCategoryForAssignment,
  parsePropertyId,
  parseRoomTypePayload,
  roomMasterErrorResponse,
  writeRoomMasterAudit
} from './roomMasterService';

const ROOM_TYPE_LIST_SQL = `
  SELECT rt.id, rt.property_id, rt.code, rt.name, rt.description,
         rt.room_category_id, rcat.code AS room_category_code,
         rcat.name AS room_category_name, rcat.is_active AS room_category_is_active,
         rt.capacity AS max_occupancy, rt.capacity, rt.max_adults, rt.max_children,
         rt.bed_type, rt.base_rate, rt.is_active, rt.display_order,
         rt.created_at, rt.updated_at,
         COALESCE(rc.total_rooms, 0) AS physical_room_count,
         COALESCE(rc.active_rooms, 0) AS active_physical_rooms,
         COALESCE(ar.active_reservations, 0) AS active_reservation_count
  FROM room_types rt
  LEFT JOIN room_categories rcat ON rcat.id = rt.room_category_id
  LEFT JOIN (
    SELECT room_type_id,
           COUNT(*) AS total_rooms,
           COUNT(*) FILTER (WHERE COALESCE(is_active, TRUE)) AS active_rooms
    FROM rooms
    GROUP BY room_type_id
  ) rc ON rc.room_type_id = rt.id
  LEFT JOIN (
    SELECT rm.room_type_id, COUNT(*)::int AS active_reservations
    FROM reservations res
    JOIN rooms rm ON rm.id = res.room_id
    WHERE res.status IN ('BOOKED', 'CHECKED_IN')
    GROUP BY rm.room_type_id
  ) ar ON ar.room_type_id = rt.id
`;

function sendError(res: any, err: unknown) {
  const response = roomMasterErrorResponse(err);
  if (response.statusCode === 500) {
    console.error('Room Type API error', err);
  }
  return res.status(response.statusCode).json(response.body);
}

async function addCategoryFields(client: Pool | PoolClient, roomType: any): Promise<any> {
  if (roomType.room_category_id === null || roomType.room_category_id === undefined) {
    return {
      ...roomType,
      room_category_code: null,
      room_category_name: null,
      room_category_is_active: null
    };
  }
  const result = await client.query(
    'SELECT code, name, is_active FROM room_categories WHERE id = $1',
    [roomType.room_category_id]
  );
  const category = result.rows[0];
  return {
    ...roomType,
    room_category_code: category?.code ?? null,
    room_category_name: category?.name ?? null,
    room_category_is_active: category?.is_active ?? null
  };
}

export function createRoomTypesRouter(pool: Pool) {
  const router = Router();

  router.get('/', async (req: any, res: any) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id, 'property_id');
      await assertPropertyExists(pool, propertyId);

      const activeFilter = String(req.query.active || 'all').toLowerCase();
      const params: any[] = [propertyId];
      let sql = `${ROOM_TYPE_LIST_SQL} WHERE rt.property_id = $1`;
      if (activeFilter === 'true') {
        sql += ` AND rt.is_active`;
      } else if (activeFilter === 'false') {
        sql += ` AND NOT rt.is_active`;
      }
      sql += ` ORDER BY rt.display_order, rt.id`;
      const result = await pool.query(sql, params);
      const peaks = await getFutureReservedPeaks(pool);
      const data = result.rows.map((row: any) => ({
        ...row,
        future_reserved_peak: peaks.get(Number(row.id)) ?? 0
      }));
      return res.json({ status: 'OK', data });
    } catch (err: unknown) {
      return sendError(res, err);
    }
  });

  router.get('/:id', async (req: any, res: any) => {
    const typeId = Number(req.params.id);
    if (!Number.isInteger(typeId) || typeId <= 0) {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid room type id' });
    }
    try {
      const propertyId = parsePropertyId(req.query.property_id, 'property_id');
      await assertPropertyExists(pool, propertyId);
      await assertRoomTypeBelongsToProperty(pool, typeId, propertyId);
      const result = await pool.query(`${ROOM_TYPE_LIST_SQL} WHERE rt.id = $1`, [typeId]);
      if ((result.rowCount ?? 0) === 0) {
        return res.status(404).json({ status: 'ERROR', code: 'NOT_FOUND', message: `room type ${typeId} not found` });
      }
      const row = result.rows[0];
      const futureReservedPeak = await getFutureReservedPeak(pool, typeId);
      return res.json({ status: 'OK', data: { ...row, future_reserved_peak: futureReservedPeak } });
    } catch (err: unknown) {
      return sendError(res, err);
    }
  });

  router.post('/', async (req: any, res: any) => {
    const client = await pool.connect();
    try {
      const payload = parseRoomTypePayload(req.body || {}, 'CREATE');
      const propertyId = parsePropertyId(req.body?.property_id, 'property_id');

      await client.query('BEGIN');
      await assertPropertyExists(client, propertyId);

      let roomCategory: any = null;
      if (payload.room_category_id !== undefined && payload.room_category_id !== null) {
        roomCategory = await lockRoomCategoryForAssignment(client, payload.room_category_id, propertyId, true);
      }

      if (payload.max_adults !== undefined && payload.capacity === undefined) {
        throw httpError(400, 'VALIDATION_ERROR', 'max_adults cannot exceed capacity');
      }

      const capacity = payload.capacity ?? 2;
      const maxAdults = payload.max_adults ?? capacity;
      if (maxAdults > capacity) {
        throw httpError(400, 'VALIDATION_ERROR', 'max_adults cannot exceed capacity');
      }

      await assertRoomTypeCodeAvailable(client, propertyId, payload.code!);

      const inserted = await client.query(
         `INSERT INTO room_types
           (property_id, code, name, room_category_id, description, base_rate, capacity, max_adults, max_children, bed_type, is_active, display_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, $11)
         RETURNING *`,
         [
           propertyId,
           payload.code,
           payload.name,
           payload.room_category_id ?? null,
           payload.description ?? null,
           payload.base_rate ?? 0,
           capacity,
           maxAdults,
           payload.max_children ?? 0,
           payload.bed_type ?? null,
           payload.display_order ?? 0
        ]
      );
      const created = inserted.rows[0];
      await writeRoomMasterAudit(client, {
        action: 'CREATE',
        entity: 'ROOM_TYPE',
        recordId: created.id,
        newValue: created
      });
      await client.query('COMMIT');
      return res.status(201).json({
        status: 'OK',
        data: {
          ...created,
          room_category_code: roomCategory?.code ?? null,
          room_category_name: roomCategory?.name ?? null,
          room_category_is_active: roomCategory?.is_active ?? null
        }
      });
    } catch (err: unknown) {
      try { await client.query('ROLLBACK'); } catch (_e) { /* noop */ }
      return sendError(res, err);
    } finally {
      client.release();
    }
  });

  router.patch('/:id', async (req: any, res: any) => {
    const typeId = Number(req.params.id);
    if (!Number.isInteger(typeId) || typeId <= 0) {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid room type id' });
    }
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.body?.property_id, 'property_id');
      const payload = parseRoomTypePayload(req.body || {}, 'UPDATE');
      const body = req.body || {};

      await client.query('BEGIN');
      await assertPropertyExists(client, propertyId);
      await assertRoomTypeBelongsToProperty(client, typeId, propertyId);

      const currentResult = await client.query('SELECT * FROM room_types WHERE id = $1 FOR UPDATE', [typeId]);
      if ((currentResult.rowCount ?? 0) === 0) {
        throw httpError(404, 'NOT_FOUND', `room type ${typeId} not found`);
      }
      const current = currentResult.rows[0];

      const nextCapacity = payload.capacity !== undefined ? payload.capacity : Number(current.capacity);
      const nextMaxAdults = payload.max_adults !== undefined ? payload.max_adults : Number(current.max_adults ?? current.capacity);
      if (nextMaxAdults > nextCapacity) {
        throw httpError(400, 'VALIDATION_ERROR', 'max_adults cannot exceed capacity');
      }

      if (payload.code !== undefined) {
        await assertRoomTypeCodeAvailable(client, current.property_id, payload.code, typeId);
      }

      if (payload.room_category_id !== undefined && payload.room_category_id !== null) {
        await lockRoomCategoryForAssignment(
          client,
          payload.room_category_id,
          current.property_id === null ? null : Number(current.property_id),
          Number(payload.room_category_id) !== Number(current.room_category_id)
        );
      }

      if (payload.capacity !== undefined && payload.capacity < Number(current.capacity)) {
        const peak = await getFutureReservedPeak(client, typeId);
        if (payload.capacity < peak) {
          throw httpError(409, 'CAPACITY_BELOW_RESERVED',
            `capacity ${payload.capacity} is below already-reserved quantity ${peak} for upcoming dates`);
        }
      }

      const assignments: string[] = [];
      const params: any[] = [];
      const setField = (column: string, value: unknown) => {
        params.push(value);
        assignments.push(`${column} = $${params.length}`);
      };

      if (payload.room_category_id !== undefined
          && Number(payload.room_category_id) !== Number(current.room_category_id)) {
        setField('room_category_id', payload.room_category_id);
      }

      for (const [column, key] of [
        ['code', 'code'],
        ['name', 'name'],
        ['description', 'description'],
        ['base_rate', 'base_rate'],
        ['capacity', 'capacity'],
        ['max_adults', 'max_adults'],
        ['max_children', 'max_children'],
        ['bed_type', 'bed_type'],
        ['display_order', 'display_order']
      ] as Array<[string, keyof typeof payload]>) {
        const value = payload[key];
        if (value !== undefined) {
          setField(column, value);
        }
      }

      let activationAction: string | null = null;
      if (body.is_active !== undefined && Boolean(body.is_active) !== Boolean(current.is_active)) {
        // RM-1C.1: never allow contradictory state — an inactive type must not
        // own active, sellable physical rooms. Require explicit room
        // deactivation first.
        if (!payload.is_active) {
          const attachedActiveRooms = await countActivePhysicalRooms(client, typeId);
          if (attachedActiveRooms > 0) {
            throw httpError(409, 'TYPE_HAS_ACTIVE_ROOMS',
              `room type ${current.code} still has ${attachedActiveRooms} active physical room(s); deactivate those rooms first`);
          }
        }
        setField('is_active', payload.is_active);
        activationAction = payload.is_active ? 'ACTIVATE' : 'DEACTIVATE';
      }

      if (assignments.length === 0) {
        throw httpError(400, 'VALIDATION_ERROR', 'no supported fields to update');
      }

      params.push(typeId);
      assignments.push(`updated_at = CURRENT_TIMESTAMP`);
      const updated = await client.query(
        `UPDATE room_types SET ${assignments.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params
      );
      const row = updated.rows[0];
      const responseRow = await addCategoryFields(client, row);

      await writeRoomMasterAudit(client, {
        action: activationAction ?? 'UPDATE',
        entity: 'ROOM_TYPE',
        recordId: typeId,
        newValue: {
          before: { room_category_id: current.room_category_id, is_active: current.is_active },
          after: { room_category_id: row.room_category_id, is_active: row.is_active },
          fields: Object.keys(payload)
        }
      });
      await client.query('COMMIT');
      return res.json({
        status: 'OK',
        data: responseRow,
        meta: row.is_active
          ? undefined
          : { note: 'deactivated; historical references preserved and new bookings are rejected' }
      });
    } catch (err: unknown) {
      try { await client.query('ROLLBACK'); } catch (_e) { /* noop */ }
      return sendError(res, err);
    } finally {
      client.release();
    }
  });

  // RM-1D Safe Delete: a Room Type may be permanently deleted ONLY when no
  // physical room and no inventory/ledger/lock dependency references it.
  // Historical availability rows are NEVER removed to make deletion succeed;
  // their presence is exactly what forces Nonaktifkan instead.
  router.delete('/:id', async (req: any, res: any) => {
    const typeId = Number(req.params.id);
    if (!Number.isInteger(typeId) || typeId <= 0) {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid room type id' });
    }
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.query.property_id, 'property_id');
      await client.query('BEGIN');
      await assertPropertyExists(client, propertyId);
      await assertRoomTypeBelongsToProperty(client, typeId, propertyId);
      const currentResult = await client.query('SELECT * FROM room_types WHERE id = $1 FOR UPDATE', [typeId]);
      if ((currentResult.rowCount ?? 0) === 0) {
        throw httpError(404, 'NOT_FOUND', `room type ${typeId} not found`);
      }
      const current = currentResult.rows[0];

      const roomRefs = await client.query(
        'SELECT COUNT(*)::int AS c FROM rooms WHERE room_type_id = $1',
        [typeId]
      );
      if (Number(roomRefs.rows[0].c) > 0) {
        throw httpError(409, 'ROOM_TYPE_HAS_ROOMS',
          `room type ${current.code} still has ${roomRefs.rows[0].c} physical room(s); deactivate or move them first`);
      }

      const ledgerRefs = await client.query(
        'SELECT COUNT(*)::int AS c FROM availability_dates WHERE room_type_id = $1',
        [typeId]
      );
      if (Number(ledgerRefs.rows[0].c) > 0) {
        throw httpError(409, 'ROOM_TYPE_HAS_HISTORY',
          `room type ${current.code} has ${ledgerRefs.rows[0].c} availability ledger row(s); permanent deletion is rejected`);
      }

      const lockRefs = await client.query(
        'SELECT COUNT(*)::int AS c FROM availability_locks WHERE room_type_id = $1',
        [typeId]
      );
      if (Number(lockRefs.rows[0].c) > 0) {
        throw httpError(409, 'ROOM_TYPE_HAS_HISTORY',
          `room type ${current.code} still has booking lock references; permanent deletion is rejected`);
      }

      const snapshotRefs = await client.query(
        'SELECT COUNT(*)::int AS c FROM reservations WHERE booked_room_type_id_snapshot = $1',
        [typeId]
      );
      if (Number(snapshotRefs.rows[0].c) > 0) {
        throw httpError(409, 'ROOM_TYPE_HAS_HISTORY',
          `room type ${current.code} is referenced by ${snapshotRefs.rows[0].c} reservation snapshot(s); permanent deletion is rejected`);
      }

      await client.query('DELETE FROM room_types WHERE id = $1', [typeId]);

      await writeRoomMasterAudit(client, {
        action: 'DELETE',
        entity: 'ROOM_TYPE',
        recordId: typeId,
        newValue: { code: current.code, name: current.name, property_id: current.property_id }
      });
      await client.query('COMMIT');
      return res.json({
        status: 'OK',
        data: { id: typeId },
        meta: { note: 'unused room type permanently deleted; no history existed' }
      });
    } catch (err: unknown) {
      try { await client.query('ROLLBACK'); } catch (_e) { /* noop */ }
      return sendError(res, err);
    } finally {
      client.release();
    }
  });

  return router;
}

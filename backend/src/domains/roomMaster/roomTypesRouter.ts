import { Router } from 'express';
import type { Pool } from 'pg';
import {
  assertRoomTypeCodeAvailable,
  countActivePhysicalRooms,
  getFutureReservedPeak,
  getFutureReservedPeaks,
  httpError,
  parseRoomTypePayload,
  writeRoomMasterAudit
} from './roomMasterService';

const ROOM_TYPE_LIST_SQL = `
  SELECT rt.id, rt.property_id, rt.code, rt.name, rt.description,
         rt.capacity AS max_occupancy, rt.capacity, rt.max_adults, rt.max_children,
         rt.bed_type, rt.base_rate, rt.is_active, rt.display_order,
         rt.created_at, rt.updated_at,
         COALESCE(rc.total_rooms, 0) AS physical_room_count,
         COALESCE(rc.active_rooms, 0) AS active_physical_rooms,
         COALESCE(ar.active_reservations, 0) AS active_reservation_count
  FROM room_types rt
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

export function createRoomTypesRouter(pool: Pool) {
  const router = Router();

  router.get('/', async (req: any, res: any) => {
    try {
      const activeFilter = String(req.query.active || 'all').toLowerCase();
      const params: any[] = [];
      let sql = ROOM_TYPE_LIST_SQL;
      if (activeFilter === 'true') {
        sql += ` WHERE rt.is_active`;
      } else if (activeFilter === 'false') {
        sql += ` WHERE NOT rt.is_active`;
      }
      sql += ` ORDER BY rt.display_order, rt.id`;
      const result = await pool.query(sql, params);
      const peaks = await getFutureReservedPeaks(pool);
      const data = result.rows.map((row: any) => ({
        ...row,
        future_reserved_peak: peaks.get(Number(row.id)) ?? 0
      }));
      return res.json({ status: 'OK', data });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message });
    }
  });

  router.get('/:id', async (req: any, res: any) => {
    const typeId = Number(req.params.id);
    if (!Number.isInteger(typeId) || typeId <= 0) {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid room type id' });
    }
    try {
      const result = await pool.query(`${ROOM_TYPE_LIST_SQL} WHERE rt.id = $1`, [typeId]);
      if ((result.rowCount ?? 0) === 0) {
        return res.status(404).json({ status: 'ERROR', code: 'NOT_FOUND', message: `room type ${typeId} not found` });
      }
      const row = result.rows[0];
      const futureReservedPeak = await getFutureReservedPeak(pool, typeId);
      return res.json({ status: 'OK', data: { ...row, future_reserved_peak: futureReservedPeak } });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message });
    }
  });

  router.post('/', async (req: any, res: any) => {
    const client = await pool.connect();
    try {
      const payload = parseRoomTypePayload(req.body || {}, 'CREATE');

      await client.query('BEGIN');
      const propertyResult = await client.query('SELECT id FROM properties ORDER BY id LIMIT 1');
      if ((propertyResult.rowCount ?? 0) === 0) {
        throw httpError(409, 'PROPERTY_MISSING', 'no property exists to attach the room type to');
      }
      const propertyId = Number(propertyResult.rows[0].id);

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
           (property_id, code, name, description, base_rate, capacity, max_adults, max_children, bed_type, is_active, display_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10)
         RETURNING *`,
        [
          propertyId,
          payload.code,
          payload.name,
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
      return res.status(201).json({ status: 'OK', data: created });
    } catch (err: any) {
      try { await client.query('ROLLBACK'); } catch (_e) { /* noop */ }
      if (err && typeof err.statusCode === 'number' && err.code) {
        return res.status(err.statusCode).json({ status: err.statusCode === 409 ? 'CONFLICT' : 'ERROR', code: err.code, message: err.message });
      }
      return res.status(500).json({ status: 'ERROR', message: err.message });
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
      const payload = parseRoomTypePayload(req.body || {}, 'UPDATE');
      const body = req.body || {};

      await client.query('BEGIN');
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

      await writeRoomMasterAudit(client, {
        action: activationAction ?? 'UPDATE',
        entity: 'ROOM_TYPE',
        recordId: typeId,
        newValue: { before: { is_active: current.is_active }, after: { is_active: row.is_active }, fields: Object.keys(payload) }
      });
      await client.query('COMMIT');
      return res.json({
        status: 'OK',
        data: row,
        meta: row.is_active
          ? undefined
          : { note: 'deactivated; historical references preserved and new bookings are rejected' }
      });
    } catch (err: any) {
      try { await client.query('ROLLBACK'); } catch (_e) { /* noop */ }
      if (err && typeof err.statusCode === 'number' && err.code) {
        return res.status(err.statusCode).json({ status: err.statusCode === 409 ? 'CONFLICT' : 'ERROR', code: err.code, message: err.message });
      }
      return res.status(500).json({ status: 'ERROR', message: err.message });
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
      await client.query('BEGIN');
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
    } catch (err: any) {
      try { await client.query('ROLLBACK'); } catch (_e) { /* noop */ }
      if (err && typeof err.statusCode === 'number' && err.code) {
        return res.status(err.statusCode).json({ status: err.statusCode === 409 ? 'CONFLICT' : 'ERROR', code: err.code, message: err.message });
      }
      return res.status(500).json({ status: 'ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  return router;
}

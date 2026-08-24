import { Router } from 'express';
import type { Pool } from 'pg';
import {
  assertDeactivationInventorySafe,
  countActiveReservationsForRoom,
  getActivePhysicalCapacity,
  httpError,
  syncLedgerCapacityFromMaster,
  writeRoomMasterAudit
} from './roomMasterService';

function normalizeRoomNumber(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  if (value.length < 1 || value.length > 20) {
    return null;
  }
  return value;
}

export function createRoomsRouter(pool: Pool) {
  const router = Router();

  router.get('/:id', async (req: any, res: any) => {
    const roomId = Number(req.params.id);
    if (!Number.isInteger(roomId) || roomId <= 0) {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid room id' });
    }
    try {
      const result = await pool.query(
        `SELECT r.id, r.property_id, r.room_number, r.room_type_id, rt.code AS room_type_code,
                COALESCE(rt.name, r.name) AS room_type_name,
                rt.is_active AS room_type_is_active,
                r.floor, r.status, r.notes, r.name AS legacy_name,
                r.is_active, r.created_at, r.updated_at
         FROM rooms r
         LEFT JOIN room_types rt ON rt.id = r.room_type_id
         WHERE r.id = $1`,
        [roomId]
      );
      if ((result.rowCount ?? 0) === 0) {
        return res.status(404).json({ status: 'ERROR', code: 'NOT_FOUND', message: `room ${roomId} not found` });
      }
      const activeCount = await countActiveReservationsForRoom(pool, roomId);
      return res.json({ status: 'OK', data: { ...result.rows[0], active_reservation_count: activeCount } });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message });
    }
  });

  router.post('/', async (req: any, res: any) => {
    const client = await pool.connect();
    try {
      const body = req.body || {};
      const roomNumber = normalizeRoomNumber(body.room_number);
      if (!roomNumber) {
        throw httpError(400, 'VALIDATION_ERROR', 'room_number is required (1-20 characters)');
      }
      const typeId = Number(body.room_type_id);
      if (!Number.isInteger(typeId) || typeId <= 0) {
        throw httpError(400, 'VALIDATION_ERROR', 'room_type_id is required and must be a positive integer');
      }

      const floor = body.floor === undefined ? null : String(body.floor).trim().slice(0, 10) || null;
      let notes: string | null | undefined;
      if (body.notes !== undefined) {
        notes = body.notes === null ? null : String(body.notes).trim().slice(0, 500) || null;
      }

      await client.query('BEGIN');
      const typeResult = await client.query('SELECT * FROM room_types WHERE id = $1 FOR UPDATE', [typeId]);
      if ((typeResult.rowCount ?? 0) === 0) {
        throw httpError(404, 'NOT_FOUND', `room type ${typeId} not found`);
      }
      const roomType = typeResult.rows[0];
      if (!roomType.is_active) {
        throw httpError(409, 'ROOM_TYPE_INACTIVE', `room type ${roomType.code} (${roomType.name}) is inactive`);
      }
      const propertyId = Number(roomType.property_id);

      const duplicate = await client.query(
        'SELECT id FROM rooms WHERE property_id IS NOT DISTINCT FROM $1 AND room_number = $2',
        [propertyId, roomNumber]
      );
      if ((duplicate.rowCount ?? 0) > 0) {
        throw httpError(409, 'ROOM_NUMBER_EXISTS', `room number ${roomNumber} already exists for this property`);
      }

      const inserted = await client.query(
        `INSERT INTO rooms (property_id, room_number, room_type_id, name, floor, notes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [propertyId, roomNumber, typeId, roomType.name, floor, notes ?? null]
      );
      const created = inserted.rows[0];
      await writeRoomMasterAudit(client, {
        action: 'CREATE',
        entity: 'ROOM',
        recordId: created.id,
        newValue: created
      });
      // RM-1C.1: physical capacity grew by one; align today/future ledger rows.
      await syncLedgerCapacityFromMaster(client, typeId);
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
    const roomId = Number(req.params.id);
    if (!Number.isInteger(roomId) || roomId <= 0) {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid room id' });
    }
    const client = await pool.connect();
    try {
      const body = req.body || {};

      await client.query('BEGIN');
      const currentResult = await client.query('SELECT * FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
      if ((currentResult.rowCount ?? 0) === 0) {
        throw httpError(404, 'NOT_FOUND', `room ${roomId} not found`);
      }
      const current = currentResult.rows[0];

      const assignments: string[] = [];
      const params: any[] = [];
      const setField = (column: string, value: unknown) => {
        params.push(value);
        assignments.push(`${column} = $${params.length}`);
      };

      let nextRoomNumber = current.room_number;
      if (body.room_number !== undefined) {
        const roomNumber = normalizeRoomNumber(body.room_number);
        if (!roomNumber) {
          throw httpError(400, 'VALIDATION_ERROR', 'room_number must be 1-20 characters');
        }
        if (roomNumber !== current.room_number) {
          const duplicate = await client.query(
            'SELECT id FROM rooms WHERE property_id IS NOT DISTINCT FROM $1 AND room_number = $2 AND id <> $3',
            [current.property_id, roomNumber, roomId]
          );
          if ((duplicate.rowCount ?? 0) > 0) {
            throw httpError(409, 'ROOM_NUMBER_EXISTS', `room number ${roomNumber} already exists for this property`);
          }
          setField('room_number', roomNumber);
          nextRoomNumber = roomNumber;
        }
      }

      if (body.floor !== undefined) {
        setField('floor', body.floor === null ? null : String(body.floor).trim().slice(0, 10) || null);
      }
      if (body.notes !== undefined) {
        setField('notes', body.notes === null ? null : String(body.notes).trim().slice(0, 500) || null);
      }

      let typeChangeApplied = false;
      if (body.room_type_id !== undefined && Number(body.room_type_id) !== Number(current.room_type_id)) {
        const targetTypeId = Number(body.room_type_id);
        if (!Number.isInteger(targetTypeId) || targetTypeId <= 0) {
          throw httpError(400, 'VALIDATION_ERROR', 'room_type_id must be a positive integer');
        }
        const targetTypeResult = await client.query('SELECT * FROM room_types WHERE id = $1 FOR UPDATE', [targetTypeId]);
        if ((targetTypeResult.rowCount ?? 0) === 0) {
          throw httpError(404, 'NOT_FOUND', `room type ${targetTypeId} not found`);
        }
        const targetType = targetTypeResult.rows[0];
        if (!targetType.is_active) {
          throw httpError(409, 'ROOM_TYPE_INACTIVE', `room type ${targetType.code} (${targetType.name}) is inactive`);
        }
        const activeReservations = await countActiveReservationsForRoom(client, roomId);
        if (activeReservations > 0) {
          throw httpError(409, 'ROOM_HAS_ACTIVE_RESERVATIONS',
            `room ${current.room_number} has ${activeReservations} active reservation(s); cancel or complete them before changing the room type`);
        }
        // RM-1C.1: the donor type loses one active room; ensure its ledger stays safe.
        const donorTypeId = current.room_type_id === null ? null : Number(current.room_type_id);
        if (donorTypeId !== null && Number(donorTypeId) !== Number(targetTypeId)) {
          const donorCapacity = await getActivePhysicalCapacity(client, donorTypeId);
          if (Number(current.is_active)) {
            await assertDeactivationInventorySafe(client, donorTypeId, donorCapacity - 1);
          }
        }
        setField('room_type_id', targetTypeId);
        setField('name', targetType.name);
        typeChangeApplied = true;
      }

      const deactivating = body.is_active !== undefined && !Boolean(body.is_active) && Boolean(current.is_active);
      const activating = body.is_active !== undefined && Boolean(body.is_active) && !Boolean(current.is_active);

      if (deactivating) {
        const activeReservations = await countActiveReservationsForRoom(client, roomId);
        if (activeReservations > 0) {
          throw httpError(409, 'ROOM_HAS_ACTIVE_RESERVATIONS',
            `room ${current.room_number} still holds ${activeReservations} active reservation(s); move, cancel or complete them before deactivating`);
        }
        const typeIdForDeactivation = current.room_type_id === null ? null : Number(current.room_type_id);
        if (typeIdForDeactivation !== null) {
          const resultingCapacity = (await getActivePhysicalCapacity(client, typeIdForDeactivation)) - 1;
          await assertDeactivationInventorySafe(client, typeIdForDeactivation, resultingCapacity);
        }
      }

      if (activating && current.room_type_id !== null && current.room_type_id !== undefined) {
        const ownerType = await client.query('SELECT is_active, code, name FROM room_types WHERE id = $1', [Number(current.room_type_id)]);
        if ((ownerType.rowCount ?? 0) > 0 && !ownerType.rows[0].is_active) {
          throw httpError(409, 'ROOM_TYPE_INACTIVE',
            `cannot activate room ${current.room_number}: room type ${ownerType.rows[0].code} (${ownerType.rows[0].name}) is inactive`);
        }
      }

      let activationAction: string | null = null;
      if (body.is_active !== undefined && Boolean(body.is_active) !== Boolean(current.is_active)) {
        params.push(Boolean(body.is_active));
        assignments.push(`is_active = $${params.length}`);
        activationAction = Boolean(body.is_active) ? 'ACTIVATE' : 'DEACTIVATE';
      }

      if (assignments.length === 0) {
        throw httpError(400, 'VALIDATION_ERROR', 'no supported fields to update');
      }

      params.push(roomId);
      assignments.push(`updated_at = CURRENT_TIMESTAMP`);
      const updated = await client.query(
        `UPDATE rooms SET ${assignments.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params
      );
      const row = updated.rows[0];

      // RM-1C.1: re-align ledger capacity for every affected room type.
      const affectedTypeIds = new Set<number>();
      if (current.room_type_id !== null && current.room_type_id !== undefined) {
        affectedTypeIds.add(Number(current.room_type_id));
      }
      if (row.room_type_id !== null && row.room_type_id !== undefined) {
        affectedTypeIds.add(Number(row.room_type_id));
      }
      for (const typeId of affectedTypeIds) {
        await syncLedgerCapacityFromMaster(client, typeId);
      }

      await writeRoomMasterAudit(client, {
        action: activationAction ?? (typeChangeApplied ? 'CHANGE_TYPE' : 'UPDATE'),
        entity: 'ROOM',
        recordId: roomId,
        newValue: {
          before: { room_type_id: current.room_type_id, is_active: current.is_active },
          after: { room_type_id: row.room_type_id, is_active: row.is_active, room_number: row.room_number },
          fields: Object.keys(body)
        }
      });
      await client.query('COMMIT');
      return res.json({
        status: 'OK',
        data: row,
        meta: row.is_active
          ? undefined
          : { note: 'deactivated; existing reservations remain valid and new bookings are rejected' }
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

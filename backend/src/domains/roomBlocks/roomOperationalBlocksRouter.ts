import { Router } from 'express';
import type { Pool } from 'pg';
import {
  assertMaintenanceTaskBelongsToProperty,
  assertPropertyExists,
  assertRoomBelongsToProperty,
  assertRoomTypeBelongsToProperty,
  assertSellableCapacitySafe,
  findActiveRoomBlockOverlap,
  findActiveRoomReservationOverlap,
  getTodayJakartaDate,
  httpError,
  normalizeHotelDate,
  parsePropertyId,
  writeRoomBlockAudit
} from './roomOperationalBlocksService';

export function createRoomOperationalBlocksRouter(pool: Pool) {
  const router = Router();

  // GET /api/room-operational-blocks
  router.get('/', async (req: any, res: any) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id, 'property_id');
      await assertPropertyExists(pool, propertyId);

      const conditions: string[] = ['b.property_id = $1'];
      const params: any[] = [propertyId];

      if (req.query.room_id !== undefined) {
        const roomId = Number(req.query.room_id);
        if (!Number.isInteger(roomId) || roomId <= 0) {
          throw httpError(400, 'VALIDATION_ERROR', 'invalid room_id');
        }
        params.push(roomId);
        conditions.push(`b.room_id = $${params.length}`);
      }

      if (req.query.room_type_id !== undefined) {
        const typeId = Number(req.query.room_type_id);
        if (!Number.isInteger(typeId) || typeId <= 0) {
          throw httpError(400, 'VALIDATION_ERROR', 'invalid room_type_id');
        }
        params.push(typeId);
        conditions.push(`b.room_type_id = $${params.length}`);
      }

      if (req.query.block_type !== undefined) {
        const bType = String(req.query.block_type).trim().toUpperCase();
        if (!['OUT_OF_ORDER', 'OUT_OF_SERVICE'].includes(bType)) {
          throw httpError(400, 'VALIDATION_ERROR', 'invalid block_type filter');
        }
        params.push(bType);
        conditions.push(`b.block_type = $${params.length}`);
      }

      if (req.query.status !== undefined) {
        const stat = String(req.query.status).trim().toUpperCase();
        if (stat !== 'ALL') {
          if (!['ACTIVE', 'RELEASED', 'CANCELLED'].includes(stat)) {
            throw httpError(400, 'VALIDATION_ERROR', 'invalid status filter');
          }
          params.push(stat);
          conditions.push(`b.status = $${params.length}`);
        }
      }

      if (req.query.start_date !== undefined) {
        const sDate = normalizeHotelDate(req.query.start_date);
        if (!sDate) throw httpError(400, 'VALIDATION_ERROR', 'invalid start_date filter');
        params.push(sDate);
        conditions.push(`b.end_date > $${params.length}::date`);
      }

      if (req.query.end_date !== undefined) {
        const eDate = normalizeHotelDate(req.query.end_date);
        if (!eDate) throw httpError(400, 'VALIDATION_ERROR', 'invalid end_date filter');
        params.push(eDate);
        conditions.push(`b.start_date < $${params.length}::date`);
      }

      const query = `
        SELECT b.id, b.property_id, b.room_id, b.room_type_id,
               b.block_type, to_char(b.start_date, 'YYYY-MM-DD') AS start_date,
               to_char(b.end_date, 'YYYY-MM-DD') AS end_date,
               b.reason, b.maintenance_task_id, b.status,
               b.created_by, b.created_at, b.released_by, b.released_at,
               r.room_number,
               rt.code AS room_type_code,
               rt.name AS room_type_name
        FROM room_operational_blocks b
        JOIN rooms r ON r.id = b.room_id
        JOIN room_types rt ON rt.id = b.room_type_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY b.start_date DESC, b.id DESC
      `;

      const result = await pool.query(query, params);
      return res.json({ status: 'OK', data: result.rows });
    } catch (err: any) {
      if (err && typeof err.statusCode === 'number' && err.code) {
        return res.status(err.statusCode).json({
          status: err.statusCode === 409 ? 'CONFLICT' : 'ERROR',
          code: err.code,
          message: err.message
        });
      }
      return res.status(500).json({ status: 'ERROR', message: err.message });
    }
  });

  // POST /api/room-operational-blocks
  router.post('/', async (req: any, res: any) => {
    const client = await pool.connect();
    try {
      const body = req.body || {};
      const propertyId = parsePropertyId(body.property_id, 'property_id');
      await assertPropertyExists(client, propertyId);

      const roomId = Number(body.room_id);
      if (!Number.isInteger(roomId) || roomId <= 0) {
        throw httpError(400, 'VALIDATION_ERROR', 'room_id is required and must be a positive integer');
      }

      const blockType = String(body.block_type || '').trim().toUpperCase();
      if (!['OUT_OF_ORDER', 'OUT_OF_SERVICE'].includes(blockType)) {
        throw httpError(400, 'VALIDATION_ERROR', 'block_type must be either OUT_OF_ORDER or OUT_OF_SERVICE');
      }

      const startDate = normalizeHotelDate(body.start_date);
      const endDate = normalizeHotelDate(body.end_date);
      if (!startDate) {
        throw httpError(400, 'VALIDATION_ERROR', 'start_date is required (YYYY-MM-DD)');
      }
      if (!endDate) {
        throw httpError(400, 'VALIDATION_ERROR', 'end_date is required (YYYY-MM-DD)');
      }
      if (endDate <= startDate) {
        throw httpError(400, 'VALIDATION_ERROR', 'end_date must be strictly greater than start_date');
      }

      const reason = body.reason === undefined || body.reason === null
        ? null
        : String(body.reason).trim().slice(0, 255) || null;

      let maintenanceTaskId: number | null = null;
      if (body.maintenance_task_id !== undefined && body.maintenance_task_id !== null) {
        maintenanceTaskId = Number(body.maintenance_task_id);
        if (!Number.isInteger(maintenanceTaskId) || maintenanceTaskId <= 0) {
          throw httpError(400, 'VALIDATION_ERROR', 'maintenance_task_id must be a positive integer');
        }
      }

      const createdBy = body.created_by ? String(body.created_by).trim().slice(0, 100) : 'FRONT_OFFICE';

      await client.query('BEGIN');

      // 1. Transactionally lock room row
      const roomResult = await client.query('SELECT * FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
      if ((roomResult.rowCount ?? 0) === 0) {
        throw httpError(404, 'ROOM_NOT_FOUND', `room ${roomId} not found`);
      }
      const room = roomResult.rows[0];
      if (room.property_id != null && Number(room.property_id) !== propertyId) {
        throw httpError(403, 'PROPERTY_MISMATCH', `room ${roomId} does not belong to property ${propertyId}`);
      }

      const roomTypeId = Number(room.room_type_id);
      if (!Number.isInteger(roomTypeId) || roomTypeId <= 0) {
        throw httpError(409, 'ROOM_HAS_NO_TYPE', `room ${room.room_number} does not have a canonical room type assigned`);
      }

      // If room_type_id explicitly passed in body, it must match current room's room_type_id snapshot
      if (body.room_type_id !== undefined && body.room_type_id !== null) {
        const requestedTypeId = Number(body.room_type_id);
        if (requestedTypeId !== roomTypeId) {
          throw httpError(
            400,
            'VALIDATION_ERROR',
            `room_type_id mismatch: room ${room.room_number} belongs to type ${roomTypeId}, got ${requestedTypeId}`
          );
        }
      }

      // 2. Validate room type
      const roomType = await assertRoomTypeBelongsToProperty(client, roomTypeId, propertyId);

      // 3. Validate maintenance task if provided
      if (maintenanceTaskId !== null) {
        await assertMaintenanceTaskBelongsToProperty(client, maintenanceTaskId, propertyId);
      }

      // 4. Overlap Check: Active Reservations
      const reservationOverlaps = await findActiveRoomReservationOverlap(client, roomId, startDate, endDate);
      if (reservationOverlaps.length > 0) {
        const res = reservationOverlaps[0];
        throw httpError(
          409,
          'ROOM_HAS_ACTIVE_RESERVATIONS',
          `room ${room.room_number} has active reservation (${res.guest_name}, ${res.check_in} to ${res.check_out}) overlapping [${startDate}, ${endDate})`
        );
      }

      // 5. Overlap Check: Existing Active Operational Blocks
      const blockOverlaps = await findActiveRoomBlockOverlap(client, roomId, startDate, endDate);
      if (blockOverlaps.length > 0) {
        const b = blockOverlaps[0];
        throw httpError(
          409,
          'OVERLAPPING_BLOCK',
          `room ${room.room_number} already has an active ${b.block_type} block overlapping [${startDate}, ${endDate})`
        );
      }

      // 6. Capacity Underflow Protection across span
      await assertSellableCapacitySafe(client, roomTypeId, startDate, endDate);

      // 7. Insert block record
      const inserted = await client.query(
        `INSERT INTO room_operational_blocks (
           property_id, room_id, room_type_id, block_type,
           start_date, end_date, reason, maintenance_task_id,
           status, created_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE', $9)
         RETURNING *`,
        [propertyId, roomId, roomTypeId, blockType, startDate, endDate, reason, maintenanceTaskId, createdBy]
      );

      const createdBlock = inserted.rows[0];

      // 8. Audit log
      await writeRoomBlockAudit(client, {
        action: 'CREATE',
        blockId: createdBlock.id,
        newValue: {
          room_id: roomId,
          room_number: room.room_number,
          room_type_id: roomTypeId,
          room_type_code: roomType.code,
          block_type: blockType,
          start_date: startDate,
          end_date: endDate,
          reason,
          maintenance_task_id: maintenanceTaskId,
          created_by: createdBy
        },
        propertyId,
        correlationId: req.headers['x-correlation-id'] || null
      });

      await client.query('COMMIT');

      const responseData = {
        ...createdBlock,
        start_date: startDate,
        end_date: endDate,
        room_number: room.room_number,
        room_type_code: roomType.code,
        room_type_name: roomType.name
      };

      return res.status(201).json({ status: 'OK', data: responseData });
    } catch (err: any) {
      try { await client.query('ROLLBACK'); } catch (_e) { /* noop */ }
      if (err && typeof err.statusCode === 'number' && err.code) {
        return res.status(err.statusCode).json({
          status: err.statusCode === 409 ? 'CONFLICT' : 'ERROR',
          code: err.code,
          message: err.message
        });
      }
      return res.status(500).json({ status: 'ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // PATCH /api/room-operational-blocks/:id/release
  router.patch('/:id/release', async (req: any, res: any) => {
    const blockId = Number(req.params.id);
    if (!Number.isInteger(blockId) || blockId <= 0) {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid block id' });
    }

    const client = await pool.connect();
    try {
      const body = req.body || {};
      const propertyId = parsePropertyId(body.property_id, 'property_id');
      await assertPropertyExists(client, propertyId);

      const releasedBy = body.released_by ? String(body.released_by).trim().slice(0, 100) : 'FRONT_OFFICE';
      const releaseDate = body.effective_release_date
        ? normalizeHotelDate(body.effective_release_date)
        : (body.released_at_date ? normalizeHotelDate(body.released_at_date) : getTodayJakartaDate());

      if (!releaseDate) {
        throw httpError(400, 'VALIDATION_ERROR', 'invalid effective_release_date');
      }

      await client.query('BEGIN');

      const blockResult = await client.query(
        'SELECT * FROM room_operational_blocks WHERE id = $1 FOR UPDATE',
        [blockId]
      );
      if ((blockResult.rowCount ?? 0) === 0) {
        throw httpError(404, 'NOT_FOUND', `block ${blockId} not found`);
      }

      const block = blockResult.rows[0];
      if (Number(block.property_id) !== propertyId) {
        throw httpError(403, 'PROPERTY_MISMATCH', `block ${blockId} does not belong to property ${propertyId}`);
      }

      if (block.status !== 'ACTIVE') {
        throw httpError(409, 'BLOCK_NOT_ACTIVE', `block ${blockId} is already ${block.status}`);
      }

      const blockStart = normalizeHotelDate(block.start_date)!;
      const blockEnd = normalizeHotelDate(block.end_date)!;

      let nextStatus: string = 'RELEASED';
      let nextEndDate: string = blockEnd;

      if (releaseDate <= blockStart) {
        // Released on or before start date: 0 room nights were blocked. Void / Cancel.
        nextStatus = 'CANCELLED';
        nextEndDate = blockEnd;
      } else if (releaseDate < blockEnd) {
        // Early release during active span: shorten end_date to effective release date
        nextStatus = 'RELEASED';
        nextEndDate = releaseDate;
      } else {
        // Released on or after scheduled end date
        nextStatus = 'RELEASED';
        nextEndDate = blockEnd;
      }

      const updated = await client.query(
        `UPDATE room_operational_blocks
         SET status = $1,
             end_date = $2,
             released_by = $3,
             released_at = CURRENT_TIMESTAMP
         WHERE id = $4
         RETURNING *`,
        [nextStatus, nextEndDate, releasedBy, blockId]
      );

      const updatedBlock = updated.rows[0];

      await writeRoomBlockAudit(client, {
        action: nextStatus === 'CANCELLED' ? 'CANCEL' : 'RELEASE',
        blockId,
        newValue: {
          before: {
            status: block.status,
            start_date: blockStart,
            end_date: blockEnd
          },
          after: {
            status: updatedBlock.status,
            start_date: blockStart,
            end_date: nextEndDate,
            released_by: releasedBy,
            released_at: updatedBlock.released_at
          },
          effective_release_date: releaseDate,
          reason: body.reason || null
        },
        propertyId,
        correlationId: req.headers['x-correlation-id'] || null
      });

      await client.query('COMMIT');

      return res.json({
        status: 'OK',
        data: {
          ...updatedBlock,
          start_date: blockStart,
          end_date: nextEndDate
        }
      });
    } catch (err: any) {
      try { await client.query('ROLLBACK'); } catch (_e) { /* noop */ }
      if (err && typeof err.statusCode === 'number' && err.code) {
        return res.status(err.statusCode).json({
          status: err.statusCode === 409 ? 'CONFLICT' : 'ERROR',
          code: err.code,
          message: err.message
        });
      }
      return res.status(500).json({ status: 'ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // PATCH /api/room-operational-blocks/:id/cancel
  router.patch('/:id/cancel', async (req: any, res: any) => {
    const blockId = Number(req.params.id);
    if (!Number.isInteger(blockId) || blockId <= 0) {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid block id' });
    }

    const client = await pool.connect();
    try {
      const body = req.body || {};
      const propertyId = parsePropertyId(body.property_id, 'property_id');
      await assertPropertyExists(client, propertyId);

      const cancelledBy = body.cancelled_by ? String(body.cancelled_by).trim().slice(0, 100) : 'FRONT_OFFICE';

      await client.query('BEGIN');

      const blockResult = await client.query(
        'SELECT * FROM room_operational_blocks WHERE id = $1 FOR UPDATE',
        [blockId]
      );
      if ((blockResult.rowCount ?? 0) === 0) {
        throw httpError(404, 'NOT_FOUND', `block ${blockId} not found`);
      }

      const block = blockResult.rows[0];
      if (Number(block.property_id) !== propertyId) {
        throw httpError(403, 'PROPERTY_MISMATCH', `block ${blockId} does not belong to property ${propertyId}`);
      }

      if (block.status === 'CANCELLED') {
        throw httpError(409, 'BLOCK_ALREADY_CANCELLED', `block ${blockId} is already CANCELLED`);
      }

      if (block.status === 'RELEASED') {
        throw httpError(409, 'BLOCK_ALREADY_RELEASED', `block ${blockId} has already been RELEASED; historical blocks cannot be cancelled`);
      }

      const hotelToday = getTodayJakartaDate();
      const blockStart = normalizeHotelDate(block.start_date)!;

      if (hotelToday >= blockStart) {
        throw httpError(
          409,
          'BLOCK_ALREADY_EFFECTIVE',
          `cannot cancel block ${blockId} because it is already effective (start_date: ${blockStart}, today: ${hotelToday}); use release endpoint instead`
        );
      }

      const updated = await client.query(
        `UPDATE room_operational_blocks
         SET status = 'CANCELLED',
             released_by = $1,
             released_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING *`,
        [cancelledBy, blockId]
      );

      const updatedBlock = updated.rows[0];

      await writeRoomBlockAudit(client, {
        action: 'CANCEL',
        blockId,
        newValue: {
          before: {
            status: block.status,
            start_date: blockStart,
            end_date: normalizeHotelDate(block.end_date)
          },
          after: {
            status: 'CANCELLED',
            start_date: blockStart,
            end_date: normalizeHotelDate(block.end_date),
            cancelled_by: cancelledBy,
            cancelled_at: updatedBlock.released_at
          },
          reason: body.reason || null
        },
        propertyId,
        correlationId: req.headers['x-correlation-id'] || null
      });

      await client.query('COMMIT');

      return res.json({
        status: 'OK',
        data: {
          ...updatedBlock,
          start_date: blockStart,
          end_date: normalizeHotelDate(block.end_date)
        }
      });
    } catch (err: any) {
      try { await client.query('ROLLBACK'); } catch (_e) { /* noop */ }
      if (err && typeof err.statusCode === 'number' && err.code) {
        return res.status(err.statusCode).json({
          status: err.statusCode === 409 ? 'CONFLICT' : 'ERROR',
          code: err.code,
          message: err.message
        });
      }
      return res.status(500).json({ status: 'ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  return router;
}

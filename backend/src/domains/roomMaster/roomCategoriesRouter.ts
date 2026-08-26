import { Router } from 'express';
import type { Pool } from 'pg';
import {
  assertCategoryBelongsToProperty,
  assertPropertyExists,
  assertRoomCategoryUnique,
  httpError,
  parsePropertyId,
  parseRoomCategoryPayload,
  roomMasterErrorResponse,
  writeRoomMasterAudit
} from './roomMasterService';

const ROOM_CATEGORY_READ_SQL = `
  SELECT rc.id, rc.property_id, rc.code, rc.name, rc.description,
         rc.is_active, rc.display_order,
         rc.created_at, rc.updated_at,
         (SELECT COUNT(*)::int FROM room_types rt WHERE rt.room_category_id = rc.id) AS room_type_count,
         (SELECT COUNT(*)::int
            FROM rooms r
            JOIN room_types rt ON rt.id = r.room_type_id
           WHERE rt.room_category_id = rc.id) AS physical_room_count,
          (SELECT COUNT(*)::int FROM reservations res WHERE res.booked_room_category_id_snapshot = rc.id) AS reservation_snapshot_count
  FROM room_categories rc
`;

function sendError(res: any, err: unknown) {
  const response = roomMasterErrorResponse(err);
  if (response.statusCode === 500) {
    console.error('Room Category API error', err);
  }
  return res.status(response.statusCode).json(response.body);
}

function parsePositiveId(raw: unknown, label: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw httpError(400, 'VALIDATION_ERROR', `invalid ${label}`);
  }
  return value;
}

export function createRoomCategoriesRouter(pool: Pool) {
  const router = Router();

  router.get('/', async (req: any, res: any) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id, 'property_id');
      await assertPropertyExists(pool, propertyId);

      const activeFilter = String(req.query.active ?? 'all').toLowerCase();
      if (!['all', 'true', 'false'].includes(activeFilter)) {
        throw httpError(400, 'VALIDATION_ERROR', 'active must be all, true, or false');
      }

      const params: any[] = [propertyId];
      const conditions: string[] = [`rc.property_id = $${params.length}`];
      if (activeFilter !== 'all') {
        params.push(activeFilter === 'true');
        conditions.push(`rc.is_active = $${params.length}`);
      }

      const where = ` WHERE ${conditions.join(' AND ')}`;
      const result = await pool.query(`${ROOM_CATEGORY_READ_SQL}${where} ORDER BY rc.display_order, rc.id`, params);
      return res.json({ status: 'OK', data: result.rows });
    } catch (err: unknown) {
      return sendError(res, err);
    }
  });

  router.get('/:id', async (req: any, res: any) => {
    try {
      const categoryId = parsePositiveId(req.params.id, 'room category id');
      const propertyId = parsePropertyId(req.query.property_id, 'property_id');
      await assertPropertyExists(pool, propertyId);
      await assertCategoryBelongsToProperty(pool, categoryId, propertyId);
      const result = await pool.query(`${ROOM_CATEGORY_READ_SQL} WHERE rc.id = $1`, [categoryId]);
      if ((result.rowCount ?? 0) === 0) {
        throw httpError(404, 'ROOM_CATEGORY_NOT_FOUND', `room category ${categoryId} not found`);
      }
      return res.json({ status: 'OK', data: result.rows[0] });
    } catch (err: unknown) {
      return sendError(res, err);
    }
  });

  router.post('/', async (req: any, res: any) => {
    const client = await pool.connect();
    try {
      const payload = parseRoomCategoryPayload(req.body || {}, 'CREATE');
      const propertyId = parsePropertyId(req.body?.property_id, 'property_id');

      await client.query('BEGIN');
      await assertPropertyExists(client, propertyId);

      await assertRoomCategoryUnique(client, propertyId, payload.code!, payload.name!);
      const nextOrderResult = await client.query(
        `SELECT COALESCE((FLOOR(MAX(display_order)::numeric / 10) + 1) * 10, 10)::int AS next_order
         FROM room_categories
         WHERE property_id = $1`,
        [propertyId]
      );
      const inserted = await client.query(
        `INSERT INTO room_categories (property_id, code, name, description, is_active, display_order)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          propertyId,
          payload.code,
          payload.name,
          payload.description ?? null,
          payload.is_active ?? true,
          payload.display_order ?? Number(nextOrderResult.rows[0].next_order)
        ]
      );
      const created = inserted.rows[0];
      await writeRoomMasterAudit(client, {
        action: 'CREATE',
        entity: 'ROOM_CATEGORY',
        recordId: created.id,
        newValue: created
      });
      await client.query('COMMIT');
      return res.status(201).json({ status: 'OK', data: created });
    } catch (err: unknown) {
      try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* noop */ }
      return sendError(res, err);
    } finally {
      client.release();
    }
  });

  router.patch('/reorder', async (req: any, res: any) => {
    const client = await pool.connect();
    try {
      const propertyId = req.body?.property_id;
      const categoryIds = req.body?.category_ids;
      if (typeof propertyId !== 'number' || !Number.isInteger(propertyId) || propertyId <= 0 || propertyId > 2147483647) {
        throw httpError(400, 'VALIDATION_ERROR', 'property_id must be a positive integer');
      }
      if (!Array.isArray(categoryIds) || categoryIds.length === 0) {
        throw httpError(400, 'VALIDATION_ERROR', 'category_ids must be a non-empty array');
      }
      if (categoryIds.some((id: unknown) => typeof id !== 'number' || !Number.isInteger(id) || id <= 0 || id > 2147483647)) {
        throw httpError(400, 'VALIDATION_ERROR', 'category_ids must contain only positive integers');
      }
      if (new Set(categoryIds).size !== categoryIds.length) {
        throw httpError(400, 'VALIDATION_ERROR', 'category_ids must not contain duplicates');
      }

      await client.query('BEGIN');
      const propertyResult = await client.query('SELECT id FROM properties WHERE id = $1 FOR UPDATE', [propertyId]);
      if ((propertyResult.rowCount ?? 0) === 0) {
        throw httpError(404, 'PROPERTY_NOT_FOUND', `property ${propertyId} not found`);
      }

      const currentResult = await client.query(
        `SELECT id, display_order
         FROM room_categories
         WHERE property_id = $1
         ORDER BY display_order, id
         FOR UPDATE`,
        [propertyId]
      );
      const currentIds = currentResult.rows.map((row) => Number(row.id));
      const currentIdSet = new Set(currentIds);
      if (categoryIds.length !== currentIds.length || categoryIds.some((id: number) => !currentIdSet.has(id))) {
        throw httpError(
          409,
          'ROOM_CATEGORY_REORDER_SET_MISMATCH',
          'category_ids must contain every category for the property exactly once'
        );
      }

      const beforeOrder = new Map(
        currentResult.rows.map((row) => [Number(row.id), Number(row.display_order)])
      );
      const updatedResult = await client.query(
        `WITH requested AS (
           SELECT category_id, (ordinality * 10)::int AS display_order
           FROM unnest($2::int[]) WITH ORDINALITY AS ordered(category_id, ordinality)
         )
         UPDATE room_categories rc
         SET display_order = requested.display_order,
             updated_at = CURRENT_TIMESTAMP
         FROM requested
         WHERE rc.property_id = $1
           AND rc.id = requested.category_id
           AND rc.display_order IS DISTINCT FROM requested.display_order
         RETURNING rc.id, rc.display_order`,
        [propertyId, categoryIds]
      );

      for (const row of updatedResult.rows) {
        await writeRoomMasterAudit(client, {
          action: 'REORDER',
          entity: 'ROOM_CATEGORY',
          recordId: row.id,
          newValue: {
            property_id: propertyId,
            before: { display_order: beforeOrder.get(Number(row.id)) },
            after: { display_order: Number(row.display_order) }
          }
        });
      }

      const orderedResult = await client.query(
        `${ROOM_CATEGORY_READ_SQL} WHERE rc.property_id = $1 ORDER BY rc.display_order, rc.id`,
        [propertyId]
      );
      await client.query('COMMIT');
      return res.json({ status: 'OK', data: orderedResult.rows });
    } catch (err: unknown) {
      try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* noop */ }
      return sendError(res, err);
    } finally {
      client.release();
    }
  });

  router.patch('/:id', async (req: any, res: any) => {
    const client = await pool.connect();
    try {
      const categoryId = parsePositiveId(req.params.id, 'room category id');
      const payload = parseRoomCategoryPayload(req.body || {}, 'UPDATE');

      await client.query('BEGIN');
      const ownerResult = await client.query('SELECT property_id FROM room_categories WHERE id = $1', [categoryId]);
      if ((ownerResult.rowCount ?? 0) === 0) {
        throw httpError(404, 'ROOM_CATEGORY_NOT_FOUND', `room category ${categoryId} not found`);
      }
      const propertyId = Number(ownerResult.rows[0].property_id);
      await client.query('SELECT id FROM properties WHERE id = $1 FOR UPDATE', [propertyId]);

      const currentResult = await client.query('SELECT * FROM room_categories WHERE id = $1 FOR UPDATE', [categoryId]);
      if ((currentResult.rowCount ?? 0) === 0) {
        throw httpError(404, 'ROOM_CATEGORY_NOT_FOUND', `room category ${categoryId} not found`);
      }
      const current = currentResult.rows[0];
      const nextCode = payload.code ?? current.code;
      const nextName = payload.name ?? current.name;
      if (payload.code !== undefined || payload.name !== undefined) {
        await assertRoomCategoryUnique(client, propertyId, nextCode, nextName, categoryId);
      }

      const assignments: string[] = [];
      const params: any[] = [];
      const setField = (column: string, value: unknown) => {
        params.push(value);
        assignments.push(`${column} = $${params.length}`);
      };
      if (payload.code !== undefined) setField('code', payload.code);
      if (payload.name !== undefined) setField('name', payload.name);
      if (payload.description !== undefined) setField('description', payload.description);
      if (payload.display_order !== undefined) setField('display_order', payload.display_order);
      if (payload.is_active !== undefined) setField('is_active', payload.is_active);
      if (assignments.length === 0) {
        throw httpError(400, 'VALIDATION_ERROR', 'no supported fields to update');
      }

      params.push(categoryId);
      assignments.push('updated_at = CURRENT_TIMESTAMP');
      const updated = await client.query(
        `UPDATE room_categories SET ${assignments.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params
      );
      const row = updated.rows[0];
      const activationChanged = Boolean(row.is_active) !== Boolean(current.is_active);
      await writeRoomMasterAudit(client, {
        action: activationChanged ? (row.is_active ? 'ACTIVATE' : 'DEACTIVATE') : 'UPDATE',
        entity: 'ROOM_CATEGORY',
        recordId: categoryId,
        newValue: {
          before: {
            code: current.code,
            name: current.name,
            description: current.description,
            display_order: current.display_order,
            is_active: current.is_active
          },
          after: {
            code: row.code,
            name: row.name,
            description: row.description,
            display_order: row.display_order,
            is_active: row.is_active
          },
          fields: Object.keys(payload)
        }
      });
      await client.query('COMMIT');
      return res.json({
        status: 'OK',
        data: row,
        meta: activationChanged
          ? { note: 'classification state changed; room types, rooms, reservations, and inventory were not altered' }
          : undefined
      });
    } catch (err: unknown) {
      try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* noop */ }
      return sendError(res, err);
    } finally {
      client.release();
    }
  });

  router.delete('/:id', async (req: any, res: any) => {
    const client = await pool.connect();
    try {
      const categoryId = parsePositiveId(req.params.id, 'room category id');
      const propertyId = parsePropertyId(req.query.property_id, 'property_id');

      await client.query('BEGIN');
      await assertPropertyExists(client, propertyId);
      await assertCategoryBelongsToProperty(client, categoryId, propertyId);
      const currentResult = await client.query('SELECT * FROM room_categories WHERE id = $1 FOR UPDATE', [categoryId]);
      if ((currentResult.rowCount ?? 0) === 0) {
        throw httpError(404, 'ROOM_CATEGORY_NOT_FOUND', `room category ${categoryId} not found`);
      }
      const current = currentResult.rows[0];

      const typeRefs = await client.query(
        'SELECT COUNT(*)::int AS c FROM room_types WHERE room_category_id = $1',
        [categoryId]
      );
      if (Number(typeRefs.rows[0].c) > 0) {
        throw httpError(409, 'ROOM_CATEGORY_HAS_ROOM_TYPES',
          `room category ${current.code} is referenced by ${typeRefs.rows[0].c} room type(s); permanent deletion is rejected`);
      }

      const snapshotRefs = await client.query(
        'SELECT COUNT(*)::int AS c FROM reservations WHERE booked_room_category_id_snapshot = $1',
        [categoryId]
      );
      if (Number(snapshotRefs.rows[0].c) > 0) {
        throw httpError(409, 'ROOM_CATEGORY_HAS_RESERVATION_HISTORY',
          `room category ${current.code} is referenced by ${snapshotRefs.rows[0].c} reservation snapshot(s); permanent deletion is rejected`);
      }

      await client.query('DELETE FROM room_categories WHERE id = $1', [categoryId]);
      await writeRoomMasterAudit(client, {
        action: 'DELETE',
        entity: 'ROOM_CATEGORY',
        recordId: categoryId,
        newValue: { code: current.code, name: current.name, property_id: current.property_id }
      });
      await client.query('COMMIT');
      return res.json({ status: 'OK', data: { id: categoryId } });
    } catch (err: unknown) {
      try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* noop */ }
      return sendError(res, err);
    } finally {
      client.release();
    }
  });

  return router;
}

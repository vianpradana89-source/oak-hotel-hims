import type { Pool, PoolClient } from 'pg';

export class RoomMasterHttpError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function httpError(statusCode: number, code: string, message: string): RoomMasterHttpError {
  return new RoomMasterHttpError(statusCode, code, message);
}

export function parsePropertyId(raw: unknown, label = 'property_id'): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw httpError(400, 'VALIDATION_ERROR', `invalid ${label}`);
  }
  return value;
}

export async function assertPropertyExists(
  client: PoolClient | Pool,
  propertyId: number
): Promise<void> {
  const result = await client.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
  if ((result.rowCount ?? 0) === 0) {
    throw httpError(404, 'PROPERTY_NOT_FOUND', `property ${propertyId} not found`);
  }
}

export async function assertRoomBelongsToProperty(
  client: PoolClient | Pool,
  roomId: number,
  propertyId: number
): Promise<void> {
  const result = await client.query(
    'SELECT id, property_id FROM rooms WHERE id = $1',
    [roomId]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw httpError(404, 'NOT_FOUND', `room ${roomId} not found`);
  }
  const roomPropertyId = result.rows[0].property_id;
  if (roomPropertyId != null && Number(roomPropertyId) !== propertyId) {
    throw httpError(403, 'PROPERTY_MISMATCH', `room ${roomId} does not belong to property ${propertyId}`);
  }
}

export async function assertReservationBelongsToProperty(
  client: PoolClient | Pool,
  reservationId: number,
  propertyId: number
): Promise<void> {
  const result = await client.query(
    `SELECT res.id, res.room_id, r.property_id AS room_property_id
     FROM reservations res
     JOIN rooms r ON r.id = res.room_id
     WHERE res.id = $1`,
    [reservationId]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw httpError(404, 'NOT_FOUND', `reservation ${reservationId} not found`);
  }
  const roomPropertyId = result.rows[0].room_property_id;
  if (roomPropertyId != null && Number(roomPropertyId) !== propertyId) {
    throw httpError(403, 'PROPERTY_MISMATCH', `reservation ${reservationId} does not belong to property ${propertyId}`);
  }
}

export async function assertCategoryBelongsToProperty(
  client: PoolClient | Pool,
  categoryId: number,
  propertyId: number
): Promise<void> {
  const result = await client.query(
    'SELECT id, property_id FROM room_categories WHERE id = $1',
    [categoryId]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw httpError(404, 'ROOM_CATEGORY_NOT_FOUND', `room category ${categoryId} not found`);
  }
  const catPropertyId = result.rows[0].property_id;
  if (catPropertyId != null && Number(catPropertyId) !== propertyId) {
    throw httpError(403, 'PROPERTY_MISMATCH', `room category ${categoryId} does not belong to property ${propertyId}`);
  }
}

export async function assertRoomTypeBelongsToProperty(
  client: PoolClient | Pool,
  typeId: number,
  propertyId: number
): Promise<void> {
  const result = await client.query(
    'SELECT id, property_id FROM room_types WHERE id = $1',
    [typeId]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw httpError(404, 'NOT_FOUND', `room type ${typeId} not found`);
  }
  const typePropertyId = result.rows[0].property_id;
  if (typePropertyId != null && Number(typePropertyId) !== propertyId) {
    throw httpError(403, 'PROPERTY_MISMATCH', `room type ${typeId} does not belong to property ${propertyId}`);
  }
}

const TYPE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,19}$/;
const CATEGORY_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,19}$/;

export function normalizeRoomTypeCode(raw: unknown): string | null {
  const value = String(raw ?? '').trim().toUpperCase();
  if (!TYPE_CODE_PATTERN.test(value)) {
    return null;
  }
  return value;
}

function toIntegerOrNull(raw: unknown): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return null;
  }
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

function toNonNegativeNumberOrNull(raw: unknown): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function boundedText(raw: unknown, maxLength: number): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const value = String(raw).trim();
  if (value.length > maxLength) {
    throw httpError(400, 'VALIDATION_ERROR', `text exceeds ${maxLength} characters`);
  }
  return value === '' ? null : value;
}

export type RoomTypeWriteModel = {
  code?: string;
  name?: string;
  room_category_id?: number | null;
  description?: string | null;
  capacity?: number;
  max_adults?: number;
  max_children?: number;
  bed_type?: string | null;
  display_order?: number;
  base_rate?: number;
};

export function parseRoomTypePayload(body: any, mode: 'CREATE' | 'UPDATE'): RoomTypeWriteModel & { is_active?: boolean } {
  const result: RoomTypeWriteModel & { is_active?: boolean } = {};
  const errors: string[] = [];

  if (mode === 'CREATE' || body.code !== undefined) {
    const code = normalizeRoomTypeCode(body.code);
    if (!code) {
      errors.push('code must match [A-Z0-9] followed by 1-19 characters of A-Z 0-9 _ -');
    } else {
      result.code = code;
    }
  }

  if (mode === 'CREATE' || body.name !== undefined) {
    const name = boundedText(body.name, 100);
    if (mode === 'CREATE' && !name) {
      errors.push('name is required');
    } else if (name !== undefined) {
      result.name = name as string;
    }
  }

  if (body.room_category_id !== undefined) {
    if (body.room_category_id === null) {
      result.room_category_id = null;
    } else {
      const categoryId = toIntegerOrNull(body.room_category_id);
      if (typeof body.room_category_id === 'boolean' || categoryId === null || categoryId <= 0) {
        errors.push('room_category_id must be a positive integer or null');
      } else {
        result.room_category_id = categoryId;
      }
    }
  }

  if (body.capacity !== undefined) {
    const capacity = toIntegerOrNull(body.capacity);
    if (capacity === null || capacity < 1 || capacity > 999) {
      errors.push('capacity must be an integer between 1 and 999');
    } else {
      result.capacity = capacity;
    }
  }

  if (body.max_adults !== undefined) {
    const maxAdults = toIntegerOrNull(body.max_adults);
    if (maxAdults === null || maxAdults < 1 || maxAdults > 999) {
      errors.push('max_adults must be an integer between 1 and 999');
    } else {
      result.max_adults = maxAdults;
    }
  }

  if (body.max_children !== undefined) {
    const maxChildren = toIntegerOrNull(body.max_children);
    if (maxChildren === null || maxChildren < 0 || maxChildren > 99) {
      errors.push('max_children must be an integer between 0 and 99');
    } else {
      result.max_children = maxChildren;
    }
  }

  if (errors.length > 0) {
    throw httpError(400, 'VALIDATION_ERROR', errors.join('; '));
  }

  if (result.max_adults !== undefined && result.capacity !== undefined && result.max_adults > result.capacity) {
    throw httpError(400, 'VALIDATION_ERROR', 'max_adults cannot exceed capacity');
  }

  const description = boundedText(body.description, 500);
  if (description !== undefined) {
    result.description = description;
  }
  const bedType = boundedText(body.bed_type, 50);
  if (bedType !== undefined) {
    result.bed_type = bedType;
  }

  if (body.display_order !== undefined) {
    const displayOrder = toIntegerOrNull(body.display_order);
    if (displayOrder === null || displayOrder < 0) {
      throw httpError(400, 'VALIDATION_ERROR', 'display_order must be a non-negative integer');
    }
    result.display_order = displayOrder;
  }

  if (body.base_rate !== undefined) {
    const baseRate = toNonNegativeNumberOrNull(body.base_rate);
    if (baseRate === null) {
      throw httpError(400, 'VALIDATION_ERROR', 'base_rate must be a non-negative number');
    }
    result.base_rate = baseRate;
  }

  if (body.is_active !== undefined) {
    result.is_active = Boolean(body.is_active);
  }

  return result;
}

export type RoomCategoryWriteModel = {
  code?: string;
  name?: string;
  description?: string | null;
  display_order?: number;
  is_active?: boolean;
};

export function parseRoomCategoryPayload(body: any, mode: 'CREATE' | 'UPDATE'): RoomCategoryWriteModel {
  const result: RoomCategoryWriteModel = {};
  const errors: string[] = [];

  if (mode === 'CREATE' || body.code !== undefined) {
    const code = String(body.code ?? '').trim().toUpperCase();
    if (!CATEGORY_CODE_PATTERN.test(code)) {
      errors.push('code must match [A-Z0-9] followed by 1-19 characters of A-Z 0-9 _ -');
    } else {
      result.code = code;
    }
  }

  if (mode === 'CREATE' || body.name !== undefined) {
    const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name) {
      errors.push('name is required');
    } else if (name.length > 100) {
      errors.push('name exceeds 100 characters');
    } else {
      result.name = name;
    }
  }

  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') {
      errors.push('is_active must be a boolean');
    } else {
      result.is_active = body.is_active;
    }
  }

  const description = boundedText(body.description, 500);
  if (description !== undefined) {
    result.description = description;
  }

  if (body.display_order !== undefined) {
    const displayOrder = toIntegerOrNull(body.display_order);
    if (displayOrder === null || displayOrder < 0) {
      errors.push('display_order must be a non-negative integer');
    } else {
      result.display_order = displayOrder;
    }
  }

  if (errors.length > 0) {
    throw httpError(400, 'VALIDATION_ERROR', errors.join('; '));
  }

  return result;
}

export async function assertRoomCategoryUnique(
  client: PoolClient | Pool,
  propertyId: number,
  code: string,
  name: string,
  excludeCategoryId?: number
): Promise<void> {
  const params: any[] = [propertyId, code, name];
  let excludeSql = '';
  if (excludeCategoryId !== undefined) {
    params.push(excludeCategoryId);
    excludeSql = ` AND id <> $${params.length}`;
  }

  const duplicate = await client.query(
    `SELECT code
     FROM room_categories
     WHERE property_id = $1
       AND (code = $2 OR LOWER(REGEXP_REPLACE(BTRIM(name), '[[:space:]]+', ' ', 'g')) = LOWER($3))
       ${excludeSql}
     ORDER BY CASE WHEN code = $2 THEN 0 ELSE 1 END
     LIMIT 1`,
    params
  );
  if ((duplicate.rowCount ?? 0) === 0) return;
  if (duplicate.rows[0].code === code) {
    throw httpError(409, 'ROOM_CATEGORY_CODE_EXISTS', `room category code ${code} already exists for this property`);
  }
  throw httpError(409, 'ROOM_CATEGORY_NAME_EXISTS', `room category name ${name} already exists for this property`);
}

export async function lockRoomCategoryForAssignment(
  client: PoolClient,
  categoryId: number,
  propertyId: number | null,
  rejectInactive: boolean
): Promise<any> {
  const result = await client.query('SELECT * FROM room_categories WHERE id = $1 FOR UPDATE', [categoryId]);
  if ((result.rowCount ?? 0) === 0) {
    throw httpError(404, 'ROOM_CATEGORY_NOT_FOUND', `room category ${categoryId} not found`);
  }
  const category = result.rows[0];
  if (propertyId === null || propertyId === undefined || Number(category.property_id) !== Number(propertyId)) {
    throw httpError(409, 'ROOM_CATEGORY_PROPERTY_MISMATCH', 'room category belongs to a different property');
  }
  if (rejectInactive && !category.is_active) {
    throw httpError(409, 'ROOM_CATEGORY_INACTIVE', `room category ${category.code} (${category.name}) is inactive`);
  }
  return category;
}

export function roomMasterErrorResponse(err: unknown): {
  statusCode: number;
  body: { status: string; code: string; message: string };
} {
  const candidate = err as any;
  if (candidate && typeof candidate.statusCode === 'number' && typeof candidate.code === 'string') {
    return {
      statusCode: candidate.statusCode,
      body: {
        status: candidate.statusCode === 409 ? 'CONFLICT' : 'ERROR',
        code: candidate.code,
        message: candidate.message
      }
    };
  }

  if (candidate?.code === '23505') {
    const constraint = String(candidate.constraint ?? '').toLowerCase();
    let code = 'ROOM_MASTER_DUPLICATE';
    let message = 'a Room Master record with the same unique value already exists';
    if (constraint.includes('room_categories') && constraint.includes('code')) {
      code = 'ROOM_CATEGORY_CODE_EXISTS';
      message = 'room category code already exists for this property';
    } else if (constraint.includes('room_categories') && constraint.includes('name')) {
      code = 'ROOM_CATEGORY_NAME_EXISTS';
      message = 'room category name already exists for this property';
    } else if (constraint.includes('room_types') && constraint.includes('code')) {
      code = 'ROOM_TYPE_CODE_EXISTS';
      message = 'room type code already exists for this property';
    }
    return { statusCode: 409, body: { status: 'CONFLICT', code, message } };
  }

  return {
    statusCode: 500,
    body: { status: 'ERROR', code: 'INTERNAL_ERROR', message: 'an unexpected Room Master error occurred' }
  };
}

export async function assertRoomTypeCodeAvailable(
  client: PoolClient | Pool,
  propertyId: number | null,
  code: string,
  excludeTypeId?: number
): Promise<void> {
  const params: any[] = [propertyId, code];
  let sql = `SELECT id FROM room_types WHERE property_id IS NOT DISTINCT FROM $1 AND code = $2`;
  if (excludeTypeId !== undefined) {
    params.push(excludeTypeId);
    sql += ` AND id <> $${params.length}`;
  }
  const existing = await client.query(sql, params);
  if ((existing.rowCount ?? 0) > 0) {
    throw httpError(409, 'ROOM_TYPE_CODE_EXISTS', `room type code ${code} already exists for this property`);
  }
}

export async function getFutureReservedPeak(client: PoolClient | Pool, roomTypeId: number): Promise<number> {
  const result = await client.query(
    `SELECT COALESCE(MAX(reserved_qty), 0) AS peak
     FROM availability_dates
     WHERE room_type_id = $1
       AND (date AT TIME ZONE 'Asia/Jakarta')::date >= (NOW() AT TIME ZONE 'Asia/Jakarta')::date`,
    [roomTypeId]
  );
  return Number(result.rows[0]?.peak || 0);
}

export async function getFutureReservedPeaks(client: PoolClient | Pool): Promise<Map<number, number>> {
  const result = await client.query(
    `SELECT room_type_id, MAX(reserved_qty)::int AS peak
     FROM availability_dates
     WHERE room_type_id IS NOT NULL
       AND (date AT TIME ZONE 'Asia/Jakarta')::date >= (NOW() AT TIME ZONE 'Asia/Jakarta')::date
     GROUP BY room_type_id`
  );
  const peaks = new Map<number, number>();
  for (const row of result.rows) {
    peaks.set(Number(row.room_type_id), Number(row.peak || 0));
  }
  return peaks;
}

// RM-1C.1: Physical Room Master is the source of truth for PHYSICAL CAPACITY.
// Active physical capacity counts only canonical active rooms; temporary
// housekeeping/maintenance states never influence it.
export async function getActivePhysicalCapacity(client: PoolClient | Pool, roomTypeId: number): Promise<number> {
  const result = await client.query(
    `SELECT COUNT(*)::int AS active_count
     FROM rooms
     WHERE room_type_id = $1 AND COALESCE(is_active, TRUE)`,
    [roomTypeId]
  );
  return Number(result.rows[0]?.active_count || 0);
}

export async function countActivePhysicalRooms(client: PoolClient | Pool, roomTypeId: number): Promise<number> {
  return getActivePhysicalCapacity(client, roomTypeId);
}

// Aligns ledger total_rooms with active physical capacity for today/future
// (Jakarta hotel dates). Rows whose reserved_qty already exceeds the target
// capacity are NEVER rewritten here; they are reported as conflicts so the
// caller can reject the operation instead of clamping or silently overbooking.
// Returns the number of aligned rows and conflicting rows encountered.
export async function syncLedgerCapacityFromMaster(
  client: PoolClient,
  roomTypeId: number
): Promise<{ updatedRows: number; conflictRows: number }> {
  const capacity = await getActivePhysicalCapacity(client, roomTypeId);
  const updated = await client.query(
    `UPDATE availability_dates ad
     SET total_rooms = $2
     WHERE ad.room_type_id = $1
       AND (ad.date AT TIME ZONE 'Asia/Jakarta')::date >= (NOW() AT TIME ZONE 'Asia/Jakarta')::date
       AND ad.total_rooms <> $2
       AND ad.reserved_qty <= $2
     RETURNING ad.id`,
    [roomTypeId, capacity]
  );
  const conflicts = await client.query(
    `SELECT id FROM availability_dates
     WHERE room_type_id = $1
       AND (date AT TIME ZONE 'Asia/Jakarta')::date >= (NOW() AT TIME ZONE 'Asia/Jakarta')::date
       AND reserved_qty > $2`,
    [roomTypeId, capacity]
  );
  return { updatedRows: updated.rowCount ?? 0, conflictRows: conflicts.rowCount ?? 0 };
}

export async function assertDeactivationInventorySafe(
  client: PoolClient,
  roomTypeId: number,
  resultingCapacity: number
): Promise<void> {
  const conflicts = await client.query(
    `SELECT date::date AS day, reserved_qty FROM availability_dates
     WHERE room_type_id = $1
       AND (date AT TIME ZONE 'Asia/Jakarta')::date >= (NOW() AT TIME ZONE 'Asia/Jakarta')::date
       AND reserved_qty > $2
     ORDER BY date
     LIMIT 5
     FOR UPDATE`,
    [roomTypeId, resultingCapacity]
  );
  if ((conflicts.rowCount ?? 0) > 0) {
    const detail = conflicts.rows
      .map((r: any) => `${jakartaDayKey(r.day)}(reserved=${r.reserved_qty})`)
      .join(', ');
    throw httpError(409, 'CAPACITY_CONFLICT',
      `deactivation would leave active capacity ${resultingCapacity} below already-reserved quantity on ${detail}; resolve reservations first`);
  }
}

function jakartaDayKey(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return new Date(date.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function getActiveReservationsForRoom(
  client: PoolClient | Pool,
  roomId: number,
  excludeReservationId?: number
): Promise<any[]> {
  const params: any[] = [roomId];
  let exclusionSql = '';
  if (excludeReservationId !== undefined) {
    params.push(excludeReservationId);
    exclusionSql = ` AND r.id <> $${params.length}`;
  }
  const result = await client.query(
    `SELECT r.id, r.room_id, rm.room_number,
            b.bid,
            COALESCE(b.legacy_booking_number, r.booking_number) AS booking_number,
            r.guest_name, r.status,
            to_char(r.check_in::date, 'YYYY-MM-DD') AS check_in,
            to_char(r.check_out::date, 'YYYY-MM-DD') AS check_out,
            GREATEST(r.check_out::date - r.check_in::date, 0)::int AS nights,
            CASE WHEN r.status = 'CHECKED_IN' THEN 'IN_HOUSE' ELSE 'UPCOMING' END AS classification
     FROM reservations r
     JOIN rooms rm ON rm.id = r.room_id
     LEFT JOIN bookings b ON b.id = r.booking_id
     WHERE r.room_id = $1
       AND r.status IN ('BOOKED', 'CHECKED_IN')
       ${exclusionSql}
     ORDER BY CASE WHEN r.status = 'CHECKED_IN' THEN 0 ELSE 1 END,
              r.check_in, r.id
     FOR UPDATE OF r`,
    params
  );
  return result.rows;
}

export async function countActiveReservationsForRoom(
  client: PoolClient | Pool,
  roomId: number,
  excludeReservationId?: number
): Promise<number> {
  return (await getActiveReservationsForRoom(client, roomId, excludeReservationId)).length;
}

export async function writeRoomMasterAudit(
  client: PoolClient,
  entry: {
    action: string;
    entity: 'ROOM_CATEGORY' | 'ROOM_TYPE' | 'ROOM';
    recordId: number | string;
    newValue: unknown;
    propertyId: number;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
     VALUES ('ROOM_MASTER', $1, $2, $3, $4, $5)`,
    [entry.action, entry.entity, String(entry.recordId), JSON.stringify(entry.newValue), entry.propertyId]
  );
}

async function deleteForeignKeyDependents(
  client: PoolClient,
  targetTable: string,
  targetIds: Array<number | string>,
  depth = 0
): Promise<void> {
  if (!targetIds || targetIds.length === 0 || depth > 5) return;

  // Clear self-referential foreign keys first if present on targetTable
  const selfFkRes = await client.query(
    `SELECT att.attname AS col_name
     FROM pg_constraint con
     JOIN pg_class cl ON cl.oid = con.conrelid
     JOIN pg_namespace ns ON ns.oid = cl.relnamespace
     JOIN unnest(con.conkey) WITH ORDINALITY AS ck(attnum, ord) ON TRUE
     JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ck.attnum
     WHERE con.contype = 'f'
       AND ns.nspname = 'public'
       AND cl.relname = $1
       AND con.conrelid = con.confrelid`,
    [targetTable]
  );
  for (const row of selfFkRes.rows) {
    const col = row.col_name;
    await client.query(
      `UPDATE "${targetTable}" SET "${col}" = NULL WHERE "${col}"::text = ANY($1::text[])`,
      [targetIds.map(String)]
    );
  }

  const fkRes = await client.query(
    `SELECT DISTINCT
       cl.relname AS child_table,
       att.attname AS child_column,
       EXISTS (
         SELECT 1 FROM pg_attribute id_att
         WHERE id_att.attrelid = cl.oid AND id_att.attname = 'id' AND NOT id_att.attisdropped
       ) AS has_id_col
     FROM pg_constraint con
     JOIN pg_class cl ON cl.oid = con.conrelid
     JOIN pg_namespace ns ON ns.oid = cl.relnamespace
     JOIN pg_class pcl ON pcl.oid = con.confrelid
     JOIN unnest(con.conkey) WITH ORDINALITY AS ck(attnum, ord) ON TRUE
     JOIN unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = ck.ord
     JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ck.attnum
     JOIN pg_attribute patt ON patt.attrelid = con.confrelid AND patt.attnum = fk.attnum
     WHERE con.contype = 'f'
       AND ns.nspname = 'public'
       AND pcl.relname = $1
       AND patt.attname = 'id'
       AND cl.relname <> $1`,
    [targetTable]
  );

  const stringIds = targetIds.map(String);
  for (const fk of fkRes.rows) {
    const childTable = String(fk.child_table);
    const childColumn = String(fk.child_column);
    if (fk.has_id_col) {
      const childIdsRes = await client.query(
        `SELECT id FROM "${childTable}" WHERE "${childColumn}"::text = ANY($1::text[])`,
        [stringIds]
      );
      const childIds = childIdsRes.rows.map((r: any) => r.id).filter((v: any) => v !== null && v !== undefined);
      if (childIds.length > 0) {
        await deleteForeignKeyDependents(client, childTable, childIds, depth + 1);
      }
    }
    await client.query(
      `DELETE FROM "${childTable}" WHERE "${childColumn}"::text = ANY($1::text[])`,
      [stringIds]
    );
  }
}

export async function forceCascadeDeleteRoomMasterData(
  client: PoolClient,
  options: {
    propertyId: number;
    roomTypeId?: number;
    roomId?: number;
  }
): Promise<void> {
  const { propertyId, roomTypeId, roomId } = options;

  const targetTypeIds: number[] = roomTypeId ? [roomTypeId] : [];
  let targetRoomIds: number[] = [];
  let targetRoomNumbers: string[] = [];
  let donorTypeIdForRoom: number | null = null;

  if (roomId) {
    const rmRes = await client.query(
      'SELECT id, room_number, room_type_id FROM rooms WHERE id = $1',
      [roomId]
    );
    if ((rmRes.rowCount ?? 0) > 0) {
      targetRoomIds.push(Number(rmRes.rows[0].id));
      if (rmRes.rows[0].room_number) {
        targetRoomNumbers.push(String(rmRes.rows[0].room_number));
      }
      if (rmRes.rows[0].room_type_id != null) {
        donorTypeIdForRoom = Number(rmRes.rows[0].room_type_id);
      }
    }
  }

  if (targetTypeIds.length > 0) {
    const rmsRes = await client.query(
      'SELECT id, room_number FROM rooms WHERE room_type_id = ANY($1::int[])',
      [targetTypeIds]
    );
    for (const r of rmsRes.rows) {
      const rid = Number(r.id);
      if (!targetRoomIds.includes(rid)) targetRoomIds.push(rid);
      if (r.room_number) targetRoomNumbers.push(String(r.room_number));
    }
  }

  // 1. Collect all reservations referencing targetRoomIds or targetTypeIds
  const resConds: string[] = [];
  const resParams: any[] = [];
  if (targetRoomIds.length > 0) {
    resParams.push(targetRoomIds);
    resConds.push(`room_id = ANY($${resParams.length}::int[])`);
  }
  if (targetTypeIds.length > 0) {
    resParams.push(targetTypeIds);
    resConds.push(`booked_room_type_id_snapshot = ANY($${resParams.length}::int[])`);
  }

  let targetReservationIds: number[] = [];
  let affectedBookingIds: number[] = [];
  if (resConds.length > 0) {
    const resRows = await client.query(
      `SELECT id, booking_id FROM reservations WHERE ${resConds.join(' OR ')}`,
      resParams
    );
    targetReservationIds = resRows.rows.map((r: any) => Number(r.id));
    affectedBookingIds = Array.from(
      new Set(
        resRows.rows
          .map((r: any) => (r.booking_id != null ? Number(r.booking_id) : null))
          .filter((v: number | null): v is number => v !== null && v > 0)
      )
    );
  }

  // 2. Delete transactions linked to targetReservationIds so reports have zero residual history
  if (targetReservationIds.length > 0) {
    const txRes = await client.query(
      `SELECT id FROM transactions WHERE reservation_id = ANY($1::int[])`,
      [targetReservationIds]
    );
    const txIds = txRes.rows.map((r: any) => Number(r.id));
    if (txIds.length > 0) {
      await deleteForeignKeyDependents(client, 'transactions', txIds);
      await client.query(`DELETE FROM transactions WHERE id = ANY($1::int[])`, [txIds]);
    }

    await deleteForeignKeyDependents(client, 'reservations', targetReservationIds);
    await client.query(`DELETE FROM reservations WHERE id = ANY($1::int[])`, [targetReservationIds]);
  }

  // 3. Delete bookings that now have 0 remaining reservations (and their transactions)
  if (affectedBookingIds.length > 0) {
    const orphanBookingsRes = await client.query(
      `SELECT b.id
       FROM bookings b
       WHERE b.id = ANY($1::bigint[])
         AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.booking_id = b.id)`,
      [affectedBookingIds]
    );
    const orphanBookingIds = orphanBookingsRes.rows.map((r: any) => Number(r.id));
    if (orphanBookingIds.length > 0) {
      const bTxRes = await client.query(
        `SELECT id FROM transactions WHERE booking_id = ANY($1::bigint[])`,
        [orphanBookingIds]
      );
      const bTxIds = bTxRes.rows.map((r: any) => Number(r.id));
      if (bTxIds.length > 0) {
        await deleteForeignKeyDependents(client, 'transactions', bTxIds);
        await client.query(`DELETE FROM transactions WHERE id = ANY($1::int[])`, [bTxIds]);
      }

      await deleteForeignKeyDependents(client, 'bookings', orphanBookingIds);
      await client.query(`DELETE FROM bookings WHERE id = ANY($1::bigint[])`, [orphanBookingIds]);
    }
  }

  // 4. Clean up housekeeping & maintenance tasks by room_number / room_id
  if (targetRoomNumbers.length > 0 || targetRoomIds.length > 0) {
    const hkRes = await client.query(
      `SELECT id FROM housekeeping_tasks
       WHERE property_id = $1
         AND (
           (room_id IS NOT NULL AND room_id = ANY($2::int[]))
           OR (room_number IS NOT NULL AND room_number = ANY($3::text[]))
         )`,
      [propertyId, targetRoomIds, targetRoomNumbers]
    );
    const hkIds = hkRes.rows.map((r: any) => Number(r.id));
    if (hkIds.length > 0) {
      await deleteForeignKeyDependents(client, 'housekeeping_tasks', hkIds);
      await client.query(`DELETE FROM housekeeping_tasks WHERE id = ANY($1::int[])`, [hkIds]);
    }

    if (targetRoomNumbers.length > 0) {
      const mtRes = await client.query(
        `SELECT id FROM maintenance_tasks WHERE property_id = $1 AND room_number = ANY($2::text[])`,
        [propertyId, targetRoomNumbers]
      );
      const mtIds = mtRes.rows.map((r: any) => Number(r.id));
      if (mtIds.length > 0) {
        await deleteForeignKeyDependents(client, 'maintenance_tasks', mtIds);
        await client.query(`DELETE FROM maintenance_tasks WHERE id = ANY($1::int[])`, [mtIds]);
      }
    }
  }

  // 5. Delete physical rooms & their FK dependents
  if (targetRoomIds.length > 0) {
    await deleteForeignKeyDependents(client, 'rooms', targetRoomIds);
    await client.query(`DELETE FROM rooms WHERE id = ANY($1::int[])`, [targetRoomIds]);
  }

  // 6. Delete room types & their FK dependents (availability_dates, availability_locks, rate_plans, etc.)
  if (targetTypeIds.length > 0) {
    await client.query(`DELETE FROM availability_locks WHERE room_type_id = ANY($1::int[])`, [targetTypeIds]);
    await client.query(`DELETE FROM availability_dates WHERE room_type_id = ANY($1::int[])`, [targetTypeIds]);
    await deleteForeignKeyDependents(client, 'room_types', targetTypeIds);
    await client.query(`DELETE FROM room_types WHERE id = ANY($1::int[])`, [targetTypeIds]);
  } else if (donorTypeIdForRoom !== null) {
    // Reconcile reserved_qty and total_rooms for donorTypeIdForRoom so inventory drift stays 0
    await client.query(
      `UPDATE availability_dates ad
       SET reserved_qty = COALESCE((
         SELECT COUNT(*)::int
         FROM reservations r
         JOIN bookings b ON b.id = r.booking_id
         LEFT JOIN rooms rm ON rm.id = r.room_id
         WHERE b.property_id = $2
           AND COALESCE(rm.room_type_id, r.booked_room_type_id_snapshot) = $1
           AND r.status IN ('BOOKED', 'CHECKED_IN')
           AND COALESCE(b.booking_status, '') != 'CANCELLED'
           AND r.check_in::date <= ad.date::date
           AND r.check_out::date > ad.date::date
       ), 0)
       WHERE ad.room_type_id = $1`,
      [donorTypeIdForRoom, propertyId]
    );
    const capacity = await getActivePhysicalCapacity(client, donorTypeIdForRoom);
    await client.query(
      `UPDATE availability_dates
       SET total_rooms = GREATEST($2, reserved_qty)
       WHERE room_type_id = $1
         AND (date AT TIME ZONE 'Asia/Jakarta')::date >= (NOW() AT TIME ZONE 'Asia/Jakarta')::date`,
      [donorTypeIdForRoom, capacity]
    );
  }
}

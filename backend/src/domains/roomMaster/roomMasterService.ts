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

const TYPE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,19}$/;

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

export async function countActiveReservationsForRoom(
  client: PoolClient | Pool,
  roomId: number,
  excludeReservationId?: number
): Promise<number> {
  const params: any[] = [roomId];
  let sql = `SELECT COUNT(*)::int AS active_count
     FROM reservations
     WHERE room_id = $1 AND status IN ('BOOKED', 'CHECKED_IN')`;
  if (excludeReservationId !== undefined) {
    params.push(excludeReservationId);
    sql += ` AND id <> $${params.length}`;
  }
  const result = await client.query(sql, params);
  return Number(result.rows[0]?.active_count || 0);
}

export async function writeRoomMasterAudit(
  client: PoolClient,
  entry: {
    action: string;
    entity: 'ROOM_TYPE' | 'ROOM';
    recordId: number | string;
    newValue: unknown;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value)
     VALUES ('ROOM_MASTER', $1, $2, $3, $4)`,
    [entry.action, entry.entity, String(entry.recordId), JSON.stringify(entry.newValue)]
  );
}

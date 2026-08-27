import type { Pool, PoolClient } from 'pg';

export interface RoomOperationalBlock {
  id: number;
  property_id: number;
  room_id: number;
  room_type_id: number;
  block_type: 'OUT_OF_ORDER' | 'OUT_OF_SERVICE';
  start_date: string;
  end_date: string;
  reason: string | null;
  maintenance_task_id: number | null;
  status: 'ACTIVE' | 'RELEASED' | 'CANCELLED';
  created_by: string | null;
  created_at: string;
  released_by: string | null;
  released_at: string | null;
  room_number?: string;
  room_type_code?: string;
  room_type_name?: string;
}

export function httpError(statusCode: number, code: string, message: string): Error & { statusCode: number; code: string } {
  const err = new Error(message) as Error & { statusCode: number; code: string };
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

export function parsePropertyId(value: unknown, fieldName = 'property_id'): number {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw httpError(400, 'VALIDATION_ERROR', `${fieldName} is required`);
  }
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw httpError(400, 'VALIDATION_ERROR', `${fieldName} must be a positive integer`);
  }
  return id;
}

export function normalizeHotelDate(raw: unknown): string | null {
  if (!raw) return null;
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    const year = raw.getFullYear();
    const month = String(raw.getMonth() + 1).padStart(2, '0');
    const day = String(raw.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const str = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }
  const dateObj = new Date(str);
  if (isNaN(dateObj.getTime())) return null;
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getTodayJakartaDate(): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(new Date());
}

export function enumerateHotelDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cur = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (cur < end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

export async function assertPropertyExists(client: PoolClient | Pool, propertyId: number): Promise<void> {
  const res = await client.query('SELECT id, is_active FROM properties WHERE id = $1', [propertyId]);
  if ((res.rowCount ?? 0) === 0) {
    throw httpError(404, 'PROPERTY_NOT_FOUND', `property ${propertyId} not found`);
  }
}

export async function assertRoomBelongsToProperty(
  client: PoolClient | Pool,
  roomId: number,
  propertyId: number
): Promise<any> {
  const res = await client.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
  if ((res.rowCount ?? 0) === 0) {
    throw httpError(404, 'ROOM_NOT_FOUND', `room ${roomId} not found`);
  }
  const room = res.rows[0];
  if (room.property_id != null && Number(room.property_id) !== propertyId) {
    throw httpError(403, 'PROPERTY_MISMATCH', `room ${roomId} does not belong to property ${propertyId}`);
  }
  return room;
}

export async function assertRoomTypeBelongsToProperty(
  client: PoolClient | Pool,
  typeId: number,
  propertyId: number
): Promise<any> {
  const res = await client.query('SELECT * FROM room_types WHERE id = $1', [typeId]);
  if ((res.rowCount ?? 0) === 0) {
    throw httpError(404, 'ROOM_TYPE_NOT_FOUND', `room type ${typeId} not found`);
  }
  const roomType = res.rows[0];
  if (roomType.property_id != null && Number(roomType.property_id) !== propertyId) {
    throw httpError(403, 'PROPERTY_MISMATCH', `room type ${typeId} does not belong to property ${propertyId}`);
  }
  return roomType;
}

export async function assertMaintenanceTaskBelongsToProperty(
  client: PoolClient | Pool,
  taskId: number,
  propertyId: number
): Promise<any> {
  const res = await client.query('SELECT * FROM maintenance_tasks WHERE id = $1', [taskId]);
  if ((res.rowCount ?? 0) === 0) {
    throw httpError(404, 'MAINTENANCE_TASK_NOT_FOUND', `maintenance task ${taskId} not found`);
  }
  const task = res.rows[0];
  if (task.property_id != null && Number(task.property_id) !== propertyId) {
    throw httpError(403, 'PROPERTY_MISMATCH', `maintenance task ${taskId} does not belong to property ${propertyId}`);
  }
  return task;
}

export async function findActiveRoomReservationOverlap(
  client: PoolClient | Pool,
  roomId: number,
  startDate: string,
  endDate: string
): Promise<any[]> {
  const res = await client.query(
    `SELECT id, guest_name, check_in, check_out, status
     FROM reservations
     WHERE room_id = $1
       AND status IN ('BOOKED', 'CHECKED_IN')
       AND check_in::date < $2::date
       AND check_out::date > $3::date
     ORDER BY check_in, id`,
    [roomId, endDate, startDate]
  );
  return res.rows;
}

export async function findActiveRoomBlockOverlap(
  client: PoolClient | Pool,
  roomId: number,
  startDate: string,
  endDate: string,
  excludeBlockId?: number
): Promise<any[]> {
  const params: any[] = [roomId, endDate, startDate];
  let exclusionSql = '';
  if (excludeBlockId !== undefined) {
    params.push(excludeBlockId);
    exclusionSql = ` AND id <> $${params.length}`;
  }
  const res = await client.query(
    `SELECT id, room_id, block_type, start_date, end_date, status
     FROM room_operational_blocks
     WHERE room_id = $1
       AND status IN ('ACTIVE', 'RELEASED')
       AND start_date < $2::date
       AND end_date > $3::date
       ${exclusionSql}
     ORDER BY start_date, id`,
    params
  );
  return res.rows;
}

export async function assertSellableCapacitySafe(
  client: PoolClient,
  roomTypeId: number,
  startDate: string,
  endDate: string,
  excludeBlockId?: number
): Promise<void> {
  const dates = enumerateHotelDates(startDate, endDate);
  for (const date of dates) {
    // 1. Get availability row for this date
    const availRes = await client.query(
      `SELECT id, total_rooms, reserved_qty
       FROM availability_dates
       WHERE room_type_id = $1 AND date = $2::date
       FOR UPDATE`,
      [roomTypeId, date]
    );

    if ((availRes.rowCount ?? 0) === 0) {
      continue; // If date not yet in availability_dates, skip or pass
    }

    const avail = availRes.rows[0];
    const totalRooms = Number(avail.total_rooms || 0);
    const reservedQty = Number(avail.reserved_qty || 0);

    // 2. Count existing effective blocks on this room type for this date
    const params: any[] = [roomTypeId, date];
    let exclusionSql = '';
    if (excludeBlockId !== undefined) {
      params.push(excludeBlockId);
      exclusionSql = ` AND id <> $${params.length}`;
    }

    const blocksRes = await client.query(
      `SELECT COUNT(*)::int AS blocked_count
       FROM room_operational_blocks
       WHERE room_type_id = $1
         AND status IN ('ACTIVE', 'RELEASED')
         AND start_date <= $2::date
         AND end_date > $2::date
         ${exclusionSql}`,
      params
    );

    const existingBlocked = Number(blocksRes.rows[0]?.blocked_count || 0);
    const proposedBlocked = existingBlocked + 1;
    const sellableCapacity = totalRooms - proposedBlocked;

    if (reservedQty > sellableCapacity) {
      throw httpError(
        409,
        'INSUFFICIENT_SELLABLE_CAPACITY',
        `blocking room on ${date} would reduce sellable capacity (${sellableCapacity}) below reserved quantity (${reservedQty}) for room type ${roomTypeId}`
      );
    }
  }
}

export async function writeRoomBlockAudit(
  client: PoolClient | Pool,
  entry: {
    action: 'CREATE' | 'RELEASE' | 'CANCEL';
    blockId: number;
    newValue: any;
    propertyId: number;
    correlationId?: string | null;
  }
): Promise<void> {
  if (!entry.propertyId || !Number.isInteger(entry.propertyId) || entry.propertyId <= 0) {
    throw new Error('AUDIT_INTEGRITY_ERROR: property_id must not be null for room operational block audit');
  }
  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'ROOM_MASTER',
      entry.action,
      'ROOM_OPERATIONAL_BLOCK',
      String(entry.blockId),
      JSON.stringify(entry.newValue),
      entry.correlationId || null,
      entry.propertyId
    ]
  );
}

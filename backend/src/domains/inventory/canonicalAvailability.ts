import { enumerateHotelDates } from '../../utils/hotelDate';

type QueryClient = {
  query: (text: string, params?: any[]) => Promise<any>;
};

export type CanonicalAvailabilityKey = {
  roomTypeId: number;
  roomTypeName?: string;
  date: string;
};

export type CanonicalAvailabilityRow = {
  id: number;
  roomTypeId: number;
  date: string;
  reservedQty: number;
  totalRooms: number;
};

export function canonicalAvailabilityKey(roomTypeId: number, date: string): string {
  return `${roomTypeId}|${date}`;
}

function assertCanonicalKey(key: CanonicalAvailabilityKey): void {
  if (!Number.isInteger(key.roomTypeId) || key.roomTypeId <= 0) {
    throw new Error(`INVENTORY_INTEGRITY_ERROR: canonical room_type_id is required for ${key.date}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key.date)) {
    throw new Error(`INVENTORY_INTEGRITY_ERROR: invalid hotel date ${key.date}`);
  }
}

/**
 * Ensures canonical availability ledger rows exist for the given keys.
 * If rows for any (room_type_id, date) do not yet exist, they are inserted idempotently
 * with total_rooms derived from active physical rooms of that room type, and reserved_qty
 * derived from any active reservations and holds for that date (or 0 if none).
 * If rows already exist, they are left unmodified.
 */
export async function ensureCanonicalAvailabilityRows(
  client: QueryClient,
  keys: CanonicalAvailabilityKey[]
): Promise<void> {
  if (!keys || keys.length === 0) return;

  const datesByType = new Map<number, Set<string>>();
  for (const key of keys) {
    assertCanonicalKey(key);
    if (!datesByType.has(key.roomTypeId)) {
      datesByType.set(key.roomTypeId, new Set());
    }
    datesByType.get(key.roomTypeId)!.add(key.date);
  }

  const roomTypeIds = Array.from(datesByType.keys()).sort((a, b) => a - b);

  for (const roomTypeId of roomTypeIds) {
    const dates = Array.from(datesByType.get(roomTypeId)!).sort();
    if (dates.length === 0) continue;

    // Check existing dates in availability_dates for this room type
    const existing = await client.query(
      `SELECT to_char(date::date, 'YYYY-MM-DD') AS hotel_date
       FROM availability_dates
       WHERE room_type_id = $1 AND date = ANY($2::date[])`,
      [roomTypeId, dates]
    );
    const existingDates = new Set(existing.rows.map((r: any) => String(r.hotel_date)));
    const missingDates = dates.filter(d => !existingDates.has(d));

    if (missingDates.length === 0) {
      continue;
    }

    // Determine canonical room type label and authoritative active physical capacity
    const typeRes = await client.query(
      `SELECT rt.id AS room_type_id,
              COALESCE(
                (SELECT ad.room_type FROM availability_dates ad WHERE ad.room_type_id = rt.id LIMIT 1),
                CASE
                  WHEN (SELECT COUNT(*) FROM room_types rt2 WHERE rt2.name = rt.name AND rt2.is_active = TRUE) > 1
                    THEN LEFT(rt.name, 80) || ' [RT-' || rt.id || ']'
                  ELSE rt.name
                END
              ) AS room_type,
              COUNT(r.id) FILTER (WHERE COALESCE(r.is_active, TRUE))::int AS active_rooms
       FROM room_types rt
       LEFT JOIN rooms r ON r.room_type_id = rt.id AND r.property_id = rt.property_id
       WHERE rt.id = $1
       GROUP BY rt.id, rt.name`,
      [roomTypeId]
    );

    if (typeRes.rowCount === 0) {
      throw new Error(`INVENTORY_INTEGRITY_ERROR: room_type_id ${roomTypeId} does not exist`);
    }

    const rtInfo = typeRes.rows[0];
    const roomTypeLabel = String(rtInfo.room_type || `Room Type ${roomTypeId}`);
    const activeRooms = Number(rtInfo.active_rooms || 0);

    // Insert missing rows idempotently, computing reserved_qty from active reservations & unexpired holds
    await client.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       SELECT $1, $2, d::date, $3,
         (
           (SELECT COUNT(res.id)::int
            FROM reservations res
            JOIN rooms rm ON rm.id = res.room_id
            WHERE rm.room_type_id = $1
              AND res.status IN ('BOOKED', 'CHECKED_IN')
              AND res.check_in <= d::date AND res.check_out > d::date)
           +
           COALESCE(
             (SELECT SUM(al.qty_locked)::int
              FROM availability_locks al
              WHERE al.room_type_id = $1
                AND al.reservation_id IS NULL
                AND al.lock_expires_at > NOW()
                AND al.date::date = d::date),
             0
           )
         )
       FROM UNNEST($4::text[]) AS d
       ON CONFLICT DO NOTHING`,
      [roomTypeId, roomTypeLabel, activeRooms, missingDates]
    );
  }
}

/**
 * Ensures canonical availability ledger rows exist across a date range [startDate, endDate)
 * for the specified room types (or all active room types for propertyId/system).
 */
export async function ensureCanonicalAvailabilityRange(
  client: QueryClient,
  options: {
    roomTypeIds?: number[];
    propertyId?: number;
    startDate: string;
    endDate: string;
  }
): Promise<{ roomTypeCount: number; dateCount: number; insertedCount: number }> {
  const { propertyId, startDate, endDate } = options;
  let targetRoomTypeIds: number[] = [];

  if (options.roomTypeIds && options.roomTypeIds.length > 0) {
    targetRoomTypeIds = Array.from(new Set(options.roomTypeIds.map(Number))).sort((a, b) => a - b);
  } else {
    const queryText = propertyId
      ? 'SELECT id FROM room_types WHERE property_id = $1 AND is_active = TRUE ORDER BY id'
      : 'SELECT id FROM room_types WHERE is_active = TRUE ORDER BY id';
    const params = propertyId ? [propertyId] : [];
    const res = await client.query(queryText, params);
    targetRoomTypeIds = res.rows.map((r: any) => Number(r.id));
  }

  if (targetRoomTypeIds.length === 0) {
    return { roomTypeCount: 0, dateCount: 0, insertedCount: 0 };
  }

  // Count availability_dates rows before
  const countBeforeRes = await client.query(
    'SELECT COUNT(*)::int AS count FROM availability_dates WHERE room_type_id = ANY($1::int[]) AND date >= $2::date AND date < $3::date',
    [targetRoomTypeIds, startDate, endDate]
  );
  const countBefore = Number(countBeforeRes.rows[0]?.count || 0);

  const dates = enumerateHotelDates(startDate, endDate);
  const keys: CanonicalAvailabilityKey[] = [];
  for (const roomTypeId of targetRoomTypeIds) {
    for (const date of dates) {
      keys.push({ roomTypeId, date });
    }
  }

  await ensureCanonicalAvailabilityRows(client, keys);

  const countAfterRes = await client.query(
    'SELECT COUNT(*)::int AS count FROM availability_dates WHERE room_type_id = ANY($1::int[]) AND date >= $2::date AND date < $3::date',
    [targetRoomTypeIds, startDate, endDate]
  );
  const countAfter = Number(countAfterRes.rows[0]?.count || 0);

  return {
    roomTypeCount: targetRoomTypeIds.length,
    dateCount: dates.length,
    insertedCount: Math.max(0, countAfter - countBefore)
  };
}

export async function lockCanonicalAvailabilityRows(
  client: QueryClient,
  keys: CanonicalAvailabilityKey[]
): Promise<Map<string, CanonicalAvailabilityRow>> {
  const deduped = new Map<string, CanonicalAvailabilityKey>();
  for (const key of keys) {
    assertCanonicalKey(key);
    deduped.set(canonicalAvailabilityKey(key.roomTypeId, key.date), key);
  }

  const sorted = Array.from(deduped.values()).sort((a, b) =>
    a.roomTypeId - b.roomTypeId || a.date.localeCompare(b.date)
  );

  // Ensure canonical availability rows exist for all requested keys
  await ensureCanonicalAvailabilityRows(client, sorted);

  const locked = new Map<string, CanonicalAvailabilityRow>();

  for (const key of sorted) {
    const result = await client.query(
      `SELECT id, room_type_id, reserved_qty, total_rooms
       FROM availability_dates
       WHERE room_type_id = $1 AND date = $2::date
       ORDER BY id
       FOR UPDATE`,
      [key.roomTypeId, key.date]
    );
    if (result.rowCount !== 1) {
      const detail = result.rowCount === 0 ? 'missing canonical ledger' : `duplicate canonical ledger rows (${result.rowCount})`;
      throw new Error(
        `INVENTORY_INTEGRITY_ERROR: ${detail} for room_type_id ${key.roomTypeId} on ${key.date}`
      );
    }

    const row = result.rows[0];
    locked.set(canonicalAvailabilityKey(key.roomTypeId, key.date), {
      id: Number(row.id),
      roomTypeId: Number(row.room_type_id),
      date: key.date,
      reservedQty: Number(row.reserved_qty || 0),
      totalRooms: Number(row.total_rooms || 0)
    });
  }

  return locked;
}

export async function mutateCanonicalAvailabilityRow(
  client: QueryClient,
  row: CanonicalAvailabilityRow,
  delta: number
): Promise<void> {
  if (!Number.isInteger(delta) || delta === 0) {
    throw new Error(`INVENTORY_INTEGRITY_ERROR: invalid inventory delta ${delta} for availability ${row.id}`);
  }

  const result = delta > 0
    ? await client.query(
        `UPDATE availability_dates
         SET reserved_qty = reserved_qty + $3
         WHERE id = $1 AND room_type_id = $2
           AND reserved_qty + $3 <= total_rooms
         RETURNING id`,
        [row.id, row.roomTypeId, delta]
      )
    : await client.query(
        `UPDATE availability_dates
         SET reserved_qty = reserved_qty - $3
         WHERE id = $1 AND room_type_id = $2
           AND reserved_qty >= $3
         RETURNING id`,
        [row.id, row.roomTypeId, Math.abs(delta)]
      );

  if (result.rowCount !== 1) {
    throw new Error(
      `INVENTORY_INTEGRITY_ERROR: exact inventory mutation failed for availability ${row.id} on ${row.date}`
    );
  }
}

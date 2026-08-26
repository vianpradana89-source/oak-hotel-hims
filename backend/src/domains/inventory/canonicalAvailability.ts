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

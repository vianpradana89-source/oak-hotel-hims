import { enumerateHotelDates, hotelDateKey } from '../../utils/hotelDate';
import {
  CanonicalAvailabilityRow,
  canonicalAvailabilityKey,
  mutateCanonicalAvailabilityRow
} from './canonicalAvailability';

type PoolLike = {
  connect: () => Promise<any>;
};

export type CanonicalReconciliationSummary = {
  roomTypeCount: number;
  ledgerRowCount: number;
  expectedCellCount: number;
  updatedRowCount: number;
};

export async function reconcileCanonicalAvailability(
  pool: PoolLike,
  options: { roomTypeIds?: number[] } = {}
): Promise<CanonicalReconciliationSummary> {
  const scopedIds = options.roomTypeIds === undefined
    ? null
    : Array.from(new Set(options.roomTypeIds.map(Number))).sort((a, b) => a - b);
  if (scopedIds?.some(id => !Number.isInteger(id) || id <= 0)) {
    throw new Error('INVENTORY_INTEGRITY_ERROR: invalid reconciliation room_type_id scope');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const typeResult = scopedIds === null
      ? await client.query(
          `SELECT DISTINCT rt.id
           FROM room_types rt
           JOIN rooms rm ON rm.room_type_id = rt.id
           ORDER BY rt.id`
        )
      : await client.query(
          `SELECT DISTINCT rt.id
           FROM room_types rt
           JOIN rooms rm ON rm.room_type_id = rt.id
           WHERE rt.id = ANY($1::int[])
           ORDER BY rt.id`,
          [scopedIds]
        );
    const roomTypeIds = typeResult.rows.map((row: any) => Number(row.id));
    if (scopedIds !== null && roomTypeIds.length !== scopedIds.length) {
      throw new Error('INVENTORY_INTEGRITY_ERROR: reconciliation scope contains a room type without a physical room');
    }
    if (roomTypeIds.length === 0) {
      await client.query('COMMIT');
      return { roomTypeCount: 0, ledgerRowCount: 0, expectedCellCount: 0, updatedRowCount: 0 };
    }

    const expected = new Map<string, number>();
    const reservations = await client.query(
      `SELECT res.id, res.check_in, res.check_out,
              COALESCE(rm.room_type_id, res.booked_room_type_id_snapshot) AS initial_room_type_id
       FROM reservations res
       JOIN rooms rm ON rm.id = res.room_id
       WHERE res.status IN ('BOOKED', 'CHECKED_IN')
         AND rm.room_type_id = ANY($1::int[])
         AND res.check_in IS NOT NULL
         AND res.check_out IS NOT NULL
         AND res.check_out > res.check_in
        ORDER BY res.check_in, res.check_out, res.id`,
        [roomTypeIds]
      );
    for (const reservation of reservations.rows) {
      const moveRows = await client.query(
        `SELECT to_room_type_id, effective_from_date
         FROM reservation_room_moves WHERE reservation_id = $1
         ORDER BY effective_from_date, id`,
        [reservation.id]
      ).catch(() => ({ rows: [] as any[] }));
      const moveTypeByDate = new Map<string, number>(moveRows.rows.map((move: any) => [
        hotelDateKey(move.effective_from_date), Number(move.to_room_type_id)
      ]));
      let roomTypeId = Number(reservation.initial_room_type_id);
      for (const date of enumerateHotelDates(
        hotelDateKey(reservation.check_in),
        hotelDateKey(reservation.check_out)
      )) {
        roomTypeId = moveTypeByDate.get(date) || roomTypeId;
        if (!roomTypeIds.includes(roomTypeId)) continue;
        const key = canonicalAvailabilityKey(roomTypeId, date);
        expected.set(key, (expected.get(key) || 0) + 1);
      }
    }

    const activeHolds = await client.query(
      `SELECT room_type_id, to_char(date::date, 'YYYY-MM-DD') AS hotel_date,
              SUM(qty_locked)::int AS qty
       FROM availability_locks
       WHERE reservation_id IS NULL
         AND room_type_id = ANY($1::int[])
         AND lock_expires_at > NOW()
       GROUP BY room_type_id, date
       ORDER BY room_type_id, date`,
      [roomTypeIds]
    );
    for (const hold of activeHolds.rows) {
      const key = canonicalAvailabilityKey(Number(hold.room_type_id), String(hold.hotel_date));
      expected.set(key, (expected.get(key) || 0) + Number(hold.qty || 0));
    }

    const ledgerResult = await client.query(
      `SELECT id, room_type_id, to_char(date::date, 'YYYY-MM-DD') AS hotel_date,
              reserved_qty, total_rooms
       FROM availability_dates
       WHERE room_type_id = ANY($1::int[])
       ORDER BY room_type_id, date, id
       FOR UPDATE`,
      [roomTypeIds]
    );
    const ledger = new Map<string, CanonicalAvailabilityRow>();
    for (const raw of ledgerResult.rows) {
      const row: CanonicalAvailabilityRow = {
        id: Number(raw.id),
        roomTypeId: Number(raw.room_type_id),
        date: String(raw.hotel_date),
        reservedQty: Number(raw.reserved_qty || 0),
        totalRooms: Number(raw.total_rooms || 0)
      };
      const key = canonicalAvailabilityKey(row.roomTypeId, row.date);
      if (ledger.has(key)) {
        throw new Error(`INVENTORY_INTEGRITY_ERROR: duplicate canonical ledger rows for room_type_id ${row.roomTypeId} on ${row.date}`);
      }
      ledger.set(key, row);
    }

    for (const [key, expectedQty] of expected) {
      const row = ledger.get(key);
      if (!row) {
        throw new Error(`INVENTORY_INTEGRITY_ERROR: missing canonical ledger for ${key}`);
      }
      if (expectedQty > row.totalRooms) {
        throw new Error(`INVENTORY_INTEGRITY_ERROR: expected quantity ${expectedQty} exceeds capacity for ${key}`);
      }
    }
    for (const row of ledger.values()) {
      if (row.reservedQty < 0 || row.reservedQty > row.totalRooms) {
        throw new Error(`INVENTORY_INTEGRITY_ERROR: invalid ledger bounds for availability ${row.id}`);
      }
    }

    let updatedRowCount = 0;
    for (const row of ledger.values()) {
      const expectedQty = expected.get(canonicalAvailabilityKey(row.roomTypeId, row.date)) || 0;
      const delta = expectedQty - row.reservedQty;
      if (delta === 0) continue;
      await mutateCanonicalAvailabilityRow(client, row, delta);
      updatedRowCount += 1;
    }

    await client.query('COMMIT');
    return {
      roomTypeCount: roomTypeIds.length,
      ledgerRowCount: ledger.size,
      expectedCellCount: expected.size,
      updatedRowCount
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

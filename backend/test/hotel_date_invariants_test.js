require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

async function main() {
  const result = await pool.query(`
    WITH active_nights AS (
      SELECT rm.room_type_id, night.day::date AS date, COUNT(*)::int AS expected_qty
      FROM reservations r
      JOIN rooms rm ON rm.id = r.room_id
      CROSS JOIN LATERAL generate_series(
        r.check_in::date,
        r.check_out::date - 1,
        INTERVAL '1 day'
      ) AS night(day)
      WHERE r.status IN ('BOOKED', 'CHECKED_IN')
        AND rm.room_type_id IS NOT NULL
        AND r.check_in IS NOT NULL
        AND r.check_out IS NOT NULL
        AND r.check_out > r.check_in
      GROUP BY rm.room_type_id, night.day
    ),
    ledger AS (
      SELECT
        COUNT(*) FILTER (WHERE ad.reserved_qty IS DISTINCT FROM COALESCE(an.expected_qty, 0))::int AS drift,
        COUNT(*) FILTER (WHERE ad.reserved_qty < 0)::int AS negative,
        COUNT(*) FILTER (WHERE ad.reserved_qty > ad.total_rooms)::int AS over_capacity
      FROM availability_dates ad
      LEFT JOIN active_nights an ON an.room_type_id = ad.room_type_id AND an.date = ad.date
    ),
    missing AS (
      SELECT COUNT(*)::int AS missing_active_rows
      FROM active_nights an
      LEFT JOIN availability_dates ad ON ad.room_type_id = an.room_type_id AND ad.date = an.date
      WHERE ad.id IS NULL
    ),
    residue AS (
      SELECT
        (SELECT COUNT(*) FROM reservations WHERE correlation_id LIKE 'HOTEL-DATE-%')::int AS residue_reservations,
        (SELECT COUNT(*) FROM bookings WHERE correlation_id LIKE 'HOTEL-DATE-%')::int AS residue_bookings,
        (SELECT COUNT(*) FROM availability_locks
         WHERE reservation_id IN (
           SELECT id FROM reservations WHERE correlation_id LIKE 'HOTEL-DATE-%'
         ))::int AS residue_locks
    )
    SELECT * FROM ledger CROSS JOIN missing CROSS JOIN residue
  `);

  const snapshot = result.rows[0];
  console.log('Hotel date inventory invariants');
  console.log(`existing-row drift=${snapshot.drift}`);
  console.log(`negative=${snapshot.negative}`);
  console.log(`over-capacity=${snapshot.over_capacity}`);
  console.log(`missing-active-rows=${snapshot.missing_active_rows}`);
  console.log(`phase-residue=${Number(snapshot.residue_reservations) + Number(snapshot.residue_bookings) + Number(snapshot.residue_locks)}`);

  if (Number(snapshot.drift) !== 0 || Number(snapshot.negative) !== 0 || Number(snapshot.over_capacity) !== 0) {
    throw new Error('inventory invariant failure');
  }
  if (Number(snapshot.residue_reservations) + Number(snapshot.residue_bookings) + Number(snapshot.residue_locks) !== 0) {
    throw new Error('hotel-date test residue detected');
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

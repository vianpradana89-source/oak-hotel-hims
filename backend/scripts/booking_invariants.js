require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db',
});

async function runCheck(name, sql, label) {
  const result = await pool.query(sql);
  const count = Number(result.rows?.[0]?.count ?? result.rows?.[0]?.total ?? 0);
  const issues = result.rows; 

  return {
    name,
    label,
    count,
    issues,
    passed: count === 0,
  };
}

async function main() {
  const checks = [
    {
      name: 'duplicate_bids',
      label: 'Duplicate booking identities (bid)',
      sql: `SELECT COUNT(*)::int AS count FROM (SELECT bid FROM bookings GROUP BY bid HAVING COUNT(*) > 1) d;`,
    },
    {
      name: 'booking_without_reservation',
      label: 'Bookings without linked reservations',
      sql: `SELECT COUNT(*)::int AS count FROM bookings b LEFT JOIN reservations r ON r.booking_id = b.id WHERE r.id IS NULL;`,
    },
    {
      name: 'reservation_missing_booking',
      label: 'Reservations pointing to missing bookings',
      sql: `SELECT COUNT(*)::int AS count FROM reservations r LEFT JOIN bookings b ON b.id = r.booking_id WHERE r.booking_id IS NOT NULL AND b.id IS NULL;`,
    },
    {
      name: 'reservation_null_booking_id',
      label: 'Reservations with null booking_id while data is fully linked',
      sql: `SELECT COUNT(*)::int AS count FROM reservations WHERE booking_id IS NULL;`,
    },
    {
      name: 'reservation_null_stay_sequence',
      label: 'Reservations with null stay_sequence while data is fully linked',
      sql: `SELECT COUNT(*)::int AS count FROM reservations WHERE stay_sequence IS NULL;`,
    },
    {
      name: 'duplicate_stay_sequence_by_booking',
      label: 'Duplicate stay_sequence values within the same booking',
      sql: `SELECT COUNT(*)::int AS count FROM (SELECT booking_id, stay_sequence FROM reservations WHERE booking_id IS NOT NULL AND stay_sequence IS NOT NULL GROUP BY booking_id, stay_sequence HAVING COUNT(*) > 1) x;`,
    },
    {
      name: 'booking_status_out_of_sync',
      label: 'Reservations still active when their booking is cancelled or completed',
      sql: `SELECT COUNT(*)::int AS count
            FROM reservations r
            JOIN bookings b ON b.id = r.booking_id
            WHERE (
              (b.booking_status = 'CANCELLED' AND r.status <> 'CANCELLED')
              OR (b.booking_status = 'COMPLETED' AND r.status NOT IN ('CHECKED_OUT','CANCELLED'))
            );`,
    },
    {
      name: 'cancelled_reservations_without_booking_cancelled',
      label: 'All-cancelled bookings whose parent booking is not cancelled',
      sql: `SELECT COUNT(*)::int AS count
            FROM bookings b
            WHERE b.booking_status <> 'CANCELLED'
              AND EXISTS (
                SELECT 1
                FROM reservations r
                WHERE r.booking_id = b.id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM reservations r
                WHERE r.booking_id = b.id
                  AND r.status <> 'CANCELLED'
              );`,
    },
    {
      name: 'active_booking_eligible_for_completion',
      label: 'Active bookings that are eligible for completion',
      sql: `SELECT COUNT(*)::int AS count
            FROM bookings b
            WHERE b.booking_status = 'ACTIVE'
              AND EXISTS (
                SELECT 1
                FROM reservations r
                WHERE r.booking_id = b.id
                  AND r.status = 'CHECKED_OUT'
              )
              AND NOT EXISTS (
                SELECT 1
                FROM reservations r
                WHERE r.booking_id = b.id
                  AND r.status IN ('BOOKED', 'CHECKED_IN')
              );`,
    },
  ];

  const results = [];
  for (const check of checks) {
    const result = await runCheck(check.name, check.sql, check.label);
    results.push(result);
  }

  const failures = results.filter((result) => !result.passed);

  console.log('Booking invariant audit');
  for (const result of results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    console.log(`${status} | ${result.label}: ${result.count}`);
    if (result.issues?.length && result.issues[0]?.bid) {
      console.log(JSON.stringify(result.issues.slice(0, 5), null, 2));
    }
  }

  if (failures.length > 0) {
    console.error(`\nFAIL: ${failures.length} invariant checks failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nPASS: all booking invariant checks are clean.');
  }

  await pool.end();
}

main().catch((error) => {
  console.error('Booking invariant audit failed to run:', error.message);
  process.exit(1);
});

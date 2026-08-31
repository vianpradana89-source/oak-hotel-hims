'use strict';

require('dotenv').config({ path: 'E:/oak-hotel-hims/backend/.env' });
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

async function main() {
  console.log('\n======================================================');
  console.log('RUNNING COMPREHENSIVE DATA DRIFT & INVARIANT AUDIT');
  console.log('======================================================\n');

  let violations = 0;

  // 1. Duplicate Properties
  const propRes = await pool.query(`
    SELECT property_code, COUNT(*) as cnt
    FROM properties
    GROUP BY property_code
    HAVING COUNT(*) > 1
  `);
  const dupProps = propRes.rowCount;
  console.log(`[1] Duplicate Property Codes: ${dupProps}`);
  if (dupProps > 0) violations++;

  // 2. Duplicate BIDs
  const bidRes = await pool.query(`
    SELECT bid, COUNT(*) as cnt
    FROM bookings
    WHERE bid IS NOT NULL
    GROUP BY bid
    HAVING COUNT(*) > 1
  `);
  const dupBids = bidRes.rowCount;
  console.log(`[2] Duplicate BIDs: ${dupBids}`);
  if (dupBids > 0) violations++;

  // 3. Inventory Drift
  const invNeg = await pool.query(`
    SELECT COUNT(*) as cnt FROM availability_dates WHERE reserved_qty < 0
  `);
  const invExceed = await pool.query(`
    SELECT COUNT(*) as cnt FROM availability_dates WHERE reserved_qty > total_rooms
  `);
  const invDriftCount = Number(invNeg.rows[0].cnt) + Number(invExceed.rows[0].cnt);
  console.log(`[3] Inventory Violations (< 0 or > total_rooms): ${invDriftCount}`);
  if (invDriftCount > 0) violations++;

  // 4. Room Overlaps (Active Booked/Checked-in reservations sharing same room on overlapping [check_in, check_out))
  const overlapRes = await pool.query(`
    SELECT r1.id AS res1, r2.id AS res2, r1.room_id
    FROM reservations r1
    JOIN reservations r2 ON r1.room_id = r2.room_id AND r1.id < r2.id
    WHERE r1.status IN ('BOOKED', 'CHECKED_IN')
      AND r2.status IN ('BOOKED', 'CHECKED_IN')
      AND r1.check_in < r2.check_out
      AND r2.check_in < r1.check_out
  `);
  const overlapCount = overlapRes.rowCount;
  console.log(`[4] Active Room Overlaps: ${overlapCount}`);
  if (overlapCount > 0) violations++;

  // 5. Orphan Reservations (No valid booking_id)
  const orphanRes = await pool.query(`
    SELECT COUNT(*) as cnt
    FROM reservations r
    LEFT JOIN bookings b ON b.id = r.booking_id
    WHERE r.booking_id IS NOT NULL AND b.id IS NULL
  `);
  const orphanResCount = Number(orphanRes.rows[0].cnt);
  console.log(`[5] Orphan Reservations (broken FK): ${orphanResCount}`);
  if (orphanResCount > 0) violations++;

  // 6. Orphan Folio Entries (No valid reservation_id)
  const orphanFolio = await pool.query(`
    SELECT COUNT(*) as cnt
    FROM folio_entries fe
    LEFT JOIN reservations r ON r.id = fe.reservation_id
    WHERE fe.reservation_id IS NOT NULL AND r.id IS NULL
  `);
  const orphanFolioCount = Number(orphanFolio.rows[0].cnt);
  console.log(`[6] Orphan Folio Entries (broken reservation_id): ${orphanFolioCount}`);
  if (orphanFolioCount > 0) violations++;

  // 7. Orphan Payments (No valid reservation_id)
  const orphanPay = await pool.query(`
    SELECT COUNT(*) as cnt
    FROM payment_transactions pt
    LEFT JOIN reservations r ON r.id = pt.reservation_id
    WHERE pt.reservation_id IS NOT NULL AND r.id IS NULL
  `);
  const orphanPayCount = Number(orphanPay.rows[0].cnt);
  console.log(`[7] Orphan Payment Transactions (broken reservation_id): ${orphanPayCount}`);
  if (orphanPayCount > 0) violations++;

  // 8. Folio Property NULL
  const nullFolioProp = await pool.query(`
    SELECT COUNT(*) as cnt
    FROM folio_entries
    WHERE property_id IS NULL
  `);
  const nullFolioPropCount = Number(nullFolioProp.rows[0].cnt);
  console.log(`[8] Folio Entries with NULL property_id: ${nullFolioPropCount}`);
  if (nullFolioPropCount > 0) violations++;

  // 9. Folio Property Mismatch with Booking Property
  const folioMismatch = await pool.query(`
    SELECT COUNT(*) as cnt
    FROM folio_entries fe
    JOIN reservations r ON r.id = fe.reservation_id
    JOIN bookings b ON b.id = r.booking_id
    WHERE fe.property_id <> b.property_id
  `);
  const folioMismatchCount = Number(folioMismatch.rows[0].cnt);
  console.log(`[9] Folio Entries with Property Mismatch: ${folioMismatchCount}`);
  if (folioMismatchCount > 0) violations++;

  // 10. Duplicate Transaction Projections
  const dupTx = await pool.query(`
    SELECT property_id, source_type, source_id, COUNT(*) as cnt
    FROM transactions
    WHERE source_type IS NOT NULL AND source_id IS NOT NULL
    GROUP BY property_id, source_type, source_id
    HAVING COUNT(*) > 1
  `);
  const dupTxCount = dupTx.rowCount;
  console.log(`[10] Duplicate Transaction Projections: ${dupTxCount}`);
  if (dupTxCount > 0) violations++;

  // 11. Test Residue
  const testRes = await pool.query(`
    SELECT COUNT(*) as cnt
    FROM properties
    WHERE name LIKE 'Isolation Prop%' OR name LIKE 'Idempotency Prop%' OR name LIKE 'Anka Prop%'
  `);
  const testResidueCount = Number(testRes.rows[0].cnt);
  console.log(`[11] Test Properties Residue: ${testResidueCount}`);
  if (testResidueCount > 0) violations++;

  console.log('\n======================================================');
  if (violations === 0) {
    console.log('AUDIT RESULT: ALL 11 INVARIANTS SATISFIED (0 VIOLATIONS)');
  } else {
    console.log(`AUDIT RESULT: ${violations} INVARIANTS VIOLATED`);
  }
  console.log('======================================================\n');

  await pool.end();
  process.exit(violations === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Audit fatal error:', err);
  process.exit(1);
});

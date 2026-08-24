require('dotenv').config();
const path = require('path');
const { Pool } = require('pg');

let generateBid;
try {
  ({ generateBid } = require(path.join(__dirname, '..', 'dist', 'utils', 'bid.js')));
} catch (err) {
  throw new Error('Build backend first so dist/utils/bid.js is available.');
}

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db',
});

const BATCH_CORRELATION_ID = 'PHASE_1D2_BID_BACKFILL-20260822';
const EXPECTED_ROWS = 67;

async function getOne(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows[0];
}

async function getCount(client, sql, params = []) {
  const row = await getOne(client, sql, params);
  return Number(row.count || 0);
}

async function assertInitialState() {
  const checks = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM bookings) AS bookings_count,
      (SELECT COUNT(*) FROM reservations) AS reservations_count,
      (SELECT COUNT(*) FROM reservations WHERE booking_id IS NOT NULL) AS booking_id_non_null_count,
      (SELECT COUNT(*) FROM reservations WHERE stay_sequence IS NOT NULL) AS stay_sequence_non_null_count,
      (SELECT COUNT(*) FROM reservations WHERE created_at IS NULL) AS null_created_at_count,
      (SELECT MIN(created_at)::text FROM reservations) AS earliest_created_at,
      (SELECT MAX(created_at)::text FROM reservations) AS latest_created_at,
      (SELECT COUNT(*) FROM reservations r1
        WHERE r1.status IN ('BOOKED', 'CHECKED_IN')
          AND EXISTS (
            SELECT 1
            FROM reservations r2
            WHERE r2.id <> r1.id
              AND r2.status IN ('BOOKED', 'CHECKED_IN')
              AND r2.room_id = r1.room_id
              AND r2.check_in < r1.check_out
              AND r1.check_in < r2.check_out
          )
      ) AS active_overlap_count,
      (SELECT COUNT(*) FROM reservations
        WHERE status IN ('BOOKED', 'CHECKED_IN')
          AND (
            room_id IS NULL
            OR check_in IS NULL
            OR check_out IS NULL
            OR check_out <= check_in
            OR room_id NOT IN (SELECT id FROM rooms)
          )
      ) AS invalid_active_count,
      (SELECT COUNT(*) FROM availability_dates WHERE reserved_qty < 0 OR reserved_qty > total_rooms) AS ledger_violation_count,
      (SELECT COUNT(*) FROM (
        SELECT ad.room_type, ad.date, ad.reserved_qty,
               COALESCE(COUNT(DISTINCT r.id), 0) + COALESCE(SUM(l.qty_locked), 0) AS expected_qty
        FROM availability_dates ad
        LEFT JOIN rooms room ON room.id IS NOT NULL
        LEFT JOIN room_types rt ON rt.name = ad.room_type
        LEFT JOIN reservations r
          ON r.room_id = room.id
         AND r.status IN ('BOOKED', 'CHECKED_IN')
         AND ad.date >= r.check_in
         AND ad.date < r.check_out
         AND room.room_type_id = rt.id
        LEFT JOIN availability_locks l
          ON l.room_type = ad.room_type
         AND l.date = ad.date
        GROUP BY ad.room_type, ad.date, ad.reserved_qty
        HAVING ad.reserved_qty <> (COALESCE(COUNT(DISTINCT r.id), 0) + COALESCE(SUM(l.qty_locked), 0))
      ) drift) AS drift_count
    `);

  const row = checks.rows[0];
  if (Number(row.bookings_count) !== 0) throw new Error(`Expected bookings_count=0, got ${row.bookings_count}`);
  if (Number(row.reservations_count) !== EXPECTED_ROWS) throw new Error(`Expected reservations_count=${EXPECTED_ROWS}, got ${row.reservations_count}`);
  if (Number(row.booking_id_non_null_count) !== 0) throw new Error(`Expected booking_id_non_null_count=0, got ${row.booking_id_non_null_count}`);
  if (Number(row.stay_sequence_non_null_count) !== 0) throw new Error(`Expected stay_sequence_non_null_count=0, got ${row.stay_sequence_non_null_count}`);
  if (Number(row.null_created_at_count) !== 0) throw new Error(`Expected null_created_at_count=0, got ${row.null_created_at_count}`);
  if (Number(row.active_overlap_count) !== 0) throw new Error(`Expected active_overlap_count=0, got ${row.active_overlap_count}`);
  if (Number(row.invalid_active_count) !== 0) throw new Error(`Expected invalid_active_count=0, got ${row.invalid_active_count}`);
  if (Number(row.ledger_violation_count) !== 0) throw new Error(`Expected ledger_violation_count=0, got ${row.ledger_violation_count}`);
  if (Number(row.drift_count) !== 0) throw new Error(`Expected drift_count=0, got ${row.drift_count}`);
}

async function buildMappingPlan(client) {
  await client.query(`
    CREATE TEMP TABLE phase1d2_bid_backfill_plan (
      reservation_id INTEGER PRIMARY KEY,
      booking_id BIGINT,
      bid VARCHAR(32) NOT NULL,
      property_id INTEGER NOT NULL,
      property_code VARCHAR(6) NOT NULL,
      reservation_created_at TEXT NOT NULL,
      property_local_creation_date TEXT NOT NULL,
      legacy_booking_number VARCHAR(50),
      guest_name_snapshot VARCHAR(150) NOT NULL,
      guest_phone_snapshot VARCHAR(50),
      booking_source VARCHAR(20) NOT NULL,
      channel VARCHAR(40),
      booking_status VARCHAR(20) NOT NULL,
      source_classification VARCHAR(40) NOT NULL,
      original_status VARCHAR(30) NOT NULL,
      original_correlation_id VARCHAR(100),
      reservation_status VARCHAR(30) NOT NULL
    ) ON COMMIT DROP;
  `);

  const rows = await client.query(`
    SELECT
      r.id AS reservation_id,
      r.booking_number AS legacy_booking_number,
      r.guest_name,
      r.guest_phone,
      r.status AS reservation_status,
      r.booking_type,
      r.correlation_id AS original_correlation_id,
      r.created_at::text AS reservation_created_at,
      to_char(((r.created_at AT TIME ZONE 'UTC') AT TIME ZONE p.timezone), 'YYMMDD') AS property_local_creation_date,
      p.id AS property_id,
      p.property_code,
      p.currency
    FROM reservations r
    JOIN rooms rm ON rm.id = r.room_id
    JOIN properties p ON p.id = rm.property_id
    ORDER BY r.id
    FOR UPDATE OF r
  `);

  if (rows.rowCount !== EXPECTED_ROWS) {
    throw new Error(`Expected ${EXPECTED_ROWS} reservations in mapping plan, got ${rows.rowCount}`);
  }

  for (const row of rows.rows) {
    const bookingStatus = mapBookingStatus(row.reservation_status);
    const bookingSource = mapBookingSource(row.booking_type);
    const bid = generateBid(String(row.property_code), String(row.property_local_creation_date));

    await client.query(
      `INSERT INTO phase1d2_bid_backfill_plan (
         reservation_id, bid, property_id, property_code, reservation_created_at,
         property_local_creation_date, legacy_booking_number, guest_name_snapshot,
         guest_phone_snapshot, booking_source, channel, booking_status,
         source_classification, original_status, original_correlation_id, reservation_status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        row.reservation_id,
        bid,
        row.property_id,
        row.property_code,
        row.reservation_created_at,
        row.property_local_creation_date,
        row.legacy_booking_number,
        row.guest_name,
        row.guest_phone,
        bookingSource,
        null,
        bookingStatus,
        'LEGACY_ONE_TO_ONE_BACKFILL',
        row.reservation_status,
        row.original_correlation_id,
        row.reservation_status
      ]
    );
  }

  const planCount = await getCount(client, 'SELECT COUNT(*) AS count FROM phase1d2_bid_backfill_plan');
  if (planCount !== EXPECTED_ROWS) {
    throw new Error(`Expected mapping plan rows=${EXPECTED_ROWS}, got ${planCount}`);
  }

  const nullCreatedAtCount = await getCount(client, `
    SELECT COUNT(*) AS count
    FROM phase1d2_bid_backfill_plan
    WHERE reservation_created_at IS NULL OR reservation_created_at = ''
  `);
  if (nullCreatedAtCount !== 0) {
    throw new Error(`Mapping plan contains ${nullCreatedAtCount} reservations without created_at`);
  }

  const propertyMismatchCount = await getCount(client, `
    SELECT COUNT(*) AS count
    FROM phase1d2_bid_backfill_plan
    WHERE property_id <> 1 OR property_code <> 'LWG'
  `);
  if (propertyMismatchCount !== 0) {
    throw new Error(`Mapping plan property mismatch count = ${propertyMismatchCount}`);
  }

  return rows.rows;
}

function mapBookingStatus(status) {
  const normalized = String(status || '').toUpperCase();
  if (normalized === 'CANCELLED') return 'CANCELLED';
  if (normalized === 'CHECKED_OUT') return 'COMPLETED';
  return 'ACTIVE';
}

function mapBookingSource(bookingType) {
  const normalized = String(bookingType || '').toUpperCase();
  if (normalized === 'OTA') return 'OTA';
  if (normalized === 'WALKIN') return 'WALKIN';
  return 'LEGACY';
}

async function insertBookingsAndUpdateReservations(client) {
  const plan = await client.query(`
    SELECT *
    FROM phase1d2_bid_backfill_plan
    ORDER BY reservation_id
    FOR UPDATE
  `);

  const inserted = [];

  for (const row of plan.rows) {
    let bookingId = null;
    let bid = row.bid;
    let attempt = 0;
    while (attempt < 5) {
      attempt += 1;
      try {
        const result = await client.query(
          `INSERT INTO bookings (
             bid, property_id, guest_name_snapshot, guest_phone_snapshot,
             booking_source, channel, booking_status, currency_code,
             legacy_booking_number, created_by, correlation_id, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT currency FROM properties WHERE id = $2),$8,$9,$10,$11)
           RETURNING id`,
          [
            bid,
            row.property_id,
            row.guest_name_snapshot,
            row.guest_phone_snapshot,
            row.booking_source,
            row.channel,
            row.booking_status,
            row.legacy_booking_number,
            'phase1d2-backfill',
            BATCH_CORRELATION_ID,
            row.reservation_created_at
          ]
        );
        bookingId = result.rows[0].id;
        break;
      } catch (err) {
        if (err && err.code === '23505' && err.constraint === 'bookings_bid_unique') {
          bid = generateBid(row.property_code, row.property_local_creation_date);
          continue;
        }
        throw err;
      }
    }

    if (!bookingId) {
      throw new Error(`Failed to generate unique BID for reservation ${row.reservation_id} after 5 attempts`);
    }

    inserted.push({
      reservation_id: row.reservation_id,
      booking_id: bookingId,
      bid,
      property_id: row.property_id,
      legacy_booking_number: row.legacy_booking_number,
      guest_name_snapshot: row.guest_name_snapshot,
      guest_phone_snapshot: row.guest_phone_snapshot,
      booking_status: row.booking_status,
      booking_source: row.booking_source,
      original_status: row.original_status,
      original_correlation_id: row.original_correlation_id,
      property_code: row.property_code,
      reservation_created_at: row.reservation_created_at,
      property_local_creation_date: row.property_local_creation_date
    });
  }

  for (const row of inserted) {
    await client.query(
      `UPDATE reservations
       SET booking_id = $1, stay_sequence = 1
       WHERE id = $2`,
      [row.booking_id, row.reservation_id]
    );

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        'PMS',
        'BACKFILL',
        'BOOKING',
        String(row.booking_id),
        JSON.stringify({
          booking_id: row.booking_id,
          bid: row.bid,
          property_id: row.property_id,
          reservation_id: row.reservation_id,
          legacy_booking_number: row.legacy_booking_number,
          source_reason: 'LEGACY_ONE_TO_ONE_BACKFILL',
          original_reservation_status: row.original_status,
          original_correlation_id: row.original_correlation_id,
          stay_sequence: 1,
          property_code: row.property_code,
          booking_status: row.booking_status,
          booking_source: row.booking_source,
          reservation_created_at: row.reservation_created_at,
          property_local_creation_date: row.property_local_creation_date
        }),
        BATCH_CORRELATION_ID
      ]
    );
  }

  return inserted;
}

async function assertPostCommitState() {
  const checks = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM bookings) AS bookings_count,
      (SELECT COUNT(*) FROM reservations) AS reservations_count,
      (SELECT COUNT(*) FROM reservations WHERE booking_id IS NOT NULL) AS booking_id_non_null_count,
      (SELECT COUNT(*) FROM reservations WHERE stay_sequence IS NOT NULL) AS stay_sequence_non_null_count,
      (SELECT COUNT(*) FROM (SELECT bid FROM bookings GROUP BY bid HAVING COUNT(*) > 1) d) AS duplicate_bid_count,
      (SELECT COUNT(*) FROM reservations r1
        WHERE r1.status IN ('BOOKED', 'CHECKED_IN')
          AND EXISTS (
            SELECT 1
            FROM reservations r2
            WHERE r2.id <> r1.id
              AND r2.status IN ('BOOKED', 'CHECKED_IN')
              AND r2.room_id = r1.room_id
              AND r2.check_in < r1.check_out
              AND r1.check_in < r2.check_out
          )
      ) AS active_overlap_count,
      (SELECT COUNT(*) FROM reservations
        WHERE status IN ('BOOKED', 'CHECKED_IN')
          AND (
            room_id IS NULL
            OR check_in IS NULL
            OR check_out IS NULL
            OR check_out <= check_in
            OR room_id NOT IN (SELECT id FROM rooms)
          )
      ) AS invalid_active_count,
      (SELECT COUNT(*) FROM availability_dates WHERE reserved_qty < 0 OR reserved_qty > total_rooms) AS ledger_violation_count,
      (SELECT COUNT(*) FROM (
        SELECT ad.room_type, ad.date, ad.reserved_qty,
               COALESCE(COUNT(DISTINCT r.id), 0) + COALESCE(SUM(l.qty_locked), 0) AS expected_qty
        FROM availability_dates ad
        LEFT JOIN rooms room ON room.id IS NOT NULL
        LEFT JOIN room_types rt ON rt.name = ad.room_type
        LEFT JOIN reservations r
          ON r.room_id = room.id
         AND r.status IN ('BOOKED', 'CHECKED_IN')
         AND ad.date >= r.check_in
         AND ad.date < r.check_out
         AND room.room_type_id = rt.id
        LEFT JOIN availability_locks l
          ON l.room_type = ad.room_type
         AND l.date = ad.date
        GROUP BY ad.room_type, ad.date, ad.reserved_qty
        HAVING ad.reserved_qty <> (COALESCE(COUNT(DISTINCT r.id), 0) + COALESCE(SUM(l.qty_locked), 0))
      ) drift) AS drift_count,
      (SELECT COUNT(*) FROM bookings b LEFT JOIN reservations r ON r.booking_id = b.id WHERE r.id IS NULL) AS booking_without_reservation_count,
      (SELECT COUNT(*) FROM reservations r LEFT JOIN bookings b ON b.id = r.booking_id WHERE r.booking_id IS NOT NULL AND b.id IS NULL) AS orphan_booking_id_count,
      (SELECT COUNT(*) FROM reservations r JOIN bookings b ON b.id = r.booking_id WHERE r.booking_number IS DISTINCT FROM b.legacy_booking_number) AS legacy_booking_number_mismatch_count,
      (SELECT COUNT(*) FROM reservations r JOIN bookings b ON b.id = r.booking_id WHERE r.guest_name IS DISTINCT FROM b.guest_name_snapshot) AS guest_snapshot_mismatch_count,
      (SELECT COUNT(*) FROM reservations r JOIN bookings b ON b.id = r.booking_id WHERE CASE WHEN r.status = 'CANCELLED' THEN 'CANCELLED' WHEN r.status = 'CHECKED_OUT' THEN 'COMPLETED' ELSE 'ACTIVE' END <> b.booking_status) AS booking_status_mismatch_count,
      (SELECT COUNT(*) FROM audit_logs WHERE correlation_id = $1 AND action = 'BACKFILL' AND entity = 'BOOKING') AS audit_rows_count
  `, [BATCH_CORRELATION_ID]);

  const row = checks.rows[0];
  const expected = {
    bookings_count: 67,
    reservations_count: 67,
    booking_id_non_null_count: 67,
    stay_sequence_non_null_count: 67,
    duplicate_bid_count: 0,
    active_overlap_count: 0,
    invalid_active_count: 0,
    ledger_violation_count: 0,
    drift_count: 0,
    booking_without_reservation_count: 0,
    orphan_booking_id_count: 0,
    legacy_booking_number_mismatch_count: 0,
    guest_snapshot_mismatch_count: 0,
    booking_status_mismatch_count: 0,
    audit_rows_count: 67
  };

  for (const [key, value] of Object.entries(expected)) {
    if (Number(row[key]) !== value) {
      throw new Error(`Post-commit assertion failed for ${key}: expected ${value}, got ${row[key]}`);
    }
  }
}

async function snapshotReservations(client) {
  // Create a snapshot of all immutable fields for all 67 reservations
  // to prove that only booking_id and stay_sequence changed
  const snapshot = await client.query(`
    SELECT
      id,
      room_id,
      guest_name,
      guest_phone,
      check_in::text,
      check_out::text,
      status,
      stay_status,
      booking_number,
      correlation_id,
      created_at::text
    FROM reservations
    ORDER BY id
  `);

  if (snapshot.rowCount !== EXPECTED_ROWS) {
    throw new Error(`Snapshot expected ${EXPECTED_ROWS} rows, got ${snapshot.rowCount}`);
  }

  return snapshot.rows;
}

async function verifyReservationsUnchanged(client, preMutationSnapshot) {
  // Compare post-mutation snapshot against pre-mutation snapshot
  // Only booking_id and stay_sequence should differ
  const postSnapshot = await client.query(`
    SELECT
      id,
      room_id,
      guest_name,
      guest_phone,
      check_in::text,
      check_out::text,
      status,
      stay_status,
      booking_number,
      correlation_id,
      created_at::text
    FROM reservations
    ORDER BY id
  `);

  if (postSnapshot.rowCount !== EXPECTED_ROWS) {
    throw new Error(`Post-mutation snapshot expected ${EXPECTED_ROWS} rows, got ${postSnapshot.rowCount}`);
  }

  const fieldsToCompare = [
    'room_id', 'guest_name', 'guest_phone', 'check_in', 'check_out',
    'status', 'stay_status', 'booking_number', 'correlation_id', 'created_at'
  ];

  for (let i = 0; i < preMutationSnapshot.length; i++) {
    const pre = preMutationSnapshot[i];
    const post = postSnapshot.rows[i];

    if (pre.id !== post.id) {
      throw new Error(`Row order changed at index ${i}: pre id=${pre.id}, post id=${post.id}`);
    }

    for (const field of fieldsToCompare) {
      let preVal = String(pre[field] || '');
      let postVal = String(post[field] || '');
      
      if (preVal !== postVal) {
        throw new Error(
          `Row ${pre.id} field '${field}' changed: '${preVal}' -> '${postVal}'`
        );
      }
    }
  }

  // Specifically verify rows 2, 3, 9 preservation
  for (const legacyId of [2, 3, 9]) {
    const pre = preMutationSnapshot.find(r => r.id === legacyId);
    const post = postSnapshot.rows.find(r => r.id === legacyId);

    if (!pre || !post) {
      throw new Error(`Legacy row ${legacyId} missing in snapshot`);
    }

    if (pre.status !== 'CANCELLED' || post.status !== 'CANCELLED') {
      throw new Error(`Row ${legacyId} status changed from/to ${pre.status} / ${post.status}`);
    }

    if (pre.stay_status !== 'CANCELLED' || post.stay_status !== 'CANCELLED') {
      throw new Error(`Row ${legacyId} stay_status not preserved as CANCELLED`);
    }

    if (String(pre.check_in) !== String(post.check_in) || String(pre.check_out) !== String(post.check_out)) {
      throw new Error(
        `Row ${legacyId} dates changed: check_in ${pre.check_in}->${post.check_in}, check_out ${pre.check_out}->${post.check_out}`
      );
    }
  }
}

async function verifyConstraintRestored(client) {
  // Verify the constraint exists and has NOT VALID status
  const constraint = await client.query(`
    SELECT
      conname,
      pg_get_constraintdef(oid) as definition,
      convalidated
    FROM pg_constraint
    WHERE conrelid = 'reservations'::regclass
      AND conname = 'reservations_check_out_after_check_in'
  `);

  if (constraint.rowCount !== 1) {
    throw new Error(`Expected 1 constraint, found ${constraint.rowCount}`);
  }

  const c = constraint.rows[0];
  if (c.conname !== 'reservations_check_out_after_check_in') {
    throw new Error(`Constraint name mismatch: expected 'reservations_check_out_after_check_in', got '${c.conname}'`);
  }

  const expectedDef = 'CHECK ((check_out > check_in)) NOT VALID';
  if (c.definition !== expectedDef) {
    throw new Error(`Constraint definition mismatch: expected '${expectedDef}', got '${c.definition}'`);
  }

  if (c.convalidated !== false) {
    throw new Error(`Constraint convalidated should be false, got ${c.convalidated}`);
  }
}

async function main() {
  const client = await pool.connect();
  try {
    await assertInitialState();
    await client.query('BEGIN');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    
    // Use ACCESS EXCLUSIVE lock to prevent any concurrent mutations while constraint is absent
    await client.query('LOCK TABLE reservations IN ACCESS EXCLUSIVE MODE');
    await client.query('LOCK TABLE bookings IN SHARE ROW EXCLUSIVE MODE');

    const preflight = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM reservations WHERE booking_id IS NOT NULL) AS booking_id_non_null_count,
        (SELECT COUNT(*) FROM reservations WHERE stay_sequence IS NOT NULL) AS stay_sequence_non_null_count,
        (SELECT COUNT(*) FROM reservations) AS reservation_count,
        (SELECT COUNT(*) FROM reservations r JOIN rooms rm ON rm.id = r.room_id JOIN properties p ON p.id = rm.property_id) AS property_resolvable_count,
        (SELECT COUNT(*) FROM reservations WHERE check_out <= check_in) AS constraint_violation_count
    `);

    const pf = preflight.rows[0];
    if (Number(pf.booking_id_non_null_count) !== 0) throw new Error('booking_id is no longer fully NULL');
    if (Number(pf.stay_sequence_non_null_count) !== 0) throw new Error('stay_sequence is no longer fully NULL');
    if (Number(pf.reservation_count) !== EXPECTED_ROWS) throw new Error(`reservation count changed to ${pf.reservation_count}`);
    if (Number(pf.property_resolvable_count) !== EXPECTED_ROWS) throw new Error(`property resolvable count changed to ${pf.property_resolvable_count}`);
    if (Number(pf.constraint_violation_count) !== 3) throw new Error(`constraint violations should be 3, got ${pf.constraint_violation_count}`);

    // Snapshot all immutable fields BEFORE constraint drop
    const preMutationSnapshot = await snapshotReservations(client);

    // DROP the legacy constraint to allow UPDATE on rows 2,3,9
    await client.query(`
      ALTER TABLE reservations DROP CONSTRAINT reservations_check_out_after_check_in
    `);

    await buildMappingPlan(client);
    const inserted = await insertBookingsAndUpdateReservations(client);

    // RE-ADD the exact legacy constraint with NOT VALID to preserve grandfathering
    await client.query(`
      ALTER TABLE reservations
      ADD CONSTRAINT reservations_check_out_after_check_in
      CHECK (check_out > check_in)
      NOT VALID
    `);

    // Verify constraint was restored correctly
    await verifyConstraintRestored(client);

    // Verify reservation business data unchanged (except booking_id and stay_sequence)
    await verifyReservationsUnchanged(client, preMutationSnapshot);

    const finalCounts = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM bookings) AS bookings_count,
        (SELECT COUNT(*) FROM reservations WHERE booking_id IS NOT NULL) AS booking_id_non_null_count,
        (SELECT COUNT(*) FROM reservations WHERE stay_sequence = 1) AS stay_sequence_one_count,
        (SELECT COUNT(*) FROM reservations WHERE booking_id IS NULL) AS booking_id_null_count,
        (SELECT COUNT(*) FROM (SELECT bid FROM bookings GROUP BY bid HAVING COUNT(*) > 1) d) AS duplicate_bid_count,
        (SELECT COUNT(*) FROM reservations r JOIN bookings b ON b.id = r.booking_id WHERE r.booking_id IS NOT NULL AND b.id IS NULL) AS orphan_booking_id_count,
        (SELECT COUNT(*) FROM bookings b LEFT JOIN reservations r ON r.booking_id = b.id WHERE r.id IS NULL) AS booking_without_reservation_count,
        (SELECT COUNT(*) FROM reservations r JOIN bookings b ON b.id = r.booking_id WHERE r.booking_number IS DISTINCT FROM b.legacy_booking_number) AS legacy_booking_number_mismatch_count,
        (SELECT COUNT(*) FROM reservations r JOIN bookings b ON b.id = r.booking_id WHERE r.guest_name IS DISTINCT FROM b.guest_name_snapshot) AS guest_snapshot_mismatch_count,
        (SELECT COUNT(*) FROM reservations r JOIN bookings b ON b.id = r.booking_id WHERE CASE WHEN r.status = 'CANCELLED' THEN 'CANCELLED' WHEN r.status = 'CHECKED_OUT' THEN 'COMPLETED' ELSE 'ACTIVE' END <> b.booking_status) AS booking_status_mismatch_count,
        (SELECT COUNT(*) FROM audit_logs WHERE correlation_id = $1 AND action = 'BACKFILL' AND entity = 'BOOKING') AS audit_rows_count,
        (SELECT COUNT(*) FROM reservations r LEFT JOIN bookings b ON b.id = r.booking_id WHERE r.booking_id IS NOT NULL AND b.id IS NULL) AS orphan_reservation_booking_count,
        (SELECT COUNT(*) FROM reservations WHERE booking_id IS NOT NULL AND stay_sequence <> 1) AS stay_sequence_not_one_count
    `, [BATCH_CORRELATION_ID]);

    const fc = finalCounts.rows[0];
    console.log(JSON.stringify({
      inserted_count: inserted.length,
      bookings_count: fc.bookings_count,
      booking_id_non_null_count: fc.booking_id_non_null_count,
      stay_sequence_one_count: fc.stay_sequence_one_count,
      booking_id_null_count: fc.booking_id_null_count,
      duplicate_bid_count: fc.duplicate_bid_count,
      orphan_booking_id_count: fc.orphan_booking_id_count,
      booking_without_reservation_count: fc.booking_without_reservation_count,
      legacy_booking_number_mismatch_count: fc.legacy_booking_number_mismatch_count,
      guest_snapshot_mismatch_count: fc.guest_snapshot_mismatch_count,
      booking_status_mismatch_count: fc.booking_status_mismatch_count,
      audit_rows_count: fc.audit_rows_count,
      orphan_reservation_booking_count: fc.orphan_reservation_booking_count,
      stay_sequence_not_one_count: fc.stay_sequence_not_one_count
    }, null, 2));

    await client.query('COMMIT');

    await assertPostCommitState();

    const samples = await pool.query(`
      SELECT
        r.id AS reservation_id,
        r.status AS reservation_status,
        r.guest_name,
        r.booking_number AS legacy_booking_number,
        r.booking_id,
        r.stay_sequence,
        b.bid,
        b.booking_status,
        p.property_code,
        b.guest_name_snapshot,
        b.created_at::text AS booking_created_at
      FROM reservations r
      JOIN bookings b ON b.id = r.booking_id
      JOIN rooms rm ON rm.id = r.room_id
      JOIN properties p ON p.id = rm.property_id
      WHERE r.id IN (2, 3, 9)
         OR r.status = 'BOOKED'
         OR r.status = 'CHECKED_OUT'
         OR r.booking_number IS NULL
      ORDER BY CASE WHEN r.id IN (2, 3, 9) THEN 0 ELSE 1 END, r.id
      LIMIT 8
    `);

    const bidValidation = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE b.bid !~ '^LWG-[0-9]{6}-[0-9A-HJKMNP-TV-Z]{8}$') AS format_failures,
        COUNT(*) FILTER (WHERE b.bid IS NULL) AS null_bids,
        COUNT(*) FILTER (WHERE b.bid LIKE 'LWG-%') AS prefixed_bids,
        COUNT(*) AS total_bids
      FROM bookings b
    `);

    const summary = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM properties) AS property_count,
        (SELECT COUNT(*) FROM rooms) AS room_count,
        (SELECT COUNT(*) FROM room_types) AS room_type_count,
        (SELECT COUNT(*) FROM reservations) AS reservation_count,
        (SELECT COUNT(*) FROM bookings) AS bookings_count,
        (SELECT COUNT(*) FROM reservations WHERE booking_id IS NOT NULL) AS booking_id_non_null_count,
        (SELECT COUNT(*) FROM reservations WHERE stay_sequence IS NOT NULL) AS stay_sequence_non_null_count,
        (SELECT COUNT(*) FROM reservations r1
          WHERE r1.status IN ('BOOKED', 'CHECKED_IN')
            AND EXISTS (
              SELECT 1
              FROM reservations r2
              WHERE r2.id <> r1.id
                AND r2.status IN ('BOOKED', 'CHECKED_IN')
                AND r2.room_id = r1.room_id
                AND r2.check_in < r1.check_out
                AND r1.check_in < r2.check_out
            )
        ) AS active_overlap_count,
        (SELECT COUNT(*) FROM reservations
          WHERE status IN ('BOOKED', 'CHECKED_IN')
            AND (
              room_id IS NULL
              OR check_in IS NULL
              OR check_out IS NULL
              OR check_out <= check_in
              OR room_id NOT IN (SELECT id FROM rooms)
            )
        ) AS invalid_active_count,
        (SELECT COUNT(*) FROM availability_dates WHERE reserved_qty < 0 OR reserved_qty > total_rooms) AS ledger_violation_count,
        (SELECT COUNT(*) FROM (
          SELECT ad.room_type, ad.date, ad.reserved_qty,
                 COALESCE(COUNT(DISTINCT r.id), 0) + COALESCE(SUM(l.qty_locked), 0) AS expected_qty
          FROM availability_dates ad
          LEFT JOIN rooms room ON room.id IS NOT NULL
          LEFT JOIN room_types rt ON rt.name = ad.room_type
          LEFT JOIN reservations r
            ON r.room_id = room.id
           AND r.status IN ('BOOKED', 'CHECKED_IN')
           AND ad.date >= r.check_in
           AND ad.date < r.check_out
           AND room.room_type_id = rt.id
          LEFT JOIN availability_locks l
            ON l.room_type = ad.room_type
           AND l.date = ad.date
          GROUP BY ad.room_type, ad.date, ad.reserved_qty
          HAVING ad.reserved_qty <> (COALESCE(COUNT(DISTINCT r.id), 0) + COALESCE(SUM(l.qty_locked), 0))
        ) drift) AS drift_count
    `);

    console.log(JSON.stringify({
      bid_validation: bidValidation.rows[0],
      summary: summary.rows[0],
      samples: samples.rows
    }, null, 2));
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // ignore rollback failure
    }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

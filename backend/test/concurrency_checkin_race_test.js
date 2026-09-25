
/**
 * CONCURRENCY CHECK-IN RACE TEST
 *
 * Proves that the parent reservation-row lock (FOR UPDATE) serializes
 * financial writers against concurrent POST /api/reservations/:id/checkin,
 * so the check-in always observes the freshest financial state after the
 * writer commits.
 *
 * Three scenarios:
 *   A. Check-in vs post-stay-charge  — writer adds Rp100K, check-in sees
 *      updated outstanding balance and is blocked (PAYMENT_REQUIRED).
 *      Observation: pg_blocking_pids(checkinPid) === [writerPid].
 *   B. Check-in vs revoke-complimentary — writer revokes approved comp,
 *      balance becomes outstanding, check-in is blocked.
 *      Uses coordinator transaction to deterministically create blocking chain:
 *      coordinator blocks revoke (child lock) → revoke blocks check-in (parent lock).
 *      Observation: pg_blocking_pids(revokePid) === [coordinatorPid],
 *                   pg_blocking_pids(checkinPid) === [revokePid].
 *   C. PARKED — no canonical production financial writer exists that
 *      makes a settled (zero balance) reservation become outstanding
 *      while holding the parent reservation lock.
 *
 * Disposable DB: oak_concurrency_checkin_race_test_<ts>
 * NO COMMIT / NO PUSH / NO DEPLOY
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const net = require('net');
const dns = require('dns');
const { initializeDatabase } = require('../dist/db/schema_v3');
const { seedSuperAdmin } = require('../dist/domains/auth/authService');
const { calculateReservationFinancials } = require('../dist/domains/stayCharges/stayChargesService');
const { evaluatePreCheckinEligibility } = require('../dist/domains/checkin/checkinGateService');
const { lockReservationFinancialState } = require('../dist/domains/reservations/reservationLockService');
const { generateToken } = require('../dist/domains/auth/authService');
const { postStayChargeToFolio } = require('../dist/domains/stayCharges/stayChargesService');
const { revokeComplimentaryRequest } = require('../dist/domains/reservations/complimentaryService');

// ── Disposable DB contract ───────────────────────────────────────────────────
function applyDbUrl() {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) return;
  try {
    const u = new URL(raw);
    process.env.DB_HOST = u.hostname || '127.0.0.1';
    process.env.DB_PORT = String(u.port || '5432');
    process.env.DB_USER = u.username;
    process.env.DB_PASSWORD = u.password || '';
  } catch (_) { /* leave env as-is */ }
}
applyDbUrl();

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_DB_NAME = `oak_concurrency_checkin_race_test_${suffix}`;

assert(
  TEST_DB_NAME.startsWith('oak_concurrency_checkin_race_test_'),
  'SAFETY: DB_NAME must start with exact prefix oak_concurrency_checkin_race_test_'
);
assert(
  TEST_DB_NAME !== 'oak_hotel_db' &&
  !TEST_DB_NAME.includes('prod') &&
  !TEST_DB_NAME.includes('staging'),
  'SAFETY: must not target production or staging database'
);

process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'secretpassword';

// ── LOCAL-ONLY DATABASE SAFETY ────────────────────────────────────────────────
function resolveHost(host) {
  try {
    const addr = net.isIP(host);
    if (addr !== 0) return host;
    const results = dns.lookupSync(host, { all: true });
    return results[0].address;
  } catch (_) { return host; }
}

function assertLocalHost(host) {
  const resolved = resolveHost(host);
  const allowed = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!allowed.has(resolved) && !allowed.has(host)) {
    throw new Error(
      `SAFETY: DB_HOST="${host}" (resolved="${resolved}") is not a local address. ` +
      'This test is local-disposable-only. Allowed: 127.0.0.1, ::1, localhost'
    );
  }
}
assertLocalHost(process.env.DB_HOST);

process.env.DB_NAME = TEST_DB_NAME;
process.env.RUN_SCHEMA_INITIALIZATION = 'false';

const testPool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: TEST_DB_NAME,
});

const adminPool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: 'postgres',
});

// ── Output helpers ────────────────────────────────────────────────────────────
function pass(n, desc) { console.log(`  ✓ Scenario ${n}: ${desc}`); }
function fail(n, desc, err) {
  console.error(`  ✗ Scenario ${n}: ${desc}`);
  if (err) console.error(`    Error: ${err.message || err}`);
  process.exitCode = 1;
}
function expectCond(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── Schema bootstrap ──────────────────────────────────────────────────────────
async function bootstrap() {
  await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}"`);
  await adminPool.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
  await initializeDatabase(testPool);

  const propRes = await testPool.query(
    `INSERT INTO properties (id, name, property_code, timezone, currency_code, is_active)
     VALUES (1, 'OAK Concurrency Race Test', 'TST1', 'Asia/Jakarta', 'IDR', TRUE)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       property_code = EXCLUDED.property_code
     RETURNING id`
  );
  expectCond(propRes.rows.length > 0, 'Property id=1 creation failed');
  await testPool.query(`SELECT setval('properties_id_seq', GREATEST((SELECT MAX(id) FROM properties), 1))`);

  await seedSuperAdmin(testPool);

  const saAssert = await testPool.query(`
    SELECT COUNT(*) AS cnt
    FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE r.name = 'Super Admin'
      AND r.property_id IS NULL
      AND r.is_system_role = TRUE
      AND COALESCE(r.is_active, TRUE) = TRUE
      AND COALESCE(u.is_active, TRUE) = TRUE
  `);
  expectCond(
    Number(saAssert.rows[0]?.cnt ?? 0) > 0,
    'Platform Super Admin not found after seedSuperAdmin'
  );

  const rtRes = await testPool.query(
    `INSERT INTO room_types (property_id, name, code, base_rate, capacity, is_active)
     VALUES (1, 'Deluxe King', 'DLX-K', 588000, 2, TRUE)
     RETURNING id`
  );
  expectCond(rtRes.rows.length > 0, 'Room type creation failed');
}

// ── Fixture builder ───────────────────────────────────────────────────────────
let _counter = 0;

/**
 * Creates a settled reservation fixture:
 *   - Guest with phone + valid identity
 *   - Booking + room + reservation (BOOKED)
 *   - Canonical ROOM_CHARGE folio DEBIT
 *   - reservation_nightly_rates
 *   - PRIMARY_GUEST linkage
 *   - identity_custody HELD
 *   - availability_dates entry
 *   - (optional) approved complimentary request + DISCOUNT folio credit
 *   - (optional) ordinary SUCCESS payment transaction
 *   - (optional) payment_evidences row
 */
async function createSettledFixture(pool, opts = {}) {
  _counter += 1;
  const {
    baseRate = 588000,
    payOrdinary = false,
    addEvidence = false,
    compApprove = false,
    compAmount = 0,
    extraCharge = 0,
  } = opts;

  const roomNumber = `10${String(_counter).padStart(2, '0')}`;

  const rtRes = await pool.query('SELECT id FROM room_types WHERE property_id = 1 LIMIT 1');
  const roomTypeId = Number(rtRes.rows[0]?.id);
  expectCond(roomTypeId > 0, 'No canonical room_type found for property_id=1');

  const guestRes = await pool.query(
    `INSERT INTO guests
       (full_name, phone, identity_storage_key, has_valid_identity, vip_status, created_at)
     VALUES ($1, $2, $3, TRUE, 'STANDARD', NOW())
     RETURNING id`,
    ['Budi Santoso', '+6281234567890', 'ktp/budi_2024.jpg']
  );
  const guestId = Number(guestRes.rows[0].id);

  const bookRes = await pool.query(
    `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status, created_at)
     VALUES (1, $1, 'Budi Santoso', 'ACTIVE', NOW())
     RETURNING id`,
    [`RACE-BK-${Date.now()}-${_counter}`]
  );
  const bookingId = Number(bookRes.rows[0].id);

  const checkIn = '2030-07-20';
  const checkOut = '2030-07-21';

  const roomRes = await pool.query(
    `INSERT INTO rooms (property_id, room_number, room_type_id, status, is_active)
     VALUES (1, $1, $2, 'VACANT_CLEAN', TRUE)
     RETURNING id`,
    [roomNumber, roomTypeId]
  );
  expectCond(roomRes.rows.length > 0, 'Room creation failed');
  const roomId = Number(roomRes.rows[0].id);

  // Compute expected remaining balance after all fixtures are applied
  let remainingBalance = baseRate;
  if (compApprove && compAmount > 0) remainingBalance -= compAmount;
  if (payOrdinary) remainingBalance -= baseRate;

  const resRes = await pool.query(
    `INSERT INTO reservations
       (booking_id, room_id, status, stay_status, guest_name, guest_phone,
        check_in, check_out,
        total_price, amount_paid, applied_deposit, remaining_balance, payment_status,
        subtotal_amount, booked_room_type_id_snapshot, stay_sequence,
        has_valid_identity, identity_number)
     VALUES ($1, $2, 'BOOKED', NULL, 'Budi Santoso', '+6281234567890',
        $3::DATE, $4::DATE,
        $5, $6, 0, $7, $8,
        $5, $9, 1,
        TRUE, '3201010101010001')
     RETURNING id`,
    [bookingId, roomId, checkIn, checkOut,
     baseRate, payOrdinary ? baseRate : 0, remainingBalance,
     remainingBalance <= 0.01 ? 'PAID' : 'UNPAID', roomTypeId]
  );
  const reservationId = Number(resRes.rows[0].id);

  // Canonical ROOM_CHARGE folio DEBIT
  await pool.query(
    `INSERT INTO folio_entries
       (reservation_id, property_id, entry_type, description, amount, direction, status, created_at)
     VALUES ($1, 1, 'ROOM_CHARGE', 'Room charge', $2, 'DEBIT', 'POSTED', NOW())`,
    [reservationId, baseRate]
  );

  // Nightly rates
  await pool.query(
    `INSERT INTO reservation_nightly_rates
       (reservation_id, property_id, stay_date, room_type_id,
        base_rate, final_room_rate, service_amount, tax_amount, total_amount, created_at)
     VALUES ($1, 1, $2, $3, $4, $4, 0, 0, $4, NOW())
     ON CONFLICT (reservation_id, stay_date) DO UPDATE SET total_amount = EXCLUDED.total_amount`,
    [reservationId, checkIn, roomTypeId, baseRate]
  );

  // PRIMARY_GUEST
  await pool.query(
    `INSERT INTO reservation_guests (reservation_id, guest_id, role, is_staying)
     VALUES ($1, $2, 'PRIMARY_GUEST', TRUE)
     ON CONFLICT DO NOTHING`,
    [reservationId, guestId]
  );

  // Identity custody HELD
  await pool.query(
    `INSERT INTO identity_custody
       (property_id, reservation_id, scope, status, document_type, document_holder_name, received_by, received_at, created_at)
     VALUES (1, $1, 'ROOM_RESERVATION', 'HELD', 'KTP', 'Budi Santoso', 'System', NOW(), NOW())`,
    [reservationId]
  );

  // Availability
  await pool.query(
    `INSERT INTO availability_dates (room_type_id, room_type, date, reserved_qty, total_rooms)
     VALUES ($1, $2, $3, 1, 10)
     ON CONFLICT (room_type, date) DO UPDATE
       SET reserved_qty = availability_dates.reserved_qty + 1`,
    [roomTypeId, 'Deluxe King', checkIn]
  );

  // Ordinary payment
  let paymentTransactionId = null;
  if (payOrdinary) {
    const payRes = await pool.query(
      `INSERT INTO payment_transactions
         (reservation_id, transaction_type, amount, payment_method, status, created_by)
       VALUES ($1, 'PAYMENT', $2, 'CASH', 'SUCCESS', 'PMS')
       RETURNING id`,
      [reservationId, baseRate]
    );
    paymentTransactionId = Number(payRes.rows[0].id);
  }

  // Payment evidence
  let paymentEvidenceId = null;
  if (payOrdinary && addEvidence && paymentTransactionId) {
    const evRes = await pool.query(
      `INSERT INTO payment_evidences
         (property_id, reservation_id, payment_transaction_id, evidence_type,
          storage_key, original_filename, mime_type, file_size_bytes, is_active, uploaded_by_name_snapshot, uploaded_at)
       VALUES (1, $1, $2, 'BANK_TRANSFER', 'evidence/budi_transfer.jpg',
               'budi_transfer.jpg', 'image/jpeg', 24000, TRUE, 'Front Desk', NOW())
       RETURNING id`,
      [reservationId, paymentTransactionId]
    );
    paymentEvidenceId = Number(evRes.rows[0].id);
  }

  // Approved complimentary discount
  let compRequestId = null;
  if (compApprove) {
    const compIns = await pool.query(
      `INSERT INTO reservation_complimentary_requests
         (property_id, reservation_id, status, category, reason,
          original_gross_amount, pre_complimentary_payable_amount,
          applied_adjustment_amount, requested_at, approved_at)
       VALUES (1, $1, 'APPROVED', 'VIP', 'Loyalty award',
          $2, $2, $3, NOW(), NOW())
       RETURNING id`,
      [reservationId, baseRate, compAmount || baseRate]
    );
    compRequestId = Number(compIns.rows[0].id);

    await pool.query(
      `INSERT INTO folio_entries
         (reservation_id, property_id, entry_type, description, amount, direction,
          source_type, source_id, status, created_at)
       VALUES ($1, 1, 'DISCOUNT', $2, $3, 'CREDIT',
          'COMPLIMENTARY', $4, 'POSTED', NOW())`,
      [reservationId,
       `Complimentary adjustment (VIP): Loyalty award`,
       compAmount || baseRate,
       String(compRequestId)]
    );
  }

  // Extra unpaid charge
  if (extraCharge > 0) {
    await pool.query(
      `INSERT INTO folio_entries
         (reservation_id, property_id, entry_type, description, amount, direction, status, created_at)
       VALUES ($1, 1, 'OTHER_SALE', 'Mini bar charge', $2, 'DEBIT', 'POSTED', NOW())`,
      [reservationId, extraCharge]
    );
  }

  // Persist canonical financials
  await pool.query(
    `UPDATE reservations SET
       amount_paid = $1, applied_deposit = 0,
       remaining_balance = $2, payment_status = $3
     WHERE id = $4`,
    [payOrdinary ? baseRate : 0,
     remainingBalance,
     remainingBalance <= 0.01 ? 'PAID' : 'UNPAID',
     reservationId]
  );

  return {
    reservationId, roomId, roomTypeId, checkIn, checkOut,
    bookingId, guestId,
    compRequestId, paymentTransactionId, paymentEvidenceId,
  };
}

async function cleanupReservation(pool, reservationId, roomId) {
  await pool.query(`DELETE FROM housekeeping_tasks WHERE reservation_id = $1`, [reservationId]).catch(() => {});
  await pool.query(`DELETE FROM reservation_nightly_rates WHERE reservation_id = $1`, [reservationId]).catch(() => {});
  await pool.query(`DELETE FROM folio_entries WHERE reservation_id = $1`, [reservationId]).catch(() => {});
  await pool.query(`DELETE FROM payment_transactions WHERE reservation_id = $1`, [reservationId]).catch(() => {});
  await pool.query(`DELETE FROM payment_evidences WHERE reservation_id = $1`, [reservationId]).catch(() => {});
  await pool.query(`DELETE FROM reservation_complimentary_requests WHERE reservation_id = $1`, [reservationId]).catch(() => {});
  await pool.query(`DELETE FROM reservation_guests WHERE reservation_id = $1`, [reservationId]).catch(() => {});
  await pool.query(`DELETE FROM identity_custody WHERE reservation_id = $1`, [reservationId]).catch(() => {});
  const bookRes = await pool.query(`SELECT booking_id FROM reservations WHERE id = $1`, [reservationId]);
  if (bookRes.rows[0]) {
    await pool.query(`DELETE FROM bookings WHERE id = $1`, [bookRes.rows[0].booking_id]).catch(() => {});
  }
  await pool.query(`DELETE FROM reservations WHERE id = $1`, [reservationId]).catch(() => {});
  await pool.query(`UPDATE rooms SET status = 'VACANT_CLEAN' WHERE id = $1`, [roomId]).catch(() => {});
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
let server = null;
let baseUrl = null;
let testPropertyId = 1;
let authToken = null;
let cachedSaActor = null;

async function getAuthToken() {
  if (authToken) return authToken;
  const saRes = await testPool.query(`
    SELECT u.id, u.username, u.full_name, u.email, r.id AS role_id, r.name AS role
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE r.name = 'Super Admin' AND r.is_system_role = TRUE
    LIMIT 1
  `);
  if (!saRes.rows[0]) throw new Error('Super Admin not found');
  const sa = saRes.rows[0];
  // Cache canonical actor for direct function calls
  cachedSaActor = {
    userId: String(sa.id),
    userName: sa.full_name || sa.email || 'Super Admin',
    userRole: sa.role,
    id: sa.id,
    role: sa.role,
    role_id: sa.role_id,
    property_id: testPropertyId,
  };
  authToken = generateToken({
    id: sa.id, username: sa.username, full_name: sa.full_name,
    email: sa.email || 'sa@test.local', role_id: sa.role_id, role: sa.role,
    property_id: testPropertyId, access_type: 'PMS_STAFF', scope: 'FULL'
  });
  return authToken;
}

async function httpReq(method, path_, body) {
  const token = await getAuthToken();
  return fetch(`${baseUrl}${path_}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(async res => {
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, text };
  });
}

// ── pg_blocking_pids observation helpers ──────────────────────────────────────
//
// PostgreSQL canonical blocking observation uses:
//   pg_stat_activity.pid           — backend PID
//   pg_stat_activity.state         — 'active' means executing
//   pg_stat_activity.query         — current SQL text (parameter values NOT shown)
//   pg_blocking_pids(pid)          — array of PIDs this backend is blocked BY
//
// These replace the earlier (incorrect) pg_locks objid-based helpers.
// The old helpers tried locktype='relation' AND objid=reservationId,
// which does NOT map reservation PK to a row-lock identifier in pg_locks.
// The correct approach is to observe the blocking relationship directly.

const BLOCK_POLL_INTERVAL_MS = 20;
const BLOCK_POLL_TIMEOUT_MS = 10_000;

/**
 * Poll pg_stat_activity until a backend in this database is observed that is
 * blocked by exactly the given `blockedByPid` (canonical PostgreSQL check:
 *   blockedByPid = ANY(pg_blocking_pids(a.pid))
 * ).
 *
 * Returns { pid, query } when found, or null on timeout.
 */
async function waitForBlockedBackend({ pool, blockedByPid, dbFilter = TEST_DB_NAME }) {
  const deadline = Date.now() + BLOCK_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await pool.query(
      `SELECT a.pid, a.state, LEFT(a.query, 200) AS query_sample
       FROM pg_stat_activity a
       WHERE a.datname = $1
         AND a.pid <> pg_backend_pid()
         AND a.state = 'active'
         AND $2 = ANY(pg_blocking_pids(a.pid))
       LIMIT 1`,
      [dbFilter, blockedByPid]
    ).catch(() => ({ rowCount: 0, rows: [] }));
    if (res.rowCount > 0) {
      return { pid: Number(res.rows[0].pid), query: res.rows[0].query_sample };
    }
    await new Promise(r => setTimeout(r, BLOCK_POLL_INTERVAL_MS));
  }
  return null;
}

/**
 * Get the blocking PIDs for a specific backend PID.
 * Returns null on failure.
 */
async function getBlockingPids(pool, pid) {
  try {
    const res = await pool.query(
      `SELECT pg_blocking_pids($1) AS blockers`,
      [pid]
    );
    return res.rows[0]?.blockers ?? [];
  } catch (_) {
    return null;
  }
}

/**
 * Poll until a backend matching a query pattern is observed to be blocked by
 * the given `blockedByPid`. Combines state=active + query pattern match.
 *
 * @param {Pool} pool
 * @param {number} blockedByPid   — the writer's pg_backend_pid()
 * @param {string} queryPattern   — substring to look for in query text (e.g. 'reservations')
 * @returns {Promise<{pid:number, query:string}|null>}
 */
async function waitForBlockedBackendByQuery({ pool, blockedByPid, queryPattern }) {
  const deadline = Date.now() + BLOCK_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await pool.query(
      `SELECT a.pid, a.state, LEFT(a.query, 300) AS query_sample
       FROM pg_stat_activity a
       WHERE a.datname = $1
         AND a.pid <> pg_backend_pid()
         AND a.state = 'active'
         AND $2 = ANY(pg_blocking_pids(a.pid))
         AND a.query ILIKE $3
       LIMIT 1`,
      [TEST_DB_NAME, blockedByPid, `%${queryPattern}%`]
    ).catch(() => ({ rowCount: 0, rows: [] }));
    if (res.rowCount > 0) {
      return { pid: Number(res.rows[0].pid), query: res.rows[0].query_sample };
    }
    await new Promise(r => setTimeout(r, BLOCK_POLL_INTERVAL_MS));
  }
  return null;
}

/**
 * Find an active backend in TEST_DB_NAME whose query contains `pattern`.
 * Excludes well-known test-control PIDs.
 */
async function findActiveBackend(pool, pattern, excludePids = []) {
  const res = await pool.query(
    `SELECT a.pid, a.state, LEFT(a.query, 300) AS query_sample
     FROM pg_stat_activity a
     WHERE a.datname = $1
       AND a.pid <> pg_backend_pid()
       AND NOT EXISTS (SELECT 1 FROM unnest($2::int[]) x WHERE x = a.pid)
       AND a.state = 'active'
       AND a.query ILIKE $3
     LIMIT 1`,
    [TEST_DB_NAME, excludePids, `%${pattern}%`]
  ).catch(() => ({ rowCount: 0, rows: [] }));
  if (res.rowCount === 0) return null;
  return { pid: Number(res.rows[0].pid), query: res.rows[0].query_sample };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== OAK HIMS CONCURRENCY CHECK-IN RACE TEST (${suffix}) ===`);
  console.log(`Disposable DB: ${TEST_DB_NAME}\n`);

  const cleanupErrors = [];
  let appPool = null;
  let realtimeBus = null;

  try {
    console.log('-> Bootstrapping schema ...');
    await bootstrap();
    console.log('   property_id=1, Super Admin seeded');

    const { app: expressApp, pool: _appPool, realtimeBus: _rbus } = require('../dist/index');
    appPool = _appPool;
    realtimeBus = _rbus;

    console.log('-> Starting Express server ...');
    server = http.createServer(expressApp);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    baseUrl = `http://${addr.address}:${addr.port}`;
    console.log(`   Server at ${baseUrl}\n`);

    // ── Helper: assert settled precondition ───────────────────────────────
    async function assertSettled(reservationId, expectedRemaining) {
      const fin = await calculateReservationFinancials(testPool, reservationId, testPropertyId);
      expectCond(
        Math.abs(fin.remaining_balance - expectedRemaining) < 0.01,
        `Precondition: expected remaining_balance≈${expectedRemaining}, got ${fin.remaining_balance}`
      );
      const elig = await evaluatePreCheckinEligibility(testPool, testPropertyId, reservationId);
      expectCond(elig.eligible, `Precondition: reservation should be eligible for check-in before race`);
      return fin;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SCENARIO A — CHECK-IN VS POST STAY CHARGE
    //
    // Writer: BEGIN + lockReservationFinancialState → get writerPid →
    //         start checkinPromise → await blocked check-in by writerPid →
    //         postStayChargeToFolio → COMMIT → await checkinPromise
    //
    // Observation: pg_blocking_pids(checkinPid) contains writerPid confirms check-in
    //              is literally blocked by the writer's transaction.
    //
    // Lock ordering under test:
    //   writer:  reservation FOR UPDATE (lockReservationFinancialState)
    //   checkin: room FOR UPDATE → reservation FOR UPDATE (same table, same row)
    //   Result:  check-in waits for writer's reservation lock → observes fresh state
    // ═══════════════════════════════════════════════════════════════════════
    {
      console.log('─── Scenario A: check-in vs post-stay-charge ───');
      const { reservationId, roomId } = await createSettledFixture(testPool, {
        baseRate: 588000,
        compApprove: true,   // comp full-cover keeps balance at 0
      });
      await assertSettled(reservationId, 0);
      console.log(`   reservationId=${reservationId}  roomId=${roomId}`);

      // Concurrent race with deterministic pg_blocking_pids observation
      const writerClient = await testPool.connect();
      let writerPid = null;
      try {
        await writerClient.query('BEGIN');

        // Writer acquires parent reservation lock
        await lockReservationFinancialState(writerClient, reservationId, testPropertyId);
        console.log('   [writer] reservation lock acquired');

        // Capture EXACT writer backend PID
        const pidRes = await writerClient.query('SELECT pg_backend_pid() AS pid');
        writerPid = Number(pidRes.rows[0]?.pid);
        expectCond(writerPid > 0, 'A: writer backend pid not obtained');
        console.log(`   [observation] writerPid = ${writerPid}`);

        // START check-in HTTP request WHILE writer still holds the reservation lock
        const checkinPromise = httpReq('POST', `/api/reservations/${reservationId}/checkin`, {
          property_id: testPropertyId,
        });

        // Poll pg_stat_activity until we observe the check-in backend blocked BY writerPid.
        // This is the CANONICAL PostgreSQL proof that the check-in transaction is literally
        // waiting on the writer's lock — not just concurrent, but sequenced by the lock.
        const blockedCheckin = await waitForBlockedBackend({
          pool: testPool,
          blockedByPid: writerPid,
        });
        expectCond(blockedCheckin !== null,
          `A: check-in backend not observed blocked by writerPid=${writerPid} within ${BLOCK_POLL_TIMEOUT_MS}ms`);
        console.log(`   [observation] check-in backend PID=${blockedCheckin.pid} CONFIRMED blocked by writerPid=${writerPid} via pg_blocking_pids`);
        console.log(`                 check-in query sample: ${blockedCheckin.query}`);

        // Now writer mutates and commits — check-in will observe fresh state
        const postedCharge = await postStayChargeToFolio(writerClient, testPropertyId, {
          reservation_id: reservationId,
          charge_type: 'PENALTY',
          custom_description: 'Late service charge',
          quantity: 1,
          unit_price: 100000,
          is_override: true,
          override_amount: 100000,
          override_reason: 'Race test: extra charge',
          override_by: 'Test Automation',
          actor_user_id: 'test-sa',
          actor_name: 'Test SA',
          actor_role: 'Super Admin',
        });
        const postedChargeAmount = Math.round(Number(postedCharge?.folio_entry?.amount || 0));
        expectCond(postedChargeAmount > 0,
          `A: expected positive posted charge amount, got ${postedChargeAmount}`);
        console.log(`   [observation] raw requested charge = 100000`);
        console.log(`   [observation] posted canonical charge = ${postedChargeAmount}`);
        await writerClient.query('COMMIT');
        console.log('   [writer] COMMITTED');

        // Await check-in result
        const checkinRes = await checkinPromise;
        console.log(`   HTTP ${checkinRes.status}  code=${checkinRes.body?.code ?? 'none'}  msg=${checkinRes.body?.message || ''}`);

        expectCond(checkinRes.status === 409, `A: expected 409, got ${checkinRes.status}`);
        expectCond(checkinRes.body?.code === 'PAYMENT_REQUIRED',
          `A: expected PAYMENT_REQUIRED, got ${checkinRes.body?.code}`);

        // No partial write
        const resRow = await testPool.query('SELECT status, stay_status FROM reservations WHERE id = $1', [reservationId]);
        expectCond(resRow.rows[0]?.status === 'BOOKED',
          `A: reservation should stay BOOKED, got ${resRow.rows[0]?.status}`);
        expectCond(resRow.rows[0]?.stay_status == null,
          `A: stay_status should be NULL, got ${resRow.rows[0]?.stay_status}`);

        const roomRow = await testPool.query('SELECT status FROM rooms WHERE id = $1', [roomId]);
        expectCond(roomRow.rows[0]?.status === 'VACANT_CLEAN',
          `A: room should stay VACANT_CLEAN, got ${roomRow.rows[0]?.status}`);

        // Exactly one extra charge
        const chargeCount = await testPool.query(
          `SELECT COUNT(*) AS cnt FROM folio_entries
           WHERE reservation_id = $1 AND entry_type = 'PENALTY'
             AND reversal_of_entry_id IS NULL AND is_voided = FALSE`,
          [reservationId]
        );
        expectCond(Number(chargeCount.rows[0]?.cnt) === 1,
          `A: expected exactly 1 PENALTY entry, got ${chargeCount.rows[0]?.cnt}`);

        // Verify DB PENALTY entry amount matches posted amount
        const penaltyEntry = await testPool.query(
          `SELECT amount FROM folio_entries
           WHERE reservation_id = $1 AND entry_type = 'PENALTY'
             AND reversal_of_entry_id IS NULL AND is_voided = FALSE
           LIMIT 1`,
          [reservationId]
        );
        const dbPenaltyAmount = Math.round(Number(penaltyEntry.rows[0]?.amount || 0));
        expectCond(dbPenaltyAmount === postedChargeAmount,
          `A: expected DB PENALTY amount=${postedChargeAmount}, got ${dbPenaltyAmount}`);

        // Financial state updated — canonical remaining equals posted charge amount
        const fin = await calculateReservationFinancials(testPool, reservationId, testPropertyId);
        expectCond(Math.abs(fin.remaining_balance - postedChargeAmount) < 0.01,
          `A: expected remaining_balance≈${postedChargeAmount}, got ${fin.remaining_balance}`);
        console.log(`   [observation] remaining balance = ${fin.remaining_balance}`);

        pass('A',
          `writerPid=${writerPid} serializes check-in (pg_blocking_pids(checkinPid) contains writerPid confirmed); ` +
          `raw charge=100000 → posted=${postedChargeAmount} → remaining=${fin.remaining_balance}; ` +
          'check-in observes updated balance → PAYMENT_REQUIRED; no partial write; exactly 1 charge');
      } finally {
        if (writerClient && writerClient.query) {
          try { await writerClient.query('ROLLBACK'); } catch (_) {}
        }
        writerClient.release();
      }
      await cleanupReservation(testPool, reservationId, roomId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SCENARIO B — CHECK-IN VS REVOKE COMPLIMENTARY (WITH COORDINATOR)
    //
    // Problem: revokeComplimentaryRequest may complete too fast before we can
    //          observe its lock.
    //
    // Solution: coordinator transaction holds the CHILD row (reservation_complimentary_requests)
    //           FOR UPDATE, creating a deterministic blocking chain:
    //             coordinator ← blocks ← revoke (holding reservation parent lock)
    //                                   ↓ blocks
    //                             check-in (waiting on reservation parent lock)
    //
    // Steps:
    //   1. coordinator BEGIN; SELECT ... FOR UPDATE ON req (child row)
    //   2. get coordinatorPid
    //   3. START revokeComplimentaryRequest (will acquire reservation lock, then block on child)
        //   4. poll pg_stat_activity: find revoke backend blocked by coordinatorPid (pg_blocking_pids(revokePid) contains coordinatorPid)
    //   5. get revokePid
    //   6. START check-in HTTP
        //   7. poll pg_stat_activity: find check-in backend blocked by revokePid (pg_blocking_pids(checkinPid) contains revokePid)
    //   8. COMMIT coordinator → revoke proceeds → check-in proceeds
    //
    // Lock ordering under test:
    //   coordinator: req FOR UPDATE (child)
    //   revoke:      reservation FOR UPDATE (parent) → req FOR UPDATE (child, blocked by coordinator)
    //   checkin:     room FOR UPDATE → reservation FOR UPDATE (blocked by revoke's parent lock)
    // ═══════════════════════════════════════════════════════════════════════
    {
      console.log('─── Scenario B: check-in vs revoke-complimentary (coordinator chain) ───');
      const { reservationId, roomId, compRequestId } = await createSettledFixture(testPool, {
        baseRate: 588000,
        compApprove: true,
        compAmount: 588000, // full cover
      });
      await assertSettled(reservationId, 0);
      console.log(`   reservationId=${reservationId}  compRequestId=${compRequestId}`);

      let coordinatorClient = null;
      let coordinatorTransactionOpen = false;
      let coordinatorPid = null;
      let revokePid = null;
      let checkinBlockedPid = null;

      try {
        // ── Step 1: Coordinator acquires child lock ─────────────────────────
        coordinatorClient = await testPool.connect();
        await coordinatorClient.query('BEGIN');
        coordinatorTransactionOpen = true;

        const coordRes = await coordinatorClient.query(
          `SELECT id FROM reservation_complimentary_requests
           WHERE id = $1 FOR UPDATE`,
          [compRequestId]
        );
        expectCond(coordRes.rows.length > 0, 'B: coordinator could not lock child request row');
        console.log('   [coordinator] child request row locked (FOR UPDATE)');

        const coordPidRes = await coordinatorClient.query('SELECT pg_backend_pid() AS pid');
        coordinatorPid = Number(coordPidRes.rows[0]?.pid);
        expectCond(coordinatorPid > 0, 'B: coordinator backend pid not obtained');
        console.log(`   [observation] coordinatorPid = ${coordinatorPid}`);

        // ── Step 2: Start production revoke (will acquire parent reservation lock, then block on child) ──
        // Use real Super Admin from DB to ensure hasPermission resolves correctly
        if (!cachedSaActor) {
          await getAuthToken(); // populate cachedSaActor
        }
        const revokePromise = revokeComplimentaryRequest(testPool, {
          requestId: compRequestId,
          reservationId,
          propertyId: testPropertyId,
          reason: 'Race test: revoke comp',
          actor: cachedSaActor,
        });

        // ── Step 3: Wait until revoke backend is blocked BY coordinator ──────
        const blockedRevoke = await waitForBlockedBackend({
          pool: testPool,
          blockedByPid: coordinatorPid,
        });
        expectCond(blockedRevoke !== null,
          `B: revoke backend not observed blocked by coordinatorPid=${coordinatorPid} within ${BLOCK_POLL_TIMEOUT_MS}ms`);
        revokePid = blockedRevoke.pid;
        console.log(`   [observation] revoke backend PID=${revokePid} CONFIRMED blocked by coordinatorPid=${coordinatorPid} via pg_blocking_pids`);
        console.log(`                 revoke query sample: ${blockedRevoke.query}`);

        // ── Step 4: Start HTTP check-in WHILE revoke holds parent lock ───────
        const checkinPromise = httpReq('POST', `/api/reservations/${reservationId}/checkin`, {
          property_id: testPropertyId,
        });

        // ── Step 5: Wait until check-in backend is blocked BY revoke ─────────
        const blockedCheckin = await waitForBlockedBackend({
          pool: testPool,
          blockedByPid: revokePid,
        });
        expectCond(blockedCheckin !== null,
          `B: check-in backend not observed blocked by revokePid=${revokePid} within ${BLOCK_POLL_TIMEOUT_MS}ms`);
        checkinBlockedPid = blockedCheckin.pid;
        console.log(`   [observation] check-in backend PID=${checkinBlockedPid} CONFIRMED blocked by revokePid=${revokePid} via pg_blocking_pids`);
        console.log(`                 check-in query sample: ${blockedCheckin.query}`);

        // Blocking chain proven:
        //   coordinatorPid → blocks → revokePid → blocks → checkinBlockedPid
        console.log(`   [observation] blocking chain: ${coordinatorPid} → ${revokePid} → ${checkinBlockedPid}`);

        // ── Step 6: Release coordinator → revoke proceeds → check-in proceeds ─
        await coordinatorClient.query('COMMIT');
        coordinatorTransactionOpen = false;
        console.log('   [coordinator] COMMITTED → revoke unblocked');

        await revokePromise;
        console.log('   [writer] revoke COMMITTED');

        const checkinRes = await checkinPromise;
        console.log(`   HTTP ${checkinRes.status}  code=${checkinRes.body?.code ?? 'none'}`);

        expectCond(checkinRes.status === 409, `B: expected 409, got ${checkinRes.status}`);
        expectCond(checkinRes.body?.code === 'PAYMENT_REQUIRED',
          `B: expected PAYMENT_REQUIRED, got ${checkinRes.body?.code}`);

        // No partial write
        const resRow = await testPool.query('SELECT status, stay_status FROM reservations WHERE id = $1', [reservationId]);
        expectCond(resRow.rows[0]?.status === 'BOOKED',
          `B: reservation should stay BOOKED, got ${resRow.rows[0]?.status}`);

        // Exactly one reversal
        const revCount = await testPool.query(
          `SELECT COUNT(*) AS cnt FROM folio_entries
           WHERE reservation_id = $1 AND entry_type = 'REVERSAL'
             AND source_type = 'COMPLIMENTARY' AND reversal_of_entry_id IS NOT NULL`,
          [reservationId]
        );
        expectCond(Number(revCount.rows[0]?.cnt) === 1,
          `B: expected exactly 1 REVERSAL entry, got ${revCount.rows[0]?.cnt}`);

        // Request is REVOKED
        const reqStatus = await testPool.query(
          `SELECT status FROM reservation_complimentary_requests WHERE id = $1`,
          [compRequestId]
        );
        expectCond(reqStatus.rows[0]?.status === 'REVOKED',
          `B: request should be REVOKED, got ${reqStatus.rows[0]?.status}`);

        // Balance is now outstanding
        const fin = await calculateReservationFinancials(testPool, reservationId, testPropertyId);
        expectCond(fin.remaining_balance > 0.01,
          `B: expected remaining_balance > 0.01 after revoke, got ${fin.remaining_balance}`);

        pass('B',
          `exact blocking chain proven: coordinatorPid=${coordinatorPid} → revokePid=${revokePid} → checkinPid=${checkinBlockedPid}; ` +
          'revoke COMMITTED → check-in observes updated balance → PAYMENT_REQUIRED; no partial write; exactly 1 reversal; request REVOKED');
      } finally {
        // Safety rollback: if coordinator transaction was never committed, release it
        if (coordinatorClient) {
          if (coordinatorTransactionOpen) {
            try {
              await coordinatorClient.query('ROLLBACK');
              coordinatorTransactionOpen = false;
              console.log('   [safety] coordinator ROLLBACK executed (was left open)');
            } catch (err) {
              // Rollback failure must NOT be silently swallowed — record it.
              cleanupErrors.push(`coordinator.rollback: ${err.message || err}`);
            }
          }
          coordinatorClient.release();
        }
      }
      await cleanupReservation(testPool, reservationId, roomId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SCENARIO C — PARKED
    //
    // No valid canonical financial writer exists that makes a settled
    // (remaining_balance ≈ 0) reservation become outstanding while holding
    // the parent reservation lock.
    //
    // Analysis of candidates:
    //   • voidFolioEntry on ROOM_CHARGE DEBIT → creates REVERSAL CREDIT entry
    //     → reduces gross charges → remaining_balance goes DOWN, not up
    //   • voidFolioEntry on ordinary PAYMENT CREDIT entry → production guard
    //     rejects: "Pembayaran harus dibatalkan melalui fitur pembatalan
    //     pembayaran" (entry_type = 'PAYMENT' + direction = 'CREDIT' blocked)
    //   • correctFolioEntry → changes amounts but not in a direction that
    //     reliably makes zero-balance become outstanding
    //   • No production "void payment" service that holds parent reservation
    //     lock and makes balance go from zero to positive
    //
    // Conclusion: Scenario C is parked. Two valid race tests (A+B) prove the
    // lock contract more reliably than three fake ones.
    // ═══════════════════════════════════════════════════════════════════════
    {
      console.log('─── Scenario C: PARKED ───');
      console.log('   No canonical production writer makes zero-balance → outstanding');
      console.log('   while holding parent reservation lock.');
      console.log('   Reasons: voidFolioEntry(DEBIT) lowers balance; no void-payment service; correctFolioEntry insufficient.');
      // Note: intentionally NOT calling pass('C',...) — parked scenarios are reported in summary only.
    }

    // ── Invariant check ─────────────────────────────────────────────────────
    {
      console.log('\n--- Invariant check: inventory drift ---');
      const rtRes = await testPool.query('SELECT id FROM room_types WHERE property_id = 1 LIMIT 1');
      const rtId = Number(rtRes.rows[0]?.id);
      if (rtId) {
        const drift = await testPool.query(
          `SELECT COUNT(*) AS cnt FROM availability_dates
           WHERE room_type_id = $1 AND reserved_qty < 0`,
          [rtId]
        );
        expectCond(Number(drift.rows[0]?.cnt ?? 0) === 0,
          `Inventory drift: ${drift.rows[0]?.cnt} negative reserved_qty rows`);
        console.log('  ✓ reserved_qty >= 0 for all dates');
      }
    }

    console.log('\n===========================================');
    console.log('Result: 2 race scenarios passed (A+B); 1 scenario parked (C).');
    console.log('===========================================\n');

  } catch (err) {
    console.error('\n✗ Test FAILED:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    // ── CLEANUP WITH ERROR AGGREGATION ─────────────────────────────────────
    if (server) {
      try {
        await new Promise((resolve, reject) => {
          server.close(() => resolve());
          setTimeout(() => reject(new Error('server close timeout')), 5000);
        });
      } catch (e) {
        cleanupErrors.push(`server.close: ${e.message}`);
      }
    }

    try {
      if (realtimeBus && typeof realtimeBus.stop === 'function') {
        await realtimeBus.stop();
      }
    } catch (e) {
      cleanupErrors.push(`realtimeBus.stop: ${e.message}`);
    }

    try {
      if (appPool && typeof appPool.end === 'function') {
        await appPool.end();
      }
    } catch (e) {
      cleanupErrors.push(`appPool.end: ${e.message}`);
    }

    try {
      await testPool.end();
    } catch (e) {
      cleanupErrors.push(`testPool.end: ${e.message}`);
    }

    try {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEST_DB_NAME]
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}"`);
      console.log(`Dropped disposable DB: ${TEST_DB_NAME}`);
    } catch (e) {
      cleanupErrors.push(`DB cleanup: ${e.message}`);
    }

    try {
      await adminPool.end();
    } catch (e) {
      cleanupErrors.push(`adminPool.end: ${e.message}`);
    }

    if (cleanupErrors.length > 0) {
      console.error('\n⚠ Cleanup errors:');
      for (const err of cleanupErrors) {
        console.error(`  - ${err}`);
      }
      process.exitCode = 1;
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

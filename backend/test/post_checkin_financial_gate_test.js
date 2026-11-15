
/**
 * POST CHECK-IN — FINANCIAL GATE TEST
 *
 * Exercises the real POST /api/reservations/:id/checkin endpoint against a
 * disposable PostgreSQL database bootstrapped with the canonical application
 * schema (initializeDatabase).
 *
 * Six scenarios:
 *   A. outstanding balance > 0        → PAYMENT_REQUIRED  (reservation stays BOOKED)
 *   B. full ordinary payment, no evidence → PAYMENT_EVIDENCE_REQUIRED
 *   C. Approved Complimentary full cover → PASS (CHECKED_IN, OCCUPIED_CLEAN)
 *   D. Approved Complimentary + extra unpaid charge → PAYMENT_REQUIRED
 *   E. mixed ordinary+comp, zero remaining, no evidence → PAYMENT_EVIDENCE_REQUIRED
 *   F. force/override flags with outstanding balance → STILL PAYMENT_REQUIRED
 *
 * Disposable DB: oak_post_checkin_financial_gate_test_<ts>
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
const { calculateReservationFinancials } = require('../dist/domains/stayCharges/stayChargesService');
const { generateToken } = require('../dist/domains/auth/authService');
const { seedSuperAdmin } = require('../dist/domains/auth/authService');

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
const TEST_DB_NAME = `oak_post_checkin_financial_gate_test_${suffix}`;

// Safety assertions
assert(
  TEST_DB_NAME.startsWith('oak_post_checkin_financial_gate_test_'),
  'SAFETY: DB_NAME must start with exact prefix oak_post_checkin_financial_gate_test_'
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
  } catch (_) {
    return host;
  }
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

// Admin pool for lifecycle ops against the "postgres" maintenance database
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
  // 1. Create the disposable database
  await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}"`);
  await adminPool.query(`CREATE DATABASE "${TEST_DB_NAME}"`);

  // 2. Run the canonical schema initialization (NO manual CREATE TABLE)
  await initializeDatabase(testPool);

  // 3. Insert property id=1 explicitly
  const propRes = await testPool.query(
    `INSERT INTO properties (id, name, property_code, timezone, currency_code, is_active)
     VALUES (1, 'OAK Disposable Checkin Test', 'TST1', 'Asia/Jakarta', 'IDR', TRUE)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       property_code = EXCLUDED.property_code
     RETURNING id`
  );
  expectCond(propRes.rows.length > 0, 'Property id=1 creation failed');

  // Advance sequence so subsequent inserts don't collide with id=1
  await testPool.query(`SELECT setval('properties_id_seq', GREATEST((SELECT MAX(id) FROM properties), 1))`);

  // 4. Seed roles and users via production service (canonical)
  await seedSuperAdmin(testPool);

  // 5. Assert Platform Super Admin exists and meets identity invariants
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
    'Platform Super Admin not found after seedSuperAdmin — roles/users may be inconsistent'
  );

  // 6. Create a room type (canonical)
  const rtRes = await testPool.query(
    `INSERT INTO room_types (property_id, name, code, base_rate, capacity, is_active)
     VALUES (1, 'Deluxe King', 'DLX-K', 588000, 2, TRUE)
     RETURNING id`
  );
  expectCond(rtRes.rows.length > 0, 'Room type creation failed');
}

// ── Fixture builder ───────────────────────────────────────────────────────────
let _reservationCounter = 0;

/**
 * Creates a canonical reservation fixture:
 *   - Guest with phone + valid identity (storage key + has_valid_identity)
 *   - Booking linked to the reservation
 *   - Reservation in BOOKED status, VACANT_CLEAN room, PRIMARY_GUEST linked
 *   - Canonical ROOM_CHARGE folio DEBIT (so calculateReservationFinancials uses real charge branch)
 *   - reservation_nightly_rates rows
 *   - identity_custody HELD as guarantee
 *   - availability_dates entry
 *
 * Room numbers are unique per call (10A, 10B, ...) to avoid FK conflicts.
 *
 * @param {Pool} pool
 * @param {number} [baseRate] - total charge amount (default 588000)
 * @param {number} [extraCharge] - additional DEBIT folio entry (default 0)
 * @returns {{ reservationId, roomId, roomTypeId, checkIn, checkOut }}
 */
async function createReservation(pool, baseRate = 588000, extraCharge = 0) {
  _reservationCounter += 1;
  const roomNumber = `10${String(_reservationCounter).padStart(2, '0')}`; // 10A, 10B, ...

  // Read canonical room type
  const rtRes = await pool.query('SELECT id FROM room_types WHERE property_id = 1 LIMIT 1');
  const roomTypeId = Number(rtRes.rows[0]?.id);
  expectCond(roomTypeId > 0, 'No canonical room_type found for property_id=1');

  // Guest: phone + identity_storage_key + has_valid_identity = identity gate passes
  const guestRes = await pool.query(
    `INSERT INTO guests
       (full_name, phone, identity_storage_key, has_valid_identity, vip_status, created_at)
     VALUES ($1, $2, $3, TRUE, 'STANDARD', NOW())
     RETURNING id`,
    ['Budi Santoso', '+6281234567890', 'ktp/budi_2024.jpg']
  );
  const guestId = Number(guestRes.rows[0].id);

  // Booking (property_id=1)
  const bookRes = await pool.query(
    `INSERT INTO bookings
       (property_id, bid, guest_name_snapshot, booking_status, created_at)
     VALUES (1, $1, 'Budi Santoso', 'ACTIVE', NOW())
     RETURNING id`,
    [`PILOT-BK-${Date.now()}-${_reservationCounter}`]
  );
  const bookingId = Number(bookRes.rows[0].id);

  const checkIn = '2030-06-15';
  const checkOut = '2030-06-16';

  // Single INSERT room (no placeholder hack)
  const roomRes = await pool.query(
    `INSERT INTO rooms (property_id, room_number, room_type_id, status, is_active)
     VALUES (1, $1, $2, 'VACANT_CLEAN', TRUE)
     RETURNING id`,
    [roomNumber, roomTypeId]
  );
  expectCond(roomRes.rows.length > 0, 'Room creation failed');
  const roomId = Number(roomRes.rows[0].id);

  // Reservation (BOOKED) - no property_id column, property resolved via booking
  const resRes = await pool.query(
    `INSERT INTO reservations
       (booking_id, room_id, status, stay_status, guest_name, guest_phone,
        check_in, check_out,
        total_price, amount_paid, applied_deposit, remaining_balance, payment_status,
        subtotal_amount, booked_room_type_id_snapshot, stay_sequence,
        has_valid_identity, identity_number)
     VALUES ($1, $2, 'BOOKED', NULL, 'Budi Santoso', '+6281234567890',
        $3::DATE, $4::DATE,
        $5, 0, 0, $5, 'UNPAID',
        $5, $6, 1,
        TRUE, '3201010101010001')
     RETURNING id`,
    [bookingId, roomId, checkIn, checkOut, baseRate, roomTypeId]
  );
  const reservationId = Number(resRes.rows[0].id);

  // Canonical ROOM_CHARGE folio DEBIT — the source that drives netTotalCharges
  await pool.query(
    `INSERT INTO folio_entries
       (reservation_id, property_id, entry_type, description, amount, direction, status, created_at)
     VALUES ($1, 1, 'ROOM_CHARGE', 'Room charge', $2, 'DEBIT', 'POSTED', NOW())`,
    [reservationId, baseRate]
  );

  // Nightly rate — canonical channel for netTotalCharges calculation
  await pool.query(
    `INSERT INTO reservation_nightly_rates
       (reservation_id, property_id, stay_date, room_type_id,
        base_rate, final_room_rate, service_amount, tax_amount, total_amount, created_at)
     VALUES ($1, 1, $2, $3, $4, $4, 0, 0, $4, NOW())
     ON CONFLICT (reservation_id, stay_date) DO UPDATE SET total_amount = EXCLUDED.total_amount`,
    [reservationId, checkIn, roomTypeId, baseRate]
  );

  // PRIMARY_GUEST linkage
  await pool.query(
    `INSERT INTO reservation_guests (reservation_id, guest_id, role, is_staying)
     VALUES ($1, $2, 'PRIMARY_GUEST', TRUE)
     ON CONFLICT DO NOTHING`,
    [reservationId, guestId]
  );

  // Identity custody HELD -> satisfies GUARANTEE gate without interfering with financial gate
  await pool.query(
    `INSERT INTO identity_custody
       (property_id, reservation_id, scope, status, document_type, document_holder_name, received_by, received_at, created_at)
     VALUES (1, $1, 'ROOM_RESERVATION', 'HELD', 'KTP', 'Budi Santoso', 'System', NOW(), NOW())`,
    [reservationId]
  );

  // Availability - use legacy UNIQUE(room_type, date) for ON CONFLICT
  await pool.query(
    `INSERT INTO availability_dates (room_type_id, room_type, date, reserved_qty, total_rooms)
     VALUES ($1, $2, $3, 1, 10)
     ON CONFLICT (room_type, date) DO UPDATE
       SET reserved_qty = availability_dates.reserved_qty + 1`,
    [roomTypeId, 'Deluxe King', checkIn]
  );

  // Extra unpaid charge (folio DEBIT) - only for Scenario D
  if (extraCharge > 0) {
    await pool.query(
      `INSERT INTO folio_entries
         (reservation_id, property_id, entry_type, description, amount, direction, status, created_at)
       VALUES ($1, 1, 'OTHER_SALE', 'Mini bar charge', $2, 'DEBIT', 'POSTED', NOW())`,
      [reservationId, extraCharge]
    );
  }

  return { reservationId, roomId, roomTypeId, checkIn, checkOut };
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

// ── HTTP request helper ───────────────────────────────────────────────────────
let server = null;
let baseUrl = null;
let testPropertyId = 1;
let authToken = null;

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

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== OAK HIMS POST-CHECKIN-FINANCIAL-GATE v6 (${suffix}) ===`);
  console.log(`Disposable DB: ${TEST_DB_NAME}\n`);

  const cleanupErrors = [];

  // Lifecycle references declared at main() scope so finally can safely reference them
  let appPool = null;
  let realtimeBus = null;

  try {
    // Bootstrap: disposable DB + canonical schema + property + super admin
    console.log('-> Bootstrapping schema ...');
    await bootstrap();
    console.log(`   property_id=1`);

    // Import app AFTER env vars are fully set (required by spec)
    const { app: expressApp, pool: _appPool, realtimeBus: _rbus } = require('../dist/index');
    appPool = _appPool;
    realtimeBus = _rbus;

    // Start Express deterministically (no setTimeout)
    console.log('-> Starting Express server ...');
    server = http.createServer(expressApp);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    baseUrl = `http://${addr.address}:${addr.port}`;
    console.log(`   Server at ${baseUrl}\n`);

    const BASE_RATE = 588000;

    // ═══════════════════════════════════════════════════════════════════════
    // SCENARIO A: Outstanding balance > 0 -> PAYMENT_REQUIRED
    // ═══════════════════════════════════════════════════════════════════════
    {
      const { reservationId, roomId } = await createReservation(testPool, BASE_RATE);
      console.log('--- Scenario A: unpaid reservation -> PAYMENT_REQUIRED ---');

      // Assert canonical financials before POST
      const fin = await calculateReservationFinancials(testPool, reservationId, testPropertyId);
      expectCond(fin.remaining_balance > 0.01,
        `A: expected remaining_balance > 0.01, got ${fin.remaining_balance}`);

      const res = await httpReq('POST', `/api/reservations/${reservationId}/checkin`, { property_id: testPropertyId });
      console.log(`   HTTP ${res.status}  code=${res.body?.code ?? 'none'}  msg=${res.body?.message || ''}`);

      expectCond(res.status === 409, `A: expected 409, got ${res.status}`);
      expectCond(res.body?.code === 'PAYMENT_REQUIRED',
        `A: expected PAYMENT_REQUIRED, got ${res.body?.code}`);

      // Verify reservation NOT partially mutated
      const verify = await testPool.query('SELECT status FROM reservations WHERE id = $1', [reservationId]);
      expectCond(verify.rows[0]?.status === 'BOOKED',
        `A: reservation should stay BOOKED, got ${verify.rows[0]?.status}`);

      pass('A', 'Unpaid reservation blocked with PAYMENT_REQUIRED');
      await cleanupReservation(testPool, reservationId, roomId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SCENARIO B: Full ordinary payment, no evidence -> PAYMENT_EVIDENCE_REQUIRED
    // Canonical source: payment_transactions SUCCESS ROOM_RESERVATION only.
    // No manual folio_entries CREDIT -- not needed by canonical calculator.
    // ═══════════════════════════════════════════════════════════════════════
    {
      const { reservationId, roomId } = await createReservation(testPool, BASE_RATE);
      console.log('--- Scenario B: paid but no evidence -> PAYMENT_EVIDENCE_REQUIRED ---');

      // Insert ordinary SUCCESS payment (canonical source only)
      await testPool.query(
        `INSERT INTO payment_transactions
           (reservation_id, transaction_type, amount, payment_method, status, created_by)
         VALUES ($1, 'PAYMENT', $2, 'CASH', 'SUCCESS', 'PMS')`,
        [reservationId, BASE_RATE]
      );
      // NO manual folio_entries CREDIT -- canonical calculator reads payment_transactions directly

      // Assert canonical: remaining_balance <= 0.01
      const fin = await calculateReservationFinancials(testPool, reservationId, testPropertyId);
      expectCond(fin.remaining_balance <= 0.01,
        `B: expected remaining_balance <= 0.01, got ${fin.remaining_balance}`);

      const res = await httpReq('POST', `/api/reservations/${reservationId}/checkin`, { property_id: testPropertyId });
      console.log(`   HTTP ${res.status}  code=${res.body?.code ?? 'none'}`);

      expectCond(res.status === 409, `B: expected 409, got ${res.status}`);
      expectCond(res.body?.code === 'PAYMENT_EVIDENCE_REQUIRED',
        `B: expected PAYMENT_EVIDENCE_REQUIRED, got ${res.body?.code}`);

      const verify = await testPool.query('SELECT status FROM reservations WHERE id = $1', [reservationId]);
      expectCond(verify.rows[0]?.status === 'BOOKED',
        `B: reservation should stay BOOKED, got ${verify.rows[0]?.status}`);

      pass('B', 'Paid reservation without evidence blocked with PAYMENT_EVIDENCE_REQUIRED');
      await cleanupReservation(testPool, reservationId, roomId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SCENARIO C: Approved Complimentary full cover -> PASS (CHECKED_IN)
    // ═══════════════════════════════════════════════════════════════════════
    {
      const { reservationId, roomId } = await createReservation(testPool, BASE_RATE);
      console.log('--- Scenario C: approved complimentary full cover -> PASS ---');

      // Approved complimentary request
      const compRes = await testPool.query(
        `INSERT INTO reservation_complimentary_requests
           (property_id, reservation_id, status, category, reason,
            original_gross_amount, pre_complimentary_payable_amount,
            applied_adjustment_amount, requested_at, approved_at)
         VALUES ($1, $2, 'APPROVED', 'VIP', 'Loyalty award',
            $3, $3, $3, NOW(), NOW())
         RETURNING id`,
        [testPropertyId, reservationId, BASE_RATE]
      );
      const compId = String(compRes.rows[0].id);

      // COMPLIMENTARY DISCOUNT folio credit
      await testPool.query(
        `INSERT INTO folio_entries
           (reservation_id, property_id, entry_type, description, amount, direction,
            source_type, source_id, status, created_at)
         VALUES ($1, $2, 'DISCOUNT', $3, $4, 'CREDIT',
            'COMPLIMENTARY', $5, 'POSTED', NOW())`,
        [reservationId, testPropertyId,
         `Complimentary adjustment (VIP): Loyalty award`, BASE_RATE, compId]
      );

      // Assert canonical: remaining_balance <= 0.01
      const fin = await calculateReservationFinancials(testPool, reservationId, testPropertyId);
      console.log(`   Canonical remaining_balance = ${fin.remaining_balance}`);
      expectCond(fin.remaining_balance <= 0.01,
        `C: expected remaining_balance <= 0.01, got ${fin.remaining_balance}`);

      const res = await httpReq('POST', `/api/reservations/${reservationId}/checkin`, {
        property_id: testPropertyId,
      });
      console.log(`   HTTP ${res.status}  status=${res.body?.data?.status ?? 'n/a'}`);

      expectCond(res.status === 200, `C: expected 200, got ${res.status}: ${res.body?.message || res.text}`);
      expectCond(res.body?.data?.status === 'CHECKED_IN',
        `C: expected CHECKED_IN, got ${res.body?.data?.status}`);

      // Downstream state assertions
      const resRow = await testPool.query('SELECT status, stay_status FROM reservations WHERE id = $1', [reservationId]);
      expectCond(resRow.rows[0]?.status === 'CHECKED_IN',
        `C: reservation.status = CHECKED_IN, got ${resRow.rows[0]?.status}`);
      expectCond(resRow.rows[0]?.stay_status === 'IN_HOUSE',
        `C: stay_status = IN_HOUSE, got ${resRow.rows[0]?.stay_status}`);

      const roomRow = await testPool.query('SELECT status FROM rooms WHERE id = $1', [roomId]);
      expectCond(roomRow.rows[0]?.status === 'OCCUPIED_CLEAN',
        `C: room.status = OCCUPIED_CLEAN, got ${roomRow.rows[0]?.status}`);

      pass('C', 'Approved complimentary full cover allows check-in (evidence WAIVED)');
      await cleanupReservation(testPool, reservationId, roomId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SCENARIO D: Approved Comp + extra unpaid charge -> PAYMENT_REQUIRED
    // ═══════════════════════════════════════════════════════════════════════
    {
      const extraCharge = 100000;
      const { reservationId, roomId } = await createReservation(testPool, BASE_RATE, extraCharge);
      console.log('--- Scenario D: comp + extra unpaid charge -> PAYMENT_REQUIRED ---');

      // Approved complimentary covering BASE_RATE only
      const compRes = await testPool.query(
        `INSERT INTO reservation_complimentary_requests
           (property_id, reservation_id, status, category, reason,
            original_gross_amount, pre_complimentary_payable_amount,
            applied_adjustment_amount, requested_at, approved_at)
         VALUES ($1, $2, 'APPROVED', 'SERVICE_RECOVERY', 'Mini-bar waiver',
            $3, $3, $3, NOW(), NOW())
         RETURNING id`,
        [testPropertyId, reservationId, BASE_RATE]
      );
      await testPool.query(
        `INSERT INTO folio_entries
           (reservation_id, property_id, entry_type, description, amount, direction,
            source_type, source_id, status, created_at)
         VALUES ($1, $2, 'DISCOUNT', 'Complimentary adjustment', $3, 'CREDIT',
            'COMPLIMENTARY', $4, 'POSTED', NOW())`,
        [reservationId, testPropertyId, BASE_RATE, String(compRes.rows[0].id)]
      );

      // Extra charge was already inserted by createReservation(..., extraCharge)
      // Assert canonical: remaining_balance === extraCharge (proving no double-count)
      const fin = await calculateReservationFinancials(testPool, reservationId, testPropertyId);
      console.log(`   Canonical remaining_balance = ${fin.remaining_balance} (expected ${extraCharge})`);
      expectCond(fin.remaining_balance === extraCharge,
        `D: expected remaining_balance=${extraCharge}, got ${fin.remaining_balance}`);

      const res = await httpReq('POST', `/api/reservations/${reservationId}/checkin`, {
        property_id: testPropertyId,
      });
      console.log(`   HTTP ${res.status}  code=${res.body?.code ?? 'none'}`);

      expectCond(res.status === 409, `D: expected 409, got ${res.status}`);
      expectCond(res.body?.code === 'PAYMENT_REQUIRED',
        `D: expected PAYMENT_REQUIRED, got ${res.body?.code}`);

      const verify = await testPool.query('SELECT status FROM reservations WHERE id = $1', [reservationId]);
      expectCond(verify.rows[0]?.status === 'BOOKED',
        `D: reservation should stay BOOKED, got ${verify.rows[0]?.status}`);

      pass('D', 'Comp + extra unpaid charge blocked with PAYMENT_REQUIRED (no double-count)');
      await cleanupReservation(testPool, reservationId, roomId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SCENARIO E: Mixed ordinary + comp, zero remaining, no evidence -> PAYMENT_EVIDENCE_REQUIRED
    // baseRate=500000, comp=300000, payment=200000 -> remaining=0
    // ═══════════════════════════════════════════════════════════════════════
    {
      const E_BASE_RATE = 500000;
      const E_COMP_AMT = 300000;
      const E_ORDINARY_AMT = 200000;
      const { reservationId, roomId } = await createReservation(testPool, E_BASE_RATE);
      console.log('--- Scenario E: mixed pay+comp, zero balance, no evidence -> PAYMENT_EVIDENCE_REQUIRED ---');

      // Approved complimentary (original_gross_amount = full base rate, applied = partial)
      const compRes = await testPool.query(
        `INSERT INTO reservation_complimentary_requests
           (property_id, reservation_id, status, category, reason,
            original_gross_amount, pre_complimentary_payable_amount,
            applied_adjustment_amount, requested_at, approved_at)
         VALUES ($1, $2, 'APPROVED', 'VIP', 'Partial waiver',
            $3, $3, $4, NOW(), NOW())
         RETURNING id`,
        [testPropertyId, reservationId, E_BASE_RATE, E_COMP_AMT]
      );
      // COMPLIMENTARY DISCOUNT folio credit (only applied amount)
      await testPool.query(
        `INSERT INTO folio_entries
           (reservation_id, property_id, entry_type, description, amount, direction,
            source_type, source_id, status, created_at)
         VALUES ($1, $2, 'DISCOUNT', 'Partial complimentary', $3, 'CREDIT',
            'COMPLIMENTARY', $4, 'POSTED', NOW())`,
        [reservationId, testPropertyId, E_COMP_AMT, String(compRes.rows[0].id)]
      );

      // Ordinary SUCCESS payment (canonical source only - no manual folio CREDIT)
      await testPool.query(
        `INSERT INTO payment_transactions
           (reservation_id, transaction_type, amount, payment_method, status, created_by)
         VALUES ($1, 'PAYMENT', $2, 'CASH', 'SUCCESS', 'PMS')`,
        [reservationId, E_ORDINARY_AMT]
      );
      // NO manual folio_entries CREDIT -- canonical calculator reads payment_transactions directly

      // NO payment_evidences row -- evidence required but absent
      const fin = await calculateReservationFinancials(testPool, reservationId, testPropertyId);
      console.log(`   Canonical remaining_balance = ${fin.remaining_balance} (expected <= 0.01)`);
      expectCond(fin.remaining_balance <= 0.01,
        `E: expected remaining_balance <= 0.01, got ${fin.remaining_balance}`);

      const res = await httpReq('POST', `/api/reservations/${reservationId}/checkin`, {
        property_id: testPropertyId,
      });
      console.log(`   HTTP ${res.status}  code=${res.body?.code ?? 'none'}`);

      expectCond(res.status === 409, `E: expected 409, got ${res.status}`);
      expectCond(res.body?.code === 'PAYMENT_EVIDENCE_REQUIRED',
        `E: expected PAYMENT_EVIDENCE_REQUIRED, got ${res.body?.code}`);

      const verify = await testPool.query('SELECT status FROM reservations WHERE id = $1', [reservationId]);
      expectCond(verify.rows[0]?.status === 'BOOKED',
        `E: reservation should stay BOOKED, got ${verify.rows[0]?.status}`);

      pass('E', 'Mixed comp+ordinary, zero balance, no evidence -> PAYMENT_EVIDENCE_REQUIRED');
      await cleanupReservation(testPool, reservationId, roomId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SCENARIO F: force/override flags on unpaid -> STILL PAYMENT_REQUIRED
    // ═══════════════════════════════════════════════════════════════════════
    {
      const { reservationId, roomId } = await createReservation(testPool, BASE_RATE);
      console.log('--- Scenario F: force+overrides on unpaid -> STILL PAYMENT_REQUIRED ---');

      const fin = await calculateReservationFinancials(testPool, reservationId, testPropertyId);
      expectCond(fin.remaining_balance > 0.01,
        `F: expected remaining_balance > 0.01, got ${fin.remaining_balance}`);

      const res = await httpReq('POST', `/api/reservations/${reservationId}/checkin`, {
        property_id: testPropertyId,
        force: true,
        override_guest_identity: true,
        override_housekeeping: true,
      });
      console.log(`   HTTP ${res.status}  code=${res.body?.code ?? 'none'}`);

      expectCond(res.status === 409, `F: expected 409, got ${res.status}`);
      expectCond(res.body?.code === 'PAYMENT_REQUIRED',
        `F: expected PAYMENT_REQUIRED, got ${res.body?.code}`);

      const verify = await testPool.query('SELECT status FROM reservations WHERE id = $1', [reservationId]);
      expectCond(verify.rows[0]?.status === 'BOOKED',
        `F: reservation should stay BOOKED, got ${verify.rows[0]?.status}`);

      pass('F', 'Force/override flags do NOT bypass canonical financial gate');
      await cleanupReservation(testPool, reservationId, roomId);
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
    console.log('All 6 scenarios passed.');
    console.log('===========================================\n');

  } catch (err) {
    console.error('\n✗ Test FAILED:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    // ── CLEANUP WITH ERROR AGGREGATION ─────────────────────────────────────
    // Attempt every step even if one fails; collect errors then surface them.
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

    // Terminate connections to disposable DB and drop it
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
      cleanupErrors.push(`DB cleanup (terminate/drop ${TEST_DB_NAME}): ${e.message}`);
    }

    try {
      await adminPool.end();
    } catch (e) {
      cleanupErrors.push(`adminPool.end: ${e.message}`);
    }

    // If any cleanup step failed, surface it
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

/**
 * CHECKOUT-FOLIO-GATE-1B — SAFE TEST ISOLATION
 * Uses disposable test DB with exact-ID isolation. No wildcard deletes.
 */
'use strict';

const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { app } = require('../dist/index');

const runId = `CHECKOUT-1B-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// DB SAFETY: Must use disposable test DB
const currentDb = process.env.DB_NAME || 'oak_checkout_folio_gate_test';
if (!currentDb.includes('test')) {
  console.error(`\n❌ SAFETY VIOLATION: Cannot run against production DB "${currentDb}"`);
  process.exit(1);
}

const testPool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: currentDb
});

let server, baseUrl;
let testPropertyId = null;
const createdReservationIds = new Set();
const createdRoomIds = new Set();

const { generateToken } = require('../dist/domains/auth/authService');

function genId() {
  return `${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).toUpperCase().slice(2, 8)}`;
}

async function authHeaders(pool) {
  const saRes = await pool.query(`
    SELECT u.id, u.username, u.full_name, u.email, r.id AS role_id, r.name AS role
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE r.name = 'Super Admin' AND r.is_system_role = TRUE
    LIMIT 1
  `);
  if (!saRes.rows[0]) throw new Error('Super Admin not found');
  const sa = saRes.rows[0];
  const token = generateToken({
    id: sa.id, username: sa.username, full_name: sa.full_name,
    email: sa.email || 'sa@test.local', role_id: sa.role_id, role: sa.role,
    property_id: testPropertyId, access_type: 'PMS_STAFF', scope: 'FULL'
  });
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function request(pool, method, path_, body) {
  const headers = await authHeaders(pool);
  const res = await fetch(`${baseUrl}${path_}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, body: data };
}

function pass(n, d) { console.log(`  PASS #${n}: ${d}`); }
function fail(n, d, err) { console.error(`  FAIL #${n}: ${d}`); console.error(`    Error:`, err?.message || err); process.exitCode = 1; }

async function initServer() {
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => setTimeout(r, 500));
  const addr = server.address();
  baseUrl = `http://${addr.address}:${addr.port}`;
}

async function teardown() {
  if (server) { server.close(); await new Promise(r => setTimeout(r, 200)); }
  await testPool.end();
}

async function createTestBooking(
  pool,
  roomId,
  roomTypeId,
  checkIn,
  checkOut,
  baseRate,
  paymentResponsibility = 'HOTEL_COLLECT'
) {
  const bid = `TEST-BK-${genId()}`;

  const bookRes = await pool.query(
    `INSERT INTO bookings (
       property_id, bid, guest_name_snapshot, booking_status,
       payment_responsibility, created_at, updated_at
     )
     VALUES ($1, $2, $3, 'ACTIVE', $4, NOW(), NOW()) RETURNING id`,
    [testPropertyId, bid, `Guest${genId().slice(0, 4)}`, paymentResponsibility]
  );
  const bookingId = bookRes.rows[0].id;

  const resRes = await pool.query(
    `INSERT INTO reservations (
       booking_id, room_id, status, stay_status, guest_name, stay_sequence,
       check_in, check_out, total_price, amount_paid, applied_deposit, remaining_balance, payment_status,
       booked_room_type_id_snapshot
     ) VALUES ($1, $2, 'CHECKED_IN', 'IN_HOUSE', 'Test Guest', 1, $3, $4, $5, 0, 0, 0, 'UNPAID', $6)
     RETURNING id`,
    [bookingId, roomId, checkIn, checkOut, baseRate, roomTypeId]
  );
  const reservationId = resRes.rows[0].id;
  createdReservationIds.add(reservationId);

  await pool.query(
    `INSERT INTO reservation_nightly_rates
       (reservation_id, property_id, stay_date, room_type_id, base_rate, final_room_rate,
        service_amount, tax_amount, total_amount, created_at)
     VALUES ($1, $2, $3, $4, $5, $5, 0, 50000, $5, NOW())`,
    [reservationId, testPropertyId, checkIn, roomTypeId, baseRate]
  );

  await pool.query(
    `UPDATE availability_dates SET reserved_qty = reserved_qty + 1
     WHERE room_type_id = $1 AND date::date = $2`,
    [roomTypeId, checkIn]
  );

  await pool.query(`UPDATE rooms SET status = 'VACANT' WHERE id = $1`, [roomId]).catch(() => {});
  createdRoomIds.add(roomId);

  return { bookingId, reservationId, roomId };
}

async function cleanupTestReservation(pool, reservationId, roomId) {
  await pool.query(`DELETE FROM housekeeping_tasks WHERE reservation_id = $1`, [reservationId]).catch(() => {});
  await pool.query(`DELETE FROM reservation_nightly_rates WHERE reservation_id = $1`, [reservationId]).catch(() => {});
  await pool.query(`DELETE FROM folio_entries WHERE reservation_id = $1`, [reservationId]).catch(() => {});
  await pool.query(`DELETE FROM payment_transactions WHERE reservation_id = $1`, [reservationId]).catch(() => {});
  await pool.query(`DELETE FROM identity_custody WHERE reservation_id = $1`, [reservationId]).catch(() => {});
  await pool.query(`DELETE FROM bookings WHERE id = (SELECT booking_id FROM reservations WHERE id = $1)`, [reservationId]).catch(() => {});
  await pool.query(`DELETE FROM reservations WHERE id = $1`, [reservationId]).catch(() => {});
  if (createdRoomIds.has(roomId)) {
    await pool.query(`UPDATE rooms SET status = 'VACANT' WHERE id = $1`, [roomId]).catch(() => {});
  }
}

async function main() {
  console.log(`\n=== OAK HIMS CHECKOUT-FOLIO-GATE-1B (${runId}) ===`);
  console.log(`DB: ${currentDb}\n`);

  try {
    const propRes = await testPool.query(`SELECT id FROM properties LIMIT 1`);
    if (propRes.rows.length === 0) throw new Error('No property found in DB');
    testPropertyId = Number(propRes.rows[0].id);
    console.log(`Using property: ${testPropertyId}`);

    const roomsResult = await testPool.query(`
      SELECT r.id, r.room_type_id, r.property_id, r.room_number
      FROM rooms r
      WHERE r.property_id = $1
        AND r.room_type_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM reservations res WHERE res.room_id = r.id AND res.stay_status IN ('IN_HOUSE', 'BOOKED'))
      ORDER BY r.id
      LIMIT 10
    `, [testPropertyId]);
    const testRooms = roomsResult.rows;
    if (testRooms.length < 10) throw new Error(`Need at least 10 free rooms, found ${testRooms.length}`);
    console.log(`Using ${testRooms.length} test rooms\n`);

    await initServer();

    const baseDate = '2030-09-01';
    const nextDate = '2030-09-02';
    const baseRate = 500000;

    // ── Scenario 1: Unpaid => FOLIO_BALANCE_OUTSTANDING ──
    {
      const room = testRooms[0];
      const { reservationId, roomId } = await createTestBooking(testPool, room.id, room.room_type_id, baseDate, nextDate, baseRate);
      const res = await request(testPool, 'POST', `/api/reservations/${reservationId}/checkout`, { property_id: testPropertyId });
      assert.strictEqual(res.status, 409, `S1: expected 409, got ${res.status}`);
      assert.strictEqual(res.body.code, 'FOLIO_BALANCE_OUTSTANDING', `S1: got ${res.body.code}`);
      assert(Number.isFinite(res.body.remaining_balance), 'S1: remaining_balance should be finite');
      pass(1, 'Unpaid reservation blocked with remaining_balance');
      await cleanupTestReservation(testPool, reservationId, roomId);
    }

    // ── Scenario 2: Partially paid => FOLIO_BALANCE_OUTSTANDING ──
    {
      const room = testRooms[1];
      const { reservationId, roomId } = await createTestBooking(testPool, room.id, room.room_type_id, baseDate, nextDate, baseRate);
      await testPool.query(
        `INSERT INTO folio_entries (reservation_id, property_id, entry_type, direction, amount, status, is_voided, created_at)
         VALUES ($1, $2, 'PAYMENT', 'CREDIT', 200000, 'POSTED', FALSE, NOW())`,
        [reservationId, testPropertyId]
      );
      const res = await request(testPool, 'POST', `/api/reservations/${reservationId}/checkout`, { property_id: testPropertyId });
      assert.strictEqual(res.status, 409, `S2: expected 409, got ${res.status}`);
      assert.strictEqual(res.body.code, 'FOLIO_BALANCE_OUTSTANDING', `S2: got ${res.body.code}`);
      pass(2, 'Partially paid reservation blocked');
      await cleanupTestReservation(testPool, reservationId, roomId);
    }

    // ── Scenario 3: Fully paid => CHECKOUT_SUCCESS ──
    {
      const room = testRooms[2];
      const { reservationId, roomId } = await createTestBooking(testPool, room.id, room.room_type_id, baseDate, nextDate, baseRate);
      await testPool.query(
        `INSERT INTO folio_entries (reservation_id, property_id, entry_type, direction, amount, status, is_voided, reversal_of_entry_id, created_at)
         VALUES ($1, $2, 'PAYMENT', 'CREDIT', $3, 'POSTED', FALSE, NULL, NOW())`,
        [reservationId, testPropertyId, baseRate]
      );
      const res = await request(testPool, 'POST', `/api/reservations/${reservationId}/checkout`, { property_id: testPropertyId });
      assert.strictEqual(res.status, 200, `S3: expected 200, got ${res.status} - ${JSON.stringify(res.body?.code || res.body?.error)}`);
      assert.strictEqual(res.body.data.status, 'CHECKED_OUT', `S3: got ${res.body.data?.status}`);
      pass(3, 'Fully paid reservation succeeds');
      await cleanupTestReservation(testPool, reservationId, roomId);
    }

    // ── Scenario 4: Applied deposit sufficient => CHECKOUT_SUCCESS ──
    {
      const room = testRooms[3];
      const { reservationId, roomId } = await createTestBooking(testPool, room.id, room.room_type_id, baseDate, nextDate, baseRate);
      await testPool.query(
        `INSERT INTO folio_entries (reservation_id, property_id, entry_type, direction, amount, status, is_voided, reversal_of_entry_id, created_at)
         VALUES ($1, $2, 'DEPOSIT_APPLY', 'CREDIT', $3, 'POSTED', FALSE, NULL, NOW())`,
        [reservationId, testPropertyId, baseRate]
      );
      const res = await request(testPool, 'POST', `/api/reservations/${reservationId}/checkout`, { property_id: testPropertyId });
      assert.strictEqual(res.status, 200, `S4: expected 200, got ${res.status} - ${JSON.stringify(res.body?.code || res.body?.error)}`);
      assert.strictEqual(res.body.data.status, 'CHECKED_OUT', `S4: got ${res.body.data?.status}`);
      pass(4, 'Applied deposit sufficient clears gate');
      await cleanupTestReservation(testPool, reservationId, roomId);
    }

    // ── Scenario 5: Held deposit (DEPOSIT type) does NOT settle => FOLIO_BALANCE_OUTSTANDING ──
    {
      const room = testRooms[4];
      const { reservationId, roomId } = await createTestBooking(testPool, room.id, room.room_type_id, baseDate, nextDate, baseRate);
      await testPool.query(
        `INSERT INTO folio_entries (reservation_id, property_id, entry_type, direction, amount, status, is_voided, reversal_of_entry_id, created_at)
         VALUES ($1, $2, 'DEPOSIT', 'CREDIT', $3, 'POSTED', FALSE, NULL, NOW())`,
        [reservationId, testPropertyId, baseRate]
      );
      const res = await request(testPool, 'POST', `/api/reservations/${reservationId}/checkout`, { property_id: testPropertyId });
      assert.strictEqual(res.status, 409, `S5: expected 409, got ${res.status} - ${JSON.stringify(res.body?.code || res.body?.error)}`);
      assert.strictEqual(res.body.code, 'FOLIO_BALANCE_OUTSTANDING', `S5: got ${res.body.code}`);
      pass(5, 'Held/unapplied deposit does NOT satisfy gate');
      await cleanupTestReservation(testPool, reservationId, roomId);
    }

    // ── Scenario 6: Multi-room child isolation ──
    {
      const roomA = testRooms[5];
      const roomB = testRooms[6];
      const propId = testPropertyId;
      const roomAType = roomA.room_type_id;
      const roomBType = roomB.room_type_id;

      const bid = `TEST-BK-${genId()}`;
      const bookRes = await testPool.query(
        `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status, created_at, updated_at)
         VALUES ($1, $2, 'TestGuest', 'ACTIVE', NOW(), NOW()) RETURNING id`,
        [propId, bid]
      );
      const bookingId = bookRes.rows[0].id;

      const resARes = await testPool.query(
        `INSERT INTO reservations (booking_id, room_id, status, stay_status, guest_name, stay_sequence, check_in, check_out, total_price, amount_paid, applied_deposit, remaining_balance, payment_status, booked_room_type_id_snapshot)
         VALUES ($1, $2, 'CHECKED_IN', 'IN_HOUSE', 'Test Guest 6A', 1, $3, $4, $5, 0, 0, 0, 'UNPAID', $6)
         RETURNING id`,
        [bookingId, roomA.id, '2030-09-01', '2030-09-02', baseRate, roomAType]
      );
      const r6a = resARes.rows[0].id;
      createdReservationIds.add(r6a);

      const resBRes = await testPool.query(
        `INSERT INTO reservations (booking_id, room_id, status, stay_status, guest_name, stay_sequence, check_in, check_out, total_price, amount_paid, applied_deposit, remaining_balance, payment_status, booked_room_type_id_snapshot)
         VALUES ($1, $2, 'CHECKED_IN', 'IN_HOUSE', 'Test Guest 6B', 2, $3, $4, $5, 0, 0, 0, 'UNPAID', $6)
         RETURNING id`,
        [bookingId, roomB.id, '2030-09-02', '2030-09-03', baseRate, roomBType]
      );
      const r6b = resBRes.rows[0].id;
      createdReservationIds.add(r6b);

      await testPool.query(
        `INSERT INTO reservation_nightly_rates (reservation_id, property_id, stay_date, room_type_id, base_rate, final_room_rate, service_amount, tax_amount, total_amount, created_at)
         VALUES ($1, $2, $3, $4, $5, $5, 0, 50000, $5, NOW())`,
        [r6a, propId, '2030-09-01', roomAType, baseRate]
      );
      await testPool.query(
        `INSERT INTO reservation_nightly_rates (reservation_id, property_id, stay_date, room_type_id, base_rate, final_room_rate, service_amount, tax_amount, total_amount, created_at)
         VALUES ($1, $2, $3, $4, $5, $5, 0, 50000, $5, NOW())`,
        [r6b, propId, '2030-09-02', roomBType, baseRate]
      );

      await testPool.query(
        `UPDATE availability_dates SET reserved_qty = reserved_qty + 1 WHERE room_type_id = $1 AND date::date = '2030-09-01'`,
        [roomAType]
      );
      await testPool.query(
        `UPDATE availability_dates SET reserved_qty = reserved_qty + 1 WHERE room_type_id = $1 AND date::date = '2030-09-02'`,
        [roomBType]
      );
      await testPool.query(
        `UPDATE availability_dates SET reserved_qty = reserved_qty + 1 WHERE room_type_id = $1 AND date::date = '2030-09-03'`,
        [roomBType]
      );

      await testPool.query(
        `INSERT INTO folio_entries (reservation_id, property_id, entry_type, direction, amount, status, is_voided, reversal_of_entry_id, created_at)
         VALUES ($1, $2, 'PAYMENT', 'CREDIT', $3, 'POSTED', FALSE, NULL, NOW())`,
        [r6b, propId, baseRate]
      );

      const resA = await request(testPool, 'POST', `/api/reservations/${r6a}/checkout`, { property_id: propId });
      assert.strictEqual(resA.status, 409, `S6A: expected 409, got ${resA.status}`);
      assert.strictEqual(resA.body.code, 'FOLIO_BALANCE_OUTSTANDING', 'S6A: unpaid child blocked');

      const resB = await request(testPool, 'POST', `/api/reservations/${r6b}/checkout`, { property_id: propId });
      assert.strictEqual(resB.status, 200, `S6B: expected 200, got ${resB.status}`);
      assert.strictEqual(resB.body.data.status, 'CHECKED_OUT', 'S6B: paid child succeeds');

      const verifyA = await testPool.query(`SELECT status FROM reservations WHERE id = $1`, [r6a]);
      assert.strictEqual(verifyA.rows[0].status, 'CHECKED_IN', 'S6: sibling A still CHECKED_IN');
      pass(6, 'Multi-room: sibling balance does NOT block other child');

      await testPool.query(`DELETE FROM housekeeping_tasks WHERE reservation_id = $1`, [r6a]).catch(() => {});
      await testPool.query(`DELETE FROM reservation_nightly_rates WHERE reservation_id = $1`, [r6a]).catch(() => {});
      await testPool.query(`DELETE FROM folio_entries WHERE reservation_id = $1`, [r6a]).catch(() => {});
      await testPool.query(`DELETE FROM payment_transactions WHERE reservation_id = $1`, [r6a]).catch(() => {});
      await testPool.query(`DELETE FROM identity_custody WHERE reservation_id = $1`, [r6a]).catch(() => {});
      await testPool.query(`DELETE FROM bookings WHERE id = $1`, [bookingId]).catch(() => {});
      await testPool.query(`DELETE FROM reservations WHERE id = $1`, [r6a]).catch(() => {});
      await testPool.query(`UPDATE rooms SET status = 'VACANT' WHERE id = $1`, [roomA.id]).catch(() => {});
    }

    // ── Scenario 7: Reversed payment restores balance ──
    {
      const room = testRooms[7];
      const { reservationId, roomId } = await createTestBooking(testPool, room.id, room.room_type_id, baseDate, nextDate, baseRate);
      await testPool.query(
        `INSERT INTO folio_entries (reservation_id, property_id, entry_type, direction, amount, status, is_voided, reversal_of_entry_id, created_at)
         VALUES ($1, $2, 'PAYMENT', 'CREDIT', $3, 'POSTED', FALSE, NULL, NOW())`,
        [reservationId, testPropertyId, baseRate]
      );
      await testPool.query(
        `INSERT INTO folio_entries (reservation_id, property_id, entry_type, direction, amount, status, is_voided, reversal_of_entry_id, created_at)
         VALUES ($1, $2, 'PAYMENT_REVERSAL', 'DEBIT', $3, 'POSTED', FALSE, NULL, NOW())`,
        [reservationId, testPropertyId, baseRate]
      );
      const res = await request(testPool, 'POST', `/api/reservations/${reservationId}/checkout`, { property_id: testPropertyId });
      assert.strictEqual(res.status, 409, `S7: expected 409 after reversal, got ${res.status}`);
      assert.strictEqual(res.body.code, 'FOLIO_BALANCE_OUTSTANDING', 'S7: reversed payment restores balance');
      pass(7, 'Reversed payment restores FOLIO_BALANCE_OUTSTANDING');
      await cleanupTestReservation(testPool, reservationId, roomId);
    }

    // ── Scenario 8: Non-existent reservation => rejected ──
    {
      const res = await request(testPool, 'POST', '/api/reservations/99999999/checkout', { property_id: testPropertyId });
      assert.strictEqual(res.status !== 200, true, 'S8: non-existent must not succeed');
      pass(8, 'Non-existent reservation rejected');
    }

    // ── Scenario 9: Identity custody blocks before folio gate ──
    {
      const room = testRooms[8];
      const { reservationId, roomId } = await createTestBooking(testPool, room.id, room.room_type_id, baseDate, nextDate, baseRate);
      await testPool.query(
        `INSERT INTO identity_custody (property_id, reservation_id, scope, status, document_type, document_holder_name, received_by, received_at, created_at, updated_at)
         VALUES ($1, $2, 'ROOM_RESERVATION', 'HELD', 'KTP', 'Test ID Holder', 'Staff', NOW(), NOW(), NOW())`,
        [testPropertyId, reservationId]
      );
      const res = await request(testPool, 'POST', `/api/reservations/${reservationId}/checkout`, { property_id: testPropertyId });
      assert.strictEqual(res.status, 409, `S9: expected 409, got ${res.status}`);
      assert.strictEqual(res.body.code, 'IDENTITY_CUSTODY_NOT_RETURNED', `S9: got ${res.body.code}`);
      pass(9, 'Identity custody gate fires before folio gate');
      await testPool.query(`DELETE FROM identity_custody WHERE reservation_id = $1`, [reservationId]);
      await cleanupTestReservation(testPool, reservationId, roomId);
    }

    // ── Scenario 10: GET /folio returns authoritative_financials ──
    {
      const room = testRooms[9];
      const { reservationId, roomId } = await createTestBooking(testPool, room.id, room.room_type_id, baseDate, nextDate, baseRate);
      const folioRes = await request(testPool, 'GET', `/api/reservations/${reservationId}/folio?property_id=${testPropertyId}`);
      assert.strictEqual(folioRes.status, 200, `S10: expected 200, got ${folioRes.status}`);
      assert(folioRes.body?.data?.authoritative_financials, 'S10: authoritative_financials present');
      const fin = folioRes.body.data.authoritative_financials;
      assert(Number.isFinite(fin.total_price), 'S10: total_price is finite');
      assert(Number.isFinite(fin.remaining_balance), 'S10: remaining_balance is finite');
      assert(fin.payment_status === 'UNPAID', `S10: payment_status=UNPAID, got ${fin.payment_status}`);
      pass(10, 'GET /folio returns authoritative_financials');
      await cleanupTestReservation(testPool, reservationId, roomId);
    }

    // ── Scenario 11: GET /folio does NOT mutate reservation financial columns ──
    {
      const room = testRooms[0];
      const { reservationId, roomId } = await createTestBooking(testPool, room.id, room.room_type_id, baseDate, nextDate, baseRate);
      const before = await testPool.query(
        `SELECT total_price, amount_paid, applied_deposit, remaining_balance, payment_status
         FROM reservations WHERE id = $1`,
        [reservationId]
      );
      const beforeState = before.rows[0];

      const folioRes = await request(testPool, 'GET', `/api/reservations/${reservationId}/folio?property_id=${testPropertyId}`);
      assert.strictEqual(folioRes.status, 200, 'S11: folio GET should succeed');

      const after = await testPool.query(
        `SELECT total_price, amount_paid, applied_deposit, remaining_balance, payment_status
         FROM reservations WHERE id = $1`,
        [reservationId]
      );
      const afterState = after.rows[0];
      assert.strictEqual(afterState.total_price, beforeState.total_price, 'S11: total_price unchanged');
      assert.strictEqual(afterState.amount_paid, beforeState.amount_paid, 'S11: amount_paid unchanged');
      assert.strictEqual(afterState.applied_deposit, beforeState.applied_deposit, 'S11: applied_deposit unchanged');
      assert.strictEqual(afterState.remaining_balance, beforeState.remaining_balance, 'S11: remaining_balance unchanged');
      assert.strictEqual(afterState.payment_status, beforeState.payment_status, 'S11: payment_status unchanged');
      pass(11, 'GET /folio is read-only, does not mutate reservation');
      await cleanupTestReservation(testPool, reservationId, roomId);
    }

    // Scenario 12: OTA_COLLECT room-only balance is not hotel collectible
    {
      const room = testRooms[0];
      const { reservationId, roomId } = await createTestBooking(
        testPool, room.id, room.room_type_id, baseDate, nextDate, baseRate, 'OTA_COLLECT'
      );
      await testPool.query(
        `INSERT INTO folio_entries
         (reservation_id, property_id, entry_type, source_type, direction, amount, status, is_voided, reversal_of_entry_id, created_at)
         VALUES ($1, $2, 'ROOM_CHARGE', 'ROOM_CHARGE', 'DEBIT', $3, 'POSTED', FALSE, NULL, NOW())`,
        [reservationId, testPropertyId, baseRate]
      );
      const folioRes = await request(testPool, 'GET', `/api/reservations/${reservationId}/folio?property_id=${testPropertyId}`);
      assert.strictEqual(folioRes.status, 200, `S12: expected folio 200, got ${folioRes.status}`);
      const fin = folioRes.body.data.authoritative_financials;
      assert.strictEqual(Number(fin.remaining_balance), baseRate, 'S12: canonical room balance remains visible');
      assert.strictEqual(Number(fin.hotel_collectible_remaining_balance), 0, 'S12: OTA room is not hotel collectible');
      assert.strictEqual(fin.payment_responsibility, 'OTA_COLLECT', 'S12: payment responsibility');
      const res = await request(testPool, 'POST', `/api/reservations/${reservationId}/checkout`, { property_id: testPropertyId });
      assert.strictEqual(res.status, 200, `S12: expected checkout 200, got ${res.status}`);
      pass(12, 'OTA_COLLECT room-only does not block checkout');
      await cleanupTestReservation(testPool, reservationId, roomId);
    }

    // Scenario 13: OTA_COLLECT unpaid manual extra remains hotel collectible
    {
      const extra = 150000;
      const room = testRooms[1];
      const { reservationId, roomId } = await createTestBooking(
        testPool, room.id, room.room_type_id, baseDate, nextDate, baseRate, 'OTA_COLLECT'
      );

      await testPool.query(
        `INSERT INTO folio_entries
         (reservation_id, property_id, entry_type, source_type, direction, amount, status, is_voided, reversal_of_entry_id, created_at)
         VALUES
         ($1, $2, 'ROOM_CHARGE', 'ROOM_CHARGE', 'DEBIT', $3, 'POSTED', FALSE, NULL, NOW()),
         ($1, $2, 'STAY_CHARGE', 'EXTRA_BED', 'DEBIT', $4, 'POSTED', FALSE, NULL, NOW())`,
        [reservationId, testPropertyId, baseRate, extra]
      );

      const folioRes = await request(
        testPool,
        'GET',
        `/api/reservations/${reservationId}/folio?property_id=${testPropertyId}`
      );
      const fin = folioRes.body.data.authoritative_financials;

      assert.strictEqual(
        Number(fin.hotel_collectible_remaining_balance),
        extra,
        'S13: manual extra remains hotel collectible'
      );

      const res = await request(
        testPool,
        'POST',
        `/api/reservations/${reservationId}/checkout`,
        { property_id: testPropertyId }
      );

      assert.strictEqual(res.status, 409, `S13: expected 409, got ${res.status}`);
      assert.strictEqual(
        res.body.code,
        'FOLIO_BALANCE_OUTSTANDING',
        'S13: unpaid manual extra blocks checkout'
      );

      pass(13, 'OTA_COLLECT unpaid manual extra blocks checkout');
      await cleanupTestReservation(testPool, reservationId, roomId);
    }

    // Scenario 14: OTA_COLLECT manual extra paid to hotel allows checkout
    {
      const extra = 150000;
      const room = testRooms[2];
      const { reservationId, roomId } = await createTestBooking(
        testPool, room.id, room.room_type_id, baseDate, nextDate, baseRate, 'OTA_COLLECT'
      );

      await testPool.query(
        `INSERT INTO folio_entries
         (reservation_id, property_id, entry_type, source_type, direction, amount, status, is_voided, reversal_of_entry_id, created_at)
         VALUES
         ($1, $2, 'ROOM_CHARGE', 'ROOM_CHARGE', 'DEBIT', $3, 'POSTED', FALSE, NULL, NOW()),
         ($1, $2, 'STAY_CHARGE', 'EXTRA_BED', 'DEBIT', $4, 'POSTED', FALSE, NULL, NOW()),
         ($1, $2, 'PAYMENT', NULL, 'CREDIT', $4, 'POSTED', FALSE, NULL, NOW())`,
        [reservationId, testPropertyId, baseRate, extra]
      );

      const folioRes = await request(
        testPool,
        'GET',
        `/api/reservations/${reservationId}/folio?property_id=${testPropertyId}`
      );
      const fin = folioRes.body.data.authoritative_financials;

      assert.strictEqual(
        Number(fin.hotel_collectible_total),
        extra,
        'S14: collectible total is manual extra'
      );
      assert.strictEqual(
        Number(fin.hotel_collectible_remaining_balance),
        0,
        'S14: hotel payment clears collectible balance'
      );

      const res = await request(
        testPool,
        'POST',
        `/api/reservations/${reservationId}/checkout`,
        { property_id: testPropertyId }
      );

      assert.strictEqual(res.status, 200, `S14: expected 200, got ${res.status}`);

      pass(14, 'OTA_COLLECT paid manual extra allows checkout');
      await cleanupTestReservation(testPool, reservationId, roomId);
    }

    // Scenario 15: OTA_COLLECT reversed manual extra leaves no collectible balance
    {
      const extra = 150000;
      const room = testRooms[3];
      const { reservationId, roomId } = await createTestBooking(
        testPool, room.id, room.room_type_id, baseDate, nextDate, baseRate, 'OTA_COLLECT'
      );

      await testPool.query(
        `INSERT INTO folio_entries
         (reservation_id, property_id, entry_type, source_type, direction, amount, status, is_voided, reversal_of_entry_id, created_at)
         VALUES ($1, $2, 'ROOM_CHARGE', 'ROOM_CHARGE', 'DEBIT', $3, 'POSTED', FALSE, NULL, NOW())`,
        [reservationId, testPropertyId, baseRate]
      );

      const charge = await testPool.query(
        `INSERT INTO folio_entries
         (reservation_id, property_id, entry_type, source_type, direction, amount, status, is_voided, reversal_of_entry_id, created_at)
         VALUES ($1, $2, 'STAY_CHARGE', 'EXTRA_BED', 'DEBIT', $3, 'POSTED', FALSE, NULL, NOW())
         RETURNING id`,
        [reservationId, testPropertyId, extra]
      );

      await testPool.query(
        `UPDATE folio_entries
         SET is_voided = TRUE, status = 'VOIDED'
         WHERE id = $1`,
        [charge.rows[0].id]
      );

      await testPool.query(
        `INSERT INTO folio_entries
         (reservation_id, property_id, entry_type, source_type, direction, amount, status, is_voided, reversal_of_entry_id, created_at)
         VALUES ($1, $2, 'REVERSAL', 'EXTRA_BED', 'CREDIT', $3, 'POSTED', FALSE, $4, NOW())`,
        [reservationId, testPropertyId, extra, charge.rows[0].id]
      );

      const folioRes = await request(
        testPool,
        'GET',
        `/api/reservations/${reservationId}/folio?property_id=${testPropertyId}`
      );
      const fin = folioRes.body.data.authoritative_financials;

      assert.strictEqual(
        Number(fin.hotel_collectible_remaining_balance),
        0,
        'S15: reversed manual extra is not collectible'
      );

      const res = await request(
        testPool,
        'POST',
        `/api/reservations/${reservationId}/checkout`,
        { property_id: testPropertyId }
      );

      assert.strictEqual(res.status, 200, `S15: expected 200, got ${res.status}`);

      pass(15, 'OTA_COLLECT reversed manual extra allows checkout');
      await cleanupTestReservation(testPool, reservationId, roomId);
    }

    // Scenario 16: OTA_COLLECT stay extension remains hotel collectible
    {
      const extension = 150000;
      const room = testRooms[4];
      const { reservationId, roomId } = await createTestBooking(
        testPool, room.id, room.room_type_id, baseDate, nextDate, baseRate, 'OTA_COLLECT'
      );

      await testPool.query(
        `INSERT INTO folio_entries
         (reservation_id, property_id, entry_type, source_type, direction, amount, status, is_voided, reversal_of_entry_id, created_at)
         VALUES
         ($1, $2, 'ROOM_CHARGE', 'ROOM_CHARGE', 'DEBIT', $3, 'POSTED', FALSE, NULL, NOW()),
         ($1, $2, 'ROOM_CHARGE', 'STAY_EXTENSION', 'DEBIT', $4, 'POSTED', FALSE, NULL, NOW())`,
        [reservationId, testPropertyId, baseRate, extension]
      );

      const folioRes = await request(
        testPool,
        'GET',
        `/api/reservations/${reservationId}/folio?property_id=${testPropertyId}`
      );
      const fin = folioRes.body.data.authoritative_financials;

      assert.strictEqual(
        Number(fin.hotel_collectible_remaining_balance),
        extension,
        'S16: stay extension remains hotel collectible'
      );

      const res = await request(
        testPool,
        'POST',
        `/api/reservations/${reservationId}/checkout`,
        { property_id: testPropertyId }
      );

      assert.strictEqual(res.status, 409, `S16: expected 409, got ${res.status}`);
      assert.strictEqual(
        res.body.code,
        'FOLIO_BALANCE_OUTSTANDING',
        'S16: unpaid extension blocks checkout'
      );

      pass(16, 'OTA_COLLECT stay extension remains hotel collectible');
      await cleanupTestReservation(testPool, reservationId, roomId);
    }

  } catch (err) {
    fail(-1, 'Unexpected error', err);
  } finally {
    await teardown();
  }

  console.log(`\n=== OAK HIMS CHECKOUT-FOLIO-GATE-1B TEST COMPLETE (${runId}) ===\n`);
}

main().catch(err => { console.error('Test suite failed:', err); process.exit(1); });

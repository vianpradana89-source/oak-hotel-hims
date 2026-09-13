#!/usr/bin/env node
/**
 * guarantee_queue_router_test.js — Router auth/NaN regression tests.
 *
 * Validates:
 * A. valid Front Office same-property request → 200
 * B. valid General Manager same-property request → 200
 * C. valid Super Admin request → 200 (via isPlatformSuperAdmin)
 * D. cross-property regular user rejected → 403
 * E. missing/invalid user identifier does NOT reach SQL as NaN → 401
 * F. missing/invalid property claim fails safely → 400/401
 *
 * Run: node test/guarantee_queue_router_test.js
 */
const { Pool } = require('pg');
const http = require('http');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db',
});

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { passed += 1; console.log('PASS | ' + label); }
  else { failed += 1; console.log('FAIL | ' + label); }
}
function log(msg) { console.log('>> ' + msg); }

const FIXTURE_BASE = 'GQ' + (Date.now().toString(36).toUpperCase().slice(-2));

// ── DB helpers ───────────────────────────────────────────────────────────────

async function seedProperty(client, code, name, address) {
  const row = await client.query(
    'INSERT INTO properties (name, property_code, address, is_active) VALUES ($1,$2,$3,true) RETURNING id',
    [name, code, address]
  );
  return Number(row.rows[0].id);
}
async function seedCategory(client, propertyId, code) {
  const row = await client.query(
    'INSERT INTO room_categories (name, code, property_id) VALUES ($1,$2,$3) RETURNING id',
    ['Cat-' + code, code, propertyId]
  );
  return Number(row.rows[0].id);
}
async function seedRoomType(client, catId, propertyId, code) {
  const row = await client.query(
    'INSERT INTO room_types (property_id, name, code, base_rate, room_category_id) VALUES ($1,$2,$3,100000,$4) RETURNING id',
    [propertyId, 'T-' + code, code, catId]
  );
  return Number(row.rows[0].id);
}
async function seedRoom(client, propertyId, typeId, number) {
  const row = await client.query(
    'INSERT INTO rooms (room_number, property_id, room_type_id, is_active) VALUES ($1,$2,$3,true) RETURNING id',
    [number, propertyId, typeId]
  );
  return Number(row.rows[0].id);
}
async function seedBooking(client, propertyId, bid, guestName) {
  const row = await client.query(
    'INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_source, channel) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [bid, propertyId, guestName, 'WALKIN', 'FRONT_DESK']
  );
  return Number(row.rows[0].id);
}
async function seedReservation(client, bookingId, roomId, seq, checkIn, checkOut, status, guestName) {
  const row = await client.query(
    'INSERT INTO reservations (booking_id, room_id, stay_sequence, check_in, check_out, status, guest_name) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [bookingId, roomId, seq, checkIn, checkOut, status, guestName]
  );
  return Number(row.rows[0].id);
}
async function seedDepositAndEvent(client, propertyId, reservationId, bookingId, amount, scope) {
  const ptRow = await client.query(
    'INSERT INTO payment_transactions (reservation_id, transaction_type, amount, payment_method, status) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [reservationId, 'DEPOSIT', amount, 'CASH', 'SUCCESS']
  );
  const ptId = Number(ptRow.rows[0].id);
  const depotRow = await client.query(
    'INSERT INTO deposits (property_id, reservation_id, booking_id, deposit_number, original_amount, payment_method, status, received_by, scope) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
    [propertyId, reservationId, bookingId, 'DEP-' + Date.now(), amount, 'CASH', 'RECEIVED', 'Front', scope]
  );
  const depotId = Number(depotRow.rows[0].id);
  await client.query(
    'INSERT INTO deposit_events (deposit_id, property_id, reservation_id, event_type, amount, idempotency_key, performed_by, payment_transaction_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [depotId, propertyId, reservationId, 'RECEIVED', amount, 'idem-' + Date.now() + '-' + depotId, 'Front', ptId]
  );
  return { ptId, depotId };
}
async function seedCustody(client, propertyId, reservationId, bookingId, scope, status) {
  const row = await client.query(
    'INSERT INTO identity_custody (property_id, reservation_id, booking_id, document_type, document_holder_name, status, received_by, scope) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
    [propertyId, reservationId, bookingId, 'KTP', 'Guest', status, 'Front', scope]
  );
  return Number(row.rows[0].id);
}

// Users don't have a "role" column; role is via role_id FK.
// Return user IDs for later cleanup.
async function createTestUsers(client, propAId) {
  const passwords = ['TestPassword123!', 'TestPassword123!', 'TestPassword123!'];
  const roles = ['Front Office', 'General Manager', 'Super Admin'];
  const userIds = [];

  for (const role of roles) {
    const email = `${role}_${propAId}@gq.test`;
    const check = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (check.rows.length > 0) {
      // User exists from a prior run; reset password to known value
      const pwHash = bcrypt.hashSync(passwords[userIds.length], bcrypt.genSaltSync(10));
      await client.query('UPDATE users SET password_hash = $1 WHERE email = $2', [pwHash, email]);
      userIds.push(Number(check.rows[0].id));
      continue;
    }
    const roleCheck = await client.query('SELECT id FROM roles WHERE name = $1 AND is_active = true ORDER BY id LIMIT 1', [role]);
    if (roleCheck.rows.length === 0) throw new Error(`Role not found: ${role}`);
    const pwHash = bcrypt.hashSync(passwords[userIds.length], bcrypt.genSaltSync(10));
    const result = await client.query(
      `INSERT INTO users (email, username, password_hash, full_name, role_id, property_id, access_type, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, 'PMS_STAFF', true) RETURNING id`,
      [email, email, pwHash, `Test ${role}`, Number(roleCheck.rows[0].id), propAId]
    );
    userIds.push(Number(result.rows[0].id));
  }
  return userIds;
}

async function cleanup(client, propIds, userIds) {
  // Delete users first (they reference properties)
  for (const uid of userIds) {
    await client.query('DELETE FROM users WHERE id = $1', [uid]);
  }
  // Then cascade-delete property fixtures
  for (const propId of propIds) {
    log('cleaning prop ' + propId);
    await client.query('DELETE FROM identity_custody WHERE property_id = $1', [propId]);
    await client.query('DELETE FROM deposit_events WHERE property_id = $1', [propId]);
    await client.query('DELETE FROM deposits WHERE property_id = $1', [propId]);
    await client.query(
      'DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1))',
      [propId]
    );
    await client.query('DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1)', [propId]);
    await client.query('DELETE FROM bookings WHERE property_id = $1', [propId]);
    await client.query('DELETE FROM rooms WHERE property_id = $1', [propId]);
    await client.query('DELETE FROM room_types WHERE property_id = $1', [propId]);
    await client.query('DELETE FROM room_categories WHERE property_id = $1', [propId]);
    await client.query('DELETE FROM properties WHERE id = $1', [propId]);
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function apiRequest(method, path, body, authToken) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (authToken) opts.headers['Authorization'] = `Bearer ${authToken}`;
  if (body) opts.body = JSON.stringify(body);
  const port = process.env.TEST_PORT || '3002';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, opts);
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

async function login(email, password) {
  const port = process.env.TEST_PORT || '3002';
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return json?.data?.token || json?.token || null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const client = await pool.connect();
  log('connected | fixture marker=' + FIXTURE_BASE);

  const createdPropIds = [];
  const createdUserIds = [];

  try {
    const appModule = require('../dist/index');
    const app = appModule.default || appModule.app || appModule;
    if (!app) { log('ERROR: Could not load app'); process.exit(1); }

    const server = http.createServer(app);
    const PORT = parseInt(process.env.TEST_PORT || '3002');
    await new Promise(r => server.listen(PORT, r));
    log('server started on port ' + PORT);
    await new Promise(r => setTimeout(r, 300));

    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const inOneDay = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000).toISOString();
    const inTwoDays = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const TEST_PWD = 'TestPassword123!';

    // ── Property A ──
    const propAId = Number(await seedProperty(client, FIXTURE_BASE + 'A', 'PropA', 'Addr-A'));
    createdPropIds.push(propAId);
    log('propA=' + propAId);
    const catAId = Number(await seedCategory(client, propAId, 'CA-A'));
    const typeAId = Number(await seedRoomType(client, catAId, propAId, 'DA'));
    const roomA1 = Number(await seedRoom(client, propAId, typeAId, '101'));
    const bookingAId = Number(await seedBooking(client, propAId, FIXTURE_BASE + 'A', 'Guest A'));
    const resA1 = Number(await seedReservation(client, bookingAId, roomA1, 1, threeDaysAgo, twoDaysAgo, 'CHECKED_OUT', 'Guest A1'));
    const { depotId: depotA1 } = await seedDepositAndEvent(client, propAId, resA1, bookingAId, 500000, 'ROOM_RESERVATION');
    await seedCustody(client, propAId, resA1, bookingAId, 'ROOM_RESERVATION', 'HELD');

    // ── Property B ──
    const propBId = Number(await seedProperty(client, FIXTURE_BASE + 'B', 'PropB', 'Addr-B'));
    createdPropIds.push(propBId);
    log('propB=' + propBId);
    const catBId = Number(await seedCategory(client, propBId, 'CA-B'));
    const typeBId = Number(await seedRoomType(client, catBId, propBId, 'DB'));
    const roomB1 = Number(await seedRoom(client, propBId, typeBId, '201'));
    const bookingBId = Number(await seedBooking(client, propBId, FIXTURE_BASE + 'B', 'Guest B'));
    const resB1 = Number(await seedReservation(client, bookingBId, roomB1, 1, inOneDay, inTwoDays, 'CHECKED_IN', 'Guest B1'));
    const { depotId: depotB1 } = await seedDepositAndEvent(client, propBId, resB1, bookingBId, 200000, 'ROOM_RESERVATION');

    // ── Test users ──
    createdUserIds.push(...await createTestUsers(client, propAId));
    log('users created: ' + createdUserIds.join(','));

    const emailFO = `Front Office_${propAId}@gq.test`;
    const emailGM = `General Manager_${propAId}@gq.test`;
    const emailSA = `Super Admin_${propAId}@gq.test`;
    const authTokenFO = await login(emailFO, TEST_PWD);
    const authTokenGM = await login(emailGM, TEST_PWD);
    const authTokenSA = await login(emailSA, TEST_PWD);
    log('tokens: FO=' + (authTokenFO ? 'yes' : 'NO') + ' GM=' + (authTokenGM ? 'yes' : 'NO') + ' SA=' + (authTokenSA ? 'yes' : 'NO'));

    // ── A: valid FO same-property ──
    const rA = await apiRequest('GET', `/api/reservations/unresolved-guarantees?property_id=${propAId}`, null, authTokenFO);
    assert(rA.status === 200, 'A: FO same-property 200 — got ' + rA.status);
    assert(rA.json?.status === 'SUCCESS', 'A1: Response is SUCCESS');
    assert(Array.isArray(rA.json?.data?.items), 'A2: items is array');

    // ── B: valid GM same-property ──
    const rB = await apiRequest('GET', `/api/reservations/unresolved-guarantees?property_id=${propAId}`, null, authTokenGM);
    assert(rB.status === 200, 'B: GM same-property 200 — got ' + rB.status);
    assert(rB.json?.status === 'SUCCESS', 'B1: Response is SUCCESS');

    // ── C: Super Admin bypass ──
    const rC = await apiRequest('GET', `/api/reservations/unresolved-guarantees?property_id=${propAId}`, null, authTokenSA);
    assert(rC.status === 200, 'C: SA same-property 200 — got ' + rC.status);
    assert(rC.json?.status === 'SUCCESS', 'C1: SA response is SUCCESS');

    // ── D: cross-property FO → 403 ──
    const rD = await apiRequest('GET', `/api/reservations/unresolved-guarantees?property_id=${propBId}`, null, authTokenFO);
    assert(rD.status === 403, 'D: Cross-property FO → 403 — got ' + rD.status);
    assert(rD.json?.code === 'CROSS_PROPERTY_ACCESS', 'D1: code is CROSS_PROPERTY_ACCESS');

    // ── E: missing/invalid user → 401 (not NaN SQL error) ──
    const rE = await apiRequest('GET', `/api/reservations/unresolved-guarantees?property_id=${propAId}`, null, null);
    assert(rE.status === 401, 'E1: No auth → 401 — got ' + rE.status);
    assert(rE.json?.code !== 'INVALID_INPUT', 'E1a: No SQL NaN error');

    const rE2 = await apiRequest('GET', `/api/reservations/unresolved-guarantees?property_id=${propAId}`, null, 'invalid-token');
    assert(rE2.status === 401, 'E2: Invalid token → 401 — got ' + rE2.status);

    // ── F: missing/invalid property claim → 400 ──
    const rF = await apiRequest('GET', '/api/reservations/unresolved-guarantees', null, authTokenFO);
    assert(rF.status === 400, 'F1: Missing property_id → 400 — got ' + rF.status);
    assert(rF.json?.code === 'VALIDATION_ERROR', 'F1a: code is VALIDATION_ERROR');

    const rF2 = await apiRequest('GET', '/api/reservations/unresolved-guarantees?property_id=abc', null, authTokenFO);
    assert(rF2.status === 400, 'F2: Non-numeric property_id → 400 — got ' + rF2.status);
    assert(rF2.json?.code === 'VALIDATION_ERROR', 'F2a: code is VALIDATION_ERROR');

    const rF3 = await apiRequest('GET', '/api/reservations/unresolved-guarantees?property_id=-1', null, authTokenFO);
    assert(rF3.status === 400, 'F3: Negative property_id → 400 — got ' + rF3.status);

    const rF4 = await apiRequest('GET', '/api/reservations/unresolved-guarantees?property_id=0', null, authTokenFO);
    assert(rF4.status === 400, 'F4: Zero property_id → 400 — got ' + rF4.status);

    console.log('\n=== RESULTS:', passed, 'passed,', failed, 'failed ===\n');

  } catch (err) {
    console.error('FATAL:', err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(0, 5).join('\n'));
  } finally {
    try {
      await cleanup(client, createdPropIds, createdUserIds);
      log('cleanup complete | props=' + createdPropIds.join(',') + ' users=' + createdUserIds.join(','));
    } catch (e) {
      console.error('CLEANUP WARN:', e.message);
    }
    client.release();
    await pool.end();
    process.exit(failed > 0 ? 1 : 0);
  }
}

main();

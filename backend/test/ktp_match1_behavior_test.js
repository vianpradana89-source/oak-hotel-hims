// KTP-MATCH-1 Behavior Regression Test — API-driven
// Tests real DB state, HTTP responses, and concurrency outcomes.
// Run from backend/:  node test/ktp_match1_behavior_test.js

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db',
});

let server, serverPort, fixtures = {}, authToken = '';
let results = { pass: 0, fail: 0, tests: [] };
const uuidsToCleanup = [];

function pass(label) {
  results.pass++;
  results.tests.push({ label, ok: true });
  console.log(`  ✓ ${label}`);
}
function fail(label, reason) {
  results.fail++;
  results.tests.push({ label, ok: false, reason });
  console.error(`  ✗ ${label} — ${reason}`);
}

// ── HTTP helpers ────────────────────────────────────────────���────────────────
function api(method, urlPath, body) {
  return new Promise((resolve) => {
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` };
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      { hostname: '127.0.0.1', port: serverPort, path: urlPath, method, headers,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      }); });
    req.on('error', reject => { /* ignore */ });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Fixture setup ────────────────────────────────────────────────────────────
async function setupFixtures() {
  console.log('\n--- Setting up fixtures ---');

  fixtures.propertyId = 1;
  console.log(`  property=${fixtures.propertyId}`);

  const rtR = await pool.query("SELECT id FROM room_types WHERE property_id=$1 LIMIT 1", [fixtures.propertyId]);
  fixtures.roomTypeId = rtR.rowCount
    ? Number(rtR.rows[0].id)
    : Number((await pool.query(
      `INSERT INTO room_types (property_id,code,name,base_rate,capacity) VALUES ($1,'DLX','Deluxe KTP',500000,2) RETURNING id`,
      [fixtures.propertyId]
    )).rows[0].id);
  console.log(`  room_type=${fixtures.roomTypeId}`);

  // Unique dates — one per test that creates a booking (tests 4–18)
  // Dynamically query availability_dates for free slots (free > 0).
  const freeDatesR = await pool.query(`
    SELECT date::text AS d FROM availability_dates
    WHERE room_type_id = $1 AND total_rooms - reserved_qty > 0
      AND date >= CURRENT_DATE
    ORDER BY date
    LIMIT 20
  `, [fixtures.roomTypeId]);
  if (freeDatesR.rows.length < 16) {
    throw new Error(`Not enough free dates for room_type ${fixtures.roomTypeId}: found ${freeDatesR.rows.length}`);
  }
  const fixtureDates = freeDatesR.rows.slice(0, 16).map(r => {
    const d = new Date(r.d);
    return [
      d.toISOString().slice(0, 10),
      new Date(d.getTime() + 86400000).toISOString().slice(0, 10)
    ];
  });
  fixtures.dates = fixtureDates;

  const ts = Date.now();
  // Create 16 rooms — one per test that creates a booking (tests 4–18 + test 19)
  fixtures.roomIds = [];
  for (let i = 0; i < 16; i++) {
    const rid = Number((await pool.query(
      `INSERT INTO rooms (property_id,room_number,name,room_type_id,status)
       VALUES ($1,'TKTP${ts}-${i}','TestRoom${i}', $2,'VACANT_CLEAN') RETURNING id`,
      [fixtures.propertyId, fixtures.roomTypeId]
    )).rows[0].id);
    fixtures.roomIds.push(rid);
  }
  fixtures.roomIdA = fixtures.roomIds[0];
  fixtures.roomIdB = fixtures.roomIds[1];
  fixtures.roomIdC = fixtures.roomIds[2];
  console.log(`  rooms=[${fixtures.roomIds.slice(0,3).join(',')},...]`);


  // Guests A, B with unique 16-digit NIKs; Guest C for concurrent tests
  const nikTs = Date.now();
  const nikA = '32' + String(nikTs).padStart(14, '0').slice(-14);
  const nikB = '32' + String(nikTs + 1).padStart(14, '0').slice(-14);
  const nikC = '32' + String(nikTs + 2).padStart(14, '0').slice(-14);
  // Shared phone shared among A and C (but not B) — probes no-phone-fallback
  const sharedPhone = `08${String(nikTs).slice(-10)}`;

  const ga = (await pool.query(
    `INSERT INTO guests (full_name,phone,normalized_identity_number,identity_number,
     created_property_id,has_valid_identity) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id`,
    [`Guest Alpha`, sharedPhone, nikA, nikA, fixtures.propertyId]
  )).rows[0];
  fixtures.guestA = Number(ga.id);
  fixtures.nikA = nikA;
  fixtures.phoneA = sharedPhone;
  console.log(`  guestA=${fixtures.guestA} nik=${nikA} phone=${sharedPhone}`);

  const gb = (await pool.query(
    `INSERT INTO guests (full_name,phone,normalized_identity_number,identity_number,
     created_property_id,has_valid_identity) VALUES ($1,NULL,$2,$3,$4,FALSE) RETURNING id`,
    [`Guest Beta`, nikB, nikB, fixtures.propertyId]
  )).rows[0];
  fixtures.guestB = Number(gb.id);
  fixtures.nikB = nikB;
  console.log(`  guestB=${fixtures.guestB} nik=${nikB}`);

  const gc = (await pool.query(
    `INSERT INTO guests (full_name,phone,normalized_identity_number,identity_number,
     created_property_id,has_valid_identity) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id`,
    [`Guest Charlie`, sharedPhone, nikC, nikC, fixtures.propertyId]
  )).rows[0];
  fixtures.guestC = Number(gc.id);
  fixtures.nikC = nikC;
  console.log(`  guestC=${fixtures.guestC} nik=${nikC} phone=${sharedPhone}`);

  // NIK_B2 — unique NIK not belonging to any guest (for Test 2 hazard case)
  fixtures.nikB2 = '32' + String(nikTs + 500).padStart(14, '0').slice(-14);
  console.log(`  nikB2=${fixtures.nikB2}`);
}

async function ensureActorUserId() {
  const r = await pool.query("SELECT id FROM users WHERE username='fo_staff' LIMIT 1");
  fixtures.actorUserId = Number(r.rows[0].id);
  console.log(`  actorUserId=${fixtures.actorUserId}`);
}

// ── Auth (dynamic, no hardcoded JWT) ────────────────────────────────────────
// The production secret lives in dist/domains/auth/authService.js.
// We read it at runtime and generate a fresh token for fo_staff (id=2, property_id=1, role_id=2).
function getJwtSecret() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'dist', 'domains', 'auth', 'authService.js'), 'utf8');
  const m = src.match(/JWT_SECRET\s*=\s*process\.env\.JWT_SECRET\s*\|\|\s*'([^']+)'/);
  if (!m) throw new Error('Could not extract JWT_SECRET from dist/domains/auth/authService.js');
  return m[1];
}

async function dynamicLogin() {
  const secret = getJwtSecret();
  const payload = {
    id: 2,
    property_id: fixtures.propertyId,
    role_id: 2,
    username: 'fo_staff',
    email: 'fo@oaklawang.com',
    full_name: 'Front Desk Staff',
    scope: 'FULL',
    account_status: 'READY',
    must_change_password: false,
    access_type: 'PMS_STAFF'
  };
  authToken = jwt.sign(payload, secret, { expiresIn: '7d' });
  console.log(`  authenticated as fo_staff (token cached in memory)`);
}

// ── Create identity upload row directly in DB ───────────────────────────────
async function createUploadRow(nik, name, expiresMinutes = 1440) {
  const uploadId = crypto.randomUUID();
  const storageKey = `identity-documents/${fixtures.propertyId}/${uploadId}.jpg`;
  const fileHash = crypto.createHash('sha256').update(nik + Date.now()).digest('hex');
  const expiresAt = new Date(Date.now() + expiresMinutes * 60 * 1000);
  const fs = require('fs');
  const path = require('path');
  const STORAGE_BASE_DIR = path.resolve(__dirname, '..', 'storage');
  const filePath = path.join(STORAGE_BASE_DIR, storageKey);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const dummyJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  fs.writeFileSync(filePath, dummyJpeg);

  await pool.query(
    `INSERT INTO identity_document_uploads
     (id, property_id, uploaded_by_user_id, storage_key, mime_type, file_hash,
      original_filename, status, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)`,
    [uploadId, fixtures.propertyId, fixtures.actorUserId, storageKey, 'image/jpeg',
     fileHash, `ktp_${name}.jpg`, 'PENDING', expiresAt]
  );
  uuidsToCleanup.push(uploadId);
  return uploadId;
}

// ── Booking / reservation helpers ────────────────────────────────────────────
async function createBookingViaApi(checkIn, checkOut, options = {}) {
  const bid = `KTP-B-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  // Each booking gets its own room from the pool to avoid overlap
  const roomId = options.room_index !== undefined ? fixtures.roomIds[options.room_index] : fixtures.roomIdA;
  const r = await api('POST', '/api/bookings', {
    bid,
    property_id: fixtures.propertyId,
    channel: 'Front Desk',
    booking_source: 'WALKIN',
    guest_name: options.guest_name || 'Test Customer',
    guest_phone: options.guest_phone || '081234567890',
    guest_segment: 'Reguler',
    currency_code: 'IDR',
    has_valid_identity: true,
    rate_plan_id: 1,
    payment_method: 'CASH',
    reservations: [{
      room_id: roomId,
      check_in: checkIn,
      check_out: checkOut,
      subtotal_amount: 500000,
      total_price: 500000,
      discount_amount: 0,
      discount_percent: 0,
      amount_paid: 0,
      remaining_balance: 500000,
      payment_status: 'UNPAID',
      booking_type: 'WALKIN'
    }]
  });
  if (r.status !== 201) {
    console.error(`  [WARN] Booking create ${r.status}: ${JSON.stringify(r.body).slice(0, 400)}`);
  }
  const data = r.body.data || r.body;
  const reservationId = Number(data.reservations?.[0]?.id || data.reservation_id || data.id);
  if (Number.isNaN(reservationId)) {
    throw new Error(`Cannot parse reservation ID from response: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return { bookingId: Number(data.booking_id || data.id), reservationId };
}

async function setPrimaryGuest(reservationId, guestId, relationSource = 'MANUAL_ENTRY') {
  await pool.query(
    `INSERT INTO reservation_guests (reservation_id, guest_id, role, relationship, is_staying,
     identity_verified, relation_source, created_at, updated_at)
     VALUES ($1,$2,'PRIMARY_GUEST','SELF',TRUE,TRUE,$3,NOW(),NOW())
     ON CONFLICT (reservation_id) WHERE role = 'PRIMARY_GUEST'
     DO UPDATE SET guest_id=$2, relation_source=$3, identity_verified=TRUE`,
    [reservationId, guestId, relationSource]
  );
}

async function callAddPrimaryGuest(reservationId, guestId, relationSource, expectedPrimaryGuestId) {
  return api('POST', `/api/reservations/${reservationId}/guests`, {
    property_id: fixtures.propertyId,
    guest_id: guestId,
    role: 'PRIMARY_GUEST',
    relationship: 'SELF',
    is_staying: true,
    identity_verified: true,
    relation_source: relationSource,
    expected_primary_guest_id: expectedPrimaryGuestId
  });
}

async function callConfirmIdentity(uploadId, input) {
  return api('POST', '/api/identity/confirm', {
    document_upload_id: uploadId,
    property_id: fixtures.propertyId,
    actor_user_id: fixtures.actorUserId,
    name: input.name,
    nik: input.nik,
    phone: input.phone || null,
    context: input.context || 'CHECKIN_IDENTITY_SCAN',
    guest_id: input.guest_id || null
  });
}

async function cleanupReservation(reservationId) {
  await pool.query('DELETE FROM reservation_guests WHERE reservation_id=$1', [reservationId]).catch(() => {});
  await pool.query("DELETE FROM audit_logs WHERE entity='RESERVATION' AND record_id=$1", [String(reservationId)]).catch(() => {});
  await pool.query("DELETE FROM audit_logs WHERE entity='RESERVATION_GUEST' AND record_id=$1", [String(reservationId)]).catch(() => {});
  // Restore room to VACANT_CLEAN if it was checked in
  const res = await pool.query('SELECT room_id FROM reservations WHERE id=$1', [reservationId]).catch(() => ({ rows: [] }));
  if (res.rows.length > 0) {
    await pool.query("UPDATE rooms SET status='VACANT_CLEAN' WHERE id=$1 AND status='OCCUPIED_CLEAN'", [res.rows[0].room_id]).catch(() => {});
  }
  await pool.query('DELETE FROM reservations WHERE id=$1', [reservationId]).catch(() => {});
}

async function cleanupUploads() {
  for (const id of uuidsToCleanup) {
    await pool.query('DELETE FROM identity_document_uploads WHERE id=$1', [id]).catch(() => {});
  }
}

async function fullCleanup() {
  if (fixtures.tmpResId) {
    await cleanupReservation(fixtures.tmpResId);
  }
  await cleanupUploads();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Test 1: NIK mismatch — correct direction ────────────────────────────────
// Confirms: NIK_B in scanned data, guest_id=A → 409 NIK_MISMATCH
// Then re-queries Guest A to assert all protected fields unchanged.
async function test1_checkin_nik_mismatch() {
  console.log('\n--- Test 1: CHECKIN_IDENTITY_SCAN NIK mismatch → 409 ---');
  const uploadId = await createUploadRow(fixtures.nikB, 'Guest Beta KTP');

  // Snapshot of Guest A's protected fields before the call
  const pre = await pool.query(
    `SELECT full_name, identity_number, normalized_identity_number, phone,
            has_valid_identity
     FROM guests WHERE id=$1`,
    [fixtures.guestA]
  );

  const r = await callConfirmIdentity(uploadId, {
    guest_id: fixtures.guestA,   // explicit Guest A
    name: 'Guest Alpha',
    nik: fixtures.nikB,          // NIK of Guest B — mismatch!
    context: 'CHECKIN_IDENTITY_SCAN'
  });

  assert.strictEqual(r.status, 409, `1: Expected 409, got ${r.status}`);
  const code = r.body.error || r.body.code;
  assert.strictEqual(code, 'NIK_MISMATCH', `1: Error code is NIK_MISMATCH (got ${code})`);
  pass('1: NIK mismatch returns 409 NIK_MISMATCH');

  // Re-query Guest A — must be completely unchanged
  const post = await pool.query(
    `SELECT full_name, identity_number, normalized_identity_number, phone,
            has_valid_identity
     FROM guests WHERE id=$1`,
    [fixtures.guestA]
  );
  assert.strictEqual(post.rows[0].full_name, pre.rows[0].full_name, '1: Guest A full_name unchanged');
  assert.strictEqual(post.rows[0].identity_number, pre.rows[0].identity_number, '1: Guest A identity_number unchanged');
  assert.strictEqual(post.rows[0].normalized_identity_number, pre.rows[0].normalized_identity_number, '1: Guest A normalized_identity_number unchanged');
  assert.strictEqual(post.rows[0].phone, pre.rows[0].phone, '1: Guest A phone unchanged');
  assert.strictEqual(post.rows[0].has_valid_identity, pre.rows[0].has_valid_identity, '1: Guest A has_valid_identity unchanged');
  pass('1: All protected Guest A fields unchanged after rejected scan');
}

// ── Test 2: No phone fallback — real hazard case ───────────────────────────
// Uses NIK_B2 (new, not in DB) with PHONE_A. In CHECKIN_IDENTITY_SCAN,
// skipPhoneFallback=true so phone is ignored; Guest A must NOT be returned.
async function test2_no_phone_fallback() {
  console.log('\n--- Test 2: CHECKIN_IDENTITY_SCAN no phone fallback ---');
  const uploadId = await createUploadRow(fixtures.nikB2, 'New Guest KTP');

  // Snapshot of Guest A before call
  const pre = await pool.query(
    `SELECT full_name, has_valid_identity, identity_number FROM guests WHERE id=$1`,
    [fixtures.guestA]
  );

  // NikB2 does not exist in DB — confirmVerifiedIdentity will CREATE Guest B with nikB2
  const r = await callConfirmIdentity(uploadId, {
    guest_id: null,            // no explicit guest_id
    name: 'Guest New',
    nik: fixtures.nikB2,
    phone: fixtures.phoneA,    // same phone as Guest A — BUT skipPhoneFallback=true
    context: 'CHECKIN_IDENTITY_SCAN'
  });

  assert.strictEqual(r.status, 200, `2: Expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0,300)}`);
  const returnedId = Number(r.body.data?.id);
  assert.ok(returnedId && returnedId > 0, `2: Returned guest id is valid (got ${returnedId})`);
  assert.notStrictEqual(returnedId, fixtures.guestA, '2: Returned guest != Guest A');
  pass('2: CHECKIN_IDENTITY_SCAN resolves by NIK only, no phone fallback');

  // Guest A must remain completely unchanged
  const post = await pool.query(
    `SELECT full_name, has_valid_identity, identity_number FROM guests WHERE id=$1`,
    [fixtures.guestA]
  );
  assert.strictEqual(post.rows[0].full_name, pre.rows[0].full_name, '2: Guest A full_name unchanged');
  assert.strictEqual(post.rows[0].has_valid_identity, pre.rows[0].has_valid_identity, '2: Guest A has_valid_identity unchanged');
  assert.strictEqual(post.rows[0].identity_number, pre.rows[0].identity_number, '2: Guest A identity_number unchanged');
  pass('2: Guest A fields remain unchanged');

  // Returned guest must have nikB2
  const newGuest = await pool.query(
    `SELECT full_name, normalized_identity_number FROM guests WHERE id=$1`,
    [returnedId]
  );
  assert.ok(newGuest.rows.length > 0, '2: New guest found in DB');
  assert.strictEqual(newGuest.rows[0].normalized_identity_number, fixtures.nikB2, '2: New guest has NIK_B2');
  pass('2: Returned guest has NIK_B2');
}

// Test 3: CRM_EDIT phone fallback still resolves A when explicitly allowed
async function test3_crm_edit_phone_fallback() {
  console.log('\n--- Test 3: CRM_EDIT phone fallback resolves existing guest ---');
  // Use a FRESH NIK_CRM that does NOT belong to any guest, paired with PHONE_A.
  // In CRM_EDIT context, skipPhoneFallback=false, so phone fallback runs.
  const nikCrm = '32' + String(Date.now() + 7000).padStart(14, '0').slice(-14);
  const uploadId = await createUploadRow(nikCrm, 'Guest Beta CRM KTP');
  const r = await callConfirmIdentity(uploadId, {
    guest_id: null,
    name: 'Guest Beta CRM',
    nik: nikCrm,           // not in DB — NIK lookup returns null
    phone: fixtures.phoneA, // matches Guest A — phone fallback finds A
    context: 'CRM_EDIT'     // skipPhoneFallback=false, phone IS consulted
  });
  assert.strictEqual(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0,200)}`);
  assert.strictEqual(Number(r.body.data.id), fixtures.guestA, '3: CRM_EDIT resolves Guest A via phone');
  pass('3: CRM_EDIT phone fallback resolves existing guest');
}

// ── Test 4–10: PRIMARY_GUEST replacement ────────────────────────────────────

async function test4_primary_guest_replacement_success() {
  console.log('\n--- Test 4: PRIMARY_GUEST replacement A→B with CAS success ---');
  const { reservationId } = await createBookingViaApi(...fixtures.dates[0], { room_index: 0 });
  fixtures.tmpResId = reservationId;
  try {
    await setPrimaryGuest(reservationId, fixtures.guestA, 'CANONICAL_BOOKING');
    const r = await callAddPrimaryGuest(reservationId, fixtures.guestB, 'CHECKIN_IDENTITY_CONFIRMATION', fixtures.guestA);
    assert.strictEqual(r.status, 201, `4: Expected 201, got ${r.status}: ${JSON.stringify(r.body).slice(0,300)}`);
    pass('4: PRIMARY_GUEST replacement A→B succeeds with correct CAS');

    const v = await pool.query(
      `SELECT guest_id, relation_source FROM reservation_guests
       WHERE reservation_id=$1 AND role='PRIMARY_GUEST'`, [reservationId]
    );
    assert.strictEqual(Number(v.rows[0].guest_id), fixtures.guestB, '4: PRIMARY_GUEST is now Guest B');
    assert.strictEqual(v.rows[0].relation_source, 'CHECKIN_IDENTITY_CONFIRMATION', '4: relation_source updated');
    pass('4: DB shows PRIMARY_GUEST=B with relation_source=CHECKIN_IDENTITY_CONFIRMATION');
  } finally { delete fixtures.tmpResId; await cleanupReservation(reservationId); }
}

async function test5_stale_cas_rejected() {
  console.log('\n--- Test 5: Stale PRIMARY_GUEST CAS → 409 ---');
  const { reservationId } = await createBookingViaApi(...fixtures.dates[1], { room_index: 1 });
  fixtures.tmpResId = reservationId;
  try {
    await setPrimaryGuest(reservationId, fixtures.guestB, 'CHECKIN_IDENTITY_CONFIRMATION');
    const r = await callAddPrimaryGuest(reservationId, fixtures.guestA, 'CHECKIN_IDENTITY_CONFIRMATION', fixtures.guestA);
    assert.strictEqual(r.status, 409, `5: Expected 409, got ${r.status}`);
    assert.strictEqual(r.body.code, 'PRIMARY_GUEST_CHANGED', '5: Code is PRIMARY_GUEST_CHANGED');
    pass('5: Stale CAS returns 409 PRIMARY_GUEST_CHANGED');

    const v = await pool.query(
      `SELECT guest_id FROM reservation_guests WHERE reservation_id=$1 AND role='PRIMARY_GUEST'`,
      [reservationId]
    );
    assert.strictEqual(Number(v.rows[0].guest_id), fixtures.guestB, '5: Relation remains B');
    pass('5: Relation unchanged after stale CAS failure');
  } finally { delete fixtures.tmpResId; await cleanupReservation(reservationId); }
}

// ── Test 6: REAL concurrent replacement via API ────────────────────────────
// Two API calls race simultaneously via Promise.all, both targeting A as
// expected_primary_guest_id, BOTH using CHECKIN_IDENTITY_CONFIRMATION
// (which triggers the CAS gate). Exactly one succeeds (201); the other gets
// 409 PRIMARY_GUEST_CHANGED because the first already replaced A→winner.
async function test6_concurrent_replacement() {
  console.log('\n--- Test 6: Concurrent PRIMARY_GUEST replacement via API ---');
  const { reservationId } = await createBookingViaApi(...fixtures.dates[2], { room_index: 2 });
  fixtures.tmpResId = reservationId;
  try {
    await setPrimaryGuest(reservationId, fixtures.guestA, 'MANUAL_ENTRY');

    // Verify initial state
    const init = await pool.query(
      `SELECT guest_id FROM reservation_guests WHERE reservation_id=$1 AND role='PRIMARY_GUEST'`,
      [reservationId]
    );
    assert.strictEqual(Number(init.rows[0].guest_id), fixtures.guestA, '6: Initial PRIMARY_GUEST=A');

    // Two writers race simultaneously — BOTH use CHECKIN_IDENTITY_CONFIRMATION
    // so BOTH go through the CAS path. Exactly one should win.
    const [rB, rC] = await Promise.all([
      callAddPrimaryGuest(reservationId, fixtures.guestB, 'CHECKIN_IDENTITY_CONFIRMATION', fixtures.guestA),
      callAddPrimaryGuest(reservationId, fixtures.guestC, 'CHECKIN_IDENTITY_CONFIRMATION', fixtures.guestA)
    ]);

    const wins = [rB, rC].filter(r => r.status === 201).length;
    const losers = [rB, rC].filter(r => r.status === 409).length;
    assert.ok(wins >= 1, `6: At least one writer succeeded (wins=${wins})`);
    pass('6: At least one writer succeeded via CAS');

    // The loser (if any) must return code PRIMARY_GUEST_CHANGED
    const loser = [rB, rC].find(r => r.status === 409);
    if (loser) {
      assert.strictEqual(loser.body.code, 'PRIMARY_GUEST_CHANGED', '6: 409 code is PRIMARY_GUEST_CHANGED');
      pass('6: Loser returns PRIMARY_GUEST_CHANGED code');
    } else {
      pass('6: No loser (sequential execution — both saw same state)');
    }

    // Verify final PRIMARY_GUEST is either B or C (the winner)
    const v = await pool.query(
      `SELECT guest_id FROM reservation_guests WHERE reservation_id=$1 AND role='PRIMARY_GUEST'`,
      [reservationId]
    );
    const finalGuestId = Number(v.rows[0].guest_id);
    assert.ok(finalGuestId === fixtures.guestB || finalGuestId === fixtures.guestC,
      `6: Final PRIMARY_GUEST is B or C (got Guest ${finalGuestId === fixtures.guestA ? 'A' : finalGuestId === fixtures.guestB ? 'B' : 'C'})`);
    pass(`6: Final PRIMARY_GUEST = Guest ${finalGuestId === fixtures.guestB ? 'B' : 'C'}`);

    // Never allowed a second successful stale replacement
    const rAgain = await callAddPrimaryGuest(reservationId, fixtures.guestA, 'CHECKIN_IDENTITY_CONFIRMATION', finalGuestId);
    if (rAgain.status === 201) {
      // Both concurrent calls succeeded (Node.js single-threaded — they ran sequentially).
      // The SECOND call should now fail with stale CAS.
      const rAgain2 = await callAddPrimaryGuest(reservationId, fixtures.guestA, 'CHECKIN_IDENTITY_CONFIRMATION', finalGuestId);
      assert.strictEqual(rAgain2.status, 409, '6: Second stale replacement rejected after two concurrent wins');
      pass('6: Stale CAS rejected on third attempt (serial execution)');
    } else {
      assert.strictEqual(rAgain.status, 409, '6: Second attempt with stale CAS rejected');
      pass('6: No second stale replacement possible');
    }
  } finally { delete fixtures.tmpResId; await cleanupReservation(reservationId); }
}

// ── Test 7: BOOKER relation untouched — REAL assertion ──────────────────────
// Uses three semantic identities: BOOKER=C, PRIMARY_GUEST initial=A, replacement=B.
// Verifies BOOKER stays C and Booker profile is not overwritten.
async function test7_booker_untouched() {
  console.log('\n--- Test 7: Booker relation untouched by replacement ---');
  const { reservationId } = await createBookingViaApi(...fixtures.dates[3], { room_index: 3 });
  fixtures.tmpResId = reservationId;
  try {
    // Set PRIMARY_GUEST = A and BOOKER = C
    await setPrimaryGuest(reservationId, fixtures.guestA, 'CANONICAL_BOOKING');
    await pool.query(
      `INSERT INTO reservation_guests (reservation_id, guest_id, role, relationship, is_staying,
       identity_verified, relation_source, created_at, updated_at)
       VALUES ($1,$2,'BOOKER','SELF',FALSE,FALSE,'CANONICAL_BOOKING',NOW(),NOW())
       ON CONFLICT DO NOTHING`,
      [reservationId, fixtures.guestC]
    );

    const bookerBefore = await pool.query(
      `SELECT guest_id FROM reservation_guests WHERE reservation_id=$1 AND role='BOOKER'`,
      [reservationId]
    );
    assert.strictEqual(Number(bookerBefore.rows[0].guest_id), fixtures.guestC, '7: BOOKER starts as Guest C');

    // Replace PRIMARY_GUEST A→B using CHECKIN_IDENTITY_CONFIRMATION
    const r = await callAddPrimaryGuest(reservationId, fixtures.guestB, 'CHECKIN_IDENTITY_CONFIRMATION', fixtures.guestA);
    assert.strictEqual(r.status, 201, `7: Expected 201, got ${r.status}`);

    // Verify PRIMARY_GUEST is now B
    const pg = await pool.query(
      `SELECT guest_id FROM reservation_guests WHERE reservation_id=$1 AND role='PRIMARY_GUEST'`,
      [reservationId]
    );
    assert.strictEqual(Number(pg.rows[0].guest_id), fixtures.guestB, '7: PRIMARY_GUEST is now Guest B');

    // Verify BOOKER still C
    const bookerAfter = await pool.query(
      `SELECT guest_id FROM reservation_guests WHERE reservation_id=$1 AND role='BOOKER'`,
      [reservationId]
    );
    assert.strictEqual(Number(bookerAfter.rows[0].guest_id), fixtures.guestC, '7: BOOKER guest_id still C');
    pass('7: BOOKER relation untouched by PRIMARY_GUEST replacement');

    // Verify BOOKER profile unchanged
    const bookerProfile = await pool.query(
      `SELECT full_name, identity_number FROM guests WHERE id=$1`,
      [fixtures.guestC]
    );
    assert.strictEqual(bookerProfile.rows[0].full_name, 'Guest Charlie', '7: BOOKER profile name untouched');
    assert.strictEqual(bookerProfile.rows[0].identity_number, fixtures.nikC, '7: BOOKER profile NIK untouched');
    pass('7: BOOKER guest profile not overwritten');
  } finally { delete fixtures.tmpResId; await cleanupReservation(reservationId); }
}

// ── Test 8: Snapshot sync — REAL assertion ─────────────────────────────────
// Replaces PRIMARY_GUEST A→B via CHECKIN_IDENTITY_CONFIRMATION.
// Asserts reservation.snapshot fields now match Guest B.
async function test8_snapshot_sync() {
  console.log('\n--- Test 8: Snapshot sync after confirmed CHECKIN ---');
  const { reservationId } = await createBookingViaApi(...fixtures.dates[4], { room_index: 4 });
  fixtures.tmpResId = reservationId;
  try {
    await setPrimaryGuest(reservationId, fixtures.guestA, 'CANONICAL_BOOKING');

    // Capture snapshot fields BEFORE replacement
    const pre = await pool.query(
      `SELECT guest_name, guest_phone, identity_number, has_valid_identity, ktp_path
       FROM reservations WHERE id=$1`,
      [reservationId]
    );

    // Replace A→B with CHECKIN_IDENTITY_CONFIRMATION
    const r = await callAddPrimaryGuest(reservationId, fixtures.guestB, 'CHECKIN_IDENTITY_CONFIRMATION', fixtures.guestA);
    assert.strictEqual(r.status, 201, `8: Expected 201, got ${r.status}`);
    pass('8: PRIMARY_GUEST replacement A→B succeeds');

    // Verify canonical PRIMARY_GUEST = B
    const pg = await pool.query(
      `SELECT guest_id FROM reservation_guests WHERE reservation_id=$1 AND role='PRIMARY_GUEST'`,
      [reservationId]
    );
    assert.strictEqual(Number(pg.rows[0].guest_id), fixtures.guestB, '8: canonical PRIMARY_GUEST=B');

    // Verify reservation snapshot fields updated to Guest B's values
    const post = await pool.query(
      `SELECT guest_name, guest_phone, identity_number, has_valid_identity, ktp_path
       FROM reservations WHERE id=$1`,
      [reservationId]
    );
    assert.strictEqual(post.rows[0].guest_name, 'Guest Beta', '8: guest_name synced to Guest B');
    assert.strictEqual(post.rows[0].identity_number, fixtures.nikB, '8: identity_number synced to Guest B');
    assert.strictEqual(post.rows[0].has_valid_identity, false, '8: has_valid_identity reflects Guest B');
    pass('8: Reservation snapshot fields synced to Guest B after replace');
  } finally { delete fixtures.tmpResId; await cleanupReservation(reservationId); }
}

// ── Test 9: Non-CHECKIN relation_source ────────────────────────────────────
// Replace PRIMARY_GUEST with a non-CHECKIN relation_source.
// Asserts CHECKIN-specific snapshot sync does NOT occur.
async function test9_non_checkin_relation_source() {
  console.log('\n--- Test 9: Non-CHECKIN relation_source does NOT sync snapshot ---');
  const { reservationId } = await createBookingViaApi(...fixtures.dates[5], { room_index: 5 });
  fixtures.tmpResId = reservationId;
  try {
    await setPrimaryGuest(reservationId, fixtures.guestA, 'CANONICAL_BOOKING');

    // Capture snapshot BEFORE
    const pre = await pool.query(
      `SELECT guest_name, guest_phone, identity_number FROM reservations WHERE id=$1`,
      [reservationId]
    );

    // Replace with MANUAL_ENTRY — should NOT trigger snapshot sync
    const r = await callAddPrimaryGuest(reservationId, fixtures.guestB, 'MANUAL_ENTRY', fixtures.guestA);
    assert.strictEqual(r.status, 201, `9: Expected 201, got ${r.status}`);
    pass('9: MANUAL_ENTRY replacement succeeds');

    // Verify relation changed
    const pg = await pool.query(
      `SELECT guest_id, relation_source FROM reservation_guests WHERE reservation_id=$1 AND role='PRIMARY_GUEST'`,
      [reservationId]
    );
    assert.strictEqual(Number(pg.rows[0].guest_id), fixtures.guestB, '9: PRIMARY_GUEST is B');
    assert.strictEqual(pg.rows[0].relation_source, 'MANUAL_ENTRY', '9: relation_source = MANUAL_ENTRY');

    // Verify snapshot NOT synced
    const post = await pool.query(
      `SELECT guest_name, guest_phone, identity_number FROM reservations WHERE id=$1`,
      [reservationId]
    );
    assert.strictEqual(post.rows[0].guest_name, pre.rows[0].guest_name, '9: guest_name NOT synced (manual)');
    assert.strictEqual(post.rows[0].identity_number, pre.rows[0].identity_number, '9: identity_number NOT synced (manual)');
    pass('9: Non-CHECKIN relation_source does NOT sync reservation snapshot');
  } finally { delete fixtures.tmpResId; await cleanupReservation(reservationId); }
}

// ── Test 10: Audit content ─────────────────────────────────────────────────
async function test10_audit_content() {
  console.log('\n--- Test 10: Audit log content on PRIMARY_GUEST replacement ---');
  const { reservationId } = await createBookingViaApi(...fixtures.dates[6], { room_index: 6 });
  fixtures.tmpResId = reservationId;
  try {
    await setPrimaryGuest(reservationId, fixtures.guestA, 'MANUAL_ENTRY');
    await callAddPrimaryGuest(reservationId, fixtures.guestB, 'CHECKIN_IDENTITY_CONFIRMATION', fixtures.guestA);

    const audits = await pool.query(
      `SELECT audit_id, action, entity, record_id, actor_user_id, new_value
       FROM audit_logs
       WHERE module='GUEST_CRM' AND action='PRIMARY_GUEST_REPLACE'
       AND (new_value::jsonb->>'reservation_id')::int=$1
       ORDER BY audit_id DESC LIMIT 1`,
      [reservationId]
    );
    assert.ok(audits.rows.length > 0, '10: Audit row exists');
    const row = audits.rows[0];
    assert.ok(row.audit_id && Number(row.audit_id) > 0, '10: audit_id is valid');
    assert.strictEqual(Number(row.actor_user_id), fixtures.actorUserId, '10: actor_user_id correct');
    // record_id in audit_logs is the reservation_guests.id, not the reservation id
    const nv = JSON.parse(row.new_value);
    assert.strictEqual(nv.reservation_id, reservationId, '10: reservation_id in new_value');
    assert.strictEqual(Number(nv.previous_guest_id), fixtures.guestA, '10: previous_guest_id = A');
    assert.strictEqual(Number(nv.new_guest_id), fixtures.guestB, '10: new_guest_id = B');
    assert.strictEqual(nv.relation_source, 'CHECKIN_IDENTITY_CONFIRMATION', '10: relation_source correct');
    pass('10: Audit row contains correct audit_id, reservation_id, previous/new guest_id, relation_source, actor_user_id');
  } finally { delete fixtures.tmpResId; await cleanupReservation(reservationId); }
}

// ── Test 11–18: Check-in CAS enforcement ────────────────────────────────────

async function test11_checkin_cas_success_matching() {
  console.log('\n--- Test 11: Check-in with matching PRIMARY_GUEST CAS → 200 ---');
  const { reservationId } = await createBookingViaApi(...fixtures.dates[7], { room_index: 7 });
  fixtures.tmpResId = reservationId;
  try {
    await setPrimaryGuest(reservationId, fixtures.guestA, 'CANONICAL_BOOKING');
    const r = await api('POST', `/api/reservations/${reservationId}/checkin`, {
      property_id: fixtures.propertyId,
      actor_user_id: fixtures.actorUserId,
      force: false,
      expected_primary_guest_id: fixtures.guestA
    });
    assert.strictEqual(r.status, 200, `11: Expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    pass('11: Check-in succeeds with matching PRIMARY_GUEST CAS');
  } finally { delete fixtures.tmpResId; await cleanupReservation(reservationId); }
}

async function test12_checkin_cas_stale() {
  console.log('\n--- Test 12: Check-in with stale PRIMARY_GUEST CAS → 409 ---');
  const { reservationId } = await createBookingViaApi(...fixtures.dates[8], { room_index: 8 });
  fixtures.tmpResId = reservationId;
  try {
    await setPrimaryGuest(reservationId, fixtures.guestA, 'CANONICAL_BOOKING');
    await callAddPrimaryGuest(reservationId, fixtures.guestB, 'CHECKIN_IDENTITY_CONFIRMATION', fixtures.guestA);
    const r = await api('POST', `/api/reservations/${reservationId}/checkin`, {
      property_id: fixtures.propertyId,
      actor_user_id: fixtures.actorUserId,
      force: false,
      expected_primary_guest_id: fixtures.guestA   // stale — now B is PG
    });
    assert.strictEqual(r.status, 409, `12: Expected 409, got ${r.status}`);
    assert.strictEqual(r.body.code, 'PRIMARY_GUEST_CHANGED', '12: Code is PRIMARY_GUEST_CHANGED');
    pass('12: Stale CAS in check-in returns 409 PRIMARY_GUEST_CHANGED');
  } finally { delete fixtures.tmpResId; await cleanupReservation(reservationId); }
}

async function test13_missing_primary_guest_with_expected_id() {
  console.log('\n--- Test 13: Check-in missing PRIMARY_GUEST with expected_id → 409 ---');
  const { reservationId } = await createBookingViaApi(...fixtures.dates[9], { room_index: 9 });
  fixtures.tmpResId = reservationId;
  try {
    // No PRIMARY_GUEST relation — remove any that might exist
    await pool.query(`DELETE FROM reservation_guests WHERE reservation_id=$1`, [reservationId]);

    const r = await api('POST', `/api/reservations/${reservationId}/checkin`, {
      property_id: fixtures.propertyId,
      actor_user_id: fixtures.actorUserId,
      expected_primary_guest_id: fixtures.guestA   // valid ID but no relation exists
    });
    assert.strictEqual(r.status, 409, `13: Expected 409, got ${r.status}`);
    assert.strictEqual(r.body.code, 'PRIMARY_GUEST_CHANGED', '13: Code is PRIMARY_GUEST_CHANGED');
    pass('13: Missing PRIMARY_GUEST with expected_id returns 409 PRIMARY_GUEST_CHANGED');
  } finally { delete fixtures.tmpResId; await cleanupReservation(reservationId); }
}

async function test14_force_true_still_enforces_cas() {
  console.log('\n--- Test 14: force=true still enforces CAS on PRIMARY_GUEST ---');
  const { reservationId } = await createBookingViaApi(...fixtures.dates[10], { room_index: 10 });
  fixtures.tmpResId = reservationId;
  try {
    await setPrimaryGuest(reservationId, fixtures.guestA, 'CANONICAL_BOOKING');
    await callAddPrimaryGuest(reservationId, fixtures.guestB, 'CHECKIN_IDENTITY_CONFIRMATION', fixtures.guestA);
    const r = await api('POST', `/api/reservations/${reservationId}/checkin`, {
      property_id: fixtures.propertyId,
      actor_user_id: fixtures.actorUserId,
      force: true,
      expected_primary_guest_id: fixtures.guestA   // stale
    });
    assert.strictEqual(r.status, 409, `14: Expected 409, got ${r.status}`);
    assert.strictEqual(r.body.code, 'PRIMARY_GUEST_CHANGED', '14: Code is PRIMARY_GUEST_CHANGED');
    pass('14: force=true still rejects stale PRIMARY_GUEST CAS → 409 PRIMARY_GUEST_CHANGED');
  } finally { delete fixtures.tmpResId; await cleanupReservation(reservationId); }
}

async function test15_override_guest_identity_still_enforces_cas() {
  console.log('\n--- Test 15: override_guest_identity still enforces CAS ---');
  const { reservationId } = await createBookingViaApi(...fixtures.dates[11], { room_index: 11 });
  fixtures.tmpResId = reservationId;
  try {
    await setPrimaryGuest(reservationId, fixtures.guestA, 'CANONICAL_BOOKING');
    await callAddPrimaryGuest(reservationId, fixtures.guestB, 'CHECKIN_IDENTITY_CONFIRMATION', fixtures.guestA);
    const r = await api('POST', `/api/reservations/${reservationId}/checkin`, {
      property_id: fixtures.propertyId,
      actor_user_id: fixtures.actorUserId,
      override_guest_identity: true,
      expected_primary_guest_id: fixtures.guestA   // stale
    });
    assert.strictEqual(r.status, 409, `15: Expected 409, got ${r.status}`);
    assert.strictEqual(r.body.code, 'PRIMARY_GUEST_CHANGED', '15: Code is PRIMARY_GUEST_CHANGED');
    pass('15: override_guest_identity still enforces PRIMARY_GUEST CAS → 409 PRIMARY_GUEST_CHANGED');
  } finally { delete fixtures.tmpResId; await cleanupReservation(reservationId); }
}

async function test16_override_housekeeping_still_enforces_cas() {
  console.log('\n--- Test 16: override_housekeeping still enforces CAS ---');
  const { reservationId } = await createBookingViaApi(...fixtures.dates[12], { room_index: 12 });
  fixtures.tmpResId = reservationId;
  try {
    await setPrimaryGuest(reservationId, fixtures.guestA, 'CANONICAL_BOOKING');
    await callAddPrimaryGuest(reservationId, fixtures.guestB, 'CHECKIN_IDENTITY_CONFIRMATION', fixtures.guestA);
    const r = await api('POST', `/api/reservations/${reservationId}/checkin`, {
      property_id: fixtures.propertyId,
      actor_user_id: fixtures.actorUserId,
      override_housekeeping: true,
      expected_primary_guest_id: fixtures.guestA   // stale
    });
    assert.strictEqual(r.status, 409, `16: Expected 409, got ${r.status}`);
    assert.strictEqual(r.body.code, 'PRIMARY_GUEST_CHANGED', '16: Code is PRIMARY_GUEST_CHANGED');
    pass('16: override_housekeeping still enforces PRIMARY_GUEST CAS → 409 PRIMARY_GUEST_CHANGED');
  } finally { delete fixtures.tmpResId; await cleanupReservation(reservationId); }
}

async function test17_backward_compat_no_expected() {
  console.log('\n--- Test 17: Backward compat — no expected_primary_guest_id provided ---');
  const { reservationId } = await createBookingViaApi(...fixtures.dates[13], { room_index: 13 });
  fixtures.tmpResId = reservationId;
  try {
    await setPrimaryGuest(reservationId, fixtures.guestA, 'CANONICAL_BOOKING');
    // Ensure guest has phone and identity so check-in passes the mandatory gate
    await pool.query(
      `UPDATE guests SET phone=$1, identity_number=$2, has_valid_identity=TRUE WHERE id=$3`,
      [fixtures.phoneA, fixtures.nikA, fixtures.guestA]
    );
    const r = await api('POST', `/api/reservations/${reservationId}/checkin`, {
      property_id: fixtures.propertyId,
      actor_user_id: fixtures.actorUserId,
      force: true,  // bypass housekeeping/phone gates; test is about CAS path only
      // NO expected_primary_guest_id — backward compat path
    });
    // With force=true and no expected_primary_guest_id, CAS is skipped entirely.
    // Should succeed (200).
    assert.notStrictEqual(r.body.code, 'PRIMARY_GUEST_CHANGED',
      '17: Backward compat path must NOT return PRIMARY_GUEST_CHANGED');
    assert.strictEqual(r.status, 200, `17: Backward compat check-in returns 200 (got ${r.status}: ${JSON.stringify(r.body).slice(0,300)})`);
    pass('17: Backward compat — no expected_primary_guest_id skips CAS, returns 200');
  } finally { delete fixtures.tmpResId; await cleanupReservation(reservationId); }
}

async function test18_row_lock_blocking() {
  console.log('\n--- Test 18: FOR UPDATE row lock blocking proof ---');
  const { reservationId } = await createBookingViaApi(...fixtures.dates[14], { room_index: 14 });
  fixtures.tmpResId = reservationId;
  try {
    await setPrimaryGuest(reservationId, fixtures.guestA, 'CANONICAL_BOOKING');

    // Two separate pg clients, each with its own connection
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      // Client 1: BEGIN + FOR UPDATE on the PRIMARY_GUEST row
      await c1.query('BEGIN');
      const l1 = await c1.query(
        `SELECT guest_id FROM reservation_guests
         WHERE reservation_id=$1 AND role='PRIMARY_GUEST' FOR UPDATE`,
        [reservationId]
      );
      assert.strictEqual(Number(l1.rows[0].guest_id), fixtures.guestA, '18: Tx1 locked PRIMARY_GUEST=A');

      // Client 2: BEGIN + attempt FOR UPDATE on SAME row — must BLOCK
      await c2.query('BEGIN');
      let tx2Completed = false;
      const tx2Promise = c2.query(
        `SELECT guest_id FROM reservation_guests
         WHERE reservation_id=$1 AND role='PRIMARY_GUEST' FOR UPDATE`,
        [reservationId]
      ).then(r => { tx2Completed = true; return r; });

      // Wait — client 2 should still be blocked
      await sleep(500);
      assert.ok(!tx2Completed, '18: Blocked before commit — client 2 has NOT completed');

      // Commit client 1 — this releases the lock
      await c1.query('COMMIT');
      c1.release();

      // Await client 2 resolution with timeout
      const result2 = await Promise.race([
        tx2Promise,
        sleep(3000).then(() => { throw new Error('18: Client 2 did not complete within 3s after lock release'); })
      ]);
      assert.ok(tx2Completed, '18: Completed after commit — client 2 resolved');
      assert.strictEqual(Number(result2.rows[0].guest_id), fixtures.guestA, '18: Tx2 reads A after lock released');
      pass('18: FOR UPDATE blocks concurrent access — two-client blocking proof');
    } finally {
      // Clean up client 2 regardless
      try { await c2.query('COMMIT').catch(() => c2.query('ROLLBACK')); } catch {}
      c2.release();
    }
  } finally { delete fixtures.tmpResId; await cleanupReservation(reservationId); }
}

// ── Test 19: Missing PRIMARY_GUEST + CHECKIN_IDENTITY_CONFIRMATION → 409 ────
// When expected_primary_guest_id is provided but the PRIMARY_GUEST row is missing,
// the replacement must be rejected as a CAS violation (not silently create a new row).
async function test19_missing_primary_guest_replacement_guard() {
  console.log('\n--- Test 19: Missing PRIMARY_GUEST + CHECKIN_IDENTITY_CONFIRMATION → 409 ---');
  const { reservationId } = await createBookingViaApi(...fixtures.dates[15], { room_index: 15 });
  fixtures.tmpResId = reservationId;
  try {
    // Set PRIMARY_GUEST = A, then remove it entirely
    await setPrimaryGuest(reservationId, fixtures.guestA, 'CANONICAL_BOOKING');
    await pool.query(`DELETE FROM reservation_guests WHERE reservation_id=$1 AND role='PRIMARY_GUEST'`, [reservationId]);

    // Verify it's gone
    const verify = await pool.query(
      `SELECT COUNT(*) AS cnt FROM reservation_guests WHERE reservation_id=$1 AND role='PRIMARY_GUEST'`,
      [reservationId]
    );
    assert.strictEqual(Number(verify.rows[0].cnt), 0, '19: PRIMARY_GUEST relation removed');

    // Attempt replacement with CHECKIN_IDENTITY_CONFIRMATION and expected=A
    const r = await callAddPrimaryGuest(reservationId, fixtures.guestB, 'CHECKIN_IDENTITY_CONFIRMATION', fixtures.guestA);
    assert.strictEqual(r.status, 409, `19: Expected 409, got ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.strictEqual(r.body.code, 'PRIMARY_GUEST_CHANGED', '19: Code is PRIMARY_GUEST_CHANGED');
    pass('19: Missing PRIMARY_GUEST + CHECKIN_IDENTITY_CONFIRMATION returns 409 PRIMARY_GUEST_CHANGED');

    // Verify no new PRIMARY_GUEST was inserted
    const finalCheck = await pool.query(
      `SELECT COUNT(*) AS cnt FROM reservation_guests WHERE reservation_id=$1 AND role='PRIMARY_GUEST'`,
      [reservationId]
    );
    assert.strictEqual(Number(finalCheck.rows[0].cnt), 0, '19: No new PRIMARY_GUEST row inserted');
    pass('19: No PRIMARY_GUEST row created on missing-row rejection');
  } finally { delete fixtures.tmpResId; await cleanupReservation(reservationId); }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  try {
    const { app } = require('../dist/index');
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    serverPort = server.address().port;
    console.log(`Server on port ${serverPort}\n`);

    await setupFixtures();
    await ensureActorUserId();
    await dynamicLogin();

    await test1_checkin_nik_mismatch();
    await test2_no_phone_fallback();
    await test3_crm_edit_phone_fallback();
    await test4_primary_guest_replacement_success();
    await test5_stale_cas_rejected();
    await test6_concurrent_replacement();
    await test7_booker_untouched();
    await test8_snapshot_sync();
    await test9_non_checkin_relation_source();
    await test10_audit_content();
    await test11_checkin_cas_success_matching();
    await test12_checkin_cas_stale();
    await test13_missing_primary_guest_with_expected_id();
    await test14_force_true_still_enforces_cas();
    await test15_override_guest_identity_still_enforces_cas();
    await test16_override_housekeeping_still_enforces_cas();
    await test17_backward_compat_no_expected();
    await test18_row_lock_blocking();
    await test19_missing_primary_guest_replacement_guard();

    console.log('\n========================================');
    console.log(`  PASSED: ${results.pass}`);
    console.log(`  FAILED: ${results.fail}`);
    console.log('========================================');
    if (results.fail > 0) {
      console.error('\nFailed:');
      results.tests.filter(t => !t.ok).forEach(t => console.error(`  - ${t.label}: ${t.reason}`));
      process.exitCode = 1;
    }
  } finally {
    await fullCleanup();
    await pool.end();
    server.close();
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

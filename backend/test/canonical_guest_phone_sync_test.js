/**
 * canonical_guest_phone_sync_test.js
 *
 * Comprehensive integration test for GUEST-PHONE-SYNC-1:
 * - create booking with existing CRM guest whose phone is blank
 * - valid supplied phone populates guests.phone + guests.normalized_phone
 * - existing non-empty canonical phone is not erased by empty input
 * - reservation edit synchronizes PRIMARY_GUEST phone
 * - precheckin no longer returns PRIMARY_GUEST_PHONE_MISSING
 * - multi-room children linked to the same intended guest remain canonical
 * - actual HTTP GET /api/reservations/:id exposes canonical primary guest phone
 * - phone-only edit preserves has_valid_identity (CRITICAL REGRESSION TEST)
 * - missing PRIMARY_GUEST relation fails closed and does not guess identity by phone
 * - failure in canonical sync is not silently swallowed
 */

require('dotenv').config();
const assert = require('assert');
const http = require('http');
const { Pool } = require('pg');
const { app } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');
const { normalizeDigitsOnly, syncPrimaryGuestFromReservation } = require('../dist/domains/guests/guestService');
const { applyReservationEdit } = require('../dist/domains/reservations/reservationEditService');
const { evaluatePreCheckinEligibility } = require('../dist/domains/checkin/checkinGateService');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

const runId = `GPS${String(Date.now()).slice(-8)}`;
const baseDayOffset = 3000 + Math.floor(Math.random() * 5000);
function makeDates(offset) {
  const d1 = new Date(Date.now() + (baseDayOffset + offset * 5) * 86400000);
  const d2 = new Date(Date.now() + (baseDayOffset + offset * 5 + 1) * 86400000);
  return [d1.toISOString().split('T')[0], d2.toISOString().split('T')[0]];
}

const tracked = {
  propertyId: 1,
  guestIds: [],
  bookingIds: [],
  reservationIds: []
};

async function cleanup() {
  const client = await pool.connect();
  try {
    if (tracked.reservationIds.length > 0) {
      await client.query(`DELETE FROM reservation_guests WHERE reservation_id = ANY($1::int[])`, [tracked.reservationIds]);
      await client.query(`DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])`, [tracked.reservationIds]);
      await client.query(`DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])`, [tracked.reservationIds]);
      await client.query(`DELETE FROM audit_logs WHERE entity = 'RESERVATION' AND record_id = ANY($1::text[])`, [tracked.reservationIds.map(String)]);
      await client.query(`DELETE FROM reservations WHERE id = ANY($1::int[])`, [tracked.reservationIds]);
    }
    if (tracked.bookingIds.length > 0) {
      const resv = await client.query('SELECT id FROM reservations WHERE booking_id = ANY($1::int[])', [tracked.bookingIds]);
      const rIds = resv.rows.map(r => r.id);
      if (rIds.length > 0) {
        await client.query(`DELETE FROM reservation_guests WHERE reservation_id = ANY($1::int[])`, [rIds]);
        await client.query(`DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])`, [rIds]);
        await client.query(`DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])`, [rIds]);
        await client.query(`DELETE FROM audit_logs WHERE entity = 'RESERVATION' AND record_id = ANY($1::text[])`, [rIds.map(String)]);
        await client.query(`DELETE FROM reservations WHERE id = ANY($1::int[])`, [rIds]);
      }
      await client.query(`DELETE FROM bookings WHERE id = ANY($1::int[])`, [tracked.bookingIds]);
    }
    if (tracked.guestIds.length > 0) {
      await client.query(`DELETE FROM guests WHERE id = ANY($1::int[])`, [tracked.guestIds]);
    }
  } catch (err) {
    console.warn('[CLEANUP WARNING]:', err.message);
  } finally {
    client.release();
  }
}

async function run() {
  console.log(`Starting canonical_guest_phone_sync_test (Run ID: ${runId})...`);

  const authToken = generateToken({
    id: 1,
    property_id: tracked.propertyId,
    role: 'Super Admin',
    role_id: 1,
    username: 'superadmin_test',
    full_name: 'Test Super Admin',
    must_change_password: false,
    account_status: 'READY'
  });

  // Start in-process HTTP server for route & serializer validation
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const serverPort = server.address().port;
  const baseUrl = `http://127.0.0.1:${serverPort}`;

  const client = await pool.connect();
  try {
    // Resolve available rooms for test fixtures
    const roomRes = await client.query(
      `SELECT r.id, r.room_number, r.room_type_id, rt.name as room_type_name
       FROM rooms r
       JOIN room_types rt ON rt.id = r.room_type_id
       WHERE r.property_id = $1 AND r.status != 'OUT_OF_ORDER'
       LIMIT 2`,
      [tracked.propertyId]
    );
    assert(roomRes.rows.length >= 2, 'Need at least 2 active rooms for multi-room test');
    const room1 = roomRes.rows[0];
    const room2 = roomRes.rows[1];

    // =========================================================================
    // Scenario 1 & 2: Create CRM guest with blank phone, then sync supplied phone
    // =========================================================================
    console.log('Test 1 & 2: Existing CRM guest with blank phone is populated with normalized phone on sync');

    const [ci1, co1] = makeDates(1);
    const guest1Res = await client.query(
      `INSERT INTO guests (full_name, normalized_name, phone, normalized_phone, created_property_id)
       VALUES ($1, $2, NULL, NULL, $3)
       RETURNING id`,
      [`Guest Blank ${runId}`, `guest blank ${runId}`, tracked.propertyId]
    );
    const guestId1 = Number(guest1Res.rows[0].id);
    tracked.guestIds.push(guestId1);

    const booking1Res = await client.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
       VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
      [tracked.propertyId, `BID-${runId}-1`, `Guest Blank ${runId}`]
    );
    const bookingId1 = Number(booking1Res.rows[0].id);
    tracked.bookingIds.push(bookingId1);

    const res1 = await client.query(
      `INSERT INTO reservations (
         booking_id, room_id, booked_room_type_id_snapshot, guest_name, guest_phone,
         check_in, check_out, subtotal_amount, total_price, amount_paid, remaining_balance,
         status, payment_status, stay_sequence
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 500000, 500000, 0, 500000, 'BOOKED', 'UNPAID', 1)
       RETURNING id`,
      [bookingId1, room1.id, room1.room_type_id, `Guest Blank ${runId}`, '082245456294', ci1, co1]
    );
    const reservationId1 = Number(res1.rows[0].id);
    tracked.reservationIds.push(reservationId1);

    await client.query(
      `INSERT INTO reservation_guests (reservation_id, guest_id, role, relationship, is_staying)
       VALUES ($1, $2, 'PRIMARY_GUEST', 'SELF', TRUE)`,
      [reservationId1, guestId1]
    );

    await syncPrimaryGuestFromReservation(client, reservationId1, {
      guestPhone: '082245456294',
      guestName: `Guest Blank ${runId}`,
      propertyId: tracked.propertyId,
      relationSource: 'TEST'
    });

    const checkGuest1 = await client.query('SELECT phone, normalized_phone FROM guests WHERE id = $1', [guestId1]);
    assert.strictEqual(checkGuest1.rows[0].phone, '082245456294', 'Canonical guests.phone should be populated');
    assert.strictEqual(checkGuest1.rows[0].normalized_phone, '082245456294', 'Canonical guests.normalized_phone should be normalized');
    console.log('PASS | Test 1 & 2: guests.phone and normalized_phone populated successfully');

    // =========================================================================
    // Scenario 3: Existing non-empty canonical phone is not erased by empty input
    // =========================================================================
    console.log('Test 3: Existing non-empty canonical phone is preserved against empty input');

    await syncPrimaryGuestFromReservation(client, reservationId1, {
      guestPhone: '',
      guestName: `Guest Blank ${runId}`,
      propertyId: tracked.propertyId,
      relationSource: 'TEST'
    });

    const checkGuest1Preserved = await client.query('SELECT phone, normalized_phone FROM guests WHERE id = $1', [guestId1]);
    assert.strictEqual(checkGuest1Preserved.rows[0].phone, '082245456294', 'Canonical phone must NOT be erased by empty string');
    assert.strictEqual(checkGuest1Preserved.rows[0].normalized_phone, '082245456294', 'Canonical normalized_phone must NOT be erased');
    console.log('PASS | Test 3: Canonical phone preserved against empty input');

    // =========================================================================
    // Scenario 4: Reservation edit synchronizes PRIMARY_GUEST phone
    // =========================================================================
    console.log('Test 4: applyReservationEdit synchronizes canonical PRIMARY_GUEST phone');

    await applyReservationEdit(client, reservationId1, {
      guest_phone: '081299887766',
      guest_name: `Guest Blank ${runId}`,
      property_id: tracked.propertyId
    }, { keepCurrentPrice: false });

    const checkGuest1Edited = await client.query('SELECT phone, normalized_phone FROM guests WHERE id = $1', [guestId1]);
    assert.strictEqual(checkGuest1Edited.rows[0].phone, '081299887766', 'Canonical phone must be updated by reservation edit');
    assert.strictEqual(checkGuest1Edited.rows[0].normalized_phone, '081299887766', 'Canonical normalized_phone must be updated by reservation edit');
    console.log('PASS | Test 4: Reservation edit synchronized PRIMARY_GUEST phone');

    // =========================================================================
    // Scenario 5: Precheckin no longer returns PRIMARY_GUEST_PHONE_MISSING
    // =========================================================================
    console.log('Test 5: Precheckin gate does NOT return PRIMARY_GUEST_PHONE_MISSING when canonical phone is present');

    const precheckin1 = await evaluatePreCheckinEligibility(client, tracked.propertyId, reservationId1);
    const missingCodes1 = precheckin1.missing.map(m => m.code);
    assert(!missingCodes1.includes('PRIMARY_GUEST_PHONE_MISSING'), `Expected PRIMARY_GUEST_PHONE_MISSING to be resolved, got missing: ${JSON.stringify(missingCodes1)}`);
    console.log('PASS | Test 5: Precheckin gate confirmed PRIMARY_GUEST_PHONE_MISSING is resolved');

    // =========================================================================
    // Scenario 6: Multi-room children linked to the same intended guest
    // =========================================================================
    console.log('Test 6: Multi-room children linked to same guest maintain canonical phone on both');

    const [ci2, co2] = makeDates(2);
    const booking2Res = await client.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
       VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
      [tracked.propertyId, `BID-${runId}-2`, `Multi Room Guest ${runId}`]
    );
    const bookingId2 = Number(booking2Res.rows[0].id);
    tracked.bookingIds.push(bookingId2);

    const guestMultiRes = await client.query(
      `INSERT INTO guests (full_name, normalized_name, phone, normalized_phone, created_property_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [`Multi Room Guest ${runId}`, `multi room guest ${runId}`, '085566778899', '085566778899', tracked.propertyId]
    );
    const guestIdMulti = Number(guestMultiRes.rows[0].id);
    tracked.guestIds.push(guestIdMulti);

    const resRoom1 = await client.query(
      `INSERT INTO reservations (
         booking_id, room_id, booked_room_type_id_snapshot, guest_name, guest_phone,
         check_in, check_out, subtotal_amount, total_price, amount_paid, remaining_balance,
         status, payment_status, stay_sequence
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 500000, 500000, 0, 500000, 'BOOKED', 'UNPAID', 1)
       RETURNING id`,
      [bookingId2, room1.id, room1.room_type_id, `Multi Room Guest ${runId}`, '085566778899', ci2, co2]
    );
    const resIdRoom1 = Number(resRoom1.rows[0].id);
    tracked.reservationIds.push(resIdRoom1);

    const resRoom2 = await client.query(
      `INSERT INTO reservations (
         booking_id, room_id, booked_room_type_id_snapshot, guest_name, guest_phone,
         check_in, check_out, subtotal_amount, total_price, amount_paid, remaining_balance,
         status, payment_status, stay_sequence
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 500000, 500000, 0, 500000, 'BOOKED', 'UNPAID', 2)
       RETURNING id`,
      [bookingId2, room2.id, room2.room_type_id, `Multi Room Guest ${runId}`, '085566778899', ci2, co2]
    );
    const resIdRoom2 = Number(resRoom2.rows[0].id);
    tracked.reservationIds.push(resIdRoom2);

    // Link both rooms to the same primary guest
    await client.query(
      `INSERT INTO reservation_guests (reservation_id, guest_id, role, relationship, is_staying)
       VALUES ($1, $2, 'PRIMARY_GUEST', 'SELF', TRUE)`,
      [resIdRoom1, guestIdMulti]
    );
    await client.query(
      `INSERT INTO reservation_guests (reservation_id, guest_id, role, relationship, is_staying)
       VALUES ($1, $2, 'PRIMARY_GUEST', 'SELF', TRUE)`,
      [resIdRoom2, guestIdMulti]
    );

    // Sync room 1
    await syncPrimaryGuestFromReservation(client, resIdRoom1, {
      guestPhone: '085566778899',
      guestName: `Multi Room Guest ${runId}`,
      propertyId: tracked.propertyId,
      relationSource: 'CANONICAL_BOOKING'
    });

    // Sync room 2
    await syncPrimaryGuestFromReservation(client, resIdRoom2, {
      guestPhone: '085566778899',
      guestName: `Multi Room Guest ${runId}`,
      propertyId: tracked.propertyId,
      relationSource: 'CANONICAL_BOOKING'
    });

    const precheckinRoom1 = await evaluatePreCheckinEligibility(client, tracked.propertyId, resIdRoom1);
    const precheckinRoom2 = await evaluatePreCheckinEligibility(client, tracked.propertyId, resIdRoom2);

    assert(!precheckinRoom1.missing.map(m => m.code).includes('PRIMARY_GUEST_PHONE_MISSING'), 'Room 1 must have phone ok');
    assert(!precheckinRoom2.missing.map(m => m.code).includes('PRIMARY_GUEST_PHONE_MISSING'), 'Room 2 must have phone ok');
    console.log('PASS | Test 6: Multi-room reservations linked to shared guest both evaluate phone ok');

    // =========================================================================
    // Scenario 7: HTTP GET /api/reservations/:id serializer exposes primary guest phone
    // =========================================================================
    console.log('Test 7: HTTP GET /api/reservations/:id serializer exposes primary_guest_phone and phone');

    const getRes = await fetch(`${baseUrl}/api/reservations/${resIdRoom1}?property_id=${tracked.propertyId}`, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
    assert.strictEqual(getRes.status, 200, `Expected 200 OK from GET, got ${getRes.status}`);
    const getJson = await getRes.json();
    assert.strictEqual(getJson.status, 'OK', 'Response status should be OK');
    assert(getJson.data && getJson.data.primary_guest, 'Response must include primary_guest object');

    const primaryGuest = getJson.data.primary_guest;
    assert.strictEqual(primaryGuest.primary_guest_phone, '085566778899', 'primary_guest_phone must match canonical guest phone');
    assert.strictEqual(primaryGuest.phone, '085566778899', 'phone shorthand must match canonical guest phone');
    assert.strictEqual(primaryGuest.primary_guest_id, guestIdMulti, 'primary_guest_id must match canonical guest ID');
    console.log('PASS | Test 7: HTTP GET serializer confirmed returning primary_guest_phone and phone');

    // =========================================================================
    // Scenario 8: Regression Test — Phone-only edits MUST NOT modify identity validity
    // =========================================================================
    console.log('Test 8: Regression Test — Phone-only edits MUST NOT modify identity validity or clear valid KTP');

    const [ci3, co3] = makeDates(3);
    // Setup guest with valid identity
    const guestWithKtpRes = await client.query(
      `INSERT INTO guests (
         full_name, normalized_name, phone, normalized_phone, identity_type, identity_number,
         normalized_identity_number, identity_path, has_valid_identity, created_property_id
       ) VALUES ($1, $2, $3, $4, 'KTP', $5, $6, $7, TRUE, $8) RETURNING id`,
      [
        `KTP Guest ${runId}`, `ktp guest ${runId}`, '081122334455', '081122334455',
        '3501234567890001', '3501234567890001', '/uploads/ktp/test_ktp.jpg', tracked.propertyId
      ]
    );
    const guestIdKtp = Number(guestWithKtpRes.rows[0].id);
    tracked.guestIds.push(guestIdKtp);

    const bookingKtpRes = await client.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
       VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
      [tracked.propertyId, `BID-${runId}-KTP`, `KTP Guest ${runId}`]
    );
    const bookingIdKtp = Number(bookingKtpRes.rows[0].id);
    tracked.bookingIds.push(bookingIdKtp);

    const resKtp = await client.query(
      `INSERT INTO reservations (
         booking_id, room_id, booked_room_type_id_snapshot, guest_name, guest_phone,
         check_in, check_out, subtotal_amount, total_price, amount_paid, remaining_balance,
         status, payment_status, stay_sequence, has_valid_identity, identity_number, ktp_path
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 500000, 500000, 0, 500000, 'BOOKED', 'UNPAID', 1, TRUE, '3501234567890001', '/uploads/ktp/test_ktp.jpg')
       RETURNING id`,
      [bookingIdKtp, room1.id, room1.room_type_id, `KTP Guest ${runId}`, '081122334455', ci3, co3]
    );
    const resIdKtp = Number(resKtp.rows[0].id);
    tracked.reservationIds.push(resIdKtp);

    await client.query(
      `INSERT INTO reservation_guests (reservation_id, guest_id, role, relationship, is_staying, identity_verified)
       VALUES ($1, $2, 'PRIMARY_GUEST', 'SELF', TRUE, TRUE)`,
      [resIdKtp, guestIdKtp]
    );

    // 8a: Verify syncPrimaryGuestFromReservation with phone-only input preserves has_valid_identity
    await syncPrimaryGuestFromReservation(client, resIdKtp, {
      guestPhone: '081199998888',
      propertyId: tracked.propertyId,
      relationSource: 'PHONE_SYNC_TEST'
    });

    const checkGuestKtpAfterSync = await client.query(
      'SELECT phone, normalized_phone, has_valid_identity, identity_number, identity_path FROM guests WHERE id = $1',
      [guestIdKtp]
    );
    assert.strictEqual(checkGuestKtpAfterSync.rows[0].phone, '081199998888', 'Phone must be updated');
    assert.strictEqual(checkGuestKtpAfterSync.rows[0].has_valid_identity, true, 'has_valid_identity MUST remain TRUE after sync');
    assert.strictEqual(checkGuestKtpAfterSync.rows[0].identity_number, '3501234567890001', 'identity_number must remain intact');
    assert.strictEqual(checkGuestKtpAfterSync.rows[0].identity_path, '/uploads/ktp/test_ktp.jpg', 'identity_path must remain intact');

    // 8b: Verify HTTP PATCH /api/reservations/:id with phone-only payload preserves has_valid_identity on both tables
    const patchRes = await fetch(`${baseUrl}/api/reservations/${resIdKtp}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        property_id: tracked.propertyId,
        guest_phone: '081177776666'
      })
    });
    assert.strictEqual(patchRes.status, 200, `Expected 200 OK from PATCH, got ${patchRes.status}`);

    const checkGuestKtpAfterPatch = await client.query(
      'SELECT phone, normalized_phone, has_valid_identity, identity_number, identity_path FROM guests WHERE id = $1',
      [guestIdKtp]
    );
    const checkResKtpAfterPatch = await client.query(
      'SELECT guest_phone, has_valid_identity, identity_number, ktp_path FROM reservations WHERE id = $1',
      [resIdKtp]
    );

    assert.strictEqual(checkGuestKtpAfterPatch.rows[0].phone, '081177776666', 'guests.phone must be updated via PATCH');
    assert.strictEqual(checkGuestKtpAfterPatch.rows[0].has_valid_identity, true, 'CRITICAL: guests.has_valid_identity MUST remain TRUE');
    assert.strictEqual(checkResKtpAfterPatch.rows[0].guest_phone, '081177776666', 'reservations.guest_phone must be updated via PATCH');
    assert.strictEqual(checkResKtpAfterPatch.rows[0].has_valid_identity, true, 'CRITICAL: reservations.has_valid_identity MUST remain TRUE');
    console.log('PASS | Test 8: Phone-only edit strictly preserves has_valid_identity on both tables');

    // =========================================================================
    // Scenario 9: Missing PRIMARY_GUEST relation fails closed (no guessing by phone)
    // =========================================================================
    console.log('Test 9: Missing PRIMARY_GUEST relation fails closed and does not attach arbitrary CRM guest');

    const [ci4, co4] = makeDates(4);
    // Create an unlinked reservation (no reservation_guests entry)
    const bookingOrphanRes = await client.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
       VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
      [tracked.propertyId, `BID-${runId}-ORPHAN`, `Orphan Guest ${runId}`]
    );
    const bookingIdOrphan = Number(bookingOrphanRes.rows[0].id);
    tracked.bookingIds.push(bookingIdOrphan);

    const resOrphan = await client.query(
      `INSERT INTO reservations (
         booking_id, room_id, booked_room_type_id_snapshot, guest_name, guest_phone,
         check_in, check_out, subtotal_amount, total_price, amount_paid, remaining_balance,
         status, payment_status, stay_sequence
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 500000, 500000, 0, 500000, 'BOOKED', 'UNPAID', 1)
       RETURNING id`,
      [bookingIdOrphan, room1.id, room1.room_type_id, `Orphan Guest ${runId}`, '089900001111', ci4, co4]
    );
    const resIdOrphan = Number(resOrphan.rows[0].id);
    tracked.reservationIds.push(resIdOrphan);

    // Create a distinct CRM guest who happens to share the same phone
    const guestCrmRes = await client.query(
      `INSERT INTO guests (full_name, normalized_name, phone, normalized_phone, created_property_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [`Distinct CRM Person ${runId}`, `distinct crm person ${runId}`, '089900001111', '089900001111', tracked.propertyId]
    );
    const guestIdCrm = Number(guestCrmRes.rows[0].id);
    tracked.guestIds.push(guestIdCrm);

    // Calling syncPrimaryGuestFromReservation on resIdOrphan MUST fail closed
    let orphanSyncFailed = false;
    try {
      await syncPrimaryGuestFromReservation(client, resIdOrphan, {
        guestPhone: '089900001111',
        propertyId: tracked.propertyId,
        relationSource: 'TEST'
      });
    } catch (err) {
      if (err.code === 'PRIMARY_GUEST_RELATION_MISSING') {
        orphanSyncFailed = true;
      } else {
        throw err;
      }
    }
    assert(orphanSyncFailed, 'syncPrimaryGuestFromReservation MUST throw PRIMARY_GUEST_RELATION_MISSING when relation does not exist');

    // Confirm that the CRM guest was NOT attached to resIdOrphan
    const checkLinks = await client.query('SELECT * FROM reservation_guests WHERE reservation_id = $1', [resIdOrphan]);
    assert.strictEqual(checkLinks.rowCount, 0, 'No reservation_guests record should be arbitrarily created');
    console.log('PASS | Test 9: Missing PRIMARY_GUEST relation fails closed; no ambiguous guest linking');

    // =========================================================================
    // Scenario 10: Failure in canonical sync propagates to caller
    // =========================================================================
    console.log('Test 10: Failure in canonical sync throws and propagates as required');

    let errorThrown = false;
    try {
      const mockFailingClient = {
        query: async () => {
          throw new Error('SIMULATED_DB_FAILURE_DURING_SYNC');
        }
      };
      await syncPrimaryGuestFromReservation(mockFailingClient, resIdRoom1, {
        guestPhone: '08123456789',
        propertyId: tracked.propertyId
      });
    } catch (err) {
      if (err.message === 'SIMULATED_DB_FAILURE_DURING_SYNC') {
        errorThrown = true;
      } else {
        throw err;
      }
    }
    assert(errorThrown, 'syncPrimaryGuestFromReservation MUST propagate errors to the caller');
    console.log('PASS | Test 10: Failure in canonical sync throws and propagates as required');

  } finally {
    server.close();
    client.release();
    await cleanup();
    await pool.end();
  }

  console.log('ALL CANONICAL GUEST PHONE SYNC TESTS PASSED');
}

run().catch((err) => {
  console.error('FAIL | canonical_guest_phone_sync_test failed:', err);
  process.exit(1);
});

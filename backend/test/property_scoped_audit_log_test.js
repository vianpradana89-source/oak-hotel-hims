'use strict';

require('dotenv').config({ path: 'E:/oak-hotel-hims/backend/.env' });
const http = require('http');
const { once } = require('events');
const { app, pool } = require('../dist/index');
const { initializeDatabase } = require('../dist/db/schema_v3');

let server;
let baseUrl;
let passed = 0;
let failed = 0;

function expect(condition, msg) {
  if (condition) {
    passed += 1;
    console.log('PASS | ' + msg);
  } else {
    failed += 1;
    console.error('FAIL | ' + msg);
  }
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const res = await fetch(baseUrl + path, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// ─── FIXTURE STATE ──────────────────────────────────────────────────────────

let propIdA;
let propIdB;
let categoryIdA;
let roomTypeIdA;
let roomTypeIdA2;
let roomIdA1;
let roomIdA2;
let createdBookingIdA;
let createdResIdA;
let createdBookingBidA;

async function cleanupPropertiesByName(client, pattern) {
  const props = await client.query('SELECT id FROM properties WHERE name LIKE $1', [pattern]);
  if (props.rowCount === 0) return;
  const pids = props.rows.map((r) => r.id);

  await client.query('DELETE FROM audit_logs WHERE property_id = ANY($1)', [pids]);
  await client.query(
    'DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = ANY($1)))',
    [pids]
  );
  await client.query(
    'DELETE FROM folio_entries WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = ANY($1)))',
    [pids]
  );
  await client.query(
    'DELETE FROM availability_dates WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id = ANY($1))',
    [pids]
  );
  await client.query(
    'DELETE FROM availability_locks WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id = ANY($1))',
    [pids]
  );
  await client.query(
    'DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = ANY($1))',
    [pids]
  );
  await client.query('DELETE FROM bookings WHERE property_id = ANY($1)', [pids]);
  await client.query('DELETE FROM rooms WHERE property_id = ANY($1)', [pids]);
  await client.query('DELETE FROM room_types WHERE property_id = ANY($1)', [pids]);
  await client.query('DELETE FROM room_categories WHERE property_id = ANY($1)', [pids]);
  await client.query('DELETE FROM properties WHERE id = ANY($1)', [pids]);
}

async function setupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Clean any prior dangling test properties
    await cleanupPropertiesByName(client, 'Audit Prop %');

    const suffix = Math.floor(100 + Math.random() * 900);
    const codeA = `A${suffix}A`;
    const codeB = `A${suffix}B`;

    // Two test properties
    const propA = await client.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('Audit Prop A', $1, 'Asia/Jakarta', 'IDR', 'Address A', TRUE) RETURNING id",
      [codeA]
    );
    const propB = await client.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('Audit Prop B', $1, 'Asia/Jakarta', 'IDR', 'Address B', TRUE) RETURNING id",
      [codeB]
    );

    propIdA = propA.rows[0].id;
    propIdB = propB.rows[0].id;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function seedAvailability(typeId, typeName) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dates = [];
    for (let day = 1; day <= 20; day++) {
      const d = day < 10 ? `0${day}` : `${day}`;
      dates.push(`2026-09-${d}`);
    }
    for (const d of dates) {
      await client.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES ($1, $2, $3, 5, 0)`,
        [typeId, typeName, d]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function cleanupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await cleanupPropertiesByName(client, 'Audit Prop %');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Cleanup error:', err);
  } finally {
    client.release();
  }
}

async function runTests() {
  console.log('=== Starting Property-Scoped Audit Log Tests ===\n');

  await initializeDatabase(pool);
  await setupFixtures();

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  try {
    // ─── 1. ROOM MASTER AUDIT LOGS ──────────────────────────────────────────

    // A. Create Room Category -> verify audit log has property_id
    const catRes = await api('POST', '/api/room-categories', {
      property_id: propIdA,
      code: 'AUDCAT1',
      name: 'Audit Category 1',
      display_order: 1
    });
    expect(catRes.status === 201, '1A: Create Room Category returns 201');
    categoryIdA = catRes.json.data.id;

    const catAudit = await pool.query(
      "SELECT * FROM audit_logs WHERE entity = 'ROOM_CATEGORY' AND record_id = $1 AND property_id = $2",
      [String(categoryIdA), propIdA]
    );
    expect(catAudit.rowCount === 1, '1B: Room Category CREATE audit log has property_id = propIdA');
    expect(catAudit.rows[0].property_id === propIdA, '1C: Room Category CREATE audit property_id strictly matches');

    // B. Update Room Category -> verify audit log has property_id
    const catUpd = await api('PATCH', `/api/room-categories/${categoryIdA}?property_id=${propIdA}`, {
      name: 'Audit Category 1 Updated'
    });
    expect(catUpd.status === 200, '1D: Update Room Category returns 200');
    const catUpdAudit = await pool.query(
      "SELECT * FROM audit_logs WHERE entity = 'ROOM_CATEGORY' AND record_id = $1 AND action = 'UPDATE'",
      [String(categoryIdA)]
    );
    expect(catUpdAudit.rowCount === 1, '1E: Room Category UPDATE audit log exists');
    expect(catUpdAudit.rows[0].property_id === propIdA, '1F: Room Category UPDATE audit log has property_id = propIdA');

    // C. Create Room Type -> verify audit log has property_id
    const rtRes = await api('POST', '/api/room-types', {
      property_id: propIdA,
      room_category_id: categoryIdA,
      code: 'AUDRT1',
      name: 'Audit Room Type 1',
      base_rate: 450000,
      capacity: 2
    });
    expect(rtRes.status === 201, '1G: Create Room Type returns 201');
    roomTypeIdA = rtRes.json.data.id;

    const rtAudit = await pool.query(
      "SELECT * FROM audit_logs WHERE entity = 'ROOM_TYPE' AND record_id = $1 AND action = 'CREATE'",
      [String(roomTypeIdA)]
    );
    expect(rtAudit.rowCount === 1, '1H: Room Type CREATE audit log exists');
    expect(rtAudit.rows[0].property_id === propIdA, '1I: Room Type CREATE audit log has property_id = propIdA');

    // Create a 2nd Room Type for move tests
    const rtRes2 = await api('POST', '/api/room-types', {
      property_id: propIdA,
      room_category_id: categoryIdA,
      code: 'AUDRT2',
      name: 'Audit Room Type 2',
      base_rate: 550000,
      capacity: 2
    });
    expect(rtRes2.status === 201, '1J: Create 2nd Room Type returns 201');
    roomTypeIdA2 = rtRes2.json.data.id;

    // Seed availability dates for test room types
    await seedAvailability(roomTypeIdA, 'Audit Room Type 1');
    await seedAvailability(roomTypeIdA2, 'Audit Room Type 2');

    // D. Create Room -> verify audit log has property_id
    const roomRes1 = await api('POST', '/api/rooms', {
      property_id: propIdA,
      room_type_id: roomTypeIdA,
      room_number: 'AUD101',
      floor: '1'
    });
    expect(roomRes1.status === 201, '1K: Create Room 101 returns 201');
    roomIdA1 = roomRes1.json.data.id;

    const roomAudit1 = await pool.query(
      "SELECT * FROM audit_logs WHERE entity = 'ROOM' AND record_id = $1 AND action = 'CREATE'",
      [String(roomIdA1)]
    );
    expect(roomAudit1.rowCount === 1, '1L: Room CREATE audit log exists');
    expect(roomAudit1.rows[0].property_id === propIdA, '1M: Room CREATE audit log has property_id = propIdA');

    const roomRes2 = await api('POST', '/api/rooms', {
      property_id: propIdA,
      room_type_id: roomTypeIdA2,
      room_number: 'AUD102',
      floor: '1'
    });
    expect(roomRes2.status === 201, '1N: Create Room 102 returns 201');
    roomIdA2 = roomRes2.json.data.id;

    // ─── 2. OPERATIONAL BOOKING & RESERVATION AUDIT LOGS ─────────────────────

    // A. Create Booking + Reservation via POST /api/bookings
    const bookingPayload = {
      property_id: propIdA,
      guest_name: 'Audit Guest Alpha',
      booking_source: 'WALKIN',
      channel: 'FRONT_DESK',
      reservations: [
        {
          room_id: roomIdA1,
          guest_name: 'Audit Guest Alpha',
          guest_phone: '08123456789',
          guest_segment: 'Reguler',
          check_in: '2026-09-01',
          check_out: '2026-09-04',
          total_price: 1350000,
          amount_paid: 0,
          payment_status: 'UNPAID',
          booking_type: 'walkin'
        }
      ]
    };

    const bookRes = await api('POST', '/api/bookings', bookingPayload);
    if (bookRes.status !== 201) {
      console.error('2A FAILED: bookRes =', bookRes);
    }
    expect(bookRes.status === 201, '2A: POST /api/bookings returns 201');
    createdBookingIdA = bookRes.json?.data?.booking_id;
    createdBookingBidA = bookRes.json?.data?.bid;
    createdResIdA = bookRes.json?.data?.reservations?.[0]?.id;

    // Check BOOKING audit log
    const bookingAudit = await pool.query(
      "SELECT * FROM audit_logs WHERE entity = 'BOOKING' AND record_id = $1 AND action = 'CREATE'",
      [String(createdBookingIdA)]
    );
    expect(bookingAudit.rowCount === 1, '2B: BOOKING CREATE audit log exists');
    expect(bookingAudit.rows[0].property_id === propIdA, '2C: BOOKING CREATE audit log has property_id = propIdA');

    // Check RESERVATION audit log
    const resAudit = await pool.query(
      "SELECT * FROM audit_logs WHERE entity = 'RESERVATION' AND record_id = $1 AND action = 'CREATE'",
      [String(createdResIdA)]
    );
    expect(resAudit.rowCount === 1, '2D: RESERVATION CREATE audit log exists');
    expect(resAudit.rows[0].property_id === propIdA, '2E: RESERVATION CREATE audit log has property_id = propIdA');

    // B. PATCH /api/reservations/:id -> verify audit log has property_id
    const patchRes = await api('PATCH', `/api/reservations/${createdResIdA}`, {
      guest_name: 'Audit Guest Alpha Updated'
    });
    expect(patchRes.status === 200, '2F: PATCH /api/reservations/:id returns 200');
    const patchAudit = await pool.query(
      "SELECT * FROM audit_logs WHERE entity = 'RESERVATION' AND record_id = $1 AND action = 'UPDATE'",
      [String(createdResIdA)]
    );
    expect(patchAudit.rowCount === 1, '2G: RESERVATION UPDATE audit log exists');
    expect(patchAudit.rows[0].property_id === propIdA, '2H: RESERVATION UPDATE audit log has property_id = propIdA');

    // C. PATCH /api/rooms/:id/status -> verify audit log has property_id
    const roomStatRes = await api('PATCH', `/api/rooms/${roomIdA1}/status`, {
      property_id: propIdA,
      status: 'VACANT_CLEAN'
    });
    expect(roomStatRes.status === 200, '2I: PATCH /api/rooms/:id/status returns 200');
    const roomStatAudit = await pool.query(
      "SELECT * FROM audit_logs WHERE entity = 'ROOM' AND record_id = $1 AND action = 'UPDATE_STATUS'",
      [String(roomIdA1)]
    );
    expect(roomStatAudit.rowCount === 1, '2J: ROOM UPDATE_STATUS audit log exists');
    expect(roomStatAudit.rows[0].property_id === propIdA, '2K: ROOM UPDATE_STATUS audit log has property_id = propIdA');

    // D. POST /api/reservations/:id/extend -> verify audit log has property_id
    const extendRes = await api('POST', `/api/reservations/${createdResIdA}/extend`, {
      property_id: propIdA,
      new_check_out: '2026-09-05'
    });
    expect(extendRes.status === 200, '2L: POST /api/reservations/:id/extend returns 200');
    const extendAudit = await pool.query(
      "SELECT * FROM audit_logs WHERE entity = 'RESERVATION' AND record_id = $1 AND action = 'EXTEND'",
      [String(createdResIdA)]
    );
    expect(extendAudit.rowCount === 1, '2M: RESERVATION EXTEND audit log exists');
    expect(extendAudit.rows[0].property_id === propIdA, '2N: RESERVATION EXTEND audit log has property_id = propIdA');

    // E. POST /api/reservations/:id/shorten -> verify audit log has property_id
    const shortenRes = await api('POST', `/api/reservations/${createdResIdA}/shorten`, {
      property_id: propIdA,
      new_check_out: '2026-09-04'
    });
    expect(shortenRes.status === 200, '2O: POST /api/reservations/:id/shorten returns 200');
    const shortenAudit = await pool.query(
      "SELECT * FROM audit_logs WHERE entity = 'RESERVATION' AND record_id = $1 AND action = 'SHORTEN'",
      [String(createdResIdA)]
    );
    expect(shortenAudit.rowCount === 1, '2P: RESERVATION SHORTEN audit log exists');
    expect(shortenAudit.rows[0].property_id === propIdA, '2Q: RESERVATION SHORTEN audit log has property_id = propIdA');

    // F. POST /api/reservations/:id/move -> verify audit log has property_id
    const moveRes = await api('POST', `/api/reservations/${createdResIdA}/move`, {
      property_id: propIdA,
      to_room_id: roomIdA2
    });
    expect(moveRes.status === 200, '2R: POST /api/reservations/:id/move returns 200');
    const moveAudit = await pool.query(
      "SELECT * FROM audit_logs WHERE entity = 'RESERVATION' AND record_id = $1 AND action = 'MOVE'",
      [String(createdResIdA)]
    );
    expect(moveAudit.rowCount === 1, '2S: RESERVATION MOVE audit log exists');
    expect(moveAudit.rows[0].property_id === propIdA, '2T: RESERVATION MOVE audit log has property_id = propIdA');

    // G. POST /api/reservations/:id/checkin -> verify audit log has property_id
    const checkinRes = await api('POST', `/api/reservations/${createdResIdA}/checkin`, {
      property_id: propIdA
    });
    expect(checkinRes.status === 200, '2U: POST /api/reservations/:id/checkin returns 200');
    const checkinAudit = await pool.query(
      "SELECT * FROM audit_logs WHERE entity = 'RESERVATION' AND record_id = $1 AND action = 'CHECK_IN'",
      [String(createdResIdA)]
    );
    expect(checkinAudit.rowCount === 1, '2V: RESERVATION CHECK_IN audit log exists');
    expect(checkinAudit.rows[0].property_id === propIdA, '2W: RESERVATION CHECK_IN audit log has property_id = propIdA');

    // H. POST /api/reservations/:id/checkout -> verify audit log for checkout and booking completion
    const checkoutRes = await api('POST', `/api/reservations/${createdResIdA}/checkout`, {
      property_id: propIdA
    });
    expect(checkoutRes.status === 200, '2X: POST /api/reservations/:id/checkout returns 200');
    const checkoutAudit = await pool.query(
      "SELECT * FROM audit_logs WHERE entity = 'RESERVATION' AND record_id = $1 AND action = 'CHECK_OUT'",
      [String(createdResIdA)]
    );
    expect(checkoutAudit.rowCount === 1, '2Y: RESERVATION CHECK_OUT audit log exists');
    expect(checkoutAudit.rows[0].property_id === propIdA, '2Z: RESERVATION CHECK_OUT audit log has property_id = propIdA');

    const completeAudit = await pool.query(
      "SELECT * FROM audit_logs WHERE entity = 'BOOKING' AND record_id = $1 AND action = 'COMPLETE'",
      [String(createdBookingIdA)]
    );
    expect(completeAudit.rowCount === 1, '2AA: BOOKING COMPLETE audit log exists');
    expect(completeAudit.rows[0].property_id === propIdA, '2AB: BOOKING COMPLETE audit log has property_id = propIdA');

    // ─── 3. AUDIT LOG READ ENDPOINTS & ISOLATION ────────────────────────────

    // A. GET /api/reservations/:id/audit with matching property -> 200 and returns logs
    const resAuditGetA = await api('GET', `/api/reservations/${createdResIdA}/audit?property_id=${propIdA}`);
    expect(resAuditGetA.status === 200, '3A: GET /api/reservations/:id/audit with matching property returns 200');
    expect(Array.isArray(resAuditGetA.json?.data) && resAuditGetA.json.data.length > 0, '3B: returned audit logs list is non-empty');
    const allResMatch = resAuditGetA.json?.data?.every((row) => row.property_id === propIdA);
    expect(allResMatch, '3C: all returned reservation audit logs strictly have property_id = propIdA');

    // B. GET /api/reservations/:id/audit with mismatched property -> 403
    const resAuditGetB = await api('GET', `/api/reservations/${createdResIdA}/audit?property_id=${propIdB}`);
    expect(resAuditGetB.status === 403, '3D: GET /api/reservations/:id/audit with mismatched property rejected with 403');
    expect(resAuditGetB.json?.code === 'PROPERTY_MISMATCH', '3E: error code is PROPERTY_MISMATCH');

    // C. GET /api/rooms/:id/audit with matching property -> 200 and returns logs
    const roomAuditGetA = await api('GET', `/api/rooms/${roomIdA1}/audit?property_id=${propIdA}`);
    expect(roomAuditGetA.status === 200, '3F: GET /api/rooms/:id/audit with matching property returns 200');
    expect(Array.isArray(roomAuditGetA.json?.data) && roomAuditGetA.json.data.length > 0, '3G: returned room audit logs list is non-empty');
    const allRoomMatch = roomAuditGetA.json?.data?.every((row) => row.property_id === propIdA);
    expect(allRoomMatch, '3H: all returned room audit logs strictly have property_id = propIdA');

    // D. GET /api/rooms/:id/audit with mismatched property -> 403
    const roomAuditGetB = await api('GET', `/api/rooms/${roomIdA1}/audit?property_id=${propIdB}`);
    expect(roomAuditGetB.status === 403, '3I: GET /api/rooms/:id/audit with mismatched property rejected with 403');
    expect(roomAuditGetB.json?.code === 'PROPERTY_MISMATCH', '3J: error code is PROPERTY_MISMATCH');

    // ─── 4. CANCEL AUDIT LOGS ───────────────────────────────────────────────

    // Create a 2nd booking to test reservation cancellation
    const cancelBookingPayload = {
      property_id: propIdA,
      guest_name: 'Audit Guest Beta',
      booking_source: 'WALKIN',
      channel: 'FRONT_DESK',
      reservations: [
        {
          room_id: roomIdA1,
          guest_name: 'Audit Guest Beta',
          check_in: '2026-09-10',
          check_out: '2026-09-12',
          total_price: 900000,
          amount_paid: 0,
          payment_status: 'UNPAID',
          booking_type: 'walkin'
        }
      ]
    };
    const bookCancelRes = await api('POST', '/api/bookings', cancelBookingPayload);
    const cancelResId = bookCancelRes.json?.data?.reservations?.[0]?.id;

    // Cancel reservation -> verify audit log has property_id
    const cancelResCall = await api('POST', `/api/reservations/${cancelResId}/cancel`, {
      property_id: propIdA
    });
    expect(cancelResCall.status === 200, '4A: POST /api/reservations/:id/cancel returns 200');
    const cancelAudit = await pool.query(
      "SELECT * FROM audit_logs WHERE entity = 'RESERVATION' AND record_id = $1 AND action = 'CANCEL'",
      [String(cancelResId)]
    );
    expect(cancelAudit.rowCount === 1, '4B: RESERVATION CANCEL audit log exists');
    expect(cancelAudit.rows[0].property_id === propIdA, '4C: RESERVATION CANCEL audit log has property_id = propIdA');

    // Reset room status to VACANT_CLEAN for booking
    await api('PATCH', `/api/rooms/${roomIdA2}/status`, {
      property_id: propIdA,
      status: 'VACANT_CLEAN'
    });

    // Create a 3rd booking to test booking-level cancellation via POST /api/bookings/:bid/cancel
    const cancelBookingPayload3 = {
      property_id: propIdA,
      guest_name: 'Audit Guest Gamma',
      booking_source: 'WALKIN',
      channel: 'FRONT_DESK',
      reservations: [
        {
          room_id: roomIdA2,
          guest_name: 'Audit Guest Gamma',
          check_in: '2026-09-15',
          check_out: '2026-09-17',
          total_price: 1100000,
          amount_paid: 0,
          payment_status: 'UNPAID',
          booking_type: 'walkin'
        }
      ]
    };
    const bookCancelRes3 = await api('POST', '/api/bookings', cancelBookingPayload3);
    const cancelBookingBid3 = bookCancelRes3.json?.data?.bid;
    const cancelBookingId3 = bookCancelRes3.json?.data?.booking_id;

    if (bookCancelRes3.status !== 201) {
      console.error('bookCancelRes3 FAILED:', bookCancelRes3);
    }
    // Cancel booking via POST /api/bookings/:bid/cancel
    const cancelBookingCall = await api('POST', `/api/bookings/${cancelBookingBid3}/cancel`, {
      property_id: propIdA
    });
    if (cancelBookingCall.status !== 200) {
      console.error('4D FAILED: cancelBookingCall =', cancelBookingCall);
    }
    expect(cancelBookingCall.status === 200, '4D: POST /api/bookings/:bid/cancel returns 200');
    const cancelBookingAudit = await pool.query(
      "SELECT * FROM audit_logs WHERE entity = 'BOOKING' AND record_id = $1 AND action = 'CANCEL'",
      [String(cancelBookingId3)]
    );
    expect(cancelBookingAudit.rowCount === 1, '4E: BOOKING CANCEL audit log exists');
    expect(cancelBookingAudit.rows[0].property_id === propIdA, '4F: BOOKING CANCEL audit log has property_id = propIdA');

  } finally {
    if (server) {
      server.close();
      await once(server, 'close');
    }
    console.log('\n--- Cleaning up Fixtures ---');
    await cleanupFixtures();
  }

  // ─── 5. ZERO FIXTURE RESIDUE CHECK ───────────────────────────────────────
  const resProp = await pool.query('SELECT COUNT(*)::int AS count FROM properties WHERE id IN ($1, $2)', [propIdA, propIdB]);
  expect(resProp.rows[0].count === 0, '5A: zero test properties residue');

  const resAuditResidue = await pool.query('SELECT COUNT(*)::int AS count FROM audit_logs WHERE property_id IN ($1, $2)', [propIdA, propIdB]);
  expect(resAuditResidue.rows[0].count === 0, '5B: zero test audit_logs residue');

  console.log(`\nProperty-scoped audit log tests: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

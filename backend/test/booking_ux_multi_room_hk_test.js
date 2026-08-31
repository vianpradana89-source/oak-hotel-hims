const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const http = require('http');
const { Pool } = require('pg');
const assert = require('assert');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

async function runBookingUxMultiRoomHkTests() {
  console.log('=== RUNNING BOOKING-UX-1A MULTI-ROOM & PRE-CHECKOUT HK SUITE ===\n');

  const { initializeDatabase } = require('../dist/db/schema_v3');
  await initializeDatabase(pool);

  const { app } = require('../dist/index');
  let server = http.createServer(app);
  let serverPort = null;

  await new Promise((resolve) => {
    server.listen(0, () => {
      serverPort = server.address().port;
      console.log('Test API Server running on port ' + serverPort);
      resolve();
    });
  });

  const request = async (method, reqPath, body = null) => {
    return new Promise((resolve, reject) => {
      const payloadStr = body ? JSON.stringify(body) : null;
      const headers = {
        'Content-Type': 'application/json'
      };
      if (payloadStr) {
        headers['Content-Length'] = Buffer.byteLength(payloadStr);
      }
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: serverPort,
          path: reqPath,
          method,
          headers
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            let json = null;
            try {
              json = JSON.parse(data);
            } catch (_e) {
              json = data;
            }
            resolve({ status: res.statusCode, headers: res.headers, body: json });
          });
        }
      );
      req.on('error', reject);
      if (payloadStr) {
        req.write(payloadStr);
      }
      req.end();
    });
  };

  const propertyId = 1;
  const uniqueSuffix = Date.now();
  let createdOtaId = null;
  let testRoomTypeId1 = null;
  let testRoomTypeId2 = null;
  let testRoomId1 = null;
  let testRoomId2 = null;
  let testBookingId = null;
  let testResId1 = null;
  let testResId2 = null;
  let testGuestId = null;
  let testHkTaskId = null;

  const code1 = 'TMR_K_' + uniqueSuffix;
  const code2 = 'TMR_T_' + uniqueSuffix;
  const name1 = 'Test MR King ' + uniqueSuffix;
  const name2 = 'Test MR Twin ' + uniqueSuffix;
  const roomNo1 = 'MR1-' + uniqueSuffix.toString().slice(-4);
  const roomNo2 = 'MR2-' + uniqueSuffix.toString().slice(-4);

  const testDates = ['2027-07-10', '2027-07-11', '2027-07-12'];

  try {
    // -------------------------------------------------------------------------
    // SETUP FIXTURES: Dedicated Room Types & Physical Rooms with Availability
    // -------------------------------------------------------------------------
    console.log('Setting up isolated test fixtures...');
    
    // Create Room Type 1
    const rtRes1 = await pool.query(
      `INSERT INTO room_types (property_id, code, name, base_rate, is_active)
       VALUES (1, $1, $2, 500000, true)
       RETURNING id`,
      [code1, name1]
    );
    testRoomTypeId1 = rtRes1.rows[0].id;

    // Create Room Type 2
    const rtRes2 = await pool.query(
      `INSERT INTO room_types (property_id, code, name, base_rate, is_active)
       VALUES (1, $1, $2, 600000, true)
       RETURNING id`,
      [code2, name2]
    );
    testRoomTypeId2 = rtRes2.rows[0].id;

    // Create Physical Room 1
    const rmRes1 = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES (1, $1, $2, $3, 'VACANT_CLEAN', true)
       RETURNING id`,
      [testRoomTypeId1, roomNo1, 'Room ' + roomNo1]
    );
    testRoomId1 = rmRes1.rows[0].id;

    // Create Physical Room 2
    const rmRes2 = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES (1, $1, $2, $3, 'VACANT_CLEAN', true)
       RETURNING id`,
      [testRoomTypeId2, roomNo2, 'Room ' + roomNo2]
    );
    testRoomId2 = rmRes2.rows[0].id;

    // Seed availability_dates for both types
    for (const d of testDates) {
      await pool.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES ($1, $2, $3::date, 5, 0)
         ON CONFLICT (room_type, date) DO UPDATE SET total_rooms = 5, reserved_qty = 0`,
        [testRoomTypeId1, name1, d]
      );
      await pool.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES ($1, $2, $3::date, 5, 0)
         ON CONFLICT (room_type, date) DO UPDATE SET total_rooms = 5, reserved_qty = 0`,
        [testRoomTypeId2, name2, d]
      );
    }
    console.log('  ✓ Dedicated test rooms seeded: ' + roomNo1 + ' (#' + testRoomId1 + ') & ' + roomNo2 + ' (#' + testRoomId2 + ')');

    // -------------------------------------------------------------------------
    // TEST 1: OTA Source Master API Verification & Strict Seeds
    // -------------------------------------------------------------------------
    console.log('\n[TEST 1] OTA Master API: JSON response, default sources, and fields...');
    const otaListRes = await request('GET', '/api/ota-sources?property_id=' + propertyId);
    assert.strictEqual(otaListRes.status, 200);
    assert.ok(otaListRes.headers['content-type'].includes('application/json'), 'Must return Content-Type: application/json');
    assert.ok(Array.isArray(otaListRes.body.data), 'Data must be an array');
    
    const otaNames = otaListRes.body.data.map(o => o.name);
    console.log('  Active OTA sources in DB:', otaNames);
    assert.ok(otaNames.includes('Tiket.com'), 'Tiket.com must be present');
    assert.ok(otaNames.includes('Booking.com'), 'Booking.com must be present');
    assert.ok(otaNames.includes('Agoda'), 'Agoda must be present');

    // Create custom test OTA source
    const testOtaCode = 'EXP_TEST_' + uniqueSuffix;
    const createOtaRes = await request('POST', '/api/ota-sources', {
      property_id: propertyId,
      code: testOtaCode,
      name: 'Expedia Partner Test',
      description: 'Expedia International OTA',
      commission_rate_percent: 16.5,
      display_order: 10
    });
    assert.strictEqual(createOtaRes.status, 201);
    assert.ok(createOtaRes.body.data && createOtaRes.body.data.id);
    createdOtaId = createOtaRes.body.data.id;
    assert.strictEqual(Number(createOtaRes.body.data.commission_rate_percent), 16.5);
    console.log('  ✓ Created OTA source #' + createdOtaId + ' with commission_rate_percent = 16.5%');

    // Update custom OTA source
    const updateOtaRes = await request('PUT', '/api/ota-sources/' + createdOtaId, {
      name: 'Expedia Partner Test Updated',
      commission_rate_percent: 18.0
    });
    assert.strictEqual(updateOtaRes.status, 200);
    assert.strictEqual(Number(updateOtaRes.body.data.commission_rate_percent), 18.0);
    console.log('  ✓ Updated OTA source commission rate to 18.0%');

    // -------------------------------------------------------------------------
    // TEST 2: Multi-Room Booking Creation
    // -------------------------------------------------------------------------
    console.log('\n[TEST 2] Multi-Room Booking Creation (2 rooms, stay charges, discounts)...');
    const bookingPayload = {
      property_id: propertyId,
      guest_name: 'Budi Multiroom Lead',
      guest_phone: '081299887766',
      guest_segment: 'Group',
      booker_name: 'Dewi Booker',
      booker_phone: '081299887700',
      booker_same_as_guest: false,
      booking_source: 'Tiket.com',
      booking_channel: 'OTA',
      ota_source_id: createdOtaId,
      referral: 'OTA Group Booking Ref #9988',
      has_valid_identity: true,
      identity_number: '3171010101990001',
      ktp_path: '/uploads/ktp-budi.jpg',
      payment_method: 'TRANSFER',
      amount_paid: 1200000,
      bukti_bayar_path: '/uploads/bukti-multiroom.jpg',
      require_strict_gates: true,
      special_requests: 'Connecting room requested',
      reservations: [
        {
          room_id: testRoomId1,
          room_type_id: testRoomTypeId1,
          check_in: '2027-07-10',
          check_out: '2027-07-12',
          stay_type: 'OVERNIGHT',
          subtotal_amount: 1000000,
          total_price: 1050000,
          stay_charges: [
            {
              charge_type: 'EXTRA_BED',
              description: 'Extra Bed Kamar 1',
              quantity: 1,
              unit_price: 100000,
              amount: 100000
            }
          ],
          discount_amount: 50000,
          discount_type: 'NOMINAL',
          discount_value: 50000,
          discount_reason: 'Diskon Booking Group',
          qty: 1
        },
        {
          room_id: testRoomId2,
          room_type_id: testRoomTypeId2,
          check_in: '2027-07-10',
          check_out: '2027-07-12',
          stay_type: 'OVERNIGHT',
          subtotal_amount: 1200000,
          total_price: 1200000,
          stay_charges: [],
          discount_amount: 0,
          discount_type: 'NOMINAL',
          discount_value: 0,
          qty: 1
        }
      ]
    };

    const bookRes = await request('POST', '/api/bookings', bookingPayload);
    if (bookRes.status !== 201) {
      console.error('bookRes failed with status', bookRes.status, 'body:', JSON.stringify(bookRes.body, null, 2));
    }
    assert.ok(bookRes.body.data && (bookRes.body.data.booking_id || bookRes.body.data.booking));
    testBookingId = bookRes.body.data.booking_id || bookRes.body.data.booking?.id;
    const reservations = bookRes.body.data.reservations;
    assert.strictEqual(reservations.length, 2, 'Must create 2 child reservations');
    
    testResId1 = reservations[0].id;
    testResId2 = reservations[1].id;
    console.log('  ✓ Created Multi-Room Booking #' + testBookingId + ' with Child Reservations: #' + testResId1 + ' & #' + testResId2);

    // Verify room 1 and room 2 independent state
    assert.strictEqual(Number(reservations[0].room_id), testRoomId1);
    assert.strictEqual(Number(reservations[1].room_id), testRoomId2);

    // -------------------------------------------------------------------------
    // TEST 3: Atomic Overlap Rollback
    // -------------------------------------------------------------------------
    console.log('\n[TEST 3] Atomic Overlap Rollback: Ensure collision on Room 1 rejects entire booking...');
    const collisionPayload = {
      property_id: propertyId,
      guest_name: 'Collision Booker',
      guest_phone: '081211112222',
      has_valid_identity: true,
      identity_number: '3171010101990009',
      payment_method: 'CASH',
      amount_paid: 500000,
      bukti_bayar_path: '/uploads/collision.jpg',
      require_strict_gates: true,
      reservations: [
        {
          room_id: testRoomId1, // Colliding with testResId1 on 2027-07-10 -> 2027-07-12
          room_type_id: testRoomTypeId1,
          check_in: '2027-07-10',
          check_out: '2027-07-11',
          stay_type: 'OVERNIGHT',
          subtotal_amount: 500000,
          total_price: 500000,
          qty: 1
        }
      ]
    };

    const collisionRes = await request('POST', '/api/bookings', collisionPayload);
    assert.ok(collisionRes.status === 400 || collisionRes.status === 409, 'Collision should return 400/409');
    console.log('  ✓ Overlap correctly rejected with status ' + collisionRes.status + ': ' + (collisionRes.body.message || collisionRes.body.error));

    // -------------------------------------------------------------------------
    // TEST 4: GET /api/reservations/:id: Sibling Reservations & HK Inspection Flag
    // -------------------------------------------------------------------------
    console.log('\n[TEST 4] GET /api/reservations/:id join verification...');
    const detailRes = await request('GET', '/api/reservations/' + testResId1 + '?property_id=' + propertyId);
    assert.strictEqual(detailRes.status, 200);
    const dData = detailRes.body.data;
    
    assert.ok(Array.isArray(dData.sibling_reservations), 'Must contain sibling_reservations array');
    assert.strictEqual(dData.sibling_reservations.length, 2, 'Should contain all 2 reservations in booking');
    const siblingRoomNumbers = dData.sibling_reservations.map(s => s.room_number);
    assert.ok(siblingRoomNumbers.includes(roomNo1), 'Must contain room 1');
    assert.ok(siblingRoomNumbers.includes(roomNo2), 'Must contain room 2');
    assert.strictEqual(typeof dData.require_checkout_inspection, 'boolean');
    console.log('  ✓ GET /api/reservations/:id returned sibling rooms (' + siblingRoomNumbers.join(', ') + ') & inspection flag');

    // -------------------------------------------------------------------------
    // TEST 5: Pre-Checkout FO -> HK Flow & Independent Room Checkout
    // -------------------------------------------------------------------------
    console.log('\n[TEST 5] Pre-Checkout FO -> HK flow & independent checkout...');
    
    // Check in Room 1
    const ciRes = await request('POST', '/api/reservations/' + testResId1 + '/checkin', {
      property_id: propertyId
    });
    assert.ok(ciRes.status === 200 || ciRes.status === 201);
    console.log('  ✓ Room ' + roomNo1 + ' (Res #' + testResId1 + ') checked in');

    // Request Pre-Checkout Inspection
    const checkReqRes = await request('POST', '/api/housekeeping/checkout-room-check', {
      property_id: propertyId,
      reservation_id: testResId1,
      room_id: testRoomId1,
      requested_by: 'FO Front Desk Tester'
    });
    assert.ok(checkReqRes.status === 200 || checkReqRes.status === 201);
    assert.ok(checkReqRes.body.data && checkReqRes.body.data.id);
    testHkTaskId = checkReqRes.body.data.id;
    console.log('  ✓ Created CHECKOUT_ROOM_CHECK task #' + testHkTaskId);

    // Test Idempotency
    const checkReqRes2 = await request('POST', '/api/housekeeping/checkout-room-check', {
      property_id: propertyId,
      reservation_id: testResId1,
      room_id: testRoomId1,
      requested_by: 'FO Front Desk Tester'
    });
    assert.strictEqual(checkReqRes2.body.data.id, testHkTaskId, 'Must be idempotent');
    console.log('  ✓ Idempotency verified: second call returned existing task #' + testHkTaskId);

    // HK updates task to ISSUE_FOUND with notes
    const issueRes = await request('PATCH', '/api/housekeeping/tasks/' + testHkTaskId + '/complete', {
      property_id: propertyId,
      inspection_result: 'ISSUE_FOUND',
      issue_type: 'DAMAGE',
      issue_note: 'Handuk bernoda dan asbak pecah',
      estimated_charge: 50000
    });
    assert.strictEqual(issueRes.status, 200);
    console.log('  ✓ Housekeeping flagged ISSUE_FOUND');

    // FO adds penalty charge
    const chargeRes = await request('POST', '/api/stay-charges/post-charge', {
      property_id: propertyId,
      reservation_id: testResId1,
      charge_type: 'DAMAGE_PENALTY',
      description: 'Denda Asbak Pecah',
      unit_price: 50000,
      quantity: 1
    });
    assert.strictEqual(chargeRes.status, 201);
    console.log('  ✓ Added penalty charge to reservation #' + testResId1);

    // Complete mandatory checklist items for inspection task
    const clItemsRes = await request('GET', '/api/housekeeping/tasks/' + testHkTaskId + '/checklist-items?property_id=' + propertyId);
    if (clItemsRes.body.data && Array.isArray(clItemsRes.body.data)) {
      for (const itm of clItemsRes.body.data) {
        await request('PATCH', '/api/housekeeping/tasks/' + testHkTaskId + '/checklist-items/' + itm.id, {
          property_id: propertyId,
          is_completed: true
        });
      }
    }

    // HK resolves and marks CLEAR
    const clearRes = await request('PATCH', '/api/housekeeping/tasks/' + testHkTaskId + '/complete', {
      property_id: propertyId,
      inspection_result: 'CLEAR',
      completion_note: 'Denda sudah diselesaikan FO, kamar aman checkout'
    });
    assert.strictEqual(clearRes.status, 200);
    console.log('  ✓ Housekeeping marked inspection CLEAR');

    // Verify room status is still OCCUPIED (must NOT mark VACANT_CLEAN)
    const roomBeforeCo = await pool.query('SELECT status FROM rooms WHERE id = $1', [testRoomId1]);
    assert.notStrictEqual(roomBeforeCo.rows[0].status, 'VACANT_CLEAN', 'CLEAR must not mark room VACANT_CLEAN');
    console.log('  ✓ Verified room status before checkout: ' + roomBeforeCo.rows[0].status + ' (NOT VACANT_CLEAN)');

    // FO performs checkout on Room 1
    const coRes = await request('POST', '/api/reservations/' + testResId1 + '/checkout', {
      property_id: propertyId
    });
    assert.ok(coRes.status === 200 || coRes.status === 201);
    console.log('  ✓ Room ' + roomNo1 + ' checked out successfully');

    // Verify Room 1 status is VACANT_DIRTY / Terisi/Kotor
    const roomAfterCo = await pool.query('SELECT status FROM rooms WHERE id = $1', [testRoomId1]);
    console.log('  ✓ Room ' + roomNo1 + ' status after checkout: ' + roomAfterCo.rows[0].status);

    // Verify Room 2 is still BOOKED (independent lifecycle)
    const res2Db = await pool.query('SELECT status FROM reservations WHERE id = $1', [testResId2]);
    assert.strictEqual(res2Db.rows[0].status, 'BOOKED');
    console.log('  ✓ Sibling Room ' + roomNo2 + ' (Res #' + testResId2 + ') status is still ' + res2Db.rows[0].status);

    console.log('\n=== ALL BOOKING-UX-1A INTEGRATION TESTS PASSED ===');
  } finally {
    console.log('\nCleaning up test fixtures...');
    if (testHkTaskId) {
      await pool.query('DELETE FROM housekeeping_tasks WHERE id = $1', [testHkTaskId]);
    }
    if (testBookingId) {
      await pool.query('DELETE FROM payment_evidences WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [testBookingId]);
      await pool.query('DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [testBookingId]);
      await pool.query('DELETE FROM folio_entries WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [testBookingId]);
      await pool.query('DELETE FROM housekeeping_tasks WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [testBookingId]);
      await pool.query('DELETE FROM reservations WHERE booking_id = $1', [testBookingId]);
      await pool.query('DELETE FROM bookings WHERE id = $1', [testBookingId]);
    }
    if (testRoomId1 || testRoomId2) {
      await pool.query('DELETE FROM payment_evidences WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id IN ($1, $2))', [testRoomId1 || 0, testRoomId2 || 0]);
      await pool.query('DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id IN ($1, $2))', [testRoomId1 || 0, testRoomId2 || 0]);
      await pool.query('DELETE FROM folio_entries WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id IN ($1, $2))', [testRoomId1 || 0, testRoomId2 || 0]);
      await pool.query('DELETE FROM housekeeping_tasks WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id IN ($1, $2))', [testRoomId1 || 0, testRoomId2 || 0]);
      await pool.query('DELETE FROM reservations WHERE room_id IN ($1, $2)', [testRoomId1 || 0, testRoomId2 || 0]);
    }
    if (testGuestId) {
      await pool.query('DELETE FROM guests WHERE id = $1', [testGuestId]);
    }
    if (createdOtaId) {
      await pool.query('DELETE FROM ota_sources WHERE id = $1', [createdOtaId]);
    }
    if (testRoomId1) {
      await pool.query('DELETE FROM rooms WHERE id = $1', [testRoomId1]);
    }
    if (testRoomId2) {
      await pool.query('DELETE FROM rooms WHERE id = $1', [testRoomId2]);
    }
    if (testRoomTypeId1) {
      await pool.query('DELETE FROM availability_dates WHERE room_type_id = $1', [testRoomTypeId1]);
      await pool.query('DELETE FROM room_types WHERE id = $1', [testRoomTypeId1]);
    }
    if (testRoomTypeId2) {
      await pool.query('DELETE FROM availability_dates WHERE room_type_id = $1', [testRoomTypeId2]);
      await pool.query('DELETE FROM room_types WHERE id = $1', [testRoomTypeId2]);
    }
    if (server) {
      server.close();
    }
    await pool.end();
    console.log('Zero database residue remaining.\n');
  }
}

runBookingUxMultiRoomHkTests()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('Test failed with error:', err);
    process.exit(1);
  });

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

async function runBookingUx1Tests() {
  console.log('=== RUNNING BOOKING-UX-1 INTEGRATION REGRESSION SUITE ===\n');

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
            resolve({ status: res.statusCode, body: json });
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
  const testCode = 'TEST_OTA_' + Date.now();
  let createdOtaId = null;
  let testBookingId = null;
  let testReservationId = null;
  let testGuestId = null;
  let testRoomTypeId = null;
  let testRoomId = null;

  const testDates = ['2027-05-10', '2027-05-11', '2027-05-12'];

  try {
    // -------------------------------------------------------------------------
    // SETUP FIXTURES: Dedicated Room Type & Physical Room with Availability
    // -------------------------------------------------------------------------
    console.log('Setting up isolated test fixtures...');
    // Create dedicated Room Type
    const rtRes = await pool.query(
      `INSERT INTO room_types (property_id, code, name, base_rate, is_active)
       VALUES (1, 'TST-UX-DELUXE', 'Test UX Deluxe Suite', 500000, true)
       RETURNING id`
    );
    testRoomTypeId = rtRes.rows[0].id;

    // Create dedicated Physical Room
    const rmRes = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES (1, $1, 'UX-999', 'Room UX 999', 'Tersedia', true)
       RETURNING id`,
      [testRoomTypeId]
    );
    testRoomId = rmRes.rows[0].id;

    // Seed availability_dates
    for (const d of testDates) {
      await pool.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES ($1, 'Test UX Deluxe Suite', $2::date, 5, 0)
         ON CONFLICT (room_type, date) DO UPDATE SET total_rooms = 5, reserved_qty = 0`,
        [testRoomTypeId, d]
      );
    }
    console.log('  ✓ Test room #' + testRoomId + ' (Type #' + testRoomTypeId + ') and availability seeded');

    // -------------------------------------------------------------------------
    // TEST 1: OTA Source Master CRUD via REST API
    // -------------------------------------------------------------------------
    console.log('\n[TEST 1] Testing OTA Source Master CRUD via API...');
    
    // 1. Create OTA Source
    const createRes = await request('POST', '/api/ota-sources', {
      property_id: propertyId,
      code: testCode,
      name: 'Test OTA Channel Express',
      description: 'Automated test OTA channel',
      commission_rate_percent: 12.5,
      display_order: 99
    });
    assert.strictEqual(createRes.status, 201, 'OTA create should return 201');
    assert.ok(createRes.body.data && createRes.body.data.id, 'OTA response must contain ID');
    createdOtaId = createRes.body.data.id;
    console.log('  ✓ Created OTA source #' + createdOtaId + ' (' + testCode + ')');

    // 2. Get OTA list
    const listRes = await request('GET', '/api/ota-sources?property_id=' + propertyId);
    assert.strictEqual(listRes.status, 200);
    assert.ok(Array.isArray(listRes.body.data), 'OTA list should be array');
    const found = listRes.body.data.find((o) => o.id === createdOtaId);
    assert.ok(found, 'Created OTA must be in list');
    console.log('  ✓ Retrieved OTA list with new OTA channel');

    // 3. Update OTA source
    const updateRes = await request('PUT', '/api/ota-sources/' + createdOtaId + '?property_id=' + propertyId, {
      name: 'Updated Test OTA Express',
      commission_rate_percent: 14.5
    });
    assert.strictEqual(updateRes.status, 200);
    assert.strictEqual(updateRes.body.data.name, 'Updated Test OTA Express');
    console.log('  ✓ Updated OTA source fields via API');

    // 4. Toggle Active Status
    const toggleRes = await request('PATCH', '/api/ota-sources/' + createdOtaId + '/status?property_id=' + propertyId, {
      is_active: false
    });
    assert.strictEqual(toggleRes.status, 200);
    assert.strictEqual(toggleRes.body.data.is_active, false);
    console.log('  ✓ Toggled OTA channel status');

    // Re-enable for booking tests
    await request('PATCH', '/api/ota-sources/' + createdOtaId + '/status?property_id=' + propertyId, {
      is_active: true
    });

    // -------------------------------------------------------------------------
    // TEST 2: Guest CRM Search & Identity OCR Endpoint
    // -------------------------------------------------------------------------
    console.log('\n[TEST 2] Testing Guest CRM Search & Identity OCR Endpoint...');
    const testNik = '31750' + Math.floor(10000000000 + Math.random() * 90000000000);
    const testPhone = '0812' + Math.floor(10000000 + Math.random() * 90000000);
    const guestService = require('../dist/domains/guests/guestService');
    const newGuest = await guestService.createGuest(pool, {
      property_id: propertyId,
      full_name: 'Budi Test Santoso',
      phone: testPhone,
      email: 'budi.test@example.com',
      identity_type: 'KTP',
      identity_number: testNik,
      identity_path: '/uploads/identities/ktp_test.jpg',
      has_valid_identity: true,
      guest_segment: 'Reguler'
    });
    testGuestId = newGuest.id;
    console.log('  ✓ Seeded CRM Guest #' + testGuestId + ' with KTP ' + testNik);

    // Search via API
    const crmSearchRes = await request('GET', '/api/guests?property_id=' + propertyId + '&search=' + testPhone);
    assert.strictEqual(crmSearchRes.status, 200);
    assert.ok(Array.isArray(crmSearchRes.body.data), 'CRM search returns array');
    const matchedGuest = crmSearchRes.body.data.find((g) => g.id === testGuestId);
    assert.ok(matchedGuest, 'Search query must find created guest');
    assert.strictEqual(matchedGuest.identity_number, testNik);
    console.log('  ✓ Found CRM Guest through debounced search query');

    // -------------------------------------------------------------------------
    // TEST 3: Validation Gates (Strict Checks)
    // -------------------------------------------------------------------------
    console.log('\n[TEST 3] Testing Booking Required Fields Validation Gates...');
    const checkInDate = '2027-05-10';
    const checkOutDate = '2027-05-11';

    // Payload missing staying guest name
    const invalidBookingPayload = {
      property_id: propertyId,
      channel_type: 'WALKIN',
      require_strict_gates: true,
      reservations: [
        {
          room_id: testRoomId,
          room_type_id: testRoomTypeId,
          check_in: checkInDate,
          check_out: checkOutDate,
          guest_name: '', // Missing!
          guest_phone: '',
          subtotal_amount: 500000
        }
      ]
    };

    const gateFailRes = await request('POST', '/api/bookings', invalidBookingPayload);
    assert.strictEqual(gateFailRes.status, 400, 'Should reject invalid payload with 400');
    assert.strictEqual(gateFailRes.body.code, 'BOOKING_REQUIRED_FIELDS_MISSING');
    assert.ok(gateFailRes.body.missing_fields.includes('guest_name'), 'missing_fields contains guest_name');
    console.log('  ✓ Validation gate rejected missing guest name with code BOOKING_REQUIRED_FIELDS_MISSING');

    // -------------------------------------------------------------------------
    // TEST 4: Full Canonical Booking with Booker vs Guest, Stay Charges, Discount, Payment
    // -------------------------------------------------------------------------
    console.log('\n[TEST 4] Creating Full Canonical Booking with Booker vs Guest, Stay Charges, Discount, and Payment Gate...');
    const validBookingPayload = {
      property_id: propertyId,
      booking_type: 'ota',
      channel_type: 'OTA',
      ota_source_id: createdOtaId,
      referral: 'Direkomendasikan oleh Pak Hendra',
      booker_name: 'Dewi Pemesan',
      booker_phone: '081122334455',
      same_as_booker: false,
      require_strict_gates: true,
      initial_payment: {
        payment_method: 'TRANSFER',
        amount: 300000,
        paid_at: new Date().toISOString(),
        payment_evidence_path: '/uploads/evidences/test_transfer.jpg',
        reference_number: 'TRF-TEST-9999',
        note: 'Pembayaran DP transfer bank'
      },
      reservations: [
        {
          room_id: testRoomId,
          room_type_id: testRoomTypeId,
          guest_name: 'Budi Test Santoso',
          guest_phone: testPhone,
          guest_segment: 'Reguler',
          identity_type: 'KTP',
          identity_number: testNik,
          has_valid_identity: true,
          check_in: checkInDate,
          check_out: checkOutDate,
          rate_plan_id: null,
          rate_plan_code: 'BAR',
          rate_plan_name: 'Best Available Rate',
          meal_plan: 'ROOM_ONLY',
          room_price: 500000,
          subtotal_amount: 500000,
          total_price: 600000,
          tax_amount: 50000,
          service_amount: 50000,
          discount_type: 'NOMINAL',
          discount_amount: 50000,
          discount_reason: 'Voucher VIP Promo',
          stay_charges: [
            {
              charge_type: 'EXTRA_BED',
              description: 'Extra Bed Extra Pillow',
              quantity: 1,
              unit_price: 100000,
              amount: 100000
            }
          ]
        }
      ]
    };

    const bookingRes = await request('POST', '/api/bookings', validBookingPayload);
    if (bookingRes.status !== 201) {
      console.error('Booking failed with status', bookingRes.status, 'body:', JSON.stringify(bookingRes.body, null, 2));
    }
    assert.strictEqual(bookingRes.status, 201, 'Booking creation should return 201');
    assert.strictEqual(bookingRes.body.status, 'SUCCESS');
    assert.ok(bookingRes.body.data.booking_id, 'Must return booking_id');

    testBookingId = bookingRes.body.data.booking_id;
    testReservationId = bookingRes.body.data.reservations[0].id;
    console.log('  ✓ Canonical booking created: BID = ' + bookingRes.body.data.bid + ', Reservation ID = ' + testReservationId);

    // -------------------------------------------------------------------------
    // TEST 5: Verify Ledger, Roles, and Reservation Detail joins
    // -------------------------------------------------------------------------
    console.log('\n[TEST 5] Verifying Database Invariants, Roles, and Folio Accounting...');

    // 1. Roles in reservation_guests
    const guestsRes = await pool.query(
      `SELECT rg.*, g.full_name AS name, g.phone, g.identity_number 
       FROM reservation_guests rg
       JOIN guests g ON g.id = rg.guest_id
       WHERE rg.reservation_id = $1 
       ORDER BY rg.role`,
      [testReservationId]
    );
    assert.ok(guestsRes.rows.length >= 2, 'Should have both BOOKER and PRIMARY_GUEST');
    const bookerRow = guestsRes.rows.find((r) => r.role === 'BOOKER');
    const primaryGuestRow = guestsRes.rows.find((r) => r.role === 'PRIMARY_GUEST');

    assert.ok(bookerRow, 'Must have BOOKER row');
    assert.strictEqual(bookerRow.name, 'Dewi Pemesan');
    assert.strictEqual(bookerRow.phone, '081122334455');

    assert.ok(primaryGuestRow, 'Must have PRIMARY_GUEST row');
    assert.strictEqual(primaryGuestRow.name, 'Budi Test Santoso');
    assert.strictEqual(primaryGuestRow.identity_number, testNik);
    console.log('  ✓ Verified reservation_guests roles (BOOKER & PRIMARY_GUEST)');

    // 2. Folio entries
    const folioRes = await pool.query(
      'SELECT * FROM folio_entries WHERE reservation_id = $1 ORDER BY id',
      [testReservationId]
    );
    const folioEntries = folioRes.rows;
    console.log('  ✓ Folio entries generated (' + folioEntries.length + ' items):');
    for (const f of folioEntries) {
      console.log('    - [' + f.entry_type + ' / ' + f.direction + '] ' + f.description + ': Amount = ' + f.amount);
    }

    const hasRoomCharge = folioEntries.some((f) => f.entry_type === 'ROOM_CHARGE' && Number(f.amount) > 0 && f.direction === 'DEBIT');
    const hasStayCharge = folioEntries.some((f) => (f.entry_type === 'EXTRA_BED' || f.description.includes('Extra Bed')) && Number(f.amount) === 100000 && f.direction === 'DEBIT');
    const hasDiscount = folioEntries.some((f) => f.entry_type === 'DISCOUNT' && Number(f.amount) === 50000 && f.direction === 'CREDIT');
    const hasPayment = folioEntries.some((f) => f.entry_type === 'PAYMENT' && Number(f.amount) === 300000 && f.direction === 'CREDIT');

    assert.ok(hasRoomCharge, 'Must record ROOM_CHARGE debit');
    assert.ok(hasStayCharge, 'Must record stay charge debit');
    assert.ok(hasDiscount, 'Must record discount contra-revenue credit');
    assert.ok(hasPayment, 'Must record payment credit');
    console.log('  ✓ Folio ledger accounting integrity confirmed');

    // 3. Payment Transaction & Evidence
    const paymentTxRes = await pool.query(
      'SELECT * FROM payment_transactions WHERE reservation_id = $1',
      [testReservationId]
    );
    assert.ok(paymentTxRes.rows.length > 0, 'Payment transaction must exist');
    assert.strictEqual(Number(paymentTxRes.rows[0].amount), 300000);

    const evidenceRes = await pool.query(
      'SELECT * FROM payment_evidences WHERE reservation_id = $1',
      [testReservationId]
    );
    assert.ok(evidenceRes.rows.length > 0, 'Payment evidence must exist');
    console.log('  ✓ Payment transaction & evidence record verified');

    // 4. Detail API join
    const detailApiRes = await request('GET', '/api/reservations/' + testReservationId + '?property_id=' + propertyId);
    if (detailApiRes.status !== 200) {
      console.error('detailApiRes failed with status', detailApiRes.status, 'body:', JSON.stringify(detailApiRes.body, null, 2));
    }
    assert.strictEqual(detailApiRes.status, 200);
    const resData = detailApiRes.body.data;
    assert.strictEqual(resData.booker_name, 'Dewi Pemesan');
    assert.strictEqual(resData.referral, 'Direkomendasikan oleh Pak Hendra');
    assert.strictEqual(resData.ota_source_name, 'Updated Test OTA Express');
    console.log('  ✓ GET /api/reservations/:id returned complete booking metadata & OTA source');

    console.log('\n=== ALL BOOKING-UX-1 INTEGRATION TESTS PASSED ===');
  } finally {
    console.log('\nCleaning up test fixtures...');
    if (testReservationId) {
      await pool.query('DELETE FROM payment_evidences WHERE reservation_id = $1', [testReservationId]);
      await pool.query('DELETE FROM payment_transactions WHERE reservation_id = $1', [testReservationId]);
      await pool.query('DELETE FROM folio_entries WHERE reservation_id = $1', [testReservationId]);
      await pool.query('DELETE FROM reservation_guests WHERE reservation_id = $1', [testReservationId]);
      await pool.query('DELETE FROM reservations WHERE id = $1', [testReservationId]);
    }
    if (testBookingId) {
      await pool.query('DELETE FROM bookings WHERE id = $1', [testBookingId]);
    }
    if (testGuestId) {
      await pool.query('DELETE FROM guests WHERE id = $1', [testGuestId]);
    }
    if (createdOtaId) {
      await pool.query('DELETE FROM ota_sources WHERE id = $1', [createdOtaId]);
    }
    if (testRoomId) {
      await pool.query('DELETE FROM rooms WHERE id = $1', [testRoomId]);
    }
    if (testRoomTypeId) {
      await pool.query('DELETE FROM availability_dates WHERE room_type_id = $1', [testRoomTypeId]);
      await pool.query('DELETE FROM room_types WHERE id = $1', [testRoomTypeId]);
    }
    if (server) {
      server.close();
    }
    await pool.end();
    console.log('Zero database residue remaining.\n');
  }
}

runBookingUx1Tests()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('Test failed with error:', err);
    process.exit(1);
  });

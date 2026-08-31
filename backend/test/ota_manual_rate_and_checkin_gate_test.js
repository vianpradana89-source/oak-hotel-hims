const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Pool } = require('pg');
const http = require('http');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

async function run() {
  console.log('=== Starting OTA Manual Rate & Pre-Check-in Gate Integration Test ===\n');

  let testBookingId = null;
  let testReservationId = null;
  let testRoomId = null;
  let originalRoomStatus = null;
  let server = null;
  let port = null;

  try {
    const { initializeDatabase } = require('../dist/db/schema_v3');
    await initializeDatabase(pool);

    // Step 1: Verify Schema Columns on reservations table
    console.log('1. Checking reservations schema for identity_number and has_valid_identity...');
    const colCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'reservations' 
        AND column_name IN ('identity_number', 'has_valid_identity')
    `);
    const colNames = colCheck.rows.map(r => r.column_name);
    if (!colNames.includes('identity_number') || !colNames.includes('has_valid_identity')) {
      throw new Error(`Missing columns on reservations table! Found: ${JSON.stringify(colNames)}`);
    }
    console.log('✓ Columns identity_number and has_valid_identity are verified present.');

    // Step 2: Start test server instance with Express app
    console.log('\n2. Starting local Express test server instance...');
    const { app } = require('../dist/index');
    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, () => {
        port = server.address().port;
        console.log(`✓ Test server listening on port ${port}`);
        resolve();
      });
    });

    // Helper request function
    const makeRequest = (method, path, body = null) => {
      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: port,
          path: path,
          method: method,
          headers: {
            'Content-Type': 'application/json'
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            try {
              const json = data ? JSON.parse(data) : {};
              resolve({ status: res.statusCode, body: json });
            } catch (e) {
              resolve({ status: res.statusCode, raw: data });
            }
          });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
      });
    };

    // Get a room without active checked-in reservation for testing
    const roomRes = await pool.query(`
      SELECT r.id, r.room_number, r.room_type_id, r.property_id, r.status 
      FROM rooms r 
      WHERE r.id NOT IN (
        SELECT res.room_id FROM reservations res WHERE res.status = 'CHECKED_IN' AND res.room_id IS NOT NULL
      )
      ORDER BY r.id ASC 
      LIMIT 1
    `);
    if (roomRes.rows.length === 0) {
      throw new Error('No unoccupied room found in DB to perform test!');
    }
    const testRoom = roomRes.rows[0];
    testRoomId = testRoom.id;
    originalRoomStatus = testRoom.status;
    // Temporarily ensure room status is VACANT_CLEAN or AVAILABLE
    await pool.query(`UPDATE rooms SET status = 'VACANT_CLEAN' WHERE id = $1`, [testRoom.id]);
    console.log(`✓ Using test room #${testRoom.room_number} (ID: ${testRoom.id})`);

    // Step 3: Test Booking Creation with OTA Channel & Manual Room Rate
    console.log('\n3. Creating OTA booking with manual room rate...');
    const createBookingRes = await makeRequest('POST', '/api/bookings', {
      property_id: testRoom.property_id || 1,
      booking_type: 'OTA',
      guest_name: 'TEST TAMU OTA KHUSUS',
      guest_phone: '', // Intentionally empty phone to test pre-checkin gate
      amount_paid: 0,
      payment_method: 'TRANSFER',
      reservations: [
        {
          room_id: testRoom.id,
          room_type_id: testRoom.room_type_id,
          guest_name: 'TEST TAMU OTA KHUSUS',
          guest_phone: '', // Missing phone initially
          booking_channel: 'OTA',
          check_in: '2026-11-10',
          check_out: '2026-11-12',
          stay_type: 'OVERNIGHT',
          is_manual_override: true,
          manual_override_reason: 'OTA: Traveloka Voucher TVL-99881',
          subtotal_amount: 350000,
          total_price: 350000,
          amount_paid: 0,
          payment_status: 'UNPAID'
        }
      ]
    });

    if (createBookingRes.status !== 200 && createBookingRes.status !== 201) {
      throw new Error(`Failed to create OTA booking: ${JSON.stringify(createBookingRes)}`);
    }

    testBookingId = createBookingRes.body.booking_id || createBookingRes.body.data?.booking_id || createBookingRes.body.id || createBookingRes.body.booking?.id;
    console.log(`✓ Created test booking ID: ${testBookingId}`);

    // Retrieve created reservation
    const rCheck = await pool.query(`
      SELECT id, status, guest_name, guest_phone, is_manual_override, manual_override_reason, total_price, identity_number, has_valid_identity
      FROM reservations 
      WHERE booking_id = $1 
      LIMIT 1
    `, [testBookingId]);

    if (rCheck.rows.length === 0) {
      throw new Error(`Reservation not found in DB for booking_id: ${testBookingId}`);
    }

    testReservationId = rCheck.rows[0].id;
    const resRow = rCheck.rows[0];
    console.log('✓ Stored reservation details:', {
      id: resRow.id,
      guest_name: resRow.guest_name,
      guest_phone: resRow.guest_phone,
      is_manual_override: resRow.is_manual_override,
      manual_override_reason: resRow.manual_override_reason,
      total_price: resRow.total_price
    });

    if (!resRow.is_manual_override || !resRow.manual_override_reason.includes('Traveloka')) {
      throw new Error(`Manual override rate was not properly saved! Row: ${JSON.stringify(resRow)}`);
    }

    // Step 4: Test Pre-Check-in Gate (Must FAIL because Phone & KTP are missing)
    console.log('\n4. Testing pre-check-in validation gate without Phone & KTP...');
    const checkinFailRes = await makeRequest('POST', `/api/reservations/${testReservationId}/checkin`, {
      property_id: testRoom.property_id || 1
    });

    console.log(`Checkin attempt response status: ${checkinFailRes.status}`, checkinFailRes.body);
    if (checkinFailRes.status !== 400 || checkinFailRes.body.code !== 'CHECKIN_REQUIREMENTS_NOT_MET') {
      throw new Error(`Expected check-in to be rejected with 400 CHECKIN_REQUIREMENTS_NOT_MET, but got: ${JSON.stringify(checkinFailRes)}`);
    }
    if (!checkinFailRes.body.missing_fields || !checkinFailRes.body.missing_fields.phone || !checkinFailRes.body.missing_fields.identity) {
      throw new Error(`Expected missing phone and identity indicators in response, got: ${JSON.stringify(checkinFailRes.body)}`);
    }
    console.log('✓ Pre-checkin gate successfully blocked check-in due to missing Phone and KTP.');

    // Step 5: Test updating reservation with Phone & KTP/Identity via PATCH
    console.log('\n5. Updating reservation with Guest Phone and KTP (NIK)...');
    const patchRes = await makeRequest('PATCH', `/api/reservations/${testReservationId}`, {
      property_id: testRoom.property_id || 1,
      guest_phone: '081234567890',
      identity_number: '3171012345670001',
      ktp_path: '/uploads/ktp/ktp_test_ota_gate.jpg',
      has_valid_identity: true
    });

    if (patchRes.status !== 200 || (patchRes.body.status !== 'SUCCESS' && !patchRes.body.success)) {
      throw new Error(`Failed to PATCH reservation: ${JSON.stringify(patchRes)}`);
    }
    console.log('✓ Reservation updated via PATCH.');

    // Verify reservation DB state after PATCH
    const afterPatch = await pool.query(`
      SELECT id, guest_phone, identity_number, ktp_path, has_valid_identity 
      FROM reservations 
      WHERE id = $1
    `, [testReservationId]);
    console.log('✓ DB state after PATCH:', afterPatch.rows[0]);

    if (afterPatch.rows[0].guest_phone !== '081234567890' || afterPatch.rows[0].identity_number !== '3171012345670001') {
      throw new Error('PATCH did not persist phone and identity_number correctly in reservations table!');
    }

    // Step 6: Test Check-in again (Must SUCCEED now that Phone & KTP are provided)
    console.log('\n6. Retrying check-in now that Phone & KTP are provided...');
    const checkinSuccessRes = await makeRequest('POST', `/api/reservations/${testReservationId}/checkin`, {
      property_id: testRoom.property_id || 1
    });

    if (checkinSuccessRes.status !== 200 || (!checkinSuccessRes.body.success && checkinSuccessRes.body.status !== 'SUCCESS')) {
      throw new Error(`Expected check-in to succeed, but got: ${JSON.stringify(checkinSuccessRes)}`);
    }
    console.log('✓ Check-in succeeded successfully:', checkinSuccessRes.body.message);

    // Verify reservation status is CHECKED_IN
    const finalResCheck = await pool.query(`SELECT status FROM reservations WHERE id = $1`, [testReservationId]);
    if (finalResCheck.rows[0].status !== 'CHECKED_IN') {
      throw new Error(`Expected reservation status to be CHECKED_IN, got: ${finalResCheck.rows[0].status}`);
    }
    console.log('✓ Reservation status in DB is confirmed CHECKED_IN.');

    console.log('\n=== All Tests Passed Successfully! ===');

  } catch (err) {
    console.error('❌ Test Failed:', err);
    process.exitCode = 1;
  } finally {
    console.log('\nCleaning up fixtures...');
    if (testRoomId && originalRoomStatus) {
      await pool.query(`UPDATE rooms SET status = $1 WHERE id = $2`, [originalRoomStatus, testRoomId]).catch(() => {});
    }
    if (testReservationId) {
      await pool.query(`DELETE FROM room_inventory_ledger WHERE reservation_id = $1`, [testReservationId]).catch(() => {});
      await pool.query(`DELETE FROM folio_entries WHERE reservation_id = $1`, [testReservationId]).catch(() => {});
      await pool.query(`DELETE FROM reservation_charges WHERE reservation_id = $1`, [testReservationId]).catch(() => {});
      await pool.query(`DELETE FROM reservation_guests WHERE reservation_id = $1`, [testReservationId]).catch(() => {});
      await pool.query(`DELETE FROM reservations WHERE id = $1`, [testReservationId]).catch(() => {});
    }
    if (testBookingId) {
      await pool.query(`DELETE FROM bookings WHERE id = $1`, [testBookingId]).catch(() => {});
    }
    const { reconcileCanonicalAvailability } = require('../dist/domains/inventory/canonicalReconciliation');
    await reconcileCanonicalAvailability(pool).catch(() => {});
    if (server) {
      server.close();
    }
    await pool.end();
    console.log('Cleanup complete.');
  }
}

run();

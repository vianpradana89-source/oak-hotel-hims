#!/usr/bin/env node
'use strict';

const http = require('http');
const { Pool } = require('pg');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log('PASS | ' + label);
  } else {
    failed += 1;
    console.log('FAIL | ' + label);
  }
}

function makeRequest(server, options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (_) {
          json = data;
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function main() {
  const adminUrl = process.env.TEST_DATABASE_URL
    || ('postgresql://' + (process.env.DB_USER || 'postgres') + ':' + (process.env.DB_PASSWORD || 'secretpassword') + '@' + (process.env.DB_HOST || '127.0.0.1') + ':' + (process.env.DB_PORT || 5432) + '/oak_hotel_db');

  const pool = new Pool({ connectionString: adminUrl });
  const { app } = require('../dist/index');
  const { initializeDatabase } = require('../dist/db/schema_v3');

  await initializeDatabase(pool);

  let server;
  let port;

  const fixtures = {
    propertyId: null,
    roomTypeId: null,
    roomTypeName: null,
    room1Id: null,
    room2Id: null,
    bookings: [],
    reservations: [],
    guests: []
  };

  try {
    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });

    console.log(`CRM-1 Test server listening on port ${port}`);

    // Setup isolated fixtures
    const suffix = Date.now().toString().slice(-6);
    const rnd = Math.floor(Math.random() * 90) + 10;
    const pRes = await pool.query(
      `INSERT INTO properties (property_code, name, address, is_active) VALUES ($1, $2, 'Jl. Test CRM', true) RETURNING id`,
      [`C${rnd}`, `CRM Property ${suffix}`]
    );
    fixtures.propertyId = pRes.rows[0].id;
    fixtures.roomTypeName = `CRM Deluxe ${suffix}`;

    const rtRes = await pool.query(
      `INSERT INTO room_types (property_id, code, name, base_rate, capacity) VALUES ($1, 'DLX', $2, 500000, 2) RETURNING id`,
      [fixtures.propertyId, fixtures.roomTypeName]
    );
    fixtures.roomTypeId = rtRes.rows[0].id;

    // Seed availability_dates for 2026-09-01 through 2026-09-30
    for (let day = 1; day <= 30; day++) {
      const dayStr = day < 10 ? `0${day}` : `${day}`;
      const dateStr = `2026-09-${dayStr}`;
      await pool.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES ($1, $2, $3::date, 5, 0)
         ON CONFLICT (room_type, date) DO UPDATE SET total_rooms = 5, reserved_qty = 0, room_type_id = $1`,
        [fixtures.roomTypeId, fixtures.roomTypeName, dateStr]
      );
    }

    const r1Res = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, floor, status) VALUES ($1, $2, '901', 9, 'VACANT_CLEAN') RETURNING id`,
      [fixtures.propertyId, fixtures.roomTypeId]
    );
    fixtures.room1Id = r1Res.rows[0].id;

    const r2Res = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, floor, status) VALUES ($1, $2, '902', 9, 'VACANT_CLEAN') RETURNING id`,
      [fixtures.propertyId, fixtures.roomTypeId]
    );
    fixtures.room2Id = r2Res.rows[0].id;

    console.log('\n--- TEST 1: CRM Guest Creation & Auto Normalization & Code Generation ---');
    const createGuestRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/guests',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId,
      full_name: 'Budi Santoso',
      phone: '0812-3456-7890',
      email: 'Budi.Santoso@Example.COM',
      identity_type: 'KTP',
      identity_number: '3171-0123-4567-0001',
      guest_segment: 'Corporate',
      preferences: 'High floor, non-smoking'
    });

    console.log('createGuestRes status:', createGuestRes.statusCode, 'body:', createGuestRes.body);
    assert(createGuestRes.statusCode === 201, 'POST /api/guests returns 201 Created');
    const guest1 = createGuestRes.body.data;
    fixtures.guests.push(guest1.id);

    assert(guest1.guest_code && guest1.guest_code.startsWith('GST-'), 'Guest has canonical guest_code (e.g. GST-XXXXX)');
    assert(guest1.normalized_phone === '081234567890', 'Phone is normalized correctly');
    assert(guest1.normalized_email === 'budi.santoso@example.com', 'Email is normalized correctly to lowercase');
    assert(guest1.normalized_identity_number === '3171012345670001', 'NIK is normalized to digits only');
    assert(guest1.guest_segment === 'Corporate', 'Guest segment is preserved');

    console.log('\n--- TEST 2: CRM Multi-Field Autocomplete & Search ---');
    // Search by name
    const searchNameRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/search?property_id=${fixtures.propertyId}&q=budi`,
      method: 'GET'
    });
    assert(searchNameRes.statusCode === 200 && searchNameRes.body.data.some(g => g.id === guest1.id), 'Search by name returns guest');

    // Search by phone
    const searchPhoneRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/search?property_id=${fixtures.propertyId}&q=081234567890`,
      method: 'GET'
    });
    assert(searchPhoneRes.statusCode === 200 && searchPhoneRes.body.data.some(g => g.id === guest1.id), 'Search by phone returns guest');

    // Search by NIK
    const searchNikRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/search?property_id=${fixtures.propertyId}&q=3171012345670001`,
      method: 'GET'
    });
    assert(searchNikRes.statusCode === 200 && searchNikRes.body.data.some(g => g.id === guest1.id), 'Search by NIK returns guest');

    // Search by guest_code
    const searchCodeRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/search?property_id=${fixtures.propertyId}&q=${guest1.guest_code}`,
      method: 'GET'
    });
    assert(searchCodeRes.statusCode === 200 && searchCodeRes.body.data.some(g => g.id === guest1.id), 'Search by guest_code returns guest');

    console.log('\n--- TEST 3: Duplicate Detection Service ---');
    // Exact phone match
    const dupPhoneRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/guests/duplicate-check',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId,
      full_name: 'Budi S.',
      phone: '+62 812-3456-7890'
    });
    assert(dupPhoneRes.statusCode === 200, 'POST /duplicate-check returns 200');
    assert(dupPhoneRes.body.data.has_duplicate === true, 'Duplicate check detects phone match');
    assert(dupPhoneRes.body.data.candidates.some(c => c.match_strength === 'STRONG_PHONE' || c.match_type === 'STRONG_PHONE'), 'Candidate classified as STRONG_PHONE');

    // Exact NIK match
    const dupNikRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/guests/duplicate-check',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId,
      full_name: 'Budi Santoso',
      identity_number: '3171012345670001'
    });
    assert(dupNikRes.body.data.candidates.some(c => c.match_strength === 'STRONG_NIK' || c.match_type === 'STRONG_NIK'), 'Candidate classified as STRONG_NIK');

    console.log('\n--- TEST 4: Quick Booking with Selected Canonical CRM Guest ---');
    const booking1Res = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/bookings',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId,
      guest_id: guest1.id,
      guest_name: 'Budi Santoso',
      guest_phone: '081234567890',
      guest_segment: 'Corporate',
      booking_source: 'Walk-in Direct',
      booking_channel: 'WALK_IN',
      payment_method: 'CASH',
      amount_paid: 500000,
      has_valid_identity: true,
      reservations: [{
        guest_id: guest1.id,
        room_id: fixtures.room1Id,
        room_type_id: fixtures.roomTypeId,
        check_in: '2026-09-01',
        check_out: '2026-09-03',
        total_price: 500000,
        subtotal_amount: 500000,
        amount_paid: 500000,
        payment_status: 'PAID'
      }]
    });

    assert(booking1Res.statusCode === 201, 'Quick Booking with selected guest_id succeeds with 201');
    const b1Data = booking1Res.body.data;
    fixtures.bookings.push(b1Data.booking_id);
    const r1Id = b1Data.reservations[0].id;
    fixtures.reservations.push(r1Id);

    // Verify reservation_guests links PRIMARY_GUEST to canonical guest_id
    const rg1 = await pool.query(
      `SELECT * FROM reservation_guests WHERE reservation_id = $1`,
      [r1Id]
    );
    assert(rg1.rows.length === 1, 'reservation_guests has exactly 1 row');
    assert(rg1.rows[0].guest_id === guest1.id, 'reservation_guests links directly to canonical guest_id');
    assert(rg1.rows[0].role === 'PRIMARY_GUEST', 'Role is PRIMARY_GUEST');

    console.log('\n--- TEST 5: Booker vs Primary Guest Distinction ---');
    const booking2Res = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/bookings',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId,
      guest_id: guest1.id,
      guest_name: 'Budi Santoso',
      guest_phone: '081234567890',
      guest_segment: 'Corporate',
      booker_name: 'PT Maju Bersama',
      booker_phone: '0215551234',
      booker_same_as_guest: false,
      booking_source: 'Corporate Contract',
      booking_channel: 'WALK_IN',
      payment_method: 'TRANSFER',
      amount_paid: 500000,
      has_valid_identity: true,
      reservations: [{
        guest_id: guest1.id,
        room_id: fixtures.room2Id,
        room_type_id: fixtures.roomTypeId,
        check_in: '2026-09-05',
        check_out: '2026-09-07',
        total_price: 500000,
        subtotal_amount: 500000,
        amount_paid: 500000,
        payment_status: 'PAID'
      }]
    });

    assert(booking2Res.statusCode === 201, 'Booking with separate booker succeeds');
    const b2Data = booking2Res.body.data;
    fixtures.bookings.push(b2Data.booking_id);
    const r2Id = b2Data.reservations[0].id;
    fixtures.reservations.push(r2Id);

    const rg2 = await pool.query(
      `SELECT * FROM reservation_guests WHERE reservation_id = $1 ORDER BY role`,
      [r2Id]
    );
    assert(rg2.rows.length === 2, 'reservation_guests has 2 rows for booker + primary guest');
    assert(rg2.rows.some(r => r.role === 'BOOKER'), 'reservation_guests contains BOOKER role');
    assert(rg2.rows.some(r => r.role === 'PRIMARY_GUEST' && r.guest_id === guest1.id), 'reservation_guests contains PRIMARY_GUEST linked to guest1');

    // Mark first reservation as CHECKED_OUT and booking as COMPLETED
    await pool.query(
      `UPDATE reservations SET status = 'CHECKED_OUT' WHERE id = $1`,
      [r1Id]
    );
    await pool.query(
      `UPDATE bookings SET booking_status = 'COMPLETED' WHERE id = $1`,
      [b1Data.booking_id]
    );

    const profileRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/${guest1.id}?property_id=${fixtures.propertyId}`,
      method: 'GET'
    });

    assert(profileRes.statusCode === 200, 'GET /api/guests/:id returns 200');
    const profData = profileRes.body.data;
    assert(profData.visit_count === 1, 'visit_count calculated dynamically from CHECKED_OUT stay (1)');
    assert(profData.room_nights === 2, 'room_nights calculated dynamically from [2026-09-01, 2026-09-03) (2 nights)');
    assert(profData.stays && profData.stays.length >= 2, 'stays history contains all property reservations');

    console.log('\n--- TEST 7: Quick Booking Auto-Creates Canonical Guest with Guest Code & Normalization ---');
    const autoCreateBookingRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/bookings',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId,
      guest_name: 'Siti Aminah',
      guest_phone: '0857-1122-3344',
      guest_segment: 'Reguler',
      booking_source: 'Walk-in Direct',
      booking_channel: 'WALK_IN',
      payment_method: 'CASH',
      amount_paid: 500000,
      has_valid_identity: true,
      reservations: [{
        room_id: fixtures.room1Id,
        room_type_id: fixtures.roomTypeId,
        check_in: '2026-09-10',
        check_out: '2026-09-12',
        total_price: 500000,
        subtotal_amount: 500000,
        amount_paid: 500000,
        payment_status: 'PAID'
      }]
    });

    assert(autoCreateBookingRes.statusCode === 201, 'Quick Booking with new guest succeeds');
    const b3Data = autoCreateBookingRes.body.data;
    fixtures.bookings.push(b3Data.booking_id);
    const r3Id = b3Data.reservations[0].id;
    fixtures.reservations.push(r3Id);

    const rg3 = await pool.query(
      `SELECT * FROM reservation_guests WHERE reservation_id = $1`,
      [r3Id]
    );
    const newGuestId = rg3.rows[0].guest_id;
    fixtures.guests.push(newGuestId);

    const newGuestRow = await pool.query(
      `SELECT * FROM guests WHERE id = $1`,
      [newGuestId]
    );
    const createdGuest = newGuestRow.rows[0];
    assert(createdGuest.full_name === 'Siti Aminah', 'Created guest has correct name');
    assert(createdGuest.normalized_phone === '085711223344', 'Created guest has normalized phone');
    assert(createdGuest.guest_code && createdGuest.guest_code.startsWith('GST-'), 'Created guest was assigned a canonical guest_code');

    console.log('\n--- TEST 8: Archive & Restore Lifecycle ---');
    // Archive guest
    const archiveRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/${createdGuest.id}/archive`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { property_id: fixtures.propertyId });
    assert(archiveRes.statusCode === 200, 'POST /:id/archive returns 200');

    // Search should not return archived guest by default
    const searchArchivedRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/search?property_id=${fixtures.propertyId}&q=aminah`,
      method: 'GET'
    });
    assert(!searchArchivedRes.body.data.some(g => g.id === createdGuest.id), 'Archived guest excluded from default search');

    // Restore guest
    const restoreRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/${createdGuest.id}/restore`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { property_id: fixtures.propertyId });
    assert(restoreRes.statusCode === 200, 'POST /:id/restore returns 200');

    // Search now returns restored guest
    const searchRestoredRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/search?property_id=${fixtures.propertyId}&q=aminah`,
      method: 'GET'
    });
    assert(searchRestoredRes.body.data.some(g => g.id === createdGuest.id), 'Restored guest appears in search');

    console.log('\n--- TEST 9: Deletion Safety: Protected When Reservations Exist (409) ---');
    const deleteGuestWithStaysRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/${guest1.id}?property_id=${fixtures.propertyId}`,
      method: 'DELETE'
    });
    assert(deleteGuestWithStaysRes.statusCode === 409, 'DELETE /api/guests/:id returns 409 Conflict when stay history exists');
    assert(deleteGuestWithStaysRes.body.code === 'GUEST_HAS_STAY_HISTORY', 'Error code is GUEST_HAS_STAY_HISTORY');

    console.log('\n--- TEST 10: Deletion Safety: Allowed When No Stay History Exists ---');
    const createOrphanGuestRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/guests',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId,
      full_name: 'Tamu Tanpa Stay',
      phone: '0899-0000-1111'
    });
    const orphanGuestId = createOrphanGuestRes.body.data.id;

    const deleteOrphanRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/${orphanGuestId}?property_id=${fixtures.propertyId}`,
      method: 'DELETE'
    });
    assert(deleteOrphanRes.statusCode === 200, 'DELETE /api/guests/:id returns 200 for guest without stays');

    console.log('\n--- TEST 11: Multi-Room Quick Booking Links to Canonical Guest ---');
    const multiRoomBookingRes = await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: '/api/bookings',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      property_id: fixtures.propertyId,
      guest_id: guest1.id,
      guest_name: 'Budi Santoso',
      guest_phone: '081234567890',
      guest_segment: 'Corporate',
      booking_source: 'Walk-in Direct',
      booking_channel: 'WALK_IN',
      payment_method: 'CASH',
      amount_paid: 1000000,
      has_valid_identity: true,
      reservations: [
        {
          guest_id: guest1.id,
          room_id: fixtures.room1Id,
          room_type_id: fixtures.roomTypeId,
          check_in: '2026-09-15',
          check_out: '2026-09-16',
          total_price: 500000,
          subtotal_amount: 500000,
          amount_paid: 500000,
          payment_status: 'PAID'
        },
        {
          guest_id: guest1.id,
          room_id: fixtures.room2Id,
          room_type_id: fixtures.roomTypeId,
          check_in: '2026-09-15',
          check_out: '2026-09-16',
          total_price: 500000,
          subtotal_amount: 500000,
          amount_paid: 500000,
          payment_status: 'PAID'
        }
      ]
    });

    assert(multiRoomBookingRes.statusCode === 201, 'Multi-room booking succeeds with 201');
    const multiData = multiRoomBookingRes.body.data;
    fixtures.bookings.push(multiData.booking_id);
    for (const r of multiData.reservations) {
      fixtures.reservations.push(r.id);
      const resGuestCheck = await pool.query(
        `SELECT * FROM reservation_guests WHERE reservation_id = $1 AND role = 'PRIMARY_GUEST'`,
        [r.id]
      );
      assert(resGuestCheck.rows[0].guest_id === guest1.id, `Room reservation ${r.id} correctly links to canonical guest1`);
    }

    console.log('\n--- TEST 12: Reservation Guest Snapshot Preservation on CRM Profile Update ---');
    // Update CRM profile name
    await makeRequest(server, {
      hostname: '127.0.0.1',
      port,
      path: `/api/guests/${guest1.id}?property_id=${fixtures.propertyId}`,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }
    }, {
      full_name: 'Budi Santoso, M.Kom'
    });

    // Check that historical reservation retains original guest_name snapshot
    const histRes = await pool.query(
      `SELECT guest_name FROM reservations WHERE id = $1`,
      [r1Id]
    );
    assert(histRes.rows[0].guest_name === 'Budi Santoso', 'Historical reservation maintains immutable snapshot');

    console.log('\n--- TEST 13: Zero Inventory Drift Check ---');
    const driftCheck = await pool.query(`
      SELECT 
        COUNT(*) as total_rows,
        COUNT(CASE WHEN reserved_qty < 0 THEN 1 END) as negative_qty,
        COUNT(CASE WHEN reserved_qty > total_rooms THEN 1 END) as overflow_qty
      FROM availability_dates
    `);
    assert(Number(driftCheck.rows[0].negative_qty) === 0, 'Zero negative reserved_qty in availability_dates');
    assert(Number(driftCheck.rows[0].overflow_qty) === 0, 'Zero overflow reserved_qty in availability_dates');

  } catch (err) {
    console.error('Test execution error:', err);
    failed += 1;
  } finally {
    // Teardown fixtures
    console.log('\n--- Cleaning up test fixtures ---');
    try {
      if (fixtures.reservations.length > 0) {
        await pool.query(`DELETE FROM payment_transactions WHERE reservation_id = ANY($1)`, [fixtures.reservations]);
        await pool.query(`DELETE FROM folio_entries WHERE reservation_id = ANY($1)`, [fixtures.reservations]);
        await pool.query(`DELETE FROM reservation_guests WHERE reservation_id = ANY($1)`, [fixtures.reservations]);
        await pool.query(`DELETE FROM reservations WHERE id = ANY($1)`, [fixtures.reservations]);
      }
      if (fixtures.bookings.length > 0) {
        await pool.query(`DELETE FROM bookings WHERE id = ANY($1)`, [fixtures.bookings]);
      }
      if (fixtures.guests.length > 0) {
        await pool.query(`DELETE FROM guests WHERE id = ANY($1)`, [fixtures.guests]);
      }
      if (fixtures.room1Id || fixtures.room2Id) {
        await pool.query(`DELETE FROM rooms WHERE id IN ($1, $2)`, [fixtures.room1Id, fixtures.room2Id]);
      }
      if (fixtures.roomTypeId || fixtures.roomTypeName) {
        await pool.query(`DELETE FROM availability_dates WHERE room_type_id = $1 OR room_type = $2`, [fixtures.roomTypeId, fixtures.roomTypeName]);
        if (fixtures.roomTypeId) {
          await pool.query(`DELETE FROM room_types WHERE id = $1`, [fixtures.roomTypeId]);
        }
      }
      if (fixtures.propertyId) {
        const propId = fixtures.propertyId;
        await pool.query(`DELETE FROM meal_plans WHERE property_id = $1`, [propId]);
        await pool.query(`DELETE FROM ota_sources WHERE property_id = $1`, [propId]);
        await pool.query(`DELETE FROM property_day_use_durations WHERE property_id = $1`, [propId]);
        await pool.query(`DELETE FROM property_quick_booking_rules WHERE property_id = $1`, [propId]);
        await pool.query(`DELETE FROM property_pricing_settings WHERE property_id = $1`, [propId]);
        await pool.query(`DELETE FROM property_brandings WHERE property_id = $1`, [propId]);
        await pool.query(`DELETE FROM stay_charge_rules WHERE property_id = $1`, [propId]);
        await pool.query(`DELETE FROM property_housekeeping_settings WHERE property_id = $1`, [propId]);
        await pool.query(`DELETE FROM property_attendance_settings WHERE property_id = $1`, [propId]);
        await pool.query(`DELETE FROM property_features WHERE property_id = $1`, [propId]);
        await pool.query(`DELETE FROM housekeeping_finding_types WHERE property_id = $1`, [propId]);
        await pool.query(`DELETE FROM reservation_nightly_rates WHERE property_id = $1`, [propId]);
        await pool.query(`DELETE FROM audit_logs WHERE property_id = $1`, [propId]);
        await pool.query(`DELETE FROM properties WHERE id = $1`, [propId]);
      }
    } catch (cleanErr) {
      console.warn('Fixture cleanup warning:', cleanErr.message);
    }

    if (server) {
      server.close();
    }
    await pool.end();

    console.log(`\n=============================`);
    console.log(`CRM-1 RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log(`=============================`);

    if (failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  }
}

main();

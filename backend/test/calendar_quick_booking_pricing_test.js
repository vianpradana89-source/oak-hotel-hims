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

async function runTest() {
  console.log('--- STARTING CALENDAR QUICK BOOKING + RATE PLAN INTEGRATION TEST (RATE-1D) ---');
  const client = await pool.connect();
  let server = null;
  let serverPort = null;

  const cleanupIds = {
    propertyId: 1,
    roomTypeIds: [],
    roomIds: [],
    ratePlanIds: [],
    overrideIds: [],
    bookingIds: [],
    reservationIds: []
  };

  try {
    const { initializeDatabase } = require('../dist/db/schema_v3');
    await initializeDatabase(pool);

    // Setup HTTP server for API testing
    const { app } = require('../dist/index');
    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, () => {
        serverPort = server.address().port;
        console.log(`Test API Server running on port ${serverPort}`);
        resolve();
      });
    });

    const request = async (method, reqPath, body = null) => {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: serverPort,
            path: reqPath,
            method,
            headers: {
              'Content-Type': 'application/json'
            }
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              try {
                const parsed = data ? JSON.parse(data) : {};
                resolve({ status: res.statusCode, data: parsed });
              } catch (e) {
                resolve({ status: res.statusCode, raw: data });
              }
            });
          }
        );
        req.on('error', reject);
        if (body) {
          req.write(JSON.stringify(body));
        }
        req.end();
      });
    };

    console.log('1. Setting up test fixtures (Room Types, Rooms, Rate Plans, Meal Plans)...');
    // Pre-cleanup in proper foreign-key order
    await client.query("DELETE FROM payment_evidences WHERE reservation_id IN (SELECT id FROM reservations WHERE guest_name LIKE 'Tamu%' OR guest_name LIKE 'Group Tamu%')");
    await client.query("DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE guest_name LIKE 'Tamu%' OR guest_name LIKE 'Group Tamu%')");
    await client.query("DELETE FROM reservation_guests WHERE reservation_id IN (SELECT id FROM reservations WHERE guest_name LIKE 'Tamu%' OR guest_name LIKE 'Group Tamu%')");
    await client.query("DELETE FROM reservation_nightly_rates WHERE reservation_id IN (SELECT id FROM reservations WHERE guest_name LIKE 'Tamu%' OR guest_name LIKE 'Group Tamu%')");
    await client.query("DELETE FROM availability_locks WHERE reservation_id IN (SELECT id FROM reservations WHERE guest_name LIKE 'Tamu%' OR guest_name LIKE 'Group Tamu%')");
    await client.query("DELETE FROM folio_entries WHERE reservation_id IN (SELECT id FROM reservations WHERE guest_name LIKE 'Tamu%' OR guest_name LIKE 'Group Tamu%')");
    await client.query("DELETE FROM reservations WHERE guest_name LIKE 'Tamu%' OR guest_name LIKE 'Group Tamu%'");
    await client.query("DELETE FROM bookings WHERE guest_name_snapshot LIKE 'Tamu%' OR guest_name_snapshot LIKE 'Group Tamu%'");
    await client.query("DELETE FROM rate_overrides WHERE reason = 'Weekend Surcharge'");
    await client.query("DELETE FROM rate_plans WHERE code IN ('TST-RP-BAR-A', 'TST-RP-DU-A', 'TST-RP-BAR-B')");
    await client.query("DELETE FROM rooms WHERE room_number IN ('901-QB', '902-QB')");
    await client.query("DELETE FROM availability_dates WHERE room_type IN ('Test QB Deluxe King', 'Test QB Standard Twin')");
    await client.query("DELETE FROM room_types WHERE code IN ('TST-QB-DK', 'TST-QB-ST')");
    await client.query("DELETE FROM meal_plans WHERE code = 'TST-BF-QB'");

    const mpRes = await client.query(
      `INSERT INTO meal_plans (property_id, code, name, breakfast_included, is_active)
       VALUES (1, 'TST-BF-QB', 'Test Breakfast Included', true, true)
       RETURNING id`
    );
    const mealPlanId = mpRes.rows[0].id;

    // Room Type A (Deluxe King)
    const rtRes1 = await client.query(
      `INSERT INTO room_types (property_id, code, name, base_rate, is_active)
       VALUES (1, 'TST-QB-DK', 'Test QB Deluxe King', 500000, true)
       RETURNING id`
    );
    const rtA = rtRes1.rows[0].id;
    cleanupIds.roomTypeIds.push(rtA);

    // Room Type B (Standard Twin)
    const rtRes2 = await client.query(
      `INSERT INTO room_types (property_id, code, name, base_rate, is_active)
       VALUES (1, 'TST-QB-ST', 'Test QB Standard Twin', 400000, true)
       RETURNING id`
    );
    const rtB = rtRes2.rows[0].id;
    cleanupIds.roomTypeIds.push(rtB);

    // Physical Rooms
    const rmRes1 = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES (1, $1, '901-QB', 'Room 901 QB', 'Tersedia', true)
       RETURNING id`,
      [rtA]
    );
    const roomA = rmRes1.rows[0].id;
    cleanupIds.roomIds.push(roomA);

    const rmRes2 = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES (1, $1, '902-QB', 'Room 902 QB', 'Tersedia', true)
       RETURNING id`,
      [rtB]
    );
    const roomB = rmRes2.rows[0].id;
    cleanupIds.roomIds.push(roomB);

    // Rate Plan 1 (Overnight BAR for Room A)
    const rpRes1 = await client.query(
      `INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate, meal_plan, meal_plan_id, rate_type, is_active)
       VALUES (1, $1, 'TST-RP-BAR-A', 'Best Available Rate Room A', 600000, 'BB', $2, 'OVERNIGHT', true)
       RETURNING id`,
      [rtA, mealPlanId]
    );
    const ratePlanA = rpRes1.rows[0].id;
    cleanupIds.ratePlanIds.push(ratePlanA);

    // Rate Plan 2 (Day Use for Room A)
    const rpRes2 = await client.query(
      `INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate, meal_plan, rate_type, duration_minutes, is_active)
       VALUES (1, $1, 'TST-RP-DU-A', 'Day Use 6 Hours Room A', 300000, 'RO', 'DAY_USE', 360, true)
       RETURNING id`,
      [rtA]
    );
    const ratePlanDU = rpRes2.rows[0].id;
    cleanupIds.ratePlanIds.push(ratePlanDU);

    // Rate Plan 3 (Overnight for Room B)
    const rpRes3 = await client.query(
      `INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate, meal_plan, rate_type, is_active)
       VALUES (1, $1, 'TST-RP-BAR-B', 'Best Available Rate Room B', 450000, 'RO', 'OVERNIGHT', true)
       RETURNING id`,
      [rtB]
    );
    const ratePlanB = rpRes3.rows[0].id;
    cleanupIds.ratePlanIds.push(ratePlanB);

    // Rate Override for Room A on 2026-09-10
    const ovRes = await client.query(
      `INSERT INTO rate_overrides (property_id, rate_plan_id, start_date, end_date, override_rate, reason, is_active)
       VALUES (1, $1, '2026-09-10', '2026-09-11', 750000, 'Weekend Surcharge', true)
       RETURNING id`,
      [ratePlanA]
    );
    cleanupIds.overrideIds.push(ovRes.rows[0].id);

    // Seed availability_dates for test room types
    const testDates = [
      '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12',
      '2026-09-15', '2026-09-16', '2026-09-20', '2026-09-21', '2026-09-22',
      '2026-10-01', '2026-10-02',
      '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14',
      '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19',
      '2026-10-20', '2026-10-21'
    ];
    for (const d of testDates) {
      await client.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES ($1, 'Test QB Deluxe King', $2::date, 5, 0)`,
        [rtA, d]
      );
      await client.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES ($1, 'Test QB Standard Twin', $2::date, 5, 0)`,
        [rtB, d]
      );
    }

    console.log('2. Testing Price Quoting API (POST /api/pricing/quote)...');
    // Test 2.1: Overnight Quote with Override
    const quoteRes1 = await request('POST', '/api/pricing/quote', {
      property_id: 1,
      room_type_id: rtA,
      rate_plan_id: ratePlanA,
      check_in: '2026-09-09',
      check_out: '2026-09-11',
      stay_type: 'OVERNIGHT'
    });
    assert.strictEqual(quoteRes1.status, 200);
    assert.strictEqual(quoteRes1.data.nights, 2);
    assert.strictEqual(quoteRes1.data.nightly_breakdown.length, 2);
    // Night 1 (2026-09-09): base 600,000
    assert.strictEqual(quoteRes1.data.nightly_breakdown[0].final_room_rate, 600000);
    assert.strictEqual(quoteRes1.data.nightly_breakdown[0].applied_override_rate, null);
    // Night 2 (2026-09-10): overridden to 750,000
    assert.strictEqual(quoteRes1.data.nightly_breakdown[1].final_room_rate, 750000);
    assert.strictEqual(quoteRes1.data.nightly_breakdown[1].applied_override_rate, 750000);
    // Subtotal = 600,000 + 750,000 = 1,350,000
    assert.strictEqual(quoteRes1.data.room_subtotal, 1350000);

    // Test 2.2: Day Use Quote
    const quoteResDU = await request('POST', '/api/pricing/quote', {
      property_id: 1,
      room_type_id: rtA,
      rate_plan_id: ratePlanDU,
      check_in: '2026-09-15',
      check_out: '2026-09-15',
      stay_type: 'DAY_USE'
    });
    assert.strictEqual(quoteResDU.status, 200);
    assert.strictEqual(quoteResDU.data.room_subtotal, 300000);
    assert.strictEqual(quoteResDU.data.nightly_breakdown.length, 1);

    // Test 2.3: Incompatible Stay Type rejection
    const quoteResMismatch = await request('POST', '/api/pricing/quote', {
      property_id: 1,
      room_type_id: rtA,
      rate_plan_id: ratePlanDU, // Day Use rate plan
      check_in: '2026-09-15',
      check_out: '2026-09-16',
      stay_type: 'OVERNIGHT' // Mismatched stay type
    });
    assert.strictEqual(quoteResMismatch.status, 400);

    console.log('3. Testing Quick Booking Creation with Rate Plan (POST /api/bookings)...');
    const bookingPayload = {
      property_id: 1,
      guest_name: 'Tamu Test Rate Plan',
      guest_phone: '081234567890',
      guest_segment: 'Reguler',
      booking_source: 'BOOKING_COM',
      channel: 'OTA',
      currency_code: 'IDR',
      reservations: [
        {
          room_id: roomA,
          check_in: '2026-09-09',
          check_out: '2026-09-11',
          stay_type: 'OVERNIGHT',
          rate_plan_id: ratePlanA,
          subtotal_amount: quoteRes1.data.room_subtotal,
          tax_amount: quoteRes1.data.tax_amount,
          service_amount: quoteRes1.data.service_amount,
          total_price: quoteRes1.data.grand_total,
          amount_paid: 0,
          payment_status: 'UNPAID',
          qty: 1
        }
      ]
    };

    const bookRes = await request('POST', '/api/bookings', bookingPayload);
    if (bookRes.status !== 201) {
      console.error('Booking failed payload/response:', JSON.stringify(bookRes));
    }
    assert.strictEqual(bookRes.status, 201);
    assert.ok(bookRes.data.data.bid);
    const bookingId = bookRes.data.data.booking_id || bookRes.data.data.id;
    const reservationId = bookRes.data.data.reservations[0].id;
    cleanupIds.bookingIds.push(bookingId);
    cleanupIds.reservationIds.push(reservationId);

    // 4. Verify Database Persistence of Snapshots
    console.log('4. Verifying DB Snapshots & Rate Ledger in reservation_nightly_rates...');
    const resRow = await client.query(
      `SELECT r.id, r.booking_id, b.booking_source, b.channel, r.rate_plan_id, r.rate_plan_code_snapshot,
              r.rate_plan_name_snapshot, r.meal_plan_code_snapshot, r.meal_plan_name_snapshot,
              r.subtotal_amount, r.tax_amount, r.service_amount, r.total_price, r.is_manual_override
       FROM reservations r
       JOIN bookings b ON b.id = r.booking_id
       WHERE r.id = $1`,
      [reservationId]
    );
    assert.strictEqual(resRow.rows.length, 1);
    const r = resRow.rows[0];
    assert.strictEqual(r.rate_plan_id, ratePlanA);
    assert.strictEqual(r.rate_plan_code_snapshot, 'TST-RP-BAR-A');
    assert.strictEqual(r.rate_plan_name_snapshot, 'Best Available Rate Room A');
    assert.strictEqual(r.meal_plan_code_snapshot, 'TST-BF-QB');
    assert.strictEqual(r.booking_source, 'BOOKING_COM');
    assert.strictEqual(r.channel, 'OTA');
    assert.strictEqual(Number(r.subtotal_amount), 1350000);
    assert.strictEqual(r.is_manual_override, false);

    // Verify reservation_nightly_rates entries
    const rnrRes = await client.query(
      `SELECT stay_date::text AS stay_date, base_rate, applied_override_rate, final_room_rate, total_amount, is_manual_override
       FROM reservation_nightly_rates WHERE reservation_id = $1 ORDER BY stay_date ASC`,
      [reservationId]
    );
    assert.strictEqual(rnrRes.rows.length, 2);
    // Stay Date 1: 2026-09-09
    assert.strictEqual(rnrRes.rows[0].stay_date, '2026-09-09');
    assert.strictEqual(Number(rnrRes.rows[0].final_room_rate), 600000);
    assert.strictEqual(rnrRes.rows[0].applied_override_rate, null);
    // Stay Date 2: 2026-09-10 (with override)
    assert.strictEqual(rnrRes.rows[1].stay_date, '2026-09-10');
    assert.strictEqual(Number(rnrRes.rows[1].final_room_rate), 750000);
    assert.strictEqual(Number(rnrRes.rows[1].applied_override_rate), 750000);

    console.log('5. Testing Quick Booking with Manual Pricing Override & Mandatory Reason...');
    const manualBookingPayload = {
      property_id: 1,
      guest_name: 'Tamu Manual Price',
      guest_phone: '081234567899',
      guest_segment: 'Corporate',
      booking_source: 'DIRECT',
      channel: 'DIRECT',
      currency_code: 'IDR',
      reservations: [
        {
          room_id: roomB,
          check_in: '2026-09-20',
          check_out: '2026-09-22',
          stay_type: 'OVERNIGHT',
          rate_plan_id: ratePlanB,
          subtotal_amount: 700000, // Custom override (instead of 2 x 450,000 = 900,000)
          tax_amount: 0,
          service_amount: 0,
          total_price: 700000,
          is_manual_override: true,
          manual_override_reason: 'Diskon Korporat Direksi',
          amount_paid: 700000,
          payment_status: 'PAID',
          qty: 1
        }
      ]
    };

    const manualBookRes = await request('POST', '/api/bookings', manualBookingPayload);
    assert.strictEqual(manualBookRes.status, 201);
    const manualBookingId = manualBookRes.data.data.booking_id || manualBookRes.data.data.id;
    const manualResId = manualBookRes.data.data.reservations[0].id;
    cleanupIds.bookingIds.push(manualBookingId);
    cleanupIds.reservationIds.push(manualResId);

    const manualResRow = await client.query(
      `SELECT is_manual_override, manual_override_reason, subtotal_amount, total_price
       FROM reservations WHERE id = $1`,
      [manualResId]
    );
    assert.strictEqual(manualResRow.rows[0].is_manual_override, true);
    assert.strictEqual(manualResRow.rows[0].manual_override_reason, 'Diskon Korporat Direksi');
    assert.strictEqual(Number(manualResRow.rows[0].total_price), 700000);

    const manualNightlyRates = await client.query(
      `SELECT stay_date::text AS stay_date, final_room_rate, is_manual_override
       FROM reservation_nightly_rates WHERE reservation_id = $1 ORDER BY stay_date ASC`,
      [manualResId]
    );
    assert.strictEqual(manualNightlyRates.rows.length, 2);
    // 700,000 divided across 2 nights = 350,000 per night
    assert.strictEqual(Number(manualNightlyRates.rows[0].final_room_rate), 350000);
    assert.strictEqual(Number(manualNightlyRates.rows[1].final_room_rate), 350000);
    assert.strictEqual(manualNightlyRates.rows[0].is_manual_override, true);

    console.log('6. Testing Multi-Room Quick Booking with Mixed Rate Plans...');
    const multiRoomPayload = {
      property_id: 1,
      guest_name: 'Group Tamu Mixed',
      guest_phone: '081299998888',
      guest_segment: 'Group',
      booking_source: 'TRAVELOKA',
      channel: 'OTA',
      currency_code: 'IDR',
      reservations: [
        {
          room_id: roomA,
          check_in: '2026-10-01',
          check_out: '2026-10-02',
          stay_type: 'OVERNIGHT',
          rate_plan_id: ratePlanA,
          subtotal_amount: 600000,
          total_price: 600000,
          qty: 1
        },
        {
          room_id: roomB,
          check_in: '2026-10-01',
          check_out: '2026-10-02',
          stay_type: 'OVERNIGHT',
          rate_plan_id: ratePlanB,
          subtotal_amount: 450000,
          total_price: 450000,
          qty: 1
        }
      ]
    };

    const multiRes = await request('POST', '/api/bookings', multiRoomPayload);
    assert.strictEqual(multiRes.status, 201);
    const multiBookingId = multiRes.data.data.booking_id || multiRes.data.data.id;
    cleanupIds.bookingIds.push(multiBookingId);
    for (const resv of multiRes.data.data.reservations) {
      cleanupIds.reservationIds.push(resv.id);
    }
    assert.strictEqual(multiRes.data.data.reservations.length, 2);

    console.log('7. Testing Granular Booking Source Values...');
    const granularSources = [
      { src: 'WALK_IN', expected: 'WALKIN', inDate: '2026-10-10', outDate: '2026-10-11' },
      { src: 'DIRECT', expected: 'DIRECT', inDate: '2026-10-12', outDate: '2026-10-13' },
      { src: 'WEBSITE', expected: 'WEBSITE', inDate: '2026-10-14', outDate: '2026-10-15' },
      { src: 'AGODA', expected: 'AGODA', inDate: '2026-10-16', outDate: '2026-10-17' },
      { src: 'TIKET_COM', expected: 'TIKET_COM', inDate: '2026-10-18', outDate: '2026-10-19' },
      { src: 'OTHER', expected: 'OTHER', inDate: '2026-10-20', outDate: '2026-10-21' }
    ];
    for (const item of granularSources) {
      const srcPayload = {
        property_id: 1,
        guest_name: `Tamu Source ${item.src}`,
        guest_phone: '081233334444',
        guest_segment: 'Reguler',
        booking_source: item.src,
        channel: ['AGODA', 'TIKET_COM'].includes(item.src) ? 'OTA' : 'DIRECT',
        currency_code: 'IDR',
        reservations: [
          {
            room_id: roomA,
            check_in: item.inDate,
            check_out: item.outDate,
            stay_type: 'OVERNIGHT',
            rate_plan_id: ratePlanA,
            subtotal_amount: 600000,
            total_price: 600000,
            qty: 1
          }
        ]
      };
      const r = await request('POST', '/api/bookings', srcPayload);
      assert.strictEqual(r.status, 201);
      const bId = r.data.data.booking_id || r.data.data.id;
      const resvId = r.data.data.reservations[0].id;
      cleanupIds.bookingIds.push(bId);
      cleanupIds.reservationIds.push(resvId);

      const dbCheck = await client.query('SELECT booking_source FROM bookings WHERE id = $1', [bId]);
      assert.ok(dbCheck.rows.length > 0, `Booking ${bId} not found in DB`);
      assert.strictEqual(dbCheck.rows[0].booking_source, item.expected);
    }

    console.log('--- ALL CALENDAR QUICK BOOKING + RATE PLAN INTEGRATION TESTS PASSED ---');
  } catch (err) {
    console.error('TEST FAILED:', err);
    throw err;
  } finally {
    console.log('Cleaning up test fixtures...');
    try {
      if (cleanupIds.reservationIds.length > 0) {
        await client.query('DELETE FROM payment_evidences WHERE reservation_id = ANY($1::int[])', [cleanupIds.reservationIds]);
        await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [cleanupIds.reservationIds]);
        await client.query('DELETE FROM reservation_guests WHERE reservation_id = ANY($1::int[])', [cleanupIds.reservationIds]);
        await client.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])', [cleanupIds.reservationIds]);
        await client.query('DELETE FROM availability_locks WHERE reservation_id = ANY($1::int[])', [cleanupIds.reservationIds]);
        await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [cleanupIds.reservationIds]);
        await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [cleanupIds.reservationIds]);
      }
      if (cleanupIds.bookingIds.length > 0) {
        await client.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [cleanupIds.bookingIds]);
      }
      if (cleanupIds.overrideIds.length > 0) {
        await client.query('DELETE FROM rate_overrides WHERE id = ANY($1::int[])', [cleanupIds.overrideIds]);
      }
      if (cleanupIds.ratePlanIds.length > 0) {
        await client.query('DELETE FROM rate_plans WHERE id = ANY($1::int[])', [cleanupIds.ratePlanIds]);
      }
      if (cleanupIds.roomIds.length > 0) {
        await client.query('DELETE FROM rooms WHERE id = ANY($1::int[])', [cleanupIds.roomIds]);
      }
      if (cleanupIds.roomTypeIds.length > 0) {
        await client.query('DELETE FROM availability_dates WHERE room_type_id = ANY($1::int[])', [cleanupIds.roomTypeIds]);
        await client.query('DELETE FROM room_types WHERE id = ANY($1::int[])', [cleanupIds.roomTypeIds]);
      }
      await client.query("DELETE FROM meal_plans WHERE code = 'TST-BF-QB'");
    } catch (cleanErr) {
      console.warn('Cleanup error:', cleanErr);
    }

    client.release();
    if (server) {
      if (server.closeAllConnections) server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    await pool.end();
    setTimeout(() => process.exit(0), 50);
  }
}

runTest().catch((e) => {
  console.error('Fatal error during test run:', e);
  process.exit(1);
});

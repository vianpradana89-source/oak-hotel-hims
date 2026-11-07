'use strict';

const assert = require('assert');
const { Pool } = require('pg');
const { app, pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');

const testPool = new Pool({
  host: process.env.PGHOST || process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.PGPORT || process.env.DB_PORT || 5432),
  user: process.env.PGUSER || process.env.DB_USER || 'postgres',
  password: process.env.PGPASSWORD || process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.PGDATABASE || process.env.DB_NAME || 'oak_hotel_db',
});

const runId = `FUT-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
let server = null;
let baseUrl = '';
let authToken = '';

const fixture = {
  propertyId: null,
  roomCategoryId: null,
  roomTypeId: null,
  ratePlanId: null,
  rooms: [],
  bookingIds: [],
  reservationIds: [],
  createdCorrelationIds: [],
};

async function createFixture() {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');

    const propCode = `F${String(Date.now()).slice(-4)}`.toUpperCase();
    const propRes = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ($1, $2, 'Asia/Jakarta', 'IDR', 'Future Inventory Test Property', TRUE)
       RETURNING id`,
      [runId, propCode]
    );
    fixture.propertyId = Number(propRes.rows[0].id);

    await client.query(
      `INSERT INTO property_pricing_settings (
         property_id, tax_percent, service_charge_percent, prices_include_tax, prices_include_service
       ) VALUES ($1, 0, 0, FALSE, FALSE)`,
      [fixture.propertyId]
    );

    const catRes = await client.query(
      `INSERT INTO room_categories (property_id, code, name, is_active)
       VALUES ($1, 'FUT_CAT', $2, TRUE)
       RETURNING id`,
      [fixture.propertyId, `Category ${propCode}`]
    );
    fixture.roomCategoryId = Number(catRes.rows[0].id);

    const typeRes = await client.query(
      `INSERT INTO room_types (
         property_id, room_category_id, code, name, base_rate, capacity, is_active
       ) VALUES ($1, $2, $3, $4, 150000, 2, TRUE)
       RETURNING id`,
      [fixture.propertyId, fixture.roomCategoryId, `RT-${propCode}`, `Future Deluxe ${propCode}`]
    );
    fixture.roomTypeId = Number(typeRes.rows[0].id);

    const ratePlanRes = await client.query(
      `INSERT INTO rate_plans (
         property_id, room_type_id, code, name, base_rate, is_active, is_archived
       ) VALUES ($1, $2, $3, $4, 150000, TRUE, FALSE)
       RETURNING id`,
      [fixture.propertyId, fixture.roomTypeId, `BAR-${propCode}`, `Best Available ${propCode}`]
    );
    fixture.ratePlanId = Number(ratePlanRes.rows[0].id);

    // Create exactly 2 physical rooms
    const roomsRes = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES
         ($1, $2, 'FUT-101', 'FUT-101', 'VACANT_CLEAN', TRUE),
         ($1, $2, 'FUT-102', 'FUT-102', 'VACANT_CLEAN', TRUE)
       RETURNING id, room_number`,
      [fixture.propertyId, fixture.roomTypeId]
    );
    fixture.rooms = roomsRes.rows.map((r) => ({ id: Number(r.id), number: r.room_number }));

    // IMPORTANT: Deliberately do NOT pre-seed availability_dates for 2027+
    // This allows testing dynamic creation for missing future dates.

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  authToken = generateToken({
    id: 1,
    email: 'admin@oakhotel.test',
    username: 'admin',
    full_name: 'Test Administrator',
    role: 'SUPERADMIN',
    role_id: 1,
    property_id: fixture.propertyId,
    scope: 'FULL',
  });
}

async function request(method, path, body, corr) {
  const correlationId = corr || `FUT-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  if (!fixture.createdCorrelationIds.includes(correlationId)) {
    fixture.createdCorrelationIds.push(correlationId);
  }

  const headers = {
    'Content-Type': 'application/json',
    'X-Correlation-Id': correlationId,
    'Authorization': `Bearer ${authToken}`,
  };

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_e) {
    json = null;
  }

  return { status: response.status, text, json, correlationId };
}

async function getLedgerCell(roomTypeId, dateKey) {
  const res = await testPool.query(
    `SELECT id, room_type_id, room_type, date, total_rooms, reserved_qty
     FROM availability_dates
     WHERE room_type_id = $1 AND date = $2::date`,
    [roomTypeId, dateKey]
  );
  return res.rows[0] || null;
}

async function cleanup() {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');

    if (fixture.reservationIds.length) {
      await client.query('DELETE FROM payment_evidences WHERE reservation_id = ANY($1::int[])', [fixture.reservationIds]);
      await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [fixture.reservationIds]);
      await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [fixture.reservationIds]);
      await client.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])', [fixture.reservationIds]);
      await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [fixture.reservationIds]);
    }

    if (fixture.createdCorrelationIds.length) {
      await client.query('DELETE FROM reservations WHERE correlation_id = ANY($1::text[])', [fixture.createdCorrelationIds]);
      await client.query('DELETE FROM bookings WHERE correlation_id = ANY($1::text[])', [fixture.createdCorrelationIds]);
    }

    if (fixture.bookingIds.length) {
      await client.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [fixture.bookingIds]);
    }

    if (fixture.propertyId) {
      await client.query('DELETE FROM audit_logs WHERE property_id = $1', [fixture.propertyId]);
      await client.query('DELETE FROM transaction_lines WHERE transaction_id IN (SELECT id FROM transactions WHERE property_id = $1)', [fixture.propertyId]).catch(() => {});
      await client.query('DELETE FROM transaction_attachments WHERE transaction_id IN (SELECT id FROM transactions WHERE property_id = $1)', [fixture.propertyId]).catch(() => {});
      await client.query('DELETE FROM transactions WHERE property_id = $1', [fixture.propertyId]).catch(() => {});
      await client.query('DELETE FROM availability_locks WHERE room_type_id = $1', [fixture.roomTypeId]);
      await client.query('DELETE FROM availability_dates WHERE room_type_id = $1', [fixture.roomTypeId]);
      await client.query('DELETE FROM rate_plans WHERE property_id = $1', [fixture.propertyId]);
      await client.query('DELETE FROM rooms WHERE property_id = $1', [fixture.propertyId]);
      await client.query('DELETE FROM room_types WHERE property_id = $1', [fixture.propertyId]);
      await client.query('DELETE FROM room_categories WHERE property_id = $1', [fixture.propertyId]);
      await client.query('DELETE FROM property_pricing_settings WHERE property_id = $1', [fixture.propertyId]);
      await client.query('DELETE FROM properties WHERE id = $1', [fixture.propertyId]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error during cleanup:', err);
  } finally {
    client.release();
  }
}

async function run() {
  console.log('=== TEST SUITE: Future Quick Booking & Canonical Inventory Invariants ===\n');

  // Start in-process server on ephemeral port
  server = app.listen(0);
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running on ${baseUrl}`);

  await createFixture();
  console.log(`Fixture created: property_id=${fixture.propertyId}, room_type_id=${fixture.roomTypeId}, rooms=[${fixture.rooms.map(r=>r.number).join(', ')}]`);

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Problematic 2027 date (2027-07-28 to 2027-07-29)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 1: Booking on problematic date 2027-07-28 ---');
    const cellBefore1 = await getLedgerCell(fixture.roomTypeId, '2027-07-28');
    assert.strictEqual(cellBefore1, null, 'Ledger row for 2027-07-28 must NOT exist before booking');

    const res1 = await request('POST', '/api/bookings', {
      property_id: fixture.propertyId,
      guest_name: 'Guest 2027 Test',
      guest_phone: '081234567801',
      booking_source: 'WALKIN',
      payment_type: 'CASH',
      reservations: [
        {
          room_type_id: fixture.roomTypeId,
          room_id: fixture.rooms[0].id,
          check_in: '2027-07-28',
          check_out: '2027-07-29',
          total_price: 150000,
          rate: 150000,
          guest_name: 'Guest 2027 Test',
        },
      ],
    });

    assert.strictEqual(res1.status, 201, `Booking create on 2027-07-28 must succeed with 201. Output: ${res1.text}`);
    assert.ok(res1.json?.data?.booking_id, 'Must return booking_id');
    fixture.bookingIds.push(res1.json.data.booking_id);
    for (const r of res1.json.data.reservations || []) {
      fixture.reservationIds.push(r.id);
    }

    const cellAfter1 = await getLedgerCell(fixture.roomTypeId, '2027-07-28');
    assert.ok(cellAfter1 !== null, 'Ledger row for 2027-07-28 must be dynamically created');
    assert.strictEqual(Number(cellAfter1.total_rooms), 2, 'Total rooms must match authoritative active physical rooms (2)');
    assert.strictEqual(Number(cellAfter1.reserved_qty), 1, 'reserved_qty must be 1 for stay date');

    // Checkout date (2027-07-29) must NOT be reserved (stay is [check_in, check_out))
    const cellCheckout1 = await getLedgerCell(fixture.roomTypeId, '2027-07-29');
    if (cellCheckout1 !== null) {
      assert.strictEqual(Number(cellCheckout1.reserved_qty), 0, 'Checkout date must NOT have reserved_qty incremented (preserves [check_in, check_out))');
    }
    console.log('✓ TEST 1 PASSED: 2027-07-28 booking created ledger dynamically, reserved_qty=1, checkout date not reserved');

    // -------------------------------------------------------------------------
    // TEST 2: Cross-year stay dates (2027-12-30 to 2028-01-02, 3 nights)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 2: Cross-year stay dates (2027-12-30 to 2028-01-02) ---');
    const res2 = await request('POST', '/api/bookings', {
      property_id: fixture.propertyId,
      guest_name: 'Cross Year Guest',
      guest_phone: '081234567802',
      booking_source: 'WALKIN',
      payment_type: 'CASH',
      reservations: [
        {
          room_type_id: fixture.roomTypeId,
          room_id: fixture.rooms[0].id,
          check_in: '2027-12-30',
          check_out: '2028-01-02',
          total_price: 450000,
          rate: 150000,
          guest_name: 'Cross Year Guest',
        },
      ],
    });

    assert.strictEqual(res2.status, 201, `Cross-year booking must succeed with 201. Output: ${res2.text}`);
    fixture.bookingIds.push(res2.json.data.booking_id);
    for (const r of res2.json.data.reservations || []) {
      fixture.reservationIds.push(r.id);
    }

    const nights = ['2027-12-30', '2027-12-31', '2028-01-01'];
    for (const night of nights) {
      const cell = await getLedgerCell(fixture.roomTypeId, night);
      assert.ok(cell !== null, `Ledger row for ${night} must exist`);
      assert.strictEqual(Number(cell.reserved_qty), 1, `reserved_qty for ${night} must be 1`);
      assert.strictEqual(Number(cell.total_rooms), 2, `total_rooms for ${night} must be 2`);
    }

    const checkoutCell2 = await getLedgerCell(fixture.roomTypeId, '2028-01-02');
    if (checkoutCell2 !== null) {
      assert.strictEqual(Number(checkoutCell2.reserved_qty), 0, 'Checkout date 2028-01-02 must have reserved_qty=0');
    }
    console.log('✓ TEST 2 PASSED: Cross-year stay dates reserved correctly across year boundary [2027-12-30, 2028-01-02)');

    // -------------------------------------------------------------------------
    // TEST 3: Distant future empty calendar (2029-06-01 to 2029-06-03, 2 nights)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 3: Distant future empty calendar (2029-06-01 to 2029-06-03) ---');
    const cellBefore3 = await getLedgerCell(fixture.roomTypeId, '2029-06-01');
    assert.strictEqual(cellBefore3, null, '2029-06-01 must not exist initially');

    const res3 = await request('POST', '/api/bookings', {
      property_id: fixture.propertyId,
      guest_name: 'Distant Future Guest',
      guest_phone: '081234567803',
      booking_source: 'WALKIN',
      payment_type: 'CASH',
      reservations: [
        {
          room_type_id: fixture.roomTypeId,
          room_id: fixture.rooms[1].id,
          check_in: '2029-06-01',
          check_out: '2029-06-03',
          total_price: 300000,
          rate: 150000,
          guest_name: 'Distant Future Guest',
        },
      ],
    });

    assert.strictEqual(res3.status, 201, `Distant future booking must succeed with 201. Output: ${res3.text}`);
    fixture.bookingIds.push(res3.json.data.booking_id);
    for (const r of res3.json.data.reservations || []) {
      fixture.reservationIds.push(r.id);
    }

    const cellAfter3_1 = await getLedgerCell(fixture.roomTypeId, '2029-06-01');
    const cellAfter3_2 = await getLedgerCell(fixture.roomTypeId, '2029-06-02');
    assert.strictEqual(Number(cellAfter3_1.reserved_qty), 1);
    assert.strictEqual(Number(cellAfter3_2.reserved_qty), 1);
    console.log('✓ TEST 3 PASSED: Distant future empty calendar dates dynamically created with accurate capacity');

    // -------------------------------------------------------------------------
    // TEST 4: Capacity exhausted (overselling protection)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 4: Capacity exhausted (overselling protection) ---');
    // Date: 2027-08-15 to 2027-08-16. Total capacity is 2 rooms.
    // Book room 0
    const res4a = await request('POST', '/api/bookings', {
      property_id: fixture.propertyId,
      guest_name: 'Room 1 Guest',
      guest_phone: '081234567804',
      booking_source: 'WALKIN',
      payment_type: 'CASH',
      reservations: [
        {
          room_type_id: fixture.roomTypeId,
          room_id: fixture.rooms[0].id,
          check_in: '2027-08-15',
          check_out: '2027-08-16',
          total_price: 150000,
          rate: 150000,
          guest_name: 'Room 1 Guest',
        },
      ],
    });
    assert.strictEqual(res4a.status, 201);
    fixture.bookingIds.push(res4a.json.data.booking_id);
    fixture.reservationIds.push(res4a.json.data.reservations[0].id);

    // Book room 1
    const res4b = await request('POST', '/api/bookings', {
      property_id: fixture.propertyId,
      guest_name: 'Room 2 Guest',
      guest_phone: '081234567805',
      booking_source: 'WALKIN',
      payment_type: 'CASH',
      reservations: [
        {
          room_type_id: fixture.roomTypeId,
          room_id: fixture.rooms[1].id,
          check_in: '2027-08-15',
          check_out: '2027-08-16',
          total_price: 150000,
          rate: 150000,
          guest_name: 'Room 2 Guest',
        },
      ],
    });
    assert.strictEqual(res4b.status, 201);
    fixture.bookingIds.push(res4b.json.data.booking_id);
    fixture.reservationIds.push(res4b.json.data.reservations[0].id);

    const cellCap = await getLedgerCell(fixture.roomTypeId, '2027-08-15');
    assert.strictEqual(Number(cellCap.reserved_qty), 2, 'reserved_qty must be 2 (full capacity)');
    assert.strictEqual(Number(cellCap.total_rooms), 2, 'total_rooms must be 2');

    // Attempt third booking on the same date (both rooms are booked)
    const res4c = await request('POST', '/api/bookings', {
      property_id: fixture.propertyId,
      guest_name: 'Room 3 Attempt (Overbooking)',
      guest_phone: '081234567806',
      booking_source: 'WALKIN',
      payment_type: 'CASH',
      reservations: [
        {
          room_type_id: fixture.roomTypeId,
          room_id: fixture.rooms[0].id,
          check_in: '2027-08-15',
          check_out: '2027-08-16',
          total_price: 150000,
          rate: 150000,
          guest_name: 'Room 3 Attempt',
        },
      ],
    });
    assert.strictEqual(res4c.status, 409, `Overbooking attempt must be rejected with 409 Conflict. Got: ${res4c.status}`);

    const cellCapAfter = await getLedgerCell(fixture.roomTypeId, '2027-08-15');
    assert.strictEqual(Number(cellCapAfter.reserved_qty), 2, 'reserved_qty must NOT exceed total_rooms (never clamped, never oversold)');
    console.log('✓ TEST 4 PASSED: Overselling protected, 409 returned when capacity exhausted');

    // -------------------------------------------------------------------------
    // TEST 5: Concurrent bookings race condition
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 5: Concurrent bookings race condition ---');
    // Date: 2027-09-20 to 2027-09-21.
    // 4 concurrent requests competing for 2 available rooms.
    const concurrentRequests = [0, 1, 2, 3].map((idx) =>
      request('POST', '/api/bookings', {
        property_id: fixture.propertyId,
        guest_name: `Concurrent Guest ${idx}`,
        guest_phone: `08123456781${idx}`,
        booking_source: 'WALKIN',
        payment_type: 'CASH',
        reservations: [
          {
            room_type_id: fixture.roomTypeId,
            room_id: fixture.rooms[idx % 2].id,
            check_in: '2027-09-20',
            check_out: '2027-09-21',
            total_price: 150000,
            rate: 150000,
            guest_name: `Concurrent Guest ${idx}`,
          },
        ],
      })
    );

    const concurrentResults = await Promise.all(concurrentRequests);
    const successes = concurrentResults.filter((r) => r.status === 201);
    const conflicts = concurrentResults.filter((r) => r.status === 409);

    for (const s of successes) {
      fixture.bookingIds.push(s.json.data.booking_id);
      fixture.reservationIds.push(s.json.data.reservations[0].id);
    }

    assert.strictEqual(successes.length, 2, `Exactly 2 bookings must succeed for 2 rooms. Got ${successes.length} successes.`);
    assert.strictEqual(conflicts.length, 2, `Remaining 2 bookings must be rejected with 409. Got ${conflicts.length} conflicts.`);

    const cellRace = await getLedgerCell(fixture.roomTypeId, '2027-09-20');
    assert.strictEqual(Number(cellRace.reserved_qty), 2, 'Final reserved_qty must be exactly 2');
    assert.strictEqual(Number(cellRace.total_rooms), 2, 'total_rooms must be 2');

    // Ensure exactly 1 ledger row exists for (room_type_id, date) - no duplicates created under race
    const duplicateRowsRes = await testPool.query(
      `SELECT COUNT(*)::int AS count
       FROM availability_dates
       WHERE room_type_id = $1 AND date = '2027-09-20'::date`,
      [fixture.roomTypeId]
    );
    assert.strictEqual(Number(duplicateRowsRes.rows[0].count), 1, 'Exactly one availability row must exist (no duplicate rows)');
    console.log('✓ TEST 5 PASSED: Concurrent booking race condition handled cleanly with atomic row locks');

    // -------------------------------------------------------------------------
    // TEST 6: Transaction rollback on failure (zero orphan records)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 6: Transaction rollback on failure ---');
    const bookingCountBefore = await testPool.query(`SELECT COUNT(*)::int AS count FROM bookings WHERE property_id = $1`, [fixture.propertyId]);
    const resCountBefore = await testPool.query(
      `SELECT COUNT(*)::int AS count FROM reservations WHERE room_id = ANY($1::int[])`,
      [fixture.rooms.map((r) => r.id)]
    );

    // Send payload with invalid stay dates (check_out <= check_in), which fails validation / DB constraint
    const failRes = await request('POST', '/api/bookings', {
      property_id: fixture.propertyId,
      guest_name: 'Rollback Test Guest',
      guest_phone: '081234567899',
      booking_source: 'WALKIN',
      payment_type: 'CASH',
      reservations: [
        {
          room_type_id: fixture.roomTypeId,
          room_id: fixture.rooms[0].id,
          check_in: '2027-10-15',
          check_out: '2027-10-14', // Invalid checkout before checkin
          total_price: 150000,
          rate: 150000,
          guest_name: 'Rollback Test Guest',
        },
      ],
    });

    assert.ok(failRes.status >= 400, `Invalid stay dates must fail with HTTP 4xx/5xx. Got: ${failRes.status}`);

    const bookingCountAfter = await testPool.query(`SELECT COUNT(*)::int AS count FROM bookings WHERE property_id = $1`, [fixture.propertyId]);
    const resCountAfter = await testPool.query(
      `SELECT COUNT(*)::int AS count FROM reservations WHERE room_id = ANY($1::int[])`,
      [fixture.rooms.map((r) => r.id)]
    );

    assert.strictEqual(Number(bookingCountAfter.rows[0].count), Number(bookingCountBefore.rows[0].count), 'Zero orphan bookings created on rollback');
    assert.strictEqual(Number(resCountAfter.rows[0].count), Number(resCountBefore.rows[0].count), 'Zero orphan reservations created on rollback');
    console.log('✓ TEST 6 PASSED: Transaction rollback cleanly leaves zero orphan bookings or reservations');

    // -------------------------------------------------------------------------
    // TEST 7: Inventory Invariants Check
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 7: Post-test Inventory Invariants ---');
    const negativeRes = await testPool.query(`SELECT COUNT(*)::int AS count FROM availability_dates WHERE reserved_qty < 0`);
    const negativeCount = Number(negativeRes.rows[0].count);
    assert.strictEqual(negativeCount, 0, 'reserved_qty < 0 count must be 0');

    const overbookedRes = await testPool.query(`SELECT COUNT(*)::int AS count FROM availability_dates WHERE reserved_qty > total_rooms`);
    const overbookedCount = Number(overbookedRes.rows[0].count);
    assert.strictEqual(overbookedCount, 0, 'reserved_qty > total_rooms count must be 0');

    console.log('✓ TEST 7 PASSED: Invariants verified (0 negative, 0 overflow)');

  } finally {
    console.log('\nCleaning up fixtures and shutting down server...');
    await cleanup();
    if (server) {
      server.close();
    }
    await testPool.end();
    await pool.end();
    console.log('Cleanup complete.');
  }

  console.log('\n======================================================');
  console.log('ALL 6 FUTURE INVENTORY & QUICK BOOKING TESTS PASSED!');
  console.log('======================================================\n');
}

run().catch((err) => {
  console.error('\nTEST SUITE FAILED:', err);
  if (server) {
    server.close();
  }
  process.exit(1);
});

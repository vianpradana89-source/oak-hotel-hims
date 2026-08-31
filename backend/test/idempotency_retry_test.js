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

async function api(method, path, body, customHeaders = {}) {
  const opts = {
    method,
    headers: {
      ...customHeaders
    }
  };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body && method !== 'GET') {
    if (path.match(/\/api\/reservations\/\d+\/payments$/) && method === 'POST') {
      const fd = new FormData();
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined && v !== null) fd.append(k, String(v));
      }
      fd.append('file', new Blob([Buffer.from('TEST_PROPERTY_PAYMENT_PROOF_JPEG')], { type: 'image/jpeg' }), 'receipt.jpg');
      opts.body = fd;
    } else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(baseUrl + path, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, json };
}

// ─── FIXTURE STATE ──────────────────────────────────────────────────────────

let propertyId;
let roomCategoryId;
let roomTypeId;
let roomId;
let posCatId;
let posItemId;

async function setupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const rand = Math.floor(1000 + Math.random() * 9000);

    const prop = await client.query(
      `INSERT INTO properties (name, address, phone, property_code, timezone, currency)
       VALUES ($1, 'Idempotency Test Address', '08123456789', $2, 'Asia/Jakarta', 'IDR')
       RETURNING id`,
      [`Idempotency Prop ${rand}`, `IP${rand}`]
    );
    propertyId = prop.rows[0].id;

    const cat = await client.query(
      `INSERT INTO room_categories (property_id, name, code)
       VALUES ($1, 'Idempotency Cat', $2) RETURNING id`,
      [propertyId, `IC${rand}`]
    );
    roomCategoryId = cat.rows[0].id;

    const rt = await client.query(
      `INSERT INTO room_types (property_id, room_category_id, name, code, base_rate, capacity)
       VALUES ($1, $2, 'Idempotency Type', $3, 400000, 2) RETURNING id`,
      [propertyId, roomCategoryId, `IT${rand}`]
    );
    roomTypeId = rt.rows[0].id;

    const r = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES ($1, $2, $3, 'Room 101', 'VACANT_CLEAN', TRUE) RETURNING id`,
      [propertyId, roomTypeId, `101-${rand}`]
    );
    roomId = r.rows[0].id;

    // Seed availability dates
    for (let d = 1; d <= 25; d++) {
      const dateStr = `2026-09-${String(d).padStart(2, '0')}`;
      await client.query(
        `INSERT INTO availability_dates (room_type, room_type_id, date, total_rooms, reserved_qty)
         VALUES ('Idempotency Type', $1, $2, 5, 0)
         ON CONFLICT (room_type, date) DO UPDATE SET room_type_id = EXCLUDED.room_type_id`,
        [roomTypeId, dateStr]
      );
    }

    const pCat = await client.query(
      `INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, 'Beverages') RETURNING id`,
      [propertyId]
    );
    posCatId = pCat.rows[0].id;

    const pItem = await client.query(
      `INSERT INTO pos_menu_items (property_id, category_id, name, price, is_active)
       VALUES ($1, $2, 'Kopi Idempotent', 20000, TRUE) RETURNING id`,
      [propertyId, posCatId]
    );
    posItemId = pItem.rows[0].id;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function cleanupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (propertyId) {
      await client.query('DELETE FROM idempotency_keys WHERE key LIKE $1', [`IDEMP-TEST-%`]);
      await client.query('DELETE FROM pos_order_items WHERE order_id IN (SELECT id FROM pos_orders WHERE property_id = $1)', [propertyId]);
      await client.query('DELETE FROM pos_orders WHERE property_id = $1', [propertyId]);
      await client.query('DELETE FROM pos_menu_items WHERE property_id = $1', [propertyId]);
      await client.query('DELETE FROM pos_menu_categories WHERE property_id = $1', [propertyId]);
      await client.query('DELETE FROM housekeeping_tasks WHERE room_id = $1', [roomId]);
      await client.query('DELETE FROM transactions WHERE property_id = $1', [propertyId]);
      await client.query('DELETE FROM folio_entries WHERE property_id = $1', [propertyId]);
      await client.query('DELETE FROM payment_evidences WHERE payment_transaction_id IN (SELECT id FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1)))', [propertyId]);
      await client.query('DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1))', [propertyId]);
      await client.query('DELETE FROM reservation_guests WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1))', [propertyId]);
      await client.query('DELETE FROM availability_dates WHERE room_type_id = $1', [roomTypeId]);
      await client.query('DELETE FROM audit_logs WHERE property_id = $1', [propertyId]);
      await client.query('DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1)', [propertyId]);
      await client.query('DELETE FROM bookings WHERE property_id = $1', [propertyId]);
      await client.query('DELETE FROM rooms WHERE property_id = $1', [propertyId]);
      await client.query('DELETE FROM room_types WHERE property_id = $1', [propertyId]);
      await client.query('DELETE FROM room_categories WHERE property_id = $1', [propertyId]);
      await client.query('DELETE FROM property_housekeeping_settings WHERE property_id = $1', [propertyId]);
      await client.query('DELETE FROM property_pricing_settings WHERE property_id = $1', [propertyId]);
      await client.query('DELETE FROM properties WHERE id = $1', [propertyId]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Fixture cleanup error:', err.message);
  } finally {
    client.release();
  }
}

// ─── RUN TESTS ──────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n======================================================');
  console.log('START: Critical Operations Idempotency Retry Tests');
  console.log('======================================================\n');

  const testStamp = Date.now();

  // 1. Quick Booking Creation Idempotent Retry
  let createdReservationId;
  {
    const idempKey = `IDEMP-TEST-BOOKING-${testStamp}`;
    const payload = {
      property_id: propertyId,
      guest_name: 'Budi Idempotent',
      guest_phone: '0812333444',
      guest_segment: 'Reguler',
      booking_source: 'WALKIN',
      channel: 'Front Desk',
      currency_code: 'IDR',
      reservations: [
        {
          room_id: roomId,
          guest_name: 'Budi Idempotent',
          guest_phone: '0812333444',
          guest_segment: 'Reguler',
          check_in: '2026-09-10',
          check_out: '2026-09-12',
          stay_type: 'OVERNIGHT',
          total_price: 800000,
          subtotal_amount: 800000,
          discount_amount: 0,
          amount_paid: 0,
          payment_method: 'CASH',
          stay_sequence: 1
        }
      ]
    };

    // First attempt
    const res1 = await api('POST', '/api/bookings', payload, { 'Idempotency-Key': idempKey });
    if (res1.status !== 201 && res1.status !== 200) {
      console.log('Booking 400 error detail:', res1.json);
    }
    expect(res1.status === 201 || res1.status === 200, `Quick booking attempt 1 succeeds (got ${res1.status})`);
    createdReservationId = res1.json?.data?.reservations?.[0]?.id || res1.json?.data?.id;

    // Retry attempt with same Idempotency-Key
    const res2 = await api('POST', '/api/bookings', payload, { 'Idempotency-Key': idempKey });
    expect(res2.status === 201 || res2.status === 200, `Quick booking attempt 2 succeeds (got ${res2.status})`);
    expect(res2.headers.get('x-idempotency') === 'HIT', 'Quick booking attempt 2 was served from Idempotency cache (HIT)');

    // DB Invariant: exactly 1 booking & reservation created
    const bCount = await pool.query('SELECT COUNT(*) AS c FROM bookings WHERE property_id = $1', [propertyId]);
    const rCount = await pool.query(
      'SELECT COUNT(*) AS c FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1)',
      [propertyId]
    );
    expect(Number(bCount.rows[0].c) === 1, `Exactly 1 booking in DB (found ${bCount.rows[0].c})`);
    expect(Number(rCount.rows[0].c) === 1, `Exactly 1 reservation in DB (found ${rCount.rows[0].c})`);
  }

  // 2. Stay Charge Posting Idempotent Retry
  {
    const idempKey = `IDEMP-TEST-CHARGE-${testStamp}`;
    const payload = {
      property_id: propertyId,
      reservation_id: createdReservationId,
      charge_type: 'CUSTOM',
      custom_description: 'Laundry Cuci Kilat',
      unit_price: 35000,
      quantity: 2
    };

    const res1 = await api('POST', '/api/stay-charges/post-charge', payload, { 'Idempotency-Key': idempKey });
    expect(res1.status === 201 || res1.status === 200, `Stay charge attempt 1 succeeds (got ${res1.status})`);

    const res2 = await api('POST', '/api/stay-charges/post-charge', payload, { 'Idempotency-Key': idempKey });
    expect(res2.status === 201 || res2.status === 200, `Stay charge attempt 2 succeeds (got ${res2.status})`);
    expect(res2.headers.get('x-idempotency') === 'HIT', 'Stay charge attempt 2 was served from Idempotency cache (HIT)');

    const folioCount = await pool.query(
      "SELECT COUNT(*) AS c FROM folio_entries WHERE reservation_id = $1 AND description = 'Laundry Cuci Kilat'",
      [createdReservationId]
    );
    expect(Number(folioCount.rows[0].c) === 1, `Exactly 1 folio charge entry created (found ${folioCount.rows[0].c})`);
  }

  // 3. Payment Creation Idempotent Retry
  {
    const idempKey = `IDEMP-TEST-PAYMENT-${testStamp}`;
    const payload = {
      property_id: propertyId,
      amount: 150000,
      payment_method: 'CASH',
      reference_code: `REF-${testStamp}`
    };

    const res1 = await api('POST', `/api/reservations/${createdReservationId}/payments`, payload, { 'Idempotency-Key': idempKey });
    expect(res1.status === 201 || res1.status === 200, `Payment attempt 1 succeeds (got ${res1.status})`);

    const res2 = await api('POST', `/api/reservations/${createdReservationId}/payments`, payload, { 'Idempotency-Key': idempKey });
    expect(res2.status === 201 || res2.status === 200, `Payment attempt 2 succeeds (got ${res2.status})`);
    expect(res2.headers.get('x-idempotency') === 'HIT', 'Payment attempt 2 was served from Idempotency cache (HIT)');

    const payCount = await pool.query('SELECT COUNT(*) AS c FROM payment_transactions WHERE reservation_id = $1', [createdReservationId]);
    expect(Number(payCount.rows[0].c) === 1, `Exactly 1 payment transaction in DB (found ${payCount.rows[0].c})`);
  }

  // 4. POS Order Creation & Sale Projection Idempotent Retry
  {
    const idempKey = `IDEMP-TEST-POS-${testStamp}`;
    const payload = {
      property_id: propertyId,
      reservation_id: createdReservationId,
      table_number: 'Meja 01',
      guest_name: 'Customer POS',
      status: 'PAID',
      items: [
        {
          menu_item_id: posItemId,
          quantity: 2
        }
      ]
    };

    const res1 = await api('POST', '/api/pos/orders', payload, { 'Idempotency-Key': idempKey });
    expect(res1.status === 201 || res1.status === 200, `POS order attempt 1 succeeds (got ${res1.status})`);

    const res2 = await api('POST', '/api/pos/orders', payload, { 'Idempotency-Key': idempKey });
    expect(res2.status === 201 || res2.status === 200, `POS order attempt 2 succeeds (got ${res2.status})`);
    expect(res2.headers.get('x-idempotency') === 'HIT', 'POS order attempt 2 was served from Idempotency cache (HIT)');

    const orderCount = await pool.query('SELECT COUNT(*) AS c FROM pos_orders WHERE property_id = $1', [propertyId]);
    expect(Number(orderCount.rows[0].c) === 1, `Exactly 1 POS order created (found ${orderCount.rows[0].c})`);

    const saleTxCount = await pool.query(
      "SELECT COUNT(*) AS c FROM transactions WHERE property_id = $1 AND source_type = 'POS_ORDER'",
      [propertyId]
    );
    expect(Number(saleTxCount.rows[0].c) === 1, `Exactly 1 SALE transaction projected (found ${saleTxCount.rows[0].c})`);
  }

  // 5. Checkin & Checkout Idempotent Retry
  {
    // Check-in first
    const checkinRes = await api('POST', `/api/reservations/${createdReservationId}/checkin`, { property_id: propertyId, override_guest_identity: true });
    expect(checkinRes.status === 200, `Checkin succeeds (got ${checkinRes.status})`);

    // Checkout with idempotency key
    const idempKey = `IDEMP-TEST-CHECKOUT-${testStamp}`;
    const payload = { property_id: propertyId, skip_inspection: true };

    const res1 = await api('POST', `/api/reservations/${createdReservationId}/checkout`, payload, { 'Idempotency-Key': idempKey });
    expect(res1.status === 200, `Checkout attempt 1 succeeds (got ${res1.status})`);

    const res2 = await api('POST', `/api/reservations/${createdReservationId}/checkout`, payload, { 'Idempotency-Key': idempKey });
    expect(res2.status === 200, `Checkout attempt 2 succeeds (got ${res2.status})`);
    expect(res2.headers.get('x-idempotency') === 'HIT', 'Checkout attempt 2 was served from Idempotency cache (HIT)');

    const resCheck = await pool.query('SELECT status, stay_status FROM reservations WHERE id = $1', [createdReservationId]);
    expect(resCheck.rows[0]?.status === 'CHECKED_OUT', `Reservation status is CHECKED_OUT`);

    const hkTasks = await pool.query(
      "SELECT COUNT(*) AS c FROM housekeeping_tasks WHERE room_id = $1 AND task_type = 'CHECKOUT_CLEANING'",
      [roomId]
    );
    expect(Number(hkTasks.rows[0].c) <= 1, `Checkout housekeeping task created without duplicate spam (count: ${hkTasks.rows[0].c})`);
  }
}

async function main() {
  server = http.createServer(app);
  server.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running at ${baseUrl}`);

  try {
    await initializeDatabase(pool);
    await setupFixtures();
    await runTests();
  } finally {
    await cleanupFixtures();
    server.close();
    await pool.end();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

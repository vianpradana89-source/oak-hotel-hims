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
  return { status: res.status, json };
}

// ─── FIXTURE STATE ──────────────────────────────────────────────────────────

let propIdA;
let propIdB;
let roomTypeIdA;
let roomTypeIdB;
let roomIdA;
let roomIdB;
let bookingIdA;
let bookingIdB;
let resIdA;
let resIdB;
let posItemIdA;
let glAccountIdB;

async function setupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const randA = Math.floor(1000 + Math.random() * 9000);
    const randB = Math.floor(1000 + Math.random() * 9000);

    // Two test properties
    const propA = await client.query(
      `INSERT INTO properties (name, address, phone, property_code, timezone, currency)
       VALUES ($1, 'Property A Address', '08111111111', $2, 'Asia/Jakarta', 'IDR')
       RETURNING id`,
      [`Property A IsoTest ${randA}`, `PA${randA}`]
    );
    propIdA = propA.rows[0].id;

    const propB = await client.query(
      `INSERT INTO properties (name, address, phone, property_code, timezone, currency)
       VALUES ($1, 'Property B Address', '08222222222', $2, 'Asia/Jakarta', 'IDR')
       RETURNING id`,
      [`Property B IsoTest ${randB}`, `PB${randB}`]
    );
    propIdB = propB.rows[0].id;

    // Room categories
    const catA = await client.query(
      `INSERT INTO room_categories (property_id, name, code)
       VALUES ($1, 'Category A', $2) RETURNING id`,
      [propIdA, `CTA${randA}`]
    );
    const catB = await client.query(
      `INSERT INTO room_categories (property_id, name, code)
       VALUES ($1, 'Category B', $2) RETURNING id`,
      [propIdB, `CTB${randB}`]
    );

    // Room types
    const rtA = await client.query(
      `INSERT INTO room_types (property_id, room_category_id, name, code, base_rate, capacity)
       VALUES ($1, $2, 'Deluxe A', $3, 500000, 2) RETURNING id`,
      [propIdA, catA.rows[0].id, `DLA${randA}`]
    );
    roomTypeIdA = rtA.rows[0].id;

    const rtB = await client.query(
      `INSERT INTO room_types (property_id, room_category_id, name, code, base_rate, capacity)
       VALUES ($1, $2, 'Deluxe B', $3, 600000, 2) RETURNING id`,
      [propIdB, catB.rows[0].id, `DLB${randB}`]
    );
    roomTypeIdB = rtB.rows[0].id;

    // Physical rooms
    const rA = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES ($1, $2, $3, 'Deluxe A', 'VACANT_CLEAN', TRUE) RETURNING id`,
      [propIdA, roomTypeIdA, `101-${randA}`]
    );
    roomIdA = rA.rows[0].id;

    const rB = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES ($1, $2, $3, 'Deluxe B', 'VACANT_CLEAN', TRUE) RETURNING id`,
      [propIdB, roomTypeIdB, `201-${randB}`]
    );
    roomIdB = rB.rows[0].id;

    // Bookings & Reservations
    const bA = await client.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
       VALUES ($1, $2, 'Guest A', 'ACTIVE')
       RETURNING id`,
      [propIdA, `BID-A-${randA}`]
    );
    bookingIdA = bA.rows[0].id;

    const resA = await client.query(
      `INSERT INTO reservations (booking_id, room_id, guest_name, check_in, check_out, total_price, amount_paid, remaining_balance, status, stay_status, payment_status, stay_sequence)
       VALUES ($1, $2, 'Guest A', '2026-09-01', '2026-09-03', 1000000, 0, 1000000, 'BOOKED', 'RESERVED', 'UNPAID', 1)
       RETURNING id`,
      [bookingIdA, roomIdA]
    );
    resIdA = resA.rows[0].id;

    const bB = await client.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
       VALUES ($1, $2, 'Guest B', 'ACTIVE')
       RETURNING id`,
      [propIdB, `BID-B-${randB}`]
    );
    bookingIdB = bB.rows[0].id;

    const resB = await client.query(
      `INSERT INTO reservations (booking_id, room_id, guest_name, check_in, check_out, total_price, amount_paid, remaining_balance, status, stay_status, payment_status, stay_sequence)
       VALUES ($1, $2, 'Guest B', '2026-09-01', '2026-09-03', 1200000, 0, 1200000, 'BOOKED', 'RESERVED', 'UNPAID', 1)
       RETURNING id`,
      [bookingIdB, roomIdB]
    );
    resIdB = resB.rows[0].id;

    // POS Menu item for Property A
    const posCatA = await client.query(
      `INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, 'Beverages') RETURNING id`,
      [propIdA]
    );
    const posItemA = await client.query(
      `INSERT INTO pos_menu_items (property_id, category_id, name, price, is_active)
       VALUES ($1, $2, 'Kopi A', 25000, TRUE) RETURNING id`,
      [propIdA, posCatA.rows[0].id]
    );
    posItemIdA = posItemA.rows[0].id;

    // GL Account for Property B
    const glB = await client.query(
      `INSERT INTO accounting_gl_accounts (property_id, code, name, account_type)
       VALUES ($1, $2, 'Kas Property B', 'ASSET') RETURNING id`,
      [propIdB, `GL-B-${randB}`]
    );
    glAccountIdB = glB.rows[0].id;

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
    if (propIdA) {
      await client.query('DELETE FROM folio_entries WHERE property_id = $1', [propIdA]);
      await client.query('DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1))', [propIdA]);
      await client.query('DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1)', [propIdA]);
      await client.query('DELETE FROM bookings WHERE property_id = $1', [propIdA]);
      await client.query('DELETE FROM pos_menu_items WHERE property_id = $1', [propIdA]);
      await client.query('DELETE FROM pos_menu_categories WHERE property_id = $1', [propIdA]);
      await client.query('DELETE FROM rooms WHERE property_id = $1', [propIdA]);
      await client.query('DELETE FROM room_types WHERE property_id = $1', [propIdA]);
      await client.query('DELETE FROM room_categories WHERE property_id = $1', [propIdA]);
      await client.query('DELETE FROM properties WHERE id = $1', [propIdA]);
    }
    if (propIdB) {
      await client.query('DELETE FROM folio_entries WHERE property_id = $1', [propIdB]);
      await client.query('DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1))', [propIdB]);
      await client.query('DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1)', [propIdB]);
      await client.query('DELETE FROM bookings WHERE property_id = $1', [propIdB]);
      await client.query('DELETE FROM accounting_gl_accounts WHERE property_id = $1', [propIdB]);
      await client.query('DELETE FROM rooms WHERE property_id = $1', [propIdB]);
      await client.query('DELETE FROM room_types WHERE property_id = $1', [propIdB]);
      await client.query('DELETE FROM room_categories WHERE property_id = $1', [propIdB]);
      await client.query('DELETE FROM properties WHERE id = $1', [propIdB]);
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
  console.log('START: Cross-Property Multi-Tenant Isolation Negative Tests');
  console.log('======================================================\n');

  // 1. GET /api/reservations/:id with mismatching property_id
  {
    const res = await api('GET', `/api/reservations/${resIdA}?property_id=${propIdB}`);
    expect(res.status === 403 || res.status === 404, `GET /api/reservations/:id cross-property returns 403/404 (got ${res.status})`);
  }

  // 2. PATCH /api/reservations/:id with mismatching property_id
  {
    const res = await api('PATCH', `/api/reservations/${resIdA}`, {
      property_id: propIdB,
      guest_name: 'Hacked Guest Name'
    });
    expect(res.status === 403, `PATCH /api/reservations/:id cross-property returns 403 (got ${res.status})`);
  }

  // 3. POST /api/reservations/:id/cancel with mismatching property_id
  {
    const res = await api('POST', `/api/reservations/${resIdA}/cancel`, {
      property_id: propIdB,
      reason: 'Cross cancel attempt'
    });
    expect(res.status === 403 || res.status === 404, `POST /api/reservations/:id/cancel cross-property returns 403/404 (got ${res.status})`);
  }

  // 4. POST /api/reservations/:id/checkin with mismatching property_id
  {
    const res = await api('POST', `/api/reservations/${resIdA}/checkin`, {
      property_id: propIdB
    });
    expect(res.status === 403 || res.status === 404, `POST /api/reservations/:id/checkin cross-property returns 403/404 (got ${res.status})`);
  }

  // 5. POST /api/reservations/:id/checkout with mismatching property_id
  {
    const res = await api('POST', `/api/reservations/${resIdA}/checkout`, {
      property_id: propIdB
    });
    expect(res.status === 403 || res.status === 404, `POST /api/reservations/:id/checkout cross-property returns 403/404 (got ${res.status})`);
  }

  // 6. POST /api/stay-charges/post-charge with mismatching property_id
  {
    const res = await api('POST', '/api/stay-charges/post-charge', {
      property_id: propIdB,
      reservation_id: resIdA,
      charge_type: 'CUSTOM',
      custom_description: 'Cross Property Laundry',
      unit_price: 50000,
      quantity: 1
    });
    expect(res.status === 403, `POST /api/stay-charges/post-charge cross-property returns 403 (got ${res.status})`);
  }

  // 7. POST /api/reservations/:id/payments with mismatching property_id
  {
    const res = await api('POST', `/api/reservations/${resIdA}/payments`, {
      property_id: propIdB,
      amount: 100000,
      payment_method: 'CASH'
    });
    expect(res.status === 403, `POST /api/reservations/:id/payments cross-property returns 403 (got ${res.status})`);
  }

  // 8. POST /api/reservations/:id/move to room belonging to another property
  {
    const res = await api('POST', `/api/reservations/${resIdA}/move`, {
      property_id: propIdA,
      to_room_id: roomIdB
    });
    expect(res.status === 403 || res.status === 400, `POST /api/reservations/:id/move to another property room returns 403/400 (got ${res.status})`);
  }

  // 9. POST /api/reservations/:id/edit with mismatching property_id
  {
    const res = await api('POST', `/api/reservations/${resIdA}/edit`, {
      property_id: propIdB,
      guest_name: 'Cross Property Edit'
    });
    expect(res.status === 403, `POST /api/reservations/:id/edit cross-property returns 403 (got ${res.status})`);
  }

  // 10. POST /api/reservations/:id/edit targeting room belonging to another property
  {
    const res = await api('POST', `/api/reservations/${resIdA}/edit`, {
      property_id: propIdA,
      room_id: roomIdB
    });
    expect(res.status === 403, `POST /api/reservations/:id/edit with cross-property room returns 403 (got ${res.status})`);
  }

  // 11. DELETE /api/pos/menu/items/:id with mismatching property_id
  {
    const res = await api('DELETE', `/api/pos/menu/items/${posItemIdA}?property_id=${propIdB}`);
    expect(res.status === 404, `DELETE /api/pos/menu/items/:id cross-property returns 404 (got ${res.status})`);

    // Verify item A is still active in DB
    const itemCheck = await pool.query('SELECT is_active FROM pos_menu_items WHERE id = $1', [posItemIdA]);
    expect(itemCheck.rows[0]?.is_active === true, 'Menu item A was not deactivated by Property B request');
  }

  // 12. POST /api/accounting/journal with GL account belonging to another property
  {
    const res = await api('POST', '/api/accounting/journal', {
      property_id: propIdA,
      description: 'Cross property journal test',
      lines: [
        { account_id: glAccountIdB, debit: 100000, credit: 0 }
      ]
    });
    expect(res.status === 403, `POST /api/accounting/journal cross-property account returns 403 (got ${res.status})`);
  }

  // 13. POST /api/accounting/receivables with reservation belonging to another property
  {
    const res = await api('POST', '/api/accounting/receivables', {
      property_id: propIdA,
      reservation_id: resIdB,
      guest_name: 'Guest B',
      total_amount: 1200000
    });
    expect(res.status === 403, `POST /api/accounting/receivables cross-property reservation returns 403 (got ${res.status})`);
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

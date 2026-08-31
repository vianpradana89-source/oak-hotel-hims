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

// Tracked fixtures for deterministic cleanup
const tracked = {
  properties: [],
  roomCategories: [],
  roomTypes: [],
  bookings: [],
  reservations: [],
  categories: [],
  items: [],
  orders: [],
  orderItems: []
};

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

async function safe(fn) {
  try { return await fn(); } catch (e) { return null; }
}

// ─── FIXTURE SETUP ──────────────────────────────────────────────────────────

async function setupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Two isolated test properties
    const propA = await client.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('POS Order Prop A', 'POCA', 'Asia/Jakarta', 'IDR', 'Addr A', TRUE) RETURNING id"
    );
    tracked.properties.push(propA.rows[0].id);

    const propB = await client.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('POS Order Prop B', 'POCB', 'Asia/Jakarta', 'IDR', 'Addr B', TRUE) RETURNING id"
    );
    tracked.properties.push(propB.rows[0].id);

    const pidA = propA.rows[0].id;
    const pidB = propB.rows[0].id;

    // Room categories and room types for reservation testing
    const rcB = await client.query(
      "INSERT INTO room_categories (property_id, code, name) VALUES ($1, 'CATB', 'Category B') RETURNING id",
      [pidB]
    );
    tracked.roomCategories.push(rcB.rows[0].id);

    const rtB = await client.query(
      `INSERT INTO room_types (property_id, code, name, room_category_id, capacity, max_adults, max_children, is_active, display_order, base_rate)
       VALUES ($1, 'RTB', 'Room Type B', $2, 2, 2, 0, TRUE, 10, 500000) RETURNING id`,
      [pidB, rcB.rows[0].id]
    );
    tracked.roomTypes.push(rtB.rows[0].id);

    const roomB = await client.query(
      `INSERT INTO rooms (property_id, room_number, room_type_id, is_active)
       VALUES ($1, 'R201', $2, TRUE) RETURNING id`,
      [pidB, rtB.rows[0].id]
    );

    // Booking and reservation in Property B
    const bookingB = await client.query(
      "INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status) VALUES ('BID-POCB-01', $1, 'Guest B Snapshot', 'ACTIVE') RETURNING id",
      [pidB]
    );
    tracked.bookings.push(bookingB.rows[0].id);

    const resB = await client.query(
      `INSERT INTO reservations (booking_id, room_id, status, stay_status, check_in, check_out, booked_room_type_id_snapshot, guest_name, stay_sequence)
       VALUES ($1, $2, 'BOOKED', 'RESERVED', CURRENT_DATE + 5, CURRENT_DATE + 6, $3, 'Guest B', 1)
       RETURNING id`,
      [bookingB.rows[0].id, roomB.rows[0].id, rtB.rows[0].id]
    );
    tracked.reservations.push(resB.rows[0].id);

    // POS menu for each property
    const catA = await client.query(
      'INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, $2) RETURNING id',
      [pidA, 'Food A']
    );
    tracked.categories.push(catA.rows[0].id);

    const catB = await client.query(
      'INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, $2) RETURNING id',
      [pidB, 'Food B']
    );
    tracked.categories.push(catB.rows[0].id);

    const itemA = await client.query(
      'INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, is_active) VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id',
      [pidA, catA.rows[0].id, 'POC-A-001', 'Item A', 25000]
    );
    tracked.items.push(itemA.rows[0].id);

    const itemB = await client.query(
      'INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, is_active) VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id',
      [pidB, catB.rows[0].id, 'POC-B-001', 'Item B', 30000]
    );
    tracked.items.push(itemB.rows[0].id);

    await client.query('COMMIT');
    return {
      pidA,
      pidB,
      catA: catA.rows[0].id,
      catB: catB.rows[0].id,
      itemA: itemA.rows[0].id,
      itemB: itemB.rows[0].id,
      resB: resB.rows[0].id
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── CLEANUP ─────────────────────────────────────────────────────────────────

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 0. Delete transactions
    await client.query(`
      DELETE FROM transactions WHERE property_id IN (
        SELECT id FROM properties WHERE property_code IN ('POCA', 'POCB')
      )
    `);

    // 1. Delete POS order items and POS orders for test properties
    await client.query(`
      DELETE FROM pos_order_items WHERE order_id IN (
        SELECT id FROM pos_orders WHERE property_id IN (
          SELECT id FROM properties WHERE property_code IN ('POCA', 'POCB')
        )
      )
    `);
    await client.query(`
      DELETE FROM pos_orders WHERE property_id IN (
        SELECT id FROM properties WHERE property_code IN ('POCA', 'POCB')
      )
    `);

    // 2. Delete POS menu items & categories
    await client.query(`
      DELETE FROM pos_menu_items WHERE property_id IN (
        SELECT id FROM properties WHERE property_code IN ('POCA', 'POCB')
      )
    `);
    await client.query(`
      DELETE FROM pos_menu_categories WHERE property_id IN (
        SELECT id FROM properties WHERE property_code IN ('POCA', 'POCB')
      )
    `);

    // 3. Delete reservations & bookings
    await client.query(`
      DELETE FROM reservations WHERE booking_id IN (
        SELECT id FROM bookings WHERE property_id IN (
          SELECT id FROM properties WHERE property_code IN ('POCA', 'POCB')
        ) OR bid LIKE 'BID-POCB-%'
      )
    `);
    await client.query(`
      DELETE FROM bookings WHERE property_id IN (
        SELECT id FROM properties WHERE property_code IN ('POCA', 'POCB')
      ) OR bid LIKE 'BID-POCB-%'
    `);

    // 4. Delete rooms, availability_dates, room types & categories
    await client.query(`
      DELETE FROM availability_dates WHERE room_type_id IN (
        SELECT id FROM room_types WHERE property_id IN (
          SELECT id FROM properties WHERE property_code IN ('POCA', 'POCB')
        )
      )
    `);
    await client.query(`
      DELETE FROM rooms WHERE property_id IN (
        SELECT id FROM properties WHERE property_code IN ('POCA', 'POCB')
      )
    `);
    await client.query(`
      DELETE FROM room_types WHERE property_id IN (
        SELECT id FROM properties WHERE property_code IN ('POCA', 'POCB')
      )
    `);
    await client.query(`
      DELETE FROM room_categories WHERE property_id IN (
        SELECT id FROM properties WHERE property_code IN ('POCA', 'POCB')
      )
    `);

    // 5. Delete test properties
    await client.query("DELETE FROM properties WHERE property_code IN ('POCA', 'POCB')");

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('CLEANUP FAILED:', e.message);
    failed += 1;
  } finally {
    client.release();
  }
}

// ─── TESTS ───────────────────────────────────────────────────────────────────

// A. missing property_id → 400 (GET, POST, PATCH)
async function testA_missingPropertyId(itemA) {
  const rGet = await api('GET', '/api/pos/orders');
  expect(rGet.status === 400, 'A1: GET /api/pos/orders without property_id returns 400 (got ' + rGet.status + ')');
  expect(rGet.json && rGet.json.code === 'VALIDATION_ERROR', 'A1: error code is VALIDATION_ERROR');

  const rPost = await api('POST', '/api/pos/orders', {
    items: [{ menu_item_id: itemA, quantity: 1 }]
  });
  expect(rPost.status === 400, 'A2: POST /api/pos/orders without property_id returns 400 (got ' + rPost.status + ')');
  expect(rPost.json && rPost.json.code === 'VALIDATION_ERROR', 'A2: error code is VALIDATION_ERROR');

  const rPatch = await api('PATCH', '/api/pos/orders/999999/status', { status: 'CLOSED' });
  expect(rPatch.status === 400, 'A3: PATCH /api/pos/orders/:id/status without property_id returns 400 (got ' + rPatch.status + ')');
  expect(rPatch.json && rPatch.json.code === 'VALIDATION_ERROR', 'A3: error code is VALIDATION_ERROR');
}

// B. unknown property → 404 (GET, POST, PATCH)
async function testB_unknownProperty(itemA) {
  const rGet = await api('GET', '/api/pos/orders?property_id=999999');
  expect(rGet.status === 404, 'B1: GET with unknown property returns 404 (got ' + rGet.status + ')');
  expect(rGet.json && rGet.json.code === 'PROPERTY_NOT_FOUND', 'B1: error code is PROPERTY_NOT_FOUND');

  const rPost = await api('POST', '/api/pos/orders', {
    property_id: 999999,
    items: [{ menu_item_id: itemA, quantity: 1 }]
  });
  expect(rPost.status === 404, 'B2: POST with unknown property returns 404 (got ' + rPost.status + ')');
  expect(rPost.json && rPost.json.code === 'PROPERTY_NOT_FOUND', 'B2: error code is PROPERTY_NOT_FOUND');

  const rPatch = await api('PATCH', '/api/pos/orders/999999/status', {
    property_id: 999999,
    status: 'CLOSED'
  });
  expect(rPatch.status === 404, 'B3: PATCH with unknown property returns 404 (got ' + rPatch.status + ')');
  expect(rPatch.json && rPatch.json.code === 'PROPERTY_NOT_FOUND', 'B3: error code is PROPERTY_NOT_FOUND');
}

// C & D. Property A sees only A orders; Property B sees only B orders
async function testCD_propertyReadIsolation(pidA, pidB, itemA, itemB) {
  const rCreateA = await api('POST', '/api/pos/orders', {
    property_id: pidA,
    table_number: 'Table A1',
    guest_name: 'Guest A',
    items: [{ menu_item_id: itemA, quantity: 2 }]
  });
  expect(rCreateA.status === 201, 'C1: create order for Property A succeeds (got ' + rCreateA.status + ')');
  const orderAId = rCreateA.json?.data?.id;

  const rCreateB = await api('POST', '/api/pos/orders', {
    property_id: pidB,
    table_number: 'Table B1',
    guest_name: 'Guest B',
    items: [{ menu_item_id: itemB, quantity: 1 }]
  });
  expect(rCreateB.status === 201, 'D1: create order for Property B succeeds (got ' + rCreateB.status + ')');
  const orderBId = rCreateB.json?.data?.id;

  const rA = await api('GET', '/api/pos/orders?property_id=' + pidA);
  expect(rA.status === 200, 'C2: GET Property A orders returns 200');
  const aOrderIds = (rA.json?.data || []).map(o => o.id);
  expect(aOrderIds.includes(orderAId), 'C3: Property A list includes order A');
  expect(!aOrderIds.includes(orderBId), 'C4: Property A list excludes order B');

  const rB = await api('GET', '/api/pos/orders?property_id=' + pidB);
  expect(rB.status === 200, 'D2: GET Property B orders returns 200');
  const bOrderIds = (rB.json?.data || []).map(o => o.id);
  expect(bOrderIds.includes(orderBId), 'D3: Property B list includes order B');
  expect(!bOrderIds.includes(orderAId), 'D4: Property B list excludes order A');

  return { orderAId, orderBId };
}

// E. same order_number allowed across different properties
async function testE_sameOrderNumberAcrossProperties(pidA, pidB) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO pos_orders (property_id, order_number, table_number, guest_name, total_amount, status) VALUES ($1, 'SHARED-NUM-001', 'T1', 'G1', 10000, 'OPEN')",
      [pidA]
    );
    await client.query(
      "INSERT INTO pos_orders (property_id, order_number, table_number, guest_name, total_amount, status) VALUES ($1, 'SHARED-NUM-001', 'T2', 'G2', 15000, 'OPEN')",
      [pidB]
    );
    await client.query('COMMIT');
    expect(true, 'E: same order_number allowed across different properties (A and B)');
  } catch (e) {
    await client.query('ROLLBACK');
    expect(false, 'E: same order_number across different properties failed: ' + e.message);
  } finally {
    client.release();
  }
}

// F. duplicate order_number rejected within same property
async function testF_duplicateOrderNumberSamePropertyRejected(pidA) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO pos_orders (property_id, order_number, table_number, guest_name, total_amount, status) VALUES ($1, 'DUP-NUM-001', 'T1', 'G1', 10000, 'OPEN')",
      [pidA]
    );
    let duplicateRejected = false;
    try {
      await client.query(
        "INSERT INTO pos_orders (property_id, order_number, table_number, guest_name, total_amount, status) VALUES ($1, 'DUP-NUM-001', 'T2', 'G2', 20000, 'OPEN')",
        [pidA]
      );
    } catch (err) {
      duplicateRejected = true;
    }
    expect(duplicateRejected, 'F: duplicate order_number within same property is rejected by UNIQUE constraint');
    await client.query('ROLLBACK');
  } catch (e) {
    await client.query('ROLLBACK');
    expect(false, 'F: unexpected failure in duplicate test: ' + e.message);
  } finally {
    client.release();
  }
}

// G. Property A cannot create order using Property B menu item
async function testG_crossPropertyMenuItemRejected(pidA, itemB) {
  const r = await api('POST', '/api/pos/orders', {
    property_id: pidA,
    table_number: 'T1',
    guest_name: 'Guest A',
    items: [{ menu_item_id: itemB, quantity: 1 }]
  });
  expect(r.status === 403, 'G: cross-property menu item rejected with 403 (got ' + r.status + ')');
  expect(r.json && r.json.code === 'CROSS_PROPERTY_MENU_ITEM', 'G: error code is CROSS_PROPERTY_MENU_ITEM');
}

// H. cross-property reservation linkage rejected
async function testH_crossPropertyReservationRejected(pidA, resB, itemA) {
  const r = await api('POST', '/api/pos/orders', {
    property_id: pidA,
    reservation_id: resB, // belongs to pidB
    table_number: 'Room Charge',
    guest_name: 'Guest A',
    items: [{ menu_item_id: itemA, quantity: 1 }]
  });
  expect(r.status === 403, 'H: cross-property reservation linkage rejected with 403 (got ' + r.status + ')');
  expect(r.json && r.json.code === 'CROSS_PROPERTY_RESERVATION', 'H: error code is CROSS_PROPERTY_RESERVATION');
}

// I. cross-property status mutation rejected
async function testI_crossPropertyStatusMutationRejected(pidA, orderBId) {
  const r = await api('PATCH', '/api/pos/orders/' + orderBId + '/status', {
    property_id: pidA,
    status: 'CLOSED'
  });
  expect(r.status === 403, 'I: cross-property status mutation rejected with 403 (got ' + r.status + ')');
  expect(r.json && r.json.code === 'CROSS_PROPERTY_ORDER', 'I: error code is CROSS_PROPERTY_ORDER');
}

// J & K. failed multi-item order leaves no partial pos_orders or pos_order_items
async function testJK_noPartialOrderOrItems(pidA, itemA, itemB) {
  const beforeOrders = await pool.query('SELECT COUNT(*)::int AS c FROM pos_orders WHERE property_id = $1', [pidA]);
  const beforeItems = await pool.query('SELECT COUNT(*)::int AS c FROM pos_order_items');

  // Attempt multi-item order where second item belongs to Property B
  const r = await api('POST', '/api/pos/orders', {
    property_id: pidA,
    table_number: 'T-Multi',
    guest_name: 'Guest Multi',
    items: [
      { menu_item_id: itemA, quantity: 2 },
      { menu_item_id: itemB, quantity: 1 } // illegal cross-property item
    ]
  });
  expect(r.status === 403, 'J/K: multi-item order with cross-property item rejected with 403 (got ' + r.status + ')');

  const afterOrders = await pool.query('SELECT COUNT(*)::int AS c FROM pos_orders WHERE property_id = $1', [pidA]);
  const afterItems = await pool.query('SELECT COUNT(*)::int AS c FROM pos_order_items');

  expect(afterOrders.rows[0].c === beforeOrders.rows[0].c, 'J: failed order leaves zero partial pos_orders rows');
  expect(afterItems.rows[0].c === beforeItems.rows[0].c, 'K: failed order leaves zero partial pos_order_items rows');
}

// L. property switching does not leak order data
async function testL_propertySwitchingIsolation(pidA, pidB) {
  const rA = await api('GET', '/api/pos/orders?property_id=' + pidA);
  const rB = await api('GET', '/api/pos/orders?property_id=' + pidB);

  const ordersA = rA.json?.data || [];
  const ordersB = rB.json?.data || [];

  const allAValid = ordersA.every(o => Number(o.property_id) === pidA);
  const allBValid = ordersB.every(o => Number(o.property_id) === pidB);

  expect(allAValid, 'L1: all orders returned for Property A belong to Property A');
  expect(allBValid, 'L2: all orders returned for Property B belong to Property B');
}

// M. valid same-property order succeeds
async function testM_validSamePropertyOrderSucceeds(pidA, itemA) {
  const r = await api('POST', '/api/pos/orders', {
    property_id: pidA,
    table_number: 'Table Valid',
    guest_name: 'Valid Guest',
    items: [{ menu_item_id: itemA, quantity: 3, notes: 'Extra spicy' }]
  });

  expect(r.status === 201, 'M1: valid order creation returns 201 (got ' + r.status + ')');
  expect(r.json?.status === 'SUCCESS', 'M2: response status is SUCCESS');
  expect(Number(r.json?.data?.property_id) === pidA, 'M3: returned order has correct property_id');
  expect(Number(r.json?.data?.total_amount) === 75000, 'M4: returned order has correct total_amount');
  return r.json?.data?.id;
}

// N. valid same-property status update succeeds
async function testN_validSamePropertyStatusUpdateSucceeds(pidA, orderId) {
  const r = await api('PATCH', '/api/pos/orders/' + orderId + '/status', {
    property_id: pidA,
    status: 'PAID'
  });

  expect(r.status === 200, 'N1: valid status update returns 200 (got ' + r.status + ')');
  expect(r.json?.status === 'SUCCESS', 'N2: response status is SUCCESS');
  expect(r.json?.data?.status === 'PAID', 'N3: returned order has updated status PAID');
}

// P. zero fixture residue after test
async function testP_zeroFixtureResidue() {
  const pCount = await pool.query(
    "SELECT COUNT(*)::int AS c FROM properties WHERE property_code IN ('POCA', 'POCB')"
  );
  expect(pCount.rows[0].c === 0, 'P1: zero test properties residue');

  const rcCount = await pool.query(
    "SELECT COUNT(*)::int AS c FROM room_categories WHERE code = 'CATB'"
  );
  expect(rcCount.rows[0].c === 0, 'P2: zero test room_categories residue');

  const bCount = await pool.query(
    "SELECT COUNT(*)::int AS c FROM bookings WHERE bid = 'BID-POCB-01'"
  );
  expect(bCount.rows[0].c === 0, 'P3: zero test bookings residue');
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const serverReady = new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  await serverReady;
  const address = server.address();
  baseUrl = 'http://127.0.0.1:' + address.port;

  let fixtures;
  try {
    await initializeDatabase(pool);
    await cleanup();
    fixtures = await setupFixtures();

    await testA_missingPropertyId(fixtures.itemA);
    await testB_unknownProperty(fixtures.itemA);
    const { orderAId, orderBId } = await testCD_propertyReadIsolation(
      fixtures.pidA,
      fixtures.pidB,
      fixtures.itemA,
      fixtures.itemB
    );
    await testE_sameOrderNumberAcrossProperties(fixtures.pidA, fixtures.pidB);
    await testF_duplicateOrderNumberSamePropertyRejected(fixtures.pidA);
    await testG_crossPropertyMenuItemRejected(fixtures.pidA, fixtures.itemB);
    await testH_crossPropertyReservationRejected(fixtures.pidA, fixtures.resB, fixtures.itemA);
    await testI_crossPropertyStatusMutationRejected(fixtures.pidA, orderBId);
    await testJK_noPartialOrderOrItems(fixtures.pidA, fixtures.itemA, fixtures.itemB);
    await testL_propertySwitchingIsolation(fixtures.pidA, fixtures.pidB);
    const validOrderId = await testM_validSamePropertyOrderSucceeds(fixtures.pidA, fixtures.itemA);
    await testN_validSamePropertyStatusUpdateSucceeds(fixtures.pidA, validOrderId);
  } finally {
    // O. deterministic cleanup
    await cleanup();
    await testP_zeroFixtureResidue();
    await once(server.close(), 'close');
  }

  console.log('Property-scoped POS order: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Property-scoped POS order test failed:', err.message);
  process.exitCode = 1;
});

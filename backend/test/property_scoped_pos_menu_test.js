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
const tracked = { properties: [], categories: [], items: [] };

function expect(condition, msg) {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error('FAIL: ' + msg);
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

async function expectConstraintFailure(fn, label) {
  let failedAsExpected = false;
  try {
    await fn();
  } catch (e) {
    failedAsExpected = true;
    expect(Boolean(e), label + ' throws');
  }
  expect(failedAsExpected, label + ' fails as expected');
}

async function setupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const propA = await client.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('POS Prop A', 'POSA', 'Asia/Jakarta', 'IDR', 'POS A Address', TRUE) RETURNING id"
    );
    tracked.properties.push(propA.rows[0].id);

    const propB = await client.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('POS Prop B', 'POSB', 'Asia/Jakarta', 'IDR', 'POS B Address', TRUE) RETURNING id"
    );
    tracked.properties.push(propB.rows[0].id);

    const pidA = propA.rows[0].id;
    const pidB = propB.rows[0].id;

    const catA = await client.query(
      'INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, $2) RETURNING id',
      [pidA, 'Breakfast']
    );
    tracked.categories.push(catA.rows[0].id);

    const catB = await client.query(
      'INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, $2) RETURNING id',
      [pidB, 'Breakfast']
    );
    tracked.categories.push(catB.rows[0].id);

    const itemA = await client.query(
      'INSERT INTO pos_menu_items (property_id, category_id, item_code, name, description, price, is_active) VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING id',
      [pidA, catA.rows[0].id, 'BR-001', 'Nasi Goreng', 'Prop A item', 35000,]
    );
    tracked.items.push(itemA.rows[0].id);

    const itemB = await client.query(
      'INSERT INTO pos_menu_items (property_id, category_id, item_code, name, description, price, is_active) VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING id',
      [pidB, catB.rows[0].id, 'BR-001', 'Nasi Goreng', 'Prop B item', 42000,]
    );
    tracked.items.push(itemB.rows[0].id);

    await client.query('COMMIT');
    return { pidA, pidB, catA: catA.rows[0].id, catB: catB.rows[0].id, itemA: itemA.rows[0].id, itemB: itemB.rows[0].id };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const itemId of tracked.items) {
      await safe(() => client.query('DELETE FROM pos_menu_items WHERE id = $1', [itemId]));
    }
    for (const catId of tracked.categories) {
      await safe(() => client.query('DELETE FROM pos_menu_categories WHERE id = $1', [catId]));
    }
    for (const pid of tracked.properties) {
      await safe(() => client.query('DELETE FROM properties WHERE id = $1', [pid]));
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('CLEANUP FAILED:', e.message);
    failed += 1;
  } finally {
    client.release();
  }
}

async function testA_missingPropertyId() {
  const r = await api('GET', '/api/pos/menu');
  expect(r.status === 400, 'A: missing property_id -> 400 (got ' + r.status + ')');
  expect(r.json && r.json.code === 'VALIDATION_ERROR', 'A: validation code is VALIDATION_ERROR');
}

async function testB_unknownProperty() {
  const r = await api('GET', '/api/pos/menu?property_id=999999');
  expect(r.status === 404, 'B: unknown property -> 404 (got ' + r.status + ')');
  expect(r.json && r.json.code === 'PROPERTY_NOT_FOUND', 'B: PROPERTY_NOT_FOUND code');
}

async function testC_propertyAScope(pidA, pidB) {
  const rA = await api('GET', '/api/pos/menu?property_id=' + pidA);
  expect(rA.status === 200, 'C: property A menu returns 200 (got ' + rA.status + ')');
  const catNamesA = (rA.json && rA.json.data && rA.json.data.categories) ? rA.json.data.categories.map(c => c.name) : [];
  const itemCodesA = (rA.json && rA.json.data && rA.json.data.items) ? rA.json.data.items.map(i => i.item_code) : [];
  expect(catNamesA.includes('Breakfast'), 'C: property A includes Breakfast category');
  expect(itemCodesA.includes('BR-001'), 'C: property A includes its own item code');

  const rB = await api('GET', '/api/pos/menu?property_id=' + pidB);
  expect(rB.status === 200, 'C: property B menu returns 200 (got ' + rB.status + ')');
  const catNamesB = (rB.json && rB.json.data && rB.json.data.categories) ? rB.json.data.categories.map(c => c.name) : [];
  const itemCodesB = (rB.json && rB.json.data && rB.json.data.items) ? rB.json.data.items.map(i => i.item_code) : [];
  expect(catNamesB.includes('Breakfast'), 'C: property B includes Breakfast category');
  expect(itemCodesB.includes('BR-001'), 'C: property B includes its own item code');

  expect(!catNamesA.includes('Property B Only'), 'C: property A does not carry B-only category names');
  expect(!itemCodesA.includes('B-ONLY-001'), 'C: property A does not carry B-only item codes');
  expect(!catNamesB.includes('Property A Only'), 'C: property B does not carry A-only category names');
  expect(!itemCodesB.includes('A-ONLY-001'), 'C: property B does not carry A-only item codes');
}

async function testD_crossPropertyNoLeak(pidA, pidB) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const catAOnly = await client.query(
      'INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, $2) RETURNING id',
      [pidA, 'Property A Only']
    );
    tracked.categories.push(catAOnly.rows[0].id);
    const itemAOnly = await client.query(
      'INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, is_active) VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id',
      [pidA, catAOnly.rows[0].id, 'A-ONLY-001', 'A Only Item', 20000]
    );
    tracked.items.push(itemAOnly.rows[0].id);

    const catBOnly = await client.query(
      'INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, $2) RETURNING id',
      [pidB, 'Property B Only']
    );
    tracked.categories.push(catBOnly.rows[0].id);
    const itemBOnly = await client.query(
      'INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, is_active) VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id',
      [pidB, catBOnly.rows[0].id, 'B-ONLY-001', 'B Only Item', 25000]
    );
    tracked.items.push(itemBOnly.rows[0].id);

    await client.query('COMMIT');

    const aMenu = await api('GET', '/api/pos/menu?property_id=' + pidA);
    const bMenu = await api('GET', '/api/pos/menu?property_id=' + pidB);

    const aCategoryNames = (aMenu.json && aMenu.json.data && aMenu.json.data.categories) ? aMenu.json.data.categories.map(c => c.name) : [];
    const aItemCodes = (aMenu.json && aMenu.json.data && aMenu.json.data.items) ? aMenu.json.data.items.map(i => i.item_code) : [];
    const bCategoryNames = (bMenu.json && bMenu.json.data && bMenu.json.data.categories) ? bMenu.json.data.categories.map(c => c.name) : [];
    const bItemCodes = (bMenu.json && bMenu.json.data && bMenu.json.data.items) ? bMenu.json.data.items.map(i => i.item_code) : [];

    expect(aCategoryNames.includes('Property A Only'), 'D: property A includes A-only category');
    expect(!aCategoryNames.includes('Property B Only'), 'D: property A excludes B-only category');
    expect(aItemCodes.includes('A-ONLY-001'), 'D: property A includes A-only item');
    expect(!aItemCodes.includes('B-ONLY-001'), 'D: property A excludes B-only item');

    expect(bCategoryNames.includes('Property B Only'), 'D: property B includes B-only category');
    expect(!bCategoryNames.includes('Property A Only'), 'D: property B excludes A-only category');
    expect(bItemCodes.includes('B-ONLY-001'), 'D: property B includes B-only item');
    expect(!bItemCodes.includes('A-ONLY-001'), 'D: property B excludes A-only item');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function testE_sameNameAndCodeAcrossPropertiesAllowed(pidA, pidB) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sharedCatA = await client.query(
      'INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, $2) RETURNING id',
      [pidA, 'Shared Category']
    );
    tracked.categories.push(sharedCatA.rows[0].id);
    const sharedCatB = await client.query(
      'INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, $2) RETURNING id',
      [pidB, 'Shared Category']
    );
    tracked.categories.push(sharedCatB.rows[0].id);

    const sharedItemA = await client.query(
      'INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, is_active) VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id',
      [pidA, sharedCatA.rows[0].id, 'SHARED-100', 'Shared Item A', 15000]
    );
    tracked.items.push(sharedItemA.rows[0].id);
    const sharedItemB = await client.query(
      'INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, is_active) VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id',
      [pidB, sharedCatB.rows[0].id, 'SHARED-100', 'Shared Item B', 18000]
    );
    tracked.items.push(sharedItemB.rows[0].id);

    await client.query('COMMIT');

    const aMenu = await api('GET', '/api/pos/menu?property_id=' + pidA);
    const bMenu = await api('GET', '/api/pos/menu?property_id=' + pidB);
    expect(aMenu.status === 200 && aMenu.json.data.categories.some(c => c.name === 'Shared Category'), 'E: property A keeps shared category');
    expect(bMenu.status === 200 && bMenu.json.data.categories.some(c => c.name === 'Shared Category'), 'E: property B keeps shared category');
    expect(aMenu.json.data.items.some(i => i.item_code === 'SHARED-100'), 'E: property A keeps shared item code');
    expect(bMenu.json.data.items.some(i => i.item_code === 'SHARED-100'), 'E: property B keeps shared item code');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function testF_samePropertyCategoryDuplicateRejected(pidA) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expectConstraintFailure(
      () => client.query('INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, $2)', [pidA, 'Breakfast']),
      'F: duplicate category in same property rejected'
    );
    await client.query('ROLLBACK');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function testG_samePropertyItemCodeDuplicateRejected(pidA, catA) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expectConstraintFailure(
      () => client.query('INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, is_active) VALUES ($1, $2, $3, $4, $5, TRUE)', [pidA, catA, 'BR-001', 'Duplicate Item', 10000]),
      'G: duplicate item_code in same property rejected'
    );
    await client.query('ROLLBACK');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function testH_crossPropertyCategoryItemRelationRejected(pidA, pidB, catB) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expectConstraintFailure(
      () => client.query('INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, is_active) VALUES ($1, $2, $3, $4, $5, TRUE)', [pidA, catB, 'A-CROSS-001', 'Cross Property Item', 12000]),
      'H: item must match category property'
    );
    await client.query('ROLLBACK');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function main() {
  const serverReady = new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  await serverReady;
  const address = server.address();
  baseUrl = 'http://127.0.0.1:' + address.port;

  try {
    await initializeDatabase(pool);
    const fixtures = await setupFixtures();
    await testA_missingPropertyId();
    await testB_unknownProperty();
    await testC_propertyAScope(fixtures.pidA, fixtures.pidB);
    await testD_crossPropertyNoLeak(fixtures.pidA, fixtures.pidB);
    await testE_sameNameAndCodeAcrossPropertiesAllowed(fixtures.pidA, fixtures.pidB);
    await testF_samePropertyCategoryDuplicateRejected(fixtures.pidA);
    await testG_samePropertyItemCodeDuplicateRejected(fixtures.pidA, fixtures.catA);
    await testH_crossPropertyCategoryItemRelationRejected(fixtures.pidA, fixtures.pidB, fixtures.catB);
  } finally {
    await cleanup();
    await once(server.close(), 'close');
  }

  console.log('Property-scoped POS menu: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Property-scoped POS menu test failed:', err.message);
  process.exitCode = 1;
});

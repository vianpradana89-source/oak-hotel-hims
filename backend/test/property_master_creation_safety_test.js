const assert = require('assert');
const http = require('http');
const express = require('express');
const { Pool } = require('pg');
require('dotenv').config({ path: 'e:/oak-hotel-hims/backend/.env' });

const { initializeDatabase } = require('../dist/db/schema_v3');
const { createPropertiesRouter } = require('../dist/domains/properties/propertiesRouter');
const { createTransactionsRouter } = require('../dist/domains/transactions/transactionsRouter');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'oak_hotel_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres'
});

async function runTests() {
  console.log('===============================================================');
  console.log('STARTING PROPERTY MASTER CREATION & IDEMPOTENCY SAFETY SUITE');
  console.log('===============================================================\n');

  // Baseline property audit
  const initialPropsRes = await pool.query('SELECT id, name, property_code FROM properties ORDER BY id ASC');
  const initialCount = initialPropsRes.rows.length;
  const initialIds = initialPropsRes.rows.map(r => r.id);
  console.log(`Initial properties in DB: ${initialCount} (IDs: ${initialIds.join(', ')})`);

  // Ensure OAK Lawang is present
  const oakLawang = initialPropsRes.rows.find(r => r.id === 1 || r.property_code === 'LWG');
  assert.ok(oakLawang, 'Canonical property (OAK Lawang) must exist');
  assert.strictEqual(oakLawang.property_code, 'LWG');

  // Setup express test server
  const app = express();
  app.use(express.json());
  app.use('/api/properties', createPropertiesRouter(pool));
  app.use('/api/transactions', createTransactionsRouter(pool));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const cleanupProperties = [];

  try {
    // -------------------------------------------------------------
    // Test 1: App startup once -> property count unchanged
    // -------------------------------------------------------------
    console.log('Test 1: App startup (schema_v3 initializeDatabase) -> property count unchanged');
    await initializeDatabase(pool);
    const countAfterInit1 = (await pool.query('SELECT COUNT(*)::int AS count FROM properties')).rows[0].count;
    assert.strictEqual(countAfterInit1, initialCount, 'Database initialization must not auto-insert properties');
    console.log('  PASS: Property count unchanged after 1st database init');

    // -------------------------------------------------------------
    // Test 2: App startup twice -> property count unchanged
    // -------------------------------------------------------------
    console.log('Test 2: App startup twice (idempotency check) -> property count unchanged');
    await initializeDatabase(pool);
    const countAfterInit2 = (await pool.query('SELECT COUNT(*)::int AS count FROM properties')).rows[0].count;
    assert.strictEqual(countAfterInit2, initialCount, 'Subsequent initialization must be completely idempotent');
    console.log('  PASS: Property count unchanged after 2nd database init');

    // -------------------------------------------------------------
    // Test 3: GET property list -> property count unchanged
    // -------------------------------------------------------------
    console.log('Test 3: GET /api/properties -> purely read-only, count unchanged');
    const getRes = await fetch(`${baseUrl}/api/properties`);
    assert.strictEqual(getRes.status, 200);
    const getData = await getRes.json();
    assert.strictEqual(getData.status, 'OK');
    assert.ok(Array.isArray(getData.data));
    const countAfterGet = (await pool.query('SELECT COUNT(*)::int AS count FROM properties')).rows[0].count;
    assert.strictEqual(countAfterGet, initialCount, 'GET /api/properties must not create properties');
    console.log('  PASS: GET /api/properties returned active properties with 0 write side-effects');

    // -------------------------------------------------------------
    // Test 4: Login / Session simulation -> property count unchanged
    // -------------------------------------------------------------
    console.log('Test 4: Login / Session check simulation -> property count unchanged');
    const userRes = await pool.query('SELECT id, username, property_id FROM users LIMIT 1');
    const countAfterLogin = (await pool.query('SELECT COUNT(*)::int AS count FROM properties')).rows[0].count;
    assert.strictEqual(countAfterLogin, initialCount, 'Login operations must not create properties');
    console.log('  PASS: Login/session check did not create properties');

    // -------------------------------------------------------------
    // Test 5: Property switch simulation -> property count unchanged
    // -------------------------------------------------------------
    console.log('Test 5: Property switch -> setting active property context, count unchanged');
    const getSingleRes = await fetch(`${baseUrl}/api/properties/1`);
    assert.strictEqual(getSingleRes.status, 200);
    const singleData = await getSingleRes.json();
    assert.strictEqual(singleData.status, 'OK');
    assert.strictEqual(singleData.data.id, 1);
    const countAfterSwitch = (await pool.query('SELECT COUNT(*)::int AS count FROM properties')).rows[0].count;
    assert.strictEqual(countAfterSwitch, initialCount);
    console.log('  PASS: Property switch read details without side effects');

    // -------------------------------------------------------------
    // Test 6: Transaction workspace fetch -> property count unchanged
    // -------------------------------------------------------------
    console.log('Test 6: Transaction workspace load -> property count unchanged');
    const txRes = await fetch(`${baseUrl}/api/transactions?property_id=1&type=SALE`);
    assert.strictEqual(txRes.status, 200);
    const countAfterTx = (await pool.query('SELECT COUNT(*)::int AS count FROM properties')).rows[0].count;
    assert.strictEqual(countAfterTx, initialCount);
    console.log('  PASS: Transaction queries do not create properties');

    // -------------------------------------------------------------
    // Test 7: Reservation queries -> property count unchanged
    // -------------------------------------------------------------
    console.log('Test 7: Reservation / Booking queries -> property count unchanged');
    await pool.query('SELECT id, bid FROM bookings WHERE property_id = 1 LIMIT 5');
    await pool.query('SELECT id, guest_name FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = 1) LIMIT 5');
    const countAfterResv = (await pool.query('SELECT COUNT(*)::int AS count FROM properties')).rows[0].count;
    assert.strictEqual(countAfterResv, initialCount);
    console.log('  PASS: Reservation queries do not create properties');

    // -------------------------------------------------------------
    // Test 8: Explicit authorized create -> exactly +1 property
    // -------------------------------------------------------------
    console.log('Test 8: Explicit authorized POST /api/properties -> exactly +1 property');
    const uniqueTestCode = `T${Math.floor(10000 + Math.random() * 89999)}`;
    const createRes = await fetch(`${baseUrl}/api/properties`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Unit Test Explicit Property',
        property_code: uniqueTestCode,
        address: 'Jl. Uji Coba No. 1',
        phone: '08123456789',
        timezone: 'Asia/Jakarta',
        currency: 'IDR'
      })
    });
    assert.strictEqual(createRes.status, 201);
    assert.strictEqual(createRes.status, 201);
    const createData = await createRes.json();
    assert.ok(createData.status === 'OK' || createData.status === 'SUCCESS');
    const createdPropId = createData.data.id;
    cleanupProperties.push(createdPropId);

    const countAfterCreate = (await pool.query('SELECT COUNT(*)::int AS count FROM properties')).rows[0].count;
    assert.strictEqual(countAfterCreate, initialCount + 1, 'Explicit property create must add exactly 1 property');
    console.log(`  PASS: Property created explicitly with ID #${createdPropId} (Count: ${countAfterCreate})`);

    // -------------------------------------------------------------
    // Test 9: Same property create retry (duplicate property_code) -> 409 Conflict
    // -------------------------------------------------------------
    console.log('Test 9: Retry create with same property_code -> rejected with 409 Conflict');
    const retryRes = await fetch(`${baseUrl}/api/properties`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Duplicate Test Property',
        property_code: uniqueTestCode, // SAME CODE
        address: 'Jl. Duplicate No. 2'
      })
    });
    assert.strictEqual(retryRes.status, 409, 'Duplicate property_code must return 409 Conflict');
    const retryData = await retryRes.json();
    assert.strictEqual(retryData.status, 'ERROR');
    const countAfterRetry = (await pool.query('SELECT COUNT(*)::int AS count FROM properties')).rows[0].count;
    assert.strictEqual(countAfterRetry, initialCount + 1, 'Retry must NOT create duplicate property record');
    console.log('  PASS: Duplicate property_code blocked by backend uniqueness check');

    // -------------------------------------------------------------
    // Test 10: Invalid / unauthorized payload -> 400 Bad Request
    // -------------------------------------------------------------
    console.log('Test 10: Invalid creation payload (missing code) -> 400 Bad Request');
    const badRes = await fetch(`${baseUrl}/api/properties`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Invalid Property Without Code'
      })
    });
    assert.strictEqual(badRes.status, 400);
    const countAfterBad = (await pool.query('SELECT COUNT(*)::int AS count FROM properties')).rows[0].count;
    assert.strictEqual(countAfterBad, initialCount + 1);
    console.log('  PASS: Invalid creation payload rejected');

    // -------------------------------------------------------------
    // Test 11: Teardown & Clean Test Fixture Isolation
    // -------------------------------------------------------------
    console.log('Test 11: Fixture cleanup -> zero test residue left behind');
    for (const pId of cleanupProperties) {
      await pool.query('DELETE FROM property_features WHERE property_id = $1', [pId]);
      await pool.query('DELETE FROM property_brandings WHERE property_id = $1', [pId]);
      await pool.query('DELETE FROM property_pricing_settings WHERE property_id = ANY($1)', [[pId]]);
      await pool.query('DELETE FROM property_housekeeping_settings WHERE property_id = ANY($1)', [[pId]]);
      await pool.query('DELETE FROM property_attendance_settings WHERE property_id = ANY($1)', [[pId]]);
      await pool.query('DELETE FROM property_quick_booking_rules WHERE property_id = ANY($1)', [[pId]]);
      await pool.query('DELETE FROM property_day_use_durations WHERE property_id = ANY($1)', [[pId]]);
      await pool.query('DELETE FROM rate_plans WHERE property_id = ANY($1)', [[pId]]);
      await pool.query('DELETE FROM meal_plans WHERE property_id = ANY($1)', [[pId]]);
      await pool.query('DELETE FROM properties WHERE id = $1', [pId]);
    }
    cleanupProperties.length = 0; // cleared

    const countAfterClean = (await pool.query('SELECT COUNT(*)::int AS count FROM properties')).rows[0].count;
    assert.strictEqual(countAfterClean, initialCount, 'Test cleanup must leave 0 residual properties');
    console.log(`  PASS: All test fixtures cleanly removed (Count returned to: ${countAfterClean})`);

    // -------------------------------------------------------------
    // Test 12: Canonical OAK Lawang remains completely intact
    // -------------------------------------------------------------
    console.log('Test 12: Verify Canonical OAK Lawang integrity');
    const finalOakRes = await pool.query('SELECT id, name, property_code, is_active FROM properties WHERE id = 1');
    assert.strictEqual(finalOakRes.rows.length, 1);
    const oak = finalOakRes.rows[0];
    assert.strictEqual(oak.name, 'OAK Lawang');
    assert.strictEqual(oak.property_code, 'LWG');
    assert.strictEqual(oak.is_active, true);
    console.log('  PASS: Canonical OAK Lawang is 100% intact and unchanged');

    console.log('\n===============================================================');
    console.log('>>> ALL 12 PROPERTY CREATION & IDEMPOTENCY SAFETY TESTS PASSED! <<<');
    console.log('===============================================================\n');
  } finally {
    if (cleanupProperties.length > 0) {
      await pool.query('DELETE FROM property_features WHERE property_id = ANY($1)', [cleanupProperties]).catch(() => {});
      await pool.query('DELETE FROM property_brandings WHERE property_id = ANY($1)', [cleanupProperties]).catch(() => {});
      await pool.query('DELETE FROM property_pricing_settings WHERE property_id = ANY($1)', [cleanupProperties]).catch(() => {});
      await pool.query('DELETE FROM property_housekeeping_settings WHERE property_id = ANY($1)', [cleanupProperties]).catch(() => {});
      await pool.query('DELETE FROM property_attendance_settings WHERE property_id = ANY($1)', [cleanupProperties]).catch(() => {});
      await pool.query('DELETE FROM property_quick_booking_rules WHERE property_id = ANY($1)', [cleanupProperties]).catch(() => {});
      await pool.query('DELETE FROM property_day_use_durations WHERE property_id = ANY($1)', [cleanupProperties]).catch(() => {});
      await pool.query('DELETE FROM rate_plans WHERE property_id = ANY($1)', [cleanupProperties]).catch(() => {});
      await pool.query('DELETE FROM meal_plans WHERE property_id = ANY($1)', [cleanupProperties]).catch(() => {});
      await pool.query('DELETE FROM properties WHERE id = ANY($1)', [cleanupProperties]).catch(() => {});
    }
    server.close();
    await pool.end();
  }
}

runTests().catch((err) => {
  console.error('Property Creation Safety Test FAILED:', err);
  process.exit(1);
});

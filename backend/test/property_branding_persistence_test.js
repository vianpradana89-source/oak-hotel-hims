'use strict';

const path = require('path');
const assert = require('assert');
const http = require('http');
const { app, pool } = require('../dist/index');
const { initializeDatabase } = require('../dist/db/schema_v3');

let server;
let baseUrl;

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('=== Starting Property Branding Persistence & Multi-Property Isolation Tests ===\n');

  // Initialize DB schema
  await initializeDatabase(pool);

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  const TEST_PROP_CODE = 'VCT';
  let testPropId = null;

  try {
    // Clean up any stale test branding/property before test
    await pool.query("DELETE FROM properties WHERE property_code = $1", [TEST_PROP_CODE]);
    await pool.query("DELETE FROM property_brandings WHERE property_id = 1");

    // ========================================================================
    // Scenario 1: GET default branding for Property 1 (dynamic fallback)
    // ========================================================================
    console.log('--- Scenario 1: GET default dynamic branding ---');
    const res1 = await request('GET', '/api/properties/1/branding');
    assert.strictEqual(res1.status, 200, '1.1 GET branding returns 200');
    assert.strictEqual(res1.body.status, 'OK', '1.2 status is OK');
    assert.strictEqual(res1.body.data.property_id, 1, '1.3 property_id is 1');
    assert.strictEqual(res1.body.data.display_name, 'OAK Lawang', '1.4 default display_name matches property name');
    assert.strictEqual(res1.body.data.short_name, 'LWG', '1.5 default short_name matches property_code');
    assert.strictEqual(res1.body.data.primary_color, '#1b4332', '1.6 default primary_color is #1b4332');
    assert.strictEqual(res1.body.data.accent_color, '#c5a880', '1.7 default accent_color is #c5a880');
    console.log('PASS | Scenario 1 passed');

    // ========================================================================
    // Scenario 2: PUT branding update for Property 1 (persistence)
    // ========================================================================
    console.log('--- Scenario 2: PUT branding update & database persistence ---');
    const updatePayload1 = {
      display_name: 'OAK Lawang Resort & Spa',
      short_name: 'LWG-SPA',
      tagline: 'Luxury Boutique Stay in Lawang',
      primary_color: '#143527',
      accent_color: '#b89340',
      logo_url: '/assets/branding/custom-lawang.png',
    };

    const res2 = await request('PUT', '/api/properties/1/branding', updatePayload1);
    assert.strictEqual(res2.status, 200, '2.1 PUT branding returns 200');
    assert.strictEqual(res2.body.data.display_name, 'OAK Lawang Resort & Spa', '2.2 display_name updated');
    assert.strictEqual(res2.body.data.short_name, 'LWG-SPA', '2.3 short_name updated');
    assert.strictEqual(res2.body.data.tagline, 'Luxury Boutique Stay in Lawang', '2.4 tagline updated');
    assert.strictEqual(res2.body.data.primary_color, '#143527', '2.5 primary_color updated');
    assert.strictEqual(res2.body.data.accent_color, '#b89340', '2.6 accent_color updated');

    // Verify DB physical row
    const dbRow1 = await pool.query('SELECT * FROM property_brandings WHERE property_id = 1');
    assert.strictEqual(dbRow1.rowCount, 1, '2.7 physical row inserted in property_brandings');
    assert.strictEqual(dbRow1.rows[0].display_name, 'OAK Lawang Resort & Spa', '2.8 DB display_name matches');
    assert.strictEqual(dbRow1.rows[0].primary_color, '#143527', '2.9 DB primary_color matches');

    // Refetch via GET
    const res2Refetch = await request('GET', '/api/properties/1/branding');
    assert.strictEqual(res2Refetch.status, 200, '2.10 Refetch returns 200');
    assert.strictEqual(res2Refetch.body.data.display_name, 'OAK Lawang Resort & Spa', '2.11 Refetched display_name persisted');
    assert.strictEqual(res2Refetch.body.data.short_name, 'LWG-SPA', '2.12 Refetched short_name persisted');
    console.log('PASS | Scenario 2 passed');

    // ========================================================================
    // Scenario 3: Color safety and validation
    // ========================================================================
    console.log('--- Scenario 3: Color safety & format rejection ---');
    const invalidColorRes = await request('PUT', '/api/properties/1/branding', {
      primary_color: 'not-a-color',
    });
    assert.strictEqual(invalidColorRes.status, 400, '3.1 Invalid color returns 400');
    assert.strictEqual(invalidColorRes.body.code, 'VALIDATION_ERROR', '3.2 Code is VALIDATION_ERROR');

    const invalidHexRes = await request('PUT', '/api/properties/1/branding', {
      accent_color: '#gg1234',
    });
    assert.strictEqual(invalidHexRes.status, 400, '3.3 Invalid hex returns 400');
    assert.strictEqual(invalidHexRes.body.code, 'VALIDATION_ERROR', '3.4 Code is VALIDATION_ERROR');

    // Verify previous values unchanged
    const afterInvalidRes = await request('GET', '/api/properties/1/branding');
    assert.strictEqual(afterInvalidRes.body.data.primary_color, '#143527', '3.5 Primary color uncorrupted');
    assert.strictEqual(afterInvalidRes.body.data.accent_color, '#b89340', '3.6 Accent color uncorrupted');
    console.log('PASS | Scenario 3 passed');

    // ========================================================================
    // Scenario 4: Multi-Property Isolation & Cross-Tenant Safety
    // ========================================================================
    console.log('--- Scenario 4: Multi-property isolation & tenant protection ---');
    // Create second property
    const prop2Res = await pool.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('Villa Cemara Test', $1, 'Asia/Jakarta', 'IDR', 'Jl. Cemara No. 12', TRUE) RETURNING id",
      [TEST_PROP_CODE]
    );
    testPropId = prop2Res.rows[0].id;

    // GET default for property 2
    const resProp2 = await request('GET', `/api/properties/${testPropId}/branding`);
    assert.strictEqual(resProp2.status, 200, '4.1 Property 2 branding returns 200');
    assert.strictEqual(resProp2.body.data.display_name, 'Villa Cemara Test', '4.2 Property 2 display_name is Villa Cemara Test');
    assert.strictEqual(resProp2.body.data.short_name, TEST_PROP_CODE, '4.3 Property 2 short_name is VCT');

    // PUT custom branding for property 2
    const updatePayload2 = {
      display_name: 'Villa Cemara Private Estate',
      short_name: 'CEMARA',
      tagline: 'Exclusive Mountain Villa',
      primary_color: '#0f4c3a',
      accent_color: '#d4af37',
    };
    const resProp2Update = await request('PUT', `/api/properties/${testPropId}/branding`, updatePayload2);
    assert.strictEqual(resProp2Update.status, 200, '4.4 Property 2 PUT returns 200');
    assert.strictEqual(resProp2Update.body.data.display_name, 'Villa Cemara Private Estate', '4.5 Property 2 updated');

    // Verify Property 1 branding was NOT affected (Zero Cross-Tenant Mutation)
    const resProp1Check = await request('GET', '/api/properties/1/branding');
    assert.strictEqual(resProp1Check.body.data.display_name, 'OAK Lawang Resort & Spa', '4.6 Property 1 display_name unaffected');
    assert.strictEqual(resProp1Check.body.data.short_name, 'LWG-SPA', '4.7 Property 1 short_name unaffected');
    assert.strictEqual(resProp1Check.body.data.primary_color, '#143527', '4.8 Property 1 primary_color unaffected');

    // Unknown property returns 404
    const unknownRes = await request('GET', '/api/properties/999999/branding');
    assert.strictEqual(unknownRes.status, 404, '4.9 Unknown property returns 404');
    assert.strictEqual(unknownRes.body.code, 'PROPERTY_NOT_FOUND', '4.10 Code is PROPERTY_NOT_FOUND');

    const unknownPutRes = await request('PUT', '/api/properties/999999/branding', { display_name: 'Test' });
    assert.strictEqual(unknownPutRes.status, 404, '4.11 Unknown property PUT returns 404');
    assert.strictEqual(unknownPutRes.body.code, 'PROPERTY_NOT_FOUND', '4.12 Code is PROPERTY_NOT_FOUND');

    // Invalid property ID returns 400
    const invalidIdRes = await request('GET', '/api/properties/abc/branding');
    assert.strictEqual(invalidIdRes.status, 400, '4.13 Invalid property ID returns 400');
    assert.strictEqual(invalidIdRes.body.code, 'VALIDATION_ERROR', '4.14 Code is VALIDATION_ERROR');
    console.log('PASS | Scenario 4 passed');

    console.log('\n======================================================');
    console.log('All Property Branding Persistence & Isolation Tests PASSED!');
    console.log('======================================================\n');
  } finally {
    // Clean up fixtures
    console.log('--- Cleaning Up Test Fixtures ---');
    if (testPropId) {
      await pool.query('DELETE FROM property_brandings WHERE property_id = $1', [testPropId]);
      await pool.query('DELETE FROM properties WHERE id = $1', [testPropId]);
    }
    await pool.query('DELETE FROM property_brandings WHERE property_id = 1');

    if (server) {
      server.close();
    }
    await pool.end();
  }
}

runTests().catch((err) => {
  console.error('Test Failed:', err);
  process.exit(1);
});

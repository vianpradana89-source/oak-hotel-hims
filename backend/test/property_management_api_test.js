const http = require('http');
const { pool } = require('../dist/index');

const BASE_URL = process.env.TEST_API_URL || 'http://127.0.0.1:5000';

function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
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
  console.log('--- STARTING PROPERTY MANAGEMENT API TESTS ---');
  let createdPropId = null;
  let testPassed = 0;
  let testFailed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log('PASS:', message);
      testPassed++;
    } else {
      console.error('FAIL:', message);
      testFailed++;
    }
  }

  try {
    // 1. GET /api/properties
    const getRes = await makeRequest('GET', '/api/properties');
    assert(getRes.status === 200, 'GET /api/properties returns 200');
    assert(getRes.data.status === 'OK', 'GET /api/properties status is OK');
    assert(Array.isArray(getRes.data.data) && getRes.data.data.length > 0, 'GET /api/properties returns array of properties');
    const oakLawang = getRes.data.data.find(p => p.id === 1);
    assert(oakLawang && oakLawang.property_code === 'LWG', 'Primary property OAK Lawang (LWG) exists');

    // 2. POST /api/properties (Create new test property)
    const testCode = 'T' + Math.floor(Math.random() * 8999 + 1000);
    const createRes = await makeRequest('POST', '/api/properties', {
      name: 'OAK Test Resort',
      property_code: testCode,
      address: 'Jl. Uji Coba No. 123, Kota Wisata',
      phone: '081234567890',
      timezone: 'Asia/Jakarta',
      currency: 'IDR'
    });

    assert(createRes.status === 201, 'POST /api/properties returns 201 Created');
    assert(createRes.data.status === 'SUCCESS', 'POST /api/properties returns status SUCCESS');
    assert(createRes.data.data && createRes.data.data.id, 'POST /api/properties returns created property with ID');
    createdPropId = createRes.data.data.id;

    // 2b. Verify default configs created in DB
    const hkSettings = await pool.query('SELECT * FROM property_housekeeping_settings WHERE property_id = $1', [createdPropId]);
    assert(hkSettings.rows.length === 1, 'Default housekeeping settings auto-initialized');

    const attSettings = await pool.query('SELECT * FROM property_attendance_settings WHERE property_id = $1', [createdPropId]);
    assert(attSettings.rows.length === 1, 'Default attendance settings auto-initialized');

    const branding = await pool.query('SELECT * FROM property_brandings WHERE property_id = $1', [createdPropId]);
    assert(branding.rows.length === 1, 'Default branding auto-initialized');

    const stayChargeRules = await pool.query('SELECT COUNT(*)::int AS count FROM stay_charge_rules WHERE property_id = $1', [createdPropId]);
    assert(stayChargeRules.rows[0].count === 7, 'Default stay-charge rules auto-initialized');

    // 3. Prevent duplicate property_code
    const dupRes = await makeRequest('POST', '/api/properties', {
      name: 'OAK Duplicate Test',
      property_code: testCode
    });
    assert(dupRes.status === 409, 'POST duplicate property_code returns 409 Conflict');

    // 4. PATCH /api/properties/:id (Update property)
    const updateRes = await makeRequest('PATCH', `/api/properties/${createdPropId}`, {
      name: 'OAK Test Resort Updated',
      property_code: testCode,
      address: 'Jl. Perubahan No. 456',
      phone: '08987654321',
      timezone: 'Asia/Makassar',
      currency: 'IDR',
      is_active: true
    });
    assert(updateRes.status === 200, 'PATCH /api/properties/:id returns 200 OK');
    assert(updateRes.data.data.name === 'OAK Test Resort Updated', 'Property name was successfully updated');
    assert(updateRes.data.data.timezone === 'Asia/Makassar', 'Property timezone was successfully updated');

    // 5. DELETE /api/properties/1 (Primary Property deletion blocked)
    const delPrimaryRes = await makeRequest('DELETE', '/api/properties/1');
    assert(delPrimaryRes.status === 403, 'DELETE primary property (id=1) is blocked with 403 Forbidden');

    // 6. DELETE /api/properties/:id (Delete created test property)
    const delTestRes = await makeRequest('DELETE', `/api/properties/${createdPropId}`);
    assert(delTestRes.status === 200, 'DELETE created test property returns 200 OK');
    assert(delTestRes.data.status === 'SUCCESS', 'DELETE returns SUCCESS');
    createdPropId = null;

    // 7. Verify DB cleanup
    const checkProp = await pool.query('SELECT * FROM properties WHERE property_code = $1', [testCode]);
    assert(checkProp.rows.length === 0, 'Deleted property row is completely removed from DB');

  } catch (err) {
    console.error('Test execution error:', err);
    testFailed++;
  } finally {
    // Zero residue safety
    if (createdPropId) {
      try {
        await pool.query('DELETE FROM property_housekeeping_settings WHERE property_id = $1', [createdPropId]);
        await pool.query('DELETE FROM property_attendance_settings WHERE property_id = $1', [createdPropId]);
        await pool.query('DELETE FROM property_brandings WHERE property_id = $1', [createdPropId]);
        await pool.query('DELETE FROM checklist_templates WHERE property_id = $1', [createdPropId]);
        await pool.query('DELETE FROM checklist_template_groups WHERE property_id = $1', [createdPropId]);
        await pool.query('DELETE FROM properties WHERE id = $1', [createdPropId]);
        console.log('Cleaned up residue fixture ID:', createdPropId);
      } catch (cleanupErr) {
        console.error('Cleanup error:', cleanupErr);
      }
    }
    await pool.end();

    console.log(`\n--- TEST SUMMARY: ${testPassed} PASSED, ${testFailed} FAILED ---`);
    if (testFailed > 0) {
      process.exit(1);
    }
  }
}

runTests();

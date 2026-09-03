// backend/test/auth_route_order_hotfix_test.js
require('dotenv').config();
const assert = require('assert');
const http = require('http');
const { app, pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');

function makeRequest(server, method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers
    };

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: reqHeaders
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(raw);
            resolve({ status: res.statusCode, data: json });
          } catch (e) {
            resolve({ status: res.statusCode, raw });
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
}

async function runAuthRouteOrderTests() {
  console.log('=== AUTH ROUTE ORDER & GLOBAL MIDDLEWARE HOTFIX REGRESSION TEST ===\n');

  // Start HTTP server on port 0 (ephemeral port)
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`Test server running on port ${port}\n`);

  try {
    // -------------------------------------------------------------
    // TEST A & B: POST /api/auth/login without JWT reaches authRouter
    // and returns 200 on valid credentials
    // -------------------------------------------------------------
    console.log('Test A & B: POST /api/auth/login with valid credentials (no auth header)...');
    const validLoginRes = await makeRequest(server, 'POST', '/api/auth/login', {}, {
      username: 'vian',
      password: 'OakLawang2026!'
    });

    assert.strictEqual(validLoginRes.status, 200, `Expected 200, got ${validLoginRes.status}`);
    assert.strictEqual(validLoginRes.data.status, 'OK');
    assert.ok(validLoginRes.data.data.token, 'Response must contain JWT token');
    assert.strictEqual(validLoginRes.data.data.user.username, 'vian');
    console.log('✓ PASS: Public login reachable without JWT; returns 200 and auth token.\n');

    // -------------------------------------------------------------
    // TEST C: Invalid password returns auth-specific INVALID_CREDENTIALS
    // and NOT generic UNAUTHORIZED from broad /api middleware
    // -------------------------------------------------------------
    console.log('Test C: POST /api/auth/login with invalid password...');
    const invalidLoginRes = await makeRequest(server, 'POST', '/api/auth/login', {}, {
      username: 'vian',
      password: 'WrongPassword123!'
    });

    assert.strictEqual(invalidLoginRes.status, 401, `Expected 401, got ${invalidLoginRes.status}`);
    assert.strictEqual(
      invalidLoginRes.data.code,
      'INVALID_CREDENTIALS',
      `Expected INVALID_CREDENTIALS code, got: ${invalidLoginRes.data.code}`
    );
    assert.notStrictEqual(
      invalidLoginRes.data.message,
      'Akses ditolak. Silakan login terlebih dahulu untuk mengakses sistem HIMS.',
      'Must NOT be rejected by broad requireAuth middleware'
    );
    console.log('✓ PASS: Invalid login returns domain-specific INVALID_CREDENTIALS (not broad middleware 401).\n');

    // -------------------------------------------------------------
    // TEST D: Protected Deposit route without JWT remains 401
    // -------------------------------------------------------------
    console.log('Test D: POST /api/deposits without JWT...');
    const unauthDepositRes = await makeRequest(server, 'POST', '/api/deposits', {}, {
      reservation_id: 1,
      amount: 50000,
      payment_method: 'CASH'
    });

    assert.strictEqual(unauthDepositRes.status, 401, `Expected 401, got ${unauthDepositRes.status}`);
    assert.strictEqual(unauthDepositRes.data.code, 'UNAUTHORIZED');
    assert.strictEqual(
      unauthDepositRes.data.message,
      'Akses ditolak. Silakan login terlebih dahulu untuk mengakses sistem HIMS.'
    );
    console.log('✓ PASS: /api/deposits remains strictly protected (401 UNAUTHORIZED without JWT).\n');

    // -------------------------------------------------------------
    // TEST E: Protected Identity Custody route without JWT remains 401
    // -------------------------------------------------------------
    console.log('Test E: POST /api/identity-custody without JWT...');
    const unauthIdentityRes = await makeRequest(server, 'POST', '/api/identity-custody', {}, {
      reservation_id: 1,
      document_type: 'KTP',
      document_holder_name: 'Test Holder'
    });

    assert.strictEqual(unauthIdentityRes.status, 401, `Expected 401, got ${unauthIdentityRes.status}`);
    assert.strictEqual(unauthIdentityRes.data.code, 'UNAUTHORIZED');
    console.log('✓ PASS: /api/identity-custody remains strictly protected (401 UNAUTHORIZED without JWT).\n');

    // -------------------------------------------------------------
    // TEST F: Authenticated protected routes continue working
    // -------------------------------------------------------------
    console.log('Test F: Authenticated protected route access...');
    const foToken = generateToken({
      id: 2,
      property_id: 1,
      role: 'Front Office',
      role_id: 2,
      username: 'fo_staff',
      full_name: 'Front Office Staff',
      must_change_password: false,
      account_status: 'READY'
    });

    // Query reservation deposits using authenticated token and valid reservation
    const resRes = await pool.query(
      'SELECT r.id, b.property_id FROM reservations r JOIN bookings b ON b.id = r.booking_id LIMIT 1'
    );
    const reservationId = resRes.rows[0]?.id || 287;
    const propertyId = resRes.rows[0]?.property_id || 1;

    const authDepositRes = await makeRequest(
      server,
      'GET',
      `/api/reservations/${reservationId}/deposits?property_id=${propertyId}`,
      { Authorization: `Bearer ${foToken}` }
    );
    assert.strictEqual(authDepositRes.status, 200, `Expected 200, got ${authDepositRes.status}`);
    assert.strictEqual(authDepositRes.data.status, 'SUCCESS');

    // Also verify /api/auth/me works with authenticated token
    const authMeRes = await makeRequest(
      server,
      'GET',
      '/api/auth/me',
      { Authorization: `Bearer ${foToken}` }
    );
    assert.strictEqual(authMeRes.status, 200, `Expected 200, got ${authMeRes.status}`);
    assert.strictEqual(authMeRes.data.data.user.username, 'fo_staff');
    console.log('✓ PASS: Authenticated requests succeed across protected domain routes.\n');

    // -------------------------------------------------------------
    // TEST G: Route ordering does not expose unrelated PMS APIs
    // -------------------------------------------------------------
    console.log('Test G: Verifying other protected endpoints remain secure...');
    const unauthUsersRes = await makeRequest(server, 'GET', '/api/users');
    // /api/users requires authentication
    assert.strictEqual(unauthUsersRes.status, 401, `Expected 401 for /api/users, got ${unauthUsersRes.status}`);

    const unauthCustodyListRes = await makeRequest(server, 'GET', '/api/reservations/1/identity-custody');
    assert.strictEqual(unauthCustodyListRes.status, 401, `Expected 401 for custody list, got ${unauthCustodyListRes.status}`);
    console.log('✓ PASS: Route ordering does not expose unrelated protected PMS APIs.\n');

    console.log('===============================================================');
    console.log('ALL TESTS A THROUGH G PASSED! ROUTE ORDER & SECURITY VERIFIED.');
    console.log('===============================================================\n');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    console.log('Test server shut down cleanly.');
  }
}

runAuthRouteOrderTests().catch((err) => {
  console.error('FATAL TEST FAILURE:', err);
  process.exit(1);
});

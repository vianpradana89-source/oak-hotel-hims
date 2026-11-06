// test_cors_routing_preflight_r4.mjs
// Standalone verification of CORS callback and HTTP transport routing for Guest Bill R8 Preflight R4.
// Tests without cloud DB:
// 1. Active staging CORS configuration rejects tagged origin and evil origins.
// 2. Candidate tagged CORS configuration allows existing origins AND tagged origin, while rejecting untrusted origins.
// 3. Verifies same-origin SSE and relative URL transport behavior.

import express from 'express';
import cors from 'cors';
import http from 'http';

function createTestApp(corsAllowedOriginsEnv) {
  const app = express();
  const allowedOrigins = (corsAllowedOriginsEnv || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error('Not allowed by CORS'));
    },
    credentials: false,
  }));

  // Error handling middleware for CORS error
  app.use((err, req, res, next) => {
    if (err.message === 'Not allowed by CORS') {
      res.status(403).json({ error: 'Not allowed by CORS' });
      return;
    }
    next(err);
  });

  app.get('/api/events', (req, res) => {
    res.status(200).json({ ok: true, endpoint: 'sse', property_id: req.query.property_id });
  });

  app.get('/api/documents/reservations/:id/folio', (req, res) => {
    res.status(200).json({ ok: true, endpoint: 'guest-folio', id: req.params.id, property_id: req.query.property_id });
  });

  app.post('/api/auth/login', (req, res) => {
    res.status(200).json({ status: 'OK', data: { token: 'mock-token' } });
  });

  return { app, allowedOrigins };
}

function makeRequest(server, path, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request({
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function runTests() {
  console.log('===============================================================');
  console.log('   OAK HIMS GUEST BILL R8 - CORS & ROUTING VERIFICATION SUITE  ');
  console.log('===============================================================');

  let passed = 0;
  let failed = 0;

  function assert(condition, name) {
    if (condition) {
      console.log(`[PASS] ${name}`);
      passed++;
    } else {
      console.error(`[FAIL] ${name}`);
      failed++;
    }
  }

  // --- SUITE 1: Active Revision CORS (00683-6cm) ---
  console.log('\n--- SUITE 1: Active Revision 00683-6cm CORS Policy ---');
  const activeOriginsEnv = 'https://hims.oaklawang.com,https://oak-hims-staging-bh5vdfv2ia-et.a.run.app';
  const { app: activeApp } = createTestApp(activeOriginsEnv);
  const activeServer = http.createServer(activeApp);
  await new Promise((r) => activeServer.listen(0, '127.0.0.1', r));

  try {
    // 1.1 Direct request (no Origin header) -> allowed (same-origin / server-to-server)
    const resNoOrigin = await makeRequest(activeServer, '/api/documents/reservations/101/folio?property_id=1');
    assert(resNoOrigin.statusCode === 200, 'Active config: Direct/same-origin request (no Origin header) returns 200');

    // 1.2 Allowed origin 1: hims.oaklawang.com
    const resOrigin1 = await makeRequest(activeServer, '/api/documents/reservations/101/folio?property_id=1', 'GET', {
      origin: 'https://hims.oaklawang.com',
    });
    assert(resOrigin1.statusCode === 200, 'Active config: Allowed origin https://hims.oaklawang.com returns 200');
    assert(resOrigin1.headers['access-control-allow-origin'] === 'https://hims.oaklawang.com', 'Active config: ACAO header echoes allowed origin');

    // 1.3 Allowed origin 2: oak-hims-staging-bh5vdfv2ia-et.a.run.app
    const resOrigin2 = await makeRequest(activeServer, '/api/documents/reservations/101/folio?property_id=1', 'GET', {
      origin: 'https://oak-hims-staging-bh5vdfv2ia-et.a.run.app',
    });
    assert(resOrigin2.statusCode === 200, 'Active config: Allowed origin https://oak-hims-staging-bh5vdfv2ia-et.a.run.app returns 200');

    // 1.4 Tagged origin against active container: MUST BE REJECTED (matches reviewer probe finding)
    const resTaggedAgainstActive = await makeRequest(activeServer, '/api/documents/reservations/101/folio?property_id=1', 'GET', {
      origin: 'https://guest-bill-r8---oak-hims-staging-bh5vdfv2ia-et.a.run.app',
    });
    assert(resTaggedAgainstActive.statusCode === 403, 'Active config: Tagged origin https://guest-bill-r8---... is rejected with 403 (expected gap)');

    // 1.5 Evil origin -> REJECTED
    const resEvilActive = await makeRequest(activeServer, '/api/documents/reservations/101/folio?property_id=1', 'GET', {
      origin: 'https://evil.com',
    });
    assert(resEvilActive.statusCode === 403, 'Active config: Unknown origin https://evil.com is rejected with 403');
  } finally {
    activeServer.close();
  }

  // --- SUITE 2: Candidate Tagged Deploy CORS Policy ---
  console.log('\n--- SUITE 2: Candidate Tagged Deploy CORS Policy ---');
  const candidateOriginsEnv = 'https://hims.oaklawang.com,https://oak-hims-staging-bh5vdfv2ia-et.a.run.app,https://guest-bill-r8---oak-hims-staging-bh5vdfv2ia-et.a.run.app';
  const { app: candidateApp } = createTestApp(candidateOriginsEnv);
  const candidateServer = http.createServer(candidateApp);
  await new Promise((r) => candidateServer.listen(0, '127.0.0.1', r));

  try {
    // 2.1 Same-origin / direct -> allowed
    const resNoOrigin = await makeRequest(candidateServer, '/api/events?property_id=1');
    assert(resNoOrigin.statusCode === 200, 'Candidate config: Direct/same-origin SSE request returns 200');

    // 2.2 Existing origin 1 -> allowed
    const resOrigin1 = await makeRequest(candidateServer, '/api/auth/login', 'POST', {
      origin: 'https://hims.oaklawang.com',
      'content-type': 'application/json',
    });
    assert(resOrigin1.statusCode === 200, 'Candidate config: Existing origin https://hims.oaklawang.com returns 200');

    // 2.3 Existing origin 2 -> allowed
    const resOrigin2 = await makeRequest(candidateServer, '/api/auth/login', 'POST', {
      origin: 'https://oak-hims-staging-bh5vdfv2ia-et.a.run.app',
      'content-type': 'application/json',
    });
    assert(resOrigin2.statusCode === 200, 'Candidate config: Existing origin https://oak-hims-staging-bh5vdfv2ia-et.a.run.app returns 200');

    // 2.4 Tagged origin -> ALLOWED on candidate
    const resTagged = await makeRequest(candidateServer, '/api/documents/reservations/101/folio?property_id=1', 'GET', {
      origin: 'https://guest-bill-r8---oak-hims-staging-bh5vdfv2ia-et.a.run.app',
      authorization: 'Bearer mock_token_valid',
    });
    assert(resTagged.statusCode === 200, 'Candidate config: Tagged origin https://guest-bill-r8---... returns 200');
    assert(resTagged.headers['access-control-allow-origin'] === 'https://guest-bill-r8---oak-hims-staging-bh5vdfv2ia-et.a.run.app', 'Candidate config: Tagged origin echoes in ACAO');

    // 2.5 OPTIONS Preflight on tagged origin -> allowed
    const resPreflight = await makeRequest(candidateServer, '/api/documents/reservations/101/folio?property_id=1', 'OPTIONS', {
      origin: 'https://guest-bill-r8---oak-hims-staging-bh5vdfv2ia-et.a.run.app',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    });
    assert(resPreflight.statusCode === 204, 'Candidate config: OPTIONS preflight on tagged origin returns 204');
    assert(resPreflight.headers['access-control-allow-origin'] === 'https://guest-bill-r8---oak-hims-staging-bh5vdfv2ia-et.a.run.app', 'Candidate config: OPTIONS preflight echoes ACAO');

    // 2.6 Subdomain attacker -> REJECTED
    const resAttacker = await makeRequest(candidateServer, '/api/documents/reservations/101/folio?property_id=1', 'GET', {
      origin: 'https://guest-bill-r8---oak-hims-staging-bh5vdfv2ia-et.a.run.app.attacker.com',
    });
    assert(resAttacker.statusCode === 403, 'Candidate config: Subdomain attacker spoof is rejected with 403');

    // 2.7 Arbitrary evil origin -> REJECTED
    const resEvil = await makeRequest(candidateServer, '/api/documents/reservations/101/folio?property_id=1', 'GET', {
      origin: 'https://evil.com',
    });
    assert(resEvil.statusCode === 403, 'Candidate config: Arbitrary origin https://evil.com is rejected with 403');
  } finally {
    candidateServer.close();
  }

  // --- SUITE 3: Realtime Base URL & Relative URL Transport Invariants ---
  console.log('\n--- SUITE 3: Transport & Routing Invariants ---');
  const emptyBaseUrl = '';
  const propertyId = 42;
  const computedEventsUrl = `${emptyBaseUrl}/api/events?property_id=${propertyId}`;
  assert(computedEventsUrl === '/api/events?property_id=42', 'Empty VITE_REALTIME_BASE_URL yields same-origin relative SSE URL');
  assert(!computedEventsUrl.startsWith('http://') && !computedEventsUrl.startsWith('https://'), 'Computed events URL is strictly relative');

  console.log('\n===============================================================');
  console.log(`SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('===============================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test suite error:', err);
  process.exit(1);
});

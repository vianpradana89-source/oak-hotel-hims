const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const { generateToken } = require('../dist/domains/auth/authService');
const { createIdentityExtractionRouter } = require('../dist/domains/identity/identityExtractionRouter');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

function staffToken(propertyId = 1, id = 20) {
  return generateToken({
    id,
    email: `staff${id}@oak.test`,
    username: `staff${id}`,
    full_name: 'Front Office Staff',
    role: 'Front Office',
    role_id: 3,
    property_id: propertyId,
    scope: 'FULL'
  });
}

function superAdminToken(id = 1) {
  return generateToken({
    id,
    email: 'sa@oak.test',
    username: 'superadmin',
    full_name: 'Platform Super Admin',
    role: 'Super Admin',
    role_id: 1,
    property_id: 1,
    scope: 'FULL'
  });
}

function mockPool({ ownershipRows = [], superAdminIds = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ text, params });
      if (text.includes('FROM users u') && text.includes('JOIN roles r')) {
        const userId = Number(params[0]);
        if (superAdminIds.includes(userId)) {
          return {
            rows: [{
              id: userId,
              username: 'superadmin',
              full_name: 'Platform Super Admin',
              email: 'sa@oak.test',
              user_is_active: true,
              role_id: 1,
              role_name: 'Super Admin',
              role_is_active: true,
              is_system_role: true,
              role_property_id: null
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('FROM reservations') || text.includes('created_property_id') || text.includes('doc_props')) {
        return { rows: ownershipRows, rowCount: ownershipRows.length };
      }
      throw new Error(`Unexpected query: ${text}`);
    }
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function request(port, urlPath, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(body.toString('utf8')); } catch { /* binary */ }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(pool, uploadDir, fn) {
  const app = express();
  app.use('/api/identity', createIdentityExtractionRouter(pool, uploadDir));
  const { server, port } = await listen(app);
  try {
    await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-identity-doc-'));
  const filename = 'ktp-guest-created-prop.jpg';
  fs.mkdirSync(path.join(uploadDir, 'identity'), { recursive: true });
  fs.writeFileSync(path.join(uploadDir, 'identity', filename), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  await test('ownership SQL uses guests.created_property_id and booking/room property joins', async () => {
    const pool = mockPool({ ownershipRows: [{ property_id: 1 }] });
    await withServer(pool, uploadDir, async (port) => {
      await request(port, `/api/identity/document/${filename}`, staffToken(1));
    });
    const ownership = pool.calls.find((call) => call.text.includes('doc_props') || call.text.includes('created_property_id'));
    assert.ok(ownership, 'ownership query was issued');
    assert.ok(ownership.text.includes('g.created_property_id AS property_id'), 'guest column is created_property_id');
    assert.ok(ownership.text.includes('LEFT JOIN bookings b ON b.id = r.booking_id'), 'reservation property comes from bookings');
    assert.ok(ownership.text.includes('LEFT JOIN rooms rm ON rm.id = r.room_id'), 'room property is the documented fallback');
    assert.ok(ownership.text.includes('COALESCE(b.property_id, rm.property_id)'), 'canonical reservation property is booking then room');
    assert.ok(!ownership.text.includes('r.property_id'), 'non-existent reservations.property_id is not selected');
    assert.ok(!ownership.text.includes('reservations.property_id'), 'reservations.property_id is not referenced');
    assert.ok(!ownership.text.includes('g.property_id'), 'invalid guests.property_id is not selected');
    assert.ok(ownership.text.includes('property_id IS NOT NULL'), 'unresolved property is excluded');
    assert.equal(ownership.params[0], filename);
  });

  await test('guest KTP resolves using created_property_id for same-property staff', async () => {
    const pool = mockPool({ ownershipRows: [{ property_id: 1 }] });
    await withServer(pool, uploadDir, async (port) => {
      const res = await request(port, `/api/identity/document/${filename}`, staffToken(1));
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /image\/jpeg/);
    });
  });

  await test('reservation KTP resolves property via bookings.property_id join', async () => {
    const pool = mockPool({ ownershipRows: [{ property_id: 1 }] });
    await withServer(pool, uploadDir, async (port) => {
      const res = await request(port, `/api/identity/document/${filename}`, staffToken(1));
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /image\/jpeg/);
    });
    const ownership = pool.calls.find((call) => call.text.includes('FROM reservations r'));
    assert.ok(ownership, 'reservation ownership lookup remains');
    assert.ok(ownership.text.includes('JOIN bookings b ON b.id = r.booking_id'), 'uses reservations.booking_id -> bookings.id');
    assert.ok(!ownership.text.includes('r.property_id'), 'does not read reservations.property_id');
  });

  await test('unresolved ownership fails closed with 404', async () => {
    const pool = mockPool({ ownershipRows: [] });
    await withServer(pool, uploadDir, async (port) => {
      const res = await request(port, `/api/identity/document/${filename}`, staffToken(1));
      assert.equal(res.status, 404);
      assert.equal(res.json.code, 'DOCUMENT_NOT_FOUND');
    });
  });

  await test('null created_property_id is treated as unresolved, not invented', async () => {
    const pool = mockPool({ ownershipRows: [] });
    await withServer(pool, uploadDir, async (port) => {
      const res = await request(port, `/api/identity/document/${filename}`, staffToken(1));
      assert.equal(res.status, 404);
    });
    const ownership = pool.calls.find((call) => call.text.includes('doc_props') || call.text.includes('created_property_id'));
    assert.ok(ownership.text.includes('property_id IS NOT NULL'));
  });

  await test('cross-property staff is denied', async () => {
    const pool = mockPool({ ownershipRows: [{ property_id: 2 }] });
    await withServer(pool, uploadDir, async (port) => {
      const res = await request(port, `/api/identity/document/${filename}`, staffToken(1));
      assert.equal(res.status, 403);
      assert.equal(res.json.code, 'FORBIDDEN');
    });
  });

  await test('Super Admin may read a document from another property', async () => {
    const pool = mockPool({ ownershipRows: [{ property_id: 2 }], superAdminIds: [1] });
    await withServer(pool, uploadDir, async (port) => {
      const res = await request(port, `/api/identity/document/${filename}`, superAdminToken(1));
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /image\/jpeg/);
    });
  });

  await test('unauthorized request is rejected without inventing access', async () => {
    const pool = mockPool({ ownershipRows: [{ property_id: 1 }] });
    await withServer(pool, uploadDir, async (port) => {
      const res = await request(port, `/api/identity/document/${filename}`);
      assert.equal(res.status, 401);
      assert.equal(res.json.code, 'UNAUTHORIZED');
    });
  });

  fs.rmSync(uploadDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

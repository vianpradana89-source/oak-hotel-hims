const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const { generateToken } = require('../dist/domains/auth/authService');
const { createTransactionsRouter } = require('../dist/domains/transactions/transactionsRouter');
const {
  resolveSafeTransactionAttachmentPath
} = require('../dist/domains/transactions/transactionAttachmentAccess');

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

function staffToken(propertyId = 1, id = 30) {
  return generateToken({
    id,
    email: `txstaff${id}@oak.test`,
    username: `txstaff${id}`,
    full_name: 'Transaction Staff',
    role: 'Front Office',
    role_id: 3,
    property_id: propertyId,
    scope: 'FULL'
  });
}

function mockPool({ transaction, attachment, superAdminIds = [] } = {}) {
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
      if (text.includes('FROM transactions') && text.includes('property_id')) {
        if (!transaction) return { rows: [], rowCount: 0 };
        if (Number(params[0]) === Number(transaction.id) && Number(params[1]) === Number(transaction.property_id)) {
          return { rows: [transaction], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('FROM transaction_attachments')) {
        if (!attachment) return { rows: [], rowCount: 0 };
        if (
          Number(params[0]) === Number(attachment.id)
          && Number(params[1]) === Number(attachment.transaction_id)
          && Number(params[2]) === Number(attachment.property_id)
        ) {
          return { rows: [attachment], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
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

async function withServer(pool, fn) {
  const app = express();
  app.use('/api/transactions', createTransactionsRouter(pool));
  const { server, port } = await listen(app);
  try {
    await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const uploadRoot = path.join(__dirname, '..', 'uploads', 'transactions');
  fs.mkdirSync(uploadRoot, { recursive: true });
  const safeName = `tx-att-test-${Date.now()}-${process.pid}.jpg`;
  const safeAbs = path.join(uploadRoot, safeName);
  fs.writeFileSync(safeAbs, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  const attachment = {
    id: 77,
    transaction_id: 55,
    property_id: 1,
    mime_type: 'image/jpeg',
    original_name: 'WhatsApp Image 2026-09-06 at 15.23.32.jpeg',
    file_name: safeName,
    storage_path: `/uploads/transactions/${safeName}`
  };
  const transaction = { id: 55, property_id: 1 };

  try {
    await test('authorized same-property stream succeeds with content-type', async () => {
      const pool = mockPool({ transaction, attachment });
      await withServer(pool, async (port) => {
        const res = await request(port, `/api/transactions/55/attachments/77/file?property_id=1`, staffToken(1));
        assert.equal(res.status, 200);
        assert.match(String(res.headers['content-type']), /image\/jpeg/);
        assert.match(String(res.headers['cache-control']), /private/);
        assert.match(String(res.headers['cache-control']), /no-store/);
        assert.ok(res.body.length > 0);
      });
    });

    await test('unauthorized request is rejected', async () => {
      const pool = mockPool({ transaction, attachment });
      await withServer(pool, async (port) => {
        const res = await request(port, `/api/transactions/55/attachments/77/file?property_id=1`);
        assert.equal(res.status, 401);
        assert.equal(res.json.code, 'UNAUTHORIZED');
      });
    });

    await test('cross-property staff is denied', async () => {
      const pool = mockPool({ transaction, attachment });
      await withServer(pool, async (port) => {
        const res = await request(port, `/api/transactions/55/attachments/77/file?property_id=2`, staffToken(1));
        assert.equal(res.status, 403);
        assert.equal(res.json.code, 'FORBIDDEN');
      });
    });

    await test('missing attachment returns 404', async () => {
      const pool = mockPool({ transaction, attachment: null });
      await withServer(pool, async (port) => {
        const res = await request(port, `/api/transactions/55/attachments/999/file?property_id=1`, staffToken(1));
        assert.equal(res.status, 404);
        assert.equal(res.json.code, 'ATTACHMENT_NOT_FOUND');
      });
    });

    await test('attachment must belong to the requested transaction', async () => {
      const pool = mockPool({
        transaction,
        attachment: { ...attachment, transaction_id: 88 }
      });
      await withServer(pool, async (port) => {
        const res = await request(port, `/api/transactions/55/attachments/77/file?property_id=1`, staffToken(1));
        assert.equal(res.status, 404);
        assert.equal(res.json.code, 'ATTACHMENT_NOT_FOUND');
      });
    });

    await test('path traversal / storage escape is rejected', async () => {
      const escaped = {
        ...attachment,
        storage_path: '../../../backend/.env'
      };
      const pool = mockPool({ transaction, attachment: escaped });
      await withServer(pool, async (port) => {
        const res = await request(port, `/api/transactions/55/attachments/77/file?property_id=1`, staffToken(1));
        assert.equal(res.status, 404);
        assert.equal(res.json.code, 'FILE_NOT_FOUND');
      });

      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-tx-att-'));
      assert.equal(resolveSafeTransactionAttachmentPath('../../../etc/passwd', tmpRoot), null);
      assert.equal(resolveSafeTransactionAttachmentPath('..', tmpRoot), null);
      assert.equal(resolveSafeTransactionAttachmentPath('../..', tmpRoot), null);
      assert.equal(resolveSafeTransactionAttachmentPath('/uploads/transactions/..\\..\\secret.txt', tmpRoot), null);
      const ok = resolveSafeTransactionAttachmentPath(`/uploads/transactions/${safeName}`, tmpRoot);
      assert.ok(ok);
      assert.equal(ok, path.resolve(tmpRoot, safeName));
      assert.ok(ok.startsWith(path.resolve(tmpRoot)));
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    await test('file route never returns a public /uploads URL', async () => {
      const pool = mockPool({ transaction, attachment });
      await withServer(pool, async (port) => {
        const res = await request(port, `/api/transactions/55/attachments/77/file?property_id=1`, staffToken(1));
        assert.equal(res.status, 200);
        const asText = res.body.toString('utf8');
        assert.ok(!asText.includes('/uploads/transactions/'));
      });
    });
  } finally {
    fs.unlinkSync(safeAbs);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

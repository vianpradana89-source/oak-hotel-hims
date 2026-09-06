const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const {
  persistIdentityDocument
} = require('../dist/domains/identity/identityDocumentStorageService');
const {
  confirmVerifiedIdentity,
  createPendingIdentityDocumentUpload,
  resolveAuthoritativeIdentityPropertyId
} = require('../dist/domains/identity/identityDocumentUploadService');
const { createIdentityExtractionRouter } = require('../dist/domains/identity/identityExtractionRouter');
const { generateToken } = require('../dist/domains/auth/authService');
const { setStorageAdapterForTesting, calculatePhotoHash } = require('../dist/domains/auth/faceEnrollmentStorageService');

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

function jpegBuffer() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
}

function memoryAdapter() {
  const objects = new Map();
  return {
    provider: 'gcs',
    objects,
    async savePhoto(storageKey, buffer) { objects.set(storageKey, Buffer.from(buffer)); },
    async deletePhoto(storageKey) { objects.delete(storageKey); },
    async photoExists(storageKey) { return objects.has(storageKey); },
    async readPhoto(storageKey) { return objects.get(storageKey) || null; }
  };
}

function staffUser(propertyId = 1, id = 20) {
  return {
    id,
    email: `staff${id}@oak.test`,
    username: `staff${id}`,
    full_name: 'Front Office Staff',
    role: 'Front Office',
    role_id: 3,
    property_id: propertyId,
    scope: 'FULL'
  };
}

function staffToken(propertyId = 1, id = 20) {
  return generateToken(staffUser(propertyId, id));
}

function superAdminPool(userId = 1) {
  return {
    async query(sql, params = []) {
      const text = String(sql);
      if (text.includes('FROM users u') && text.includes('JOIN roles r')) {
        if (Number(params[0]) === userId) {
          return {
            rowCount: 1,
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
            }]
          };
        }
        return { rowCount: 0, rows: [] };
      }
      if (text.includes('FROM properties WHERE id')) {
        return Number(params[0]) > 0 ? { rowCount: 1, rows: [{ id: Number(params[0]) }] } : { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }
  };
}

function createConfirmPool({ upload, guestById = null, guestByNik = null, failAudit = false }) {
  const queries = [];
  const state = { began: false, rolledBack: false, committed: false };
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ text, params });
      if (text === 'BEGIN') { state.began = true; return { rows: [] }; }
      if (text === 'COMMIT') { state.committed = true; return { rows: [] }; }
      if (text === 'ROLLBACK') { state.rolledBack = true; return { rows: [] }; }
      if (text.includes('FROM identity_document_uploads')) {
        return { rowCount: 1, rows: [upload] };
      }
      if (text.includes('SELECT') && text.includes('FROM guests') && text.includes('WHERE id = $1') && text.includes('FOR UPDATE')) {
        return guestById ? { rowCount: 1, rows: [guestById] } : { rowCount: 0, rows: [] };
      }
      if (text.includes('SELECT') && text.includes('normalized_identity_number')) {
        return guestByNik ? { rowCount: 1, rows: [guestByNik] } : { rowCount: 0, rows: [] };
      }
      if (text.includes('SELECT') && text.includes('created_property_id = $1') && text.includes('phone = $2')) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes('INSERT INTO guests')) {
        return {
          rowCount: 1,
          rows: [{
            id: 42,
            created_property_id: upload.property_id,
            identity_storage_key: upload.storage_key,
            identity_file_hash: upload.file_hash,
            identity_mime_type: upload.mime_type
          }]
        };
      }
      if (text.includes('UPDATE guests SET guest_code')) {
        return {
          rowCount: 1,
          rows: [{
            id: 42,
            guest_code: 'GST-00042',
            identity_storage_key: upload.storage_key,
            identity_file_hash: upload.file_hash
          }]
        };
      }
      if (text.includes('UPDATE guests') && text.includes('identity_storage_key')) {
        return {
          rowCount: 1,
          rows: [{
            id: guestById.id,
            created_property_id: guestById.created_property_id,
            identity_storage_key: upload.storage_key,
            identity_file_hash: upload.file_hash,
            identity_mime_type: upload.mime_type,
            identity_path: `/api/identity/document/bound.jpg`
          }]
        };
      }
      if (text.includes('UPDATE identity_document_uploads') && text.includes('confirmed_guest_id')) {
        return { rowCount: 1, rows: [{ id: upload.id }] };
      }
      if (text.includes('INSERT INTO audit_logs')) {
        if (failAudit) throw new Error('audit failed');
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('SELECT * FROM guests WHERE id')) {
        return {
          rowCount: 1,
          rows: [{
            id: upload.confirmed_guest_id,
            identity_storage_key: upload.storage_key,
            full_name: 'Existing'
          }]
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    release() {}
  };
  return {
    queries,
    state,
    async connect() { return client; },
    async query(sql, params = []) {
      const text = String(sql);
      if (text.includes('FROM users u') && text.includes('JOIN roles r')) {
        return { rowCount: 0, rows: [] };
      }
      return client.query(sql, params);
    }
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function request(port, urlPath, { method = 'GET', token, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch { /* ignore */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  const adapter = memoryAdapter();
  setStorageAdapterForTesting(adapter);

  try {
    await test('staff property is token-authoritative and body cannot override', async () => {
      const propertyId = await resolveAuthoritativeIdentityPropertyId(
        { async query() { return { rowCount: 0, rows: [] }; } },
        staffUser(1, 20),
        99
      );
      assert.equal(propertyId, 1);
    });

    await test('Super Admin requires explicit server-validated property context', async () => {
      let threw = false;
      try {
        await resolveAuthoritativeIdentityPropertyId(superAdminPool(1), {
          ...staffUser(1, 1),
          role: 'Super Admin',
          role_id: 1
        });
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'INVALID_PROPERTY_ID');
      }
      assert.equal(threw, true);

      const resolved = await resolveAuthoritativeIdentityPropertyId(superAdminPool(1), {
        ...staffUser(1, 1),
        role: 'Super Admin',
        role_id: 1
      }, 2);
      assert.equal(resolved, 2);
    });

    const buffer = jpegBuffer();
    const persisted = await persistIdentityDocument({
      propertyId: 1,
      buffer,
      mimeType: 'image/jpeg',
      originalFilename: 'identity.jpg',
      size: buffer.length
    });

    await test('authenticated upload receipt is bound to user + property and hides storage_key', async () => {
      const inserts = [];
      const pool = {
        async query(sql, params = []) {
          if (String(sql).includes('INSERT INTO identity_document_uploads')) {
            inserts.push({ sql: String(sql), params });
            return { rowCount: 1, rows: [] };
          }
          throw new Error(`Unexpected query: ${sql}`);
        }
      };
      const receipt = await createPendingIdentityDocumentUpload(pool, {
        propertyId: 1,
        uploadedByUserId: 20,
        persistResult: persisted
      });
      assert.ok(receipt.documentUploadId);
      assert.equal(receipt.apiPath, persisted.apiPath);
      assert.equal(receipt.storageKey, undefined);
      assert.equal(inserts[0].params[2], 20);
      assert.equal(inserts[0].params[1], 1);
      assert.equal(inserts[0].params[3], persisted.storageKey);
      assert.equal(inserts[0].params[4], 'image/jpeg');
      assert.equal(inserts[0].params[5], calculatePhotoHash(buffer));
    });

    const pendingUpload = {
      id: '11111111-1111-4111-8111-111111111111',
      property_id: 1,
      uploaded_by_user_id: 20,
      storage_key: persisted.storageKey,
      mime_type: 'image/jpeg',
      file_hash: persisted.hash,
      original_filename: 'identity.jpg',
      status: 'PENDING',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      confirmed_guest_id: null
    };

    await test('valid receipt + same-property guest confirms using server metadata', async () => {
      const pool = createConfirmPool({
        upload: pendingUpload,
        guestById: { id: 7, created_property_id: 1, identity_storage_key: null }
      });
      const guest = await confirmVerifiedIdentity(pool, {
        document_upload_id: pendingUpload.id,
        actor_user_id: 20,
        is_platform_super_admin: false,
        guest_id: 7,
        property_id: 1,
        name: 'Budi Santoso',
        nik: '3201010101010001',
        identity_file_hash: 'forged-hash',
        identity_mime_type: 'image/png'
      });
      const update = pool.queries.find((q) => q.text.includes('UPDATE guests') && q.text.includes('identity_storage_key'));
      assert.ok(update);
      assert.equal(update.params[7], persisted.storageKey);
      assert.equal(update.params[8], 'image/jpeg');
      assert.equal(update.params[9], persisted.hash);
      assert.notEqual(update.params[9], 'forged-hash');
      assert.equal(guest.identity_storage_key, undefined);
      assert.equal(guest.identity_file_hash, persisted.hash);
      assert.equal(pool.state.committed, true);
      assert.equal(pool.state.rolledBack, false);
    });

    await test('same receipt + same guest retry is idempotent', async () => {
      const pool = createConfirmPool({
        upload: { ...pendingUpload, status: 'CONFIRMED', confirmed_guest_id: 7 },
        guestById: { id: 7, created_property_id: 1, identity_storage_key: persisted.storageKey }
      });
      const guest = await confirmVerifiedIdentity(pool, {
        document_upload_id: pendingUpload.id,
        actor_user_id: 20,
        is_platform_super_admin: false,
        guest_id: 7,
        property_id: 1,
        name: 'Budi Santoso',
        nik: '3201010101010001'
      });
      assert.equal(guest.id, 7);
      assert.equal(pool.queries.some((q) => q.text.includes('INSERT INTO audit_logs')), false);
      assert.equal(pool.state.committed, true);
    });

    await test('same receipt + different guest is denied', async () => {
      const pool = createConfirmPool({
        upload: { ...pendingUpload, status: 'CONFIRMED', confirmed_guest_id: 7 },
        guestById: { id: 9, created_property_id: 1, identity_storage_key: null }
      });
      let threw = false;
      try {
        await confirmVerifiedIdentity(pool, {
          document_upload_id: pendingUpload.id,
          actor_user_id: 20,
          is_platform_super_admin: false,
          guest_id: 9,
          property_id: 1,
          name: 'Other Guest',
          nik: '3201010101010002'
        });
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'DOCUMENT_UPLOAD_ALREADY_CONSUMED');
      }
      assert.equal(threw, true);
      assert.equal(pool.state.rolledBack, true);
    });

    await test('cross-property guest is denied', async () => {
      const pool = createConfirmPool({
        upload: pendingUpload,
        guestById: { id: 8, created_property_id: 2, identity_storage_key: null }
      });
      let threw = false;
      try {
        await confirmVerifiedIdentity(pool, {
          document_upload_id: pendingUpload.id,
          actor_user_id: 20,
          is_platform_super_admin: false,
          guest_id: 8,
          property_id: 1,
          name: 'Other Property Guest',
          nik: '3201010101010003'
        });
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'GUEST_PROPERTY_MISMATCH');
      }
      assert.equal(threw, true);
    });

    await test('receipt from another property is denied', async () => {
      const pool = createConfirmPool({
        upload: { ...pendingUpload, property_id: 2 }
      });
      let threw = false;
      try {
        await confirmVerifiedIdentity(pool, {
          document_upload_id: pendingUpload.id,
          actor_user_id: 20,
          is_platform_super_admin: false,
          property_id: 1,
          name: 'Budi Santoso',
          nik: '3201010101010001'
        });
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'DOCUMENT_UPLOAD_PROPERTY_MISMATCH');
      }
      assert.equal(threw, true);
    });

    await test('receipt from another unauthorized user is denied', async () => {
      const pool = createConfirmPool({
        upload: { ...pendingUpload, uploaded_by_user_id: 99 }
      });
      let threw = false;
      try {
        await confirmVerifiedIdentity(pool, {
          document_upload_id: pendingUpload.id,
          actor_user_id: 20,
          is_platform_super_admin: false,
          property_id: 1,
          name: 'Budi Santoso',
          nik: '3201010101010001'
        });
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'DOCUMENT_UPLOAD_NOT_OWNED');
      }
      assert.equal(threw, true);
    });

    await test('audit failure rolls back guest metadata and receipt confirm', async () => {
      const pool = createConfirmPool({
        upload: pendingUpload,
        guestById: { id: 7, created_property_id: 1, identity_storage_key: null },
        failAudit: true
      });
      let threw = false;
      try {
        await confirmVerifiedIdentity(pool, {
          document_upload_id: pendingUpload.id,
          actor_user_id: 20,
          is_platform_super_admin: false,
          guest_id: 7,
          property_id: 1,
          name: 'Budi Santoso',
          nik: '3201010101010001'
        });
      } catch (err) {
        threw = true;
        assert.match(String(err.message), /audit failed/);
      }
      assert.equal(threw, true);
      assert.equal(pool.state.rolledBack, true);
      assert.equal(pool.state.committed, false);
    });

    await test('unauthenticated extract and confirm are 401', async () => {
      const pool = { async query() { return { rows: [], rowCount: 0 }; } };
      const app = express();
      app.use(express.json());
      app.use('/api/identity', createIdentityExtractionRouter(pool, require('os').tmpdir()));
      const { server, port } = await listen(app);
      try {
        const extractRes = await request(port, '/api/identity/extract', { method: 'POST', body: { image: 'x' } });
        assert.equal(extractRes.status, 401);
        assert.equal(extractRes.json.code, 'UNAUTHORIZED');
        const confirmRes = await request(port, '/api/identity/confirm', {
          method: 'POST',
          body: { name: 'Budi', document_upload_id: pendingUpload.id }
        });
        assert.equal(confirmRes.status, 401);
        assert.equal(confirmRes.json.code, 'UNAUTHORIZED');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    await test('HTTP confirm does not bind by client identity_path', async () => {
      const pool = createConfirmPool({
        upload: pendingUpload,
        guestById: { id: 7, created_property_id: 1, identity_storage_key: null }
      });
      const app = express();
      app.use(express.json());
      app.use('/api/identity', createIdentityExtractionRouter(pool, require('os').tmpdir()));
      const { server, port } = await listen(app);
      try {
        const res = await request(port, '/api/identity/confirm', {
          method: 'POST',
          token: staffToken(1, 20),
          body: {
            name: 'Budi Santoso',
            nik: '3201010101010001',
            guest_id: 7,
            property_id: 99,
            document_upload_id: pendingUpload.id,
            identity_path: '/api/identity/document/totally-different.jpg',
            identity_file_hash: 'forged',
            identity_storage_key: 'identity-documents/2/other.jpg'
          }
        });
        assert.equal(res.status, 200);
        const update = pool.queries.find((q) => q.text.includes('UPDATE guests') && q.text.includes('identity_storage_key'));
        assert.equal(update.params[7], persisted.storageKey);
        assert.equal(update.params[9], persisted.hash);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  } finally {
    setStorageAdapterForTesting(null);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

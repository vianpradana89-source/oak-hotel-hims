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

function createConfirmPool({
  upload,
  guestById = null,
  guestByNik = null,
  failAudit = false,
  auditBinding = undefined
}) {
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
      if (text.includes('SELECT') && text.includes('FROM audit_logs')) {
        if (auditBinding === null) {
          return { rowCount: 0, rows: [] };
        }
        const effectiveBinding = auditBinding || {
          document_upload_id: upload.id,
          property_id: upload.property_id,
          actor_user_id: upload.uploaded_by_user_id,
          confirmed_guest_id: upload.confirmed_guest_id,
          requested_guest_id: guestById ? guestById.id : null,
          reservation_id: null,
          expected_primary_guest_id: null,
          relink_reservation_primary_guest: false,
          context: 'CRM_EDIT',
          normalized_name: 'budi santoso',
          normalized_nik: '3201010101010001'
        };
        return {
          rowCount: 1,
          rows: [{ new_value: JSON.stringify({ operation_binding: effectiveBinding }) }]
        };
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

    await test('R1 repro 1: legacy CRM_EDIT without reservation_id cannot overwrite master guest with different person name', async () => {
      const pool = createConfirmPool({
        upload: pendingUpload,
        guestById: {
          id: 404,
          created_property_id: 1,
          full_name: 'SYNTHETIC GROUP',
          identity_storage_key: null,
          normalized_identity_number: null,
          has_valid_identity: false,
          total_res_count: 5
        }
      });
      let threw = false;
      try {
        await confirmVerifiedIdentity(pool, {
          document_upload_id: pendingUpload.id,
          actor_user_id: 20,
          is_platform_super_admin: false,
          guest_id: 404,
          property_id: 1,
          name: 'SYNTHETIC PERSON NEW',
          nik: '3201010101010099',
          context: 'CRM_EDIT'
        });
      } catch (err) {
        threw = true;
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, 'GUEST_IDENTITY_TARGET_MISMATCH');
      }
      assert.equal(threw, true);
      assert.equal(pool.queries.some((q) => q.text.includes('UPDATE guests')), false);
      assert.equal(pool.state.rolledBack, true);
    });

    await test('R1 repro 2: CONFIRMED receipt replayed on another reservation with different primary guest is rejected', async () => {
      const queries = [];
      const state = { began: false, rolledBack: false, committed: false };
      const synthPool = {
        queries,
        state,
        async connect() {
          return {
            async query(sql, params = []) {
              const text = String(sql);
              queries.push({ text, params });
              if (text === 'BEGIN') { state.began = true; return { rows: [] }; }
              if (text === 'COMMIT') { state.committed = true; return { rows: [] }; }
              if (text === 'ROLLBACK') { state.rolledBack = true; return { rows: [] }; }
              if (text.includes('FROM identity_document_uploads')) {
                return {
                  rowCount: 1,
                  rows: [{ ...pendingUpload, status: 'CONFIRMED', confirmed_guest_id: 900 }]
                };
              }
              if (text.includes('FROM reservations r') && text.includes('FOR UPDATE OF r')) {
                return {
                  rowCount: 1,
                  rows: [{
                    id: 1503,
                    guest_name: 'SYNTHETIC GROUP',
                    guest_phone: '08120000',
                    identity_number: null,
                    has_valid_identity: false,
                    ktp_path: null,
                    property_id: 1
                  }]
                };
              }
              if (text.includes('FROM reservation_guests') && text.includes("role = 'PRIMARY_GUEST'")) {
                return { rowCount: 1, rows: [{ id: 5001, guest_id: 800 }] };
              }
              if (text.includes('SELECT') && text.includes('FROM audit_logs')) {
                return { rowCount: 0, rows: [] };
              }
              if (text.includes('SELECT * FROM guests WHERE id')) {
                return {
                  rowCount: 1,
                  rows: [{ id: 900, full_name: 'SYNTHETIC PERSON A', identity_storage_key: pendingUpload.storage_key }]
                };
              }
              throw new Error(`Unexpected query: ${text}`);
            },
            release() {}
          };
        }
      };

      let threw = false;
      try {
        await confirmVerifiedIdentity(synthPool, {
          document_upload_id: pendingUpload.id,
          actor_user_id: 20,
          is_platform_super_admin: false,
          property_id: 1,
          reservation_id: 1503,
          expected_primary_guest_id: 800,
          guest_id: null,
          name: 'SYNTHETIC PERSON A',
          context: 'RESERVATION_IDENTITY_ASSIGN',
          relink_reservation_primary_guest: true
        });
      } catch (err) {
        threw = true;
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, 'DOCUMENT_UPLOAD_ALREADY_CONSUMED');
        assert.match(String(err.message), /unggah ulang/i);
      }
      assert.equal(threw, true);
      assert.equal(state.committed, false);
      assert.equal(state.rolledBack, true);
    });

    await test('CONFIRMED receipt without audit/binding in Edit Reservasi mode is rejected 409 after upload lock', async () => {
      const queries = [];
      const state = { began: false, rolledBack: false, committed: false };
      const editUnboundPool = {
        queries,
        state,
        async connect() {
          return {
            async query(sql, params = []) {
              const text = String(sql);
              queries.push({ text, params });
              if (text === 'BEGIN') { state.began = true; return { rows: [] }; }
              if (text === 'COMMIT') { state.committed = true; return { rows: [] }; }
              if (text === 'ROLLBACK') { state.rolledBack = true; return { rows: [] }; }
              if (text.includes('FROM identity_document_uploads')) {
                return {
                  rowCount: 1,
                  rows: [{ ...pendingUpload, status: 'CONFIRMED', confirmed_guest_id: 900 }]
                };
              }
              if (text.includes('FROM reservations r') && text.includes('FOR UPDATE OF r')) {
                return {
                  rowCount: 1,
                  rows: [{
                    id: 1503,
                    guest_name: 'SYNTHETIC GROUP',
                    guest_phone: '08120000',
                    identity_number: null,
                    has_valid_identity: false,
                    ktp_path: null,
                    property_id: 1
                  }]
                };
              }
              if (text.includes('FROM reservation_guests') && text.includes("role = 'PRIMARY_GUEST'")) {
                return { rowCount: 1, rows: [{ id: 5001, guest_id: 800 }] };
              }
              if (text.includes('SELECT') && text.includes('FROM audit_logs')) {
                return { rowCount: 0, rows: [] };
              }
              throw new Error(`Unexpected query: ${text}`);
            },
            release() {}
          };
        }
      };

      let threw = false;
      try {
        await confirmVerifiedIdentity(editUnboundPool, {
          document_upload_id: pendingUpload.id,
          actor_user_id: 20,
          is_platform_super_admin: false,
          property_id: 1,
          reservation_id: 1503,
          expected_primary_guest_id: 800,
          guest_id: null,
          name: 'SYNTHETIC PERSON A',
          context: 'RESERVATION_EDIT_IDENTITY',
          relink_reservation_primary_guest: false
        });
      } catch (err) {
        threw = true;
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, 'DOCUMENT_UPLOAD_ALREADY_CONSUMED');
        assert.match(String(err.message), /unggah ulang/i);
      }
      assert.equal(threw, true);
      assert.equal(state.committed, false);
      assert.equal(state.rolledBack, true);
      const uploadLockIdx = queries.findIndex((q) => q.text.includes('FROM identity_document_uploads') && q.text.includes('FOR UPDATE'));
      const auditReadIdx = queries.findIndex((q) => q.text.includes('SELECT') && q.text.includes('FROM audit_logs'));
      assert.ok(uploadLockIdx >= 0 && auditReadIdx > uploadLockIdx, 'Audit binding must be read after upload FOR UPDATE lock');
    });

    await test('CONFIRMED receipt without audit/binding in Assignment mode is rejected 409 even if primary guest and ktp_path match', async () => {
      const queries = [];
      const state = { began: false, rolledBack: false, committed: false };
      const assignUnboundPool = {
        queries,
        state,
        async connect() {
          return {
            async query(sql, params = []) {
              const text = String(sql);
              queries.push({ text, params });
              if (text === 'BEGIN') { state.began = true; return { rows: [] }; }
              if (text === 'COMMIT') { state.committed = true; return { rows: [] }; }
              if (text === 'ROLLBACK') { state.rolledBack = true; return { rows: [] }; }
              if (text.includes('FROM identity_document_uploads')) {
                return {
                  rowCount: 1,
                  rows: [{ ...pendingUpload, status: 'CONFIRMED', confirmed_guest_id: 900 }]
                };
              }
              if (text.includes('FROM reservations r') && text.includes('FOR UPDATE OF r')) {
                return {
                  rowCount: 1,
                  rows: [{
                    id: 1503,
                    guest_name: 'SYNTHETIC PERSON A',
                    guest_phone: '08120000',
                    identity_number: '3201010101010001',
                    has_valid_identity: true,
                    ktp_path: persisted.apiPath,
                    property_id: 1
                  }]
                };
              }
              if (text.includes('FROM reservation_guests') && text.includes("role = 'PRIMARY_GUEST'")) {
                return { rowCount: 1, rows: [{ id: 5001, guest_id: 900 }] };
              }
              if (text.includes('SELECT') && text.includes('FROM audit_logs')) {
                return { rowCount: 0, rows: [] };
              }
              throw new Error(`Unexpected query: ${text}`);
            },
            release() {}
          };
        }
      };

      let threw = false;
      try {
        await confirmVerifiedIdentity(assignUnboundPool, {
          document_upload_id: pendingUpload.id,
          actor_user_id: 20,
          is_platform_super_admin: false,
          property_id: 1,
          reservation_id: 1503,
          expected_primary_guest_id: 800,
          guest_id: null,
          name: 'SYNTHETIC PERSON A',
          nik: '3201010101010001',
          context: 'RESERVATION_IDENTITY_ASSIGN',
          relink_reservation_primary_guest: true
        });
      } catch (err) {
        threw = true;
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, 'DOCUMENT_UPLOAD_ALREADY_CONSUMED');
        assert.match(String(err.message), /unggah ulang/i);
      }
      assert.equal(threw, true);
      assert.equal(state.committed, false);
      assert.equal(state.rolledBack, true);
    });

    await test('valid identical retry in Edit Reservasi and Assignment modes reads binding after upload lock and succeeds', async () => {
      for (const modeCase of [
        { context: 'RESERVATION_EDIT_IDENTITY', relink: false, currentPg: 800 },
        { context: 'RESERVATION_IDENTITY_ASSIGN', relink: true, currentPg: 900 }
      ]) {
        const queries = [];
        const state = { began: false, rolledBack: false, committed: false };
        const validRetryPool = {
          queries,
          state,
          async connect() {
            return {
              async query(sql, params = []) {
                const text = String(sql);
                queries.push({ text, params });
                if (text === 'BEGIN') { state.began = true; return { rows: [] }; }
                if (text === 'COMMIT') { state.committed = true; return { rows: [] }; }
                if (text === 'ROLLBACK') { state.rolledBack = true; return { rows: [] }; }
                if (text.includes('FROM identity_document_uploads')) {
                  return {
                    rowCount: 1,
                    rows: [{ ...pendingUpload, status: 'CONFIRMED', confirmed_guest_id: 900 }]
                  };
                }
                if (text.includes('FROM reservations r') && text.includes('FOR UPDATE OF r')) {
                  return {
                    rowCount: 1,
                    rows: [{
                      id: 1503,
                      guest_name: 'SYNTHETIC PERSON A',
                      guest_phone: '08120000',
                      identity_number: '3201010101010001',
                      has_valid_identity: true,
                      ktp_path: persisted.apiPath,
                      property_id: 1
                    }]
                  };
                }
                if (text.includes('FROM reservation_guests') && text.includes("role = 'PRIMARY_GUEST'")) {
                  return { rowCount: 1, rows: [{ id: 5001, guest_id: modeCase.currentPg }] };
                }
                if (text.includes('SELECT') && text.includes('FROM audit_logs')) {
                  return {
                    rowCount: 1,
                    rows: [{
                      new_value: JSON.stringify({
                        operation_binding: {
                          document_upload_id: pendingUpload.id,
                          property_id: 1,
                          actor_user_id: 20,
                          confirmed_guest_id: 900,
                          requested_guest_id: null,
                          reservation_id: 1503,
                          expected_primary_guest_id: 800,
                          relink_reservation_primary_guest: modeCase.relink,
                          context: modeCase.context,
                          normalized_name: 'synthetic person a',
                          normalized_nik: '3201010101010001'
                        }
                      })
                    }]
                  };
                }
                if (text.includes('SELECT * FROM guests WHERE id')) {
                  return {
                    rowCount: 1,
                    rows: [{
                      id: 900,
                      full_name: 'SYNTHETIC PERSON A',
                      normalized_identity_number: '3201010101010001',
                      identity_storage_key: pendingUpload.storage_key
                    }]
                  };
                }
                throw new Error(`Unexpected query: ${text}`);
              },
              release() {}
            };
          }
        };

        const guest = await confirmVerifiedIdentity(validRetryPool, {
          document_upload_id: pendingUpload.id,
          actor_user_id: 20,
          is_platform_super_admin: false,
          property_id: 1,
          reservation_id: 1503,
          expected_primary_guest_id: 800,
          guest_id: null,
          name: 'SYNTHETIC PERSON A',
          nik: '3201010101010001',
          context: modeCase.context,
          relink_reservation_primary_guest: modeCase.relink
        });
        assert.equal(guest.id, 900);
        assert.equal(state.committed, true);
        assert.equal(state.rolledBack, false);
        const uploadLockIdx = queries.findIndex((q) => q.text.includes('FROM identity_document_uploads') && q.text.includes('FOR UPDATE'));
        const auditReadIdx = queries.findIndex((q) => q.text.includes('SELECT') && q.text.includes('FROM audit_logs'));
        assert.ok(uploadLockIdx >= 0 && auditReadIdx > uploadLockIdx, 'Audit binding must be read after upload FOR UPDATE lock');
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

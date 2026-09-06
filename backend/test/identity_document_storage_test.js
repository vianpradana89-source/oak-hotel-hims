const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  generateIdentityDocumentStorageKey,
  identityDocumentContainsPii,
  persistIdentityDocument,
  readIdentityDocument,
  writeIdentityOcrTempFile,
  cleanupIdentityTempFile,
  buildIdentityDocumentApiPath,
  assertIdentityStorageKeyForProperty,
  decodeIdentityBase64Payload,
  PRIVATE_IDENTITY_DOCUMENT_PREFIX
} = require('../dist/domains/identity/identityDocumentStorageService');
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
    async savePhoto(storageKey, buffer) {
      objects.set(storageKey, Buffer.from(buffer));
    },
    async deletePhoto(storageKey) {
      objects.delete(storageKey);
    },
    async photoExists(storageKey) {
      return objects.has(storageKey);
    },
    async readPhoto(storageKey) {
      return objects.get(storageKey) || null;
    }
  };
}

async function main() {
  const adapter = memoryAdapter();
  setStorageAdapterForTesting(adapter);

  try {
    await test('generated key is property-scoped and contains no PII', async () => {
      const key = generateIdentityDocumentStorageKey(7, 'image/jpeg', 'KTP Budi Santoso NIK 3201010101010001.jpg');
      assert.ok(key.startsWith(`${PRIVATE_IDENTITY_DOCUMENT_PREFIX}7/`));
      assert.ok(!identityDocumentContainsPii(key));
      assert.ok(!key.includes('Budi'));
      assert.ok(!key.includes('3201010101010001'));
      assert.ok(!key.includes('@'));
      assert.ok(!key.includes('gs://'));
      assert.ok(!key.includes('/uploads/'));
    });

    await test('new KTP writes to private storage adapter with SHA-256 and MIME', async () => {
      const buffer = jpegBuffer();
      const persisted = await persistIdentityDocument({
        propertyId: 3,
        buffer,
        mimeType: 'image/jpeg',
        originalFilename: 'scan-ktp.jpg',
        size: buffer.length
      });

      assert.ok(adapter.objects.has(persisted.storageKey));
      assert.equal(persisted.hash, calculatePhotoHash(buffer));
      assert.equal(persisted.mimeType, 'image/jpeg');
      assert.equal(persisted.originalFilename, 'scan-ktp.jpg');
      assert.equal(persisted.apiPath, buildIdentityDocumentApiPath(persisted.storageKey));
      assert.ok(persisted.apiPath.startsWith('/api/identity/document/'));
      assert.ok(!persisted.apiPath.includes('/uploads/'));
      assert.ok(!persisted.apiPath.includes('storage.googleapis.com'));
      assert.ok(!persisted.apiPath.includes('gs://'));
      assert.ok(!persisted.storageKey.includes('/uploads/'));

      const stored = await readIdentityDocument(persisted.storageKey);
      assert.ok(stored);
      assert.deepEqual(stored.buffer, buffer);
    });

    await test('OCR temp files are written under tmpdir and cleaned', async () => {
      const buffer = jpegBuffer();
      const tempPath = await writeIdentityOcrTempFile(buffer, 'image/jpeg');
      assert.ok(tempPath.startsWith(path.resolve(os.tmpdir())));
      assert.ok(fs.existsSync(tempPath));
      await cleanupIdentityTempFile(tempPath);
      assert.equal(fs.existsSync(tempPath), false);

      const outside = path.join(os.tmpdir(), '..', `oak-identity-should-not-delete-${crypto.randomUUID()}.txt`);
      await cleanupIdentityTempFile(outside);
    });

    await test('storage key property prefix is enforced', async () => {
      assert.equal(assertIdentityStorageKeyForProperty('identity-documents/3/11111111-1111-4111-8111-111111111111.jpg', 3), true);
      assert.equal(assertIdentityStorageKeyForProperty('identity-documents/2/11111111-1111-4111-8111-111111111111.jpg', 3), false);
      assert.equal(assertIdentityStorageKeyForProperty('face-enrollment/3/1/x.jpg', 3), false);
    });

    await test('oversized base64 is rejected before persistent upload', async () => {
      const huge = 'A'.repeat(Math.ceil((16 * 1024 * 1024 * 4) / 3));
      let threw = false;
      try {
        decodeIdentityBase64Payload(huge);
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'FILE_TOO_LARGE');
      }
      assert.equal(threw, true);
    });

    await test('guest columns and upload receipts stay additive', async () => {
      const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema_v3.ts'), 'utf8');
      assert.ok(schema.includes("version = 'identity_document_persistent_storage_v1'"));
      assert.ok(schema.includes("version = 'identity_document_uploads_v1'"));
      assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS identity_document_uploads'));
      assert.ok(schema.includes('ADD COLUMN IF NOT EXISTS identity_storage_key'));
      assert.ok(!schema.includes('DROP COLUMN identity_path'));
      assert.ok(!schema.includes('DROP COLUMN ktp_path'));
    });

    await test('reservation upload and identity extract do not emit public /uploads KTP paths', async () => {
      const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
      assert.ok(indexSrc.includes('persistIdentityDocument'));
      assert.ok(indexSrc.includes('ktpPath = persisted.apiPath'));
      assert.match(indexSrc, /ktp_path: ktpPath/);

      const routerSrc = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'domains', 'identity', 'identityExtractionRouter.ts'),
        'utf8'
      );
      assert.ok(routerSrc.includes('file_path: receipt.apiPath'));
      assert.ok(routerSrc.includes('document_upload_id'));
      assert.ok(!routerSrc.includes('`/uploads/${'));
      assert.ok(routerSrc.includes('IDENTITY_DOCUMENT_MISSING_CODE'));
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

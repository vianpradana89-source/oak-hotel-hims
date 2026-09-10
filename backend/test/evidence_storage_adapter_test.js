/**
 * OAK HIMS — Payment Evidence Storage Adapter Test Suite
 *
 * Verifies:
 * 1. LocalStorageAdapter: save, exists, read, delete, path traversal protection
 * 2. GcsStorageAdapter (mocked Storage): private upload, correct bucket, options, exists, read, delete
 * 3. Fail-closed production configuration: missing provider, missing bucket -> STORAGE_CONFIGURATION_ERROR
 * 4. Development fallback: defaults to 'local'
 * 5. Test adapter injection: setStorageAdapterForTesting
 * 6. Domain helpers: saveEvidenceFile, deleteEvidenceFile, evidenceFileExists, getEvidenceFileBuffer
 * 7. Error handling & 404 FILE_NOT_FOUND behavior
 * 8. Canonical storage_key formatting
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const {
  LocalStorageAdapter,
  GcsStorageAdapter,
  setStorageAdapterForTesting,
  getActiveStorageProvider,
  getStorageAdapter,
  saveEvidenceFile,
  deleteEvidenceFile,
  evidenceFileExists,
  getEvidenceFileBuffer,
  generateStorageKey,
  resolveAbsolutePath,
  validateEvidenceUpload,
  isGcsNotFoundError
} = require('../dist/domains/payments/evidenceStorageService');

let passed = 0;
let failed = 0;

function it(desc, fn) {
  try {
    fn();
    console.log(`  ✓ ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${desc}`);
    console.error(err);
    failed++;
  }
}

async function itAsync(desc, fn) {
  try {
    await fn();
    console.log(`  ✓ ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${desc}`);
    console.error(err);
    failed++;
  }
}

async function run() {
  console.log('=== PAYMENT EVIDENCE STORAGE ADAPTER TESTS ===\n');

  // ------------------------------------------------------------------------
  // Suite 1: Canonical Storage Key
  // ------------------------------------------------------------------------
  console.log('Suite 1: Canonical Storage Key Semantics');

  it('1.1 generates canonical key format payment-evidence/{propertyId}/{year}/{month}/{uuid}.{ext}', () => {
    const key = generateStorageKey(1, 'image/jpeg', 'struk.jpg');
    assert.match(key, /^payment-evidence\/1\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);
    assert.strictEqual(key.includes('gs://'), false, 'Key must not include gs://');
    assert.strictEqual(key.includes('https://'), false, 'Key must not include https://');
    assert.strictEqual(key.includes('\\'), false, 'Key must not contain backslashes');
    assert.strictEqual(key.startsWith('/'), false, 'Key must not have leading slash');
  });

  it('1.2 maps png, webp, and pdf mimetypes correctly', () => {
    const keyPng = generateStorageKey(2, 'image/png');
    assert.ok(keyPng.endsWith('.png'));

    const keyWebp = generateStorageKey(2, 'image/webp');
    assert.ok(keyWebp.endsWith('.webp'));

    const keyPdf = generateStorageKey(2, 'application/pdf');
    assert.ok(keyPdf.endsWith('.pdf'));
  });

  // ------------------------------------------------------------------------
  // Suite 2: LocalStorageAdapter
  // ------------------------------------------------------------------------
  console.log('\nSuite 2: LocalStorageAdapter Operations');

  const localAdapter = new LocalStorageAdapter();
  const testKey = `payment-evidence/999/2026/09/test-${Date.now()}.jpg`;
  const testData = Buffer.from('TEST_PAYMENT_EVIDENCE_LOCAL_123');

  await itAsync('2.1 save writes file to disk', async () => {
    await localAdapter.save(testKey, testData, 'image/jpeg');
    const absPath = resolveAbsolutePath(testKey);
    assert.strictEqual(fs.existsSync(absPath), true);
  });

  await itAsync('2.2 exists returns true for existing file', async () => {
    const exists = await localAdapter.exists(testKey);
    assert.strictEqual(exists, true);
  });

  await itAsync('2.3 exists returns false for nonexistent file', async () => {
    const exists = await localAdapter.exists('payment-evidence/999/2026/09/nonexistent.jpg');
    assert.strictEqual(exists, false);
  });

  await itAsync('2.4 read returns buffer identical to written content', async () => {
    const readBuf = await localAdapter.read(testKey);
    assert.ok(readBuf);
    assert.strictEqual(readBuf.toString(), 'TEST_PAYMENT_EVIDENCE_LOCAL_123');
  });

  await itAsync('2.5 delete removes file from disk', async () => {
    await localAdapter.delete(testKey);
    const absPath = resolveAbsolutePath(testKey);
    assert.strictEqual(fs.existsSync(absPath), false);
    const exists = await localAdapter.exists(testKey);
    assert.strictEqual(exists, false);
  });

  await itAsync('2.6 path traversal is rejected on save', async () => {
    let threw = false;
    try {
      await localAdapter.save('../../etc/passwd', testData, 'image/jpeg');
    } catch (err) {
      threw = true;
      assert.strictEqual(err.code, 'INVALID_STORAGE_KEY');
    }
    assert.strictEqual(threw, true);
  });

  await itAsync('2.7 read on non-existent file returns null', async () => {
    const result = await localAdapter.read('payment-evidence/999/2026/09/never_existed.jpg');
    assert.strictEqual(result, null);
  });

  // ------------------------------------------------------------------------
  // Suite 3: GcsStorageAdapter (Mocked Storage)
  // ------------------------------------------------------------------------
  console.log('\nSuite 3: GcsStorageAdapter Operations (Mocked Storage)');

  let mockSavedKey = null;
  let mockSavedBuffer = null;
  let mockSavedOpts = null;
  let mockDeletedKey = null;
  let mockDeleteOpts = null;
  let mockExistsHandler = async () => [true];
  let mockDownloadHandler = async () => [Buffer.from('GCS_MOCK_PAYMENT_DATA')];

  const mockStorage = {
    bucket: (bName) => ({
      name: bName,
      file: (key) => ({
        save: async (buf, opts) => {
          mockSavedKey = key;
          mockSavedBuffer = buf;
          mockSavedOpts = opts;
        },
        delete: async (opts) => {
          mockDeletedKey = key;
          mockDeleteOpts = opts;
        },
        exists: async () => mockExistsHandler(),
        download: async () => mockDownloadHandler()
      })
    })
  };

  const gcsAdapter = new GcsStorageAdapter('oak-hims-payment-evidence-staging', mockStorage);

  it('3.1 validates bucket name in constructor', () => {
    let threw = false;
    try {
      new GcsStorageAdapter('');
    } catch (err) {
      threw = true;
      assert.strictEqual(err.code, 'STORAGE_CONFIGURATION_ERROR');
    }
    assert.strictEqual(threw, true);
  });

  await itAsync('3.2 save uploads to configured bucket with private cache-control', async () => {
    const gcsKey = 'payment-evidence/1/2026/09/mock-uuid-123.jpg';
    const gcsBuf = Buffer.from('EVIDENCE_PAYLOAD');
    await gcsAdapter.save(gcsKey, gcsBuf, 'image/jpeg');

    assert.strictEqual(mockSavedKey, gcsKey);
    assert.strictEqual(mockSavedBuffer.toString(), 'EVIDENCE_PAYLOAD');
    assert.strictEqual(mockSavedOpts.contentType, 'image/jpeg');
    assert.strictEqual(mockSavedOpts.resumable, false);
    assert.strictEqual(mockSavedOpts.metadata?.cacheControl, 'private, max-age=0, no-transform');
    assert.strictEqual(mockSavedOpts.predefinedAcl, undefined, 'Must not set public ACL');
  });

  await itAsync('3.3 exists delegates to file.exists returning true/false', async () => {
    mockExistsHandler = async () => [true];
    const ex1 = await gcsAdapter.exists('payment-evidence/1/test.jpg');
    assert.strictEqual(ex1, true);

    mockExistsHandler = async () => [false];
    const ex2 = await gcsAdapter.exists('payment-evidence/1/test.jpg');
    assert.strictEqual(ex2, false);
  });

  await itAsync('3.4 read downloads buffer from bucket', async () => {
    mockDownloadHandler = async () => [Buffer.from('GCS_MOCK_PAYMENT_DATA')];
    const downloaded = await gcsAdapter.read('payment-evidence/1/test.jpg');
    assert.ok(downloaded);
    assert.strictEqual(downloaded.toString(), 'GCS_MOCK_PAYMENT_DATA');
  });

  await itAsync('3.5 delete uses ignoreNotFound: true', async () => {
    await gcsAdapter.delete('payment-evidence/1/delete-me.jpg');
    assert.strictEqual(mockDeletedKey, 'payment-evidence/1/delete-me.jpg');
    assert.strictEqual(mockDeleteOpts?.ignoreNotFound, true);
  });

  await itAsync('3.6 GCS object 404 (err.code = 404) => read returns null', async () => {
    mockDownloadHandler = async () => {
      const err = new Error('No such object');
      err.code = 404;
      throw err;
    };
    const res = await gcsAdapter.read('payment-evidence/1/missing-404.jpg');
    assert.strictEqual(res, null, 'GCS 404 must return null');
  });

  await itAsync('3.7 GCS object 404 (err.message contains "No such object") => read returns null', async () => {
    mockDownloadHandler = async () => {
      throw new Error('No such object: oak-hims-payment-evidence-staging/test.jpg');
    };
    const res = await gcsAdapter.read('payment-evidence/1/missing-msg.jpg');
    assert.strictEqual(res, null, 'GCS missing object message must return null');
  });

  await itAsync('3.8 GCS 403 IAM/permission error is NOT converted to null and is rethrown', async () => {
    const iamError = new Error('Access denied: caller does not have storage.objects.get');
    iamError.code = 403;
    mockDownloadHandler = async () => {
      throw iamError;
    };

    let caught = null;
    try {
      await gcsAdapter.read('payment-evidence/1/forbidden.jpg');
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, 'Must throw error on GCS 403');
    assert.strictEqual(caught.code, 403);
    assert.strictEqual(caught.message, 'Access denied: caller does not have storage.objects.get');
  });

  await itAsync('3.9 GCS generic/network error is NOT converted to null and is propagated', async () => {
    const netError = new Error('connect ECONNREFUSED 142.250.186.42:443');
    netError.code = 'ECONNREFUSED';
    mockDownloadHandler = async () => {
      throw netError;
    };

    let caught = null;
    try {
      await gcsAdapter.read('payment-evidence/1/neterr.jpg');
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, 'Must throw error on generic network error');
    assert.strictEqual(caught.code, 'ECONNREFUSED');
  });

  await itAsync('3.10 GCS exists returns false on object 404 error', async () => {
    mockExistsHandler = async () => {
      const err = new Error('No such object');
      err.code = 404;
      throw err;
    };
    const res = await gcsAdapter.exists('payment-evidence/1/nonexistent.jpg');
    assert.strictEqual(res, false);
  });

  await itAsync('3.11 GCS exists rethrows 403 IAM error and does not silently return false', async () => {
    const iamError = new Error('Permission denied on bucket');
    iamError.code = 403;
    mockExistsHandler = async () => {
      throw iamError;
    };

    let caught = null;
    try {
      await gcsAdapter.exists('payment-evidence/1/check.jpg');
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, 'Must rethrow IAM error from exists()');
    assert.strictEqual(caught.code, 403);
  });

  await itAsync('3.12 GCS exists rethrows network error and does not silently return false', async () => {
    const netError = new Error('ETIMEDOUT');
    netError.code = 'ETIMEDOUT';
    mockExistsHandler = async () => {
      throw netError;
    };

    let caught = null;
    try {
      await gcsAdapter.exists('payment-evidence/1/check.jpg');
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, 'Must rethrow network error from exists()');
    assert.strictEqual(caught.code, 'ETIMEDOUT');
  });

  await itAsync('3.13 generic non-object error containing "Not Found" without 404 signal is NOT converted to null and is rethrown', async () => {
    const genericErr = new Error('getaddrinfo ENOTFOUND storage.googleapis.com (Host Not Found)');
    genericErr.code = 'ENOTFOUND';
    mockDownloadHandler = async () => {
      throw genericErr;
    };

    let caught = null;
    try {
      await gcsAdapter.read('payment-evidence/1/check.jpg');
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, 'Must throw error on generic Not Found error without 404 signal');
    assert.strictEqual(caught.code, 'ENOTFOUND');
    assert.strictEqual(caught.message.includes('Host Not Found'), true);
  });

  it('3.14 isGcsNotFoundError returns false for generic "Not Found" message without 404 code or "No such object"', () => {
    assert.strictEqual(isGcsNotFoundError(new Error('Bucket Not Found')), false);
    assert.strictEqual(isGcsNotFoundError(new Error('Host Not Found')), false);
    assert.strictEqual(isGcsNotFoundError({ code: 'ENOTFOUND', message: 'DNS Not Found' }), false);
    assert.strictEqual(isGcsNotFoundError({ code: 404 }), true);
    assert.strictEqual(isGcsNotFoundError({ statusCode: 404 }), true);
    assert.strictEqual(isGcsNotFoundError({ errors: [{ reason: 'notFound' }] }), true);
    assert.strictEqual(isGcsNotFoundError(new Error('No such object in bucket')), true);
  });

  // ------------------------------------------------------------------------
  // Suite 4: Fail-closed Production Configuration
  // ------------------------------------------------------------------------
  console.log('\nSuite 4: Fail-closed Production Configuration');

  const origEnv = { ...process.env };

  try {
    setStorageAdapterForTesting(null);

    // 4.1 Production with missing PAYMENT_EVIDENCE_STORAGE_PROVIDER -> STORAGE_CONFIGURATION_ERROR
    process.env.NODE_ENV = 'production';
    delete process.env.PAYMENT_EVIDENCE_STORAGE_PROVIDER;
    delete process.env.PAYMENT_EVIDENCE_GCS_BUCKET;

    it('4.1 production with missing provider throws STORAGE_CONFIGURATION_ERROR', () => {
      let threw = false;
      try {
        getActiveStorageProvider();
      } catch (err) {
        threw = true;
        assert.strictEqual(err.code, 'STORAGE_CONFIGURATION_ERROR');
      }
      assert.strictEqual(threw, true, 'Must fail closed in production without explicit provider');
    });

    // 4.2 Production with invalid provider -> STORAGE_CONFIGURATION_ERROR
    process.env.PAYMENT_EVIDENCE_STORAGE_PROVIDER = 's3_bucket';
    it('4.2 production with invalid provider throws STORAGE_CONFIGURATION_ERROR', () => {
      let threw = false;
      try {
        getActiveStorageProvider();
      } catch (err) {
        threw = true;
        assert.strictEqual(err.code, 'STORAGE_CONFIGURATION_ERROR');
      }
      assert.strictEqual(threw, true);
    });

    // 4.3 Production with gcs provider but missing bucket -> STORAGE_CONFIGURATION_ERROR
    process.env.PAYMENT_EVIDENCE_STORAGE_PROVIDER = 'gcs';
    delete process.env.PAYMENT_EVIDENCE_GCS_BUCKET;
    it('4.3 production GCS provider without bucket throws STORAGE_CONFIGURATION_ERROR', () => {
      let threw = false;
      try {
        getStorageAdapter();
      } catch (err) {
        threw = true;
        assert.strictEqual(err.code, 'STORAGE_CONFIGURATION_ERROR');
      }
      assert.strictEqual(threw, true);
    });

    // 4.4 Development without provider -> defaults to local
    process.env.NODE_ENV = 'development';
    delete process.env.PAYMENT_EVIDENCE_STORAGE_PROVIDER;
    delete process.env.PAYMENT_EVIDENCE_GCS_BUCKET;
    it('4.4 development without provider defaults to local', () => {
      const provider = getActiveStorageProvider();
      assert.strictEqual(provider, 'local');
      const adapter = getStorageAdapter();
      assert.strictEqual(adapter.provider, 'local');
    });

  } finally {
    process.env = { ...origEnv };
    setStorageAdapterForTesting(null);
  }

  // ------------------------------------------------------------------------
  // Suite 5: Test Adapter Injection (setStorageAdapterForTesting)
  // ------------------------------------------------------------------------
  console.log('\nSuite 5: Test Adapter Injection');

  const customMock = {
    provider: 'gcs',
    save: async () => {},
    delete: async () => {},
    exists: async () => true,
    read: async () => Buffer.from('CUSTOM_INJECTED_MOCK')
  };

  setStorageAdapterForTesting(customMock);
  it('5.1 setStorageAdapterForTesting overrides active adapter', () => {
    assert.strictEqual(getActiveStorageProvider(), 'gcs');
    assert.strictEqual(getStorageAdapter(), customMock);
  });

  await itAsync('5.2 getEvidenceFileBuffer uses injected adapter', async () => {
    const buf = await getEvidenceFileBuffer('payment-evidence/1/injected.jpg');
    assert.strictEqual(buf.toString(), 'CUSTOM_INJECTED_MOCK');
  });

  setStorageAdapterForTesting(null);
  it('5.3 setStorageAdapterForTesting(null) restores default behavior', () => {
    assert.strictEqual(getActiveStorageProvider(), 'local');
  });

  // ------------------------------------------------------------------------
  // Suite 6: Domain-level Helpers & 404 FILE_NOT_FOUND
  // ------------------------------------------------------------------------
  console.log('\nSuite 6: Domain-level Helpers & 404 Behavior');

  await itAsync('6.1 getEvidenceFileBuffer on nonexistent file throws 404 FILE_NOT_FOUND', async () => {
    let caughtErr = null;
    try {
      await getEvidenceFileBuffer('payment-evidence/999/2026/09/does_not_exist_xyz.jpg');
    } catch (err) {
      caughtErr = err;
    }
    assert.ok(caughtErr);
    assert.strictEqual(caughtErr.statusCode, 404);
    assert.strictEqual(caughtErr.code, 'FILE_NOT_FOUND');
    assert.strictEqual(caughtErr.message, 'Evidence file not found in storage');
  });

  await itAsync('6.2 getEvidenceFileBuffer with path traversal throws 404 FILE_NOT_FOUND', async () => {
    let caughtErr = null;
    try {
      await getEvidenceFileBuffer('../../../etc/shadow');
    } catch (err) {
      caughtErr = err;
    }
    assert.ok(caughtErr);
    assert.strictEqual(caughtErr.statusCode, 404);
    assert.strictEqual(caughtErr.code, 'FILE_NOT_FOUND');
  });

  await itAsync('6.3 saveEvidenceFile -> exists -> read -> delete round-trip', async () => {
    const file = {
      mimetype: 'image/jpeg',
      size: 15,
      originalname: 'struk_test.jpg',
      buffer: Buffer.from('TEST_ROUND_TRIP')
    };

    const saved = await saveEvidenceFile(1, file);
    assert.ok(saved.storageKey);
    assert.strictEqual(saved.fileSizeBytes, 15);
    assert.strictEqual(saved.provider, 'local');
    assert.ok(saved.absolutePath);

    const existsBefore = await evidenceFileExists(saved.storageKey);
    assert.strictEqual(existsBefore, true);

    const readBuf = await getEvidenceFileBuffer(saved.storageKey);
    assert.strictEqual(readBuf.toString(), 'TEST_ROUND_TRIP');

    await deleteEvidenceFile(saved.storageKey);

    const existsAfter = await evidenceFileExists(saved.storageKey);
    assert.strictEqual(existsAfter, false);
  });

  await itAsync('6.4 getEvidenceFileBuffer propagates GCS 403 error without converting to 404', async () => {
    const iamError = new Error('Permission denied by IAM policy');
    iamError.code = 403;
    const failingAdapter = {
      provider: 'gcs',
      save: async () => {},
      delete: async () => {},
      exists: async () => true,
      read: async () => { throw iamError; }
    };

    setStorageAdapterForTesting(failingAdapter);
    try {
      let caught = null;
      try {
        await getEvidenceFileBuffer('payment-evidence/1/check.jpg');
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.strictEqual(caught.code, 403, 'Must retain original error code 403');
      assert.notStrictEqual(caught.code, 'FILE_NOT_FOUND', 'Must NOT convert 403 to FILE_NOT_FOUND');
    } finally {
      setStorageAdapterForTesting(null);
    }
  });

  await itAsync('6.5 evidenceFileExists propagates GCS 403 error without converting to false', async () => {
    const iamError = new Error('Permission denied by IAM policy');
    iamError.code = 403;
    const failingAdapter = {
      provider: 'gcs',
      save: async () => {},
      delete: async () => {},
      exists: async () => { throw iamError; },
      read: async () => null
    };

    setStorageAdapterForTesting(failingAdapter);
    try {
      let caught = null;
      try {
        await evidenceFileExists('payment-evidence/1/check.jpg');
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.strictEqual(caught.code, 403, 'Must retain original error code 403');
    } finally {
      setStorageAdapterForTesting(null);
    }
  });

  console.log(`\n========================================`);
  console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Unhandled test failure:', err);
  process.exit(1);
});

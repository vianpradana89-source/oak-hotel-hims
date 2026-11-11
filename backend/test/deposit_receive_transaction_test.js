// DEPOSIT-RECEIVE-TRANSACTION-TEST: Fase 2A DB-free.
// Verifies transaction lifecycle of the receiveDeposit wrapper and its core,
// including evidence ownership, replay, and validation/property guards.
// No Pool / no real database.
const assert = require('node:assert');
const Module = require('node:module');

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

function loadService() {
  const servicePath = require.resolve('../dist/domains/deposits/depositService');
  delete require.cache[servicePath];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent && parent.filename === servicePath) {
      if (request === '../stayCharges/stayChargesService') {
        return { recalculateReservationFinancials: async () => ({ remaining_balance: 400 }) };
      }
      if (request === '../payments/evidenceStorageService') {
        return {
          validateEvidenceUpload: () => ({ valid: true }),
          saveEvidenceFile: saveEvidenceFileMock,
          deleteEvidenceFile: deleteEvidenceFileMock
        };
      }
      if (request === './depositNumberService') {
        return { generateDepositNumber: async () => 'DEP-OAK-99999' };
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(servicePath);
  } finally {
    Module._load = originalLoad;
  }
}

function receivePool({ replayRows = () => [] } = {}) {
  const commands = [];
  let rolledBack = 0;
  const DEPOSIT_ROW = { id: 10, property_id: 1, reservation_id: 20, deposit_number: 'DEP-OAK-99999', reference_code: 'DEP-OAK-99999', original_amount: 1000, purpose: 'ADVANCE_PAYMENT' };
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      commands.push(text);
      if (text === 'BEGIN') return { rows: [], rowCount: 0 };
      if (text === 'COMMIT') return { rows: [], rowCount: 0 };
      if (text === 'ROLLBACK') { rolledBack += 1; return { rows: [], rowCount: 0 }; }
      if (text.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
      if (text.includes('FROM reservations r')) {
        return { rows: [{ id: 20, booking_property_id: 1, status: 'BOOKED', booking_id: null }], rowCount: 1 };
      }
      if (text.includes('WHERE e.property_id') && text.includes('idempotency_key')) {
        const rows = replayRows(params);
        return { rows, rowCount: rows.length };
      }
      if (text === 'SELECT * FROM deposits WHERE id = $1') {
        return { rows: [{ ...DEPOSIT_ROW, status: 'RECEIVED' }], rowCount: 1 };
      }
      if (text.includes('FROM deposit_events e') && text.includes('ORDER BY e.id')) {
        return { rows: [{ id: 2, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'RECEIVED', amount: 1000, reversed_event_type: null }], rowCount: 1 };
      }
      if (text.includes('INSERT INTO payment_transactions')) return { rows: [{ id: 5, transaction_type: 'DEPOSIT', amount: params[3], payment_method: params[4] }], rowCount: 1 };
      if (text.includes('INSERT INTO payment_evidences')) return { rows: [{ id: 9, storage_key: params[4] }], rowCount: 1 };
      if (text.includes('INSERT INTO deposits')) return { rows: [DEPOSIT_ROW], rowCount: 1 };
      if (text.includes('INSERT INTO deposit_events')) return { rows: [{ id: 2, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'RECEIVED', amount: params[4] }], rowCount: 1 };
      if (text.startsWith('UPDATE deposits SET status')) return { rows: [], rowCount: 1 };
      if (text.includes('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    release() { commands.push('RELEASE'); }
  };
  return { pool: { connect: async () => client }, commands, client };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => error && error.code === code);
}

// Shared storage mock: both the wrapper's owner path and any direct core
// calls go through these functions, so assertions on saved/deleted keys see
// every file operation that occurred across the whole test.
const storage = {
  savedKeys: [],
  deletedKeys: []
};
async function saveEvidenceFileMock(propertyId, file) {
  const key = `dep-receipt/${propertyId}/${file.originalname}`;
  storage.savedKeys.push(key);
  return { storageKey: key };
}
async function deleteEvidenceFileMock(key) {
  storage.deletedKeys.push(key);
}

async function main() {
  const { receiveDeposit, receiveDepositInTransaction } = loadService();
  const actor = { userId: '7', name: 'Front Desk', role: 'Front Office' };
  const evidence = { originalname: 'proof.jpg', mimetype: 'image/jpeg', size: 10 };
  const base = {
    propertyId: 1, reservationId: 20, amount: 1000,
    paymentMethod: 'CASH', idempotencyKey: 'receive-tx-1',
    purpose: 'ADVANCE_PAYMENT', actor, evidence
  };
  // Stateful replay rows: the first call for 'receive-replay-1' simulates
  // "no row yet" (fresh receive); subsequent calls see the committed replay row.
  const replayEvent = {
    id: 2, deposit_id: 10, property_id: 1, reservation_id: 20,
    event_type: 'RECEIVED', amount: 1000, payment_method: 'CASH',
    idempotency_key: 'receive-replay-1', deposit_number: 'DEP-OAK-99999',
    reversed_event_type: null
  };

  // CASE 1: the core manages no transaction lifecycle — it never issues
  // BEGIN/COMMIT/ROLLBACK and never releases the client it is handed.
  // No evidence: evidence-less path requires no owner registration.
  await test('core receives a pre-opened client and performs no lifecycle management', async () => {
    const { client, commands } = receivePool();
    await client.query('BEGIN');
    const noEvidence = { ...base, evidence: undefined };
    const result = await receiveDepositInTransaction(client, noEvidence);
    assert.strictEqual(result.balance.status, 'RECEIVED');
    assert.deepStrictEqual(
      commands.filter(cmd => ['BEGIN', 'COMMIT', 'ROLLBACK', 'RELEASE'].includes(cmd)),
      ['BEGIN']
    );
  });

  // CASE 2: the wrapper owns the lifecycle — BEGIN first, COMMIT after the
  // core succeeds, then exactly one client release.
  await test('wrapper success opens, commits, and releases the client', async () => {
    const { pool, commands } = receivePool();
    const result = await receiveDeposit(pool, base);
    assert.strictEqual(result.balance.status, 'RECEIVED');
    const lifecycle = commands.filter(cmd => ['BEGIN', 'COMMIT', 'ROLLBACK', 'RELEASE'].includes(cmd));
    assert.deepStrictEqual(lifecycle, ['BEGIN', 'COMMIT', 'RELEASE']);
    assert.ok(storage.savedKeys.includes('dep-receipt/1/proof.jpg'));
  });

  // CASE 3: wrapper failure BEFORE evidence save (payment insert throws).
  // The owner has no registered key, so no cleanup is performed. The wrapper
  // must still roll back, release the client, and forward the original error.
  await test('wrapper failure before evidence save: rolls back, no cleanup, forwards error', async () => {
    const { pool, commands } = receivePool();
    const boom = Object.assign(new Error('db exploded'), { code: 'DB_EXPLODED', statusCode: 500 });
    const client = await pool.connect();
    const originalQuery = client.query.bind(client);
    let failedInsert = false;
    client.query = async (sql, params) => {
      const text = String(sql);
      if (text.includes('INSERT INTO payment_transactions') && !failedInsert) {
        failedInsert = true;
        throw boom;
      }
      return originalQuery(text, params);
    };
    pool.connect = async () => client;
    storage.savedKeys.length = 0;
    storage.deletedKeys.length = 0;
    await assert.rejects(receiveDeposit(pool, base), error => error.code === 'DB_EXPLODED' && error.message === 'db exploded');
    // The payment insert throws before saveEvidenceFile is reached,
    // so no storage key was registered — the owner has nothing to clean up.
    assert.strictEqual(storage.savedKeys.length, 0, 'evidence is saved after payment insert, which failed');
    assert.deepStrictEqual(storage.deletedKeys, []);
    const lifecycle = commands.filter(cmd => ['BEGIN', 'COMMIT', 'ROLLBACK', 'RELEASE'].includes(cmd));
    assert.deepStrictEqual(lifecycle, ['BEGIN', 'ROLLBACK', 'RELEASE']);
  });

  // CASE 4: failure AFTER evidence was saved and registered with the owner
  // (a later DB step inside the core throws). The wrapper's owner path must
  // still clean up the storage key. Also verifies the core alone, without an
  // owner, never cleans up — cleanup belongs to the lifecycle owner.
  await test('post-save evidence failure is cleaned up by the owner', async () => {
    storage.savedKeys.length = 0;
    storage.deletedKeys.length = 0;
    const { pool } = receivePool();
    const client = await pool.connect();
    const originalQuery = client.query.bind(client);
    client.query = async (sql, params) => {
      const text = String(sql);
      if (text.includes('INSERT INTO deposits')) {
        throw new Error('deposit insert failed');
      }
      return originalQuery(text, params);
    };
    pool.connect = async () => client;
    await assert.rejects(receiveDeposit(pool, base), error => error.message === 'deposit insert failed');
    assert.strictEqual(storage.savedKeys.length, 1);
    assert.ok(storage.deletedKeys.includes('dep-receipt/1/proof.jpg'));
  });
  // CASE 4b-1 (P2A-R1-01): core called WITHOUT owner must be rejected BEFORE
  // saveEvidenceFile / INSERT evidence, so no orphaned file can be created.
  // The ownerless path no longer silently accepts an evidence-less owner.
  await test('core without owner rejects before evidence save (no orphaned file)', async () => {
    storage.savedKeys.length = 0;
    storage.deletedKeys.length = 0;
    const { client, commands } = receivePool();
    await client.query('BEGIN');
    // No owner is passed. The core must reject with EVIDENCE_OWNER_REQUIRED
    // before saveEvidenceFile is called.
    await assert.rejects(
      receiveDepositInTransaction(client, base),
      error => error.code === 'EVIDENCE_OWNER_REQUIRED' && error.statusCode === 400
    );
    // No file was saved, no key registered.
    assert.strictEqual(storage.savedKeys.length, 0, 'no evidence file should be saved without owner');
    assert.deepStrictEqual(storage.deletedKeys, []);
    assert.ok(!commands.some(sql => sql.includes('INSERT INTO')), 'ownerless call must not write any receipt/evidence/event');
  });

  // CASE 4b-2 (P2A-R1-01): with an explicit owner, the key is registered
  // BEFORE INSERT evidence can fail; on rollback the caller can clean up.
  await test('owner receives key before INSERT evidence fails; caller can clean up after rollback', async () => {
    storage.savedKeys.length = 0;
    storage.deletedKeys.length = 0;
    const { client } = receivePool();
    await client.query('BEGIN');
    // Make INSERT payment_evidences throw after evidence file is saved
    const originalQuery = client.query.bind(client);
    let evidenceInsertFired = false;
    client.query = async (sql, params) => {
      const text = String(sql);
      if (text.includes('INSERT INTO payment_evidences') && !evidenceInsertFired) {
        assert.strictEqual(registeredKeys.length, 1, 'key must already be registered when INSERT starts');
        evidenceInsertFired = true;
        throw new Error('evidence insert failed');
      }
      return originalQuery(text, params);
    };
    // A minimal owner object matching EvidenceRegisteringOwner
    const registeredKeys = [];
    const owner = {
      registerStorageKey(key) { registeredKeys.push(key); },
      isOwnedByCaller() { return true; }
    };
    await assert.rejects(
      receiveDepositInTransaction(client, base, owner),
      error => error.message === 'evidence insert failed'
    );
    // The owner registered the key BEFORE INSERT evidence threw.
    // The guard only rejects when owner is absent; with an owner, save +
    // register proceed, and only the subsequent INSERT evidence fails.
    assert.strictEqual(registeredKeys.length, 1, 'owner must register key before INSERT evidence');
    assert.strictEqual(registeredKeys[0], 'dep-receipt/1/proof.jpg');
    // Storage mock: file was saved; caller can now delete it
    assert.strictEqual(storage.savedKeys.length, 1);
    assert.deepStrictEqual(storage.deletedKeys, []); // core never cleans up
    // Caller rolls back its transaction, then compensates owned resources.
    await client.query('ROLLBACK');
    await deleteEvidenceFileMock(registeredKeys[0]);
    assert.ok(storage.deletedKeys.includes('dep-receipt/1/proof.jpg'));
  });

  // CASE 5: a successful receive keeps the evidence file; a replay with the
  // same idempotency key returns the existing record and creates no new
  // receipt, no new storage key, and no new file.
  await test('success keeps the evidence and replay adds no receipt or file', async () => {
    storage.savedKeys.length = 0;
    storage.deletedKeys.length = 0;
    let replaySeen = false;
    // First call: the key has not been committed yet → empty → fresh receive.
    let callCount = 0;
    const { pool } = receivePool({
      replayRows(params) {
        callCount += 1;
        if (params[1] === 'receive-replay-1' && callCount > 1) {
          replaySeen = true;
          return [replayEvent];
        }
        return [];
      }
    });
    const first = await receiveDeposit(pool, { ...base, idempotencyKey: 'receive-replay-1' });
    assert.strictEqual(first.idempotent_replay, undefined);
    assert.strictEqual(storage.savedKeys.length, 1);
    assert.strictEqual(storage.savedKeys[0], 'dep-receipt/1/proof.jpg');
    // Second call: same key now matches replayEvent → replay, no new file.
    const replay = await receiveDeposit(pool, { ...base, idempotencyKey: 'receive-replay-1' });
    assert.strictEqual(replay.idempotent_replay, true);
    assert.strictEqual(replay.id, 10);
    assert.strictEqual(storage.savedKeys.length, 1);
    assert.deepStrictEqual(storage.deletedKeys, []);
    assert.ok(replaySeen);
  });

  // CASE 6: validation and property guards stay active in the new wrapper.
  // All of these reject BEFORE a pool connection is ever taken.
  await test('validation and property guards still reject before connecting', async () => {
    const neverPool = { connect: async () => { throw new Error('validation reached database'); } };
    await rejectsCode(receiveDeposit(neverPool, { ...base, amount: 0 }), 'VALIDATION_ERROR');
    await rejectsCode(receiveDeposit(neverPool, { ...base, paymentMethod: 'CRYPTO' }), 'UNSUPPORTED_PAYMENT_METHOD');
    await rejectsCode(receiveDeposit(neverPool, { ...base, purpose: 'GRATUITY' }), 'VALIDATION_ERROR');
    await rejectsCode(receiveDeposit(neverPool, { ...base, idempotencyKey: '   ' }), 'IDEMPOTENCY_KEY_REQUIRED');
  });
  await test('cross-property reservation is rejected inside the transaction', async () => {
    const fixture = receivePool();
    const client = await fixture.pool.connect();
    const originalQuery = client.query.bind(client);
    client.query = async (sql, params) => {
      const text = String(sql);
      if (text.includes('FROM reservations r')) {
        return { rows: [{ id: 20, booking_property_id: 99, status: 'BOOKED', booking_id: null }], rowCount: 1 };
      }
      return originalQuery(text, params);
    };
    fixture.pool.connect = async () => client;
    await rejectsCode(receiveDeposit(fixture.pool, { ...base, idempotencyKey: 'receive-xprop' }), 'CROSS_PROPERTY_RESERVATION');
    const lifecycle = fixture.commands.filter(cmd => ['BEGIN', 'COMMIT', 'ROLLBACK', 'RELEASE'].includes(cmd));
    assert.deepStrictEqual(lifecycle, ['BEGIN', 'ROLLBACK', 'RELEASE']);
  });

  // Receipt guard: the stored projection is a DEPOSIT receipt. The payment
  // transaction type written by the wrapper path must remain DEPOSIT.
  await test('receipt writes a DEPOSIT payment transaction with the generated reference', async () => {
    storage.savedKeys.length = 0;
    storage.deletedKeys.length = 0;
    const { pool, commands } = receivePool();
    const result = await receiveDeposit(pool, { ...base, idempotencyKey: 'receive-receipt-type' });
    assert.strictEqual(result.payment.transaction_type, 'DEPOSIT');
    const paymentInsert = commands.find(cmd => cmd.includes('INSERT INTO payment_transactions'));
    assert.ok(paymentInsert.includes("'DEPOSIT'"));
    assert.ok(result.reference_code === result.deposit_number && result.reference_code === 'DEP-OAK-99999');
  });

  console.log(`RESULT: PASS=${passed} FAIL=${failed} TOTAL=${passed + failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  console.log(`RESULT: PASS=${passed} FAIL=${failed + 1} TOTAL=${passed + failed + 1}`);
  process.exitCode = 1;
});

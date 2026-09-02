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
    if (parent && parent.filename === servicePath && request === '../stayCharges/stayChargesService') {
      return { recalculateReservationFinancials: async () => { throw new Error('replay recalculated financials'); } };
    }
    if (parent && parent.filename === servicePath && request === '../payments/evidenceStorageService') {
      return {
        validateEvidenceUpload: () => ({ valid: true }),
        saveEvidenceFile: async () => { throw new Error('replay wrote evidence'); },
        deleteEvidenceFile: async () => {}
      };
    }
    if (parent && parent.filename === servicePath && request === './depositNumberService') {
      return { generateDepositNumber: async () => { throw new Error('replay allocated a number'); } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(servicePath);
  } finally {
    Module._load = originalLoad;
  }
}

function replayPool({ actualType, depositId = 10, replayDepositId = 10 }) {
  const mutations = [];
  const replayEvent = {
    id: 80,
    deposit_id: replayDepositId,
    property_id: 1,
    reservation_id: 20,
    event_type: actualType,
    amount: 500,
    payment_method: actualType === 'RECEIVED' ? 'CASH' : actualType === 'REFUND' ? 'TRANSFER' : null,
    notes: actualType === 'REVERSAL' ? 'duplicate request' : null,
    idempotency_key: 'stable-key',
    reversed_event_type: actualType === 'REVERSAL' ? 'RECEIVED' : null,
    deposit_number: 'DEP-OAK-00001'
  };
  const receipt = {
    id: actualType === 'RECEIVED' ? 80 : 1,
    deposit_id: replayDepositId,
    property_id: 1,
    reservation_id: 20,
    event_type: 'RECEIVED',
    amount: 500,
    idempotency_key: actualType === 'RECEIVED' ? 'stable-key' : 'original-receipt'
  };
  const events = actualType === 'RECEIVED' ? [replayEvent] : [receipt, replayEvent];
  const client = {
    async query(sql) {
      const text = String(sql);
      if (/^(INSERT|UPDATE|DELETE)/.test(text.trim())) mutations.push(text);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (text.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
      if (text.includes('FROM reservations r')) return { rows: [{ id: 20, booking_property_id: 1 }], rowCount: 1 };
      if (text.includes('SELECT * FROM deposits') && text.includes('FOR UPDATE')) {
        return { rows: [{ id: depositId, property_id: 1, reservation_id: 20, original_amount: 500, deposit_number: 'DEP-OAK-00001' }], rowCount: 1 };
      }
      if (text.includes('WHERE e.property_id') && text.includes('idempotency_key')) return { rows: [replayEvent], rowCount: 1 };
      if (text === 'SELECT * FROM deposits WHERE id = $1') {
        return { rows: [{ id: replayDepositId, property_id: 1, reservation_id: 20, original_amount: 500, deposit_number: 'DEP-OAK-00001' }], rowCount: 1 };
      }
      if (text.includes('FROM deposit_events e') && text.includes('ORDER BY e.id')) return { rows: events, rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    release() {}
  };
  return { pool: { connect: async () => client }, mutations };
}

async function expectReplay(operation, type, input) {
  const fixture = replayPool({ actualType: type });
  const result = await operation(fixture.pool, input);
  assert.strictEqual(result.idempotent_replay, true);
  assert.strictEqual(result.event ? result.event.id : result.events[0].id, 80);
  assert.deepStrictEqual(fixture.mutations, []);
}

async function main() {
  const { applyDeposit, receiveDeposit, refundDeposit, reverseDeposit } = loadService();
  const actor = { userId: '7', name: 'Front Desk', role: 'Front Office' };
  const base = { propertyId: 1, reservationId: 20, idempotencyKey: 'stable-key', actor };

  await test('receive replay returns the existing deposit without mutation', () => expectReplay(receiveDeposit, 'RECEIVED', {
    ...base, amount: 500, paymentMethod: 'cash'
  }));
  await test('apply replay returns the original event without another folio credit', () => expectReplay(applyDeposit, 'APPLY', {
    ...base, depositId: 10, amount: 500
  }));
  await test('refund replay returns the original event without another payment', () => expectReplay(refundDeposit, 'REFUND', {
    ...base, depositId: 10, amount: 500, paymentMethod: 'transfer'
  }));
  await test('reversal replay returns the original reversal without another refund', () => expectReplay(reverseDeposit, 'REVERSAL', {
    ...base, depositId: 10, reason: 'duplicate request'
  }));

  await test('a key cannot be reused for a different operation type', async () => {
    const fixture = replayPool({ actualType: 'REFUND' });
    await assert.rejects(applyDeposit(fixture.pool, { ...base, depositId: 10, amount: 100 }), error => error.code === 'IDEMPOTENCY_KEY_REUSED');
    assert.deepStrictEqual(fixture.mutations, []);
  });
  await test('a key cannot be reused by another deposit', async () => {
    const fixture = replayPool({ actualType: 'APPLY', depositId: 10, replayDepositId: 99 });
    await assert.rejects(applyDeposit(fixture.pool, { ...base, depositId: 10, amount: 100 }), error => error.code === 'IDEMPOTENCY_KEY_REUSED');
    assert.deepStrictEqual(fixture.mutations, []);
  });
  await test('a receive key cannot be replayed with a different amount', async () => {
    const fixture = replayPool({ actualType: 'RECEIVED' });
    await assert.rejects(receiveDeposit(fixture.pool, {
      ...base, amount: 501, paymentMethod: 'CASH'
    }), error => error.code === 'IDEMPOTENCY_KEY_REUSED');
    assert.deepStrictEqual(fixture.mutations, []);
  });
  await test('an apply key cannot be replayed with a different amount', async () => {
    const fixture = replayPool({ actualType: 'APPLY' });
    await assert.rejects(applyDeposit(fixture.pool, {
      ...base, depositId: 10, amount: 499
    }), error => error.code === 'IDEMPOTENCY_KEY_REUSED');
    assert.deepStrictEqual(fixture.mutations, []);
  });
  await test('idempotency keys are scoped by property in the lookup', async () => {
    const fixture = replayPool({ actualType: 'RECEIVED' });
    await receiveDeposit(fixture.pool, { ...base, amount: 500, paymentMethod: 'CASH' });
    // The fake only responds to the authoritative property/key predicate.
    assert.deepStrictEqual(fixture.mutations, []);
  });
  await test('keys longer than 150 characters are rejected before a connection', async () => {
    const pool = { connect: async () => { throw new Error('connected'); } };
    await assert.rejects(receiveDeposit(pool, {
      ...base, amount: 500, paymentMethod: 'CASH', idempotencyKey: 'x'.repeat(151)
    }), error => error.code === 'IDEMPOTENCY_KEY_REQUIRED');
  });

  console.log(`RESULT: PASS=${passed} FAIL=${failed} TOTAL=${passed + failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  console.log(`RESULT: PASS=${passed} FAIL=${failed + 1} TOTAL=${passed + failed + 1}`);
  process.exitCode = 1;
});

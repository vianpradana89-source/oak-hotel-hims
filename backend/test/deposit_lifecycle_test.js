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

async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => error && error.code === code);
}

function loadService() {
  const servicePath = require.resolve('../dist/domains/deposits/depositService');
  delete require.cache[servicePath];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent && parent.filename === servicePath && request === '../stayCharges/stayChargesService') {
      return { recalculateReservationFinancials: async () => ({ remaining_balance: 400 }) };
    }
    if (parent && parent.filename === servicePath && request === '../payments/evidenceStorageService') {
      return {
        validateEvidenceUpload: () => ({ valid: true }),
        saveEvidenceFile: async () => ({ storageKey: 'unused' }),
        deleteEvidenceFile: async () => {}
      };
    }
    if (parent && parent.filename === servicePath && request === './depositNumberService') {
      return { generateDepositNumber: async () => 'DEP-OAK-00001' };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(servicePath);
  } finally {
    Module._load = originalLoad;
  }
}

function applyPool() {
  const received = { id: 1, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'RECEIVED', amount: 1000 };
  const events = [received];
  const queries = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ text, params });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (text.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
      if (text.includes('FROM reservations r')) return { rows: [{ id: 20, booking_property_id: 1 }], rowCount: 1 };
      if (text.includes('SELECT * FROM deposits') && text.includes('FOR UPDATE')) {
        return { rows: [{ id: 10, property_id: 1, reservation_id: 20, deposit_number: 'DEP-OAK-00001', original_amount: 1000 }], rowCount: 1 };
      }
      if (text.includes('WHERE e.property_id') && text.includes('idempotency_key')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO folio_entries')) return { rows: [{ id: 70, amount: params[3], direction: 'CREDIT', entry_type: 'DEPOSIT_APPLY' }], rowCount: 1 };
      if (text.includes('INSERT INTO deposit_events')) {
        const event = { id: 2, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'APPLY', amount: params[3], folio_entry_id: 70 };
        events.push(event);
        return { rows: [event], rowCount: 1 };
      }
      if (text.includes('FROM deposit_events e') && text.includes('ORDER BY e.id')) return { rows: events.slice(), rowCount: events.length };
      if (text.startsWith('UPDATE deposits SET status')) return { rows: [], rowCount: 1 };
      if (text.includes('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
      if (text === 'SELECT * FROM deposits WHERE id = $1') {
        return { rows: [{ id: 10, property_id: 1, reservation_id: 20, deposit_number: 'DEP-OAK-00001', original_amount: 1000, status: 'PARTIALLY_USED' }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    release() {}
  };
  return { pool: { connect: async () => client }, queries };
}

async function main() {
  const { applyDeposit, deriveDepositBalance, receiveDeposit, refundDeposit, reverseDeposit } = loadService();
  const received = amount => ({ event_type: 'RECEIVED', amount });

  await test('new receipt is fully available and RECEIVED', () => {
    assert.deepStrictEqual(deriveDepositBalance([received(1000)]), {
      effective_received: 1000, applied: 0, refunded: 0, reversed_received: 0, remaining: 1000, status: 'RECEIVED'
    });
  });
  await test('partial application derives PARTIALLY_USED', () => {
    assert.strictEqual(deriveDepositBalance([received(1000), { event_type: 'APPLY', amount: 250 }]).status, 'PARTIALLY_USED');
  });
  await test('partial refund derives PARTIALLY_USED', () => {
    const balance = deriveDepositBalance([received(1000), { event_type: 'REFUND', amount: 300 }]);
    assert.deepStrictEqual([balance.refunded, balance.remaining, balance.status], [300, 700, 'PARTIALLY_USED']);
  });
  await test('mixed apply and refund can close the deposit', () => {
    const balance = deriveDepositBalance([received(1000), { event_type: 'APPLY', amount: 600 }, { event_type: 'REFUND', amount: 400 }]);
    assert.deepStrictEqual([balance.applied, balance.refunded, balance.remaining, balance.status], [600, 400, 0, 'CLOSED']);
  });
  await test('full application closes the deposit', () => {
    assert.strictEqual(deriveDepositBalance([received(1000), { event_type: 'APPLY', amount: 1000 }]).status, 'CLOSED');
  });
  await test('full refund closes the deposit', () => {
    assert.strictEqual(deriveDepositBalance([received(1000), { event_type: 'REFUND', amount: 1000 }]).status, 'CLOSED');
  });
  await test('unused receipt reversal cancels the deposit', () => {
    const balance = deriveDepositBalance([received(1000), { event_type: 'REVERSAL', amount: 1000, reversed_event_type: 'RECEIVED' }]);
    assert.deepStrictEqual([balance.effective_received, balance.reversed_received, balance.remaining, balance.status], [0, 1000, 0, 'CANCELLED']);
  });
  await test('over-application violates the ledger invariant', () => rejectsCode(
    Promise.resolve().then(() => deriveDepositBalance([received(1000), { event_type: 'APPLY', amount: 1001 }])),
    'DEPOSIT_INVARIANT_VIOLATION'
  ));
  await test('over-refund violates the ledger invariant', () => rejectsCode(
    Promise.resolve().then(() => deriveDepositBalance([received(1000), { event_type: 'REFUND', amount: 1001 }])),
    'DEPOSIT_INVARIANT_VIOLATION'
  ));
  await test('reversing a non-receipt event is rejected', () => rejectsCode(
    Promise.resolve().then(() => deriveDepositBalance([received(1000), { event_type: 'REVERSAL', amount: 100, reversed_event_type: 'APPLY' }])),
    'UNSUPPORTED_REVERSAL'
  ));
  await test('unknown event types are rejected', () => rejectsCode(
    Promise.resolve().then(() => deriveDepositBalance([received(1000), { event_type: 'WRITE_OFF', amount: 1 }])),
    'DEPOSIT_INVARIANT_VIOLATION'
  ));
  await test('unsafe integer amounts are rejected', () => rejectsCode(
    Promise.resolve().then(() => deriveDepositBalance([received(Number.MAX_SAFE_INTEGER + 1)])),
    'DEPOSIT_INVARIANT_VIOLATION'
  ));

  const neverPool = { connect: async () => { throw new Error('validation reached database'); } };
  const actor = { userId: '7', name: 'Front Desk', role: 'Front Office' };
  await test('receive requires a positive integer amount', () => rejectsCode(receiveDeposit(neverPool, {
    propertyId: 1, reservationId: 2, amount: 0, paymentMethod: 'CASH', idempotencyKey: 'receive-1', actor
  }), 'VALIDATION_ERROR'));
  await test('receive rejects unsupported payment methods before connecting', () => rejectsCode(receiveDeposit(neverPool, {
    propertyId: 1, reservationId: 2, amount: 100, paymentMethod: 'CRYPTO', idempotencyKey: 'receive-2', actor
  }), 'UNSUPPORTED_PAYMENT_METHOD'));
  await test('apply requires an idempotency key', () => rejectsCode(applyDeposit(neverPool, {
    propertyId: 1, reservationId: 2, depositId: 3, amount: 100, idempotencyKey: ' ', actor
  }), 'IDEMPOTENCY_KEY_REQUIRED'));
  await test('refund validates its deposit identifier', () => rejectsCode(refundDeposit(neverPool, {
    propertyId: 1, reservationId: 2, depositId: -1, amount: 100, paymentMethod: 'CASH', idempotencyKey: 'refund-1', actor
  }), 'VALIDATION_ERROR'));
  await test('reversal requires a reason', () => rejectsCode(reverseDeposit(neverPool, {
    propertyId: 1, reservationId: 2, depositId: 3, idempotencyKey: 'reverse-1', reason: ' ', actor
  }), 'REVERSAL_REASON_REQUIRED'));
  await test('apply posts a credit projection and updates status from authoritative events', async () => {
    const { pool, queries } = applyPool();
    const result = await applyDeposit(pool, {
      propertyId: 1, reservationId: 20, depositId: 10, amount: 400, idempotencyKey: 'apply-happy', actor
    });
    assert.strictEqual(result.balance.status, 'PARTIALLY_USED');
    assert.strictEqual(result.balance.remaining, 600);
    const folioInsert = queries.find(query => query.text.includes('INSERT INTO folio_entries'));
    assert.ok(folioInsert);
    assert.ok(folioInsert.text.includes("'CREDIT'"));
    assert.ok(folioInsert.text.includes("'DEPOSIT_APPLY'"));
    assert.ok(queries.some(query => query.text === 'COMMIT'));
    assert.ok(!queries.some(query => query.text === 'ROLLBACK'));
  });

  console.log(`RESULT: PASS=${passed} FAIL=${failed} TOTAL=${passed + failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  console.log(`RESULT: PASS=${passed} FAIL=${failed + 1} TOTAL=${passed + failed + 1}`);
  process.exitCode = 1;
});

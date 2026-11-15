/**
 * deposit_purpose_phase_a_test.js
 *
 * DEPOSIT-PURPOSE-PHASE-A — unit tests (mock pool, no DB) covering the 9
 * minimal Phase A scenarios:
 *
 *  1. new ADVANCE_PAYMENT receive -> success + purpose benar
 *  2. new SECURITY_DEPOSIT receive -> success + purpose benar
 *  3. missing purpose create baru -> 400 VALIDATION_ERROR
 *  4. invalid purpose -> 400 VALIDATION_ERROR
 *  5. legacy purpose NULL tetap readable (read path, via hydrate SELECT *)
 *  6. APPLY SECURITY_DEPOSIT -> 409 SECURITY_DEPOSIT_APPLY_FORBIDDEN
 *  7. APPLY ADVANCE_PAYMENT -> existing behavior tetap jalan (folio CREDIT)
 *  8. APPLY legacy NULL -> existing backward-compatible behavior tetap jalan
 *  9. deriveDepositBalance UNAPPLY-aware: UNAPPLY reduces applied, increases
 *     remaining; over-unapply violates invariant (schema support only).
 *
 * These tests run against the compiled service (dist/) with a mocked pool,
 * so they are safe to run locally without a database.
 */

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
      return { recalculateReservationFinancials: async () => ({ remaining_balance: 1000, amount_paid: 0 }) };
    }
    if (parent && parent.filename === servicePath && request === '../payments/evidenceStorageService') {
      return {
        validateEvidenceUpload: () => ({ valid: true }),
        saveEvidenceFile: async () => ({ storageKey: 'unused' }),
        deleteEvidenceFile: async () => {}
      };
    }
    if (parent && parent.filename === servicePath && request === './depositNumberService') {
      return { generateDepositNumber: async () => 'DEP-OAK-99999' };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(servicePath);
  } finally {
    Module._load = originalLoad;
  }
}

/**
 * Mock pool that records every INSERT so assertions can inspect the exact SQL
 * + parameters the service issued. Simulates a clean "receive then read" flow.
 */
function receivePool() {
  const inserts = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (text.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
      if (text.includes('FROM reservations r')) return { rows: [{ id: 20, booking_property_id: 1, booking_id: null }], rowCount: 1 };
      if (text.includes('WHERE e.property_id') && text.includes('idempotency_key')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO payment_transactions')) {
        return { rows: [{ id: 501, ...params }] , rowCount: 1 };
      }
      if (text.includes('INSERT INTO deposits')) {
        // params order: property, reservation, deposit_number, amount, method, received_by, notes, booking_id, scope, purpose
        const row = {
          id: 77,
          property_id: params[0],
          reservation_id: params[1],
          deposit_number: params[2],
          original_amount: params[3],
          payment_method: params[4],
          status: 'RECEIVED',
          received_by: params[5],
          notes: params[6],
          booking_id: params[7],
          scope: params[8],
          purpose: params[9],
        };
        inserts.push({ text, params });
        return { rows: [row], rowCount: 1 };
      }
      if (text.includes('INSERT INTO deposit_events')) {
        const event = { id: 88, deposit_id: params[0], property_id: params[1], reservation_id: params[2], event_type: 'RECEIVED', amount: params[4] };
        return { rows: [event], rowCount: 1 };
      }
      if (text.includes('FROM deposit_events e') && text.includes('ORDER BY e.id')) {
        return { rows: [{ id: 88, event_type: 'RECEIVED', amount: 500000, reversal_of_event_type: null }], rowCount: 1 };
      }
      if (text.startsWith('UPDATE deposits SET status')) return { rows: [], rowCount: 1 };
      if (text.includes('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
      if (text === 'SELECT * FROM deposits WHERE id = $1') {
        return {
          rows: [{ id: 77, property_id: 1, reservation_id: 20, original_amount: 500000, deposit_number: 'DEP-OAK-99999', status: 'RECEIVED', purpose: lastReplayPurpose }],
          rowCount: 1
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    release() {}
  };
  // Captured from the deposits INSERT so the hydration step reads back the
  // purpose that was actually written (simulates a real DB round-trip).
  const originalQuery = client.query;
  let lastReplayPurpose = null;
  client.query = async (sql, params = []) => {
    const res = await originalQuery.call(client, sql, params);
    if (String(sql).includes('INSERT INTO deposits')) {
      lastReplayPurpose = params[9];
    }
    return res;
  };
  return { pool: { connect: async () => client }, inserts };
}

function applyPool({ purpose }) {
  // Mock pool for applyDeposit. Returns a deposit row with the given purpose
  // (null simulates legacy). Like deposit_lifecycle_test.js, the events array
  // accumulates so that after an APPLY the projection re-derives the balance
  // from RECEIVED + APPLY (-> PARTIALLY_USED).
  const events = [
    { id: 2, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'RECEIVED', amount: 500000, reversal_of_event_type: null }
  ];
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (text.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
      if (text.includes('FROM reservations r')) return { rows: [{ id: 20, booking_property_id: 1, booking_id: null }], rowCount: 1 };
      if (text.includes('SELECT * FROM deposits') && text.includes('FOR UPDATE')) {
        return { rows: [{ id: 10, property_id: 1, reservation_id: 20, deposit_number: 'DEP-OAK-00001', original_amount: 500000, status: 'RECEIVED', purpose }], rowCount: 1 };
      }
      if (text.includes('WHERE e.property_id') && text.includes('idempotency_key')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM deposit_events e') && text.includes('ORDER BY e.id')) {
        return { rows: events.slice(), rowCount: events.length };
      }
      if (text.includes('INSERT INTO folio_entries')) {
        return { rows: [{ id: 70, amount: params[3], direction: 'CREDIT', entry_type: 'DEPOSIT_APPLY' }], rowCount: 1 };
      }
      if (text.includes('INSERT INTO deposit_events')) {
        const event = { id: 21, deposit_id: 10, property_id: 1, reservation_id: 20, event_type: 'APPLY', amount: params[3], folio_entry_id: 70 };
        events.push(event);
        return { rows: [event], rowCount: 1 };
      }
      if (text.startsWith('UPDATE deposits SET status')) return { rows: [], rowCount: 1 };
      if (text.includes('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
      if (text === 'SELECT * FROM deposits WHERE id = $1') {
        return { rows: [{ id: 10, property_id: 1, reservation_id: 20, deposit_number: 'DEP-OAK-00001', original_amount: 500000, status: 'PARTIALLY_USED', purpose }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    release() {}
  };
  return { pool: { connect: async () => client } };
}

async function main() {
  const { receiveDeposit, applyDeposit, deriveDepositBalance } = loadService();
  const actor = { userId: '7', name: 'Front Desk', role: 'Front Office' };

  // ── 1 & 2: new ADVANCE_PAYMENT / SECURITY_DEPOSIT receive succeed with correct purpose
  for (const [purpose, label] of [['ADVANCE_PAYMENT', 'ADVANCE_PAYMENT'], ['SECURITY_DEPOSIT', 'SECURITY_DEPOSIT']]) {
    await test(`receive with purpose=${label} persists the purpose on the deposit row`, async () => {
      const fixture = receivePool();
      const result = await receiveDeposit(fixture.pool, {
        propertyId: 1, reservationId: 20, amount: 500000, paymentMethod: 'CASH',
        idempotencyKey: `recv-${purpose}`, actor, purpose
      });
      assert.strictEqual(result.purpose, purpose, 'deposit row must carry the requested purpose');
      const depositInsert = fixture.inserts.find(i => i.text.includes('INSERT INTO deposits'));
      assert.ok(depositInsert, 'a deposits INSERT must be issued');
      // params[9] is purpose in the new 10-param INSERT
      assert.strictEqual(depositInsert.params[9], purpose, 'purpose must be persisted in the INSERT params');
    });
  }

  // ── 3: missing purpose -> 400 VALIDATION_ERROR
  await test('missing purpose on a new receive is rejected with VALIDATION_ERROR', async () => {
    const pool = { connect: async () => { throw new Error('should not reach DB'); } };
    await rejectsCode(receiveDeposit(pool, {
      propertyId: 1, reservationId: 20, amount: 500000, paymentMethod: 'CASH',
      idempotencyKey: 'recv-missing-purpose', actor
      // purpose intentionally omitted
    }), 'VALIDATION_ERROR');
  });

  // ── 4: invalid purpose -> 400 VALIDATION_ERROR
  // Note: 'advance_payment' (lowercase) is intentionally NOT in this list —
  // purpose is case-insensitive and normalizes to ADVANCE_PAYMENT (valid).
  for (const bad of [null, '', ' ', 'GIFTS', 'SECURITY', 'ADVANCE', 'SECURITY_DEPOSIT_S', 123]) {
    await test(`invalid purpose (${JSON.stringify(bad)}) on a new receive is rejected with VALIDATION_ERROR`, async () => {
      const pool = { connect: async () => { throw new Error('should not reach DB'); } };
      await rejectsCode(receiveDeposit(pool, {
        propertyId: 1, reservationId: 20, amount: 500000, paymentMethod: 'CASH',
        idempotencyKey: `recv-bad-purpose-${String(bad)}`, actor, purpose: bad
      }), 'VALIDATION_ERROR');
    });
  }

  // ── 5: legacy purpose NULL remains readable (read path passes NULL through)
  await test('a legacy deposit row with purpose=NULL is readable as-is (no backfill)', async () => {
    const fixture = applyPool({ purpose: null });
    const result = await applyDeposit(fixture.pool, {
      propertyId: 1, reservationId: 20, depositId: 10, amount: 400,
      idempotencyKey: 'apply-legacy-null', actor
    });
    // Legacy NULL purpose is permissive: apply succeeds and the row keeps purpose=null.
    assert.strictEqual(result.deposit.purpose, null, 'legacy deposit keeps NULL purpose through apply');
    assert.strictEqual(result.balance.status, 'PARTIALLY_USED');
  });

  // ── 6: APPLY SECURITY_DEPOSIT -> 409 SECURITY_DEPOSIT_APPLY_FORBIDDEN
  await test('applyDeposit on a SECURITY_DEPOSIT is blocked with SECURITY_DEPOSIT_APPLY_FORBIDDEN', async () => {
    const fixture = applyPool({ purpose: 'SECURITY_DEPOSIT' });
    await rejectsCode(applyDeposit(fixture.pool, {
      propertyId: 1, reservationId: 20, depositId: 10, amount: 400,
      idempotencyKey: 'apply-security', actor
    }), 'SECURITY_DEPOSIT_APPLY_FORBIDDEN');
  });

  // ── 7: APPLY ADVANCE_PAYMENT -> existing behavior (folio CREDIT) still works
  await test('applyDeposit on an ADVANCE_PAYMENT still posts a CREDIT folio entry', async () => {
    const fixture = applyPool({ purpose: 'ADVANCE_PAYMENT' });
    const result = await applyDeposit(fixture.pool, {
      propertyId: 1, reservationId: 20, depositId: 10, amount: 400,
      idempotencyKey: 'apply-advance', actor
    });
    assert.strictEqual(result.balance.status, 'PARTIALLY_USED');
    assert.strictEqual(result.folio_entry.direction, 'CREDIT');
    assert.strictEqual(result.folio_entry.entry_type, 'DEPOSIT_APPLY');
  });

  // ── 8: APPLY legacy NULL -> existing backward-compatible behavior still works
  await test('applyDeposit on a legacy (NULL purpose) deposit keeps the original behavior', async () => {
    const fixture = applyPool({ purpose: null });
    const result = await applyDeposit(fixture.pool, {
      propertyId: 1, reservationId: 20, depositId: 10, amount: 400,
      idempotencyKey: 'apply-legacy', actor
    });
    assert.strictEqual(result.balance.status, 'PARTIALLY_USED');
    assert.strictEqual(result.folio_entry.entry_type, 'DEPOSIT_APPLY');
  });

  // ── 9: deriveDepositBalance is UNAPPLY-aware (schema support; no service yet)
  await test('deriveDepositBalance treats UNAPPLY as reversing a prior APPLY', () => {
    const events = [
      { event_type: 'RECEIVED', amount: 1000 },
      { event_type: 'APPLY', amount: 600 },
      { event_type: 'UNAPPLY', amount: 600, folio_entry_id: 5, reversal_of_event_id: 2 }
    ];
    const bal = deriveDepositBalance(events);
    assert.strictEqual(bal.applied, 0, 'full UNAPPLY of an APPLY zeroes applied');
    assert.strictEqual(bal.remaining, 1000, 'UNAPPLY returns the amount to custody');
    assert.strictEqual(bal.status, 'RECEIVED');
  });
  await test('deriveDepositBalance partial UNAPPLY leaves a positive applied balance', () => {
    const events = [
      { event_type: 'RECEIVED', amount: 1000 },
      { event_type: 'APPLY', amount: 600 },
      { event_type: 'UNAPPLY', amount: 250, folio_entry_id: 5, reversal_of_event_id: 2 }
    ];
    const bal = deriveDepositBalance(events);
    assert.strictEqual(bal.applied, 350);
    assert.strictEqual(bal.remaining, 650);
    assert.strictEqual(bal.status, 'PARTIALLY_USED');
  });
  await test('over-UNAPPLY (unapplied > applied) violates the ledger invariant', async () => {
    const events = [
      { event_type: 'RECEIVED', amount: 1000 },
      { event_type: 'APPLY', amount: 600 },
      { event_type: 'UNAPPLY', amount: 900, folio_entry_id: 5, reversal_of_event_id: 2 }
    ];
    await rejectsCode(Promise.resolve().then(() => deriveDepositBalance(events)), 'DEPOSIT_INVARIANT_VIOLATION');
  });

  console.log(`RESULT: PASS=${passed} FAIL=${failed} TOTAL=${passed + failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  console.log(`RESULT: PASS=${passed} FAIL=${failed + 1} TOTAL=${passed + failed + 1}`);
  process.exitCode = 1;
});

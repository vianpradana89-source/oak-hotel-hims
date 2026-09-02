const assert = require('node:assert');
const {
  getHeldIdentityCustodyForCheckout,
  getIdentityCustodyByReservation,
  holdIdentity,
  returnIdentity
} = require('../dist/domains/identity/identityCustodyService');

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

function custodyPool(options = {}) {
  const calls = [];
  let released = false;
  const existing = options.existing || {
    id: 50, property_id: 1, reservation_id: 20, document_type: 'KTP', document_holder_name: 'Guest Name', status: 'HELD'
  };
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ text, params });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (text.includes('FROM reservations r')) {
        return options.ownership === false ? { rows: [], rowCount: 0 } : { rows: [{ id: 20, status: options.reservationStatus || 'BOOKED' }], rowCount: 1 };
      }
      if (text.includes('INSERT INTO identity_custody')) {
        return { rows: [{ id: 50, property_id: params[0], reservation_id: params[1], document_type: params[2], document_holder_name: params[3], status: 'HELD', received_by: params[5] }], rowCount: 1 };
      }
      if (text.includes('SELECT * FROM identity_custody')) {
        return options.found === false ? { rows: [], rowCount: 0 } : { rows: [existing], rowCount: 1 };
      }
      if (text.includes('UPDATE identity_custody')) {
        return { rows: [{ ...existing, status: 'RETURNED', returned_by: params[0], returned_at: '2026-09-02T00:00:00.000Z' }], rowCount: 1 };
      }
      if (text.includes('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    release() { released = true; }
  };
  return { pool: { connect: async () => client }, client, calls, wasReleased: () => released };
}

const actor = { userId: '7', name: 'Front Desk', role: 'Front Office' };

async function main() {
  await test('holding identity normalizes document type and trims holder name', async () => {
    const fixture = custodyPool();
    const result = await holdIdentity(fixture.pool, {
      propertyId: 1, reservationId: 20, documentType: ' ktp ', documentHolderName: ' Guest Name ', actor
    });
    assert.strictEqual(result.document_type, 'KTP');
    assert.strictEqual(result.document_holder_name, 'Guest Name');
    assert.ok(fixture.calls.some(call => call.text === 'COMMIT'));
    assert.strictEqual(fixture.wasReleased(), true);
  });
  await test('all Phase 1A document types are accepted', async () => {
    for (const documentType of ['KTP', 'SIM', 'PASSPORT', 'OTHER']) {
      const fixture = custodyPool();
      const result = await holdIdentity(fixture.pool, { propertyId: 1, reservationId: 20, documentType, documentHolderName: 'Guest', actor });
      assert.strictEqual(result.document_type, documentType);
    }
  });
  await test('unsupported document type is rejected before connecting', async () => {
    const pool = { connect: async () => { throw new Error('connected'); } };
    await assert.rejects(holdIdentity(pool, {
      propertyId: 1, reservationId: 20, documentType: 'BIRTH_CERTIFICATE', documentHolderName: 'Guest', actor
    }), error => error.code === 'INVALID_DOCUMENT_TYPE');
  });
  await test('holder name is required before connecting', async () => {
    const pool = { connect: async () => { throw new Error('connected'); } };
    await assert.rejects(holdIdentity(pool, {
      propertyId: 1, reservationId: 20, documentType: 'KTP', documentHolderName: ' ', actor
    }), error => error.code === 'DOCUMENT_HOLDER_REQUIRED');
  });
  await test('hold verifies property-scoped reservation ownership', async () => {
    const fixture = custodyPool({ ownership: false });
    await assert.rejects(holdIdentity(fixture.pool, {
      propertyId: 2, reservationId: 20, documentType: 'KTP', documentHolderName: 'Guest', actor
    }), error => error.code === 'RESERVATION_NOT_FOUND');
    assert.ok(fixture.calls.some(call => call.text === 'ROLLBACK'));
    assert.ok(!fixture.calls.some(call => call.text.includes('INSERT INTO identity_custody')));
  });
  await test('hold persists only a masked document number and optional location', async () => {
    const fixture = custodyPool();
    await holdIdentity(fixture.pool, {
      propertyId: 1, reservationId: 20, documentType: 'PASSPORT', documentHolderName: 'Guest',
      documentNumberMasked: 'A12****89', storageLocation: 'Safe A-2', notes: 'Envelope 4', actor
    });
    const insert = fixture.calls.find(call => call.text.includes('INSERT INTO identity_custody'));
    assert.deepStrictEqual(insert.params.slice(4), ['********1289', 'Front Desk', 'Safe A-2', 'Envelope 4']);
    assert.ok(!insert.text.includes('document_number,'));
  });
  await test('hold writes an audit snapshot without an unmasked identifier', async () => {
    const fixture = custodyPool();
    await holdIdentity(fixture.pool, {
      propertyId: 1, reservationId: 20, documentType: 'KTP', documentHolderName: 'Guest', documentNumberMasked: '32**********01', actor
    });
    const audit = fixture.calls.find(call => call.text.includes('INSERT INTO audit_logs'));
    const payload = JSON.parse(audit.params[2]);
    assert.strictEqual(payload.document_number_masked, '********3201');
    assert.strictEqual(payload.actor_user_id, '7');
  });
  await test('raw document input is masked before persistence', async () => {
    const fixture = custodyPool();
    await holdIdentity(fixture.pool, {
      propertyId: 1, reservationId: 20, documentType: 'KTP', documentHolderName: 'Guest', documentNumberMasked: '3273012345678901', actor
    });
    const insert = fixture.calls.find(call => call.text.includes('INSERT INTO identity_custody'));
    assert.strictEqual(insert.params[4], '********8901');
  });
  await test('hold is rejected after reservation checkout', async () => {
    const fixture = custodyPool({ reservationStatus: 'CHECKED_OUT' });
    await assert.rejects(holdIdentity(fixture.pool, {
      propertyId: 1, reservationId: 20, documentType: 'KTP', documentHolderName: 'Guest', actor
    }), error => error.code === 'IDENTITY_CUSTODY_RESERVATION_CLOSED');
    assert.ok(!fixture.calls.some(call => call.text.includes('INSERT INTO identity_custody')));
  });
  await test('return transitions a HELD document to RETURNED', async () => {
    const fixture = custodyPool();
    const result = await returnIdentity(fixture.pool, { propertyId: 1, custodyId: 50, actor });
    assert.strictEqual(result.status, 'RETURNED');
    assert.strictEqual(result.returned_by, 'Front Desk');
    assert.ok(fixture.calls.some(call => call.text.includes("SET status = 'RETURNED'")));
    assert.ok(fixture.calls.some(call => call.text === 'COMMIT'));
  });
  await test('return cannot access custody from another property', async () => {
    const fixture = custodyPool({ found: false });
    await assert.rejects(returnIdentity(fixture.pool, { propertyId: 2, custodyId: 50, actor }), error => error.code === 'IDENTITY_CUSTODY_NOT_FOUND');
    assert.ok(fixture.calls.some(call => call.text === 'ROLLBACK'));
  });
  await test('return is rejected when custody was already returned', async () => {
    const fixture = custodyPool({ existing: { id: 50, property_id: 1, reservation_id: 20, document_type: 'KTP', status: 'RETURNED' } });
    await assert.rejects(returnIdentity(fixture.pool, { propertyId: 1, custodyId: 50, actor }), error => error.code === 'IDENTITY_ALREADY_RETURNED');
    assert.ok(!fixture.calls.some(call => call.text.includes('UPDATE identity_custody')));
  });
  await test('return revalidates reservation ownership before mutation', async () => {
    const fixture = custodyPool({ ownership: false });
    await assert.rejects(returnIdentity(fixture.pool, { propertyId: 1, custodyId: 50, actor }), error => error.code === 'RESERVATION_NOT_FOUND');
    assert.ok(!fixture.calls.some(call => call.text.includes('UPDATE identity_custody')));
  });
  await test('reservation listing is property scoped through custody, reservation, and booking', async () => {
    let observed;
    const pool = { query: async (sql, params) => { observed = { sql: String(sql), params }; return { rows: [{ id: 50 }] }; } };
    assert.deepStrictEqual(await getIdentityCustodyByReservation(pool, 1, 20), [{ id: 50 }]);
    assert.ok(observed.sql.includes('ic.property_id = $1'));
    assert.ok(observed.sql.includes('b.property_id = $1'));
    assert.deepStrictEqual(observed.params, [1, 20]);
  });
  await test('checkout locks and returns only HELD identity records', async () => {
    let observed;
    const client = { query: async (sql, params) => { observed = { sql: String(sql), params }; return { rows: [{ id: 50, document_type: 'KTP' }] }; } };
    assert.deepStrictEqual(await getHeldIdentityCustodyForCheckout(client, 1, 20), [{ id: 50, document_type: 'KTP' }]);
    assert.ok(observed.sql.includes("status = 'HELD'"));
    assert.ok(observed.sql.includes('FOR UPDATE'));
    assert.deepStrictEqual(observed.params, [1, 20]);
  });

  console.log(`RESULT: PASS=${passed} FAIL=${failed} TOTAL=${passed + failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  console.log(`RESULT: PASS=${passed} FAIL=${failed + 1} TOTAL=${passed + failed + 1}`);
  process.exitCode = 1;
});

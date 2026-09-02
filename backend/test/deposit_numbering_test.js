const assert = require('node:assert');
const { generateDepositNumber } = require('../dist/domains/deposits/depositNumberService');

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

function clientFixture({ propertyCode = 'oak', propertyFound = true, max = 0 } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      async query(sql, params) {
        const text = String(sql);
        calls.push({ text, params });
        if (text.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
        if (text.includes('SELECT property_code')) {
          return propertyFound ? { rows: [{ property_code: propertyCode }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (text.includes('AS max_num')) return { rows: [{ max_num: max }], rowCount: 1 };
        throw new Error(`Unexpected query: ${text}`);
      }
    }
  };
}

async function main() {
  await test('first deposit number is property-coded and zero padded', async () => {
    const fixture = clientFixture();
    assert.strictEqual(await generateDepositNumber(fixture.client, 1, 'DEP'), 'DEP-OAK-00001');
  });
  await test('deposit sequence increments the authoritative maximum', async () => {
    const fixture = clientFixture({ max: '41' });
    assert.strictEqual(await generateDepositNumber(fixture.client, 1, 'DEP'), 'DEP-OAK-00042');
  });
  await test('refund sequence has an independent RFD prefix', async () => {
    const fixture = clientFixture({ propertyCode: 'jkt', max: 7 });
    assert.strictEqual(await generateDepositNumber(fixture.client, 3, 'RFD'), 'RFD-JKT-00008');
  });
  await test('number allocation takes a property and prefix advisory lock first', async () => {
    const fixture = clientFixture();
    await generateDepositNumber(fixture.client, 9, 'RFD');
    assert.ok(fixture.calls[0].text.includes('pg_advisory_xact_lock'));
    assert.deepStrictEqual(fixture.calls[0].params, [9, 'RFD']);
  });
  await test('deposit sequence reads deposits scoped to property and code', async () => {
    const fixture = clientFixture();
    await generateDepositNumber(fixture.client, 5, 'DEP');
    const sequence = fixture.calls.find(call => call.text.includes('AS max_num'));
    assert.ok(sequence.text.includes('FROM deposits'));
    assert.deepStrictEqual(sequence.params, [5, 'DEP', 'OAK']);
  });
  await test('refund sequence reads only DEPOSIT_REFUND payment references', async () => {
    const fixture = clientFixture();
    await generateDepositNumber(fixture.client, 5, 'RFD');
    const sequence = fixture.calls.find(call => call.text.includes('AS max_num'));
    assert.ok(sequence.text.includes('FROM payment_transactions'));
    assert.ok(sequence.text.includes("transaction_type = 'DEPOSIT_REFUND'"));
  });
  await test('missing property is rejected with PROPERTY_NOT_FOUND', async () => {
    const fixture = clientFixture({ propertyFound: false });
    await assert.rejects(generateDepositNumber(fixture.client, 404, 'DEP'), error => error.code === 'PROPERTY_NOT_FOUND' && error.statusCode === 404);
  });
  await test('blank property code is rejected', async () => {
    const fixture = clientFixture({ propertyCode: '   ' });
    await assert.rejects(generateDepositNumber(fixture.client, 1, 'DEP'), error => error.code === 'PROPERTY_CODE_REQUIRED' && error.statusCode === 422);
  });
  await test('large sequence values are not truncated to five digits', async () => {
    const fixture = clientFixture({ max: 99999 });
    assert.strictEqual(await generateDepositNumber(fixture.client, 1, 'DEP'), 'DEP-OAK-100000');
  });

  console.log(`RESULT: PASS=${passed} FAIL=${failed} TOTAL=${passed + failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  console.log(`RESULT: PASS=${passed} FAIL=${failed + 1} TOTAL=${passed + failed + 1}`);
  process.exitCode = 1;
});

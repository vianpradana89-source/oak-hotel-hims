// booking_create_request_test.js
// DB-free test for bookingCreateRequestService (Phase 2B-1 Unit 2 R1 fixes).
// Uses a stateful mock PoolClient â€” no real DB, no pool.connect, no schema.
// All fingerprints are valid SHA-256 hex64 to match DDL CHECK constraint.
const assert = require('node:assert');
const crypto = require('node:crypto');
const {
  computeBookingCreateFingerprint,
  claimBookingCreateRequest,
  finalizeBookingCreateRequest,
  getBookingCreateReplay,
  domainError,
  canonicalJsonStringify
} = require('../dist/domains/reservations/bookingCreateRequestService');

// Valid hex64 fingerprints (real SHA-256 values, match DDL CHECK)
const FP1 = 'b131e1b4c0fb85e381c8fd3a54b8a89831c100f4108b548ad2fb18c176fec343';
const FP2 = 'c01783b531207cb37e5814aaf7dc8601152aa793dad5df24c380981c04463bd8';
const FP3 = '4080bb651b6edf5e56827908c6ea4dcb3d21725ea3bd16fa07703aab63c1351c';
const FP4 = '225181e3de2af6b56a540d1abac779a7c8cd3167df64fb283acf087a3f876635';
const FP5 = '99b92226abce416f307de9909a8812d624767af89c346af68e6d176dfe3f0112';
const FP6 = '21ba2f580cf06c90be65254dc178404f75e90991004fab686cdee4644c780b65';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS: ' + name); }
  catch (e) { failed++; console.error('FAIL: ' + name + '\n  ' + e.message); }
}

// â”€â”€ Stateful mock client â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function makeMockClient({ existingRows = [] } = {}) {
  const rows = new Map();
  const commands = [];
  const paramLog = [];
  for (const r of existingRows) rows.set(r.property_id + ':' + r.request_key, r);
  const client = {
    async query(sql, params = []) {
      const text = String(sql).toLowerCase().trim();
      commands.push(text);
      paramLog.push({ sql: String(sql), params: [...params] });
      if (text.startsWith('select') && text.includes('booking_create_requests')) {
        const row = rows.get(params[0] + ':' + String(params[1]));
        if (row) return { rows: [row], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith('insert into booking_create_requests')) {
        const [propId, reqKey, fp, fpVer, paymentIntent] = params;
        const newRow = {
          id: Date.now(), property_id: propId, request_key: reqKey,
          status: 'PENDING', fingerprint: fp, fingerprint_version: fpVer,
          payment_intent: paymentIntent, booking_id: null, result: null,
          response_status: null, created_at: '', updated_at: '', finalized_at: null
        };
        const rk = propId + ':' + reqKey;
        if (!rows.has(rk)) { rows.set(rk, newRow); return { rows: [newRow], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith('update booking_create_requests')) {
        const [propId, reqKey, bookingId, resultJson, respStatus, fp, fpVer] = params;
        const rk = propId + ':' + reqKey;
        const row = rows.get(rk);
        if (row && row.status === 'PENDING' && row.fingerprint === fp && row.fingerprint_version === fpVer) {
          row.status = 'FINAL'; row.booking_id = bookingId;
          row.result = JSON.parse(resultJson); row.response_status = respStatus;
          row.finalized_at = '';
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      throw new Error('Unexpected SQL: ' + String(sql).slice(0, 100));
    },
    release() { commands.push('release'); }
  };
  return { client, commands, paramLog, rows };
}

function pendingRow(prop, key, fp, ver) {
  return { id: 1, property_id: prop, request_key: key, status: 'PENDING',
    fingerprint: fp, fingerprint_version: ver, payment_intent: null,
    booking_id: null, result: null, response_status: null,
    created_at: '', updated_at: '', finalized_at: null };
}
function finalRow(prop, key, fp, ver, bookingId, result, { response_status = 201, finalized_at = '2026-11-08T00:00:00Z' } = {}) {
  return { id: 2, property_id: prop, request_key: key, status: 'FINAL',
    fingerprint: fp, fingerprint_version: ver, payment_intent: null,
    booking_id: bookingId, result, response_status,
    created_at: '', updated_at: '', finalized_at };
}
// BU-R2-04: scripted query mock — the FINAL read path is driven by an exact
// sequence (e.g. claim conflict: SELECT empty → INSERT rowCount 0 → SELECT row).
function makeSequenceClient(querySeq) {
  let i = 0;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql).toLowerCase().trim(), params: [...params] });
      const out = querySeq[i++];
      if (out === undefined || out === null) return { rows: [], rowCount: 0 };
      return out;
    },
    release() { calls.push({ sql: 'release' }); }
  };
  return { client, calls };
}
function conflictClaimSeq(row) {
  // SELECT (primary, empty) → INSERT ON CONFLICT (lost the race) → SELECT reread (row)
  return [
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
    { rows: [row], rowCount: 1 },
  ];
}
function finalizeFallbackSeq(row) {
  // UPDATE PENDING→FINAL misses (rowCount 0) → SELECT fallback (row)
  return [
    { rows: [], rowCount: 0 },
    { rows: [row], rowCount: 1 },
  ];
}

// â”€â”€ Fingerprint tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function runFingerprintTests() {
  await test('FP1: same object, different key order â†’ same fingerprint', () => {
    const a = computeBookingCreateFingerprint({ check_in: '2026-01-10', guest_name: 'A' });
    const b = computeBookingCreateFingerprint({ guest_name: 'A', check_in: '2026-01-10' });
    assert.strictEqual(a, b, 'fingerprint must be key-order stable');
  });
  await test('FP2: business value change â†’ different fingerprint', () => {
    assert.notStrictEqual(
      computeBookingCreateFingerprint({ check_in: '2026-01-10' }),
      computeBookingCreateFingerprint({ check_in: '2026-01-11' })
    );
  });
  await test('FP3: phone as string vs number â†’ different FP (leading zero preserved)', () => {
    const a = computeBookingCreateFingerprint({ phone: '081234567890' });
    const b = computeBookingCreateFingerprint({ phone: 81234567890 });
    assert.notStrictEqual(a, b);
    assert.strictEqual(a, computeBookingCreateFingerprint({ phone: '081234567890' }));
  });
  await test('FP4: array order preserved (children order matters)', () => {
    assert.notStrictEqual(
      computeBookingCreateFingerprint({ children: [1, 2, 3] }),
      computeBookingCreateFingerprint({ children: [3, 2, 1] })
    );
  });
  await test('FP5: nested object keys sorted canonically', () => {
    assert.strictEqual(
      computeBookingCreateFingerprint({ booking: { b: 1, a: 2 }, x: 0 }),
      computeBookingCreateFingerprint({ booking: { a: 2, b: 1 }, x: 0 })
    );
  });
  await test('FP6: null field â‰  absent field (explicit null preserved)', () => {
    const withNull = computeBookingCreateFingerprint({ phone: null, name: 'X' });
    const without = computeBookingCreateFingerprint({ name: 'X' });
    assert.notStrictEqual(withNull, without, 'explicit null must differ from absent field');
    assert.strictEqual(withNull, computeBookingCreateFingerprint({ phone: null, name: 'X' }));
  });
  await test('FP7: payment intent mode change â†’ different FP (caller includes intent in snapshot)', () => {
    assert.notStrictEqual(
      computeBookingCreateFingerprint({ check_in: '2026-01-10', payment_mode: 'ADVANCE', amount: 50000 }),
      computeBookingCreateFingerprint({ check_in: '2026-01-10', payment_mode: 'PAY_BILL', amount: 50000 })
    );
  });
  await test('FP8: non-finite number â†’ 400 FP_NONFINITE', () => {
    assert.throws(() => computeBookingCreateFingerprint({ amount: Infinity }),
      e => e.code === 'BOOKING_CREATE_FP_NONFINITE' && e.statusCode === 400);
  });
  await test('FP9: cyclic structure â†’ 400 FP_CYCLIC', () => {
    const obj = { a: 1 }; obj.self = obj;
    assert.throws(() => computeBookingCreateFingerprint(obj),
      e => e.code === 'BOOKING_CREATE_FP_CYCLIC' && e.statusCode === 400);
  });
  await test('FP10: function value â†’ 400 FP_UNSUPPORTED', () => {
    assert.throws(() => computeBookingCreateFingerprint({ fn: () => {} }),
      e => e.code === 'BOOKING_CREATE_FP_UNSUPPORTED' && e.statusCode === 400);
  });
}

// â”€â”€ Claim tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runClaimTests() {
  await test('C1: new claim (no existing row) â†’ claimed=true, PENDING, no lifecycle', async () => {
    const { client, commands, paramLog } = makeMockClient();
    const res = await claimBookingCreateRequest(client, {
      propertyId: 1, requestKey: 'test-key-1', fingerprint: FP1, fingerprintVersion: 1
    });
    assert.strictEqual(res.claimed, true);
    assert.strictEqual(res.row.status, 'PENDING');
    const lifecycle = commands.filter(c => ['begin','commit','rollback','release'].includes(c));
    assert.deepStrictEqual(lifecycle, [], 'helper must NOT issue BEGIN/COMMIT/ROLLBACK/RELEASE');
    const insert = paramLog.find(p => p.sql.toLowerCase().includes('insert into'));
    assert.strictEqual(insert.params[0], 1, 'INSERT carries property_id=1');
  });
  await test('C2: existing PENDING row + same FP â†’ 409 E_INCOMPLETE', async () => {
    const { client } = makeMockClient({ existingRows: [pendingRow(1, 'k', FP1, 1)] });
    await assert.rejects(
      claimBookingCreateRequest(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 }),
      e => e.code === 'BOOKING_CREATE_REQUEST_INCOMPLETE' && e.statusCode === 409
    );
  });
  await test('C3: existing FINAL row + same FP + complete result â†’ replay', async () => {
    const { client } = makeMockClient({ existingRows: [finalRow(1, 'k', FP1, 1, 42, { booking_id: 42, bid: 'BID-42' })] });
    const res = await claimBookingCreateRequest(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 });
    assert.strictEqual(res.claimed, false);
    assert.strictEqual(res.row.replayed, true);
    assert.strictEqual(Number(res.row.booking_id), 42);
  });
  await test('C4: existing row + different FP value â†’ 409 E_MISMATCH', async () => {
    const { client } = makeMockClient({ existingRows: [pendingRow(1, 'k', FP1, 1)] });
    await assert.rejects(
      claimBookingCreateRequest(client, { propertyId: 1, requestKey: 'k', fingerprint: FP2, fingerprintVersion: 1 }),
      e => e.code === 'BOOKING_CREATE_REPLAY_MISMATCH' && e.statusCode === 409
    );
  });
  await test('C4b: same FP value but different version â†’ 409 E_MISMATCH', async () => {
    const { client } = makeMockClient({ existingRows: [pendingRow(1, 'k', FP1, 1)] });
    await assert.rejects(
      claimBookingCreateRequest(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 2 }),
      e => e.code === 'BOOKING_CREATE_REPLAY_MISMATCH',
      'version mismatch rejected even when FP value matches'
    );
  });
  await test('C5: empty request_key â†’ 400 E_MISSING_KEY', async () => {
    const { client } = makeMockClient();
    await assert.rejects(
      claimBookingCreateRequest(client, { propertyId: 1, requestKey: '  ', fingerprint: FP1, fingerprintVersion: 1 }),
      e => e.code === 'BOOKING_CREATE_KEY_REQUIRED' && e.statusCode === 400
    );
  });
  await test('C6: request_key with invalid chars â†’ 400 E_INVALID_KEY', async () => {
    const { client } = makeMockClient();
    await assert.rejects(
      claimBookingCreateRequest(client, { propertyId: 1, requestKey: 'bad;DROP', fingerprint: FP1, fingerprintVersion: 1 }),
      e => e.code === 'BOOKING_CREATE_KEY_INVALID'
    );
  });
  await test('C7: property_id=0 â†’ 400 E_INVALID_PROPERTY', async () => {
    const { client } = makeMockClient();
    await assert.rejects(
      claimBookingCreateRequest(client, { propertyId: 0, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 }),
      e => e.code === 'BOOKING_CREATE_PROPERTY_INVALID'
    );
  });
  await test('C7b: property_id=1.5 (non-integer) â†’ 400', async () => {
    const { client } = makeMockClient();
    await assert.rejects(
      claimBookingCreateRequest(client, { propertyId: 1.5, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 }),
      e => e.code === 'BOOKING_CREATE_PROPERTY_INVALID'
    );
  });
  await test('C8: FINAL row with booking_id=null â†’ 409 E_INCOMPLETE', async () => {
    const { client } = makeMockClient({ existingRows: [finalRow(1, 'k', FP1, 1, null, null)] });
    await assert.rejects(
      claimBookingCreateRequest(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 }),
      e => e.code === 'BOOKING_CREATE_REQUEST_INCOMPLETE'
    );
  });
  await test('C8b: FINAL row with result=[] (array) â†’ 409 E_INCOMPLETE', async () => {
    const { client } = makeMockClient({ existingRows: [finalRow(1, 'k', FP1, 1, 42, [])] });
    await assert.rejects(
      claimBookingCreateRequest(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 }),
      e => e.code === 'BOOKING_CREATE_REQUEST_INCOMPLETE'
    );
  });
  await test('C9: fingerprint not hex64 â†’ 400 FP_FORMAT', async () => {
    const { client } = makeMockClient();
    await assert.rejects(
      claimBookingCreateRequest(client, { propertyId: 1, requestKey: 'k', fingerprint: 'abc123', fingerprintVersion: 1 }),
      e => e.code === 'BOOKING_CREATE_FP_FORMAT' && e.statusCode === 400
    );
  });
  await test('C10: fingerprint_version=0 â†’ 400 FP_VERSION_INVALID', async () => {
    const { client } = makeMockClient();
    await assert.rejects(
      claimBookingCreateRequest(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 0 }),
      e => e.code === 'BOOKING_CREATE_FP_VERSION_INVALID' && e.statusCode === 400
    );
  });
}

// â”€â”€ Finalize tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runFinalizeTests() {
  await test('F1: finalize PENDING row â†’ UPDATE issued, FP in params, no COMMIT', async () => {
    const { client, commands, paramLog } = makeMockClient();
    await claimBookingCreateRequest(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 });
    await finalizeBookingCreateRequest(client, {
      propertyId: 1, requestKey: 'k', bookingId: 42,
      result: { booking_id: 42, bid: 'BID-42' },
      fingerprint: FP1, fingerprintVersion: 1
    });
    const upd = paramLog.find(p => p.sql.toLowerCase().includes('update booking_create_requests'));
    assert.ok(upd, 'finalize must issue UPDATE');
    assert.strictEqual(upd.params[5], FP1, 'UPDATE carries expected fingerprint');
    assert.strictEqual(upd.params[6], 1, 'UPDATE carries expected version');
    assert.ok(!commands.includes('commit'), 'helper must NOT commit');
  });
  await test('F1b: repeated finalize (same FP+booking+result) â†’ idempotent, no throw', async () => {
    const { client } = makeMockClient();
    await claimBookingCreateRequest(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 });
    await finalizeBookingCreateRequest(client, {
      propertyId: 1, requestKey: 'k', bookingId: 42,
      result: { booking_id: 42, bid: 'BID-42' },
      fingerprint: FP1, fingerprintVersion: 1
    });
    await finalizeBookingCreateRequest(client, {
      propertyId: 1, requestKey: 'k', bookingId: 42,
      result: { booking_id: 42, bid: 'BID-42' },
      fingerprint: FP1, fingerprintVersion: 1
    });
  });
  await test('F2: FINAL row + different bookingId â†’ 409 E_MISMATCH', async () => {
    const { client } = makeMockClient({ existingRows: [finalRow(1, 'k', FP1, 1, 42, { booking_id: 42 })] });
    await assert.rejects(
      finalizeBookingCreateRequest(client, {
        propertyId: 1, requestKey: 'k', bookingId: 999,
        result: { booking_id: 999 },
        fingerprint: FP1, fingerprintVersion: 1
      }),
      e => e.code === 'BOOKING_CREATE_REPLAY_MISMATCH' && e.statusCode === 409
    );
  });
  await test('F2b: FINAL row + different FP â†’ 409 E_MISMATCH', async () => {
    const { client } = makeMockClient({ existingRows: [finalRow(1, 'k', FP1, 1, 42, { booking_id: 42 })] });
    await assert.rejects(
      finalizeBookingCreateRequest(client, {
        propertyId: 1, requestKey: 'k', bookingId: 42,
        result: { booking_id: 42 },
        fingerprint: FP2, fingerprintVersion: 1
      }),
      e => e.code === 'BOOKING_CREATE_REPLAY_MISMATCH',
      'different FP on FINAL row must be rejected'
    );
  });
  await test('F2c: PENDING row + different FP â†’ 409 E_MISMATCH', async () => {
    const { client } = makeMockClient({ existingRows: [pendingRow(1, 'k', FP1, 1)] });
    await assert.rejects(
      finalizeBookingCreateRequest(client, {
        propertyId: 1, requestKey: 'k', bookingId: 42,
        result: {},
        fingerprint: FP2, fingerprintVersion: 1
      }),
      e => e.code === 'BOOKING_CREATE_REPLAY_MISMATCH',
      'PENDING row with different FP must reject finalize'
    );
  });
  await test('F3: finalize invalid request_key â†’ 400 E_MISSING_KEY', async () => {
    const { client } = makeMockClient();
    await assert.rejects(
      finalizeBookingCreateRequest(client, {
        propertyId: 1, requestKey: '  ', bookingId: 42,
        result: {}, fingerprint: FP1, fingerprintVersion: 1
      }),
      e => e.code === 'BOOKING_CREATE_KEY_REQUIRED'
    );
  });
  await test('F4: finalize property_id=-1 â†’ 400 E_INVALID_PROPERTY', async () => {
    const { client } = makeMockClient();
    await assert.rejects(
      finalizeBookingCreateRequest(client, {
        propertyId: -1, requestKey: 'k', bookingId: 42,
        result: {}, fingerprint: FP1, fingerprintVersion: 1
      }),
      e => e.code === 'BOOKING_CREATE_PROPERTY_INVALID'
    );
  });
  await test('F5: finalize result=[] â†’ 400 RESULT_INVALID', async () => {
    const { client } = makeMockClient();
    await assert.rejects(
      finalizeBookingCreateRequest(client, {
        propertyId: 1, requestKey: 'k', bookingId: 42,
        result: [], fingerprint: FP1, fingerprintVersion: 1
      }),
      e => e.code === 'BOOKING_CREATE_RESULT_INVALID'
    );
  });
  await test('F5b: finalize result=null â†’ 400 RESULT_INVALID', async () => {
    const { client } = makeMockClient();
    await assert.rejects(
      finalizeBookingCreateRequest(client, {
        propertyId: 1, requestKey: 'k', bookingId: 42,
        result: null, fingerprint: FP1, fingerprintVersion: 1
      }),
      e => e.code === 'BOOKING_CREATE_RESULT_INVALID'
    );
  });
  await test('F6: finalize bookingId=0 â†’ 400 BOOKING_ID_INVALID', async () => {
    const { client } = makeMockClient();
    await assert.rejects(
      finalizeBookingCreateRequest(client, {
        propertyId: 1, requestKey: 'k', bookingId: 0,
        result: {}, fingerprint: FP1, fingerprintVersion: 1
      }),
      e => e.code === 'BOOKING_CREATE_BOOKING_ID_INVALID'
    );
  });
  await test('F7: finalize with no row found â†’ 409 E_INCOMPLETE', async () => {
    const { client } = makeMockClient();
    await assert.rejects(
      finalizeBookingCreateRequest(client, {
        propertyId: 1, requestKey: 'nonexistent', bookingId: 42,
        result: {}, fingerprint: FP1, fingerprintVersion: 1
      }),
      e => e.code === 'BOOKING_CREATE_REQUEST_INCOMPLETE'
    );
  });
  await test('F8: finalize responseStatus=500 â†’ 400 RESPONSE_STATUS_INVALID', async () => {
    const { client } = makeMockClient();
    await assert.rejects(
      finalizeBookingCreateRequest(client, {
        propertyId: 1, requestKey: 'k', bookingId: 42,
        result: {}, responseStatus: 500,
        fingerprint: FP1, fingerprintVersion: 1
      }),
      e => e.code === 'BOOKING_CREATE_RESPONSE_STATUS_INVALID'
    );
  });
  await test('F9: finalize non-hex64 FP â†’ 400 FP_FORMAT', async () => {
    const { client } = makeMockClient();
    await assert.rejects(
      finalizeBookingCreateRequest(client, {
        propertyId: 1, requestKey: 'k', bookingId: 42,
        result: {}, fingerprint: 'not-hex64', fingerprintVersion: 1
      }),
      e => e.code === 'BOOKING_CREATE_FP_FORMAT'
    );
  });

  // ── BU-R2-04: authoritative FINAL validator across the four read paths ──
  const malformedRows = [
    ['BU04-F1: finalize fallback FINAL result=primitive → 409 INCOMPLETE',
      finalRow(1, 'k', FP1, 1, 42, 'invalid'), r => finalizeFallbackSeq(r)],
    ['BU04-F2: finalize fallback FINAL response_status=null → 409 INCOMPLETE',
      finalRow(1, 'k', FP1, 1, 42, { booking_id: 42 }, { response_status: null }), r => finalizeFallbackSeq(r)],
    ['BU04-F3: finalize fallback FINAL finalized_at=null → 409 INCOMPLETE',
      finalRow(1, 'k', FP1, 1, 42, { booking_id: 42 }, { finalized_at: null }), r => finalizeFallbackSeq(r)],
    ['BU04-F4: finalize fallback FINAL booking_id=null → 409 INCOMPLETE',
      finalRow(1, 'k', FP1, 1, null, { booking_id: 42 }), r => finalizeFallbackSeq(r)],
  ];
  for (const [name, row, seq] of malformedRows) {
    await test(name, async () => {
      const { client, calls } = makeSequenceClient(seq(row));
      await assert.rejects(
        finalizeBookingCreateRequest(client, {
          propertyId: 1, requestKey: 'k', bookingId: 42,
          result: { booking_id: 42 }, fingerprint: FP1, fingerprintVersion: 1
        }),
        e => e.code === 'BOOKING_CREATE_REQUEST_INCOMPLETE' && e.statusCode === 409
      );
      assert.ok(calls.some(c => c.sql.startsWith('update booking_create_requests')), 'UPDATE issued then rowCount 0');
      assert.ok(calls.some(c => c.sql.startsWith('select')), 'fallback SELECT issued and validated');
    });
  }
  await test('BU04-F5: finalize fallback FP mismatch on valid FINAL → 409 MISMATCH (unchanged)', async () => {
    const { client } = makeSequenceClient(finalizeFallbackSeq(finalRow(1, 'k', FP1, 1, 42, { booking_id: 42 })));
    await assert.rejects(
      finalizeBookingCreateRequest(client, {
        propertyId: 1, requestKey: 'k', bookingId: 42,
        result: { booking_id: 42 }, fingerprint: FP2, fingerprintVersion: 1
      }),
      e => e.code === 'BOOKING_CREATE_REPLAY_MISMATCH' && e.statusCode === 409
    );
  });
  await test('BU04-F6: finalize fallback valid FINAL same result → idempotent success', async () => {
    const { client } = makeSequenceClient(finalizeFallbackSeq(finalRow(1, 'k', FP1, 1, 42, { booking_id: 42, bid: 'BID-42' })));
    await finalizeBookingCreateRequest(client, {
      propertyId: 1, requestKey: 'k', bookingId: 42,
      result: { bid: 'BID-42', booking_id: 42 }, fingerprint: FP1, fingerprintVersion: 1
    }); // reordered keys: canonical equality must hold
  });
  const claimPrimaryMalformed = [
    ['BU04-C1: claim primary SELECT FINAL result=primitive → 409 INCOMPLETE', { result: 'invalid' }],
    ['BU04-C2: claim primary SELECT FINAL response_status=500 → 409 INCOMPLETE', { response_status: 500 }],
    ['BU04-C3: claim primary SELECT FINAL finalized_at=null → 409 INCOMPLETE', { finalized_at: null }],
    ['BU04-C4: claim primary SELECT FINAL booking_id=null → 409 INCOMPLETE', { booking_id: null }],
  ];
  for (const [name, patch] of claimPrimaryMalformed) {
    await test(name, async () => {
      const row = { ...finalRow(1, 'k', FP1, 1, 42, { booking_id: 42 }), ...patch };
      const { client } = makeSequenceClient([{ rows: [row], rowCount: 1 }]);
      await assert.rejects(
        claimBookingCreateRequest(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 }),
        e => e.code === 'BOOKING_CREATE_REQUEST_INCOMPLETE' && e.statusCode === 409
      );
    });
  }
  for (const [name, patch] of claimPrimaryMalformed) {
    await test(name.replace('claim primary SELECT', 'claim conflict reread FINAL') + ' (conflict path)', async () => {
      const row = { ...finalRow(1, 'k', FP1, 1, 42, { booking_id: 42 }), ...patch };
      const { client, calls } = makeSequenceClient(conflictClaimSeq(row));
      await assert.rejects(
        claimBookingCreateRequest(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 }),
        e => e.code === 'BOOKING_CREATE_REQUEST_INCOMPLETE' && e.statusCode === 409
      );
      assert.strictEqual(calls.length, 3, 'SELECT empty → INSERT rowCount 0 → reread SELECT (3 queries)');
    });
  }
  await test('BU04-C5: claim conflict reread valid FINAL → replay (control)', async () => {
    const { client } = makeSequenceClient(conflictClaimSeq(finalRow(1, 'k', FP1, 1, 42, { booking_id: 42 })));
    const res = await claimBookingCreateRequest(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 });
    assert.strictEqual(res.claimed, false);
    assert.strictEqual(res.row.replayed, true);
    assert.strictEqual(Number(res.row.booking_id), 42);
  });
  for (const [name, patch] of claimPrimaryMalformed) {
    await test(name.replace('claim primary SELECT', 'replay SELECT FINAL') + ' (replay path)', async () => {
      const row = { ...finalRow(1, 'k', FP1, 1, 42, { booking_id: 42 }), ...patch };
      const { client } = makeSequenceClient([{ rows: [row], rowCount: 1 }]);
      await assert.rejects(
        getBookingCreateReplay(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 }),
        e => e.code === 'BOOKING_CREATE_REQUEST_INCOMPLETE' && e.statusCode === 409
      );
    });
  }
  await test('BU04-C6: replay valid FINAL (key-order diff result) → replay succeeds', async () => {
    const { client } = makeSequenceClient([{ rows: [finalRow(1, 'k', FP1, 1, 42, { booking_id: 42, bid: 'BID-42' })], rowCount: 1 }]);
    const res = await getBookingCreateReplay(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 });
    assert.strictEqual(res.replayed, true);
    assert.strictEqual(res.bookingId, 42);
    assert.strictEqual(res.result.bid, 'BID-42');
  });

  // ── BU-R2-02: Date/Map/Set/class instance rejection ──
  await test('FP11: Date value in snapshot → 400 FP_UNSUPPORTED', () => {
    assert.throws(() => computeBookingCreateFingerprint({ check_in: new Date('2026-01-10') }),
      e => e.code === 'BOOKING_CREATE_FP_UNSUPPORTED' && e.statusCode === 400);
  });
  await test('FP12: Map value in snapshot → 400 FP_UNSUPPORTED', () => {
    const m = new Map([['a', 1]]);
    assert.throws(() => computeBookingCreateFingerprint({ data: m }),
      e => e.code === 'BOOKING_CREATE_FP_UNSUPPORTED');
  });
  await test('FP13: Set value in snapshot → 400 FP_UNSUPPORTED', () => {
    const st = new Set([1]);
    assert.throws(() => computeBookingCreateFingerprint({ data: st }),
      e => e.code === 'BOOKING_CREATE_FP_UNSUPPORTED');
  });
  await test('FP14: class instance in snapshot → 400 FP_UNSUPPORTED', () => {
    class Foo { constructor() { this.x = 1; } }
    const inst = new Foo();
    assert.throws(() => computeBookingCreateFingerprint({ obj: inst }),
      e => e.code === 'BOOKING_CREATE_FP_UNSUPPORTED');
  });
  await test('FP15: canonicalJsonStringify key-order stable', () => {
    const a = canonicalJsonStringify({ b: 1, a: 2 });
    const b = canonicalJsonStringify({ a: 2, b: 1 });
    assert.strictEqual(a, b);
  });
  await test('FP16: finalize idempotent with key-order-different nested objects', async () => {
    const { client } = makeMockClient();
    const payload = { booking_id: 42, bid: 'BID-42', nested: { z: 1, a: 2 } };
    const payloadReordered = { nested: { a: 2, z: 1 }, booking_id: 42, bid: 'BID-42' };
    await claimBookingCreateRequest(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 });
    await finalizeBookingCreateRequest(client, {
      propertyId: 1, requestKey: 'k', bookingId: 42,
      result: payload,
      fingerprint: FP1, fingerprintVersion: 1
    });
    // Second call with reordered keys must be idempotent (canonicalJsonStringify sorts keys)
    await finalizeBookingCreateRequest(client, {
      propertyId: 1, requestKey: 'k', bookingId: 42,
      result: payloadReordered,
      fingerprint: FP1, fingerprintVersion: 1
    });
  });}

// â”€â”€ Replay tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function runReplayTests() {
  const result = { booking_id: 42, bid: 'BID-42' };
  await test('R1: FINAL row + matching FP+version â†’ replay returned', async () => {
    const { client } = makeMockClient({ existingRows: [finalRow(1, 'k', FP1, 1, 42, result)] });
    const res = await getBookingCreateReplay(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 });
    assert.strictEqual(res.replayed, true);
    assert.strictEqual(res.bookingId, 42);
    assert.strictEqual(res.result.bid, 'BID-42');
  });
  await test('R2: PENDING row â†’ 409 E_INCOMPLETE (NOT null)', async () => {
    const { client } = makeMockClient({ existingRows: [pendingRow(1, 'k', FP1, 1)] });
    await assert.rejects(
      getBookingCreateReplay(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 }),
      e => e.code === 'BOOKING_CREATE_REQUEST_INCOMPLETE' && e.statusCode === 409,
      'PENDING state must throw 409, not return null'
    );
  });
  await test('R3: non-existent key â†’ null (no-row case only)', async () => {
    const { client } = makeMockClient();
    const res = await getBookingCreateReplay(client, { propertyId: 1, requestKey: 'nonexistent', fingerprint: FP1, fingerprintVersion: 1 });
    assert.strictEqual(res, null, 'no-row case returns null');
  });
  await test('R4: FINAL row + mismatched FP â†’ 409 E_MISMATCH', async () => {
    const { client } = makeMockClient({ existingRows: [finalRow(1, 'k', FP1, 1, 42, result)] });
    await assert.rejects(
      getBookingCreateReplay(client, { propertyId: 1, requestKey: 'k', fingerprint: FP2, fingerprintVersion: 1 }),
      e => e.code === 'BOOKING_CREATE_REPLAY_MISMATCH'
    );
  });
  await test('R5: FINAL row + mismatched version â†’ 409 E_MISMATCH', async () => {
    const { client } = makeMockClient({ existingRows: [finalRow(1, 'k', FP1, 1, 42, result)] });
    await assert.rejects(
      getBookingCreateReplay(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 2 }),
      e => e.code === 'BOOKING_CREATE_REPLAY_MISMATCH',
      'version mismatch rejected even with same FP value'
    );
  });
  await test('R6: FINAL row with result=null â†’ 409 E_INCOMPLETE', async () => {
    const { client } = makeMockClient({ existingRows: [finalRow(1, 'k', FP1, 1, 42, null)] });
    await assert.rejects(
      getBookingCreateReplay(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 }),
      e => e.code === 'BOOKING_CREATE_REQUEST_INCOMPLETE'
    );
  });
  await test('R7: empty FP â†’ 400 (no exported bypass without FP)', async () => {
    const { client } = makeMockClient({ existingRows: [finalRow(1, 'k', FP1, 1, 42, result)] });
    await assert.rejects(
      getBookingCreateReplay(client, { propertyId: 1, requestKey: 'k', fingerprint: '', fingerprintVersion: 1 }),
      e => e.statusCode === 400,
      'empty FP must be rejected at validation layer'
    );
  });


  // ── Unit 3C-01: responseStatus surfaced on the replay DTO ──
  await test('R10: FINAL row responseStatus is preserved from stored 201', async () => {
    const { client } = makeMockClient({ existingRows: [finalRow(1, 'k', FP1, 1, 42, result)] });
    const res = await getBookingCreateReplay(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 });
    assert.strictEqual(res.responseStatus, 201);
  });
  await test('R11: FINAL row with stored status 200 is preserved, not overridden by a default', async () => {
    const { client } = makeMockClient({ existingRows: [finalRow(1, 'k', FP1, 1, 42, result, { response_status: 200 })] });
    const res = await getBookingCreateReplay(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 });
    assert.strictEqual(res.responseStatus, 200);
  });
  await test('R12: FINAL row with stored status 304 is preserved', async () => {
    const { client } = makeMockClient({ existingRows: [finalRow(1, 'k', FP1, 1, 42, result, { response_status: 304 })] });
    const res = await getBookingCreateReplay(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 });
    assert.strictEqual(res.responseStatus, 304);
  });
  await test('R13: FINAL row with response_status=null is still rejected by the existing validator (409)', async () => {
    const { client } = makeMockClient({ existingRows: [finalRow(1, 'k', FP1, 1, 42, result, { response_status: null })] });
    await assert.rejects(
      getBookingCreateReplay(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 }),
      e => e.code === 'BOOKING_CREATE_REQUEST_INCOMPLETE' && e.statusCode === 409
    );
  });
  // ── BU-R2-03: invalid key types (null/undefined/number/object) → 400, not TypeError ──
  await test('C11: requestKey=null → 400 E_INVALID_KEY (not TypeError)', async () => {
    const { client } = makeMockClient();
    await assert.rejects(
      claimBookingCreateRequest(client, { propertyId: 1, requestKey: null, fingerprint: FP1, fingerprintVersion: 1 }),
      e => e.code === 'BOOKING_CREATE_KEY_INVALID' && e.statusCode === 400
    );
  });
  await test('C12: requestKey=undefined → 400 E_INVALID_KEY', async () => {
    const { client } = makeMockClient();
    await assert.rejects(
      claimBookingCreateRequest(client, { propertyId: 1, requestKey: undefined, fingerprint: FP1, fingerprintVersion: 1 }),
      e => e.code === 'BOOKING_CREATE_KEY_INVALID' && e.statusCode === 400
    );
  });
  await test('C13: requestKey=42 (number) → 400 E_INVALID_KEY', async () => {
    const { client } = makeMockClient();
    await assert.rejects(
      claimBookingCreateRequest(client, { propertyId: 1, requestKey: 42, fingerprint: FP1, fingerprintVersion: 1 }),
      e => e.code === 'BOOKING_CREATE_KEY_INVALID' && e.statusCode === 400
    );
  });
  await test('C14: requestKey={a:1} (object) → 400 E_INVALID_KEY', async () => {
    const { client } = makeMockClient();
    await assert.rejects(
      claimBookingCreateRequest(client, { propertyId: 1, requestKey: { a: 1 }, fingerprint: FP1, fingerprintVersion: 1 }),
      e => e.code === 'BOOKING_CREATE_KEY_INVALID' && e.statusCode === 400
    );
  });
  await test('C15: finalize with requestKey=null → 400 (not TypeError)', async () => {
    const { client } = makeMockClient();
    await assert.rejects(
      finalizeBookingCreateRequest(client, {
        propertyId: 1, requestKey: null, bookingId: 42,
        result: {}, fingerprint: FP1, fingerprintVersion: 1
      }),
      e => e.code === 'BOOKING_CREATE_KEY_INVALID' && e.statusCode === 400
    );
  });
  await test('C16: getReplay with requestKey=undefined → 400 (not TypeError)', async () => {
    const { client } = makeMockClient();
    await assert.rejects(
      getBookingCreateReplay(client, { propertyId: 1, requestKey: undefined, fingerprint: FP1, fingerprintVersion: 1 }),
      e => e.code === 'BOOKING_CREATE_KEY_INVALID' && e.statusCode === 400
    );
  });}

// â”€â”€ Property isolation tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runPropertyIsolationTests() {
  await test('ISO1: property_id=1 and property_id=2 with same key are independent', async () => {
    const { client, paramLog, rows } = makeMockClient();
    const res1 = await claimBookingCreateRequest(client, { propertyId: 1, requestKey: 'shared-key', fingerprint: FP1, fingerprintVersion: 1 });
    assert.strictEqual(res1.claimed, true);
    assert.ok(rows.get('1:shared-key'), 'property_id=1 row stored under 1:shared-key');

    const res2 = await claimBookingCreateRequest(client, { propertyId: 2, requestKey: 'shared-key', fingerprint: FP2, fingerprintVersion: 1 });
    assert.strictEqual(res2.claimed, true);
    assert.ok(rows.get('2:shared-key'), 'property_id=2 row stored under 2:shared-key');
    assert.notStrictEqual(res1.row, res2.row, 'rows for different properties must be distinct');

    const inserts = paramLog.filter(p => p.sql.toLowerCase().includes('insert into'));
    assert.strictEqual(inserts[0].params[0], 1, 'first INSERT property_id=1');
    assert.strictEqual(inserts[1].params[0], 2, 'second INSERT property_id=2');
  });
  await test('ISO2: SELECT is parameterized by property_id (not string-interpolated)', async () => {
    const { client, paramLog } = makeMockClient();
    await claimBookingCreateRequest(client, { propertyId: 5, requestKey: 'prop5-key', fingerprint: FP1, fingerprintVersion: 1 });
    const selects = paramLog.filter(p => p.sql.toLowerCase().includes('from booking_create_requests'));
    assert.ok(selects.length >= 1, 'SELECT must be issued');
    assert.strictEqual(selects[0].params[0], 5, 'SELECT params[0] = property_id');
    assert.strictEqual(selects[0].params[1], 'prop5-key', 'SELECT params[1] = request_key');
  });

  // ── BU-R2-04: malformed FINAL with finalized_at=null → 409 E_INCOMPLETE ──
  await test('R8: FINAL row with finalized_at=null → 409 E_INCOMPLETE', async () => {
    const badRow = { id: 3, property_id: 1, request_key: 'k', status: 'FINAL',
      fingerprint: FP1, fingerprint_version: 1, payment_intent: null,
      booking_id: 42, result: { booking_id: 42 }, response_status: 201,
      created_at: '', updated_at: '', finalized_at: null };
    const { client } = makeMockClient({ existingRows: [badRow] });
    await assert.rejects(
      getBookingCreateReplay(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 }),
      e => e.code === 'BOOKING_CREATE_REQUEST_INCOMPLETE' && e.statusCode === 409
    );
  });
  await test('R9: FINAL row with response_status=500 → 409 E_INCOMPLETE', async () => {
    const badRow = { id: 4, property_id: 1, request_key: 'k', status: 'FINAL',
      fingerprint: FP1, fingerprint_version: 1, payment_intent: null,
      booking_id: 42, result: { booking_id: 42 }, response_status: 500,
      created_at: '', updated_at: '', finalized_at: '2026-11-08T00:00:00Z' };
    const { client } = makeMockClient({ existingRows: [badRow] });
    await assert.rejects(
      getBookingCreateReplay(client, { propertyId: 1, requestKey: 'k', fingerprint: FP1, fingerprintVersion: 1 }),
      e => e.code === 'BOOKING_CREATE_REQUEST_INCOMPLETE' && e.statusCode === 409
    );
  });}

// â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ï¿½ï¿½ï¿½â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function main() {
  console.log('=== Fingerprint ===');
  await runFingerprintTests();
  console.log('\n=== Claim ===');
  await runClaimTests();
  console.log('\n=== Finalize ===');
  await runFinalizeTests();
  console.log('\n=== Replay ===');
  await runReplayTests();
  console.log('\n=== Property Isolation ===');
  await runPropertyIsolationTests();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed > 0 ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });


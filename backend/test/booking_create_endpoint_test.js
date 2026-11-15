// Checkpoint B: actual adapter + accepted domain helpers, stateful query mocks.
// No entrypoint/Pool import, server, HTTP, SQL execution, schema or file storage.
const assert = require('node:assert/strict');
const svc = require('../dist/domains/reservations/bookingCreateEndpointService');
const http = require('../dist/domains/reservations/bookingCreateHttpService');
const clone = x => JSON.parse(JSON.stringify(x));
const payload = (mode = 'PAY_BILL') => ({ property_id: 1, payment_mode: mode,
  guest_phone: '00123', reservations: [{ guest_name: 'Review', room_id: 10 }],
  ...(mode === 'PAY_BILL' ? { amount_paid: 100, payment_method: 'CASH' } : {}),
  ...(mode === 'ADVANCE_PAYMENT' ? { advance_amount: 100, payment_method: 'CASH' } : {}) });
function input(overrides = {}) {
  return { payload: payload(), propertyId: 1, headerKey: 'key-1', bodyKey: undefined,
    upload: null, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT', ...overrides };
}
const prepare = overrides => svc.prepareExplicitBookingCreateContext(input(overrides));
function upload(content = 'proof', mimetype = 'image/png', originalname = 'proof.png') {
  const buffer = Buffer.from(content); return { buffer, mimetype, originalname, size: buffer.length };
}
function canonical(property = 1, id = 101) {
  return { booking: { id, bid: 'B-101', property_id: property, booking_status: 'ACTIVE',
    guest_name_snapshot: 'Review', guest_phone_snapshot: '00123', guest_id: 22,
    booking_source: 'WALK_IN', channel: 'WALK_IN', currency_code: 'IDR' },
    reservations: [{ id: 201, booking_id: id, check_in: new Date('2026-11-11T07:00:00Z') }],
    created_guest_ids: [22], correlationId: 'CORR-original', dp_metadata: { receipt_id: 44, amount: 100 } };
}
const rowKey = (p, k) => JSON.stringify([p, k]);
function finalRow(ctx, changes = {}) {
  return { id: 10, property_id: ctx.propertyId, request_key: ctx.requestKey,
    status: 'FINAL', fingerprint: ctx.fingerprint, fingerprint_version: ctx.fingerprintVersion,
    booking_id: 101, payment_intent: { ...ctx.intent },
    result: http.buildBookingCreateHttpResponse(canonical(ctx.propertyId)).responseBody,
    response_status: 201, finalized_at: '2026-11-11T07:00:00Z', ...changes };
}
function client(options = {}) {
  const rows = new Map(), calls = [], lifecycle = [];
  let selects = 0;
  return { rows, calls, lifecycle,
    connect() { lifecycle.push('connect'); throw Error('adapter cannot connect'); },
    release() { lifecycle.push('release'); throw Error('adapter cannot release'); },
    async query(sql, args = []) {
      const text = String(sql).trim(); calls.push({ sql: text, args: [...args] });
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(text)) { lifecycle.push(text); throw Error('adapter cannot own transaction'); }
      const op = text.startsWith('SELECT') ? 'read' : text.startsWith('INSERT') ? 'claim' : 'finalize';
      if (options.failOp === op) throw options.error;
      assert.match(text, /booking_create_requests/, 'only domain storage queried');
      assert.doesNotMatch(text, /idempotency_keys/i, 'never global cache');
      const k = rowKey(args[0], args[1]);
      if (op === 'read') {
        selects++;
        if (options.disappearAfterClaim && selects === 2) rows.delete(k);
        const r = rows.get(k); return { rows: r ? [clone(r)] : [], rowCount: r ? 1 : 0 };
      }
      if (op === 'claim') {
        if (options.raceWinner) rows.set(k, clone(options.raceWinner));
        if (rows.has(k)) return { rows: [], rowCount: 0 };
        const r = { id: 1, property_id: args[0], request_key: args[1], status: 'PENDING',
          fingerprint: args[2], fingerprint_version: args[3], payment_intent: JSON.parse(args[4]),
          booking_id: null, result: null, response_status: 201, finalized_at: null };
        rows.set(k, r); return { rows: [clone(r)], rowCount: 1 };
      }
      const r = rows.get(k);
      if (!r || r.status !== 'PENDING' || r.fingerprint !== args[5] || r.fingerprint_version !== args[6]) return { rows: [], rowCount: 0 };
      Object.assign(r, { status: 'FINAL', booking_id: args[2], result: JSON.parse(args[3]),
        response_status: args[4], finalized_at: '2026-11-11T07:00:00Z' });
      return { rows: [], rowCount: 1 };
    }
  };
}
const put = (c, row) => c.rows.set(rowKey(row.property_id, row.request_key), row);
const errorIs = (status, code) => e => e.statusCode === status && (!code || e.code === code);
let passed = 0, failed = 0;
async function test(name, f) {
  try { await f(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + (e.stack || e)); }
}
(async () => {
  for (const mode of ['PAY_BILL', 'ADVANCE_PAYMENT', 'UNPAID']) await test('prepare explicit ' + mode, () => {
    const ctx = prepare({ payload: payload(mode) }); assert.equal(ctx.intent.mode, mode);
    assert.equal(ctx.propertyId, 1); assert.equal(ctx.childCount, 1); assert.match(ctx.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(ctx.fingerprintVersion, svc.BOOKING_CREATE_ENDPOINT_FP_VERSION);
    assert.ok(!JSON.stringify(ctx).includes('proof.png'));
  });
  await test('LEGACY rejected by explicit adapter', () => {
    const p = payload(); delete p.payment_mode;
    assert.throws(() => prepare({ payload: p }), errorIs(400, 'EXPLICIT_MODE_REQUIRES_PAYMENT_MODE'));
  });
  for (const overrides of [ { headerKey: undefined, bodyKey: undefined }, { headerKey: 1 },
    { headerKey: 'one', bodyKey: 'two' }, { headerKey: null, bodyKey: true } ]) {
    await test('invalid/missing/conflicting request keys ' + JSON.stringify(overrides), () => {
      assert.throws(() => prepare(overrides), errorIs(400));
    });
  }
  await test('header/body aliases normalize identically without affecting FP', () => {
    const a = prepare({ headerKey: ' key-1 ', bodyKey: 'key-1' });
    const b = prepare({ headerKey: null, bodyKey: 'key-1' });
    assert.equal(a.requestKey, b.requestKey); assert.equal(a.fingerprint, b.fingerprint);
  });
  for (const propertyId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, true, '1']) {
    await test('authorized property type/range rejected ' + String(propertyId), () => {
      assert.throws(() => prepare({ propertyId }), errorIs(400));
    });
  }
  for (const raw of [2, true, [], [1], {}, null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    await test('payload property binding rejects ' + JSON.stringify(raw), () => {
      assert.throws(() => prepare({ payload: { ...payload(), property_id: raw } }), errorIs(400));
    });
  }
  await test('numeric string property accepted and input unchanged', () => {
    const p = { ...payload(), property_id: '1' }, before = clone(p);
    assert.equal(prepare({ payload: p }).propertyId, 1); assert.deepEqual(p, before);
  });
  for (const p of [null, [], 'scalar', { ...payload(), reservations: [] }, { ...payload(), reservations: {} }]) {
    await test('invalid payload/children ' + JSON.stringify(p), () => assert.throws(() => prepare({ payload: p }), errorIs(400)));
  }
  await test('FP canonical nested ordering + excluded client metadata', () => {
    const a = { ...payload(), initial_payment: { amount: 100, payment_method: 'CASH' }, request_key: 'one', correlation_id: 'old', _oak_correlation: 'a', fingerprint: 'fake', fingerprint_version: 999, fingerprintVersion: 999 };
    const b = { ...payload(), initial_payment: { payment_method: 'CASH', amount: 100 }, request_key: 'two', correlation_id: 'new', _oak_correlation: 'b', fingerprint: 'other', fingerprint_version: 0, fingerprintVersion: 0 };
    assert.equal(prepare({ payload: a }).fingerprint, prepare({ payload: b }).fingerprint);
    assert.equal(prepare({ payload: a }).fingerprintVersion, svc.BOOKING_CREATE_ENDPOINT_FP_VERSION);
  });
  await test('FP mode/amount/method/property/unknown-business inputs retained', () => {
    const original = prepare().fingerprint;
    for (const p of [payload('UNPAID'), payload('ADVANCE_PAYMENT'), { ...payload(), amount_paid: 101 },
      { ...payload(), payment_method: 'QRIS' }, { ...payload(), future_business_field: 'new' }]) {
      assert.notEqual(prepare({ payload: p }).fingerprint, original);
    }
    assert.notEqual(prepare({ propertyId: 2, payload: { ...payload(), property_id: 2 } }).fingerprint, original);
  });
  await test('FP child order, phone leading zero and server collection context retained', () => {
    const p = { ...payload(), reservations: [{ room_id: 1 }, { room_id: 2 }] };
    assert.notEqual(prepare({ payload: p }).fingerprint, prepare({ payload: { ...p, reservations: [...p.reservations].reverse() } }).fingerprint);
    assert.notEqual(prepare().fingerprint, prepare({ payload: { ...payload(), guest_phone: '123' } }).fingerprint);
    assert.notEqual(prepare().fingerprint, prepare({ channelType: 'OTA' }).fingerprint);
  });
  await test('server wrappers cannot be overwritten by payload fields', () => {
    const p = { ...payload(), _fp_context: { propertyId: 99 }, payload: { property_id: 99 }, voucherDescriptor: 'fake' };
    assert.equal(prepare({ payload: p }).propertyId, 1); assert.notEqual(prepare({ payload: p }).fingerprint, prepare().fingerprint);
  });
  await test('hotel file identity ignores filename; bytes/MIME/length differ', () => {
    const a = prepare({ upload: upload() }).fingerprint;
    assert.equal(a, prepare({ upload: upload('proof', 'image/png', 'new.png') }).fingerprint);
    assert.notEqual(a, prepare({ upload: upload('other') }).fingerprint);
    assert.notEqual(a, prepare({ upload: upload('proof', 'application/pdf') }).fingerprint);
    assert.notEqual(a, prepare({ upload: upload('proof-longer') }).fingerprint);
    assert.notEqual(prepare({ upload: upload('') }).fingerprint, prepare().fingerprint);
    assert.throws(() => prepare({ upload: { ...upload(), size: 999 } }), errorIs(400));
  });
  await test('UNPAID hotel file rejected; OTA voucher legal and identity-bound', () => {
    assert.throws(() => prepare({ payload: payload('UNPAID'), upload: upload() }), errorIs(400));
    const p = input({ payload: payload('UNPAID'), channelType: 'OTA', paymentResponsibility: 'OTA_COLLECT', upload: upload() });
    const a = svc.prepareExplicitBookingCreateContext(p);
    assert.equal(a.intent.mode, 'UNPAID');
    assert.notEqual(a.fingerprint, svc.prepareExplicitBookingCreateContext({ ...p, upload: upload('other') }).fingerprint);
    assert.equal(a.fingerprint, svc.prepareExplicitBookingCreateContext({ ...p, upload: upload('proof', 'image/png', 'other.png') }).fingerprint);
  });
  await test('invalid collection context/channel combination rejected', () => {
    assert.throws(() => prepare({ paymentResponsibility: 'OTA_COLLECT' }), errorIs(400));
    assert.throws(() => prepare({ channelType: 'invalid' }), errorIs(400));
  });
  await test('read absent is null and fresh claim records expected FP/version/intent', async () => {
    const c = client(), ctx = prepare(); assert.equal(await svc.readBookingCreateEndpointReplay(c, ctx), null);
    assert.deepEqual(await svc.claimBookingCreateEndpoint(c, ctx), { kind: 'claimed' });
    const row = c.rows.get(rowKey(1, 'key-1'));
    assert.equal(row.fingerprint, ctx.fingerprint); assert.equal(row.fingerprint_version, ctx.fingerprintVersion);
    assert.deepEqual(row.payment_intent, ctx.intent); assert.equal(row.status, 'PENDING'); assert.deepEqual(c.lifecycle, []);
  });
  await test('fresh finalize exact snapshot + replay, caller lifecycle untouched', async () => {
    const c = client(), ctx = prepare(), source = canonical(); await svc.claimBookingCreateEndpoint(c, ctx);
    const snap = await svc.finalizeBookingCreateEndpoint(c, ctx, source);
    const update = c.calls.find(q => q.sql.startsWith('UPDATE'));
    assert.equal(update.args[4], snap.responseStatus); assert.deepEqual(JSON.parse(update.args[3]), snap.responseBody);
    assert.equal(snap.responseBody.data.reservations[0].check_in, '2026-11-11T07:00:00.000Z');
    source.dp_metadata.amount = 999; source.reservations[0].id = 999;
    const read = await svc.readBookingCreateEndpointReplay(c, ctx);
    assert.equal(read.kind, 'replay'); assert.deepEqual(read.response, snap); assert.equal(read.response.responseBody.data.dp_metadata.amount, 100);
    assert.equal(read.response.responseBody.correlation_id, 'CORR-original'); assert.deepEqual(c.lifecycle, []);
  });
  for (const status of [200, 201, 304]) await test('stored status preserved ' + status, async () => {
    const c = client(), ctx = prepare(), row = finalRow(ctx, { response_status: status });
    row.result.extra = { additive: [3, 1, 2] }; put(c, row);
    const oldBuilder = http.buildBookingCreateHttpResponse;
    http.buildBookingCreateHttpResponse = () => { throw Error('read must not build a fresh response'); };
    try {
      const r = await svc.readBookingCreateEndpointReplay(c, ctx);
      assert.equal(r.response.responseStatus, status); assert.deepEqual(r.response.responseBody, row.result);
    } finally { http.buildBookingCreateHttpResponse = oldBuilder; }
  });
  await test('claim existing FINAL and raced FINAL use validated winner', async () => {
    const ctx = prepare();
    for (const race of [false, true]) {
      const row = finalRow(ctx), c = client(race ? { raceWinner: row } : {}); if (!race) put(c, row);
      const out = await svc.claimBookingCreateEndpoint(c, ctx);
      assert.equal(out.kind, 'replay'); assert.equal(out.bookingId, 101); assert.deepEqual(out.response.responseBody, row.result);
      assert.ok(c.calls.filter(q => q.sql.startsWith('SELECT')).every(q => q.args[0] === ctx.propertyId && q.args[1] === ctx.requestKey));
    }
  });
  await test('claim loser missing reread fails closed', async () => {
    const ctx = prepare(), c = client({ disappearAfterClaim: true }); put(c, finalRow(ctx));
    await assert.rejects(svc.claimBookingCreateEndpoint(c, ctx), errorIs(409));
  });
  for (const which of ['read', 'claim']) for (const change of [
    { status: 'PENDING', result: null, booking_id: null, finalized_at: null },
    { fingerprint: 'f'.repeat(64) }, { fingerprint_version: 999 }, { finalized_at: null },
    { result: null }, { result: [] }, { response_status: null }, { response_status: 500 }
  ]) await test(which + ' authoritative invalid row ' + JSON.stringify(change), async () => {
    const ctx = prepare(), c = client(); put(c, finalRow(ctx, change));
    await assert.rejects(which === 'read' ? svc.readBookingCreateEndpointReplay(c, ctx) : svc.claimBookingCreateEndpoint(c, ctx), errorIs(409));
    assert.ok(!c.calls.some(q => q.sql.startsWith('UPDATE')));
  });
  const badBodies = [
    b => { b.status = 'ERROR'; }, b => { b.data = []; }, b => { b.data.booking_id = 999; },
    b => { b.data.property_id = 2; }, b => { b.data.booking_id = '101'; }, b => { b.data.property_id = true; },
    b => { b.data.reservations = []; }, b => { b.correlation_id = ''; }, b => { b.data.dp_metadata = null; },
    b => { b.data.dp_metadata = []; }
  ];
  for (const [i, mutate] of badBodies.entries()) await test('stored public envelope rejected #' + i, async () => {
    const ctx = prepare(), c = client(), row = finalRow(ctx); mutate(row.result); put(c, row);
    await assert.rejects(svc.readBookingCreateEndpointReplay(c, ctx), errorIs(409));
  });
  await test('validator rejects non-plain data, coerced IDs and invalid expected binding', () => {
    const body = http.buildBookingCreateHttpResponse(canonical()).responseBody;
    class Data { constructor() { Object.assign(this, body.data); } }
    assert.throws(() => svc.validateStoredHttpResponse({ ...body, data: new Data() }, { bookingId: 101, propertyId: 1 }), errorIs(409));
    assert.throws(() => svc.validateStoredHttpResponse({ ...body, data: { ...body.data, booking_id: true } }, { bookingId: 1, propertyId: 1 }), errorIs(409));
    assert.throws(() => svc.validateStoredHttpResponse(body, { bookingId: NaN, propertyId: 1 }), errorIs(409));
  });
  await test('same key property isolation', async () => {
    const c = client(), one = prepare(), two = prepare({ propertyId: 2, payload: { ...payload(), property_id: 2 } });
    put(c, finalRow(one)); assert.equal(await svc.readBookingCreateEndpointReplay(c, two), null);
    assert.equal((await svc.claimBookingCreateEndpoint(c, two)).kind, 'claimed'); assert.equal(c.rows.size, 2);
  });
  for (const invalid of ['booking', 'property', 'buffer', 'cycle', 'empty-reservations', 'blank-correlation']) {
    await test('finalize invalid canonical before UPDATE ' + invalid, async () => {
      const ctx = prepare(), c = client(), result = canonical(); await svc.claimBookingCreateEndpoint(c, ctx);
      if (invalid === 'booking') result.booking.id = true;
      if (invalid === 'property') result.booking.property_id = 2;
      if (invalid === 'buffer') result.dp_metadata.bytes = Buffer.from('bad');
      if (invalid === 'cycle') result.dp_metadata.loop = result;
      if (invalid === 'empty-reservations') result.reservations = [];
      if (invalid === 'blank-correlation') result.correlationId = '';
      await assert.rejects(svc.finalizeBookingCreateEndpoint(c, ctx, result));
      assert.ok(!c.calls.some(q => q.sql.startsWith('UPDATE'))); assert.equal(c.rows.get(rowKey(1, 'key-1')).status, 'PENDING');
    });
  }
  for (const op of ['read', 'claim', 'finalize']) for (const code of ['42P01', '42703', '42P10']) {
    await test('readiness ' + op + ' ' + code, async () => {
      const c = client({ failOp: op, error: Object.assign(Error('schema'), { code }) }), ctx = prepare();
      const fn = op === 'read' ? svc.readBookingCreateEndpointReplay : op === 'claim' ? svc.claimBookingCreateEndpoint : svc.finalizeBookingCreateEndpoint;
      await assert.rejects(fn(c, ctx, canonical()), errorIs(503, 'BOOKING_CREATE_REPLAY_NOT_READY')); assert.deepEqual(c.lifecycle, []);
    });
  }
  for (const op of ['read', 'claim', 'finalize']) for (const error of [
    Object.assign(Error('business'), { code: 'BUSINESS', statusCode: 409 }),
    Object.assign(Error('transport'), { code: 'ECONNRESET' }), Object.assign(Error('unrelated database'), { code: '23505' })
  ]) await test('unrelated error preserved ' + op + ' ' + error.code, async () => {
    const c = client({ failOp: op, error }), ctx = prepare();
    const fn = op === 'read' ? svc.readBookingCreateEndpointReplay : op === 'claim' ? svc.claimBookingCreateEndpoint : svc.finalizeBookingCreateEndpoint;
    await assert.rejects(fn(c, ctx, canonical()), e => e === error);
  });
  await test('finalize failure propagates and PENDING remains; no lifecycle action', async () => {
    const error = Error('finalize failed'), ctx = prepare(), c = client({ failOp: 'finalize', error });
    await svc.claimBookingCreateEndpoint(c, ctx);
    await assert.rejects(svc.finalizeBookingCreateEndpoint(c, ctx, canonical()), e => e === error);
    assert.equal(c.rows.get(rowKey(1, 'key-1')).status, 'PENDING'); assert.deepEqual(c.lifecycle, []);
  });
  await test('finalize idempotent snapshot tolerates JSONB object key order', async () => {
    const ctx = prepare(), c = client(); await svc.claimBookingCreateEndpoint(c, ctx);
    const a = await svc.finalizeBookingCreateEndpoint(c, ctx, canonical());
    const row = c.rows.get(rowKey(1, 'key-1')); row.result = Object.fromEntries(Object.entries(row.result).reverse());
    const b = await svc.finalizeBookingCreateEndpoint(c, ctx, canonical()); assert.deepEqual(a, b);
  });
  console.log('RESULT PASS=' + passed + ' FAIL=' + failed + ' TOTAL=' + (passed + failed));
  console.log('DB-free accepted helpers + adapter only. Endpoint C / DB concurrency / smoke pending.');
  process.exitCode = failed ? 1 : 0;
})();

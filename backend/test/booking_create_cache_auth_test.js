// DB-free: AST-extract ACTUAL production declarations and Express callbacks.
// Does not import index, construct a Pool, open a server, or execute SQL/HTTP.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const http = require('../dist/domains/reservations/bookingCreateHttpService');
const context = require('../dist/domains/reservations/bookingCreateContextService');
const replay = require('../dist/domains/reservations/bookingCreateRequestService');
const src = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');
const ast = ts.createSourceFile('index.ts', src, ts.ScriptTarget.Latest, true);
assert.equal(ast.parseDiagnostics.length, 0, 'production source parses');
const names = ['globalIdempotencyCacheBody', 'buildScopedBookingPayloadFingerprint',
  'bookingScopedLegacyCacheLookup', 'bookingScopedLegacyCacheClaim', 'bookingScopedLegacyCachePersist',
  'normalizeBookingSourceValue', 'deriveBookingCollectionContext', 'createHttpError'];
const functions = names.map(name => {
  const f = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(f, 'production function exists: ' + name); return f.getText(ast);
});
function appCall(method, predicate) {
  for (const s of ast.statements) {
    if (!ts.isExpressionStatement(s) || !ts.isCallExpression(s.expression)) continue;
    const c = s.expression, e = c.expression;
    if (ts.isPropertyAccessExpression(e) && e.expression.getText(ast) === 'app' &&
      e.name.text === method && predicate(c)) return c;
  }
  throw Error('missing production app.' + method);
}
const routeCall = appCall('post', c => c.arguments[0]?.text === '/api/bookings');
const middlewareCall = appCall('use', c => c.arguments[0]?.getText(ast).includes('isBookingCreateRequest'));
const fragment = functions.join('\n') + '\nconst api={' + names.join(',') +
  ',route:' + routeCall.arguments.at(-1).getText(ast) +
  ',middleware:' + middlewareCall.arguments[0].getText(ast) + '};';
const executable = ts.transpileModule(fragment, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
}}).outputText;
const future = () => new Date(Date.now() + 3600000).toISOString();
const expired = '2000-01-01T00:00:00Z';
const freshPayload = () => ({ property_id: 1, guest_phone: '00123', reservations: [{ guest_name: 'Review' }] });
const clone = value => JSON.parse(JSON.stringify(value));
function makePool(options = {}) {
  const rows = new Map();
  return { rows, queries: [], async query(sql, args = []) {
    this.queries.push({ sql, args: [...args] });
    if (/^SELECT/i.test(sql)) {
      if (options.failRead) throw Error('read unavailable');
      const r = rows.get(args[0]); return { rows: r ? [{ ...r }] : [], rowCount: r ? 1 : 0 };
    }
    if (/^DELETE/i.test(sql)) {
      options.beforeDelete?.(rows, args[0]);
      const r = rows.get(args[0]);
      if (!r || !r.expires_at || !(new Date(r.expires_at) < new Date())) return { rows: [], rowCount: 0 };
      rows.delete(args[0]); return { rows: [{ key: args[0] }], rowCount: 1 };
    }
    if (/^INSERT/i.test(sql)) {
      if (options.failClaim) throw Error('claim unavailable');
      if (options.unconfirmedClaim) return { rows: [], rowCount: 0 };
      if (rows.has(args[0])) {
        if (/DO NOTHING/i.test(sql)) return { rows: [], rowCount: 0 };
        throw Object.assign(Error('duplicate'), { code: '23505' });
      }
      const isBookingClaim = /response_headers/i.test(sql);
      rows.set(args[0], { key: args[0], request_hash: args[1], response_body: null,
        response_headers: isBookingClaim ? args[2] : null,
        expires_at: isBookingClaim ? args[3] : args[2], status_code: null });
      return { rows: [{ key: args[0] }], rowCount: 1 };
    }
    if (/^UPDATE/i.test(sql)) {
      if (options.failPersist) throw Error('persist unavailable');
      const r = rows.get(args[3]);
      if (!r) return { rows: [], rowCount: 0 };
      if (args.length >= 6 && (r.request_hash !== args[4] || r.response_headers !== args[5] || r.response_body !== null)) {
        return { rows: [], rowCount: 0 };
      }
      Object.assign(r, { response_body: args[0], response_headers: args[1], status_code: args[2] });
      return { rows: [{ key: args[3] }], rowCount: 1 };
    }
    throw Error('unexpected mock SQL: ' + sql);
  }};
}
function req(payload = freshPayload(), header = 'test-key', file = null) {
  return { method: 'POST', path: '/api/bookings', body: payload,
    headers: header === null ? {} : { 'idempotency-key': header }, file };
}
function res() {
  return { statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; }, getHeaders() { return this.headers; }
  };
}
function makeHarness(options = {}) {
  const pool = makePool(options), events = [], logs = [];
  const state = { writers: 0, scopes: [], broadcasts: 0 };
  pool.connect = async () => ({ release() { events.push('read-release'); } });
  const endpointSvc = require('../dist/domains/reservations/bookingCreateEndpointService');
  const deps = { pool, __oakGlobalPoolRef: pool, crypto, Buffer, process: { env: { IDEMPOTENCY_WAIT_SECONDS: '0' } },
    console: { error: (...a) => logs.push(a), log: () => {} }, setTimeout,
    hasRows: r => Number(r?.rowCount ?? 0) > 0,
    isBookingCreateRequest: http.isBookingCreateRequest,
    buildLegacyBookingCacheKey: http.buildLegacyBookingCacheKey,
    buildEvidenceDescriptor: context.buildEvidenceDescriptor,
    computeBookingCreateFingerprint: replay.computeBookingCreateFingerprint,
    computeRequestHash: (_m, _p, body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    assertPropertyScope: async (_q, property) => {
      events.push('scope'); state.scopes.push(property);
      if (options.forbidden) throw Object.assign(Error('Forbidden'), { statusCode: 403 });
    },
    createCanonicalBooking: async (q, payload, _children, canonicalOptions) => {
      events.push('writer'); state.writers++;
      await options.writer?.(q, payload);
      const result = { booking: { id: 101, property_id: 1, bid: 'B-1', booking_status: 'ACTIVE',
        guest_name_snapshot: 'Review', guest_phone_snapshot: null, booking_source: 'WALKIN', channel: null, currency_code: 'IDR' },
        reservations: [{ id: 201, booking_id: 101 }], correlationId: 'C-1' };
      if (canonicalOptions?.explicitContext) return { kind: 'fresh', result, response: http.buildBookingCreateHttpResponse(result) };
      return result;
    },
    broadcastEvent: () => { state.broadcasts++; },
    isRoomOverlapViolation: () => false,
    sendRoomOverlapConflict: r => r.status(409).json({ status: 'FAILED' }),
    responseStatusTextForCode: code => code >= 500 ? 'ERROR' : 'FAILED',
    VALID_EXTENDED_BOOKING_SOURCES: ['WALKIN','WALK_IN','DIRECT','WEBSITE','BOOKING_COM','AGODA','TRAVELOKA','TIKET_COM','OTA','OTHER'],
    prepareExplicitBookingCreateContext: options.mockPrepare ? options.mockPrepare : endpointSvc.prepareExplicitBookingCreateContext,
    readBookingCreateEndpointReplay: options.mockReadReplay ? options.mockReadReplay : (async (c, ctx) => null)
  };
  const realQuery = pool.query.bind(pool);
  pool.query = async (...args) => { events.push('cache'); return realQuery(...args); };
  // Same realm as pure helper modules: avoids prototype mismatches introduced by a VM.
  const api = new Function(...Object.keys(deps), executable + '\nreturn api;')(...Object.values(deps));
  return { api, pool, state, events, logs };
}
const key = (header = 'test-key', property = 1) => http.buildLegacyBookingCacheKey(property, header);
const file = (bytes = 'proof', mime = 'image/png', filename = 'proof.png') => ({ buffer: Buffer.from(bytes), mimetype: mime, originalname: filename });
async function call(h, p = freshPayload(), header = 'test-key', f = null) {
  const r = res(); await h.api.route(req(p, header, f), r); return r;
}
let passed = 0, failed = 0;
async function test(name, f) {
  try { await f(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + (e.stack || e)); }
}
(async () => {
  await test('registration preserves auth then upload before handler', () => {
    assert.equal(routeCall.arguments[1].getText(ast), 'requireAuth');
    assert.match(routeCall.arguments[2].getText(ast), /quickBookingEvidenceUpload\.single/);
  });
  for (const p of ['/api/bookings', '/api/bookings/', '/API/BOOKINGS', '/Api/Bookings/']) {
    await test('actual global callback bypass ' + p, async () => {
      const h = makeHarness(), q = req(), r = res(); q.path = p;
      const oldSend = r.send; let n = 0;
      await h.api.middleware(q, r, () => n++);
      assert.equal(n, 1); assert.equal(h.pool.queries.length, 0); assert.equal(r.send, oldSend);
    });
  }
  for (const [method, p] of [['POST', '/api/pos/orders'], ['POST', '/api/pos/orders/12/pay'],
    ['POST', '/api/pos/orders/12/room-charge'], ['PUT', '/API/POS/ORDERS/abc/'], ['GET', '/api/reservations']]) {
    await test('actual non-cache bypass ' + method + ' ' + p, async () => {
      const h = makeHarness(), q = req(), r = res(); q.method = method; q.path = p;
      let n = 0; await h.api.middleware(q, r, () => n++);
      assert.equal(n, 1); assert.equal(h.pool.queries.length, 0);
    });
  }
  for (const p of ['/API/POS/ORDERS/', '/api/pos/orders/x/pay', '/API/POS/ORDERS/1/room-charge/']) {
    await test('actual invalid POS variant rejected ' + p, async () => {
      const h = makeHarness(), q = req(), r = res(); q.path = p;
      await h.api.middleware(q, r, () => assert.fail('must not next'));
      assert.equal(r.statusCode, 404); assert.equal(h.pool.queries.length, 0);
    });
  }
  await test('non-booking global cache still claims and installs persistence hook', async () => {
    const h = makeHarness(), q = req(), r = res(); q.path = '/api/reservations'; const original = r.send;
    let n = 0; await h.api.middleware(q, r, () => n++);
    assert.equal(n, 1); assert.ok(h.pool.rows.has('test-key')); assert.notEqual(r.send, original);
    r.send('done'); await Promise.resolve(); assert.equal(h.pool.rows.get('test-key').response_body, 'done');
  });
  for (const p of [null, [], 'scalar', { booking_payload: 'null' }, { booking_payload: '[]' },
    { booking_payload: '42' }, { booking_payload: '{broken' }, { booking_payload: {} }, { booking_payload: null },
    { property_id: 1, reservations: [] }]) {
    await test('shape error returns 400 without cache/writer ' + JSON.stringify(p), async () => {
      const h = makeHarness(), r = await call(h, p);
      assert.equal(r.statusCode, 400); assert.equal(h.state.writers, 0); assert.equal(h.pool.queries.length, 0);
    });
  }
  for (const property of [true, false, [], [1], {}, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '', 'abc']) {
    await test('property shape rejected ' + JSON.stringify(property), async () => {
      const h = makeHarness(), r = await call(h, { ...freshPayload(), property_id: property });
      assert.equal(r.statusCode, 400); assert.equal(h.state.scopes.length, 0); assert.equal(h.state.writers, 0); assert.equal(h.pool.queries.length, 0);
    });
  }
  await test('forbidden access stops cache/writer', async () => {
    const h = makeHarness({ forbidden: true }), r = await call(h);
    assert.equal(r.statusCode, 403); assert.equal(h.pool.queries.length, 0); assert.equal(h.state.writers, 0);
  });
  for (const multipart of [false, true]) await test('scope precedes cache for ' + (multipart ? 'multipart' : 'JSON'), async () => {
    const h = makeHarness(), p = { ...freshPayload(), property_id: '1' };
    const r = await call(h, multipart ? { booking_payload: JSON.stringify(p) } : p);
    assert.equal(r.statusCode, 201); assert.equal(h.events[0], 'scope'); assert.equal(h.state.writers, 1);
  });
  for (const mode of ['PAY_BILL', 'ADVANCE_PAYMENT', 'UNPAID', 'UNKNOWN_MODE']) {
    for (const failure of [false, true]) await test('explicit zero cache ' + mode + ' failure=' + failure, async () => {
      const h = makeHarness({ writer: failure ? () => { throw Object.assign(Error('validation'), { statusCode: 400 }); } : undefined });
      const modePayload = { ...freshPayload(), payment_mode: mode,
        ...(mode === 'ADVANCE_PAYMENT' ? { advance_amount: 100, payment_method: 'CASH' } : {}) };
      const r = await call(h, modePayload);
      assert.equal(r.statusCode, mode === 'UNKNOWN_MODE' || failure ? 400 : 201); assert.equal(h.pool.queries.length, 0);
      // Context prepare now rejects UNKNOWN before any domain read/canonical writer.
    });
  }
  await test('legacy without key has no cache', async () => {
    const h = makeHarness(), r = await call(h, freshPayload(), null);
    assert.equal(r.statusCode, 201); assert.equal(h.pool.queries.length, 0); assert.equal(h.state.writers, 1);
  });
  await test('invalid header type returns controlled 400', async () => {
    const h = makeHarness(), r = await call(h, freshPayload(), ['bad']);
    assert.equal(r.statusCode, 400); assert.equal(h.pool.queries.length, 0); assert.equal(h.state.writers, 0);
  });
  await test('identical retry replays final, one writer and no replay broadcasts', async () => {
    const h = makeHarness(), first = await call(h), broadcasts = h.state.broadcasts, second = await call(h);
    assert.equal(second.statusCode, 201); assert.deepEqual(second.body, clone(first.body));
    assert.equal(h.state.writers, 1); assert.equal(h.state.broadcasts, broadcasts);
  });
  await test('lookup PENDING never enters writer', async () => {
    const h = makeHarness(); await h.api.bookingScopedLegacyCacheClaim(h.pool, key(), h.api.buildScopedBookingPayloadFingerprint(freshPayload(), null));
    const r = await call(h); assert.equal(r.statusCode, 202); assert.equal(h.state.writers, 0);
  });
  for (const kind of ['failRead', 'failClaim', 'unconfirmedClaim']) await test(kind + ' never blind-creates', async () => {
    const h = makeHarness({ [kind]: true }), r = await call(h);
    assert.ok(r.statusCode >= 500); assert.equal(h.state.writers, 0);
  });
  await test('concurrent identical key runs exactly one writer', async () => {
    const h = makeHarness({ writer: async () => new Promise(resolve => setImmediate(resolve)) });
    const replies = await Promise.all([call(h), call(h)]);
    assert.equal(h.state.writers, 1); assert.deepEqual(replies.map(r => r.statusCode).sort(), [201, 202]);
    const replayed = await call(h); assert.equal(replayed.statusCode, 201); assert.equal(h.state.writers, 1);
  });
  await test('different payload under PENDING key conflicts, no writer', async () => {
    const h = makeHarness(); await h.api.bookingScopedLegacyCacheClaim(h.pool, key(), h.api.buildScopedBookingPayloadFingerprint(freshPayload(), null));
    const r = await call(h, { ...freshPayload(), amount_paid: 10 });
    assert.equal(r.statusCode, 409); assert.equal(h.state.writers, 0);
  });
  await test('upload retry/filename-only change HIT; bytes or MIME change conflicts', async () => {
    const h = makeHarness(); await call(h, freshPayload(), 'test-key', file());
    assert.equal((await call(h, freshPayload(), 'test-key', file('proof', 'image/png', 'renamed.png'))).statusCode, 201);
    assert.equal((await call(h, freshPayload(), 'test-key', file('changed'))).statusCode, 409);
    assert.equal((await call(h, freshPayload(), 'test-key', file('proof', 'application/pdf'))).statusCode, 409);
    assert.equal(h.state.writers, 1);
  });
  await test('empty upload distinct from no upload', () => {
    const h = makeHarness(); assert.notEqual(h.api.buildScopedBookingPayloadFingerprint(freshPayload(), null),
      h.api.buildScopedBookingPayloadFingerprint(freshPayload(), Buffer.alloc(0), 'image/png'));
  });
  await test('nested key order and transport request_key do not alter business identity', () => {
    const h = makeHarness();
    const a = { ...freshPayload(), initial_payment: { amount: 10, method: 'CASH' }, request_key: 'one' };
    const b = { ...freshPayload(), initial_payment: { method: 'CASH', amount: 10 }, request_key: 'two' };
    assert.equal(h.api.buildScopedBookingPayloadFingerprint(a, null), h.api.buildScopedBookingPayloadFingerprint(b, null));
  });
  await test('array order and leading-zero string values remain identity', () => {
    const h = makeHarness(), fp = v => h.api.buildScopedBookingPayloadFingerprint(v, null);
    assert.notEqual(fp({ children: [1, 2] }), fp({ children: [2, 1] }));
    assert.notEqual(fp({ phone: '00123' }), fp({ phone: '123' }));
  });
  await test('writer mutation cannot change precomputed cache fingerprint', async () => {
    const h = makeHarness({ writer: (_q, p) => { p.server_mutation = 'after claim'; } });
    await call(h); const r = await call(h);
    assert.equal(r.statusCode, 201); assert.equal(h.state.writers, 1);
  });
  await test('same raw key across properties remains isolated', async () => {
    const h = makeHarness(); await call(h);
    const r = await call(h, { ...freshPayload(), property_id: 2 });
    assert.equal(r.statusCode, 201); assert.equal(h.state.writers, 2); assert.ok(h.pool.rows.has(key('test-key', 2)));
  });
  for (const sameHash of [false, true]) await test('active unscoped row withheld even matching=' + sameHash, async () => {
    const h = makeHarness(); h.pool.rows.set('test-key', { request_hash: sameHash ? h.api.buildScopedBookingPayloadFingerprint(freshPayload(), null) : 'old',
      response_body: JSON.stringify({ secret: 'foreign' }), expires_at: future() });
    const r = await call(h); assert.equal(r.statusCode, 409); assert.equal(h.state.writers, 0); assert.ok(!JSON.stringify(r.body).includes('foreign'));
  });
  await test('expired unscoped row ignored, not deleted', async () => {
    const h = makeHarness(); h.pool.rows.set('test-key', { request_hash: 'old', expires_at: expired });
    assert.equal((await call(h)).statusCode, 201); assert.ok(h.pool.rows.has('test-key'));
  });
  await test('expired scoped row can be claimed again per existing TTL', async () => {
    const h = makeHarness(); h.pool.rows.set(key(), { request_hash: 'old', expires_at: expired });
    assert.equal((await call(h)).statusCode, 201); assert.equal(h.state.writers, 1);
  });
  await test('expired cleanup cannot delete a fresh replacement', async () => {
    const h = makeHarness({ beforeDelete: (rows, k) => { rows.set(k, { request_hash: 'new', expires_at: future() }); } });
    h.pool.rows.set(key(), { request_hash: 'old', expires_at: expired });
    assert.equal((await call(h)).statusCode, 202); assert.equal(h.state.writers, 0); assert.equal(h.pool.rows.get(key()).request_hash, 'new');
  });
  await test('lost owner cannot finalize or overwrite a FINAL', async () => {
    const h = makeHarness(), fp = h.api.buildScopedBookingPayloadFingerprint(freshPayload(), null);
    const claim = await h.api.bookingScopedLegacyCacheClaim(h.pool, key(), fp);
    await assert.rejects(h.api.bookingScopedLegacyCachePersist(h.pool, key(), fp, 'wrong-owner', 201, {}));
    assert.equal(h.pool.rows.get(key()).response_body, null);
    await h.api.bookingScopedLegacyCachePersist(h.pool, key(), fp, claim.ownerToken, 201, { result: 'winner' });
    await assert.rejects(h.api.bookingScopedLegacyCachePersist(h.pool, key(), fp, claim.ownerToken, 500, { result: 'loser' }));
    assert.equal(JSON.parse(h.pool.rows.get(key()).response_body).result, 'winner');
  });
  await test('finalize cannot recreate missing placeholder', async () => {
    const h = makeHarness(); await assert.rejects(h.api.bookingScopedLegacyCachePersist(h.pool, key(), 'fp', 'owner', 201, {}));
    assert.equal(h.pool.rows.size, 0);
  });
  await test('persist failure after writer keeps PENDING and retry cannot recreate', async () => {
    const h = makeHarness({ failPersist: true }); assert.equal((await call(h)).statusCode, 201);
    assert.equal(h.pool.rows.get(key()).response_body, null); assert.ok(h.logs.length > 0);
    assert.equal((await call(h)).statusCode, 202); assert.equal(h.state.writers, 1);
  });
  await test('unknown writer/commit failure remains PENDING, not FINAL error', async () => {
    const h = makeHarness({ writer: () => { throw Error('COMMIT acknowledgement lost'); } });
    assert.equal((await call(h)).statusCode, 500); assert.equal(h.pool.rows.get(key()).response_body, null);
    assert.equal((await call(h)).statusCode, 202); assert.equal(h.state.writers, 1);
  });
  await test('ordinary pre-return 4xx uses owned row and replays error', async () => {
    const h = makeHarness({ writer: () => { throw Object.assign(Error('business validation'), { statusCode: 400 }); } });
    assert.equal((await call(h)).statusCode, 400); assert.equal((await call(h)).statusCode, 400); assert.equal(h.state.writers, 1);
  });
  await test('response failure after FINAL cannot overwrite success', async () => {
    const h = makeHarness(), q = req(), r = res(); let once = true;
    r.json = function(b) { if (once) { once = false; throw Error('transport failure'); } this.body = b; return this; };
    await h.api.route(q, r);
    const row = h.pool.rows.get(key()); assert.equal(row.status_code, 201); assert.equal(JSON.parse(row.response_body).status, 'SUCCESS');
    const retry = await call(h); assert.equal(retry.statusCode, 201); assert.equal(h.state.writers, 1);
  });
  console.log('RESULT PASS=' + passed + ' FAIL=' + failed + ' TOTAL=' + (passed + failed));
  console.log('DB-free extracted production code only; no PostgreSQL concurrency/build/runtime claim.');
  process.exitCode = failed ? 1 : 0;
})();

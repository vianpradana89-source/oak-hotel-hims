// booking_create_http_test.js
// Unit 3C Part 1 — DB-free tests for bookingCreateHttpService:
// buildBookingCreateHttpResponse, isBookingCreateRequest, buildLegacyBookingCacheKey.
// Imports production dist output only — no index.ts, no server, no pool, no cache.
const assert = require('node:assert');
const crypto = require('node:crypto');
const {
  buildBookingCreateHttpResponse,
  isBookingCreateRequest,
  buildLegacyBookingCacheKey
} = require('../dist/domains/reservations/bookingCreateHttpService');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS: ' + name); }
  catch (e) { failed++; console.error('FAIL: ' + name + '\n  ' + (e.message || e)); }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeReservation(overrides = {}) {
  return {
    id: 101, booking_number: 'RES-001', bid: 'BID-001', booking_id: 7,
    status: 'BOOKED', guest_name: 'Budi', guest_phone: '081234',
    room_id: 12, check_in: '2026-12-01', check_out: '2026-12-03',
    ...overrides
  };
}

function baseBooking() {
  return {
    id: 7,
    bid: 'BID-001',
    property_id: 3,
    guest_name_snapshot: 'Budi',
    guest_phone_snapshot: '081234',
    booking_status: 'ACTIVE',
    booking_source: 'walkin',
    channel: 'WALK_IN',
    currency_code: 'IDR',
    guest_id: null,
    created_guest_ids: [55, 56]
  };
}

function makeCanonicalResult(overrides = {}) {
  return {
    booking: { ...baseBooking(), ...(overrides.booking || {}) },
    reservations: overrides.reservations !== undefined ? overrides.reservations : [makeReservation(), makeReservation({ id: 102, booking_number: 'RES-002' })],
    created_guest_ids: overrides.created_guest_ids !== undefined ? overrides.created_guest_ids : [55, 56],
    correlationId: overrides.correlationId !== undefined ? overrides.correlationId : 'CORR-TEST-1',
    ...(overrides.dp_metadata !== undefined ? { dp_metadata: overrides.dp_metadata } : {})
  };
}

// ── buildBookingCreateHttpResponse ───────────────────────────────────────────

async function runBuilderTests() {
  await test('B01: legacy single-reservation shape matches existing wire contract', () => {
    const result = makeCanonicalResult({
      reservations: [makeReservation()],
      created_guest_ids: [],
      booking: { ...baseBooking(), guest_id: null, created_guest_ids: [] }
    });
    result.created_guest_ids = [];
    const { responseStatus, responseBody } = buildBookingCreateHttpResponse(result);
    assert.strictEqual(responseStatus, 201);
    assert.strictEqual(responseBody.status, 'SUCCESS');
    assert.strictEqual(responseBody.data.booking_id, 7);
    assert.strictEqual(responseBody.data.bid, 'BID-001');
    assert.strictEqual(responseBody.data.booking_status, 'ACTIVE');
    assert.strictEqual(responseBody.data.property_id, 3);
    assert.strictEqual(responseBody.data.guest_name, 'Budi');
    assert.strictEqual(responseBody.data.guest_phone, '081234');
    assert.strictEqual(responseBody.data.guest_id, null, 'guest_id falls back to null when no created ids');
    assert.deepStrictEqual(responseBody.data.created_guest_ids, []);
    assert.strictEqual(responseBody.data.booking_source, 'walkin');
    assert.strictEqual(responseBody.data.channel, 'WALK_IN');
    assert.strictEqual(responseBody.data.currency_code, 'IDR');
    assert.strictEqual(responseBody.data.reservations.length, 1);
    assert.strictEqual(responseBody.correlation_id, 'CORR-TEST-1');
    assert.ok(!('dp_metadata' in responseBody.data), 'legacy: no dp_metadata key when absent');
  });

  await test('B02: group reservation shape; guest_id = created_guest_ids[0] fallback', () => {
    const result = makeCanonicalResult({ booking: { ...baseBooking(), guest_id: null } });
    const { responseBody } = buildBookingCreateHttpResponse(result);
    assert.strictEqual(responseBody.data.reservations.length, 2);
    assert.deepStrictEqual(responseBody.data.created_guest_ids, [55, 56]);
    assert.strictEqual(responseBody.data.guest_id, 55, 'guest_id = created_guest_ids[0] when booking.guest_id null');
  });

  await test('B03: booking.guest_id takes precedence over created_guest_ids[0]', () => {
    const result = makeCanonicalResult({ booking: { ...baseBooking(), guest_id: 99 } });
    const { responseBody } = buildBookingCreateHttpResponse(result);
    assert.strictEqual(responseBody.data.guest_id, 99);
  });

  await test('B04: DP mode — dp_metadata is added additively, no other shape change', () => {
    const dpMeta = {
      deposit_id: 201, deposit_number: 'DP-001', deposit_amount: 500000,
      deposit_purpose: 'ADVANCE_PAYMENT', deposit_scope: 'BOOKING_GROUP',
      deposit_reservation_id: 101, deposit_method: 'CASH',
      deposit_idempotency_key: 'k-dp-1', deposit_replayed: false
    };
    const result = makeCanonicalResult({ dp_metadata: dpMeta });
    const { responseBody } = buildBookingCreateHttpResponse(result);
    assert.deepStrictEqual(responseBody.data.dp_metadata, dpMeta);
    assert.strictEqual(responseBody.status, 'SUCCESS', 'DP does not change status');
    assert.strictEqual(responseBody.data.booking_id, 7);
    assert.strictEqual(responseBody.data.reservations.length, 2, 'reservations shape unchanged by DP');
  });

  await test('B05: dp_metadata=null is not added (treated as absent)', () => {
    const result = makeCanonicalResult({ dp_metadata: null });
    const { responseBody } = buildBookingCreateHttpResponse(result);
    assert.ok(!('dp_metadata' in responseBody.data), 'null dp_metadata → key absent');
  });

  await test('B06: input is not mutated', () => {
    const result = makeCanonicalResult({ dp_metadata: { deposit_id: 1 } });
    const original = JSON.parse(JSON.stringify(result));
    buildBookingCreateHttpResponse(result);
    assert.deepStrictEqual(result, original, 'canonical result must not be mutated');
  });

  await test('B07: correlation_id is copied, never minted (stable across calls)', () => {
    const result = makeCanonicalResult({ correlationId: 'CORR-FIXED' });
    const a = buildBookingCreateHttpResponse(result);
    const b = buildBookingCreateHttpResponse(result);
    assert.strictEqual(a.responseBody.correlation_id, 'CORR-FIXED');
    assert.strictEqual(b.responseBody.correlation_id, 'CORR-FIXED');
  });

  await test('B08: result JSON-serializable (round-trips through JSON)', () => {
    const result = makeCanonicalResult();
    const { responseBody } = buildBookingCreateHttpResponse(result);
    const json = JSON.stringify(responseBody);
    assert.ok(typeof json === 'string' && json.length > 0);
    assert.deepStrictEqual(JSON.parse(json), responseBody, 'round-trips through JSON');
  });

  await test('B09: empty reservations array → 500 domain error', () => {
    const result = makeCanonicalResult({ reservations: [] });
    assert.throws(() => buildBookingCreateHttpResponse(result),
      e => e.code === 'BOOKING_CREATE_RESPONSE_INVALID' && e.statusCode === 500);
  });

  await test('B10: non-array reservations → 500 domain error', () => {
    const result = makeCanonicalResult({ reservations: 'oops' });
    assert.throws(() => buildBookingCreateHttpResponse(result),
      e => e.code === 'BOOKING_CREATE_RESPONSE_INVALID');
  });

  await test('B11: missing booking → 500 domain error', () => {
    const result = makeCanonicalResult();
    delete result.booking;
    assert.throws(() => buildBookingCreateHttpResponse(result),
      e => e.code === 'BOOKING_CREATE_RESPONSE_INVALID');
  });

  await test('B12: booking.id not a positive integer → 500 domain error', () => {
    const result = makeCanonicalResult({ booking: { ...baseBooking(), id: 0 } });
    assert.throws(() => buildBookingCreateHttpResponse(result),
      e => e.code === 'BOOKING_CREATE_RESPONSE_INVALID');
  });

  await test('B13: missing correlationId → 500 domain error', () => {
    const result = makeCanonicalResult();
    delete result.correlationId;
    assert.throws(() => buildBookingCreateHttpResponse(result),
      e => e.code === 'BOOKING_CREATE_RESPONSE_INVALID');
  });

  await test('B14: dp_metadata that is an array → 500 domain error', () => {
    const result = makeCanonicalResult({ dp_metadata: [1, 2] });
    assert.throws(() => buildBookingCreateHttpResponse(result),
      e => e.code === 'BOOKING_CREATE_RESPONSE_INVALID');
  });

  await test('B15: dp_metadata with non-plain object (class instance) → 500', () => {
    class Foo { constructor() { this.x = 1; } }
    const result = makeCanonicalResult({ dp_metadata: new Foo() });
    assert.throws(() => buildBookingCreateHttpResponse(result),
      e => e.code === 'BOOKING_CREATE_RESPONSE_INVALID');
  });
}

async function runSnapshotRegressionTests() {
  const invalid = e => e.statusCode === 500 && e.code === 'BOOKING_CREATE_RESPONSE_INVALID';
  await test('S01 Date values match existing JSON wire strings, input remains Date', () => {
    const date = new Date('2026-11-11T00:00:00.000Z');
    const result = makeCanonicalResult(); result.reservations[0].created_at = date;
    const body = buildBookingCreateHttpResponse(result).responseBody;
    assert.strictEqual(body.data.reservations[0].created_at, date.toISOString());
    assert.strictEqual(result.reservations[0].created_at, date);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(body)), body);
  });
  await test('S02 nested Buffer is rejected before a response can be stored/sent', () => {
    const result = makeCanonicalResult(); result.reservations[0].evidence = Buffer.from('proof');
    assert.throws(() => buildBookingCreateHttpResponse(result), invalid);
  });
  await test('S03 nested function value is rejected', () => {
    const result = makeCanonicalResult(); result.reservations[0].extra = () => 1;
    assert.throws(() => buildBookingCreateHttpResponse(result), invalid);
  });
  await test('S04 cyclic DP metadata is rejected as a domain error', () => {
    const meta = { deposit_id: 1 }; meta.self = meta;
    assert.throws(() => buildBookingCreateHttpResponse(makeCanonicalResult({ dp_metadata: meta })), invalid);
  });
  await test('S05 nested bigint is rejected before JSON serialization', () => {
    const result = makeCanonicalResult(); result.reservations[0].extra = 1n;
    assert.throws(() => buildBookingCreateHttpResponse(result), invalid);
  });
  await test('S06 nested Map does not silently become an empty JSON object', () => {
    const result = makeCanonicalResult(); result.reservations[0].extra = new Map([['x', 1]]);
    assert.throws(() => buildBookingCreateHttpResponse(result), invalid);
  });
  await test('S07 response snapshot is detached from subsequent canonical mutation', () => {
    const result = makeCanonicalResult({ dp_metadata: { deposit_amount: 10000 } });
    const body = buildBookingCreateHttpResponse(result).responseBody;
    result.reservations[0].guest_name = 'Changed'; result.dp_metadata.deposit_amount = 99999;
    assert.strictEqual(body.data.reservations[0].guest_name, 'Budi');
    assert.strictEqual(body.data.dp_metadata.deposit_amount, 10000);
  });
  await test('S08 undefined object fields match JSON omission', () => {
    const result = makeCanonicalResult(); result.reservations[0].optional = undefined;
    const body = buildBookingCreateHttpResponse(result).responseBody;
    assert.ok(!Object.hasOwn(body.data.reservations[0], 'optional'));
  });
  await test('S09 undefined array entries match JSON null slots', () => {
    const result = makeCanonicalResult(); result.reservations[0].extra = [undefined, 0, null];
    assert.deepStrictEqual(buildBookingCreateHttpResponse(result).responseBody.data.reservations[0].extra, [null, 0, null]);
  });
  await test('S10 shared references are cloned, not mistaken for cycles', () => {
    const shared = { note: 'shared' }; const result = makeCanonicalResult({ dp_metadata: { extra: shared } });
    result.reservations[0].extra = shared;
    const body = buildBookingCreateHttpResponse(result).responseBody;
    assert.deepStrictEqual(body.data.reservations[0].extra, shared);
    assert.deepStrictEqual(body.data.dp_metadata.extra, shared);
    assert.notStrictEqual(body.data.reservations[0].extra, shared);
  });
  await test('G01 guest_id zero uses existing legacy fallback', () => {
    const result = makeCanonicalResult({ booking: { guest_id: 0 } });
    assert.strictEqual(buildBookingCreateHttpResponse(result).responseBody.data.guest_id, result.created_guest_ids[0]);
  });
  await test('G02 guest_id empty string uses existing legacy fallback', () => {
    const result = makeCanonicalResult({ booking: { guest_id: '' } });
    assert.strictEqual(buildBookingCreateHttpResponse(result).responseBody.data.guest_id, result.created_guest_ids[0]);
  });
}

// ── isBookingCreateRequest ────────────────────────────────────────────────────

async function runPredicateTests() {
  const cases = [
    ['POST', '/api/bookings', true, 'canonical'],
    ['POST', '/api/bookings/', true, 'trailing slash'],
    ['POST', '/API/bookings', true, 'case-insensitive path'],
    ['POST', '/Api/Bookings/', true, 'mixed case + trailing slash'],
    ['POST', '/API/BOOKINGS', true, 'all uppercase'],
    ['GET', '/api/bookings', false, 'GET not POST'],
    ['PUT', '/api/bookings', false, 'PUT not POST'],
    ['POST', '/api/reservations', false, 'different path'],
    ['POST', '/api/bookings/123', false, 'extra segment'],
    ['POST', '/api/bookings/123/', false, 'extra segment + trailing slash'],
    ['POST', '/api/bookings?x=1', false, 'query string NOT part of req.path — reject if caller passes full URL'],
    ['POST', '/api/', false, 'wrong path with slash'],
    ['POST', '/api', false, 'shorter path'],
    ['POST', '/api/bookings//', false, 'double trailing slash'],
    ['POST', '', false, 'empty path'],
    ['POST', null, false, 'null path'],
    ['POST', undefined, false, 'undefined path'],
    ['post', '/api/bookings', false, 'lowercase method not canonical'],
  ];
  for (const [method, path, expected, label] of cases) {
    await test('P: ' + label, () => {
      assert.strictEqual(isBookingCreateRequest(method, path), expected);
    });
  }
}

// ── buildLegacyBookingCacheKey ────────────────────────────────────────────────

async function runCacheKeyTests() {
  await test('K01: stable — same inputs produce same key', () => {
    const a = buildLegacyBookingCacheKey(3, 'abc-key');
    const b = buildLegacyBookingCacheKey(3, 'abc-key');
    assert.strictEqual(a, b);
  });

  await test('K02: property A ≠ property B for same raw key', () => {
    const kA = buildLegacyBookingCacheKey(1, 'same-key');
    const kB = buildLegacyBookingCacheKey(2, 'same-key');
    assert.notStrictEqual(kA, kB);
    assert.ok(kA.startsWith('leg-b1:1:'), 'A: ' + kA);
    assert.ok(kB.startsWith('leg-b1:2:'), 'B: ' + kB);
  });

  await test('K03: namespace distinct from DP/global keys (prefix leg-b1)', () => {
    const key = buildLegacyBookingCacheKey(1, 'x');
    assert.ok(key.startsWith('leg-b1:'), key);
    assert.strictEqual(key.split(':').pop().length, 64, 'sha256 hex64 tail');
  });

  await test('K04: raw key hash is lowercase SHA-256 of the exact header string', () => {
    const raw = 'Mixed-Case-Header_123 .key';
    const key = buildLegacyBookingCacheKey(10, raw);
    const expectedHash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
    assert.strictEqual(key, 'leg-b1:10:' + expectedHash);
  });

  await test('K05: null/undefined/empty/whitespace raw key → null (no cache)', () => {
    assert.strictEqual(buildLegacyBookingCacheKey(1, null), null);
    assert.strictEqual(buildLegacyBookingCacheKey(1, undefined), null);
    assert.strictEqual(buildLegacyBookingCacheKey(1, ''), null);
    assert.strictEqual(buildLegacyBookingCacheKey(1, '   '), null);
  });

  await test('K06: raw key preserved exactly (no trim/case normalization in hash input)', () => {
    const k1 = buildLegacyBookingCacheKey(1, '  Padded-Key ');
    const k2 = buildLegacyBookingCacheKey(1, '  Padded-Key '.trim());
    assert.notStrictEqual(k1, k2, 'different raw strings → different keys');
  });

  await test('K07: invalid propertyId (0, -1, 1.5, NaN, null, undefined, object, string) → throw', () => {
    for (const bad of [0, -1, 1.5, NaN, null, undefined, {}, '5']) {
      assert.throws(() => buildLegacyBookingCacheKey(bad, 'k'),
        e => e.code === 'BOOKING_LEGACY_CACHE_KEY_INVALID' && e.statusCode === 400,
        'propertyId=' + String(bad) + ' should throw');
    }
  });

  await test('K08: non-string raw key (number, object, array, boolean) → throw, NOT String(object)', () => {
    for (const bad of [123, { a: 1 }, ['x'], true]) {
      assert.throws(() => buildLegacyBookingCacheKey(1, bad),
        e => e.code === 'BOOKING_LEGACY_CACHE_KEY_INVALID' && e.statusCode === 400,
        'rawHeaderKey=' + String(bad) + ' should throw');
    }
  });

  await test('K09: no collision with DP-style or global key shapes', () => {
    const legacy = buildLegacyBookingCacheKey(5, 'dp-looking-key');
    assert.notStrictEqual(legacy, 'dp-5:dp-looking-key');
    assert.notStrictEqual(legacy, 'global:dp-looking-key');
  });
}

async function main() {
  console.log('=== buildBookingCreateHttpResponse ===');
  await runBuilderTests();
  await runSnapshotRegressionTests();
  console.log('=== isBookingCreateRequest ===');
  await runPredicateTests();
  console.log('=== buildLegacyBookingCacheKey ===');
  await runCacheKeyTests();
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed > 0 ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });

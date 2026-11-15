/* Executes production helper + extracted composer callbacks, without React/server/DB. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const frontend = path.resolve(__dirname, '..');
let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const cache = new Map();
function loadTs(filename) {
  filename = path.resolve(filename);
  if (cache.has(filename)) return cache.get(filename).exports;
  const source = fs.readFileSync(filename, 'utf8');
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  assert.equal(parsed.parseDiagnostics.length, 0, filename + ' parses');
  const m = new Module(filename, module);
  m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  cache.set(filename, m);
  const normalRequire = m.require.bind(m);
  m.require = name => {
    if (name.startsWith('.')) {
      const base = path.resolve(path.dirname(filename), name);
      const found = [base, base + '.ts'].find(p => fs.existsSync(p) && fs.statSync(p).isFile());
      if (found?.endsWith('.ts')) return loadTs(found);
    }
    return normalRequire(name);
  };
  m._compile(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText, filename);
  return m.exports;
}
const helper = loadTs(path.join(frontend, 'src/features/booking/quickBookingPayment.ts'));
const backend = loadTs(path.join(frontend, '../backend/src/domains/reservations/bookingPaymentIntentService.ts'));
const { buildQuickBookingStayFields } = loadTs(path.join(frontend, 'src/features/booking/dayUseInterval.ts'));
const modalPath = path.join(frontend, 'src/features/booking/QuickBookingModal.tsx');
const modalSource = fs.readFileSync(modalPath, 'utf8');
const modalAst = ts.createSourceFile(modalPath, modalSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
assert.equal(modalAst.parseDiagnostics.length, 0);
function callback(name, scope) {
  const matches = [];
  const visit = n => {
    if (ts.isVariableDeclaration(n) && n.name.getText(modalAst) === name) matches.push(n.initializer);
    ts.forEachChild(n, visit);
  };
  visit(modalAst); assert.equal(matches.length, 1, name);
  let expression = matches[0];
  if (ts.isCallExpression(expression)) expression = expression.arguments[0];
  assert.ok(ts.isArrowFunction(expression));
  const output = ts.transpileModule('const fn = ' + expression.getText(modalAst) + ';\nreturn fn;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function('scope', 'with (scope) {' + output + '}')(scope);
}
const input = (mode = 'PAY_BILL', extra = {}) => ({ mode, amountPaid: 250000, advanceAmount: 100000,
  paymentMethod: 'CASH', otaCollect: false, ...extra });
const base = () => ({ property_id: 1, guest_phone: '0812345', booking_channel: 'WALK_IN',
  payment_responsibility: 'HOTEL_COLLECT', reservations: [
    { room_id: 11, stay_type: 'OVERNIGHT', amount_paid: 19, payment_method: 'QRIS',
      initial_payment: { amount: 20 }, bukti_bayar_path: 'old-child-path' },
    { room_id: 12, stay_type: 'DAY_USE', start_at: '2026-11-11T22:00:00', end_at: '2026-11-12T02:00:00' },
  ], initial_payment: { amount: 99, payment_method: 'TRANSFER' }, amount_paid: 999,
  advance_amount: 123, bukti_bayar_path: 'old-root-path' });
const build = (mode, extra = {}) => helper.buildQuickBookingPaymentPayload(base(), input(mode, extra));
const responseBody = (attempt, extra = {}) => ({ status: 'SUCCESS', data: { booking_id: 21, bid: 'BID21',
  property_id: attempt.propertyId, reservations: [{ id: 41 }], ...(attempt.mode === 'ADVANCE_PAYMENT' ? {
    dp_metadata: { deposit_id: 31, deposit_amount: attempt.advanceAmount, deposit_purpose: 'ADVANCE_PAYMENT' },
  } : {}), ...extra }, correlation_id: 'server-correlation' });
const json = (body, status = 201) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const attempt = (mode = 'PAY_BILL', evidence = null) => helper.createQuickBookingAttempt(build(mode), evidence, () => 'fixed-key');

test('three user labels, PAY_BILL default order; no LUNAS/Piutang/Direct Bill shortcut', () => {
  assert.deepEqual(helper.QUICK_BOOKING_PAYMENT_OPTIONS.map(x => x.label), ['Bayar Tagihan', 'Uang Muka (DP)', 'Belum Bayar']);
});
for (const mode of ['PAY_BILL', 'ADVANCE_PAYMENT', 'UNPAID']) {
  test(mode + ' payload accepted by production backend normalizer', () => {
    const payload = build(mode);
    const intent = backend.normalizeBookingPaymentIntent(payload);
    assert.equal(intent.mode, mode); assert.equal(intent.legacy, false);
    assert.equal(intent.ordinaryAmount, mode === 'PAY_BILL' ? 250000 : 0);
    assert.equal(intent.advanceAmount, mode === 'ADVANCE_PAYMENT' ? 100000 : 0);
    assert.equal(payload.guest_phone, '0812345');
    assert.ok(payload.reservations.every(x => x.amount_paid === 0 && !('payment_method' in x) && !('initial_payment' in x)));
    assert.equal('initial_payment' in payload, false); assert.equal('bukti_bayar_path' in payload, false);
  });
  test(mode + ' has no mutation and preserves overnight/Day Use child business fields', () => {
    const original = base(), before = JSON.stringify(original);
    const payload = helper.buildQuickBookingPaymentPayload(original, input(mode));
    assert.equal(JSON.stringify(original), before);
    assert.equal(payload.reservations[0].stay_type, 'OVERNIGHT');
    assert.equal(payload.reservations[1].end_at, '2026-11-12T02:00:00');
  });
  test(mode + ' cash and remaining bill separate from DP custody', () => {
    const summary = helper.quickBookingPaymentSummary({ ...input(mode), grandTotal: 500000 });
    assert.equal(summary.ordinaryPaid, mode === 'PAY_BILL' ? 250000 : 0);
    assert.equal(summary.advanceReceived, mode === 'ADVANCE_PAYMENT' ? 100000 : 0);
    assert.equal(summary.remainingBill, mode === 'PAY_BILL' ? 250000 : 500000);
  });
  test(mode + ' OTA_COLLECT always produces zero hotel cash, no method/advance', () => {
    const payload = build(mode, { otaCollect: true });
    assert.equal(payload.payment_mode, 'UNPAID'); assert.equal(payload.amount_paid, 0);
    assert.equal('payment_method' in payload, false); assert.equal('advance_amount' in payload, false);
  });
}
for (const value of [-1, NaN, Infinity, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
  test('PAY_BILL rejects malformed/unsafe amount ' + value, () => assert.throws(() => build('PAY_BILL', { amountPaid: value })));
  test('DP rejects malformed/unsafe amount ' + value, () => assert.throws(() => build('ADVANCE_PAYMENT', { advanceAmount: value })));
}
test('DP zero is rejected', () => assert.throws(() => build('ADVANCE_PAYMENT', { advanceAmount: 0 })));
test('DP requires a supported selected method', () => assert.throws(() => build('ADVANCE_PAYMENT', { paymentMethod: '' })));
test('PAY_BILL zero is valid under optional rules', () => assert.equal(backend.normalizeBookingPaymentIntent(build('PAY_BILL', { amountPaid: 0 })).ordinaryAmount, 0));
test('PAY_BILL partial stays partial', () => assert.equal(backend.normalizeBookingPaymentIntent(build('PAY_BILL', { amountPaid: 17 })).ordinaryAmount, 17));
test('single child carries no second payment', () => {
  const original = base(); original.reservations = [original.reservations[0]];
  assert.equal(helper.buildQuickBookingPaymentPayload(original, input()).reservations[0].amount_paid, 0);
});
test('UNPAID ignores stale method/advance/root-child payment aliases', () => {
  const p = build('UNPAID'); assert.equal(p.payment_method, undefined); assert.equal(p.advance_amount, undefined);
  assert.equal(backend.normalizeBookingPaymentIntent(p).mode, 'UNPAID');
});
for (const mode of ['ADVANCE_PAYMENT', 'UNPAID']) test(mode + ' never auto-fills ordinary payment', () => {
  assert.equal(helper.nextQuickBookingOrdinaryAmount({ mode, otaCollect: false, isOta: false, touched: false, amountPaid: 500000, grandTotal: 600000 }), 0);
});
for (const [name, options, expected] of [
  ['walkin default', {}, 500000], ['OTA untouched', { isOta: true }, 0],
  ['OTA deliberate zero', { isOta: true, touched: true }, 0],
  ['partial', { touched: true, amountPaid: 200000 }, 200000],
  ['overpayment clamp', { touched: true, amountPaid: 600000 }, 500000],
  ['OTA voucher', { otaCollect: true, amountPaid: 600000 }, 0],
]) test('auto-sync ' + name, () => assert.equal(helper.nextQuickBookingOrdinaryAmount({ mode: 'PAY_BILL', otaCollect: false,
  isOta: false, touched: false, amountPaid: 0, grandTotal: 500000, ...options }), expected));

for (const method of ['CASH', 'TRANSFER', 'QRIS', 'DEBIT_CARD', 'CREDIT_CARD']) {
  test('evidence REQUIRED applies to positive ordinary and DP, including ' + method, () => {
    for (const mode of ['PAY_BILL', 'ADVANCE_PAYMENT']) assert.equal(helper.quickBookingPaymentIssues({ ...input(mode, { paymentMethod: method }),
      rules: { payment_evidence: 'REQUIRED' }, hasFile: false }).length, 1);
  });
}
test('UNPAID allowed under optional payment rules', () => assert.deepEqual(helper.quickBookingPaymentIssues({ ...input('UNPAID'), rules: {}, hasFile: false }), []));
for (const field of ['payment_method', 'payment_amount']) test('UNPAID respects required property rule ' + field, () => {
  assert.equal(helper.quickBookingPaymentIssues({ ...input('UNPAID'), rules: { [field]: 'REQUIRED' }, hasFile: false }).length, 1);
});
test('UNPAID not blocked by evidence-only rule', () => assert.deepEqual(helper.quickBookingPaymentIssues({ ...input('UNPAID'), rules: { payment_evidence: 'REQUIRED' }, hasFile: false }), []));
test('PAY_BILL zero optional does not require evidence', () => assert.deepEqual(helper.quickBookingPaymentIssues({ ...input('PAY_BILL', { amountPaid: 0 }), rules: { payment_evidence: 'REQUIRED' }, hasFile: false }), []));
test('OTA voucher requirement bypasses hotel payment rules only', () => {
  const p = { ...input('UNPAID', { otaCollect: true }), rules: { payment_method: 'REQUIRED', payment_amount: 'REQUIRED', payment_evidence: 'REQUIRED' } };
  assert.equal(helper.quickBookingPaymentIssues({ ...p, hasFile: false }).length, 1);
  assert.deepEqual(helper.quickBookingPaymentIssues({ ...p, hasFile: true }), []);
});
test('attempt snapshot detached from subsequent form mutation', () => {
  const payload = build('PAY_BILL'), frozen = helper.createQuickBookingAttempt(payload, null, () => 'k1');
  payload.guest_phone = 'changed'; payload.reservations[0].room_id = 999;
  assert.equal(JSON.parse(frozen.payloadJson).guest_phone, '0812345');
  assert.equal(JSON.parse(frozen.payloadJson).reservations[0].room_id, 11); assert.ok(Object.isFrozen(frozen));
});
test('hotel UNPAID cannot attach stale hotel file', () => assert.throws(() => attempt('UNPAID', new File(['x'], 'receipt.pdf'))));
test('OTA UNPAID accepts dedicated voucher file', () => {
  const payload = build('UNPAID'); payload.booking_channel = 'OTA'; payload.payment_responsibility = 'OTA_COLLECT';
  assert.ok(helper.createQuickBookingAttempt(payload, new File(['v'], 'voucher.pdf'), () => 'v1').evidence);
});
test('invalid property/key rejected before sending', () => {
  assert.throws(() => helper.createQuickBookingAttempt({ ...build('PAY_BILL'), property_id: '1' }, null));
  assert.throws(() => helper.createQuickBookingAttempt(build('PAY_BILL'), null, () => 'bad key'));
});
for (const mode of ['PAY_BILL', 'ADVANCE_PAYMENT', 'UNPAID']) test(mode + ' transport header/body and success binding', async () => {
  const a = attempt(mode); let calls = 0;
  const outcome = await helper.sendQuickBookingAttempt(a, async (url, init) => {
    calls++; assert.equal(url, '/api/bookings'); assert.equal(init.method, 'POST');
    assert.equal(init.headers['Idempotency-Key'], a.requestKey);
    assert.equal(JSON.parse(init.body.get('booking_payload')).request_key, a.requestKey);
    assert.equal(init.headers['Content-Type'], undefined); return json(responseBody(a));
  });
  assert.equal(calls, 1); assert.equal(outcome.kind, 'success');
});
test('lost response retries exact key/body/evidence bytes once, no automatic retry', async () => {
  const file = new File(['receipt-data'], 'receipt.pdf', { type: 'application/pdf' }); const a = attempt('ADVANCE_PAYMENT', file);
  const sent = [];
  const transport = async (_url, init) => {
    sent.push({ key: init.headers['Idempotency-Key'], body: init.body.get('booking_payload'),
      bytes: await init.body.get('payment_evidence').text() });
    if (sent.length === 1) throw new Error('response lost after COMMIT');
    return json(responseBody(a));
  };
  assert.equal((await helper.sendQuickBookingAttempt(a, transport)).kind, 'uncertain'); assert.equal(sent.length, 1);
  assert.equal((await helper.sendQuickBookingAttempt(a, transport)).kind, 'success');
  assert.deepEqual(sent[0], sent[1]);
});
test('concurrent calls for the same attempt have one transport', async () => {
  const a = attempt(); let release; let calls = 0;
  const transport = async () => { calls++; await new Promise(r => { release = r; }); return json(responseBody(a)); };
  const one = helper.sendQuickBookingAttempt(a, transport), two = helper.sendQuickBookingAttempt(a, transport);
  assert.equal(one, two); assert.equal(calls, 1); release(); await Promise.all([one, two]);
});
for (const [name, res] of [
  ['HTML 502', () => new Response('<html>gateway</html>', { status: 502 })],
  ['500', () => json({ status: 'ERROR', message: 'unknown commit' }, 500)],
  ['202', () => json({ status: 'IN_PROGRESS' }, 202)],
  ['409 pending', () => json({ status: 'FAILED', code: 'BOOKING_CREATE_REQUEST_INCOMPLETE' }, 409)],
  ['409 mismatch', () => json({ status: 'FAILED', code: 'BOOKING_CREATE_REPLAY_MISMATCH' }, 409)],
  ['schema not ready', () => json({ status: 'ERROR', code: 'BOOKING_CREATE_REPLAY_NOT_READY' }, 503)],
  ['wrong property', a => json(responseBody(a, { property_id: 2 }))],
  ['string booking ID', a => json(responseBody(a, { booking_id: '21' }))],
  ['missing reservations', a => json(responseBody(a, { reservations: [] }))],
  ['invalid JSON success', () => new Response('not-json', { status: 201 })],
]) test('unconfirmed response freezes attempt: ' + name, async () => {
  const a = attempt(); assert.equal((await helper.sendQuickBookingAttempt(a, async () => res(a))).kind, 'uncertain');
});
test('DP success missing DP metadata is uncertain', async () => {
  const a = attempt('ADVANCE_PAYMENT'); assert.equal((await helper.sendQuickBookingAttempt(a, async () => json(responseBody(a, { dp_metadata: undefined })))).kind, 'uncertain');
});
test('DP response wrong amount is uncertain', async () => {
  const a = attempt('ADVANCE_PAYMENT'); const b = responseBody(a); b.data.dp_metadata.deposit_amount++;
  assert.equal((await helper.sendQuickBookingAttempt(a, async () => json(b))).kind, 'uncertain');
});
for (const id of ['1', '2', '9223372036854775807', 2]) test('DP JSON 201 accepts canonical deposit identifier without rounding: ' + id, async () => {
  const a = attempt('ADVANCE_PAYMENT'); const body = responseBody(a); body.data.dp_metadata.deposit_id = id;
  assert.equal((await helper.sendQuickBookingAttempt(a, async () => json(body))).kind, 'success');
  assert.equal(body.data.dp_metadata.deposit_id, id);
});
for (const id of ['0', '00', '01', '-1', '1.2', '1e3', ' 2 ', '+2', '9223372036854775808', '', null, {}, [], true, 0, Number.MAX_SAFE_INTEGER + 1]) {
  test('DP JSON rejects invalid/out-of-range identifier: ' + JSON.stringify(id), async () => {
    const a = attempt('ADVANCE_PAYMENT'); const body = responseBody(a); body.data.dp_metadata.deposit_id = id;
    assert.equal((await helper.sendQuickBookingAttempt(a, async () => json(body))).kind, 'uncertain');
  });
}
test('DP monetary amount remains strictly numeric and bound to the attempt', async () => {
  const a = attempt('ADVANCE_PAYMENT'); const body = responseBody(a); body.data.dp_metadata.deposit_id = '2'; body.data.dp_metadata.deposit_amount = '100000';
  assert.equal((await helper.sendQuickBookingAttempt(a, async () => json(body))).kind, 'uncertain');
});
test('pending snapshot retains identical object, payload, file/key across modal unmount', () => {
  const a = attempt('ADVANCE_PAYMENT', new File(['proof'], 'proof.pdf'));
  helper.rememberQuickBookingAttempt(a); const reopened = helper.pendingQuickBookingAttempt(1);
  assert.equal(reopened, a); assert.equal(reopened.evidence, a.evidence); assert.equal(reopened.payloadJson, a.payloadJson);
  assert.equal(reopened.requestKey, a.requestKey);
});
test('a new attempt cannot replace an unresolved property attempt', () => {
  const a = attempt(); helper.rememberQuickBookingAttempt(a);
  const other = helper.createQuickBookingAttempt(build('PAY_BILL'), null, () => 'other-key');
  assert.throws(() => helper.rememberQuickBookingAttempt(other));
  helper.finishQuickBookingAttempt(other); assert.equal(helper.pendingQuickBookingAttempt(1), a);
});
test('resolved attempt is removed and another property remains isolated', () => {
  const a = attempt(); const second = helper.createQuickBookingAttempt({ ...build('PAY_BILL'), property_id: 2 }, null, () => 'property-2');
  helper.rememberQuickBookingAttempt(a); helper.rememberQuickBookingAttempt(second); helper.finishQuickBookingAttempt(a);
  assert.equal(helper.pendingQuickBookingAttempt(1), null); assert.equal(helper.pendingQuickBookingAttempt(2), second);
});
test('unload warning stays until the last retained attempt is resolved', () => {
  const oldWindow = global.window; const events = [];
  global.window = { addEventListener: (name, fn) => events.push(['add', name, fn]), removeEventListener: (name, fn) => events.push(['remove', name, fn]) };
  try {
    const a = attempt(); helper.rememberQuickBookingAttempt(a); helper.rememberQuickBookingAttempt(a);
    assert.equal(events.length, 1); let prevented = false; const event = { preventDefault() { prevented = true; }, returnValue: null };
    events[0][2](event); assert.equal(prevented, true); assert.equal(event.returnValue, '');
    helper.finishQuickBookingAttempt(a); assert.equal(events.length, 2); assert.equal(events[0][2], events[1][2]);
  } finally { global.window = oldWindow; }
});
for (const status of [400, 401, 403, 404, 413, 415, 422]) test('confirmed input/auth error permits editing: ' + status, async () => {
  assert.equal((await helper.sendQuickBookingAttempt(attempt(), async () => json({ status: 'ERROR', message: 'rejected' }, status))).kind, 'rejected');
});
test('known room overlap is a terminal rejection', async () => {
  assert.equal((await helper.sendQuickBookingAttempt(attempt(), async () => json({ status: 'CONFLICT', code: 'ROOM_OVERLAP' }, 409))).kind, 'rejected');
});

function composer(transport) {
  const scope = {
    ...helper, buildQuickBookingStayFields, toBackendDiscountType: () => 'FIXED',
    isOpen: true, propertyId: 1, activePropertyRef: { current: 1 }, channelType: 'WALKIN',
    walkinSubSource: 'DIRECT', otaSources: [], selectedOtaSourceId: null, selectedOtaSourceName: '',
    guestName: 'Guest', guestPhone: '0812345', guestSegment: 'Reguler', selectedCrmGuest: null,
    duplicateBypassed: true, sameAsBooker: true, bookerName: '', bookerPhone: '', referral: '',
    ktpPath: null, identityNumber: '', hasValidIdentity: false, extractedKtpData: null,
    paymentMode: 'PAY_BILL', amountPaid: 250000, advanceAmount: 100000, paymentMethod: 'CASH',
    otaCollect: false, paymentResponsibility: 'HOTEL_COLLECT', buktiBayarFile: null, specialRequests: '',
    globalDiscountType: 'NOMINAL', globalDiscountValue: 0, globalDiscountReason: '',
    rulesLoading: false, rulesLoadError: null, isValid: true, validationIssues: [],
    attemptRef: { current: null }, submitGuardRef: { current: false }, completedRef: { current: false },
    isPaymentTouchedRef: { current: false }, submitting: false, requestLocked: false, errorMsg: null,
    useCallback: fn => fn, closeCount: 0, successCount: 0, recoveringAttempt: false,
    roomsList: [{ roomId: 11, roomTypeId: 1, stayType: 'DAY_USE', checkIn: '2026-11-11', checkOut: '2026-11-11',
      dayUseStartTime: '22:00', dayUseHours: 4, ratePlanId: 2, isManualOverride: false, stayCharges: [] }],
    roomCalculations: [{ roomCharge: 500000, stayChargesTotal: 0 }],
    authenticatedFetch: transport,
  };
  for (const [setter, value] of Object.entries({ setSubmitting: 'submitting', setRequestLocked: 'requestLocked', setErrorMsg: 'errorMsg',
    setAmountPaid: 'amountPaid', setAdvanceAmount: 'advanceAmount', setPaymentMode: 'paymentMode', setBuktiBayarFile: 'buktiBayarFile',
    setPaymentResponsibility: 'paymentResponsibility', setChannelType: 'channelType', setRecoveringAttempt: 'recoveringAttempt' })) scope[setter] = v => { scope[value] = v; };
  scope.onClose = () => { scope.closeCount++; }; scope.onBookingSuccess = () => { scope.successCount++; };
  for (const name of ['clearPaymentDraft', 'handlePaymentModeChange', 'handlePaymentResponsibilityChange', 'handleChannelTypeChange',
    'handleClose', 'resetQuickBookingState', 'submitAttempt', 'handleSubmit']) scope[name] = callback(name, scope);
  return scope;
}
const event = { preventDefault() {} };
for (const mode of ['PAY_BILL', 'ADVANCE_PAYMENT', 'UNPAID']) test('actual handleSubmit uses explicit ' + mode + ' payload and unchanged Day Use serializer', async () => {
  let sent;
  const c = composer(async (_url, init) => { sent = JSON.parse(init.body.get('booking_payload'));
    return json(responseBody({ propertyId: 1, mode, advanceAmount: 100000 })); });
  c.paymentMode = mode; await c.handleSubmit(event);
  assert.equal(sent.payment_mode, mode); assert.equal(backend.normalizeBookingPaymentIntent(sent).mode, mode);
  assert.equal(sent.reservations[0].start_at, '2026-11-11T22:00:00');
  assert.equal(sent.reservations[0].end_at, '2026-11-12T02:00:00');
  assert.equal(c.successCount, 1); assert.equal(c.closeCount, 1); assert.equal(c.completedRef.current, true);
});
test('actual double click and post-success click cannot create twice', async () => {
  let release, calls = 0;
  const c = composer(async () => { calls++; await new Promise(r => { release = r; }); return json(responseBody({ propertyId: 1, mode: 'PAY_BILL' })); });
  const first = c.handleSubmit(event); const second = c.handleSubmit(event); assert.equal(calls, 1);
  release(); await Promise.all([first, second]); await c.handleSubmit(event); assert.equal(calls, 1);
});
test('actual retry bypasses fresh validation and preserves frozen payload after lost response', async () => {
  const sent = []; const c = composer(async (_url, init) => { sent.push(init.body.get('booking_payload'));
    if (sent.length === 1) throw new Error('lost'); return json(responseBody({ propertyId: 1, mode: 'PAY_BILL' })); });
  await c.handleSubmit(event); assert.equal(c.requestLocked, true); c.handleClose(); assert.equal(c.closeCount, 1); assert.equal(helper.pendingQuickBookingAttempt(1), c.attemptRef.current);
  c.resetQuickBookingState(); assert.ok(c.attemptRef.current);
  c.amountPaid = 999; c.roomsList[0].dayUseStartTime = '10:00'; c.isValid = false; c.rulesLoadError = 'offline';
  await c.handleSubmit(event); assert.equal(sent.length, 2); assert.equal(sent[0], sent[1]); assert.equal(c.requestLocked, false);
});
test('actual committed DP string ID closes, refreshes once and clears retained attempt', async () => {
  const c = composer(async () => json(responseBody({ propertyId: 1, mode: 'ADVANCE_PAYMENT', advanceAmount: 100000 }, {
    dp_metadata: { deposit_id: '2', deposit_amount: 100000, deposit_purpose: 'ADVANCE_PAYMENT' },
  })));
  c.paymentMode = 'ADVANCE_PAYMENT'; await c.handleSubmit(event);
  assert.equal(c.completedRef.current, true); assert.equal(c.closeCount, 1); assert.equal(c.successCount, 1);
  assert.equal(c.requestLocked, false); assert.equal(helper.pendingQuickBookingAttempt(1), null);
});
test('actual close while uncertain retains attempt; remounted callback checks the same key once', async () => {
  const sent = []; const first = composer(async (_url, init) => { sent.push(init.headers['Idempotency-Key']); throw new Error('lost'); });
  first.paymentMode = 'ADVANCE_PAYMENT'; await first.handleSubmit(event); const frozen = first.attemptRef.current;
  first.handleClose(); assert.equal(first.closeCount, 1); assert.equal(helper.pendingQuickBookingAttempt(1), frozen);
  const reopened = composer(async (_url, init) => { sent.push(init.headers['Idempotency-Key']); return json(responseBody(frozen, {
    dp_metadata: { deposit_id: '2', deposit_amount: frozen.advanceAmount, deposit_purpose: 'ADVANCE_PAYMENT' },
  })); });
  reopened.attemptRef.current = frozen; reopened.requestLocked = true; reopened.recoveringAttempt = true;
  await reopened.handleSubmit(event); assert.deepEqual(sent, [frozen.requestKey, frozen.requestKey]);
  assert.equal(reopened.successCount, 1); assert.equal(helper.pendingQuickBookingAttempt(1), null);
});
test('a second stale composer switches to recovery before sending a different draft', async () => {
  const first = composer(async () => { throw new Error('lost'); }); await first.handleSubmit(event);
  let calls = 0; const stale = composer(async () => { calls++; }); await stale.handleSubmit(event);
  assert.equal(calls, 0); assert.equal(stale.recoveringAttempt, true); assert.equal(stale.attemptRef.current, first.attemptRef.current);
});
test('in-flight close is held only until the active network response returns', async () => {
  let release; const c = composer(async () => { await new Promise(r => { release = r; }); throw new Error('lost'); });
  const sending = c.handleSubmit(event); c.handleClose(); assert.equal(c.closeCount, 0);
  release(); await sending; c.handleClose(); assert.equal(c.closeCount, 1);
});
test('property switch cannot replay an unresolved request into another property', async () => {
  let calls = 0; const c = composer(async () => { calls++; throw new Error('lost'); });
  await c.handleSubmit(event); c.propertyId = 2; await c.handleSubmit(event); assert.equal(calls, 1);
});
test('confirmed rejection unlocks editing and next intentional attempt gets a new key', async () => {
  const keys = []; const c = composer(async (_url, init) => { keys.push(init.headers['Idempotency-Key']);
    return json({ status: 'ERROR', message: 'invalid input' }, 400); });
  await c.handleSubmit(event); assert.equal(c.attemptRef.current, null); assert.equal(c.requestLocked, false);
  c.amountPaid = 100; await c.handleSubmit(event); assert.notEqual(keys[0], keys[1]);
});
test('fresh invalid/rules-unavailable cannot send', async () => {
  let calls = 0; const c = composer(async () => { calls++; });
  c.rulesLoading = true; await c.handleSubmit(event); c.rulesLoading = false; c.isValid = false;
  await c.handleSubmit(event); assert.equal(calls, 0);
});
test('property changes during duplicate lookup abort before booking POST', async () => {
  const c = composer(async url => { assert.equal(url, '/api/guests/duplicate-check');
    c.activePropertyRef.current = 2; return json({ data: { has_duplicate: false } }, 200); });
  c.duplicateBypassed = false; await c.handleSubmit(event); assert.equal(c.attemptRef.current, null); assert.match(c.errorMsg, /Properti berubah/);
});
for (const mode of ['PAY_BILL', 'ADVANCE_PAYMENT', 'UNPAID']) test('actual mode change clears stale amount/DP/evidence to ' + mode, () => {
  const c = composer(); c.buktiBayarFile = new File(['old'], 'old.pdf'); c.handlePaymentModeChange(mode);
  assert.equal(c.amountPaid, 0); assert.equal(c.advanceAmount, 0); assert.equal(c.buktiBayarFile, null); assert.equal(c.paymentMode, mode);
});
test('actual OTA collect/hotel collect transition clears voucher vs receipt and amounts', () => {
  const c = composer(); c.buktiBayarFile = new File(['r'], 'receipt.pdf'); c.handlePaymentResponsibilityChange('OTA_COLLECT');
  assert.equal(c.paymentMode, 'UNPAID'); assert.equal(c.buktiBayarFile, null);
  c.buktiBayarFile = new File(['v'], 'voucher.pdf'); c.handlePaymentResponsibilityChange('HOTEL_COLLECT');
  assert.equal(c.paymentMode, 'PAY_BILL'); assert.equal(c.buktiBayarFile, null); assert.equal(c.amountPaid, 0);
});
test('actual OTA to WALKIN clears inherited OTA collect responsibility', () => {
  const c = composer(); c.channelType = 'OTA'; c.paymentResponsibility = 'OTA_COLLECT'; c.buktiBayarFile = new File(['v'], 'voucher.pdf');
  c.handleChannelTypeChange('WALKIN'); assert.equal(c.paymentResponsibility, 'HOTEL_COLLECT');
  assert.equal(c.channelType, 'WALKIN'); assert.equal(c.buktiBayarFile, null);
});
test('actual hotel collect channel transition preserves intentional partial/zero ordinary amount', () => {
  for (const amount of [0, 170000]) {
    const c = composer(); c.amountPaid = amount; c.isPaymentTouchedRef.current = true;
    c.handleChannelTypeChange('OTA'); assert.equal(c.amountPaid, amount);
    assert.equal(c.paymentResponsibility, 'HOTEL_COLLECT');
  }
});
test('wiring: controlled mode, protected close, inert fields, recovery button and unload warning', () => {
  for (const text of ['value={effectivePaymentMode}', 'disabled={otaCollect}', 'onClick={handleClose}',
    'inert={submitting || requestLocked}', 'Coba Lagi — Periksa Pengiriman', 'Tutup Sementara',
    'key={channelType + effectivePaymentMode + paymentResponsibility}']) assert.ok(modalSource.includes(text), text);
  assert.ok(!modalSource.includes('onClick={onClose}'));
  assert.ok(!modalSource.includes('Nominal Dibayar (DP / Lunas)'));
});
function renderComposer(overrides) {
  const stateNames = [];
  const collect = n => {
    if (ts.isVariableDeclaration(n) && ts.isArrayBindingPattern(n.name) && n.initializer &&
      ts.isCallExpression(n.initializer) && n.initializer.expression.getText(modalAst) === 'useState') {
      stateNames.push(n.name.elements[0].getText(modalAst));
    }
    ts.forEachChild(n, collect);
  };
  collect(modalAst); let index = 0;
  const react = { __esModule: true, default: {}, useState(initial) {
    const name = stateNames[index++];
    const value = Object.hasOwn(overrides, name) ? overrides[name] : typeof initial === 'function' ? initial() : initial;
    return [value, () => {}];
  }, useMemo: fn => fn(), useCallback: fn => fn, useEffect() {}, useRef: initial => ({ current: initial }) };
  const jsx = (type, props) => ({ type, props: props || {} });
  const m = new Module(modalPath, module); m.filename = modalPath;
  m.require = name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
    if (name.startsWith('.')) {
      const base = path.resolve(path.dirname(modalPath), name);
      const file = [base, base + '.ts'].find(p => fs.existsSync(p) && fs.statSync(p).isFile());
      if (file) return loadTs(file);
      return new Proxy({ __esModule: true, default: () => null }, { get: (target, key) => target[key] || (() => null) });
    }
    throw new Error('Unexpected render dependency ' + name);
  };
  m._compile(ts.transpileModule(modalSource, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, modalPath);
  const tree = m.exports.default({ isOpen: true, propertyId: 1, rooms: [], roomTypes: [], onClose() {}, onBookingSuccess() {} });
  const elements = [], text = [];
  function visit(node) {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node && typeof node === 'object' && node.props) { elements.push(node); visit(node.props.children); }
    else if (typeof node === 'string' || typeof node === 'number') text.push(String(node));
  }
  visit(tree);
  return { elements, text: text.join(' ') };
}
for (const mode of ['PAY_BILL', 'ADVANCE_PAYMENT', 'UNPAID']) test('actual JSX render has one mode dropdown and appropriate payment fields: ' + mode, () => {
  const view = renderComposer({ paymentMode: mode, advanceAmount: 100000 });
  assert.equal(view.elements.filter(n => n.type === 'select' && n.props.id === 'quick-booking-payment-mode').length, 1);
  assert.equal(view.text.includes('Nominal Bayar Tagihan'), mode === 'PAY_BILL');
  assert.equal(view.text.includes('Nominal Uang Muka (DP)'), mode === 'ADVANCE_PAYMENT');
  const methods = view.elements.filter(n => n.type === 'select' && n.props.value === 'CASH');
  assert.equal(methods.length, mode === 'UNPAID' ? 0 : 1);
});
test('actual OTA Collect JSX disables hotel mode selector and keeps voucher upload', () => {
  const view = renderComposer({ channelType: 'OTA', paymentResponsibility: 'OTA_COLLECT', paymentMode: 'ADVANCE_PAYMENT' });
  const selector = view.elements.find(n => n.type === 'select' && n.props.id === 'quick-booking-payment-mode');
  assert.equal(selector.props.value, 'UNPAID'); assert.equal(selector.props.disabled, true);
  assert.match(view.text, /Upload Voucher/); assert.ok(!view.text.includes('Nominal Uang Muka (DP)'));
});
test('actual remounted JSX shows recovery instead of a new editable guest form', () => {
  const a = attempt('ADVANCE_PAYMENT'); helper.rememberQuickBookingAttempt(a);
  const view = renderComposer({});
  assert.match(view.text, /Periksa Pengiriman Reservasi/); assert.match(view.text, /Tutup Sementara/);
  assert.equal(view.elements.filter(n => n.type === 'select' && n.props.id === 'quick-booking-payment-mode').length, 0);
});
(async () => {
  for (const [name, fn] of tests) {
    try {
      for (const propertyId of [1, 2, 3]) { const pending = helper.pendingQuickBookingAttempt(propertyId); if (pending) helper.finishQuickBookingAttempt(pending); }
      await fn(); passed++; console.log('PASS ' + name); }
    catch (error) { console.error('FAIL ' + name, error); process.exitCode = 1; }
  }
  console.log('RESULT PASS=' + passed + ' FAIL=' + (tests.length - passed) + ' TOTAL=' + tests.length);
  console.log('DB-free production helper/callback tests; no React browser/full-workspace build claim.');
})();

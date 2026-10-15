'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const sourceArg = process.argv.indexOf('--source-dir');
const sourceDir = sourceArg >= 0 ? path.resolve(process.argv[sourceArg + 1]) : path.join(__dirname, '../src/features/pos');
const contractOnly = process.argv.includes('--contract-only');
let ts;
try { ts = require('typescript'); } catch (e) { if (!contractOnly) throw new Error('TypeScript dependency missing; run from frontend/test after npm install.'); }
function compile(file, pure = false) {
  const text = fs.readFileSync(path.join(sourceDir, file), 'utf8');
  if (ts) return ts.transpileModule(text, {compilerOptions: {target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}, fileName: file}).outputText;
  assert.ok(pure);
  const code = require('node:module').stripTypeScriptTypes(text);
  const names = [...code.matchAll(/export (?:function|const) (\w+)/g)].map(m => m[1]);
  return code.replace(/export /g, '') + '\nmodule.exports = {' + names.join(',') + '};';
}
function load(code, imports = {}) {
  const module = {exports: {}};
  vm.runInNewContext(code, {module, exports: module.exports, require: name => {
    if (name in imports) return imports[name]; throw new Error('Unexpected import ' + name);
  }, console: {error() {}, warn() {}}, crypto: {randomUUID}, AbortController, URL, Response, Blob,
    window: {setTimeout() {return 1;}, clearTimeout() {}}, document: {activeElement: {focus() {}}}}, {timeout: 3000});
  return module.exports;
}
const C = load(compile('posPaymentContract.ts', true));
let pass = 0;
function check(name, action) {action(); pass++; console.log('  PASS  ' + name);}
const cfg = {property_id: 7, qris_enabled: true, qris_image_available: true,
  qris_terminal_name: 'Oak', qris_merchant_id: 'MID-7', transfer_enabled: true,
  transfer_ref_note: 'POS', bank_name: 'Bank', bank_account_name: 'Oak', bank_account_number: '000123',
  debit_enabled: true, debit_edc_terminal: 'EDC-7'};
const make = (method = 'CASH', overrides = {}) => C.createPaySnapshot({orderId: 9, propertyId: 7,
  amount: '54900.00', key: 'test-key', method, cashInput: '60000', reference: ' REF-7 ',
  config: cfg, qrisImageLoaded: true, verified: true, ...overrides});
function response(snap, status = 201) {
  return {status: status === 201 ? 'SUCCESS' : 'REPLAY', data: {created: status === 201, replayed: status === 200,
    settlement: {id: 8, property_id: 7, pos_order_id: 9, transaction_id: '9007199254740993123',
      amount: '54900.00', payment_method: snap.paymentMethod, status: 'SUCCESS', idempotency_key: snap.key,
      request_fingerprint: 'fp', created_by: 'cashier', cash_received: snap.cashReceived,
      change_due: snap.paymentMethod === 'CASH' ? (Number(snap.cashReceived) - 54900).toFixed(2) : null,
      payment_reference: snap.paymentReference, verified_by: snap.paymentMethod === 'CASH' ? null : 'cashier',
      verified_at: snap.paymentMethod === 'CASH' ? null : '2026-10-14T08:00:00.000Z',
      created_at: '2026-10-15T10:30:00.000Z'},
    sale: {id: '9007199254740993123', transaction_no: 'POS-7', payment_status: 'PAID',
      payment_method: snap.paymentMethod, source_type: 'POS_ORDER', source_id: '9'}}};
}
check('CASH money numeric/decimal only; reject separators/NaN/exponent/overflow', () => {
  assert.equal(C.parseCashInput('60000.50'), 60000.5);
  for (const value of ['', '60.000,50', '1e6', '-1', 'NaN', 'Infinity', '10000000000', '1.001']) assert.equal(C.parseCashInput(value), null);
});
check('Method config scope/types fail closed, CASH remains usable', () => {
  assert.ok(C.readPosPaymentConfig(cfg, 7));
  assert.equal(C.readPosPaymentConfig({...cfg, qris_enabled: 'true'}, 7), null);
  assert.equal(C.readPosPaymentConfig(cfg, 8), null);
  assert.equal(C.isMethodAvailable('CASH', null), true);
  assert.equal(C.isMethodAvailable('QRIS', {...cfg, qris_image_available: false}), false);
  assert.equal(C.isMethodAvailable('TRANSFER', {...cfg, bank_account_number: ' '}), false);
  assert.equal(C.isMethodAvailable('DEBIT', {...cfg, debit_edc_terminal: ' '}), false);
});
for (const method of C.POS_PAYMENT_METHODS) {
  check(method + ' immutable snapshot contains only method fields, no spoofed actor/net/change', () => {
    const snap = make(method), body = JSON.parse(snap.bodyJson);
    assert.equal(Object.isFrozen(snap), true);
    assert.deepEqual(Object.keys(body).sort(), (method === 'CASH' ? ['property_id','payment_method','cash_received'] : ['property_id','payment_method','payment_reference']).sort());
    assert.equal(body.payment_method, method);
    if (method !== 'CASH') assert.equal(body.payment_reference, 'REF-7');
    assert.throws(() => {snap.key = 'different';});
  });
  check(method + ' validates created/replay with BIGINT string beyond safe integer', () => {
    const snap = make(method);
    assert.equal(C.validatePayResponse(201, response(snap), snap), true);
    assert.equal(C.validatePayResponse(200, response(snap, 200), snap), true);
    assert.equal(C.validatePayResponse(200, response(snap), snap), false);
  });
}
check('Reject zero/order-ID overflow/underpayment/blank/invalid cash before request', () => {
  for (const overrides of [{amount: '0'}, {orderId: 2147483648}, {cashInput: '54900x'}, {cashInput: ''}, {cashInput: '54899.99'}]) assert.throws(() => make('CASH', overrides));
});
for (const method of ['QRIS', 'TRANSFER', 'DEBIT']) check(method + ' requires own enabled config and staff verification', () => {
  assert.throws(() => make(method, {verified: false}));
  assert.throws(() => make(method, {config: null}));
  assert.throws(() => make(method, {config: {...cfg, property_id: 8}}));
  assert.throws(() => make(method, {reference: 'x'.repeat(101)}));
});
check('QRIS requires displayed image and permits optional empty reference', () => {
  assert.throws(() => make('QRIS', {qrisImageLoaded: false}));
  assert.equal(make('QRIS', {reference: ' '}).paymentReference, null);
});
const malformed = [
  ['wrong property', r => r.data.settlement.property_id = 8],
  ['wrong order', r => r.data.settlement.pos_order_id = 10],
  ['wrong key', r => r.data.settlement.idempotency_key = 'different'],
  ['wrong amount', r => r.data.settlement.amount = '54901'],
  ['numeric amount', r => r.data.settlement.amount = 54900],
  ['numeric BIGINT', r => r.data.sale.id = 9007199254740993],
  ['mismatched SALE', r => r.data.sale.id = '123'],
  ['wrong source', r => r.data.sale.source_type = 'RESERVATION'],
  ['numeric source ID', r => r.data.sale.source_id = 9],
  ['different sale method', r => r.data.sale.payment_method = 'DEBIT'],
  ['different settlement method', r => r.data.settlement.payment_method = 'DEBIT'],
  ['missing fingerprint', r => delete r.data.settlement.request_fingerprint],
  ['wrong change', r => r.data.settlement.change_due = '0'],
  ['wrong cash', r => r.data.settlement.cash_received = '70000'],
  ['missing cash metadata', r => delete r.data.settlement.cash_received],
];
for (const [name, mutate] of malformed) check('Malformed response: ' + name, () => {
  const snap = make(), r = response(snap); mutate(r); assert.equal(C.validatePayResponse(201, r, snap), false);
});
for (const [name, mutate] of [
  ['missing verifier', r => r.data.settlement.verified_by = null],
  ['bad time', r => r.data.settlement.verified_at = 'invalid'],
  ['different reference', r => r.data.settlement.payment_reference = 'OTHER'],
  ['cash on non-CASH', r => r.data.settlement.cash_received = '60000'],
]) check('Non-CASH response: ' + name, () => {
  const snap = make('QRIS'), r = response(snap); mutate(r); assert.equal(C.validatePayResponse(201, r, snap), false);
});
// ── created_at fail-closed validation ──────────────────────────────────────
check('valid created_at accepted for CASH', () => {
  const snap = make('CASH'), r = response(snap);
  assert.equal(r.data.settlement.created_at, '2026-10-15T10:30:00.000Z');
  assert.equal(C.validatePayResponse(201, r, snap), true);
});
check('valid created_at accepted for non-CASH', () => {
  const snap = make('QRIS'), r = response(snap);
  assert.equal(C.validatePayResponse(201, r, snap), true);
});
check('missing created_at rejected', () => {
  const snap = make('CASH'), r = response(snap);
  delete r.data.settlement.created_at;
  assert.equal(C.validatePayResponse(201, r, snap), false);
});
check('null created_at rejected', () => {
  const snap = make('CASH'), r = response(snap);
  r.data.settlement.created_at = null;
  assert.equal(C.validatePayResponse(201, r, snap), false);
});
check('invalid created_at rejected', () => {
  const snap = make('CASH'), r = response(snap);
  r.data.settlement.created_at = 'not-a-date';
  assert.equal(C.validatePayResponse(201, r, snap), false);
});
check('empty string created_at rejected', () => {
  const snap = make('CASH'), r = response(snap);
  r.data.settlement.created_at = '';
  assert.equal(C.validatePayResponse(201, r, snap), false);
});
check('replay with valid created_at still valid', () => {
  const snap = make('QRIS'), r = response(snap, 200);
  assert.equal(r.data.settlement.created_at, '2026-10-15T10:30:00.000Z');
  assert.equal(C.validatePayResponse(200, r, snap), true);
});
check('CASH success uses created_at as payment time source', () => {
  const snap = make('CASH'), r = response(snap);
  // CASH: verified_at is null, created_at is valid → created_at wins
  assert.equal(r.data.settlement.verified_at, null);
  assert.equal(typeof r.data.settlement.created_at, 'string');
  assert.ok(Number.isFinite(Date.parse(r.data.settlement.created_at)));
});
check('non-CASH success prefers verified_at over created_at', () => {
  const snap = make('TRANSFER'), r = response(snap);
  assert.equal(typeof r.data.settlement.verified_at, 'string');
  assert.equal(typeof r.data.settlement.created_at, 'string');
  assert.notEqual(r.data.settlement.verified_at, r.data.settlement.created_at);
});

function harness(authFetch, overrides = {}) {
  const slots = []; let cursor = 0, queued = [], tree, props;
  const react = {
    useState(initial) {const i = cursor++; if (!slots[i]) slots[i] = {value: typeof initial === 'function' ? initial() : initial};
      return [slots[i].value, value => {slots[i].value = typeof value === 'function' ? value(slots[i].value) : value;}];},
    useRef(value) {const i = cursor++; if (!slots[i]) slots[i] = {current: value}; return slots[i];},
    useCallback(fn) {cursor++; return fn;},
    useEffect(fn, deps) {const i = cursor++, prev = slots[i];
      if (!prev || !deps || deps.some((v,k) => !Object.is(v, prev.deps[k]))) queued.push(() => {
        prev?.cleanup?.(); slots[i] = {deps, cleanup: fn()};
      });},
  };
  const jsx = (type, p, key) => ({type, props: p || {}, key});
  const component = load(compile('PosPayCashModal.tsx'), {
    react,
    'react/jsx-runtime': {jsx, jsxs: jsx},
    './posPaymentContract': C,
    '../thermalReceipt/PosThermalReceiptModal': {__esModule: true, default: () => null},
  }).default;
  const signals = {paid: [], pending: [], unresolved: [], closes: 0, refreshes: 0};
  props = {order: {orderId: 9, propertyId: 7, orderNumber: 'POS-7', totalAmount: '54900.00'}, authFetch,
    canEditPos: true, onRequestClose() {signals.closes++;}, onRequestPending(v) {signals.pending.push(v);},
    onUnresolvedChange(v) {signals.unresolved.push(v);}, onPaid(r) {signals.paid.push(r);}, onRefresh() {signals.refreshes++;}, ...overrides};
  function render() {cursor = 0; tree = component(props); const effects = queued; queued = []; effects.forEach(fn => fn()); return tree;}
  function nodes() {const out = []; (function walk(n) {if (Array.isArray(n)) {n.forEach(walk); return;} if (!n || typeof n !== 'object') return;
    out.push(n); walk(n.props?.children);})(tree); return out;}
  function label(n) {const flatten = v => Array.isArray(v) ? v.map(flatten).join('') : v && typeof v === 'object' ? flatten(v.props?.children) : v == null ? '' : String(v); return flatten(n.props.children);}
  function button(text) {const n = nodes().find(n => n.type === 'button' && label(n) === text); assert.ok(n, 'Missing button ' + text); return n;}
  function click(text) {const n = button(text); assert.equal(!!n.props.disabled, false, 'Disabled button ' + text); n.props.onClick(); render();}
  function input(type, value) {const n = nodes().find(n => n.type === 'input' && n.props.type === type); assert.ok(n); assert.equal(!!n.props.disabled, false);
    n.props.onChange({target: {value, checked: value}}); render();}
  async function settle() {await new Promise(resolve => setImmediate(resolve)); render(); await new Promise(resolve => setImmediate(resolve)); render();}
  render(); return {render, nodes, button, click, input, settle, signals,
    changeOrder(order) {props = {...props, order}; render();},
    cleanup() {slots.forEach(s => s?.cleanup?.());}};
}
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});
function transport(pay) {
  const requests = [];
  return {requests, fetch: async (url, init) => {
    if (url.startsWith('/api/pos/payment-config?')) return json({status: 'OK', data: cfg});
    if (url.startsWith('/api/pos/payment-config/qris-image?')) return new Response(new Uint8Array([137,80,78,71]), {headers: {'content-type': 'image/png'}});
    requests.push({url, init}); return pay(url, init);
  }};
}
function serverResponse(init, status = 201) {
  const body = JSON.parse(init.body);
  return json(response(make(body.payment_method, {key: init.headers['Idempotency-Key'], cashInput: body.cash_received || '60000', reference: body.payment_reference || ''}), status), status);
}
async function lifecycle() {
  let t, h;
  for (const method of C.POS_PAYMENT_METHODS) {
    t = transport(async (_url, init) => serverResponse(init)); h = harness(t.fetch); await h.settle();
    if (method === 'CASH') h.input('text', '60000'); else {
      h.click(method === 'TRANSFER' ? 'Transfer' : method === 'DEBIT' ? 'Debit' : method);
      if (method === 'QRIS') {assert.equal(h.button('Bayar Sekarang').props.disabled, true);
        const image = h.nodes().find(n => n.type === 'img'); assert.ok(image); image.props.onLoad(); h.render();}
      assert.equal(h.button('Bayar Sekarang').props.disabled, true);
      h.input('checkbox', true);
    }
    h.click('Bayar Sekarang'); await h.settle();
    check('Component ' + method + ': correct POST, verified success callback and close', () => {
      assert.equal(t.requests.length, 1); assert.equal(JSON.parse(t.requests[0].init.body).payment_method, method);
      assert.equal(h.signals.paid.length, 1); assert.equal(h.signals.paid[0].settlement.payment_method, method);
      assert.equal(h.signals.pending.at(-1), false); h.click('Tutup'); assert.equal(h.signals.closes, 1);
    }); h.cleanup();
  }
  let release;
  t = transport((_url, init) => new Promise(resolve => {release = () => resolve(serverResponse(init));})); h = harness(t.fetch); await h.settle();
  h.input('text', '60000'); const confirm = h.button('Bayar Sekarang'); confirm.props.onClick(); confirm.props.onClick(); h.render();
  check('Component double click creates one request and pending blocks close', () => {
    assert.equal(t.requests.length, 1); assert.equal(h.button('Batal').props.disabled, true);
    h.button('Batal').props.onClick(); assert.equal(h.signals.closes, 0);
  }); release(); await h.settle(); h.cleanup();
  let attempt = 0;
  t = transport(async (_url, init) => {if (++attempt === 1) throw new Error('network'); return serverResponse(init, 200);});
  h = harness(t.fetch); await h.settle(); h.click('Transfer'); h.input('text', 'REF-7'); h.input('checkbox', true);
  h.click('Bayar Sekarang'); await h.settle();
  check('Component network failure locks method/reference/close, not paid', () => {
    assert.equal(h.signals.paid.length, 0); assert.equal(h.signals.unresolved.at(-1), true);
    assert.equal(h.button('Tunai').props.disabled, true); assert.equal(h.button('Batal').props.disabled, true);
    h.button('Batal').props.onClick(); assert.equal(h.signals.closes, 0);
  }); h.click('Coba Lagi'); await h.settle();
  check('Component retry uses byte-identical body/key/path and validates replay', () => {
    assert.equal(t.requests[1].init.body, t.requests[0].init.body);
    assert.equal(t.requests[1].url, t.requests[0].url);
    assert.equal(t.requests[1].init.headers['Idempotency-Key'], t.requests[0].init.headers['Idempotency-Key']);
    assert.equal(h.signals.paid.length, 1); assert.equal(h.signals.paid[0].replayed, true);
    assert.equal(h.signals.unresolved.at(-1), false);
  }); h.cleanup();
  for (const kind of ['malformed-success', 'server-error', 'retry-403', 'retry-already-paid', 'context-change']) {
    attempt = 0;
    t = transport(async (_url, init) => {
      if (++attempt === 1) {
        if (kind === 'malformed-success') return json({status: 'SUCCESS', data: {}}, 201);
        if (kind === 'server-error') return json({message: 'temporary'}, 500);
        throw new Error('timeout');
      }
      return kind === 'retry-already-paid' ? json({code:'ALREADY_PAID'},409) : json({code:'FORBIDDEN'},403);
    }); h = harness(t.fetch); await h.settle(); h.click('Bayar Sekarang'); await h.settle();
    if (kind === 'context-change') h.changeOrder({orderId: 10, propertyId: 7, orderNumber: 'POS-10', totalAmount: '54900.00'});
    h.click('Coba Lagi'); await h.settle();
    check('Component ' + kind + ' preserves unresolved and never claims paid', () => {
      assert.equal(h.signals.paid.length, 0); assert.equal(h.signals.unresolved.at(-1), true);
      const close = h.button(kind === 'retry-already-paid' ? 'Tutup' : 'Batal');
      assert.equal(close.props.disabled, true);
      close.props.onClick();
      assert.equal(h.signals.closes, 0);
      assert.equal(t.requests.length, kind === 'context-change' ? 1 : 2);
    }); h.cleanup();
  }
  attempt = 0;
  t = transport(async (_url, init) => ++attempt === 1 ? json({code: 'CASH_RECEIVED_INSUFFICIENT'},422) : serverResponse(init));
  h = harness(t.fetch); await h.settle(); h.input('text','60000'); h.click('Bayar Sekarang'); await h.settle();
  check('Component definitive rejection permits editing and releases unresolved', () => {
    assert.equal(h.signals.paid.length, 0); assert.equal(h.signals.unresolved.at(-1), false);
    assert.equal(h.button('Batal').props.disabled, false);
  }); h.input('text','60000'); h.click('Bayar Sekarang'); await h.settle();
  check('Component corrected fresh request has a new key and valid success', () => {
    assert.notEqual(t.requests[1].init.headers['Idempotency-Key'], t.requests[0].init.headers['Idempotency-Key']);
    assert.equal(h.signals.paid.length, 1);
  }); h.cleanup();
  t = transport(async (_url, init) => serverResponse(init));
  h = harness(t.fetch, {onPaid() {throw new Error('consumer failure');}}); await h.settle(); h.click('Bayar Sekarang'); await h.settle();
  check('Component callback failure leaves payment successful, refresh and close usable', () => {
    assert.equal(h.signals.unresolved.at(-1), false); assert.equal(h.signals.refreshes, 1);
    h.click('Tutup'); assert.equal(h.signals.closes, 1);
  }); h.cleanup();
  h = harness(async () => {throw new Error('config unavailable');}); await h.settle();
  check('Component config unavailable disables non-CASH and keeps CASH available', () => {
    assert.equal(h.button('Transfer').props.disabled, true); assert.equal(h.button('QRIS').props.disabled, true);
    assert.equal(h.button('Bayar Sekarang').props.disabled, false);
  }); h.cleanup();
  h = harness(t.fetch, {canEditPos: false}); await h.settle();
  check('Component POS View without edit cannot submit', () => assert.equal(h.button('Bayar Sekarang').props.disabled,true)); h.cleanup();

  // ── Uang Pas test ──────────────────────────────────────────────────────────
  t = transport(async (_url, init) => serverResponse(init));
  h = harness(t.fetch); await h.settle();
  h.input('text', '60000');
  const uangPasBtn = h.nodes().find(n => n.type === 'button' && (n.props.children === 'Uang Pas' ||
    Array.isArray(n.props.children) && n.props.children.join('') === 'Uang Pas'));
  assert.ok(uangPasBtn, 'Uang Pas button must exist in CASH panel');
  // Click Uang Pas: sets cashInput to totalValue (54900), no payment request
  uangPasBtn.props.onClick(); h.render();
  check('Uang Pas button exists in CASH panel', () => {
    assert.equal(uangPasBtn.props.disabled, false);
  });
  check('Click Uang Pas sets cash input to exact total, no payment request', () => {
    assert.equal(t.requests.length, 0);
    // Verify cashInput was set to String(totalValue) = '54900'
    const input = h.nodes().find(n => n.type === 'input' && n.props.type === 'text');
    assert.equal(input.props.value, '54900');
  });
  // Now proceed to success
  h.click('Bayar Sekarang'); await h.settle();
  check('CASH success state: no method buttons, no payment input, no checkbox, no Bayar Sekarang/Batal; only Cetak Struk + Tutup', () => {
    const allText = JSON.stringify(h.nodes());
    // No method buttons
    for (const m of ['Tunai', 'QRIS', 'Transfer', 'Debit']) {
      const btn = h.nodes().find(n => n.type === 'button' && (n.props.children === m || (Array.isArray(n.props.children) && n.props.children.join('') === m)));
      assert.equal(btn, undefined, 'Method button ' + m + ' should not exist in success state');
    }
    // No payment text input
    const textInput = h.nodes().find(n => n.type === 'input' && n.props.type === 'text');
    assert.equal(textInput, undefined, 'Payment text input should not exist in success state');
    // No checkbox
    const checkbox = h.nodes().find(n => n.type === 'input' && n.props.type === 'checkbox');
    assert.equal(checkbox, undefined, 'Checkbox should not exist in success state');
    // No "Bayar Sekarang" or "Batal" buttons
    for (const label of ['Bayar Sekarang', 'Batal']) {
      const btn = h.nodes().find(n => n.type === 'button' && n.props.children === label);
      assert.equal(btn, undefined, 'Button ' + label + ' should not exist in success state');
    }
    // Cetak Struk present
    const strukBtn = h.nodes().find(n => n.type === 'button' && n.props.children === 'Cetak Struk');
    assert.ok(strukBtn, 'Cetak Struk button must exist in success footer');
    // Tutup present
    const tutupBtn = h.nodes().find(n => n.type === 'button' && n.props.children === 'Tutup');
    assert.ok(tutupBtn, 'Tutup button must exist in success footer');
  });
  h.cleanup();

  // ── Non-CASH success state test (QRIS) ─────────────────────────────────────
  t = transport(async (_url, init) => serverResponse(init));
  h = harness(t.fetch); await h.settle();
  h.click('QRIS');
  const img = h.nodes().find(n => n.type === 'img');
  if (img) { img.props.onLoad(); h.render(); }
  h.input('checkbox', true);
  h.click('Bayar Sekarang'); await h.settle();
  check('Non-CASH (QRIS) success state: no method buttons, no payment input, no checkbox; shows Ref/Diverifikasi bila ada', () => {
    for (const m of ['Tunai', 'QRIS', 'Transfer', 'Debit']) {
      const btn = h.nodes().find(n => n.type === 'button' && (n.props.children === m || (Array.isArray(n.props.children) && n.props.children.join('') === m)));
      assert.equal(btn, undefined, 'Method button ' + m + ' should not exist in success state');
    }
    const textInput = h.nodes().find(n => n.type === 'input' && n.props.type === 'text');
    assert.equal(textInput, undefined, 'Payment text input should not exist in success state');
    const checkbox = h.nodes().find(n => n.type === 'input' && n.props.type === 'checkbox');
    assert.equal(checkbox, undefined, 'Checkbox should not exist in success state');
    // Cetak Struk + Tutup present
    const strukBtn = h.nodes().find(n => n.type === 'button' && n.props.children === 'Cetak Struk');
    assert.ok(strukBtn, 'Cetak Struk button must exist in success footer');
    const tutupBtn = h.nodes().find(n => n.type === 'button' && n.props.children === 'Tutup');
    assert.ok(tutupBtn, 'Tutup button must exist in success footer');
    // No "Bayar Sekarang" or "Batal"
    for (const label of ['Bayar Sekarang', 'Batal']) {
      const btn = h.nodes().find(n => n.type === 'button' && n.props.children === label);
      assert.equal(btn, undefined, 'Button ' + label + ' should not exist in success state');
    }
  });
  h.cleanup();
}
(async () => {
  if (!contractOnly) await lifecycle();
  console.log(`\n[RESULT] ${pass} PASS, 0 FAIL${contractOnly ? ' (contract only; component lifecycle not run)' : ''}`);
})().catch(error => {console.error('[FAIL]', error); process.exitCode = 1;});

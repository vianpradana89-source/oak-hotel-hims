'use strict';
/**
 * pos_edit_payment_integration_test.cjs
 *
 * POS-EDIT-1B (taf2) — Integration test PEMBAYARAN ORDER EXISTING,
 * dijalankan terhadap KOMPONEN AKTUAL PosWorkspace.tsx.
 *
 * Verifikasi skenario:
 *   S1. Order existing bersih tanpa PUT sebelumnya: total server valid.
 *   S2. Dirty: PUT + GET deferred; pembayaran belum terbuka saat GET pending.
 *   S3. Sesudah GET sukses: context memakai total/guest/reservation terbaru.
 *   S4. GET gagal, hasil ambigu, identitas unresolved, atau draft berubah
 *       selama await: modal pembayaran tidak terbuka.
 *   S5. Close/ganti session saat await: respons lama tidak membuka pembayaran.
 *   S6. Double-click Bayar serta pemulihan tombol setelah gagal/selesai.
 *   S7. Context CREATE tetap utuh.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const sourceDir = path.join(__dirname, '../src/features/pos');

let ts;
try { ts = require('typescript'); } catch (e) {
  throw new Error('TypeScript missing; run from frontend/ after npm install.');
}

function compile(file) {
  const text = fs.readFileSync(path.join(sourceDir, file), 'utf8');
  return ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    fileName: file
  }).outputText;
}

function load(code, imports = {}, envHooks = {}) {
  const module = { exports: {} };
  const alertFn = msg => { if (envHooks.onAlert) envHooks.onAlert(String(msg ?? '')); };
  const confirmFn = msg => {
    if (envHooks.onConfirm) return envHooks.onConfirm(String(msg ?? ''));
    return true;
  };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: name => {
      if (name in imports) return imports[name];
      throw new Error('Unexpected import ' + name);
    },
    console: { error() {}, warn() {}, log() {} },
    crypto: { randomUUID },
    AbortController,
    URL,
    Response,
    Blob,
    alert: alertFn,
    confirm: confirmFn,
    window: { setTimeout() { return 1; }, clearTimeout() {}, alert: alertFn, confirm: confirmFn },
    document: { activeElement: { focus() {} } }
  }, { timeout: 3000 });
  return module.exports;
}

const D = load(compile('posOrderDraft.ts'));

// ── Test runner ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  PASS  ' + name);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.error('  FAIL  ' + name);
    console.error(err && err.stack ? err.stack : err);
  }
}

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ── Harness PosWorkspace ─────────────────────────────────────────────────────
function harness(handler, overrides = {}) {
  const slots = [];
  let cursor = 0, queued = [], tree, props;
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }];
    },
    useRef(value) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { current: value };
      return slots[i];
    },
    useCallback(fn) { cursor++; return fn; },
    useMemo(fn) { cursor++; return fn(); },
    useEffect(fn, deps) {
      const i = cursor++, prev = slots[i];
      if (!prev || !deps || deps.some((v, k) => !Object.is(v, prev.deps[k]))) {
        queued.push(() => {
          prev?.cleanup?.();
          slots[i] = { deps, cleanup: fn() };
        });
      }
    },
  };

  const jsx = (type, p, key) => ({ type, props: p || {}, key });
  const _pricingData = overrides.pricingData || {
    service_charge_enabled: false, service_charge_percent: 0,
    tax_enabled: false, tax_percent: 0,
  };
  const mockAuthenticatedFetch = async () => new Response(
    JSON.stringify({ status: 'OK', data: _pricingData }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );

  let confirmResult = true;
  const signals = {
    created: [],
    edited: [],
    pay: [],
    refreshes: 0,
    dirty: false,
    dirtyHistory: [],
    pending: false,
    pendingHistory: [],
    unresolved: false,
    unresolvedHistory: [],
    alerts: [],
    confirms: [],
  };

  const component = load(compile('PosWorkspace.tsx'), {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    './posOrderDraft': D,
    './GuestPicker': { default: () => null },
    '../../lib/authenticatedFetch': { authenticatedFetch: mockAuthenticatedFetch },
  }, {
    onAlert(msg) { signals.alerts.push(msg); },
    onConfirm(msg) {
      signals.confirms.push(msg);
      return typeof confirmResult === 'function' ? confirmResult(msg) : confirmResult;
    },
  }).default;

  const log = { gets: [], puts: [], posts: [] };
  const authFetch = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    if (method === 'GET' && url.includes('/detail')) {
      log.gets.push(url);
      return handler.get({ url, init, n: log.gets.length });
    }
    if (method === 'PUT') {
      log.puts.push({ url, body: init.body, headers: init.headers });
      return handler.put({ url, init, n: log.puts.length });
    }
    if (method === 'POST') {
      log.posts.push({ url, body: init.body, headers: init.headers });
      return handler.post({ url, init, n: log.posts.length });
    }
    throw new Error('Unexpected request ' + method + ' ' + url);
  };

  props = {
    propertyId: 7,
    posMenu: MENU,
    posOrders: [ORDER],
    reservationId: null,
    authFetch,
    canEditPos: true,
    canDiscountPos: false,
    onOrderCreated(order) { signals.created.push(order); },
    onOrderEdited(order) { signals.edited.push(order); },
    onCartChange(dirty) { signals.dirty = Boolean(dirty); signals.dirtyHistory.push(Boolean(dirty)); },
    onRequestPending(pending) { signals.pending = Boolean(pending); signals.pendingHistory.push(Boolean(pending)); },
    onUnresolvedChange(u) { signals.unresolved = Boolean(u); signals.unresolvedHistory.push(Boolean(u)); },
    onOpenCashPayment(ctx) { signals.pay.push(ctx); },
    onRefresh() { signals.refreshes++; },
    ...overrides
  };

  function render() {
    cursor = 0;
    tree = component(props);
    const effects = queued;
    queued = [];
    effects.forEach(fn => fn());
    return tree;
  }

  function nodes() {
    const out = [];
    (function walk(n) {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!n || typeof n !== 'object') return;
      out.push(n);
      walk(n.props?.children);
    })(tree);
    return out;
  }

  function label(n) {
    const flatten = v => Array.isArray(v) ? v.map(flatten).join('') : v && typeof v === 'object' ? flatten(v.props?.children) : v == null ? '' : String(v);
    return flatten(n.props.children);
  }

  function button(text) {
    const n = nodes().find(n => n.type === 'button' && label(n) === text);
    assert.ok(n, 'Missing button ' + text);
    return n;
  }

  function findButton(text) {
    return nodes().find(n => n.type === 'button' && label(n) === text);
  }

  function click(text) {
    const n = button(text);
    assert.equal(!!n.props.disabled, false, 'Disabled button ' + text);
    n.props.onClick();
    render();
  }

  function forceClick(text) {
    const n = button(text);
    n.props.onClick();
    render();
  }

  function field(name) {
    const div = nodes().find(n => n.type === 'div' && Array.isArray(n.props.children)
      && n.props.children.some(c => c && c.type === 'label' && label(c).includes(name))
      && n.props.children.some(c => c && c.type === 'input'));
    assert.ok(div, 'Missing metadata field ' + name);
    return div.props.children.find(c => c && c.type === 'input');
  }

  function typeInto(name, value) {
    const n = field(name);
    assert.equal(!!n.props.disabled, false, 'Disabled field ' + name);
    n.props.onChange({ target: { value } });
    render();
  }

  function qtyButtons(aria) { return nodes().filter(n => n.type === 'button' && n.props['aria-label'] === aria); }
  function incQty(index = 0) {
    const n = qtyButtons('Tambah jumlah')[index];
    assert.ok(n, 'Missing qty + button');
    assert.equal(!!n.props.disabled, false);
    n.props.onClick();
    render();
  }

  function menuSelect() {
    return nodes().find(n => n.type === 'select'
      && (n.props.children || []).some(c => c && c.type === 'option' && label(c).includes('pilih menu')));
  }

  function addMenu(menuId) {
    const s = menuSelect();
    assert.ok(s, 'Missing "Tambah Menu" select');
    s.props.onChange({ target: { value: String(menuId) } });
    render();
  }

  function clickMenuCard(name) {
    const card = nodes().find(n => n.type === 'div' && typeof n.props.onClick === 'function'
      && JSON.stringify(n.props.children || '').includes(name));
    assert.ok(card, 'Missing menu card: ' + name);
    card.props.onClick();
    render();
  }

  async function settle() {
    await new Promise(resolve => setImmediate(resolve));
    render();
    await new Promise(resolve => setImmediate(resolve));
    render();
  }

  async function settle2() {
    await settle();
    await settle();
  }

  function openOrder() {
    click('Riwayat Order (1)');
    click('POS-501');
  }

  render();
  return {
    render, nodes, button, findButton, click, forceClick, field, typeInto, incQty, addMenu, clickMenuCard,
    settle, settle2, openOrder, signals, log, label,
    setConfirmResult(val) { confirmResult = val; },
    changeProps(patch) { props = { ...props, ...patch }; render(); },
    cleanup() { slots.forEach(s => s?.cleanup?.()); }
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const MENU = [
  { id: 1, item_code: 'CF', name: 'Coffee', price: 13000 },
  { id: 2, item_code: 'TE', name: 'Tea', price: 10000 }
];

const ORDER = {
  id: 501, order_number: 'POS-501', status: 'OPEN', total_amount: '26000',
  table_number: 'A1', guest_name: 'Budi'
};

const line = (id, menuItemId, quantity, extra = {}) => ({
  id, menu_item_id: menuItemId, quantity, notes: null, discount_type: null,
  discount_value: null, unit_price: menuItemId === 1 ? 13000 : 10000,
  item_name_snapshot: menuItemId === 1 ? 'Coffee' : 'Tea', item_code_snapshot: 'X',
  ...extra,
});

function detail({
  version = 1, status = 'OPEN', items = [line(9001, 1, 2)], guestName = 'Budi',
  tableNumber = 'A1', notes = null, reservationId = null, totalAmount = '26000'
} = {}) {
  return json({
    status: 'OK',
    data: {
      order: {
        id: 501, property_id: 7, order_number: 'POS-501', status, version,
        total_amount: totalAmount, table_number: tableNumber, guest_name: guestName,
        guest_phone: '+62811', notes, discount_reason: null, discount_type: null,
        discount_value: null, reservation_id: reservationId,
        service_charge_enabled_snapshot: false, service_charge_percent_snapshot: 0,
        tax_enabled_snapshot: false, tax_percent_snapshot: 0
      },
      items,
    }
  });
}

const putOk = (version, total) => json({
  status: 'OK', replayed: false,
  data: { order: { id: 501, total_amount: total, version } }
});

// ── Skenario Tes ─────────────────────────────────────────────────────────────
(async () => {
  console.log('=== TEST SUITE: Pembayaran Order Existing (PosWorkspace) ===\n');

  // S1. Order existing bersih tanpa PUT sebelumnya: total server valid.
  await check('S1: Order existing bersih tanpa PUT sebelumnya membuka pembayaran dengan total server valid', async () => {
    const h = harness({
      get: ({ n }) => {
        if (n === 1) return detail({ items: [line(9001, 1, 2)], totalAmount: '26000', guestName: 'Budi' });
        // GET #2 dipicu saat klik Bayar (refresh snapshot server terverifikasi)
        return detail({ items: [line(9001, 1, 2)], totalAmount: '26000', guestName: 'Budi' });
      },
      put: () => { throw new Error('Clean draft must not trigger PUT'); },
      post: () => json({}, 500),
    });

    h.openOrder();
    await h.settle2();

    // Pastikan tidak ada PUT
    assert.equal(h.log.puts.length, 0);

    // Klik tombol Bayar
    h.click('Bayar');
    await h.settle2();

    assert.equal(h.log.puts.length, 0, 'Draft bersih tidak boleh memicu PUT');
    assert.equal(h.signals.pay.length, 1, 'Modal pembayaran harus terbuka tepat satu kali');
    assert.deepEqual(JSON.parse(JSON.stringify(h.signals.pay[0])), {
      propertyId: 7,
      orderId: 501,
      orderNumber: 'POS-501',
      totalAmount: '26000',
      guestName: 'Budi',
      reservationId: null,
    }, 'Context pembayaran harus cocok dengan snapshot server');

    h.cleanup();
  });

  // S2. Dirty: PUT + GET deferred; pembayaran belum terbuka saat GET pending.
  await check('S2: Dirty draft melakukan PUT + GET deferred; pembayaran belum terbuka saat GET pending', async () => {
    const d = deferred();
    let putCalled = false;
    const h = harness({
      get: ({ n }) => {
        if (n === 1) return detail({ items: [line(9001, 1, 1)], totalAmount: '13000' });
        // GET #2 pasca-PUT ditahan
        return d.promise;
      },
      put: () => {
        putCalled = true;
        return putOk(2, 26000);
      },
      post: () => json({}, 500),
    });

    h.openOrder();
    await h.settle2();

    // Buat draft dirty (ubah quantity)
    h.incQty(0);
    await h.settle2();

    // Klik Bayar
    h.click('Bayar');
    await h.settle2();

    assert.equal(putCalled, true, 'PUT harus dipanggil saat draft dirty');
    assert.equal(h.signals.pay.length, 0, 'Pembayaran BELUM boleh terbuka saat GET sinkronisasi masih pending');

    // Tombol Bayar harus dalam status pending ("Menunggu simpan…") dan disabled
    assert.ok(h.nodes().some(n => n.type === 'button' && (n.props.disabled === true)));

    // Lepas GET
    d.resolve(detail({ version: 2, items: [line(9001, 1, 2)], totalAmount: '26000' }));
    await h.settle2();

    assert.equal(h.signals.pay.length, 1, 'Pembayaran terbuka setelah GET sinkronisasi selesai');
    h.cleanup();
  });

  // S3. Sesudah GET sukses: context memakai total/guest/reservation terbaru dari server.
  await check('S3: Sesudah GET sukses, context memakai total/guest/reservation terbaru dari server', async () => {
    const h = harness({
      get: ({ n }) => {
        if (n === 1) return detail({ items: [line(9001, 1, 1)], totalAmount: '13000', guestName: 'Lama', reservationId: null });
        return detail({
          version: 2,
          items: [line(9001, 1, 3)],
          totalAmount: '39000',
          guestName: 'Tamu VIP',
          reservationId: 108
        });
      },
      put: () => putOk(2, 39000),
      post: () => json({}, 500),
    });

    h.openOrder();
    await h.settle2();

    h.incQty(0); // Dirty
    h.click('Bayar');
    await h.settle2();
    await h.settle2();

    assert.equal(h.signals.pay.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(h.signals.pay[0])), {
      propertyId: 7,
      orderId: 501,
      orderNumber: 'POS-501',
      totalAmount: '39000',
      guestName: 'Tamu VIP',
      reservationId: 108,
    }, 'Context harus memakai total, guest, dan reservation dari snapshot server terbaru');

    h.cleanup();
  });

  // S4. GET gagal, hasil ambigu, identitas unresolved, atau draft berubah: modal pembayaran tidak terbuka.
  await check('S4a: GET gagal (HTTP 500) -> modal pembayaran tidak terbuka', async () => {
    const h = harness({
      get: ({ n }) => {
        if (n === 1) return detail();
        return json({ message: 'Internal Server Error' }, 500);
      },
      put: () => putOk(2, 26000),
      post: () => json({}, 500),
    });

    h.openOrder();
    await h.settle2();

    h.click('Bayar');
    await h.settle2();

    assert.equal(h.signals.pay.length, 0, 'Modal pembayaran tidak boleh terbuka bila GET gagal');
    h.cleanup();
  });

  await check('S4b: PUT gagal (HTTP 500 ambigu) -> modal pembayaran tidak terbuka', async () => {
    const h = harness({
      get: () => detail(),
      put: () => json({ message: 'Crash' }, 500),
      post: () => json({}, 500),
    });

    h.openOrder();
    await h.settle2();

    h.incQty(0); // Dirty
    h.click('Bayar');
    await h.settle2();

    assert.equal(h.signals.pay.length, 0, 'Modal pembayaran tidak boleh terbuka bila PUT gagal');
    h.cleanup();
  });

  await check('S4c: PUT item baru + GET sync gagal (identitas unresolved) -> modal pembayaran tidak terbuka', async () => {
    const h = harness({
      get: ({ n }) => {
        if (n === 1) return detail();
        // GET sinkronisasi pasca-PUT gagal
        return json({ message: 'Server error' }, 500);
      },
      put: () => putOk(2, 36000),
      post: () => json({}, 500),
    });

    h.openOrder();
    await h.settle2();

    // Tambah menu baru (item tanpa id)
    h.addMenu(2);
    await h.settle2();

    h.click('Bayar');
    await h.settle2();

    assert.equal(h.signals.pay.length, 0, 'Modal pembayaran tidak boleh terbuka saat identitas item unresolved');
    h.cleanup();
  });

  await check('S4d: Draft berubah selama GET in-flight -> modal pembayaran tidak terbuka', async () => {
    const d = deferred();
    const h = harness({
      get: ({ n }) => (n === 1 ? detail() : d.promise),
      put: () => putOk(2, 26000),
      post: () => json({}, 500),
    });

    h.openOrder();
    await h.settle2();

    h.incQty(0);
    h.click('Bayar');
    await h.settle2();

    // Sementara GET in-flight, pengguna mengubah draft lagi
    h.typeInto('Nama Tamu', 'Nama Berubah Saat Await');
    await h.settle2();

    // Sekarang lepas GET
    d.resolve(detail({ version: 2, totalAmount: '26000' }));
    await h.settle2();

    assert.equal(h.signals.pay.length, 0, 'Perubahan draft selama await harus membatalkan niat pembayaran');
    h.cleanup();
  });

  // S5. Close/ganti session saat await: respons lama tidak membuka pembayaran.
  await check('S5a: Editor ditutup (Batal/Kembali) saat GET in-flight -> respons lama tidak membuka pembayaran', async () => {
    const d = deferred();
    const h = harness({
      get: ({ n }) => (n === 1 ? detail() : d.promise),
      put: () => putOk(2, 26000),
      post: () => json({}, 500),
    });

    h.openOrder();
    await h.settle2();

    h.click('Bayar');
    await h.settle2();

    // Tutup editor
    h.click('Kembali ke Riwayat');
    await h.settle2();

    // Lepas GET yang tertahan
    d.resolve(detail({ version: 2, totalAmount: '26000' }));
    await h.settle2();

    assert.equal(h.signals.pay.length, 0, 'Editor yang ditutup tidak boleh membuka modal pembayaran');
    h.cleanup();
  });

  await check('S5b: Property ID berubah saat await -> respons lama tidak membuka pembayaran', async () => {
    const d = deferred();
    const h = harness({
      get: ({ n }) => (n === 1 ? detail() : d.promise),
      put: () => putOk(2, 26000),
      post: () => json({}, 500),
    });

    h.openOrder();
    await h.settle2();

    h.click('Bayar');
    await h.settle2();

    // Ganti propertyId
    h.changeProps({ propertyId: 99 });
    await h.settle2();

    d.resolve(detail({ version: 2, totalAmount: '26000' }));
    await h.settle2();

    assert.equal(h.signals.pay.length, 0, 'Perubahan properti/session harus membatalkan pembukaan pembayaran');
    h.cleanup();
  });

  // S6. Double-click Bayar serta pemulihan tombol setelah gagal/selesai.
  await check('S6: Double-click tombol Bayar dicegah secara sinkron & tombol pulih setelah selesai', async () => {
    const d = deferred();
    let getCallCount = 0;
    const h = harness({
      get: ({ n }) => {
        getCallCount++;
        if (n === 1) return detail();
        return d.promise;
      },
      put: () => putOk(2, 26000),
      post: () => json({}, 500),
    });

    h.openOrder();
    await h.settle2();

    // Klik pertama
    h.click('Bayar');
    assert.equal(getCallCount, 2, 'GET refresh kedua dipicu');

    // Force click kedua saat masih pending ("Menunggu simpan…")
    h.forceClick('Menunggu simpan…');
    assert.equal(getCallCount, 2, 'Double-click tidak boleh memicu GET kedua');

    // Selesaikan GET
    d.resolve(detail({ version: 2, totalAmount: '26000' }));
    await h.settle2();

    assert.equal(h.signals.pay.length, 1);

    // Tombol kembali dapat diklik ("Bayar")
    const payBtn = h.findButton('Bayar');
    assert.ok(payBtn, 'Tombol Bayar harus pulih kembali setelah operasi selesai');
    assert.equal(!!payBtn.props.disabled, false, 'Tombol Bayar tidak boleh terkunci permanen');

    h.cleanup();
  });

  // S7. Context CREATE tetap utuh.
  await check('S7: Context CREATE tetap utuh dan tidak ditimpa oleh pembayaran alur EDIT', async () => {
    const h = harness({
      get: () => detail({ totalAmount: '26000' }),
      put: () => putOk(2, 26000),
      post: () => json({
        status: 'SUCCESS',
        data: {
          id: 999,
          property_id: 7,
          order_number: 'POS-CREATE-999',
          status: 'OPEN',
          total_amount: '13000'
        }
      }, 201),
    });

    // 1. Lakukan alur CREATE di Kasir
    // Tambah item ke cart register
    h.clickMenuCard('Coffee');
    await h.settle2();

    // Buat pesanan (Simpan Pesanan)
    h.click('Simpan Pesanan');
    await h.settle2();

    // Verifikasi tombol "Bayar" di banner alur CREATE muncul
    const createPayBtn = h.nodes().find(n => n.type === 'button' && h.label(n) === 'Bayar' && n.props.className?.includes('text-[11px]'));
    assert.ok(createPayBtn, 'Tombol Bayar alur CREATE harus tampil di banner hasil simpan');

    // 2. Sekarang buka order existing 501 dan lakukan pembayaran EDIT
    h.click('Riwayat Order (1)');
    h.click('POS-501');
    await h.settle2();

    h.click('Bayar');
    await h.settle2();

    assert.equal(h.signals.pay.length, 1);
    assert.equal(h.signals.pay[0].orderId, 501, 'Context EDIT harus untuk order 501');

    // 3. Kembali ke alur create dan klik "Bayar" di banner alur CREATE
    // Tutup editor untuk kembali ke Riwayat lalu ke Kasir
    h.click('Kembali ke Riwayat');
    await h.settle2();
    h.click('Kasir & Menu POS');
    await h.settle2();

    const createPayBtnAgain = h.nodes().find(n => n.type === 'button' && h.label(n) === 'Bayar' && n.props.className?.includes('text-[11px]'));
    assert.ok(createPayBtnAgain, 'Tombol Bayar alur CREATE tetap ada di banner hasil simpan');
    createPayBtnAgain.props.onClick();
    await h.settle2();

    assert.equal(h.signals.pay.length, 2);
    assert.equal(h.signals.pay[1].orderId, 999, 'Context CREATE untuk order 999 harus tetap utuh dan tidak tertimpa');

    h.cleanup();
  });

  // S8. Pelaporan ke parent: gabungan CREATE + EDIT, sinkron, dan tahan re-render callback.
  await check('S8a: Pelaporan dirty ke parent menggabungkan CREATE + EDIT (false CREATE tidak menimpa EDIT dirty)', async () => {
    const h = harness({
      get: () => detail(),
      put: () => putOk(2, 39000),
      post: () => json({}, 500),
    });

    assert.equal(h.signals.dirty, false, 'Awal bersih');

    h.openOrder();
    await h.settle2();
    assert.equal(h.signals.dirty, false, 'Saat order baru dibuka dari server belum dirty');

    // Ubah draft EDIT (cart CREATE masih kosong = false)
    h.incQty(0);
    assert.equal(h.signals.dirty, true, 'Dirty EDIT harus langsung dilaporkan true ke parent meskipun CREATE kosong');

    // Simulasikan parent re-render dengan callback onCartChange inline baru
    let parentDirtyState = false;
    h.changeProps({
      onCartChange: d => { parentDirtyState = Boolean(d); h.signals.dirty = Boolean(d); },
    });
    assert.equal(parentDirtyState, true, 'Re-render dengan referensi callback baru tidak boleh menimpa EDIT dirty dengan false CREATE');

    // Simpan perubahan EDIT -> setelah PUT sukses menjadi bersih kembali
    h.click('Simpan Perubahan');
    await h.settle2();
    assert.equal(h.signals.dirty, false, 'Setelah PUT sukses tanpa perubahan lanjutan, dirty kembali false');

    // Ubah lagi, lalu tutup editor (confirm = true) -> kembali false
    h.incQty(0);
    assert.equal(h.signals.dirty, true);
    h.setConfirmResult(true);
    h.click('Batal');
    await h.settle2();
    assert.equal(h.signals.dirty, false, 'Setelah keluar dari editor, dirty harus dibersihkan');

    h.cleanup();
  });

  await check('S8b: Pending mutasi & hasil ambigu (termasuk network error) dilaporkan sinkron, tahan ganti callback, dan bersih setelah replay sukses', async () => {
    const putDef = deferred();
    let putAttempt = 0;
    const h = harness({
      get: () => detail(),
      put: () => {
        putAttempt++;
        if (putAttempt === 1) return putDef.promise;
        if (putAttempt === 2) return Promise.reject(new Error('Network down'));
        return putOk(2, 39000);
      },
      post: () => json({}, 500),
    });

    h.openOrder();
    await h.settle2();
    h.incQty(0);

    // 1. Klik Simpan -> PUT#1 tertahan (in-flight)
    h.click('Simpan Perubahan');
    assert.equal(h.signals.pending, true, 'Pending mutasi harus langsung true secara sinkron saat PUT dimulai');

    // Parent re-render mengganti referensi callback onRequestPending & onUnresolvedChange
    let latestPending = false;
    let latestUnresolved = false;
    h.changeProps({
      onRequestPending: p => { latestPending = Boolean(p); h.signals.pending = Boolean(p); },
      onUnresolvedChange: u => { latestUnresolved = Boolean(u); h.signals.unresolved = Boolean(u); },
    });
    assert.equal(latestPending, true, 'Callback onRequestPending baru saat re-render tetap menerima true (tidak ditimpa saving=false CREATE)');

    // Selesaikan PUT#1 dengan HTTP 502 (ambigu)
    putDef.resolve(json({ message: 'Bad Gateway' }, 502));
    await h.settle2();
    assert.equal(latestPending, false, 'Pending dibersihkan setelah PUT selesai');
    assert.equal(latestUnresolved, true, 'Hasil 502 ambigu dilaporkan ke parent');

    // Parent re-render lagi dengan callback baru saat ambiguous aktif
    let rerenderUnresolved = false;
    h.changeProps({
      onUnresolvedChange: u => { rerenderUnresolved = Boolean(u); h.signals.unresolved = Boolean(u); },
    });
    assert.equal(rerenderUnresolved, true, 'Callback onUnresolvedChange baru saat re-render tidak boleh ditimpa ambiguous=false CREATE');

    // 2. Retry ("Coba Lagi (retry identik)") mengalami network error -> tetap unresolved
    h.click('Coba Lagi (retry identik)');
    await h.settle2();
    assert.equal(h.signals.pending, false);
    assert.equal(h.signals.unresolved, true, 'Network error pada PUT wajib mempertahankan unresolved=true');

    // 3. Retry ketiga ("Coba Lagi (retry identik)") sukses 200 definitif -> unresolved dibersihkan
    h.click('Coba Lagi (retry identik)');
    await h.settle2();
    assert.equal(h.signals.unresolved, false, 'Setelah replay 200 sukses terverifikasi, unresolved parent wajib dibersihkan');

    h.cleanup();
  });

  // S9. Membuka kembali order yang sama mempertahankan draft (tanpa reseed diam-diam).
  await check('S9: Membuka kembali order yang sama mempertahankan draft; pindah ke order lain meminta konfirmasi eksplisit', async () => {
    const ORDER_2 = {
      id: 502, order_number: 'POS-502', status: 'OPEN', total_amount: '10000',
      table_number: 'B2', guest_name: 'Siti'
    };
    const h = harness({
      get: ({ url }) => {
        if (url.includes('/502/detail')) {
          return json({
            status: 'OK',
            data: {
              order: {
                id: 502, property_id: 7, order_number: 'POS-502', status: 'OPEN', version: 1,
                total_amount: '10000', table_number: 'B2', guest_name: 'Siti',
                guest_phone: null, notes: null, discount_reason: null, discount_type: null,
                discount_value: null, reservation_id: null,
                service_charge_enabled_snapshot: false, service_charge_percent_snapshot: 0,
                tax_enabled_snapshot: false, tax_percent_snapshot: 0
              },
              items: [line(9002, 2, 1)],
            }
          });
        }
        return detail({ guestName: 'Budi', items: [line(9001, 1, 2)] });
      },
      put: () => putOk(2, 39000),
      post: () => json({}, 500),
    }, {
      posOrders: [ORDER, ORDER_2],
    });

    // Buka order #501
    h.click('Riwayat Order (2)');
    h.click('POS-501');
    await h.settle2();
    assert.equal(h.log.gets.length, 1, 'GET #1 untuk order 501');

    // Ubah draft lokal pada order #501 (Nama Tamu & qty)
    h.typeInto('Nama Tamu', 'Budi Draft Baru');
    h.incQty(0);
    assert.equal(h.field('Nama Tamu').props.value, 'Budi Draft Baru');

    // Pindah ke tab Riwayat Order (confirm menyatakan "Draft dipertahankan")
    h.setConfirmResult(true);
    h.click('Riwayat Order (2)');
    await h.settle2();
    assert.ok(
      h.signals.confirms.some(m => m.includes('Draft dipertahankan')),
      'Dialog perpindahan tab harus menyatakan draft dipertahankan'
    );

    // Klik kembali order yang SAMA (POS-501) dari tabel Riwayat
    const getsBeforeReopenSame = h.log.gets.length;
    h.click('POS-501');
    await h.settle2();

    assert.equal(h.log.gets.length, getsBeforeReopenSame, 'Membuka kembali order yang sedang diedit TIDAK boleh memicu GET/reseed diam-diam');
    assert.equal(h.field('Nama Tamu').props.value, 'Budi Draft Baru', 'Draft Nama Tamu harus tetap utuh setelah kembali ke order yang sama');

    // Sekarang pindah lagi ke Riwayat Order, lalu coba klik order BERBEDA (POS-502) tetapi BATALKAN konfirmasi
    h.click('Riwayat Order (2)');
    await h.settle2();
    h.setConfirmResult(false);
    h.click('POS-502');
    await h.settle2();

    assert.equal(h.log.gets.length, getsBeforeReopenSame, 'Batal konfirmasi ganti order tidak boleh memuat order 502');
    h.click('Kasir & Menu POS');
    await h.settle2();
    assert.equal(h.field('Nama Tamu').props.value, 'Budi Draft Baru', 'Draft order 501 tetap terjaga saat batal ganti order');

    // Sekarang konfirmasi ganti ke order 502 (confirm = true)
    h.setConfirmResult(true);
    h.click('Riwayat Order (2)');
    await h.settle2();
    h.click('POS-502');
    await h.settle2();

    assert.equal(h.log.gets.length, getsBeforeReopenSame + 1, 'Konfirmasi ganti ke order berbeda memuat detail order 502');
    assert.equal(h.field('Nama Tamu').props.value, 'Siti', 'Editor kini menampilkan order 502');

    h.cleanup();
  });

  // S10. Guard read-only (PAID) & signal PAID saat GET tertunda.
  await check('S10: Order PAID / signal paidOrderId mengunci mutasi katalog & tidak dibuka kembali oleh GET lama', async () => {
    const slowGet = deferred();
    const h = harness({
      get: ({ n }) => (n === 1 ? detail({ status: 'OPEN' }) : slowGet.promise),
      put: () => putOk(2, 26000),
      post: () => json({}, 500),
    });

    h.openOrder();
    await h.settle2();

    // Mulai klik Bayar (memicu GET #2 yang tertahan di slowGet)
    h.click('Bayar');

    // Sementara GET #2 masih tertunda, signal paidOrderId datang dari parent
    h.changeProps({ paidOrderId: { propertyId: 7, orderId: 501 } });
    await h.settle2();

    // Sekarang GET #2 lama kembali membawa status: 'OPEN'
    slowGet.resolve(detail({ status: 'OPEN', version: 1, totalAmount: '26000' }));
    await h.settle2();

    // Modal pembayaran tidak boleh terbuka dan status tetap terkunci readonly (PAID)
    assert.equal(h.signals.pay.length, 0, 'Respons GET lama setelah signal PAID tidak boleh membuka modal pembayaran');
    assert.equal(h.findButton('Simpan'), undefined, 'Tombol Simpan tidak boleh muncul pada order PAID');

    // Klik kartu katalog menu saat readonly tidak boleh menambah item ke draft
    const teaOccurrencesBefore = JSON.stringify(h.nodes()).split('Tea').length;
    h.clickMenuCard('Tea');
    await h.settle2();
    const teaOccurrencesAfter = JSON.stringify(h.nodes()).split('Tea').length;
    assert.equal(teaOccurrencesAfter, teaOccurrencesBefore, 'Klik katalog pada order PAID/readonly tidak boleh mengubah cart edit');

    h.cleanup();
  });

  // S11. Pembatalan niat pembayaran saat PosWorkspace unmount selama GET in-flight.
  await check('S11: PosWorkspace unmount selama GET pembayaran berjalan membatalkan onOpenCashPayment', async () => {
    const slowGet = deferred();
    const h = harness({
      get: ({ n }) => (n === 1 ? detail({ status: 'OPEN', totalAmount: '26000' }) : slowGet.promise),
      put: () => putOk(2, 26000),
      post: () => json({}, 500),
    });

    // 1. Buka order OPEN lalu klik Bayar
    h.openOrder();
    await h.settle2();
    h.click('Bayar');

    // 2. Pastikan GET detail untuk Bayar sedang tertahan
    assert.equal(h.log.gets.length, 2, 'Klik Bayar harus memicu GET detail verifikasi');
    assert.equal(h.signals.pay.length, 0, 'Modal pembayaran belum boleh terbuka saat GET in-flight');

    // 3. Simulasikan modal parent ditutup sehingga workspace unmount (jalankan cleanup hook, bukan closeEditorView)
    h.cleanup();

    // 4. Selesaikan GET tanpa melakukan render ulang komponen yang sudah unmount
    slowGet.resolve(detail({ status: 'OPEN', version: 1, totalAmount: '26000' }));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    // 5. Pastikan onOpenCashPayment tidak terpanggil
    assert.equal(h.signals.pay.length, 0, 'onOpenCashPayment tidak boleh terpanggil setelah PosWorkspace unmount');
  });

  console.log(`\n[RESULT] ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
})();

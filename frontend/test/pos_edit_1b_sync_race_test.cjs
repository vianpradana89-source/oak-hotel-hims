'use strict';
/**
 * pos_edit_1b_sync_race_test.cjs
 *
 * POS-EDIT-1B (P3) — regression test RACE GET sinkronisasi vs draft editor,
 * dijalankan terhadap KOMPONEN AKTUAL PosWorkspace.tsx (bukan probe/simulasi).
 *
 * Fasilitas test: harness hook tiruan + JSX factory yang sudah dipakai repo
 * (lihat pos_order_draft_ui_test.cjs). Komponen yang dieksekusi adalah file
 * sumber asli frontend/src/features/pos/PosWorkspace.tsx; yang diganti hanya
 * runtime React (useState/useRef/useCallback/useEffect) dan `authFetch`.
 * Jadi event handler, state machine, dan JSX yang diuji adalah kode produksi.
 *
 * Skenario (GET sinkronisasi dikendalikan lewat deferred promise):
 *   R1  GET awal saat membuka order tetap bekerja (draft ter-seed).
 *   R2  Tanpa perubahan draft: GET pasca-PUT menyinkronkan quantity, total,
 *       dan version.
 *   R3  Quantity diubah selama GET in-flight → draft terbaru TIDAK tertimpa.
 *   R4  Metadata diubah selama GET in-flight → draft terbaru TIDAK tertimpa.
 *   R5  Editor ditutup sebelum GET selesai → respons lama diabaikan, editor
 *       tidak terbuka kembali, navigasi TIDAK dikunci saat editLoading.
 *   R6  PUT sukses + GET gagal (HTTP 500) → banner sukses PUT dipertahankan,
 *       kegagalan dilaporkan sebagai sync warning (bukan editError).
 *   R7  Double-submit: klik Simpan dua kali saat PUT in-flight → hanya 1 PUT.
 *   R8  Retry setelah 5xx memakai idempotency_key + body yang SAMA.
 *   R9  Stale closure: payload PUT memakai quantity draft TERBARU.
 *   R10 CREATE (POST) tetap berjalan seperti sebelumnya.
 *   R11 Draft dipertahankan + identitas item baru direkonsiliasi (badge BARU
 *       hilang setelah id server diketahui).
 *   R12 Simpan lanjutan setelah PUT sukses + draft berubah selama GET
 *       (expected_version = versi server, key siklus baru).
 *   R13 Item lama dihapus lalu menu sama ditambahkan selama GET: baris
 *       pengganti TIDAK menerima id item lama.
 *   R14 Beberapa baris menu sama dengan notes berbeda tidak tertukar.
 *   R15 Baris yang lahir SETELAH snapshot PUT tetap tanpa id (beda dari baris
 *       yang sudah disimpan PUT tersebut).
 *   R16 Pemetaan identitas tidak pasti → simpan diblokir eksplisit, draft aman.
 *   R17 PUT membuat item baru + GET sinkronisasi gagal → simpan lanjutan
 *       diblokir sampai identitas dipastikan (PUT pertama tetap sukses).
 *   R18 GET sinkronisasi masih in-flight → simpan lanjutan diblokir secara
 *       sinkron (tombol + guard), lalu aktif setelah identitas aman.
 *
 * Jalankan:
 *   cd frontend && node test/pos_edit_1b_sync_race_test.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const sourceArg = process.argv.indexOf('--source-dir');
const sourceDir = sourceArg >= 0
  ? path.resolve(process.argv[sourceArg + 1])
  : path.join(__dirname, '../src/features/pos');

let ts;
try { ts = require('typescript'); } catch (e) {
  throw new Error('TypeScript dependency missing; run from frontend/ after npm install.');
}

function compile(file) {
  const text = fs.readFileSync(path.join(sourceDir, file), 'utf8');
  return ts.transpileModule(text, {compilerOptions: {target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}, fileName: file}).outputText;
}
function load(code, imports = {}) {
  const module = {exports: {}};
  const noopAlert = () => {};
  const defaultConfirm = () => true;
  vm.runInNewContext(code, {module, exports: module.exports, require: name => {
    if (name in imports) return imports[name]; throw new Error('Unexpected import ' + name);
  }, console: {error() {}, warn() {}}, crypto: {randomUUID}, AbortController, URL, Response, Blob,
    alert: noopAlert, confirm: defaultConfirm,
    window: {setTimeout() {return 1;}, clearTimeout() {}, alert: noopAlert, confirm: defaultConfirm}, document: {activeElement: {focus() {}}}},
    {timeout: 3000});
  return module.exports;
}

const D = load(compile('posOrderDraft.ts'));

// ── Test infra ───────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (err) { fail++; failures.push({name, err}); console.error('  FAIL  ' + name);
    console.error(err && err.stack ? err.stack : err); }
}

const json = (value, status = 200) => new Response(JSON.stringify(value),
  {status, headers: {'content-type': 'application/json'}});

/** Deferred response — GET sinkronisasi ditahan sampai test melepasnya. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {resolve = res; reject = rej;});
  return {promise, resolve, reject};
}

// ── Harness: komponen PosWorkspace AKTUAL + authFetch yang dikendalikan ──────
function harness(handler, overrides = {}) {
  const slots = []; let cursor = 0, queued = [], tree, props;
  const react = {
    useState(initial) {const i = cursor++; if (!slots[i]) slots[i] = {value: typeof initial === 'function' ? initial() : initial};
      return [slots[i].value, value => {slots[i].value = typeof value === 'function' ? value(slots[i].value) : value;}];},
    useRef(value) {const i = cursor++; if (!slots[i]) slots[i] = {current: value}; return slots[i];},
    useCallback(fn) {cursor++; return fn;},
    useMemo(fn) {cursor++; return fn();},
    useEffect(fn, deps) {const i = cursor++, prev = slots[i];
      if (!prev || !deps || deps.some((v,k) => !Object.is(v, prev.deps[k]))) queued.push(() => {
        prev?.cleanup?.(); slots[i] = {deps, cleanup: fn()};
      });},
  };
  const jsx = (type, p, key) => ({type, props: p || {}, key});
  const _pricingData = overrides.pricingData || {
    service_charge_enabled: false, service_charge_percent: 0,
    tax_enabled: false, tax_percent: 0,
  };
  const mockAuthenticatedFetch = async () => new Response(
    JSON.stringify({status: 'OK', data: _pricingData}),
    {status: 200, headers: {'content-type': 'application/json'}});

  const component = load(compile('PosWorkspace.tsx'), {
    react, 'react/jsx-runtime': {jsx, jsxs: jsx},
    './posOrderDraft': D,
    './GuestPicker': {default: () => null},
    '../../lib/authenticatedFetch': {authenticatedFetch: mockAuthenticatedFetch},
  }).default;

  const log = {gets: [], puts: [], posts: []};
  const authFetch = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    if (method === 'GET' && url.includes('/detail')) {
      log.gets.push(url);
      return handler.get({url, init, n: log.gets.length});
    }
    if (method === 'PUT') {
      log.puts.push({url, body: init.body, headers: init.headers});
      return handler.put({url, init, n: log.puts.length});
    }
    if (method === 'POST') {
      log.posts.push({url, body: init.body, headers: init.headers});
      return handler.post({url, init, n: log.posts.length});
    }
    throw new Error('Unexpected request ' + method + ' ' + url);
  };

  const signals = {created: [], edited: [], pay: [], refreshes: 0};
  props = {propertyId: 7, posMenu: MENU, posOrders: [ORDER], reservationId: null,
    authFetch, canEditPos: true, canDiscountPos: false,
    onOrderCreated(order) {signals.created.push(order);},
    onOrderEdited(order) {signals.edited.push(order);},
    onRequestPending() {}, onUnresolvedChange() {},
    onOpenCashPayment(ctx) {signals.pay.push(ctx);},
    onRefresh() {signals.refreshes++;}, ...overrides};
  function render() {cursor = 0; tree = component(props); const effects = queued; queued = []; effects.forEach(fn => fn()); return tree;}
  function nodes() {const out = []; (function walk(n) {if (Array.isArray(n)) {n.forEach(walk); return;} if (!n || typeof n !== 'object') return;
    out.push(n); walk(n.props?.children);})(tree); return out;}
  function label(n) {const flatten = v => Array.isArray(v) ? v.map(flatten).join('') : v && typeof v === 'object' ? flatten(v.props?.children) : v == null ? '' : String(v); return flatten(n.props.children);}
  function button(text) {const n = nodes().find(n => n.type === 'button' && (label(n) === text || n.props['aria-label'] === text)); assert.ok(n, 'Missing button ' + text); return n;}
  function click(text) {const n = button(text); assert.equal(!!n.props.disabled, false, 'Disabled button ' + text); n.props.onClick(); render();}
  function forceClick(text) {const n = button(text); n.props.onClick(); render();}
  function field(name) {
    const div = nodes().find(n => n.type === 'div' && Array.isArray(n.props.children)
      && n.props.children.some(c => c && c.type === 'label' && label(c).includes(name))
      && n.props.children.some(c => c && c.type === 'input'));
    assert.ok(div, 'Missing metadata field ' + name);
    return div.props.children.find(c => c && c.type === 'input');
  }
  function typeInto(name, value) {const n = field(name); assert.equal(!!n.props.disabled, false, 'Disabled field ' + name);
    n.props.onChange({target: {value}}); render();}
  function labelledDivs(name, tag) {
    return nodes().filter(n => n.type === 'div' && Array.isArray(n.props.children)
      && n.props.children.some(c => c && c.type === 'label' && label(c).includes(name))
      && n.props.children.some(c => c && c.type === tag));
  }
  function itemNotesInput(index) {
    const inputs = nodes().filter(n => n.type === 'input' && String(n.props['aria-label'] || '').startsWith('Catatan item'));
    assert.ok(inputs[index], 'Missing item notes input #' + index);
    return inputs[index];
  }
  function typeItemNotes(index, value) {
    const n = itemNotesInput(index);
    assert.equal(!!n.props.disabled, false, 'Disabled item notes #' + index);
    n.props.onChange({target: {value}}); render();
  }
  function itemDiscount(index) {
    const sels = nodes().filter(n => n.type === 'select' && String(n.props['aria-label'] || '').startsWith('Satuan diskon item'));
    assert.ok(sels[index], 'Missing item discount select #' + index);
    return sels[index];
  }
  function setItemDiscount(index, type) {
    const sel = itemDiscount(index);
    assert.equal(!!sel.props.disabled, false, 'Disabled item discount #' + index);
    sel.props.onChange({target: {value: type}}); render();
  }
  function itemDiscountValue(index) {
    const inputs = nodes().filter(n => n.type === 'input' && String(n.props['aria-label'] || '').startsWith('Nilai diskon item'));
    assert.ok(inputs[index], 'Missing item discount value #' + index);
    return inputs[index];
  }
  function setItemDiscountValue(index, value) {
    const n = itemDiscountValue(index);
    n.props.onChange({target: {value}}); render();
  }
  function removeLine(index) {
    const btns = nodes().filter(n => n.type === 'button' && (String(n.props['aria-label'] || '').startsWith('Hapus item') || label(n) === 'Hapus'));
    assert.ok(btns[index], 'Missing Hapus button #' + index);
    assert.equal(!!btns[index].props.disabled, false);
    btns[index].props.onClick(); render();
  }
  function baruCount() {return nodes().filter(n => n.type === 'span' && label(n) === 'BARU').length;}
  function qtyButtons(aria) {return nodes().filter(n => n.type === 'button' && n.props['aria-label'] === aria);}
  function incQty(index = 0) {const n = qtyButtons('Tambah jumlah')[index]; assert.ok(n, 'Missing qty + button');
    assert.equal(!!n.props.disabled, false); n.props.onClick(); render();}
  function qtys() {return nodes().filter(n => n.type === 'span' && String(n.props.className || '').includes('w-8'))
    .map(n => Number(label(n)));}
  function menuSelect() {return null;}
  function addMenu(menuId) {
    const m = MENU.find(x => x.id === Number(menuId));
    assert.ok(m, 'Unknown menu id ' + menuId);
    const card = nodes().find(n => n.type === 'div' && typeof n.props.onClick === 'function' && label(n).includes(m.name));
    assert.ok(card, 'Missing menu card for ' + m.name);
    card.props.onClick(); render();
  }
  function text() {return nodes().map(n => typeof n.props.children === 'string' ? n.props.children : '').join('\n');}
  function hasText(substr) {return nodes().some(n => label(n).includes(substr));}
  function hasBaruBadge() {return nodes().some(n => n.type === 'span' && label(n) === 'BARU');}
  async function settle() {await new Promise(resolve => setImmediate(resolve)); render();
    await new Promise(resolve => setImmediate(resolve)); render();}
  async function settle2() {await settle(); await settle();}
  function openOrder() {click('Riwayat Order (1)'); click('POS-501');}
  render(); return {render, nodes, button, click, forceClick, field, typeInto, incQty, qtys,
    typeItemNotes, setItemDiscount, setItemDiscountValue, removeLine, baruCount,
    menuSelect, addMenu, text, hasText, hasBaruBadge, settle, settle2, openOrder, signals, log,
    changeProps(patch) {props = {...props, ...patch}; render();},
    cleanup() {slots.forEach(s => s?.cleanup?.());}};
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const MENU = [{id: 1, item_code: 'CF', name: 'Coffee', price: 13000},
  {id: 2, item_code: 'TE', name: 'Tea', price: 10000}];
const ORDER = {id: 501, order_number: 'POS-501', status: 'OPEN', total_amount: '26000',
  table_number: 'A1', guest_name: 'Budi'};

const line = (id, menuItemId, quantity, extra = {}) => ({
  id, menu_item_id: menuItemId, quantity, notes: null, discount_type: null,
  discount_value: null, unit_price: menuItemId === 1 ? 13000 : 10000,
  item_name_snapshot: menuItemId === 1 ? 'Coffee' : 'Tea', item_code_snapshot: 'X',
  ...extra,
});

function detail({version = 1, status = 'OPEN', items = [line(9001, 1, 1)], guestName = 'Budi',
  tableNumber = 'A1', notes = null} = {}) {
  return json({status: 'OK', data: {
    order: {id: 501, property_id: 7, order_number: 'POS-501', status, version,
      total_amount: '26000', table_number: tableNumber, guest_name: guestName,
      guest_phone: '+62811', notes, discount_reason: null, discount_type: null,
      discount_value: null, reservation_id: null,
      service_charge_enabled_snapshot: false, service_charge_percent_snapshot: 0,
      tax_enabled_snapshot: false, tax_percent_snapshot: 0},
    items,
  }});
}
const putOk = (version, total) => json({status: 'OK', replayed: false,
  data: {order: {id: 501, total_amount: total, version}}});
const idr = n => new Intl.NumberFormat('id-ID', {style: 'currency', currency: 'IDR',
  maximumFractionDigits: 0}).format(n);

// ── Skenario ─────────────────────────────────────────────────────────────────
(async () => {
  console.log('=== POS-EDIT-1B (P3): GET sync vs draft race — KOMPONEN AKTUAL ===\n');

  // R1 — GET awal saat membuka order tetap bekerja.
  await check('R1: GET awal membuka order men-seed draft (qty, metadata, version)', async () => {
    const h = harness({get: () => detail({items: [line(9001, 1, 2), line(9002, 2, 3)]}),
      put: () => putOk(1, 26000), post: () => json({}, 500)});
    h.openOrder(); await h.settle2();
    assert.deepEqual(h.qtys(), [2, 3], 'quantity hasil GET awal harus tampil');
    assert.equal(h.field('Nama Tamu').props.value, 'Budi');
    assert.ok(h.hasText('v1'), 'version badge v1 tampil');
    assert.equal(h.hasText('Memuat detail order'), false, 'loading harus berakhir');
    h.cleanup();
  });

  // R2 — Tanpa perubahan draft: GET pasca-PUT menyinkronkan qty/total/version.
  await check('R2: GET pasca-PUT tanpa perubahan draft menyinkronkan quantity, total, version', async () => {
    const h = harness({
      get: ({n}) => (n === 1 ? detail({items: [line(9001, 1, 1), line(9002, 2, 1)]})
        : detail({version: 2, items: [line(9001, 1, 2), line(9002, 2, 3)]})),
      put: () => putOk(2, 53000), post: () => json({}, 500)});
    h.openOrder(); await h.settle2();
    assert.deepEqual(h.qtys(), [1, 1]);
    h.click('Simpan'); await h.settle2(); await h.settle2();
    assert.deepEqual(h.qtys(), [2, 3], 'draft harus di-reseed dari GET sinkronisasi');
    assert.ok(h.hasText('v2'), 'version server (v2) diterapkan');
    assert.ok(h.hasText(idr(53000)), 'total versi server ditampilkan');
    assert.equal(h.hasText('Draft Anda berubah'), false, 'tanpa perubahan draft tidak ada sync warning');
    h.cleanup();
  });

  // R3 — Quantity berubah selama GET sinkronisasi in-flight.
  await check('R3: quantity diubah selama GET in-flight TIDAK tertimpa respons lama', async () => {
    const d = deferred();
    const h = harness({
      get: ({n}) => (n === 1 ? detail({items: [line(9001, 1, 1)]}) : d.promise),
      put: () => putOk(2, 26000), post: () => json({}, 500)});
    h.openOrder(); await h.settle2();
    h.incQty(0);                                  // draft qty 2
    h.click('Simpan Perubahan'); await h.settle2();          // PUT sukses → GET sync in-flight
    assert.equal(h.hasText('Memuat detail order'), true, 'GET sinkronisasi benar-benar in-flight');
    h.incQty(0);                                  // draft qty 3 SELAMA GET
    assert.deepEqual(h.qtys(), [3]);
    d.resolve(detail({version: 2, items: [line(9001, 1, 2)]})); // server masih qty 2
    await h.settle2();
    assert.deepEqual(h.qtys(), [3], 'draft terbaru (qty 3) tidak boleh ditimpa snapshot server');
    assert.equal(h.hasText('Draft Anda berubah'), true, 'status sinkronisasi dilaporkan jujur');
    assert.equal(h.hasText('Memuat detail order'), false, 'loading tetap berakhir');
    assert.ok(h.hasText('v2'), 'version server tetap diterapkan');
    assert.ok(h.hasText('berhasil disimpan'), 'banner sukses PUT tetap tampil');
    h.cleanup();
  });

  // R4 — Metadata berubah selama GET sinkronisasi in-flight.
  await check('R4: metadata diubah selama GET in-flight TIDAK tertimpa respons lama', async () => {
    const d = deferred();
    const h = harness({
      get: ({n}) => (n === 1 ? detail({guestName: 'Budi'}) : d.promise),
      put: () => putOk(2, 26000), post: () => json({}, 500)});
    h.openOrder(); await h.settle2();
    h.typeInto('Nama Tamu', 'Budi');               // draft = nilai server (belum berubah)
    h.click('Simpan Perubahan'); await h.settle2();          // GET sync in-flight
    h.typeInto('Nama Tamu', 'Siti');               // draft berubah selama GET
    d.resolve(detail({version: 2, guestName: 'Server Name'}));
    await h.settle2();
    assert.equal(h.field('Nama Tamu').props.value, 'Siti', 'metadata draft pengguna dipertahankan');
    assert.equal(h.hasText('Draft Anda berubah'), true, 'sync warning tampil');
    assert.equal(h.hasText('Memuat detail order'), false, 'loading berakhir');
    h.cleanup();
  });

  // R5 — Editor ditutup sebelum GET selesai.
  await check('R5: editor ditutup saat GET in-flight → respons lama diabaikan, editor tidak terbuka lagi', async () => {
    const d = deferred();
    const h = harness({
      get: ({n}) => (n === 1 ? detail({items: [line(9001, 1, 1)]}) : d.promise),
      put: () => putOk(2, 26000), post: () => json({}, 500)});
    h.openOrder(); await h.settle2();
    h.click('Simpan'); await h.settle2();
    assert.equal(h.hasText('Memuat detail order'), true, 'GET sync in-flight');
    // Navigasi tidak boleh dikunci selama editLoading (epoch guard yang menangani).
    const back = h.button('Batalkan edit pesanan');
    assert.equal(!!back.props.disabled, false, 'Batalkan edit pesanan TIDAK disabled saat editLoading');
    h.click('Batalkan edit pesanan'); await h.settle2();
    assert.equal(h.nodes().some(n => n.type === 'button' && n.props['aria-label'] === 'Batalkan edit pesanan'), false, 'editor tertutup');
    assert.ok(h.hasText('POS-501'), 'daftar riwayat tampil kembali');
    d.resolve(detail({version: 2, items: [line(9001, 1, 5)]}));
    await h.settle2();
    assert.equal(h.nodes().some(n => n.type === 'button' && n.props['aria-label'] === 'Batalkan edit pesanan'), false, 'respons GET lama tidak membuka editor kembali');
    assert.equal(h.hasText('Item Pesanan'), false, 'state editor tidak dihidupkan lagi');
    assert.equal(h.hasText('Memuat detail order'), false, 'loading tidak tersisa');
    h.cleanup();
  });

  // R6 — PUT sukses + GET gagal.
  await check('R6: PUT sukses + GET gagal → banner sukses dipertahankan, warning sync (bukan editError)', async () => {
    const h = harness({
      get: ({n}) => (n === 1 ? detail({items: [line(9001, 1, 1)]})
        : json({status: 'ERROR', message: 'detail tidak tersedia'}, 500)),
      put: () => putOk(2, 26000), post: () => json({}, 500)});
    h.openOrder(); await h.settle2();
    h.click('Simpan'); await h.settle2(); await h.settle2();
    assert.ok(h.hasText('berhasil disimpan'), 'banner sukses PUT tetap tampil');
    assert.ok(h.hasText('detail tidak tersedia'), 'pesan kegagalan GET tampil');
    assert.equal(h.hasText('Gagal memuat detail order (HTTP 500)'), false,
      'kegagalan GET sinkronisasi TIDAK memakai pesan editError generik');
    assert.equal(h.hasText('Memuat detail order'), false, 'loading berakhir');
    assert.deepEqual(h.qtys(), [1], 'draft tidak dihapus saat GET gagal');
    // P3c: kegagalan GET membersihkan penanda sinkron. Karena PUT ini TIDAK
    // mengirim item baru, identitas tidak bermasalah → simpan lanjutan boleh.
    h.incQty(0);
    assert.equal(h.hasText('belum tersimpan'), true, 'perubahan draft setelah GET gagal tetap dihitung belum tersimpan');
    const follow = h.button('Simpan Perubahan');
    assert.equal(!!follow.props.disabled, false,
      'tanpa item baru, kegagalan GET tidak boleh memblokir simpan lanjutan');
    assert.equal(h.hasText('Penyimpanan lanjutan diblokir'), false,
      'tidak ada pemblokiran unresolved bila PUT tidak mengirim item baru');
    h.cleanup();
  });

  // R7 — Double-submit.
  await check('R7: klik Simpan dua kali saat PUT in-flight → hanya 1 PUT', async () => {
    const d = deferred();
    const h = harness({
      get: ({n}) => (n === 1 ? detail({items: [line(9001, 1, 1)]}) : detail({version: 2})),
      put: () => d.promise, post: () => json({}, 500)});
    h.openOrder(); await h.settle2();
    h.click('Simpan');
    await new Promise(r => setImmediate(r)); h.render();
    h.forceClick('Menyimpan…');                    // bypass tombol disabled → uji guard handler
    await h.settle2();
    assert.equal(h.log.puts.length, 1, 'submit kedua harus ditolak editSubmittingRef');
    d.resolve(putOk(2, 26000));
    await h.settle2(); await h.settle2();
    assert.equal(h.log.puts.length, 1, 'tidak ada PUT tambahan setelah selesai');
    assert.ok(h.hasText('berhasil disimpan'));
    h.cleanup();
  });

  // R8 — Retry idempotency setelah 5xx.
  await check('R8: retry setelah 5xx memakai idempotency_key + body identik', async () => {
    const h = harness({
      get: ({n}) => (n === 1 ? detail({items: [line(9001, 1, 1)]}) : detail({version: 2})),
      put: ({n}) => (n === 1 ? json({status: 'ERROR', message: 'server sibuk'}, 500) : putOk(2, 26000)),
      post: () => json({}, 500)});
    h.openOrder(); await h.settle2();
    h.incQty(0);
    h.click('Simpan Perubahan'); await h.settle2();
    assert.equal(h.log.puts.length, 1);
    assert.ok(h.hasText('Coba Lagi (retry identik)'), 'tombol retry identik tampil');
    h.click('Coba Lagi (retry identik)'); await h.settle2();
    assert.equal(h.log.puts.length, 2, 'retry benar-benar dikirim');
    const b1 = JSON.parse(h.log.puts[0].body), b2 = JSON.parse(h.log.puts[1].body);
    assert.equal(b2.idempotency_key, b1.idempotency_key, 'idempotency_key retry harus sama');
    assert.equal(h.log.puts[1].body, h.log.puts[0].body, 'body retry identik byte-per-byte');
    assert.equal(b2.items[0].quantity, 2, 'quantity draft ikut tersimpan di payload retry');
    h.cleanup();
  });

  // R9 — Stale closure: payload memakai draft terbaru.
  await check('R9: payload PUT memakai quantity draft terbaru (stale closure)', async () => {
    const h = harness({
      get: ({n}) => (n === 1 ? detail({items: [line(9001, 1, 1)]}) : detail({version: 2})),
      put: () => putOk(2, 39000), post: () => json({}, 500)});
    h.openOrder(); await h.settle2();
    h.incQty(0); h.incQty(0);                      // 1 → 3
    assert.deepEqual(h.qtys(), [3]);
    h.click('Simpan Perubahan'); await h.settle2();
    const body = JSON.parse(h.log.puts[0].body);
    assert.equal(body.items[0].quantity, 3, 'payload harus memakai qty 3, bukan closure lama');
    assert.equal(body.items[0].id, 9001, 'identitas item existing (pos_order_items.id) dipertahankan');
    assert.equal(body.expected_version, 1, 'expected_version dari detail awal');
    h.cleanup();
  });

  // R10 — CREATE flow tetap berjalan.
  await check('R10: alur CREATE (POST /api/pos/orders) tetap berjalan', async () => {
    const h = harness({
      get: () => detail({}),
      put: () => putOk(1, 13000),
      post: ({init}) => {const b = JSON.parse(init.body);
        return json({status: 'SUCCESS', data: {id: 777, property_id: b.property_id,
          order_number: 'POS-777', status: 'OPEN', total_amount: '13000'}}, 201);}});
    // Tab Kasir: klik menu Coffee lalu simpan pesanan.
    const coffee = h.nodes().find(n => n.type === 'div' && typeof n.props.onClick === 'function'
      && h.nodes().length && JSON.stringify(n.props.children || '').includes('Coffee'));
    assert.ok(coffee, 'kartu menu Coffee tersedia');
    coffee.props.onClick(); h.render();
    await h.settle2();
    h.click('Simpan Pesanan'); await h.settle2();
    assert.equal(h.log.posts.length, 1, 'CREATE mengirim tepat 1 POST');
    assert.equal(h.signals.created.length, 1, 'onOrderCreated tetap dipanggil');
    assert.equal(h.log.puts.length, 0, 'CREATE tidak menyentuh jalur PUT edit');
    h.cleanup();
  });

  // R11 — Draft dipertahankan + identitas item baru direkonsiliasi.
  await check('R11: item baru di draft mendapat id server setelah respons sync basi ditolak', async () => {
    const d = deferred();
    const h = harness({
      get: ({n}) => (n === 1 ? detail({items: [line(9001, 1, 1)]}) : d.promise),
      put: () => putOk(2, 23000), post: () => json({}, 500)});
    h.openOrder(); await h.settle2();
    h.addMenu(2);                                   // baris BARU (belum punya id)
    assert.equal(h.hasBaruBadge(), true, 'baris item baru ditandai BARU');
    h.click('Simpan Perubahan'); await h.settle2();           // PUT membuat item baru di server
    h.incQty(1);                                    // draft berubah selama GET → snapshot ditolak
    d.resolve(detail({version: 2, items: [line(9001, 1, 1), line(9002, 2, 1)]}));
    await h.settle2();
    assert.equal(h.hasText('Draft Anda berubah'), true, 'snapshot server tidak diterapkan');
    assert.equal(h.hasBaruBadge(), false,
      'orderItemId baris baru direkonsiliasi dari items[] server (tidak akan INSERT duplikat)');
    assert.deepEqual(h.qtys(), [1, 2], 'draft pengguna tetap utuh');
    h.cleanup();
  });

  // R12 — Simpan lanjutan pada order yang sama setelah PUT sukses.
  await check('R12: PUT#1 sukses, draft berubah selama GET → perubahan lanjutan tersimpan aman ke order yang sama', async () => {
    const d = deferred();
    const h = harness({
      get: ({n}) => (n === 1 ? detail({items: [line(9001, 1, 1)]})
        : n === 2 ? d.promise
        : detail({version: 3, items: [line(9001, 1, 4)]})),
      put: ({n}) => (n === 1 ? putOk(2, 26000) : putOk(3, 26000)), post: () => json({}, 500)});
    h.openOrder(); await h.settle2();
    h.incQty(0);                                    // draft qty 2
    h.click('Simpan Perubahan'); await h.settle2();           // PUT#1 200 → GET sync in-flight
    assert.equal(h.hasText('Memuat detail order'), true, 'GET sinkronisasi benar-benar in-flight');
    h.incQty(0);                                    // draft qty 3 SELAMA GET
    d.resolve(detail({version: 2, items: [line(9001, 1, 2)]}));
    await h.settle2();
    assert.deepEqual(h.qtys(), [3], 'draft pengguna dipertahankan (bukan snapshot server qty 2)');
    assert.ok(h.hasText('berhasil disimpan'), 'keberhasilan PUT sebelumnya tetap ditampilkan');
    assert.ok(h.hasText('belum tersimpan'), 'perubahan draft sesudah PUT dibedakan sebagai belum tersimpan');
    assert.equal(h.hasText('Memuat detail order'), false, 'loading berakhir');
    const follow = h.button('Simpan Perubahan');
    assert.equal(!!follow.props.disabled, false, 'tombol simpan lanjutan tersedia dan aktif');
    h.click('Simpan Perubahan'); await h.settle2(); await h.settle2(); await h.settle2();
    assert.equal(h.log.puts.length, 2, 'perubahan lanjutan benar-benar dikirim sebagai PUT kedua');
    const b1 = JSON.parse(h.log.puts[0].body), b2 = JSON.parse(h.log.puts[1].body);
    assert.equal(b2.expected_version, 2, 'PUT kedua memakai versi server hasil PUT pertama (bukan versi basi)');
    assert.equal(b2.items.length, 1);
    assert.equal(b2.items[0].id, 9001, 'identitas item existing tetap aman');
    assert.equal(b2.items[0].quantity, 3, 'quantity lanjutan ikut tersimpan');
    assert.notEqual(b2.idempotency_key, b1.idempotency_key, 'siklus PUT baru memakai idempotency_key baru');
    assert.equal(h.hasText('belum tersimpan'), false, 'setelah simpan lanjutan + sync bersih, status kembali tersimpan');
    assert.deepEqual(h.qtys(), [4], 'GET sync pasca-PUT kedua men-seed ulang draft');
    h.cleanup();
  });

  // R13 — Item lama dihapus lalu menu sama ditambahkan selama GET.
  await check('R13: item lama dihapus + menu sama ditambahkan selama GET → baris pengganti TIDAK menerima id item lama', async () => {
    const d = deferred();
    const h = harness({
      get: ({n}) => (n === 1 ? detail({items: [line(9001, 1, 1)]})
        : n === 2 ? d.promise
        : detail({version: 3, items: [line(9502, 1, 1)]})),
      put: ({n}) => (n === 1 ? putOk(2, 26000) : putOk(3, 26000)), post: () => json({}, 500)});
    h.openOrder(); await h.settle2();
    h.incQty(0);
    h.click('Simpan Perubahan'); await h.settle2();           // PUT#1 hanya berisi item existing 9001
    h.addMenu(1);                                   // baris Coffee BARU (tanpa id)
    h.removeLine(0);                                // item lama (9001) dihapus SELAMA GET
    assert.deepEqual(h.qtys(), [1]);
    d.resolve(detail({version: 2, items: [line(9001, 1, 2)]})); // server masih punya 9001
    await h.settle2();
    assert.equal(h.baruCount(), 1, 'baris pengganti tetap tanpa id (badge BARU)');
    h.click('Simpan Perubahan'); await h.settle2(); await h.settle2(); await h.settle2();
    const b2 = JSON.parse(h.log.puts[1].body);
    assert.equal(b2.items.length, 1);
    assert.equal('id' in b2.items[0], false, 'id item lama (9001) TIDAK boleh dipakai baris pengganti');
    assert.equal(b2.items[0].menu_item_id, 1);
    h.cleanup();
  });

  // R14 — Beberapa baris menu sama dengan notes/diskon berbeda.
  await check('R14: beberapa baris menu sama dengan notes/diskon berbeda tidak tertukar', async () => {
    const d = deferred();
    const h = harness({
      get: ({n}) => (n === 1 ? detail({items: [line(9001, 1, 1)]})
        : n === 2 ? d.promise
        : detail({version: 3, items: [line(9001, 1, 1)]})),
      put: ({n}) => (n === 1 ? putOk(2, 33000) : putOk(3, 33000)), post: () => json({}, 500)},
      {canDiscountPos: true});
    h.openOrder(); await h.settle2();
    h.addMenu(2); h.typeItemNotes(1, 'pedas');
    h.addMenu(2); h.typeItemNotes(2, 'manis');
    // Diskon hanya pada baris "manis" (order-level diskon tidak dipakai di test ini).
    h.setItemDiscount(2, 'NOMINAL'); h.setItemDiscountValue(2, '1000');
    assert.equal(h.baruCount(), 2);
    h.click('Simpan Perubahan'); await h.settle2();           // PUT#1 membuat 2 item baru
    h.incQty(0);                                    // draft berubah selama GET
    // Server mengembalikan urutan item baru TERBALIK (9502 lebih dulu).
    d.resolve(detail({version: 2, items: [
      line(9001, 1, 1),
      line(9502, 2, 1, {notes: 'manis', discount_type: 'NOMINAL', discount_value: 1000}),
      line(9501, 2, 1, {notes: 'pedas'}),
    ]}));
    await h.settle2();
    assert.equal(h.baruCount(), 0, 'kedua baris item baru mendapat id');
    h.click('Simpan Perubahan'); await h.settle2(); await h.settle2(); await h.settle2();
    const b2 = JSON.parse(h.log.puts[1].body);
    const pedas = b2.items.find(i => i.notes === 'pedas');
    const manis = b2.items.find(i => i.notes === 'manis');
    assert.ok(pedas && manis, 'kedua baris tetap ada di payload');
    assert.equal(pedas.id, 9501, 'baris "pedas" mendapat id item 9501 (tidak tertukar)');
    assert.equal(manis.id, 9502, 'baris "manis" (diskon NOMINAL 1000) mendapat id item 9502');
    h.cleanup();
  });

  // R15 — Baris yang lahir setelah snapshot PUT.
  await check('R15: baris setelah snapshot PUT tetap dibedakan dari baris yang sudah disimpan PUT', async () => {
    const d = deferred();
    const h = harness({
      get: ({n}) => (n === 1 ? detail({items: [line(9001, 1, 1)]})
        : n === 2 ? d.promise
        : detail({version: 3, items: [line(9001, 1, 1), line(9501, 2, 1), line(9503, 2, 1)]})),
      put: ({n}) => (n === 1 ? putOk(2, 23000) : putOk(3, 33000)), post: () => json({}, 500)});
    h.openOrder(); await h.settle2();
    h.addMenu(2);                                   // Tea#1 — masuk snapshot PUT#1
    h.click('Simpan Perubahan'); await h.settle2();           // PUT#1 + GET sync in-flight
    h.addMenu(2);                                   // Tea#2 — lahir SESUDAH snapshot
    d.resolve(detail({version: 2, items: [line(9001, 1, 1), line(9501, 2, 1)]}));
    await h.settle2();
    assert.equal(h.baruCount(), 1, 'hanya baris yang lahir setelah snapshot yang tetap BARU');
    h.click('Simpan Perubahan'); await h.settle2(); await h.settle2(); await h.settle2();
    const b2 = JSON.parse(h.log.puts[1].body);
    assert.equal(b2.items.length, 3);
    assert.equal(b2.items[0].id, 9001);
    assert.equal(b2.items[1].id, 9501, 'baris yang disimpan PUT#1 dikenali id-nya');
    assert.equal('id' in b2.items[2], false, 'baris setelah snapshot tidak diberi id tebakan');
    assert.equal(b2.items[2].menu_item_id, 2);
    h.cleanup();
  });

  // R16 — Respons tidak cukup untuk memastikan pemetaan identitas.
  await check('R16: pemetaan identitas tidak pasti → simpan diblokir eksplisit, draft tetap aman', async () => {
    const d = deferred();
    const h = harness({
      get: ({n}) => (n === 1 ? detail({items: [line(9001, 1, 1)]})
        : n === 2 ? d.promise
        : detail({version: 3, items: [line(9001, 1, 1), line(9501, 2, 1)]})),
      put: ({n}) => (n === 1 ? putOk(2, 33000) : putOk(3, 33000)), post: () => json({}, 500)});
    h.openOrder(); await h.settle2();
    h.addMenu(2); h.addMenu(2);                     // dua baris Tea identik (signature sama)
    h.click('Simpan Perubahan'); await h.settle2();           // PUT#1 membuat 2 item baru
    h.incQty(0);                                    // draft berubah selama GET
    // Server hanya mengembalikan SATU kandidat item baru → jumlah tidak cocok.
    d.resolve(detail({version: 2, items: [line(9001, 1, 1), line(9501, 2, 1)]}));
    await h.settle2();
    assert.ok(h.hasText('Identitas item baru tidak dapat dipastikan'), 'penanganan eksplisit ditampilkan');
    assert.deepEqual(h.qtys(), [2, 1, 1], 'draft dipertahankan utuh');
    const blocked = h.button('Simpan Perubahan');
    assert.equal(!!blocked.props.disabled, true, 'tombol simpan diblokir (bukan menebak identitas)');
    h.forceClick('Simpan Perubahan'); await h.settle2();
    assert.equal(h.log.puts.length, 1, 'handler menolak simpan saat identitas belum pasti');
    h.click('Muat Ulang Detail'); await h.settle2(); await h.settle2();
    assert.equal(h.hasText('Identitas item baru tidak dapat dipastikan'), false,
      'muat ulang detail memulihkan siklus edit');
    h.cleanup();
  });

  // R17 — PUT membuat item baru + GET sinkronisasi gagal (kegagalan GET ≠ PUT).
  await check('R17: PUT membuat item baru + GET sync gagal → simpan lanjutan diblokir, PUT pertama tetap sukses', async () => {
    const h = harness({
      get: ({n}) => (n === 1 ? detail({items: [line(9001, 1, 1)]})
        : n === 2 ? json({status: 'ERROR', message: 'detail tidak tersedia'}, 500)
        : detail({version: 2, items: [line(9001, 1, 1), line(9501, 2, 1)]})),
      put: ({n}) => (n === 1 ? putOk(2, 23000) : putOk(3, 23000)), post: () => json({}, 500)});
    h.openOrder(); await h.settle2();
    h.addMenu(2);                                   // item BARU ikut terkirim di PUT#1
    h.click('Simpan Perubahan'); await h.settle2(); await h.settle2();
    assert.ok(h.hasText('berhasil disimpan'), 'banner sukses PUT pertama tetap tampil (GET gagal ≠ PUT gagal)');
    assert.ok(h.hasText('detail tidak tersedia'), 'kegagalan GET dilaporkan sebagai warning sinkronisasi');
    assert.equal(h.hasText('Gagal memuat detail order (HTTP 500)'), false,
      'kegagalan GET tidak memakai pesan editError generik');
    assert.ok(h.hasText('Penyimpanan lanjutan diblokir'), 'alasan pemblokiran ditampilkan');
    // Pengguna mengubah draft setelah GET gagal.
    h.incQty(0);
    assert.deepEqual(h.qtys(), [2, 1], 'draft pengguna tetap utuh');
    const blocked = h.button('Simpan Perubahan');
    assert.equal(!!blocked.props.disabled, true, 'tombol simpan lanjutan diblokir lewat tombol');
    h.forceClick('Simpan Perubahan'); await h.settle2();
    assert.equal(h.log.puts.length, 1,
      'guard handler menolak PUT lanjutan — item tersimpan tidak dikirim ulang sebagai item tanpa ID');
    assert.ok(h.hasText('berhasil disimpan'), 'banner PUT pertama tetap sukses setelah percobaan simpan');
    // Jalur pemulihan eksplisit.
    h.click('Muat Ulang Detail'); await h.settle2(); await h.settle2();
    assert.equal(h.hasText('Penyimpanan lanjutan diblokir'), false, 'pemblokiran dibuka setelah sinkronisasi berhasil');
    assert.deepEqual(h.qtys(), [1, 1], 'draft di-seed ulang dari server setelah pemulihan');
    h.cleanup();
  });

  // R18 — Simpan lanjutan saat GET sinkronisasi masih in-flight.
  await check('R18: simpan lanjutan diblokir SINKRON selama GET in-flight, aktif lagi setelah identitas aman', async () => {
    const d = deferred();
    const h = harness({
      get: ({n}) => (n === 1 ? detail({items: [line(9001, 1, 1)]})
        : n === 2 ? d.promise
        : detail({version: 3, items: [line(9001, 1, 2), line(9501, 2, 1)]})),
      put: ({n}) => (n === 1 ? putOk(2, 23000) : putOk(3, 33000)), post: () => json({}, 500)});
    h.openOrder(); await h.settle2();
    h.addMenu(2);                                    // item BARU ikut PUT#1
    h.click('Simpan Perubahan'); await h.settle2();            // PUT#1 200 → GET sync in-flight
    assert.equal(h.hasText('Memuat detail order'), true, 'GET sinkronisasi benar-benar in-flight');
    h.incQty(0);                                     // draft berubah SELAMA GET
    assert.deepEqual(h.qtys(), [2, 1], 'draft tetap boleh diedit selama GET');
    const blocked = h.button('Simpan Perubahan');
    assert.equal(!!blocked.props.disabled, true, 'tombol simpan lanjutan disabled selama GET in-flight');
    assert.ok(h.hasText('belum tersimpan'), 'status draft belum tersimpan tetap dilaporkan');
    assert.ok(h.hasText('Sinkronisasi detail masih berjalan'), 'alasan penundaan simpan ditampilkan');
    h.forceClick('Simpan Perubahan'); await h.settle2();
    assert.equal(h.log.puts.length, 1, 'guard handler SINKRON menolak PUT#2 selama GET in-flight');
    assert.ok(h.hasText('berhasil disimpan'), 'banner PUT#1 tetap sukses');
    assert.deepEqual(h.qtys(), [2, 1], 'draft tetap utuh setelah percobaan simpan');
    // GET selesai dengan ID valid → identitas item baru aman.
    d.resolve(detail({version: 2, items: [line(9001, 1, 1), line(9501, 2, 1)]}));
    await h.settle2();
    assert.equal(h.hasText('Memuat detail order'), false, 'sinkronisasi selesai');
    assert.equal(h.baruCount(), 0, 'identitas item baru berhasil dipastikan');
    const follow = h.button('Simpan Perubahan');
    assert.equal(!!follow.props.disabled, false, 'simpan lanjutan aktif setelah identitas aman');
    h.click('Simpan Perubahan'); await h.settle2(); await h.settle2(); await h.settle2();
    assert.equal(h.log.puts.length, 2, 'PUT#2 dikirim setelah sinkronisasi selesai');
    const b1 = JSON.parse(h.log.puts[0].body), b2 = JSON.parse(h.log.puts[1].body);
    assert.equal(b2.expected_version, 2, 'expected_version memakai versi server hasil PUT#1');
    assert.equal(b2.items.find(i => i.menu_item_id === 2).id, 9501,
      'item baru memakai ID server (tidak dikirim ulang tanpa ID)');
    assert.equal(b2.items.find(i => i.menu_item_id === 1).id, 9001, 'identitas item existing tetap aman');
    assert.notEqual(b2.idempotency_key, b1.idempotency_key, 'siklus baru memakai idempotency_key baru');
    h.cleanup();
  });

  console.log(`\n[RESULT] ${pass} PASS, ${fail} FAIL`);  if (fail > 0) {failures.forEach(f => console.error('  FAILED: ' + f.name)); process.exitCode = 1;}
})().catch(err => {console.error('[FATAL]', err); process.exitCode = 1;});

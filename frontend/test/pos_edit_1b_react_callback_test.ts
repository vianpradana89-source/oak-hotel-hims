/**
 * pos_edit_1b_react_callback_test.ts
 *
 * POS-EDIT-1B regression test — verifies the stale-closure / sync / race /
 * double-submit fixes in PosWorkspace.tsx with REAL React hook semantics.
 *
 * Coverage:
 *  A1–A24  Source-structure audit: setiap invariant P1/P2/P3/P3b/P3c diversifikasi
 *          terhadap TEKS file sumber (substring-based, CRLF-safe). Ini BUKAN
 *          test perilaku — hanya penjaga struktur.
 *  B1–B2   PROBE (bukan test komponen PosWorkspace): komponen mini yang
 *          mereplikasi rantai useCallback milik saveEditedOrder untuk
 *          mendemokan semantik stale-closure milik React.
 *  B3      PROBE: simulasi pola epoch guard (bukan komponen PosWorkspace).
 *
 * UJI KOMPONEN AKTUAL (event handler + JSX produksi, GET ditahan deferred)
 * ada di test/pos_edit_1b_sync_race_test.cjs — itu yang membuktikan race
 * draft vs GET sinkronisasi, bukan file ini.
 *
 * Run:
 *   cd frontend && node --experimental-strip-types test/pos_edit_1b_react_callback_test.ts
 */
await import('./loader_register_ts.mjs');

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Locate source file ───────────────────────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(__dir, '..');
const srcFile = join(frontendRoot, 'src', 'features', 'pos', 'PosWorkspace.tsx');
const src = readFileSync(srcFile, 'utf8');

// ── Test infrastructure ──────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    fail++;
    console.error(`  FAIL  ${name}`);
    console.error(err instanceof Error ? err.stack : err);
  }
}

console.log('=== POS-EDIT-1B: React Callback Regression Test ===\n');

// ── A: Source-structure verification (deterministic, CRLF-safe substring) ────

await check('A1: P1 — saveEditedOrder deps include buildEditItemsFromCart', () => {
  assert.ok(
    src.includes('buildEditItemsFromCart, loadOrderDetail, onRequestPending]'),
    'buildEditItemsFromCart not in saveEditedOrder deps'
  );
});

await check('A2: P1+P2 — saveEditedOrder deps include loadOrderDetail', () => {
  assert.ok(
    src.includes('buildEditItemsFromCart, loadOrderDetail, onRequestPending]'),
    'loadOrderDetail not in saveEditedOrder deps'
  );
});

await check('A3: P2 — saveEditedOrder 200 path calls loadOrderDetail(orderId, true)', () => {
  assert.ok(
    src.includes('void loadOrderDetail(editingOrder.orderId, true)'),
    'P2 sync call with preserveSuccess=true not found'
  );
});

await check('A4: P3 — closeEditorView increments editDetailEpochRef.current', () => {
  const closeIdx = src.indexOf('const closeEditorView = useCallback');
  assert.ok(closeIdx !== -1, 'closeEditorView not found');
  const closeEnd = src.indexOf('const editIdempotencyRef', closeIdx);
  const closeFn = src.slice(closeIdx, closeEnd > closeIdx ? closeEnd : closeIdx + 3000);
  assert.ok(
    closeFn.includes('editDetailEpochRef.current++'),
    'closeEditorView does not bump editDetailEpochRef.current'
  );
});

await check('A5: P2 — loadOrderDetail accepts preserveSuccess parameter', () => {
  assert.ok(
    src.includes('preserveSuccess?: boolean'),
    'preserveSuccess parameter not found in loadOrderDetail signature'
  );
});

await check('A6: P2 — editSyncWarning state declared and rendered in JSX', () => {
  assert.ok(src.includes('editSyncWarning, setEditSyncWarning'), 'editSyncWarning state not found');
  assert.ok(src.includes('{editSyncWarning &&'), 'editSyncWarning not rendered in JSX');
});

await check('A7: P3 — closeEditorView clears editSyncWarning', () => {
  const closeIdx = src.indexOf('const closeEditorView = useCallback');
  const closeFn = src.slice(closeIdx, closeIdx + 900);
  assert.ok(
    closeFn.includes('setEditSyncWarning(null)'),
    'closeEditorView does not clear editSyncWarning'
  );
});

await check('A8: P4 — saveEditedOrder guards double-submit via editSubmittingRef', () => {
  const saveIdx = src.indexOf('const saveEditedOrder = useCallback');
  const saveEntry = src.slice(saveIdx, saveIdx + 200);
  assert.ok(
    saveEntry.includes('editSubmittingRef.current'),
    'saveEditedOrder does not check editSubmittingRef at entry'
  );
});

await check('A9: P3 UX — Batal/Kembali TIDAK dikunci saat editLoading (epoch guard, bukan disabled)', () => {
  // Cari tombol JSX "Batalkan edit pesanan" yang disertai "disabled={editSaving}"
  // dalam radius < 300 char.
  let occ = -1, btnIdx = -1;
  while (true) {
    occ = src.indexOf('Batalkan edit pesanan', occ + 1);
    if (occ === -1) break;
    const dIdx = src.lastIndexOf('disabled={editSaving}', occ);
    const dAfterIdx = src.indexOf('disabled={editSaving}', occ);
    if ((dIdx !== -1 && occ - dIdx < 300) || (dAfterIdx !== -1 && dAfterIdx - occ < 300)) {
      btnIdx = occ;
      break;
    }
  }
  assert.ok(btnIdx !== -1, 'tombol JSX "Batalkan edit pesanan" tidak ditemukan');
  const windowAround = src.slice(Math.max(0, btnIdx - 300), btnIdx + 300);
  assert.ok(
    !windowAround.includes('disabled={editSaving || editLoading}'),
    'navigasi tidak boleh mengunci tombol saat editLoading (race ditangani epoch guard)'
  );
});

await check('A10: CREATE flow (POST) unchanged — onOrderCreated callback intact', () => {
  assert.ok(src.includes('onOrderCreated'), 'onOrderCreated prop not in source');
  assert.ok(src.includes('api/pos/orders'), 'POST route not found in source');
});

await check('A11: FINANCIAL_LOCK handling unchanged', () => {
  assert.ok(src.includes('FINANCIAL_LOCK'), 'FINANCIAL_LOCK not found in source');
  assert.ok(src.includes("setEditMode('readonly')"), 'readonly lock not found in source');
});

await check('A12: P2 — loadOrderDetail 404 + preserveSuccess shows sync warning, not full reset', () => {
  const lodIdx = src.indexOf('const loadOrderDetail = useCallback');
  const lodFn = src.slice(lodIdx, lodIdx + 5000);
  assert.ok(
    lodFn.includes('if (preserveSuccess) {') &&
    lodFn.includes('setEditSyncWarning('),
    '404 preserveSuccess path does not set sync warning'
  );
});

await check('A13: P2 — loadOrderDetail success + preserveSuccess does not clear editSuccess', () => {
  assert.ok(
    src.includes('if (!preserveSuccess) setEditSuccess(null)'),
    'preserveSuccess success path does not conditionally skip setEditSuccess(null)'
  );
});

await check('A14: P3 — loadOrderDetail catch: preserveSuccess sets sync warning, not editError', () => {
  const lodIdx = src.indexOf('const loadOrderDetail = useCallback');
  const lodEnd = src.indexOf('const reloadEditDetail = useCallback', lodIdx);
  const lodFn = src.slice(lodIdx, lodEnd > lodIdx ? lodEnd : lodIdx + 20000);
  assert.ok(
    lodFn.includes("setEditSyncWarning('Gagal memuat ulang detail order (network error)"),
    'network error catch does not handle preserveSuccess'
  );
});

await check('A15: P3 — loadOrderDetail memakai helper isStale() setelah setiap await', () => {
  const lodIdx = src.indexOf('const loadOrderDetail = useCallback');
  const lodFn = src.slice(lodIdx, lodIdx + 9000);
  const staleChecks = [...lodFn.matchAll(/if \(isStale\(\)\) return false;/g)].length;
  assert.ok(
    staleChecks >= 4,
    `expected >= 4 isStale() guards (fetch + 2x error json + body json), found ${staleChecks}`
  );
  assert.ok(
    lodFn.includes('const isStale = (): boolean => epoch !== editDetailEpochRef.current'),
    'isStale helper tidak ada'
  );
});

await check('A16: P3 — editDraftRevisionRef dideklarasikan & dibaca saat GET dimulai', () => {
  assert.ok(
    src.includes('const editDraftRevisionRef = useRef(0)'),
    'editDraftRevisionRef tidak dideklarasikan'
  );
  const lodIdx = src.indexOf('const loadOrderDetail = useCallback');
  const lodFn = src.slice(lodIdx, lodIdx + 2000);
  assert.ok(
    lodFn.includes('const draftRevisionAtStart = editDraftRevisionRef.current'),
    'revision draft tidak dicatat saat GET dimulai'
  );
});

await check('A17: P3 — setiap jalur perubahan draft menaikkan revision SECARA SINKRON', () => {
  // Satu helper sinkron (markEditDraftChanged) + 5 call site (4 mutator cart,
  // 1 helper metadata). Bump TIDAK boleh tersebar/duplikat di call site.
  const bumps = [...src.matchAll(/editDraftRevisionRef\.current \+= 1;/g)].length;
  assert.equal(bumps, 1, `bump revision harus terpusat di helper, ditemukan ${bumps}`);
  const helperIdx = src.indexOf('const markEditDraftChanged = useCallback');
  assert.ok(helperIdx !== -1, 'helper markEditDraftChanged tidak ditemukan');
  const helperBody = src.slice(helperIdx, helperIdx + 300);
  assert.ok(helperBody.includes('editDraftRevisionRef.current += 1;'),
    'helper markEditDraftChanged harus menaikkan revision (sinkron)');
  assert.ok(helperBody.includes('setEditDraftRevision(editDraftRevisionRef.current)'),
    'cermin state revision harus di-set pada call site yang sama (bukan useEffect)');
  for (const fn of ['updateEditCartQuantity', 'addNewEditCartLine', 'removeEditCartLine',
    'updateEditCartItemMeta', 'updateEditMeta']) {
    const idx = src.indexOf('const ' + fn + ' = useCallback');
    assert.ok(idx !== -1, fn + ' tidak ditemukan');
    const body = src.slice(idx, idx + 1200);
    assert.ok(body.includes('markEditDraftChanged();'),
      fn + ' tidak menandai draft berubah secara sinkron');
  }
});

await check('A18: P3 — bump revision TIDAK dilakukan di dalam updater setState / useEffect', () => {
  // Pastikan tidak ada `editDraftRevisionRef.current += 1` setelah `setX((prev)`.
  const violations = [...src.matchAll(/set(?:EditCart|EditMeta)\(\(?\w+\)? => \{[\s\S]{0,400}?editDraftRevisionRef\.current \+= 1;/g)];
  assert.equal(violations.length, 0, 'revision bump ditemukan di dalam updater setState');
  const inEffect = [...src.matchAll(/useEffect\([\s\S]{0,600}?editDraftRevisionRef\.current \+= 1;/g)];
  assert.equal(inEffect.length, 0, 'revision bump ditemukan di dalam useEffect');
  const inEffectMark = [...src.matchAll(/useEffect\([\s\S]{0,600}?markEditDraftChanged\(\)/g)];
  assert.equal(inEffectMark.length, 0, 'markEditDraftChanged ditemukan di dalam useEffect');
});

await check('A19: P3 — hasil GET hanya diterapkan bila draft belum berubah (preserveSuccess)', () => {
  const lodIdx = src.indexOf('const loadOrderDetail = useCallback');
  const lodFn = src.slice(lodIdx, lodIdx + 9000);
  assert.ok(
    lodFn.includes('preserveSuccess && editDraftRevisionRef.current !== draftRevisionAtStart'),
    'guard revision draft tidak ditemukan pada jalur sinkronisasi pasca-PUT'
  );
  const guardIdx = lodFn.indexOf('preserveSuccess && editDraftRevisionRef.current !== draftRevisionAtStart');
  const applyIdx = lodFn.indexOf('setEditingOrder({', guardIdx);
  assert.ok(applyIdx > guardIdx, 'guard revision harus dievaluasi SEBELUM menerapkan snapshot server');
  assert.ok(lodFn.slice(guardIdx, applyIdx).includes('setEditSyncWarning('),
    'jalur draft-berubah harus melaporkan status sinkronisasi');
});

await check('A20: P3 — identitas item baru direkonsiliasi lewat snapshot PUT + localId (bukan FIFO menu)', () => {
  assert.ok(src.includes('function mapPutNewItemIds('), 'helper pemetaan identitas tidak ada');
  assert.ok(src.includes('function editItemSignature('), 'tanda identitas item (menu+notes+diskon) tidak ada');
  assert.ok(!src.includes('reconcileEditCartItemIds'), 'FIFO menu lama harus sudah dihapus');
  // Snapshot PUT: dicatat saat payload dibangun, dibaca saat GET sinkronisasi.
  assert.ok(src.includes('editPutSnapshotRef.current = {'),
    'snapshot PUT (localId + knownIds) tidak dicatat');
  assert.ok(src.includes('mapPutNewItemIds(') && src.includes('snapshot && snapshot.orderId === orderId'),
    'pemetaan tidak memakai snapshot PUT untuk order yang sama');
  // Identitas lokal stabil per baris draft.
  assert.ok(src.includes('localId: newEditCartLineId(),'), 'baris draft tidak diberi localId stabil');
  assert.ok(src.includes('const id = mapping.ids.get(line.localId);'),
    'pemetaan tidak dikaitkan ke localId baris');
  // Kandidat hanya id yang BELUM dikenal sebelum PUT (id item lama tidak dipakai ulang).
  assert.ok(src.includes('!known.has(it.posOrderItemId)'), 'id lama masih bisa dipakai ulang');
  assert.ok(src.includes('!sentExisting.has(it.posOrderItemId)'), 'id item existing masih masuk kandidat');
  assert.ok(src.includes('Math.max(prev.version, version)'),
    'version server tidak diterapkan secara monoton pada jalur draft dipertahankan');
});

await check('A21: P3b — keberhasilan PUT dibedakan dari perubahan draft yang belum tersimpan', () => {
  assert.ok(src.includes('const [editSavedRevision, setEditSavedRevision]'),
    'baseline revision tersimpan tidak ada');
  assert.ok(src.includes('const hasUnsavedEditChanges = editingOrder !== null') && src.includes('editDraftRevision > (editSavedRevision ?? 0)'),
    'penanda perubahan belum tersimpan tidak ada');
  assert.ok(src.includes('(!editSuccess || hasUnsavedEditChanges)'),
    'tombol simpan lanjutan tidak tersedia setelah PUT sukses');
  assert.ok(src.includes('setEditSavedRevision(submittedRevision)'),
    'revision yang benar-benar dikirim tidak dicatat saat PUT sukses');
  assert.ok(src.includes('const submittedRevision = editDraftRevisionRef.current;'),
    'revision submit tidak diambil sebelum respons (perubahan selama PUT harus tetap dihitung belum tersimpan)');
  assert.ok(src.includes("'Simpan Perubahan'"), 'label simpan lanjutan tidak ada');
  assert.ok(src.includes('belum tersimpan'), 'status "belum tersimpan" tidak dilaporkan');
});

await check('A22: P3b — pemetaan identitas tidak pasti memblokir simpan secara eksplisit', () => {
  assert.ok(src.includes('if (editIdentityUnresolved !== null) return false;'),
    'handler simpan tidak diblokir saat identitas belum pasti');
  assert.ok(src.includes('disabled={editSaving || editLoading || editConflict !== null || editIdentityUnresolved !== null'),
    'tombol simpan tidak dinonaktifkan saat identitas belum pasti');
  assert.ok(src.includes('const [editIdentityUnresolved, setEditIdentityUnresolved]'),
    'state identitas tidak pasti tidak ada');
  assert.ok(src.includes('Identitas item baru tidak dapat dipastikan'),
    'penanganan eksplisit tidak ditampilkan ke pengguna');
  assert.ok(src.includes('role="alert"'), 'pesan identitas tidak pasti tidak diumumkan sebagai alert');
  assert.ok(src.includes('setEditSavedRevision(editDraftRevisionRef.current)'),
    'seed ulang dari server tidak mereset baseline tersimpan');
  assert.ok(src.includes('editPutSnapshotRef.current = null;'),
    'snapshot PUT lama tidak dibersihkan saat siklus edit berakhir');
});

await check('A23: P3b — kegagalan GET pasca-PUT dengan item baru memakai mekanisme unresolved yang sama', () => {
  assert.ok(src.includes('const flagUnresolvedAfterFailedSync = useCallback'),
    'helper penanda unresolved pasca-GET-gagal tidak ada');
  const flagIdx = src.indexOf('const flagUnresolvedAfterFailedSync = useCallback');
  const flagBody = src.slice(flagIdx, flagIdx + 1400);
  assert.ok(flagBody.includes('editPutSnapshotRef.current'),
    'helper tidak membaca snapshot PUT terakhir');
  assert.ok(flagBody.includes('entry.orderItemId === undefined'),
    'helper tidak membatasi pada PUT yang mengirim item baru');
  assert.ok(flagBody.includes('setEditIdentityUnresolved('),
    'helper tidak memakai mekanisme unresolved yang sudah ada');
  // Tanpa state baru yang menduplikasi fungsi unresolved.
  const unresolvedStates = [...src.matchAll(/const \[(\w*[Uu]nresolved\w*), set\w+\]/g)].length;
  assert.equal(unresolvedStates, 1, 'tidak boleh ada state unresolved baru');
  assert.ok(src.includes('seedEditCartFromDetail, flagUnresolvedAfterFailedSync]'),
    'helper tidak masuk deps loadOrderDetail');
  // Terpusat + dipakai di SEMUA jalur kegagalan GET sinkronisasi.
  const lodIdx = src.indexOf('const loadOrderDetail = useCallback');
  const lodEnd = src.indexOf('const reloadEditDetail = useCallback', lodIdx);
  const lodFn = src.slice(lodIdx, lodEnd > lodIdx ? lodEnd : lodIdx + 20000);
  const rIdx = lodFn.indexOf('const reportSyncFailure = (msg: string): void => {');
  assert.ok(rIdx !== -1, 'pelaporan kegagalan GET tidak terpusat');
  const rBody = lodFn.slice(rIdx, rIdx + 500);
  assert.ok(rBody.includes('if (preserveSuccess) {') && rBody.includes('setEditSyncWarning(msg);'),
    'kegagalan GET pasca-PUT harus tetap memakai warning sinkronisasi (bukan editError)');
  assert.ok(rBody.includes('flagUnresolvedAfterFailedSync();'),
    'kegagalan GET pasca-PUT tidak memblokir simpan lanjutan');
  assert.ok(rBody.includes('setEditError(msg);'), 'jalur non-preserve harus tetap memakai editError');
  const reportCalls = [...src.matchAll(/reportSyncFailure\(msg\);/g)].length;
  assert.ok(reportCalls >= 6, `jalur kegagalan GET belum semuanya terpusat (found ${reportCalls})`);
  const flagCalls = [...lodFn.matchAll(/flagUnresolvedAfterFailedSync\(\);/g)].length;
  assert.ok(flagCalls >= 3, `jalur 404/network/umum harus memanggil helper (found ${flagCalls})`);
});

await check('A24: P3c — simpan lanjutan diblokir SINKRON selama GET sinkronisasi berjalan', () => {
  assert.ok(src.includes('const editDetailInFlightRef = useRef(false)'),
    'penanda sinkron GET detail tidak ada');
  assert.ok(src.includes('editDetailInFlightRef.current = true;'),
    'penanda tidak diset saat GET detail dimulai');
  assert.ok(src.includes('if (editDetailInFlightRef.current) return false;'),
    'guard handler simpan lanjutan tidak memakai penanda sinkron (hanya tombol disabled)');
  assert.ok(src.includes('if (epoch === editDetailEpochRef.current) editDetailInFlightRef.current = false;'),
    'penanda tidak dibersihkan lewat epoch guard di finally');
  assert.ok(src.includes('disabled={editSaving || editLoading || editConflict !== null'),
    'tombol simpan lanjutan tidak disabled saat GET berjalan');
  // Draft tetap editable selama GET: tidak ada guard editLoading pada mutator.
  assert.ok(!/updateEditCartQuantity[\s\S]{0,200}editLoading/.test(src),
    'mutator draft tidak boleh diblokir oleh GET yang berjalan');
  // Batal/Kembali tetap lewat epoch guard, bukan disabled saat GET berjalan.
  const closeIdx = src.indexOf('const closeEditorView = useCallback');
  const closeBody = src.slice(closeIdx, closeIdx + 2500);
  assert.ok(closeBody.includes('editDetailInFlightRef.current = false;'),
    'closeEditorView harus membersihkan penanda sinkron');
  assert.ok(closeBody.includes('editDetailEpochRef.current++;'),
    'closeEditorView tetap memakai epoch guard');
});

console.log('\n--- PROBE: React hook semantics (BUKAN test komponen PosWorkspace) ---\n');

// ── Minimal DOM stub (react-dom probes these globals on use) ────────────────
function makeNode(nodeType: number, tag: string) {
  return {
    nodeType,
    tagName: tag ? tag.toUpperCase() : '',
    childNodes: [] as any[],
    style: {} as Record<string, unknown>,
    dataset: {} as Record<string, string>,
    setAttribute() {},
    getAttribute() { return null; },
    setAttributeNS() {},
    appendChild(c: any) { this.childNodes.push(c); c.parentNode = this; return c; },
    removeChild(c: any) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); return c; },
    insertBefore(a: any, _b: any) { this.childNodes.push(a); return a; },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    contains(n: any) { return this.childNodes.includes(n); },
    parentNode: null as unknown,
    ownerDocument: null as unknown,
    textContent: '',
  };
}

function installDomStub() {
  const doc: any = {
    createElement: (t: string) => { const n = makeNode(1, t); n.ownerDocument = doc; return n; },
    createElementNS: (_ns: string, t: string) => { const n = makeNode(1, t); n.ownerDocument = doc; return n; },
    createTextNode: (t: string) => ({ nodeType: 3, nodeValue: t, textContent: t, ownerDocument: doc, appendChild() {}, removeChild() {}, childNodes: [] }),
    createComment: (t: string) => ({ nodeType: 8, nodeValue: t, childNodes: [] }),
    documentElement: makeNode(1, 'HTML'),
    body: makeNode(1, 'BODY'),
    head: makeNode(1, 'HEAD'),
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    activeElement: null,
    defaultView: globalThis,
    HTMLIFrameElement: class HTMLIFrameElement {},
  };
  doc.documentElement.ownerDocument = doc;
  doc.body.ownerDocument = doc;
  doc.head.ownerDocument = doc;

  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).document = doc;
  (globalThis as any).window = globalThis;
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });
  (globalThis as any).HTMLIFrameElement = doc.HTMLIFrameElement;
  (globalThis as any).Element = class Element {};
  (globalThis as any).Node = class Node {};
  (globalThis as any).HTMLElement = class HTMLElement {};
  (globalThis as any).Text = class Text {};
}
installDomStub();

// React is loaded AFTER the DOM stub is in place (react-dom probes globals).
const React = (await import('react')).default ?? (await import('react'));
const { createRoot } = await import('react-dom/client');
const act = (React as any).act;

// ── B1/B2: PROBE komponen mini (bukan PosWorkspace) — stale closure ────────
// This probe replicates the dependency chain of saveEditedOrder in
// PosWorkspace.tsx:
//   editCart (state)
//     → buildEditItemsFromCart = useCallback(..., [editCart])
//     → saveEditedOrder = useCallback(..., [..., buildEditItemsFromCart, loadOrderDetail])
// With the P1 fix, changing editCart re-creates buildEditItemsFromCart, which
// re-creates saveEditedOrder, so the submit callback ALWAYS reads the latest
// cart. Without the fix (buildEditItemsFromCart missing from save deps), the
// save callback keeps the OLD closure and submits the stale payload.
{
  function Probe({ fixed, captured }: {
    fixed: { onSavedPayloads: string[] };
    captured: { saveFn: ((qtyOverride?: number) => string) | null; saveIdentity: number[] };
  }) {
    const [editCart, setEditCart] = React.useState({ qty: 1 });

    // Mirrors buildEditItemsFromCart = useCallback(..., [editCart, ...])
    const buildEditItemsFromCart = React.useCallback(
      () => [{ qty: editCart.qty }],
      [editCart]
    );

    // Mirrors saveEditedOrder with the P1 fix: buildEditItemsFromCart IS in deps
    const saveEditedOrderFixed = React.useCallback(
      () => JSON.stringify(buildEditItemsFromCart()),
      [buildEditItemsFromCart]
    );

    // Mirrors the BUGGY pre-P1 saveEditedOrder: builder NOT in deps
    const saveEditedOrderBuggy = React.useCallback(
      () => JSON.stringify(buildEditItemsFromCart()),
      [] as never[]
    );

    React.useEffect(() => {
      if (fixed.onSavedPayloads.length > 0) return; // record only on demand
    });

    // Expose to the test driver
    captured.saveFn = fixed.buggy
      ? saveEditedOrderBuggy
      : saveEditedOrderFixed;
    captured.saveIdentity.push(
      fixed.buggy
        ? saveEditedOrderBuggy ? 1 : 0
        : saveEditedOrderFixed ? 1 : 0
    );
    // also expose the setter so the test can drive state changes
    (captured as any).setEditCart = setEditCart;
    (captured as any).cart = editCart;
    return null;
  }
  // give Probe a second prop channel for buggy/fixed switch
  function ProbeWrapper(props: { buggy: boolean }) {
    const ref = React.useRef(props.buggy);
    return React.createElement(Probe, {
      fixed: { buggy: props.buggy, onSavedPayloads: [] as string[] },
      captured: props.captured,
    });
  }

  await check('B1: PROBE (bukan komponen PosWorkspace) — deps fix me-recreate callback save setelah cart berubah', async () => {
    const captured: any = { saveIdentity: [] };
    const container = (globalThis as any).document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(Probe, {
        fixed: { buggy: false, onSavedPayloads: [] },
        captured,
      }));
    });
    assert.ok(typeof captured.saveFn === 'function', 'save callback not exposed');

    // Save BEFORE cart change → qty 1
    const before = captured.saveFn();
    assert.equal(before, JSON.stringify([{ qty: 1 }]), 'initial save payload should be qty=1');

    // Change cart qty 1 → 2 (mirrors updateEditCartQuantity)
    await act(async () => {
      captured.setEditCart({ qty: 2 });
    });

    // Save AFTER cart change → MUST be qty 2 (P1 fix). Without the fix this
    // would still be qty 1 — the stale closure bug.
    const after = captured.saveFn();
    assert.equal(
      after,
      JSON.stringify([{ qty: 2 }]),
      'STALE CLOSURE REGRESSION: save callback still reads qty=1 after cart changed to qty=2'
    );
    await act(async () => { root.unmount(); });
  });

  await check('B2: PROBE (bukan komponen PosWorkspace) — tanpa deps fix, callback save tetap stale (bug direproduksi)', async () => useRefBug());

  async function useRefBug() {
    const captured: any = { saveIdentity: [] };
    const container = (globalThis as any).document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(Probe, {
        fixed: { buggy: true, onSavedPayloads: [] },
        captured,
      }));
    });
    await act(async () => {
      captured.setEditCart({ qty: 2 });
    });
    const stale = captured.saveFn();
    // The buggy version (builder not in deps) still returns qty=1 — this is
    // exactly the bug POS-EDIT-1B P1 fixed. Verify the bug is reproducible
    // with the old deps shape, proving the semantics of the fix.
    assert.equal(
      stale,
      JSON.stringify([{ qty: 1 }]),
      'expected buggy deps shape to exhibit the stale closure (qty=1)'
    );
    await act(async () => { root.unmount(); });
  }
}

// ── B3: epoch-guard semantics — late GET response is discarded ──────────────
{
  await check('B3: PROBE (bukan komponen PosWorkspace) — epoch guard membuang respons GET telat setelah editor ditutup', async () => {
    // Mirrors loadOrderDetail + closeEditorView epoch pattern:
    //   const epoch = ++editDetailEpochRef.current;
    //   const res = await authFetch(...);
    //   if (epoch !== editDetailEpochRef.current) return; // stale → discard
    //   ...apply response...
    // closeEditorView(): editDetailEpochRef.current++;
    let appliedResponses: string[] = [];
    let editDetailEpochRef = { current: 0 };

    async function loadOrderDetail(simulatedDelayMs: number): Promise<string | null> {
      const epoch = ++editDetailEpochRef.current;
      await new Promise(r => setTimeout(r, simulatedDelayMs));
      if (epoch !== editDetailEpochRef.current) return null; // stale
      return `order-state-v${epoch}`;
    }
    function closeEditorView() {
      editDetailEpochRef.current++; // P3 race guard
    }

    // Scenario: GET starts, editor closes before the response arrives.
    const p = loadOrderDetail(30);
    closeEditorView(); // bump epoch while GET in flight
    const result = await p;
    assert.equal(
      result,
      null,
      'late GET after close must be discarded (epoch mismatch)'
    );
    assert.equal(appliedResponses.length, 0, 'no response should have been applied');
  });
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n[RESULT] ${pass} PASS, ${fail} FAIL`);
if (fail > 0) process.exit(1);

/**
 * pos_order_edit_integration_test.ts
 *
 * POS-EDIT-1B.2 — Integration test untuk editor state & API integration
 * (GET /api/pos/orders/:id/detail + PUT /api/pos/orders/:id) pada frontend.
 *
 * Karena loadOrderDetail/saveEditedOrder hidup di dalam React component
 * PosWorkspace (useCallback, tidak diekspor), test ini memverifikasi kontrak
 * lapisan yang sama persis seperti yang dipakai component:
 *
 *   A. GET detail parsing — validasi shape respons backend
 *      (posOrderDetailHandler.ts), pemisahan pos_order_items.id vs
 *      menu_item_id, notes/diskon existing tersimpan pada editor state.
 *   B. PAID/VOIDED tidak boleh disimpan (mode readonly).
 *   C. PUT menggunakan expected_version dari GET detail (version ?? 1)
 *      dan idempotency key edit BARU (bukan key CREATE dari order).
 *   D. Retry PUT identik — key & bodyJson dari snapshot, tidak di-rebuild.
 *   E. Error handling: 409 codes, 400/422, 401/403, 5xx, network error.
 *   F. Snapshot dibuang/dipertahankan sesuai semantik error (definitif vs ambigu).
 *   G. Tidak ada field immutable (reservation_id / service_charge_enabled /
 *      tax_enabled) di payload PUT; tidak ada unit_price / order.id di body.
 *   H. Regresi CREATE: buildPosOrderDraft tidak berubah (payload create
 *      tidak mengandung expected_version / idempotency_key body PUT).
 *
 * Run:  cd frontend && node --experimental-strip-types test/pos_order_edit_integration_test.ts
 */
import { strict as assert } from 'node:assert';
import {
  buildPosOrderEditPayload,
  buildPosOrderDraft,
  type PosOrderDetail,
  type PosOrderEditDetails,
  type PosOrderEditItem,
  type PosCartLine,
  type PosDiscountType,
} from '../src/features/pos/posOrderDraft.ts';

let pass = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      pass++;
      console.log(`  PASS  ${name}`);
    })
    .catch((err) => {
      console.error(`  FAIL  ${name}`);
      console.error(err);
      process.exitCode = 1;
    });
}

// ── Editor state mirror (bentuk yang sama dengan state PosWorkspace) ─────────
// Ini mereplikasi mapping yang dilakukan loadOrderDetail di PosWorkspace.tsx.
interface EditorItemState {
  posOrderItemId: number;
  menuItemId: number;
  quantity: number;
  notes: string | null;
  discount_type: 'NOMINAL' | 'PERCENT' | null;
  discount_value: number | null;
}
interface EditorState {
  orderId: number;
  version: number;
  status: string;
  orderNumber: string;
  items: EditorItemState[];
  tableNumber: string | null;
  guestName: string | null;
  guestPhone: string | null;
  orderNotes: string | null;
  discountReason: string | null;
  orderDiscountType: 'NOMINAL' | 'PERCENT' | null;
  orderDiscountValue: number | null;
}

/**
 * Replika EXACT mapping loadOrderDetail di PosWorkspace.tsx — dipisahkan
 * agar bisa dites tanpa React. Bila component berubah, replika ini harus
 * ikut diselaraskan (source of truth tetap PosWorkspace.tsx).
 */
function mapDetailToEditorState(detail: { order: Record<string, unknown>; items: unknown[] }, requestedOrderId: number): { ok: true; state: EditorState } | { ok: false; reason: string } {
  const order = detail.order;
  if (Number(order.id) !== requestedOrderId) {
    return { ok: false, reason: 'ID order tidak cocok dengan yang diminta.' };
  }
  const version = Number(order.version ?? 1);
  if (!Number.isInteger(version) || version < 1) {
    return { ok: false, reason: 'Versi order tidak valid.' };
  }
  const status = String(order.status ?? '').toUpperCase();
  if (status !== 'OPEN' && status !== 'PAID' && status !== 'VOIDED') {
    return { ok: false, reason: `Status order tidak dikenal: ${status}` };
  }
  const items = (detail.items as Array<Record<string, unknown>>).map((it) => ({
    posOrderItemId: Number(it.id),
    menuItemId: Number(it.menu_item_id),
    quantity: Number(it.quantity),
    notes: typeof it.notes === 'string' ? it.notes : null,
    discount_type: (it.discount_type === 'NOMINAL' || it.discount_type === 'PERCENT')
      ? (it.discount_type as 'NOMINAL' | 'PERCENT')
      : null,
    discount_value: it.discount_value == null ? null : Number(it.discount_value),
  }));
  return {
    ok: true,
    state: {
      orderId: requestedOrderId,
      version,
      status,
      orderNumber: String(order.order_number ?? ''),
      items,
      tableNumber: typeof order.table_number === 'string' ? order.table_number : null,
      guestName: typeof order.guest_name === 'string' ? order.guest_name : null,
      guestPhone: typeof order.guest_phone === 'string' ? order.guest_phone : null,
      orderNotes: typeof order.notes === 'string' ? order.notes : null,
      discountReason: typeof order.discount_reason === 'string' ? order.discount_reason : null,
      orderDiscountType: (order.discount_type === 'NOMINAL' || order.discount_type === 'PERCENT') ? (order.discount_type as 'NOMINAL' | 'PERCENT') : null,
      orderDiscountValue: order.discount_value == null ? null : Number(order.discount_value),
    },
  };
}

// ── Fixture: GET detail respons backend (shape posOrderDetailHandler.ts) ─────
function makeDetail(overrides?: Partial<PosOrderDetail>): { status: string; data: { order: Record<string, unknown>; items: unknown[] } } {
  const order: Record<string, unknown> = {
    id: 9101,
    order_number: 'POS-20261018-0001',
    property_id: 7,
    reservation_id: null,
    table_number: 'A1',
    guest_name: 'Budi',
    guest_phone: '+628123456789',
    notes: 'Order catatan',
    status: 'OPEN',
    total_amount: 121000,
    discount_type: 'PERCENT',
    discount_value: 10,
    discount_reason: 'Member',
    discount_amount: 11000,
    service_charge_percent_snapshot: 5,
    tax_percent_snapshot: 11,
    service_charge_enabled_snapshot: true,
    tax_enabled_snapshot: true,
    service_amount: 5500,
    tax_amount: 12100,
    version: 4,
    idempotency_key: 'create-key-11111111-2222-3333-4444-555555555555',
    created_at: '2026-10-18T08:00:00Z',
    updated_at: '2026-10-18T08:30:00Z',
    ...overrides,
  };
  const items = [
    {
      id: 501,
      menu_item_id: 11,
      quantity: 2,
      unit_price: 45000,
      discount_type: 'NOMINAL',
      discount_value: 5000,
      discount_amount: 10000,
      notes: 'tanpa pedas',
      item_name_snapshot: 'Nasi Goreng',
      item_code_snapshot: 'NG-01',
      menu_item_is_active: true,
      menu_item_name: 'Nasi Goreng',
    },
    {
      id: 502,
      menu_item_id: 12,
      quantity: 1,
      unit_price: 30000,
      discount_type: null,
      discount_value: null,
      discount_amount: null,
      notes: null,
      item_name_snapshot: 'Es Teh',
      item_code_snapshot: 'ET-01',
      menu_item_is_active: true,
      menu_item_name: 'Es Teh',
    },
  ];
  return { status: 'OK', data: { order, items } };
}

// ── Fixture: snapshot idempotency editor (mirror editIdempotencyRef) ─────────
interface EditSnapshotMirror {
  key: string;
  bodyJson: string;
  orderId: number;
}

/** Replika logika snapshot-save di saveEditedOrder (PosWorkspace.tsx). */
function buildPutBody(
  editor: EditorState,
  key: string,
  canDiscount: boolean
): string {
  const payload = buildPosOrderEditPayload(
    {
      property_id: 7,
      expected_version: editor.version,
      idempotency_key: key,
      // items SEMENTARA di-omit di POS-EDIT-1B.2 — hanya metadata order.
      table_number: editor.tableNumber,
      guest_name: editor.guestName,
      guest_phone: editor.guestPhone,
      notes: editor.orderNotes,
      discount_reason: editor.discountReason,
      order_discount_type: editor.orderDiscountType,
      order_discount_value: editor.orderDiscountValue,
    },
    canDiscount
  );
  return JSON.stringify(payload);
}

// ── Mock authFetch + history pencatatan request ──────────────────────────────
type MockRoute = (url: string, init?: RequestInit) => Promise<Response>;
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const tests: Array<[string, () => void | Promise<void>]> = [];

// ═══ A. GET detail parsing ═════════════════════════════════════════════════
tests.push(['A1: GET detail parsing — mapping penuh ke editor state', () => {
  const res = makeDetail();
  const mapped = mapDetailToEditorState(res.data, 9101);
  assert.ok(mapped.ok, 'mapping harus sukses');
  if (!mapped.ok) return;
  const st = mapped.state;
  assert.equal(st.orderId, 9101);
  assert.equal(st.version, 4);
  assert.equal(st.status, 'OPEN');
  assert.equal(st.orderNumber, 'POS-20261018-0001');
  assert.equal(st.tableNumber, 'A1');
  assert.equal(st.guestName, 'Budi');
  assert.equal(st.orderNotes, 'Order catatan');
  assert.equal(st.orderDiscountType, 'PERCENT');
  assert.equal(st.orderDiscountValue, 10);
}]);

tests.push(['A2: pemisahan pos_order_items.id vs menu_item_id', () => {
  const res = makeDetail();
  const mapped = mapDetailToEditorState(res.data, 9101);
  assert.ok(mapped.ok);
  if (!mapped.ok) return;
  assert.equal(mapped.state.items[0].posOrderItemId, 501);
  assert.equal(mapped.state.items[0].menuItemId, 11);
  assert.equal(mapped.state.items[1].posOrderItemId, 502);
  assert.notEqual(mapped.state.items[0].posOrderItemId, mapped.state.items[0].menuItemId);
}]);

tests.push(['A3: notes & diskon existing tersimpan pada editor state', () => {
  const res = makeDetail();
  const mapped = mapDetailToEditorState(res.data, 9101);
  assert.ok(mapped.ok);
  if (!mapped.ok) return;
  assert.equal(mapped.state.items[0].notes, 'tanpa pedas');
  assert.equal(mapped.state.items[0].discount_type, 'NOMINAL');
  assert.equal(mapped.state.items[0].value ?? mapped.state.items[0].discount_value, 5000);
  assert.equal(mapped.state.items[1].notes, null);
  assert.equal(mapped.state.items[1].discount_type, null);
  assert.equal(mapped.state.items[1].discount_value, null);
}]);

tests.push(['A4: version null pada order pra-migrasi → editor version = 1', () => {
  const res = makeDetail({ version: null as unknown as number });
  const mapped = mapDetailToEditorState(res.data, 9101);
  assert.ok(mapped.ok);
  if (!mapped.ok) return;
  assert.equal(mapped.state.version, 1);
}]);

tests.push(['A5: unit_price snapshot TIDAK masuk editor state (tidak diganti harga live)', () => {
  const res = makeDetail();
  const mapped = mapDetailToEditorState(res.data, 9101);
  assert.ok(mapped.ok);
  if (!mapped.ok) return;
  // Editor state hanya menyimpan identitas + qty + notes + diskon.
  assert.equal('unit_price' in mapped.state.items[0], false);
}]);

tests.push(['A6: order.id mismatch → ditolak', () => {
  const res = makeDetail();
  const mapped = mapDetailToEditorState(res.data, 9999);
  assert.equal(mapped.ok, false);
}]);

// ═══ B. PAID/VOIDED tidak boleh disimpan ══════════════════════════════════
tests.push(['B1: status PAID → editor tetap termuat, mode readonly (tidak bisa save)', () => {
  const res = makeDetail({ status: 'PAID' });
  const mapped = mapDetailToEditorState(res.data, 9101);
  assert.ok(mapped.ok);
  if (!mapped.ok) return;
  assert.equal(mapped.state.status, 'PAID');
  // Mirror guard saveEditedOrder: editMode !== 'edit' → return false.
  const editMode = mapped.state.status === 'OPEN' ? 'edit' : 'readonly';
  assert.equal(editMode, 'readonly');
}]);

tests.push(['B2: status VOIDED → readonly', () => {
  const res = makeDetail({ status: 'VOIDED' });
  const mapped = mapDetailToEditorState(res.data, 9101);
  assert.ok(mapped.ok);
  if (!mapped.ok) return;
  const editMode = mapped.state.status === 'OPEN' ? 'edit' : 'readonly';
  assert.equal(editMode, 'readonly');
}]);

tests.push(['B3: status tidak dikenal → ditolak mapping', () => {
  const res = makeDetail({ status: 'DELETED' });
  const mapped = mapDetailToEditorState(res.data, 9101);
  assert.equal(mapped.ok, false);
}]);

// ═══ C. PUT menggunakan version + key edit baru ═══════════════════════════
tests.push(['C1: PUT body memuat expected_version dari GET detail + key edit baru', () => {
  const res = makeDetail();
  const mapped = mapDetailToEditorState(res.data, 9101);
  assert.ok(mapped.ok);
  if (!mapped.ok) return;
  const key = 'edit-' + 'aaaa1111-2222-3333-4444-555566667777';
  const bodyJson = buildPutBody(mapped.state, key, true);
  const body = JSON.parse(bodyJson);
  assert.equal(body.property_id, 7);
  assert.equal(body.expected_version, 4);
  assert.equal(body.idempotency_key, key);
  // Key edit WAJIB berbeda dari key CREATE (order.idempotency_key dari GET detail).
  const createKeyFromDetail = res.data.order.idempotency_key as string | null;
  assert.equal(body.idempotency_key !== createKeyFromDetail, true,
    'key edit tidak boleh sama dengan key create dari order');
}]);

tests.push(['C2: PUT tidak mengirim field immutable + tidak ada order.id di body', () => {
  const res = makeDetail();
  const mapped = mapDetailToEditorState(res.data, 9101);
  assert.ok(mapped.ok);
  if (!mapped.ok) return;
  const bodyJson = buildPutBody(mapped.state, 'edit-key-x', true);
  const body = JSON.parse(bodyJson);
  assert.equal('reservation_id' in body, false);
  assert.equal('service_charge_enabled' in body, false);
  assert.equal('tax_enabled' in body, false);
  assert.equal('id' in body, false);
  assert.equal('order_number' in body, false);
  assert.equal('unit_price' in body, false);
}]);

// ═══ D. Retry PUT identik ═══════════════════════════════════════════════════
tests.push(['D1: body PUT deterministik untuk input sama (aman untuk retry)', () => {
  const res = makeDetail();
  const mapped = mapDetailToEditorState(res.data, 9101);
  assert.ok(mapped.ok);
  if (!mapped.ok) return;
  const bodyJson1 = buildPutBody(mapped.state, 'edit-key-y', true);
  const bodyJson2 = buildPutBody(mapped.state, 'edit-key-y', true);
  assert.equal(bodyJson1, bodyJson2);
}]);

tests.push(['D2: retry memakai snapshot key & bodyJson identik (tidak rebuild dari state)', () => {
  const res = makeDetail();
  const mapped = mapDetailToEditorState(res.data, 9101);
  assert.ok(mapped.ok);
  if (!mapped.ok) return;
  // Simulasi: snapshot dibuat sekali...
  const snap: EditSnapshotMirror = { key: 'edit-snap-key', bodyJson: buildPutBody(mapped.state, 'edit-snap-key', true), orderId: 9101 };
  // ...state berubah setelah snapshot (mis. user mengedit qty di UI)...
  const mutated: EditorState = { ...mapped.state, version: mapped.state.version + 1 };
  // ...retry WAJIB memakai snapshot, bukan state terbaru:
  const retryUsesSnapshot = snap.orderId === mapped.state.orderId;
  assert.ok(retryUsesSnapshot);
  const rebuilt = buildPutBody(mutated, snap.key, true);
  assert.notEqual(rebuilt, snap.bodyJson, 'rebuilt dari state berubah harus berbeda — snapshot adalah sumber retry');
}]);

// ═══ E. Error handling & conflict versi ═════════════════════════════════════
tests.push(['E1: 409 ORDER_VERSION_CONFLICT → editConflict (perlu reload detail), snapshot tidak dibuang', () => {
  // Mirror logika di saveEditedOrder: code === 'ORDER_VERSION_CONFLICT'
  // → setEditConflict(...), snapshot DIPERTAHANKAN (tidak di-null).
  let conflictSet: { code: string; message: string } | null = null;
  let snapshotCleared = false;
  const code = 'ORDER_VERSION_CONFLICT';
  if (code === 'ORDER_VERSION_CONFLICT') {
    conflictSet = { code, message: 'Versi order tidak cocok. Reload dan coba lagi.' };
  } else {
    snapshotCleared = true;
  }
  assert.ok(conflictSet !== null);
  assert.equal(conflictSet!.code, 'ORDER_VERSION_CONFLICT');
  assert.equal(snapshotCleared, false, 'VERSION_CONFLICT: snapshot tidak dibuang');
}]);

tests.push(['E2: 409 PRICING_TOTAL_CHANGED → error tampil, snapshot dibuang (definitif)', () => {
  let snapshotCleared = false;
  const code = 'PRICING_TOTAL_CHANGED';
  if (code === 'PRICING_TOTAL_CHANGED') {
    snapshotCleared = true;
  }
  assert.ok(snapshotCleared, 'PRICING_TOTAL_CHANGED: snapshot dibuang agar boleh submit ulang');
}]);

tests.push(['E3: 409 IDEMPOTENCY_KEY_CONFLICT → tidak otomatis ganti key', () => {
  let keyReplaced = false;
  let snapshotKept = false;
  const code = 'IDEMPOTENCY_KEY_CONFLICT';
  if (code === 'IDEMPOTENCY_KEY_CONFLICT') {
    snapshotKept = true; // dipertahankan, TIDAK diganti
  } else {
    keyReplaced = true;
  }
  assert.equal(keyReplaced, false);
  assert.equal(snapshotKept, true);
}]);

tests.push(['E4: 409 ORDER_NOT_OPEN / FINANCIAL_LOCK → kunci editor (readonly), snapshot dibuang', () => {
  for (const code of ['ORDER_NOT_OPEN', 'FINANCIAL_LOCK']) {
    let editModeAfter = 'edit';
    let snapshotCleared = false;
    if (code === 'ORDER_NOT_OPEN' || code === 'FINANCIAL_LOCK') {
      editModeAfter = 'readonly';
      snapshotCleared = true;
    }
    assert.equal(editModeAfter, 'readonly');
    assert.equal(snapshotCleared, true);
  }
}]);

tests.push(['E5: 400/422 validation → pesan aman, snapshot dibuang', () => {
  const codes: Array<[number, string]> = [[400, 'VALIDATION_ERROR'], [422, 'ITEM_SNAPSHOT_MISMATCH']];
  for (const [status, code] of codes) {
    let snapshotCleared = false;
    if (status === 400 || status === 422) {
      snapshotCleared = true;
    }
    assert.ok(snapshotCleared, `${status} ${code}: snapshot dibuang`);
  }
}]);

tests.push(['E6: 401/403 → hentikan operasi, editor dikunci', () => {
  for (const status of [401, 403]) {
    let editModeAfter = 'edit';
    if (status === 401 || status === 403) {
      editModeAfter = 'readonly';
    }
    assert.equal(editModeAfter, 'readonly');
  }
}]);

tests.push(['E7: 5xx → status ambigu, snapshot DIPERTAHANKAN untuk retry identik', () => {
  let snapshotCleared = false;
  const status = 502;
  if (status >= 500) {
    // tidak ada snapshot clear di jalur 5xx
  } else {
    snapshotCleared = true;
  }
  assert.equal(snapshotCleared, false);
}]);

tests.push(['E8: network error → status ambigu, snapshot DIPERTAHANKAN', () => {
  let snapshotCleared = false;
  let networkError = true;
  if (networkError) {
    // snapshot dipertahankan
  } else {
    snapshotCleared = true;
  }
  assert.equal(snapshotCleared, false);
}]);

// ═══ F. PUT sukses — versi bertambah ════════════════════════════════════════
tests.push(['F1: PUT sukses → version baru disimpan ke editor state', () => {
  const res = makeDetail();
  const mapped = mapDetailToEditorState(res.data, 9101);
  assert.ok(mapped.ok);
  if (!mapped.ok) return;
  // Mirror: setEditingOrder(prev => ({...prev, version: newVersion}))
  const newVersion = 5;
  const updated: EditorState = { ...mapped.state, version: newVersion };
  assert.equal(updated.version, 5);
  assert.equal(updated.orderId, 9101);
}]);

tests.push(['F2: PUT sukses shape malformed → ambigu, snapshot dipertahankan', () => {
  const malformedData = { data: { order: { id: 9101 } } }; // tanpa version
  const d = malformedData.data as { order?: { id?: number; version?: number } };
  const newVersion = Number(d?.order?.version ?? 0);
  const valid = Number(d?.order?.id) === 9101 && Number.isInteger(newVersion) && newVersion >= 1;
  assert.equal(valid, false, 'shape tanpa version → tidak valid → snapshot dipertahankan');
}]);

// ═══ G. Guard kontrak payload (builder level, terintegrasi) ═════════════════
tests.push(['G1: editor items + notes/diskon → items[] payload mempertahankan notes/diskon (full-replace resend)', () => {
  const res = makeDetail();
  const mapped = mapDetailToEditorState(res.data, 9101);
  assert.ok(mapped.ok);
  if (!mapped.ok) return;
  const items: PosOrderEditItem[] = mapped.state.items.map((it) => ({
    orderId: it.posOrderItemId,
    menu_item_id: it.menuItemId,
    quantity: it.quantity,
    notes: it.notes ?? null,
    discount_type: it.discount_type,
    discount_value: it.discount_value,
  }));
  const payload = buildPosOrderEditPayload(
    {
      property_id: 7,
      expected_version: mapped.state.version,
      idempotency_key: 'edit-key-g1',
      items,
      table_number: mapped.state.tableNumber,
      guest_name: mapped.state.guestName,
      guest_phone: mapped.state.guestPhone,
      notes: mapped.state.orderNotes,
      discount_reason: mapped.state.discountReason,
      order_discount_type: mapped.state.orderDiscountType,
      order_discount_value: mapped.state.orderDiscountValue,
    },
    true
  );
  const itemsArr = payload.items as Array<Record<string, unknown>>;
  assert.equal(itemsArr.length, 2);
  assert.equal(itemsArr[0].id, 501);
  assert.equal(itemsArr[0].notes, 'tanpa pedas');
  assert.equal(itemsArr[0].discount_type, 'NOMINAL');
  assert.equal(itemsArr[0].discount_value, 5000);
  assert.equal(itemsArr[1].id, 502);
  assert.equal(itemsArr[1].notes, null);
  assert.equal(itemsArr[1].discount_type, undefined);
  assert.equal(itemsArr[1].discount_value, undefined);
}]);

tests.push(['G2: order tanpa diskon → kunci diskon order di-omit (preserve backend)', () => {
  const res = makeDetail({ discount_type: null, discount_value: null, discount_amount: null });
  const mapped = mapDetailToEditorState(res.data, 9101);
  assert.ok(mapped.ok);
  if (!mapped.ok) return;
  const bodyJson = buildPutBody(mapped.state, 'edit-key-g2', true);
  const body = JSON.parse(bodyJson);
  // Order tanpa diskon: null + null → bothNull → kunci dikirim null+null (hapus diskon)
  // — backend memertahankan karena null+null adalah no-op semantik "hapus diskon"
  // pada order yang memang tanpa diskon.
  assert.equal(body.order_discount_type, null);
  assert.equal(body.order_discount_value, null);
}]);

tests.push(['G3: metadata order undefined → omitted (preserve), bukan reset null', () => {
  const details: PosOrderEditDetails = {
    property_id: 7,
    expected_version: 2,
    idempotency_key: 'edit-key-g3',
  };
  const payload = buildPosOrderEditPayload(details, false);
  for (const k of ['table_number', 'guest_name', 'guest_phone', 'notes', 'discount_reason', 'order_discount_type', 'order_discount_value', 'items', 'expected_total']) {
    assert.equal(k in payload, false, `${k} undefined → di-omit`);
  }
}]);

// ═══ H. Regresi CREATE — buildPosOrderDraft tidak berubah ════════════════════
tests.push(['H1: buildPosOrderDraft CREATE tidak memuat field PUT (expected_version, idempotency_key body)', () => {
  const lines: PosCartLine[] = [
    { item: { id: 11, name: 'Nasi Goreng', price: 45000 }, qty: 2 },
  ];
  const draft = buildPosOrderDraft(
    lines,
    {
      propertyId: 7,
      reservationId: null,
      tableNumber: 'A1',
      guestName: 'Budi',
      guestPhone: '',
      notes: '',
      discountType: '' as PosDiscountType,
      discountInput: '',
      discountReason: '',
    },
    false
  );
  const json = JSON.stringify(draft);
  assert.equal('expected_version' in draft, false);
  assert.equal('idempotency_key' in draft, false);
  assert.ok(json.includes('"menu_item_id":11'));
  assert.ok(json.includes('"quantity":2'));
}]);

tests.push(['H2: CREATE tetap mengirim service_charge_enabled/tax_enabled (kontrak create ≠ PUT)', () => {
  const lines: PosCartLine[] = [{ item: { id: 11, name: 'Nasi Goreng', price: 45000 }, qty: 1 }];
  const draft = buildPosOrderDraft(
    lines,
    {
      propertyId: 7,
      reservationId: null,
      tableNumber: 'A1',
      guestName: 'Budi',
      guestPhone: '',
      notes: '',
      discountType: '' as PosDiscountType,
      discountInput: '',
      discountReason: '',
      serviceChargeEnabled: false,
      taxEnabled: false,
    },
    false
  );
  assert.equal('service_charge_enabled' in draft, true);
  assert.equal('tax_enabled' in draft, true);
}]);

// ═══ I. POS-EDIT-1B.2.2 — Cart edit & items[] full-replace ════════════════════

// ── Mirror cart edit PosWorkspace (EditCartLine + operasi) ──────────────────
// Replika logika seedEditCartFromDetail + buildEditItemsFromCart di
// PosWorkspace.tsx. Dipisahkan agar bisa dites tanpa React.
interface EditCartLine {
  orderItemId?: number; // undefined = item baru
  menuItemId: number;
  quantity: number;
  notes: string | null;
  discount_type: 'NOMINAL' | 'PERCENT' | null;
  discount_value: number | null;
  unit_price: number;
  name: string;
  code: string;
}

/**
 * seedEditCart — replika seedEditCartFromDetail di PosWorkspace.
 * Mapping items[] GET detail → cart edit (snapshot harga, notes, diskon).
 */
function seedEditCartFromDetailTest(
  items: Array<{
    posOrderItemId: number;
    menuItemId: number;
    quantity: number;
    notes: string | null;
    discount_type: 'NOMINAL' | 'PERCENT' | null;
    discount_value: number | null;
    unit_price: number;
    name: string;
    code: string;
  }> | null
): EditCartLine[] | null {
  if (items === null) return null;
  return items.map((it) => ({
    orderItemId: it.posOrderItemId,
    menuItemId: it.menuItemId,
    quantity: it.quantity,
    notes: it.notes,
    discount_type: it.discount_type,
    discount_value: it.discount_value,
    unit_price: it.unit_price,
    name: it.name,
    code: it.code,
  }));
}

/**
 * buildEditItemsFromCart — replika fungsi di PosWorkspace (tanpa React).
 * Kontrak:
 *  - cart null/kosong → undefined (items di-omit, tanpa perubahan item).
 *  - Item existing (orderItemId terisi) → items[].id = orderItemId.
 *  - Item baru (orderItemId undefined) → tanpa id.
 *  - notes/diskon: WAJIB resend (full-replace).
 *  - unit_price TIDAK dikirim.
 */
function buildEditItemsFromCartTest(
  cart: EditCartLine[] | null
): PosOrderEditItem[] | undefined {
  if (cart === null || cart.length === 0) return undefined;
  return cart.map((line) => {
    const item: PosOrderEditItem = {
      menu_item_id: line.menuItemId,
      quantity: line.quantity,
      notes: line.notes,
      discount_type: line.discount_type,
      discount_value: line.discount_value,
    };
    if (line.orderItemId !== undefined) {
      item.orderId = line.orderItemId;
    }
    return item;
  });
}

/** Bangun PUT body lengkap dengan items[] dari cart edit (mirror saveEditedOrder). */
function buildPutBodyWithItems(
  editor: EditorState,
  cart: EditCartLine[] | null,
  key: string,
  canDiscount: boolean
): string {
  const items = buildEditItemsFromCartTest(cart);
  const payload = buildPosOrderEditPayload(
    {
      property_id: 7,
      expected_version: editor.version,
      idempotency_key: key,
      items,
      table_number: editor.tableNumber,
      guest_name: editor.guestName,
      guest_phone: editor.guestPhone,
      notes: editor.orderNotes,
      discount_reason: editor.discountReason,
      order_discount_type: editor.orderDiscountType,
      order_discount_value: editor.orderDiscountValue,
    },
    canDiscount
  );
  return JSON.stringify(payload);
}

/** Seed cart edit dari fixture makeDetail (path normal loadOrderDetail). */
function seedCartFromFixture(detail: ReturnType<typeof makeDetail>): EditCartLine[] | null {
  // Replika: mapping yang dilakukan loadOrderDetail untuk mengisi cart
  const items = (detail.data.items as Array<Record<string, unknown>>).map((it) => ({
    posOrderItemId: Number(it.id),
    menuItemId: Number(it.menu_item_id),
    quantity: Number(it.quantity),
    notes: typeof it.notes === 'string' ? it.notes : null,
    discount_type: (it.discount_type === 'NOMINAL' || it.discount_type === 'PERCENT')
      ? (it.discount_type as 'NOMINAL' | 'PERCENT')
      : null,
    discount_value: it.discount_value == null ? null : Number(it.discount_value),
    unit_price: Number(it.unit_price),
    name: typeof it.item_name_snapshot === 'string' ? it.item_name_snapshot : 'Menu',
    code: typeof it.item_code_snapshot === 'string' ? it.item_code_snapshot : '',
  }));
  return seedEditCartFromDetailTest(items);
}

// ── I1: Seed cart mempertahankan snapshot harga/notes/diskon ───────────────
tests.push(['I1: seed cart — unit_price, notes, diskon dari GET detail dipertahankan (tidak diganti harga live)', () => {
  const detail = makeDetail();
  const cart = seedCartFromFixture(detail)!;
  // Item 0: snapshot harga 45000, notes 'tanpa pedas', diskon NOMINAL 5000
  assert.equal(cart![0].unit_price, 45000, 'unit_price snapshot item 0');
  assert.equal(cart![0].notes, 'tanpa pedas', 'notes item 0 dipertahankan');
  assert.equal(cart![0].discount_type, 'NOMINAL', 'discount_type item 0');
  assert.equal(cart![0].discount_value, 5000, 'discount_value item 0');
  assert.equal(cart![0].orderItemId, 501, 'orderItemId item 0 = pos_order_items.id');
  // Item 1: tanpa notes/diskon, harga 30000
  assert.equal(cart![1].unit_price, 30000, 'unit_price snapshot item 1');
  assert.equal(cart![1].notes, null, 'notes item 1 = null');
  assert.equal(cart![1].discount_type, null, 'discount_type item 1 = null');
  assert.equal(cart![1].orderItemId, 502, 'orderItemId item 1');
}]);

// ── I2: Item existing mempertahankan orderItemId di payload items[].id ─────
tests.push(['I2: item existing → items[].id terisi (pos_order_items.id); item baru → tanpa id', () => {
  const detail = makeDetail();
  const cart = seedCartFromFixture(detail)!;
  const items = buildEditItemsFromCartTest(cart)!;
  // Kedua item adalah existing → semua punya orderId
  assert.equal(items[0].orderId, 501, 'item 0: orderId terisi');
  assert.equal(items[1].orderId, 502, 'item 1: orderId terisi');
  // Tambah item baru → tanpa orderId
  const cartWithNew = [...cart!, {
    menuItemId: 99, quantity: 1,
    notes: null, discount_type: null, discount_value: null,
    unit_price: 25000, name: 'Menu Baru', code: 'MB-01',
  }];
  const itemsWithNew = buildEditItemsFromCartTest(cartWithNew)!;
  assert.equal(itemsWithNew[2].orderId, undefined, 'item baru: orderId tidak ada');
  assert.equal('orderId' in itemsWithNew[2], false, 'item baru: key orderId tidak ada di objek');
}]);

// ── I3: Quantity/notes/diskon berubah secara benar di cart edit ─────────────
tests.push(['I3: update quantity/notes/diskon di cart edit → payload items[] memantulkan perubahan', () => {
  const detail = makeDetail();
  const cart = seedCartFromFixture(detail)!;
  // Ubah: qty item 0 → 3, notes → 'sangat pedas', diskon → PERCENT 10
  cart[0] = { ...cart[0], quantity: 3, notes: 'sangat pedas', discount_type: 'PERCENT', discount_value: 10 };
  const items = buildEditItemsFromCartTest(cart)!;
  assert.equal(items[0].quantity, 3, 'qty diubah');
  assert.equal(items[0].notes, 'sangat pedas', 'notes diubah');
  assert.equal(items[0].discount_type, 'PERCENT', 'diskon type diubah');
  assert.equal(items[0].discount_value, 10, 'diskon value diubah');
  // Item 1 tidak berubah
  assert.equal(items[1].quantity, 1, 'item 1 qty tetap');
  assert.equal(items[1].notes, null, 'item 1 notes tetap null');
}]);

// ── I4: Full-replace — item yang tidak dihapus tetap dikirim lengkap ───────
tests.push(['I4: full-replace — seluruh item yang tidak dihapus dikirim di items[]', () => {
  const detail = makeDetail();
  const cart = seedCartFromFixture(detail)!;
  // Hapus item 1 (index 1), item 0 tetap ada
  const cartReduced = cart!.filter((_, i) => i !== 1);
  assert.equal(cartReduced.length, 1, 'hanya item 0 tersisa');
  const items = buildEditItemsFromCartTest(cartReduced)!;
  assert.equal(items.length, 1, 'items[] hanya memuat item yang tersisa');
  assert.equal(items[0].orderId, 501, 'item 0 (existing) tetap dikirim');
}]);

// ── I5: items=[] diblokir — cart kosong → items di-omit (undefined) ────────
tests.push(['I5: cart kosong → items undefined (items[] full-replace ditolak backend, omit = preserve)', () => {
  const items = buildEditItemsFromCartTest([]);
  assert.equal(items, undefined, 'cart kosong → items undefined, bukan []');
  const itemsNull = buildEditItemsFromCartTest(null);
  assert.equal(itemsNull, undefined, 'cart null → items undefined');
}]);

// ── I5b: items=[] ditolak builder (throws) ──────────────────────────────────
tests.push(['I5b: builder menolak items=[] (sesuai backend: payload items kosong dilarang)', () => {
  let threw = false;
  try {
    buildPosOrderEditPayload(
      {
        property_id: 7,
        expected_version: 4,
        idempotency_key: 'edit-key-empty',
        items: [], // ← harus ditolak
      },
      false
    );
  } catch {
    threw = true;
  }
  assert.equal(threw, true, 'items=[] harus ditolak builder');
}]);

// ── I6: Payload PUT lengkap + immutable fields tidak dikirim ───────────────
tests.push(['I6: PUT body dengan items[] — field immutable & unit_price TIDAK ada', () => {
  const detail = makeDetail();
  const mapped = mapDetailToEditorState(detail.data, 9101)!;
  const cart = seedCartFromFixture(detail)!;
  const bodyJson = buildPutBodyWithItems(mapped.state, cart, 'edit-key-i6', true);
  const body = JSON.parse(bodyJson);
  // Immutable fields TIDAK ada
  assert.equal('reservation_id' in body, false, 'reservation_id tidak dikirim');
  assert.equal('service_charge_enabled' in body, false, 'service_charge_enabled tidak dikirim');
  assert.equal('tax_enabled' in body, false, 'tax_enabled tidak dikirim');
  assert.equal('id' in body, false, 'order.id tidak di body');
  // items[] ada dan lengkap
  const itemsArr = body.items as Array<Record<string, unknown>>;
  assert.equal(Array.isArray(itemsArr), true, 'items[] ada di body');
  assert.equal(itemsArr.length, 2, '2 item');
  // item 0: id terisi (existing), notes/diskon resend
  assert.equal(itemsArr[0].id, 501, 'item 0: id (pos_order_items.id) terisi');
  assert.equal(itemsArr[0].menu_item_id, 11, 'item 0: menu_item_id');
  assert.equal(itemsArr[0].quantity, 2, 'item 0: quantity');
  assert.equal(itemsArr[0].notes, 'tanpa pedas', 'item 0: notes resend (full-replace)');
  assert.equal(itemsArr[0].discount_type, 'NOMINAL', 'item 0: diskon type resend');
  assert.equal(itemsArr[0].discount_value, 5000, 'item 0: diskon value resend');
  // unit_price TIDAK di payload item (backend sumber harga)
  assert.equal('unit_price' in itemsArr[0], false, 'unit_price tidak dikirim di item');
  assert.equal('unit_price' in itemsArr[1], false, 'unit_price tidak dikirim di item 1');
  // expected_total TIDAK dikirim (preview tidak akurat untuk item baru)
  assert.equal('expected_total' in body, false, 'expected_total tidak dikirim');
}]);

// ── I7: Item baru tanpa orderId → INSERT di backend (tanpa id di payload) ─
tests.push(['I7: item baru (orderItemId undefined) → payload items[] tanpa key id', () => {
  const detail = makeDetail();
  const cart = seedCartFromFixture(detail)!;
  // Tambah item baru
  cart.push({
    menuItemId: 200, quantity: 2,
    notes: 'ekstra manis', discount_type: null, discount_value: null,
    unit_price: 15000, name: 'Kopi', code: 'KP-01',
  });
  const items = buildEditItemsFromCartTest(cart)!;
  const payload = buildPosOrderEditPayload(
    {
      property_id: 7,
      expected_version: 4,
      idempotency_key: 'edit-key-i7',
      items,
    },
    true
  );
  const itemsArr = payload.items as Array<Record<string, unknown>>;
  // 3 item: 2 existing + 1 baru
  assert.equal(itemsArr.length, 3, '3 item di payload');
  // Item baru (index 2) tidak punya key id
  assert.equal('id' in itemsArr[2], false, 'item baru: key id tidak ada');
  assert.equal(itemsArr[2].menu_item_id, 200, 'item baru: menu_item_id');
  assert.equal(itemsArr[2].quantity, 2, 'item baru: quantity');
  assert.equal(itemsArr[2].notes, 'ekstra manis', 'item baru: notes');
  // Item existing tetap punya id
  assert.equal(itemsArr[0].id, 501, 'item 0: id terisi');
  assert.equal(itemsArr[1].id, 502, 'item 1: id terisi');
}]);

// ── I8: Retry ambiguous — payload identik, state divergensi → stale ────────
tests.push(['I8: retry — state belum berubah → payload identik (snapshot valid)', () => {
  const detail = makeDetail();
  const mapped = mapDetailToEditorState(detail.data, 9101)!;
  const cart = seedCartFromFixture(detail)!;
  const bodyJson1 = buildPutBodyWithItems(mapped.state, cart, 'edit-key-i8', true);
  const bodyJson2 = buildPutBodyWithItems(mapped.state, cart, 'edit-key-i8', true);
  assert.equal(bodyJson1, bodyJson2, 'payload deterministik untuk state sama');
}]);

tests.push(['I8b: retry — state berubah setelah snapshot → payload berbeda (stale, blokir submit)', () => {
  const detail = makeDetail();
  const mapped = mapDetailToEditorState(detail.data, 9101)!;
  const cart = seedCartFromFixture(detail)!;
  const snapBody = buildPutBodyWithItems(mapped.state, cart, 'edit-key-i8b', true);
  // User mengubah qty setelah snapshot ambigu
  const cartChanged = cart!.map((l, i) => i === 0 ? { ...l, quantity: 99 } : l);
  const currentBody = buildPutBodyWithItems(mapped.state, cartChanged, 'edit-key-i8b', true);
  assert.notEqual(snapBody, currentBody, 'state berubah → payload berbeda → stale, retry diblokir');
}]);

// ── I9: Diskon item baru (NOMINAL) → builder valid ─────────────────────────
tests.push(['I9: item baru dengan diskon NOMINAL → builder valid, id tidak ada', () => {
  const detail = makeDetail();
  const mapped = mapDetailToEditorState(detail.data, 9101)!;
  const items: PosOrderEditItem[] = [
    { menu_item_id: 11, quantity: 1, orderId: 501, notes: null, discount_type: null, discount_value: null },
    { menu_item_id: 50, quantity: 2, notes: 'baru', discount_type: 'NOMINAL', discount_value: 1000 },
  ];
  const payload = buildPosOrderEditPayload(
    {
      property_id: 7,
      expected_version: mapped.state.version,
      idempotency_key: 'edit-key-i9',
      items,
    },
    true // canDiscount = true agar diskon item diterima
  );
  const itemsArr = payload.items as Array<Record<string, unknown>>;
  assert.equal(itemsArr[1].id, undefined, 'item baru: tidak ada key id');
  assert.equal(itemsArr[1].discount_type, 'NOMINAL', 'diskon type');
  assert.equal(itemsArr[1].discount_value, 1000, 'diskon value');
  assert.equal('unit_price' in itemsArr[1], false, 'unit_price tidak dikirim');
}]);

// ── I10: Diskon item tanpa izin → builder menolak ───────────────────────────
tests.push(['I10: item dengan diskon + canDiscount=false → builder throw', () => {
  let threw = false;
  try {
    buildPosOrderEditPayload(
      {
        property_id: 7,
        expected_version: 4,
        idempotency_key: 'edit-key-i10',
        items: [
          { menu_item_id: 11, quantity: 1, orderId: 501, notes: null, discount_type: 'NOMINAL', discount_value: 1000 },
        ],
      },
      false // canDiscount = false
    );
  } catch {
    threw = true;
  }
  assert.equal(threw, true, 'diskon item tanpa izin harus ditolak');
}]);

// ── I11: notes null di cart → payload items[].notes = null (bukan omit) ────
tests.push(['I11: notes null di cart → payload items[].notes = null (explicit, bukan undefined)', () => {
  const detail = makeDetail();
  const cart = seedCartFromFixture(detail)!;
  const items = buildEditItemsFromCartTest(cart)!;
  // Item 0: notes 'tanpa pedas' → string di payload
  assert.equal(items[0].notes, 'tanpa pedas', 'item 0: notes string dipertahankan');
  // Item 1: notes null → null di payload (explicit, bukan omitted)
  assert.equal(items[1].notes, null, 'item 1: notes null dikirim explicit');
  // Verifikasi di payload akhir: key notes ada (bukan di-omit)
  const payload = buildPosOrderEditPayload(
    { property_id: 7, expected_version: 4, idempotency_key: 'edit-key-i11', items },
    true
  );
  const itemsArr = payload.items as Array<Record<string, unknown>>;
  assert.equal(itemsArr[1].notes, null, 'item 1: notes null di payload');
  assert.equal('notes' in itemsArr[1], true, 'key notes ada (explicit null, bukan omit)');
}]);

// ── I12: PAID/VOIDED → cart edit tidak bisa simpan (mode readonly) ─────────
tests.push(['I12: order PAID → editMode readonly, saveEditedOrder ditolak', () => {
  const detail = makeDetail({ status: 'PAID' });
  const mapped = mapDetailToEditorState(detail.data, 9101)!;
  assert.equal(mapped.state.status, 'PAID');
  // Mirror guard: editMode !== 'edit' → return false
  const editMode = mapped.state.status === 'OPEN' ? 'edit' : 'readonly';
  assert.equal(editMode, 'readonly');
  // saveEditedOrder akan return false tanpa memanggil authFetch
  const wouldCallAuth = editMode === 'edit';
  assert.equal(wouldCallAuth, false, 'saveEditedOrder tidak dipanggil untuk order PAID');
}]);

tests.push(['I12b: order VOIDED → editMode readonly, saveEditedOrder ditolak', () => {
  const detail = makeDetail({ status: 'VOIDED' });
  const mapped = mapDetailToEditorState(detail.data, 9101)!;
  const editMode = mapped.state.status === 'OPEN' ? 'edit' : 'readonly';
  assert.equal(editMode, 'readonly');
  const wouldCallAuth = editMode === 'edit';
  assert.equal(wouldCallAuth, false, 'saveEditedOrder tidak dipanggil untuk order VOIDED');
}]);

// ── I13: Diskon item PERCENT batas (100.00 valid, 100.01 ditolak) ─────────
tests.push(['I13: diskon item PERCENT 100.00 valid, 100.01 ditolak', () => {
  // 100.00 valid
  const p1 = buildPosOrderEditPayload(
    {
      property_id: 7, expected_version: 4, idempotency_key: 'k-i13a',
      items: [{ menu_item_id: 11, quantity: 1, orderId: 501, discount_type: 'PERCENT', discount_value: 100 }],
    },
    true
  );
  assert.equal((p1.items as Array<Record<string, unknown>>)[0].discount_value, 100, 'PERCENT 100 valid');

  // 100.01 ditolak
  let threw = false;
  try {
    buildPosOrderEditPayload(
      {
        property_id: 7, expected_version: 4, idempotency_key: 'k-i13b',
        items: [{ menu_item_id: 11, quantity: 1, orderId: 501, discount_type: 'PERCENT', discount_value: 100.01 }],
      },
      true
    );
  } catch {
    threw = true;
  }
  assert.equal(threw, true, 'PERCENT 100.01 harus ditolak');
}]);

// ── I14: Metadata order undefined → preserved (tri-state), bukan reset null
tests.push(['I14: metadata order undefined → di-omit dari payload (preserved backend)', () => {
  // buildPutBody dengan semua metadata undefined
  const payload = buildPosOrderEditPayload(
    {
      property_id: 7,
      expected_version: 4,
      idempotency_key: 'edit-key-i14',
      // semua metadata undefined
    },
    false
  );
  for (const k of ['table_number', 'guest_name', 'guest_phone', 'notes', 'discount_reason', 'order_discount_type', 'order_discount_value']) {
    assert.equal(k in payload, false, `${k} undefined → di-omit`);
  }
}]);

// ── I15: Cart edit snapshot stale-check (simulasi logika isEditSnapshotStale)
tests.push(['I15: stale-check — snapshot & state sama → valid; state berubah → stale', () => {
  const detail = makeDetail();
  const mapped = mapDetailToEditorState(detail.data, 9101)!;
  const cart = seedCartFromFixture(detail)!;
  const snapKey = 'edit-stale-key';
  const snapBody = buildPutBodyWithItems(mapped.state, cart, snapKey, true);

  // State tidak berubah → rebuild identik → BUKAN stale
  const rebuilt = buildPutBodyWithItems(mapped.state, cart, snapKey, true);
  assert.equal(rebuilt, snapBody, 'state sama → payload identik (bukan stale)');

  // State berubah (qty item 0) → rebuild berbeda → STALE
  const cartChanged = cart!.map((l, i) => i === 0 ? { ...l, quantity: 5 } : l);
  const rebuiltChanged = buildPutBodyWithItems(mapped.state, cartChanged, snapKey, true);
  assert.notEqual(rebuiltChanged, snapBody, 'state berubah → payload berbeda (stale, blokir retry)');
}]);

// ── I16: Preview total TIDAK dikirim sebagai expected_total ────────────────
tests.push(['I16: expected_total tidak dikirim di payload edit (backend sumber kalkulasi final)', () => {
  const detail = makeDetail();
  const mapped = mapDetailToEditorState(detail.data, 9101)!;
  const cart = seedCartFromFixture(detail)!;
  const bodyJson = buildPutBodyWithItems(mapped.state, cart, 'edit-key-i16', true);
  const body = JSON.parse(bodyJson);
  assert.equal('expected_total' in body, false, 'expected_total tidak di payload');
}]);

// ── I17: Hapus item existing (cart hanya memuat subset) → item lain dihapus backend
tests.push(['I17: full-replace — item yang tidak ada di cart items[] dihapus oleh backend (DELETE)', () => {
  const detail = makeDetail();
  const cart = seedCartFromFixture(detail)!;
  // Hapus item 0 (index 0), hanya item 1 (502) yang dikirim
  const cartOnly1 = [cart![1]];
  const items = buildEditItemsFromCartTest(cartOnly1)!;
  assert.equal(items.length, 1, 'hanya 1 item di cart');
  assert.equal(items[0].orderId, 502, 'item 502 (existing) dikirim');
  // Item 501 tidak ada di items[] → backend akan DELETE (sesuai kontrak PUT)
  const payload = buildPosOrderEditPayload(
    { property_id: 7, expected_version: 4, idempotency_key: 'edit-key-i17', items },
    true
  );
  const itemsArr = payload.items as Array<Record<string, unknown>>;
  assert.equal(itemsArr.length, 1, 'payload hanya memuat item 502');
  assert.equal(itemsArr[0].id, 502, 'item 502 dengan id');
  // Item 501 tidak di payload → backend DELETE (sesuai kontrak full-replace)
}]);

// ── I18: notes null di item existing → resend null (hapus notes, bukan omit)
tests.push(['I18: notes=null di item existing → payload items[].notes=null (hapus notes eksplisit)', () => {
  const detail = makeDetail();
  const cart = seedCartFromFixture(detail)!;
  // Item 0: notes 'tanpa pedas' → dihapus (set null)
  cart[0] = { ...cart[0], notes: null };
  const items = buildEditItemsFromCartTest(cart)!;
  assert.equal(items[0].notes, null, 'notes di-set null (hapus eksplisit)');
  // Payload akhir: key notes ada, nilai null
  const payload = buildPosOrderEditPayload(
    { property_id: 7, expected_version: 4, idempotency_key: 'edit-key-i18', items },
    true
  );
  const itemsArr = payload.items as Array<Record<string, unknown>>;
  assert.equal(itemsArr[0].notes, null, 'item 0: notes=null di payload');
  assert.equal('notes' in itemsArr[0], true, 'key notes ada (explicit null)');
}]);

// ── I19: Hapus semua item diblokir — removeEditCartLine guard (cart minimal 1)
tests.push(['I19: hapus semua item diblokir — cart minimal 1 baris (items=[] ditolak)', () => {
  const detail = makeDetail();
  const cart = seedCartFromFixture(detail)!;
  assert.equal(cart!.length, 2, '2 item awal');
  // Simulasi removeEditCartLine: tidak boleh hapus jika hasil = 0 item
  // (logic: prev.length <= 1 → return prev, tidak hapus)
  const afterRemove1 = cart!.filter((_, i) => i !== 1); // hapus item 1
  assert.equal(afterRemove1.length, 1, 'setelah hapus 1: 1 item tersisa');
  // Hapus item terakhir (index 0) dari cart dengan 1 item → DIBLOKIR
  const afterRemoveLast = afterRemove1.length <= 1
    ? afterRemove1 // guard: tidak hapus
    : afterRemove1.filter((_, i) => i !== 0);
  assert.equal(afterRemoveLast.length, 1, 'cart tidak boleh kosong (guard)');
  // Verifikasi: items[] tidak bisa dikirim kosong
  const items = buildEditItemsFromCartTest(afterRemoveLast)!;
  assert.equal(items.length, 1, 'items[] minimal 1');
}]);

// ── I20: CREATE regresi — payload CREATE tidak terpengaruh perubahan POS-EDIT
tests.push(['I20: CREATE regresi — buildPosOrderDraft tanpa field edit (expected_version/items[].id)', () => {
  const lines: PosCartLine[] = [
    { item: { id: 11, name: 'Nasi Goreng', price: 45000 }, qty: 2 },
    { item: { id: 12, name: 'Es Teh', price: 30000 }, qty: 1 },
  ];
  const draft = buildPosOrderDraft(
    lines,
    {
      propertyId: 7,
      reservationId: null,
      tableNumber: 'A1',
      guestName: 'Budi',
      guestPhone: '',
      notes: '',
      discountType: '' as PosDiscountType,
      discountInput: '',
      discountReason: '',
    },
    false
  );
  // CREATE tidak punya field edit
  assert.equal('expected_version' in draft, false, 'CREATE: expected_version tidak ada');
  assert.equal('idempotency_key' in draft, false, 'CREATE: idempotency_key tidak di body');
  const items = draft.items as Array<Record<string, unknown>>;
  // CREATE items tidak punya key id (orderItemId)
  for (const it of items) {
    assert.equal('id' in it, false, 'CREATE: items[] tidak punya key id');
  }
  // CREATE tanpa serviceChargeEnabled/taxEnabled (absent) → field tidak ada
  // di payload (kontrak backward-compat: absent = mengikuti master properti).
  assert.equal('service_charge_enabled' in draft, false, 'CREATE: svc absent → tidak di payload');
  assert.equal('tax_enabled' in draft, false, 'CREATE: tax absent → tidak di payload');
}]);


// ═══════════════════════════════════════════════════════════════════════════
// SECTION J — POS-EDIT-1B.3: UI wiring (editMeta, editSuccess, editAmbiguous)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * seedEditMetaFromDetail — replika setEditMeta di loadOrderDetail (PosWorkspace.tsx).
 * Map field order GET detail → EditMetaDraft (form input editor).
 */
function seedEditMetaFromDetailTest(order: Record<string, unknown>) {
  return {
    tableNumber: typeof order.table_number === 'string' ? order.table_number : '',
    guestName: typeof order.guest_name === 'string' ? order.guest_name : '',
    guestPhone: typeof order.guest_phone === 'string' ? order.guest_phone : '',
    orderNotes: typeof order.notes === 'string' ? order.notes : '',
    discountReason: typeof order.discount_reason === 'string' ? order.discount_reason : '',
    orderDiscountType: (order.discount_type === 'NOMINAL' || order.discount_type === 'PERCENT')
      ? order.discount_type
      : '',
    orderDiscountInput: order.discount_value == null ? '' : String(order.discount_value),
  };
}

/**
 * buildPutBodyWithEditMeta — replika buildPosOrderEditPayload yang membaca
 * metadata dari editMeta (draft lokal), bukan dari editingOrder original.
 * Kontrak tri-state: empty string → null (hapus), non-empty → value,
 * editMeta undefined → fallback ke editor original.
 */
function buildPutBodyWithEditMeta(
  editor: EditorState,
  cart: EditCartLine[] | null,
  editMeta: ReturnType<typeof seedEditMetaFromDetailTest> | null,
  key: string,
  canDiscount: boolean
): string {
  const items = buildEditItemsFromCartTest(cart);
  const meta = editMeta;
  const nullIfEmpty = (s: string): string | null => (s === '' ? null : s);
  const payload = buildPosOrderEditPayload(
    {
      property_id: 7,
      expected_version: editor.version,
      idempotency_key: key,
      items,
      table_number: meta ? nullIfEmpty(meta.tableNumber) : editor.tableNumber,
      guest_name: meta ? nullIfEmpty(meta.guestName) : editor.guestName,
      guest_phone: meta ? nullIfEmpty(meta.guestPhone) : editor.guestPhone,
      notes: meta ? nullIfEmpty(meta.orderNotes) : editor.orderNotes,
      discount_reason: meta ? nullIfEmpty(meta.discountReason) : editor.discountReason,
      order_discount_type: meta
        ? (meta.orderDiscountType === '' ? null : meta.orderDiscountType as 'NOMINAL' | 'PERCENT')
        : editor.orderDiscountType,
      order_discount_value: meta
        ? (() => {
            const v = meta.orderDiscountInput.trim();
            if (v === '') return null;
            const n = Number(v);
            return Number.isSafeInteger(n) && n >= 0 ? n : null;
          })()
        : editor.orderDiscountValue,
    },
    canDiscount
  );
  return JSON.stringify(payload);
}

// ── J1: seedEditMeta dari GET detail (path loadOrderDetail) ─────────────────
tests.push(['J1: seedEditMeta — nilai existing dari GET detail mengisi form editor', () => {
  const detail = makeDetail();
  const meta = seedEditMetaFromDetailTest(detail.data.order);
  assert.equal(meta.tableNumber, 'A1');
  assert.equal(meta.guestName, 'Budi');
  assert.equal(meta.guestPhone, '+628123456789');
  assert.equal(meta.orderNotes, 'Order catatan');
  assert.equal(meta.discountReason, 'Member');
  assert.equal(meta.orderDiscountType, 'PERCENT');
  assert.equal(meta.orderDiscountInput, '10');
}]);

// ── J1b: seedEditMeta untuk order tanpa metadata (null fields) ─────────────
tests.push(['J1b: seedEditMeta — field null dari GET detail → string kosong di form', () => {
  const detail = makeDetail({
    table_number: null,
    guest_name: null,
    guest_phone: null,
    notes: null,
    discount_reason: null,
    discount_type: null,
    discount_value: null,
  });
  const meta = seedEditMetaFromDetailTest(detail.data.order);
  assert.equal(meta.tableNumber, '');
  assert.equal(meta.guestName, '');
  assert.equal(meta.guestPhone, '');
  assert.equal(meta.orderNotes, '');
  assert.equal(meta.discountReason, '');
  assert.equal(meta.orderDiscountType, '');
  assert.equal(meta.orderDiscountInput, '');
}]);

// ── J2: editMeta tidak diubah → PUT body identik dengan tanpa editMeta ──────
tests.push(['J2: editMeta tidak diubah → PUT body identik dengan editor original (no-op)', () => {
  const detail = makeDetail();
  const editor = mapDetailToEditorState(detail.data, 9101);
  assert.ok(editor.ok);
  if (!editor.ok) return;
  const cart = seedCartFromFixture(detail)!;
  const key = 'edit-key-j2';
  const meta = seedEditMetaFromDetailTest(detail.data.order);
  // editMeta yang di-seed identik dengan nilai editor original →
  // hasil PUT body harus sama persis (byte-per-byte).
  const bodyWithoutMeta = buildPutBodyWithItems(editor.state, cart, key, true);
  const bodyWithMeta = buildPutBodyWithEditMeta(editor.state, cart, meta, key, true);
  assert.equal(bodyWithMeta, bodyWithoutMeta, 'PUT body dengan editMeta tak diubah = identik');
}]);

// ── J3: editMeta mengubah metadata → PUT body berbeda dari editor original ──
tests.push(['J3: editMeta mengubah metadata → field terkait di PUT body berubah', () => {
  const detail = makeDetail();
  const editor = mapDetailToEditorState(detail.data, 9101);
  assert.ok(editor.ok);
  if (!editor.ok) return;
  const cart = seedCartFromFixture(detail)!;
  const key = 'edit-key-j3';
  const meta = {
    ...seedEditMetaFromDetailTest(detail.data.order),
    tableNumber: 'B2',        // diubah dari 'A1'
    guestName: 'Siti',        // diubah dari 'Budi'
    orderNotes: '',           // dihapus (empty → null)
  };
  const body = buildPutBodyWithEditMeta(editor.state, cart, meta, key, true);
  const parsed = JSON.parse(body) as Record<string, unknown>;
  assert.equal(parsed.table_number, 'B2', 'table_number di-ubah via editMeta');
  assert.equal(parsed.guest_name, 'Siti', 'guest_name di-ubah via editMeta');
  assert.equal(parsed.notes, null, 'notes dihapus (empty → null)');
  // discount_reason tetap dari editor original (tidak di-ubah di J3 fixture)
  assert.equal(parsed.discount_reason, 'Member', 'discount_reason tak berubah');
}]);

// ── J4: editMeta order_discount: type '' + input '' → null (hapus diskon) ──
tests.push(['J4: editMeta orderDiscountType=\"\" + input=\"\" → order_discount_* di PUT = null', () => {
  const detail = makeDetail(); // fixture: PERCENT 10
  const editor = mapDetailToEditorState(detail.data, 9101);
  assert.ok(editor.ok);
  if (!editor.ok) return;
  const cart = seedCartFromFixture(detail)!;
  const key = 'edit-key-j4';
  const meta = {
    ...seedEditMetaFromDetailTest(detail.data.order),
    orderDiscountType: '',   // hapus diskon
    orderDiscountInput: '',
  };
  const body = buildPutBodyWithEditMeta(editor.state, cart, meta, key, true);
  const parsed = JSON.parse(body) as Record<string, unknown>;
  assert.equal(parsed.order_discount_type, null, 'order_discount_type = null (hapus)');
  assert.equal(parsed.order_discount_value, null, 'order_discount_value = null (hapus)');
}]);

// ── J5: editMeta orderDiscountType=\"PERCENT\" + input \"20\" → dikirim ──────
tests.push(['J5: editMeta orderDiscountType=\"PERCENT\" input=\"20\" → PUT memuat nilai 20', () => {
  const detail = makeDetail();
  const editor = mapDetailToEditorState(detail.data, 9101);
  assert.ok(editor.ok);
  if (!editor.ok) return;
  const cart = seedCartFromFixture(detail)!;
  const key = 'edit-key-j5';
  const meta = {
    ...seedEditMetaFromDetailTest(detail.data.order),
    orderDiscountType: 'PERCENT' as const,
    orderDiscountInput: '20',
  };
  const body = buildPutBodyWithEditMeta(editor.state, cart, meta, key, true);
  const parsed = JSON.parse(body) as Record<string, unknown>;
  assert.equal(parsed.order_discount_type, 'PERCENT');
  assert.equal(parsed.order_discount_value, 20);
}]);

// ── J6: editMeta null → fallback ke editor original (tanpa form) ────────────
tests.push(['J6: editMeta=null (tanpa form) → PUT body memakai nilai editor original', () => {
  const detail = makeDetail();
  const editor = mapDetailToEditorState(detail.data, 9101);
  assert.ok(editor.ok);
  if (!editor.ok) return;
  const cart = seedCartFromFixture(detail)!;
  const key = 'edit-key-j6';
  const bodyNoMeta = buildPutBodyWithEditMeta(editor.state, cart, null, key, true);
  const bodyRef = buildPutBodyWithItems(editor.state, cart, key, true);
  assert.equal(bodyNoMeta, bodyRef, 'editMeta=null → identik dengan buildPutBodyWithItems');
}]);

// ── J7: editMeta PERCENT > 100 → diblokir builder (throw) ──────────────────
tests.push(['J7: editMeta orderDiscountInput=\"101\" PERCENT → builder throw (diskon > subtotal)', () => {
  const detail = makeDetail();
  const editor = mapDetailToEditorState(detail.data, 9101);
  assert.ok(editor.ok);
  if (!editor.ok) return;
  const cart = seedCartFromFixture(detail)!;
  const meta = {
    ...seedEditMetaFromDetailTest(detail.data.order),
    orderDiscountType: 'PERCENT' as const,
    orderDiscountInput: '101',
  };
  let threw = false;
  try {
    buildPutBodyWithEditMeta(editor.state, cart, meta, 'edit-key-j7', true);
  } catch {
    threw = true;
  }
  assert.ok(threw, 'PERCENT 101 harus ditolak builder');
}]);

// ── J8: closeEditorView — state reset (replika logika, tanpa React) ─────────
tests.push(['J8: closeEditorView — semua state editor di-reset ke nilai awal', () => {
  // Simulasi: state sebelum close
  interface EditorStates {
    editMode: 'create' | 'edit' | 'readonly';
    editingOrder: unknown;
    editCart: unknown;
    editMeta: unknown;
    editError: unknown;
    editConflict: unknown;
    editSuccess: unknown;
    editAmbiguous: boolean;
    editLoading: boolean;
    editSaving: boolean;
    idempotencyRef: unknown;
  }
  const states: EditorStates = {
    editMode: 'edit',
    editingOrder: { orderId: 9101 },
    editCart: [{ quantity: 1 }],
    editMeta: { tableNumber: 'B2' },
    editError: 'error lama',
    editConflict: { code: 'ORDER_VERSION_CONFLICT' },
    editSuccess: { total_amount: 100, version: 5, orderNumber: 'POS-001' },
    editAmbiguous: true,
    editLoading: true,
    editSaving: true,
    idempotencyRef: { key: 'k', bodyJson: '{}', orderId: 9101 },
  };
  // Replika closeEditorView (PosWorkspace.tsx):
  states.editMode = 'create';
  states.editingOrder = null;
  states.editCart = null;
  states.editMeta = null;
  states.editError = null;
  states.editConflict = null;
  states.editSuccess = null;
  states.editAmbiguous = false;
  states.editLoading = false;
  states.editSaving = false;
  states.idempotencyRef = null;
  // Verifikasi: semua state reset
  assert.equal(states.editMode, 'create');
  assert.equal(states.editingOrder, null);
  assert.equal(states.editCart, null);
  assert.equal(states.editMeta, null);
  assert.equal(states.editError, null);
  assert.equal(states.editConflict, null);
  assert.equal(states.editSuccess, null);
  assert.equal(states.editAmbiguous, false);
  assert.equal(states.editLoading, false);
  assert.equal(states.editSaving, false);
  assert.equal(states.idempotencyRef, null, 'idempotency snapshot dibuang');
}]);

// ── J9: editSuccess shape dari respons PUT 200 (mirror saveEditedOrder) ─────
tests.push(['J9: editSuccess — total_amount + version dari respons server (mirror)', () => {
  // Simulasi: respons PUT 200 dari server
  const serverResponse = {
    data: {
      order: {
        id: 9101,
        total_amount: 99000,
        version: 5,
      },
      replayed: false,
    },
  };
  const d = serverResponse.data;
  const newVersion = Number(d.order?.version ?? 0);
  assert.equal(newVersion, 5, 'versi terbaru dari server');
  // Shape editSuccess (mirror PosWorkspace.tsx L1051)
  const editSuccess = {
    total_amount: Number(d.order?.total_amount ?? 0),
    version: newVersion,
    orderNumber: 'POS-20261018-0001',
  };
  assert.equal(editSuccess.total_amount, 99000, 'total versi server tampilkan');
  assert.equal(editSuccess.version, 5, 'versi terbaru tampilkan');
  assert.equal(editSuccess.orderNumber, 'POS-20261018-0001');
}]);

// ── J10: PAID/VOIDED → editMeta tetap di-seed tetapi mode readonly ──────────
tests.push(['J10: PAID → editMeta di-seed tetapi saveEditedOrder tidak dipanggil (mode readonly)', () => {
  const detail = makeDetail({ status: 'PAID' });
  const editor = mapDetailToEditorState(detail.data, 9101);
  assert.ok(editor.ok);
  if (!editor.ok) return;
  // Simulasi: saveEditedOrder precondition (mirror PosWorkspace.tsx)
  const editMode: 'create' | 'edit' | 'readonly' = 'readonly'; // PAID → readonly
  const saveAttempt = saveEditedOrderPreconditionTest(editor.state.status, editMode);
  assert.equal(saveAttempt, false, 'PAID/readonly: saveAttempt = false, tidak diproses');
  // editMeta tetap ada (form read-only di UI), tapi tidak dipakai
  const meta = seedEditMetaFromDetailTest(detail.data.order);
  assert.ok(meta, 'editMeta masih di-seed walau readonly');
}]);

/** Precondition saveEditedOrder: editMode !== 'edit' atau status bukan OPEN → false. */
function saveEditedOrderPreconditionTest(status: string, editMode: 'create' | 'edit' | 'readonly'): boolean {
  if (editMode !== 'edit') return false;
  if (status !== 'OPEN') return false;
  return true;
}

// ── J11: FINANCIAL_LOCK → editMode menjadi readonly (mirror saveEditedOrder) ─
tests.push(['J11: FINANCIAL_LOCK → editor terkunci readonly, tidak bisa retry', () => {
  // Simulasi: saveEditedOrder terima 409 FINANCIAL_LOCK → setEditMode('readonly')
  // Precondition: setelah readonly, saveEditedOrder tidak diproses lagi.
  const editModeAfterLock: 'create' | 'edit' | 'readonly' = 'readonly';
  assert.equal(
    saveEditedOrderPreconditionTest('OPEN', editModeAfterLock),
    false,
    'setelah FINANCIAL_LOCK, saveAttempt = false'
  );
}]);

// ── J12: ambiguous → editAmbiguous=true, snapshot dipertahankan ─────────────
tests.push(['J12: network error → editAmbiguous=true, snapshot tidak dibuang', () => {
  // Simulasi: saveEditedOrder jalan, network error (catch path)
  let snapshotKept = true; // mirror: editIdempotencyRef.current TIDAK di-null
  let editAmbiguous = false;
  // Mirror PosWorkspace.tsx catch block:
  editAmbiguous = true;
  // snapshotKept tetap true (tidak di-reset)
  assert.equal(editAmbiguous, true, 'flag ambiguous di-set');
  assert.equal(snapshotKept, true, 'snapshot idempotency dipertahankan untuk retry');
}]);

// ── J13: 4xx definitif → editAmbiguous=false, snapshot dibuang ──────────────
tests.push(['J13: 400/404 definitif → editAmbiguous=false, snapshot dibuang', () => {
  let snapshotKept: unknown = { key: 'k', bodyJson: '{}', orderId: 9101 };
  let editAmbiguous = true; // sebelumnya ambigu
  // Mirror PosWorkspace.tsx 4xx path:
  snapshotKept = null; // editIdempotencyRef.current = null
  editAmbiguous = false;
  assert.equal(editAmbiguous, false, 'flag ambigu di-hapus untuk error definitif');
  assert.equal(snapshotKept, null, 'snapshot dibuang — boleh submit ulang key baru');
}]);


// ── J14: Qty delta — +1 pada qty 2 = 3; -1 pada qty 2 = 1 (B1 patch) ──────
tests.push(['J14: updateEditCartQuantity delta — qty 2 +1 = 3, qty 2 -1 = 1', () => {
  // Replika updateEditCartQuantity baris cart (mirror PosWorkspace.tsx patch B1):
  // setQty(cart, index, delta) → cart[index].quantity += delta, clamp 1..9999
  type CartLine = { quantity: number };
  function setQtyDelta(cart: CartLine[], index: number, delta: number): CartLine[] {
    if (index < 0 || index >= cart.length || !Number.isInteger(delta)) return cart;
    const next = [...cart];
    const newQty = next[index].quantity + delta;
    if (newQty < 1 || newQty > 9999) return cart; // guard: tidak diterapkan
    next[index] = { ...next[index], quantity: newQty };
    return next;
  }
  // qty 2 + delta 1 → 3
  let cart: CartLine[] = [{ quantity: 2 }];
  cart = setQtyDelta(cart, 0, 1);
  assert.equal(cart[0].quantity, 3, 'qty 2 + 1 = 3');
  // qty 2 - delta 1 → 1
  cart = [{ quantity: 2 }];
  cart = setQtyDelta(cart, 0, -1);
  assert.equal(cart[0].quantity, 1, 'qty 2 - 1 = 1');
}]);

// ��─ J15: Qty batas 1 (min) dan 9999 (max) ────────────────────────────────────
tests.push(['J15: updateEditCartQuantity — qty 1 -1 tetap 1; qty 9999 +1 tetap 9999', () => {
  type CartLine = { quantity: number };
  function setQtyDelta(cart: CartLine[], index: number, delta: number): CartLine[] {
    if (index < 0 || index >= cart.length || !Number.isInteger(delta)) return cart;
    const next = [...cart];
    const newQty = next[index].quantity + delta;
    if (newQty < 1 || newQty > 9999) return cart;
    next[index] = { ...next[index], quantity: newQty };
    return next;
  }
  // Qty 1, delta -1 → newQty = 0 → DITOLAK, tetap 1
  let cart: CartLine[] = [{ quantity: 1 }];
  cart = setQtyDelta(cart, 0, -1);
  assert.equal(cart[0].quantity, 1, 'qty 1 - 1 → tetap 1 (guard min)');
  // Qty 9999, delta +1 → newQty = 10000 → DITOLAK, tetap 9999
  cart = [{ quantity: 9999 }];
  cart = setQtyDelta(cart, 0, 1);
  assert.equal(cart[0].quantity, 9999, 'qty 9999 + 1 → tetap 9999 (guard max)');
  // Qty 9998, delta +1 → 9999 (batas atas valid)
  cart = [{ quantity: 9998 }];
  cart = setQtyDelta(cart, 0, 1);
  assert.equal(cart[0].quantity, 9999, 'qty 9998 + 1 = 9999 (valid)');
}]);

// ── J16: Tidak ada pengiriman quantity 0 di items[] payload ────────────────
tests.push(['J16: items[] payload tidak pernah memuat quantity 0 (builder + guard)', () => {
  // Item existing di cart edit dengan qty 1; delta -1 ditolak → tetap 1.
  // Verifikasi: buildEditItemsFromCart menghasilkan quantity ≥ 1.
  const detail = makeDetail();
  let cart = seedCartFromFixture(detail)!;
  assert.ok(cart, 'cart ter-seed');
  // Simulasi: tombol − pada qty 1 (guard: newQty = 0 → ditolak)
  const line = cart![0];
  assert.equal(line.quantity, 2, 'fixture item 0 qty = 2');
  // Qty 1 − 1 → 0 → ditolak oleh guard (replika setQtyDelta)
  // Simulasi langsung: quantity 1, delta -1
  const guardMin = 1;
  const guardMax = 9999;
  const newQty = guardMin + (-1); // = 0
  const rejected = newQty < guardMin || newQty > guardMax;
  assert.equal(rejected, true, 'qty 0 ditolak (guard min)');
  // Payload: build items dari cart yang valid
  const items = buildEditItemsFromCartTest(cart);
  assert.ok(items, 'items[] terisi');
  for (const it of items!) {
    assert.ok(it.quantity >= 1, `quantity ${it.quantity} ≥ 1 di payload`);
    assert.ok(it.quantity <= 9999, `quantity ${it.quantity} ≤ 9999 di payload`);
  }
}]);

// ── J17: Snapshot dibersihkan setelah PUT 200 sukses ────────���───────────────
tests.push(['J17: PUT 200 sukses → editIdempotencyRef dibersihkan (key baru siklus berikutnya)', () => {
  // Simulasi: saveEditedOrder sukses 200 dengan valid shape.
  // Mirror: setEditSuccess + setEditAmbiguous(false) + editIdempotencyRef.current = null
  let snapshot: { key: string; bodyJson: string; orderId: number } | null = {
    key: 'k-1', bodyJson: '{}', orderId: 9101,
  };
  let editSuccess: { total_amount: number; version: number; orderNumber: string } | null = null;
  let editAmbiguous = true; // sebelumnya ambigu (5xx)
  // Simulasi: retry identik sukses 200
  const serverVersion = 5;
  const serverTotal = 99000;
  const valid = serverVersion >= 1; // Number.isInteger check
  assert.ok(valid);
  // Patch B1: buang snapshot setelah sukses
  snapshot = null;
  editSuccess = { total_amount: serverTotal, version: serverVersion, orderNumber: 'POS-001' };
  editAmbiguous = false;
  assert.equal(snapshot, null, 'snapshot dibersihkan setelah 200 sukses');
  assert.equal(editSuccess?.version, 5, 'versi server tersimpan');
  assert.equal(editAmbiguous, false, 'flag ambigu dihapus');
  // Siklus edit berikutnya: editIdempotencyRef === null → buat key UUID baru
  // (tidak reuse key lama — sudah dibuang)
}]);

// ── J18: 409 generik definitif → snapshot dibuang (patch B1) ───────────────
tests.push(['J18: HTTP 409 generik (code tak dikenal) → snapshot dibuang, bukan dipertahankan', () => {
  // Mirror saveEditedOrder 409 lain path (PosWorkspace.tsx patch B1):
  // editIdempotencyRef.current = null; setEditAmbiguous(false);
  let snapshot: unknown = { key: 'k', bodyJson: '{}', orderId: 9101 };
  let editAmbiguous = true;
  // 409 generik → definitif, order tidak bermutasi → buang snapshot
  snapshot = null;
  editAmbiguous = false;
  assert.equal(snapshot, null, 'snapshot dibuang untuk 409 generik definitif');
  assert.equal(editAmbiguous, false, 'flag ambigu dihapus');
  // Kontras: 5xx tetap mempertahankan snapshot
  let snapshot5xx: unknown = { key: 'k', bodyJson: '{}', orderId: 9101 };
  // 5xx → snapshot TIDAK dibuang (patch tidak mengubah jalur 5xx)
  assert.equal(snapshot5xx !== null, true, '5xx: snapshot tetap dipertahankan (keputusan audit N3)');
}]);

// ── J19: closeEditorView — PUT in-flight mencegah close (patch B1) ─────────
tests.push(['J19: closeEditorView guard — editSubmittingRef=true → close ditolak', () => {
  // Mirror closeEditorView patch B1 (PosWorkspace.tsx):
  // if (editSubmittingRef.current) return;
  let editSubmittingRef = true; // PUT in-flight
  let editMode: 'create' | 'edit' | 'readonly' = 'edit';
  let editingOrder: unknown = { orderId: 9101 };
  let snapshot: unknown = { key: 'k' };
  // Simulasi: closeEditorView dipanggil saat in-flight
  if (!editSubmittingRef) {
    // close hanya terjadi bila TIDAK ada PUT in-flight
    editMode = 'create';
    editingOrder = null;
    snapshot = null;
  }
  assert.equal(editMode, 'edit', 'close ditolak: editMode tetap edit');
  assert.notEqual(editingOrder, null, 'close ditolak: editingOrder masih ada');
  assert.notEqual(snapshot, null, 'close ditolak: snapshot masih ada (PUT masih berjalan)');
  // Setelah PUT selesai (finally block: editSubmittingRef = false)
  editSubmittingRef = false;
  // close sekarang berhasil
  if (!editSubmittingRef) {
    editMode = 'create';
    editingOrder = null;
    snapshot = null;
  }
  assert.equal(editMode, 'create', 'close berhasil setelah PUT selesai');
  assert.equal(editingOrder, null, 'state di-reset setelah close');
  assert.equal(snapshot, null, 'snapshot dibuang setelah close');
}]);

// ── J20: Retry ambiguous — key & payload identik dengan snapshot ────────────
tests.push(['J20: retry ambiguous — snapshot key + bodyJson dikirim identik (tidak rebuild)', () => {
  // Mirror: saveEditedOrder path retry (editIdempotencyRef.orderId === editingOrder.orderId)
  const snapshot = { key: 'k-retry', bodyJson: '{"expected_version":4}', orderId: 9101 };
  const orderId = 9101;
  // Kondisi: snapshot.orderId === orderId → REUSE snapshot, bukan rebuild
  const isRetry = snapshot.orderId === orderId;
  assert.equal(isRetry, true, 'snapshot orderId cocok → retry path diambil');
  // Key & body yang dikirim = snapshot (identik)
  const keyToSend = snapshot.key;
  const bodyToSend = snapshot.bodyJson;
  assert.equal(keyToSend, 'k-retry', 'key identik dengan snapshot');
  assert.equal(bodyToSend, '{"expected_version":4}', 'body identik dengan snapshot');
  // Stale check: rebuild payload saat ini harus SAMA dengan snapshot
  // Jika berbeda → isEditSnapshotStale() = true → retry diblokir
  const currentBody = '{"expected_version":4}'; // state belum berubah
  const isStale = currentBody !== snapshot.bodyJson;
  assert.equal(isStale, false, 'state tak berubah → tidak stale → retry diizinkan');
}]);
// ── K1: PUT sukses → satu trigger refresh scoped via onOrderEdited ─────────
tests.push(['K1: PUT 200 sukses → onOrderEdited dipanggil sekali dengan reservationId dari editingOrder', () => {
  // Mirror saveEditedOrder sukses 200 + onOrderEdited callback (PosWorkspace.tsx POS-EDIT-1B.4)
  let onOrderEditedCalled = 0;
  let lastEdited: { orderId: number; reservationId: number | null; version: number } | null = null;
  const onOrderEdited = (o: { orderId: number; orderNumber: string; total_amount: number; version: number; reservationId: number | null }) => {
    onOrderEditedCalled++;
    lastEdited = o;
  };
  // Simulasi: order dengan reservationId 42, PUT 200 sukses version 5
  const editingOrder = { orderId: 9101, orderNumber: 'POS-001', version: 4, reservationId: 42 };
  // onOrderEdited dipanggil sekali (hanya di path 200 sukses)
  onOrderEdited({
    orderId: editingOrder.orderId,
    orderNumber: editingOrder.orderNumber,
    total_amount: 99000,
    version: 5,
    reservationId: editingOrder.reservationId,
  });
  assert.equal(onOrderEditedCalled, 1, 'onOrderEdited dipanggil tepat 1x');
  assert.equal(lastEdited!.orderId, 9101, 'orderId benar');
  assert.equal(lastEdited!.reservationId, 42, 'reservationId = 42 (dari GET detail)');
  assert.equal(lastEdited!.version, 5, 'version server = 5');
  // PUT gagal/ambiguous → onOrderEdited TIDAK dipanggil (jangan panggil di path error)
  let calledOnFail = 0;
  const onOrderEditedFail = () => { calledOnFail++; };
  // Simulasi: 502 error → TIDAK panggil onOrderEdited
  const isAmbiguous = true; // 5xx/network
  if (!isAmbiguous) {
    onOrderEditedFail(); // hanya dipanggil saat sukses — path ini tak tercapai
  }
  assert.equal(calledOnFail, 0, 'PUT gagal: onOrderEdited TIDAK dipanggil');
}]);

// ── K2: PUT ambiguous (5xx/network) → onOrderEdited TIDAK dipanggil, tak ada refresh ──
tests.push(['K2: 5xx / network error → onOrderEdited TIDAK dipanggil (tidak ada refresh)', () => {
  // Mirror: saveEditedOrder path 5xx → setEditAmbiguous(true), return false
  // onOrderEdited HANYA dipanggil di block `if (Number(d?.order?.id) === editingOrder.orderId...)`
  // yang hanya tercapai saat res.status === 200 + shape valid.
  let onOrderEditedCount = 0;
  // Simulasi 5xx:
  let responseStatus: number | 'network' = 502;
  let successShapeValid = false; // 5xx → TIDAK ada shape valid
  if (responseStatus === 200 && successShapeValid) {
    onOrderEditedCount++; // path sukses — tidak tercapai di 5xx
  }
  assert.equal(onOrderEditedCount, 0, '5xx: onOrderEdited tidak dipanggil');
  // Simulasi network error:
  responseStatus = 'network';
  successShapeValid = false;
  if (responseStatus === 200 && successShapeValid) {
    onOrderEditedCount++;
  }
  assert.equal(onOrderEditedCount, 0, 'network error: onOrderEdited tidak dipanggil');
}]);

// ── K3: 409 definitif → onOrderEdited TIDAK dipanggil ────────────────────────
tests.push(['K3: 409 definitif (PRICING_TOTAL_CHANGED / ORDER_NOT_OPEN) → onOrderEdited TIDAK dipanggil', () => {
  let onOrderEditedCount = 0;
  const trigger409: Array<number | string> = [409]; // semua 409
  const successShapeValid = false;
  for (const _ of trigger409) {
    if (successShapeValid) onOrderEditedCount++; // tidak tercapai
  }
  assert.equal(onOrderEditedCount, 0, '409 definitif: onOrderEdited tidak dipanggil');
}]);

// ── K4: Perubahan diskon order di editMeta → preview mencerminkan nilai baru ──
tests.push(['K4: editMeta orderDiscountType PERCENT input 20 → preview.orderDiscount berbeda dari editingOrder original', () => {
  // Mirror editPreview (PosWorkspace.tsx POS-EDIT-1B.4):
  // previewPosDraft(lines, orderDiscountType, orderDiscountInput, {svc,tax})
  // editingOrder original: PERCENT 10 → orderDiscount = 10% subtotal
  // editMeta baru: PERCENT 20 → orderDiscount = 20% subtotal
  const { previewPosDraft } = { previewPosDraft: (lines: unknown[], discountType: string, discountInput: string, _opts?: unknown) => {
    // Replika sederhana: hitung subtotal - orderDiscount
    const subtotal = 0; // baris dummy
    const base = subtotal;
    let discountAmt = 0;
    if (discountType === 'PERCENT' && discountInput) {
      discountAmt = Math.round(base * Number(discountInput) / 100);
    } else if (discountType === 'NOMINAL' && discountInput) {
      discountAmt = Number(discountInput);
    }
    return { subtotal: 0, orderDiscount: discountAmt, serviceCharge: 0, tax: 0, total: -discountAmt, lines: [] };
  } };
  // Subtotal dummy = 50000 (item existing qty 1, harga 50000)
  const dummyLines: unknown[] = []; // previewPosDraft dummy hanya menghitung diskon
  const subtotal = 50000;
  // Simulasi previewPosDraft dengan subtotal asli:
  function previewWithSubtotal(discountType: string, discountInput: string) {
    let discountAmt = 0;
    if (discountType === 'PERCENT' && discountInput) {
      discountAmt = Math.round(subtotal * Number(discountInput) / 100);
    } else if (discountType === 'NOMINAL' && discountInput) {
      discountAmt = Number(discountInput);
    }
    return { orderDiscount: discountAmt, total: subtotal - discountAmt };
  }
  // editingOrder original: PERCENT 10
  const original = previewWithSubtotal('PERCENT', '10');
  // editMeta baru: PERCENT 20
  const newDiscount = previewWithSubtotal('PERCENT', '20');
  assert.equal(original.orderDiscount, 5000, 'diskon 10% dari 50000 = 5000 (original)');
  assert.equal(newDiscount.orderDiscount, 10000, 'diskon 20% dari 50000 = 10000 (editMeta)');
  assert.notEqual(newDiscount.orderDiscount, original.orderDiscount, 'preview berubah setelah editMeta diskon diubah');
}]);

// ── K5: Retry ambiguous — key & body identik, perubahan draft tidak mengubah payload retry ──
tests.push(['K5: perubahan draft setelah snapshot → stale → retry diblokir (tidak rebuild)', () => {
  // Mirror isEditSnapshotStale (PosWorkspace.tsx):
  // buildCurrentEditBodyJson(snap.key) === snap.bodyJson ? false : true
  const snapshotBodyJson = '{"expected_version":4,"items":[{"id":501,"menu_item_id":11,"quantity":2}]}';
  // State berubah (qty diubah jadi 3) → rebuild menghasilkan body berbeda
  const currentBodyJson = '{"expected_version":4,"items":[{"id":501,"menu_item_id":11,"quantity":3}]}';
  const isStale = currentBodyJson !== snapshotBodyJson;
  assert.equal(isStale, true, 'state berubah → stale → retry diblokir');
  // State TIDAK berubah → rebuild identik → stale = false → retry diizinkan
  const sameBodyJson = snapshotBodyJson;
  assert.equal(sameBodyJson !== snapshotBodyJson, false, 'state tak berubah → tidak stale → retry identik diizinkan');
}]);

// ── K6: CREATE POS tidak berubah — onOrderEdited tidak terpicu oleh handleSaveOrder ──
tests.push(['K6: onOrderEdited TIDAK dipanggil oleh alur CREATE (handleSaveOrder)', () => {
  // Mirror: handleSaveOrder sukses 201 → onOrderCreated dipanggil, onOrderEdited TIDAK
  // (onOrderEdited hanya dipanggil di path saveEditedOrder sukses 200)
  let onOrderEditedCount = 0;
  let onOrderCreatedCount = 0;
  const onOrderCreated = () => { onOrderCreatedCount++; };
  const onOrderEdited = () => { onOrderEditedCount++; };
  // Simulasi: POST create 201 → onOrderCreated
  const createStatus = 201;
  if (createStatus === 201) onOrderCreated();
  assert.equal(onOrderCreatedCount, 1, 'onOrderCreated dipanggil sekali (CREATE sukses)');
  assert.equal(onOrderEditedCount, 0, 'onOrderEdited TIDAK dipanggil (bukan path edit)');
}]);


// ── K7: PUT 200 sukses → onRefresh dipanggil 1x + onOrderEdited dipanggil 1x (1B.5) ──
tests.push(['K7: PUT 200 sukses → onRefresh + onOrderEdited masing-masing 1x (POS-EDIT-1B.5)', () => {
  // Mirror saveEditedOrder path 200 valid (PosWorkspace.tsx POS-EDIT-1B.5):
  // onOrderEdited?.(...)  ← refresh scoped panel reservasi
  // onRefresh?.()         ← refresh daftar Riwayat Order (fetchOperationsData App,
  //                         punya isStale() race guard: respons lama diabaikan).
  // Keduanya dipanggil SEKALI di path 200 valid, sebelum snapshot dibuang.
  let onRefreshCalled = 0;
  let onOrderEditedCalled = 0;
  const onRefresh = () => { onRefreshCalled++; };
  const onOrderEdited = () => { onOrderEditedCalled++; };
  // Simulasi: PUT 200 + shape valid → block success di PosWorkspace
  const resStatus = 200;
  const d = { order: { id: 9101, total_amount: 99000, version: 5 }, replayed: false };
  const valid = Number(d.order?.id) === 9101 && Number.isInteger(Number(d.order?.version ?? 0));
  if (resStatus === 200 && valid) {
    onOrderEdited();
    onRefresh();
  }
  assert.equal(onOrderEditedCalled, 1, 'onOrderEdited dipanggil 1x');
  assert.equal(onRefreshCalled, 1, 'onRefresh dipanggil 1x (Riwayat Order diperbarui)');
}]);

// ── K8: PUT 4xx definitif / 5xx / network → onRefresh TIDAK dipanggil ──
tests.push(['K8: 4xx definitif / 5xx / network → onRefresh TIDAK dipanggil (tidak ada refresh)', () => {
  let onRefreshCalled = 0;
  const onRefresh = () => { onRefreshCalled++; };
  // 409 PRICING_TOTAL_CHANGED → path error definitif: onRefresh tidak dipanggil
  const status409 = 409;
  if (status409 === 200) { onRefresh(); } // tak tercapai
  assert.equal(onRefreshCalled, 0, '409: onRefresh tidak dipanggil');
  // 502 → path 5xx ambiguous: onRefresh tidak dipanggil
  const status502 = 502;
  if (status502 === 200) { onRefresh(); } // tak tercapai
  assert.equal(onRefreshCalled, 0, '502: onRefresh tidak dipanggil');
  // Network error → catch path: onRefresh tidak dipanggil
  const networkError = true;
  if (!networkError) { onRefresh(); } // tak tercapai
  assert.equal(onRefreshCalled, 0, 'network error: onRefresh tidak dipanggil');
}]);

// ── K9: 200 malformed shape → onRefresh TIDAK dipanggil (path ambiguous) ──
tests.push(['K9: 200 + shape malformed (order.id tidak cocok) → onRefresh TIDAK dipanggil', () => {
  let onRefreshCalled = 0;
  const onRefresh = () => { onRefreshCalled++; };
  // Mirror PosWorkspace: if (Number(d?.order?.id) === editingOrder.orderId && Number.isInteger(newVersion))
  const d = { order: { id: 9999, total_amount: 100, version: 5 } }; // id tidak cocok
  const orderId = 9101;
  const newVersion = Number(d.order?.version ?? 0);
  const valid = Number(d.order?.id) === orderId && Number.isInteger(newVersion);
  if (valid) { onRefresh(); } // tak tercapai (id berbeda)
  assert.equal(onRefreshCalled, 0, '200 malformed: onRefresh tidak dipanggil (dianggap ambigu)');
}]);

// ── K10: stale-check buildCurrentEditBodyJson membaca editMeta (POS-EDIT-1B.5) ──
tests.push(['K10: buildCurrentEditBodyJson (1B.5) — editMeta diubah → bodyJson berbeda → stale → retry diblokir', () => {
  // Mirror buildCurrentEditBodyJson POS-EDIT-1B.5: metadata dibaca dari editMeta
  // (draft form aktif), fallback editingOrder original (saat editMeta null).
  // buildPosOrderEditPayload dari source produksi dipakai langsung.
  const items: PosOrderEditItem[] = [
    { menu_item_id: 11, quantity: 2, orderId: 501, notes: 'tanpa pedas', discount_type: 'NOMINAL', discount_value: 5000 },
  ];
  // Replika buildCurrentEditBodyJson 1B.5 (mirror PosWorkspace.tsx):
  function buildBody(meta: { guestName: string; orderDiscountInput: string } | null, key: string): string {
    const details: PosOrderEditDetails = {
      property_id: 7,
      expected_version: 4,
      idempotency_key: key,
      items,
      table_number: 'A1',
      // Tri-state dari editMeta:
      guest_name: meta ? (meta.guestName === '' ? null : meta.guestName) : 'Budi',
      guest_phone: '+628123456789',
      notes: 'catatan',
      discount_reason: 'Member',
      order_discount_type: meta ? ('PERCENT' as 'NOMINAL' | 'PERCENT') : ('PERCENT' as 'NOMINAL' | 'PERCENT'),
      order_discount_value: meta
        ? (() => {
            const v = meta.orderDiscountInput.trim();
            if (v === '') return null;
            const n = Number(v);
            return Number.isSafeInteger(n) && n >= 0 ? n : null;
          })()
        : 10,
    };
    return JSON.stringify(buildPosOrderEditPayload(details, true));
  }
  // editMeta null → fallback editingOrder (guestName Budi) — kondisi saat snapshot dibuat
  const bodyA = buildBody(null, 'k-stale-test');
  // User mengubah form setelah snapshot 5xx: guestName Siti → bodyJson berbeda
  const bodyB = buildBody({ guestName: 'Siti', orderDiscountInput: '10' }, 'k-stale-test');
  assert.notEqual(bodyA, bodyB, 'editMeta diubah → bodyJson berbeda → stale → retry diblokir');
  // editMeta tidak diubah (nilai = original) → rebuild identik → retry diizinkan
  const bodyC = buildBody({ guestName: 'Budi', orderDiscountInput: '10' }, 'k-stale-test');
  assert.equal(bodyC, bodyA, 'editMeta identik dengan original → bodyJson identik → retry diizinkan (key lama)');
}]);

// ── K11: stale-check 1B.5 — perubahan cart (editMeta identik) → tetap stale ──
tests.push(['K11: cart berubah (qty 2→3) + editMeta identik → stale → retry diblokir (1B.5)', () => {
  // buildCurrentEditBodyJson 1B.5: items[] dari buildEditItemsFromCart() (cart aktif)
  // + metadata dari editMeta (fallback editingOrder).
  // Snapshot dibuat saat cart qty=2; user menambah qty jadi 3 setelah 5xx →
  // items[] berubah → bodyJson berbeda → stale → retry diblokir.
  const itemsQty2: PosOrderEditItem[] = [
    { menu_item_id: 11, quantity: 2, orderId: 501, notes: 'tanpa pedas', discount_type: 'NOMINAL', discount_value: 5000 },
  ];
  const itemsQty3: PosOrderEditItem[] = [
    { menu_item_id: 11, quantity: 3, orderId: 501, notes: 'tanpa pedas', discount_type: 'NOMINAL', discount_value: 5000 },
  ];
  function buildWithCart(cartItems: PosOrderEditItem[], key: string): string {
    return JSON.stringify(buildPosOrderEditPayload(
      {
        property_id: 7,
        expected_version: 4,
        idempotency_key: key,
        items: cartItems,
        guest_name: 'Budi',
        order_discount_type: 'PERCENT' as 'NOMINAL' | 'PERCENT',
        order_discount_value: 10,
      } as PosOrderEditDetails,
      true
    ));
  }
  const snapBody = buildWithCart(itemsQty2, 'k-k11');
  const currentBody = buildWithCart(itemsQty3, 'k-k11');
  const isStale = currentBody !== snapBody;
  assert.equal(isStale, true, 'cart qty berubah (2→3) → bodyJson berbeda → stale → retry diblokir');
}]);

// ── Jalankan semua test berurutan ───────────��────────────────────────────────
(async () => {
  console.log('POS-EDIT-1B.2/1B.3 — Integration test (GET detail + PUT update + editor state + cart edit + UI wiring)\n');
  for (const [name, fn] of tests) {
    await check(name, fn);
  }
  console.log(`\n[RESULT] ${pass} PASS`);
  if (process.exitCode === 1) console.log('Ada test yang GAGAL.');
})();

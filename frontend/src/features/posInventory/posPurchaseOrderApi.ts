/**
 * OAK HIMS — MP-04D POS Purchase Order, Goods Receipt & Supplier API Client
 */

import { authenticatedFetch } from '../../lib/authenticatedFetch';

export interface PosSupplier {
  id: number;
  property_id: number;
  code: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PosPurchaseOrderItem {
  id: number;
  po_id: number;
  product_id: number;
  menu_item_id?: number;
  product_name?: string;
  product_code?: string | null;
  item_code?: string | null;
  base_unit?: string | null;
  canonical_base_unit_code?: string | null;
  ordered_unit?: string | null;
  packaging_id?: number | null;
  packaging_code?: string | null;
  packaging_label?: string | null;
  conversion_factor?: number | string | null;
  conversion_factor_snapshot?: number | string | null;
  to_base_factor?: number | string | null;
  ordered_qty: string | number;
  quantity_ordered?: string | number;
  received_qty: string | number;
  already_received_qty?: string | number;
  remaining_qty?: string | number;
  invoiced_qty?: string | number;
  unit_cost: string | number;
  line_total?: string | number;
  uom_id?: number | null;
  uom_code?: string | null;
  uom_name?: string | null;
  track_stock?: boolean;
  track_inventory?: boolean;
  notes: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PosPurchaseOrder {
  id: number;
  property_id: number;
  po_number: string;
  supplier_id: number;
  canonical_supplier_id?: number | null;
  legacy_pos_supplier_id?: number | null;
  supplier_name?: string;
  supplier_code?: string;
  supplier_phone?: string | null;
  order_date: string;
  expected_date: string | null;
  destination_location_id?: number | null;
  destination_location_name?: string | null;
  destination_location_code?: string | null;
  status:
    | 'DRAFT'
    | 'PENDING_APPROVAL'
    | 'APPROVED'
    | 'REJECTED'
    | 'ORDERED'
    | 'PARTIALLY_RECEIVED'
    | 'COMPLETED'
    | 'CANCELLED';
  approval_status?: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
  receiving_status?: 'BELUM_DITERIMA' | 'DITERIMA_SEBAGIAN' | 'DITERIMA_LENGKAP';
  notes: string | null;
  subtotal_amount?: number | string;
  tax_amount?: number | string;
  total_amount?: number | string;
  total_estimated_amount?: string | number;
  created_by: string | number | null;
  submitted_by_user_id?: number | null;
  submitted_by_name_snapshot?: string | null;
  submitted_at?: string | null;
  approved_by?: number | null;
  approved_by_user_id?: number | null;
  approved_by_name_snapshot?: string | null;
  approved_at?: string | null;
  rejection_reason?: string | null;
  source_revision?: number;
  archived_at?: string | null;
  archived_by_user_id?: number | null;
  archived_by_name_snapshot?: string | null;
  archive_reason?: string | null;
  item_count?: number;
  invoice_count?: number;
  invoiced_total_amount?: number;
  paid_total_amount?: number;
  outstanding_amount?: number;
  payment_settlement_status?: 'BELUM_ADA_TAGIHAN' | 'BELUM_DIBAYAR' | 'DIBAYAR_SEBAGIAN' | 'LUNAS';
  invoice_verification_status?: 'BELUM_ADA_TAGIHAN' | 'UNVERIFIED' | 'VERIFIED' | 'REJECTED';
  has_po_variance?: boolean;
  grn_posted_count?: number;
  grn_draft_count?: number;
  receiving_progress_text?: string;
  created_at: string;
  updated_at: string;
  items?: PosPurchaseOrderItem[];
  linked_invoices?: any[];
  linked_goods_receipts?: any[];
}

export interface PosGoodsReceiptItem {
  id: number;
  receipt_id: number;
  product_id: number;
  product_name?: string;
  item_code?: string | null;
  base_unit?: string | null;
  canonical_base_unit_code?: string | null;
  po_item_id: number | null;
  transaction_line_id?: number | null;
  packaging_id?: number | null;
  packaging_code?: string | null;
  packaging_name?: string | null;
  packaging_label?: string | null;
  to_base_factor?: string | number | null;
  conversion_factor_snapshot?: string | number | null;
  source_allocated_qty?: string | number | null;
  base_quantity?: string | number | null;
  received_base_qty?: string | number | null;
  received_qty: string;
  unit_cost: string;
  subtotal: string;
  uom_id: number | null;
  uom_code?: string | null;
  uom_name?: string | null;
  location_id: number;
  location_code?: string;
  location_name?: string;
  created_at: string;
}

export interface PosGoodsReceipt {
  id: number;
  property_id: number;
  grn_number: string;
  po_id: number | null;
  po_number?: string | null;
  transaction_id?: number | null;
  transaction_number?: string | null;
  supplier_id: number | null;
  supplier_name?: string | null;
  supplier_code?: string | null;
  location_id: number | null;
  location_name?: string | null;
  location_code?: string | null;
  receipt_date: string;
  invoice_no: string | null;
  received_by: string | null;
  status: 'DRAFT' | 'POSTED' | 'COMPLETED' | 'CANCELLED';
  posted_at?: string | null;
  posted_by?: string | null;
  notes: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  items?: PosGoodsReceiptItem[];
  po_status?: string | null;
}

export interface RawMaterialCandidate {
  id: number;
  name: string;
  item_code: string | null;
  base_unit: string | null;
  canonical_base_unit_code: string | null;
  product_type?: string | null;
  track_stock?: boolean;
  track_inventory?: boolean;
  category_name?: string | null;
  average_cost?: string | number;
  last_cost?: string | number;
}

export class PosPoApiError extends Error {
  statusCode: number;
  code?: string;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.name = 'PosPoApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

async function handleResponse<T>(res: Response, defaultErrMsg: string): Promise<T> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON
  }

  if (!res.ok) {
    const errorMsg =
      body?.message ||
      body?.error ||
      body?.data?.message ||
      `${defaultErrMsg} (HTTP ${res.status})`;
    const errorCode = body?.code || body?.error_code;
    throw new PosPoApiError(errorMsg, res.status, errorCode);
  }

  return (body?.data !== undefined ? body.data : body) as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Supplier API
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchSuppliers(
  propertyId: number,
  params?: { search?: string; is_active?: boolean }
): Promise<PosSupplier[]> {
  const q = new URLSearchParams({ property_id: String(propertyId) });
  if (params?.search) q.set('search', params.search);
  if (params?.is_active !== undefined) q.set('is_active', String(params.is_active));

  const res = await authenticatedFetch(`/api/pos/suppliers?${q.toString()}`);
  return handleResponse<PosSupplier[]>(res, 'Gagal memuat daftar supplier');
}

export async function createSupplier(payload: {
  property_id: number;
  code: string;
  name: string;
  contact_person?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  is_active?: boolean;
}): Promise<PosSupplier> {
  const res = await authenticatedFetch('/api/pos/suppliers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<PosSupplier>(res, 'Gagal membuat supplier baru');
}

export async function updateSupplier(
  propertyId: number,
  supplierId: number,
  payload: {
    code?: string;
    name?: string;
    contact_person?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    is_active?: boolean;
  }
): Promise<PosSupplier> {
  const res = await authenticatedFetch(`/api/pos/suppliers/${supplierId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ property_id: propertyId, ...payload }),
  });
  return handleResponse<PosSupplier>(res, 'Gagal memperbarui supplier');
}

export async function deleteSupplier(propertyId: number, supplierId: number): Promise<{ deleted: boolean }> {
  const res = await authenticatedFetch(`/api/pos/suppliers/${supplierId}?property_id=${propertyId}`, {
    method: 'DELETE',
  });
  return handleResponse<{ deleted: boolean }>(res, 'Gagal menghapus supplier');
}

// ─────────────────────────────────────────────────────────────────────────────
// Purchase Order API
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchPurchaseOrders(
  propertyId: number,
  filter?: {
    status?: string;
    supplier_id?: number;
    start_date?: string;
    end_date?: string;
    search?: string;
    include_archived?: boolean;
    page?: number;
    limit?: number;
  }
): Promise<{ orders: PosPurchaseOrder[]; total: number; page: number; limit: number }> {
  const q = new URLSearchParams({ property_id: String(propertyId) });
  if (filter?.status && filter.status !== 'ALL') q.set('status', filter.status);
  if (filter?.supplier_id) q.set('supplier_id', String(filter.supplier_id));
  if (filter?.start_date) q.set('start_date', filter.start_date);
  if (filter?.end_date) q.set('end_date', filter.end_date);
  if (filter?.search) q.set('search', filter.search);
  if (filter?.include_archived) q.set('include_archived', 'true');
  if (filter?.page) q.set('page', String(filter.page));
  if (filter?.limit) q.set('limit', String(filter.limit));

  const res = await authenticatedFetch(`/api/pos/purchase-orders?${q.toString()}`);
  const raw = await handleResponse<any>(
    res,
    'Gagal memuat daftar Purchase Order'
  );
  if (Array.isArray(raw)) {
    return { orders: raw, total: raw.length, page: 1, limit: raw.length };
  }
  return {
    orders: Array.isArray(raw?.orders) ? raw.orders : [],
    total: Number(raw?.total ?? (Array.isArray(raw?.orders) ? raw.orders.length : 0)),
    page: Number(raw?.page ?? 1),
    limit: Number(raw?.limit ?? 50),
  };
}

export async function fetchPurchaseOrderById(
  propertyId: number,
  poId: number
): Promise<PosPurchaseOrder> {
  const res = await authenticatedFetch(`/api/pos/purchase-orders/${poId}?property_id=${propertyId}`);
  return handleResponse<PosPurchaseOrder>(res, 'Gagal memuat detail Purchase Order');
}

export const fetchPurchaseOrderDetail = fetchPurchaseOrderById;

export async function createPurchaseOrder(payload: {
  property_id: number;
  po_number?: string;
  supplier_id: number;
  order_date?: string;
  expected_date?: string | null;
  destination_location_id?: number | null;
  tax_amount?: number;
  notes?: string | null;
  submit_for_approval?: boolean;
  initial_status?: 'DRAFT' | 'PENDING_APPROVAL';
  created_by?: string | number | null;
  actor_name_snapshot?: string | null;
  items: Array<{
    id?: number | null;
    product_id: number;
    packaging_id?: number | null;
    ordered_unit?: string | null;
    ordered_qty: number | string;
    unit_cost: number | string;
    uom_id?: number | null;
    notes?: string | null;
  }>;
}): Promise<PosPurchaseOrder> {
  const res = await authenticatedFetch('/api/pos/purchase-orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<PosPurchaseOrder>(res, 'Gagal membuat Purchase Order');
}

export async function updatePurchaseOrder(
  propertyId: number,
  poId: number,
  payload: {
    supplier_id?: number;
    order_date?: string;
    expected_date?: string | null;
    destination_location_id?: number | null;
    tax_amount?: number;
    notes?: string | null;
    submit_for_approval?: boolean;
    updated_by?: string | number | null;
    actor_name_snapshot?: string | null;
    items: Array<{
      id?: number | null;
      product_id: number;
      packaging_id?: number | null;
      ordered_unit?: string | null;
      ordered_qty: number | string;
      unit_cost: number | string;
      uom_id?: number | null;
      notes?: string | null;
    }>;
  }
): Promise<PosPurchaseOrder> {
  const res = await authenticatedFetch(`/api/pos/purchase-orders/${poId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ property_id: propertyId, ...payload }),
  });
  return handleResponse<PosPurchaseOrder>(res, 'Gagal memperbarui Purchase Order');
}

export async function updatePurchaseOrderStatus(
  propertyId: number,
  poId: number,
  status:
    | 'DRAFT'
    | 'PENDING_APPROVAL'
    | 'SUBMIT'
    | 'APPROVE'
    | 'APPROVED'
    | 'ORDERED'
    | 'REJECT'
    | 'REJECTED'
    | 'CANCELLED'
    | 'ARCHIVE'
    | 'UNARCHIVE',
  updatedBy?: string,
  options?: { reason?: string | null; actor_name_snapshot?: string | null }
): Promise<PosPurchaseOrder> {
  const res = await authenticatedFetch(`/api/pos/purchase-orders/${poId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      property_id: propertyId,
      status,
      updated_by: updatedBy,
      reason: options?.reason ?? null,
      rejection_reason: options?.reason ?? null,
      archive_reason: options?.reason ?? null,
      actor_name_snapshot: options?.actor_name_snapshot ?? updatedBy ?? null,
    }),
  });
  return handleResponse<PosPurchaseOrder>(res, 'Gagal memperbarui status Purchase Order');
}

// ─────────────────────────────────────────────────────────────────────────────
// Goods Receipt API
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchGoodsReceipts(
  propertyId: number,
  filter?: {
    po_id?: number;
    transaction_id?: number;
    status?: 'ALL' | 'DRAFT' | 'POSTED';
    supplier_id?: number;
    location_id?: number;
    start_date?: string;
    end_date?: string;
    search?: string;
    page?: number;
    limit?: number;
  }
): Promise<{ receipts: PosGoodsReceipt[]; total: number; page: number; limit: number }> {
  const q = new URLSearchParams({ property_id: String(propertyId) });
  if (filter?.po_id) q.set('po_id', String(filter.po_id));
  if (filter?.transaction_id) q.set('transaction_id', String(filter.transaction_id));
  if (filter?.status && filter.status !== 'ALL') q.set('status', filter.status);
  if (filter?.supplier_id) q.set('supplier_id', String(filter.supplier_id));
  if (filter?.location_id) q.set('location_id', String(filter.location_id));
  if (filter?.start_date) q.set('start_date', filter.start_date);
  if (filter?.end_date) q.set('end_date', filter.end_date);
  if (filter?.search) q.set('search', filter.search);
  if (filter?.page) q.set('page', String(filter.page));
  if (filter?.limit) q.set('limit', String(filter.limit));

  const res = await authenticatedFetch(`/api/pos/goods-receipts?${q.toString()}`);
  return handleResponse<{ receipts: PosGoodsReceipt[]; total: number; page: number; limit: number }>(
    res,
    'Gagal memuat riwayat Goods Receipt'
  );
}

export async function fetchGoodsReceiptById(
  propertyId: number,
  grnId: number
): Promise<PosGoodsReceipt> {
  const res = await authenticatedFetch(`/api/pos/goods-receipts/${grnId}?property_id=${propertyId}`);
  return handleResponse<PosGoodsReceipt>(res, 'Gagal memuat detail Goods Receipt');
}

export async function createGoodsReceipt(payload: {
  property_id: number;
  grn_number?: string;
  po_id?: number | null;
  transaction_id?: number | null;
  supplier_id?: number | null;
  location_id: number;
  receipt_date?: string;
  invoice_no?: string | null;
  received_by?: string | null;
  notes?: string | null;
  idempotency_key?: string | null;
  operation_key?: string | null;
  is_draft?: boolean;
  status?: 'DRAFT' | 'POSTED';
  items: Array<{
    product_id: number;
    po_item_id?: number | null;
    transaction_line_id?: number | null;
    packaging_id?: number | null;
    received_qty: number | string;
    unit_cost: number | string;
    uom_id?: number | null;
    location_id?: number | null;
  }>;
}): Promise<PosGoodsReceipt> {
  const res = await authenticatedFetch('/api/pos/goods-receipts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<PosGoodsReceipt>(res, 'Gagal mencatat penerimaan barang');
}

export async function postGoodsReceiptApi(
  propertyId: number,
  grnId: number,
  postedBy?: string,
  operationKey?: string
): Promise<PosGoodsReceipt> {
  const res = await authenticatedFetch(`/api/pos/goods-receipts/${grnId}/post`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      property_id: propertyId,
      posted_by: postedBy,
      ...(operationKey ? { operation_key: operationKey, idempotency_key: operationKey } : {}),
    }),
  });
  return handleResponse<PosGoodsReceipt>(res, 'Gagal memposting penerimaan barang');
}

export async function updateGoodsReceiptDraftApi(
  propertyId: number,
  grnId: number,
  data: {
    supplier_id?: number | null;
    location_id?: number;
    receipt_date?: string;
    invoice_no?: string | null;
    received_by?: string | null;
    notes?: string | null;
    items?: Array<{
      id?: number | null;
      product_id: number;
      po_item_id?: number | null;
      transaction_line_id?: number | null;
      packaging_id?: number | null;
      received_qty: number | string;
      unit_cost: number | string;
      uom_id?: number | null;
      location_id?: number | null;
    }>;
  }
): Promise<PosGoodsReceipt> {
  const res = await authenticatedFetch(`/api/pos/goods-receipts/${grnId}/draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ property_id: propertyId, ...data }),
  });
  return handleResponse<PosGoodsReceipt>(res, 'Gagal memperbarui draft penerimaan');
}

export async function cancelGoodsReceiptDraftApi(
  propertyId: number,
  grnId: number,
  reason?: string
): Promise<PosGoodsReceipt> {
  const res = await authenticatedFetch(`/api/pos/goods-receipts/${grnId}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ property_id: propertyId, reason }),
  });
  return handleResponse<PosGoodsReceipt>(res, 'Gagal membatalkan draft penerimaan');
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw Materials & UOM Helpers
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchRawMaterialCandidates(propertyId: number): Promise<RawMaterialCandidate[]> {
  const res = await authenticatedFetch(`/api/pos/raw-materials?property_id=${propertyId}`);
  return handleResponse<RawMaterialCandidate[]>(res, 'Gagal memuat daftar bahan baku');
}

export async function fetchProductUoms(propertyId: number): Promise<Array<{ id: number; code: string; name: string; category?: string }>> {
  const res = await authenticatedFetch(`/api/pos/uoms?property_id=${propertyId}`);
  return handleResponse<Array<{ id: number; code: string; name: string; category?: string }>>(
    res,
    'Gagal memuat satuan UOM'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Purchase Transaction -> Goods Receipt Preview & Helpers (Tahap 1 F10)
// ─────────────────────────────────────────────────────────────────────────────

export interface PurchaseReceivableLinePreview {
  po_item_id?: number | null;
  transaction_line_id: number | null;
  product_id: number;
  product_name: string;
  item_code: string | null;
  description_snapshot: string;
  packaging_id: number | null;
  packaging_code: string | null;
  packaging_label: string | null;
  to_base_factor: number;
  ordered_qty: number;
  received_qty: number;
  remaining_qty: number;
  ordered_unit: string;
  base_unit: string;
  unit_cost: number;
  line_type: string;
  track_stock?: boolean;
  track_inventory?: boolean;
}

export interface PurchaseTransactionReceivablePreview {
  po_id?: number | null;
  po_number?: string | null;
  po_status?: string | null;
  transaction_id: number | null;
  transaction_no: string | null;
  transaction_date: string;
  approval_status: string;
  receiving_status: string;
  supplier_id: number | null;
  canonical_supplier_id?: number | null;
  supplier_name: string | null;
  source_reference: string | null;
  default_location: {
    id: number;
    code: string;
    name: string;
    location_type: string;
  } | null;
  active_draft_id?: number | null;
  active_draft?: any | null;
  lines: PurchaseReceivableLinePreview[];
  items?: PurchaseReceivableLinePreview[];
}

export interface PurchaseOrderReceivablePreview {
  po_id: number;
  po_number: string;
  order_date: string;
  po_date?: string;
  status?: string;
  po_status: string;
  approval_status: string;
  receiving_status: string;
  supplier_id: number | null;
  canonical_supplier_id: number | null;
  supplier_name: string | null;
  source_reference?: string | null;
  default_location: {
    id: number;
    code: string;
    name: string;
    location_type: string;
  } | null;
  active_draft_id?: number | null;
  active_draft?: any | null;
  lines: PurchaseReceivableLinePreview[];
  items?: PurchaseReceivableLinePreview[];
}

export interface ApprovedPurchaseOption {
  id: number;
  transaction_no: string;
  transaction_date: string;
  party_name: string | null;
  supplier_name?: string | null;
  description: string;
  net_amount: number;
  approval_status?: string | null;
  receiving_status?: string | null;
}

export interface ProductPackagingOption {
  id: number;
  property_id: number;
  menu_item_id: number;
  packaging_code: string;
  packaging_label: string;
  packaging_name?: string;
  base_unit_code: string;
  to_base_factor: number;
  is_default_purchase?: boolean;
  is_active: boolean;
}

export async function fetchPurchaseTransactionReceivablePreview(
  propertyId: number,
  transactionId: number
): Promise<PurchaseTransactionReceivablePreview> {
  const res = await authenticatedFetch(
    `/api/pos/goods-receipts/from-purchase/${transactionId}?property_id=${propertyId}`
  );
  return handleResponse<PurchaseTransactionReceivablePreview>(
    res,
    'Gagal memuat pratinjau penerimaan dari transaksi pembelian'
  );
}

export async function fetchPurchaseOrderReceivablePreview(
  propertyId: number,
  poId: number
): Promise<PurchaseOrderReceivablePreview> {
  const res = await authenticatedFetch(
    `/api/pos/goods-receipts/from-po/${poId}?property_id=${propertyId}`
  );
  return handleResponse<PurchaseOrderReceivablePreview>(
    res,
    'Gagal memuat pratinjau penerimaan dari Purchase Order'
  );
}

export async function fetchApprovedPurchaseOrdersForReceiving(
  propertyId: number
): Promise<PosPurchaseOrder[]> {
  const res = await fetchPurchaseOrders(propertyId, { limit: 200 });
  return (res.orders || []).filter((po) => {
    const appSt = String(po.approval_status || po.status || '').toUpperCase();
    const st = String(po.status || '').toUpperCase();
    const isApproved =
      appSt === 'APPROVED' ||
      ['APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED', 'COMPLETED'].includes(st);
    const notCancelled = !['CANCELLED', 'REJECTED', 'DRAFT', 'PENDING_APPROVAL'].includes(st);
    return isApproved && notCancelled;
  });
}

export async function fetchApprovedPurchasesForReceiving(
  propertyId: number
): Promise<ApprovedPurchaseOption[]> {
  const res = await authenticatedFetch(
    `/api/transactions?property_id=${propertyId}&transaction_type=PURCHASE&limit=100`
  );
  const json = await res.json().catch(() => null);
  const rows: any[] = json?.data?.transactions || json?.transactions || [];
  return rows.filter(
    (r) =>
      r.transaction_type === 'PURCHASE' &&
      r.transaction_status === 'POSTED' &&
      r.approval_status === 'APPROVED' &&
      r.receiving_status !== 'RECEIVED' &&
      r.receiving_status !== 'DITERIMA'
  );
}

export async function fetchProductPackagingsForGrn(
  propertyId: number,
  productId: number
): Promise<ProductPackagingOption[]> {
  const res = await authenticatedFetch(
    `/api/pos/menu/items/${productId}/packagings?property_id=${propertyId}`
  );
  const json = await res.json().catch(() => null);
  if (Array.isArray(json?.data?.packagings)) return json.data.packagings;
  if (Array.isArray(json?.packagings)) return json.packagings;
  return Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
}

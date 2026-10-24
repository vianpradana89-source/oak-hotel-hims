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
  product_name?: string;
  item_code?: string | null;
  base_unit?: string | null;
  canonical_base_unit_code?: string | null;
  ordered_qty: string;
  received_qty: string;
  unit_cost: string;
  uom_id: number | null;
  uom_code?: string | null;
  uom_name?: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PosPurchaseOrder {
  id: number;
  property_id: number;
  po_number: string;
  supplier_id: number;
  supplier_name?: string;
  supplier_code?: string;
  order_date: string;
  expected_date: string | null;
  status: 'DRAFT' | 'ORDERED' | 'PARTIALLY_RECEIVED' | 'COMPLETED' | 'CANCELLED';
  notes: string | null;
  total_estimated_amount: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  items?: PosPurchaseOrderItem[];
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
  supplier_id: number | null;
  supplier_name?: string | null;
  supplier_code?: string | null;
  location_id: number | null;
  location_name?: string | null;
  location_code?: string | null;
  receipt_date: string;
  invoice_no: string | null;
  received_by: string | null;
  status: 'COMPLETED' | 'CANCELLED';
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
  if (filter?.page) q.set('page', String(filter.page));
  if (filter?.limit) q.set('limit', String(filter.limit));

  const res = await authenticatedFetch(`/api/pos/purchase-orders?${q.toString()}`);
  return handleResponse<{ orders: PosPurchaseOrder[]; total: number; page: number; limit: number }>(
    res,
    'Gagal memuat daftar Purchase Order'
  );
}

export async function fetchPurchaseOrderById(
  propertyId: number,
  poId: number
): Promise<PosPurchaseOrder> {
  const res = await authenticatedFetch(`/api/pos/purchase-orders/${poId}?property_id=${propertyId}`);
  return handleResponse<PosPurchaseOrder>(res, 'Gagal memuat detail Purchase Order');
}

export async function createPurchaseOrder(payload: {
  property_id: number;
  po_number?: string;
  supplier_id: number;
  order_date?: string;
  expected_date?: string | null;
  notes?: string | null;
  created_by?: string | null;
  items: Array<{
    product_id: number;
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

export async function updatePurchaseOrderStatus(
  propertyId: number,
  poId: number,
  status: 'ORDERED' | 'CANCELLED',
  updatedBy?: string
): Promise<PosPurchaseOrder> {
  const res = await authenticatedFetch(`/api/pos/purchase-orders/${poId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ property_id: propertyId, status, updated_by: updatedBy }),
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
  supplier_id?: number | null;
  location_id: number;
  receipt_date?: string;
  invoice_no?: string | null;
  received_by?: string | null;
  notes?: string | null;
  idempotency_key?: string | null;
  items: Array<{
    product_id: number;
    po_item_id?: number | null;
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

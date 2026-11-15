/**
 * OAK HIMS — MP-04B POS Inventory API Client
 */

import { authenticatedFetch } from '../../lib/authenticatedFetch';
import type {
  StockLocation,
  InventoryValuationReport,
  StockLedgerCardData,
  StockAdjustmentPayload,
  StockOpnamePayload,
  StockTransferPayload,
  StockTrackedProductOption,
  StockOpeningBalancePayload,
  GlobalStockMovementsFilterParams,
  GlobalStockMovementsReport,
} from './posInventoryTypes';

export class InventoryApiError extends Error {
  code?: string;
  statusCode: number;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.name = 'InventoryApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

async function handleResponse<T>(res: Response, defaultErrMsg: string): Promise<T> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON response
  }

  if (!res.ok) {
    const errorMsg =
      body?.message ||
      body?.error ||
      body?.data?.message ||
      `${defaultErrMsg} (HTTP ${res.status})`;
    const errorCode = body?.code || body?.error_code;
    throw new InventoryApiError(errorMsg, res.status, errorCode);
  }

  return (body?.data !== undefined ? body.data : body) as T;
}

/**
 * Mengambil daftar lokasi stok aktif untuk properti.
 */
export async function fetchStockLocations(propertyId: number): Promise<StockLocation[]> {
  const res = await authenticatedFetch(`/api/pos/stock-locations?property_id=${propertyId}`);
  const data = await handleResponse<any>(res, 'Gagal memuat lokasi stok');
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.locations)) return data.locations;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

/**
 * Mengambil laporan rekap saldo dan valuasi persediaan POS.
 */
export async function fetchInventoryValuation(
  propertyId: number,
  params?: {
    location_id?: number | null;
    category_id?: number | null;
    product_id?: number | null;
    search?: string | null;
  }
): Promise<InventoryValuationReport> {
  const query = new URLSearchParams({ property_id: String(propertyId) });
  if (params?.location_id) query.set('location_id', String(params.location_id));
  if (params?.category_id) query.set('category_id', String(params.category_id));
  if (params?.product_id) query.set('product_id', String(params.product_id));
  if (params?.search && params.search.trim()) query.set('search', params.search.trim());

  const res = await authenticatedFetch(`/api/pos/stock/valuation-report?${query.toString()}`);
  return await handleResponse<InventoryValuationReport>(res, 'Gagal memuat valuasi persediaan');
}

/**
 * Mengambil kartu stok (stock ledger) untuk produk dan lokasi tertentu dalam rentang tanggal.
 */
export async function fetchStockLedger(
  propertyId: number,
  params: {
    product_id: number;
    location_id: number;
    start_date?: string;
    end_date?: string;
  }
): Promise<StockLedgerCardData> {
  const query = new URLSearchParams({
    property_id: String(propertyId),
    product_id: String(params.product_id),
    location_id: String(params.location_id),
  });
  if (params.start_date) query.set('start_date', params.start_date);
  if (params.end_date) query.set('end_date', params.end_date);

  const res = await authenticatedFetch(`/api/pos/stock/stock-ledger?${query.toString()}`);
  return await handleResponse<StockLedgerCardData>(res, 'Gagal memuat kartu stok');
}

/**
 * Mencatat penyesuaian stok (IN / OUT).
 */
export async function submitStockAdjustment(payload: StockAdjustmentPayload): Promise<any> {
  const normalizedPayload = {
    ...payload,
    quantity: String(payload.quantity).trim(),
  };
  const res = await authenticatedFetch('/api/pos/stock/adjustments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': payload.operation_key,
    },
    body: JSON.stringify(normalizedPayload),
  });
  return await handleResponse<any>(res, 'Gagal mencatat penyesuaian stok');
}

/**
 * Mencatat stock opname fisik.
 */
export async function submitStockOpname(payload: StockOpnamePayload): Promise<any> {
  const normalizedPayload = {
    ...payload,
    items: (payload.items || []).map((item) => ({
      ...item,
      physical_quantity: String(item.physical_quantity).trim(),
    })),
  };
  const res = await authenticatedFetch('/api/pos/stock/opname', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': payload.operation_key,
    },
    body: JSON.stringify(normalizedPayload),
  });
  return await handleResponse<any>(res, 'Gagal mencatat opname fisik');
}

/**
 * Mencatat transfer stok antar lokasi gudang / outlet.
 */
export async function submitStockTransfer(payload: StockTransferPayload): Promise<any> {
  const normalizedPayload = {
    ...payload,
    items: (payload.items || []).map((item) => ({
      ...item,
      quantity: String(item.quantity).trim(),
    })),
  };
  const res = await authenticatedFetch('/api/pos/stock/transfers', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': payload.operation_key,
    },
    body: JSON.stringify(normalizedPayload),
  });
  return await handleResponse<any>(res, 'Gagal mencatat transfer stok');
}

/**
 * Mengambil daftar produk aktif dengan track_stock = true dari master produk (pos_menu_items),
 * termasuk produk yang belum memiliki baris di stock_balances.
 */
export async function fetchStockTrackedProducts(propertyId: number): Promise<StockTrackedProductOption[]> {
  let rawRows: any[] = [];
  try {
    const res = await authenticatedFetch(
      `/api/pos/menu?property_id=${propertyId}&scope=master&status=active&include_internal=true&sellable=all`
    );
    if (res.ok) {
      const data = await handleResponse<any>(res, 'Gagal memuat daftar produk master');
      rawRows = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
    }
  } catch {
    // Fallback below
  }

  if (rawRows.length === 0) {
    try {
      const res = await authenticatedFetch(`/api/pos/raw-materials?property_id=${propertyId}`);
      if (res.ok) {
        const body = await res.json();
        const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
        rawRows = list;
      }
    } catch {
      // Ignore fallback error
    }
  }

  return rawRows
    .filter((row: any) => Boolean(row?.track_stock))
    .map((row: any) => ({
      id: Number(row.id),
      name: String(row.name || '').trim(),
      item_code: row.item_code ? String(row.item_code).trim() : null,
      base_unit_code: String(row.canonical_base_unit_code || row.base_unit || 'PCS')
        .trim()
        .toUpperCase(),
      track_stock: true,
      storage_sublocation: row.storage_sublocation ? String(row.storage_sublocation).trim() : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'id-ID'));
}

/**
 * Mencatat saldo awal persediaan (OPENING_BALANCE) tanpa PO / faktur pembelian.
 */
export async function submitStockOpeningBalance(payload: StockOpeningBalancePayload): Promise<any> {
  const res = await authenticatedFetch('/api/pos/stock/opening-balance', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': payload.operation_key,
    },
    body: JSON.stringify(payload),
  });
  return await handleResponse<any>(res, 'Gagal mencatat saldo awal persediaan');
}

/**
 * Mengambil Riwayat Mutasi Persediaan Global & Laporan Mutasi Barang (8 Kolom) — Tahap A.
 */
export async function fetchGlobalStockMovements(
  propertyId: number,
  params?: GlobalStockMovementsFilterParams
): Promise<GlobalStockMovementsReport> {
  const qs = new URLSearchParams({ property_id: String(propertyId) });
  if (params?.warehouse_id) qs.set('warehouse_id', String(params.warehouse_id));
  if (params?.location_id && !params?.warehouse_id) qs.set('location_id', String(params.location_id));
  if (params?.warehouse_code) qs.set('warehouse_code', String(params.warehouse_code));
  if (params?.storage_sublocation && params.storage_sublocation !== 'ALL') {
    qs.set('storage_sublocation', String(params.storage_sublocation).trim());
  }
  if (params?.product_id) qs.set('product_id', String(params.product_id));
  if (params?.start_date) qs.set('start_date', params.start_date);
  if (params?.end_date) qs.set('end_date', params.end_date);
  if (params?.operation_type && params.operation_type !== 'ALL') {
    qs.set('operation_type', String(params.operation_type));
  }
  if (params?.direction && params.direction !== 'ALL') {
    qs.set('direction', params.direction);
  }
  if (params?.search && params.search.trim()) {
    qs.set('search', params.search.trim());
  }
  if (params?.sort_order) {
    qs.set('sort_order', params.sort_order);
  }
  if (params?.export_all !== undefined && params?.export_all !== null) {
    qs.set('export_all', String(Boolean(params.export_all)));
  }
  if (params?.page) {
    qs.set('page', String(params.page));
  }
  if (params?.limit) {
    qs.set('limit', String(params.limit));
  }

  const res = await authenticatedFetch(`/api/pos/inventory/stock-movements-global?${qs.toString()}`);
  return await handleResponse<GlobalStockMovementsReport>(
    res,
    'Gagal memuat riwayat mutasi persediaan global'
  );
}

/**
 * Menghapus produk bersaldo 0 (quantity = 0) dari suatu lokasi penyimpanan
 * tanpa menghapus histori mutasi (Kartu Stok tetap tersimpan untuk audit).
 */
export async function removeZeroStockBalanceFromLocation(params: {
  property_id: number;
  product_id: number;
  location_id: number;
}): Promise<{ removed: boolean; property_id: number; product_id: number; location_id: number }> {
  const qs = new URLSearchParams({
    property_id: String(params.property_id),
    product_id: String(params.product_id),
    location_id: String(params.location_id),
  });
  const res = await authenticatedFetch(`/api/pos/stock/balances?${qs.toString()}`, {
    method: 'DELETE',
  });
  return await handleResponse<{ removed: boolean; property_id: number; product_id: number; location_id: number }>(
    res,
    'Gagal menghapus produk dari lokasi penyimpanan'
  );
}

/**
 * Mengatur atau mengubah Tempat Penyimpanan (storage_sublocation, mis. Showcase, Chiller, Rak)
 * untuk suatu produk pada lokasi gudang tertentu.
 */
export async function updateStockBalanceSublocation(params: {
  property_id: number;
  product_id: number;
  location_id: number;
  storage_sublocation: string | null;
}): Promise<{
  property_id: number;
  product_id: number;
  location_id: number;
  storage_sublocation: string | null;
}> {
  const res = await authenticatedFetch('/api/pos/stock/balances/sublocation', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  return await handleResponse<{
    property_id: number;
    product_id: number;
    location_id: number;
    storage_sublocation: string | null;
  }>(res, 'Gagal memperbarui tempat penyimpanan produk');
}




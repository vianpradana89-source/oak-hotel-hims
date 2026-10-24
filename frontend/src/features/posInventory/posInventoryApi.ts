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
  const res = await authenticatedFetch('/api/pos/stock/adjustments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': payload.operation_key,
    },
    body: JSON.stringify(payload),
  });
  return await handleResponse<any>(res, 'Gagal mencatat penyesuaian stok');
}

/**
 * Mencatat stock opname fisik.
 */
export async function submitStockOpname(payload: StockOpnamePayload): Promise<any> {
  const res = await authenticatedFetch('/api/pos/stock/opname', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': payload.operation_key,
    },
    body: JSON.stringify(payload),
  });
  return await handleResponse<any>(res, 'Gagal mencatat opname fisik');
}

/**
 * Mencatat transfer stok antar lokasi gudang / outlet.
 */
export async function submitStockTransfer(payload: StockTransferPayload): Promise<any> {
  const res = await authenticatedFetch('/api/pos/stock/transfers', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': payload.operation_key,
    },
    body: JSON.stringify(payload),
  });
  return await handleResponse<any>(res, 'Gagal mencatat transfer stok');
}

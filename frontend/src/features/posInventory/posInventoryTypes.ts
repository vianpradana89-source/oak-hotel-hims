/**
 * OAK HIMS — MP-04B POS Inventory Types
 * Tipe data persediaan POS: Saldo, Valuasi, Kartu Stok, Penyesuaian, Opname, Transfer
 */

export interface StockLocation {
  id: number;
  property_id: number;
  code: string;
  name: string;
  location_type: 'WAREHOUSE' | 'KITCHEN' | 'POS_OUTLET' | 'HK_PANTRY' | 'ROOM_MINIBAR' | string;
  is_active: boolean;
  notes?: string | null;
  room_id?: number | null;
}

export interface InventoryValuationItem {
  balance_id: number;
  property_id: number;
  product_id: number;
  product_name: string;
  product_item_code: string | null;
  category_id: number | null;
  category_name: string | null;
  location_id: number;
  location_code: string;
  location_name: string;
  location_type: string;
  base_unit_code: string;
  quantity: string;
  unit_cost: string | null;
  last_unit_cost?: string | null;
  prev_unit_cost?: string | null;
  cost_delta?: string | null;
  cost_delta_pct?: number | null;
  total_value: string | null;
  cost_known?: boolean;
  cost_status?: 'KNOWN' | 'UNKNOWN';
  updated_at: string;
}

export interface InventoryValuationSummary {
  total_items: number;
  total_quantity: string;
  total_valuation_value: string;
  unknown_cost_items?: number;
}

export interface InventoryValuationReport {
  property_id: number;
  filters: {
    location_id: number | null;
    product_id: number | null;
    category_id: number | null;
    search: string | null;
  };
  summary: InventoryValuationSummary;
  items: InventoryValuationItem[];
}

export type StockMovementType =
  | 'OPENING_BALANCE'
  | 'PURCHASE_RECEIPT'
  | 'STOCK_ADJUSTMENT'
  | 'STOCK_OPNAME'
  | 'STOCK_TRANSFER_IN'
  | 'STOCK_TRANSFER_OUT'
  | 'SALE'
  | 'ROOM_MINIBAR_POSTING'
  | 'ROOM_MINIBAR_RESTOCK'
  | 'ROOM_MINIBAR_WASTE'
  | string;

export interface StockMovement {
  id: number;
  movement_key: string;
  movement_type: StockMovementType;
  quantity_delta: string;
  running_balance: string;
  unit_cost: string | null;
  prev_unit_cost?: string | null;
  cost_delta?: string | null;
  cost_delta_pct?: number | null;
  total_cost: string | null;
  reference_type: string | null;
  reference_id: string | null;
  notes: string | null;
  created_by?: number | null;
  created_by_name?: string | null;
  created_at: string;
}

export interface StockTrackedProductOption {
  id: number;
  name: string;
  item_code: string | null;
  base_unit_code: string;
  track_stock: boolean;
}

export interface StockOpeningBalancePayload {
  property_id: number;
  product_id: number;
  location_id: number;
  quantity: string;
  unit_cost: string;
  operation_key: string;
  notes?: string;
}

export interface StockLedgerCardData {
  property_id: number;
  product_id: number;
  product_name: string;
  product_item_code: string | null;
  base_unit_code: string;
  location_id: number;
  location_code: string;
  location_name: string;
  start_date: string;
  end_date: string;
  opening_balance: string;
  total_in: string;
  total_out: string;
  closing_balance: string;
  cost_summary?: {
    min_unit_cost: string | null;
    max_unit_cost: string | null;
    last_unit_cost: string | null;
    average_cost: string | null;
  };
  movements: StockMovement[];
}

export type StockAdjustmentReasonCode =
  | 'RUSAK'
  | 'HILANG'
  | 'KADALUARSA'
  | 'PEMAKAIAN_INTERNAL'
  | 'KOREKSI_ADMIN'
  | 'SAMPLE';

export const STOCK_ADJUSTMENT_REASONS: Array<{ code: StockAdjustmentReasonCode; label: string }> = [
  { code: 'RUSAK', label: 'Barang Rusak / Pecah / Cacat' },
  { code: 'HILANG', label: 'Selisih / Barang Hilang' },
  { code: 'KADALUARSA', label: 'Kadaluarsa / Expired' },
  { code: 'PEMAKAIAN_INTERNAL', label: 'Pemakaian Internal / Operasional Hotel' },
  { code: 'KOREKSI_ADMIN', label: 'Koreksi Administrasi / Kesalahan Input' },
  { code: 'SAMPLE', label: 'Sample / Uji Coba' },
];

export interface StockAdjustmentPayload {
  property_id: number;
  product_id: number;
  location_id: number;
  adjustment_type: 'IN' | 'OUT';
  reason_code: StockAdjustmentReasonCode;
  quantity: number | string;
  packaging_id?: number | null;
  operation_key: string;
  notes?: string;
}

export interface StockOpnameItemInput {
  product_id: number;
  physical_quantity: number | string;
  notes?: string;
}

export interface StockOpnamePayload {
  property_id: number;
  location_id: number;
  items: StockOpnameItemInput[];
  operation_key: string;
  notes?: string;
}

export interface StockTransferItemInput {
  product_id: number;
  quantity: number | string;
  packaging_id?: number | null;
  notes?: string;
}

export interface StockTransferPayload {
  property_id: number;
  from_location_id: number;
  to_location_id: number;
  items: StockTransferItemInput[];
  operation_key: string;
  notes?: string;
}

// ── Tahap A: Riwayat Mutasi Global & Laporan Mutasi Barang (8 Kolom) ─────────

export type GlobalMovementOperationFilter =
  | 'ALL'
  | 'OPENING_BALANCE'
  | 'PURCHASE_RECEIPT'
  | 'STOCK_TRANSFER'
  | 'STOCK_TRANSFER_IN'
  | 'STOCK_TRANSFER_OUT'
  | 'STOCK_OPNAME'
  | 'STOCK_ADJUSTMENT'
  | 'POS_SALE'
  | 'SALE'
  | 'ROOM_MINIBAR_POSTING';

export interface GlobalStockMovementsFilterParams {
  warehouse_id?: number | null;
  location_id?: number | null;
  warehouse_code?: string | null;
  product_id?: number | null;
  start_date?: string | null;
  end_date?: string | null;
  operation_type?: GlobalMovementOperationFilter | string | null;
  direction?: 'ALL' | 'IN' | 'OUT' | null;
  search?: string | null;
  sort_order?: 'ASC' | 'DESC' | null;
  export_all?: boolean | null;
  page?: number | null;
  limit?: number | null;
}

export interface GlobalStockMovementItem {
  movement_id: number;
  operation_id: number;
  property_id: number;
  created_at: string;
  movement_date_wib: string;
  movement_time_wib: string;
  product_id: number;
  product_code: string;
  product_name: string;
  location_id: number;
  location_code: string;
  location_name: string;
  location_type: string;
  operation_type: string;
  operation_category: string;
  operation_label: string;
  direction: 'IN' | 'OUT';
  base_unit_code: string;
  packaging_id: number | null;
  packaging_code: string | null;
  packaging_label: string | null;
  balance_before: string;
  quantity_in: string;
  quantity_out: string;
  quantity_delta: string;
  balance_after: string;
  unit_cost: string | null;
  operation_key: string;
  reference_no: string | null;
  counterpart_location_id: number | null;
  counterpart_location_code: string | null;
  counterpart_location_name: string | null;
  notes: string | null;
  display_keterangan: string;
  created_by: number | null;
}

export interface GlobalStockMovementUnitTotal {
  base_unit_code: string;
  movement_count: number;
  distinct_product_count: number;
  distinct_partition_count: number;
  total_in: string;
  total_out: string;
  net_delta: string;
}

export interface GlobalStockMovementPartitionSummary {
  property_id: number;
  product_id: number;
  product_code: string;
  product_name: string;
  location_id: number;
  location_code: string;
  location_name: string;
  base_unit_code: string;
  movement_count: number;
  opening_balance: string;
  total_in: string;
  total_out: string;
  net_delta: string;
  closing_balance: string;
}

export interface GlobalStockMovementsReport {
  property_id: number;
  property_name: string;
  report_header_title: string;
  storage_sublocation_label: string;
  snapshot: {
    as_of_timestamp: string;
    as_of_wib: string;
    isolation_level: 'REPEATABLE_READ_READ_ONLY';
  };
  filters: {
    warehouse_id: number | null;
    warehouse_code: string | null;
    warehouse_name: string | null;
    product_id: number | null;
    start_date: string | null;
    end_date: string | null;
    start_bound_inclusive: string | null;
    end_bound_exclusive: string | null;
    timezone: 'Asia/Jakarta';
    bound_mode: 'HALF_OPEN_START_INCLUSIVE_END_EXCLUSIVE';
    operation_type: string;
    direction: 'ALL' | 'IN' | 'OUT';
    search: string | null;
    sort_order: 'ASC' | 'DESC';
    export_all: boolean;
  };
  scope_notice: string;
  pagination: {
    page: number;
    limit: number;
    total_rows: number;
    total_pages: number;
    is_export_all: boolean;
  };
  totals_by_unit: GlobalStockMovementUnitTotal[];
  partition_summaries: GlobalStockMovementPartitionSummary[];
  movements: GlobalStockMovementItem[];
}


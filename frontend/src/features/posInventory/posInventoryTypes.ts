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
  unit_cost: string;
  total_value: string;
  updated_at: string;
}

export interface InventoryValuationSummary {
  total_items: number;
  total_quantity: string;
  total_valuation_value: string;
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
  total_cost: string | null;
  reference_type: string | null;
  reference_id: string | null;
  notes: string | null;
  created_at: string;
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

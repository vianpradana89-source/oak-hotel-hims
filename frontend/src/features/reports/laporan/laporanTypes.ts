// Laporan workspace — API response shapes for /api/reports/analytics-hub
// and /api/reports/financials. These mirror the backend contracts.

export interface RoomRankingRow {
  room_id: number;
  room_number: string;
  room_type_name: string;
  room_type_code: string;
  room_status: string;
  booking_count: number;
  occupied_nights: number;
  room_revenue: number | string;
  complimentary_booking_count: number;
  complimentary_nights: number;
}

export interface ComplimentaryStayRow {
  reservation_id: number;
  booking_code: string;
  guest_name: string | null;
  room_number: string;
  room_type_name: string;
  check_in: string;
  check_out: string;
  nights: number;
  total_price: number | string;
  reference_rate: number | string;
  estimated_comp_value: number | string;
  payment_method: string;
  status: string;
  notes: string;
}

export interface PosItemSaleRow {
  order_item_id: number;
  order_id: number;
  booking_or_order_no: string;
  tx_date: string;
  customer_name: string;
  room_or_table: string;
  item_name: string;
  item_code: string;
  category_name: string;
  quantity: number | string;
  unit_price: number | string;
  discount_amount: number | string;
  line_total: number | string;
  total_hpp: number | string;
  unit_hpp: number | string;
  payment_method: string;
  payment_status: string;
  transaction_id: number | null;
  is_complimentary: boolean;
}

export interface PurchaseLineRow {
  transaction_id: number | string;
  transaction_no: string;
  transaction_date: string;
  supplier_name: string;
  reference_no: string;
  item_name: string;
  item_code: string;
  quantity: number | string;
  unit: string;
  unit_price: number | string;
  line_total: number | string;
  transaction_net_amount: number | string;
  payment_method: string;
  payment_status: string;
  workflow_status: string;
  receiving_status: string;
  attachment_count: number;
}

export interface AnalyticsHubData {
  property_id: number;
  start_date: string;
  end_date: string;
  room_ranking: RoomRankingRow[];
  complimentary_stays: ComplimentaryStayRow[];
  pos_item_sales: PosItemSaleRow[];
  purchase_lines: PurchaseLineRow[];
}

export interface IncomeByCategory {
  category_code: string;
  category_name: string;
  total: number;
  count: number;
}

export interface IncomeByPaymentMethod {
  method: string;
  total: number;
  count: number;
}

export interface ExpenseByCategory {
  category_code: string;
  category_name: string;
  total: number;
  count: number;
}

export interface ExpenseByDepartment {
  department_code: string;
  total: number;
  count: number;
}

export interface PurchaseByPaymentStatus {
  status: string;
  total: number;
  count: number;
}

export interface PurchaseByDepartment {
  department_code: string;
  total: number;
  count: number;
}

export interface PaymentMethodSummaryRow {
  method: string;
  booking_total: number;
  pos_total: number;
  income_total: number;
  purchase_total: number;
  expense_total: number;
  grand_total: number;
  grand_count: number;
}

export interface FinancialsData {
  property_id: number;
  start_date: string;
  end_date: string;
  income: {
    total: number;
    count: number;
    by_category: IncomeByCategory[];
    by_payment_method: IncomeByPaymentMethod[];
  };
  expense: {
    total: number;
    count: number;
    by_category: ExpenseByCategory[];
    by_department: ExpenseByDepartment[];
  };
  purchase: {
    total: number;
    count: number;
    by_payment_status: PurchaseByPaymentStatus[];
    by_department: PurchaseByDepartment[];
  };
  payment_method_summary: PaymentMethodSummaryRow[];
}

// Daily operations / KPIs types live in useDailyOperations.ts to avoid a
// circular import; re-exported here for convenience.
export type { DailyOperationsData, DailyKpiData } from './useDailyOperations';

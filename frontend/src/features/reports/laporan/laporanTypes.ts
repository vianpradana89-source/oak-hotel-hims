// Laporan workspace — API response shapes for /api/reports/analytics-hub
// and /api/reports/financials. These mirror the backend contracts.

export interface DailyOccupancyBarRow {
  date: string;
  gross_rooms: number;
  sellable_rooms: number;
  sold_rooms: number;
  complimentary_rooms: number;
  occupancy_pct: number | string;
}

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

export interface RoomSaleRow {
  reservation_id: number;
  booking_id?: number;
  room_id?: number;
  booking_code: string;
  tx_date: string;
  tx_datetime?: string;
  check_in: string;
  check_out: string;
  nights: number;
  period_nights?: number;
  total_stay_nights?: number;
  stay_type?: string;
  start_time?: string;
  end_time?: string;
  guest_name: string;
  room_number: string;
  room_type_name: string;
  room_rate?: number | string;
  total_price: number | string;
  full_total_price?: number | string;
  discount_amount?: number | string;
  full_discount_amount?: number | string;
  discount_percent?: number | string;
  discount_reason?: string;
  amount_paid: number | string;
  full_amount_paid?: number | string;
  remaining_balance: number | string;
  full_remaining_balance?: number | string;
  payment_status?: string;
  payment_method: string;
  booking_channel?: string;
  ota_source_name?: string;
  guest_segment?: string;
  tax_amount?: number | string;
  attachment_id?: number | null;
  payment_evidence_id?: number | null;
  reservation_status: string;
  is_complimentary: boolean;
  estimated_comp_value: number | string;
}

export interface CancelledBookingRow {
  reservation_id: number;
  booking_id?: number;
  booking_code: string;
  guest_name: string;
  room_number: string;
  room_type_name: string;
  check_in: string;
  check_out: string;
  nights: number;
  cancelled_date: string;
  lost_revenue: number | string;
  booking_channel: string;
  cancel_reason: string;
}

export interface PricingSettingsData {
  tax_percent: number | string;
  service_charge_percent: number | string;
  prices_include_tax: boolean;
  prices_include_service: boolean;
}

export interface DiscountSummaryData {
  room_discount_total: number;
  room_discount_count: number;
  pos_discount_total: number;
  pos_discount_count: number;
  total_discount_amount: number;
  total_discount_count: number;
}

export interface ProfitLossStatementData {
  revenue: {
    room_sales: number;
    product_sales: number;
    other_income: number;
    shipping_revenue: number;
    tax_exclude: number;
    tax_include: number;
    service_charge: number;
    rounding: number;
    returns_and_discounts: number;
    total_revenue: number;
  };
  cogs: {
    sales_cogs: number;
    returns_cogs: number;
    total_cogs: number;
  };
  gross_profit: number;
  expenses: {
    by_category: ExpenseByCategory[];
    total_expenses: number;
  };
  stock_adjustments: {
    stock_out_cost: number;
    stock_opname_cost: number;
    total_stock_cost: number;
  };
  purchases_summary: {
    purchase_total: number;
    purchase_discount: number;
    purchase_shipping: number;
    purchase_tax: number;
    total_purchases: number;
  };
  net_profit: number;
}

export interface CashFlowStatementData {
  opening_cash_balance: number;
  operating_activities: {
    customer_receipts: number;
    supplier_payments: number;
    operating_expenses: number;
    maintenance_expenses: number;
    other_income_receipts: number;
    other_expenses: number;
    stock_opname_adjustment: number;
    stock_out_adjustment: number;
    subtotal_operating: number;
  };
  investing_activities: {
    fixed_assets: number;
    intangible_assets: number;
    other_investing: number;
    subtotal_investing: number;
  };
  total_income_after_investing: number;
  financing_activities: {
    loans: number;
    equity_changes: number;
    subtotal_financing: number;
  };
  net_cash_change: number;
  closing_cash_balance: number;
}

export interface BalanceSheetStatementData {
  assets: {
    current_assets: {
      cash_on_hand: number;
      bank_account: number;
      transfer_bank: number;
      qris_balance: number;
      card_edc: number;
      short_term_investment: number;
      accounts_receivable: number;
      inventory_value: number;
      subtotal_current_assets: number;
    };
    non_current_assets: {
      fixed_assets: number;
      subtotal_non_current_assets: number;
    };
    total_assets: number;
  };
  liabilities_and_equity: {
    liabilities: {
      accounts_payable: number;
      guest_deposits: number;
      subtotal_liabilities: number;
    };
    equity: {
      retained_earnings: number;
      current_period_income: number;
      subtotal_equity: number;
    };
    total_liabilities_and_equity: number;
  };
}

export interface AccountingStatementsData {
  profit_loss: ProfitLossStatementData;
  cash_flow: CashFlowStatementData;
  balance_sheet: BalanceSheetStatementData;
}

export interface PosItemSaleRow {
  order_item_id: number;
  order_id: number;
  booking_or_order_no: string;
  tx_date: string;
  tx_datetime?: string;
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
  tax_amount?: number | string;
  guest_segment?: string;
  attachment_id?: number | null;
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

export interface PiutangSheetItem {
  bid: string;
  guest_name: string;
  room_count: number;
  room_summary: string;
  check_in: string | null;
  check_out: string | null;
  tx_date: string;
  net: number;
  paid: number;
  remaining: number;
}

export interface PiutangSheetSummaryData {
  period_total: number;
  period_count: number;
  all_time_total: number;
  all_time_count: number;
  items: PiutangSheetItem[];
  all_time_items?: PiutangSheetItem[];
}

export interface AnalyticsHubData {
  property_id: number;
  start_date: string;
  end_date: string;
  daily_occupancy?: DailyOccupancyBarRow[];
  room_ranking: RoomRankingRow[];
  complimentary_stays: ComplimentaryStayRow[];
  room_sales?: RoomSaleRow[];
  cancelled_bookings?: CancelledBookingRow[];
  pricing_settings?: PricingSettingsData;
  pos_item_sales: PosItemSaleRow[];
  purchase_lines: PurchaseLineRow[];
  discount_summary?: DiscountSummaryData;
  piutang_sheet_summary?: PiutangSheetSummaryData;
  accounting_statements?: AccountingStatementsData;
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
  booking_count?: number;
  pos_total: number;
  pos_count?: number;
  income_total: number;
  income_count?: number;
  purchase_total: number;
  purchase_count?: number;
  expense_total: number;
  expense_count?: number;
  grand_total: number;
  grand_count: number;
}

export interface TransactionReportItemRow {
  id: number | string;
  transaction_no: string;
  transaction_date: string;
  party_name: string;
  description: string;
  category_code: string;
  category_name: string;
  department_code: string;
  net_amount: number;
  payment_method: string;
  payment_status: string;
  transaction_status: string;
  operational_status: string;
  created_by: string;
  nota_attachment_id: number | null;
  bayar_attachment_id: number | null;
}

export interface FinancialsData {
  property_id: number;
  start_date: string;
  end_date: string;
  sales_breakdown?: {
    total: number;
    count: number;
    room_total: number;
    room_count: number;
    pos_total: number;
    pos_count: number;
    paid_total: number;
    unpaid_total: number;
  };
  other_income?: {
    total: number;
    count: number;
    by_category: IncomeByCategory[];
    by_payment_method: IncomeByPaymentMethod[];
    items: TransactionReportItemRow[];
  };
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
    items?: TransactionReportItemRow[];
  };
  purchase: {
    total: number;
    count: number;
    unpaid_total?: number;
    unpaid_count?: number;
    by_payment_status: PurchaseByPaymentStatus[];
    by_department: PurchaseByDepartment[];
  };
  payment_method_summary: PaymentMethodSummaryRow[];
}

// Daily operations / KPIs types live in useDailyOperations.ts to avoid a
// circular import; re-exported here for convenience.
export type { DailyOperationsData, DailyKpiData } from './useDailyOperations';

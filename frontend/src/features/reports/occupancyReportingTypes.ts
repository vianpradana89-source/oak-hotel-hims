export interface OccupancyTotals {
  gross_room_nights: number;
  ooo_room_nights: number;
  oos_room_nights: number;
  blocked_room_nights: number;
  sellable_room_nights: number;
  sold_room_nights: number;
  available_room_nights: number;
  occupancy_pct: number;
  is_zero_sellable?: boolean;
}

export interface DailyOccupancyItem {
  date: string;
  gross_room_nights: number;
  ooo_room_nights: number;
  oos_room_nights: number;
  blocked_room_nights: number;
  sellable_room_nights: number;
  sold_room_nights: number;
  available_room_nights: number;
  occupancy_pct: number;
  is_zero_sellable?: boolean;
}

export interface RoomTypeOccupancyItem {
  room_type_id: number;
  room_type_code: string;
  room_type_name: string;
  is_active_current: boolean;
  gross_room_nights: number;
  ooo_room_nights: number;
  oos_room_nights: number;
  blocked_room_nights: number;
  sellable_room_nights: number;
  sold_room_nights: number;
  available_room_nights: number;
  occupancy_pct: number;
  is_zero_sellable?: boolean;
  daily?: DailyOccupancyItem[];
}

export interface OccupancyReportData {
  property_id: number;
  start_date: string;
  end_date: string;
  nights: number;
  totals: OccupancyTotals;
  financials: OccupancyFinancials;
  daily: DailyOccupancyItem[];
  room_types?: RoomTypeOccupancyItem[];
}

export interface OccupancyFinancials {
  room_revenue: number;
  paid_room_nights: number;
  complimentary_room_nights: number;
  adr: number;
  revpar: number;
  alos: number;
  room_revenue_by_type: Record<string, number>;
}

export type OccupancyPeriodPreset = 'today' | 'yesterday' | '7days' | 'this_month' | 'last_month' | 'custom';

export interface OccupancyErrorPayload {
  code: string;
  message: string;
  details?: {
    first_covered_date?: string;
    last_covered_date?: string;
    coverage_end_exclusive?: string;
    available_ledger_start?: string;
    available_ledger_end?: string;
    missing_dates?: string[];
    missing_count?: number;
    [key: string]: any;
  };
}

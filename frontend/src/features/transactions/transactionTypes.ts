export type TransactionPeriodPreset =
  | 'today'
  | 'yesterday'
  | '7days'
  | 'this_month'
  | 'last_month'
  | 'custom';

export type TransactionStatusFilter =
  | 'all'
  | 'booked'
  | 'checked_in'
  | 'checked_out'
  | 'cancelled';

export interface TransactionPeriodRange {
  preset: TransactionPeriodPreset;
  startDate: string;
  endDateExclusive: string;
  displayLabel: string;
  isSingleDay: boolean;
}

export interface TransactionPeriodCounters {
  all: number;
  booked: number;
  checkedIn: number;
  checkedOut: number;
  cancelled: number;
}

export interface TransactionPaginationState {
  currentPage: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  startItemIndex: number;
  endItemIndex: number;
}

export interface TransactionActionItem {
  key: string;
  label: string;
  icon?: string;
  isDestructive?: boolean;
  onClick: () => void;
}

export interface TransactionActionMatrix {
  primaryAction: TransactionActionItem | null;
  overflowActions: TransactionActionItem[];
}

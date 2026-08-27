import {
  addHotelDays,
  formatCompactHotelDate,
  hotelDateFromInstant,
  hotelNightsBetween,
  normalizeHotelDate,
} from '../calendar/calendarDates.ts';
import type {
  TransactionActionMatrix,
  TransactionPaginationState,
  TransactionPeriodCounters,
  TransactionPeriodPreset,
  TransactionPeriodRange,
  TransactionStatusFilter,
} from './transactionTypes.ts';

/**
 * Returns the first date of the month (YYYY-MM-01) for a given hotel date.
 */
export function getFirstDateOfMonth(hotelDate: string): string {
  const normalized = normalizeHotelDate(hotelDate);
  if (!normalized) return '';
  const [year, month] = normalized.split('-');
  return `${year}-${month}-01`;
}

/**
 * Returns the exclusive end date for the month containing the given hotel date (first date of next month).
 * e.g., 2026-08-27 -> 2026-09-01
 * e.g., 2026-12-15 -> 2027-01-01
 */
export function getFirstDateOfNextMonth(hotelDate: string): string {
  const normalized = normalizeHotelDate(hotelDate);
  if (!normalized) return '';
  const [yearStr, monthStr] = normalized.split('-');
  let year = parseInt(yearStr, 10);
  let month = parseInt(monthStr, 10);

  if (month === 12) {
    year += 1;
    month = 1;
  } else {
    month += 1;
  }

  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/**
 * Returns the first date of the previous month (YYYY-MM-01).
 * Handles January -> previous December year rollover.
 * e.g., 2026-08-27 -> 2026-07-01
 * e.g., 2026-01-15 -> 2025-12-01
 */
export function getFirstDateOfPreviousMonth(hotelDate: string): string {
  const normalized = normalizeHotelDate(hotelDate);
  if (!normalized) return '';
  const [yearStr, monthStr] = normalized.split('-');
  let year = parseInt(yearStr, 10);
  let month = parseInt(monthStr, 10);

  if (month === 1) {
    year -= 1;
    month = 12;
  } else {
    month -= 1;
  }

  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/**
 * Formats YYYY-MM-DD into Indonesian readable format e.g. "27/08/2026"
 */
export function formatDateIndonesian(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const norm = normalizeHotelDate(dateStr);
  if (!norm) return dateStr;
  const [y, m, d] = norm.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Constructs the exact half-open [startDate, endDateExclusive) interval for each preset.
 */
export function getTransactionPeriodRange(
  preset: TransactionPeriodPreset,
  todayHotelDate: string,
  customStart?: string,
  customEnd?: string
): TransactionPeriodRange | null {
  const today = normalizeHotelDate(todayHotelDate) || hotelDateFromInstant(new Date());

  if (preset === 'today') {
    const nextDay = addHotelDays(today, 1);
    return {
      preset: 'today',
      startDate: today,
      endDateExclusive: nextDay,
      displayLabel: `Hari Ini (${formatDateIndonesian(today)})`,
      isSingleDay: true,
    };
  }

  if (preset === 'yesterday') {
    const yesterday = addHotelDays(today, -1);
    return {
      preset: 'yesterday',
      startDate: yesterday,
      endDateExclusive: today,
      displayLabel: `Kemarin (${formatDateIndonesian(yesterday)})`,
      isSingleDay: true,
    };
  }

  if (preset === '7days') {
    // 7 hotel nights up to today: (today - 6 days) to (today + 1 day exclusive)
    const start = addHotelDays(today, -6);
    const endExclusive = addHotelDays(today, 1);
    return {
      preset: '7days',
      startDate: start,
      endDateExclusive: endExclusive,
      displayLabel: `7 Hari Terakhir (${formatDateIndonesian(start)} – ${formatDateIndonesian(today)})`,
      isSingleDay: false,
    };
  }

  if (preset === 'this_month') {
    const start = getFirstDateOfMonth(today);
    const endExclusive = getFirstDateOfNextMonth(today);
    const lastDayInclusive = addHotelDays(endExclusive, -1);
    return {
      preset: 'this_month',
      startDate: start,
      endDateExclusive: endExclusive,
      displayLabel: `Bulan Ini (${formatDateIndonesian(start)} – ${formatDateIndonesian(lastDayInclusive)})`,
      isSingleDay: false,
    };
  }

  if (preset === 'last_month') {
    const start = getFirstDateOfPreviousMonth(today);
    const endExclusive = getFirstDateOfMonth(today);
    const lastDayInclusive = addHotelDays(endExclusive, -1);
    return {
      preset: 'last_month',
      startDate: start,
      endDateExclusive: endExclusive,
      displayLabel: `Bulan Lalu (${formatDateIndonesian(start)} – ${formatDateIndonesian(lastDayInclusive)})`,
      isSingleDay: false,
    };
  }

  if (preset === 'custom') {
    const normStart = normalizeHotelDate(customStart);
    const normEnd = normalizeHotelDate(customEnd);
    if (!normStart || !normEnd) return null;
    if (normStart > normEnd) return null;

    // Convert human inclusive end date to authoritative backend exclusive end date
    const endExclusive = addHotelDays(normEnd, 1);
    const isSingle = normStart === normEnd;

    return {
      preset: 'custom',
      startDate: normStart,
      endDateExclusive: endExclusive,
      displayLabel: isSingle
        ? `Kustom (${formatDateIndonesian(normStart)})`
        : `Kustom (${formatDateIndonesian(normStart)} – ${formatDateIndonesian(normEnd)})`,
      isSingleDay: isSingle,
    };
  }

  return null;
}

/**
 * Normalizes raw reservation status to one of standard canonical statuses.
 */
export function normalizeStatus(statusRaw: unknown): 'BOOKED' | 'CHECKED_IN' | 'CHECKED_OUT' | 'CANCELLED' {
  const s = String(statusRaw || '').trim().toUpperCase();
  if (s === 'CHECKED_IN' || s === 'CHECKIN' || s === 'CI') return 'CHECKED_IN';
  if (s === 'CHECKED_OUT' || s === 'CHECKOUT' || s === 'CO') return 'CHECKED_OUT';
  if (s === 'CANCELLED' || s === 'CANCELED') return 'CANCELLED';
  return 'BOOKED';
}

/**
 * Calculates summary counters for the given list of reservations in the selected period.
 */
export function calculatePeriodCounters(reservations: any[]): TransactionPeriodCounters {
  let booked = 0;
  let checkedIn = 0;
  let checkedOut = 0;
  let cancelled = 0;

  for (const res of reservations) {
    const st = normalizeStatus(res?.status);
    if (st === 'BOOKED') booked++;
    else if (st === 'CHECKED_IN') checkedIn++;
    else if (st === 'CHECKED_OUT') checkedOut++;
    else if (st === 'CANCELLED') cancelled++;
  }

  return {
    all: reservations.length,
    booked,
    checkedIn,
    checkedOut,
    cancelled,
  };
}

/**
 * Filters reservations by status filter.
 */
export function filterTransactionsByStatus(
  reservations: any[],
  filter: TransactionStatusFilter
): any[] {
  if (filter === 'all') return reservations;

  return reservations.filter((res) => {
    const st = normalizeStatus(res?.status);
    if (filter === 'booked') return st === 'BOOKED';
    if (filter === 'checked_in') return st === 'CHECKED_IN';
    if (filter === 'checked_out') return st === 'CHECKED_OUT';
    if (filter === 'cancelled') return st === 'CANCELLED';
    return true;
  });
}

/**
 * Filters reservations by search term.
 */
export function filterTransactionsBySearch(reservations: any[], query: string): any[] {
  const q = query.trim().toLowerCase();
  if (!q) return reservations;

  return reservations.filter((res) => {
    const haystack = [
      res?.guest_name,
      res?.guest_phone,
      res?.room_number,
      res?.room_id,
      res?.bid,
      res?.room_type,
      res?.guest_segment,
      String(res?.id || ''),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return haystack.includes(q);
  });
}

/**
 * Paginates a list of reservations with 1-based page index.
 */
export function paginateTransactions(
  items: any[],
  currentPage: number,
  pageSize: number
): {
  items: any[];
  pagination: TransactionPaginationState;
} {
  const validPageSize = [25, 50, 100].includes(pageSize) ? pageSize : 25;
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / validPageSize));
  const safePage = Math.max(1, Math.min(currentPage, totalPages));

  const startIdx = (safePage - 1) * validPageSize;
  const endIdx = Math.min(startIdx + validPageSize, totalItems);
  const pagedItems = items.slice(startIdx, endIdx);

  return {
    items: pagedItems,
    pagination: {
      currentPage: safePage,
      pageSize: validPageSize,
      totalItems,
      totalPages,
      startItemIndex: totalItems === 0 ? 0 : startIdx + 1,
      endItemIndex: endIdx,
    },
  };
}

export interface ActionHandlers {
  onCheckIn: (res: any) => void;
  onCheckout: (res: any) => void;
  onOpenDetail: (res: any) => void;
  onEdit: (res: any) => void;
  onMove: (res: any) => void;
  onExtend: (res: any) => void;
  onShorten?: (res: any) => void;
  onCancel: (res: any) => void;
  onViewFolio: (res: any) => void;
  onViewAudit: (res: any) => void;
}

/**
 * Determines primary and overflow actions based on reservation status.
 */
export function getTransactionActionMatrix(
  reservation: any,
  handlers: ActionHandlers
): TransactionActionMatrix {
  const status = normalizeStatus(reservation?.status);

  if (status === 'BOOKED') {
    return {
      primaryAction: {
        key: 'checkin',
        label: 'Check In',
        icon: '✓',
        onClick: () => handlers.onCheckIn(reservation),
      },
      overflowActions: [
        {
          key: 'detail',
          label: 'Buka Detail',
          onClick: () => handlers.onOpenDetail(reservation),
        },
        {
          key: 'edit',
          label: 'Edit Reservasi',
          onClick: () => handlers.onEdit(reservation),
        },
        {
          key: 'move',
          label: 'Pindah Kamar',
          onClick: () => handlers.onMove(reservation),
        },
        {
          key: 'extend',
          label: 'Extend Stay',
          onClick: () => handlers.onExtend(reservation),
        },
        {
          key: 'cancel',
          label: 'Batalkan Reservasi',
          isDestructive: true,
          onClick: () => handlers.onCancel(reservation),
        },
      ],
    };
  }

  if (status === 'CHECKED_IN') {
    return {
      primaryAction: {
        key: 'checkout',
        label: 'Checkout',
        icon: '📤',
        onClick: () => handlers.onCheckout(reservation),
      },
      overflowActions: [
        {
          key: 'detail',
          label: 'Buka Detail',
          onClick: () => handlers.onOpenDetail(reservation),
        },
        {
          key: 'folio',
          label: 'Lihat Folio',
          onClick: () => handlers.onViewFolio(reservation),
        },
        {
          key: 'move',
          label: 'Pindah Kamar',
          onClick: () => handlers.onMove(reservation),
        },
        {
          key: 'extend',
          label: 'Extend Stay',
          onClick: () => handlers.onExtend(reservation),
        },
      ],
    };
  }

  if (status === 'CHECKED_OUT') {
    return {
      primaryAction: {
        key: 'detail',
        label: 'Detail',
        onClick: () => handlers.onOpenDetail(reservation),
      },
      overflowActions: [
        {
          key: 'folio',
          label: 'Lihat Folio',
          onClick: () => handlers.onViewFolio(reservation),
        },
        {
          key: 'audit',
          label: 'Lihat Riwayat',
          onClick: () => handlers.onViewAudit(reservation),
        },
      ],
    };
  }

  // CANCELLED
  return {
    primaryAction: {
      key: 'detail',
      label: 'Detail',
      onClick: () => handlers.onOpenDetail(reservation),
    },
    overflowActions: [
      {
        key: 'audit',
        label: 'Lihat Riwayat',
        onClick: () => handlers.onViewAudit(reservation),
      },
    ],
  };
}

/**
 * Formats stay period display e.g. "27 Agu – 28 Agu (1 mlm)"
 */
export function formatStayPeriodDisplay(checkIn: string, checkOut: string): string {
  const normIn = normalizeHotelDate(checkIn);
  const normOut = normalizeHotelDate(checkOut);
  if (!normIn || !normOut) return '—';

  const inLabel = formatCompactHotelDate(normIn);
  const outLabel = formatCompactHotelDate(normOut);
  const nights = hotelNightsBetween(normIn, normOut) ?? 0;

  return `${inLabel} – ${outLabel} (${nights} mlm)`;
}

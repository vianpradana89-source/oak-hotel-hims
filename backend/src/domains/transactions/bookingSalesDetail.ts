import {
  derivePaymentStatus,
  roundIdr,
  saleNet,
  type PenjualanPaymentStatus,
} from './bookingBidGrouping';
import {
  mapSaleSourceCategory,
  type BookingSaleSourceCategory,
} from './saleSourceIdentity';
import {
  deriveReservationLinkedSaleSheet,
  groupSaleLifecycles,
} from './saleLifecycleGrouping';
import type { OperationalSheet } from './transactionTypes';

export type BookingSalesDetailScope = 'LIFETIME_BOOKING';

export interface BookingSalesHeader {
  booking_id: number;
  bid: string;
  property_id: number;
  guest_name: string;
  booker_name: string | null;
  booking_source: string | null;
  booking_channel: string | null;
  booking_status: string | null;
  check_in: string | null;
  check_out: string | null;
  room_count: number;
}

export interface BookingSalesFinancial {
  scope: BookingSalesDetailScope;
  gross: number;
  discount: number;
  net: number;
  paid: number;
  remaining: number;
  payment_status: PenjualanPaymentStatus;
}

export interface BookingSalesSourceBreakdownRow {
  category: BookingSaleSourceCategory;
  source_type: string;
  gross: number;
  discount: number;
  net: number;
  transaction_count: number;
}

export interface BookingSalesChildRow {
  reservation_id: number;
  room_id: number | null;
  room_number: string;
  room_type_name: string;
  stay_sequence: number | null;
  stay_type: string | null;
  check_in: string | null;
  check_out: string | null;
  reservation_status: string | null;
  operational_sheet: OperationalSheet;
  payment_status: PenjualanPaymentStatus;
  gross: number;
  discount: number;
  net: number;
  paid: number;
  remaining: number;
}

export interface BookingSalesPaymentRow {
  payment_id: number;
  reservation_id: number | null;
  transaction_id: number | string | null;
  method: string | null;
  amount: number;
  status: string;
  paid_at: string | null;
  reference: string | null;
  evidence_reference: string | null;
}

export interface BookingSalesDetail {
  context_label: 'Seluruh Booking';
  scope: BookingSalesDetailScope;
  booking: BookingSalesHeader;
  financial: BookingSalesFinancial;
  source_breakdown: BookingSalesSourceBreakdownRow[];
  children: BookingSalesChildRow[];
  payments: BookingSalesPaymentRow[];
}

export interface BookingSalesDetailBookingInput {
  id: number | string;
  bid: string;
  property_id: number;
  guest_name_snapshot?: string | null;
  booker_name?: string | null;
  booking_source?: string | null;
  channel?: string | null;
  booking_channel?: string | null;
  booking_status?: string | null;
}

export interface BookingSalesDetailReservationInput {
  id: number | string;
  room_id?: number | string | null;
  room_number?: string | null;
  room_type_name?: string | null;
  booked_room_type_name_snapshot?: string | null;
  stay_sequence?: number | string | null;
  stay_type?: string | null;
  check_in?: string | null;
  check_out?: string | null;
  status?: string | null;
  stay_status?: string | null;
  amount_paid?: unknown;
  remaining_balance?: unknown;
}

export interface BookingSalesDetailSaleInput {
  id: number | string;
  property_id?: unknown;
  transaction_type?: string | null;
  source_type?: string | null;
  source_id?: string | null;
  amount?: unknown;
  discount_amount?: unknown;
  net_amount?: unknown;
  effective_net_amount?: unknown;
  payment_status?: string | null;
  paid_amount?: unknown;
  reservation_id?: number | string | null;
  booking_id?: number | string | null;
  transaction_status?: string | null;
  reversal_of_transaction_id?: number | string | null;
  correction_group_id?: string | null;
  deleted_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface BookingSalesDetailPaymentInput {
  id: number | string;
  reservation_id?: number | string | null;
  transaction_id?: number | string | null;
  payment_method?: string | null;
  amount?: unknown;
  status?: string | null;
  created_at?: string | null;
  reference_code?: string | null;
  evidence_filename?: string | null;
  evidence_storage_key?: string | null;
}

function hotelDate(value: unknown): string | null {
  if (value == null || value === '') return null;
  const raw = String(value);
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso ? iso[1] : raw.slice(0, 10);
}

function asPositiveInt(value: unknown): number | null {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function canonicalRoomTypeName(row: BookingSalesDetailReservationInput): string {
  return String(row.room_type_name || row.booked_room_type_name_snapshot || '').trim();
}

function childOperationalSheet(row: BookingSalesDetailReservationInput): OperationalSheet {
  const sheet = deriveReservationLinkedSaleSheet({
    transaction_type: 'SALE',
    source_type: 'ROOM_CHARGE',
    reservation_id: row.id,
    reservation_status: row.status || null,
    reservation_stay_status: row.stay_status || null,
  });
  return sheet || 'PROSES';
}

function effectiveSaleAmounts(members: BookingSalesDetailSaleInput[]): { gross: number; discount: number; net: number } {
  const live = members.filter((member) => !member.deleted_at);
  const pool = live.length > 0 ? live : members;
  return {
    gross: pool.reduce((sum, row) => sum + roundIdr(row.amount), 0),
    discount: pool.reduce((sum, row) => sum + roundIdr(row.discount_amount), 0),
    net: pool.reduce((sum, row) => sum + saleNet(row), 0),
  };
}

function unattachedPaid(row: BookingSalesDetailSaleInput, net: number): number {
  if (row.paid_amount !== undefined && row.paid_amount !== null && String(row.paid_amount) !== '') {
    return roundIdr(row.paid_amount);
  }
  if (String(row.payment_status || '').toUpperCase() === 'PAID') return net;
  return 0;
}

const SOURCE_CATEGORY_ORDER: BookingSaleSourceCategory[] = [
  'ROOM',
  'STAY_EXTRA',
  'LAUNDRY',
  'POS',
  'PENALTY',
  'OTHER_OUTLET',
  'OTHER',
];

export function assembleBookingSalesDetail(input: {
  booking: BookingSalesDetailBookingInput;
  reservations: BookingSalesDetailReservationInput[];
  sales: BookingSalesDetailSaleInput[];
  payments: BookingSalesDetailPaymentInput[];
}): BookingSalesDetail {
  const bookingId = asPositiveInt(input.booking.id);
  if (!bookingId) {
    const err: any = new Error('booking_id tidak valid');
    err.statusCode = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  const saleRows = (input.sales || []).filter(
    (row) => String(row.transaction_type || 'SALE').toUpperCase() === 'SALE'
  );
  const lifecycleGroups = groupSaleLifecycles(saleRows as any);

  type EffectiveGroup = {
    reservationId: number | null;
    sourceType: string;
    category: BookingSaleSourceCategory;
    gross: number;
    discount: number;
    net: number;
    paid: number;
    remaining: number;
  };

  const effectiveGroups: EffectiveGroup[] = lifecycleGroups.map((group) => {
    const amounts = effectiveSaleAmounts(group.members);
    const sourceType = String(group.primary.source_type || 'OTHER_SALE').toUpperCase();
    const reservationId = asPositiveInt(group.primary.reservation_id);
    const paid = reservationId ? 0 : unattachedPaid(group.primary, amounts.net);
    return {
      reservationId,
      sourceType,
      category: mapSaleSourceCategory(sourceType),
      gross: amounts.gross,
      discount: amounts.discount,
      net: amounts.net,
      paid,
      remaining: reservationId ? 0 : Math.max(0, amounts.net - paid),
    };
  });

  const children: BookingSalesChildRow[] = [...(input.reservations || [])]
    .map((reservation) => {
      const reservationId = asPositiveInt(reservation.id);
      if (!reservationId) return null;
      const groups = effectiveGroups.filter((group) => group.reservationId === reservationId);
      const gross = groups.reduce((sum, group) => sum + group.gross, 0);
      const discount = groups.reduce((sum, group) => sum + group.discount, 0);
      const net = groups.reduce((sum, group) => sum + group.net, 0);
      const paid = roundIdr(reservation.amount_paid);
      const remaining = reservation.remaining_balance !== undefined && reservation.remaining_balance !== null && String(reservation.remaining_balance) !== ''
        ? Math.max(0, roundIdr(reservation.remaining_balance))
        : Math.max(0, net - paid);
      return {
        reservation_id: reservationId,
        room_id: asPositiveInt(reservation.room_id),
        room_number: String(reservation.room_number || '').trim(),
        room_type_name: canonicalRoomTypeName(reservation),
        stay_sequence: reservation.stay_sequence == null || reservation.stay_sequence === ''
          ? null
          : Number(reservation.stay_sequence),
        stay_type: reservation.stay_type || null,
        check_in: hotelDate(reservation.check_in),
        check_out: hotelDate(reservation.check_out),
        reservation_status: reservation.status || reservation.stay_status || null,
        operational_sheet: childOperationalSheet(reservation),
        payment_status: derivePaymentStatus(paid, remaining, net),
        gross,
        discount,
        net,
        paid,
        remaining,
      } as BookingSalesChildRow;
    })
    .filter((row): row is BookingSalesChildRow => Boolean(row))
    .sort((a, b) => {
      const seqCmp = Number(a.stay_sequence || 0) - Number(b.stay_sequence || 0);
      if (seqCmp !== 0) return seqCmp;
      const roomCmp = a.room_number.localeCompare(b.room_number, undefined, { numeric: true });
      if (roomCmp !== 0) return roomCmp;
      return a.reservation_id - b.reservation_id;
    });

  const unattached = effectiveGroups.filter((group) => !group.reservationId);
  const gross = effectiveGroups.reduce((sum, group) => sum + group.gross, 0);
  const discount = effectiveGroups.reduce((sum, group) => sum + group.discount, 0);
  const net = effectiveGroups.reduce((sum, group) => sum + group.net, 0);
  const paid = children.reduce((sum, child) => sum + child.paid, 0)
    + unattached.reduce((sum, group) => sum + group.paid, 0);
  const remaining = children.reduce((sum, child) => sum + child.remaining, 0)
    + unattached.reduce((sum, group) => sum + group.remaining, 0);

  const breakdownMap = new Map<string, BookingSalesSourceBreakdownRow>();
  for (const group of effectiveGroups) {
    const key = `${group.category}|${group.sourceType}`;
    const existing = breakdownMap.get(key);
    if (existing) {
      existing.gross += group.gross;
      existing.discount += group.discount;
      existing.net += group.net;
      existing.transaction_count += 1;
    } else {
      breakdownMap.set(key, {
        category: group.category,
        source_type: group.sourceType,
        gross: group.gross,
        discount: group.discount,
        net: group.net,
        transaction_count: 1,
      });
    }
  }

  const source_breakdown = [...breakdownMap.values()].sort((a, b) => {
    const catCmp = SOURCE_CATEGORY_ORDER.indexOf(a.category) - SOURCE_CATEGORY_ORDER.indexOf(b.category);
    if (catCmp !== 0) return catCmp;
    return a.source_type.localeCompare(b.source_type);
  });

  const checkIns = children.map((child) => child.check_in).filter((value): value is string => Boolean(value)).sort();
  const checkOuts = children.map((child) => child.check_out).filter((value): value is string => Boolean(value)).sort();

  const payments: BookingSalesPaymentRow[] = [...(input.payments || [])]
    .map((payment) => ({
      payment_id: Number(payment.id),
      reservation_id: asPositiveInt(payment.reservation_id),
      transaction_id: payment.transaction_id == null || payment.transaction_id === ''
        ? null
        : payment.transaction_id,
      method: payment.payment_method || null,
      amount: roundIdr(payment.amount),
      status: String(payment.status || '').toUpperCase() || 'SUCCESS',
      paid_at: payment.created_at ? String(payment.created_at) : null,
      reference: payment.reference_code || null,
      evidence_reference: payment.evidence_filename || payment.evidence_storage_key || null,
    }))
    .sort((a, b) => String(a.paid_at || '').localeCompare(String(b.paid_at || '')) || a.payment_id - b.payment_id);

  return {
    context_label: 'Seluruh Booking',
    scope: 'LIFETIME_BOOKING',
    booking: {
      booking_id: bookingId,
      bid: String(input.booking.bid || '').trim(),
      property_id: Number(input.booking.property_id),
      guest_name: String(input.booking.guest_name_snapshot || '').trim() || '-',
      booker_name: input.booking.booker_name ? String(input.booking.booker_name).trim() : null,
      booking_source: input.booking.booking_source || null,
      booking_channel: input.booking.booking_channel || input.booking.channel || null,
      booking_status: input.booking.booking_status || null,
      check_in: checkIns[0] || null,
      check_out: checkOuts[checkOuts.length - 1] || null,
      room_count: children.length,
    },
    financial: {
      scope: 'LIFETIME_BOOKING',
      gross,
      discount,
      net,
      paid,
      remaining,
      payment_status: derivePaymentStatus(paid, remaining, net),
    },
    source_breakdown,
    children,
    payments,
  };
}

import type { OperationalSheet, TransactionRecord } from './transactionDomainTypes.ts';
import { formatReservationStayType, mapToOperationalStatus } from './transactionDomainTypes.ts';

export type PenjualanPaymentStatus = 'PAID' | 'PARTIAL' | 'UNPAID';
export type PenjualanTotalsScope = 'PERIOD_ACTIVITY';

export interface PenjualanBidChild {
  reservation_id: number | null;
  primary_transaction_id: number | string;
  room_number: string;
  room_type_name: string;
  check_in: string | null;
  check_out: string | null;
  stay_type: string | null;
  stay_sequence: number | null;
  gross: number;
  discount: number;
  net: number;
  paid: number;
  remaining: number;
  payment_status: PenjualanPaymentStatus;
  reservation_status: string | null;
  operational_sheet: OperationalSheet;
}

export interface PenjualanBidGroup {
  bid: string;
  booking_id: number | string | null;
  guest_name: string;
  room_count: number;
  stay_type_label: string;
  totals_scope: PenjualanTotalsScope;
  member_transaction_ids: number[];
  gross: number;
  discount: number;
  net: number;
  paid: number;
  remaining: number;
  payment_status: PenjualanPaymentStatus;
  operational_sheet: OperationalSheet;
  children: PenjualanBidChild[];
  primary: TransactionRecord;
  members: TransactionRecord[];
}

export type PenjualanListItem =
  | { kind: 'standalone'; tx: TransactionRecord }
  | { kind: 'bid_group'; group: PenjualanBidGroup };

export type AllTabListItem =
  | PenjualanListItem
  | { kind: 'other'; tx: TransactionRecord };

export function roundIdr(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount);
}

export function saleNet(tx: Pick<TransactionRecord, 'effective_net_amount' | 'net_amount'>): number {
  if (tx.effective_net_amount !== undefined && tx.effective_net_amount !== null && String(tx.effective_net_amount) !== '') {
    return roundIdr(tx.effective_net_amount);
  }
  return roundIdr(tx.net_amount);
}

export function canonicalBookingBid(tx: Pick<TransactionRecord, 'booking_bid'>): string | null {
  const bid = String(tx.booking_bid || '').trim();
  return bid || null;
}

/**
 * Standalone if there is no booking BID.
 * POS / POS_ORDER with a BID join the booking group (future linked outlet sales).
 * POS / POS_ORDER without a BID stay standalone — never invent a fake BID.
 */
export function isStandalonePenjualanSale(tx: Pick<TransactionRecord, 'source_type' | 'booking_bid'>): boolean {
  return !canonicalBookingBid(tx);
}

export function derivePaymentStatus(paid: number, remaining: number, net: number): PenjualanPaymentStatus {
  if (remaining <= 0) return 'PAID';
  if (paid > 0 && remaining > 0) return 'PARTIAL';
  if (paid <= 0 && net > 0) return 'UNPAID';
  return remaining <= 0 ? 'PAID' : 'UNPAID';
}

/** Booking settlement badge. Does not compare lifetime paid/remaining to period net. */
export function deriveBookingPaymentStatus(paid: number, remaining: number): PenjualanPaymentStatus {
  if (remaining <= 0) return 'PAID';
  if (paid > 0) return 'PARTIAL';
  return 'UNPAID';
}

export function isPeriodActivityGroup(group: Pick<PenjualanBidGroup, 'totals_scope'>): boolean {
  return group.totals_scope === 'PERIOD_ACTIVITY';
}

export function shouldShowListSettlementAmounts(item: Pick<PenjualanListItem, 'kind'>): boolean {
  return item.kind === 'standalone';
}

function normalizePaymentStatus(value: unknown): PenjualanPaymentStatus | null {
  const raw = String(value || '').toUpperCase();
  if (raw === 'PAID' || raw === 'PARTIAL' || raw === 'UNPAID') return raw;
  return null;
}

export function deriveGroupOperationalSheet(sheets: OperationalSheet[]): OperationalSheet {
  if (sheets.length > 0 && sheets.every((sheet) => sheet === 'BATAL')) return 'BATAL';
  if (sheets.length > 0 && sheets.every((sheet) => sheet === 'SELESAI')) return 'SELESAI';
  return 'PROSES';
}

export interface BookingReservationLifecycleRow {
  property_id?: number;
  booking_id?: number | string | null;
  booking_bid?: string | null;
  reservation_id: number;
  reservation_status?: string | null;
  reservation_stay_status?: string | null;
  stay_status?: string | null;
}

export interface BidGroupingOptions {
  lifecycleReservations?: BookingReservationLifecycleRow[];
}

/** Stay-child sheet from reservation lifecycle. Paid/unpaid is ignored. */
export function reservationLifecycleSheet(row: BookingReservationLifecycleRow): OperationalSheet {
  const reservationStatus = String(row.reservation_status || '').trim().toUpperCase();
  const stayStatus = String(row.reservation_stay_status || row.stay_status || '').trim().toUpperCase();
  if (reservationStatus === 'CANCELLED' || stayStatus === 'CANCELLED') return 'BATAL';
  if (reservationStatus === 'CHECKED_OUT' || stayStatus === 'CHECKED_OUT') return 'SELESAI';
  if (
    reservationStatus === 'BOOKED'
    || reservationStatus === 'CHECKED_IN'
    || stayStatus === 'RESERVED'
    || stayStatus === 'CHECKED_IN'
    || stayStatus === 'BOOKED'
  ) {
    return 'PROSES';
  }
  return 'PROSES';
}

function lifecycleStorageKeys(row: {
  property_id?: unknown;
  booking_id?: unknown;
  booking_bid?: unknown;
}): string[] {
  const propertyId = Number(row.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) return [];
  const keys: string[] = [];
  const bookingId = Number(row.booking_id);
  if (Number.isInteger(bookingId) && bookingId > 0) keys.push(`${propertyId}:${bookingId}`);
  const bid = String(row.booking_bid || '').trim();
  if (bid) keys.push(`${propertyId}:bid:${bid}`);
  return keys;
}

export function indexBookingLifecycleSheets(
  reservations: BookingReservationLifecycleRow[] | undefined
): Map<string, OperationalSheet[]> {
  const map = new Map<string, OperationalSheet[]>();
  if (!reservations || reservations.length === 0) return map;
  for (const row of reservations) {
    const sheet = reservationLifecycleSheet(row);
    for (const key of lifecycleStorageKeys(row)) {
      const list = map.get(key) || [];
      list.push(sheet);
      map.set(key, list);
    }
  }
  return map;
}

function lookupBookingLifecycleSheets(
  lifecycleSheets: Map<string, OperationalSheet[]>,
  row: { property_id?: unknown; booking_id?: unknown; booking_bid?: unknown }
): OperationalSheet[] {
  for (const key of lifecycleStorageKeys(row)) {
    const sheets = lifecycleSheets.get(key);
    if (sheets && sheets.length > 0) return sheets;
  }
  return [];
}

export function stayTypeLabel(stayTypes: Array<string | null | undefined>): string {
  const unique = [...new Set(stayTypes.map((value) => String(value || '').trim().toUpperCase()).filter(Boolean))];
  if (unique.length === 0) return '-';
  if (unique.length === 1) {
    const formatted = formatReservationStayType(unique[0]);
    return formatted === '-' ? unique[0] : formatted;
  }
  return 'MIXED';
}

function groupStorageKey(tx: Pick<TransactionRecord, 'booking_bid' | 'property_id'>): string | null {
  const bid = canonicalBookingBid(tx);
  if (!bid) return null;
  const propertyId = Number(tx.property_id);
  return Number.isInteger(propertyId) && propertyId > 0 ? `${propertyId}:${bid}` : bid;
}

function childKey(tx: TransactionRecord): string {
  const reservationId = Number(tx.reservation_id);
  if (Number.isInteger(reservationId) && reservationId > 0) return `r:${reservationId}`;
  return `t:${tx.id}`;
}

function hasReservationChild(tx: TransactionRecord): boolean {
  const reservationId = Number(tx.reservation_id);
  return Number.isInteger(reservationId) && reservationId > 0;
}

function canonicalBookingId(rows: TransactionRecord[]): number | string | null {
  for (const row of rows) {
    if (row.booking_id == null || row.booking_id === '') continue;
    const numeric = Number(row.booking_id);
    if (Number.isInteger(numeric) && numeric > 0) return numeric;
    return row.booking_id;
  }
  return null;
}

function reservationPaid(tx: TransactionRecord): number {
  if (tx.reservation_amount_paid !== undefined && tx.reservation_amount_paid !== null && String(tx.reservation_amount_paid) !== '') {
    return roundIdr(tx.reservation_amount_paid);
  }
  return roundIdr(tx.paid_amount);
}

function reservationRemaining(tx: TransactionRecord, net: number, paid: number): number {
  if (tx.reservation_remaining_balance !== undefined && tx.reservation_remaining_balance !== null && String(tx.reservation_remaining_balance) !== '') {
    return Math.max(0, roundIdr(tx.reservation_remaining_balance));
  }
  return Math.max(0, net - paid);
}

function canonicalRoomTypeName(tx: TransactionRecord): string {
  return String(tx.room_type_name || tx.booked_room_type_name_snapshot || '').trim();
}

function operationalSheetOf(tx: TransactionRecord): OperationalSheet {
  if (tx.operational_sheet === 'HAPUS' || tx.operational_sheet === 'BATAL' || tx.operational_sheet === 'SELESAI' || tx.operational_sheet === 'PROSES') {
    return tx.operational_sheet;
  }
  return mapToOperationalStatus(tx).group;
}

function buildChild(reservationId: number | null, members: TransactionRecord[]): PenjualanBidChild {
  const primary = members[0];
  const gross = members.reduce((sum, tx) => sum + roundIdr(tx.amount), 0);
  const discount = members.reduce((sum, tx) => sum + roundIdr(tx.discount_amount), 0);
  const net = members.reduce((sum, tx) => sum + saleNet(tx), 0);
  const paid = reservationPaid(primary);
  const remaining = reservationRemaining(primary, net, paid);
  return {
    reservation_id: reservationId,
    primary_transaction_id: primary.id,
    room_number: String(primary.room_number_snapshot || '').trim(),
    room_type_name: canonicalRoomTypeName(primary),
    check_in: primary.check_in ? String(primary.check_in).slice(0, 10) : null,
    check_out: primary.check_out ? String(primary.check_out).slice(0, 10) : null,
    stay_type: primary.stay_type || null,
    stay_sequence: primary.stay_sequence == null ? null : Number(primary.stay_sequence),
    gross,
    discount,
    net,
    paid,
    remaining,
    payment_status: deriveBookingPaymentStatus(paid, remaining),
    reservation_status: primary.reservation_status || null,
    operational_sheet: operationalSheetOf(primary)
  };
}

function unattachedFinancial(rows: TransactionRecord[]): { gross: number; discount: number; net: number; paid: number; remaining: number } {
  return rows.reduce(
    (acc, tx) => {
      const gross = roundIdr(tx.amount);
      const discount = roundIdr(tx.discount_amount);
      const net = saleNet(tx);
      const paid = reservationPaid(tx);
      const remaining = reservationRemaining(tx, net, paid);
      return {
        gross: acc.gross + gross,
        discount: acc.discount + discount,
        net: acc.net + net,
        paid: acc.paid + paid,
        remaining: acc.remaining + remaining
      };
    },
    { gross: 0, discount: 0, net: 0, paid: 0, remaining: 0 }
  );
}

function buildGroup(
  bid: string,
  members: TransactionRecord[],
  lifecycleSheets: Map<string, OperationalSheet[]>
): PenjualanBidGroup {
  const reservationMembers = members.filter(hasReservationChild);
  const unattachedMembers = members.filter((tx) => !hasReservationChild(tx));
  const byChild = new Map<string, TransactionRecord[]>();
  for (const tx of reservationMembers) {
    const key = childKey(tx);
    const list = byChild.get(key) || [];
    list.push(tx);
    byChild.set(key, list);
  }
  const children = [...byChild.entries()]
    .map(([key, childMembers]) => {
      const reservationId = key.startsWith('r:') ? Number(key.slice(2)) : null;
      return buildChild(reservationId && Number.isFinite(reservationId) ? reservationId : null, childMembers);
    })
    .sort((a, b) => {
      const seqCmp = Number(a.stay_sequence || 0) - Number(b.stay_sequence || 0);
      if (seqCmp !== 0) return seqCmp;
      const roomCmp = a.room_number.localeCompare(b.room_number, undefined, { numeric: true });
      if (roomCmp !== 0) return roomCmp;
      return Number(a.reservation_id || 0) - Number(b.reservation_id || 0);
    });

  const unattached = unattachedFinancial(unattachedMembers);
  const gross = children.reduce((sum, child) => sum + child.gross, 0) + unattached.gross;
  const discount = children.reduce((sum, child) => sum + child.discount, 0) + unattached.discount;
  const net = children.reduce((sum, child) => sum + child.net, 0) + unattached.net;
  const paid = children.reduce((sum, child) => sum + child.paid, 0) + unattached.paid;
  const remaining = children.reduce((sum, child) => sum + child.remaining, 0) + unattached.remaining;
  const bookingId = canonicalBookingId(members);
  const lifetimeSheets = lookupBookingLifecycleSheets(lifecycleSheets, {
    property_id: members[0].property_id,
    booking_id: bookingId,
    booking_bid: bid
  });
  const periodSheets = [
    ...children.map((child) => child.operational_sheet),
    ...unattachedMembers.map((tx) => operationalSheetOf(tx)),
  ];
  const statusSheets = lifetimeSheets.length > 0
    ? lifetimeSheets
    : (periodSheets.length > 0 ? periodSheets : members.map((tx) => operationalSheetOf(tx)));

  return {
    bid,
    booking_id: bookingId,
    guest_name: String(members[0].party_name || members[0].guest_name_snapshot || '').trim() || '-',
    room_count: children.length,
    stay_type_label: stayTypeLabel(children.map((child) => child.stay_type)),
    totals_scope: 'PERIOD_ACTIVITY',
    member_transaction_ids: members.map((tx) => Number(tx.id)),
    gross,
    discount,
    net,
    paid,
    remaining,
    payment_status: deriveBookingPaymentStatus(paid, remaining),
    operational_sheet: deriveGroupOperationalSheet(statusSheets),
    children,
    primary: members[0],
    members
  };
}

export function groupPenjualanSaleRows(
  rows: TransactionRecord[],
  options?: BidGroupingOptions
): PenjualanListItem[] {
  const lifecycleSheets = indexBookingLifecycleSheets(options?.lifecycleReservations);
  const items: PenjualanListItem[] = [];
  const bidIndex = new Map<string, number>();

  for (const row of rows) {
    if (isStandalonePenjualanSale(row)) {
      items.push({ kind: 'standalone', tx: row });
      continue;
    }
    const bid = canonicalBookingBid(row);
    if (!bid) {
      items.push({ kind: 'standalone', tx: row });
      continue;
    }
    if (row.booking_bid_group && String(row.booking_bid_group.bid || '').trim()) {
      const payload = row.booking_bid_group;
      const paid = roundIdr(payload.paid);
      const remaining = roundIdr(payload.remaining);
      items.push({
        kind: 'bid_group',
        group: {
          bid: payload.bid,
          booking_id: payload.booking_id ?? row.booking_id ?? null,
          guest_name: payload.guest_name,
          room_count: payload.room_count,
          stay_type_label: payload.stay_type_label,
          totals_scope: 'PERIOD_ACTIVITY',
          member_transaction_ids: Array.isArray(payload.member_transaction_ids)
            ? payload.member_transaction_ids.map(Number)
            : [Number(row.id)],
          gross: roundIdr(payload.gross),
          discount: roundIdr(payload.discount),
          net: roundIdr(payload.net),
          paid,
          remaining,
          payment_status:
            normalizePaymentStatus(payload.payment_status) || deriveBookingPaymentStatus(paid, remaining),
          operational_sheet: payload.operational_sheet,
          children: (payload.children || []).map((child) => ({
            ...child,
            payment_status:
              normalizePaymentStatus(child.payment_status)
              || deriveBookingPaymentStatus(roundIdr(child.paid), roundIdr(child.remaining)),
            stay_sequence: child.stay_sequence == null ? null : Number(child.stay_sequence)
          })),
          primary: row,
          members: [row]
        }
      });
      continue;
    }
    const storageKey = groupStorageKey(row) || bid;
    const existing = bidIndex.get(storageKey);
    if (existing === undefined) {
      bidIndex.set(storageKey, items.length);
      items.push({ kind: 'bid_group', group: buildGroup(bid, [row], lifecycleSheets) });
    } else {
      const item = items[existing];
      if (item.kind !== 'bid_group') continue;
      item.group = buildGroup(bid, [...item.group.members, row], lifecycleSheets);
    }
  }

  return items;
}

function saleGroupKey(tx: Pick<TransactionRecord, 'property_id' | 'booking_bid'> & { booking_bid_group?: { bid?: string } }): string | null {
  const bid = String(tx.booking_bid_group?.bid || tx.booking_bid || '').trim();
  if (!bid) return null;
  const propertyId = Number(tx.property_id);
  return Number.isInteger(propertyId) && propertyId > 0 ? `${propertyId}:${bid}` : bid;
}

/**
 * ALL-tab presenter: only SALE uses BID grouping. Other types stay standalone.
 */
export function groupAllTabRows(rows: TransactionRecord[], options?: BidGroupingOptions): AllTabListItem[] {
  const saleRows = rows.filter((row) => String(row.transaction_type || '').toUpperCase() === 'SALE');
  const groupedSales = groupPenjualanSaleRows(saleRows, options);
  const itemBySaleId = new Map<number, PenjualanListItem>();

  for (const item of groupedSales) {
    if (item.kind === 'standalone') {
      itemBySaleId.set(Number(item.tx.id), item);
      continue;
    }
    const ids = item.group.member_transaction_ids.length > 0
      ? item.group.member_transaction_ids
      : [Number(item.group.primary.id)];
    for (const id of ids) {
      if (Number.isInteger(id) && id > 0) itemBySaleId.set(id, item);
    }
    itemBySaleId.set(Number(item.group.primary.id), item);
  }

  const seenGroup = new Set<string>();
  const result: AllTabListItem[] = [];
  for (const row of rows) {
    if (String(row.transaction_type || '').toUpperCase() !== 'SALE') {
      result.push({ kind: 'other', tx: row });
      continue;
    }
    const item = itemBySaleId.get(Number(row.id));
    if (!item) {
      result.push({ kind: 'standalone', tx: row });
      continue;
    }
    if (item.kind === 'bid_group') {
      const key = saleGroupKey(item.group.primary) || `${item.group.bid}`;
      if (seenGroup.has(key)) continue;
      seenGroup.add(key);
      result.push(item);
      continue;
    }
    result.push(item);
  }
  return result;
}

export function flattenAllTabRows(items: AllTabListItem[]): TransactionRecord[] {
  return items.map((item) => {
    if (item.kind !== 'bid_group') return item.tx;
    const { group } = item;
    return {
      ...group.primary,
      operational_sheet: group.operational_sheet,
      payment_status: group.payment_status,
      booking_bid_group: {
        bid: group.bid,
        booking_id: group.booking_id,
        guest_name: group.guest_name,
        room_count: group.room_count,
        stay_type_label: group.stay_type_label,
        totals_scope: group.totals_scope,
        member_transaction_ids: group.member_transaction_ids,
        gross: group.gross,
        discount: group.discount,
        net: group.net,
        paid: group.paid,
        remaining: group.remaining,
        payment_status: group.payment_status,
        operational_sheet: group.operational_sheet,
        children: group.children
      }
    };
  });
}

export function formatStayShortDate(value: string | null | undefined): string {
  const raw = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '-';
  const date = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
}

export function paymentStatusBadgeClass(status: string): string {
  const raw = String(status || '').toUpperCase();
  if (raw === 'PAID' || raw === 'LUNAS') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (raw === 'PARTIAL') return 'bg-amber-50 text-amber-700 border-amber-200';
  return 'bg-slate-50 text-slate-600 border-slate-200';
}

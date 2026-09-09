import { OperationalSheet } from './transactionTypes';
import { deriveReservationLinkedSaleSheet } from './saleLifecycleGrouping';

export type PenjualanPaymentStatus = 'PAID' | 'PARTIAL' | 'UNPAID';

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

export type PenjualanTotalsScope = 'PERIOD_ACTIVITY';

export interface PenjualanBidGroupPayload {
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
}

export function roundIdr(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount);
}

export function saleNet(row: { effective_net_amount?: unknown; net_amount?: unknown }): number {
  if (row.effective_net_amount !== undefined && row.effective_net_amount !== null && String(row.effective_net_amount) !== '') {
    return roundIdr(row.effective_net_amount);
  }
  return roundIdr(row.net_amount);
}

export function canonicalBookingBid(row: { booking_bid?: unknown }): string | null {
  const bid = String(row.booking_bid || '').trim();
  return bid || null;
}

/**
 * Standalone if there is no booking BID.
 * POS / POS_ORDER with a BID join the booking group (future linked outlet sales).
 * POS / POS_ORDER without a BID stay standalone — never invent a fake BID.
 */
export function isStandalonePenjualanSale(row: { source_type?: unknown; booking_bid?: unknown }): boolean {
  return !canonicalBookingBid(row);
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

export function shouldShowListSettlementAmounts(hasBidGroup: boolean): boolean {
  return !hasBidGroup;
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
  const sheet = deriveReservationLinkedSaleSheet({
    transaction_type: 'SALE',
    source_type: 'ROOM_CHARGE',
    reservation_id: row.reservation_id,
    reservation_status: row.reservation_status,
    reservation_stay_status: row.reservation_stay_status,
    stay_status: row.stay_status,
  });
  return sheet || 'PROSES';
}

export function collectSaleBookingRefs(rows: any[]): { bookingIds: number[]; bids: string[] } {
  const bookingIds = new Set<number>();
  const bids = new Set<string>();
  for (const row of rows) {
    if (String(row.transaction_type || '').toUpperCase() !== 'SALE') continue;
    const bid = canonicalBookingBid(row);
    if (!bid) continue;
    bids.add(bid);
    const bookingId = Number(row.booking_id);
    if (Number.isInteger(bookingId) && bookingId > 0) bookingIds.add(bookingId);
  }
  return { bookingIds: [...bookingIds], bids: [...bids] };
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
    if (unique[0] === 'DAY_USE') return 'DAY USE';
    if (unique[0] === 'OVERNIGHT') return 'OVERNIGHT';
    return unique[0];
  }
  return 'MIXED';
}

function hotelDate(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const raw = String(value);
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso ? iso[1] : raw.slice(0, 10);
}

function groupStorageKey(row: { booking_bid?: unknown; property_id?: unknown }): string | null {
  const bid = canonicalBookingBid(row);
  if (!bid) return null;
  const propertyId = Number(row.property_id);
  return Number.isInteger(propertyId) && propertyId > 0 ? `${propertyId}:${bid}` : bid;
}

function childKey(row: any): string {
  const reservationId = Number(row.reservation_id);
  if (Number.isInteger(reservationId) && reservationId > 0) return `r:${reservationId}`;
  return `t:${row.id}`;
}

function hasReservationChild(row: any): boolean {
  const reservationId = Number(row.reservation_id);
  return Number.isInteger(reservationId) && reservationId > 0;
}

function canonicalBookingId(rows: any[]): number | string | null {
  for (const row of rows) {
    if (row.booking_id == null || row.booking_id === '') continue;
    const numeric = Number(row.booking_id);
    if (Number.isInteger(numeric) && numeric > 0) return numeric;
    return row.booking_id;
  }
  return null;
}

function reservationPaid(row: any): number {
  if (row.reservation_amount_paid !== undefined && row.reservation_amount_paid !== null && String(row.reservation_amount_paid) !== '') {
    return roundIdr(row.reservation_amount_paid);
  }
  return roundIdr(row.paid_amount);
}

function reservationRemaining(row: any, net: number, paid: number): number {
  if (row.reservation_remaining_balance !== undefined && row.reservation_remaining_balance !== null && String(row.reservation_remaining_balance) !== '') {
    return Math.max(0, roundIdr(row.reservation_remaining_balance));
  }
  return Math.max(0, net - paid);
}

function canonicalRoomTypeName(row: any): string {
  return String(row.room_type_name || row.booked_room_type_name_snapshot || '').trim();
}

function operationalSheetOf(row: any): OperationalSheet {
  const sheet = String(row.operational_sheet || '').toUpperCase();
  if (sheet === 'HAPUS' || sheet === 'BATAL' || sheet === 'SELESAI' || sheet === 'PROSES') {
    return sheet as OperationalSheet;
  }
  return 'PROSES';
}

function buildChild(reservationId: number | null, members: any[]): PenjualanBidChild {
  const primary = members[0];
  const gross = members.reduce((sum, row) => sum + roundIdr(row.amount), 0);
  const discount = members.reduce((sum, row) => sum + roundIdr(row.discount_amount), 0);
  const net = members.reduce((sum, row) => sum + saleNet(row), 0);
  const paid = reservationPaid(primary);
  const remaining = reservationRemaining(primary, net, paid);
  return {
    reservation_id: reservationId,
    primary_transaction_id: primary.id,
    room_number: String(primary.room_number_snapshot || '').trim(),
    room_type_name: canonicalRoomTypeName(primary),
    check_in: hotelDate(primary.check_in),
    check_out: hotelDate(primary.check_out),
    stay_type: primary.stay_type || null,
    stay_sequence: primary.stay_sequence == null || primary.stay_sequence === '' ? null : Number(primary.stay_sequence),
    gross,
    discount,
    net,
    paid,
    remaining,
    payment_status: deriveBookingPaymentStatus(paid, remaining),
    reservation_status: primary.reservation_status || null,
    operational_sheet: operationalSheetOf(primary),
  };
}

function unattachedFinancial(rows: any[]): { gross: number; discount: number; net: number; paid: number; remaining: number } {
  return rows.reduce(
    (acc, row) => {
      const gross = roundIdr(row.amount);
      const discount = roundIdr(row.discount_amount);
      const net = saleNet(row);
      const paid = reservationPaid(row);
      const remaining = reservationRemaining(row, net, paid);
      return {
        gross: acc.gross + gross,
        discount: acc.discount + discount,
        net: acc.net + net,
        paid: acc.paid + paid,
        remaining: acc.remaining + remaining,
      };
    },
    { gross: 0, discount: 0, net: 0, paid: 0, remaining: 0 }
  );
}

function buildGroup(
  bid: string,
  members: any[],
  lifecycleSheets: Map<string, OperationalSheet[]>
): PenjualanBidGroupPayload & { primary: any; members: any[] } {
  const reservationMembers = members.filter(hasReservationChild);
  const unattachedMembers = members.filter((row) => !hasReservationChild(row));
  const byChild = new Map<string, any[]>();
  for (const row of reservationMembers) {
    const key = childKey(row);
    const list = byChild.get(key) || [];
    list.push(row);
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
    booking_bid: bid,
  });
  const periodSheets = [
    ...children.map((child) => child.operational_sheet),
    ...unattachedMembers.map((row) => operationalSheetOf(row)),
  ];
  const periodIsFullyBatal =
    periodSheets.length > 0
    && periodSheets.every((sheet) => sheet === 'BATAL');
  const statusSheets: OperationalSheet[] = periodIsFullyBatal
    ? ['BATAL']
    : (lifetimeSheets.length > 0
        ? lifetimeSheets
        : (periodSheets.length > 0 ? periodSheets : members.map((row) => operationalSheetOf(row))));

  return {
    bid,
    booking_id: bookingId,
    guest_name: String(members[0].party_name || members[0].guest_name_snapshot || '').trim() || '-',
    room_count: children.length,
    stay_type_label: stayTypeLabel(children.map((child) => child.stay_type)),
    totals_scope: 'PERIOD_ACTIVITY',
    member_transaction_ids: members.map((row) => Number(row.id)),
    gross,
    discount,
    net,
    paid,
    remaining,
    payment_status: deriveBookingPaymentStatus(paid, remaining),
    operational_sheet: deriveGroupOperationalSheet(statusSheets),
    children,
    primary: members[0],
    members,
  };
}

export function presentBidGroupedSales(presented: any[], options?: BidGroupingOptions): any[] {
  const lifecycleSheets = indexBookingLifecycleSheets(options?.lifecycleReservations);
  const items: Array<{ kind: 'standalone'; tx: any } | { kind: 'bid_group'; group: ReturnType<typeof buildGroup> }> = [];
  const bidIndex = new Map<string, number>();

  for (const row of presented) {
    if (isStandalonePenjualanSale(row)) {
      items.push({ kind: 'standalone', tx: row });
      continue;
    }
    const bid = canonicalBookingBid(row);
    if (!bid) {
      items.push({ kind: 'standalone', tx: row });
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

  return items.map((item) => {
    if (item.kind === 'standalone') return item.tx;
    const group = item.group;
    const { primary, members: _members, ...payload } = group;
    return {
      ...primary,
      operational_sheet: payload.operational_sheet,
      payment_status: payload.payment_status,
      booking_bid_group: payload,
    };
  });
}

function saleGroupStorageKey(row: { booking_bid?: unknown; property_id?: unknown; booking_bid_group?: { bid?: unknown } }): string | null {
  const groupedBid = String(row.booking_bid_group?.bid || '').trim();
  const bid = groupedBid || canonicalBookingBid(row);
  if (!bid) return null;
  const propertyId = Number(row.property_id);
  return Number.isInteger(propertyId) && propertyId > 0 ? `${propertyId}:${bid}` : bid;
}

/**
 * ALL-tab / mixed-type list presenter:
 * SALE rows use BID grouping; PURCHASE / EXPENSE / INCOME stay standalone.
 * Each BID group is emitted once so pagination does not count member rows twice.
 */
export function presentListWithSaleBidGrouping(presented: any[], options?: BidGroupingOptions): any[] {
  const saleRows = presented.filter((row) => String(row.transaction_type || '').toUpperCase() === 'SALE');
  const groupedSales = presentBidGroupedSales(saleRows, options);
  const groupedByMemberId = new Map<number, any>();

  for (const grouped of groupedSales) {
    const memberIds: number[] = Array.isArray(grouped.booking_bid_group?.member_transaction_ids)
      ? grouped.booking_bid_group.member_transaction_ids.map(Number)
      : [Number(grouped.id)];
    for (const id of memberIds) {
      if (Number.isInteger(id) && id > 0) groupedByMemberId.set(id, grouped);
    }
  }

  const seenGroup = new Set<string>();
  const result: any[] = [];
  for (const row of presented) {
    if (String(row.transaction_type || '').toUpperCase() !== 'SALE') {
      result.push(row);
      continue;
    }
    const grouped = groupedByMemberId.get(Number(row.id));
    if (!grouped) {
      result.push(row);
      continue;
    }
    if (grouped.booking_bid_group) {
      const key = saleGroupStorageKey(grouped);
      if (!key) {
        result.push(grouped);
        continue;
      }
      if (seenGroup.has(key)) continue;
      seenGroup.add(key);
      result.push(grouped);
      continue;
    }
    result.push(grouped);
  }
  return result;
}

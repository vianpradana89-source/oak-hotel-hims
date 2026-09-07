import { OperationalSheet } from './transactionTypes';

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

export interface PenjualanBidGroupPayload {
  bid: string;
  guest_name: string;
  room_count: number;
  stay_type_label: string;
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

export function isStandalonePenjualanSale(row: { source_type?: unknown; booking_bid?: unknown }): boolean {
  const source = String(row.source_type || '').trim().toUpperCase();
  if (source === 'POS' || source === 'POS_ORDER') return true;
  return !canonicalBookingBid(row);
}

export function derivePaymentStatus(paid: number, remaining: number, net: number): PenjualanPaymentStatus {
  if (remaining <= 0) return 'PAID';
  if (paid > 0 && remaining > 0) return 'PARTIAL';
  if (paid <= 0 && net > 0) return 'UNPAID';
  return remaining <= 0 ? 'PAID' : 'UNPAID';
}

export function deriveGroupOperationalSheet(sheets: OperationalSheet[]): OperationalSheet {
  if (sheets.length > 0 && sheets.every((sheet) => sheet === 'BATAL')) return 'BATAL';
  if (sheets.length > 0 && sheets.every((sheet) => sheet === 'SELESAI')) return 'SELESAI';
  return 'PROSES';
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
    payment_status: derivePaymentStatus(paid, remaining, net),
    reservation_status: primary.reservation_status || null,
    operational_sheet: operationalSheetOf(primary),
  };
}

function buildGroup(bid: string, members: any[]): PenjualanBidGroupPayload & { primary: any; members: any[] } {
  const byChild = new Map<string, any[]>();
  for (const row of members) {
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

  const gross = children.reduce((sum, child) => sum + child.gross, 0);
  const discount = children.reduce((sum, child) => sum + child.discount, 0);
  const net = children.reduce((sum, child) => sum + child.net, 0);
  const paid = children.reduce((sum, child) => sum + child.paid, 0);
  const remaining = children.reduce((sum, child) => sum + child.remaining, 0);

  return {
    bid,
    guest_name: String(members[0].party_name || members[0].guest_name_snapshot || '').trim() || '-',
    room_count: children.length,
    stay_type_label: stayTypeLabel(children.map((child) => child.stay_type)),
    gross,
    discount,
    net,
    paid,
    remaining,
    payment_status: derivePaymentStatus(paid, remaining, net),
    operational_sheet: deriveGroupOperationalSheet(children.map((child) => child.operational_sheet)),
    children,
    primary: members[0],
    members,
  };
}

export function presentBidGroupedSales(presented: any[]): any[] {
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
      items.push({ kind: 'bid_group', group: buildGroup(bid, [row]) });
    } else {
      const item = items[existing];
      if (item.kind !== 'bid_group') continue;
      item.group = buildGroup(bid, [...item.group.members, row]);
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

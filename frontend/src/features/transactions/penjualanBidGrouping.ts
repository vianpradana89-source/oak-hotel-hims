import type { OperationalSheet, TransactionRecord } from './transactionDomainTypes.ts';
import { formatReservationStayType, mapToOperationalStatus } from './transactionDomainTypes.ts';

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

export interface PenjualanBidGroup {
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
  primary: TransactionRecord;
  members: TransactionRecord[];
}

export type PenjualanListItem =
  | { kind: 'standalone'; tx: TransactionRecord }
  | { kind: 'bid_group'; group: PenjualanBidGroup };

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

export function isStandalonePenjualanSale(tx: Pick<TransactionRecord, 'source_type' | 'booking_bid'>): boolean {
  const source = String(tx.source_type || '').trim().toUpperCase();
  if (source === 'POS' || source === 'POS_ORDER') return true;
  return !canonicalBookingBid(tx);
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
    payment_status: derivePaymentStatus(paid, remaining, net),
    reservation_status: primary.reservation_status || null,
    operational_sheet: operationalSheetOf(primary)
  };
}

function buildGroup(bid: string, members: TransactionRecord[]): PenjualanBidGroup {
  const byChild = new Map<string, TransactionRecord[]>();
  for (const tx of members) {
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
    members
  };
}

export function groupPenjualanSaleRows(rows: TransactionRecord[]): PenjualanListItem[] {
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
    if (row.booking_bid_group && Array.isArray(row.booking_bid_group.children) && row.booking_bid_group.children.length > 0) {
      const payload = row.booking_bid_group;
      items.push({
        kind: 'bid_group',
        group: {
          bid: payload.bid,
          guest_name: payload.guest_name,
          room_count: payload.room_count,
          stay_type_label: payload.stay_type_label,
          gross: roundIdr(payload.gross),
          discount: roundIdr(payload.discount),
          net: roundIdr(payload.net),
          paid: roundIdr(payload.paid),
          remaining: roundIdr(payload.remaining),
          payment_status: derivePaymentStatus(roundIdr(payload.paid), roundIdr(payload.remaining), roundIdr(payload.net)),
          operational_sheet: payload.operational_sheet,
          children: payload.children.map((child) => ({
            ...child,
            payment_status: derivePaymentStatus(roundIdr(child.paid), roundIdr(child.remaining), roundIdr(child.net)),
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
      items.push({ kind: 'bid_group', group: buildGroup(bid, [row]) });
    } else {
      const item = items[existing];
      if (item.kind !== 'bid_group') continue;
      item.group = buildGroup(bid, [...item.group.members, row]);
    }
  }

  return items;
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

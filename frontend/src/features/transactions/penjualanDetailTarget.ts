import type { PenjualanBidChild, PenjualanListItem } from './penjualanBidGrouping.ts';

export type PenjualanDetailTarget =
  | { kind: 'booking'; bookingId: number | string }
  | { kind: 'transaction'; transactionId: number | string };

export function resolvePenjualanMainRowDetailTarget(item: PenjualanListItem): PenjualanDetailTarget {
  if (item.kind === 'bid_group') {
    const bookingId = item.group.booking_id ?? item.group.primary.booking_id ?? item.group.bid;
    return { kind: 'booking', bookingId };
  }
  return { kind: 'transaction', transactionId: item.tx.id };
}

export function resolvePenjualanChildDetailTarget(child: PenjualanBidChild): PenjualanDetailTarget {
  return { kind: 'transaction', transactionId: child.primary_transaction_id };
}

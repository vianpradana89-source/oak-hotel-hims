import assert from 'node:assert/strict';
import {
  deriveGroupOperationalSheet,
  derivePaymentStatus,
  groupPenjualanSaleRows,
  isStandalonePenjualanSale,
  stayTypeLabel
} from '../src/features/transactions/penjualanBidGrouping.ts';
import type { TransactionRecord } from '../src/features/transactions/transactionDomainTypes.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

function sale(partial: Partial<TransactionRecord> & { id: number }): TransactionRecord {
  return {
    property_id: 1,
    transaction_no: `TRX-${partial.id}`,
    transaction_date: '2026-09-07',
    transaction_time: '10:00:00',
    transaction_type: 'SALE',
    source_type: 'ROOM_CHARGE',
    source_id: null,
    source_reference: null,
    party_name: 'HADIRA NUR RAGAWAN',
    category_code: 'ROOM_SALES',
    category_name: 'Room Sales',
    department_code: 'FRONT_OFFICE',
    description: 'Room charge',
    amount: 0,
    discount_amount: 0,
    service_amount: 0,
    tax_amount: 0,
    net_amount: 0,
    payment_status: 'UNPAID',
    payment_method: 'CASH',
    transaction_status: 'POSTED',
    guest_id: null,
    guest_name_snapshot: 'HADIRA NUR RAGAWAN',
    room_number_snapshot: null,
    reservation_id: null,
    booking_id: 10,
    booking_bid: 'LWG-260907-79W91XS8',
    stay_type: 'OVERNIGHT',
    verification_status: 'UNVERIFIED',
    reversal_of_transaction_id: null,
    correction_group_id: null,
    notes: null,
    metadata: {},
    created_by: null,
    created_at: '2026-09-07T03:00:00.000Z',
    ...partial
  } as TransactionRecord;
}

console.log('=== OAK HIMS TRANSACTION-BID-GROUP-1 ===\n');

const room101 = sale({
  id: 1,
  reservation_id: 101,
  stay_sequence: 1,
  room_number_snapshot: '101',
  room_type_name: 'DELUXE KING',
  booked_room_type_name_snapshot: 'DELUXE KING',
  check_in: '2026-09-07',
  check_out: '2026-09-08',
  amount: 460000,
  discount_amount: 92000,
  net_amount: 368000,
  effective_net_amount: 368000,
  reservation_amount_paid: 368000,
  reservation_remaining_balance: 0,
  reservation_status: 'CHECKED_IN',
  reservation_stay_status: 'CHECKED_IN',
  operational_sheet: 'PROSES'
});

const room204 = sale({
  id: 2,
  reservation_id: 204,
  stay_sequence: 2,
  room_number_snapshot: '204',
  room_type_name: 'DELUXE TRIPLE',
  booked_room_type_name_snapshot: 'DELUXE TRIPLE',
  check_in: '2026-09-07',
  check_out: '2026-09-08',
  amount: 534000,
  discount_amount: 106800,
  net_amount: 427200,
  effective_net_amount: 427200,
  reservation_amount_paid: 92000,
  reservation_remaining_balance: 335200,
  reservation_status: 'CHECKED_IN',
  reservation_stay_status: 'CHECKED_IN',
  operational_sheet: 'PROSES',
  transaction_time: '10:05:00'
});

const extraOn101 = sale({
  id: 3,
  reservation_id: 101,
  stay_sequence: 1,
  source_type: 'EXTRA_BED',
  room_number_snapshot: '101',
  room_type_name: 'DELUXE KING',
  amount: 50000,
  discount_amount: 0,
  net_amount: 50000,
  effective_net_amount: 50000,
  reservation_amount_paid: 368000,
  reservation_remaining_balance: 0,
  operational_sheet: 'PROSES',
  transaction_time: '10:01:00'
});

const posSale = sale({
  id: 9,
  booking_bid: null,
  booking_id: null,
  reservation_id: null,
  source_type: 'POS_ORDER',
  party_name: 'Walk-in POS',
  guest_name_snapshot: 'Walk-in POS',
  amount: 90000,
  net_amount: 90000,
  effective_net_amount: 90000,
  payment_status: 'PAID',
  operational_sheet: 'SELESAI',
  stay_type: null
});

const grouped = groupPenjualanSaleRows([room204, extraOn101, room101, posSale]);

check(grouped.filter((item) => item.kind === 'bid_group').length === 1, 'A. two child reservations same BID => one grouped row');
const hadira = grouped.find((item) => item.kind === 'bid_group');
check(hadira?.kind === 'bid_group' && hadira.group.bid === 'LWG-260907-79W91XS8', 'A. grouped row uses canonical BID');
check(hadira?.kind === 'bid_group' && hadira.group.room_count === 2, 'B. badge count is 2 Kamar');
check(hadira?.kind === 'bid_group' && hadira.group.gross === 1044000, 'C. gross aggregates ROOM + extra + second room (460k+50k+534k)');
check(hadira?.kind === 'bid_group' && hadira.group.discount === 198800, 'C. discount aggregates 92k + 106.8k');

const hadiraCore = groupPenjualanSaleRows([room101, room204]);
check(hadiraCore.length === 1 && hadiraCore[0].kind === 'bid_group', 'A. core 2-room booking is one row');
if (hadiraCore[0].kind === 'bid_group') {
  check(hadiraCore[0].group.room_count === 2, 'B. 2 Kamar');
  check(hadiraCore[0].group.gross === 994000, 'C. gross 994000');
  check(hadiraCore[0].group.discount === 198800, 'C. discount 198800');
  check(hadiraCore[0].group.net === 795200, 'C. net 795200');
  check(hadiraCore[0].group.paid === 460000, 'D/M. paid 368k + 92k = 460000');
  check(hadiraCore[0].group.remaining === 335200, 'D/N. remaining 0 + 335200');
  check(hadiraCore[0].group.net - hadiraCore[0].group.paid === hadiraCore[0].group.remaining, 'D. Net - Paid = Remaining');
  check(hadiraCore[0].group.payment_status === 'PARTIAL', 'E. group payment PARTIAL');
  check(hadiraCore[0].group.children.length === 2, 'E. expand shows 2 child rows');
  const child101 = hadiraCore[0].group.children.find((child) => child.room_number === '101');
  const child204 = hadiraCore[0].group.children.find((child) => child.room_number === '204');
  check(Boolean(child101 && child204), 'E. children are rooms 101 and 204');
  check(child101?.paid === 368000 && child101?.remaining === 0 && child101?.payment_status === 'PAID', 'M. 101 paid 368k remaining 0 PAID');
  check(child204?.paid === 92000 && child204?.remaining === 335200 && child204?.payment_status === 'PARTIAL', 'M. 204 paid 92k remaining 335.2k PARTIAL');
  check(child101?.room_type_name === 'DELUXE KING', 'L. canonical room type DELUXE KING');
  check(child204?.room_type_name === 'DELUXE TRIPLE', 'L. canonical room type DELUXE TRIPLE');
}

const extrasGrouped = groupPenjualanSaleRows([room101, extraOn101]);
check(extrasGrouped.length === 1 && extrasGrouped[0].kind === 'bid_group', 'F. ROOM + extra still one group');
if (extrasGrouped[0].kind === 'bid_group') {
  check(extrasGrouped[0].group.room_count === 1, 'F. extra SALE does not add a room');
  check(extrasGrouped[0].group.children.length === 1, 'O. no duplicate child rows');
  check(extrasGrouped[0].group.children[0].gross === 510000, 'F. child gross includes extra');
  check(extrasGrouped[0].group.children[0].paid === 368000, 'F. paid is reservation paid once, not summed across SALE lines');
}

const single = groupPenjualanSaleRows([room101]);
check(single.length === 1 && single[0].kind === 'bid_group', 'G. single-room booking is still a grouped row');
check(single[0].kind === 'bid_group' && single[0].group.room_count === 1, 'G. badge 1 Kamar');
check(single[0].kind === 'bid_group' && single[0].group.children.length === 1, 'G. expand shows one child');

check(isStandalonePenjualanSale(posSale) === true, 'H. POS without BID is standalone');
const withPos = groupPenjualanSaleRows([room101, room204, posSale]);
check(withPos.length === 2, 'H. POS remains a peer standalone row');
check(withPos.some((item) => item.kind === 'standalone' && item.tx.id === 9), 'H. POS sale is not forced into the BID group');

const linkedPos = sale({
  id: 11,
  reservation_id: 101,
  stay_sequence: 1,
  source_type: 'POS',
  booking_id: 10,
  booking_bid: 'LWG-260907-79W91XS8',
  room_number_snapshot: '101',
  room_type_name: 'DELUXE KING',
  amount: 150000,
  net_amount: 150000,
  effective_net_amount: 150000,
  reservation_amount_paid: 368000,
  reservation_remaining_balance: 0,
  payment_status: 'PAID',
  operational_sheet: 'SELESAI'
});
check(isStandalonePenjualanSale(linkedPos) === false, 'P. linked POS with BID is not standalone');
const linkedGrouped = groupPenjualanSaleRows([room101, room204, linkedPos, posSale]);
check(linkedGrouped.length === 2, 'P/Q. linked POS joins BID; walk-in POS stays standalone');
const linkedBid = linkedGrouped.find((item) => item.kind === 'bid_group');
check(linkedBid?.kind === 'bid_group' && linkedBid.group.room_count === 2, 'P. linked POS does not add a fake room');
check(
  linkedBid?.kind === 'bid_group'
    && linkedBid.group.children.find((child) => child.reservation_id === 101)?.gross === 610000,
  'P. linked POS rolls into reservation child'
);
check(linkedBid?.kind === 'bid_group' && linkedBid.group.booking_id === 10, 'P. grouped payload exposes booking_id');

const searchRows = groupPenjualanSaleRows([room101, room204]);
check(searchRows.length === 1, 'I. search by BID returns one group');

const mixedStay = groupPenjualanSaleRows([
  room101,
  sale({ ...room204, stay_type: 'DAY_USE' })
]);
check(mixedStay[0].kind === 'bid_group' && mixedStay[0].group.stay_type_label === 'MIXED', 'stay type MIXED when children differ');
check(stayTypeLabel(['OVERNIGHT', 'OVERNIGHT']) === 'OVERNIGHT', 'shared overnight stay type');

const checkoutBoth = groupPenjualanSaleRows([
  sale({ ...room101, operational_sheet: 'SELESAI', reservation_status: 'CHECKED_OUT', reservation_stay_status: 'CHECKED_OUT' }),
  sale({ ...room204, operational_sheet: 'SELESAI', reservation_status: 'CHECKED_OUT', reservation_stay_status: 'CHECKED_OUT' })
]);
check(checkoutBoth[0].kind === 'bid_group' && checkoutBoth[0].group.operational_sheet === 'SELESAI', 'J. all checked-out => SELESAI');

const cancelledBoth = groupPenjualanSaleRows([
  sale({ ...room101, operational_sheet: 'BATAL', reservation_status: 'CANCELLED', reservation_stay_status: 'CANCELLED' }),
  sale({ ...room204, operational_sheet: 'BATAL', reservation_status: 'CANCELLED', reservation_stay_status: 'CANCELLED' })
]);
check(cancelledBoth[0].kind === 'bid_group' && cancelledBoth[0].group.operational_sheet === 'BATAL', 'J. all cancelled => BATAL');

const mixedOps = groupPenjualanSaleRows([
  sale({ ...room101, operational_sheet: 'SELESAI', reservation_status: 'CHECKED_OUT' }),
  sale({ ...room204, operational_sheet: 'PROSES', reservation_status: 'CHECKED_IN' })
]);
check(mixedOps[0].kind === 'bid_group' && mixedOps[0].group.operational_sheet === 'PROSES', 'J. mixed states => PROSES');
check(deriveGroupOperationalSheet(['SELESAI', 'PROSES']) === 'PROSES', 'J. mixed sheet aggregation');

const firstPass = groupPenjualanSaleRows([room204, room101, posSale]).map((item) =>
  item.kind === 'bid_group' ? item.group.bid : `standalone:${item.tx.id}`
);
const secondPass = groupPenjualanSaleRows([room204, room101, posSale]).map((item) =>
  item.kind === 'bid_group' ? item.group.bid : `standalone:${item.tx.id}`
);
check(JSON.stringify(firstPass) === JSON.stringify(secondPass), 'K. grouping order is stable across expand/collapse-equivalent reruns');

const staleName = groupPenjualanSaleRows([
  sale({
    ...room101,
    room_type_name: 'DELUXE KING',
    booked_room_type_name_snapshot: 'DELUXE KING'
  })
]);
check(
  staleName[0].kind === 'bid_group' && staleName[0].group.children[0].room_type_name === 'DELUXE KING',
  'L. child type uses canonical room_type_name, not rooms.name'
);

check(derivePaymentStatus(0, 0, 0) === 'PAID', 'zero-net remaining 0 is PAID');
check(derivePaymentStatus(0, 368000, 368000) === 'UNPAID', 'unpaid when paid 0 and remaining > 0');

const otherProperty = groupPenjualanSaleRows([
  room101,
  sale({ ...room204, property_id: 2, booking_bid: 'LWG-260907-79W91XS8' })
]);
check(otherProperty.filter((item) => item.kind === 'bid_group').length === 2, 'P/Q. same BID on another property stays isolated');

const duplicatePaidTrap = sale({
  ...room101,
  paid_amount: 368000,
  reservation_amount_paid: 368000,
  reservation_remaining_balance: 0
});
const extraPaidTrap = sale({
  ...extraOn101,
  paid_amount: 368000,
  reservation_amount_paid: 368000,
  reservation_remaining_balance: 0
});
const paidOnce = groupPenjualanSaleRows([duplicatePaidTrap, extraPaidTrap]);
check(paidOnce[0].kind === 'bid_group' && paidOnce[0].group.paid === 368000, 'S. paid is not summed from duplicated SALE-line paid_amount');

console.log(`\n=== ALL TRANSACTION BID GROUPING TESTS PASSED (${assertions} assertions) ===`);

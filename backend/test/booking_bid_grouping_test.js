'use strict';

const {
  presentBidGroupedSales,
  deriveGroupOperationalSheet,
  derivePaymentStatus,
  isStandalonePenjualanSale,
} = require('../dist/domains/transactions/bookingBidGrouping');

let assertions = 0;
function expect(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
}

function sale(partial) {
  return {
    property_id: 1,
    transaction_no: `TRX-${partial.id}`,
    transaction_date: '2026-09-07',
    transaction_time: '10:00:00',
    transaction_type: 'SALE',
    source_type: 'ROOM_CHARGE',
    party_name: 'HADIRA NUR RAGAWAN',
    guest_name_snapshot: 'HADIRA NUR RAGAWAN',
    amount: 0,
    discount_amount: 0,
    net_amount: 0,
    payment_status: 'UNPAID',
    transaction_status: 'POSTED',
    booking_bid: 'LWG-260907-79W91XS8',
    stay_type: 'OVERNIGHT',
    operational_sheet: 'PROSES',
    ...partial,
  };
}

const room101 = sale({
  id: 1,
  reservation_id: 101,
  stay_sequence: 1,
  room_number_snapshot: '101',
  room_type_name: 'DELUXE KING',
  check_in: '2026-09-07',
  check_out: '2026-09-08',
  amount: 460000,
  discount_amount: 92000,
  net_amount: 368000,
  effective_net_amount: 368000,
  reservation_amount_paid: 368000,
  reservation_remaining_balance: 0,
});
const room204 = sale({
  id: 2,
  reservation_id: 204,
  stay_sequence: 2,
  room_number_snapshot: '204',
  room_type_name: 'DELUXE TRIPLE',
  check_in: '2026-09-07',
  check_out: '2026-09-08',
  amount: 534000,
  discount_amount: 106800,
  net_amount: 427200,
  effective_net_amount: 427200,
  reservation_amount_paid: 92000,
  reservation_remaining_balance: 335200,
  transaction_time: '10:05:00',
});
const extra101 = sale({
  id: 3,
  reservation_id: 101,
  stay_sequence: 1,
  source_type: 'EXTRA_BED',
  room_number_snapshot: '101',
  room_type_name: 'DELUXE KING',
  amount: 50000,
  net_amount: 50000,
  effective_net_amount: 50000,
  reservation_amount_paid: 368000,
  reservation_remaining_balance: 0,
});
const pos = sale({
  id: 9,
  booking_bid: null,
  reservation_id: null,
  source_type: 'POS_ORDER',
  party_name: 'Walk-in POS',
  amount: 90000,
  net_amount: 90000,
  effective_net_amount: 90000,
  payment_status: 'PAID',
  operational_sheet: 'SELESAI',
});

const grouped = presentBidGroupedSales([room204, extra101, room101, pos]);
expect(grouped.length === 2, 'A/H. BID group + POS standalone');
const bidRow = grouped.find((row) => row.booking_bid_group);
const posRow = grouped.find((row) => Number(row.id) === 9);
expect(Boolean(bidRow && bidRow.booking_bid_group), 'A. BID group payload attached');
expect(bidRow.booking_bid_group.room_count === 2, 'B. 2 Kamar even with extra SALE');
expect(bidRow.booking_bid_group.children.length === 2, 'E/O. two unique rooms, extras collapsed');
expect(bidRow.booking_bid_group.paid === 460000, 'M. paid unique by reservation');
expect(posRow && !posRow.booking_bid_group, 'H. POS stays standalone');
expect(isStandalonePenjualanSale(pos) === true, 'H. POS detected as standalone');

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
  operational_sheet: 'SELESAI',
});
expect(isStandalonePenjualanSale(linkedPos) === false, 'P. linked POS with BID is not standalone');
const linkedGrouped = presentBidGroupedSales([room101, room204, linkedPos, pos]);
expect(linkedGrouped.length === 2, 'P/Q. linked POS joins BID; walk-in POS stays standalone');
const linkedBid = linkedGrouped.find((row) => row.booking_bid_group);
expect(linkedBid.booking_bid_group.room_count === 2, 'P. linked POS does not add a fake room');
expect(linkedBid.booking_bid_group.children.find((child) => child.reservation_id === 101).gross === 610000, 'P. linked POS rolls into reservation child');
expect(linkedBid.booking_bid_group.booking_id === 10, 'P. grouped payload exposes booking_id');

const linkedNoRoom = sale({
  id: 12,
  reservation_id: null,
  source_type: 'POS_ORDER',
  booking_id: 10,
  booking_bid: 'LWG-260907-79W91XS8',
  amount: 25000,
  net_amount: 25000,
  effective_net_amount: 25000,
  payment_status: 'PAID',
  paid_amount: 25000,
});
const noRoomGroup = presentBidGroupedSales([room101, linkedNoRoom])[0].booking_bid_group;
expect(noRoomGroup.room_count === 1, 'P. BID-linked POS without reservation is not a fake room');
expect(noRoomGroup.net === 393000, 'P. unattached linked POS still contributes to group net');

const core = presentBidGroupedSales([room101, room204])[0].booking_bid_group;
expect(core.gross === 994000, 'C. gross 994000');
expect(core.discount === 198800, 'C. discount 198800');
expect(core.net === 795200, 'C. net 795200');
expect(core.remaining === 335200, 'N. remaining 335200');
expect(core.net - core.paid === core.remaining, 'D. Net - Paid = Remaining');
expect(core.payment_status === 'PARTIAL', 'group PARTIAL');
expect(core.children[0].room_type_name === 'DELUXE KING', 'L. canonical type, not rooms.name');

const isolated = presentBidGroupedSales([
  room101,
  sale({ ...room204, property_id: 2 }),
]);
expect(isolated.length === 2, 'P/Q. same BID does not group across property_id');
expect(isolated.every((row) => row.booking_bid_group && row.booking_bid_group.children.length === 1), 'Q. each property keeps its own child');

expect(deriveGroupOperationalSheet(['BATAL', 'BATAL']) === 'BATAL', 'all BATAL');
expect(deriveGroupOperationalSheet(['SELESAI', 'PROSES']) === 'PROSES', 'mixed => PROSES');
expect(derivePaymentStatus(0, 0, 0) === 'PAID', 'zero-net PAID');

const originalNet = Number(room101.net_amount);
presentBidGroupedSales([room101, room204]);
expect(Number(room101.net_amount) === originalNet, 'R. grouping does not mutate source transaction nets');

console.log(`PASS | booking BID grouping | ${assertions} assertions`);

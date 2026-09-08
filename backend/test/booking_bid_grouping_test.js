'use strict';

const {
  presentBidGroupedSales,
  presentListWithSaleBidGrouping,
  deriveGroupOperationalSheet,
  derivePaymentStatus,
  deriveBookingPaymentStatus,
  isStandalonePenjualanSale,
  shouldShowListSettlementAmounts,
  reservationLifecycleSheet,
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

const periodRoomCharge = sale({
  id: 31,
  reservation_id: 101,
  stay_sequence: 1,
  transaction_date: '2026-09-07',
  source_type: 'ROOM_CHARGE',
  amount: 200000,
  net_amount: 200000,
  effective_net_amount: 200000,
  reservation_amount_paid: 700000,
  reservation_remaining_balance: 400000,
  reservation_status: 'BOOKED',
  reservation_stay_status: 'BOOKED',
  operational_sheet: 'PROSES',
});
const periodPos = sale({
  id: 32,
  reservation_id: 101,
  stay_sequence: 1,
  transaction_date: '2026-09-08',
  source_type: 'POS',
  amount: 100000,
  net_amount: 100000,
  effective_net_amount: 100000,
  reservation_amount_paid: 700000,
  reservation_remaining_balance: 400000,
  reservation_status: 'BOOKED',
  reservation_stay_status: 'BOOKED',
  operational_sheet: 'PROSES',
});
const periodLaundry = sale({
  id: 33,
  reservation_id: 101,
  stay_sequence: 1,
  transaction_date: '2026-09-09',
  source_type: 'LAUNDRY',
  amount: 50000,
  net_amount: 50000,
  effective_net_amount: 50000,
  reservation_amount_paid: 700000,
  reservation_remaining_balance: 400000,
  reservation_status: 'BOOKED',
  reservation_stay_status: 'BOOKED',
  operational_sheet: 'PROSES',
});
function inPeriod(rows, start, end) {
  return rows.filter((row) => String(row.transaction_date) >= start && String(row.transaction_date) <= end);
}
const lifetimeMembers = [periodRoomCharge, periodPos, periodLaundry];
const todayOnly = presentBidGroupedSales(inPeriod([periodRoomCharge], '2026-09-08', '2026-09-08'));
expect(todayOnly.length === 0, 'A. no Sep8 activity when only Sep7 exists');
const oneToday = presentBidGroupedSales(inPeriod([periodPos], '2026-09-08', '2026-09-08'));
expect(oneToday.length === 1 && oneToday[0].booking_bid_group, 'A. one BID one SALE today');
expect(oneToday[0].booking_bid_group.net === 100000, 'A. period net is the one SALE');
expect(oneToday[0].booking_bid_group.totals_scope === 'PERIOD_ACTIVITY', 'D. totals_scope is PERIOD_ACTIVITY');

const sep8Only = presentBidGroupedSales(inPeriod(lifetimeMembers, '2026-09-08', '2026-09-08'));
expect(sep8Only.length === 1, 'B/C. multi-date BID still one grouped row on Sep8');
expect(sep8Only[0].booking_bid_group.net === 100000, 'C. Sep8 returns only Sep8 activity');
expect(sep8Only[0].booking_bid_group.gross === 100000, 'D. Sep8 gross is period-scoped');
expect(sep8Only[0].booking_bid_group.room_count === 1, 'C. room_count is period children, not lifetime rooms outside period');
expect(sep8Only[0].booking_bid_group.net - sep8Only[0].booking_bid_group.paid !== sep8Only[0].booking_bid_group.remaining, 'T. period net minus lifetime paid is not remaining');
expect(shouldShowListSettlementAmounts(true) === false, 'T. grouped period row hides Paid/Sisa amounts');
expect(deriveBookingPaymentStatus(700000, 400000) === 'PARTIAL', 'T. payment badge stays booking settlement');

const searchPeriod = presentBidGroupedSales(inPeriod(lifetimeMembers.filter((row) => row.booking_bid.includes('79W91')), '2026-09-08', '2026-09-08'));
expect(searchPeriod[0].booking_bid_group.net === 100000, 'F. BID search + period does not inflate lifetime totals');

const bookedPaid = presentBidGroupedSales([
  sale({
    ...room101,
    reservation_status: 'BOOKED',
    reservation_stay_status: 'BOOKED',
    operational_sheet: 'PROSES',
    reservation_amount_paid: 368000,
    reservation_remaining_balance: 0,
    payment_status: 'PAID',
  }),
])[0].booking_bid_group;
expect(bookedPaid.operational_sheet === 'PROSES', 'G. BOOKED fully paid remains PROSES');
expect(bookedPaid.payment_status === 'PAID', 'G. payment badge PAID is separate from sheet');

const checkedInPaid = presentBidGroupedSales([
  sale({
    ...room101,
    reservation_status: 'CHECKED_IN',
    reservation_stay_status: 'CHECKED_IN',
    operational_sheet: 'PROSES',
    reservation_amount_paid: 368000,
    reservation_remaining_balance: 0,
    payment_status: 'PAID',
  }),
])[0].booking_bid_group;
expect(checkedInPaid.operational_sheet === 'PROSES', 'H. CHECKED_IN fully paid remains PROSES');

expect(deriveGroupOperationalSheet(['SELESAI', 'SELESAI']) === 'SELESAI', 'I. all CHECKED_OUT => SELESAI');
expect(deriveGroupOperationalSheet(['SELESAI', 'PROSES']) === 'PROSES', 'J. mixed child lifecycle => PROSES');
expect(deriveGroupOperationalSheet(['BATAL', 'BATAL']) === 'BATAL', 'K. all CANCELLED => BATAL');

const purchase = {
  id: 41,
  property_id: 1,
  transaction_type: 'PURCHASE',
  transaction_date: '2026-09-08',
  transaction_no: 'PUR-41',
  net_amount: 25000,
  booking_bid: 'LWG-260907-79W91XS8',
};
const expense = {
  id: 42,
  property_id: 1,
  transaction_type: 'EXPENSE',
  transaction_date: '2026-09-08',
  transaction_no: 'EXP-42',
  net_amount: 15000,
  booking_bid: 'LWG-260907-79W91XS8',
};
const income = {
  id: 43,
  property_id: 1,
  transaction_type: 'INCOME',
  transaction_date: '2026-09-08',
  transaction_no: 'INC-43',
  net_amount: 12000,
  booking_bid: null,
};
const allMixed = presentListWithSaleBidGrouping([room101, room204, linkedPos, pos, purchase, expense, income]);
expect(allMixed.length === 5, 'L-O. ALL emits 1 BID SALE + POS + PURCHASE + EXPENSE + INCOME');
expect(allMixed.filter((row) => row.booking_bid_group).length === 1, 'L. ALL groups booking-derived SALE by BID');
expect(allMixed.some((row) => Number(row.id) === 41 && !row.booking_bid_group), 'M. ALL leaves PURCHASE standalone');
expect(allMixed.some((row) => Number(row.id) === 42 && !row.booking_bid_group), 'N. ALL leaves EXPENSE standalone');
expect(allMixed.some((row) => Number(row.id) === 43 && !row.booking_bid_group), 'O. ALL leaves INCOME standalone');
expect(allMixed.some((row) => Number(row.id) === 9 && !row.booking_bid_group), 'Q. standalone POS stays standalone');
const allBid = allMixed.find((row) => row.booking_bid_group);
expect(allBid.booking_bid_group.member_transaction_ids.includes(11), 'P. linked POS SALE with BID joins group');
expect(allBid.booking_bid_group.member_transaction_ids.includes(1), 'L. room SALE joins same BID group');

const saleOnlyGrouped = presentBidGroupedSales([room101, room204, linkedPos, pos]);
const allOnlySales = presentListWithSaleBidGrouping([room101, room204, linkedPos, pos]);
expect(saleOnlyGrouped.length === allOnlySales.length, 'V. SALE-tab and ALL-tab SALE grouping count match');
expect(saleOnlyGrouped[0].booking_bid_group.net === allOnlySales.find((row) => row.booking_bid_group).booking_bid_group.net, 'V. frontend/backend-equivalent SALE totals match');

const mixedLifetime = [
  {
    property_id: 1,
    booking_id: 10,
    booking_bid: 'LWG-260907-79W91XS8',
    reservation_id: 101,
    reservation_status: 'CHECKED_OUT',
    reservation_stay_status: 'CHECKED_OUT',
  },
  {
    property_id: 1,
    booking_id: 10,
    booking_bid: 'LWG-260907-79W91XS8',
    reservation_id: 102,
    reservation_status: 'BOOKED',
    reservation_stay_status: 'BOOKED',
  },
  {
    property_id: 1,
    booking_id: 10,
    booking_bid: 'LWG-260907-79W91XS8',
    reservation_id: 103,
    reservation_status: 'CHECKED_IN',
    reservation_stay_status: 'CHECKED_IN',
  },
];
const periodCheckedOutOnly = sale({
  id: 81,
  booking_id: 10,
  reservation_id: 101,
  transaction_date: '2026-09-08',
  amount: 200000,
  discount_amount: 10000,
  net_amount: 190000,
  effective_net_amount: 190000,
  reservation_status: 'CHECKED_OUT',
  reservation_stay_status: 'CHECKED_OUT',
  operational_sheet: 'SELESAI',
  reservation_amount_paid: 190000,
  reservation_remaining_balance: 0,
  payment_status: 'PAID',
});
const mixedPeriod = presentBidGroupedSales([periodCheckedOutOnly], { lifecycleReservations: mixedLifetime });
expect(mixedPeriod[0].booking_bid_group.operational_sheet === 'PROSES', '3B1-A. mixed lifetime children stay PROSES');
expect(mixedPeriod[0].booking_bid_group.gross === 200000, '3B1-E. period gross unchanged');
expect(mixedPeriod[0].booking_bid_group.discount === 10000, '3B1-E. period discount unchanged');
expect(mixedPeriod[0].booking_bid_group.net === 190000, '3B1-E. period net unchanged');
expect(mixedPeriod[0].booking_bid_group.room_count === 1, '3B1-F. room_count stays period activity');
expect(mixedPeriod[0].booking_bid_group.payment_status === 'PAID', '3B1-D. payment badge stays separate');

const allCheckedOutLifetime = mixedLifetime.map((row) => ({
  ...row,
  reservation_status: 'CHECKED_OUT',
  reservation_stay_status: 'CHECKED_OUT',
}));
const allDone = presentBidGroupedSales([periodCheckedOutOnly], { lifecycleReservations: allCheckedOutLifetime });
expect(allDone[0].booking_bid_group.operational_sheet === 'SELESAI', '3B1-B. all lifetime CHECKED_OUT => SELESAI');
expect(allDone[0].booking_bid_group.net === 190000, '3B1-E. SELESAI booking keeps period net');

const allCancelledLifetime = mixedLifetime.map((row) => ({
  ...row,
  reservation_status: 'CANCELLED',
  reservation_stay_status: 'CANCELLED',
}));
const cancelledPeriod = sale({
  ...periodCheckedOutOnly,
  id: 82,
  reservation_status: 'CANCELLED',
  reservation_stay_status: 'CANCELLED',
  operational_sheet: 'BATAL',
});
const allBatal = presentBidGroupedSales([cancelledPeriod], { lifecycleReservations: allCancelledLifetime });
expect(allBatal[0].booking_bid_group.operational_sheet === 'BATAL', '3B1-C. all lifetime CANCELLED => BATAL');

const bookedPaidLifetime = [{
  property_id: 1,
  booking_id: 10,
  booking_bid: 'LWG-260907-79W91XS8',
  reservation_id: 101,
  reservation_status: 'BOOKED',
  reservation_stay_status: 'BOOKED',
}];
const bookedPaidPeriod = presentBidGroupedSales([
  sale({
    ...periodCheckedOutOnly,
    reservation_status: 'BOOKED',
    reservation_stay_status: 'BOOKED',
    operational_sheet: 'PROSES',
  }),
], { lifecycleReservations: bookedPaidLifetime });
expect(bookedPaidPeriod[0].booking_bid_group.operational_sheet === 'PROSES', '3B1-D. BOOKED fully paid => PROSES');

const searchOneChild = presentBidGroupedSales(
  [periodCheckedOutOnly],
  { lifecycleReservations: mixedLifetime }
);
expect(searchOneChild[0].booking_bid_group.operational_sheet === 'PROSES', '3B1-G. search/period one child still uses full booking sheet');
expect(searchOneChild[0].booking_bid_group.room_count === 1, '3B1-G. searched child does not inflate room_count');

const allMixedStatus = presentListWithSaleBidGrouping(
  [periodCheckedOutOnly, purchase, expense, income],
  { lifecycleReservations: mixedLifetime }
);
const allGroupedSale = allMixedStatus.find((row) => row.booking_bid_group);
expect(allGroupedSale.booking_bid_group.operational_sheet === 'PROSES', '3B1-H. ALL grouped SALE uses full booking sheet');
expect(allMixedStatus.some((row) => Number(row.id) === 41 && !row.booking_bid_group), '3B1-H. ALL non-SALE stays standalone');

const otherPropertyLifetime = [{
  property_id: 2,
  booking_id: 99,
  booking_bid: 'LWG-260907-79W91XS8',
  reservation_id: 201,
  reservation_status: 'CHECKED_OUT',
  reservation_stay_status: 'CHECKED_OUT',
}];
const propertyLeak = presentBidGroupedSales(
  [periodCheckedOutOnly],
  { lifecycleReservations: [...mixedLifetime, ...otherPropertyLifetime] }
);
expect(propertyLeak[0].booking_bid_group.operational_sheet === 'PROSES', '3B1-I. other-property CHECKED_OUT does not force SELESAI');
const otherPropertySale = presentBidGroupedSales(
  [sale({ ...periodCheckedOutOnly, id: 91, property_id: 2, booking_id: 99, reservation_id: 201 })],
  { lifecycleReservations: [...mixedLifetime, ...otherPropertyLifetime] }
);
expect(otherPropertySale[0].booking_bid_group.operational_sheet === 'SELESAI', '3B1-I. same BID other property keeps its own lifecycle');

expect(reservationLifecycleSheet({
  reservation_id: 1,
  reservation_status: 'CHECKED_OUT',
  reservation_stay_status: 'CHECKED_OUT',
}) === 'SELESAI', '3B1-J. reservation CHECKED_OUT maps SELESAI');
expect(reservationLifecycleSheet({
  reservation_id: 2,
  reservation_status: 'BOOKED',
  reservation_stay_status: 'BOOKED',
}) === 'PROSES', '3B1-J. reservation BOOKED maps PROSES');

console.log(`PASS | booking BID grouping | ${assertions} assertions`);

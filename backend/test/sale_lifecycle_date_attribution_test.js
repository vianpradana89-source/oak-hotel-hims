'use strict';

const {
  groupSaleLifecycles,
  presentLifecyclePrimary,
  isLifecyclePrimaryInPeriod,
  hotelDateOf,
} = require('../dist/domains/transactions/saleLifecycleGrouping');
const {
  presentBidGroupedSales,
  presentListWithSaleBidGrouping,
  shouldShowListSettlementAmounts,
} = require('../dist/domains/transactions/bookingBidGrouping');
const {
  isChargeToRoomDoubleRevenue,
  shouldSkipFolioKeyedPosSale,
  isStandalonePosSale,
  linkedPosJoinsBooking,
  paidAtPosHasNoFolioOutstanding,
  saleIdentityKey,
  findDuplicateSaleIdentities,
  CHARGE_TO_ROOM_SALE_INVARIANT,
  explicitPosOrderIdFromFolioEntry,
} = require('../dist/domains/transactions/saleSourceIdentity');
const { assembleBookingSalesDetail } = require('../dist/domains/transactions/bookingSalesDetail');

let assertions = 0;
function expect(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
}

function tx(partial) {
  return {
    property_id: 1,
    transaction_type: 'SALE',
    source_type: 'ROOM_CHARGE',
    transaction_status: 'POSTED',
    amount: 300000,
    discount_amount: 0,
    net_amount: 300000,
    ...partial,
  };
}

const original = tx({
  id: 94,
  transaction_no: 'TRX-94',
  transaction_date: '2026-09-07',
  transaction_time: '10:00:00',
  transaction_status: 'VOIDED',
  reservation_id: 101,
  booking_id: 10,
  booking_bid: 'BID-3C',
  correction_group_id: 'corr_94',
});
const reversal = tx({
  id: 95,
  transaction_no: 'TRX-95',
  transaction_date: '2026-09-08',
  transaction_time: '09:00:00',
  transaction_status: 'REVERSED',
  net_amount: -300000,
  amount: -300000,
  reservation_id: 101,
  booking_id: 10,
  booking_bid: 'BID-3C',
  reversal_of_transaction_id: 94,
  correction_group_id: 'corr_94',
});
const replacement = tx({
  id: 96,
  transaction_no: 'TRX-96',
  transaction_date: '2026-09-08',
  transaction_time: '09:05:00',
  reservation_id: 101,
  booking_id: 10,
  booking_bid: 'BID-3C',
  correction_group_id: 'corr_94',
  source_id: 'CORR-850',
  metadata: { correction_kind: 'SALE_PROJECTION_REPLACEMENT', restored_from_transaction_id: 94 },
});

expect(hotelDateOf('2026-09-07T00:00:00.000Z') === '2026-09-07', 'hotelDateOf reads ISO date');
expect(hotelDateOf(new Date('2026-09-07T17:00:00.000Z')) === '2026-09-08', 'hotelDateOf uses Asia/Jakarta for Date values');
expect(isLifecyclePrimaryInPeriod('2026-09-08', '2026-09-07', '2026-09-07') === false, 'A. primary Sep8 not in Sep7');
expect(isLifecyclePrimaryInPeriod('2026-09-08', '2026-09-08', '2026-09-08') === true, 'A. primary Sep8 in Sep8');

const corrected = groupSaleLifecycles([original, reversal, replacement]);
expect(corrected.length === 1, 'A. one lifecycle');
expect(Number(corrected[0].primary.id) === 96, 'A. presented primary is replacement');
expect(corrected[0].effectiveNet === 300000, 'A. effective net is replacement, not original+replacement');
expect(isLifecyclePrimaryInPeriod(corrected[0].primary.transaction_date, '2026-09-07', '2026-09-07') === false, 'A. Sep7 excludes corrected sale');
expect(isLifecyclePrimaryInPeriod(corrected[0].primary.transaction_date, '2026-09-08', '2026-09-08') === true, 'A. Sep8 includes corrected sale');
expect(isLifecyclePrimaryInPeriod(corrected[0].primary.transaction_date, '2026-09-07', '2026-09-08') === true, 'A. combined range still one economic activity');

const presented = [presentLifecyclePrimary(corrected[0])];
const sep7 = presented.filter((row) => isLifecyclePrimaryInPeriod(row.transaction_date, '2026-09-07', '2026-09-07'));
const sep8 = presented.filter((row) => isLifecyclePrimaryInPeriod(row.transaction_date, '2026-09-08', '2026-09-08'));
expect(sep7.length === 0, 'A. Sep7 list has no corrected row');
expect(sep8.length === 1, 'A. Sep8 list has exactly one effective sale');

const reversalOnly = groupSaleLifecycles([original, reversal]);
expect(reversalOnly.length === 1, 'B. reversal-only is one lifecycle');
expect(reversalOnly[0].effectiveNet === 0, 'B. no phantom positive revenue');
expect(Number(reversalOnly[0].primary.id) === 95, 'B. primary is the reversal');

const sameDay = groupSaleLifecycles([
  { ...original, transaction_date: '2026-09-08' },
  { ...reversal, transaction_date: '2026-09-08' },
  replacement,
]);
expect(sameDay.length === 1 && Number(sameDay[0].primary.id) === 96, 'C. same-date correction is one presented row');

const secondCorrection = tx({
  id: 97,
  transaction_date: '2026-09-09',
  transaction_time: '11:00:00',
  reservation_id: 101,
  booking_id: 10,
  booking_bid: 'BID-3C',
  correction_group_id: 'corr_94',
  net_amount: 280000,
  amount: 280000,
  source_id: 'CORR-851',
  metadata: { correction_kind: 'SALE_PROJECTION_REPLACEMENT', restored_from_transaction_id: 94 },
});
const multi = groupSaleLifecycles([original, reversal, replacement, secondCorrection]);
expect(multi.length === 1, 'D. multiple corrections stay one lifecycle');
expect(Number(multi[0].primary.id) === 97, 'D. latest posted correction is primary');

const periodPos = tx({
  id: 32,
  transaction_date: '2026-09-08',
  source_type: 'POS',
  booking_bid: 'BID-3C',
  booking_id: 10,
  reservation_id: 101,
  amount: 100000,
  net_amount: 100000,
  effective_net_amount: 100000,
  operational_sheet: 'PROSES',
});
const groupedPeriod = presentBidGroupedSales([periodPos], {
  lifecycleReservations: [
    { property_id: 1, booking_id: 10, booking_bid: 'BID-3C', reservation_id: 101, reservation_status: 'CHECKED_OUT', reservation_stay_status: 'CHECKED_OUT' },
    { property_id: 1, booking_id: 10, booking_bid: 'BID-3C', reservation_id: 102, reservation_status: 'BOOKED', reservation_stay_status: 'BOOKED' },
  ],
});
expect(groupedPeriod[0].booking_bid_group.net === 100000, 'E. period net unchanged');
expect(groupedPeriod[0].booking_bid_group.operational_sheet === 'PROSES', 'F. mixed lifetime sheet PROSES');
expect(groupedPeriod[0].booking_bid_group.room_count === 1, 'G. period room_count activity-only');
expect(shouldShowListSettlementAmounts(true) === false, 'H. grouped Paid/Sisa hidden');

const allMixed = presentListWithSaleBidGrouping([
  periodPos,
  { id: 41, property_id: 1, transaction_type: 'PURCHASE', net_amount: 1, booking_bid: 'BID-3C' },
  { id: 42, property_id: 1, transaction_type: 'EXPENSE', net_amount: 1 },
  { id: 43, property_id: 1, transaction_type: 'INCOME', net_amount: 1 },
]);
expect(allMixed.filter((row) => row.booking_bid_group).length === 1, 'J. ALL SALE groups');
expect(allMixed.some((row) => Number(row.id) === 41 && !row.booking_bid_group), 'K. PURCHASE standalone');

expect(isStandalonePosSale({ source_type: 'POS_ORDER', booking_bid: null }) === true, 'V. standalone POS');
expect(linkedPosJoinsBooking({ source_type: 'POS', booking_bid: 'BID-3C' }) === true, 'U. linked POS joins BID');
expect(paidAtPosHasNoFolioOutstanding({ paidAtPos: true, folioRemaining: 0 }) === true, 'U. paid-at-POS no folio outstanding');
expect(saleIdentityKey(1, 'POS', 'POS-1') !== saleIdentityKey(1, 'POS', '9901'), 'W. POS id != folio id');
expect(findDuplicateSaleIdentities([
  { property_id: 1, source_type: 'POS', source_id: 'POS-1' },
  { property_id: 1, source_type: 'POS', source_id: 'POS-1' },
]).length === 1, 'idempotent identity detects duplicate POS projection');
expect(isChargeToRoomDoubleRevenue({
  propertyId: 1,
  posSourceType: 'POS',
  posSourceId: 'POS-1',
  folioEntryId: '9901',
  projectedSales: [
    { property_id: 1, source_type: 'POS', source_id: 'POS-1' },
    { property_id: 1, source_type: 'POS_ROOM_CHARGE', source_id: '9901' },
  ],
}) === true, 'W. Charge-to-Room dual SALE is rejected by contract');
expect(shouldSkipFolioKeyedPosSale({
  propertyId: 1,
  chargeSourceType: 'POS_ROOM_CHARGE',
  folioEntryId: 9901,
  posOrderId: 'POS-1',
  existingSales: [{ property_id: 1, source_type: 'POS', source_id: 'POS-1' }],
}).skip === true, 'W. folio-keyed POS SALE skipped when economic SALE exists');
expect(shouldSkipFolioKeyedPosSale({
  propertyId: 1,
  chargeSourceType: 'POS_ROOM_CHARGE',
  folioEntryId: 9901,
  posOrderId: 'POS-1',
  existingSales: [{ property_id: 1, source_type: 'POS', source_id: 'POS-2' }],
}).skip === false, 'P. different POS order is not deduped');
expect(shouldSkipFolioKeyedPosSale({
  propertyId: 1,
  chargeSourceType: 'POS_ROOM_CHARGE',
  folioEntryId: 9901,
  posOrderId: '',
  existingSales: [{ property_id: 1, source_type: 'POS', source_id: 'POS-1' }],
}).skip === false, 'R. no explicit POS order identity does not guess');
expect(shouldSkipFolioKeyedPosSale({
  propertyId: 1,
  chargeSourceType: 'ROOM_CHARGE',
  folioEntryId: 850,
  posOrderId: 'POS-1',
  existingSales: [{ property_id: 1, source_type: 'POS', source_id: 'POS-1' }],
}).skip === false, 'S. ROOM_CHARGE unaffected');
expect(shouldSkipFolioKeyedPosSale({
  propertyId: 1,
  chargeSourceType: 'LAUNDRY',
  folioEntryId: 860,
  posOrderId: 'POS-1',
  existingSales: [{ property_id: 1, source_type: 'POS', source_id: 'POS-1' }],
}).skip === false, 'T. LAUNDRY unaffected');
expect(shouldSkipFolioKeyedPosSale({
  propertyId: 1,
  chargeSourceType: 'EXTRA_BED',
  folioEntryId: 870,
  posOrderId: 'POS-1',
  existingSales: [{ property_id: 1, source_type: 'POS', source_id: 'POS-1' }],
}).skip === false, 'U. EXTRA_BED unaffected');
expect(shouldSkipFolioKeyedPosSale({
  propertyId: 2,
  chargeSourceType: 'POS_ROOM_CHARGE',
  folioEntryId: 9901,
  posOrderId: 'POS-1',
  existingSales: [{ property_id: 1, source_type: 'POS', source_id: 'POS-1' }],
}).skip === false, 'W. same POS source different property never cross-dedupes');
expect(explicitPosOrderIdFromFolioEntry({
  id: 9901,
  source_type: 'POS_ROOM_CHARGE',
  source_id: '9901',
}) === null, 'R. folio id as source_id is not a POS order identity');
expect(explicitPosOrderIdFromFolioEntry({
  id: 9901,
  source_type: 'POS',
  source_id: 'POS-1',
}) === 'POS-1', 'N. POS source_id distinct from folio id is explicit identity');
expect(CHARGE_TO_ROOM_SALE_INVARIANT.includes('PAYMENT: settlement only'), 'T. payment is not revenue');

const booking = {
  id: 10,
  bid: 'BID-3C',
  property_id: 1,
  guest_name_snapshot: 'TAMU',
  booker_name: null,
  booking_source: 'WALKIN',
  channel: 'WALKIN',
  booking_status: 'ACTIVE',
};
const reservations = [
  {
    id: 101,
    room_id: 1,
    room_number: '101',
    room_type_name: 'DELUXE KING',
    stay_sequence: 1,
    stay_type: 'OVERNIGHT',
    check_in: '2026-09-07',
    check_out: '2026-09-08',
    status: 'CHECKED_IN',
    stay_status: 'CHECKED_IN',
    amount_paid: 200000,
    remaining_balance: 168000,
  },
  {
    id: 204,
    room_id: 2,
    room_number: '204',
    room_type_name: 'DELUXE TRIPLE',
    stay_sequence: 2,
    stay_type: 'OVERNIGHT',
    check_in: '2026-09-07',
    check_out: '2026-09-08',
    status: 'BOOKED',
    stay_status: 'BOOKED',
    amount_paid: 92000,
    remaining_balance: 335200,
  },
];
const sales = [
  {
    id: 1,
    property_id: 1,
    transaction_type: 'SALE',
    source_type: 'ROOM_CHARGE',
    source_id: '1',
    amount: 368000,
    discount_amount: 0,
    net_amount: 368000,
    payment_status: 'PARTIAL',
    transaction_status: 'POSTED',
    reservation_id: 101,
    booking_id: 10,
  },
  {
    id: 2,
    property_id: 1,
    transaction_type: 'SALE',
    source_type: 'EXTRA_BED',
    source_id: '2',
    amount: 50000,
    discount_amount: 0,
    net_amount: 50000,
    payment_status: 'UNPAID',
    transaction_status: 'POSTED',
    reservation_id: 101,
    booking_id: 10,
  },
  {
    id: 3,
    property_id: 1,
    transaction_type: 'SALE',
    source_type: 'ROOM_CHARGE',
    source_id: '3',
    amount: 427200,
    discount_amount: 0,
    net_amount: 427200,
    payment_status: 'PARTIAL',
    transaction_status: 'POSTED',
    reservation_id: 204,
    booking_id: 10,
  },
];
const payments = [
  { id: 11, reservation_id: 101, transaction_id: 1, method: 'CASH', amount: 200000, status: 'SUCCESS', created_at: '2026-09-07', reference: 'P1', evidence_reference: null },
  { id: 12, reservation_id: 204, transaction_id: 3, method: 'CASH', amount: 92000, status: 'SUCCESS', created_at: '2026-09-08', reference: 'P2', evidence_reference: null },
];
const detail = assembleBookingSalesDetail({
  booking,
  reservations,
  sales,
  payments,
});
expect(detail.financial.net === 845200, 'Q/R. lifetime net is sum of SALE nets');
expect(detail.financial.paid === 292000, 'R. paid is reservation rollup, not multiplied by SALE sources');
expect(detail.children.find((child) => child.reservation_id === 101).paid === 200000, 'Q. room 101 paid once');
expect(detail.payments.length === 2, 'S. later payment remains a payment row');
expect(detail.payments.reduce((sum, row) => sum + row.amount, 0) === 292000, 'T. payments are settlement not extra revenue');

const isolated = presentBidGroupedSales([
  { ...periodPos, property_id: 1 },
  { ...periodPos, id: 99, property_id: 2 },
]);
expect(isolated.length === 2, 'X. same BID different property does not merge');

console.log(`PASS | SALES-3C unit | ${assertions} assertions`);

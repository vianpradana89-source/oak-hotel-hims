import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hotelDateFromInstant } from '../src/features/calendar/calendarDates.ts';
import {
  deriveBookingPaymentStatus,
  deriveGroupOperationalSheet,
  flattenAllTabRows,
  groupAllTabRows,
  groupPenjualanSaleRows,
  isPeriodActivityGroup,
  reservationLifecycleSheet,
  shouldShowListSettlementAmounts,
} from '../src/features/transactions/penjualanBidGrouping.ts';
import { getPenjualanPeriodPresetRange } from '../src/features/transactions/transactionPeriodHelpers.ts';
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

function other(partial: Partial<TransactionRecord> & { id: number; transaction_type: 'PURCHASE' | 'EXPENSE' | 'INCOME' }): TransactionRecord {
  return sale({
    booking_id: null,
    booking_bid: null,
    reservation_id: null,
    source_type: `MANUAL_${partial.transaction_type}`,
    party_name: partial.transaction_type,
    ...partial
  });
}

function inPeriod(rows: TransactionRecord[], start: string, end: string): TransactionRecord[] {
  return rows.filter((row) => String(row.transaction_date) >= start && String(row.transaction_date) <= end);
}

console.log('=== OAK HIMS TRANSACTION-SALES-3B ===\n');

const sep7 = sale({
  id: 31,
  reservation_id: 101,
  stay_sequence: 1,
  transaction_date: '2026-09-07',
  room_number_snapshot: '101',
  amount: 200000,
  net_amount: 200000,
  effective_net_amount: 200000,
  reservation_amount_paid: 700000,
  reservation_remaining_balance: 400000,
  reservation_status: 'BOOKED',
  operational_sheet: 'PROSES'
});
const sep8 = sale({
  id: 32,
  reservation_id: 101,
  stay_sequence: 1,
  transaction_date: '2026-09-08',
  source_type: 'POS',
  room_number_snapshot: '101',
  amount: 100000,
  net_amount: 100000,
  effective_net_amount: 100000,
  reservation_amount_paid: 700000,
  reservation_remaining_balance: 400000,
  reservation_status: 'BOOKED',
  operational_sheet: 'PROSES'
});
const sep9 = sale({
  id: 33,
  reservation_id: 101,
  stay_sequence: 1,
  transaction_date: '2026-09-09',
  source_type: 'LAUNDRY',
  room_number_snapshot: '101',
  amount: 50000,
  net_amount: 50000,
  effective_net_amount: 50000,
  reservation_amount_paid: 700000,
  reservation_remaining_balance: 400000,
  reservation_status: 'BOOKED',
  operational_sheet: 'PROSES'
});

const oneToday = groupPenjualanSaleRows(inPeriod([sep8], '2026-09-08', '2026-09-08'));
check(oneToday.length === 1 && oneToday[0].kind === 'bid_group', 'A. one BID, one SALE today');
check(oneToday[0].kind === 'bid_group' && oneToday[0].group.net === 100000, 'A. period net is the one SALE');

const multiDate = [sep7, sep8, sep9];
const sep8Items = groupPenjualanSaleRows(inPeriod(multiDate, '2026-09-08', '2026-09-08'));
check(sep8Items.length === 1 && sep8Items[0].kind === 'bid_group', 'B/C. Sep8 still one BID row');
if (sep8Items[0].kind === 'bid_group') {
  check(sep8Items[0].group.net === 100000, 'C. Sep8 returns only Sep8 activity');
  check(sep8Items[0].group.gross === 100000, 'D. Sep8 totals are period-scoped');
  check(isPeriodActivityGroup(sep8Items[0].group), 'D. totals_scope PERIOD_ACTIVITY');
  check(sep8Items[0].group.room_count === 1, 'room_count is period reservation children');
  check(shouldShowListSettlementAmounts(sep8Items[0]) === false, 'T. grouped row hides Paid/Sisa amounts');
  check(sep8Items[0].group.net - sep8Items[0].group.paid !== sep8Items[0].group.remaining, 'T. no false period arithmetic');
  check(sep8Items[0].group.payment_status === 'PARTIAL', 'T. badge stays booking settlement');
}

const lifetimeItems = groupPenjualanSaleRows(multiDate);
check(lifetimeItems[0].kind === 'bid_group' && lifetimeItems[0].group.net === 350000, 'E. lifetime grouping still contains Sep7+Sep8+Sep9');

const searchPeriod = groupPenjualanSaleRows(inPeriod(multiDate.filter((row) => String(row.booking_bid).includes('79W91')), '2026-09-08', '2026-09-08'));
check(searchPeriod[0].kind === 'bid_group' && searchPeriod[0].group.net === 100000, 'F. BID search + period does not inflate lifetime totals');

const bookedPaid = groupPenjualanSaleRows([
  sale({
    id: 61,
    reservation_id: 101,
    reservation_status: 'BOOKED',
    reservation_stay_status: 'BOOKED',
    operational_sheet: 'PROSES',
    reservation_amount_paid: 368000,
    reservation_remaining_balance: 0,
    payment_status: 'PAID',
    amount: 368000,
    net_amount: 368000,
    effective_net_amount: 368000
  })
]);
check(bookedPaid[0].kind === 'bid_group' && bookedPaid[0].group.operational_sheet === 'PROSES', 'G. BOOKED fully paid = PROSES');
check(bookedPaid[0].kind === 'bid_group' && bookedPaid[0].group.payment_status === 'PAID', 'G. payment badge remains PAID');

const checkedInPaid = groupPenjualanSaleRows([
  sale({
    id: 62,
    reservation_id: 101,
    reservation_status: 'CHECKED_IN',
    reservation_stay_status: 'CHECKED_IN',
    operational_sheet: 'PROSES',
    reservation_amount_paid: 368000,
    reservation_remaining_balance: 0,
    amount: 368000,
    net_amount: 368000,
    effective_net_amount: 368000
  })
]);
check(checkedInPaid[0].kind === 'bid_group' && checkedInPaid[0].group.operational_sheet === 'PROSES', 'H. CHECKED_IN fully paid = PROSES');

check(deriveGroupOperationalSheet(['SELESAI', 'SELESAI']) === 'SELESAI', 'I. all CHECKED_OUT = SELESAI');
check(deriveGroupOperationalSheet(['SELESAI', 'PROSES']) === 'PROSES', 'J. mixed child lifecycle = PROSES');
check(deriveGroupOperationalSheet(['BATAL', 'BATAL']) === 'BATAL', 'K. all CANCELLED = BATAL');

const room101 = sale({
  id: 1,
  reservation_id: 101,
  stay_sequence: 1,
  room_number_snapshot: '101',
  amount: 368000,
  net_amount: 368000,
  effective_net_amount: 368000,
  operational_sheet: 'PROSES'
});
const linkedPos = sale({
  id: 11,
  reservation_id: 101,
  source_type: 'POS',
  amount: 150000,
  net_amount: 150000,
  effective_net_amount: 150000
});
const walkInPos = sale({
  id: 9,
  booking_id: null,
  booking_bid: null,
  reservation_id: null,
  source_type: 'POS_ORDER',
  party_name: 'Walk-in POS',
  amount: 90000,
  net_amount: 90000,
  effective_net_amount: 90000,
  operational_sheet: 'SELESAI'
});
const purchase = other({ id: 41, transaction_type: 'PURCHASE', amount: 25000, net_amount: 25000 });
const expense = other({ id: 42, transaction_type: 'EXPENSE', amount: 15000, net_amount: 15000 });
const income = other({ id: 43, transaction_type: 'INCOME', amount: 12000, net_amount: 12000 });

const allItems = groupAllTabRows([room101, linkedPos, walkInPos, purchase, expense, income]);
check(allItems.filter((item) => item.kind === 'bid_group').length === 1, 'L. ALL tab groups booking-derived SALE by BID');
check(allItems.some((item) => item.kind === 'other' && item.tx.id === 41), 'M. ALL leaves PURCHASE standalone');
check(allItems.some((item) => item.kind === 'other' && item.tx.id === 42), 'N. ALL leaves EXPENSE standalone');
check(allItems.some((item) => item.kind === 'other' && item.tx.id === 43), 'O. ALL leaves INCOME standalone');
const allBid = allItems.find((item) => item.kind === 'bid_group');
check(allBid?.kind === 'bid_group' && allBid.group.member_transaction_ids.includes(11), 'P. linked POS SALE with BID can join group');
check(allItems.some((item) => item.kind === 'standalone' && item.tx.id === 9), 'Q. standalone POS stays standalone');
check(allItems.length === 5, 'L-O. ALL pagination emits 1 BID + POS + 3 non-SALE');

const isolated = groupPenjualanSaleRows([
  room101,
  sale({ ...room101, id: 77, property_id: 2 })
]);
check(isolated.filter((item) => item.kind === 'bid_group').length === 2, 'R. same BID different property never merges');

check(hotelDateFromInstant(new Date('2026-09-07T17:00:00.000Z')) === '2026-09-08', 'S. 17:00 UTC is hotel Sep 8');
check(hotelDateFromInstant(new Date('2026-09-07T16:59:00.000Z')) === '2026-09-07', 'S. 16:59 UTC is still hotel Sep 7');
const nearMidnight = getPenjualanPeriodPresetRange('today', new Date('2026-09-07T17:00:00.000Z'));
check(nearMidnight.start === '2026-09-08' && nearMidnight.end === '2026-09-08', 'S. Hari Ini uses property business date');
const stillSep7 = getPenjualanPeriodPresetRange('today', new Date('2026-09-07T16:59:00.000Z'));
check(stillSep7.start === '2026-09-07' && stillSep7.end === '2026-09-07', 'S. before Jakarta midnight stays Sep 7');
const thisMonth = getPenjualanPeriodPresetRange('this_month', new Date('2026-09-07T17:00:00.000Z'));
check(thisMonth.start === '2026-09-01' && thisMonth.end === '2026-09-30', 'S. Bulan Ini uses hotel month');
const allTime = getPenjualanPeriodPresetRange('all_time', new Date('2026-09-07T17:00:00.000Z'));
check(allTime.start === '' && allTime.end === '', 'S. All Time stays unscoped');

const payloadCopy = groupPenjualanSaleRows([
  {
    ...sep8,
    booking_bid_group: {
      bid: 'LWG-260907-79W91XS8',
      booking_id: 10,
      guest_name: 'HADIRA NUR RAGAWAN',
      room_count: 1,
      stay_type_label: 'OVERNIGHT',
      totals_scope: 'PERIOD_ACTIVITY',
      member_transaction_ids: [32],
      gross: 100000,
      discount: 0,
      net: 100000,
      paid: 700000,
      remaining: 400000,
      payment_status: 'PARTIAL',
      operational_sheet: 'PROSES',
      children: [
        {
          reservation_id: 101,
          primary_transaction_id: 32,
          room_number: '101',
          room_type_name: 'DELUXE KING',
          check_in: '2026-09-07',
          check_out: '2026-09-08',
          stay_type: 'OVERNIGHT',
          stay_sequence: 1,
          gross: 100000,
          discount: 0,
          net: 100000,
          paid: 700000,
          remaining: 400000,
          payment_status: 'PARTIAL',
          reservation_status: 'BOOKED',
          operational_sheet: 'PROSES'
        }
      ]
    }
  }
]);
check(payloadCopy[0].kind === 'bid_group' && payloadCopy[0].group.net === 100000, 'V. frontend copies backend period net');
check(payloadCopy[0].kind === 'bid_group' && payloadCopy[0].group.payment_status === 'PARTIAL', 'V. frontend does not recompute badge from period net');
check(payloadCopy[0].kind === 'bid_group' && shouldShowListSettlementAmounts(payloadCopy[0]) === false, 'V. grouping parity keeps settlement amounts hidden');

const flattened = flattenAllTabRows(allItems);
check(flattened.filter((row) => row.booking_bid_group).length === 1, 'V. ALL flatten emits one BID payload');
check(flattened.some((row) => row.transaction_type === 'PURCHASE' && !row.booking_bid_group), 'V. ALL flatten leaves PURCHASE ungrouped');

check(deriveBookingPaymentStatus(700000, 400000) === 'PARTIAL', 'T. settlement badge ignores period net');
check(deriveBookingPaymentStatus(700000, 0) === 'PAID', 'T. remaining 0 is PAID even if period net is smaller');

const here = dirname(fileURLToPath(import.meta.url));
const workspaceSrc = readFileSync(join(here, '../src/features/transactions/TransactionWorkspace.tsx'), 'utf8');
const drawerSrc = readFileSync(join(here, '../src/features/transactions/BookingSalesDetailDrawer.tsx'), 'utf8');
const clientSrc = readFileSync(join(here, '../src/features/transactions/transactionClient.ts'), 'utf8');
check(workspaceSrc.includes('getPenjualanPeriodPresetRange'), 'S. workspace uses hotel-date presets');
check(!workspaceSrc.includes('now.getFullYear()'), 'S. workspace no longer uses browser-local month math');
check(workspaceSrc.includes('Aktivitas Periode'), 'D. period list is labeled Aktivitas Periode');
check(workspaceSrc.includes('kamar aktivitas'), 'room_count label is period activity rooms');
check(workspaceSrc.includes('groupAllTabRows'), 'L. ALL tab uses SALE BID grouping');
check(workspaceSrc.includes('shouldShowListSettlementAmounts'), 'T. grouped Paid/Sisa amounts are gated');
check(drawerSrc.includes("fetchBookingSalesDetailApi(bookingId, propertyId)"), 'U. booking detail fetch is lifetime only');
check(!drawerSrc.includes('start_date'), 'U. BookingSalesDetailDrawer does not take list period');
check(!clientSrc.includes('sales/bookings/${encoded}?property_id=${propertyId}&start'), 'U. booking detail API does not forward list period');

const mixedLifetime = [
  {
    property_id: 1,
    booking_id: 10,
    booking_bid: 'LWG-260907-79W91XS8',
    reservation_id: 101,
    reservation_status: 'CHECKED_OUT',
    reservation_stay_status: 'CHECKED_OUT'
  },
  {
    property_id: 1,
    booking_id: 10,
    booking_bid: 'LWG-260907-79W91XS8',
    reservation_id: 102,
    reservation_status: 'BOOKED',
    reservation_stay_status: 'BOOKED'
  },
  {
    property_id: 1,
    booking_id: 10,
    booking_bid: 'LWG-260907-79W91XS8',
    reservation_id: 103,
    reservation_status: 'CHECKED_IN',
    reservation_stay_status: 'CHECKED_IN'
  }
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
  payment_status: 'PAID'
});
const mixedPeriod = groupPenjualanSaleRows([periodCheckedOutOnly], { lifecycleReservations: mixedLifetime });
check(mixedPeriod[0].kind === 'bid_group' && mixedPeriod[0].group.operational_sheet === 'PROSES', '3B1-A. mixed lifetime children stay PROSES');
if (mixedPeriod[0].kind === 'bid_group') {
  check(mixedPeriod[0].group.gross === 200000, '3B1-E. period gross unchanged');
  check(mixedPeriod[0].group.discount === 10000, '3B1-E. period discount unchanged');
  check(mixedPeriod[0].group.net === 190000, '3B1-E. period net unchanged');
  check(mixedPeriod[0].group.room_count === 1, '3B1-F. room_count stays period activity');
  check(mixedPeriod[0].group.payment_status === 'PAID', '3B1-D. payment badge stays separate');
}

const allCheckedOut = groupPenjualanSaleRows([periodCheckedOutOnly], {
  lifecycleReservations: mixedLifetime.map((row) => ({
    ...row,
    reservation_status: 'CHECKED_OUT',
    reservation_stay_status: 'CHECKED_OUT'
  }))
});
check(allCheckedOut[0].kind === 'bid_group' && allCheckedOut[0].group.operational_sheet === 'SELESAI', '3B1-B. all lifetime CHECKED_OUT => SELESAI');

const allCancelled = groupPenjualanSaleRows([
  sale({
    ...periodCheckedOutOnly,
    id: 82,
    reservation_status: 'CANCELLED',
    reservation_stay_status: 'CANCELLED',
    operational_sheet: 'BATAL'
  })
], {
  lifecycleReservations: mixedLifetime.map((row) => ({
    ...row,
    reservation_status: 'CANCELLED',
    reservation_stay_status: 'CANCELLED'
  }))
});
check(allCancelled[0].kind === 'bid_group' && allCancelled[0].group.operational_sheet === 'BATAL', '3B1-C. all lifetime CANCELLED => BATAL');

const bookedPaidLifecycle = groupPenjualanSaleRows([
  sale({
    ...periodCheckedOutOnly,
    reservation_status: 'BOOKED',
    reservation_stay_status: 'BOOKED',
    operational_sheet: 'PROSES'
  })
], {
  lifecycleReservations: [{
    property_id: 1,
    booking_id: 10,
    booking_bid: 'LWG-260907-79W91XS8',
    reservation_id: 101,
    reservation_status: 'BOOKED',
    reservation_stay_status: 'BOOKED'
  }]
});
check(bookedPaidLifecycle[0].kind === 'bid_group' && bookedPaidLifecycle[0].group.operational_sheet === 'PROSES', '3B1-D. BOOKED fully paid => PROSES');

const searchOneChild = groupPenjualanSaleRows([periodCheckedOutOnly], { lifecycleReservations: mixedLifetime });
check(searchOneChild[0].kind === 'bid_group' && searchOneChild[0].group.operational_sheet === 'PROSES', '3B1-G. search/period one child uses full booking sheet');
check(searchOneChild[0].kind === 'bid_group' && searchOneChild[0].group.room_count === 1, '3B1-G. searched child does not inflate room_count');

const allMixedStatus = groupAllTabRows(
  [periodCheckedOutOnly, purchase, expense, income],
  { lifecycleReservations: mixedLifetime }
);
const allGroupedSale = allMixedStatus.find((item) => item.kind === 'bid_group');
check(allGroupedSale?.kind === 'bid_group' && allGroupedSale.group.operational_sheet === 'PROSES', '3B1-H. ALL grouped SALE uses full booking sheet');
check(allMixedStatus.some((item) => item.kind === 'other' && item.tx.id === 41), '3B1-H. ALL non-SALE stays standalone');

const otherPropertyLifetime = [{
  property_id: 2,
  booking_id: 99,
  booking_bid: 'LWG-260907-79W91XS8',
  reservation_id: 201,
  reservation_status: 'CHECKED_OUT',
  reservation_stay_status: 'CHECKED_OUT'
}];
const propertyLeak = groupPenjualanSaleRows(
  [periodCheckedOutOnly],
  { lifecycleReservations: [...mixedLifetime, ...otherPropertyLifetime] }
);
check(propertyLeak[0].kind === 'bid_group' && propertyLeak[0].group.operational_sheet === 'PROSES', '3B1-I. other-property CHECKED_OUT does not force SELESAI');
const otherPropertySale = groupPenjualanSaleRows(
  [sale({ ...periodCheckedOutOnly, id: 91, property_id: 2, booking_id: 99, reservation_id: 201 })],
  { lifecycleReservations: [...mixedLifetime, ...otherPropertyLifetime] }
);
check(otherPropertySale[0].kind === 'bid_group' && otherPropertySale[0].group.operational_sheet === 'SELESAI', '3B1-I. same BID other property keeps its own lifecycle');

const trustedPayload = groupPenjualanSaleRows([{
  ...periodCheckedOutOnly,
  booking_bid_group: {
    bid: 'LWG-260907-79W91XS8',
    booking_id: 10,
    guest_name: 'HADIRA NUR RAGAWAN',
    room_count: 1,
    stay_type_label: 'OVERNIGHT',
    totals_scope: 'PERIOD_ACTIVITY',
    member_transaction_ids: [81],
    gross: 200000,
    discount: 10000,
    net: 190000,
    paid: 190000,
    remaining: 0,
    payment_status: 'PAID',
    operational_sheet: 'PROSES',
    children: []
  }
}]);
check(trustedPayload[0].kind === 'bid_group' && trustedPayload[0].group.operational_sheet === 'PROSES', '3B1-J. frontend trusts backend full-booking sheet');
check(trustedPayload[0].kind === 'bid_group' && trustedPayload[0].group.net === 190000, '3B1-J. frontend still copies period net');
check(reservationLifecycleSheet({
  reservation_id: 1,
  reservation_status: 'CHECKED_OUT',
  reservation_stay_status: 'CHECKED_OUT'
}) === 'SELESAI', '3B1-J. reservation CHECKED_OUT maps SELESAI');
check(reservationLifecycleSheet({
  reservation_id: 2,
  reservation_status: 'BOOKED',
  reservation_stay_status: 'BOOKED'
}) === 'PROSES', '3B1-J. reservation BOOKED maps PROSES');

console.log(`\n=== ALL TRANSACTION SALES-3B TESTS PASSED (${assertions} assertions) ===`);

import assert from 'node:assert/strict';
import { hotelDateFromInstant } from '../src/features/calendar/calendarDates.ts';
import {
  groupPenjualanSaleRows,
  shouldShowListSettlementAmounts,
  isStandalonePenjualanSale,
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
    transaction_date: '2026-09-08',
    transaction_time: '10:00:00',
    transaction_type: 'SALE',
    source_type: 'ROOM_CHARGE',
    source_id: null,
    source_reference: null,
    party_name: 'TAMU',
    category_code: 'ROOM_SALES',
    category_name: 'Room',
    department_code: 'FRONT_OFFICE',
    description: 'Room',
    amount: 100000,
    discount_amount: 0,
    service_amount: 0,
    tax_amount: 0,
    net_amount: 100000,
    payment_status: 'UNPAID',
    payment_method: 'CASH',
    transaction_status: 'POSTED',
    guest_id: null,
    guest_name_snapshot: 'TAMU',
    room_number_snapshot: '101',
    reservation_id: 101,
    booking_id: 10,
    booking_bid: 'BID-3C',
    stay_type: 'OVERNIGHT',
    verification_status: 'UNVERIFIED',
    reversal_of_transaction_id: null,
    correction_group_id: null,
    notes: null,
    metadata: {},
    created_by: null,
    created_at: '2026-09-08T03:00:00.000Z',
    ...partial
  } as TransactionRecord;
}

const today = getPenjualanPeriodPresetRange('today', new Date('2026-09-07T17:00:00.000Z'));
check(today.start === '2026-09-08' && today.end === '2026-09-08', 'Z. Hari Ini still uses Asia/Jakarta');
check(hotelDateFromInstant(new Date('2026-09-07T16:59:00.000Z')) === '2026-09-07', 'Z. before midnight stays previous hotel date');
const allTime = getPenjualanPeriodPresetRange('all_time');
check(allTime.start === '' && allTime.end === '', 'Z. All Time still unscoped');

const grouped = groupPenjualanSaleRows([
  sale({
    id: 1,
    operational_sheet: 'SELESAI',
    reservation_status: 'CHECKED_OUT',
    reservation_amount_paid: 100000,
    reservation_remaining_balance: 0
  })
], {
  lifecycleReservations: [
    { property_id: 1, booking_id: 10, booking_bid: 'BID-3C', reservation_id: 101, reservation_status: 'CHECKED_OUT', reservation_stay_status: 'CHECKED_OUT' },
    { property_id: 1, booking_id: 10, booking_bid: 'BID-3C', reservation_id: 102, reservation_status: 'BOOKED', reservation_stay_status: 'BOOKED' }
  ]
});
check(grouped[0].kind === 'bid_group' && grouped[0].group.operational_sheet === 'PROSES', 'F. frontend full-booking sheet');
check(grouped[0].kind === 'bid_group' && shouldShowListSettlementAmounts(grouped[0]) === false, 'H. grouped Paid/Sisa hidden');
check(isStandalonePenjualanSale({ source_type: 'POS_ORDER', booking_bid: null }) === true, 'V. standalone POS no fake BID');
check(isStandalonePenjualanSale({ source_type: 'POS', booking_bid: 'BID-3C' }) === false, 'U. linked POS joins BID');

console.log(`\n=== SALES-3C FRONTEND CONTRACT PASSED (${assertions} assertions) ===`);

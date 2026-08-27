import assert from 'node:assert/strict';
import {
  getFirstDateOfMonth,
  getFirstDateOfNextMonth,
  getFirstDateOfPreviousMonth,
  formatDateIndonesian,
  getTransactionPeriodRange,
  calculatePeriodCounters,
  filterTransactionsByStatus,
  filterTransactionsBySearch,
  paginateTransactions,
  getTransactionActionMatrix,
  formatStayPeriodDisplay,
  normalizeStatus,
} from '../src/features/transactions/transactionPeriodHelpers.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== Starting Transaksi UX & Period Helpers Tests ===\n');

// ============================================================================
// Test A: Hari Ini interval
// ============================================================================
console.log('--- Test A: Hari Ini Interval ---');
const todayRange = getTransactionPeriodRange('today', '2026-08-27');
check(todayRange !== null, 'A1. todayRange must not be null');
check(todayRange?.startDate === '2026-08-27', 'A2. today startDate is 2026-08-27');
check(todayRange?.endDateExclusive === '2026-08-28', 'A3. today endDateExclusive is 2026-08-28');
check(todayRange?.isSingleDay === true, 'A4. today isSingleDay is true');
check(todayRange?.displayLabel.includes('27/08/2026'), 'A5. today display label contains formatted date');

// ============================================================================
// Test B: Kemarin interval
// ============================================================================
console.log('\n--- Test B: Kemarin Interval ---');
const yesterdayRange = getTransactionPeriodRange('yesterday', '2026-08-27');
check(yesterdayRange !== null, 'B1. yesterdayRange must not be null');
check(yesterdayRange?.startDate === '2026-08-26', 'B2. yesterday startDate is 2026-08-26');
check(yesterdayRange?.endDateExclusive === '2026-08-27', 'B3. yesterday endDateExclusive is 2026-08-27');
check(yesterdayRange?.isSingleDay === true, 'B4. yesterday isSingleDay is true');
check(yesterdayRange?.displayLabel.includes('26/08/2026'), 'B5. yesterday display label contains 26/08/2026');

// ============================================================================
// Test C: 7 Hari interval
// ============================================================================
console.log('\n--- Test C: 7 Hari Interval ---');
const sevenDaysRange = getTransactionPeriodRange('7days', '2026-08-27');
check(sevenDaysRange !== null, 'C1. 7days range must not be null');
check(sevenDaysRange?.startDate === '2026-08-21', 'C2. 7days start is 6 days prior (2026-08-21)');
check(sevenDaysRange?.endDateExclusive === '2026-08-28', 'C3. 7days exclusive end is today + 1 (2026-08-28)');
check(sevenDaysRange?.isSingleDay === false, 'C4. 7days isSingleDay is false');
check(sevenDaysRange?.displayLabel.includes('21/08/2026 – 27/08/2026'), 'C5. 7days display label shows inclusive span');

// ============================================================================
// Test D: Bulan Ini interval
// ============================================================================
console.log('\n--- Test D: Bulan Ini Interval ---');
const thisMonthRange = getTransactionPeriodRange('this_month', '2026-08-27');
check(thisMonthRange !== null, 'D1. this_month range must not be null');
check(thisMonthRange?.startDate === '2026-08-01', 'D2. this_month start is 2026-08-01');
check(thisMonthRange?.endDateExclusive === '2026-09-01', 'D3. this_month exclusive end is 2026-09-01');
check(thisMonthRange?.isSingleDay === false, 'D4. this_month isSingleDay is false');
check(thisMonthRange?.displayLabel.includes('01/08/2026 – 31/08/2026'), 'D5. this_month display shows inclusive last day');

// ============================================================================
// Test E: Bulan Lalu / Year Rollover
// ============================================================================
console.log('\n--- Test E: Bulan Lalu & Year Rollover ---');
const lastMonthAug = getTransactionPeriodRange('last_month', '2026-08-27');
check(lastMonthAug !== null, 'E1. last_month for August must not be null');
check(lastMonthAug?.startDate === '2026-07-01', 'E2. last_month start for Aug is 2026-07-01');
check(lastMonthAug?.endDateExclusive === '2026-08-01', 'E3. last_month exclusive end for Aug is 2026-08-01');

// January rollover test
const lastMonthJan = getTransactionPeriodRange('last_month', '2026-01-15');
check(lastMonthJan !== null, 'E4. last_month for January must not be null');
check(lastMonthJan?.startDate === '2025-12-01', 'E5. last_month start for Jan 2026 rolls over to 2025-12-01');
check(lastMonthJan?.endDateExclusive === '2026-01-01', 'E6. last_month exclusive end for Jan 2026 is 2026-01-01');

// December next-month rollover test
const nextMonthDec = getFirstDateOfNextMonth('2026-12-20');
check(nextMonthDec === '2027-01-01', 'E7. next month after Dec 2026 rolls over to 2027-01-01');

// ============================================================================
// Test F: Custom Inclusive -> Exclusive Conversion & Validation
// ============================================================================
console.log('\n--- Test F: Custom Date Range ---');
const customValid = getTransactionPeriodRange('custom', '2026-08-27', '2026-08-10', '2026-08-15');
check(customValid !== null, 'F1. valid custom range must not be null');
check(customValid?.startDate === '2026-08-10', 'F2. custom start is 2026-08-10');
check(customValid?.endDateExclusive === '2026-08-16', 'F3. custom exclusive end is 2026-08-16 for inclusive end 2026-08-15');

const customSingleDay = getTransactionPeriodRange('custom', '2026-08-27', '2026-08-10', '2026-08-10');
check(customSingleDay?.startDate === '2026-08-10', 'F4. single day custom start matches');
check(customSingleDay?.endDateExclusive === '2026-08-11', 'F5. single day custom exclusive end is next day');
check(customSingleDay?.isSingleDay === true, 'F6. single day custom isSingleDay is true');

const customInvalidOrder = getTransactionPeriodRange('custom', '2026-08-27', '2026-08-20', '2026-08-10');
check(customInvalidOrder === null, 'F7. invalid range start > end returns null');

const customInvalidFormat = getTransactionPeriodRange('custom', '2026-08-27', 'invalid-date', '2026-08-10');
check(customInvalidFormat === null, 'F8. invalid date format returns null');

// ============================================================================
// Test G: Period Counters
// ============================================================================
console.log('\n--- Test G: Period Counters ---');
const sampleReservations = [
  { id: 1, guest_name: 'Alice', status: 'BOOKED', check_in: '2026-08-27', check_out: '2026-08-28' },
  { id: 2, guest_name: 'Bob', status: 'CHECKED_IN', check_in: '2026-08-27', check_out: '2026-08-29' },
  { id: 3, guest_name: 'Charlie', status: 'CHECKED_IN', check_in: '2026-08-26', check_out: '2026-08-28' },
  { id: 4, guest_name: 'Dave', status: 'CHECKED_OUT', check_in: '2026-08-25', check_out: '2026-08-27' },
  { id: 5, guest_name: 'Eve', status: 'CANCELLED', check_in: '2026-08-27', check_out: '2026-08-30' },
  { id: 6, guest_name: 'Frank', status: 'booked', check_in: '2026-08-27', check_out: '2026-08-28' },
];
const counters = calculatePeriodCounters(sampleReservations);
check(counters.all === 6, 'G1. all count is 6');
check(counters.booked === 2, 'G2. booked count is 2 (Alice, Frank)');
check(counters.checkedIn === 2, 'G3. checked_in count is 2 (Bob, Charlie)');
check(counters.checkedOut === 1, 'G4. checked_out count is 1 (Dave)');
check(counters.cancelled === 1, 'G5. cancelled count is 1 (Eve)');

// ============================================================================
// Test H: 25-Row Pagination
// ============================================================================
console.log('\n--- Test H: Pagination ---');
const mockItems = Array.from({ length: 78 }, (_, i) => ({ id: i + 1, name: `Guest ${i + 1}` }));
const page1 = paginateTransactions(mockItems, 1, 25);
check(page1.items.length === 25, 'H1. page 1 has 25 items');
check(page1.items[0].id === 1, 'H2. first item is id 1');
check(page1.items[24].id === 25, 'H3. 25th item is id 25');
check(page1.pagination.currentPage === 1, 'H4. current page is 1');
check(page1.pagination.totalPages === 4, 'H5. total pages is 4 for 78 items at 25/page');
check(page1.pagination.startItemIndex === 1, 'H6. start item index is 1');
check(page1.pagination.endItemIndex === 25, 'H7. end item index is 25');

const page4 = paginateTransactions(mockItems, 4, 25);
check(page4.items.length === 3, 'H8. page 4 has 3 remaining items');
check(page4.pagination.startItemIndex === 76, 'H9. page 4 start item index is 76');
check(page4.pagination.endItemIndex === 78, 'H10. page 4 end item index is 78');

// Clamping out-of-bounds page
const pageOverflow = paginateTransactions(mockItems, 10, 25);
check(pageOverflow.pagination.currentPage === 4, 'H11. page > totalPages clamps to totalPages');

// ============================================================================
// Test I: Status & Search Filtering
// ============================================================================
console.log('\n--- Test I: Status & Search Filtering ---');
const bookedOnly = filterTransactionsByStatus(sampleReservations, 'booked');
check(bookedOnly.length === 2, 'I1. booked filter returns 2 items');

const ciOnly = filterTransactionsByStatus(sampleReservations, 'checked_in');
check(ciOnly.length === 2, 'I2. checked_in filter returns 2 items');

const searchBob = filterTransactionsBySearch(sampleReservations, 'bob');
check(searchBob.length === 1 && searchBob[0].guest_name === 'Bob', 'I3. search by name returns Bob');

const searchPhone = filterTransactionsBySearch([
  { id: 1, guest_name: 'Budi', guest_phone: '08123456789' },
  { id: 2, guest_name: 'Siti', guest_phone: '08771122334' },
], '0877');
check(searchPhone.length === 1 && searchPhone[0].guest_name === 'Siti', 'I4. search by phone returns Siti');

// ============================================================================
// Test J, K, L, M, N: Action Matrix by Status
// ============================================================================
console.log('\n--- Test J-N: Action Matrices by Status ---');
let actionTriggered = '';
const dummyHandlers = {
  onCheckIn: () => { actionTriggered = 'checkin'; },
  onCheckout: () => { actionTriggered = 'checkout'; },
  onOpenDetail: () => { actionTriggered = 'detail'; },
  onEdit: () => { actionTriggered = 'edit'; },
  onMove: () => { actionTriggered = 'move'; },
  onExtend: () => { actionTriggered = 'extend'; },
  onCancel: () => { actionTriggered = 'cancel'; },
  onViewFolio: () => { actionTriggered = 'folio'; },
  onViewAudit: () => { actionTriggered = 'audit'; },
};

// J. BOOKED Action Matrix
const bookedActions = getTransactionActionMatrix({ id: 10, status: 'BOOKED' }, dummyHandlers);
check(bookedActions.primaryAction !== null, 'J1. BOOKED has primary action');
check(bookedActions.primaryAction?.key === 'checkin', 'J2. BOOKED primary action is checkin');
check(bookedActions.primaryAction?.label === 'Check In', 'J3. BOOKED primary action label is Check In');
check(bookedActions.overflowActions.some((a) => a.key === 'detail'), 'J4. BOOKED overflow contains detail');
check(bookedActions.overflowActions.some((a) => a.key === 'edit'), 'J5. BOOKED overflow contains edit');
check(bookedActions.overflowActions.some((a) => a.key === 'move'), 'J6. BOOKED overflow contains move');
check(bookedActions.overflowActions.some((a) => a.key === 'extend'), 'J7. BOOKED overflow contains extend');
check(bookedActions.overflowActions.some((a) => a.key === 'cancel'), 'J8. BOOKED overflow contains cancel');

// N. Cancel Only in Overflow & Destructive
const cancelAction = bookedActions.overflowActions.find((a) => a.key === 'cancel');
check(cancelAction?.isDestructive === true, 'N1. Cancel action is marked destructive');
check(bookedActions.primaryAction?.key !== 'cancel', 'N2. Cancel action is NOT primary');

// K. CHECKED_IN Action Matrix
const ciActions = getTransactionActionMatrix({ id: 20, status: 'CHECKED_IN' }, dummyHandlers);
check(ciActions.primaryAction?.key === 'checkout', 'K1. CHECKED_IN primary action is checkout');
check(ciActions.overflowActions.some((a) => a.key === 'detail'), 'K2. CHECKED_IN overflow contains detail');
check(ciActions.overflowActions.some((a) => a.key === 'folio'), 'K3. CHECKED_IN overflow contains folio');
check(ciActions.overflowActions.some((a) => a.key === 'move'), 'K4. CHECKED_IN overflow contains move');
check(ciActions.overflowActions.some((a) => a.key === 'extend'), 'K5. CHECKED_IN overflow contains extend');
check(!ciActions.overflowActions.some((a) => a.key === 'cancel'), 'K6. CHECKED_IN cannot be cancelled');

// L. CHECKED_OUT Action Matrix
const coActions = getTransactionActionMatrix({ id: 30, status: 'CHECKED_OUT' }, dummyHandlers);
check(coActions.primaryAction?.key === 'detail', 'L1. CHECKED_OUT primary action is detail');
check(coActions.overflowActions.some((a) => a.key === 'folio'), 'L2. CHECKED_OUT overflow contains folio');
check(coActions.overflowActions.some((a) => a.key === 'audit'), 'L3. CHECKED_OUT overflow contains audit');
check(!coActions.overflowActions.some((a) => a.key === 'checkin'), 'L4. CHECKED_OUT cannot check-in');
check(!coActions.overflowActions.some((a) => a.key === 'checkout'), 'L5. CHECKED_OUT cannot checkout');

// M. CANCELLED Action Matrix
const cancelActions = getTransactionActionMatrix({ id: 40, status: 'CANCELLED' }, dummyHandlers);
check(cancelActions.primaryAction?.key === 'detail', 'M1. CANCELLED primary action is detail');
check(cancelActions.overflowActions.some((a) => a.key === 'audit'), 'M2. CANCELLED overflow contains audit');
check(!cancelActions.overflowActions.some((a) => a.key === 'checkin'), 'M3. CANCELLED cannot check-in');
check(!cancelActions.overflowActions.some((a) => a.key === 'cancel'), 'M4. CANCELLED cannot cancel again');

// ============================================================================
// Test O & P: Historical and Future Reachability
// ============================================================================
console.log('\n--- Test O & P: Historical & Future Reachability ---');
const pastCustom = getTransactionPeriodRange('custom', '2026-08-27', '2026-01-01', '2026-01-31');
check(pastCustom !== null, 'O1. past custom range is reachable');
check(pastCustom?.startDate === '2026-01-01' && pastCustom?.endDateExclusive === '2026-02-01', 'O2. past custom span accurate');

const futureCustom = getTransactionPeriodRange('custom', '2026-08-27', '2026-12-01', '2026-12-31');
check(futureCustom !== null, 'P1. future custom range is reachable');
check(futureCustom?.startDate === '2026-12-01' && futureCustom?.endDateExclusive === '2027-01-01', 'P2. future custom span accurate');

// ============================================================================
// Test Q: Stay Period Formatting
// ============================================================================
console.log('\n--- Test Q: Formatting & Off-by-one verification ---');
const stayFormat = formatStayPeriodDisplay('2026-08-27', '2026-08-28');
check(stayFormat.includes('1 mlm'), 'Q1. 1-night stay formatted correctly with 1 mlm');
const stay3Format = formatStayPeriodDisplay('2026-08-27', '2026-08-30');
check(stay3Format.includes('3 mlm'), 'Q2. 3-night stay formatted correctly with 3 mlm');

console.log(`\n=== All ${assertions} Transaksi UX Assertions PASSED ===\n`);

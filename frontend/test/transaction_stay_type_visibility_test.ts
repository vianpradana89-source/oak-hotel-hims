import assert from 'node:assert/strict';
import { formatReservationStayType, stayTypeBadgeClass } from '../src/features/transactions/transactionDomainTypes.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== OAK HIMS Transaction Stay Type Visibility ===\n');

check(formatReservationStayType('DAY_USE') === 'DAY USE', 'DAY_USE maps to DAY USE');
check(formatReservationStayType('day_use') === 'DAY USE', 'day_use is canonicalized to DAY USE');
check(formatReservationStayType('OVERNIGHT') === 'OVERNIGHT', 'OVERNIGHT maps to OVERNIGHT');
check(formatReservationStayType('overnight') === 'OVERNIGHT', 'overnight is canonicalized to OVERNIGHT');
check(formatReservationStayType(null) === '-', 'missing stay_type displays dash');
check(formatReservationStayType(undefined) === '-', 'undefined stay_type displays dash');
check(formatReservationStayType('') === '-', 'blank stay_type displays dash');
check(formatReservationStayType('WEEKLY') === '-', 'unknown stay_type is not inferred');

const groupedCorrection = { stay_type: 'DAY_USE', reservation_id: 986, transaction_status: 'POSTED' };
check(formatReservationStayType(groupedCorrection.stay_type) === 'DAY USE', 'grouped correction lifecycle preserves DAY USE');

const detailPayload = { booking_bid: 'BID-986', stay_type: 'DAY_USE' };
check(formatReservationStayType(detailPayload.stay_type) === 'DAY USE', 'detail drawer can display Tipe Stay DAY USE');
check(stayTypeBadgeClass(detailPayload.stay_type).includes('cyan'), 'DAY USE uses a compact Day Use badge');
check(stayTypeBadgeClass('OVERNIGHT').includes('emerald'), 'OVERNIGHT uses a compact overnight badge');
check(stayTypeBadgeClass(null).includes('slate-400'), 'non-reservation dash stays muted');

console.log(`\n=== ALL STAY TYPE VISIBILITY TESTS PASSED (${assertions} assertions) ===`);

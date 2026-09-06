import assert from 'node:assert/strict';
import { mapToOperationalStatus } from '../src/features/transactions/transactionDomainTypes.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== OAK HIMS Sale Status Mapping Tests ===\n');

const bookedStay = mapToOperationalStatus({
  transaction_type: 'SALE',
  transaction_status: 'POSTED',
  source_type: 'ROOM_CHARGE',
  reservation_id: 986,
  reservation_status: 'BOOKED',
  reservation_stay_status: 'RESERVED',
});
check(bookedStay.group === 'PROSES', 'BOOKED stay sale maps to Proses');
check(bookedStay.label === 'Proses', 'BOOKED stay sale label is Proses');
check(bookedStay.label !== 'Selesai', 'POSTED financial status does not make a BOOKED stay Selesai');

const checkedInStay = mapToOperationalStatus({
  transaction_type: 'SALE',
  transaction_status: 'POSTED',
  source_type: 'ROOM_CHARGE',
  reservation_id: 100,
  reservation_status: 'CHECKED_IN',
  reservation_stay_status: 'CHECKED_IN',
});
check(checkedInStay.group === 'PROSES', 'CHECKED_IN stay sale maps to Proses');

const checkedOutStay = mapToOperationalStatus({
  transaction_type: 'SALE',
  transaction_status: 'POSTED',
  source_type: 'ROOM_CHARGE',
  reservation_id: 101,
  reservation_status: 'CHECKED_OUT',
  reservation_stay_status: 'CHECKED_OUT',
});
check(checkedOutStay.group === 'SELESAI', 'CHECKED_OUT stay sale maps to Selesai');
check(checkedOutStay.label === 'Selesai', 'CHECKED_OUT stay sale label is Selesai');

const cancelledStay = mapToOperationalStatus({
  transaction_type: 'SALE',
  transaction_status: 'POSTED',
  source_type: 'ROOM_CHARGE',
  reservation_id: 984,
  reservation_status: 'CANCELLED',
  reservation_stay_status: 'CANCELLED',
});
check(cancelledStay.group === 'BATAL', 'CANCELLED stay sale maps to Batal');
check(cancelledStay.label === 'Dibatalkan', 'CANCELLED stay sale label is Dibatalkan');

const reversed = mapToOperationalStatus({
  transaction_type: 'SALE',
  transaction_status: 'REVERSED',
  reservation_status: 'BOOKED',
});
check(reversed.label === 'Batal', 'REVERSED financial history row remains Batal');
check(reversed.group === 'BATAL', 'REVERSED sale stays on the Batal sheet');

const voided = mapToOperationalStatus({
  transaction_type: 'SALE',
  transaction_status: 'VOIDED',
  reservation_status: 'BOOKED',
});
check(voided.label === 'Batal', 'VOIDED original remains Batal');

const proses = mapToOperationalStatus({
  transaction_type: 'SALE',
  transaction_status: 'DRAFT',
});
check(proses.group === 'PROSES', 'non-posted non-terminal sale stays Proses');

const nonReservationPosted = mapToOperationalStatus({
  transaction_type: 'SALE',
  transaction_status: 'POSTED',
  source_type: 'MANUAL_SALE',
});
check(nonReservationPosted.group === 'SELESAI', 'non-reservation POSTED sale stays Selesai');

const posOnBookedStay = mapToOperationalStatus({
  transaction_type: 'SALE',
  transaction_status: 'POSTED',
  source_type: 'POS',
  reservation_id: 986,
  reservation_status: 'BOOKED',
});
check(posOnBookedStay.group === 'SELESAI', 'POS POSTED mapping is unchanged even on a BOOKED stay');

const expensePosted = mapToOperationalStatus({
  transaction_type: 'EXPENSE',
  transaction_status: 'POSTED',
});
check(expensePosted.group === 'SELESAI', 'expense POSTED mapping is unchanged');

const cancelledLifecycle = mapToOperationalStatus({
  transaction_type: 'SALE',
  transaction_status: 'REVERSED',
  operational_sheet: 'BATAL',
  is_lifecycle_primary: true,
  lifecycle_status_label: 'Dibatalkan',
});
check(cancelledLifecycle.label === 'Dibatalkan', 'cancelled lifecycle primary shows Dibatalkan');
check(cancelledLifecycle.group === 'BATAL', 'cancelled lifecycle stays on the Batal sheet');

const bookedLifecyclePrimary = mapToOperationalStatus({
  transaction_type: 'SALE',
  transaction_status: 'POSTED',
  operational_sheet: 'PROSES',
  is_lifecycle_primary: true,
});
check(bookedLifecyclePrimary.label === 'Proses', 'grouped BOOKED stay primary shows Proses');
check(bookedLifecyclePrimary.group === 'PROSES', 'grouped BOOKED stay primary stays on Proses');

const checkedOutLifecyclePrimary = mapToOperationalStatus({
  transaction_type: 'SALE',
  transaction_status: 'POSTED',
  operational_sheet: 'SELESAI',
  is_lifecycle_primary: true,
});
check(checkedOutLifecyclePrimary.label === 'Selesai', 'grouped CHECKED_OUT stay primary shows Selesai');

console.log(`\n=== ALL SALE STATUS MAPPING TESTS PASSED (${assertions} assertions) ===`);

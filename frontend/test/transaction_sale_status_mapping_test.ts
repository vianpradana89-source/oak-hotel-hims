import assert from 'node:assert/strict';
import { mapToOperationalStatus } from '../src/features/transactions/transactionDomainTypes.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== OAK HIMS Sale Status Mapping Tests ===\n');

const activeSale = mapToOperationalStatus({
  transaction_type: 'SALE',
  transaction_status: 'POSTED',
  reservation_status: 'CANCELLED',
  booking_status: 'CANCELLED',
});
check(activeSale.label !== 'Batal', 'POSTED sale must not inherit Batal from reservation/booking status');
check(activeSale.group === 'SELESAI', 'POSTED sale maps to Selesai');

const reversed = mapToOperationalStatus({
  transaction_type: 'SALE',
  transaction_status: 'REVERSED',
  reservation_status: 'BOOKED',
});
check(reversed.label === 'Batal', 'REVERSED sale remains Batal');
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

const cancelledLifecycle = mapToOperationalStatus({
  transaction_type: 'SALE',
  transaction_status: 'REVERSED',
  operational_sheet: 'BATAL',
  is_lifecycle_primary: true,
  lifecycle_status_label: 'Dibatalkan',
});
check(cancelledLifecycle.label === 'Dibatalkan', 'cancelled lifecycle primary shows Dibatalkan');
check(cancelledLifecycle.group === 'BATAL', 'cancelled lifecycle stays on Batal sheet');

const correctedLifecycle = mapToOperationalStatus({
  transaction_type: 'SALE',
  transaction_status: 'POSTED',
  operational_sheet: 'SELESAI',
  is_lifecycle_primary: true,
});
check(correctedLifecycle.label === 'Selesai', 'corrected lifecycle primary shows Selesai');

console.log(`\n=== ALL SALE STATUS MAPPING TESTS PASSED (${assertions} assertions) ===`);

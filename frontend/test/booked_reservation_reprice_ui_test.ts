import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { canShowBookedRateCorrection } from '../src/features/calendar/bookedReservationReprice.ts';

const here = dirname(fileURLToPath(import.meta.url));
const drawerSrc = readFileSync(join(here, '../src/features/calendar/ReservationDetailDrawer.tsx'), 'utf8');
const modalSrc = readFileSync(join(here, '../src/features/calendar/BookedReservationRepriceModal.tsx'), 'utf8');

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== BOOKED-RESERVATION-REPRICE-1 frontend ===\n');

check(canShowBookedRateCorrection({ status: 'BOOKED' }), 'BOOKED walk-in can show Koreksi Tarif');
check(!canShowBookedRateCorrection({ status: 'CHECKED_IN' }), 'CHECKED_IN hides Koreksi Tarif');
check(!canShowBookedRateCorrection({ status: 'CHECKED_OUT' }), 'CHECKED_OUT hides Koreksi Tarif');
check(!canShowBookedRateCorrection({ status: 'CANCELLED' }), 'CANCELLED hides Koreksi Tarif');
check(!canShowBookedRateCorrection({ status: 'BOOKED', ota_source_id: 12 }), 'OTA source hides Koreksi Tarif');
check(!canShowBookedRateCorrection({ status: 'BOOKED', booking_channel: 'OTA' }), 'OTA channel hides Koreksi Tarif');
check(
  !canShowBookedRateCorrection({ status: 'BOOKED', is_manual_override: true, manual_override_reason: 'OTA: Traveloka' }),
  'OTA override reason hides Koreksi Tarif'
);

check(drawerSrc.includes('Koreksi Tarif'), 'drawer button copy');
check(drawerSrc.includes('BookedReservationRepriceModal'), 'drawer opens dedicated modal');
check(drawerSrc.includes('canShowBookedRateCorrection'), 'drawer uses BOOKED/OTA helper');
check(!drawerSrc.includes('edit-with-payment'), 'drawer reprice path is not edit-with-payment');

check(modalSrc.includes('/reprice-preview'), 'modal previews via dedicated endpoint');
check(modalSrc.includes('/reprice'), 'modal commits via dedicated endpoint');
check(modalSrc.includes('Konfirmasi Koreksi Tarif'), 'confirm copy');
check(modalSrc.includes('Alasan koreksi'), 'required reason field');
check(!modalSrc.includes('edit-with-payment'), 'modal does not use edit-with-payment');
check(!modalSrc.includes('payment_method'), 'modal has no payment fields');
check(modalSrc.includes('Number(rp.room_type_id) === roomTypeId'), 'plan list uses exact room_type_id');
check(!modalSrc.includes('startsWith'), 'no prefix plan matching');

console.log(`\nPASS ${assertions} assertions`);

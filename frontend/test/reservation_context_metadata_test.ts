import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  canEditReservationSpecialRequests,
  formatReservationRatePlanLabel,
  formatReservationSourceLabel,
  reservationSpecialRequestsText,
} from '../src/features/calendar/reservationContextMetadata.ts';

const here = dirname(fileURLToPath(import.meta.url));
const drawerSrc = readFileSync(join(here, '../src/features/calendar/ReservationDetailDrawer.tsx'), 'utf8');
const quickSrc = readFileSync(join(here, '../src/features/calendar/QuickReservationDetail.tsx'), 'utf8');
const helperSrc = readFileSync(join(here, '../src/features/calendar/reservationContextMetadata.ts'), 'utf8');
const quickBookingSrc = readFileSync(join(here, '../src/features/booking/QuickBookingModal.tsx'), 'utf8');

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== RESERVATION-CONTEXT-METADATA-1 frontend ===\n');

check(
  formatReservationSourceLabel({ booking_source: 'WALKIN' }) === 'Walk-in',
  'A. Walk-in source displays Walk-in'
);
check(
  formatReservationSourceLabel({ booking_source: 'DIRECT' }) === 'Resepsionis / Langsung',
  'A. DIRECT displays Resepsionis / Langsung'
);
check(
  formatReservationSourceLabel({ ota_source_name: 'TRIP.COM', booking_source: 'WALKIN' }) === 'OTA — TRIP.COM',
  'B. OTA brand comes from ota_sources.name as OTA — TRIP.COM'
);
check(
  formatReservationSourceLabel({ ota_source_id: 9, ota_source_name: 'TRIP.COM', booking_source: 'OTA' }) === 'OTA — TRIP.COM',
  'B. ota_source_id with name still uses OTA — TRIP.COM'
);
check(
  formatReservationRatePlanLabel({
    rate_plan_name_snapshot: 'DELUXE KING - RO',
    ota_source_name: 'TRIP.COM',
  }) === 'DELUXE KING - RO',
  'C. Rate Plan uses snapshot name when present'
);
check(
  formatReservationRatePlanLabel({
    ota_source_id: 3,
    ota_source_name: 'TRIP.COM',
    rate_plan_id: null,
    is_manual_override: true,
  }) === 'Manual / OTA Override',
  'D. OTA/manual with no rate plan displays Manual / OTA Override'
);
check(
  formatReservationRatePlanLabel({
    ota_source_name: 'TRIP.COM',
    rate_plan_id: null,
  }) !== 'TRIP.COM',
  'E. OTA name is never the Rate Plan label'
);
check(
  formatReservationRatePlanLabel({
    ota_source_name: 'TRIP.COM',
    rate_plan_id: null,
  }) === 'Manual / OTA Override',
  'E. OTA without a plan is Manual / OTA Override, not the OTA brand'
);

check(formatReservationSourceLabel({ booking_source: 'WEBSITE' }) === 'Website Hotel', 'WEBSITE label');
check(
  formatReservationSourceLabel({ booking_source: 'WALKIN' }) !== 'Telepon / WhatsApp',
  'PHONE_WA residual: persisted WALKIN is not faked as Telepon / WhatsApp'
);
check(
  formatReservationSourceLabel({ booking_source: 'PHONE_WA' }) === 'Telepon / WhatsApp',
  'explicit PHONE_WA still formats when canonical data actually stores it'
);
check(formatReservationSourceLabel({ booking_source: 'BOOKING_COM' }) === 'Booking Com', 'unknown explicit source is normalized safely');
check(reservationSpecialRequestsText({ special_requests: '  Late arrival  ' }) === 'Late arrival', 'notes trim for display');
check(reservationSpecialRequestsText({ special_requests: null }) === '', 'empty notes are blank');
check(canEditReservationSpecialRequests('BOOKED'), 'BOOKED notes are editable');
check(canEditReservationSpecialRequests('CHECKED_IN'), 'CHECKED_IN notes are editable');
check(!canEditReservationSpecialRequests('CHECKED_OUT'), 'CHECKED_OUT notes are read-only');
check(!canEditReservationSpecialRequests('CANCELLED'), 'CANCELLED notes are read-only');

check(quickBookingSrc.includes('special_requests: specialRequests.trim()'), 'F. Quick Booking payload sends special_requests');
check(
  quickBookingSrc.includes('reservations: roomsList.map') &&
    /special_requests:\s*specialRequests\.trim\(\)/.test(quickBookingSrc),
  'G. multi-room create copies the same textarea onto every child payload'
);

check(quickSrc.includes('formatReservationSourceLabel'), 'popup uses shared source formatter');
check(quickSrc.includes('formatReservationRatePlanLabel'), 'popup uses shared rate plan formatter');
check(quickSrc.includes('reservationSpecialRequestsText'), 'popup uses shared notes helper');
check(quickSrc.includes('Sumber'), 'popup shows Sumber');
check(quickSrc.includes('Rate Plan'), 'popup shows Rate Plan');
check(quickSrc.includes('specialRequestsNote ?'), 'I. popup Catatan is gated on non-empty text');
check(quickSrc.includes('line-clamp-2'), 'H. popup long notes are line-clamped');
check(quickSrc.includes('>Catatan<') || quickSrc.includes('>Catatan</span>'), 'H. popup Catatan label exists');
check(!quickSrc.includes('formatBookingSource'), 'popup no longer uses a local source formatter');
check(!quickSrc.includes('/special-requests'), 'popup Catatan is read-only (no dedicated edit call)');

check(drawerSrc.includes('formatReservationSourceLabel'), 'drawer uses shared source formatter');
check(drawerSrc.includes('formatReservationRatePlanLabel'), 'drawer uses shared rate plan helper');
check(!drawerSrc.includes('OTA: '), 'drawer does not keep OTA: variant');
check(drawerSrc.includes('OTA —') === false || helperSrc.includes('OTA —'), 'canonical em dash lives in the shared helper');
check(!drawerSrc.includes('isOtaReservation'), 'drawer no longer treats OTA name as Rate Plan');
check(drawerSrc.includes('whitespace-pre-wrap'), 'J. Reservation Detail shows full Catatan');
check(drawerSrc.includes('Edit Catatan'), 'drawer has Edit Catatan');
check(drawerSrc.includes('Tambah Catatan'), 'empty editable reservation can add notes');
check(drawerSrc.includes('/special-requests'), 'save calls dedicated special-requests endpoint');
check(!/handleSaveSpecialRequests[\s\S]*edit-with-payment/.test(drawerSrc), 'notes save does not use edit-with-payment');
check(drawerSrc.includes("method: 'PATCH'"), 'notes save is PATCH');
check(drawerSrc.includes('disabled={savingNotes}'), 'duplicate submit is disabled while saving');
check(drawerSrc.includes('Simpan') && drawerSrc.includes('Batal'), 'edit actions are Simpan / Batal');
check(drawerSrc.includes('canEditReservationSpecialRequests'), 'UI edit policy uses BOOKED / CHECKED_IN helper');
check(helperSrc.includes("return `OTA — ${otaName}`"), 'shared formatter uses one OTA em-dash format');

console.log(`\nRESERVATION-CONTEXT-METADATA-1 frontend passed (${assertions} assertions)`);

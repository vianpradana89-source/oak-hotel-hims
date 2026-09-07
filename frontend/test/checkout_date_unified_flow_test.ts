import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildCheckoutChangeSubmit,
  canConfirmCheckoutDateChange,
  canShowCheckoutDateChange,
  checkoutChangeCopy,
  CHECKED_IN_SHORTEN_BLOCKED_MESSAGE,
  CHECKOUT_DATE_CHANGE_LABEL,
  isCheckedInShortenBlocked,
  resolveCheckoutChangeMode,
} from '../src/features/calendar/checkoutDateChange.ts';

const here = dirname(fileURLToPath(import.meta.url));
const drawerSrc = readFileSync(join(here, '../src/features/calendar/ReservationDetailDrawer.tsx'), 'utf8');
const quickSrc = readFileSync(join(here, '../src/features/calendar/QuickReservationDetail.tsx'), 'utf8');
const appSrc = readFileSync(join(here, '../src/App.tsx'), 'utf8');
const helperSrc = readFileSync(join(here, '../src/features/calendar/checkoutDateChange.ts'), 'utf8');
const txHelperSrc = readFileSync(join(here, '../src/features/transactions/transactionPeriodHelpers.ts'), 'utf8');

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== CHECKOUT-DATE-UNIFIED-FLOW-1 frontend ===\n');

const bookedShorten = buildCheckoutChangeSubmit({
  reservationId: 101,
  propertyId: 1,
  status: 'BOOKED',
  currentCheckout: '2026-09-09',
  newCheckout: '2026-09-08',
});
check(resolveCheckoutChangeMode('2026-09-09', '2026-09-08') === 'shorten', 'A1. BOOKED 09 -> 08 is SHORTEN');
check(bookedShorten.kind === 'request' && bookedShorten.mode === 'shorten', 'A2. BOOKED earlier submits shorten');
check(bookedShorten.kind === 'request' && bookedShorten.url === '/api/reservations/101/shorten', 'A3. BOOKED earlier uses /shorten only');
check(bookedShorten.kind === 'request' && !('additional_night_rate' in bookedShorten.payload), 'A4. shorten payload has no additional_night_rate');

const bookedExtend = buildCheckoutChangeSubmit({
  reservationId: 101,
  propertyId: 1,
  status: 'BOOKED',
  currentCheckout: '2026-09-09',
  newCheckout: '2026-09-10',
  additionalNightRate: 450000,
});
check(resolveCheckoutChangeMode('2026-09-09', '2026-09-10') === 'extend', 'B1. BOOKED 09 -> 10 is EXTEND');
check(bookedExtend.kind === 'request' && bookedExtend.mode === 'extend', 'B2. BOOKED later submits extend');
check(bookedExtend.kind === 'request' && bookedExtend.url === '/api/reservations/101/extend', 'B3. BOOKED later uses /extend only');
check(bookedExtend.kind === 'request' && bookedExtend.payload.additional_night_rate === 450000, 'B4. extend payload keeps additional_night_rate');

const sameDate = buildCheckoutChangeSubmit({
  reservationId: 101,
  propertyId: 1,
  status: 'BOOKED',
  currentCheckout: '2026-09-09',
  newCheckout: '2026-09-09',
});
check(resolveCheckoutChangeMode('2026-09-09', '2026-09-09') === 'same', 'C1. same date is SAME');
check(sameDate.kind === 'noop', 'C2. same date is a no-op with no request');
check(!canConfirmCheckoutDateChange('BOOKED', '2026-09-09', '2026-09-09'), 'C3. same date disables confirm');

const checkedInEarlier = buildCheckoutChangeSubmit({
  reservationId: 202,
  propertyId: 1,
  status: 'CHECKED_IN',
  currentCheckout: '2026-09-09',
  newCheckout: '2026-09-08',
});
check(resolveCheckoutChangeMode('2026-09-09', '2026-09-08') === 'shorten', 'D1. CHECKED_IN earlier still resolves SHORTEN');
check(isCheckedInShortenBlocked('CHECKED_IN', 'shorten'), 'D2. CHECKED_IN shorten is blocked');
check(checkedInEarlier.kind === 'blocked', 'D3. CHECKED_IN 09 -> 08 does not call /shorten');
check(
  checkedInEarlier.kind === 'blocked' && checkedInEarlier.reason === CHECKED_IN_SHORTEN_BLOCKED_MESSAGE,
  'D4. CHECKED_IN earlier shows Early Checkout guidance'
);
check(!canConfirmCheckoutDateChange('CHECKED_IN', '2026-09-09', '2026-09-08'), 'D5. CHECKED_IN earlier disables confirm');

const checkedInLater = buildCheckoutChangeSubmit({
  reservationId: 202,
  propertyId: 1,
  status: 'CHECKED_IN',
  currentCheckout: '2026-09-09',
  newCheckout: '2026-09-10',
  additionalNightRate: 500000,
});
check(canConfirmCheckoutDateChange('CHECKED_IN', '2026-09-09', '2026-09-10'), 'E1. CHECKED_IN later allows confirm');
check(checkedInLater.kind === 'request' && checkedInLater.mode === 'extend', 'E2. CHECKED_IN 09 -> 10 is EXTEND');
check(checkedInLater.kind === 'request' && checkedInLater.url === '/api/reservations/202/extend', 'E3. CHECKED_IN later uses /extend');

check(!canShowCheckoutDateChange('CHECKED_OUT'), 'F1. CHECKED_OUT hides unified action');
check(!canShowCheckoutDateChange('CANCELLED'), 'G1. CANCELLED hides unified action');
check(canShowCheckoutDateChange('BOOKED'), 'G2. BOOKED still shows unified action');
check(canShowCheckoutDateChange('CHECKED_IN'), 'G3. CHECKED_IN still shows unified action');

const otaExtend = buildCheckoutChangeSubmit({
  reservationId: 303,
  propertyId: 1,
  status: 'BOOKED',
  currentCheckout: '2026-09-09',
  newCheckout: '2026-09-11',
  additionalNightRate: 275000,
});
check(otaExtend.kind === 'request' && otaExtend.payload.additional_night_rate === 275000, 'H1. OTA extend keeps FO additional_night_rate');
check(appSrc.includes('Tarif per Malam Tambahan'), 'H2. extend preview still has extra-night rate field');
check(appSrc.includes('additionalNightRate'), 'H3. App still binds additionalNightRate');
check(appSrc.includes('pricingSource'), 'H4. OTA/manual pricing source label remains');

const otaShorten = buildCheckoutChangeSubmit({
  reservationId: 303,
  propertyId: 1,
  status: 'BOOKED',
  currentCheckout: '2026-09-09',
  newCheckout: '2026-09-08',
});
check(otaShorten.kind === 'request' && otaShorten.mode === 'shorten', 'I1. OTA shorten still routes to /shorten');
check(otaShorten.kind === 'request' && !('additional_night_rate' in otaShorten.payload), 'I2. OTA shorten has no additional_night_rate');
check(appSrc.includes('Penyesuaian Tagihan'), 'I3. existing shorten preview remains');
check(appSrc.includes('Potensi Lebih Bayar (Kredit Tamu)'), 'I4. overpaid credit preview remains');
check(appSrc.includes('Total Tagihan Baru'), 'I5. new total preview remains');

check(!drawerSrc.includes('Perpanjang Menginap'), 'J1. drawer has no Perpanjang Menginap button');
check(!quickSrc.includes('Perpanjang Menginap'), 'J2. quick detail has no Perpanjang Menginap button');
check(!quickSrc.includes('>Perpanjang<') && !quickSrc.includes('\n                    Perpanjang\n'), 'J3. quick detail has no standalone Perpanjang button');
check(!appSrc.includes("label: 'Extend'") && !appSrc.includes("label: 'Shorten'"), 'J4. calendar quick actions no longer split Extend/Shorten');
check(drawerSrc.includes('CHECKOUT_DATE_CHANGE_LABEL'), 'J5. drawer uses unified checkout-date label');
check(quickSrc.includes('CHECKOUT_DATE_CHANGE_LABEL'), 'J6. quick detail uses unified checkout-date label');
check(drawerSrc.includes('canShowCheckoutDateChange'), 'J7. drawer gates the unified action by status');
check(quickSrc.includes('canShowCheckoutDateChange'), 'J8. quick detail gates the unified action by status');
check(txHelperSrc.includes("label: 'Ubah Tanggal Check-out'"), 'J9. transaction overflow uses unified checkout-date label');
check(!txHelperSrc.includes("label: 'Extend Stay'"), 'J10. transaction overflow no longer says Extend Stay');

check(helperSrc.includes('/api/reservations/${input.reservationId}/${mode}'), 'K1. helper keeps /shorten and /extend URL shape');
check(appSrc.includes('authFetch(submit.url'), 'K2. App posts to helper-built /shorten or /extend URL');
check(!appSrc.includes('/edit-with-payment'), 'K3. stay-change confirm does not use generic reservation edit');
check(appSrc.includes('resolveCheckoutChangeMode'), 'K4. App derives mode from dates');
check(appSrc.includes('buildCheckoutChangeSubmit'), 'K5. App submit uses shared routing helper');
check(checkoutChangeCopy('shorten').title === 'Pendekkan Masa Menginap', 'K6. shorten title');
check(checkoutChangeCopy('shorten').confirm === 'Konfirmasi Pendekkan', 'K7. shorten confirm copy');
check(checkoutChangeCopy('extend').title === 'Perpanjang Masa Menginap', 'K8. extend title');
check(checkoutChangeCopy('extend').confirm === 'Konfirmasi Perpanjangan', 'K9. extend confirm copy');
check(checkoutChangeCopy('same').title === CHECKOUT_DATE_CHANGE_LABEL, 'K10. same-date title stays unified');
check(appSrc.includes('stayChangeCopy.title'), 'K11. modal title follows date-derived copy');
check(appSrc.includes('stayChangeCanConfirm'), 'K12. confirm button uses date-derived enablement');
check(appSrc.includes('CHECKED_IN_SHORTEN_BLOCKED_MESSAGE'), 'K13. CHECKED_IN shorten leak is closed in UI');
check(
  (drawerSrc.match(/CHECKOUT_DATE_CHANGE_LABEL/g) || []).length >= 2,
  'K14. drawer shows the unified action for BOOKED and CHECKED_IN'
);

console.log(`\nPASS ${assertions} assertions`);

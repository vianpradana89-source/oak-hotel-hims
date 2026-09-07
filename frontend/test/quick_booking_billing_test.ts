import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  computeQuickBookingRoomDiscount,
  toBackendDiscountType
} from '../src/features/booking/quickBookingBilling.ts';

const here = dirname(fileURLToPath(import.meta.url));
const modalSrc = readFileSync(join(here, '../src/features/booking/QuickBookingModal.tsx'), 'utf8');

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== QUICK-BOOKING-FINANCIAL-CONTRACT-1 frontend billing ===\n');

check(
  computeQuickBookingRoomDiscount({
    roomCharge: 1000000,
    stayChargesTotal: 0,
    discountType: 'PERCENT',
    discountValue: 10
  }) === 100000,
  'A: 1,000,000 + 10% => discount 100,000'
);
check(
  1000000 - computeQuickBookingRoomDiscount({
    roomCharge: 1000000,
    stayChargesTotal: 0,
    discountType: 'PERCENT',
    discountValue: 10
  }) === 900000,
  'A/B: net 900,000, not 810,000'
);
check(
  computeQuickBookingRoomDiscount({
    roomCharge: 1000000,
    stayChargesTotal: 0,
    discountType: 'NOMINAL',
    discountValue: 100000
  }) === 100000,
  'C: nominal 100,000'
);
check(
  computeQuickBookingRoomDiscount({
    roomCharge: 1000000,
    stayChargesTotal: 0,
    discountType: 'PERCENT',
    discountValue: 0
  }) === 0,
  'D: zero discount'
);
check(
  computeQuickBookingRoomDiscount({
    roomCharge: 800000,
    stayChargesTotal: 200000,
    discountType: 'PERCENT',
    discountValue: 10
  }) === 100000,
  'Q: discount base is room + stay charges'
);
check(toBackendDiscountType('PERCENT') === 'PERCENTAGE', 'payload maps PERCENT to PERCENTAGE');
check(toBackendDiscountType('NOMINAL') === 'NOMINAL', 'payload keeps NOMINAL');

check(!modalSrc.includes('total_price: calc.netSubtotal'), 'J: frontend no longer sends net as total_price');
check(modalSrc.includes('total_price: calc.roomCharge + calc.stayChargesTotal'), 'payload total_price is gross room + stay');
check(modalSrc.includes('toBackendDiscountType(r.discountType)'), 'payload sends backend discount_type');
check(modalSrc.includes("Alasan diskon wajib diisi"), 'H: non-zero discount requires reason in UI gate');
check(modalSrc.includes('Net Kamar'), 'summary shows net');
check(!modalSrc.includes('global_discount') && !modalSrc.includes('booking_discount'), 'no global discount fields');

console.log(`\nPASS ${assertions} assertions`);

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  QUICK_BOOKING_QUOTE_NOT_READY_MESSAGE,
  compatibleQuickBookingRatePlans,
  isCompatibleQuickBookingRatePlan,
  isQuickBookingQuoteReady,
  matchRatePlanToCanonicalRoomType,
  quickBookingQuoteFingerprint,
  resolveQuotedRoomSubtotal,
  selectDefaultRatePlan
} from '../src/features/booking/quickBookingRatePlans.ts';

const here = dirname(fileURLToPath(import.meta.url));
const modalSrc = readFileSync(join(here, '../src/features/booking/QuickBookingModal.tsx'), 'utf8');

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== QUICK-BOOKING-PRICING-AUTHORITY-1 frontend ===\n');

const outPlan = {
  id: 6,
  room_type_id: 52,
  rate_type: 'OVERNIGHT',
  is_active: true,
  is_archived: false,
  room_type_code: 'PRM-T-OUT'
};
const inPlan = {
  id: 3,
  room_type_id: 4,
  rate_type: 'OVERNIGHT',
  is_active: true,
  is_archived: false,
  room_type_code: 'PRM-T'
};
const inactiveOut = {
  id: 9,
  room_type_id: 52,
  rate_type: 'OVERNIGHT',
  is_active: false,
  is_archived: false
};
const archivedOut = {
  id: 10,
  room_type_id: 52,
  rate_type: 'OVERNIGHT',
  is_active: true,
  is_archived: true
};
const dayUseOut = {
  id: 11,
  room_type_id: 52,
  rate_type: 'DAY_USE',
  is_active: true,
  is_archived: false
};

check(!matchRatePlanToCanonicalRoomType(inPlan, 52), 'A: PRM-T / IN plan does not match OUT type id 52');
check(matchRatePlanToCanonicalRoomType(outPlan, 52), 'A: OUT plan matches OUT type id 52');
check(!matchRatePlanToCanonicalRoomType(inPlan, 52), 'A: prefix PRM-T vs PRM-T-OUT cannot match via id helper');
check(
  compatibleQuickBookingRatePlans([inPlan, outPlan, inactiveOut], 52, 'OVERNIGHT').map((p) => p.id).join(',') === '6',
  'A: compatible overnight list for OUT is only the OUT plan'
);

check(!isCompatibleQuickBookingRatePlan(inactiveOut, 52, 'OVERNIGHT'), 'B: inactive plan is not compatible');
check(!isCompatibleQuickBookingRatePlan(archivedOut, 52, 'OVERNIGHT'), 'B: archived plan is not compatible');
check(selectDefaultRatePlan([inactiveOut, outPlan], 52, 'OVERNIGHT') === 6, 'B: auto-select skips inactive and uses first active');
check(selectDefaultRatePlan([inPlan, inactiveOut, dayUseOut], 52, 'OVERNIGHT') === null, 'B: no overnight default when only IN/inactive/day-use');
check(selectDefaultRatePlan([outPlan, dayUseOut], 52, 'DAY_USE') === 11, 'stay-type: day-use default is the day-use plan');

check(
  resolveQuotedRoomSubtotal({ grand_total: 739200, room_subtotal: 640000 }) === 640000,
  'G: room rate uses room_subtotal, not grand_total'
);
check(
  resolveQuotedRoomSubtotal({
    nightly_breakdown: [{ final_room_rate: 640000 }],
    grand_total: 739200
  }) === 640000,
  'G: fallback is nightly final_room_rate sum, not grand_total'
);
check(resolveQuotedRoomSubtotal({ grand_total: 739200 }) === 0, 'G: grand_total alone is not a room rate');

const readyDraft = {
  isManualOverride: false,
  quoteLoading: false,
  quoteOk: true,
  quotedFingerprint: '52|6|2026-09-12|2026-09-13|OVERNIGHT',
  roomTypeId: 52,
  ratePlanId: 6,
  checkIn: '2026-09-12',
  checkOut: '2026-09-13',
  stayType: 'OVERNIGHT' as const
};
check(quickBookingQuoteFingerprint(readyDraft) === '52|6|2026-09-12|2026-09-13|OVERNIGHT', 'I: 12 Sep -> 13 Sep fingerprint uses 12 Sep stay');
check(isQuickBookingQuoteReady(readyDraft), 'submit: matching fingerprint is ready');
check(
  !isQuickBookingQuoteReady({ ...readyDraft, ratePlanId: 3, quoteOk: true }),
  'submit: wrong-plan quote fingerprint is not ready'
);
check(
  !isQuickBookingQuoteReady({ ...readyDraft, quoteOk: false }),
  'submit: failed quote is not ready'
);
check(
  !isQuickBookingQuoteReady({ ...readyDraft, quoteLoading: true }),
  'submit: in-flight quote is not ready'
);
check(
  isQuickBookingQuoteReady({ ...readyDraft, isManualOverride: true, quoteOk: false }),
  'F: manual override does not require quote'
);

check(modalSrc.includes('resolveQuotedRoomSubtotal'), 'modal uses room-only quote helper');
check(!modalSrc.includes('grand_total || json.data.room_subtotal'), 'modal no longer prefers grand_total as room rate');
check(!modalSrc.includes('startsWith(rpCode)'), 'modal dropped prefix room-type matching');
check(!modalSrc.includes('rpName.includes(activeName)'), 'modal dropped name-includes room-type matching');
check(modalSrc.includes('isQuickBookingQuoteReady'), 'modal submit gate uses quote readiness');
check(modalSrc.includes('QUICK_BOOKING_QUOTE_NOT_READY_MESSAGE'), 'modal shows controlled quote-not-ready copy');
check(modalSrc.includes('selectDefaultRatePlan'), 'modal default plan uses exact canonical helper');
check(modalSrc.includes('is_active=true'), 'modal loads active rate plans only');
check(QUICK_BOOKING_QUOTE_NOT_READY_MESSAGE.includes('Tarif kamar belum siap'), 'FO copy is present');

console.log(`\nPASS ${assertions} assertions`);

import assert from 'node:assert/strict';
import {
  buildDayUseInterval,
  buildQuickBookingStayFields,
  tryBuildDayUseInterval,
} from '../src/features/booking/dayUseInterval.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== OAK HIMS Day Use Interval Integrity Tests ===\n');

console.log('--- 1. Same-day intervals ---');
const tenToFour = buildDayUseInterval('2026-09-06', '10:00', 6);
check(tenToFour.start_at === '2026-09-06T10:00:00', 'DAY_USE 10:00 + 6 hours starts at 10:00');
check(tenToFour.end_at === '2026-09-06T16:00:00', 'DAY_USE 10:00 + 6 hours ends at 16:00');
check(tenToFour.start_at < tenToFour.end_at, 'start_at is strictly earlier than end_at');

const sevenThirty = buildDayUseInterval('2026-09-06', '07:30', 4);
check(sevenThirty.start_at === '2026-09-06T07:30:00', 'DAY_USE 07:30 + 4 hours starts at 07:30');
check(sevenThirty.end_at === '2026-09-06T11:30:00', 'DAY_USE 07:30 + 4 hours ends at 11:30');

console.log('--- 2. Midnight crossing ---');
const overnightDayUse = buildDayUseInterval('2026-09-06', '22:00', 4);
check(overnightDayUse.start_at === '2026-09-06T22:00:00', 'late start stays on the selected hotel date');
check(overnightDayUse.end_at === '2026-09-07T02:00:00', 'duration past midnight lands on the next hotel date');

const monthRoll = buildDayUseInterval('2026-09-30', '23:00', 3);
check(monthRoll.end_at === '2026-10-01T02:00:00', 'midnight crossing rolls the calendar month');

console.log('--- 3. Rejected durations and inputs ---');
check(tryBuildDayUseInterval('2026-09-06', '10:00', 0).ok === false, 'zero duration is rejected');
check(tryBuildDayUseInterval('2026-09-06', '10:00', -2).ok === false, 'negative duration is rejected');
check(tryBuildDayUseInterval('2026-13-40', '10:00', 6).ok === false, 'invalid hotel date is rejected');
check(tryBuildDayUseInterval('2026-09-06', '25:99', 6).ok === false, 'invalid start time is rejected');

console.log('--- 4. Overnight payload unchanged ---');
const overnight = buildQuickBookingStayFields({
  stayType: 'OVERNIGHT',
  checkIn: '2026-09-06',
  checkOut: '2026-09-08',
  dayUseStartTime: '10:00',
  dayUseHours: 6,
});
check(overnight.stay_type === 'OVERNIGHT', 'overnight stay_type is preserved');
check(overnight.check_in === '2026-09-06', 'overnight check_in is preserved');
check(overnight.check_out === '2026-09-08', 'overnight check_out is not collapsed to check_in');
check(overnight.start_at === undefined, 'overnight start_at remains unset');
check(overnight.end_at === undefined, 'overnight end_at remains unset');

const dayUseFields = buildQuickBookingStayFields({
  stayType: 'DAY_USE',
  checkIn: '2026-09-06',
  checkOut: '2026-09-06',
  dayUseStartTime: '10:00',
  dayUseHours: 6,
});
check(dayUseFields.start_at === '2026-09-06T10:00:00', 'composer start_at is hotel-local wall-clock without browser offset');
check(dayUseFields.end_at === '2026-09-06T16:00:00', 'composer end_at adds dayUseHours without browser offset');
check(dayUseFields.check_out === '2026-09-06', 'DAY_USE check_out stays on the hotel date');
check(!String(dayUseFields.start_at).includes('+') && !String(dayUseFields.start_at).includes('Z'), 'frontend leaves timezone attachment to the backend');

console.log(`\n=== ALL DAY USE INTERVAL TESTS PASSED (${assertions} assertions) ===`);

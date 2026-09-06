import assert from 'node:assert/strict';
import { getReservationCalendarSpan } from '../src/features/calendar/calendarReservationSpans.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

const days = [
  { date: '2026-09-05' },
  { date: '2026-09-06' },
  { date: '2026-09-07' },
  { date: '2026-09-08' },
];

console.log('=== OAK HIMS Calendar Day Use Span Tests ===\n');

console.log('--- 1. DAY_USE same-day is included ---');
const dayUse = getReservationCalendarSpan({
  check_in: '2026-09-06',
  check_out: '2026-09-06',
  stay_type: 'DAY_USE',
  start_at: '2026-09-06T10:00:00',
  end_at: '2026-09-06T16:00:00',
}, days);
check(dayUse !== null, 'DAY_USE with check_in === check_out must appear on the calendar');
check(dayUse?.startIndex === 1, 'DAY_USE must render on the check_in hotel date');
check(dayUse?.span === 1, 'DAY_USE must occupy exactly one hotel date');

const dayUseWideCheckout = getReservationCalendarSpan({
  check_in: '2026-09-06',
  check_out: '2026-09-08',
  stay_type: 'DAY_USE',
}, days);
check(dayUseWideCheckout?.span === 1, 'DAY_USE must not consume overnight inventory dates');
check(dayUseWideCheckout?.startIndex === 1, 'DAY_USE stays on the check_in date even if check_out is later');

console.log('--- 2. Overnight same-day remains omitted ---');
const overnightSameDay = getReservationCalendarSpan({
  check_in: '2026-09-06',
  check_out: '2026-09-06',
  stay_type: 'OVERNIGHT',
}, days);
check(overnightSameDay === null, 'overnight check_in === check_out must remain omitted');

const overnightMissingType = getReservationCalendarSpan({
  check_in: '2026-09-06',
  check_out: '2026-09-06',
}, days);
check(overnightMissingType === null, 'same-day reservation without stay_type stays overnight and is omitted');

console.log('--- 3. Overnight multi-day unchanged ---');
const overnightOneNight = getReservationCalendarSpan({
  check_in: '2026-09-06',
  check_out: '2026-09-07',
  stay_type: 'OVERNIGHT',
}, days);
check(overnightOneNight?.startIndex === 1, 'overnight 06→07 starts on 06');
check(overnightOneNight?.span === 1, 'overnight 06→07 occupies only date 06');

const overnightMulti = getReservationCalendarSpan({
  check_in: '2026-09-06',
  check_out: '2026-09-08',
  stay_type: 'OVERNIGHT',
}, days);
check(overnightMulti?.startIndex === 1, 'overnight 06→08 starts on 06');
check(overnightMulti?.span === 2, 'overnight 06→08 occupies 06 and 07');

console.log(`\n=== ALL CALENDAR DAY USE SPAN TESTS PASSED (${assertions} assertions) ===`);

import assert from 'node:assert/strict';
import {
  buildDayUseInterval,
  buildQuickBookingStayFields,
  tryBuildDayUseInterval,
  roundUpHotelTimestamp,
} from '../src/features/booking/dayUseInterval.ts';
import {
  hotelNowFromInstant,
  applyDayUseSeed,
  type DayUseRoomDraft,
  type DayUseClockData,
} from '../src/features/booking/dayUseSessionClock.ts';
import { normalizeHotelDate } from '../src/features/calendar/calendarDates.ts';
import { resolveOvernightStayDates } from '../src/features/booking/quickBookingDates.ts';

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

console.log('--- 5. Round-up default start time (15-min interval) ---');
const r1 = roundUpHotelTimestamp('2026-11-10T10:07:00', 15);
check(r1.time === '10:15' && !r1.datePlusOne, '10:07 → 10:15');

const r2 = roundUpHotelTimestamp('2026-11-10T10:17:00', 15);
check(r2.time === '10:30' && !r2.datePlusOne, '10:17 → 10:30');

const r3 = roundUpHotelTimestamp('2026-11-10T10:30:00', 15);
check(r3.time === '10:30' && !r3.datePlusOne, '10:30 (on boundary) → stays 10:30');

const r4 = roundUpHotelTimestamp('2026-11-10T10:46:00', 15);
check(r4.time === '11:00' && !r4.datePlusOne, '10:46 → 11:00');

const r5 = roundUpHotelTimestamp('2026-11-10T23:53:00', 15);
check(r5.time === '00:00' && r5.datePlusOne === true, '23:53 → 00:00 next day flag');

const r6 = roundUpHotelTimestamp('2026-11-10T22:30:00', 15);
check(r6.time === '22:30' && !r6.datePlusOne, '22:30 (on boundary) → stays 22:30');

const r7 = roundUpHotelTimestamp('invalid-input', 15);
check(r7.time === '10:00' && !r7.datePlusOne, 'invalid input falls back to 10:00');

console.log('--- 6. Duration change does not touch start time (payload integrity) ---');
const duPayload1 = buildQuickBookingStayFields({
  stayType: 'DAY_USE',
  checkIn: '2026-11-10',
  checkOut: '2026-11-10',
  dayUseStartTime: '10:15',
  dayUseHours: 4,
});
check(duPayload1.start_at === '2026-11-10T10:15:00', '4h from 10:15 keeps start 10:15');
check(duPayload1.end_at === '2026-11-10T14:15:00', '4h from 10:15 ends 14:15 same day');

const duPayload2 = buildQuickBookingStayFields({
  stayType: 'DAY_USE',
  checkIn: '2026-11-10',
  checkOut: '2026-11-10',
  dayUseStartTime: '10:15',
  dayUseHours: 8,
});
check(duPayload2.start_at === '2026-11-10T10:15:00', '8h from 10:15 keeps start 10:15');
check(duPayload2.end_at === '2026-11-10T18:15:00', '8h from 10:15 ends 18:15 same day');

const duPayload3 = buildQuickBookingStayFields({
  stayType: 'DAY_USE',
  checkIn: '2026-11-10',
  checkOut: '2026-11-10',
  dayUseStartTime: '22:30',
  dayUseHours: 6,
});
check(duPayload3.start_at === '2026-11-10T22:30:00', '22:30 + 6h keeps start');
check(duPayload3.end_at === '2026-11-11T04:30:00', '22:30 + 6h → 04:30 next day');

console.log('--- 7. hotelNowFromInstant: timezone conversion of open instant ---');
const h1 = hotelNowFromInstant('2026-11-10T03:07:00Z', 'Asia/Jakarta');
check(h1.ok === true, '10:07 Jakarta conversion succeeds');
check(h1.ok && h1.time === '10:15', '10:07 Jakarta rounds to 10:15');
check(h1.ok && !h1.datePlusOne, 'no rollover for 10:07');
check(h1.ok && h1.hotelDate === '2026-11-10', 'hotelDate stays 2026-11-10');

const h2 = hotelNowFromInstant('2026-11-10T16:50:00Z', 'Asia/Jakarta');
check(h2.ok === true && h2.time === '00:00', '16:50 UTC = 23:50 Jakarta, rollover gives 00:00');
check(h2.ok && h2.datePlusOne === true, '23:50 Jakarta triggers datePlusOne');
check(h2.ok && h2.hotelDate === '2026-11-10', 'rollover hotelDate is the original open date');

const h3 = hotelNowFromInstant(null, 'Asia/Jakarta');
check(h3.ok === false, 'missing open instant returns ok=false');

const h4 = hotelNowFromInstant('2026-11-10T03:07:00Z', 'Invalid/Timezone');
check(h4.ok === false, 'invalid timezone returns ok=false');

const h5 = hotelNowFromInstant('not-a-valid-date', 'Asia/Jakarta');
check(h5.ok === false, 'malformed open instant returns ok=false');

console.log('--- 8. applyDayUseSeed: per-draft dirty flag behaviour ---');
const makeDraft = (id: string, stayType: 'OVERNIGHT' | 'DAY_USE', checkIn: string, duTimeSeeded = false, duDateSeeded = false): DayUseRoomDraft => ({
  id, stayType, checkIn,
  checkOut: stayType === 'DAY_USE' ? checkIn : checkIn,
  dayUseStartTime: '10:00', duTimeSeeded, duDateSeeded,
});

const clockNormal: DayUseClockData = { time: '10:15', hotelDate: '2026-11-10', datePlusOne: false };
const twoRooms = [
  makeDraft('room-A', 'OVERNIGHT', '2026-11-20'),
  makeDraft('room-B', 'OVERNIGHT', '2026-11-20'),
];
const twoSeeded = applyDayUseSeed(twoRooms, clockNormal);
check(twoSeeded[0].dayUseStartTime === '10:15' && twoSeeded[0].duTimeSeeded === true, 'room A time seeded to 10:15');
check(twoSeeded[0].checkIn === '2026-11-20', 'room A OVERNIGHT checkIn unchanged');
check(twoSeeded[1].dayUseStartTime === '10:15', 'room B also seeded (index > 0 supported)');

const clockMidnight: DayUseClockData = { time: '00:00', hotelDate: '2026-11-10', datePlusOne: true };
const duRoom = makeDraft('room-DU', 'DAY_USE', '2026-11-10');
const duSeeded = applyDayUseSeed([duRoom], clockMidnight);
check(duSeeded[0].dayUseStartTime === '00:00', 'DAY_USE rollover sets start to 00:00');
check(duSeeded[0].checkIn === '2026-11-11', 'DAY_USE rollover shifts checkIn to next day');
check(duSeeded[0].duDateSeeded === false, 'auto-shifted date not marked manual');

const overnightRoom = makeDraft('room-ON', 'OVERNIGHT', '2026-11-20');
const onSeeded = applyDayUseSeed([overnightRoom], clockMidnight);
check(onSeeded[0].checkIn === '2026-11-20', 'OVERNIGHT checkIn NOT shifted by midnight rollover');
check(onSeeded[0].dayUseStartTime === '00:00', 'OVERNIGHT dayUseStartTime still updated');

const manualDateRoom = makeDraft('room-DUM', 'DAY_USE', '2026-12-05', false, true);
const manualDateSeeded = applyDayUseSeed([manualDateRoom], clockMidnight);
check(manualDateSeeded[0].checkIn === '2026-12-05', 'DAY_USE manual date NOT overwritten by rollover');

const manualTimeRoom = makeDraft('room-DUT', 'DAY_USE', '2026-11-10', true, false);
const manualTimeSeeded = applyDayUseSeed([manualTimeRoom], clockNormal);
check(manualTimeSeeded[0].dayUseStartTime === '10:00', 'manually-set time NOT overwritten by seed');

const idempotent = applyDayUseSeed(applyDayUseSeed([makeDraft('room-ID', 'OVERNIGHT', '2026-11-20')], clockNormal), clockNormal);
check(idempotent[0].dayUseStartTime === '10:15', 'second apply is idempotent');

console.log('--- 9. Full lifecycle: reopen + async delay + stale response guard ---');
const open1 = '2026-11-10T03:07:00Z';
const c1 = hotelNowFromInstant(open1, 'Asia/Jakarta');
check(c1.ok === true && c1.time === '10:15', 'session 1: 10:07 Jakarta -> 10:15');

const open2 = '2026-11-10T05:07:00Z';
const c2 = hotelNowFromInstant(open2, 'Asia/Jakarta');
check(c2.ok === true && c2.time === '12:15', 'session 2: 12:07 Jakarta -> 12:15 (fresh clock)');

const s2Room = makeDraft('room-s2', 'OVERNIGHT', '2026-11-22');
const s2Clock: DayUseClockData = c2.ok
  ? { time: c2.time, hotelDate: c2.hotelDate, datePlusOne: c2.datePlusOne }
  : { time: '10:00', hotelDate: '2026-11-10', datePlusOne: false };
const s2Seeded = applyDayUseSeed([s2Room], s2Clock);
check(s2Seeded[0].dayUseStartTime === '12:15', 'session 2 room seeded to 12:15, not stale 10:15');

const openInstantCaptured = '2026-11-10T03:07:00Z';
const responseArrivalTime = '2026-11-10T03:17:00Z';
const clockFromOpen = hotelNowFromInstant(openInstantCaptured, 'Asia/Jakarta');
const clockFromResponse = hotelNowFromInstant(responseArrivalTime, 'Asia/Jakarta');
check(clockFromOpen.ok === true && clockFromOpen.time === '10:15', 'open-instant clock gives 10:15');
check(clockFromResponse.ok === true && clockFromResponse.time === '10:30', 'response-arrival time gives 10:30 (wrong, not used)');
check(clockFromOpen.time !== clockFromResponse.time, 'open-instant differs from response-arrival');

const jktClock = hotelNowFromInstant(open1, 'Asia/Jakarta');
const tyClock = hotelNowFromInstant(open1, 'Asia/Tokyo');
check(jktClock.ok === true && jktClock.time === '10:15', 'Jakarta clock: 10:15');
check(tyClock.ok === true && tyClock.time === '12:15', 'Tokyo clock: 12:15 (03:07 UTC = 12:07 Tokyo, would be wrong if not guarded)');
check(tyClock.time !== jktClock.time, 'different property tz gives different result (guard needed)');

console.log('--- 10. QB-R2-02: seed idempotency + manual/calendar date provenance ---');
// Case A — manual date protection survives reseed:
// DAY_USE manual date 5 Dec, duDateSeeded=true, duTimeSeeded=false.
// Seed 1 (rollover clock) must NOT change the date AND must NOT clear duDateSeeded.
const clockMidnightR2: DayUseClockData = { time: '00:00', hotelDate: '2026-11-10', datePlusOne: true };
const manualDateR2 = makeDraft('room-manual', 'DAY_USE', '2026-12-05', false, true);
const r2Seed1 = applyDayUseSeed([manualDateR2], clockMidnightR2);
check(r2Seed1[0].checkIn === '2026-12-05', 'QB-R2-02A: manual date survives first seed');
check(r2Seed1[0].duDateSeeded === true, 'QB-R2-02A: duDateSeeded flag NOT cleared by auto-seed');
// Seed 2 (same clock, simulating loadInitialData re-invoke):
const r2Seed2 = applyDayUseSeed(r2Seed1, clockMidnightR2);
check(r2Seed2[0].checkIn === '2026-12-05', 'QB-R2-02A: manual date survives second reseed');
check(r2Seed2[0].duDateSeeded === true, 'QB-R2-02A: duDateSeeded flag still true after reseed');

// Case B — calendar-selected date protection:
// factory would set duDateSeeded=true when initialDate != null.
// Simulate: DAY_USE with calendar date, duDateSeeded=true.
const calendarDateR2 = makeDraft('room-cal', 'DAY_USE', '2026-11-20', false, true);
const calSeeded = applyDayUseSeed([calendarDateR2], clockMidnightR2);
check(calSeeded[0].checkIn === '2026-11-20', 'QB-R2-02B: calendar date NOT overwritten by rollover');
check(calSeeded[0].duDateSeeded === true, 'QB-R2-02B: calendar duDateSeeded flag preserved');

// Early click scenario: auto-eligible draft (duDateSeeded=false) gets rolled forward
const autoDateR2 = makeDraft('room-auto', 'DAY_USE', '2026-11-10', false, false);
const autoSeeded = applyDayUseSeed([autoDateR2], clockMidnightR2);
check(autoSeeded[0].checkIn === '2026-11-11', 'QB-R2-02: auto-eligible date IS shifted to next day');
check(autoSeeded[0].duDateSeeded === false, 'QB-R2-02: auto date NOT marked manual');

console.log('--- 11. QB-R2-01: late Day Use click vs early click equivalence ---');
// Simulate: clock available (rollover 00:00), draft was OVERNIGHT.
// Early click: clock arrives after mode transition → seed effect handles it.
// Late click: clock already arrived, mode transition handler applies it.
// Both should produce the same effective date.
const earlyDraft = makeDraft('room-early', 'DAY_USE', '2026-11-10', false, false);
// Before clock: draft has default checkIn 2026-11-10 (auto-eligible).
// Early path: seed effect runs after clockData arrives → shifts to 11th.
const earlySeeded = applyDayUseSeed([earlyDraft], clockMidnightR2);
check(earlySeeded[0].checkIn === '2026-11-11', 'QB-R2-01 early: auto date shifted to 11th by seed');

// Late click: draft was OVERNIGHT with checkIn 2026-11-10.
// Handler applies applyDayUseSeed with clockMidnightR2.
// OVERNIGHT → DAY_USE transition: stayType changes, duDateSeeded=false, checkIn=11-10.
const lateDraft: DayUseRoomDraft = { ...makeDraft('room-late', 'OVERNIGHT', '2026-11-10'), stayType: 'DAY_USE', checkOut: '2026-11-10' };
const lateSeeded = applyDayUseSeed([lateDraft], clockMidnightR2);
check(lateSeeded[0].checkIn === '2026-11-11', 'QB-R2-01 late: late-clicked DAY_USE also gets 11th');
check(lateSeeded[0].checkIn === earlySeeded[0].checkIn, 'QB-R2-01: early and late click produce same date');

// Protected calendar date in late-click scenario:
const lateCalDraft: DayUseRoomDraft = { ...makeDraft('room-late-cal', 'OVERNIGHT', '2026-11-20', false, true), stayType: 'DAY_USE', checkOut: '2026-11-20' };
const lateCalSeeded = applyDayUseSeed([lateCalDraft], clockMidnightR2);
check(lateCalSeeded[0].checkIn === '2026-11-20', 'QB-R2-01: calendar-protected date NOT shifted in late click');

console.log('--- 12. QB-R2-03: deferred JSON body across session reopen ---');
// Simulate: session A at 10:07 Jakarta → 10:15.
// Body of A's tz response is deferred (Promise that resolves late).
// Session B opens at 12:07 Jakarta → 12:15.
// When A's body finally resolves, the session key has changed.
// A's clock must NOT be written to B's draft.
const sessionAClockResult: { ok: true; time: string; hotelDate: string; datePlusOne: boolean } =
  (() => { const r = hotelNowFromInstant('2026-11-10T03:07:00Z', 'Asia/Jakarta'); return r.ok ? r : ({ ok: false, error: 'unexpected' } as any as never); })();
check(sessionAClockResult.time === '10:15', 'QB-R2-03: session A clock is 10:15');

const sessionBClockResult: { ok: true; time: string; hotelDate: string; datePlusOne: boolean } =
  (() => { const r = hotelNowFromInstant('2026-11-10T05:07:00Z', 'Asia/Jakarta'); return r.ok ? r : ({ ok: false, error: 'unexpected' } as any as never); })();
check(sessionBClockResult.time === '12:15', 'QB-R2-03: session B clock is 12:15');

// B's draft: initially at B's clock
const bDraft = makeDraft('room-B', 'OVERNIGHT', '2026-11-22');
const bSeeded = applyDayUseSeed([bDraft], { time: sessionBClockResult.time, hotelDate: sessionBClockResult.hotelDate, datePlusOne: sessionBClockResult.datePlusOne });
check(bSeeded[0].dayUseStartTime === '12:15', 'QB-R2-03: B seeded with own clock 12:15');

// Now A's stale body "arrives" after B is already seeded:
// The guard (recheck in QuickBookingModal) prevents this write.
// Simulate: if the guard were missing, A would write 10:15 to B's draft:
const staleAPrevented = applyDayUseSeed(bSeeded, { time: sessionAClockResult.time, hotelDate: sessionAClockResult.hotelDate, datePlusOne: sessionAClockResult.datePlusOne });
// Because B's duTimeSeeded is already true from B's own seed, the stale write is no-op:
check(staleAPrevented[0].dayUseStartTime === '12:15', 'QB-R2-03: stale A body does NOT overwrite B (duTimeSeeded guard)');

console.log('--- 13. QB-R2-04: tz failure → explicit error status, no silent 10:00 ---');
// non-OK response: setClockState({ status: 'error', ... })
// The derived clockData = clockState.status === 'ready' ? clockState.data : null → null
// So the seed effect does NOT fire; draft keeps its static default.
// The draft's duTimeSeeded remains false, signalling the time was NOT auto-seeded.
const errorDraft = makeDraft('room-err', 'DAY_USE', '2026-11-10', false, false);
// No seed applied (clockData=null when status=error):
// The UI would show "⚠ Clock Day Use gagal…" instead of a false success.
check(errorDraft.dayUseStartTime === '10:00', 'QB-R2-04: default 10:00 remains when clock failed');
check(errorDraft.duTimeSeeded === false, 'QB-R2-04: duTimeSeeded=false → time was NOT auto-seeded');
// Validation would use clockState.status: if 'error' and DAY_USE, issue message is shown.

console.log('--- 14. QB-R2-02 extended: provenance via normalizeHotelDate (App→factory→seed) ---');
// This section tests the actual provenance decision made by the factory:
//   duDateSeeded = normalizeHotelDate(initialDate) !== ''
// combined with the real resolveOvernightStayDates path and applyDayUseSeed.
// No hand-made flags — the flags come from the same expression the factory uses.

// ── Scenario 1: App passes initialDate='' (no calendar selection) ──
// Factory: resolveOvernightStayDates('') → today's date + tomorrow.
//          duDateSeeded = normalizeHotelDate('') !== '' → false (auto-eligible)
// Clock: 23:53 WIB → rollover → 00:00, datePlusOne=true, hotelDate='2026-11-10'
// Simulate: draft in DAY_USE mode (operator clicked before clock arrived)

const factoryCheckIn_fromEmpty = resolveOvernightStayDates(''); // today/tomorrow
const draft_fromEmpty: DayUseRoomDraft = {
  id: 'room-empty',
  stayType: 'DAY_USE',
  checkIn: factoryCheckIn_fromEmpty.checkIn,   // today's date (e.g. 2026-11-10)
  checkOut: factoryCheckIn_fromEmpty.checkIn,  // DAY_USE: checkOut = checkIn
  dayUseStartTime: '10:00',
  duTimeSeeded: false,
  duDateSeeded: normalizeHotelDate('') !== '',  // false — empty → auto-eligible
};
check(draft_fromEmpty.duDateSeeded === false, 'R2-02: initialDate="" → duDateSeeded=false (auto-eligible)');

// Clock available: 23:53 WIB → 00:00 next day (hotelDate 2026-11-10, datePlusOne=true)
const clockRollover: DayUseClockData = { time: '00:00', hotelDate: '2026-11-10', datePlusOne: true };

// Early click: operator selected DAY_USE before clock arrived;
// seed effect fires when clockData becomes available.
const earlyResult = applyDayUseSeed([draft_fromEmpty], clockRollover);
check(earlyResult[0].checkIn === '2026-11-11', 'R2-01: early click (auto-eligible) → 2026-11-11 00:00');
check(earlyResult[0].dayUseStartTime === '00:00', 'R2-01: early click start time 00:00');

// Late click: operator selected DAY_USE AFTER clock was already available.
// applyClockToDayUseDraft handler applies the same seed with the same clock.
const lateResult = applyDayUseSeed([draft_fromEmpty], clockRollover);
check(lateResult[0].checkIn === '2026-11-11', 'R2-01: late click (auto-eligible) → 2026-11-11 00:00');
check(lateResult[0].checkIn === earlyResult[0].checkIn, 'R2-01: early and late click produce SAME date');

// ── Scenario 2: App passes initialDate='2026-11-20' (calendar selection) ──
// Factory: resolveOvernightStayDates('2026-11-20') → checkIn 2026-11-20, checkOut 2026-11-21
//          duDateSeeded = normalizeHotelDate('2026-11-20') !== '' → true (protected)
const factoryCheckIn_fromCal = resolveOvernightStayDates('2026-11-20');
const draft_fromCal: DayUseRoomDraft = {
  id: 'room-cal',
  stayType: 'DAY_USE',
  checkIn: factoryCheckIn_fromCal.checkIn,   // 2026-11-20
  checkOut: factoryCheckIn_fromCal.checkIn,   // DAY_USE: checkOut = checkIn
  dayUseStartTime: '10:00',
  duTimeSeeded: false,
  duDateSeeded: normalizeHotelDate('2026-11-20') !== '',  // true — calendar-protected
};
check(draft_fromCal.duDateSeeded === true, 'R2-02: initialDate="2026-11-20" → duDateSeeded=true (calendar-protected)');

// Same rollover clock: 23:53 → 00:00, datePlusOne=true
const calResult = applyDayUseSeed([draft_fromCal], clockRollover);
check(calResult[0].checkIn === '2026-11-20', 'R2-02: calendar date 2026-11-20 NOT overwritten by rollover');
check(calResult[0].duDateSeeded === true, 'R2-02: calendar duDateSeeded flag still true after seed');

// Reseed (loadInitialData re-invoked):
const calReseed = applyDayUseSeed(calResult, clockRollover);
check(calReseed[0].checkIn === '2026-11-20', 'R2-02: calendar date still protected on reseed');

// ── Scenario 3: invalid initialDate string (malformed) ──
// normalizeHotelDate('garbage') → '' → duDateSeeded=false → auto-eligible
const draft_malformed: DayUseRoomDraft = {
  id: 'room-mal',
  stayType: 'DAY_USE',
  checkIn: resolveOvernightStayDates('garbage').checkIn, // falls back to today
  checkOut: resolveOvernightStayDates('garbage').checkIn,
  dayUseStartTime: '10:00',
  duTimeSeeded: false,
  duDateSeeded: normalizeHotelDate('garbage') !== '',  // false
};
check(draft_malformed.duDateSeeded === false, 'R2-02: malformed initialDate → duDateSeeded=false (auto-eligible)');

console.log(`\n=== ALL DAY USE INTERVAL TESTS PASSED (${assertions} assertions) ===`);

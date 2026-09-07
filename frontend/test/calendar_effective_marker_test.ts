import assert from 'node:assert/strict';
import {
  emptyCellEffectiveMarkers,
  isEffectiveArrival,
  isEffectiveDeparture,
  reservationMarkerId,
  uniqueMarkerIds,
} from '../src/features/calendar/effectiveStayMarkers.ts';
import { getReservationCalendarSpan } from '../src/features/calendar/calendarReservationSpans.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

const booked = {
  id: 101,
  status: 'BOOKED',
  checked_in_at: null,
  checked_out_at: null,
  check_in: '2026-09-06',
  check_out: '2026-09-08',
  stay_type: 'OVERNIGHT',
};

const checkedIn = {
  id: 102,
  status: 'CHECKED_IN',
  checked_in_at: '2026-09-06T07:00:00.000Z',
  checked_out_at: null,
  check_in: '2026-09-06',
  check_out: '2026-09-08',
  stay_type: 'OVERNIGHT',
};

const checkedOut = {
  id: 103,
  status: 'CHECKED_OUT',
  checked_in_at: '2026-09-06T07:00:00.000Z',
  checked_out_at: '2026-09-08T03:00:00.000Z',
  check_in: '2026-09-06',
  check_out: '2026-09-08',
  stay_type: 'OVERNIGHT',
};

const cancelled = {
  id: 104,
  status: 'CANCELLED',
  checked_in_at: null,
  checked_out_at: null,
  check_in: '2026-09-06',
  check_out: '2026-09-08',
};

const skippedCheckIn = {
  id: 105,
  status: 'CHECKED_OUT',
  checked_in_at: null,
  checked_out_at: '2026-09-08T03:00:00.000Z',
  check_in: '2026-09-06',
  check_out: '2026-09-08',
};

const dayUseInHouse = {
  id: 202,
  status: 'CHECKED_IN',
  checked_in_at: '2026-09-06T03:00:00.000Z',
  checked_out_at: null,
  check_in: '2026-09-06',
  check_out: '2026-09-06',
  stay_type: 'DAY_USE',
};

console.log('=== OAK HIMS Calendar Effective ARR/DEP Marker Tests ===\n');

console.log('A-C lifecycle');
check(isEffectiveArrival(booked) === false, 'A. BOOKED bar must not show ARR');
check(isEffectiveDeparture(booked) === false, 'A. BOOKED has no DEP');
check(isEffectiveArrival(checkedIn) === true, 'B. CHECKED_IN bar shows ARR');
check(isEffectiveDeparture(checkedIn) === false, 'B. CHECKED_IN has no DEP');
check(isEffectiveArrival(checkedOut) === true, 'C. CHECKED_OUT keeps ARR eligibility');
check(isEffectiveDeparture(checkedOut) === true, 'C. CHECKED_OUT is effective DEP');

console.log('D/S cancel and skipped check-in');
check(isEffectiveArrival(cancelled) === false, 'D. CANCELLED has no ARR');
check(isEffectiveDeparture(cancelled) === false, 'D. CANCELLED has no DEP');
check(isEffectiveArrival(skippedCheckIn) === false, 'S. CHECKED_OUT without checked_in_at has no ARR');
check(isEffectiveDeparture(skippedCheckIn) === false, 'S. CHECKED_OUT without checked_in_at has no DEP');

console.log('K/L duplicate prevention: bar XOR empty-cell ARR');
const visibleBarIds = [reservationMarkerId(checkedIn)];
const occupiedArrivalCell = emptyCellEffectiveMarkers({
  effective_arrivals: [checkedIn],
  effective_departures: [],
}, visibleBarIds);
check(occupiedArrivalCell.arrivals.length === 0, 'K. visible CHECKED_IN bar suppresses empty-cell ARR');
check(occupiedArrivalCell.departures.length === 0, 'K. in-house stay has no empty-cell DEP');

const checkoutCell = emptyCellEffectiveMarkers({
  effective_arrivals: [],
  effective_departures: [checkedOut],
}, visibleBarIds);
check(checkoutCell.departures.length === 1, 'L. empty-cell DEP only from effective departures');
check(reservationMarkerId(checkoutCell.departures[0]) === '103', 'L. DEP belongs to CHECKED_OUT stay');
check(isEffectiveDeparture(checkedIn) === false, 'L. in-house stay is not passed through as DEP');

const completedEmptyCells = emptyCellEffectiveMarkers({
  effective_arrivals: [checkedOut, checkedOut],
  effective_departures: [checkedOut, checkedOut],
}, []);
check(completedEmptyCells.arrivals.length === 1, 'K. duplicate ARR payload collapses for empty cell via bar-id uniqueness later');
check(uniqueMarkerIds(completedEmptyCells.arrivals).length === 1, 'K. one ARR id');
check(uniqueMarkerIds(completedEmptyCells.departures).length === 1, 'L. one DEP id');
check(completedEmptyCells.departures.length === 1, 'L. duplicate DEP payload collapses on empty cell');

console.log('Q/R DAY_USE and overnight spans remain occupancy-only');
const days = [
  { date: '2026-09-05' },
  { date: '2026-09-06' },
  { date: '2026-09-07' },
  { date: '2026-09-08' },
];
const dayUseSpan = getReservationCalendarSpan(dayUseInHouse, days);
check(dayUseSpan?.span === 1, 'Q. DAY_USE bar still occupies one hotel date');
check(isEffectiveArrival(dayUseInHouse) === true, 'Q. DAY_USE CHECKED_IN still shows ARR on the bar');
const overnightSpan = getReservationCalendarSpan(checkedIn, days);
check(overnightSpan?.span === 2, 'R. overnight 06->08 occupancy unchanged');
check(isEffectiveArrival({ ...checkedIn, stay_type: 'OVERNIGHT' }) === true, 'R. multi-day CHECKED_IN still shows ARR');

console.log('planned turnover arrays are not used for empty-cell chips');
const plannedOnlyCell = emptyCellEffectiveMarkers({
  effective_arrivals: [],
  effective_departures: [],
}, []);
check(plannedOnlyCell.arrivals.length === 0, 'empty cell ignores missing effective ARR even if planned arrivals exist elsewhere');
check(plannedOnlyCell.departures.length === 0, 'empty cell ignores missing effective DEP even if planned departures exist elsewhere');

console.log(`\n=== ALL CALENDAR EFFECTIVE MARKER TESTS PASSED (${assertions} assertions) ===`);

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  applyInvalidAvailabilitySelections,
  createAvailabilityRequestFromDraft,
  DAY_USE_OVERLAP_BUFFER_MINUTES,
  eligibleRoomsForRow,
  overlappingSiblingTakesRoom,
  QUICK_BOOKING_NO_TYPES_MESSAGE,
  QUICK_BOOKING_SELECTION_UNAVAILABLE_MESSAGE,
  quickBookingIntervalsOverlap,
  visibleRoomTypesForRow,
  type CreateAvailabilityRoomType,
  type QuickBookingAvailabilityDraft,
} from '../src/features/booking/quickBookingAvailability.ts';

const here = dirname(fileURLToPath(import.meta.url));
const workspaceSrc = readFileSync(join(here, '../src/features/booking/QuickBookingModal.tsx'), 'utf8');
const helperSrc = readFileSync(join(here, '../src/features/booking/quickBookingAvailability.ts'), 'utf8');

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

const deluxeType: CreateAvailabilityRoomType = {
  id: 10,
  code: 'DLX',
  name: 'DELUXE',
  rooms: [
    { id: 101, room_number: '101', floor: '1', name: '101' },
    { id: 102, room_number: '102', floor: '1', name: '102' },
    { id: 103, room_number: '103', floor: '1', name: '103' },
  ],
};

function draft(partial: Partial<QuickBookingAvailabilityDraft> & { id: string }): QuickBookingAvailabilityDraft {
  return {
    roomTypeId: 10,
    roomId: null,
    stayType: 'OVERNIGHT',
    checkIn: '2026-09-07',
    checkOut: '2026-09-09',
    dayUseHours: 6,
    dayUseStartTime: '10:00',
    ...partial,
  };
}

console.log('=== QUICK-BOOKING-ROOMTYPE-AVAILABILITY-1 ===\n');

const overlappingRows = [
  draft({ id: 'r1', roomId: 101 }),
  draft({ id: 'r2' }),
];
check(visibleRoomTypesForRow(overlappingRows, 1, [deluxeType]).length === 1, 'R: type remains while another deluxe room is free');
check(
  eligibleRoomsForRow(overlappingRows, 1, [deluxeType], 10).map((room) => room.id).join(',') === '102,103',
  'S: overlapping sibling removes 101 from row 2'
);
check(overlappingSiblingTakesRoom(overlappingRows, 1, 101) === true, 'S: 101 is taken by overlapping sibling');

const lastTaken = [
  draft({ id: 'r1', roomId: 101 }),
  draft({ id: 'r2', roomId: 102 }),
  draft({ id: 'r3', roomId: 103 }),
  draft({ id: 'r4' }),
];
check(visibleRoomTypesForRow(lastTaken, 3, [deluxeType]).length === 0, 'Q: type disappears when the last eligible room is taken');

const adjacentRows = [
  draft({ id: 'r1', roomId: 101, checkIn: '2026-09-07', checkOut: '2026-09-09' }),
  draft({ id: 'r2', roomId: null, checkIn: '2026-09-09', checkOut: '2026-09-10' }),
];
check(overlappingSiblingTakesRoom(adjacentRows, 1, 101) === false, 'T: same room is reusable on an adjacent non-overlapping row');
check(
  eligibleRoomsForRow(adjacentRows, 1, [deluxeType], 10).some((room) => room.id === 101),
  'T: 101 remains eligible for 9-10 Sep'
);

const dateChangeBefore = [
  draft({ id: 'r1', roomId: 101, checkIn: '2026-09-07', checkOut: '2026-09-09' }),
  draft({ id: 'r2', roomId: 101, checkIn: '2026-09-09', checkOut: '2026-09-10' }),
];
const dateChangeAfter = [
  dateChangeBefore[0],
  { ...dateChangeBefore[1], checkIn: '2026-09-07', checkOut: '2026-09-09' },
];
check(overlappingSiblingTakesRoom(dateChangeBefore, 1, 101) === false, 'U: before date change the sibling is valid');
check(overlappingSiblingTakesRoom(dateChangeAfter, 1, 101) === true, 'U: changing dates recalculates sibling collision');

const cleared = applyInvalidAvailabilitySelections(dateChangeAfter, [[deluxeType], [deluxeType]], { autoPickEmpty: true });
check(cleared.drafts[0].roomId === 101, 'V: valid sibling selection is preserved');
check(cleared.drafts[1].roomId == null, 'V: only the now-invalid sibling room is cleared');
check(cleared.clearedIndexes.includes(1), 'V: cleared index is the invalid row');

check(
  quickBookingIntervalsOverlap(
    { stayType: 'DAY_USE', checkIn: '2026-09-07', checkOut: '2026-09-07', startAt: '2026-09-07T10:00:00', endAt: '2026-09-07T16:00:00' },
    { stayType: 'DAY_USE', checkIn: '2026-09-07', checkOut: '2026-09-07', startAt: '2026-09-07T16:30:00', endAt: '2026-09-07T18:30:00' }
  ) === true,
  'Y: DAY_USE 16:30 start is inside the 60-minute buffer'
);
check(
  quickBookingIntervalsOverlap(
    { stayType: 'DAY_USE', checkIn: '2026-09-07', checkOut: '2026-09-07', startAt: '2026-09-07T10:00:00', endAt: '2026-09-07T16:00:00' },
    { stayType: 'DAY_USE', checkIn: '2026-09-07', checkOut: '2026-09-07', startAt: '2026-09-07T17:00:00', endAt: '2026-09-07T19:00:00' }
  ) === false,
  'Y: DAY_USE exact 60-minute gap is allowed'
);
check(
  quickBookingIntervalsOverlap(
    { stayType: 'OVERNIGHT', checkIn: '2026-09-07', checkOut: '2026-09-09' },
    { stayType: 'DAY_USE', checkIn: '2026-09-07', checkOut: '2026-09-07', startAt: '2026-09-07T10:00:00', endAt: '2026-09-07T16:00:00' }
  ) === true,
  'Y: overnight request blocks a DAY_USE on an occupied hotel date'
);
check(DAY_USE_OVERLAP_BUFFER_MINUTES === 60, 'Y: frontend buffer matches backend 60 minutes');

const request = createAvailabilityRequestFromDraft(7, draft({ id: 'open' }));
check(request?.params.get('property_id') === '7', 'W: availability request is property-scoped and does not need tapechart rooms');
check(request?.params.get('stay_type') === 'OVERNIGHT', 'W: request carries the row stay type');

check(workspaceSrc.includes('/api/bookings/create-availability'), 'W: Quick Booking fetches create-availability directly');
check(!workspaceSrc.includes('isTakenByOther'), 'S: date-blind isTakenByOther is gone');
check(workspaceSrc.includes('overlappingSiblingTakesRoom'), 'S: workspace uses interval-aware sibling collision');
check(workspaceSrc.includes('visibleRoomTypesForRow'), 'Q: workspace filters types from eligible rooms');
check(workspaceSrc.includes('QUICK_BOOKING_NO_TYPES_MESSAGE'), 'X: no-availability copy is wired');
check(workspaceSrc.includes('QUICK_BOOKING_SELECTION_UNAVAILABLE_MESSAGE'), 'X: invalid-selection copy is wired');
check(QUICK_BOOKING_NO_TYPES_MESSAGE.includes('Tidak ada tipe kamar tersedia'), 'X: no-availability copy text is preserved');
check(QUICK_BOOKING_SELECTION_UNAVAILABLE_MESSAGE.includes('sudah tidak tersedia'), 'X: invalid-selection copy text is preserved');
check(helperSrc.includes('DAY_USE_OVERLAP_BUFFER_MINUTES = 60'), 'Y: helper keeps the canonical buffer');

console.log(`\n${assertions} assertions passed.`);

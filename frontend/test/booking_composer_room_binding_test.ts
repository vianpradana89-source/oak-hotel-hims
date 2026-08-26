import assert from 'node:assert/strict';
import {
  additionalBookingChildOverrides,
  canonicalBookingChildRoomId,
  canonicalCalendarRoomBinding,
  canonicalRoomClassification,
  hasOverlappingPriorSiblingRoomSelection,
  removeBookingChildById,
  resolveBookingChildRoomId,
  updateBookingChildById,
  type BookingComposerChildIdentity,
} from '../src/features/booking/bookingComposerState.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

const clickedRoom = {
  id: 61,
  room_number: '103',
  room_type_id: 5,
  room_type_code: 'DLX-T',
  room_type_name: 'DELUXE TWIN',
  room_type_display_order: 20,
  room_category_id: 1,
  room_category_code: 'DLX',
  room_category_name: 'DELUXE',
  room_category_display_order: 10,
};

const binding = canonicalCalendarRoomBinding(clickedRoom);
const r01: BookingComposerChildIdentity = {
  id: 'R01',
  ...binding,
  room_id: resolveBookingChildRoomId({ room_id: binding.room_id }, null),
  room_type_id: binding.room_type_id,
  check_in: '2026-09-01',
  check_out: '2026-09-03',
  room_variant: clickedRoom.room_type_name,
};

check(r01.room_id === 61, 'R01 must bind the clicked canonical room id, not displayed room number 103');
check(r01.room_type_id === 5, 'R01 must bind the clicked canonical room_type_id');
check(r01.room_category_id === 1 && r01.room_category_code === 'DLX', 'R01 must preserve category display metadata');

const r02: BookingComposerChildIdentity = {
  id: 'R02',
  ...additionalBookingChildOverrides(r01, {}),
  room_id: resolveBookingChildRoomId({ room_id: null }, r01.room_id),
  room_type_id: r01.room_type_id,
};
let children = [r01, r02];
check(children[0] === r01 && children[0].room_id === 61, 'adding R02 must not rebuild or clear R01');
check(r02.room_id === null, 'R02 must start without a physical room');
check(r02.room_type_id === r01.room_type_id, 'R02 may inherit the canonical leaf room type');
check(r02.check_in === r01.check_in && r02.check_out === r01.check_out, 'R02 may inherit booking dates');

const r03: BookingComposerChildIdentity = {
  id: 'R03',
  ...additionalBookingChildOverrides(r01, {}),
  room_id: null,
  room_type_id: r01.room_type_id,
};
const beforeR03 = children;
children = [...children, r03];
check(children[0] === beforeR03[0] && children[1] === beforeR03[1], 'adding R03 must not mutate R01 or R02');

children = removeBookingChildById(children, 'R02');
check(children[0] === r01 && children[0].room_id === 61, 'removing R02 must preserve R01');

children = [r01, r02];
const changedR02 = updateBookingChildById(children, 'R02', {
  room_id: 62,
  ...canonicalRoomClassification({ ...clickedRoom, id: 62, room_type_id: 2, room_type_code: 'STD-T' }),
});
check(changedR02[0] === r01 && changedR02[0].room_id === 61, 'changing R02 type/room must preserve R01');
check(changedR02[1].room_id === 62 && changedR02[1].room_type_id === 2, 'R02 must keep its independent selection');

check(
  hasOverlappingPriorSiblingRoomSelection([r01, r02], 'R02', 61, r02.check_in, r02.check_out),
  'R02 options must exclude R01 room for overlapping dates',
);
check(
  !hasOverlappingPriorSiblingRoomSelection([r01, r02], 'R02', 61, r01.check_out, '2026-09-04'),
  'exclusive checkout must allow the same room for a non-overlapping stay',
);
check(
  !hasOverlappingPriorSiblingRoomSelection([r01, { ...r02, room_id: 61 }], 'R01', 61, r01.check_in, r01.check_out),
  'a later child must never invalidate the established R01 binding',
);

const payloadRoomIds = changedR02.map(canonicalBookingChildRoomId);
assert.deepEqual(payloadRoomIds, [61, 62], 'payload room identities must preserve independent canonical selections');
assertions += 1;

check(resolveBookingChildRoomId({ room_id: null }, 61) === null, 'explicit unassigned room must never fall back to R01');
check(!JSON.stringify(binding).includes('DELUXE TWIN:61'), 'room identity must not be synthesized from display names');

console.log(`booking composer room-binding assertions=${assertions}`);

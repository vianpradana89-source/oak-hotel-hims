const {
  isEffectiveArrival,
  isEffectiveDeparture,
  listEffectiveArrivalsForDate,
  listEffectiveDeparturesForDate,
  reservationOccupiesTapechartDate,
  toTapechartCellReservation,
} = require('../dist/utils/tapechartReservation');
const { hotelDateKey } = require('../dist/utils/hotelDate');

let assertions = 0;

function expect(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
}

function plannedArrivals(rows, dateStr) {
  return rows.filter((row) => hotelDateKey(row.check_in) === dateStr);
}

function plannedDepartures(rows, dateStr) {
  return rows.filter((row) => hotelDateKey(row.check_out) === dateStr);
}

function markersByRoom(rooms, dateStr, kind) {
  const found = [];
  for (const [roomId, rows] of Object.entries(rooms)) {
    const markers = kind === 'arr'
      ? listEffectiveArrivalsForDate(rows, dateStr)
      : listEffectiveDeparturesForDate(rows, dateStr);
    for (const marker of markers) {
      found.push({ roomId: Number(roomId), marker });
    }
  }
  return found;
}

const checkInAt = '2026-09-06T07:00:00.000Z';
const checkOutAt = '2026-09-08T03:00:00.000Z';

const booked = {
  id: 101,
  reservation_id: 101,
  room_id: 103,
  guest_name: 'Booked Guest',
  check_in: '2026-09-06',
  check_out: '2026-09-08',
  stay_type: 'OVERNIGHT',
  status: 'BOOKED',
  stay_status: 'RESERVED',
  checked_in_at: null,
  checked_out_at: null,
};

const checkedIn = {
  ...booked,
  id: 102,
  reservation_id: 102,
  guest_name: 'In House',
  status: 'CHECKED_IN',
  stay_status: 'IN_HOUSE',
  checked_in_at: checkInAt,
};

const checkedOut = {
  ...checkedIn,
  id: 103,
  reservation_id: 103,
  guest_name: 'Departed',
  status: 'CHECKED_OUT',
  stay_status: 'DEPARTED',
  checked_out_at: checkOutAt,
};

const cancelled = {
  ...booked,
  id: 104,
  reservation_id: 104,
  guest_name: 'Cancelled',
  status: 'CANCELLED',
  stay_status: 'CANCELLED',
};

const skippedCheckIn = {
  ...booked,
  id: 105,
  reservation_id: 105,
  guest_name: 'Skip CI',
  status: 'CHECKED_OUT',
  stay_status: 'DEPARTED',
  checked_in_at: null,
  checked_out_at: checkOutAt,
};

const dayUseBooked = {
  id: 201,
  reservation_id: 201,
  room_id: 201,
  guest_name: 'Day Use Booked',
  check_in: '2026-09-06',
  check_out: '2026-09-06',
  stay_type: 'DAY_USE',
  status: 'BOOKED',
  stay_status: 'RESERVED',
  checked_in_at: null,
  checked_out_at: null,
};

const dayUseInHouse = {
  ...dayUseBooked,
  id: 202,
  reservation_id: 202,
  guest_name: 'Day Use In House',
  status: 'CHECKED_IN',
  stay_status: 'IN_HOUSE',
  checked_in_at: checkInAt,
};

const dayUseDeparted = {
  ...dayUseInHouse,
  id: 203,
  reservation_id: 203,
  guest_name: 'Day Use Departed',
  status: 'CHECKED_OUT',
  stay_status: 'DEPARTED',
  checked_out_at: '2026-09-06T09:00:00.000Z',
};

const overnightOneNight = {
  ...checkedIn,
  id: 301,
  reservation_id: 301,
  check_out: '2026-09-07',
};

const reservedQty = Object.freeze({ room_type_id: 1, date: '2026-09-06', reserved_qty: 4 });

console.log('=== OAK HIMS Tapechart Effective ARR/DEP Marker Contract ===\n');

console.log('A. BOOKED -> no ARR/DEP');
expect(isEffectiveArrival(booked) === false, 'A. BOOKED is not an effective arrival');
expect(isEffectiveDeparture(booked) === false, 'A. BOOKED is not an effective departure');
expect(listEffectiveArrivalsForDate([booked], '2026-09-06').length === 0, 'A. no effective ARR on planned arrival date');
expect(listEffectiveDeparturesForDate([booked], '2026-09-08').length === 0, 'A. no effective DEP on planned departure date');

console.log('B. CHECKED_IN + checked_in_at -> ARR only');
expect(isEffectiveArrival(checkedIn) === true, 'B. CHECKED_IN with timestamp is effective ARR');
expect(isEffectiveDeparture(checkedIn) === false, 'B. CHECKED_IN is not effective DEP');
expect(listEffectiveArrivalsForDate([checkedIn], '2026-09-06').length === 1, 'B. ARR placed on hotel check_in date');
expect(listEffectiveDeparturesForDate([checkedIn], '2026-09-08').length === 0, 'B. no DEP while in-house');

console.log('C. CHECKED_OUT + both timestamps -> ARR + DEP');
expect(isEffectiveArrival(checkedOut) === true, 'C. completed stay keeps effective ARR');
expect(isEffectiveDeparture(checkedOut) === true, 'C. completed stay is effective DEP');
expect(listEffectiveArrivalsForDate([checkedOut], '2026-09-06')[0].id === 103, 'C. ARR on check_in hotel date');
expect(listEffectiveDeparturesForDate([checkedOut], '2026-09-08')[0].id === 103, 'C. DEP on check_out hotel date');

console.log('D. CANCELLED before check-in -> none');
expect(isEffectiveArrival(cancelled) === false, 'D. CANCELLED is not ARR');
expect(isEffectiveDeparture(cancelled) === false, 'D. CANCELLED is not DEP');
expect(listEffectiveArrivalsForDate([cancelled], '2026-09-06').length === 0, 'D. cancelled planned arrival has no marker');

console.log('E. planned arrival reached but still BOOKED -> no ARR');
expect(listEffectiveArrivalsForDate([booked], '2026-09-06').length === 0, 'E. BOOKED on arrival date still has no ARR');
expect(plannedArrivals([booked], '2026-09-06').length === 1, 'E. planned turnover arrival still includes BOOKED');

console.log('F. planned checkout reached but still CHECKED_IN -> no DEP');
expect(listEffectiveDeparturesForDate([checkedIn], '2026-09-08').length === 0, 'F. in-house guest has no DEP on planned checkout date');
expect(plannedDepartures([checkedIn], '2026-09-08').length === 1, 'F. planned turnover departure still includes CHECKED_IN');

console.log('G-I. room move follows current room_id, never old rooms');
const stay103 = { ...checkedIn, id: 401, reservation_id: 401, room_id: 103 };
const afterMove105 = { ...stay103, room_id: 105 };
const afterMove107 = { ...stay103, room_id: 107 };
const afterCheckout107 = { ...afterMove107, status: 'CHECKED_OUT', stay_status: 'DEPARTED', checked_out_at: checkOutAt };

let rooms = { 103: [stay103], 105: [], 107: [] };
let arr = markersByRoom(rooms, '2026-09-06', 'arr');
expect(arr.length === 1 && arr[0].roomId === 103, 'G. ARR starts on check-in room 103');

rooms = { 103: [], 105: [afterMove105], 107: [] };
arr = markersByRoom(rooms, '2026-09-06', 'arr');
expect(arr.length === 1 && arr[0].roomId === 105, 'G. after move 103->105 ARR only on 105');
expect(listEffectiveArrivalsForDate(rooms[103], '2026-09-06').length === 0, 'G. ARR disappeared from 103');

rooms = { 103: [], 105: [], 107: [afterMove107] };
arr = markersByRoom(rooms, '2026-09-06', 'arr');
expect(arr.length === 1 && arr[0].roomId === 107, 'H. second move 105->107 ARR only on 107');
expect(listEffectiveArrivalsForDate(rooms[105], '2026-09-06').length === 0, 'H. ARR disappeared from 105');

rooms = { 103: [], 105: [], 107: [afterCheckout107] };
arr = markersByRoom(rooms, '2026-09-06', 'arr');
const dep = markersByRoom(rooms, '2026-09-08', 'dep');
expect(arr.length === 1 && arr[0].roomId === 107, 'I. checkout ARR remains on final room 107');
expect(dep.length === 1 && dep[0].roomId === 107, 'I. checkout DEP on final room 107');
expect(listEffectiveDeparturesForDate(rooms[105], '2026-09-08').length === 0, 'I. no DEP copied onto old room');

console.log('J. failed move keeps marker on existing room');
const failedMoveRooms = { 103: [stay103], 105: [] };
arr = markersByRoom(failedMoveRooms, '2026-09-06', 'arr');
expect(arr.length === 1 && arr[0].roomId === 103, 'J. failed move leaves ARR on 103');
expect(listEffectiveArrivalsForDate(failedMoveRooms[105], '2026-09-06').length === 0, 'J. target room has no copied ARR');

console.log('K-L. no duplicate ARR/DEP per reservation');
const duplicatedRow = [checkedOut, { ...checkedOut }];
const uniqueArr = listEffectiveArrivalsForDate(duplicatedRow, '2026-09-06');
const uniqueDep = listEffectiveDeparturesForDate(duplicatedRow, '2026-09-08');
expect(uniqueArr.length === 1, 'K. duplicate source rows collapse to one ARR');
expect(uniqueDep.length === 1, 'L. duplicate source rows collapse to one DEP');

console.log('M. planned turnover arrays remain date/status-unaware');
const mixed = [booked, checkedIn, checkedOut, cancelled];
expect(plannedArrivals(mixed, '2026-09-06').length === 4, 'M. planned arrivals still include BOOKED/CANCELLED/in-house/departed');
expect(plannedDepartures(mixed, '2026-09-08').length === 4, 'M. planned departures still include all planned check_out dates');
expect(listEffectiveArrivalsForDate(mixed, '2026-09-06').map((row) => row.id).join(',') === '102,103', 'M. effective ARR is a separate projection');
expect(listEffectiveDeparturesForDate(mixed, '2026-09-08').map((row) => row.id).join(',') === '103', 'M. effective DEP is a separate projection');

console.log('N. housekeeping/turnover occupancy helper unchanged');
expect(reservationOccupiesTapechartDate(booked, '2026-09-06') === true, 'N. BOOKED still occupies arrival night');
expect(reservationOccupiesTapechartDate(checkedIn, '2026-09-07') === true, 'N. in-house still occupies intervening night');
expect(reservationOccupiesTapechartDate(checkedOut, '2026-09-08') === false, 'N. checkout date remains exclusive');

console.log('O. marker projection does not rewrite move/audit-shaped history');
const moveHistory = Object.freeze([
  Object.freeze({ from_room_id: 103, to_room_id: 105, moved_at: '2026-09-06T08:00:00.000Z' }),
]);
listEffectiveArrivalsForDate([afterMove105], '2026-09-06');
expect(moveHistory[0].from_room_id === 103 && moveHistory[0].to_room_id === 105, 'O. room-move history object remains untouched');

console.log('P. marker GET/render helper does not mutate reserved_qty');
listEffectiveArrivalsForDate([checkedIn], '2026-09-06');
listEffectiveDeparturesForDate([checkedOut], '2026-09-08');
expect(reservedQty.reserved_qty === 4, 'P. reserved_qty snapshot unchanged by marker helper');

console.log('Q. DAY_USE lifecycle');
expect(listEffectiveArrivalsForDate([dayUseBooked], '2026-09-06').length === 0, 'Q. DAY_USE BOOKED has no ARR');
expect(listEffectiveArrivalsForDate([dayUseInHouse], '2026-09-06').length === 1, 'Q. DAY_USE CHECKED_IN has ARR');
expect(listEffectiveDeparturesForDate([dayUseInHouse], '2026-09-06').length === 0, 'Q. DAY_USE CHECKED_IN has no DEP');
expect(listEffectiveArrivalsForDate([dayUseDeparted], '2026-09-06').length === 1, 'Q. DAY_USE CHECKED_OUT keeps ARR');
expect(listEffectiveDeparturesForDate([dayUseDeparted], '2026-09-06').length === 1, 'Q. DAY_USE CHECKED_OUT has DEP on check_out hotel date');
expect(reservationOccupiesTapechartDate(dayUseDeparted, '2026-09-06') === true, 'Q. DAY_USE occupancy stays on check_in date');
expect(reservationOccupiesTapechartDate(dayUseDeparted, '2026-09-07') === false, 'Q. DAY_USE does not occupy the next hotel date');

console.log('R. overnight / multi-day placement uses hotel dates, not UTC timestamp dates');
expect(listEffectiveArrivalsForDate([overnightOneNight], '2026-09-06').length === 1, 'R. 1-night ARR on check_in hotel date');
expect(listEffectiveArrivalsForDate([overnightOneNight], '2026-09-07').length === 0, 'R. 1-night ARR is not placed on checkout date');
expect(listEffectiveArrivalsForDate([checkedOut], '2026-09-05').length === 0, 'R. ARR is not moved to UTC calendar date of checked_in_at');
expect(listEffectiveDeparturesForDate([checkedOut], '2026-09-08').length === 1, 'R. multi-day DEP on planned check_out hotel date');
expect(listEffectiveDeparturesForDate([checkedOut], '2026-09-07').length === 0, 'R. DEP is not placed on UTC date of checked_out_at');

console.log('S. CHECKED_OUT without checked_in_at -> no fake ARR/DEP');
expect(isEffectiveArrival(skippedCheckIn) === false, 'S. skipped check-in cannot be effective ARR');
expect(isEffectiveDeparture(skippedCheckIn) === false, 'S. skipped check-in cannot be effective DEP');
expect(listEffectiveArrivalsForDate([skippedCheckIn], '2026-09-06').length === 0, 'S. no ARR marker');
expect(listEffectiveDeparturesForDate([skippedCheckIn], '2026-09-08').length === 0, 'S. no DEP marker');

const dto = toTapechartCellReservation(checkedOut);
expect(dto.room_id === 103, 'DTO exposes current room_id');
expect(dto.stay_status === 'DEPARTED', 'DTO exposes stay_status');
expect(dto.checked_in_at === checkInAt, 'DTO exposes checked_in_at as ISO');
expect(dto.checked_out_at === checkOutAt, 'DTO exposes checked_out_at as ISO');
expect(dto.check_in === '2026-09-06', 'DTO keeps hotel-date check_in');
expect(dto.status === 'CHECKED_OUT', 'DTO keeps lifecycle status');

console.log(`\n=== PASS | ${assertions} assertions ===`);

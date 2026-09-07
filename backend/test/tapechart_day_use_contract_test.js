const {
  reservationOccupiesTapechartDate,
  toTapechartCellReservation,
} = require('../dist/utils/tapechartReservation');

let assertions = 0;

function expect(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
}

function cellReservations(rows, dateStr) {
  return rows
    .filter((row) => reservationOccupiesTapechartDate(row, dateStr))
    .map((row) => toTapechartCellReservation(row));
}

const dayUse = {
  id: 501,
  reservation_id: 501,
  booking_id: 80,
  bid: 'LWG-DU-1',
  stay_sequence: 1,
  guest_name: 'Day Use Guest',
  guest_phone: '0800',
  guest_segment: 'REGULAR',
  booking_number: 'BK-DU-1',
  legacy_booking_number: 'BK-DU-1',
  booking_type: 'WALK_IN',
  payment_status: 'PAID',
  check_in: '2026-09-06',
  check_out: '2026-09-06',
  stay_type: 'DAY_USE',
  start_at: '2026-09-06T10:00:00+07:00',
  end_at: '2026-09-06T16:00:00+07:00',
  status: 'BOOKED',
};

const sameDayOvernight = {
  id: 502,
  check_in: '2026-09-06',
  check_out: '2026-09-06',
  stay_type: 'OVERNIGHT',
  start_at: null,
  end_at: null,
  status: 'BOOKED',
};

const oneNight = {
  id: 503,
  check_in: '2026-09-06',
  check_out: '2026-09-07',
  stay_type: 'OVERNIGHT',
  start_at: null,
  end_at: null,
  status: 'BOOKED',
};

const multiNight = {
  id: 504,
  check_in: '2026-09-06',
  check_out: '2026-09-08',
  stay_type: 'OVERNIGHT',
  start_at: null,
  end_at: null,
  status: 'BOOKED',
};

const onCheckIn = cellReservations([dayUse], '2026-09-06');
expect(onCheckIn.length === 1, 'DAY_USE check_in === check_out is included on its check_in hotel date');
expect(onCheckIn[0].id === 501, 'DAY_USE cell reservation keeps its id');
expect(onCheckIn[0].stay_type === 'DAY_USE', 'DAY_USE DTO exposes stay_type');
expect(onCheckIn[0].start_at === '2026-09-06T10:00:00+07:00', 'DAY_USE DTO exposes canonical start_at');
expect(onCheckIn[0].end_at === '2026-09-06T16:00:00+07:00', 'DAY_USE DTO exposes canonical end_at');
expect(onCheckIn[0].check_in === '2026-09-06', 'DAY_USE DTO keeps hotel-date check_in');
expect(onCheckIn[0].check_out === '2026-09-06', 'DAY_USE DTO keeps hotel-date check_out');

const nextDay = cellReservations([dayUse], '2026-09-07');
expect(nextDay.length === 0, 'DAY_USE is not included on the following hotel date');

const prevDay = cellReservations([dayUse], '2026-09-05');
expect(prevDay.length === 0, 'DAY_USE is not included on the previous hotel date');

expect(
  reservationOccupiesTapechartDate(sameDayOvernight, '2026-09-06') === false,
  'same-day non-DAY_USE remains excluded'
);
expect(
  cellReservations([sameDayOvernight], '2026-09-06').length === 0,
  'same-day overnight does not appear in the cell DTO list'
);

expect(reservationOccupiesTapechartDate(oneNight, '2026-09-06') === true, '1-night stay occupies check_in date');
expect(reservationOccupiesTapechartDate(oneNight, '2026-09-07') === false, '1-night stay does not occupy checkout date');

expect(reservationOccupiesTapechartDate(multiNight, '2026-09-06') === true, 'multi-night stay occupies check_in date');
expect(reservationOccupiesTapechartDate(multiNight, '2026-09-07') === true, 'multi-night stay occupies intervening night');
expect(reservationOccupiesTapechartDate(multiNight, '2026-09-08') === false, 'multi-night stay does not occupy checkout date');

const overnightDto = toTapechartCellReservation({
  ...oneNight,
  reservation_id: 503,
  booking_id: 81,
  bid: 'LWG-ON-1',
  guest_name: 'Overnight Guest',
});
expect(Object.prototype.hasOwnProperty.call(overnightDto, 'stay_type'), 'overnight DTO still includes stay_type');
expect(Object.prototype.hasOwnProperty.call(overnightDto, 'start_at'), 'overnight DTO still includes start_at');
expect(Object.prototype.hasOwnProperty.call(overnightDto, 'end_at'), 'overnight DTO still includes end_at');
expect(Object.prototype.hasOwnProperty.call(overnightDto, 'room_id'), 'overnight DTO exposes room_id for effective markers');
expect(Object.prototype.hasOwnProperty.call(overnightDto, 'stay_status'), 'overnight DTO exposes stay_status');
expect(Object.prototype.hasOwnProperty.call(overnightDto, 'checked_in_at'), 'overnight DTO exposes checked_in_at');
expect(Object.prototype.hasOwnProperty.call(overnightDto, 'checked_out_at'), 'overnight DTO exposes checked_out_at');
expect(overnightDto.guest_name === 'Overnight Guest', 'existing DTO fields are preserved');
expect(onCheckIn[0].checked_in_at === null, 'BOOKED DAY_USE DTO keeps checked_in_at null');
expect(onCheckIn[0].status === 'BOOKED', 'BOOKED DAY_USE occupancy DTO status is unchanged');

console.log('Tapechart Day Use contract');
console.log(`PASS | ${assertions} assertions`);
console.log('PASS | DAY_USE same-day included only on check_in date');
console.log('PASS | DTO exposes stay_type, start_at, end_at');
console.log('PASS | same-day overnight excluded; 1-night and multi-night unchanged');

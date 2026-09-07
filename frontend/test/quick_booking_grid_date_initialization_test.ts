import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createAvailabilityRequestFromDraft,
  createAvailabilityRequestKey,
  type QuickBookingAvailabilityDraft,
} from '../src/features/booking/quickBookingAvailability.ts';
import {
  bumpOvernightCheckoutIfNeeded,
  overnightNights,
  resolveOvernightStayDates,
} from '../src/features/booking/quickBookingDates.ts';

const here = dirname(fileURLToPath(import.meta.url));
const modalSrc = readFileSync(join(here, '../src/features/booking/QuickBookingModal.tsx'), 'utf8');
const helperSrc = readFileSync(join(here, '../src/features/booking/quickBookingDates.ts'), 'utf8');
const availabilitySrc = readFileSync(
  join(here, '../src/features/booking/quickBookingAvailability.ts'),
  'utf8'
);
const backendAvailabilitySrc = readFileSync(
  join(here, '../../backend/src/domains/reservations/reservationEditService.ts'),
  'utf8'
);

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

function overnightDraft(
  checkIn: string,
  checkOut: string,
  extra: Partial<QuickBookingAvailabilityDraft> = {}
): QuickBookingAvailabilityDraft {
  return {
    id: 'row-1',
    roomTypeId: 10,
    roomId: 101,
    stayType: 'OVERNIGHT',
    checkIn,
    checkOut,
    dayUseHours: 6,
    dayUseStartTime: '10:00',
    ...extra,
  };
}

console.log('=== OAK HIMS Quick Booking Grid Date Initialization ===\n');

const from07 = resolveOvernightStayDates('2026-09-07');
check(from07.checkIn === '2026-09-07' && from07.checkOut === '2026-09-08', 'A. Grid 07 Sep => 07 -> 08');
check(overnightNights(from07.checkIn, from07.checkOut) === 1, 'A. Grid 07 Sep duration is 1 night');

const from08 = resolveOvernightStayDates('2026-09-08');
check(from08.checkIn === '2026-09-08' && from08.checkOut === '2026-09-09', 'B. close then Grid 08 Sep => 08 -> 09');
check(from08.checkOut !== from07.checkOut, 'B. 08 Sep checkout is not leftover 08 Sep');

const from09 = resolveOvernightStayDates('2026-09-09');
check(from09.checkIn === '2026-09-09' && from09.checkOut === '2026-09-10', 'C. close then Grid 09 Sep => 09 -> 10');

const from10 = resolveOvernightStayDates('2026-09-10');
check(from10.checkIn === '2026-09-10' && from10.checkOut === '2026-09-11', 'C. Grid 10 Sep => 10 -> 11');

const reopenSequence = ['2026-09-07', '2026-09-08', '2026-09-09'].map((date) =>
  resolveOvernightStayDates(date)
);
check(
  reopenSequence[0].checkOut === '2026-09-08' &&
    reopenSequence[1].checkOut === '2026-09-09' &&
    reopenSequence[2].checkOut === '2026-09-10',
  'D. repeated reopen never keeps previous checkout'
);
check(
  reopenSequence[1].checkOut !== reopenSequence[0].checkOut &&
    reopenSequence[2].checkOut !== reopenSequence[1].checkOut,
  'D. each Grid date produces a new D+1 checkout'
);

const futureIntervals = [
  createAvailabilityRequestFromDraft(7, overnightDraft('2026-09-08', '2026-09-09')),
  createAvailabilityRequestFromDraft(7, overnightDraft('2026-09-09', '2026-09-10')),
  createAvailabilityRequestFromDraft(7, overnightDraft('2026-09-10', '2026-09-11')),
];
check(
  futureIntervals.every((request) => request != null),
  'E. future D/D+1 overnight drafts produce a valid availability request'
);
check(
  futureIntervals[0]?.params.get('check_in') === '2026-09-08' &&
    futureIntervals[0]?.params.get('check_out') === '2026-09-09' &&
    futureIntervals[0]?.params.get('stay_type') === 'OVERNIGHT',
  'E. 08 Sep availability request is 08 -> 09 OVERNIGHT'
);

check(
  bumpOvernightCheckoutIfNeeded('2026-09-10', '2026-09-09') === '2026-09-11',
  'F. manual check-in >= checkout advances checkout to new check-in + 1'
);
check(
  bumpOvernightCheckoutIfNeeded('2026-09-08', '2026-09-08') === '2026-09-09',
  'F. equal overnight dates bump checkout +1 hotel day'
);

check(
  bumpOvernightCheckoutIfNeeded('2026-09-08', '2026-09-12') === '2026-09-12',
  'G. manual check-in still before checkout preserves checkout'
);

const dayUseDraft: QuickBookingAvailabilityDraft = {
  id: 'day-use',
  roomTypeId: 10,
  roomId: 101,
  stayType: 'DAY_USE',
  checkIn: '2026-09-08',
  checkOut: '2026-09-08',
  dayUseHours: 6,
  dayUseStartTime: '10:00',
};
const dayUseRequest = createAvailabilityRequestFromDraft(7, dayUseDraft);
check(dayUseDraft.checkIn === dayUseDraft.checkOut, 'H. DAY_USE same hotel date is valid');
check(dayUseRequest != null, 'H. DAY_USE same-date still builds an availability request');
check(
  modalSrc.includes("stayType: 'DAY_USE'") &&
    modalSrc.includes('checkOut: roomDraft.checkIn'),
  'H. DAY_USE toggle still sets checkout to the same hotel date'
);
check(
  modalSrc.includes("checkIn: e.target.value, checkOut: e.target.value"),
  'H. DAY_USE date change keeps same-date check-in/check-out'
);

check(
  modalSrc.includes('initialDate !== prevInitialDate') &&
    modalSrc.includes('setRoomsList([createInitialRoomDraft(0, initialRoomId)])') &&
    modalSrc.includes('roomId: initRId'),
  'I. fresh open rebuilds one draft from current initialRoomId and initialDate'
);
check(
  /}, \[isOpen, initialRoomId, initialDate, createInitialRoomDraft, resetQuickBookingState\]\)/.test(
    modalSrc
  ),
  'I. reset effect dependencies include initialDate'
);

const key08 = createAvailabilityRequestKey({
  propertyId: 7,
  stayType: 'OVERNIGHT',
  checkIn: '2026-09-08',
  checkOut: '2026-09-09',
});
const key07 = createAvailabilityRequestKey({
  propertyId: 7,
  stayType: 'OVERNIGHT',
  checkIn: '2026-09-07',
  checkOut: '2026-09-08',
});
check(key07 === '7|OVERNIGHT|2026-09-07|2026-09-08', 'J. 07 Sep cache key is property|OVERNIGHT|D|D+1');
check(key08 === '7|OVERNIGHT|2026-09-08|2026-09-09', 'J. 08 Sep cache key is property|OVERNIGHT|D|D+1');
check(key07 !== key08, 'J. availability key changes with new D/D+1 and does not reuse 07->08');
check(
  modalSrc.includes('setAvailabilityByKey({})') &&
    modalSrc.includes('availabilityRequestRef.current += 1'),
  'J. fresh modal open still clears availabilityByKey'
);

check(!modalSrc.includes('tomorrowStr'), 'K. mount-time tomorrowStr is gone from QuickBookingModal');
check(
  !modalSrc.includes("checkOut: tomorrowStr") &&
    modalSrc.includes('resolveOvernightStayDates(initialDate)'),
  'K. overnight checkout is derived from initialDate via resolveOvernightStayDates'
);
check(
  helperSrc.includes('addHotelDays') &&
    helperSrc.includes('hotelDateFromInstant') &&
    helperSrc.includes('normalizeHotelDate'),
  'K. overnight helpers reuse canonical hotel-date utilities'
);
check(
  !modalSrc.includes('d.setDate(d.getDate() + 1)') &&
    !modalSrc.includes("toISOString().slice(0, 10)"),
  'K. overnight bump no longer uses raw Date/toISOString hotel arithmetic'
);

check(
  createAvailabilityRequestFromDraft(7, overnightDraft('2026-09-08', '2026-09-08')) == null,
  'L. frontend still skips OVERNIGHT 08 -> 08 availability fetch'
);
check(
  availabilitySrc.includes('if (!checkIn || !checkOut || checkIn >= checkOut) return null'),
  'L. frontend invalid-interval guard is unchanged'
);
check(
  backendAvailabilitySrc.includes('if (!isValidHotelDate(checkOutInput) || checkIn >= checkOutInput)'),
  'L. backend OVERNIGHT check_out > check_in rejection is untouched'
);

console.log(`\n=== ALL QUICK BOOKING GRID DATE INITIALIZATION TESTS PASSED (${assertions} assertions) ===`);

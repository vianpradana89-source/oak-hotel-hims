/**
 * Pure helpers for QuickBookingModal Day-Use clock initialisation.
 *
 * Two responsibilities:
 * 1. Convert a captured "open instant" (ISO UTC) into the property-timezone
 *    wall-clock, rounded up to the 15-minute interval.
 * 2. Apply the resulting clock data to room drafts that are still eligible
 *    for automatic seeding, respecting per-room dirty flags so that
 *    manual edits (time or date) are never overwritten.
 *
 * Both functions are pure (no side-effects, no module-level state) so that
 * the full initialisation path can be exercised in a unit test without
 * mounting React components.
 */

import { roundUpHotelTimestamp } from './dayUseInterval.ts';
import { addHotelDays } from '../calendar/calendarDates.ts';

// ─────────────────────────────────────────────────────────────────────────────
// QB-R2-04: Clock status for UI surfacing.
// 'pending' → tz fetch in flight; 'ready' → clockData present; 'error' →
// non-OK / invalid / network failure. OVERNIGHT is NOT gated by this state.
// ─────────────────────────────────────────────────────────────────────────────
export type DayUseClockStatus = 'pending' | 'ready' | 'error';

export interface DayUseClockState {
  status: DayUseClockStatus;
  /** Present only when status === 'ready' */
  data: DayUseClockData | null;
  /** Present only when status === 'error' */
  error: string | null;
}

export const INITIAL_CLOCK_STATE: DayUseClockState = {
  status: 'pending',
  data: null,
  error: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Type for a single room draft (mirror of QuickBookingModal's RoomDraft,
// narrowed to the fields the seed logic actually needs).
// ─────────────────────────────────────────────────────────────────────────────
export interface DayUseRoomDraft {
  id: string;
  stayType: 'OVERNIGHT' | 'DAY_USE';
  checkIn: string;
  checkOut: string;
  dayUseStartTime: string;
  /** true once the user has manually edited the start-time input */
  duTimeSeeded: boolean;
  /** true once the user has manually edited the Day-Use date input */
  duDateSeeded: boolean;
}

/** Clock data computed from the property-timezone open instant. */
export interface DayUseClockData {
  /** Rounded-up HH:mm in property timezone */
  time: string;
  /** The hotel-local date portion of the open instant */
  hotelDate: string;
  /** true when rounding caused a rollover past midnight (start = 00:00 next day) */
  datePlusOne: boolean;
}

/**
 * Convert a captured open instant (ISO-8601 UTC, e.g. "2026-11-10T03:07:00Z")
 * to the property's timezone and return the rounded-up 15-min start time.
 *
 * If the timezone string is invalid or the open instant is missing, returns
 * `{ ok: false, error }` so the caller can surface a clear pending/error
 * state instead of silently falling back to host-local time.
 */
export function hotelNowFromInstant(
  openInstantISO: string | null | undefined,
  propertyTimezone: string,
):
  | ({ ok: true } & DayUseClockData)
  | { ok: false; error: string } {
  if (!openInstantISO) {
    return { ok: false, error: 'Open instant belum tersedia' };
  }
  const openDate = new Date(openInstantISO);
  if (Number.isNaN(openDate.getTime())) {
    return { ok: false, error: 'Open instant tidak valid' };
  }

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: propertyTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(openDate);
  } catch {
    return { ok: false, error: `Timezone properti tidak valid: ${propertyTimezone}` };
  }

  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '00';
  const hotelDate = `${get('year')}-${get('month')}-${get('day')}`;
  const rawTime = `${get('hour')}:${get('minute')}:${get('second')}`;
  const timestamp = `${hotelDate}T${rawTime}`;

  const rounded = roundUpHotelTimestamp(timestamp, 15);
  return {
    ok: true,
    time: rounded.datePlusOne ? '00:00' : rounded.time,
    datePlusOne: rounded.datePlusOne,
    hotelDate,
  };
}

/**
 * Seed eligible room drafts with the computed day-use start time.
 *
 * Seeding rules:
 * - A draft's start-time is updated ONLY when `duTimeSeeded` is `false`.
 * - For DAY_USE drafts with rollover (datePlusOne=true), checkIn/checkOut are
 *   shifted to the next hotel date ONLY when `duDateSeeded` is `false`.
 * - OVERNIGHT drafts: start-time is updated but checkIn/checkOut are never
 *   modified by this function.
 *
 * This function is idempotent: calling it a second time with the same
 * clock data on already-seeded drafts produces no further changes.
 */
export function applyDayUseSeed<T extends DayUseRoomDraft>(
  rooms: T[],
  clock: DayUseClockData,
): T[] {
  if (clock.datePlusOne) {
    // Effective date for DAY_USE with rollover is the next hotel date
    // (the roundUpHotelTimestamp helper already sets time to '00:00').
  }
  const nextHotelDate = clock.datePlusOne
    ? addHotelDays(clock.hotelDate, 1)
    : clock.hotelDate;

  return rooms.map((room) => {
    // Protect manually-set start time
    if (room.duTimeSeeded) {
      // Still apply date rollover for DAY_USE if date wasn't touched
      if (room.stayType === 'DAY_USE' && !room.duDateSeeded && clock.datePlusOne) {
        return {
          ...room,
          checkIn: nextHotelDate,
          checkOut: nextHotelDate,
        };
      }
      return room;
    }

    const isDayUse = room.stayType === 'DAY_USE';

    // OVERNIGHT: only update dayUseStartTime; never touch dates
    if (!isDayUse) {
      return { ...room, dayUseStartTime: clock.time, duTimeSeeded: true };
    }

    // DAY_USE: update dayUseStartTime + handle date
    let newCheckIn: string;
    let newCheckOut: string;
    if (clock.datePlusOne && !room.duDateSeeded) {
      // Rollover: use the next hotel date
      newCheckIn = nextHotelDate;
      newCheckOut = nextHotelDate;
    } else {
      // No rollover or date was manually set: keep existing checkIn
      newCheckIn = room.checkIn;
      newCheckOut = room.checkIn; // DAY_USE: checkOut = checkIn (same hotel day)
    }

    return {
      ...room,
      dayUseStartTime: clock.time,
      checkIn: newCheckIn,
      checkOut: newCheckOut,
      duTimeSeeded: true,
      // QB-R2-02 fix: never clear duDateSeeded.
      // - If the user manually set the date (duDateSeeded=true), that protection
      //   must survive any subsequent seed/reseed regardless of datePlusOne.
      // - If the date was auto-seeded by a previous rollover, it stays false so
      //   that a second identical seed is idempotent (no flag flip).
      // - If datePlusOne and the date was auto-shifted, mark it as auto-seeded
      //   (duDateSeeded=false) so the "auto default" is still eligible for
      //   future rollover corrections — the calendar/manual provenance is
      //   tracked separately by the factory flag (duDateSeeded=true means the
      //   user or calendar explicitly set the date, and no auto-seed may
      //   override it).
      duDateSeeded: room.duDateSeeded,
    };
  });
}

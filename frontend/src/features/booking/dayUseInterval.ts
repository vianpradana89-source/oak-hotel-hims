import { addHotelDays, normalizeHotelDate } from '../calendar/calendarDates.ts';

const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

export interface DayUseInterval {
  start_at: string;
  end_at: string;
}

export type DayUseIntervalResult =
  | { ok: true; start_at: string; end_at: string }
  | { ok: false; error: string };

export interface QuickBookingStayInput {
  stayType: 'OVERNIGHT' | 'DAY_USE';
  checkIn: string;
  checkOut: string;
  dayUseStartTime: string;
  dayUseHours: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatHotelLocalTimestamp(date: string, hours: number, minutes: number): string {
  return `${date}T${pad2(hours)}:${pad2(minutes)}:00`;
}

/**
 * Build a DAY_USE start/end interval as hotel-local wall-clock timestamps
 * without an offset (YYYY-MM-DDTHH:mm:ss).
 *
 * Backend booking-create attaches properties.timezone before TIMESTAMPTZ insert.
 * This helper never uses browser Date timezone conversion.
 */
export function tryBuildDayUseInterval(
  checkIn: string,
  startTime: string,
  hours: number
): DayUseIntervalResult {
  const date = normalizeHotelDate(checkIn);
  if (!date) {
    return { ok: false, error: 'Tanggal Day Use tidak valid' };
  }

  const timeMatch = TIME_PATTERN.exec(String(startTime || '').trim());
  if (!timeMatch) {
    return { ok: false, error: 'Jam mulai Day Use tidak valid' };
  }

  if (!Number.isFinite(hours) || hours <= 0) {
    return { ok: false, error: 'Durasi Day Use harus lebih dari 0 jam' };
  }

  const startHour = Number(timeMatch[1]);
  const startMinute = Number(timeMatch[2]);
  const durationMinutes = Math.round(hours * 60);
  if (durationMinutes <= 0) {
    return { ok: false, error: 'Durasi Day Use harus lebih dari 0 jam' };
  }

  const startMinutes = startHour * 60 + startMinute;
  const endTotalMinutes = startMinutes + durationMinutes;
  const dayOffset = Math.floor(endTotalMinutes / (24 * 60));
  const endMinutesOfDay = endTotalMinutes % (24 * 60);
  const endHour = Math.floor(endMinutesOfDay / 60);
  const endMinute = endMinutesOfDay % 60;
  const endDate = addHotelDays(date, dayOffset);
  if (!endDate) {
    return { ok: false, error: 'Jam selesai Day Use tidak valid' };
  }

  const start_at = formatHotelLocalTimestamp(date, startHour, startMinute);
  const end_at = formatHotelLocalTimestamp(endDate, endHour, endMinute);
  if (start_at >= end_at) {
    return { ok: false, error: 'Jam selesai Day Use harus setelah jam mulai' };
  }

  return { ok: true, start_at, end_at };
}

export function buildDayUseInterval(
  checkIn: string,
  startTime: string,
  hours: number
): DayUseInterval {
  const result = tryBuildDayUseInterval(checkIn, startTime, hours);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return { start_at: result.start_at, end_at: result.end_at };
}

/**
 * Compute the default Day-Use start time rounded UP to the given interval.
 * When the current time is already on the boundary, it is kept.
 * If rounding rolls over to midnight of the next day, the caller receives
 * `datePlusOne: true` and must use `addHotelDays` to shift the date.
 */
export function roundUpHotelTimestamp(timestamp: string, intervalMinutes: number = 15): { time: string; datePlusOne: boolean } {
  const m = timestamp.match(/^(\d{4}-\d{2}-\d{2})T?([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
  if (!m) return { time: '10:00', datePlusOne: false };

  const datePart = m[1];
  const h = Number(m[2]);
  const min = Number(m[3]);
  const sec = Number(m[4] || 0);

  const totalMin = h * 60 + min + (sec > 0 ? 1 : 0);
  const step = Math.max(1, Math.round(intervalMinutes));
  const rounded = Math.ceil(totalMin / step) * step;

  if (rounded >= 24 * 60) {
    // rollover to next day 00:00
    const nextDay = addHotelDays(datePart, 1);
    return { time: nextDay ? '00:00' : '10:00', datePlusOne: nextDay !== null };
  }

  return { time: `${pad2(Math.floor(rounded / 60))}:${pad2(rounded % 60)}`, datePlusOne: false };
}

export function buildQuickBookingStayFields(room: QuickBookingStayInput): {
  check_in: string;
  check_out: string;
  stay_type: 'OVERNIGHT' | 'DAY_USE';
  start_at: string | undefined;
  end_at: string | undefined;
} {
  if (room.stayType === 'DAY_USE') {
    const interval = buildDayUseInterval(room.checkIn, room.dayUseStartTime, room.dayUseHours);
    return {
      check_in: room.checkIn,
      check_out: room.checkIn,
      stay_type: 'DAY_USE',
      start_at: interval.start_at,
      end_at: interval.end_at,
    };
  }

  return {
    check_in: room.checkIn,
    check_out: room.checkOut,
    stay_type: room.stayType,
    start_at: undefined,
    end_at: undefined,
  };
}

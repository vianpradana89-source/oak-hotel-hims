import { normalizeHotelDate } from './hotelDate';
import {
  DEFAULT_PROPERTY_TIMEZONE,
  InvalidLocalWallTimeError,
  InvalidPropertyTimezoneError,
  requirePropertyTimezone,
  resolveTimezoneOffsetForLocalDateTime,
} from './propertyTimezone';

const HOTEL_LOCAL_TS_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

export class DayUseIntervalError extends Error {
  code: string;
  field: string;

  constructor(code: string, field: string, message: string) {
    super(message);
    this.name = 'DayUseIntervalError';
    this.code = code;
    this.field = field;
  }
}

interface ParsedHotelTimestamp {
  date: string;
  hour: number;
  minute: number;
  second: number;
  explicitOffset: string | null;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function parseHotelTimestamp(value: unknown): ParsedHotelTimestamp | null {
  const raw = String(value ?? '').trim();
  const match = HOTEL_LOCAL_TS_PATTERN.exec(raw);
  if (!match) return null;

  const date = normalizeHotelDate(match[1]);
  if (!date) return null;

  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = match[4] == null ? 0 : Number(match[4]);
  if (hour > 23 || minute > 59 || second > 59) return null;

  return {
    date,
    hour,
    minute,
    second,
    explicitOffset: match[5] || null,
  };
}

export function isValidHotelLocalTimestamp(value: unknown): boolean {
  return parseHotelTimestamp(value) !== null;
}

/**
 * Attach the booking property timezone to a timezone-less wall-clock timestamp.
 * Explicit Z / ±HH:mm offsets are preserved and never rewritten.
 */
export function canonicalizeHotelTimestamp(
  value: unknown,
  propertyTimezone: string = DEFAULT_PROPERTY_TIMEZONE
): string | null {
  const parsed = parseHotelTimestamp(value);
  if (!parsed) return null;

  const wall = `${parsed.date}T${pad2(parsed.hour)}:${pad2(parsed.minute)}:${pad2(parsed.second)}`;
  if (parsed.explicitOffset === 'Z') return `${wall}Z`;
  if (parsed.explicitOffset) return `${wall}${parsed.explicitOffset}`;

  try {
    const timezone = requirePropertyTimezone(propertyTimezone);
    const offset = resolveTimezoneOffsetForLocalDateTime(
      timezone,
      parsed.date,
      parsed.hour,
      parsed.minute,
      parsed.second
    );
    return `${wall}${offset}`;
  } catch (err) {
    if (err instanceof InvalidPropertyTimezoneError) {
      throw new DayUseIntervalError('DAY_USE_TIMEZONE_INVALID', 'start_at', 'property timezone is invalid');
    }
    if (err instanceof InvalidLocalWallTimeError) {
      return null;
    }
    throw err;
  }
}

export function compareCanonicalTimestamps(left: string, right: string): number {
  const leftParsed = parseHotelTimestamp(left);
  const rightParsed = parseHotelTimestamp(right);
  if (!leftParsed?.explicitOffset || !rightParsed?.explicitOffset) {
    throw new DayUseIntervalError('DAY_USE_INTERVAL_INVALID', 'end_at', 'end_at must be after start_at');
  }

  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) {
    throw new DayUseIntervalError('DAY_USE_INTERVAL_INVALID', 'end_at', 'end_at must be after start_at');
  }
  return leftMs - rightMs;
}

export function validateDayUseInterval(
  startAt: unknown,
  endAt: unknown,
  propertyTimezone: string = DEFAULT_PROPERTY_TIMEZONE
): { startAt: string; endAt: string } {
  if (startAt == null || String(startAt).trim() === '') {
    throw new DayUseIntervalError('DAY_USE_START_AT_REQUIRED', 'start_at', 'start_at is required for day use');
  }
  if (endAt == null || String(endAt).trim() === '') {
    throw new DayUseIntervalError('DAY_USE_END_AT_REQUIRED', 'end_at', 'end_at is required for day use');
  }

  let timezone: string;
  try {
    timezone = requirePropertyTimezone(propertyTimezone);
  } catch (err) {
    if (err instanceof InvalidPropertyTimezoneError) {
      throw new DayUseIntervalError('DAY_USE_TIMEZONE_INVALID', 'start_at', 'property timezone is invalid');
    }
    throw err;
  }

  const start = canonicalizeHotelTimestamp(startAt, timezone);
  const end = canonicalizeHotelTimestamp(endAt, timezone);

  if (!start) {
    throw new DayUseIntervalError('DAY_USE_START_AT_INVALID', 'start_at', 'start_at is invalid');
  }
  if (!end) {
    throw new DayUseIntervalError('DAY_USE_END_AT_INVALID', 'end_at', 'end_at is invalid');
  }
  if (compareCanonicalTimestamps(start, end) >= 0) {
    throw new DayUseIntervalError('DAY_USE_INTERVAL_INVALID', 'end_at', 'end_at must be after start_at');
  }

  return { startAt: start, endAt: end };
}

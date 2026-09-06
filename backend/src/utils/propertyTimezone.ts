/**
 * Canonical property timezone resolution.
 * Source of truth: properties.timezone
 * Established fallback for blank/null only: Asia/Jakarta
 *
 * Day Use offset resolution is date-aware. It must not use a fixed
 * year-2000 reference date, and it must not silently fall back to +07:00
 * for a non-empty invalid IANA timezone.
 */

export const DEFAULT_PROPERTY_TIMEZONE = 'Asia/Jakarta';

export class InvalidPropertyTimezoneError extends Error {
  code = 'PROPERTY_TIMEZONE_INVALID';

  constructor(timezone: string) {
    super(`Invalid property timezone: ${timezone}`);
    this.name = 'InvalidPropertyTimezoneError';
  }
}

export class InvalidLocalWallTimeError extends Error {
  code = 'INVALID_LOCAL_WALL_TIME';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidLocalWallTimeError';
  }
}

export function resolvePropertyTimezone(value: unknown): string {
  const timezone = String(value ?? '').trim();
  return timezone || DEFAULT_PROPERTY_TIMEZONE;
}

export function isValidIanaTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date('2000-01-01T12:00:00Z'));
    return true;
  } catch {
    return false;
  }
}

/** Blank/null → Asia/Jakarta. Non-empty invalid IANA → throw. */
export function requirePropertyTimezone(value: unknown): string {
  const timezone = resolvePropertyTimezone(value);
  if (!isValidIanaTimezone(timezone)) {
    throw new InvalidPropertyTimezoneError(timezone);
  }
  return timezone;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatOffsetMinutes(totalMinutes: number): string {
  const sign = totalMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(totalMinutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function parseGmtOffsetMinutes(label: string): number | null {
  if (label === 'GMT' || label === 'UTC') return 0;
  const matched = label.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!matched) return null;
  const sign = matched[1] === '-' ? -1 : 1;
  return sign * (Number(matched[2]) * 60 + Number(matched[3] || 0));
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  offsetMinutes: number;
}

function readZonedParts(timeZone: string, utcMs: number): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  }).formatToParts(new Date(utcMs));

  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value || '';

  const offsetMinutes = parseGmtOffsetMinutes(read('timeZoneName'));
  if (offsetMinutes == null) {
    throw new InvalidPropertyTimezoneError(timeZone);
  }

  return {
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
    hour: Number(read('hour')) % 24,
    minute: Number(read('minute')),
    second: Number(read('second')),
    offsetMinutes,
  };
}

function matchesWallClock(
  parts: ZonedParts,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): boolean {
  return parts.year === year
    && parts.month === month
    && parts.day === day
    && parts.hour === hour
    && parts.minute === minute
    && parts.second === second;
}

/**
 * Resolve the UTC offset for a local wall-clock in an IANA zone on that date.
 * Rejects invalid IANA names and nonexistent DST-gap wall times.
 */
export function resolveTimezoneOffsetForLocalDateTime(
  timezone: string,
  date: string,
  hour: number,
  minute: number,
  second: number
): string {
  const zone = requirePropertyTimezone(timezone);
  const [year, month, day] = date.split('-').map(Number);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);

  const firstGuess = readZonedParts(zone, asUtc);
  const firstInstant = asUtc - firstGuess.offsetMinutes * 60_000;
  const firstActual = readZonedParts(zone, firstInstant);
  if (matchesWallClock(firstActual, year, month, day, hour, minute, second)) {
    return formatOffsetMinutes(firstActual.offsetMinutes);
  }

  const secondInstant = asUtc - firstActual.offsetMinutes * 60_000;
  const secondActual = readZonedParts(zone, secondInstant);
  if (matchesWallClock(secondActual, year, month, day, hour, minute, second)) {
    return formatOffsetMinutes(secondActual.offsetMinutes);
  }

  throw new InvalidLocalWallTimeError(
    `Local time ${date}T${pad2(hour)}:${pad2(minute)}:${pad2(second)} does not exist in ${zone}`
  );
}

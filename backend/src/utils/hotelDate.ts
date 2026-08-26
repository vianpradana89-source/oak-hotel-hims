const HOTEL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function formatHotelDateParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isValidHotelDateParts(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function normalizeHotelDate(value: unknown): string | null {
  const match = HOTEL_DATE_PATTERN.exec(String(value ?? '').trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return isValidHotelDateParts(year, month, day) ? formatHotelDateParts(year, month, day) : null;
}

export function hotelDateKey(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return formatHotelDateParts(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }

  return normalizeHotelDate(value) ?? '';
}

export function hotelDateFromInstant(value: unknown, timeZone = 'Asia/Jakarta'): string {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  if (Number.isNaN(date.getTime())) return '';

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return year && month && day ? `${year}-${month}-${day}` : '';
}

export function addHotelDays(value: unknown, amount: number): string {
  const dateKey = hotelDateKey(value);
  if (!dateKey || !Number.isInteger(amount)) return '';

  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return formatHotelDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function enumerateHotelDates(startValue: unknown, endValue: unknown): string[] {
  const start = hotelDateKey(startValue);
  const end = hotelDateKey(endValue);
  if (!start || !end || start >= end) return [];

  const dates: string[] = [];
  for (let current = start; current < end; current = addHotelDays(current, 1)) {
    dates.push(current);
  }
  return dates;
}

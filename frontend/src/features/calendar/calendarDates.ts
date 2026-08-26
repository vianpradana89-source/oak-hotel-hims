const HOTEL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function hotelDateOrdinal(date: string): number | null {
  const normalized = normalizeHotelDate(date);
  if (!normalized) return null;
  const [year, month, day] = normalized.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

export function normalizeHotelDate(value: unknown): string {
  const match = HOTEL_DATE_PATTERN.exec(String(value ?? '').trim());
  if (!match) return '';

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function hotelDateFromInstant(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return year && month && day ? `${year}-${month}-${day}` : '';
}

export function addHotelDays(date: string, amount: number): string {
  const ordinal = hotelDateOrdinal(date);
  if (ordinal === null || !Number.isInteger(amount)) return '';
  const value = new Date(ordinal + amount * DAY_MS);
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function hotelDateToLocalDate(date: string): Date | null {
  const normalized = normalizeHotelDate(date);
  if (!normalized) return null;
  const [year, month, day] = normalized.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function buildHotelDateWindow(anchorDate: string, anchorIndex = 2, windowSize = 7): string[] {
  const anchor = normalizeHotelDate(anchorDate);
  if (!anchor || !Number.isInteger(anchorIndex) || !Number.isInteger(windowSize) || windowSize < 1) return [];
  const start = addHotelDays(anchor, -anchorIndex);
  return Array.from({ length: windowSize }, (_, index) => addHotelDays(start, index));
}

export function hotelNightsBetween(start: string, end: string): number | null {
  const startOrdinal = hotelDateOrdinal(start);
  const endOrdinal = hotelDateOrdinal(end);
  if (startOrdinal === null || endOrdinal === null) return null;
  return Math.round((endOrdinal - startOrdinal) / DAY_MS);
}

export function hotelDateRangesOverlap(startA: string, endA: string, startB: string, endB: string): boolean {
  const dates = [startA, endA, startB, endB].map(normalizeHotelDate);
  if (dates.some((date) => !date)) return false;
  const [leftStart, leftEnd, rightStart, rightEnd] = dates;
  return leftStart < rightEnd && leftEnd > rightStart;
}

export function formatCompactHotelDate(date: string | null | undefined): string {
  if (!date) return '-';
  const ordinal = hotelDateOrdinal(date);
  if (ordinal === null) return date;
  return new Date(ordinal).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

import {
  addHotelDays,
  hotelDateFromInstant,
  hotelNightsBetween,
  normalizeHotelDate
} from '../calendar/calendarDates.ts';

export function resolveOvernightCheckIn(initialDate?: string | null): string {
  return normalizeHotelDate(initialDate) || hotelDateFromInstant(new Date());
}

export function defaultOvernightCheckOut(checkIn: string): string {
  const normalized = normalizeHotelDate(checkIn);
  if (!normalized) return '';
  return addHotelDays(normalized, 1);
}

export function resolveOvernightStayDates(initialDate?: string | null): {
  checkIn: string;
  checkOut: string;
} {
  const checkIn = resolveOvernightCheckIn(initialDate);
  return {
    checkIn,
    checkOut: defaultOvernightCheckOut(checkIn)
  };
}

export function bumpOvernightCheckoutIfNeeded(
  newCheckIn: string,
  currentCheckOut: string | null | undefined
): string {
  const checkIn = normalizeHotelDate(newCheckIn);
  const checkOut = normalizeHotelDate(currentCheckOut);
  if (!checkIn) return checkOut;
  if (!checkOut || checkOut <= checkIn) {
    return addHotelDays(checkIn, 1);
  }
  return checkOut;
}

export function overnightNights(checkIn: string, checkOut: string): number {
  const nights = hotelNightsBetween(checkIn, checkOut);
  return nights != null && nights > 0 ? nights : 0;
}

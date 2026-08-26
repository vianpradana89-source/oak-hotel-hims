import { hotelDateRangesOverlap } from '../calendar/calendarDates.ts';

export interface BookingComposerChildIdentity {
  id: string;
  room_id: number | null;
  room_type_id: number | null;
  check_in: string;
  check_out: string;
  [key: string]: unknown;
}

interface CanonicalRoomBindingSource {
  id: number;
  room_number?: string | null;
  room_type_id?: number | null;
  room_type_code?: string | null;
  room_type_name?: string | null;
  room_type_display_order?: number | null;
  room_category_id?: number | null;
  room_category_code?: string | null;
  room_category_name?: string | null;
  room_category_display_order?: number | null;
}

export function canonicalRoomClassification(room: CanonicalRoomBindingSource) {
  return {
    room_type_id: room.room_type_id == null ? null : Number(room.room_type_id),
    room_type_code: room.room_type_code ?? null,
    room_type_name: room.room_type_name ?? null,
    room_type_display_order: room.room_type_display_order ?? null,
    room_category_id: room.room_category_id == null ? null : Number(room.room_category_id),
    room_category_code: room.room_category_code ?? null,
    room_category_name: room.room_category_name ?? null,
    room_category_display_order: room.room_category_display_order ?? null,
  };
}

export function canonicalCalendarRoomBinding(room: CanonicalRoomBindingSource) {
  return {
    room_id: Number(room.id),
    room_number: room.room_number ?? null,
    ...canonicalRoomClassification(room),
  };
}

export function resolveBookingChildRoomId(
  overrides: { room_id?: number | null },
  fallbackRoomId: number | null,
): number | null {
  return Object.prototype.hasOwnProperty.call(overrides, 'room_id')
    ? overrides.room_id ?? null
    : fallbackRoomId;
}

export function additionalBookingChildOverrides(
  baseChild: Partial<BookingComposerChildIdentity>,
  fallback: Partial<BookingComposerChildIdentity>,
) {
  return {
    room_id: null,
    room_number: null,
    room_type_id: baseChild.room_type_id ?? fallback.room_type_id ?? null,
    room_type_code: baseChild.room_type_code ?? fallback.room_type_code ?? null,
    room_type_name: baseChild.room_type_name ?? fallback.room_type_name ?? null,
    room_type_display_order: baseChild.room_type_display_order ?? fallback.room_type_display_order ?? null,
    room_category_id: baseChild.room_category_id ?? fallback.room_category_id ?? null,
    room_category_code: baseChild.room_category_code ?? fallback.room_category_code ?? null,
    room_category_name: baseChild.room_category_name ?? fallback.room_category_name ?? null,
    room_category_display_order: baseChild.room_category_display_order ?? fallback.room_category_display_order ?? null,
    room_variant: baseChild.room_variant ?? fallback.room_variant ?? '',
    check_in: baseChild.check_in ?? fallback.check_in ?? '',
    check_out: baseChild.check_out ?? fallback.check_out ?? '',
    total_price: 0,
    subtotal_amount: 0,
    discount_amount: 0,
    discount_percent: 0,
    amount_paid: 0,
    payment_status: 'UNPAID',
  };
}

export function updateBookingChildById<T extends BookingComposerChildIdentity>(
  children: T[],
  childId: string,
  updates: Partial<T>,
): T[] {
  return children.map((child) => child.id === childId ? { ...child, ...updates } : child);
}

export function removeBookingChildById<T extends BookingComposerChildIdentity>(children: T[], childId: string): T[] {
  return children.length > 1 ? children.filter((child) => child.id !== childId) : children;
}

export function hasOverlappingPriorSiblingRoomSelection(
  children: BookingComposerChildIdentity[],
  childId: string,
  roomId: number,
  checkIn: string,
  checkOut: string,
): boolean {
  const childIndex = children.findIndex((child) => child.id === childId);
  if (childIndex <= 0) return false;
  return children.slice(0, childIndex).some((otherChild) => {
    if (!otherChild || otherChild.room_id == null) return false;
    if (Number(otherChild.room_id) !== roomId) return false;
    return hotelDateRangesOverlap(otherChild.check_in, otherChild.check_out, checkIn, checkOut);
  });
}

export function canonicalBookingChildRoomId(child: Pick<BookingComposerChildIdentity, 'room_id'>): number | null {
  const roomId = Number(child.room_id);
  return Number.isInteger(roomId) && roomId > 0 ? roomId : null;
}

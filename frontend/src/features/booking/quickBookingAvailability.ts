import { hotelDateRangesOverlap, normalizeHotelDate } from '../calendar/calendarDates.ts';
import { buildQuickBookingStayFields, tryBuildDayUseInterval } from './dayUseInterval.ts';

export const DAY_USE_OVERLAP_BUFFER_MINUTES = 60;
export const QUICK_BOOKING_NO_TYPES_MESSAGE = 'Tidak ada tipe kamar tersedia untuk periode ini.';
export const QUICK_BOOKING_SELECTION_UNAVAILABLE_MESSAGE =
  'Kamar yang dipilih sudah tidak tersedia pada periode tersebut.';

export interface CreateAvailabilityRoom {
  id: number;
  room_number: string;
  floor: string | null;
  name: string | null;
}

export interface CreateAvailabilityRoomType {
  id: number;
  code: string;
  name: string;
  rooms: CreateAvailabilityRoom[];
}

export interface BookingCreateAvailability {
  property_id: number;
  check_in: string;
  check_out: string;
  stay_type: 'OVERNIGHT' | 'DAY_USE' | 'TRANSIT';
  room_types: CreateAvailabilityRoomType[];
}

export interface QuickBookingStayInterval {
  stayType: 'OVERNIGHT' | 'DAY_USE';
  checkIn: string;
  checkOut: string;
  startAt?: string | null;
  endAt?: string | null;
}

export interface QuickBookingAvailabilityDraft {
  id: string;
  roomTypeId: number | null;
  roomId: number | null;
  stayType: 'OVERNIGHT' | 'DAY_USE';
  checkIn: string;
  checkOut: string;
  dayUseHours: number;
  dayUseStartTime: string;
}

function parseWallClockMs(value: string | null | undefined): number | null {
  const raw = String(value || '').trim();
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
  if (!match) return null;
  const date = normalizeHotelDate(match[1]);
  if (!date) return null;
  const [year, month, day] = date.split('-').map(Number);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = match[4] == null ? 0 : Number(match[4]);
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function hotelDateAtTimeMs(date: string, time: string): number | null {
  const hotelDate = normalizeHotelDate(date);
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!hotelDate || !timeMatch) return null;
  return parseWallClockMs(`${hotelDate}T${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3] || '00'}`);
}

function hotelDateFromTimestamp(value: string | null | undefined): string {
  const raw = String(value || '').trim();
  return normalizeHotelDate(raw.slice(0, 10));
}

export function draftStayInterval(draft: QuickBookingAvailabilityDraft): QuickBookingStayInterval | null {
  if (draft.stayType === 'DAY_USE') {
    const interval = tryBuildDayUseInterval(draft.checkIn, draft.dayUseStartTime, draft.dayUseHours);
    if (!interval.ok) return null;
    return {
      stayType: 'DAY_USE',
      checkIn: draft.checkIn,
      checkOut: draft.checkIn,
      startAt: interval.start_at,
      endAt: interval.end_at,
    };
  }
  const checkIn = normalizeHotelDate(draft.checkIn);
  const checkOut = normalizeHotelDate(draft.checkOut);
  if (!checkIn || !checkOut || checkIn >= checkOut) return null;
  return {
    stayType: 'OVERNIGHT',
    checkIn,
    checkOut,
    startAt: null,
    endAt: null,
  };
}

function dayUseVsDayUseOverlap(left: QuickBookingStayInterval, right: QuickBookingStayInterval): boolean {
  const leftStart = parseWallClockMs(left.startAt);
  const leftEnd = parseWallClockMs(left.endAt);
  const rightStart = parseWallClockMs(right.startAt);
  const rightEnd = parseWallClockMs(right.endAt);
  if (leftStart == null || leftEnd == null || rightStart == null || rightEnd == null) return false;
  const bufferMs = DAY_USE_OVERLAP_BUFFER_MINUTES * 60 * 1000;
  return leftStart < rightEnd + bufferMs && leftEnd + bufferMs > rightStart;
}

function dayUseVsOvernightOverlap(dayUse: QuickBookingStayInterval, overnight: QuickBookingStayInterval): boolean {
  const startDate = hotelDateFromTimestamp(dayUse.startAt) || normalizeHotelDate(dayUse.checkIn);
  const startMs = parseWallClockMs(dayUse.startAt);
  const endMs = parseWallClockMs(dayUse.endAt);
  const overnightIn = normalizeHotelDate(overnight.checkIn);
  const overnightOut = normalizeHotelDate(overnight.checkOut);
  if (!startDate || startMs == null || endMs == null || !overnightIn || !overnightOut) return false;

  if (overnightIn < startDate && overnightOut > startDate) return true;

  const checkInGate = hotelDateAtTimeMs(overnightIn, '14:00:00');
  const checkOutGate = hotelDateAtTimeMs(overnightOut, '12:00:00');
  const bufferMs = DAY_USE_OVERLAP_BUFFER_MINUTES * 60 * 1000;
  if (overnightIn === startDate && checkInGate != null && endMs > checkInGate - bufferMs) return true;
  if (overnightOut === startDate && checkOutGate != null && startMs < checkOutGate + bufferMs) return true;
  return false;
}

function overnightVsDayUseOverlap(overnight: QuickBookingStayInterval, dayUse: QuickBookingStayInterval): boolean {
  const dayUseDate = hotelDateFromTimestamp(dayUse.startAt) || normalizeHotelDate(dayUse.checkIn);
  const overnightIn = normalizeHotelDate(overnight.checkIn);
  const overnightOut = normalizeHotelDate(overnight.checkOut);
  if (!dayUseDate || !overnightIn || !overnightOut) return false;
  return dayUseDate >= overnightIn && dayUseDate < overnightOut;
}

export function quickBookingIntervalsOverlap(
  left: QuickBookingStayInterval,
  right: QuickBookingStayInterval
): boolean {
  if (left.stayType === 'DAY_USE' && right.stayType === 'DAY_USE') {
    return dayUseVsDayUseOverlap(left, right);
  }
  if (left.stayType === 'DAY_USE' && right.stayType === 'OVERNIGHT') {
    return dayUseVsOvernightOverlap(left, right);
  }
  if (left.stayType === 'OVERNIGHT' && right.stayType === 'DAY_USE') {
    return overnightVsDayUseOverlap(left, right);
  }
  return hotelDateRangesOverlap(left.checkIn, left.checkOut, right.checkIn, right.checkOut);
}

export function overlappingSiblingTakesRoom(
  drafts: QuickBookingAvailabilityDraft[],
  rowIndex: number,
  roomId: number,
  options?: { priorOnly?: boolean }
): boolean {
  const row = drafts[rowIndex];
  const rowInterval = row ? draftStayInterval(row) : null;
  if (!rowInterval || !Number.isInteger(roomId) || roomId <= 0) return false;
  return drafts.some((other, otherIndex) => {
    if (otherIndex === rowIndex || Number(other.roomId) !== roomId) return false;
    if (options?.priorOnly && otherIndex >= rowIndex) return false;
    const otherInterval = draftStayInterval(other);
    return otherInterval ? quickBookingIntervalsOverlap(rowInterval, otherInterval) : false;
  });
}

export function eligibleRoomsForRow(
  drafts: QuickBookingAvailabilityDraft[],
  rowIndex: number,
  serverTypes: CreateAvailabilityRoomType[],
  roomTypeId?: number | null
): CreateAvailabilityRoom[] {
  const typeId = roomTypeId === undefined ? drafts[rowIndex]?.roomTypeId : roomTypeId;
  const type = serverTypes.find((item) => Number(item.id) === Number(typeId));
  if (!type) return [];
  return type.rooms.filter((room) => !overlappingSiblingTakesRoom(drafts, rowIndex, Number(room.id)));
}

export function visibleRoomTypesForRow(
  drafts: QuickBookingAvailabilityDraft[],
  rowIndex: number,
  serverTypes: CreateAvailabilityRoomType[]
): CreateAvailabilityRoomType[] {
  return serverTypes.filter((type) => eligibleRoomsForRow(drafts, rowIndex, serverTypes, type.id).length > 0);
}

export function createAvailabilityRequestKey(input: {
  propertyId: number;
  stayType: 'OVERNIGHT' | 'DAY_USE';
  checkIn: string;
  checkOut: string;
  startAt?: string | null;
  endAt?: string | null;
}): string | null {
  if (!Number.isInteger(input.propertyId) || input.propertyId <= 0) return null;
  if (input.stayType === 'DAY_USE') {
    if (!input.startAt || !input.endAt) return null;
    return [input.propertyId, 'DAY_USE', input.checkIn, input.startAt, input.endAt].join('|');
  }
  const checkIn = normalizeHotelDate(input.checkIn);
  const checkOut = normalizeHotelDate(input.checkOut);
  if (!checkIn || !checkOut || checkIn >= checkOut) return null;
  return [input.propertyId, 'OVERNIGHT', checkIn, checkOut].join('|');
}

export function createAvailabilityRequestFromDraft(
  propertyId: number,
  draft: QuickBookingAvailabilityDraft
): { key: string; params: URLSearchParams } | null {
  const interval = draftStayInterval(draft);
  if (!interval) return null;
  const stayFields = draft.stayType === 'DAY_USE'
    ? buildQuickBookingStayFields(draft)
    : { check_in: interval.checkIn, check_out: interval.checkOut, stay_type: 'OVERNIGHT' as const, start_at: undefined, end_at: undefined };
  const key = createAvailabilityRequestKey({
    propertyId,
    stayType: interval.stayType,
    checkIn: stayFields.check_in,
    checkOut: stayFields.check_out,
    startAt: stayFields.start_at,
    endAt: stayFields.end_at,
  });
  if (!key) return null;
  const params = new URLSearchParams({
    property_id: String(propertyId),
    check_in: stayFields.check_in,
    check_out: stayFields.check_out,
    stay_type: stayFields.stay_type,
  });
  if (stayFields.start_at) params.set('start_at', stayFields.start_at);
  if (stayFields.end_at) params.set('end_at', stayFields.end_at);
  return { key, params };
}

export function applyInvalidAvailabilitySelections<T extends QuickBookingAvailabilityDraft>(
  drafts: T[],
  serverTypesByRow: Array<CreateAvailabilityRoomType[] | undefined>,
  options?: { autoPickEmpty?: boolean }
): { drafts: T[]; clearedIndexes: number[] } {
  const next = drafts.map((draft) => ({ ...draft }));
  const clearedIndexes: number[] = [];
  const autoPickEmpty = options?.autoPickEmpty === true;

  next.forEach((draft, index) => {
    const serverTypes = serverTypesByRow[index];
    if (!serverTypes) return;
    const originallyEmpty = drafts[index].roomTypeId == null && drafts[index].roomId == null;
    const visibleTypes = visibleRoomTypesForRow(next, index, serverTypes);
    const typeStillVisible = visibleTypes.some((type) => Number(type.id) === Number(draft.roomTypeId));
    if (draft.roomTypeId != null && !typeStillVisible) {
      draft.roomTypeId = null;
      draft.roomId = null;
      clearedIndexes.push(index);
    } else if (draft.roomId != null) {
      const typeRooms = serverTypes.find((type) => Number(type.id) === Number(draft.roomTypeId))?.rooms || [];
      const serverHasRoom = typeRooms.some((room) => Number(room.id) === Number(draft.roomId));
      const takenByPrior = overlappingSiblingTakesRoom(next, index, draft.roomId, { priorOnly: true });
      if (!serverHasRoom || takenByPrior) {
        draft.roomId = null;
        clearedIndexes.push(index);
      }
    }

    if (autoPickEmpty && originallyEmpty && draft.roomTypeId == null && visibleTypes.length > 0) {
      const firstType = visibleTypes[0];
      const eligible = eligibleRoomsForRow(next, index, serverTypes, firstType.id);
      draft.roomTypeId = firstType.id;
      draft.roomId = eligible[0]?.id ?? null;
    }
  });

  return { drafts: next, clearedIndexes };
}

export function formatCreateAvailabilityRoomLabel(room: CreateAvailabilityRoom): string {
  return `Kamar ${room.room_number}${room.name ? ` (${room.name})` : ''}`;
}

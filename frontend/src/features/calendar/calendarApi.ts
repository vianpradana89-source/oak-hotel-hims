export interface TapechartRequest {
  start: string;
  end: string;
  includeInactive?: boolean;
}

export async function fetchTapechart(request: TapechartRequest): Promise<TapechartResponse> {
  const params = new URLSearchParams({ start: request.start, end: request.end });
  if (request.includeInactive) params.set('include_inactive', '1');

  const response = await fetch(`/api/tapechart?${params.toString()}`);
  if (!response.ok) throw new Error(`Tape Chart request failed (${response.status})`);
  return response.json();
}

export function buildAvailabilityRequest(
  roomTypeId: number | null,
  roomTypeName: string,
  checkIn: string,
  checkOut: string,
): string {
  const params = new URLSearchParams({ start: checkIn, end: checkOut });
  if (roomTypeId !== null) params.set('room_type_id', String(roomTypeId));
  else params.set('room_type', roomTypeName);
  return `/api/availability?${params.toString()}`;
}

export function parseAvailabilityKey(key: string): {
  roomTypeId: number | null;
  roomTypeName: string;
  checkIn: string;
  checkOut: string;
} | null {
  const [identity, checkIn, checkOut] = String(key || '').split('|');
  if (!identity || !checkIn || !checkOut) return null;
  if (identity.startsWith('id:')) {
    const roomTypeId = Number(identity.slice(3));
    return Number.isInteger(roomTypeId) && roomTypeId > 0
      ? { roomTypeId, roomTypeName: '', checkIn, checkOut }
      : null;
  }
  return { roomTypeId: null, roomTypeName: identity, checkIn, checkOut };
}
import type { TapechartResponse } from './calendarTypes';

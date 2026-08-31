export interface TapechartRequest {
  start: string;
  end: string;
  propertyId: number;
  includeInactive?: boolean;
}

export interface SafeFetchOptions extends RequestInit {
  expectJson?: boolean;
}

export interface SafeFetchResult<T = any> {
  ok: boolean;
  status: number;
  contentType: string;
  data: T | null;
  errorMessage?: string;
}

export async function safeFetchJson<T = any>(
  url: string,
  options?: SafeFetchOptions,
  defaultErrorMessage = 'Data operasional belum dapat dimuat. Coba lagi.'
): Promise<SafeFetchResult<T>> {
  const expectJson = options?.expectJson ?? true;

  try {
    const res = await fetch(url, options);
    const contentType = res.headers.get('content-type') || '';
    const isJson = contentType.toLowerCase().includes('application/json');

    // Handle HTTP 204 No Content / 205 Reset Content explicitly
    if (res.status === 204 || res.status === 205) {
      if (res.ok) {
        return {
          ok: true,
          status: res.status,
          contentType,
          data: null,
          errorMessage: undefined
        };
      } else {
        return {
          ok: false,
          status: res.status,
          contentType,
          data: null,
          errorMessage: defaultErrorMessage
        };
      }
    }

    // When JSON is expected (default), verify Content-Type indicates JSON
    if (expectJson && !isJson) {
      console.warn(`[safeFetchJson] Non-JSON response received (expected application/json):`, {
        url,
        status: res.status,
        statusText: res.statusText,
        contentType
      });
      return {
        ok: false,
        status: res.status,
        contentType,
        data: null,
        errorMessage: defaultErrorMessage
      };
    }

    // Parse JSON body if Content-Type indicates JSON
    let json: any = null;
    if (isJson) {
      try {
        json = await res.json();
      } catch (parseErr) {
        console.warn(`[safeFetchJson] JSON parse failure:`, {
          url,
          status: res.status,
          error: parseErr
        });
        return {
          ok: false,
          status: res.status,
          contentType,
          data: null,
          errorMessage: defaultErrorMessage
        };
      }
    }

    // Non-OK HTTP status handling
    if (!res.ok) {
      const serverMsg = json?.message || json?.error || defaultErrorMessage;
      console.warn(`[safeFetchJson] HTTP error ${res.status}:`, {
        url,
        status: res.status,
        json
      });
      return {
        ok: false,
        status: res.status,
        contentType,
        data: json,
        errorMessage: serverMsg
      };
    }

    // Success response
    return {
      ok: true,
      status: res.status,
      contentType,
      data: json,
      errorMessage: undefined
    };
  } catch (netErr: any) {
    console.warn(`[safeFetchJson] Network/fetch error:`, {
      url,
      error: netErr
    });
    return {
      ok: false,
      status: 0,
      contentType: '',
      data: null,
      errorMessage: 'Gagal terhubung ke server. Periksa koneksi jaringan.'
    };
  }
}

export async function fetchTapechart(request: TapechartRequest): Promise<TapechartResponse> {
  const params = new URLSearchParams({ start: request.start, end: request.end, property_id: String(request.propertyId) });
  if (request.includeInactive) params.set('include_inactive', '1');

  const result = await safeFetchJson<TapechartResponse>(`/api/tapechart?${params.toString()}`);
  if (!result.ok || !result.data) {
    throw new Error(result.errorMessage || `Tape Chart request failed (${result.status})`);
  }
  return result.data;
}

export function buildAvailabilityRequest(
  roomTypeId: number | null,
  roomTypeName: string,
  checkIn: string,
  checkOut: string,
  propertyId: number,
): string {
  const params = new URLSearchParams({ start: checkIn, end: checkOut, property_id: String(propertyId) });
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

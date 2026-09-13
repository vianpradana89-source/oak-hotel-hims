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

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function safeFetchJson<T = any>(
  url: string,
  options?: SafeFetchOptions,
  defaultErrorMessage = 'Data operasional belum dapat dimuat. Coba lagi.',
  fetchImpl: FetchLike = fetch
): Promise<SafeFetchResult<T>> {
  const expectJson = options?.expectJson ?? true;

  try {
    const res = await fetchImpl(url, options);
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

export async function fetchTapechart(request: TapechartRequest, fetchImpl: FetchLike = fetch): Promise<TapechartResponse> {
  const params = new URLSearchParams({ start: request.start, end: request.end, property_id: String(request.propertyId) });
  if (request.includeInactive) params.set('include_inactive', '1');

  const result = await safeFetchJson<TapechartResponse>(`/api/tapechart?${params.toString()}`, undefined, undefined, fetchImpl);
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
import type { TapechartResponse, UnresolvedGuaranteeItem } from './calendarTypes';

export interface DailyKpiResponse {
  status: string;
  data: DailyKpiData;
}

export interface DailyKpiData {
  property_id: number;
  business_date: string;
  timezone: string;
  occupancy: {
    occupied_rooms: number;
    sellable_rooms: number;
    occupancy_pct: number | null;
    ooo_oos_rooms: number;
  };
  booked_today: {
    rooms: number;
    bookings: number;
  };
  check_in_today: { rooms: number };
  check_out_today: { rooms: number };
  rooms: {
    dirty: number;
    vacant_clean: number;
    maintenance_ooo_oos: number;
  };
  checkout_check: { pending: number };
}

export async function fetchDailyKpis(
  propertyId: number,
  date: string | undefined,
  fetchImpl: FetchLike = fetch
): Promise<DailyKpiData> {
  const params = new URLSearchParams({ property_id: String(propertyId) });
  if (date) params.set('date', date);
  const result = await safeFetchJson<DailyKpiResponse>(
    `/api/reports/daily-kpis?${params.toString()}`,
    undefined,
    'Ringkasan KPI hari ini belum dapat dimuat.',
    fetchImpl
  );
  if (!result.ok || !result.data?.data) {
    throw new Error(result.errorMessage || `Daily KPI request failed (${result.status})`);
  }
  return result.data.data;
}

export interface UnresolvedGuaranteesResponse {
  status: string;
  data: { items: UnresolvedGuaranteeItem[] };
}

/**
 * GET /api/reservations/unresolved-guarantees?property_id=<id>
 *
 * Returns the unresolved guarantee work queue for the property.
 * READ-ONLY - the queue is a triage surface; all mutations remain in
 * ReservationDetailDrawer.
 */
export async function fetchUnresolvedGuarantees(
  propertyId: number,
  fetchImpl: FetchLike = fetch
): Promise<UnresolvedGuaranteeItem[]> {
  const params = new URLSearchParams({ property_id: String(propertyId) });
  const result = await safeFetchJson<UnresolvedGuaranteesResponse>(
    `/api/reservations/unresolved-guarantees?${params.toString()}`,
    undefined,
    'Daftar jaminan belum dapat dimuat.',
    fetchImpl
  );
  if (!result.ok) {
    throw new Error(result.errorMessage || `Unresolved guarantees request failed (${result.status})`);
  }
  const items = result.data?.data?.items;
  // Malformed payload guard: a successful response without a well-formed
  // items array is treated as an error, never silently as "all settled".
  if (!Array.isArray(items)) {
    throw new Error('Daftar jaminan belum dapat dimuat.');
  }

  // Validate every item strictly; any malformed entry aborts the entire
  // queue so it never renders as "all settled" with missing data.
  const validateGuaranteeItem = (item: unknown): item is UnresolvedGuaranteeItem => {
    if (item === null || typeof item !== 'object') return false;
    const r = item as Record<string, unknown>;
    if (r.scope !== 'ROOM_RESERVATION' && r.scope !== 'BOOKING_GROUP') return false;
    if (!Number.isInteger(Number(r.reservation_id)) || Number(r.reservation_id) <= 0) return false;
    if (!Number.isInteger(Number(r.anchor_reservation_id)) || Number(r.anchor_reservation_id) <= 0) return false;
    if (!Number.isInteger(Number(r.booking_id)) || Number(r.booking_id) <= 0) return false;
    if (typeof r.bid !== 'string' || !r.bid) return false;
    if (typeof r.guest_name !== 'string' || !r.guest_name) return false;
    if (r.room_number !== null && typeof r.room_number !== 'string') return false;
    if (r.room_type_name !== null && typeof r.room_type_name !== 'string') return false;
    if (r.room_count !== null && (!Number.isInteger(Number(r.room_count)) || Number(r.room_count) < 0)) return false;
    if (typeof r.reservation_status !== 'string' || !r.reservation_status) return false;
    if (typeof r.unresolved_deposit_amount !== 'number' || !Number.isFinite(r.unresolved_deposit_amount) || r.unresolved_deposit_amount < 0) return false;
    if (typeof r.identity_held !== 'boolean') return false;
    if (!Number.isInteger(Number(r.deposit_count)) || Number(r.deposit_count) < 0) return false;
    if (!Number.isInteger(Number(r.custody_count)) || Number(r.custody_count) < 0) return false;
    if (r.last_activity_at !== null && typeof r.last_activity_at !== 'string') return false;
    return true;
  };

  for (const item of items) {
    if (!validateGuaranteeItem(item)) {
      throw new Error('Daftar jaminan belum dapat dimuat.');
    }
  }
  return items as UnresolvedGuaranteeItem[];
}

export const DAILY_KPI_DRILLDOWN_TYPES = [
  'occupancy',
  'booked',
  'checkin',
  'checkout',
  'dirty',
  'vacant_clean',
  'checkout_check',
  'maintenance',
] as const;

export type DailyKpiDrilldownType = (typeof DAILY_KPI_DRILLDOWN_TYPES)[number];

export interface DailyKpiStayItem {
  reservation_id: number;
  booking_id: number;
  bid: string | null;
  guest_name: string | null;
  room_id: number | null;
  room_number: string | null;
  room_type_name: string | null;
  status: string | null;
  stay_type: string | null;
  check_in: string | null;
  check_out: string | null;
  checked_in_at?: string | null;
  checked_out_at?: string | null;
}

export interface DailyKpiBookedChild {
  reservation_id: number;
  room_id: number | null;
  room_number: string | null;
  room_type_name: string | null;
  status: string | null;
}

export interface DailyKpiBookedGroup {
  booking_id: number;
  bid: string | null;
  guest_name: string | null;
  booking_status: string | null;
  booking_source: string | null;
  created_at: string | null;
  room_count: number;
  children: DailyKpiBookedChild[];
}

export interface DailyKpiRoomItem {
  room_id: number;
  room_number: string | null;
  room_type_name: string | null;
  status: string | null;
}

export interface DailyKpiCheckoutCheckItem {
  task_id: number;
  task_number: string | null;
  status: string | null;
  room_id: number | null;
  room_number: string | null;
  room_type_name: string | null;
  reservation_id: number | null;
  guest_name: string | null;
  bid: string | null;
  created_at: string | null;
}

export interface DailyKpiMaintenanceItem {
  room_id: number;
  room_number: string | null;
  room_type_name: string | null;
  room_status: string | null;
  from_room_status: boolean;
  from_operational_block: boolean;
  block_type: string | null;
}

interface DailyKpiDrilldownBase {
  property_id: number;
  business_date: string;
  timezone: string;
  count: number;
}

export type DailyKpiDrilldownData =
  | (DailyKpiDrilldownBase & { type: 'occupancy'; items: DailyKpiStayItem[] })
  | (DailyKpiDrilldownBase & {
      type: 'booked';
      groups: DailyKpiBookedGroup[];
      bookings: number;
      rooms: number;
    })
  | (DailyKpiDrilldownBase & { type: 'checkin'; items: DailyKpiStayItem[] })
  | (DailyKpiDrilldownBase & { type: 'checkout'; items: DailyKpiStayItem[] })
  | (DailyKpiDrilldownBase & { type: 'dirty'; items: DailyKpiRoomItem[] })
  | (DailyKpiDrilldownBase & { type: 'vacant_clean'; items: DailyKpiRoomItem[] })
  | (DailyKpiDrilldownBase & { type: 'checkout_check'; items: DailyKpiCheckoutCheckItem[] })
  | (DailyKpiDrilldownBase & { type: 'maintenance'; items: DailyKpiMaintenanceItem[] });

export interface DailyKpiDrilldownResponse {
  status: string;
  data: DailyKpiDrilldownData;
}

export async function fetchDailyKpiDrilldown(
  propertyId: number,
  type: DailyKpiDrilldownType,
  date: string | undefined,
  fetchImpl: FetchLike = fetch
): Promise<DailyKpiDrilldownData> {
  const params = new URLSearchParams({
    property_id: String(propertyId),
    type,
  });
  if (date) params.set('date', date);
  const result = await safeFetchJson<DailyKpiDrilldownResponse>(
    `/api/reports/daily-kpis/drilldown?${params.toString()}`,
    undefined,
    'Rincian KPI hari ini belum dapat dimuat.',
    fetchImpl
  );
  if (!result.ok || !result.data?.data) {
    throw new Error(result.errorMessage || `Daily KPI drilldown request failed (${result.status})`);
  }
  return result.data.data;
}

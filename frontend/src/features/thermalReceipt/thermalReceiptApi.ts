/**
 * Thermal Receipt — API Layer
 *
 * Thin wrappers around existing endpoints.
 * No backend changes needed — all endpoints already exist.
 */
import { depositApi, identityCustodyApi } from '../deposits/depositApi';
import type {
  FolioFinancials,
  ThermalDeposit,
  ThermalIdentityRecord,
  ThermalReceiptReservation,
} from './thermalReceiptTypes';

/** Fetch folio + authoritative financials for a reservation. */
export async function fetchFolioFinancials(
  reservationId: number,
  propertyId: number,
  authFetch: (url: string, init?: RequestInit) => Promise<Response>
): Promise<FolioFinancials> {
  const res = await authFetch(
    `/api/reservations/${reservationId}/folio?property_id=${propertyId}`
  );
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error((json as any)?.message ?? `HTTP ${res.status}`);
  }
  const json = await res.json();
  const fin = json?.data?.authoritative_financials;
  return {
    total_price: fin?.total_price ?? 0,
    amount_paid: fin?.amount_paid ?? 0,
    applied_deposit: fin?.applied_deposit ?? 0,
    remaining_balance: fin?.remaining_balance ?? 0,
    payment_status: (fin?.payment_status ?? 'UNPAID') as FolioFinancials['payment_status'],
  };
}

/** Fetch deposit list for a reservation. */
export async function fetchDeposits(
  reservationId: number,
  propertyId: number
): Promise<ThermalDeposit[]> {
  return depositApi.list(reservationId, propertyId).then((raw: any[]) =>
    raw.map((d) => ({
      id: d.id,
      deposit_number: d.deposit_number,
      original_amount: d.original_amount,
      payment_method: d.payment_method,
      status: d.status,
      received_by: d.received_by,
      notes: d.notes ?? null,
      created_at: d.created_at,
    }))
  );
}

/** Fetch identity custody records for a reservation. */
export async function fetchIdentityCustody(
  reservationId: number,
  propertyId: number
): Promise<ThermalIdentityRecord[]> {
  return identityCustodyApi.list(reservationId, propertyId).then((raw: any[]) =>
    raw.map((r) => ({
      id: r.id,
      document_type: r.document_type,
      document_holder_name: r.document_holder_name,
      document_number_masked: r.document_number_masked ?? null,
      status: r.status,
      received_by: r.received_by,
      storage_location: r.storage_location ?? null,
      notes: r.notes ?? null,
      returned_by: r.returned_by ?? null,
      returned_at: r.returned_at ?? null,
      created_at: r.created_at,
    }))
  );
}

/** Extract reservation fields needed for thermal receipt rendering. */
export function extractReservationContext(
  reservation: any
): ThermalReceiptReservation {
  return {
    id: reservation.id,
    bid: reservation.bid || reservation.legacy_booking_number || null,
    guest_name: reservation.guest_name || reservation.primary_guest?.name || '',
    room_number: reservation.room_number ?? null,
    room_type_name: reservation.room_type_name ?? null,
    check_in: reservation.check_in ?? '',
    check_out: reservation.check_out ?? '',
    nights: reservation.nights || 0,
    guest_count: reservation.guest_count || 1,
    source: reservation.source ?? null,
    status: reservation.status ?? 'BOOKED',
  };
}

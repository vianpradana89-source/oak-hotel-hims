export type ReservationContextRecord = {
  status?: unknown;
  ota_source_id?: unknown;
  ota_source_name?: unknown;
  booking_channel?: unknown;
  booking_type?: unknown;
  booking_source?: unknown;
  channel?: unknown;
  rate_plan_id?: unknown;
  rate_plan_name_snapshot?: unknown;
  rate_plan_code_snapshot?: unknown;
  rate_plan_name?: unknown;
  is_manual_override?: unknown;
  special_requests?: unknown;
} | null | undefined;

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function upper(value: unknown): string {
  return text(value).toUpperCase();
}

function isOtaReservation(reservation: ReservationContextRecord): boolean {
  if (!reservation) return false;
  if (reservation.ota_source_id != null && reservation.ota_source_id !== '') return true;
  if (text(reservation.ota_source_name)) return true;
  const channel = upper(reservation.booking_channel);
  const type = upper(reservation.booking_type);
  const source = upper(reservation.booking_source);
  return channel === 'OTA' || type === 'OTA' || source === 'OTA';
}

export function formatReservationSourceLabel(reservation: ReservationContextRecord): string {
  if (!reservation) return 'Walk-in';

  const otaName = text(reservation.ota_source_name);
  if (otaName) return `OTA — ${otaName}`;
  if (reservation.ota_source_id != null && reservation.ota_source_id !== '') return 'OTA';

  const channel = upper(reservation.booking_channel);
  const type = upper(reservation.booking_type);
  const source = upper(reservation.booking_source || reservation.channel);
  if (channel === 'OTA' || type === 'OTA' || source === 'OTA') return 'OTA';

  if (source === 'DIRECT') return 'Resepsionis / Langsung';
  if (source === 'WEBSITE') return 'Website Hotel';
  if (source === 'WALKIN' || source === 'WALK_IN' || source === 'FRONT_DESK') return 'Walk-in';
  if (source === 'PHONE_WA') return 'Telepon / WhatsApp';

  if (source) {
    return source
      .split(/[_\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
      .join(' ');
  }
  return 'Walk-in';
}

export function formatReservationRatePlanLabel(reservation: ReservationContextRecord): string {
  if (!reservation) return '-';
  const snapshotName = text(reservation.rate_plan_name_snapshot || reservation.rate_plan_name);
  if (snapshotName) return snapshotName;
  const snapshotCode = text(reservation.rate_plan_code_snapshot);
  if (snapshotCode) return snapshotCode;
  if (isOtaReservation(reservation) || Boolean(reservation.is_manual_override)) {
    return 'Manual / OTA Override';
  }
  return '-';
}

export function reservationSpecialRequestsText(reservation: ReservationContextRecord): string {
  return text(reservation?.special_requests);
}

export function canEditReservationSpecialRequests(status: unknown): boolean {
  const value = String(status || '').toUpperCase();
  return value === 'BOOKED' || value === 'CHECKED_IN';
}

export function isBookedWalkInReservation(reservation: {
  status?: unknown;
  ota_source_id?: unknown;
  ota_source_name?: unknown;
  booking_channel?: unknown;
  booking_type?: unknown;
  booking_source?: unknown;
  is_manual_override?: unknown;
  manual_override_reason?: unknown;
} | null | undefined): boolean {
  if (!reservation) return false;
  if (String(reservation.status || '').toUpperCase() !== 'BOOKED') return false;
  if (reservation.ota_source_id != null && reservation.ota_source_id !== '') return false;
  if (reservation.ota_source_name) return false;
  const channel = String(reservation.booking_channel || '').toUpperCase();
  const type = String(reservation.booking_type || '').toUpperCase();
  const source = String(reservation.booking_source || '').toUpperCase();
  if (channel === 'OTA' || type === 'OTA' || source === 'OTA') return false;
  if (
    reservation.is_manual_override
    && String(reservation.manual_override_reason || '').toLowerCase().includes('ota')
  ) {
    return false;
  }
  return true;
}

export function canShowBookedRateCorrection(reservation: Parameters<typeof isBookedWalkInReservation>[0]): boolean {
  return isBookedWalkInReservation(reservation);
}

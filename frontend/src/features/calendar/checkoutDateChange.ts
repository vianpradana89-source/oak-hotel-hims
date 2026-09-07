import { normalizeHotelDate } from './calendarDates.ts';

export type CheckoutChangeMode = 'shorten' | 'extend' | 'same';

export const CHECKOUT_DATE_CHANGE_LABEL = 'Ubah Tanggal Check-out';

export const CHECKED_IN_SHORTEN_BLOCKED_MESSAGE =
  'Masa inap tamu yang sudah check-in tidak dapat diperpendek. Gunakan proses Early Checkout.';

export function resolveCheckoutChangeMode(currentCheckout: unknown, newCheckout: unknown): CheckoutChangeMode {
  const current = normalizeHotelDate(currentCheckout);
  const next = normalizeHotelDate(newCheckout);
  if (!current || !next || current === next) return 'same';
  return next < current ? 'shorten' : 'extend';
}

export function canShowCheckoutDateChange(status: unknown): boolean {
  const value = String(status || '').toUpperCase();
  return value === 'BOOKED' || value === 'CHECKED_IN';
}

export function isCheckedInShortenBlocked(status: unknown, mode: CheckoutChangeMode): boolean {
  return String(status || '').toUpperCase() === 'CHECKED_IN' && mode === 'shorten';
}

export function canConfirmCheckoutDateChange(
  status: unknown,
  currentCheckout: unknown,
  newCheckout: unknown
): boolean {
  const mode = resolveCheckoutChangeMode(currentCheckout, newCheckout);
  if (mode === 'same') return false;
  if (isCheckedInShortenBlocked(status, mode)) return false;
  return true;
}

export function checkoutChangeCopy(mode: CheckoutChangeMode): {
  title: string;
  body: string;
  confirm: string;
  icon: string;
} {
  if (mode === 'shorten') {
    return {
      title: 'Pendekkan Masa Menginap',
      body: 'Konfirmasi perubahan tanggal check-out ke tanggal lebih awal.',
      confirm: 'Konfirmasi Pendekkan',
      icon: '↘',
    };
  }
  if (mode === 'extend') {
    return {
      title: 'Perpanjang Masa Menginap',
      body: 'Konfirmasi perpanjangan malam menginap dan tentukan tarif per malam tambahan.',
      confirm: 'Konfirmasi Perpanjangan',
      icon: '↗',
    };
  }
  return {
    title: CHECKOUT_DATE_CHANGE_LABEL,
    body: 'Pilih tanggal check-out baru. Tanggal yang sama tidak mengubah masa inap.',
    confirm: 'Konfirmasi',
    icon: '↔',
  };
}

export type CheckoutChangeSubmitResult =
  | { kind: 'noop' }
  | { kind: 'blocked'; reason: string }
  | {
      kind: 'request';
      mode: 'shorten' | 'extend';
      url: string;
      payload: {
        property_id: number | null | undefined;
        new_check_out: string;
        additional_night_rate?: number;
      };
    };

export function buildCheckoutChangeSubmit(input: {
  reservationId: number;
  propertyId?: number | null;
  status: unknown;
  currentCheckout: unknown;
  newCheckout: unknown;
  additionalNightRate?: number;
}): CheckoutChangeSubmitResult {
  const mode = resolveCheckoutChangeMode(input.currentCheckout, input.newCheckout);
  if (mode === 'same') return { kind: 'noop' };
  if (isCheckedInShortenBlocked(input.status, mode)) {
    return { kind: 'blocked', reason: CHECKED_IN_SHORTEN_BLOCKED_MESSAGE };
  }

  const payload: {
    property_id: number | null | undefined;
    new_check_out: string;
    additional_night_rate?: number;
  } = {
    property_id: input.propertyId,
    new_check_out: normalizeHotelDate(input.newCheckout),
  };
  if (mode === 'extend') {
    payload.additional_night_rate = Number(input.additionalNightRate) || 0;
  }

  return {
    kind: 'request',
    mode,
    url: `/api/reservations/${input.reservationId}/${mode}`,
    payload,
  };
}

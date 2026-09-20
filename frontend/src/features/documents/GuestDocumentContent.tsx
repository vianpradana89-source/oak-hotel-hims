import { useCallback, useMemo } from 'react';
import { hotelNightsBetween, normalizeHotelDate } from '../calendar/calendarDates';

export interface PropertyInfoDto {
  id?: number;
  name?: string;
  property_code?: string;
  address?: string;
  phone?: string;
  currency?: string;
}

export interface PropertyBrandingDto {
  displayName?: string;
  shortName?: string;
  logoUrl?: string | null;
  tagline?: string;
}

export interface GuestDocumentContentProps {
  reservation: any;
  propertyInfo?: PropertyInfoDto;
  propertyBranding?: PropertyBrandingDto;
}

/** Indonesian guest-facing date: "15 September 2026" */
export function formatHotelDateIndonesian(dateStr: string | null | undefined): string {
  const normalized = normalizeHotelDate(dateStr ?? '');
  if (!normalized) return '—';
  const [y, m, d] = normalized.split('-').map(Number);
  const dateObj = new Date(Date.UTC(y, m - 1, d));
  return dateObj.toLocaleDateString('id-ID', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatHotelCurrency(
  value: number | string | null | undefined,
  currencyCode?: string,
): string {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num)) return 'Rp 0';
  const currency = currencyCode || 'IDR';
  try {
    return new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(num);
  } catch {
    // Fallback for unsupported currency code
    return `Rp ${Math.round(num).toLocaleString('id-ID')}`;
  }
}

/**
 * Shared helper for the reservation-level document scope label.
 * Shows the specific room/type/date the document covers (single reservation,
 * NOT a booking-group aggregate).
 */
export function reservationScopeLabel(res: any): string {
  const roomNumber = res.room_number ? `Kamar ${res.room_number}` : '';
  const roomType = res.room_type_name || res.room_type || '';
  const parts = [roomNumber, roomType].filter(Boolean);
  return parts.join(' · ');
}

/** Reusable property header block. */
export function PropertyHeader({
  propertyInfo,
  propertyBranding,
}: {
  propertyInfo?: PropertyInfoDto;
  propertyBranding?: PropertyBrandingDto;
}) {
  const hotelName =
    propertyBranding?.displayName || propertyInfo?.name || 'Hotel';
  const tagline = propertyBranding?.tagline;
  const address = propertyInfo?.address;
  const phone = propertyInfo?.phone;
  const logoUrl = propertyBranding?.logoUrl;
  const propertyCode = propertyInfo?.property_code;

  return (
    <div className="guest-doc-header">
      {logoUrl ? (
        <img
          src={logoUrl}
          alt=""
          className="guest-doc-logo"
          onError={(e) => {
            // If logo fails to load, hide it gracefully
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
      ) : null}
      <div className="guest-doc-hotel-info">
        <div className="guest-doc-hotel-name">{hotelName}</div>
        {tagline ? <div className="guest-doc-hotel-tagline">{tagline}</div> : null}
        {propertyCode ? (
          <div className="guest-doc-hotel-address" style={{ marginTop: 2 }}>
            Kode Properti: {propertyCode}
          </div>
        ) : null}
        {address ? <div className="guest-doc-hotel-address">{address}</div> : null}
        {phone ? <div className="guest-doc-hotel-phone">Telp: {phone}</div> : null}
      </div>
    </div>
  );
}

/** Standard document footer */
export function DocumentFooter() {
  const now = new Date();
  const printedDate = now.toLocaleDateString('id-ID', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <div className="guest-doc-footer">
      Dokumen ini dicetak secara otomatis dari sistem OAK HIMS.
      <br />
      Waktu cetak: {printedDate}
    </div>
  );
}

export function useDocumentHelpers(
  res: any,
  propertyInfo?: PropertyInfoDto,
) {
  const currencyCode = propertyInfo?.currency;

  const checkIn = res?.check_in;
  const checkOut = res?.check_out;
  const nights = useMemo(
    () => hotelNightsBetween(checkIn ?? '', checkOut ?? ''),
    [checkIn, checkOut],
  );

  const nightsLabel = nights !== null ? `${nights} malam` : '—';

  const formatCurrency = useCallback(
    (val: number | string | null | undefined) => formatHotelCurrency(val, currencyCode),
    [currencyCode],
  );

  const formatDate = useCallback(
    (d: string | null | undefined) => formatHotelDateIndonesian(d),
    [],
  );

  return { checkIn, checkOut, nights, nightsLabel, formatCurrency, formatDate };
}

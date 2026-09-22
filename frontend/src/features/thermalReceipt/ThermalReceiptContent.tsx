/**
 * Thermal Receipt — Stay / Folio Receipt Component
 *
 * Renders a thermal-print layout for the reservation stay summary.
 * Width controlled via CSS class: thermal-receipt--58 or thermal-receipt--80
 */
import type { ThermalReceiptData, FolioFinancials } from './thermalReceiptTypes';
import {
  formatHotelDateIndonesian,
  formatHotelCurrency,
  formatPaymentStatus,
  formatHotelDateTimeIndonesian,
} from './thermalReceiptFormatters';

interface Props {
  data: ThermalReceiptData;
  financials: FolioFinancials;
}

export default function ThermalReceiptContent({ data, financials }: Props) {
  const { property, reservation, printedBy, printedAt } = data;

  return (
    <div className={`thermal-receipt thermal-receipt--${data.width}`}>
      {/* ── Header ── */}
      <div className="thermal-header">
        {property.logoUrl && (
          <img
            src={property.logoUrl}
            alt="Logo"
            className="thermal-logo"
          />
        )}
        <div className="thermal-hotel-name">{property.displayName || 'OAK HOTEL'}</div>
        {property.tagline && (
          <div className="thermal-hotel-tagline">{property.tagline}</div>
        )}
        {property.address && (
          <div className="thermal-hotel-address">{property.address}</div>
        )}
        {property.phone && (
          <div className="thermal-hotel-phone">Telp: {property.phone}</div>
        )}
      </div>

      <div className="thermal-divider" />

      {/* ── Title ── */}
      <div className="thermal-title">STRUK RESERVASI / MENGINAP</div>

      {/* ── Reservation Info ── */}
      <div className="thermal-section">
        <ThermalRow
          label={reservation.bid ? 'BID' : 'No. Reservasi'}
          value={reservation.bid ?? `#${reservation.id}`}
          mono
        />
        <ThermalRow label="Tamu" value={reservation.guest_name} />
        <ThermalRow label="Kamar" value={reservation.room_number ? `Kamar ${reservation.room_number}` : '—'} />
        <ThermalRow label="Tipe Kamar" value={reservation.room_type_name || '—'} />
        <ThermalRow label="Check-in" value={formatHotelDateIndonesian(reservation.check_in)} mono />
        <ThermalRow label="Check-out" value={formatHotelDateIndonesian(reservation.check_out)} mono />
        {reservation.nights > 0 && (
          <ThermalRow label="Malam" value={`${reservation.nights} malam`} mono />
        )}
        {reservation.guest_count > 1 && (
          <ThermalRow label="Jumlah Tamu" value={`${reservation.guest_count} orang`} mono />
        )}
        {reservation.source && (
          <ThermalRow label="Sumber" value={reservation.source} />
        )}
      </div>

      <div className="thermal-divider" />

      {/* ── Financials ── */}
      <div className="thermal-section">
        <ThermalRow
          label="Total Tagihan"
          value={formatHotelCurrency(financials.total_price)}
          bold
          mono
        />
        {financials.applied_deposit > 0 && (
          <ThermalRow
            label="Deposit Diterapkan"
            value={`−${formatHotelCurrency(financials.applied_deposit)}`}
            mono
          />
        )}
        <ThermalRow
          label="Sudah Dibayar"
          value={`−${formatHotelCurrency(financials.amount_paid)}`}
          mono
        />
      </div>

      <div className="thermal-divider" />

      {/* ── Balance ── */}
      <div className="thermal-row thermal-row--total">
        <span className="thermal-label">Sisa Tagihan</span>
        <span className="thermal-value thermal-value--total">
          {formatHotelCurrency(financials.remaining_balance)}
        </span>
      </div>

      <div className="thermal-divider" />

      {/* ── Status ── */}
      <div className="thermal-status">{formatPaymentStatus(financials.payment_status)}</div>

      {/* ── Footer ── */}
      <div className="thermal-footer">
        <div className="thermal-footer-text">
          Dicetak oleh: <strong>{printedBy}</strong>
        </div>
        <div className="thermal-footer-text">
          {formatHotelDateTimeIndonesian(printedAt)}
        </div>
        <div className="thermal-footer-note">
          Terima kasih atas kunjungan Anda.
        </div>
      </div>
    </div>
  );
}

/* ── Sub-component: single row ── */
function ThermalRow({
  label,
  value,
  mono,
  bold,
}: {
  label: string;
  value: string;
  mono?: boolean;
  bold?: boolean;
}) {
  return (
    <div className={`thermal-row${mono ? ' thermal-row--mono' : ''}${bold ? ' thermal-row--bold' : ''}`}>
      <span className="thermal-label">{label}</span>
      <span className="thermal-value">{value}</span>
    </div>
  );
}

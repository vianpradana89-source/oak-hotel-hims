/**
 * Thermal Receipt — Deposit Receipt Component
 *
 * Renders a thermal-print layout for a single deposit record.
 */
import type { ThermalDepositReceiptData } from './thermalReceiptTypes';
import {
  formatHotelCurrency,
  formatHotelDateTimeIndonesian,
  formatPaymentMethod,
  formatDepositStatus,
} from './thermalReceiptFormatters';

interface Props {
  data: ThermalDepositReceiptData;
}

export default function ThermalDepositReceipt({ data }: Props) {
  const { property, reservation, deposit, printedBy, printedAt } = data;

  return (
    <div className={`thermal-receipt thermal-receipt--${data.width}`}>
      {/* ── Header ── */}
      <div className="thermal-header">
        {property.logoUrl && (
          <img src={property.logoUrl} alt="Logo" className="thermal-logo" />
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
      <div className="thermal-title">BUKTI DEPOSIT UANG</div>

      {/* ── Deposit Info ── */}
      <div className="thermal-section">
        <ThermalRow label="No. Deposit" value={deposit.deposit_number} mono />
        <ThermalRow
          label={reservation.bid ? 'BID' : 'No. Reservasi'}
          value={reservation.bid ?? `#${reservation.id}`}
          mono
        />
        <ThermalRow label="Tamu" value={reservation.guest_name} />
        <ThermalRow
          label="Kamar"
          value={reservation.room_number ? `Kamar ${reservation.room_number}` : '—'}
        />
      </div>

      <div className="thermal-divider" />

      {/* ── Amount & Method ── */}
      <div className="thermal-section">
        <ThermalRow
          label="Jumlah"
          value={formatHotelCurrency(deposit.original_amount)}
          bold
          mono
        />
        <ThermalRow
          label="Metode"
          value={formatPaymentMethod(deposit.payment_method)}
        />
        <ThermalRow
          label="Diterima"
          value={formatHotelDateTimeIndonesian(deposit.created_at)}
          mono
        />
        <ThermalRow
          label="Oleh"
          value={deposit.received_by}
        />
        <ThermalRow
          label="Status"
          value={formatDepositStatus(deposit.status)}
        />
        {deposit.notes && (
          <ThermalRow label="Catatan" value={deposit.notes} />
        )}
      </div>

      <div className="thermal-divider" />

      {/* ── Note ── */}
      <div className="thermal-note">
        Deposit/jaminan, bukan pendapatan final.
      </div>

      {/* ── Signature Area ── */}
      <div className="thermal-signatures">
        <div className="thermal-signature-block">
          <div className="thermal-signature-line" />
          <span className="thermal-signature-label">Tamu</span>
        </div>
        <div className="thermal-signature-block">
          <div className="thermal-signature-line" />
          <span className="thermal-signature-label">Petugas</span>
        </div>
      </div>

      {/* ── Footer ── */}
      <div className="thermal-footer">
        <div className="thermal-footer-text">
          Dicetak oleh: <strong>{printedBy}</strong>
        </div>
        <div className="thermal-footer-text">
          {formatHotelDateTimeIndonesian(printedAt)}
        </div>
      </div>
    </div>
  );
}

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

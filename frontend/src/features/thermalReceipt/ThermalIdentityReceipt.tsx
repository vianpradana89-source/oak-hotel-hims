/**
 * Thermal Receipt — Identity Custody Receipt Component
 *
 * Renders a thermal-print layout for identity document custody record.
 * Document numbers are ALREADY masked by backend — never render raw NIK/passport.
 */
import type { ThermalIdentityReceiptData } from './thermalReceiptTypes';
import {
  formatHotelDateTimeIndonesian,
  formatIdentityStatus,
} from './thermalReceiptFormatters';

interface Props {
  data: ThermalIdentityReceiptData;
}

export default function ThermalIdentityReceipt({ data }: Props) {
  const { property, reservation, identity, printedBy, printedAt } = data;

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
      <div className="thermal-title">BUKTI JAMINAN IDENTITAS</div>

      {/* ── Reservation Info ── */}
      <div className="thermal-section">
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

      {/* ── Identity Info ── */}
      <div className="thermal-section">
        <ThermalRow label="Jenis Dokumen" value={identity.document_type} />
        <ThermalRow label="Nama Pemegang" value={identity.document_holder_name} />
        <ThermalRow label="No. Dokumen" value={identity.document_number_masked ?? '—'} mono />
        <ThermalRow label="Diterima" value={formatHotelDateTimeIndonesian(identity.created_at)} mono />
        <ThermalRow label="Oleh" value={identity.received_by} />
        <ThermalRow label="Status" value={formatIdentityStatus(identity.status)} />
        {identity.storage_location && (
          <ThermalRow label="Lokasi Penyimpanan" value={identity.storage_location} />
        )}
        {identity.notes && (
          <ThermalRow label="Catatan" value={identity.notes} />
        )}
        {identity.status === 'RETURNED' && (
          <>
            <ThermalRow label="Dikembalikan" value={formatHotelDateTimeIndonesian(identity.returned_at ?? '')} mono />
            <ThermalRow label="Oleh" value={identity.returned_by ?? '—'} />
          </>
        )}
      </div>

      <div className="thermal-divider" />

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
        <div className="thermal-footer-note">
          Dokumen identitas tamu yang ditahan selama masa menginap.
        </div>
      </div>
    </div>
  );
}

function ThermalRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className={`thermal-row${mono ? ' thermal-row--mono' : ''}`}>
      <span className="thermal-label">{label}</span>
      <span className="thermal-value">{value}</span>
    </div>
  );
}

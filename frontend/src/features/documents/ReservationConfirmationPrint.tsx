import OakLetterhead from './OakLetterhead';
import { useDocumentHelpers, reservationScopeLabel } from './GuestDocumentContent';
import type { GuestDocumentContentProps } from './GuestDocumentContent';

export default function ReservationConfirmationPrint({
  reservation: res,
  propertyInfo,
  propertyBranding,
}: GuestDocumentContentProps) {
  const {
    checkIn,
    checkOut,
    nightsLabel,
    formatCurrency,
    formatDate,
  } = useDocumentHelpers(res, propertyInfo);

  const bid = res?.bid;
  const guestName = res?.guest_name || res?.booker_name || '---';
  const guestPhone = res?.guest_phone || res?.booker_phone || '';
  const roomNumber = res?.room_number || null;
  const roomTypeName = res?.room_type_name || res?.room_type || '';
  const bookingSource = res?.booking_source;
  const bookingChannel = res?.booking_channel;
  const specialRequests = res?.special_requests;
  const totalPrice = Number(res?.total_price || 0);
  const amountPaid = Number(res?.amount_paid || 0);
  const remainingBalance = Number(res?.remaining_balance || 0);
  const paymentStatus = res?.payment_status;
  const scopeLabel = reservationScopeLabel(res);

  const paymentStatusLabel =
    paymentStatus === 'PAID'
      ? 'LUNAS'
      : paymentStatus === 'PARTIAL'
        ? 'Dibayar Sebagian'
        : 'BELUM LUNAS';

  const sourceLabel =
    bookingSource && bookingSource !== 'WALKIN' ? bookingSource : null;
  const channelLabel =
    bookingChannel && bookingChannel !== 'FRONT_DESK' ? bookingChannel : null;

  return (
    <OakLetterhead
      propertyInfo={propertyInfo}
      propertyBranding={propertyBranding}
      documentTitle="Konfirmasi Reservasi"
    >
      {/* Reference */}
      <div className="oak-doc-section">
        <div className="oak-doc-section-title">Referensi</div>
        <div className="oak-doc-field-grid">
          <div>
            <div className="oak-doc-field-label">No. Booking (BID)</div>
            <div className="oak-doc-field-value">{bid || '---'}</div>
          </div>
          <div>
            <div className="oak-doc-field-label">Cakupan Dokumen</div>
            <div className="oak-doc-field-value">{scopeLabel || 'Reservasi'}</div>
          </div>
        </div>
      </div>

      {/* Guest Info */}
      <div className="oak-doc-section">
        <div className="oak-doc-section-title">Tamu</div>
        <div className="oak-doc-field-grid">
          <div>
            <div className="oak-doc-field-label">Nama</div>
            <div className="oak-doc-field-value">{guestName}</div>
          </div>
          <div>
            <div className="oak-doc-field-label">Telepon</div>
            <div className="oak-doc-field-value">{guestPhone || '---'}</div>
          </div>
          {sourceLabel ? (
            <div>
              <div className="oak-doc-field-label">Sumber Booking</div>
              <div className="oak-doc-field-value">{sourceLabel}</div>
            </div>
          ) : null}
          {channelLabel ? (
            <div>
              <div className="oak-doc-field-label">Kanal</div>
              <div className="oak-doc-field-value">{channelLabel}</div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Stay Details */}
      <div className="oak-doc-section">
        <div className="oak-doc-section-title">Rincian Penginapan</div>
        <div className="oak-doc-field-grid">
          <div>
            <div className="oak-doc-field-label">Check-in</div>
            <div className="oak-doc-field-value">{formatDate(checkIn)}</div>
          </div>
          <div>
            <div className="oak-doc-field-label">Check-out</div>
            <div className="oak-doc-field-value">{formatDate(checkOut)}</div>
          </div>
          <div>
            <div className="oak-doc-field-label">Lama</div>
            <div className="oak-doc-field-value">{nightsLabel}</div>
          </div>
          <div>
            <div className="oak-doc-field-label">Tipe Kamar</div>
            <div className="oak-doc-field-value">{roomTypeName || '---'}</div>
          </div>
          {roomNumber ? (
            <div>
              <div className="oak-doc-field-label">Kamar</div>
              <div className="oak-doc-field-value">{roomNumber}</div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Financial Summary */}
      <div className="oak-doc-section">
        <div className="oak-doc-section-title">Ringkasan Finansial</div>
        <table className="oak-doc-fin-table">
          <tbody>
            <tr>
              <td>Total Reservasi</td>
              <td className="right">{formatCurrency(totalPrice)}</td>
            </tr>
            {amountPaid > 0 ? (
              <tr>
                <td>Jumlah Dibayar</td>
                <td className="right">{formatCurrency(amountPaid)}</td>
              </tr>
            ) : null}
            {remainingBalance > 0 ? (
              <tr>
                <td>Sisa Tagihan</td>
                <td className="right">{formatCurrency(remainingBalance)}</td>
              </tr>
            ) : null}
            <tr className="row-total">
              <td>Status Pembayaran</td>
              <td className="right">{paymentStatusLabel}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Special Requests */}
      {specialRequests && String(specialRequests).trim() ? (
        <div className="oak-doc-section">
          <div className="oak-doc-section-title">Permintaan Khusus</div>
          <div className="oak-doc-requests">{specialRequests}</div>
        </div>
      ) : null}
    </OakLetterhead>
  );
}

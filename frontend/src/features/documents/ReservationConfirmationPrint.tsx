import React from 'react';
import OakLetterhead from './OakLetterhead';
import { useDocumentHelpers, reservationScopeLabel } from './GuestDocumentContent';
import type { GuestDocumentContentProps } from './GuestDocumentContent';
import type { GuestFolioLineDto } from './GuestFolioPrint';

export interface ReservationConfirmationPrintProps extends GuestDocumentContentProps {
  chargeLines?: GuestFolioLineDto[];
  receptionistName?: string | null;
  receptionistRole?: string | null;
  headerRef?: React.Ref<HTMLDivElement>;
  footerRef?: React.Ref<HTMLDivElement>;
}

export default function ReservationConfirmationPrint({
  reservation: res,
  propertyInfo,
  propertyBranding,
  chargeLines,
  receptionistName,
  receptionistRole,
  headerRef,
  footerRef,
}: ReservationConfirmationPrintProps) {
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
  const appliedDeposit = Number((res as any)?.applied_deposit || 0);
  const remainingBalance = Number(res?.remaining_balance || 0);
  const paymentStatus = res?.payment_status;
  const scopeLabel = reservationScopeLabel(res);

  const paymentStatusLabel =
    paymentStatus === 'PAID'
      ? 'LUNAS'
      : paymentStatus === 'PARTIAL'
        ? 'DIBAYAR SEBAGIAN'
        : 'BELUM BAYAR';

  const sourceLabel = bookingSource ? String(bookingSource) : null;
  const channelLabel = bookingChannel ? String(bookingChannel) : null;

  // Build charges to render: use passed chargeLines, or synthesize fallback row if none
  const chargesToRender: GuestFolioLineDto[] =
    chargeLines && chargeLines.length > 0
      ? chargeLines
      : totalPrice > 0
        ? [
            {
              line_id: 'charge-fallback',
              chronology_ts: checkIn || '',
              date_display: formatDate(checkIn),
              created_at_local: '',
              category: 'ROOM_CHARGE',
              entry_type: 'ROOM_CHARGE',
              description: roomNumber
                ? `Kamar ${roomNumber} — ${roomTypeName || 'Sewa Kamar'}`
                : `Tagihan Sewa Kamar — ${roomTypeName || 'Kamar'}`,
              detail_note: null,
              reference: bid || '',
              quantity: res?.nights || 1,
              unit: 'malam',
              qty_label: `${res?.nights || 1} malam`,
              debit: totalPrice,
              credit: 0,
              status_badge: 'POSTED',
              is_audit_only: false,
              included_in_scope: true,
            },
          ]
        : [];

  return (
    <OakLetterhead
      propertyInfo={propertyInfo}
      propertyBranding={propertyBranding}
      documentTitle="Guest Bill"
      headerRef={headerRef}
      footerRef={footerRef}
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
          <div>
            <div className="oak-doc-field-label">Kamar</div>
            <div className="oak-doc-field-value">{roomNumber || '---'}</div>
          </div>
        </div>
      </div>

      {/* Itemized Charges Section (Rincian Tagihan) */}
      <div className="oak-doc-section oak-guest-bill-charges-section">
        <div className="oak-doc-section-title">Rincian Tagihan</div>
        <table className="oak-guest-bill-table">
          <thead>
            <tr>
              <th style={{ width: '18%', textAlign: 'left' }}>Tanggal</th>
              <th style={{ width: '48%', textAlign: 'left' }}>Keterangan</th>
              <th style={{ width: '14%', textAlign: 'center' }}>Qty</th>
              <th style={{ width: '20%', textAlign: 'right' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {chargesToRender.length > 0 ? (
              chargesToRender.map((line, idx) => {
                const isDiscount = line.credit > 0 && line.debit === 0;
                const amountFormatted = isDiscount
                  ? `(${formatCurrency(line.credit)})`
                  : formatCurrency(line.debit);
                return (
                  <tr key={line.line_id || idx}>
                    <td style={{ whiteSpace: 'nowrap' }}>{line.date_display}</td>
                    <td>
                      <div className="oak-guest-bill-charge-desc">{line.description}</div>
                      {line.reference ? (
                        <div className="oak-guest-bill-charge-ref">Ref: {line.reference}</div>
                      ) : null}
                    </td>
                    <td style={{ textAlign: 'center' }}>{line.qty_label || '—'}</td>
                    <td
                      style={{
                        textAlign: 'right',
                        fontVariantNumeric: 'tabular-nums',
                        color: isDiscount ? '#b91c1c' : undefined,
                      }}
                    >
                      {amountFormatted}
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={4} style={{ textAlign: 'center', color: '#888', padding: '12px' }}>
                  Tidak ada rincian tagihan
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Financial Summary & Dual Signature Block wrapped together as closing block (GB6-F03) */}
      <div className="oak-guest-bill-closing-block">
        {/* Financial Summary */}
        <div className="oak-doc-fin-block">
          <div className="oak-doc-section">
            <div className="oak-doc-section-title">Ringkasan Pembayaran</div>
            <table className="oak-doc-fin-table oak-doc-summary-table">
              <tbody>
                <tr>
                  <td>Total Tagihan</td>
                  <td className="right">{formatCurrency(totalPrice)}</td>
                </tr>
                {amountPaid > 0 ? (
                  <tr>
                    <td>Jumlah Dibayar</td>
                    <td className="right">{formatCurrency(amountPaid)}</td>
                  </tr>
                ) : null}
                {appliedDeposit > 0 ? (
                  <tr>
                    <td>Deposit Diterapkan</td>
                    <td className="right">{formatCurrency(appliedDeposit)}</td>
                  </tr>
                ) : null}
                <tr>
                  <td>Sisa Tagihan</td>
                  <td className="right">{formatCurrency(remainingBalance)}</td>
                </tr>
                <tr className="row-total">
                  <td>Status Pembayaran</td>
                  <td className="right">{paymentStatusLabel}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Special Requests */}
        {specialRequests && String(specialRequests).trim() ? (
          <div className="oak-doc-section">
            <div className="oak-doc-section-title">Permintaan Khusus</div>
            <div className="oak-doc-requests">{specialRequests}</div>
          </div>
        ) : null}

        {/* Dual Signature Block */}
        <div className="oak-doc-signature-block">
          <div className="oak-doc-signature-grid">
            <div className="oak-doc-signature-col">
              <div className="oak-doc-signature-title">Guest Signature</div>
              <div className="oak-doc-signature-space" />
              <div className="oak-doc-signature-line" />
              <div className="oak-doc-signature-name">{guestName}</div>
              <div className="oak-doc-signature-role">(Tamu / Guest)</div>
            </div>
            <div className="oak-doc-signature-col">
              <div className="oak-doc-signature-title">Receptionist Signature</div>
              <div className="oak-doc-signature-space" />
              <div className="oak-doc-signature-line" />
              <div className="oak-doc-signature-name">
                {receptionistName || '(......................................................)'}
              </div>
              <div className="oak-doc-signature-role">
                {receptionistRole ? `(${receptionistRole})` : '(Front Office / Receptionist)'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </OakLetterhead>
  );
}

import React from 'react';
import OakLetterhead from '../../documents/OakLetterhead';
import type { PropertyInfoDto, PropertyBrandingDto } from '../../documents/GuestDocumentContent';
import {
  formatHotelDateIndonesian,
  formatHotelCurrency,
} from '../../documents/GuestDocumentContent';
import { maskIdentityNumber } from './registrationFormDraft';

export interface RegistrationFormPrintProps {
  reservation: any;
  propertyInfo?: PropertyInfoDto;
  propertyBranding?: PropertyBrandingDto;
  headerRef?: React.Ref<HTMLDivElement>;
  footerRef?: React.Ref<HTMLDivElement>;
  /** Authoritative folio financials (optional; shown when available) */
  folioFinancials?: {
    total_price: number;
    amount_paid: number;
    applied_deposit: number;
    remaining_balance: number;
    payment_status: 'UNPAID' | 'PARTIAL' | 'PAID';
  } | null;
  /** Deposit list for this reservation (optional) */
  deposits?: Array<{
    id: number;
    deposit_number: string;
    original_amount: number;
    payment_method: string;
    status: string;
    received_by: string;
    created_at: string;
  }> | null;
  /** Identity custody record (optional) */
  identityRecord?: {
    id: number;
    document_type: string;
    document_holder_name: string;
    document_number_masked: string | null;
    status: string;
    received_by: string;
    created_at: string;
  } | null;
  /** Editable Terms & Conditions content */
  terms: string;
}

export default function RegistrationFormPrint({
  reservation: res,
  propertyInfo,
  propertyBranding,
  headerRef,
  footerRef,
  folioFinancials,
  deposits,
  identityRecord,
  terms,
}: RegistrationFormPrintProps) {
  const bid = res?.bid || '—';
  const guestName = res?.guest_name || res?.primary_guest?.name || '—';
  const guestPhone = res?.guest_phone || '—';
  const guestEmail = res?.guest_email || null;
  const identityNumber = res?.primary_guest_identity_number ?? null;
  const identityType = res?.primary_guest_identity_type || null;
  const checkIn = res?.check_in;
  const checkOut = res?.check_out;
  const nights = res?.nights ?? 0;
  const roomTypeName = res?.room_type_name || res?.room_type || '—';
  const roomNumber = res?.room_number || null;
  const source = res?.booking_source || res?.source || null;

  const nightsLabel = nights > 0 ? `${nights} malam` : '—';

  const paymentStatusLabel = (() => {
    if (!folioFinancials) return null;
    const s = folioFinancials.payment_status;
    if (s === 'PAID') return 'LUNAS';
    if (s === 'PARTIAL') return 'Dibayar Sebagian';
    return 'BELUM LUNAS';
  })();

  return (
    <OakLetterhead
      propertyInfo={propertyInfo}
      propertyBranding={propertyBranding}
      documentTitle="Formulir Registrasi & Deposit"
      headerRef={headerRef}
      footerRef={footerRef}
    >
      {/* 1. Informasi Reservasi */}
      <div className="reg-doc-section">
        <div className="oak-doc-section-title">Informasi Reservasi</div>
        <div className="reg-doc-field-grid">
          <div>
            <div className="reg-doc-field-label">No. Booking (BID)</div>
            <div className="reg-doc-field-value">{bid}</div>
          </div>
          {source ? (
            <div>
              <div className="reg-doc-field-label">Sumber Booking</div>
              <div className="reg-doc-field-value">{source}</div>
            </div>
          ) : null}
        </div>
      </div>

      {/* 2. Informasi Tamu */}
      <div className="reg-doc-section">
        <div className="oak-doc-section-title">Informasi Tamu</div>
        <div className="reg-doc-field-grid">
          <div>
            <div className="reg-doc-field-label">Nama Lengkap</div>
            <div className="reg-doc-field-value">{guestName}</div>
          </div>
          <div>
            <div className="reg-doc-field-label">Telepon</div>
            <div className="reg-doc-field-value">{guestPhone}</div>
          </div>
          {guestEmail ? (
            <div>
              <div className="reg-doc-field-label">Email</div>
              <div className="reg-doc-field-value">{guestEmail}</div>
            </div>
          ) : null}
          {identityType ? (
            <div>
              <div className="reg-doc-field-label">Jenis Identitas</div>
              <div className="reg-doc-field-value">{identityType}</div>
            </div>
          ) : null}
          <div>
            <div className="reg-doc-field-label">No. Identitas</div>
            <div className="reg-doc-field-value">{maskIdentityNumber(identityNumber)}</div>
          </div>
        </div>
      </div>

      {/* 3. Informasi Menginap */}
      <div className="reg-doc-section">
        <div className="oak-doc-section-title">Informasi Menginap</div>
        <div className="reg-doc-field-grid">
          <div>
            <div className="reg-doc-field-label">Check-in</div>
            <div className="reg-doc-field-value">{formatHotelDateIndonesian(checkIn)}</div>
          </div>
          <div>
            <div className="reg-doc-field-label">Check-out</div>
            <div className="reg-doc-field-value">{formatHotelDateIndonesian(checkOut)}</div>
          </div>
          <div>
            <div className="reg-doc-field-label">Lama Menginap</div>
            <div className="reg-doc-field-value">{nightsLabel}</div>
          </div>
          <div>
            <div className="reg-doc-field-label">Tipe Kamar</div>
            <div className="reg-doc-field-value">{roomTypeName}</div>
          </div>
          {roomNumber ? (
            <div>
              <div className="reg-doc-field-label">Nomor Kamar</div>
              <div className="reg-doc-field-value">{roomNumber}</div>
            </div>
          ) : null}
        </div>
      </div>

      {/* 4. Informasi Deposit */}
      {deposits && deposits.length > 0 && (
        <div className="reg-doc-section">
          <div className="oak-doc-section-title">Deposit</div>
          <table className="reg-doc-deposit-table">
            <thead>
              <tr>
                <th>No. Deposit</th>
                <th>Jumlah</th>
                <th>Metode</th>
                <th>Status</th>
                <th>Diterima Oleh</th>
                <th>Tanggal</th>
              </tr>
            </thead>
            <tbody>
              {deposits.map((d) => (
                <tr key={d.id}>
                  <td>{d.deposit_number}</td>
                  <td className="right">{formatHotelCurrency(d.original_amount)}</td>
                  <td>{d.payment_method}</td>
                  <td>{d.status}</td>
                  <td>{d.received_by}</td>
                  <td>{formatHotelDateIndonesian(d.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {identityRecord ? (
        <div className="reg-doc-section">
          <div className="oak-doc-section-title">Jaminan Identitas</div>
          <div className="reg-doc-field-grid">
            <div>
              <div className="reg-doc-field-label">Jenis Dokumen</div>
              <div className="reg-doc-field-value">{identityRecord.document_type}</div>
            </div>
            <div>
              <div className="reg-doc-field-label">No. Dokumen</div>
              <div className="reg-doc-field-value">
                {maskIdentityNumber(identityRecord.document_number_masked)}
              </div>
            </div>
            <div>
              <div className="reg-doc-field-label">Status</div>
              <div className="reg-doc-field-value">{identityRecord.status}</div>
            </div>
            <div>
              <div className="reg-doc-field-label">Diterima Oleh</div>
              <div className="reg-doc-field-value">{identityRecord.received_by}</div>
            </div>
          </div>
        </div>
      ) : null}

      {/* 5. Ringkasan Finansial */}
      {folioFinancials ? (
        <div className="reg-doc-fin-block">
          <div className="reg-doc-section">
            <div className="oak-doc-section-title">Ringkasan Finansial</div>
            <table className="oak-doc-fin-table oak-doc-summary-table">
              <tbody>
                <tr>
                  <td>Total Reservasi</td>
                  <td className="right">{formatHotelCurrency(folioFinancials.total_price)}</td>
                </tr>
                <tr>
                  <td>Jumlah Dibayar</td>
                  <td className="right">{formatHotelCurrency(folioFinancials.amount_paid)}</td>
                </tr>
                {folioFinancials.applied_deposit > 0 ? (
                  <tr>
                    <td>Deposit Digunakan</td>
                    <td className="right">
                      {formatHotelCurrency(folioFinancials.applied_deposit)}
                    </td>
                  </tr>
                ) : null}
                <tr>
                  <td>Sisa Tagihan</td>
                  <td className="right">
                    {formatHotelCurrency(folioFinancials.remaining_balance)}
                  </td>
                </tr>
                <tr className="row-total">
                  <td>Status Pembayaran</td>
                  <td className="right">{paymentStatusLabel}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* 6. Terms & Conditions */}
      <div className="reg-doc-section reg-doc-terms-section">
        <div className="oak-doc-section-title">Ketentuan & Syarat</div>
        <div className="reg-doc-terms">{terms}</div>
      </div>

      {/* 7. Tanda Tangan */}
      <div className="reg-doc-section reg-doc-signature-section">
        <div className="oak-doc-section-title">Tanda Tangan</div>
        <div className="reg-doc-signature-row">
          <div className="reg-doc-signature-col">
            <div className="reg-doc-signature-label">Petugas Hotel</div>
            <div className="reg-doc-signature-line" />
          </div>
          <div className="reg-doc-signature-col">
            <div className="reg-doc-signature-label">Tamu</div>
            <div className="reg-doc-signature-line" />
          </div>
        </div>
      </div>
    </OakLetterhead>
  );
}

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
  /** List of sibling reservations for multi-room group bookings */
  siblingReservations?: Array<{
    id: number;
    room_number?: string;
    room_type_name?: string;
  }> | null;
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
  siblingReservations,
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
  const source = res?.booking_source || res?.source || null;

  const nightsLabel = nights > 0 ? `${nights} malam` : '—';

  // Build room number display: single room or comma-separated list for group booking
  const getRoomNumbers = (): string | null => {
    const currentRoom = res?.room_number;
    const siblings = siblingReservations ?? [];

    if (siblings.length === 0 && !currentRoom) return null;
    if (siblings.length === 0 && currentRoom) return currentRoom;

    // Collect unique room numbers from siblings + current
    const roomSet = new Set<string>();
    if (currentRoom) roomSet.add(currentRoom);
    for (const sib of siblings) {
      if (sib.room_number) roomSet.add(sib.room_number);
    }
    const rooms = Array.from(roomSet);
    return rooms.length > 0 ? rooms.sort((a, b) => Number(a) - Number(b)).join(', ') : null;
  };

  const roomNumbers = getRoomNumbers();

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
          {roomNumbers ? (
            <div>
              <div className="reg-doc-field-label">Nomor Kamar</div>
              <div className="reg-doc-field-value">{roomNumbers}</div>
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

      {/* 5. Terms & Conditions */}
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

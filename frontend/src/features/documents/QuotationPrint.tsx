import React from 'react';
import { useMemo } from 'react';
import OakLetterhead from './OakLetterhead';
import type { PropertyInfoDto, PropertyBrandingDto } from './GuestDocumentContent';
import { formatHotelDateIndonesian, formatHotelCurrency } from './GuestDocumentContent';
import { hotelNightsBetween } from '../calendar/calendarDates';
import type { QuotationDraft } from './quotationDraft';
import {
  calculateQuotationDraftTotals,
  buildQuotationDraftFromReservation,
  createBlankQuotationDraft,
} from './quotationDraft';

/* ---------------------------------------------------------------- */
/*  QuotationPrint - OAK HIMS DOCUMENT-1B.1 Step D                  */
/*                                                                  */
/*  Draft-powered quotation print/preview component.                */
/*  Renders directly from QuotationDraft (reservation or manual).   */
/*  Financial totals calculated purely via                          */
/*  calculateQuotationDraftTotals(draft).                           */
/*  No database writes. No canonical mutation.                      */
/* ---------------------------------------------------------------- */

export interface QuotationPrintProps {
  draft?: QuotationDraft;
  /** Compatibility prop for legacy callers passing raw reservation */
  reservation?: any;
  propertyInfo?: PropertyInfoDto;
  propertyBranding?: PropertyBrandingDto;
  headerRef?: React.Ref<HTMLDivElement>;
  footerRef?: React.Ref<HTMLDivElement>;
}

export default function QuotationPrint({
  draft: propDraft,
  reservation: legacyReservation,
  propertyInfo,
  propertyBranding,
  headerRef,
  footerRef,
}: QuotationPrintProps) {
  const currencyCode = propertyInfo?.currency || 'IDR';

  /* Resolve draft: prefer propDraft, fall back to converting legacy reservation */
  const draft: QuotationDraft = useMemo(() => {
    if (propDraft) return propDraft;
    if (legacyReservation) return buildQuotationDraftFromReservation(legacyReservation);
    return createBlankQuotationDraft('manual');
  }, [propDraft, legacyReservation]);

  /* Financial totals calculated purely from editable draft */
  const totals = useMemo(() => calculateQuotationDraftTotals(draft), [draft]);

  /* Nights calculation from checkIn / checkOut */
  const nightsLabel = useMemo(() => {
    if (draft.checkIn && draft.checkOut) {
      const n = hotelNightsBetween(draft.checkIn, draft.checkOut);
      return n != null && n > 0 ? `${n} malam` : null;
    }
    return null;
  }, [draft.checkIn, draft.checkOut]);

  /* Check if at least one stay detail field exists */
  const hasStayDetails = Boolean(
    draft.checkIn?.trim() ||
    draft.checkOut?.trim() ||
    draft.roomType?.trim() ||
    draft.roomNumber?.trim() ||
    (draft.guestCount != null && draft.guestCount > 0)
  );

  /* Check if at least one payment/bank field exists */
  const hasBankInfo = Boolean(
    draft.bankName?.trim() ||
    draft.bankAccountName?.trim() ||
    draft.bankAccountNumber?.trim()
  );

  /* Printable items filter: only items with meaningful description and qty > 0 */
  const printableItems = useMemo(() => {
    return draft.items
      .map((item, originalIndex) => ({ item, originalIndex }))
      .filter(
        ({ item }) =>
          Boolean(item.description && item.description.trim() !== '') &&
          Number(item.qty) > 0
      );
  }, [draft.items]);

  return (
    <OakLetterhead
      propertyInfo={propertyInfo}
      propertyBranding={propertyBranding}
      documentTitle="Quotation / Penawaran"
      headerRef={headerRef}
      footerRef={footerRef}
    >
      {/* 1. Meta / Reference */}
      <div className="oak-doc-section">
        <div className="oak-doc-section-title">Informasi Dokumen</div>
        <div className="oak-doc-field-grid">
          {draft.quotationNumber?.trim() ? (
            <div>
              <div className="oak-doc-field-label">No. Quotation</div>
              <div className="oak-doc-field-value">{draft.quotationNumber}</div>
            </div>
          ) : null}
          <div>
            <div className="oak-doc-field-label">Tanggal Penawaran</div>
            <div className="oak-doc-field-value">
              {formatHotelDateIndonesian(draft.quotationDate)}
            </div>
          </div>
          {draft.validUntil?.trim() ? (
            <div>
              <div className="oak-doc-field-label">Berlaku Sampai</div>
              <div className="oak-doc-field-value">
                {formatHotelDateIndonesian(draft.validUntil)}
              </div>
            </div>
          ) : null}
          {draft.reference?.trim() ? (
            <div>
              <div className="oak-doc-field-label">Referensi / BID</div>
              <div className="oak-doc-field-value">{draft.reference}</div>
            </div>
          ) : null}
          {draft.subject?.trim() ? (
            <div>
              <div className="oak-doc-field-label">Perihal</div>
              <div className="oak-doc-field-value">{draft.subject}</div>
            </div>
          ) : null}
        </div>
      </div>

      {/* 2. Customer / Recipient */}
      <div className="oak-doc-section">
        <div className="oak-doc-section-title">Penerima Penawaran</div>
        <div className="oak-doc-field-grid">
          <div>
            <div className="oak-doc-field-label">Nama Tamu / Perusahaan</div>
            <div className="oak-doc-field-value">
              {draft.customerName?.trim() || '—'}
            </div>
          </div>
          {draft.contactPerson?.trim() ? (
            <div>
              <div className="oak-doc-field-label">Contact Person</div>
              <div className="oak-doc-field-value">{draft.contactPerson}</div>
            </div>
          ) : null}
          {draft.phone?.trim() ? (
            <div>
              <div className="oak-doc-field-label">Telepon</div>
              <div className="oak-doc-field-value">{draft.phone}</div>
            </div>
          ) : null}
          {draft.email?.trim() ? (
            <div>
              <div className="oak-doc-field-label">Email</div>
              <div className="oak-doc-field-value">{draft.email}</div>
            </div>
          ) : null}
          {draft.address?.trim() ? (
            <div>
              <div className="oak-doc-field-label">Alamat</div>
              <div className="oak-doc-field-value">{draft.address}</div>
            </div>
          ) : null}
        </div>
      </div>

      {/* 3. Stay Details (rendered only if at least one stay field exists) */}
      {hasStayDetails ? (
        <div className="oak-doc-section">
          <div className="oak-doc-section-title">Rincian Penginapan</div>
          <div className="oak-doc-field-grid">
            {draft.checkIn?.trim() ? (
              <div>
                <div className="oak-doc-field-label">Check-in</div>
                <div className="oak-doc-field-value">
                  {formatHotelDateIndonesian(draft.checkIn)}
                </div>
              </div>
            ) : null}
            {draft.checkOut?.trim() ? (
              <div>
                <div className="oak-doc-field-label">Check-out</div>
                <div className="oak-doc-field-value">
                  {formatHotelDateIndonesian(draft.checkOut)}
                </div>
              </div>
            ) : null}
            {nightsLabel ? (
              <div>
                <div className="oak-doc-field-label">Lama Menginap</div>
                <div className="oak-doc-field-value">{nightsLabel}</div>
              </div>
            ) : null}
            {draft.roomType?.trim() ? (
              <div>
                <div className="oak-doc-field-label">Tipe Kamar</div>
                <div className="oak-doc-field-value">{draft.roomType}</div>
              </div>
            ) : null}
            {draft.roomNumber?.trim() ? (
              <div>
                <div className="oak-doc-field-label">Nomor Kamar</div>
                <div className="oak-doc-field-value">{draft.roomNumber}</div>
              </div>
            ) : null}
            {draft.guestCount != null && draft.guestCount > 0 ? (
              <div>
                <div className="oak-doc-field-label">Jumlah Tamu</div>
                <div className="oak-doc-field-value">
                  {`${draft.guestCount} orang`}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 4. Line Item Table */}
      <div className="oak-doc-section">
        <div className="oak-doc-section-title">Rincian Item Penawaran</div>
        {printableItems.length === 0 ? (
          <div style={{ padding: '16px', textAlign: 'center', color: '#888', fontStyle: 'italic', fontSize: '11px', background: '#faf9f6', borderRadius: '4px', border: '1px dashed #e4dfd7' }}>
            Belum ada item penawaran.
          </div>
        ) : (
          <table className="oak-doc-fin-table">
            <thead>
              <tr>
                <th style={{ width: '36px', textAlign: 'center' }}>No.</th>
                <th>Deskripsi</th>
                <th className="right" style={{ width: '50px' }}>Qty</th>
                <th style={{ width: '60px' }}>Satuan</th>
                <th className="right" style={{ width: '110px' }}>Harga Satuan</th>
                <th className="right" style={{ width: '110px' }}>Jumlah</th>
              </tr>
            </thead>
            <tbody>
              {printableItems.map(({ item, originalIndex }, printableIndex) => {
                const amount = totals.itemTotals[originalIndex] ?? 0;
                return (
                  <tr key={item.id || originalIndex}>
                    <td style={{ textAlign: 'center', color: '#888' }}>{printableIndex + 1}</td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{item.description}</div>
                      {item.note?.trim() ? (
                        <div style={{ fontSize: '10px', color: '#666', marginTop: '2px', whiteSpace: 'pre-line', wordBreak: 'break-word' }}>
                          {item.note}
                        </div>
                      ) : null}
                    </td>
                    <td className="right">{item.qty}</td>
                    <td>{item.unit?.trim() || ''}</td>
                    <td className="right">
                      {formatHotelCurrency(item.unitPrice, currencyCode)}
                    </td>
                    <td className="right" style={{ fontWeight: 600 }}>
                      {formatHotelCurrency(amount, currencyCode)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* 5. Financial Summary */}
      <div className="oak-doc-section">
        <div className="oak-doc-section-title">Ringkasan Finansial</div>
        <table className="oak-doc-fin-table oak-doc-summary-table">
          <tbody>
            <tr>
              <td>Subtotal</td>
              <td className="right">{formatHotelCurrency(totals.subtotal, currencyCode)}</td>
            </tr>
            {totals.discountAmount > 0 ? (
              <tr>
                <td>
                  Diskon
                  {draft.discountType === 'percent' && Number(draft.discountValue) > 0
                    ? ` (${draft.discountValue}%)`
                    : ''}
                </td>
                <td className="right" style={{ color: '#b91c1c' }}>
                  -{formatHotelCurrency(totals.discountAmount, currencyCode)}
                </td>
              </tr>
            ) : null}
            {totals.serviceAmount > 0 ? (
              <tr>
                <td>
                  Service Charge
                  {draft.serviceType === 'percent' && Number(draft.serviceValue) > 0
                    ? ` (${draft.serviceValue}%)`
                    : ''}
                </td>
                <td className="right">
                  +{formatHotelCurrency(totals.serviceAmount, currencyCode)}
                </td>
              </tr>
            ) : null}
            {totals.taxAmount > 0 ? (
              <tr>
                <td>
                  Pajak (PB1 / PPN)
                  {draft.taxType === 'percent' && Number(draft.taxValue) > 0
                    ? ` (${draft.taxValue}%)`
                    : ''}
                </td>
                <td className="right">
                  +{formatHotelCurrency(totals.taxAmount, currencyCode)}
                </td>
              </tr>
            ) : null}
            <tr className="row-total">
              <td>Total Penawaran</td>
              <td className="right" style={{ fontSize: '13px', fontWeight: 700, color: '#1a3328' }}>
                {formatHotelCurrency(totals.grandTotal, currencyCode)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* 6. Notes */}
      {draft.notes?.trim() ? (
        <div className="oak-doc-section">
          <div className="oak-doc-section-title">Catatan</div>
          <div className="oak-doc-requests">
            {draft.notes}
          </div>
        </div>
      ) : null}

      {/* 7. Terms & Conditions */}
      {draft.terms?.trim() ? (
        <div className="oak-doc-section">
          <div className="oak-doc-section-title">Syarat &amp; Ketentuan</div>
          <div className="oak-doc-requests">
            {draft.terms}
          </div>
        </div>
      ) : null}

      {/* 8. Payment Instructions (only if at least one bank field is non-empty) */}
      {hasBankInfo ? (
        <div className="oak-doc-section">
          <div className="oak-doc-section-title">Instruksi Pembayaran</div>
          <div className="oak-doc-field-grid">
            {draft.bankName?.trim() ? (
              <div>
                <div className="oak-doc-field-label">Bank</div>
                <div className="oak-doc-field-value">{draft.bankName}</div>
              </div>
            ) : null}
            {draft.bankAccountName?.trim() ? (
              <div>
                <div className="oak-doc-field-label">Atas Nama (A/N)</div>
                <div className="oak-doc-field-value">{draft.bankAccountName}</div>
              </div>
            ) : null}
            {draft.bankAccountNumber?.trim() ? (
              <div>
                <div className="oak-doc-field-label">Nomor Rekening</div>
                <div className="oak-doc-field-value" style={{ fontWeight: 600, letterSpacing: '0.04em' }}>
                  {draft.bankAccountNumber}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </OakLetterhead>
  );
}

import React from 'react';
import OakLetterhead from './OakLetterhead';
import {
  formatHotelCurrency as formatIDR,
  formatHotelDateIndonesian as formatDateIndonesian,
  type PropertyInfoDto,
  type PropertyBrandingDto,
} from './GuestDocumentContent';
import './guestDocumentPrint.css';

export type GuestFolioScope = 'GUEST_FOLIO' | 'FULL_RESERVATION';
export type GuestFolioViewMode = 'EFFECTIVE' | 'AUDIT';

export interface GuestFolioLineDto {
  line_id: string;
  chronology_ts: string;
  date_display: string;
  created_at_local: string;
  category:
    | 'ROOM_CHARGE'
    | 'STAY_EXTENSION'
    | 'MINIBAR'
    | 'LAUNDRY'
    | 'FNB_POS'
    | 'STAY_CHARGE'
    | 'CHARGE_ADJUSTMENT'
    | 'INCIDENTAL_CHARGE'
    | 'DISCOUNT'
    | 'PAYMENT'
    | 'GROUP_PAYMENT_ALLOCATION'
    | 'DEPOSIT_APPLY'
    | 'DEPOSIT_UNAPPLY'
    | 'REVERSAL'
    | string;
  entry_type: string;
  description: string;
  detail_note: string | null;
  reference: string;
  quantity?: number | null;
  unit?: string | null;
  qty_label?: string | null;
  debit: number;
  credit: number;
  status_badge:
    | 'POSTED'
    | 'VOIDED'
    | 'CORRECTED'
    | 'REPLACEMENT'
    | 'REVERSAL'
    | 'GROUP_ALLOCATION'
    | 'OTA_COVERED';
  is_audit_only: boolean;
  included_in_scope: boolean;
}

export interface GuestFolioDepositCustodyItemDto {
  id: number;
  deposit_number: string;
  payment_method: string;
  received_at_local: string;
  effective_received: number;
  applied: number;
  refunded: number;
  remaining: number;
  status: string;
  notes: string | null;
}

export interface GuestFolioDepositCustodySummaryDto {
  can_view: boolean;
  has_deposits: boolean;
  effective_received: number;
  applied_to_folio: number;
  refunded: number;
  remaining_held_custody: number;
  items: GuestFolioDepositCustodyItemDto[];
}

export interface GuestFolioBookingSiblingDto {
  id: number;
  room_number: string | null;
  room_type_name: string | null;
  guest_name: string;
  status: string;
  check_in: string;
  check_out: string;
}

export interface GuestFolioDocumentDto {
  reservation_id: number;
  booking_id: number;
  bid: string | null;
  legacy_booking_number: string | null;
  folio_number: string;
  is_derived_reference?: boolean;
  folio_label?: string;
  reference_label: 'Kode Booking' | 'No. Booking' | 'ID Reservasi';
  reference_value: string;

  property: {
    id: number;
    name: string;
    property_code: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
    timezone: string;
  };

  guest_name: string;
  guest_phone: string | null;
  guest_email: string | null;
  guest_address: string | null;

  booker_name: string | null;
  booker_phone: string | null;
  booker_email: string | null;
  ota_name: string | null;
  booking_source: string | null;
  booking_channel: string | null;

  payment_responsibility: 'HOTEL_COLLECT' | 'OTA_COLLECT';
  payment_responsibility_label: string;
  scope: GuestFolioScope;
  scope_label: string;

  check_in: string;
  check_out: string;
  nights: number;
  status: string;
  status_label: string;
  room_number: string | null;
  room_type_name: string | null;
  room_type_code: string | null;
  pax: number;

  is_multi_room_booking: boolean;
  booking_siblings: GuestFolioBookingSiblingDto[];

  effective_lines: GuestFolioLineDto[];
  audit_lines: GuestFolioLineDto[];
  ota_covered_lines: GuestFolioLineDto[];

  summary: {
    gross_charges: number;
    discounts_and_reversals: number;
    net_total_charges: number;
    ota_covered_charges: number;
    effective_amount_paid: number;
    applied_deposit: number;
    remaining_balance: number;
    overpayment_excess: number;
    payment_status: 'UNPAID' | 'PARTIAL' | 'PAID';
    payment_status_label: 'BELUM BAYAR' | 'DIBAYAR SEBAGIAN' | 'LUNAS';
    canonical_payment_source: 'CANONICAL_TRANSACTIONS' | 'FOLIO_FALLBACK';
  };

  reconciliation: {
    effective_debit_total: number;
    effective_credit_total: number;
    effective_net_balance: number;
    effective_signed_balance?: number;
    audit_debit_total: number;
    audit_credit_total: number;
    audit_net_balance: number;
    audit_signed_balance?: number;
    calculator_remaining_balance: number;
    calculator_signed_balance?: number;
    is_reconciled: boolean;
    discrepancy_amount: number;
    discrepancy_reasons?: string[];
  };

  deposit_custody: GuestFolioDepositCustodySummaryDto;

  print_metadata: {
    printed_at_iso: string;
    printed_at_local: string;
    printed_by_name: string;
    printed_by_role: string;
  };
}

export interface GuestFolioPrintProps {
  data: GuestFolioDocumentDto;
  propertyInfo?: PropertyInfoDto;
  propertyBranding?: PropertyBrandingDto;
  viewMode?: GuestFolioViewMode;
  customFooterNote?: string;
  cashierSignatureLabel?: string;
  headerRef?: React.Ref<HTMLDivElement>;
  footerRef?: React.Ref<HTMLDivElement>;
}

function getBadgeLabelAndClass(badge: GuestFolioLineDto['status_badge']): {
  label: string;
  className: string;
} | null {
  switch (badge) {
    case 'REPLACEMENT':
      return { label: 'Koreksi Aktif', className: 'oak-folio-badge oak-folio-badge-replacement' };
    case 'GROUP_ALLOCATION':
      return { label: 'Alokasi Grup', className: 'oak-folio-badge oak-folio-badge-group' };
    case 'VOIDED':
      return { label: 'Dibatalkan (Void)', className: 'oak-folio-badge oak-folio-badge-void' };
    case 'CORRECTED':
      return { label: 'Digantikan (Koreksi)', className: 'oak-folio-badge oak-folio-badge-void' };
    case 'REVERSAL':
      return { label: 'Jurnal Pembalik', className: 'oak-folio-badge oak-folio-badge-reversal' };
    case 'OTA_COVERED':
      return { label: 'Ditanggung OTA', className: 'oak-folio-badge oak-folio-badge-ota' };
    default:
      return null;
  }
}

export default function GuestFolioPrint({
  data,
  propertyInfo,
  propertyBranding,
  viewMode = 'EFFECTIVE',
  customFooterNote,
  cashierSignatureLabel,
  headerRef,
  footerRef,
}: GuestFolioPrintProps) {
  const effectivePropertyInfo: PropertyInfoDto = propertyInfo || {
    id: data.property.id,
    name: data.property.name,
    property_code: data.property.property_code ?? undefined,
    address: data.property.address ?? undefined,
    phone: data.property.phone ?? undefined,
  };

  const lines = viewMode === 'AUDIT' ? data.audit_lines : data.effective_lines;
  const totalDebit =
    viewMode === 'AUDIT'
      ? data.reconciliation.audit_debit_total
      : data.reconciliation.effective_debit_total;
  const totalCredit =
    viewMode === 'AUDIT'
      ? data.reconciliation.audit_credit_total
      : data.reconciliation.effective_credit_total;

  // Determine Booker / Company / Agent display
  const bookerOrAgentDisplay = (() => {
    const parts: string[] = [];
    if (
      data.booker_name &&
      data.booker_name.trim() &&
      data.booker_name.trim().toLowerCase() !== (data.guest_name || '').trim().toLowerCase()
    ) {
      parts.push(data.booker_name.trim());
    }
    if (data.ota_name && data.ota_name.trim()) {
      parts.push(data.ota_name.trim());
    } else if (data.booking_channel && data.booking_channel.trim()) {
      parts.push(data.booking_channel.trim());
    }
    return parts.length > 0 ? parts.join(' · ') : 'Tamu Langsung (Direct / Walk-In)';
  })();

  const guestContactDisplay = (() => {
    const parts: string[] = [];
    if (data.guest_phone && data.guest_phone.trim()) parts.push(data.guest_phone.trim());
    if (data.guest_email && data.guest_email.trim()) parts.push(data.guest_email.trim());
    return parts.length > 0 ? parts.join(' · ') : '—';
  })();

  const roomDisplay = (() => {
    const num = data.room_number ? `Kamar ${data.room_number}` : 'Belum Ditetapkan';
    const type = data.room_type_name || data.room_type_code || '—';
    return `${num} · ${type}`;
  })();

  const statusBadgeClass =
    data.summary.payment_status === 'PAID'
      ? 'oak-folio-status-paid'
      : data.summary.payment_status === 'PARTIAL'
      ? 'oak-folio-status-partial'
      : 'oak-folio-status-unpaid';

  const cashierName =
    cashierSignatureLabel && cashierSignatureLabel.trim()
      ? cashierSignatureLabel.trim()
      : data.print_metadata.printed_by_name || 'Front Office / Kasir';

  return (
    <OakLetterhead
      propertyInfo={effectivePropertyInfo}
      propertyBranding={propertyBranding}
      documentTitle="Tagihan Tamu / Guest Folio"
      headerRef={headerRef}
      footerRef={footerRef}
    >
      {/* ── 1. HEADER IDENTITAS TAMU & MENGINAP (Swiss-Belinn Style 2-Column) ── */}
      <div className="oak-doc-section oak-folio-identity-box">
        <div className="oak-folio-identity-grid">
          {/* Kolom Kiri: Identitas Tamu, Pemesan & Pembayar */}
          <div className="oak-folio-identity-col">
            <div className="oak-folio-kv-row">
              <span className="oak-folio-kv-label">Nama Tamu</span>
              <span className="oak-folio-kv-sep">:</span>
              <span className="oak-folio-kv-value oak-folio-kv-strong">
                {data.guest_name || '—'}
              </span>
            </div>
            <div className="oak-folio-kv-row">
              <span className="oak-folio-kv-label">Pemesan / Agen</span>
              <span className="oak-folio-kv-sep">:</span>
              <span className="oak-folio-kv-value">{bookerOrAgentDisplay}</span>
            </div>
            <div className="oak-folio-kv-row">
              <span className="oak-folio-kv-label">Kontak Tamu</span>
              <span className="oak-folio-kv-sep">:</span>
              <span className="oak-folio-kv-value">{guestContactDisplay}</span>
            </div>
            {data.guest_address ? (
              <div className="oak-folio-kv-row">
                <span className="oak-folio-kv-label">Alamat</span>
                <span className="oak-folio-kv-sep">:</span>
                <span className="oak-folio-kv-value">{data.guest_address}</span>
              </div>
            ) : null}
            <div className="oak-folio-kv-row">
              <span className="oak-folio-kv-label">Penanggung Jawab</span>
              <span className="oak-folio-kv-sep">:</span>
              <span className="oak-folio-kv-value">{data.payment_responsibility_label}</span>
            </div>
            <div className="oak-folio-kv-row">
              <span className="oak-folio-kv-label">Cakupan Folio</span>
              <span className="oak-folio-kv-sep">:</span>
              <span className="oak-folio-kv-value">{data.scope_label}</span>
            </div>
          </div>

          {/* Kolom Kanan: Identitas Folio, Kamar & Periode Menginap */}
          <div className="oak-folio-identity-col">
            <div className="oak-folio-kv-row">
              <span className="oak-folio-kv-label">
                {data.folio_label || (data.is_derived_reference ? 'No. Referensi Folio (Turunan)' : 'No. Folio')}
              </span>
              <span className="oak-folio-kv-sep">:</span>
              <span className="oak-folio-kv-value oak-folio-kv-strong">{data.folio_number}</span>
            </div>
            <div className="oak-folio-kv-row">
              <span className="oak-folio-kv-label">{data.reference_label}</span>
              <span className="oak-folio-kv-sep">:</span>
              <span className="oak-folio-kv-value">
                {data.reference_value} (Res #{data.reservation_id})
              </span>
            </div>
            <div className="oak-folio-kv-row">
              <span className="oak-folio-kv-label">Kamar / Tipe</span>
              <span className="oak-folio-kv-sep">:</span>
              <span className="oak-folio-kv-value oak-folio-kv-strong">{roomDisplay}</span>
            </div>
            <div className="oak-folio-kv-row">
              <span className="oak-folio-kv-label">Check-In</span>
              <span className="oak-folio-kv-sep">:</span>
              <span className="oak-folio-kv-value">{formatDateIndonesian(data.check_in)}</span>
            </div>
            <div className="oak-folio-kv-row">
              <span className="oak-folio-kv-label">Check-Out</span>
              <span className="oak-folio-kv-sep">:</span>
              <span className="oak-folio-kv-value">{formatDateIndonesian(data.check_out)}</span>
            </div>
            <div className="oak-folio-kv-row">
              <span className="oak-folio-kv-label">Durasi & Status</span>
              <span className="oak-folio-kv-sep">:</span>
              <span className="oak-folio-kv-value">
                {data.nights} Malam · {data.pax} Tamu · <strong>{data.status_label}</strong>
              </span>
            </div>
          </div>
        </div>

        {data.is_multi_room_booking && (
          <div className="oak-folio-multiroom-banner">
            <strong>Reservasi Grup / Multi-Kamar ({data.bid || `Booking #${data.booking_id}`}):</strong>{' '}
            Folio ini menampilkan rincian khusus untuk <strong>{roomDisplay}</strong> (Res #{data.reservation_id})
            dan tidak menggabungkan tagihan kamar lain secara diam-diam.
          </div>
        )}
      </div>

      {/* ── 2. RINCIAN TRANSAKSI FOLIO (CHRONOLOGICAL DEBIT / CREDIT) ── */}
      <div className="oak-doc-section oak-folio-transactions-section">
        <div className="oak-folio-section-header">
          <div className="oak-doc-section-title" style={{ marginBottom: 0, borderBottom: 'none' }}>
            Rincian Transaksi Folio{' '}
            {viewMode === 'AUDIT' ? '(Mode Jejak Audit Lengkap)' : '(Item Efektif)'}
          </div>
          <div className="oak-folio-debit-credit-legend">
            <strong>Debit (+)</strong> menambah tagihan · <strong>Kredit (-)</strong> mengurangi tagihan
          </div>
        </div>

        <table className="oak-doc-fin-table oak-folio-table">
          <thead>
            <tr>
              <th style={{ width: '15%' }}>Tanggal</th>
              <th style={{ width: '43%' }}>Uraian / Keterangan Transaksi</th>
              <th style={{ width: '14%' }}>Referensi</th>
              <th className="right" style={{ width: '14%' }}>
                Debit (+)
              </th>
              <th className="right" style={{ width: '14%' }}>
                Kredit (-)
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', color: '#777', padding: '14px 8px' }}>
                  Belum ada transaksi aktif yang tercatat pada cakupan folio ini.
                </td>
              </tr>
            ) : (
              lines.map((line) => {
                const badgeInfo = getBadgeLabelAndClass(line.status_badge);
                const isAuditDimmed =
                  line.status_badge === 'VOIDED' ||
                  line.status_badge === 'CORRECTED' ||
                  line.status_badge === 'REVERSAL';

                return (
                  <tr
                    key={line.line_id}
                    className={isAuditDimmed ? 'oak-folio-row-audit' : undefined}
                  >
                    <td className="oak-folio-col-date">{line.date_display}</td>
                    <td>
                      <div className="oak-folio-desc-main">
                        <span>{line.description}</span>
                        {badgeInfo && (
                          <span className={badgeInfo.className}>{badgeInfo.label}</span>
                        )}
                      </div>
                      {line.detail_note ? (
                        <div className="oak-folio-desc-sub">{line.detail_note}</div>
                      ) : null}
                    </td>
                    <td className="oak-folio-col-ref">{line.reference}</td>
                    <td className="right">
                      {line.debit > 0 ? formatIDR(line.debit) : '—'}
                    </td>
                    <td className="right">
                      {line.credit > 0 ? formatIDR(line.credit) : '—'}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          <tfoot>
            <tr className="oak-folio-table-subtotal">
              <td colSpan={3} className="right">
                Total Mutasi Folio ({viewMode === 'AUDIT' ? 'Jejak Audit' : 'Efektif'})
              </td>
              <td className="right">{formatIDR(totalDebit)}</td>
              <td className="right">{formatIDR(totalCredit)}</td>
            </tr>
          </tfoot>
        </table>

        {/* OTA Collect note when guest scope excludes base room charge */}
        {data.scope === 'GUEST_FOLIO' &&
          data.payment_responsibility === 'OTA_COLLECT' &&
          data.summary.ota_covered_charges > 0 && (
            <div className="oak-folio-ota-note">
              <strong>Informasi OTA Collect:</strong> Tagihan sewa kamar dasar sebesar{' '}
              <strong>{formatIDR(data.summary.ota_covered_charges)}</strong> ditagihkan langsung
              kepada pihak OTA/Agen ({data.ota_name || data.booking_channel || 'OTA'}) dan tidak
              dibebankan pada kewajiban bayar tamu di hotel. Pilih cakupan{' '}
              <em>&ldquo;Seluruh Tagihan Kamar&rdquo;</em> bila memerlukan rincian nilai kamar penuh.
            </div>
          )}
      </div>

      {/* ── 3. RINGKASAN FINANSIAL REKONSILIASI (INDIVISIBLE BLOCK) ── */}
      <div className="oak-doc-section oak-doc-fin-block oak-folio-summary-block">
        <div className="oak-doc-section-title">Ringkasan Tagihan &amp; Pembayaran</div>
        <div className="oak-folio-summary-layout">
          <div className="oak-folio-status-card">
            <div className="oak-folio-status-caption">Status Penyelesaian Folio</div>
            <div className={`oak-folio-status-badge ${statusBadgeClass}`}>
              {data.summary.payment_status_label}
            </div>
            <div className="oak-folio-status-sub">
              {data.summary.remaining_balance === 0 && data.summary.overpayment_excess === 0
                ? 'Seluruh kewajiban tagihan pada cakupan folio ini telah diselesaikan.'
                : data.summary.overpayment_excess > 0
                ? `Terdapat kelebihan pembayaran (kredit tamu) sebesar ${formatIDR(
                    data.summary.overpayment_excess
                  )}.`
                : `Sisa tagihan yang masih harus diselesaikan: ${formatIDR(
                    data.summary.remaining_balance
                  )}.`}
            </div>
          </div>

          <table className="oak-doc-fin-table oak-doc-summary-table oak-folio-summary-numbers">
            <tbody>
              <tr>
                <td>Total Tagihan Bersih (Net Charges)</td>
                <td className="right">{formatIDR(data.summary.net_total_charges)}</td>
              </tr>
              <tr>
                <td>Total Pembayaran Efektif Diterima</td>
                <td className="right">
                  {data.summary.effective_amount_paid > 0
                    ? `- ${formatIDR(data.summary.effective_amount_paid)}`
                    : formatIDR(0)}
                </td>
              </tr>
              {(data.summary.applied_deposit > 0 || data.deposit_custody.has_deposits) && (
                <tr>
                  <td>Deposit Jaminan Diterapkan ke Tagihan (Deposit Apply)</td>
                  <td className="right">
                    {data.summary.applied_deposit > 0
                      ? `- ${formatIDR(data.summary.applied_deposit)}`
                      : formatIDR(0)}
                  </td>
                </tr>
              )}
              <tr className="row-total">
                <td>Sisa Tagihan / Saldo Akhir (Balance Due)</td>
                <td className="right">{formatIDR(data.summary.remaining_balance)}</td>
              </tr>
              {data.summary.overpayment_excess > 0 && (
                <tr className="oak-folio-overpayment-row">
                  <td>Kelebihan Pembayaran / Saldo Kredit Tamu</td>
                  <td className="right">{formatIDR(data.summary.overpayment_excess)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── 4. INFORMASI DEPOSIT / JAMINAN CUSTODY (TERPISAH DARI SALDO FOLIO) ── */}
      {data.deposit_custody.can_view && data.deposit_custody.has_deposits && (
        <div className="oak-doc-section oak-doc-fin-block oak-folio-custody-block">
          <div className="oak-doc-section-title">
            Informasi Deposit / Jaminan Kamar (Custody Terpisah)
          </div>
          <div className="oak-folio-custody-grid">
            <div className="oak-folio-custody-metric">
              <span className="oak-folio-custody-label">Deposit Diterima</span>
              <span className="oak-folio-custody-val">
                {formatIDR(data.deposit_custody.effective_received)}
              </span>
            </div>
            <div className="oak-folio-custody-metric">
              <span className="oak-folio-custody-label">Diterapkan ke Folio</span>
              <span className="oak-folio-custody-val">
                {formatIDR(data.deposit_custody.applied_to_folio)}
              </span>
            </div>
            <div className="oak-folio-custody-metric">
              <span className="oak-folio-custody-label">Dikembalikan (Refund)</span>
              <span className="oak-folio-custody-val">
                {formatIDR(data.deposit_custody.refunded)}
              </span>
            </div>
            <div className="oak-folio-custody-metric oak-folio-custody-highlight">
              <span className="oak-folio-custody-label">Sisa Jaminan Ditahan (Custody)</span>
              <span className="oak-folio-custody-val">
                {formatIDR(data.deposit_custody.remaining_held_custody)}
              </span>
            </div>
          </div>
          <div className="oak-folio-custody-note">
            * Catatan Akuntansi: Sisa Jaminan Ditahan (Held Custody) merupakan dana titipan jaminan
            tamu di hotel dan <strong>tidak mengurangi Sisa Tagihan Folio</strong> kecuali telah
            diposting sebagai <em>Deposit Diterapkan (Deposit Apply)</em>.
          </div>
        </div>
      )}

      {/* ── 5. PERSETUJUAN, TANDA TANGAN & METADATA CETAK ── */}
      <div className="oak-doc-section oak-doc-fin-block oak-folio-signature-block">
        <div className="oak-folio-legal-statement">
          {customFooterNote && customFooterNote.trim()
            ? customFooterNote.trim()
            : 'Saya menyatakan bahwa rincian tagihan kamar, layanan tambahan, dan pembayaran pada Guest Folio ini telah diperiksa dan disetujui.'}
        </div>

        <div className="oak-folio-signature-grid">
          <div className="oak-folio-sig-col">
            <div className="oak-folio-sig-title">Tanda Tangan Tamu / Guest Signature</div>
            <div className="oak-folio-sig-space" />
            <div className="oak-folio-sig-name">( {data.guest_name || 'Tamu'} )</div>
            <div className="oak-folio-sig-role">Tamu / Penanggung Jawab</div>
          </div>

          <div className="oak-folio-sig-col">
            <div className="oak-folio-sig-title">Petugas Kasir / Front Office</div>
            <div className="oak-folio-sig-space" />
            <div className="oak-folio-sig-name">( {cashierName} )</div>
            <div className="oak-folio-sig-role">{data.print_metadata.printed_by_role}</div>
          </div>
        </div>

        <div className="oak-folio-print-meta">
          <span>
            {(data.folio_label || (data.is_derived_reference ? 'No. Referensi Folio (Turunan)' : 'No. Folio'))}: {data.folio_number}
          </span>
          <span>•</span>
          <span>
            Dicetak pada: {data.print_metadata.printed_at_local} ({data.property.timezone})
          </span>
        </div>
      </div>
    </OakLetterhead>
  );
}

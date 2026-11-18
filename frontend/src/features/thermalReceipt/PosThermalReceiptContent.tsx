import type { ThermalWidth } from './thermalReceiptTypes';
import type { PosReceiptData } from '../pos/posReceiptTypes';
import { formatPosOrderDisplayRef } from '../pos/posFormatUtils';
import { getLogoServeUrl } from '../propertySettings/propertyBrandingApi';
import {
  formatHotelDateTimeIndonesian,
  formatHotelCurrency,
} from './thermalReceiptFormatters';

interface PosThermalReceiptContentProps {
  receipt: PosReceiptData;
  width: ThermalWidth;
  printedBy: string;
  printedAt: string;
}

export default function PosThermalReceiptContent({
  receipt,
  width,
  printedBy,
  printedAt,
}: PosThermalReceiptContentProps) {
  const { property, order, items, settlement, sale } = receipt;
  const b = property.branding;

  const hotelName = b?.display_name || property.name;
  const tagline = b?.tagline || null;
  // Resolve managed branding storage key to the backend serve endpoint.
  // - Managed key ("branding/..."): MUST go through getLogoServeUrl.
  //   If the resolver returns null (malformed, property scope mismatch,
  //   invalid key), the final result is null — the raw storage key is
  //   NEVER used as an <img src> (it would hit the SPA fallback).
  // - Legacy/non-managed URL (does not start with "branding/"): the raw
  //   value is kept as a compatibility fallback.
  const logoUrl = (() => {
    const raw = b?.logo_url || null;
    if (!raw) return null;
    if (raw.startsWith('branding/')) {
      return getLogoServeUrl(raw, property.id);
    }
    return raw;
  })();
  const address = property.address;
  const phone = property.phone;

  // Transaction date: use sale.created_at, fallback to settlement/order
  const txDate =
    sale.created_at || settlement.created_at || order.created_at || null;

  // ── Item computations ────────────────────────────────���─────────────────
  const itemRows = items.map((item) => {
    const qty = safeQty(item.quantity);
    const unitPrice = safeNum(item.unit_price);
    const gross = qty * unitPrice;
    const discount = safeNum(item.discount_amount);
    const net = gross - discount;
    return { ...item, qty, unitPrice, gross, discount, net };
  });

  const totalGross = itemRows.reduce(
    (sum, r) => sum + r.gross,
    0,
  );
  const totalItemDiscount = itemRows.reduce(
    (sum, r) => sum + r.discount,
    0,
  );

  const orderDiscount = safeNum(order.discount_amount);
  const grandTotal = safeNum(order.total_amount);

  // B4.1 — service charge & tax amounts (canonical whole-rupiah strings from backend).
  // Displayed as separate line items when > 0; omitted otherwise.
  const serviceCharge = safeNum(order.service_amount);
  const taxAmount = safeNum(order.tax_amount);

  // CASH vs non-CASH sections
  const isCash = settlement.payment_method === 'CASH';

  return (
    <div className={`thermal-receipt thermal-receipt--${width}`}>
      {/* 1. HEADER */}
      <div className="thermal-header">
        {logoUrl && <img src={logoUrl} alt="Logo" className="thermal-logo" />}
        <div className="thermal-hotel-name">{hotelName}</div>
        {tagline && (
          <div className="thermal-hotel-tagline">{tagline}</div>
        )}
        {address && (
          <div className="thermal-hotel-address">{address}</div>
        )}
        {phone && (
          <div className="thermal-hotel-phone">Telp: {phone}</div>
        )}
      </div>

      <div className="thermal-divider" />

      {/* 2. JUDUL */}
      <div className="thermal-title">STRUK POS</div>

      {/* 3. IDENTITAS TRANSAKSI */}
      <div className="thermal-section">
        <Row label="No. Order" value={order.id ? formatPosOrderDisplayRef(order.id) : order.order_number} mono />
        <Row label="No. Transaksi" value={sale.transaction_no} mono />
        {txDate && <Row label="Tanggal" value={formatHotelDateTimeIndonesian(txDate)} />}
        {order.guest_name && <Row label="Tamu" value={order.guest_name} />}
        {order.table_number && <Row label="Meja" value={order.table_number} />}
        {order.notes && <Row label="Catatan" value={order.notes} />}
      </div>

      <div className="thermal-divider" />

      {/* 4. ITEM */}
      <div className="thermal-section">
        {itemRows.map((r, i) => (
          <div key={i} className="thermal-item">
            {/* Baris 1: Nama Produk */}
            <div className="thermal-item-name">
              {r.item_name_snapshot}
            </div>
            {/* Baris 2: Qty x Harga Satuan di kiri, Subtotal di kanan */}
            <div className="thermal-row thermal-row--mono">
              <span className="thermal-item-qty">
                {r.qty} x {formatHotelCurrency(r.unitPrice)}
              </span>
              <span className="thermal-value">
                {formatHotelCurrency(r.gross)}
              </span>
            </div>
            {/* Item notes */}
            {r.notes && (
              <div className="thermal-item-note">Catatan: {r.notes}</div>
            )}
            {/* Item discount */}
            {r.discount > 0 && (
              <Row
                label="  Diskon Item"
                value={`- ${formatHotelCurrency(r.discount)}`}
                mono
              />
            )}
            {/* Item net */}
            {r.discount > 0 && (
              <Row
                label="  Nett"
                value={formatHotelCurrency(r.net)}
                mono
              />
            )}
          </div>
        ))}
      </div>

      <div className="thermal-divider" />

      {/* 5. RINGKASAN */}
      <div className="thermal-section">
        <Row label="Subtotal" value={formatHotelCurrency(totalGross)} mono />
        {totalItemDiscount > 0 && (
          <Row label="Diskon Item" value={`- ${formatHotelCurrency(totalItemDiscount)}`} mono />
        )}
        {order.discount_amount && orderDiscount > 0 && (
          <>
            <Row label="Diskon Pesanan" value={`- ${formatHotelCurrency(orderDiscount)}`} mono />
            {order.discount_reason && (
              <Row label="Alasan" value={order.discount_reason} />
            )}
          </>
        )}
        {/* B4.1 — Service charge & PBJT lines (shown only when amount > 0).
            Persentase tampil di label kiri; nominal rata kanan. */}
        {serviceCharge > 0 && (
          <Row
            label={`Service Charge${
              order.service_charge_percent_snapshot != null && Number(order.service_charge_percent_snapshot) > 0
                ? ` (${order.service_charge_percent_snapshot}%)`
                : ''
            }`}
            value={formatHotelCurrency(serviceCharge)}
            mono
          />
        )}
        {taxAmount > 0 && (
          <Row
            label={`PBJT${
              order.tax_percent_snapshot != null && Number(order.tax_percent_snapshot) > 0
                ? ` (${order.tax_percent_snapshot}%)`
                : ''
            }`}
            value={formatHotelCurrency(taxAmount)}
            mono
          />
        )}
        <div className="thermal-row thermal-row--total">
          <span className="thermal-label">Total</span>
          <span className="thermal-value thermal-value--total">
            {formatHotelCurrency(grandTotal)}
          </span>
        </div>
      </div>

      <div className="thermal-divider" />

      {/* 6. PEMBAYARAN */}
      <div className="thermal-section">
        <Row label="Metode" value={settlement.payment_method === 'COMPLIMENTARY' ? 'COMPLIMENTARY (FREE)' : settlement.payment_method} bold />

        {settlement.payment_method === 'COMPLIMENTARY' ? (
          <>
            <Row label="Total Tagihan" value={formatHotelCurrency(settlement.amount)} mono />
            <Row label="Potongan Komplimen" value={`- ${formatHotelCurrency(settlement.amount)}`} mono />
            <Row label="Total Bayar" value="Rp 0" bold mono />
            {settlement.payment_reference && (
              <Row label="Keterangan" value={settlement.payment_reference} />
            )}
            {settlement.verified_by && (
              <Row label="Otorisator" value={settlement.verified_by} />
            )}
            {settlement.verified_at && (
              <Row label="Waktu Otorisasi" value={formatHotelDateTimeIndonesian(settlement.verified_at)} />
            )}
          </>
        ) : isCash ? (
          <>
            <Row label="Nominal" value={formatHotelCurrency(settlement.amount)} bold mono />
            {settlement.cash_received && (
              <Row label="Uang Diterima" value={formatHotelCurrency(settlement.cash_received)} mono />
            )}
            {settlement.change_due && (
              <Row label="Kembalian" value={formatHotelCurrency(settlement.change_due)} mono />
            )}
          </>
        ) : (
          <>
            <Row label="Nominal" value={formatHotelCurrency(settlement.amount)} bold mono />
            {settlement.payment_reference && (
              <Row label="Referensi" value={settlement.payment_reference} mono />
            )}
            {settlement.verified_by && (
              <Row label="Diverifikasi" value={settlement.verified_by} />
            )}
            {settlement.verified_at && (
              <Row label="Waktu Verif" value={formatHotelDateTimeIndonesian(settlement.verified_at)} />
            )}
          </>
        )}
      </div>

      {/* Status badge */}
      <div className="thermal-status">
        {settlement.payment_method === 'COMPLIMENTARY' ? 'COMPLIMENTARY' : 'PAID'}
      </div>

      {/* 7. FOOTER */}
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

/* ── Internal helpers ────────────────────────────────────────────────── */

function safeNum(value: string | null | undefined): number {
  if (value == null || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function safeQty(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function Row({
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
    <div
      className={`thermal-row${mono ? ' thermal-row--mono' : ''}${bold ? ' thermal-row--bold' : ''}`}
    >
      <span className="thermal-label">{label}</span>
      <span className="thermal-value">{value}</span>
    </div>
  );
}

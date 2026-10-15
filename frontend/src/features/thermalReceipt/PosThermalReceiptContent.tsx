import type { ThermalWidth } from './thermalReceiptTypes';
import type { PosReceiptData } from '../pos/posReceiptTypes';
import {
  formatHotelDateTimeIndonesian,
  formatHotelCurrency,
} from './thermalReceiptFormatters';
import {
  resolveReceiptLogoUrl,
  formatPosReceiptOrderReference,
  normalizeOptionalGuestName,
  normalizeOptionalTableNumber,
} from './posReceiptPresentation';

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
  // Resolve the managed branding logo key into a browser-servable URL.
  // null when there is no logo → no <img>, no broken image, no placeholder.
  const logoUrl = resolveReceiptLogoUrl(property.branding, property.id);
  const address = property.address;
  const phone = property.phone;

  // Compact display reference (POS-YYMMDD-<id>) — canonical order_number is
  // NOT mutated; this is presentation-only for the thermal receipt.
  const orderRef = formatPosReceiptOrderReference(
    order,
    sale.created_at,
    settlement.created_at,
  );

  // Optional identity rows: hidden when there is no real value.
  const guestName = normalizeOptionalGuestName(order.guest_name);
  const tableNumber = normalizeOptionalTableNumber(order.table_number);

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
        <Row label="No. Order" value={orderRef} mono />
        <Row label="No. Transaksi" value={sale.transaction_no} mono />
        {txDate && <Row label="Tanggal" value={formatHotelDateTimeIndonesian(txDate)} />}
        {guestName && <Row label="Tamu" value={guestName} />}
        {tableNumber && <Row label="Meja" value={tableNumber} />}
        {order.notes && <Row label="Catatan" value={order.notes} />}
      </div>

      <div className="thermal-divider" />

      {/* 4. ITEM */}
      <div className="thermal-section">
        {itemRows.map((r, i) => (
          <div key={i}>
            {/* Item line */}
            <Row
              label={r.item_code_snapshot ? `[${r.item_code_snapshot}] ${r.item_name_snapshot}` : r.item_name_snapshot}
              value={`${r.qty} x ${formatHotelCurrency(r.unitPrice)}`}
              mono
            />
            {/* Item notes */}
            {r.notes && (
              <Row label="" value={r.notes} />
            )}
            {/* Item discount */}
            {r.discount > 0 && (
              <Row
                label=" Diskon Item"
                value={`- ${formatHotelCurrency(r.discount)}`}
                mono
              />
            )}
            {/* Item net */}
            {(r.discount > 0) && (
              <Row
                label=" Nett"
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
        <Row label="Metode" value={settlement.payment_method} />
        <Row label="Nominal" value={formatHotelCurrency(settlement.amount)} bold mono />

        {isCash ? (
          <>
            {settlement.cash_received && (
              <Row label="Uang Diterima" value={formatHotelCurrency(settlement.cash_received)} mono />
            )}
            {settlement.change_due && (
              <Row label="Kembalian" value={formatHotelCurrency(settlement.change_due)} mono />
            )}
          </>
        ) : (
          <>
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
      <div className="thermal-status">PAID</div>

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

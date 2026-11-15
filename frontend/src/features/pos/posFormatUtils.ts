/**
 * posFormatUtils.ts
 *
 * Canonical display formatters for POS orders on frontend.
 *
 * OAK HIMS Rule:
 * - Order display reference formats integer pos_orders.id padded to at least 6 digits:
 *   e.g. ID 112 -> "POS-000112".
 * - Never truncates digits if ID exceeds 999999 (e.g. ID 1234567 -> "POS-1234567").
 * - Never uses folio_entries.id as POS order number.
 * - Used consistently across POS order panels, receipts, Guest Bill, and Guest Folio.
 */

export function formatPosOrderDisplayRef(orderId: number | string | null | undefined): string {
  if (orderId === null || orderId === undefined || orderId === '') return '';
  const num = typeof orderId === 'number' ? orderId : parseInt(String(orderId).trim(), 10);
  if (!Number.isFinite(num) || num <= 0) {
    const raw = String(orderId).trim();
    if (/^POS-\d+$/i.test(raw)) {
      const parsed = parseInt(raw.slice(4), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        const s = String(parsed);
        return `POS-${s.length < 6 ? s.padStart(6, '0') : s}`;
      }
    }
    return raw;
  }
  const str = String(num);
  const padded = str.length < 6 ? str.padStart(6, '0') : str;
  return `POS-${padded}`;
}

export function parsePosOrderIdFromDisplayRef(ref: string | null | undefined): number | null {
  if (!ref) return null;
  const clean = ref.trim().toUpperCase();
  const match = clean.match(/^POS-(\d+)$/);
  if (match && match[1]) {
    const parsed = parseInt(match[1], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

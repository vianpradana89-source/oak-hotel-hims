/**
 * Deterministic PURCHASE header summary.
 * Category is classification; line items are the goods; this string is display-only.
 */
export function generatePurchaseDescription(params: {
  lineDescriptions: Array<string | null | undefined>;
  supplierName?: string | null;
}): string {
  const lines = params.lineDescriptions
    .map((value) => String(value || '').trim())
    .filter((value) => value.length > 0);
  const firstItem = lines[0] || '';
  const extraCount = Math.max(0, lines.length - 1);
  const extra = extraCount > 0 ? ` + ${extraCount} item lainnya` : '';
  const supplier = String(params.supplierName || '').trim();

  if (!firstItem) {
    return supplier ? `Pembelian — ${supplier}` : 'Pembelian';
  }
  if (supplier) {
    return `Pembelian ${firstItem}${extra} — ${supplier}`;
  }
  return `Pembelian ${firstItem}${extra}`;
}

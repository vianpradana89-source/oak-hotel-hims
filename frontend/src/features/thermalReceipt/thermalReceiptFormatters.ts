/**
 * Thermal Receipt — Shared Formatters
 *
 * Inline helpers so we don't depend on GuestDocumentContent exports
 * (keeps thermal module fully self-contained).
 */

/** Indonesian date: "15 September 2026" */
export function formatHotelDateIndonesian(dateStr: string): string {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
  } catch {
    return dateStr;
  }
}

/** Indonesian datetime: "15 Sep 2026, 14:30" */
export function formatHotelDateTimeIndonesian(dateStr: string): string {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleString('id-ID', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Jakarta',
    });
  } catch {
    return dateStr;
  }
}

/** Indonesian Rupiah, no decimal */
export function formatHotelCurrency(value: number | string | null | undefined): string {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num)) return 'Rp 0';
  try {
    return new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: 'IDR',
      maximumFractionDigits: 0,
    }).format(num);
  } catch {
    return `Rp ${Math.round(num).toLocaleString('id-ID')}`;
  }
}

/** Short payment method label */
export function formatPaymentMethod(method: string): string {
  const map: Record<string, string> = {
    CASH: 'Tunai',
    TRANSFER: 'Transfer',
    QRIS: 'QRIS',
    DEBIT_CARD: 'Kartu Debit',
    CREDIT_CARD: 'Kartu Kredit',
  };
  return map[method] ?? method;
}

/** Short identity status label */
export function formatIdentityStatus(status: string): string {
  const map: Record<string, string> = {
    HELD: 'Ditahan',
    RETURNED: 'Dikembalikan',
  };
  return map[status] ?? status;
}

/** Short deposit status label */
export function formatDepositStatus(status: string): string {
  const map: Record<string, string> = {
    RECEIVED: 'Diterima',
    PARTIALLY_USED: 'Sebagian Dipakai',
    CLOSED: 'Ditutup',
    CANCELLED: 'Dibatalkan',
  };
  return map[status] ?? status;
}

/** Payment status badge text */
export function formatPaymentStatus(status: string): string {
  const map: Record<string, string> = {
    UNPAID: 'Belum Lunas',
    PARTIAL: 'Sebagian Lunas',
    PAID: 'Lunas',
  };
  return map[status] ?? status;
}

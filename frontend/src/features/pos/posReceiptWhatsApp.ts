/**
 * POS Receipt WhatsApp Helper
 *
 * Membangun pesan WhatsApp dan deep link dari data receipt authoritative
 * (PosReceiptData yang sudah tervalidasi oleh fetchPosReceipt).
 *
 * Prinsip:
 * - Nomor telepon HANYA berasal dari receipt.order.guest_phone (snapshot)
 * - Tidak ada fetch, tidak ada mutation, tidak ada window.open
 * - Tidak membuka WhatsApp/browser secara otomatis
 * - Helper ini murni dan bisa diuji
 */

import type { PosReceiptData } from './posReceiptTypes';

/**
 * Opsi opsional untuk `buildPosReceiptWhatsAppMessage`.
 *
 * - `intro`:   custom intro message (diambil dari `whatsapp_intro_message` di
 *             `property_pos_communication_settings`). Bila ada, tampil SEBELUM
 *             nama hotel sebagai baris tambahan. Tidak menggantikan nama hotel
 *             atau informasi authoritative lain.
 * - `closing`: custom closing message (diambil dari `whatsapp_closing_message`
 *             di `property_pos_communication_settings`). Bila ada, tampil
 *             SETELAH info pembayaran dan SEBELUM hardcoded closing existing.
 *             Tidak menggantikan hardcoded closing existing.
 */
export interface PosWhatsAppMessageOptions {
  intro?: string | null;
  closing?: string | null;
}

/**
 * Normalisasi nomor telepon Indonesia untuk format WhatsApp.
 *
 * Aturan:
 * - Trim whitespace
 * - Hapus karakter selain digit dan leading +
 * - Nomor kosong → null
 * - +62xxxxxxxx → 62xxxxxxxx
 * - 62xxxxxxxx → tetap
 * - 08xxxxxxxx → ubah menjadi 628xxxxxxxx
 * - Selain pola masuk akal → null
 * - Jangan mengarang nomor default
 */
export function normalizeWhatsAppPhone(
  phone: string | null | undefined
): string | null {
  if (!phone || typeof phone !== 'string') return null;

  const trimmed = phone.trim();
  if (!trimmed) return null;

  // Hapus SEMUA karakter non-digit (termasuk +, spasi, strip, dll)
  // Ini menangani: +62-8123.456789, 0812 3456 7890, dll
  const digitsOnly = trimmed.replace(/\D/g, '');

  // Validasi: harus ada digit
  if (!digitsOnly) return null;

  // Cek prefix
  let cleaned: string;

  if (digitsOnly.startsWith('08')) {
    // 08xxxxxxxx → 628xxxxxxxx
    cleaned = '62' + digitsOnly.slice(1);
  } else if (digitsOnly.startsWith('62')) {
    // 62xxxxxxxx → tetap
    cleaned = digitsOnly;
  } else {
    // Pola tidak masuk akal
    return null;
  }

  // Validasi panjang: 62 + 8-13 digit = 10-15 digit total
  // Contoh: 628123456789 (12 digit), 6281234567890 (13 digit)
  if (cleaned.length < 10 || cleaned.length > 15) {
    return null;
  }

  return cleaned;
}

/**
 * Parse strict: hanya menerima string murni digit penuh (^\d+$).
 * Menolak: whitespace, decimal, huruf, exponent, tanda +/-, karakter apa pun
 * selain digit. Mengembalikan 0 bila gagal — TIDAK pernah menghasilkan NaN
 * atau nilai parsial (mis. "10000abc" → 0, bukan 10000).
 */
function parseRupiahStringStrict(raw: string | null | undefined): number {
  if (typeof raw !== 'string') return 0;
  if (!/^\d+$/.test(raw)) return 0;
  // TIDAK boleh ada leading-zero panjang yang mengubah magnitudo — regex ^\d+$
  // sudah menolak whitespace/+/-. Nilai panjang > 15 digit (beyond
  // Number.MAX_SAFE_INTEGER) juga harus ditolak:
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

/**
 * Format angka Rupiah dari string ke format tampilan (tanpa pecahan).
 * Hanya menampilkan jumlah bila string valid (^\d+$, safe integer, >= 0);
 * selain itu "Rp 0". Tidak menghasilkan NaN di output.
 */
function formatRupiah(amount: string | null | undefined): string {
  const value = parseRupiahStringStrict(amount);
  return `Rp ${value.toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;
}

/**
 * Apakah nilai string merepresentasikan jumlah Rupiah yang > 0?
 * Strict: string penuh digit, safe integer, > 0.
 */
function isPositiveAmount(amount: string | null | undefined): boolean {
  return parseRupiahStringStrict(amount) > 0;
}

/**
 * Bangun pesan WhatsApp dari data receipt authoritative.
 *
 * Format:
 * - [intro custom — opsional, additive]
 * - Nama hotel/property
 * - No. Order & No. Transaksi
 * - Daftar item (quantity x harga)
 * - Diskon (item/penawaran) bila ada
 * - Total
 * - Metode pembayaran
 * - Info CASH: uang diterima + kembalian
 * - Non-CASH: referensi pembayaran
 * - [closing custom — opsional, additive]
 * - Ucapan terima kasih
 */
export function buildPosReceiptWhatsAppMessage(
  receipt: PosReceiptData,
  options?: PosWhatsAppMessageOptions,
): string {
  const { property, order, items, settlement, sale } = receipt;

  // Nama hotel
  const hotelName =
    property.branding?.display_name || property.name || '';

  const lines: string[] = [];

  // Intro custom (additive — tidak menggantikan header hotel)
  const intro = options?.intro?.trim();
  if (intro) {
    lines.push(intro);
    lines.push('');
  }

  // Header
  lines.push(`*${hotelName}*`);
  lines.push('');
  lines.push(`No. Order: ${order.order_number}`);
  lines.push(`No. Transaksi: ${sale.transaction_no}`);
  lines.push('');

  // Item list
  lines.push('*Detail Pesanan:*');
  for (const item of items) {
    // Line total per item = quantity × unit_price − item discount_amount
    // Quantity: number (bukan string) — validasi defensif, fallback 0
    const qty =
      Number.isInteger(item.quantity) && item.quantity >= 0
        ? item.quantity
        : 0;
    const validUnit = parseRupiahStringStrict(item.unit_price);
    const validItemDisc = parseRupiahStringStrict(item.discount_amount);
    const lineTotal = validUnit * qty - validItemDisc;
    const safeLineTotal = lineTotal > 0 ? lineTotal : 0;

    const discountSuffix =
      validItemDisc > 0
        ? ` (diskon ${formatRupiah(item.discount_amount)})`
        : '';

    lines.push(
      `${qty}x ${item.item_name_snapshot} = ${formatRupiah(
        String(safeLineTotal)
      )}${discountSuffix}`
    );
  }
  lines.push('');

  // Diskon pesanan
  if (isPositiveAmount(order.discount_amount)) {
    lines.push(
      `Diskon: ${formatRupiah(order.discount_amount)}${
        order.discount_reason ? ` (${order.discount_reason})` : ''
      }`
    );
    lines.push('');
  }

  // Total
  lines.push(`*Total: ${formatRupiah(order.total_amount)}*`);
  lines.push('');

  // Pembayaran
  lines.push('Pembayaran:');
  lines.push(`Metode: ${settlement.payment_method}`);

  if (settlement.payment_method === 'CASH') {
    if (isPositiveAmount(settlement.cash_received)) {
      lines.push(`Uang Diterima: ${formatRupiah(settlement.cash_received)}`);
    }
    if (isPositiveAmount(settlement.change_due)) {
      lines.push(`Kembalian: ${formatRupiah(settlement.change_due)}`);
    }
  } else {
    if (settlement.payment_reference) {
      lines.push(`Referensi: ${settlement.payment_reference}`);
    }
  }

  lines.push('');

  // Closing custom (additive — tidak menggantikan hardcoded closing)
  const customClosing = options?.closing?.trim();
  if (customClosing) {
    lines.push(customClosing);
    lines.push('');
  }

  lines.push('Terima kasih telah berbelanja di ' + hotelName + '!');
  lines.push('Semoga berkenan. Sampai jumpa.');

  return lines.join('\n');
}

/**
 * Bangun URL deep link WhatsApp dari data receipt.
 *
 * Aturan:
 * - Nomor HANYA dari receipt.order.guest_phone
 * - Normalize dengan normalizeWhatsAppPhone
 * - Jika tidak valid/null → return null
 * - Message dari buildPosReceiptWhatsAppMessage(receipt, options)
 * - Format: https://wa.me/<normalized>?text=<encodeURIComponent(message)>
 *
 * `options` (opsional): intro/closing custom dari communication settings.
 * Caller lama yang tidak memberi options tetap bekerja (default undefined).
 *
 * Tidak menerima phone sebagai parameter agar caller tidak bisa
 * memakai nomor draft secara tidak sengaja.
 */
export function buildPosReceiptWhatsAppUrl(
  receipt: PosReceiptData,
  options?: PosWhatsAppMessageOptions,
): string | null {
  const phone = receipt.order.guest_phone;
  const normalized = normalizeWhatsAppPhone(phone);

  if (!normalized) {
    return null;
  }

  const message = buildPosReceiptWhatsAppMessage(receipt, options);
  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
}

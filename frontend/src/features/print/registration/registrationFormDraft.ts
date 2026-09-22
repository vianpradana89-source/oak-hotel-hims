/**
 * Form Registrasi - Draft & Constants
 *
 * Default Terms & Conditions (Bahasa Indonesia) untuk Form Registrasi A4.
 * Terms ini bersifat editable per-session; tidak disimpan ke database.
 */

export const REGISTRATION_FORM_DEFAULT_TERMS = [
  'Tamu wajib menunjukkan identitas resmi yang masih berlaku (KTP / SIM / Paspor) pada saat check-in.',
  'Waktu check-in mulai pukul 14.00 WIB dan check-out paling lambat pukul 12.00 WIB, kecuali terdapat kesepakatan lain dengan hotel.',
  'Deposit digunakan sebagai jaminan atas tagihan tambahan, kerusakan, atau kehilangan selama masa menginap.',
  'Hotel dapat memperhitungkan biaya kerusakan, kehilangan, atau tagihan tambahan terhadap deposit sesuai kondisi aktual.',
  'Sisa deposit dikembalikan setelah proses check-out dan pemeriksaan kamar selesai, sesuai metode dan prosedur hotel.',
  'Tamu bertanggung jawab menggunakan kamar dan fasilitas hotel dengan baik selama masa menginap.',
  'Tamu bertanggung jawab menjaga barang pribadi dan barang berharga selama berada di hotel.',
  'Tamu wajib mematuhi ketentuan keamanan, ketertiban, kebijakan merokok, serta ketentuan jumlah tamu yang berlaku di hotel.',
  'Perubahan tanggal, pembatalan, no-show, dan refund mengikuti kebijakan reservasi atau rate plan yang berlaku pada reservasi tersebut.',
  'Dengan menandatangani formulir ini, tamu menyatakan bahwa data yang diberikan benar dan menyetujui ketentuan yang tercantum.',
].join('\n');

/**
 * Mask identity number for safe frontend rendering.
 * Shows last 4 characters, replaces rest with asterisks.
 * Format: **** **** **** 1234 (fixed format)
 *
 * SECURITY: Never returns raw identity value.
 * - Raw input: always masked
 * - Already-masked input: normalized to same format
 */
export function maskIdentityNumber(value: string | null | undefined): string {
  if (!value || value.trim().length === 0) return '—';

  const trimmed = value.trim();

  // Detect if already masked by looking for masking markers
  const hasAsterisk = trimmed.includes('*');
  const hasBullet = trimmed.includes('•');
  // X/x only counts as masking if there are at least 4 consecutive X chars (after removing spaces)
  const stripped = trimmed.replace(/\s+/g, '');
  const hasXMask = /[Xx]{4,}/.test(stripped);

  const isAlreadyMasked = hasAsterisk || hasBullet || hasXMask;

  if (isAlreadyMasked) {
    // Extract trailing 4 visible characters (digits or alphanumerics)
    const match = trimmed.match(/([A-Za-z0-9]{4})$/);
    if (match) {
      return '**** **** **** ' + match[1];
    }
    // Cannot safely extract trailing chars → return safe placeholder
    return '****';
  }

  // ALL other inputs are treated as RAW — never return raw value
  if (trimmed.length <= 4) return '****';

  const last4 = trimmed.slice(-4);
  return '**** **** **** ' + last4;
}

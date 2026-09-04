/**
 * Normalizes Indonesian phone numbers into standard international format (628...).
 * Handles:
 * - 081234567890 -> 6281234567890
 * - +6281234567890 -> 6281234567890
 * - 6281234567890 -> 6281234567890
 * - Handles spaces, dashes, dots, and parentheses safely.
 * Returns null if the phone is empty or invalid.
 */
export function normalizeIndonesianPhoneNumber(phone: string | null | undefined): string | null {
  if (!phone || typeof phone !== 'string') return null;
  const trimmed = phone.trim();
  if (!trimmed) return null;

  // Remove common separators
  let cleaned = trimmed.replace(/[\s\-\.\(\)]/g, '');

  // Strip leading plus
  if (cleaned.startsWith('+')) {
    cleaned = cleaned.slice(1);
  }

  // If starts with 08, convert to 628
  if (cleaned.startsWith('08')) {
    cleaned = '62' + cleaned.slice(1);
  } else if (cleaned.startsWith('8')) {
    cleaned = '62' + cleaned;
  }

  // Indonesian mobile numbers start with 628 and have 10-15 total digits
  if (/^628\d{8,12}$/.test(cleaned)) {
    return cleaned;
  }

  return null;
}

export function formatExpiryDateTime(isoString?: string | null): string {
  if (!isoString) return '7 hari ke depan';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '7 hari ke depan';
    return d.toLocaleDateString('id-ID', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }) + ' WIB';
  } catch {
    return '7 hari ke depan';
  }
}

export function getCanonicalLoginUrl(): string {
  if (typeof window !== 'undefined' && window.location) {
    const origin = window.location.origin;
    if (origin && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
      return origin;
    }
  }
  return 'https://hims.oaklawang.com';
}

export interface WhatsAppMessageParams {
  employeeName: string;
  email: string;
  username: string;
  temporaryPassword: string;
  expiryStr: string;
  loginUrl?: string;
  isReset?: boolean;
}

export function buildWhatsAppCredentialMessage(params: WhatsAppMessageParams): string {
  const { employeeName, email, username, temporaryPassword, expiryStr, loginUrl, isReset } = params;
  const actionText = isReset
    ? 'Password akun OAK HIMS Anda telah direset.'
    : 'Akun OAK HIMS Anda sudah dibuat.';

  const loginSection = loginUrl ? `\nLogin:\n${loginUrl}\n` : '';

  return `Halo ${employeeName},

${actionText}

Email: ${email}
Username: ${username}
Password sementara: ${temporaryPassword}
Berlaku sampai: ${expiryStr}
${loginSection}
Silakan login ke OAK HIMS menggunakan kredensial di atas.

Pada login pertama Anda wajib:
1. Membuat password pribadi baru.
2. Melanjutkan proses pendaftaran wajah.

Jangan membagikan password sementara ini kepada orang lain.

Pesan ini dibuat oleh OAK HIMS HRD.`;
}

export function buildWhatsAppDeepLink(phone: string, message: string): string {
  const norm = normalizeIndonesianPhoneNumber(phone);
  if (!norm) {
    throw new Error('Nomor WhatsApp karyawan belum tersedia atau tidak valid.');
  }
  return `https://wa.me/${norm}?text=${encodeURIComponent(message)}`;
}

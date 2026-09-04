import { PoolClient } from 'pg';

/**
 * Normalizes Indonesian phone numbers into standard international format (628...).
 * Supports:
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

/**
 * Masks phone number for privacy-safe audit logging.
 * e.g. 6281234567890 -> 62812****7890
 */
export function maskPhoneNumber(phone: string | null | undefined): string {
  if (!phone) return 'EMPTY';
  const clean = phone.replace(/[\s\-\.\(\)]/g, '');
  if (clean.length <= 6) return clean.replace(/./g, '*');
  const start = clean.slice(0, 5);
  const end = clean.slice(-4);
  return `${start}****${end}`;
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

/**
 * Builds the canonical onboarding/reset WhatsApp message according to OAK HIMS template.
 */
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

/**
 * Generates a WhatsApp click-to-chat deep link.
 * Does NOT mutate the employee phone in DB.
 */
export function buildWhatsAppDeepLink(phone: string, message: string): string {
  const norm = normalizeIndonesianPhoneNumber(phone);
  if (!norm) {
    throw new Error('Nomor WhatsApp karyawan belum tersedia atau tidak valid.');
  }
  return `https://wa.me/${norm}?text=${encodeURIComponent(message)}`;
}

/**
 * Safely audits that HR opened the WhatsApp click-to-chat action.
 * CRITICAL SECURITY INVARIANT:
 * - Never log plaintext temporary password
 * - Never log full message body
 * - Never log password hash
 * - Audit action is WHATSAPP_CREDENTIAL_OPENED (does NOT claim delivered/sent)
 */
export async function auditWhatsAppCredentialOpened(
  client: PoolClient,
  propertyId: number,
  employeeId: number,
  phone: string | null | undefined,
  actor?: { id?: number; name?: string; role?: string }
): Promise<void> {
  const maskedPhone = maskPhoneNumber(phone);

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'HRD',
      'WHATSAPP_CREDENTIAL_OPENED',
      'USER_AUTH',
      String(employeeId),
      JSON.stringify({
        employee_id: employeeId,
        actor_user_id: actor?.id || null,
        target_phone_masked: maskedPhone,
        timestamp: new Date().toISOString()
      }),
      actor?.name || 'HRD',
      propertyId
    ]
  );
}

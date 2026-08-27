import {
  EVIDENCE_TYPE_OPTIONS,
  type EvidenceStatusBadgeInfo,
  type PaymentEvidenceItem
} from './paymentEvidenceTypes.ts';

export const ALLOWED_EVIDENCE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf'
] as const;

export const MAX_EVIDENCE_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export function validateEvidenceFile(file: { type: string; size: number } | null | undefined): {
  valid: boolean;
  error?: string;
  code?: string;
} {
  if (!file) {
    return { valid: false, error: 'File bukti pembayaran wajib dipilih', code: 'FILE_REQUIRED' };
  }

  const mime = String(file.type || '').toLowerCase();
  const isAllowed = ALLOWED_EVIDENCE_MIME_TYPES.some(t => t === mime);
  if (!isAllowed) {
    return {
      valid: false,
      error: 'Format file tidak didukung. Harap unggah format JPG, PNG, WEBP, atau PDF.',
      code: 'UNSUPPORTED_MIME_TYPE'
    };
  }

  if (file.size <= 0) {
    return {
      valid: false,
      error: 'File yang dipilih kosong (0 byte).',
      code: 'EMPTY_FILE'
    };
  }

  if (file.size > MAX_EVIDENCE_FILE_SIZE_BYTES) {
    const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
    return {
      valid: false,
      error: `Ukuran file melebihi batas maksimal 10 MB (ukuran: ${sizeMb} MB).`,
      code: 'FILE_TOO_LARGE'
    };
  }

  return { valid: true };
}

export function formatEvidenceType(type?: string | null): string {
  if (!type) return '-';
  const found = EVIDENCE_TYPE_OPTIONS.find(opt => opt.type === type);
  return found ? found.label : type;
}

export function formatEvidenceFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || isNaN(Number(bytes)) || bytes < 0) {
    return '0 B';
  }
  const n = Number(bytes);
  if (n === 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function isEvidenceImage(mimeType?: string | null): boolean {
  if (!mimeType) return false;
  const m = mimeType.toLowerCase();
  return m === 'image/jpeg' || m === 'image/png' || m === 'image/webp';
}

export function isEvidencePdf(mimeType?: string | null): boolean {
  if (!mimeType) return false;
  return mimeType.toLowerCase() === 'application/pdf';
}

export function getActiveEvidences(
  evidences?: PaymentEvidenceItem[] | null,
  paymentId?: number | null
): PaymentEvidenceItem[] {
  if (!Array.isArray(evidences)) return [];
  return evidences.filter(e => {
    const matchPay = paymentId !== undefined && paymentId !== null ? Number(e.payment_transaction_id) === Number(paymentId) : true;
    return matchPay && e.is_active === true;
  });
}

export function getInactiveEvidences(
  evidences?: PaymentEvidenceItem[] | null,
  paymentId?: number | null
): PaymentEvidenceItem[] {
  if (!Array.isArray(evidences)) return [];
  return evidences.filter(e => {
    const matchPay = paymentId !== undefined && paymentId !== null ? Number(e.payment_transaction_id) === Number(paymentId) : true;
    return matchPay && e.is_active === false;
  });
}

export function getPaymentEvidenceStatus(
  evidences?: PaymentEvidenceItem[] | null,
  paymentId?: number | null
): EvidenceStatusBadgeInfo {
  const active = getActiveEvidences(evidences, paymentId);
  const count = active.length;

  if (count > 0) {
    return {
      status: 'ATTACHED',
      label: `${count} Bukti`,
      count,
      badgeClass: 'bg-emerald-50 text-emerald-800 border-emerald-300'
    };
  }

  return {
    status: 'MISSING',
    label: 'Belum ada bukti',
    count: 0,
    badgeClass: 'bg-amber-50 text-amber-800 border-amber-300'
  };
}

export function formatEvidenceDate(dateStr?: string | null): string {
  if (!dateStr) return '-';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(d);
  } catch {
    return dateStr;
  }
}

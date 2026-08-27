export interface PaymentTransactionItem {
  id: number;
  reservation_id: number;
  transaction_type: string;
  amount: number | string;
  payment_method?: string;
  reference_code?: string;
  status: string;
  reference_payment_id?: number | null;
  correction_group_id?: string | null;
  reason_code?: string | null;
  reason_text?: string | null;
  created_by?: string | null;
  created_at?: string;
}

export type PaymentCorrectionReasonCode =
  | 'WRONG_AMOUNT'
  | 'WRONG_PAYMENT_METHOD'
  | 'DUPLICATE_ENTRY'
  | 'PAYMENT_CANCELLED'
  | 'OTHER';

export interface ReasonOption {
  code: PaymentCorrectionReasonCode;
  label: string;
  description: string;
}

export const PAYMENT_CORRECTION_REASONS: ReasonOption[] = [
  { code: 'WRONG_AMOUNT', label: 'Salah input nominal', description: 'Nominal yang dicatat berbeda dengan pembayaran aktual' },
  { code: 'WRONG_PAYMENT_METHOD', label: 'Salah metode pembayaran', description: 'Metode bayar yang dipilih salah (contoh: Tunai vs Transfer)' },
  { code: 'DUPLICATE_ENTRY', label: 'Duplikasi input', description: 'Transaksi tercatat lebih dari satu kali' },
  { code: 'PAYMENT_CANCELLED', label: 'Pembayaran dibatalkan', description: 'Tamu membatalkan atau transaksi bank/EDC gagal' },
  { code: 'OTHER', label: 'Lainnya (wajib catatan)', description: 'Alasan operasional khusus lainnya' }
];

export function getReasonLabel(code?: string | null): string {
  if (!code) return '-';
  const found = PAYMENT_CORRECTION_REASONS.find(r => r.code === code);
  return found ? found.label : code;
}

/**
 * A payment is eligible for correction or voiding only if:
 * 1. It is not already CORRECTED or VOIDED
 * 2. It is not a REVERSAL transaction itself
 * 3. It has SUCCESS status
 */
export function isPaymentEligibleForCorrection(payment: PaymentTransactionItem | null | undefined): boolean {
  if (!payment) return false;
  const status = String(payment.status || '').toUpperCase();
  const type = String(payment.transaction_type || '').toUpperCase();

  if (status === 'CORRECTED' || status === 'VOIDED') return false;
  if (type === 'REVERSAL') return false;
  if (status !== 'SUCCESS') return false;

  return true;
}

export interface DifferenceCalculation {
  oldAmount: number;
  newAmount: number;
  difference: number;
  isIncrease: boolean;
  isDecrease: boolean;
  isSame: boolean;
  absDifference: number;
}

export function calculateCorrectionDifference(
  oldAmountInput: number | string,
  newAmountInput: number | string
): DifferenceCalculation {
  const oldAmount = Math.max(0, Math.round(Number(oldAmountInput) || 0));
  const newAmount = Math.max(0, Math.round(Number(newAmountInput) || 0));
  const difference = newAmount - oldAmount;

  return {
    oldAmount,
    newAmount,
    difference,
    isIncrease: difference > 0,
    isDecrease: difference < 0,
    isSame: difference === 0,
    absDifference: Math.abs(difference)
  };
}

export interface CorrectionValidationResult {
  valid: boolean;
  errors: {
    amount?: string;
    reasonCode?: string;
    reasonText?: string;
  };
}

export function validateCorrectionForm(params: {
  originalAmount: number;
  newAmount: number;
  maxAllowedNewAmount: number;
  reasonCode: string;
  reasonText?: string;
}): CorrectionValidationResult {
  const errors: CorrectionValidationResult['errors'] = {};
  const { originalAmount, newAmount, maxAllowedNewAmount, reasonCode, reasonText } = params;

  if (!Number.isFinite(newAmount) || !Number.isInteger(newAmount) || newAmount <= 0) {
    errors.amount = 'Nominal pembayaran baru harus berupa angka bulat positif lebih dari 0.';
  } else if (newAmount > maxAllowedNewAmount) {
    errors.amount = `Nominal koreksi tidak boleh melebihi batas maksimal Rp ${maxAllowedNewAmount.toLocaleString('id-ID')}.`;
  } else if (newAmount === originalAmount && reasonCode === 'WRONG_AMOUNT') {
    errors.amount = 'Nominal baru sama dengan nominal sebelumnya. Ubah nominal atau pilih alasan lain.';
  }

  const validReasons: string[] = PAYMENT_CORRECTION_REASONS.map(r => r.code);
  if (!reasonCode || !validReasons.includes(reasonCode)) {
    errors.reasonCode = 'Silakan pilih alasan koreksi.';
  }

  if (reasonCode === 'OTHER' && (!reasonText || reasonText.trim().length === 0)) {
    errors.reasonText = 'Catatan wajib diisi jika memilih alasan Lainnya.';
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors
  };
}

export interface VoidValidationResult {
  valid: boolean;
  errors: {
    reasonCode?: string;
    reasonText?: string;
  };
}

export function validateVoidForm(params: {
  reasonCode: string;
  reasonText?: string;
}): VoidValidationResult {
  const errors: VoidValidationResult['errors'] = {};
  const { reasonCode, reasonText } = params;

  const validReasons: string[] = PAYMENT_CORRECTION_REASONS.map(r => r.code);
  if (!reasonCode || !validReasons.includes(reasonCode)) {
    errors.reasonCode = 'Silakan pilih alasan pembatalan.';
  }

  if (reasonCode === 'OTHER' && (!reasonText || reasonText.trim().length === 0)) {
    errors.reasonText = 'Catatan wajib diisi jika memilih alasan Lainnya.';
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors
  };
}

const MONTH_NAMES_ID = [
  'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun',
  'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'
];

/**
 * Format timestamp to Hotel Local WIB format (Asia/Jakarta UTC+7):
 * Example: '27 Agu 2026 · 19:31 WIB'
 */
export function formatHotelTimestamp(isoOrDate?: string | Date | null): string {
  if (!isoOrDate) return '-';
  try {
    const d = new Date(isoOrDate);
    if (isNaN(d.getTime())) return String(isoOrDate);

    // Use Intl for Asia/Jakarta timezone
    const formatter = new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    const parts = formatter.formatToParts(d);
    let day = '';
    let monthIdx = 0;
    let year = '';
    let hour = '';
    let minute = '';

    for (const part of parts) {
      if (part.type === 'day') day = part.value.padStart(2, '0');
      if (part.type === 'month') monthIdx = Math.max(0, parseInt(part.value, 10) - 1);
      if (part.type === 'year') year = part.value;
      if (part.type === 'hour') hour = part.value.padStart(2, '0');
      if (part.type === 'minute') minute = part.value.padStart(2, '0');
    }

    const monthName = MONTH_NAMES_ID[monthIdx] || 'Jan';
    return `${day} ${monthName} ${year} · ${hour}:${minute} WIB`;
  } catch {
    return String(isoOrDate);
  }
}

export interface PaymentStatusVisual {
  label: string;
  bgColor: string;
  textColor: string;
  borderColor: string;
  strikeThrough?: boolean;
}

export function getPaymentStatusVisual(status?: string, type?: string): PaymentStatusVisual {
  const s = String(status || '').toUpperCase();
  const t = String(type || '').toUpperCase();

  if (t === 'REVERSAL') {
    return {
      label: 'REVERSAL',
      bgColor: 'bg-rose-50',
      textColor: 'text-rose-700',
      borderColor: 'border-rose-200'
    };
  }
  if (t === 'CORRECTION_REPLACEMENT') {
    return {
      label: 'PENGGANTI',
      bgColor: 'bg-emerald-50',
      textColor: 'text-emerald-700',
      borderColor: 'border-emerald-200'
    };
  }
  if (s === 'CORRECTED') {
    return {
      label: 'DIKOREKSI',
      bgColor: 'bg-amber-50',
      textColor: 'text-amber-700',
      borderColor: 'border-amber-200',
      strikeThrough: true
    };
  }
  if (s === 'VOIDED') {
    return {
      label: 'DIBATALKAN',
      bgColor: 'bg-rose-50',
      textColor: 'text-rose-700',
      borderColor: 'border-rose-200',
      strikeThrough: true
    };
  }
  if (s === 'SUCCESS') {
    return {
      label: 'BERHASIL',
      bgColor: 'bg-emerald-50',
      textColor: 'text-emerald-700',
      borderColor: 'border-emerald-200'
    };
  }
  return {
    label: s || 'UNKNOWN',
    bgColor: 'bg-stone-50',
    textColor: 'text-stone-700',
    borderColor: 'border-stone-200'
  };
}

export function formatActorName(actor?: string | null): string {
  if (!actor || !actor.trim()) {
    return 'Pelaku tidak tersedia';
  }
  return actor.trim();
}

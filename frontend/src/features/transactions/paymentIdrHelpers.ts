/**
 * Payment & IDR Monetary Formatting Utilities for OAK HIMS.
 *
 * Enforces integer IDR monetary parsing, formatting, and validation.
 * Rejects negative amounts, ambiguous decimals, non-integers, and overpayments.
 */

export interface IdrPaymentValidationResult {
  isValid: boolean;
  amount: number;
  error: string | null;
}

/**
 * Parses any display or user-entered string into a raw integer IDR number.
 * Returns 0 if input is empty, null, undefined, negative, contains decimals, or is non-numeric.
 */
export function parseIdrInput(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (!Number.isInteger(value)) return 0; // Rejects 1.5, 1000.5
    return value;
  }

  let str = String(value).trim();
  if (!str) return 0;

  // 1. Reject negative signs
  if (str.includes('-')) {
    return 0;
  }

  // 2. Reject commas (decimals)
  if (str.includes(',')) {
    return 0;
  }

  // 3. Strip optional currency prefix "Rp", "IDR", "Rp." (case-insensitive)
  str = str.replace(/^(rp\.?|idr)\s*/i, '').trim();
  if (!str) return 0;

  // 4. Validate thousand-group dots vs ambiguous decimals
  if (str.includes('.')) {
    const validThousandGroupPattern = /^\d{1,3}(\.\d{3})+$/;
    if (!validThousandGroupPattern.test(str)) {
      // Ambiguous decimal (e.g. "1.5", "1000.50", "1.2.3")
      return 0;
    }
    str = str.replace(/\./g, '');
  }

  // 5. Must consist strictly of digits
  if (!/^\d+$/.test(str)) {
    return 0;
  }

  const parsed = parseInt(str, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Formats a raw number or string into Indonesian IDR formatted string with '.' thousands separators.
 * Preserves invalid characters (such as '-' or decimals) so live validation can flag them to the user.
 */
export function formatIdrInput(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return '';
    if (value === 0) return '0';
    return value.toLocaleString('id-ID');
  }

  const str = String(value).trim();
  if (!str) return '';

  // If input contains negative sign, comma, or alphabets (except Rp/IDR prefix), keep string for validation
  if (str.includes('-') || str.includes(',')) {
    return str;
  }

  const strippedPrefix = str.replace(/^(rp\.?|idr)\s*/i, '').trim();
  if (!strippedPrefix) return '';

  // Check if it's an ambiguous decimal like 1.5 or 1000.50 (single dot followed by 0-2 digits)
  if (strippedPrefix.includes('.')) {
    const validThousandGroupPattern = /^\d{1,3}(\.\d{3})+$/;
    if (!validThousandGroupPattern.test(strippedPrefix)) {
      // Check if it's an ambiguous decimal like "1.5", "100.50", "100." (dot followed by 0-2 digits at end)
      if (/\.\d{0,2}$/.test(strippedPrefix)) {
        return str;
      }
      const parts = strippedPrefix.split('.');
      // If any internal part before the last part has length !== 3 (e.g. "1.2.0000"), it's malformed
      for (let i = 1; i < parts.length - 1; i++) {
        if (parts[i].length !== 3) {
          return str;
        }
      }
    }
  }

  // If pure digits or already thousand-formatted, normalize to pure digits then format
  const digits = strippedPrefix.replace(/\./g, '');
  if (!/^\d+$/.test(digits)) {
    return str;
  }

  const parsed = parseInt(digits, 10);
  if (!Number.isFinite(parsed)) return str;
  if (parsed === 0) return '0';

  return parsed.toLocaleString('id-ID');
}

/**
 * Validates IDR payment input against format rules and remaining balance.
 */
export function validateIdrPaymentInput(
  input: string | number | null | undefined,
  remainingBalance?: number | string | null | undefined
): IdrPaymentValidationResult {
  if (input === null || input === undefined || String(input).trim() === '') {
    return { isValid: false, amount: 0, error: 'Masukkan nominal pembayaran' };
  }

  const str = String(input).trim();

  if (str.includes('-') || (typeof input === 'number' && input < 0)) {
    return { isValid: false, amount: 0, error: 'Nominal pembayaran tidak boleh bernilai negatif' };
  }

  if (str.includes(',') || (typeof input === 'number' && !Number.isInteger(input))) {
    return { isValid: false, amount: 0, error: 'Nominal pembayaran tidak boleh menggunakan desimal' };
  }

  if (str.includes('.')) {
    const unprefix = str.replace(/^(rp\.?|idr)\s*/i, '').trim();
    const validThousandGroupPattern = /^\d{1,3}(\.\d{3})+$/;
    if (!validThousandGroupPattern.test(unprefix)) {
      return { isValid: false, amount: 0, error: 'Nominal pembayaran tidak boleh menggunakan desimal' };
    }
  }

  const unprefix = str.replace(/^(rp\.?|idr)\s*/i, '').replace(/\./g, '').trim();
  if (!/^\d+$/.test(unprefix)) {
    return { isValid: false, amount: 0, error: 'Nominal pembayaran harus berupa angka' };
  }

  const amount = parseIdrInput(input);
  if (amount <= 0) {
    return { isValid: false, amount: 0, error: 'Nominal pembayaran harus lebih dari 0' };
  }

  if (remainingBalance !== undefined && remainingBalance !== null) {
    const remaining = parseIdrInput(remainingBalance);
    if (remaining > 0 && amount > remaining) {
      return {
        isValid: false,
        amount,
        error: 'Nominal pembayaran melebihi sisa tagihan'
      };
    }
  }

  return { isValid: true, amount, error: null };
}

/**
 * Calculates preview of remaining balance after applying candidate payment amount.
 * Clamps remaining balance to 0 minimum.
 */
export function calculateRemainingBalancePreview(
  outstandingBalance: number | string | null | undefined,
  paymentAmount: number | string | null | undefined
): number {
  const currentOutstanding = Math.max(0, parseIdrInput(outstandingBalance));
  const amountToPay = Math.max(0, parseIdrInput(paymentAmount));
  return Math.max(0, currentOutstanding - amountToPay);
}

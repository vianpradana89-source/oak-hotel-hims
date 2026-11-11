/**
 * bookingPaymentIntentService.ts
 *
 * Pure normalization for quick-booking payment intent (Phase 2B-1).
 * No queries, no storage, no network.
 *
 * Money validation model:
 *  - Legacy ordinary (no payment_mode): tolerant; negative clamps to 0
 *    (original handler max(0, roundIdr)); boolean/array/object/NaN/Infinity → 400.
 *  - Strict explicit ordinary (PAY_BILL / ADVANCE_PAYMENT / UNPAID):
 *    finite, nonnegative, rounded safe integer; negative/non-safe/boolean/
 *    array/object/NaN → 400.
 *  - DP advance amount (advance_amount):
 *    missing/null/''/0 → inactive (DP not used).
 *    Positive safe integer → accepted for ADVANCE_PAYMENT; 400 otherwise.
 *    Negative/non-integer/unsafe/boolean/array/object/NaN/Infinity → 400.
 *
 * Supported payment sources (explicit modes only):
 *  - amount_paid          (booking-level ordinary)
 *  - initial_payment.amount (alias, NOT double-counted if amount_paid present)
 *  - reservations[i].amount_paid (child ordinary)
 *
 * Legacy (no payment_mode): existing behaviour preserved as-is.
 * Explicit modes: any malformed source field → domain error 400, not silent fallback.
 */

export type PaymentMode = 'PAY_BILL' | 'ADVANCE_PAYMENT' | 'UNPAID' | 'LEGACY';

export interface BookingPaymentIntent {
  mode: PaymentMode;
  /** Ordinary cash-now (PAY_BILL only; 0 for ADVANCE_PAYMENT and UNPAID). Rounded integer IDR. */
  ordinaryAmount: number;
  /** DP advance amount (ADVANCE_PAYMENT only; 0 otherwise). Positive safe integer. */
  advanceAmount: number;
  /** Payment method, or null when no ordinary cash is involved. */
  paymentMethod: string | null;
  /** Evidence path. Present in UNPAID → rejected, not silently discarded. */
  evidencePath: string | null;
  /** True when payload had no payment_mode; legacy path preserved. */
  legacy: boolean;
}

function domainError(code: string, message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

/**
 * Tolerant legacy ordinary parser: matches original handler behaviour
 * `max(0, roundIdr(raw))`. Negative values clamp to 0 (no 400 from helper);
 * the existing final validation in the handler remains authoritative.
 * Boolean / array / object / NaN / Infinity → 400 (unchanged from prior helper).
 */
function parseOrdinaryAmountTolerant(raw: unknown, field: string): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'boolean' || Array.isArray(raw) || typeof raw === 'object') {
    throw domainError('INVALID_AMOUNT_FORMAT', `${field} harus number atau string numerik (got ${typeof raw})`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw domainError('INVALID_AMOUNT_FORMAT', `${field} harus bilangan finit (got: ${String(raw)})`);
  }
  // Tolerant: negative clamps to 0, matching original handler max(0, roundIdr).
  return Math.max(0, Math.round(parsed));
}

/** Strict explicit ordinary parser: finite nonnegative, rounded safe integer. */
function parseOrdinaryAmountStrict(raw: unknown, field: string): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'boolean' || Array.isArray(raw) || typeof raw === 'object') {
    throw domainError('INVALID_AMOUNT_FORMAT', `${field} harus number atau string numerik (got ${typeof raw})`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw domainError('INVALID_AMOUNT_FORMAT', `${field} harus bilangan finit (got: ${String(raw)})`);
  }
  if (parsed < 0) {
    throw domainError('INVALID_AMOUNT_FORMAT', `${field} tidak boleh negatif (got: ${parsed})`);
  }
  const rounded = Math.round(parsed);
  if (!Number.isSafeInteger(rounded)) {
    throw domainError('INVALID_AMOUNT_FORMAT', `${field} harus safe integer setelah pembulatan (got: ${String(raw)})`);
  }
  return rounded;
}

/**
 * Parses DP advance amount: must be a positive safe integer.
 * Returns the integer, or null when field is absent/inactive (undefined/null/''/0).
 * Throws 400 domain error for any invalid populated value (negative, non-integer,
 * unsafe, boolean, array, object, NaN, Infinity).
 */
function parseAdvanceAmount(raw: unknown, field: string): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'boolean' || Array.isArray(raw) || typeof raw === 'object') {
    throw domainError('INVALID_ADVANCE_AMOUNT', `advance_amount harus number/string integer positif (got ${typeof raw})`);
  }
  const parsed = Number(raw);
  if (parsed === 0) return null; // 0 = DP inactive (PAY_BILL/UNPAID)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw domainError('INVALID_ADVANCE_AMOUNT', `advance_amount harus safe integer > 0 (got: ${String(raw)})`);
  }
  return parsed;
}

function getInitialPaymentObject(payload: Record<string, unknown>): Record<string, unknown> | null {
  const ip = payload['initial_payment'];
  if (ip === undefined || ip === null) return null;
  if (typeof ip !== 'object' || Array.isArray(ip)) {
    throw domainError('INVALID_INITIAL_PAYMENT_FORMAT',
      'initial_payment harus object { amount, payment_method, payment_evidence_path } atau kosong');
  }
  return ip as Record<string, unknown>;
}

/** Resolves initial_payment sub-object; returns undefined if absent. */
function getInitialPaymentAmount(payload: Record<string, unknown>): unknown {
  const ip = getInitialPaymentObject(payload);
  if (!ip) return undefined;
  return ip['amount'];
}

function isMeaningfulText(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const s = String(value).trim();
  return s.length > 0;
}

function firstMeaningfulText(sources: unknown[], fieldLabel: string): string | null {
  let found: string | null = null;
  for (const raw of sources) {
    if (!isMeaningfulText(raw)) continue;
    const s = String(raw).trim();
    if (found !== null && s !== found) {
      throw domainError('CONFLICTING_ALIAS_VALUES', `${fieldLabel} memiliki nilai alias yang bertentangan; buang salah satu`);
    }
    found = s;
  }
  return found;
}

/** Validates reservations array shape before accessing child fields. */
function getReservationsChildAmounts(payload: Record<string, unknown>, strict: boolean): number[] | null {
  const reservations = payload['reservations'];
  if (reservations === undefined || reservations === null) return null;
  if (!Array.isArray(reservations)) {
    throw domainError('INVALID_RESERVATIONS_FORMAT', 'reservations harus array of objects');
  }
  const parse = strict ? parseOrdinaryAmountStrict : parseOrdinaryAmountTolerant;
  return reservations.map((child, idx) => {
    if (child === undefined || child === null || typeof child !== 'object' || Array.isArray(child)) {
      throw domainError('INVALID_RESERVATIONS_FORMAT', `reservations[${idx}] harus object`);
    }
    const raw = (child as Record<string, unknown>)['amount_paid'];
    // Child amount_paid: same rules as booking-level ordinary amount
    return parse(raw, `reservations[${idx}].amount_paid`) ?? 0;
  });
}

/** BU-R2-05: True when any child has a raw (pre-rounding) positive amount_paid. */
function hasRawPositiveChildAmount(payload: Record<string, unknown>): boolean {
  const reservations = payload['reservations'];
  if (!Array.isArray(reservations)) return false;
  return reservations.some((child) => {
    if (!child || typeof child !== 'object' || Array.isArray(child)) return false;
    const raw = (child as Record<string, unknown>)['amount_paid'];
    if (raw === undefined || raw === null || raw === '') return false;
    const num = Number(raw);
    return Number.isFinite(num) && num > 0;
  });
}

/**
 * Normalizes payment intent from booking payload.
 *
 * - No payment_mode field => LEGACY (existing behaviour preserved).
 * - PAY_BILL: ordinaryAmount from amount_paid / initial_payment.amount (no double-count);
 *   advanceAmount=0; positive advance_amount => 400.
 * - ADVANCE_PAYMENT: advanceAmount from advance_amount (>0 safe integer);
 *   ordinary forced to 0; any positive ordinary/child source => 400.
 * - UNPAID: all zero; any positive ordinary/advance/child input OR any populated
 *   evidence field => 400 (not silently discarded).
 * - Unknown mode => 400 before any write.
 */
export function normalizeBookingPaymentIntent(
  payload: Record<string, unknown> | null | undefined
): BookingPaymentIntent {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { mode: 'LEGACY', ordinaryAmount: 0, advanceAmount: 0, paymentMethod: null, evidencePath: null, legacy: true };
  }

  const rawMode = payload['payment_mode'];

  // ── LEGACY: no explicit payment_mode, preserve existing behaviour ─────────
  if (rawMode === undefined || rawMode === null || rawMode === '') {
    // Legacy: accept the same source fields the existing code reads, no 400 for
    // populated-but-invalid values (preserve existing tolerant behaviour).
    const legacyAmount = parseOrdinaryAmountTolerant(payload['amount_paid'], 'amount_paid')
      ?? parseOrdinaryAmountTolerant(getInitialPaymentAmount(payload), 'initial_payment.amount')
      ?? 0;
    const legacyMethod = payload['payment_method'] != null ? String(payload['payment_method']) : null;
    const legacyEvidence = payload['bukti_bayar_path'] != null
      ? String(payload['bukti_bayar_path'])
      : (typeof payload['initial_payment'] === 'object' && payload['initial_payment'] !== null
        ? ((payload['initial_payment'] as Record<string, unknown>)['payment_evidence_path'] != null
            ? String((payload['initial_payment'] as Record<string, unknown>)['payment_evidence_path']) : null)
        : null);
    return {
      mode: 'LEGACY',
      ordinaryAmount: legacyAmount,
      advanceAmount: 0,
      paymentMethod: legacyMethod,
      evidencePath: legacyEvidence,
      legacy: true
    };
  }

  const mode = String(rawMode).trim().toUpperCase();
  if (mode !== 'PAY_BILL' && mode !== 'ADVANCE_PAYMENT' && mode !== 'UNPAID') {
    throw domainError('UNKNOWN_PAYMENT_MODE', `payment_mode harus PAY_BILL, ADVANCE_PAYMENT, atau UNPAID (got: ${String(rawMode)})`);
  }

  // ── Resolve ordinary amount (no double-count) ─────────────────────────────
  // Precedence: amount_paid (if present) > initial_payment.amount (if present) > 0
  // Strict explicit parsing: finite, nonnegative, rounded safe integer.
  const amountPaidRaw = payload['amount_paid'];
  const initialAmountRaw = getInitialPaymentAmount(payload);
  let ordinary: number;
  if (amountPaidRaw !== undefined && amountPaidRaw !== null && amountPaidRaw !== '') {
    ordinary = parseOrdinaryAmountStrict(amountPaidRaw, 'amount_paid')!; // non-null after guard
    // If amount_paid is present AND initial_payment.amount is also present with a
    // different value, that is ambiguous — reject.
    const initialParsed = parseOrdinaryAmountStrict(initialAmountRaw, 'initial_payment.amount');
    if (initialParsed !== null && initialParsed !== ordinary) {
      throw domainError('AMBIGUOUS_ORDINARY_AMOUNT',
        'amount_paid dan initial_payment.amount bertentangan; buang salah satu');
    }
  } else {
    ordinary = parseOrdinaryAmountStrict(initialAmountRaw, 'initial_payment.amount') ?? 0;
  }

  // Raw-positive conflict check BEFORE rounding erases the value:
  // a positive ordinary raw that rounds to 0 must not silently vanish.
  const rawPositiveOrdinary = (
    (amountPaidRaw !== undefined && amountPaidRaw !== null && amountPaidRaw !== '' && Number(amountPaidRaw) > 0)
    || (initialAmountRaw !== undefined && initialAmountRaw !== null && initialAmountRaw !== '' && Number(initialAmountRaw) > 0)
  );

  // Child amounts: sum of reservations[i].amount_paid (validated above)
  const childAmounts = getReservationsChildAmounts(payload, true);
  let totalChildPaid = childAmounts ? childAmounts.reduce((s, v) => s + v, 0) : 0;
  if (!Number.isSafeInteger(totalChildPaid)) {
    throw domainError('INVALID_AMOUNT_FORMAT',
      'total reservations[i].amount_paid harus safe integer setelah pembulatan (got: ' + String(totalChildPaid) + ')');
  }
  // BU-R2-05: rawPositiveChild checks the pre-rounding raw value, not the rounded sum.
  // A child amount of 0.1 (or "0.1") rounds to 0 in totalChildPaid, but the raw
  // value is still positive — that must be treated as a conflict, not silently erased.
  const rawPositiveChild = hasRawPositiveChildAmount(payload) || totalChildPaid > 0;

  // Resolve initial_payment alias object once for method/evidence aliases.
  const ipObj = getInitialPaymentObject(payload);

  // Resolve payment_method alias: booking-level payment_method vs initial_payment.payment_method.
  // Conflicting nonblank aliases are rejected; blank/null are not meaningful values.
  const aliasMethod = firstMeaningfulText(
    [payload['payment_method'], ipObj ? ipObj['payment_method'] : undefined],
    'payment_method'
  );
  const paymentMethod = aliasMethod !== null ? aliasMethod.toUpperCase() : null;

  // Resolve evidence alias: booking-level bukti_bayar_path vs initial_payment.payment_evidence_path.
  // Blank/null values are not considered receipt evidence.
  const evidencePath = firstMeaningfulText(
    [payload['bukti_bayar_path'], ipObj ? ipObj['payment_evidence_path'] : undefined],
    'evidence (bukti_bayar_path / initial_payment.payment_evidence_path)'
  );

  // ── UNPAID ─────────────────────────────────────────────────────────────────
  if (mode === 'UNPAID') {
    // advance_amount missing/null/blank/0 means DP inactive; only positive
    // values conflict. Invalid populated values still 400 via parseAdvanceAmount.
    const advance = parseAdvanceAmount(payload['advance_amount'], 'advance_amount');
    const conflictSources: string[] = [];
    if (rawPositiveOrdinary || rawPositiveChild) conflictSources.push('ordinary input (amount_paid / initial_payment.amount / reservations[i].amount_paid)');
    if (advance !== null) conflictSources.push('advance_amount');
    if (evidencePath !== null) conflictSources.push('bukti_bayar_path / initial_payment.payment_evidence_path');
    if (aliasMethod !== null) conflictSources.push('payment_method');
    if (conflictSources.length > 0) {
      throw domainError('UNPAID_CONFLICTS_WITH_PAYMENT_INPUT',
        `UNPAID (Belum Bayar) tidak boleh disertai: ${conflictSources.join(', ')}. Hapus field tersebut atau ubah payment_mode.`);
    }
    return { mode: 'UNPAID', ordinaryAmount: 0, advanceAmount: 0, paymentMethod: null, evidencePath: null, legacy: false };
  }

  // ── ADVANCE_PAYMENT ────────────────────────��──────────────────────────────
  if (mode === 'ADVANCE_PAYMENT') {
    const advance = parseAdvanceAmount(payload['advance_amount'], 'advance_amount');
    if (advance === null || advance <= 0) {
      throw domainError('ADVANCE_AMOUNT_REQUIRED',
        'ADVANCE_PAYMENT membutuhkan advance_amount positif (safe integer > 0)');
    }
    const conflictSources: string[] = [];
    if (rawPositiveOrdinary) conflictSources.push('amount_paid');
    if (rawPositiveChild) conflictSources.push('reservations[i].amount_paid');
    if (conflictSources.length > 0) {
      throw domainError('ORDINARY_AND_ADVANCE_CONFLICT',
        `ADVANCE_PAYMENT tidak boleh membawa ordinary payment positif: ${conflictSources.join(', ')}. Nominal DP disimpan di advance_amount saja.`);
    }
    return { mode: 'ADVANCE_PAYMENT', ordinaryAmount: 0, advanceAmount: advance, paymentMethod, evidencePath, legacy: false };
  }

  // ── PAY_BILL ───────────────────────────────────────────────────────────────
  // advance_amount missing/null/blank/0 means DP inactive; only positive values
  // conflict. Invalid populated values still 400 via parseAdvanceAmount.
  const advance = parseAdvanceAmount(payload['advance_amount'], 'advance_amount');
  if (advance !== null && advance > 0) {
    throw domainError('ADVANCE_IN_PAY_BILL',
      'PAY_BILL tidak boleh membawa advance_amount > 0; gunakan payment_mode ADVANCE_PAYMENT');
  }
  // Explicit resolution of booking / initial_payment / child sources: no silent
  // drop, no double-count.
  //  - booking amount only → ordinary = booking amount (child-only reservation
  //    rows carry no amount; the helper does not claim child-only support).
  //  - child amount only → reject: child nominal is NOT returned by this DTO,
  //    so accepting it would silently drop money.
  //  - both positive → ambiguous: conflict 400.
  if (ordinary > 0 && totalChildPaid > 0) {
    throw domainError('AMBIGUOUS_ORDINARY_AMOUNT',
      'amount_paid booking dan total reservations[i].amount_paid positif bersama-sama; pilih satu sumber authoritative (buang salah satu)');
  }
  if (ordinary === 0 && totalChildPaid > 0) {
    throw domainError('UNSUPPORTED_CHILD_ONLY_PAYMENT',
      'Hanya nominal child (reservations[i].amount_paid) terisi tanpa amount_paid booking; helper ini tidak mendukung sumber child-only karena nominal child tidak dikembalikan ke caller');
  }
  return {
    mode: 'PAY_BILL',
    ordinaryAmount: Math.max(0, ordinary ?? 0),
    advanceAmount: 0,
    paymentMethod,
    evidencePath,
    legacy: false
  };
}

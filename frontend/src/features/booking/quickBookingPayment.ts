/** Explicit create-only payment DTO and one-attempt HTTP transport. No storage/DB. */
export type QuickBookingPaymentMode = 'PAY_BILL' | 'ADVANCE_PAYMENT' | 'UNPAID';
export const QUICK_BOOKING_PAYMENT_OPTIONS: ReadonlyArray<{ value: QuickBookingPaymentMode; label: string }> = [
  { value: 'PAY_BILL', label: 'Bayar Tagihan' },
  { value: 'ADVANCE_PAYMENT', label: 'Uang Muka (DP)' },
  { value: 'UNPAID', label: 'Belum Bayar' },
];

export interface QuickBookingPaymentInput {
  mode: QuickBookingPaymentMode;
  amountPaid: number;
  advanceAmount: number;
  paymentMethod: string;
  otaCollect: boolean;
}

export function effectiveQuickBookingPaymentMode(input: Pick<QuickBookingPaymentInput, 'mode' | 'otaCollect'>): QuickBookingPaymentMode {
  return input.otaCollect ? 'UNPAID' : input.mode;
}

export function nextQuickBookingOrdinaryAmount(input: {
  mode: QuickBookingPaymentMode; otaCollect: boolean; isOta: boolean;
  touched: boolean; amountPaid: number; grandTotal: number;
}): number {
  if (input.otaCollect || input.mode !== 'PAY_BILL') return 0;
  if (input.isOta && !input.touched) return 0;
  if (input.touched) return Math.min(input.amountPaid, input.grandTotal);
  return input.amountPaid === 0 || input.amountPaid > input.grandTotal ? input.grandTotal : input.amountPaid;
}

function validAmount(value: number, positive: boolean): boolean {
  return Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0);
}

const METHODS = ['CASH', 'TRANSFER', 'QRIS', 'DEBIT_CARD', 'CREDIT_CARD'];

export function quickBookingPaymentIssues(input: QuickBookingPaymentInput & {
  rules: Record<string, string>; hasFile: boolean;
}): string[] {
  if (input.otaCollect) return input.hasFile ? [] : ['Voucher / bukti booking OTA wajib diunggah untuk OTA Collect'];
  const issues: string[] = [];
  const mode = effectiveQuickBookingPaymentMode(input);
  const cashNow = mode === 'PAY_BILL' ? input.amountPaid : mode === 'ADVANCE_PAYMENT' ? input.advanceAmount : 0;
  if (mode === 'UNPAID' && input.hasFile) issues.push('Belum Bayar tidak boleh disertai bukti pembayaran hotel');
  if (mode === 'PAY_BILL' && !validAmount(input.amountPaid, false)) {
    issues.push('Nominal pembayaran harus rupiah bulat, tidak negatif, dan dalam batas aman');
  }
  if (mode === 'ADVANCE_PAYMENT' && !validAmount(input.advanceAmount, true)) {
    issues.push('Nominal uang muka harus rupiah bulat lebih dari 0 dan dalam batas aman');
  }
  // Match the accepted backend gates; UNPAID does not override property rules.
  if (mode === 'UNPAID' && (input.rules.payment_method === 'REQUIRED' || input.rules.payment_amount === 'REQUIRED')) {
    issues.push('Belum Bayar tidak tersedia karena aturan properti mewajibkan pembayaran');
  } else {
    if ((mode === 'ADVANCE_PAYMENT' || input.rules.payment_method === 'REQUIRED') && !METHODS.includes(input.paymentMethod)) {
      issues.push('Metode pembayaran wajib dipilih');
    }
    if (input.rules.payment_amount === 'REQUIRED' && !(cashNow > 0)) issues.push('Nominal pembayaran wajib lebih dari 0');
  }
  if (mode !== 'UNPAID' && input.rules.payment_evidence === 'REQUIRED' && cashNow > 0 && !input.hasFile) {
    issues.push('Bukti pembayaran wajib diunggah untuk nominal pembayaran > 0');
  }
  return issues;
}

export function quickBookingPaymentSummary(input: QuickBookingPaymentInput & { grandTotal: number }) {
  const mode = effectiveQuickBookingPaymentMode(input);
  const ordinaryPaid = mode === 'PAY_BILL' ? input.amountPaid : 0;
  return {
    ordinaryPaid,
    advanceReceived: mode === 'ADVANCE_PAYMENT' ? input.advanceAmount : 0,
    remainingBill: Math.max(0, input.grandTotal - ordinaryPaid),
  };
}

const PAYMENT_KEYS = ['payment_mode', 'amount_paid', 'advance_amount', 'payment_method', 'initial_payment',
  'bukti_bayar_path', 'payment_evidence_path', 'evidence_path'];

function withoutPaymentAliases(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => !PAYMENT_KEYS.includes(name)));
}

/** One booking-level amount; child ordinary amounts are always zero in this composer. */
export function buildQuickBookingPaymentPayload(base: Record<string, unknown>, input: QuickBookingPaymentInput): Record<string, unknown> {
  const mode = effectiveQuickBookingPaymentMode(input);
  if (!QUICK_BOOKING_PAYMENT_OPTIONS.some(option => option.value === mode)) throw new Error('Pilihan pembayaran tidak valid');
  if (!Array.isArray(base.reservations) || base.reservations.length === 0) throw new Error('Minimal 1 kamar harus dipilih');
  if (mode === 'PAY_BILL' && !validAmount(input.amountPaid, false)) throw new Error('Nominal pembayaran tidak valid');
  if (mode === 'ADVANCE_PAYMENT' && (!validAmount(input.advanceAmount, true) || !METHODS.includes(input.paymentMethod))) {
    throw new Error('Nominal atau metode uang muka tidak valid');
  }
  return {
    ...withoutPaymentAliases(base),
    payment_mode: mode,
    amount_paid: mode === 'PAY_BILL' ? input.amountPaid : 0,
    ...(mode === 'ADVANCE_PAYMENT' ? { advance_amount: input.advanceAmount } : {}),
    ...(mode !== 'UNPAID' && input.paymentMethod ? { payment_method: input.paymentMethod } : {}),
    reservations: base.reservations.map((value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Data kamar tidak valid');
      return { ...withoutPaymentAliases(value as Record<string, unknown>), amount_paid: 0 };
    }),
  };
}

export interface QuickBookingAttempt {
  readonly requestKey: string;
  readonly propertyId: number;
  readonly mode: QuickBookingPaymentMode;
  readonly advanceAmount: number;
  readonly payloadJson: string;
  readonly evidence: File | null;
}

// Retain an unresolved attempt across modal close/unmount within this browser tab.
// A retry always receives the same frozen object, payload, file and request key.
const pendingAttempts = new Map<number, QuickBookingAttempt>();
const warnBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
export function pendingQuickBookingAttempt(propertyId: number): QuickBookingAttempt | null {
  return pendingAttempts.get(propertyId) || null;
}
export function rememberQuickBookingAttempt(attempt: QuickBookingAttempt): void {
  const existing = pendingAttempts.get(attempt.propertyId);
  if (existing && existing !== attempt) throw new Error('Pengiriman sebelumnya perlu diperiksa sebelum membuat reservasi baru.');
  if (pendingAttempts.size === 0 && typeof window !== 'undefined') window.addEventListener('beforeunload', warnBeforeUnload);
  pendingAttempts.set(attempt.propertyId, attempt);
}
export function finishQuickBookingAttempt(attempt: QuickBookingAttempt): void {
  if (pendingAttempts.get(attempt.propertyId) !== attempt) return;
  pendingAttempts.delete(attempt.propertyId);
  if (pendingAttempts.size === 0 && typeof window !== 'undefined') window.removeEventListener('beforeunload', warnBeforeUnload);
}

export function createQuickBookingAttempt(payload: Record<string, unknown>, evidence: File | null,
  makeKey: () => string = () => crypto.randomUUID()): QuickBookingAttempt {
  const propertyId = payload.property_id;
  if (typeof propertyId !== 'number' || !Number.isSafeInteger(propertyId) || propertyId <= 0) throw new Error('Properti tidak valid');
  const mode = payload.payment_mode as QuickBookingPaymentMode;
  if (!QUICK_BOOKING_PAYMENT_OPTIONS.some(option => option.value === mode)) throw new Error('Pilihan pembayaran tidak valid');
  const otaCollect = payload.booking_channel === 'OTA' && payload.payment_responsibility === 'OTA_COLLECT';
  if (mode === 'UNPAID' && evidence && !otaCollect) throw new Error('Belum Bayar tidak boleh disertai bukti pembayaran hotel');
  const requestKey = makeKey();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(requestKey)) throw new Error('Identitas pengiriman tidak dapat dibuat');
  return Object.freeze({ requestKey, propertyId, mode, advanceAmount: Number(payload.advance_amount || 0),
    payloadJson: JSON.stringify({ ...payload, request_key: requestKey }), evidence });
}

export type QuickBookingSubmitOutcome =
  | { kind: 'success'; bookingId: number }
  | { kind: 'rejected'; message: string }
  | { kind: 'uncertain'; message: string };

const UNCERTAIN_MESSAGE = 'Hasil pengiriman belum dapat dipastikan. Gunakan Coba Lagi untuk memeriksa pengiriman yang sama; jangan membuat reservasi baru.';
const inFlight = new WeakMap<QuickBookingAttempt, Promise<QuickBookingSubmitOutcome>>();

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** PostgreSQL BIGSERIAL IDs arrive as decimal strings; retain precision, never coerce them. */
function validDepositId(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}

/** No automatic retry or legacy fallback. Repeated calls reuse the exact snapshot/key/file. */
export function sendQuickBookingAttempt(attempt: QuickBookingAttempt,
  transport: (url: string, init: RequestInit) => Promise<Response>): Promise<QuickBookingSubmitOutcome> {
  const pending = inFlight.get(attempt);
  if (pending) return pending;
  const promise = (async (): Promise<QuickBookingSubmitOutcome> => {
    try {
      const formData = new FormData();
      formData.append('booking_payload', attempt.payloadJson);
      if (attempt.evidence) formData.append('payment_evidence', attempt.evidence);
      const res = await transport('/api/bookings', {
        method: 'POST', headers: { 'Idempotency-Key': attempt.requestKey }, body: formData,
      });
      const body: unknown = await res.json();
      if (res.ok && object(body) && body.status === 'SUCCESS' && object(body.data)) {
        const data = body.data;
        const dp = data.dp_metadata;
        const dpValid = attempt.mode !== 'ADVANCE_PAYMENT' || (object(dp) &&
          validDepositId(dp.deposit_id) &&
          dp.deposit_amount === attempt.advanceAmount && dp.deposit_purpose === 'ADVANCE_PAYMENT');
        if (typeof data.booking_id === 'number' && Number.isSafeInteger(data.booking_id) && data.booking_id > 0 &&
          data.property_id === attempt.propertyId && typeof data.bid === 'string' && data.bid.trim() &&
          Array.isArray(data.reservations) && data.reservations.length > 0 && dpValid) {
          return { kind: 'success', bookingId: data.booking_id };
        }
      }
      if (object(body)) {
        // These are terminal, pre-commit input/auth rejections in the accepted route.
        const inputRejected = [400, 401, 403, 404, 413, 415, 422].includes(res.status)
          && (body.status === 'ERROR' || body.status === 'FAILED');
        const roomOverlap = res.status === 409 && body.code === 'ROOM_OVERLAP' && body.status === 'CONFLICT';
        if (inputRejected || roomOverlap) return { kind: 'rejected', message:
          typeof body.message === 'string' && body.message.trim() ? body.message : 'Data reservasi ditolak. Periksa kembali isian.' };
        if (body.code === 'BOOKING_CREATE_REPLAY_NOT_READY') return { kind: 'uncertain',
          message: 'Layanan pembuatan reservasi belum siap. Hubungi pengelola, lalu gunakan Coba Lagi untuk pengiriman yang sama.' };
      }
      return { kind: 'uncertain', message: UNCERTAIN_MESSAGE };
    } catch {
      return { kind: 'uncertain', message: UNCERTAIN_MESSAGE };
    }
  })();
  inFlight.set(attempt, promise);
  void promise.finally(() => inFlight.delete(attempt));
  return promise;
}

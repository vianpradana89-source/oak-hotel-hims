/**
 * bookingCreatePaymentService.ts
 *
 * UNIT 3B — Canonical booking payment path adapter.
 * Small decision module so the production wiring in createCanonicalBooking
 * (index.ts) uses shared, testable payment/DP decisions instead of inline
 * ad-hoc logic. No Pool, no client.query, no storage, no schema.
 *
 * Inputs are normalized values only; caller owns transactions and writes.
 */

import type { PoolClient } from 'pg';
import type { BookingPaymentIntent, PaymentMode } from './bookingPaymentIntentService';
import type { BookingCreateDeps } from './bookingCreatePaymentTypes';
import {
  resolveRequestKey,
  deriveDpReceiptKey,
  buildEvidenceDescriptor,
  type EvidenceUploadInput
} from './bookingCreateContextService';
import type {
  EvidenceUpload,
  DepositActor,
  DepositScope,
  ReceiveDepositInput
} from '../deposits/depositTypes';

/** Mirrors EvidenceRegisteringOwner from depositService (type-only usage here). */
export interface EvidenceRegisteringOwner {
  registerStorageKey(storageKey: string): void;
  isOwnedByCaller(): boolean;
}

export interface ResolvedRequestKey {
  /** null only for LEGACY mode (no explicit key required). */
  requestKey: string | null;
  /** true when at least one source (header/body) carried a key. */
  explicit: boolean;
}

export interface PaymentGateResult {
  ok: boolean;
  /** Aggregate missing_fields per property quick-booking rules. */
  missing: string[];
  /** True when a 400 was thrown before any write (e.g. OTA + UNPAID + file). */
  hardRejected: boolean;
}

export interface OrdinaryPaymentPlan {
  /** Cash to allocate across children (sequential; caller runs allocator). */
  bookingLevelCash: number;
  /** True when ≥2 children AND booking-level input present. */
  useGroupPayment: boolean;
  /** True when booking-level input present but 1 child. */
  useBookingLevelPayment: boolean;
  /** Method snapshot for group/child writes (normalized uppercase). */
  method: string | null;
  /** Evidence path alias snapshot (path form; file form handled separately). */
  evidencePath: string | null;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

export function httpError(statusCode: number, message: string, code?: string): Error {
  const err = new Error(message) as Error & { statusCode?: number; code?: string };
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw httpError(400, `${field} must be a positive integer`, 'VALIDATION_ERROR');
  }
  return n;
}

/** Core 2A supported deposit receipt methods (same contract, not invented). */
const DP_RECEIPT_METHODS: readonly string[] = [
  'CASH',
  'TRANSFER',
  'BANK_TRANSFER',
  'QRIS',
  'CARD',
  'DEBIT_CARD',
  'CREDIT_CARD'
];

export function validateDpReceiptMethod(value: unknown): string {
  const method = String(value || '').trim().toUpperCase();
  if (method.length === 0 || !DP_RECEIPT_METHODS.includes(method)) {
    throw httpError(
      400,
      `ADVANCE_PAYMENT receipt requires a supported payment method ` +
      `(one of: ${DP_RECEIPT_METHODS.join(', ')}); got ${String(value || '(empty)')}`,
      'UNSUPPORTED_PAYMENT_METHOD'
    );
  }
  return method;
}

// ── 1. Request key resolution (explicit modes) ────────────────────────────────

export function resolveBookingRequestKey(input: {
  headerKey: unknown;
  bodyKey: unknown;
  intent: BookingPaymentIntent;
}): ResolvedRequestKey {
  const explicit = !input.intent.legacy;
  const requestKey = resolveRequestKey({
    headerKey: input.headerKey,
    bodyKey: input.bodyKey,
    explicit
  });
  return { requestKey, explicit };
}

// ── 2. Convert req.file into accepted EvidenceUpload (pre-core validation) ───

export function convertFileToEvidence(file: {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
} | null | undefined,
validateEvidenceUpload: (f: {
  mimetype: string;
  size: number;
  originalname: string;
  buffer: Buffer;
}) => { valid: boolean; error?: string | null; code?: string | null }
): EvidenceUpload | null {
  if (file === null || file === undefined) return null;
  if (typeof file !== 'object' || !Buffer.isBuffer(file.buffer) ||
      typeof file.mimetype !== 'string' || file.mimetype.trim().length === 0 ||
      typeof file.originalname !== 'string') {
    throw httpError(400, 'Invalid supplied evidence file', 'EVIDENCE_INVALID');
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size !== file.buffer.length) {
    throw httpError(400, 'Declared evidence size must match buffer length', 'EVIDENCE_SIZE_MISMATCH');
  }
  if (typeof validateEvidenceUpload !== 'function') {
    throw httpError(400, 'Evidence upload validator is required', 'EVIDENCE_VALIDATOR_REQUIRED');
  }
  const evidence: EvidenceUpload = {
    buffer: file.buffer,
    mimetype: file.mimetype,
    originalname: file.originalname,
    size: file.size
  };
  const validation = validateEvidenceUpload(evidence);
  if (!validation.valid) {
    throw httpError(
      400,
      validation.error || 'File bukti pembayaran tidak valid',
      validation.code || 'EVIDENCE_INVALID'
    );
  }
  return evidence;
}

// ── 3. Payment gates (cash-now per mode + existing property rules) ──────────

export function evaluateBookingPaymentGates(input: {
  intent: BookingPaymentIntent;
  rules: Record<string, string>;
  channelType: 'WALK_IN' | 'OTA';
  paymentResponsibility: 'HOTEL_COLLECT' | 'OTA_COLLECT';
  paymentMethod: string | null;
  evidencePath: string | null;
  childOrdinaryTotal: number;
  filePresent: boolean;
}): { missing: string[]; hardReject?: { status: number; code: string; message: string } } {
  const missing: string[] = [];
  const intent = input.intent;
  const rules = input.rules || {};
  const ota = input.paymentResponsibility === 'OTA_COLLECT';

  // HOTEL_COLLECT + UNPAID + uploaded receipt file → 400 before any write.
  // (OTA_COLLECT + UNPAID + file is still the OTA voucher path, not a receipt.)
  if (
    intent.mode === 'UNPAID' &&
    !ota &&
    input.filePresent
  ) {
    return {
      missing,
      hardReject: {
        status: 400,
        code: 'UNPAID_WITH_RECEIPT_CONFLICT',
        message:
          'UNPAID (Belum Bayar) tidak boleh disertai upload bukti/DP receipt pada hotel-collect booking; ' +
          'hapus file atau ubah payment_mode'
      }
    };
  }

  // OTA positive ordinary/DP conflict: OTA_COLLECT is voucher-only, no hotel cash.
  if (ota) {
    const positiveOrdinary =
      (intent.mode === 'PAY_BILL' && intent.ordinaryAmount > 0) ||
      input.childOrdinaryTotal > 0;
    const positiveDp = intent.mode === 'ADVANCE_PAYMENT' && intent.advanceAmount > 0;
    if (positiveOrdinary || positiveDp) {
      const sources: string[] = [];
      if (positiveOrdinary) sources.push('nominal ordinary (amount_paid / reservations[i].amount_paid)');
      if (positiveDp) sources.push('advance_amount');
      return {
        missing,
        hardReject: {
          status: 400,
          code: 'OTA_COLLECT_PAYMENT_CONFLICT',
          message:
            `OTA_COLLECT hanya menerima voucher/bukti OTA; menolak nominal hotel: ${sources.join(', ')}. ` +
            'Pindahkan pembayaran hotel ke jalur booking hotel-collect atau hapus nominal tersebut.'
        }
      };
    }
  }

  // Cash-now per explicit mode.
  let cashNow = 0;
  if (intent.mode === 'PAY_BILL') cashNow = intent.ordinaryAmount;
  else if (intent.mode === 'ADVANCE_PAYMENT') cashNow = intent.advanceAmount;
  // UNPAID / LEGACY handled below via legacy fields.

  if (rules['payment_method'] === 'REQUIRED') {
    if (ota) {
      // OTA_COLLECT bypasses the hotel's REQUIRED property rule entirely.
      // (Legacy OTA production already handles this via its own block.)
    } else if (input.paymentMethod == null) {
      // Fix #3: explicit UNPAID or PAY_BILL with cashNow=0 must NOT bypass the
      // REQUIRED rule just because no cash was collected. The property rule
      // still applies — method is required for the booking record.
      if (cashNow > 0) {
        // Normal cash-now case: method is required because cash was collected.
        missing.push('payment_method');
      } else if (intent.legacy) {
        // Legacy: raw fields may carry the method; already checked via input.paymentMethod.
        missing.push('payment_method');
      } else {
        // Explicit UNPAID / PAY_BILL with cashNow=0: REQUIRED property still applies.
        missing.push('payment_method');
      }
    }
  }

  if (rules['payment_amount'] === 'REQUIRED') {
    // UNPAID never satisfies REQUIRED; DP positive satisfies via cash-now.
    const paidNow = intent.legacy
      ? (intent.ordinaryAmount > 0 || input.childOrdinaryTotal > 0)
      : cashNow > 0;
    if (!ota && !paidNow) missing.push('payment_amount');
  }

  if (rules['payment_evidence'] === 'REQUIRED') {
    const needsEvidence = intent.legacy
      ? (intent.ordinaryAmount > 0 || input.childOrdinaryTotal > 0)
      : cashNow > 0;
    if (!ota && needsEvidence && !input.evidencePath && !input.filePresent) {
      missing.push('payment_evidence');
    }
  }

  return { missing };
}

// ── 4. Ordinary payment plan (before writers) ────────────────────────────────

export function buildOrdinaryPaymentPlan(input: BookingPaymentPlanInput): OrdinaryPaymentPlan {
  // Fix #5: evidencePath silently dropped guard for ordinary path too.
  const hasOrdPath = input.evidencePath != null && String(input.evidencePath).trim().length > 0;
  if (hasOrdPath && input.file != null) {
    throw httpError(
      400,
      'Ordinary payment evidence: both evidencePath and uploaded file are present; ambiguous source. ' +
      'Provide exactly one evidence source (file upload OR path reference, not both).',
      'ORDINARY_EVIDENCE_AMBIGUOUS'
    );
  }
  // Path-only evidence (hasPath && !hasFile) is silently dropped in the current
  // ordinary flow because legacy handler may handle it. We do NOT reject here —
  // the existing legacy handler owns path-only handling. Only the DP path rejects.

  const intent = input.intent;
  if (intent.legacy) {
    const cash = Number(intent.ordinaryAmount || 0);
    return {
      bookingLevelCash: cash,
      useGroupPayment: cash > 0 && input.childCount >= 2,
      useBookingLevelPayment: cash > 0 || input.childCount === 0,
      method: intent.paymentMethod,
      evidencePath: intent.evidencePath
    };
  }
  if (intent.mode === 'PAY_BILL') {
    const cash = Number(intent.ordinaryAmount || 0);
    return {
      bookingLevelCash: cash,
      useGroupPayment: cash > 0 && input.childCount >= 2,
      useBookingLevelPayment: input.childCount >= 1,
      method: intent.paymentMethod,
      evidencePath: intent.evidencePath
    };
  }
  // ADVANCE_PAYMENT / UNPAID: no ordinary cash into booking/children.
  return {
    bookingLevelCash: 0,
    useGroupPayment: false,
    useBookingLevelPayment: false,
    method: intent.paymentMethod,
    evidencePath: intent.evidencePath
  };
}

// ── 5. DP receipt plan (after children, before COMMIT) ──────────────────────

export function buildDpReceiptPlan(
  input: BookingPaymentPlanInput,
  requestKey: string | null,
  insertedChildren: Array<{ id: number; stay_sequence?: number; booking_id?: number }>
): DpReceiptPlan {
  const intent = input.intent;
  if (intent.mode !== 'ADVANCE_PAYMENT') {
    throw httpError(400, 'DP receipt plan only for ADVANCE_PAYMENT', 'ADVANCE_RECEIPT_MODE_INVALID');
  }
  const amount = requirePositiveInteger(intent.advanceAmount, 'advance_amount');
  if (!requestKey) {
    throw httpError(
      400,
      'ADVANCE_PAYMENT requires request_key (explicit mode); empty/missing key is not accepted',
      'DP_RECEIPT_KEY_REQUIRED'
    );
  }
  if (insertedChildren.length < 1) {
    throw httpError(400, 'DP receipt requires at least one inserted child reservation', 'DP_ANCHOR_MISSING');
  }

  // Use the authoritative parent and the complete server-inserted child set.
  if (!Number.isSafeInteger(input.bookingId) || input.bookingId <= 0) {
    throw httpError(400, 'Expected parent bookingId is invalid', 'DP_PARENT_BOOKING_INVALID');
  }
  if (!Number.isSafeInteger(input.childCount) || input.childCount < 1 ||
      input.childCount !== insertedChildren.length) {
    throw httpError(400, 'Inserted child count does not match booking plan', 'DP_CHILD_COUNT_MISMATCH');
  }
  for (const child of insertedChildren) {
    if (!Number.isSafeInteger(child.booking_id) || child.booking_id !== input.bookingId) {
      throw httpError(400, 'Inserted child does not belong to the expected parent', 'DP_CHILDREN_PARENT_MISMATCH');
    }
  }

  // Fix #5: DP evidencePath must not be silently dropped.
  // If a path-only evidence was sent but path-only is not yet supported, reject 400.
  // If both path and file are present, the ambiguity is a 400.
  const hasPath = input.evidencePath != null && String(input.evidencePath).trim().length > 0;
  const hasFile = input.file != null;
  if (hasPath && hasFile) {
    throw httpError(
      400,
      'DP evidence: both evidencePath and uploaded file are present; ambiguous source. ' +
      'Provide exactly one evidence source (file upload OR path reference, not both).',
      'DP_EVIDENCE_AMBIGUOUS'
    );
  }
  if (hasPath && !hasFile) {
    // Path-only evidence: not yet supported in this adapter path. Reject explicitly.
    throw httpError(
      400,
      'DP evidencePath (path-only reference) is not yet supported for quick-booking DP; ' +
      'upload the file directly or leave evidencePath empty',
      'DP_EVIDENCE_PATH_UNSUPPORTED'
    );
  }

  const sorted = insertedChildren.slice().sort((a, b) => {
    const seqA = Number(a.stay_sequence ?? 0);
    const seqB = Number(b.stay_sequence ?? 0);
    if (seqA !== seqB) return seqA - seqB;
    return Number(a.id) - Number(b.id);
  });
  const anchor = sorted[0];
  const scope: DepositScope = insertedChildren.length > 1 ? 'BOOKING_GROUP' : 'ROOM_RESERVATION';
  const idempotencyKey = deriveDpReceiptKey({
    propertyId: requirePositiveInteger(input.propertyId, 'property_id'),
    requestKey,
    intent
  });
  if (!idempotencyKey) {
    throw httpError(400, 'Failed to derive stable DP receipt key', 'DP_RECEIPT_KEY_DERIVE_FAILED');
  }
  // The existing upload policy must be supplied for every uploaded file.
  // Step 3: when preValidatedEvidence is provided (from preflight), use it directly
  // — the file was already validated once with the real upload policy.
  let evidence: EvidenceUpload | null = null;
  if (input.preValidatedEvidence != null) {
    evidence = input.preValidatedEvidence;
  } else if (input.file != null) {
    const validator = input.validateEvidenceUpload;
    if (typeof validator !== 'function') {
      throw httpError(400, 'Evidence upload validator is required', 'EVIDENCE_VALIDATOR_REQUIRED');
    }
    evidence = convertFileToEvidence(input.file, validator);
  }
  return {
    purpose: 'ADVANCE_PAYMENT',
    scope,
    anchorReservationId: Number(anchor.id),
    amount,
    method: validateDpReceiptMethod(intent.paymentMethod),
    idempotencyKey,
    actor: input.actor,
    evidence,
    evidenceNote: 'Bukti DP saat reservasi',
    notes: `Quick booking DP (${requestKey})`
  };
}

// ── 6. DP owner + call wrapper (used by index before COMMIT) ────────────────

export async function callDpReceiptInBookingTransaction(
  client: PoolClient,
  plan: DpReceiptPlan,
  deps: {
    receiveDepositInTransaction: (
      client: PoolClient,
      input: ReceiveDepositInput,
      owner?: EvidenceRegisteringOwner | undefined
    ) => Promise<any>;
    propertyId: number;
    savedEvidenceKeys: string[];
  }
): Promise<any> {
  const owner = {
    registerStorageKey(storageKey: string) {
      deps.savedEvidenceKeys.push(storageKey);
    },
    isOwnedByCaller: () => true
  };
  const evidence = plan.evidence ? {
    buffer: plan.evidence.buffer,
    mimetype: plan.evidence.mimetype,
    originalname: plan.evidence.originalname,
    size: plan.evidence.size
  } : null;
  return deps.receiveDepositInTransaction(client, {
    propertyId: deps.propertyId,
    reservationId: plan.anchorReservationId,
    amount: plan.amount,
    paymentMethod: plan.method,
    idempotencyKey: plan.idempotencyKey,
    purpose: plan.purpose,
    scope: plan.scope,
    actor: plan.actor,
    evidence: evidence ?? undefined,
    evidenceNote: plan.evidenceNote,
    notes: plan.notes
  }, owner);
}

// ── 7. Result metadata for canonical explicit DP ────────────────────────────

export function buildDpResultMetadata(
  intent: BookingPaymentIntent,
  dpResult: any,
  plan: DpReceiptPlan
): Record<string, unknown> | null {
  if (intent.mode !== 'ADVANCE_PAYMENT' || !dpResult) return null;
  const deposit = dpResult.deposit ?? dpResult;
  return {
    deposit_id: deposit?.id ?? null,
    deposit_number: deposit?.deposit_number ?? null,
    deposit_payment_id: dpResult.payment?.id ?? null,
    deposit_amount: plan.amount,
    deposit_purpose: plan.purpose,
    deposit_scope: plan.scope,
    deposit_reservation_id: plan.anchorReservationId,
    deposit_method: plan.method,
    deposit_idempotency_key: plan.idempotencyKey,
    deposit_replayed: Boolean(dpResult.idempotent_replay)
  };
}

export interface DpReceiptPlan {
  purpose: 'ADVANCE_PAYMENT';
  scope: DepositScope;
  /** Anchor reservationId (deterministic stay_sequence then id). */
  anchorReservationId: number;
  amount: number;
  method: string;
  idempotencyKey: string;
  actor: DepositActor;
  /** req.file evidence already converted + validated (null when no file). */
  evidence: EvidenceUpload | null;
  evidenceNote: string | null;
  /** Property-local notes for audit (not a client path). */
  notes: string;
}

export interface BookingPaymentPlanInput {
  intent: BookingPaymentIntent;
  propertyId: number;
  /** Expected parent bookingId that inserted children must belong to (fix #6). */
  bookingId: number;
  rules: Record<string, string>;
  channelType: 'WALK_IN' | 'OTA';
  paymentResponsibility: 'HOTEL_COLLECT' | 'OTA_COLLECT';
  /** Alias method/evidence already resolved by accepted helper (null when absent). */
  paymentMethod: string | null;
  evidencePath: string | null;
  /** Child amount totals from raw payloads (legacy path). */
  childOrdinaryTotal: number;
  file: { buffer: Buffer; mimetype: string; originalname: string; size: number } | null;
  /**
   * Existing evidence upload validator. Required at runtime when file is present.
   * Optional only because a booking may have no uploaded evidence.
   */
  validateEvidenceUpload?: (f: {
    mimetype: string;
    size: number;
    originalname: string;
    buffer: Buffer;
  }) => { valid: boolean; error?: string | null; code?: string | null };
  /** Authenticated context actor. */
  actor: DepositActor;
  /** Header key raw. */
  headerKey: unknown;
  /** Body request_key raw. */
  bodyKey: unknown;
  /** Child count (reservations array length). */
  childCount: number;
  /**
   * Pre-validated evidence DTO from preflight (Step 3).
   * When set, convertFileToEvidence is skipped — evidence is already a valid
   * EvidenceUpload; raw-file path (input.file) is not used.
   */
  preValidatedEvidence?: EvidenceUpload | null;
}

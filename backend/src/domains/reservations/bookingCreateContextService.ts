/**
 * bookingCreateContextService.ts
 *
 * Unit 3A — Pure request-context helper for booking-create replay.
 * No queries, no storage, no network, no DB. Pure functions only.
 *
 * Public API:
 *  - resolveRequestKey(input)       → string | null
 *  - buildBookingCreateFingerprint(ctx) → string
 *  - buildEvidenceDescriptor(ev)   → Record<string, unknown>
 *  - deriveDpReceiptKey(input)     → string | null
 *
 * Domain errors: statusCode + code on the Error object.
 *
 * ── Design notes ──────────────────────────────────────────────────────────────
 * 1. resolveRequestKey:
 *    - two aliases: header `Idempotency-Key` (headerKey) and body `request_key`
 *      (bodyKey), both typed unknown.
 *    - explicit mode (explicit=true): at least one alias must carry a key;
 *      missing/blank/invalid → 400; two different nonblank aliases → 400;
 *      same-after-trim → one key.
 *    - legacy mode (explicit=false): both aliases absent/blank → null.
 *      Invalid type on a supplied alias → 400 (never silent).
 *    - Header array/object is rejected. No auto-generation.
 *
 * 2. buildBookingCreateFingerprint:
 *    - Accepts a PRE-NORMALIZED businessSnapshot (caller's responsibility).
 *    - The helper wraps the snapshot + payment intent + derived purpose/scope
 *      into an explicit envelope so callers cannot accidentally compute FP
 *      from snapshot alone and omit the intent.
 *    - ADVANCE: purpose=ADVANCE_PAYMENT, scope=ROOM_RESERVATION (1 child) or
 *      BOOKING_GROUP (>1 child).
 *    - Non-ADVANCE: purpose=null, scope=ROOM_RESERVATION (1 child) or
 *      BOOKING_GROUP (>1 child).
 *    - Delegates to computeBookingCreateFingerprint (accepted helper).
 *
 * 3. buildEvidenceDescriptor:
 *    - Pure: SHA-256 of bytes + MIME + byteLength. No file I/O, no GCS.
 *    - Input: { bytes: Buffer, mime?: string, declaredSize?: number, filename?: string }
 *    - declaredSize mismatch vs bytes.length → 400.
 *    - Invalid shape (bytes not Buffer/Uint8Array) → 400.
 *
 * 4. deriveDpReceiptKey:
 *    - Stable namespace-separated receipt key for DP receipts.
 *    - Input: { propertyId, requestKey, intent } where intent.mode === ADVANCE.
 *    - Returns null for non-ADVANCE or missing requestKey.
 *    - Format: "dp:" + SHA256hex(propertyId + "|" + requestKey).slice(0, N)
 *    - Total length ≤ 150 characters.
 *    - Does NOT create a receipt; does NOT allow DP without a key.
 */

import crypto from 'node:crypto';
import type { BookingPaymentIntent } from './bookingPaymentIntentService';
import { computeBookingCreateFingerprint } from './bookingCreateRequestService';

// ── Domain error helper (consistent with bookingCreateRequestService) ───────
function domainError(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

// ── 1. resolveRequestKey ──────────────────────────────────────────────────────

export interface ResolveRequestKeyInput {
  /** Raw value from HTTP header `Idempotency-Key` (unknown). */
  headerKey: unknown;
  /** Raw value from body field `request_key` (unknown). */
  bodyKey: unknown;
  /**
   * true  → explicit booking-create mode: key is required.
   * false → legacy mode: key is optional; returns null when both are blank.
   */
  explicit: boolean;
}

/**
 * Normalizes null/undefined/'' to "absent".
 * Only string-typed values pass through (trimmed).
 * All supplied non-string values (number, boolean, array, object, function,
 * symbol, bigint) → domain 400 REQUEST_KEY_TYPE_INVALID.
 * Returns trimmed string or null when absent/blank.
 */
function normalizeKeyValue(raw: unknown, label: string): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    const typeName = Array.isArray(raw) ? 'array' : (typeof raw === 'object' && raw !== null) ? (raw as Record<string, unknown>).constructor?.name ?? 'object' : String(typeof raw);
    throw domainError(400, 'REQUEST_KEY_TYPE_INVALID',
      `${label} harus string atau kosong (got ${typeName})`);
  }
  const s = raw.trim();
  return s.length > 0 ? s : null;
}

/** Validates final key format: 1–200 chars, [a-zA-Z0-9._-] only. */
function validateKeyFormat(key: string): void {
  if (key.length < 1 || key.length > 200) {
    throw domainError(400, 'REQUEST_KEY_INVALID',
      `request_key harus 1–200 karakter (got ${key.length})`);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(key)) {
    throw domainError(400, 'REQUEST_KEY_INVALID',
      'request_key hanya boleh alfanumerik, titik, underscore, hyphen');
  }
}

/**
 * Resolves the effective request key from two alias sources.
 * Returns the trimmed key string, or null when legacy mode and no key supplied.
 * Throws domain 400 on type-invalid or conflicting aliases.
 */
export function resolveRequestKey(input: ResolveRequestKeyInput): string | null {
  const h = normalizeKeyValue(input.headerKey, 'Idempotency-Key');
  const b = normalizeKeyValue(input.bodyKey, 'request_key');

  // Both absent
  if (h === null && b === null) {
    if (input.explicit) {
      throw domainError(400, 'REQUEST_KEY_REQUIRED',
        'request_key wajib diisi dalam explicit booking-create mode');
    }
    return null;
  }

  // Both present and nonblank
  if (h !== null && b !== null) {
    if (h !== b) {
      throw domainError(400, 'REQUEST_KEY_CONFLICT',
        `Idempotency-Key dan request_key berbeda: "${h}" vs "${b}"`);
    }
    validateKeyFormat(h);
    return h;
  }

  // Exactly one present
  const key = h !== null ? h : b!;
  validateKeyFormat(key);
  return key;
}

// ── 2. buildBookingCreateFingerprint ─────────────────────────────────────────

export interface BookingFingerprintContext {
  /** Pre-normalized business snapshot (booking/children/date/rate/discount/charges/OTA). */
  businessSnapshot: Record<string, unknown>;
  /** Normalized payment intent from bookingPaymentIntentService. */
  intent: BookingPaymentIntent;
  /** Positive property ID. */
  propertyId: number;
  /** Number of child reservations (≥ 0). Used to derive scope. */
  childCount: number;
  /** Optional evidence descriptor (output of buildEvidenceDescriptor). */
  evidenceDescriptor?: Record<string, unknown> | null;
}

/**
 * Derives purpose and scope from the intent + childCount.
 * - ADVANCE → purpose ADVANCE_PAYMENT; scope ROOM_RESERVATION (childCount===1)
 *   or BOOKING_GROUP (childCount>1).
 * - Non-ADVANCE → purpose null; scope follows the same childCount rule.
 */
function derivePurposeAndScope(
  intent: BookingPaymentIntent,
  childCount: number
): { purpose: string | null; scope: string } {
  const isAdvance = intent.mode === 'ADVANCE_PAYMENT';
  const purpose: string | null = isAdvance ? 'ADVANCE_PAYMENT' : null;
  const scope: string = childCount > 1 ? 'BOOKING_GROUP' : 'ROOM_RESERVATION';
  return { purpose, scope };
}

/**
 * Builds the full fingerprint envelope and computes FP via
 * computeBookingCreateFingerprint (accepted helper from Unit 2).
 *
 * The envelope explicitly embeds the normalized intent fields so that
 * changing the intent (even with identical businessSnapshot) changes FP.
 *
 * Does NOT mutate input. Does NOT reconstruct raw payloads or price math.
 */
export function buildBookingCreateFingerprint(ctx: BookingFingerprintContext): string {
  // U3A-F04: childCount must be integer >= 1 (not >= 0).
  if (!Number.isInteger(ctx.childCount) || ctx.childCount < 1) {
    throw domainError(400, 'CHILD_COUNT_INVALID',
      `childCount harus integer >= 1 (got ${String(ctx.childCount)})`);
  }
  if (!Number.isInteger(ctx.propertyId) || ctx.propertyId <= 0) {
    throw domainError(400, 'PROPERTY_ID_INVALID',
      `propertyId harus positive integer (got ${String(ctx.propertyId)})`);
  }

  const { purpose, scope } = derivePurposeAndScope(ctx.intent, ctx.childCount);

  // UNPAID + evidenceDescriptor → 400 conflict (pure normalizer; no file check)
  if (ctx.intent.mode === 'UNPAID' && ctx.evidenceDescriptor != null) {
    throw domainError(400, 'UNPAID_EVIDENCE_CONFLICT',
      'UNPAID (Belum Bayar) tidak boleh disertai evidence upload');
  }

  // U3A-F02: businessSnapshot is stored as a nested field, NOT spread into the
  // envelope. The generated _fp_context is a separate sibling, so a caller
  // snapshot that happens to contain a key named "_fp_context" cannot
  // overwrite the generated context.
  //
  // U3A-F01: evidenceDescriptor in the FP uses only sha256 + byteLength + mime
  // (filename is audit metadata, not a binding identity). Same bytes + same
  // MIME + same size → same FP regardless of filename.
  const evidenceFp = ctx.evidenceDescriptor != null
    ? {
        sha256:     ctx.evidenceDescriptor.sha256 ?? null,
        byteLength: ctx.evidenceDescriptor.byteLength ?? null,
        mime:       ctx.evidenceDescriptor.mime ?? null,
      }
    : null;

  const envelope: Record<string, unknown> = {
    businessSnapshot: ctx.businessSnapshot,
    _fp_context: {
      propertyId: ctx.propertyId,
      childCount: ctx.childCount,
      intent: {
        mode: ctx.intent.mode,
        ordinaryAmount: ctx.intent.ordinaryAmount,
        advanceAmount: ctx.intent.advanceAmount,
        paymentMethod: ctx.intent.paymentMethod,
        evidencePath: ctx.intent.evidencePath,
      },
      purpose,
      scope,
      evidenceDescriptor: evidenceFp,
    },
  };

  return computeBookingCreateFingerprint(envelope);
}

// ── 3. buildEvidenceDescriptor ────────────────────────────────────────────────

export interface EvidenceUploadInput {
  /** Raw file bytes. Must be Buffer or Uint8Array. */
  bytes: Buffer | Uint8Array;
  /** MIME type (e.g. "application/pdf"). Optional; included in descriptor. */
  mime?: string;
  /** Client-declared file size in bytes. Must match bytes.length when provided. */
  declaredSize?: number;
  /** Filename for reference (NOT used as sole identity; bytes + MIME are primary). */
  filename?: string;
}

/**
 * Computes a deterministic evidence descriptor for the fingerprint envelope.
 *
 * - SHA-256 hex of the file bytes (primary identity).
 * - mime and declaredSize are included for context.
 * - filename is included for reference but is NOT the sole identifier:
 *   same bytes + different filename → same descriptor (filename is a hint,
 *   not a binding contract); different bytes + same filename → different hash.
 * - Does NOT save/read files, call GCS, or use UUID/timestamp/correlation IDs.
 * - Declared size mismatch vs actual bytes.length → 400.
 * - Invalid bytes shape → 400.
 */
export function buildEvidenceDescriptor(input: EvidenceUploadInput): Record<string, unknown> {
  const raw = input.bytes;

  // Validate bytes shape
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    throw domainError(400, 'EVIDENCE_BYTES_INVALID',
      'bytes harus Buffer atau Uint8Array');
  }
  if (!Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) {
    const typeName = raw !== null && typeof raw === 'object' ? (raw as any).constructor?.name ?? 'object' : typeof raw;
    throw domainError(400, 'EVIDENCE_BYTES_INVALID',
      `bytes harus Buffer atau Uint8Array (got ${typeName})`);
  }

  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const byteLength = buf.length;

  // Validate declared size when provided
  if (input.declaredSize !== undefined) {
    if (!Number.isInteger(input.declaredSize) || input.declaredSize < 0) {
      throw domainError(400, 'EVIDENCE_SIZE_INVALID',
        `declaredSize harus non-negatif integer (got ${String(input.declaredSize)})`);
    }
    if (input.declaredSize !== byteLength) {
      throw domainError(400, 'EVIDENCE_SIZE_MISMATCH',
        `declaredSize (${input.declaredSize}) tidak sama dengan bytes.length (${byteLength})`);
    }
  }

  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

  return {
    sha256,
    byteLength,
    mime: input.mime ?? null,
    filename: input.filename ?? null,
  };
}

// ── 4. deriveDpReceiptKey ────────────────────────────────────────────────────

export interface DpReceiptKeyInput {
  propertyId: number;
  /** The effective request key (trimmed, validated). */
  requestKey: string;
  intent: BookingPaymentIntent;
}

const DP_KEY_NAMESPACE = 'dp';
const DP_KEY_PREFIX_LEN = 3; // "dp:"
const DP_KEY_HASH_LEN = 144; // "dp:" + 144 hex = 147 total chars (≤ 150)

/**
 * Derives a stable, namespace-separated idempotency key for DP receipt calls.
 *
 * - Returns null when intent.mode !== 'ADVANCE_PAYMENT' or requestKey is null/empty.
 * - Format: "dp:" + SHA-256-hex(propertyId + "|" + requestKey, 144 chars)
 *   Total: 3 + 144 = 147 characters (≤ 150 core deposit limit).
 * - Deterministic: same inputs → same key. No time, no random.
 * - Does NOT create a receipt row; the caller invokes the DP receipt service.
 * - The key is separate from the booking request key namespace.
 */
export function deriveDpReceiptKey(input: DpReceiptKeyInput): string | null {
  if (input.intent.mode !== 'ADVANCE_PAYMENT') return null;
  if (!input.requestKey || input.requestKey.length === 0) return null;

  if (!Number.isInteger(input.propertyId) || input.propertyId <= 0) {
    throw domainError(400, 'DP_KEY_PROPERTY_INVALID',
      `propertyId harus positive integer untuk DP key (got ${String(input.propertyId)})`);
  }

  const tuple = `${input.propertyId}|${input.requestKey}`;
  const hash = crypto.createHash('sha256').update(tuple, 'utf8').digest('hex');
  return DP_KEY_NAMESPACE + ':' + hash.slice(0, DP_KEY_HASH_LEN);
}

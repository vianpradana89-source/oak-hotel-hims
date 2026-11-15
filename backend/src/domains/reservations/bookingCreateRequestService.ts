/**
 * bookingCreateRequestService.ts
 *
 * Domain replay storage for canonical booking create (Phase 2B-1 Unit 2).
 *
 * CONTRACT:
 * - All functions accept a caller-owned PoolClient (client.query is the
 *   transaction boundary managed by the caller).
 * - No pool.connect(), no BEGIN/COMMIT/ROLLBACK, no client.release().
 * - No schema auto-creation.
 * - Authorization (property binding, RBAC) MUST be completed by the caller
 *   BEFORE invoking claimBookingCreateRequest or finalizeBookingCreateRequest.
 * - The caller serialises concurrency via the caller's advisory lock or
 *   the caller's transaction; this module does NOT acquire pg_advisory_xact_lock
 *   itself — it relies on the caller's unique constraint + the caller's lock.
 *
 * Storage: booking_create_requests (additive DDL — see draft file, NOT executed here).
 *
 * Replay semantics:
 *   Same (property_id, request_key) + same fingerprint + COMPLETE result
 *     → return stored result, do NOT create new booking/money/file.
 *   Same (property_id, request_key) + DIFFERENT fingerprint
 *     → 409 BOOKING_CREATE_REPLAY_MISMATCH.
 *   Same (property_id, request_key) + INCOMPLETE state (no booking_id yet,
 *     or result_status not FINAL)
 *     → 409 BOOKING_CREATE_REQUEST_INCOMPLETE — caller must retry with the
 *       same key; no automatic new key, no timeout/polling.
 */

import type { PoolClient } from 'pg';
import crypto from 'node:crypto';

// ── Error codes ───────────────────────────────────────────────────────────────
const E_MISSING_KEY = 'BOOKING_CREATE_KEY_REQUIRED';
const E_INVALID_KEY = 'BOOKING_CREATE_KEY_INVALID';
const E_INVALID_PROPERTY = 'BOOKING_CREATE_PROPERTY_INVALID';
const E_MISMATCH = 'BOOKING_CREATE_REPLAY_MISMATCH';
const E_INCOMPLETE = 'BOOKING_CREATE_REQUEST_INCOMPLETE';
const E_INVALID_STATE = 'BOOKING_CREATE_INVALID_STATE';

export function domainError(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BookingCreateRequestSnapshot {
  /** Deterministic business snapshot; must NOT contain random timestamps or correlation IDs. */
  fingerprintSource: Record<string, unknown>;
  /** Normalized payment intent (from bookingPaymentIntentService). */
  paymentIntent: Record<string, unknown>;
}

export interface BookingCreateReplayResult {
  /** true when the request was replayed from storage (no new booking created). */
  replayed: boolean;
  /** booking_id when the request reached a complete FINAL state. */
  bookingId: number | null;
  /** Stored response snapshot (for replay). */
  result: Record<string, unknown> | null;
  /** The request_key used. */
  requestKey: string;
  /**
   * Unit 3C-01 extension: the stored HTTP status code (response_status column,
   * validated 200–399 by the authoritative FINAL validator before this field
   * is returned). The SELECT already fetched the column; this surfaces it to
   * the replay DTO without a new query and without a default that would
   * override the stored value.
   */
  responseStatus: number;
}

export interface ClaimResult {
  /** true when a new request row was created; false when an existing row was found. */
  claimed: boolean;
  /** The stored request row (always set). */
  row: Record<string, unknown>;
}

// ── Fingerprint ───────────────────────────────────────────────────────────────

/**
 * Canonical JSON stringify with sorted object keys.
 * Used by finalizeBookingCreateRequest to compare result snapshots regardless
 * of key insertion order. Nested objects are sorted recursively; array order
 * is preserved (meaningful in business context).
 *
 * Exported so tests use the same production helper (BU-R2-01 requirement).
 */
export function canonicalJsonStringify(v: unknown): string {
  function canon(val: unknown): string {
    if (val === undefined) return 'undefined';
    if (val === null) return 'null';
    if (typeof val === 'number') {
      if (!Number.isFinite(val)) throw domainError(400, 'BOOKING_CREATE_FP_NONFINITE',
        `canonicalJsonStringify: angka non-finit tidak didukung (got ${val})`);
      return String(val);
    }
    if (typeof val === 'string' || typeof val === 'boolean') {
      return JSON.stringify(val);
    }
    if (Array.isArray(val)) {
      return '[' + val.map(item => canon(item)).join(',') + ']';
    }
    if (typeof val === 'object' && val !== null) {
      const obj = val as Record<string, unknown>;
      const proto = Object.getPrototypeOf(obj);
      if (proto !== null && proto !== Object.prototype) {
        throw domainError(400, 'BOOKING_CREATE_FP_UNSUPPORTED',
          'canonicalJsonStringify: nilai non-plain object (class instance/Date/Map/Set) tidak didukung');
      }
      const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
      return '{' + keys.map(k => JSON.stringify(k) + ':' + canon(obj[k])).join(',') + '}';
    }
    throw domainError(400, 'BOOKING_CREATE_FP_UNSUPPORTED',
      `canonicalJsonStringify: tipe tidak didukung (got ${typeof val})`);
  }
  return canon(v);
}

/**
 * Computes a deterministic SHA-256 fingerprint from a business snapshot.
 *
 * Rules:
 * - Object keys are sorted lexicographically before hashing (stability).
 * - Array order is preserved (children order is meaningful).
 * - String values are NOT coerced to numbers (phone/identity fields intact).
 * - Numbers are serialised via Number.toString() (deterministic for safe ints).
 * - Explicit `null` is preserved (serialized as JSON null); `undefined` is
 *   dropped per JSON contract. `computeFP({phone:null})` ≠ `computeFP({})`.
 * - The caller MUST include all business-relevant fields in the snapshot,
 *   INCLUDING normalized payment intent (mode, purpose, scope, amount).
 *   Omitting a field changes the fingerprint: a caller that drops
 *   `paymentIntent` from the snapshot cannot then pass a different
 *   `paymentIntent` value under the same stored FP.
 * - Non-finite numbers (NaN/±Infinity), functions, and non-plain objects are
 *   rejected with a domain 400 error — they must not produce a valid-looking
 *   business fingerprint.
 * - Cyclic structures are rejected with a clear 400 error.
 */
export function computeBookingCreateFingerprint(
  snapshot: Record<string, unknown>
): string {
  function canon(v: unknown, path: string, seen: Set<unknown>): string {
    // undefined at top level is not expected (filter keys in canon); sentinel for safety
    if (v === undefined) return '\u2205';
    if (v === null) return 'null';   // explicit null preserved: {phone:null} ≠ {phone:undefined/dropped}
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) {
        throw domainError(400, 'BOOKING_CREATE_FP_NONFINITE',
          `fingerprint ${path}: angka non-finit tidak didukung (got ${v})`);
      }
      return String(v);
    }
    if (typeof v === 'string' || typeof v === 'boolean') {
      return JSON.stringify(v);
    }
    if (typeof v === 'function') {
      throw domainError(400, 'BOOKING_CREATE_FP_UNSUPPORTED',
        `fingerprint ${path}: fungsi tidak didukung dalam snapshot bisnis`);
    }
    if (Array.isArray(v)) {
      if (seen.has(v)) throw domainError(400, 'BOOKING_CREATE_FP_CYCLIC', `fingerprint ${path}: struktur siklik terdeteksi`);
      seen.add(v);
      const out = `[${v.map((item, i) => canon(item, `${path}[${i}]`, seen)).join(',')}]`;
      seen.delete(v);
      return out;
    }
    if (typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      const proto = Object.getPrototypeOf(obj);
      // BU-R2-02: reject Date, Map, Set, and class instances (BU-R2-02)
      if (proto !== null && proto !== Object.prototype) {
        throw domainError(400, 'BOOKING_CREATE_FP_UNSUPPORTED',
          `fingerprint ${path}: nilai ${proto.constructor?.name ?? 'non-plain'} tidak didukung; hanya plain object JSON`);
      }
      if (seen.has(obj)) throw domainError(400, 'BOOKING_CREATE_FP_CYCLIC', `fingerprint ${path}: struktur siklik terdeteksi`);
      seen.add(obj);
      const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
      const out = `{${keys.map(k => `${JSON.stringify(k)}:${canon(obj[k], `${path}.${k}`, seen)}`).join(',')}}`;
      seen.delete(obj);
      return out;
    }
    throw domainError(400, 'BOOKING_CREATE_FP_UNSUPPORTED',
      `fingerprint ${path}: tipe tidak didukung (got ${typeof v})`);
  }
  const seen = new Set<unknown>();
  const canonical = canon(snapshot, '$', seen);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ── Validation helpers ────────────────────────────────────────────────────────

/**
 * Validates and normalizes the request key.
 * BU-R2-03: guard unknown/non-string types BEFORE calling .trim()
 * to return domain 400 instead of raw TypeError.
 */
function validateRequestKey(rawKey: unknown): string {
  if (typeof rawKey !== 'string') {
    throw domainError(400, E_INVALID_KEY,
      `request_key harus string (got ${typeof rawKey === 'undefined' ? 'undefined' : typeof rawKey})`);
  }
  const key = rawKey;
  const trimmed = key.trim();
  if (!trimmed) {
    throw domainError(400, E_MISSING_KEY, 'request_key is required for explicit booking-create mode');
  }
  if (trimmed.length > 200 || trimmed.length < 1) {
    throw domainError(400, E_INVALID_KEY, `request_key must be 1–200 characters (got length ${trimmed.length})`);
  }
  // Allow only safe characters (no SQL injection vector through the key value).
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    throw domainError(400, E_INVALID_KEY, 'request_key contains invalid characters; use alphanumeric, dot, underscore, hyphen only');
  }
  return trimmed;
}

function validatePropertyId(propertyId: number): void {
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw domainError(400, E_INVALID_PROPERTY, `property_id must be a positive integer (got: ${propertyId})`);
  }
}

// ── Row validator (authoritative, used by both primary lookup and reread) ────

interface ExpectedBinding {
  fingerprint: string;
  fingerprintVersion: number;
}

/**
 * Validates a stored row against the expected binding + state contract.
 *  - fingerprint mismatch (value or version) → 409 E_MISMATCH
 *  - PENDING (incomplete by definition)        → 409 E_INCOMPLETE
 *  - FINAL but missing/invalid result/booking_id/response_status/finalized_at
 *    → 409 E_INCOMPLETE
 *  - FINAL + complete                          → returns the row with replayed=true
 *  - any other status                          → 409 E_INVALID_STATE
 *
 * BU-R2-04: the SELECT feeding this validator must include `finalized_at`
 * and `response_status` so the FINAL completeness check is authoritative.
 */
function validateStoredRow(
  row: Record<string, unknown>,
  expected: ExpectedBinding,
  requestKey: string
): Record<string, unknown> {
  const rowStatus = String(row.status || '');
  const storedFp = String(row.fingerprint || '');
  const storedVer = Number(row.fingerprint_version || 0);

  if (storedFp !== expected.fingerprint || storedVer !== expected.fingerprintVersion) {
    throw domainError(409, E_MISMATCH,
      `request_key "${requestKey}" fingerprint mismatch (stored fp=${storedFp.slice(0, 12)} v${storedVer}, expected ${expected.fingerprint.slice(0, 12)} v${expected.fingerprintVersion})`);
  }

  if (rowStatus === 'PENDING') {
    // PENDING = in-progress; not replayable
    throw domainError(409, E_INCOMPLETE,
      `request_key "${requestKey}" masih PENDING (in-progress); retry dengan key yang sama`);
  }

  if (rowStatus === 'FINAL') {
    // BU-R2-04: authoritative FINAL completeness — result must be a plain JSON
    // object (not primitive/null/array), booking_id positive, finalized_at
    // present, response_status in 200–399. Used by all four read paths.
    const result = row.result;
    if (result === null || result === undefined || typeof result !== 'object' || Array.isArray(result) ||
        Object.getPrototypeOf(result) !== Object.prototype) {
      throw domainError(409, E_INCOMPLETE,
        `FINAL request "${requestKey}" has incomplete stored result (result must be a plain JSON object)`);
    }
    const bookingIdNum = Number(row.booking_id);
    if (row.booking_id == null || !Number.isInteger(bookingIdNum) || bookingIdNum <= 0) {
      throw domainError(409, E_INCOMPLETE,
        `FINAL request "${requestKey}" has missing/invalid booking_id (got ${String(row.booking_id)})`);
    }
    if (row.finalized_at === null || row.finalized_at === undefined) {
      throw domainError(409, E_INCOMPLETE,
        `FINAL request "${requestKey}" missing finalized_at (DDL contract violation)`);
    }
    const respStatusNum = Number(row.response_status);
    if (row.response_status == null || !Number.isInteger(respStatusNum) || respStatusNum < 200 || respStatusNum > 399) {
      throw domainError(409, E_INCOMPLETE,
        `FINAL request "${requestKey}" has invalid/missing response_status (got ${String(row.response_status)}; contract requires 200-399)`);
    }
    return { ...row, replayed: true };
  }

  throw domainError(409, E_INVALID_STATE,
    `request_key "${requestKey}" is in unexpected state "${rowStatus}"`);
}

// ── Fingerprint format validation ────────────────────────────────────────────

const FP_HEX64_RE = /^[a-f0-9]{64}$/;

function validateFingerprintFormat(fp: string): void {
  if (typeof fp !== 'string' || !FP_HEX64_RE.test(fp)) {
    throw domainError(400, 'BOOKING_CREATE_FP_FORMAT',
      `fingerprint harus SHA-256 hex64 lowercase (got: ${String(fp).slice(0, 32)}...)`);
  }
}

function validateFingerprintVersion(v: number): void {
  if (!Number.isInteger(v) || v <= 0) {
    throw domainError(400, 'BOOKING_CREATE_FP_VERSION_INVALID',
      `fingerprint_version harus integer > 0 (got: ${v})`);
  }
}

function validateResultObject(result: unknown): void {
  if (result === null || result === undefined || typeof result !== 'object' || Array.isArray(result)) {
    throw domainError(400, 'BOOKING_CREATE_RESULT_INVALID',
      'result harus plain object JSON (bukan array, bukan null, bukan primitive)');
  }
}

/** HTTP response status must be 2xx-3xx success code (per API contract). */
function validateResponseStatus(code: number): void {
  if (!Number.isInteger(code) || code < 200 || code > 399) {
    throw domainError(400, 'BOOKING_CREATE_RESPONSE_STATUS_INVALID',
      `response_status harus integer 200-399 (got: ${code})`);
  }
}

// ── Core helpers ──────────────────────────────────────────────────────────────

/**
 * Claims or retrieves a booking-create request row within the caller's transaction.
 *
 * - If no row exists for (property_id, request_key): inserts a PENDING row and returns { claimed: true }.
 * - If a row exists with status PENDING: → 409 E_INCOMPLETE (in-progress; caller retries with same key).
 * - If a row exists with status FINAL + complete result + matching FP: returns replay.
 * - If a row exists with a mismatched fingerprint/version: → 409 E_MISMATCH.
 *
 * The caller must hold a pg_advisory_xact_lock on the request key before
 * calling this function to serialise concurrent claims.
 */
export async function claimBookingCreateRequest(
  client: PoolClient,
  input: {
    propertyId: number;
    requestKey: string;
    /** Pre-computed deterministic fingerprint. */
    fingerprint: string;
    /** Fingerprint version (increment when the snapshot shape changes). */
    fingerprintVersion: number;
    /** Normalized payment intent (stored for audit in the row, NOT part of FP hash).
     *  The caller MUST also include all payment-intent fields (mode, purpose,
     *  scope, amount) in the fingerprintSource snapshot passed to
     *  computeBookingCreateFingerprint so that a changed intent changes the FP.
     *  The service stores this separately for audit readability. */
    paymentIntent?: Record<string, unknown>;
  }
): Promise<ClaimResult> {
  const propertyId = input.propertyId;
  const requestKey = validateRequestKey(input.requestKey);
  validatePropertyId(propertyId);
  validateFingerprintFormat(input.fingerprint);
  validateFingerprintVersion(input.fingerprintVersion);

  const expected: ExpectedBinding = {
    fingerprint: input.fingerprint,
    fingerprintVersion: input.fingerprintVersion,
  };

  // Check existing row
  const existing = await client.query(
    `SELECT id, property_id, request_key, status, fingerprint, fingerprint_version,
            payment_intent, booking_id, result, response_status, finalized_at
     FROM booking_create_requests
     WHERE property_id = $1 AND request_key = $2`,
    [propertyId, requestKey]
  );

  if ((existing.rowCount ?? 0) > 0) {
    const row = existing.rows[0] as Record<string, unknown>;
    // Authoritative row validation (same path as conflict reread)
    const validated = validateStoredRow(row, expected, requestKey);
    return { claimed: false, row: validated };
  }

  // New claim: insert PENDING row
  const insertRes = await client.query(
    `INSERT INTO booking_create_requests
       (property_id, request_key, status, fingerprint, fingerprint_version,
        payment_intent, created_at, updated_at)
     VALUES ($1, $2, 'PENDING', $3, $4, $5, NOW(), NOW())
     ON CONFLICT (property_id, request_key) DO NOTHING
     RETURNING *`,
    [
      propertyId,
      requestKey,
      input.fingerprint,
      input.fingerprintVersion,
      input.paymentIntent ? JSON.stringify(input.paymentIntent) : null
    ]
  );

  if ((insertRes.rowCount ?? 0) === 0) {
    // Lost the race (another transaction inserted between our SELECT and INSERT).
    // Re-read to get the winner's row, validated through the same authoritative path.
    const reread = await client.query(
      `SELECT id, property_id, request_key, status, fingerprint, fingerprint_version,
              payment_intent, booking_id, result, response_status, finalized_at
       FROM booking_create_requests WHERE property_id = $1 AND request_key = $2`,
      [propertyId, requestKey]
    );
    if ((reread.rowCount ?? 0) === 0) {
      throw domainError(409, E_INVALID_STATE,
        `Failed to claim request_key "${requestKey}" (unexpected DB state)`);
    }
    const winnerRow = reread.rows[0] as Record<string, unknown>;
    const validated = validateStoredRow(winnerRow, expected, requestKey);
    return { claimed: false, row: validated };
  }

  return { claimed: true, row: insertRes.rows[0] as Record<string, unknown> };
}

/**
 * Finalizes a booking-create request: marks it FINAL and stores the result.
 *
 * Call this AFTER the booking + receipts + audit are all written successfully
 * within the same transaction. On failure the caller's transaction rolls back
 * automatically; no explicit ROLLBACK is issued here.
 *
 * Contract:
 * - PENDING row with matching expected claim (fingerprint+version) → UPDATE to FINAL.
 * - Already FINAL with same booking_id+result → idempotent, no error.
 * - Already FINAL with different booking_id or different result → 409 E_MISMATCH.
 * - No row or unknown state → 409 E_INCOMPLETE.
 *
 * The caller passes the expected fingerprint + version (the claim binding) so
 * finalize can verify it is operating on the correct claim, not a different
 * business payload that happens to share the same request_key.
 */
export async function finalizeBookingCreateRequest(
  client: PoolClient,
  input: {
    propertyId: number;
    requestKey: string;
    bookingId: number;
    result: Record<string, unknown>;
    /** HTTP status code to record (e.g. 201). */
    responseStatus?: number;
    /** Expected fingerprint from the claim binding (for verification). */
    fingerprint: string;
    /** Expected fingerprint version from the claim binding. */
    fingerprintVersion: number;
  }
): Promise<void> {
  const requestKey = validateRequestKey(input.requestKey);
  validatePropertyId(input.propertyId);
  validateFingerprintFormat(input.fingerprint);
  validateFingerprintVersion(input.fingerprintVersion);
  validateResultObject(input.result);
  validateResponseStatus(input.responseStatus ?? 201);
  if (!Number.isInteger(input.bookingId) || input.bookingId <= 0) {
    throw domainError(400, 'BOOKING_CREATE_BOOKING_ID_INVALID',
      `booking_id harus positive integer (got: ${input.bookingId})`);
  }

  const res = await client.query(
    `UPDATE booking_create_requests
     SET status = 'FINAL',
         booking_id = $3,
         result = $4::jsonb,
         response_status = $5,
         finalized_at = NOW(),
         updated_at = NOW()
     WHERE property_id = $1 AND request_key = $2
       AND status = 'PENDING'
       AND fingerprint = $6
       AND fingerprint_version = $7`,
    [
      input.propertyId,
      requestKey,
      input.bookingId,
      JSON.stringify(input.result),
      input.responseStatus ?? 201,
      input.fingerprint,
      input.fingerprintVersion
    ]
  );

  if ((res.rowCount ?? 0) === 0) {
    // Check current state to distinguish "already FINAL same binding" from "different binding"
    const check = await client.query(
      `SELECT status, booking_id, result, response_status, finalized_at,
              fingerprint, fingerprint_version
       FROM booking_create_requests WHERE property_id = $1 AND request_key = $2`,
      [input.propertyId, requestKey]
    );
    const row = check.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw domainError(409, E_INCOMPLETE,
        `Cannot finalize request_key "${requestKey}": row not found`);
    }
    // BU-R2-04: same authoritative row validator as the claim read paths —
    // verifies FP/version, state, and FINAL completeness (result is a plain
    // JSON object, booking_id positive, finalized_at present,
    // response_status 200–399). Incomplete FINAL rows are rejected here,
    // BEFORE any result/booking comparison.
    validateStoredRow(row, { fingerprint: input.fingerprint, fingerprintVersion: input.fingerprintVersion }, requestKey);
    // FP + version now verified; compare booking/result via canonical JSON
    // (order-invariant). Differing business payload → 409 MISMATCH.
    const storedBookingId = Number(row.booking_id);
    const storedResult = row.result as Record<string, unknown>;
    const resultJson = canonicalJsonStringify(input.result);
    const storedResultJson = canonicalJsonStringify(storedResult);
    if (storedBookingId === input.bookingId && resultJson === storedResultJson) {
      return; // idempotent: same business binding and result already finalized
    }
    throw domainError(409, E_MISMATCH,
      `FINAL request "${requestKey}" has different result/booking than finalize input (stored booking_id=${storedBookingId}, incoming=${input.bookingId}); refusing to overwrite`);
  }
}

/**
 * Retrieves the complete result of a FINAL booking-create request for replay.
 *
 * Requires the expected business binding (fingerprint + version) so that a
 * caller cannot retrieve a replay for a different business payload that
 * happens to share the same request_key.
 *
 * Returns null only when the request does not exist (no-row case).
 * PENDING → 409 E_INCOMPLETE (distinguished from no-row).
 * FINAL incomplete → 409 E_INCOMPLETE.
 * FINAL complete + matching binding → replay result.
 * FINAL complete + mismatched binding → 409 E_MISMATCH.
 */
export async function getBookingCreateReplay(
  client: PoolClient,
  input: {
    propertyId: number;
    requestKey: string;
    /** Expected fingerprint for the business binding. */
    fingerprint: string;
    /** Expected fingerprint version. */
    fingerprintVersion: number;
  }
): Promise<BookingCreateReplayResult | null> {
  const requestKey = validateRequestKey(input.requestKey);
  validatePropertyId(input.propertyId);
  validateFingerprintFormat(input.fingerprint);
  validateFingerprintVersion(input.fingerprintVersion);

  const res = await client.query(
    `SELECT property_id, request_key, status, booking_id, result, response_status,
            finalized_at, fingerprint, fingerprint_version
     FROM booking_create_requests
     WHERE property_id = $1 AND request_key = $2`,
    [input.propertyId, requestKey]
  );
  if ((res.rowCount ?? 0) === 0) return null;

  const row = res.rows[0] as Record<string, unknown>;
  // BU-R2-04: same authoritative FINAL validator as the claim read paths —
  // covers FP/version, PENDING/FINAL state, and FINAL completeness.
  // Also enforces response_status 200–399 for FINAL rows (3C-01 extension:
  // surface the validated column, never fabricate a default).
  const validated = validateStoredRow(row, { fingerprint: input.fingerprint, fingerprintVersion: input.fingerprintVersion }, requestKey);

  const bookingId = Number(validated.booking_id);
  const result = validated.result as Record<string, unknown>;
  const responseStatus = Number(validated.response_status);
  if (!Number.isInteger(responseStatus)) {
    throw domainError(409, E_INCOMPLETE,
      `FINAL request "${requestKey}" response_status is not an integer (got ${String(validated.response_status)})`);
  }
  return {
    replayed: true,
    bookingId,
    result,
    requestKey,
    responseStatus
  };
}

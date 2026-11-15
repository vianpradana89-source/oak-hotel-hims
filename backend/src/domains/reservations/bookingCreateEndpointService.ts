/**
 * bookingCreateEndpointService.ts
 *
 * Unit 3C-02 Checkpoint B — explicit booking-create endpoint adapter.
 * Glue layer over accepted helpers (context / http / intent / request services).
 *
 * CONTRACT:
 * - Pure context preparation (no DB, no queries).
 * - Read / claim / finalize accept a caller-owned query client (PoolClient
 *   structural type). No pool.connect, no BEGIN/COMMIT/ROLLBACK, no release.
 * - Authorization is the caller's responsibility and must be complete before
 *   any storage call in this module.
 * - No index.ts, no runtime wiring, no DDL, no second implementation of
 *   accepted helpers.
 */

import type { PoolClient } from 'pg';
import {
  normalizeBookingPaymentIntent,
  type BookingPaymentIntent
} from './bookingPaymentIntentService';
import {
  resolveRequestKey,
  buildEvidenceDescriptor,
  buildBookingCreateFingerprint,
  type EvidenceUploadInput
} from './bookingCreateContextService';
import {
  getBookingCreateReplay,
  claimBookingCreateRequest,
  finalizeBookingCreateRequest,
  domainError
} from './bookingCreateRequestService';
import {
  buildBookingCreateHttpResponse,
  type BookingCreateHttpResponse
} from './bookingCreateHttpService';
import type { EvidenceUpload } from '../deposits/depositTypes';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Server-side fingerprint version constant.
 * Exported so tests and future C wiring can reference it.
 * Never read from client input; this is a server-documented constant.
 */
export const BOOKING_CREATE_ENDPOINT_FP_VERSION = 1;

/** Schema readiness error code (503). */
const E_READINESS = 'BOOKING_CREATE_REPLAY_NOT_READY';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Caller-owned query client type accepted by read/claim/finalize.
 * A type alias of PoolClient keeps the accepted storage-helper contract without
 * asserting a pool/query stub is a transaction client. Import is type-only.
 */
export type QueryClient = PoolClient;

export type ChannelType = 'WALK_IN' | 'OTA';
export type PaymentResponsibility = 'HOTEL_COLLECT' | 'OTA_COLLECT';

/** Memory-upload DTO as accepted by EvidenceUpload (buffer/mimetype/originalname/size). */
export type UploadDto = EvidenceUpload;

// ── Prepare input / output types ──────────────────────────────────────────────

export interface PrepareExplicitBookingCreateInput {
  /** Parsed JSON body (already safe-parsed by caller; caller owns mutation risk). */
  payload: Record<string, unknown>;
  /** Authorized property ID (caller completed assertPropertyScope before this call). */
  propertyId: number;
  /** Raw header value of Idempotency-Key (unknown; null/undefined when absent). */
  headerKey: unknown;
  /** Raw body field request_key (unknown; null/undefined when absent). */
  bodyKey: unknown;
  /** Memory upload DTO (EvidenceUpload) or null when no file was uploaded. */
  upload: UploadDto | null;
  /** Channel type derived by server canonical logic (same as index.ts). */
  channelType: ChannelType;
  /** Payment responsibility derived by server canonical logic (same as index.ts). */
  paymentResponsibility: PaymentResponsibility;
}

export interface ExplicitBookingCreateContext {
  propertyId: number;
  requestKey: string;
  /** SHA-256 hex64 fingerprint computed server-side. */
  fingerprint: string;
  /** Server fingerprint version constant (BOOKING_CREATE_ENDPOINT_FP_VERSION). */
  fingerprintVersion: number;
  /** Normalized payment intent (accepted helper output; LEGACY is rejected here). */
  intent: BookingPaymentIntent;
  /** Child reservation count derived from payload.reservations. */
  childCount: number;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Fields to exclude from the business snapshot wrapper.
 * These are request/correlation metadata or server-computed values that must
 * never be part of the FP identity:
 *  - request_key / correlation_id: idempotency metadata, not business fields
 *  - fingerprint / fingerprint_version / fingerprintVersion: server-computed,
 *    supplied by client would allow FP binding manipulation
 */
const EXCLUDED_SNAPSHOT_KEYS: ReadonlySet<string> = new Set([
  'request_key', 'correlation_id', '_oak_correlation',
  'fingerprint', 'fingerprint_version', 'fingerprintVersion',
]);

/**
 * Builds a clean business-snapshot payload:
 *  - Removes top-level excluded keys (request metadata / supplied FP fields).
 *  - Preserves all other fields including unknown business fields, child order,
 *    phone strings, leading zeros.
 *  - Does NOT mutate the input payload.
 *  - Does NOT add server fields via spread that could be overwritten by client.
 */
function buildBusinessPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined) continue;
    if (EXCLUDED_SNAPSHOT_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Validates channel/paymentResponsibility pair against the fixed 3B contract:
 *  - OTA_COLLECT requires channelType === 'OTA'.
 * Throws domain 400 on violation.
 */
function validateChannelPair(channelType: ChannelType, paymentResponsibility: PaymentResponsibility): void {
  if (!['WALK_IN', 'OTA'].includes(channelType) || !['HOTEL_COLLECT', 'OTA_COLLECT'].includes(paymentResponsibility)) {
    throw domainError(400, 'BOOKING_COLLECTION_CONTEXT_INVALID', 'invalid server channel/payment responsibility');
  }
  if (paymentResponsibility === 'OTA_COLLECT' && channelType !== 'OTA') {
    throw domainError(400, 'OTA_COLLECT_CHANNEL_MISMATCH',
      `OTA_COLLECT payment responsibility requires channelType OTA (got ${channelType})`);
  }
}

// ── Readiness error translation ─────────────────────────────────────────────

/**
 * Translates PostgreSQL schema-readiness errors (42P01/42703/42P10) that occur
 * during storage-domain calls into a 503 BOOKING_CREATE_REPLAY_NOT_READY domain error.
 * Any other error (business 409/400, transport, unknown DB errors) passes through
 * unchanged — this function must NOT swallow them into "row absent".
 */
function translateReadinessError(err: unknown): never {
  const code = (err as { code?: string })?.code;
  if (code === '42P01' || code === '42703' || code === '42P10') {
    throw domainError(503, E_READINESS,
      `Booking-create replay storage not ready (${code})`);
  }
  throw err;
}

// ── 1. prepareExplicitBookingCreateContext (pure) ────────────────────────────

/**
 * 1. prepareExplicitBookingCreateContext (pure, no DB).
 *
 * Input is a parsed payload + authorized propertyId + raw keys + upload DTO +
 * server-derived channel/paymentResponsibility.
 *
 * Returns a typed ExplicitBookingCreateContext with:
 *  - requestKey resolved via accepted resolveRequestKey (explicit=true required)
 *  - intent normalized via accepted normalizeBookingPaymentIntent (LEGACY rejected)
 *  - businessSnapshot built by wrapping payload in a server-owned "payload" field,
 *    excluding top-level request_key / correlation metadata / client-supplied FP
 *  - voucherDescriptor (OTA) or evidenceDescriptor (hotel) computed via
 *    accepted buildEvidenceDescriptor
 *  - fingerprint via accepted buildBookingCreateFingerprint
 *  - fingerprintVersion = BOOKING_CREATE_ENDPOINT_FP_VERSION (server constant)
 *
 * Does NOT retain raw Buffer, mutable payload reference, or filename in identity.
 * Does NOT mutate input. Does NOT use LEGACY mode.
 */
export function prepareExplicitBookingCreateContext(
  input: PrepareExplicitBookingCreateInput
): ExplicitBookingCreateContext {
  const { payload, propertyId, headerKey, bodyKey, upload, channelType, paymentResponsibility } = input;

  if (!Number.isSafeInteger(propertyId) || propertyId <= 0) {
    throw domainError(400, 'PROPERTY_ID_INVALID',
      `propertyId must be a positive integer (got ${String(propertyId)})`);
  }

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
      (Object.getPrototypeOf(payload) !== null && Object.getPrototypeOf(payload) !== Object.prototype)) {
    throw domainError(400, 'BOOKING_PAYLOAD_INVALID', 'payload must be a plain JSON object');
  }
  const rawPropertyId = payload.property_id;
  const payloadPropertyId = typeof rawPropertyId === 'number' ||
    (typeof rawPropertyId === 'string' && rawPropertyId.trim() !== '') ? Number(rawPropertyId) : NaN;
  if (!Number.isSafeInteger(payloadPropertyId) || payloadPropertyId !== propertyId) {
    throw domainError(400, 'BOOKING_PROPERTY_BINDING_MISMATCH', 'payload property_id must match the authorized propertyId');
  }
  validateChannelPair(channelType, paymentResponsibility);

  const intent = normalizeBookingPaymentIntent(payload);
  if (intent.legacy) {
    throw domainError(400, 'EXPLICIT_MODE_REQUIRES_PAYMENT_MODE',
      'Explicit booking-create mode requires an explicit payment_mode ' +
      '(PAY_BILL, ADVANCE_PAYMENT, or UNPAID); LEGACY is not accepted here');
  }

  const requestKey = resolveRequestKey({ headerKey, bodyKey, explicit: true });
  if (requestKey === null) {
    throw domainError(400, 'REQUEST_KEY_REQUIRED',
      'request_key is required in explicit booking-create mode');
  }

  const reservations = payload['reservations'];
  const childCount = Array.isArray(reservations) ? reservations.length : 0;
  if (childCount < 1) {
    throw domainError(400, 'CHILD_COUNT_REQUIRED',
      'reservations must be a non-empty array');
  }

  const isOta = paymentResponsibility === 'OTA_COLLECT';
  let evidenceDescriptor: Record<string, unknown> | null = null;
  let voucherDescriptor: Record<string, unknown> | null = null;

  if (upload != null) {
    const uploadInput: EvidenceUploadInput = {
      bytes: upload.buffer,
      mime: upload.mimetype,
      declaredSize: upload.size,
      filename: upload.originalname,
    };
    const descriptor = buildEvidenceDescriptor(uploadInput);

    if (isOta) {
      voucherDescriptor = {
        sha256: descriptor.sha256 ?? null,
        byteLength: descriptor.byteLength ?? null,
        mime: descriptor.mime ?? null,
      };
      evidenceDescriptor = null;
    } else {
      evidenceDescriptor = descriptor;
      if (intent.mode === 'UNPAID') {
        throw domainError(400, 'UNPAID_WITH_HOTEL_FILE_CONFLICT',
          'UNPAID (Belum Bayar) tidak boleh disertai upload bukti/DP pada hotel-collect; hapus file atau ubah payment_mode');
      }
    }
  }

  const businessPayload = buildBusinessPayload(payload);
  const businessSnapshot: Record<string, unknown> = {
    payload: businessPayload,
    voucherDescriptor,
    collectionContext: { channelType, paymentResponsibility },
  };

  const fingerprint = buildBookingCreateFingerprint({
    businessSnapshot,
    intent,
    propertyId,
    childCount,
    evidenceDescriptor,
  });

  return {
    propertyId,
    requestKey,
    fingerprint,
    fingerprintVersion: BOOKING_CREATE_ENDPOINT_FP_VERSION,
    intent,
    childCount,
  };
}

// ── 2. readBookingCreateEndpointReplay ──────────────────────────────────────

/** Fresh responses are 201; replay preserves the validated stored status. */
export interface BookingCreateStoredHttpResponse {
  responseStatus: number;
  responseBody: Record<string, unknown>;
}

export interface ReadReplayResult {
  kind: 'replay';
  response: BookingCreateStoredHttpResponse;
  bookingId: number;
}

/**
 * Reads a validated replay from booking-create request storage.
 *
 * - Returns null when the row is truly absent (no conflict).
 * - FINAL + complete + matching FP → validates stored HTTP envelope and returns
 *   { kind: 'replay', response, bookingId }.
 * - PENDING / mismatch / incomplete → throws 409 (accepted helper error).
 *
 * No builder re-run, no new correlation, no broadcast.
 */
export async function readBookingCreateEndpointReplay(
  client: QueryClient,
  context: ExplicitBookingCreateContext
): Promise<ReadReplayResult | null> {
  let replay;
  try {
    replay = await getBookingCreateReplay(client, {
      propertyId: context.propertyId,
      requestKey: context.requestKey,
      fingerprint: context.fingerprint,
      fingerprintVersion: context.fingerprintVersion,
    });
  } catch (err) {
    translateReadinessError(err);
  }

  if (replay === null) return null;

  if (typeof replay.bookingId !== 'number' || !Number.isSafeInteger(replay.bookingId) || replay.bookingId <= 0) {
    throw domainError(409, 'BOOKING_CREATE_REPLAY_INCOMPLETE', 'replay bookingId is invalid');
  }
  const storedResult = replay.result;
  const validatedResponse = validateStoredHttpResponse(storedResult, {
    bookingId: replay.bookingId,
    propertyId: context.propertyId,
  });

  return {
    kind: 'replay',
    response: {
      responseStatus: replay.responseStatus,
      responseBody: validatedResponse,
    },
    bookingId: replay.bookingId,
  };
}

// ── 3. claimBookingCreateEndpoint ───────────────────────────────────────────

export interface ClaimFreshResult {
  kind: 'claimed';
}

export interface ClaimLoserResult {
  kind: 'replay';
  response: BookingCreateStoredHttpResponse;
  bookingId: number;
}

export type ClaimResult = ClaimFreshResult | ClaimLoserResult;

/**
 * Claims or replays a booking-create request row.
 *
 * - claimed=true → { kind: 'claimed' } — caller proceeds with writer path.
 * - claimed=false FINAL → validates the winner's stored response via the
 *   accepted read API (getBookingCreateReplay) and returns { kind: 'replay',
 *   response, bookingId }.
 * - PENDING / mismatch → throws 409 accepted helper error (no create fallback).
 *
 * Does NOT query idempotency_keys. Does NOT start/commit/rollback a
 * transaction. Uses the caller's client for all queries.
 */
export async function claimBookingCreateEndpoint(
  client: QueryClient,
  context: ExplicitBookingCreateContext
): Promise<ClaimResult> {
  let claim;
  try {
    claim = await claimBookingCreateRequest(client, {
      propertyId: context.propertyId,
      requestKey: context.requestKey,
      fingerprint: context.fingerprint,
      fingerprintVersion: context.fingerprintVersion,
      paymentIntent: { ...context.intent },
    });
  } catch (err) {
    translateReadinessError(err);
  }

  if (claim.claimed) {
    return { kind: 'claimed' };
  }

  // claimed=false: a row already exists. Use the accepted read API to validate
  // and return the winner's response (do NOT trust row.result directly).
  const replay = await readBookingCreateEndpointReplay(client, context);
  if (replay === null) {
    // After claim returned a row, a null read is fail-closed: throw 409.
    throw domainError(409, 'BOOKING_CREATE_CLAIM_READ_FAILED',
      `Claim returned existing row but re-read returned null for key "${context.requestKey}"; fail-closed`);
  }
  return replay;
}

// ── 4. finalizeBookingCreateEndpoint ───────────────────────────────────────

/**
 * Finalizes a booking-create request with the exact HTTP snapshot.
 *
 * - Builds the fresh HTTP response via accepted buildBookingCreateHttpResponse.
 * - Validates booking/property binding on the canonical result.
 * - Calls accepted finalizeBookingCreateRequest to persist the FINAL row.
 * - Returns the SAME snapshot that was stored, for the caller to send after
 *   COMMIT. No rebuild, no re-timestamp, no extra metadata after finalize.
 *
 * Builder/snapshot errors occur BEFORE the FINAL SQL; finalize failures are
 * thrown to the caller. No deposit/ordinary writer / file save calls here.
 */
export async function finalizeBookingCreateEndpoint(
  client: QueryClient,
  context: ExplicitBookingCreateContext,
  canonicalResult: Parameters<typeof buildBookingCreateHttpResponse>[0]
): Promise<BookingCreateHttpResponse> {
  const bookingId = canonicalResult.booking.id;
  if (typeof bookingId !== 'number' || !Number.isSafeInteger(bookingId) || bookingId <= 0) {
    throw domainError(400, 'BOOKING_ID_INVALID_FOR_FINALIZE', 'canonical booking.id must be a positive safe integer');
  }
  const resultPropertyId = canonicalResult.booking.property_id;
  if (typeof resultPropertyId !== 'number' || resultPropertyId !== context.propertyId) {
    throw domainError(409, 'BOOKING_PROPERTY_MISMATCH', 'canonical booking.property_id must match authorized context');
  }
  const snapshot = buildBookingCreateHttpResponse(canonicalResult);
  validateStoredHttpResponse(snapshot.responseBody, { bookingId, propertyId: context.propertyId });

  // Call accepted finalize (stores the exact responseBody + responseStatus).
  try {
    await finalizeBookingCreateRequest(client, {
      propertyId: context.propertyId,
      requestKey: context.requestKey,
      bookingId,
      result: snapshot.responseBody,
      responseStatus: snapshot.responseStatus,
      fingerprint: context.fingerprint,
      fingerprintVersion: context.fingerprintVersion,
    });
  } catch (err) {
    translateReadinessError(err);
  }

  // Return the SAME snapshot (already built, no rebuild after FINAL SQL).
  return snapshot;
}

// ── HTTP stored-envelope validator (exported for testing) ──────────────────

/**
 * Validates a stored HTTP result envelope before it is returned as a replay.
 * Checks:
 *  - result is a plain JSON object with status === 'SUCCESS'
 *  - result.data is a plain object
 *  - result.data.booking_id is a positive integer matching authoritative bookingId
 *  - result.data.property_id matches the authorized context propertyId
 *  - result.data.reservations is a non-empty array
 *  - result.correlation_id is a nonblank string
 *  - result.data.dp_metadata, if present, is a plain JSON object
 *
 * Does NOT mutate the stored result. Does NOT reorder or reconstruct.
 * Object-key order is meaningless for JSON wire; array order is preserved.
 *
 * Throws 409 on any binding/validation failure (controlled error, no body leak).
 */
export function validateStoredHttpResponse(
  result: unknown,
  expected: { bookingId: number; propertyId: number }
): Record<string, unknown> {
  // result must be a plain object
  if (result === null || result === undefined || typeof result !== 'object' || Array.isArray(result)) {
    throw domainError(409, 'BOOKING_CREATE_REPLAY_INCOMPLETE',
      'stored replay result must be a plain JSON object');
  }
  const resultObj = result as Record<string, unknown>;
  const proto = Object.getPrototypeOf(resultObj);
  if (proto !== null && proto !== Object.prototype) {
    throw domainError(409, 'BOOKING_CREATE_REPLAY_INCOMPLETE',
      'stored replay result is a non-plain object (class instance)');
  }

  if (resultObj['status'] !== 'SUCCESS') {
    throw domainError(409, 'BOOKING_CREATE_REPLAY_INCOMPLETE',
      `stored replay status must be "SUCCESS" (got ${String(resultObj['status'])})`);
  }

  const data = resultObj['data'];
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
    throw domainError(409, 'BOOKING_CREATE_REPLAY_INCOMPLETE',
      'stored replay result.data must be a plain JSON object');
  }
  const dataObj = data as Record<string, unknown>;
  const dataProto = Object.getPrototypeOf(dataObj);
  if (dataProto !== null && dataProto !== Object.prototype) {
    throw domainError(409, 'BOOKING_CREATE_REPLAY_INCOMPLETE', 'stored replay result.data must be a plain object');
  }
  if (!Number.isSafeInteger(expected.bookingId) || expected.bookingId <= 0 ||
      !Number.isSafeInteger(expected.propertyId) || expected.propertyId <= 0) {
    throw domainError(409, 'BOOKING_CREATE_REPLAY_BINDING_MISMATCH', 'invalid authoritative response binding');
  }
  const bookingId = dataObj['booking_id'];
  if (typeof bookingId !== 'number' || !Number.isSafeInteger(bookingId) || bookingId <= 0) {
    throw domainError(409, 'BOOKING_CREATE_REPLAY_INCOMPLETE',
      `stored replay result.data.booking_id must be a positive integer (got ${String(dataObj['booking_id'])})`);
  }
  if (bookingId !== expected.bookingId) {
    throw domainError(409, 'BOOKING_CREATE_REPLAY_BINDING_MISMATCH',
      `stored replay booking_id (${bookingId}) does not match authoritative bookingId (${expected.bookingId})`);
  }

  const propertyId = dataObj['property_id'];
  if (typeof propertyId !== 'number' || !Number.isSafeInteger(propertyId) || propertyId !== expected.propertyId) {
    throw domainError(409, 'BOOKING_CREATE_REPLAY_BINDING_MISMATCH',
      `stored replay property_id (${propertyId}) does not match authorized context propertyId (${expected.propertyId})`);
  }

  const reservations = dataObj['reservations'];
  if (!Array.isArray(reservations) || reservations.length < 1) {
    throw domainError(409, 'BOOKING_CREATE_REPLAY_INCOMPLETE',
      'stored replay result.data.reservations must be a non-empty array');
  }

  const correlationId = resultObj['correlation_id'];
  if (typeof correlationId !== 'string' || correlationId.trim().length === 0) {
    throw domainError(409, 'BOOKING_CREATE_REPLAY_INCOMPLETE',
      'stored replay result.correlation_id must be a nonblank string');
  }

  // dp_metadata: if present, must be a plain JSON object (additive, not dropped)
  const dpMeta = dataObj['dp_metadata'];
  if (dpMeta !== undefined) {
    if (dpMeta === null || typeof dpMeta !== 'object' || Array.isArray(dpMeta)) {
      throw domainError(409, 'BOOKING_CREATE_REPLAY_INCOMPLETE',
        'stored replay result.data.dp_metadata, if present, must be a plain JSON object');
    }
    const dpProto = Object.getPrototypeOf(dpMeta);
    if (dpProto !== null && dpProto !== Object.prototype) {
      throw domainError(409, 'BOOKING_CREATE_REPLAY_INCOMPLETE',
        'stored replay result.data.dp_metadata is a non-plain object (class instance)');
    }
  }

  // Return the validated result unchanged (no mutation, no reorder).
  return resultObj;
}

/**
 * bookingCreateHttpService.ts
 *
 * Unit 3C — Part 1: HTTP response builder + legacy booking-identity helpers
 * for the canonical POST /api/bookings create flow.
 *
 * CONTRACT:
 * - Pure functions: no DB pool, no cache read/write, no file/storage, no
 *   Express app, no timers. The input canonical result is read, never mutated.
 * - buildBookingCreateHttpResponse is the single builder for the fresh
 *   201 response body (later stored FINAL and sent over HTTP). It mirrors
 *   the existing POST /api/bookings wire shape exactly, and additively
 *   includes data.dp_metadata when the canonical result carries it.
 * - isBookingCreateRequest is the pure predicate used to bypass the
 *   pre-auth global cache for this route (variants tolerated by the
 *   current Express config: case-insensitive path, optional trailing slash;
 *   query string is not part of req.path).
 * - buildLegacyBookingCacheKey produces a stable, property-scoped,
 *   booking-namespaced cache key from the legacy Idempotency-Key header.
 *   It is distinct from the DP request_key namespace and from the
 *   booking_create_requests request_key; it reuses the preserved raw
 *   header string, never requires payment_mode/request_key, and does not
 *   change legacy billing behaviour.
 */

import crypto from 'node:crypto';

import { domainError } from './bookingCreateRequestService';

// ── Wire-shape contract (mirrors POST /api/bookings success response) ───────

export interface BookingCreateHttpResponse {
  responseStatus: 201;
  responseBody: {
    status: 'SUCCESS';
    data: {
      booking_id: number;
      bid: string;
      booking_status: string;
      property_id: number;
      guest_name: string | null;
      guest_phone: string | null;
      guest_id: number | null;
      created_guest_ids: number[];
      booking_source: string | null;
      channel: string | null;
      currency_code: string;
      reservations: unknown[];
      dp_metadata?: Record<string, unknown>;
    };
    correlation_id: string;
  };
}

interface CanonicalBookingShape {
  booking: {
    id: unknown;
    bid: unknown;
    booking_status: unknown;
    property_id: unknown;
    guest_name_snapshot: unknown;
    guest_phone_snapshot: unknown;
    booking_source: unknown;
    channel: unknown;
    currency_code: unknown;
    guest_id?: unknown;
    created_guest_ids?: unknown;
  };
  reservations: unknown;
  created_guest_ids?: unknown;
  correlationId: unknown;
  dp_metadata?: Record<string, unknown>;
}

function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    throw domainError(500, 'BOOKING_CREATE_RESPONSE_INVALID',
      `canonical result ${label} must be a plain JSON object (got ${Array.isArray(value) ? 'array' : typeof value})`);
  }
  const obj = value as Record<string, unknown>;
  const proto = Object.getPrototypeOf(obj);
  if (proto !== null && proto !== Object.prototype) {
    throw domainError(500, 'BOOKING_CREATE_RESPONSE_INVALID',
      `canonical result ${label} is a non-plain object (class instance); only JSON-serializable plain objects are allowed`);
  }
  return obj;
}

/** Build a detached JSON wire snapshot without invoking custom toJSON hooks. */
function toJsonWireSnapshot<T>(value: T): T {
  const ancestors = new WeakSet<object>();
  const invalid = (message: string): never => {
    throw domainError(500, 'BOOKING_CREATE_RESPONSE_INVALID', message);
  };
  const copy = (node: unknown): unknown => {
    if (node === null || node === undefined || typeof node === 'string' || typeof node === 'boolean') return node;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) return invalid('Response contains a non-finite number');
      return node;
    }
    if (typeof node !== 'object') return invalid('Response contains a non-JSON value');
    if (Buffer.isBuffer(node)) return invalid('Response must not contain evidence/file buffers');
    if (node instanceof Date) {
      if (!Number.isFinite(Date.prototype.getTime.call(node))) return invalid('Response contains an invalid date');
      return Date.prototype.toISOString.call(node);
    }
    const proto = Object.getPrototypeOf(node);
    if (!Array.isArray(node) && proto !== Object.prototype && proto !== null) {
      return invalid('Response contains a non-plain object');
    }
    if (ancestors.has(node)) return invalid('Response contains a cycle');
    ancestors.add(node);
    let snapshot: unknown;
    if (Array.isArray(node)) {
      snapshot = Array.from(node, item => copy(item) ?? null);
    } else {
      const object: Record<string, unknown> = {};
      for (const key of Object.keys(node)) {
        const next = copy((node as Record<string, unknown>)[key]);
        if (next !== undefined) {
          Object.defineProperty(object, key, { value: next, enumerable: true, writable: true, configurable: true });
        }
      }
      snapshot = object;
    }
    ancestors.delete(node);
    return snapshot;
  };
  return copy(value) as T;
}

/**
 * Builds the single canonical 201 response for POST /api/bookings.
 *
 * - Mirrors the existing route wire shape field-for-field.
 * - guest_id falls back to created_guest_ids[0] (existing legacy behaviour).
 * - If canonicalResult.dp_metadata is present and a plain object, it is
 *   copied into data.dp_metadata additively; absent/null → no dp_metadata
 *   key on legacy results.
 * - No new timestamp/correlation is minted: correlation_id is copied from
 *   the canonical result, never generated.
 * - Input is not mutated. Result is JSON-serializable (plain objects only).
 * - An incomplete/invalid canonical result throws a 500 domain error — it
 *   must never become a partial success.
 */
export function buildBookingCreateHttpResponse(
  canonicalResult: CanonicalBookingShape
): BookingCreateHttpResponse {
  const result = assertPlainObject(canonicalResult, 'root');
  const booking = assertPlainObject(result.booking, 'booking');
  const reservations = result.reservations;
  if (!Array.isArray(reservations)) {
    throw domainError(500, 'BOOKING_CREATE_RESPONSE_INVALID',
      'canonical result.reservations must be an array');
  }
  if (reservations.length < 1) {
    throw domainError(500, 'BOOKING_CREATE_RESPONSE_INVALID',
      'canonical result.reservations must not be empty');
  }
  for (const reservation of reservations) {
    if (reservation === null || reservation === undefined || typeof reservation !== 'object') {
      throw domainError(500, 'BOOKING_CREATE_RESPONSE_INVALID',
        'canonical result.reservations entries must be objects');
    }
  }

  const bookingId = Number(booking.id);
  if (!Number.isInteger(bookingId) || bookingId <= 0) {
    throw domainError(500, 'BOOKING_CREATE_RESPONSE_INVALID',
      `canonical result.booking.id must be a positive integer (got ${String(booking.id)})`);
  }
  const propertyId = Number(booking.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw domainError(500, 'BOOKING_CREATE_RESPONSE_INVALID',
      `canonical result.booking.property_id must be a positive integer (got ${String(booking.property_id)})`);
  }
  const bid = booking.bid;
  if (typeof bid !== 'string' || !bid) {
    throw domainError(500, 'BOOKING_CREATE_RESPONSE_INVALID',
      `canonical result.booking.bid must be a non-empty string (got ${typeof bid})`);
  }
  const correlationId = result.correlationId;
  if (typeof correlationId !== 'string') {
    throw domainError(500, 'BOOKING_CREATE_RESPONSE_INVALID',
      'canonical result.correlationId must be a string (copied, never generated here)');
  }

  // guest_id: existing fallback chain — booking.guest_id || created_guest_ids[0] || null.
  const fallbackGuestIds = Array.isArray(result.created_guest_ids) ? result.created_guest_ids : [];
  const rawGuestId = booking.guest_id || fallbackGuestIds[0] || null;
  const guestId: number | null = rawGuestId === null ? null : Number(rawGuestId);
  const createdGuestIds = fallbackGuestIds.map((v: unknown) => Number(v)).filter(Number.isFinite);

  const data: BookingCreateHttpResponse['responseBody']['data'] = {
    booking_id: bookingId,
    bid,
    booking_status: String(booking.booking_status ?? ''),
    property_id: propertyId,
    guest_name: (booking.guest_name_snapshot as string | null) ?? null,
    guest_phone: (booking.guest_phone_snapshot as string | null) ?? null,
    guest_id: guestId,
    created_guest_ids: createdGuestIds,
    booking_source: (booking.booking_source as string | null) ?? null,
    channel: (booking.channel as string | null) ?? null,
    currency_code: String(booking.currency_code ?? 'IDR'),
    reservations: reservations.map((r: unknown) => (r as Record<string, unknown>))
  };

  // Additive DP metadata: present only when the canonical result carries it
  // (Unit 3B explicit DP mode). Legacy results must NOT gain a key.
  const dpMetadata = result.dp_metadata;
  if (dpMetadata !== null && dpMetadata !== undefined) {
    data.dp_metadata = assertPlainObject(dpMetadata, 'dp_metadata');
  }

  return {
    responseStatus: 201,
    responseBody: toJsonWireSnapshot({
      status: 'SUCCESS' as const,
      data,
      correlation_id: correlationId
    })
  };
}

// ── Route predicate (cache-bypass for pre-auth layer) ───────────────────────

/**
 * True when the request matches the canonical POST /api/bookings create
 * route under the current Express configuration:
 * - case-insensitive path (default caseSensitive=false)
 * - optional trailing slash (default strict routing=false)
 * - req.path only (query string is not part of req.path; never compare
 *   the full URL here).
 *
 * Method must be POST exactly (Express matches method case-sensitively in
 * practice; accept the canonical uppercase form). Other methods/paths
 * (GET /api/bookings, /api/bookings/:bid/*, extra segments, other routes)
 * must NOT bypass.
 *
 * Used to bypass the pre-auth global cache for this route in Part 2.
 */
export function isBookingCreateRequest(method: unknown, path: unknown): boolean {
  if (method !== 'POST') return false;
  if (typeof path !== 'string') return false;
  return /^\/api\/bookings\/?$/i.test(path);
}

// ── Legacy booking-identity cache key ────────────────────────────────────────

/**
 * Builds the property-scoped legacy booking namespace cache key from the raw
 * Idempotency-Key header string.
 *
 * Rules:
 * - propertyId must be a positive integer (reject 0/negative/non-integer/NaN
 *   explicitly — never String(object) coercion).
 * - rawHeaderKey must be a non-empty string; null/undefined/empty/whitespace
 *   → returns null (explicitly: no cache identity, do NOT cache).
 * - Non-string rawHeaderKey (number, object, array, boolean) → throws a 400
 *   domain error, NOT String(object) coercion.
 * - Output: stable string `leg-b1:<propertyId>:<sha256hex(rawHeaderKey)>`
 *   where sha256hex is lowercase SHA-256 of the raw header string (UTF-8).
 *   The versioned prefix + property + hash form a namespace distinct from
 *   the DP request_key namespace and the booking_create_requests key;
 *   it is NOT the legacy global (unscoped) key.
 * - No cache read/write, no pool, no file/storage, no middleware side
 *   effect. The function is pure.
 */
export function buildLegacyBookingCacheKey(
  propertyId: unknown,
  rawHeaderKey: unknown
): string | null {
  if (typeof propertyId !== 'number' || !Number.isInteger(propertyId) || propertyId <= 0) {
    throw domainError(400, 'BOOKING_LEGACY_CACHE_KEY_INVALID',
      `property_id must be a positive integer (got ${propertyId === null ? 'null' : typeof propertyId === 'undefined' ? 'undefined' : String(propertyId)})`);
  }
  const propNum = propertyId;
  if (rawHeaderKey === null || rawHeaderKey === undefined || rawHeaderKey === '') {
    // Absent/empty header → no cache identity (legacy no-key requests).
    return null;
  }
  if (typeof rawHeaderKey !== 'string') {
    throw domainError(400, 'BOOKING_LEGACY_CACHE_KEY_INVALID',
      `legacy Idempotency-Key header must be a string (got ${typeof rawHeaderKey}); no String(object) coercion`);
  }
  if (rawHeaderKey.trim() === '') {
    return null;
  }
  const digest = crypto.createHash('sha256').update(rawHeaderKey, 'utf8').digest('hex');
  return `leg-b1:${propNum}:${digest}`;
}

import { safeFetchJson, type SafeFetchResult, type FetchLike } from './calendarApi';

// ---------------------------------------------------------------------------
// Types - exact shapes sourced from backend complimentaryService.ts & schema
// ---------------------------------------------------------------------------

/** Mirrors COMPLIMENTARY_STATUSES from backend (schema_v3.ts + complimentaryService.ts) */
export type ComplimentaryStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'REVOKED';

/** Mirrors COMPLIMENTARY_CATEGORIES from backend (complimentaryService.ts:6) */
export type ComplimentaryCategory =
  | 'OWNER_GUEST'
  | 'VIP'
  | 'SERVICE_RECOVERY'
  | 'PROMOTION'
  | 'STAFF'
  | 'MANAGEMENT'
  | 'OTHER';

/**
 * Minimal shape of a row in reservation_complimentary_requests.
 * Only the fields relevant to the frontend workflow are typed; extra DB columns
 * are silently ignored by destructuring.
 */
export interface ComplimentaryRequest {
  id: number;
  property_id: number;
  reservation_id: number;
  status: ComplimentaryStatus;
  category: ComplimentaryCategory;
  reason: string | null;
  original_gross_amount: number;
  pre_complimentary_payable_amount: number;
  applied_adjustment_amount: number;
  requestor_user_id: string | null;
  requestor_name_snapshot: string | null;
  requested_at: string;
  approver_user_id: string | null;
  approver_name_snapshot: string | null;
  approved_at: string | null;
  rejector_user_id: string | null;
  rejector_name_snapshot: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  revoker_user_id: string | null;
  revoker_name_snapshot: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

/** Minimal payload shape for the /request endpoint body */
export interface CreateComplimentaryRequestInput {
  category: ComplimentaryCategory;
  reason: string;
}

/** Minimal payload shape for the /reject endpoint body */
export interface RejectComplimentaryInput {
  reason: string;
}

/** Minimal payload shape for the /revoke endpoint body */
export interface RevokeComplimentaryInput {
  reason: string;
}

/**
 * Typed error thrown on non-OK backend responses.
 * Carries HTTP status, backend error code (e.g. SETTLEMENT_GUARD_PAYMENT),
 * and human-readable message so callers can branch UI logic.
 */
export class ComplimentaryApiError extends Error {
  readonly httpStatus: number;
  readonly backendCode: string | null;

  constructor(httpStatus: number, backendCode: string | null, message: string) {
    super(message);
    this.name = 'ComplimentaryApiError';
    this.httpStatus = httpStatus;
    this.backendCode = backendCode;
  }
}

// ---------------------------------------------------------------------------
// Backend response shapes
// ---------------------------------------------------------------------------

interface BackendSuccessResponse<T> {
  status: 'SUCCESS';
  data: T;
}

interface BackendErrorResponse {
  status: 'ERROR';
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolves safeFetchJson result into typed data or throws ComplimentaryApiError.
 * Mirrors the pattern used by fetchDailyKpis / fetchUnresolvedGuarantees in
 * calendarApi.ts.
 */
async function ensureOk<T>(
  result: SafeFetchResult<BackendSuccessResponse<T> | BackendErrorResponse>,
  fallbackMessage: string
): Promise<T> {
  if (!result.ok || result.data?.status !== 'SUCCESS') {
    const err = result.data as BackendErrorResponse | undefined;
    throw new ComplimentaryApiError(
      result.status,
      err?.code ?? null,
      err?.message ?? result.errorMessage ?? fallbackMessage
    );
  }
  return result.data.data;
}

// ---------------------------------------------------------------------------
// Public API - all functions accept an explicit authFetch to match existing
// calendar module conventions (depositApi, calendarApi, etc.).
// ---------------------------------------------------------------------------

/**
 * GET /api/reservations/:reservationId/complimentary
 *
 * Returns the single most-recent active complimentary request for the
 * reservation (ORDER BY created_at DESC LIMIT 1).
 *
 * Throws ComplimentaryApiError with backendCode 'NOT_FOUND' when no request
 * exists for this reservation.
 */
export async function getComplimentaryRequest(
  reservationId: number,
  propertyId: number,
  authFetch: FetchLike
): Promise<ComplimentaryRequest> {
  const result = await safeFetchJson<BackendSuccessResponse<ComplimentaryRequest>>(
    `/api/reservations/${reservationId}/complimentary?property_id=${propertyId}`,
    { cache: 'no-store' },
    'Data komplementer belum dapat dimuat.',
    authFetch
  );
  return ensureOk(result, 'Data komplementer belum dapat dimuat.');
}

/**
 * GET /api/reservations/:reservationId/complimentary/list
 *
 * Returns all complimentary requests (including REJECTED / REVOKED) for the
 * reservation ordered by created_at DESC.
 */
export async function listComplimentaryRequests(
  reservationId: number,
  propertyId: number,
  authFetch: FetchLike
): Promise<ComplimentaryRequest[]> {
  const result = await safeFetchJson<BackendSuccessResponse<ComplimentaryRequest[]>>(
    `/api/reservations/${reservationId}/complimentary/list?property_id=${propertyId}`,
    undefined,
    'Daftar komplementer belum dapat dimuat.',
    authFetch
  );
  return ensureOk(result, 'Daftar komplementer belum dapat dimuat.');
}

/**
 * POST /api/reservations/:reservationId/complimentary/request
 *
 * Creates a new complimentary request. Caller must provide an idempotency key;
 * the same key may be retried without creating a duplicate request.
 *
 * @param idempotencyKey - unique per submit attempt. Caller is responsible for
 *   generating (e.g. crypto.randomUUID()). Passing the same key for a retry
 *   returns the already-created request rather than duplicating it.
 * @param input.category - one of the allowed COMPLIMENTARY_CATEGORIES values
 * @param input.reason - free-text justification (required by backend)
 */
export async function requestComplimentary(
  reservationId: number,
  propertyId: number,
  input: CreateComplimentaryRequestInput,
  idempotencyKey: string,
  authFetch: FetchLike
): Promise<ComplimentaryRequest> {
  const result = await safeFetchJson<BackendSuccessResponse<ComplimentaryRequest>>(
    `/api/reservations/${reservationId}/complimentary/request?property_id=${propertyId}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        category: input.category,
        reason: input.reason,
      }),
    },
    'Permintaan komplementer gagal dibuat.',
    authFetch
  );
  return ensureOk(result, 'Permintaan komplementer gagal dibuat.');
}

/**
 * Result shape returned by approveComplimentaryRequest.
 * Mirrors the object returned by backend complimentaryService.approveComplimentaryRequest.
 */
export interface ApprovedComplimentaryResult {
  request: ComplimentaryRequest;
  folio_entry_id: number;
  financials: {
    eligible_room_charge: number;
    commercial_discount: number;
    adjustment_amount: number;
  };
}

/**
 * POST /api/reservations/:reservationId/complimentary/:requestId/approve
 *
 * Approves a PENDING_APPROVAL request. Backend creates a folio CREDIT
 * entry (entry_type=DISCOUNT, source_type=COMPLIMENTARY) and recalculates
 * reservation financials.
 *
 * Returns the updated request together with the generated folio entry id and
 * computed financial snapshot.
 */
export async function approveComplimentaryRequest(
  reservationId: number,
  requestId: number,
  propertyId: number,
  authFetch: FetchLike
): Promise<ApprovedComplimentaryResult> {
  const result = await safeFetchJson<BackendSuccessResponse<ApprovedComplimentaryResult>>(
    `/api/reservations/${reservationId}/complimentary/${requestId}/approve?property_id=${propertyId}`,
    { method: 'POST' },
    'Persetujuan komplementer gagal.',
    authFetch
  );
  return ensureOk(result, 'Persetujuan komplementer gagal.');
}

/**
 * POST /api/reservations/:reservationId/complimentary/:requestId/reject
 *
 * Rejects a PENDING_APPROVAL request. Requires the 'approve' permission
 * (backend reuses the same permission for approve / reject).
 */
export async function rejectComplimentaryRequest(
  reservationId: number,
  requestId: number,
  propertyId: number,
  input: RejectComplimentaryInput,
  authFetch: FetchLike
): Promise<ComplimentaryRequest> {
  const result = await safeFetchJson<BackendSuccessResponse<ComplimentaryRequest>>(
    `/api/reservations/${reservationId}/complimentary/${requestId}/reject?property_id=${propertyId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: input.reason }),
    },
    'Penolakan komplementer gagal.',
    authFetch
  );
  return ensureOk(result, 'Penolakan komplementer gagal.');
}

/**
 * Result shape returned by revokeComplimentaryRequest.
 * Mirrors the object returned by backend complimentaryService.revokeComplimentaryRequest.
 */
export interface RevokedComplimentaryResult {
  request: ComplimentaryRequest;
  reversal_folio_entry_id: number;
  reversal_amount: number;
}

/**
 * POST /api/reservations/:reservationId/complimentary/:requestId/revoke
 *
 * Revokes an APPROVED request. Backend creates a folio DEBIT reversal entry
 * (entry_type=REVERSAL, source_type=COMPLIMENTARY) and recalculates financials.
 *
 * Returns the updated request together with the reversal entry id and amount.
 */
export async function revokeComplimentaryRequest(
  reservationId: number,
  requestId: number,
  propertyId: number,
  input: RevokeComplimentaryInput,
  authFetch: FetchLike
): Promise<RevokedComplimentaryResult> {
  const result = await safeFetchJson<BackendSuccessResponse<RevokedComplimentaryResult>>(
    `/api/reservations/${reservationId}/complimentary/${requestId}/revoke?property_id=${propertyId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: input.reason }),
    },
    'Pencabutan komplementer gagal.',
    authFetch
  );
  return ensureOk(result, 'Pencabutan komplementer gagal.');
}

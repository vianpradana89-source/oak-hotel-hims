import type { Pool, PoolClient } from 'pg';
import { hasPermission } from '../auth/authMiddleware';
import type { AuthUserPayload } from '../auth/authService';
import { recalculateReservationFinancials } from '../stayCharges/stayChargesService';
import { lockReservationFinancialState } from './reservationLockService';

export const COMPLIMENTARY_CATEGORIES = [
  'OWNER_GUEST', 'VIP', 'SERVICE_RECOVERY', 'PROMOTION', 'STAFF', 'MANAGEMENT', 'OTHER'
] as const;
export type ComplimentaryCategory = typeof COMPLIMENTARY_CATEGORIES[number];

export const COMPLIMENTARY_STATUSES = [
  'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'REVOKED'
] as const;
export type ComplimentaryStatus = typeof COMPLIMENTARY_STATUSES[number];

export class ComplimentaryError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'ComplimentaryError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function validatePositiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ComplimentaryError(400, 'VALIDATION_ERROR', `${field} must be a positive integer`);
  }
  return parsed;
}

function validateCategory(value: unknown): ComplimentaryCategory {
  if (!value) throw new ComplimentaryError(400, 'CATEGORY_REQUIRED', 'category is required');
  const cat = String(value).trim().toUpperCase();
  if (!COMPLIMENTARY_CATEGORIES.includes(cat as ComplimentaryCategory)) {
    throw new ComplimentaryError(
      400,
      'INVALID_CATEGORY',
      `Invalid category: ${value}. Allowed: ${COMPLIMENTARY_CATEGORIES.join(', ')}`
    );
  }
  return cat as ComplimentaryCategory;
}

function validateReason(value: unknown): string {
  const reason = String(value || '').trim();
  if (!reason) throw new ComplimentaryError(400, 'REASON_REQUIRED', 'reason is required');
  return reason;
}

// ---------------------------------------------------------------------------
// Eligible room charge: SUM(reservation_nightly_rates.total_amount)
// ---------------------------------------------------------------------------
async function getEligibleRoomChargeAmount(
  client: PoolClient | Pool,
  reservationId: number
): Promise<number> {
  const res = await client.query(
    `SELECT COALESCE(SUM(total_amount), 0) AS eligible
     FROM reservation_nightly_rates
     WHERE reservation_id = $1`,
    [reservationId]
  );
  return Math.round(Number(res.rows[0]?.eligible || 0));
}

// ---------------------------------------------------------------------------
// Commercial discount: valid folio CREDIT DISCOUNT entries (NULL-safe)
// ---------------------------------------------------------------------------
async function getExistingCommercialDiscount(
  client: PoolClient | Pool,
  reservationId: number
): Promise<number> {
  const res = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS discount
     FROM folio_entries
      WHERE reservation_id = $1
        AND direction = 'CREDIT'
        AND entry_type = 'DISCOUNT'
        AND COALESCE(is_voided, FALSE) = FALSE
        AND reversal_of_entry_id IS NULL
        AND source_type IS DISTINCT FROM 'COMPLIMENTARY'`,
    [reservationId]
  );
  return Math.round(Number(res.rows[0]?.discount || 0));
}

// ---------------------------------------------------------------------------
// Check settlement guards: ordinaryAmountPaid > 0 or appliedDeposit > 0
// ---------------------------------------------------------------------------
async function checkSettlementGuards(
  client: PoolClient | Pool,
  reservationId: number,
  propertyId: number
): Promise<{ ordinaryPaid: number; appliedDeposit: number }> {
  const financials = await recalculateReservationFinancials(client, reservationId, propertyId);
  return {
    ordinaryPaid: Math.round(Number(financials.amount_paid || 0)),
    appliedDeposit: Math.round(Number(financials.applied_deposit || 0))
  };
}

// ---------------------------------------------------------------------------
// Request creation
// ---------------------------------------------------------------------------
export async function createComplimentaryRequest(
  pool: Pool,
  input: {
    reservationId: number;
    propertyId: number;
    category: ComplimentaryCategory;
    reason: string;
    idempotencyKey: string;
    requestor: { userId?: string; userName?: string; userRole?: string };
  }
): Promise<any> {
  const { reservationId, propertyId, category, reason, idempotencyKey, requestor } = input;

  validatePositiveInteger(reservationId, 'reservation_id');
  validatePositiveInteger(propertyId, 'property_id');
  const validatedCategory = validateCategory(category);
  const validatedReason = validateReason(reason);
  const cleanIdempotencyKey = (idempotencyKey || '').trim().slice(0, 100) || null;
  if (!cleanIdempotencyKey) {
    throw new ComplimentaryError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Resolve actual role from database to handle test/direct-call scenarios
    let resolvedActor = requestor as any;
    const userId = (requestor as any).userId ?? (requestor as any).id;
    if (userId) {
      const userRes = await client.query(
        `SELECT r.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
        [userId]
      );
      if (userRes.rows[0]) {
        resolvedActor = { ...requestor, role: userRes.rows[0].name };
      }
    }

    // Permission check (FIX 1: must happen before any idempotent return)
    const hasRequestPerm = await hasPermission(resolvedActor, 'reservations.complimentary.request', client);
    if (!hasRequestPerm) {
      throw new ComplimentaryError(403, 'FORBIDDEN', 'Insufficient permission to request complimentary');
    }

    // Idempotency pre-check (FIX 2: SELECT * for full row response)
    const idemCheck = await client.query(
      `SELECT * FROM reservation_complimentary_requests
       WHERE idempotency_key = $1
       LIMIT 1`,
      [cleanIdempotencyKey]
    );
    if ((idemCheck.rowCount ?? 0) > 0) {
      const existingRow = idemCheck.rows[0];
      if (Number(existingRow.reservation_id) === reservationId && Number(existingRow.property_id) === propertyId) {
        // Same scope: commit cleanly and return full existing row
        await client.query('COMMIT');
        return existingRow;
      }
      // Different scope: let generic catch handle the single ROLLBACK
      throw new ComplimentaryError(409, 'IDEMPOTENCY_KEY_CONFLICT',
        'This idempotency key is already associated with a different reservation/property');
    }

    // Lock and validate reservation
    const resCheck = await client.query(
      `SELECT r.id, r.status, b.property_id AS booking_property_id
       FROM reservations r
       JOIN bookings b ON b.id = r.booking_id
       WHERE r.id = $1 FOR UPDATE`,
      [reservationId]
    );
    if ((resCheck.rowCount ?? 0) !== 1) {
      throw new ComplimentaryError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found');
    }
    const resRow = resCheck.rows[0];
    const bookingPropId = Number(resRow.booking_property_id);
    if (bookingPropId !== propertyId) {
      throw new ComplimentaryError(403, 'PROPERTY_MISMATCH', 'Reservation does not belong to this property');
    }

    // Check for active PENDING_APPROVAL request (unique constraint guards duplicate)
    const existingActive = await client.query(
      `SELECT id, status FROM reservation_complimentary_requests
       WHERE reservation_id = $1 AND property_id = $2 AND status IN ('PENDING_APPROVAL', 'APPROVED')`,
      [reservationId, propertyId]
    );
    if ((existingActive.rowCount ?? 0) > 0) {
      if (existingActive.rows[0].status === 'PENDING_APPROVAL') {
        throw new ComplimentaryError(409, 'ACTIVE_REQUEST_EXISTS', 'An active complimentary request already exists for this reservation');
      }
      throw new ComplimentaryError(409, 'APPROVED_EXISTS', 'An approved complimentary request already exists for this reservation');
    }

    // Insert request
    const ins = await client.query(
      `INSERT INTO reservation_complimentary_requests (
         property_id, reservation_id, status, category, reason,
         original_gross_amount, pre_complimentary_payable_amount, applied_adjustment_amount,
         requestor_user_id, requestor_name_snapshot, requested_at,
         idempotency_key, created_at, updated_at
       ) VALUES ($1, $2, 'PENDING_APPROVAL', $3, $4, 0, 0, 0,
                $5, $6, NOW(), $7, NOW(), NOW())
       RETURNING *`,
      [
        propertyId,
        reservationId,
        validatedCategory,
        validatedReason,
        requestor?.userId || null,
        requestor?.userName || null,
        cleanIdempotencyKey
      ]
    );

    await client.query('COMMIT');
    return ins.rows[0];
  } catch (error) {
    // FIX 3: Handle concurrent unique violation on idempotency key
    const pgError = error as any;
    if (pgError.code === '23505' && pgError.constraint === 'uq_comp_req_idempotency_key') {
      // Rollback exactly once for this path
      await client.query('ROLLBACK').catch(() => {});
      const retry = await pool.query(
        `SELECT * FROM reservation_complimentary_requests
         WHERE idempotency_key = $1`,
        [cleanIdempotencyKey]
      );
      if ((retry.rowCount ?? 0) > 0) {
        const existingRow = retry.rows[0];
        if (Number(existingRow.reservation_id) === reservationId && Number(existingRow.property_id) === propertyId) {
          return existingRow;
        }
        throw new ComplimentaryError(409, 'IDEMPOTENCY_KEY_CONFLICT',
          'This idempotency key is already associated with a different reservation/property');
      }
      // Row not found after 23505 -- rethrow original PG error (transaction already rolled back)
      throw error;
    }
    // Non-idempotency error: rollback exactly once and rethrow
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Get complimentary request (read)
// ---------------------------------------------------------------------------
export async function getComplimentaryRequest(
  pool: Pool,
  reservationId: number,
  propertyId: number,
  user?: AuthUserPayload
): Promise<any> {
  validatePositiveInteger(reservationId, 'reservation_id');
  validatePositiveInteger(propertyId, 'property_id');

  const hasViewPerm = await hasPermission(user, 'reservations.complimentary.view', pool);
  if (!hasViewPerm) {
    throw new ComplimentaryError(403, 'FORBIDDEN', 'Insufficient permission to view complimentary requests');
  }

  const res = await pool.query(
    `SELECT r.*
     FROM reservation_complimentary_requests r
     JOIN reservations res ON res.id = r.reservation_id
     JOIN bookings b ON b.id = res.booking_id
      WHERE r.reservation_id = $1
        AND b.property_id = $2
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 1`,
    [reservationId, propertyId]
  );

  if ((res.rowCount ?? 0) === 0) {
    throw new ComplimentaryError(404, 'NOT_FOUND', 'Complimentary request not found');
  }
  return res.rows[0];
}

// ---------------------------------------------------------------------------
// List complimentary requests for a reservation
// ---------------------------------------------------------------------------
export async function listComplimentaryRequests(
  pool: Pool,
  reservationId: number,
  propertyId: number,
  user?: AuthUserPayload
): Promise<any[]> {
  validatePositiveInteger(reservationId, 'reservation_id');
  validatePositiveInteger(propertyId, 'property_id');

  const hasViewPerm = await hasPermission(user, 'reservations.complimentary.view', pool);
  if (!hasViewPerm) {
    throw new ComplimentaryError(403, 'FORBIDDEN', 'Insufficient permission to view complimentary requests');
  }

  const res = await pool.query(
    `SELECT r.*
     FROM reservation_complimentary_requests r
     JOIN reservations res ON res.id = r.reservation_id
     JOIN bookings b ON b.id = res.booking_id
     WHERE r.reservation_id = $1
       AND b.property_id = $2
     ORDER BY r.created_at DESC`,
    [reservationId, propertyId]
  );
  return res.rows;
}

// ---------------------------------------------------------------------------
// Approve complimentary request
// ---------------------------------------------------------------------------
export async function approveComplimentaryRequest(
  pool: Pool,
  input: {
    requestId: number;
    reservationId: number;
    propertyId: number;
    actor: { userId?: string; userName?: string; userRole?: string };
  }
): Promise<any> {
  const { requestId, reservationId, propertyId, actor } = input;

  validatePositiveInteger(requestId, 'request_id');
  validatePositiveInteger(reservationId, 'reservation_id');
  validatePositiveInteger(propertyId, 'property_id');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Permission check
    const hasApprovePerm = await hasPermission(actor as any, 'reservations.complimentary.approve', client);
    if (!hasApprovePerm) {
      throw new ComplimentaryError(403, 'FORBIDDEN', 'Insufficient permission to approve complimentary requests');
    }

    // STEP 1: PLAIN READ request (no lock yet)
    const reqCheck = await client.query(
      `SELECT r.*, b.property_id AS booking_property_id
       FROM reservation_complimentary_requests r
       JOIN reservations res ON res.id = r.reservation_id
       JOIN bookings b ON b.id = res.booking_id
       WHERE r.id = $1`,
      [requestId]
    );
    if ((reqCheck.rowCount ?? 0) !== 1) {
      throw new ComplimentaryError(404, 'REQUEST_NOT_FOUND', 'Complimentary request not found');
    }
    const reqRow = reqCheck.rows[0];

    // Derive actual parent reservation from the request row, not caller-supplied ID
    const discoveredReservationId = Number(reqRow.reservation_id);

    // STEP 2: PARENT LOCK FIRST — lock reservation
    await lockReservationFinancialState(client, discoveredReservationId, propertyId);

    // STEP 3: CHILD LOCK — lock request (after parent is secured)
    const lockedReq = await client.query(
      `SELECT r.*, b.property_id AS booking_property_id
       FROM reservation_complimentary_requests r
       JOIN reservations res ON res.id = r.reservation_id
       JOIN bookings b ON b.id = res.booking_id
       WHERE r.id = $1
       FOR UPDATE`,
      [requestId]
    );
    if ((lockedReq.rowCount ?? 0) !== 1) {
      throw new ComplimentaryError(404, 'REQUEST_NOT_FOUND', 'Complimentary request not found');
    }
    const lockedReqRow = lockedReq.rows[0];

    // STEP 4: REVALIDATE after locks
    // TOCTOU parent invariant: locked child reservation_id === discovered parent
    if (Number(lockedReqRow.reservation_id) !== discoveredReservationId) {
      throw new ComplimentaryError(
        400,
        'MISMATCH',
        'Request reservation changed during locking'
      );
    }
    // Caller-scope validation: locked child reservation_id === caller's reservationId
    if (Number(lockedReqRow.reservation_id) !== reservationId) {
      throw new ComplimentaryError(400, 'MISMATCH', 'Request does not belong to the specified reservation');
    }
    const lockedBookingPropId = Number(lockedReqRow.booking_property_id);
    if (lockedBookingPropId !== propertyId) {
      throw new ComplimentaryError(403, 'PROPERTY_MISMATCH', 'Request does not belong to this property');
    }
    if (lockedReqRow.status !== 'PENDING_APPROVAL') {
      throw new ComplimentaryError(409, 'INVALID_STATUS_TRANSITION',
        `Cannot approve request in status '${lockedReqRow.status}'. Expected PENDING_APPROVAL.`
      );
    }

    // Recalculate all financial inputs
    const eligibleRoomCharge = await getEligibleRoomChargeAmount(client, reservationId);
    const commercialDiscount = await getExistingCommercialDiscount(client, reservationId);
    const baseForComplimentary = Math.max(0, eligibleRoomCharge - commercialDiscount);

    if (baseForComplimentary <= 0) {
      throw new ComplimentaryError(400, 'NO_ELIGIBLE_AMOUNT', 'No eligible room charge amount for complimentary (eligible amount is zero or negative)');
    }

    // Settlement guards: block if ordinary payment or deposit exists
    const { ordinaryPaid, appliedDeposit } = await checkSettlementGuards(client, reservationId, propertyId);
    if (ordinaryPaid > 0) {
      throw new ComplimentaryError(409, 'SETTLEMENT_GUARD_PAYMENT',
        'Approval blocked: reservation has ordinary payment(s). Please refund/unapply settlement first.'
      );
    }
    if (appliedDeposit > 0) {
      throw new ComplimentaryError(409, 'SETTLEMENT_GUARD_DEPOSIT',
        'Approval blocked: reservation has applied deposit. Please refund/unapply deposit first.'
      );
    }

    const adjustmentAmount = baseForComplimentary;

    // Write financial snapshots to request row
    await client.query(
      `UPDATE reservation_complimentary_requests
       SET original_gross_amount = $1,
           pre_complimentary_payable_amount = $2,
           applied_adjustment_amount = $3,
           approver_user_id = $4,
           approver_name_snapshot = $5,
           approved_at = NOW(),
           status = 'APPROVED',
           updated_at = NOW()
       WHERE id = $6`,
      [eligibleRoomCharge, baseForComplimentary, adjustmentAmount, actor?.userId || null, actor?.userName || null, requestId]
    );

    // Create folio CREDIT entry (DISCOUNT, source_type = COMPLIMENTARY)
    const folioIns = await client.query(
      `INSERT INTO folio_entries (
         reservation_id, property_id, entry_type, description, amount, direction,
         source_type, source_id, status,
         actor_user_id, actor_name_snapshot, actor_role_snapshot,
         base_amount, unit_price, quantity, notes
       ) VALUES ($1, $2, 'DISCOUNT', $3, $4, 'CREDIT',
                'COMPLIMENTARY', $5, 'POSTED',
                $6, $7, $8,
                $4, $4, 1, $9)
       RETURNING id`,
      [
        reservationId,
        propertyId,
        `Complimentary adjustment (${reqRow.category}): ${reqRow.reason}`,
        adjustmentAmount,
        String(requestId),
        actor?.userId || null,
        actor?.userName || null,
        actor?.userRole || null,
        reqRow.reason
      ]
    );

    // Recalculate reservation financials through canonical function
    await recalculateReservationFinancials(client, reservationId, propertyId);

    // Reload request for response
    const updatedReq = await client.query(
      `SELECT * FROM reservation_complimentary_requests WHERE id = $1`,
      [requestId]
    );

    await client.query('COMMIT');
    return {
      request: updatedReq.rows[0],
      folio_entry_id: folioIns.rows[0].id,
      financials: {
        eligible_room_charge: eligibleRoomCharge,
        commercial_discount: commercialDiscount,
        adjustment_amount: adjustmentAmount
      }
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Reject complimentary request
// ---------------------------------------------------------------------------
export async function rejectComplimentaryRequest(
  pool: Pool,
  input: {
    requestId: number;
    reservationId: number;
    propertyId: number;
    reason: string;
    actor: { userId?: string; userName?: string; userRole?: string };
  }
): Promise<any> {
  const { requestId, reservationId, propertyId, reason, actor } = input;

  const validatedRequestId = validatePositiveInteger(requestId, 'request_id');
  const validatedReservationId = validatePositiveInteger(reservationId, 'reservation_id');
  const validatedPropertyId = validatePositiveInteger(propertyId, 'property_id');
  const validatedReason = validateReason(reason);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Use approve permission for reject (per spec: "Reject may use approve permission")
    const hasApprovePerm = await hasPermission(actor as any, 'reservations.complimentary.approve', client);
    if (!hasApprovePerm) {
      throw new ComplimentaryError(403, 'FORBIDDEN', 'Insufficient permission to reject complimentary requests');
    }

    // Lock request
    const reqCheck = await client.query(
      `SELECT r.*
       FROM reservation_complimentary_requests r
       JOIN bookings b ON b.id = (SELECT booking_id FROM reservations WHERE id = r.reservation_id)
       WHERE r.id = $1 AND b.property_id = $2
       FOR UPDATE`,
      [validatedRequestId, validatedPropertyId]
    );
    if ((reqCheck.rowCount ?? 0) !== 1) {
      throw new ComplimentaryError(404, 'REQUEST_NOT_FOUND', 'Complimentary request not found');
    }
    const reqRow = reqCheck.rows[0];

    if (Number(reqRow.reservation_id) !== validatedReservationId) {
      throw new ComplimentaryError(400, 'MISMATCH', 'Request does not belong to the specified reservation');
    }

    if (reqRow.status !== 'PENDING_APPROVAL') {
      throw new ComplimentaryError(409, 'INVALID_STATUS_TRANSITION',
        `Cannot reject request in status '${reqRow.status}'. Expected PENDING_APPROVAL.`
      );
    }

    await client.query(
      `UPDATE reservation_complimentary_requests
       SET status = 'REJECTED',
           rejector_user_id = $2,
           rejector_name_snapshot = $3,
           rejected_at = NOW(),
           rejection_reason = $4,
           updated_at = NOW()
       WHERE id = $1`,
      [validatedRequestId, actor?.userId || null, actor?.userName || null, validatedReason]
    );

    await client.query('COMMIT');

    const updated = await client.query(`SELECT * FROM reservation_complimentary_requests WHERE id = $1`, [validatedRequestId]);
    return updated.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Revoke approved complimentary request
// ---------------------------------------------------------------------------
export async function revokeComplimentaryRequest(
  pool: Pool,
  input: {
    requestId: number;
    reservationId: number;
    propertyId: number;
    reason: string;
    actor: { userId?: string; userName?: string; userRole?: string };
  }
): Promise<any> {
  const { requestId, reservationId, propertyId, reason, actor } = input;

  const validatedRequestId = validatePositiveInteger(requestId, 'request_id');
  const validatedReservationId = validatePositiveInteger(reservationId, 'reservation_id');
  const validatedPropertyId = validatePositiveInteger(propertyId, 'property_id');
  const validatedReason = validateReason(reason);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Permission check
    const hasRevokePerm = await hasPermission(actor as any, 'reservations.complimentary.revoke', client);
    if (!hasRevokePerm) {
      throw new ComplimentaryError(403, 'FORBIDDEN', 'Insufficient permission to revoke complimentary requests');
    }

    // STEP 1: PLAIN READ request (no lock yet)
    const reqCheck = await client.query(
      `SELECT r.*, b.property_id AS booking_property_id
       FROM reservation_complimentary_requests r
       JOIN reservations res ON res.id = r.reservation_id
       JOIN bookings b ON b.id = res.booking_id
       WHERE r.id = $1`,
      [validatedRequestId]
    );
    if ((reqCheck.rowCount ?? 0) !== 1) {
      throw new ComplimentaryError(404, 'REQUEST_NOT_FOUND', 'Complimentary request not found');
    }
    const reqRow = reqCheck.rows[0];

    // Derive actual parent reservation from the request row, not caller-supplied ID
    const discoveredReservationId = Number(reqRow.reservation_id);

    // STEP 2: PARENT LOCK FIRST — lock reservation
    await lockReservationFinancialState(client, discoveredReservationId, validatedPropertyId);

    // STEP 3: CHILD LOCK — lock request (after parent is secured)
    const lockedReq = await client.query(
      `SELECT r.*, b.property_id AS booking_property_id
       FROM reservation_complimentary_requests r
       JOIN reservations res ON res.id = r.reservation_id
       JOIN bookings b ON b.id = res.booking_id
       WHERE r.id = $1
       FOR UPDATE`,
      [validatedRequestId]
    );
    if ((lockedReq.rowCount ?? 0) !== 1) {
      throw new ComplimentaryError(404, 'REQUEST_NOT_FOUND', 'Complimentary request not found');
    }
    const lockedReqRow = lockedReq.rows[0];

    // STEP 4: REVALIDATE after locks
    // TOCTOU parent invariant: locked child reservation_id === discovered parent
    if (Number(lockedReqRow.reservation_id) !== discoveredReservationId) {
      throw new ComplimentaryError(
        400,
        'MISMATCH',
        'Request reservation changed during locking'
      );
    }
    // Caller-scope validation: locked child reservation_id === caller's reservationId
    if (Number(lockedReqRow.reservation_id) !== validatedReservationId) {
      throw new ComplimentaryError(400, 'MISMATCH', 'Request does not belong to the specified reservation');
    }
    if (lockedReqRow.status !== 'APPROVED') {
      throw new ComplimentaryError(409, 'INVALID_STATUS_TRANSITION',
        `Cannot revoke request in status '${lockedReqRow.status}'. Expected APPROVED.`
      );
    }
    if (!lockedReqRow.applied_adjustment_amount || Number(lockedReqRow.applied_adjustment_amount) <= 0) {
      throw new ComplimentaryError(400, 'NO_ADJUSTMENT_TO_REVOKE', 'No adjustment amount to revoke');
    }

    // Find the original complimentary folio credit entry
    const origEntry = await client.query(
      `SELECT id, amount, reservation_id, property_id
       FROM folio_entries
       WHERE reservation_id = $1
         AND source_type = 'COMPLIMENTARY'
         AND source_id = $2
         AND direction = 'CREDIT'
         AND COALESCE(is_voided, FALSE) = FALSE
         AND reversal_of_entry_id IS NULL
       LIMIT 1`,
      [reservationId, String(requestId)]
    );
    if ((origEntry.rowCount ?? 0) === 0) {
      throw new ComplimentaryError(404, 'ORIG_ENTRY_NOT_FOUND', 'Original complimentary folio entry not found');
    }
    const origEntryId = Number(origEntry.rows[0].id);
    const origAmount = Math.round(Number(origEntry.rows[0].amount));

    // Create reversal folio DEBIT entry
    const reversalIns = await client.query(
      `INSERT INTO folio_entries (
         reservation_id, property_id, entry_type, description, amount, direction,
         source_type, source_id, reversal_of_entry_id, status,
         actor_user_id, actor_name_snapshot, actor_role_snapshot,
         base_amount, unit_price, quantity, notes
       ) VALUES ($1, $2, 'REVERSAL', $3, $4, 'DEBIT',
                'COMPLIMENTARY', $5, $6, 'POSTED',
                $7, $8, $9,
                $4, $4, 1, $10)
       RETURNING id`,
      [
        reservationId,
        propertyId,
        `Reversal of complimentary adjustment (req #${requestId}): ${validatedReason}`,
        origAmount,
        String(requestId),
        origEntryId,
        actor?.userId || null,
        actor?.userName || null,
        actor?.userRole || null,
        validatedReason
      ]
    );

    // Update request to REVOKED
    await client.query(
      `UPDATE reservation_complimentary_requests
       SET status = 'REVOKED',
           revoker_user_id = $2,
           revoker_name_snapshot = $3,
           revoked_at = NOW(),
           revoke_reason = $4,
           updated_at = NOW()
       WHERE id = $1`,
      [validatedRequestId, actor?.userId || null, actor?.userName || null, validatedReason]
    );

    // Recalculate reservation financials
    await recalculateReservationFinancials(client, reservationId, propertyId);

    await client.query('COMMIT');

    const updated = await client.query(`SELECT * FROM reservation_complimentary_requests WHERE id = $1`, [validatedRequestId]);
    return {
      request: updated.rows[0],
      reversal_folio_entry_id: reversalIns.rows[0].id,
      reversal_amount: origAmount
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

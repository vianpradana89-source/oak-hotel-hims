/**
 * bookingGroupPaymentService.ts
 *
 * MULTI-BOOKING-SCOPE-1B3A — Group Payment Write Domain Core
 *
 * Creates a single BOOKING_GROUP payment and allocates it across child
 * reservations of a booking using deterministic first-fit allocation.
 *
 * Design principles:
 *   - Caller owns transaction (no BEGIN/COMMIT/ROLLBACK in this service)
 *   - No schema changes required
 *   - No evidence handling (deferred to 1B3B)
 *   - No Gate 4/5 modifications (deferred to 1B3B)
 *   - No runtime booking creation activation (deferred to 1B3C)
 *   - Transaction safety only; no standalone retry-idempotency
 *
 * Dependency direction (no cycles):
 *   bookingGroupPaymentService → paymentAllocationService (canonical reads)
 *   bookingGroupPaymentService → stayChargesService (recalculate)
 *   stayChargesService → paymentAllocationService (existing)
 */

import type { PoolClient } from 'pg';
import {
  getEffectivePaymentStateForReservation,
  type EffectivePaymentState
} from './paymentAllocationService';
import { recalculateReservationFinancials } from '../stayCharges/stayChargesService';

// ─── Input / Output Types ─────────────────────────────────────────────────────

export interface CreateBookingGroupPaymentInput {
  propertyId: number;
  bookingId: number;
  amount: number;
  paymentMethod?: string;
  referenceCode?: string | null;
  createdBy?: string | null;
  description?: string;
  /**
   * Explicit list of reservation IDs to allocate against.
   * If omitted, all active reservations for the booking are used.
   */
  reservationIds?: number[] | null;
}

export interface BookingGroupAllocation {
  reservationId: number;
  allocatedAmount: number;
  paymentTransactionId: number;
}

export interface CreateBookingGroupPaymentResult {
  parentPayment: {
    id: number;
    amount: number;
    referenceCode: string | null;
    paymentMethod: string;
    status: string;
    bookingId: number;
    propertyId: number;
    scope: string;
    createdAt: Date;
  };
  allocations: BookingGroupAllocation[];
  folioEntries: Array<{
    reservationId: number;
    folioEntryId: number;
    amount: number;
  }>;
  recalculatedReservations: Array<{
    reservationId: number;
    amountPaid: number;
    appliedDeposit: number;
    remainingBalance: number;
    paymentStatus: string;
  }>;
}

// ─── Domain Errors ────────────────────────────────────────────────────────────

class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

function throwOverpayment(paymentAmount: number, totalRemainingDue: number): never {
  throw new DomainError(
    'OVERPAYMENT_NOT_ALLOWED',
    `Pembayaran (${paymentAmount}) melebihi sisa tagihan booking (${totalRemainingDue})`,
    { paymentAmount, totalRemainingDue }
  );
}

function throwConservationViolation(inMemory: number, stored: number): never {
  throw new DomainError(
    'ALLOCATION_CONSERVATION_VIOLATION',
    `Conservation violation: in-memory sum ${inMemory} ≠ stored sum ${stored}`,
    { inMemory, stored }
  );
}

// ─── Core Service ─────────────────────────────────────────────────────────────

/**
 * Creates a BOOKING_GROUP payment and allocates it across child reservations.
 *
 * Caller MUST wrap in a transaction (BEGIN/COMMIT/ROLLBACK).
 * This service does NOT manage transactions.
 *
 * @param client - Active PoolClient within a transaction
 * @param input - Payment creation parameters
 */
export async function createBookingGroupPaymentWithAllocations(
  client: PoolClient,
  input: CreateBookingGroupPaymentInput
): Promise<CreateBookingGroupPaymentResult> {
  const {
    propertyId,
    bookingId,
    amount: rawAmount,
    paymentMethod = 'CASH',
    referenceCode = null,
    createdBy = null,
    description = 'Pembayaran group booking',
    reservationIds: explicitReservationIds = null
  } = input;

  // ── Step 0: Validate input ──────────────────────────────────────────────
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw new DomainError('VALIDATION_ERROR', 'property_id must be a positive integer');
  }
  if (!Number.isInteger(bookingId) || bookingId <= 0) {
    throw new DomainError('VALIDATION_ERROR', 'booking_id must be a positive integer');
  }
  const paymentAmount = Math.round(Number(rawAmount));
  if (!Number.isInteger(paymentAmount) || paymentAmount <= 0) {
    throw new DomainError(
      'PAYMENT_AMOUNT_MUST_BE_POSITIVE',
      'Payment amount must be a positive integer (IDR)'
    );
  }

  // Explicit empty reservationIds list is a clear caller error, not "auto-select".
  // null / undefined → auto-select all eligible reservations for the booking.
  // [] (empty array) → explicitly reject: caller asked for zero targets.
  if (Array.isArray(explicitReservationIds) && explicitReservationIds.length === 0) {
    throw new DomainError(
      'NO_TARGET_RESERVATIONS',
      'reservationIds must not be an empty array; omit the field or provide eligible reservation IDs'
    );
  }

  // ── Step 1: Lock booking row ────────────────────────────────────────────
  const bookingLock = await client.query(
    `SELECT id, property_id FROM bookings WHERE id = $1 FOR UPDATE`,
    [bookingId]
  );
  if ((bookingLock.rowCount ?? 0) === 0) {
    throw new DomainError('BOOKING_NOT_FOUND', `Booking ${bookingId} not found`);
  }
  if (Number(bookingLock.rows[0].property_id) !== propertyId) {
    throw new DomainError(
      'CROSS_PROPERTY_BOOKING',
      'Booking does not belong to specified property'
    );
  }

  // ── Step 2: Lock target reservations in canonical order ─────────────────
  let reservationsQuery: string;
  let reservationsParams: unknown[];

  if (explicitReservationIds && explicitReservationIds.length > 0) {
    // Use explicit reservation IDs, locked in stay_sequence, id order.
    // Must enforce the same eligible-status filter as the auto branch so
    // callers cannot bypass reservation-state guards by passing IDs directly.
    reservationsQuery = `
      SELECT r.id, r.booking_id, b.property_id, r.total_price,
             r.stay_sequence, r.status
      FROM reservations r
      JOIN bookings b ON b.id = r.booking_id
      WHERE r.booking_id = $1
        AND r.id = ANY($2::int[])
        AND b.property_id = $3
        AND r.status IN ('CONFIRMED', 'CHECKED_IN')
      ORDER BY r.stay_sequence ASC, r.id ASC
      FOR UPDATE OF r
    `;
    reservationsParams = [bookingId, explicitReservationIds, propertyId];
  } else {
    // Lock all active reservations for this booking
    reservationsQuery = `
      SELECT r.id, r.booking_id, b.property_id, r.total_price,
             r.stay_sequence, r.status
      FROM reservations r
      JOIN bookings b ON b.id = r.booking_id
      WHERE r.booking_id = $1
        AND b.property_id = $2
        AND r.status IN ('CONFIRMED', 'CHECKED_IN')
      ORDER BY r.stay_sequence ASC, r.id ASC
      FOR UPDATE OF r
    `;
    reservationsParams = [bookingId, propertyId];
  }

  const reservationsRes = await client.query(reservationsQuery, reservationsParams);
  if ((reservationsRes.rowCount ?? 0) === 0) {
    throw new DomainError(
      'NO_ELIGIBLE_RESERVATIONS',
      'No eligible reservations found for booking'
    );
  }

  // Cross-booking safety check: all returned rows must belong to the target booking
  const bookingIds = new Set(reservationsRes.rows.map((r: any) => Number(r.booking_id)));
  if (bookingIds.size !== 1 || !bookingIds.has(bookingId)) {
    throw new DomainError(
      'CROSS_BOOKING_RESERVATIONS',
      'Reservation rows do not all belong to the target booking'
    );
  }

  // Explicit list integrity: verify all requested reservation IDs were found
  // and are eligible (CONFIRMED / CHECKED_IN).
  // If any ID is missing it means either (a) cross-booking or (b) ineligible status.
  if (explicitReservationIds && explicitReservationIds.length > 0) {
    const foundIds = new Set(reservationsRes.rows.map((r: any) => Number(r.id)));
    const missingIds = explicitReservationIds.filter(id => !foundIds.has(Number(id)));
    if (missingIds.length > 0) {
      throw new DomainError(
        'ELIGIBLE_RESERVATIONS_REQUIRED',
        `Some requested reservations are not eligible (missing or ineligible status): ${missingIds.join(', ')}`
      );
    }
  }

  const targetReservations = reservationsRes.rows;

  // ── Step 3: Compute remaining due for each reservation (while locks held) ─
  interface ReservationState {
    id: number;
    staySequence: number;
    totalPrice: number;
    payState: EffectivePaymentState;
    appliedDeposit: number;
    remainingDue: number;
  }

  const reservationStates: ReservationState[] = [];

  for (const resRow of targetReservations) {
    const reservationId = Number(resRow.id);
    const totalPrice = Math.round(Number(resRow.total_price || 0));

    // Canonical payment read (1B2 dual-read engine)
    const payState = await getEffectivePaymentStateForReservation(
      client,
      reservationId,
      propertyId
    );

    // Applied deposit (same semantics as recalculateReservationFinancials)
    const depositRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS applied_deposit
       FROM folio_entries
       WHERE reservation_id = $1
         AND property_id = $2
         AND entry_type = 'DEPOSIT_APPLY'
         AND direction = 'CREDIT'
         AND status = 'POSTED'
         AND is_voided = FALSE
         AND reversal_of_entry_id IS NULL`,
      [reservationId, propertyId]
    );
    const appliedDeposit = Math.round(Number(depositRes.rows[0]?.applied_deposit || 0));

    const remainingDue = Math.max(0, totalPrice - payState.totalEffectivePaid - appliedDeposit);

    reservationStates.push({
      id: reservationId,
      staySequence: Number(resRow.stay_sequence || 0),
      totalPrice,
      payState,
      appliedDeposit,
      remainingDue
    });
  }

  // ── Step 4: Validate payment amount ─────────────────────────────────────
  const totalRemainingDue = reservationStates.reduce((sum, rs) => sum + rs.remainingDue, 0);

  if (paymentAmount > totalRemainingDue) {
    throwOverpayment(paymentAmount, totalRemainingDue);
  }

  // ── Step 5: Calculate allocation plan (first-fit) ───────────────────────
  const allocationPlan: Array<{ reservationId: number; allocatedAmount: number }> = [];
  let remainingPayment = paymentAmount;

  for (const rs of reservationStates) {
    if (remainingPayment <= 0) break;
    if (rs.remainingDue <= 0) continue;

    const allocate = Math.min(rs.remainingDue, remainingPayment);
    if (allocate > 0) {
      allocationPlan.push({
        reservationId: rs.id,
        allocatedAmount: allocate
      });
      remainingPayment -= allocate;
    }
  }

  // In-memory conservation assert
  const plannedSum = allocationPlan.reduce((sum, a) => sum + a.allocatedAmount, 0);
  if (plannedSum !== paymentAmount) {
    throwConservationViolation(plannedSum, paymentAmount);
  }

  // ── Step 6: Insert parent payment ───────────────────────────────────────
  const parentInsert = await client.query(
    `INSERT INTO payment_transactions (
       property_id, booking_id, reservation_id, transaction_type,
       amount, payment_method, reference_code, status, scope,
       created_by, created_at
     ) VALUES ($1, $2, NULL, 'PAYMENT', $3, $4, $5, 'SUCCESS', 'BOOKING_GROUP', $6, NOW())
     RETURNING id, amount, reference_code, payment_method, status,
               booking_id, property_id, scope, created_at`,
    [
      propertyId,
      bookingId,
      paymentAmount,
      paymentMethod,
      referenceCode || `GB-PAY-${bookingId}-${Date.now()}`,
      createdBy || 'system'
    ]
  );

  const parentPayment = parentInsert.rows[0];
  const parentPaymentId = Number(parentPayment.id);

  // ── Step 7: Insert allocations ──────────────────────────────────────────
  const allocations: BookingGroupAllocation[] = [];

  for (let seq = 0; seq < allocationPlan.length; seq++) {
    const plan = allocationPlan[seq];
    const allocInsert = await client.query(
      `INSERT INTO payment_allocations (
         property_id, booking_id, reservation_id, payment_transaction_id,
         allocated_amount, allocation_sequence, status, created_by, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, NOW())
       RETURNING id`,
      [
        propertyId,
        bookingId,
        plan.reservationId,
        parentPaymentId,
        plan.allocatedAmount,
        seq + 1,
        createdBy || 'system'
      ]
    );
    allocations.push({
      reservationId: plan.reservationId,
      allocatedAmount: plan.allocatedAmount,
      paymentTransactionId: parentPaymentId
    });
  }

  // ── Step 8: Stored-row conservation verification ────────────────────────
  const conservationCheck = await client.query(
    `WITH parent AS (
       SELECT amount FROM payment_transactions WHERE id = $1
     ),
     allocations AS (
       SELECT COALESCE(SUM(allocated_amount), 0) AS total_allocated
       FROM payment_allocations
       WHERE payment_transaction_id = $1
         AND status = 'ACTIVE'
     )
     SELECT p.amount AS parent_amount, a.total_allocated,
            (p.amount = a.total_allocated) AS conserved
     FROM parent p CROSS JOIN allocations a`,
    [parentPaymentId]
  );

  const conservation = conservationCheck.rows[0];
  if (!conservation.conserved) {
    // Rollback is caller's responsibility, but we throw to signal failure
    throwConservationViolation(conservation.parent_amount, conservation.total_allocated);
  }

  // ── Step 9: Project folio entries ──────────���────────────────────────────
  const folioEntries: Array<{ reservationId: number; folioEntryId: number; amount: number }> = [];

  for (const alloc of allocations) {
    const folioInsert = await client.query(
      `INSERT INTO folio_entries (
         reservation_id, property_id, entry_type, source_type, source_id,
         description, amount, direction, correction_group_id, status, created_at
       ) VALUES ($1, $2, 'PAYMENT', 'BOOKING_PAYMENT', $3, $4, $5, 'CREDIT', $6, 'POSTED', NOW())
       RETURNING id`,
      [
        alloc.reservationId,
        propertyId,
        String(bookingId), // source_id = booking ID (existing convention)
        description || `Pembayaran group booking (${paymentMethod})`,
        alloc.allocatedAmount,
        `corr_gb_${parentPaymentId}_${alloc.reservationId}`
      ]
    );
    folioEntries.push({
      reservationId: alloc.reservationId,
      folioEntryId: Number(folioInsert.rows[0].id),
      amount: alloc.allocatedAmount
    });
  }

  // ── Step 10: Recalculate financials for affected reservations ───────────
  const recalculatedReservations: Array<{
    reservationId: number;
    amountPaid: number;
    appliedDeposit: number;
    remainingBalance: number;
    paymentStatus: string;
  }> = [];

  for (const alloc of allocations) {
    const recalc = await recalculateReservationFinancials(
      client,
      alloc.reservationId,
      propertyId
    );
    recalculatedReservations.push({
      reservationId: alloc.reservationId,
      amountPaid: recalc.amount_paid,
      appliedDeposit: recalc.applied_deposit,
      remainingBalance: recalc.remaining_balance,
      paymentStatus: recalc.payment_status
    });
  }

  // ── Return result ───────────────────────────────────────────────────────
  return {
    parentPayment: {
      id: parentPaymentId,
      amount: Number(parentPayment.amount),
      referenceCode: parentPayment.reference_code,
      paymentMethod: parentPayment.payment_method,
      status: parentPayment.status,
      bookingId: Number(parentPayment.booking_id),
      propertyId: Number(parentPayment.property_id),
      scope: parentPayment.scope,
      createdAt: parentPayment.created_at
    },
    allocations,
    folioEntries,
    recalculatedReservations
  };
}

/**
 * 1B3A Guarantee Statement:
 *
 * This service provides transaction safety (atomicity via caller-owned
 * BEGIN/COMMIT/ROLLBACK), deterministic allocation, conservation verification,
 * and cross-booking/cross-property guards.
 *
 * It does NOT provide standalone retry-idempotency. Duplicate invocation
 * with the same logical payment will create duplicate parent payments and
 * allocations. Retry-idempotency is the caller's responsibility (e.g., via
 * HTTP-level idempotency keys).
 */

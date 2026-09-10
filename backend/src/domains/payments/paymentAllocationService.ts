/**
 * paymentAllocationService.ts
 *
 * MULTI-BOOKING-SCOPE-1B2 — Payment Allocation Domain Core (Read Engine)
 *
 * Provides canonical read functions for reservation payment attribution that
 * combine:
 *   A. Direct ROOM_RESERVATION payment_transactions
 *   B. Allocated BOOKING_GROUP payment transactions via payment_allocations
 *
 * This service is READ-ONLY in 1B2. Allocation writes belong to 1B3.
 *
 * KEY SEMANTIC DISTINCTION — three independent booleans:
 *
 *   canonicalPaymentHistoryExists
 *     → Controls whether legacy fallback is ALLOWED in recalculateReservationFinancials.
 *     → History semantics: row exists with qualifying transaction_type,
 *       regardless of current status (SUCCESS / VOIDED / CORRECTED / REVERSED).
 *     → DEPOSIT / DEPOSIT_REFUND do NOT count as ordinary-payment history.
 *     → Preserves pre-1B2 fallback behaviour: a reservation whose canonical
 *       payment was later voided/corrected still does NOT fall back to stale
 *       folio/persisted amount_paid.
 *
 *   totalEffectivePaid
 *     → Controls reservations.amount_paid written back.
 *     → Only SUCCESS direct payments + ACTIVE allocations from SUCCESS parents.
 *     → VOIDED/CORRECTED/REVERSED contribute zero.
 *
 *   qualifyingPositivePaymentExists
 *     → Controls Precheckin Gate 4.
 *     → Only positive (amount > 0) SUCCESS direct or ACTIVE allocation.
 */

import type { Pool, PoolClient } from 'pg';

export interface EffectivePaymentState {
  // ── Effective paid amounts (strict SUCCESS/ACTIVE filter) ────────────────
  directPaid: number;
  allocatedPaid: number;
  totalEffectivePaid: number;

  // ── Canonical payment HISTORY existence (broad status filter) ─────────────
  // Used by recalculateReservationFinancials to decide whether legacy fallback
  // is allowed. History exists when a qualifying row is present, even if its
  // current status is VOIDED / CORRECTED / REVERSED.
  directPaymentHistoryExists: boolean;
  allocatedPaymentHistoryExists: boolean;
  canonicalPaymentHistoryExists: boolean;

  // ── Qualifying positive payment (Gate 4) ─────────────────────────────────
  directPositivePaymentExists: boolean;
  allocatedPositivePaymentExists: boolean;
  qualifyingPositivePaymentExists: boolean;

  // Legacy alias — kept for backward compat with any external consumers.
  // Semantics are now narrower than the old canonicalSourceExists (history
  // now includes non-SUCCESS rows); callers should prefer canonicalPaymentHistoryExists.
  canonicalSourceExists: boolean;

  allocationCount: number;
}

/**
 * Computes the full effective payment state for a reservation.
 *
 * Single CTE query:
 *   - DIRECT component reads ALL qualifying payment_transactions rows
 *     (history) AND only SUCCESS rows (effective) in one pass.
 *   - ALLOCATED component joins payment_allocations to parent
 *     payment_transactions; history counts all ACTIVE allocations from any
 *     qualifying parent, effective counts only ACTIVE allocations from
 *     SUCCESS parents.
 *
 * @param client - PoolClient or Pool (caller's transaction context; no
 *                 transaction is opened here)
 * @param reservationId - target reservation
 * @param propertyId - target property (defense-in-depth scoping)
 */
export async function getEffectivePaymentStateForReservation(
  client: PoolClient | Pool,
  reservationId: number,
  propertyId: number
): Promise<EffectivePaymentState> {
  const res = await client.query(
    `WITH direct AS (
       SELECT
         COALESCE(SUM(CASE
           WHEN status = 'SUCCESS'
             AND transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
           THEN amount ELSE 0 END), 0) AS direct_paid,
         COUNT(CASE
           WHEN status = 'SUCCESS'
             AND transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
           THEN 1 END) AS direct_source_cnt,
         COUNT(CASE
           WHEN status = 'SUCCESS'
             AND transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
             AND amount > 0
           THEN 1 END) AS direct_positive_cnt,
         -- HISTORY: row exists with qualifying type, ANY status
         COUNT(CASE
           WHEN transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
           THEN 1 END) AS direct_history_cnt
       FROM payment_transactions
       WHERE reservation_id = $1
         AND scope = 'ROOM_RESERVATION'
     ),
      allocated AS (
        SELECT
          COALESCE(SUM(CASE
            WHEN pa.status = 'ACTIVE'
              AND pt.status = 'SUCCESS'
              AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
            THEN pa.allocated_amount ELSE 0 END), 0) AS allocated_paid,
          COUNT(CASE
            WHEN pa.status = 'ACTIVE'
              AND pt.status = 'SUCCESS'
              AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
            THEN 1 END) AS alloc_effective_cnt,
          COUNT(CASE
            WHEN pa.status = 'ACTIVE'
              AND pt.status = 'SUCCESS'
              AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
              AND pa.allocated_amount > 0
            THEN 1 END) AS alloc_positive_cnt,
          -- HISTORY: any allocation row joining a qualifying parent type, regardless of allocation status
          COUNT(CASE
            WHEN pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
            THEN 1 END) AS alloc_history_cnt
        FROM payment_allocations pa
        JOIN payment_transactions pt
          ON pt.id = pa.payment_transaction_id
        WHERE pa.reservation_id = $1
          AND pa.property_id = $2
          AND pt.scope = 'BOOKING_GROUP'
      )
     SELECT
       d.direct_paid,
       d.direct_source_cnt,
       d.direct_positive_cnt,
       d.direct_history_cnt,
       a.allocated_paid,
       a.alloc_effective_cnt,
       a.alloc_positive_cnt,
       a.alloc_history_cnt
     FROM direct d
     CROSS JOIN allocated a`,
    [reservationId, propertyId]
  );

  const row = res.rows[0] ?? {};

  const directPaid = Math.max(0, Math.round(Number(row.direct_paid || 0)));
  const allocatedPaid = Math.max(0, Math.round(Number(row.allocated_paid || 0)));
  const totalEffectivePaid = directPaid + allocatedPaid;

  // ── History booleans (broad: any status, qualifying type only) ────────────
  const directHistoryCnt = Number(row.direct_history_cnt || 0);
  const allocHistoryCnt = Number(row.alloc_history_cnt || 0);
  const directPaymentHistoryExists = directHistoryCnt > 0;
  const allocatedPaymentHistoryExists = allocHistoryCnt > 0;
  const canonicalPaymentHistoryExists = directPaymentHistoryExists || allocatedPaymentHistoryExists;

  // ── Effective / positive booleans (strict: SUCCESS + ACTIVE) ──────────────
  const directSourceCnt = Number(row.direct_source_cnt || 0);
  const allocEffectiveCnt = Number(row.alloc_effective_cnt || 0);
  const directPositiveCnt = Number(row.direct_positive_cnt || 0);
  const allocPositiveCnt = Number(row.alloc_positive_cnt || 0);

  // canonicalSourceExists kept as narrow alias for backward compat
  // (matches old semantics: at least one SUCCESS row)
  const canonicalSourceExists = directSourceCnt > 0 || allocEffectiveCnt > 0;

  const directPositivePaymentExists = directPositiveCnt > 0;
  const allocatedPositivePaymentExists = allocPositiveCnt > 0;
  const qualifyingPositivePaymentExists = directPositivePaymentExists || allocatedPositivePaymentExists;

  return {
    directPaid,
    allocatedPaid,
    totalEffectivePaid,
    directPaymentHistoryExists,
    allocatedPaymentHistoryExists,
    canonicalPaymentHistoryExists,
    canonicalSourceExists,
    directPositivePaymentExists,
    allocatedPositivePaymentExists,
    qualifyingPositivePaymentExists,
    allocationCount: allocEffectiveCnt,
  };
}

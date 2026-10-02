import type { Pool, PoolClient } from 'pg';
import { shouldApplyPostedCommercialDiscount } from './reservationBilling';
import {
  getEffectivePaymentStateForReservation,
  type EffectivePaymentState
} from '../payments/paymentAllocationService';

// ============================================================================
// CANONICAL READ-ONLY FINANCIAL CALCULATORS
// ============================================================================
// This module is intentionally neutral: it depends only on pg types, pricing
// settings, reservation billing helpers, and the payment allocation read engine.
// It MUST NOT depend on transactionService, stayChargesService, or paymentDomainService
// to avoid circular imports.
// ============================================================================

/**
 * Read-only canonical financial calculator.
 *
 * Computes total_price, amount_paid, applied_deposit, remaining_balance,
 * and payment_status from folio_entries + payment_transactions without
 * mutating any rows. Used by GET /api/reservations/:id/folio.
 *
 * Same canonical rules as recalculateReservationFinancials but NO FOR UPDATE,
 * NO UPDATE/INSERT/DELETE.
 */
export async function calculateReservationFinancials(
  client: PoolClient | Pool,
  reservationId: number,
  propertyId: number,
  ordinaryFallbackOverride?: number
): Promise<{
  total_price: number;
  amount_paid: number;
  applied_deposit: number;
  remaining_balance: number;
  payment_status: 'UNPAID' | 'PARTIAL' | 'PAID';
  reservation: any;
}> {
  // 1. Fetch current reservation details (read-only, no lock)
  const resCheck = await client.query(
    `SELECT r.*, b.property_id AS booking_property_id
     FROM reservations r
     LEFT JOIN bookings b ON b.id = r.booking_id
     WHERE r.id = $1`,
    [reservationId]
  );
  if ((resCheck.rowCount ?? 0) === 0) {
    const err: any = new Error(`Reservasi #${reservationId} tidak ditemukan`);
    err.statusCode = 404;
    throw err;
  }
  const resRow = resCheck.rows[0];
  const bookingPropId = Number(resRow.booking_property_id || resRow.property_id || propertyId);
  if (propertyId && bookingPropId && bookingPropId !== propertyId) {
    const err: any = new Error('Reservasi milik properti yang berbeda');
    err.statusCode = 403;
    err.code = 'CROSS_PROPERTY_ACCESS';
    throw err;
  }

  // 2. Calculate Total Charges (Debits) from folio_entries:
  // Charges = Sum of DEBIT entries that are NOT payment voids/reversals
  // Reversals = Sum of CREDIT entries that are reversals of charges (reversal_of_entry_id IS NOT NULL OR entry_type = 'REVERSAL')
  // Net Charges = Charges - Reversals
  const folioDebitsRes = await client.query(
    `SELECT
       COALESCE(SUM(CASE
         WHEN direction = 'DEBIT' AND entry_type NOT IN ('PAYMENT_VOID', 'PAYMENT_REVERSAL', 'REFUND_DEBIT', 'DEPOSIT_UNAPPLY') THEN amount
         ELSE 0
       END), 0) AS gross_charges,
       COALESCE(SUM(CASE
         WHEN direction = 'CREDIT' AND (reversal_of_entry_id IS NOT NULL OR entry_type = 'REVERSAL' OR entry_type LIKE '%_REVERSAL') THEN amount
         ELSE 0
       END), 0) AS charge_reversals,
       COALESCE(SUM(CASE
         WHEN direction = 'DEBIT' AND entry_type = 'ROOM_CHARGE' AND COALESCE(is_voided, FALSE) = FALSE THEN amount
         ELSE 0
       END), 0) AS room_charge_posted,
       COALESCE(SUM(CASE
         WHEN direction = 'CREDIT'
          AND entry_type = 'DISCOUNT'
          AND COALESCE(is_voided, FALSE) = FALSE
          AND reversal_of_entry_id IS NULL
         THEN amount
         ELSE 0
       END), 0) AS commercial_discounts,
       COUNT(CASE WHEN direction = 'DEBIT' AND entry_type NOT IN ('PAYMENT_VOID', 'PAYMENT_REVERSAL', 'REFUND_DEBIT', 'DEPOSIT_UNAPPLY') THEN 1 END)::int as charge_count
     FROM folio_entries
     WHERE reservation_id = $1`,
    [reservationId]
  );

  const grossCharges = Math.round(Number(folioDebitsRes.rows[0]?.gross_charges || 0));
  const chargeReversals = Math.round(Number(folioDebitsRes.rows[0]?.charge_reversals || 0));
  const roomChargePosted = Math.round(Number(folioDebitsRes.rows[0]?.room_charge_posted || 0));
  const commercialDiscounts = Math.round(Number(folioDebitsRes.rows[0]?.commercial_discounts || 0));
  const chargeCount = Number(folioDebitsRes.rows[0]?.charge_count || 0);

  let netTotalCharges: number;
  if (chargeCount > 0) {
    netTotalCharges = Math.max(0, grossCharges - chargeReversals);
    if (
      commercialDiscounts > 0
      && shouldApplyPostedCommercialDiscount({
        roomChargePosted,
        persistedSubtotal: resRow.subtotal_amount
      })
    ) {
      netTotalCharges = Math.max(0, netTotalCharges - commercialDiscounts);
    }
  } else {
    // Fallback for legacy reservations where folio charges haven't been backfilled
    const nightlySumRes = await client.query(
      `SELECT COALESCE(SUM(total_amount), 0) as nightly_sum FROM reservation_nightly_rates WHERE reservation_id = $1`,
      [reservationId]
    );
    const nightlySum = Math.round(Number(nightlySumRes.rows[0]?.nightly_sum || 0));
    netTotalCharges = nightlySum > 0 ? nightlySum : Math.round(Number(resRow.total_price || 0));
  }

  // 3. Calculate Total Payments from canonical dual-source engine:
  //    A. Direct ROOM_RESERVATION payment_transactions
  //    B. Allocated BOOKING_GROUP payments via payment_allocations
  const payState = await getEffectivePaymentStateForReservation(
    client, reservationId, propertyId
  );
  let ordinaryAmountPaid = payState.totalEffectivePaid;

  const depositApplyRes = await client.query(
    `SELECT COALESCE(SUM(
      CASE
        WHEN entry_type = 'DEPOSIT_APPLY' AND direction = 'CREDIT' THEN amount
        WHEN entry_type = 'DEPOSIT_UNAPPLY' AND direction = 'DEBIT' THEN -amount
        ELSE 0
      END
    ), 0) AS applied_deposit
     FROM folio_entries
     WHERE reservation_id = $1
       AND property_id = $2
       AND entry_type IN ('DEPOSIT_APPLY', 'DEPOSIT_UNAPPLY')
       AND status = 'POSTED'
       AND is_voided = FALSE
       AND reversal_of_entry_id IS NULL`,
    [reservationId, propertyId]
  );
  const appliedDeposit = Math.round(Number(depositApplyRes.rows[0]?.applied_deposit || 0));

  // CRITICAL: We use canonicalPaymentHistoryExists (broad: any status), NOT
  // canonicalSourceExists (narrow: SUCCESS only). This preserves the pre-1B2
  // invariant: a reservation whose canonical payment was later voided/corrected
  // still does NOT fall back to stale folio or persisted amount_paid.
  if (!payState.canonicalPaymentHistoryExists) {
    const folioPmtRes = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'CREDIT'
           AND entry_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
           AND reversal_of_entry_id IS NULL THEN amount ELSE 0 END), 0) -
         COALESCE(SUM(CASE WHEN direction = 'DEBIT'
           AND entry_type IN ('PAYMENT_VOID', 'PAYMENT_REVERSAL') THEN amount ELSE 0 END), 0)
           AS folio_paid
       FROM folio_entries
       WHERE reservation_id = $1`,
      [reservationId]
    );
    const folioPaid = Math.round(Number(folioPmtRes.rows[0]?.folio_paid || 0));
    if (folioPaid > 0) {
      ordinaryAmountPaid = folioPaid;
    } else {
      ordinaryAmountPaid = ordinaryFallbackOverride === undefined
        ? Math.max(0, Math.round(Number(resRow.amount_paid || 0)))
        : Math.max(0, Math.round(ordinaryFallbackOverride));
    }
  }

  const effectiveSettlement = ordinaryAmountPaid + appliedDeposit;

  // 4. Calculate Remaining Balance & Payment Status
  const remainingBalance = Math.max(0, netTotalCharges - effectiveSettlement);

  let newPaymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID' = 'UNPAID';
  if (remainingBalance <= 0.01) {
    newPaymentStatus = 'PAID';
  } else if (effectiveSettlement <= 0) {
    newPaymentStatus = 'UNPAID';
  } else {
    newPaymentStatus = 'PARTIAL';
  }

  return {
    total_price: netTotalCharges,
    amount_paid: ordinaryAmountPaid,
    applied_deposit: appliedDeposit,
    remaining_balance: remainingBalance,
    payment_status: newPaymentStatus,
    reservation: resRow
  };
}

/**
 * Canonical hotel collectible balance calculator.
 *
 * HOTEL_COLLECT: hotel is fully responsible for the entire net amount.
 * OTA_COLLECT: original ROOM_CHARGE is settled outside the hotel; only
 *   non-ROOM_CHARGE folio entries (STAY_EXTENSION, manual charges, etc.)
 *   remain as hotel collectible.
 */
export async function calculateHotelCollectibleBalance(
  client: PoolClient | Pool,
  reservationId: number,
  propertyId: number,
  paymentResponsibility: unknown
): Promise<{
  payment_responsibility: 'HOTEL_COLLECT' | 'OTA_COLLECT';
  hotel_collectible_total: number;
  hotel_collectible_remaining_balance: number;
  // Legacy aliases for backward compat with bookingSalesDetailService and other callers
  amount_paid: number;
  applied_deposit: number;
  // Canonical field names for transactionService UI-3 read model
  canonical_amount_paid: number;
  canonical_applied_deposit: number;
}> {
  const responsibility = String(paymentResponsibility || 'HOTEL_COLLECT')
    .trim()
    .toUpperCase();

  const canonical = await calculateReservationFinancials(
    client,
    reservationId,
    propertyId
  );

  if (responsibility !== 'OTA_COLLECT') {
    return {
      payment_responsibility: 'HOTEL_COLLECT',
      hotel_collectible_total: canonical.total_price,
      hotel_collectible_remaining_balance: canonical.remaining_balance,
      amount_paid: canonical.amount_paid,
      applied_deposit: canonical.applied_deposit,
      canonical_amount_paid: canonical.amount_paid,
      canonical_applied_deposit: canonical.applied_deposit
    };
  }

  // OTA_COLLECT:
  // The original OTA room charge is settled outside the hotel and therefore
  // must not block checkout. Only exclude the original ROOM_CHARGE source.
  //
  // STAY_EXTENSION and all other manually-posted hotel charges remain
  // collectible by the hotel.
  const collectibleRes = await client.query(
    `SELECT
       COALESCE(SUM(CASE
         WHEN direction = 'DEBIT'
          AND entry_type NOT IN ('PAYMENT_VOID', 'PAYMENT_REVERSAL', 'REFUND_DEBIT', 'DEPOSIT_UNAPPLY')
          AND COALESCE(source_type, entry_type, '') <> 'ROOM_CHARGE'
         THEN amount
         ELSE 0
       END), 0) AS gross_collectible,
       COALESCE(SUM(CASE
         WHEN direction = 'CREDIT'
          AND (reversal_of_entry_id IS NOT NULL OR entry_type = 'REVERSAL' OR entry_type LIKE '%_REVERSAL')
          AND COALESCE(source_type, entry_type, '') <> 'ROOM_CHARGE'
         THEN amount
         ELSE 0
       END), 0) AS collectible_reversals
     FROM folio_entries
     WHERE reservation_id = $1`,
    [reservationId]
  );

  const grossCollectible = Math.round(
    Number(collectibleRes.rows[0]?.gross_collectible || 0)
  );
  const collectibleReversals = Math.round(
    Number(collectibleRes.rows[0]?.collectible_reversals || 0)
  );

  const hotelCollectibleTotal = Math.max(
    0,
    grossCollectible - collectibleReversals
  );

  const effectiveHotelSettlement =
    canonical.amount_paid + canonical.applied_deposit;

  return {
    payment_responsibility: 'OTA_COLLECT',
    hotel_collectible_total: hotelCollectibleTotal,
    hotel_collectible_remaining_balance: Math.max(
      0,
      hotelCollectibleTotal - effectiveHotelSettlement
    ),
    amount_paid: canonical.amount_paid,
    applied_deposit: canonical.applied_deposit,
    canonical_amount_paid: canonical.amount_paid,
    canonical_applied_deposit: canonical.applied_deposit
  };
}

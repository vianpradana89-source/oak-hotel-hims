'use strict';

import type { Pool, PoolClient } from 'pg';
import { evaluateRoomReadiness } from '../turnover/turnoverService';
import { deriveDepositBalance } from '../deposits/depositService';
import { getEffectivePaymentStateForReservation } from '../payments/paymentAllocationService';
import { getQualifyingEvidenceForReservation } from '../payments/paymentEvidenceService';
import { calculateReservationFinancials } from '../stayCharges/stayChargesService';
import type { MissingRequirement } from './checkinGateTypes';

/**
 * PRECHECKIN-GATE-1 — Canonical eligibility evaluator.
 *
 * Returns pure canonical truth: what conditions must hold for check-in.
 * No override / force / bypass flags accepted.
 * READ-ONLY: accepts an external PoolClient so it can be called:
 *   A. from GET /api/reservations/:id enrichment
 *   B. inside POST /checkin transaction after reservation lock
 */
export interface PreCheckinEligibility {
  eligible: boolean;
  guest_name_ok: boolean;
  guest_phone_ok: boolean;
  identity_ok: boolean;
  payment_ok: boolean;
  payment_evidence_ok: boolean;
  guarantee_ok: boolean;
  room_ready_ok: boolean;
  missing: MissingRequirement[];
}

const MISSING_LABELS: Record<string, string> = {
  PRIMARY_GUEST_NAME_MISSING: 'Nama tamu menginap belum lengkap',
  PRIMARY_GUEST_PHONE_MISSING: 'No. telepon tamu menginap belum lengkap',
  IDENTITY_DOCUMENT_MISSING: 'Dokumen identitas tamu belum tersedia',
  PAYMENT_MISSING: 'Pembayaran belum tercatat',
  PAYMENT_EVIDENCE_MISSING: 'Bukti pembayaran belum tersedia',
  OTA_VOUCHER_MISSING: 'Voucher / bukti booking OTA belum tersedia',
  GUARANTEE_MISSING: 'Jaminan belum ditambahkan',
  ROOM_NOT_READY: 'Kamar belum siap',
};

export async function evaluatePreCheckinEligibility(
  client: Pool | PoolClient,
  propertyId: number,
  reservationId: number
): Promise<PreCheckinEligibility> {
  const missing: MissingRequirement[] = [];

  // ── Validate reservation belongs to property (canonical: booking→room fallback) ──
  const resCheck = await client.query(
    `SELECT res.id, res.room_id, res.booking_id,
            b.property_id AS booking_property_id,
            b.payment_responsibility,
            r.property_id AS room_property_id
     FROM reservations res
     LEFT JOIN bookings b ON b.id = res.booking_id
     LEFT JOIN rooms r ON r.id = res.room_id
     WHERE res.id = $1`,
    [reservationId]
  );
  if (resCheck.rowCount === 0) {
    return {
      eligible: false,
      guest_name_ok: false,
      guest_phone_ok: false,
      identity_ok: false,
      payment_ok: false,
      payment_evidence_ok: false,
      guarantee_ok: false,
      room_ready_ok: false,
      missing: [
        { code: 'RESERVATION_NOT_FOUND', label: 'Reservation tidak ditemukan atau tidak milik properti ini' },
      ],
    };
  }

  const row = resCheck.rows[0];
  const paymentResponsibility = String(row.payment_responsibility || 'HOTEL_COLLECT').toUpperCase();
  const isOtaCollect = paymentResponsibility === 'OTA_COLLECT';
  const effectivePropertyId = row.booking_property_id ?? row.room_property_id;
  if (effectivePropertyId != null && Number(effectivePropertyId) !== propertyId) {
    return {
      eligible: false,
      guest_name_ok: false,
      guest_phone_ok: false,
      identity_ok: false,
      payment_ok: false,
      payment_evidence_ok: false,
      guarantee_ok: false,
      room_ready_ok: false,
      missing: [
        { code: 'RESERVATION_NOT_FOUND', label: 'Reservation tidak ditemukan atau tidak milik properti ini' },
      ],
    };
  }

  const roomId = Number(row.room_id);

  // ── Gate 1+2: PRIMARY_GUEST name & phone ───────────────────────────────
  const pgRes = await client.query(
    `SELECT g.full_name, g.phone
     FROM reservation_guests rg
     JOIN guests g ON g.id = rg.guest_id
     WHERE rg.reservation_id = $1
       AND rg.role = 'PRIMARY_GUEST'
     LIMIT 1`,
    [reservationId]
  );

  let guestNameOk = false;
  let guestPhoneOk = false;

  if (pgRes.rowCount && pgRes.rowCount > 0) {
    const pg = pgRes.rows[0];
    const name = typeof pg.full_name === 'string' ? pg.full_name.trim() : '';
    const phone = typeof pg.phone === 'string' ? pg.phone.trim() : '';
    guestNameOk = name.length > 0;
    guestPhoneOk = phone.length > 0;
  }
  // If no PRIMARY_GUEST found: both stay false.

  if (!guestNameOk) missing.push({ code: 'PRIMARY_GUEST_NAME_MISSING', label: MISSING_LABELS.PRIMARY_GUEST_NAME_MISSING });
  if (!guestPhoneOk) missing.push({ code: 'PRIMARY_GUEST_PHONE_MISSING', label: MISSING_LABELS.PRIMARY_GUEST_PHONE_MISSING });

  // ── Gate 3: Identity DOCUMENT (not NIK alone) ──────────────────────────
  // identity_ok REQUIRES an actual uploaded document file stored in guests.identity_storage_key.
  // has_valid_identity flag is checked but does NOT substitute for a missing document.
  // identity_number (NIK) alone is NOT sufficient.
  const identityRes = await client.query(
    `SELECT g.identity_storage_key, g.has_valid_identity
     FROM reservation_guests rg
     JOIN guests g ON g.id = rg.guest_id
     WHERE rg.reservation_id = $1
       AND rg.role = 'PRIMARY_GUEST'
     LIMIT 1`,
    [reservationId]
  );

  let identityOk = false;
  if (identityRes.rowCount && identityRes.rowCount > 0) {
    const row = identityRes.rows[0];
    const storageKey = row.identity_storage_key;
    const hasValidIdentity = Boolean(row.has_valid_identity);
    // Must have BOTH an actual uploaded document AND the validation flag
    identityOk = Boolean(storageKey && storageKey.trim().length > 0) && hasValidIdentity;
  }
  // No PRIMARY_GUEST → identityOk stays false.

  if (!identityOk) missing.push({ code: 'IDENTITY_DOCUMENT_MISSING', label: MISSING_LABELS.IDENTITY_DOCUMENT_MISSING });

  // ── Gate 4: Payment ────────────────────────────────────────────────────
  // Use canonical remaining_balance from calculateReservationFinancials()
  // as the authoritative payment state.
  //
  // Rules:
  //   - remaining_balance > 0.01 => PAYMENT_REQUIRED (fail-closed)
  //   - remaining_balance <= 0.01 + qualifying ordinary payment exists => PASS
  //   - remaining_balance <= 0.01 + Approved Complimentary only (no ordinary) => PASS
  //   - mixed ordinary + comp with remaining <= 0.01 => PASS
  //   - pending/rejected/revoked Complimentary => no privilege
  const financials = await calculateReservationFinancials(client, reservationId, effectivePropertyId);
  const remainingBalance = Number.isFinite(financials?.remaining_balance)
    ? Number(financials.remaining_balance)
    : Number.POSITIVE_INFINITY;

  // Check for approved complimentary with zero ordinary payment
  const approvedCompOnly = await hasApprovedComplimentarySettled(client, reservationId, effectivePropertyId);
  const payState = await getEffectivePaymentStateForReservation(
    client, reservationId, effectivePropertyId
  );

  let paymentOk = false;
  if (isOtaCollect) {
    // OTA Collect: hotel payment is not expected; settlement is the OTA's responsibility.
    paymentOk = true;
  } else if (remainingBalance <= 0.01) {
    // Zero-balance: check settlement source
    const hasOrdinaryPayment = payState.qualifyingPositivePaymentExists;
    if (hasOrdinaryPayment || approvedCompOnly) {
      paymentOk = true;
    }
  }

  if (!paymentOk) missing.push({ code: 'PAYMENT_MISSING', label: MISSING_LABELS.PAYMENT_MISSING });

   // ── Gate 5: Payment Evidence ───────────────────────────────────────────
   // Evidence REQUIRED only when ordinary payment exists AND balance is settled.
   // Complimentary-only (no ordinary payment, zero balance) => evidence WAIVED.
   // No payment at all => evidence not required (only PAYMENT_MISSING reported).
   let evidenceCount = 0;
   if (isOtaCollect) {
     const otaVoucherRes = await client.query(
       `SELECT 1
        FROM booking_evidences
        WHERE booking_id = $1
          AND property_id = $2
          AND evidence_type = 'OTA_VOUCHER'
          AND is_active = TRUE
        LIMIT 1`,
       [Number(row.booking_id), effectivePropertyId]
     );
     evidenceCount = otaVoucherRes.rowCount ?? 0;
   } else if (paymentOk && payState.qualifyingPositivePaymentExists) {
     // Ordinary payment exists and balance is zero: require evidence
     const evidenceRows = await getQualifyingEvidenceForReservation(
       client, reservationId, effectivePropertyId
     );
     evidenceCount = evidenceRows.length;
   } else if (paymentOk && approvedCompOnly) {
     // Approved complimentary only (zero balance, no ordinary payment): WAIVE evidence
     evidenceCount = 1; // Waived
   }
   const paymentEvidenceOk = evidenceCount > 0;

   if (!paymentEvidenceOk) {
     if (isOtaCollect) {
       missing.push({ code: 'OTA_VOUCHER_MISSING', label: MISSING_LABELS.OTA_VOUCHER_MISSING });
     } else if (!approvedCompOnly) {
       missing.push({ code: 'PAYMENT_EVIDENCE_MISSING', label: MISSING_LABELS.PAYMENT_EVIDENCE_MISSING });
     }
   }

  // ── Gate 6: Guarantee ──────────────────────────────────────────────────
  // TRUE if EITHER:
  //   A. Active cash deposit with remaining balance > 0 (computed from deposit_events)
  //      - ROOM_RESERVATION scope: reservation_id = target
  //      - BOOKING_GROUP scope: booking_id = target's booking, scope = 'BOOKING_GROUP'
  //   B. Held identity custody (status = 'HELD')
  //      - ROOM_RESERVATION scope: reservation_id = target
  //      - BOOKING_GROUP scope: booking_id = target's booking, scope = 'BOOKING_GROUP'
  // Note: deposits table has no balance_remaining column; balance is derived from deposit_events
  // Using canonical deriveDepositBalance from deposit domain to avoid duplicate accounting logic

  // First, get the booking_id for this reservation (for GROUP scope lookup)
  const bookingRes = await client.query(
    `SELECT b.id AS booking_id
     FROM reservations r
     LEFT JOIN bookings b ON b.id = r.booking_id
     WHERE r.id = $1`,
    [reservationId]
  );
  const targetBookingId = bookingRes.rows[0]?.booking_id ? Number(bookingRes.rows[0].booking_id) : null;

  // Query reservation-scoped deposits (ROOM_RESERVATION)
  const resDepositsRes = await client.query(
    `SELECT id FROM deposits
     WHERE reservation_id = $1
       AND property_id = $2
       AND scope = 'ROOM_RESERVATION'
       AND status IN ('RECEIVED', 'PARTIALLY_USED')`,
    [reservationId, propertyId]
  );

  // Query booking-group-scoped deposits (BOOKING_GROUP)
  let groupDepositsRes: any = { rows: [] };
  if (targetBookingId && targetBookingId > 0) {
    groupDepositsRes = await client.query(
      `SELECT id FROM deposits
       WHERE booking_id = $1
         AND property_id = $2
         AND scope = 'BOOKING_GROUP'
         AND status IN ('RECEIVED', 'PARTIALLY_USED')`,
      [targetBookingId, propertyId]
    );
  }

  let cashDepositCount = 0;
  const allDeposits = [...resDepositsRes.rows, ...groupDepositsRes.rows];
  for (const deposit of allDeposits) {
    const eventsRes = await client.query(
      `SELECT * FROM deposit_events WHERE deposit_id = $1 ORDER BY id`,
      [deposit.id]
    );
    const balance = deriveDepositBalance(eventsRes.rows);
    if (balance.remaining > 0) {
      cashDepositCount++;
    }
  }

  // Query reservation-scoped identity custody (ROOM_RESERVATION)
  const resCustodyRes = await client.query(
    `SELECT COUNT(*) AS cnt
     FROM identity_custody
     WHERE reservation_id = $1
       AND property_id = $2
       AND scope = 'ROOM_RESERVATION'
       AND status = 'HELD'`,
    [reservationId, propertyId]
  );

  // Query booking-group-scoped identity custody (BOOKING_GROUP)
  let groupCustodyRes: any = { rows: [{ cnt: 0 }] };
  if (targetBookingId && targetBookingId > 0) {
    groupCustodyRes = await client.query(
      `SELECT COUNT(*) AS cnt
       FROM identity_custody
       WHERE booking_id = $1
         AND property_id = $2
         AND scope = 'BOOKING_GROUP'
         AND status = 'HELD'`,
      [targetBookingId, propertyId]
    );
  }

  const heldCustodyCount =
    parseInt(resCustodyRes.rows[0].cnt, 10) +
    parseInt(groupCustodyRes.rows[0].cnt, 10);

  const guaranteeOk = cashDepositCount > 0 || heldCustodyCount > 0;

  if (!guaranteeOk) missing.push({ code: 'GUARANTEE_MISSING', label: MISSING_LABELS.GUARANTEE_MISSING });

  // ── Gate 7: Room Ready ─────────────────────────────────────────────────
  // Reuse existing evaluateRoomReadiness — no duplication.
  const roomReadiness = await evaluateRoomReadiness(client, roomId, reservationId);
  const roomReadyOk = roomReadiness.is_ready;

  if (!roomReadyOk) missing.push({ code: 'ROOM_NOT_READY', label: MISSING_LABELS.ROOM_NOT_READY });

  // ── Aggregate ──────────────────────────────────────────────────────────
  const eligible =
    guestNameOk &&
    guestPhoneOk &&
    identityOk &&
    paymentOk &&
    paymentEvidenceOk &&
    guaranteeOk &&
    roomReadyOk;

  return {
    eligible,
    guest_name_ok: guestNameOk,
    guest_phone_ok: guestPhoneOk,
    identity_ok: identityOk,
    payment_ok: paymentOk,
    payment_evidence_ok: paymentEvidenceOk,
    guarantee_ok: guaranteeOk,
    room_ready_ok: roomReadyOk,
    missing,
  };
}

/**
 * hasApprovedComplimentarySettled — Check if reservation has approved
 * complimentary with zero ordinary payment (evidence-waived scenario).
 */
async function hasApprovedComplimentarySettled(
  client: Pool | PoolClient,
  reservationId: number,
  propertyId: number
): Promise<boolean> {
  // Check for approved complimentary request with adjustment
  const compReq = await client.query(
    `SELECT id, applied_adjustment_amount, status
     FROM reservation_complimentary_requests
     WHERE reservation_id = $1
       AND status = 'APPROVED'
       AND applied_adjustment_amount > 0
     LIMIT 1`,
    [reservationId]
  );

  if ((compReq.rowCount ?? 0) === 0) {
    return false;
  }

  // Verify no ordinary payment exists (complimentary-only scenario)
  const payState = await getEffectivePaymentStateForReservation(
    client, reservationId, propertyId
  );

  return !payState.qualifyingPositivePaymentExists;
}

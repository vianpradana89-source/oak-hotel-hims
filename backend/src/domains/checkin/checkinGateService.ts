'use strict';

import type { Pool, PoolClient } from 'pg';
import { evaluateRoomReadiness } from '../turnover/turnoverService';
import { deriveDepositBalance } from '../deposits/depositService';
import { getEffectivePaymentStateForReservation } from '../payments/paymentAllocationService';
import { getQualifyingEvidenceForReservation } from '../payments/paymentEvidenceService';
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
    `SELECT res.id, res.room_id,
            b.property_id AS booking_property_id,
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
  // At least one qualifying positive payment exists for this reservation.
  // Qualifying sources:
  //   A. Direct ROOM_RESERVATION payment with amount > 0
  //   B. ACTIVE allocation from a SUCCESS BOOKING_GROUP payment with
  //      allocated_amount > 0
  // Partial payment is acceptable. Full settlement is NOT required here.
  // Gate 5 (evidence) is intentionally unchanged — group evidence is a 1B3+ concern.
  const payState = await getEffectivePaymentStateForReservation(
    client, reservationId, effectivePropertyId
  );
  const paymentOk = payState.qualifyingPositivePaymentExists;

  if (!paymentOk) missing.push({ code: 'PAYMENT_MISSING', label: MISSING_LABELS.PAYMENT_MISSING });

  // ── Gate 5: Payment Evidence ───────────────────────────────────────────
  // At least one ACTIVE evidence row linked to a qualifying SUCCESS payment_transaction.
  // If no payment exists: evidence_ok = false (explicitly).
  // Supports both direct ROOM_RESERVATION payments and BOOKING_GROUP allocations.
  let evidenceCount = 0;
  if (paymentOk) {
    const evidenceRows = await getQualifyingEvidenceForReservation(
      client, reservationId, effectivePropertyId
    );
    evidenceCount = evidenceRows.length;
  }
  const paymentEvidenceOk = paymentOk && evidenceCount > 0;

  if (!paymentEvidenceOk) missing.push({ code: 'PAYMENT_EVIDENCE_MISSING', label: MISSING_LABELS.PAYMENT_EVIDENCE_MISSING });

  // ── Gate 6: Guarantee ──────────────────────────────────────────────────
  // TRUE if EITHER:
  //   A. Active cash deposit with remaining balance > 0 (computed from deposit_events)
  //   B. Held identity custody (status = 'HELD')
  // Note: deposits table has no balance_remaining column; balance is derived from deposit_events
  // Using canonical deriveDepositBalance from deposit domain to avoid duplicate accounting logic
  const depositsRes = await client.query(
    `SELECT id FROM deposits
     WHERE reservation_id = $1
       AND property_id = $2
       AND status IN ('RECEIVED', 'PARTIALLY_USED')`,
    [reservationId, propertyId]
  );

  let cashDepositCount = 0;
  for (const deposit of depositsRes.rows) {
    const eventsRes = await client.query(
      `SELECT * FROM deposit_events WHERE deposit_id = $1 ORDER BY id`,
      [deposit.id]
    );
    const balance = deriveDepositBalance(eventsRes.rows);
    if (balance.remaining > 0) {
      cashDepositCount++;
    }
  }

  const identityCustodyRes = await client.query(
    `SELECT COUNT(*) AS cnt
     FROM identity_custody
     WHERE reservation_id = $1
       AND property_id = $2
       AND status = 'HELD'`,
    [reservationId, propertyId]
  );

  const heldCustodyCount = parseInt(identityCustodyRes.rows[0].cnt, 10) || 0;
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

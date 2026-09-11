import { Pool, PoolClient } from 'pg';
import {
  ALLOWED_EVIDENCE_TYPES,
  PaymentEvidenceType,
  PaymentEvidenceRow,
  PaymentEvidenceMetadata,
  toEvidenceMetadata
} from './paymentEvidenceTypes';
import {
  saveEvidenceFile,
  deleteEvidenceFile
} from './evidenceStorageService';

export interface UploadEvidenceInput {
  propertyId: number;
  reservationId: number;
  paymentId: number;
  evidenceType: PaymentEvidenceType;
  note?: string | null;
  file: {
    mimetype: string;
    size: number;
    originalname: string;
    buffer: Buffer;
  };
  actorUserId?: string | null;
  actorNameSnapshot?: string | null;
  actorRoleSnapshot?: string | null;
  correlationId?: string | null;
}

export interface DeactivateEvidenceInput {
  propertyId: number;
  reservationId: number;
  paymentId: number;
  evidenceId: number;
  reason: string;
  actorUserId?: string | null;
  actorNameSnapshot?: string | null;
  actorRoleSnapshot?: string | null;
  correlationId?: string | null;
}

export interface RecordEvidenceAccessAuditInput {
  propertyId: number;
  reservationId: number;
  paymentId: number;
  evidenceId: number;
  action: 'PAYMENT_EVIDENCE_VIEWED' | 'PAYMENT_EVIDENCE_DOWNLOADED';
  actorUserId?: string | null;
  actorNameSnapshot?: string | null;
  actorRoleSnapshot?: string | null;
  correlationId?: string | null;
}

// ─── QUERY CLIENT INTERFACE (read-only helpers) ─────────────────────────────
// Both Pool and PoolClient have the query() method signature we need for reads.
// Mutations own their transaction and accept Pool only.
type QueryClient = { query: Pool['query'] };

/**
 * Validates the payment hierarchy for evidence operations.
 * This is an AUTHORIZATION check — it answers "does this reservation
 * legitimately belong to this payment path?" It does NOT check payment
 * gate status (e.g. SUCCESS). Gate status is checked separately by
 * getQualifyingEvidenceForReservation used in Gate 5 of check-in.
 *
 * BOOKING_GROUP full ownership predicate:
 *   pa.reservation_id = r.id
 *   pa.payment_transaction_id = pt.id
 *   pa.property_id = propertyId
 *   pa.booking_id = pt.booking_id        ← same booking
 *   pa.status = 'ACTIVE'
 *   pt.scope = 'BOOKING_GROUP'
 *   pt.property_id = propertyId
 *   pt.id = paymentId
 */
export async function validatePaymentHierarchy(
  pool: QueryClient,
  propertyId: number,
  reservationId: number,
  paymentId: number
): Promise<{
  property: { id: number; name: string };
  reservation: { id: number; booking_id: number; booking_property_id: number };
  payment: { id: number; reservation_id: number; amount: number; transaction_type: string; status: string; scope: string; property_id: number; booking_id: number | null };
}> {
  // 1. Property check
  const propRes = await pool.query('SELECT id, name FROM properties WHERE id = $1', [propertyId]);
  if ((propRes.rowCount ?? 0) === 0) {
    throw { statusCode: 404, code: 'PROPERTY_NOT_FOUND', message: `Property ${propertyId} not found` };
  }

  // 2. Reservation check with authoritative booking ownership + room fallback
  const resRes = await pool.query(
    `SELECT
       res.id,
       res.booking_id,
       b.property_id AS booking_property_id,
       r.property_id AS room_property_id
     FROM reservations res
     LEFT JOIN bookings b ON b.id = res.booking_id
     LEFT JOIN rooms r ON r.id = res.room_id
     WHERE res.id = $1`,
    [reservationId]
  );
  if ((resRes.rowCount ?? 0) === 0) {
    throw { statusCode: 404, code: 'RESERVATION_NOT_FOUND', message: `Reservation ${reservationId} not found` };
  }

  const effectivePropertyId = resRes.rows[0].booking_property_id ?? resRes.rows[0].room_property_id;

  if (effectivePropertyId == null) {
    throw { statusCode: 422, code: 'RESERVATION_INTEGRITY_ERROR', message: 'Reservation lacks authoritative property ownership' };
  }
  if (Number(effectivePropertyId) !== propertyId) {
    throw { statusCode: 403, code: 'CROSS_PROPERTY_RESERVATION', message: 'Reservation belongs to a different property' };
  }

  // 3. Payment check — includes property_id and booking_id in return shape
  const payRes = await pool.query(
    'SELECT id, reservation_id, amount, transaction_type, status, scope, property_id, booking_id FROM payment_transactions WHERE id = $1',
    [paymentId]
  );
  if ((payRes.rowCount ?? 0) === 0) {
    throw { statusCode: 404, code: 'PAYMENT_NOT_FOUND', message: `Payment ${paymentId} not found` };
  }

  const payment = payRes.rows[0];
  const scope = payment.scope;

  if (scope === 'ROOM_RESERVATION') {
    // Direct mode — preserve exact current behavior
    if (Number(payment.reservation_id) !== reservationId) {
      throw { statusCode: 403, code: 'CROSS_RESERVATION_PAYMENT', message: `Payment ${paymentId} does not belong to reservation ${reservationId}` };
    }
    if (payment.property_id != null && Number(payment.property_id) !== propertyId) {
      throw { statusCode: 403, code: 'CROSS_PROPERTY_RESERVATION', message: 'Payment belongs to a different property' };
    }
  } else if (scope === 'BOOKING_GROUP') {
    // Group mode — full ownership predicate
    // Target reservation R:
    // - r.id = reservationId
    // - r.booking_id = payment.booking_id
    // - booking.property_id = propertyId
    // Parent payment P:
    // - pt.id = paymentId
    // - pt.scope = 'BOOKING_GROUP'
    // - pt.property_id = propertyId
    // - pt.booking_id IS NOT NULL
    // - pt.booking_id = r.booking_id
    // Allocation A:
    // - pa.payment_transaction_id = pt.id
    // - pa.reservation_id = r.id
    // - pa.property_id = propertyId
    // - pa.booking_id = pt.booking_id
    // - pa.status = 'ACTIVE'
    // NOTE: We do NOT require pt.status = 'SUCCESS' here — that is Gate 5's job.
    const allocCheck = await pool.query(
      `SELECT 1 FROM payment_allocations pa
       JOIN payment_transactions pt ON pt.id = pa.payment_transaction_id
       JOIN reservations r ON r.id = pa.reservation_id
       JOIN bookings b ON b.id = r.booking_id
       WHERE r.id = $1
         AND pt.id = $2
         AND pa.property_id = $3
         AND pt.property_id = $3
         AND b.property_id = $3
         AND pt.scope = 'BOOKING_GROUP'
         AND pt.booking_id IS NOT NULL
         AND r.booking_id = pt.booking_id
         AND pa.booking_id = pt.booking_id
         AND pa.status = 'ACTIVE'
       LIMIT 1`,
      [reservationId, paymentId, propertyId]
    );
    if ((allocCheck.rowCount ?? 0) === 0) {
      throw { statusCode: 403, code: 'CROSS_RESERVATION_PAYMENT', message: 'Reservation has no active allocation to this BOOKING_GROUP payment' };
    }
  } else {
    throw { statusCode: 400, code: 'VALIDATION_ERROR', message: `Unsupported payment scope: ${scope}` };
  }

  return {
    property: propRes.rows[0],
    reservation: resRes.rows[0],
    payment: payment
  };
}

/**
 * Resolves the canonical anchor reservation for a BOOKING_GROUP payment.
 * Returns the first allocated reservation ordered by (stay_sequence, id).
 *
 * Hierarchy-safe: binds to parent payment's property_id and booking_id.
 * If propertyId or bookingId are omitted, resolves them from the payment row.
 */
export async function resolveEvidenceAnchorReservation(
  pool: QueryClient,
  paymentId: number,
  propertyId?: number,
  bookingId?: number | null
): Promise<number | null> {
  let propId = propertyId;
  let bId = bookingId;

  if (propId === undefined || bId === undefined) {
    const payRes = await pool.query(
      `SELECT property_id, booking_id FROM payment_transactions WHERE id = $1`,
      [paymentId]
    );
    if ((payRes.rowCount ?? 0) === 0) {
      return null;
    }
    propId = payRes.rows[0].property_id;
    bId = payRes.rows[0].booking_id;
  }

  const res = await pool.query(
    `SELECT r.id FROM reservations r
     JOIN payment_allocations pa ON pa.reservation_id = r.id
     WHERE pa.payment_transaction_id = $1
       AND pa.status = 'ACTIVE'
       AND pa.property_id = $2
       AND pa.booking_id = $3
       AND r.booking_id = $3
     ORDER BY r.stay_sequence ASC, r.id ASC
     LIMIT 1`,
    [paymentId, propId, bId]
  );
  return res.rows[0]?.id ?? null;
}

/**
 * Returns all qualifying active evidence rows accessible to a reservation,
 * traversing both direct ROOM_RESERVATION payments and BOOKING_GROUP allocations.
 *
 * Gate 5 ONLY: requires pt.status = 'SUCCESS' for both DIRECT and GROUP modes.
 * This is the strict SUCCESS rule — only evidence linked to successfully settled
 * payments qualifies for check-in eligibility.
 */
export async function getQualifyingEvidenceForReservation(
  pool: QueryClient,
  reservationId: number,
  propertyId: number
): Promise<PaymentEvidenceRow[]> {
  // First check direct evidence (ROOM_RESERVATION, strict SUCCESS required)
  const directRes = await pool.query(
    `SELECT pe.* FROM payment_evidences pe
     WHERE pe.reservation_id = $1
       AND pe.payment_transaction_id IN (
         SELECT pt.id FROM payment_transactions pt
         WHERE pt.reservation_id = $1
           AND (
             pt.property_id = $2
             OR pt.property_id IS NULL
           )
           AND pt.status = 'SUCCESS'
           AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
       )
       AND pe.is_active = TRUE
       AND pe.property_id = $2`,
    [reservationId, propertyId]
  );

  if ((directRes.rowCount ?? 0) > 0) {
    return directRes.rows as PaymentEvidenceRow[];
  }

  // Then check group evidence via allocations (GROUP, strict SUCCESS required)
  // Allocation A: A.reservation_id = reservationId, A.property_id = propertyId, A.booking_id = P.booking_id, A.payment_transaction_id = P.id, A.status = 'ACTIVE'
  // Parent P: P.scope = 'BOOKING_GROUP', P.property_id = propertyId, P.status = 'SUCCESS', P.transaction_type IN ('PAYMENT','CORRECTION_REPLACEMENT')
  // Evidence E: E.payment_transaction_id = P.id, E.property_id = propertyId, E.is_active = TRUE
  // Bind reservation booking to P.booking_id via JOIN reservations r
  const groupRes = await pool.query(
    `SELECT pe.* FROM payment_evidences pe
     JOIN payment_allocations pa ON pa.payment_transaction_id = pe.payment_transaction_id
     JOIN payment_transactions pt ON pt.id = pa.payment_transaction_id
     JOIN reservations r ON r.id = pa.reservation_id
     WHERE pa.reservation_id = $1
       AND pa.property_id = $2
       AND pa.booking_id = pt.booking_id
       AND pa.payment_transaction_id = pt.id
       AND pa.status = 'ACTIVE'
       AND pt.scope = 'BOOKING_GROUP'
       AND pt.property_id = $2
       AND pt.status = 'SUCCESS'
       AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
       AND pe.payment_transaction_id = pt.id
       AND pe.property_id = $2
       AND pe.is_active = TRUE
       AND r.booking_id = pt.booking_id`,
    [reservationId, propertyId]
  );

  return groupRes.rows as PaymentEvidenceRow[];
}

// ─── MUTATION FUNCTIONS — Transaction ownership ─────────────────────────────
// Each mutation accepts Pool, acquires its own client, manages BEGIN/COMMIT/ROLLBACK.
// They NEVER accept PoolClient to avoid nested-transaction semantics.

/**
 * Validates and locks the requesting reservation's allocation to a BOOKING_GROUP payment
 * INSIDE the mutation transaction after the parent payment row has been locked FOR UPDATE.
 * Prevents TOCTOU races if an allocation is reversed/modified between hierarchy check and mutation.
 */
async function lockBookingGroupEvidenceAccess(
  client: PoolClient,
  propertyId: number,
  reservationId: number,
  paymentId: number,
  bookingId: number
): Promise<{ allocationId: number }> {
  const res = await client.query(
    `SELECT pa.id
     FROM payment_allocations pa
     JOIN reservations r ON r.id = pa.reservation_id
     JOIN bookings b ON b.id = r.booking_id
     WHERE pa.payment_transaction_id = $1
       AND pa.reservation_id = $2
       AND pa.property_id = $3
       AND pa.booking_id = $4
       AND r.booking_id = $4
       AND b.property_id = $3
       AND pa.status = 'ACTIVE'
     FOR UPDATE OF pa`,
    [paymentId, reservationId, propertyId, bookingId]
  );

  if ((res.rowCount ?? 0) === 0) {
    throw {
      statusCode: 403,
      code: 'CROSS_RESERVATION_PAYMENT',
      message: 'Reservation does not have active allocation to this group payment'
    };
  }

  return { allocationId: res.rows[0].id };
}

export async function uploadPaymentEvidence(
  pool: Pool,
  input: UploadEvidenceInput
): Promise<PaymentEvidenceMetadata> {
  const payment = input.paymentId;
  const propertyId = input.propertyId;
  const reservationId = input.reservationId;

  // Step A: Basic input/file validation first
  if (!input.file || !input.file.buffer || input.file.size <= 0) {
    throw { statusCode: 400, code: 'VALIDATION_ERROR', message: 'File bukti pembayaran wajib diisi' };
  }

  if (!ALLOWED_EVIDENCE_TYPES.includes(input.evidenceType)) {
    throw {
      statusCode: 400,
      code: 'INVALID_EVIDENCE_TYPE',
      message: `Tipe bukti tidak valid: ${input.evidenceType}. Pilihan yang didukung: ${ALLOWED_EVIDENCE_TYPES.join(', ')}`
    };
  }

  // Step B: Validate hierarchy (authorization) — non-transactional read
  const hierarchy = await validatePaymentHierarchy(pool, propertyId, reservationId, payment);
  const resolvedPayment = hierarchy.payment;

  // Step C: Save file (storage layer may require file-first behavior)
  const saved = await saveEvidenceFile(propertyId, input.file);

  // Step D: Acquire transaction client
  const client = await pool.connect();
  try {
    // Step E: BEGIN transaction
    await client.query('BEGIN');

    // Step F: Acquire lock on parent payment row (serialization primitive)
    const lockRes = await client.query(
      `SELECT id, property_id, booking_id, scope, reservation_id FROM payment_transactions WHERE id = $1 FOR UPDATE`,
      [payment]
    );
    if ((lockRes.rowCount ?? 0) === 0) {
      throw { statusCode: 404, code: 'PAYMENT_NOT_FOUND', message: `Payment ${payment} not found` };
    }
    const lockedPayment = lockRes.rows[0];

    // Step G: INSIDE SAME TRANSACTION — resolve anchor, validate group, check existing evidence
    let effectiveReservationId: number;

    if (lockedPayment.scope === 'BOOKING_GROUP') {
      if (Number(lockedPayment.property_id) !== propertyId) {
        throw { statusCode: 403, code: 'CROSS_PROPERTY_RESERVATION', message: 'Payment belongs to a different property' };
      }

      // Re-validate and lock requesting reservation's active allocation inside transaction
      await lockBookingGroupEvidenceAccess(
        client,
        propertyId,
        reservationId,
        payment,
        lockedPayment.booking_id
      );

      // Resolve deterministic anchor from ACTIVE allocations (hierarchy-safe)
      const anchorId = await resolveEvidenceAnchorReservation(
        client, payment, lockedPayment.property_id, lockedPayment.booking_id
      );
      if (!anchorId) {
        await client.query('ROLLBACK');
        await deleteEvidenceFile(saved.storageKey).catch(() => {});
        throw { statusCode: 409, code: 'NO_ALLOCATION_FOR_EVIDENCE', message: 'No active allocation found for this group payment' };
      }
      effectiveReservationId = anchorId;

      // Check if evidence already exists for this group payment — MUST be inside transaction after lock
      const existingRes = await client.query(
        `SELECT id FROM payment_evidences WHERE payment_transaction_id = $1 AND is_active = TRUE`,
        [payment]
      );
      if ((existingRes.rowCount ?? 0) > 0) {
        await client.query('ROLLBACK');
        await deleteEvidenceFile(saved.storageKey).catch(() => {});
        throw { statusCode: 409, code: 'EVIDENCE_ALREADY_EXISTS', message: 'This booking group already has evidence attached' };
      }
    } else if (lockedPayment.scope === 'ROOM_RESERVATION') {
      if (Number(lockedPayment.reservation_id) !== reservationId) {
        throw { statusCode: 403, code: 'CROSS_RESERVATION_PAYMENT', message: `Payment ${payment} does not belong to reservation ${reservationId}` };
      }
      if (lockedPayment.property_id != null && Number(lockedPayment.property_id) !== propertyId) {
        throw { statusCode: 403, code: 'CROSS_PROPERTY_RESERVATION', message: 'Payment belongs to a different property' };
      }
      // Direct mode — use requesting reservation as anchor
      effectiveReservationId = reservationId;
    } else {
      throw { statusCode: 400, code: 'VALIDATION_ERROR', message: `Unsupported payment scope: ${lockedPayment.scope}` };
    }

    // Step H: INSERT exactly one evidence row
    const now = new Date().toISOString();
    const actorUserId = input.actorUserId || null;
    const actorName = input.actorNameSnapshot || null;
    const actorRole = input.actorRoleSnapshot || null;
    const corrId = input.correlationId || `corr_evid_${Date.now()}`;

    const insertRes = await client.query(
      `INSERT INTO payment_evidences (
        property_id,
        reservation_id,
        payment_transaction_id,
        evidence_type,
        storage_key,
        original_filename,
        mime_type,
        file_size_bytes,
        note,
        is_active,
        uploaded_by_user_id,
        uploaded_by_name_snapshot,
        uploaded_by_role_snapshot,
        uploaded_at,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10, $11, $12, $13, $13, $13)
      RETURNING *`,
      [
        propertyId,
        effectiveReservationId,
        payment,
        input.evidenceType,
        saved.storageKey,
        input.file.originalname || 'evidence',
        input.file.mimetype,
        saved.fileSizeBytes,
        input.note ? input.note.trim() : null,
        actorUserId,
        actorName,
        actorRole,
        now
      ]
    );

    const evidenceRow: PaymentEvidenceRow = insertRes.rows[0];

    // Step I: Audit log
    const auditPayload = {
      event: 'PAYMENT_EVIDENCE_UPLOADED',
      property_id: propertyId,
      reservation_id: effectiveReservationId,
      payment_transaction_id: payment,
      evidence_id: evidenceRow.id,
      evidence_type: evidenceRow.evidence_type,
      original_filename: evidenceRow.original_filename,
      mime_type: evidenceRow.mime_type,
      file_size_bytes: Number(evidenceRow.file_size_bytes),
      actor_user_id: actorUserId,
      actor_name_snapshot: actorName,
      actor_role_snapshot: actorRole,
      reason: null,
      correlation_id: corrId,
      created_at: now
    };

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
        VALUES ('PAYMENT', 'PAYMENT_EVIDENCE_UPLOADED', 'RESERVATION', $1, $2, $3, $4)`,
      [String(effectiveReservationId), JSON.stringify(auditPayload), corrId, propertyId]
    );

    // Step J: COMMIT
    await client.query('COMMIT');
    return toEvidenceMetadata(evidenceRow);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Compensation cleanup: delete saved file from disk
    await deleteEvidenceFile(saved.storageKey).catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getPaymentEvidences(
  pool: QueryClient,
  propertyId: number,
  reservationId: number,
  paymentId: number,
  includeInactive = true
): Promise<PaymentEvidenceMetadata[]> {
  await validatePaymentHierarchy(pool, propertyId, reservationId, paymentId);

  const payRes = await pool.query(
    'SELECT scope FROM payment_transactions WHERE id = $1', [paymentId]
  );
  const scope = payRes.rows[0]?.scope;

  let query;
  let params;

  if (scope === 'BOOKING_GROUP') {
    // Group mode: return evidence by payment_transaction_id, scoped to property
    query = `SELECT * FROM payment_evidences WHERE payment_transaction_id = $1 AND property_id = $2`;
    params = [paymentId, propertyId];
  } else {
    // Direct mode: preserve existing behavior
    query = `SELECT * FROM payment_evidences WHERE property_id = $1 AND reservation_id = $2 AND payment_transaction_id = $3`;
    params = [propertyId, reservationId, paymentId];
  }

  if (!includeInactive) {
    query += ' AND is_active = TRUE';
  }
  query += ' ORDER BY id DESC';

  const res = await pool.query(query, params);
  return (res.rows as unknown as PaymentEvidenceRow[]).map(toEvidenceMetadata);
}

export async function getEvidenceRowById(
  pool: QueryClient,
  propertyId: number,
  reservationId: number,
  paymentId: number,
  evidenceId: number
): Promise<PaymentEvidenceRow> {
  await validatePaymentHierarchy(pool, propertyId, reservationId, paymentId);

  const payRes = await pool.query(
    'SELECT scope FROM payment_transactions WHERE id = $1', [paymentId]
  );
  const scope = payRes.rows[0]?.scope;

  let query;
  let params;

  if (scope === 'BOOKING_GROUP') {
    // Group mode: validate via allocation path, then fetch by payment_transaction_id + property_id.
    // Property guard is REQUIRED — hierarchy validation answered authorization,
    // but property_id in the query prevents cross-property access.
    query = `SELECT * FROM payment_evidences WHERE id = $1 AND property_id = $2 AND payment_transaction_id = $3`;
    params = [evidenceId, propertyId, paymentId];
  } else {
    // Direct mode: preserve existing behavior
    query = `SELECT * FROM payment_evidences WHERE id = $1 AND property_id = $2 AND reservation_id = $3 AND payment_transaction_id = $4`;
    params = [evidenceId, propertyId, reservationId, paymentId];
  }

  const res = await pool.query(query, params);

  if ((res.rowCount ?? 0) === 0) {
    throw { statusCode: 404, code: 'EVIDENCE_NOT_FOUND', message: `Evidence ${evidenceId} not found` };
  }

  return res.rows[0] as unknown as PaymentEvidenceRow;
}

export async function deactivateEvidence(
  pool: Pool,
  input: DeactivateEvidenceInput
): Promise<PaymentEvidenceMetadata> {
  const existing = await getEvidenceRowById(
    pool,
    input.propertyId,
    input.reservationId,
    input.paymentId,
    input.evidenceId
  );

  if (!existing.is_active) {
    throw { statusCode: 409, code: 'EVIDENCE_ALREADY_DEACTIVATED', message: 'Bukti pembayaran sudah dinonaktifkan sebelumnya' };
  }

  if (!input.reason || !input.reason.trim()) {
    throw { statusCode: 400, code: 'DEACTIVATION_REASON_REQUIRED', message: 'Alasan penonaktifan bukti pembayaran wajib diisi' };
  }

  const actorUserId = input.actorUserId || null;
  const actorName = input.actorNameSnapshot || null;
  const actorRole = input.actorRoleSnapshot || null;
  const corrId = input.correlationId || `corr_deact_${Date.now()}`;
  const now = new Date().toISOString();

  // Step D: acquire transaction client
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Acquire lock on parent payment row FOR UPDATE
    const lockRes = await client.query(
      `SELECT id, property_id, booking_id, scope, reservation_id FROM payment_transactions WHERE id = $1 FOR UPDATE`,
      [input.paymentId]
    );
    if ((lockRes.rowCount ?? 0) === 0) {
      throw { statusCode: 404, code: 'PAYMENT_NOT_FOUND', message: `Payment ${input.paymentId} not found` };
    }
    const lockedPayment = lockRes.rows[0];

    if (lockedPayment.scope === 'BOOKING_GROUP') {
      if (Number(lockedPayment.property_id) !== input.propertyId) {
        throw { statusCode: 403, code: 'CROSS_PROPERTY_RESERVATION', message: 'Payment belongs to a different property' };
      }
      await lockBookingGroupEvidenceAccess(
        client,
        input.propertyId,
        input.reservationId,
        input.paymentId,
        lockedPayment.booking_id
      );
    } else if (lockedPayment.scope === 'ROOM_RESERVATION') {
      if (Number(lockedPayment.reservation_id) !== input.reservationId) {
        throw { statusCode: 403, code: 'CROSS_RESERVATION_PAYMENT', message: `Payment ${input.paymentId} does not belong to reservation ${input.reservationId}` };
      }
      if (lockedPayment.property_id != null && Number(lockedPayment.property_id) !== input.propertyId) {
        throw { statusCode: 403, code: 'CROSS_PROPERTY_RESERVATION', message: 'Payment belongs to a different property' };
      }
    } else {
      throw { statusCode: 400, code: 'VALIDATION_ERROR', message: `Unsupported payment scope: ${lockedPayment.scope}` };
    }

    // UPDATE with property_id + payment_transaction_id guards to prevent cross-property updates
    const updateRes = await client.query(
      `UPDATE payment_evidences
       SET is_active = FALSE,
           deactivated_by_user_id = $1,
           deactivated_by_name_snapshot = $2,
           deactivated_by_role_snapshot = $3,
           deactivated_at = $4,
           deactivation_reason = $5,
           updated_at = $4
       WHERE id = $6
         AND property_id = $7
         AND payment_transaction_id = $8
       RETURNING *`,
      [actorUserId, actorName, actorRole, now, input.reason.trim(), input.evidenceId, input.propertyId, input.paymentId]
    );

    const updatedRow: PaymentEvidenceRow = updateRes.rows[0];

    const auditPayload = {
      event: 'PAYMENT_EVIDENCE_DEACTIVATED',
      property_id: input.propertyId,
      reservation_id: input.reservationId,
      payment_transaction_id: input.paymentId,
      evidence_id: input.evidenceId,
      evidence_type: updatedRow.evidence_type,
      original_filename: updatedRow.original_filename,
      mime_type: updatedRow.mime_type,
      file_size_bytes: Number(updatedRow.file_size_bytes),
      actor_user_id: actorUserId,
      actor_name_snapshot: actorName,
      actor_role_snapshot: actorRole,
      reason: input.reason.trim(),
      correlation_id: corrId,
      created_at: now
    };

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ('PAYMENT', 'PAYMENT_EVIDENCE_DEACTIVATED', 'RESERVATION', $1, $2, $3, $4)`,
      [String(input.reservationId), JSON.stringify(auditPayload), corrId, input.propertyId]
    );

    await client.query('COMMIT');
    return toEvidenceMetadata(updatedRow);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface ReplaceEvidenceInput {
  propertyId: number;
  reservationId: number;
  paymentId: number;
  oldEvidenceId: number;
  evidenceType: PaymentEvidenceType;
  note?: string | null;
  file: {
    mimetype: string;
    size: number;
    originalname: string;
    buffer: Buffer;
  };
  actorUserId?: string | null;
  actorNameSnapshot?: string | null;
  actorRoleSnapshot?: string | null;
  correlationId?: string | null;
}

export async function recordEvidenceAccessAudit(
  pool: QueryClient,
  input: RecordEvidenceAccessAuditInput
): Promise<void> {
  const evidence = await getEvidenceRowById(
    pool,
    input.propertyId,
    input.reservationId,
    input.paymentId,
    input.evidenceId
  );

  const actorUserId = input.actorUserId || null;
  const actorName = input.actorNameSnapshot || null;
  const actorRole = input.actorRoleSnapshot || null;
  const corrId = input.correlationId || `corr_access_${Date.now()}`;
  const now = new Date().toISOString();

  const auditPayload = {
    event: input.action,
    property_id: input.propertyId,
    reservation_id: input.reservationId,
    payment_transaction_id: input.paymentId,
    evidence_id: input.evidenceId,
    evidence_type: evidence.evidence_type,
    original_filename: evidence.original_filename,
    mime_type: evidence.mime_type,
    file_size_bytes: Number(evidence.file_size_bytes),
    actor_user_id: actorUserId,
    actor_name_snapshot: actorName,
    actor_role_snapshot: actorRole,
    reason: null,
    correlation_id: corrId,
    created_at: now
  };

  await pool.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ('PAYMENT', $1, 'RESERVATION', $2, $3, $4, $5)`,
    [input.action, String(input.reservationId), JSON.stringify(auditPayload), corrId, input.propertyId]
  );
}

/**
 * Replaces existing evidence with a new file.
 *
 * STABLE ANCHOR BEHAVIOR:
 * - For initial group evidence creation: anchor = first ACTIVE allocation by (stay_sequence, id)
 * - For REPLACEMENT: anchor = stored reservation_id from the old evidence row (immutable audit ownership)
 *
 * The stored anchor is NEVER recomputed during replacement.
 */
export async function replaceEvidence(
  pool: Pool,
  input: ReplaceEvidenceInput
): Promise<{ newEvidence: PaymentEvidenceMetadata; deactivatedEvidence: PaymentEvidenceMetadata | null }> {
  // Step A: validate authorization via hierarchy check (non-transactional)
  const hierarchy = await validatePaymentHierarchy(pool, input.propertyId, input.reservationId, input.paymentId);
  const payment = hierarchy.payment;

  // Step B: Save new file FIRST (before any DB transaction)
  const saved = await saveEvidenceFile(input.propertyId, input.file);

  const actorUserId = input.actorUserId || null;
  const actorName = input.actorNameSnapshot || null;
  const actorRole = input.actorRoleSnapshot || null;
  const corrId = input.correlationId || `corr_replace_${Date.now()}`;
  const now = new Date().toISOString();

  // Step C: acquire transaction client (pool → own client)
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Step D: acquire lock on parent payment row for serialization
    const lockRes = await client.query(
      `SELECT id, property_id, booking_id, scope, reservation_id FROM payment_transactions WHERE id = $1 FOR UPDATE`,
      [input.paymentId]
    );
    if ((lockRes.rowCount ?? 0) === 0) {
      throw { statusCode: 404, code: 'PAYMENT_NOT_FOUND', message: `Payment ${input.paymentId} not found` };
    }
    const lockedPayment = lockRes.rows[0];

    if (lockedPayment.scope === 'BOOKING_GROUP') {
      if (Number(lockedPayment.property_id) !== input.propertyId) {
        throw { statusCode: 403, code: 'CROSS_PROPERTY_RESERVATION', message: 'Payment belongs to a different property' };
      }
      await lockBookingGroupEvidenceAccess(
        client,
        input.propertyId,
        input.reservationId,
        input.paymentId,
        lockedPayment.booking_id
      );
    } else if (lockedPayment.scope === 'ROOM_RESERVATION') {
      if (Number(lockedPayment.reservation_id) !== input.reservationId) {
        throw { statusCode: 403, code: 'CROSS_RESERVATION_PAYMENT', message: `Payment ${input.paymentId} does not belong to reservation ${input.reservationId}` };
      }
      if (lockedPayment.property_id != null && Number(lockedPayment.property_id) !== input.propertyId) {
        throw { statusCode: 403, code: 'CROSS_PROPERTY_RESERVATION', message: 'Payment belongs to a different property' };
      }
    } else {
      throw { statusCode: 400, code: 'VALIDATION_ERROR', message: `Unsupported payment scope: ${lockedPayment.scope}` };
    }

    // Step E: authoritative SELECT FOR UPDATE inside the transaction
    // Retrieve full row including reservation_id (the stored anchor)
    const oldRes = await client.query(
      `SELECT id, reservation_id, property_id, payment_transaction_id, storage_key, original_filename, mime_type, file_size_bytes
       FROM payment_evidences
       WHERE id = $1
         AND property_id = $2
         AND payment_transaction_id = $3
         AND is_active = TRUE
       FOR UPDATE`,
      [input.oldEvidenceId, input.propertyId, input.paymentId]
    );

    if ((oldRes.rowCount ?? 0) === 0) {
      // Another concurrent operation already deactivated this evidence.
      await client.query('ROLLBACK');
      await deleteEvidenceFile(saved.storageKey).catch(() => {});
      throw { statusCode: 409, code: 'EVIDENCE_CONFLICT', message: 'Bukti pembayaran sudah diganti oleh operasi lain' };
    }

    const oldEvidence: PaymentEvidenceRow = oldRes.rows[0];

    // Step F: STABLE ANCHOR — use oldEvidence.reservation_id as the reservation_id of the replacement row.
    // Do NOT recompute anchor from allocations. The stored anchor is immutable audit ownership.
    const stableReservationId = oldEvidence.reservation_id;

    // Step G: Create new payment_evidences row as active (preserving stable anchor)
    const insertRes = await client.query(
      `INSERT INTO payment_evidences (
        property_id, reservation_id, payment_transaction_id,
        evidence_type, storage_key, original_filename,
        mime_type, file_size_bytes, note,
        is_active, uploaded_by_user_id, uploaded_by_name_snapshot, uploaded_by_role_snapshot,
        uploaded_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10, $11, $12, $13, $13, $13)
      RETURNING *`,
      [
        input.propertyId,
        stableReservationId,
        input.paymentId,
        input.evidenceType,
        saved.storageKey,
        input.file.originalname || 'evidence',
        input.file.mimetype,
        saved.fileSizeBytes,
        input.note ? input.note.trim() : null,
        actorUserId,
        actorName,
        actorRole,
        now
      ]
    );

    const newEvidence = toEvidenceMetadata(insertRes.rows[0]);

    // Step H: Deactivate old row WITH multi-column safety guard.
    const deactivateRes = await client.query(
      `UPDATE payment_evidences
       SET is_active = FALSE,
           deactivated_by_user_id = $1,
           deactivated_by_name_snapshot = $2,
           deactivated_by_role_snapshot = $3,
           deactivated_at = $4,
           deactivation_reason = $5,
           updated_at = $4
       WHERE id = $6
         AND property_id = $7
         AND payment_transaction_id = $8
         AND is_active = TRUE
       RETURNING *`,
      [actorUserId, actorName, actorRole, now, 'Diperbarui via Ganti Bukti',
       input.oldEvidenceId, input.propertyId, input.paymentId]
    );

    if ((deactivateRes.rowCount ?? 0) === 0) {
      // Race: another transaction already deactivated this row after our FOR UPDATE.
      await client.query('ROLLBACK');
      await deleteEvidenceFile(saved.storageKey).catch(() => {});
      throw { statusCode: 409, code: 'EVIDENCE_CONFLICT', message: 'Bukti pembayaran sudah diganti oleh operasi lain' };
    }

    const deactivatedEvidence: PaymentEvidenceRow = deactivateRes.rows[0];

    // Step I: Write audit trail
    const auditPayload = {
      event: 'PAYMENT_EVIDENCE_REPLACED',
      property_id: input.propertyId,
      reservation_id: input.reservationId,
      payment_transaction_id: input.paymentId,
      old_evidence_id: input.oldEvidenceId,
      new_evidence_id: newEvidence.id,
      old_filename: oldEvidence.original_filename,
      new_filename: input.file.originalname || 'evidence',
      old_mime_type: oldEvidence.mime_type,
      new_mime_type: input.file.mimetype,
      old_file_size_bytes: Number(oldEvidence.file_size_bytes),
      new_file_size_bytes: saved.fileSizeBytes,
      actor_user_id: actorUserId,
      actor_name_snapshot: actorName,
      actor_role_snapshot: actorRole,
      correlation_id: corrId,
      created_at: now
    };

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ('PAYMENT', 'PAYMENT_EVIDENCE_REPLACED', 'RESERVATION', $1, $2, $3, $4)`,
      [String(stableReservationId), JSON.stringify(auditPayload), corrId, input.propertyId]
    );

    // Step J: Commit DB transaction
    await client.query('COMMIT');

    // Step K: Only AFTER successful commit, delete old physical file.
    await deleteEvidenceFile(oldEvidence.storage_key).catch((err: any) => {
      console.error(`[replaceEvidence] Failed to delete old evidence file ${oldEvidence.storage_key}:`, err);
    });

    return { newEvidence, deactivatedEvidence: toEvidenceMetadata(deactivatedEvidence) };
  } catch (err) {
    // DB transaction failed: compensate by deleting the newly saved physical file.
    await client.query('ROLLBACK').catch(() => {});
    await deleteEvidenceFile(saved.storageKey).catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

import { Pool } from 'pg';
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

export async function validatePaymentHierarchy(
  pool: Pool,
  propertyId: number,
  reservationId: number,
  paymentId: number
): Promise<{
  property: { id: number; name: string };
  reservation: { id: number; booking_id: number; booking_property_id: number };
  payment: { id: number; reservation_id: number; amount: number; transaction_type: string; status: string };
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

  // 3. Payment check
  const payRes = await pool.query(
    'SELECT id, reservation_id, amount, transaction_type, status FROM payment_transactions WHERE id = $1',
    [paymentId]
  );
  if ((payRes.rowCount ?? 0) === 0) {
    throw { statusCode: 404, code: 'PAYMENT_NOT_FOUND', message: `Payment ${paymentId} not found` };
  }
  if (Number(payRes.rows[0].reservation_id) !== reservationId) {
    throw { statusCode: 403, code: 'CROSS_RESERVATION_PAYMENT', message: `Payment ${paymentId} does not belong to reservation ${reservationId}` };
  }

  return {
    property: propRes.rows[0],
    reservation: resRes.rows[0],
    payment: payRes.rows[0]
  };
}

export async function uploadPaymentEvidence(
  pool: Pool,
  input: UploadEvidenceInput
): Promise<PaymentEvidenceMetadata> {
  await validatePaymentHierarchy(pool, input.propertyId, input.reservationId, input.paymentId);

  // Validate evidence type
  if (!ALLOWED_EVIDENCE_TYPES.includes(input.evidenceType)) {
    throw {
      statusCode: 400,
      code: 'INVALID_EVIDENCE_TYPE',
      message: `Tipe bukti tidak valid: ${input.evidenceType}. Pilihan yang didukung: ${ALLOWED_EVIDENCE_TYPES.join(', ')}`
    };
  }

  // Store file in private filesystem
  const saved = await saveEvidenceFile(input.propertyId, input.file);

  const actorUserId = input.actorUserId || null;
  const actorName = input.actorNameSnapshot || null;
  const actorRole = input.actorRoleSnapshot || null;
  const corrId = input.correlationId || `corr_evid_${Date.now()}`;
  const now = new Date().toISOString();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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
        input.propertyId,
        input.reservationId,
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

    const evidenceRow: PaymentEvidenceRow = insertRes.rows[0];

    // Audit log
    const auditPayload = {
      event: 'PAYMENT_EVIDENCE_UPLOADED',
      property_id: input.propertyId,
      reservation_id: input.reservationId,
      payment_transaction_id: input.paymentId,
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
      [String(input.reservationId), JSON.stringify(auditPayload), corrId, input.propertyId]
    );

    await client.query('COMMIT');
    return toEvidenceMetadata(evidenceRow);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Compensation cleanup: delete saved file from disk
    await deleteEvidenceFile(saved.storageKey);
    throw err;
  } finally {
    client.release();
  }
}

export async function getPaymentEvidences(
  pool: Pool,
  propertyId: number,
  reservationId: number,
  paymentId: number,
  includeInactive = true
): Promise<PaymentEvidenceMetadata[]> {
  await validatePaymentHierarchy(pool, propertyId, reservationId, paymentId);

  let query = `
    SELECT * FROM payment_evidences
    WHERE property_id = $1 AND reservation_id = $2 AND payment_transaction_id = $3
  `;
  if (!includeInactive) {
    query += ' AND is_active = TRUE';
  }
  query += ' ORDER BY id DESC';

  const res = await pool.query(query, [propertyId, reservationId, paymentId]);
  return res.rows.map(toEvidenceMetadata);
}

export async function getEvidenceRowById(
  pool: Pool,
  propertyId: number,
  reservationId: number,
  paymentId: number,
  evidenceId: number
): Promise<PaymentEvidenceRow> {
  await validatePaymentHierarchy(pool, propertyId, reservationId, paymentId);

  const res = await pool.query(
    `SELECT * FROM payment_evidences
     WHERE id = $1 AND property_id = $2 AND reservation_id = $3 AND payment_transaction_id = $4`,
    [evidenceId, propertyId, reservationId, paymentId]
  );

  if ((res.rowCount ?? 0) === 0) {
    throw { statusCode: 404, code: 'EVIDENCE_NOT_FOUND', message: `Evidence ${evidenceId} not found` };
  }

  return res.rows[0];
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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
       RETURNING *`,
      [actorUserId, actorName, actorRole, now, input.reason.trim(), input.evidenceId]
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
  pool: Pool,
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

export async function replaceEvidence(
  pool: Pool,
  input: ReplaceEvidenceInput
): Promise<{ newEvidence: PaymentEvidenceMetadata; deactivatedEvidence: PaymentEvidenceMetadata | null }> {
  // Step A: validate authorization via hierarchy check (non-transactional)
  await validatePaymentHierarchy(pool, input.propertyId, input.reservationId, input.paymentId);

  // Step B: Save new file FIRST (before any DB transaction) — must persist before we touch DB
  const saved = await saveEvidenceFile(input.propertyId, input.file);

  const actorUserId = input.actorUserId || null;
  const actorName = input.actorNameSnapshot || null;
  const actorRole = input.actorRoleSnapshot || null;
  const corrId = input.correlationId || `corr_replace_${Date.now()}`;
  const now = new Date().toISOString();

  // Step C: acquire PoolClient and hold SELECT FOR UPDATE inside the transaction
  // This prevents concurrent replacements from both observing the same old evidence as active.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Step D: authoritative SELECT WITH FOR UPDATE inside the transaction.
    // If another concurrent replacement already deactivated this row, rowCount=0 here
    // and we roll back, compensating the newly saved file.
    const oldRes = await client.query(
      `SELECT id, storage_key, original_filename, mime_type, file_size_bytes
       FROM payment_evidences
       WHERE id = $1
         AND property_id = $2
         AND reservation_id = $3
         AND payment_transaction_id = $4
         AND is_active = TRUE
       FOR UPDATE`,
      [input.oldEvidenceId, input.propertyId, input.reservationId, input.paymentId]
    );

    if ((oldRes.rowCount ?? 0) === 0) {
      // Another concurrent operation already deactivated this evidence.
      // Roll back and compensate the newly saved physical file.
      await client.query('ROLLBACK');
      await deleteEvidenceFile(saved.storageKey).catch(() => {});
      throw { statusCode: 409, code: 'EVIDENCE_CONFLICT', message: 'Bukti pembayaran sudah diganti oleh operasi lain' };
    }

    const oldEvidence: PaymentEvidenceRow = oldRes.rows[0];

    // Step E: Create new payment_evidences row as active
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
        input.reservationId,
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

    // Step F: Deactivate old row WITH multi-column safety guard.
    // WHERE conditions confirm identity + ownership + current active state.
    // rowCount=0 means the row was already deactivated by another concurrent op — abort.
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
         AND reservation_id = $8
         AND payment_transaction_id = $9
         AND is_active = TRUE
       RETURNING *`,
      [actorUserId, actorName, actorRole, now, 'Diperbarui via Ganti Bukti',
       input.oldEvidenceId, input.propertyId, input.reservationId, input.paymentId]
    );

    if ((deactivateRes.rowCount ?? 0) === 0) {
      // Race: another transaction already deactivated this row after our FOR UPDATE.
      // This should be extremely rare (FOR UPDATE should serialize), but defensively abort.
      await client.query('ROLLBACK');
      await deleteEvidenceFile(saved.storageKey).catch(() => {});
      throw { statusCode: 409, code: 'EVIDENCE_CONFLICT', message: 'Bukti pembayaran sudah diganti oleh operasi lain' };
    }

    const deactivatedEvidence: PaymentEvidenceRow = deactivateRes.rows[0];

    // Step G: Write audit trail
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
      [String(input.reservationId), JSON.stringify(auditPayload), corrId, input.propertyId]
    );

    // Step H: Commit DB transaction
    await client.query('COMMIT');

    // Step I: Only AFTER successful commit, delete old physical file.
    // Cleanup failure does NOT rollback the successful replacement.
    await deleteEvidenceFile(oldEvidence.storage_key).catch((err: any) => {
      console.error(`[replaceEvidence] Failed to delete old evidence file ${oldEvidence.storage_key}:`, err);
    });

    return { newEvidence, deactivatedEvidence: toEvidenceMetadata(deactivatedEvidence) };
  } catch (err) {
    // DB transaction failed (including SELECT FOR UPDATE miss or INSERT error):
    // compensate by deleting the newly saved physical file.
    await client.query('ROLLBACK').catch(() => {});
    await deleteEvidenceFile(saved.storageKey).catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

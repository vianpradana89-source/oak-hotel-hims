import { Pool } from 'pg';
import {
  PaymentEvidenceType,
  PaymentEvidenceRow,
  PaymentEvidenceMetadata,
  toEvidenceMetadata
} from './paymentEvidenceTypes';
import {
  saveEvidenceFile,
  deleteEvidenceFile,
  validateEvidenceUpload
} from './evidenceStorageService';

export interface CreatePaymentCoreInput {
  propertyId: number;
  reservationId: number;
  amount: number;
  paymentMethod?: string;
  referenceCode?: string | null;
  transactionType?: string;
  requireEvidence?: boolean;
  file?: {
    buffer: Buffer;
    mimetype: string;
    originalname: string;
    size: number;
  } | null;
  evidenceType?: PaymentEvidenceType;
  evidenceNote?: string | null;
  actorUserId?: string | null;
  actorNameSnapshot?: string | null;
  actorRoleSnapshot?: string | null;
  correlationId?: string | null;
}

export interface CreatePaymentCoreResult {
  payment: any;
  reservation: any;
  evidence?: PaymentEvidenceMetadata | null;
}

export async function createPaymentCore(
  pool: Pool,
  input: CreatePaymentCoreInput
): Promise<CreatePaymentCoreResult> {
  const {
    propertyId,
    reservationId,
    amount,
    paymentMethod = 'CASH',
    referenceCode = null,
    transactionType = 'PAYMENT',
    requireEvidence = false,
    file = null,
    evidenceType,
    evidenceNote = null,
    actorUserId = null,
    actorNameSnapshot = null,
    actorRoleSnapshot = null,
    correlationId = null
  } = input;

  // 1. Validation
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw { statusCode: 400, code: 'VALIDATION_ERROR', message: 'property_id is required' };
  }
  if (!Number.isInteger(reservationId) || reservationId <= 0) {
    throw { statusCode: 400, code: 'VALIDATION_ERROR', message: 'invalid reservation id' };
  }
  const paymentAmount = Number(amount);
  if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
    throw { statusCode: 400, code: 'VALIDATION_ERROR', message: 'amount must be greater than zero' };
  }
  if (!Number.isInteger(paymentAmount)) {
    throw { statusCode: 400, code: 'VALIDATION_ERROR', message: 'amount must be an integer (IDR currency does not support decimal amounts)' };
  }

  // 2. Evidence validation
  if (requireEvidence && !file) {
    throw {
      statusCode: 400,
      code: 'PAYMENT_EVIDENCE_REQUIRED',
      message: 'Bukti pembayaran wajib dilampirkan untuk penerimaan pembayaran Front Office'
    };
  }

  if (file) {
    const fileValidation = validateEvidenceUpload(file);
    if (!fileValidation.valid) {
      throw {
        statusCode: 400,
        code: fileValidation.code || 'INVALID_FILE',
        message: fileValidation.error || 'File bukti pembayaran tidak valid'
      };
    }
  }

  let savedStorageKey: string | null = null;
  const client = await pool.connect();

  try {
    const propCheck = await client.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
    if ((propCheck.rowCount ?? 0) === 0) {
      throw { statusCode: 404, code: 'PROPERTY_NOT_FOUND', message: `property ${propertyId} not found` };
    }

    await client.query('BEGIN');

    const reservationRes = await client.query(`
      SELECT
        r.id,
        r.total_price,
        r.amount_paid,
        r.payment_status,
        r.booking_id,
        b.property_id AS booking_property_id
      FROM reservations r
      LEFT JOIN bookings b ON b.id = r.booking_id
      WHERE r.id = $1
      FOR UPDATE OF r
    `, [reservationId]);

    if ((reservationRes.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      throw { statusCode: 404, code: 'RESERVATION_NOT_FOUND', message: 'reservation not found' };
    }

    const bookingPropertyId = reservationRes.rows[0].booking_property_id;
    if (bookingPropertyId === null || bookingPropertyId === undefined) {
      await client.query('ROLLBACK');
      throw { statusCode: 422, code: 'RESERVATION_INTEGRITY_ERROR', message: 'Reservation lacks authoritative booking property ownership' };
    }

    if (Number(bookingPropertyId) !== propertyId) {
      await client.query('ROLLBACK');
      throw { statusCode: 403, code: 'CROSS_PROPERTY_RESERVATION', message: 'Reservation belongs to a different property' };
    }

    const currentPaid = Math.round(Number(reservationRes.rows[0].amount_paid || 0));
    const totalPrice = Math.round(Number(reservationRes.rows[0].total_price || 0));
    const currentRemaining = Math.max(totalPrice - currentPaid, 0);

    if (paymentAmount > currentRemaining) {
      await client.query('ROLLBACK');
      throw {
        statusCode: 400,
        code: 'OVERPAYMENT_NOT_ALLOWED',
        message: 'Nominal pembayaran melebihi sisa tagihan',
        details: {
          payment_amount: paymentAmount,
          remaining_balance: currentRemaining,
          total_price: totalPrice,
          amount_paid: currentPaid
        }
      };
    }

    const updatedAmountPaid = currentPaid + paymentAmount;
    const updatedRemaining = totalPrice - updatedAmountPaid;
    const updatedPaymentStatus = updatedAmountPaid <= 0 ? 'UNPAID' : updatedRemaining === 0 ? 'PAID' : 'PARTIAL';

    const corrId = correlationId || `corr_pmt_${reservationId}_${Date.now()}`;

    // 3. Save physical file if provided
    let savedEvidence: { storageKey: string; absolutePath: string; fileSizeBytes: number } | null = null;
    if (file) {
      savedEvidence = await saveEvidenceFile(propertyId, file);
      savedStorageKey = savedEvidence.storageKey;
    }

    // 4. Insert payment_transactions
    const payInsert = await client.query(`
      INSERT INTO payment_transactions (
        reservation_id,
        transaction_type,
        amount,
        payment_method,
        reference_code,
        status,
        created_by,
        correction_group_id
      )
      VALUES ($1, $2, $3, $4, $5, 'SUCCESS', $6, $7)
      RETURNING *
    `, [
      reservationId,
      transactionType,
      paymentAmount,
      paymentMethod,
      referenceCode || `TXN-${Date.now()}`,
      actorNameSnapshot,
      corrId
    ]);
    const paymentRow = payInsert.rows[0];

    // 5. Insert folio_entries
    await client.query(`
      INSERT INTO folio_entries (
        reservation_id,
        property_id,
        entry_type,
        description,
        amount,
        direction
      )
      VALUES ($1, $2, $3, $4, $5, 'CREDIT')
    `, [
      reservationId,
      propertyId,
      transactionType,
      'Pembayaran tamu',
      paymentAmount
    ]);

    // 6. Insert payment_evidences if file attached
    let evidenceRow: any = null;
    if (savedEvidence && file) {
      const defaultEvType = paymentMethod === 'BANK_TRANSFER' ? 'BANK_TRANSFER' : paymentMethod === 'QRIS' ? 'QRIS_RECEIPT' : paymentMethod === 'CARD' ? 'EDC_SLIP' : 'CASH_RECEIPT';
      const evType = evidenceType || defaultEvType;

      const evInsert = await client.query(`
        INSERT INTO payment_evidences (
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
          uploaded_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10, $11, $12, CURRENT_TIMESTAMP)
        RETURNING *
      `, [
        propertyId,
        reservationId,
        paymentRow.id,
        evType,
        savedEvidence.storageKey,
        file.originalname,
        file.mimetype,
        savedEvidence.fileSizeBytes,
        evidenceNote,
        actorUserId,
        actorNameSnapshot,
        actorRoleSnapshot
      ]);
      evidenceRow = evInsert.rows[0];

      const evidenceAuditPayload = {
        event: 'PAYMENT_EVIDENCE_UPLOADED',
        evidence_id: evidenceRow.id,
        payment_transaction_id: paymentRow.id,
        reservation_id: reservationId,
        property_id: propertyId,
        evidence_type: evType,
        original_filename: file.originalname,
        mime_type: file.mimetype,
        file_size_bytes: savedEvidence.fileSizeBytes,
        actor_user_id: actorUserId,
        actor_name_snapshot: actorNameSnapshot,
        actor_role_snapshot: actorRoleSnapshot,
        correlation_id: corrId,
        timestamp: new Date().toISOString()
      };
      await client.query(`
        INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
        VALUES ('PAYMENT', 'PAYMENT_EVIDENCE_UPLOADED', 'RESERVATION', $1, $2, $3, $4)
      `, [String(reservationId), JSON.stringify(evidenceAuditPayload), corrId, propertyId]);
    }

    // 7. Update reservation
    const updated = await client.query(`
      UPDATE reservations
      SET
        amount_paid = $1,
        remaining_balance = $2,
        payment_status = $3
      WHERE id = $4
      RETURNING *
    `, [updatedAmountPaid, updatedRemaining, updatedPaymentStatus, reservationId]);

    // 8. Audit log for payment created
    const paymentAuditPayload = {
      event: 'PAYMENT_CREATED',
      payment_transaction_id: paymentRow.id,
      payment_id: paymentRow.id,
      reservation_id: reservationId,
      amount: paymentAmount,
      payment_method: paymentMethod,
      actor_user_id: actorUserId,
      actor_id: actorUserId,
      actor_name_snapshot: actorNameSnapshot,
      actor_name: actorNameSnapshot,
      actor_role_snapshot: actorRoleSnapshot,
      actor_role: actorRoleSnapshot,
      property_id: propertyId,
      correlation_id: corrId,
      has_evidence: !!evidenceRow,
      evidence_id: evidenceRow ? evidenceRow.id : null,
      created_at: new Date().toISOString(),
      timestamp: new Date().toISOString()
    };
    await client.query(`
      INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
      VALUES ('PAYMENT', 'PAYMENT_CREATED', 'RESERVATION', $1, $2, $3, $4)
    `, [String(reservationId), JSON.stringify(paymentAuditPayload), corrId, propertyId]);

    await client.query('COMMIT');

    return {
      payment: paymentRow,
      reservation: updated.rows[0],
      evidence: evidenceRow ? toEvidenceMetadata(evidenceRow) : null
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (savedStorageKey) {
      await deleteEvidenceFile(savedStorageKey).catch(() => {});
    }
    throw err;
  } finally {
    client.release();
  }
}

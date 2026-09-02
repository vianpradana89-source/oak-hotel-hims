import { Pool, PoolClient } from 'pg';
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
import { recalculateReservationFinancials } from '../stayCharges/stayChargesService';

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
  recalculateFromFolio?: boolean;
}

export interface CreatePaymentCoreResult {
  payment: any;
  reservation: any;
  evidence?: PaymentEvidenceMetadata | null;
}

export interface SavedPaymentEvidenceFile {
  storageKey: string;
  absolutePath: string;
  fileSizeBytes: number;
}

export async function createPaymentInTransaction(
  client: PoolClient,
  input: CreatePaymentCoreInput,
  savedEvidence: SavedPaymentEvidenceFile | null
): Promise<CreatePaymentCoreResult> {
  const propertyId = input.propertyId;
  const reservationId = input.reservationId;
  const paymentAmount = Number(input.amount);
  const paymentMethod = input.paymentMethod || 'CASH';
  const transactionType = input.transactionType || 'PAYMENT';
  const corrId = input.correlationId || `corr_pmt_${reservationId}_${Date.now()}`;

  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw { statusCode: 400, code: 'VALIDATION_ERROR', message: 'property_id is required' };
  }
  if (!Number.isInteger(reservationId) || reservationId <= 0) {
    throw { statusCode: 400, code: 'VALIDATION_ERROR', message: 'invalid reservation id' };
  }
  if (!Number.isInteger(paymentAmount) || paymentAmount <= 0) {
    throw { statusCode: 400, code: 'VALIDATION_ERROR', message: 'amount must be a positive integer' };
  }
  if (['DEPOSIT', 'DEPOSIT_REFUND'].includes(String(transactionType).toUpperCase())) {
    throw { statusCode: 400, code: 'DEPOSIT_ENDPOINT_REQUIRED', message: 'Deposit cash movements must use the canonical deposit service' };
  }
  if (input.requireEvidence && (!input.file || !savedEvidence)) {
    throw { statusCode: 400, code: 'PAYMENT_EVIDENCE_REQUIRED', message: 'Bukti pembayaran wajib dilampirkan untuk penerimaan pembayaran Front Office' };
  }

  const propCheck = await client.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
  if ((propCheck.rowCount ?? 0) === 0) {
    throw { statusCode: 404, code: 'PROPERTY_NOT_FOUND', message: `property ${propertyId} not found` };
  }

  const reservationRes = await client.query(`
    SELECT r.id, r.total_price, r.amount_paid, r.applied_deposit,
           r.payment_status, r.booking_id, b.property_id AS booking_property_id
    FROM reservations r
    LEFT JOIN bookings b ON b.id = r.booking_id
    WHERE r.id = $1
    FOR UPDATE OF r
  `, [reservationId]);
  if ((reservationRes.rowCount ?? 0) === 0) {
    throw { statusCode: 404, code: 'RESERVATION_NOT_FOUND', message: 'reservation not found' };
  }

  const bookingPropertyId = reservationRes.rows[0].booking_property_id;
  if (bookingPropertyId === null || bookingPropertyId === undefined) {
    throw { statusCode: 422, code: 'RESERVATION_INTEGRITY_ERROR', message: 'Reservation lacks authoritative booking property ownership' };
  }
  if (Number(bookingPropertyId) !== propertyId) {
    throw { statusCode: 403, code: 'CROSS_PROPERTY_RESERVATION', message: 'Reservation belongs to a different property' };
  }

  const currentPaid = Math.round(Number(reservationRes.rows[0].amount_paid || 0));
  const currentAppliedDeposit = Math.round(Number(reservationRes.rows[0].applied_deposit || 0));
  const totalPrice = Math.round(Number(reservationRes.rows[0].total_price || 0));
  const currentRemaining = Math.max(totalPrice - currentPaid - currentAppliedDeposit, 0);
  if (paymentAmount > currentRemaining) {
    throw {
      statusCode: 400,
      code: 'OVERPAYMENT_NOT_ALLOWED',
      message: 'Nominal pembayaran melebihi sisa tagihan',
      details: { payment_amount: paymentAmount, remaining_balance: currentRemaining, total_price: totalPrice, amount_paid: currentPaid }
    };
  }

  const payInsert = await client.query(`
    INSERT INTO payment_transactions (
      reservation_id, transaction_type, amount, payment_method, reference_code,
      status, created_by, correction_group_id
    ) VALUES ($1, $2, $3, $4, $5, 'SUCCESS', $6, $7)
    RETURNING *
  `, [
    reservationId, transactionType, paymentAmount, paymentMethod,
    input.referenceCode || `TXN-${Date.now()}`, input.actorNameSnapshot, corrId
  ]);
  const paymentRow = payInsert.rows[0];

  await client.query(`
    INSERT INTO folio_entries (
      reservation_id, property_id, entry_type, description, amount, direction
    ) VALUES ($1, $2, $3, $4, $5, 'CREDIT')
  `, [reservationId, propertyId, transactionType, 'Pembayaran tamu', paymentAmount]);

  let evidenceRow: any = null;
  if (savedEvidence && input.file) {
    const defaultEvType = ['TRANSFER', 'BANK_TRANSFER'].includes(paymentMethod) ? 'BANK_TRANSFER'
      : paymentMethod === 'QRIS' ? 'QRIS_RECEIPT'
      : ['CARD', 'DEBIT_CARD', 'CREDIT_CARD'].includes(paymentMethod) ? 'EDC_SLIP'
      : 'CASH_RECEIPT';
    const evType = input.evidenceType || defaultEvType;
    const evInsert = await client.query(`
      INSERT INTO payment_evidences (
        property_id, reservation_id, payment_transaction_id, evidence_type,
        storage_key, original_filename, mime_type, file_size_bytes, note,
        is_active, uploaded_by_user_id, uploaded_by_name_snapshot,
        uploaded_by_role_snapshot, uploaded_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10, $11, $12, CURRENT_TIMESTAMP)
      RETURNING *
    `, [
      propertyId, reservationId, paymentRow.id, evType, savedEvidence.storageKey,
      input.file.originalname, input.file.mimetype, savedEvidence.fileSizeBytes,
      input.evidenceNote, input.actorUserId, input.actorNameSnapshot, input.actorRoleSnapshot
    ]);
    evidenceRow = evInsert.rows[0];

    await client.query(`
      INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
      VALUES ('PAYMENT', 'PAYMENT_EVIDENCE_UPLOADED', 'RESERVATION', $1, $2, $3, $4)
    `, [String(reservationId), JSON.stringify({
      event: 'PAYMENT_EVIDENCE_UPLOADED', evidence_id: evidenceRow.id,
      payment_transaction_id: paymentRow.id, reservation_id: reservationId,
      property_id: propertyId, evidence_type: evType,
      original_filename: input.file.originalname, mime_type: input.file.mimetype,
      file_size_bytes: savedEvidence.fileSizeBytes,
      actor_user_id: input.actorUserId,
      actor_name_snapshot: input.actorNameSnapshot,
      actor_role_snapshot: input.actorRoleSnapshot,
      correlation_id: corrId, timestamp: new Date().toISOString()
    }), corrId, propertyId]);
  }

  await client.query(`
    INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
    VALUES ('PAYMENT', 'PAYMENT_CREATED', 'RESERVATION', $1, $2, $3, $4)
  `, [String(reservationId), JSON.stringify({
    event: 'PAYMENT_CREATED', payment_transaction_id: paymentRow.id,
    payment_id: paymentRow.id,
    reservation_id: reservationId, amount: paymentAmount,
    payment_method: paymentMethod, actor_user_id: input.actorUserId,
    actor_id: input.actorUserId,
    actor_name_snapshot: input.actorNameSnapshot, actor_role_snapshot: input.actorRoleSnapshot,
    actor_name: input.actorNameSnapshot,
    actor_role: input.actorRoleSnapshot,
    property_id: propertyId, correlation_id: corrId,
    has_evidence: Boolean(evidenceRow), evidence_id: evidenceRow?.id || null,
    created_at: new Date().toISOString(), timestamp: new Date().toISOString()
  }), corrId, propertyId]);

  let updatedReservation: any;
  if (input.recalculateFromFolio) {
    const financials = await recalculateReservationFinancials(client, reservationId, propertyId, currentPaid);
    updatedReservation = financials.reservation;
  } else {
    const updatedAmountPaid = currentPaid + paymentAmount;
    const effectiveSettlement = updatedAmountPaid + currentAppliedDeposit;
    const updatedRemaining = Math.max(0, totalPrice - effectiveSettlement);
    const updatedPaymentStatus = effectiveSettlement <= 0 ? 'UNPAID' : updatedRemaining === 0 ? 'PAID' : 'PARTIAL';
    const updated = await client.query(`
      UPDATE reservations
      SET amount_paid = $1, applied_deposit = $2, remaining_balance = $3, payment_status = $4
      WHERE id = $5 RETURNING *
    `, [updatedAmountPaid, currentAppliedDeposit, updatedRemaining, updatedPaymentStatus, reservationId]);
    updatedReservation = updated.rows[0];
  }
  return {
    payment: paymentRow,
    reservation: updatedReservation,
    evidence: evidenceRow ? toEvidenceMetadata(evidenceRow) : null
  };
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
  if (['DEPOSIT', 'DEPOSIT_REFUND'].includes(String(transactionType).toUpperCase())) {
    throw {
      statusCode: 400,
      code: 'DEPOSIT_ENDPOINT_REQUIRED',
      message: 'Deposit cash movements must use the canonical deposit service'
    };
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
    await client.query('BEGIN');
    let savedEvidence: { storageKey: string; absolutePath: string; fileSizeBytes: number } | null = null;
    if (file) {
      savedEvidence = await saveEvidenceFile(propertyId, file);
      savedStorageKey = savedEvidence.storageKey;
    }
    const result = await createPaymentInTransaction(client, input, savedEvidence);
    await client.query('COMMIT');
    return result;
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

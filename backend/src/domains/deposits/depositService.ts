import crypto from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { deleteEvidenceFile, saveEvidenceFile, validateEvidenceUpload } from '../payments/evidenceStorageService';
import { recalculateReservationFinancials } from '../stayCharges/stayChargesService';
import { generateDepositNumber } from './depositNumberService';
import type {
  ApplyDepositInput,
  DepositBalanceSummary,
  DepositEventType,
  DepositReconciliationIssue,
  DepositStatus,
  EvidenceUpload,
  ReceiveDepositInput,
  RefundDepositInput,
  ReverseDepositInput
} from './depositTypes';

const SUPPORTED_PAYMENT_METHODS = new Set([
  'CASH',
  'TRANSFER',
  'BANK_TRANSFER',
  'QRIS',
  'CARD',
  'DEBIT_CARD',
  'CREDIT_CARD'
]);

function domainError(statusCode: number, code: string, message: string, details?: unknown): Error {
  return Object.assign(new Error(message), { statusCode, code, details });
}

function requirePositiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw domainError(400, 'VALIDATION_ERROR', `${field} must be a positive integer`);
  }
  return parsed;
}

function normalizePaymentMethod(value: unknown): string {
  const method = String(value || '').trim().toUpperCase();
  if (!SUPPORTED_PAYMENT_METHODS.has(method)) {
    throw domainError(400, 'UNSUPPORTED_PAYMENT_METHOD', 'Unsupported payment method');
  }
  return method;
}

function validateIdempotencyKey(value: unknown): string {
  const key = String(value || '').trim();
  if (!key || key.length > 150) {
    throw domainError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'A valid idempotency key is required');
  }
  return key;
}

function validateEvidence(file?: EvidenceUpload | null): void {
  if (!file) return;
  const validation = validateEvidenceUpload(file);
  if (!validation.valid) {
    throw domainError(400, validation.code || 'INVALID_FILE', validation.error || 'Invalid payment evidence');
  }
}

function asInteger(value: unknown): number {
  const parsed = Number(value || 0);
  if (!Number.isSafeInteger(parsed)) {
    throw domainError(409, 'DEPOSIT_INVARIANT_VIOLATION', 'Deposit amount exceeds safe integer range');
  }
  return parsed;
}

export function deriveDepositBalance(events: any[]): DepositBalanceSummary {
  let effectiveReceived = 0;
  let applied = 0;
  let refunded = 0;
  let reversedReceived = 0;

  for (const event of events) {
    const amount = asInteger(event.amount);
    switch (String(event.event_type) as DepositEventType) {
      case 'RECEIVED':
        effectiveReceived += amount;
        break;
      case 'APPLY':
        applied += amount;
        break;
      case 'REFUND':
        refunded += amount;
        break;
      case 'REVERSAL':
        if (String(event.reversed_event_type || 'RECEIVED') !== 'RECEIVED') {
          throw domainError(409, 'UNSUPPORTED_REVERSAL', 'Phase 1A only supports reversal of RECEIVED events');
        }
        reversedReceived += amount;
        break;
      default:
        throw domainError(409, 'DEPOSIT_INVARIANT_VIOLATION', `Unknown deposit event type ${event.event_type}`);
    }
  }

  effectiveReceived -= reversedReceived;
  const remaining = effectiveReceived - applied - refunded;
  if (effectiveReceived < 0 || remaining < 0 || applied + refunded > effectiveReceived) {
    throw domainError(409, 'DEPOSIT_INVARIANT_VIOLATION', 'Derived deposit balance is negative or over-consumed', {
      effective_received: effectiveReceived,
      applied,
      refunded,
      reversed_received: reversedReceived,
      remaining
    });
  }

  let status: DepositStatus;
  if (reversedReceived > 0 && effectiveReceived === 0 && applied === 0 && refunded === 0) {
    status = 'CANCELLED';
  } else if (remaining === 0 && (applied > 0 || refunded > 0)) {
    status = 'CLOSED';
  } else if (remaining > 0 && remaining < effectiveReceived) {
    status = 'PARTIALLY_USED';
  } else {
    status = 'RECEIVED';
  }

  return {
    effective_received: effectiveReceived,
    applied,
    refunded,
    reversed_received: reversedReceived,
    remaining,
    status
  };
}

async function lockReservation(client: PoolClient, propertyId: number, reservationId: number): Promise<any> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('oak_deposit_' || $1))`,
    [reservationId]
  );
  const result = await client.query(
    `SELECT r.*, b.property_id AS booking_property_id
     FROM reservations r
     LEFT JOIN bookings b ON b.id = r.booking_id
     WHERE r.id = $1
     FOR UPDATE OF r`,
    [reservationId]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw domainError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found');
  }
  const reservation = result.rows[0];
  if (Number(reservation.booking_property_id) !== propertyId) {
    throw domainError(403, 'CROSS_PROPERTY_RESERVATION', 'Reservation belongs to a different property');
  }
  return reservation;
}

async function lockIdempotencyKey(client: PoolClient, propertyId: number, idempotencyKey: string): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('oak_deposit_idempotency_' || $1 || '_' || $2))`,
    [propertyId, idempotencyKey]
  );
}

function assertReservationOpenForDeposit(reservation: any, operation: 'receive' | 'apply'): void {
  const status = String(reservation.status || '').toUpperCase();
  if (status === 'CHECKED_OUT' || status === 'CANCELLED') {
    throw domainError(409, 'RESERVATION_CLOSED_FOR_DEPOSIT', `Cannot ${operation} deposit on a closed reservation`);
  }
}

async function findIdempotentEvent(
  client: PoolClient,
  propertyId: number,
  idempotencyKey: string,
  expectedType: DepositEventType
): Promise<any | null> {
  const result = await client.query(
    `SELECT e.*, d.deposit_number, pt.payment_method
     FROM deposit_events e
     JOIN deposits d ON d.id = e.deposit_id
     LEFT JOIN payment_transactions pt ON pt.id = e.payment_transaction_id
     WHERE e.property_id = $1 AND e.idempotency_key = $2`,
    [propertyId, idempotencyKey]
  );
  if ((result.rowCount ?? 0) === 0) return null;
  if (String(result.rows[0].event_type) !== expectedType) {
    throw domainError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used for a different operation');
  }
  return result.rows[0];
}

function assertReplayMatches(event: any, expected: {
  reservationId: number;
  depositId?: number;
  amount?: number;
  paymentMethod?: string;
  notes?: string;
}): void {
  const mismatch =
    Number(event.reservation_id) !== expected.reservationId
    || (expected.depositId !== undefined && Number(event.deposit_id) !== expected.depositId)
    || (expected.amount !== undefined && asInteger(event.amount) !== expected.amount)
    || (expected.paymentMethod !== undefined && String(event.payment_method || '').toUpperCase() !== expected.paymentMethod)
    || (expected.notes !== undefined && String(event.notes || '') !== expected.notes);
  if (mismatch) {
    throw domainError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used with a different request');
  }
}

async function getEvents(client: PoolClient | Pool, depositId: number): Promise<any[]> {
  const result = await client.query(
    `SELECT e.*, original.event_type AS reversed_event_type
     FROM deposit_events e
     LEFT JOIN deposit_events original ON original.id = e.reversal_of_event_id
     WHERE e.deposit_id = $1
     ORDER BY e.id`,
    [depositId]
  );
  return result.rows;
}

async function updateStatusProjection(client: PoolClient, depositId: number): Promise<DepositBalanceSummary> {
  const summary = deriveDepositBalance(await getEvents(client, depositId));
  await client.query(
    'UPDATE deposits SET status = $1, updated_at = NOW() WHERE id = $2',
    [summary.status, depositId]
  );
  return summary;
}

async function lockDeposit(
  client: PoolClient,
  depositId: number,
  propertyId: number,
  reservationId: number
): Promise<any> {
  const result = await client.query(
    `SELECT * FROM deposits
     WHERE id = $1 AND property_id = $2 AND reservation_id = $3
     FOR UPDATE`,
    [depositId, propertyId, reservationId]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw domainError(404, 'DEPOSIT_NOT_FOUND', 'Deposit not found for this property and reservation');
  }
  return result.rows[0];
}

async function insertEvidence(
  client: PoolClient,
  propertyId: number,
  reservationId: number,
  paymentTransactionId: number,
  file: EvidenceUpload,
  storageKey: string,
  note: string | null,
  actor: { userId: string; name: string; role: string }
): Promise<any> {
  const result = await client.query(
    `INSERT INTO payment_evidences (
       property_id, reservation_id, payment_transaction_id, evidence_type,
       storage_key, original_filename, mime_type, file_size_bytes, note,
       is_active, uploaded_by_user_id, uploaded_by_name_snapshot,
       uploaded_by_role_snapshot, uploaded_at
     ) VALUES ($1, $2, $3, 'DEPOSIT_PROOF', $4, $5, $6, $7, $8, TRUE, $9, $10, $11, NOW())
     RETURNING *`,
    [
      propertyId,
      reservationId,
      paymentTransactionId,
      storageKey,
      file.originalname,
      file.mimetype,
      file.size,
      note,
      actor.userId,
      actor.name,
      actor.role
    ]
  );
  return result.rows[0];
}

async function logDepositAudit(
  client: PoolClient,
  action: string,
  propertyId: number,
  reservationId: number,
  payload: Record<string, unknown>,
  correlationId: string
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ('DEPOSIT', $1, 'RESERVATION', $2, $3, $4, $5)`,
    [action, String(reservationId), JSON.stringify(payload), correlationId, propertyId]
  );
}

async function hydrateDeposit(client: PoolClient | Pool, depositId: number): Promise<any> {
  const result = await client.query('SELECT * FROM deposits WHERE id = $1', [depositId]);
  if ((result.rowCount ?? 0) === 0) return null;
  const deposit = result.rows[0];
  const events = await getEvents(client, depositId);
  return { ...deposit, original_amount: asInteger(deposit.original_amount), events, balance: deriveDepositBalance(events) };
}

export async function receiveDeposit(pool: Pool, input: ReceiveDepositInput): Promise<any> {
  const propertyId = requirePositiveInteger(input.propertyId, 'property_id');
  const reservationId = requirePositiveInteger(input.reservationId, 'reservation_id');
  const amount = requirePositiveInteger(input.amount, 'amount');
  const method = normalizePaymentMethod(input.paymentMethod);
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
  validateEvidence(input.evidence);

  let savedStorageKey: string | null = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockIdempotencyKey(client, propertyId, idempotencyKey);
    const reservation = await lockReservation(client, propertyId, reservationId);

    const replay = await findIdempotentEvent(client, propertyId, idempotencyKey, 'RECEIVED');
    if (replay) {
      assertReplayMatches(replay, { reservationId, amount, paymentMethod: method });
      const existing = await hydrateDeposit(client, Number(replay.deposit_id));
      await client.query('COMMIT');
      return { ...existing, idempotent_replay: true };
    }
    assertReservationOpenForDeposit(reservation, 'receive');

    const depositNumber = await generateDepositNumber(client, propertyId, 'DEP');
    const paymentResult = await client.query(
      `INSERT INTO payment_transactions (
         reservation_id, property_id, transaction_type, amount, payment_method,
         reference_code, status, created_by
       ) VALUES ($1, $2, 'DEPOSIT', $3, $4, $5, 'SUCCESS', $6)
       RETURNING *`,
      [reservationId, propertyId, amount, method, depositNumber, input.actor.name]
    );
    const payment = paymentResult.rows[0];

    let evidence: any = null;
    if (input.evidence) {
      const saved = await saveEvidenceFile(propertyId, input.evidence);
      savedStorageKey = saved.storageKey;
      evidence = await insertEvidence(
        client,
        propertyId,
        reservationId,
        Number(payment.id),
        input.evidence,
        saved.storageKey,
        input.evidenceNote || null,
        input.actor
      );
    }

    const depositResult = await client.query(
      `INSERT INTO deposits (
         property_id, reservation_id, deposit_number, original_amount,
         payment_method, status, received_by, notes
       ) VALUES ($1, $2, $3, $4, $5, 'RECEIVED', $6, $7)
       RETURNING *`,
      [propertyId, reservationId, depositNumber, amount, method, input.actor.name, input.notes || null]
    );
    const deposit = depositResult.rows[0];

    const eventResult = await client.query(
      `INSERT INTO deposit_events (
         deposit_id, property_id, reservation_id, event_type, amount,
         payment_transaction_id, idempotency_key, performed_by, notes
       ) VALUES ($1, $2, $3, 'RECEIVED', $4, $5, $6, $7, $8)
       RETURNING *`,
      [deposit.id, propertyId, reservationId, amount, payment.id, idempotencyKey, input.actor.name, input.notes || null]
    );

    const balance = await updateStatusProjection(client, Number(deposit.id));
    await logDepositAudit(client, 'DEPOSIT_RECEIVED', propertyId, reservationId, {
      deposit_id: deposit.id,
      deposit_number: depositNumber,
      deposit_event_id: eventResult.rows[0].id,
      payment_transaction_id: payment.id,
      amount,
      payment_method: method,
      evidence_id: evidence?.id || null,
      actor_user_id: input.actor.userId,
      actor_name: input.actor.name
    }, idempotencyKey);

    await client.query('COMMIT');
    return { ...deposit, original_amount: amount, event: eventResult.rows[0], payment, evidence, balance };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (savedStorageKey) await deleteEvidenceFile(savedStorageKey).catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function applyDeposit(pool: Pool, input: ApplyDepositInput): Promise<any> {
  const propertyId = requirePositiveInteger(input.propertyId, 'property_id');
  const reservationId = requirePositiveInteger(input.reservationId, 'reservation_id');
  const depositId = requirePositiveInteger(input.depositId, 'deposit_id');
  const amount = requirePositiveInteger(input.amount, 'amount');
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await lockIdempotencyKey(client, propertyId, idempotencyKey);
    const reservation = await lockReservation(client, propertyId, reservationId);
    const deposit = await lockDeposit(client, depositId, propertyId, reservationId);

    const replay = await findIdempotentEvent(client, propertyId, idempotencyKey, 'APPLY');
    if (replay) {
      assertReplayMatches(replay, { reservationId, depositId, amount });
      const existing = await hydrateDeposit(client, depositId);
      await client.query('COMMIT');
      return { ...existing, event: replay, idempotent_replay: true };
    }
    assertReservationOpenForDeposit(reservation, 'apply');

    const before = deriveDepositBalance(await getEvents(client, depositId));
    if (before.status === 'CANCELLED' || before.status === 'CLOSED') {
      throw domainError(409, 'DEPOSIT_NOT_OPEN', 'Deposit is not available for application');
    }
    if (amount > before.remaining) {
      throw domainError(409, 'INSUFFICIENT_DEPOSIT_BALANCE', 'Apply amount exceeds remaining deposit balance');
    }

    const currentFinancials = await recalculateReservationFinancials(client, reservationId, propertyId);
    if (amount > currentFinancials.remaining_balance) {
      throw domainError(409, 'DEPOSIT_APPLY_EXCEEDS_OUTSTANDING', 'Apply amount exceeds eligible reservation outstanding', {
        apply_amount: amount,
        eligible_outstanding: currentFinancials.remaining_balance
      });
    }

    const folioResult = await client.query(
      `INSERT INTO folio_entries (
         reservation_id, property_id, entry_type, description, amount, direction,
         source_type, source_id, status, actor_user_id, actor_name_snapshot,
         actor_role_snapshot, base_amount, unit_price, quantity, notes
       ) VALUES ($1, $2, 'DEPOSIT_APPLY', $3, $4, 'CREDIT',
         'DEPOSIT', $5, 'POSTED', $6, $7, $8, $4, $4, 1, $9)
       RETURNING *`,
      [
        reservationId,
        propertyId,
        `Deposit applied: ${deposit.deposit_number}`,
        amount,
        String(depositId),
        input.actor.userId,
        input.actor.name,
        input.actor.role,
        input.notes || null
      ]
    );
    const folio = folioResult.rows[0];
    const eventResult = await client.query(
      `INSERT INTO deposit_events (
         deposit_id, property_id, reservation_id, event_type, amount,
         folio_entry_id, idempotency_key, performed_by, notes
       ) VALUES ($1, $2, $3, 'APPLY', $4, $5, $6, $7, $8)
       RETURNING *`,
      [depositId, propertyId, reservationId, amount, folio.id, idempotencyKey, input.actor.name, input.notes || null]
    );

    const balance = await updateStatusProjection(client, depositId);
    const ordinaryFallback = Math.max(0, currentFinancials.amount_paid);
    const financials = await recalculateReservationFinancials(client, reservationId, propertyId, ordinaryFallback);
    await logDepositAudit(client, 'DEPOSIT_APPLIED', propertyId, reservationId, {
      deposit_id: depositId,
      deposit_number: deposit.deposit_number,
      deposit_event_id: eventResult.rows[0].id,
      folio_entry_id: folio.id,
      amount,
      actor_user_id: input.actor.userId,
      actor_name: input.actor.name
    }, idempotencyKey);

    const hydrated = await hydrateDeposit(client, depositId);
    await client.query('COMMIT');
    return { deposit: hydrated, event: eventResult.rows[0], folio_entry: folio, balance, reservation_financials: financials };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function refundDeposit(pool: Pool, input: RefundDepositInput): Promise<any> {
  const propertyId = requirePositiveInteger(input.propertyId, 'property_id');
  const reservationId = requirePositiveInteger(input.reservationId, 'reservation_id');
  const depositId = requirePositiveInteger(input.depositId, 'deposit_id');
  const amount = requirePositiveInteger(input.amount, 'amount');
  const method = normalizePaymentMethod(input.paymentMethod);
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
  validateEvidence(input.evidence);
  let savedStorageKey: string | null = null;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await lockIdempotencyKey(client, propertyId, idempotencyKey);
    await lockReservation(client, propertyId, reservationId);
    await lockDeposit(client, depositId, propertyId, reservationId);

    const replay = await findIdempotentEvent(client, propertyId, idempotencyKey, 'REFUND');
    if (replay) {
      assertReplayMatches(replay, { reservationId, depositId, amount, paymentMethod: method });
      const existing = await hydrateDeposit(client, depositId);
      await client.query('COMMIT');
      return { ...existing, event: replay, idempotent_replay: true };
    }

    const before = deriveDepositBalance(await getEvents(client, depositId));
    if (before.status === 'CANCELLED' || before.status === 'CLOSED') {
      throw domainError(409, 'DEPOSIT_NOT_OPEN', 'Deposit is not available for refund');
    }
    if (amount > before.remaining) {
      throw domainError(409, 'INSUFFICIENT_DEPOSIT_BALANCE', 'Refund amount exceeds remaining deposit balance');
    }

    const refundNumber = await generateDepositNumber(client, propertyId, 'RFD');
    const paymentResult = await client.query(
      `INSERT INTO payment_transactions (
         reservation_id, property_id, transaction_type, amount, payment_method,
         reference_code, status, created_by
       ) VALUES ($1, $2, 'DEPOSIT_REFUND', $3, $4, $5, 'SUCCESS', $6)
       RETURNING *`,
      [reservationId, propertyId, amount, method, refundNumber, input.actor.name]
    );
    const payment = paymentResult.rows[0];

    let evidence: any = null;
    if (input.evidence) {
      const saved = await saveEvidenceFile(propertyId, input.evidence);
      savedStorageKey = saved.storageKey;
      evidence = await insertEvidence(client, propertyId, reservationId, Number(payment.id), input.evidence, saved.storageKey, input.evidenceNote || null, input.actor);
    }

    const eventResult = await client.query(
      `INSERT INTO deposit_events (
         deposit_id, property_id, reservation_id, event_type, amount,
         payment_transaction_id, idempotency_key, performed_by, notes
       ) VALUES ($1, $2, $3, 'REFUND', $4, $5, $6, $7, $8)
       RETURNING *`,
      [depositId, propertyId, reservationId, amount, payment.id, idempotencyKey, input.actor.name, input.notes || null]
    );
    const balance = await updateStatusProjection(client, depositId);
    await logDepositAudit(client, 'DEPOSIT_REFUNDED', propertyId, reservationId, {
      deposit_id: depositId,
      deposit_event_id: eventResult.rows[0].id,
      payment_transaction_id: payment.id,
      refund_number: refundNumber,
      amount,
      payment_method: method,
      evidence_id: evidence?.id || null,
      actor_user_id: input.actor.userId,
      actor_name: input.actor.name
    }, idempotencyKey);

    const hydrated = await hydrateDeposit(client, depositId);
    await client.query('COMMIT');
    return { deposit: hydrated, event: eventResult.rows[0], payment, evidence, balance };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (savedStorageKey) await deleteEvidenceFile(savedStorageKey).catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function reverseDeposit(pool: Pool, input: ReverseDepositInput): Promise<any> {
  const propertyId = requirePositiveInteger(input.propertyId, 'property_id');
  const reservationId = requirePositiveInteger(input.reservationId, 'reservation_id');
  const depositId = requirePositiveInteger(input.depositId, 'deposit_id');
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
  const reason = String(input.reason || '').trim();
  if (!reason) throw domainError(400, 'REVERSAL_REASON_REQUIRED', 'Reversal reason is required');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await lockIdempotencyKey(client, propertyId, idempotencyKey);
    await lockReservation(client, propertyId, reservationId);
    const deposit = await lockDeposit(client, depositId, propertyId, reservationId);

    const replay = await findIdempotentEvent(client, propertyId, idempotencyKey, 'REVERSAL');
    if (replay) {
      assertReplayMatches(replay, { reservationId, depositId, notes: reason });
      const existing = await hydrateDeposit(client, depositId);
      await client.query('COMMIT');
      return { ...existing, event: replay, idempotent_replay: true };
    }

    const events = await getEvents(client, depositId);
    const receivedEvents = events.filter(event => event.event_type === 'RECEIVED');
    const usageEvents = events.filter(event => event.event_type === 'APPLY' || event.event_type === 'REFUND');
    const reversalEvents = events.filter(event => event.event_type === 'REVERSAL');
    if (receivedEvents.length !== 1) throw domainError(409, 'DEPOSIT_INVARIANT_VIOLATION', 'Deposit must have exactly one RECEIVED event');
    if (usageEvents.length > 0) throw domainError(409, 'DEPOSIT_REVERSAL_NOT_ALLOWED_AFTER_USAGE', 'Used deposits must be resolved through apply/refund workflows');
    if (reversalEvents.length > 0) throw domainError(409, 'DEPOSIT_ALREADY_REVERSED', 'Deposit receipt has already been reversed');

    const before = deriveDepositBalance(events);
    const original = receivedEvents[0];
    if (before.remaining !== before.effective_received || before.remaining !== asInteger(original.amount)) {
      throw domainError(409, 'DEPOSIT_REVERSAL_NOT_ALLOWED_AFTER_USAGE', 'Only a fully unused received deposit can be reversed');
    }

    const refundNumber = await generateDepositNumber(client, propertyId, 'RFD');
    const correctionGroupId = `dep_reverse_${depositId}_${crypto.randomUUID()}`;
    const paymentResult = await client.query(
      `INSERT INTO payment_transactions (
         reservation_id, property_id, transaction_type, amount, payment_method,
         reference_code, status, reference_payment_id, correction_group_id,
         reason_code, reason_text, created_by
       ) VALUES ($1, $2, 'DEPOSIT_REFUND', $3, $4, $5, 'SUCCESS', $6, $7,
         'PAYMENT_CANCELLED', $8, $9)
       RETURNING *`,
      [
        reservationId,
        propertyId,
        original.amount,
        deposit.payment_method,
        refundNumber,
        original.payment_transaction_id,
        correctionGroupId,
        reason,
        input.actor.name
      ]
    );
    const payment = paymentResult.rows[0];
    const eventResult = await client.query(
      `INSERT INTO deposit_events (
         deposit_id, property_id, reservation_id, event_type, amount,
         payment_transaction_id, reversal_of_event_id, idempotency_key,
         performed_by, notes
       ) VALUES ($1, $2, $3, 'REVERSAL', $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [depositId, propertyId, reservationId, original.amount, payment.id, original.id, idempotencyKey, input.actor.name, reason]
    );
    const balance = await updateStatusProjection(client, depositId);
    if (balance.status !== 'CANCELLED') throw domainError(409, 'DEPOSIT_INVARIANT_VIOLATION', 'Reversed unused deposit did not derive CANCELLED status');

    await logDepositAudit(client, 'DEPOSIT_REVERSED', propertyId, reservationId, {
      deposit_id: depositId,
      reversed_event_id: original.id,
      reversal_event_id: eventResult.rows[0].id,
      original_payment_transaction_id: original.payment_transaction_id,
      reversing_payment_transaction_id: payment.id,
      refund_number: refundNumber,
      amount: asInteger(original.amount),
      reason,
      actor_user_id: input.actor.userId,
      actor_name: input.actor.name
    }, idempotencyKey);

    const hydrated = await hydrateDeposit(client, depositId);
    await client.query('COMMIT');
    return { deposit: hydrated, event: eventResult.rows[0], payment, balance };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function reconcileDeposit(client: PoolClient | Pool, depositId: number): Promise<DepositReconciliationIssue[]> {
  const result = await client.query(
    `SELECT
       e.*,
       d.property_id AS deposit_property_id,
       d.reservation_id AS deposit_reservation_id,
       pt.amount AS payment_amount,
       pt.transaction_type AS payment_type,
       pt.status AS payment_status,
       pt.property_id AS payment_property_id,
       pt.reservation_id AS payment_reservation_id,
       fe.amount AS folio_amount,
       fe.entry_type AS folio_type,
       fe.direction AS folio_direction,
       fe.status AS folio_status,
       fe.is_voided AS folio_is_voided,
       fe.property_id AS folio_property_id,
       fe.reservation_id AS folio_reservation_id,
       fe.source_type AS folio_source_type,
       fe.source_id AS folio_source_id,
       original.event_type AS reversed_event_type
     FROM deposit_events e
     JOIN deposits d ON d.id = e.deposit_id
     LEFT JOIN payment_transactions pt ON pt.id = e.payment_transaction_id
     LEFT JOIN folio_entries fe ON fe.id = e.folio_entry_id
     LEFT JOIN deposit_events original ON original.id = e.reversal_of_event_id
     WHERE e.deposit_id = $1
     ORDER BY e.id`,
    [depositId]
  );

  const issues: DepositReconciliationIssue[] = [];
  const paymentProjectionOwners = new Map<number, number>();
  const folioProjectionOwners = new Map<number, number>();
  for (const event of result.rows) {
    const amount = asInteger(event.amount);
    const fail = (code: string, message: string) => issues.push({ event_id: Number(event.id), code, message });
    if (event.payment_transaction_id) {
      const projectionId = Number(event.payment_transaction_id);
      const existingOwner = paymentProjectionOwners.get(projectionId);
      if (existingOwner !== undefined) fail('DUPLICATE_PAYMENT_PROJECTION', `Payment projection is already linked to event ${existingOwner}`);
      else paymentProjectionOwners.set(projectionId, Number(event.id));
    }
    if (event.folio_entry_id) {
      const projectionId = Number(event.folio_entry_id);
      const existingOwner = folioProjectionOwners.get(projectionId);
      if (existingOwner !== undefined) fail('DUPLICATE_FOLIO_PROJECTION', `Folio projection is already linked to event ${existingOwner}`);
      else folioProjectionOwners.set(projectionId, Number(event.id));
    }
    if (Number(event.property_id) !== Number(event.deposit_property_id) || Number(event.reservation_id) !== Number(event.deposit_reservation_id)) {
      fail('EVENT_OWNERSHIP_MISMATCH', 'Event ownership differs from deposit ownership');
    }
    if (event.event_type === 'RECEIVED' || event.event_type === 'REFUND' || event.event_type === 'REVERSAL') {
      const expectedType = event.event_type === 'RECEIVED' ? 'DEPOSIT' : 'DEPOSIT_REFUND';
      if (!event.payment_transaction_id) fail('PAYMENT_PROJECTION_MISSING', 'Payment projection is missing');
      if (event.payment_type !== expectedType || event.payment_status !== 'SUCCESS') fail('PAYMENT_PROJECTION_INVALID', `Expected successful ${expectedType} payment projection`);
      if (asInteger(event.payment_amount) !== amount) fail('PAYMENT_AMOUNT_MISMATCH', 'Payment projection amount differs from deposit event');
      if (Number(event.payment_property_id) !== Number(event.property_id)) fail('PAYMENT_PROPERTY_MISMATCH', 'Payment projection property differs from event');
      if (Number(event.payment_reservation_id) !== Number(event.reservation_id)) fail('PAYMENT_RESERVATION_MISMATCH', 'Payment projection reservation differs from event');
    } else if (event.event_type === 'APPLY') {
      if (!event.folio_entry_id) fail('FOLIO_PROJECTION_MISSING', 'Folio projection is missing');
      if (event.folio_type !== 'DEPOSIT_APPLY' || event.folio_direction !== 'CREDIT' || event.folio_status !== 'POSTED' || event.folio_is_voided === true) {
        fail('FOLIO_PROJECTION_INVALID', 'Expected effective posted DEPOSIT_APPLY folio credit');
      }
      if (asInteger(event.folio_amount) !== amount) fail('FOLIO_AMOUNT_MISMATCH', 'Folio projection amount differs from deposit event');
      if (Number(event.folio_property_id) !== Number(event.property_id)) fail('FOLIO_PROPERTY_MISMATCH', 'Folio projection property differs from event');
      if (Number(event.folio_reservation_id) !== Number(event.reservation_id)) fail('FOLIO_RESERVATION_MISMATCH', 'Folio projection reservation differs from event');
      if (event.folio_source_type !== 'DEPOSIT' || String(event.folio_source_id) !== String(depositId)) fail('FOLIO_SOURCE_MISMATCH', 'Folio projection does not identify the deposit source');
    }
  }

  try {
    deriveDepositBalance(result.rows);
  } catch (error: any) {
    issues.push({ event_id: 0, code: error.code || 'DEPOSIT_INVARIANT_VIOLATION', message: error.message });
  }
  return issues;
}

export async function getDepositsByReservation(pool: Pool, propertyId: number, reservationId: number): Promise<any[]> {
  requirePositiveInteger(propertyId, 'property_id');
  requirePositiveInteger(reservationId, 'reservation_id');
  const ownership = await pool.query(
    `SELECT r.id FROM reservations r
     JOIN bookings b ON b.id = r.booking_id
     WHERE r.id = $1 AND b.property_id = $2`,
    [reservationId, propertyId]
  );
  if ((ownership.rowCount ?? 0) === 0) throw domainError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found for this property');
  const result = await pool.query(
    'SELECT id FROM deposits WHERE property_id = $1 AND reservation_id = $2 ORDER BY id',
    [propertyId, reservationId]
  );
  return Promise.all(result.rows.map(row => hydrateDeposit(pool, Number(row.id))));
}

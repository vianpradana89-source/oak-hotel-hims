export type DepositStatus = 'RECEIVED' | 'PARTIALLY_USED' | 'CLOSED' | 'CANCELLED';
export type DepositEventType = 'RECEIVED' | 'APPLY' | 'REFUND' | 'REVERSAL' | 'UNAPPLY';
export type DepositScope = 'ROOM_RESERVATION' | 'BOOKING_GROUP';

/**
 * Canonical purpose classification for a deposit receipt.
 *
 * - ADVANCE_PAYMENT: uang muka / DP. Custody saat RECEIVE; mengurangi
 *   outstanding reservation hanya setelah APPLY eksplisit (keputusan D2).
 * - SECURITY_DEPOSIT: jaminan. Custody saat RECEIVE; refund setelah check-out.
 *   TIDAK boleh di-APPLY (guard SECURITY_DEPOSIT_APPLY_FORBIDDEN).
 *
 * Deposit legacy (baris lama) memiliki purpose NULL — diperlakukan sebagai
 * LEGACY/UNKNOWN, hanya diizinkan untuk READ. Tidak di-backfill otomatis.
 * Semua create baru WAJIB purpose explicit (divalidasi di receiveDeposit).
 */
export type DepositPurpose = 'ADVANCE_PAYMENT' | 'SECURITY_DEPOSIT';

export interface DepositActor {
  userId: string;
  name: string;
  role: string;
}

export interface EvidenceUpload {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

export interface DepositOperationBase {
  propertyId: number;
  reservationId: number;
  amount: number;
  idempotencyKey: string;
  actor: DepositActor;
  notes?: string | null;
}

export interface ReceiveDepositInput extends DepositOperationBase {
  paymentMethod: string;
  /**
   * Mandatory untuk semua create deposit baru:
   * - 'ADVANCE_PAYMENT' = Uang Muka / DP (custody saat RECEIVE, APPLY eksplisit utk settlement)
   * - 'SECURITY_DEPOSIT' = Jaminan (custody, refund setelah check-out, TIDAK boleh APPLY)
   * Missing/NULL/invalid pada create baru -> 400 VALIDATION_ERROR.
   * Deposit legacy (baris lama NULL) hanya berlaku untuk READ, tidak untuk create.
   */
  purpose: DepositPurpose;
  scope?: DepositScope;
  evidence?: EvidenceUpload | null;
  evidenceNote?: string | null;
}

export interface ApplyDepositInput extends DepositOperationBase {
  depositId: number;
}

export interface RefundDepositInput extends DepositOperationBase {
  depositId: number;
  paymentMethod: string;
  evidence?: EvidenceUpload | null;
  evidenceNote?: string | null;
}

export interface ReverseDepositInput {
  propertyId: number;
  reservationId: number;
  depositId: number;
  idempotencyKey: string;
  actor: DepositActor;
  reason: string;
}

export interface UnapplyDepositInput {
  propertyId: number;
  reservationId: number;
  depositId: number;
  /**
   * DEPOSIT-PURPOSE-PHASE-B: The specific DEPOSIT_APPLY event id this UNAPPLY
   * targets. MANDATORY — no backend auto-select fallback.
   * Must point to an APPLY event belonging to the same deposit, property, and
   * reservation. Multiple partial UNAPPLY events may target the same APPLY
   * event; the per-target cumulative cap is enforced at service layer.
   */
  applyEventId: number;
  /** Amount to unapply. Must be <= the active (remaining) amount of the target APPLY event. */
  amount: number;
  /** Idempotency key bound to propertyId+reservationId+depositId+applyEventId+amount. */
  idempotencyKey: string;
  actor: DepositActor;
  notes?: string | null;
}

export interface DepositBalanceSummary {
  effective_received: number;
  applied: number;
  refunded: number;
  reversed_received: number;
  remaining: number;
  status: DepositStatus;
}

export interface DepositReconciliationIssue {
  event_id: number;
  code: string;
  message: string;
}

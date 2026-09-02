export type DepositStatus = 'RECEIVED' | 'PARTIALLY_USED' | 'CLOSED' | 'CANCELLED';
export type DepositEventType = 'RECEIVED' | 'APPLY' | 'REFUND' | 'REVERSAL';

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

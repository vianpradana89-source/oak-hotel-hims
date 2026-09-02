import { Router, type Response } from 'express';
import multer from 'multer';
import type { Pool } from 'pg';
import { requireAuth, requireRole, normalizeRoleName, type AuthenticatedRequest } from '../auth/authMiddleware';
import { applyDeposit, getDepositsByReservation, receiveDeposit, refundDeposit, reverseDeposit } from './depositService';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function positiveInt(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw Object.assign(new Error(`${field} must be a positive integer`), { statusCode: 400, code: 'VALIDATION_ERROR' });
  }
  return parsed;
}

function propertyIdFor(req: AuthenticatedRequest): number {
  const requested = positiveInt(req.body?.property_id ?? req.query?.property_id, 'property_id');
  const role = normalizeRoleName(req.user?.role);
  if (role !== 'Super Admin' && requested !== Number(req.user?.property_id)) {
    throw Object.assign(new Error('Cross-property access is not allowed'), { statusCode: 403, code: 'CROSS_PROPERTY_ACCESS' });
  }
  return requested;
}

function actorFor(req: AuthenticatedRequest) {
  return {
    userId: String(req.user!.id),
    name: req.user!.full_name,
    role: normalizeRoleName(req.user!.role)
  };
}

function idempotencyKey(req: AuthenticatedRequest): string {
  return String(req.headers['idempotency-key'] || req.body?.idempotency_key || '').trim();
}

function sendError(res: Response, error: any): Response {
  const statusCode = Number(error?.statusCode || error?.status || 500);
  return res.status(statusCode).json({
    status: 'ERROR',
    code: error?.code || 'INTERNAL_ERROR',
    message: error?.message || 'Deposit operation failed',
    details: error?.details
  });
}

export function createDepositRouter(pool: Pool): Router {
  const router = Router();
  router.use(requireAuth);

  router.post('/deposits', requireRole(['Front Office']), upload.single('file'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const propertyId = propertyIdFor(req);
      const reservationId = positiveInt(req.body?.reservation_id, 'reservation_id');
      const result = await receiveDeposit(pool, {
        propertyId,
        reservationId,
        amount: Number(req.body?.amount),
        paymentMethod: req.body?.payment_method,
        idempotencyKey: idempotencyKey(req),
        actor: actorFor(req),
        notes: req.body?.notes || null,
        evidence: req.file || null,
        evidenceNote: req.body?.evidence_note || null
      });
      return res.status(result.idempotent_replay ? 200 : 201).json({ status: 'SUCCESS', data: result });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/deposits/:id/apply', requireRole(['Front Office']), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await applyDeposit(pool, {
        depositId: positiveInt(req.params.id, 'deposit_id'),
        propertyId: propertyIdFor(req),
        reservationId: positiveInt(req.body?.reservation_id, 'reservation_id'),
        amount: Number(req.body?.amount),
        idempotencyKey: idempotencyKey(req),
        actor: actorFor(req),
        notes: req.body?.notes || null
      });
      return res.status(200).json({ status: 'SUCCESS', data: result });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/deposits/:id/refund', requireRole(['Front Office']), upload.single('file'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await refundDeposit(pool, {
        depositId: positiveInt(req.params.id, 'deposit_id'),
        propertyId: propertyIdFor(req),
        reservationId: positiveInt(req.body?.reservation_id, 'reservation_id'),
        amount: Number(req.body?.amount),
        paymentMethod: req.body?.payment_method,
        idempotencyKey: idempotencyKey(req),
        actor: actorFor(req),
        notes: req.body?.notes || null,
        evidence: req.file || null,
        evidenceNote: req.body?.evidence_note || null
      });
      return res.status(200).json({ status: 'SUCCESS', data: result });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/deposits/:id/reverse', requireRole(['Front Office']), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await reverseDeposit(pool, {
        depositId: positiveInt(req.params.id, 'deposit_id'),
        propertyId: propertyIdFor(req),
        reservationId: positiveInt(req.body?.reservation_id, 'reservation_id'),
        idempotencyKey: idempotencyKey(req),
        actor: actorFor(req),
        reason: req.body?.reason
      });
      return res.status(200).json({ status: 'SUCCESS', data: result });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/reservations/:id/deposits', requireRole(['Front Office']), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const propertyId = propertyIdFor(req);
      const reservationId = positiveInt(req.params.id, 'reservation_id');
      const deposits = await getDepositsByReservation(pool, propertyId, reservationId);
      return res.json({ status: 'SUCCESS', data: deposits });
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

import { Router, type Response } from 'express';
import type { Pool } from 'pg';
import { normalizeRoleName, requireAuth, type AuthenticatedRequest } from '../auth/authMiddleware';
import { isPlatformSuperAdmin } from '../auth/authService';
import { getIdentityCustodyByReservation, holdIdentity, returnIdentity } from './identityCustodyService';

function positiveInt(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw Object.assign(new Error(`${field} must be a positive integer`), { statusCode: 400, code: 'VALIDATION_ERROR' });
  return parsed;
}

async function propertyIdFor(req: AuthenticatedRequest, pool: Pool): Promise<number> {
  const requested = positiveInt(req.body?.property_id ?? req.query?.property_id, 'property_id');
  if (requested !== Number(req.user?.property_id) && !(await isPlatformSuperAdmin(pool, req.user?.id))) {
    throw Object.assign(new Error('Cross-property access is not allowed'), { statusCode: 403, code: 'CROSS_PROPERTY_ACCESS' });
  }
  return requested;
}

function actorFor(req: AuthenticatedRequest) {
  return { userId: String(req.user!.id), name: req.user!.full_name, role: normalizeRoleName(req.user!.role) };
}

function sendError(res: Response, error: any): Response {
  return res.status(Number(error?.statusCode || 500)).json({ status: 'ERROR', code: error?.code || 'INTERNAL_ERROR', message: error?.message || 'Identity custody operation failed' });
}

export function createIdentityCustodyRouter(pool: Pool): Router {
  const router = Router();
  const allowed = [requireAuth];

  router.post('/identity-custody', ...allowed, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await holdIdentity(pool, {
        propertyId: await propertyIdFor(req, pool),
        reservationId: positiveInt(req.body?.reservation_id, 'reservation_id'),
        documentType: req.body?.document_type,
        documentHolderName: req.body?.document_holder_name,
        documentNumberMasked: req.body?.document_number_masked || null,
        storageLocation: req.body?.storage_location || null,
        notes: req.body?.notes || null,
        actor: actorFor(req)
      });
      return res.status(201).json({ status: 'SUCCESS', data: result });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.patch('/identity-custody/:id/return', ...allowed, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await returnIdentity(pool, {
        propertyId: await propertyIdFor(req, pool),
        custodyId: positiveInt(req.params.id, 'identity_custody_id'),
        actor: actorFor(req)
      });
      return res.json({ status: 'SUCCESS', data: result });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/reservations/:id/identity-custody', ...allowed, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await getIdentityCustodyByReservation(pool, await propertyIdFor(req, pool), positiveInt(req.params.id, 'reservation_id'));
      return res.json({ status: 'SUCCESS', data: result });
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

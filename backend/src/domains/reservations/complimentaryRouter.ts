import { Router } from 'express';
import type { Pool } from 'pg';
import { requireAuth, normalizeRoleName, type AuthenticatedRequest } from '../auth/authMiddleware';
import { isPlatformSuperAdmin } from '../auth/authService';
import {
  createComplimentaryRequest,
  getComplimentaryRequest,
  listComplimentaryRequests,
  approveComplimentaryRequest,
  rejectComplimentaryRequest,
  revokeComplimentaryRequest,
  type ComplimentaryCategory
} from './complimentaryService';

function positiveInt(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw Object.assign(new Error(`${field} must be a positive integer`), { statusCode: 400, code: 'VALIDATION_ERROR' });
  }
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
  return {
    // Audit snapshot fields (dipakai complimentaryService untuk snapshot)
    userId: String(req.user!.id),
    userName: req.user!.full_name,
    userRole: normalizeRoleName(req.user!.role),

    // Permission-check fields (diperlukan hasPermission untuk query role_permissions)
    id: req.user!.id,
    role: req.user!.role,
    role_id: req.user!.role_id,
    property_id: req.user!.property_id
  };
}

function idempotencyKey(req: AuthenticatedRequest): string {
  return String(req.headers['idempotency-key'] || '').trim();
}

function sendError(res: any, error: any): void {
  const statusCode = Number(error?.statusCode || error?.status || 500);
  res.status(statusCode).json({
    status: 'ERROR',
    code: error?.code || 'INTERNAL_ERROR',
    message: error?.message || 'Complimentary operation failed'
  });
}

export function createComplimentaryRouter(pool: Pool, broadcastEvent?: (eventType: string, payload: any, propertyId?: number) => void): Router {
  const router = Router();
  const allowed = [requireAuth];

  // GET /api/reservations/:id/complimentary
  router.get('/reservations/:id/complimentary', ...allowed, async (req: AuthenticatedRequest, res) => {
    // NO-CACHE: CDN/Firebase cache must not serve stale 404 for uninitiated
    // reservations. Applied BEFORE try so even error/404 responses bypass cache.
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    try {
      const reservationId = positiveInt(req.params.id, 'reservation_id');
      const propertyId = await propertyIdFor(req, pool);
      const data = await getComplimentaryRequest(pool, reservationId, propertyId, req.user);
      res.json({ status: 'SUCCESS', data });
    } catch (error) {
      sendError(res, error);
    }
  });

  // GET /api/reservations/:id/complimentary/list
  router.get('/reservations/:id/complimentary/list', ...allowed, async (req: AuthenticatedRequest, res) => {
    // NO-CACHE: same rationale as above
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    try {
      const reservationId = positiveInt(req.params.id, 'reservation_id');
      const propertyId = await propertyIdFor(req, pool);
      const data = await listComplimentaryRequests(pool, reservationId, propertyId, req.user);
      res.json({ status: 'SUCCESS', data });
    } catch (error) {
      sendError(res, error);
    }
  });

  // POST /api/reservations/:id/complimentary/request
  router.post('/reservations/:id/complimentary/request', ...allowed, async (req: AuthenticatedRequest, res) => {
    try {
      const reservationId = positiveInt(req.params.id, 'reservation_id');
      const propertyId = await propertyIdFor(req, pool);
      const idemKey = idempotencyKey(req);
      if (!idemKey) {
        throw Object.assign(new Error('Idempotency-Key header is required'), { statusCode: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' });
      }
      const category = req.body?.category as ComplimentaryCategory | undefined;
      if (!category) {
        throw Object.assign(new Error('category is required'), { statusCode: 400, code: 'VALIDATION_ERROR' });
      }
      const reason = req.body?.reason;
      const data = await createComplimentaryRequest(pool, {
        reservationId,
        propertyId,
        category,
        reason,
        idempotencyKey: idemKey,
        requestor: actorFor(req)
      });
      broadcastEvent?.('ComplimentaryUpdated', {
        reservation_id: reservationId,
        request_id: data.id,
        operation: 'REQUEST',
        status: data.status,
        timestamp: new Date().toISOString()
      }, propertyId);
      res.status(201).json({ status: 'SUCCESS', data });
    } catch (error) {
      sendError(res, error);
    }
  });

  // POST /api/reservations/:id/complimentary/:requestId/approve
  router.post('/reservations/:id/complimentary/:requestId/approve', ...allowed, async (req: AuthenticatedRequest, res) => {
    try {
      const reservationId = positiveInt(req.params.id, 'reservation_id');
      const requestId = positiveInt(req.params.requestId, 'request_id');
      const propertyId = await propertyIdFor(req, pool);
      const data = await approveComplimentaryRequest(pool, {
        requestId,
        reservationId,
        propertyId,
        actor: actorFor(req)
      });
      broadcastEvent?.('ComplimentaryUpdated', {
        reservation_id: reservationId,
        request_id: requestId,
        operation: 'APPROVE',
        status: data.status,
        timestamp: new Date().toISOString()
      }, propertyId);
      res.json({ status: 'SUCCESS', data });
    } catch (error) {
      sendError(res, error);
    }
  });

  // POST /api/reservations/:id/complimentary/:requestId/reject
  router.post('/reservations/:id/complimentary/:requestId/reject', ...allowed, async (req: AuthenticatedRequest, res) => {
    try {
      const reservationId = positiveInt(req.params.id, 'reservation_id');
      const requestId = positiveInt(req.params.requestId, 'request_id');
      const propertyId = await propertyIdFor(req, pool);
      const data = await rejectComplimentaryRequest(pool, {
        requestId,
        reservationId,
        propertyId,
        reason: req.body?.reason,
        actor: actorFor(req)
      });
      broadcastEvent?.('ComplimentaryUpdated', {
        reservation_id: reservationId,
        request_id: requestId,
        operation: 'REJECT',
        status: data.status,
        timestamp: new Date().toISOString()
      }, propertyId);
      res.json({ status: 'SUCCESS', data });
    } catch (error) {
      sendError(res, error);
    }
  });

  // POST /api/reservations/:id/complimentary/:requestId/revoke
  router.post('/reservations/:id/complimentary/:requestId/revoke', ...allowed, async (req: AuthenticatedRequest, res) => {
    try {
      const reservationId = positiveInt(req.params.id, 'reservation_id');
      const requestId = positiveInt(req.params.requestId, 'request_id');
      const propertyId = await propertyIdFor(req, pool);
      const data = await revokeComplimentaryRequest(pool, {
        requestId,
        reservationId,
        propertyId,
        reason: req.body?.reason,
        actor: actorFor(req)
      });
      broadcastEvent?.('ComplimentaryUpdated', {
        reservation_id: reservationId,
        request_id: requestId,
        operation: 'REVOKE',
        status: data.status,
        timestamp: new Date().toISOString()
      }, propertyId);
      res.json({ status: 'SUCCESS', data });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

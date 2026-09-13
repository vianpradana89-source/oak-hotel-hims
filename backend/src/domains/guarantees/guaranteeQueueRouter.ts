import { Router, type Response } from 'express';
import type { Pool } from 'pg';
import { requireAuth, requireRole, type AuthenticatedRequest } from '../auth/authMiddleware';
import { isPlatformSuperAdmin } from '../auth/authService';
import { getUnresolvedGuaranteesByProperty } from './unresolvedGuaranteeService';

function positiveInt(value: unknown, field: string): number {
  if (value === undefined || value === null) {
    const err: any = new Error(`${field} is required`);
    err.statusCode = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw Object.assign(new Error(`${field} must be a positive integer`), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  return parsed;
}

async function propertyIdFor(req: AuthenticatedRequest, pool: Pool): Promise<number> {
  const requested = positiveInt(req.body?.property_id ?? req.query?.property_id, 'property_id');
  // Guard against missing/malformed user: undefined property_id produces NaN comparison.
  // A properly authenticated user must have a numeric property_id.
  if (!req.user || typeof req.user.property_id !== 'number') {
    const err: any = new Error('Akses ditolak: Autentikasi diperlukan.');
    err.statusCode = 401;
    err.code = 'UNAUTHORIZED';
    throw err;
  }
  if (requested !== req.user.property_id && !(await isPlatformSuperAdmin(pool, req.user.id))) {
    throw Object.assign(new Error('Cross-property access is not allowed'), {
      statusCode: 403,
      code: 'CROSS_PROPERTY_ACCESS',
    });
  }
  return requested;
}

function sendError(res: Response, error: any): Response {
  const statusCode = Number(error?.statusCode || error?.status || 500);
  return res.status(statusCode).json({
    status: 'ERROR',
    code: error?.code || 'INTERNAL_ERROR',
    message: error?.message || 'Operation failed',
  });
}

/**
 * GET /api/reservations/unresolved-guarantees?property_id=<id>
 *
 * Returns a flat list of unresolved guarantee work items across the property.
 * READ-ONLY — does not mutate any data.
 *
 * Auth: requireAuth + requireRole(['Front Office', 'General Manager', 'Super Admin'])
 * Property isolation enforced via propertyIdFor().
 */
export function createUnresolvedGuaranteeRouter(pool: Pool): Router {
  const router = Router();

  // Role guard: Front Office, General Manager, Super Admin only
  const roleGuard = requireRole(['Front Office', 'General Manager', 'Super Admin']);

    router.get(
      '/reservations/unresolved-guarantees',
      requireAuth,
      roleGuard,
      async (req: any, res: Response) => {
        try {
          const propertyId = await propertyIdFor(req, pool);
          const items = await getUnresolvedGuaranteesByProperty(pool, propertyId);
          return res.json({ status: 'SUCCESS', data: { items } });
        } catch (error: any) {
          return sendError(res, error);
        }
      }
    );

  return router;
}

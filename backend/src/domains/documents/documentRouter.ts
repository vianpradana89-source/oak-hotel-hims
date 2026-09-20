/**
 * documentRouter.ts
 *
 * Dedicated Document & Print read endpoints:
 *   GET /api/documents/reservations          -> list (picker)
 *   GET /api/documents/reservations/:id      -> detail (print)
 *
 * Authorization flow (in strict order):
 *   1. requireAuth               -> 401 if no token
 *   2. parsePositiveInt property_id -> 400 if missing/invalid
 *   3. assertPropertyScope       -> 403 if user cannot access this property
 *   4. isFeatureEnabled(documents.enabled) -> 403 MODULE_DISABLED
 *   5. (operationalAccessGuard will enforce Dokumen & Print view later,
 *       but feature gate is a HARD STOP regardless of permissions)
 *   6. call documentReservationReadService
 *
 * This router must be mounted AFTER the operational access guard so that
 * the guard's permission check still runs. However, this router provides
 * its own feature-gate hard stop that even Platform Super Admin cannot bypass.
 */

import { Router, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth, type AuthenticatedRequest } from '../auth/authMiddleware';
import { isPlatformSuperAdmin } from '../auth/authService';
import { isFeatureEnabled } from '../features/featureService';
import {
  getDocumentReservationList,
  getDocumentReservationDetail,
} from './documentReservationReadService';

function parsePositiveInt(value: any): number | null {
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Property scope check: reject if token property != requested property,
 * unless user is platform super admin.
 */
async function assertPropertyScope(pool: Pool, req: AuthenticatedRequest, propertyId: number): Promise<void> {
  const tokenPropertyId = Number(req.user?.property_id);
  const isSuperAdmin = req.user?.id
    ? await isPlatformSuperAdmin(pool, req.user.id)
    : false;
  if (!isSuperAdmin && tokenPropertyId !== propertyId) {
    throw { statusCode: 403, code: 'PROPERTY_SCOPE_REQUIRED', message: 'Tidak memiliki akses ke properti ini' };
  }
}

export function createDocumentRouter(pool: Pool): Router {
  const router = Router();

  // GET /api/documents/reservations
  router.get('/reservations', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const propertyId = parsePositiveInt(req.query.property_id);
      if (propertyId === null) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id is required and must be a positive integer',
        });
      }

      await assertPropertyScope(pool, req, propertyId);

      // HARD STOP: feature gate - even super admin cannot bypass
      const documentsEnabled = await isFeatureEnabled(pool, propertyId, 'documents.enabled');
      if (!documentsEnabled) {
        return res.status(403).json({
          status: 'ERROR',
          code: 'MODULE_DISABLED',
          message: 'Fitur Dokumen & Print telah dinonaktifkan oleh administrator.',
        });
      }

      const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;
      const result = await getDocumentReservationList(pool, propertyId, search);
      return res.json(result);
    } catch (err: any) {
      const status = err.statusCode || 500;
      return res.status(status).json({
        status: 'ERROR',
        code: err.code || 'INTERNAL_ERROR',
        message: err.message || 'Terjadi kesalahan internal',
      });
    }
  });

  // GET /api/documents/reservations/:id
  router.get('/reservations/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const reservationId = parsePositiveInt(req.params.id);
      if (reservationId === null) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'id must be a positive integer',
        });
      }

      const propertyId = parsePositiveInt(req.query.property_id);
      if (propertyId === null) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id is required and must be a positive integer',
        });
      }

      await assertPropertyScope(pool, req, propertyId);

      // HARD STOP: feature gate - even super admin cannot bypass
      const documentsEnabled = await isFeatureEnabled(pool, propertyId, 'documents.enabled');
      if (!documentsEnabled) {
        return res.status(403).json({
          status: 'ERROR',
          code: 'MODULE_DISABLED',
          message: 'Fitur Dokumen & Print telah dinonaktifkan oleh administrator.',
        });
      }

      const result = await getDocumentReservationDetail(pool, propertyId, reservationId);
      if ((result as any).status === 'ERROR' && (result as any).code === 'RESERVATION_NOT_FOUND') {
        return res.status(404).json(result);
      }
      return res.status(200).json(result);
    } catch (err: any) {
      const status = err.statusCode || 500;
      return res.status(status).json({
        status: 'ERROR',
        code: err.code || 'INTERNAL_ERROR',
        message: err.message || 'Terjadi kesalahan internal',
      });
    }
  });

  return router;
}

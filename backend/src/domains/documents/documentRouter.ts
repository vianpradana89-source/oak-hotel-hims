/**
 * documentRouter.ts
 *
 * Dedicated Document & Print read endpoints:
 *   GET /api/documents/reservations            -> list (picker)
 *   GET /api/documents/reservations/:id        -> detail (confirmation / quotation print)
 *   GET /api/documents/reservations/:id/folio  -> Guest Folio (Tagihan Tamu) read-only projection
 *
 * Authorization flow (in strict order):
 *   1. requireAuth               -> 401 if no token
 *   2. parsePositiveInt property_id -> 400 if missing/invalid
 *   3. assertPropertyScope       -> 403 if user cannot access this property
 *   4. isFeatureEnabled(documents.enabled) -> 403 MODULE_DISABLED
 *   5. (operationalAccessGuard enforces Dokumen & Print view permission,
 *       and feature gate is a HARD STOP regardless of permissions)
 *   6. call documentReservationReadService / documentGuestFolioReadService
 *
 * This router must be mounted AFTER the operational access guard so that
 * the guard's permission check still runs. However, this router provides
 * its own feature-gate hard stop that even Platform Super Admin cannot bypass.
 */

import { Router, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/authMiddleware';
import { isPlatformSuperAdmin } from '../auth/authService';
import { isFeatureEnabled } from '../features/featureService';
import {
  getDocumentReservationList,
  getDocumentReservationDetail,
} from './documentReservationReadService';
import { getDocumentGuestFolio } from './documentGuestFolioReadService';
import {
  createQuotation,
  updateQuotationRevision,
  listQuotations,
  getQuotationDetail,
  softDeleteQuotation,
  restoreQuotation,
} from './quotationService';

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

  const propCheck = await pool.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
  if ((propCheck.rowCount ?? 0) === 0) {
    throw { statusCode: 404, code: 'PROPERTY_NOT_FOUND', message: `Properti ${propertyId} tidak ditemukan` };
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
      const includeId = parsePositiveInt(req.query.include_id) ?? undefined;
      const result = await getDocumentReservationList(pool, propertyId, search, includeId);
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

  // GET /api/documents/reservations/:id/folio
  router.get('/reservations/:id/folio', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
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

      const scope = typeof req.query.scope === 'string' ? req.query.scope.trim() : undefined;
      const result = await getDocumentGuestFolio(pool, propertyId, reservationId, {
        scope,
        user: req.user,
      });

      if ((result as any).status === 'ERROR') {
        const errCode = (result as any).code;
        if (errCode === 'RESERVATION_NOT_FOUND' || errCode === 'PROPERTY_NOT_FOUND') {
          return res.status(404).json(result);
        }
        return res.status(400).json(result);
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

  // ── Quotation Endpoints ──────────────────────────────────────────────────

  // GET /api/documents/quotations - list quotations
  router.get('/quotations', requireAuth, requirePermission('documents.view'), async (req: AuthenticatedRequest, res: Response) => {
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

      const status = req.query.status === 'DELETED' ? 'DELETED' : (req.query.status === 'ALL' ? 'ALL' : 'ACTIVE');
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const page = parsePositiveInt(req.query.page) || 1;
      const limit = parsePositiveInt(req.query.limit) || 50;

      const result = await listQuotations(pool, propertyId, { status, search, page, limit });
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

  // POST /api/documents/quotations - create quotation
  router.post('/quotations', requireAuth, requirePermission('documents.create'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const propertyId = parsePositiveInt(req.body.property_id || req.query.property_id);
      if (propertyId === null) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id is required and must be a positive integer',
        });
      }
      await assertPropertyScope(pool, req, propertyId);

      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ status: 'ERROR', code: 'UNAUTHORIZED', message: 'User belum login' });
      }

      const result = await createQuotation(pool, propertyId, userId, req.body);
      return res.status(201).json(result);
    } catch (err: any) {
      const status = err.statusCode || 500;
      return res.status(status).json({
        status: 'ERROR',
        code: err.code || 'INTERNAL_ERROR',
        message: err.message || 'Terjadi kesalahan internal',
      });
    }
  });

  // GET /api/documents/quotations/:id - get detail
  router.get('/quotations/:id', requireAuth, requirePermission('documents.view'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const quotationId = parsePositiveInt(req.params.id);
      if (quotationId === null) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'id must be a positive integer' });
      }
      const propertyId = parsePositiveInt(req.query.property_id);
      if (propertyId === null) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
      }
      await assertPropertyScope(pool, req, propertyId);

      const result = await getQuotationDetail(pool, quotationId, propertyId);
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

  // PUT /api/documents/quotations/:id - save revision
  router.put('/quotations/:id', requireAuth, requirePermission('documents.edit'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const quotationId = parsePositiveInt(req.params.id);
      if (quotationId === null) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'id must be a positive integer' });
      }
      const propertyId = parsePositiveInt(req.body.property_id || req.query.property_id);
      if (propertyId === null) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
      }
      await assertPropertyScope(pool, req, propertyId);

      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ status: 'ERROR', code: 'UNAUTHORIZED', message: 'User belum login' });
      }

      const expectedVersion = Number(req.body.expected_version ?? req.body.version);
      if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'expected_version is required for optimistic concurrency control',
        });
      }

      const result = await updateQuotationRevision(pool, quotationId, propertyId, userId, expectedVersion, req.body);
      return res.status(200).json(result);
    } catch (err: any) {
      const status = err.statusCode || 500;
      return res.status(status).json({
        status: 'ERROR',
        code: err.code || 'INTERNAL_ERROR',
        message: err.message || 'Terjadi kesalahan internal',
        current_version: err.current_version,
      });
    }
  });

  // DELETE /api/documents/quotations/:id - soft delete
  router.delete('/quotations/:id', requireAuth, requirePermission('documents.delete'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const quotationId = parsePositiveInt(req.params.id);
      if (quotationId === null) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'id must be a positive integer' });
      }
      const propertyId = parsePositiveInt(req.query.property_id || req.body?.property_id);
      if (propertyId === null) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
      }
      await assertPropertyScope(pool, req, propertyId);

      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ status: 'ERROR', code: 'UNAUTHORIZED', message: 'User belum login' });
      }

      const result = await softDeleteQuotation(pool, quotationId, propertyId, userId);
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

  // POST /api/documents/quotations/:id/restore - restore
  router.post('/quotations/:id/restore', requireAuth, requirePermission('documents.edit'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const quotationId = parsePositiveInt(req.params.id);
      if (quotationId === null) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'id must be a positive integer' });
      }
      const propertyId = parsePositiveInt(req.query.property_id || req.body?.property_id);
      if (propertyId === null) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
      }
      await assertPropertyScope(pool, req, propertyId);

      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ status: 'ERROR', code: 'UNAUTHORIZED', message: 'User belum login' });
      }

      const result = await restoreQuotation(pool, quotationId, propertyId, userId);
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

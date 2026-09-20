import { Router, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { isPlatformSuperAdmin } from '../auth/authService';
import {
  getPropertyPaymentInstructions,
  updatePropertyPaymentInstructions,
  PropertyPaymentInstructionsError,
} from './propertyPaymentInstructionsService';

/**
 * Creates router for Property Payment Instructions.
 * Mountable at both:
 * 1. /api/settings/property/payment-instructions
 * 2. /api/properties/:id/payment-instructions
 */
export function createPropertyPaymentInstructionsRouter(pool: Pool): Router {
  const router = Router({ mergeParams: true });

  // Resolve target property ID from query param, route param, or request body
  const resolveTargetPropertyId = (req: AuthenticatedRequest): number | null => {
    const raw = req.params.propertyId || req.params.id || req.query.property_id || req.body?.property_id;
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    const num = Number(raw);
    return Number.isInteger(num) && num > 0 ? num : null;
  };

  // Property scope security verification
  const assertPropertyAccess = async (req: AuthenticatedRequest, targetPropertyId: number): Promise<boolean> => {
    const user = req.user;
    if (!user) return false;

    // Platform Super Admin has access across all properties
    if (await isPlatformSuperAdmin(pool, user.id)) {
      return true;
    }

    // Scoped property users can only view/edit their own property
    const userPropertyId = Number(user.property_id);
    return Number.isInteger(userPropertyId) && userPropertyId === targetPropertyId;
  };

  // --------------------------------------------------------------------------
  // GET / (when mounted at /api/settings/property/payment-instructions)
  // GET /:id/payment-instructions (when mounted at /api/properties)
  // --------------------------------------------------------------------------
  const handleGet = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const propertyId = resolveTargetPropertyId(req);
      if (!propertyId) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'Parameter property_id wajib disertakan dan harus berupa angka positif.',
        });
      }

      const hasAccess = await assertPropertyAccess(req, propertyId);
      if (!hasAccess) {
        return res.status(403).json({
          status: 'ERROR',
          code: 'FORBIDDEN_CROSS_PROPERTY',
          message: 'Akses ditolak: properti tidak sesuai dengan profil akun Anda.',
        });
      }

      const data = await getPropertyPaymentInstructions(pool, propertyId);
      return res.status(200).json({
        status: 'OK',
        data,
      });
    } catch (err: any) {
      if (err instanceof PropertyPaymentInstructionsError) {
        return res.status(err.statusCode).json({
          status: 'ERROR',
          code: err.code,
          message: err.message,
        });
      }
      return res.status(500).json({
        status: 'ERROR',
        code: 'INTERNAL_ERROR',
        message: err.message || 'Internal server error while fetching payment instructions',
      });
    }
  };

  // --------------------------------------------------------------------------
  // PUT / (when mounted at /api/settings/property/payment-instructions)
  // PUT /:id/payment-instructions (when mounted at /api/properties)
  // --------------------------------------------------------------------------
  const handlePut = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const propertyId = resolveTargetPropertyId(req);
      if (!propertyId) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib disertakan dan harus berupa angka positif.',
        });
      }

      const hasAccess = await assertPropertyAccess(req, propertyId);
      if (!hasAccess) {
        return res.status(403).json({
          status: 'ERROR',
          code: 'FORBIDDEN_CROSS_PROPERTY',
          message: 'Akses ditolak: properti tidak sesuai dengan profil akun Anda.',
        });
      }

      const actor = req.user?.username || req.user?.full_name || 'Staff';
      const updated = await updatePropertyPaymentInstructions(pool, propertyId, req.body || {}, actor);

      return res.status(200).json({
        status: 'OK',
        message: 'Instruksi pembayaran properti berhasil disimpan.',
        data: updated,
      });
    } catch (err: any) {
      if (err instanceof PropertyPaymentInstructionsError) {
        return res.status(err.statusCode).json({
          status: 'ERROR',
          code: err.code,
          message: err.message,
        });
      }
      return res.status(500).json({
        status: 'ERROR',
        code: 'INTERNAL_ERROR',
        message: err.message || 'Internal server error while updating payment instructions',
      });
    }
  };

  // Mount handlers for root (settings router mount) and sub-routes (property router mount)
  router.get('/', requireAuth, handleGet);
  router.put('/', requireAuth, handlePut);
  router.get('/:id/payment-instructions', requireAuth, handleGet);
  router.put('/:id/payment-instructions', requireAuth, handlePut);

  return router;
}

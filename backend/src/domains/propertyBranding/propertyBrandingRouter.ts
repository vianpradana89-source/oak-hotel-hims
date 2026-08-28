import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import {
  getPropertyBranding,
  updatePropertyBranding,
  PropertyBrandingError,
} from './propertyBrandingService';

export function createPropertyBrandingRouter(pool: Pool): Router {
  const router = Router();

  // GET /api/properties/:id/branding
  router.get('/:id/branding', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.params.id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'Invalid property ID parameter',
        });
      }

      const branding = await getPropertyBranding(pool, propertyId);
      return res.status(200).json({
        status: 'OK',
        data: branding,
      });
    } catch (err: any) {
      if (err instanceof PropertyBrandingError) {
        return res.status(err.statusCode).json({
          status: 'ERROR',
          code: err.code,
          message: err.message,
        });
      }
      return res.status(500).json({
        status: 'ERROR',
        code: 'INTERNAL_ERROR',
        message: err.message || 'Internal server error while fetching property branding',
      });
    }
  });

  // PUT /api/properties/:id/branding
  router.put('/:id/branding', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.params.id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'Invalid property ID parameter',
        });
      }

      const updated = await updatePropertyBranding(pool, propertyId, req.body || {});
      return res.status(200).json({
        status: 'OK',
        message: 'Property branding updated successfully',
        data: updated,
      });
    } catch (err: any) {
      if (err instanceof PropertyBrandingError) {
        return res.status(err.statusCode).json({
          status: 'ERROR',
          code: err.code,
          message: err.message,
        });
      }
      return res.status(500).json({
        status: 'ERROR',
        code: 'INTERNAL_ERROR',
        message: err.message || 'Internal server error while updating property branding',
      });
    }
  });

  return router;
}

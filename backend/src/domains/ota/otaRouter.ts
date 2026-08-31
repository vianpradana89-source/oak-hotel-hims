import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import {
  listOtaSources,
  createOtaSource,
  updateOtaSource,
  deleteOrArchiveOtaSource
} from './otaService';

export function createOtaRouter(pool: Pool): Router {
  const router = Router();

  // GET /api/ota-sources?property_id=1&include_archived=false
  router.get('/', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.query.property_id || 1);
      const includeArchived = req.query.include_archived === 'true';
      const sources = await listOtaSources(pool, propertyId, includeArchived);
      return res.json({ success: true, data: sources });
    } catch (err: any) {
      console.error('Error listing OTA sources:', err);
      return res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message || 'Gagal memuat sumber OTA'
      });
    }
  });

  // POST /api/ota-sources
  router.post('/', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.body.property_id || req.query.property_id || 1);
      const { code, name, description, commission_rate_percent, display_order, is_active } = req.body;
      const created = await createOtaSource(pool, {
        property_id: propertyId,
        code,
        name,
        description,
        commission_rate_percent: commission_rate_percent !== undefined ? Number(commission_rate_percent) : undefined,
        display_order: display_order !== undefined ? Number(display_order) : undefined,
        is_active: is_active !== undefined ? Boolean(is_active) : true
      });
      return res.status(201).json({ success: true, data: created });
    } catch (err: any) {
      console.error('Error creating OTA source:', err);
      return res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message || 'Gagal membuat sumber OTA'
      });
    }
  });

  // PUT /api/ota-sources/:id
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const propertyId = Number(req.body.property_id || req.query.property_id || 1);
      const { name, description, commission_rate_percent, is_active, is_archived, display_order } = req.body;
      const updated = await updateOtaSource(pool, id, propertyId, {
        name,
        description,
        commission_rate_percent: commission_rate_percent !== undefined ? (commission_rate_percent === null ? null : Number(commission_rate_percent)) : undefined,
        is_active,
        is_archived,
        display_order
      });
      return res.json({ success: true, data: updated });
    } catch (err: any) {
      console.error('Error updating OTA source:', err);
      return res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message || 'Gagal memperbarui sumber OTA'
      });
    }
  });

  // PATCH /api/ota-sources/:id/status
  router.patch('/:id/status', async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const propertyId = Number(req.body.property_id || req.query.property_id || 1);
      const { is_active } = req.body;
      const updated = await updateOtaSource(pool, id, propertyId, {
        is_active: Boolean(is_active)
      });
      return res.json({ success: true, data: updated });
    } catch (err: any) {
      console.error('Error toggling OTA source status:', err);
      return res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message || 'Gagal mengubah status sumber OTA'
      });
    }
  });

  // PATCH /api/ota-sources/:id
  router.patch('/:id', async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const propertyId = Number(req.body.property_id || req.query.property_id || 1);
      const { name, description, commission_rate_percent, is_active, is_archived, display_order } = req.body;
      const updated = await updateOtaSource(pool, id, propertyId, {
        name,
        description,
        commission_rate_percent: commission_rate_percent !== undefined ? (commission_rate_percent === null ? null : Number(commission_rate_percent)) : undefined,
        is_active,
        is_archived,
        display_order
      });
      return res.json({ success: true, data: updated });
    } catch (err: any) {
      console.error('Error updating OTA source:', err);
      return res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message || 'Gagal memperbarui sumber OTA'
      });
    }
  });

  // DELETE /api/ota-sources/:id
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const propertyId = Number(req.query.property_id || req.body.property_id || 1);
      const result = await deleteOrArchiveOtaSource(pool, id, propertyId);
      return res.json({
        success: true,
        action: result.action,
        data: result.source,
        message: result.action === 'ARCHIVED'
          ? 'Sumber OTA telah diarsipkan karena memiliki riwayat reservasi'
          : 'Sumber OTA berhasil dihapus'
      });
    } catch (err: any) {
      console.error('Error deleting OTA source:', err);
      return res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message || 'Gagal menghapus sumber OTA'
      });
    }
  });

  return router;
}

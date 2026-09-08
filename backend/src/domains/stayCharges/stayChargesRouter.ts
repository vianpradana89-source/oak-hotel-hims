import { Router, Request, Response } from 'express';
import type { Pool } from 'pg';
import {
  createStayChargeRule,
  deleteStayChargeRule,
  getStayChargeRuleById,
  listStayChargeRules,
  postStayChargeToFolio,
  updateStayChargeRule,
  voidFolioEntry,
  correctFolioEntry
} from './stayChargesService';
import type { StayChargeType } from './stayChargesTypes';
import { requireAuth, type AuthenticatedRequest } from '../auth/authMiddleware';
import { isPlatformSuperAdmin } from '../auth/authService';

export function createStayChargesRouter(pool: Pool): Router {
  const router = Router();
  router.use(requireAuth);

  function getPropertyId(req: AuthenticatedRequest): number {
    const raw = req.query.property_id || req.body?.property_id;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      throw { status: 400, statusCode: 400, code: 'VALIDATION_ERROR', message: 'property_id wajib diisi' };
    }
    const propId = Number(raw);
    if (!Number.isInteger(propId) || propId <= 0) {
      throw { status: 400, statusCode: 400, code: 'VALIDATION_ERROR', message: 'property_id tidak valid' };
    }
    return propId;
  }

  async function resolveScopedPropertyId(req: AuthenticatedRequest): Promise<number> {
    const requested = getPropertyId(req);
    const tokenPropertyId = Number(req.user?.property_id);
    if (requested !== tokenPropertyId && !(await isPlatformSuperAdmin(pool, req.user?.id))) {
      throw {
        status: 403,
        statusCode: 403,
        code: 'CROSS_PROPERTY_ACCESS',
        message: 'Cross-property access is not allowed'
      };
    }
    return requested;
  }

  function actorName(req: AuthenticatedRequest): string {
    return req.user?.full_name || req.user?.username || 'SYSTEM';
  }

  function sendError(res: Response, err: any, fallbackStatus: number, fallbackMessage: string) {
    const statusCode = err.statusCode || err.status || fallbackStatus;
    return res.status(statusCode).json({
      status: 'ERROR',
      code: err.code || 'STAY_CHARGE_ERROR',
      message: err.message || fallbackMessage
    });
  }

  // GET /api/stay-charges/rules
  router.get('/rules', async (req: AuthenticatedRequest, res) => {
    try {
      const propertyId = await resolveScopedPropertyId(req);
      const chargeType = req.query.charge_type as StayChargeType | undefined;
      const includeArchived = ['1', 'true', 'yes'].includes(String(req.query.include_archived || '').toLowerCase());

      const rules = await listStayChargeRules(pool, propertyId, chargeType, includeArchived);
      res.json(rules);
    } catch (err: any) {
      sendError(res, err, 500, 'Gagal memuat aturan biaya');
    }
  });

  // GET /api/stay-charges/rules/:id
  router.get('/rules/:id', async (req: AuthenticatedRequest, res) => {
    try {
      const propertyId = await resolveScopedPropertyId(req);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'ID aturan tidak valid' });
      }

      const rule = await getStayChargeRuleById(pool, propertyId, id);
      if (!rule) {
        return res.status(404).json({ status: 'ERROR', code: 'NOT_FOUND', message: `Aturan biaya #${id} tidak ditemukan` });
      }
      res.json(rule);
    } catch (err: any) {
      sendError(res, err, 500, 'Gagal memuat detail aturan biaya');
    }
  });

  // POST /api/stay-charges/rules
  router.post('/rules', async (req: AuthenticatedRequest, res) => {
    try {
      const propertyId = await resolveScopedPropertyId(req);
      const rule = await createStayChargeRule(pool, propertyId, req.body, actorName(req));
      res.status(201).json(rule);
    } catch (err: any) {
      sendError(res, err, 400, 'Gagal membuat aturan biaya');
    }
  });

  // PATCH /api/stay-charges/rules/:id
  router.patch('/rules/:id', async (req: AuthenticatedRequest, res) => {
    try {
      const propertyId = await resolveScopedPropertyId(req);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'ID aturan tidak valid' });
      }
      const updated = await updateStayChargeRule(pool, propertyId, id, req.body, actorName(req));
      res.json(updated);
    } catch (err: any) {
      sendError(res, err, 400, 'Gagal memperbarui aturan biaya');
    }
  });

  // DELETE /api/stay-charges/rules/:id
  router.delete('/rules/:id', async (req: AuthenticatedRequest, res) => {
    try {
      const propertyId = await resolveScopedPropertyId(req);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'ID aturan tidak valid' });
      }
      const result = await deleteStayChargeRule(pool, propertyId, id, actorName(req));
      res.json(result);
    } catch (err: any) {
      sendError(res, err, 400, 'Gagal menghapus aturan biaya');
    }
  });

  // POST /api/stay-charges/post-charge
  router.post('/post-charge', async (req: AuthenticatedRequest, res) => {
    const client = await pool.connect();
    try {
      const propertyId = await resolveScopedPropertyId(req);
      await client.query('BEGIN');
      const result = await postStayChargeToFolio(client, propertyId, req.body);
      await client.query('COMMIT');
      res.status(201).json({ status: 'SUCCESS', data: result });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      sendError(res, err, 400, 'Gagal membebankan biaya ke folio');
    } finally {
      client.release();
    }
  });

  // POST /api/stay-charges/void-entry or /api/stay-charges/void-entry/:id
  const handleVoidEntry = async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const client = await pool.connect();
    try {
      const propertyId = await resolveScopedPropertyId(authReq);
      const folioEntryId = Number(req.params.id || req.body?.folio_entry_id);
      const reservationId = Number(req.body?.reservation_id || 0);
      if (!Number.isInteger(folioEntryId) || folioEntryId <= 0) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'ID item folio tidak valid' });
      }

      await client.query('BEGIN');
      const result = await voidFolioEntry(client, propertyId, reservationId, folioEntryId, req.body);
      await client.query('COMMIT');
      res.json({ status: 'SUCCESS', data: result });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      sendError(res, err, 400, 'Gagal membatalkan (void) item folio');
    } finally {
      client.release();
    }
  };

  router.post('/void-entry', handleVoidEntry);
  router.post('/void-entry/:id', handleVoidEntry);

  // POST /api/stay-charges/correct-entry or /api/stay-charges/correct-entry/:id
  const handleCorrectEntry = async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const client = await pool.connect();
    try {
      const propertyId = await resolveScopedPropertyId(authReq);
      const folioEntryId = Number(req.params.id || req.body?.folio_entry_id);
      const reservationId = Number(req.body?.reservation_id || 0);
      if (!Number.isInteger(folioEntryId) || folioEntryId <= 0) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'ID item folio tidak valid' });
      }

      await client.query('BEGIN');
      const result = await correctFolioEntry(client, propertyId, reservationId, folioEntryId, req.body);
      await client.query('COMMIT');
      res.json({ status: 'SUCCESS', data: result });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      sendError(res, err, 400, 'Gagal mengoreksi item folio');
    } finally {
      client.release();
    }
  };

  router.post('/correct-entry', handleCorrectEntry);
  router.post('/correct-entry/:id', handleCorrectEntry);

  return router;
}

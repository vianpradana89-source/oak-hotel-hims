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

export function createStayChargesRouter(pool: Pool): Router {
  const router = Router();

  function getPropertyId(req: any): number {
    const raw = req.query.property_id || req.body?.property_id;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      throw { status: 400, statusCode: 400, message: 'property_id wajib diisi' };
    }
    const propId = Number(raw);
    if (!Number.isInteger(propId) || propId <= 0) {
      throw { status: 400, statusCode: 400, message: 'property_id tidak valid' };
    }
    return propId;
  }

  // GET /api/stay-charges/rules
  router.get('/rules', async (req, res) => {
    try {
      const propertyId = getPropertyId(req);
      const chargeType = req.query.charge_type as StayChargeType | undefined;
      const includeArchived = ['1', 'true', 'yes'].includes(String(req.query.include_archived || '').toLowerCase());

      const rules = await listStayChargeRules(pool, propertyId, chargeType, includeArchived);
      res.json(rules);
    } catch (err: any) {
      const statusCode = err.statusCode || err.status || 500;
      res.status(statusCode).json({ status: 'ERROR', message: err.message || 'Gagal memuat aturan biaya' });
    }
  });

  // GET /api/stay-charges/rules/:id
  router.get('/rules/:id', async (req, res) => {
    try {
      const propertyId = getPropertyId(req);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ status: 'ERROR', message: 'ID aturan tidak valid' });
      }

      const rule = await getStayChargeRuleById(pool, propertyId, id);
      if (!rule) {
        return res.status(404).json({ status: 'ERROR', message: `Aturan biaya #${id} tidak ditemukan` });
      }
      res.json(rule);
    } catch (err: any) {
      const statusCode = err.statusCode || err.status || 500;
      res.status(statusCode).json({ status: 'ERROR', message: err.message || 'Gagal memuat detail aturan biaya' });
    }
  });

  // POST /api/stay-charges/rules
  router.post('/rules', async (req, res) => {
    try {
      const propertyId = getPropertyId(req);
      const actor = req.body?.created_by || 'Front Desk';
      const rule = await createStayChargeRule(pool, propertyId, req.body, actor);
      res.status(201).json(rule);
    } catch (err: any) {
      const statusCode = err.statusCode || err.status || 400;
      res.status(statusCode).json({ status: 'ERROR', message: err.message || 'Gagal membuat aturan biaya' });
    }
  });

  // PATCH /api/stay-charges/rules/:id
  router.patch('/rules/:id', async (req, res) => {
    try {
      const propertyId = getPropertyId(req);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ status: 'ERROR', message: 'ID aturan tidak valid' });
      }
      const actor = req.body?.updated_by || 'Front Desk';
      const updated = await updateStayChargeRule(pool, propertyId, id, req.body, actor);
      res.json(updated);
    } catch (err: any) {
      const statusCode = err.statusCode || err.status || 400;
      res.status(statusCode).json({ status: 'ERROR', message: err.message || 'Gagal memperbarui aturan biaya' });
    }
  });

  // DELETE /api/stay-charges/rules/:id
  router.delete('/rules/:id', async (req, res) => {
    try {
      const propertyId = getPropertyId(req);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ status: 'ERROR', message: 'ID aturan tidak valid' });
      }
      const actor = (req.query.actor as string) || 'Front Desk';
      const result = await deleteStayChargeRule(pool, propertyId, id, actor);
      res.json(result);
    } catch (err: any) {
      const statusCode = err.statusCode || err.status || 400;
      res.status(statusCode).json({ status: 'ERROR', message: err.message || 'Gagal menghapus aturan biaya' });
    }
  });

  // POST /api/stay-charges/post-charge
  router.post('/post-charge', async (req, res) => {
    const client = await pool.connect();
    try {
      const propertyId = getPropertyId(req);
      await client.query('BEGIN');
      const result = await postStayChargeToFolio(client, propertyId, req.body);
      await client.query('COMMIT');
      res.status(201).json({ status: 'SUCCESS', data: result });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const statusCode = err.statusCode || err.status || 400;
      res.status(statusCode).json({ status: 'ERROR', message: err.message || 'Gagal membebankan biaya ke folio' });
    } finally {
      client.release();
    }
  });

  // POST /api/stay-charges/void-entry or /api/stay-charges/void-entry/:id
  const handleVoidEntry = async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = getPropertyId(req);
      const folioEntryId = Number(req.params.id || req.body?.folio_entry_id);
      const reservationId = Number(req.body?.reservation_id || 0);
      if (!Number.isInteger(folioEntryId) || folioEntryId <= 0) {
        return res.status(400).json({ status: 'ERROR', message: 'ID item folio tidak valid' });
      }

      await client.query('BEGIN');
      const result = await voidFolioEntry(client, propertyId, reservationId, folioEntryId, req.body);
      await client.query('COMMIT');
      res.json({ status: 'SUCCESS', data: result });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const statusCode = err.statusCode || err.status || 400;
      res.status(statusCode).json({ status: 'ERROR', message: err.message || 'Gagal membatalkan (void) item folio' });
    } finally {
      client.release();
    }
  };

  router.post('/void-entry', handleVoidEntry);
  router.post('/void-entry/:id', handleVoidEntry);

  // POST /api/stay-charges/correct-entry or /api/stay-charges/correct-entry/:id
  const handleCorrectEntry = async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = getPropertyId(req);
      const folioEntryId = Number(req.params.id || req.body?.folio_entry_id);
      const reservationId = Number(req.body?.reservation_id || 0);
      if (!Number.isInteger(folioEntryId) || folioEntryId <= 0) {
        return res.status(400).json({ status: 'ERROR', message: 'ID item folio tidak valid' });
      }

      await client.query('BEGIN');
      const result = await correctFolioEntry(client, propertyId, reservationId, folioEntryId, req.body);
      await client.query('COMMIT');
      res.json({ status: 'SUCCESS', data: result });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const statusCode = err.statusCode || err.status || 400;
      res.status(statusCode).json({ status: 'ERROR', message: err.message || 'Gagal mengoreksi item folio' });
    } finally {
      client.release();
    }
  };

  router.post('/correct-entry', handleCorrectEntry);
  router.post('/correct-entry/:id', handleCorrectEntry);

  return router;
}

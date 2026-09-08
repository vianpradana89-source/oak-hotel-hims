import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { resolveAuthenticatedTransactionWrite } from './transactionReadAuth';
import {
  createPurchaseCategory,
  deletePurchaseCategory,
  getPurchaseFormOptions,
  listPurchaseCategories,
  listPurchaseDepartmentOptions,
  replacePurchaseAllowedDepartments,
  setPurchaseCategoryActive,
  updatePurchaseCategory,
} from './purchaseSettingsService';

export function createPurchaseSettingsRouter(pool: Pool): Router {
  const router = Router();

  router.get('/categories', async (req: Request, res: Response) => {
    try {
      const scoped = await resolveAuthenticatedTransactionWrite({ req, res, pool });
      if (!scoped) return;
      const rows = await listPurchaseCategories(pool, scoped.propertyId);
      return res.json({ success: true, data: rows });
    } catch (err: any) {
      return res.status(err.statusCode || 400).json({ success: false, code: err.code, error: err.message });
    }
  });

  router.post('/categories', async (req: Request, res: Response) => {
    try {
      const scoped = await resolveAuthenticatedTransactionWrite({ req, res, pool });
      if (!scoped) return;
      const created = await createPurchaseCategory(pool, {
        property_id: scoped.propertyId,
        name: req.body.name,
        code: req.body.code,
        description: req.body.description,
        sort_order: req.body.sort_order,
        actor_name: req.body.actor_name || scoped.user.full_name || scoped.user.username || 'Staff',
      });
      return res.status(201).json({ success: true, data: created });
    } catch (err: any) {
      return res.status(err.statusCode || 400).json({ success: false, code: err.code, error: err.message });
    }
  });

  router.patch('/categories/:id', async (req: Request, res: Response) => {
    try {
      const scoped = await resolveAuthenticatedTransactionWrite({ req, res, pool });
      if (!scoped) return;
      const updated = await updatePurchaseCategory(pool, scoped.propertyId, Number(req.params.id), {
        name: req.body.name,
        description: req.body.description,
        sort_order: req.body.sort_order,
        actor_name: req.body.actor_name || scoped.user.full_name || scoped.user.username || 'Staff',
      });
      return res.json({ success: true, data: updated });
    } catch (err: any) {
      return res.status(err.statusCode || 400).json({ success: false, code: err.code, error: err.message });
    }
  });

  router.post('/categories/:id/activate', async (req: Request, res: Response) => {
    try {
      const scoped = await resolveAuthenticatedTransactionWrite({ req, res, pool });
      if (!scoped) return;
      const updated = await setPurchaseCategoryActive(
        pool,
        scoped.propertyId,
        Number(req.params.id),
        true,
        req.body.actor_name || scoped.user.full_name || scoped.user.username
      );
      return res.json({ success: true, data: updated });
    } catch (err: any) {
      return res.status(err.statusCode || 400).json({ success: false, code: err.code, error: err.message });
    }
  });

  router.post('/categories/:id/deactivate', async (req: Request, res: Response) => {
    try {
      const scoped = await resolveAuthenticatedTransactionWrite({ req, res, pool });
      if (!scoped) return;
      const updated = await setPurchaseCategoryActive(
        pool,
        scoped.propertyId,
        Number(req.params.id),
        false,
        req.body.actor_name || scoped.user.full_name || scoped.user.username
      );
      return res.json({ success: true, data: updated });
    } catch (err: any) {
      return res.status(err.statusCode || 400).json({ success: false, code: err.code, error: err.message });
    }
  });

  router.delete('/categories/:id', async (req: Request, res: Response) => {
    try {
      const scoped = await resolveAuthenticatedTransactionWrite({ req, res, pool });
      if (!scoped) return;
      const result = await deletePurchaseCategory(
        pool,
        scoped.propertyId,
        Number(req.params.id),
        req.body?.actor_name || scoped.user.full_name || scoped.user.username
      );
      return res.json({ success: true, data: result });
    } catch (err: any) {
      return res.status(err.statusCode || 400).json({ success: false, code: err.code, error: err.message });
    }
  });

  router.get('/allowed-departments', async (req: Request, res: Response) => {
    try {
      const scoped = await resolveAuthenticatedTransactionWrite({ req, res, pool });
      if (!scoped) return;
      const data = await listPurchaseDepartmentOptions(pool, scoped.propertyId);
      return res.json({ success: true, data });
    } catch (err: any) {
      return res.status(err.statusCode || 400).json({ success: false, code: err.code, error: err.message });
    }
  });

  router.put('/allowed-departments', async (req: Request, res: Response) => {
    try {
      const scoped = await resolveAuthenticatedTransactionWrite({ req, res, pool });
      if (!scoped) return;
      const data = await replacePurchaseAllowedDepartments(
        pool,
        scoped.propertyId,
        Array.isArray(req.body.department_ids) ? req.body.department_ids : [],
        req.body.actor_name || scoped.user.full_name || scoped.user.username
      );
      return res.json({ success: true, data });
    } catch (err: any) {
      return res.status(err.statusCode || 400).json({ success: false, code: err.code, error: err.message });
    }
  });

  router.get('/form-options', async (req: Request, res: Response) => {
    try {
      const scoped = await resolveAuthenticatedTransactionWrite({ req, res, pool });
      if (!scoped) return;
      const data = await getPurchaseFormOptions(pool, scoped.propertyId);
      return res.json({ success: true, data });
    } catch (err: any) {
      return res.status(err.statusCode || 400).json({ success: false, code: err.code, error: err.message });
    }
  });

  return router;
}

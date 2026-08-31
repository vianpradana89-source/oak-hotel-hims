import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { getSuppliers, getSupplierById, createSupplier, updateSupplier } from './supplierService';

export function createSuppliersRouter(pool: Pool): Router {
  const router = Router();

  /**
   * GET /api/suppliers
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.query.property_id || (req as any).propertyId || 1);
      if (!propertyId || isNaN(propertyId)) {
        return res.status(400).json({ success: false, error: 'property_id wajib disertakan' });
      }

      const search = req.query.search ? String(req.query.search) : undefined;
      const isActive = req.query.is_active !== undefined ? req.query.is_active === 'true' || req.query.is_active === '1' : undefined;

      const suppliers = await getSuppliers(pool, {
        property_id: propertyId,
        search,
        is_active: isActive
      });

      return res.json({
        success: true,
        data: suppliers
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/suppliers/:id
   */
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.query.property_id || (req as any).propertyId || 1);
      const supplier = await getSupplierById(pool, propertyId, req.params.id);
      if (!supplier) {
        return res.status(404).json({ success: false, error: 'Supplier tidak ditemukan' });
      }
      return res.json({ success: true, data: supplier });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/suppliers
   */
  router.post('/', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.body.property_id || (req as any).propertyId || 1);
      if (!propertyId || isNaN(propertyId)) {
        return res.status(400).json({ success: false, error: 'property_id wajib disertakan' });
      }

      const supplier = await createSupplier(pool, {
        property_id: propertyId,
        name: req.body.name,
        phone: req.body.phone,
        bank_name: req.body.bank_name,
        bank_account: req.body.bank_account,
        address: req.body.address,
        actor_name: req.body.actor_name
      });

      return res.status(201).json({ success: true, data: supplier });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  /**
   * PUT /api/suppliers/:id
   */
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.body.property_id || (req as any).propertyId || 1);
      if (!propertyId || isNaN(propertyId)) {
        return res.status(400).json({ success: false, error: 'property_id wajib disertakan' });
      }

      const updated = await updateSupplier(pool, propertyId, req.params.id, {
        name: req.body.name,
        phone: req.body.phone,
        bank_name: req.body.bank_name,
        bank_account: req.body.bank_account,
        address: req.body.address,
        is_active: req.body.is_active,
        actor_name: req.body.actor_name
      });

      return res.json({ success: true, data: updated });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  /**
   * PATCH /api/suppliers/:id/toggle
   */
  router.patch('/:id/toggle', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.body.property_id || (req as any).propertyId || 1);
      const current = await getSupplierById(pool, propertyId, req.params.id);
      if (!current) {
        return res.status(404).json({ success: false, error: 'Supplier tidak ditemukan' });
      }

      const updated = await updateSupplier(pool, propertyId, req.params.id, {
        is_active: !current.is_active,
        actor_name: req.body.actor_name
      });

      return res.json({ success: true, data: updated });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  return router;
}

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import {
  getSuppliers,
  getSupplierById,
  createSupplier,
  updateSupplier,
  toggleSupplier,
  deleteSupplier
} from './supplierService';

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
      const entityType = req.query.entity_type ? String(req.query.entity_type) : undefined;
      const category = req.query.category ? String(req.query.category) : undefined;
      const status = req.query.status ? String(req.query.status) : undefined;
      const isActive = req.query.is_active !== undefined
        ? req.query.is_active === 'true' || req.query.is_active === '1'
        : undefined;
      const includeDeleted = req.query.include_deleted === 'true' || req.query.include_deleted === '1';
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
      const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : undefined;

      const suppliers = await getSuppliers(pool, {
        property_id: propertyId,
        search,
        entity_type: entityType,
        category,
        status,
        is_active: isActive,
        include_deleted: includeDeleted,
        limit,
        offset
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
        code: req.body.code,
        name: req.body.name,
        legal_name: req.body.legal_name,
        entity_type: req.body.entity_type,
        category: req.body.category,
        contact_person: req.body.contact_person,
        phone: req.body.phone,
        whatsapp: req.body.whatsapp,
        email: req.body.email,
        address: req.body.address,
        city: req.body.city,
        province: req.body.province,
        tax_id: req.body.tax_id,
        bank_name: req.body.bank_name,
        bank_account: req.body.bank_account,
        bank_holder: req.body.bank_holder,
        payment_terms_days: req.body.payment_terms_days,
        default_department_code: req.body.default_department_code,
        status: req.body.status,
        notes: req.body.notes,
        is_active: req.body.is_active,
        actor_name: req.body.actor_name,
        created_by: req.body.created_by
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
        code: req.body.code,
        name: req.body.name,
        legal_name: req.body.legal_name,
        entity_type: req.body.entity_type,
        category: req.body.category,
        contact_person: req.body.contact_person,
        phone: req.body.phone,
        whatsapp: req.body.whatsapp,
        email: req.body.email,
        address: req.body.address,
        city: req.body.city,
        province: req.body.province,
        tax_id: req.body.tax_id,
        bank_name: req.body.bank_name,
        bank_account: req.body.bank_account,
        bank_holder: req.body.bank_holder,
        payment_terms_days: req.body.payment_terms_days,
        default_department_code: req.body.default_department_code,
        status: req.body.status,
        notes: req.body.notes,
        is_active: req.body.is_active,
        actor_name: req.body.actor_name,
        updated_by: req.body.updated_by
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
      const updated = await toggleSupplier(pool, propertyId, req.params.id, req.body.actor_name);
      return res.json({ success: true, data: updated });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  /**
   * DELETE /api/suppliers/:id
   */
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.body.property_id || req.query.property_id || (req as any).propertyId || 1);
      const result = await deleteSupplier(pool, propertyId, req.params.id, req.body.actor_name || (req.query.actor_name as string));
      return res.json({ success: true, message: result.message });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  return router;
}


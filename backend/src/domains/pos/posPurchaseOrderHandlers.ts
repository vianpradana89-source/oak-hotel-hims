/**
 * HTTP Handlers: Purchase Order, Goods Receipt & Supplier POS (MP-04D)
 * OAK Hotel Integrated Management System (HIMS)
 */

import { Request, Response } from 'express';
import { Pool } from 'pg';
import {
  getPosSuppliers,
  getPosSupplierById,
  createPosSupplier,
  updatePosSupplier,
  deletePosSupplier,
  getPosPurchaseOrders,
  getPosPurchaseOrderById,
  createPosPurchaseOrder,
  updatePosPurchaseOrderStatus,
} from './posPurchaseOrderService';
import {
  recordPosGoodsReceipt,
  getPosGoodsReceipts,
  getPosGoodsReceiptById,
} from './posGoodsReceiptService';

export interface PosPurchaseOrderDeps {
  pool: Pool;
  assertPropertyScope?: (req: any, resOrPropId: any, maybePropId?: any) => Promise<void>;
}

async function invokeAssertPropertyScope(
  fn: PosPurchaseOrderDeps['assertPropertyScope'],
  req: any,
  res: any,
  propertyId: number
): Promise<void> {
  if (typeof fn !== 'function') return;
  if (fn.length >= 3) {
    await (fn as (req: any, res: any, propertyId: number) => Promise<void>)(req, res, propertyId);
  } else {
    await (fn as (req: any, propertyId: number) => Promise<void>)(req, propertyId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Supplier Handlers
// ─────────────────────────────────────────────────────────────────────────────

export function createPosSuppliersListHandler(deps: PosPurchaseOrderDeps) {
  return async function handlePosSuppliersList(req: Request, res: Response) {
    try {
      const propertyId = Number(req.query?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib berupa bilangan bulat positif',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const isActive = req.query?.is_active !== undefined
        ? req.query.is_active === 'true' || req.query.is_active === '1'
        : undefined;

      const suppliers = await getPosSuppliers(deps.pool, propertyId, {
        search: req.query?.search ? String(req.query.search) : undefined,
        is_active: isActive,
      });

      return res.status(200).json({ status: 'OK', data: suppliers });
    } catch (err: any) {
      const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(sc).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal mengambil data supplier',
      });
    }
  };
}

export function createPosSupplierGetHandler(deps: PosPurchaseOrderDeps) {
  return async function handlePosSupplierGet(req: Request, res: Response) {
    try {
      const supplierId = Number(req.params.id);
      const propertyId = Number(req.query?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib berupa bilangan bulat positif',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const supplier = await getPosSupplierById(deps.pool, propertyId, supplierId);
      if (!supplier) {
        return res.status(404).json({
          status: 'ERROR',
          code: 'SUPPLIER_NOT_FOUND',
          message: `Supplier #${supplierId} tidak ditemukan`,
        });
      }

      return res.status(200).json({ status: 'OK', data: supplier });
    } catch (err: any) {
      const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(sc).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal mengambil detail supplier',
      });
    }
  };
}

export function createPosSupplierCreateHandler(deps: PosPurchaseOrderDeps) {
  return async function handlePosSupplierCreate(req: Request, res: Response) {
    try {
      const { property_id, code, name, contact_person, phone, email, address, is_active } = req.body || {};
      const propertyId = Number(property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib diisi dengan benar',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const created = await createPosSupplier(deps.pool, {
        property_id: propertyId,
        code,
        name,
        contact_person,
        phone,
        email,
        address,
        is_active,
      });

      return res.status(201).json({ status: 'OK', data: created });
    } catch (err: any) {
      const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(sc).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal membuat supplier baru',
      });
    }
  };
}

export function createPosSupplierUpdateHandler(deps: PosPurchaseOrderDeps) {
  return async function handlePosSupplierUpdate(req: Request, res: Response) {
    try {
      const supplierId = Number(req.params.id);
      const { property_id, code, name, contact_person, phone, email, address, is_active } = req.body || {};
      const propertyId = Number(property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib diisi dengan benar',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const updated = await updatePosSupplier(deps.pool, propertyId, supplierId, {
        code,
        name,
        contact_person,
        phone,
        email,
        address,
        is_active,
      });

      return res.status(200).json({ status: 'OK', data: updated });
    } catch (err: any) {
      const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(sc).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal memperbarui supplier',
      });
    }
  };
}

export function createPosSupplierDeleteHandler(deps: PosPurchaseOrderDeps) {
  return async function handlePosSupplierDelete(req: Request, res: Response) {
    try {
      const supplierId = Number(req.params.id);
      const propertyId = Number(req.query?.property_id || req.body?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib diisi dengan benar',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const result = await deletePosSupplier(deps.pool, propertyId, supplierId);
      return res.status(200).json({ status: 'OK', data: result });
    } catch (err: any) {
      const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(sc).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal menghapus supplier',
      });
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Purchase Order Handlers
// ─────────────────────────────────────────────────────────────────────────────

export function createPosPurchaseOrdersListHandler(deps: PosPurchaseOrderDeps) {
  return async function handlePosPurchaseOrdersList(req: Request, res: Response) {
    try {
      const propertyId = Number(req.query?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib berupa bilangan bulat positif',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const filter = {
        status: req.query?.status ? String(req.query.status) : undefined,
        supplier_id: req.query?.supplier_id ? Number(req.query.supplier_id) : undefined,
        start_date: req.query?.start_date ? String(req.query.start_date) : undefined,
        end_date: req.query?.end_date ? String(req.query.end_date) : undefined,
        search: req.query?.search ? String(req.query.search) : undefined,
        page: req.query?.page ? Number(req.query.page) : undefined,
        limit: req.query?.limit ? Number(req.query.limit) : undefined,
      };

      const result = await getPosPurchaseOrders(deps.pool, propertyId, filter);
      return res.status(200).json({ status: 'OK', ...result });
    } catch (err: any) {
      const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(sc).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal memuat daftar purchase order',
      });
    }
  };
}

export function createPosPurchaseOrderGetHandler(deps: PosPurchaseOrderDeps) {
  return async function handlePosPurchaseOrderGet(req: Request, res: Response) {
    try {
      const poId = Number(req.params.id);
      const propertyId = Number(req.query?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib berupa bilangan bulat positif',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const po = await getPosPurchaseOrderById(deps.pool, propertyId, poId);
      if (!po) {
        return res.status(404).json({
          status: 'ERROR',
          code: 'PO_NOT_FOUND',
          message: `Purchase Order #${poId} tidak ditemukan`,
        });
      }

      return res.status(200).json({ status: 'OK', data: po });
    } catch (err: any) {
      const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(sc).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal memuat detail purchase order',
      });
    }
  };
}

export function createPosPurchaseOrderCreateHandler(deps: PosPurchaseOrderDeps) {
  return async function handlePosPurchaseOrderCreate(req: Request, res: Response) {
    try {
      const {
        property_id,
        po_number,
        supplier_id,
        order_date,
        expected_date,
        notes,
        created_by,
        items,
      } = req.body || {};

      const propertyId = Number(property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib diisi dengan benar',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const created = await createPosPurchaseOrder(deps.pool, {
        property_id: propertyId,
        po_number,
        supplier_id: Number(supplier_id),
        order_date,
        expected_date,
        notes,
        created_by,
        items,
      });

      return res.status(201).json({ status: 'OK', data: created });
    } catch (err: any) {
      const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(sc).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal membuat purchase order',
      });
    }
  };
}

export function createPosPurchaseOrderStatusHandler(deps: PosPurchaseOrderDeps) {
  return async function handlePosPurchaseOrderStatus(req: Request, res: Response) {
    try {
      const poId = Number(req.params.id);
      const { property_id, status, updated_by } = req.body || {};
      const propertyId = Number(property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib diisi dengan benar',
        });
      }

      if (!status || (status !== 'ORDERED' && status !== 'CANCELLED')) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'INVALID_STATUS',
          message: 'status pembaruan harus ORDERED atau CANCELLED',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const updated = await updatePosPurchaseOrderStatus(deps.pool, propertyId, poId, status, updated_by);
      return res.status(200).json({ status: 'OK', data: updated });
    } catch (err: any) {
      const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(sc).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal memperbarui status purchase order',
      });
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Goods Receipt Handlers
// ─────────────────────────────────────────────────────────────────────────────

export function createPosGoodsReceiptsListHandler(deps: PosPurchaseOrderDeps) {
  return async function handlePosGoodsReceiptsList(req: Request, res: Response) {
    try {
      const propertyId = Number(req.query?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib berupa bilangan bulat positif',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const filter = {
        po_id: req.query?.po_id ? Number(req.query.po_id) : undefined,
        supplier_id: req.query?.supplier_id ? Number(req.query.supplier_id) : undefined,
        location_id: req.query?.location_id ? Number(req.query.location_id) : undefined,
        start_date: req.query?.start_date ? String(req.query.start_date) : undefined,
        end_date: req.query?.end_date ? String(req.query.end_date) : undefined,
        search: req.query?.search ? String(req.query.search) : undefined,
        page: req.query?.page ? Number(req.query.page) : undefined,
        limit: req.query?.limit ? Number(req.query.limit) : undefined,
      };

      const result = await getPosGoodsReceipts(deps.pool, propertyId, filter);
      return res.status(200).json({ status: 'OK', ...result });
    } catch (err: any) {
      const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(sc).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal memuat riwayat penerimaan barang (GRN)',
      });
    }
  };
}

export function createPosGoodsReceiptGetHandler(deps: PosPurchaseOrderDeps) {
  return async function handlePosGoodsReceiptGet(req: Request, res: Response) {
    try {
      const grnId = Number(req.params.id);
      const propertyId = Number(req.query?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib berupa bilangan bulat positif',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const grn = await getPosGoodsReceiptById(deps.pool, propertyId, grnId);
      if (!grn) {
        return res.status(404).json({
          status: 'ERROR',
          code: 'GRN_NOT_FOUND',
          message: `Goods Receipt #${grnId} tidak ditemukan`,
        });
      }

      return res.status(200).json({ status: 'OK', data: grn });
    } catch (err: any) {
      const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(sc).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal memuat detail penerimaan barang',
      });
    }
  };
}

export function createPosGoodsReceiptCreateHandler(deps: PosPurchaseOrderDeps) {
  return async function handlePosGoodsReceiptCreate(req: Request, res: Response) {
    try {
      const {
        property_id,
        grn_number,
        po_id,
        supplier_id,
        location_id,
        receipt_date,
        invoice_no,
        received_by,
        notes,
        idempotency_key,
        items,
      } = req.body || {};

      const propertyId = Number(property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib diisi dengan benar',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const created = await recordPosGoodsReceipt(deps.pool, {
        property_id: propertyId,
        grn_number,
        po_id: po_id ? Number(po_id) : null,
        supplier_id: supplier_id ? Number(supplier_id) : null,
        location_id: Number(location_id),
        receipt_date,
        invoice_no,
        received_by,
        notes,
        idempotency_key,
        items,
      });

      return res.status(201).json({ status: 'OK', data: created });
    } catch (err: any) {
      const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(sc).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal mencatat penerimaan barang (GRN)',
      });
    }
  };
}

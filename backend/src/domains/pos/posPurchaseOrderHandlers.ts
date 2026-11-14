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
  updatePosPurchaseOrder,
  updatePosPurchaseOrderStatus,
  assertProcurementApprovalAuthority,
} from './posPurchaseOrderService';
import {
  recordPosGoodsReceipt,
  getPosGoodsReceipts,
  getPosGoodsReceiptById,
  postPosGoodsReceipt,
  updatePosGoodsReceiptDraft,
  cancelPosGoodsReceiptDraft,
  getPurchaseOrderReceivablePreview,
  getPurchaseTransactionReceivablePreview,
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
        includeInactive: isActive === undefined ? true : !isActive,
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
        contact_name: contact_person,
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
        contact_name: contact_person,
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
        include_archived: req.query?.include_archived === 'true' || req.query?.include_archived === '1',
        page: req.query?.page ? Number(req.query.page) : undefined,
        limit: req.query?.limit ? Number(req.query.limit) : undefined,
      };

      const rows = await getPosPurchaseOrders(deps.pool, propertyId, filter);
      return res.status(200).json({
        status: 'OK',
        data: {
          orders: rows,
          total: rows.length,
          page: filter.page || 1,
          limit: filter.limit || rows.length || 50,
        },
        orders: rows,
        pagination: {
          total: rows.length,
          page: 1,
          limit: rows.length,
          total_pages: 1,
        },
      });
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
        destination_location_id,
        tax_amount,
        notes,
        submit_for_approval,
        initial_status,
        created_by,
        actor_name_snapshot,
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

      const authUser = (req as any).user;
      const resolvedCreatedBy = Number(authUser?.id || created_by) || null;
      const resolvedActorName = authUser?.full_name || authUser?.username || actor_name_snapshot || null;

      const created = await createPosPurchaseOrder(deps.pool, {
        property_id: propertyId,
        supplier_id: Number(supplier_id),
        order_date,
        expected_date,
        destination_location_id: destination_location_id ? Number(destination_location_id) : null,
        tax_amount: tax_amount !== undefined ? Number(tax_amount) : 0,
        notes,
        submit_for_approval: Boolean(submit_for_approval),
        initial_status,
        created_by: resolvedCreatedBy,
        actor_name_snapshot: resolvedActorName,
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

export function createPosPurchaseOrderUpdateHandler(deps: PosPurchaseOrderDeps) {
  return async function handlePosPurchaseOrderUpdate(req: Request, res: Response) {
    try {
      const poId = Number(req.params.id);
      const {
        property_id,
        supplier_id,
        order_date,
        expected_date,
        destination_location_id,
        tax_amount,
        notes,
        submit_for_approval,
        updated_by,
        actor_name_snapshot,
        items,
      } = req.body || {};

      const propertyId = Number(property_id || req.query?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib diisi dengan benar',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const authUser = (req as any).user;
      const resolvedUpdatedBy = Number(authUser?.id || updated_by) || null;
      const resolvedActorName = authUser?.full_name || authUser?.username || actor_name_snapshot || null;

      const updated = await updatePosPurchaseOrder(deps.pool, propertyId, poId, {
        supplier_id: supplier_id !== undefined ? Number(supplier_id) : undefined,
        order_date,
        expected_date,
        destination_location_id: destination_location_id !== undefined ? (destination_location_id ? Number(destination_location_id) : null) : undefined,
        tax_amount: tax_amount !== undefined ? Number(tax_amount) : undefined,
        notes,
        submit_for_approval,
        actor_user_id: resolvedUpdatedBy,
        actor_name_snapshot: resolvedActorName,
        items,
      });

      return res.status(200).json({ status: 'OK', data: updated });
    } catch (err: any) {
      const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(sc).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        code_detail: err?.code,
        message: err?.message || 'Gagal memperbarui purchase order',
      });
    }
  };
}

export function createPosPurchaseOrderStatusHandler(deps: PosPurchaseOrderDeps) {
  return async function handlePosPurchaseOrderStatus(req: Request, res: Response) {
    try {
      const poId = Number(req.params.id);
      const { property_id, status, action, updated_by, reason, rejection_reason, archive_reason, actor_name_snapshot } = req.body || {};
      const propertyId = Number(property_id || req.query?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib diisi dengan benar',
        });
      }

      const targetStatus = String(status || action || '').trim().toUpperCase();
      const allowedStatuses = new Set([
        'DRAFT',
        'PENDING_APPROVAL',
        'SUBMIT',
        'APPROVE',
        'APPROVED',
        'ORDERED',
        'REJECT',
        'REJECTED',
        'CANCELLED',
        'CANCEL',
        'ARCHIVE',
        'UNARCHIVE',
      ]);
      if (!targetStatus || !allowedStatuses.has(targetStatus)) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'INVALID_STATUS',
          message: 'status pembaruan PO tidak valid',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const authUser = (req as any).user;
      if (['APPROVE', 'APPROVED', 'ORDERED', 'REJECT', 'REJECTED'].includes(targetStatus)) {
        await assertProcurementApprovalAuthority(deps.pool, propertyId, authUser);
      }

      const resolvedUpdatedBy = Number(authUser?.id || updated_by) || null;
      const resolvedActorName = authUser?.full_name || authUser?.username || actor_name_snapshot || null;

      const updated = await updatePosPurchaseOrderStatus(
        deps.pool,
        propertyId,
        poId,
        targetStatus as any,
        resolvedUpdatedBy,
        {
          rejectionReason: reason || rejection_reason || null,
          archiveReason: reason || archive_reason || null,
          actorNameSnapshot: resolvedActorName,
        }
      );
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
        transaction_id: req.query?.transaction_id ? Number(req.query.transaction_id) : undefined,
        supplier_id: req.query?.supplier_id ? Number(req.query.supplier_id) : undefined,
        location_id: req.query?.location_id ? Number(req.query.location_id) : undefined,
        status: req.query?.status ? String(req.query.status) : undefined,
        start_date: req.query?.start_date ? String(req.query.start_date) : undefined,
        end_date: req.query?.end_date ? String(req.query.end_date) : undefined,
        search: req.query?.search ? String(req.query.search) : undefined,
        page: req.query?.page ? Number(req.query.page) : undefined,
        limit: req.query?.limit ? Number(req.query.limit) : undefined,
      };

      const result = await getPosGoodsReceipts(deps.pool, propertyId, filter);
      return res.status(200).json({
        status: 'OK',
        data: result,
        receipts: result.receipts,
        pagination: {
          total: result.total,
          page: result.page,
          limit: result.limit,
          total_pages: Math.ceil(result.total / Math.max(1, result.limit)),
        },
      });
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
        transaction_id,
        supplier_id,
        location_id,
        receipt_date,
        invoice_no,
        received_by,
        posted_by,
        notes,
        idempotency_key,
        operation_key,
        payload_fingerprint,
        status,
        is_draft,
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
        transaction_id: transaction_id ? Number(transaction_id) : null,
        supplier_id: supplier_id ? Number(supplier_id) : null,
        location_id: Number(location_id),
        receipt_date,
        invoice_no,
        received_by,
        posted_by,
        notes,
        idempotency_key,
        operation_key,
        payload_fingerprint,
        status,
        is_draft,
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

export function createPosGoodsReceiptPostHandler(deps: PosPurchaseOrderDeps) {
  return async function handlePosGoodsReceiptPost(req: Request, res: Response) {
    try {
      const grnId = Number(req.params.id);
      const { property_id, posted_by } = req.body || {};

      const propertyId = Number(property_id || req.query?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib berupa bilangan bulat positif',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const posted = await postPosGoodsReceipt(deps.pool, propertyId, grnId, posted_by);
      return res.status(200).json({ status: 'OK', data: posted });
    } catch (err: any) {
      const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(sc).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal memposting penerimaan barang',
      });
    }
  };
}

export function createPosGoodsReceiptDraftUpdateHandler(deps: PosPurchaseOrderDeps) {
  return async function handlePosGoodsReceiptDraftUpdate(req: Request, res: Response) {
    try {
      const grnId = Number(req.params.id);
      const { property_id, location_id, receipt_date, invoice_no, received_by, notes, items } = req.body || {};

      const propertyId = Number(property_id || req.query?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib berupa bilangan bulat positif',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const updated = await updatePosGoodsReceiptDraft(deps.pool, propertyId, grnId, {
        location_id,
        receipt_date,
        invoice_no,
        received_by,
        notes,
        items,
      });

      return res.status(200).json({ status: 'OK', data: updated });
    } catch (err: any) {
      const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(sc).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal memperbarui draft penerimaan barang',
      });
    }
  };
}

export function createPosGoodsReceiptCancelHandler(deps: PosPurchaseOrderDeps) {
  return async function handlePosGoodsReceiptCancel(req: Request, res: Response) {
    try {
      const grnId = Number(req.params.id);
      const { property_id, reason } = req.body || {};

      const propertyId = Number(property_id || req.query?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib berupa bilangan bulat positif',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const cancelled = await cancelPosGoodsReceiptDraft(deps.pool, propertyId, grnId, reason);
      return res.status(200).json({ status: 'OK', data: cancelled });
    } catch (err: any) {
      const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(sc).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal membatalkan draft penerimaan barang',
      });
    }
  };
}

export function createPosPurchaseOrderReceivablePreviewHandler(deps: PosPurchaseOrderDeps) {
  return async function handlePosPurchaseOrderReceivablePreview(req: Request, res: Response) {
    try {
      const poId = Number(req.params.poId);
      const propertyId = Number(req.query?.property_id || req.body?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib berupa bilangan bulat positif',
        });
      }
      if (!Number.isInteger(poId) || poId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'poId wajib berupa bilangan bulat positif',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const preview = await getPurchaseOrderReceivablePreview(deps.pool, propertyId, poId);
      return res.status(200).json({ status: 'OK', data: preview });
    } catch (err: any) {
      const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(sc).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal memuat preview penerimaan dari Purchase Order',
      });
    }
  };
}

export function createPosPurchaseTransactionReceivablePreviewHandler(deps: PosPurchaseOrderDeps) {
  return async function handlePosPurchaseTransactionReceivablePreview(req: Request, res: Response) {
    try {
      const transactionId = Number(req.params.transactionId);
      const propertyId = Number(req.query?.property_id || req.body?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib berupa bilangan bulat positif',
        });
      }
      if (!Number.isInteger(transactionId) || transactionId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'transactionId wajib berupa bilangan bulat positif',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const preview = await getPurchaseTransactionReceivablePreview(deps.pool, propertyId, transactionId);
      return res.status(200).json({ status: 'OK', data: preview });
    } catch (err: any) {
      const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(sc).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal memuat preview penerimaan dari transaksi pembelian',
      });
    }
  };
}


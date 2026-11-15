/**
 * posOrderDetailHandler.ts
 *
 * GET /api/pos/orders/:id/detail
 *
 * Mengembalikan detail order POS termasuk item, snapshot pricing, dan
 * metadata idempotency untuk keperluan edit (POS-EDIT-1).
 *
 * Dapat digunakan untuk order OPEN, PAID, dan VOIDED dengan property
 * scope yang benar. Tidak memodifikasi data apa pun.
 *
 * Dependency: connect/release (PoolClient), assertPropertyScope.
 * Tidak membuat pool, tidak membaca dotenv, tidak mengimpor index.ts.
 */

import type { Pool, PoolClient } from 'pg';
import type { Request, Response } from 'express';

// ── Dependency interface ─────────────────────────────────────────────────────

export interface PosOrderDetailDeps {
  pool: Pool;
  connect: () => Promise<PoolClient>;
  release: (client: PoolClient, discard?: boolean) => void;
  assertPropertyScope: (req: Request, propertyId: number) => Promise<void>;
}

// ── Factory ─────────────────────────────���────────────────────────────────────

export function createPosOrderDetailHandler(deps: PosOrderDetailDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    // ── 1. Validasi parameter ──────────────────────────────────────────────
    const orderIdRaw = req.params.id;
    if (orderIdRaw === undefined || String(orderIdRaw).trim() === '') {
      res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'order id is required' });
      return;
    }
    if (!/^\d+$/.test(String(orderIdRaw))) {
      res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'Invalid order id' });
      return;
    }
    const orderId = Number(orderIdRaw);
    if (!Number.isInteger(orderId) || orderId <= 0 || orderId > 2147483647) {
      res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'Invalid order id' });
      return;
    }

    const { property_id: propertyIdRaw } = req.query;
    if (propertyIdRaw === undefined || String(propertyIdRaw).trim() === '') {
      res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id query param is required' });
      return;
    }
    const propertyId = Number(propertyIdRaw);
    if (!Number.isInteger(propertyId) || propertyId <= 0 || propertyId > 2147483647) {
      res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
      return;
    }

    // Property scope guard SEBELUM transaksi DB
    try {
      await deps.assertPropertyScope(req, propertyId);
    } catch (e: any) {
      res.status(e?.statusCode ?? 403).json({
        status: 'ERROR',
        code: e?.code ?? 'SCOPE_DENIED',
        message: e?.message ?? 'property scope denied',
      });
      return;
    }

    const client = await deps.connect();
    let txnActive = false;
    try {
      await client.query('BEGIN');
      txnActive = true;

      // ── 2. Lock & baca order (baca + verifikasi property) ───────────────
      const orderRes = await client.query(
        `SELECT id, property_id, reservation_id, order_number, table_number,
                guest_name, guest_phone, notes, status, total_amount,
                discount_type, discount_value, discount_reason, discount_amount,
                service_charge_percent_snapshot, tax_percent_snapshot,
                service_charge_enabled_snapshot, tax_enabled_snapshot,
                service_amount, tax_amount,
                idempotency_key, request_fingerprint,
                version, created_at, updated_at
         FROM pos_orders
         WHERE id = $1
         FOR UPDATE`,
        [orderId]
      );
      const orderRow = orderRes.rows[0];
      if ((orderRes.rowCount ?? 0) === 0 || !orderRow) {
        await client.query('ROLLBACK');
        txnActive = false;
        res.status(404).json({ status: 'ERROR', code: 'ORDER_NOT_FOUND', message: `POS order ${orderId} not found` });
        return;
      }

      if (Number(orderRow.property_id) !== propertyId) {
        await client.query('ROLLBACK');
        txnActive = false;
        res.status(403).json({
          status: 'ERROR',
          code: 'CROSS_PROPERTY_ORDER',
          message: 'POS order bukan milik properti ini',
        });
        return;
      }

      // ── 3. Baca items order ──────────────────────────────────────────────
      const itemsRes = await client.query(
        `SELECT oi.id, oi.menu_item_id, oi.quantity, oi.unit_price,
                oi.discount_type, oi.discount_value, oi.discount_amount,
                oi.notes, oi.item_name_snapshot, oi.item_code_snapshot,
                oi.created_at AS item_created_at,
                mi.is_active AS menu_item_is_active,
                mi.name AS menu_item_name
         FROM pos_order_items oi
         LEFT JOIN pos_menu_items mi ON mi.id = oi.menu_item_id AND mi.property_id = $2
         WHERE oi.order_id = $1
         ORDER BY oi.id ASC`,
        [orderId, propertyId]
      );

      await client.query('COMMIT');
      txnActive = false;

      // ── 4. Susun response ────────────────────────────────────────────────
      res.json({
        status: 'OK',
        data: {
          order: {
            id: Number(orderRow.id),
            order_number: orderRow.order_number,
            property_id: propertyId,
            reservation_id: orderRow.reservation_id == null ? null : Number(orderRow.reservation_id),
            table_number: orderRow.table_number,
            guest_name: orderRow.guest_name,
            guest_phone: orderRow.guest_phone,
            notes: orderRow.notes,
            status: String(orderRow.status),
            total_amount: Number(orderRow.total_amount),
            discount_type: orderRow.discount_type,
            discount_value: orderRow.discount_value == null ? null : Number(orderRow.discount_value),
            discount_reason: orderRow.discount_reason,
            discount_amount: orderRow.discount_amount == null ? null : Number(orderRow.discount_amount),
            service_charge_percent_snapshot:
              orderRow.service_charge_percent_snapshot == null ? null : Number(orderRow.service_charge_percent_snapshot),
            tax_percent_snapshot:
              orderRow.tax_percent_snapshot == null ? null : Number(orderRow.tax_percent_snapshot),
            service_charge_enabled_snapshot: orderRow.service_charge_enabled_snapshot === true,
            tax_enabled_snapshot: orderRow.tax_enabled_snapshot === true,
            service_amount: orderRow.service_amount == null ? null : Number(orderRow.service_amount),
            tax_amount: orderRow.tax_amount == null ? null : Number(orderRow.tax_amount),
            version: orderRow.version == null ? null : Number(orderRow.version),
            idempotency_key: orderRow.idempotency_key,
            created_at: orderRow.created_at,
            updated_at: orderRow.updated_at,
          },
          items: itemsRes.rows.map((r: any) => ({
            id: Number(r.id),
            menu_item_id: r.menu_item_id == null ? null : Number(r.menu_item_id),
            quantity: Number(r.quantity),
            unit_price: Number(r.unit_price),
            discount_type: r.discount_type,
            discount_value: r.discount_value == null ? null : Number(r.discount_value),
            discount_amount: r.discount_amount == null ? null : Number(r.discount_amount),
            notes: r.notes,
            item_name_snapshot: r.item_name_snapshot,
            item_code_snapshot: r.item_code_snapshot,
            menu_item_is_active: r.menu_item_is_active === true || r.menu_item_is_active === 'true',
            menu_item_name: r.menu_item_name,
          })),
        },
      });
    } catch (err: any) {
      if (txnActive) {
        try { await client.query('ROLLBACK'); } catch (_) { /* sudah terminated */ }
      }
      res.status(500).json({ status: 'ERROR', code: 'INTERNAL_ERROR', message: err.message });
    } finally {
      deps.release(client);
    }
  };
}

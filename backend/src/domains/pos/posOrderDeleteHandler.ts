/**
 * posOrderDeleteHandler.ts
 *
 * DELETE /api/pos/orders/:id
 *
 * Menghapus/membatalkan order POS dari Riwayat Order secara atomik:
 * 1. Mengembalikan stok produk/bahan baku yang telah dipotong (restoreStockForPosOrderVoid).
 * 2. Membatalkan & menyembunyikan transaksi penjualan POS terkait di tabel transactions (deleted_at + VOIDED).
 * 3. Membatalkan tagihan kamar di folio_entries (bila BILLED_TO_ROOM) & merekalkulasi saldo reservasi.
 * 4. Menandai pos_orders sebagai VOIDED sehingga hilang dari daftar Riwayat Order & metrik penjualan POS.
 * 5. Mencatat jejak audit di audit_logs.
 */

import type { Pool, PoolClient } from 'pg';
import type { Request, Response } from 'express';
import { restoreStockForPosOrderVoid } from './stockInventoryService';
import { recalculateReservationFinancials } from '../stayCharges/stayChargesService';

export interface PosOrderDeleteDeps {
  pool: Pool;
  connect: () => Promise<PoolClient>;
  release: (client: PoolClient, discard?: boolean) => void;
  assertPropertyScope: (req: Request, propertyId: number) => Promise<void>;
}

const hasRows = (result: { rowCount?: number | null } | null | undefined): boolean =>
  Number(result?.rowCount ?? 0) > 0;

export function createPosOrderDeleteHandler(deps: PosOrderDeleteDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const orderIdRaw = req.params.id;
    if (orderIdRaw === undefined || orderIdRaw === null || String(orderIdRaw).trim() === '') {
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

    const propertyIdRaw = req.query?.property_id ?? req.body?.property_id;
    if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
      res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
      return;
    }
    const propertyId = Number(propertyIdRaw);
    if (!Number.isInteger(propertyId) || propertyId <= 0 || propertyId > 2147483647) {
      res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
      return;
    }

    try {
      await deps.assertPropertyScope(req, propertyId);
    } catch (scopeErr: any) {
      const sc = scopeErr?.statusCode ?? 403;
      res.status(sc).json({
        status: 'ERROR',
        code: scopeErr?.code || 'PROPERTY_SCOPE_REQUIRED',
        message: scopeErr?.message || 'Tidak memiliki akses ke properti ini',
      });
      return;
    }

    let client: PoolClient | null = null;
    let txnActive = false;

    try {
      client = await deps.connect();
      await client.query('BEGIN');
      txnActive = true;

      const orderRes = await client.query(
        `SELECT *
           FROM pos_orders
          WHERE id = $1
          FOR UPDATE`,
        [orderId]
      );

      if (!hasRows(orderRes)) {
        await client.query('ROLLBACK');
        txnActive = false;
        res.status(404).json({ status: 'ERROR', code: 'ORDER_NOT_FOUND', message: 'POS order tidak ditemukan' });
        return;
      }

      const orderRow = orderRes.rows[0];
      const orderPropertyId = Number(orderRow.property_id);

      if (orderPropertyId !== propertyId) {
        await client.query('ROLLBACK');
        txnActive = false;
        res.status(403).json({
          status: 'ERROR',
          code: 'CROSS_PROPERTY_ORDER',
          message: 'POS order bukan milik properti ini',
        });
        return;
      }

      const currentStatus = String(orderRow.status || '').toUpperCase();
      const actorName = (req as any).user?.full_name || (req as any).user?.username || 'Staff POS';
      const actorUserId = (req as any).user?.id ? String((req as any).user.id) : null;

      if (currentStatus === 'VOIDED') {
        await client.query('COMMIT');
        txnActive = false;
        res.status(200).json({
          status: 'SUCCESS',
          data: orderRow,
          replayed: true,
          stock_restored: [],
        });
        return;
      }

      // 1. Kembalikan stok persediaan bila sudah pernah dipotong saat pembayaran POS
      const stockRestore = await restoreStockForPosOrderVoid({
        client,
        propertyId,
        orderId,
        actorUserId,
        actorName,
      });

      // 2. Bila order pernah ditagihkan ke kamar (folio_entries), batalkan folio & rekalkulasi reservasi
      const folioRes = await client.query(
        `SELECT id, reservation_id
           FROM folio_entries
          WHERE property_id = $1
            AND source_type = 'POS_ORDER'
            AND source_id = $2
            AND is_voided = FALSE
          FOR UPDATE`,
        [propertyId, String(orderId)]
      );

      const affectedReservationIds = new Set<number>();
      for (const fRow of folioRes.rows) {
        const folioId = Number(fRow.id);
        if (fRow.reservation_id) {
          affectedReservationIds.add(Number(fRow.reservation_id));
        }
        await client.query(
          `UPDATE folio_entries
              SET is_voided = TRUE,
                  voided_at = NOW(),
                  voided_by = $1,
                  void_reason = 'POS Order dihapus dari Riwayat Order',
                  status = 'VOIDED'
            WHERE id = $2 AND property_id = $3`,
          [actorName, folioId, propertyId]
        );
        await client.query(
          `UPDATE transactions
              SET transaction_status = 'VOIDED',
                  deleted_at = COALESCE(deleted_at, NOW()),
                  deleted_by_user_id = COALESCE(deleted_by_user_id, $1),
                  deleted_by_name_snapshot = COALESCE(deleted_by_name_snapshot, $2),
                  delete_reason = COALESCE(delete_reason, 'POS Order dihapus dari Riwayat Order'),
                  updated_at = NOW()
            WHERE property_id = $3
              AND source_type = 'FOLIO'
              AND source_id = $4`,
          [actorUserId, actorName, propertyId, String(folioId)]
        );
      }

      for (const resId of affectedReservationIds) {
        if (Number.isInteger(resId) && resId > 0) {
          await recalculateReservationFinancials(client, resId, propertyId);
        }
      }

      // 3. Tandai transaksi penjualan POS terkait di tabel transactions sebagai VOIDED + deleted_at
      await client.query(
        `UPDATE transactions
            SET transaction_status = 'VOIDED',
                deleted_at = COALESCE(deleted_at, NOW()),
                deleted_by_user_id = COALESCE(deleted_by_user_id, $1),
                deleted_by_name_snapshot = COALESCE(deleted_by_name_snapshot, $2),
                delete_reason = COALESCE(delete_reason, 'POS Order dihapus dari Riwayat Order'),
                updated_at = NOW()
          WHERE property_id = $3
            AND source_type IN ('POS_ORDER', 'POS')
            AND source_id = $4`,
        [actorUserId, actorName, propertyId, String(orderId)]
      );

      // 3b. Bila order menggunakan kuota complimentary, kembalikan kuota dengan membatalkan usage di pos_complimentary_usages
      const compUsageRes = await client.query(
        `UPDATE pos_complimentary_usages
            SET status = 'CANCELLED'
          WHERE pos_order_id = $1
            AND property_id = $2
            AND status = 'ACTIVE'
          RETURNING id, employee_id, amount`,
        [orderId, propertyId]
      );

      // 4. Tandai pos_orders menjadi VOIDED
      const updateRes = await client.query(
        `UPDATE pos_orders
            SET status = 'VOIDED',
                updated_at = NOW()
          WHERE id = $1 AND property_id = $2
          RETURNING *`,
        [orderId, propertyId]
      );

      // 5. Catat jejak audit
      const auditPayload = JSON.stringify({
        property_id: propertyId,
        pos_order_id: orderId,
        order_number: orderRow.order_number,
        previous_status: currentStatus,
        new_status: 'VOIDED',
        stock_restored_count: stockRestore.items_restored.length,
        stock_restored_items: stockRestore.items_restored,
        complimentary_restored_count: compUsageRes.rowCount ?? 0,
        complimentary_restored_usages: compUsageRes.rows,
        actor_name: actorName,
        actor_user_id: actorUserId,
      });

      await client.query(
        `INSERT INTO audit_logs (
           module, action, entity, record_id, new_value,
           property_id, actor_user_id, correlation_id
         ) VALUES (
           'POS', 'DELETE_ORDER', 'pos_orders', $1, $2,
           $3, $4, $5
         )`,
        [String(orderId), auditPayload, propertyId, actorUserId, null]
      );

      await client.query('COMMIT');
      txnActive = false;

      res.status(200).json({
        status: 'SUCCESS',
        data: updateRes.rows[0],
        replayed: false,
        stock_restored: stockRestore.items_restored,
      });
    } catch (err: any) {
      if (client && txnActive) {
        try {
          await client.query('ROLLBACK');
        } catch {
          deps.release(client, true);
          client = null;
        }
      }
      console.error('POS order delete error:', err?.message || err);
      res.status(500).json({
        status: 'ERROR',
        code: 'INTERNAL_ERROR',
        message: err?.message || 'Gagal menghapus POS order',
      });
    } finally {
      if (client) {
        deps.release(client);
      }
    }
  };
}

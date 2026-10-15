/**
 * POS RECEIPT â€” Read-only endpoint untuk menampilkan receipt order POS final (PAID).
 *
 * Route: GET /api/pos/orders/:id/receipt?property_id=<id>
 *
 * Invariant:
 * - Read-only: TIDAK BEGIN/COMMIT, TIDAK INSERT/UPDATE/DELETE, TIDAK audit write.
 * - Item identity selalu dari immutable snapshot (item_name_snapshot, item_code_snapshot).
 * - TIDAK JOIN pos_menu_items untuk nama/kode receipt â€” receipt historical.
 * - Auth + property scope dijamin oleh middleware global + assertPropertyScope.
 */

import { Request, Response } from 'express';
import { Pool, PoolClient } from 'pg';
import { getPropertyBranding } from '../propertyBranding/propertyBrandingService';

// =============================================================================
// Dependencies (injected â€” zero import-time side effects)
// =============================================================================

export interface PosReceiptDeps {
  pool: Pool;
  connect: () => Promise<PoolClient>;
  release: (client: PoolClient) => void;
  assertPropertyScope: (req: Request, propertyId: number) => Promise<void>;
}

// =============================================================================
// Internal helpers
// =============================================================================

function integrityError(res: Response, detail: string): void {
  res.status(500).json({
    status: 'ERROR',
    code: 'RECEIPT_INTEGRITY_ERROR',
    message: `Receipt integrity error: ${detail}`,
  });
}

/**
 * Read-only: query tunggal, kembalikan row atau null.
 * Client di-release di finally.
 */
async function queryOne<T = Record<string, unknown>>(
  deps: PosReceiptDeps,
  sql: string,
  params: unknown[],
): Promise<T | null> {
  const client = await deps.connect();
  try {
    const r = await client.query(sql, params);
    return (r.rows[0] as T) ?? null;
  } finally {
    deps.release(client);
  }
}

/**
 * Read-only: query multiple rows.
 */
async function queryAll<T = Record<string, unknown>>(
  deps: PosReceiptDeps,
  sql: string,
  params: unknown[],
): Promise<T[]> {
  const client = await deps.connect();
  try {
    const r = await client.query(sql, params);
    return r.rows as T[];
  } finally {
    deps.release(client);
  }
}

// =============================================================================
// Handler factory
// =============================================================================

export function createPosReceiptHandler(deps: PosReceiptDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    // â”€â”€ 1. Validasi :id (order ID) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // â”€â”€ 2. Validasi property_id (query parameter) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const propertyIdRaw = req.query.property_id;
    if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
      res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
      return;
    }
    const propertyId = Number(propertyIdRaw);
    if (!Number.isInteger(propertyId) || propertyId <= 0) {
      res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
      return;
    }

    // â”€â”€ 3. assertPropertyScope SEBELUM membaca data scoped â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Cross-property tidak membocorkan existence order.
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

    // â”€â”€ 4. Query order (read-only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // pos_orders tidak memiliki created_by di schema;
    // hanya SELECT kolom yang memang ada.
    let order: Record<string, unknown> | null;
    try {
      order = await queryOne(
        deps,
        `SELECT id, property_id, reservation_id, order_number,
                table_number, guest_name, guest_phone,
                status, total_amount,
                notes,
                discount_type, discount_value, discount_reason, discount_amount,
                tax_enabled, tax_rate, tax_amount,
                service_charge_enabled, service_charge_rate, service_charge_amount,
                created_at, updated_at
         FROM pos_orders
         WHERE id = $1 AND property_id = $2`,
        [orderId, propertyId],
      );
    } catch {
      res.status(500).json({ status: 'ERROR', code: 'INTERNAL_ERROR', message: 'Database error' });
      return;
    }

    if (!order) {
      res.status(404).json({ status: 'ERROR', code: 'ORDER_NOT_FOUND', message: 'Order tidak ditemukan' });
      return;
    }

    // â”€â”€ 5. Hanya receipt untuk order final PAID â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const orderStatus = String(order.status ?? '').toUpperCase();
    if (orderStatus !== 'PAID') {
      res.status(409).json({
        status: 'CONFLICT',
        code: 'RECEIPT_NOT_AVAILABLE',
        message: `Receipt hanya tersedia untuk order PAID (status saat ini: ${orderStatus || 'UNKNOWN'})`,
      });
      return;
    }

    // â”€â”€ 6. Read items dari immutable snapshot (TANPA JOIN pos_menu_items) â”€
    // item_name_snapshot & item_code_snapshot adalah kolom immutable per row.
    let items: Record<string, unknown>[];
    try {
      items = await queryAll(
        deps,
        `SELECT menu_item_id,
                item_name_snapshot,
                item_code_snapshot,
                quantity,
                unit_price,
                notes,
                discount_type,
                discount_value,
                discount_amount
         FROM pos_order_items
         WHERE order_id = $1
         ORDER BY id`,
        [orderId],
      );
    } catch {
      res.status(500).json({ status: 'ERROR', code: 'INTERNAL_ERROR', message: 'Database error' });
      return;
    }

    // â”€â”€ 7. Query canonical settlement (status='SUCCESS') â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // pos_settlements.transaction_id adalah BIGINT â†’ pg mengembalikan string.
    let settlement: Record<string, unknown> | null;
    try {
      // Hitung jumlah settlement SUCCESS per order untuk fail-closed.
      const countRes = await queryOne<{ n: string }>(
        deps,
        `SELECT COUNT(*)::text AS n
         FROM pos_settlements
         WHERE property_id = $1 AND pos_order_id = $2 AND status = 'SUCCESS'`,
        [propertyId, orderId],
      );
      const settlementCount = Number(countRes?.n ?? '0');

      if (settlementCount === 0) {
        res.status(409).json({
          status: 'CONFLICT',
          code: 'RECEIPT_NOT_AVAILABLE',
          message: 'Tidak ada settlement SUCCESS untuk order ini',
        });
        return;
      }
      if (settlementCount > 1) {
        integrityError(res, `Lebih dari satu settlement SUCCESS untuk order ${orderId} (ditemukan ${settlementCount}). Invariant satu settlement per order dilanggar.`);
        return;
      }

      settlement = await queryOne(
        deps,
        `SELECT id, property_id, pos_order_id,
                transaction_id, amount,
                payment_method, status,
                cash_received, change_due, payment_reference,
                created_by, created_at,
                verified_by, verified_at
         FROM pos_settlements
         WHERE property_id = $1 AND pos_order_id = $2 AND status = 'SUCCESS'
         LIMIT 1`,
        [propertyId, orderId],
      );
    } catch {
      res.status(500).json({ status: 'ERROR', code: 'INTERNAL_ERROR', message: 'Database error' });
      return;
    }

    if (!settlement) {
      res.status(409).json({
        status: 'CONFLICT',
        code: 'RECEIPT_NOT_AVAILABLE',
        message: 'Settlement tidak ditemukan untuk order ini',
      });
      return;
    }

    // â”€â”€ 8. Query SALE transaction dari settlement.transaction_id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // settlement.transaction_id adalah BIGINT â†’ pg mengembalikan string.
    const settlementTxId = String(settlement.transaction_id);

    let sale: Record<string, unknown> | null;
    try {
      sale = await queryOne(
        deps,
        `SELECT id, property_id, transaction_no,
                transaction_type, source_type, source_id,
                payment_status, payment_method,
                amount, discount_amount, net_amount,
                created_at
         FROM transactions
         WHERE id = $1 AND property_id = $2 AND deleted_at IS NULL
         LIMIT 1`,
        [settlementTxId, propertyId],
      );
    } catch {
      res.status(500).json({ status: 'ERROR', code: 'INTERNAL_ERROR', message: 'Database error' });
      return;
    }

    if (!sale) {
      integrityError(res, `SALE transaction ${settlementTxId} tidak ditemukan atau terhapus untuk property ${propertyId}`);
      return;
    }

    // â”€â”€ 9. Integrity checks: settlement â†” SALE transaction â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const saleTxType = String(sale.transaction_type ?? '').toUpperCase();
    const saleSourceType = String(sale.source_type ?? '').toUpperCase();
    const saleSourceId = String(sale.source_id ?? '');
    const salePaymentStatus = String(sale.payment_status ?? '').toUpperCase();
    const salePaymentMethod = String(sale.payment_method ?? '').toUpperCase();
    const settlementPaymentMethod = String(settlement.payment_method ?? '').toUpperCase();

    // transaction_type harus SALE
    if (saleTxType !== 'SALE') {
      integrityError(res, `Transaction ${settlementTxId} transaction_type='${saleTxType}', expected 'SALE'`);
      return;
    }
    // source_type harus POS_ORDER atau POS
    if (saleSourceType !== 'POS_ORDER' && saleSourceType !== 'POS') {
      integrityError(res, `Transaction ${settlementTxId} source_type='${saleSourceType}', expected 'POS_ORDER' or 'POS'`);
      return;
    }
    // source_id harus = String(order.id)
    if (saleSourceId !== String(orderId)) {
      integrityError(res, `Transaction ${settlementTxId} source_id='${saleSourceId}', expected '${orderId}'`);
      return;
    }
    // payment_status harus PAID
    if (salePaymentStatus !== 'PAID') {
      integrityError(res, `Transaction ${settlementTxId} payment_status='${salePaymentStatus}', expected 'PAID'`);
      return;
    }
    // payment_method settlement dan SALE harus konsisten
    if (settlementPaymentMethod !== salePaymentMethod) {
      integrityError(res, `Payment method mismatch: settlement='${settlementPaymentMethod}' vs transaction='${salePaymentMethod}'`);
      return;
    }
    // â”€â”€ Amount integrity: triple authoritative check (whole rupiah) â”€â”€â”€â”€â”€â”€â”€
    // Ketiga sumber harus EXACT match:
    //   pos_orders.total_amount === pos_settlements.amount === transactions.net_amount
    // POS memakai whole rupiah: validasi Number.isSafeInteger + >= 0.
    const orderTotalNum = Number(String(order.total_amount ?? '0'));
    const settlementAmountNum = Number(String(settlement.amount ?? '0'));
    const saleNetAmountNum = Number(String(sale.net_amount ?? '0'));

    for (const [label, val] of [
      ['order.total_amount', orderTotalNum],
      ['settlement.amount', settlementAmountNum],
      ['transaction.net_amount', saleNetAmountNum],
    ] as const) {
      if (!Number.isFinite(val) || !Number.isSafeInteger(val) || val <= 0) {
        integrityError(res, `${label} invalid: ${val} (harus finite safe-integer positif)`);
        return;
      }
    }
    if (orderTotalNum !== settlementAmountNum || orderTotalNum !== saleNetAmountNum) {
      integrityError(res,
        `Amount mismatch: order.total_amount=${orderTotalNum} vs settlement.amount=${settlementAmountNum} vs transaction.net_amount=${saleNetAmountNum}`);
      return;
    }

    // â”€â”€ 10. Property + Branding (read-only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let propertyRow: Record<string, unknown> | null;
    let branding: Record<string, unknown> | null = null;
    try {
      propertyRow = await queryOne(
        deps,
        `SELECT id, name, property_code, address, phone, timezone, currency
         FROM properties WHERE id = $1`,
        [propertyId],
      );
    } catch {
      res.status(500).json({ status: 'ERROR', code: 'INTERNAL_ERROR', message: 'Database error' });
      return;
    }

    if (!propertyRow) {
      integrityError(res, `Property row ${propertyId} tidak ditemukan meskipun scoped PAID order sudah ada. Keadaan referential/integrity tidak normal.`);
      return;
    }

    try {
      branding = (await getPropertyBranding(deps.pool, propertyId)) as unknown as Record<string, unknown>;
    } catch {
      // Jika getPropertyBranding gagal (mis. property_brandings table belum ada),
      // receipt tetap bisa dikembalikan tanpa branding (null).
      // Fail-open untuk optional display data.
      branding = null;
    }

    // â”€â”€ 11. Build response â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    res.status(200).json({
      status: 'SUCCESS',
      data: {
        property: {
          id: Number(propertyRow.id),
          name: String(propertyRow.name ?? ''),
          property_code: String(propertyRow.property_code ?? ''),
          address: String(propertyRow.address ?? '') || null,
          phone: String(propertyRow.phone ?? '') || null,
          timezone: String(propertyRow.timezone ?? ''),
          currency: String(propertyRow.currency ?? 'IDR'),
          branding: branding,
        },
        order: {
          id: Number(order.id),
          order_number: String(order.order_number ?? ''),
          property_id: Number(order.property_id),
          status: String(order.status ?? ''),
          guest_name: String(order.guest_name ?? '') || null,
          guest_phone: String(order.guest_phone ?? '') || null,
          table_number: String(order.table_number ?? '') || null,
          notes: String(order.notes ?? '') || null,
          total_amount: String(order.total_amount ?? '0'),
          discount_type: String(order.discount_type ?? '') || null,
          discount_value: order.discount_value !== null ? String(order.discount_value) : null,
          discount_reason: String(order.discount_reason ?? '') || null,
          discount_amount: String(order.discount_amount ?? '0'),
          tax_enabled: Boolean(order.tax_enabled ?? false),
          tax_rate: order.tax_rate !== null ? String(order.tax_rate) : '0',
          tax_amount: String(order.tax_amount ?? '0'),
          service_charge_enabled: Boolean(order.service_charge_enabled ?? false),
          service_charge_rate: order.service_charge_rate !== null ? String(order.service_charge_rate) : '0',
          service_charge_amount: String(order.service_charge_amount ?? '0'),
          created_at: order.created_at ? String(order.created_at) : null,
          updated_at: order.updated_at ? String(order.updated_at) : null,
        },
        items: items,
        settlement: {
          id: Number(settlement.id),
          amount: String(settlement.amount ?? '0'),
          payment_method: String(settlement.payment_method ?? ''),
          status: String(settlement.status ?? ''),
          cash_received: settlement.cash_received !== null ? String(settlement.cash_received) : null,
          change_due: settlement.change_due !== null ? String(settlement.change_due) : null,
          payment_reference: String(settlement.payment_reference ?? '') || null,
          created_by: String(settlement.created_by ?? '') || null,
          created_at: settlement.created_at ? String(settlement.created_at) : null,
          verified_by: String(settlement.verified_by ?? '') || null,
          verified_at: settlement.verified_at ? String(settlement.verified_at) : null,
        },
        sale: {
          // BIGINT â†’ string, jangan Number()
          id: String(sale.id),
          transaction_no: String(sale.transaction_no ?? ''),
          transaction_type: saleTxType,
          source_type: saleSourceType,
          source_id: saleSourceId,
          payment_status: salePaymentStatus,
          payment_method: salePaymentMethod,
          net_amount: String(sale.net_amount ?? '0'),
          created_at: sale.created_at ? String(sale.created_at) : null,
        },
      },
    });
  };
}

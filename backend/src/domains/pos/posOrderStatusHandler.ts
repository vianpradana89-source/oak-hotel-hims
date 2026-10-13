/**
 * posOrderStatusHandler.ts
 *
 * Extracted and reworked from index.ts PATCH /api/pos/orders/:id/status.
 *
 * PATCH /api/pos/orders/:id/status
 *
 * Kontrak:
 *   - Target status hanya 'VOIDED' (case-insensitive setelah toUpperCase).
 *   - status wajib string non-kosong di body; kosong/undefined → 400.
 *   - status ≠ 'VOIDED' → 400 UNSUPPORTED_TARGET.
 *   - assertPropertyScope SEBELUM transaksi DB.
 *   - Lock pos_orders FOR UPDATE dalam transaksi eksplisit.
 *   - Status asal hanya 'OPEN' (void baru) atau 'VOIDED' (replay idempoten).
 *   - Semua artefak finansial (transaksi POS terkait, settlement) → 409.
 *   - Tidak memanggil projection, tidak membuat reversal, tidak refund.
 *
 * Dependency minimal: pool/connect/release + assertPropertyScope.
 * Tidak membuat pool, tidak membaca dotenv, tidak mengimpor index.ts.
 */

import type { Pool, PoolClient } from 'pg';
import type { Request, Response } from 'express';

// ── Dependency interface ────────────────────────────────���────────────────────

export interface PosOrderStatusDeps {
  /** Pool untuk connect/release. */
  pool: Pool;

  /**
   * Connect a dedicated client for the transaction.
   * Production: pool.connect().
   * Tests: wrapped client (barrier, etc.).
   */
  connect: () => Promise<PoolClient>;

  /**
   * Release a dedicated client back to the pool.
   * Production: client.release().
   * Second arg (discard) → pool discards the broken connection.
   */
  release: (client: PoolClient, discard?: boolean) => void;

  /**
   * Property scope guard: user's token property must match requested property,
   * unless the user is a platform super admin.
   * Production: assertPropertyScope(req, propertyId) from index.ts.
   */
  assertPropertyScope: (req: Request, propertyId: number) => Promise<void>;
}

// ── Helper ───────────────────────────────────────────────────────────────────

const hasRows = (result: { rowCount?: number | null } | null | undefined): boolean =>
  Number(result?.rowCount ?? 0) > 0;

// ── Factory ─────────────────────────────────────────────────────────────────

export function createPosOrderStatusHandler(deps: PosOrderStatusDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    // ── 1. Validasi parameter ──────────────────────────────────────────────
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

    const { status: statusRaw, property_id: propertyIdRaw } = req.body ?? {};

    if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
      res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
      return;
    }
    const propertyId = Number(propertyIdRaw);
    if (!Number.isInteger(propertyId) || propertyId <= 0 || propertyId > 2147483647) {
      res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
      return;
    }

    // status wajib string non-kosong; target hanya VOIDED
    if (typeof statusRaw !== 'string' || statusRaw.trim() === '') {
      res.status(400).json({
        status: 'ERROR',
        code: 'INVALID_STATUS_TARGET',
        message: 'status wajib dikirim sebagai string non-kosong; target yang didukung: VOIDED'
      });
      return;
    }
    const targetStatus = statusRaw.trim().toUpperCase();
    if (targetStatus !== 'VOIDED') {
      res.status(400).json({
        status: 'ERROR',
        code: 'UNSUPPORTED_TARGET',
        message: `Hanya VOIDED yang didukung oleh endpoint ini (menerima ${JSON.stringify(targetStatus)})`
      });
      return;
    }

    // ── 2. assertPropertyScope SEBELUM transaksi DB ────────────────────────
    try {
      await deps.assertPropertyScope(req, propertyId);
    } catch (scopeErr: any) {
      const sc = scopeErr?.statusCode ?? 403;
      res.status(sc).json({
        status: 'ERROR',
        code: scopeErr?.code || 'PROPERTY_SCOPE_REQUIRED',
        message: scopeErr?.message || 'Tidak memiliki akses ke properti ini'
      });
      return;
    }

    // ── 3. Connect + BEGIN (transaksi eksplisit) ─────────────────────────
    let client: PoolClient | null = null;
    let txnActive = false;

    try {
      client = await deps.connect();
      await client.query('BEGIN');
      txnActive = true;

      // ── 4. Lock order FOR UPDATE ─────────────────────────────────────────
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
          message: 'POS order bukan milik properti ini'
        });
        return;
      }

      const currentStatus = String(orderRow.status || '').toUpperCase();

      // ── 5. Deteksi artefak finansial ────────────────────────────────────
      // Q1a: transaksi POS (source_type POS_ORDER/POS, source_id=String(orderId))
      //       semua status, semua deleted_at, termasuk reversal yang menunjuk
      //       transaksi original. Tidak ada filter yang menyembunyikan.
      // Q1b: reversal via reversal_of_transaction_id yang menunjuk transaksi
      //       POS original, meskipun source_type reversal berbeda.
      const q1a = await client.query(
        `SELECT 1 AS found
         FROM transactions
         WHERE property_id = $1
           AND source_type IN ('POS_ORDER', 'POS')
           AND source_id   = $2
         LIMIT 1`,
        [propertyId, String(orderId)]
      );

      const q1b = await client.query(
        `SELECT 1 AS found
         FROM transactions rev
         WHERE rev.property_id = $1
           AND rev.reversal_of_transaction_id IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM transactions orig
             WHERE orig.id = rev.reversal_of_transaction_id
               AND orig.property_id = $1
               AND orig.source_type IN ('POS_ORDER', 'POS')
               AND orig.source_id   = $2
           )
         LIMIT 1`,
        [propertyId, String(orderId)]
      );

      const q2 = await client.query(
        `SELECT 1 AS found
         FROM pos_settlements
         WHERE property_id  = $1
           AND pos_order_id = $2
         LIMIT 1`,
        [propertyId, orderId]
      );

      if (hasRows(q1a) || hasRows(q1b) || hasRows(q2)) {
        await client.query('ROLLBACK');
        txnActive = false;
        res.status(409).json({
          status: 'ERROR',
          code: 'POS_ORDER_FINANCIAL_ARTIFACTS_PRESENT',
          message: 'Order memiliki transaksi atau settlement terkait. Void hanya melalui mekanisme refund resmi.'
        });
        return;
      }

      // ── 6. Lifecycle: replay VOIDED bersih vs void OPEN ────────────────
      if (currentStatus === 'VOIDED') {
        // Replay: sudah VOIDED, tidak ada artefak → 200 idempoten, tanpa mutation
        await client.query('COMMIT');
        txnActive = false;
        res.status(200).json({
          status: 'SUCCESS',
          data: orderRow,
          replayed: true
        });
        return;
      }

      if (currentStatus !== 'OPEN') {
        await client.query('ROLLBACK');
        txnActive = false;
        res.status(409).json({
          status: 'ERROR',
          code: 'ORDER_NOT_OPEN',
          current_status: currentStatus,
          message: `Void hanya diizinkan untuk order OPEN atau replay VOIDED (status saat ini: ${currentStatus})`
        });
        return;
      }

      // ── 7. Void OPEN bersih: UPDATE + audit dalam transaksi yang sama ──
      const actorName = (req as any).user?.full_name || (req as any).user?.username || null;
      const actorUserId = (req as any).user?.id ? String((req as any).user.id) : null;

      const updateRes = await client.query(
        `UPDATE pos_orders
         SET status = 'VOIDED', updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [orderId]
      );

      if (!hasRows(updateRes)) {
        await client.query('ROLLBACK');
        txnActive = false;
        res.status(500).json({ status: 'ERROR', code: 'UPDATE_FAILED', message: 'UPDATE pos_orders gagal' });
        return;
      }

      // Audit void — satu row, actor dari req.user (token terautentikasi)
      const auditPayload = JSON.stringify({
        property_id: propertyId,
        pos_order_id: orderId,
        previous_status: 'OPEN',
        new_status: 'VOIDED',
        actor_name: actorName,
        actor_user_id: actorUserId
      });

      await client.query(
        `INSERT INTO audit_logs (
           module, action, entity, record_id, new_value,
           property_id, actor_user_id, correlation_id
         ) VALUES (
           'POS', 'VOID', 'pos_orders', $1, $2,
           $3, $4, $5
         )`,
        [String(orderId), auditPayload, propertyId, actorUserId, null]
      );

      await client.query('COMMIT');
      txnActive = false;

      res.status(200).json({
        status: 'SUCCESS',
        data: updateRes.rows[0],
        replayed: false
      });
      return;

    } catch (err: any) {
      console.error('[PosOrderStatusHandler] Error:', err?.message || err);
      res.status(500).json({ status: 'ERROR', message: err.message || 'Internal error' });
      return;
    } finally {
      let discardClient = false;

      // Rollback if transaction is still active
      if (txnActive && client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr: any) {
          console.error('[PosOrderStatusHandler] ROLLBACK failed, discarding client:', rollbackErr?.message || rollbackErr);
          discardClient = true;
        }
      }

      // Release client exactly once
      if (client) {
        try {
          deps.release(client, discardClient);
        } catch (releaseErr: any) {
          console.error('[PosOrderStatusHandler] release() failed:', releaseErr?.message || releaseErr);
        }
      }
    }
  };
}

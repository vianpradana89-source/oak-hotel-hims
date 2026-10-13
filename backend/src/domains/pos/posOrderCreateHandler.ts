/**
 * posOrderCreateHandler.ts
 *
 * Extracted from index.ts lines 6090–6381.
 *
 * POST /api/pos/orders
 *
 * Mechanical extraction: validation, fingerprint, replay FOR UPDATE,
 * replay-before-menu-validation, INSERT/ON CONFLICT, price snapshot,
 * responses, COMMIT/ROLLBACK, and release are preserved exactly as in
 * the original handler.
 *
 * The factory receives every external dependency explicitly so that tests
 * can substitute a disposable pool and no-op broadcast without importing
 * index.ts, dotenv, or starting a server.
 */

import crypto from 'crypto';
import type { Pool, PoolClient } from 'pg';
import type { Request, Response } from 'express';
import { computeRequestHash } from '../../utils/hash';

// ── Simple helper (no external dependency) ─────────────────────────────────

const hasRows = (result: { rowCount?: number | null } | null | undefined): boolean =>
  Number(result?.rowCount ?? 0) > 0;

// ── Dependency interface ────────────────────────────────────────────────────

/**
 * Explicit dependency bag for the POS order create handler factory.
 *
 * Every helper the handler needs is listed here so that:
 *   - index.ts passes its own production instances (pool, services, etc.)
 *   - tests pass a disposable pool and no-op broadcast
 *   - the module does NOT import index.ts, read dotenv, create a pool,
 *     or run schema initialization
 */
export interface PosOrderCreateDeps {
  /** The Pool used for pre-transaction checks and connection management. */
  pool: Pool;

  /**
   * Connect a dedicated client for the transaction.
   * In production: `pool.connect()`.
   * In tests: may return a wrapped client that signals after lock
   * acquisition so the test can hold execution deterministically.
   */
  connect: () => Promise<PoolClient>;

  /**
   * Release a dedicated client back to the pool.
   * In production: `client.release()`.
   */
  release: (client: PoolClient) => void;

  /**
   * Property scope guard: user's token property must match requested property,
   * unless the user is a platform super admin.
   * Production: assertPropertyScope(req, propertyId) from index.ts.
   */
  assertPropertyScope: (req: Request, propertyId: number) => Promise<void>;

  /**
   * Broadcast a realtime event (SSE / pg-notify fan-out).
   * No-op in tests. Never blocks the caller.
   */
  broadcastEvent: (eventType: string, payload: any, propertyId?: number) => void;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Creates the Express handler for POST /api/pos/orders.
 *
 * The handler body is a mechanical copy of the original index.ts:6090–6381.
 * All external dependencies are injected through `deps`, so this module
 * has zero import-time side effects (no dotenv, no pool creation, no
 * schema initialization, no server startup).
 */
export function createPosOrderCreateHandler(deps: PosOrderCreateDeps) {
  return async (req: Request, res: Response) => {
    const { property_id: propertyIdRaw, reservation_id, table_number, guest_name, items } = req.body;

    if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
    }
    const propertyId = Number(propertyIdRaw);
    if (!Number.isInteger(propertyId) || propertyId <= 0) {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'items must not be empty' });
    }

    // Validasi quantity: setiap item wajib quantity integer > 0.
    for (let i = 0; i < items.length; i++) {
      const qty = Number(items[i].quantity ?? 1);
      if (!Number.isInteger(qty) || qty <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: `items[${i}].quantity must be a positive integer`
        });
      }
    }

    // Property scope: user token properti harus cocok (kecuali super admin platform).
    try {
      await deps.assertPropertyScope(req, propertyId);
    } catch (scopeErr: any) {
      const sc = scopeErr?.statusCode ?? 403;
      return res.status(sc).json({
        status: 'ERROR',
        code: scopeErr?.code || 'PROPERTY_SCOPE_REQUIRED',
        message: scopeErr?.message || 'Tidak memiliki akses ke properti ini'
      });
    }

    // ─── Idempotency key (opsional; backward compat: tanpa key = normal insert) ───
    // Key diambil dari header Idempotency-Key. Validasi: string 1–150 char.
    const rawKey = String(
      req.headers['idempotency-key'] || req.headers['Idempotency-Key'] || ''
    ).trim();
    let idempotencyKey: string | null = null;
    if (rawKey.length > 0) {
      if (rawKey.length > 150 || /\s/.test(rawKey)) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'Idempotency-Key must be 1–150 non-whitespace characters'
        });
      }
      idempotencyKey = rawKey;
    }

    // Fingerprint: hash payload bisnis tervalidasi/ternormalisasi.
    // Mengandung property, reservation, items (menu_item_id + quantity + notes),
    // meja, nama — TIDAK memakai harga master terkini (harga di-snapshot di DB).
    const fingerprintPayload = JSON.stringify({
      property_id: propertyId,
      reservation_id: reservation_id ?? null,
      table_number: table_number ?? 'Walk In',
      guest_name: guest_name ?? 'Guest',
      items: items.map((it: any) => ({
        menu_item_id: Number(it.menu_item_id),
        quantity: Number(it.quantity ?? 1),
        notes: it.notes ?? null
      }))
    });
    const fingerprint = computeRequestHash('POST', '/api/pos/orders', fingerprintPayload);

    const client = await deps.connect();
    try {
      await client.query('BEGIN');

      // Validate property exists
      const propCheck = await client.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
      if ((propCheck.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ status: 'ERROR', code: 'PROPERTY_NOT_FOUND', message: `property ${propertyId} not found` });
      }

      // Validate reservation linkage: reservation must belong to same property
      if (reservation_id != null) {
        const resCheck = await client.query(
          'SELECT b.property_id FROM reservations r JOIN bookings b ON b.id = r.booking_id WHERE r.id = $1',
          [reservation_id]
        );
        if ((resCheck.rowCount ?? 0) === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'ERROR', code: 'RESERVATION_NOT_FOUND', message: `reservation ${reservation_id} not found` });
        }
        if (Number(resCheck.rows[0].property_id) !== propertyId) {
          await client.query('ROLLBACK');
          return res.status(403).json({ status: 'ERROR', code: 'CROSS_PROPERTY_RESERVATION', message: 'reservation belongs to a different property' });
        }
      }

      // ─── Step 1: Initial replay check (BEFORE any booking/reservation lock) ───
      // Jika idempotency_key ada, cek order existing DULU dengan FOR UPDATE.
      // Dilakukan SEBELUM validasi produk aktif agar replay order committed tidak
      // bergantung pada status is_active produk (produk bisa nonaktif kemudian).
      // Fingerprint cocok → 200 replay; fingerprint beda → 409.
      // Jalur ini selesai SEBELUM mengambil lock booking/reservasi.
      if (idempotencyKey) {
        const existingCheck = await client.query(
          `SELECT po.id, po.property_id, po.reservation_id, po.order_number,
                  po.table_number, po.guest_name, po.status, po.total_amount,
                  po.created_at, po.updated_at,
                  po.request_fingerprint AS stored_fingerprint
           FROM pos_orders po
           WHERE po.property_id = $1 AND po.idempotency_key = $2
           FOR UPDATE`,
          [propertyId, idempotencyKey]
        );
        if (hasRows(existingCheck)) {
          const existing = existingCheck.rows[0];
          // Fingerprint cocok → replay (kembalikan order + items tersimpan, TANPA recompute harga).
          if (existing.stored_fingerprint === fingerprint) {
            const existingItems = await client.query(
              `SELECT poi.*, pmi.name, pmi.item_code
               FROM pos_order_items poi
               LEFT JOIN pos_menu_items pmi ON pmi.id = poi.menu_item_id
               WHERE poi.order_id = $1`,
              [existing.id]
            );
            await client.query('COMMIT');
            res.status(200).json({
              status: 'REPLAY',
              code: 'IDEMPOTENT_REPLAY',
              data: { ...existing, items: existingItems.rows }
            });
            return;
          }
          // Fingerprint beda → 409: key sama tapi payload berbeda.
          await client.query('ROLLBACK');
          res.status(409).json({
            status: 'CONFLICT',
            code: 'IDEMPOTENCY_KEY_CONFLICT',
            message: 'Idempotency-Key sudah dipakai untuk payload berbeda'
          });
          return;
        }
        // Order belum ada untuk key ini → lanjut ke lock booking/reservasi.
      }

      // ─── Step 2: Lock booking + reservation (hanya jika reservation_id terisi) ───
      // Urutan lock: booking → reservation (sama dengan checkout handler).
      // Ini memastikan koordinasi dengan checkout tanpa deadlock:
      // kedua writer mengambil lock dalam urutan yang sama.
      let lockedBooking: any = null;
      let lockedReservation: any = null;
      let targetBookingId: string | null = null;

      if (reservation_id != null) {
        // Lookup booking_id untuk reservasi target.
        const bookingLookup = await client.query(
          `SELECT booking_id FROM reservations WHERE id = $1`,
          [reservation_id]
        );
        if (!hasRows(bookingLookup)) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'ERROR', code: 'RESERVATION_NOT_FOUND', message: `reservation ${reservation_id} not found` });
        }
        targetBookingId = String(bookingLookup.rows[0].booking_id);

        // Lock booking terlebih dahulu (BIGINT → string untuk menghindari presisi).
        const bookingLock = await client.query(
          `SELECT * FROM bookings WHERE id = $1::BIGINT FOR UPDATE`,
          [targetBookingId]
        );
        if (!hasRows(bookingLock)) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'ERROR', code: 'BOOKING_NOT_FOUND', message: 'booking not found' });
        }
        lockedBooking = bookingLock.rows[0];

        // Lock reservasi target.
        const reservationLock = await client.query(
          `SELECT * FROM reservations WHERE id = $1 FOR UPDATE`,
          [reservation_id]
        );
        if (!hasRows(reservationLock)) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'ERROR', code: 'RESERVATION_NOT_FOUND', message: `reservation ${reservation_id} not found` });
        }
        lockedReservation = reservationLock.rows[0];

        // ─── Step 3: Re-validate linkage AFTER lock ───
        // Jangan mengandalkan pembacaan sebelum lock sebagai validasi final.
        // Jika linkage berubah saat kita menunggu lock, tolak tanpa INSERT.
        if (String(lockedReservation.booking_id) !== targetBookingId) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            status: 'ERROR',
            code: 'RESERVATION_LINKAGE_CHANGED',
            message: 'Keterkaitan reservasi dengan booking telah berubah. Silakan coba lagi.'
          });
        }
        if (Number(lockedBooking.property_id) !== propertyId) {
          await client.query('ROLLBACK');
          return res.status(403).json({
            status: 'ERROR',
            code: 'CROSS_PROPERTY_RESERVATION',
            message: 'Reservasi ini terkait properti yang berbeda'
          });
        }

        // ─── Step 4: Recheck idempotency key (plain SELECT, TANPA FOR UPDATE) ───
        // Request lain mungkin sudah membuat order saat kita menunggu lock.
        // Pemeriksaan ini mendahului penolakan status untuk create baru.
        if (idempotencyKey) {
          const recheckResult = await client.query(
            `SELECT po.id, po.property_id, po.reservation_id, po.order_number,
                    po.table_number, po.guest_name, po.status, po.total_amount,
                    po.created_at, po.updated_at,
                    po.request_fingerprint AS stored_fingerprint
             FROM pos_orders po
             WHERE po.property_id = $1 AND po.idempotency_key = $2`,
            [propertyId, idempotencyKey]
          );
          if (hasRows(recheckResult)) {
            const recheck = recheckResult.rows[0];
            if (recheck.stored_fingerprint === fingerprint) {
              // Fingerprint cocok → replay data tersimpan (tanpa recompute harga).
              const recheckItems = await client.query(
                `SELECT poi.*, pmi.name, pmi.item_code
                 FROM pos_order_items poi
                 LEFT JOIN pos_menu_items pmi ON pmi.id = poi.menu_item_id
                 WHERE poi.order_id = $1`,
                [recheck.id]
              );
              await client.query('COMMIT');
              res.status(200).json({
                status: 'REPLAY',
                code: 'IDEMPOTENT_REPLAY',
                data: { ...recheck, items: recheckItems.rows }
              });
              return;
            }
            // Fingerprint berbeda → 409.
            await client.query('ROLLBACK');
            res.status(409).json({
              status: 'CONFLICT',
              code: 'IDEMPOTENCY_KEY_CONFLICT',
              message: 'Idempotency-Key sudah dipakai untuk payload berbeda'
            });
            return;
          }
        }

        // ─── Step 5: Reservation status gate (setelah lock + recheck) ───
        // Hanya jika tetap belum ada order existing.
        const reservationStatus = String(lockedReservation.status || '').toUpperCase();
        if (reservationStatus !== 'BOOKED' && reservationStatus !== 'CHECKED_IN') {
          await client.query('ROLLBACK');
          if (reservationStatus === 'CHECKED_OUT') {
            return res.status(409).json({
              status: 'ERROR',
              code: 'RESERVATION_CHECKED_OUT',
              message: 'Reservasi sudah selesai (check-out). Tidak dapat membuat pesanan POS baru.'
            });
          }
          if (reservationStatus === 'CANCELLED') {
            return res.status(409).json({
              status: 'ERROR',
              code: 'RESERVATION_CANCELLED',
              message: 'Reservasi telah dibatalkan. Tidak dapat membuat pesanan POS baru.'
            });
          }
          // Status lain/kosong → tolak tanpa INSERT.
          return res.status(409).json({
            status: 'ERROR',
            code: 'RESERVATION_STATUS_INVALID',
            message: `Status reservasi tidak valid untuk pembuatan pesanan POS (${reservationStatus || 'EMPTY'}).`
          });
        }
      }

      // Validasi produk aktif: hanya untuk pembuatan order BARU.
      // Replay (di atas) sudah mengembalikan 200/409 tanpa melewati blok ini.
      for (const item of items) {
        const menuItem = await client.query(
          'SELECT id, price, name, property_id FROM pos_menu_items WHERE id = $1 AND is_active = TRUE',
          [item.menu_item_id]
        );
        if (!hasRows(menuItem)) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'ERROR', code: 'MENU_ITEM_NOT_FOUND', message: `Menu item ${item.menu_item_id} not found or inactive` });
        }
        if (Number(menuItem.rows[0].property_id) !== propertyId) {
          await client.query('ROLLBACK');
          return res.status(403).json({ status: 'ERROR', code: 'CROSS_PROPERTY_MENU_ITEM', message: `Menu item ${item.menu_item_id} belongs to a different property` });
        }
      }

      // ─── Step 6: Insert path (order baru, status DIPAKSA OPEN) ───
      // Status di-create selalu OPEN — payload tidak boleh memilih status lain.
      // Ini menjamin tidak ada projection transaksi/folio saat create.
      const orderStatus = 'OPEN';
      // order_number: POS-YYYYMMDD-<UUID> (49 char, muat dalam VARCHAR(50)).
      // crypto.randomUUID() penuh — TIDAK dipotong; unique per request, bebas bentrokan konkuren.
      // Dipakai kedua path: dengan & tanpa idempotency key. Nomor historis tidak diubah.
      const posDateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const orderNumber = `POS-${posDateStr}-${crypto.randomUUID()}`;

      let orderInsert: any;
      if (idempotencyKey) {
        // INSERT dengan ON CONFLICT untuk concurrent dedup:
        // Jika request konkuren menang lebih dulu → rowCount = 0, ambil yang existing.
        orderInsert = await client.query(
          `INSERT INTO pos_orders
             (property_id, reservation_id, order_number, table_number, guest_name, total_amount, status,
              idempotency_key, request_fingerprint)
           VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8)
            ON CONFLICT (property_id, idempotency_key) WHERE idempotency_key IS NOT NULL
            DO NOTHING
            RETURNING *`,
          [propertyId, reservation_id || null, orderNumber, table_number || 'Walk In',
            guest_name || 'Guest', orderStatus, idempotencyKey, fingerprint]
        );
        if ((orderInsert.rowCount ?? 0) === 0) {
          // ─── Step 7: Winner lookup (plain SELECT, TANPA FOR UPDATE) ───
          // Kita sudah memegang lock booking/reservasi (jika ada), jadi tidak
          // perlu FOR UPDATE pada order existing. Ini mencegah jalur yang
          // memegang lock order lalu melanjutkan mengambil lock parent.
          const winnerCheck = await client.query(
            `SELECT po.id, po.property_id, po.reservation_id, po.order_number,
                    po.table_number, po.guest_name, po.status, po.total_amount,
                    po.created_at, po.updated_at,
                    po.request_fingerprint AS stored_fingerprint
             FROM pos_orders po
             WHERE po.property_id = $1 AND po.idempotency_key = $2`,
            [propertyId, idempotencyKey]
          );
          if (!hasRows(winnerCheck)) {
            // Tidak mungkin terjadi (rowCount=0 tapi SELECT kosong) — error tak terduga.
            await client.query('ROLLBACK');
            return res.status(500).json({ status: 'ERROR', code: 'IDEMPOTENCY_INTERNAL', message: 'Idempotency conflict tidak terduga' });
          }
          const winner = winnerCheck.rows[0];
          if (winner.stored_fingerprint !== fingerprint) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              status: 'CONFLICT',
              code: 'IDEMPOTENCY_KEY_CONFLICT',
              message: 'Idempotency-Key sudah dipakai untuk payload berbeda'
            });
          }
          // Fingerprint cocok → replay data tersimpan (tanpa recompute harga).
          const winnerItems = await client.query(
            `SELECT poi.*, pmi.name, pmi.item_code
             FROM pos_order_items poi
             LEFT JOIN pos_menu_items pmi ON pmi.id = poi.menu_item_id
             WHERE poi.order_id = $1`,
            [winner.id]
          );
          await client.query('COMMIT');
          res.status(200).json({
            status: 'REPLAY',
            code: 'IDEMPOTENT_REPLAY',
            data: { ...winner, items: winnerItems.rows }
          });
          return;
        }
      } else {
        // Tanpa key (backward compat) → INSERT biasa.
        orderInsert = await client.query(
          `INSERT INTO pos_orders
             (property_id, reservation_id, order_number, table_number, guest_name, total_amount, status,
              idempotency_key, request_fingerprint)
           VALUES ($1, $2, $3, $4, $5, 0, $6, NULL, $7)
           RETURNING *`,
          [propertyId, reservation_id || null, orderNumber, table_number || 'Walk In',
            guest_name || 'Guest', orderStatus, fingerprint]
        );
      }

      const orderId = orderInsert.rows[0].id;
      let totalAmount = 0;

      for (const item of items) {
        const menuItem = await client.query(
          'SELECT id, price, name FROM pos_menu_items WHERE id = $1 AND is_active = TRUE',
          [item.menu_item_id]
        );
        const menu = menuItem.rows[0];
        const qty = Number(item.quantity || 1);
        const unitPrice = Number(menu.price);
        totalAmount += qty * unitPrice;

        await client.query(
          `INSERT INTO pos_order_items (order_id, menu_item_id, quantity, unit_price, notes)
           VALUES ($1, $2, $3, $4, $5)`,
          [orderId, menu.id, qty, unitPrice, item.notes || null]
        );
      }

      const updatedOrder = await client.query(
        'UPDATE pos_orders SET total_amount = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [totalAmount, orderId]
      );

      // Status OPEN → TIDAK ada projection transaksi. Tidak perlu guard status.
      // (Code lama yang cek PAID/COMPLETED/POSTED/CLOSED dihapus karena status dipaksa OPEN.)

      await client.query('COMMIT');
      deps.broadcastEvent('PosOrderCreated', {
        order_id: orderId,
        order_number: orderNumber,
        guest_name: guest_name || 'Guest',
        total_amount: totalAmount,
        timestamp: new Date().toISOString()
      }, propertyId);

      res.status(201).json({ status: 'SUCCESS', data: updatedOrder.rows[0] });
    } catch (err: any) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {
        // transaksi sudah terminated / sudah commit — abaikan
      }
      res.status(500).json({ status: 'ERROR', message: err.message });
    } finally {
      deps.release(client);
    }
  };
}

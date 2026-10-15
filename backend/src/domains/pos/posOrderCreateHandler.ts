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
import { getPropertyPricingSettings } from '../pricing/pricingService';

// ── Simple helper (no external dependency) ─────────────────────────────────

const hasRows = (result: { rowCount?: number | null } | null | undefined): boolean =>
  Number(result?.rowCount ?? 0) > 0;

// Numeric input validation without coercing objects/booleans into discounts.
const isDiscountValue = (raw: unknown, type: unknown): boolean => {
  if (typeof raw !== 'number' && typeof raw !== 'string') return false;
  if (typeof raw === 'string' && raw.trim() === '') return false;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return false;
  if (type === 'NOMINAL') return Number.isSafeInteger(value);
  // discount_value is NUMERIC(12,2); percentages may use two decimal places.
  return value <= 100 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-8;
};

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

  /**
   * Check whether the authenticated user holds the `pos.discount.edit` permission.
   * In production: uses getUserEffectivePermissions(pool, userId).
   * In tests: may be stubbed to return true/false.
   * Returns true only when the user is explicitly granted the permission.
   *
   * When not provided, the handler denies discount usage (fail-closed) but
   * allows orders without discount to proceed as before.
   */
  checkDiscountPermission?: (pool: Pool, userId: number, propertyId: number) => Promise<boolean>;
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
    const {
      property_id: propertyIdRaw,
      reservation_id,
      table_number,
      guest_name,
      guest_phone,
      notes,
      discount_type: orderDiscountTypeRaw,
      discount_value: orderDiscountValueRaw,
      discount_reason: orderDiscountReason,
      tax_enabled: taxEnabledRaw,
      service_charge_enabled: serviceChargeEnabledRaw,
      items,
    } = req.body;

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
    // Diskon per item (opsional): type 'NOMINAL'|'PERCENT', value >= 0,
    // PERCENT ≤ 100.
    for (let i = 0; i < items.length; i++) {
      if (!items[i] || typeof items[i] !== 'object' || Array.isArray(items[i])) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: `items[${i}] must be an object` });
      }
      const qty = Number(items[i].quantity ?? 1);
      if (!Number.isSafeInteger(qty) || qty <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: `items[${i}].quantity must be a positive integer`
        });
      }
      // Validasi diskon per item (opsional)
      const itDisType = items[i].discount_type ?? null;
      const itDisVal = items[i].discount_value ?? null;
      if ((itDisType === null) !== (itDisVal === null)) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: `items[${i}].discount_type and discount_value must be supplied together` });
      }
      if (itDisType !== null && itDisType !== undefined) {
        if (itDisType !== 'NOMINAL' && itDisType !== 'PERCENT') {
          return res.status(400).json({
            status: 'ERROR',
            code: 'VALIDATION_ERROR',
            message: `items[${i}].discount_type must be 'NOMINAL' or 'PERCENT'`
          });
        }
      }
      if (itDisVal !== null && itDisVal !== undefined) {
        if (!isDiscountValue(itDisVal, itDisType)) {
          return res.status(400).json({
            status: 'ERROR',
            code: 'VALIDATION_ERROR',
            message: `items[${i}].discount_value must be finite and non-negative; NOMINAL uses whole rupiah, PERCENT uses 0-100 with up to 2 decimals`
          });
        }
      }
    }

    // Validasi diskon order (opsional)
    let orderDiscountType: string | null = null;
    let orderDiscountValue: number | null = null;
    let orderDiscountReasonNorm: string | null = null;
    if ((orderDiscountTypeRaw == null) !== (orderDiscountValueRaw == null)) {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'discount_type and discount_value must be supplied together' });
    }
    if (orderDiscountTypeRaw !== null && orderDiscountTypeRaw !== undefined) {
      if (orderDiscountTypeRaw !== 'NOMINAL' && orderDiscountTypeRaw !== 'PERCENT') {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: "discount_type must be 'NOMINAL' or 'PERCENT'"
        });
      }
      orderDiscountType = orderDiscountTypeRaw;
    }
    if (orderDiscountValueRaw !== null && orderDiscountValueRaw !== undefined) {
      if (!isDiscountValue(orderDiscountValueRaw, orderDiscountType)) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'discount_value must be finite and non-negative; NOMINAL uses whole rupiah, PERCENT uses 0-100 with up to 2 decimals'
        });
      }
      orderDiscountValue = Number(orderDiscountValueRaw);
    }
    if (orderDiscountReason !== null && orderDiscountReason !== undefined) {
      const s = String(orderDiscountReason).trim();
      if (s.length > 100) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'discount_reason must be ≤ 100 characters'
        });
      }
      orderDiscountReasonNorm = s || null;
    }

    // Validasi guest_phone (opsional, snapshot)
    let normalizedGuestPhone: string | null = null;
    if (guest_phone !== null && guest_phone !== undefined) {
      const s = String(guest_phone).trim();
      if (s.length > 50) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'guest_phone must be ≤ 50 characters'
        });
      }
      normalizedGuestPhone = s || null;
    }

    // Validasi notes (opsional, snapshot)
    let normalizedNotes: string | null = null;
    if (notes !== null && notes !== undefined) {
      const s = String(notes).trim();
      if (s.length > 1000) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'notes must be ≤ 1000 characters'
        });
      }
      normalizedNotes = s || null;
    }

    // ─── Validasi toggle tax / service charge (opsional, default false) ───
    // Client hanya mengirim enabled flag. Rate selalu diambil dari
    // property_pricing_settings di backend — client tidak mengirim rate.
    // Nilai selain true/false → default false (fail-closed ke OFF).
    const taxEnabled = taxEnabledRaw === true;
    const serviceChargeEnabled = serviceChargeEnabledRaw === true;

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

    // ─── Discount permission gate ─────────────────────────────────────────
    // Jika request mengandung diskon (item atau order), user wajib memiliki
    // izin `pos.discount.edit`. Order tanpa diskon tidak terpengaruh.
    // Fail-closed: jika checkDiscountPermission tidak tersedia, tolak diskon.
    const hasAnyDiscount =
      orderDiscountType !== null ||
      orderDiscountValue !== null ||
      items.some((it: any) => it.discount_type != null || it.discount_value != null);
    if (hasAnyDiscount) {
      if (typeof deps.checkDiscountPermission !== 'function') {
        return res.status(403).json({
          status: 'ERROR',
          code: 'DISCOUNT_PERMISSION_DENIED',
          message: 'Izin diskon tidak tersedia (pos.discount.edit)'
        });
      }
      const userId = Number((req as any).user?.id);
      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(401).json({
          status: 'ERROR',
          code: 'UNAUTHORIZED',
          message: 'User tidak terautentikasi'
        });
      }
      const allowed = await deps.checkDiscountPermission(deps.pool, userId, propertyId);
      if (!allowed) {
        return res.status(403).json({
          status: 'ERROR',
          code: 'DISCOUNT_PERMISSION_DENIED',
          message: 'Anda tidak memiliki izin untuk memberikan diskon (pos.discount.edit)'
        });
      }
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

    // Preserve the legacy fingerprint when no expansion metadata is supplied.
    // Tax/service toggles are treated as expanded fields (they affect total_amount).
    //
    // CRITICAL: hasTaxServiceToggles menggunakan PRESENCE CHECK terhadap raw
    // request fields (taxEnabledRaw / serviceChargeEnabledRaw), BUKAN nilai
    // boolean hasil normalisasi. Alasannya:
    //   - tax_enabled=false vs tax_enabled=true  → fingerprint BERBEDA
    //   - request legacy tanpa field sama sekali → tetap backward-compatible
    //     (fingerprint legacy tanpa field tax/service)
    // Ini menjamin bahwa perubahan toggle menghasilkan fingerprint berbeda
    // sehingga replay idempotent tidak akan salah-match.
    const legacyPayload = {
      property_id: propertyId,
      reservation_id: reservation_id ?? null,
      table_number: table_number ?? 'Walk In',
      guest_name: guest_name ?? 'Guest',
      items: items.map((it: any) => ({
        menu_item_id: Number(it.menu_item_id),
        quantity: Number(it.quantity ?? 1),
        notes: it.notes ?? null
      }))
    };
    // Presence check: field ada di body request (baik true maupun false).
    const hasTaxServiceToggles = (taxEnabledRaw !== undefined && taxEnabledRaw !== null) ||
      (serviceChargeEnabledRaw !== undefined && serviceChargeEnabledRaw !== null);
    const hasExpandedFields = normalizedGuestPhone !== null || normalizedNotes !== null ||
      orderDiscountType !== null || orderDiscountValue !== null || orderDiscountReasonNorm !== null ||
      hasTaxServiceToggles ||
      items.some((it: any) => it.discount_type != null || it.discount_value != null);
    const expandedPayload = {
      property_id: propertyId,
      reservation_id: reservation_id ?? null,
      table_number: table_number ?? 'Walk In',
      guest_name: guest_name ?? 'Guest',
      guest_phone: normalizedGuestPhone,
      notes: normalizedNotes,
      discount_type: orderDiscountType,
      discount_value: orderDiscountValue,
      discount_reason: orderDiscountReasonNorm,
      tax_enabled: taxEnabled,
      service_charge_enabled: serviceChargeEnabled,
      items: items.map((it: any) => ({
        menu_item_id: Number(it.menu_item_id),
        quantity: Number(it.quantity ?? 1),
        notes: it.notes ?? null,
        discount_type: it.discount_type ?? null,
        discount_value: it.discount_value == null ? null : Number(it.discount_value)
      }))
    };
    const expandedFingerprint = computeRequestHash('POST', '/api/pos/orders', JSON.stringify(expandedPayload));
    const fingerprint = hasExpandedFields
      ? expandedFingerprint
      : computeRequestHash('POST', '/api/pos/orders', JSON.stringify(legacyPayload));
    // Also accept empty-expansion hashes produced by the earlier local version.
    // Never accept a legacy hash when the request contains expansion metadata.
    const matchesFingerprint = (stored: unknown): boolean => stored === fingerprint ||
      (!hasExpandedFields && stored === expandedFingerprint);

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
                  po.guest_phone, po.notes,
                  po.discount_type, po.discount_value, po.discount_reason, po.discount_amount,
                  po.tax_enabled, po.tax_rate, po.tax_amount,
                  po.service_charge_enabled, po.service_charge_rate, po.service_charge_amount,
                  po.request_fingerprint AS stored_fingerprint
           FROM pos_orders po
           WHERE po.property_id = $1 AND po.idempotency_key = $2
           FOR UPDATE`,
          [propertyId, idempotencyKey]
        );
        if (hasRows(existingCheck)) {
          const existing = existingCheck.rows[0];
          // Fingerprint cocok → replay (kembalikan order + items tersimpan, TANPA recompute harga).
          if (matchesFingerprint(existing.stored_fingerprint)) {
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
                    po.guest_phone, po.notes,
                    po.discount_type, po.discount_value, po.discount_reason, po.discount_amount,
                    po.tax_enabled, po.tax_rate, po.tax_amount,
                    po.service_charge_enabled, po.service_charge_rate, po.service_charge_amount,
                    po.request_fingerprint AS stored_fingerprint
             FROM pos_orders po
             WHERE po.property_id = $1 AND po.idempotency_key = $2`,
            [propertyId, idempotencyKey]
          );
          if (hasRows(recheckResult)) {
            const recheck = recheckResult.rows[0];
            if (matchesFingerprint(recheck.stored_fingerprint)) {
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

      // ── Ambil snapshot rate dari property_pricing_settings (di dalam transaksi) ──
      // Rate dari property_pricing_settings adalah authoritative untuk order ini.
      // Snapshot disimpan selamanya pada pos_orders — replay tidak recompute
      // dari pricing settings current (yang bisa berubah).
      //
      // Gunakan canonical accessor getPropertyPricingSettings():
      //  - auto-creates default row bila belum ada (tax_percent=10.00, service_charge_percent=0.00)
      //  - POS tidak mendefinisikan fallback rate sendiri
      //  - helper menerima PoolClient, aman di dalam transaksi
      const pricingSettings = await getPropertyPricingSettings(client, propertyId);
      const snapshotTaxRate = pricingSettings.tax_percent;
      const snapshotServiceChargeRate = pricingSettings.service_charge_percent;

      let orderInsert: any;
      if (idempotencyKey) {
        // INSERT dengan ON CONFLICT untuk concurrent dedup:
        // Jika request konkuren menang lebih dulu → rowCount = 0, ambil yang existing.
        orderInsert = await client.query(
          `INSERT INTO pos_orders
             (property_id, reservation_id, order_number, table_number, guest_name, total_amount, status,
              idempotency_key, request_fingerprint,
              guest_phone, notes,
              discount_type, discount_value, discount_reason, discount_amount,
              tax_enabled, tax_rate, tax_amount,
              service_charge_enabled, service_charge_rate, service_charge_amount)
           VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8,
                  $9, $10, $11, $12, $13, 0,
                  $14, $15, 0,
                  $16, $17, 0)
            ON CONFLICT (property_id, idempotency_key) WHERE idempotency_key IS NOT NULL
            DO NOTHING
            RETURNING *`,
          [propertyId, reservation_id || null, orderNumber, table_number || 'Walk In',
            guest_name || 'Guest', orderStatus, idempotencyKey, fingerprint,
            normalizedGuestPhone, normalizedNotes,
            orderDiscountType, orderDiscountValue, orderDiscountReasonNorm,
            taxEnabled, snapshotTaxRate,
            serviceChargeEnabled, snapshotServiceChargeRate]
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
                    po.guest_phone, po.notes,
                    po.discount_type, po.discount_value, po.discount_reason, po.discount_amount,
                    po.tax_enabled, po.tax_rate, po.tax_amount,
                    po.service_charge_enabled, po.service_charge_rate, po.service_charge_amount,
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
          if (!matchesFingerprint(winner.stored_fingerprint)) {
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
              idempotency_key, request_fingerprint,
              guest_phone, notes,
              discount_type, discount_value, discount_reason, discount_amount,
              tax_enabled, tax_rate, tax_amount,
              service_charge_enabled, service_charge_rate, service_charge_amount)
           VALUES ($1, $2, $3, $4, $5, 0, $6, NULL, $7,
                  $8, $9, $10, $11, $12, 0,
                  $13, $14, 0,
                  $15, $16, 0)
            RETURNING *`,
           [propertyId, reservation_id || null, orderNumber, table_number || 'Walk In',
             guest_name || 'Guest', orderStatus, fingerprint,
             normalizedGuestPhone, normalizedNotes,
             orderDiscountType, orderDiscountValue, orderDiscountReasonNorm,
             taxEnabled, snapshotTaxRate,
             serviceChargeEnabled, snapshotServiceChargeRate]
        );
      }

      const orderId = orderInsert.rows[0].id;
      let totalAmount = 0;
      let orderSubtotalAfterItemDiscounts = 0;
      // Collect per-item discount details for audit (only items with discount).
      const itemDiscountAudit: Array<{
        menu_item_id: number; quantity: number; item_gross: number;
        discount_type: string; discount_value: number; discount_amount: number; item_net: number;
      }> = [];

      for (const item of items) {
        const menuItem = await client.query(
          'SELECT id, price, name, item_code FROM pos_menu_items WHERE id = $1 AND property_id = $2 AND is_active = TRUE',
          [item.menu_item_id, propertyId]
        );
        const menu = menuItem.rows[0];
        if (!menu) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'ERROR', code: 'MENU_ITEM_NOT_FOUND', message: `Menu item ${item.menu_item_id} not found or inactive` });
        }
        const qty = Number(item.quantity ?? 1);
        const unitPrice = Number(menu.price);
        const itemGross = qty * unitPrice;
        if (menu.price == null || !Number.isSafeInteger(unitPrice) || unitPrice < 0 || !Number.isSafeInteger(itemGross)) {
          await client.query('ROLLBACK');
          return res.status(422).json({ status: 'ERROR', code: 'INVALID_MENU_PRICE', message: 'Menu price and item subtotal must use valid whole rupiah' });
        }

        // ── Diskon per item (per baris) ──────────────────────────────────
        // NOMINAL: potongan per baris (bukan per unit).
        // PERCENT: potongan persentase dari itemGross.
        // NOMINAL must not exceed the line subtotal; invalid input is rejected.
        // PERCENT is rounded from itemGross * discount_value / 100.
        let itemDiscountAmount = 0;
        const itDisType = item.discount_type ?? null;
        const itDisVal = item.discount_value ?? null;
        if (itDisType === 'NOMINAL' && itDisVal !== null && itDisVal !== undefined) {
          const raw = Number(itDisVal);
          if (raw > itemGross) {
            await client.query('ROLLBACK');
            return res.status(422).json({ status: 'ERROR', code: 'DISCOUNT_EXCEEDS_SUBTOTAL', message: `Item discount exceeds subtotal for menu item ${menu.id}` });
          }
          itemDiscountAmount = raw;
        } else if (itDisType === 'PERCENT' && itDisVal !== null && itDisVal !== undefined) {
          const raw = Number(itDisVal);
          itemDiscountAmount = Math.round(itemGross * raw / 100);
        }
        itemDiscountAmount = Math.round(itemDiscountAmount);
        const itemNet = itemGross - itemDiscountAmount;
        totalAmount += itemNet;
        orderSubtotalAfterItemDiscounts += itemNet;

        await client.query(
          `INSERT INTO pos_order_items
             (order_id, menu_item_id, quantity, unit_price, notes,
              discount_type, discount_value, discount_amount,
              item_name_snapshot, item_code_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [orderId, menu.id, qty, unitPrice, item.notes || null,
            itDisType,
            (itDisVal !== null && itDisVal !== undefined) ? Number(itDisVal) : null,
            itemDiscountAmount,
            menu.name,
            menu.item_code ?? null]
        );

        // Record item discount for audit
        if (itemDiscountAmount > 0) {
          itemDiscountAudit.push({
            menu_item_id: Number(item.menu_item_id),
            quantity: qty,
            item_gross: itemGross,
            discount_type: itDisType!,
            discount_value: Number(itDisVal),
            discount_amount: itemDiscountAmount,
            item_net: itemNet,
          });
        }
      }

      // ── Diskon order (di atas subtotal setelah diskon item) ──────────
      if (!Number.isSafeInteger(orderSubtotalAfterItemDiscounts)) {
        await client.query('ROLLBACK');
        return res.status(422).json({ status: 'ERROR', code: 'INVALID_ORDER_AMOUNT', message: 'Order subtotal exceeds the supported range' });
      }
      let orderDiscountAmount = 0;
      if (orderDiscountType === 'NOMINAL' && orderDiscountValue !== null) {
        const raw = Number(orderDiscountValue);
        if (raw > orderSubtotalAfterItemDiscounts) {
          await client.query('ROLLBACK');
          return res.status(422).json({ status: 'ERROR', code: 'DISCOUNT_EXCEEDS_SUBTOTAL', message: 'Order discount exceeds subtotal after item discounts' });
        }
        orderDiscountAmount = raw;
      } else if (orderDiscountType === 'PERCENT' && orderDiscountValue !== null) {
        const raw = Number(orderDiscountValue);
        orderDiscountAmount = Math.round(orderSubtotalAfterItemDiscounts * raw / 100);
      }
      orderDiscountAmount = Math.round(orderDiscountAmount);
      const netAfterDiscount = orderSubtotalAfterItemDiscounts - orderDiscountAmount;

      // ── Service charge & tax canonical calculation ─────────────────────
      // Urutan: service charge → tax atas (net + service charge)
      // Rate dari snapshot property_pricing_settings (di atas), bukan live.
      // Whole-rupiah: semua hasil Math.round ke integer.
      let serviceChargeAmount = 0;
      let taxAmount = 0;

      if (serviceChargeEnabled) {
        serviceChargeAmount = Math.round(netAfterDiscount * snapshotServiceChargeRate / 100);
        if (!Number.isSafeInteger(serviceChargeAmount) || serviceChargeAmount < 0) {
          await client.query('ROLLBACK');
          return res.status(422).json({ status: 'ERROR', code: 'INVALID_ORDER_AMOUNT', message: 'Service charge calculation overflow' });
        }
      }

      const taxBase = netAfterDiscount + serviceChargeAmount;

      if (taxEnabled) {
        taxAmount = Math.round(taxBase * snapshotTaxRate / 100);
        if (!Number.isSafeInteger(taxAmount) || taxAmount < 0) {
          await client.query('ROLLBACK');
          return res.status(422).json({ status: 'ERROR', code: 'INVALID_ORDER_AMOUNT', message: 'Tax calculation overflow' });
        }
      }

      const finalTotal = netAfterDiscount + serviceChargeAmount + taxAmount;
      if (!Number.isSafeInteger(finalTotal) || finalTotal < 0) {
        await client.query('ROLLBACK');
        return res.status(422).json({ status: 'ERROR', code: 'INVALID_ORDER_AMOUNT', message: 'Order final total exceeds the supported range' });
      }

      const updatedOrder = await client.query(
        `UPDATE pos_orders
         SET total_amount = $1,
             discount_amount = $2,
             tax_amount = $3,
             service_charge_amount = $4,
             updated_at = NOW()
         WHERE id = $5
         RETURNING *`,
        [finalTotal, orderDiscountAmount, taxAmount, serviceChargeAmount, orderId]
      );

      // Status OPEN → TIDAK ada projection transaksi. Tidak perlu guard status.
      // (Code lama yang cek PAID/COMPLETED/POSTED/CLOSED dihapus karena status dipaksa OPEN.)

      // ── Audit log diskon (hanya jika ada diskon yang diterapkan) ──────
      if (itemDiscountAudit.length > 0 || orderDiscountAmount > 0) {
        const actorId = Number((req as any).user?.id) || null;
        const actorName = String((req as any).user?.username || (req as any).user?.full_name || null);
        const itemDiscountTotal = itemDiscountAudit.reduce((s, d) => s + d.discount_amount, 0);
        const discountAuditPayload: Record<string, any> = {
          property_id: propertyId,
          pos_order_id: orderId,
          order_number: orderNumber,
          item_discounts: itemDiscountAudit,
          order_discount: orderDiscountAmount > 0 ? {
            discount_type: orderDiscountType,
            discount_value: orderDiscountValue,
            discount_amount: orderDiscountAmount,
            basis: 'subtotal_after_item_discounts',
            basis_amount: orderSubtotalAfterItemDiscounts,
            reason: orderDiscountReasonNorm,
          } : null,
          total_discount: itemDiscountTotal + orderDiscountAmount,
          actor_user_id: actorId,
          actor_name: actorName,
        };
        await client.query(
          `INSERT INTO audit_logs (
             module, action, entity, record_id, new_value,
             property_id, actor_user_id, correlation_id
           ) VALUES ('POS', $1, 'pos_orders', $2, $3, $4, $5, $6)`,
          [
            'ORDER_DISCOUNT_APPLIED',
            String(orderId),
            JSON.stringify(discountAuditPayload),
            propertyId,
            String(actorId || null),
            null,
          ]
        );
      }

      // ── Audit log tax/service charge (hanya jika ada yang diterapkan) ──
      if (serviceChargeAmount > 0 || taxAmount > 0) {
        const actorId = Number((req as any).user?.id) || null;
        const actorName = String((req as any).user?.username || (req as any).user?.full_name || null);
        const taxServiceAuditPayload: Record<string, any> = {
          property_id: propertyId,
          pos_order_id: orderId,
          order_number: orderNumber,
          service_charge: serviceChargeAmount > 0 ? {
            enabled: serviceChargeEnabled,
            rate: snapshotServiceChargeRate,
            basis: 'net_after_discount',
            basis_amount: netAfterDiscount,
            amount: serviceChargeAmount,
          } : null,
          tax: taxAmount > 0 ? {
            enabled: taxEnabled,
            rate: snapshotTaxRate,
            basis: 'net_after_discount_plus_service_charge',
            basis_amount: netAfterDiscount + serviceChargeAmount,
            amount: taxAmount,
          } : null,
          total_amount: finalTotal,
          actor_user_id: actorId,
          actor_name: actorName,
        };
        await client.query(
          `INSERT INTO audit_logs (
             module, action, entity, record_id, new_value,
             property_id, actor_user_id, correlation_id
           ) VALUES ('POS', $1, 'pos_orders', $2, $3, $4, $5, $6)`,
          [
            'ORDER_TAX_SERVICE_APPLIED',
            String(orderId),
            JSON.stringify(taxServiceAuditPayload),
            propertyId,
            String(actorId || null),
            null,
          ]
        );
      }

      await client.query('COMMIT');
      deps.broadcastEvent('PosOrderCreated', {
        order_id: orderId,
        order_number: orderNumber,
        guest_name: guest_name || 'Guest',
        total_amount: finalTotal,
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

/**
 * posOrderUpdateHandler.ts
 *
 * PUT /api/pos/orders/:id
 *
 * POS-EDIT-1A — Update order OPEN secara aman.
 *
 * Kontrak:
 *   - assertPropertyScope SEBELUM transaksi DB.
 *   - Lock parent order FOR UPDATE.
 *   - Status harus OPEN; PAID/VOIDED → 409 ORDER_NOT_OPEN.
 *   - Artefak finansial (transaksi POS + pos_settlements) → 409 FINANCIAL_LOCK.
 *   - Version wajib dikirim oleh klien (expected_version) → mismatch → 409 ORDER_VERSION_CONFLICT.
 *   - Idempotency multi-siklus via pos_order_edit_requests (key + fingerprint).
 *   - Item diff: DELETE dihapus → UPDATE existing → INSERT baru (atomik, satu transaksi).
 *   - Item existing: unit_price dipertahankan dari snapshot lama.
 *   - Item baru: harga dari DB (pos_menu_items.price) saat itu.
 *   - Item dinonaktifkan (is_active=false) → 400 INACTIVE_ITEM.
 *   - computePosPricing() dipanggil dengan snapshot svc/tax dari order lama
 *     (bukan master pricing settings).
 *   - Flag snapshot svc/tax TIDAK di-overwrite saat edit. reservation_id,
 *     service_charge_enabled, dan tax_enabled DITOLAK (400 UNSUPPORTED_FIELD)
 *     — termasuk bila dikirim null.
 *   - Field editable: item/quantity/diskon per-item, order-level discount,
 *     dan metadata order (table_number, guest_name, guest_phone, notes,
 *     discount_reason) dengan persist tri-state: omitted → kolom tidak
 *     berubah, null → SET NULL, string → trim + batas panjang.
 *   - version incremented + commit.
 *
 * Dependency: pool/connect/release, assertPropertyScope, checkDiscountPermission.
 * Tidak membuat pool, tidak membaca dotenv, tidak mengimpor index.ts.
 */

import type { Pool, PoolClient } from 'pg';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import { computePosPricing, PosPricingError } from './posPricingCore';

// ── Dependency interface ─────────────────────────────────────────────────────

export interface PosOrderUpdateDeps {
  pool: Pool;
  connect: () => Promise<PoolClient>;
  release: (client: PoolClient, discard?: boolean) => void;
  assertPropertyScope: (req: Request, propertyId: number) => Promise<void>;
  /**
   * Cek apakah userId memiliki permission 'pos.discount.edit' di propertyId.
   * Jika request mengandung diskon (item atau order) tanpa permission → 403.
   * Implementasi production: getUserEffectivePermissions + includes check.
   * Fail-closed: exception → return false.
   */
  checkDiscountPermission: (
    pool: Pool,
    userId: number,
    propertyId: number
  ) => Promise<boolean>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Hash deterministik SHA-256 dari objek, string hex. */
function hashFingerprint(payload: Record<string, unknown>): string {
  // JSON.stringify deterministik: objek dibuat dalam urutan key yang tetap,
  // maka output string stabil untuk payload identik.
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

const hasRows = (result: { rowCount?: number | null } | null | undefined): boolean =>
  Number(result?.rowCount ?? 0) > 0;

/** Validasi nilai diskon (sama seperti posOrderCreateHandler). */
function isDiscountValue(value: unknown, type: string | null): boolean {
  if (value == null || !Number.isFinite(Number(value))) return false;
  const n = Number(value);
  if (n < 0) return false;
  if (type === 'NOMINAL') {
    return Number.isInteger(n);
  }
  if (type === 'PERCENT') {
    return n <= 100 && Number((n * 100).toFixed(2)) === n * 100;
  }
  return n <= 100; // type null → anggap percent
}

/**
 * Validasi + normalisasi snapshot teks tamu/order (table_number, guest_name,
 * guest_phone, notes, discount_reason). trim() + batas panjang sesuai schema.
 * Tri-state:
 *   - undefined → undefined (omitted: kolom TIDAK berubah)
 *   - null      → null      (clear: SET NULL)
 *   - string    → hasil trim; '' (setelah trim) → null (clear)
 * throw (VALIDATION_ERROR) bila nilai bukan string/undefined/null atau
 * panjang melebihi batas.
 */
function normalizeSnapshotText(
  raw: unknown,
  field: string,
  maxLength: number
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    throw new Error(`${field} harus string`);
  }
  const s = raw.trim();
  if (s.length > maxLength) {
    throw new Error(`${field} must be ≤ ${maxLength} characters`);
  }
  return s === '' ? null : s;
}

/**
 * Konstruksi payload fingerprint (sumber tunggal) — dipakai untuk:
 *   1. replay check di awal transaksi (bandingkan dengan record tersimpan),
 *   2. INSERT record idempotency setelah commit sukses.
 * Menghindari divergensi: satu-satunya tempat payload fingerprint disusun.
 *
 * Cakupan (hanya field editable yang benar-benar diterapkan):
 *   - expected_version (anti-stale)
 *   - identitas item existing: it.id (id dari GET /detail);
 *     item baru → null (identitas dibuat saat INSERT)
 *   - item baru: menu_item_id, quantity, diskon, notes
 *   - metadata tamu/order: table_number, guest_name, guest_phone, notes,
 *     discount_reason — tri-state: omitted (undefined) dibedakan dari
 *     explicit null (JSON.stringify menghilangkan key bernilai undefined,
 *     sehingga hash omitted ≠ hash null)
 *   - diskon: order-level type/value
 *   - expected_total (anti-stale harga, sama seperti create handler)
 *
 * Field yang ditolak (reservation_id, service_charge_enabled, tax_enabled)
 * TIDAK dimasukkan ke fingerprint.
 */
interface EditFingerprintInput {
  expected_version: number;
  raw_items: unknown[] | undefined;
  table_number: string | null | undefined;
  guest_name: string | null | undefined;
  guest_phone: string | null | undefined;
  notes: string | null | undefined;
  discount_reason: string | null | undefined;
  order_discount_type: 'NOMINAL' | 'PERCENT' | null;
  order_discount_value: number | null;
  expected_total: number | null;
}

/**
 * Susun payload fingerprint deterministik (urutan key tetap untuk JSON.stringify).
 * Identitas item existing memakai `it.id` — field yang sama dengan yang
 * dikembalikan GET detail (items[].id) dan yang dipakai validasi item diff.
 * Item baru (tanpa id) → null, di-snapshot lewat menu_item_id.
 */
function buildEditFingerprintPayload(inp: EditFingerprintInput): Record<string, unknown> {
  // Normalisasi item: identitas existing via it.id; item baru → null.
  // Sort by (id ?? MAX) lalu menu_item_id → urutan deterministik stabil untuk
  // replay & INSERT, tanpa bergantung pada urutan array klien.
  const items = (inp.raw_items ?? [])
    .map((it: any) => ({
      id:
        it?.id != null && Number.isFinite(Number(it.id))
          ? Number(it.id)
          : null,
      menu_item_id: it?.menu_item_id == null ? null : Number(it.menu_item_id),
      quantity: it?.quantity == null ? 1 : Number(it.quantity),
      discount_type: it?.discount_type ?? null,
      discount_value: it?.discount_value == null ? null : Number(it.discount_value),
      notes: it?.notes ?? null,
    }))
    .sort((a: any, b: any) => {
      const ai = a.id == null ? Number.MAX_SAFE_INTEGER : a.id;
      const bi = b.id == null ? Number.MAX_SAFE_INTEGER : b.id;
      if (ai !== bi) return ai - bi;
      // Item baru (null) di-sort oleh menu_item_id sebagai tiebreaker stabil
      const am = a.menu_item_id == null ? Number.MAX_SAFE_INTEGER : a.menu_item_id;
      const bm = b.menu_item_id == null ? Number.MAX_SAFE_INTEGER : b.menu_item_id;
      if (am !== bm) return am - bm;
      return 0;
    });

  return {
    expected_version: inp.expected_version,
    items,
    table_number: inp.table_number,
    guest_name: inp.guest_name,
    guest_phone: inp.guest_phone,
    notes: inp.notes,
    discount_reason: inp.discount_reason,
    order_discount_type: inp.order_discount_type,
    order_discount_value: inp.order_discount_value,
    expected_total: inp.expected_total,
  };
}

/** Hitung fingerprint (SHA-256 hex) dari input normalisasi. */
function computeEditFingerprint(inp: EditFingerprintInput): string {
  return hashFingerprint(buildEditFingerprintPayload(inp));
}

export function createPosOrderUpdateHandler(deps: PosOrderUpdateDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    // ── 1. Validasi parameter order id ─────────────────────────────────────
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

    const body = req.body ?? {};
    const propertyIdRaw = body.property_id;
    if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
      res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
      return;
    }
    const propertyId = Number(propertyIdRaw);
    if (!Number.isInteger(propertyId) || propertyId <= 0 || propertyId > 2147483647) {
      res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
      return;
    }

    // expected_version wajib integer ≥ 1
    const expectedVersion = body.expected_version;
    if (expectedVersion === undefined || expectedVersion === null) {
      res.status(400).json({
        status: 'ERROR',
        code: 'VALIDATION_ERROR',
        message: 'expected_version is required (integer ≥ 1)'
      });
      return;
    }
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      res.status(400).json({
        status: 'ERROR',
        code: 'VALIDATION_ERROR',
        message: 'expected_version must be integer ≥ 1'
      });
      return;
    }

    // items array (opsional — jika tak dikirim, tanpa perubahan item)
    const rawItems: unknown[] | undefined = Array.isArray(body.items) ? body.items : undefined;

    // Idempotency key — WAJIB untuk PUT
    if (typeof body.idempotency_key !== 'string' || body.idempotency_key.trim() === '') {
      res.status(400).json({
        status: 'ERROR', code: 'VALIDATION_ERROR',
        message: 'idempotency_key is required (non-empty string)'
      });
      return;
    }
    const editIdempotencyKey = body.idempotency_key.trim().slice(0, 150);

    // Order-level discount (opsional)
    let orderDiscountType: 'NOMINAL' | 'PERCENT' | null | undefined = undefined;
    let orderDiscountValue: number | null = null;
    if (body.order_discount_type !== undefined) {
      const ot = body.order_discount_type;
      if (ot !== null && ot !== 'NOMINAL' && ot !== 'PERCENT') {
        res.status(400).json({
          status: 'ERROR', code: 'VALIDATION_ERROR',
          message: "order_discount_type must be null, 'NOMINAL', or 'PERCENT'"
        });
        return;
      }
      orderDiscountType = ot;
    }
    if (body.order_discount_value !== undefined) {
      const ov = body.order_discount_value;
      if (ov !== null && (!Number.isFinite(Number(ov)) || Number(ov) < 0)) {
        res.status(400).json({
          status: 'ERROR', code: 'VALIDATION_ERROR',
          message: 'order_discount_value must be null or finite non-negative'
        });
        return;
      }
      orderDiscountValue = ov === null ? null : Number(ov);
    }

    // ── Field immutable via PUT: tolak eksplisit (termasuk null) ──────────
    // reservation_id (relasi folio/reservasi), service_charge_enabled, dan
    // tax_enabled (harus mengikuti snapshot order existing) TIDAK boleh
    // berubah lewat PUT. Ditolak sebelum transaksi DB agar tidak terjadi
    // false-success maupun polusi fingerprint idempotency.
    {
      const unsupported: string[] = [];
      if (body.reservation_id !== undefined) unsupported.push('reservation_id');
      if (body.service_charge_enabled !== undefined) unsupported.push('service_charge_enabled');
      if (body.tax_enabled !== undefined) unsupported.push('tax_enabled');
      if (unsupported.length > 0) {
        res.status(400).json({
          status: 'ERROR', code: 'UNSUPPORTED_FIELD',
          message: `Field tidak dapat diubah melalui PUT: ${unsupported.join(', ')}`,
        });
        return;
      }
    }

    // ── Snapshot fields: validasi + normalisasi tri-state (fail-closed) ────
    // table_number (VARCHAR(20)), guest_name (VARCHAR(100)), guest_phone
    // (VARCHAR(50)), notes (TEXT, 1000), discount_reason (VARCHAR(100)).
    // Tri-state: undefined → omitted (kolom tidak berubah); null → SET NULL;
    // string → trim + batas panjang (sama seperti create handler).
    let tableNumber: string | null | undefined;
    let guestName: string | null | undefined;
    let guestPhone: string | null | undefined;
    let orderNotes: string | null | undefined;
    let discountReason: string | null | undefined;
    let expectedTotal: number | null = null;
    try {
      tableNumber = normalizeSnapshotText(body.table_number, 'table_number', 20);
      guestName = normalizeSnapshotText(body.guest_name, 'guest_name', 100);
      guestPhone = normalizeSnapshotText(body.guest_phone, 'guest_phone', 50);
      orderNotes = normalizeSnapshotText(body.notes, 'notes', 1000);
      discountReason = normalizeSnapshotText(body.discount_reason, 'discount_reason', 100);
      // expected_total: whole-rupiah safe integer ≥ 0, opsional (absent → null),
      // sama seperti create handler — termasuk dalam fingerprint sebagai
      // anti-stale harga.
      const etRaw = body.expected_total;
      if (etRaw !== undefined) {
        if (etRaw === null || !Number.isFinite(Number(etRaw))) {
          throw new Error('expected_total harus whole-rupiah integer ≥ 0 atau tidak dikirim');
        }
        const n = Number(etRaw);
        if (!Number.isSafeInteger(n) || n < 0) {
          throw new Error(`expected_total harus whole-rupiah integer ≥ 0 (diterima: ${JSON.stringify(etRaw)})`);
        }
        expectedTotal = n;
      }
    } catch (e: any) {
      res.status(400).json({
        status: 'ERROR', code: 'VALIDATION_ERROR', message: e.message,
      });
      return;
    }

    const userId: number | undefined = (req as any).user?.id;

    // ── 2. Property scope guard ────────────────────────────────────────────
    try {
      await deps.assertPropertyScope(req, propertyId);
    } catch (e: any) {
      res.status(e?.statusCode ?? 403).json({
        status: 'ERROR', code: e?.code ?? 'SCOPE_DENIED',
        message: e?.message ?? 'property scope denied',
      });
      return;
    }

    // ── 3. Jika ada diskon → cek permission (fail-closed) ─────────────────
    // Cek apakah payload mengandung diskon yang memerlukan permission.
    // Jika userId tidak tersedia → tolak (fail-closed): karena PUT dengan
    // diskon memerlukan identity yang terotorisasi.
    const hasDiscountInPayload =
      (orderDiscountType !== null && orderDiscountType !== undefined) ||
      (orderDiscountValue !== null && orderDiscountValue !== undefined) ||
      (rawItems?.some((it: any) =>
        (it?.discount_value != null && Number(it.discount_value) > 0) ||
        (it?.discount_type && it.discount_value != null && Number(it.discount_value) > 0)
      ) ?? false);

    if (hasDiscountInPayload) {
      if (userId == null) {
        res.status(403).json({
          status: 'ERROR', code: 'AUTH_REQUIRED_FOR_DISCOUNT',
          message: 'Diskon memerlukan user terotorisasi — user tidak tersedia'
        });
        return;
      }
      const hasPerm = await deps.checkDiscountPermission(deps.pool, userId, propertyId);
      if (!hasPerm) {
        res.status(403).json({
          status: 'ERROR', code: 'DISCOUNT_PERMISSION_DENIED',
          message: 'User tidak memiliki permission pos.discount.edit untuk properti ini'
        });
        return;
      }
    }

    const client = await deps.connect();
    let txnActive = false;

    try {
      await client.query('BEGIN');
      txnActive = true;

      // ── 4. Lock & baca parent order FOR UPDATE ───────────────────────────
      const orderRes = await client.query(
        `SELECT id, property_id, status, version, total_amount,
                discount_type, discount_value, discount_reason, discount_amount,
                service_charge_percent_snapshot, tax_percent_snapshot,
                service_charge_enabled_snapshot, tax_enabled_snapshot,
                service_amount, tax_amount
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

      // Property scope DB-level
      if (Number(orderRow.property_id) !== propertyId) {
        await client.query('ROLLBACK');
        txnActive = false;
        res.status(403).json({
          status: 'ERROR', code: 'CROSS_PROPERTY_ORDER',
          message: 'POS order bukan milik properti ini',
        });
        return;
      }

      // ── 5. Idempotency replay check (multi-siklus) ───────────────────────
      // WAJIB diperiksa SEBELUM status gate & version check:
      // retry identik yang sudah sukses di siklus sebelumnya (order
      // mungkin sudah menjadi PAID/VOIDED setelahnya) harus mengembalikan
      // hasil historis tanpa mutasi ulang — bukan 409.
      // Status gate & financial gate tetap berlaku untuk request BARU
      // (tanpa record idempotency): PAID/VOIDED → 409 ORDER_NOT_OPEN,
      // artefak finansial → 409 FINANCIAL_LOCK.
      //
      // Fingerprint (satu helper, buildEditFingerprintPayload) mencakup seluruh
      // field editable: expected_version, identitas item existing
      // (it.id — sama dengan GET detail), item baru, metadata tamu/order
      // (tri-state omitted vs explicit null), diskon, dan expected_total.
      //
      // Key sama + fingerprint sama  → 200 REPLAY (resulting_version/total tersimpan)
      // Key sama + fingerprint beda  → 409 IDEMPOTENCY_KEY_CONFLICT
      //
      // Replay tetap menghormati property scope: query idempotency selalu
      // terfilter property_id (unique constraint tabel), dan check
      // DB-level sebelumnya menolak CROSS_PROPERTY_ORDER. Replay identik
      // adalah read-only: tidak menyentuh order, item, atau status apa pun.

      {
        const fingerprint = computeEditFingerprint({
          expected_version: expectedVersion,
          raw_items: rawItems,
          table_number: tableNumber,
          guest_name: guestName,
          guest_phone: guestPhone,
          notes: orderNotes,
          discount_reason: discountReason,
          order_discount_type: orderDiscountType ?? null,
          order_discount_value: orderDiscountValue,
          expected_total: expectedTotal,
        });

        const idemRes = await client.query(
          `SELECT id, request_fingerprint, resulting_version, resulting_total
           FROM pos_order_edit_requests
           WHERE property_id = $1 AND pos_order_id = $2 AND idempotency_key = $3`,
          [propertyId, orderId, editIdempotencyKey]
        );

        if ((idemRes.rowCount ?? 0) > 0) {
          const existing = idemRes.rows[0];
          if (String(existing.request_fingerprint) === fingerprint) {
            // REPLAY — kembalikan hasil tersimpan, tanpa mutasi.
            // Status order saat ini (mungkin sudah PAID) TIDAK diubah.
            await client.query('COMMIT');
            txnActive = false;
            res.json({
              status: 'OK',
              data: {
                order: {
                  id: orderId,
                  total_amount: Number(existing.resulting_total),
                  version: Number(existing.resulting_version),
                },
                replayed: true,
                idempotency_key: editIdempotencyKey,
              },
            });
            return;
          }
          // Key sama, fingerprint beda → 409 (payload edit berbeda).
          await client.query('ROLLBACK');
          txnActive = false;
          res.status(409).json({
            status: 'ERROR', code: 'IDEMPOTENCY_KEY_CONFLICT',
            message: 'Idempotency-Key sudah dipakai untuk payload edit berbeda',
          });
          return;
        }
      }

      // ── 5b. Status gate (hanya untuk request BARU — replay sudah di atas) ─
      const currentStatus = String(orderRow.status || '').toUpperCase();
      if (currentStatus !== 'OPEN') {
        await client.query('ROLLBACK');
        txnActive = false;
        res.status(409).json({
          status: 'ERROR', code: 'ORDER_NOT_OPEN',
          message: `POS order status ${currentStatus} — hanya order OPEN yang dapat diupdate`,
        });
        return;
      }

      // ── 5c. Artefak finansial gate (request BARU) ─────────────────────────
      {
        const txnRes = await client.query(
          `SELECT COUNT(*)::int AS n
           FROM transactions
           WHERE (source_type IN ('POS_ORDER','POS') AND source_id = $1)
              OR reversal_of_transaction_id = $2
           LIMIT 1`,
          [String(orderId), String(orderId)]
        );
        const hasFinancial = Number(txnRes.rows[0]?.n ?? 0) > 0;
        if (hasFinancial) {
          await client.query('ROLLBACK');
          txnActive = false;
          res.status(409).json({
            status: 'ERROR', code: 'FINANCIAL_LOCK',
            message: 'POS order memiliki transaksi finansial — tidak dapat diedit',
          });
          return;
        }
        const settleRes = await client.query(
          `SELECT COUNT(*)::int AS n FROM pos_settlements WHERE pos_order_id = $1`,
          [orderId]
        );
        if (Number(settleRes.rows[0]?.n ?? 0) > 0) {
          await client.query('ROLLBACK');
          txnActive = false;
          res.status(409).json({
            status: 'ERROR', code: 'FINANCIAL_LOCK',
            message: 'POS order memiliki settlement — tidak dapat diedit',
          });
          return;
        }
      }

      // ── 6. Version check (optimistic concurrency, request BARU) ──────────
      const dbVersion = Number(orderRow.version ?? 1);
      if (dbVersion !== expectedVersion) {
        await client.query('ROLLBACK');
        txnActive = false;
        res.status(409).json({
          status: 'ERROR', code: 'ORDER_VERSION_CONFLICT',
          message: `Versi order tidak cocok: expected_version=${expectedVersion}, actual version=${dbVersion}. Reload dan coba lagi.`,
        });
        return;
      }

      // ── 7. Baca items existing (untuk diff) ──────────────────────────────
      const existingItemsRes = await client.query(
        `SELECT id, menu_item_id, quantity, unit_price,
                discount_type, discount_value, discount_amount,
                notes
         FROM pos_order_items
         WHERE order_id = $1
         ORDER BY id ASC`,
        [orderId]
      );
      const existingItems: Array<{
        id: number;
        menu_item_id: number | null;
        quantity: number;
        unit_price: number;
        discount_type: string | null;
        discount_value: number | null;
        notes: string | null;
      }> = existingItemsRes.rows.map((r: any) => ({
        id: Number(r.id),
        menu_item_id: r.menu_item_id == null ? null : Number(r.menu_item_id),
        quantity: Number(r.quantity),
        unit_price: Number(r.unit_price),
        discount_type: r.discount_type,
        discount_value: r.discount_value == null ? null : Number(r.discount_value),
        notes: r.notes,
      }));

      // ── 8. Validasi payload items ───────────────────────────────────────
      // Jika items dikirim, validasi:
      //  - item ID baru (tidak ada di existing) → cek is_active=true + harga DB
      //  - item existing → pertahankan unit_price snapshot
      //  - item yang TIDAK ada di payload → dihapus (DELETE)
      type ItemPayload = {
        itemId?: number;         // pos_order_items.id untuk item existing
        menuItemId: number;
        quantity: number;
        discountType: 'NOMINAL' | 'PERCENT' | null;
        discountValue: number | null;
        notes: string | null;
        isNew: boolean;
        unitPrice: number;       // dari snapshot lama (existing) atau DB (baru)
        // Snapshot identitas menu — diisi HANYA untuk item baru, bersumber
        // dari DB (pos_menu_items) dengan property scope, bukan payload.
        // item_name_snapshot NOT NULL → wajib ada saat INSERT item baru.
        itemNameSnapshot: string | null;
        itemCodeSnapshot: string | null;
      };

      const newItems: ItemPayload[] = [];
      const payloadItemIds: Set<number> = new Set();

      if (rawItems !== undefined) {
        if (rawItems.length === 0) {
          res.status(400).json({
            status: 'ERROR', code: 'VALIDATION_ERROR',
            message: 'items=[] tidak diperbolehkan. Untuk mempertahankan seluruh item existing tanpa perubahan, jangan kirim field items. Untuk mengedit item, kirim daftar item lengkap yang akan dipertahankan.'
          });
          // ROLLBACK will be called in catch block or below
          // Actually we're in the main flow, ROLLBACK manually:
          await client.query('ROLLBACK');
          txnActive = false;
          return;
        }

        for (let i = 0; i < rawItems.length; i++) {
          const it = rawItems[i] as any;

          // menu_item_id
          const mmiRaw = it.menu_item_id ?? it.menuItemId;
          if (mmiRaw === undefined || mmiRaw === null) {
            res.status(400).json({
              status: 'ERROR', code: 'VALIDATION_ERROR',
              message: `items[${i}].menu_item_id is required`
            });
            await client.query('ROLLBACK');
            txnActive = false;
            return;
          }
          const mmi = Number(mmiRaw);
          if (!Number.isInteger(mmi) || mmi <= 0) {
            res.status(400).json({
              status: 'ERROR', code: 'VALIDATION_ERROR',
              message: `items[${i}].menu_item_id must be positive integer`
            });
            await client.query('ROLLBACK');
            txnActive = false;
            return;
          }

          // quantity
          const qtyRaw = it.quantity ?? 1;
          const qty = Number(qtyRaw);
          if (!Number.isInteger(qty) || qty <= 0 || qty > 9999) {
            res.status(400).json({
              status: 'ERROR', code: 'VALIDATION_ERROR',
              message: `items[${i}].quantity must be integer 1..9999`
            });
            await client.query('ROLLBACK');
            txnActive = false;
            return;
          }

          // discount
          let disType: 'NOMINAL' | 'PERCENT' | null = null;
          let disVal: number | null = null;
          if (it.discount_type !== undefined && it.discount_type !== null) {
            if (it.discount_type !== 'NOMINAL' && it.discount_type !== 'PERCENT') {
              res.status(400).json({
                status: 'ERROR', code: 'VALIDATION_ERROR',
                message: `items[${i}].discount_type must be 'NOMINAL' or 'PERCENT'`
              });
              await client.query('ROLLBACK');
              txnActive = false;
              return;
            }
            disType = it.discount_type;
          }
          if (it.discount_value !== undefined && it.discount_value !== null) {
            if (!isDiscountValue(it.discount_value, disType)) {
              res.status(400).json({
                status: 'ERROR', code: 'VALIDATION_ERROR',
                message: `items[${i}].discount_value invalid`
              });
              await client.query('ROLLBACK');
              txnActive = false;
              return;
            }
            disVal = Number(it.discount_value);
          }
          // Pasangan diskon per item harus lengkap: type+value bersama, atau
          // keduanya absen. Hanya salah satu → tolak (sama seperti create
          // handler: `(itDisType === null) !== (itDisVal === null)`).
          if ((disType !== null || disVal !== null) && (disType === null) !== (disVal === null)) {
            res.status(400).json({
              status: 'ERROR', code: 'VALIDATION_ERROR',
              message: `items[${i}]: discount_type dan discount_value harus dikirim berpasangan`
            });
            await client.query('ROLLBACK');
            txnActive = false;
            return;
          }

          // notes
          const notes: string | null =
            typeof it.notes === 'string' && it.notes.trim() !== '' ? it.notes.trim() : null;

          const isExisting: boolean =
            it.id !== undefined && it.id !== null &&
            Number.isInteger(Number(it.id));
          const itemId: number | undefined = isExisting ? Number(it.id) : undefined;

          let unitPrice: number;
          let isNew: boolean;
          // Snapshot identitas menu — hanya terisi untuk item baru (dari DB).
          let itemNameSnapshot: string | null = null;
          let itemCodeSnapshot: string | null = null;

          if (itemId !== undefined) {
            // Item existing — cari di existing items
            const found = existingItems.find((e) => e.id === itemId);
            if (!found) {
              res.status(400).json({
                status: 'ERROR', code: 'ITEM_NOT_FOUND',
                message: `items[${i}].id=${itemId} tidak ditemukan di order ini`
              });
              await client.query('ROLLBACK');
              txnActive = false;
              return;
            }
            // Item existing → pertahankan unit_price snapshot
            unitPrice = found.unit_price;
            isNew = false;
            payloadItemIds.add(itemId);
          } else {
            // Item baru → cek is_active + is_sellable_pos + harga & snapshot identitas dari DB
            const menuItemRes = await client.query(
              `SELECT id, price, is_active, is_sellable_pos, name, item_code FROM pos_menu_items
               WHERE id = $1 AND property_id = $2`,
              [mmi, propertyId]
            );
            if ((menuItemRes.rowCount ?? 0) === 0) {
              res.status(400).json({
                status: 'ERROR', code: 'MENU_ITEM_NOT_FOUND',
                message: `items[${i}].menu_item_id=${mmi} tidak ditemukan atau bukan milik properti ini`
              });
              await client.query('ROLLBACK');
              txnActive = false;
              return;
            }
            const miRow = menuItemRes.rows[0];
            if (miRow.is_active === false || miRow.is_active === 'false') {
              res.status(400).json({
                status: 'ERROR', code: 'INACTIVE_ITEM',
                message: `items[${i}]: menu item ${mmi} tidak aktif — tidak dapat ditambahkan`
              });
              await client.query('ROLLBACK');
              txnActive = false;
              return;
            }
            if (miRow.is_sellable_pos === false || miRow.is_sellable_pos === 'false') {
              res.status(400).json({
                status: 'ERROR', code: 'MENU_ITEM_NOT_SELLABLE',
                message: `items[${i}]: menu item ${mmi} tidak dijual di POS (produk internal) — tidak dapat ditambahkan`
              });
              await client.query('ROLLBACK');
              txnActive = false;
              return;
            }
            const parsedMenuPrice = miRow.price === null || miRow.price === undefined ? NaN : Number(miRow.price);
            if (!Number.isFinite(parsedMenuPrice) || parsedMenuPrice < 0 || !Number.isSafeInteger(parsedMenuPrice)) {
              res.status(400).json({
                status: 'ERROR', code: 'MENU_ITEM_PRICE_INVALID',
                message: `items[${i}]: menu item ${mmi} tidak memiliki harga jual POS yang valid`
              });
              await client.query('ROLLBACK');
              txnActive = false;
              return;
            }
            unitPrice = parsedMenuPrice;
            isNew = true;
            // Snapshot identitas menu berasal dari row DB yang sudah
            // dipastikan milik properti ini (WHERE property_id = $2).
            // pos_menu_items.name NOT NULL → item_name_snapshot terjamin terisi.
            itemNameSnapshot = miRow.name;
            itemCodeSnapshot = miRow.item_code ?? null;
          }

          newItems.push({
            itemId,
            menuItemId: mmi,
            quantity: qty,
            discountType: disType,
            discountValue: disVal,
            notes,
            isNew,
            unitPrice,
            itemNameSnapshot,
            itemCodeSnapshot,
          });
        }
      }

      // ── 9. Hitung item diff ──────────────────────────────────────────────
      // Items yang dihapus: ada di existing, TIDAK ada di payload.
      // PENTING: bila rawItems === undefined (klien TIDAK mengirim items),
      // seluruh item existing DIPERTAHANKAN — tidak ada yang dihapus.
      // Tanpa guard ini, payloadItemIds yang kosong akan membuat semua item
      // existing tampak "hilang" (kandidat DELETE).
      const deleteIds: number[] = rawItems === undefined
        ? []
        : existingItems
            .filter((e) => !payloadItemIds.has(e.id))
            .map((e) => e.id);

      // Items yang di-UPDATE: ada di payload dengan itemId (existing)
      const updateItems = newItems.filter((it) => it.itemId !== undefined);

      // Items yang di-INSERT: item baru
      const insertItems = newItems.filter((it) => it.isNew);

      // ── 10. Baca pricing snapshot dari order lama ───────────────────────
      const svcPercentSnapshot = Number(orderRow.service_charge_percent_snapshot ?? 0);
      const taxPercentSnapshot = Number(orderRow.tax_percent_snapshot ?? 0);
      const svcEnabledSnapshot = orderRow.service_charge_enabled_snapshot === true || orderRow.service_charge_enabled_snapshot === 'true';
      const taxEnabledSnapshot = orderRow.tax_enabled_snapshot === true || orderRow.tax_enabled_snapshot === 'true';

      // ── 11. Jalankan item diff (DELETE → UPDATE → INSERT) ───────────────
      if (rawItems !== undefined) {
        // DELETE items yang hilang
        if (deleteIds.length > 0) {
          const delValues = deleteIds.map((_, i) => `$${i + 1}`).join(', ');
          await client.query(
            `DELETE FROM pos_order_items WHERE id IN (${delValues})`,
            deleteIds
          );
        }

        // UPDATE items existing
        for (const it of updateItems) {
          await client.query(
            `UPDATE pos_order_items
             SET quantity = $1,
                 discount_type = $2,
                 discount_value = $3,
                 notes = $4
             WHERE id = $5 AND order_id = $6`,
            [
              it.quantity,
              it.discountType,
              it.discountValue,
              it.notes,
              it.itemId!,
              orderId,
            ]
          );
        }

        // INSERT items baru
        for (const it of insertItems) {
          await client.query(
            `INSERT INTO pos_order_items
               (order_id, menu_item_id, quantity, unit_price, discount_type, discount_value, notes,
                item_name_snapshot, item_code_snapshot)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id`,
            [
              orderId,
              it.menuItemId,
              it.quantity,
              it.unitPrice,
              it.discountType,
              it.discountValue,
              it.notes,
              it.itemNameSnapshot,
              it.itemCodeSnapshot,
            ]
          );
        }
      }

      // ── 12. Update order-level discount ──────────────────────────────────
      const orderDiscountSet: string[] = [];
      const orderDiscountVals: unknown[] = [];
      let oi = 0;
      if (orderDiscountType !== undefined) {
        oi++;
        orderDiscountSet.push(`discount_type = $${oi}`);
        orderDiscountVals.push(orderDiscountType);
      }
      if (orderDiscountValue !== undefined) {
        oi++;
        orderDiscountSet.push(`discount_value = $${oi}`);
        orderDiscountVals.push(orderDiscountValue);
      }
      if (orderDiscountSet.length > 0) {
        oi++;
        orderDiscountSet.push(`updated_at = NOW()`);
        orderDiscountVals.push(orderId);
        await client.query(
          `UPDATE pos_orders SET ${orderDiscountSet.join(', ')} WHERE id = $${oi}`,
          orderDiscountVals
        );
      }

      // ── 12a. Update metadata order (persist tri-state) ───────────────────
      // undefined (omitted) → kolom TIDAK dimasukkan ke SET (nilai existing
      // dipertahankan). null → SET NULL (hapus nilai). string → nilai hasil
      // trim (validasi panjang sudah dilakukan di awal). Satu UPDATE
      // terparameterisasi, dalam transaksi yang sama, sebelum COMMIT.
      {
        const metadataSet: string[] = [];
        const metadataVals: unknown[] = [];
        let mi = 0;
        const pushMeta = (col: string, val: string | null | undefined): void => {
          if (val !== undefined) {
            mi++;
            metadataSet.push(`${col} = $${mi}`);
            metadataVals.push(val);
          }
        };
        pushMeta('table_number', tableNumber);
        pushMeta('guest_name', guestName);
        pushMeta('guest_phone', guestPhone);
        pushMeta('notes', orderNotes);
        pushMeta('discount_reason', discountReason);
        if (metadataSet.length > 0) {
          mi++;
          metadataSet.push(`updated_at = NOW()`);
          metadataVals.push(orderId);
          await client.query(
            `UPDATE pos_orders SET ${metadataSet.join(', ')} WHERE id = $${mi}`,
            metadataVals
          );
        }
      }

      // ── 13. Hitung ulang total via computePosPricing() ───────────────────
      // Baca items hasil update (setelah semua mutasi)
      const finalItemsRes = await client.query(
        `SELECT id, quantity, unit_price, discount_type, discount_value
         FROM pos_order_items
         WHERE order_id = $1
         ORDER BY id ASC`,
        [orderId]
      );

      // Order discount efektif (jika diubah, pakai nilai baru; jika tidak, pakai lama)
      const effOrderDisType: 'NOMINAL' | 'PERCENT' | null =
        orderDiscountType !== undefined ? orderDiscountType : orderRow.discount_type;
      const effOrderDisVal: number | null =
        orderDiscountValue !== undefined ? orderDiscountValue :
          (orderRow.discount_value == null ? null : Number(orderRow.discount_value));

      // Item-level discount amount untuk pricing calculation
      const finalItemsForPricing = finalItemsRes.rows.map((r: any) => ({
        quantity: Number(r.quantity),
        unitPrice: Number(r.unit_price),
        discountType: r.discount_type as 'NOMINAL' | 'PERCENT' | null,
        discountValue: r.discount_value == null ? null : Number(r.discount_value),
      }));

      let pricing;
      try {
        pricing = computePosPricing({
          items: finalItemsForPricing,
          orderDiscountType: effOrderDisType,
          orderDiscountValue: effOrderDisVal,
          serviceChargeEnabled: svcEnabledSnapshot,
          serviceChargePercent: svcPercentSnapshot,
          taxEnabled: taxEnabledSnapshot,
          taxPercent: taxPercentSnapshot,
        });
      } catch (pricingErr: any) {
        await client.query('ROLLBACK');
        txnActive = false;
        res.status(400).json({
          status: 'ERROR',
          code: pricingErr instanceof PosPricingError ? pricingErr.code : 'PRICING_ERROR',
          message: pricingErr.message,
        });
        return;
      }

      const newTotal = pricing.totalAmount;

      // ── 13a. Expected total guard (anti-stale harga) ─────────────────────
      // Bila klien mengirim expected_total, bandingkan dengan total canonical
      // hasil computePosPricing. Mismatch → 409 PRICING_TOTAL_CHANGED TANPA
      // COMMIT: karena seluruh mutasi (item diff, order-level discount) berada
      // di transaksi ini, ROLLBACK memastikan order, item, discount_amount,
      // dan idempotency record tidak berubah parsial. Sumber kebenaran tetap
      // perhitungan backend — total dari frontend TIDAK dipercaya.
      // Absent (null) → perilaku existing tanpa memaksa field ini.
      if (expectedTotal !== null && expectedTotal !== newTotal) {
        await client.query('ROLLBACK');
        txnActive = false;
        res.status(409).json({
          status: 'CONFLICT',
          code: 'PRICING_TOTAL_CHANGED',
          message:
            'Total order tidak sesuai estimasi kasir. Pengaturan properti atau item mungkin telah berubah. ' +
            'Perbarui estimasi dan minta konfirmasi kasir.',
          data: {
            computed_total: newTotal,
            expected_total: expectedTotal,
            service_amount: pricing.serviceAmount,
            tax_amount: pricing.taxAmount,
            service_charge_percent: pricing.serviceChargePercentSnapshot,
            tax_percent: pricing.taxPercentSnapshot,
            service_charge_enabled: pricing.serviceChargeEnabledSnapshot,
            tax_enabled: pricing.taxEnabledSnapshot,
            discounted_subtotal: pricing.discountedSubtotal,
          },
        });
        return;
      }

      // ── 14. Commit: update total, snapshot fields, version, idempotency ──
      const newVersion = dbVersion + 1;

      await client.query(
        `UPDATE pos_orders
         SET total_amount = $1,
             version = $2,
             service_amount = $3,
             tax_amount = $4,
             discount_amount = $5,
             updated_at = NOW()
         WHERE id = $6`,
        [
          newTotal,
          newVersion,
          pricing.serviceAmount,
          pricing.taxAmount,
          pricing.orderDiscountAmount,
          orderId,
        ]
      );

      // ── 14a. Snapshot discount_amount per item dari canonical pricing ────
      // Sumber tunggal: pricing.items[i].lineDiscountAmount (hasil
      // computePosPricing di atas) — TIDAK dihitung ulang di sini.
      // Indeks cocok: pricing.items dibangun dari finalItemsForPricing yang
      // mengikuti urutan finalItemsRes.rows (ORDER BY id ASC), sehingga
      // pricing.items[i] ↔ finalItemsRes.rows[i].
      // Hanya dijalankan bila klien mengirim items (rawItems !== undefined):
      // saat tidak ada perubahan item, discount_amount existing TIDAK ditulis
      // ulang. Seluruh penulisan berada dalam transaksi ini, sebelum COMMIT.
      if (rawItems !== undefined) {
        if (pricing.items.length !== finalItemsRes.rows.length) {
          // Invariant internal: jumlah baris pricing harus sama dengan jumlah
          // item aktual. Tidak diharapkan terjadi; fail-closed tanpa COMMIT.
          await client.query('ROLLBACK');
          txnActive = false;
          res.status(422).json({
            status: 'ERROR', code: 'ITEM_SNAPSHOT_MISMATCH',
            message: 'Jumlah item pricing tidak selaras dengan item order'
          });
          return;
        }
        for (let i = 0; i < pricing.items.length; i++) {
          await client.query(
            `UPDATE pos_order_items
             SET discount_amount = $1
             WHERE id = $2 AND order_id = $3`,
            [
              pricing.items[i].lineDiscountAmount,
              finalItemsRes.rows[i].id,
              orderId,
            ]
          );
        }
      }

      // Simpan record idempotency — fingerprint WAJIB identik dengan step 5.
      // Memakai helper yang sama (computeEditFingerprint) dengan argumen
      // identik, sehingga replay berikutnya selalu cocok.
      {
        const fingerprint = computeEditFingerprint({
          expected_version: expectedVersion,
          raw_items: rawItems,
          table_number: tableNumber,
          guest_name: guestName,
          guest_phone: guestPhone,
          notes: orderNotes,
          discount_reason: discountReason,
          order_discount_type: orderDiscountType ?? null,
          order_discount_value: orderDiscountValue,
          expected_total: expectedTotal,
        });
        await client.query(
          `INSERT INTO pos_order_edit_requests
             (property_id, pos_order_id, idempotency_key, request_fingerprint, resulting_version, resulting_total)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [propertyId, orderId, editIdempotencyKey, fingerprint, newVersion, newTotal]
        );
      }

      await client.query('COMMIT');
      txnActive = false;

      // ── 15. Response ──────────────────────────────────────────────────────
      res.json({
        status: 'OK',
        data: {
          order: {
            id: orderId,
            total_amount: newTotal,
            version: newVersion,
          },
          replayed: false,
          idempotency_key: editIdempotencyKey,
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

import type { Pool, PoolClient } from 'pg';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import { hasPermission } from '../auth/authMiddleware';
import {
  parseStrictDecimalString,
  parseCanonicalQuantityInput,
  convertPackagingToBaseQuantity,
} from './productUnitsAndLocations';

// ─────────────────────────────────────────────────────────────────────────────
// Types & Interfaces
// ─────────────────────────────────────────────────────────────────────────────

export interface RecordOpeningBalanceParams {
  property_id: number;
  product_id: number;
  location_id: number;
  quantity: string | number;
  packaging_id?: number | null;
  unit_cost?: string | number | null;
  operation_key: string;
  created_by?: number | null;
  cutover_id?: number | null;
  notes?: string | null;
}

export interface OpeningBalanceResult {
  operation_id: number;
  operation_type: 'OPENING_BALANCE';
  operation_key: string;
  movement_id: number;
  property_id: number;
  product_id: number;
  location_id: number;
  quantity_delta: string;
  base_unit_code: string;
  packaging_id: number | null;
  packaging_code: string | null;
  packaging_label: string | null;
  unit_cost: string | null;
  current_balance: string;
  is_replay: boolean;
  notes?: string | null;
  created_at: string | Date;
}

export interface StockBalancesFilters {
  property_id: number;
  product_id?: number | null;
  location_id?: number | null;
  category_id?: number | null;
  search?: string | null;
  track_stock_only?: boolean;
}

export interface StockBalanceItem {
  id: number;
  property_id: number;
  product_id: number;
  product_name: string;
  product_item_code: string | null;
  canonical_base_unit_code: string | null;
  base_unit: string | null;
  track_stock: boolean;
  category_id: number | null;
  category_name: string | null;
  location_id: number;
  location_code: string;
  location_name: string;
  location_type: string;
  quantity: string;
  updated_at: string | Date;
}

export type StockPurchaseLineType = 'STOCK' | 'NON_STOCK_PHYSICAL' | 'SERVICE';

export interface ReceivedLineItemInput {
  line_id?: number | null;
  transaction_line_id?: number | null;
  product_id?: number | null;
  location_id?: number | null;
  quantity_received: string | number;
  packaging_id?: number | null;
}

export interface RecordPurchaseReceiptParams {
  property_id: number;
  transaction_id: number;
  location_id?: number | null;
  received_lines: ReceivedLineItemInput[];
  operation_key: string;
  created_by?: number | null;
  notes?: string | null;
}

export interface PurchaseLineBindingInput {
  transaction_line_id: number;
  line_type?: StockPurchaseLineType;
  product_id?: number | null;
  destination_location_id?: number | null;
  packaging_id?: number | null;
  ordered_quantity: string | number;
  received_quantity?: string | number;
  base_unit_code?: string;
}

export interface BindPurchaseLinesParams {
  property_id: number;
  transaction_id: number;
  lines: PurchaseLineBindingInput[];
}

export interface PurchaseReceiptMovement {
  id: number;
  product_id: number;
  location_id: number;
  packaging_id: number | null;
  packaging_code: string | null;
  packaging_label: string | null;
  quantity_delta: string;
  base_unit_code: string;
}

export interface PurchaseReceiptLineResult {
  transaction_line_id: number;
  line_type: StockPurchaseLineType;
  quantity_received: string;
  base_quantity_received?: string;
  product_id?: number | null;
  location_id?: number | null;
  packaging_id?: number | null;
}

export interface PurchaseReceiptResult {
  operation_id: number;
  operation_type: 'PURCHASE_RECEIPT';
  operation_key: string;
  transaction_id: number;
  receiving_status: string;
  received_at: string | Date | null;
  received_lines: PurchaseReceiptLineResult[];
  movements: PurchaseReceiptMovement[];
  is_replay: boolean;
  created_at: string | Date;
}

export interface PurchaseReceiptHistoryItem {
  operation_id: number;
  operation_key: string;
  operation_type: string;
  transaction_id: number;
  created_by: number | null;
  created_at: string | Date;
  notes: string | null;
  movements: Array<{
    id: number;
    product_id: number;
    product_name: string;
    location_id: number;
    location_code: string;
    quantity_delta: string;
    base_unit_code: string;
    packaging_id: number | null;
    packaging_code: string | null;
  }>;
}

export interface PurchaseReceiptsSummary {
  transaction_id: number;
  receiving_status: string | null;
  received_at: string | Date | null;
  bindings: Array<{
    id: number;
    transaction_line_id: number;
    line_type: StockPurchaseLineType;
    product_id: number | null;
    product_name: string | null;
    destination_location_id: number | null;
    location_code: string | null;
    packaging_id: number | null;
    packaging_code: string | null;
    ordered_quantity: string;
    received_quantity: string;
    base_unit_code: string;
  }>;
  receipts: PurchaseReceiptHistoryItem[];
}

export interface StockInventoryDeps {
  pool: Pool | any;
  assertPropertyScope: (req: any, propertyId: number) => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint & Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

export function computeStockOperationFingerprint(payload: {
  property_id: number;
  operation_type: string;
  product_id: number;
  location_id: number;
  quantity: string;
  packaging_id?: number | null;
  unit_cost?: string | null;
  cutover_id?: number | null;
}): string {
  const canonical = JSON.stringify({
    cutover_id: payload.cutover_id ?? null,
    location_id: Number(payload.location_id),
    operation_type: String(payload.operation_type).trim().toUpperCase(),
    packaging_id: payload.packaging_id ? Number(payload.packaging_id) : null,
    product_id: Number(payload.product_id),
    property_id: Number(payload.property_id),
    quantity: String(payload.quantity).trim(),
    unit_cost: payload.unit_cost !== null && payload.unit_cost !== undefined ? String(payload.unit_cost).trim() : null,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function computePurchaseReceiptFingerprint(payload: {
  property_id: number;
  transaction_id: number;
  received_lines: ReceivedLineItemInput[];
}): string {
  const sortedLines = [...payload.received_lines]
    .map((l) => ({
      line_id: Number(l.line_id ?? l.transaction_line_id),
      location_id: l.location_id ? Number(l.location_id) : null,
      packaging_id: l.packaging_id ? Number(l.packaging_id) : null,
      product_id: l.product_id ? Number(l.product_id) : null,
      quantity_received: String(l.quantity_received).trim(),
    }))
    .sort((a, b) => a.line_id - b.line_id);

  const canonical = JSON.stringify({
    operation_type: 'PURCHASE_RECEIPT',
    property_id: Number(payload.property_id),
    received_lines: sortedLines,
    transaction_id: Number(payload.transaction_id),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function invokeAssertPropertyScope(
  fn: StockInventoryDeps['assertPropertyScope'],
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
// 1. Service: Record Opening Balance (MP-04B R-01, R-04, R-05, R-06)
// ─────────────────────────────────────────────────────────────────────────────

export async function recordOpeningBalance(
  clientOrPool: Pool | PoolClient | any,
  params: RecordOpeningBalanceParams
): Promise<OpeningBalanceResult> {
  // Validasi parameter wajib
  const propertyId = Number(params.property_id);
  const productId = Number(params.product_id);
  const locationId = Number(params.location_id);
  const opKey = String(params.operation_key || '').trim();

  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw Object.assign(new Error('property_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!Number.isInteger(productId) || productId <= 0) {
    throw Object.assign(new Error('product_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!Number.isInteger(locationId) || locationId <= 0) {
    throw Object.assign(new Error('location_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!opKey) {
    throw Object.assign(new Error('operation_key wajib disertakan sebagai teks non-kosong'), {
      statusCode: 400,
      code: 'OPERATION_KEY_REQUIRED',
    });
  }
  if (opKey.length > 100) {
    throw Object.assign(new Error('operation_key maksimal 100 karakter'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  const isPool = typeof clientOrPool.connect === 'function';
  const client: PoolClient = isPool ? await clientOrPool.connect() : clientOrPool;

  try {
    if (isPool) {
      await client.query('BEGIN');
    }

    // ── Guard 1 & 2: Lock produk (FOR UPDATE) & periksa status track_stock & biaya persediaan saat ini ──
    const productRes = await client.query(
      `SELECT id, property_id, name, base_unit, canonical_base_unit_code, track_stock, is_active,
              (to_jsonb(pos_menu_items) ? 'average_cost') AS has_avg_cost_col,
              (to_jsonb(pos_menu_items) ? 'last_cost') AS has_last_cost_col,
              (to_jsonb(pos_menu_items) ? 'updated_at') AS has_updated_at_col,
              CASE
                WHEN (to_jsonb(pos_menu_items)->>'average_cost')::numeric IS NOT NULL AND (
                  (to_jsonb(pos_menu_items)->>'average_cost')::numeric > 0
                  OR (
                    (to_jsonb(pos_menu_items)->>'average_cost')::numeric = 0
                    AND EXISTS (
                      SELECT 1
                      FROM stock_movements sm_zero
                      WHERE sm_zero.property_id = pos_menu_items.property_id
                        AND sm_zero.product_id = pos_menu_items.id
                        AND sm_zero.unit_cost = 0
                        AND sm_zero.quantity_delta > 0
                        AND COALESCE((
                          SELECT SUM(sm_prev.quantity_delta)
                          FROM stock_movements sm_prev
                          WHERE sm_prev.property_id = sm_zero.property_id
                            AND sm_prev.product_id = sm_zero.product_id
                            AND (
                              sm_prev.created_at < sm_zero.created_at
                              OR (sm_prev.created_at = sm_zero.created_at AND sm_prev.id < sm_zero.id)
                            )
                        ), 0) <= 0
                        AND NOT EXISTS (
                          SELECT 1
                          FROM stock_movements sm_pos
                          WHERE sm_pos.property_id = sm_zero.property_id
                            AND sm_pos.product_id = sm_zero.product_id
                            AND sm_pos.unit_cost > 0
                            AND (
                              sm_pos.created_at > sm_zero.created_at
                              OR (sm_pos.created_at = sm_zero.created_at AND sm_pos.id > sm_zero.id)
                            )
                        )
                        AND NOT EXISTS (
                          SELECT 1
                          FROM stock_movements sm_unk
                          WHERE sm_unk.property_id = sm_zero.property_id
                            AND sm_unk.product_id = sm_zero.product_id
                            AND sm_unk.unit_cost IS NULL
                            AND sm_unk.quantity_delta > 0
                            AND (
                              sm_unk.created_at > sm_zero.created_at
                              OR (sm_unk.created_at = sm_zero.created_at AND sm_unk.id > sm_zero.id)
                            )
                            AND COALESCE((
                              SELECT SUM(sm_prev_unk.quantity_delta)
                              FROM stock_movements sm_prev_unk
                              WHERE sm_prev_unk.property_id = sm_unk.property_id
                                AND sm_prev_unk.product_id = sm_unk.product_id
                                AND (
                                  sm_prev_unk.created_at < sm_unk.created_at
                                  OR (sm_prev_unk.created_at = sm_unk.created_at AND sm_prev_unk.id < sm_unk.id)
                                )
                            ), 0) <= 0
                            AND NOT EXISTS (
                              SELECT 1
                              FROM stock_movements sm_tr_out
                              JOIN stock_operations so_tr
                                ON so_tr.id = sm_unk.operation_id
                               AND so_tr.property_id = sm_unk.property_id
                               AND so_tr.operation_type = 'STOCK_TRANSFER'
                              WHERE sm_tr_out.property_id = sm_unk.property_id
                                AND sm_tr_out.product_id = sm_unk.product_id
                                AND sm_tr_out.operation_id = sm_unk.operation_id
                                AND sm_tr_out.location_id <> sm_unk.location_id
                                AND sm_tr_out.unit_cost IS NULL
                                AND sm_tr_out.quantity_delta = -sm_unk.quantity_delta
                                AND sm_tr_out.id < sm_unk.id
                                AND NOT EXISTS (
                                  SELECT 1
                                  FROM stock_movements sm_mid
                                  WHERE sm_mid.property_id = sm_unk.property_id
                                    AND sm_mid.product_id = sm_unk.product_id
                                    AND sm_mid.id > sm_tr_out.id
                                    AND sm_mid.id < sm_unk.id
                                )
                            )
                        )
                    )
                  )
                ) THEN (to_jsonb(pos_menu_items)->>'average_cost')::numeric
                ELSE NULL
              END AS known_average_cost
         FROM pos_menu_items
        WHERE id = $1 AND property_id = $2
        FOR UPDATE`,
      [productId, propertyId]
    );

    if (productRes.rowCount === 0) {
      throw Object.assign(
        new Error(`Produk dengan id ${productId} tidak ditemukan pada properti ${propertyId}`),
        { statusCode: 404, code: 'PRODUCT_NOT_FOUND' }
      );
    }

    const product = productRes.rows[0];
    if (!product.is_active) {
      throw Object.assign(
        new Error(`Produk "${product.name}" sedang tidak aktif`),
        { statusCode: 400, code: 'PRODUCT_INACTIVE' }
      );
    }
    if (!product.track_stock) {
      throw Object.assign(
        new Error(`Produk "${product.name}" tidak dikonfigurasi untuk pencatatan stok (track_stock = false)`),
        { statusCode: 400, code: 'PRODUCT_STOCK_NOT_TRACKED' }
      );
    }

    const baseUnitCode = product.canonical_base_unit_code || product.base_unit;
    if (!baseUnitCode) {
      throw Object.assign(
        new Error(`Produk "${product.name}" belum memiliki satuan dasar yang terdefinisi`),
        { statusCode: 400, code: 'PRODUCT_BASE_UNIT_NOT_CONFIGURED' }
      );
    }

    // ── Validasi Lokasi Stok ──
    const locRes = await client.query(
      `SELECT id, property_id, code, name, location_type, is_active
         FROM stock_locations
        WHERE id = $1 AND property_id = $2`,
      [locationId, propertyId]
    );

    if (locRes.rowCount === 0) {
      throw Object.assign(
        new Error(`Lokasi stok dengan id ${locationId} tidak ditemukan pada properti ${propertyId}`),
        { statusCode: 404, code: 'LOCATION_NOT_FOUND' }
      );
    }

    const location = locRes.rows[0];
    if (!location.is_active) {
      throw Object.assign(
        new Error(`Lokasi stok "${location.name}" (${location.code}) sedang tidak aktif`),
        { statusCode: 400, code: 'LOCATION_INACTIVE' }
      );
    }

    // ── Validasi Cutover Window (jika ada) ──
    let cutoverId: number | null = null;
    if (params.cutover_id !== undefined && params.cutover_id !== null) {
      const parsedCutover = Number(params.cutover_id);
      if (!Number.isInteger(parsedCutover) || parsedCutover <= 0) {
        throw Object.assign(new Error('cutover_id harus berupa bilangan bulat positif'), {
          statusCode: 400,
          code: 'VALIDATION_ERROR',
        });
      }
      const cutoverRes = await client.query(
        `SELECT id, status FROM stock_cutover_windows WHERE id = $1 AND property_id = $2`,
        [parsedCutover, propertyId]
      );
      if (cutoverRes.rowCount === 0) {
        throw Object.assign(new Error(`Window cutover dengan id ${parsedCutover} tidak ditemukan`), {
          statusCode: 404,
          code: 'CUTOVER_WINDOW_NOT_FOUND',
        });
      }
      if (cutoverRes.rows[0].status !== 'OPEN') {
        throw Object.assign(new Error('Window cutover sudah berstatus tertutup (bukan OPEN)'), {
          statusCode: 400,
          code: 'CUTOVER_WINDOW_NOT_OPEN',
        });
      }
      cutoverId = parsedCutover;
    }

    // ── Validasi & Perhitungan Kuantitas (R-06: Dukungan Kemasan) ──
    let baseQuantityDelta: string;
    let packagingId: number | null = null;
    let packagingCode: string | null = null;
    let packagingLabel: string | null = null;
    let packagingToBaseFactor = 1;

    if (params.packaging_id !== undefined && params.packaging_id !== null) {
      const parsedPkgId = Number(params.packaging_id);
      if (!Number.isInteger(parsedPkgId) || parsedPkgId <= 0) {
        throw Object.assign(new Error('packaging_id harus berupa bilangan bulat positif'), {
          statusCode: 400,
          code: 'VALIDATION_ERROR',
        });
      }

      const pkgRes = await client.query(
        `SELECT id, property_id, menu_item_id, packaging_code, packaging_label,
                base_unit_code, to_base_factor, is_active
           FROM product_packaging_conversions
          WHERE id = $1 AND property_id = $2 AND menu_item_id = $3`,
        [parsedPkgId, propertyId, productId]
      );

      if (pkgRes.rowCount === 0) {
        throw Object.assign(new Error(`Kemasan konversi tidak ditemukan untuk produk ini`), {
          statusCode: 404,
          code: 'PACKAGING_NOT_FOUND',
        });
      }

      const pkg = pkgRes.rows[0];
      if (!pkg.is_active) {
        throw Object.assign(new Error(`Kemasan "${pkg.packaging_code}" sedang nonaktif`), {
          statusCode: 400,
          code: 'PACKAGING_INACTIVE',
        });
      }

      const conv = convertPackagingToBaseQuantity({
        packagingQty: params.quantity,
        toBaseFactor: pkg.to_base_factor,
        baseUnitCode: pkg.base_unit_code,
      });

      if (!conv.ok) {
        throw Object.assign(new Error(conv.error), { statusCode: conv.status, code: conv.code });
      }

      baseQuantityDelta = conv.formatted3;
      packagingId = Number(pkg.id);
      packagingCode = pkg.packaging_code;
      packagingLabel = pkg.packaging_label;
      const parsedFactor = parseFloat(String(pkg.to_base_factor));
      packagingToBaseFactor = Number.isFinite(parsedFactor) && parsedFactor > 0 ? parsedFactor : 1;
    } else {
      // Satuan dasar langsung (mendukung 0.000 untuk penguncian awal R-01)
      let parsedQty;
      if (product.canonical_base_unit_code) {
        parsedQty = parseCanonicalQuantityInput(params.quantity, product.canonical_base_unit_code, {
          allowZero: true,
          fieldLabel: 'Kuantitas saldo awal',
        });
      } else {
        parsedQty = parseStrictDecimalString(params.quantity, 'Kuantitas saldo awal');
        if (parsedQty.ok && parsedQty.milli < 0n) {
          throw Object.assign(new Error('Kuantitas saldo awal tidak boleh negatif'), {
            statusCode: 400,
            code: 'VALIDATION_ERROR',
          });
        }
      }

      if (!parsedQty.ok) {
        throw Object.assign(new Error(parsedQty.error), { statusCode: parsedQty.status, code: parsedQty.code });
      }

      baseQuantityDelta = parsedQty.formatted3;
    }

    // ── Validasi unit_cost (opsional via API umum, namun string kosong wajib ditolak) ──
    let formattedUnitCost: string | null = null;
    if (params.unit_cost !== undefined && params.unit_cost !== null) {
      if (typeof params.unit_cost === 'string' && params.unit_cost.trim() === '') {
        throw Object.assign(
          new Error('Biaya satuan (unit_cost) tidak boleh berupa string kosong; isi biaya perolehan yang valid (>= 0)'),
          { statusCode: 400, code: 'VALIDATION_ERROR' }
        );
      }
      const parsedCost = parseStrictDecimalString(params.unit_cost, 'Biaya satuan (unit_cost)');
      if (!parsedCost.ok) {
        throw Object.assign(new Error(parsedCost.error), { statusCode: parsedCost.status, code: parsedCost.code });
      }
      if (parsedCost.milli < 0n) {
        throw Object.assign(new Error('Biaya satuan (unit_cost) tidak boleh negatif'), {
          statusCode: 400,
          code: 'VALIDATION_ERROR',
        });
      }
      formattedUnitCost = (Number(parsedCost.milli) / 1000).toFixed(2);
    }

    const notes =
      params.notes !== undefined && params.notes !== null && String(params.notes).trim() !== ''
        ? String(params.notes).trim()
        : null;

    // ── Fingerprint Payload (R-05) ──
    const payloadFingerprint = computeStockOperationFingerprint({
      property_id: propertyId,
      operation_type: 'OPENING_BALANCE',
      product_id: productId,
      location_id: locationId,
      quantity: String(params.quantity).trim(),
      packaging_id: packagingId,
      unit_cost: formattedUnitCost,
      cutover_id: cutoverId,
    });

    // ── Idempotency Check (R-05) ──
    const existingOpRes = await client.query(
      `SELECT id, operation_type, operation_key, payload_fingerprint,
              (to_jsonb(stock_operations)->>'notes') AS notes,
              created_at
         FROM stock_operations
        WHERE property_id = $1 AND operation_key = $2`,
      [propertyId, opKey]
    );

    if (existingOpRes.rows.length > 0) {
      const existingOp = existingOpRes.rows[0];
      if (existingOp.payload_fingerprint === payloadFingerprint) {
        // Idempotent Replay: Muat data mutasi & saldo yang sudah tersimpan
        const replayRes = await client.query(
          `SELECT sm.id AS movement_id, sm.quantity_delta, sm.base_unit_code,
                  sm.packaging_id, sm.packaging_code, sm.packaging_label, sm.unit_cost, sm.created_at,
                  sb.quantity AS current_balance
             FROM stock_movements sm
             LEFT JOIN stock_balances sb ON sb.property_id = sm.property_id AND sb.product_id = sm.product_id AND sb.location_id = sm.location_id
            WHERE sm.operation_id = $1
            LIMIT 1`,
          [existingOp.id]
        );

        if (replayRes.rows.length > 0) {
          const replayRow = replayRes.rows[0];
          if (isPool) await client.query('COMMIT');
          return {
            operation_id: Number(existingOp.id),
            operation_type: 'OPENING_BALANCE',
            operation_key: existingOp.operation_key,
            movement_id: Number(replayRow.movement_id),
            property_id: propertyId,
            product_id: productId,
            location_id: locationId,
            quantity_delta: String(replayRow.quantity_delta),
            base_unit_code: replayRow.base_unit_code,
            packaging_id: replayRow.packaging_id ? Number(replayRow.packaging_id) : null,
            packaging_code: replayRow.packaging_code ?? null,
            packaging_label: replayRow.packaging_label ?? null,
            unit_cost: replayRow.unit_cost !== null ? String(replayRow.unit_cost) : null,
            current_balance: String(replayRow.current_balance ?? '0.000'),
            is_replay: true,
            notes: existingOp.notes ?? null,
            created_at: replayRow.created_at,
          };
        }
      } else {
        throw Object.assign(
          new Error(`operation_key "${opKey}" sudah digunakan dengan payload yang berbeda`),
          { statusCode: 409, code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH' }
        );
      }
    }

    // ── Guard 3: Tolak opening balance kedua pada (property_id, product_id, location_id) (R-04) ──
    const existingOpeningRes = await client.query(
      `SELECT so.id, so.operation_key, so.created_at
         FROM stock_operations so
         JOIN stock_movements sm ON sm.operation_id = so.id
        WHERE so.property_id = $1
          AND so.operation_type = 'OPENING_BALANCE'
          AND sm.product_id = $2
          AND sm.location_id = $3
        LIMIT 1`,
      [propertyId, productId, locationId]
    );

    if (existingOpeningRes.rows.length > 0) {
      throw Object.assign(
        new Error(
          `Saldo awal untuk produk id ${productId} pada lokasi id ${locationId} sudah pernah dicatat sebelumnya (operation_key: ${existingOpeningRes.rows[0].operation_key})`
        ),
        { statusCode: 409, code: 'STOCK_OPENING_ALREADY_EXISTS' }
      );
    }

    // ── Guard 4 & Perhitungan Biaya Pokok / Moving Average Cost Produk ──
    // Baca total saldo produk di seluruh lokasi properti SEBELUM mutasi ini dicatat
    const prevTotalStockRes = await client.query(
      `SELECT COALESCE(SUM(quantity), 0) AS total_qty
         FROM stock_balances
        WHERE property_id = $1 AND product_id = $2`,
      [propertyId, productId]
    );
    const prevTotalStock = parseFloat(prevTotalStockRes.rows[0]?.total_qty || '0') || 0;
    const incomingBaseQty = parseFloat(baseQuantityDelta) || 0;

    const hasKnownPrevAvgCost =
      product.known_average_cost !== null &&
      product.known_average_cost !== undefined &&
      String(product.known_average_cost).trim() !== '' &&
      Number.isFinite(Number(product.known_average_cost));
    const prevKnownAvgCost = hasKnownPrevAvgCost ? parseFloat(String(product.known_average_cost)) : null;

    if (Boolean(product.has_avg_cost_col) && prevTotalStock > 0 && incomingBaseQty > 0) {
      if (!hasKnownPrevAvgCost && formattedUnitCost !== null) {
        throw Object.assign(
          new Error(
            `Produk "${product.name}" sudah memiliki stok tercatat (${prevTotalStock.toFixed(3)} ${baseUnitCode}) tanpa biaya pokok terverifikasi (UNKNOWN). Biaya stok sebelumnya tidak boleh dianggap Rp0 secara diam-diam. Pastikan biaya stok yang sudah ada terlebih dahulu sebelum mencatat saldo awal berbiaya di lokasi lain.`
          ),
          { statusCode: 409, code: 'EXISTING_STOCK_COST_UNKNOWN' }
        );
      }
      if (hasKnownPrevAvgCost && formattedUnitCost === null) {
        throw Object.assign(
          new Error(
            `Produk "${product.name}" sudah memiliki stok tercatat dengan biaya rata-rata terverifikasi. Pencatatan saldo awal baru wajib menyertakan unit_cost yang diketahui agar valuasi tidak bias.`
          ),
          { statusCode: 409, code: 'OPENING_BALANCE_COST_REQUIRED_FOR_COSTED_PRODUCT' }
        );
      }
    }

    let nextAverageCostStr: string | null = null;
    let nextLastCostStr: string | null = null;
    const resetDepletedCostToUnknown =
      formattedUnitCost === null && prevTotalStock <= 0 && incomingBaseQty > 0;
    if (formattedUnitCost !== null) {
      const rawUnitCostNum = parseFloat(formattedUnitCost);
      const unitCostBase = packagingId !== null ? rawUnitCostNum / packagingToBaseFactor : rawUnitCostNum;
      nextLastCostStr = unitCostBase.toFixed(2);

      if (prevTotalStock <= 0) {
        nextAverageCostStr = unitCostBase.toFixed(2);
      } else if (incomingBaseQty > 0 && prevKnownAvgCost !== null) {
        const weightedAvg =
          (prevTotalStock * prevKnownAvgCost + incomingBaseQty * unitCostBase) /
          (prevTotalStock + incomingBaseQty);
        nextAverageCostStr = weightedAvg.toFixed(2);
      } else if (prevKnownAvgCost !== null) {
        nextAverageCostStr = prevKnownAvgCost.toFixed(2);
      } else {
        nextAverageCostStr = unitCostBase.toFixed(2);
      }
    }

    // ── Eksekusi Transaksi Atomik ──
    // 1. Insert header stock_operations
    const createdBy = params.created_by ? Number(params.created_by) : null;
    const hasOpNotesColRes = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'stock_operations'
            AND column_name = 'notes'
       ) AS has_notes,
       EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'pos_menu_items'
            AND column_name = 'average_cost'
            AND is_nullable = 'NO'
       ) AS avg_cost_not_null`
    );
    const hasOpNotesCol = Boolean(hasOpNotesColRes.rows[0]?.has_notes);
    const avgCostNotNull = Boolean(hasOpNotesColRes.rows[0]?.avg_cost_not_null);

    let opRow: any;
    if (hasOpNotesCol && notes !== null) {
      const opInsertRes = await client.query(
        `INSERT INTO stock_operations (
           property_id, operation_type, operation_key, payload_fingerprint, notes, created_by, created_at
         ) VALUES ($1, 'OPENING_BALANCE', $2, $3, $4, $5, NOW())
         RETURNING id, created_at`,
        [propertyId, opKey, payloadFingerprint, notes, createdBy]
      );
      opRow = opInsertRes.rows[0];
    } else {
      const opInsertRes = await client.query(
        `INSERT INTO stock_operations (
           property_id, operation_type, operation_key, payload_fingerprint, created_by, created_at
         ) VALUES ($1, 'OPENING_BALANCE', $2, $3, $4, NOW())
         RETURNING id, created_at`,
        [propertyId, opKey, payloadFingerprint, createdBy]
      );
      opRow = opInsertRes.rows[0];
    }

    // 2. Insert append-only stock_movements
    const movInsertRes = await client.query(
      `INSERT INTO stock_movements (
         operation_id, property_id, product_id, location_id,
         packaging_id, packaging_code, packaging_label,
         quantity_delta, base_unit_code, unit_cost, created_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7,
         $8, $9, $10, NOW()
       )
       RETURNING id, created_at`,
      [
        opRow.id,
        propertyId,
        productId,
        locationId,
        packagingId,
        packagingCode,
        packagingLabel,
        baseQuantityDelta,
        baseUnitCode,
        formattedUnitCost,
      ]
    );
    const movRow = movInsertRes.rows[0];

    // 3. Upsert proyeksi stock_balances
    const balUpsertRes = await client.query(
      `INSERT INTO stock_balances (
         property_id, product_id, location_id, quantity, updated_at
       ) VALUES (
         $1, $2, $3, $4, NOW()
       )
       ON CONFLICT (property_id, product_id, location_id)
       DO UPDATE SET
         quantity = stock_balances.quantity + EXCLUDED.quantity,
         updated_at = NOW()
       RETURNING quantity`,
      [propertyId, productId, locationId, baseQuantityDelta]
    );
    const balRow = balUpsertRes.rows[0];

    // 4. Perbarui biaya rata-rata kanonik produk (pos_menu_items.average_cost & last_cost) secara atomik
    if ((nextAverageCostStr !== null || resetDepletedCostToUnknown) && product.has_avg_cost_col) {
      const avgCostParam = resetDepletedCostToUnknown
        ? (avgCostNotNull ? '0.00' : null)
        : nextAverageCostStr;
      const setClauses: string[] = ['average_cost = $1'];
      const costParams: any[] = [avgCostParam];
      if (nextLastCostStr !== null && product.has_last_cost_col) {
        costParams.push(nextLastCostStr);
        setClauses.push(`last_cost = $${costParams.length}`);
      }
      if (product.has_updated_at_col) {
        setClauses.push('updated_at = NOW()');
      }
      costParams.push(productId, propertyId);
      await client.query(
        `UPDATE pos_menu_items
            SET ${setClauses.join(', ')}
          WHERE id = $${costParams.length - 1} AND property_id = $${costParams.length}`,
        costParams
      );
    }

    if (isPool) {
      await client.query('COMMIT');
    }

    return {
      operation_id: Number(opRow.id),
      operation_type: 'OPENING_BALANCE',
      operation_key: opKey,
      movement_id: Number(movRow.id),
      property_id: propertyId,
      product_id: productId,
      location_id: locationId,
      quantity_delta: baseQuantityDelta,
      base_unit_code: baseUnitCode,
      packaging_id: packagingId,
      packaging_code: packagingCode,
      packaging_label: packagingLabel,
      unit_cost: formattedUnitCost,
      current_balance: String(balRow.quantity),
      is_replay: false,
      notes,
      created_at: movRow.created_at,
    };
  } catch (error) {
    if (isPool) {
      try {
        await client.query('ROLLBACK');
      } catch {}
    }
    throw error;
  } finally {
    if (isPool) {
      client.release();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Service: Get Stock Balances
// ─────────────────────────────────────────────────────────────────────────────

export async function getStockBalances(
  clientOrPool: Pool | PoolClient | any,
  filters: StockBalancesFilters
): Promise<StockBalanceItem[]> {
  const propertyId = Number(filters.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw Object.assign(new Error('property_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  const conditions: string[] = ['sb.property_id = $1'];
  const params: any[] = [propertyId];

  if (filters.product_id !== undefined && filters.product_id !== null) {
    const pid = Number(filters.product_id);
    if (Number.isInteger(pid) && pid > 0) {
      params.push(pid);
      conditions.push(`sb.product_id = $${params.length}`);
    }
  }

  if (filters.location_id !== undefined && filters.location_id !== null) {
    const lid = Number(filters.location_id);
    if (Number.isInteger(lid) && lid > 0) {
      params.push(lid);
      conditions.push(`sb.location_id = $${params.length}`);
    }
  }

  if (filters.category_id !== undefined && filters.category_id !== null) {
    const cid = Number(filters.category_id);
    if (Number.isInteger(cid) && cid > 0) {
      params.push(cid);
      conditions.push(`pmi.category_id = $${params.length}`);
    }
  }

  if (filters.track_stock_only) {
    conditions.push(`pmi.track_stock = TRUE`);
  }

  if (filters.search !== undefined && filters.search !== null && String(filters.search).trim() !== '') {
    params.push(`%${String(filters.search).trim()}%`);
    const idx = params.length;
    conditions.push(`(pmi.name ILIKE $${idx} OR pmi.item_code ILIKE $${idx} OR sl.name ILIKE $${idx} OR sl.code ILIKE $${idx})`);
  }

  const query = `
    SELECT
      sb.id,
      sb.property_id,
      sb.product_id,
      pmi.name AS product_name,
      pmi.item_code AS product_item_code,
      pmi.canonical_base_unit_code,
      pmi.base_unit,
      pmi.track_stock,
      pmi.category_id,
      pmc.name AS category_name,
      sb.location_id,
      sl.code AS location_code,
      sl.name AS location_name,
      sl.location_type,
      sb.quantity::text AS quantity,
      sb.updated_at
    FROM stock_balances sb
    JOIN pos_menu_items pmi ON pmi.id = sb.product_id AND pmi.property_id = sb.property_id
    JOIN stock_locations sl ON sl.id = sb.location_id AND sl.property_id = sb.property_id
    LEFT JOIN pos_menu_categories pmc ON pmc.id = pmi.category_id AND pmc.property_id = sb.property_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY pmi.name ASC, sl.code ASC;
  `;

  const res = await clientOrPool.query(query, params);
  return (res.rows || []).map((row: any) => ({
    id: Number(row.id),
    property_id: Number(row.property_id),
    product_id: Number(row.product_id),
    product_name: String(row.product_name || ''),
    product_item_code: row.product_item_code ?? null,
    canonical_base_unit_code: row.canonical_base_unit_code ?? null,
    base_unit: row.base_unit ?? null,
    track_stock: Boolean(row.track_stock),
    category_id: row.category_id ? Number(row.category_id) : null,
    category_name: row.category_name ?? null,
    location_id: Number(row.location_id),
    location_code: String(row.location_code || ''),
    location_name: String(row.location_name || ''),
    location_type: String(row.location_type || ''),
    quantity: String(row.quantity ?? '0.000'),
    updated_at: row.updated_at,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Express Route Handlers
// ─────────────────────────────────────────────────────────────────────────────

export function createStockOpeningBalanceHandler(deps: StockInventoryDeps) {
  return async function handleStockOpeningBalance(req: Request, res: Response) {
    try {
      const propertyId = Number(req.body?.property_id ?? req.query?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib berupa bilangan bulat positif',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      // Guard izin operasional: inventory.create atau inventory.edit
      const authUser = (req as any).user;
      if (authUser) {
        const canWrite =
          (await hasPermission(authUser, 'inventory.create', deps.pool)) ||
          (await hasPermission(authUser, 'inventory.edit', deps.pool));
        if (!canWrite) {
          return res.status(403).json({
            status: 'ERROR',
            code: 'FORBIDDEN',
            message: 'Akses ditolak: Memerlukan izin operasional inventory.create atau inventory.edit',
          });
        }
      }

      const {
        product_id,
        location_id,
        quantity,
        packaging_id,
        unit_cost,
        cutover_id,
        notes,
      } = req.body || {};

      const headerKey =
        (typeof req.headers?.['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null) ||
        (typeof req.headers?.['x-idempotency-key'] === 'string' ? req.headers['x-idempotency-key'] : null);
      const opKey = String(headerKey || req.body?.operation_key || '').trim();
      if (!opKey) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'OPERATION_KEY_REQUIRED',
          message: 'operation_key atau header Idempotency-Key wajib disertakan',
        });
      }

      const createdBy = authUser?.id
        ? Number(authUser.id)
        : req.body?.created_by
        ? Number(req.body.created_by)
        : null;

      const result = await recordOpeningBalance(deps.pool, {
        property_id: propertyId,
        product_id: Number(product_id),
        location_id: Number(location_id),
        quantity,
        packaging_id: packaging_id !== undefined && packaging_id !== null ? Number(packaging_id) : null,
        unit_cost: unit_cost !== undefined && unit_cost !== null ? unit_cost : null,
        operation_key: opKey,
        created_by: createdBy,
        cutover_id: cutover_id !== undefined && cutover_id !== null ? Number(cutover_id) : null,
        notes: notes !== undefined && notes !== null ? String(notes) : null,
      });

      return res.status(result.is_replay ? 200 : 201).json({
        status: 'OK',
        data: result,
      });
    } catch (err: any) {
      const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal mencatat saldo awal stok',
      });
    }
  };
}

export function createStockBalancesHandler(deps: StockInventoryDeps) {
  return async function handleStockBalances(req: Request, res: Response) {
    try {
      const propertyId = Number(req.query?.property_id ?? req.body?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib berupa bilangan bulat positif',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      // Guard izin operasional: inventory.view
      const authUser = (req as any).user;
      if (authUser) {
        const canView = await hasPermission(authUser, 'inventory.view', deps.pool);
        if (!canView) {
          return res.status(403).json({
            status: 'ERROR',
            code: 'FORBIDDEN',
            message: 'Akses ditolak: Memerlukan izin operasional inventory.view',
          });
        }
      }

      const productId = req.query?.product_id ? Number(req.query.product_id) : null;
      const locationId = req.query?.location_id ? Number(req.query.location_id) : null;
      const categoryId = req.query?.category_id ? Number(req.query.category_id) : null;
      const search = req.query?.search ? String(req.query.search).trim() : null;
      const trackStockOnly = req.query?.track_stock_only === 'true';

      const balances = await getStockBalances(deps.pool, {
        property_id: propertyId,
        product_id: productId,
        location_id: locationId,
        category_id: categoryId,
        search,
        track_stock_only: trackStockOnly,
      });

      return res.json({
        status: 'OK',
        data: balances,
      });
    } catch (err: any) {
      const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal memuat saldo stok',
      });
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Service: Bind Purchase Lines (MP-04B B-3)
// ─────────────────────────────────────────────────────────────────────────────

export async function bindPurchaseLines(
  clientOrPool: Pool | PoolClient | any,
  params: BindPurchaseLinesParams
): Promise<any[]> {
  const propertyId = Number(params.property_id);
  const transactionId = Number(params.transaction_id);

  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw Object.assign(new Error('property_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!Number.isInteger(transactionId) || transactionId <= 0) {
    throw Object.assign(new Error('transaction_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!Array.isArray(params.lines) || params.lines.length === 0) {
    throw Object.assign(new Error('lines wajib berupa array non-kosong'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  const isPool = typeof clientOrPool.connect === 'function';
  const client: PoolClient = isPool ? await clientOrPool.connect() : clientOrPool;

  try {
    if (isPool) await client.query('BEGIN');

    const results: any[] = [];
    for (const line of params.lines) {
      const lineId = Number(line.transaction_line_id);
      const lineType = line.line_type || 'STOCK';
      const productId = line.product_id ? Number(line.product_id) : null;
      const locationId = line.destination_location_id ? Number(line.destination_location_id) : null;
      const packagingId = line.packaging_id ? Number(line.packaging_id) : null;
      const baseUnitCode = String(line.base_unit_code || 'pcs').trim().toUpperCase();

      const orderedQty = parseStrictDecimalString(line.ordered_quantity, 'ordered_quantity');
      if (!orderedQty.ok || orderedQty.milli < 0n) {
        throw Object.assign(new Error(`ordered_quantity tidak valid pada baris #${lineId}`), {
          statusCode: 400,
          code: 'VALIDATION_ERROR',
        });
      }

      let receivedQtyStr = '0.000';
      if (line.received_quantity !== undefined && line.received_quantity !== null) {
        const parsedRecv = parseStrictDecimalString(line.received_quantity, 'received_quantity');
        if (!parsedRecv.ok || parsedRecv.milli < 0n) {
          throw Object.assign(new Error(`received_quantity tidak valid pada baris #${lineId}`), {
            statusCode: 400,
            code: 'VALIDATION_ERROR',
          });
        }
        receivedQtyStr = parsedRecv.formatted3;
      }

      const res = await client.query(
        `INSERT INTO stock_purchase_line_bindings (
           property_id, transaction_id, transaction_line_id, line_type,
           product_id, destination_location_id, packaging_id,
           ordered_quantity, received_quantity, base_unit_code,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7,
           $8, $9, $10,
           NOW(), NOW()
         )
         ON CONFLICT (property_id, transaction_id, transaction_line_id)
         DO UPDATE SET
           line_type = EXCLUDED.line_type,
           product_id = EXCLUDED.product_id,
           destination_location_id = EXCLUDED.destination_location_id,
           packaging_id = EXCLUDED.packaging_id,
           ordered_quantity = EXCLUDED.ordered_quantity,
           base_unit_code = EXCLUDED.base_unit_code,
           updated_at = NOW()
         RETURNING *`,
        [
          propertyId,
          transactionId,
          lineId,
          lineType,
          productId,
          locationId,
          packagingId,
          orderedQty.formatted3,
          receivedQtyStr,
          baseUnitCode,
        ]
      );
      results.push(res.rows[0]);
    }

    if (isPool) await client.query('COMMIT');
    return results;
  } catch (err) {
    if (isPool) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (isPool) client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Service: Record Purchase Receipt (MP-04B B-3: R-02, R-03, R-05, R-06, R-07)
// ─────────────────────────────────────────────────────────────────────────────

export async function recordPurchaseReceipt(
  clientOrPool: Pool | PoolClient | any,
  params: RecordPurchaseReceiptParams
): Promise<PurchaseReceiptResult> {
  const propertyId = Number(params.property_id);
  const transactionId = Number(params.transaction_id);
  const opKey = String(params.operation_key || '').trim();

  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw Object.assign(new Error('property_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!Number.isInteger(transactionId) || transactionId <= 0) {
    throw Object.assign(new Error('transaction_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!opKey) {
    throw Object.assign(new Error('operation_key wajib disertakan sebagai teks non-kosong'), {
      statusCode: 400,
      code: 'OPERATION_KEY_REQUIRED',
    });
  }
  if (opKey.length > 100) {
    throw Object.assign(new Error('operation_key maksimal 100 karakter'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!Array.isArray(params.received_lines) || params.received_lines.length === 0) {
    throw Object.assign(new Error('received_lines wajib berupa array non-kosong'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  // Validasi awal setiap baris penerimaan
  const seenLineIds = new Set<number>();
  for (const line of params.received_lines) {
    const lineId = Number(line.line_id ?? line.transaction_line_id);
    if (!Number.isInteger(lineId) || lineId <= 0) {
      throw Object.assign(new Error('line_id / transaction_line_id wajib berupa bilangan bulat positif'), {
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      });
    }
    if (seenLineIds.has(lineId)) {
      throw Object.assign(new Error(`Baris #${lineId} tercantum lebih dari satu kali dalam satu penerimaan`), {
        statusCode: 400,
        code: 'DUPLICATE_LINE_ID',
      });
    }
    seenLineIds.add(lineId);

    const parseRecv = parseStrictDecimalString(line.quantity_received, `Kuantitas penerimaan baris #${lineId}`);
    if (!parseRecv.ok || parseRecv.milli <= 0n) {
      throw Object.assign(new Error(`Kuantitas penerimaan baris #${lineId} harus berupa angka positif lebih dari 0`), {
        statusCode: 400,
        code: 'INVALID_QUANTITY',
      });
    }
  }

  const isPool = typeof clientOrPool.connect === 'function';
  const client: PoolClient = isPool ? await clientOrPool.connect() : clientOrPool;

  try {
    if (isPool) await client.query('BEGIN');

    // ── Guard 1: Kunci baris transaksi pembelian (FOR UPDATE) ──
    const txRes = await client.query(
      `SELECT id, property_id, transaction_no, transaction_type, transaction_status,
              approval_status, purchase_workflow_status, receiving_status, received_at,
              po_id, is_legacy_without_po
         FROM transactions
        WHERE id = $1 AND property_id = $2
        FOR UPDATE`,
      [transactionId, propertyId]
    );

    if (txRes.rowCount === 0) {
      throw Object.assign(
        new Error(`Transaksi #${transactionId} tidak ditemukan pada properti ${propertyId}`),
        { statusCode: 404, code: 'TRANSACTION_NOT_FOUND' }
      );
    }

    const tx = txRes.rows[0];
    if (String(tx.transaction_type).toUpperCase() !== 'PURCHASE') {
      throw Object.assign(
        new Error(`Transaksi #${transactionId} bukan transaksi pembelian (PURCHASE), melainkan ${tx.transaction_type}`),
        { statusCode: 400, code: 'INVALID_TRANSACTION_TYPE' }
      );
    }

    if (
      tx.transaction_status === 'VOIDED' ||
      tx.transaction_status === 'REVERSED' ||
      tx.transaction_status === 'CANCELLED' ||
      tx.purchase_workflow_status === 'BATAL'
    ) {
      throw Object.assign(
        new Error(`Transaksi #${transactionId} sudah dalam status ${tx.transaction_status} dan tidak dapat menerima barang`),
        { statusCode: 400, code: 'TRANSACTION_ALREADY_VOIDED' }
      );
    }

    if (!tx.po_id && !tx.is_legacy_without_po) {
      throw Object.assign(
        new Error(
          `PO_REQUIRED_FOR_RECEIPT: Transaksi pembelian #${transactionId} belum terhubung ke Purchase Order (PO) yang disetujui. Pengadaan baru wajib dimulai dari PO.`
        ),
        { statusCode: 400, code: 'PO_REQUIRED_FOR_RECEIPT' }
      );
    }

    if (tx.po_id) {
      const poCheckRes = await client.query(
        `SELECT id, po_number, status, approval_status
           FROM pos_purchase_orders
          WHERE id = $1 AND property_id = $2
          FOR UPDATE`,
        [Number(tx.po_id), propertyId]
      );
      if (poCheckRes.rowCount === 0) {
        throw Object.assign(
          new Error(`PO #${tx.po_id} yang dirujuk oleh transaksi #${transactionId} tidak ditemukan`),
          { statusCode: 404, code: 'PO_NOT_FOUND' }
        );
      }
      const poCheck = poCheckRes.rows[0];
      const poSt = String(poCheck.status || '').toUpperCase();
      const poAppSt = String(poCheck.approval_status || '').toUpperCase();
      const isPoApproved =
        ['APPROVED', 'ORDERED', 'PARTIAL', 'PARTIALLY_RECEIVED', 'RECEIVED', 'COMPLETED'].includes(poSt) &&
        poSt !== 'CANCELLED' &&
        poSt !== 'REJECTED' &&
        (poAppSt === 'APPROVED' || (!poAppSt && ['APPROVED', 'ORDERED', 'PARTIAL', 'PARTIALLY_RECEIVED', 'RECEIVED', 'COMPLETED'].includes(poSt)));
      if (!isPoApproved) {
        throw Object.assign(
          new Error(
            `PO_NOT_APPROVED_FOR_RECEIPT: PO ${poCheck.po_number} berstatus ${poSt} (${poAppSt}). Hanya PO yang sudah disetujui yang dapat diterima barangnya.`
          ),
          { statusCode: 400, code: 'PO_NOT_APPROVED_FOR_RECEIPT' }
        );
      }
    }

    if (tx.approval_status !== 'APPROVED') {
      throw Object.assign(
        new Error(`PURCHASE_NOT_APPROVED: Transaksi pembelian #${transactionId} belum disetujui (status: ${tx.approval_status || 'PENDING_APPROVAL'}). Hanya pembelian berstatus APPROVED yang dapat diterima barangnya.`),
        { statusCode: 400, code: 'PURCHASE_NOT_APPROVED' }
      );
    }

    // ── Fingerprint & Idempotency Check (R-05) ──
    const payloadFingerprint = computePurchaseReceiptFingerprint({
      property_id: propertyId,
      transaction_id: transactionId,
      received_lines: params.received_lines,
    });

    const existingOpRes = await client.query(
      `SELECT id, operation_type, operation_key, payload_fingerprint, transaction_id, notes, metadata, created_at
         FROM stock_operations
        WHERE property_id = $1 AND operation_key = $2`,
      [propertyId, opKey]
    );

    if (existingOpRes.rows.length > 0) {
      const existingOp = existingOpRes.rows[0];
      if (existingOp.payload_fingerprint === payloadFingerprint) {
        // Idempotent Replay: Muat data mutasi & status yang sudah tersimpan
        const existingMovementsRes = await client.query(
          `SELECT sm.id, sm.product_id, sm.location_id, sm.packaging_id, sm.packaging_code,
                  sm.packaging_label, sm.quantity_delta, sm.base_unit_code
             FROM stock_movements sm
            WHERE sm.operation_id = $1
            ORDER BY sm.id ASC`,
          [existingOp.id]
        );

        const currentTxRes = await client.query(
          `SELECT receiving_status, received_at FROM transactions WHERE id = $1 AND property_id = $2`,
          [transactionId, propertyId]
        );
        const currentTx = currentTxRes.rows[0] || tx;

        const replayLines: PurchaseReceiptLineResult[] = (existingOp.metadata?.received_lines || []).map((l: any) => ({
          transaction_line_id: Number(l.transaction_line_id ?? l.line_id),
          line_type: (l.line_type || 'STOCK') as StockPurchaseLineType,
          quantity_received: String(l.quantity_received),
          base_quantity_received: l.base_quantity_received ? String(l.base_quantity_received) : undefined,
          product_id: l.product_id ? Number(l.product_id) : null,
          location_id: l.location_id ? Number(l.location_id) : null,
          packaging_id: l.packaging_id ? Number(l.packaging_id) : null,
        }));

        if (isPool) await client.query('COMMIT');
        return {
          operation_id: Number(existingOp.id),
          operation_type: 'PURCHASE_RECEIPT',
          operation_key: existingOp.operation_key,
          transaction_id: transactionId,
          receiving_status: currentTx.receiving_status || 'DITERIMA_SEBAGIAN',
          received_at: currentTx.received_at ?? null,
          received_lines: replayLines,
          movements: existingMovementsRes.rows.map((m: any) => ({
            id: Number(m.id),
            product_id: Number(m.product_id),
            location_id: Number(m.location_id),
            packaging_id: m.packaging_id ? Number(m.packaging_id) : null,
            packaging_code: m.packaging_code ?? null,
            packaging_label: m.packaging_label ?? null,
            quantity_delta: String(m.quantity_delta),
            base_unit_code: String(m.base_unit_code),
          })),
          is_replay: true,
          created_at: existingOp.created_at,
        };
      } else {
        throw Object.assign(
          new Error(`operation_key "${opKey}" sudah digunakan dengan payload yang berbeda`),
          { statusCode: 409, code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH' }
        );
      }
    }

    // ── Guard 2 & Guard 3: Kunci Binding, Validasi Plafon (R-07) & Produk (R-01/R-03) ──
    // Urutkan line_id secara deterministik untuk mencegah PostgreSQL deadlocks antar transaksi konkuren
    const sortedReceivedLines = [...params.received_lines].sort(
      (a, b) => Number(a.line_id ?? a.transaction_line_id) - Number(b.line_id ?? b.transaction_line_id)
    );

    // Pre-aggregate incoming quantity per lineId in binding unit space to close split-line & packaging ceiling bypass
    const incomingTotalsPerLine = new Map<number, bigint>();
    const incomingTotalsPerPoItem = new Map<number, bigint>();

    interface PreparedStockItem {
      lineId: number;
      bindingId: number;
      poItemId: number | null;
      productId: number;
      destinationLocationId: number;
      quantityReceived: string;
      allocQuantity: string;
      poAllocQuantity: string;
      baseQuantityDelta: string;
      baseUnitCode: string;
      packagingId: number | null;
      packagingCode: string | null;
      packagingLabel: string | null;
      unitCostBase: number | null;
      prevAvgCost: number | null;
      prevLastCost: number | null;
    }

    interface PreparedNonStockItem {
      lineId: number;
      bindingId: number;
      poItemId: number | null;
      lineType: StockPurchaseLineType;
      quantityReceived: string;
      poAllocQuantity: string;
    }

    const preparedStockItems: PreparedStockItem[] = [];
    const preparedNonStockItems: PreparedNonStockItem[] = [];

    for (const line of sortedReceivedLines) {
      const lineId = Number(line.line_id ?? line.transaction_line_id);
      const parseRecv = parseStrictDecimalString(line.quantity_received, `Kuantitas baris #${lineId}`);
      if (!parseRecv.ok || parseRecv.milli <= 0n) {
        throw Object.assign(
          new Error(
            parseRecv.ok
              ? `Kuantitas penerimaan baris #${lineId} harus lebih besar dari 0`
              : parseRecv.error
          ),
          { statusCode: 400, code: 'VALIDATION_ERROR' }
        );
      }

      // Lock baris binding pembelian
      let bindingRes = await client.query(
        `SELECT *
           FROM stock_purchase_line_bindings
          WHERE property_id = $1 AND transaction_id = $2 AND transaction_line_id = $3
          FOR UPDATE`,
        [propertyId, transactionId, lineId]
      );

      const tlRes = await client.query(
        `SELECT tl.*, pmi.name AS product_name, pmi.base_unit, pmi.canonical_base_unit_code, pmi.track_stock,
                NULLIF(tl.conversion_factor_snapshot, 0) AS source_to_base_factor
           FROM transaction_lines tl
           LEFT JOIN pos_menu_items pmi ON pmi.id = tl.product_id AND pmi.property_id = tl.property_id
           LEFT JOIN product_packaging_conversions ppc_tl ON ppc_tl.id = tl.packaging_id AND ppc_tl.property_id = tl.property_id
          WHERE tl.id = $1 AND tl.transaction_id = $2 AND tl.property_id = $3`,
        [lineId, transactionId, propertyId]
      );

      if (bindingRes.rowCount === 0 && tlRes.rowCount === 0) {
        throw Object.assign(
          new Error(`Baris pembelian #${lineId} tidak ditemukan pada transaksi #${transactionId}`),
          { statusCode: 404, code: 'PURCHASE_LINE_NOT_FOUND' }
        );
      }

      const tl = tlRes.rows[0] || {};
      const effectiveSourcePkgId =
        bindingRes.rows[0]?.packaging_id != null
          ? Number(bindingRes.rows[0].packaging_id)
          : tl.packaging_id != null
          ? Number(tl.packaging_id)
          : null;
      const effectiveSourceProductId =
        bindingRes.rows[0]?.product_id != null
          ? Number(bindingRes.rows[0].product_id)
          : tl.product_id != null
          ? Number(tl.product_id)
          : null;
      const poItemId =
        bindingRes.rows[0]?.po_item_id != null
          ? Number(bindingRes.rows[0].po_item_id)
          : tl.po_item_id != null
          ? Number(tl.po_item_id)
          : null;

      let effectiveSourceFactor: number | null = effectiveSourcePkgId == null ? 1 : null;
      const bindSnapFactor =
        bindingRes.rows[0]?.packaging_id != null &&
        effectiveSourcePkgId != null &&
        Number(bindingRes.rows[0].packaging_id) === Number(effectiveSourcePkgId)
          ? Number(bindingRes.rows[0]?.conversion_factor_snapshot || 0)
          : 0;
      const tlDirectSnapFactor =
        tl.packaging_id != null &&
        effectiveSourcePkgId != null &&
        Number(tl.packaging_id) === Number(effectiveSourcePkgId)
          ? Number(tl.conversion_factor_snapshot || 0)
          : 0;
      const tlSnapFactor = bindSnapFactor > 0 ? bindSnapFactor : tlDirectSnapFactor;
      if (effectiveSourcePkgId != null && effectiveSourceProductId != null) {
        const srcPkgRes = await client.query(
          `SELECT to_base_factor FROM product_packaging_conversions WHERE id = $1 AND property_id = $2 AND menu_item_id = $3`,
          [effectiveSourcePkgId, propertyId, effectiveSourceProductId]
        );
        const fVal = parseFloat(String(srcPkgRes.rows[0]?.to_base_factor || '0'));
        if (!srcPkgRes.rows.length || isNaN(fVal) || fVal <= 0) {
          throw Object.assign(
            new Error(
              `Gagal merekonsiliasi kuantitas historis pada baris pembelian #${lineId}: faktor kemasan sumber #${effectiveSourcePkgId} tidak valid`
            ),
            { statusCode: 409, code: 'RECONCILIATION_CONVERSION_FAILED' }
          );
        }
        if (tlSnapFactor > 0) {
          effectiveSourceFactor = tlSnapFactor;
        }
      }

      let poItem: any = null;
      let poFactor = 1;
      if (poItemId != null) {
        const poItemRes = await client.query(
          `SELECT *
             FROM pos_purchase_order_items
            WHERE id = $1 AND property_id = $2
            FOR UPDATE`,
          [poItemId, propertyId]
        );
        if (poItemRes.rows.length > 0) {
          poItem = poItemRes.rows[0];
          const snapFactor = Number(poItem.conversion_factor_snapshot || 0);
          if (snapFactor > 0) {
            poFactor = snapFactor;
            if (
              poItem.packaging_id != null &&
              effectiveSourcePkgId != null &&
              Number(poItem.packaging_id) === Number(effectiveSourcePkgId) &&
              (!effectiveSourceFactor || effectiveSourceFactor <= 0)
            ) {
              effectiveSourceFactor = snapFactor;
            }
          } else if (
            poItem.packaging_id != null &&
            effectiveSourcePkgId != null &&
            Number(poItem.packaging_id) === Number(effectiveSourcePkgId) &&
            effectiveSourceFactor &&
            effectiveSourceFactor > 0
          ) {
            poFactor = effectiveSourceFactor;
          } else if (poItem.packaging_id != null && effectiveSourceProductId != null) {
            const poPkgRes = await client.query(
              `SELECT to_base_factor FROM product_packaging_conversions WHERE id = $1 AND property_id = $2 AND menu_item_id = $3`,
              [Number(poItem.packaging_id), propertyId, effectiveSourceProductId]
            );
            const pf = parseFloat(String(poPkgRes.rows[0]?.to_base_factor || '0'));
            if (pf > 0) poFactor = pf;
          }
        }
      }

      if (effectiveSourcePkgId != null && (!effectiveSourceFactor || effectiveSourceFactor <= 0)) {
        throw Object.assign(
          new Error(
            `Baris pembelian #${lineId} menggunakan kemasan (#${effectiveSourcePkgId}) yang belum memiliki snapshot faktor konversi terverifikasi. Penerimaan ditolak agar tidak menggunakan faktor konversi master terkini secara spekulatif.`
          ),
          { statusCode: 409, code: 'UNRESOLVED_CONVERSION_FACTOR_SNAPSHOT' }
        );
      }

      const histGrnRes = await client.query(
        `SELECT COALESCE(
                  SUM(
                    CASE
                      WHEN $4::bigint IS NOT NULL AND gri.packaging_id = $4::bigint THEN gri.received_qty
                      WHEN $4::bigint IS NOT NULL AND COALESCE($5::numeric, 0) > 0 THEN
                        COALESCE(
                          NULLIF(gri.base_quantity, 0),
                          gri.received_qty * COALESCE(NULLIF(gri.conversion_factor_snapshot, 0), ppc_gri.to_base_factor, 1)
                        ) / $5::numeric
                      ELSE COALESCE(
                        NULLIF(gri.base_quantity, 0),
                        gri.received_qty * COALESCE(NULLIF(gri.conversion_factor_snapshot, 0), ppc_gri.to_base_factor, 1),
                        gri.received_qty
                      )
                    END
                  ),
                  0
                ) AS reconciled_qty
           FROM pos_goods_receipt_items gri
           JOIN pos_goods_receipts gr ON gr.id = gri.receipt_id
           LEFT JOIN product_packaging_conversions ppc_gri ON ppc_gri.id = gri.packaging_id AND ppc_gri.property_id = gr.property_id
          WHERE gr.property_id = $1
            AND gr.transaction_id = $2
            AND gri.transaction_line_id = $3
            AND gr.status IN ('POSTED', 'COMPLETED')`,
        [propertyId, transactionId, lineId, effectiveSourcePkgId, effectiveSourceFactor]
      );
      const reconciledReceivedQty = parseFloat(String(histGrnRes.rows[0]?.reconciled_qty || '0'));

      // Rekonsiliasi atau inisialisasi binding dari transaction_lines dan riwayat GRN
      if (bindingRes.rowCount === 0) {
        let derivedLineType: StockPurchaseLineType = 'STOCK';
        if (!tl.product_id) {
          derivedLineType = 'SERVICE';
        } else if (!tl.track_stock) {
          derivedLineType = 'NON_STOCK_PHYSICAL';
        }

        const baseUnit = String(tl.canonical_base_unit_code || tl.base_unit || tl.unit || 'PCS')
          .trim()
          .toUpperCase();
        const defaultLocId = line.location_id ?? params.location_id ?? null;

        await client.query(
          `INSERT INTO stock_purchase_line_bindings (
             property_id, transaction_id, transaction_line_id, po_item_id, line_type,
             product_id, destination_location_id, packaging_id,
             ordered_quantity, received_quantity, base_unit_code,
             packaging_label_snapshot, conversion_factor_snapshot, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5,
             $6, $7, $8,
             $9, $10, $11,
             $12, $13, NOW(), NOW()
           )
           ON CONFLICT (property_id, transaction_id, transaction_line_id)
           DO UPDATE SET
             ordered_quantity = EXCLUDED.ordered_quantity,
             received_quantity = GREATEST(stock_purchase_line_bindings.received_quantity, EXCLUDED.received_quantity),
             po_item_id = COALESCE(stock_purchase_line_bindings.po_item_id, EXCLUDED.po_item_id),
             base_unit_code = COALESCE(EXCLUDED.base_unit_code, stock_purchase_line_bindings.base_unit_code),
             packaging_label_snapshot = COALESCE(stock_purchase_line_bindings.packaging_label_snapshot, EXCLUDED.packaging_label_snapshot),
             conversion_factor_snapshot = COALESCE(stock_purchase_line_bindings.conversion_factor_snapshot, EXCLUDED.conversion_factor_snapshot),
             updated_at = NOW()`,
          [
            propertyId,
            transactionId,
            lineId,
            tl.po_item_id ? Number(tl.po_item_id) : null,
            derivedLineType,
            tl.product_id ? Number(tl.product_id) : null,
            defaultLocId,
            tl.packaging_id ? Number(tl.packaging_id) : null,
            tl.quantity,
            reconciledReceivedQty.toFixed(3),
            baseUnit,
            tl.packaging_label_snapshot || (tl.packaging_id ? (tl.unit || null) : baseUnit),
            tl.packaging_id
              ? effectiveSourceFactor != null && effectiveSourceFactor > 0
                ? effectiveSourceFactor.toFixed(4)
                : tl.conversion_factor_snapshot || null
              : '1.0000',
          ]
        );

        bindingRes = await client.query(
          `SELECT *
             FROM stock_purchase_line_bindings
            WHERE property_id = $1 AND transaction_id = $2 AND transaction_line_id = $3
            FOR UPDATE`,
          [propertyId, transactionId, lineId]
        );
      } else {
        const existingBind = bindingRes.rows[0];
        const canonicalBase = String(
          tl.canonical_base_unit_code || tl.base_unit || existingBind.base_unit_code || 'PCS'
        )
          .trim()
          .toUpperCase();
        if (reconciledReceivedQty > Number(existingBind.received_quantity || 0) || existingBind.base_unit_code !== canonicalBase) {
          const updBindRes = await client.query(
            `UPDATE stock_purchase_line_bindings
                SET received_quantity = GREATEST(received_quantity, $1),
                    base_unit_code = $2,
                    updated_at = NOW()
              WHERE id = $3
              RETURNING *`,
            [reconciledReceivedQty.toFixed(3), canonicalBase, existingBind.id]
          );
          if (updBindRes.rows.length > 0) {
            bindingRes = updBindRes;
          }
        }
      }

      const binding = bindingRes.rows[0];
      const lineType = binding.line_type as StockPurchaseLineType;

      if (poItem) {
        // Reconcile binding.received_quantity with poItem.received_qty (converted to binding unit) so direct PO GRN receipts are respected
        const poReceivedRaw = Number(poItem.received_qty || 0);
        let poReceivedInBindingUnit = poReceivedRaw;
        const bindPkgId = binding.packaging_id != null ? Number(binding.packaging_id) : null;
        const poPkgId = poItem.packaging_id != null ? Number(poItem.packaging_id) : null;
        if (bindPkgId !== poPkgId || Math.abs(poFactor - (effectiveSourceFactor || 1)) > 1e-6) {
          const poReceivedBase = poReceivedRaw * poFactor;
          poReceivedInBindingUnit =
            effectiveSourceFactor && effectiveSourceFactor > 0
              ? poReceivedBase / effectiveSourceFactor
              : poReceivedBase;
        }
        if (poReceivedInBindingUnit > Number(binding.received_quantity || 0) + 1e-6) {
          const syncBindRes = await client.query(
            `UPDATE stock_purchase_line_bindings
                SET received_quantity = GREATEST(received_quantity, $1),
                    updated_at = NOW()
              WHERE id = $2
              RETURNING *`,
            [poReceivedInBindingUnit.toFixed(3), binding.id]
          );
          if (syncBindRes.rows.length > 0) {
            Object.assign(binding, syncBindRes.rows[0]);
          } else {
            binding.received_quantity = poReceivedInBindingUnit.toFixed(3);
          }
        }
      }

      if (lineType === 'STOCK') {
        // Guard 3: Kunci pos_menu_items dan pastikan track_stock = TRUE
        const productId = line.product_id ? Number(line.product_id) : (binding.product_id ? Number(binding.product_id) : null);
        if (!productId) {
          throw Object.assign(
            new Error(`Baris bertipe STOCK pada baris #${lineId} wajib memiliki product_id`),
            { statusCode: 400, code: 'PRODUCT_REQUIRED_FOR_STOCK_LINE' }
          );
        }
        if (binding.product_id && Number(binding.product_id) !== productId) {
          throw Object.assign(
            new Error(`Baris pembelian #${lineId} terikat ke produk #${binding.product_id}, bukan produk #${productId}`),
            { statusCode: 400, code: 'TX_LINE_PRODUCT_MISMATCH' }
          );
        }

        const prodRes = await client.query(
          `SELECT id, property_id, name, base_unit, canonical_base_unit_code, track_stock, is_active, average_cost, last_cost
             FROM pos_menu_items
            WHERE id = $1 AND property_id = $2
            FOR UPDATE`,
          [productId, propertyId]
        );

        if (prodRes.rowCount === 0) {
          throw Object.assign(
            new Error(`Produk dengan id ${productId} tidak ditemukan`),
            { statusCode: 404, code: 'PRODUCT_NOT_FOUND' }
          );
        }

        const product = prodRes.rows[0];
        if (!product.track_stock) {
          throw Object.assign(
            new Error(`Produk "${product.name}" tidak dikonfigurasi untuk pencatatan stok (track_stock = false)`),
            { statusCode: 400, code: 'PRODUCT_STOCK_NOT_TRACKED' }
          );
        }

        const baseUnitCode = product.canonical_base_unit_code || product.base_unit || binding.base_unit_code;

        // Lokasi tujuan penerimaan stok
        const destinationLocationId = line.location_id
          ? Number(line.location_id)
          : (binding.destination_location_id ? Number(binding.destination_location_id) : (params.location_id ? Number(params.location_id) : null));

        if (!destinationLocationId) {
          throw Object.assign(
            new Error(`Lokasi tujuan penerimaan stok untuk baris #${lineId} wajib ditentukan`),
            { statusCode: 400, code: 'LOCATION_REQUIRED' }
          );
        }

        const locRes = await client.query(
          `SELECT id, property_id, code, name, is_active
             FROM stock_locations
            WHERE id = $1 AND property_id = $2`,
          [destinationLocationId, propertyId]
        );

        if (locRes.rowCount === 0) {
          throw Object.assign(
            new Error(`Lokasi stok dengan id ${destinationLocationId} tidak ditemukan`),
            { statusCode: 404, code: 'LOCATION_NOT_FOUND' }
          );
        }

        const location = locRes.rows[0];
        if (!location.is_active) {
          throw Object.assign(
            new Error(`Lokasi stok "${location.name}" (${location.code}) sedang tidak aktif`),
            { statusCode: 400, code: 'LOCATION_INACTIVE' }
          );
        }

        // Konversi Kemasan (R-06) terlebih dahulu sebelum cek plafon (R-07)
        const packagingIdParam = line.packaging_id !== undefined ? line.packaging_id : binding.packaging_id;
        let baseQuantityDelta = parseRecv.formatted3;
        let packagingIdVal: number | null = null;
        let packagingCodeVal: string | null = null;
        let packagingLabelVal: string | null = null;
        let recvToBaseFactor = 1;

        if (packagingIdParam) {
          const parsedPkgId = Number(packagingIdParam);
          const pkgRes = await client.query(
            `SELECT id, property_id, menu_item_id, packaging_code, packaging_label,
                    base_unit_code, to_base_factor, is_active
               FROM product_packaging_conversions
              WHERE id = $1 AND property_id = $2 AND menu_item_id = $3`,
            [parsedPkgId, propertyId, productId]
          );

          if (pkgRes.rowCount === 0) {
            throw Object.assign(
              new Error(`Kemasan konversi #${parsedPkgId} tidak ditemukan untuk produk id ${productId}`),
              { statusCode: 404, code: 'PACKAGING_NOT_FOUND' }
            );
          }

          const pkg = pkgRes.rows[0];
          if (!pkg.is_active) {
            throw Object.assign(
              new Error(`Kemasan "${pkg.packaging_code}" sedang nonaktif`),
              { statusCode: 400, code: 'PACKAGING_INACTIVE' }
            );
          }

          let effectivePkgFactor: number | null = null;
          if (effectiveSourcePkgId != null && Number(effectiveSourcePkgId) === parsedPkgId) {
            if (!effectiveSourceFactor || effectiveSourceFactor <= 0) {
              throw Object.assign(
                new Error(
                  `Baris pembelian #${lineId} menggunakan kemasan (#${parsedPkgId}) yang belum memiliki snapshot faktor konversi terverifikasi.`
                ),
                { statusCode: 409, code: 'UNRESOLVED_CONVERSION_FACTOR_SNAPSHOT' }
              );
            }
            effectivePkgFactor = effectiveSourceFactor;
          } else if (poItem && poItem.packaging_id != null && Number(poItem.packaging_id) === parsedPkgId) {
            const poVerifiedSnap = Number(poItem.conversion_factor_snapshot || 0);
            if (!(poVerifiedSnap > 0)) {
              throw Object.assign(
                new Error(
                  `Baris PO #${poItemId} menggunakan kemasan (#${parsedPkgId}) yang belum memiliki snapshot faktor konversi terverifikasi.`
                ),
                { statusCode: 409, code: 'UNRESOLVED_CONVERSION_FACTOR_SNAPSHOT' }
              );
            }
            effectivePkgFactor = poVerifiedSnap;
          } else {
            effectivePkgFactor = Number(pkg.to_base_factor || 0);
          }

          const conv = convertPackagingToBaseQuantity({
            packagingQty: parseRecv.formatted3,
            toBaseFactor: String(effectivePkgFactor),
            baseUnitCode: pkg.base_unit_code,
          });

          if (!conv.ok) {
            throw Object.assign(new Error(conv.error), { statusCode: conv.status, code: conv.code });
          }

          baseQuantityDelta = conv.formatted3;
          packagingIdVal = Number(pkg.id);
          packagingCodeVal = pkg.packaging_code;
          packagingLabelVal =
            (poItem && poItem.packaging_id != null && Number(poItem.packaging_id) === parsedPkgId && poItem.packaging_label_snapshot
              ? String(poItem.packaging_label_snapshot)
              : null) ||
            (effectiveSourcePkgId != null &&
            Number(effectiveSourcePkgId) === parsedPkgId &&
            (binding.packaging_label_snapshot || tl.packaging_label_snapshot)
              ? String(binding.packaging_label_snapshot || tl.packaging_label_snapshot)
              : null) ||
            pkg.packaging_label;
          recvToBaseFactor = Number(effectivePkgFactor || 1) > 0 ? Number(effectivePkgFactor) : 1;
        }

        if (
          (line as any).conversion_factor_snapshot !== undefined &&
          (line as any).conversion_factor_snapshot !== null &&
          String((line as any).conversion_factor_snapshot).trim() !== ''
        ) {
          const reqSnap = Number((line as any).conversion_factor_snapshot);
          if (!Number.isFinite(reqSnap) || reqSnap <= 0 || Math.abs(reqSnap - recvToBaseFactor) > 1e-6) {
            throw Object.assign(
              new Error(
                `Faktor konversi kemasan pada request (${(line as any).conversion_factor_snapshot}) tidak sesuai dengan faktor konversi otoritatif sistem (${recvToBaseFactor}) untuk baris #${lineId}.`
              ),
              { statusCode: 400, code: 'INVALID_CONVERSION_FACTOR_SNAPSHOT' }
            );
          }
        }

        // Tentukan allocQuantity pada satuan binding (jika binding memiliki packaging_id yang sama, gunakan parseRecv; jika binding kemasan berbeda, bagi baseQuantityDelta dengan effectiveSourceFactor; jika binding satuan dasar, gunakan baseQuantityDelta)
        let allocQuantityStr = baseQuantityDelta;
        if (binding.packaging_id && packagingIdVal && Number(binding.packaging_id) === Number(packagingIdVal)) {
          allocQuantityStr = parseRecv.formatted3;
        } else if (binding.packaging_id && effectiveSourceFactor && effectiveSourceFactor > 0) {
          allocQuantityStr = (Number(baseQuantityDelta) / effectiveSourceFactor).toFixed(3);
        }
        const allocMilli = BigInt(Math.round(Number(allocQuantityStr) * 1000));
        const nextTotalIncomingMilli = (incomingTotalsPerLine.get(lineId) || 0n) + allocMilli;
        incomingTotalsPerLine.set(lineId, nextTotalIncomingMilli);

        const orderedMilli = BigInt(Math.round(Number(binding.ordered_quantity) * 1000));
        const currentReceivedMilli = BigInt(Math.round(Number(binding.received_quantity) * 1000));
        if (currentReceivedMilli + nextTotalIncomingMilli > orderedMilli) {
          const remainingStr = (Number(orderedMilli - currentReceivedMilli) / 1000).toFixed(3);
          const incomingStr = (Number(nextTotalIncomingMilli) / 1000).toFixed(3);
          throw Object.assign(
            new Error(
              `RECEIPT_QUANTITY_EXCEEDS_ORDERED: Total kuantitas penerimaan (${incomingStr}) melebihi sisa pesanan (${remainingStr}) pada baris #${lineId}`
            ),
            { statusCode: 400, code: 'RECEIPT_QUANTITY_EXCEEDS_ORDERED' }
          );
        }

        // Tentukan poAllocQuantity pada satuan baris PO (jika terhubung ke PO) dan validasi plafon PO
        let poAllocQuantityStr = allocQuantityStr;
        if (poItem && poItemId != null) {
          const poPkgId = poItem.packaging_id != null ? Number(poItem.packaging_id) : null;
          if (poPkgId === packagingIdVal && Math.abs(poFactor - recvToBaseFactor) <= 1e-6) {
            poAllocQuantityStr = parseRecv.formatted3;
          } else {
            poAllocQuantityStr = (Number(baseQuantityDelta) / (poFactor > 0 ? poFactor : 1)).toFixed(3);
          }

          const poAllocMilli = BigInt(Math.round(Number(poAllocQuantityStr) * 1000));
          const nextPoIncomingMilli = (incomingTotalsPerPoItem.get(poItemId) || 0n) + poAllocMilli;
          incomingTotalsPerPoItem.set(poItemId, nextPoIncomingMilli);

          const poOrderedMilli = BigInt(Math.round(Number(poItem.ordered_qty || 0) * 1000));
          const poCurrentReceivedMilli = BigInt(Math.round(Number(poItem.received_qty || 0) * 1000));
          if (poCurrentReceivedMilli + nextPoIncomingMilli > poOrderedMilli) {
            const remainingPoStr = (Number(poOrderedMilli - poCurrentReceivedMilli) / 1000).toFixed(3);
            const incomingPoStr = (Number(nextPoIncomingMilli) / 1000).toFixed(3);
            throw Object.assign(
              new Error(
                `RECEIPT_QUANTITY_EXCEEDS_ORDERED: Total kuantitas penerimaan (${incomingPoStr}) melebihi sisa pesanan PO (${remainingPoStr}) pada baris PO #${poItemId}`
              ),
              { statusCode: 400, code: 'RECEIPT_QUANTITY_EXCEEDS_ORDERED' }
            );
          }
        }

        // Hitung unitCostBase untuk pembaruan moving average cost produk (termasuk biaya 0 yang sah)
        let unitCostBase: number | null = null;
        const hasTxUnitPrice =
          tl.unit_price !== undefined &&
          tl.unit_price !== null &&
          String(tl.unit_price).trim() !== '' &&
          !isNaN(Number(tl.unit_price));
        const txUnitPrice = hasTxUnitPrice ? Number(tl.unit_price) : NaN;
        if (hasTxUnitPrice && txUnitPrice >= 0) {
          const srcFactor = effectiveSourceFactor && effectiveSourceFactor > 0 ? effectiveSourceFactor : 1;
          unitCostBase = txUnitPrice / srcFactor;
        } else if (
          poItem &&
          poItem.unit_cost !== undefined &&
          poItem.unit_cost !== null &&
          String(poItem.unit_cost).trim() !== '' &&
          !isNaN(Number(poItem.unit_cost)) &&
          Number(poItem.unit_cost) >= 0
        ) {
          unitCostBase = Number(poItem.unit_cost) / (poFactor > 0 ? poFactor : 1);
        }

        preparedStockItems.push({
          lineId,
          bindingId: Number(binding.id),
          poItemId,
          productId,
          destinationLocationId,
          quantityReceived: parseRecv.formatted3,
          allocQuantity: allocQuantityStr,
          poAllocQuantity: poAllocQuantityStr,
          baseQuantityDelta,
          baseUnitCode,
          packagingId: packagingIdVal,
          packagingCode: packagingCodeVal,
          packagingLabel: packagingLabelVal,
          unitCostBase,
          prevAvgCost: product.average_cost != null ? Number(product.average_cost) : null,
          prevLastCost: product.last_cost != null ? Number(product.last_cost) : null,
        });
      } else {
        // Baris NON_STOCK_PHYSICAL atau SERVICE (R-03)
        const nextTotalIncomingMilli = (incomingTotalsPerLine.get(lineId) || 0n) + parseRecv.milli;
        incomingTotalsPerLine.set(lineId, nextTotalIncomingMilli);

        const orderedMilli = BigInt(Math.round(Number(binding.ordered_quantity) * 1000));
        const currentReceivedMilli = BigInt(Math.round(Number(binding.received_quantity) * 1000));
        if (currentReceivedMilli + nextTotalIncomingMilli > orderedMilli) {
          const remainingStr = (Number(orderedMilli - currentReceivedMilli) / 1000).toFixed(3);
          const incomingStr = (Number(nextTotalIncomingMilli) / 1000).toFixed(3);
          throw Object.assign(
            new Error(
              `RECEIPT_QUANTITY_EXCEEDS_ORDERED: Total kuantitas penerimaan (${incomingStr}) melebihi sisa pesanan (${remainingStr}) pada baris #${lineId}`
            ),
            { statusCode: 400, code: 'RECEIPT_QUANTITY_EXCEEDS_ORDERED' }
          );
        }

        if (poItem && poItemId != null) {
          const nextPoIncomingMilli = (incomingTotalsPerPoItem.get(poItemId) || 0n) + parseRecv.milli;
          incomingTotalsPerPoItem.set(poItemId, nextPoIncomingMilli);
          const poOrderedMilli = BigInt(Math.round(Number(poItem.ordered_qty || 0) * 1000));
          const poCurrentReceivedMilli = BigInt(Math.round(Number(poItem.received_qty || 0) * 1000));
          if (poCurrentReceivedMilli + nextPoIncomingMilli > poOrderedMilli) {
            const remainingPoStr = (Number(poOrderedMilli - poCurrentReceivedMilli) / 1000).toFixed(3);
            const incomingPoStr = (Number(nextPoIncomingMilli) / 1000).toFixed(3);
            throw Object.assign(
              new Error(
                `RECEIPT_QUANTITY_EXCEEDS_ORDERED: Total kuantitas penerimaan (${incomingPoStr}) melebihi sisa pesanan PO (${remainingPoStr}) pada baris PO #${poItemId}`
              ),
              { statusCode: 400, code: 'RECEIPT_QUANTITY_EXCEEDS_ORDERED' }
            );
          }
        }

        preparedNonStockItems.push({
          lineId,
          bindingId: Number(binding.id),
          poItemId,
          lineType,
          quantityReceived: parseRecv.formatted3,
          poAllocQuantity: parseRecv.formatted3,
        });
      }
    }

    // ── Mutasi Stok Atomik ──
    // 1. Buat header stock_operations
    const createdBy = params.created_by ? Number(params.created_by) : null;
    const notes = params.notes ? String(params.notes).trim() : null;

    const metadataPayload = {
      transaction_id: transactionId,
      received_lines: [
        ...preparedStockItems.map((s) => ({
          transaction_line_id: s.lineId,
          line_type: 'STOCK',
          quantity_received: s.quantityReceived,
          base_quantity_received: s.baseQuantityDelta,
          product_id: s.productId,
          location_id: s.destinationLocationId,
          packaging_id: s.packagingId,
        })),
        ...preparedNonStockItems.map((n) => ({
          transaction_line_id: n.lineId,
          line_type: n.lineType,
          quantity_received: n.quantityReceived,
        })),
      ],
      notes,
    };

    const opInsertRes = await client.query(
      `INSERT INTO stock_operations (
         property_id, operation_type, operation_key, payload_fingerprint,
         transaction_id, notes, metadata, created_by, created_at
       ) VALUES (
         $1, 'PURCHASE_RECEIPT', $2, $3,
         $4, $5, $6, $7, NOW()
       )
       RETURNING id, created_at`,
      [propertyId, opKey, payloadFingerprint, transactionId, notes, JSON.stringify(metadataPayload), createdBy]
    );
    const opRow = opInsertRes.rows[0];

    const outMovements: PurchaseReceiptMovement[] = [];
    const runningProductCostState = new Map<number, { avgCost: number | null }>();

    // 2. Eksekusi tiap baris STOCK ke stock_movements & stock_balances
    for (const item of preparedStockItems) {
      let prevTotalStock = 0;
      if (item.unitCostBase != null && item.unitCostBase >= 0) {
        const prevBalRes = await client.query(
          `SELECT COALESCE(SUM(quantity), 0) AS total_qty
             FROM stock_balances
            WHERE property_id = $1 AND product_id = $2`,
          [propertyId, item.productId]
        );
        prevTotalStock = Number(prevBalRes.rows[0]?.total_qty ?? 0);
      }

      const movRes = await client.query(
        `INSERT INTO stock_movements (
           operation_id, property_id, product_id, location_id,
           packaging_id, packaging_code, packaging_label,
           quantity_delta, base_unit_code, created_at
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7,
           $8, $9, NOW()
         )
         RETURNING id`,
        [
          opRow.id,
          propertyId,
          item.productId,
          item.destinationLocationId,
          item.packagingId,
          item.packagingCode,
          item.packagingLabel,
          item.baseQuantityDelta,
          item.baseUnitCode,
        ]
      );

      await client.query(
        `INSERT INTO stock_balances (
           property_id, product_id, location_id, quantity, updated_at
         ) VALUES (
           $1, $2, $3, $4, NOW()
         )
         ON CONFLICT (property_id, product_id, location_id)
         DO UPDATE SET
           quantity = stock_balances.quantity + EXCLUDED.quantity,
           updated_at = NOW()`,
        [propertyId, item.productId, item.destinationLocationId, item.baseQuantityDelta]
      );

      if (item.unitCostBase != null && item.unitCostBase >= 0) {
        const incomingBaseQty = Number(item.baseQuantityDelta);
        const safePrevStock = Math.max(0, prevTotalStock);
        const priorCostState = runningProductCostState.get(item.productId);
        const effectivePrevAvgCost = priorCostState !== undefined ? priorCostState.avgCost : item.prevAvgCost;
        const hasKnownPrevAvg =
          effectivePrevAvgCost !== null &&
          effectivePrevAvgCost !== undefined &&
          Number.isFinite(effectivePrevAvgCost) &&
          effectivePrevAvgCost >= 0;
        let nextAvgCost: number;
        if (safePrevStock <= 0 || !hasKnownPrevAvg) {
          nextAvgCost = item.unitCostBase;
        } else {
          const nextTotalStock = safePrevStock + incomingBaseQty;
          nextAvgCost =
            nextTotalStock > 0
              ? (safePrevStock * effectivePrevAvgCost + incomingBaseQty * item.unitCostBase) / nextTotalStock
              : item.unitCostBase;
        }
        runningProductCostState.set(item.productId, { avgCost: nextAvgCost });
        await client.query(
          `UPDATE pos_menu_items
              SET average_cost = $1,
                  last_cost = $2,
                  updated_at = NOW()
            WHERE id = $3 AND property_id = $4`,
          [Number(nextAvgCost.toFixed(2)), Number(item.unitCostBase.toFixed(2)), item.productId, propertyId]
        );
      }

      await client.query(
        `UPDATE stock_purchase_line_bindings
            SET received_quantity = received_quantity + $1,
                destination_location_id = COALESCE(destination_location_id, $2),
                packaging_id = COALESCE(packaging_id, $3),
                updated_at = NOW()
          WHERE id = $4`,
        [item.allocQuantity, item.destinationLocationId, item.packagingId, item.bindingId]
      );

      if (item.poItemId != null) {
        await client.query(
          `UPDATE pos_purchase_order_items
              SET received_qty = received_qty + $1,
                  updated_at = NOW()
            WHERE id = $2`,
          [Number(item.poAllocQuantity), item.poItemId]
        );
      }

      outMovements.push({
        id: Number(movRes.rows[0].id),
        product_id: item.productId,
        location_id: item.destinationLocationId,
        packaging_id: item.packagingId,
        packaging_code: item.packagingCode,
        packaging_label: item.packagingLabel,
        quantity_delta: item.baseQuantityDelta,
        base_unit_code: item.baseUnitCode,
      });
    }

    // 3. Eksekusi baris non-stok / service (hanya catat binding administratif)
    for (const item of preparedNonStockItems) {
      await client.query(
        `UPDATE stock_purchase_line_bindings
            SET received_quantity = received_quantity + $1,
                updated_at = NOW()
          WHERE id = $2`,
        [item.quantityReceived, item.bindingId]
      );

      if (item.poItemId != null) {
        await client.query(
          `UPDATE pos_purchase_order_items
              SET received_qty = received_qty + $1,
                  updated_at = NOW()
            WHERE id = $2`,
          [Number(item.poAllocQuantity), item.poItemId]
        );
      }
    }

    // 4. Sinkronisasi status penerimaan pada header PO (jika terhubung ke PO)
    if (tx.po_id) {
      const poItemsAllRes = await client.query(
        `SELECT id, ordered_qty, received_qty
           FROM pos_purchase_order_items
          WHERE po_id = $1`,
        [Number(tx.po_id)]
      );
      if (poItemsAllRes.rows.length > 0) {
        let poAllCompleted = true;
        let poAnyReceived = false;
        for (const pi of poItemsAllRes.rows) {
          const pOrd = BigInt(Math.round(Number(pi.ordered_qty || 0) * 1000));
          const pRec = BigInt(Math.round(Number(pi.received_qty || 0) * 1000));
          if (pRec < pOrd) poAllCompleted = false;
          if (pRec > 0n) poAnyReceived = true;
        }
        const nextPoStatus = poAllCompleted ? 'COMPLETED' : poAnyReceived ? 'PARTIALLY_RECEIVED' : 'APPROVED';
        const nextPoRecvStatus = poAllCompleted
          ? 'DITERIMA_LENGKAP'
          : poAnyReceived
          ? 'DITERIMA_SEBAGIAN'
          : 'BELUM_DITERIMA';
        await client.query(
          `UPDATE pos_purchase_orders
              SET status = $1,
                  receiving_status = $2,
                  updated_at = NOW()
            WHERE id = $3 AND property_id = $4`,
          [nextPoStatus, nextPoRecvStatus, Number(tx.po_id), propertyId]
        );
      }
    }

    // ── Derivasi Status Header Pembelian ──
    const allBindingsRes = await client.query(
      `SELECT id, transaction_line_id, line_type, ordered_quantity, received_quantity
         FROM stock_purchase_line_bindings
        WHERE property_id = $1 AND transaction_id = $2`,
      [propertyId, transactionId]
    );

    const stockBindings = allBindingsRes.rows.filter((b: any) => b.line_type === 'STOCK');
    const evaluationBindings = stockBindings.length > 0 ? stockBindings : allBindingsRes.rows;

    let allCompleted = true;
    let anyReceived = false;

    for (const b of evaluationBindings) {
      const ordered = BigInt(Math.round(Number(b.ordered_quantity) * 1000));
      const received = BigInt(Math.round(Number(b.received_quantity) * 1000));
      if (received < ordered) {
        allCompleted = false;
      }
      if (received > 0n) {
        anyReceived = true;
      }
    }

    let derivedReceivingStatus: string;
    if (allCompleted && evaluationBindings.length > 0) {
      derivedReceivingStatus = 'DITERIMA_LENGKAP';
    } else if (anyReceived) {
      derivedReceivingStatus = 'DITERIMA_SEBAGIAN';
    } else {
      derivedReceivingStatus = 'BELUM_DITERIMA';
    }

    const txUpdateRes = await client.query(
      `UPDATE transactions
          SET receiving_status = $1::varchar,
              received_at = CASE WHEN $1::varchar = 'DITERIMA_LENGKAP' THEN COALESCE(received_at, NOW()) ELSE received_at END,
              updated_at = NOW()
        WHERE id = $2 AND property_id = $3
        RETURNING id, receiving_status, received_at`,
      [derivedReceivingStatus, transactionId, propertyId]
    );

    const updatedTx = txUpdateRes.rows[0];

    if (isPool) await client.query('COMMIT');

    const outLines: PurchaseReceiptLineResult[] = [
      ...preparedStockItems.map((s) => ({
        transaction_line_id: s.lineId,
        line_type: 'STOCK' as StockPurchaseLineType,
        quantity_received: s.quantityReceived,
        base_quantity_received: s.baseQuantityDelta,
        product_id: s.productId,
        location_id: s.destinationLocationId,
        packaging_id: s.packagingId,
      })),
      ...preparedNonStockItems.map((n) => ({
        transaction_line_id: n.lineId,
        line_type: n.lineType,
        quantity_received: n.quantityReceived,
      })),
    ];

    return {
      operation_id: Number(opRow.id),
      operation_type: 'PURCHASE_RECEIPT',
      operation_key: opKey,
      transaction_id: transactionId,
      receiving_status: updatedTx.receiving_status,
      received_at: updatedTx.received_at,
      received_lines: outLines,
      movements: outMovements,
      is_replay: false,
      created_at: opRow.created_at,
    };
  } catch (error) {
    if (isPool) {
      try {
        await client.query('ROLLBACK');
      } catch {}
    }
    throw error;
  } finally {
    if (isPool) client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Service: Get Purchase Receipts (MP-04B B-3)
// ─────────────────────────────────────────────────────────────────────────────

export async function getPurchaseReceipts(
  clientOrPool: Pool | PoolClient | any,
  filters: { property_id: number; transaction_id: number }
): Promise<PurchaseReceiptsSummary> {
  const propertyId = Number(filters.property_id);
  const transactionId = Number(filters.transaction_id);

  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw Object.assign(new Error('property_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!Number.isInteger(transactionId) || transactionId <= 0) {
    throw Object.assign(new Error('transaction_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  const txRes = await clientOrPool.query(
    `SELECT id, transaction_no, transaction_type, receiving_status, received_at
       FROM transactions
      WHERE id = $1 AND property_id = $2`,
    [transactionId, propertyId]
  );

  if (txRes.rowCount === 0) {
    throw Object.assign(
      new Error(`Transaksi #${transactionId} tidak ditemukan pada properti ${propertyId}`),
      { statusCode: 404, code: 'TRANSACTION_NOT_FOUND' }
    );
  }
  const tx = txRes.rows[0];

  const bindingsRes = await clientOrPool.query(
    `SELECT splb.id, splb.transaction_line_id, splb.line_type,
            splb.product_id, pmi.name AS product_name,
            splb.destination_location_id, sl.code AS location_code,
            splb.packaging_id, ppc.packaging_code,
            splb.ordered_quantity::text AS ordered_quantity,
            splb.received_quantity::text AS received_quantity,
            splb.base_unit_code
       FROM stock_purchase_line_bindings splb
       LEFT JOIN pos_menu_items pmi ON pmi.id = splb.product_id AND pmi.property_id = splb.property_id
       LEFT JOIN stock_locations sl ON sl.id = splb.destination_location_id AND sl.property_id = splb.property_id
       LEFT JOIN product_packaging_conversions ppc ON ppc.id = splb.packaging_id AND ppc.property_id = splb.property_id
      WHERE splb.property_id = $1 AND splb.transaction_id = $2
      ORDER BY splb.transaction_line_id ASC`,
    [propertyId, transactionId]
  );

  const opsRes = await clientOrPool.query(
    `SELECT so.id, so.operation_key, so.operation_type, so.transaction_id,
            so.created_by, so.notes, so.created_at
       FROM stock_operations so
      WHERE so.property_id = $1 AND so.transaction_id = $2 AND so.operation_type = 'PURCHASE_RECEIPT'
      ORDER BY so.created_at ASC, so.id ASC`,
    [propertyId, transactionId]
  );

  const opIds = opsRes.rows.map((r: any) => r.id);
  const movementsByOpId: Record<string, any[]> = {};

  if (opIds.length > 0) {
    const movRes = await clientOrPool.query(
      `SELECT sm.id, sm.operation_id, sm.product_id, pmi.name AS product_name,
              sm.location_id, sl.code AS location_code,
              sm.quantity_delta::text AS quantity_delta, sm.base_unit_code,
              sm.packaging_id, sm.packaging_code
         FROM stock_movements sm
         LEFT JOIN pos_menu_items pmi ON pmi.id = sm.product_id AND pmi.property_id = sm.property_id
         LEFT JOIN stock_locations sl ON sl.id = sm.location_id AND sl.property_id = sm.property_id
        WHERE sm.operation_id = ANY($1::bigint[])
        ORDER BY sm.id ASC`,
      [opIds]
    );

    for (const m of movRes.rows) {
      const opKey = String(m.operation_id);
      if (!movementsByOpId[opKey]) movementsByOpId[opKey] = [];
      movementsByOpId[opKey].push({
        id: Number(m.id),
        product_id: Number(m.product_id),
        product_name: String(m.product_name || ''),
        location_id: Number(m.location_id),
        location_code: String(m.location_code || ''),
        quantity_delta: String(m.quantity_delta),
        base_unit_code: String(m.base_unit_code),
        packaging_id: m.packaging_id ? Number(m.packaging_id) : null,
        packaging_code: m.packaging_code ?? null,
      });
    }
  }

  const receipts: PurchaseReceiptHistoryItem[] = opsRes.rows.map((r: any) => ({
    operation_id: Number(r.id),
    operation_key: String(r.operation_key),
    operation_type: String(r.operation_type),
    transaction_id: Number(r.transaction_id),
    created_by: r.created_by ? Number(r.created_by) : null,
    created_at: r.created_at,
    notes: r.notes ?? null,
    movements: movementsByOpId[String(r.id)] || [],
  }));

  return {
    transaction_id: Number(tx.id),
    receiving_status: tx.receiving_status ?? null,
    received_at: tx.received_at ?? null,
    bindings: bindingsRes.rows.map((b: any) => ({
      id: Number(b.id),
      transaction_line_id: Number(b.transaction_line_id),
      line_type: b.line_type as StockPurchaseLineType,
      product_id: b.product_id ? Number(b.product_id) : null,
      product_name: b.product_name ?? null,
      destination_location_id: b.destination_location_id ? Number(b.destination_location_id) : null,
      location_code: b.location_code ?? null,
      packaging_id: b.packaging_id ? Number(b.packaging_id) : null,
      packaging_code: b.packaging_code ?? null,
      ordered_quantity: String(b.ordered_quantity),
      received_quantity: String(b.received_quantity),
      base_unit_code: String(b.base_unit_code),
    })),
    receipts,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Express Route Handlers (MP-04B B-3)
// ─────────────────────────────────────────────────────────────────────────────

export function createPurchaseReceiptHandler(deps: StockInventoryDeps) {
  return async function handlePurchaseReceipt(req: Request, res: Response) {
    try {
      const propertyId = Number(req.body?.property_id ?? req.query?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib berupa bilangan bulat positif',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      // Guard izin operasional: inventory.create atau inventory.edit
      const authUser = (req as any).user;
      if (authUser) {
        const canWrite =
          (await hasPermission(authUser, 'inventory.create', deps.pool)) ||
          (await hasPermission(authUser, 'inventory.edit', deps.pool));
        if (!canWrite) {
          return res.status(403).json({
            status: 'ERROR',
            code: 'FORBIDDEN',
            message: 'Akses ditolak: Memerlukan izin operasional inventory.create atau inventory.edit',
          });
        }
      }

      const { transaction_id, location_id, received_lines, notes } = req.body || {};

      const headerKey =
        (typeof req.headers?.['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null) ||
        (typeof req.headers?.['x-idempotency-key'] === 'string' ? req.headers['x-idempotency-key'] : null);
      const opKey = String(headerKey || req.body?.operation_key || '').trim();

      if (!opKey) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'OPERATION_KEY_REQUIRED',
          message: 'operation_key atau header Idempotency-Key wajib disertakan',
        });
      }

      const createdBy = authUser?.id
        ? Number(authUser.id)
        : req.body?.created_by
        ? Number(req.body.created_by)
        : null;

      const result = await recordPurchaseReceipt(deps.pool, {
        property_id: propertyId,
        transaction_id: Number(transaction_id),
        location_id: location_id !== undefined && location_id !== null ? Number(location_id) : null,
        received_lines: received_lines || [],
        operation_key: opKey,
        created_by: createdBy,
        notes: notes ?? null,
      });

      return res.status(result.is_replay ? 200 : 201).json({
        status: 'OK',
        data: result,
      });
    } catch (err: any) {
      const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal mencatat penerimaan barang pembelian',
      });
    }
  };
}

export function createPurchaseReceiptsQueryHandler(deps: StockInventoryDeps) {
  return async function handlePurchaseReceiptsQuery(req: Request, res: Response) {
    try {
      const propertyId = Number(req.query?.property_id ?? req.body?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib berupa bilangan bulat positif',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const authUser = (req as any).user;
      if (authUser) {
        const canView = await hasPermission(authUser, 'inventory.view', deps.pool);
        if (!canView) {
          return res.status(403).json({
            status: 'ERROR',
            code: 'FORBIDDEN',
            message: 'Akses ditolak: Memerlukan izin operasional inventory.view',
          });
        }
      }

      const transactionId = Number(req.query?.transaction_id ?? req.params?.transaction_id);
      if (!Number.isInteger(transactionId) || transactionId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'transaction_id wajib berupa bilangan bulat positif',
        });
      }

      const receipts = await getPurchaseReceipts(deps.pool, {
        property_id: propertyId,
        transaction_id: transactionId,
      });

      return res.json({
        status: 'OK',
        data: receipts,
      });
    } catch (err: any) {
      const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal memuat riwayat penerimaan barang',
      });
    }
  };
}



// ─────────────────────────────────────────────────────────────────────────────
// MP-04B Batch 4: Penyesuaian Stok, Opname Fisik, dan Transfer Antar Lokasi
// ─────────────────────────────────────────────────────────────────────────────

export const STOCK_ADJUSTMENT_REASON_CODES = [
  'RUSAK',
  'HILANG',
  'KADALUARSA',
  'PEMAKAIAN_INTERNAL',
  'KOREKSI_ADMIN',
  'SAMPLE',
] as const;

export type StockAdjustmentReasonCode = (typeof STOCK_ADJUSTMENT_REASON_CODES)[number] | string;
export type StockAdjustmentType = 'IN' | 'OUT';

export interface RecordStockAdjustmentParams {
  property_id: number;
  product_id: number;
  location_id: number;
  adjustment_type: StockAdjustmentType;
  reason_code: StockAdjustmentReasonCode;
  quantity: string | number;
  packaging_id?: number | null;
  operation_key: string;
  notes?: string | null;
  created_by?: number | null;
}

export interface StockAdjustmentResult {
  operation_id: number;
  operation_type: 'STOCK_ADJUSTMENT';
  operation_key: string;
  movement_id: number;
  property_id: number;
  product_id: number;
  location_id: number;
  adjustment_type: StockAdjustmentType;
  reason_code: string;
  quantity_delta: string;
  base_unit_code: string;
  packaging_id: number | null;
  packaging_code: string | null;
  packaging_label: string | null;
  current_balance: string;
  is_replay: boolean;
  notes: string | null;
  created_at: string | Date;
}

export interface StockAdjustmentFilters {
  property_id: number;
  product_id?: number | null;
  location_id?: number | null;
  reason_code?: string | null;
  adjustment_type?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  limit?: number;
  offset?: number;
}

export interface StockOpnameItemInput {
  product_id: number;
  physical_quantity: string | number;
  packaging_id?: number | null;
  notes?: string | null;
}

export interface RecordStockOpnameParams {
  property_id: number;
  location_id: number;
  items: StockOpnameItemInput[];
  operation_key: string;
  notes?: string | null;
  created_by?: number | null;
}

export interface StockOpnameItemResult {
  product_id: number;
  product_name: string;
  base_unit_code: string;
  system_quantity: string;
  physical_quantity: string;
  variance_quantity: string;
  status: 'MATCH' | 'SURPLUS' | 'DEFICIT';
  movement_id: number | null;
  packaging_id: number | null;
  unit_cost?: string | null;
  notes: string | null;
}

export interface StockOpnameResult {
  operation_id: number;
  operation_type: 'STOCK_OPNAME';
  operation_key: string;
  property_id: number;
  location_id: number;
  items: StockOpnameItemResult[];
  notes: string | null;
  is_replay: boolean;
  created_at: string | Date;
}

export interface StockOpnameFilters {
  property_id: number;
  location_id?: number | null;
  start_date?: string | null;
  end_date?: string | null;
  limit?: number;
  offset?: number;
}

export interface StockTransferItemInput {
  product_id: number;
  quantity: string | number;
  packaging_id?: number | null;
  notes?: string | null;
}

export interface RecordStockTransferParams {
  property_id: number;
  from_location_id: number;
  to_location_id: number;
  items: StockTransferItemInput[];
  operation_key: string;
  notes?: string | null;
  created_by?: number | null;
}

export interface StockTransferItemResult {
  product_id: number;
  product_name: string;
  base_unit_code: string;
  quantity: string;
  base_quantity: string;
  out_movement_id: number;
  in_movement_id: number;
  origin_balance: string;
  destination_balance: string;
  packaging_id: number | null;
  packaging_code: string | null;
  packaging_label: string | null;
  notes: string | null;
}

export interface StockTransferResult {
  operation_id: number;
  operation_type: 'STOCK_TRANSFER';
  operation_key: string;
  property_id: number;
  from_location_id: number;
  to_location_id: number;
  items: StockTransferItemResult[];
  notes: string | null;
  is_replay: boolean;
  created_at: string | Date;
}

export interface StockTransferFilters {
  property_id: number;
  from_location_id?: number | null;
  to_location_id?: number | null;
  product_id?: number | null;
  start_date?: string | null;
  end_date?: string | null;
  limit?: number;
  offset?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint Functions for Batch 4
// ─────────────────────────────────────────────────────────────────────────────

export function computeStockAdjustmentFingerprint(payload: {
  property_id: number;
  product_id: number;
  location_id: number;
  adjustment_type: string;
  reason_code: string;
  quantity: string;
  packaging_id?: number | null;
}): string {
  const canonical = JSON.stringify({
    adjustment_type: String(payload.adjustment_type).trim().toUpperCase(),
    location_id: Number(payload.location_id),
    operation_type: 'STOCK_ADJUSTMENT',
    packaging_id: payload.packaging_id ? Number(payload.packaging_id) : null,
    product_id: Number(payload.product_id),
    property_id: Number(payload.property_id),
    quantity: String(payload.quantity).trim(),
    reason_code: String(payload.reason_code).trim().toUpperCase(),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function computeStockOpnameFingerprint(payload: {
  property_id: number;
  location_id: number;
  items: Array<{
    product_id: number;
    physical_quantity: string | number;
    packaging_id?: number | null;
  }>;
}): string {
  const sortedItems = [...payload.items]
    .map((item) => ({
      packaging_id: item.packaging_id ? Number(item.packaging_id) : null,
      physical_quantity: String(item.physical_quantity).trim(),
      product_id: Number(item.product_id),
    }))
    .sort((a, b) => a.product_id - b.product_id);

  const canonical = JSON.stringify({
    items: sortedItems,
    location_id: Number(payload.location_id),
    operation_type: 'STOCK_OPNAME',
    property_id: Number(payload.property_id),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function computeStockTransferFingerprint(payload: {
  property_id: number;
  from_location_id: number;
  to_location_id: number;
  items: Array<{
    product_id: number;
    quantity: string | number;
    packaging_id?: number | null;
  }>;
}): string {
  const sortedItems = [...payload.items]
    .map((item) => ({
      packaging_id: item.packaging_id ? Number(item.packaging_id) : null,
      product_id: Number(item.product_id),
      quantity: String(item.quantity).trim(),
    }))
    .sort((a, b) => a.product_id - b.product_id);

  const canonical = JSON.stringify({
    from_location_id: Number(payload.from_location_id),
    items: sortedItems,
    operation_type: 'STOCK_TRANSFER',
    property_id: Number(payload.property_id),
    to_location_id: Number(payload.to_location_id),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Domain Function: recordStockAdjustment
// ─────────────────────────────────────────────────────────────────────────────

export async function recordStockAdjustment(
  clientOrPool: Pool | PoolClient | any,
  params: RecordStockAdjustmentParams
): Promise<StockAdjustmentResult> {
  const propertyId = Number(params.property_id);
  const productId = Number(params.product_id);
  const locationId = Number(params.location_id);
  const opKey = String(params.operation_key || '').trim();
  const rawType = String(params.adjustment_type || '').trim().toUpperCase();
  const rawReason = String(params.reason_code || '').trim().toUpperCase();
  const notes = params.notes !== undefined && params.notes !== null ? String(params.notes).trim() : null;
  const createdBy = params.created_by ? Number(params.created_by) : null;

  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw Object.assign(new Error('property_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!Number.isInteger(productId) || productId <= 0) {
    throw Object.assign(new Error('product_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!Number.isInteger(locationId) || locationId <= 0) {
    throw Object.assign(new Error('location_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!opKey) {
    throw Object.assign(new Error('operation_key wajib disertakan sebagai teks non-kosong'), {
      statusCode: 400,
      code: 'OPERATION_KEY_REQUIRED',
    });
  }
  if (opKey.length > 100) {
    throw Object.assign(new Error('operation_key maksimal 100 karakter'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  if (rawType !== 'IN' && rawType !== 'OUT') {
    throw Object.assign(new Error(`adjustment_type tidak valid: "${params.adjustment_type}". Harus "IN" atau "OUT"`), {
      statusCode: 400,
      code: 'INVALID_ADJUSTMENT_TYPE',
    });
  }
  const adjustmentType: StockAdjustmentType = rawType;

  if (!STOCK_ADJUSTMENT_REASON_CODES.includes(rawReason as any)) {
    throw Object.assign(
      new Error(
        `Alasan penyesuaian tidak valid: "${params.reason_code}". Pilihan yang diperbolehkan: ${STOCK_ADJUSTMENT_REASON_CODES.join(', ')}`
      ),
      {
        statusCode: 400,
        code: 'INVALID_ADJUSTMENT_REASON',
      }
    );
  }
  const reasonCode = rawReason;

  const isPool = typeof clientOrPool.connect === 'function';
  const client: PoolClient = isPool ? await clientOrPool.connect() : clientOrPool;

  try {
    if (isPool) {
      await client.query('BEGIN');
    }

    // ── Guard 1: Kunci produk (FOR UPDATE) & validasi track_stock ──
    const productRes = await client.query(
      `SELECT id, property_id, name, base_unit, canonical_base_unit_code, track_stock, is_active
         FROM pos_menu_items
        WHERE id = $1 AND property_id = $2
        FOR UPDATE`,
      [productId, propertyId]
    );

    if (productRes.rowCount === 0) {
      throw Object.assign(
        new Error(`Produk dengan id ${productId} tidak ditemukan pada properti ${propertyId}`),
        { statusCode: 404, code: 'PRODUCT_NOT_FOUND' }
      );
    }

    const product = productRes.rows[0];
    if (!product.track_stock) {
      throw Object.assign(
        new Error(`Produk "${product.name}" tidak dikonfigurasi untuk pencatatan stok (track_stock = false)`),
        { statusCode: 400, code: 'PRODUCT_STOCK_NOT_TRACKED' }
      );
    }

    const baseUnitCode = product.canonical_base_unit_code || product.base_unit;
    if (!baseUnitCode) {
      throw Object.assign(
        new Error(`Produk "${product.name}" belum memiliki satuan dasar yang terdefinisi`),
        { statusCode: 400, code: 'PRODUCT_BASE_UNIT_NOT_CONFIGURED' }
      );
    }

    // ── Guard 2: Validasi lokasi ──
    const locRes = await client.query(
      `SELECT id, property_id, code, name, location_type, is_active
         FROM stock_locations
        WHERE id = $1 AND property_id = $2`,
      [locationId, propertyId]
    );

    if (locRes.rowCount === 0) {
      throw Object.assign(
        new Error(`Lokasi stok dengan id ${locationId} tidak ditemukan pada properti ${propertyId}`),
        { statusCode: 404, code: 'LOCATION_NOT_FOUND' }
      );
    }
    const location = locRes.rows[0];
    if (!location.is_active) {
      throw Object.assign(
        new Error(`Lokasi stok "${location.name}" (${location.code}) sedang tidak aktif`),
        { statusCode: 400, code: 'LOCATION_INACTIVE' }
      );
    }

    // ── Kuantitas & Kemasan (R-06) ──
    let baseQuantityDelta: string;
    let packagingId: number | null = null;
    let packagingCode: string | null = null;
    let packagingLabel: string | null = null;

    if (params.packaging_id !== undefined && params.packaging_id !== null) {
      const parsedPkgId = Number(params.packaging_id);
      if (!Number.isInteger(parsedPkgId) || parsedPkgId <= 0) {
        throw Object.assign(new Error('packaging_id harus berupa bilangan bulat positif'), {
          statusCode: 400,
          code: 'VALIDATION_ERROR',
        });
      }

      const pkgRes = await client.query(
        `SELECT id, property_id, menu_item_id, packaging_code, packaging_label,
                base_unit_code, to_base_factor, is_active
           FROM product_packaging_conversions
          WHERE id = $1 AND property_id = $2 AND menu_item_id = $3`,
        [parsedPkgId, propertyId, productId]
      );

      if (pkgRes.rowCount === 0) {
        throw Object.assign(new Error(`Kemasan konversi tidak ditemukan untuk produk ini`), {
          statusCode: 404,
          code: 'PACKAGING_NOT_FOUND',
        });
      }
      const pkg = pkgRes.rows[0];
      if (!pkg.is_active) {
        throw Object.assign(
          new Error(`Kemasan konversi "${pkg.packaging_label}" (${pkg.packaging_code}) sedang tidak aktif`),
          { statusCode: 400, code: 'PACKAGING_INACTIVE' }
        );
      }

      const conv = convertPackagingToBaseQuantity({
        packagingQty: params.quantity,
        toBaseFactor: pkg.to_base_factor,
        baseUnitCode: product.canonical_base_unit_code || pkg.base_unit_code,
      });
      if (!conv.ok) {
        throw Object.assign(new Error(conv.error), { statusCode: conv.status, code: conv.code });
      }

      baseQuantityDelta = conv.formatted3;
      packagingId = Number(pkg.id);
      packagingCode = pkg.packaging_code;
      packagingLabel = pkg.packaging_label;
    } else {
      let parsedQty;
      if (product.canonical_base_unit_code) {
        parsedQty = parseCanonicalQuantityInput(params.quantity, product.canonical_base_unit_code, {
          allowZero: false,
          fieldLabel: 'Kuantitas penyesuaian stok',
        });
      } else {
        parsedQty = parseStrictDecimalString(params.quantity, 'Kuantitas penyesuaian stok');
      }

      if (!parsedQty.ok) {
        throw Object.assign(new Error(parsedQty.error), { statusCode: parsedQty.status, code: parsedQty.code });
      }

      if (parsedQty.milli <= 0n) {
        throw Object.assign(new Error('Kuantitas penyesuaian stok harus lebih besar dari 0'), {
          statusCode: 400,
          code: 'VALIDATION_ERROR',
        });
      }

      baseQuantityDelta = parsedQty.formatted3;
    }

    const baseQtyMilli = BigInt(Math.round(Number(baseQuantityDelta) * 1000));

    // ── Guard Saldo Tidak Boleh Negatif (INSUFFICIENT_STOCK_BALANCE) ──
    const balanceRes = await client.query(
      `SELECT id, quantity
         FROM stock_balances
        WHERE property_id = $1 AND product_id = $2 AND location_id = $3
        FOR UPDATE`,
      [propertyId, productId, locationId]
    );

    const currentBalanceMilli =
      balanceRes.rows.length > 0 ? BigInt(Math.round(Number(balanceRes.rows[0].quantity) * 1000)) : 0n;

    if (adjustmentType === 'OUT' && currentBalanceMilli < baseQtyMilli) {
      const curBalFormatted = (Number(currentBalanceMilli) / 1000).toFixed(3);
      const reqQtyFormatted = (Number(baseQtyMilli) / 1000).toFixed(3);
      throw Object.assign(
        new Error(
          `Saldo stok tidak mencukupi untuk penyesuaian keluar. Saldo saat ini: ${curBalFormatted}, dibutuhkan: ${reqQtyFormatted}`
        ),
        {
          statusCode: 400,
          code: 'INSUFFICIENT_STOCK_BALANCE',
        }
      );
    }

    // ── Fingerprint & Idempotency (R-05) ──
    const payloadFingerprint = computeStockAdjustmentFingerprint({
      property_id: propertyId,
      product_id: productId,
      location_id: locationId,
      adjustment_type: adjustmentType,
      reason_code: reasonCode,
      quantity: String(params.quantity).trim(),
      packaging_id: packagingId,
    });

    const existingOpRes = await client.query(
      `SELECT id, operation_type, operation_key, payload_fingerprint, notes, metadata, created_at
         FROM stock_operations
        WHERE property_id = $1 AND operation_key = $2`,
      [propertyId, opKey]
    );

    if (existingOpRes.rows.length > 0) {
      const existingOp = existingOpRes.rows[0];
      if (existingOp.payload_fingerprint === payloadFingerprint) {
        // Idempotent Replay
        const replayRes = await client.query(
          `SELECT sm.id AS movement_id, sm.quantity_delta, sm.base_unit_code,
                  sm.packaging_id, sm.packaging_code, sm.packaging_label,
                  sb.quantity AS current_balance, sm.created_at
             FROM stock_movements sm
             LEFT JOIN stock_balances sb ON sb.property_id = sm.property_id AND sb.product_id = sm.product_id AND sb.location_id = sm.location_id
            WHERE sm.operation_id = $1
            LIMIT 1`,
          [existingOp.id]
        );

        if (replayRes.rows.length > 0) {
          const row = replayRes.rows[0];
          if (isPool) await client.query('COMMIT');
          return {
            operation_id: Number(existingOp.id),
            operation_type: 'STOCK_ADJUSTMENT',
            operation_key: existingOp.operation_key,
            movement_id: Number(row.movement_id),
            property_id: propertyId,
            product_id: productId,
            location_id: locationId,
            adjustment_type: adjustmentType,
            reason_code: reasonCode,
            quantity_delta: String(row.quantity_delta),
            base_unit_code: row.base_unit_code,
            packaging_id: row.packaging_id ? Number(row.packaging_id) : null,
            packaging_code: row.packaging_code ?? null,
            packaging_label: row.packaging_label ?? null,
            current_balance: String(row.current_balance ?? '0.000'),
            is_replay: true,
            notes: existingOp.notes ?? null,
            created_at: row.created_at,
          };
        }
      }

      throw Object.assign(
        new Error(
          `operation_key "${opKey}" sudah digunakan untuk operasi stok lain dengan payload berbeda. Gunakan operation_key unik.`
        ),
        {
          statusCode: 409,
          code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
        }
      );
    }

    // ── Eksekusi Mutasi ──
    const metadataPayload = {
      adjustment_type: adjustmentType,
      reason_code: reasonCode,
      packaging_id: packagingId,
      original_quantity: String(params.quantity).trim(),
    };

    const opInsertRes = await client.query(
      `INSERT INTO stock_operations (
         property_id, operation_type, operation_key, payload_fingerprint,
         notes, metadata, created_by, created_at
       ) VALUES (
         $1, 'STOCK_ADJUSTMENT', $2, $3,
         $4, $5, $6, NOW()
       )
       RETURNING id, created_at`,
      [propertyId, opKey, payloadFingerprint, notes, JSON.stringify(metadataPayload), createdBy]
    );
    const opRow = opInsertRes.rows[0];

    const signedDeltaMilli = adjustmentType === 'OUT' ? -baseQtyMilli : baseQtyMilli;
    const signedDeltaStr =
      (signedDeltaMilli < 0n ? '-' : '') + (Number(signedDeltaMilli < 0n ? -signedDeltaMilli : signedDeltaMilli) / 1000).toFixed(3);

    const movRes = await client.query(
      `INSERT INTO stock_movements (
         operation_id, property_id, product_id, location_id,
         packaging_id, packaging_code, packaging_label,
         quantity_delta, base_unit_code, created_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7,
         $8, $9, NOW()
       )
       RETURNING id`,
      [
        opRow.id,
        propertyId,
        productId,
        locationId,
        packagingId,
        packagingCode,
        packagingLabel,
        signedDeltaStr,
        baseUnitCode,
      ]
    );
    const movRow = movRes.rows[0];

    // Ambil dan kunci saldo saat ini terlebih dahulu dengan SELECT FOR UPDATE
    const existingBalRes = await client.query(
      `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3 FOR UPDATE`,
      [propertyId, productId, locationId]
    );
    const currentQty = existingBalRes.rows.length > 0 ? parseFloat(existingBalRes.rows[0].quantity) : 0;
    const deltaQty = parseFloat(signedDeltaStr);
    const nextQty = currentQty + deltaQty;

    // Jika nextQty < -0.000001, batalkan transaksi dan lempar error INSUFFICIENT_STOCK_BALANCE
    if (nextQty < -0.000001) {
      throw Object.assign(
        new Error(
          `Saldo stok tidak mencukupi untuk penyesuaian keluar. Saldo saat ini: ${currentQty.toFixed(3)}, dibutuhkan: ${Math.abs(deltaQty).toFixed(3)}`
        ),
        {
          statusCode: 400,
          code: 'INSUFFICIENT_STOCK_BALANCE',
        }
      );
    }

    // Hitung finalBalance = Math.max(0, nextQty).toFixed(3), lalu simpan ke database dengan nilai non-negatif
    const finalBalance = Math.max(0, nextQty).toFixed(3);
    const balRes = await client.query(
      `INSERT INTO stock_balances (property_id, product_id, location_id, quantity, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (property_id, product_id, location_id)
       DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = NOW()
       RETURNING quantity`,
      [propertyId, productId, locationId, finalBalance]
    );
    const newBalance = balRes.rows[0].quantity;

    if (isPool) await client.query('COMMIT');

    return {
      operation_id: Number(opRow.id),
      operation_type: 'STOCK_ADJUSTMENT',
      operation_key: opKey,
      movement_id: Number(movRow.id),
      property_id: propertyId,
      product_id: productId,
      location_id: locationId,
      adjustment_type: adjustmentType,
      reason_code: reasonCode,
      quantity_delta: signedDeltaStr,
      base_unit_code: baseUnitCode,
      packaging_id: packagingId,
      packaging_code: packagingCode,
      packaging_label: packagingLabel,
      current_balance: String(newBalance),
      is_replay: false,
      notes,
      created_at: opRow.created_at,
    };
  } catch (err) {
    if (isPool) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
    }
    throw err;
  } finally {
    if (isPool) {
      client.release();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Domain Function: recordStockOpname
// ─────────────────────────────────────────────────────────────────────────────

export async function recordStockOpname(
  clientOrPool: Pool | PoolClient | any,
  params: RecordStockOpnameParams
): Promise<StockOpnameResult> {
  const propertyId = Number(params.property_id);
  const locationId = Number(params.location_id);
  const opKey = String(params.operation_key || '').trim();
  const notes = params.notes !== undefined && params.notes !== null ? String(params.notes).trim() : null;
  const createdBy = params.created_by ? Number(params.created_by) : null;

  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw Object.assign(new Error('property_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!Number.isInteger(locationId) || locationId <= 0) {
    throw Object.assign(new Error('location_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!opKey) {
    throw Object.assign(new Error('operation_key wajib disertakan sebagai teks non-kosong'), {
      statusCode: 400,
      code: 'OPERATION_KEY_REQUIRED',
    });
  }
  if (!Array.isArray(params.items) || params.items.length === 0) {
    throw Object.assign(new Error('items opname harus berupa array dengan minimal 1 produk'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  // Cek duplikasi produk dalam daftar item
  const productIdsSet = new Set<number>();
  for (const item of params.items) {
    const pid = Number(item.product_id);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw Object.assign(new Error('product_id pada item opname harus bilangan bulat positif'), {
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      });
    }
    if (productIdsSet.has(pid)) {
      throw Object.assign(new Error(`Produk dengan id ${pid} tercantum lebih dari satu kali dalam satu sesi opname`), {
        statusCode: 400,
        code: 'DUPLICATE_PRODUCT_IN_OPNAME',
      });
    }
    productIdsSet.add(pid);
  }

  const isPool = typeof clientOrPool.connect === 'function';
  const client: PoolClient = isPool ? await clientOrPool.connect() : clientOrPool;

  try {
    if (isPool) {
      await client.query('BEGIN');
    }

    // ── Validasi Lokasi ──
    const locRes = await client.query(
      `SELECT id, property_id, code, name, location_type, is_active
         FROM stock_locations
        WHERE id = $1 AND property_id = $2`,
      [locationId, propertyId]
    );

    if (locRes.rowCount === 0) {
      throw Object.assign(
        new Error(`Lokasi stok dengan id ${locationId} tidak ditemukan pada properti ${propertyId}`),
        { statusCode: 404, code: 'LOCATION_NOT_FOUND' }
      );
    }
    const location = locRes.rows[0];
    if (!location.is_active) {
      throw Object.assign(
        new Error(`Lokasi stok "${location.name}" (${location.code}) sedang tidak aktif`),
        { statusCode: 400, code: 'LOCATION_INACTIVE' }
      );
    }

    // ── Fingerprint & Idempotency Check (R-05) ──
    const payloadFingerprint = computeStockOpnameFingerprint({
      property_id: propertyId,
      location_id: locationId,
      items: params.items,
    });

    const existingOpRes = await client.query(
      `SELECT id, operation_type, operation_key, payload_fingerprint, notes, metadata, created_at
         FROM stock_operations
        WHERE property_id = $1 AND operation_key = $2`,
      [propertyId, opKey]
    );

    if (existingOpRes.rows.length > 0) {
      const existingOp = existingOpRes.rows[0];
      if (existingOp.payload_fingerprint === payloadFingerprint) {
        // Idempotent Replay
        const meta = typeof existingOp.metadata === 'string' ? JSON.parse(existingOp.metadata) : existingOp.metadata || {};
        if (isPool) await client.query('COMMIT');
        return {
          operation_id: Number(existingOp.id),
          operation_type: 'STOCK_OPNAME',
          operation_key: existingOp.operation_key,
          property_id: propertyId,
          location_id: locationId,
          items: meta.items_summary || [],
          notes: existingOp.notes ?? null,
          is_replay: true,
          created_at: existingOp.created_at,
        };
      }

      throw Object.assign(
        new Error(
          `operation_key "${opKey}" sudah digunakan untuk operasi stok lain dengan payload berbeda. Gunakan operation_key unik.`
        ),
        {
          statusCode: 409,
          code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
        }
      );
    }

    // Urutkan item berdasarkan product_id ASC guna mencegah PostgreSQL deadlocks
    const sortedItems = [...params.items].sort((a, b) => Number(a.product_id) - Number(b.product_id));

    // Siapkan wadah hasil
    const processedItemResults: StockOpnameItemResult[] = [];
    const movementsToInsert: Array<{
      productId: number;
      packagingId: number | null;
      packagingCode: string | null;
      packagingLabel: string | null;
      deltaStr: string;
      baseUnitCode: string;
      unitCostStr: string | null;
      itemIndex: number;
      physicalBaseQtyStr: string;
    }> = [];

    for (let i = 0; i < sortedItems.length; i++) {
      const item = sortedItems[i];
      const pid = Number(item.product_id);

      // Kunci produk FOR UPDATE beserta snapshot biaya persediaan saat opname
      const prodRes = await client.query(
        `SELECT id, property_id, name, base_unit, canonical_base_unit_code, track_stock, is_active,
                CASE
                  WHEN (to_jsonb(pos_menu_items)->>'average_cost')::numeric IS NOT NULL AND (
                    (to_jsonb(pos_menu_items)->>'average_cost')::numeric > 0
                    OR (
                      (to_jsonb(pos_menu_items)->>'average_cost')::numeric = 0
                      AND EXISTS (
                        SELECT 1
                        FROM stock_movements sm_zero
                        WHERE sm_zero.property_id = pos_menu_items.property_id
                          AND sm_zero.product_id = pos_menu_items.id
                          AND sm_zero.unit_cost = 0
                          AND sm_zero.quantity_delta > 0
                          AND COALESCE((
                            SELECT SUM(sm_prev.quantity_delta)
                            FROM stock_movements sm_prev
                            WHERE sm_prev.property_id = sm_zero.property_id
                              AND sm_prev.product_id = sm_zero.product_id
                              AND (
                                sm_prev.created_at < sm_zero.created_at
                                OR (sm_prev.created_at = sm_zero.created_at AND sm_prev.id < sm_zero.id)
                              )
                          ), 0) <= 0
                          AND NOT EXISTS (
                            SELECT 1
                            FROM stock_movements sm_pos
                            WHERE sm_pos.property_id = sm_zero.property_id
                              AND sm_pos.product_id = sm_zero.product_id
                              AND sm_pos.unit_cost > 0
                              AND (
                                sm_pos.created_at > sm_zero.created_at
                                OR (sm_pos.created_at = sm_zero.created_at AND sm_pos.id > sm_zero.id)
                              )
                          )
                          AND NOT EXISTS (
                            SELECT 1
                            FROM stock_movements sm_unk
                            WHERE sm_unk.property_id = sm_zero.property_id
                              AND sm_unk.product_id = sm_zero.product_id
                              AND sm_unk.unit_cost IS NULL
                              AND sm_unk.quantity_delta > 0
                              AND (
                                sm_unk.created_at > sm_zero.created_at
                                OR (sm_unk.created_at = sm_zero.created_at AND sm_unk.id > sm_zero.id)
                              )
                              AND COALESCE((
                                SELECT SUM(sm_prev_unk.quantity_delta)
                                FROM stock_movements sm_prev_unk
                                WHERE sm_prev_unk.property_id = sm_unk.property_id
                                  AND sm_prev_unk.product_id = sm_unk.product_id
                                  AND (
                                    sm_prev_unk.created_at < sm_unk.created_at
                                    OR (sm_prev_unk.created_at = sm_unk.created_at AND sm_prev_unk.id < sm_unk.id)
                                  )
                              ), 0) <= 0
                              AND NOT EXISTS (
                                SELECT 1
                                FROM stock_movements sm_tr_out
                                JOIN stock_operations so_tr
                                  ON so_tr.id = sm_unk.operation_id
                                 AND so_tr.property_id = sm_unk.property_id
                                 AND so_tr.operation_type = 'STOCK_TRANSFER'
                                WHERE sm_tr_out.property_id = sm_unk.property_id
                                  AND sm_tr_out.product_id = sm_unk.product_id
                                  AND sm_tr_out.operation_id = sm_unk.operation_id
                                  AND sm_tr_out.location_id <> sm_unk.location_id
                                  AND sm_tr_out.unit_cost IS NULL
                                  AND sm_tr_out.quantity_delta = -sm_unk.quantity_delta
                                  AND sm_tr_out.id < sm_unk.id
                                  AND NOT EXISTS (
                                    SELECT 1
                                    FROM stock_movements sm_mid
                                    WHERE sm_mid.property_id = sm_unk.property_id
                                      AND sm_mid.product_id = sm_unk.product_id
                                      AND sm_mid.id > sm_tr_out.id
                                      AND sm_mid.id < sm_unk.id
                                  )
                              )
                          )
                      )
                    )
                  ) THEN (to_jsonb(pos_menu_items)->>'average_cost')::numeric
                  ELSE NULL
                END AS snapshot_unit_cost
           FROM pos_menu_items
          WHERE id = $1 AND property_id = $2
          FOR UPDATE`,
        [pid, propertyId]
      );

      if (prodRes.rowCount === 0) {
        throw Object.assign(
          new Error(`Produk dengan id ${pid} tidak ditemukan pada properti ${propertyId}`),
          { statusCode: 404, code: 'PRODUCT_NOT_FOUND' }
        );
      }

      const product = prodRes.rows[0];
      if (!product.track_stock) {
        throw Object.assign(
          new Error(`Produk "${product.name}" tidak dikonfigurasi untuk pencatatan stok (track_stock = false)`),
          { statusCode: 400, code: 'PRODUCT_STOCK_NOT_TRACKED' }
        );
      }

      const baseUnitCode = product.canonical_base_unit_code || product.base_unit;

      // Konversi kuantitas fisik (R-06 jika via kemasan)
      let physicalBaseQtyStr: string;
      let packagingId: number | null = null;
      let packagingCode: string | null = null;
      let packagingLabel: string | null = null;

      if (item.packaging_id !== undefined && item.packaging_id !== null) {
        const parsedPkgId = Number(item.packaging_id);
        const pkgRes = await client.query(
          `SELECT id, property_id, menu_item_id, packaging_code, packaging_label,
                  base_unit_code, to_base_factor, is_active
             FROM product_packaging_conversions
            WHERE id = $1 AND property_id = $2 AND menu_item_id = $3`,
          [parsedPkgId, propertyId, pid]
        );

        if (pkgRes.rowCount === 0) {
          throw Object.assign(new Error(`Kemasan konversi tidak ditemukan untuk produk ${product.name}`), {
            statusCode: 404,
            code: 'PACKAGING_NOT_FOUND',
          });
        }
        const pkg = pkgRes.rows[0];
        const conv = convertPackagingToBaseQuantity({
          packagingQty: item.physical_quantity,
          toBaseFactor: pkg.to_base_factor,
          baseUnitCode: product.canonical_base_unit_code || pkg.base_unit_code,
        });
        if (!conv.ok) {
          throw Object.assign(new Error(conv.error), { statusCode: conv.status, code: conv.code });
        }
        physicalBaseQtyStr = conv.formatted3;
        packagingId = Number(pkg.id);
        packagingCode = pkg.packaging_code;
        packagingLabel = pkg.packaging_label;
      } else {
        let parsedQty;
        if (product.canonical_base_unit_code) {
          parsedQty = parseCanonicalQuantityInput(item.physical_quantity, product.canonical_base_unit_code, {
            allowZero: true,
            fieldLabel: `Kuantitas fisik produk ${product.name}`,
          });
        } else {
          parsedQty = parseStrictDecimalString(item.physical_quantity, `Kuantitas fisik produk ${product.name}`);
        }

        if (!parsedQty.ok) {
          throw Object.assign(new Error(parsedQty.error), { statusCode: parsedQty.status, code: parsedQty.code });
        }
        if (parsedQty.milli < 0n) {
          throw Object.assign(new Error(`Kuantitas fisik produk ${product.name} tidak boleh negatif`), {
            statusCode: 400,
            code: 'VALIDATION_ERROR',
          });
        }
        physicalBaseQtyStr = parsedQty.formatted3;
      }

      const physicalMilli = BigInt(Math.round(Number(physicalBaseQtyStr) * 1000));

      // Saldo sistem saat ini
      const balRes = await client.query(
        `SELECT quantity
           FROM stock_balances
          WHERE property_id = $1 AND product_id = $2 AND location_id = $3
          FOR UPDATE`,
        [propertyId, pid, locationId]
      );

      const systemMilli = balRes.rows.length > 0 ? BigInt(Math.round(Number(balRes.rows[0].quantity) * 1000)) : 0n;
      const systemQtyStr = (Number(systemMilli) / 1000).toFixed(3);

      const varianceMilli = physicalMilli - systemMilli;
      let status: 'MATCH' | 'SURPLUS' | 'DEFICIT';
      let varianceStr: string;

      if (varianceMilli > 0n) {
        status = 'SURPLUS';
        varianceStr = (Number(varianceMilli) / 1000).toFixed(3);
      } else if (varianceMilli < 0n) {
        status = 'DEFICIT';
        varianceStr = '-' + (Number(-varianceMilli) / 1000).toFixed(3);
      } else {
        status = 'MATCH';
        varianceStr = '0.000';
      }

      const hasSnapshotCost =
        product.snapshot_unit_cost !== null &&
        product.snapshot_unit_cost !== undefined &&
        String(product.snapshot_unit_cost).trim() !== '' &&
        Number.isFinite(Number(product.snapshot_unit_cost));
      const snapshotUnitCostStr = hasSnapshotCost ? parseFloat(String(product.snapshot_unit_cost)).toFixed(2) : null;

      processedItemResults.push({
        product_id: pid,
        product_name: product.name,
        base_unit_code: baseUnitCode,
        system_quantity: systemQtyStr,
        physical_quantity: physicalBaseQtyStr,
        variance_quantity: varianceStr,
        status,
        movement_id: null,
        packaging_id: packagingId,
        unit_cost: snapshotUnitCostStr,
        notes: item.notes ?? null,
      });

      if (varianceMilli !== 0n) {
        movementsToInsert.push({
          productId: pid,
          packagingId,
          packagingCode,
          packagingLabel,
          deltaStr: varianceStr,
          baseUnitCode,
          unitCostStr: snapshotUnitCostStr,
          itemIndex: i,
          physicalBaseQtyStr,
        });
      }
    }

    // Buat header stock_operations
    const opInsertRes = await client.query(
      `INSERT INTO stock_operations (
         property_id, operation_type, operation_key, payload_fingerprint,
         notes, metadata, created_by, created_at
       ) VALUES (
         $1, 'STOCK_OPNAME', $2, $3,
         $4, $5, $6, NOW()
       )
       RETURNING id, created_at`,
      [propertyId, opKey, payloadFingerprint, notes, JSON.stringify({ location_id: locationId }), createdBy]
    );
    const opRow = opInsertRes.rows[0];

    // Eksekusi mutasi ledger untuk variansi != 0
    for (const mov of movementsToInsert) {
      const movRes = await client.query(
        `INSERT INTO stock_movements (
           operation_id, property_id, product_id, location_id,
           packaging_id, packaging_code, packaging_label,
           quantity_delta, base_unit_code, unit_cost, created_at
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7,
           $8, $9, $10, NOW()
         )
         RETURNING id`,
        [
          opRow.id,
          propertyId,
          mov.productId,
          locationId,
          mov.packagingId,
          mov.packagingCode,
          mov.packagingLabel,
          mov.deltaStr,
          mov.baseUnitCode,
          mov.unitCostStr,
        ]
      );
      const movId = Number(movRes.rows[0].id);
      processedItemResults[mov.itemIndex].movement_id = movId;

      // Update stock_balances tepat sesuai saldo fisik (SELECT FOR UPDATE -> non-negatif -> INSERT ON CONFLICT)
      const existingOpnameBalRes = await client.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3 FOR UPDATE`,
        [propertyId, mov.productId, locationId]
      );
      const currentOpnameQty = existingOpnameBalRes.rows.length > 0 ? parseFloat(existingOpnameBalRes.rows[0].quantity) : 0;
      const opnameDeltaQty = parseFloat(mov.deltaStr);
      const nextOpnameQty = currentOpnameQty + opnameDeltaQty;

      if (nextOpnameQty < -0.000001) {
        throw Object.assign(
          new Error(`Saldo stok hasil opname tidak boleh negatif`),
          {
            statusCode: 400,
            code: 'INSUFFICIENT_STOCK_BALANCE',
          }
        );
      }

      const finalOpnameBalance = Math.max(0, nextOpnameQty).toFixed(3);
      await client.query(
        `INSERT INTO stock_balances (property_id, product_id, location_id, quantity, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (property_id, product_id, location_id)
         DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = NOW()`,
        [propertyId, mov.productId, locationId, finalOpnameBalance]
      );
    }

    // Simpan ringkasan item ke metadata stock_operations
    await client.query(
      `UPDATE stock_operations
          SET metadata = $1
        WHERE id = $2`,
      [JSON.stringify({ location_id: locationId, items_summary: processedItemResults }), opRow.id]
    );

    if (isPool) await client.query('COMMIT');

    return {
      operation_id: Number(opRow.id),
      operation_type: 'STOCK_OPNAME',
      operation_key: opKey,
      property_id: propertyId,
      location_id: locationId,
      items: processedItemResults,
      notes,
      is_replay: false,
      created_at: opRow.created_at,
    };
  } catch (err) {
    if (isPool) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
    }
    throw err;
  } finally {
    if (isPool) {
      client.release();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Domain Function: recordStockTransfer
// ─────────────────────────────────────────────────────────────────────────────

export async function recordStockTransfer(
  clientOrPool: Pool | PoolClient | any,
  params: RecordStockTransferParams
): Promise<StockTransferResult> {
  const propertyId = Number(params.property_id);
  const fromLocationId = Number(params.from_location_id);
  const toLocationId = Number(params.to_location_id);
  const opKey = String(params.operation_key || '').trim();
  const notes = params.notes !== undefined && params.notes !== null ? String(params.notes).trim() : null;
  const createdBy = params.created_by ? Number(params.created_by) : null;

  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw Object.assign(new Error('property_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!Number.isInteger(fromLocationId) || fromLocationId <= 0) {
    throw Object.assign(new Error('from_location_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!Number.isInteger(toLocationId) || toLocationId <= 0) {
    throw Object.assign(new Error('to_location_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (fromLocationId === toLocationId) {
    throw Object.assign(new Error('Lokasi asal dan tujuan transfer tidak boleh sama'), {
      statusCode: 400,
      code: 'SAME_LOCATION_TRANSFER_FORBIDDEN',
    });
  }
  if (!opKey) {
    throw Object.assign(new Error('operation_key wajib disertakan sebagai teks non-kosong'), {
      statusCode: 400,
      code: 'OPERATION_KEY_REQUIRED',
    });
  }
  if (!Array.isArray(params.items) || params.items.length === 0) {
    throw Object.assign(new Error('items transfer harus berupa array dengan minimal 1 produk'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  // Cek duplikasi produk dalam daftar transfer
  const productIdsSet = new Set<number>();
  for (const item of params.items) {
    const pid = Number(item.product_id);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw Object.assign(new Error('product_id pada item transfer harus bilangan bulat positif'), {
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      });
    }
    if (productIdsSet.has(pid)) {
      throw Object.assign(new Error(`Produk dengan id ${pid} tercantum lebih dari satu kali dalam transfer ini`), {
        statusCode: 400,
        code: 'DUPLICATE_PRODUCT_IN_TRANSFER',
      });
    }
    productIdsSet.add(pid);
  }

  const isPool = typeof clientOrPool.connect === 'function';
  const client: PoolClient = isPool ? await clientOrPool.connect() : clientOrPool;

  try {
    if (isPool) {
      await client.query('BEGIN');
    }

    // ── Validasi Lokasi Asal dan Tujuan ──
    const locRes = await client.query(
      `SELECT id, code, name, is_active
         FROM stock_locations
        WHERE id IN ($1, $2) AND property_id = $3`,
      [fromLocationId, toLocationId, propertyId]
    );

    const fromLoc = locRes.rows.find((r: any) => Number(r.id) === fromLocationId);
    const toLoc = locRes.rows.find((r: any) => Number(r.id) === toLocationId);

    if (!fromLoc) {
      throw Object.assign(new Error(`Lokasi asal transfer id ${fromLocationId} tidak ditemukan`), {
        statusCode: 404,
        code: 'LOCATION_NOT_FOUND',
      });
    }
    if (!fromLoc.is_active) {
      throw Object.assign(
        new Error(`Lokasi asal transfer "${fromLoc.name}" (${fromLoc.code}) sedang tidak aktif`),
        { statusCode: 400, code: 'LOCATION_INACTIVE' }
      );
    }

    if (!toLoc) {
      throw Object.assign(new Error(`Lokasi tujuan transfer id ${toLocationId} tidak ditemukan`), {
        statusCode: 404,
        code: 'LOCATION_NOT_FOUND',
      });
    }
    if (!toLoc.is_active) {
      throw Object.assign(
        new Error(`Lokasi tujuan transfer "${toLoc.name}" (${toLoc.code}) sedang tidak aktif`),
        { statusCode: 400, code: 'LOCATION_INACTIVE' }
      );
    }

    // ── Fingerprint & Idempotency Check (R-05) ──
    const payloadFingerprint = computeStockTransferFingerprint({
      property_id: propertyId,
      from_location_id: fromLocationId,
      to_location_id: toLocationId,
      items: params.items,
    });

    const existingOpRes = await client.query(
      `SELECT id, operation_type, operation_key, payload_fingerprint, notes, metadata, created_at
         FROM stock_operations
        WHERE property_id = $1 AND operation_key = $2`,
      [propertyId, opKey]
    );

    if (existingOpRes.rows.length > 0) {
      const existingOp = existingOpRes.rows[0];
      if (existingOp.payload_fingerprint === payloadFingerprint) {
        // Idempotent Replay
        const meta = typeof existingOp.metadata === 'string' ? JSON.parse(existingOp.metadata) : existingOp.metadata || {};
        if (isPool) await client.query('COMMIT');
        return {
          operation_id: Number(existingOp.id),
          operation_type: 'STOCK_TRANSFER',
          operation_key: existingOp.operation_key,
          property_id: propertyId,
          from_location_id: fromLocationId,
          to_location_id: toLocationId,
          items: meta.items_summary || [],
          notes: existingOp.notes ?? null,
          is_replay: true,
          created_at: existingOp.created_at,
        };
      }

      throw Object.assign(
        new Error(
          `operation_key "${opKey}" sudah digunakan untuk operasi stok lain dengan payload berbeda. Gunakan operation_key unik.`
        ),
        {
          statusCode: 409,
          code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
        }
      );
    }

    // Urutkan item berdasarkan product_id ASC guna mencegah PostgreSQL deadlocks
    const sortedItems = [...params.items].sort((a, b) => Number(a.product_id) - Number(b.product_id));

    // Validasi kuantitas & kecukupan saldo di lokasi asal untuk semua item sebelum mutasi
    interface PreparedTransferItem {
      productId: number;
      productName: string;
      baseUnitCode: string;
      requestedQtyStr: string;
      baseQtyStr: string;
      baseQtyMilli: bigint;
      packagingId: number | null;
      packagingCode: string | null;
      packagingLabel: string | null;
      notes: string | null;
    }

    const preparedItems: PreparedTransferItem[] = [];

    for (const item of sortedItems) {
      const pid = Number(item.product_id);

      const prodRes = await client.query(
        `SELECT id, property_id, name, base_unit, canonical_base_unit_code, track_stock, is_active
           FROM pos_menu_items
          WHERE id = $1 AND property_id = $2
          FOR UPDATE`,
        [pid, propertyId]
      );

      if (prodRes.rowCount === 0) {
        throw Object.assign(
          new Error(`Produk dengan id ${pid} tidak ditemukan pada properti ${propertyId}`),
          { statusCode: 404, code: 'PRODUCT_NOT_FOUND' }
        );
      }

      const product = prodRes.rows[0];
      if (!product.track_stock) {
        throw Object.assign(
          new Error(`Produk "${product.name}" tidak dikonfigurasi untuk pencatatan stok (track_stock = false)`),
          { statusCode: 400, code: 'PRODUCT_STOCK_NOT_TRACKED' }
        );
      }

      const baseUnitCode = product.canonical_base_unit_code || product.base_unit;

      let baseQtyStr: string;
      let packagingId: number | null = null;
      let packagingCode: string | null = null;
      let packagingLabel: string | null = null;

      if (item.packaging_id !== undefined && item.packaging_id !== null) {
        const parsedPkgId = Number(item.packaging_id);
        const pkgRes = await client.query(
          `SELECT id, property_id, menu_item_id, packaging_code, packaging_label,
                  base_unit_code, to_base_factor, is_active
             FROM product_packaging_conversions
            WHERE id = $1 AND property_id = $2 AND menu_item_id = $3`,
          [parsedPkgId, propertyId, pid]
        );

        if (pkgRes.rowCount === 0) {
          throw Object.assign(new Error(`Kemasan konversi tidak ditemukan untuk produk ${product.name}`), {
            statusCode: 404,
            code: 'PACKAGING_NOT_FOUND',
          });
        }
        const pkg = pkgRes.rows[0];
        const conv = convertPackagingToBaseQuantity({
          packagingQty: item.quantity,
          toBaseFactor: pkg.to_base_factor,
          baseUnitCode: product.canonical_base_unit_code || pkg.base_unit_code,
        });
        if (!conv.ok) {
          throw Object.assign(new Error(conv.error), { statusCode: conv.status, code: conv.code });
        }
        baseQtyStr = conv.formatted3;
        packagingId = Number(pkg.id);
        packagingCode = pkg.packaging_code;
        packagingLabel = pkg.packaging_label;
      } else {
        let parsedQty;
        if (product.canonical_base_unit_code) {
          parsedQty = parseCanonicalQuantityInput(item.quantity, product.canonical_base_unit_code, {
            allowZero: false,
            fieldLabel: `Kuantitas transfer produk ${product.name}`,
          });
        } else {
          parsedQty = parseStrictDecimalString(item.quantity, `Kuantitas transfer produk ${product.name}`);
        }

        if (!parsedQty.ok) {
          throw Object.assign(new Error(parsedQty.error), { statusCode: parsedQty.status, code: parsedQty.code });
        }
        if (parsedQty.milli <= 0n) {
          throw Object.assign(new Error(`Kuantitas transfer produk ${product.name} harus lebih besar dari 0`), {
            statusCode: 400,
            code: 'VALIDATION_ERROR',
          });
        }
        baseQtyStr = parsedQty.formatted3;
      }

      const baseQtyMilli = BigInt(Math.round(Number(baseQtyStr) * 1000));

      // Guard saldo lokasi asal
      const originBalRes = await client.query(
        `SELECT quantity
           FROM stock_balances
          WHERE property_id = $1 AND product_id = $2 AND location_id = $3
          FOR UPDATE`,
        [propertyId, pid, fromLocationId]
      );

      const originBalMilli =
        originBalRes.rows.length > 0 ? BigInt(Math.round(Number(originBalRes.rows[0].quantity) * 1000)) : 0n;

      if (originBalMilli < baseQtyMilli) {
        const curBalFormatted = (Number(originBalMilli) / 1000).toFixed(3);
        const reqQtyFormatted = (Number(baseQtyMilli) / 1000).toFixed(3);
        throw Object.assign(
          new Error(
            `Saldo stok tidak mencukupi untuk transfer di lokasi asal (${fromLoc.code}). Saldo saat ini: ${curBalFormatted}, dibutuhkan: ${reqQtyFormatted}`
          ),
          {
            statusCode: 400,
            code: 'INSUFFICIENT_STOCK_BALANCE',
          }
        );
      }

      preparedItems.push({
        productId: pid,
        productName: product.name,
        baseUnitCode,
        requestedQtyStr: String(item.quantity).trim(),
        baseQtyStr,
        baseQtyMilli,
        packagingId,
        packagingCode,
        packagingLabel,
        notes: item.notes ?? null,
      });
    }

    // ── Eksekusi Atomik Transfer ──
    const opInsertRes = await client.query(
      `INSERT INTO stock_operations (
         property_id, operation_type, operation_key, payload_fingerprint,
         notes, metadata, created_by, created_at
       ) VALUES (
         $1, 'STOCK_TRANSFER', $2, $3,
         $4, $5, $6, NOW()
       )
       RETURNING id, created_at`,
      [
        propertyId,
        opKey,
        payloadFingerprint,
        notes,
        JSON.stringify({ from_location_id: fromLocationId, to_location_id: toLocationId }),
        createdBy,
      ]
    );
    const opRow = opInsertRes.rows[0];

    const resultsItems: StockTransferItemResult[] = [];

    for (const prep of preparedItems) {
      const outDeltaStr = '-' + prep.baseQtyStr;
      const inDeltaStr = prep.baseQtyStr;

      // Mutasi OUT di lokasi asal
      const outMovRes = await client.query(
        `INSERT INTO stock_movements (
           operation_id, property_id, product_id, location_id,
           packaging_id, packaging_code, packaging_label,
           quantity_delta, base_unit_code, created_at
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7,
           $8, $9, NOW()
         )
         RETURNING id`,
        [
          opRow.id,
          propertyId,
          prep.productId,
          fromLocationId,
          prep.packagingId,
          prep.packagingCode,
          prep.packagingLabel,
          outDeltaStr,
          prep.baseUnitCode,
        ]
      );
      const outMovId = Number(outMovRes.rows[0].id);

      // Potong saldo di lokasi asal
      const existingOriginBalRes = await client.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3 FOR UPDATE`,
        [propertyId, prep.productId, fromLocationId]
      );
      const originCurrentQty = existingOriginBalRes.rows.length > 0 ? parseFloat(existingOriginBalRes.rows[0].quantity) : 0;
      const originDeltaQty = -parseFloat(prep.baseQtyStr);
      const originNextQty = originCurrentQty + originDeltaQty;

      if (originNextQty < -0.000001) {
        throw Object.assign(
          new Error(
            `Saldo stok tidak mencukupi untuk transfer di lokasi asal (${fromLoc.code}). Saldo saat ini: ${originCurrentQty.toFixed(3)}, dibutuhkan: ${prep.baseQtyStr}`
          ),
          {
            statusCode: 400,
            code: 'INSUFFICIENT_STOCK_BALANCE',
          }
        );
      }

      const originFinalBalance = Math.max(0, originNextQty).toFixed(3);
      const outBalRes = await client.query(
        `INSERT INTO stock_balances (property_id, product_id, location_id, quantity, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (property_id, product_id, location_id)
         DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = NOW()
         RETURNING quantity`,
        [propertyId, prep.productId, fromLocationId, originFinalBalance]
      );
      const newOriginBal = outBalRes.rows[0].quantity;

      // Mutasi IN di lokasi tujuan
      const inMovRes = await client.query(
        `INSERT INTO stock_movements (
           operation_id, property_id, product_id, location_id,
           packaging_id, packaging_code, packaging_label,
           quantity_delta, base_unit_code, created_at
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7,
           $8, $9, NOW()
         )
         RETURNING id`,
        [
          opRow.id,
          propertyId,
          prep.productId,
          toLocationId,
          prep.packagingId,
          prep.packagingCode,
          prep.packagingLabel,
          inDeltaStr,
          prep.baseUnitCode,
        ]
      );
      const inMovId = Number(inMovRes.rows[0].id);

      // Tambah saldo di lokasi tujuan
      const existingDestBalRes = await client.query(
        `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3 FOR UPDATE`,
        [propertyId, prep.productId, toLocationId]
      );
      const destCurrentQty = existingDestBalRes.rows.length > 0 ? parseFloat(existingDestBalRes.rows[0].quantity) : 0;
      const destDeltaQty = parseFloat(prep.baseQtyStr);
      const destNextQty = destCurrentQty + destDeltaQty;
      const destFinalBalance = Math.max(0, destNextQty).toFixed(3);

      const inBalRes = await client.query(
        `INSERT INTO stock_balances (property_id, product_id, location_id, quantity, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (property_id, product_id, location_id)
         DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = NOW()
         RETURNING quantity`,
        [propertyId, prep.productId, toLocationId, destFinalBalance]
      );
      const newDestBal = inBalRes.rows[0].quantity;

      resultsItems.push({
        product_id: prep.productId,
        product_name: prep.productName,
        base_unit_code: prep.baseUnitCode,
        quantity: prep.requestedQtyStr,
        base_quantity: prep.baseQtyStr,
        out_movement_id: outMovId,
        in_movement_id: inMovId,
        origin_balance: String(newOriginBal),
        destination_balance: String(newDestBal),
        packaging_id: prep.packagingId,
        packaging_code: prep.packagingCode,
        packaging_label: prep.packagingLabel,
        notes: prep.notes,
      });
    }

    // Simpan ringkasan item ke metadata stock_operations
    await client.query(
      `UPDATE stock_operations
          SET metadata = $1
        WHERE id = $2`,
      [
        JSON.stringify({
          from_location_id: fromLocationId,
          to_location_id: toLocationId,
          items_summary: resultsItems,
        }),
        opRow.id,
      ]
    );

    if (isPool) await client.query('COMMIT');

    return {
      operation_id: Number(opRow.id),
      operation_type: 'STOCK_TRANSFER',
      operation_key: opKey,
      property_id: propertyId,
      from_location_id: fromLocationId,
      to_location_id: toLocationId,
      items: resultsItems,
      notes,
      is_replay: false,
      created_at: opRow.created_at,
    };
  } catch (err) {
    if (isPool) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
    }
    throw err;
  } finally {
    if (isPool) {
      client.release();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Query Functions: Adjustments, Opnames, Transfers
// ─────────────────────────────────────────────────────────────────────────────

export async function getStockAdjustments(
  pool: Pool | any,
  filters: StockAdjustmentFilters
): Promise<any[]> {
  const propertyId = Number(filters.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw Object.assign(new Error('property_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  const conditions: string[] = ['so.property_id = $1', "so.operation_type = 'STOCK_ADJUSTMENT'"];
  const params: any[] = [propertyId];
  let paramIdx = 2;

  if (filters.product_id) {
    conditions.push(`sm.product_id = $${paramIdx++}`);
    params.push(Number(filters.product_id));
  }

  if (filters.location_id) {
    conditions.push(`sm.location_id = $${paramIdx++}`);
    params.push(Number(filters.location_id));
  }

  if (filters.reason_code) {
    conditions.push(`so.metadata->>'reason_code' = $${paramIdx++}`);
    params.push(String(filters.reason_code).trim().toUpperCase());
  }

  if (filters.adjustment_type) {
    conditions.push(`so.metadata->>'adjustment_type' = $${paramIdx++}`);
    params.push(String(filters.adjustment_type).trim().toUpperCase());
  }

  if (filters.start_date) {
    conditions.push(`so.created_at >= $${paramIdx++}`);
    params.push(filters.start_date);
  }

  if (filters.end_date) {
    conditions.push(`so.created_at <= $${paramIdx++}`);
    params.push(filters.end_date);
  }

  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
  const offset = Math.max(Number(filters.offset) || 0, 0);

  const queryStr = `
    SELECT so.id AS operation_id,
           so.operation_key,
           so.operation_type,
           so.notes,
           so.metadata,
           so.created_by,
           so.created_at,
           sm.id AS movement_id,
           sm.product_id,
           p.name AS product_name,
           sm.location_id,
           loc.code AS location_code,
           loc.name AS location_name,
           sm.quantity_delta,
           sm.base_unit_code,
           sm.packaging_id,
           sm.packaging_code,
           sm.packaging_label
      FROM stock_operations so
      JOIN stock_movements sm ON sm.operation_id = so.id
      JOIN pos_menu_items p ON p.id = sm.product_id
      JOIN stock_locations loc ON loc.id = sm.location_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY so.id DESC
     LIMIT ${limit} OFFSET ${offset}
  `;

  const res = await pool.query(queryStr, params);
  return res.rows.map((r: any) => {
    const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata || {};
    return {
      operation_id: Number(r.operation_id),
      operation_key: r.operation_key,
      movement_id: Number(r.movement_id),
      product_id: Number(r.product_id),
      product_name: r.product_name,
      location_id: Number(r.location_id),
      location_code: r.location_code,
      location_name: r.location_name,
      adjustment_type: meta.adjustment_type || (Number(r.quantity_delta) < 0 ? 'OUT' : 'IN'),
      reason_code: meta.reason_code || 'KOREKSI_ADMIN',
      quantity_delta: String(r.quantity_delta),
      base_unit_code: r.base_unit_code,
      packaging_id: r.packaging_id ? Number(r.packaging_id) : null,
      packaging_code: r.packaging_code ?? null,
      packaging_label: r.packaging_label ?? null,
      notes: r.notes ?? null,
      created_by: r.created_by ? Number(r.created_by) : null,
      created_at: r.created_at,
    };
  });
}

export async function getStockOpnames(
  pool: Pool | any,
  filters: StockOpnameFilters
): Promise<any[]> {
  const propertyId = Number(filters.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw Object.assign(new Error('property_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  const conditions: string[] = ['so.property_id = $1', "so.operation_type = 'STOCK_OPNAME'"];
  const params: any[] = [propertyId];
  let paramIdx = 2;

  if (filters.location_id) {
    conditions.push(`(so.metadata->>'location_id')::int = $${paramIdx++}`);
    params.push(Number(filters.location_id));
  }

  if (filters.start_date) {
    conditions.push(`so.created_at >= $${paramIdx++}`);
    params.push(filters.start_date);
  }

  if (filters.end_date) {
    conditions.push(`so.created_at <= $${paramIdx++}`);
    params.push(filters.end_date);
  }

  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
  const offset = Math.max(Number(filters.offset) || 0, 0);

  const queryStr = `
    SELECT so.id AS operation_id,
           so.operation_key,
           so.operation_type,
           so.notes,
           so.metadata,
           so.created_by,
           so.created_at
      FROM stock_operations so
     WHERE ${conditions.join(' AND ')}
     ORDER BY so.id DESC
     LIMIT ${limit} OFFSET ${offset}
  `;

  const res = await pool.query(queryStr, params);
  return res.rows.map((r: any) => {
    const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata || {};
    return {
      operation_id: Number(r.operation_id),
      operation_key: r.operation_key,
      location_id: meta.location_id ? Number(meta.location_id) : null,
      items: meta.items_summary || [],
      notes: r.notes ?? null,
      created_by: r.created_by ? Number(r.created_by) : null,
      created_at: r.created_at,
    };
  });
}

export async function getStockTransfers(
  pool: Pool | any,
  filters: StockTransferFilters
): Promise<any[]> {
  const propertyId = Number(filters.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw Object.assign(new Error('property_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  const conditions: string[] = ['so.property_id = $1', "so.operation_type = 'STOCK_TRANSFER'"];
  const params: any[] = [propertyId];
  let paramIdx = 2;

  if (filters.from_location_id) {
    conditions.push(`(so.metadata->>'from_location_id')::int = $${paramIdx++}`);
    params.push(Number(filters.from_location_id));
  }

  if (filters.to_location_id) {
    conditions.push(`(so.metadata->>'to_location_id')::int = $${paramIdx++}`);
    params.push(Number(filters.to_location_id));
  }

  if (filters.start_date) {
    conditions.push(`so.created_at >= $${paramIdx++}`);
    params.push(filters.start_date);
  }

  if (filters.end_date) {
    conditions.push(`so.created_at <= $${paramIdx++}`);
    params.push(filters.end_date);
  }

  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
  const offset = Math.max(Number(filters.offset) || 0, 0);

  const queryStr = `
    SELECT so.id AS operation_id,
           so.operation_key,
           so.operation_type,
           so.notes,
           so.metadata,
           so.created_by,
           so.created_at
      FROM stock_operations so
     WHERE ${conditions.join(' AND ')}
     ORDER BY so.id DESC
     LIMIT ${limit} OFFSET ${offset}
  `;

  const res = await pool.query(queryStr, params);
  return res.rows.map((r: any) => {
    const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata || {};
    return {
      operation_id: Number(r.operation_id),
      operation_key: r.operation_key,
      from_location_id: meta.from_location_id ? Number(meta.from_location_id) : null,
      to_location_id: meta.to_location_id ? Number(meta.to_location_id) : null,
      items: meta.items_summary || [],
      notes: r.notes ?? null,
      created_by: r.created_by ? Number(r.created_by) : null,
      created_at: r.created_at,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. Express Route Handlers (MP-04B B-4)
// ─────────────────────────────────────────────────────────────────────────────

async function checkInventoryPermission(
  authUser: any,
  requiredPermissions: string[],
  pool: Pool
): Promise<boolean> {
  if (!authUser) return true;
  const role = String(authUser.role || '').toUpperCase();
  if (role === 'SUPERADMIN' || role === 'SUPER ADMIN' || role === 'ADMIN') {
    return true;
  }
  if (Array.isArray(authUser.permissions)) {
    if (requiredPermissions.some((p) => authUser.permissions.includes(p))) {
      return true;
    }
  }
  try {
    for (const perm of requiredPermissions) {
      if (await hasPermission(authUser, perm, pool)) {
        return true;
      }
    }
    return false;
  } catch (_) {
    return false;
  }
}

export function createStockAdjustmentHandler(deps: StockInventoryDeps) {
  return async function handleStockAdjustment(req: Request, res: Response) {
    try {
      const propertyId = Number(req.body?.property_id ?? req.query?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib berupa bilangan bulat positif',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const authUser = (req as any).user;
      if (authUser) {
        const canWrite = await checkInventoryPermission(authUser, ['inventory.create', 'inventory.edit'], deps.pool);
        if (!canWrite) {
          return res.status(403).json({
            status: 'ERROR',
            code: 'FORBIDDEN',
            message: 'Akses ditolak: Memerlukan izin operasional inventory.create atau inventory.edit',
          });
        }
      }

      const headerKey =
        (typeof req.headers?.['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null) ||
        (typeof req.headers?.['x-idempotency-key'] === 'string' ? req.headers['x-idempotency-key'] : null);
      const opKey = String(headerKey || req.body?.operation_key || '').trim();

      if (!opKey) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'OPERATION_KEY_REQUIRED',
          message: 'operation_key atau header Idempotency-Key wajib disertakan',
        });
      }

      const createdBy = authUser?.id ? Number(authUser.id) : null;

      const result = await recordStockAdjustment(deps.pool, {
        property_id: propertyId,
        product_id: Number(req.body?.product_id),
        location_id: Number(req.body?.location_id),
        adjustment_type: req.body?.adjustment_type,
        reason_code: req.body?.reason_code,
        quantity: req.body?.quantity,
        packaging_id: req.body?.packaging_id,
        operation_key: opKey,
        notes: req.body?.notes,
        created_by: createdBy,
      });

      const httpStatus = result.is_replay ? 200 : 201;
      return res.status(httpStatus).json({
        status: 'OK',
        data: result,
      });
    } catch (err: any) {
      const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal mencatat penyesuaian stok',
      });
    }
  };
}

export function createStockAdjustmentsQueryHandler(deps: StockInventoryDeps) {
  return async function handleStockAdjustmentsQuery(req: Request, res: Response) {
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

      const authUser = (req as any).user;
      if (authUser) {
        const canView = await checkInventoryPermission(authUser, ['inventory.view', 'inventory.create', 'inventory.edit'], deps.pool);
        if (!canView) {
          return res.status(403).json({
            status: 'ERROR',
            code: 'FORBIDDEN',
            message: 'Akses ditolak: Memerlukan izin operasional inventory.view',
          });
        }
      }

      const adjustments = await getStockAdjustments(deps.pool, {
        property_id: propertyId,
        product_id: req.query?.product_id ? Number(req.query.product_id) : undefined,
        location_id: req.query?.location_id ? Number(req.query.location_id) : undefined,
        reason_code: req.query?.reason_code ? String(req.query.reason_code) : undefined,
        adjustment_type: req.query?.adjustment_type ? String(req.query.adjustment_type) : undefined,
        start_date: req.query?.start_date ? String(req.query.start_date) : undefined,
        end_date: req.query?.end_date ? String(req.query.end_date) : undefined,
        limit: req.query?.limit ? Number(req.query.limit) : undefined,
        offset: req.query?.offset ? Number(req.query.offset) : undefined,
      });

      return res.json({
        status: 'OK',
        data: adjustments,
      });
    } catch (err: any) {
      const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal memuat riwayat penyesuaian stok',
      });
    }
  };
}

export function createStockOpnameHandler(deps: StockInventoryDeps) {
  return async function handleStockOpname(req: Request, res: Response) {
    try {
      const propertyId = Number(req.body?.property_id ?? req.query?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib berupa bilangan bulat positif',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const authUser = (req as any).user;
      if (authUser) {
        const canWrite = await checkInventoryPermission(authUser, ['inventory.create', 'inventory.edit'], deps.pool);
        if (!canWrite) {
          return res.status(403).json({
            status: 'ERROR',
            code: 'FORBIDDEN',
            message: 'Akses ditolak: Memerlukan izin operasional inventory.create atau inventory.edit',
          });
        }
      }

      const headerKey =
        (typeof req.headers?.['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null) ||
        (typeof req.headers?.['x-idempotency-key'] === 'string' ? req.headers['x-idempotency-key'] : null);
      const opKey = String(headerKey || req.body?.operation_key || '').trim();

      if (!opKey) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'OPERATION_KEY_REQUIRED',
          message: 'operation_key atau header Idempotency-Key wajib disertakan',
        });
      }

      const createdBy = authUser?.id ? Number(authUser.id) : null;

      const result = await recordStockOpname(deps.pool, {
        property_id: propertyId,
        location_id: Number(req.body?.location_id),
        items: req.body?.items,
        operation_key: opKey,
        notes: req.body?.notes,
        created_by: createdBy,
      });

      const httpStatus = result.is_replay ? 200 : 201;
      return res.status(httpStatus).json({
        status: 'OK',
        data: result,
      });
    } catch (err: any) {
      const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal mencatat stock opname',
      });
    }
  };
}

export function createStockOpnamesQueryHandler(deps: StockInventoryDeps) {
  return async function handleStockOpnamesQuery(req: Request, res: Response) {
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

      const authUser = (req as any).user;
      if (authUser) {
        const canView = await checkInventoryPermission(authUser, ['inventory.view', 'inventory.create', 'inventory.edit'], deps.pool);
        if (!canView) {
          return res.status(403).json({
            status: 'ERROR',
            code: 'FORBIDDEN',
            message: 'Akses ditolak: Memerlukan izin operasional inventory.view',
          });
        }
      }

      const opnames = await getStockOpnames(deps.pool, {
        property_id: propertyId,
        location_id: req.query?.location_id ? Number(req.query.location_id) : undefined,
        start_date: req.query?.start_date ? String(req.query.start_date) : undefined,
        end_date: req.query?.end_date ? String(req.query.end_date) : undefined,
        limit: req.query?.limit ? Number(req.query.limit) : undefined,
        offset: req.query?.offset ? Number(req.query.offset) : undefined,
      });

      return res.json({
        status: 'OK',
        data: opnames,
      });
    } catch (err: any) {
      const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal memuat riwayat stock opname',
      });
    }
  };
}

export function createStockTransferHandler(deps: StockInventoryDeps) {
  return async function handleStockTransfer(req: Request, res: Response) {
    try {
      const propertyId = Number(req.body?.property_id ?? req.query?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib berupa bilangan bulat positif',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const authUser = (req as any).user;
      if (authUser) {
        const canWrite = await checkInventoryPermission(authUser, ['inventory.create', 'inventory.edit'], deps.pool);
        if (!canWrite) {
          return res.status(403).json({
            status: 'ERROR',
            code: 'FORBIDDEN',
            message: 'Akses ditolak: Memerlukan izin operasional inventory.create atau inventory.edit',
          });
        }
      }

      const headerKey =
        (typeof req.headers?.['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null) ||
        (typeof req.headers?.['x-idempotency-key'] === 'string' ? req.headers['x-idempotency-key'] : null);
      const opKey = String(headerKey || req.body?.operation_key || '').trim();

      if (!opKey) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'OPERATION_KEY_REQUIRED',
          message: 'operation_key atau header Idempotency-Key wajib disertakan',
        });
      }

      const createdBy = authUser?.id ? Number(authUser.id) : null;

      const result = await recordStockTransfer(deps.pool, {
        property_id: propertyId,
        from_location_id: Number(req.body?.from_location_id),
        to_location_id: Number(req.body?.to_location_id),
        items: req.body?.items,
        operation_key: opKey,
        notes: req.body?.notes,
        created_by: createdBy,
      });

      const httpStatus = result.is_replay ? 200 : 201;
      return res.status(httpStatus).json({
        status: 'OK',
        data: result,
      });
    } catch (err: any) {
      const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal mencatat transfer stok',
      });
    }
  };
}

export function createStockTransfersQueryHandler(deps: StockInventoryDeps) {
  return async function handleStockTransfersQuery(req: Request, res: Response) {
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

      const authUser = (req as any).user;
      if (authUser) {
        const canView = await checkInventoryPermission(authUser, ['inventory.view', 'inventory.create', 'inventory.edit'], deps.pool);
        if (!canView) {
          return res.status(403).json({
            status: 'ERROR',
            code: 'FORBIDDEN',
            message: 'Akses ditolak: Memerlukan izin operasional inventory.view',
          });
        }
      }

      const transfers = await getStockTransfers(deps.pool, {
        property_id: propertyId,
        from_location_id: req.query?.from_location_id ? Number(req.query.from_location_id) : undefined,
        to_location_id: req.query?.to_location_id ? Number(req.query.to_location_id) : undefined,
        product_id: req.query?.product_id ? Number(req.query.product_id) : undefined,
        start_date: req.query?.start_date ? String(req.query.start_date) : undefined,
        end_date: req.query?.end_date ? String(req.query.end_date) : undefined,
        limit: req.query?.limit ? Number(req.query.limit) : undefined,
        offset: req.query?.offset ? Number(req.query.offset) : undefined,
      });

      return res.json({
        status: 'OK',
        data: transfers,
      });
    } catch (err: any) {
      const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal memuat riwayat transfer stok',
      });
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MP-04B Batch 5: Laporan Mutasi Stok, Kartu Stok / Ledger, dan Valuasi Persediaan
// ─────────────────────────────────────────────────────────────────────────────

export interface StockLedgerFilterParams {
  property_id: number;
  product_id: number;
  location_id: number;
  start_date?: string | null;
  end_date?: string | null;
}

export interface StockLedgerMovementItem {
  id?: number;
  movement_id: number;
  operation_id: number;
  operation_type: string;
  movement_type?: string;
  operation_key: string;
  reference_id?: string | null;
  transaction_id: number | null;
  quantity_delta: string;
  in_quantity: string;
  out_quantity: string;
  running_balance: string;
  base_unit_code: string;
  packaging_id: number | null;
  packaging_code: string | null;
  packaging_label: string | null;
  unit_cost: string | null;
  notes: string | null;
  created_by?: number | null;
  created_by_name?: string | null;
  created_at: string | Date;
}

export interface StockLedgerCardResult {
  property_id: number;
  product: {
    id: number;
    name: string;
    item_code: string | null;
    base_unit_code: string;
  };
  location: {
    id: number;
    code: string;
    name: string;
    type: string;
  };
  date_range: {
    start_date: string | null;
    end_date: string | null;
  };
  opening_balance: string;
  closing_balance: string;
  current_system_balance: string;
  total_in: string;
  total_out: string;
  movements: StockLedgerMovementItem[];
}

export interface InventoryValuationFilterParams {
  property_id: number;
  location_id?: number | null;
  product_id?: number | null;
  category_id?: number | null;
  search?: string | null;
}

export interface InventoryValuationItem {
  balance_id: number;
  property_id: number;
  product_id: number;
  product_name: string;
  product_item_code: string | null;
  category_id: number | null;
  category_name: string | null;
  location_id: number;
  location_code: string;
  location_name: string;
  location_type: string;
  base_unit_code: string;
  quantity: string;
  unit_cost: string | null;
  total_value: string | null;
  cost_known?: boolean;
  cost_status?: 'KNOWN' | 'UNKNOWN';
  updated_at: string | Date;
}

export interface InventoryValuationReportResult {
  property_id: number;
  filters: {
    location_id: number | null;
    product_id: number | null;
    category_id: number | null;
    search: string | null;
  };
  summary: {
    total_items: number;
    total_quantity: string;
    total_valuation_value: string;
    unknown_cost_items?: number;
  };
  items: InventoryValuationItem[];
}

export interface OpnameVarianceFilterParams {
  property_id: number;
  location_id?: number | null;
  start_date?: string | null;
  end_date?: string | null;
  status?: 'SURPLUS' | 'DEFICIT' | 'MATCH' | 'ALL' | string | null;
}

export interface OpnameVarianceItemReport {
  operation_id: number;
  operation_key: string;
  location_id: number;
  location_code?: string | null;
  location_name?: string | null;
  product_id: number;
  product_name: string;
  system_quantity: string;
  physical_quantity: string;
  variance_quantity: string;
  status: 'SURPLUS' | 'DEFICIT' | 'MATCH';
  movement_id: number | null;
  unit_cost: string | null;
  variance_value: string | null;
  cost_known?: boolean;
  cost_status?: 'KNOWN' | 'UNKNOWN';
  notes: string | null;
  counted_at: string | Date;
}

export interface OpnameVarianceReportResult {
  property_id: number;
  filters: {
    location_id: number | null;
    start_date: string | null;
    end_date: string | null;
    status: string;
  };
  summary: {
    total_sessions: number;
    total_items_counted: number;
    total_surplus_items: number;
    total_deficit_items: number;
    total_match_items: number;
    total_surplus_qty: string;
    total_deficit_qty: string;
    net_variance_qty: string;
    total_surplus_value: string;
    total_deficit_value: string;
    net_variance_value: string;
    unknown_cost_items?: number;
  };
  sessions: any[];
  items: OpnameVarianceItemReport[];
}

export function parseAsiaJakartaDateBounds(startDateStr?: string | null, endDateStr?: string | null): {
  startBound: string | null;
  endBound: string | null;
} {
  let startBound: string | null = null;
  let endBound: string | null = null;

  if (startDateStr && typeof startDateStr === 'string' && startDateStr.trim()) {
    const trimmed = startDateStr.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      startBound = `${trimmed}T00:00:00+07:00`;
    } else {
      startBound = trimmed;
    }
  }

  if (endDateStr && typeof endDateStr === 'string' && endDateStr.trim()) {
    const trimmed = endDateStr.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      endBound = `${trimmed}T23:59:59.999+07:00`;
    } else {
      endBound = trimmed;
    }
  }

  return { startBound, endBound };
}

/**
 * Kartu Stok (Stock Ledger Card)
 * Menampilkan riwayat transaksi per produk di lokasi tertentu untuk rentang tanggal (Asia/Jakarta),
 * mencakup opening balance, daftar mutasi kronologis, running balance, dan closing balance.
 */
export async function getStockLedgerCard(
  pool: Pool,
  params: StockLedgerFilterParams
): Promise<StockLedgerCardResult> {
  const propertyId = Number(params.property_id);
  const productId = Number(params.product_id);
  const locationId = Number(params.location_id);

  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw Object.assign(new Error('property_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!Number.isInteger(productId) || productId <= 0) {
    throw Object.assign(new Error('product_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!Number.isInteger(locationId) || locationId <= 0) {
    throw Object.assign(new Error('location_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  // 1. Validasi produk & lokasi
  const prodRes = await pool.query(
    `SELECT id, property_id, name, item_code, canonical_base_unit_code, base_unit, track_stock
       FROM pos_menu_items
      WHERE id = $1 AND property_id = $2`,
    [productId, propertyId]
  );
  if (prodRes.rowCount === 0) {
    throw Object.assign(new Error(`Produk dengan id ${productId} tidak ditemukan`), {
      statusCode: 404,
      code: 'PRODUCT_NOT_FOUND',
    });
  }
  const product = prodRes.rows[0];

  const locRes = await pool.query(
    `SELECT id, property_id, code, name, location_type
       FROM stock_locations
      WHERE id = $1 AND property_id = $2`,
    [locationId, propertyId]
  );
  if (locRes.rowCount === 0) {
    throw Object.assign(new Error(`Lokasi dengan id ${locationId} tidak ditemukan`), {
      statusCode: 404,
      code: 'LOCATION_NOT_FOUND',
    });
  }
  const location = locRes.rows[0];

  // 2. Saldo sistem saat ini
  const balRes = await pool.query(
    `SELECT quantity FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
    [propertyId, productId, locationId]
  );
  const currentSystemBalance = balRes.rows.length > 0 ? parseFloat(balRes.rows[0].quantity).toFixed(3) : '0.000';

  // 3. Batas Tanggal Asia/Jakarta
  const { startBound, endBound } = parseAsiaJakartaDateBounds(params.start_date, params.end_date);

  // 4. Opening Balance: Akumulasi seluruh pergerakan sebelum rentang tanggal
  let openingBalance = '0.000';
  if (startBound) {
    const openRes = await pool.query(
      `SELECT COALESCE(SUM(quantity_delta), 0) AS opening_balance
         FROM stock_movements
        WHERE property_id = $1 AND product_id = $2 AND location_id = $3
          AND created_at < $4::timestamptz`,
      [propertyId, productId, locationId, startBound]
    );
    openingBalance = parseFloat(openRes.rows[0].opening_balance).toFixed(3);
  }

  // 5. Riwayat mutasi dalam rentang
  const conditions: string[] = ['sm.property_id = $1', 'sm.product_id = $2', 'sm.location_id = $3'];
  const queryParams: any[] = [propertyId, productId, locationId];
  let pIdx = 4;

  if (startBound) {
    conditions.push(`sm.created_at >= $${pIdx++}::timestamptz`);
    queryParams.push(startBound);
  }
  if (endBound) {
    conditions.push(`sm.created_at <= $${pIdx++}::timestamptz`);
    queryParams.push(endBound);
  }

  const movRes = await pool.query(
    `SELECT
       sm.id AS movement_id,
       sm.operation_id,
       so.operation_type,
       so.operation_key,
       so.transaction_id,
       so.notes,
       so.created_by,
       COALESCE(
         NULLIF(TRIM(to_jsonb(u)->>'full_name'), ''),
         NULLIF(TRIM(to_jsonb(u)->>'name'), ''),
         NULLIF(TRIM(to_jsonb(u)->>'username'), '')
       ) AS created_by_name,
       pgr.grn_number,
       sm.quantity_delta,
       sm.base_unit_code,
       sm.packaging_id,
       sm.packaging_code,
       sm.packaging_label,
       sm.unit_cost,
       sm.created_at
      FROM stock_movements sm
      JOIN stock_operations so ON so.id = sm.operation_id
      LEFT JOIN users u ON u.id = so.created_by
      LEFT JOIN pos_goods_receipts pgr
        ON pgr.property_id = so.property_id
       AND pgr.operation_key = so.operation_key
     WHERE ${conditions.join(' AND ')}
     ORDER BY sm.created_at ASC, sm.id ASC`,
    queryParams
  );

  let runningNum = parseFloat(openingBalance);
  let totalIn = 0;
  let totalOut = 0;

  const movements: StockLedgerMovementItem[] = movRes.rows.map((row: any) => {
    const delta = parseFloat(row.quantity_delta);
    if (delta > 0) {
      totalIn += delta;
    } else if (delta < 0) {
      totalOut += Math.abs(delta);
    }
    runningNum += delta;

    return {
      id: Number(row.movement_id),
      movement_id: Number(row.movement_id),
      operation_id: Number(row.operation_id),
      operation_type: row.operation_type,
      movement_type: row.operation_type,
      operation_key: row.operation_key,
      reference_id: row.grn_number || row.operation_key || null,
      transaction_id: row.transaction_id ? Number(row.transaction_id) : null,
      quantity_delta: delta >= 0 ? `+${delta.toFixed(3)}` : delta.toFixed(3),
      in_quantity: delta > 0 ? delta.toFixed(3) : '0.000',
      out_quantity: delta < 0 ? Math.abs(delta).toFixed(3) : '0.000',
      running_balance: runningNum.toFixed(3),
      base_unit_code: row.base_unit_code,
      packaging_id: row.packaging_id ? Number(row.packaging_id) : null,
      packaging_code: row.packaging_code ?? null,
      packaging_label: row.packaging_label ?? null,
      unit_cost: row.unit_cost !== null && row.unit_cost !== undefined ? parseFloat(row.unit_cost).toFixed(2) : null,
      notes: row.notes ?? null,
      created_by: row.created_by ? Number(row.created_by) : null,
      created_by_name: row.created_by_name ?? null,
      created_at: row.created_at,
    };
  });

  const closingBalance = runningNum.toFixed(3);

  return {
    property_id: propertyId,
    product: {
      id: Number(product.id),
      name: product.name,
      item_code: product.item_code ?? null,
      base_unit_code: product.canonical_base_unit_code || product.base_unit || 'PCS',
    },
    location: {
      id: Number(location.id),
      code: location.code,
      name: location.name,
      type: location.location_type,
    },
    date_range: {
      start_date: params.start_date || null,
      end_date: params.end_date || null,
    },
    opening_balance: openingBalance,
    closing_balance: closingBalance,
    current_system_balance: currentSystemBalance,
    total_in: totalIn.toFixed(3),
    total_out: totalOut.toFixed(3),
    movements,
  };
}

/**
 * Rekap Saldo & Valuasi Persediaan (Inventory Valuation Report)
 * Menghitung kuantitas stok per lokasi, biaya rata-rata persediaan (moving average cost) per satuan dasar,
 * dan total nilai valuasi persediaan. Tidak menggunakan harga jual sebagai fallback biaya persediaan.
 */
export async function getInventoryValuationReport(
  pool: Pool,
  params: InventoryValuationFilterParams
): Promise<InventoryValuationReportResult> {
  const propertyId = Number(params.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw Object.assign(new Error('property_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  const conditions: string[] = ['sb.property_id = $1'];
  const queryParams: any[] = [propertyId];
  let pIdx = 2;

  if (params.location_id) {
    conditions.push(`sb.location_id = $${pIdx++}`);
    queryParams.push(Number(params.location_id));
  }
  if (params.product_id) {
    conditions.push(`sb.product_id = $${pIdx++}`);
    queryParams.push(Number(params.product_id));
  }
  if (params.category_id) {
    conditions.push(`pmi.category_id = $${pIdx++}`);
    queryParams.push(Number(params.category_id));
  }
  if (params.search && typeof params.search === 'string' && params.search.trim()) {
    conditions.push(`(pmi.name ILIKE $${pIdx} OR pmi.item_code ILIKE $${pIdx})`);
    queryParams.push(`%${params.search.trim()}%`);
    pIdx++;
  }

  const queryStr = `
    SELECT
      sb.id AS balance_id,
      sb.property_id,
      sb.product_id,
      pmi.name AS product_name,
      pmi.item_code AS product_item_code,
      COALESCE(pmi.canonical_base_unit_code, pmi.base_unit, 'PCS') AS base_unit_code,
      pmi.category_id,
      pc.name AS category_name,
      pmi.price AS selling_price,
      sb.location_id,
      sl.code AS location_code,
      sl.name AS location_name,
      sl.location_type,
      sb.quantity,
      sb.updated_at,
      CASE
        WHEN pmi.average_cost IS NOT NULL AND (
          pmi.average_cost > 0
          OR (
            pmi.average_cost = 0
            AND EXISTS (
              SELECT 1
              FROM stock_movements sm_zero
              WHERE sm_zero.property_id = sb.property_id
                AND sm_zero.product_id = sb.product_id
                AND sm_zero.unit_cost = 0
                AND sm_zero.quantity_delta > 0
                AND COALESCE((
                  SELECT SUM(sm_prev.quantity_delta)
                  FROM stock_movements sm_prev
                  WHERE sm_prev.property_id = sm_zero.property_id
                    AND sm_prev.product_id = sm_zero.product_id
                    AND (
                      sm_prev.created_at < sm_zero.created_at
                      OR (sm_prev.created_at = sm_zero.created_at AND sm_prev.id < sm_zero.id)
                    )
                ), 0) <= 0
                AND NOT EXISTS (
                  SELECT 1
                  FROM stock_movements sm_pos
                  WHERE sm_pos.property_id = sm_zero.property_id
                    AND sm_pos.product_id = sm_zero.product_id
                    AND sm_pos.unit_cost > 0
                    AND (
                      sm_pos.created_at > sm_zero.created_at
                      OR (sm_pos.created_at = sm_zero.created_at AND sm_pos.id > sm_zero.id)
                    )
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM stock_movements sm_unk
                  WHERE sm_unk.property_id = sm_zero.property_id
                    AND sm_unk.product_id = sm_zero.product_id
                    AND sm_unk.unit_cost IS NULL
                    AND sm_unk.quantity_delta > 0
                    AND (
                      sm_unk.created_at > sm_zero.created_at
                      OR (sm_unk.created_at = sm_zero.created_at AND sm_unk.id > sm_zero.id)
                    )
                    AND COALESCE((
                      SELECT SUM(sm_prev_unk.quantity_delta)
                      FROM stock_movements sm_prev_unk
                      WHERE sm_prev_unk.property_id = sm_unk.property_id
                        AND sm_prev_unk.product_id = sm_unk.product_id
                        AND (
                          sm_prev_unk.created_at < sm_unk.created_at
                          OR (sm_prev_unk.created_at = sm_unk.created_at AND sm_prev_unk.id < sm_unk.id)
                        )
                    ), 0) <= 0
                    AND NOT EXISTS (
                      SELECT 1
                      FROM stock_movements sm_tr_out
                      JOIN stock_operations so_tr
                        ON so_tr.id = sm_unk.operation_id
                       AND so_tr.property_id = sm_unk.property_id
                       AND so_tr.operation_type = 'STOCK_TRANSFER'
                      WHERE sm_tr_out.property_id = sm_unk.property_id
                        AND sm_tr_out.product_id = sm_unk.product_id
                        AND sm_tr_out.operation_id = sm_unk.operation_id
                        AND sm_tr_out.location_id <> sm_unk.location_id
                        AND sm_tr_out.unit_cost IS NULL
                        AND sm_tr_out.quantity_delta = -sm_unk.quantity_delta
                        AND sm_tr_out.id < sm_unk.id
                        AND NOT EXISTS (
                          SELECT 1
                          FROM stock_movements sm_mid
                          WHERE sm_mid.property_id = sm_unk.property_id
                            AND sm_mid.product_id = sm_unk.product_id
                            AND sm_mid.id > sm_tr_out.id
                            AND sm_mid.id < sm_unk.id
                        )
                    )
                )
            )
          )
        ) THEN pmi.average_cost
        ELSE NULL
      END AS unit_cost
    FROM stock_balances sb
    JOIN pos_menu_items pmi ON pmi.id = sb.product_id AND pmi.property_id = sb.property_id
    JOIN stock_locations sl ON sl.id = sb.location_id AND sl.property_id = sb.property_id
    LEFT JOIN pos_menu_categories pc ON pc.id = pmi.category_id AND pc.property_id = sb.property_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY sl.code ASC, pmi.name ASC
  `;

  const res = await pool.query(queryStr, queryParams);

  let sumQuantity = 0;
  let sumValue = 0;
  let unknownCostItems = 0;

  const items: InventoryValuationItem[] = res.rows.map((row: any) => {
    const qty = parseFloat(row.quantity);
    sumQuantity += qty;

    const hasKnownCost =
      row.unit_cost !== null &&
      row.unit_cost !== undefined &&
      String(row.unit_cost).trim() !== '' &&
      Number.isFinite(Number(row.unit_cost));

    let unitCostStr: string | null = null;
    let totalValueStr: string | null = null;

    if (hasKnownCost) {
      const unitCost = parseFloat(String(row.unit_cost));
      const totalVal = Math.round(qty * unitCost * 100) / 100;
      sumValue += totalVal;
      unitCostStr = unitCost.toFixed(2);
      totalValueStr = totalVal.toFixed(2);
    } else {
      unknownCostItems++;
    }

    return {
      balance_id: Number(row.balance_id),
      property_id: Number(row.property_id),
      product_id: Number(row.product_id),
      product_name: row.product_name,
      product_item_code: row.product_item_code ?? null,
      category_id: row.category_id ? Number(row.category_id) : null,
      category_name: row.category_name ?? null,
      location_id: Number(row.location_id),
      location_code: row.location_code,
      location_name: row.location_name,
      location_type: row.location_type,
      base_unit_code: row.base_unit_code,
      quantity: qty.toFixed(3),
      unit_cost: unitCostStr,
      total_value: totalValueStr,
      cost_known: hasKnownCost,
      cost_status: hasKnownCost ? 'KNOWN' : 'UNKNOWN',
      updated_at: row.updated_at,
    };
  });

  return {
    property_id: propertyId,
    filters: {
      location_id: params.location_id ? Number(params.location_id) : null,
      product_id: params.product_id ? Number(params.product_id) : null,
      category_id: params.category_id ? Number(params.category_id) : null,
      search: params.search ?? null,
    },
    summary: {
      total_items: items.length,
      total_quantity: sumQuantity.toFixed(3),
      total_valuation_value: sumValue.toFixed(2),
      unknown_cost_items: unknownCostItems,
    },
    items,
  };
}

/**
 * Laporan Rekap Variansi Opname (Opname Variance Report)
 * Ringkasan hasil opname fisik per periode, filter berdasarkan status (SURPLUS, DEFICIT, MATCH),
 * dan total selisih kuantitas serta nominal variansi.
 */
export async function getOpnameVarianceReport(
  pool: Pool,
  params: OpnameVarianceFilterParams
): Promise<OpnameVarianceReportResult> {
  const propertyId = Number(params.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw Object.assign(new Error('property_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  const { startBound, endBound } = parseAsiaJakartaDateBounds(params.start_date, params.end_date);

  const conditions: string[] = ['so.property_id = $1', "so.operation_type = 'STOCK_OPNAME'"];
  const queryParams: any[] = [propertyId];
  let pIdx = 2;

  if (params.location_id) {
    conditions.push(`(so.metadata->>'location_id')::int = $${pIdx++}`);
    queryParams.push(Number(params.location_id));
  }
  if (startBound) {
    conditions.push(`so.created_at >= $${pIdx++}::timestamptz`);
    queryParams.push(startBound);
  }
  if (endBound) {
    conditions.push(`so.created_at <= $${pIdx++}::timestamptz`);
    queryParams.push(endBound);
  }

  const queryStr = `
    SELECT
      so.id AS operation_id,
      so.property_id,
      so.operation_key,
      so.operation_type,
      so.notes,
      so.metadata,
      so.created_by,
      so.created_at,
      sl.id AS location_id,
      sl.code AS location_code,
      sl.name AS location_name
    FROM stock_operations so
    LEFT JOIN stock_locations sl
      ON sl.id = (so.metadata->>'location_id')::int AND sl.property_id = so.property_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY so.id DESC
  `;

  const opRes = await pool.query(queryStr, queryParams);

  // Ambil snapshot unit_cost saat opname (atau riwayat biaya terverifikasi hingga waktu opname)
  // tanpa mencampur dengan perubahan biaya setelah opname dan tanpa fallback ke harga jual (pmi.price).
  const productIds = new Set<number>();
  const movementIds = new Set<number>();
  for (const row of opRes.rows) {
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || {};
    const items = Array.isArray(meta.items_summary) ? meta.items_summary : [];
    for (const item of items) {
      if (item.product_id) productIds.add(Number(item.product_id));
      if (item.movement_id) movementIds.add(Number(item.movement_id));
    }
  }

  const movementCostMap = new Map<number, number>();
  if (movementIds.size > 0) {
    const mids = Array.from(movementIds);
    const movCostRes = await pool.query(
      `SELECT id, unit_cost
         FROM stock_movements
        WHERE property_id = $1
          AND id = ANY($2::bigint[])
          AND unit_cost IS NOT NULL`,
      [propertyId, mids]
    );
    for (const mr of movCostRes.rows) {
      movementCostMap.set(Number(mr.id), parseFloat(String(mr.unit_cost)));
    }
  }

  const productCostHistoryMap = new Map<number, Array<{ created_at: Date; id: number; unit_cost: number }>>();
  if (productIds.size > 0) {
    const pids = Array.from(productIds);
    const histRes = await pool.query(
      `SELECT id, product_id, unit_cost, created_at
         FROM stock_movements
        WHERE property_id = $1
          AND product_id = ANY($2::int[])
          AND unit_cost IS NOT NULL
        ORDER BY created_at DESC, id DESC`,
      [propertyId, pids]
    );
    for (const hr of histRes.rows) {
      const pid = Number(hr.product_id);
      const list = productCostHistoryMap.get(pid) || [];
      list.push({
        id: Number(hr.id),
        created_at: new Date(hr.created_at),
        unit_cost: parseFloat(String(hr.unit_cost)),
      });
      productCostHistoryMap.set(pid, list);
    }
  }

  const resolveOpnameEventUnitCost = (item: any, opCreatedAt: any): number | null => {
    if (
      item.unit_cost !== null &&
      item.unit_cost !== undefined &&
      String(item.unit_cost).trim() !== '' &&
      Number.isFinite(Number(item.unit_cost))
    ) {
      return parseFloat(String(item.unit_cost));
    }
    if (item.movement_id && movementCostMap.has(Number(item.movement_id))) {
      return movementCostMap.get(Number(item.movement_id))!;
    }
    const pid = Number(item.product_id);
    const history = productCostHistoryMap.get(pid) || [];
    if (history.length > 0 && opCreatedAt) {
      const opTime = new Date(opCreatedAt).getTime();
      if (Number.isFinite(opTime)) {
        const asOfEntries = history.filter((h) => h.created_at.getTime() <= opTime);
        if (asOfEntries.length > 0) {
          const distinctCosts = new Set(asOfEntries.map((h) => h.unit_cost));
          if (distinctCosts.size === 1) {
            return asOfEntries[0].unit_cost;
          }
        }
      }
    }
    return null;
  };

  const requestedStatus = params.status ? String(params.status).trim().toUpperCase() : 'ALL';

  let totalItemsCounted = 0;
  let totalSurplusItems = 0;
  let totalDeficitItems = 0;
  let totalMatchItems = 0;
  let totalSurplusQty = 0;
  let totalDeficitQty = 0;
  let netVarianceQty = 0;
  let totalSurplusValue = 0;
  let totalDeficitValue = 0;
  let netVarianceValue = 0;
  let unknownCostItems = 0;

  const sessionsList: any[] = [];
  const itemsList: OpnameVarianceItemReport[] = [];

  for (const row of opRes.rows) {
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || {};
    const items = Array.isArray(meta.items_summary) ? meta.items_summary : [];
    const locId = Number(meta.location_id || row.location_id || 0);

    sessionsList.push({
      operation_id: Number(row.operation_id),
      operation_key: row.operation_key,
      location_id: locId,
      location_code: row.location_code ?? null,
      location_name: row.location_name ?? null,
      notes: row.notes ?? null,
      created_by: row.created_by ? Number(row.created_by) : null,
      created_at: row.created_at,
      total_items: items.length,
    });

    for (const item of items) {
      totalItemsCounted++;
      const itemStatus = String(item.status || '').toUpperCase() as 'SURPLUS' | 'DEFICIT' | 'MATCH';
      const varQty = parseFloat(item.variance_quantity || 0);
      const unitCost = resolveOpnameEventUnitCost(item, row.created_at);
      const hasKnownCost = unitCost !== null && Number.isFinite(unitCost);
      const varValue = hasKnownCost ? Math.round(varQty * unitCost! * 100) / 100 : null;

      if (!hasKnownCost) {
        unknownCostItems++;
      }

      if (itemStatus === 'SURPLUS') {
        totalSurplusItems++;
        totalSurplusQty += varQty;
        if (varValue !== null) {
          totalSurplusValue += varValue;
        }
      } else if (itemStatus === 'DEFICIT') {
        totalDeficitItems++;
        totalDeficitQty += Math.abs(varQty);
        if (varValue !== null) {
          totalDeficitValue += Math.abs(varValue);
        }
      } else {
        totalMatchItems++;
      }

      netVarianceQty += varQty;
      if (varValue !== null) {
        netVarianceValue += varValue;
      }

      // Filter status
      if (requestedStatus === 'ALL' || requestedStatus === itemStatus) {
        itemsList.push({
          operation_id: Number(row.operation_id),
          operation_key: row.operation_key,
          location_id: locId,
          location_code: row.location_code ?? null,
          location_name: row.location_name ?? null,
          product_id: Number(item.product_id),
          product_name: item.product_name,
          system_quantity: parseFloat(item.system_quantity || 0).toFixed(3),
          physical_quantity: parseFloat(item.physical_quantity || 0).toFixed(3),
          variance_quantity: varQty >= 0 ? `+${varQty.toFixed(3)}` : varQty.toFixed(3),
          status: itemStatus,
          movement_id: item.movement_id ? Number(item.movement_id) : null,
          unit_cost: hasKnownCost ? unitCost!.toFixed(2) : null,
          variance_value: varValue !== null ? (varValue >= 0 ? `+${varValue.toFixed(2)}` : varValue.toFixed(2)) : null,
          cost_known: hasKnownCost,
          cost_status: hasKnownCost ? 'KNOWN' : 'UNKNOWN',
          notes: item.notes ?? null,
          counted_at: row.created_at,
        });
      }
    }
  }

  return {
    property_id: propertyId,
    filters: {
      location_id: params.location_id ? Number(params.location_id) : null,
      start_date: params.start_date || null,
      end_date: params.end_date || null,
      status: requestedStatus,
    },
    summary: {
      total_sessions: sessionsList.length,
      total_items_counted: totalItemsCounted,
      total_surplus_items: totalSurplusItems,
      total_deficit_items: totalDeficitItems,
      total_match_items: totalMatchItems,
      total_surplus_qty: totalSurplusQty.toFixed(3),
      total_deficit_qty: totalDeficitQty.toFixed(3),
      net_variance_qty: (netVarianceQty >= 0 ? '+' : '') + netVarianceQty.toFixed(3),
      total_surplus_value: totalSurplusValue.toFixed(2),
      total_deficit_value: totalDeficitValue.toFixed(2),
      net_variance_value: (netVarianceValue >= 0 ? '+' : '') + netVarianceValue.toFixed(2),
      unknown_cost_items: unknownCostItems,
    },
    sessions: sessionsList,
    items: itemsList,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. Express Route Handlers (MP-04B B-5: Reports & Ledger)
// ─────────────────────────────────────────────────────────────────────────────

export function createStockLedgerHandler(deps: StockInventoryDeps) {
  return async function handleStockLedger(req: Request, res: Response) {
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

      const authUser = (req as any).user;
      if (authUser) {
        const canView = await checkInventoryPermission(
          authUser,
          ['inventory.view', 'inventory.create', 'inventory.edit'],
          deps.pool
        );
        if (!canView) {
          return res.status(403).json({
            status: 'ERROR',
            code: 'FORBIDDEN',
            message: 'Akses ditolak: Memerlukan izin operasional inventory.view',
          });
        }
      }

      const productId = Number(req.query?.product_id);
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'product_id wajib disertakan berupa bilangan bulat positif',
        });
      }

      const locationId = Number(req.query?.location_id);
      if (!Number.isInteger(locationId) || locationId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'location_id wajib disertakan berupa bilangan bulat positif',
        });
      }

      const ledger = await getStockLedgerCard(deps.pool, {
        property_id: propertyId,
        product_id: productId,
        location_id: locationId,
        start_date: req.query?.start_date ? String(req.query.start_date) : undefined,
        end_date: req.query?.end_date ? String(req.query.end_date) : undefined,
      });

      return res.json({
        status: 'OK',
        data: ledger,
      });
    } catch (err: any) {
      const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal memuat kartu stok',
      });
    }
  };
}

export function createInventoryValuationHandler(deps: StockInventoryDeps) {
  return async function handleInventoryValuation(req: Request, res: Response) {
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

      const authUser = (req as any).user;
      if (authUser) {
        const canView = await checkInventoryPermission(
          authUser,
          ['inventory.view', 'inventory.create', 'inventory.edit'],
          deps.pool
        );
        if (!canView) {
          return res.status(403).json({
            status: 'ERROR',
            code: 'FORBIDDEN',
            message: 'Akses ditolak: Memerlukan izin operasional inventory.view',
          });
        }
      }

      const valuation = await getInventoryValuationReport(deps.pool, {
        property_id: propertyId,
        location_id: req.query?.location_id ? Number(req.query.location_id) : undefined,
        product_id: req.query?.product_id ? Number(req.query.product_id) : undefined,
        category_id: req.query?.category_id ? Number(req.query.category_id) : undefined,
        search: req.query?.search ? String(req.query.search) : undefined,
      });

      return res.json({
        status: 'OK',
        data: valuation,
      });
    } catch (err: any) {
      const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal memuat laporan valuasi persediaan',
      });
    }
  };
}

export function createOpnameVarianceHandler(deps: StockInventoryDeps) {
  return async function handleOpnameVariance(req: Request, res: Response) {
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

      const authUser = (req as any).user;
      if (authUser) {
        const canView = await checkInventoryPermission(
          authUser,
          ['inventory.view', 'inventory.create', 'inventory.edit'],
          deps.pool
        );
        if (!canView) {
          return res.status(403).json({
            status: 'ERROR',
            code: 'FORBIDDEN',
            message: 'Akses ditolak: Memerlukan izin operasional inventory.view',
          });
        }
      }

      const varianceReport = await getOpnameVarianceReport(deps.pool, {
        property_id: propertyId,
        location_id: req.query?.location_id ? Number(req.query.location_id) : undefined,
        start_date: req.query?.start_date ? String(req.query.start_date) : undefined,
        end_date: req.query?.end_date ? String(req.query.end_date) : undefined,
        status: req.query?.status ? String(req.query.status) : undefined,
      });

      return res.json({
        status: 'OK',
        data: varianceReport,
      });
    } catch (err: any) {
      const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal memuat laporan variansi opname',
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Tahap A: Riwayat Mutasi Global & Laporan Mutasi Barang (8 Kolom)
// ---------------------------------------------------------------------------

export interface AsiaJakartaHalfOpenDateBounds {
  startDate: string | null;
  endDate: string | null;
  startBoundInclusive: string | null;
  endBoundExclusive: string | null;
}

function validateStrictCalendarDateString(dateStr: string, fieldName: string): {
  year: number;
  month: number;
  day: number;
} {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw Object.assign(
      new Error(`Format ${fieldName} tidak valid (${dateStr}). Gunakan format YYYY-MM-DD`),
      { statusCode: 400, code: 'VALIDATION_ERROR' }
    );
  }
  const [yStr, mStr, dStr] = dateStr.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isFinite(dt.getTime()) ||
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() + 1 !== month ||
    dt.getUTCDate() !== day
  ) {
    throw Object.assign(
      new Error(`Tanggal ${fieldName} tidak valid pada kalender (${dateStr})`),
      { statusCode: 400, code: 'VALIDATION_ERROR' }
    );
  }
  return { year, month, day };
}

function addOneCalendarDayFormatted(year: number, month: number, day: number): string {
  const nextDt = new Date(Date.UTC(year, month - 1, day + 1));
  const ny = String(nextDt.getUTCFullYear()).padStart(4, '0');
  const nm = String(nextDt.getUTCMonth() + 1).padStart(2, '0');
  const nd = String(nextDt.getUTCDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

/**
 * Helper kanonik batas tanggal half-open [start_bound_inclusive, end_bound_exclusive)
 * dalam zona waktu Asia/Jakarta (+07:00) untuk endpoint laporan/mutasi baru.
 * - start_bound_inclusive = YYYY-MM-DDT00:00:00+07:00
 * - end_bound_exclusive   = (end_date + 1 hari kalender)T00:00:00+07:00
 */
export function parseAsiaJakartaHalfOpenDateBounds(
  startDateStr?: string | null,
  endDateStr?: string | null
): AsiaJakartaHalfOpenDateBounds {
  const cleanStart = startDateStr ? String(startDateStr).trim() : '';
  const cleanEnd = endDateStr ? String(endDateStr).trim() : '';

  let startDate: string | null = null;
  let endDate: string | null = null;
  let startBoundInclusive: string | null = null;
  let endBoundExclusive: string | null = null;

  if (cleanStart) {
    validateStrictCalendarDateString(cleanStart, 'start_date');
    startDate = cleanStart;
    startBoundInclusive = `${cleanStart}T00:00:00+07:00`;
  }

  if (cleanEnd) {
    const { year, month, day } = validateStrictCalendarDateString(cleanEnd, 'end_date');
    endDate = cleanEnd;
    const nextDayStr = addOneCalendarDayFormatted(year, month, day);
    endBoundExclusive = `${nextDayStr}T00:00:00+07:00`;
  }

  if (startDate && endDate && startDate > endDate) {
    throw Object.assign(
      new Error(`Rentang tanggal tidak valid: start_date (${startDate}) tidak boleh lebih besar dari end_date (${endDate})`),
      { statusCode: 400, code: 'VALIDATION_ERROR' }
    );
  }

  return {
    startDate,
    endDate,
    startBoundInclusive,
    endBoundExclusive,
  };
}

export const ALLOWED_GLOBAL_MOVEMENT_OPERATION_FILTERS = [
  'ALL',
  'OPENING_BALANCE',
  'PURCHASE_RECEIPT',
  'STOCK_TRANSFER',
  'STOCK_TRANSFER_IN',
  'STOCK_TRANSFER_OUT',
  'STOCK_OPNAME',
  'STOCK_ADJUSTMENT',
  'POS_SALE',
  'SALE',
  'ROOM_MINIBAR_POSTING',
] as const;

export type GlobalMovementOperationFilter = (typeof ALLOWED_GLOBAL_MOVEMENT_OPERATION_FILTERS)[number];

export interface GlobalStockMovementsFilterParams {
  property_id: number;
  warehouse_id?: number | null;
  location_id?: number | null;
  warehouse_code?: string | null;
  product_id?: number | null;
  start_date?: string | null;
  end_date?: string | null;
  operation_type?: string | null;
  direction?: string | null;
  search?: string | null;
  sort_order?: string | null;
  export_all?: boolean | string | null;
  page?: number | string | null;
  limit?: number | string | null;
}

export interface GlobalStockMovementItem {
  movement_id: number;
  operation_id: number;
  property_id: number;
  created_at: string | Date;
  movement_date_wib: string;
  movement_time_wib: string;
  product_id: number;
  product_code: string;
  product_name: string;
  location_id: number;
  location_code: string;
  location_name: string;
  location_type: string;
  operation_type: string;
  operation_category: string;
  operation_label: string;
  direction: 'IN' | 'OUT';
  base_unit_code: string;
  packaging_id: number | null;
  packaging_code: string | null;
  packaging_label: string | null;
  balance_before: string;
  quantity_in: string;
  quantity_out: string;
  quantity_delta: string;
  balance_after: string;
  unit_cost: string | null;
  operation_key: string;
  reference_no: string | null;
  counterpart_location_id: number | null;
  counterpart_location_code: string | null;
  counterpart_location_name: string | null;
  notes: string | null;
  display_keterangan: string;
  created_by: number | null;
}

export interface GlobalStockMovementUnitTotal {
  base_unit_code: string;
  movement_count: number;
  distinct_product_count: number;
  distinct_partition_count: number;
  total_in: string;
  total_out: string;
  net_delta: string;
}

export interface GlobalStockMovementPartitionSummary {
  property_id: number;
  product_id: number;
  product_code: string;
  product_name: string;
  location_id: number;
  location_code: string;
  location_name: string;
  base_unit_code: string;
  movement_count: number;
  opening_balance: string;
  total_in: string;
  total_out: string;
  net_delta: string;
  closing_balance: string;
}

export interface GlobalStockMovementsReportResult {
  property_id: number;
  property_name: string;
  report_header_title: string;
  storage_sublocation_label: string;
  snapshot: {
    as_of_timestamp: string;
    as_of_wib: string;
    isolation_level: 'REPEATABLE_READ_READ_ONLY';
  };
  filters: {
    warehouse_id: number | null;
    warehouse_code: string | null;
    warehouse_name: string | null;
    product_id: number | null;
    start_date: string | null;
    end_date: string | null;
    start_bound_inclusive: string | null;
    end_bound_exclusive: string | null;
    timezone: 'Asia/Jakarta';
    bound_mode: 'HALF_OPEN_START_INCLUSIVE_END_EXCLUSIVE';
    operation_type: string;
    direction: 'ALL' | 'IN' | 'OUT';
    search: string | null;
    sort_order: 'ASC' | 'DESC';
    export_all: boolean;
  };
  scope_notice: string;
  pagination: {
    page: number;
    limit: number;
    total_rows: number;
    total_pages: number;
    is_export_all: boolean;
  };
  totals_by_unit: GlobalStockMovementUnitTotal[];
  partition_summaries: GlobalStockMovementPartitionSummary[];
  movements: GlobalStockMovementItem[];
}

export function resolveGlobalMovementOperationDisplay(params: {
  operationType: string;
  quantityDelta: number;
  grnNumber?: string | null;
  transactionNumber?: string | null;
  operationKey?: string | null;
  notes?: string | null;
  counterpartLocationName?: string | null;
  counterpartLocationCode?: string | null;
  metadata?: any;
}): {
  operationCategory: string;
  operationLabel: string;
  referenceNo: string | null;
  displayKeterangan: string;
} {
  const opType = String(params.operationType || '').trim().toUpperCase();
  const isPositive = params.quantityDelta >= 0;
  const cleanNotes = params.notes ? String(params.notes).trim() : '';
  const meta = params.metadata && typeof params.metadata === 'object' ? params.metadata : {};

  let operationCategory = opType;
  let operationLabel = opType;
  let referenceNo: string | null = params.operationKey ? String(params.operationKey) : null;

  if (opType === 'OPENING_BALANCE') {
    operationLabel = 'Saldo Awal';
  } else if (opType === 'PURCHASE_RECEIPT') {
    operationLabel = 'Penerimaan Pembelian (GRN)';
    referenceNo = params.grnNumber || params.transactionNumber || referenceNo;
  } else if (opType === 'STOCK_TRANSFER') {
    if (isPositive) {
      operationCategory = 'STOCK_TRANSFER_IN';
      operationLabel = 'Transfer Masuk';
    } else {
      operationCategory = 'STOCK_TRANSFER_OUT';
      operationLabel = 'Transfer Keluar';
    }
  } else if (opType === 'STOCK_OPNAME') {
    operationLabel = 'Opname Fisik';
  } else if (opType === 'STOCK_ADJUSTMENT') {
    operationLabel = 'Penyesuaian Stok';
  } else if (opType === 'POS_SALE') {
    operationLabel = 'Penjualan POS';
    if (meta.transaction_no) {
      referenceNo = String(meta.transaction_no);
    } else if (meta.pos_order_id) {
      referenceNo = `POS Order #${meta.pos_order_id}`;
    }
  } else if (opType === 'ROOM_MINIBAR_POSTING') {
    operationLabel = 'Minibar Kamar';
    if (meta.reservation_id) {
      referenceNo = `Reservasi #${meta.reservation_id}`;
    }
  }

  const parts: string[] = [operationLabel];
  if (opType === 'STOCK_TRANSFER' && params.counterpartLocationName) {
    const peerLabel = params.counterpartLocationCode
      ? `${params.counterpartLocationCode} (${params.counterpartLocationName})`
      : params.counterpartLocationName;
    parts.push(isPositive ? `dari ${peerLabel}` : `ke ${peerLabel}`);
  } else if (opType === 'PURCHASE_RECEIPT' && (params.grnNumber || params.transactionNumber)) {
    parts.push(`Ref: ${params.grnNumber || params.transactionNumber}`);
  } else if (opType === 'POS_SALE' && referenceNo) {
    parts.push(`Ref: ${referenceNo}`);
  }

  if (cleanNotes) {
    const lowerJoined = parts.join(' ').toLowerCase();
    if (!lowerJoined.includes(cleanNotes.toLowerCase())) {
      parts.push(`— ${cleanNotes}`);
    }
  }

  return {
    operationCategory,
    operationLabel,
    referenceNo,
    displayKeterangan: parts.join(' '),
  };
}

const MAX_GLOBAL_MOVEMENTS_EXPORT_ROWS = 10000;
const MAX_GLOBAL_MOVEMENTS_PAGE_LIMIT = 200;

/**
 * Format nilai desimal NUMERIC(18,3) secara presisi tanpa konversi floating-point Number
 * sehingga nilai ekstrem valid seperti '999999999999999.999' tetap akurat hingga 3 desimal.
 */
export function formatNumeric18_3Exact(raw: unknown): string {
  if (raw === null || raw === undefined) return '0.000';
  const str = String(raw).trim();
  if (!str) return '0.000';
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(str);
  if (!match) {
    const num = Number(str);
    return Number.isFinite(num) ? num.toFixed(3) : '0.000';
  }
  const sign = match[1] === '-' ? '-' : '';
  const intPartRaw = match[2].replace(/^0+(?=\d)/, '') || '0';
  const fracRaw = match[3] || '';
  if (fracRaw.length <= 3) {
    const fracPadded = fracRaw.padEnd(3, '0');
    if (intPartRaw === '0' && fracPadded === '000') return '0.000';
    return `${sign}${intPartRaw}.${fracPadded}`;
  }
  const scaled = BigInt(intPartRaw + fracRaw.slice(0, 3));
  const fourthDigit = Number(fracRaw[3]);
  const rounded = fourthDigit >= 5 ? scaled + 1n : scaled;
  if (rounded === 0n) return '0.000';
  const roundedStr = rounded.toString().padStart(4, '0');
  const finalInt = roundedStr.slice(0, -3);
  const finalFrac = roundedStr.slice(-3);
  return `${sign}${finalInt}.${finalFrac}`;
}

/**
 * Riwayat Mutasi Persediaan Global & Laporan Mutasi Barang (8 Kolom) — Tahap A.
 * - Berjalan dalam satu transaksi snapshot REPEATABLE READ READ ONLY.
 * - Menghitung balance_before & balance_after per partisi kanonik (property_id, product_id, location_id)
 *   dari seluruh histori partisi SEBELUM filter tanggal/operasi/arah/pencarian dan paginasi.
 * - Memisahkan ringkasan kuantitas berdasarkan satuan dasar (totals_by_unit).
 */
export async function getGlobalStockMovements(
  pool: Pool,
  params: GlobalStockMovementsFilterParams
): Promise<GlobalStockMovementsReportResult> {
  const propertyId = Number(params.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw Object.assign(new Error('property_id wajib berupa bilangan bulat positif'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  // Validasi warehouse_id / location_id
  const rawWarehouseId =
    params.warehouse_id !== undefined && params.warehouse_id !== null && String(params.warehouse_id).trim() !== ''
      ? Number(params.warehouse_id)
      : null;
  const rawLocationId =
    params.location_id !== undefined && params.location_id !== null && String(params.location_id).trim() !== ''
      ? Number(params.location_id)
      : null;

  if (rawWarehouseId !== null && (!Number.isInteger(rawWarehouseId) || rawWarehouseId <= 0)) {
    throw Object.assign(new Error('warehouse_id tidak valid'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (rawLocationId !== null && (!Number.isInteger(rawLocationId) || rawLocationId <= 0)) {
    throw Object.assign(new Error('location_id tidak valid'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (rawWarehouseId !== null && rawLocationId !== null && rawWarehouseId !== rawLocationId) {
    throw Object.assign(
      new Error('warehouse_id dan location_id tidak boleh berisi ID lokasi yang berbeda'),
      { statusCode: 400, code: 'VALIDATION_ERROR' }
    );
  }
  let resolvedLocationId: number | null = rawWarehouseId ?? rawLocationId;
  const cleanWarehouseCode = params.warehouse_code ? String(params.warehouse_code).trim() : null;

  // Validasi product_id
  let resolvedProductId: number | null = null;
  if (params.product_id !== undefined && params.product_id !== null && String(params.product_id).trim() !== '') {
    resolvedProductId = Number(params.product_id);
    if (!Number.isInteger(resolvedProductId) || resolvedProductId <= 0) {
      throw Object.assign(new Error('product_id tidak valid'), {
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      });
    }
  }

  // Validasi batas tanggal half-open Asia/Jakarta
  const dateBounds = parseAsiaJakartaHalfOpenDateBounds(params.start_date, params.end_date);

  // Validasi operation_type
  const rawOpType = params.operation_type ? String(params.operation_type).trim().toUpperCase() : 'ALL';
  if (!(ALLOWED_GLOBAL_MOVEMENT_OPERATION_FILTERS as readonly string[]).includes(rawOpType)) {
    throw Object.assign(
      new Error(
        `operation_type tidak valid (${rawOpType}). Pilihan yang didukung: ${ALLOWED_GLOBAL_MOVEMENT_OPERATION_FILTERS.join(', ')}`
      ),
      { statusCode: 400, code: 'VALIDATION_ERROR' }
    );
  }
  const normalizedOpType = rawOpType === 'SALE' ? 'POS_SALE' : rawOpType;

  // Validasi direction
  const rawDirection = params.direction ? String(params.direction).trim().toUpperCase() : 'ALL';
  if (rawDirection !== 'ALL' && rawDirection !== 'IN' && rawDirection !== 'OUT') {
    throw Object.assign(
      new Error(`direction tidak valid (${rawDirection}). Gunakan ALL, IN, atau OUT`),
      { statusCode: 400, code: 'VALIDATION_ERROR' }
    );
  }
  const directionFilter = rawDirection as 'ALL' | 'IN' | 'OUT';

  // Validasi sort_order
  const rawSortOrder = params.sort_order ? String(params.sort_order).trim().toUpperCase() : 'DESC';
  if (rawSortOrder !== 'ASC' && rawSortOrder !== 'DESC') {
    throw Object.assign(
      new Error(`sort_order tidak valid (${rawSortOrder}). Gunakan ASC atau DESC`),
      { statusCode: 400, code: 'VALIDATION_ERROR' }
    );
  }
  const sortOrder = rawSortOrder as 'ASC' | 'DESC';

  // Validasi export_all, page, limit
  const isExportAll =
    params.export_all === true ||
    String(params.export_all || '').trim().toLowerCase() === 'true' ||
    String(params.export_all || '').trim() === '1';

  let page = 1;
  if (params.page !== undefined && params.page !== null && String(params.page).trim() !== '') {
    page = Number(params.page);
    if (!Number.isInteger(page) || page < 1) {
      throw Object.assign(new Error('page wajib berupa bilangan bulat >= 1'), {
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      });
    }
  }

  let limit = 50;
  if (params.limit !== undefined && params.limit !== null && String(params.limit).trim() !== '') {
    limit = Number(params.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_GLOBAL_MOVEMENTS_PAGE_LIMIT) {
      throw Object.assign(
        new Error(`limit wajib berupa bilangan bulat antara 1 dan ${MAX_GLOBAL_MOVEMENTS_PAGE_LIMIT}`),
        {
          statusCode: 400,
          code: 'VALIDATION_ERROR',
        }
      );
    }
  }

  const cleanSearch = params.search ? String(params.search).trim() : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

    // Ambil informasi snapshot waktu dan properti
    const snapRes = await client.query(
      `SELECT NOW() AS as_of_utc,
              TO_CHAR(NOW() AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS') AS as_of_wib,
              (SELECT name FROM properties WHERE id = $1 LIMIT 1) AS property_name`,
      [propertyId]
    );
    const snapRow = snapRes.rows[0] || {};
    const asOfTimestamp = snapRow.as_of_utc ? new Date(snapRow.as_of_utc).toISOString() : new Date().toISOString();
    const asOfWib = String(snapRow.as_of_wib || '');
    const propertyName = String(snapRow.property_name || 'OAK Lawang');

    // Resolusi informasi warehouse/location bila difilter
    let resolvedWarehouseCode: string | null = null;
    let resolvedWarehouseName: string | null = null;

    if (resolvedLocationId !== null) {
      const locRes = await client.query(
        `SELECT id, code, name, location_type
           FROM stock_locations
          WHERE id = $1 AND property_id = $2
          LIMIT 1`,
        [resolvedLocationId, propertyId]
      );
      if (locRes.rowCount === 0) {
        throw Object.assign(
          new Error(`Lokasi penyimpanan #${resolvedLocationId} tidak ditemukan pada properti #${propertyId}`),
          { statusCode: 404, code: 'LOCATION_NOT_FOUND' }
        );
      }
      resolvedWarehouseCode = locRes.rows[0].code;
      resolvedWarehouseName = locRes.rows[0].name;
      if (
        cleanWarehouseCode &&
        String(resolvedWarehouseCode || '').trim().toUpperCase() !== cleanWarehouseCode.toUpperCase()
      ) {
        throw Object.assign(
          new Error(`warehouse_code (${cleanWarehouseCode}) tidak cocok dengan warehouse_id (#${resolvedLocationId})`),
          { statusCode: 400, code: 'VALIDATION_ERROR' }
        );
      }
    } else if (cleanWarehouseCode) {
      const locRes = await client.query(
        `SELECT id, code, name, location_type
           FROM stock_locations
          WHERE property_id = $1
            AND UPPER(TRIM(code)) = UPPER(TRIM($2))
          LIMIT 1`,
        [propertyId, cleanWarehouseCode]
      );
      if (locRes.rowCount === 0) {
        throw Object.assign(
          new Error(`Lokasi penyimpanan dengan kode "${cleanWarehouseCode}" tidak ditemukan pada properti #${propertyId}`),
          { statusCode: 404, code: 'LOCATION_NOT_FOUND' }
        );
      }
      resolvedLocationId = Number(locRes.rows[0].id);
      resolvedWarehouseCode = locRes.rows[0].code;
      resolvedWarehouseName = locRes.rows[0].name;
    }

    // Validasi product_id milik properti bila disertakan
    if (resolvedProductId !== null) {
      const prodRes = await client.query(
        `SELECT id FROM pos_menu_items WHERE id = $1 AND property_id = $2 LIMIT 1`,
        [resolvedProductId, propertyId]
      );
      if (prodRes.rowCount === 0) {
        throw Object.assign(
          new Error(`Produk #${resolvedProductId} tidak ditemukan pada properti #${propertyId}`),
          { statusCode: 404, code: 'PRODUCT_NOT_FOUND' }
        );
      }
    }

    // Bangun kondisi partisi utuh (hanya key partisi: property_id, location_id, product_id)
    // PENTING: Filter tanggal, operation_type, direction, dan search TIDAK boleh masuk ke partitionConditions
    // agar window function SUM(sm.quantity_delta) OVER (PARTITION BY property_id, product_id, location_id)
    // selalu menghitung saldo komulatif dari awal histori partisi.
    const partitionConditions: string[] = ['sm.property_id = $1'];
    const sqlParams: any[] = [propertyId];
    let pIdx = 2;

    if (resolvedLocationId !== null) {
      partitionConditions.push(`sm.location_id = $${pIdx++}`);
      sqlParams.push(resolvedLocationId);
    }

    if (resolvedProductId !== null) {
      partitionConditions.push(`sm.product_id = $${pIdx++}`);
      sqlParams.push(resolvedProductId);
    }

    // Bangun kondisi pasca-partisi (filtered_movements)
    const filterConditions: string[] = ['1 = 1'];

    if (dateBounds.startBoundInclusive) {
      filterConditions.push(`pl.created_at >= $${pIdx++}::timestamptz`);
      sqlParams.push(dateBounds.startBoundInclusive);
    }

    if (dateBounds.endBoundExclusive) {
      filterConditions.push(`pl.created_at < $${pIdx++}::timestamptz`);
      sqlParams.push(dateBounds.endBoundExclusive);
    }

    if (normalizedOpType !== 'ALL') {
      if (normalizedOpType === 'STOCK_TRANSFER_IN') {
        filterConditions.push(`(pl.operation_type = 'STOCK_TRANSFER' AND pl.quantity_delta > 0)`);
      } else if (normalizedOpType === 'STOCK_TRANSFER_OUT') {
        filterConditions.push(`(pl.operation_type = 'STOCK_TRANSFER' AND pl.quantity_delta < 0)`);
      } else {
        filterConditions.push(`pl.operation_type = $${pIdx++}`);
        sqlParams.push(normalizedOpType);
      }
    }

    if (directionFilter === 'IN') {
      filterConditions.push(`pl.quantity_delta > 0`);
    } else if (directionFilter === 'OUT') {
      filterConditions.push(`pl.quantity_delta < 0`);
    }

    if (cleanSearch) {
      const searchParamIdx = pIdx++;
      sqlParams.push(`%${cleanSearch}%`);
      filterConditions.push(`(
        pl.product_name ILIKE $${searchParamIdx}
        OR pl.product_code ILIKE $${searchParamIdx}
        OR pl.location_name ILIKE $${searchParamIdx}
        OR pl.location_code ILIKE $${searchParamIdx}
        OR COALESCE(pl.notes, '') ILIKE $${searchParamIdx}
        OR COALESCE(pl.operation_key, '') ILIKE $${searchParamIdx}
        OR COALESCE(pl.grn_number, '') ILIKE $${searchParamIdx}
        OR COALESCE(pl.transaction_number, '') ILIKE $${searchParamIdx}
        OR COALESCE(pl.counterpart_location_name, '') ILIKE $${searchParamIdx}
        OR COALESCE(pl.counterpart_location_code, '') ILIKE $${searchParamIdx}
        OR COALESCE(pl.operation_type, '') ILIKE $${searchParamIdx}
      )`);
    }

    const baseCteSql = `
      WITH partition_ledger AS (
        SELECT
          sm.id AS movement_id,
          sm.operation_id,
          sm.property_id,
          sm.product_id,
          COALESCE(NULLIF(TRIM(pmi.item_code), ''), 'SKU-' || sm.product_id::text) AS product_code,
          pmi.name AS product_name,
          sm.location_id,
          sl.code AS location_code,
          sl.name AS location_name,
          sl.location_type,
          so.operation_type,
          so.operation_key,
          so.transaction_id,
          so.notes,
          so.metadata,
          so.created_by,
          sm.created_at,
          TO_CHAR(sm.created_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS movement_date_wib,
          TO_CHAR(sm.created_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS') AS movement_time_wib,
          COALESCE(NULLIF(TRIM(sm.base_unit_code), ''), pmi.canonical_base_unit_code, pmi.base_unit, 'PCS') AS base_unit_code,
          sm.packaging_id,
          sm.packaging_code,
          sm.packaging_label,
          sm.quantity_delta,
          CASE WHEN sm.quantity_delta > 0 THEN sm.quantity_delta ELSE 0::numeric(18,3) END AS quantity_in,
          CASE WHEN sm.quantity_delta < 0 THEN ABS(sm.quantity_delta) ELSE 0::numeric(18,3) END AS quantity_out,
          SUM(sm.quantity_delta) OVER (
            PARTITION BY sm.property_id, sm.product_id, sm.location_id
            ORDER BY sm.created_at ASC, sm.id ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) - sm.quantity_delta AS balance_before,
          SUM(sm.quantity_delta) OVER (
            PARTITION BY sm.property_id, sm.product_id, sm.location_id
            ORDER BY sm.created_at ASC, sm.id ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS balance_after,
          sm.unit_cost,
          pgr.grn_number,
          COALESCE(
            NULLIF(TRIM(to_jsonb(tx)->>'transaction_number'), ''),
            NULLIF(TRIM(to_jsonb(tx)->>'reference_number'), ''),
            NULLIF(TRIM(to_jsonb(tx)->>'invoice_number'), ''),
            CASE WHEN so.transaction_id IS NOT NULL THEN 'TX-' || so.transaction_id::text ELSE NULL END
          ) AS transaction_number,
          peer.counterpart_location_id,
          peer.counterpart_location_code,
          peer.counterpart_location_name
        FROM stock_movements sm
        JOIN stock_operations so
          ON so.id = sm.operation_id
         AND so.property_id = sm.property_id
        JOIN pos_menu_items pmi
          ON pmi.id = sm.product_id
         AND pmi.property_id = sm.property_id
        JOIN stock_locations sl
          ON sl.id = sm.location_id
         AND sl.property_id = sm.property_id
        LEFT JOIN LATERAL (
          SELECT pgr_row.grn_number
          FROM pos_goods_receipts pgr_row
          WHERE pgr_row.property_id = so.property_id
            AND (
              pgr_row.operation_key = so.operation_key
              OR pgr_row.idempotency_key = so.operation_key
              OR (
                so.metadata IS NOT NULL
                AND jsonb_typeof(so.metadata) = 'object'
                AND (so.metadata->>'grn_id') ~ '^[0-9]+$'
                AND pgr_row.id = (
                  CASE
                    WHEN jsonb_typeof(so.metadata) = 'object'
                     AND (so.metadata->>'grn_id') ~ '^[0-9]+$'
                     AND LENGTH(so.metadata->>'grn_id') <= 9
                    THEN (so.metadata->>'grn_id')::int
                    ELSE NULL
                  END
                )
              )
            )
          ORDER BY pgr_row.id DESC
          LIMIT 1
        ) pgr ON TRUE
        LEFT JOIN transactions tx
          ON tx.id = so.transaction_id
         AND tx.property_id = so.property_id
        LEFT JOIN LATERAL (
          SELECT
            sm2.location_id AS counterpart_location_id,
            sl2.code AS counterpart_location_code,
            sl2.name AS counterpart_location_name
          FROM stock_movements sm2
          JOIN stock_locations sl2
            ON sl2.id = sm2.location_id
           AND sl2.property_id = sm2.property_id
          WHERE sm2.property_id = sm.property_id
            AND sm2.operation_id = sm.operation_id
            AND sm2.product_id = sm.product_id
            AND sm2.id <> sm.id
          ORDER BY sm2.id ASC
          LIMIT 1
        ) peer ON so.operation_type = 'STOCK_TRANSFER'
        WHERE ${partitionConditions.join(' AND ')}
      ),
      filtered_movements AS (
        SELECT pl.*
        FROM partition_ledger pl
        WHERE ${filterConditions.join(' AND ')}
      )
    `;

    // 1. Hitung total baris dan agregat per satuan dasar (totals_by_unit)
    const unitAggSql = `
      ${baseCteSql}
      SELECT
        base_unit_code,
        COUNT(*)::int AS movement_count,
        COUNT(DISTINCT product_id)::int AS distinct_product_count,
        COUNT(DISTINCT (product_id::text || ':' || location_id::text))::int AS distinct_partition_count,
        COALESCE(SUM(quantity_in), 0)::numeric(18,3) AS total_in,
        COALESCE(SUM(quantity_out), 0)::numeric(18,3) AS total_out,
        COALESCE(SUM(quantity_delta), 0)::numeric(18,3) AS net_delta
      FROM filtered_movements
      GROUP BY base_unit_code
      ORDER BY base_unit_code ASC
    `;
    const unitAggRes = await client.query(unitAggSql, sqlParams);

    let totalRows = 0;
    const totalsByUnit: GlobalStockMovementUnitTotal[] = unitAggRes.rows.map((row: any) => {
      const mCount = Number(row.movement_count || 0);
      totalRows += mCount;
      return {
        base_unit_code: String(row.base_unit_code || 'PCS'),
        movement_count: mCount,
        distinct_product_count: Number(row.distinct_product_count || 0),
        distinct_partition_count: Number(row.distinct_partition_count || 0),
        total_in: formatNumeric18_3Exact(row.total_in),
        total_out: formatNumeric18_3Exact(row.total_out),
        net_delta: formatNumeric18_3Exact(row.net_delta),
      };
    });

    if (isExportAll && totalRows > MAX_GLOBAL_MOVEMENTS_EXPORT_ROWS) {
      throw Object.assign(
        new Error(
          `Jumlah baris laporan (${totalRows}) melebihi batas maksimum cetak/ekspor sekaligus (${MAX_GLOBAL_MOVEMENTS_EXPORT_ROWS} baris). Silakan persempit rentang tanggal atau pilih lokasi gudang spesifik.`
        ),
        { statusCode: 422, code: 'EXPORT_LIMIT_EXCEEDED' }
      );
    }

    // 2. Hitung ringkasan per partisi (property_id + product_id + location_id)
    const partitionSummarySql = `
      ${baseCteSql},
      ranked_partitions AS (
        SELECT
          fm.*,
          FIRST_VALUE(fm.balance_before) OVER (
            PARTITION BY fm.property_id, fm.product_id, fm.location_id
            ORDER BY fm.created_at ASC, fm.movement_id ASC
          ) AS first_balance_before,
          FIRST_VALUE(fm.balance_after) OVER (
            PARTITION BY fm.property_id, fm.product_id, fm.location_id
            ORDER BY fm.created_at DESC, fm.movement_id DESC
          ) AS last_balance_after
        FROM filtered_movements fm
      )
      SELECT
        property_id,
        product_id,
        product_code,
        product_name,
        location_id,
        location_code,
        location_name,
        base_unit_code,
        COUNT(*)::int AS movement_count,
        MIN(first_balance_before)::numeric(18,3) AS opening_balance,
        COALESCE(SUM(quantity_in), 0)::numeric(18,3) AS total_in,
        COALESCE(SUM(quantity_out), 0)::numeric(18,3) AS total_out,
        COALESCE(SUM(quantity_delta), 0)::numeric(18,3) AS net_delta,
        MIN(last_balance_after)::numeric(18,3) AS closing_balance
      FROM ranked_partitions
      GROUP BY
        property_id,
        product_id,
        product_code,
        product_name,
        location_id,
        location_code,
        location_name,
        base_unit_code
      ORDER BY location_code ASC, product_code ASC, product_id ASC
    `;
    const partSumRes = await client.query(partitionSummarySql, sqlParams);
    const partitionSummaries: GlobalStockMovementPartitionSummary[] = partSumRes.rows.map((row: any) => ({
      property_id: Number(row.property_id),
      product_id: Number(row.product_id),
      product_code: String(row.product_code || `SKU-${row.product_id}`),
      product_name: String(row.product_name || ''),
      location_id: Number(row.location_id),
      location_code: String(row.location_code || ''),
      location_name: String(row.location_name || ''),
      base_unit_code: String(row.base_unit_code || 'PCS'),
      movement_count: Number(row.movement_count || 0),
      opening_balance: formatNumeric18_3Exact(row.opening_balance),
      total_in: formatNumeric18_3Exact(row.total_in),
      total_out: formatNumeric18_3Exact(row.total_out),
      net_delta: formatNumeric18_3Exact(row.net_delta),
      closing_balance: formatNumeric18_3Exact(row.closing_balance),
    }));

    // 3. Ambil daftar baris mutasi (terpaginasi atau export_all)
    const orderDirectionSql = sortOrder === 'ASC' ? 'ASC' : 'DESC';
    let paginationClause = '';
    const movParams = [...sqlParams];
    if (!isExportAll) {
      const offset = (page - 1) * limit;
      paginationClause = `LIMIT $${movParams.length + 1} OFFSET $${movParams.length + 2}`;
      movParams.push(limit, offset);
    } else {
      paginationClause = `LIMIT ${MAX_GLOBAL_MOVEMENTS_EXPORT_ROWS}`;
    }

    const movementsSql = `
      ${baseCteSql}
      SELECT *
      FROM filtered_movements
      ORDER BY created_at ${orderDirectionSql}, movement_id ${orderDirectionSql}
      ${paginationClause}
    `;
    const movRes = await client.query(movementsSql, movParams);

    await client.query('COMMIT');

    const movements: GlobalStockMovementItem[] = movRes.rows.map((row: any) => {
      const exactQuantityDelta = formatNumeric18_3Exact(row.quantity_delta);
      const isNegativeDelta = exactQuantityDelta.startsWith('-');
      const deltaNum = isNegativeDelta ? -1 : 1;
      const resolvedDisplay = resolveGlobalMovementOperationDisplay({
        operationType: row.operation_type,
        quantityDelta: deltaNum,
        grnNumber: row.grn_number,
        transactionNumber: row.transaction_number,
        operationKey: row.operation_key,
        notes: row.notes,
        counterpartLocationName: row.counterpart_location_name,
        counterpartLocationCode: row.counterpart_location_code,
        metadata: row.metadata,
      });

      return {
        movement_id: Number(row.movement_id),
        operation_id: Number(row.operation_id),
        property_id: Number(row.property_id),
        created_at: row.created_at,
        movement_date_wib: String(row.movement_date_wib || ''),
        movement_time_wib: String(row.movement_time_wib || ''),
        product_id: Number(row.product_id),
        product_code: String(row.product_code || `SKU-${row.product_id}`),
        product_name: String(row.product_name || ''),
        location_id: Number(row.location_id),
        location_code: String(row.location_code || ''),
        location_name: String(row.location_name || ''),
        location_type: String(row.location_type || ''),
        operation_type: String(row.operation_type || ''),
        operation_category: resolvedDisplay.operationCategory,
        operation_label: resolvedDisplay.operationLabel,
        direction: isNegativeDelta ? 'OUT' : 'IN',
        base_unit_code: String(row.base_unit_code || 'PCS'),
        packaging_id: row.packaging_id ? Number(row.packaging_id) : null,
        packaging_code: row.packaging_code ?? null,
        packaging_label: row.packaging_label ?? null,
        balance_before: formatNumeric18_3Exact(row.balance_before),
        quantity_in: formatNumeric18_3Exact(row.quantity_in),
        quantity_out: formatNumeric18_3Exact(row.quantity_out),
        quantity_delta: exactQuantityDelta,
        balance_after: formatNumeric18_3Exact(row.balance_after),
        unit_cost: row.unit_cost !== null && row.unit_cost !== undefined ? String(row.unit_cost) : null,
        operation_key: String(row.operation_key || ''),
        reference_no: resolvedDisplay.referenceNo,
        counterpart_location_id: row.counterpart_location_id ? Number(row.counterpart_location_id) : null,
        counterpart_location_code: row.counterpart_location_code ?? null,
        counterpart_location_name: row.counterpart_location_name ?? null,
        notes: row.notes ?? null,
        display_keterangan: resolvedDisplay.displayKeterangan,
        created_by: row.created_by ? Number(row.created_by) : null,
      };
    });

    const effectiveLimit = isExportAll ? Math.max(1, totalRows) : limit;
    const effectivePage = isExportAll ? 1 : page;
    const totalPages = isExportAll ? 1 : Math.max(1, Math.ceil(totalRows / limit));

    return {
      property_id: propertyId,
      property_name: propertyName,
      report_header_title: 'OAK Lawang',
      storage_sublocation_label: 'Tempat penyimpanan: Belum dirinci',
      snapshot: {
        as_of_timestamp: asOfTimestamp,
        as_of_wib: asOfWib,
        isolation_level: 'REPEATABLE_READ_READ_ONLY',
      },
      filters: {
        warehouse_id: resolvedLocationId,
        warehouse_code: resolvedWarehouseCode,
        warehouse_name: resolvedWarehouseName,
        product_id: resolvedProductId,
        start_date: dateBounds.startDate,
        end_date: dateBounds.endDate,
        start_bound_inclusive: dateBounds.startBoundInclusive,
        end_bound_exclusive: dateBounds.endBoundExclusive,
        timezone: 'Asia/Jakarta',
        bound_mode: 'HALF_OPEN_START_INCLUSIVE_END_EXCLUSIVE',
        operation_type: normalizedOpType,
        direction: directionFilter,
        search: cleanSearch,
        sort_order: sortOrder,
        export_all: isExportAll,
      },
      scope_notice:
        resolvedLocationId !== null
          ? `Saldo Awal dan Saldo Akhir dihitung per Produk pada lokasi ${resolvedWarehouseCode} (${resolvedWarehouseName}).`
          : 'Semua Lokasi digabung: Saldo Awal dan Saldo Akhir pada setiap baris adalah saldo per (Produk + Lokasi) masing-masing, bukan saldo gabungan lintas gudang.',
      pagination: {
        page: effectivePage,
        limit: effectiveLimit,
        total_rows: totalRows,
        total_pages: totalPages,
        is_export_all: isExportAll,
      },
      totals_by_unit: totalsByUnit,
      partition_summaries: partitionSummaries,
      movements,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback error
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Handler GET /api/pos/inventory/stock-movements-global (dan alias /api/pos/stock/movements-global)
 */
export function createGlobalStockMovementsHandler(deps: StockInventoryDeps) {
  return async function handleGlobalStockMovements(req: Request, res: Response) {
    try {
      const rawPropId = req.query?.property_id;
      const propertyId = Number(rawPropId);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib berupa bilangan bulat positif',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const authUser = (req as any).user || (req as any).authUser;
      if (authUser) {
        const canView = await checkInventoryPermission(
          authUser,
          ['inventory.view', 'inventory.create', 'inventory.edit'],
          deps.pool
        );
        if (!canView) {
          return res.status(403).json({
            status: 'ERROR',
            code: 'FORBIDDEN',
            message: 'Akses ditolak: Memerlukan izin operasional inventory.view',
          });
        }
      }

      const report = await getGlobalStockMovements(deps.pool, {
        property_id: propertyId,
        warehouse_id:
          req.query?.warehouse_id !== undefined && String(req.query.warehouse_id).trim() !== ''
            ? Number(req.query.warehouse_id)
            : undefined,
        location_id:
          req.query?.location_id !== undefined && String(req.query.location_id).trim() !== ''
            ? Number(req.query.location_id)
            : undefined,
        warehouse_code: req.query?.warehouse_code ? String(req.query.warehouse_code) : undefined,
        product_id:
          req.query?.product_id !== undefined && String(req.query.product_id).trim() !== ''
            ? Number(req.query.product_id)
            : undefined,
        start_date: req.query?.start_date ? String(req.query.start_date) : undefined,
        end_date: req.query?.end_date ? String(req.query.end_date) : undefined,
        operation_type: req.query?.operation_type ? String(req.query.operation_type) : undefined,
        direction: req.query?.direction ? String(req.query.direction) : undefined,
        search: req.query?.search ? String(req.query.search) : undefined,
        sort_order: req.query?.sort_order ? String(req.query.sort_order) : undefined,
        export_all: req.query?.export_all !== undefined ? String(req.query.export_all) : undefined,
        page: req.query?.page !== undefined ? String(req.query.page) : undefined,
        limit: req.query?.limit !== undefined ? String(req.query.limit) : undefined,
      });

      return res.json({
        status: 'OK',
        data: report,
      });
    } catch (err: any) {
      const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal memuat riwayat mutasi persediaan global',
      });
    }
  };
}


// ---------------------------------------------------------------------------
// POS Sale Automatic Stock Deduction (MP-04B E2E)
// ---------------------------------------------------------------------------

export interface DeductStockForPosSaleParams {
  client: PoolClient;
  propertyId: number;
  orderId: number;
  locationId?: number | null;
  saleTransactionNo?: string | null;
  actorUserId?: string | null;
  actorName?: string | null;
}

export interface PosSaleStockDeductionItemResult {
  product_id: number;
  product_name: string;
  quantity: number;
  movement_id: number;
  quantity_delta: string;
  previous_balance: string;
  new_balance: string;
  base_unit_code: string;
  is_ingredient?: boolean;
}

export interface PosSaleStockDeductionResult {
  replayed: boolean;
  operation_id?: number;
  location_id?: number;
  items_deducted: PosSaleStockDeductionItemResult[];
  skipped_non_tracked: number;
}

/**
 * Memotong saldo persediaan secara atomik saat pesanan POS diselesaikan (PAID / SETTLED).
 * - Berjalan di dalam transaksi DB yang sama (menggunakan client yang diteruskan).
 * - Menjaga idempotency per order via operation_key deterministik.
 * - Memverifikasi ketersediaan saldo dengan row lock FOR UPDATE.
 * - Mematuhi CHECK constraint chk_stock_balance_non_negative.
 * - Mencatat stock_operations (POS_SALE) dan stock_movements (delta negatif).
 */
export async function deductStockForPosSale(
  params: DeductStockForPosSaleParams
): Promise<PosSaleStockDeductionResult> {
  const { client, propertyId, orderId } = params;

  // 1. Idempotency Check: apakah order ini sudah pernah dipotong stoknya
  const operationKey = `POS-SALE-${propertyId}-${orderId}`;
  const existingOpRes = await client.query(
    `SELECT id, metadata FROM stock_operations
      WHERE property_id = $1 AND operation_key = $2`,
    [propertyId, operationKey]
  );

  if (existingOpRes.rows.length > 0) {
    const existingOp = existingOpRes.rows[0];
    const movRes = await client.query(
      `SELECT sm.id AS movement_id, sm.product_id, sm.quantity_delta, sm.base_unit_code,
              pmi.name AS product_name, sb.quantity AS current_balance
         FROM stock_movements sm
         JOIN pos_menu_items pmi ON pmi.id = sm.product_id
         LEFT JOIN stock_balances sb ON sb.property_id = sm.property_id AND sb.product_id = sm.product_id AND sb.location_id = sm.location_id
        WHERE sm.operation_id = $1
        ORDER BY sm.id ASC`,
      [existingOp.id]
    );

    return {
      replayed: true,
      operation_id: Number(existingOp.id),
      location_id: existingOp.metadata?.location_id ? Number(existingOp.metadata.location_id) : undefined,
      items_deducted: movRes.rows.map((r: any) => ({
        product_id: Number(r.product_id),
        product_name: r.product_name,
        quantity: Math.abs(parseFloat(r.quantity_delta)),
        movement_id: Number(r.movement_id),
        quantity_delta: String(r.quantity_delta),
        previous_balance: String(r.current_balance ?? '0.000'),
        new_balance: String(r.current_balance ?? '0.000'),
        base_unit_code: r.base_unit_code,
      })),
      skipped_non_tracked: 0,
    };
  }

  // 2. Ambil baris pesanan
  const itemsRes = await client.query(
    `SELECT poi.id, poi.menu_item_id, poi.quantity,
            pmi.name, pmi.track_stock, pmi.track_inventory,
            pmi.base_unit, pmi.canonical_base_unit_code
       FROM pos_order_items poi
       JOIN pos_menu_items pmi ON pmi.id = poi.menu_item_id
      WHERE poi.order_id = $1
      ORDER BY poi.id ASC`,
    [orderId]
  );

  if (itemsRes.rows.length === 0) {
    return {
      replayed: false,
      items_deducted: [],
      skipped_non_tracked: 0,
    };
  }

  // Cek apakah item menu memiliki formula resep (Bill of Materials / BOM)
  const menuItemIds = itemsRes.rows.map((r: any) => Number(r.menu_item_id));
  const recipesByProduct = new Map<number, Array<{
    recipe_id: number;
    product_id: number;
    ingredient_product_id: number;
    recipe_quantity: number;
    ingredient_name: string;
    ingredient_track_stock: boolean;
    ingredient_track_inventory: boolean;
    ingredient_base_unit: string | null;
    ingredient_canonical_unit: string | null;
    uom_code: string | null;
  }>>();

  if (menuItemIds.length > 0) {
    const recRes = await client.query(
      `SELECT r.id AS recipe_id, r.product_id, r.ingredient_product_id, r.quantity AS recipe_quantity,
              r.uom_id, i.name AS ingredient_name, i.track_stock AS ingredient_track_stock,
              i.track_inventory AS ingredient_track_inventory,
              i.base_unit AS ingredient_base_unit,
              i.canonical_base_unit_code AS ingredient_canonical_unit,
              u.code AS uom_code
         FROM pos_product_recipes r
         JOIN pos_menu_items i ON i.id = r.ingredient_product_id
         LEFT JOIN pos_product_uoms u ON u.id = r.uom_id
        WHERE r.property_id = $1 AND r.product_id = ANY($2::int[])
        ORDER BY r.id ASC`,
      [propertyId, menuItemIds]
    );

    for (const r of recRes.rows) {
      const pid = Number(r.product_id);
      if (!recipesByProduct.has(pid)) {
        recipesByProduct.set(pid, []);
      }
      recipesByProduct.get(pid)!.push({
        recipe_id: Number(r.recipe_id),
        product_id: pid,
        ingredient_product_id: Number(r.ingredient_product_id),
        recipe_quantity: parseFloat(r.recipe_quantity),
        ingredient_name: r.ingredient_name,
        ingredient_track_stock: Boolean(r.ingredient_track_stock),
        ingredient_track_inventory: Boolean(r.ingredient_track_inventory),
        ingredient_base_unit: r.ingredient_base_unit,
        ingredient_canonical_unit: r.ingredient_canonical_unit,
        uom_code: r.uom_code,
      });
    }
  }

  // 3. Klasifikasi item pesanan:
  // KASUS A: Memiliki Resep (BOM) -> potong bahan baku (ingredient_product_id)
  // KASUS B: Tanpa Resep & Tracked -> potong item langsung (Finished Good Retail)
  // KASUS C: Non-Tracked & Tanpa Resep -> lewati
  const aggregatedMap = new Map<number, {
    product_id: number;
    name: string;
    quantity: number;
    base_unit_code: string;
    is_ingredient: boolean;
    source_notes: string[];
  }>();

  let skippedNonTracked = 0;

  for (const item of itemsRes.rows) {
    const pId = Number(item.menu_item_id);
    const orderQty = Number(item.quantity);
    const recipes = recipesByProduct.get(pId);

    if (recipes && recipes.length > 0) {
      // KASUS A: BOM Resep Bahan Baku
      for (const ing of recipes) {
        const ingId = ing.ingredient_product_id;
        const requiredQty = orderQty * ing.recipe_quantity;
        const unitCode = ing.ingredient_canonical_unit || ing.ingredient_base_unit || ing.uom_code || 'PCS';
        const note = `BOM: ${orderQty}x ${item.name} (${ing.recipe_quantity} ${unitCode}/porsi)`;

        const existing = aggregatedMap.get(ingId);
        if (existing) {
          existing.quantity += requiredQty;
          existing.source_notes.push(note);
        } else {
          aggregatedMap.set(ingId, {
            product_id: ingId,
            name: ing.ingredient_name,
            quantity: requiredQty,
            base_unit_code: unitCode,
            is_ingredient: true,
            source_notes: [note],
          });
        }
      }
    } else if (item.track_stock === true || item.track_inventory === true) {
      // KASUS B: Finished Good Retail langsung
      const unitCode = item.canonical_base_unit_code || item.base_unit || 'PCS';
      const existing = aggregatedMap.get(pId);
      if (existing) {
        existing.quantity += orderQty;
      } else {
        aggregatedMap.set(pId, {
          product_id: pId,
          name: item.name,
          quantity: orderQty,
          base_unit_code: unitCode,
          is_ingredient: false,
          source_notes: [`Penjualan produk langsung`],
        });
      }
    } else {
      // KASUS C: Non-Tracked
      skippedNonTracked++;
    }
  }

  if (aggregatedMap.size === 0) {
    return {
      replayed: false,
      items_deducted: [],
      skipped_non_tracked: skippedNonTracked,
    };
  }

  // 4. Resolusi lokasi persediaan target (outlet kasir / dapur / gudang)
  let targetLocationId: number | null = null;
  if (params.locationId && Number.isInteger(Number(params.locationId)) && Number(params.locationId) > 0) {
    targetLocationId = Number(params.locationId);
  } else {
    // Ambil dari pos_orders.location_id jika tersedia
    const orderLocRes = await client.query(
      `SELECT location_id FROM pos_orders WHERE id = $1 AND property_id = $2`,
      [orderId, propertyId]
    );
    if (orderLocRes.rows.length > 0 && orderLocRes.rows[0].location_id) {
      targetLocationId = Number(orderLocRes.rows[0].location_id);
    }
  }

  if (!targetLocationId) {
    // Cari lokasi aktif default: POS_OUTLET > KITCHEN > BAR > WAREHOUSE
    const defaultLocRes = await client.query(
      `SELECT id FROM stock_locations
        WHERE property_id = $1 AND is_active = TRUE
        ORDER BY
          CASE
            WHEN location_type = 'POS_OUTLET' THEN 1
            WHEN location_type = 'KITCHEN' THEN 2
            WHEN location_type = 'BAR' THEN 3
            WHEN location_type = 'WAREHOUSE' THEN 4
            ELSE 5
          END, id ASC
        LIMIT 1`,
      [propertyId]
    );
    if (defaultLocRes.rows.length > 0) {
      targetLocationId = Number(defaultLocRes.rows[0].id);
    }
  }

  if (!targetLocationId) {
    throw Object.assign(
      new Error(`Tidak ditemukan lokasi persediaan aktif pada properti #${propertyId} untuk pemotongan stok penjualan POS`),
      {
        statusCode: 400,
        code: 'NO_STOCK_LOCATION',
      }
    );
  }

  // Validasi keaktifan lokasi stok
  const locValRes = await client.query(
    `SELECT id, is_active, name FROM stock_locations WHERE id = $1 AND property_id = $2`,
    [targetLocationId, propertyId]
  );
  if (locValRes.rowCount === 0) {
    throw Object.assign(
      new Error(`Lokasi stok #${targetLocationId} tidak ditemukan pada properti #${propertyId}`),
      { statusCode: 404, code: 'LOCATION_NOT_FOUND' }
    );
  }
  if (!locValRes.rows[0].is_active) {
    throw Object.assign(
      new Error(`Lokasi stok "${locValRes.rows[0].name}" sedang tidak aktif`),
      { statusCode: 400, code: 'LOCATION_INACTIVE' }
    );
  }

  // Urutkan berdasarkan product_id menaik untuk mencegah deadlock saat konkurensi tinggi
  const sortedItems = Array.from(aggregatedMap.values()).sort((a, b) => a.product_id - b.product_id);

  // 5. Kunci baris saldo stok (FOR UPDATE) dan verifikasi kecukupan saldo
  const checkedItems: {
    product_id: number;
    name: string;
    quantity: number;
    base_unit_code: string;
    is_ingredient: boolean;
    currentBalance: number;
    unitCost: number | null;
  }[] = [];

  for (const item of sortedItems) {
    const balRes = await client.query(
      `SELECT quantity FROM stock_balances
        WHERE property_id = $1 AND product_id = $2 AND location_id = $3
        FOR UPDATE`,
      [propertyId, item.product_id, targetLocationId]
    );
    const currentBalance = balRes.rows.length > 0 ? parseFloat(balRes.rows[0].quantity) : 0;
    if (currentBalance < item.quantity - 0.000001) {
      const curFormatted = currentBalance.toFixed(3);
      const reqFormatted = item.quantity.toFixed(3);
      throw Object.assign(
        new Error(
          `Saldo persediaan tidak mencukupi untuk ${item.is_ingredient ? 'bahan baku' : 'produk'} "${item.name}". Saldo saat ini: ${curFormatted}, dibutuhkan: ${reqFormatted}`
        ),
        {
          statusCode: 422,
          code: 'INSUFFICIENT_STOCK_BALANCE',
          details: {
            product_id: item.product_id,
            product_name: item.name,
            current_balance: curFormatted,
            required_quantity: reqFormatted,
            location_id: targetLocationId,
            is_ingredient: item.is_ingredient,
          },
        }
      );
    }

    // Cari unit cost terakhir jika tersedia untuk snapshot pergerakan
    const costRes = await client.query(
      `SELECT unit_cost FROM stock_movements
        WHERE property_id = $1 AND product_id = $2 AND unit_cost IS NOT NULL AND unit_cost > 0
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [propertyId, item.product_id]
    );
    const unitCost = costRes.rows.length > 0 ? parseFloat(costRes.rows[0].unit_cost) : null;

    checkedItems.push({
      ...item,
      currentBalance,
      unitCost,
    });
  }

  // 6. Buat header stock_operations (tipe: POS_SALE)
  const receiptNote = params.saleTransactionNo ? ` (Receipt: ${params.saleTransactionNo})` : '';
  const notes = `Penjualan POS Order #${orderId}${receiptNote}`;
  const metadata = {
    pos_order_id: orderId,
    transaction_no: params.saleTransactionNo || null,
    location_id: targetLocationId,
    actor_user_id: params.actorUserId || null,
    actor_name: params.actorName || null,
  };

  const opRes = await client.query(
    `INSERT INTO stock_operations (
       property_id, operation_type, operation_key, payload_fingerprint,
       notes, metadata, created_by, created_at
     ) VALUES (
       $1, 'POS_SALE', $2, $3,
       $4, $5, $6, NOW()
     )
     RETURNING id, created_at`,
    [
      propertyId,
      operationKey,
      operationKey,
      notes,
      JSON.stringify(metadata),
      params.actorUserId && Number.isInteger(Number(params.actorUserId)) ? Number(params.actorUserId) : null,
    ]
  );
  const opId = Number(opRes.rows[0].id);

  // 7. Catat stock_movements (delta negatif) dan perbarui stock_balances
  const itemsDeducted: PosSaleStockDeductionItemResult[] = [];

  for (const check of checkedItems) {
    const deltaQty = -check.quantity;
    const deltaStr = deltaQty.toFixed(3);
    const nextBalance = Math.max(0, check.currentBalance + deltaQty);
    const nextBalanceStr = nextBalance.toFixed(3);

    const movRes = await client.query(
      `INSERT INTO stock_movements (
         operation_id, property_id, product_id, location_id,
         packaging_id, packaging_code, packaging_label,
         quantity_delta, base_unit_code, unit_cost, created_at
       ) VALUES (
         $1, $2, $3, $4,
         NULL, NULL, NULL,
         $5, $6, $7, NOW()
       )
       RETURNING id`,
      [
        opId,
        propertyId,
        check.product_id,
        targetLocationId,
        deltaStr,
        check.base_unit_code,
        check.unitCost,
      ]
    );
    const movId = Number(movRes.rows[0].id);

    // Update stock_balances secara aman (mencegah pelanggaran constraint chk_stock_balance_non_negative)
    const checkExisting = await client.query(
      `SELECT id FROM stock_balances WHERE property_id = $1 AND product_id = $2 AND location_id = $3`,
      [propertyId, check.product_id, targetLocationId]
    );
    if (checkExisting.rows.length > 0) {
      await client.query(
        `UPDATE stock_balances
            SET quantity = $1, updated_at = NOW()
          WHERE property_id = $2 AND product_id = $3 AND location_id = $4`,
        [nextBalanceStr, propertyId, check.product_id, targetLocationId]
      );
    } else {
      await client.query(
        `INSERT INTO stock_balances (property_id, product_id, location_id, quantity, updated_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [propertyId, check.product_id, targetLocationId, nextBalanceStr]
      );
    }

    itemsDeducted.push({
      product_id: check.product_id,
      product_name: check.name,
      quantity: check.quantity,
      movement_id: movId,
      quantity_delta: deltaStr,
      previous_balance: check.currentBalance.toFixed(3),
      new_balance: nextBalanceStr,
      base_unit_code: check.base_unit_code,
      is_ingredient: check.is_ingredient,
    });
  }

  return {
    replayed: false,
    operation_id: opId,
    location_id: targetLocationId,
    items_deducted: itemsDeducted,
    skipped_non_tracked: skippedNonTracked,
  };
}

/**
 * Handler: DELETE /api/pos/stock/balances
 * Menghapus baris saldo stok bernilai 0 (quantity = 0) dari suatu lokasi penyimpanan
 * tanpa menghapus histori mutasi (stock_movements / Kartu Stok tetap utuh untuk jejak audit).
 */
export function createRemoveZeroStockBalanceHandler(deps: StockInventoryDeps) {
  return async function handleRemoveZeroStockBalance(req: Request, res: Response) {
    const propertyId = Number(req.query?.property_id ?? req.body?.property_id);
    const productId = Number(req.query?.product_id ?? req.body?.product_id);
    const locationId = Number(req.query?.location_id ?? req.body?.location_id);

    if (!Number.isInteger(propertyId) || propertyId <= 0) {
      return res.status(400).json({
        status: 'ERROR',
        code: 'VALIDATION_ERROR',
        message: 'property_id wajib berupa bilangan bulat positif',
      });
    }
    if (!Number.isInteger(productId) || productId <= 0) {
      return res.status(400).json({
        status: 'ERROR',
        code: 'VALIDATION_ERROR',
        message: 'product_id wajib berupa bilangan bulat positif',
      });
    }
    if (!Number.isInteger(locationId) || locationId <= 0) {
      return res.status(400).json({
        status: 'ERROR',
        code: 'VALIDATION_ERROR',
        message: 'location_id wajib berupa bilangan bulat positif',
      });
    }

    try {
      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const authUser = (req as any).user;
      if (authUser) {
        const canEdit = await checkInventoryPermission(
          authUser,
          ['inventory.edit', 'inventory.create'],
          deps.pool
        );
        if (!canEdit) {
          return res.status(403).json({
            status: 'ERROR',
            code: 'FORBIDDEN',
            message: 'Akses ditolak: Memerlukan izin operasional inventory.edit',
          });
        }
      }

      const client = await deps.pool.connect();
      try {
        await client.query('BEGIN');

        const balRes = await client.query(
          `SELECT id, quantity
             FROM stock_balances
            WHERE property_id = $1
              AND product_id = $2
              AND location_id = $3
            FOR UPDATE`,
          [propertyId, productId, locationId]
        );

        if ((balRes.rowCount ?? 0) === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({
            status: 'ERROR',
            code: 'STOCK_BALANCE_NOT_FOUND',
            message: 'Data saldo produk pada lokasi ini tidak ditemukan.',
          });
        }

        const row = balRes.rows[0];
        const qty = parseFloat(String(row.quantity ?? '0'));
        if (!Number.isFinite(qty) || Math.abs(qty) > 0.0001) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            status: 'ERROR',
            code: 'NON_ZERO_STOCK_BALANCE',
            message:
              'Produk tidak dapat dihapus dari lokasi ini karena masih memiliki sisa stok tercatat. Lakukan Transfer Stok atau Penyesuaian Stok terlebih dahulu hingga saldo menjadi 0.',
          });
        }

        await client.query(
          `DELETE FROM stock_balances
            WHERE id = $1
              AND property_id = $2
              AND quantity = 0`,
          [row.id, propertyId]
        );

        await client.query('COMMIT');
        return res.status(200).json({
          status: 'OK',
          data: {
            removed: true,
            property_id: propertyId,
            product_id: productId,
            location_id: locationId,
          },
        });
      } catch (txErr) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback error
        }
        throw txErr;
      } finally {
        client.release();
      }
    } catch (err: any) {
      const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal menghapus produk dari lokasi penyimpanan',
      });
    }
  };
}




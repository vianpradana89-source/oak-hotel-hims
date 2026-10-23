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

    // ── Guard 1 & 2: Lock produk (FOR UPDATE) & periksa status track_stock ──
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

    // ── Validasi unit_cost (opsional) ──
    let formattedUnitCost: string | null = null;
    if (params.unit_cost !== undefined && params.unit_cost !== null && String(params.unit_cost).trim() !== '') {
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
      `SELECT id, operation_type, operation_key, payload_fingerprint, created_at
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

    // ── Eksekusi Transaksi Atomik ──
    // 1. Insert header stock_operations
    const createdBy = params.created_by ? Number(params.created_by) : null;
    const opInsertRes = await client.query(
      `INSERT INTO stock_operations (
         property_id, operation_type, operation_key, payload_fingerprint, created_by, created_at
       ) VALUES ($1, 'OPENING_BALANCE', $2, $3, $4, NOW())
       RETURNING id, created_at`,
      [propertyId, opKey, payloadFingerprint, createdBy]
    );
    const opRow = opInsertRes.rows[0];

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
      `SELECT id, property_id, transaction_no, transaction_type, transaction_status, receiving_status, received_at
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

    if (tx.transaction_status === 'VOIDED' || tx.transaction_status === 'REVERSED') {
      throw Object.assign(
        new Error(`Transaksi #${transactionId} sudah dalam status ${tx.transaction_status} dan tidak dapat menerima barang`),
        { statusCode: 400, code: 'TRANSACTION_ALREADY_VOIDED' }
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

    interface PreparedStockItem {
      lineId: number;
      bindingId: number;
      productId: number;
      destinationLocationId: number;
      quantityReceived: string;
      baseQuantityDelta: string;
      baseUnitCode: string;
      packagingId: number | null;
      packagingCode: string | null;
      packagingLabel: string | null;
    }

    interface PreparedNonStockItem {
      lineId: number;
      bindingId: number;
      lineType: StockPurchaseLineType;
      quantityReceived: string;
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

      // Jika belum ada di binding, coba inisialisasi dari transaction_lines jika tersedia
      if (bindingRes.rowCount === 0) {
        const tlRes = await client.query(
          `SELECT tl.*, pmi.name AS product_name, pmi.base_unit, pmi.canonical_base_unit_code, pmi.track_stock
             FROM transaction_lines tl
             LEFT JOIN pos_menu_items pmi ON pmi.id = tl.product_id AND pmi.property_id = tl.property_id
            WHERE tl.id = $1 AND tl.transaction_id = $2 AND tl.property_id = $3`,
          [lineId, transactionId, propertyId]
        );

        if (tlRes.rowCount === 0) {
          throw Object.assign(
            new Error(`Baris pembelian #${lineId} tidak ditemukan pada transaksi #${transactionId}`),
            { statusCode: 404, code: 'PURCHASE_LINE_NOT_FOUND' }
          );
        }

        const tl = tlRes.rows[0];
        let derivedLineType: StockPurchaseLineType = 'STOCK';
        if (!tl.product_id) {
          derivedLineType = 'SERVICE';
        } else if (!tl.track_stock) {
          derivedLineType = 'NON_STOCK_PHYSICAL';
        }

        const baseUnit = tl.canonical_base_unit_code || tl.base_unit || tl.unit || 'pcs';
        const defaultLocId = line.location_id ?? params.location_id ?? null;

        await client.query(
          `INSERT INTO stock_purchase_line_bindings (
             property_id, transaction_id, transaction_line_id, line_type,
             product_id, destination_location_id, packaging_id,
             ordered_quantity, received_quantity, base_unit_code, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4,
             $5, $6, $7,
             $8, 0.000, $9, NOW(), NOW()
           )`,
          [
            propertyId,
            transactionId,
            lineId,
            derivedLineType,
            tl.product_id ? Number(tl.product_id) : null,
            defaultLocId,
            line.packaging_id ? Number(line.packaging_id) : null,
            tl.quantity,
            baseUnit,
          ]
        );

        bindingRes = await client.query(
          `SELECT *
             FROM stock_purchase_line_bindings
            WHERE property_id = $1 AND transaction_id = $2 AND transaction_line_id = $3
            FOR UPDATE`,
          [propertyId, transactionId, lineId]
        );
      }

      const binding = bindingRes.rows[0];

      // Guard 2: Kuantitas Plafon PO (R-07)
      const orderedMilli = BigInt(Math.round(Number(binding.ordered_quantity) * 1000));
      const currentReceivedMilli = BigInt(Math.round(Number(binding.received_quantity) * 1000));
      const newReceivedMilli = parseRecv.milli;

      if (currentReceivedMilli + newReceivedMilli > orderedMilli) {
        const remainingStr = (Number(orderedMilli - currentReceivedMilli) / 1000).toFixed(3);
        throw Object.assign(
          new Error(
            `RECEIPT_QUANTITY_EXCEEDS_ORDERED: Kuantitas penerimaan (${parseRecv.formatted3}) melebihi sisa pesanan (${remainingStr}) pada baris #${lineId}`
          ),
          { statusCode: 400, code: 'RECEIPT_QUANTITY_EXCEEDS_ORDERED' }
        );
      }

      const lineType = binding.line_type as StockPurchaseLineType;

      if (lineType === 'STOCK') {
        // Guard 3: Kunci pos_menu_items dan pastikan track_stock = TRUE
        const productId = line.product_id ? Number(line.product_id) : (binding.product_id ? Number(binding.product_id) : null);
        if (!productId) {
          throw Object.assign(
            new Error(`Baris bertipe STOCK pada baris #${lineId} wajib memiliki product_id`),
            { statusCode: 400, code: 'PRODUCT_REQUIRED_FOR_STOCK_LINE' }
          );
        }

        const prodRes = await client.query(
          `SELECT id, property_id, name, base_unit, canonical_base_unit_code, track_stock, is_active
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

        // Konversi Kemasan (R-06) jika menggunakan packaging_id
        const packagingIdParam = line.packaging_id !== undefined ? line.packaging_id : binding.packaging_id;
        let baseQuantityDelta = parseRecv.formatted3;
        let packagingIdVal: number | null = null;
        let packagingCodeVal: string | null = null;
        let packagingLabelVal: string | null = null;

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

          const conv = convertPackagingToBaseQuantity({
            packagingQty: parseRecv.formatted3,
            toBaseFactor: pkg.to_base_factor,
            baseUnitCode: pkg.base_unit_code,
          });

          if (!conv.ok) {
            throw Object.assign(new Error(conv.error), { statusCode: conv.status, code: conv.code });
          }

          baseQuantityDelta = conv.formatted3;
          packagingIdVal = Number(pkg.id);
          packagingCodeVal = pkg.packaging_code;
          packagingLabelVal = pkg.packaging_label;
        }

        preparedStockItems.push({
          lineId,
          bindingId: Number(binding.id),
          productId,
          destinationLocationId,
          quantityReceived: parseRecv.formatted3,
          baseQuantityDelta,
          baseUnitCode,
          packagingId: packagingIdVal,
          packagingCode: packagingCodeVal,
          packagingLabel: packagingLabelVal,
        });
      } else {
        // Baris NON_STOCK_PHYSICAL atau SERVICE (R-03)
        preparedNonStockItems.push({
          lineId,
          bindingId: Number(binding.id),
          lineType,
          quantityReceived: parseRecv.formatted3,
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

    // 2. Eksekusi tiap baris STOCK ke stock_movements & stock_balances
    for (const item of preparedStockItems) {
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

      await client.query(
        `UPDATE stock_purchase_line_bindings
            SET received_quantity = received_quantity + $1,
                destination_location_id = COALESCE(destination_location_id, $2),
                packaging_id = COALESCE(packaging_id, $3),
                updated_at = NOW()
          WHERE id = $4`,
        [item.quantityReceived, item.destinationLocationId, item.packagingId, item.bindingId]
      );

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


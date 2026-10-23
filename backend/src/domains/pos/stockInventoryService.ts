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
      itemIndex: number;
      physicalBaseQtyStr: string;
    }> = [];

    for (let i = 0; i < sortedItems.length; i++) {
      const item = sortedItems[i];
      const pid = Number(item.product_id);

      // Kunci produk FOR UPDATE
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
          mov.productId,
          locationId,
          mov.packagingId,
          mov.packagingCode,
          mov.packagingLabel,
          mov.deltaStr,
          mov.baseUnitCode,
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

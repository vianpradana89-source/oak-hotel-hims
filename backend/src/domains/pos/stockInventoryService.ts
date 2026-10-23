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

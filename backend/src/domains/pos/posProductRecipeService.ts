import { Pool, PoolClient } from 'pg';
import type { Request, Response } from 'express';

export interface PosProductRecipeDeps {
  pool: Pool;
  assertPropertyScope?: (req: any, resOrPropId: any, maybePropId?: any) => Promise<void>;
}

async function invokeAssertPropertyScope(
  fn: PosProductRecipeDeps['assertPropertyScope'],
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

export interface PosProductUomRecord {
  id: number;
  property_id: number | null;
  code: string;
  name: string;
  category: string;
  created_at: string;
}

export interface PosRecipeIngredientRecord {
  id: number;
  recipe_id: number;
  property_id: number;
  product_id: number;
  ingredient_product_id: number;
  ingredient_name: string;
  ingredient_code: string | null;
  ingredient_base_unit: string | null;
  ingredient_canonical_unit: string | null;
  ingredient_track_stock: boolean;
  quantity: string;
  uom_id: number | null;
  uom_code: string | null;
  uom_name: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PosProductRecipeDetail {
  product: {
    id: number;
    property_id: number;
    name: string;
    item_code: string | null;
    price: string | null;
    base_unit: string | null;
    canonical_base_unit_code: string | null;
    product_type: string | null;
    is_raw_material: boolean;
    track_stock: boolean;
    track_inventory: boolean;
  };
  ingredients: PosRecipeIngredientRecord[];
}

export interface SaveRecipeIngredientDTO {
  propertyId: number;
  productId: number;
  ingredientProductId: number;
  quantity: number;
  uomId?: number | null;
  notes?: string | null;
}

/**
 * Mengambil daftar satuan ukur (Units of Measurement) untuk resep produk.
 */
export async function getPosProductUoms(
  poolOrClient: Pool | PoolClient,
  propertyId?: number
): Promise<PosProductUomRecord[]> {
  const querySql = `
    SELECT id, property_id, code, name, category, created_at
      FROM pos_product_uoms
     WHERE property_id IS NULL OR ($1::int IS NOT NULL AND property_id = $1::int)
     ORDER BY
       CASE
         WHEN code IN ('GRAM', 'KG', 'ML', 'LITER', 'PCS', 'PORSI') THEN 1
         ELSE 2
       END, code ASC
  `;
  const res = await poolOrClient.query(querySql, [propertyId || null]);
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    property_id: r.property_id ? Number(r.property_id) : null,
    code: r.code,
    name: r.name,
    category: r.category,
    created_at: r.created_at,
  }));
}

/**
 * Mengambil resep lengkap (Bill of Materials) untuk satu produk / menu.
 */
export async function getProductRecipe(
  poolOrClient: Pool | PoolClient,
  propertyId: number,
  productId: number
): Promise<PosProductRecipeDetail> {
  const prodRes = await poolOrClient.query(
    `SELECT id, property_id, name, item_code, price, base_unit,
            canonical_base_unit_code, product_type, is_raw_material,
            track_stock, track_inventory
       FROM pos_menu_items
      WHERE id = $1 AND property_id = $2`,
    [productId, propertyId]
  );

  if (prodRes.rowCount === 0) {
    throw Object.assign(
      new Error(`Produk menu #${productId} tidak ditemukan pada properti #${propertyId}`),
      { statusCode: 404, code: 'PRODUCT_NOT_FOUND' }
    );
  }

  const p = prodRes.rows[0];

  const ingRes = await poolOrClient.query(
    `SELECT r.id, r.property_id, r.product_id, r.ingredient_product_id,
            r.quantity, r.uom_id, r.notes, r.created_at, r.updated_at,
            i.name AS ingredient_name, i.item_code AS ingredient_code,
            i.base_unit AS ingredient_base_unit,
            i.canonical_base_unit_code AS ingredient_canonical_unit,
            i.track_stock AS ingredient_track_stock,
            u.code AS uom_code, u.name AS uom_name
       FROM pos_product_recipes r
       JOIN pos_menu_items i ON i.id = r.ingredient_product_id
       LEFT JOIN pos_product_uoms u ON u.id = r.uom_id
      WHERE r.property_id = $1 AND r.product_id = $2
      ORDER BY r.id ASC`,
    [propertyId, productId]
  );

  return {
    product: {
      id: Number(p.id),
      property_id: Number(p.property_id),
      name: p.name,
      item_code: p.item_code || null,
      price: p.price !== null ? String(p.price) : null,
      base_unit: p.base_unit || null,
      canonical_base_unit_code: p.canonical_base_unit_code || null,
      product_type: p.product_type || null,
      is_raw_material: Boolean(p.is_raw_material),
      track_stock: Boolean(p.track_stock),
      track_inventory: Boolean(p.track_inventory),
    },
    ingredients: ingRes.rows.map((r: any) => ({
      id: Number(r.id),
      recipe_id: Number(r.id),
      property_id: Number(r.property_id),
      product_id: Number(r.product_id),
      ingredient_product_id: Number(r.ingredient_product_id),
      ingredient_name: r.ingredient_name,
      ingredient_code: r.ingredient_code || null,
      ingredient_base_unit: r.ingredient_base_unit || null,
      ingredient_canonical_unit: r.ingredient_canonical_unit || null,
      ingredient_track_stock: Boolean(r.ingredient_track_stock),
      quantity: String(r.quantity),
      uom_id: r.uom_id ? Number(r.uom_id) : null,
      uom_code: r.uom_code || null,
      uom_name: r.uom_name || null,
      notes: r.notes || null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
  };
}

/**
 * Menambahkan atau memperbarui bahan baku pada resep menu (BOM).
 */
export async function addOrUpdateRecipeIngredient(
  poolOrClient: Pool | PoolClient,
  dto: SaveRecipeIngredientDTO
): Promise<PosRecipeIngredientRecord> {
  const { propertyId, productId, ingredientProductId, quantity, uomId, notes } = dto;

  if (!productId || productId <= 0) {
    throw Object.assign(new Error('product_id tidak valid'), { statusCode: 400, code: 'INVALID_PRODUCT_ID' });
  }

  if (!ingredientProductId || ingredientProductId <= 0) {
    throw Object.assign(new Error('ingredient_product_id tidak valid'), {
      statusCode: 400,
      code: 'INVALID_INGREDIENT_PRODUCT_ID',
    });
  }

  if (productId === ingredientProductId) {
    throw Object.assign(new Error('Produk tidak dapat menjadi bahan baku untuk dirinya sendiri'), {
      statusCode: 400,
      code: 'CIRCULAR_RECIPE_SELF_REFERENCE',
    });
  }

  const numQty = parseFloat(String(quantity));
  if (isNaN(numQty) || numQty <= 0) {
    throw Object.assign(new Error('Kuantitas bahan baku harus berupa angka positif lebih dari 0'), {
      statusCode: 400,
      code: 'INVALID_RECIPE_QUANTITY',
    });
  }

  // 1. Verifikasi kepemilikan tenant untuk product_id
  const prodCheck = await poolOrClient.query(
    `SELECT id, name FROM pos_menu_items WHERE id = $1 AND property_id = $2`,
    [productId, propertyId]
  );
  if (prodCheck.rowCount === 0) {
    throw Object.assign(
      new Error(`Produk menu #${productId} tidak ditemukan pada properti #${propertyId}`),
      { statusCode: 404, code: 'PRODUCT_NOT_FOUND' }
    );
  }
  const productName = prodCheck.rows[0].name;

  // 2. Verifikasi kepemilikan tenant untuk ingredient_product_id
  const ingCheck = await poolOrClient.query(
    `SELECT id, name, canonical_base_unit_code, base_unit, track_stock, track_inventory
       FROM pos_menu_items WHERE id = $1 AND property_id = $2`,
    [ingredientProductId, propertyId]
  );
  if (ingCheck.rowCount === 0) {
    throw Object.assign(
      new Error(`Bahan baku #${ingredientProductId} tidak ditemukan pada properti #${propertyId}`),
      { statusCode: 404, code: 'INGREDIENT_NOT_FOUND' }
    );
  }
  const ingredientName = ingCheck.rows[0].name;

  // 3. Deteksi Circular Dependency: cek apakah ingredient_product_id sudah mencakup productId dalam resepnya
  const cycleQuery = `
    WITH RECURSIVE recipe_chain AS (
      SELECT product_id, ingredient_product_id, 1 AS depth
        FROM pos_product_recipes
       WHERE property_id = $1 AND product_id = $2
      UNION ALL
      SELECT r.product_id, r.ingredient_product_id, rc.depth + 1
        FROM pos_product_recipes r
        JOIN recipe_chain rc ON r.product_id = rc.ingredient_product_id
       WHERE r.property_id = $1 AND rc.depth < 10
    )
    SELECT 1 FROM recipe_chain WHERE ingredient_product_id = $3 LIMIT 1;
  `;
  const cycleRes = await poolOrClient.query(cycleQuery, [propertyId, ingredientProductId, productId]);
  if (cycleRes.rowCount && cycleRes.rowCount > 0) {
    throw Object.assign(
      new Error(
        `Terdeteksi dependensi sirkular: "${ingredientName}" telah bergantung secara langsung/tidak langsung pada "${productName}".`
      ),
      { statusCode: 400, code: 'CIRCULAR_RECIPE_DEPENDENCY' }
    );
  }

  // 4. Resolusi UoM jika uomId diberikan atau jika tidak diisi, gunakan satuan dasar ingredient
  let resolvedUomId: number | null = null;
  if (uomId && Number(uomId) > 0) {
    const uomRes = await poolOrClient.query(
      `SELECT id FROM pos_product_uoms WHERE id = $1 AND (property_id IS NULL OR property_id = $2)`,
      [uomId, propertyId]
    );
    if (uomRes.rows.length > 0) {
      resolvedUomId = Number(uomRes.rows[0].id);
    }
  }

  // Jika uomId tidak diisi, coba cocokkan dengan canonical_base_unit_code atau base_unit
  if (!resolvedUomId) {
    const unitCode = (ingCheck.rows[0].canonical_base_unit_code || ingCheck.rows[0].base_unit || '').trim().toUpperCase();
    if (unitCode) {
      const matchUom = await poolOrClient.query(
        `SELECT id FROM pos_product_uoms WHERE UPPER(code) = $1 AND (property_id IS NULL OR property_id = $2) LIMIT 1`,
        [unitCode, propertyId]
      );
      if (matchUom.rows.length > 0) {
        resolvedUomId = Number(matchUom.rows[0].id);
      }
    }
  }

  // 5. Simpan (UPSERT)
  const upsertSql = `
    INSERT INTO pos_product_recipes (
      property_id, product_id, ingredient_product_id, quantity, uom_id, notes, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, NOW(), NOW()
    )
    ON CONFLICT (property_id, product_id, ingredient_product_id)
    DO UPDATE SET
      quantity = EXCLUDED.quantity,
      uom_id = COALESCE(EXCLUDED.uom_id, pos_product_recipes.uom_id),
      notes = EXCLUDED.notes,
      updated_at = NOW()
    RETURNING id, property_id, product_id, ingredient_product_id, quantity, uom_id, notes, created_at, updated_at
  `;

  const res = await poolOrClient.query(upsertSql, [
    propertyId,
    productId,
    ingredientProductId,
    numQty.toFixed(4),
    resolvedUomId,
    notes ? notes.trim() : null,
  ]);

  const row = res.rows[0];

  // Ambil UoM detail untuk respons
  let uomCode: string | null = null;
  let uomName: string | null = null;
  if (resolvedUomId) {
    const uRes = await poolOrClient.query(`SELECT code, name FROM pos_product_uoms WHERE id = $1`, [resolvedUomId]);
    if (uRes.rows.length > 0) {
      uomCode = uRes.rows[0].code;
      uomName = uRes.rows[0].name;
    }
  }

  return {
    id: Number(row.id),
    recipe_id: Number(row.id),
    property_id: Number(row.property_id),
    product_id: Number(row.product_id),
    ingredient_product_id: Number(row.ingredient_product_id),
    ingredient_name: ingredientName,
    ingredient_code: ingCheck.rows[0].item_code || null,
    ingredient_base_unit: ingCheck.rows[0].base_unit || null,
    ingredient_canonical_unit: ingCheck.rows[0].canonical_base_unit_code || null,
    ingredient_track_stock: Boolean(ingCheck.rows[0].track_stock),
    quantity: String(row.quantity),
    uom_id: resolvedUomId,
    uom_code: uomCode,
    uom_name: uomName,
    notes: row.notes || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Menghapus satu komponen resep berdasarkan recipe_id.
 */
export async function deleteRecipeIngredient(
  poolOrClient: Pool | PoolClient,
  propertyId: number,
  recipeId: number
): Promise<{ deleted: boolean; recipe_id: number }> {
  const delRes = await poolOrClient.query(
    `DELETE FROM pos_product_recipes WHERE id = $1 AND property_id = $2 RETURNING id`,
    [recipeId, propertyId]
  );

  if (delRes.rowCount === 0) {
    throw Object.assign(
      new Error(`Komponen resep #${recipeId} tidak ditemukan pada properti #${propertyId}`),
      { statusCode: 404, code: 'RECIPE_ITEM_NOT_FOUND' }
    );
  }

  return { deleted: true, recipe_id: recipeId };
}

/**
 * Menghapus komponen resep berdasarkan product_id dan ingredient_product_id.
 */
export async function deleteRecipeIngredientByProduct(
  poolOrClient: Pool | PoolClient,
  propertyId: number,
  productId: number,
  ingredientProductId: number
): Promise<{ deleted: boolean }> {
  const delRes = await poolOrClient.query(
    `DELETE FROM pos_product_recipes
      WHERE property_id = $1 AND product_id = $2 AND ingredient_product_id = $3
     RETURNING id`,
    [propertyId, productId, ingredientProductId]
  );

  return { deleted: (delRes.rowCount ?? 0) > 0 };
}

/**
 * Mengambil daftar produk yang dapat dijadikan bahan baku (Raw Material / Produk Terlacak).
 */
export async function getRawMaterialCandidates(
  poolOrClient: Pool | PoolClient,
  propertyId: number,
  excludeProductId?: number
): Promise<Array<{
  id: number;
  name: string;
  item_code: string | null;
  base_unit: string | null;
  canonical_base_unit_code: string | null;
  product_type: string | null;
  is_raw_material: boolean;
  track_stock: boolean;
}>> {
  const querySql = `
    SELECT id, name, item_code, base_unit, canonical_base_unit_code,
           product_type, is_raw_material, track_stock
      FROM pos_menu_items
     WHERE property_id = $1
       AND is_active = TRUE
       AND ($2::int IS NULL OR id != $2::int)
     ORDER BY
       CASE WHEN is_raw_material = TRUE OR product_type = 'RAW_MATERIAL' THEN 1 ELSE 2 END,
       name ASC
  `;

  const res = await poolOrClient.query(querySql, [propertyId, excludeProductId || null]);
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    name: r.name,
    item_code: r.item_code || null,
    base_unit: r.base_unit || null,
    canonical_base_unit_code: r.canonical_base_unit_code || null,
    product_type: r.product_type || null,
    is_raw_material: Boolean(r.is_raw_material),
    track_stock: Boolean(r.track_stock),
  }));
}

/**
 * Handler: GET /api/pos/uoms
 */
export function createPosProductUomsHandler(deps: PosProductRecipeDeps) {
  return async function handlePosProductUoms(req: Request, res: Response) {
    try {
      const propertyId = req.query?.property_id ? Number(req.query.property_id) : undefined;
      const uoms = await getPosProductUoms(deps.pool, propertyId);
      return res.status(200).json({ status: 'OK', data: uoms });
    } catch (err: any) {
      return res.status(500).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal mengambil daftar UoM',
      });
    }
  };
}

/**
 * Handler: GET /api/pos/products/:id/recipe & GET /api/pos/menu/items/:id/recipe
 */
export function createProductRecipeGetHandler(deps: PosProductRecipeDeps) {
  return async function handleProductRecipeGet(req: Request, res: Response) {
    try {
      const productId = Number(req.params.id);
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'id produk wajib berupa bilangan bulat positif',
        });
      }

      // Ambil property_id dari query atau langsung dari tabel pos_menu_items
      let propertyId = req.query?.property_id ? Number(req.query.property_id) : 0;
      if (!propertyId || propertyId <= 0) {
        const itemPropRes = await deps.pool.query(
          `SELECT property_id FROM pos_menu_items WHERE id = $1`,
          [productId]
        );
        if (itemPropRes.rows.length === 0) {
          return res.status(404).json({
            status: 'ERROR',
            code: 'PRODUCT_NOT_FOUND',
            message: `Produk menu #${productId} tidak ditemukan`,
          });
        }
        propertyId = Number(itemPropRes.rows[0].property_id);
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const recipe = await getProductRecipe(deps.pool, propertyId, productId);
      return res.status(200).json({ status: 'OK', data: recipe });
    } catch (err: any) {
      const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(sc).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal mengambil resep produk',
      });
    }
  };
}

/**
 * Handler: POST /api/pos/products/:id/recipe & POST /api/pos/menu/items/:id/recipe
 */
export function createProductRecipeSaveHandler(deps: PosProductRecipeDeps) {
  return async function handleProductRecipeSave(req: Request, res: Response) {
    try {
      const productId = Number(req.params.id);
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'id produk wajib berupa bilangan bulat positif',
        });
      }

      let propertyId = req.body?.property_id ? Number(req.body.property_id) : 0;
      if (!propertyId || propertyId <= 0) {
        const itemPropRes = await deps.pool.query(
          `SELECT property_id FROM pos_menu_items WHERE id = $1`,
          [productId]
        );
        if (itemPropRes.rows.length === 0) {
          return res.status(404).json({
            status: 'ERROR',
            code: 'PRODUCT_NOT_FOUND',
            message: `Produk menu #${productId} tidak ditemukan`,
          });
        }
        propertyId = Number(itemPropRes.rows[0].property_id);
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      // Jika dikirim satu komponen:
      const { ingredient_product_id, quantity, uom_id, notes } = req.body || {};
      if (ingredient_product_id !== undefined && quantity !== undefined) {
        const ingId = Number(ingredient_product_id);
        const qty = parseFloat(String(quantity));
        const record = await addOrUpdateRecipeIngredient(deps.pool, {
          propertyId,
          productId,
          ingredientProductId: ingId,
          quantity: qty,
          uomId: uom_id ? Number(uom_id) : null,
          notes: notes || null,
        });
        return res.status(201).json({ status: 'OK', data: record });
      }

      return res.status(400).json({
        status: 'ERROR',
        code: 'VALIDATION_ERROR',
        message: 'ingredient_product_id dan quantity wajib diisi',
      });
    } catch (err: any) {
      const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(sc).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal menyimpan resep produk',
      });
    }
  };
}

/**
 * Handler: DELETE /api/pos/recipes/:recipeId
 */
export function createProductRecipeDeleteHandler(deps: PosProductRecipeDeps) {
  return async function handleProductRecipeDelete(req: Request, res: Response) {
    try {
      const recipeId = Number(req.params.recipeId);
      if (!Number.isInteger(recipeId) || recipeId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'recipeId wajib berupa bilangan bulat positif',
        });
      }

      // Ambil property_id dari pos_product_recipes
      const recRes = await deps.pool.query(
        `SELECT property_id FROM pos_product_recipes WHERE id = $1`,
        [recipeId]
      );
      if (recRes.rows.length === 0) {
        return res.status(404).json({
          status: 'ERROR',
          code: 'RECIPE_ITEM_NOT_FOUND',
          message: `Komponen resep #${recipeId} tidak ditemukan`,
        });
      }
      const propertyId = Number(recRes.rows[0].property_id);

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const result = await deleteRecipeIngredient(deps.pool, propertyId, recipeId);
      return res.status(200).json({ status: 'OK', data: result });
    } catch (err: any) {
      const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(sc).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal menghapus komponen resep',
      });
    }
  };
}

/**
 * Handler: GET /api/pos/raw-materials
 */
export function createRawMaterialsListHandler(deps: PosProductRecipeDeps) {
  return async function handleRawMaterialsList(req: Request, res: Response) {
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

      const excludeProductId = req.query?.exclude_product_id ? Number(req.query.exclude_product_id) : undefined;
      const candidates = await getRawMaterialCandidates(deps.pool, propertyId, excludeProductId);
      return res.status(200).json({ status: 'OK', data: candidates });
    } catch (err: any) {
      const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(sc).json({
        status: 'ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Gagal mengambil daftar bahan baku',
      });
    }
  };
}

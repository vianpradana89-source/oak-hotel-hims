/**
 * OAK HIMS — MP-04E Food Cost Calculation, HPP Margin Analysis & F&B Menu Engineering
 *
 * Mengimplementasikan:
 * 1. Kalkulasi real-time HPP (Cost of Goods Sold / COGS) per porsi berdasarkan Bill of Materials (BOM)
 *    dari pos_product_recipes dan weighted moving average cost aktual bahan baku di pos_menu_items.
 * 2. Analisis margin profit kotor (Gross Profit) dan persentase Food Cost ((HPP / Selling Price) * 100%).
 * 3. Matriks Menu Engineering F&B (Kasavana & Smith 1982 model) mengelompokkan menu ke dalam 4 kuadran:
 *    - STARS: Popularitas Tinggi, Margin Tinggi
 *    - PLOWHORSES: Popularitas Tinggi, Margin Rendah
 *    - PUZZLES: Popularitas Rendah, Margin Tinggi
 *    - DOGS: Popularitas Rendah, Margin Rendah
 *    beserta rekomendasi taktis otomatis untuk pengelola hotel/restoran.
 */

import type { Pool, PoolClient } from 'pg';

export interface IngredientCostDetail {
  recipe_id: number;
  ingredient_id: number;
  ingredient_name: string;
  ingredient_code: string | null;
  quantity: number;
  uom_id: number | null;
  uom_code: string | null;
  uom_name: string | null;
  unit_cost: number;
  subtotal_cost: number;
  cost_share_percentage: number;
  notes: string | null;
}

export type FoodCostClassification =
  | 'LOW_COST'
  | 'HEALTHY'
  | 'OVER_COST'
  | 'NO_RECIPE'
  | 'ZERO_COST';

export interface ProductFoodCostAnalysis {
  product_id: number;
  property_id: number;
  product_name: string;
  item_code: string | null;
  category_id: number | null;
  category_name: string | null;
  selling_price: number;
  hpp: number; // Total HPP per porsi
  gross_profit: number; // selling_price - hpp
  food_cost_percentage: number; // (hpp / selling_price) * 100
  classification: FoodCostClassification;
  classification_label: string;
  has_recipe: boolean;
  ingredient_count: number;
  ingredients: IngredientCostDetail[];
}

export interface FoodCostOverviewSummary {
  total_items: number;
  items_with_recipe: number;
  average_food_cost_percentage: number;
  count_low_cost: number;
  count_healthy: number;
  count_over_cost: number;
  count_no_recipe: number;
}

export interface FoodCostOverviewItem {
  product_id: number;
  product_name: string;
  item_code: string | null;
  category_id: number | null;
  category_name: string | null;
  selling_price: number;
  hpp: number;
  gross_profit: number;
  food_cost_percentage: number;
  classification: FoodCostClassification;
  classification_label: string;
  has_recipe: boolean;
  ingredient_count: number;
}

export interface FoodCostOverviewResponse {
  summary: FoodCostOverviewSummary;
  items: FoodCostOverviewItem[];
}

export type MenuEngineeringQuadrant = 'STARS' | 'PLOWHORSES' | 'PUZZLES' | 'DOGS';

export interface MenuEngineeringItem {
  product_id: number;
  product_name: string;
  item_code: string | null;
  category_id: number | null;
  category_name: string | null;
  selling_price: number;
  hpp: number;
  unit_margin: number; // selling_price - hpp
  quantity_sold: number;
  total_revenue: number;
  total_cost: number;
  total_margin: number; // quantity_sold * unit_margin
  menu_mix_percentage: number; // (quantity_sold / total_volume) * 100
  food_cost_percentage: number; // (hpp / selling_price) * 100
  is_high_popularity: boolean; // menu_mix >= hurdle_rate
  is_high_margin: boolean; // unit_margin >= avg_contribution_margin
  quadrant: MenuEngineeringQuadrant;
  quadrant_label: string;
  recommendation: string;
}

export interface MenuEngineeringReportResponse {
  period: {
    start_date: string;
    end_date: string;
  };
  benchmarks: {
    total_volume_sold: number;
    total_revenue: number;
    total_cost: number;
    total_contribution_margin: number;
    overall_food_cost_percentage: number;
    average_contribution_margin: number;
    average_volume_per_item: number;
    popularity_hurdle_rate_percentage: number; // 70% of 1/N
    distinct_item_count: number;
  };
  quadrants: {
    stars: MenuEngineeringItem[];
    plowhorses: MenuEngineeringItem[];
    puzzles: MenuEngineeringItem[];
    dogs: MenuEngineeringItem[];
  };
  items: MenuEngineeringItem[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Format & Klasifikasi
// ─────────────────────────────────────────────────────────────────────────────

export function classifyFoodCost(
  hasRecipe: boolean,
  hpp: number,
  sellingPrice: number
): { classification: FoodCostClassification; label: string } {
  if (!hasRecipe && hpp <= 0) {
    return { classification: 'NO_RECIPE', label: 'Belum Ada Resep' };
  }
  if (sellingPrice <= 0) {
    return { classification: 'ZERO_COST', label: 'Harga Jual Rp 0' };
  }

  const fcPct = (hpp / sellingPrice) * 100;

  if (fcPct < 30) {
    return { classification: 'LOW_COST', label: 'Biaya Rendah (<30%)' };
  } else if (fcPct <= 35) {
    return { classification: 'HEALTHY', label: 'Ideal (30-35%)' };
  } else {
    return { classification: 'OVER_COST', label: 'Biaya Tinggi (>35%)' };
  }
}

export function getQuadrantRecommendation(quadrant: MenuEngineeringQuadrant): {
  label: string;
  recommendation: string;
} {
  switch (quadrant) {
    case 'STARS':
      return {
        label: 'Stars (Bintang)',
        recommendation:
          'Pertahankan resep & konsistensi porsi. Berikan posisi visual utama di menu. Jaga harga jual dan hindari diskon berlebihan.',
      };
    case 'PLOWHORSES':
      return {
        label: 'Plowhorses (Kuda Beban)',
        recommendation:
          'Sangat diminati namun margin tipis. Tinjau porsi resep bahan baku, negosiasikan harga beli dengan supplier, atau naikkan harga jual secara bertahap.',
      };
    case 'PUZZLES':
      return {
        label: 'Puzzles (Teka-Teki)',
        recommendation:
          'Margin profit tinggi namun volume penjualan rendah. Berikan promosi khusus, instruksikan staf kasir untuk upselling, atau ubah penempatan/nama menu.',
      };
    case 'DOGS':
      return {
        label: 'Dogs (Anjing)',
        recommendation:
          'Popularitas dan margin rendah. Evaluasi kelangsungan menu ini. Pertimbangkan modifikasi resep, bundling paket, atau ganti dengan menu alternatif yang lebih diminati.',
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. getProductFoodCostAnalysis
// ─────────────────────────────────────────────────────────────────────────────

export async function getProductFoodCostAnalysis(
  poolOrClient: Pool | PoolClient,
  propertyId: number,
  productId: number
): Promise<ProductFoodCostAnalysis> {
  const prodRes = await poolOrClient.query(
    `SELECT p.id, p.property_id, p.name, p.item_code, p.price,
            p.average_cost, p.last_cost, p.category_id,
            c.name AS category_name
       FROM pos_menu_items p
       LEFT JOIN pos_menu_categories c ON c.id = p.category_id
      WHERE p.property_id = $1 AND p.id = $2`,
    [propertyId, productId]
  );

  if (prodRes.rowCount === 0) {
    throw Object.assign(
      new Error(`Produk menu #${productId} tidak ditemukan pada properti #${propertyId}`),
      { statusCode: 404, code: 'PRODUCT_NOT_FOUND' }
    );
  }

  const p = prodRes.rows[0];
  const sellingPrice = p.price !== null ? parseFloat(p.price) : 0;

  // Ambil rincian resep bahan baku
  const ingRes = await poolOrClient.query(
    `SELECT r.id AS recipe_id, r.ingredient_product_id, r.quantity, r.uom_id, r.notes,
            i.name AS ingredient_name, i.item_code AS ingredient_code,
            i.average_cost, i.last_cost,
            u.code AS uom_code, u.name AS uom_name
       FROM pos_product_recipes r
       JOIN pos_menu_items i ON i.id = r.ingredient_product_id
       LEFT JOIN pos_product_uoms u ON u.id = r.uom_id
      WHERE r.property_id = $1 AND r.product_id = $2
      ORDER BY r.id ASC`,
    [propertyId, productId]
  );

  const hasRecipe = ingRes.rows.length > 0;
  let totalHpp = 0;
  const rawIngredients: Array<{
    recipe_id: number;
    ingredient_id: number;
    ingredient_name: string;
    ingredient_code: string | null;
    quantity: number;
    uom_id: number | null;
    uom_code: string | null;
    uom_name: string | null;
    unit_cost: number;
    subtotal_cost: number;
    notes: string | null;
  }> = [];

  if (hasRecipe) {
    for (const row of ingRes.rows) {
      const qty = parseFloat(row.quantity) || 0;
      const avgCost = row.average_cost !== null ? parseFloat(row.average_cost) : 0;
      const lastCost = row.last_cost !== null ? parseFloat(row.last_cost) : 0;
      const unitCost = avgCost > 0 ? avgCost : lastCost > 0 ? lastCost : 0;
      const subtotal = Math.round(qty * unitCost * 100) / 100;

      totalHpp += subtotal;
      rawIngredients.push({
        recipe_id: Number(row.recipe_id),
        ingredient_id: Number(row.ingredient_product_id),
        ingredient_name: row.ingredient_name,
        ingredient_code: row.ingredient_code || null,
        quantity: qty,
        uom_id: row.uom_id ? Number(row.uom_id) : null,
        uom_code: row.uom_code || null,
        uom_name: row.uom_name || null,
        unit_cost: unitCost,
        subtotal_cost: subtotal,
        notes: row.notes || null,
      });
    }
  } else {
    // Non-BOM / produk retail langsung
    const avgCost = p.average_cost !== null ? parseFloat(p.average_cost) : 0;
    const lastCost = p.last_cost !== null ? parseFloat(p.last_cost) : 0;
    totalHpp = avgCost > 0 ? avgCost : lastCost > 0 ? lastCost : 0;
  }

  totalHpp = Math.round(totalHpp * 100) / 100;
  const grossProfit = Math.round((sellingPrice - totalHpp) * 100) / 100;
  const foodCostPct =
    sellingPrice > 0 ? Math.round((totalHpp / sellingPrice) * 10000) / 100 : 0;

  const { classification, label: classificationLabel } = classifyFoodCost(
    hasRecipe,
    totalHpp,
    sellingPrice
  );

  const ingredientsWithShare: IngredientCostDetail[] = rawIngredients.map((item) => ({
    ...item,
    cost_share_percentage:
      totalHpp > 0 ? Math.round((item.subtotal_cost / totalHpp) * 10000) / 100 : 0,
  }));

  return {
    product_id: Number(p.id),
    property_id: Number(p.property_id),
    product_name: p.name,
    item_code: p.item_code || null,
    category_id: p.category_id ? Number(p.category_id) : null,
    category_name: p.category_name || null,
    selling_price: sellingPrice,
    hpp: totalHpp,
    gross_profit: grossProfit,
    food_cost_percentage: foodCostPct,
    classification,
    classification_label: classificationLabel,
    has_recipe: hasRecipe,
    ingredient_count: ingredientsWithShare.length,
    ingredients: ingredientsWithShare,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. getFoodCostOverview
// ─────────────────────────────────────────────────────────────────────────────

export async function getFoodCostOverview(
  poolOrClient: Pool | PoolClient,
  propertyId: number,
  options?: {
    categoryId?: number;
    status?: FoodCostClassification | 'ALL';
    search?: string;
  }
): Promise<FoodCostOverviewResponse> {
  // Ambil semua menu aktif dan sellable
  let query = `
    SELECT p.id, p.name, p.item_code, p.price, p.average_cost, p.last_cost,
           p.category_id, c.name AS category_name
      FROM pos_menu_items p
      LEFT JOIN pos_menu_categories c ON c.id = p.category_id
     WHERE p.property_id = $1
       AND p.is_active = TRUE
       AND p.is_sellable_pos = TRUE
  `;
  const queryParams: any[] = [propertyId];

  if (options?.categoryId) {
    queryParams.push(options.categoryId);
    query += ` AND p.category_id = $${queryParams.length}`;
  }

  if (options?.search && options.search.trim()) {
    queryParams.push(`%${options.search.trim().toLowerCase()}%`);
    query += ` AND (LOWER(p.name) LIKE $${queryParams.length} OR LOWER(COALESCE(p.item_code, '')) LIKE $${queryParams.length})`;
  }

  query += ` ORDER BY p.name ASC`;

  const prodsRes = await poolOrClient.query(query, queryParams);

  // Ambil semua resep properti ini
  const recipesRes = await poolOrClient.query(
    `SELECT r.product_id, r.quantity,
            i.average_cost, i.last_cost
       FROM pos_product_recipes r
       JOIN pos_menu_items i ON i.id = r.ingredient_product_id
      WHERE r.property_id = $1`,
    [propertyId]
  );

  // Petakan resep per product_id
  const recipeCostMap = new Map<number, { totalHpp: number; ingredientCount: number }>();
  for (const r of recipesRes.rows) {
    const pid = Number(r.product_id);
    const qty = parseFloat(r.quantity) || 0;
    const avgCost = r.average_cost !== null ? parseFloat(r.average_cost) : 0;
    const lastCost = r.last_cost !== null ? parseFloat(r.last_cost) : 0;
    const unitCost = avgCost > 0 ? avgCost : lastCost > 0 ? lastCost : 0;
    const subtotal = qty * unitCost;

    const existing = recipeCostMap.get(pid) || { totalHpp: 0, ingredientCount: 0 };
    existing.totalHpp += subtotal;
    existing.ingredientCount += 1;
    recipeCostMap.set(pid, existing);
  }

  const items: FoodCostOverviewItem[] = [];
  let sumFcPct = 0;
  let countFcPctValid = 0;
  let countLow = 0;
  let countHealthy = 0;
  let countOver = 0;
  let countNoRecipe = 0;
  let itemsWithRecipe = 0;

  for (const p of prodsRes.rows) {
    const pid = Number(p.id);
    const sellingPrice = p.price !== null ? parseFloat(p.price) : 0;
    const rec = recipeCostMap.get(pid);

    let hpp = 0;
    let hasRecipe = false;
    let ingredientCount = 0;

    if (rec && rec.ingredientCount > 0) {
      hasRecipe = true;
      hpp = Math.round(rec.totalHpp * 100) / 100;
      ingredientCount = rec.ingredientCount;
      itemsWithRecipe++;
    } else {
      const avgCost = p.average_cost !== null ? parseFloat(p.average_cost) : 0;
      const lastCost = p.last_cost !== null ? parseFloat(p.last_cost) : 0;
      hpp = Math.round((avgCost > 0 ? avgCost : lastCost > 0 ? lastCost : 0) * 100) / 100;
    }

    const grossProfit = Math.round((sellingPrice - hpp) * 100) / 100;
    const fcPct =
      sellingPrice > 0 ? Math.round((hpp / sellingPrice) * 10000) / 100 : 0;

    const { classification, label: classificationLabel } = classifyFoodCost(
      hasRecipe,
      hpp,
      sellingPrice
    );

    // Filter status jika diisi
    if (options?.status && options.status !== 'ALL' && classification !== options.status) {
      continue;
    }

    // Statistik
    if (classification === 'LOW_COST') countLow++;
    else if (classification === 'HEALTHY') countHealthy++;
    else if (classification === 'OVER_COST') countOver++;
    else if (classification === 'NO_RECIPE') countNoRecipe++;

    if (sellingPrice > 0 && hpp > 0) {
      sumFcPct += fcPct;
      countFcPctValid++;
    }

    items.push({
      product_id: pid,
      product_name: p.name,
      item_code: p.item_code || null,
      category_id: p.category_id ? Number(p.category_id) : null,
      category_name: p.category_name || null,
      selling_price: sellingPrice,
      hpp,
      gross_profit: grossProfit,
      food_cost_percentage: fcPct,
      classification,
      classification_label: classificationLabel,
      has_recipe: hasRecipe,
      ingredient_count: ingredientCount,
    });
  }

  const averageFoodCostPercentage =
    countFcPctValid > 0 ? Math.round((sumFcPct / countFcPctValid) * 100) / 100 : 0;

  return {
    summary: {
      total_items: items.length,
      items_with_recipe: itemsWithRecipe,
      average_food_cost_percentage: averageFoodCostPercentage,
      count_low_cost: countLow,
      count_healthy: countHealthy,
      count_over_cost: countOver,
      count_no_recipe: countNoRecipe,
    },
    items,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. getMenuEngineeringReport
// ─────────────────────────────────────────────────────────────────────────────

export async function getMenuEngineeringReport(
  poolOrClient: Pool | PoolClient,
  propertyId: number,
  startDate?: string,
  endDate?: string,
  categoryId?: number
): Promise<MenuEngineeringReportResponse> {
  // Default tanggal: 30 hari terakhir bila tidak ditentukan
  const end = endDate || new Date().toISOString().slice(0, 10);
  const start =
    startDate ||
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Ambil agregasi penjualan menu berstatus PAID dalam rentang tanggal
  let salesQuery = `
    SELECT poi.menu_item_id,
           p.name AS product_name,
           p.item_code,
           p.price AS master_price,
           p.average_cost,
           p.last_cost,
           p.category_id,
           c.name AS category_name,
           SUM(poi.quantity)::numeric AS quantity_sold,
           SUM(poi.quantity * poi.unit_price)::numeric AS total_revenue
      FROM pos_order_items poi
      JOIN pos_orders po ON po.id = poi.order_id
      JOIN pos_menu_items p ON p.id = poi.menu_item_id
      LEFT JOIN pos_menu_categories c ON c.id = p.category_id
     WHERE po.property_id = $1
       AND po.status = 'PAID'
       AND po.created_at >= $2::date
       AND po.created_at < ($3::date + INTERVAL '1 day')
  `;
  const salesParams: any[] = [propertyId, start, end];

  if (categoryId) {
    salesParams.push(categoryId);
    salesQuery += ` AND p.category_id = $${salesParams.length}`;
  }

  salesQuery += ` GROUP BY poi.menu_item_id, p.name, p.item_code, p.price, p.average_cost, p.last_cost, p.category_id, c.name
                  ORDER BY quantity_sold DESC`;

  const salesRes = await poolOrClient.query(salesQuery, salesParams);

  // Ambil data resep untuk menu yang terjual
  const productIds = salesRes.rows.map((r: any) => Number(r.menu_item_id));
  const recipeCostMap = new Map<number, number>();

  if (productIds.length > 0) {
    const recRes = await poolOrClient.query(
      `SELECT r.product_id, r.quantity,
              i.average_cost, i.last_cost
         FROM pos_product_recipes r
         JOIN pos_menu_items i ON i.id = r.ingredient_product_id
        WHERE r.property_id = $1
          AND r.product_id = ANY($2::int[])`,
      [propertyId, productIds]
    );

    for (const r of recRes.rows) {
      const pid = Number(r.product_id);
      const qty = parseFloat(r.quantity) || 0;
      const avgCost = r.average_cost !== null ? parseFloat(r.average_cost) : 0;
      const lastCost = r.last_cost !== null ? parseFloat(r.last_cost) : 0;
      const unitCost = avgCost > 0 ? avgCost : lastCost > 0 ? lastCost : 0;
      const subtotal = qty * unitCost;

      const current = recipeCostMap.get(pid) || 0;
      recipeCostMap.set(pid, current + subtotal);
    }
  }

  // Hitung total dan agregat
  let totalVolumeSold = 0;
  let totalRevenue = 0;
  let totalCost = 0;
  let totalContributionMargin = 0;

  interface PrecomputedItem {
    product_id: number;
    product_name: string;
    item_code: string | null;
    category_id: number | null;
    category_name: string | null;
    selling_price: number;
    hpp: number;
    unit_margin: number;
    quantity_sold: number;
    total_revenue: number;
    total_cost: number;
    total_margin: number;
    food_cost_percentage: number;
  }

  const precomputed: PrecomputedItem[] = [];

  for (const row of salesRes.rows) {
    const pid = Number(row.menu_item_id);
    const qty = parseFloat(row.quantity_sold) || 0;
    const rev = parseFloat(row.total_revenue) || 0;
    const masterPrice = row.master_price !== null ? parseFloat(row.master_price) : 0;
    // Rata-rata harga jual aktual per item
    const sellingPrice = qty > 0 ? Math.round((rev / qty) * 100) / 100 : masterPrice;

    // HPP: resep atau biaya langsung
    let hpp = 0;
    if (recipeCostMap.has(pid)) {
      hpp = Math.round(recipeCostMap.get(pid)! * 100) / 100;
    } else {
      const avgCost = row.average_cost !== null ? parseFloat(row.average_cost) : 0;
      const lastCost = row.last_cost !== null ? parseFloat(row.last_cost) : 0;
      hpp = Math.round((avgCost > 0 ? avgCost : lastCost > 0 ? lastCost : 0) * 100) / 100;
    }

    const unitMargin = Math.round((sellingPrice - hpp) * 100) / 100;
    const rowCost = Math.round(qty * hpp * 100) / 100;
    const rowMargin = Math.round(qty * unitMargin * 100) / 100;
    const fcPct =
      sellingPrice > 0 ? Math.round((hpp / sellingPrice) * 10000) / 100 : 0;

    totalVolumeSold += qty;
    totalRevenue += rev;
    totalCost += rowCost;
    totalContributionMargin += rowMargin;

    precomputed.push({
      product_id: pid,
      product_name: row.product_name,
      item_code: row.item_code || null,
      category_id: row.category_id ? Number(row.category_id) : null,
      category_name: row.category_name || null,
      selling_price: sellingPrice,
      hpp,
      unit_margin: unitMargin,
      quantity_sold: qty,
      total_revenue: rev,
      total_cost: rowCost,
      total_margin: rowMargin,
      food_cost_percentage: fcPct,
    });
  }

  const N = precomputed.length;

  // Standar Menu Engineering:
  // 1. Popularity Hurdle Rate = (1 / N) * 70% (atau 70% dari rata-rata penjualan per item)
  const popularityHurdleRatePercentage =
    N > 0 ? Math.round((1 / N) * 70 * 100) / 100 : 0;
  const averageVolumePerItem = N > 0 ? Math.round((totalVolumeSold / N) * 100) / 100 : 0;

  // 2. Average Contribution Margin Benchmark (Weighted Average CM)
  const averageContributionMargin =
    totalVolumeSold > 0
      ? Math.round((totalContributionMargin / totalVolumeSold) * 100) / 100
      : 0;

  const overallFoodCostPercentage =
    totalRevenue > 0
      ? Math.round((totalCost / totalRevenue) * 10000) / 100
      : 0;

  // Klasifikasikan ke dalam 4 kuadran
  const stars: MenuEngineeringItem[] = [];
  const plowhorses: MenuEngineeringItem[] = [];
  const puzzles: MenuEngineeringItem[] = [];
  const dogs: MenuEngineeringItem[] = [];
  const allItems: MenuEngineeringItem[] = [];

  for (const item of precomputed) {
    const mmPct =
      totalVolumeSold > 0
        ? Math.round((item.quantity_sold / totalVolumeSold) * 10000) / 100
        : 0;

    const isHighPopularity = mmPct >= popularityHurdleRatePercentage;
    const isHighMargin = item.unit_margin >= averageContributionMargin;

    let quadrant: MenuEngineeringQuadrant;
    if (isHighPopularity && isHighMargin) {
      quadrant = 'STARS';
    } else if (isHighPopularity && !isHighMargin) {
      quadrant = 'PLOWHORSES';
    } else if (!isHighPopularity && isHighMargin) {
      quadrant = 'PUZZLES';
    } else {
      quadrant = 'DOGS';
    }

    const { label: quadrantLabel, recommendation } = getQuadrantRecommendation(quadrant);

    const classifiedItem: MenuEngineeringItem = {
      ...item,
      menu_mix_percentage: mmPct,
      is_high_popularity: isHighPopularity,
      is_high_margin: isHighMargin,
      quadrant,
      quadrant_label: quadrantLabel,
      recommendation,
    };

    allItems.push(classifiedItem);
    if (quadrant === 'STARS') stars.push(classifiedItem);
    else if (quadrant === 'PLOWHORSES') plowhorses.push(classifiedItem);
    else if (quadrant === 'PUZZLES') puzzles.push(classifiedItem);
    else dogs.push(classifiedItem);
  }

  return {
    period: {
      start_date: start,
      end_date: end,
    },
    benchmarks: {
      total_volume_sold: totalVolumeSold,
      total_revenue: Math.round(totalRevenue * 100) / 100,
      total_cost: Math.round(totalCost * 100) / 100,
      total_contribution_margin: Math.round(totalContributionMargin * 100) / 100,
      overall_food_cost_percentage: overallFoodCostPercentage,
      average_contribution_margin: averageContributionMargin,
      average_volume_per_item: averageVolumePerItem,
      popularity_hurdle_rate_percentage: popularityHurdleRatePercentage,
      distinct_item_count: N,
    },
    quadrants: {
      stars,
      plowhorses,
      puzzles,
      dogs,
    },
    items: allItems,
  };
}

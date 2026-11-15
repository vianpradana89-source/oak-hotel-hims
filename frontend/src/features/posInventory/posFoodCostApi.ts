/**
 * OAK HIMS — MP-04E Food Cost & Menu Engineering Frontend API Client & Types
 */

import { authenticatedFetch } from '../../lib/authenticatedFetch';

export type FoodCostClassification =
  | 'LOW_COST'
  | 'HEALTHY'
  | 'OVER_COST'
  | 'NO_RECIPE'
  | 'ZERO_COST';

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

export interface ProductFoodCostAnalysis {
  product_id: number;
  property_id: number;
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
  unit_margin: number;
  quantity_sold: number;
  total_revenue: number;
  total_cost: number;
  total_margin: number;
  menu_mix_percentage: number;
  food_cost_percentage: number;
  is_high_popularity: boolean;
  is_high_margin: boolean;
  quadrant: MenuEngineeringQuadrant;
  quadrant_label: string;
  recommendation: string;
}

export interface MenuEngineeringBenchmarks {
  total_volume_sold: number;
  total_revenue: number;
  total_cost: number;
  total_contribution_margin: number;
  overall_food_cost_percentage: number;
  average_contribution_margin: number;
  average_volume_per_item: number;
  popularity_hurdle_rate_percentage: number;
  distinct_item_count: number;
}

export interface MenuEngineeringReportResponse {
  period: {
    start_date: string;
    end_date: string;
  };
  benchmarks: MenuEngineeringBenchmarks;
  quadrants: {
    stars: MenuEngineeringItem[];
    plowhorses: MenuEngineeringItem[];
    puzzles: MenuEngineeringItem[];
    dogs: MenuEngineeringItem[];
  };
  items: MenuEngineeringItem[];
}

// ─────────────────────────────────────────────────────────────────────────────
// API Methods
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchProductFoodCostAnalysis(
  productId: number,
  propertyId: number = 1
): Promise<ProductFoodCostAnalysis> {
  const res = await authenticatedFetch(`/api/pos/products/${productId}/food-cost?property_id=${propertyId}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  const body = await res.json();
  if (!res.ok || body.status !== 'OK') {
    throw new Error(body.error || body.message || 'Gagal memuat analisis food cost produk');
  }
  return body.data;
}

export async function fetchFoodCostOverview(
  propertyId: number = 1,
  filters?: {
    categoryId?: number;
    status?: FoodCostClassification | 'ALL';
    search?: string;
  }
): Promise<FoodCostOverviewResponse> {
  const params = new URLSearchParams({ property_id: String(propertyId) });
  if (filters?.categoryId) params.set('category_id', String(filters.categoryId));
  if (filters?.status && filters.status !== 'ALL') params.set('status', filters.status);
  if (filters?.search) params.set('search', filters.search);

  const res = await authenticatedFetch(`/api/pos/reports/food-cost-overview?${params.toString()}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  const body = await res.json();
  if (!res.ok || body.status !== 'OK') {
    throw new Error(body.error || body.message || 'Gagal memuat ikhtisar food cost');
  }
  return body.data;
}

export async function fetchMenuEngineeringReport(
  propertyId: number = 1,
  filters?: {
    startDate?: string;
    endDate?: string;
    categoryId?: number;
  }
): Promise<MenuEngineeringReportResponse> {
  const params = new URLSearchParams({ property_id: String(propertyId) });
  if (filters?.startDate) params.set('start_date', filters.startDate);
  if (filters?.endDate) params.set('end_date', filters.endDate);
  if (filters?.categoryId) params.set('category_id', String(filters.categoryId));

  const res = await authenticatedFetch(`/api/pos/reports/menu-engineering?${params.toString()}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  const body = await res.json();
  if (!res.ok || body.status !== 'OK') {
    throw new Error(body.error || body.message || 'Gagal memuat laporan menu engineering');
  }
  return body.data;
}

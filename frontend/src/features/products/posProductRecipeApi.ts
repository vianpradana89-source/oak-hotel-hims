/**
 * API Client untuk Master Resep & Bill of Materials (BOM) Bahan Baku POS (MP-04C)
 * OAK Hotel Integrated Management System (HIMS)
 */

import { authenticatedFetch } from '../../lib/authenticatedFetch';

export interface PosProductUom {
  id: number;
  code: string;
  name: string;
  category: string;
}

export interface PosRecipeIngredient {
  id: number;
  product_id: number;
  ingredient_product_id: number;
  ingredient_name: string;
  ingredient_item_code: string | null;
  ingredient_base_unit: string | null;
  quantity: string;
  uom_id: number | null;
  uom_code: string | null;
  uom_name: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PosProductRecipeResponse {
  product_id: number;
  product_name: string;
  ingredients: PosRecipeIngredient[];
}

export interface SaveRecipeIngredientPayload {
  ingredient_product_id: number;
  quantity: number | string;
  uom_id?: number | null;
  notes?: string | null;
}

export interface RawMaterialCandidate {
  id: number;
  name: string;
  item_code: string | null;
  base_unit: string | null;
  canonical_base_unit_code: string | null;
  product_type: string | null;
  is_raw_material: boolean;
  track_stock: boolean;
}

/**
 * Mengambil daftar satuan ukur (UOM) kanonik
 */
export async function fetchPosProductUoms(): Promise<PosProductUom[]> {
  const res = await authenticatedFetch('/api/pos/uoms');
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.message || 'Gagal memuat daftar satuan ukur (UOM)');
  }
  const json = await res.json();
  return json.data || [];
}

/**
 * Mengambil daftar produk kandidat bahan baku (raw materials)
 */
export async function fetchRawMaterialCandidates(propertyId?: number): Promise<RawMaterialCandidate[]> {
  const query = propertyId ? `?property_id=${propertyId}` : '';
  const res = await authenticatedFetch(`/api/pos/raw-materials${query}`);
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.message || 'Gagal memuat daftar kandidat bahan baku');
  }
  const json = await res.json();
  return json.data || [];
}

/**
 * Mengambil daftar formula resep (BOM) untuk suatu produk
 */
export async function fetchProductRecipe(productId: number, propertyId?: number): Promise<PosProductRecipeResponse> {
  const query = propertyId ? `?property_id=${propertyId}` : '';
  const res = await authenticatedFetch(`/api/pos/products/${productId}/recipe${query}`);
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.message || 'Gagal memuat resep produk');
  }
  const json = await res.json();
  return json.data || { product_id: productId, product_name: '', ingredients: [] };
}

/**
 * Menyimpan / memperbarui komponen bahan baku pada resep produk
 */
export async function saveRecipeIngredient(
  productId: number,
  payload: SaveRecipeIngredientPayload,
  propertyId?: number
): Promise<PosRecipeIngredient> {
  const query = propertyId ? `?property_id=${propertyId}` : '';
  const res = await authenticatedFetch(`/api/pos/products/${productId}/recipe${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.message || 'Gagal menyimpan komponen resep');
  }
  const json = await res.json();
  return json.data;
}

/**
 * Menghapus komponen resep berdasarkan recipeId
 */
export async function deleteRecipeIngredient(recipeId: number, propertyId?: number): Promise<void> {
  const query = propertyId ? `?property_id=${propertyId}` : '';
  const res = await authenticatedFetch(`/api/pos/recipes/${recipeId}${query}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.message || 'Gagal menghapus komponen resep');
  }
}

/**
 * Master Produk — Tahap 1 Domain Helper
 *
 * Cakupan Tahap 1:
 * 1. Klasifikasi:
 *    - product_type: 'RAW_MATERIAL' (Bahan Baku) | 'SEMI_FINISHED' (Setengah Jadi) | 'FINISHED_GOOD' (Produk Jadi) | null (Belum diatur)
 *    - product_kind: 'STANDARD' (Biasa) | null (Belum diatur).
 *      Jenis operasional roadmap ('WEIGHED', 'UNLIMITED', 'SERVICE', 'BUNDLE', 'FORMULA') ditolak eksplisit pada Tahap 1.
 *    - base_unit: string metadata satuan dasar (1..50 karakter setelah trim) | null (Belum diatur).
 * 2. Visibilitas POS:
 *    - is_sellable_pos: boolean (default true untuk kompatibilitas mundur).
 * 3. Aturan Harga (price):
 *    - Produk jual (is_sellable_pos = true) wajib memiliki harga Rupiah utuh valid (>= 0).
 *    - Produk internal (is_sellable_pos = false) boleh memiliki price = null (tanpa harga jual) atau harga Rupiah utuh valid (>= 0).
 */

import crypto from 'node:crypto';

export {
  MAX_PRODUCT_PHOTO_BYTES,
  ALLOWED_PRODUCT_PHOTO_MIMES,
  isProductPhotoStorageKey,
  productPhotoMime,
  hasValidImageSignature,
  validateProductPhotoBuffer,
  saveProductPhoto,
  productPhotoExists,
  readProductPhoto,
  deleteProductPhoto,
  createProductPhotoUploadHandler,
  createProductPhotoDeleteHandler,
  createProductPhotoGetHandler,
} from './productPhotoStorage';

import {
  SYSTEM_CANONICAL_UNITS,
  CANONICAL_UNIT_CODES,
  UNIT_DIMENSIONS,
  STOCK_LOCATION_TYPES,
  getCanonicalUnitByCode,
  matchCanonicalUnitByText,
  isTextEquivalentToCanonicalUnit,
  milliToDecimalString,
  parseStrictDecimalString,
  parsePackagingFactorInput,
  parseCanonicalQuantityInput,
  convertPackagingToBaseQuantity,
  convertIntraDimensionQuantity,
  resolveCreateProductUnitInput,
  resolvePatchProductUnitMutation,
  checkProductBaseUnitLockStatus,
  formatPackagingConversionRow,
  fetchPropertyPackagingsByItem,
  createProductPackagingListHandler,
  createProductPackagingCreateHandler,
  createProductPackagingPatchHandler,
  createStockLocationRoomCandidatesHandler,
  createStockLocationListHandler,
  createStockLocationCreateHandler,
  createStockLocationPatchHandler,
  type CanonicalUnitDefinition,
  type UnitDimension,
  type FormattedPackagingConversion,
  type StockLocationType,
} from './productUnitsAndLocations';

export {
  SYSTEM_CANONICAL_UNITS,
  CANONICAL_UNIT_CODES,
  UNIT_DIMENSIONS,
  STOCK_LOCATION_TYPES,
  getCanonicalUnitByCode,
  matchCanonicalUnitByText,
  isTextEquivalentToCanonicalUnit,
  milliToDecimalString,
  parseStrictDecimalString,
  parsePackagingFactorInput,
  parseCanonicalQuantityInput,
  convertPackagingToBaseQuantity,
  convertIntraDimensionQuantity,
  resolveCreateProductUnitInput,
  resolvePatchProductUnitMutation,
  checkProductBaseUnitLockStatus,
  formatPackagingConversionRow,
  fetchPropertyPackagingsByItem,
  createProductPackagingListHandler,
  createProductPackagingCreateHandler,
  createProductPackagingPatchHandler,
  createStockLocationRoomCandidatesHandler,
  createStockLocationListHandler,
  createStockLocationCreateHandler,
  createStockLocationPatchHandler,
  type CanonicalUnitDefinition,
  type UnitDimension,
  type FormattedPackagingConversion,
  type StockLocationType,
};

export const PRODUCT_TYPES = ['RAW_MATERIAL', 'SEMI_FINISHED', 'FINISHED_GOOD', 'OPERATIONAL_ITEM'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const ACTIVE_PRODUCT_KINDS = ['STANDARD'] as const;
export type ActiveProductKind = (typeof ACTIVE_PRODUCT_KINDS)[number];

export const ROADMAP_PRODUCT_KINDS = ['WEIGHED', 'UNLIMITED', 'SERVICE', 'BUNDLE', 'FORMULA'] as const;
export type RoadmapProductKind = (typeof ROADMAP_PRODUCT_KINDS)[number];

export type ProductKind = ActiveProductKind | RoadmapProductKind;

export const PRODUCT_TYPE_LABELS: Record<ProductType, string> = {
  RAW_MATERIAL: 'Bahan Baku',
  SEMI_FINISHED: 'Setengah Jadi',
  FINISHED_GOOD: 'Produk Jadi',
  OPERATIONAL_ITEM: 'Item Operasional',
};

export const PRODUCT_KIND_LABELS: Record<ProductKind, string> = {
  STANDARD: 'Biasa',
  WEIGHED: 'Timbangan',
  UNLIMITED: 'Unlimited',
  SERVICE: 'Jasa',
  BUNDLE: 'Bundle',
  FORMULA: 'Formula',
};

export type ParsedFieldResult<T> =
  | { ok: true; provided: false; value: undefined }
  | { ok: true; provided: true; value: T }
  | { ok: false; code: string; message: string };

const PRODUCT_TYPE_ALIASES: Record<string, ProductType> = {
  RAW_MATERIAL: 'RAW_MATERIAL',
  'RAW MATERIAL': 'RAW_MATERIAL',
  BAHAN_BAKU: 'RAW_MATERIAL',
  'BAHAN BAKU': 'RAW_MATERIAL',
  SEMI_FINISHED: 'SEMI_FINISHED',
  'SEMI FINISHED': 'SEMI_FINISHED',
  SETENGAH_JADI: 'SEMI_FINISHED',
  'SETENGAH JADI': 'SEMI_FINISHED',
  FINISHED_GOOD: 'FINISHED_GOOD',
  'FINISHED GOOD': 'FINISHED_GOOD',
  PRODUK_JADI: 'FINISHED_GOOD',
  'PRODUK JADI': 'FINISHED_GOOD',
  OPERATIONAL_ITEM: 'OPERATIONAL_ITEM',
  'OPERATIONAL ITEM': 'OPERATIONAL_ITEM',
  ITEM_OPERASIONAL: 'OPERATIONAL_ITEM',
  'ITEM OPERASIONAL': 'OPERATIONAL_ITEM',
  BARANG_OPERASIONAL: 'OPERATIONAL_ITEM',
  'BARANG OPERASIONAL': 'OPERATIONAL_ITEM',
};

const ACTIVE_KIND_ALIASES: Record<string, ActiveProductKind> = {
  STANDARD: 'STANDARD',
  BIASA: 'STANDARD',
};

const ROADMAP_KIND_ALIASES: Record<string, RoadmapProductKind> = {
  WEIGHED: 'WEIGHED',
  TIMBANGAN: 'WEIGHED',
  UNLIMITED: 'UNLIMITED',
  SERVICE: 'SERVICE',
  JASA: 'SERVICE',
  BUNDLE: 'BUNDLE',
  FORMULA: 'FORMULA',
};

/**
 * Normalisasi input product_type pada POST/PATCH.
 * - undefined -> provided: false
 * - null atau '' -> provided: true, value: null (Belum diatur)
 * - kode kanonik atau label Indonesia -> provided: true, value: ProductType
 */
export function parseProductTypeInput(raw: unknown): ParsedFieldResult<ProductType | null> {
  if (raw === undefined) {
    return { ok: true, provided: false, value: undefined };
  }
  if (raw === null) {
    return { ok: true, provided: true, value: null };
  }
  if (typeof raw !== 'string') {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'product_type harus berupa string atau null (RAW_MATERIAL, SEMI_FINISHED, FINISHED_GOOD)',
    };
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: true, provided: true, value: null };
  }
  const normalizedKey = trimmed.toUpperCase().replace(/\s+/g, ' ');
  const mapped = PRODUCT_TYPE_ALIASES[normalizedKey];
  if (!mapped) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'product_type tidak valid. Gunakan Bahan Baku (RAW_MATERIAL), Setengah Jadi (SEMI_FINISHED), atau Produk Jadi (FINISHED_GOOD)',
    };
  }
  return { ok: true, provided: true, value: mapped };
}

/**
 * Normalisasi input product_kind pada POST/PATCH.
 * - undefined -> provided: false
 * - null atau '' -> provided: true, value: null (Belum diatur)
 * - 'STANDARD' / 'Biasa' -> provided: true, value: 'STANDARD'
 * - Jenis roadmap ('WEIGHED', 'UNLIMITED', 'SERVICE', 'BUNDLE', 'FORMULA') -> ditolak eksplisit pada Tahap 1
 */
export function parseProductKindInput(raw: unknown): ParsedFieldResult<ActiveProductKind | null> {
  if (raw === undefined) {
    return { ok: true, provided: false, value: undefined };
  }
  if (raw === null) {
    return { ok: true, provided: true, value: null };
  }
  if (typeof raw !== 'string') {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'product_kind harus berupa string atau null',
    };
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: true, provided: true, value: null };
  }
  const normalizedKey = trimmed.toUpperCase().replace(/\s+/g, ' ');
  const active = ACTIVE_KIND_ALIASES[normalizedKey];
  if (active) {
    return { ok: true, provided: true, value: active };
  }
  const roadmap = ROADMAP_KIND_ALIASES[normalizedKey];
  if (roadmap) {
    const label = PRODUCT_KIND_LABELS[roadmap];
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: `Jenis produk "${label}" (${roadmap}) masih dalam roadmap dan belum diaktifkan pada Tahap 1. Gunakan jenis "Biasa" (STANDARD).`,
    };
  }
  return {
    ok: false,
    code: 'VALIDATION_ERROR',
    message: 'product_kind tidak valid. Pada Tahap 1 hanya mendukung jenis "Biasa" (STANDARD).',
  };
}

/**
 * Normalisasi input base_unit pada POST/PATCH.
 * - undefined -> provided: false
 * - null atau '' -> provided: true, value: null (Belum diatur)
 * - string 1..50 karakter setelah trim -> provided: true, value: string
 */
export function parseBaseUnitInput(raw: unknown): ParsedFieldResult<string | null> {
  if (raw === undefined) {
    return { ok: true, provided: false, value: undefined };
  }
  if (raw === null) {
    return { ok: true, provided: true, value: null };
  }
  if (typeof raw !== 'string') {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'base_unit harus berupa teks satuan dasar (maksimal 50 karakter) atau null',
    };
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: true, provided: true, value: null };
  }
  if (trimmed.length > 50) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'base_unit maksimal 50 karakter',
    };
  }
  return { ok: true, provided: true, value: trimmed };
}

/**
 * Normalisasi input storage_sublocation (Tempat Penyimpanan) pada POST/PATCH.
 * Contoh: Showcase, Chiller, Freezer, Rak Kering, Lemari Linen.
 */
export function parseStorageSublocationInput(raw: unknown): ParsedFieldResult<string | null> {
  if (raw === undefined) {
    return { ok: true, provided: false, value: undefined };
  }
  if (raw === null) {
    return { ok: true, provided: true, value: null };
  }
  if (typeof raw !== 'string') {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'storage_sublocation harus berupa teks tempat penyimpanan (maksimal 100 karakter) atau null',
    };
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: true, provided: true, value: null };
  }
  if (trimmed.length > 100) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Tempat penyimpanan (storage_sublocation) maksimal 100 karakter',
    };
  }
  return { ok: true, provided: true, value: trimmed };
}

export interface ProductVariantItem {
  name: string;
  price: number;
  cost_price?: number | null;
  sku?: string | null;
  barcode?: string | null;
}

/**
 * Validasi dan normalisasi daftar varian untuk Produk Jadi (FINISHED_GOOD).
 */
export function parseVariantsInput(raw: unknown): ParsedFieldResult<ProductVariantItem[]> {
  if (raw === undefined) {
    return { ok: true, provided: false, value: undefined };
  }
  if (raw === null) {
    return { ok: true, provided: true, value: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'variants harus berupa array daftar varian produk',
    };
  }
  const result: ProductVariantItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (!v || typeof v !== 'object') {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: `Varian #${i + 1} tidak valid`,
      };
    }
    const rawName = typeof v.name === 'string' ? v.name.trim() : '';
    if (!rawName) {
      continue;
    }
    if (rawName.length > 100) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: `Nama varian #${i + 1} maksimal 100 karakter`,
      };
    }
    const rawPrice = v.price;
    const priceNum =
      rawPrice === null || rawPrice === undefined || rawPrice === '' ? 0 : Math.round(Number(rawPrice));
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: `Harga jual varian "${rawName}" harus berupa angka Rupiah >= 0`,
      };
    }
    let costPriceVal: number | null = null;
    if (v.cost_price !== undefined && v.cost_price !== null && String(v.cost_price).trim() !== '') {
      const cp = Math.round(Number(v.cost_price));
      if (Number.isFinite(cp) && cp >= 0) {
        costPriceVal = cp;
      }
    }
    const skuVal =
      typeof v.sku === 'string' && v.sku.trim() !== '' ? v.sku.trim().slice(0, 50).toUpperCase() : null;
    const barcodeVal =
      typeof v.barcode === 'string' && v.barcode.trim() !== '' ? v.barcode.trim().slice(0, 100) : null;

    result.push({
      name: rawName,
      price: priceNum,
      ...(costPriceVal !== null ? { cost_price: costPriceVal } : {}),
      ...(skuVal !== null ? { sku: skuVal } : {}),
      ...(barcodeVal !== null ? { barcode: barcodeVal } : {}),
    });
  }
  return { ok: true, provided: true, value: result };
}

/**
 * Normalisasi input barcode pada POST/PATCH (MP-02B).
 * - undefined -> provided: false, value: undefined
 * - null atau string kosong/whitespace -> provided: true, value: null
 * - string 1..100 karakter setelah trim -> provided: true, value: trimmed (mempertahankan nol awal & case)
 * - selain string/null/undefined (termasuk number) -> ditolak agar nol awal tidak hilang
 */
export function parseBarcodeInput(raw: unknown): ParsedFieldResult<string | null> {
  if (raw === undefined) {
    return { ok: true, provided: false, value: undefined };
  }
  if (raw === null) {
    return { ok: true, provided: true, value: null };
  }
  if (typeof raw !== 'string') {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'barcode harus berupa string (maksimal 100 karakter) atau null',
    };
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: true, provided: true, value: null };
  }
  if (trimmed.length > 100) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'barcode maksimal 100 karakter',
    };
  }
  return { ok: true, provided: true, value: trimmed };
}

/**
 * Validasi input is_sellable_pos pada POST/PATCH.
 * - undefined -> provided: false
 * - boolean -> provided: true, value: boolean
 * - selain boolean -> ditolak
 */
export function parseIsSellablePosInput(raw: unknown): ParsedFieldResult<boolean> {
  if (raw === undefined) {
    return { ok: true, provided: false, value: undefined };
  }
  if (typeof raw !== 'boolean') {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'is_sellable_pos harus berupa boolean (true atau false)',
    };
  }
  return { ok: true, provided: true, value: raw };
}

/**
 * Validasi input price (Rupiah utuh >= 0 atau null untuk produk internal).
 * Mempertahankan kompatibilitas caller lama:
 * - number integer >= 0 atau string numerik yang bernilai integer >= 0 diterima.
 * - string kosong ('', '   '), boolean, array, object, negatif, NaN, Infinity, atau pecahan ditolak.
 */
export function parsePriceInput(raw: unknown): ParsedFieldResult<number | null> {
  if (raw === undefined) {
    return { ok: true, provided: false, value: undefined };
  }
  if (raw === null) {
    return { ok: true, provided: true, value: null };
  }
  if (typeof raw === 'boolean' || (typeof raw !== 'number' && typeof raw !== 'string')) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Valid whole-rupiah price (>= 0) is required',
    };
  }
  if (typeof raw === 'string' && raw.trim() === '') {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Valid whole-rupiah price (>= 0) is required',
    };
  }
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0 || !Number.isSafeInteger(num)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Valid whole-rupiah price (>= 0) is required',
    };
  }
  return { ok: true, provided: true, value: num };
}

/**
 * Evaluasi kecocokan antara is_sellable_pos dan price efektif.
 * - Jika isSellablePos === true: price tidak boleh null, harus integer >= 0.
 * - Jika isSellablePos === false: price boleh null atau integer >= 0.
 */
export function validateEffectiveSellablePrice(
  isSellablePos: boolean,
  effectivePrice: number | null
): { ok: true; price: number | null } | { ok: false; code: string; message: string } {
  if (isSellablePos) {
    if (effectivePrice === null || effectivePrice === undefined) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'Valid whole-rupiah price (>= 0) is required for POS-sellable products',
      };
    }
    if (!Number.isFinite(effectivePrice) || effectivePrice < 0 || !Number.isSafeInteger(effectivePrice)) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'Valid whole-rupiah price (>= 0) is required',
      };
    }
    return { ok: true, price: effectivePrice };
  }

  if (effectivePrice === null || effectivePrice === undefined) {
    return { ok: true, price: null };
  }
  if (!Number.isFinite(effectivePrice) || effectivePrice < 0 || !Number.isSafeInteger(effectivePrice)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Valid whole-rupiah price (>= 0) is required when price is provided',
    };
  }
  return { ok: true, price: effectivePrice };
}

export type ProductTypeQueryFilter = 'ALL' | 'UNSET' | ProductType;

export function parseProductTypeQueryFilter(
  raw: unknown
): { ok: true; filter: ProductTypeQueryFilter } | { ok: false; code: string; message: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, filter: 'ALL' };
  }
  if (typeof raw !== 'string') {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Filter product_type tidak valid',
    };
  }
  const upper = raw.trim().toUpperCase();
  if (upper === 'ALL' || upper === 'SEMUA') {
    return { ok: true, filter: 'ALL' };
  }
  if (upper === 'UNSET' || upper === 'NULL' || upper === 'BELUM_DIATUR' || upper === 'BELUM DIATUR') {
    return { ok: true, filter: 'UNSET' };
  }
  const parsed = parseProductTypeInput(raw);
  if (!parsed.ok || !parsed.provided || parsed.value === null) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Filter product_type tidak valid. Gunakan ALL, UNSET, RAW_MATERIAL, SEMI_FINISHED, atau FINISHED_GOOD',
    };
  }
  return { ok: true, filter: parsed.value };
}

export function parseStockTrackingInput(
  body: Record<string, any> | null | undefined,
  options?: { productType?: ProductType | null }
):
  | { ok: true; provided: boolean; track_stock: boolean; track_inventory: boolean }
  | { ok: false; code: string; message: string } {
  const rawTrackStock = body?.track_stock;
  const rawTrackInventory = body?.track_inventory;
  const hasTrackStock = rawTrackStock !== undefined;
  const hasTrackInventory = rawTrackInventory !== undefined;

  if (hasTrackStock && typeof rawTrackStock !== 'boolean') {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'track_stock must be a boolean (true or false)',
    };
  }
  if (hasTrackInventory && typeof rawTrackInventory !== 'boolean') {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'track_inventory must be a boolean (true or false)',
    };
  }
  if (hasTrackStock && hasTrackInventory && rawTrackStock !== rawTrackInventory) {
    return {
      ok: false,
      code: 'CONFLICTING_STOCK_TRACKING_FLAGS',
      message:
        'track_stock dan track_inventory harus selaras (keduanya true untuk produk stok fisik/GRN, atau keduanya false untuk produk non-stok/resep/jasa)',
    };
  }
  if (hasTrackStock || hasTrackInventory) {
    const resolved = Boolean(hasTrackStock ? rawTrackStock : rawTrackInventory);
    return {
      ok: true,
      provided: true,
      track_stock: resolved,
      track_inventory: resolved,
    };
  }
  const defaultTracked =
    options?.productType === 'RAW_MATERIAL' ||
    options?.productType === 'SEMI_FINISHED' ||
    options?.productType === 'OPERATIONAL_ITEM';
  return {
    ok: true,
    provided: false,
    track_stock: defaultTracked,
    track_inventory: defaultTracked,
  };
}

/**
 * Format baris pos_menu_items dari database ke response JSON API.
 * Penting:
 * - price null dipertahankan sebagai null (tidak dikonversi menjadi 0).
 * - atribut klasifikasi/satuan yang null dipertahankan sebagai null (jangan menebak nilai default).
 */
export function formatPosMenuItemRow(row: Record<string, any>) {
  const { photo_storage_key, ...safeRow } = row;
  const rawPrice = safeRow.price;
  const formattedPrice =
    rawPrice === null || rawPrice === undefined ? null : Number(rawPrice);

  const productType: ProductType | null = safeRow.product_type ?? null;
  const productKind: ProductKind | null = safeRow.product_kind ?? null;
  const baseUnit: string | null = safeRow.base_unit ?? null;
  const barcode: string | null =
    safeRow.barcode === null || safeRow.barcode === undefined ? null : String(safeRow.barcode);
  const isSellablePos: boolean =
    typeof safeRow.is_sellable_pos === 'boolean' ? safeRow.is_sellable_pos : true;

  const hasPhoto = typeof photo_storage_key === 'string' && photo_storage_key.trim().length > 0;
  const versionToken = hasPhoto
    ? crypto.createHash('sha256').update(String(photo_storage_key)).digest('hex').slice(0, 8)
    : '';
  const photoUrl =
    hasPhoto && safeRow.id != null && safeRow.property_id != null
      ? `/api/pos/menu/items/${safeRow.id}/photo?property_id=${safeRow.property_id}&v=${versionToken}`
      : null;

  const canonicalCodeRaw =
    safeRow.canonical_base_unit_code === null || safeRow.canonical_base_unit_code === undefined
      ? null
      : String(safeRow.canonical_base_unit_code).trim().toUpperCase();
  const canonicalUnitDef = canonicalCodeRaw ? getCanonicalUnitByCode(canonicalCodeRaw) : null;
  const isBaseUnitLocked =
    typeof safeRow.is_base_unit_locked === 'boolean' ? safeRow.is_base_unit_locked : false;
  const packagingConversions = Array.isArray(safeRow.packaging_conversions)
    ? safeRow.packaging_conversions
    : [];
  const trackStock: boolean =
    typeof safeRow.track_stock === 'boolean' ? safeRow.track_stock : Boolean(safeRow.track_stock);
  const trackInventory: boolean =
    typeof safeRow.track_inventory === 'boolean'
      ? safeRow.track_inventory
      : Boolean(safeRow.track_inventory);

  return {
    ...safeRow,
    price: formattedPrice,
    is_sellable_pos: isSellablePos,
    product_type: productType,
    product_type_label: productType ? PRODUCT_TYPE_LABELS[productType] ?? 'Belum diatur' : 'Belum diatur',
    product_kind: productKind,
    product_kind_label: productKind ? PRODUCT_KIND_LABELS[productKind] ?? 'Belum diatur' : 'Belum diatur',
    base_unit: baseUnit,
    canonical_base_unit_code: canonicalUnitDef ? canonicalUnitDef.code : null,
    base_unit_dimension: canonicalUnitDef ? canonicalUnitDef.dimension : null,
    is_base_unit_locked: isBaseUnitLocked,
    packaging_conversions: packagingConversions,
    track_stock: trackStock,
    track_inventory: trackInventory,
    storage_sublocation:
      safeRow.storage_sublocation === null || safeRow.storage_sublocation === undefined || String(safeRow.storage_sublocation).trim() === ''
        ? null
        : String(safeRow.storage_sublocation).trim(),
    variants: Array.isArray(safeRow.variants)
      ? safeRow.variants
      : typeof safeRow.variants === 'string'
      ? (() => {
          try {
            const parsed = JSON.parse(safeRow.variants);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : [],
    barcode,
    has_photo: hasPhoto,
    photo_url: photoUrl,
  };
}

export interface PosMenuItemPatchDeps {
  pool: {
    query: (sql: string, params?: any[]) => Promise<any>;
    connect?: () => Promise<{
      query: (sql: string, params?: any[]) => Promise<any>;
      release: () => void;
    }>;
  };
  assertPropertyScope: (req: any, propertyId: number) => Promise<void>;
}

/**
 * Handler produksi untuk PATCH /api/pos/menu/items/:id.
 * Diekstrak agar dapat diuji langsung secara terisolasi maupun dipasang pada Express app.
 */
export function createPosMenuItemPatchHandler(deps: PosMenuItemPatchDeps) {
  return async (req: any, res: any) => {
    try {
      const itemId = Number(req.params?.id);
      if (!Number.isInteger(itemId) || itemId <= 0) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid item id' });
      }
      const propertyIdRaw = req.query?.property_id || req.body?.property_id;
      if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
      }
      const propertyId = Number(propertyIdRaw);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
      }
      await deps.assertPropertyScope(req, propertyId);

      const body = req.body || {};
      if (Object.prototype.hasOwnProperty.call(body, 'photo_storage_key') && body.photo_storage_key !== undefined) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'photo_storage_key dikelola oleh server melalui endpoint foto produk',
        });
      }
      // Build dynamic SET clause for only the fields present.
      const setClauses: string[] = [];
      const params: any[] = [];

      if (body.name !== undefined) {
        // name wajib string (bukan object/array/boolean/null) nonkosong.
        if (typeof body.name !== 'string') {
          return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'name must be a non-empty string' });
        }
        const nameStr = body.name.trim();
        if (!nameStr) {
          return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'name must be a non-empty string' });
        }
        if (nameStr.length > 100) {
          return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'name must be at most 100 characters' });
        }
        params.push(nameStr);
        setClauses.push(`name = $${params.length}`);
      }
      if (body.item_code !== undefined) {
        // item_code hanya string atau null; whitespace-only dinormalisasi null.
        if (body.item_code !== null && typeof body.item_code !== 'string') {
          return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'item_code must be a string or null' });
        }
        let codeStr: string | null;
        if (body.item_code === null) {
          codeStr = null;
        } else {
          const t = body.item_code.trim();
          codeStr = t === '' ? null : t.toUpperCase();
          if (codeStr !== null && codeStr.length > 50) {
            return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'item_code must be at most 50 characters' });
          }
        }
        params.push(codeStr);
        setClauses.push(`item_code = $${params.length}`);
      }
      if (body.description !== undefined) {
        // description hanya string atau null.
        if (body.description !== null && typeof body.description !== 'string') {
          return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'description must be a string or null' });
        }
        if (body.description === null) {
          params.push(null);
        } else {
          const t = body.description.trim();
          params.push(t === '' ? null : t);
        }
        setClauses.push(`description = $${params.length}`);
      }
      let parsedPatchSellable: { provided: boolean; value: boolean } | null = null;
      if (body.is_sellable_pos !== undefined) {
        const sp = parseIsSellablePosInput(body.is_sellable_pos);
        if (!sp.ok) {
          return res.status(400).json({ status: 'ERROR', code: sp.code, message: sp.message });
        }
        parsedPatchSellable = { provided: true, value: Boolean(sp.value) };
      }

      let parsedPatchPrice: { provided: boolean; value: number | null } | null = null;
      if (body.price !== undefined) {
        const pr = parsePriceInput(body.price);
        if (!pr.ok) {
          return res.status(400).json({ status: 'ERROR', code: pr.code, message: pr.message });
        }
        parsedPatchPrice = { provided: true, value: pr.value ?? null };
      }

      if (parsedPatchSellable && parsedPatchPrice) {
        const comboCheck = validateEffectiveSellablePrice(parsedPatchSellable.value, parsedPatchPrice.value);
        if (!comboCheck.ok) {
          return res.status(400).json({ status: 'ERROR', code: comboCheck.code, message: comboCheck.message });
        }
      } else if (parsedPatchPrice && parsedPatchPrice.value === null) {
        // Mengosongkan harga (price = null) tanpa mengirim is_sellable_pos:
        // hanya diizinkan bila item di DB berstatus produk internal (is_sellable_pos = false).
        const existingCheck = await deps.pool.query(
          'SELECT is_sellable_pos FROM pos_menu_items WHERE id = $1 AND property_id = $2',
          [itemId, propertyId]
        );
        if ((existingCheck.rowCount ?? 0) === 0 || existingCheck.rows[0].is_sellable_pos !== false) {
          return res.status(400).json({
            status: 'ERROR',
            code: 'VALIDATION_ERROR',
            message: 'price is required when is_sellable_pos is true (must be an integer >= 0)'
          });
        }
      } else if (parsedPatchSellable && parsedPatchSellable.value === true && !parsedPatchPrice) {
        // Mengaktifkan Dijual di POS tanpa mengirim harga baru:
        // validasi harga existing dengan aturan Rupiah utuh yang sama seperti helper domain
        // (non-null, finite, nonnegatif, Number.isSafeInteger) tanpa membulatkan/mengubahnya otomatis.
        const existingCheck = await deps.pool.query(
          'SELECT price FROM pos_menu_items WHERE id = $1 AND property_id = $2',
          [itemId, propertyId]
        );
        if ((existingCheck.rowCount ?? 0) > 0) {
          const curPrice = existingCheck.rows[0].price;
          const parsedExistingPrice = parsePriceInput(curPrice);
          const existingPriceVal =
            parsedExistingPrice.ok && parsedExistingPrice.provided ? parsedExistingPrice.value : null;
          const existingPriceCheck = validateEffectiveSellablePrice(true, existingPriceVal);
          if (
            curPrice === null ||
            curPrice === undefined ||
            !parsedExistingPrice.ok ||
            !existingPriceCheck.ok ||
            existingPriceVal === null ||
            !Number.isFinite(existingPriceVal) ||
            existingPriceVal < 0 ||
            !Number.isSafeInteger(existingPriceVal)
          ) {
            return res.status(400).json({
              status: 'ERROR',
              code: 'VALIDATION_ERROR',
              message: 'price is required when enabling is_sellable_pos (item currently has no valid whole-rupiah selling price)'
            });
          }
        }
      }

      if (parsedPatchPrice) {
        params.push(parsedPatchPrice.value);
        setClauses.push(`price = $${params.length}`);
      }
      if (parsedPatchSellable) {
        params.push(parsedPatchSellable.value);
        setClauses.push(`is_sellable_pos = $${params.length}`);
      }
      if (body.product_type !== undefined) {
        const pt = parseProductTypeInput(body.product_type);
        if (!pt.ok) {
          return res.status(400).json({ status: 'ERROR', code: pt.code, message: pt.message });
        }
        params.push(pt.value);
        setClauses.push(`product_type = $${params.length}`);
      }
      if (body.product_kind !== undefined) {
        const pk = parseProductKindInput(body.product_kind);
        if (!pk.ok) {
          return res.status(400).json({ status: 'ERROR', code: pk.code, message: pk.message });
        }
        params.push(pk.value);
        setClauses.push(`product_kind = $${params.length}`);
      }
      const hasCanonicalUnitField =
        Object.prototype.hasOwnProperty.call(body, 'canonical_base_unit_code') &&
        body.canonical_base_unit_code !== undefined;
      const hasLegacyBaseUnitField =
        Object.prototype.hasOwnProperty.call(body, 'base_unit') && body.base_unit !== undefined;
      const hasAnyUnitField = hasCanonicalUnitField || hasLegacyBaseUnitField;

      if (hasAnyUnitField) {
        const preUnitCheck = resolvePatchProductUnitMutation({
          existingBaseUnit: null,
          existingCanonicalCode: null,
          body,
        });
        if (!preUnitCheck.ok) {
          return res.status(preUnitCheck.status).json({
            status: 'ERROR',
            code: preUnitCheck.code,
            message: preUnitCheck.error,
          });
        }
        if (typeof deps.pool.connect !== 'function') {
          if (hasCanonicalUnitField) {
            params.push(preUnitCheck.base_unit);
            setClauses.push(`base_unit = $${params.length}`);
            params.push(preUnitCheck.canonical_base_unit_code);
            setClauses.push(`canonical_base_unit_code = $${params.length}`);
          } else if (hasLegacyBaseUnitField) {
            const bu = parseBaseUnitInput(body.base_unit);
            if (!bu.ok) {
              return res.status(400).json({ status: 'ERROR', code: bu.code, message: bu.message });
            }
            params.push(bu.value);
            setClauses.push(`base_unit = $${params.length}`);
          }
        }
      }
      let parsedPatchBarcode: { provided: boolean; value: string | null } | null = null;
      if (body.barcode !== undefined) {
        const bc = parseBarcodeInput(body.barcode);
        if (!bc.ok) {
          return res.status(400).json({ status: 'ERROR', code: bc.code, message: bc.message });
        }
        parsedPatchBarcode = { provided: true, value: bc.value ?? null };
        params.push(parsedPatchBarcode.value);
        setClauses.push(`barcode = $${params.length}`);
      }
      if (body.category_id !== undefined) {
        // category_id hanya integer positif atau null (bukan string/objek).
        if (body.category_id !== null) {
          const cid = Number(body.category_id);
          if (typeof body.category_id === 'string' && body.category_id.trim() === '') {
            return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'category_id must be a positive integer or null' });
          }
          if (!Number.isInteger(cid) || cid <= 0) {
            return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'category_id must be a positive integer or null' });
          }
          // Verifikasi kategori milik properti yang sama (sebelum mutasi).
          const catCheck = await deps.pool.query(
            'SELECT id FROM pos_menu_categories WHERE id = $1 AND property_id = $2',
            [cid, propertyId]
          );
          if ((catCheck.rowCount ?? 0) === 0) {
            return res.status(400).json({ status: 'ERROR', code: 'CATEGORY_NOT_FOUND', message: 'category does not exist for this property' });
          }
          params.push(cid);
        } else {
          params.push(null);
        }
        setClauses.push(`category_id = $${params.length}`);
      }
      if (body.is_active !== undefined) {
        if (typeof body.is_active !== 'boolean') {
          return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'is_active must be a boolean' });
        }
        params.push(body.is_active);
        setClauses.push(`is_active = $${params.length}`);
      }

      const parsedPatchTracking = parseStockTrackingInput(body);
      if (!parsedPatchTracking.ok) {
        return res.status(400).json({
          status: 'ERROR',
          code: parsedPatchTracking.code,
          message: parsedPatchTracking.message,
        });
      }
      if (parsedPatchTracking.provided) {
        params.push(parsedPatchTracking.track_stock);
        setClauses.push(`track_stock = $${params.length}`);
        params.push(parsedPatchTracking.track_inventory);
        setClauses.push(`track_inventory = $${params.length}`);
      }

      let parsedPatchStorageSublocation: { provided: boolean; value: string | null } | null = null;
      if (body.storage_sublocation !== undefined) {
        const ss = parseStorageSublocationInput(body.storage_sublocation);
        if (!ss.ok) {
          return res.status(400).json({ status: 'ERROR', code: ss.code, message: ss.message });
        }
        parsedPatchStorageSublocation = { provided: true, value: ss.value ?? null };
        params.push(parsedPatchStorageSublocation.value);
        setClauses.push(`storage_sublocation = $${params.length}`);
      }

      if (body.variants !== undefined) {
        const pv = parseVariantsInput(body.variants);
        if (!pv.ok) {
          return res.status(400).json({ status: 'ERROR', code: pv.code, message: pv.message });
        }
        params.push(JSON.stringify(pv.value ?? []));
        setClauses.push(`variants = $${params.length}::jsonb`);
      }

      if (setClauses.length === 0 && !hasAnyUnitField) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'no valid fields to update' });
      }

      // Item code duplicate check: jika item_code diset, pastikan tidak ada item lain
      // di properti yang sama dengan kode yang sama. Ditangani melalui 23505 di bawah
      // ATAU pre-check (untuk pesan eksplisit).
      if (body.item_code !== undefined && body.item_code !== null && String(body.item_code).trim()) {
        const dupCheck = await deps.pool.query(
          'SELECT id FROM pos_menu_items WHERE property_id = $1 AND item_code = $2 AND id != $3',
          [propertyId, String(body.item_code).trim().toUpperCase(), itemId]
        );
        if ((dupCheck.rowCount ?? 0) > 0) {
          return res.status(409).json({ status: 'ERROR', code: 'ITEM_CODE_DUPLICATE', message: 'item code already exists for this property' });
        }
      }

      if (parsedPatchBarcode && parsedPatchBarcode.value !== null) {
        const barcodeDupCheck = await deps.pool.query(
          'SELECT id FROM pos_menu_items WHERE property_id = $1 AND barcode = $2 AND id != $3',
          [propertyId, parsedPatchBarcode.value, itemId]
        );
        if ((barcodeDupCheck.rowCount ?? 0) > 0) {
          return res.status(409).json({ status: 'ERROR', code: 'BARCODE_DUPLICATE', message: 'barcode already exists for this property' });
        }
      }

      if (hasAnyUnitField && typeof deps.pool.connect === 'function') {
        const client = await deps.pool.connect();
        try {
          await client.query('BEGIN');
          const itemLockRes = await client.query(
            'SELECT * FROM pos_menu_items WHERE id = $1 AND property_id = $2 FOR UPDATE',
            [itemId, propertyId]
          );
          if ((itemLockRes.rowCount ?? 0) === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
              status: 'ERROR',
              code: 'NOT_FOUND',
              message: `menu item ${itemId} not found for property ${propertyId}`,
            });
          }
          const lockedRow = itemLockRes.rows[0];
          const unitMutation = resolvePatchProductUnitMutation({
            existingBaseUnit: lockedRow.base_unit ?? null,
            existingCanonicalCode: lockedRow.canonical_base_unit_code ?? null,
            body,
          });
          if (!unitMutation.ok) {
            await client.query('ROLLBACK');
            return res.status(unitMutation.status).json({
              status: 'ERROR',
              code: unitMutation.code,
              message: unitMutation.error,
            });
          }
          const lockCheck = await checkProductBaseUnitLockStatus(client, propertyId, itemId, {
            forMutation: unitMutation.isUnitChanging,
          });
          if (unitMutation.isUnitChanging && lockCheck.isLocked) {
            await client.query('ROLLBACK');
            const errCode = lockCheck.lockCode || (lockCheck.hasStockMovements ? 'BASE_UNIT_LOCKED_BY_STOCK' : 'BASE_UNIT_LOCKED_BY_USAGE');
            const message = lockCheck.hasStockMovements
              ? 'Satuan dasar tidak dapat diubah karena produk sudah memiliki mutasi stok'
              : 'Satuan dasar tidak dapat diubah karena produk sudah memiliki kemasan aktif atau penggunaan stok';
            return res.status(409).json({
              status: 'ERROR',
              code: errCode,
              message,
            });
          }

          params.push(unitMutation.base_unit);
          setClauses.push(`base_unit = $${params.length}`);
          params.push(unitMutation.canonical_base_unit_code);
          setClauses.push(`canonical_base_unit_code = $${params.length}`);

          if (setClauses.length === 0) {
            await client.query('COMMIT');
            return res.json({
              status: 'OK',
              data: formatPosMenuItemRow({
                ...lockedRow,
                is_base_unit_locked: lockCheck.isLocked,
              }),
            });
          }

          params.push(itemId, propertyId);
          const result = await client.query(
            `UPDATE pos_menu_items SET ${setClauses.join(', ')} WHERE id = $${params.length - 1} AND property_id = $${params.length} RETURNING *`,
            params
          );
          if ((result.rowCount ?? 0) === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
              status: 'ERROR',
              code: 'NOT_FOUND',
              message: `menu item ${itemId} not found for property ${propertyId}`,
            });
          }
          if (parsedPatchStorageSublocation) {
            await client
              .query(
                'UPDATE stock_balances SET storage_sublocation = $1 WHERE property_id = $2 AND product_id = $3',
                [parsedPatchStorageSublocation.value, propertyId, itemId]
              )
              .catch(() => {});
          }
          await client.query('COMMIT');
          const updatedRow = {
            ...result.rows[0],
            is_base_unit_locked: lockCheck.isLocked,
          };
          return res.json({ status: 'OK', data: formatPosMenuItemRow(updatedRow) });
        } catch (txErr: any) {
          try { await client.query('ROLLBACK'); } catch { /* ignore */ }
          if (txErr.code === '23505' && txErr.constraint === 'uq_pmi_property_code') {
            return res.status(409).json({ status: 'ERROR', code: 'ITEM_CODE_DUPLICATE', message: 'item code already exists for this property' });
          }
          if (txErr.code === '23505' && txErr.constraint === 'uq_pmi_property_barcode') {
            return res.status(409).json({ status: 'ERROR', code: 'BARCODE_DUPLICATE', message: 'barcode already exists for this property' });
          }
          throw txErr;
        } finally {
          client.release();
        }
      }

      params.push(itemId, propertyId);
      try {
        const result = await deps.pool.query(
          `UPDATE pos_menu_items SET ${setClauses.join(', ')} WHERE id = $${params.length - 1} AND property_id = $${params.length} RETURNING *`,
          params
        );
        if ((result.rowCount ?? 0) === 0) {
          return res.status(404).json({ status: 'ERROR', code: 'NOT_FOUND', message: `menu item ${itemId} not found for property ${propertyId}` });
        }
        if (parsedPatchStorageSublocation) {
          await deps.pool
            .query(
              'UPDATE stock_balances SET storage_sublocation = $1 WHERE property_id = $2 AND product_id = $3',
              [parsedPatchStorageSublocation.value, propertyId, itemId]
            )
            .catch(() => {});
        }
        res.json({ status: 'OK', data: formatPosMenuItemRow(result.rows[0]) });
      } catch (updateErr: any) {
        // Tangani concurrent code duplication via unique index (uq_pmi_property_code / uq_pmi_property_barcode).
        // HANYA jika 23505 dan constraint yang benar — bukan semua 23505 generik.
        if (updateErr.code === '23505' && updateErr.constraint === 'uq_pmi_property_code') {
          return res.status(409).json({ status: 'ERROR', code: 'ITEM_CODE_DUPLICATE', message: 'item code already exists for this property' });
        }
        if (updateErr.code === '23505' && updateErr.constraint === 'uq_pmi_property_barcode') {
          return res.status(409).json({ status: 'ERROR', code: 'BARCODE_DUPLICATE', message: 'barcode already exists for this property' });
        }
        throw updateErr;
      }
    } catch (err: any) {
      const statusCode = err.statusCode || 500;
      res.status(statusCode).json({
        status: 'ERROR',
        code: err.code || 'INTERNAL_ERROR',
        message: statusCode === 500 ? 'Internal server error' : err.message
      });
    }
  };
}

export interface PosMenuItemCreateDeps {
  pool: {
    query?: (sql: string, params?: any[]) => Promise<any>;
    connect: () => Promise<{
      query: (sql: string, params?: any[]) => Promise<any>;
      release: () => void;
    }>;
  };
  assertPropertyScope: (req: any, propertyId: number) => Promise<void>;
}

/**
 * Handler produksi untuk POST /api/pos/menu/items.
 * Diekstrak agar dapat diuji langsung maupun dipasang pada Express app.
 */
export function createPosMenuItemCreateHandler(deps: PosMenuItemCreateDeps) {
  return async (req: any, res: any) => {
    try {
      const body = req.body || {};
      if (Object.prototype.hasOwnProperty.call(body, 'photo_storage_key') && body.photo_storage_key !== undefined) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'photo_storage_key dikelola oleh server melalui endpoint foto produk',
        });
      }

      const {
        property_id,
        name,
        item_code,
        category_name,
        category_id,
        price,
        description,
        is_active,
        is_sellable_pos,
        product_type,
        product_kind,
        base_unit,
        barcode,
      } = body;

      if (!property_id) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
      }
      const propId = Number(property_id);
      if (!Number.isInteger(propId) || propId <= 0) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
      }

      const parsedSellable = parseIsSellablePosInput(is_sellable_pos);
      if (!parsedSellable.ok) {
        return res.status(400).json({ status: 'ERROR', code: parsedSellable.code, message: parsedSellable.message });
      }
      const effectiveSellablePos = parsedSellable.provided ? parsedSellable.value : true;

      const parsedVariants = parseVariantsInput(body.variants);
      if (!parsedVariants.ok) {
        return res.status(400).json({
          status: 'ERROR',
          code: parsedVariants.code,
          message: parsedVariants.message,
        });
      }
      const variantsVal: ProductVariantItem[] = parsedVariants.provided ? parsedVariants.value : [];

      const effectiveRawPrice =
        (price === undefined || price === null) && effectiveSellablePos && variantsVal.length > 0
          ? variantsVal[0].price
          : price;

      if (effectiveSellablePos && effectiveRawPrice === undefined) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id and price are required' });
      }

      if (typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'name must be a non-empty string' });
      }
      const propName = name.trim();
      if (propName.length > 100) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'name must be at most 100 characters' });
      }

      let code: string | null;
      if (item_code === undefined) {
        code = `PRD-${Date.now().toString().slice(-4)}`;
      } else if (item_code === null) {
        code = null;
      } else if (typeof item_code === 'string') {
        const trimmed = item_code.trim();
        code = trimmed === '' ? null : trimmed.toUpperCase();
        if (code !== null && code.length > 50) {
          return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'item_code must be at most 50 characters' });
        }
      } else {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'item_code must be a string or null' });
      }

      let desc: string | null;
      if (description === undefined || description === null) {
        desc = null;
      } else if (typeof description === 'string') {
        const t = description.trim();
        desc = t === '' ? null : t;
      } else {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'description must be a string or null' });
      }

      const parsedPrice = parsePriceInput(effectiveRawPrice);
      if (!parsedPrice.ok) {
        return res.status(400).json({ status: 'ERROR', code: parsedPrice.code, message: parsedPrice.message });
      }
      const rawEffectivePrice = parsedPrice.provided ? parsedPrice.value : null;
      const priceCheck = validateEffectiveSellablePrice(effectiveSellablePos, rawEffectivePrice);
      if (!priceCheck.ok) {
        return res.status(400).json({ status: 'ERROR', code: priceCheck.code, message: priceCheck.message });
      }
      const priceVal = priceCheck.price;

      const parsedProductType = parseProductTypeInput(product_type);
      if (!parsedProductType.ok) {
        return res.status(400).json({ status: 'ERROR', code: parsedProductType.code, message: parsedProductType.message });
      }
      const productTypeVal = parsedProductType.provided ? parsedProductType.value : null;

      const parsedProductKind = parseProductKindInput(product_kind);
      if (!parsedProductKind.ok) {
        return res.status(400).json({ status: 'ERROR', code: parsedProductKind.code, message: parsedProductKind.message });
      }
      const productKindVal = parsedProductKind.provided ? parsedProductKind.value : null;

      const resolvedUnit = resolveCreateProductUnitInput(body);
      if (!resolvedUnit.ok) {
        return res.status(resolvedUnit.status).json({ status: 'ERROR', code: resolvedUnit.code, message: resolvedUnit.error });
      }
      const baseUnitVal = resolvedUnit.base_unit;
      const canonicalBaseUnitVal = resolvedUnit.canonical_base_unit_code;

      // Barcode: opsional, pertahankan nol awal, jangan isi otomatis dari SKU/item_code.
      const parsedBarcode = parseBarcodeInput(barcode);
      if (!parsedBarcode.ok) {
        return res.status(400).json({ status: 'ERROR', code: parsedBarcode.code, message: parsedBarcode.message });
      }
      const barcodeVal = parsedBarcode.provided ? parsedBarcode.value : null;

      const parsedStorageSublocation = parseStorageSublocationInput(body.storage_sublocation);
      if (!parsedStorageSublocation.ok) {
        return res.status(400).json({
          status: 'ERROR',
          code: parsedStorageSublocation.code,
          message: parsedStorageSublocation.message,
        });
      }
      const storageSublocationVal = parsedStorageSublocation.provided ? parsedStorageSublocation.value : null;

      let isActiveVal = true;
      if (is_active !== undefined) {
        if (typeof is_active !== 'boolean') {
          return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'is_active must be a boolean' });
        }
        isActiveVal = is_active;
      }

      const parsedTracking = parseStockTrackingInput(body, { productType: productTypeVal });
      if (!parsedTracking.ok) {
        return res.status(400).json({
          status: 'ERROR',
          code: parsedTracking.code,
          message: parsedTracking.message,
        });
      }
      const trackStockVal = parsedTracking.track_stock;
      const trackInventoryVal = parsedTracking.track_inventory;

      let resolvedCategoryId: number | null = null;
      if (category_id !== undefined) {
        if (category_id === null) {
          resolvedCategoryId = null;
        } else {
          const cid = Number(category_id);
          if (!Number.isInteger(cid) || cid <= 0) {
            return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'category_id must be a positive integer or null' });
          }
          resolvedCategoryId = cid;
        }
      }

      let categoryNameArg: string | null = null;
      if (category_name !== undefined) {
        if (category_name === null) {
          categoryNameArg = null;
        } else if (typeof category_name === 'string') {
          const t = category_name.trim();
          categoryNameArg = t === '' ? null : t;
          if (categoryNameArg !== null && categoryNameArg.length > 100) {
            return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'category_name must be at most 100 characters' });
          }
        } else {
          return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'category_name must be a string or null' });
        }
      }

      await deps.assertPropertyScope(req, propId);

      const client = await deps.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM properties WHERE id = $1 FOR UPDATE', [propId]);
        let finalCategoryId: number | null;
        let finalCategoryName: string | null = null;

        if (category_id !== undefined) {
          finalCategoryId = resolvedCategoryId;
          if (finalCategoryId !== null) {
            const catCheck = await client.query(
              'SELECT id, name FROM pos_menu_categories WHERE id = $1 AND property_id = $2 FOR UPDATE',
              [finalCategoryId, propId]
            );
            if ((catCheck.rowCount ?? 0) === 0) {
              await client.query('ROLLBACK');
              return res.status(400).json({ status: 'ERROR', code: 'CATEGORY_NOT_FOUND', message: 'category does not exist for this property' });
            }
            finalCategoryName = catCheck.rows[0].name;
          }
        } else if (categoryNameArg !== null) {
          finalCategoryId = null;
          const findCat = await client.query(
            'SELECT id FROM pos_menu_categories WHERE property_id = $1 AND LOWER(name) = LOWER($2) FOR UPDATE',
            [propId, categoryNameArg]
          );
          if ((findCat.rowCount ?? 0) > 0) {
            finalCategoryId = findCat.rows[0].id;
            finalCategoryName = categoryNameArg;
          } else {
            const recheck = await client.query(
              'SELECT id FROM pos_menu_categories WHERE property_id = $1 AND LOWER(name) = LOWER($2)',
              [propId, categoryNameArg]
            );
            if ((recheck.rowCount ?? 0) > 0) {
              finalCategoryId = recheck.rows[0].id;
            } else {
              const newCat = await client.query(
                'INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, $2) RETURNING id',
                [propId, categoryNameArg]
              );
              finalCategoryId = newCat.rows[0].id;
            }
            finalCategoryName = categoryNameArg;
          }
        } else {
          finalCategoryId = null;
        }

        if (barcodeVal !== null) {
          const barcodeDup = await client.query(
            'SELECT id FROM pos_menu_items WHERE property_id = $1 AND barcode = $2',
            [propId, barcodeVal]
          );
          if ((barcodeDup.rowCount ?? 0) > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              status: 'ERROR',
              code: 'BARCODE_DUPLICATE',
              message: 'barcode already exists for this property',
            });
          }
        }

        const insertRes =
          canonicalBaseUnitVal !== null
            ? await client.query(
                `INSERT INTO pos_menu_items (
                   property_id, category_id, item_code, name, description,
                   price, is_active, is_sellable_pos, product_type, product_kind, base_unit, barcode,
                   canonical_base_unit_code, track_stock, track_inventory
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                 RETURNING *`,
                [
                  propId,
                  finalCategoryId,
                  code,
                  propName,
                  desc,
                  priceVal,
                  isActiveVal,
                  effectiveSellablePos,
                  productTypeVal,
                  productKindVal,
                  baseUnitVal,
                  barcodeVal,
                  canonicalBaseUnitVal,
                  trackStockVal,
                  trackInventoryVal,
                ]
              )
            : parsedTracking.provided || trackStockVal
            ? await client.query(
                `INSERT INTO pos_menu_items (
                   property_id, category_id, item_code, name, description,
                   price, is_active, is_sellable_pos, product_type, product_kind, base_unit, barcode,
                   track_stock, track_inventory
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                 RETURNING *`,
                [
                  propId,
                  finalCategoryId,
                  code,
                  propName,
                  desc,
                  priceVal,
                  isActiveVal,
                  effectiveSellablePos,
                  productTypeVal,
                  productKindVal,
                  baseUnitVal,
                  barcodeVal,
                  trackStockVal,
                  trackInventoryVal,
                ]
              )
            : await client.query(
                `INSERT INTO pos_menu_items (
                   property_id, category_id, item_code, name, description,
                   price, is_active, is_sellable_pos, product_type, product_kind, base_unit, barcode
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                 RETURNING *`,
                [
                  propId,
                  finalCategoryId,
                  code,
                  propName,
                  desc,
                  priceVal,
                  isActiveVal,
                  effectiveSellablePos,
                  productTypeVal,
                  productKindVal,
                  baseUnitVal,
                  barcodeVal,
                ]
              );
        let row = insertRes.rows[0];
        if ( (storageSublocationVal !== null || variantsVal.length > 0) && row?.id) {
          const subRes = await client
            .query(
              `UPDATE pos_menu_items
                  SET storage_sublocation = COALESCE($1, storage_sublocation),
                      variants = $2::jsonb
                WHERE id = $3 AND property_id = $4
                RETURNING *`,
              [storageSublocationVal, JSON.stringify(variantsVal), row.id, propId]
            )
            .catch(() => ({ rowCount: 0, rows: [] as any[] }));
          if ((subRes.rowCount ?? 0) > 0) {
            row = subRes.rows[0];
          } else {
            row = { ...row, storage_sublocation: storageSublocationVal, variants: variantsVal };
          }
        }
        if (finalCategoryId !== null && productTypeVal !== null) {
          await client
            .query(
              `UPDATE pos_menu_categories SET product_type = $1 WHERE id = $2 AND property_id = $3 AND product_type IS NULL`,
              [productTypeVal, finalCategoryId, propId]
            )
            .catch(() => {});
        }
        await client.query('COMMIT');
        res.status(201).json({
          status: 'OK',
          data: formatPosMenuItemRow({
            canonical_base_unit_code: canonicalBaseUnitVal,
            track_stock: trackStockVal,
            track_inventory: trackInventoryVal,
            storage_sublocation: storageSublocationVal,
            variants: variantsVal,
            ...row,
            category_name: finalCategoryName,
          }),
        });
        return;
      } catch (err: any) {
        try { await client.query('ROLLBACK'); } catch { /* already aborted */ }
        if (err.code === '23505' && err.constraint === 'uq_pmi_property_code') {
          return res.status(409).json({ status: 'ERROR', code: 'ITEM_CODE_DUPLICATE', message: 'item code already exists for this property' });
        }
        if (err.code === '23505' && err.constraint === 'uq_pmi_property_barcode') {
          return res.status(409).json({ status: 'ERROR', code: 'BARCODE_DUPLICATE', message: 'barcode already exists for this property' });
        }
        throw err;
      } finally {
        client.release();
      }
    } catch (err: any) {
      const statusCode = err.statusCode || 500;
      res.status(statusCode).json({
        status: 'ERROR',
        code: err.code || 'INTERNAL_ERROR',
        message: statusCode === 500 ? 'Internal server error' : err.message
      });
    }
  };
}

/**
 * Handler produksi untuk DELETE /api/pos/menu/items/:id (soft-deactivate is_active = FALSE).
 * Mempertahankan barcode dan photo_storage_key produk.
 */
export function createPosMenuItemDeactivateHandler(deps: PosMenuItemPatchDeps) {
  return async (req: any, res: any) => {
    try {
      const itemId = Number(req.params?.id);
      const propertyIdRaw = req.query?.property_id || req.body?.property_id;
      if (!itemId) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid item id' });
      }
      if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'property_id is required' });
      }
      const propertyId = Number(propertyIdRaw);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'invalid property_id' });
      }
      await deps.assertPropertyScope(req, propertyId);
      const updateResult = await deps.pool.query(
        `UPDATE pos_menu_items
            SET is_active = FALSE,
                is_deleted = TRUE,
                deleted_at = NOW(),
                item_code = NULL,
                barcode = NULL,
                category_id = NULL
          WHERE id = $1 AND property_id = $2
          RETURNING id`,
        [itemId, propertyId]
      );
      if ((updateResult.rowCount ?? 0) === 0) {
        return res.status(404).json({ status: 'ERROR', code: 'NOT_FOUND', message: `menu item ${itemId} not found for property ${propertyId}` });
      }
      res.json({ status: 'OK', message: 'Produk berhasil dihapus tanpa menghilangkan riwayat penjualan' });
    } catch (err: any) {
      const statusCode = err.statusCode || 500;
      res.status(statusCode).json({
        status: 'ERROR',
        code: err.code || 'INTERNAL_ERROR',
        message: statusCode === 500 ? 'Internal server error' : err.message
      });
    }
  };
}

/**
 * Handler produksi untuk POST /api/pos/menu/items/bulk-import.
 * Mendukung import massal (.xlsx) untuk 4 tipe produk:
 * - FINISHED_GOOD (Produk Jadi + Varian)
 * - SEMI_FINISHED (Produk Setengah Jadi)
 * - RAW_MATERIAL (Bahan Baku)
 * - OPERATIONAL_ITEM (Item Operasional HK/Hotel)
 */
export function createPosMenuItemsBulkImportHandler(deps: PosMenuItemCreateDeps) {
  return async (req: any, res: any) => {
    try {
      const body = req.body || {};
      const propertyId = Number(body.property_id ?? req.query?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib berupa bilangan bulat positif',
        });
      }
      await deps.assertPropertyScope(req, propertyId);

      const rawItems = Array.isArray(body.items) ? body.items : Array.isArray(body.rows) ? body.rows : null;
      if (!Array.isArray(rawItems) || rawItems.length === 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'items wajib berupa array non-kosong',
        });
      }
      if (rawItems.length > 500) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'Maksimal 500 baris produk per sekali proses import',
        });
      }

      const client = await deps.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM properties WHERE id = $1 FOR UPDATE', [propertyId]);

        let createdCount = 0;
        let updatedCount = 0;
        const errors: Array<{ row_index: number; name: string; message: string }> = [];

        for (let idx = 0; idx < rawItems.length; idx++) {
          const item = rawItems[idx] || {};
          const rowIndex = Number(item.row_index ?? idx + 1);
          const rawName = typeof item.name === 'string' ? item.name.trim() : '';
          if (!rawName) {
            errors.push({ row_index: rowIndex, name: '-', message: 'Nama produk wajib diisi' });
            continue;
          }
          if (rawName.length > 100) {
            errors.push({ row_index: rowIndex, name: rawName, message: 'Nama produk maksimal 100 karakter' });
            continue;
          }

          const ptParsed = parseProductTypeInput(item.product_type || 'FINISHED_GOOD');
          const productTypeVal: ProductType =
            ptParsed.ok && ptParsed.provided && ptParsed.value ? ptParsed.value : 'FINISHED_GOOD';

          const isFinishedGood = productTypeVal === 'FINISHED_GOOD';
          const effectiveSellablePos =
            typeof item.is_sellable_pos === 'boolean' ? item.is_sellable_pos : isFinishedGood;
          const trackStockVal =
            typeof item.track_stock === 'boolean'
              ? item.track_stock
              : productTypeVal === 'RAW_MATERIAL' ||
                productTypeVal === 'SEMI_FINISHED' ||
                productTypeVal === 'OPERATIONAL_ITEM' ||
                Boolean(item.track_stock);

          const rawUnitStr =
            typeof item.base_unit === 'string' && item.base_unit.trim() ? item.base_unit.trim() : 'PCS';
          const matchedUnit =
            matchCanonicalUnitByText(rawUnitStr) ||
            getCanonicalUnitByCode(rawUnitStr) ||
            getCanonicalUnitByCode('PCS')!;
          const canonicalCode = matchedUnit.code;
          const baseUnitLabel = matchedUnit.label_id;

          const parsedVariants = isFinishedGood ? parseVariantsInput(item.variants) : { ok: true as const, provided: true as const, value: [] as ProductVariantItem[] };
          const variantsVal: ProductVariantItem[] =
            parsedVariants.ok && parsedVariants.provided ? parsedVariants.value : [];

          let priceVal: number | null = null;
          if (item.price !== undefined && item.price !== null && String(item.price).trim() !== '') {
            const pNum = Math.round(Number(item.price));
            if (Number.isFinite(pNum) && pNum >= 0) {
              priceVal = pNum;
            }
          }
          if (priceVal === null && isFinishedGood && variantsVal.length > 0) {
            priceVal = variantsVal[0].price;
          }
          if (priceVal === null && effectiveSellablePos) {
            priceVal = 0;
          }

          let costPriceVal: number | null = null;
          if (item.cost_price !== undefined && item.cost_price !== null && String(item.cost_price).trim() !== '') {
            const cNum = Number(item.cost_price);
            if (Number.isFinite(cNum) && cNum >= 0) {
              costPriceVal = cNum;
            }
          }

          const rawCodeCandidate = item.item_code !== undefined && item.item_code !== null ? item.item_code : item.sku;
          const rawCode =
            typeof rawCodeCandidate === 'string' && rawCodeCandidate.trim() !== ''
              ? rawCodeCandidate.trim().slice(0, 50).toUpperCase()
              : null;
          const rawBarcode =
            typeof item.barcode === 'string' && item.barcode.trim() !== ''
              ? item.barcode.trim().slice(0, 100)
              : null;
          const rawSublocation =
            typeof item.storage_sublocation === 'string' && item.storage_sublocation.trim() !== ''
              ? item.storage_sublocation.trim().slice(0, 100)
              : null;
          const rawCategoryName =
            typeof item.category_name === 'string' && item.category_name.trim() !== ''
              ? item.category_name.trim().slice(0, 100)
              : null;

          await client.query(`SAVEPOINT sp_import_${idx}`);
          try {
            // 1. Resolve or create Category strictly per product_type
            let categoryId: number | null = null;
            if (rawCategoryName) {
              const findCat = await client.query(
                `SELECT id, product_type
                   FROM pos_menu_categories
                  WHERE property_id = $1
                    AND LOWER(name) = LOWER($2)
                    AND COALESCE(product_type, 'FINISHED_GOOD') = $3
                  LIMIT 1`,
                [propertyId, rawCategoryName, productTypeVal]
              );
              if ((findCat.rowCount ?? 0) > 0) {
                categoryId = Number(findCat.rows[0].id);
              } else {
                const newCat = await client.query(
                  `INSERT INTO pos_menu_categories (property_id, name, product_type) VALUES ($1, $2, $3) RETURNING id`,
                  [propertyId, rawCategoryName, productTypeVal]
                );
                categoryId = Number(newCat.rows[0].id);
              }
            }

            // 2. Check if item exists by item_code or (LOWER(name) + product_type) among non-deleted items
            let existingItem: any = null;
            if (rawCode) {
              const codeRes = await client.query(
                `SELECT * FROM pos_menu_items WHERE property_id = $1 AND COALESCE(is_deleted, FALSE) = FALSE AND UPPER(item_code) = $2 LIMIT 1`,
                [propertyId, rawCode]
              );
              if ((codeRes.rowCount ?? 0) > 0) {
                existingItem = codeRes.rows[0];
              }
            }
            if (!existingItem) {
              const nameRes = await client.query(
                `SELECT * FROM pos_menu_items WHERE property_id = $1 AND COALESCE(is_deleted, FALSE) = FALSE AND LOWER(name) = LOWER($2) AND COALESCE(product_type, 'FINISHED_GOOD') = $3 ORDER BY id ASC LIMIT 1`,
                [propertyId, rawName, productTypeVal]
              );
              if ((nameRes.rowCount ?? 0) > 0) {
                existingItem = nameRes.rows[0];
              }
            }

            if (existingItem) {
              // Update existing product safely
              const lockStatus = await checkProductBaseUnitLockStatus(client, propertyId, Number(existingItem.id), {
                forMutation: false,
              });
              const nextBaseUnit = lockStatus.isLocked ? existingItem.base_unit || baseUnitLabel : baseUnitLabel;
              const nextCanonicalUnit = lockStatus.isLocked
                ? existingItem.canonical_base_unit_code || canonicalCode
                : canonicalCode;

              await client.query(
                `UPDATE pos_menu_items
                    SET name = $1,
                        category_id = COALESCE($2, category_id),
                        item_code = COALESCE($3, item_code),
                        barcode = COALESCE($4, barcode),
                        price = $5,
                        is_sellable_pos = $6,
                        product_type = $7,
                        base_unit = $8,
                        canonical_base_unit_code = $9,
                        track_stock = $10,
                        track_inventory = $10,
                        storage_sublocation = COALESCE($11, storage_sublocation),
                        variants = $12::jsonb,
                        average_cost = CASE WHEN $13::numeric IS NOT NULL AND COALESCE(average_cost, 0) = 0 THEN $13::numeric ELSE average_cost END,
                        last_cost = COALESCE($13::numeric, last_cost)
                  WHERE id = $14 AND property_id = $15`,
                [
                  rawName,
                  categoryId,
                  rawCode,
                  rawBarcode,
                  priceVal,
                  effectiveSellablePos,
                  productTypeVal,
                  nextBaseUnit,
                  nextCanonicalUnit,
                  trackStockVal,
                  rawSublocation,
                  JSON.stringify(variantsVal),
                  costPriceVal,
                  existingItem.id,
                  propertyId,
                ]
              );
              if (rawSublocation) {
                await client.query(
                  `UPDATE stock_balances SET storage_sublocation = $1 WHERE property_id = $2 AND product_id = $3`,
                  [rawSublocation, propertyId, existingItem.id]
                );
              }
              updatedCount++;
            } else {
              const generatedCode =
                rawCode || `PRD-${Date.now().toString().slice(-4)}-${idx + 1}`;
              await client.query(
                `INSERT INTO pos_menu_items (
                   property_id, category_id, item_code, barcode, name,
                   price, is_active, is_sellable_pos, product_type, product_kind,
                   base_unit, canonical_base_unit_code, track_stock, track_inventory,
                   storage_sublocation, variants, average_cost, last_cost
                 ) VALUES (
                   $1, $2, $3, $4, $5,
                   $6, TRUE, $7, $8, 'STANDARD',
                   $9, $10, $11, $11,
                   $12, $13::jsonb, COALESCE($14::numeric, 0), COALESCE($14::numeric, 0)
                 )`,
                [
                  propertyId,
                  categoryId,
                  generatedCode,
                  rawBarcode,
                  rawName,
                  priceVal,
                  effectiveSellablePos,
                  productTypeVal,
                  baseUnitLabel,
                  canonicalCode,
                  trackStockVal,
                  rawSublocation,
                  JSON.stringify(variantsVal),
                  costPriceVal,
                ]
              );
              createdCount++;
            }
            await client.query(`RELEASE SAVEPOINT sp_import_${idx}`);
          } catch (rowErr: any) {
            await client.query(`ROLLBACK TO SAVEPOINT sp_import_${idx}`);
            errors.push({
              row_index: rowIndex,
              name: rawName,
              message: rowErr?.message || 'Gagal menyimpan baris produk',
            });
          }
        }

        await client.query('COMMIT');
        return res.status(200).json({
          status: 'OK',
          data: {
            created_count: createdCount,
            updated_count: updatedCount,
            failed_count: errors.length,
            errors,
          },
        });
      } catch (txErr) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore
        }
        throw txErr;
      } finally {
        client.release();
      }
    } catch (err: any) {
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err.code || 'INTERNAL_ERROR',
        message: statusCode === 500 ? 'Internal server error' : err.message,
      });
    }
  };
}

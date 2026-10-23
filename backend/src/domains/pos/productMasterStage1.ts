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

export const PRODUCT_TYPES = ['RAW_MATERIAL', 'SEMI_FINISHED', 'FINISHED_GOOD'] as const;
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
            return res.status(409).json({
              status: 'ERROR',
              code: 'BASE_UNIT_LOCKED_BY_USAGE',
              message:
                'Satuan dasar tidak dapat diubah karena produk sudah memiliki kemasan aktif atau penggunaan stok',
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

      if (effectiveSellablePos && price === undefined) {
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

      const parsedPrice = parsePriceInput(price);
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

      let isActiveVal = true;
      if (is_active !== undefined) {
        if (typeof is_active !== 'boolean') {
          return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'is_active must be a boolean' });
        }
        isActiveVal = is_active;
      }

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
                   price, is_active, is_sellable_pos, product_type, product_kind, base_unit, barcode, canonical_base_unit_code
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
        await client.query('COMMIT');
        const row = insertRes.rows[0];
        res.status(201).json({
          status: 'OK',
          data: formatPosMenuItemRow({
            canonical_base_unit_code: canonicalBaseUnitVal,
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
        'UPDATE pos_menu_items SET is_active = FALSE WHERE id = $1 AND property_id = $2 RETURNING id',
        [itemId, propertyId]
      );
      if ((updateResult.rowCount ?? 0) === 0) {
        return res.status(404).json({ status: 'ERROR', code: 'NOT_FOUND', message: `menu item ${itemId} not found for property ${propertyId}` });
      }
      res.json({ status: 'OK', message: 'Item nonaktif' });
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

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
  const rawPrice = row.price;
  const formattedPrice =
    rawPrice === null || rawPrice === undefined ? null : Number(rawPrice);

  const productType: ProductType | null = row.product_type ?? null;
  const productKind: ProductKind | null = row.product_kind ?? null;
  const baseUnit: string | null = row.base_unit ?? null;
  const isSellablePos: boolean =
    typeof row.is_sellable_pos === 'boolean' ? row.is_sellable_pos : true;

  return {
    ...row,
    price: formattedPrice,
    is_sellable_pos: isSellablePos,
    product_type: productType,
    product_type_label: productType ? PRODUCT_TYPE_LABELS[productType] ?? 'Belum diatur' : 'Belum diatur',
    product_kind: productKind,
    product_kind_label: productKind ? PRODUCT_KIND_LABELS[productKind] ?? 'Belum diatur' : 'Belum diatur',
    base_unit: baseUnit,
  };
}

export interface PosMenuItemPatchDeps {
  pool: {
    query: (sql: string, params?: any[]) => Promise<any>;
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
      if (body.base_unit !== undefined) {
        const bu = parseBaseUnitInput(body.base_unit);
        if (!bu.ok) {
          return res.status(400).json({ status: 'ERROR', code: bu.code, message: bu.message });
        }
        params.push(bu.value);
        setClauses.push(`base_unit = $${params.length}`);
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

      if (setClauses.length === 0) {
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
        // Tangani concurrent code duplication via unique index (uq_pmi_property_code).
        // HANYA jika 23505 dan constraint yang benar — bukan semua 23505 generik.
        if (updateErr.code === '23505' && updateErr.constraint === 'uq_pmi_property_code') {
          return res.status(409).json({ status: 'ERROR', code: 'ITEM_CODE_DUPLICATE', message: 'item code already exists for this property' });
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

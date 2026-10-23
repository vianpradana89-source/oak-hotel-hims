import crypto from 'crypto';
import { Request, Response } from 'express';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Katalog Satuan Kanonik Sistem (MP-03C — 15 Kode Kontrak MP-03B §2.1 & §3.1)
// ─────────────────────────────────────────────────────────────────────────────

export const UNIT_DIMENSIONS = ['COUNT', 'WEIGHT', 'VOLUME'] as const;
export type UnitDimension = (typeof UNIT_DIMENSIONS)[number];

export interface CanonicalUnitDefinition {
  code: string;
  dimension: UnitDimension;
  label_id: string;
  aliases: readonly string[];
  allow_decimal: boolean;
  display_scale: 0 | 3;
}

export const SYSTEM_CANONICAL_UNITS: readonly CanonicalUnitDefinition[] = [
  // COUNT (Diskrit — 11 kode: wajib bilangan bulat pada kuantitas satuan dasar & faktor kemasan ke satuan dasar)
  {
    code: 'PCS',
    dimension: 'COUNT',
    label_id: 'Pcs',
    aliases: ['pcs', 'pc', 'piece', 'pieces', 'buah', 'biji', 'unit'],
    allow_decimal: false,
    display_scale: 0,
  },
  {
    code: 'PORSI',
    dimension: 'COUNT',
    label_id: 'Porsi',
    aliases: ['porsi', 'portion', 'serving', 'piring', 'plate', 'mangkuk', 'bowl'],
    allow_decimal: false,
    display_scale: 0,
  },
  {
    code: 'GELAS',
    dimension: 'COUNT',
    label_id: 'Gelas',
    aliases: ['gelas', 'glass'],
    allow_decimal: false,
    display_scale: 0,
  },
  {
    code: 'CUP',
    dimension: 'COUNT',
    label_id: 'Cup',
    aliases: ['cup', 'cups', 'cangkir'],
    allow_decimal: false,
    display_scale: 0,
  },
  {
    code: 'BOTOL',
    dimension: 'COUNT',
    label_id: 'Botol',
    aliases: ['botol', 'btl', 'bottle', 'bottles'],
    allow_decimal: false,
    display_scale: 0,
  },
  {
    code: 'KALENG',
    dimension: 'COUNT',
    label_id: 'Kaleng',
    aliases: ['kaleng', 'klg', 'can', 'cans', 'tin'],
    allow_decimal: false,
    display_scale: 0,
  },
  {
    code: 'PACK',
    dimension: 'COUNT',
    label_id: 'Pack',
    aliases: ['pack', 'pak', 'bungkus', 'bks', 'sachet', 'sct', 'pouch'],
    allow_decimal: false,
    display_scale: 0,
  },
  {
    code: 'BOX',
    dimension: 'COUNT',
    label_id: 'Box',
    aliases: ['box', 'kotak', 'dus', 'doos', 'karton', 'ctn', 'carton', 'crate', 'krat'],
    allow_decimal: false,
    display_scale: 0,
  },
  {
    code: 'ROLL',
    dimension: 'COUNT',
    label_id: 'Roll',
    aliases: ['roll', 'rol', 'gulung'],
    allow_decimal: false,
    display_scale: 0,
  },
  {
    code: 'SET',
    dimension: 'COUNT',
    label_id: 'Set',
    aliases: ['set', 'pasang', 'pair', 'kit'],
    allow_decimal: false,
    display_scale: 0,
  },
  {
    code: 'LEMBAR',
    dimension: 'COUNT',
    label_id: 'Lembar',
    aliases: ['lembar', 'lbr', 'sheet', 'sheets', 'helai', 'slice'],
    allow_decimal: false,
    display_scale: 0,
  },

  // WEIGHT (Berat — 2 kode: mendukung pecahan hingga 3 desimal, skala mili-unit)
  {
    code: 'KG',
    dimension: 'WEIGHT',
    label_id: 'Kg',
    aliases: ['kg', 'kilogram', 'kilo', 'kgs'],
    allow_decimal: true,
    display_scale: 3,
  },
  {
    code: 'GRAM',
    dimension: 'WEIGHT',
    label_id: 'Gram',
    aliases: ['gram', 'gr', 'g', 'gm', 'grams'],
    allow_decimal: true,
    display_scale: 3,
  },

  // VOLUME (Volume — 2 kode: mendukung pecahan hingga 3 desimal, skala mili-unit)
  {
    code: 'LITER',
    dimension: 'VOLUME',
    label_id: 'Liter',
    aliases: ['liter', 'ltr', 'l', 'lt', 'litre', 'liters'],
    allow_decimal: true,
    display_scale: 3,
  },
  {
    code: 'ML',
    dimension: 'VOLUME',
    label_id: 'mL',
    aliases: ['ml', 'milliliter', 'mililiter', 'millilitre', 'cc'],
    allow_decimal: true,
    display_scale: 3,
  },
] as const;

export const CANONICAL_UNIT_CODES: readonly string[] = SYSTEM_CANONICAL_UNITS.map((u) => u.code);

const CANONICAL_UNIT_BY_CODE = new Map<string, CanonicalUnitDefinition>(
  SYSTEM_CANONICAL_UNITS.map((u) => [u.code, u])
);

const CANONICAL_UNIT_BY_ALIAS = new Map<string, CanonicalUnitDefinition>();
for (const unit of SYSTEM_CANONICAL_UNITS) {
  CANONICAL_UNIT_BY_ALIAS.set(unit.code.toLowerCase(), unit);
  CANONICAL_UNIT_BY_ALIAS.set(unit.label_id.toLowerCase(), unit);
  for (const alias of unit.aliases) {
    CANONICAL_UNIT_BY_ALIAS.set(alias.toLowerCase(), unit);
  }
}

export function getCanonicalUnitByCode(code: unknown): CanonicalUnitDefinition | null {
  if (typeof code !== 'string') return null;
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;
  return CANONICAL_UNIT_BY_CODE.get(normalized) ?? null;
}

export function matchCanonicalUnitByText(text: unknown): CanonicalUnitDefinition | null {
  if (typeof text !== 'string') return null;
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;
  return CANONICAL_UNIT_BY_ALIAS.get(normalized) ?? null;
}

export function isTextEquivalentToCanonicalUnit(text: unknown, canonicalCode: string): boolean {
  const unit = getCanonicalUnitByCode(canonicalCode);
  if (!unit || typeof text !== 'string') return false;
  const matched = matchCanonicalUnitByText(text);
  return matched !== null && matched.code === unit.code;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Representasi String Desimal Otoritatif & Aritmetika Mili-Unit (BigInt)
// ─────────────────────────────────────────────────────────────────────────────

export const STRICT_DECIMAL_STRING_REGEX = /^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/;
export const MAX_QUANTITY_MILLI = 999_999_999_999n; // 999999999.999 (NUMERIC(12,3))
export const MAX_COUNT_QUANTITY_MILLI = 999_999_999_000n; // 999999999
export const MAX_FACTOR_MILLI = 100_000_000n; // 100000.000 (MP-03B §2.2)

export interface DecimalParseSuccess {
  ok: true;
  milli: bigint;
  formatted3: string;
  formattedNormalized: string;
}

export interface DecimalParseFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
}

export type DecimalParseResult = DecimalParseSuccess | DecimalParseFailure;

export function milliToDecimalString(milli: bigint, fixedScale: 0 | 3 = 3): string {
  const isNeg = milli < 0n;
  const abs = isNeg ? -milli : milli;
  const whole = abs / 1000n;
  const frac = abs % 1000n;
  if (fixedScale === 0 && frac === 0n) {
    return `${isNeg ? '-' : ''}${whole.toString()}`;
  }
  const fracStr = frac.toString().padStart(3, '0');
  return `${isNeg ? '-' : ''}${whole.toString()}.${fracStr}`;
}

/**
 * Mengurai string desimal ketat ("24", "24.000", "0.250") menjadi mili-unit BigInt.
 * Menolak tipe number JS, notasi ilmiah, koma, tanda minus, dan >3 desimal dengan 400 DECIMAL_STRING_REQUIRED.
 */
export function parseStrictDecimalString(
  raw: unknown,
  fieldLabel = 'Kuantitas'
): DecimalParseResult {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      status: 400,
      code: 'DECIMAL_STRING_REQUIRED',
      error: `${fieldLabel} wajib dikirim sebagai string desimal (mis. "1" atau "0.250"), bukan tipe ${typeof raw}`,
    };
  }
  const trimmed = raw.trim();
  if (!STRICT_DECIMAL_STRING_REGEX.test(trimmed)) {
    return {
      ok: false,
      status: 400,
      code: 'DECIMAL_STRING_REQUIRED',
      error: `${fieldLabel} wajib berupa string angka desimal positif maksimal 3 angka di belakang titik (contoh: "24" atau "0.250")`,
    };
  }

  const [wholePart, fracPart = ''] = trimmed.split('.');
  const paddedFrac = fracPart.padEnd(3, '0');
  let milli: bigint;
  try {
    milli = BigInt(wholePart) * 1000n + BigInt(paddedFrac);
  } catch {
    return {
      ok: false,
      status: 400,
      code: 'DECIMAL_STRING_REQUIRED',
      error: `${fieldLabel} tidak dapat diurai sebagai angka desimal yang valid`,
    };
  }

  return {
    ok: true,
    milli,
    formatted3: milliToDecimalString(milli, 3),
    formattedNormalized: milli % 1000n === 0n ? milliToDecimalString(milli, 0) : milliToDecimalString(milli, 3),
  };
}

/**
 * Validasi faktor kemasan (`to_base_factor`) terhadap satuan dasar kanonik.
 */
export function parsePackagingFactorInput(
  rawFactor: unknown,
  baseUnitCode: string
): DecimalParseResult {
  const unit = getCanonicalUnitByCode(baseUnitCode);
  if (!unit) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_CANONICAL_BASE_UNIT',
      error: `Kode satuan dasar "${baseUnitCode}" tidak terdaftar dalam katalog satuan kanonik`,
    };
  }

  const parsed = parseStrictDecimalString(rawFactor, 'Faktor konversi kemasan (to_base_factor)');
  if (!parsed.ok) return parsed;

  if (parsed.milli <= 0n) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: 'Faktor konversi kemasan (to_base_factor) harus lebih besar dari 0',
    };
  }

  if (parsed.milli > MAX_FACTOR_MILLI) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: 'Faktor konversi kemasan (to_base_factor) melebihi batas maksimum 100000.000',
    };
  }

  if (!unit.allow_decimal && parsed.milli % 1000n !== 0n) {
    return {
      ok: false,
      status: 400,
      code: 'INTEGER_UNIT_REQUIRES_WHOLE_NUMBER',
      error: `Satuan dasar ${unit.label_id} (${unit.code}) berdimensi hitung (COUNT) sehingga faktor konversi kemasan wajib bilangan bulat`,
    };
  }

  return parsed;
}

/**
 * Validasi kuantitas pada satuan kanonik tertentu.
 */
export function parseCanonicalQuantityInput(
  rawQty: unknown,
  unitCode: string,
  options: { allowZero?: boolean; fieldLabel?: string } = {}
): DecimalParseResult {
  const unit = getCanonicalUnitByCode(unitCode);
  if (!unit) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_CANONICAL_BASE_UNIT',
      error: `Kode satuan "${unitCode}" tidak terdaftar dalam katalog satuan kanonik`,
    };
  }

  const parsed = parseStrictDecimalString(rawQty, options.fieldLabel ?? 'Kuantitas');
  if (!parsed.ok) return parsed;

  if (options.allowZero ? parsed.milli < 0n : parsed.milli <= 0n) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: `${options.fieldLabel ?? 'Kuantitas'} harus ${options.allowZero ? 'tidak negatif' : 'lebih besar dari 0'}`,
    };
  }

  if (!unit.allow_decimal && parsed.milli % 1000n !== 0n) {
    return {
      ok: false,
      status: 400,
      code: 'INTEGER_UNIT_REQUIRES_WHOLE_NUMBER',
      error: `Satuan ${unit.label_id} (${unit.code}) berdimensi hitung (COUNT) sehingga kuantitas wajib bilangan bulat`,
    };
  }

  const maxAllowedMilli = unit.allow_decimal ? MAX_QUANTITY_MILLI : MAX_COUNT_QUANTITY_MILLI;
  if (parsed.milli > maxAllowedMilli) {
    return {
      ok: false,
      status: 422,
      code: 'CONVERSION_RESULT_OVERFLOW',
      error: `${options.fieldLabel ?? 'Kuantitas'} melebihi batas maksimum penyimpanan (${unit.allow_decimal ? '999999999.999' : '999999999'})`,
    };
  }

  return parsed;
}

/**
 * Konversi kuantitas kemasan ke satuan dasar produk menggunakan aritmetika integer mili-unit BigInt.
 * Menegakkan:
 *  - 400 DECIMAL_STRING_REQUIRED jika input bukan string desimal
 *  - 400 VALIDATION_ERROR jika kuantitas kemasan bukan bilangan bulat positif
 *  - 422 SUB_MILLI_UNIT_PRECISION_LOSS jika hasil kali memiliki sisa sub-mili (rawNano % 1000n !== 0n)
 *  - 400 INTEGER_UNIT_REQUIRES_WHOLE_NUMBER jika satuan dasar COUNT menghasilkan pecahan
 *  - 422 CONVERSION_RESULT_OVERFLOW jika melebihi batas maksimum kuantitas (999999999.999 atau 999999999 untuk COUNT)
 */
export function convertPackagingToBaseQuantity(params: {
  packagingQty: unknown;
  toBaseFactor: unknown;
  baseUnitCode: string;
}): DecimalParseResult {
  const unit = getCanonicalUnitByCode(params.baseUnitCode);
  if (!unit) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_CANONICAL_BASE_UNIT',
      error: `Kode satuan dasar "${params.baseUnitCode}" tidak valid`,
    };
  }

  const parsedQty = parseStrictDecimalString(params.packagingQty, 'Kuantitas kemasan');
  if (!parsedQty.ok) return parsedQty;
  if (parsedQty.milli <= 0n) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: 'Kuantitas kemasan harus lebih besar dari 0',
    };
  }
  if (parsedQty.milli % 1000n !== 0n) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: 'Kuantitas dalam satuan kemasan wajib berupa bilangan bulat positif',
    };
  }

  const parsedFactor = parsePackagingFactorInput(params.toBaseFactor, unit.code);
  if (!parsedFactor.ok) return parsedFactor;

  const rawNano = parsedQty.milli * parsedFactor.milli;
  if (rawNano % 1000n !== 0n) {
    return {
      ok: false,
      status: 422,
      code: 'SUB_MILLI_UNIT_PRECISION_LOSS',
      error: 'Hasil konversi menghasilkan pecahan lebih kecil dari 0.001 satuan dasar (sub-mili) yang tidak dapat direpresentasikan secara eksak',
    };
  }

  const baseMilli = rawNano / 1000n;
  const maxAllowedMilli = unit.allow_decimal ? MAX_QUANTITY_MILLI : MAX_COUNT_QUANTITY_MILLI;
  if (baseMilli > maxAllowedMilli) {
    return {
      ok: false,
      status: 422,
      code: 'CONVERSION_RESULT_OVERFLOW',
      error: `Hasil konversi melebihi batas maksimum kuantitas (${unit.allow_decimal ? '999999999.999' : '999999999'})`,
    };
  }

  if (!unit.allow_decimal && baseMilli % 1000n !== 0n) {
    return {
      ok: false,
      status: 400,
      code: 'INTEGER_UNIT_REQUIRES_WHOLE_NUMBER',
      error: `Hasil konversi ke satuan dasar ${unit.label_id} (${unit.code}) wajib berupa bilangan bulat`,
    };
  }

  return {
    ok: true,
    milli: baseMilli,
    formatted3: milliToDecimalString(baseMilli, 3),
    formattedNormalized: unit.display_scale === 0 ? milliToDecimalString(baseMilli, 0) : milliToDecimalString(baseMilli, 3),
  };
}

/**
 * Konversi ukuran umum intra-dimensi (KG <-> GRAM, LITER <-> ML) dengan skala mili-unit BigInt.
 * Menolak konversi lintas dimensi (mis. KG <-> LITER atau PCS <-> GRAM) dengan 422 CROSS_DIMENSION_CONVERSION_FORBIDDEN.
 */
export function convertIntraDimensionQuantity(params: {
  quantity: unknown;
  fromUnitCode: string;
  toUnitCode: string;
}): DecimalParseResult {
  const fromUnit = getCanonicalUnitByCode(params.fromUnitCode);
  const toUnit = getCanonicalUnitByCode(params.toUnitCode);

  if (!fromUnit || !toUnit) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_CANONICAL_BASE_UNIT',
      error: 'Kode satuan asal atau tujuan tidak terdaftar dalam katalog satuan kanonik',
    };
  }

  if (fromUnit.dimension !== toUnit.dimension) {
    return {
      ok: false,
      status: 422,
      code: 'CROSS_DIMENSION_CONVERSION_FORBIDDEN',
      error: `Konversi umum lintas dimensi tidak diizinkan antara ${fromUnit.code} (${fromUnit.dimension}) dan ${toUnit.code} (${toUnit.dimension})`,
    };
  }

  const parsedQty = parseCanonicalQuantityInput(params.quantity, fromUnit.code, {
    allowZero: true,
    fieldLabel: 'Kuantitas asal',
  });
  if (!parsedQty.ok) return parsedQty;

  if (fromUnit.code === toUnit.code) {
    return parsedQty;
  }

  // Untuk COUNT, satuan berbeda (mis. BOTOL -> PCS) bukan konversi ukuran umum; wajib melalui kemasan produk.
  if (fromUnit.dimension === 'COUNT') {
    return {
      ok: false,
      status: 422,
      code: 'CROSS_DIMENSION_CONVERSION_FORBIDDEN',
      error: `Konversi antar satuan hitung (${fromUnit.code} ke ${toUnit.code}) wajib melalui definisi kemasan produk`,
    };
  }

  let resultMilli: bigint;
  if (
    (fromUnit.code === 'KG' && toUnit.code === 'GRAM') ||
    (fromUnit.code === 'LITER' && toUnit.code === 'ML')
  ) {
    resultMilli = parsedQty.milli * 1000n;
  } else if (
    (fromUnit.code === 'GRAM' && toUnit.code === 'KG') ||
    (fromUnit.code === 'ML' && toUnit.code === 'LITER')
  ) {
    if (parsedQty.milli % 1000n !== 0n) {
      return {
        ok: false,
        status: 422,
        code: 'SUB_MILLI_UNIT_PRECISION_LOSS',
        error: `Konversi dari ${fromUnit.code} ke ${toUnit.code} menghasilkan presisi lebih kecil dari 0.001 ${toUnit.code} (sub-mili)`,
      };
    }
    resultMilli = parsedQty.milli / 1000n;
  } else {
    return {
      ok: false,
      status: 422,
      code: 'CROSS_DIMENSION_CONVERSION_FORBIDDEN',
      error: `Pasangan konversi ${fromUnit.code} ke ${toUnit.code} tidak didukung`,
    };
  }

  if (resultMilli > MAX_QUANTITY_MILLI) {
    return {
      ok: false,
      status: 422,
      code: 'CONVERSION_RESULT_OVERFLOW',
      error: 'Hasil konversi melebihi batas maksimum kuantitas (999999999.999)',
    };
  }

  return {
    ok: true,
    milli: resultMilli,
    formatted3: milliToDecimalString(resultMilli, 3),
    formattedNormalized: toUnit.display_scale === 0 ? milliToDecimalString(resultMilli, 0) : milliToDecimalString(resultMilli, 3),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Matriks Kompatibilitas POST & PATCH Satuan Dasar Produk (L1–L4, C1–C4)
// ─────────────────────────────────────────────────────────────────────────────

export interface UnitMutationResolutionSuccess {
  ok: true;
  base_unit: string | null;
  canonical_base_unit_code: string | null;
  isUnitChanging: boolean;
}

export interface UnitMutationResolutionFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
}

export type UnitMutationResolutionResult =
  | UnitMutationResolutionSuccess
  | UnitMutationResolutionFailure;

const BASE_UNIT_BLOCKED_CHARS = /[\r\n\t\0]/;

function validateLegacyBaseUnitText(raw: unknown): { ok: true; value: string | null } | UnitMutationResolutionFailure {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: 'Satuan dasar (base_unit) harus berupa teks',
    };
  }
  if (BASE_UNIT_BLOCKED_CHARS.test(raw)) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: 'Satuan dasar (base_unit) tidak boleh mengandung karakter kontrol, tab, atau baris baru',
    };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > 50) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: 'Satuan dasar (base_unit) maksimal 50 karakter',
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * Resolusi satuan dasar saat POST /api/pos/menu/items.
 * - Mendukung `canonical_base_unit_code` (kanonik) maupun caller lama yang hanya mengirim `base_unit`.
 * - Menolak konflik antara `canonical_base_unit_code` dan `base_unit` dengan 400 CONFLICTING_BASE_UNIT_FIELDS.
 */
export function resolveCreateProductUnitInput(body: Record<string, any>): UnitMutationResolutionResult {
  const hasCanonicalField = Object.prototype.hasOwnProperty.call(body, 'canonical_base_unit_code');
  const rawCanonical = body.canonical_base_unit_code;
  const rawBaseUnit = body.base_unit;

  const legacyValidated = validateLegacyBaseUnitText(rawBaseUnit);
  if (!legacyValidated.ok) return legacyValidated;

  if (hasCanonicalField && rawCanonical !== undefined && rawCanonical !== null && String(rawCanonical).trim() !== '') {
    if (typeof rawCanonical !== 'string') {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_CANONICAL_BASE_UNIT',
        error: 'Kode satuan dasar kanonik (canonical_base_unit_code) harus berupa teks',
      };
    }
    const unit = getCanonicalUnitByCode(rawCanonical);
    if (!unit) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_CANONICAL_BASE_UNIT',
        error: `Kode satuan dasar kanonik "${String(rawCanonical).trim()}" tidak valid. Gunakan salah satu dari: ${CANONICAL_UNIT_CODES.join(', ')}`,
      };
    }

    if (legacyValidated.value !== null && !isTextEquivalentToCanonicalUnit(legacyValidated.value, unit.code)) {
      return {
        ok: false,
        status: 400,
        code: 'CONFLICTING_BASE_UNIT_FIELDS',
        error: `Nilai base_unit "${legacyValidated.value}" bertentangan dengan canonical_base_unit_code "${unit.code}"`,
      };
    }

    return {
      ok: true,
      base_unit: unit.label_id,
      canonical_base_unit_code: unit.code,
      isUnitChanging: false,
    };
  }

  // Jika canonical_base_unit_code dikirim eksplisit null/"" sementara base_unit juga dikirim:
  // pada POST, jika canonical_base_unit_code tidak diisi, simpan base_unit apa adanya dan canonical_base_unit_code = null
  return {
    ok: true,
    base_unit: legacyValidated.value,
    canonical_base_unit_code: null,
    isUnitChanging: false,
  };
}

/**
 * Resolusi matriks eksplisit PATCH /api/pos/menu/items/:id (L1–L4 untuk produk belum terpetakan, C1–C4 untuk produk kanonik).
 * Mengembalikan nilai target (base_unit, canonical_base_unit_code) serta flag `isUnitChanging`
 * yang menentukan apakah pemeriksaan kunci penggunaan wajib memblokir perubahan.
 */
export function resolvePatchProductUnitMutation(params: {
  existingBaseUnit: string | null;
  existingCanonicalCode: string | null;
  body: Record<string, any>;
}): UnitMutationResolutionResult {
  const { body } = params;
  const existingBaseUnit =
    typeof params.existingBaseUnit === 'string' && params.existingBaseUnit.trim() !== ''
      ? params.existingBaseUnit.trim()
      : null;
  const existingCanonicalCode =
    typeof params.existingCanonicalCode === 'string' && params.existingCanonicalCode.trim() !== ''
      ? params.existingCanonicalCode.trim().toUpperCase()
      : null;

  const hasCanonicalField = Object.prototype.hasOwnProperty.call(body, 'canonical_base_unit_code');
  const hasBaseUnitField = Object.prototype.hasOwnProperty.call(body, 'base_unit');

  // Jika kedua field tidak dikirim (L1 / C1): pertahankan nilai existing tanpa perubahan
  if (!hasCanonicalField && !hasBaseUnitField) {
    return {
      ok: true,
      base_unit: existingBaseUnit,
      canonical_base_unit_code: existingCanonicalCode,
      isUnitChanging: false,
    };
  }

  let validatedBaseUnit: string | null = null;
  if (hasBaseUnitField) {
    const legacyRes = validateLegacyBaseUnitText(body.base_unit);
    if (!legacyRes.ok) return legacyRes;
    validatedBaseUnit = legacyRes.value;
  }

  // ── JALUR 1: Caller mengirim `canonical_base_unit_code` secara eksplisit ──
  if (hasCanonicalField) {
    const rawCanonical = body.canonical_base_unit_code;
    const isCanonicalCleared =
      rawCanonical === null || (typeof rawCanonical === 'string' && rawCanonical.trim() === '');

    if (isCanonicalCleared) {
      // Jika canonical_base_unit_code: null dikirim bersama base_unit non-null yang bertentangan
      if (hasBaseUnitField && validatedBaseUnit !== null) {
        return {
          ok: false,
          status: 400,
          code: 'CONFLICTING_BASE_UNIT_FIELDS',
          error: 'Tidak dapat mengosongkan canonical_base_unit_code sambil mengirim base_unit non-kosong pada saat bersamaan',
        };
      }
      const hadAnyUnit = existingCanonicalCode !== null || existingBaseUnit !== null;
      return {
        ok: true,
        base_unit: null,
        canonical_base_unit_code: null,
        isUnitChanging: hadAnyUnit,
      };
    }

    if (typeof rawCanonical !== 'string') {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_CANONICAL_BASE_UNIT',
        error: 'Kode satuan dasar kanonik (canonical_base_unit_code) harus berupa teks',
      };
    }

    const targetUnit = getCanonicalUnitByCode(rawCanonical);
    if (!targetUnit) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_CANONICAL_BASE_UNIT',
        error: `Kode satuan dasar kanonik "${rawCanonical.trim()}" tidak valid. Gunakan salah satu dari: ${CANONICAL_UNIT_CODES.join(', ')}`,
      };
    }

    // Jika base_unit juga dikirim pada body yang sama, wajib ekuivalen dengan canonical_base_unit_code
    if (hasBaseUnitField && validatedBaseUnit !== null && !isTextEquivalentToCanonicalUnit(validatedBaseUnit, targetUnit.code)) {
      return {
        ok: false,
        status: 400,
        code: 'CONFLICTING_BASE_UNIT_FIELDS',
        error: `Nilai base_unit "${validatedBaseUnit}" bertentangan dengan canonical_base_unit_code "${targetUnit.code}"`,
      };
    }
    if (hasBaseUnitField && validatedBaseUnit === null) {
      return {
        ok: false,
        status: 400,
        code: 'CONFLICTING_BASE_UNIT_FIELDS',
        error: `Nilai base_unit null bertentangan dengan canonical_base_unit_code "${targetUnit.code}"`,
      };
    }

    // Apakah ini perubahan satuan yang harus dicek terhadap kunci penggunaan?
    let isUnitChanging = false;
    if (existingCanonicalCode !== null) {
      // Produk sudah kanonik: berubah jika kode berbeda
      isUnitChanging = existingCanonicalCode !== targetUnit.code;
    } else if (existingBaseUnit !== null) {
      // Produk legacy: jika teks lama ekuivalen dengan targetUnit, ini adalah promosi setara (bukan perubahan makna satuan)
      isUnitChanging = !isTextEquivalentToCanonicalUnit(existingBaseUnit, targetUnit.code);
    } else {
      // Produk belum memiliki satuan sama sekali: penetapan awal
      isUnitChanging = false;
    }

    return {
      ok: true,
      base_unit: targetUnit.label_id,
      canonical_base_unit_code: targetUnit.code,
      isUnitChanging,
    };
  }

  // ── JALUR 2: Caller Lama — hanya mengirim `base_unit` tanpa `canonical_base_unit_code` ──
  if (existingCanonicalCode === null) {
    // ── Matriks L2, L3, L4 (Produk Belum Terpetakan: canonical_base_unit_code IS NULL) ──
    if (validatedBaseUnit === null) {
      // L4: base_unit dikirim null / ""
      return {
        ok: true,
        base_unit: null,
        canonical_base_unit_code: null,
        isUnitChanging: existingBaseUnit !== null,
      };
    }

    // Cek kesetaraan dengan existingBaseUnit (L2 vs L3)
    const isSameCaseInsensitive =
      existingBaseUnit !== null && existingBaseUnit.toLowerCase() === validatedBaseUnit.toLowerCase();
    const existingMatchedUnit = existingBaseUnit ? matchCanonicalUnitByText(existingBaseUnit) : null;
    const newMatchedUnit = matchCanonicalUnitByText(validatedBaseUnit);
    const isSameAliasGroup =
      existingMatchedUnit !== null && newMatchedUnit !== null && existingMatchedUnit.code === newMatchedUnit.code;

    if (isSameCaseInsensitive || isSameAliasGroup) {
      // L2: Teks/alias setara -> pertahankan canonical_base_unit_code = null, tidak dianggap ubah satuan
      return {
        ok: true,
        base_unit: validatedBaseUnit,
        canonical_base_unit_code: null,
        isUnitChanging: false,
      };
    }

    // L3: Teks berbeda pada produk belum terpetakan
    return {
      ok: true,
      base_unit: validatedBaseUnit,
      canonical_base_unit_code: null,
      isUnitChanging: existingBaseUnit !== null,
    };
  }

  // ── Matriks C2, C3, C4 (Produk Sudah Kanonik: canonical_base_unit_code = X) ──
  const currentCanonicalUnit = getCanonicalUnitByCode(existingCanonicalCode);

  if (validatedBaseUnit === null) {
    // C4: base_unit dikirim null / "" pada produk kanonik -> perubahan satuan (dicek kunci!)
    return {
      ok: true,
      base_unit: null,
      canonical_base_unit_code: null,
      isUnitChanging: true,
    };
  }

  if (isTextEquivalentToCanonicalUnit(validatedBaseUnit, existingCanonicalCode)) {
    // C2: Teks/alias setara dengan X -> PERTAHANKAN canonical_base_unit_code = X dan label kanonik!
    return {
      ok: true,
      base_unit: currentCanonicalUnit ? currentCanonicalUnit.label_id : validatedBaseUnit,
      canonical_base_unit_code: existingCanonicalCode,
      isUnitChanging: false,
    };
  }

  // C3: Teks berbeda atau tidak dikenal pada produk yang sudah kanonik -> perubahan satuan (dicek kunci!).
  // Sesuai Matriks C3 MP-03B §5.2.1: caller legacy yang mengirim teks berbeda tanpa canonical_base_unit_code
  // TIDAK boleh otomatis menetapkan kode kanonik baru. Jika produk tidak terkunci, base_unit diperbarui
  // dan canonical_base_unit_code di-reset menjadi null; jika terkunci, ditolak 409 BASE_UNIT_LOCKED_BY_USAGE.
  return {
    ok: true,
    base_unit: validatedBaseUnit,
    canonical_base_unit_code: null,
    isUnitChanging: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Pemeriksaan Kesiapan Schema, Status Kunci Satuan, & Pemuatan Kemasan
// ─────────────────────────────────────────────────────────────────────────────

export interface ProductLockCheckResult {
  schemaReady: boolean;
  isLocked: boolean;
  activePackagingCount: number;
  hasInventoryOrMinibarUsage: boolean;
}

/**
 * Memeriksa apakah satuan dasar produk terkunci oleh kemasan aktif atau pemakaian minibar/inventori.
 * - Memakai `to_regclass` untuk mendeteksi kesiapan tabel `public.product_packaging_conversions`.
 * - Jika `forMutation === true` dan tabel `product_packaging_conversions` belum ada (`to_regclass === null`),
 *   melempar error dengan `code = 'SCHEMA_NOT_READY'` (HTTP 503).
 * - Jika query pemeriksaan pada tabel yang ada gagal karena error DB, melempar error dengan `code = 'USAGE_CHECK_FAILED'` (HTTP 503)
 *   agar kegagalan DB tidak pernah ditelan sebagai `false` (fail-closed).
 */
export async function checkProductBaseUnitLockStatus(
  queryable: { query: (sql: string, params?: any[]) => Promise<any> },
  propertyId: number,
  menuItemId: number,
  options: { forMutation?: boolean } = {}
): Promise<ProductLockCheckResult> {
  let pkgRegClass: string | null = null;
  try {
    const regRes = await queryable.query(
      `SELECT to_regclass('public.product_packaging_conversions') AS pkg_reg`
    );
    pkgRegClass = regRes?.rows?.[0]?.pkg_reg ?? null;
  } catch (err: any) {
    const wrapped: any = new Error(
      `Gagal memeriksa kesiapan schema satuan/kemasan: ${err?.message || 'Unknown DB error'}`
    );
    wrapped.statusCode = 503;
    wrapped.code = 'USAGE_CHECK_FAILED';
    throw wrapped;
  }

  if (!pkgRegClass) {
    if (options.forMutation) {
      const notReadyErr: any = new Error(
        'Schema kemasan produk (product_packaging_conversions) belum siap. Jalankan migrasi MP-03C terlebih dahulu.'
      );
      notReadyErr.statusCode = 503;
      notReadyErr.code = 'SCHEMA_NOT_READY';
      throw notReadyErr;
    }
    return {
      schemaReady: false,
      isLocked: true, // Fail-closed untuk indikator UI sebelum migrasi
      activePackagingCount: 0,
      hasInventoryOrMinibarUsage: false,
    };
  }

  try {
    const pkgRes = await queryable.query(
      `SELECT COUNT(*)::int AS cnt
         FROM product_packaging_conversions
        WHERE property_id = $1
          AND menu_item_id = $2
          AND is_active = TRUE`,
      [propertyId, menuItemId]
    );
    const activePackagingCount = Number(pkgRes?.rows?.[0]?.cnt ?? 0);

    // Pemeriksaan tabel minibar aktual sesuai kontrak MP-03B §3.4 & §5.2.1:
    // - public.room_type_minibar_standard (property_id, menu_item_id)
    // - public.minibar_baseline_verification (property_id, menu_item_id)
    // - public.minibar_stay_event (property_id, menu_item_id)
    // - public.minibar_inspection_report_line (property_id, menu_item_id)
    // Tabel opsional yang terkonfirmasi belum ada (to_regclass === null) boleh dilewati,
    // tetapi kegagalan query tidak boleh dianggap "belum digunakan" (fail-closed -> 503 USAGE_CHECK_FAILED).
    let hasInventoryOrMinibarUsage = false;
    const optRegRes = await queryable.query(
      `SELECT to_regclass('public.room_type_minibar_standard') AS rtms_reg,
              to_regclass('public.minibar_baseline_verification') AS mbv_reg,
              to_regclass('public.minibar_stay_event') AS mse_reg,
              to_regclass('public.minibar_inspection_report_line') AS mirl_reg`
    );
    const optRow = optRegRes?.rows?.[0] || {};

    if (optRow.rtms_reg) {
      const rtmsCheck = await queryable.query(
        `SELECT EXISTS (
           SELECT 1 FROM room_type_minibar_standard WHERE property_id = $1 AND menu_item_id = $2
         ) AS used`,
        [propertyId, menuItemId]
      );
      if (rtmsCheck?.rows?.[0]?.used) hasInventoryOrMinibarUsage = true;
    }
    if (!hasInventoryOrMinibarUsage && optRow.mbv_reg) {
      const mbvCheck = await queryable.query(
        `SELECT EXISTS (
           SELECT 1 FROM minibar_baseline_verification WHERE property_id = $1 AND menu_item_id = $2
         ) AS used`,
        [propertyId, menuItemId]
      );
      if (mbvCheck?.rows?.[0]?.used) hasInventoryOrMinibarUsage = true;
    }
    if (!hasInventoryOrMinibarUsage && optRow.mse_reg) {
      const mseCheck = await queryable.query(
        `SELECT EXISTS (
           SELECT 1 FROM minibar_stay_event WHERE property_id = $1 AND menu_item_id = $2
         ) AS used`,
        [propertyId, menuItemId]
      );
      if (mseCheck?.rows?.[0]?.used) hasInventoryOrMinibarUsage = true;
    }
    if (!hasInventoryOrMinibarUsage && optRow.mirl_reg) {
      const mirlCheck = await queryable.query(
        `SELECT EXISTS (
           SELECT 1 FROM minibar_inspection_report_line WHERE property_id = $1 AND menu_item_id = $2
         ) AS used`,
        [propertyId, menuItemId]
      );
      if (mirlCheck?.rows?.[0]?.used) hasInventoryOrMinibarUsage = true;
    }

    return {
      schemaReady: true,
      isLocked: activePackagingCount > 0 || hasInventoryOrMinibarUsage,
      activePackagingCount,
      hasInventoryOrMinibarUsage,
    };
  } catch (err: any) {
    if (err?.code === 'SCHEMA_NOT_READY' || err?.code === 'USAGE_CHECK_FAILED') {
      throw err;
    }
    const wrapped: any = new Error(
      `Gagal memeriksa keterpakai satuan dasar produk: ${err?.message || 'Unknown DB error'}`
    );
    wrapped.statusCode = 503;
    wrapped.code = 'USAGE_CHECK_FAILED';
    throw wrapped;
  }
}

export interface FormattedPackagingConversion {
  id: number;
  property_id: number;
  menu_item_id: number;
  packaging_code: string;
  packaging_label: string;
  base_unit_code: string;
  to_base_factor: string;
  is_default_purchase: boolean;
  is_active: boolean;
  idempotency_key: string;
  created_at?: any;
  updated_at?: any;
}

export function formatPackagingConversionRow(row: Record<string, any>): FormattedPackagingConversion {
  const rawFactor = row.to_base_factor !== undefined && row.to_base_factor !== null ? String(row.to_base_factor).trim() : '1.000';
  const parsedFactor = parseStrictDecimalString(rawFactor);
  const formattedFactor = parsedFactor.ok ? parsedFactor.formatted3 : rawFactor;

  return {
    id: Number(row.id),
    property_id: Number(row.property_id),
    menu_item_id: Number(row.menu_item_id),
    packaging_code: String(row.packaging_code || '').trim().toUpperCase(),
    packaging_label: String(row.packaging_label || '').trim(),
    base_unit_code: String(row.base_unit_code || '').trim().toUpperCase(),
    to_base_factor: formattedFactor,
    is_default_purchase: Boolean(row.is_default_purchase),
    is_active: row.is_active === undefined ? true : Boolean(row.is_active),
    idempotency_key: String(row.idempotency_key || '').trim(),
    ...(row.created_at !== undefined ? { created_at: row.created_at } : {}),
    ...(row.updated_at !== undefined ? { updated_at: row.updated_at } : {}),
  };
}

/**
 * Memuat peta kemasan per `menu_item_id` serta himpunan `menu_item_id` yang terkunci oleh referensi minibar
 * untuk suatu properti pada `GET /api/pos/menu`.
 * Jika tabel `product_packaging_conversions` belum ada (`to_regclass === null`), mengembalikan
 * `schemaReady: false` dan peta kosong agar kasir POS tetap berfungsi.
 * Namun jika query pada tabel yang sudah ada gagal, melempar error DB (`USAGE_CHECK_FAILED` HTTP 503) dan tidak ditelan.
 */
export async function fetchPropertyPackagingsByItem(
  queryable: { query: (sql: string, params?: any[]) => Promise<any> },
  propertyId: number
): Promise<{
  schemaReady: boolean;
  byItemId: Map<number, FormattedPackagingConversion[]>;
  lockedByMinibarItemIds: Set<number>;
}> {
  let pkgReg: string | null = null;
  try {
    const regRes = await queryable.query(
      `SELECT to_regclass('public.product_packaging_conversions') AS pkg_reg`
    );
    pkgReg = regRes?.rows?.[0]?.pkg_reg ?? null;
  } catch (err: any) {
    const wrapped: any = new Error(
      `Gagal memeriksa kesiapan schema satuan/kemasan: ${err?.message || 'Unknown DB error'}`
    );
    wrapped.statusCode = 503;
    wrapped.code = 'USAGE_CHECK_FAILED';
    throw wrapped;
  }

  const byItemId = new Map<number, FormattedPackagingConversion[]>();
  const lockedByMinibarItemIds = new Set<number>();

  if (!pkgReg) {
    return { schemaReady: false, byItemId, lockedByMinibarItemIds };
  }

  try {
    const pkgRes = await queryable.query(
      `SELECT id, property_id, menu_item_id, packaging_code, packaging_label,
              base_unit_code, to_base_factor::text AS to_base_factor,
              is_default_purchase, is_active, idempotency_key, created_at, updated_at
         FROM product_packaging_conversions
        WHERE property_id = $1
        ORDER BY is_active DESC, packaging_code ASC, id ASC`,
      [propertyId]
    );

    for (const row of pkgRes?.rows || []) {
      const formatted = formatPackagingConversionRow(row);
      const list = byItemId.get(formatted.menu_item_id) || [];
      list.push(formatted);
      byItemId.set(formatted.menu_item_id, list);
    }

    const optRegRes = await queryable.query(
      `SELECT to_regclass('public.room_type_minibar_standard') AS rtms_reg,
              to_regclass('public.minibar_baseline_verification') AS mbv_reg,
              to_regclass('public.minibar_stay_event') AS mse_reg,
              to_regclass('public.minibar_inspection_report_line') AS mirl_reg`
    );
    const optRow = optRegRes?.rows?.[0] || {};
    const minibarTables: Array<{ reg: any; table: string }> = [
      { reg: optRow.rtms_reg, table: 'room_type_minibar_standard' },
      { reg: optRow.mbv_reg, table: 'minibar_baseline_verification' },
      { reg: optRow.mse_reg, table: 'minibar_stay_event' },
      { reg: optRow.mirl_reg, table: 'minibar_inspection_report_line' },
    ];

    for (const entry of minibarTables) {
      if (entry.reg) {
        const usedRes = await queryable.query(
          `SELECT DISTINCT menu_item_id
             FROM ${entry.table}
            WHERE property_id = $1
              AND menu_item_id IS NOT NULL`,
          [propertyId]
        );
        for (const r of usedRes?.rows || []) {
          const idNum = Number(r.menu_item_id);
          if (Number.isInteger(idNum) && idNum > 0) {
            lockedByMinibarItemIds.add(idNum);
          }
        }
      }
    }

    return { schemaReady: true, byItemId, lockedByMinibarItemIds };
  } catch (err: any) {
    if (err?.code === 'USAGE_CHECK_FAILED' || err?.code === 'SCHEMA_NOT_READY') {
      throw err;
    }
    const wrapped: any = new Error(
      `Gagal memeriksa keterpakai satuan dasar produk: ${err?.message || 'Unknown DB error'}`
    );
    wrapped.statusCode = 503;
    wrapped.code = 'USAGE_CHECK_FAILED';
    throw wrapped;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Validasi & Handler Kemasan Produk (`/api/pos/menu/items/:id/packagings`)
// ─────────────────────────────────────────────────────────────────────────────

const PACKAGING_CODE_REGEX = /^[A-Z0-9][A-Z0-9_-]{0,29}$/;
const PACKAGING_BLOCKED_CHARS = /[\r\n\t\0]/;

export function parseIdempotencyKeyInput(
  raw: unknown
): { ok: true; value: string } | { ok: false; status: number; code: string; error: string } {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      status: 400,
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      error: 'idempotency_key wajib disertakan sebagai teks non-kosong (1–150 karakter)',
    };
  }
  if (PACKAGING_BLOCKED_CHARS.test(raw)) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: 'idempotency_key tidak boleh mengandung karakter kontrol, tab, atau baris baru',
    };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      ok: false,
      status: 400,
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      error: 'idempotency_key wajib disertakan dan tidak boleh kosong',
    };
  }
  if (trimmed.length > 150) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: 'idempotency_key maksimal 150 karakter setelah trim',
    };
  }
  return { ok: true, value: trimmed };
}

export function parseRequiredBaseUnitCodeInput(
  raw: unknown
): { ok: true; unit: CanonicalUnitDefinition } | { ok: false; status: number; code: string; error: string } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return {
      ok: false,
      status: 400,
      code: 'BASE_UNIT_CODE_REQUIRED',
      error: 'base_unit_code wajib disertakan dari snapshot satuan dasar produk saat mengisi form kemasan',
    };
  }
  const unit = getCanonicalUnitByCode(raw);
  if (!unit) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_CANONICAL_BASE_UNIT',
      error: `base_unit_code "${raw.trim()}" tidak terdaftar dalam katalog satuan kanonik`,
    };
  }
  return { ok: true, unit };
}

export function parsePackagingCodeInput(
  raw: unknown
): { ok: true; value: string } | { ok: false; status: number; code: string; error: string } {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: 'Kode kemasan (packaging_code) wajib berupa teks',
    };
  }
  const normalized = raw.trim().toUpperCase();
  if (!normalized) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: 'Kode kemasan (packaging_code) wajib diisi',
    };
  }
  if (!PACKAGING_CODE_REGEX.test(normalized)) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: 'Kode kemasan (packaging_code) hanya boleh berisi huruf/angka/strip/garis bawah (1–30 karakter, diawali huruf/angka)',
    };
  }
  return { ok: true, value: normalized };
}

export function parsePackagingLabelInput(
  raw: unknown
): { ok: true; value: string } | { ok: false; status: number; code: string; error: string } {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: 'Nama kemasan (packaging_label) wajib berupa teks',
    };
  }
  if (PACKAGING_BLOCKED_CHARS.test(raw)) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: 'Nama kemasan (packaging_label) tidak boleh mengandung karakter kontrol, tab, atau baris baru',
    };
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 60) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: 'Nama kemasan (packaging_label) wajib diisi (1–60 karakter)',
    };
  }
  return { ok: true, value: trimmed };
}

export interface ProductMasterMp03cDeps {
  pool: {
    query: (sql: string, params?: any[]) => Promise<any>;
    connect?: () => Promise<{
      query: (sql: string, params?: any[]) => Promise<any>;
      release: () => void;
    }>;
  };
  assertPropertyScope:
    | ((req: any, propertyId: number) => Promise<void>)
    | ((req: any, res: any, propertyId: number) => Promise<void>);
}

async function invokeAssertPropertyScope(
  fn: ProductMasterMp03cDeps['assertPropertyScope'],
  req: any,
  res: any,
  propertyId: number
): Promise<void> {
  if (fn.length >= 3) {
    await (fn as (req: any, res: any, propertyId: number) => Promise<void>)(req, res, propertyId);
  } else {
    await (fn as (req: any, propertyId: number) => Promise<void>)(req, propertyId);
  }
}

async function acquireTransactionalClient(pool: ProductMasterMp03cDeps['pool']) {
  if (typeof pool.connect === 'function') {
    const client = await pool.connect();
    return {
      client,
      isDedicatedClient: true,
    };
  }
  return {
    client: pool,
    isDedicatedClient: false,
  };
}

export interface PackagingCreatePayloadSnapshot {
  packaging_code: string;
  packaging_label: string;
  base_unit_code: string;
  to_base_factor: string;
  is_default_purchase: boolean;
}

export function buildPackagingCreatePayloadSnapshot(
  input: PackagingCreatePayloadSnapshot
): PackagingCreatePayloadSnapshot {
  const parsedFactor = parseStrictDecimalString(input.to_base_factor);
  return {
    packaging_code: String(input.packaging_code || '').trim().toUpperCase(),
    packaging_label: String(input.packaging_label || '').trim(),
    base_unit_code: String(input.base_unit_code || '').trim().toUpperCase(),
    to_base_factor: parsedFactor.ok ? parsedFactor.formatted3 : String(input.to_base_factor || '').trim(),
    is_default_purchase: Boolean(input.is_default_purchase),
  };
}

export function computePackagingCreatePayloadHash(
  snapshot: PackagingCreatePayloadSnapshot
): string {
  const canonical = JSON.stringify({
    packaging_code: String(snapshot.packaging_code || '').trim().toUpperCase(),
    packaging_label: String(snapshot.packaging_label || '').trim().toLowerCase(),
    base_unit_code: String(snapshot.base_unit_code || '').trim().toUpperCase(),
    to_base_factor: String(snapshot.to_base_factor || '').trim(),
    is_default_purchase: Boolean(snapshot.is_default_purchase),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function createProductPackagingListHandler(deps: ProductMasterMp03cDeps) {
  return async function handleProductPackagingList(req: Request, res: Response) {
    try {
      const itemId = Number(req.params.id);
      const propertyId = Number(req.query.property_id ?? req.body?.property_id);

      if (!Number.isInteger(itemId) || itemId <= 0 || !Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'id produk dan property_id wajib berupa bilangan bulat positif',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const itemCheck = await deps.pool.query(
        `SELECT id, property_id, name, base_unit, canonical_base_unit_code
           FROM pos_menu_items
          WHERE id = $1 AND property_id = $2`,
        [itemId, propertyId]
      );
      if (itemCheck.rowCount === 0) {
        return res.status(404).json({
          status: 'ERROR',
          code: 'NOT_FOUND',
          message: 'Produk tidak ditemukan pada properti ini',
        });
      }

      const lockRes = await checkProductBaseUnitLockStatus(deps.pool, propertyId, itemId, {
        forMutation: false,
      });

      const pkgRes = await deps.pool.query(
        `SELECT id, property_id, menu_item_id, packaging_code, packaging_label,
                base_unit_code, to_base_factor::text AS to_base_factor,
                is_default_purchase, is_active, idempotency_key, created_at, updated_at
           FROM product_packaging_conversions
          WHERE property_id = $1 AND menu_item_id = $2
          ORDER BY is_active DESC, packaging_code ASC, id ASC`,
        [propertyId, itemId]
      );

      const itemRow = itemCheck.rows[0];
      return res.json({
        status: 'OK',
        data: {
          menu_item_id: Number(itemRow.id),
          property_id: Number(itemRow.property_id),
          canonical_base_unit_code: itemRow.canonical_base_unit_code ?? null,
          base_unit: itemRow.base_unit ?? null,
          is_base_unit_locked: lockRes.isLocked,
          packagings: (pkgRes.rows || []).map(formatPackagingConversionRow),
        },
      });
    } catch (error: any) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      return res.status(status).json({
        status: 'ERROR',
        code: error?.code || 'INTERNAL_ERROR',
        message: error?.message || 'Gagal memuat daftar kemasan produk',
      });
    }
  };
}

export function createProductPackagingCreateHandler(deps: ProductMasterMp03cDeps) {
  return async function handleProductPackagingCreate(req: Request, res: Response) {
    const itemId = Number(req.params.id);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const propertyId = Number(body.property_id ?? req.query?.property_id);

    if (!Number.isInteger(itemId) || itemId <= 0 || !Number.isInteger(propertyId) || propertyId <= 0) {
      return res.status(400).json({
        status: 'ERROR',
        code: 'VALIDATION_ERROR',
        message: 'id produk dan property_id wajib berupa bilangan bulat positif',
      });
    }

    // 1. Validasi idempotency_key (wajib)
    const idemParsed = parseIdempotencyKeyInput(body.idempotency_key);
    if (!idemParsed.ok) {
      return res.status(idemParsed.status).json({
        status: 'ERROR',
        code: idemParsed.code,
        message: idemParsed.error,
      });
    }

    // 2. Validasi base_unit_code (wajib dari snapshot form UI)
    const baseUnitParsed = parseRequiredBaseUnitCodeInput(body.base_unit_code);
    if (!baseUnitParsed.ok) {
      return res.status(baseUnitParsed.status).json({
        status: 'ERROR',
        code: baseUnitParsed.code,
        message: baseUnitParsed.error,
      });
    }

    // 3. Validasi packaging_code & packaging_label
    const codeParsed = parsePackagingCodeInput(body.packaging_code);
    if (!codeParsed.ok) {
      return res.status(codeParsed.status).json({
        status: 'ERROR',
        code: codeParsed.code,
        message: codeParsed.error,
      });
    }

    const labelParsed = parsePackagingLabelInput(body.packaging_label);
    if (!labelParsed.ok) {
      return res.status(labelParsed.status).json({
        status: 'ERROR',
        code: labelParsed.code,
        message: labelParsed.error,
      });
    }

    // 4. Validasi to_base_factor (wajib string desimal)
    const factorParsed = parsePackagingFactorInput(body.to_base_factor, baseUnitParsed.unit.code);
    if (!factorParsed.ok) {
      return res.status(factorParsed.status).json({
        status: 'ERROR',
        code: factorParsed.code,
        message: factorParsed.error,
      });
    }

    // 5. Validasi is_default_purchase
    let isDefaultPurchase = false;
    if (body.is_default_purchase !== undefined) {
      if (typeof body.is_default_purchase !== 'boolean') {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'is_default_purchase harus bertipe boolean',
        });
      }
      isDefaultPurchase = body.is_default_purchase;
    }

    try {
      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const { client, isDedicatedClient } = await acquireTransactionalClient(deps.pool);
      try {
        if (isDedicatedClient) await client.query('BEGIN');

        // Kunci baris produk untuk serialisasi terhadap perubahan satuan dasar atau pembuatan kemasan konkuren
        const itemRes = await client.query(
          `SELECT id, property_id, base_unit, canonical_base_unit_code
             FROM pos_menu_items
            WHERE id = $1 AND property_id = $2
            FOR UPDATE`,
          [itemId, propertyId]
        );

        if (itemRes.rowCount === 0) {
          if (isDedicatedClient) await client.query('ROLLBACK');
          return res.status(404).json({
            status: 'ERROR',
            code: 'NOT_FOUND',
            message: 'Produk tidak ditemukan pada properti ini',
          });
        }

        // Bangun snapshot & hash immutable dari payload penciptaan pada request ini
        const reqCreateSnapshot = buildPackagingCreatePayloadSnapshot({
          packaging_code: codeParsed.value,
          packaging_label: labelParsed.value,
          base_unit_code: baseUnitParsed.unit.code,
          to_base_factor: factorParsed.formatted3,
          is_default_purchase: isDefaultPurchase,
        });
        const reqCreateHash = computePackagingCreatePayloadHash(reqCreateSnapshot);

        // Langkah 1-3: Cek idempotency_key pada (property_id, menu_item_id, BTRIM(idempotency_key))
        const existingIdemRes = await client.query(
          `SELECT id, property_id, menu_item_id, packaging_code, packaging_label,
                  base_unit_code, to_base_factor::text AS to_base_factor,
                  is_default_purchase, is_active, idempotency_key,
                  create_payload_hash, create_payload_snapshot,
                  created_at, updated_at
             FROM product_packaging_conversions
            WHERE property_id = $1
              AND menu_item_id = $2
              AND BTRIM(idempotency_key) = $3`,
          [propertyId, itemId, idemParsed.value]
        );

        if (existingIdemRes.rowCount > 0) {
          const rawExisting = existingIdemRes.rows[0];
          const existingRow = formatPackagingConversionRow(rawExisting);

          // Bandingkan terhadap snapshot/hash penciptaan yang immutable, terpisah dari kolom kemasan yang dapat diedit
          let storedCreateHash: string | null =
            typeof rawExisting.create_payload_hash === 'string' && rawExisting.create_payload_hash.trim() !== ''
              ? rawExisting.create_payload_hash.trim()
              : null;

          if (!storedCreateHash && rawExisting.create_payload_snapshot) {
            const snapObj =
              typeof rawExisting.create_payload_snapshot === 'string'
                ? JSON.parse(rawExisting.create_payload_snapshot)
                : rawExisting.create_payload_snapshot;
            if (snapObj && typeof snapObj === 'object') {
              storedCreateHash = computePackagingCreatePayloadHash(
                buildPackagingCreatePayloadSnapshot(snapObj as PackagingCreatePayloadSnapshot)
              );
            }
          }

          let isIdenticalCreationPayload = false;
          if (storedCreateHash) {
            isIdenticalCreationPayload = storedCreateHash === reqCreateHash;
          } else {
            // Fallback hanya bila baris lama belum memiliki kolom snapshot/hash
            isIdenticalCreationPayload =
              existingRow.packaging_code.toUpperCase() === codeParsed.value.toUpperCase() &&
              existingRow.packaging_label.toLowerCase() === labelParsed.value.toLowerCase() &&
              existingRow.base_unit_code.toUpperCase() === baseUnitParsed.unit.code.toUpperCase() &&
              existingRow.to_base_factor === factorParsed.formatted3 &&
              existingRow.is_default_purchase === isDefaultPurchase;
          }

          if (!isIdenticalCreationPayload) {
            if (isDedicatedClient) await client.query('ROLLBACK');
            return res.status(409).json({
              status: 'ERROR',
              code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
              message: 'idempotency_key sudah pernah digunakan dengan isi payload penciptaan kemasan yang berbeda',
            });
          }

          // Replay idempotent: kembalikan ID yang sama tanpa mengubah atau menerapkan ulang perubahan pada baris yang sudah diedit
          if (isDedicatedClient) await client.query('COMMIT');
          return res.status(200).json({
            status: 'OK',
            replayed: true,
            data: existingRow,
          });
        }

        // Langkah 4: Verifikasi canonical_base_unit_code produk saat ini setelah lock
        const itemRow = itemRes.rows[0];
        const currentCanonicalCode =
          typeof itemRow.canonical_base_unit_code === 'string' && itemRow.canonical_base_unit_code.trim() !== ''
            ? itemRow.canonical_base_unit_code.trim().toUpperCase()
            : null;

        if (!currentCanonicalCode) {
          if (isDedicatedClient) await client.query('ROLLBACK');
          return res.status(409).json({
            status: 'ERROR',
            code: 'BASE_UNIT_NOT_CANONICAL',
            message: 'Produk belum memiliki satuan dasar kanonik. Tetapkan satuan dasar kanonik terlebih dahulu sebelum menambah kemasan.',
          });
        }

        if (baseUnitParsed.unit.code !== currentCanonicalCode) {
          if (isDedicatedClient) await client.query('ROLLBACK');
          return res.status(409).json({
            status: 'ERROR',
            code: 'PACKAGING_BASE_UNIT_MISMATCH',
            message: `Satuan dasar pada form kemasan (${baseUnitParsed.unit.code}) tidak cocok dengan satuan dasar produk saat ini (${currentCanonicalCode}). Muat ulang data produk sebelum menyimpan kemasan.`,
          });
        }

        if (codeParsed.value === currentCanonicalCode) {
          if (isDedicatedClient) await client.query('ROLLBACK');
          return res.status(400).json({
            status: 'ERROR',
            code: 'VALIDATION_ERROR',
            message: `Kode kemasan (${codeParsed.value}) tidak boleh sama dengan kode satuan dasar produk (${currentCanonicalCode})`,
          });
        }

        // Cek duplikasi packaging_code & packaging_label pada produk ini
        const dupCodeRes = await client.query(
          `SELECT id FROM product_packaging_conversions
            WHERE property_id = $1
              AND menu_item_id = $2
              AND UPPER(BTRIM(packaging_code)) = $3`,
          [propertyId, itemId, codeParsed.value]
        );
        if (dupCodeRes.rowCount > 0) {
          if (isDedicatedClient) await client.query('ROLLBACK');
          return res.status(409).json({
            status: 'ERROR',
            code: 'PACKAGING_CODE_DUPLICATE',
            message: `Kode kemasan "${codeParsed.value}" sudah digunakan pada produk ini`,
          });
        }

        const dupLabelRes = await client.query(
          `SELECT id FROM product_packaging_conversions
            WHERE property_id = $1
              AND menu_item_id = $2
              AND LOWER(BTRIM(packaging_label)) = LOWER($3)`,
          [propertyId, itemId, labelParsed.value]
        );
        if (dupLabelRes.rowCount > 0) {
          if (isDedicatedClient) await client.query('ROLLBACK');
          return res.status(409).json({
            status: 'ERROR',
            code: 'PACKAGING_LABEL_DUPLICATE',
            message: `Nama kemasan "${labelParsed.value}" sudah digunakan pada produk ini`,
          });
        }

        // Jika is_default_purchase === true, lepas flag default lama secara atomik
        if (isDefaultPurchase) {
          await client.query(
            `UPDATE product_packaging_conversions
                SET is_default_purchase = FALSE, updated_at = NOW()
              WHERE property_id = $1
                AND menu_item_id = $2
                AND is_default_purchase = TRUE`,
            [propertyId, itemId]
          );
        }

        const insertRes = await client.query(
          `INSERT INTO product_packaging_conversions (
             property_id, menu_item_id, packaging_code, packaging_label,
             base_unit_code, to_base_factor, is_default_purchase, is_active, idempotency_key,
             create_payload_hash, create_payload_snapshot
           )
           VALUES ($1, $2, $3, $4, $5, $6::numeric(12,3), $7, TRUE, $8, $9, $10::jsonb)
           RETURNING id, property_id, menu_item_id, packaging_code, packaging_label,
                     base_unit_code, to_base_factor::text AS to_base_factor,
                     is_default_purchase, is_active, idempotency_key,
                     create_payload_hash, create_payload_snapshot,
                     created_at, updated_at`,
          [
            propertyId,
            itemId,
            codeParsed.value,
            labelParsed.value,
            baseUnitParsed.unit.code,
            factorParsed.formatted3,
            isDefaultPurchase,
            idemParsed.value,
            reqCreateHash,
            JSON.stringify(reqCreateSnapshot),
          ]
        );

        if (isDedicatedClient) await client.query('COMMIT');
        return res.status(201).json({
          status: 'OK',
          replayed: false,
          data: formatPackagingConversionRow(insertRes.rows[0]),
        });
      } catch (dbErr: any) {
        if (isDedicatedClient) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // ignore rollback error
          }
        }
        if (dbErr?.code === '23505') {
          const constraint = String(dbErr?.constraint || '');
          if (constraint.includes('uq_ppc_item_packaging_code')) {
            return res.status(409).json({
              status: 'ERROR',
              code: 'PACKAGING_CODE_DUPLICATE',
              message: `Kode kemasan "${codeParsed.value}" sudah digunakan pada produk ini`,
            });
          }
          if (constraint.includes('uq_ppc_item_packaging_label')) {
            return res.status(409).json({
              status: 'ERROR',
              code: 'PACKAGING_LABEL_DUPLICATE',
              message: `Nama kemasan "${labelParsed.value}" sudah digunakan pada produk ini`,
            });
          }
        }
        throw dbErr;
      } finally {
        if (isDedicatedClient && typeof (client as any).release === 'function') {
          (client as any).release();
        }
      }
    } catch (error: any) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      return res.status(status).json({
        status: 'ERROR',
        code: error?.code || 'INTERNAL_ERROR',
        message: error?.message || 'Gagal menambahkan kemasan produk',
      });
    }
  };
}

export function createProductPackagingPatchHandler(deps: ProductMasterMp03cDeps) {
  return async function handleProductPackagingPatch(req: Request, res: Response) {
    const itemId = Number(req.params.id);
    const packagingId = Number(req.params.packagingId);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const propertyId = Number(body.property_id ?? req.query?.property_id);

    if (
      !Number.isInteger(itemId) ||
      itemId <= 0 ||
      !Number.isInteger(packagingId) ||
      packagingId <= 0 ||
      !Number.isInteger(propertyId) ||
      propertyId <= 0
    ) {
      return res.status(400).json({
        status: 'ERROR',
        code: 'VALIDATION_ERROR',
        message: 'id produk, packagingId, dan property_id wajib berupa bilangan bulat positif',
      });
    }

    // Immutability guard: base_unit_code, idempotency_key, & snapshot penciptaan tidak boleh diubah melalui PATCH
    if (Object.prototype.hasOwnProperty.call(body, 'base_unit_code')) {
      return res.status(400).json({
        status: 'ERROR',
        code: 'IMMUTABLE_PACKAGING_BASE_UNIT',
        message: 'base_unit_code pada kemasan bersifat tetap (immutable) dan tidak dapat diubah melalui PATCH',
      });
    }
    if (Object.prototype.hasOwnProperty.call(body, 'idempotency_key')) {
      return res.status(400).json({
        status: 'ERROR',
        code: 'IMMUTABLE_IDEMPOTENCY_KEY',
        message: 'idempotency_key pada kemasan bersifat tetap (immutable) dan tidak dapat diubah melalui PATCH',
      });
    }
    if (
      Object.prototype.hasOwnProperty.call(body, 'create_payload_hash') ||
      Object.prototype.hasOwnProperty.call(body, 'create_payload_snapshot')
    ) {
      return res.status(400).json({
        status: 'ERROR',
        code: 'IMMUTABLE_CREATE_PAYLOAD_SNAPSHOT',
        message: 'Snapshot penciptaan kemasan bersifat tetap (immutable) dan tidak dapat diubah melalui PATCH',
      });
    }

    try {
      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const { client, isDedicatedClient } = await acquireTransactionalClient(deps.pool);
      try {
        if (isDedicatedClient) await client.query('BEGIN');

        // Kunci produk induk terlebih dahulu untuk urutan lock deterministik
        const itemRes = await client.query(
          `SELECT id, property_id, base_unit, canonical_base_unit_code
             FROM pos_menu_items
            WHERE id = $1 AND property_id = $2
            FOR UPDATE`,
          [itemId, propertyId]
        );
        if (itemRes.rowCount === 0) {
          if (isDedicatedClient) await client.query('ROLLBACK');
          return res.status(404).json({
            status: 'ERROR',
            code: 'NOT_FOUND',
            message: 'Produk tidak ditemukan pada properti ini',
          });
        }

        const pkgRes = await client.query(
          `SELECT id, property_id, menu_item_id, packaging_code, packaging_label,
                  base_unit_code, to_base_factor::text AS to_base_factor,
                  is_default_purchase, is_active, idempotency_key, created_at, updated_at
             FROM product_packaging_conversions
            WHERE id = $1 AND menu_item_id = $2 AND property_id = $3
            FOR UPDATE`,
          [packagingId, itemId, propertyId]
        );
        if (pkgRes.rowCount === 0) {
          if (isDedicatedClient) await client.query('ROLLBACK');
          return res.status(404).json({
            status: 'ERROR',
            code: 'NOT_FOUND',
            message: 'Kemasan produk tidak ditemukan',
          });
        }

        const existingPkg = formatPackagingConversionRow(pkgRes.rows[0]);
        const itemRow = itemRes.rows[0];
        const currentCanonicalCode =
          typeof itemRow.canonical_base_unit_code === 'string' && itemRow.canonical_base_unit_code.trim() !== ''
            ? itemRow.canonical_base_unit_code.trim().toUpperCase()
            : null;

        let nextCode = existingPkg.packaging_code;
        if (Object.prototype.hasOwnProperty.call(body, 'packaging_code')) {
          const parsed = parsePackagingCodeInput(body.packaging_code);
          if (!parsed.ok) {
            if (isDedicatedClient) await client.query('ROLLBACK');
            return res.status(parsed.status).json({ status: 'ERROR', code: parsed.code, message: parsed.error });
          }
          nextCode = parsed.value;
        }

        let nextLabel = existingPkg.packaging_label;
        if (Object.prototype.hasOwnProperty.call(body, 'packaging_label')) {
          const parsed = parsePackagingLabelInput(body.packaging_label);
          if (!parsed.ok) {
            if (isDedicatedClient) await client.query('ROLLBACK');
            return res.status(parsed.status).json({ status: 'ERROR', code: parsed.code, message: parsed.error });
          }
          nextLabel = parsed.value;
        }

        let nextFactor = existingPkg.to_base_factor;
        const isFactorProvided = Object.prototype.hasOwnProperty.call(body, 'to_base_factor');
        if (isFactorProvided) {
          const parsed = parsePackagingFactorInput(body.to_base_factor, existingPkg.base_unit_code);
          if (!parsed.ok) {
            if (isDedicatedClient) await client.query('ROLLBACK');
            return res.status(parsed.status).json({ status: 'ERROR', code: parsed.code, message: parsed.error });
          }
          nextFactor = parsed.formatted3;
        }

        let nextIsActive = existingPkg.is_active;
        if (Object.prototype.hasOwnProperty.call(body, 'is_active')) {
          if (typeof body.is_active !== 'boolean') {
            if (isDedicatedClient) await client.query('ROLLBACK');
            return res.status(400).json({
              status: 'ERROR',
              code: 'VALIDATION_ERROR',
              message: 'is_active harus bertipe boolean',
            });
          }
          nextIsActive = body.is_active;
        }

        let nextIsDefaultPurchase = existingPkg.is_default_purchase;
        if (Object.prototype.hasOwnProperty.call(body, 'is_default_purchase')) {
          if (typeof body.is_default_purchase !== 'boolean') {
            if (isDedicatedClient) await client.query('ROLLBACK');
            return res.status(400).json({
              status: 'ERROR',
              code: 'VALIDATION_ERROR',
              message: 'is_default_purchase harus bertipe boolean',
            });
          }
          nextIsDefaultPurchase = body.is_default_purchase;
        }

        // Jika kemasan dinonaktifkan, otomatis lepaskan status default pembelian
        if (!nextIsActive) {
          if (body.is_default_purchase === true && body.is_active !== false) {
            if (isDedicatedClient) await client.query('ROLLBACK');
            return res.status(400).json({
              status: 'ERROR',
              code: 'VALIDATION_ERROR',
              message: 'Kemasan nonaktif tidak dapat ditetapkan sebagai kemasan beli default',
            });
          }
          nextIsDefaultPurchase = false;
        }

        // Larangan reaktivasi atau modifikasi operasional bila base_unit_code kemasan != canonical_base_unit_code produk
        const isReactivating = !existingPkg.is_active && nextIsActive;
        const isFactorChanging = isFactorProvided && nextFactor !== existingPkg.to_base_factor;
        if (isReactivating || isFactorChanging || nextIsActive) {
          if (!currentCanonicalCode) {
            if (isDedicatedClient) await client.query('ROLLBACK');
            return res.status(409).json({
              status: 'ERROR',
              code: 'BASE_UNIT_NOT_CANONICAL',
              message: 'Produk tidak lagi memiliki satuan dasar kanonik sehingga kemasan tidak dapat diaktifkan atau diubah',
            });
          }
          if (existingPkg.base_unit_code !== currentCanonicalCode) {
            if (isDedicatedClient) await client.query('ROLLBACK');
            return res.status(409).json({
              status: 'ERROR',
              code: 'PACKAGING_BASE_UNIT_MISMATCH',
              message: `Kemasan ini terikat pada satuan dasar "${existingPkg.base_unit_code}", sedangkan satuan dasar produk saat ini adalah "${currentCanonicalCode}". Kemasan lama tidak dapat diaktifkan kembali atau diubah faktornya.`,
            });
          }
        }

        if (currentCanonicalCode && nextCode === currentCanonicalCode) {
          if (isDedicatedClient) await client.query('ROLLBACK');
          return res.status(400).json({
            status: 'ERROR',
            code: 'VALIDATION_ERROR',
            message: `Kode kemasan (${nextCode}) tidak boleh sama dengan kode satuan dasar produk (${currentCanonicalCode})`,
          });
        }

        // Cek duplikasi packaging_code & packaging_label terhadap baris lain
        const dupCodeRes = await client.query(
          `SELECT id FROM product_packaging_conversions
            WHERE property_id = $1
              AND menu_item_id = $2
              AND UPPER(BTRIM(packaging_code)) = $3
              AND id <> $4`,
          [propertyId, itemId, nextCode, packagingId]
        );
        if (dupCodeRes.rowCount > 0) {
          if (isDedicatedClient) await client.query('ROLLBACK');
          return res.status(409).json({
            status: 'ERROR',
            code: 'PACKAGING_CODE_DUPLICATE',
            message: `Kode kemasan "${nextCode}" sudah digunakan pada produk ini`,
          });
        }

        const dupLabelRes = await client.query(
          `SELECT id FROM product_packaging_conversions
            WHERE property_id = $1
              AND menu_item_id = $2
              AND LOWER(BTRIM(packaging_label)) = LOWER($3)
              AND id <> $4`,
          [propertyId, itemId, nextLabel, packagingId]
        );
        if (dupLabelRes.rowCount > 0) {
          if (isDedicatedClient) await client.query('ROLLBACK');
          return res.status(409).json({
            status: 'ERROR',
            code: 'PACKAGING_LABEL_DUPLICATE',
            message: `Nama kemasan "${nextLabel}" sudah digunakan pada produk ini`,
          });
        }

        if (nextIsDefaultPurchase) {
          await client.query(
            `UPDATE product_packaging_conversions
                SET is_default_purchase = FALSE, updated_at = NOW()
              WHERE property_id = $1
                AND menu_item_id = $2
                AND is_default_purchase = TRUE
                AND id <> $3`,
            [propertyId, itemId, packagingId]
          );
        }

        const updateRes = await client.query(
          `UPDATE product_packaging_conversions
              SET packaging_code = $1,
                  packaging_label = $2,
                  to_base_factor = $3::numeric(12,3),
                  is_default_purchase = $4,
                  is_active = $5,
                  updated_at = NOW()
            WHERE id = $6 AND menu_item_id = $7 AND property_id = $8
            RETURNING id, property_id, menu_item_id, packaging_code, packaging_label,
                      base_unit_code, to_base_factor::text AS to_base_factor,
                      is_default_purchase, is_active, idempotency_key, created_at, updated_at`,
          [
            nextCode,
            nextLabel,
            nextFactor,
            nextIsDefaultPurchase,
            nextIsActive,
            packagingId,
            itemId,
            propertyId,
          ]
        );

        if (isDedicatedClient) await client.query('COMMIT');
        return res.json({
          status: 'OK',
          data: formatPackagingConversionRow(updateRes.rows[0]),
        });
      } catch (dbErr: any) {
        if (isDedicatedClient) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // ignore
          }
        }
        throw dbErr;
      } finally {
        if (isDedicatedClient && typeof (client as any).release === 'function') {
          (client as any).release();
        }
      }
    } catch (error: any) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      return res.status(status).json({
        status: 'ERROR',
        code: error?.code || 'INTERNAL_ERROR',
        message: error?.message || 'Gagal memperbarui kemasan produk',
      });
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Lokasi Stok (`stock_locations`) & Kandidat Kamar (`room-candidates`)
// ─────────────────────────────────────────────────────────────────────────────

export const STOCK_LOCATION_TYPES = [
  'WAREHOUSE',
  'KITCHEN',
  'POS_OUTLET',
  'HK_PANTRY',
  'ROOM_MINIBAR',
] as const;

export type StockLocationType = (typeof STOCK_LOCATION_TYPES)[number];

const LOCATION_CODE_REGEX = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;

export function parseStockLocationCodeInput(
  raw: unknown
): { ok: true; value: string } | { ok: false; status: number; code: string; error: string } {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: 'Kode lokasi stok (code) wajib berupa teks',
    };
  }
  const normalized = raw.trim().toUpperCase();
  if (!LOCATION_CODE_REGEX.test(normalized)) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: 'Kode lokasi stok (code) wajib 2–40 karakter (huruf besar, angka, strip, atau garis bawah, diawali huruf/angka)',
    };
  }
  return { ok: true, value: normalized };
}

export function parseStockLocationNameInput(
  raw: unknown
): { ok: true; value: string } | { ok: false; status: number; code: string; error: string } {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: 'Nama lokasi stok (name) wajib berupa teks',
    };
  }
  if (PACKAGING_BLOCKED_CHARS.test(raw)) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: 'Nama lokasi stok (name) tidak boleh mengandung karakter kontrol, tab, atau baris baru',
    };
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 100) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: 'Nama lokasi stok (name) wajib diisi (1–100 karakter)',
    };
  }
  return { ok: true, value: trimmed };
}

export function parseStockLocationTypeInput(
  raw: unknown
): { ok: true; value: StockLocationType } | { ok: false; status: number; code: string; error: string } {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: 'Tipe lokasi stok (location_type) wajib berupa teks',
    };
  }
  const normalized = raw.trim().toUpperCase();
  if (!STOCK_LOCATION_TYPES.includes(normalized as StockLocationType)) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: `Tipe lokasi stok "${normalized}" tidak valid. Gunakan salah satu dari: ${STOCK_LOCATION_TYPES.join(', ')}`,
    };
  }
  return { ok: true, value: normalized as StockLocationType };
}

export function formatStockLocationRow(row: Record<string, any>) {
  return {
    id: Number(row.id),
    property_id: Number(row.property_id),
    code: String(row.code || '').trim().toUpperCase(),
    name: String(row.name || '').trim(),
    location_type: String(row.location_type || '').trim().toUpperCase() as StockLocationType,
    room_id: row.room_id !== null && row.room_id !== undefined ? Number(row.room_id) : null,
    room_number: row.room_number !== undefined && row.room_number !== null ? String(row.room_number) : null,
    is_active: row.is_active === undefined ? true : Boolean(row.is_active),
    notes: row.notes !== undefined && row.notes !== null ? String(row.notes) : null,
    ...(row.created_at !== undefined ? { created_at: row.created_at } : {}),
    ...(row.updated_at !== undefined ? { updated_at: row.updated_at } : {}),
  };
}

export function createStockLocationRoomCandidatesHandler(deps: ProductMasterMp03cDeps) {
  return async function handleStockLocationRoomCandidates(req: Request, res: Response) {
    try {
      const propertyId = Number(req.query.property_id ?? req.body?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib berupa bilangan bulat positif',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const result = await deps.pool.query(
        `SELECT r.id AS room_id,
                r.room_number,
                r.room_type_id,
                COALESCE(rt.name, to_jsonb(r)->>'type') AS room_type_name,
                sl.id AS existing_stock_location_id,
                sl.code AS existing_stock_location_code,
                sl.is_active AS existing_stock_location_is_active
           FROM rooms r
           LEFT JOIN room_types rt
             ON rt.id = r.room_type_id
           LEFT JOIN stock_locations sl
             ON sl.property_id = r.property_id
            AND sl.room_id = r.id
            AND sl.location_type = 'ROOM_MINIBAR'
          WHERE r.property_id = $1
          ORDER BY r.room_number ASC, r.id ASC`,
        [propertyId]
      );

      return res.json({
        status: 'OK',
        data: {
          property_id: propertyId,
          rooms: (result.rows || []).map((r: any) => {
            const existingLocId =
              r.existing_stock_location_id !== null && r.existing_stock_location_id !== undefined
                ? Number(r.existing_stock_location_id)
                : null;
            const existingLocCode =
              r.existing_stock_location_code !== null && r.existing_stock_location_code !== undefined
                ? String(r.existing_stock_location_code)
                : r.existing_location_code !== null && r.existing_location_code !== undefined
                  ? String(r.existing_location_code)
                  : null;
            const existingLocActive =
              r.existing_stock_location_is_active !== null && r.existing_stock_location_is_active !== undefined
                ? Boolean(r.existing_stock_location_is_active)
                : r.existing_location_is_active !== null && r.existing_location_is_active !== undefined
                  ? Boolean(r.existing_location_is_active)
                  : null;

            return {
              room_id: Number(r.room_id),
              room_number: String(r.room_number || ''),
              room_type_id: r.room_type_id !== null && r.room_type_id !== undefined ? Number(r.room_type_id) : null,
              room_type_name: r.room_type_name !== null && r.room_type_name !== undefined ? String(r.room_type_name) : null,
              existing_stock_location_id: existingLocId,
              existing_stock_location_code: existingLocCode,
              existing_stock_location_is_active: existingLocActive,
              is_available_for_minibar: existingLocId === null,
              existing_location_id: existingLocId,
              existing_location_code: existingLocCode,
              existing_location_is_active: existingLocActive,
            };
          }),
        },
      });
    } catch (error: any) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      return res.status(status).json({
        status: 'ERROR',
        code: error?.code || 'INTERNAL_ERROR',
        message: error?.message || 'Gagal memuat daftar kandidat kamar untuk lokasi minibar',
      });
    }
  };
}

export function createStockLocationListHandler(deps: ProductMasterMp03cDeps) {
  return async function handleStockLocationList(req: Request, res: Response) {
    try {
      const propertyId = Number(req.query.property_id ?? req.body?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib berupa bilangan bulat positif',
        });
      }

      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const rawType = typeof req.query.location_type === 'string' ? req.query.location_type.trim() : '';
      let filterType: StockLocationType | null = null;
      if (rawType) {
        const parsedType = parseStockLocationTypeInput(rawType);
        if (!parsedType.ok) {
          return res.status(parsedType.status).json({
            status: 'ERROR',
            code: parsedType.code,
            message: parsedType.error,
          });
        }
        filterType = parsedType.value;
      }

      const includeInactive =
        req.query.include_inactive === 'true' ||
        req.query.include_inactive === '1' ||
        req.query.include_inactive === ('true' as any);

      const params: any[] = [propertyId];
      const whereClauses: string[] = ['sl.property_id = $1'];
      if (filterType) {
        params.push(filterType);
        whereClauses.push(`sl.location_type = $${params.length}`);
      }
      if (!includeInactive) {
        whereClauses.push('sl.is_active = TRUE');
      }

      const result = await deps.pool.query(
        `SELECT sl.id, sl.property_id, sl.code, sl.name, sl.location_type,
                sl.room_id, r.room_number, sl.is_active, sl.notes,
                sl.created_at, sl.updated_at
           FROM stock_locations sl
           LEFT JOIN rooms r
             ON r.id = sl.room_id AND r.property_id = sl.property_id
          WHERE ${whereClauses.join(' AND ')}
          ORDER BY sl.is_active DESC, sl.location_type ASC, sl.code ASC, sl.id ASC`,
        params
      );

      return res.json({
        status: 'OK',
        data: {
          property_id: propertyId,
          locations: (result.rows || []).map(formatStockLocationRow),
        },
      });
    } catch (error: any) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      return res.status(status).json({
        status: 'ERROR',
        code: error?.code || 'INTERNAL_ERROR',
        message: error?.message || 'Gagal memuat daftar lokasi stok',
      });
    }
  };
}

export function createStockLocationCreateHandler(deps: ProductMasterMp03cDeps) {
  return async function handleStockLocationCreate(req: Request, res: Response) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const propertyId = Number(body.property_id ?? req.query?.property_id);

    if (!Number.isInteger(propertyId) || propertyId <= 0) {
      return res.status(400).json({
        status: 'ERROR',
        code: 'VALIDATION_ERROR',
        message: 'property_id wajib berupa bilangan bulat positif',
      });
    }

    const codeParsed = parseStockLocationCodeInput(body.code);
    if (!codeParsed.ok) {
      return res.status(codeParsed.status).json({
        status: 'ERROR',
        code: codeParsed.code,
        message: codeParsed.error,
      });
    }

    const nameParsed = parseStockLocationNameInput(body.name);
    if (!nameParsed.ok) {
      return res.status(nameParsed.status).json({
        status: 'ERROR',
        code: nameParsed.code,
        message: nameParsed.error,
      });
    }

    const typeParsed = parseStockLocationTypeInput(body.location_type);
    if (!typeParsed.ok) {
      return res.status(typeParsed.status).json({
        status: 'ERROR',
        code: typeParsed.code,
        message: typeParsed.error,
      });
    }

    const hasRoomId =
      body.room_id !== undefined && body.room_id !== null && String(body.room_id).trim() !== '';
    let roomId: number | null = null;

    if (typeParsed.value === 'ROOM_MINIBAR') {
      if (!hasRoomId) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'ROOM_ID_REQUIRED_FOR_MINIBAR',
          message: 'Lokasi bertipe ROOM_MINIBAR wajib menyertakan room_id yang valid',
        });
      }
      const parsedRoomId = Number(body.room_id);
      if (!Number.isInteger(parsedRoomId) || parsedRoomId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'ROOM_ID_REQUIRED_FOR_MINIBAR',
          message: 'room_id untuk lokasi ROOM_MINIBAR wajib berupa bilangan bulat positif',
        });
      }
      roomId = parsedRoomId;
    } else if (hasRoomId) {
      return res.status(400).json({
        status: 'ERROR',
        code: 'ROOM_ID_FORBIDDEN_FOR_NON_MINIBAR',
        message: `Lokasi bertipe ${typeParsed.value} tidak boleh memiliki room_id`,
      });
    }

    let isActive = true;
    if (body.is_active !== undefined) {
      if (typeof body.is_active !== 'boolean') {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'is_active harus bertipe boolean',
        });
      }
      isActive = body.is_active;
    }

    let notes: string | null = null;
    if (body.notes !== undefined && body.notes !== null) {
      if (typeof body.notes !== 'string') {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'Catatan (notes) harus berupa teks',
        });
      }
      const trimmedNotes = body.notes.trim();
      if (trimmedNotes.length > 500) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          error: 'Catatan (notes) maksimal 500 karakter',
          message: 'Catatan (notes) maksimal 500 karakter',
        });
      }
      notes = trimmedNotes || null;
    }

    try {
      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const { client, isDedicatedClient } = await acquireTransactionalClient(deps.pool);
      try {
        if (isDedicatedClient) await client.query('BEGIN');

        let roomNumber: string | null = null;
        if (typeParsed.value === 'ROOM_MINIBAR' && roomId !== null) {
          const roomRes = await client.query(
            `SELECT id, property_id, room_number FROM rooms WHERE id = $1`,
            [roomId]
          );
          if (roomRes.rowCount === 0 || Number(roomRes.rows[0].property_id) !== propertyId) {
            if (isDedicatedClient) await client.query('ROLLBACK');
            return res.status(422).json({
              status: 'ERROR',
              code: 'ROOM_PROPERTY_MISMATCH',
              message: `Kamar (room_id=${roomId}) tidak ditemukan atau bukan milik properti ${propertyId}`,
            });
          }
          roomNumber = String(roomRes.rows[0].room_number || '');

          const existingRoomLoc = await client.query(
            `SELECT id, code FROM stock_locations
              WHERE property_id = $1
                AND room_id = $2
                AND location_type = 'ROOM_MINIBAR'`,
            [propertyId, roomId]
          );
          if (existingRoomLoc.rowCount > 0) {
            if (isDedicatedClient) await client.query('ROLLBACK');
            return res.status(409).json({
              status: 'ERROR',
              code: 'ROOM_MINIBAR_LOCATION_EXISTS',
              message: `Kamar ${roomNumber || roomId} sudah memiliki lokasi stok minibar (${existingRoomLoc.rows[0].code})`,
            });
          }
        }

        const dupCodeRes = await client.query(
          `SELECT id FROM stock_locations
            WHERE property_id = $1 AND UPPER(BTRIM(code)) = $2`,
          [propertyId, codeParsed.value]
        );
        if (dupCodeRes.rowCount > 0) {
          if (isDedicatedClient) await client.query('ROLLBACK');
          return res.status(409).json({
            status: 'ERROR',
            code: 'LOCATION_CODE_DUPLICATE',
            message: `Kode lokasi "${codeParsed.value}" sudah digunakan pada properti ini`,
          });
        }

        const dupNameRes = await client.query(
          `SELECT id FROM stock_locations
            WHERE property_id = $1 AND LOWER(BTRIM(name)) = LOWER($2)`,
          [propertyId, nameParsed.value]
        );
        if (dupNameRes.rowCount > 0) {
          if (isDedicatedClient) await client.query('ROLLBACK');
          return res.status(409).json({
            status: 'ERROR',
            code: 'LOCATION_NAME_DUPLICATE',
            message: `Nama lokasi "${nameParsed.value}" sudah digunakan pada properti ini`,
          });
        }

        const insertRes = await client.query(
          `INSERT INTO stock_locations (
             property_id, code, name, location_type, room_id, is_active, notes
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, property_id, code, name, location_type, room_id, is_active, notes, created_at, updated_at`,
          [propertyId, codeParsed.value, nameParsed.value, typeParsed.value, roomId, isActive, notes]
        );

        if (isDedicatedClient) await client.query('COMMIT');
        return res.status(201).json({
          status: 'OK',
          data: formatStockLocationRow({
            ...insertRes.rows[0],
            room_number: roomNumber,
          }),
        });
      } catch (dbErr: any) {
        if (isDedicatedClient) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // ignore
          }
        }
        if (dbErr?.code === '23505') {
          const constraint = String(dbErr?.constraint || '');
          if (constraint.includes('uq_stock_locations_property_room_minibar')) {
            return res.status(409).json({
              status: 'ERROR',
              code: 'ROOM_MINIBAR_LOCATION_EXISTS',
              message: 'Kamar ini sudah memiliki lokasi stok minibar pada properti yang sama',
            });
          }
          if (constraint.includes('uq_stock_locations_property_code')) {
            return res.status(409).json({
              status: 'ERROR',
              code: 'LOCATION_CODE_DUPLICATE',
              message: `Kode lokasi "${codeParsed.value}" sudah digunakan pada properti ini`,
            });
          }
          if (constraint.includes('uq_stock_locations_property_name')) {
            return res.status(409).json({
              status: 'ERROR',
              code: 'LOCATION_NAME_DUPLICATE',
              message: `Nama lokasi "${nameParsed.value}" sudah digunakan pada properti ini`,
            });
          }
        }
        throw dbErr;
      } finally {
        if (isDedicatedClient && typeof (client as any).release === 'function') {
          (client as any).release();
        }
      }
    } catch (error: any) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      return res.status(status).json({
        status: 'ERROR',
        code: error?.code || 'INTERNAL_ERROR',
        message: error?.message || 'Gagal membuat lokasi stok baru',
      });
    }
  };
}

export function createStockLocationPatchHandler(deps: ProductMasterMp03cDeps) {
  return async function handleStockLocationPatch(req: Request, res: Response) {
    const locationId = Number(req.params.id);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const propertyId = Number(body.property_id ?? req.query?.property_id);

    if (!Number.isInteger(locationId) || locationId <= 0 || !Number.isInteger(propertyId) || propertyId <= 0) {
      return res.status(400).json({
        status: 'ERROR',
        code: 'VALIDATION_ERROR',
        message: 'id lokasi dan property_id wajib berupa bilangan bulat positif',
      });
    }

    try {
      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);
      if (res.headersSent) return;

      const { client, isDedicatedClient } = await acquireTransactionalClient(deps.pool);
      try {
        if (isDedicatedClient) await client.query('BEGIN');

        const existingRes = await client.query(
          `SELECT sl.id, sl.property_id, sl.code, sl.name, sl.location_type,
                  sl.room_id, r.room_number, sl.is_active, sl.notes,
                  sl.created_at, sl.updated_at
             FROM stock_locations sl
             LEFT JOIN rooms r
               ON r.id = sl.room_id AND r.property_id = sl.property_id
            WHERE sl.id = $1 AND sl.property_id = $2
            FOR UPDATE OF sl`,
          [locationId, propertyId]
        );

        if (existingRes.rowCount === 0) {
          if (isDedicatedClient) await client.query('ROLLBACK');
          return res.status(404).json({
            status: 'ERROR',
            code: 'NOT_FOUND',
            message: 'Lokasi stok tidak ditemukan pada properti ini',
          });
        }

        const existing = formatStockLocationRow(existingRes.rows[0]);

        // Immutability guard: location_type & room_id tidak dapat diubah setelah dibuat
        if (Object.prototype.hasOwnProperty.call(body, 'location_type')) {
          const requestedType =
            typeof body.location_type === 'string' ? body.location_type.trim().toUpperCase() : '';
          if (requestedType !== existing.location_type) {
            if (isDedicatedClient) await client.query('ROLLBACK');
            return res.status(400).json({
              status: 'ERROR',
              code: 'IMMUTABLE_LOCATION_IDENTITY',
              message: 'Identitas struktural lokasi (location_type) bersifat tetap dan tidak dapat diubah setelah lokasi dibuat',
            });
          }
        }

        if (Object.prototype.hasOwnProperty.call(body, 'room_id')) {
          const requestedRoomId =
            body.room_id === null || body.room_id === '' || body.room_id === undefined
              ? null
              : Number(body.room_id);
          if (requestedRoomId !== existing.room_id) {
            if (isDedicatedClient) await client.query('ROLLBACK');
            return res.status(400).json({
              status: 'ERROR',
              code: 'IMMUTABLE_LOCATION_IDENTITY',
              message: 'Identitas struktural lokasi (room_id) bersifat tetap dan tidak dapat diubah setelah lokasi dibuat',
            });
          }
        }

        let nextCode = existing.code;
        if (Object.prototype.hasOwnProperty.call(body, 'code')) {
          const parsed = parseStockLocationCodeInput(body.code);
          if (!parsed.ok) {
            if (isDedicatedClient) await client.query('ROLLBACK');
            return res.status(parsed.status).json({ status: 'ERROR', code: parsed.code, message: parsed.error });
          }
          nextCode = parsed.value;
        }

        let nextName = existing.name;
        if (Object.prototype.hasOwnProperty.call(body, 'name')) {
          const parsed = parseStockLocationNameInput(body.name);
          if (!parsed.ok) {
            if (isDedicatedClient) await client.query('ROLLBACK');
            return res.status(parsed.status).json({ status: 'ERROR', code: parsed.code, message: parsed.error });
          }
          nextName = parsed.value;
        }

        let nextIsActive = existing.is_active;
        if (Object.prototype.hasOwnProperty.call(body, 'is_active')) {
          if (typeof body.is_active !== 'boolean') {
            if (isDedicatedClient) await client.query('ROLLBACK');
            return res.status(400).json({
              status: 'ERROR',
              code: 'VALIDATION_ERROR',
              message: 'is_active harus bertipe boolean',
            });
          }
          nextIsActive = body.is_active;
        }

        let nextNotes = existing.notes;
        if (Object.prototype.hasOwnProperty.call(body, 'notes')) {
          if (body.notes === null || body.notes === '') {
            nextNotes = null;
          } else if (typeof body.notes !== 'string') {
            if (isDedicatedClient) await client.query('ROLLBACK');
            return res.status(400).json({
              status: 'ERROR',
              code: 'VALIDATION_ERROR',
              message: 'Catatan (notes) harus berupa teks',
            });
          } else {
            const trimmedNotes = body.notes.trim();
            if (trimmedNotes.length > 500) {
              if (isDedicatedClient) await client.query('ROLLBACK');
              return res.status(400).json({
                status: 'ERROR',
                code: 'VALIDATION_ERROR',
                message: 'Catatan (notes) maksimal 500 karakter',
              });
            }
            nextNotes = trimmedNotes || null;
          }
        }

        const dupCodeRes = await client.query(
          `SELECT id FROM stock_locations
            WHERE property_id = $1 AND UPPER(BTRIM(code)) = $2 AND id <> $3`,
          [propertyId, nextCode, locationId]
        );
        if (dupCodeRes.rowCount > 0) {
          if (isDedicatedClient) await client.query('ROLLBACK');
          return res.status(409).json({
            status: 'ERROR',
            code: 'LOCATION_CODE_DUPLICATE',
            message: `Kode lokasi "${nextCode}" sudah digunakan pada properti ini`,
          });
        }

        const dupNameRes = await client.query(
          `SELECT id FROM stock_locations
            WHERE property_id = $1 AND LOWER(BTRIM(name)) = LOWER($2) AND id <> $3`,
          [propertyId, nextName, locationId]
        );
        if (dupNameRes.rowCount > 0) {
          if (isDedicatedClient) await client.query('ROLLBACK');
          return res.status(409).json({
            status: 'ERROR',
            code: 'LOCATION_NAME_DUPLICATE',
            message: `Nama lokasi "${nextName}" sudah digunakan pada properti ini`,
          });
        }

        const updateRes = await client.query(
          `UPDATE stock_locations
              SET code = $1,
                  name = $2,
                  is_active = $3,
                  notes = $4,
                  updated_at = NOW()
            WHERE id = $5 AND property_id = $6
            RETURNING id, property_id, code, name, location_type, room_id, is_active, notes, created_at, updated_at`,
          [nextCode, nextName, nextIsActive, nextNotes, locationId, propertyId]
        );

        if (isDedicatedClient) await client.query('COMMIT');
        return res.json({
          status: 'OK',
          data: formatStockLocationRow({
            ...updateRes.rows[0],
            room_number: existing.room_number,
          }),
        });
      } catch (dbErr: any) {
        if (isDedicatedClient) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // ignore
          }
        }
        throw dbErr;
      } finally {
        if (isDedicatedClient && typeof (client as any).release === 'function') {
          (client as any).release();
        }
      }
    } catch (error: any) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      return res.status(status).json({
        status: 'ERROR',
        code: error?.code || 'INTERNAL_ERROR',
        message: error?.message || 'Gagal memperbarui lokasi stok',
      });
    }
  };
}

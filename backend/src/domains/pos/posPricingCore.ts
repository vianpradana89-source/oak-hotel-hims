/**
 * posPricingCore.ts
 *
 * PHASE B1 — Canonical POS Pricing Core (pure function, tanpa DB).
 *
 * Satu-satunya tempat di mana harga POS dihitung secara canonical.
 * Downstream consumer (posOrderCreateHandler, projection transaksi,
 * settlement, receipt) MEMBACA snapshot hasil perhitungan, TIDAK
 * menghitung ulang — menjamin ONE PRICING FLOW + ONE AUDIT TRAIL.
 *
 * Formula V1 EXCLUSIVE ONLY (V1: prices selalu EXCLUSIVE dari service/tax):
 *
 *   gross_items          = Σ (quantity × unit_price)
 *   item_discount_total  = Σ line discount
 *   after_item_discount  = gross_items − item_discount_total
 *   order_discount       = NOMINAL value
 *                          atau Math.round(after_item_discount × pct / 100)
 *   discounted_subtotal  = after_item_discount − order_discount
 *   service_amount       = enabled ? Math.round(discounted_subtotal × svc_pct / 100) : 0
 *   tax_amount           = enabled ? Math.round((discounted_subtotal + service_amount) × tax_pct / 100) : 0
 *   total_amount         = discounted_subtotal + service_amount + tax_amount
 *
 * Kontrak validasi (fail-closed, TIDAK clamp):
 *   - quantity: integer > 0
 *   - unit_price: whole rupiah integer >= 0
 *   - NOMINAL discount: whole rupiah integer >= 0, tidak melebihi basis
 *   - PERCENT: 0..100, maksimal 2 desimal (divisor selalu /100)
 *   - service_charge_percent / tax_percent: 0..100, maksimal 2 desimal
 *   - serviceChargeEnabled / taxEnabled: STRICT boolean (typeof === 'boolean');
 *     "false", 1, 0, null, undefined, {} SEMUA ditolak (INVALID_BOOLEAN)
 *   - enabled=false => amount 0, NAMUN snapshot percent TETAP menyimpan
 *     percent aktual setting (bukan dipaksa 0)
 *   - semua output monetary whole rupiah integer (Number.isSafeInteger)
 */

// =============================================================================
// Error class
// =============================================================================

export class PosPricingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PosPricingError';
    this.code = code;
  }
}

// =============================================================================
// Types
// =============================================================================

export type PosDiscountType = 'NOMINAL' | 'PERCENT';

export interface PosPricingItemInput {
  /** Jumlah item: integer > 0. */
  quantity: number;
  /** Harga satuan whole rupiah dari pos_menu_items.price: integer >= 0. */
  unitPrice: number;
  /** Jenis diskon per baris; null = tanpa diskon. */
  discountType: PosDiscountType | null;
  /**
   * Nilai diskon per baris.
   * NOMINAL: whole rupiah integer >= 0 (<= line gross).
   * PERCENT: 0..100 maksimal 2 desimal.
   * null bila discountType null.
   */
  discountValue: number | null;
}

export interface PosPricingInput {
  /** Daftar item (wajib >= 1 sesuai kontrak create order POS). */
  items: PosPricingItemInput[];
  /** Diskon level order; null = tanpa diskon. */
  orderDiscountType: PosDiscountType | null;
  /**
   * Nilai diskon order.
   * NOMINAL: whole rupiah integer >= 0 (<= afterItemDiscount).
   * PERCENT: 0..100 maksimal 2 desimal.
   * null bila orderDiscountType null.
   */
  orderDiscountValue: number | null;
  /** Service charge aktif (flag enabled setting properti). */
  serviceChargeEnabled: boolean;
  /** Percent service charge 0..100 maks 2 desimal (diambil dari setting). */
  serviceChargePercent: number;
  /** PPN aktif (flag enabled setting properti). */
  taxEnabled: boolean;
  /** Percent PPN 0..100 maks 2 desimal (diambil dari setting). */
  taxPercent: number;
}

export interface PosPricingLineResult {
  lineGross: number;
  lineDiscountAmount: number;
  lineNet: number;
}

export interface PosPricingResult {
  /** Rincian per baris (audit trail). */
  items: PosPricingLineResult[];
  /** Σ (quantity × unit_price). */
  grossItems: number;
  /** Σ line discount. */
  itemDiscountTotal: number;
  /** grossItems − itemDiscountTotal. */
  afterItemDiscount: number;
  /** Nominal hasil diskon order (0 bila tidak ada). */
  orderDiscountAmount: number;
  /** afterItemDiscount − orderDiscountAmount. */
  discountedSubtotal: number;
  /** 0 bila serviceChargeEnabled=false. */
  serviceAmount: number;
  /** 0 bila taxEnabled=false. Base PPN = (discountedSubtotal + serviceAmount). */
  taxAmount: number;
  /** discountedSubtotal + serviceAmount + taxAmount. */
  totalAmount: number;

  // ── Snapshot untuk persist ke pos_orders (PHASE A schema) ──
  /** Percent service aktual saat order dibuat (meskipun enabled=false). */
  serviceChargePercentSnapshot: number;
  /** Percent PPN aktual saat order dibuat (meskipun enabled=false). */
  taxPercentSnapshot: number;
  /** Status enabled service saat order dibuat. */
  serviceChargeEnabledSnapshot: boolean;
  /** Status enabled PPN saat order dibuat. */
  taxEnabledSnapshot: boolean;
}

// =============================================================================
// Internal validators
// =============================================================================

function requireFinite(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new PosPricingError('INVALID_NUMBER', `${label} harus finite number (diterima: ${String(value)})`);
  }
  return n;
}

function requireNonNegative(value: unknown, label: string): number {
  const n = requireFinite(value, label);
  if (n < 0) {
    throw new PosPricingError('NEGATIVE_VALUE', `${label} tidak boleh negatif (diterima: ${n})`);
  }
  return n;
}

function requireSafeInt(value: unknown, label: string): number {
  const n = requireNonNegative(value, label);
  if (!Number.isSafeInteger(n)) {
    throw new PosPricingError('NOT_SAFE_INTEGER', `${label} harus whole-rupiah safe integer (diterima: ${String(value)})`);
  }
  return n;
}

/**
 * Percent valid: finite, 0..100, maksimal 2 desimal.
 * Di-divisor selalu /100. Nilai boleh desimal (mis. 7.5, 10.55).
 */
function validatePercent(value: unknown, label: string): number {
  const n = requireFinite(value, label);
  if (n < 0) {
    throw new PosPricingError('PERCENT_NEGATIVE', `${label} tidak boleh negatif (diterima: ${n})`);
  }
  if (n > 100) {
    throw new PosPricingError('PERCENT_EXCEEDS_100', `${label} tidak boleh melebihi 100 (diterima: ${n})`);
  }
  // Maksimal 2 desimal: value × 100 harus integer (toleransi float epsilon).
  const scaled = n * 100;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-8) {
    throw new PosPricingError('PERCENT_TOO_MANY_DECIMALS', `${label} maksimal 2 desimal (diterima: ${n})`);
  }
  return Math.round(scaled) / 100; // normalisasi ke representasi eksak
}

function validateDiscountType(type: PosDiscountType | null, label: string): void {
  if (type !== null && type !== 'NOMINAL' && type !== 'PERCENT') {
    throw new PosPricingError(
      'INVALID_DISCOUNT_TYPE',
      `${label} harus 'NOMINAL', 'PERCENT', atau null (diterima: ${String(type)})`
    );
  }
}

function requireSafeNonNegative(value: unknown, label: string): number {
  const n = requireFinite(value, label);
  if (n < 0) {
    throw new PosPricingError('NEGATIVE_VALUE', `${label} tidak boleh negatif (diterima: ${n})`);
  }
  if (!Number.isSafeInteger(n)) {
    throw new PosPricingError('NOT_SAFE_INTEGER', `${label} harus safe integer non-negatif (diterima: ${String(value)})`);
  }
  return n;
}

// =============================================================================
// Main pure function
// =============================================================================

/**
 * Hitung seluruh komponen harga POS secara canonical.
 *
 * PURE FUNCTION: tidak menyentuh DB, network, waktu, atau state global.
 * Input harus sudah divalidasi di level handler untuk field business
 * (menu item aktif, property scope, dsb.) — fungsi ini fokus pada
 * validasi nilai numerik + kalkulasi.
 *
 * @throws {PosPricingError} dengan code terstruktur untuk setiap
 *   pelanggaran validasi (fail-closed, tanpa clamp).
 */
export function computePosPricing(input: PosPricingInput): PosPricingResult {
  // ── Validasi strict boolean (TIDAK ADA COERCION untuk financial core) ─
  // "false", 1, 0, null, undefined, {} — SEMUA ditolak.
  // Hanya typeof === 'boolean' yang valid.
  if (typeof input.serviceChargeEnabled !== 'boolean') {
    throw new PosPricingError(
      'INVALID_BOOLEAN',
      `serviceChargeEnabled harus boolean strict (diterima: ${typeof input.serviceChargeEnabled} = ${JSON.stringify(input.serviceChargeEnabled)})`
    );
  }
  if (typeof input.taxEnabled !== 'boolean') {
    throw new PosPricingError(
      'INVALID_BOOLEAN',
      `taxEnabled harus boolean strict (diterima: ${typeof input.taxEnabled} = ${JSON.stringify(input.taxEnabled)})`
    );
  }

  // ── Validasi struktur items ─────────────────────────────────────────────
  if (!Array.isArray(input.items)) {
    throw new PosPricingError('INVALID_ITEMS', 'items harus array');
  }
  if (input.items.length === 0) {
    throw new PosPricingError('NO_ITEMS', 'items minimal 1 (kontrak create order POS)');
  }

  // ── Validasi & hitung per baris ─────────────────────────────────────────
  const lines: PosPricingLineResult[] = [];
  let grossItems = 0;
  let itemDiscountTotal = 0;

  for (let i = 0; i < input.items.length; i++) {
    const line = input.items[i];
    if (!line || typeof line !== 'object') {
      throw new PosPricingError('INVALID_ITEM', `items[${i}] harus object`);
    }

    const quantity = requireSafeInt(line.quantity, `items[${i}].quantity`);
    if (quantity <= 0) {
      throw new PosPricingError('INVALID_QUANTITY', `items[${i}].quantity harus > 0 (diterima: ${quantity})`);
    }
    const unitPrice = requireSafeInt(line.unitPrice, `items[${i}].unitPrice`);

    // lineGross: whole rupiah
    const lineGross = quantity * unitPrice;
    if (!Number.isSafeInteger(lineGross)) {
      throw new PosPricingError('OVERFLOW', `items[${i}] gross melebihi batas safe integer (${lineGross})`);
    }

    // ── Diskon per baris ────────────────────────────────────────────────
    validateDiscountType(line.discountType, `items[${i}].discountType`);
    let lineDiscountAmount = 0;
    if (line.discountType !== null) {
      const dv = requireFinite(line.discountValue, `items[${i}].discountValue`);
      if (line.discountType === 'NOMINAL') {
        const nom = requireSafeNonNegative(dv, `items[${i}].discountValue (NOMINAL)`);
        if (nom > lineGross) {
          throw new PosPricingError(
            'ITEM_DISCOUNT_EXCEEDS_GROSS',
            `items[${i}] item discount NOMINAL (${nom}) melebihi line gross (${lineGross})`
          );
        }
        lineDiscountAmount = nom;
      } else if (line.discountType === 'PERCENT') {
        const pct = validatePercent(dv, `items[${i}].discountValue (PERCENT)`);
        lineDiscountAmount = Math.round((lineGross * pct) / 100);
        if (lineDiscountAmount > lineGross) {
          throw new PosPricingError(
            'ITEM_DISCOUNT_EXCEEDS_GROSS',
            `items[${i}] item discount PERCENT hasil (${lineDiscountAmount}) melebihi line gross (${lineGross})`
          );
        }
      }
    } else if (line.discountValue !== null && line.discountValue !== undefined) {
      // discountType null tapi value terisi — tidak konsisten, tolak eksplisit.
      throw new PosPricingError(
        'INCONSISTENT_DISCOUNT',
        `items[${i}].discountValue terisi tetapi discountType null`
      );
    }

    const lineNet = lineGross - lineDiscountAmount;
    if (!Number.isSafeInteger(lineNet) || lineNet < 0) {
      throw new PosPricingError('INVALID_LINE_NET', `items[${i}] net line tidak valid (${lineNet})`);
    }

    lines.push({ lineGross, lineDiscountAmount, lineNet });
    grossItems += lineGross;
    itemDiscountTotal += lineDiscountAmount;
  }

  if (!Number.isSafeInteger(grossItems) || grossItems < 0) {
    throw new PosPricingError('OVERFLOW', 'grossItems melebihi batas safe integer');
  }

  const afterItemDiscount = grossItems - itemDiscountTotal;
  if (!Number.isSafeInteger(afterItemDiscount) || afterItemDiscount < 0) {
    throw new PosPricingError('INVALID_AFTER_DISCOUNT', `afterItemDiscount tidak valid (${afterItemDiscount})`);
  }

  // ── Diskon order ────────────────────────────────────────────────────────
  validateDiscountType(input.orderDiscountType, 'orderDiscountType');
  let orderDiscountAmount = 0;
  if (input.orderDiscountType !== null) {
    const dv = requireFinite(input.orderDiscountValue, 'orderDiscountValue');
    if (input.orderDiscountType === 'NOMINAL') {
      const nom = requireSafeNonNegative(dv, 'orderDiscountValue (NOMINAL)');
      if (nom > afterItemDiscount) {
        throw new PosPricingError(
          'ORDER_DISCOUNT_EXCEEDS_SUBTOTAL',
          `order discount NOMINAL (${nom}) melebihi afterItemDiscount (${afterItemDiscount})`
        );
      }
      orderDiscountAmount = nom;
    } else {
      const pct = validatePercent(dv, 'orderDiscountValue (PERCENT)');
      orderDiscountAmount = Math.round((afterItemDiscount * pct) / 100);
      if (orderDiscountAmount > afterItemDiscount) {
        throw new PosPricingError(
          'ORDER_DISCOUNT_EXCEEDS_SUBTOTAL',
          `order discount PERCENT hasil (${orderDiscountAmount}) melebihi afterItemDiscount (${afterItemDiscount})`
        );
      }
    }
  } else if (input.orderDiscountValue !== null && input.orderDiscountValue !== undefined) {
    throw new PosPricingError(
      'INCONSISTENT_ORDER_DISCOUNT',
      'orderDiscountValue terisi tetapi orderDiscountType null'
    );
  }

  const discountedSubtotal = afterItemDiscount - orderDiscountAmount;
  if (!Number.isSafeInteger(discountedSubtotal) || discountedSubtotal < 0) {
    throw new PosPricingError('INVALID_DISCOUNTED_SUBTOTAL', `discountedSubtotal tidak valid (${discountedSubtotal})`);
  }

  // ── Service charge (EXCLUSIVE: ditambahkan ke subtotal) ───────────────
  // svcPct normalisasi validasi; input.serviceChargeEnabled sudah divalidasi
  // strict boolean di atas — dipakai langsung, TIDAK di-coerce.
  const svcPct = validatePercent(input.serviceChargePercent, 'serviceChargePercent');
  const serviceChargeEnabled = input.serviceChargeEnabled;
  const serviceAmount = serviceChargeEnabled
    ? Math.round((discountedSubtotal * svcPct) / 100)
    : 0;

  // ── PPN (base = discountedSubtotal + serviceAmount) ────────────────────
  const taxPct = validatePercent(input.taxPercent, 'taxPercent');
  const taxEnabled = input.taxEnabled;
  const taxAmount = taxEnabled
    ? Math.round(((discountedSubtotal + serviceAmount) * taxPct) / 100)
    : 0;

  // ── Total final ────────────────────────────────────────────────────────
  const totalAmount = discountedSubtotal + serviceAmount + taxAmount;
  if (!Number.isSafeInteger(totalAmount) || totalAmount < 0) {
    throw new PosPricingError('INVALID_TOTAL', `totalAmount tidak valid (${totalAmount})`);
  }

  // ── Snapshots: percent ACTUAL (meskipun disabled) + flag enabled ──────
  // Flag memakai nilai strict boolean yang sudah tervalidasi di awal;
  // TIDAK memakai Boolean(...) coercion.
  return {
    items: lines,
    grossItems,
    itemDiscountTotal,
    afterItemDiscount,
    orderDiscountAmount,
    discountedSubtotal,
    serviceAmount,
    taxAmount,
    totalAmount,
    serviceChargePercentSnapshot: svcPct,
    taxPercentSnapshot: taxPct,
    serviceChargeEnabledSnapshot: serviceChargeEnabled,
    taxEnabledSnapshot: taxEnabled,
  };
}

export default computePosPricing;

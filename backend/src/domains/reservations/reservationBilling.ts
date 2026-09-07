export type ReservationDiscountType = 'NOMINAL' | 'PERCENTAGE';

export class ReservationBillingError extends Error {
  statusCode: number;
  code: string;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'ReservationBillingError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function roundIdr(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount);
}

export function normalizeReservationDiscountType(value: unknown): ReservationDiscountType | null {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === 'NOMINAL' || raw === 'FIXED' || raw === 'AMOUNT') return 'NOMINAL';
  if (raw === 'PERCENTAGE' || raw === 'PERCENT' || raw === 'PCT') return 'PERCENTAGE';
  return null;
}

export function stayChargeLineGrosses(stayCharges: unknown): number[] {
  if (!Array.isArray(stayCharges)) return [];
  return stayCharges.map((line) => {
    const quantity = Math.max(1, Number((line as any)?.quantity || 1) || 1);
    const amount = Number((line as any)?.amount);
    if (Number.isFinite(amount)) return roundIdr(amount);
    const unitPrice = Number((line as any)?.unit_price ?? (line as any)?.unitPrice ?? 0);
    return roundIdr(unitPrice * quantity);
  });
}

export function sumStayChargeGross(stayCharges: unknown): number {
  return stayChargeLineGrosses(stayCharges).reduce((sum, amount) => sum + amount, 0);
}

export function resolveRoomGrossSubtotal(input: {
  subtotalAmount?: unknown;
  totalPrice?: unknown;
}): number {
  const subtotal = roundIdr(input.subtotalAmount);
  if (subtotal > 0) return Math.max(0, subtotal);
  return Math.max(0, roundIdr(input.totalPrice));
}

/**
 * Backend-authoritative room-level discount. Frontend discount_amount / net total
 * are never used when discount_type + discount_value are present.
 * Legacy payloads without type keep percent-wins-then-nominal, capped at gross.
 */
export function computeAuthoritativeDiscount(input: {
  gross: unknown;
  discountType?: unknown;
  discountValue?: unknown;
  discountPercent?: unknown;
  discountAmount?: unknown;
  discountReason?: unknown;
}): {
  gross: number;
  discountType: ReservationDiscountType | null;
  discountValue: number;
  discount: number;
  discountPercent: number;
  reason: string | null;
} {
  const gross = Math.max(0, roundIdr(input.gross));
  const reason = String(input.discountReason ?? '').trim() || null;
  const explicitType = normalizeReservationDiscountType(input.discountType);
  const hasExplicitValue = input.discountValue !== undefined && input.discountValue !== null && String(input.discountValue).trim() !== '';
  const rawValue = hasExplicitValue ? Number(input.discountValue) : NaN;

  let discountType = explicitType;
  let discountValue = 0;
  let discount = 0;
  let discountPercent = 0;

  if (explicitType === 'PERCENTAGE') {
    const percent = hasExplicitValue ? Number(rawValue) : Number(input.discountPercent ?? 0);
    if (!Number.isFinite(percent) || percent < 0) {
      throw new ReservationBillingError('DISCOUNT_NEGATIVE', 'Nilai diskon tidak boleh negatif.');
    }
    if (percent > 100) {
      throw new ReservationBillingError('DISCOUNT_PERCENT_INVALID', 'Persentase diskon tidak boleh lebih dari 100.');
    }
    discountType = 'PERCENTAGE';
    discountValue = percent;
    discountPercent = percent;
    discount = Math.min(gross, Math.max(0, roundIdr((gross * percent) / 100)));
  } else if (explicitType === 'NOMINAL') {
    const nominal = hasExplicitValue ? Number(rawValue) : Number(input.discountAmount ?? 0);
    if (!Number.isFinite(nominal) || nominal < 0) {
      throw new ReservationBillingError('DISCOUNT_NEGATIVE', 'Nilai diskon tidak boleh negatif.');
    }
    discountType = 'NOMINAL';
    discountValue = nominal;
    discountPercent = 0;
    discount = Math.min(gross, Math.max(0, roundIdr(nominal)));
  } else {
    const legacyPercent = Number(input.discountPercent ?? 0);
    const legacyAmount = Number(input.discountAmount ?? 0);
    if (legacyPercent < 0 || legacyAmount < 0) {
      throw new ReservationBillingError('DISCOUNT_NEGATIVE', 'Nilai diskon tidak boleh negatif.');
    }
    if (legacyPercent > 100) {
      throw new ReservationBillingError('DISCOUNT_PERCENT_INVALID', 'Persentase diskon tidak boleh lebih dari 100.');
    }
    if (legacyPercent > 0) {
      discountType = 'PERCENTAGE';
      discountValue = legacyPercent;
      discountPercent = legacyPercent;
      discount = Math.min(gross, Math.max(0, roundIdr((gross * legacyPercent) / 100)));
    } else {
      discountType = legacyAmount > 0 ? 'NOMINAL' : null;
      discountValue = Math.max(0, legacyAmount);
      discountPercent = 0;
      discount = Math.min(gross, Math.max(0, roundIdr(legacyAmount)));
    }
  }

  if (discount > 0 && !reason) {
    throw new ReservationBillingError('DISCOUNT_REASON_REQUIRED', 'Alasan diskon wajib diisi.');
  }

  return {
    gross,
    discountType,
    discountValue,
    discount,
    discountPercent,
    reason
  };
}

export function buildChildReservationBilling(input: {
  subtotalAmount?: unknown;
  totalPrice?: unknown;
  stayCharges?: unknown;
  discountType?: unknown;
  discountValue?: unknown;
  discountPercent?: unknown;
  discountAmount?: unknown;
  discountReason?: unknown;
  amountPaid?: unknown;
}): {
  roomGross: number;
  stayGross: number;
  discountBase: number;
  discount: number;
  discountPercent: number;
  discountType: ReservationDiscountType | null;
  discountValue: number;
  reason: string | null;
  netTotal: number;
  amountPaid: number;
  remainingBalance: number;
} {
  const roomGross = resolveRoomGrossSubtotal(input);
  const stayGross = Math.max(0, sumStayChargeGross(input.stayCharges));
  const discountBase = roomGross + stayGross;
  const computed = computeAuthoritativeDiscount({
    gross: discountBase,
    discountType: input.discountType,
    discountValue: input.discountValue,
    discountPercent: input.discountPercent,
    discountAmount: input.discountAmount,
    discountReason: input.discountReason
  });
  const netTotal = Math.max(0, discountBase - computed.discount);
  const amountPaid = Math.max(0, roundIdr(input.amountPaid));
  return {
    roomGross,
    stayGross,
    discountBase,
    discount: computed.discount,
    discountPercent: computed.discountPercent,
    discountType: computed.discountType,
    discountValue: computed.discountValue,
    reason: computed.reason ? computed.reason.slice(0, 255) : null,
    netTotal,
    amountPaid,
    remainingBalance: Math.max(0, netTotal - amountPaid)
  };
}

/**
 * Split one commercial discount across ROOM SALE then stay-charge sales.
 * Avoids negative room net when the Quick Booking discount base is room + stay.
 */
export function allocateCommercialDiscount(
  roomGross: unknown,
  stayLineAmounts: unknown[],
  discount: unknown
): { roomDiscount: number; stayDiscounts: number[] } {
  let remaining = Math.max(0, roundIdr(discount));
  const room = Math.max(0, roundIdr(roomGross));
  const roomDiscount = Math.min(room, remaining);
  remaining -= roomDiscount;
  const stayDiscounts = (Array.isArray(stayLineAmounts) ? stayLineAmounts : []).map((lineAmount) => {
    const line = Math.max(0, roundIdr(lineAmount));
    const allocated = Math.min(line, remaining);
    remaining -= allocated;
    return allocated;
  });
  return { roomDiscount, stayDiscounts };
}

/**
 * Legacy create posted ROOM_CHARGE at net while also posting DISCOUNT CREDIT.
 * Only subtract posted DISCOUNT when ROOM_CHARGE matches persisted gross subtotal.
 */
export function shouldApplyPostedCommercialDiscount(input: {
  roomChargePosted: unknown;
  persistedSubtotal: unknown;
}): boolean {
  const subtotal = roundIdr(input.persistedSubtotal);
  const posted = roundIdr(input.roomChargePosted);
  if (subtotal <= 0 || posted <= 0) return false;
  return Math.abs(posted - subtotal) <= 1;
}

export function hasBookingGlobalDiscountInput(payload: Record<string, unknown> | null | undefined): boolean {
  if (!payload || typeof payload !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(payload, 'global_discount_type')
    || Object.prototype.hasOwnProperty.call(payload, 'global_discount_value');
}

/**
 * Split a booking-level discount across children in proportion to each child's
 * gross. Last eligible child (gross > 0) receives the rounding remainder.
 * No share may exceed that child's gross. Any leftover is filled from the start.
 */
export function allocateGlobalDiscountToChildren(
  childGrosses: unknown[],
  discount: unknown
): number[] {
  const grosses = (Array.isArray(childGrosses) ? childGrosses : []).map((value) => Math.max(0, roundIdr(value)));
  const totalGross = grosses.reduce((sum, value) => sum + value, 0);
  const totalDiscount = Math.min(Math.max(0, roundIdr(discount)), totalGross);
  const allocations = grosses.map(() => 0);
  if (totalGross <= 0 || totalDiscount <= 0 || allocations.length === 0) return allocations;

  let lastEligible = -1;
  for (let index = grosses.length - 1; index >= 0; index -= 1) {
    if (grosses[index] > 0) {
      lastEligible = index;
      break;
    }
  }

  let remaining = totalDiscount;
  for (let index = 0; index < grosses.length; index += 1) {
    if (grosses[index] <= 0) continue;
    if (index === lastEligible) {
      allocations[index] = Math.min(grosses[index], remaining);
      remaining -= allocations[index];
      continue;
    }
    const proportional = roundIdr((totalDiscount * grosses[index]) / totalGross);
    const share = Math.min(grosses[index], remaining, proportional);
    allocations[index] = share;
    remaining -= share;
  }

  if (remaining > 0) {
    for (let index = 0; index < grosses.length && remaining > 0; index += 1) {
      const capacity = grosses[index] - allocations[index];
      if (capacity <= 0) continue;
      const extra = Math.min(capacity, remaining);
      allocations[index] += extra;
      remaining -= extra;
    }
  }

  return allocations;
}

export function buildBookingGlobalDiscount(input: {
  childGrosses: unknown[];
  discountType?: unknown;
  discountValue?: unknown;
  discountPercent?: unknown;
  discountAmount?: unknown;
  discountReason?: unknown;
}): {
  gross: number;
  discountType: ReservationDiscountType | null;
  discountValue: number;
  discount: number;
  discountPercent: number;
  reason: string | null;
  net: number;
  allocations: number[];
} {
  const childGrosses = (Array.isArray(input.childGrosses) ? input.childGrosses : []).map((value) => Math.max(0, roundIdr(value)));
  const gross = childGrosses.reduce((sum, value) => sum + value, 0);
  const computed = computeAuthoritativeDiscount({
    gross,
    discountType: input.discountType,
    discountValue: input.discountValue,
    discountPercent: input.discountPercent,
    discountAmount: input.discountAmount,
    discountReason: input.discountReason
  });
  const allocations = allocateGlobalDiscountToChildren(childGrosses, computed.discount);
  return {
    gross,
    discountType: computed.discountType,
    discountValue: computed.discountValue,
    discount: computed.discount,
    discountPercent: computed.discountPercent,
    reason: computed.reason ? computed.reason.slice(0, 255) : null,
    net: Math.max(0, gross - computed.discount),
    allocations
  };
}

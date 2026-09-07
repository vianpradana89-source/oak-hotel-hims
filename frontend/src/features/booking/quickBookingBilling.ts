export function roundIdr(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount);
}

export function computeQuickBookingRoomDiscount(input: {
  roomCharge: number;
  stayChargesTotal: number;
  discountType: 'NOMINAL' | 'PERCENT';
  discountValue: number;
}): number {
  const gross = Math.max(0, roundIdr(input.roomCharge) + roundIdr(input.stayChargesTotal));
  if (input.discountType === 'PERCENT') {
    const percent = Number(input.discountValue);
    if (!Number.isFinite(percent) || percent <= 0) return 0;
    return Math.min(gross, Math.max(0, roundIdr((gross * Math.min(100, percent)) / 100)));
  }
  const nominal = Number(input.discountValue);
  if (!Number.isFinite(nominal) || nominal <= 0) return 0;
  return Math.min(gross, Math.max(0, roundIdr(nominal)));
}

export function toBackendDiscountType(discountType: 'NOMINAL' | 'PERCENT'): 'NOMINAL' | 'PERCENTAGE' {
  return discountType === 'PERCENT' ? 'PERCENTAGE' : 'NOMINAL';
}

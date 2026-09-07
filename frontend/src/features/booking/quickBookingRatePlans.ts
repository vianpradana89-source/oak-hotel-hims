export const QUICK_BOOKING_QUOTE_NOT_READY_MESSAGE =
  'Tarif kamar belum siap. Tunggu perhitungan tarif atau pilih rate plan yang sesuai.';

export type QuickBookingStayType = 'OVERNIGHT' | 'DAY_USE';

export function isActiveNonArchivedRatePlan(rp: {
  is_active?: unknown;
  is_archived?: unknown;
}): boolean {
  if (rp.is_archived === true) return false;
  if (rp.is_active === false) return false;
  return true;
}

export function matchRatePlanToCanonicalRoomType(
  rp: { room_type_id?: unknown },
  roomTypeId: number | null | undefined
): boolean {
  if (roomTypeId == null || !Number.isFinite(Number(roomTypeId)) || Number(roomTypeId) <= 0) {
    return false;
  }
  if (rp.room_type_id == null || rp.room_type_id === '') {
    return false;
  }
  return Number(rp.room_type_id) === Number(roomTypeId);
}

export function isStayTypeCompatibleRatePlan(
  rp: { rate_type?: unknown },
  stayType: QuickBookingStayType
): boolean {
  const rateType = String(rp.rate_type || 'OVERNIGHT');
  if (stayType === 'DAY_USE') return rateType === 'DAY_USE';
  return rateType !== 'DAY_USE';
}

export function isCompatibleQuickBookingRatePlan(
  rp: {
    room_type_id?: unknown;
    rate_type?: unknown;
    is_active?: unknown;
    is_archived?: unknown;
  },
  roomTypeId: number | null | undefined,
  stayType: QuickBookingStayType
): boolean {
  return (
    isActiveNonArchivedRatePlan(rp)
    && matchRatePlanToCanonicalRoomType(rp, roomTypeId)
    && isStayTypeCompatibleRatePlan(rp, stayType)
  );
}

export function selectDefaultRatePlan(
  plans: Array<{
    id?: unknown;
    room_type_id?: unknown;
    rate_type?: unknown;
    is_active?: unknown;
    is_archived?: unknown;
  }>,
  roomTypeId: number | null | undefined,
  stayType: QuickBookingStayType
): number | null {
  const match = (Array.isArray(plans) ? plans : []).find((rp) =>
    isCompatibleQuickBookingRatePlan(rp, roomTypeId, stayType)
  );
  if (!match || match.id == null || match.id === '') return null;
  const id = Number(match.id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export function compatibleQuickBookingRatePlans<T extends {
  room_type_id?: unknown;
  rate_type?: unknown;
  is_active?: unknown;
  is_archived?: unknown;
}>(
  plans: T[],
  roomTypeId: number | null | undefined,
  stayType: QuickBookingStayType
): T[] {
  return (Array.isArray(plans) ? plans : []).filter((rp) =>
    isCompatibleQuickBookingRatePlan(rp, roomTypeId, stayType)
  );
}

export function quickBookingQuoteFingerprint(input: {
  roomTypeId: number | null;
  ratePlanId: number | null;
  checkIn: string;
  checkOut: string;
  stayType: QuickBookingStayType;
}): string {
  const checkOut = input.stayType === 'DAY_USE' ? input.checkIn : input.checkOut;
  return [input.roomTypeId || '', input.ratePlanId || '', input.checkIn, checkOut, input.stayType].join('|');
}

export function resolveQuotedRoomSubtotal(quote: {
  room_subtotal?: unknown;
  nightly_breakdown?: Array<{ final_room_rate?: unknown }>;
  grand_total?: unknown;
} | null | undefined): number {
  if (!quote) return 0;
  const subtotal = Number(quote.room_subtotal);
  if (Number.isFinite(subtotal) && subtotal >= 0) {
    return Math.round(subtotal);
  }
  if (Array.isArray(quote.nightly_breakdown) && quote.nightly_breakdown.length > 0) {
    return quote.nightly_breakdown.reduce(
      (sum, night) => sum + Math.max(0, Math.round(Number(night.final_room_rate) || 0)),
      0
    );
  }
  return 0;
}

export function isQuickBookingQuoteReady(draft: {
  isManualOverride: boolean;
  quoteLoading?: boolean;
  quoteOk?: boolean;
  quotedFingerprint?: string;
  roomTypeId: number | null;
  ratePlanId: number | null;
  checkIn: string;
  checkOut: string;
  stayType: QuickBookingStayType;
}): boolean {
  if (draft.isManualOverride) return true;
  if (draft.quoteLoading) return false;
  if (!draft.quoteOk) return false;
  return draft.quotedFingerprint === quickBookingQuoteFingerprint(draft);
}

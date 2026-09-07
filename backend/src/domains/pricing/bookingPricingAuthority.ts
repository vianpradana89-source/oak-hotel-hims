import type { PriceQuoteResult } from './pricingTypes';

export const CANONICAL_PRICE_QUOTE_FAILED = 'CANONICAL_PRICE_QUOTE_FAILED';

export class CanonicalPriceQuoteError extends Error {
  statusCode = 400;
  code = CANONICAL_PRICE_QUOTE_FAILED;
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalPriceQuoteError';
  }
}

export function shouldTrustFrontendRoomGross(isManualOverride: boolean): boolean {
  return Boolean(isManualOverride);
}

export function resolveAuthoritativeRoomGross(input: {
  isManualOverride: boolean;
  frontendRoomGross: unknown;
  quoteRoomSubtotal?: unknown;
  quoteAvailable?: boolean;
}): number {
  if (shouldTrustFrontendRoomGross(input.isManualOverride)) {
    return Math.max(0, Math.round(Number(input.frontendRoomGross) || 0));
  }
  if (input.quoteAvailable === false || input.quoteRoomSubtotal === undefined || input.quoteRoomSubtotal === null) {
    throw new CanonicalPriceQuoteError(
      'Tarif kamar tidak dapat dihitung. Periksa tipe kamar dan rate plan, lalu coba lagi.'
    );
  }
  const quoted = Math.round(Number(input.quoteRoomSubtotal));
  if (!Number.isFinite(quoted) || quoted < 0) {
    throw new CanonicalPriceQuoteError(
      'Tarif kamar tidak dapat dihitung. Periksa tipe kamar dan rate plan, lalu coba lagi.'
    );
  }
  return quoted;
}

export function applyManualOverrideToQuote(
  quote: PriceQuoteResult,
  canonicalRoomGross: number,
  canonicalNet: number,
  taxAmount: number,
  serviceAmount: number
): PriceQuoteResult {
  quote.room_subtotal = canonicalRoomGross;
  quote.tax_amount = taxAmount;
  quote.service_amount = serviceAmount;
  quote.grand_total = canonicalNet;
  const nights = quote.nightly_breakdown.length || 1;
  const nightlyShare = Math.round((canonicalRoomGross || canonicalNet) / nights);
  quote.nightly_breakdown.forEach((night, idx) => {
    night.final_room_rate = idx === quote.nightly_breakdown.length - 1
      ? (canonicalRoomGross || canonicalNet) - nightlyShare * (quote.nightly_breakdown.length - 1)
      : nightlyShare;
    night.total_amount = night.final_room_rate;
  });
  return quote;
}

export function commercialNetTotal(discountBase: unknown, discountAmount: unknown): number {
  return Math.max(0, Math.round(Number(discountBase) || 0) - Math.max(0, Math.round(Number(discountAmount) || 0)));
}

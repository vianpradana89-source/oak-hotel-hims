/**
 * Canonical SALE source identity and future Charge-to-Room contract.
 *
 * BID is stay context, never an outlet transaction id.
 * One economic source must produce one SALE. PAYMENT is settlement only.
 */

export type BookingSaleSourceCategory =
  | 'ROOM'
  | 'STAY_EXTRA'
  | 'LAUNDRY'
  | 'POS'
  | 'PENALTY'
  | 'OTHER_OUTLET'
  | 'OTHER';

export const CHARGE_TO_ROOM_SALE_INVARIANT = [
  'economic_source: POS / POS canonical id',
  'folio_linkage: billing receivable only — not a second SALE',
  'canonical SALE: one row keyed by (property_id, source_type, source_id)',
  'PAYMENT: settlement only, never revenue',
].join('\n');

const ROOM_SOURCES = new Set([
  'ROOM_CHARGE',
  'DAY_USE_ROOM',
  'STAY_EXTENSION',
]);

const STAY_EXTRA_SOURCES = new Set([
  'EXTRA_BED',
  'EXTRA_PERSON',
  'EARLY_CHECKIN',
  'LATE_CHECKOUT',
  'MINIBAR',
  'ROOM_SERVICE',
]);

const POS_SOURCES = new Set(['POS', 'POS_ORDER', 'POS_ROOM_CHARGE']);

const OTHER_OUTLET_SOURCES = new Set(['BANQUET']);

export function normalizeSourceType(sourceType: unknown): string {
  return String(sourceType || '').trim().toUpperCase();
}

export function mapSaleSourceCategory(sourceType: unknown): BookingSaleSourceCategory {
  const source = normalizeSourceType(sourceType);
  if (ROOM_SOURCES.has(source)) return 'ROOM';
  if (STAY_EXTRA_SOURCES.has(source)) return 'STAY_EXTRA';
  if (source === 'LAUNDRY') return 'LAUNDRY';
  if (POS_SOURCES.has(source)) return 'POS';
  if (source === 'PENALTY') return 'PENALTY';
  if (OTHER_OUTLET_SOURCES.has(source)) return 'OTHER_OUTLET';
  return 'OTHER';
}

export function saleIdentityKey(
  propertyId: unknown,
  sourceType: unknown,
  sourceId: unknown
): string {
  return `${Number(propertyId)}|${normalizeSourceType(sourceType)}|${String(sourceId || '').trim()}`;
}

export function findDuplicateSaleIdentities(
  rows: Array<{ property_id?: unknown; source_type?: unknown; source_id?: unknown }>
): string[] {
  const seen = new Map<string, number>();
  const duplicates: string[] = [];
  for (const row of rows) {
    if (row.source_id == null || String(row.source_id).trim() === '') continue;
    const key = saleIdentityKey(row.property_id, row.source_type, row.source_id);
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    if (count === 2) duplicates.push(key);
  }
  return duplicates;
}

/**
 * Future Charge-to-Room detector (fixtures/stubs only).
 *
 * Double revenue = POS economic SALE already exists AND a second SALE
 * was projected from the folio entry id (billing linkage).
 */
export function isChargeToRoomDoubleRevenue(params: {
  propertyId: number;
  posSourceType: string;
  posSourceId: string;
  folioEntryId: string;
  projectedSales: Array<{ property_id?: unknown; source_type?: unknown; source_id?: unknown }>;
}): boolean {
  const posKey = saleIdentityKey(params.propertyId, params.posSourceType, params.posSourceId);
  const hasEconomicSale = params.projectedSales.some(
    (row) => saleIdentityKey(row.property_id, row.source_type, row.source_id) === posKey
  );
  const folioId = String(params.folioEntryId || '').trim();
  const hasFolioSale = params.projectedSales.some((row) => {
    if (Number(row.property_id) !== Number(params.propertyId)) return false;
    return String(row.source_id || '').trim() === folioId && folioId !== String(params.posSourceId);
  });
  return hasEconomicSale && hasFolioSale;
}

export function isPosSourceType(sourceType: unknown): boolean {
  return POS_SOURCES.has(normalizeSourceType(sourceType));
}

export function isPosEconomicSourceType(sourceType: unknown): boolean {
  const source = normalizeSourceType(sourceType);
  return source === 'POS' || source === 'POS_ORDER';
}

/**
 * Trustworthy POS order identity only.
 * Does not infer from amount, booking, reservation, guest, date, or folio id.
 */
export function explicitPosOrderIdFromFolioEntry(entry: {
  id?: unknown;
  pos_order_id?: unknown;
  source_type?: unknown;
  source_id?: unknown;
} | null | undefined): string | null {
  if (!entry) return null;
  const folioId = String(entry.id ?? '').trim();
  const directOrderId = String(entry.pos_order_id ?? '').trim();
  if (directOrderId && directOrderId !== folioId) return directOrderId;
  if (isPosSourceType(entry.source_type) || isPosEconomicSourceType(entry.source_type)) {
    const sourceId = String(entry.source_id ?? '').trim();
    if (sourceId && sourceId !== folioId) return sourceId;
  }
  return null;
}

export function posEconomicSourceId(params: {
  posOrderId?: unknown;
  sourceId?: unknown;
  folioEntryId?: unknown;
}): string | null {
  return explicitPosOrderIdFromFolioEntry({
    id: params.folioEntryId,
    pos_order_id: params.posOrderId,
    source_type: params.posOrderId ? 'POS' : undefined,
    source_id: params.sourceId,
  });
}

/**
 * Future Charge-to-Room write guard: folio id is linkage only.
 * If a POS economic SALE already exists, do not insert a second SALE keyed by folio_entry_id.
 */
export function shouldSkipFolioKeyedPosSale(params: {
  propertyId: number;
  chargeSourceType: unknown;
  folioEntryId: unknown;
  posOrderId?: unknown;
  existingSales: Array<{ property_id?: unknown; source_type?: unknown; source_id?: unknown }>;
}): { skip: boolean; reason: string } {
  if (!isPosSourceType(params.chargeSourceType)) {
    return { skip: false, reason: 'not_pos_source' };
  }
  const folioId = String(params.folioEntryId || '').trim();
  const economicId = explicitPosOrderIdFromFolioEntry({
    id: params.folioEntryId,
    pos_order_id: params.posOrderId,
    source_type: params.chargeSourceType,
    source_id: params.posOrderId,
  });
  if (!economicId || economicId === folioId) {
    return { skip: false, reason: 'no_distinct_pos_economic_id' };
  }
  const hasEconomic = params.existingSales.some((row) => (
    Number(row.property_id) === Number(params.propertyId)
    && isPosEconomicSourceType(row.source_type)
    && String(row.source_id || '').trim() === economicId
  ));
  if (!hasEconomic) return { skip: false, reason: 'no_existing_pos_sale' };
  return { skip: true, reason: 'pos_economic_sale_already_exists' };
}

export function isStandalonePosSale(row: { source_type?: unknown; booking_bid?: unknown }): boolean {
  return isPosSourceType(row.source_type) && !String(row.booking_bid || '').trim();
}

export function linkedPosJoinsBooking(row: { source_type?: unknown; booking_bid?: unknown }): boolean {
  return isPosSourceType(row.source_type) && Boolean(String(row.booking_bid || '').trim());
}

export function paidAtPosHasNoFolioOutstanding(params: {
  paidAtPos: boolean;
  folioRemaining: number;
}): boolean {
  if (!params.paidAtPos) return true;
  return Number(params.folioRemaining || 0) <= 0;
}

/**
 * POS Thermal Receipt — presentation-only helpers.
 *
 * These helpers shape HOW receipt data is DISPLAYED on the thermal receipt
 * and modal subtitle. They do NOT mutate the authoritative receipt object,
 * do NOT touch the canonical order_number, and do NOT alter any financial,
 * monetary, or backend contract.
 *
 * Logo resolution reuses the official property-branding serve-URL helper so
 * the receipt always reflects the active Property Branding logo (never a
 * hardcoded asset, never a POS-specific logo setting).
 */
import type { PosReceiptOrder, PosReceiptBranding } from '../pos/posReceiptTypes.ts';
import { getLogoServeUrl } from '../propertySettings/propertyBrandingLogoUrl.ts';

// ── Logo ──────────────────────────────────────────────────────────────────

/**
 * Resolve the property-branding logo managed storage key into a browser-
 * servable URL using the official `getLogoServeUrl` helper (single
 * implementation — no duplicated URL parsing).
 *
 * Source of truth stays the active Property Branding:
 * `branding.logo_url` + `propertyId`.  A logo re-upload changes the UUID,
 * so the next receipt automatically serves the new logo. No hardcoded
 * asset, no POS-specific logo setting.
 *
 * - branding null / logo_url null / empty            → null (no <img>)
 * - managed key → getLogoServeUrl serve URL (used as-is)
 * - external/non-managed URL (helper returns null)   → raw key, per the
 *   existing helper contract ("falls through to the caller's fallback")
 */
export function resolveReceiptLogoUrl(
  branding: PosReceiptBranding | null | undefined,
  propertyId: number,
): string | null {
  const key = branding?.logo_url ?? null;
  if (!key || !propertyId) return null;
  return getLogoServeUrl(key, propertyId) || key;
}

// ── Short display order reference ─────────────────────────────────────────

/**
 * Build a compact, human-friendly order reference for the thermal receipt:
 *   POS-YYMMDD-<ORDER_ID_PADDED>
 *
 * - Uses `order.id` (authoritative, unique DB identifier) — NOT the full
 *   canonical order_number (which embeds a crypto UUID and is too long).
 * - Date priority: order.created_at → sale.created_at → settlement.created_at.
 *   The FIRST candidate with a valid ISO date prefix wins (an invalid or
 *   missing earlier candidate falls through to the next); printedAt is
 *   deliberately NOT used so a reprint on a later day still shows the same
 *   reference.
 * - The date is taken from the ISO prefix (stable string slice, no timezone
 *   shift that could move the business date).
 * - ID is zero-padded to a minimum of 4 digits and NEVER truncated.
 *
 * Fail-safe: if order.id is not a positive integer or no valid source date
 * exists, returns the canonical `order.order_number` unchanged.
 */
export function formatPosReceiptOrderReference(
  order: Pick<PosReceiptOrder, 'id' | 'order_number' | 'created_at'>,
  saleCreatedAt?: string | null,
  settlementCreatedAt?: string | null,
): string {
  if (!Number.isInteger(order.id) || order.id <= 0) {
    return order.order_number;
  }

  const sourceDate =
    [order.created_at, saleCreatedAt, settlementCreatedAt].find(
      isValidIsoDatePrefix,
    ) ?? null;
  if (!sourceDate) {
    return order.order_number;
  }

  const ymd = sourceDate.slice(0, 10); // "YYYY-MM-DD"
  const yy = ymd.slice(2, 4);
  const mm = ymd.slice(5, 7);
  const dd = ymd.slice(8, 10);
  const yymmdd = `${yy}${mm}${dd}`;
  const paddedId = String(order.id).padStart(4, '0');

  return `POS-${yymmdd}-${paddedId}`;
}

function isValidIsoDatePrefix(s: string | null | undefined): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s);
}

// ── Optional text (guest / table) ─────────────────────────────────────────

const GUEST_PLACEHOLDERS = new Set(['walk-in guest', 'guest']);

/**
 * Normalize an optional receipt GUEST name for display.
 *
 * - null / undefined / "" / whitespace-only  → null (row hidden)
 * - case-insensitive "Walk-in Guest" / "Guest" → null (row hidden, NOT a real
 *   name and never rendered as a fallback)
 * - real name                                  → trimmed value (row shown)
 *
 * Never mutates the receipt object; returns a new trimmed string or null.
 */
export function normalizeOptionalGuestName(
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (GUEST_PLACEHOLDERS.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

/**
 * Normalize an optional receipt TABLE number for display.
 *
 * - null / undefined / "" / whitespace-only  → null (row hidden)
 * - any real stored value (e.g. "12", "Table 1") → trimmed value (row shown)
 *
 * No placeholder/fallback is ever synthesized (no "Takeaway", "Table 1",
 * "-", "N/A").
 */
export function normalizeOptionalTableNumber(
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

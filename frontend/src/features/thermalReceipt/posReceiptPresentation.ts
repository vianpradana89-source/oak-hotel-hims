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
 *   The FIRST candidate with a valid supported receipt date wins (an invalid
 *   or missing earlier candidate falls through to the next).  Supported
 *   input forms: ISO / date-only with actual calendar-date validation
 *   (malformed dates such as "2026-99-99" are rejected), and the actual
 *   backend JS-Date string form.  `printedAt` is deliberately NOT used so a
 *   reprint on a later day still shows the same reference.
 * - The date is normalized to a stable "YYYY-MM-DD" string (UTC-safe, no
 *   local-timezone shift that could move the business date).
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
      isValidDateValue,
    ) ?? null;
  if (!sourceDate) {
    return order.order_number;
  }

  const ymd = extractReceiptDateYmd(sourceDate)!; // "YYYY-MM-DD"
  const yy = ymd.slice(2, 4);
  const mm = ymd.slice(5, 7);
  const dd = ymd.slice(8, 10);
  const yymmdd = `${yy}${mm}${dd}`;
  const paddedId = String(order.id).padStart(4, '0');

  return `POS-${yymmdd}-${paddedId}`;
}

// ── Date normalization (presentation-only, defensive) ─────────────────────
//
// Real backend receipt payloads emit JS-Date strings of the form:
//   "Thu Oct 15 2026 05:43:38 GMT+0000 (Coordinated Universal Time)"
// in addition to ISO / date-only forms. extractReceiptDateYmd normalizes all
// of them to a stable "YYYY-MM-DD" without relying on local timezone math.

/**
 * Extract a stable "YYYY-MM-DD" from a receipt timestamp string.
 *
 * Supported input forms:
 *   - ISO / date-only: "2026-10-15T03:50:00.000Z" or "2026-10-15"
 *     → taken directly from the leading date prefix (no Date parsing, no tz
 *       shift — the prefix is the authoritative business date).
 *   - JS Date toString: "Thu Oct 15 2026 05:43:38 GMT+0000 (...)"
 *     → parsed defensively with Date (UTC) and emitted as the UTC date, so a
 *       GMT+0000 stamp yields its UTC calendar date.
 *
 * Returns null when the value is not a recognizable timestamp. Never throws,
 * never mutates input, never invents a date.
 */
export function extractReceiptDateYmd(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s.length === 0) return null;

  // ISO / date-only: read the leading YYYY-MM-DD prefix, then verify it is a
  // real calendar date (reject malformed values such as 2026-99-99,
  // 2026-02-30, 2026-13-01, etc.).
  //
  // If the calendar check fails we must return null — we do NOT fall through
  // to JS-Date parsing, because Date.parse("2026-02-29") would silently roll
  // forward to 2026-03-01 instead of rejecting the malformed date.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const da = Number(m[3]);
    if (isValidCalendarDateUtc(y, mo, da)) return `${m[1]}-${m[2]}-${m[3]}`;
    return null; // malformed ISO date — fail-closed
  }

  // JS Date toString form: parse defensively, then emit UTC calendar date.
  const parsed = Date.parse(s);
  if (Number.isNaN(parsed)) return null;
  const d = new Date(parsed);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

/**
 * UTC-safe calendar validation without timezone drift.
 * Uses Date.UTC + getUTC* comparison so no local-timezone offset can affect
 * the result (the "month rolls forward" edge case — e.g. Feb 30 → Mar 2 —
 * is caught by comparing the emitted Y/M/D against the input).
 */
function isValidCalendarDateUtc(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const utc = Date.UTC(year, month - 1, day);
  const d = new Date(utc);
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

function isValidDateValue(s: string | null | undefined): s is string {
  return extractReceiptDateYmd(s) !== null;
}

// ── Optional text (guest / table) ─────────────────────────────────────────

const GUEST_PLACEHOLDERS = new Set(['walk-in guest', 'guest']);

/**
 * Walk-in style TABLE placeholders that must stay hidden on the receipt.
 * Case-insensitive, matched after trim. Real stored values (e.g. "12",
 * "Table 1", "A-03") are always shown.
 */
const TABLE_PLACEHOLDERS = new Set([
  'walk in',
  'walk-in',
  'walk in guest',
  'walk-in guest',
]);

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
  if (trimmed.length === 0) return null;
  // Hide walk-in style placeholders; show real stored values.
  if (TABLE_PLACEHOLDERS.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

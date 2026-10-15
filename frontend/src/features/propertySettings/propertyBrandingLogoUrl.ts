/**
 * Pure property-branding logo URL transformation.
 *
 * Single implementation of getLogoServeUrl. No authenticatedFetch, no React,
 * no browser-only dependency.
 *
 * Re-exported by propertyBrandingApi.ts for backward compatibility.
 */

/**
 * Convert a managed storage key to a backend serve URL.
 * Example: "branding/1/logo/{uuid}.png" -> "/api/properties/1/branding/logo/logo?v={uuid}"
 *
 * The ?v=<uuid> query parameter enables cache busting:
 * - Each upload generates a new UUID, changing the URL and bypassing browser cache.
 * - After logo deletion (null key), this returns null so the <img> src disappears.
 * - External/manual URLs (non-managed) fall through to the caller's fallback.
 */
export function getLogoServeUrl(storageKey: string | null | undefined, propertyId?: number): string | null {
  if (!storageKey || !propertyId) return null;
  const parts = storageKey.split('/').filter(Boolean);
  // Expected format: branding/{propertyId}/{variant}/{uuid}.ext
  // indices:         [0]      [1]          [2]      [3]
  if (parts.length < 4 || parts[0] !== 'branding') return null;
  // Validate property scope: key must belong to requested property
  const keyPropertyId = Number(parts[1]);
  if (!Number.isInteger(keyPropertyId) || keyPropertyId !== propertyId) return null;
  const variant = parts[2] === 'compact' ? 'compact' : 'logo';
  // Extract the UUID from the filename for cache-busting: "{uuid}.ext"
  const filename = parts[3];
  const uuid = filename.includes('.') ? filename.slice(0, filename.lastIndexOf('.')) : filename;
  return `/api/properties/${propertyId}/branding/logo/${variant}?v=${encodeURIComponent(uuid)}`;
}

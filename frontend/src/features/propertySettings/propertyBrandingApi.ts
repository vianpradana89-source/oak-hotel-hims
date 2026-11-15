import type { PropertyBrandingConfig } from './propertyBrandingTypes';
import { getFallbackPropertyBranding } from './propertyBrandingTypes';
import { authenticatedFetch } from '../../lib/authenticatedFetch';

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

/**
 * Fetch authoritative property branding from API
 */
export async function fetchPropertyBranding(
  propertyId: number,
  fallbackName?: string,
  fallbackCode?: string
): Promise<PropertyBrandingConfig> {
  try {
    const res = await authenticatedFetch(`/api/properties/${propertyId}/branding`);
    if (!res.ok) {
      return getFallbackPropertyBranding(propertyId, fallbackName, fallbackCode);
    }
    const json = await res.json();
    if (json.status === 'OK' && json.data) {
      const data = json.data;
      return {
        propertyId: data.property_id || propertyId,
        displayName: data.display_name || fallbackName || `Property ${propertyId}`,
        shortName: data.short_name || fallbackCode || `P${propertyId}`,
        tagline: data.tagline || 'Hospitality Management System',
        primaryColor: data.primary_color || '#1b4332',
        accentColor: data.accent_color || '#c5a880',
        logoUrl: data.logo_url || null,
        compactLogoUrl: data.compact_logo_url || null,
      };
    }
    return getFallbackPropertyBranding(propertyId, fallbackName, fallbackCode);
  } catch {
    return getFallbackPropertyBranding(propertyId, fallbackName, fallbackCode);
  }
}

/**
 * Save authoritative property branding to API
 */
export async function savePropertyBranding(
  propertyId: number,
  config: Partial<PropertyBrandingConfig>
): Promise<PropertyBrandingConfig> {
  const payload = {
    display_name: config.displayName,
    short_name: config.shortName,
    tagline: config.tagline,
    primary_color: config.primaryColor,
    accent_color: config.accentColor,
    logo_url: config.logoUrl,
    compact_logo_url: config.compactLogoUrl,
  };

  const res = await authenticatedFetch(`/api/properties/${propertyId}/branding`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.message || `Gagal menyimpan branding (HTTP ${res.status})`);
  }

  const json = await res.json();
  if (json.status !== 'OK' || !json.data) {
    throw new Error(json.message || 'Respon server tidak valid saat menyimpan branding');
  }

  const data = json.data;
  return {
    propertyId: data.property_id || propertyId,
    displayName: data.display_name,
    shortName: data.short_name,
    tagline: data.tagline,
    primaryColor: data.primary_color,
    accentColor: data.accent_color,
    logoUrl: data.logo_url || null,
    compactLogoUrl: data.compact_logo_url || null,
  };
}

/**
 * Upload a logo image for a property.
 * Returns the updated branding config with logo URLs.
 */
export async function uploadPropertyLogo(
  propertyId: number,
  file: File
): Promise<PropertyBrandingConfig> {
  const formData = new FormData();
  formData.append('logo', file);

  const res = await authenticatedFetch(`/api/properties/${propertyId}/branding/logo`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.message || `Gagal mengunggah logo (HTTP ${res.status})`);
  }

  const json = await res.json();
  if (json.status !== 'OK' || !json.data) {
    throw new Error(json.message || 'Respon server tidak valid saat mengunggah logo');
  }

  // Re-fetch branding to get consistent state
  return fetchPropertyBranding(propertyId);
}

/**
 * Delete the uploaded logo for a property.
 */
export async function deletePropertyLogo(propertyId: number): Promise<void> {
  const res = await authenticatedFetch(`/api/properties/${propertyId}/branding/logo`, {
    method: 'DELETE',
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.message || `Gagal menghapus logo (HTTP ${res.status})`);
  }
}

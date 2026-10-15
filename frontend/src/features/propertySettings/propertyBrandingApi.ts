import type { PropertyBrandingConfig } from './propertyBrandingTypes';
import { getFallbackPropertyBranding } from './propertyBrandingTypes';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import { getLogoServeUrl } from './propertyBrandingLogoUrl';

// Re-export so existing consumers keep working:
//   import { getLogoServeUrl } from './propertyBrandingApi';
// The single implementation lives in propertyBrandingLogoUrl.ts.
export { getLogoServeUrl };

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

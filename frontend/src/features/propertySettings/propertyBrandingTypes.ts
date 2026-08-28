export interface PropertyBrandingConfig {
  propertyId: number;
  displayName: string;
  shortName: string;
  logoUrl?: string | null;
  compactLogoUrl?: string | null;
  primaryColor: string;
  accentColor: string;
  tagline: string;
}

export const HEX_COLOR_REGEX = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;

export function isValidHexColor(color: unknown): color is string {
  if (typeof color !== 'string') return false;
  return HEX_COLOR_REGEX.test(color.trim());
}

export const DEFAULT_BRANDING_VALUES = {
  primaryColor: '#1b4332',
  accentColor: '#c5a880',
  tagline: 'Hospitality Management System',
};

export function getFallbackPropertyBranding(
  propertyId: number,
  propertyName?: string,
  propertyCode?: string
): PropertyBrandingConfig {
  return {
    propertyId,
    displayName: propertyName || (propertyId === 1 ? 'OAK Lawang' : `Property ${propertyId}`),
    shortName: propertyCode || (propertyId === 1 ? 'LWG' : `P${propertyId}`),
    logoUrl: null,
    compactLogoUrl: null,
    primaryColor: DEFAULT_BRANDING_VALUES.primaryColor,
    accentColor: DEFAULT_BRANDING_VALUES.accentColor,
    tagline: DEFAULT_BRANDING_VALUES.tagline,
  };
}

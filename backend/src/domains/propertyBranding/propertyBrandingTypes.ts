export interface PropertyBrandingRecord {
  id?: number;
  property_id: number;
  display_name: string;
  short_name: string;
  tagline: string;
  primary_color: string;
  accent_color: string;
  logo_url: string | null;
  compact_logo_url: string | null;
  created_at?: Date | string;
  updated_at?: Date | string;
}

export interface UpdatePropertyBrandingDTO {
  display_name?: string;
  short_name?: string;
  tagline?: string;
  primary_color?: string;
  accent_color?: string;
  logo_url?: string | null;
  compact_logo_url?: string | null;
}

export const HEX_COLOR_REGEX = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;

export function isValidHexColor(color: unknown): color is string {
  if (typeof color !== 'string') return false;
  return HEX_COLOR_REGEX.test(color.trim());
}

export const DEFAULT_BRANDING = {
  primary_color: '#1b4332',
  accent_color: '#c5a880',
  tagline: 'Hospitality Management System',
};

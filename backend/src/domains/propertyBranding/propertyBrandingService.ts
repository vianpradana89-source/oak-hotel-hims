import { Pool } from 'pg';
import {
  PropertyBrandingRecord,
  UpdatePropertyBrandingDTO,
  isValidHexColor,
  DEFAULT_BRANDING,
} from './propertyBrandingTypes';

export class PropertyBrandingError extends Error {
  code: string;
  statusCode: number;

  constructor(message: string, code: string, statusCode: number = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, PropertyBrandingError.prototype);
  }
}

export async function getPropertyBranding(
  pool: Pool,
  propertyId: number
): Promise<PropertyBrandingRecord> {
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw new PropertyBrandingError('Invalid property ID', 'VALIDATION_ERROR', 400);
  }

  // 1. Check property existence
  const propRes = await pool.query(
    'SELECT id, name, property_code FROM properties WHERE id = $1',
    [propertyId]
  );

  if ((propRes.rowCount ?? 0) === 0) {
    throw new PropertyBrandingError(
      `Property with ID ${propertyId} not found`,
      'PROPERTY_NOT_FOUND',
      404
    );
  }

  const prop = propRes.rows[0];

  // 2. Fetch custom branding if configured
  const brandingRes = await pool.query(
    `SELECT id, property_id, display_name, short_name, tagline, primary_color, accent_color, logo_url, compact_logo_url, created_at, updated_at
     FROM property_brandings
     WHERE property_id = $1`,
    [propertyId]
  );

  if ((brandingRes.rowCount ?? 0) > 0) {
    const row = brandingRes.rows[0];
    return {
      id: row.id,
      property_id: row.property_id,
      display_name: row.display_name || prop.name,
      short_name: row.short_name || prop.property_code,
      tagline: row.tagline || DEFAULT_BRANDING.tagline,
      primary_color: row.primary_color || DEFAULT_BRANDING.primary_color,
      accent_color: row.accent_color || DEFAULT_BRANDING.accent_color,
      logo_url: row.logo_url || null,
      compact_logo_url: row.compact_logo_url || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  // 3. Dynamic fallback derived from authoritative property row
  return {
    property_id: prop.id,
    display_name: prop.name,
    short_name: prop.property_code,
    tagline: DEFAULT_BRANDING.tagline,
    primary_color: DEFAULT_BRANDING.primary_color,
    accent_color: DEFAULT_BRANDING.accent_color,
    logo_url: null,
    compact_logo_url: null,
  };
}

export async function updatePropertyBranding(
  pool: Pool,
  propertyId: number,
  dto: UpdatePropertyBrandingDTO
): Promise<PropertyBrandingRecord> {
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw new PropertyBrandingError('Invalid property ID', 'VALIDATION_ERROR', 400);
  }

  // 1. Check property existence
  const propRes = await pool.query(
    'SELECT id, name, property_code FROM properties WHERE id = $1',
    [propertyId]
  );

  if ((propRes.rowCount ?? 0) === 0) {
    throw new PropertyBrandingError(
      `Property with ID ${propertyId} not found`,
      'PROPERTY_NOT_FOUND',
      404
    );
  }

  const prop = propRes.rows[0];

  // 2. Validate and normalize colors if provided
  let primaryColor = DEFAULT_BRANDING.primary_color;
  if (dto.primary_color !== undefined && dto.primary_color !== null && String(dto.primary_color).trim() !== '') {
    const trimmed = String(dto.primary_color).trim();
    if (!isValidHexColor(trimmed)) {
      throw new PropertyBrandingError(
        'Invalid primary_color format: must be valid hex code (e.g. #1b4332)',
        'VALIDATION_ERROR',
        400
      );
    }
    primaryColor = trimmed;
  }

  let accentColor = DEFAULT_BRANDING.accent_color;
  if (dto.accent_color !== undefined && dto.accent_color !== null && String(dto.accent_color).trim() !== '') {
    const trimmed = String(dto.accent_color).trim();
    if (!isValidHexColor(trimmed)) {
      throw new PropertyBrandingError(
        'Invalid accent_color format: must be valid hex code (e.g. #c5a880)',
        'VALIDATION_ERROR',
        400
      );
    }
    accentColor = trimmed;
  }

  // 3. Normalize strings
  const displayName = dto.display_name !== undefined && dto.display_name !== null
    ? String(dto.display_name).trim().slice(0, 200) || prop.name
    : prop.name;

  const shortName = dto.short_name !== undefined && dto.short_name !== null
    ? String(dto.short_name).trim().slice(0, 20) || prop.property_code
    : prop.property_code;

  const tagline = dto.tagline !== undefined && dto.tagline !== null
    ? String(dto.tagline).trim().slice(0, 255)
    : DEFAULT_BRANDING.tagline;

  const logoUrl = dto.logo_url !== undefined && dto.logo_url !== null
    ? String(dto.logo_url).trim().slice(0, 500) || null
    : null;

  const compactLogoUrl = dto.compact_logo_url !== undefined && dto.compact_logo_url !== null
    ? String(dto.compact_logo_url).trim().slice(0, 500) || null
    : null;

  // 4. Upsert into property_brandings
  const upsertRes = await pool.query(
    `INSERT INTO property_brandings (
       property_id, display_name, short_name, tagline, primary_color, accent_color, logo_url, compact_logo_url, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP
     )
     ON CONFLICT (property_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       short_name = EXCLUDED.short_name,
       tagline = EXCLUDED.tagline,
       primary_color = EXCLUDED.primary_color,
       accent_color = EXCLUDED.accent_color,
       logo_url = EXCLUDED.logo_url,
       compact_logo_url = EXCLUDED.compact_logo_url,
       updated_at = CURRENT_TIMESTAMP
     RETURNING id, property_id, display_name, short_name, tagline, primary_color, accent_color, logo_url, compact_logo_url, created_at, updated_at`,
    [propertyId, displayName, shortName, tagline, primaryColor, accentColor, logoUrl, compactLogoUrl]
  );

  const row = upsertRes.rows[0];
  return {
    id: row.id,
    property_id: row.property_id,
    display_name: row.display_name,
    short_name: row.short_name,
    tagline: row.tagline,
    primary_color: row.primary_color,
    accent_color: row.accent_color,
    logo_url: row.logo_url,
    compact_logo_url: row.compact_logo_url,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

import { Pool } from 'pg';
import type {
  RegistrationFormClause,
  PropertyRegistrationFormTermsRecord,
  UpdatePropertyRegistrationFormTermsDTO,
} from './registrationFormTermsTypes';
import { MAX_CLAUSE_COUNT, MAX_CLAUSE_CHARS } from './registrationFormTermsTypes';

export class RegistrationFormTermsError extends Error {
  code: string;
  statusCode: number;

  constructor(message: string, code: string, statusCode: number = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, RegistrationFormTermsError.prototype);
  }
}

export function validateClauses(clauses: unknown): { valid: boolean; error?: string; clauses?: RegistrationFormClause[] } {
  if (!Array.isArray(clauses)) {
    return { valid: false, error: 'terms_content harus berupa array' };
  }

  if (clauses.length === 0) {
    return { valid: false, error: 'Minimal 1 clause diperlukan' };
  }

  if (clauses.length > MAX_CLAUSE_COUNT) {
    return { valid: false, error: `Maksimal ${MAX_CLAUSE_COUNT} clause` };
  }

  const validClauses: RegistrationFormClause[] = [];

  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i];

    if (clause === null || clause === undefined) {
      return { valid: false, error: `Clause pada indeks ${i} tidak boleh kosong` };
    }

    if (typeof clause !== 'object') {
      return { valid: false, error: `Clause pada indeks ${i} harus berupa object` };
    }

    const obj = clause as Record<string, unknown>;

    if (!('text' in obj) || typeof obj.text !== 'string') {
      return { valid: false, error: `Clause pada indeks ${i} harus memiliki field 'text' string` };
    }

    const trimmed = obj.text.trim();

    if (trimmed.length === 0) {
      return { valid: false, error: `Clause pada indeks ${i} tidak boleh kosong setelah di-trim` };
    }

    if (trimmed.length > MAX_CLAUSE_CHARS) {
      return { valid: false, error: `Clause pada indeks ${i} melebihi ${MAX_CLAUSE_CHARS} karakter` };
    }

    validClauses.push({ text: trimmed });
  }

  return { valid: true, clauses: validClauses };
}

export function validatePersistedClauses(content: unknown): { valid: boolean; error?: string } {
  if (!Array.isArray(content)) {
    return { valid: false, error: 'REGISTRATION_TERMS_DATA_INVALID: terms_content bukan array' };
  }

  for (let i = 0; i < content.length; i++) {
    const item = content[i];
    if (!item || typeof item !== 'object' || !('text' in item) || typeof (item as any).text !== 'string') {
      return { valid: false, error: `REGISTRATION_TERMS_DATA_INVALID: clause pada indeks ${i} tidak valid` };
    }
  }

  return { valid: true };
}

export async function getPropertyRegistrationFormTerms(
  pool: Pool,
  propertyId: number
): Promise<PropertyRegistrationFormTermsRecord | null> {
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw new RegistrationFormTermsError(
      'Invalid property ID parameter',
      'VALIDATION_ERROR',
      400
    );
  }

  // 1. Verify property existence
  const propCheck = await pool.query(
    'SELECT id FROM properties WHERE id = $1',
    [propertyId]
  );

  if ((propCheck.rowCount ?? 0) === 0) {
    throw new RegistrationFormTermsError(
      `Property with ID ${propertyId} not found`,
      'PROPERTY_NOT_FOUND',
      404
    );
  }

  // 2. Fetch saved terms
  const res = await pool.query(
    `SELECT id, property_id, terms_content, is_active, created_at, updated_at, updated_by
     FROM property_registration_form_terms
     WHERE property_id = $1`,
    [propertyId]
  );

  if ((res.rowCount ?? 0) > 0) {
    const row = res.rows[0];
    const content = row.terms_content;

    if (!content) {
      throw new RegistrationFormTermsError(
        'REGISTRATION_TERMS_DATA_INVALID: terms_content kosong',
        'REGISTRATION_TERMS_DATA_INVALID',
        500
      );
    }

    // Validate structure of persisted data
    const validation = validatePersistedClauses(content);
    if (!validation.valid) {
      throw new RegistrationFormTermsError(
        validation.error!,
        'REGISTRATION_TERMS_DATA_INVALID',
        500
      );
    }

    // Sanitize for safe response
    const sanitized: RegistrationFormClause[] = content.map((c: any) => ({
      text: typeof c.text === 'string' ? c.text.trim() : c.text,
    })).filter((c: RegistrationFormClause) => c.text.length > 0);

    if (sanitized.length === 0) {
      throw new RegistrationFormTermsError(
        'REGISTRATION_TERMS_DATA_INVALID: terms_content tidak memiliki clause valid',
        'REGISTRATION_TERMS_DATA_INVALID',
        500
      );
    }

    return {
      id: row.id,
      property_id: row.property_id,
      terms_content: sanitized,
      is_active: row.is_active !== false,
      created_at: row.created_at?.toISOString() || undefined,
      updated_at: row.updated_at?.toISOString() || undefined,
      updated_by: row.updated_by || null,
    };
  }

  // 3. No saved terms yet
  return null;
}

export async function updatePropertyRegistrationFormTerms(
  pool: Pool,
  propertyId: number,
  dto: UpdatePropertyRegistrationFormTermsDTO,
  actorName?: string
): Promise<PropertyRegistrationFormTermsRecord> {
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw new RegistrationFormTermsError(
      'Invalid property ID parameter',
      'VALIDATION_ERROR',
      400
    );
  }

  // 1. Verify property existence
  const propCheck = await pool.query(
    'SELECT id FROM properties WHERE id = $1',
    [propertyId]
  );

  if ((propCheck.rowCount ?? 0) === 0) {
    throw new RegistrationFormTermsError(
      `Property with ID ${propertyId} not found`,
      'PROPERTY_NOT_FOUND',
      404
    );
  }

  // 2. Validate clauses structure
  const validation = validateClauses(dto.terms_content);
  if (!validation.valid) {
    throw new RegistrationFormTermsError(
      validation.error!,
      'VALIDATION_ERROR',
      400
    );
  }

  // 3. Use SANITIZED clauses from validation result (not raw dto)
  const clauses = validation.clauses!;
  const isActive = dto.is_active !== undefined ? Boolean(dto.is_active) : true;
  const actor = actorName ? actorName.trim().slice(0, 100) : 'SYSTEM';

  // 4. Atomic upsert
  const query = `
    INSERT INTO property_registration_form_terms (
      property_id, terms_content, is_active, updated_by, updated_at
    ) VALUES ($1, $2::jsonb, $3, $4, NOW())
    ON CONFLICT (property_id)
    DO UPDATE SET
      terms_content = EXCLUDED.terms_content,
      is_active = EXCLUDED.is_active,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
    RETURNING id, property_id, terms_content, is_active, created_at, updated_at, updated_by;
  `;

  const values = [propertyId, JSON.stringify(clauses), isActive, actor];
  const res = await pool.query(query, values);
  const row = res.rows[0];

  return {
    id: row.id,
    property_id: row.property_id,
    terms_content: row.terms_content || [],
    is_active: row.is_active !== false,
    created_at: row.created_at?.toISOString() || undefined,
    updated_at: row.updated_at?.toISOString() || undefined,
    updated_by: row.updated_by || null,
  };
}

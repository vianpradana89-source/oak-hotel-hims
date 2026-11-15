import type { Pool } from 'pg';
import type {
  PosPricingSettingsRecord,
  PosPricingSettingsData,
  UpdatePosPricingSettingsDTO,
} from './posPricingSettingsTypes';

/**
 * POS Pricing Settings — service layer.
 *
 * Manages the dedicated table property_pos_pricing_settings:
 *   - service_charge_enabled BOOLEAN NOT NULL DEFAULT FALSE
 *   - service_charge_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00
 *   - tax_enabled            BOOLEAN NOT NULL DEFAULT FALSE
 *   - tax_percent            NUMERIC(5,2) NOT NULL DEFAULT 0.00
 *
 * One row per property. Updates are atomic: settings upsert + audit log
 * INSERT execute in the same DB transaction. If the audit write fails,
 * the entire transaction rolls back, guaranteeing settings + audit stay
 * in sync (no orphan updates, no silent partial writes).
 *
 * GET behavior (row absent): returns in-memory defaults WITHOUT inserting:
 *   service_charge_enabled = false, service_charge_percent = 0,
 *   tax_enabled            = false, tax_percent            = 0
 *
 * The id column is BIGINT GENERATED ALWAYS AS IDENTITY; the service
 * never supplies it — Postgres generates it on INSERT.
 *
 * V1 EXCLUSIVE ONLY: no prices_include_service / prices_include_tax.
 */

export class PosPricingSettingsError extends Error {
  constructor(message: string, public code: string, public statusCode: number = 400) {
    super(message);
    Object.setPrototypeOf(this, PosPricingSettingsError.prototype);
  }
}

/**
 * Validate a numeric percent value: must be a finite number between 0 and 100.
 * Percent values with more than 2 decimal places are rejected (NUMERIC(5,2)).
 */
function validatePercent(field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PosPricingSettingsError(
      `${field} harus angka antara 0 dan 100.`,
      'VALIDATION_ERROR',
    );
  }
  if (value < 0 || value > 100) {
    throw new PosPricingSettingsError(
      `${field} harus antara 0 dan 100.`,
      'VALIDATION_ERROR',
    );
  }
  // Reject more than 2 decimal places (NUMERIC(5,2) enforces this too,
  // but validate early for a clearer 400 message).
  const rounded = Math.round(value * 100) / 100;
  if (rounded !== value) {
    throw new PosPricingSettingsError(
      `${field} maksimal 2 desimal.`,
      'VALIDATION_ERROR',
    );
  }
  return rounded;
}

/** Fields accepted in a PUT DTO. Anything else is rejected. */
const ALLOWED_DTO_KEYS = new Set([
  'property_id',
  'service_charge_enabled',
  'service_charge_percent',
  'tax_enabled',
  'tax_percent',
]);

const SETTINGS_TABLE = 'property_pos_pricing_settings';

/**
 * Build a canonical settings record.
 * - No row (GET before first PUT) → in-memory defaults: all disabled, 0.00.
 * - Existing row → return as stored.
 */
function record(row: Record<string, unknown> | undefined, propertyId: number): PosPricingSettingsRecord {
  if (!row) {
    return {
      property_id: propertyId,
      service_charge_enabled: false,
      service_charge_percent: 0,
      tax_enabled: false,
      tax_percent: 0,
    };
  }
  const r = { ...row } as unknown as Record<string, unknown>;
  return {
    property_id: propertyId,
    service_charge_enabled: Boolean(r.service_charge_enabled ?? false),
    service_charge_percent: Number(r.service_charge_percent ?? 0),
    tax_enabled: Boolean(r.tax_enabled ?? false),
    tax_percent: Number(r.tax_percent ?? 0),
    created_at: typeof r.created_at === 'string' ? r.created_at : undefined,
    updated_at: typeof r.updated_at === 'string' ? r.updated_at : undefined,
    updated_by: typeof r.updated_by === 'string' ? r.updated_by : null,
  };
}

function assertPropertyId(propertyId: number): void {
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw new PosPricingSettingsError(
      'property_id wajib integer positif.',
      'VALIDATION_ERROR',
      400,
    );
  }
}

/**
 * Strictly validate the incoming DTO.
 * - service_charge_enabled / tax_enabled: must be boolean if present.
 * - service_charge_percent / tax_percent: finite number 0–100, max 2 decimals.
 * - Unknown top-level fields: rejected with 400.
 */
function patchFromDTO(dto: UpdatePosPricingSettingsDTO): Record<string, unknown> {
  if (!dto || typeof dto !== 'object' || Array.isArray(dto)) {
    throw new PosPricingSettingsError('Payload tidak valid.', 'VALIDATION_ERROR');
  }

  for (const key of Object.keys(dto)) {
    if (!ALLOWED_DTO_KEYS.has(key)) {
      throw new PosPricingSettingsError(
        `Field tidak dikenal: ${key}.`,
        'VALIDATION_ERROR',
        400,
      );
    }
  }

  const patch: Record<string, unknown> = {};

  // service_charge_enabled — strict boolean
  if (dto.service_charge_enabled !== undefined) {
    if (typeof dto.service_charge_enabled !== 'boolean') {
      throw new PosPricingSettingsError(
        'service_charge_enabled harus true atau false.',
        'VALIDATION_ERROR',
      );
    }
    patch.service_charge_enabled = dto.service_charge_enabled;
  }

  // service_charge_percent — finite number 0–100, max 2 decimals
  if (dto.service_charge_percent !== undefined) {
    patch.service_charge_percent = validatePercent('service_charge_percent', dto.service_charge_percent);
  }

  // tax_enabled — strict boolean
  if (dto.tax_enabled !== undefined) {
    if (typeof dto.tax_enabled !== 'boolean') {
      throw new PosPricingSettingsError(
        'tax_enabled harus true atau false.',
        'VALIDATION_ERROR',
      );
    }
    patch.tax_enabled = dto.tax_enabled;
  }

  // tax_percent — finite number 0–100, max 2 decimals
  if (dto.tax_percent !== undefined) {
    patch.tax_percent = validatePercent('tax_percent', dto.tax_percent);
  }

  return patch;
}

/**
 * GET — read-only settings lookup.
 * If no row exists for the property, returns the in-memory canonical defaults
 * (all fields disabled / 0.00) WITHOUT inserting.
 * Property must exist (404 if not).
 */
export async function getPosPricingSettings(
  pool: Pool,
  propertyId: number,
): Promise<PosPricingSettingsRecord> {
  assertPropertyId(propertyId);

  const prop = await pool.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
  if ((prop.rows as unknown[]).length === 0) {
    throw new PosPricingSettingsError(
      'Properti tidak ditemukan.',
      'PROPERTY_NOT_FOUND',
      404,
    );
  }

  const result = await pool.query(
    `SELECT id, property_id,
            service_charge_enabled, service_charge_percent,
            tax_enabled, tax_percent,
            created_at, updated_at, updated_by
       FROM ${SETTINGS_TABLE}
      WHERE property_id = $1`,
    [propertyId],
  );

  return record(result.rows[0] as Record<string, unknown> | undefined, propertyId);
}

/**
 * PUT — upsert settings + write audit log in one transaction.
 *
 * Transaction boundary:
 *   BEGIN
 *     SELECT FOR UPDATE properties (404 if missing)
 *     read current row (may not exist → merge from defaults)
 *     INSERT ... ON CONFLICT (property_id) DO UPDATE ...
 *     INSERT INTO audit_logs (module, action, entity, record_id, ...)
 *   COMMIT
 *
 * If ANY step fails (including the audit INSERT), the whole
 * transaction rolls back — settings are not persisted without audit.
 */
export async function updatePosPricingSettings(
  pool: Pool,
  propertyId: number,
  dto: UpdatePosPricingSettingsDTO,
  actorName?: string | null,
  actorUserId?: string | null,
): Promise<PosPricingSettingsRecord> {
  const patch = patchFromDTO(dto);
  assertPropertyId(propertyId);

  const client = await pool.connect();
  let active = false;
  let discard = false;
  let primaryError: unknown = null;

  try {
    await client.query('BEGIN');
    active = true;

    // Property existence check (404)
    const prop = await client.query('SELECT id FROM properties WHERE id = $1 FOR UPDATE', [
      propertyId,
    ]);
    if ((prop.rows as unknown[]).length === 0) {
      throw new PosPricingSettingsError('Properti tidak ditemukan.', 'PROPERTY_NOT_FOUND', 404);
    }

    // Read current row (may not exist yet)
    const currentResult = await client.query(
      `SELECT id, property_id,
              service_charge_enabled, service_charge_percent,
              tax_enabled, tax_percent,
              created_at, updated_at, updated_by
         FROM ${SETTINGS_TABLE}
        WHERE property_id = $1`,
      [propertyId],
    );
    const current = record(
      currentResult.rows[0] as Record<string, unknown> | undefined,
      propertyId,
    );

    // Merge: patch fields override current; missing keys retain current
    const merged: PosPricingSettingsRecord = {
      property_id: propertyId,
      service_charge_enabled:
        patch.service_charge_enabled !== undefined
          ? (patch.service_charge_enabled as boolean)
          : current.service_charge_enabled,
      service_charge_percent:
        patch.service_charge_percent !== undefined
          ? (patch.service_charge_percent as number)
          : current.service_charge_percent,
      tax_enabled:
        patch.tax_enabled !== undefined
          ? (patch.tax_enabled as boolean)
          : current.tax_enabled,
      tax_percent:
        patch.tax_percent !== undefined
          ? (patch.tax_percent as number)
          : current.tax_percent,
    };

    // updated_by: truncate to 100 chars (matches VARCHAR(100) column),
    // 'SYSTEM' as fallback when actor not identified.
    const actor = (actorName?.trim() && actorName.trim().slice(0, 100)) || 'SYSTEM';

    // Upsert — id column omitted (GENERATED ALWAYS)
    const upsert = await client.query(
      `INSERT INTO ${SETTINGS_TABLE}
         (property_id,
          service_charge_enabled, service_charge_percent,
          tax_enabled, tax_percent,
          updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       ON CONFLICT (property_id) DO UPDATE
         SET service_charge_enabled = EXCLUDED.service_charge_enabled,
             service_charge_percent = EXCLUDED.service_charge_percent,
             tax_enabled            = EXCLUDED.tax_enabled,
             tax_percent            = EXCLUDED.tax_percent,
             updated_by             = EXCLUDED.updated_by,
             updated_at             = CURRENT_TIMESTAMP
       RETURNING id, property_id,
                 service_charge_enabled, service_charge_percent,
                 tax_enabled, tax_percent,
                 created_at, updated_at, updated_by`,
      [
        propertyId,
        merged.service_charge_enabled,
        merged.service_charge_percent,
        merged.tax_enabled,
        merged.tax_percent,
        actor,
      ],
    );

    if (!upsert.rows[0]) {
      throw new Error('POS pricing settings upsert returned no row');
    }

    // Audit log — atomic, in the same transaction as the settings write.
    // record_id = String(propertyId) (one row per property; the business key).
    // actor_user_id stored as string to match the existing VARCHAR column.
    await client.query(
      `INSERT INTO audit_logs
         (module, action, entity, record_id, new_value, property_id, actor_user_id)
       VALUES (
         'POS_PRICING',
         'POS_PRICING_SETTINGS_UPDATED',
         '${SETTINGS_TABLE}',
         $1,
         $2,
         $3,
         $4
       )`,
      [
        String(propertyId),
        JSON.stringify({
          property_id: propertyId,
          service_charge_enabled: merged.service_charge_enabled,
          service_charge_percent: merged.service_charge_percent,
          tax_enabled: merged.tax_enabled,
          tax_percent: merged.tax_percent,
          updated_by: actor,
        }),
        propertyId,
        actorUserId ? String(actorUserId) : null,
      ],
    );

    await client.query('COMMIT');
    active = false;

    return record(upsert.rows[0] as Record<string, unknown>, propertyId);
  } catch (err) {
    primaryError = err;
    if (active) {
      try {
        await client.query('ROLLBACK');
        active = false;
      } catch (rollbackErr) {
        // ROLLBACK failed — connection state is uncertain; mark for discard
        // so the pool does not hand this client to the next caller.
        discard = true;
        console.error('[POS PRICING SETTINGS] ROLLBACK failed (connection discarded):', rollbackErr);
      }
    }
    throw err; // always re-throw the primary/original error — never replace it
  } finally {
    try {
      // discard=true tells pg.Pool to remove this client from the pool
      // instead of returning it to the pool for reuse.
      client.release(discard || undefined);
    } catch (releaseErr) {
      // Release failure must never mask the primary error and must never
      // turn a successfully-committed transaction into a 500 response.
      if (primaryError) {
        // Error path: log but do not throw — primary error is already being
        // re-thrown from the catch block above; do not shadow it.
        console.error('[POS PRICING SETTINGS] release failed after error (primary error preserved):', releaseErr);
      } else {
        // Success path (COMMIT already acknowledged): log but do NOT throw.
        // The transaction is committed; a release failure is a pool-hygiene
        // issue, not a transaction failure. Throwing here would make the
        // caller believe the write failed when it actually succeeded,
        // potentially causing a dangerous duplicate retry.
        console.error('[POS PRICING SETTINGS] release failed after COMMIT (transaction already committed, result unaffected):', releaseErr);
      }
    }
  }
}

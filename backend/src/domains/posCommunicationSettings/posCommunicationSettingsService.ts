import type { Pool } from 'pg';
import type {
  PosCommunicationSettingsRecord,
  PosCommunicationSettingsData,
  UpdatePosCommunicationSettingsDTO,
} from './posCommunicationSettingsTypes';

/**
 * POS Communication Settings ΓÇö service layer.
 *
 * Manages the dedicated table property_pos_communication_settings:
 *   - whatsapp_enabled         BOOLEAN NOT NULL DEFAULT TRUE
 *   - whatsapp_intro_message   TEXT NULL
 *   - whatsapp_closing_message TEXT NULL
 *
 * One row per property. Updates are atomic: settings upsert + audit log
 * INSERT execute in the same DB transaction. If the audit write fails,
 * the entire transaction rolls back, guaranteeing settings + audit stay
 * in sync (no orphan updates, no silent partial writes).
 *
 * The id column is BIGINT GENERATED ALWAYS AS IDENTITY; the service
 * never supplies it ΓÇö Postgres generates it on INSERT.
 */

export class PosCommunicationSettingsError extends Error {
  constructor(message: string, public code: string, public statusCode: number = 400) {
    super(message);
    Object.setPrototypeOf(this, PosCommunicationSettingsError.prototype);
  }
}

/** Maximum length for intro/closing messages (enforced here, not in DDL). */
const MAX_MESSAGE_LENGTH = 500;

/** Fields accepted in a PUT DTO. Anything else is rejected. */
const ALLOWED_DTO_KEYS = new Set([
  'property_id',
  'whatsapp_enabled',
  'whatsapp_intro_message',
  'whatsapp_closing_message',
]);

const SETTINGS_TABLE = 'property_pos_communication_settings';

/**
 * Build a canonical settings record.
 * - No row (GET before first PUT) ΓåÆ defaults: enabled=true, nulls.
 * - Existing row ΓåÆ return as stored.
 */
function record(row: Record<string, unknown> | undefined, propertyId: number): PosCommunicationSettingsRecord {
  if (!row) {
    return {
      property_id: propertyId,
      whatsapp_enabled: true,
      whatsapp_intro_message: null,
      whatsapp_closing_message: null,
    };
  }
  const r = { ...row } as unknown as Record<string, unknown>;
  return {
    property_id: propertyId,
    whatsapp_enabled: Boolean(r.whatsapp_enabled ?? true),
    whatsapp_intro_message:
      typeof r.whatsapp_intro_message === 'string' ? r.whatsapp_intro_message : null,
    whatsapp_closing_message:
      typeof r.whatsapp_closing_message === 'string' ? r.whatsapp_closing_message : null,
    created_at: typeof r.created_at === 'string' ? r.created_at : undefined,
    updated_at: typeof r.updated_at === 'string' ? r.updated_at : undefined,
    updated_by: typeof r.updated_by === 'string' ? r.updated_by : null,
  };
}

function assertPropertyId(propertyId: number): void {
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw new PosCommunicationSettingsError(
      'property_id wajib integer positif.',
      'VALIDATION_ERROR',
      400,
    );
  }
}

/**
 * Strictly validate the incoming DTO.
 * - whatsapp_enabled: must be boolean if present.
 * - intro/closing:    string or null; trimmed; empty ΓåÆ null; max 500 chars.
 * - Unknown top-level fields: rejected with 400.
 */
function patchFromDTO(dto: UpdatePosCommunicationSettingsDTO): Record<string, unknown> {
  if (!dto || typeof dto !== 'object' || Array.isArray(dto)) {
    throw new PosCommunicationSettingsError('Payload tidak valid.', 'VALIDATION_ERROR');
  }

  for (const key of Object.keys(dto)) {
    if (!ALLOWED_DTO_KEYS.has(key)) {
      throw new PosCommunicationSettingsError(
        `Field tidak dikenal: ${key}.`,
        'VALIDATION_ERROR',
        400,
      );
    }
  }

  const patch: Record<string, unknown> = {};

  // whatsapp_enabled ΓÇö strict boolean type check
  if (dto.whatsapp_enabled !== undefined) {
    if (typeof dto.whatsapp_enabled !== 'boolean') {
      throw new PosCommunicationSettingsError(
        'whatsapp_enabled harus true atau false.',
        'VALIDATION_ERROR',
      );
    }
    patch.whatsapp_enabled = dto.whatsapp_enabled;
  }

  // intro / closing ΓÇö string | null, trimmed, empty ΓåÆ null, max 500
  for (const field of ['whatsapp_intro_message', 'whatsapp_closing_message'] as const) {
    const value = dto[field];
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'string') {
      throw new PosCommunicationSettingsError(
        `${field} harus teks atau kosong.`,
        'VALIDATION_ERROR',
      );
    }
    const normalized = value === null ? null : value.trim() || null;
    if (normalized !== null && normalized.length > MAX_MESSAGE_LENGTH) {
      throw new PosCommunicationSettingsError(
        `${field} maksimal ${MAX_MESSAGE_LENGTH} karakter.`,
        'VALIDATION_ERROR',
      );
    }
    patch[field] = normalized;
  }

  return patch;
}

/**
 * GET ΓÇö read-only settings lookup.
 * If no row exists for the property, returns the canonical defaults
 * (whatsapp_enabled=true, intro=null, closing=null) WITHOUT inserting.
 * Property must exist (404 if not).
 */
export async function getPosCommunicationSettings(
  pool: Pool,
  propertyId: number,
): Promise<PosCommunicationSettingsRecord> {
  assertPropertyId(propertyId);

  const prop = await pool.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
  if ((prop.rows as unknown[]).length === 0) {
    throw new PosCommunicationSettingsError(
      'Properti tidak ditemukan.',
      'PROPERTY_NOT_FOUND',
      404,
    );
  }

  const result = await pool.query(
    `SELECT id, property_id, whatsapp_enabled,
            whatsapp_intro_message, whatsapp_closing_message,
            created_at, updated_at, updated_by
       FROM ${SETTINGS_TABLE}
      WHERE property_id = $1`,
    [propertyId],
  );

  return record(result.rows[0] as Record<string, unknown> | undefined, propertyId);
}

/**
 * PUT ΓÇö upsert settings + write audit log in one transaction.
 *
 * Transaction boundary:
 *   BEGIN
 *     SELECT FOR UPDATE properties (404 if missing)
 *     read current row (may not exist ΓåÆ merge from defaults)
 *     INSERT ... ON CONFLICT (property_id) DO UPDATE ...
 *     INSERT INTO audit_logs (module, action, entity, record_id, ...)
 *   COMMIT
 *
 * If ANY step fails (including the audit INSERT), the whole
 * transaction rolls back ΓÇö settings are not persisted without audit.
 */
export async function updatePosCommunicationSettings(
  pool: Pool,
  propertyId: number,
  dto: UpdatePosCommunicationSettingsDTO,
  actorName?: string | null,
  actorUserId?: string | null,
): Promise<PosCommunicationSettingsRecord> {
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
      throw new PosCommunicationSettingsError('Properti tidak ditemukan.', 'PROPERTY_NOT_FOUND', 404);
    }

    // Read current row (may not exist yet)
    const currentResult = await client.query(
      `SELECT id, property_id, whatsapp_enabled,
              whatsapp_intro_message, whatsapp_closing_message,
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
    const merged: PosCommunicationSettingsRecord = {
      property_id: propertyId,
      whatsapp_enabled:
        patch.whatsapp_enabled !== undefined
          ? (patch.whatsapp_enabled as boolean)
          : current.whatsapp_enabled,
      whatsapp_intro_message:
        patch.whatsapp_intro_message !== undefined
          ? (patch.whatsapp_intro_message as string | null)
          : current.whatsapp_intro_message,
      whatsapp_closing_message:
        patch.whatsapp_closing_message !== undefined
          ? (patch.whatsapp_closing_message as string | null)
          : current.whatsapp_closing_message,
    };

    // updated_by: truncate to 100 chars (matches VARCHAR(100) column),
    // 'SYSTEM' as fallback when actor not identified.
    const actor = (actorName?.trim() && actorName.trim().slice(0, 100)) || 'SYSTEM';

    // Upsert ΓÇö id column omitted (GENERATED ALWAYS)
    const upsert = await client.query(
      `INSERT INTO ${SETTINGS_TABLE}
         (property_id, whatsapp_enabled, whatsapp_intro_message, whatsapp_closing_message, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (property_id) DO UPDATE
         SET whatsapp_enabled = EXCLUDED.whatsapp_enabled,
             whatsapp_intro_message = EXCLUDED.whatsapp_intro_message,
             whatsapp_closing_message = EXCLUDED.whatsapp_closing_message,
             updated_by = EXCLUDED.updated_by,
             updated_at = CURRENT_TIMESTAMP
       RETURNING id, property_id, whatsapp_enabled,
                 whatsapp_intro_message, whatsapp_closing_message,
                 created_at, updated_at, updated_by`,
      [
        propertyId,
        merged.whatsapp_enabled,
        merged.whatsapp_intro_message,
        merged.whatsapp_closing_message,
        actor,
      ],
    );

    if (!upsert.rows[0]) {
      throw new Error('POS communication settings upsert returned no row');
    }

    // Audit log ΓÇö atomic, in the same transaction as the settings write.
    // record_id = String(propertyId) (one row per property; the business key).
    // actor_user_id stored as string to match the existing VARCHAR column.
    await client.query(
      `INSERT INTO audit_logs
         (module, action, entity, record_id, new_value, property_id, actor_user_id)
       VALUES (
         'POS_COMMUNICATION',
         'POS_COMMUNICATION_SETTINGS_UPDATED',
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
          whatsapp_enabled: merged.whatsapp_enabled,
          whatsapp_intro_message: merged.whatsapp_intro_message,
          whatsapp_closing_message: merged.whatsapp_closing_message,
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
        // ROLLBACK failed ΓÇö connection state is uncertain; mark for discard
        // so the pool does not hand this client to the next caller.
        discard = true;
        console.error('[POS COMM SETTINGS] ROLLBACK failed (connection discarded):', rollbackErr);
      }
    }
    throw err; // always re-throw the primary/original error ΓÇö never replace it
  } finally {
    try {
      // discard=true tells pg.Pool to remove this client from the pool
      // instead of returning it to the pool for reuse.
      client.release(discard || undefined);
    } catch (releaseErr) {
      // Release failure must never mask the primary error and must never
      // turn a successfully-committed transaction into a 500 response.
      if (primaryError) {
        // Error path: log but do not throw ΓÇö primary error is already being
        // re-thrown from the catch block above; do not shadow it.
        console.error('[POS COMM SETTINGS] release failed after error (primary error preserved):', releaseErr);
      } else {
        // Success path (COMMIT already acknowledged): log but do NOT throw.
        // The transaction is committed; a release failure is a pool-hygiene
        // issue, not a transaction failure. Throwing here would make the
        // caller believe the write failed when it actually succeeded,
        // potentially causing a dangerous duplicate retry.
        console.error('[POS COMM SETTINGS] release failed after COMMIT (transaction already committed, result unaffected):', releaseErr);
      }
    }
  }
}

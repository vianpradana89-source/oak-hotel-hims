import { Pool } from 'pg';

export type FieldMode = 'REQUIRED' | 'OPTIONAL' | 'HIDDEN';

export interface QuickBookingRuleRow {
  id?: number;
  property_id: number;
  channel_type: 'WALK_IN' | 'OTA';
  field_key: string;
  field_mode: FieldMode;
  created_by?: string | null;
  created_at?: string;
  updated_by?: string | null;
  updated_at?: string;
}

export interface DayUseDurationRow {
  id: number;
  property_id: number;
  name: string;
  duration_minutes: number;
  sort_order: number;
  is_active: boolean;
  is_archived: boolean;
  created_by?: string | null;
  created_at?: string;
  updated_by?: string | null;
  updated_at?: string;
}

export const DEFAULT_BOOKING_FIELDS = [
  'booker_name',
  'booker_phone',
  'guest_name',
  'guest_phone',
  'guest_segment',
  'referral',
  'identity',
  'payment_method',
  'payment_amount',
  'payment_evidence',
  'rate_plan',
  'day_use'
];

export const DEFAULT_WALK_IN_RULES: Record<string, FieldMode> = {
  booker_name: 'OPTIONAL',
  booker_phone: 'OPTIONAL',
  guest_name: 'REQUIRED',
  guest_phone: 'OPTIONAL',
  guest_segment: 'OPTIONAL',
  referral: 'OPTIONAL',
  identity: 'OPTIONAL',
  payment_method: 'OPTIONAL',
  payment_amount: 'OPTIONAL',
  payment_evidence: 'OPTIONAL',
  rate_plan: 'OPTIONAL',
  day_use: 'OPTIONAL'
};

export const DEFAULT_OTA_RULES: Record<string, FieldMode> = {
  booker_name: 'OPTIONAL',
  booker_phone: 'OPTIONAL',
  guest_name: 'REQUIRED',
  guest_phone: 'OPTIONAL',
  guest_segment: 'OPTIONAL',
  referral: 'OPTIONAL',
  identity: 'OPTIONAL',
  payment_method: 'OPTIONAL',
  payment_amount: 'OPTIONAL',
  payment_evidence: 'OPTIONAL',
  rate_plan: 'OPTIONAL',
  day_use: 'HIDDEN'
};

export const DEFAULT_DAY_USE_PRESETS = [
  { name: '3 Jam', duration_minutes: 180, sort_order: 1 },
  { name: '4 Jam', duration_minutes: 240, sort_order: 2 },
  { name: '6 Jam', duration_minutes: 360, sort_order: 3 },
  { name: '8 Jam', duration_minutes: 480, sort_order: 4 },
  { name: '12 Jam', duration_minutes: 720, sort_order: 5 }
];

/**
 * Fetch all quick booking rules for property (WALK_IN and OTA)
 */
export async function getQuickBookingRules(pool: Pool, propertyId: number) {
  const result = await pool.query<QuickBookingRuleRow>(
    `SELECT id, property_id, channel_type, field_key, field_mode, created_by, created_at, updated_by, updated_at
     FROM property_quick_booking_rules
     WHERE property_id = $1
     ORDER BY channel_type ASC, id ASC`,
    [propertyId]
  );

  const walkIn: Record<string, FieldMode> = { ...DEFAULT_WALK_IN_RULES };
  const ota: Record<string, FieldMode> = { ...DEFAULT_OTA_RULES };

  if (result.rows.length > 0) {
    for (const r of result.rows) {
      if (r.channel_type === 'WALK_IN') {
        walkIn[r.field_key] = r.field_mode;
      } else if (r.channel_type === 'OTA') {
        ota[r.field_key] = r.field_mode;
      }
    }
  } else {
    // Seed defaults for property if none exist
    for (const [key, mode] of Object.entries(DEFAULT_WALK_IN_RULES)) {
      await pool.query(
        `INSERT INTO property_quick_booking_rules (property_id, channel_type, field_key, field_mode)
         VALUES ($1, 'WALK_IN', $2, $3)
         ON CONFLICT (property_id, channel_type, field_key) DO NOTHING`,
        [propertyId, key, mode]
      );
    }
    for (const [key, mode] of Object.entries(DEFAULT_OTA_RULES)) {
      await pool.query(
        `INSERT INTO property_quick_booking_rules (property_id, channel_type, field_key, field_mode)
         VALUES ($1, 'OTA', $2, $3)
         ON CONFLICT (property_id, channel_type, field_key) DO NOTHING`,
        [propertyId, key, mode]
      );
    }
  }

  return {
    property_id: propertyId,
    rules: {
      WALK_IN: walkIn,
      OTA: ota
    },
    raw: result.rows
  };
}

/**
 * Upsert quick booking rules for a specific channel
 */
export async function updateQuickBookingRules(
  pool: Pool,
  propertyId: number,
  channelType: 'WALK_IN' | 'OTA',
  rules: Record<string, FieldMode>,
  actor: string = 'USER'
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const [fieldKey, fieldMode] of Object.entries(rules)) {
      if (!['REQUIRED', 'OPTIONAL', 'HIDDEN'].includes(fieldMode)) continue;

      await client.query(
        `INSERT INTO property_quick_booking_rules 
          (property_id, channel_type, field_key, field_mode, created_by, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5, NOW())
         ON CONFLICT (property_id, channel_type, field_key) 
         DO UPDATE SET 
           field_mode = EXCLUDED.field_mode,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
        [propertyId, channelType, fieldKey, fieldMode, actor]
      );
    }

    await client.query('COMMIT');
    return await getQuickBookingRules(pool, propertyId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * List Day Use duration presets for property
 */
export async function getDayUseDurations(
  pool: Pool,
  propertyId: number,
  includeArchived: boolean = false
): Promise<DayUseDurationRow[]> {
  const result = await pool.query<DayUseDurationRow>(
    `SELECT id, property_id, name, duration_minutes, sort_order, is_active, is_archived, created_by, created_at, updated_by, updated_at
     FROM property_day_use_durations
     WHERE property_id = $1 ${includeArchived ? '' : 'AND is_archived = FALSE'}
     ORDER BY sort_order ASC, duration_minutes ASC`,
    [propertyId]
  );

  if (result.rows.length === 0 && !includeArchived) {
    // Seed defaults for property
    for (const preset of DEFAULT_DAY_USE_PRESETS) {
      await pool.query(
        `INSERT INTO property_day_use_durations (property_id, name, duration_minutes, sort_order)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (property_id, duration_minutes) DO NOTHING`,
        [propertyId, preset.name, preset.duration_minutes, preset.sort_order]
      );
    }
    const fresh = await pool.query<DayUseDurationRow>(
      `SELECT id, property_id, name, duration_minutes, sort_order, is_active, is_archived, created_by, created_at, updated_by, updated_at
       FROM property_day_use_durations
       WHERE property_id = $1 AND is_archived = FALSE
       ORDER BY sort_order ASC, duration_minutes ASC`,
      [propertyId]
    );
    return fresh.rows;
  }

  return result.rows;
}

/**
 * Create Day Use duration preset
 */
export async function createDayUseDuration(
  pool: Pool,
  propertyId: number,
  data: { name: string; duration_minutes: number; sort_order?: number },
  actor: string = 'USER'
): Promise<DayUseDurationRow> {
  const { name, duration_minutes, sort_order = 0 } = data;
  if (!name || !name.trim()) throw new Error('Nama durasi wajib diisi.');
  if (!duration_minutes || duration_minutes <= 0) throw new Error('Durasi dalam menit harus berupa bilangan positif.');

  const res = await pool.query<DayUseDurationRow>(
    `INSERT INTO property_day_use_durations (property_id, name, duration_minutes, sort_order, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (property_id, duration_minutes)
     DO UPDATE SET 
       name = EXCLUDED.name,
       sort_order = EXCLUDED.sort_order,
       is_archived = FALSE,
       is_active = TRUE,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING *`,
    [propertyId, name.trim(), Math.round(duration_minutes), sort_order, actor]
  );

  return res.rows[0];
}

/**
 * Update Day Use duration preset
 */
export async function updateDayUseDuration(
  pool: Pool,
  propertyId: number,
  id: number,
  data: { name?: string; duration_minutes?: number; sort_order?: number; is_active?: boolean },
  actor: string = 'USER'
): Promise<DayUseDurationRow> {
  const existing = await pool.query(`SELECT id FROM property_day_use_durations WHERE id = $1 AND property_id = $2`, [id, propertyId]);
  if (!existing.rows.length) throw new Error(`Durasi Day Use #${id} tidak ditemukan.`);

  const updates: string[] = ['updated_by = $3', 'updated_at = NOW()'];
  const values: any[] = [id, propertyId, actor];
  let paramIdx = 4;

  if (data.name !== undefined) {
    updates.push(`name = $${paramIdx++}`);
    values.push(data.name.trim());
  }
  if (data.duration_minutes !== undefined) {
    if (data.duration_minutes <= 0) throw new Error('Durasi dalam menit harus positif.');
    updates.push(`duration_minutes = $${paramIdx++}`);
    values.push(Math.round(data.duration_minutes));
  }
  if (data.sort_order !== undefined) {
    updates.push(`sort_order = $${paramIdx++}`);
    values.push(data.sort_order);
  }
  if (data.is_active !== undefined) {
    updates.push(`is_active = $${paramIdx++}`);
    values.push(Boolean(data.is_active));
  }

  const query = `
    UPDATE property_day_use_durations
    SET ${updates.join(', ')}
    WHERE id = $1 AND property_id = $2
    RETURNING *
  `;

  const res = await pool.query<DayUseDurationRow>(query, values);
  return res.rows[0];
}

/**
 * Soft delete / archive Day Use duration preset
 */
export async function deleteDayUseDuration(
  pool: Pool,
  propertyId: number,
  id: number,
  actor: string = 'USER'
): Promise<{ success: boolean; id: number }> {
  const res = await pool.query(
    `UPDATE property_day_use_durations
     SET is_archived = TRUE, is_active = FALSE, updated_by = $3, updated_at = NOW()
     WHERE id = $1 AND property_id = $2
     RETURNING id`,
    [id, propertyId, actor]
  );
  if (!res.rows.length) throw new Error(`Durasi Day Use #${id} tidak ditemukan.`);
  return { success: true, id };
}

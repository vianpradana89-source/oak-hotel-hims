import crypto from 'crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  BulkRateOverrideDto,
  BulkRateOverridePreviewItem,
  BulkRateOverridePreviewResult,
  CreateMealPlanDto,
  CreateRateOverrideDto,
  CreateRatePlanDto,
  DuplicateRatePlanDto,
  MealPlanMaster,
  NightlyQuote,
  PriceQuoteInput,
  PriceQuoteResult,
  PropertyPricingSettings,
  RateCalendarDay,
  RateOverride,
  RatePlan,
  ReservationNightlyRate,
  UpdateMealPlanDto,
  UpdateRatePlanDto
} from './pricingTypes';

// ============================================================================
// DATE HELPERS (Asia/Jakarta hotel date semantics)
// ============================================================================

export function toHotelDateString(d: Date): string {
  // Asia/Jakarta timezone formatter
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

export function parseHotelDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(dateStr: string, days: number): string {
  const d = parseHotelDate(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function getStayDatesArray(checkIn: string, checkOut: string): string[] {
  const dates: string[] = [];
  let curr = checkIn;
  while (curr < checkOut) {
    dates.push(curr);
    curr = addDays(curr, 1);
  }
  return dates;
}

export function getIsoDayOfWeek(dateStr: string): number {
  const d = parseHotelDate(dateStr);
  const dow = d.getUTCDay(); // 0 = Sun, 1 = Mon ...
  return dow === 0 ? 7 : dow; // Convert 0 (Sun) to 7
}

export function getDayNameIndonesian(dow: number): string {
  const map: Record<number, string> = {
    1: 'Sen',
    2: 'Sel',
    3: 'Rab',
    4: 'Kam',
    5: 'Jum',
    6: 'Sab',
    7: 'Min'
  };
  return map[dow] || '';
}

export const getIndonesianDayName = getDayNameIndonesian;

// ============================================================================
// AUDIT LOGGING HELPER
// ============================================================================

async function logAudit(
  client: PoolClient | Pool,
  params: {
    property_id: number;
    action: string;
    entity_type: string;
    entity_id: number | string;
    before?: any;
    after?: any;
    actor?: string;
  }
) {
  try {
    await client.query(
      `INSERT INTO audit_logs (
        module, action, entity, record_id, new_value, property_id
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        'PRICING',
        params.action,
        params.entity_type,
        String(params.entity_id),
        params.after ? JSON.stringify(params.after) : (params.before ? JSON.stringify(params.before) : null),
        params.property_id
      ]
    );
  } catch (err) {
    // Non-blocking fallback for audit logging in tests or legacy environments
    console.error('Audit logging warning:', err);
  }
}

// ============================================================================
// PROPERTY PRICING SETTINGS (Tax & Service Charge)
// ============================================================================

export async function getPropertyPricingSettings(
  client: PoolClient | Pool,
  propertyId: number
): Promise<PropertyPricingSettings> {
  const res = await client.query(
    `SELECT property_id, tax_percent, service_charge_percent, prices_include_tax, prices_include_service, created_at, updated_at
     FROM property_pricing_settings
     WHERE property_id = $1`,
    [propertyId]
  );

  if (res.rows.length === 0) {
    // Create default settings if absent
    const insertRes = await client.query(
      `INSERT INTO property_pricing_settings (property_id, tax_percent, service_charge_percent, prices_include_tax, prices_include_service)
       VALUES ($1, 10.00, 0.00, false, false)
       ON CONFLICT (property_id) DO UPDATE SET updated_at = NOW()
       RETURNING property_id, tax_percent, service_charge_percent, prices_include_tax, prices_include_service, created_at, updated_at`,
      [propertyId]
    );
    const row = insertRes.rows[0];
    return {
      property_id: row.property_id,
      tax_percent: Number(row.tax_percent),
      service_charge_percent: Number(row.service_charge_percent),
      prices_include_tax: Boolean(row.prices_include_tax),
      prices_include_service: Boolean(row.prices_include_service),
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  const row = res.rows[0];
  return {
    property_id: row.property_id,
    tax_percent: Number(row.tax_percent),
    service_charge_percent: Number(row.service_charge_percent),
    prices_include_tax: Boolean(row.prices_include_tax),
    prices_include_service: Boolean(row.prices_include_service),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export async function updatePropertyPricingSettings(
  client: PoolClient | Pool,
  propertyId: number,
  data: Partial<Pick<PropertyPricingSettings, 'tax_percent' | 'service_charge_percent' | 'prices_include_tax' | 'prices_include_service'>>,
  actor?: string
): Promise<PropertyPricingSettings> {
  const current = await getPropertyPricingSettings(client, propertyId);

  const taxPercent = data.tax_percent !== undefined ? Math.max(0, Number(data.tax_percent)) : current.tax_percent;
  const servicePercent = data.service_charge_percent !== undefined ? Math.max(0, Number(data.service_charge_percent)) : current.service_charge_percent;
  const incTax = data.prices_include_tax !== undefined ? Boolean(data.prices_include_tax) : current.prices_include_tax;
  const incService = data.prices_include_service !== undefined ? Boolean(data.prices_include_service) : current.prices_include_service;

  const res = await client.query(
    `INSERT INTO property_pricing_settings (property_id, tax_percent, service_charge_percent, prices_include_tax, prices_include_service, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (property_id) DO UPDATE SET
       tax_percent = EXCLUDED.tax_percent,
       service_charge_percent = EXCLUDED.service_charge_percent,
       prices_include_tax = EXCLUDED.prices_include_tax,
       prices_include_service = EXCLUDED.prices_include_service,
       updated_at = NOW()
     RETURNING property_id, tax_percent, service_charge_percent, prices_include_tax, prices_include_service, created_at, updated_at`,
    [propertyId, taxPercent, servicePercent, incTax, incService]
  );

  const updated = res.rows[0];
  await logAudit(client, {
    property_id: propertyId,
    action: 'PROPERTY_PRICING_SETTINGS_UPDATED',
    entity_type: 'property_pricing_settings',
    entity_id: propertyId,
    before: current,
    after: updated,
    actor
  });

  return {
    property_id: updated.property_id,
    tax_percent: Number(updated.tax_percent),
    service_charge_percent: Number(updated.service_charge_percent),
    prices_include_tax: Boolean(updated.prices_include_tax),
    prices_include_service: Boolean(updated.prices_include_service),
    created_at: updated.created_at,
    updated_at: updated.updated_at
  };
}

// ============================================================================
// MEAL PLAN MASTER CRUD & LIFECYCLE
// ============================================================================

export async function listMealPlans(
  client: PoolClient | Pool,
  propertyId: number,
  options?: {
    is_active?: boolean;
    include_archived?: boolean;
  }
): Promise<MealPlanMaster[]> {
  const whereParts: string[] = ['mp.property_id = $1'];
  const params: any[] = [propertyId];

  if (!options?.include_archived) {
    whereParts.push('mp.is_archived = FALSE');
  }

  if (options?.is_active !== undefined) {
    params.push(options.is_active);
    whereParts.push(`mp.is_active = $${params.length}`);
  }

  const query = `
    SELECT 
      mp.*,
      (SELECT COUNT(*)::int FROM rate_plans rp WHERE rp.meal_plan_id = mp.id AND rp.is_archived = FALSE) AS rate_plans_count
    FROM meal_plans mp
    WHERE ${whereParts.join(' AND ')}
    ORDER BY mp.sort_order ASC, mp.id ASC
  `;

  const res = await client.query(query, params);
  return res.rows.map((r) => ({
    id: Number(r.id),
    property_id: Number(r.property_id),
    code: r.code,
    name: r.name,
    description: r.description || null,
    breakfast_included: Boolean(r.breakfast_included),
    lunch_included: Boolean(r.lunch_included),
    dinner_included: Boolean(r.dinner_included),
    is_active: Boolean(r.is_active),
    is_archived: Boolean(r.is_archived),
    sort_order: Number(r.sort_order || 0),
    created_by: r.created_by || null,
    created_at: r.created_at,
    updated_by: r.updated_by || null,
    updated_at: r.updated_at,
    rate_plans_count: Number(r.rate_plans_count || 0)
  }));
}

export async function getMealPlanById(
  client: PoolClient | Pool,
  propertyId: number,
  id: number
): Promise<MealPlanMaster | null> {
  const res = await client.query(
    `SELECT 
       mp.*,
       (SELECT COUNT(*)::int FROM rate_plans rp WHERE rp.meal_plan_id = mp.id AND rp.is_archived = FALSE) AS rate_plans_count
     FROM meal_plans mp
     WHERE mp.id = $1 AND mp.property_id = $2`,
    [id, propertyId]
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    id: Number(r.id),
    property_id: Number(r.property_id),
    code: r.code,
    name: r.name,
    description: r.description || null,
    breakfast_included: Boolean(r.breakfast_included),
    lunch_included: Boolean(r.lunch_included),
    dinner_included: Boolean(r.dinner_included),
    is_active: Boolean(r.is_active),
    is_archived: Boolean(r.is_archived),
    sort_order: Number(r.sort_order || 0),
    created_by: r.created_by || null,
    created_at: r.created_at,
    updated_by: r.updated_by || null,
    updated_at: r.updated_at,
    rate_plans_count: Number(r.rate_plans_count || 0)
  };
}

export async function createMealPlan(
  client: PoolClient | Pool,
  propertyId: number,
  data: CreateMealPlanDto,
  actor?: string
): Promise<MealPlanMaster> {
  const cleanCode = data.code ? data.code.trim().toUpperCase() : '';
  const cleanName = data.name ? data.name.trim() : '';

  if (!cleanCode) throw new Error('Kode Meal Plan wajib diisi.');
  if (!cleanName) throw new Error('Nama Meal Plan wajib diisi.');

  const dupCheck = await client.query(
    `SELECT id FROM meal_plans WHERE property_id = $1 AND UPPER(TRIM(code)) = $2 AND is_archived = FALSE`,
    [propertyId, cleanCode]
  );
  if (dupCheck.rows.length > 0) {
    throw new Error(`Meal Plan dengan kode '${cleanCode}' sudah ada untuk properti ini.`);
  }

  const res = await client.query(
    `INSERT INTO meal_plans (
      property_id, code, name, description,
      breakfast_included, lunch_included, dinner_included,
      is_active, is_archived, sort_order, created_by, updated_by
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6, $7,
      $8, false, $9, $10, $10
    ) RETURNING *`,
    [
      propertyId,
      cleanCode,
      cleanName,
      data.description?.trim() || null,
      Boolean(data.breakfast_included),
      Boolean(data.lunch_included),
      Boolean(data.dinner_included),
      data.is_active !== undefined ? Boolean(data.is_active) : true,
      data.sort_order !== undefined ? Math.round(data.sort_order) : 0,
      actor || 'SYSTEM'
    ]
  );

  const row = res.rows[0];
  await logAudit(client, {
    property_id: propertyId,
    action: 'MEAL_PLAN_CREATED',
    entity_type: 'meal_plans',
    entity_id: row.id,
    after: row,
    actor
  });

  return (await getMealPlanById(client, propertyId, Number(row.id)))!;
}

export async function updateMealPlan(
  client: PoolClient | Pool,
  propertyId: number,
  id: number,
  data: UpdateMealPlanDto,
  actor?: string
): Promise<MealPlanMaster> {
  const current = await getMealPlanById(client, propertyId, id);
  if (!current) {
    throw new Error(`Meal Plan with ID ${id} not found.`);
  }

  let cleanCode = current.code;
  if (data.code !== undefined) {
    cleanCode = data.code.trim().toUpperCase();
    if (!cleanCode) throw new Error('Kode Meal Plan tidak boleh kosong.');
    const dupCheck = await client.query(
      `SELECT id FROM meal_plans WHERE property_id = $1 AND UPPER(TRIM(code)) = $2 AND id != $3 AND is_archived = FALSE`,
      [propertyId, cleanCode, id]
    );
    if (dupCheck.rows.length > 0) {
      throw new Error(`Meal Plan dengan kode '${cleanCode}' sudah ada untuk properti ini.`);
    }
  }

  let cleanName = current.name;
  if (data.name !== undefined) {
    cleanName = data.name.trim();
    if (!cleanName) throw new Error('Nama Meal Plan tidak boleh kosong.');
  }

  const res = await client.query(
    `UPDATE meal_plans SET
      code = $1,
      name = $2,
      description = $3,
      breakfast_included = COALESCE($4, breakfast_included),
      lunch_included = COALESCE($5, lunch_included),
      dinner_included = COALESCE($6, dinner_included),
      is_active = COALESCE($7, is_active),
      sort_order = COALESCE($8, sort_order),
      updated_by = $9,
      updated_at = NOW()
     WHERE id = $10 AND property_id = $11
     RETURNING *`,
    [
      cleanCode,
      cleanName,
      data.description !== undefined ? (data.description ? data.description.trim() : null) : current.description,
      data.breakfast_included !== undefined ? Boolean(data.breakfast_included) : null,
      data.lunch_included !== undefined ? Boolean(data.lunch_included) : null,
      data.dinner_included !== undefined ? Boolean(data.dinner_included) : null,
      data.is_active !== undefined ? Boolean(data.is_active) : null,
      data.sort_order !== undefined ? Math.round(data.sort_order) : null,
      actor || 'SYSTEM',
      id,
      propertyId
    ]
  );

  const updatedRow = res.rows[0];
  await logAudit(client, {
    property_id: propertyId,
    action: 'MEAL_PLAN_UPDATED',
    entity_type: 'meal_plans',
    entity_id: id,
    before: current,
    after: updatedRow,
    actor
  });

  return (await getMealPlanById(client, propertyId, id))!;
}

export async function setMealPlanActive(
  client: PoolClient | Pool,
  propertyId: number,
  id: number,
  isActive: boolean,
  actor?: string
): Promise<MealPlanMaster> {
  const current = await getMealPlanById(client, propertyId, id);
  if (!current) throw new Error(`Meal Plan with ID ${id} not found.`);

  await client.query(
    'UPDATE meal_plans SET is_active = $1, updated_by = $2, updated_at = NOW() WHERE id = $3 AND property_id = $4',
    [isActive, actor || 'SYSTEM', id, propertyId]
  );

  await logAudit(client, {
    property_id: propertyId,
    action: isActive ? 'MEAL_PLAN_ACTIVATED' : 'MEAL_PLAN_DEACTIVATED',
    entity_type: 'meal_plans',
    entity_id: id,
    before: { is_active: current.is_active },
    after: { is_active: isActive },
    actor
  });

  return (await getMealPlanById(client, propertyId, id))!;
}

export async function deleteMealPlan(
  client: PoolClient | Pool,
  propertyId: number,
  id: number,
  actor?: string
): Promise<{ deleted: boolean; archived: boolean; message: string; meal_plan?: MealPlanMaster }> {
  const current = await getMealPlanById(client, propertyId, id);
  if (!current) throw new Error(`Meal Plan with ID ${id} not found.`);

  // Check if referenced by rate_plans, reservations, or reservation_nightly_rates
  const refRes = await client.query(
    `SELECT 1 FROM rate_plans WHERE meal_plan_id = $1
     UNION
     SELECT 1 FROM reservations WHERE meal_plan_id = $1
     UNION
     SELECT 1 FROM reservation_nightly_rates WHERE meal_plan_id = $1
     LIMIT 1`,
    [id]
  );

  const isReferenced = refRes.rows.length > 0;

  if (isReferenced) {
    // Soft delete / archive
    await client.query(
      `UPDATE meal_plans SET is_archived = TRUE, is_active = FALSE, updated_by = $1, updated_at = NOW() WHERE id = $2 AND property_id = $3`,
      [actor || 'SYSTEM', id, propertyId]
    );

    const updated = await getMealPlanById(client, propertyId, id);

    await logAudit(client, {
      property_id: propertyId,
      action: 'MEAL_PLAN_ARCHIVED',
      entity_type: 'meal_plans',
      entity_id: id,
      before: current,
      after: updated,
      actor
    });

    return {
      deleted: false,
      archived: true,
      message: 'Meal Plan sudah digunakan oleh Rate Plan atau histori reservasi. Data akan diarsipkan agar histori tetap aman.',
      meal_plan: updated || undefined
    };
  }

  // Hard delete if never referenced
  await client.query('DELETE FROM meal_plans WHERE id = $1 AND property_id = $2', [id, propertyId]);

  await logAudit(client, {
    property_id: propertyId,
    action: 'MEAL_PLAN_DELETED',
    entity_type: 'meal_plans',
    entity_id: id,
    before: current,
    actor
  });

  return {
    deleted: true,
    archived: false,
    message: 'Meal Plan berhasil dihapus.'
  };
}

// ============================================================================
// RATE PLAN CRUD & LIFECYCLE
// ============================================================================

export async function listRatePlans(
  client: PoolClient | Pool,
  propertyId: number,
  options?: {
    room_type_id?: number;
    is_active?: boolean;
    include_archived?: boolean;
  }
): Promise<RatePlan[]> {
  const whereParts: string[] = ['rp.property_id = $1'];
  const params: any[] = [propertyId];

  if (!options?.include_archived) {
    whereParts.push('rp.is_archived = FALSE');
  }

  if (options?.room_type_id) {
    params.push(options.room_type_id);
    whereParts.push(`rp.room_type_id = $${params.length}`);
  }

  if (options?.is_active !== undefined) {
    params.push(options.is_active);
    whereParts.push(`rp.is_active = $${params.length}`);
  }

  const query = `
    SELECT 
      rp.*,
      rt.code AS room_type_code,
      rt.name AS room_type_name,
      mp.code AS meal_plan_code,
      mp.name AS meal_plan_name
    FROM rate_plans rp
    JOIN room_types rt ON rt.id = rp.room_type_id
    LEFT JOIN meal_plans mp ON mp.id = rp.meal_plan_id
    WHERE ${whereParts.join(' AND ')}
    ORDER BY rp.sort_order ASC, rp.id ASC
  `;

  const res = await client.query(query, params);
  return res.rows.map((r) => ({
    ...r,
    id: Number(r.id),
    property_id: Number(r.property_id),
    room_type_id: Number(r.room_type_id),
    meal_plan_id: r.meal_plan_id ? Number(r.meal_plan_id) : null,
    meal_plan_code: r.meal_plan_code || r.meal_plan,
    meal_plan_name: r.meal_plan_name || r.meal_plan,
    base_rate: Number(r.base_rate),
    extra_person_rate: Number(r.extra_person_rate || 0),
    extra_bed_rate: Number(r.extra_bed_rate || 0),
    min_stay: Number(r.min_stay || 1),
    max_stay: r.max_stay ? Number(r.max_stay) : null,
    min_advance_days: Number(r.min_advance_days || 0),
    max_advance_days: r.max_advance_days ? Number(r.max_advance_days) : null,
    sort_order: Number(r.sort_order || 0),
    rate_type: r.rate_type || 'OVERNIGHT',
    duration_minutes: r.duration_minutes ? Number(r.duration_minutes) : null,
    earliest_start_time: r.earliest_start_time || null,
    latest_start_time: r.latest_start_time || null,
    turnaround_buffer_minutes: Number(r.turnaround_buffer_minutes || 60)
  }));
}

export async function getRatePlanById(
  client: PoolClient | Pool,
  propertyId: number,
  id: number
): Promise<RatePlan | null> {
  const res = await client.query(
    `SELECT 
       rp.*, 
       rt.code AS room_type_code, 
       rt.name AS room_type_name,
       mp.code AS meal_plan_code,
       mp.name AS meal_plan_name
     FROM rate_plans rp
     JOIN room_types rt ON rt.id = rp.room_type_id
     LEFT JOIN meal_plans mp ON mp.id = rp.meal_plan_id
     WHERE rp.id = $1 AND rp.property_id = $2`,
    [id, propertyId]
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    ...r,
    id: Number(r.id),
    property_id: Number(r.property_id),
    room_type_id: Number(r.room_type_id),
    meal_plan_id: r.meal_plan_id ? Number(r.meal_plan_id) : null,
    meal_plan_code: r.meal_plan_code || r.meal_plan,
    meal_plan_name: r.meal_plan_name || r.meal_plan,
    base_rate: Number(r.base_rate),
    extra_person_rate: Number(r.extra_person_rate || 0),
    extra_bed_rate: Number(r.extra_bed_rate || 0),
    min_stay: Number(r.min_stay || 1),
    max_stay: r.max_stay ? Number(r.max_stay) : null,
    min_advance_days: Number(r.min_advance_days || 0),
    max_advance_days: r.max_advance_days ? Number(r.max_advance_days) : null,
    sort_order: Number(r.sort_order || 0),
    rate_type: r.rate_type || 'OVERNIGHT',
    duration_minutes: r.duration_minutes ? Number(r.duration_minutes) : null,
    earliest_start_time: r.earliest_start_time || null,
    latest_start_time: r.latest_start_time || null,
    turnaround_buffer_minutes: Number(r.turnaround_buffer_minutes || 60)
  };
}

export async function createRatePlan(
  client: PoolClient | Pool,
  propertyId: number,
  data: CreateRatePlanDto,
  actor?: string
): Promise<RatePlan> {
  // Validate property ownership of room_type_id
  const rtCheck = await client.query(
    'SELECT id, property_id, code, name FROM room_types WHERE id = $1 AND property_id = $2',
    [data.room_type_id, propertyId]
  );
  if (rtCheck.rows.length === 0) {
    throw new Error(`Room type ${data.room_type_id} does not exist for property ${propertyId}.`);
  }

  const cleanCode = data.code.trim().toUpperCase();
  if (!cleanCode) throw new Error('Kode Rate Plan wajib diisi.');
  if (!data.name.trim()) throw new Error('Nama Rate Plan wajib diisi.');

  const baseRate = Math.round(Number(data.base_rate));
  if (isNaN(baseRate) || baseRate < 0) {
    throw new Error('Harga Dasar harus berupa bilangan bulat positif.');
  }

  // Check code uniqueness per property
  const dupCheck = await client.query(
    `SELECT id FROM rate_plans WHERE property_id = $1 AND UPPER(TRIM(code)) = $2 AND is_archived = FALSE`,
    [propertyId, cleanCode]
  );
  if (dupCheck.rows.length > 0) {
    throw new Error(`Rate plan dengan kode '${cleanCode}' sudah ada untuk properti ini.`);
  }

  // Authoritative Meal Plan resolution
  let resolvedMealPlanId: number | null = null;
  let resolvedMealPlanCode: string = data.meal_plan || 'RO';

  if (data.meal_plan_id) {
    const mpRes = await client.query(
      'SELECT id, code, name, is_active, is_archived FROM meal_plans WHERE id = $1 AND property_id = $2',
      [data.meal_plan_id, propertyId]
    );
    if (mpRes.rows.length === 0) {
      throw new Error(`Meal Plan ${data.meal_plan_id} tidak ditemukan untuk properti ini.`);
    }
    const mp = mpRes.rows[0];
    if (mp.is_archived) {
      throw new Error('Meal Plan yang dipilih telah diarsipkan.');
    }
    if (!mp.is_active) {
      throw new Error('Meal Plan yang dipilih tidak aktif.');
    }
    resolvedMealPlanId = Number(mp.id);
    resolvedMealPlanCode = mp.code;
  } else if (data.meal_plan) {
    const mpRes = await client.query(
      'SELECT id, code, is_active, is_archived FROM meal_plans WHERE property_id = $1 AND UPPER(TRIM(code)) = $2 AND is_archived = FALSE',
      [propertyId, data.meal_plan.trim().toUpperCase()]
    );
    if (mpRes.rows.length > 0) {
      resolvedMealPlanId = Number(mpRes.rows[0].id);
      resolvedMealPlanCode = mpRes.rows[0].code;
    }
  }

  const res = await client.query(
    `INSERT INTO rate_plans (
      property_id, room_type_id, code, name, description,
      base_rate, currency, meal_plan, meal_plan_id, refundable,
      cancellation_policy, payment_policy, valid_from, valid_until,
      min_stay, max_stay, min_advance_days, max_advance_days,
      extra_person_rate, extra_bed_rate, days_of_week,
      rate_type, duration_minutes, earliest_start_time, latest_start_time, turnaround_buffer_minutes,
      is_active, is_archived, sort_order, created_by, updated_by
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13, $14,
      $15, $16, $17, $18,
      $19, $20, $21,
      $22, $23, $24, $25, $26,
      $27, false, $28, $29, $29
    ) RETURNING *`,
    [
      propertyId,
      data.room_type_id,
      cleanCode,
      data.name.trim(),
      data.description?.trim() || null,
      baseRate,
      data.currency || 'IDR',
      resolvedMealPlanCode,
      resolvedMealPlanId,
      data.refundable !== undefined ? data.refundable : true,
      data.cancellation_policy || null,
      data.payment_policy || null,
      data.valid_from || null,
      data.valid_until || null,
      data.min_stay && data.min_stay >= 1 ? Math.round(data.min_stay) : 1,
      data.max_stay ? Math.round(data.max_stay) : null,
      data.min_advance_days !== undefined ? Math.round(data.min_advance_days) : 0,
      data.max_advance_days ? Math.round(data.max_advance_days) : null,
      data.extra_person_rate ? Math.round(data.extra_person_rate) : 0,
      data.extra_bed_rate ? Math.round(data.extra_bed_rate) : 0,
      data.days_of_week || null,
      data.rate_type || 'OVERNIGHT',
      data.duration_minutes !== undefined ? (data.duration_minutes ? Math.round(data.duration_minutes) : null) : null,
      data.earliest_start_time || null,
      data.latest_start_time || null,
      data.turnaround_buffer_minutes !== undefined ? Math.round(data.turnaround_buffer_minutes) : 60,
      data.is_active !== undefined ? data.is_active : true,
      data.sort_order || 0,
      actor || 'SYSTEM'
    ]
  );

  const row = res.rows[0];
  await logAudit(client, {
    property_id: propertyId,
    action: 'RATE_PLAN_CREATED',
    entity_type: 'rate_plans',
    entity_id: row.id,
    after: row,
    actor
  });

  return (await getRatePlanById(client, propertyId, Number(row.id)))!;
}

export async function updateRatePlan(
  client: PoolClient | Pool,
  propertyId: number,
  id: number,
  data: UpdateRatePlanDto,
  actor?: string
): Promise<RatePlan> {
  const current = await getRatePlanById(client, propertyId, id);
  if (!current) {
    throw new Error(`Rate Plan with ID ${id} not found.`);
  }

  if (data.room_type_id && data.room_type_id !== current.room_type_id) {
    const rtCheck = await client.query(
      'SELECT id FROM room_types WHERE id = $1 AND property_id = $2',
      [data.room_type_id, propertyId]
    );
    if (rtCheck.rows.length === 0) {
      throw new Error(`Room type ${data.room_type_id} does not exist for property ${propertyId}.`);
    }
  }

  let cleanCode = current.code;
  if (data.code !== undefined) {
    cleanCode = data.code.trim().toUpperCase();
    if (!cleanCode) throw new Error('Kode Rate Plan tidak boleh kosong.');
    const dupCheck = await client.query(
      `SELECT id FROM rate_plans WHERE property_id = $1 AND UPPER(TRIM(code)) = $2 AND id != $3 AND is_archived = FALSE`,
      [propertyId, cleanCode, id]
    );
    if (dupCheck.rows.length > 0) {
      throw new Error(`Rate plan dengan kode '${cleanCode}' sudah ada untuk properti ini.`);
    }
  }

  const baseRate = data.base_rate !== undefined ? Math.round(Number(data.base_rate)) : current.base_rate;
  if (isNaN(baseRate) || baseRate < 0) {
    throw new Error('Harga Dasar harus berupa bilangan bulat positif.');
  }

  // Authoritative Meal Plan resolution
  let resolvedMealPlanId: number | null = current.meal_plan_id || null;
  let resolvedMealPlanCode: string = current.meal_plan;

  if (data.meal_plan_id !== undefined) {
    if (data.meal_plan_id) {
      const mpRes = await client.query(
        'SELECT id, code, name, is_active, is_archived FROM meal_plans WHERE id = $1 AND property_id = $2',
        [data.meal_plan_id, propertyId]
      );
      if (mpRes.rows.length === 0) {
        throw new Error(`Meal Plan ${data.meal_plan_id} tidak ditemukan untuk properti ini.`);
      }
      const mp = mpRes.rows[0];
      if (mp.is_archived) {
        throw new Error('Meal Plan yang dipilih telah diarsipkan.');
      }
      resolvedMealPlanId = Number(mp.id);
      resolvedMealPlanCode = mp.code;
    } else {
      resolvedMealPlanId = null;
      resolvedMealPlanCode = data.meal_plan || current.meal_plan;
    }
  } else if (data.meal_plan && data.meal_plan !== current.meal_plan) {
    const mpRes = await client.query(
      'SELECT id, code FROM meal_plans WHERE property_id = $1 AND UPPER(TRIM(code)) = $2 AND is_archived = FALSE',
      [propertyId, data.meal_plan.trim().toUpperCase()]
    );
    if (mpRes.rows.length > 0) {
      resolvedMealPlanId = Number(mpRes.rows[0].id);
      resolvedMealPlanCode = mpRes.rows[0].code;
    } else {
      resolvedMealPlanCode = data.meal_plan;
    }
  }

  const res = await client.query(
    `UPDATE rate_plans SET
      room_type_id = COALESCE($1, room_type_id),
      code = $2,
      name = COALESCE($3, name),
      description = $4,
      base_rate = $5,
      currency = COALESCE($6, currency),
      meal_plan = $7,
      meal_plan_id = $8,
      refundable = COALESCE($9, refundable),
      cancellation_policy = $10,
      payment_policy = $11,
      valid_from = $12,
      valid_until = $13,
      min_stay = COALESCE($14, min_stay),
      max_stay = $15,
      min_advance_days = COALESCE($16, min_advance_days),
      max_advance_days = $17,
      extra_person_rate = COALESCE($18, extra_person_rate),
      extra_bed_rate = COALESCE($19, extra_bed_rate),
      days_of_week = $20,
      rate_type = COALESCE($21, rate_type),
      duration_minutes = $22,
      earliest_start_time = $23,
      latest_start_time = $24,
      turnaround_buffer_minutes = COALESCE($25, turnaround_buffer_minutes),
      is_active = COALESCE($26, is_active),
      sort_order = COALESCE($27, sort_order),
      updated_by = $28,
      updated_at = NOW()
     WHERE id = $29 AND property_id = $30
     RETURNING *`,
    [
      data.room_type_id || null,
      cleanCode,
      data.name ? data.name.trim() : null,
      data.description !== undefined ? data.description : current.description,
      baseRate,
      data.currency || null,
      resolvedMealPlanCode,
      resolvedMealPlanId,
      data.refundable !== undefined ? data.refundable : null,
      data.cancellation_policy !== undefined ? data.cancellation_policy : current.cancellation_policy,
      data.payment_policy !== undefined ? data.payment_policy : current.payment_policy,
      data.valid_from !== undefined ? data.valid_from : current.valid_from,
      data.valid_until !== undefined ? data.valid_until : current.valid_until,
      data.min_stay !== undefined ? Math.round(data.min_stay) : null,
      data.max_stay !== undefined ? (data.max_stay ? Math.round(data.max_stay) : null) : current.max_stay,
      data.min_advance_days !== undefined ? Math.round(data.min_advance_days) : null,
      data.max_advance_days !== undefined ? (data.max_advance_days ? Math.round(data.max_advance_days) : null) : current.max_advance_days,
      data.extra_person_rate !== undefined ? Math.round(data.extra_person_rate) : null,
      data.extra_bed_rate !== undefined ? Math.round(data.extra_bed_rate) : null,
      data.days_of_week !== undefined ? data.days_of_week : current.days_of_week,
      data.rate_type || null,
      data.duration_minutes !== undefined ? (data.duration_minutes ? Math.round(data.duration_minutes) : null) : current.duration_minutes,
      data.earliest_start_time !== undefined ? data.earliest_start_time : current.earliest_start_time,
      data.latest_start_time !== undefined ? data.latest_start_time : current.latest_start_time,
      data.turnaround_buffer_minutes !== undefined ? Math.round(data.turnaround_buffer_minutes) : current.turnaround_buffer_minutes,
      data.is_active !== undefined ? data.is_active : null,
      data.sort_order !== undefined ? data.sort_order : null,
      actor || 'SYSTEM',
      id,
      propertyId
    ]
  );

  const updatedRow = res.rows[0];
  await logAudit(client, {
    property_id: propertyId,
    action: 'RATE_PLAN_UPDATED',
    entity_type: 'rate_plans',
    entity_id: id,
    before: current,
    after: updatedRow,
    actor
  });

  return (await getRatePlanById(client, propertyId, id))!;
}

export async function duplicateRatePlan(
  client: PoolClient | Pool,
  propertyId: number,
  id: number,
  dto: DuplicateRatePlanDto,
  actor?: string
): Promise<RatePlan> {
  const source = await getRatePlanById(client, propertyId, id);
  if (!source) {
    throw new Error(`Rate Plan with ID ${id} not found.`);
  }

  const cleanCode = dto.code.trim().toUpperCase();
  if (!cleanCode) throw new Error('Kode baru wajib diisi untuk duplikasi Rate Plan.');
  if (!dto.name.trim()) throw new Error('Nama baru wajib diisi untuk duplikasi Rate Plan.');

  const targetRoomTypeId = dto.room_type_id || source.room_type_id;
  const targetBaseRate = dto.base_rate !== undefined ? Math.round(Number(dto.base_rate)) : source.base_rate;

  const createPayload: CreateRatePlanDto = {
    room_type_id: targetRoomTypeId,
    code: cleanCode,
    name: dto.name.trim(),
    description: source.description,
    base_rate: targetBaseRate,
    currency: source.currency,
    meal_plan: source.meal_plan,
    meal_plan_id: source.meal_plan_id,
    refundable: source.refundable,
    cancellation_policy: source.cancellation_policy,
    payment_policy: source.payment_policy,
    valid_from: source.valid_from,
    valid_until: source.valid_until,
    min_stay: source.min_stay,
    max_stay: source.max_stay,
    min_advance_days: source.min_advance_days,
    max_advance_days: source.max_advance_days,
    extra_person_rate: source.extra_person_rate,
    extra_bed_rate: source.extra_bed_rate,
    days_of_week: source.days_of_week,
    rate_type: source.rate_type,
    duration_minutes: source.duration_minutes,
    earliest_start_time: source.earliest_start_time,
    latest_start_time: source.latest_start_time,
    turnaround_buffer_minutes: source.turnaround_buffer_minutes,
    is_active: dto.is_active !== undefined ? dto.is_active : true,
    sort_order: source.sort_order + 1
  };

  const duplicated = await createRatePlan(client, propertyId, createPayload, actor);

  await logAudit(client, {
    property_id: propertyId,
    action: 'RATE_PLAN_DUPLICATED',
    entity_type: 'rate_plans',
    entity_id: duplicated.id,
    before: { source_rate_plan_id: id },
    after: duplicated,
    actor
  });

  return duplicated;
}

export async function setRatePlanActive(
  client: PoolClient | Pool,
  propertyId: number,
  id: number,
  isActive: boolean,
  actor?: string
): Promise<RatePlan> {
  const current = await getRatePlanById(client, propertyId, id);
  if (!current) throw new Error(`Rate Plan with ID ${id} not found.`);

  await client.query(
    'UPDATE rate_plans SET is_active = $1, updated_by = $2, updated_at = NOW() WHERE id = $3 AND property_id = $4',
    [isActive, actor || 'SYSTEM', id, propertyId]
  );

  await logAudit(client, {
    property_id: propertyId,
    action: isActive ? 'RATE_PLAN_ACTIVATED' : 'RATE_PLAN_DEACTIVATED',
    entity_type: 'rate_plans',
    entity_id: id,
    before: { is_active: current.is_active },
    after: { is_active: isActive },
    actor
  });

  return (await getRatePlanById(client, propertyId, id))!;
}

export async function deleteRatePlan(
  client: PoolClient | Pool,
  propertyId: number,
  id: number,
  actor?: string
): Promise<{ deleted: boolean; archived: boolean; message: string }> {
  const current = await getRatePlanById(client, propertyId, id);
  if (!current) throw new Error(`Rate Plan with ID ${id} not found.`);

  // Check if referenced in reservations or reservation_nightly_rates
  const refRes = await client.query(
    `SELECT 1 FROM reservations WHERE rate_plan_id = $1
     UNION
     SELECT 1 FROM reservation_nightly_rates WHERE rate_plan_id = $1
     LIMIT 1`,
    [id]
  );

  const isReferenced = refRes.rows.length > 0;

  if (isReferenced) {
    // SAFE ARCHIVE
    await client.query(
      `UPDATE rate_plans SET is_archived = TRUE, is_active = FALSE, updated_by = $1, updated_at = NOW() WHERE id = $2 AND property_id = $3`,
      [actor || 'SYSTEM', id, propertyId]
    );

    await logAudit(client, {
      property_id: propertyId,
      action: 'RATE_PLAN_ARCHIVED',
      entity_type: 'rate_plans',
      entity_id: id,
      before: current,
      after: { is_archived: true, is_active: false },
      actor
    });

    return {
      deleted: false,
      archived: true,
      message: 'Rate Plan sudah memiliki histori transaksi. Data diarsipkan agar histori reservasi tetap aman.'
    };
  } else {
    // HARD DELETE (never referenced)
    await client.query('DELETE FROM rate_overrides WHERE rate_plan_id = $1 AND property_id = $2', [id, propertyId]);
    await client.query('DELETE FROM rate_plans WHERE id = $1 AND property_id = $2', [id, propertyId]);

    await logAudit(client, {
      property_id: propertyId,
      action: 'RATE_PLAN_DELETED',
      entity_type: 'rate_plans',
      entity_id: id,
      before: current,
      after: null,
      actor
    });

    return {
      deleted: true,
      archived: false,
      message: 'Rate Plan berhasil dihapus.'
    };
  }
}

// ============================================================================
// RATE CALENDAR & OVERRIDES
// ============================================================================

// ============================================================================
// RATE CALENDAR & OVERRIDES (PHASE 1 IMMUTABLE ENGINE)
// ============================================================================

export function computeRateCalendarFingerprint(state: {
  property_id: number;
  rate_plan_ids: number[];
  start_date: string;
  end_date: string;
  days_of_week: number[] | null;
  proposed_rate: number;
  active_overrides: Array<{
    id: number;
    rate_plan_id: number;
    start_date: string | Date;
    end_date: string | Date;
    days_of_week: number[] | null;
    override_rate: number;
    updated_at: string | Date;
    is_active: boolean;
    is_archived: boolean;
  }>;
}): string {
  const sortedPlanIds = [...state.rate_plan_ids].map(Number).sort((a, b) => a - b);
  const sortedDow = state.days_of_week && state.days_of_week.length > 0
    ? [...state.days_of_week].map(Number).sort((a, b) => a - b)
    : null;

  const sortedOverrides = [...state.active_overrides]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((o) => {
      const sDate = typeof o.start_date === 'string' ? o.start_date.slice(0, 10) : toHotelDateString(new Date(o.start_date));
      const eDate = typeof o.end_date === 'string' ? o.end_date.slice(0, 10) : toHotelDateString(new Date(o.end_date));
      const uAt = typeof o.updated_at === 'string' ? new Date(o.updated_at).toISOString() : o.updated_at.toISOString();
      const dows = o.days_of_week && o.days_of_week.length > 0
        ? [...o.days_of_week].map(Number).sort((a, b) => a - b)
        : null;

      return {
        id: Number(o.id),
        rate_plan_id: Number(o.rate_plan_id),
        start_date: sDate,
        end_date: eDate,
        days_of_week: dows,
        override_rate: Math.round(Number(o.override_rate)),
        updated_at: uAt,
        is_active: Boolean(o.is_active),
        is_archived: Boolean(o.is_archived)
      };
    });

  const canonicalObj = {
    property_id: Number(state.property_id),
    rate_plan_ids: sortedPlanIds,
    start_date: state.start_date.slice(0, 10),
    end_date: state.end_date.slice(0, 10),
    days_of_week: sortedDow,
    proposed_rate: Math.round(Number(state.proposed_rate)),
    active_overrides: sortedOverrides
  };

  const serialized = JSON.stringify(canonicalObj);
  return `sha256:${crypto.createHash('sha256').update(serialized).digest('hex')}`;
}

export async function listRateOverrides(
  client: PoolClient | Pool,
  propertyId: number,
  ratePlanId: number,
  startDate?: string,
  endDate?: string
): Promise<RateOverride[]> {
  const whereParts: string[] = [
    'property_id = $1',
    'rate_plan_id = $2',
    'is_archived = FALSE'
  ];
  const params: any[] = [propertyId, ratePlanId];

  if (startDate && endDate) {
    params.push(startDate, endDate);
    whereParts.push(`start_date < $${params.length} AND end_date > $${params.length - 1}`);
  }

  const res = await client.query(
    `SELECT * FROM rate_overrides WHERE ${whereParts.join(' AND ')} ORDER BY start_date ASC`,
    params
  );

  return res.rows.map((r) => ({
    ...r,
    id: Number(r.id),
    property_id: Number(r.property_id),
    rate_plan_id: Number(r.rate_plan_id),
    override_rate: Number(r.override_rate),
    start_date: typeof r.start_date === 'string' ? r.start_date.slice(0, 10) : toHotelDateString(r.start_date),
    end_date: typeof r.end_date === 'string' ? r.end_date.slice(0, 10) : toHotelDateString(r.end_date)
  }));
}

export async function getRateCalendarMatrix(
  client: PoolClient | Pool,
  propertyId: number,
  ratePlanId: number,
  startDate: string,
  endDate: string
): Promise<{ rate_plan: RatePlan; days: RateCalendarDay[] }> {
  const ratePlan = await getRatePlanById(client, propertyId, ratePlanId);
  if (!ratePlan) throw new Error(`Rate Plan with ID ${ratePlanId} not found.`);

  const overrides = await listRateOverrides(client, propertyId, ratePlanId, startDate, endDate);
  const dates = getStayDatesArray(startDate, endDate);

  const days: RateCalendarDay[] = dates.map((dateStr) => {
    const dow = getIsoDayOfWeek(dateStr);
    const dayName = getIndonesianDayName(dow);

    // Find active applicable override
    const matchingOverride = overrides.find((o) => {
      if (!o.is_active || o.is_archived) return false;
      if (dateStr < o.start_date || dateStr >= o.end_date) return false;
      if (o.days_of_week && o.days_of_week.length > 0 && !o.days_of_week.includes(dow)) return false;
      return true;
    });

    const isOverridden = !!matchingOverride;
    const effectiveRate = matchingOverride ? matchingOverride.override_rate : ratePlan.base_rate;

    return {
      date: dateStr,
      day_of_week: dow,
      day_name: dayName,
      base_rate: ratePlan.base_rate,
      override_id: matchingOverride ? matchingOverride.id : null,
      override_rate: matchingOverride ? matchingOverride.override_rate : null,
      effective_rate: effectiveRate,
      is_overridden: isOverridden,
      reason: matchingOverride ? matchingOverride.reason : null
    };
  });

  return { rate_plan: ratePlan, days };
}

/**
 * Immutable override application:
 * Soft-archives collided overrides, inserts non-overlapping slices as new rows,
 * and inserts the new override row.
 */
export async function applyRateOverrideImmutable(
  client: PoolClient | Pool,
  params: {
    property_id: number;
    rate_plan_id: number;
    start_date: string;
    end_date: string;
    override_rate: number;
    days_of_week?: number[] | null;
    reason?: string | null;
    actor?: string;
  }
): Promise<RateOverride> {
  const { property_id, rate_plan_id, start_date, end_date, override_rate, reason, actor } = params;
  const targetDow = params.days_of_week && params.days_of_week.length > 0 ? params.days_of_week : null;

  const allDows = [1, 2, 3, 4, 5, 6, 7];
  const targetDowSet = targetDow || allDows;

  // Query overlapping active overrides for this plan
  const existingRes = await client.query(
    `SELECT * FROM rate_overrides 
     WHERE property_id = $1 
       AND rate_plan_id = $2 
       AND is_active = TRUE 
       AND is_archived = FALSE 
       AND end_date > $3 
       AND start_date < $4 
     ORDER BY id ASC`,
    [property_id, rate_plan_id, start_date, end_date]
  );

  for (const existing of existingRes.rows) {
    const existingDow = existing.days_of_week && existing.days_of_week.length > 0 ? existing.days_of_week : allDows;
    const overlapDow = targetDowSet.filter((d: number) => existingDow.includes(d));

    if (overlapDow.length === 0) {
      // Disjoint DOWs: no collision, coexist peacefully
      continue;
    }

    const existingStart = typeof existing.start_date === 'string' ? existing.start_date.slice(0, 10) : toHotelDateString(existing.start_date);
    const existingEnd = typeof existing.end_date === 'string' ? existing.end_date.slice(0, 10) : toHotelDateString(existing.end_date);

    // 1. Soft-archive original historical row
    await client.query(
      `UPDATE rate_overrides 
       SET is_archived = TRUE, is_active = FALSE, updated_by = $1, updated_at = NOW() 
       WHERE id = $2`,
      [actor || 'SYSTEM', existing.id]
    );

    // 2. Preserve remaining non-colliding days across the FULL existing interval
    const remainingDow = existingDow.filter((d: number) => !targetDowSet.includes(d));
    if (remainingDow.length > 0) {
      await client.query(
        `INSERT INTO rate_overrides (
          property_id, rate_plan_id, start_date, end_date, override_rate,
          days_of_week, reason, is_active, is_archived, created_by, updated_by
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, TRUE, FALSE, $8, $8
        )`,
        [
          property_id,
          rate_plan_id,
          existingStart,
          existingEnd,
          existing.override_rate,
          remainingDow.sort((a: number, b: number) => a - b),
          existing.reason ? `[DOW Split #${existing.id}] ${existing.reason}` : `[DOW Split #${existing.id}]`,
          actor || 'SYSTEM'
        ]
      );
    }

    // 3. Preserve left date slice if existing starts before requested start
    if (existingStart < start_date) {
      const leftEnd = existingEnd < start_date ? existingEnd : start_date;
      const sliceDow = existing.days_of_week ? overlapDow : null;
      await client.query(
        `INSERT INTO rate_overrides (
          property_id, rate_plan_id, start_date, end_date, override_rate,
          days_of_week, reason, is_active, is_archived, created_by, updated_by
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, TRUE, FALSE, $8, $8
        )`,
        [
          property_id,
          rate_plan_id,
          existingStart,
          leftEnd,
          existing.override_rate,
          sliceDow,
          existing.reason ? `[Slice #${existing.id}] ${existing.reason}` : `[Slice #${existing.id}]`,
          actor || 'SYSTEM'
        ]
      );
    }

    // 4. Preserve right date slice if existing ends after requested end
    if (existingEnd > end_date) {
      const rightStart = existingStart > end_date ? existingStart : end_date;
      const sliceDow = existing.days_of_week ? overlapDow : null;
      await client.query(
        `INSERT INTO rate_overrides (
          property_id, rate_plan_id, start_date, end_date, override_rate,
          days_of_week, reason, is_active, is_archived, created_by, updated_by
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, TRUE, FALSE, $8, $8
        )`,
        [
          property_id,
          rate_plan_id,
          rightStart,
          existingEnd,
          existing.override_rate,
          sliceDow,
          existing.reason ? `[Slice #${existing.id}] ${existing.reason}` : `[Slice #${existing.id}]`,
          actor || 'SYSTEM'
        ]
      );
    }
  }

  // 5. Insert new requested override
  const insertRes = await client.query(
    `INSERT INTO rate_overrides (
      property_id, rate_plan_id, start_date, end_date, override_rate,
      days_of_week, reason, is_active, is_archived, created_by, updated_by
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, TRUE, FALSE, $8, $8
    ) RETURNING *`,
    [
      property_id,
      rate_plan_id,
      start_date,
      end_date,
      override_rate,
      targetDow,
      reason?.trim() || null,
      actor || 'SYSTEM'
    ]
  );

  const row = insertRes.rows[0];
  return {
    ...row,
    id: Number(row.id),
    property_id: Number(row.property_id),
    rate_plan_id: Number(row.rate_plan_id),
    override_rate: Number(row.override_rate),
    start_date: typeof row.start_date === 'string' ? row.start_date.slice(0, 10) : toHotelDateString(row.start_date),
    end_date: typeof row.end_date === 'string' ? row.end_date.slice(0, 10) : toHotelDateString(row.end_date)
  };
}

/**
 * Preview bulk rate overrides (Zero writes, property isolated, deterministic fingerprint).
 */
export async function previewBulkRateOverrides(
  client: PoolClient | Pool,
  propertyId: number,
  dto: BulkRateOverrideDto
): Promise<BulkRateOverridePreviewResult> {
  if (!dto.rate_plan_ids || dto.rate_plan_ids.length === 0) {
    throw new Error('Setidaknya satu Rate Plan harus dipilih.');
  }

  if (dto.start_date >= dto.end_date) {
    throw new Error('Tanggal mulai menginap harus sebelum tanggal selesai.');
  }

  const proposedRate = Math.round(Number(dto.override_rate));
  if (isNaN(proposedRate) || proposedRate <= 0) {
    throw new Error('Harga Override harus berupa bilangan bulat positif.');
  }

  // 1. Validate property ownership for all requested rate plans
  const plansRes = await client.query(
    `SELECT rp.id, rp.property_id, rp.room_type_id, rp.code, rp.name, rp.base_rate,
            rt.name as room_type_name, rt.code as room_type_code
     FROM rate_plans rp
     JOIN room_types rt ON rp.room_type_id = rt.id
     WHERE rp.id = ANY($1::bigint[]) AND rp.property_id = $2 AND rp.is_archived = FALSE`,
    [dto.rate_plan_ids, propertyId]
  );

  if (plansRes.rows.length !== dto.rate_plan_ids.length) {
    throw new Error('Satu atau lebih Rate Plan tidak valid atau bukan milik properti ini.');
  }

  const plansMap = new Map<number, any>();
  for (const p of plansRes.rows) {
    plansMap.set(Number(p.id), {
      ...p,
      id: Number(p.id),
      base_rate: Number(p.base_rate),
      room_type_id: Number(p.room_type_id)
    });
  }

  // 2. Query all active overrides in window (ZERO WRITES)
  const overridesRes = await client.query(
    `SELECT * FROM rate_overrides
     WHERE property_id = $1
       AND rate_plan_id = ANY($2::bigint[])
       AND is_active = TRUE
       AND is_archived = FALSE
       AND end_date > $3
       AND start_date < $4
     ORDER BY id ASC`,
    [propertyId, dto.rate_plan_ids, dto.start_date, dto.end_date]
  );

  const activeOverrides = overridesRes.rows.map((r) => ({
    ...r,
    id: Number(r.id),
    rate_plan_id: Number(r.rate_plan_id),
    override_rate: Number(r.override_rate),
    start_date: typeof r.start_date === 'string' ? r.start_date.slice(0, 10) : toHotelDateString(r.start_date),
    end_date: typeof r.end_date === 'string' ? r.end_date.slice(0, 10) : toHotelDateString(r.end_date)
  }));

  // 3. Generate deterministic preview fingerprint
  const previewToken = computeRateCalendarFingerprint({
    property_id: propertyId,
    rate_plan_ids: dto.rate_plan_ids,
    start_date: dto.start_date,
    end_date: dto.end_date,
    days_of_week: dto.days_of_week || null,
    proposed_rate: proposedRate,
    active_overrides: activeOverrides
  });

  // 4. Build per-date breakdown
  const stayDates = getStayDatesArray(dto.start_date, dto.end_date);
  const targetDow = dto.days_of_week && dto.days_of_week.length > 0 ? dto.days_of_week : null;

  const breakdown: BulkRateOverridePreviewItem[] = [];
  let affectedDatesCount = 0;
  let replacementsCount = 0;

  for (const rawPlanId of dto.rate_plan_ids) {
    const planId = Number(rawPlanId);
    const plan = plansMap.get(planId);
    if (!plan) continue;

    const planOverrides = activeOverrides.filter((o) => Number(o.rate_plan_id) === planId);

    for (const stayDate of stayDates) {
      const dow = getIsoDayOfWeek(stayDate);
      const dayName = getIndonesianDayName(dow);

      // Check DOW filter
      if (targetDow && !targetDow.includes(dow)) {
        continue;
      }

      // Find active override for this stay date
      const matching = planOverrides.find((o) => {
        if (stayDate < o.start_date || stayDate >= o.end_date) return false;
        if (o.days_of_week && o.days_of_week.length > 0 && !o.days_of_week.includes(dow)) return false;
        return true;
      });

      const currentEffectiveRate = matching ? matching.override_rate : plan.base_rate;
      let status: 'NEW' | 'REPLACE' | 'UNCHANGED' | 'CONFLICT' = 'NEW';

      if (matching) {
        if (matching.override_rate === proposedRate) {
          status = 'UNCHANGED';
        } else {
          status = 'REPLACE';
          replacementsCount++;
          affectedDatesCount++;
        }
      } else {
        if (plan.base_rate === proposedRate) {
          status = 'UNCHANGED';
        } else {
          status = 'NEW';
          affectedDatesCount++;
        }
      }

      breakdown.push({
        stay_date: stayDate,
        day_of_week: dow,
        day_name: dayName,
        room_type_id: plan.room_type_id,
        room_type_name: plan.room_type_name,
        rate_plan_id: plan.id,
        rate_plan_name: plan.name,
        rate_plan_code: plan.code,
        base_rate: plan.base_rate,
        current_effective_rate: currentEffectiveRate,
        proposed_rate: proposedRate,
        existing_override_id: matching ? matching.id : null,
        status,
        reason: dto.reason?.trim() || null
      });
    }
  }

  return {
    property_id: propertyId,
    affected_dates_count: affectedDatesCount,
    replacements_count: replacementsCount,
    preview_token: previewToken,
    breakdown
  };
}

/**
 * Transaction-scoped PostgreSQL advisory lock for Rate Calendar mutations.
 * Locks (property_id, rate_plan_id) in deterministic sorted rate_plan_id order.
 * Automatically released at COMMIT or ROLLBACK. Fail-closed.
 */
export async function acquireRateCalendarTransactionLocks(
  client: PoolClient | Pool,
  propertyId: number,
  ratePlanIds: number[]
): Promise<void> {
  const sortedPlanIds = Array.from(new Set(ratePlanIds.map((id) => Number(id)))).sort((a, b) => a - b);
  for (const planId of sortedPlanIds) {
    if (!Number.isFinite(planId) || planId <= 0) {
      throw { statusCode: 400, code: 'VALIDATION_ERROR', message: `Invalid rate_plan_id ${planId} for locking` };
    }
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('oak_rate_calendar_' || $1 || '_' || $2))`,
      [propertyId, planId]
    );
  }
}

/**
 * Apply bulk rate overrides atomically with concurrency verification.
 */
export async function applyBulkRateOverrides(
  pool: Pool,
  propertyId: number,
  dto: BulkRateOverrideDto,
  actor?: string
): Promise<{ success: boolean; message: string; preview_token: string }> {
  if (!dto.rate_plan_ids || dto.rate_plan_ids.length === 0) {
    throw new Error('Setidaknya satu Rate Plan harus dipilih.');
  }

  if (dto.start_date >= dto.end_date) {
    throw new Error('Tanggal mulai menginap harus sebelum tanggal selesai.');
  }

  const proposedRate = Math.round(Number(dto.override_rate));
  if (isNaN(proposedRate) || proposedRate <= 0) {
    throw new Error('Harga Override harus berupa bilangan bulat positif.');
  }

  if (!dto.preview_token) {
    throw new Error('preview_token wajib disertakan untuk menerapkan perubahan kalender tarif.');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Property Isolation & Plan validation
    const plansRes = await client.query(
      `SELECT id FROM rate_plans 
       WHERE id = ANY($1::bigint[]) AND property_id = $2 AND is_archived = FALSE`,
      [dto.rate_plan_ids, propertyId]
    );

    if (plansRes.rows.length !== dto.rate_plan_ids.length) {
      throw new Error('Satu atau lebih Rate Plan tidak valid atau bukan milik properti ini.');
    }

    // 2. Transaction-Scoped Advisory Locks (sorted rate_plan_ids)
    await acquireRateCalendarTransactionLocks(client, propertyId, dto.rate_plan_ids);

    // 3. Lock active overrides in window (FOR UPDATE)
    const lockedRes = await client.query(
      `SELECT id, rate_plan_id, start_date, end_date, days_of_week, override_rate, updated_at, is_active, is_archived
       FROM rate_overrides
       WHERE property_id = $1
         AND rate_plan_id = ANY($2::bigint[])
         AND is_active = TRUE
         AND is_archived = FALSE
         AND end_date > $3
         AND start_date < $4
       ORDER BY id ASC
       FOR UPDATE`,
      [propertyId, dto.rate_plan_ids, dto.start_date, dto.end_date]
    );

    // 4. Reconstruct canonical fingerprint from live locked rows
    const currentToken = computeRateCalendarFingerprint({
      property_id: propertyId,
      rate_plan_ids: dto.rate_plan_ids,
      start_date: dto.start_date,
      end_date: dto.end_date,
      days_of_week: dto.days_of_week || null,
      proposed_rate: proposedRate,
      active_overrides: lockedRes.rows
    });

    // 5. Compare with provided preview_token
    if (currentToken !== dto.preview_token) {
      const err: any = new Error(
        'Rate Calendar berubah sejak pratinjau dibuat. Silakan perbarui pratinjau sebelum menerapkan perubahan.'
      );
      err.code = 'RATE_CALENDAR_CHANGED';
      err.statusCode = 409;
      throw err;
    }

    // 6. Apply immutable override for each selected plan
    for (const planId of dto.rate_plan_ids) {
      await applyRateOverrideImmutable(client, {
        property_id: propertyId,
        rate_plan_id: planId,
        start_date: dto.start_date,
        end_date: dto.end_date,
        override_rate: proposedRate,
        days_of_week: dto.days_of_week,
        reason: dto.reason,
        actor
      });
    }

    // 7. Write Audit Log
    await logAudit(client, {
      property_id: propertyId,
      action: 'RATE_OVERRIDE_BULK_APPLIED',
      entity_type: 'rate_overrides',
      entity_id: 'BULK',
      after: {
        rate_plan_ids: dto.rate_plan_ids,
        start_date: dto.start_date,
        end_date: dto.end_date,
        override_rate: proposedRate,
        days_of_week: dto.days_of_week,
        reason: dto.reason
      },
      actor
    });

    await client.query('COMMIT');

    return {
      success: true,
      message: 'Perubahan tarif kalender berhasil diterapkan secara aman.',
      preview_token: currentToken
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function upsertRateOverride(
  poolOrClient: PoolClient | Pool,
  propertyId: number,
  ratePlanId: number,
  dto: CreateRateOverrideDto,
  actor?: string
): Promise<RateOverride> {
  const isPool = typeof (poolOrClient as any).connect === 'function';
  const client = isPool ? await (poolOrClient as Pool).connect() : (poolOrClient as PoolClient);

  try {
    if (isPool) await client.query('BEGIN');

    const ratePlan = await getRatePlanById(client, propertyId, ratePlanId);
    if (!ratePlan) throw new Error(`Rate Plan with ID ${ratePlanId} not found.`);

    if (dto.start_date >= dto.end_date) {
      throw new Error('Tanggal mulai harus sebelum tanggal selesai.');
    }

    const overrideRate = Math.round(Number(dto.override_rate));
    if (isNaN(overrideRate) || overrideRate <= 0) {
      throw new Error('Harga Override harus berupa bilangan bulat positif.');
    }

    // Acquire transaction advisory lock
    await acquireRateCalendarTransactionLocks(client, propertyId, [ratePlanId]);

    // Use the canonical immutable override engine
    const override = await applyRateOverrideImmutable(client, {
      property_id: propertyId,
      rate_plan_id: ratePlanId,
      start_date: dto.start_date,
      end_date: dto.end_date,
      override_rate: overrideRate,
      days_of_week: dto.days_of_week,
      reason: dto.reason,
      actor
    });

    await logAudit(client, {
      property_id: propertyId,
      action: 'RATE_OVERRIDE_CREATED',
      entity_type: 'rate_overrides',
      entity_id: override.id,
      after: override,
      actor
    });

    if (isPool) await client.query('COMMIT');
    return override;
  } catch (err) {
    if (isPool) await client.query('ROLLBACK');
    throw err;
  } finally {
    if (isPool) (client as PoolClient).release();
  }
}

export async function deleteRateOverride(
  poolOrClient: PoolClient | Pool,
  propertyId: number,
  overrideId: number,
  actor?: string,
  targetDate?: string
): Promise<{ success: boolean; message: string }> {
  const isPool = typeof (poolOrClient as any).connect === 'function';
  const client = isPool ? await (poolOrClient as Pool).connect() : (poolOrClient as PoolClient);

  try {
    if (isPool) await client.query('BEGIN');

    const res = await client.query(
      'SELECT * FROM rate_overrides WHERE id = $1 AND property_id = $2',
      [overrideId, propertyId]
    );
    if (res.rows.length === 0) throw new Error(`Rate override with ID ${overrideId} not found.`);

    const current = res.rows[0];
    const currentStart = typeof current.start_date === 'string' ? current.start_date.slice(0, 10) : toHotelDateString(current.start_date);
    const currentEnd = typeof current.end_date === 'string' ? current.end_date.slice(0, 10) : toHotelDateString(current.end_date);

    // Acquire transaction advisory lock
    await acquireRateCalendarTransactionLocks(client, propertyId, [Number(current.rate_plan_id)]);

    // Soft archive the original override
    await client.query(
      'UPDATE rate_overrides SET is_archived = TRUE, is_active = FALSE, updated_by = $1, updated_at = NOW() WHERE id = $2 AND property_id = $3',
      [actor || 'SYSTEM', overrideId, propertyId]
    );

    // If a specific targetDate was requested to be reset and the override spans multiple days, preserve the slices
    if (targetDate && targetDate >= currentStart && targetDate < currentEnd) {
      const nextDate = addDays(targetDate, 1);
      
      // Left slice
      if (currentStart < targetDate) {
        await client.query(
          `INSERT INTO rate_overrides (
            property_id, rate_plan_id, start_date, end_date, override_rate,
            days_of_week, reason, is_active, is_archived, created_by, updated_by
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, TRUE, FALSE, $8, $8
          )`,
          [
            propertyId,
            current.rate_plan_id,
            currentStart,
            targetDate,
            current.override_rate,
            current.days_of_week,
            current.reason ? `[Slice #${current.id}] ${current.reason}` : `[Slice #${current.id}]`,
            actor || 'SYSTEM'
          ]
        );
      }

      // Right slice
      if (currentEnd > nextDate) {
        await client.query(
          `INSERT INTO rate_overrides (
            property_id, rate_plan_id, start_date, end_date, override_rate,
            days_of_week, reason, is_active, is_archived, created_by, updated_by
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, TRUE, FALSE, $8, $8
          )`,
          [
            propertyId,
            current.rate_plan_id,
            nextDate,
            currentEnd,
            current.override_rate,
            current.days_of_week,
            current.reason ? `[Slice #${current.id}] ${current.reason}` : `[Slice #${current.id}]`,
            actor || 'SYSTEM'
          ]
        );
      }
    }

    await logAudit(client, {
      property_id: propertyId,
      action: 'RATE_OVERRIDE_DELETED',
      entity_type: 'rate_overrides',
      entity_id: overrideId,
      before: current,
      after: { is_archived: true, is_active: false, reset_date: targetDate || null },
      actor
    });

    if (isPool) await client.query('COMMIT');

    return {
      success: true,
      message: targetDate
        ? `Tarif override untuk ${targetDate} berhasil direset ke tarif standar.`
        : 'Override tarif berhasil dihapus.'
    };
  } catch (err) {
    if (isPool) await client.query('ROLLBACK');
    throw err;
  } finally {
    if (isPool) (client as PoolClient).release();
  }
}

export async function calculatePriceQuote(
  client: PoolClient | Pool,
  input: PriceQuoteInput
): Promise<PriceQuoteResult> {
  const { property_id, room_type_id, check_in, check_out } = input;
  const isDayUse = input.stay_type === 'DAY_USE';

  if (isDayUse) {
    if (check_in > check_out) {
      throw new Error('Check-in date cannot be after check-out date.');
    }
  } else {
    if (check_in >= check_out) {
      throw new Error('Check-in date must be strictly before check-out date.');
    }
  }

  // 1. Validate room type & property
  const rtRes = await client.query(
    'SELECT id, property_id, code, name, base_rate, is_active FROM room_types WHERE id = $1 AND property_id = $2',
    [room_type_id, property_id]
  );
  if (rtRes.rows.length === 0) {
    throw new Error(`Room type ${room_type_id} not found for property ${property_id}.`);
  }
  const roomTypeRow = rtRes.rows[0];

  // 2. Resolve Rate Plan
  let ratePlan: RatePlan;
  if (input.rate_plan_id) {
    const fetchedPlan = await getRatePlanById(client, property_id, input.rate_plan_id);
    if (!fetchedPlan) {
      throw new Error(`Rate Plan with ID ${input.rate_plan_id} not found for property ${property_id}.`);
    }
    if (fetchedPlan.room_type_id !== room_type_id) {
      throw new Error(`Rate Plan ${fetchedPlan.code} does not belong to room type ${roomTypeRow.code}.`);
    }
    if (fetchedPlan.is_active === false) {
      throw new Error(`Rate Plan ${fetchedPlan.code} is currently inactive.`);
    }
    if (isDayUse && fetchedPlan.rate_type === 'OVERNIGHT') {
      throw new Error(`Rate Plan ${fetchedPlan.code} is an OVERNIGHT plan and cannot be used for DAY_USE reservations.`);
    }
    if (!isDayUse && fetchedPlan.rate_type === 'DAY_USE') {
      throw new Error(`Rate Plan ${fetchedPlan.code} is a DAY_USE plan and cannot be used for OVERNIGHT reservations.`);
    }
    ratePlan = fetchedPlan;
  } else {
    // Fallback to active BAR rate plan for this room type, or fallback object
    const plans = await listRatePlans(client, property_id, {
      room_type_id,
      is_active: true,
      include_archived: false
    });
    const matchedPlan = plans.find(p => isDayUse ? p.rate_type === 'DAY_USE' : p.rate_type !== 'DAY_USE');
    if (matchedPlan) {
      ratePlan = matchedPlan;
    } else if (plans.length > 0 && !isDayUse) {
      ratePlan = plans[0];
    } else {
      // Legacy fallback
      ratePlan = {
        id: 0,
        property_id,
        room_type_id,
        code: isDayUse ? 'STANDARD_DAYUSE' : 'STANDARD',
        name: isDayUse ? 'Standard Day Use Rate' : 'Standard Base Rate',
        description: null,
        base_rate: Math.round(Number(roomTypeRow.base_rate || 0)),
        currency: 'IDR',
        meal_plan: 'RO',
        refundable: true,
        cancellation_policy: null,
        payment_policy: null,
        valid_from: null,
        valid_until: null,
        min_stay: 1,
        max_stay: null,
        min_advance_days: 0,
        max_advance_days: null,
        extra_person_rate: 0,
        extra_bed_rate: 0,
        days_of_week: null,
        rate_type: isDayUse ? 'DAY_USE' : 'OVERNIGHT',
        is_active: true,
        is_archived: false,
        sort_order: 0,
        created_by: null,
        created_at: new Date().toISOString(),
        updated_by: null,
        updated_at: new Date().toISOString(),
      };
    }
  }

  // 3. Fetch overrides if ratePlan has an id
  const overrides: RateOverride[] = ratePlan.id > 0
    ? await listRateOverrides(client, property_id, ratePlan.id, check_in, check_out)
    : [];

  // 4. Fetch Property Pricing Settings
  const pricingSettings = await getPropertyPricingSettings(client, property_id);

  // 5. Generate stay dates & calculate nightly quotes
  const stayDates = isDayUse && check_in === check_out ? [check_in] : getStayDatesArray(check_in, check_out);
  const nightlyBreakdown: NightlyQuote[] = stayDates.map((dateStr) => {
    const dow = getIsoDayOfWeek(dateStr);

    const matchingOverride = overrides.find((o) => {
      if (!o.is_active || o.is_archived) return false;
      if (dateStr < o.start_date || dateStr >= o.end_date) return false;
      if (o.days_of_week && o.days_of_week.length > 0 && !o.days_of_week.includes(dow)) return false;
      return true;
    });

    const finalRate = matchingOverride ? matchingOverride.override_rate : ratePlan!.base_rate;
    const nightService = Math.round(finalRate * (pricingSettings.service_charge_percent / 100));
    const nightTaxBase = finalRate + nightService;
    const nightTax = Math.round(nightTaxBase * (pricingSettings.tax_percent / 100));
    const nightTotal = finalRate + nightService + nightTax;

    return {
      stay_date: dateStr,
      day_of_week: dow,
      base_rate: ratePlan!.base_rate,
      applied_override_rate: matchingOverride ? matchingOverride.override_rate : null,
      final_room_rate: finalRate,
      service_amount: nightService,
      tax_amount: nightTax,
      total_amount: nightTotal
    };
  });

  const roomSubtotal = nightlyBreakdown.reduce((sum, n) => sum + n.final_room_rate, 0);
  const totalService = Math.round(roomSubtotal * (pricingSettings.service_charge_percent / 100));
  const taxableBase = roomSubtotal + totalService;
  const totalTax = Math.round(taxableBase * (pricingSettings.tax_percent / 100));
  const grandTotal = roomSubtotal + totalService + totalTax;

  return {
    property_id,
    room_type: {
      id: roomTypeRow.id,
      code: roomTypeRow.code,
      name: roomTypeRow.name
    },
    rate_plan: {
      id: ratePlan.id,
      code: ratePlan.code,
      name: ratePlan.name,
      meal_plan: ratePlan.meal_plan,
      meal_plan_id: ratePlan.meal_plan_id,
      meal_plan_code: ratePlan.meal_plan_code,
      meal_plan_name: ratePlan.meal_plan_name,
      refundable: ratePlan.refundable
    },
    check_in,
    check_out,
    nights: stayDates.length,
    nightly_breakdown: nightlyBreakdown,
    room_subtotal: roomSubtotal,
    service_amount: totalService,
    tax_amount: totalTax,
    grand_total: grandTotal,
    pricing_settings: {
      tax_percent: pricingSettings.tax_percent,
      service_charge_percent: pricingSettings.service_charge_percent,
      prices_include_tax: pricingSettings.prices_include_tax,
      prices_include_service: pricingSettings.prices_include_service
    }
  };
}

// ============================================================================
// IMMUTABLE RESERVATION NIGHTLY SNAPSHOTS & REPRICING
// ============================================================================

export async function createReservationRateSnapshots(
  client: PoolClient | Pool,
  reservationId: number,
  propertyId: number,
  quote: PriceQuoteResult,
  overrideOptions?: { isManualOverride?: boolean; manualOverrideReason?: string | null }
): Promise<ReservationNightlyRate[]> {
  const snapshots: ReservationNightlyRate[] = [];
  const isManual = Boolean(overrideOptions?.isManualOverride);
  const overrideReason = overrideOptions?.manualOverrideReason || null;

  for (const item of quote.nightly_breakdown) {
    const res = await client.query(
      `INSERT INTO reservation_nightly_rates (
        reservation_id, property_id, stay_date,
        room_type_id, room_type_code_snapshot, room_type_name_snapshot,
        rate_plan_id, rate_plan_code_snapshot, rate_plan_name_snapshot,
        meal_plan_id, meal_plan_code_snapshot, meal_plan_name_snapshot,
        base_rate, applied_override_rate, final_room_rate,
        service_amount, tax_amount, total_amount,
        is_manual_override, manual_override_reason, created_at
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6,
        $7, $8, $9,
        $10, $11, $12,
        $13, $14, $15,
        $16, $17, $18,
        $19, $20, NOW()
      )
      ON CONFLICT (reservation_id, stay_date) DO UPDATE SET
        room_type_id = EXCLUDED.room_type_id,
        room_type_code_snapshot = EXCLUDED.room_type_code_snapshot,
        room_type_name_snapshot = EXCLUDED.room_type_name_snapshot,
        rate_plan_id = EXCLUDED.rate_plan_id,
        rate_plan_code_snapshot = EXCLUDED.rate_plan_code_snapshot,
        rate_plan_name_snapshot = EXCLUDED.rate_plan_name_snapshot,
        meal_plan_id = EXCLUDED.meal_plan_id,
        meal_plan_code_snapshot = EXCLUDED.meal_plan_code_snapshot,
        meal_plan_name_snapshot = EXCLUDED.meal_plan_name_snapshot,
        base_rate = EXCLUDED.base_rate,
        applied_override_rate = EXCLUDED.applied_override_rate,
        final_room_rate = EXCLUDED.final_room_rate,
        service_amount = EXCLUDED.service_amount,
        tax_amount = EXCLUDED.tax_amount,
        total_amount = EXCLUDED.total_amount,
        is_manual_override = EXCLUDED.is_manual_override,
        manual_override_reason = EXCLUDED.manual_override_reason
      RETURNING *`,
      [
        reservationId,
        propertyId,
        item.stay_date,
        quote.room_type.id,
        quote.room_type.code,
        quote.room_type.name,
        quote.rate_plan.id > 0 ? quote.rate_plan.id : null,
        quote.rate_plan.code,
        quote.rate_plan.name,
        quote.rate_plan.meal_plan_id || null,
        quote.rate_plan.meal_plan_code || quote.rate_plan.meal_plan || null,
        quote.rate_plan.meal_plan_name || quote.rate_plan.meal_plan || null,
        item.base_rate,
        item.applied_override_rate,
        item.final_room_rate,
        item.service_amount,
        item.tax_amount,
        item.total_amount,
        isManual,
        overrideReason
      ]
    );

    const r = res.rows[0];
    snapshots.push({
      ...r,
      id: Number(r.id),
      reservation_id: Number(r.reservation_id),
      property_id: Number(r.property_id),
      room_type_id: Number(r.room_type_id),
      rate_plan_id: r.rate_plan_id ? Number(r.rate_plan_id) : null,
      meal_plan_id: r.meal_plan_id ? Number(r.meal_plan_id) : null,
      meal_plan_code_snapshot: r.meal_plan_code_snapshot || null,
      meal_plan_name_snapshot: r.meal_plan_name_snapshot || null,
      base_rate: Number(r.base_rate),
      applied_override_rate: r.applied_override_rate ? Number(r.applied_override_rate) : null,
      final_room_rate: Number(r.final_room_rate),
      service_amount: Number(r.service_amount || 0),
      tax_amount: Number(r.tax_amount || 0),
      total_amount: Number(r.total_amount),
      stay_date: typeof r.stay_date === 'string' ? r.stay_date : toHotelDateString(r.stay_date)
    });
  }

  // Update parent reservation summary fields
  await client.query(
    `UPDATE reservations SET
      rate_plan_id = $1,
      rate_plan_code_snapshot = $2,
      rate_plan_name_snapshot = $3,
      meal_plan_id = $4,
      meal_plan_code_snapshot = $5,
      meal_plan_name_snapshot = $6,
      subtotal_amount = $7,
      tax_amount = $8,
      service_amount = $9,
      total_price = $10,
      remaining_balance = GREATEST(0, $10 - COALESCE(amount_paid, 0) - COALESCE(applied_deposit, 0)),
      is_manual_override = $12,
      manual_override_reason = $13
     WHERE id = $11`,
    [
      quote.rate_plan.id > 0 ? quote.rate_plan.id : null,
      quote.rate_plan.code,
      quote.rate_plan.name,
      quote.rate_plan.meal_plan_id || null,
      quote.rate_plan.meal_plan_code || quote.rate_plan.meal_plan || null,
      quote.rate_plan.meal_plan_name || quote.rate_plan.meal_plan || null,
      quote.room_subtotal,
      quote.tax_amount,
      quote.service_amount,
      quote.grand_total,
      reservationId,
      isManual,
      overrideReason
    ]
  );

  return snapshots;
}

export async function getReservationRateSnapshots(
  client: PoolClient | Pool,
  reservationId: number
): Promise<ReservationNightlyRate[]> {
  const res = await client.query(
    `SELECT * FROM reservation_nightly_rates WHERE reservation_id = $1 ORDER BY stay_date ASC`,
    [reservationId]
  );
  return res.rows.map((r) => ({
    ...r,
    id: Number(r.id),
    reservation_id: Number(r.reservation_id),
    property_id: Number(r.property_id),
    room_type_id: Number(r.room_type_id),
    rate_plan_id: r.rate_plan_id ? Number(r.rate_plan_id) : null,
    meal_plan_id: r.meal_plan_id ? Number(r.meal_plan_id) : null,
    meal_plan_code_snapshot: r.meal_plan_code_snapshot || null,
    meal_plan_name_snapshot: r.meal_plan_name_snapshot || null,
    base_rate: Number(r.base_rate),
    applied_override_rate: r.applied_override_rate ? Number(r.applied_override_rate) : null,
    final_room_rate: Number(r.final_room_rate),
    service_amount: Number(r.service_amount || 0),
    tax_amount: Number(r.tax_amount || 0),
    total_amount: Number(r.total_amount),
    stay_date: typeof r.stay_date === 'string' ? r.stay_date : toHotelDateString(r.stay_date)
  }));
}

export async function repriceReservationStayDates(
  client: PoolClient | Pool,
  reservationId: number,
  propertyId: number,
  newCheckIn: string,
  newCheckOut: string,
  options?: {
    full_reprice?: boolean;
    rate_plan_id?: number;
    actor?: string;
  }
): Promise<{ snapshots: ReservationNightlyRate[]; total_price: number }> {
  // Fetch existing snapshots
  const existingSnapshots = await getReservationRateSnapshots(client, reservationId);
  const existingDates = new Set(existingSnapshots.map((s) => s.stay_date));

  // Determine stay dates for new range
  const targetDates = getStayDatesArray(newCheckIn, newCheckOut);
  const targetDatesSet = new Set(targetDates);

  // 1. Delete removed dates (e.g. shortening stay)
  const datesToDelete = existingSnapshots
    .filter((s) => !targetDatesSet.has(s.stay_date))
    .map((s) => s.stay_date);

  if (datesToDelete.length > 0) {
    await client.query(
      `DELETE FROM reservation_nightly_rates WHERE reservation_id = $1 AND stay_date = ANY($2::date[])`,
      [reservationId, datesToDelete]
    );
  }

  // 2. Fetch reservation to get room_type_id & rate_plan_id
  const resCheck = await client.query(
    `SELECT r.*, rm.room_type_id AS physical_room_type_id
     FROM reservations r
     LEFT JOIN rooms rm ON rm.id = r.room_id
     WHERE r.id = $1`,
    [reservationId]
  );
  if (resCheck.rows.length === 0) throw new Error(`Reservation ${reservationId} not found.`);
  const reservation = resCheck.rows[0];

  const targetRoomTypeId = reservation.booked_room_type_id_snapshot || reservation.physical_room_type_id;
  const targetRatePlanId = options?.rate_plan_id || reservation.rate_plan_id;

  // 3. For newly added dates (e.g. extending stay) OR full repricing:
  const datesToQuote = options?.full_reprice
    ? targetDates
    : targetDates.filter((d) => !existingDates.has(d));

  if (datesToQuote.length > 0) {
    for (const d of datesToQuote) {
      const singleNightQuote = await calculatePriceQuote(client, {
        property_id: propertyId,
        room_type_id: targetRoomTypeId,
        rate_plan_id: targetRatePlanId || undefined,
        check_in: d,
        check_out: addDays(d, 1)
      });

      const night = singleNightQuote.nightly_breakdown[0];
      await client.query(
        `INSERT INTO reservation_nightly_rates (
          reservation_id, property_id, stay_date,
          room_type_id, room_type_code_snapshot, room_type_name_snapshot,
          rate_plan_id, rate_plan_code_snapshot, rate_plan_name_snapshot,
          meal_plan_id, meal_plan_code_snapshot, meal_plan_name_snapshot,
          base_rate, applied_override_rate, final_room_rate,
          service_amount, tax_amount, total_amount, created_at
        ) VALUES (
          $1, $2, $3,
          $4, $5, $6,
          $7, $8, $9,
          $10, $11, $12,
          $13, $14, $15,
          $16, $17, $18, NOW()
        )
        ON CONFLICT (reservation_id, stay_date) DO UPDATE SET
          room_type_id = EXCLUDED.room_type_id,
          room_type_code_snapshot = EXCLUDED.room_type_code_snapshot,
          room_type_name_snapshot = EXCLUDED.room_type_name_snapshot,
          rate_plan_id = EXCLUDED.rate_plan_id,
          rate_plan_code_snapshot = EXCLUDED.rate_plan_code_snapshot,
          rate_plan_name_snapshot = EXCLUDED.rate_plan_name_snapshot,
          meal_plan_id = EXCLUDED.meal_plan_id,
          meal_plan_code_snapshot = EXCLUDED.meal_plan_code_snapshot,
          meal_plan_name_snapshot = EXCLUDED.meal_plan_name_snapshot,
          base_rate = EXCLUDED.base_rate,
          applied_override_rate = EXCLUDED.applied_override_rate,
          final_room_rate = EXCLUDED.final_room_rate,
          service_amount = EXCLUDED.service_amount,
          tax_amount = EXCLUDED.tax_amount,
          total_amount = EXCLUDED.total_amount`,
        [
          reservationId,
          propertyId,
          night.stay_date,
          singleNightQuote.room_type.id,
          singleNightQuote.room_type.code,
          singleNightQuote.room_type.name,
          singleNightQuote.rate_plan.id > 0 ? singleNightQuote.rate_plan.id : null,
          singleNightQuote.rate_plan.code,
          singleNightQuote.rate_plan.name,
          singleNightQuote.rate_plan.meal_plan_id || null,
          singleNightQuote.rate_plan.meal_plan_code || singleNightQuote.rate_plan.meal_plan || null,
          singleNightQuote.rate_plan.meal_plan_name || singleNightQuote.rate_plan.meal_plan || null,
          night.base_rate,
          night.applied_override_rate,
          night.final_room_rate,
          night.service_amount,
          night.tax_amount,
          night.total_amount
        ]
      );
    }
  }

  // 4. Recalculate totals from updated snapshots
  const finalSnapshots = await getReservationRateSnapshots(client, reservationId);
  const totalSubtotal = finalSnapshots.reduce((sum, s) => sum + s.final_room_rate, 0);
  const totalService = finalSnapshots.reduce((sum, s) => sum + s.service_amount, 0);
  const totalTax = finalSnapshots.reduce((sum, s) => sum + s.tax_amount, 0);
  const grandTotal = totalSubtotal + totalService + totalTax;

  await client.query(
    `UPDATE reservations SET
      check_in = $1,
      check_out = $2,
      subtotal_amount = $3,
      service_amount = $4,
      tax_amount = $5,
      total_price = $6,
      remaining_balance = GREATEST(0, $6 - COALESCE(amount_paid, 0) - COALESCE(applied_deposit, 0))
     WHERE id = $7`,
    [newCheckIn, newCheckOut, totalSubtotal, totalService, totalTax, grandTotal, reservationId]
  );

  await logAudit(client, {
    property_id: propertyId,
    action: 'RESERVATION_RATE_REPRICED',
    entity_type: 'reservations',
    entity_id: reservationId,
    after: { check_in: newCheckIn, check_out: newCheckOut, total_price: grandTotal },
    actor: options?.actor
  });

  return { snapshots: finalSnapshots, total_price: grandTotal };
}

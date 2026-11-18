import type { Pool, PoolClient } from 'pg';
import type {
  DuplicateCandidate,
  DuplicateCandidateCluster,
  DuplicateCheckInput,
  DuplicateCheckResult,
  Guest,
  GuestCrmSummary,
  GuestCreateInput,
  GuestLoyaltyLedgerEntry,
  GuestMergeInput,
  GuestMergeResult,
  GuestRole,
  GuestUpdateInput,
  GuestWithStats,
  LoyaltyCalculationPeriod,
  LoyaltyTierCode,
  MatchClassification,
  PropertyLoyaltySettings,
  PropertyLoyaltyTierConfig,
  ReservationGuest,
  ReservationGuestCreateInput,
  ReservationGuestUpdateInput,
  VipStatus
} from './guestTypes';

export const DEFAULT_TIERS_CONFIG: PropertyLoyaltyTierConfig[] = [
  { code: 'BRONZE', name: 'Bronze', min_spend: 0, discount_pct: 0 },
  { code: 'SILVER', name: 'Silver', min_spend: 500000, discount_pct: 2 },
  { code: 'GOLD', name: 'Gold', min_spend: 2500000, discount_pct: 5 },
  { code: 'PLATINUM', name: 'Platinum', min_spend: 5000000, discount_pct: 25 },
];

export const DEFAULT_WA_BIRTHDAY_MESSAGE =
  'Selamat ulang tahun {nama}! 🎉 Ada hadiah spesial dari {toko} untuk Anda.';
export const DEFAULT_WA_FOLLOWUP_MESSAGE =
  'Halo {nama}, apa kabar? Kami dari {toko} merindukan kunjungan Anda sejak {terakhir}. Dapatkan promo spesial untuk kunjungan berikutnya!';
export const DEFAULT_WA_DATABASE_MESSAGE =
  'Halo {nama}, terima kasih telah menjadi pelanggan setia {toko}. Hubungi kami untuk reservasi kamar atau promo terbaru!';

let crmTablesEnsured = false;
export async function ensureGuestCrmTables(pool: Pool | PoolClient): Promise<void> {
  if (crmTablesEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guest_loyalty_ledger (
      id BIGSERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL,
      guest_id BIGINT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
      entry_type VARCHAR(30) NOT NULL CHECK (entry_type IN ('BONUS', 'REDEEM', 'ADJUSTMENT')),
      points INTEGER NOT NULL,
      description TEXT NOT NULL,
      reference_no VARCHAR(100),
      created_by VARCHAR(120),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_guest_loyalty_ledger_prop_guest
      ON guest_loyalty_ledger(property_id, guest_id);

    CREATE TABLE IF NOT EXISTS property_loyalty_settings (
      property_id INTEGER PRIMARY KEY,
      points_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      spend_per_point NUMERIC(14,2) NOT NULL DEFAULT 10000,
      points_earned_per_unit INTEGER NOT NULL DEFAULT 1,
      points_per_visit INTEGER NOT NULL DEFAULT 1,
      point_value_idr NUMERIC(14,2) NOT NULL DEFAULT 350,
      min_redeem_points INTEGER NOT NULL DEFAULT 50,
      point_expiry_months INTEGER NOT NULL DEFAULT 12,
      silver_point_threshold INTEGER NOT NULL DEFAULT 1000,
      gold_point_threshold INTEGER NOT NULL DEFAULT 2000,
      platinum_point_threshold INTEGER NOT NULL DEFAULT 5000,
      tier_calculation_period VARCHAR(30) NOT NULL DEFAULT 'CUMULATIVE',
      tiers_config JSONB NOT NULL DEFAULT '[]'::jsonb,
      wa_birthday_message TEXT NOT NULL DEFAULT 'Selamat ulang tahun {nama}! 🎉 Ada hadiah spesial dari {toko} untuk Anda.',
      wa_followup_message TEXT NOT NULL DEFAULT 'Halo {nama}, apa kabar? Kami dari {toko} merindukan kunjungan Anda sejak {terakhir}. Dapatkan promo spesial untuk kunjungan berikutnya!',
      wa_database_message TEXT NOT NULL DEFAULT 'Halo {nama}, terima kasih telah menjadi pelanggan setia {toko}. Hubungi kami untuk reservasi kamar atau promo terbaru!',
      followup_threshold_days INTEGER NOT NULL DEFAULT 90,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  crmTablesEnsured = true;
}

export async function getPropertyLoyaltySettings(
  pool: Pool | PoolClient,
  propertyId: number
): Promise<PropertyLoyaltySettings> {
  await ensureGuestCrmTables(pool);
  const res = await pool.query(
    `SELECT * FROM property_loyalty_settings WHERE property_id = $1`,
    [propertyId]
  );
  if ((res.rowCount ?? 0) === 0) {
    return {
      property_id: propertyId,
      points_enabled: true,
      spend_per_point: 10000,
      points_earned_per_unit: 1,
      points_per_visit: 1,
      point_value_idr: 350,
      min_redeem_points: 50,
      point_expiry_months: 12,
      silver_point_threshold: 1000,
      gold_point_threshold: 2000,
      platinum_point_threshold: 5000,
      tier_calculation_period: 'CUMULATIVE',
      tiers_config: DEFAULT_TIERS_CONFIG,
      wa_birthday_message: DEFAULT_WA_BIRTHDAY_MESSAGE,
      wa_followup_message: DEFAULT_WA_FOLLOWUP_MESSAGE,
      wa_database_message: DEFAULT_WA_DATABASE_MESSAGE,
      followup_threshold_days: 90,
    };
  }
  const row = res.rows[0];
  const parsedTiers = Array.isArray(row.tiers_config) && row.tiers_config.length > 0
    ? row.tiers_config
    : DEFAULT_TIERS_CONFIG;
  return {
    property_id: Number(row.property_id),
    points_enabled: Boolean(row.points_enabled),
    spend_per_point: Math.max(1, Number(row.spend_per_point || 10000)),
    points_earned_per_unit: Math.max(0, Number(row.points_earned_per_unit ?? 1)),
    points_per_visit: Math.max(0, Number(row.points_per_visit ?? 1)),
    point_value_idr: Math.max(1, Number(row.point_value_idr || 350)),
    min_redeem_points: Math.max(1, Number(row.min_redeem_points || 50)),
    point_expiry_months: Math.max(1, Number(row.point_expiry_months || 12)),
    silver_point_threshold: Math.max(0, Number(row.silver_point_threshold ?? 1000)),
    gold_point_threshold: Math.max(0, Number(row.gold_point_threshold ?? 2000)),
    platinum_point_threshold: Math.max(0, Number(row.platinum_point_threshold ?? 5000)),
    tier_calculation_period: (['CUMULATIVE', 'MONTHLY', 'QUARTERLY', 'YEARLY'].includes(row.tier_calculation_period)
      ? row.tier_calculation_period
      : 'CUMULATIVE') as LoyaltyCalculationPeriod,
    tiers_config: parsedTiers,
    wa_birthday_message: String(row.wa_birthday_message || DEFAULT_WA_BIRTHDAY_MESSAGE),
    wa_followup_message: String(row.wa_followup_message || DEFAULT_WA_FOLLOWUP_MESSAGE),
    wa_database_message: String(row.wa_database_message || DEFAULT_WA_DATABASE_MESSAGE),
    followup_threshold_days: Math.max(1, Number(row.followup_threshold_days || 90)),
    updated_at: row.updated_at,
  };
}

export async function updatePropertyLoyaltySettings(
  pool: Pool,
  propertyId: number,
  input: Partial<PropertyLoyaltySettings>,
  correlationId?: string,
  actorUserId?: number | null
): Promise<PropertyLoyaltySettings> {
  await assertPropertyExists(pool, propertyId);
  const current = await getPropertyLoyaltySettings(pool, propertyId);

  const next: PropertyLoyaltySettings = {
    property_id: propertyId,
    points_enabled: input.points_enabled !== undefined ? Boolean(input.points_enabled) : current.points_enabled,
    spend_per_point: input.spend_per_point !== undefined ? Math.max(1, Number(input.spend_per_point)) : current.spend_per_point,
    points_earned_per_unit: input.points_earned_per_unit !== undefined ? Math.max(0, Math.round(Number(input.points_earned_per_unit))) : current.points_earned_per_unit,
    points_per_visit: input.points_per_visit !== undefined ? Math.max(0, Math.round(Number(input.points_per_visit))) : current.points_per_visit,
    point_value_idr: input.point_value_idr !== undefined ? Math.max(1, Number(input.point_value_idr)) : current.point_value_idr,
    min_redeem_points: input.min_redeem_points !== undefined ? Math.max(1, Math.round(Number(input.min_redeem_points))) : current.min_redeem_points,
    point_expiry_months: input.point_expiry_months !== undefined ? Math.max(1, Math.round(Number(input.point_expiry_months))) : current.point_expiry_months,
    silver_point_threshold: input.silver_point_threshold !== undefined ? Math.max(0, Math.round(Number(input.silver_point_threshold))) : current.silver_point_threshold,
    gold_point_threshold: input.gold_point_threshold !== undefined ? Math.max(0, Math.round(Number(input.gold_point_threshold))) : current.gold_point_threshold,
    platinum_point_threshold: input.platinum_point_threshold !== undefined ? Math.max(0, Math.round(Number(input.platinum_point_threshold))) : current.platinum_point_threshold,
    tier_calculation_period: (input.tier_calculation_period && ['CUMULATIVE', 'MONTHLY', 'QUARTERLY', 'YEARLY'].includes(input.tier_calculation_period)
      ? input.tier_calculation_period
      : current.tier_calculation_period) as LoyaltyCalculationPeriod,
    tiers_config: Array.isArray(input.tiers_config) && input.tiers_config.length > 0
      ? input.tiers_config.map((t) => ({
          code: (['BRONZE', 'SILVER', 'GOLD', 'PLATINUM'].includes(String(t.code).toUpperCase()) ? String(t.code).toUpperCase() : 'BRONZE') as LoyaltyTierCode,
          name: String(t.name || t.code || 'Bronze').trim(),
          min_spend: Math.max(0, Number(t.min_spend || 0)),
          discount_pct: Math.max(0, Math.min(100, Number(t.discount_pct || 0))),
        }))
      : current.tiers_config,
    wa_birthday_message: input.wa_birthday_message !== undefined ? String(input.wa_birthday_message) : current.wa_birthday_message,
    wa_followup_message: input.wa_followup_message !== undefined ? String(input.wa_followup_message) : current.wa_followup_message,
    wa_database_message: input.wa_database_message !== undefined ? String(input.wa_database_message) : current.wa_database_message,
    followup_threshold_days: input.followup_threshold_days !== undefined ? Math.max(1, Math.round(Number(input.followup_threshold_days))) : current.followup_threshold_days,
  };

  await pool.query(
    `INSERT INTO property_loyalty_settings (
       property_id, points_enabled, spend_per_point, points_earned_per_unit, points_per_visit,
       point_value_idr, min_redeem_points, point_expiry_months,
       silver_point_threshold, gold_point_threshold, platinum_point_threshold,
       tier_calculation_period, tiers_config,
       wa_birthday_message, wa_followup_message, wa_database_message, followup_threshold_days, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8,
       $9, $10, $11,
       $12, $13::jsonb,
       $14, $15, $16, $17, CURRENT_TIMESTAMP
     )
     ON CONFLICT (property_id) DO UPDATE SET
       points_enabled = EXCLUDED.points_enabled,
       spend_per_point = EXCLUDED.spend_per_point,
       points_earned_per_unit = EXCLUDED.points_earned_per_unit,
       points_per_visit = EXCLUDED.points_per_visit,
       point_value_idr = EXCLUDED.point_value_idr,
       min_redeem_points = EXCLUDED.min_redeem_points,
       point_expiry_months = EXCLUDED.point_expiry_months,
       silver_point_threshold = EXCLUDED.silver_point_threshold,
       gold_point_threshold = EXCLUDED.gold_point_threshold,
       platinum_point_threshold = EXCLUDED.platinum_point_threshold,
       tier_calculation_period = EXCLUDED.tier_calculation_period,
       tiers_config = EXCLUDED.tiers_config,
       wa_birthday_message = EXCLUDED.wa_birthday_message,
       wa_followup_message = EXCLUDED.wa_followup_message,
       wa_database_message = EXCLUDED.wa_database_message,
       followup_threshold_days = EXCLUDED.followup_threshold_days,
       updated_at = CURRENT_TIMESTAMP`,
    [
      propertyId,
      next.points_enabled,
      next.spend_per_point,
      next.points_earned_per_unit,
      next.points_per_visit,
      next.point_value_idr,
      next.min_redeem_points,
      next.point_expiry_months,
      next.silver_point_threshold,
      next.gold_point_threshold,
      next.platinum_point_threshold,
      next.tier_calculation_period,
      JSON.stringify(next.tiers_config),
      next.wa_birthday_message,
      next.wa_followup_message,
      next.wa_database_message,
      next.followup_threshold_days,
    ]
  );

  await writeGuestAudit(pool, {
    action: 'GUEST_LOYALTY',
    entity: 'GUEST',
    recordId: propertyId,
    newValue: next,
    propertyId,
    correlationId,
    actorUserId,
  });

  return getPropertyLoyaltySettings(pool, propertyId);
}

export function evaluateGuestLoyaltyMetrics(
  totalSpend: number,
  paidVisits: number,
  bonusPoints: number,
  redeemedPoints: number,
  vipStatus: VipStatus,
  settings: PropertyLoyaltySettings
): {
  earned_points: number;
  loyalty_points: number;
  point_value_idr: number;
  loyalty_tier: LoyaltyTierCode;
  loyalty_tier_name: string;
  tier_discount_pct: number;
} {
  const spendPerPoint = Math.max(1, Number(settings.spend_per_point || 10000));
  const pointsPerUnit = Math.max(0, Number(settings.points_earned_per_unit ?? 1));
  const pointsPerVisit = Math.max(0, Number(settings.points_per_visit ?? 1));

  const earnedPoints = settings.points_enabled
    ? Math.floor(totalSpend / spendPerPoint) * pointsPerUnit + paidVisits * pointsPerVisit
    : 0;
  const totalCumulativePoints = earnedPoints + bonusPoints;
  const loyaltyPoints = Math.max(0, earnedPoints + bonusPoints - redeemedPoints);
  const pointValueIdr = Math.round(loyaltyPoints * Number(settings.point_value_idr || 350));

  const tiers = Array.isArray(settings.tiers_config) && settings.tiers_config.length > 0
    ? settings.tiers_config
    : DEFAULT_TIERS_CONFIG;
  const tierMap = new Map<LoyaltyTierCode, PropertyLoyaltyTierConfig>();
  for (const t of tiers) {
    tierMap.set(t.code, t);
  }

  const bronzeCfg = tierMap.get('BRONZE') || { code: 'BRONZE', name: 'Bronze', min_spend: 0, discount_pct: 0 };
  const silverCfg = tierMap.get('SILVER') || { code: 'SILVER', name: 'Silver', min_spend: 500000, discount_pct: 2 };
  const goldCfg = tierMap.get('GOLD') || { code: 'GOLD', name: 'Gold', min_spend: 2500000, discount_pct: 5 };
  const platCfg = tierMap.get('PLATINUM') || { code: 'PLATINUM', name: 'Platinum', min_spend: 5000000, discount_pct: 25 };

  let chosenTier: PropertyLoyaltyTierConfig = bronzeCfg;
  if (
    vipStatus === 'VVIP' ||
    (platCfg.min_spend > 0 && totalSpend >= platCfg.min_spend) ||
    (settings.platinum_point_threshold > 0 && totalCumulativePoints >= settings.platinum_point_threshold)
  ) {
    chosenTier = platCfg;
  } else if (
    vipStatus === 'VIP' ||
    (goldCfg.min_spend > 0 && totalSpend >= goldCfg.min_spend) ||
    (settings.gold_point_threshold > 0 && totalCumulativePoints >= settings.gold_point_threshold)
  ) {
    chosenTier = goldCfg;
  } else if (
    (silverCfg.min_spend > 0 && totalSpend >= silverCfg.min_spend) ||
    (settings.silver_point_threshold > 0 && totalCumulativePoints >= settings.silver_point_threshold)
  ) {
    chosenTier = silverCfg;
  }

  return {
    earned_points: earnedPoints,
    loyalty_points: loyaltyPoints,
    point_value_idr: pointValueIdr,
    loyalty_tier: chosenTier.code,
    loyalty_tier_name: chosenTier.name,
    tier_discount_pct: Number(chosenTier.discount_pct || 0),
  };
}

export function httpError(statusCode: number, code: string, message: string): Error & { statusCode: number; code: string } {
  const err = new Error(message) as Error & { statusCode: number; code: string };
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

export function parsePropertyId(value: unknown, fieldName = 'property_id'): number {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw httpError(400, 'VALIDATION_ERROR', `${fieldName} is required`);
  }
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw httpError(400, 'VALIDATION_ERROR', `${fieldName} must be a positive integer`);
  }
  return id;
}

export async function assertPropertyExists(client: PoolClient | Pool, propertyId: number): Promise<void> {
  const res = await client.query('SELECT id, is_active FROM properties WHERE id = $1', [propertyId]);
  if ((res.rowCount ?? 0) === 0) {
    throw httpError(404, 'PROPERTY_NOT_FOUND', `property ${propertyId} not found`);
  }
}

export async function assertReservationBelongsToProperty(
  client: PoolClient | Pool,
  reservationId: number,
  propertyId: number
): Promise<{ reservation: any; booking: any }> {
  const res = await client.query(
    `SELECT r.*, b.property_id as booking_property_id
     FROM reservations r
     JOIN bookings b ON b.id = r.booking_id
     WHERE r.id = $1`,
    [reservationId]
  );
  if ((res.rowCount ?? 0) === 0) {
    const orphanCheck = await client.query('SELECT * FROM reservations WHERE id = $1', [reservationId]);
    if ((orphanCheck.rowCount ?? 0) === 0) {
      throw httpError(404, 'RESERVATION_NOT_FOUND', `reservation ${reservationId} not found`);
    }
    throw httpError(409, 'INVALID_RESERVATION_LINK', `reservation ${reservationId} is not linked to a booking`);
  }
  const row = res.rows[0];
  if (Number(row.booking_property_id) !== propertyId) {
    throw httpError(403, 'PROPERTY_MISMATCH', `reservation ${reservationId} does not belong to property ${propertyId}`);
  }
  return {
    reservation: row,
    booking: { id: row.booking_id, property_id: row.booking_property_id }
  };
}

export async function assertGuestBelongsToProperty(
  client: PoolClient | Pool,
  guestId: number,
  propertyId: number
): Promise<Guest> {
  const guestRes = await client.query('SELECT * FROM guests WHERE id = $1', [guestId]);
  if ((guestRes.rowCount ?? 0) === 0) {
    throw httpError(404, 'GUEST_NOT_FOUND', `guest ${guestId} not found`);
  }
  const guest = guestRes.rows[0];

  const authRes = await client.query(
    `SELECT 1 FROM guests g
     WHERE g.id = $1
       AND (
         g.created_property_id = $2
         OR EXISTS (
           SELECT 1
           FROM reservation_guests rg
           JOIN reservations r ON rg.reservation_id = r.id
           JOIN bookings b ON r.booking_id = b.id
           WHERE rg.guest_id = g.id AND b.property_id = $2
         )
       )`,
    [guestId, propertyId]
  );

  if ((authRes.rowCount ?? 0) === 0) {
    throw httpError(403, 'PROPERTY_MISMATCH', `guest ${guestId} does not belong to property ${propertyId}`);
  }

  return guest;
}

export function normalizePhone(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim();
  if (!str) return null;
  return str;
}

export function normalizeDigitsOnly(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('62') && digits.length > 8) {
    digits = '0' + digits.slice(2);
  }
  return digits || null;
}

export function normalizeIdentityNumber(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const clean = String(raw).replace(/[^0-9A-Za-z]/g, '').toUpperCase().trim();
  return clean || null;
}

export function normalizeEmail(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim().toLowerCase();
  if (!str) return null;
  return str;
}

export function normalizeVipStatus(raw: unknown): VipStatus {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return 'STANDARD';
  }
  const status = String(raw).trim().toUpperCase();
  if (!['STANDARD', 'VIP', 'VVIP'].includes(status)) {
    throw httpError(400, 'VALIDATION_ERROR', `invalid vip_status: ${status}. Must be STANDARD, VIP, or VVIP`);
  }
  return status as VipStatus;
}

export function normalizeGender(raw: unknown): 'MALE' | 'FEMALE' | 'OTHER' | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return null;
  }
  const gender = String(raw).trim().toUpperCase();
  if (!['MALE', 'FEMALE', 'OTHER'].includes(gender)) {
    throw httpError(400, 'VALIDATION_ERROR', `invalid gender: ${gender}. Must be MALE, FEMALE, or OTHER`);
  }
  return gender as 'MALE' | 'FEMALE' | 'OTHER';
}

export function normalizeRole(raw: unknown): GuestRole {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw httpError(400, 'VALIDATION_ERROR', 'role is required');
  }
  const role = String(raw).trim().toUpperCase();
  if (!['BOOKER', 'PRIMARY_GUEST', 'ADDITIONAL_GUEST'].includes(role)) {
    throw httpError(400, 'VALIDATION_ERROR', `invalid role: ${role}. Must be BOOKER, PRIMARY_GUEST, or ADDITIONAL_GUEST`);
  }
  return role as GuestRole;
}

export async function writeGuestAudit(
   client: PoolClient | Pool,
   entry: {
     action: 'GUEST_CREATE' | 'GUEST_UPDATE' | 'GUEST_ARCHIVE' | 'GUEST_RESTORE' | 'GUEST_DELETE' | 'GUEST_MERGE' | 'GUEST_LOYALTY' | 'RESERVATION_GUEST_ADD' | 'RESERVATION_GUEST_UPDATE' | 'RESERVATION_GUEST_REMOVE' | 'PRIMARY_GUEST_REPLACE';
     entity: 'GUEST' | 'RESERVATION_GUEST';
     recordId: string | number;
     newValue: any;
     propertyId: number;
     correlationId?: string | null;
     actorUserId?: number | null;
   }
 ): Promise<void> {
   if (!entry.propertyId || !Number.isInteger(entry.propertyId) || entry.propertyId <= 0) {
     throw new Error('AUDIT_INTEGRITY_ERROR: property_id must not be null for guest audit');
   }
   await client.query(
     `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id, actor_user_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
     [
       'GUEST_CRM',
       entry.action,
       entry.entity,
       String(entry.recordId),
       JSON.stringify(entry.newValue),
       entry.correlationId || null,
       entry.propertyId,
       entry.actorUserId ? String(entry.actorUserId) : null
     ]
   );
 }

// ---------------------------------------------------------------------------
// Guest Master CRUD & Search
// ---------------------------------------------------------------------------

export async function searchGuests(
  pool: Pool,
  propertyId: number,
  search?: string,
  limit = 50,
  offset = 0,
  vipStatus?: string,
  includeArchived = false
): Promise<{ guests: GuestWithStats[]; total: number }> {
  await assertPropertyExists(pool, propertyId);
  await ensureGuestCrmTables(pool);

  const safeLimit = Math.max(1, Math.min(limit, 2000));
  const safeOffset = Math.max(0, offset);

  const baseFilter = `
    (
      g.created_property_id = $1
      OR EXISTS (
        SELECT 1
        FROM reservation_guests rg
        JOIN reservations r ON rg.reservation_id = r.id
        JOIN bookings b ON r.booking_id = b.id
        WHERE rg.guest_id = g.id AND b.property_id = $1
      )
    )
  `;

  const conditions: string[] = [baseFilter];
  const params: any[] = [propertyId];

  if (!includeArchived) {
    conditions.push('(g.is_archived IS NULL OR g.is_archived = FALSE)');
  }

  if (search && search.trim()) {
    const term = search.trim();
    const digitsOnly = term.replace(/\D/g, '');
    const cleanNik = term.replace(/[^0-9A-Za-z]/g, '');

    params.push(`%${term}%`);
    const textPatternParam = `$${params.length}`;

    const subConditions = [
      `g.full_name ILIKE ${textPatternParam}`,
      `g.phone ILIKE ${textPatternParam}`,
      `g.email ILIKE ${textPatternParam}`,
      `g.identity_number ILIKE ${textPatternParam}`,
      `g.guest_code ILIKE ${textPatternParam}`,
      `g.city ILIKE ${textPatternParam}`,
      `g.birth_place ILIKE ${textPatternParam}`,
      `g.citizenship ILIKE ${textPatternParam}`,
      `g.nationality ILIKE ${textPatternParam}`,
      `EXISTS (SELECT 1 FROM regencies reg_s WHERE reg_s.id = g.ktp_regency_id AND reg_s.name ILIKE ${textPatternParam})`
    ];

    if (digitsOnly && digitsOnly.length >= 3) {
      params.push(`%${digitsOnly}%`);
      subConditions.push(`g.normalized_phone ILIKE $${params.length}`);
    }

    if (cleanNik && cleanNik.length >= 3) {
      params.push(`%${cleanNik}%`);
      subConditions.push(`g.normalized_identity_number ILIKE $${params.length}`);
    }

    conditions.push(`(${subConditions.join(' OR ')})`);
  }

  if (vipStatus && ['STANDARD', 'VIP', 'VVIP'].includes(vipStatus.trim().toUpperCase())) {
    params.push(vipStatus.trim().toUpperCase());
    conditions.push(`g.vip_status = $${params.length}`);
  }

  const whereClause = conditions.join(' AND ');

  const countRes = await pool.query(
    `SELECT COUNT(DISTINCT g.id)::int as total
     FROM guests g
     WHERE ${whereClause}`,
    params
  );
  const total = countRes.rows[0]?.total || 0;

  const loyaltySettings = await getPropertyLoyaltySettings(pool, propertyId);

  params.push(safeLimit);
  const limitParam = `$${params.length}`;
  params.push(safeOffset);
  const offsetParam = `$${params.length}`;

  const res = await pool.query(
    `SELECT
       g.*,
       COALESCE(NULLIF(BTRIM(g.city), ''), reg.name, NULLIF(BTRIM(g.birth_place), '')) AS resolved_city,
       COALESCE(g.guest_code, 'GST-' || LPAD(g.id::text, 5, '0')) AS guest_code,
       COALESCE(stats.visit_count, 0)::int AS visit_count,
       COALESCE(stats.paid_visit_count, 0)::int AS paid_visit_count,
       COALESCE(stats.room_nights, 0)::int AS room_nights,
       stats.first_stay,
       stats.last_stay,
       (COALESCE(stats.paid_room_spend, 0) + COALESCE(pos_stats.paid_pos_spend, 0))::numeric(14,2) AS total_spend,
       COALESCE(loy.bonus_points, 0)::int AS bonus_points,
       COALESCE(loy.redeemed_points, 0)::int AS redeemed_points
     FROM guests g
     LEFT JOIN regencies reg ON reg.id = g.ktp_regency_id
     LEFT JOIN LATERAL (
       SELECT
         COUNT(DISTINCT r.id)::int AS visit_count,
         COUNT(
           DISTINCT CASE
             WHEN UPPER(COALESCE(r.payment_status, '')) = 'PAID'
               AND COALESCE(r.remaining_balance, GREATEST(0, COALESCE(r.total_price, 0) - COALESCE(r.amount_paid, 0))) <= 0
               AND COALESCE(r.discount_percent, 0) < 100
               AND COALESCE(r.total_price, 0) > 0
               AND UPPER(COALESCE(r.payment_status, '')) NOT LIKE '%COMP%'
               AND UPPER(COALESCE(r.special_requests, '')) NOT LIKE '%COMPLIMENT%'
               AND UPPER(COALESCE(r.special_requests, '')) NOT LIKE '%HOUSE USE%'
             THEN r.id
             ELSE NULL
           END
         )::int AS paid_visit_count,
         COALESCE(SUM(GREATEST(1, r.check_out::date - r.check_in::date)), 0)::int AS room_nights,
         TO_CHAR(MIN(r.check_in), 'YYYY-MM-DD') AS first_stay,
         TO_CHAR(MAX(r.check_out), 'YYYY-MM-DD') AS last_stay,
         COALESCE(
           SUM(
             CASE
               WHEN UPPER(COALESCE(r.payment_status, '')) = 'PAID'
                 AND COALESCE(r.remaining_balance, GREATEST(0, COALESCE(r.total_price, 0) - COALESCE(r.amount_paid, 0))) <= 0
                 AND COALESCE(r.discount_percent, 0) < 100
                 AND COALESCE(r.total_price, 0) > 0
                 AND UPPER(COALESCE(r.payment_status, '')) NOT LIKE '%COMP%'
                 AND UPPER(COALESCE(r.payment_status, '')) NOT LIKE '%FREE%'
                 AND UPPER(COALESCE(r.special_requests, '')) NOT LIKE '%COMPLIMENT%'
                 AND UPPER(COALESCE(r.special_requests, '')) NOT LIKE '%HOUSE USE%'
                 AND NOT EXISTS (
                   SELECT 1 FROM reservation_complimentary_requests rcr
                   WHERE rcr.reservation_id = r.id
                     AND rcr.property_id = b.property_id
                     AND UPPER(COALESCE(rcr.status, '')) IN ('APPROVED', 'APPLIED', 'ACTIVE', 'COMPLETED')
                 )
                 AND NOT (
                   EXISTS (
                     SELECT 1 FROM transactions t_v
                     WHERE t_v.property_id = b.property_id
                       AND (t_v.reservation_id = r.id OR (t_v.reservation_id IS NULL AND t_v.booking_id = b.id))
                       AND t_v.transaction_type = 'SALE'
                       AND t_v.deleted_at IS NULL
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM transactions t_l
                     WHERE t_l.property_id = b.property_id
                       AND (t_l.reservation_id = r.id OR (t_l.reservation_id IS NULL AND t_l.booking_id = b.id))
                       AND t_l.transaction_type = 'SALE'
                       AND t_l.deleted_at IS NULL
                       AND UPPER(COALESCE(t_l.transaction_status, 'POSTED')) NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
                   )
                 )
               THEN COALESCE(r.total_price, 0)
               ELSE 0
             END
           ),
           0
         )::numeric(14,2) AS paid_room_spend,
         COALESCE(
           SUM(
             CASE
               WHEN UPPER(COALESCE(r.payment_status, '')) = 'PAID'
                 AND COALESCE(r.remaining_balance, GREATEST(0, COALESCE(r.total_price, 0) - COALESCE(r.amount_paid, 0))) <= 0
                 AND COALESCE(r.discount_percent, 0) < 100
                 AND COALESCE(r.total_price, 0) > 0
                 AND UPPER(COALESCE(r.payment_status, '')) NOT LIKE '%COMP%'
                 AND UPPER(COALESCE(r.special_requests, '')) NOT LIKE '%COMPLIMENT%'
                 AND UPPER(COALESCE(r.special_requests, '')) NOT LIKE '%HOUSE USE%'
               THEN GREATEST(1, r.check_out::date - r.check_in::date)
               ELSE 0
             END
           ),
           0
         )::int AS paid_room_nights
       FROM reservation_guests rg
       JOIN reservations r ON rg.reservation_id = r.id
       JOIN bookings b ON r.booking_id = b.id
       WHERE rg.guest_id = g.id
         AND b.property_id = $1
         AND r.status IN ('CHECKED_IN', 'CHECKED_OUT')
         AND UPPER(COALESCE(r.stay_status, '')) NOT IN ('CANCELLED', 'NO_SHOW')
         AND COALESCE(b.booking_status, '') != 'CANCELLED'
     ) stats ON true
     LEFT JOIN LATERAL (
       SELECT
         COALESCE(SUM(t.net_amount), 0)::numeric(14,2) AS paid_pos_spend
       FROM transactions t
       WHERE t.property_id = $1
         AND t.guest_id = g.id
         AND t.reservation_id IS NULL
         AND t.transaction_type = 'SALE'
         AND t.deleted_at IS NULL
         AND UPPER(COALESCE(t.transaction_status, 'POSTED')) NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
         AND UPPER(COALESCE(t.payment_status, '')) = 'PAID'
         AND COALESCE(t.net_amount, 0) > 0
         AND UPPER(COALESCE(t.payment_method, '')) NOT LIKE '%COMP%'
     ) pos_stats ON true
     LEFT JOIN LATERAL (
       SELECT
         COALESCE(SUM(CASE WHEN gll.points > 0 THEN gll.points ELSE 0 END), 0)::int AS bonus_points,
         COALESCE(SUM(CASE WHEN gll.points < 0 THEN ABS(gll.points) ELSE 0 END), 0)::int AS redeemed_points
       FROM guest_loyalty_ledger gll
       WHERE gll.property_id = $1 AND gll.guest_id = g.id
     ) loy ON true
     WHERE ${whereClause}
     ORDER BY g.updated_at DESC, g.id DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params
  );

  return {
    guests: res.rows.map((r) => {
      const totalSpend = Number(r.total_spend || 0);
      const paidVisits = Number(r.paid_visit_count || 0);
      const bonusPoints = Number(r.bonus_points || 0);
      const redeemedPoints = Number(r.redeemed_points || 0);
      const metrics = evaluateGuestLoyaltyMetrics(
        totalSpend,
        paidVisits,
        bonusPoints,
        redeemedPoints,
        r.vip_status || 'STANDARD',
        loyaltySettings
      );
      const resolvedCity = resolveGuestCityLabel(r);
      const resolvedCitizenship = classifyGuestCitizenship(r);
      return {
        ...r,
        city: resolvedCity || r.city || null,
        citizenship: resolvedCitizenship,
        total_spend: totalSpend,
        earned_points: metrics.earned_points,
        bonus_points: bonusPoints,
        redeemed_points: redeemedPoints,
        loyalty_points: metrics.loyalty_points,
        point_value_idr: metrics.point_value_idr,
        loyalty_tier: metrics.loyalty_tier,
        loyalty_tier_name: metrics.loyalty_tier_name,
        tier_discount_pct: metrics.tier_discount_pct,
      };
    }),
    total
  };
}

export async function checkGuestDuplicates(
  pool: Pool,
  input: DuplicateCheckInput
): Promise<DuplicateCheckResult> {
  const propertyId = parsePropertyId(input.property_id, 'property_id');
  await assertPropertyExists(pool, propertyId);

  const phone = normalizePhone(input.phone);
  const normalizedPhone = normalizeDigitsOnly(input.phone);
  const nik = input.nik ? String(input.nik).trim() : null;
  const normalizedNik = normalizeIdentityNumber(input.nik);
  const email = normalizeEmail(input.email);
  const name = input.name ? String(input.name).trim() : null;
  const birthDate = input.birth_date ? String(input.birth_date).trim() : null;
  const excludeGuestId = input.exclude_guest_id ? Number(input.exclude_guest_id) : null;

  if (!phone && !normalizedPhone && !nik && !normalizedNik && !email && !name) {
    return { has_duplicate: false, candidates: [] };
  }

  const baseFilter = `
    (
      g.created_property_id = $1
      OR EXISTS (
        SELECT 1
        FROM reservation_guests rg
        JOIN reservations r ON rg.reservation_id = r.id
        JOIN bookings b ON r.booking_id = b.id
        WHERE rg.guest_id = g.id AND b.property_id = $1
      )
    )
  `;

  const orConditions: string[] = [];
  const params: any[] = [propertyId];

  if (excludeGuestId) {
    params.push(excludeGuestId);
    // exclude from matches
  }

  if (normalizedPhone && normalizedPhone.length >= 7) {
    params.push(normalizedPhone);
    orConditions.push(`(REGEXP_REPLACE(g.phone, '[^0-9]', '', 'g') = $${params.length} OR g.normalized_phone = $${params.length})`);
  }

  if (normalizedNik && normalizedNik.length >= 6) {
    params.push(normalizedNik);
    orConditions.push(`(UPPER(REGEXP_REPLACE(g.identity_number, '[^0-9A-Za-z]', '', 'g')) = $${params.length} OR g.normalized_identity_number = $${params.length})`);
  }

  if (email) {
    params.push(email);
    orConditions.push(`LOWER(TRIM(g.email)) = $${params.length}`);
  }

  if (name && birthDate) {
    params.push(name.toLowerCase());
    const nameIdx = params.length;
    params.push(birthDate);
    const dobIdx = params.length;
    orConditions.push(`(LOWER(TRIM(g.full_name)) = $${nameIdx} AND g.birth_date = $${dobIdx}::date)`);
  }

  if (orConditions.length === 0) {
    return { has_duplicate: false, candidates: [] };
  }

  let query = `
    SELECT
      g.*,
      COALESCE(g.guest_code, 'GST-' || LPAD(g.id::text, 5, '0')) AS guest_code,
      COALESCE(stats.visit_count, 0)::int AS visit_count,
      stats.last_stay
    FROM guests g
    LEFT JOIN LATERAL (
      SELECT
        COUNT(DISTINCT r.id)::int AS visit_count,
        TO_CHAR(MAX(r.check_out), 'YYYY-MM-DD') AS last_stay
      FROM reservation_guests rg
      JOIN reservations r ON rg.reservation_id = r.id
      JOIN bookings b ON r.booking_id = b.id
      WHERE rg.guest_id = g.id
        AND b.property_id = $1
        AND r.status IN ('CHECKED_IN', 'CHECKED_OUT')
    ) stats ON true
    WHERE ${baseFilter}
      AND (${orConditions.join(' OR ')})
  `;

  if (excludeGuestId) {
    query += ` AND g.id != $2`;
  }

  query += ` ORDER BY g.updated_at DESC LIMIT 10`;

  const res = await pool.query(query, params);

  const candidates: DuplicateCandidate[] = res.rows.map(row => {
    let matchStrength: DuplicateCandidate['match_strength'] = 'SOFT_NAME_PHONE';
    let matchReason = 'Kemiripan data tamu';

    const rowNormPhone = normalizeDigitsOnly(row.phone || row.normalized_phone);
    const rowNormNik = normalizeIdentityNumber(row.identity_number || row.normalized_identity_number);
    const rowNormEmail = normalizeEmail(row.email || row.normalized_email);

    if (normalizedNik && rowNormNik && normalizedNik === rowNormNik) {
      matchStrength = 'STRONG_NIK';
      matchReason = `Nomor identitas/NIK cocok (${row.identity_number})`;
    } else if (normalizedPhone && rowNormPhone && normalizedPhone === rowNormPhone) {
      matchStrength = 'STRONG_PHONE';
      matchReason = `Nomor telepon cocok (${row.phone})`;
    } else if (email && rowNormEmail && email === rowNormEmail) {
      matchStrength = 'STRONG_EMAIL';
      matchReason = `Email cocok (${row.email})`;
    } else if (name && birthDate && row.full_name?.toLowerCase() === name.toLowerCase()) {
      matchStrength = 'SOFT_NAME_DOB';
      matchReason = `Nama dan tanggal lahir cocok (${row.full_name})`;
    }

    return {
      id: row.id,
      guest_code: row.guest_code,
      full_name: row.full_name,
      phone: row.phone,
      email: row.email,
      identity_number: row.identity_number,
      birth_date: row.birth_date ? String(row.birth_date).slice(0, 10) : null,
      guest_segment: row.guest_segment || 'Reguler',
      vip_status: row.vip_status,
      has_valid_identity: Boolean(row.has_valid_identity || row.identity_number || row.identity_path),
      visit_count: row.visit_count,
      last_stay: row.last_stay,
      match_strength: matchStrength,
      match_type: matchStrength,
      match_reason: matchReason
    };
  });

  return {
    has_duplicate: candidates.length > 0,
    candidates
  };
}

const COMMON_CITY_KEYWORDS = [
  'MALANG', 'SURABAYA', 'SIDOARJO', 'PASURUAN', 'BATU', 'JAKARTA', 'BANDUNG',
  'SEMARANG', 'YOGYAKARTA', 'JOGJA', 'DENPASAR', 'BALI', 'KEDIRI', 'BLITAR',
  'JEMBER', 'BANYUWANGI', 'GRESIK', 'MOJOKERTO', 'PROBOLINGGO', 'LUMAJANG',
  'MADIUN', 'SURAKARTA', 'SOLO', 'MEDAN', 'MAKASSAR', 'BALIKPAPAN', 'SAMARINDA',
  'BOGOR', 'DEPOK', 'TANGERANG', 'BEKASI', 'LAMONGAN', 'TUBAN', 'BOJONEGORO',
  'JOMBANG', 'NGANJUK', 'TULUNGAGUNG', 'TRENGGALEK', 'PONOROGO', 'JEPARA',
  'KUDUS', 'PATI', 'PEKALONGAN', 'TEGAL', 'CILACAP', 'PURWOKERTO', 'MAGELANG',
  'KLATEN', 'SRAGEN', 'PALEMBANG', 'PEKANBARU', 'BATAM', 'PADANG', 'LAMPUNG',
  'BANJARMASIN', 'PONTIANAK', 'MANADO', 'MATARAM', 'LOMBOK', 'KUPANG', 'JAYAPURA'
];

function classifyGuestCitizenship(row: any): 'WNI' | 'WNA' {
  const cit = String(row.citizenship || '').trim().toUpperCase();
  if (cit === 'WNA' || cit === 'FOREIGN' || cit === 'ASING') return 'WNA';
  if (cit !== '' && !['WNI', 'INDONESIA', 'INDONESIAN', 'ID', 'IDN'].includes(cit)) {
    return 'WNA';
  }
  const nat = String(row.nationality || '').trim().toUpperCase();
  if (nat !== '' && !['WNI', 'INDONESIA', 'INDONESIAN', 'ID', 'IDN'].includes(nat)) {
    return 'WNA';
  }
  const country = String(row.country || '').trim().toUpperCase();
  if (country !== '' && !['WNI', 'INDONESIA', 'INDONESIAN', 'ID', 'IDN'].includes(country)) {
    return 'WNA';
  }
  const phone = String(row.phone || '').trim();
  if (phone.startsWith('+') && !phone.startsWith('+62') && cit !== 'WNI') {
    return 'WNA';
  }
  return 'WNI';
}

function formatTitleCaseCity(raw: string): string {
  const clean = raw
    .replace(/\s+/g, ' ')
    .replace(/^KABUPATEN\s+/i, 'Kab. ')
    .replace(/^KAB\.?\s+/i, 'Kab. ')
    .replace(/^KOTA\s+ADMINISTRASI\s+/i, 'Kota ')
    .replace(/^KOTA\s+/i, 'Kota ')
    .trim();
  return clean
    .split(' ')
    .map((w) => {
      if (w.toLowerCase() === 'kab.') return 'Kab.';
      if (w.length <= 1) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');
}

function resolveGuestCityLabel(row: any): string | null {
  const candidates = [
    row.city,
    row.resolved_city,
    row.ktp_regency_name,
    row.birth_place,
  ];
  for (const cand of candidates) {
    const str = String(cand || '').trim();
    if (str && str.length >= 3 && !/^\d+$/.test(str) && str !== '-' && str.toLowerCase() !== 'null') {
      return formatTitleCaseCity(str);
    }
  }
  const addr = String(row.address || '').toUpperCase();
  if (addr) {
    for (const kw of COMMON_CITY_KEYWORDS) {
      const regex = new RegExp(`\\b${kw}\\b`, 'i');
      if (regex.test(addr)) {
        return formatTitleCaseCity(kw === 'JOGJA' ? 'Yogyakarta' : kw);
      }
    }
  }
  return null;
}

export async function getCrmSummary(
  pool: Pool,
  propertyId: number,
  hotelDateInput?: string
): Promise<GuestCrmSummary> {
  await assertPropertyExists(pool, propertyId);

  const hotelDate = hotelDateInput && /^\d{4}-\d{2}-\d{2}$/.test(hotelDateInput)
    ? hotelDateInput
    : new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });

  const currentYear = Number(hotelDate.slice(0, 4));
  const currentMonth = Number(hotelDate.slice(5, 7));

  const baseFilter = `
    (
      g.created_property_id = $1
      OR EXISTS (
        SELECT 1
        FROM reservation_guests rg
        JOIN reservations r ON rg.reservation_id = r.id
        JOIN bookings b ON r.booking_id = b.id
        WHERE rg.guest_id = g.id AND b.property_id = $1
      )
    )
  `;

  const totalGuestsRes = await pool.query(
    `SELECT COUNT(DISTINCT g.id)::int as total
     FROM guests g
     WHERE ${baseFilter} AND (g.is_archived IS NULL OR g.is_archived = FALSE)`,
    [propertyId]
  );
  const totalGuests = totalGuestsRes.rows[0]?.total || 0;

  const stayStatsRes = await pool.query(
    `WITH qualifying_stays AS (
       SELECT
         rg.guest_id,
         COUNT(DISTINCT r.id) AS stay_count,
         MAX(r.check_out::date) AS last_checkout,
         COALESCE(
           SUM(
             CASE
               WHEN UPPER(COALESCE(r.payment_status, '')) = 'PAID'
                 AND COALESCE(r.remaining_balance, GREATEST(0, COALESCE(r.total_price, 0) - COALESCE(r.amount_paid, 0))) <= 0
                 AND COALESCE(r.discount_percent, 0) < 100
                 AND COALESCE(r.total_price, 0) > 0
                 AND UPPER(COALESCE(r.payment_status, '')) NOT LIKE '%COMP%'
                 AND UPPER(COALESCE(r.special_requests, '')) NOT LIKE '%COMPLIMENT%'
                 AND UPPER(COALESCE(r.special_requests, '')) NOT LIKE '%HOUSE USE%'
               THEN COALESCE(r.total_price, 0)
               ELSE 0
             END
           ),
           0
         )::numeric(14,2) AS paid_spend
       FROM reservation_guests rg
       JOIN reservations r ON rg.reservation_id = r.id
       JOIN bookings b ON r.booking_id = b.id
       WHERE b.property_id = $1
         AND r.status IN ('CHECKED_IN', 'CHECKED_OUT')
         AND UPPER(COALESCE(r.stay_status, '')) NOT IN ('CANCELLED', 'NO_SHOW')
         AND COALESCE(b.booking_status, '') != 'CANCELLED'
       GROUP BY rg.guest_id
     )
     SELECT
       COUNT(DISTINCT qs.guest_id)::int AS qualifying_guests,
       COUNT(DISTINCT CASE WHEN qs.stay_count > 1 THEN qs.guest_id END)::int AS repeat_guests,
       COUNT(DISTINCT CASE WHEN ($2::date - qs.last_checkout) >= 30 THEN qs.guest_id END)::int AS dormant_30d,
       COUNT(DISTINCT CASE WHEN ($2::date - qs.last_checkout) >= 60 THEN qs.guest_id END)::int AS dormant_60d,
       COUNT(DISTINCT CASE WHEN ($2::date - qs.last_checkout) >= 90 THEN qs.guest_id END)::int AS dormant_90d,
       COALESCE(SUM(qs.paid_spend), 0)::numeric(14,2) AS total_customer_revenue
     FROM qualifying_stays qs
     JOIN guests g ON qs.guest_id = g.id
     WHERE (g.is_archived IS NULL OR g.is_archived = FALSE)`,
    [propertyId, hotelDate]
  );

  const qualifyingCount = stayStatsRes.rows[0]?.qualifying_guests || 0;
  const repeatGuests = stayStatsRes.rows[0]?.repeat_guests || 0;
  const dormantGuests30d = stayStatsRes.rows[0]?.dormant_30d || 0;
  const dormantGuests60d = stayStatsRes.rows[0]?.dormant_60d || 0;
  const dormantGuests90d = stayStatsRes.rows[0]?.dormant_90d || 0;
  const totalCustomerRevenue = Number(stayStatsRes.rows[0]?.total_customer_revenue || 0);
  const avgCustomerLtv = qualifyingCount > 0 ? Math.round(totalCustomerRevenue / qualifyingCount) : 0;
  const repeatRate = qualifyingCount > 0 ? Number(((repeatGuests / qualifyingCount) * 100).toFixed(1)) : 0;

  const newGuestsRes = await pool.query(
    `SELECT COUNT(DISTINCT g.id)::int as new_guests
     FROM guests g
     WHERE ${baseFilter}
       AND g.created_at >= ($2::date - INTERVAL '30 days')
       AND (g.is_archived IS NULL OR g.is_archived = FALSE)`,
    [propertyId, hotelDate]
  );
  const newGuestsLast30d = newGuestsRes.rows[0]?.new_guests || 0;

  const bdayRes = await pool.query(
    `SELECT
       g.id,
       g.full_name,
       g.phone,
       g.email,
       TO_CHAR(g.birth_date, 'YYYY-MM-DD') AS birth_date,
       EXTRACT(DAY FROM g.birth_date)::int AS birth_day,
       EXTRACT(MONTH FROM g.birth_date)::int AS birth_month,
       g.vip_status
     FROM guests g
     WHERE ${baseFilter}
       AND g.birth_date IS NOT NULL
       AND EXTRACT(MONTH FROM g.birth_date) = $2
       AND (g.is_archived IS NULL OR g.is_archived = FALSE)
     ORDER BY EXTRACT(DAY FROM g.birth_date) ASC, g.full_name ASC`,
    [propertyId, currentMonth]
  );

  const followUpRes = await pool.query(
    `WITH guest_last_stay AS (
       SELECT
         rg.guest_id,
         MAX(r.check_out::date) AS last_stay,
         COUNT(DISTINCT r.id)::int AS visit_count,
         COALESCE(SUM(CASE WHEN UPPER(COALESCE(r.payment_status, '')) = 'PAID' THEN COALESCE(r.total_price, 0) ELSE 0 END), 0)::numeric(14,2) AS total_spend
       FROM reservation_guests rg
       JOIN reservations r ON rg.reservation_id = r.id
       JOIN bookings b ON r.booking_id = b.id
       WHERE b.property_id = $1
         AND r.status IN ('CHECKED_IN', 'CHECKED_OUT')
         AND UPPER(COALESCE(r.stay_status, '')) NOT IN ('CANCELLED', 'NO_SHOW')
         AND COALESCE(b.booking_status, '') != 'CANCELLED'
       GROUP BY rg.guest_id
     )
     SELECT
       g.id,
       g.full_name,
       g.phone,
       g.email,
       g.vip_status,
       TO_CHAR(gls.last_stay, 'YYYY-MM-DD') AS last_stay,
       ($2::date - gls.last_stay)::int AS days_since_last_stay,
       gls.visit_count,
       gls.total_spend
     FROM guest_last_stay gls
     JOIN guests g ON gls.guest_id = g.id
     WHERE ($2::date - gls.last_stay) >= 1
       AND (g.is_archived IS NULL OR g.is_archived = FALSE)
     ORDER BY gls.last_stay ASC, gls.total_spend DESC
     LIMIT 300`,
    [propertyId, hotelDate]
  );

  const demographicsRowsRes = await pool.query(
    `SELECT
       g.id,
       g.city,
       reg.name AS ktp_regency_name,
       g.birth_place,
       g.address,
       g.citizenship,
       g.nationality,
       g.country,
       g.phone,
       COALESCE(stay_sp.paid_spend, 0)::numeric(14,2) AS paid_spend
     FROM guests g
     LEFT JOIN regencies reg ON reg.id = g.ktp_regency_id
     LEFT JOIN LATERAL (
       SELECT
         COALESCE(
           SUM(
             CASE
               WHEN UPPER(COALESCE(r.payment_status, '')) = 'PAID'
                 AND COALESCE(r.remaining_balance, GREATEST(0, COALESCE(r.total_price, 0) - COALESCE(r.amount_paid, 0))) <= 0
                 AND COALESCE(r.discount_percent, 0) < 100
                 AND COALESCE(r.total_price, 0) > 0
                 AND UPPER(COALESCE(r.payment_status, '')) NOT LIKE '%COMP%'
                 AND UPPER(COALESCE(r.special_requests, '')) NOT LIKE '%COMPLIMENT%'
                 AND UPPER(COALESCE(r.special_requests, '')) NOT LIKE '%HOUSE USE%'
               THEN COALESCE(r.total_price, 0)
               ELSE 0
             END
           ),
           0
         ) AS paid_spend
       FROM reservation_guests rg
       JOIN reservations r ON rg.reservation_id = r.id
       JOIN bookings b ON r.booking_id = b.id
       WHERE rg.guest_id = g.id
         AND b.property_id = $1
         AND r.status IN ('CHECKED_IN', 'CHECKED_OUT')
         AND UPPER(COALESCE(r.stay_status, '')) NOT IN ('CANCELLED', 'NO_SHOW')
         AND COALESCE(b.booking_status, '') != 'CANCELLED'
     ) stay_sp ON true
     WHERE ${baseFilter}
       AND (g.is_archived IS NULL OR g.is_archived = FALSE)`,
    [propertyId]
  );

  let wniCount = 0;
  let wnaCount = 0;
  let knownCityGuests = 0;
  let unknownCityGuests = 0;
  const cityMap = new Map<string, { city: string; guest_count: number; total_spend: number }>();

  for (const dRow of demographicsRowsRes.rows) {
    const citType = classifyGuestCitizenship(dRow);
    if (citType === 'WNA') {
      wnaCount++;
    } else {
      wniCount++;
    }
    const cityLabel = resolveGuestCityLabel(dRow);
    if (cityLabel) {
      knownCityGuests++;
      const normKey = cityLabel.toUpperCase();
      const existing = cityMap.get(normKey) || { city: cityLabel, guest_count: 0, total_spend: 0 };
      existing.guest_count += 1;
      existing.total_spend += Number(dRow.paid_spend || 0);
      cityMap.set(normKey, existing);
    } else {
      unknownCityGuests++;
    }
  }

  const totalDemGuests = wniCount + wnaCount;
  const wniPct = totalDemGuests > 0 ? Number(((wniCount / totalDemGuests) * 100).toFixed(1)) : 100;
  const wnaPct = totalDemGuests > 0 ? Number(((wnaCount / totalDemGuests) * 100).toFixed(1)) : 0;

  const topCities = Array.from(cityMap.values())
    .sort((a, b) => b.guest_count - a.guest_count || b.total_spend - a.total_spend)
    .slice(0, 12)
    .map((c) => ({
      city: c.city,
      guest_count: c.guest_count,
      pct: knownCityGuests > 0 ? Number(((c.guest_count / knownCityGuests) * 100).toFixed(1)) : 0,
      total_spend: Math.round(c.total_spend),
    }));

  return {
    property_id: propertyId,
    hotel_date: hotelDate,
    total_guests: totalGuests,
    guests_with_qualifying_stay: qualifyingCount,
    repeat_guests: repeatGuests,
    repeat_rate: repeatRate,
    new_guests_last_30d: newGuestsLast30d,
    dormant_guests_30d: dormantGuests30d,
    dormant_guests_60d: dormantGuests60d,
    dormant_guests_90d: dormantGuests90d,
    total_customer_revenue: totalCustomerRevenue,
    avg_customer_ltv: avgCustomerLtv,
    birthdays_this_month: bdayRes.rows,
    follow_up_candidates: followUpRes.rows.map((r) => ({
      ...r,
      total_spend: Number(r.total_spend || 0),
    })),
    demographics: {
      wni_count: wniCount,
      wna_count: wnaCount,
      wni_pct: wniPct,
      wna_pct: wnaPct,
      known_city_guests: knownCityGuests,
      unknown_city_guests: unknownCityGuests,
      top_cities: topCities,
    },
  };
}

export async function getDuplicateCandidates(
  pool: Pool,
  propertyId: number
): Promise<DuplicateCandidateCluster[]> {
  await assertPropertyExists(pool, propertyId);

  const baseFilter = `
    (
      g.created_property_id = $1
      OR EXISTS (
        SELECT 1
        FROM reservation_guests rg
        JOIN reservations r ON rg.reservation_id = r.id
        JOIN bookings b ON r.booking_id = b.id
        WHERE rg.guest_id = g.id AND b.property_id = $1
      )
    )
    AND (g.is_archived IS NULL OR g.is_archived = FALSE)
  `;

  const phoneNormExpr = `
    CASE
      WHEN REGEXP_REPLACE(COALESCE(g.phone, ''), '[^0-9]', '', 'g') LIKE '62%'
        AND LENGTH(REGEXP_REPLACE(COALESCE(g.phone, ''), '[^0-9]', '', 'g')) > 8
      THEN '0' || SUBSTRING(REGEXP_REPLACE(COALESCE(g.phone, ''), '[^0-9]', '', 'g') FROM 3)
      ELSE REGEXP_REPLACE(COALESCE(g.phone, ''), '[^0-9]', '', 'g')
    END
  `;

  // 1. Matching Phone Candidates (normalized digits >= 7)
  const phoneRes = await pool.query(
    `WITH visible_guests AS (
       SELECT g.*, (${phoneNormExpr}) AS norm_phone_key
       FROM guests g
       WHERE ${baseFilter}
         AND g.phone IS NOT NULL
         AND LENGTH((${phoneNormExpr})) >= 7
     ),
     matched_keys AS (
       SELECT norm_phone_key AS phone_key
       FROM visible_guests
       GROUP BY norm_phone_key
       HAVING COUNT(*) >= 2
     )
     SELECT
       vg.*,
       COALESCE(vg.guest_code, 'GST-' || LPAD(vg.id::text, 5, '0')) AS guest_code,
       COALESCE(stats.visit_count, 0)::int AS visit_count,
       COALESCE(stats.room_nights, 0)::int AS room_nights,
       stats.first_stay,
       stats.last_stay
     FROM visible_guests vg
     JOIN matched_keys mk ON vg.norm_phone_key = mk.phone_key
     LEFT JOIN LATERAL (
       SELECT
         COUNT(DISTINCT r.id)::int AS visit_count,
         COALESCE(SUM(r.check_out::date - r.check_in::date), 0)::int AS room_nights,
         TO_CHAR(MIN(r.check_in), 'YYYY-MM-DD') AS first_stay,
         TO_CHAR(MAX(r.check_out), 'YYYY-MM-DD') AS last_stay
       FROM reservation_guests rg
       JOIN reservations r ON rg.reservation_id = r.id
       JOIN bookings b ON r.booking_id = b.id
       WHERE rg.guest_id = vg.id
         AND b.property_id = $1
         AND r.status IN ('CHECKED_IN', 'CHECKED_OUT')
     ) stats ON true
     ORDER BY vg.norm_phone_key ASC, stats.visit_count DESC NULLS LAST, vg.updated_at DESC`,
    [propertyId]
  );

  // 2. Matching Email Candidates
  const emailRes = await pool.query(
    `WITH visible_guests AS (
       SELECT g.*
       FROM guests g
       WHERE ${baseFilter}
         AND g.email IS NOT NULL
         AND TRIM(g.email) != ''
     ),
     matched_keys AS (
       SELECT LOWER(TRIM(email)) AS email_key
       FROM visible_guests
       GROUP BY LOWER(TRIM(email))
       HAVING COUNT(*) >= 2
     )
     SELECT
       vg.*,
       COALESCE(vg.guest_code, 'GST-' || LPAD(vg.id::text, 5, '0')) AS guest_code,
       COALESCE(stats.visit_count, 0)::int AS visit_count,
       COALESCE(stats.room_nights, 0)::int AS room_nights,
       stats.first_stay,
       stats.last_stay
     FROM visible_guests vg
     JOIN matched_keys mk ON LOWER(TRIM(vg.email)) = mk.email_key
     LEFT JOIN LATERAL (
       SELECT
         COUNT(DISTINCT r.id)::int AS visit_count,
         COALESCE(SUM(r.check_out::date - r.check_in::date), 0)::int AS room_nights,
         TO_CHAR(MIN(r.check_in), 'YYYY-MM-DD') AS first_stay,
         TO_CHAR(MAX(r.check_out), 'YYYY-MM-DD') AS last_stay
       FROM reservation_guests rg
       JOIN reservations r ON rg.reservation_id = r.id
       JOIN bookings b ON r.booking_id = b.id
       WHERE rg.guest_id = vg.id
         AND b.property_id = $1
         AND r.status IN ('CHECKED_IN', 'CHECKED_OUT')
     ) stats ON true
     ORDER BY LOWER(TRIM(vg.email)) ASC, stats.visit_count DESC NULLS LAST, vg.updated_at DESC`,
    [propertyId]
  );

  // 3. Matching Name and DOB Candidates
  const nameDobRes = await pool.query(
    `WITH visible_guests AS (
       SELECT g.*
       FROM guests g
       WHERE ${baseFilter}
         AND g.full_name IS NOT NULL
         AND TRIM(g.full_name) != ''
         AND g.birth_date IS NOT NULL
     ),
     matched_keys AS (
       SELECT LOWER(TRIM(full_name)) AS name_key, birth_date AS dob_key
       FROM visible_guests
       GROUP BY LOWER(TRIM(full_name)), birth_date
       HAVING COUNT(*) >= 2
     )
     SELECT
       vg.*,
       COALESCE(vg.guest_code, 'GST-' || LPAD(vg.id::text, 5, '0')) AS guest_code,
       COALESCE(stats.visit_count, 0)::int AS visit_count,
       COALESCE(stats.room_nights, 0)::int AS room_nights,
       stats.first_stay,
       stats.last_stay
     FROM visible_guests vg
     JOIN matched_keys mk ON LOWER(TRIM(vg.full_name)) = mk.name_key AND vg.birth_date = mk.dob_key
     LEFT JOIN LATERAL (
       SELECT
         COUNT(DISTINCT r.id)::int AS visit_count,
         COALESCE(SUM(r.check_out::date - r.check_in::date), 0)::int AS room_nights,
         TO_CHAR(MIN(r.check_in), 'YYYY-MM-DD') AS first_stay,
         TO_CHAR(MAX(r.check_out), 'YYYY-MM-DD') AS last_stay
       FROM reservation_guests rg
       JOIN reservations r ON rg.reservation_id = r.id
       JOIN bookings b ON r.booking_id = b.id
       WHERE rg.guest_id = vg.id
         AND b.property_id = $1
         AND r.status IN ('CHECKED_IN', 'CHECKED_OUT')
     ) stats ON true
     ORDER BY LOWER(TRIM(vg.full_name)) ASC, stats.visit_count DESC NULLS LAST, vg.updated_at DESC`,
    [propertyId]
  );

  const clusters: DuplicateCandidateCluster[] = [];

  const phoneMap = new Map<string, GuestWithStats[]>();
  for (const row of phoneRes.rows) {
    const key = String(row.norm_phone_key || row.phone).trim();
    if (!phoneMap.has(key)) phoneMap.set(key, []);
    phoneMap.get(key)!.push(row);
  }
  for (const [key, guests] of phoneMap.entries()) {
    clusters.push({
      match_reason: 'PHONE',
      match_key: key,
      guests
    });
  }

  const emailMap = new Map<string, GuestWithStats[]>();
  for (const row of emailRes.rows) {
    const key = String(row.email).trim().toLowerCase();
    if (!emailMap.has(key)) emailMap.set(key, []);
    emailMap.get(key)!.push(row);
  }
  for (const [key, guests] of emailMap.entries()) {
    clusters.push({
      match_reason: 'EMAIL',
      match_key: key,
      guests
    });
  }

  const nameDobMap = new Map<string, GuestWithStats[]>();
  for (const row of nameDobRes.rows) {
    const key = `${String(row.full_name).trim().toLowerCase()}||${row.birth_date}`;
    if (!nameDobMap.has(key)) nameDobMap.set(key, []);
    nameDobMap.get(key)!.push(row);
  }
  for (const [key, guests] of nameDobMap.entries()) {
    clusters.push({
      match_reason: 'NAME_AND_DOB',
      match_key: key,
      guests
    });
  }

  return clusters;
}

export async function mergeGuests(
  pool: Pool,
  input: GuestMergeInput,
  correlationId?: string,
  actorUserId?: number | null
): Promise<GuestMergeResult> {
  const propertyId = parsePropertyId(input.property_id, 'property_id');
  const primaryId = Number(input.primary_guest_id);
  if (!Number.isInteger(primaryId) || primaryId <= 0) {
    throw httpError(400, 'VALIDATION_ERROR', 'primary_guest_id wajib dipilih');
  }
  const dupIds = Array.from(
    new Set(
      (input.duplicate_guest_ids || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0 && id !== primaryId)
    )
  );
  if (dupIds.length === 0) {
    throw httpError(400, 'VALIDATION_ERROR', 'Pilih minimal 1 profil duplikat untuk digabungkan');
  }

  await assertPropertyExists(pool, propertyId);
  await ensureGuestCrmTables(pool);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const primaryGuest = await assertGuestBelongsToProperty(client, primaryId, propertyId);
    const dupGuests: Guest[] = [];
    for (const dId of dupIds) {
      const dg = await assertGuestBelongsToProperty(client, dId, propertyId);
      dupGuests.push(dg);
    }

    // Lock rows
    await client.query(
      `SELECT id FROM guests WHERE id = ANY($1::bigint[]) FOR UPDATE`,
      [[primaryId, ...dupIds]]
    );

    // 1. Auto-enrich empty fields on primary guest from duplicate guests
    const vipRank: Record<string, number> = { STANDARD: 0, VIP: 1, VVIP: 2 };
    let bestVip: VipStatus = primaryGuest.vip_status || 'STANDARD';
    let phone = primaryGuest.phone;
    let email = primaryGuest.email;
    let identityType = primaryGuest.identity_type;
    let identityNumber = primaryGuest.identity_number;
    let identityPath = primaryGuest.identity_path;
    let hasValidIdentity = Boolean(primaryGuest.has_valid_identity);
    let birthDate = primaryGuest.birth_date;
    let birthPlace = primaryGuest.birth_place;
    let gender = primaryGuest.gender;
    let address = primaryGuest.address;
    let city = primaryGuest.city;
    let province = primaryGuest.province;
    let nationality = primaryGuest.nationality;
    let occupation = primaryGuest.occupation;
    let preferences = primaryGuest.preferences;
    const notesParts: string[] = [];
    if (primaryGuest.notes && primaryGuest.notes.trim()) {
      notesParts.push(primaryGuest.notes.trim());
    }

    for (const dg of dupGuests) {
      if ((vipRank[dg.vip_status] || 0) > (vipRank[bestVip] || 0)) {
        bestVip = dg.vip_status;
      }
      if (!phone && dg.phone) phone = dg.phone;
      if (!email && dg.email) email = dg.email;
      if (!identityNumber && dg.identity_number) {
        identityNumber = dg.identity_number;
        identityType = dg.identity_type || identityType || 'KTP';
      }
      if (!identityPath && dg.identity_path) identityPath = dg.identity_path;
      if (dg.has_valid_identity) hasValidIdentity = true;
      if (!birthDate && dg.birth_date) birthDate = dg.birth_date;
      if (!birthPlace && dg.birth_place) birthPlace = dg.birth_place;
      if (!gender && dg.gender) gender = dg.gender;
      if (!address && dg.address) address = dg.address;
      if (!city && dg.city) city = dg.city;
      if (!province && dg.province) province = dg.province;
      if (!nationality && dg.nationality) nationality = dg.nationality;
      if (!occupation && dg.occupation) occupation = dg.occupation;
      if (!preferences && dg.preferences) preferences = dg.preferences;
      if (dg.notes && dg.notes.trim() && !notesParts.includes(dg.notes.trim())) {
        notesParts.push(dg.notes.trim());
      }
    }

    const normPhone = normalizeDigitsOnly(phone);
    const normEmail = normalizeEmail(email);
    const normNik = normalizeIdentityNumber(identityNumber);
    const mergedNotes = notesParts.length > 0 ? notesParts.join(' | ') : null;

    await client.query(
      `UPDATE guests
       SET phone = $1,
           normalized_phone = $2,
           email = $3,
           normalized_email = $4,
           identity_type = $5,
           identity_number = $6,
           normalized_identity_number = $7,
           identity_path = $8,
           has_valid_identity = $9,
           birth_date = $10,
           birth_place = $11,
           gender = $12,
           address = $13,
           city = $14,
           province = $15,
           nationality = $16,
           occupation = $17,
           preferences = $18,
           vip_status = $19,
           notes = $20,
           is_archived = FALSE,
           is_active = TRUE,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $21`,
      [
        phone,
        normPhone,
        email,
        normEmail,
        identityType,
        identityNumber,
        normNik,
        identityPath,
        hasValidIdentity,
        birthDate,
        birthPlace,
        gender,
        address,
        city,
        province,
        nationality,
        occupation,
        preferences,
        bestVip,
        mergedNotes,
        primaryId
      ]
    );

    // 2. Relink reservation_guests safely (avoid duplicate (reservation_id, guest_id))
    // First upgrade primary guest role to PRIMARY_GUEST if a duplicate had PRIMARY_GUEST on the same reservation
    await client.query(
      `UPDATE reservation_guests rg_prim
       SET role = 'PRIMARY_GUEST',
           updated_at = CURRENT_TIMESTAMP
       FROM reservation_guests rg_dup
       WHERE rg_prim.reservation_id = rg_dup.reservation_id
         AND rg_prim.guest_id = $1
         AND rg_dup.guest_id = ANY($2::bigint[])
         AND rg_dup.role = 'PRIMARY_GUEST'
         AND rg_prim.role != 'PRIMARY_GUEST'`,
      [primaryId, dupIds]
    );

    // Delete duplicate reservation_guests rows where primaryId is already linked to that reservation
    await client.query(
      `DELETE FROM reservation_guests rg_dup
       WHERE rg_dup.guest_id = ANY($2::bigint[])
         AND EXISTS (
           SELECT 1 FROM reservation_guests rg_prim
           WHERE rg_prim.reservation_id = rg_dup.reservation_id
             AND rg_prim.guest_id = $1
         )`,
      [primaryId, dupIds]
    );

    // For remaining reservation_guests rows where multiple duplicates were on the same reservation, deduplicate them before relinking
    await client.query(
      `DELETE FROM reservation_guests rg_a
       USING reservation_guests rg_b
       WHERE rg_a.reservation_id = rg_b.reservation_id
         AND rg_a.guest_id = ANY($1::bigint[])
         AND rg_b.guest_id = ANY($1::bigint[])
         AND rg_a.id > rg_b.id`,
      [dupIds]
    );

    const relinkResv = await client.query(
      `UPDATE reservation_guests
       SET guest_id = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE guest_id = ANY($2::bigint[])`,
      [primaryId, dupIds]
    );

    // 3. Relink transactions
    const relinkTx = await client.query(
      `UPDATE transactions
       SET guest_id = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE guest_id = ANY($2::bigint[])`,
      [primaryId, dupIds]
    );

    // 4. Relink loyalty ledger
    await client.query(
      `UPDATE guest_loyalty_ledger
       SET guest_id = $1
       WHERE guest_id = ANY($2::bigint[])`,
      [primaryId, dupIds]
    );

    // 5. Relink communication logs if table exists
    const commTableRes = await client.query(`SELECT to_regclass('guest_communication_logs') AS tbl`);
    if (commTableRes.rows[0]?.tbl) {
      await client.query(
        `UPDATE guest_communication_logs
         SET guest_id = $1
         WHERE guest_id = ANY($2::bigint[])`,
        [primaryId, dupIds]
      );
    }

    // 6. Soft-archive duplicate guests so they no longer appear in active lists or duplicate clusters
    await client.query(
      `UPDATE guests
       SET is_archived = TRUE,
           is_active = FALSE,
           notes = CASE
             WHEN notes IS NULL OR BTRIM(notes) = '' THEN 'Digabungkan ke profil #' || $1::text
             ELSE notes || ' | Digabungkan ke profil #' || $1::text
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ANY($2::bigint[])`,
      [primaryId, dupIds]
    );

    const updatedPrimaryRes = await client.query(`SELECT * FROM guests WHERE id = $1`, [primaryId]);
    const updatedPrimary = updatedPrimaryRes.rows[0];

    await writeGuestAudit(client, {
      action: 'GUEST_MERGE',
      entity: 'GUEST',
      recordId: primaryId,
      newValue: {
        primary_guest_id: primaryId,
        merged_duplicate_guest_ids: dupIds,
        relinked_reservations: relinkResv.rowCount || 0,
        relinked_transactions: relinkTx.rowCount || 0
      },
      propertyId,
      correlationId,
      actorUserId
    });

    await client.query('COMMIT');
    return {
      primary_guest: updatedPrimary,
      merged_guest_ids: dupIds,
      relinked_reservations: relinkResv.rowCount || 0,
      relinked_transactions: relinkTx.rowCount || 0
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listLoyaltyLedger(
  pool: Pool,
  propertyId: number,
  guestId?: number
): Promise<GuestLoyaltyLedgerEntry[]> {
  await assertPropertyExists(pool, propertyId);
  await ensureGuestCrmTables(pool);

  const params: any[] = [propertyId];
  let guestClause = '';
  if (guestId && Number.isInteger(guestId) && guestId > 0) {
    params.push(guestId);
    guestClause = `AND gll.guest_id = $2`;
  }

  const res = await pool.query(
    `SELECT
       gll.*,
       g.full_name AS guest_name
     FROM guest_loyalty_ledger gll
     JOIN guests g ON g.id = gll.guest_id
     WHERE gll.property_id = $1
       ${guestClause}
     ORDER BY gll.created_at DESC, gll.id DESC
     LIMIT 200`,
    params
  );

  return res.rows.map((r) => ({
    id: Number(r.id),
    property_id: Number(r.property_id),
    guest_id: Number(r.guest_id),
    guest_name: r.guest_name,
    entry_type: r.entry_type,
    points: Number(r.points),
    description: r.description,
    reference_no: r.reference_no,
    created_by: r.created_by,
    created_at: r.created_at
  }));
}

export async function addLoyaltyLedgerEntry(
  pool: Pool,
  input: {
    property_id: number;
    guest_id: number;
    entry_type: 'BONUS' | 'REDEEM' | 'ADJUSTMENT';
    points: number;
    description: string;
    reference_no?: string | null;
    created_by?: string | null;
  },
  correlationId?: string,
  actorUserId?: number | null
): Promise<GuestLoyaltyLedgerEntry> {
  const propertyId = parsePropertyId(input.property_id, 'property_id');
  const guestId = Number(input.guest_id);
  if (!Number.isInteger(guestId) || guestId <= 0) {
    throw httpError(400, 'VALIDATION_ERROR', 'guest_id wajib valid');
  }
  const entryType = String(input.entry_type || '').trim().toUpperCase() as 'BONUS' | 'REDEEM' | 'ADJUSTMENT';
  if (!['BONUS', 'REDEEM', 'ADJUSTMENT'].includes(entryType)) {
    throw httpError(400, 'VALIDATION_ERROR', 'entry_type harus BONUS, REDEEM, atau ADJUSTMENT');
  }
  const rawPoints = Math.round(Number(input.points || 0));
  if (!Number.isFinite(rawPoints) || rawPoints === 0) {
    throw httpError(400, 'VALIDATION_ERROR', 'Jumlah poin harus berupa angka bulat bukan nol');
  }
  const description = String(input.description || '').trim();
  if (!description) {
    throw httpError(400, 'VALIDATION_ERROR', 'Keterangan poin wajib diisi');
  }

  await assertPropertyExists(pool, propertyId);
  await ensureGuestCrmTables(pool);
  await assertGuestBelongsToProperty(pool, guestId, propertyId);

  const signedPoints = entryType === 'REDEEM' ? -Math.abs(rawPoints) : (entryType === 'BONUS' ? Math.abs(rawPoints) : rawPoints);

  if (signedPoints < 0) {
    // Check available points
    const { guests } = await searchGuests(pool, propertyId, undefined, 2000, 0, undefined, true);
    const target = guests.find((g) => Number(g.id) === guestId);
    const currentPoints = Number(target?.loyalty_points || 0);
    if (Math.abs(signedPoints) > currentPoints) {
      throw httpError(
        400,
        'INSUFFICIENT_POINTS',
        `Saldo poin tamu (${currentPoints} poin) tidak mencukupi untuk penukaran ${Math.abs(signedPoints)} poin`
      );
    }
  }

  const insRes = await pool.query(
    `INSERT INTO guest_loyalty_ledger (
       property_id, guest_id, entry_type, points, description, reference_no, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      propertyId,
      guestId,
      entryType,
      signedPoints,
      description,
      input.reference_no ? String(input.reference_no).trim() : null,
      input.created_by || 'Front Office'
    ]
  );

  const row = insRes.rows[0];
  await writeGuestAudit(pool, {
    action: 'GUEST_LOYALTY',
    entity: 'GUEST',
    recordId: guestId,
    newValue: row,
    propertyId,
    correlationId,
    actorUserId
  });

  return {
    id: Number(row.id),
    property_id: Number(row.property_id),
    guest_id: Number(row.guest_id),
    entry_type: row.entry_type,
    points: Number(row.points),
    description: row.description,
    reference_no: row.reference_no,
    created_by: row.created_by,
    created_at: row.created_at
  };
}

export async function syncGuestLoyaltyVipTiers(
  pool: Pool,
  propertyId: number,
  correlationId?: string,
  actorUserId?: number | null
): Promise<{ updated_count: number }> {
  await assertPropertyExists(pool, propertyId);
  await ensureGuestCrmTables(pool);

  const { guests } = await searchGuests(pool, propertyId, undefined, 2000, 0, undefined, false);
  let updatedCount = 0;

  for (const g of guests) {
    let targetVip: VipStatus = g.vip_status;
    if (g.loyalty_tier === 'PLATINUM' && g.vip_status !== 'VVIP') {
      targetVip = 'VVIP';
    } else if (g.loyalty_tier === 'GOLD' && g.vip_status === 'STANDARD') {
      targetVip = 'VIP';
    }
    if (targetVip !== g.vip_status) {
      await pool.query(
        `UPDATE guests SET vip_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [targetVip, g.id]
      );
      updatedCount++;
    }
  }

  if (updatedCount > 0) {
    await writeGuestAudit(pool, {
      action: 'GUEST_LOYALTY',
      entity: 'GUEST',
      recordId: propertyId,
      newValue: { action: 'SYNC_VIP_TIERS', updated_count: updatedCount },
      propertyId,
      correlationId,
      actorUserId
    });
  }

  return { updated_count: updatedCount };
}

export async function getGuestById(
  pool: Pool,
  guestId: number,
  propertyId: number
): Promise<GuestWithStats & { stays: any[] }> {
  await assertPropertyExists(pool, propertyId);
  const guest = await assertGuestBelongsToProperty(pool, guestId, propertyId);

  // Filter stay history strictly to the requesting property (privacy boundary)
  const staysRes = await pool.query(
    `SELECT
       r.id AS reservation_id,
       r.booking_id,
       b.bid,
       r.room_id,
       rm.room_number,
       rt.name AS room_type_name,
       rp.name AS rate_plan_name,
       r.check_in,
       r.check_out,
       r.status AS reservation_status,
       r.stay_type,
       r.total_price,
       r.guest_segment,
       b.booking_source,
       b.booking_channel,
       rg.role,
       rg.relationship,
       rg.is_staying,
       rg.is_legacy_inferred,
       rg.identity_verified,
       rg.relation_source
     FROM reservation_guests rg
     JOIN reservations r ON rg.reservation_id = r.id
     JOIN bookings b ON r.booking_id = b.id
     LEFT JOIN rooms rm ON r.room_id = rm.id
     LEFT JOIN room_types rt ON rm.room_type_id = rt.id
     LEFT JOIN rate_plans rp ON r.rate_plan_id = rp.id
     WHERE rg.guest_id = $1 AND b.property_id = $2
     ORDER BY r.check_in DESC`,
    [guestId, propertyId]
  );

  const statsRes = await pool.query(
    `SELECT
       COUNT(DISTINCT r.id)::int AS visit_count,
       COALESCE(SUM(r.check_out::date - r.check_in::date), 0)::int AS room_nights,
       TO_CHAR(MIN(r.check_in), 'YYYY-MM-DD') AS first_stay,
       TO_CHAR(MAX(r.check_out), 'YYYY-MM-DD') AS last_stay
     FROM reservation_guests rg
     JOIN reservations r ON rg.reservation_id = r.id
     JOIN bookings b ON r.booking_id = b.id
     WHERE rg.guest_id = $1
       AND b.property_id = $2
       AND r.status IN ('CHECKED_IN', 'CHECKED_OUT')`,
    [guestId, propertyId]
  );

  const stats = statsRes.rows[0] || { visit_count: 0, room_nights: 0, first_stay: null, last_stay: null };

  // Compute loyalty metrics for this guest
  const { guests: matchedGuests } = await searchGuests(pool, propertyId, guest.full_name, 100, 0, undefined, true);
  const enriched = matchedGuests.find((g) => Number(g.id) === Number(guestId));

  return {
    ...guest,
    guest_code: guest.guest_code || `GST-${String(guest.id).padStart(5, '0')}`,
    visit_count: stats.visit_count,
    room_nights: stats.room_nights,
    first_stay: stats.first_stay,
    last_stay: stats.last_stay,
    total_spend: enriched?.total_spend ?? 0,
    earned_points: enriched?.earned_points ?? 0,
    bonus_points: enriched?.bonus_points ?? 0,
    redeemed_points: enriched?.redeemed_points ?? 0,
    loyalty_points: enriched?.loyalty_points ?? 0,
    point_value_idr: enriched?.point_value_idr ?? 0,
    loyalty_tier: enriched?.loyalty_tier ?? 'BRONZE',
    loyalty_tier_name: enriched?.loyalty_tier_name ?? 'Bronze',
    tier_discount_pct: enriched?.tier_discount_pct ?? 0,
    stays: staysRes.rows
  };
}

export async function redeemPointsForReservation(
  pool: Pool,
  input: {
    property_id: number;
    reservation_id: number;
    guest_id: number;
    points_to_redeem: number;
    created_by?: string | null;
  },
  correlationId?: string,
  actorUserId?: number | null
): Promise<{
  ledger_entry: GuestLoyaltyLedgerEntry;
  redeemed_points: number;
  discount_amount_idr: number;
  new_total_price: number;
  new_remaining_balance: number;
}> {
  const propertyId = parsePropertyId(input.property_id, 'property_id');
  const reservationId = Number(input.reservation_id);
  const guestId = Number(input.guest_id);
  const pointsToRedeem = Math.round(Number(input.points_to_redeem || 0));

  if (!Number.isInteger(reservationId) || reservationId <= 0) {
    throw httpError(400, 'VALIDATION_ERROR', 'reservation_id wajib valid');
  }
  if (!Number.isInteger(guestId) || guestId <= 0) {
    throw httpError(400, 'VALIDATION_ERROR', 'guest_id wajib valid');
  }
  if (!Number.isInteger(pointsToRedeem) || pointsToRedeem <= 0) {
    throw httpError(400, 'VALIDATION_ERROR', 'Jumlah poin yang ditukar harus lebih dari 0');
  }

  await assertPropertyExists(pool, propertyId);
  await ensureGuestCrmTables(pool);
  const settings = await getPropertyLoyaltySettings(pool, propertyId);
  if (!settings.points_enabled) {
    throw httpError(400, 'LOYALTY_DISABLED', 'Program Poin sedang dinonaktifkan untuk properti ini.');
  }
  if (pointsToRedeem < settings.min_redeem_points) {
    throw httpError(
      400,
      'MIN_REDEEM_NOT_MET',
      `Minimal penukaran adalah ${settings.min_redeem_points} poin.`
    );
  }

  const guestDetail = await getGuestById(pool, guestId, propertyId);
  const availablePoints = Number(guestDetail.loyalty_points || 0);
  if (pointsToRedeem > availablePoints) {
    throw httpError(
      400,
      'INSUFFICIENT_POINTS',
      `Saldo poin tamu (${availablePoints} poin) tidak mencukupi untuk penukaran ${pointsToRedeem} poin.`
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const resvLock = await client.query(
      `SELECT r.*, b.bid, b.property_id AS booking_property_id
       FROM reservations r
       JOIN bookings b ON b.id = r.booking_id
       WHERE r.id = $1
       FOR UPDATE`,
      [reservationId]
    );
    if ((resvLock.rowCount ?? 0) === 0) {
      throw httpError(404, 'RESERVATION_NOT_FOUND', 'Reservasi tidak ditemukan');
    }
    const resv = resvLock.rows[0];
    if (Number(resv.booking_property_id) !== propertyId) {
      throw httpError(403, 'PROPERTY_MISMATCH', 'Reservasi bukan milik properti ini');
    }

    const currentTotal = Math.max(0, Number(resv.total_price || 0));
    const amountPaid = Math.max(0, Number(resv.amount_paid || 0));
    const currentRemaining = Math.max(0, Number(resv.remaining_balance ?? (currentTotal - amountPaid)));

    const rawDiscountIdr = Math.round(pointsToRedeem * Number(settings.point_value_idr || 350));
    const maxCuttable = currentRemaining > 0 ? currentRemaining : currentTotal;
    if (maxCuttable <= 0) {
      throw httpError(400, 'NOTHING_TO_DISCOUNT', 'Tagihan reservasi sudah Rp 0.');
    }
    const effectiveDiscountIdr = Math.min(rawDiscountIdr, maxCuttable);
    const newTotalPrice = Math.max(0, currentTotal - effectiveDiscountIdr);
    const newRemainingBalance = Math.max(0, newTotalPrice - amountPaid);
    const newPaymentStatus =
      newRemainingBalance <= 0 && (amountPaid > 0 || newTotalPrice === 0)
        ? 'PAID'
        : resv.payment_status;

    const noteTag = `[Redeem ${pointsToRedeem} Poin = -Rp ${effectiveDiscountIdr.toLocaleString('id-ID')}]`;
    const updatedSpecialRequests = resv.special_requests
      ? `${resv.special_requests} ${noteTag}`
      : noteTag;

    await client.query(
      `UPDATE reservations
       SET total_price = $1,
           remaining_balance = $2,
           payment_status = $3,
           special_requests = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [newTotalPrice, newRemainingBalance, newPaymentStatus, updatedSpecialRequests, reservationId]
    );

    // Also sync bookings.total_amount and transactions if present
    await client.query(
      `UPDATE bookings
       SET total_amount = GREATEST(0, COALESCE(total_amount, 0) - $1),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [effectiveDiscountIdr, resv.booking_id]
    );

    await client.query(
      `UPDATE transactions
       SET discount_amount = COALESCE(discount_amount, 0) + $1,
           net_amount = GREATEST(0, COALESCE(net_amount, 0) - $1),
           updated_at = CURRENT_TIMESTAMP
       WHERE property_id = $2
         AND (reservation_id = $3 OR (reservation_id IS NULL AND booking_id = $4))
         AND transaction_type = 'SALE'
         AND deleted_at IS NULL`,
      [effectiveDiscountIdr, propertyId, reservationId, resv.booking_id]
    );

    const ledgerRes = await client.query(
      `INSERT INTO guest_loyalty_ledger (
         property_id, guest_id, entry_type, points, description, reference_no, created_by
       ) VALUES ($1, $2, 'REDEEM', $3, $4, $5, $6)
       RETURNING *`,
      [
        propertyId,
        guestId,
        -Math.abs(pointsToRedeem),
        `Potong Tagihan Reservasi ${resv.bid || '#' + reservationId} (-Rp ${effectiveDiscountIdr.toLocaleString('id-ID')})`,
        resv.bid || `RESV-${reservationId}`,
        input.created_by || 'Front Office',
      ]
    );

    const ledgerRow = ledgerRes.rows[0];
    await writeGuestAudit(client, {
      action: 'GUEST_LOYALTY',
      entity: 'GUEST',
      recordId: guestId,
      newValue: {
        action: 'REDEEM_FOR_RESERVATION',
        reservation_id: reservationId,
        bid: resv.bid,
        points_redeemed: pointsToRedeem,
        discount_amount_idr: effectiveDiscountIdr,
        new_total_price: newTotalPrice,
        new_remaining_balance: newRemainingBalance,
      },
      propertyId,
      correlationId,
      actorUserId,
    });

    await client.query('COMMIT');
    return {
      ledger_entry: {
        id: Number(ledgerRow.id),
        property_id: Number(ledgerRow.property_id),
        guest_id: Number(ledgerRow.guest_id),
        entry_type: ledgerRow.entry_type,
        points: Number(ledgerRow.points),
        description: ledgerRow.description,
        reference_no: ledgerRow.reference_no,
        created_by: ledgerRow.created_by,
        created_at: ledgerRow.created_at,
      },
      redeemed_points: pointsToRedeem,
      discount_amount_idr: effectiveDiscountIdr,
      new_total_price: newTotalPrice,
      new_remaining_balance: newRemainingBalance,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function createGuest(
  pool: Pool,
  input: GuestCreateInput,
  correlationId?: string
): Promise<Guest> {
  const propertyId = parsePropertyId(input.property_id, 'property_id');
  await assertPropertyExists(pool, propertyId);

  const fullName = String(input.full_name || '').trim();
  if (!fullName) {
    throw httpError(400, 'VALIDATION_ERROR', 'full_name is required');
  }

  const preferredName = input.preferred_name ? String(input.preferred_name).trim() || null : null;
  const gender = normalizeGender(input.gender);
  const birthPlace = input.birth_place ? String(input.birth_place).trim() || null : null;
  const birthDate = input.birth_date ? String(input.birth_date).trim() || null : null;
  const nationality = input.nationality ? String(input.nationality).trim() || 'ID' : 'ID';
  const phone = normalizePhone(input.phone);
  const normalizedPhone = normalizeDigitsOnly(input.phone);
  const email = normalizeEmail(input.email);
  const normalizedEmail = email;
  const address = input.address ? String(input.address).trim() || null : null;
  const city = input.city ? String(input.city).trim() || null : null;
  const province = input.province ? String(input.province).trim() || null : null;
  const country = input.country ? String(input.country).trim() || 'Indonesia' : 'Indonesia';
  const guestSegment = input.guest_segment ? String(input.guest_segment).trim() : 'Reguler';
  const vipStatus = normalizeVipStatus(input.vip_status);
  const preferences = input.preferences ? String(input.preferences).trim() || null : null;
  const notes = input.notes ? String(input.notes).trim() || null : null;
  const identityType = input.identity_type ? String(input.identity_type).trim() : 'KTP';
  const identityNumber = input.identity_number ? String(input.identity_number).trim() : null;
  const normalizedIdentity = normalizeIdentityNumber(input.identity_number);
  const identityPath = input.identity_path ? String(input.identity_path).trim() : null;
  const hasValidIdentity = input.has_valid_identity !== undefined ? Boolean(input.has_valid_identity) : Boolean(identityNumber || identityPath);
  const rtRw = input.rt_rw ? String(input.rt_rw).trim() || null : null;
  const villageKelurahan = input.village_kelurahan ? String(input.village_kelurahan).trim() || null : null;
  const districtKecamatan = input.district_kecamatan ? String(input.district_kecamatan).trim() || null : null;
  const religion = input.religion ? String(input.religion).trim() || null : null;
  const maritalStatus = input.marital_status ? String(input.marital_status).trim() || null : null;
  const occupation = input.occupation ? String(input.occupation).trim() || null : null;
  const citizenship = input.citizenship ? String(input.citizenship).trim() || null : null;
  const validUntil = input.valid_until ? String(input.valid_until).trim() || null : null;
  const ktpOcrConfidence = input.ktp_ocr_confidence !== undefined ? input.ktp_ocr_confidence : null;
  const ktpOcrProvider = input.ktp_ocr_provider ? String(input.ktp_ocr_provider).trim() || null : null;
  const createdBy = input.created_by ? String(input.created_by).trim() || null : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const normalizedName = fullName.toLowerCase();
    const ktpExtractedAt = (identityPath || identityNumber) ? new Date() : null;
    const res = await client.query(
      `INSERT INTO guests (
        full_name, normalized_name, preferred_name, gender, birth_place, birth_date,
        nationality, phone, normalized_phone, email, normalized_email, address, city, province, country,
        guest_segment, vip_status, preferences, is_blacklisted, notes, identity_type, identity_number, normalized_identity_number, identity_path,
        has_valid_identity, rt_rw, village_kelurahan, district_kecamatan, religion, marital_status, occupation, citizenship, valid_until,
        ktp_ocr_confidence, ktp_ocr_provider, ktp_extracted_at,
        is_archived, is_active, created_by, created_property_id, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, false, $19, $20, $21, $22, $23,
        $24, $25, $26, $27, $28, $29, $30, $31, $32,
        $33, $34, $35,
        false, true, $36, $37, NOW(), NOW()
      )
      RETURNING *`,
      [
        fullName,
        normalizedName,
        preferredName,
        gender,
        birthPlace,
        birthDate,
        nationality,
        phone,
        normalizedPhone,
        email,
        normalizedEmail,
        address,
        city,
        province,
        country,
        guestSegment,
        vipStatus,
        preferences,
        notes,
        identityType,
        identityNumber,
        normalizedIdentity,
        identityPath,
        hasValidIdentity,
        rtRw,
        villageKelurahan,
        districtKecamatan,
        religion,
        maritalStatus,
        occupation,
        citizenship,
        validUntil,
        ktpOcrConfidence,
        ktpOcrProvider,
        ktpExtractedAt,
        createdBy,
        propertyId
      ]
    );
    let createdGuest = res.rows[0];

    // Ensure guest_code is populated
    const guestCode = input.guest_code || `GST-${String(createdGuest.id).padStart(5, '0')}`;
    const updateCodeRes = await client.query(
      `UPDATE guests SET guest_code = $1 WHERE id = $2 RETURNING *`,
      [guestCode, createdGuest.id]
    );
    createdGuest = updateCodeRes.rows[0];

    await writeGuestAudit(client, {
      action: 'GUEST_CREATE',
      entity: 'GUEST',
      recordId: createdGuest.id,
      newValue: createdGuest,
      propertyId,
      correlationId
    });

    await client.query('COMMIT');
    return createdGuest;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function updateGuest(
  pool: Pool,
  guestId: number,
  input: GuestUpdateInput,
  correlationId?: string
): Promise<Guest> {
  const propertyId = parsePropertyId(input.property_id, 'property_id');
  await assertPropertyExists(pool, propertyId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Authorize property access
    await assertGuestBelongsToProperty(client, guestId, propertyId);

    const existingRes = await client.query('SELECT * FROM guests WHERE id = $1 FOR UPDATE', [guestId]);
    if ((existingRes.rowCount ?? 0) === 0) {
      throw httpError(404, 'GUEST_NOT_FOUND', `guest ${guestId} not found`);
    }
    const existing = existingRes.rows[0];

    const fullName = input.full_name !== undefined ? String(input.full_name || '').trim() : existing.full_name;
    if (!fullName) {
      throw httpError(400, 'VALIDATION_ERROR', 'full_name must not be empty');
    }

    const guestCode = input.guest_code !== undefined ? (input.guest_code ? String(input.guest_code).trim() : null) : existing.guest_code;
    const preferredName = input.preferred_name !== undefined ? (input.preferred_name ? String(input.preferred_name).trim() : null) : existing.preferred_name;
    const gender = input.gender !== undefined ? normalizeGender(input.gender) : existing.gender;
    const birthPlace = input.birth_place !== undefined ? (input.birth_place ? String(input.birth_place).trim() : null) : existing.birth_place;
    const birthDate = input.birth_date !== undefined ? (input.birth_date ? String(input.birth_date).trim() : null) : existing.birth_date;
    const nationality = input.nationality !== undefined ? (input.nationality ? String(input.nationality).trim() : 'ID') : existing.nationality;
    const phone = input.phone !== undefined ? normalizePhone(input.phone) : existing.phone;
    const normalizedPhone = phone ? normalizeDigitsOnly(phone) : null;
    const email = input.email !== undefined ? normalizeEmail(input.email) : existing.email;
    const normalizedEmail = email;
    const address = input.address !== undefined ? (input.address ? String(input.address).trim() : null) : existing.address;
    const city = input.city !== undefined ? (input.city ? String(input.city).trim() : null) : existing.city;
    const province = input.province !== undefined ? (input.province ? String(input.province).trim() : null) : existing.province;
    const country = input.country !== undefined ? (input.country ? String(input.country).trim() : 'Indonesia') : existing.country;
    const guestSegment = input.guest_segment !== undefined ? (input.guest_segment ? String(input.guest_segment).trim() : 'Reguler') : existing.guest_segment;
    const vipStatus = input.vip_status !== undefined ? normalizeVipStatus(input.vip_status) : existing.vip_status;
    const preferences = input.preferences !== undefined ? (input.preferences ? String(input.preferences).trim() : null) : existing.preferences;
    const isBlacklisted = input.is_blacklisted !== undefined ? Boolean(input.is_blacklisted) : existing.is_blacklisted;
    const blacklistReason = input.blacklist_reason !== undefined ? (input.blacklist_reason ? String(input.blacklist_reason).trim() : null) : existing.blacklist_reason;
    const identityType = input.identity_type !== undefined ? (input.identity_type ? String(input.identity_type).trim() : null) : existing.identity_type;
    const identityNumber = input.identity_number !== undefined ? (input.identity_number ? String(input.identity_number).trim() : null) : existing.identity_number;
    const normalizedIdentity = identityNumber ? normalizeIdentityNumber(identityNumber) : null;
    const identityPath = input.identity_path !== undefined ? (input.identity_path ? String(input.identity_path).trim() : null) : existing.identity_path;
    const hasValidIdentity = input.has_valid_identity !== undefined
      ? Boolean(input.has_valid_identity)
      : (Boolean(identityNumber || identityPath) || existing.has_valid_identity);
    const rtRw = input.rt_rw !== undefined ? (input.rt_rw ? String(input.rt_rw).trim() : null) : existing.rt_rw;
    const villageKelurahan = input.village_kelurahan !== undefined ? (input.village_kelurahan ? String(input.village_kelurahan).trim() : null) : existing.village_kelurahan;
    const districtKecamatan = input.district_kecamatan !== undefined ? (input.district_kecamatan ? String(input.district_kecamatan).trim() : null) : existing.district_kecamatan;
    const religion = input.religion !== undefined ? (input.religion ? String(input.religion).trim() : null) : existing.religion;
    const maritalStatus = input.marital_status !== undefined ? (input.marital_status ? String(input.marital_status).trim() : null) : existing.marital_status;
    const occupation = input.occupation !== undefined ? (input.occupation ? String(input.occupation).trim() : null) : existing.occupation;
    const citizenship = input.citizenship !== undefined ? (input.citizenship ? String(input.citizenship).trim() : null) : existing.citizenship;
    const validUntil = input.valid_until !== undefined ? (input.valid_until ? String(input.valid_until).trim() : null) : existing.valid_until;
    const ktpOcrConfidence = input.ktp_ocr_confidence !== undefined ? input.ktp_ocr_confidence : existing.ktp_ocr_confidence;
    const ktpOcrProvider = input.ktp_ocr_provider !== undefined ? (input.ktp_ocr_provider ? String(input.ktp_ocr_provider).trim() : null) : existing.ktp_ocr_provider;

    // ktp_regency_id: preserve existing when input is undefined/null; validate only when a number is provided.
    let ktpRegencyId: number | null = existing.ktp_regency_id ?? null;
    if (input.ktp_regency_id !== undefined && input.ktp_regency_id !== null) {
      const parsed = Number(input.ktp_regency_id);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw httpError(400, 'INVALID_KTP_REGENCY_ID', 'ID kabupaten/kota KTP tidak valid.');
      }
      const regCheck = await client.query('SELECT 1 FROM regencies WHERE id = $1 LIMIT 1', [parsed]);
      if ((regCheck.rowCount ?? 0) === 0) {
        throw httpError(400, 'INVALID_KTP_REGENCY_ID', 'Kota/Kabupaten KTP tidak ditemukan.');
      }
      ktpRegencyId = parsed;
    }

    const notes = input.notes !== undefined ? (input.notes ? String(input.notes).trim() : null) : existing.notes;
    const isArchived = input.is_archived !== undefined ? Boolean(input.is_archived) : existing.is_archived;
    const isActive = input.is_active !== undefined ? Boolean(input.is_active) : existing.is_active;

    if (normalizedIdentity && normalizedIdentity !== existing.normalized_identity_number) {
      const dupNikRes = await client.query(
        `SELECT id, full_name FROM guests
         WHERE created_property_id = $1
           AND normalized_identity_number = $2
           AND id <> $3
         LIMIT 1`,
        [propertyId, normalizedIdentity, guestId]
      );
      if ((dupNikRes.rowCount ?? 0) > 0) {
        throw httpError(
          409,
          'DUPLICATE_IDENTITY_NUMBER',
          `Nomor identitas sudah terdaftar pada profil tamu lain (#${dupNikRes.rows[0].id}).`
        );
      }
    }

    const normalizedName = fullName.toLowerCase();
    const res = await client.query(
      `UPDATE guests
       SET full_name = $1, normalized_name = $2, guest_code = COALESCE($3, guest_code), preferred_name = $4, gender = $5, birth_place = $6, birth_date = $7,
           nationality = $8, phone = $9, normalized_phone = $10, email = $11, normalized_email = $12, address = $13, city = $14,
           province = $15, country = $16, guest_segment = $17, vip_status = $18, preferences = $19, is_blacklisted = $20,
           blacklist_reason = $21, notes = $22, identity_type = $23, identity_number = $24, normalized_identity_number = $25,
           identity_path = $26, has_valid_identity = $27, rt_rw = $28, village_kelurahan = $29, district_kecamatan = $30,
           religion = $31, marital_status = $32, occupation = $33, citizenship = $34, valid_until = $35,
            ktp_ocr_confidence = $36, ktp_ocr_provider = $37,
            ktp_regency_id = $38,
            is_archived = $39, is_active = $40, updated_at = NOW()
        WHERE id = $41
       RETURNING *`,
      [
        fullName,
        normalizedName,
        guestCode,
        preferredName,
        gender,
        birthPlace,
        birthDate,
        nationality,
        phone,
        normalizedPhone,
        email,
        normalizedEmail,
        address,
        city,
        province,
        country,
        guestSegment,
        vipStatus,
        preferences,
        isBlacklisted,
        blacklistReason,
        notes,
        identityType,
        identityNumber,
        normalizedIdentity,
        identityPath,
        hasValidIdentity,
        rtRw,
        villageKelurahan,
        districtKecamatan,
        religion,
        maritalStatus,
        occupation,
        citizenship,
        validUntil,
        ktpOcrConfidence,
        ktpOcrProvider,
        ktpRegencyId,
        isArchived,
        isActive,
        guestId
      ]
    );
    const updated = res.rows[0];

    await writeGuestAudit(client, {
      action: 'GUEST_UPDATE',
      entity: 'GUEST',
      recordId: guestId,
      newValue: {
        ...updated,
        before: existing,
        after: updated
      },
      propertyId,
      correlationId
    });

    await client.query('COMMIT');
    return updated;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function archiveGuest(
  pool: Pool,
  guestId: number,
  propertyId: number,
  correlationId?: string
): Promise<Guest> {
  await assertPropertyExists(pool, propertyId);
  await assertGuestBelongsToProperty(pool, guestId, propertyId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `UPDATE guests
       SET is_archived = TRUE, is_active = FALSE, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [guestId]
    );
    const updated = res.rows[0];

    await writeGuestAudit(client, {
      action: 'GUEST_ARCHIVE',
      entity: 'GUEST',
      recordId: guestId,
      newValue: updated,
      propertyId,
      correlationId
    });

    await client.query('COMMIT');
    return updated;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function restoreGuest(
  pool: Pool,
  guestId: number,
  propertyId: number,
  correlationId?: string
): Promise<Guest> {
  await assertPropertyExists(pool, propertyId);
  await assertGuestBelongsToProperty(pool, guestId, propertyId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `UPDATE guests
       SET is_archived = FALSE, is_active = TRUE, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [guestId]
    );
    const updated = res.rows[0];

    await writeGuestAudit(client, {
      action: 'GUEST_RESTORE',
      entity: 'GUEST',
      recordId: guestId,
      newValue: updated,
      propertyId,
      correlationId
    });

    await client.query('COMMIT');
    return updated;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteGuest(
  pool: Pool,
  guestId: number,
  propertyId: number,
  correlationId?: string
): Promise<{ deleted: boolean }> {
  await assertPropertyExists(pool, propertyId);
  await assertGuestBelongsToProperty(pool, guestId, propertyId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check if guest is linked to any reservation
    const stayCheck = await client.query(
      `SELECT COUNT(*)::int AS count FROM reservation_guests WHERE guest_id = $1`,
      [guestId]
    );
    if ((stayCheck.rows[0]?.count || 0) > 0) {
      throw httpError(
        409,
        'GUEST_HAS_STAY_HISTORY',
        'Tamu memiliki riwayat reservasi dan tidak dapat dihapus secara permanen. Silakan gunakan fitur Arsipkan Tamu untuk menonaktifkannya.'
      );
    }

    await client.query(`DELETE FROM guests WHERE id = $1`, [guestId]);

    await writeGuestAudit(client, {
      action: 'GUEST_DELETE',
      entity: 'GUEST',
      recordId: guestId,
      newValue: { deleted_id: guestId },
      propertyId,
      correlationId
    });

    await client.query('COMMIT');
    return { deleted: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function matchGuest(
  pool: Pool,
  propertyId: number,
  query: { name?: string; phone?: string; email?: string }
): Promise<{ classification: MatchClassification; candidates: Guest[] }> {
  await assertPropertyExists(pool, propertyId);

  const name = query.name ? query.name.trim() : '';
  const phone = normalizePhone(query.phone);
  const email = normalizeEmail(query.email);

  if (!name && !phone && !email) {
    return { classification: 'NEW_GUEST', candidates: [] };
  }

  const baseFilter = `
    (
      g.created_property_id = $1
      OR EXISTS (
        SELECT 1
        FROM reservation_guests rg
        JOIN reservations r ON rg.reservation_id = r.id
        JOIN bookings b ON r.booking_id = b.id
        WHERE rg.guest_id = g.id AND b.property_id = $1
      )
    )
  `;

  const conditions: string[] = [];
  const params: any[] = [propertyId];

  if (phone) {
    params.push(phone);
    conditions.push(`g.phone = $${params.length}`);
  }
  if (email) {
    params.push(email);
    conditions.push(`LOWER(g.email) = LOWER($${params.length})`);
  }
  if (name) {
    params.push(name);
    conditions.push(`LOWER(g.full_name) = LOWER($${params.length})`);
  }

  const res = await pool.query(
    `SELECT g.*, COALESCE(g.guest_code, 'GST-' || LPAD(g.id::text, 5, '0')) AS guest_code
     FROM guests g
     WHERE ${baseFilter} AND (${conditions.join(' OR ')})
     ORDER BY g.updated_at DESC LIMIT 10`,
    params
  );

  if (res.rows.length === 0) {
    return { classification: 'NEW_GUEST', candidates: [] };
  }

  return { classification: 'POSSIBLE_MATCH', candidates: res.rows };
}

// ---------------------------------------------------------------------------
// Reservation Guests Relations
// ---------------------------------------------------------------------------

export async function listReservationGuests(
  pool: Pool,
  reservationId: number,
  propertyId: number
): Promise<ReservationGuest[]> {
  await assertPropertyExists(pool, propertyId);
  await assertReservationBelongsToProperty(pool, reservationId, propertyId);

  const res = await pool.query(
    `SELECT
       rg.*,
       g.full_name,
       g.phone,
       g.email,
       g.vip_status,
       g.is_blacklisted,
       g.identity_type,
       g.identity_number,
       g.identity_path,
       g.has_valid_identity
     FROM reservation_guests rg
     JOIN guests g ON rg.guest_id = g.id
     WHERE rg.reservation_id = $1
     ORDER BY
       CASE rg.role
         WHEN 'PRIMARY_GUEST' THEN 1
         WHEN 'BOOKER' THEN 2
         WHEN 'ADDITIONAL_GUEST' THEN 3
         ELSE 4
       END,
       rg.created_at ASC`,
    [reservationId]
  );

  return res.rows;
}

export async function addReservationGuest(
   pool: Pool,
   reservationId: number,
   propertyId: number,
   input: ReservationGuestCreateInput,
   correlationId?: string,
   actorUserId?: number | null
 ): Promise<ReservationGuest> {
   await assertPropertyExists(pool, propertyId);
   await assertReservationBelongsToProperty(pool, reservationId, propertyId);

   const guestId = Number(input.guest_id);
   if (!Number.isInteger(guestId) || guestId <= 0) {
     throw httpError(400, 'VALIDATION_ERROR', 'guest_id must be a positive integer');
   }
   await assertGuestBelongsToProperty(pool, guestId, propertyId);

   const role = normalizeRole(input.role);
   const relationship = input.relationship ? String(input.relationship).trim() || null : null;
   const isStaying = input.is_staying !== undefined ? Boolean(input.is_staying) : true;
   const identityVerified = input.identity_verified !== undefined ? Boolean(input.identity_verified) : false;
   const relationSource = input.relation_source ? String(input.relation_source).trim() : 'MANUAL_ENTRY';
   const expectedPrimaryGuestId = input.expected_primary_guest_id ? Number(input.expected_primary_guest_id) : null;
   const isCheckinIdentityConfirm = relationSource === 'CHECKIN_IDENTITY_CONFIRMATION' && role === 'PRIMARY_GUEST';

   const client = await pool.connect();
   try {
     await client.query('BEGIN');

     // Invariant: Exactly 1 PRIMARY_GUEST per reservation
     if (role === 'PRIMARY_GUEST') {
       // Canonical lock order: reservations first, then reservation_guests.
       // This matches check-in lock order (rooms → reservations → reservation_guests)
       // to prevent deadlocks.
       if (isCheckinIdentityConfirm) {
         // Lock the reservation row first (same lock as check-in transaction)
         await client.query(
           'SELECT id FROM reservations WHERE id = $1 FOR UPDATE',
           [reservationId]
         );
       }

        const existingPrimaryRes = await client.query(
          `SELECT id, guest_id FROM reservation_guests WHERE reservation_id = $1 AND role = 'PRIMARY_GUEST' FOR UPDATE`,
          [reservationId]
        );
        if ((existingPrimaryRes.rowCount ?? 0) > 0) {
          // CAS validation for CHECKIN_IDENTITY_CONFIRMATION
          if (isCheckinIdentityConfirm && expectedPrimaryGuestId !== null) {
            const currentPrimaryGuestId = Number(existingPrimaryRes.rows[0].guest_id);
            if (currentPrimaryGuestId !== expectedPrimaryGuestId) {
              await client.query('ROLLBACK');
              throw httpError(409, 'PRIMARY_GUEST_CHANGED', 'PRIMARY_GUEST has changed since the identity was confirmed. Please refresh and retry.');
            }
          }

          // Replace existing primary guest relation
          const existingId = existingPrimaryRes.rows[0].id;
          const currentGuestId = Number(existingPrimaryRes.rows[0].guest_id);

          await client.query(
            `UPDATE reservation_guests
             SET guest_id = $1, relationship = $2, is_staying = $3, identity_verified = $4,
                 relation_source = $5, updated_at = NOW()
             WHERE id = $6`,
            [guestId, relationship, isStaying, identityVerified, relationSource, existingId]
          );

           // Atomic snapshot sync for CHECKIN_IDENTITY_CONFIRMATION
           if (isCheckinIdentityConfirm) {
             await client.query(
               `UPDATE reservations SET
                  guest_name = (SELECT full_name FROM guests WHERE id = $1),
                  guest_phone = (SELECT phone FROM guests WHERE id = $1),
                  identity_number = (SELECT identity_number FROM guests WHERE id = $1),
                  has_valid_identity = (SELECT has_valid_identity FROM guests WHERE id = $1),
                  ktp_path = (SELECT identity_path FROM guests WHERE id = $1)
                WHERE id = $2`,
               [guestId, reservationId]
             );
          }

           await writeGuestAudit(client, {
             action: 'PRIMARY_GUEST_REPLACE',
             entity: 'RESERVATION_GUEST',
             recordId: existingId,
             newValue: {
               reservation_id: reservationId,
               previous_guest_id: currentGuestId,
               new_guest_id: guestId,
               role,
               relation_source: relationSource
             },
             propertyId,
             correlationId,
             actorUserId
           });

          await client.query('COMMIT');
          const updatedRes = await client.query('SELECT * FROM reservation_guests WHERE id = $1', [existingId]);
          return updatedRes.rows[0];
        }

        // MISSING-ROW GUARD: CHECKIN_IDENTITY_CONFIRMATION requires an existing
        // PRIMARY_GUEST row. If expected_primary_guest_id is provided and the
        // relation is missing, this violates CAS semantics — treat as changed.
        if (isCheckinIdentityConfirm && expectedPrimaryGuestId !== null) {
          await client.query('ROLLBACK');
          throw httpError(409, 'PRIMARY_GUEST_CHANGED', 'PRIMARY_GUEST relation not found or has changed since the identity was confirmed. Please refresh and retry.');
        }
     }

     const res = await client.query(
       `INSERT INTO reservation_guests (
         reservation_id, guest_id, role, relationship, is_staying,
         identity_verified, relation_source, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       ON CONFLICT (reservation_id, guest_id, role)
       DO UPDATE SET
         relationship = EXCLUDED.relationship,
         is_staying = EXCLUDED.is_staying,
         identity_verified = EXCLUDED.identity_verified,
         updated_at = NOW()
       RETURNING *`,
       [reservationId, guestId, role, relationship, isStaying, identityVerified, relationSource]
     );

     const createdRelation = res.rows[0];

     await writeGuestAudit(client, {
       action: 'RESERVATION_GUEST_ADD',
       entity: 'RESERVATION_GUEST',
       recordId: createdRelation.id,
       newValue: createdRelation,
       propertyId,
       correlationId
     });

     await client.query('COMMIT');
     return createdRelation;
   } catch (err) {
     await client.query('ROLLBACK').catch(() => {});
     throw err;
   } finally {
     client.release();
   }
 }

export async function updateReservationGuest(
  pool: Pool,
  reservationId: number,
  relationId: number,
  propertyId: number,
  input: ReservationGuestUpdateInput,
  correlationId?: string
): Promise<ReservationGuest> {
  await assertPropertyExists(pool, propertyId);
  await assertReservationBelongsToProperty(pool, reservationId, propertyId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existingRes = await client.query(
      `SELECT * FROM reservation_guests WHERE id = $1 AND reservation_id = $2 FOR UPDATE`,
      [relationId, reservationId]
    );
    if ((existingRes.rowCount ?? 0) === 0) {
      throw httpError(404, 'RELATION_NOT_FOUND', `reservation guest relation ${relationId} not found`);
    }
    const existing = existingRes.rows[0];

    const targetRole = input.role !== undefined ? normalizeRole(input.role) : existing.role;
    const relationship = input.relationship !== undefined ? (input.relationship ? String(input.relationship).trim() : null) : existing.relationship;
    const isStaying = input.is_staying !== undefined ? Boolean(input.is_staying) : existing.is_staying;
    const identityVerified = input.identity_verified !== undefined ? Boolean(input.identity_verified) : existing.identity_verified;

    // Invariant: Only 1 PRIMARY_GUEST allowed
    if (targetRole === 'PRIMARY_GUEST' && existing.role !== 'PRIMARY_GUEST') {
      const otherPrimary = await client.query(
        `SELECT id FROM reservation_guests WHERE reservation_id = $1 AND role = 'PRIMARY_GUEST' AND id != $2`,
        [reservationId, relationId]
      );
      if ((otherPrimary.rowCount ?? 0) > 0) {
        throw httpError(409, 'PRIMARY_GUEST_CONFLICT', 'reservation already has a primary guest');
      }
    }

    const res = await client.query(
      `UPDATE reservation_guests
       SET role = $1, relationship = $2, is_staying = $3, identity_verified = $4, updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [targetRole, relationship, isStaying, identityVerified, relationId]
    );

    const updated = res.rows[0];

    await writeGuestAudit(client, {
      action: 'RESERVATION_GUEST_UPDATE',
      entity: 'RESERVATION_GUEST',
      recordId: relationId,
      newValue: updated,
      propertyId,
      correlationId
    });

    await client.query('COMMIT');
    return updated;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteReservationGuest(
  pool: Pool,
  reservationId: number,
  relationId: number,
  propertyId: number,
  correlationId?: string
): Promise<void> {
  await assertPropertyExists(pool, propertyId);
  await assertReservationBelongsToProperty(pool, reservationId, propertyId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existingRes = await client.query(
      `SELECT * FROM reservation_guests WHERE id = $1 AND reservation_id = $2 FOR UPDATE`,
      [relationId, reservationId]
    );
    if ((existingRes.rowCount ?? 0) === 0) {
      throw httpError(404, 'RELATION_NOT_FOUND', `reservation guest relation ${relationId} not found`);
    }
    const existing = existingRes.rows[0];

    // Invariant: Do not delete the only PRIMARY_GUEST unless replacing
    if (existing.role === 'PRIMARY_GUEST') {
      const allGuests = await client.query(
        `SELECT id, role FROM reservation_guests WHERE reservation_id = $1`,
        [reservationId]
      );
      if (allGuests.rowCount === 1) {
        throw httpError(409, 'PRIMARY_GUEST_REQUIRED', 'cannot delete the only primary guest of a reservation');
      }
    }

    await client.query('DELETE FROM reservation_guests WHERE id = $1', [relationId]);

    await writeGuestAudit(client, {
      action: 'RESERVATION_GUEST_REMOVE',
      entity: 'RESERVATION_GUEST',
      recordId: relationId,
      newValue: existing,
      propertyId,
      correlationId
    });

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface SyncPrimaryGuestInput {
  guestPhone?: string | null;
  guestName?: string | null;
  propertyId?: number | null;
  relationSource?: string;
}

/**
 * Authoritatively synchronizes primary staying guest phone between reservation write-paths
 * and the canonical guests table via reservation_guests (role = 'PRIMARY_GUEST').
 *
 * Invariants:
 * 1. Do not overwrite an existing valid canonical phone with empty input.
 * 2. Synchronize normalized_phone using canonical normalizeDigitsOnly.
 * 3. Never swallow database errors silently.
 * 4. Narrow scope: phone + normalized_phone (and name if explicitly provided).
 *    Never touches identityNumber, ktpPath, or hasValidIdentity.
 * 5. Fail closed if PRIMARY_GUEST relation is missing; do not guess identity by phone.
 */
export async function syncPrimaryGuestFromReservation(
  client: PoolClient,
  reservationId: number,
  input: SyncPrimaryGuestInput
): Promise<number> {
  const rawPhone = input.guestPhone !== undefined && input.guestPhone !== null ? String(input.guestPhone).trim() : null;
  const normPhone = rawPhone ? normalizeDigitsOnly(rawPhone) : null;
  const rawName = input.guestName !== undefined && input.guestName !== null ? String(input.guestName).trim() : null;

  // 1. Lock and check if PRIMARY_GUEST is already linked in reservation_guests
  const pgLinkRes = await client.query(
    `SELECT rg.id AS link_id, rg.guest_id, g.phone, g.normalized_phone, g.full_name,
            g.normalized_name, g.has_valid_identity, g.created_property_id
     FROM reservation_guests rg
     JOIN guests g ON g.id = rg.guest_id
     WHERE rg.reservation_id = $1 AND rg.role = 'PRIMARY_GUEST'
     FOR UPDATE OF rg, g
     LIMIT 1`,
    [reservationId]
  );

  if ((pgLinkRes.rowCount ?? 0) === 0) {
    const err: any = new Error(
      `CANONICAL_PRIMARY_GUEST_MISSING: Reservation #${reservationId} does not have a linked PRIMARY_GUEST relation.`
    );
    err.statusCode = 404;
    err.code = 'PRIMARY_GUEST_RELATION_MISSING';
    throw err;
  }

  const existingGuest = pgLinkRes.rows[0];
  const guestId = Number(existingGuest.guest_id);
  const currentNormName = String(existingGuest.full_name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
  const targetNormName = rawName
    ? rawName.replace(/\s+/g, ' ').toLowerCase()
    : null;
  const existingNormPhone =
    existingGuest.normalized_phone || normalizeDigitsOnly(existingGuest.phone);
  const nameChanged = Boolean(
    targetNormName && currentNormName && targetNormName !== currentNormName
  );
  const phoneChanged = Boolean(normPhone && normPhone !== existingNormPhone);

  if (nameChanged || phoneChanged) {
    const sharedRes = await client.query(
      `SELECT COUNT(*)::int AS other_count
       FROM reservation_guests
       WHERE guest_id = $1 AND reservation_id <> $2`,
      [guestId, reservationId]
    );
    const isSharedAcrossReservations = Number(sharedRes.rows[0]?.other_count || 0) > 0;

    if (nameChanged) {
      const err: any = new Error(
        isSharedAcrossReservations
          ? 'SHARED_PRIMARY_GUEST_CONFLICT: Tamu utama pada reservasi ini terhubung ke profil bersama. Pilih atau buat profil tamu menginap yang sesuai tanpa menimpa profil bersama.'
          : 'GUEST_IDENTITY_TARGET_MISMATCH: Nama tamu menginap berbeda dari profil tamu yang terhubung. Pilih profil tamu yang sesuai atau lengkapi KTP tamu baru.'
      );
      err.statusCode = 409;
      err.code = isSharedAcrossReservations
        ? 'SHARED_PRIMARY_GUEST_CONFLICT'
        : 'GUEST_IDENTITY_TARGET_MISMATCH';
      throw err;
    }

    if (isSharedAcrossReservations && phoneChanged && !existingGuest.has_valid_identity) {
      const err: any = new Error(
        'SHARED_PRIMARY_GUEST_CONFLICT: Tamu utama pada reservasi ini masih menggunakan profil grup bersama dan belum memiliki identitas terverifikasi. Lengkapi identitas tamu kamar ini terlebih dahulu sebelum mengubah nomor telepon master.'
      );
      err.statusCode = 409;
      err.code = 'SHARED_PRIMARY_GUEST_CONFLICT';
      throw err;
    }
  }

  // 2. Authoritatively synchronize phone (and name if explicitly supplied for same person).
  const updatedGuestRes = await client.query(
    `UPDATE guests
     SET phone = CASE
           WHEN $1::VARCHAR IS NOT NULL AND TRIM($1::VARCHAR) <> '' THEN $1::VARCHAR
           ELSE phone
         END,
         normalized_phone = CASE
           WHEN $2::VARCHAR IS NOT NULL AND TRIM($2::VARCHAR) <> '' THEN $2::VARCHAR
           ELSE normalized_phone
         END,
         full_name = CASE
           WHEN $3::VARCHAR IS NOT NULL AND TRIM($3::VARCHAR) <> '' THEN $3::VARCHAR
           ELSE full_name
         END,
         normalized_name = CASE
           WHEN $3::VARCHAR IS NOT NULL AND TRIM($3::VARCHAR) <> '' THEN LOWER($3::VARCHAR)
           ELSE normalized_name
         END,
         updated_at = NOW()
     WHERE id = $4
     RETURNING id, full_name, phone, normalized_phone, created_property_id`,
    [
      rawPhone || null,
      normPhone || null,
      rawName || null,
      guestId
    ]
  );

  const auditPropertyId = Number(
    input.propertyId || existingGuest.created_property_id || 0
  );
  if ((nameChanged || phoneChanged) && Number.isInteger(auditPropertyId) && auditPropertyId > 0) {
    const afterGuest = updatedGuestRes.rows[0] || {};
    await writeGuestAudit(client, {
      action: 'GUEST_UPDATE',
      entity: 'GUEST',
      recordId: guestId,
      newValue: {
        reservation_id: reservationId,
        relation_source: input.relationSource || 'RESERVATION_SYNC',
        before: {
          full_name: existingGuest.full_name,
          phone: existingGuest.phone,
          normalized_phone: existingGuest.normalized_phone
        },
        after: {
          full_name: afterGuest.full_name,
          phone: afterGuest.phone,
          normalized_phone: afterGuest.normalized_phone
        }
      },
      propertyId: auditPropertyId
    });
  }

  return guestId;
}

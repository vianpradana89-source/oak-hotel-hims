import type { Pool, PoolClient } from 'pg';
import type {
  DuplicateCandidate,
  DuplicateCandidateCluster,
  DuplicateCheckInput,
  DuplicateCheckResult,
  Guest,
  GuestCrmSummary,
  GuestCreateInput,
  GuestRole,
  GuestUpdateInput,
  GuestWithStats,
  MatchClassification,
  ReservationGuest,
  ReservationGuestCreateInput,
  ReservationGuestUpdateInput,
  VipStatus
} from './guestTypes';

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
    action: 'GUEST_CREATE' | 'GUEST_UPDATE' | 'GUEST_ARCHIVE' | 'GUEST_RESTORE' | 'GUEST_DELETE' | 'RESERVATION_GUEST_ADD' | 'RESERVATION_GUEST_UPDATE' | 'RESERVATION_GUEST_REMOVE' | 'PRIMARY_GUEST_REPLACE';
    entity: 'GUEST' | 'RESERVATION_GUEST';
    recordId: string | number;
    newValue: any;
    propertyId: number;
    correlationId?: string | null;
  }
): Promise<void> {
  if (!entry.propertyId || !Number.isInteger(entry.propertyId) || entry.propertyId <= 0) {
    throw new Error('AUDIT_INTEGRITY_ERROR: property_id must not be null for guest audit');
  }
  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'GUEST_CRM',
      entry.action,
      entry.entity,
      String(entry.recordId),
      JSON.stringify(entry.newValue),
      entry.correlationId || null,
      entry.propertyId
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

  const safeLimit = Math.max(1, Math.min(limit, 100));
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
      `g.guest_code ILIKE ${textPatternParam}`
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

  params.push(safeLimit);
  const limitParam = `$${params.length}`;
  params.push(safeOffset);
  const offsetParam = `$${params.length}`;

  const res = await pool.query(
    `SELECT
       g.*,
       COALESCE(g.guest_code, 'GST-' || LPAD(g.id::text, 5, '0')) AS guest_code,
       COALESCE(stats.visit_count, 0)::int AS visit_count,
       COALESCE(stats.room_nights, 0)::int AS room_nights,
       stats.first_stay,
       stats.last_stay
     FROM guests g
     LEFT JOIN LATERAL (
       SELECT
         COUNT(DISTINCT r.id)::int AS visit_count,
         COALESCE(SUM(r.check_out::date - r.check_in::date), 0)::int AS room_nights,
         TO_CHAR(MIN(r.check_in), 'YYYY-MM-DD') AS first_stay,
         TO_CHAR(MAX(r.check_out), 'YYYY-MM-DD') AS last_stay
       FROM reservation_guests rg
       JOIN reservations r ON rg.reservation_id = r.id
       JOIN bookings b ON r.booking_id = b.id
       WHERE rg.guest_id = g.id
         AND b.property_id = $1
         AND r.status IN ('CHECKED_IN', 'CHECKED_OUT')
     ) stats ON true
     WHERE ${whereClause}
     ORDER BY g.updated_at DESC, g.id DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params
  );

  return { guests: res.rows, total };
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
         MAX(r.check_out::date) AS last_checkout
       FROM reservation_guests rg
       JOIN reservations r ON rg.reservation_id = r.id
       JOIN bookings b ON r.booking_id = b.id
       WHERE b.property_id = $1
         AND r.status IN ('CHECKED_IN', 'CHECKED_OUT')
       GROUP BY rg.guest_id
     )
     SELECT
       COUNT(DISTINCT qs.guest_id)::int AS qualifying_guests,
       COUNT(DISTINCT CASE WHEN qs.stay_count > 1 THEN qs.guest_id END)::int AS repeat_guests,
       COUNT(DISTINCT CASE WHEN qs.last_checkout < ($2::date - INTERVAL '90 days') THEN qs.guest_id END)::int AS dormant_guests
     FROM qualifying_stays qs
     JOIN guests g ON qs.guest_id = g.id
     WHERE (g.is_archived IS NULL OR g.is_archived = FALSE)`,
    [propertyId, hotelDate]
  );

  const qualifyingCount = stayStatsRes.rows[0]?.qualifying_guests || 0;
  const repeatGuests = stayStatsRes.rows[0]?.repeat_guests || 0;
  const dormantGuests90d = stayStatsRes.rows[0]?.dormant_guests || 0;
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
         COUNT(DISTINCT r.id)::int AS visit_count
       FROM reservation_guests rg
       JOIN reservations r ON rg.reservation_id = r.id
       JOIN bookings b ON r.booking_id = b.id
       WHERE b.property_id = $1
         AND r.status IN ('CHECKED_IN', 'CHECKED_OUT')
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
       gls.visit_count
     FROM guest_last_stay gls
     JOIN guests g ON gls.guest_id = g.id
     WHERE ($2::date - gls.last_stay) >= 30
       AND (g.is_archived IS NULL OR g.is_archived = FALSE)
     ORDER BY gls.last_stay DESC
     LIMIT 20`,
    [propertyId, hotelDate]
  );

  return {
    property_id: propertyId,
    hotel_date: hotelDate,
    total_guests: totalGuests,
    guests_with_qualifying_stay: qualifyingCount,
    repeat_guests: repeatGuests,
    repeat_rate: repeatRate,
    new_guests_last_30d: newGuestsLast30d,
    dormant_guests_90d: dormantGuests90d,
    birthdays_this_month: bdayRes.rows,
    follow_up_candidates: followUpRes.rows
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
  `;

  // 1. Matching Phone Candidates
  const phoneRes = await pool.query(
    `WITH visible_guests AS (
       SELECT g.*
       FROM guests g
       WHERE ${baseFilter}
         AND g.phone IS NOT NULL
         AND TRIM(g.phone) != ''
     ),
     matched_keys AS (
       SELECT TRIM(phone) AS phone_key
       FROM visible_guests
       GROUP BY TRIM(phone)
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
     JOIN matched_keys mk ON TRIM(vg.phone) = mk.phone_key
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
     ORDER BY vg.phone ASC, vg.updated_at DESC`,
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
     ORDER BY LOWER(TRIM(vg.email)) ASC, vg.updated_at DESC`,
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
     ORDER BY LOWER(TRIM(vg.full_name)) ASC, vg.updated_at DESC`,
    [propertyId]
  );

  const clusters: DuplicateCandidateCluster[] = [];

  const phoneMap = new Map<string, GuestWithStats[]>();
  for (const row of phoneRes.rows) {
    const key = String(row.phone).trim();
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

  return {
    ...guest,
    guest_code: guest.guest_code || `GST-${String(guest.id).padStart(5, '0')}`,
    visit_count: stats.visit_count,
    room_nights: stats.room_nights,
    first_stay: stats.first_stay,
    last_stay: stats.last_stay,
    stays: staysRes.rows
  };
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

    const notes = input.notes !== undefined ? (input.notes ? String(input.notes).trim() : null) : existing.notes;
    const isArchived = input.is_archived !== undefined ? Boolean(input.is_archived) : existing.is_archived;
    const isActive = input.is_active !== undefined ? Boolean(input.is_active) : existing.is_active;

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
           is_archived = $38, is_active = $39, updated_at = NOW()
       WHERE id = $40
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
  correlationId?: string
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Invariant: Exactly 1 PRIMARY_GUEST per reservation
    if (role === 'PRIMARY_GUEST') {
      const existingPrimaryRes = await client.query(
        `SELECT id, guest_id FROM reservation_guests WHERE reservation_id = $1 AND role = 'PRIMARY_GUEST'`,
        [reservationId]
      );
      if ((existingPrimaryRes.rowCount ?? 0) > 0) {
        // Replace existing primary guest relation
        const existingId = existingPrimaryRes.rows[0].id;
        await client.query(
          `UPDATE reservation_guests
           SET guest_id = $1, relationship = $2, is_staying = $3, identity_verified = $4,
               relation_source = $5, updated_at = NOW()
           WHERE id = $6`,
          [guestId, relationship, isStaying, identityVerified, relationSource, existingId]
        );

        await writeGuestAudit(client, {
          action: 'PRIMARY_GUEST_REPLACE',
          entity: 'RESERVATION_GUEST',
          recordId: existingId,
          newValue: { reservation_id: reservationId, guest_id: guestId, role },
          propertyId,
          correlationId
        });

        await client.query('COMMIT');
        const updatedRes = await client.query('SELECT * FROM reservation_guests WHERE id = $1', [existingId]);
        return updatedRes.rows[0];
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

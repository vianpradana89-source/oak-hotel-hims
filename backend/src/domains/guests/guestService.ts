import type { Pool, PoolClient } from 'pg';
import type {
  Guest,
  GuestCreateInput,
  GuestRole,
  GuestUpdateInput,
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
    action: 'GUEST_CREATE' | 'GUEST_UPDATE' | 'RESERVATION_GUEST_ADD' | 'RESERVATION_GUEST_UPDATE' | 'RESERVATION_GUEST_REMOVE' | 'PRIMARY_GUEST_REPLACE';
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
  offset = 0
): Promise<{ guests: Guest[]; total: number }> {
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

  if (search && search.trim()) {
    const term = search.trim();
    const searchPattern = `%${term}%`;
    const countRes = await pool.query(
      `SELECT COUNT(DISTINCT g.id)::int as total
       FROM guests g
       WHERE ${baseFilter}
         AND (
           g.full_name ILIKE $2
           OR g.phone ILIKE $2
           OR g.email ILIKE $2
         )`,
      [propertyId, searchPattern]
    );
    const total = countRes.rows[0]?.total || 0;

    const res = await pool.query(
      `SELECT g.*
       FROM guests g
       WHERE ${baseFilter}
         AND (
           g.full_name ILIKE $2
           OR g.phone ILIKE $2
           OR g.email ILIKE $2
         )
       ORDER BY g.updated_at DESC, g.id DESC
       LIMIT $3 OFFSET $4`,
      [propertyId, searchPattern, safeLimit, safeOffset]
    );
    return { guests: res.rows, total };
  }

  // Without search query: list guests belonging to this property
  const countRes = await pool.query(
    `SELECT COUNT(DISTINCT g.id)::int as total
     FROM guests g
     WHERE ${baseFilter}`,
    [propertyId]
  );
  const total = countRes.rows[0]?.total || 0;

  const res = await pool.query(
    `SELECT g.*
     FROM guests g
     WHERE ${baseFilter}
     ORDER BY g.updated_at DESC, g.id DESC
     LIMIT $2 OFFSET $3`,
    [propertyId, safeLimit, safeOffset]
  );
  return { guests: res.rows, total };
}

export async function getGuestById(
  pool: Pool,
  guestId: number,
  propertyId: number
): Promise<Guest & { stays: any[] }> {
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
       r.check_in,
       r.check_out,
       r.status AS reservation_status,
       rg.role,
       rg.relationship,
       rg.is_staying,
       rg.identity_verified,
       rg.relation_source
     FROM reservation_guests rg
     JOIN reservations r ON rg.reservation_id = r.id
     JOIN bookings b ON r.booking_id = b.id
     LEFT JOIN rooms rm ON r.room_id = rm.id
     WHERE rg.guest_id = $1 AND b.property_id = $2
     ORDER BY r.check_in DESC`,
    [guestId, propertyId]
  );

  return {
    ...guest,
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
  const email = normalizeEmail(input.email);
  const address = input.address ? String(input.address).trim() || null : null;
  const city = input.city ? String(input.city).trim() || null : null;
  const province = input.province ? String(input.province).trim() || null : null;
  const country = input.country ? String(input.country).trim() || 'Indonesia' : 'Indonesia';
  const vipStatus = normalizeVipStatus(input.vip_status);
  const notes = input.notes ? String(input.notes).trim() || null : null;
  const createdBy = input.created_by ? String(input.created_by).trim() || null : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const res = await client.query(
      `INSERT INTO guests (
        full_name, preferred_name, gender, birth_place, birth_date,
        nationality, phone, email, address, city, province, country,
        vip_status, is_blacklisted, notes, created_by, created_property_id, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), NOW())
      RETURNING *`,
      [
        fullName,
        preferredName,
        gender,
        birthPlace,
        birthDate,
        nationality,
        phone,
        email,
        address,
        city,
        province,
        country,
        vipStatus,
        false,
        notes,
        createdBy,
        propertyId
      ]
    );
    const createdGuest = res.rows[0];

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

    const preferredName = input.preferred_name !== undefined ? (input.preferred_name ? String(input.preferred_name).trim() : null) : existing.preferred_name;
    const gender = input.gender !== undefined ? normalizeGender(input.gender) : existing.gender;
    const birthPlace = input.birth_place !== undefined ? (input.birth_place ? String(input.birth_place).trim() : null) : existing.birth_place;
    const birthDate = input.birth_date !== undefined ? (input.birth_date ? String(input.birth_date).trim() : null) : existing.birth_date;
    const nationality = input.nationality !== undefined ? (input.nationality ? String(input.nationality).trim() : 'ID') : existing.nationality;
    const phone = input.phone !== undefined ? normalizePhone(input.phone) : existing.phone;
    const email = input.email !== undefined ? normalizeEmail(input.email) : existing.email;
    const address = input.address !== undefined ? (input.address ? String(input.address).trim() : null) : existing.address;
    const city = input.city !== undefined ? (input.city ? String(input.city).trim() : null) : existing.city;
    const province = input.province !== undefined ? (input.province ? String(input.province).trim() : null) : existing.province;
    const country = input.country !== undefined ? (input.country ? String(input.country).trim() : 'Indonesia') : existing.country;
    const vipStatus = input.vip_status !== undefined ? normalizeVipStatus(input.vip_status) : existing.vip_status;
    const isBlacklisted = input.is_blacklisted !== undefined ? Boolean(input.is_blacklisted) : existing.is_blacklisted;
    const blacklistReason = input.blacklist_reason !== undefined ? (input.blacklist_reason ? String(input.blacklist_reason).trim() : null) : existing.blacklist_reason;
    const notes = input.notes !== undefined ? (input.notes ? String(input.notes).trim() : null) : existing.notes;

    const res = await client.query(
      `UPDATE guests
       SET full_name = $1, preferred_name = $2, gender = $3, birth_place = $4, birth_date = $5,
           nationality = $6, phone = $7, email = $8, address = $9, city = $10,
           province = $11, country = $12, vip_status = $13, is_blacklisted = $14,
           blacklist_reason = $15, notes = $16, updated_at = NOW()
       WHERE id = $17
       RETURNING *`,
      [
        fullName,
        preferredName,
        gender,
        birthPlace,
        birthDate,
        nationality,
        phone,
        email,
        address,
        city,
        province,
        country,
        vipStatus,
        isBlacklisted,
        blacklistReason,
        notes,
        guestId
      ]
    );
    const updatedGuest = res.rows[0];

    await writeGuestAudit(client, {
      action: 'GUEST_UPDATE',
      entity: 'GUEST',
      recordId: updatedGuest.id,
      newValue: updatedGuest,
      propertyId,
      correlationId
    });

    await client.query('COMMIT');
    return updatedGuest;
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
    `SELECT g.* FROM guests g
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
       g.is_blacklisted
     FROM reservation_guests rg
     JOIN guests g ON g.id = rg.guest_id
     WHERE rg.reservation_id = $1
     ORDER BY
       CASE rg.role
         WHEN 'PRIMARY_GUEST' THEN 1
         WHEN 'BOOKER' THEN 2
         ELSE 3
       END,
       rg.id ASC`,
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

  const role = normalizeRole(input.role);
  const relationship = input.relationship ? String(input.relationship).trim() || null : null;
  const isStaying = input.is_staying !== undefined ? Boolean(input.is_staying) : true;
  const identityVerified = input.identity_verified !== undefined ? Boolean(input.identity_verified) : false;
  const relationSource = input.relation_source ? String(input.relation_source).trim() || 'MANUAL_ENTRY' : 'MANUAL_ENTRY';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ensure guest exists
    const guestRes = await client.query('SELECT * FROM guests WHERE id = $1', [guestId]);
    if ((guestRes.rowCount ?? 0) === 0) {
      throw httpError(404, 'GUEST_NOT_FOUND', `guest ${guestId} not found`);
    }

    // Check duplicate same reservation_id + guest_id + role
    const dupCheck = await client.query(
      'SELECT id FROM reservation_guests WHERE reservation_id = $1 AND guest_id = $2 AND role = $3',
      [reservationId, guestId, role]
    );
    if ((dupCheck.rowCount ?? 0) > 0) {
      throw httpError(409, 'DUPLICATE_RELATION', `guest ${guestId} already has role ${role} for reservation ${reservationId}`);
    }

    // Check primary guest invariant
    if (role === 'PRIMARY_GUEST') {
      const primaryCheck = await client.query(
        'SELECT id, guest_id FROM reservation_guests WHERE reservation_id = $1 AND role = $2',
        [reservationId, 'PRIMARY_GUEST']
      );
      if ((primaryCheck.rowCount ?? 0) > 0) {
        throw httpError(409, 'PRIMARY_GUEST_CONFLICT', `reservation ${reservationId} already has a PRIMARY_GUEST (id: ${primaryCheck.rows[0].guest_id})`);
      }
    }

    const res = await client.query(
      `INSERT INTO reservation_guests (
        reservation_id, guest_id, role, relationship, is_staying,
        identity_verified, relation_source, is_legacy_inferred,
        created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, false, NOW(), NOW())
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
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      if (err.constraint === 'idx_reservation_single_primary_guest') {
        throw httpError(409, 'PRIMARY_GUEST_CONFLICT', `reservation ${reservationId} already has a PRIMARY_GUEST`);
      }
      if (err.constraint === 'idx_reservation_guest_role') {
        throw httpError(409, 'DUPLICATE_RELATION', `guest ${guestId} already has role ${role} for reservation ${reservationId}`);
      }
    }
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
      'SELECT * FROM reservation_guests WHERE id = $1 AND reservation_id = $2 FOR UPDATE',
      [relationId, reservationId]
    );
    if ((existingRes.rowCount ?? 0) === 0) {
      throw httpError(404, 'RELATION_NOT_FOUND', `reservation_guest relation ${relationId} not found for reservation ${reservationId}`);
    }
    const existing = existingRes.rows[0];

    const role = input.role !== undefined ? normalizeRole(input.role) : existing.role;
    const relationship = input.relationship !== undefined ? (input.relationship ? String(input.relationship).trim() : null) : existing.relationship;
    const isStaying = input.is_staying !== undefined ? Boolean(input.is_staying) : existing.is_staying;
    const identityVerified = input.identity_verified !== undefined ? Boolean(input.identity_verified) : existing.identity_verified;

    // If changing role to PRIMARY_GUEST, check for existing primary guest
    if (role === 'PRIMARY_GUEST' && existing.role !== 'PRIMARY_GUEST') {
      const primaryCheck = await client.query(
        'SELECT id FROM reservation_guests WHERE reservation_id = $1 AND role = $2 AND id != $3',
        [reservationId, 'PRIMARY_GUEST', relationId]
      );
      if ((primaryCheck.rowCount ?? 0) > 0) {
        throw httpError(409, 'PRIMARY_GUEST_CONFLICT', `reservation ${reservationId} already has a PRIMARY_GUEST`);
      }
    }

    const res = await client.query(
      `UPDATE reservation_guests
       SET role = $1, relationship = $2, is_staying = $3, identity_verified = $4, updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [role, relationship, isStaying, identityVerified, relationId]
    );
    const updatedRelation = res.rows[0];

    const auditAction = (existing.role !== 'PRIMARY_GUEST' && role === 'PRIMARY_GUEST')
      ? 'PRIMARY_GUEST_REPLACE'
      : 'RESERVATION_GUEST_UPDATE';

    await writeGuestAudit(client, {
      action: auditAction as any,
      entity: 'RESERVATION_GUEST',
      recordId: updatedRelation.id,
      newValue: updatedRelation,
      propertyId,
      correlationId
    });

    await client.query('COMMIT');
    return updatedRelation;
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      if (err.constraint === 'idx_reservation_single_primary_guest') {
        throw httpError(409, 'PRIMARY_GUEST_CONFLICT', `reservation ${reservationId} already has a PRIMARY_GUEST`);
      }
      if (err.constraint === 'idx_reservation_guest_role') {
        throw httpError(409, 'DUPLICATE_RELATION', 'duplicate relation for this reservation and guest role');
      }
    }
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
      'SELECT * FROM reservation_guests WHERE id = $1 AND reservation_id = $2 FOR UPDATE',
      [relationId, reservationId]
    );
    if ((existingRes.rowCount ?? 0) === 0) {
      throw httpError(404, 'RELATION_NOT_FOUND', `reservation_guest relation ${relationId} not found for reservation ${reservationId}`);
    }
    const existing = existingRes.rows[0];

    await client.query('DELETE FROM reservation_guests WHERE id = $1', [relationId]);

    await writeGuestAudit(client, {
      action: 'RESERVATION_GUEST_REMOVE',
      entity: 'RESERVATION_GUEST',
      recordId: relationId,
      newValue: { deleted_record: existing },
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

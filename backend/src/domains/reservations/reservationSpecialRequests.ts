import type { Pool, PoolClient } from 'pg';

export const SPECIAL_REQUESTS_STATUS_LOCKED = 'SPECIAL_REQUESTS_STATUS_LOCKED';
export const SPECIAL_REQUESTS_AUDIT_ACTION = 'RESERVATION_SPECIAL_REQUESTS_UPDATED';

export class ReservationSpecialRequestsError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'ReservationSpecialRequestsError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function normalizeSpecialRequests(value: unknown): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

export function canEditReservationSpecialRequests(status: unknown): boolean {
  const value = String(status || '').toUpperCase();
  return value === 'BOOKED' || value === 'CHECKED_IN';
}

export async function updateReservationSpecialRequests(
  db: Pool | PoolClient,
  input: {
    reservationId: number;
    propertyId: number;
    specialRequests: unknown;
    actor?: string | null;
    correlationId?: string | null;
  }
): Promise<{ unchanged: boolean; reservation: any }> {
  if (!Number.isInteger(input.reservationId) || input.reservationId <= 0) {
    throw new ReservationSpecialRequestsError(400, 'VALIDATION_ERROR', 'ID reservasi tidak valid.');
  }
  if (!Number.isInteger(input.propertyId) || input.propertyId <= 0) {
    throw new ReservationSpecialRequestsError(400, 'VALIDATION_ERROR', 'property_id is required and must be a positive integer');
  }

  const nextValue = normalizeSpecialRequests(input.specialRequests);
  const current = await db.query(
    `SELECT id, status, special_requests, booking_id
     FROM reservations
     WHERE id = $1
     FOR UPDATE`,
    [input.reservationId]
  );
  if (!current.rowCount) {
    throw new ReservationSpecialRequestsError(404, 'NOT_FOUND', `reservation ${input.reservationId} not found`);
  }

  const row = current.rows[0];
  const bookingRes = await db.query('SELECT property_id FROM bookings WHERE id = $1', [row.booking_id]);
  const reservationPropertyId = bookingRes.rows[0]?.property_id ?? null;
  if (reservationPropertyId == null || Number(reservationPropertyId) !== Number(input.propertyId)) {
    throw new ReservationSpecialRequestsError(
      403,
      'PROPERTY_MISMATCH',
      `reservation ${input.reservationId} does not belong to property ${input.propertyId}`
    );
  }
  if (!canEditReservationSpecialRequests(row.status)) {
    throw new ReservationSpecialRequestsError(
      409,
      SPECIAL_REQUESTS_STATUS_LOCKED,
      'Catatan tidak dapat diubah pada status reservasi ini.'
    );
  }

  const before = row.special_requests == null ? null : String(row.special_requests);
  if (before === nextValue) {
    const unchanged = await loadReservationContextRow(db, input.reservationId);
    return { unchanged: true, reservation: unchanged };
  }

  await db.query(
    `UPDATE reservations
     SET special_requests = $1
     WHERE id = $2`,
    [nextValue, input.reservationId]
  );

  await db.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'PMS',
      SPECIAL_REQUESTS_AUDIT_ACTION,
      'RESERVATION',
      input.reservationId,
      JSON.stringify({
        reservation_id: input.reservationId,
        property_id: input.propertyId,
        before,
        after: nextValue,
        actor: input.actor || 'PMS',
      }),
      input.correlationId || null,
      input.propertyId,
    ]
  );

  const reservation = await loadReservationContextRow(db, input.reservationId);
  return { unchanged: false, reservation };
}

async function loadReservationContextRow(db: Pool | PoolClient, reservationId: number): Promise<any> {
  const result = await db.query(
    `SELECT
       r.*,
       b.bid,
       b.booking_source,
       COALESCE(b.booking_channel, r.booking_channel) AS booking_channel,
       b.property_id AS booking_property_id,
       ota.name AS ota_source_name
     FROM reservations r
     LEFT JOIN bookings b ON b.id = r.booking_id
     LEFT JOIN ota_sources ota ON ota.id = r.ota_source_id
     WHERE r.id = $1`,
    [reservationId]
  );
  return result.rows[0] || null;
}

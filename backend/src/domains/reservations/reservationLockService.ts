import type { PoolClient } from 'pg';

/**
 * lockReservationFinancialState - Canonical parent lock for financial writers.
 *
 * CONTRACT:
 *   - Caller MUST have already issued BEGIN (this helper does NOT begin).
 *   - Accepts PoolClient only (never Pool) to enforce transaction ownership.
 *   - Acquires SELECT ... FOR UPDATE OF r on the reservations row.
 *   - Validates property ownership via the authoritative booking relation.
 *   - Returns the locked reservation row.
 *
 * DOES NOT:
 *   - Issue BEGIN / COMMIT / ROLLBACK
 *   - Use advisory locks
 *   - Mutate any rows
 */
export interface LockedReservation {
  id: number;
  booking_id: number | null;
  room_id: number | null;
  status: string;
  total_price: number;
  amount_paid: number;
  applied_deposit: number;
  remaining_balance: number;
  payment_status: string;
  booking_property_id: number | null;
}

export async function lockReservationFinancialState(
  client: PoolClient,
  reservationId: number,
  propertyId: number
): Promise<LockedReservation> {
  const res = await client.query(
    `SELECT
       r.id,
       r.booking_id,
       r.room_id,
       r.status,
       r.total_price,
       r.amount_paid,
       r.applied_deposit,
       r.remaining_balance,
       r.payment_status,
       b.property_id AS booking_property_id
     FROM reservations r
     LEFT JOIN bookings b ON b.id = r.booking_id
     WHERE r.id = $1
     FOR UPDATE OF r`,
    [reservationId]
  );

  if (res.rowCount === 0) {
    const err: any = new Error(`Reservation ${reservationId} not found`);
    err.statusCode = 404;
    err.code = 'RESERVATION_NOT_FOUND';
    throw err;
  }

  const row = res.rows[0];
  const bookingPropertyId = row.booking_property_id;

  // Authoritative property ownership check via booking relation
  if (bookingPropertyId === null || bookingPropertyId === undefined) {
    const err: any = new Error('Reservation lacks authoritative booking property ownership');
    err.statusCode = 422;
    err.code = 'RESERVATION_INTEGRITY_ERROR';
    throw err;
  }

  if (Number(bookingPropertyId) !== propertyId) {
    const err: any = new Error('Reservation belongs to a different property');
    err.statusCode = 403;
    err.code = 'CROSS_PROPERTY_RESERVATION';
    throw err;
  }

  return row as LockedReservation;
}

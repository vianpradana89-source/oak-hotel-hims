import { Pool } from 'pg';
import {
  assembleBookingSalesDetail,
  type BookingSalesDetail,
} from './bookingSalesDetail';
import { isPlatformSuperAdmin } from '../auth/authService';

function httpError(statusCode: number, message: string, code: string): Error {
  const err: any = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

export async function resolveSalesReadPropertyScope(params: {
  pool: Pool;
  userId: number;
  tokenPropertyId: unknown;
  requestedPropertyId: unknown;
}): Promise<{ propertyId: number; isSuperAdmin: boolean }> {
  const requested = Number(params.requestedPropertyId);
  if (!Number.isInteger(requested) || requested <= 0) {
    throw httpError(400, 'property_id is required', 'INVALID_PROPERTY_ID');
  }

  const isSuperAdmin = await isPlatformSuperAdmin(params.pool, params.userId);
  const tokenPropertyId = Number(params.tokenPropertyId);
  if (!isSuperAdmin) {
    if (!Number.isInteger(tokenPropertyId) || tokenPropertyId <= 0) {
      throw httpError(403, 'Akses ditolak: akun tidak terkait properti yang valid.', 'PROPERTY_SCOPE_REQUIRED');
    }
    if (tokenPropertyId !== requested) {
      throw httpError(403, 'Akses ditolak. Anda tidak memiliki izin untuk melihat penjualan dari properti lain.', 'FORBIDDEN');
    }
  }

  return { propertyId: requested, isSuperAdmin };
}

export async function getBookingSalesDetail(
  pool: Pool,
  propertyId: number,
  bookingRef: string
): Promise<BookingSalesDetail> {
  const ref = String(bookingRef || '').trim();
  if (!ref) {
    throw httpError(400, 'bookingId tidak valid', 'VALIDATION_ERROR');
  }

  const numericId = Number(ref);
  const bookingRes = await pool.query(
    `SELECT
       b.id,
       b.bid,
       b.property_id,
       b.guest_name_snapshot,
       b.booker_name,
       b.booking_source,
       b.channel,
       b.booking_channel,
       b.booking_status
     FROM bookings b
     WHERE b.property_id = $1
       AND (
         b.bid = $2
         OR ($3::bigint IS NOT NULL AND b.id = $3)
       )
     LIMIT 1`,
    [
      propertyId,
      ref,
      Number.isInteger(numericId) && numericId > 0 ? numericId : null,
    ]
  );

  if ((bookingRes.rowCount ?? 0) === 0) {
    throw httpError(404, 'Booking tidak ditemukan pada properti ini', 'BOOKING_NOT_FOUND');
  }

  const booking = bookingRes.rows[0];
  const bookingId = Number(booking.id);

  const reservationRes = await pool.query(
    `SELECT
       r.id,
       r.room_id,
       r.stay_sequence,
       r.stay_type,
       r.check_in::text AS check_in,
       r.check_out::text AS check_out,
       r.status,
       r.stay_status,
       r.amount_paid,
       r.remaining_balance,
       r.booked_room_type_name_snapshot,
       rm.room_number,
       COALESCE(rt_current.name, rt_booked.name, r.booked_room_type_name_snapshot) AS room_type_name
     FROM reservations r
     LEFT JOIN rooms rm ON rm.id = r.room_id AND rm.property_id = $1
     LEFT JOIN room_types rt_current ON rt_current.id = rm.room_type_id AND rt_current.property_id = $1
     LEFT JOIN room_types rt_booked ON rt_booked.id = r.booked_room_type_id_snapshot AND rt_booked.property_id = $1
     WHERE r.booking_id = $2
     ORDER BY r.stay_sequence ASC NULLS LAST, r.id ASC`,
    [propertyId, bookingId]
  );

  const saleRes = await pool.query(
    `SELECT
       t.id,
       t.property_id,
       t.transaction_type,
       t.source_type,
       t.source_id,
       t.amount,
       t.discount_amount,
       t.net_amount,
       t.payment_status,
       t.transaction_status,
       t.reservation_id,
       t.booking_id,
       t.reversal_of_transaction_id,
       t.correction_group_id,
       t.deleted_at,
       t.metadata,
       COALESCE(pmt.total_paid, 0) AS paid_amount
     FROM transactions t
     LEFT JOIN LATERAL (
       SELECT SUM(pt.amount)::bigint AS total_paid
       FROM payment_transactions pt
       WHERE pt.transaction_id = t.id
         AND pt.status = 'SUCCESS'
         AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
     ) pmt ON TRUE
     WHERE t.property_id = $1
       AND t.deleted_at IS NULL
       AND t.transaction_type = 'SALE'
       AND (
         t.booking_id = $2
         OR t.reservation_id IN (SELECT r.id FROM reservations r WHERE r.booking_id = $2)
       )
     ORDER BY t.id ASC`,
    [propertyId, bookingId]
  );

  const paymentRes = await pool.query(
    `SELECT
       pt.id,
       pt.reservation_id,
       pt.transaction_id,
       pt.payment_method,
       pt.amount,
       pt.status,
       pt.created_at,
       pt.reference_code,
       pe.original_filename AS evidence_filename,
       pe.storage_key AS evidence_storage_key
     FROM payment_transactions pt
     LEFT JOIN LATERAL (
       SELECT original_filename, storage_key
       FROM payment_evidences
       WHERE payment_transaction_id = pt.id
         AND is_active = TRUE
         AND property_id = $1
       ORDER BY uploaded_at DESC NULLS LAST, id DESC
       LIMIT 1
     ) pe ON TRUE
     WHERE (
       pt.reservation_id IN (SELECT r.id FROM reservations r WHERE r.booking_id = $2)
       OR pt.transaction_id IN (
         SELECT t.id FROM transactions t
         WHERE t.property_id = $1
           AND t.transaction_type = 'SALE'
           AND t.deleted_at IS NULL
           AND (
             t.booking_id = $2
             OR t.reservation_id IN (SELECT r.id FROM reservations r WHERE r.booking_id = $2)
           )
       )
     )
     ORDER BY pt.created_at ASC, pt.id ASC`,
    [propertyId, bookingId]
  );

  return assembleBookingSalesDetail({
    booking,
    reservations: reservationRes.rows,
    sales: saleRes.rows,
    payments: paymentRes.rows,
  });
}

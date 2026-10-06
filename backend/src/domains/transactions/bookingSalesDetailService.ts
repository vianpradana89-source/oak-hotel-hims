import { Pool } from 'pg';
import {
  assembleBookingSalesDetail,
  type BookingSalesDetail,
} from './bookingSalesDetail';
import {
  calculateHotelCollectibleBalance,
} from '../stayCharges/stayChargesService';
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
        b.booking_status,
        b.ota_source_id,
        b.payment_responsibility,
        ota.name AS ota_source_name
     FROM bookings b
     LEFT JOIN ota_sources ota
       ON ota.id = b.ota_source_id
      AND ota.property_id = b.property_id
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
        SELECT CASE
          WHEN UPPER(COALESCE(t.source_type, '')) IN ('POS_ORDER', 'POS') THEN
            COALESCE(
              (SELECT SUM(a.amount)::numeric
               FROM payment_transactions a
               WHERE a.transaction_id = t.id
                 AND a.status = 'SUCCESS'
                 AND a.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')), 0
            ) + COALESCE(
              (SELECT SUM(b2.amount)::numeric
               FROM pos_settlements b2
               WHERE b2.transaction_id = t.id
                 AND b2.property_id = t.property_id
                 AND b2.pos_order_id::text = t.source_id
                 AND b2.status = 'SUCCESS'), 0
            )
          ELSE
            COALESCE(
              (SELECT SUM(a.amount)::numeric
               FROM payment_transactions a
               WHERE a.transaction_id = t.id
                 AND a.status = 'SUCCESS'
                 AND a.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')), 0
            )
        END AS total_paid
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

  // Build per-reservation canonical financials via calculateHotelCollectibleBalance.
  // This is the authoritative source for paid/remaining for each reservation child.
  const reservationFinancials = new Map<number, Awaited<ReturnType<typeof calculateHotelCollectibleBalance>>>();
  const paymentResponsibility = String(booking.payment_responsibility || 'HOTEL_COLLECT').trim().toUpperCase();
  for (const resRow of reservationRes.rows) {
    const rid = Number(resRow.id);
    const canonical = await calculateHotelCollectibleBalance(
      pool,
      rid,
      propertyId,
      paymentResponsibility
    );
    reservationFinancials.set(rid, canonical);
  }

  const paymentRes = await pool.query(
    `SELECT
        pa.id AS allocation_id,
        pa.reservation_id AS pa_reservation_id,
        pt.id AS payment_id,
        pt.transaction_id,
        pt.transaction_type,
        pt.payment_method,
        pt.amount AS parent_amount,
        pa.allocated_amount,
        pt.status AS payment_status,
        pa.status AS allocation_status,
        pt.created_at,
        pt.reference_code,
        pt.scope,
        pe.original_filename AS evidence_filename,
        pe.storage_key AS evidence_storage_key
      FROM payment_allocations pa
      JOIN payment_transactions pt
        ON pt.id = pa.payment_transaction_id
        AND pt.scope = 'BOOKING_GROUP'
      LEFT JOIN LATERAL (
        SELECT original_filename, storage_key
        FROM payment_evidences
        WHERE payment_transaction_id = pt.id
          AND is_active = TRUE
          AND property_id = $1
        ORDER BY uploaded_at DESC NULLS LAST, id DESC
        LIMIT 1
      ) pe ON TRUE
      WHERE pa.property_id = $1
        AND pa.booking_id = $2
        AND pa.status = 'ACTIVE'
        AND pa.reservation_id IN (SELECT r.id FROM reservations r WHERE r.booking_id = $2)
        AND pt.status = 'SUCCESS'
        AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
      UNION ALL
      SELECT
        NULL::bigint AS allocation_id,
        pt.reservation_id::bigint AS pa_reservation_id,
        pt.id AS payment_id,
        pt.transaction_id,
        pt.transaction_type,
        pt.payment_method,
        pt.amount AS parent_amount,
        NULL::bigint AS allocated_amount,
        pt.status AS payment_status,
        NULL::text AS allocation_status,
        pt.created_at,
        pt.reference_code,
        pt.scope,
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
      WHERE pt.scope = 'ROOM_RESERVATION'
        AND pt.reservation_id IN (SELECT r.id FROM reservations r WHERE r.booking_id = $2)
        AND (pt.property_id = $1 OR pt.property_id IS NULL)
        AND pt.status = 'SUCCESS'
        AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
      ORDER BY created_at ASC, payment_id ASC`,
    [propertyId, bookingId]
  );

  return assembleBookingSalesDetail({
    booking,
    reservations: reservationRes.rows,
    sales: saleRes.rows,
    payments: paymentRes.rows,
    reservationFinancials,
  });
}

/**
 * documentReservationReadService.ts
 *
 * Read-only service for the Document & Print domain.
 * Provides minimum canonical fields for:
 *   - reservation picker list
 *   - quotation / confirmation print
 *
 * NO mutations. NO SSE. NO sensitive columns (ktp_path, bukti_bayar_path,
 * identity/OCR, audit, readiness, checkout_inspection, housekeeping).
 *
 * Property isolation: every query anchors on bookings.property_id (= request
 * propertyId). A mismatched reservation_id across properties is reported as
 * 404 (does not confirm existence on the caller's property).
 */

import type { Pool, PoolClient } from 'pg';

/** ------------------------------------------------------------------ */
/*  List contract                                                       */
/*  Fields only: identity + minimal stay + room + price + status        */
/* ------------------------------------------------------------------ */
export interface DocumentReservationListItem {
  id: number;
  bid: string | null;
  guest_name: string;
  booker_name: string | null;
  check_in: string;
  check_out: string;
  room_type_name: string | null;
  room_type: string | null;
  room_number: string | null;
  status: string;
  total_price: number | null;
}

export interface DocumentReservationListResult {
  status: string;
  data: DocumentReservationListItem[];
}

/** ------------------------------------------------------------------ */
/*  Detail contract                                                     */
/*  All fields used by ReservationConfirmationPrint / QuotationDraft    */
/* ------------------------------------------------------------------ */
export interface DocumentNightlyRateItem {
  stay_date: string;
  hotel_date: string;
  total_amount: number | null;
  final_room_rate: number | null;
  final_rate: number | null;
  base_rate: number | null;
  note: string | null;
  notes: string | null;
}

export interface DocumentRateSnapshot {
  reservation_id: number;
  nightly_rates: DocumentNightlyRateItem[] | null;
}

export interface DocumentReservationDetail {
  // Identity
  id: number;
  bid: string | null;
  legacy_booking_number: string | null;

  // Guest
  guest_name: string;
  guest_phone: string | null;
  guest_email: string | null;
  guest_address: string | null;

  // Booker
  booker_name: string | null;
  booker_phone: string | null;
  booker_email: string | null;

  contact_person: string | null;

  // Stay
  check_in: string;
  check_out: string;

  // Room
  room_type_name: string | null;
  room_type: string | null;
  room_number: string | null;

  // Guests count
  guest_count: number | null;
  pax: number | null;

  // Booking metadata
  booking_source: string | null;
  booking_channel: string | null;

  // Special notes
  special_requests: string | null;
  notes: string | null;

  // Financial (pre-verified, canonical columns)
  total_price: number | null;
  amount_paid: number | null;
  remaining_balance: number | null;
  payment_status: string | null;

  // Rate snapshot for quotation line items
  rate_snapshot: DocumentRateSnapshot | null;
}

export interface DocumentReservationDetailResult {
  status: string;
  data: DocumentReservationDetail;
}

/** ------------------------------------------------------------------ */
/*  Internal helpers                                                    */
/* ------------------------------------------------------------------ */

function pickListItem(row: any): DocumentReservationListItem {
  return {
    id: Number(row.id),
    bid: row.bid ? String(row.bid) : null,
    guest_name: row.guest_name || '',
    booker_name: row.booker_name ? String(row.booker_name) : null,
    check_in: row.check_in ? String(row.check_in).split('T')[0] : '',
    check_out: row.check_out ? String(row.check_out).split('T')[0] : '',
    room_type_name: row.room_type_name ? String(row.room_type_name) : null,
    room_type: row.room_type ? String(row.room_type) : null,
    room_number: row.room_number != null ? String(row.room_number) : null,
    status: row.status || '',
    total_price: row.total_price != null ? Number(row.total_price) : null,
  };
}

function pickDetail(
  row: any,
  nightlyRates: DocumentNightlyRateItem[]
): DocumentReservationDetail {
  return {
    id: Number(row.id),
    bid: row.bid ? String(row.bid) : null,
    legacy_booking_number: row.legacy_booking_number
      ? String(row.legacy_booking_number)
      : null,

    guest_name: row.guest_name || '',
    guest_phone: row.guest_phone ? String(row.guest_phone) : null,
    guest_email: row.guest_email ? String(row.guest_email) : null,
    guest_address: row.guest_address ? String(row.guest_address) : null,

    booker_name: row.booker_name ? String(row.booker_name) : null,
    booker_phone: row.booker_phone ? String(row.booker_phone) : null,
    booker_email: row.booker_email ? String(row.booker_email) : null,

    contact_person: row.contact_person ? String(row.contact_person) : null,

    check_in: row.check_in ? String(row.check_in).split('T')[0] : '',
    check_out: row.check_out ? String(row.check_out).split('T')[0] : '',

    room_type_name: row.room_type_name ? String(row.room_type_name) : null,
    room_type: row.room_type ? String(row.room_type) : null,
    room_number: row.room_number != null ? String(row.room_number) : null,

    guest_count: row.guest_count != null ? Number(row.guest_count) : null,
    pax: row.pax != null ? Number(row.pax) : null,

    booking_source: row.booking_source ? String(row.booking_source) : null,
    booking_channel: row.booking_channel
      ? String(row.booking_channel)
      : null,

    special_requests: row.special_requests
      ? String(row.special_requests)
      : null,
    notes: row.notes ? String(row.notes) : null,

    total_price: row.total_price != null ? Number(row.total_price) : null,
    amount_paid: row.amount_paid != null ? Number(row.amount_paid) : null,
    remaining_balance: row.remaining_balance != null
      ? Number(row.remaining_balance)
      : null,
    payment_status: row.payment_status ? String(row.payment_status) : null,

    rate_snapshot:
      nightlyRates.length > 0
        ? { reservation_id: Number(row.id), nightly_rates: nightlyRates }
        : null,
  };
}

/** ------------------------------------------------------------------ */
/*  Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Fetches document-picker list scoped to `propertyId`.
 *
 * Property isolation is enforced via the bookings table: only reservations
 * whose booking belongs to the requested property are returned. No
 * cross-property leakage is possible.
 */
export async function getDocumentReservationList(
  db: Pool | PoolClient,
  propertyId: number,
  search?: string,
): Promise<DocumentReservationListResult> {
  const params: any[] = [propertyId];

  let baseQuery: string;
  let orderClause: string;
  let limitClause: string = '';

  if (search) {
    // SEARCH MODE: global property-scoped search across all statuses.
    // No CHECKED_OUT filter; no LIMIT.
    const needle = `%${search}%`;
    baseQuery = `
      SELECT
        r.id,
        b.bid,
        r.guest_name,
        COALESCE(r.booker_name, b.booker_name) AS booker_name,
        TO_CHAR(r.check_in, 'YYYY-MM-DD') AS check_in,
        TO_CHAR(r.check_out, 'YYYY-MM-DD') AS check_out,
        COALESCE(r.booked_room_type_name_snapshot, rt.name) AS room_type_name,
        COALESCE(r.booked_room_type_code_snapshot, rt.code) AS room_type,
        rm.room_number,
        r.status,
        r.total_price
      FROM reservations r
      INNER JOIN bookings b ON b.id = r.booking_id
      LEFT JOIN rooms rm ON rm.id = r.room_id
        AND rm.property_id = b.property_id
      LEFT JOIN room_types rt ON rt.id = rm.room_type_id
        AND rt.property_id = b.property_id
      WHERE b.property_id = $1
        AND (
          LOWER(CAST(b.bid AS TEXT)) LIKE LOWER($2)
          OR LOWER(r.guest_name) LIKE LOWER($2)
          OR LOWER(COALESCE(r.booker_name, b.booker_name)) LIKE LOWER($2)
          OR LOWER(CAST(r.id AS TEXT)) LIKE LOWER($2)
          OR LOWER(CAST(rm.room_number AS TEXT)) LIKE LOWER($2)
        )
    `;
    params.push(needle);
    orderClause = ' ORDER BY r.check_out DESC NULLS LAST, r.id DESC';
  } else {
    // DEFAULT MODE: recent checkouts only, newest first, capped at 20.
    baseQuery = `
      SELECT
        r.id,
        b.bid,
        r.guest_name,
        COALESCE(r.booker_name, b.booker_name) AS booker_name,
        TO_CHAR(r.check_in, 'YYYY-MM-DD') AS check_in,
        TO_CHAR(r.check_out, 'YYYY-MM-DD') AS check_out,
        COALESCE(r.booked_room_type_name_snapshot, rt.name) AS room_type_name,
        COALESCE(r.booked_room_type_code_snapshot, rt.code) AS room_type,
        rm.room_number,
        r.status,
        r.total_price
      FROM reservations r
      INNER JOIN bookings b ON b.id = r.booking_id
      LEFT JOIN rooms rm ON rm.id = r.room_id
        AND rm.property_id = b.property_id
      LEFT JOIN room_types rt ON rt.id = rm.room_type_id
        AND rt.property_id = b.property_id
      WHERE b.property_id = $1
        AND UPPER(r.status) = 'CHECKED_OUT'
        AND r.check_out::date <= CURRENT_DATE
    `;
    orderClause = ' ORDER BY r.check_out DESC, r.id DESC';
    limitClause = ' LIMIT 20';
  }

  const result = await db.query(baseQuery + orderClause + limitClause, params);
  const data = (result.rows || []).map(pickListItem);
  return { status: 'OK', data };
}

/**
 * Fetches document-rendering detail for a single reservation.
 *
 * Property isolation:
 *   1. The outer query verifies b.property_id = requested propertyId.
 *   2. The nightly_rates subquery filters by both reservation_id AND
 *      property_id (via reservation_nightly_rates.property_id FK).
 *
 * If the reservation exists on a DIFFERENT property, the outer join
 * returns zero rows and we respond 404 - without confirming existence on
 * any other property. This prevents enumeration side-channels.
 */
export async function getDocumentReservationDetail(
  db: Pool | PoolClient,
  propertyId: number,
  reservationId: number,
): Promise<DocumentReservationDetailResult> {
  const res = await db.query(
    `
    SELECT
      r.id,
      b.bid,
      COALESCE(r.booking_number, b.legacy_booking_number) AS legacy_booking_number,

      r.guest_name,
      r.guest_phone,

      pg.email AS guest_email,
      pg.address AS guest_address,

      COALESCE(r.booker_name, b.booker_name) AS booker_name,
      COALESCE(r.booker_phone, b.booker_phone) AS booker_phone,
      bg.email AS booker_email,

      COALESCE(r.booker_name, b.booker_name, r.guest_name) AS contact_person,

      TO_CHAR(r.check_in, 'YYYY-MM-DD') AS check_in,
      TO_CHAR(r.check_out, 'YYYY-MM-DD') AS check_out,

      COALESCE(r.booked_room_type_name_snapshot, rt.name) AS room_type_name,
      COALESCE(r.booked_room_type_code_snapshot, rt.code) AS room_type,
      rm.room_number,

      gc.staying_count AS guest_count,
      gc.staying_count AS pax,

      b.booking_source,
      COALESCE(b.booking_channel, b.channel, r.booking_channel) AS booking_channel,

      r.special_requests,
      NULL::text AS notes,

      r.total_price,
      r.amount_paid,
      r.remaining_balance,
      r.payment_status

    FROM reservations r
    INNER JOIN bookings b ON b.id = r.booking_id
      AND b.property_id = $2
    LEFT JOIN rooms rm ON rm.id = r.room_id
      AND rm.property_id = b.property_id
    LEFT JOIN room_types rt ON rt.id = rm.room_type_id
      AND rt.property_id = b.property_id
    LEFT JOIN LATERAL (
      SELECT
        g.email,
        g.address
      FROM reservation_guests rg
      JOIN guests g ON g.id = rg.guest_id
      WHERE rg.reservation_id = r.id
        AND rg.role = 'PRIMARY_GUEST'
      ORDER BY rg.id ASC
      LIMIT 1
    ) pg ON TRUE
    LEFT JOIN LATERAL (
      SELECT g.email
      FROM reservation_guests rg
      JOIN guests g ON g.id = rg.guest_id
      WHERE rg.reservation_id = r.id
        AND rg.role = 'BOOKER'
      ORDER BY rg.id ASC
      LIMIT 1
    ) bg ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS staying_count
      FROM reservation_guests rg
      WHERE rg.reservation_id = r.id
        AND rg.is_staying = TRUE
    ) gc ON TRUE

    WHERE r.id = $1
    LIMIT 1
    `,
    [reservationId, propertyId]
  );

  if ((res.rowCount ?? 0) === 0) {
    return {
      status: 'ERROR',
      code: 'RESERVATION_NOT_FOUND',
      message: `Reservasi ${reservationId} tidak ditemukan atau bukan milik properti ini.`,
    } as any;
  }

  // Nightly rates (sub-select scoped to property for isolation)
  const ratesRes = await db.query(
    `
    SELECT
      TO_CHAR(rnr.stay_date, 'YYYY-MM-DD') AS stay_date,
      TO_CHAR(rnr.stay_date, 'YYYY-MM-DD') AS hotel_date,
      rnr.total_amount,
      rnr.final_room_rate,
      rnr.base_rate,
      NULL::bigint AS final_rate,
      NULL::text AS note,
      NULL::text AS notes
    FROM reservation_nightly_rates rnr
    WHERE rnr.reservation_id = $1
      AND rnr.property_id = $2
    ORDER BY rnr.stay_date ASC
    `,
    [reservationId, propertyId]
  );

  const nightlyRates: DocumentNightlyRateItem[] = (ratesRes.rows || []).map(
    (r: any) => ({
      stay_date: r.stay_date || '',
      hotel_date: r.hotel_date || '',
      total_amount: r.total_amount != null ? Number(r.total_amount) : null,
      final_room_rate:
        r.final_room_rate != null ? Number(r.final_room_rate) : null,
      final_rate: null,
      base_rate: r.base_rate != null ? Number(r.base_rate) : null,
      note: null,
      notes: null,
    })
  );

  const data = pickDetail(res.rows[0], nightlyRates);
  return { status: 'OK', data };
}

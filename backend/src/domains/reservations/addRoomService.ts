import { Pool, PoolClient } from 'pg';
import { lockCanonicalAvailabilityRows, mutateCanonicalAvailabilityRow, canonicalAvailabilityKey as availKey } from '../inventory/canonicalAvailability';
import { calculatePriceQuote, createReservationRateSnapshots } from '../pricing/pricingService';
import { normalizeHotelDate, addHotelDays, enumerateHotelDates, hotelDateKey } from '../../utils/hotelDate';
import type { PriceQuoteResult } from '../../domains/pricing/pricingTypes';
import { getEffectivePaymentStateForReservation } from '../payments/paymentAllocationService';
import { recalculateReservationFinancials } from '../stayCharges/stayChargesService';
import { normalizeDigitsOnly, syncPrimaryGuestFromReservation } from '../guests/guestService';

// ─────────────────────────────────────────────────────────────────────────────
// Local helpers (mirrored from index.ts to avoid circular imports)
// ─────────────────────────────────────────────────────────────────────────────

const hasRows = (result: any): boolean => Number(result?.rowCount ?? 0) > 0;

function isRoomStatusSellable(statusValue: any): boolean {
  const s = String(statusValue || '').toUpperCase();
  return s === 'VACANT_CLEAN' || s === 'READY' || s === 'VACANT';
}

function generateBookingNumber(client: any, source: string = 'WALKIN'): string {
  const normalized = source.toUpperCase().replace(/[^A-Z]/g, '');
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).toUpperCase().padStart(6, '0');
  return `${normalized}-${ts}-${rand}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlap / block helpers (mirrored from index.ts)
// ─────────────────────────────────────────────────────────────────────────────

async function findActiveRoomOverlap(
  client: any,
  targetRoomId: number,
  requestedCheckIn: string | Date,
  requestedCheckOut: string | Date,
  excludeReservationId: number | null = null,
  options?: {
    stayType?: string;
    startAt?: string | Date | null;
    endAt?: string | Date | null;
    bufferMinutes?: number;
  }
) {
  const stayType = options?.stayType || 'OVERNIGHT';
  if (stayType === 'DAY_USE' && options?.startAt && options?.endAt) {
    const startTs = typeof options.startAt === 'string' ? options.startAt : options.startAt.toISOString();
    const endTs = typeof options.endAt === 'string' ? options.endAt : options.endAt.toISOString();
    const bufferMins = options.bufferMinutes || 60;
    return client.query(
      `SELECT existing.id, existing.booking_number, existing.check_in, existing.check_out, existing.status
       FROM reservations existing
       WHERE existing.room_id = $1
         AND existing.status IN ('BOOKED','CHECKED_IN')
         AND ($4::int IS NULL OR existing.id <> $4)
         AND (
           (existing.stay_type = 'DAY_USE' AND existing.start_at < ($3::timestamptz + ($5 || ' minutes')::interval) AND (existing.end_at + ($5 || ' minutes')::interval) > $2::timestamptz)
           OR
           (existing.stay_type = 'OVERNIGHT' AND (
             (existing.check_in < $2::date AND existing.check_out > $2::date)
             OR (existing.check_in::date = $2::date AND $3::timestamptz > (existing.check_in::date + TIME '14:00:00' - ($5 || ' minutes')::interval))
             OR (existing.check_out::date = $2::date AND $2::timestamptz < (existing.check_out::date + TIME '12:00:00' + ($5 || ' minutes')::interval))
           ))
         )
       LIMIT 1
       FOR UPDATE OF existing`,
      [targetRoomId, startTs, endTs, excludeReservationId, bufferMins]
    );
  }

  return client.query(
    `SELECT existing.id, existing.booking_number, existing.check_in, existing.check_out, existing.status
     FROM reservations existing
     WHERE existing.room_id = $1
       AND existing.status IN ('BOOKED','CHECKED_IN')
       AND ($4::int IS NULL OR existing.id <> $4)
       AND (
         (existing.stay_type = 'OVERNIGHT' AND existing.check_in < $2::date AND existing.check_out > $3::date)
         OR
         (existing.stay_type = 'DAY_USE' AND existing.start_at::date >= $3::date AND existing.start_at::date < $2::date)
       )
     LIMIT 1
     FOR UPDATE OF existing`,
    [targetRoomId, requestedCheckOut, requestedCheckIn, excludeReservationId]
  );
}

async function findActiveOperationalBlockOverlap(
  client: any,
  targetRoomId: number,
  requestedCheckIn: string | Date,
  requestedCheckOut: string | Date
) {
  return client.query(
    `SELECT id, block_type, start_date, end_date
     FROM room_operational_blocks
     WHERE room_id = $1
       AND status IN ('ACTIVE', 'RELEASED')
       AND start_date < $2::date
       AND end_date > $3::date
     LIMIT 1
     FOR UPDATE`,
    [targetRoomId, requestedCheckOut, requestedCheckIn]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type AddRoomPayload = {
  property_id: number;
  room_id: number;
  rate_plan_id: number;
  guest_name: string;
  guest_phone?: string | null;
  guest_segment?: string | null;
  check_in: string;
  check_out: string;
  stay_type?: string;
  start_at?: string | null;
  end_at?: string | null;
  // Idempotency
  idempotency_key?: string | null;
  // Audit
  created_by?: string | null;
  correlation_id?: string | null;
  special_requests?: string | null;
  ktp_path?: string | null;
};

export type AddRoomResult = {
  status: 'SUCCESS';
  data: {
    reservation: any;
    bid: string;
    booking_id: number;
    stay_sequence: number;
    correlation_id: string;
    effective_payment_state: any;
    new_booking_status: 'ACTIVE' | 'CANCELLED' | 'COMPLETED';
    group_financials: {
      existing_children_count: number;
      existing_group_total: number;
      existing_group_paid: number;
      existing_group_remaining: number;
      new_room_price: number;
      projected_group_total: number;
      projected_group_remaining: number;
    };
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Status helpers (mirrored from index.ts)
// ─────────────────────────────────────────────────────────────────────────────

type BookingChildStatusSummary = {
  total: number;
  booked: number;
  checkedIn: number;
  checkedOut: number;
  cancelled: number;
  unsupported: number;
  statuses: Array<{ reservation_id: number; status: string }>;
  hasTerminalCheckedOut: boolean;
  hasActiveChild: boolean;
  allCancelled: boolean;
};

function buildChildStatusSummary(children: any[]): BookingChildStatusSummary {
  const summary: BookingChildStatusSummary = {
    total: children.length,
    booked: 0,
    checkedIn: 0,
    checkedOut: 0,
    cancelled: 0,
    unsupported: 0,
    statuses: [],
    hasTerminalCheckedOut: false,
    hasActiveChild: false,
    allCancelled: children.length > 0
  };

  for (const child of children) {
    const status = String(child.status || '').toUpperCase();
    summary.statuses.push({ reservation_id: Number(child.id), status });

    if (status === 'BOOKED') { summary.booked++; summary.hasActiveChild = true; summary.allCancelled = false; }
    else if (status === 'CHECKED_IN') { summary.checkedIn++; summary.hasActiveChild = true; summary.allCancelled = false; }
    else if (status === 'CHECKED_OUT') { summary.checkedOut++; summary.hasTerminalCheckedOut = true; summary.allCancelled = false; }
    else if (status === 'CANCELLED') { summary.cancelled++; }
    else { summary.unsupported++; summary.hasActiveChild = true; summary.allCancelled = false; }
  }

  summary.allCancelled = summary.total > 0 && summary.cancelled === summary.total;
  return summary;
}

function deriveBookingLifecycleStatus(currentBookingStatus: any, summary: BookingChildStatusSummary): 'ACTIVE' | 'CANCELLED' | 'COMPLETED' {
  const normalizedCurrent = String(currentBookingStatus || '').toUpperCase();
  if (normalizedCurrent === 'CANCELLED') return 'CANCELLED';
  if (normalizedCurrent === 'COMPLETED') return 'COMPLETED';
  if (summary.total === 0) return 'ACTIVE';
  if (summary.hasTerminalCheckedOut && !summary.hasActiveChild) return 'COMPLETED';
  if (summary.allCancelled) return 'CANCELLED';
  return 'ACTIVE';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main service
// ─────────────────────────────────────────────────────────────────────────────

export async function addRoomToBooking(
  pool: Pool,
  bid: string,
  payload: AddRoomPayload
): Promise<AddRoomResult> {
  const client: PoolClient = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── 1. Lock booking (FOR UPDATE — prevents concurrent race on lifecycle) ──
    const bookingRes = await client.query(
      `SELECT id, property_id, booking_status, booking_source FROM bookings WHERE UPPER(bid) = $1 FOR UPDATE`,
      [bid.toUpperCase()]
    );
    if (!hasRows(bookingRes)) {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error('booking_not_found'),
        { statusCode: 404, code: 'BOOKING_NOT_FOUND' }
      );
    }
    const booking = bookingRes.rows[0];
    const bookingId = Number(booking.id);
    const bookingPropertyId = Number(booking.property_id);
    const bookingSource = String(booking.booking_source || 'WALKIN').trim().toUpperCase() || 'WALKIN';

    if (payload.property_id != null && Number(payload.property_id) !== bookingPropertyId) {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error('booking does not belong to this property'),
        { statusCode: 403, code: 'PROPERTY_MISMATCH' }
      );
    }

    const propertyId = bookingPropertyId;

    // ── 2. Load existing children and derive lifecycle BEFORE insert ───────
    const childrenRes = await client.query(
      `SELECT id, stay_sequence, status, total_price FROM reservations WHERE booking_id = $1 ORDER BY stay_sequence ASC`,
      [bookingId]
    );
    const children = childrenRes.rows;
    const maxSeq = children.length > 0
      ? Math.max(...children.map((c: any) => Number(c.stay_sequence || 0)))
      : 0;
    const nextStaySequence = maxSeq + 1;

    // Build canonical child summary
    const childSummary = buildChildStatusSummary(children);
    const derivedStatus = deriveBookingLifecycleStatus(booking.booking_status, childSummary);

    // Block: derived CANCELLED or COMPLETED
    if (derivedStatus === 'CANCELLED' || derivedStatus === 'COMPLETED') {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error(`booking is effectively ${derivedStatus} (all children are ${derivedStatus.toLowerCase()})`),
        { statusCode: 409, code: 'BOOKING_EFFECTIVELY_TERMINAL' }
      );
    }

    // Block: any CHECKED_IN / CHECKED_OUT child
    for (const child of children) {
      const st = String(child.status || '').toUpperCase();
      if (st === 'CHECKED_IN' || st === 'CHECKED_OUT') {
        await client.query('ROLLBACK');
        throw Object.assign(
          new Error(`cannot add room to booking: child reservation ${child.id} is ${st}`),
          { statusCode: 409, code: 'CHILD_CHECKED_IN_OR_OUT' }
        );
      }
    }

    // ── 3. Resolve room (FOR UPDATE — same pattern as createCanonicalBooking) ─
    const roomRes = await client.query(
      `SELECT r.id AS room_id, r.room_number, r.status AS room_status,
              r.is_active AS room_is_active,
              r.room_type_id AS canonical_room_type_id,
              rt.is_active AS room_type_is_active,
              rt.code AS room_type_code,
              COALESCE(rt.name, r.name) AS room_type,
              rc.id AS room_category_id,
              rc.code AS room_category_code,
              rc.name AS room_category_name
       FROM rooms r
       JOIN room_types rt ON rt.id = r.room_type_id
       LEFT JOIN room_categories rc
         ON rc.id = rt.room_category_id AND rc.property_id = rt.property_id
       WHERE r.id = $1 AND r.property_id = $2
       FOR UPDATE OF r`,
      [payload.room_id, propertyId]
    );
    if (!hasRows(roomRes)) {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error(`room ${payload.room_id} not found or does not belong to property ${propertyId}`),
        { statusCode: 404, code: 'ROOM_NOT_FOUND' }
      );
    }
    const roomInfo = roomRes.rows[0];

    if (roomInfo.room_is_active === false || roomInfo.room_type_is_active === false) {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error(`room ${payload.room_id} or its room type is inactive in Room Master and cannot accept new bookings`),
        { statusCode: 409, code: 'ROOM_INACTIVE' }
      );
    }
    if (!isRoomStatusSellable(roomInfo.room_status)) {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error(`room ${roomInfo.room_number || payload.room_id} is not sellable: status=${roomInfo.room_status}`),
        { statusCode: 409, code: 'ROOM_NOT_SELLABLE' }
      );
    }

    const canonicalRoomTypeId = Number(roomInfo.canonical_room_type_id);
    if (!Number.isFinite(canonicalRoomTypeId) || canonicalRoomTypeId <= 0) {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error(`room ${payload.room_id} is missing canonical room_type_id link`),
        { statusCode: 409, code: 'ROOM_TYPE_ID_MISSING' }
      );
    }

    // ── 4. Validate rate_plan_id ──────────────────────────────────────────
    const ratePlanId = Number(payload.rate_plan_id);
    if (!Number.isFinite(ratePlanId) || ratePlanId <= 0) {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error('rate_plan_id is required and must be a positive integer'),
        { statusCode: 400, code: 'INVALID_RATE_PLAN' }
      );
    }

    // Validate rate plan belongs to the room type and is active/not archived
    const rpCheck = await client.query(
      `SELECT id, is_active, is_archived, room_type_id FROM rate_plans WHERE id = $1`,
      [ratePlanId]
    );
    if (!hasRows(rpCheck)) {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error(`rate plan ${ratePlanId} not found`),
        { statusCode: 404, code: 'RATE_PLAN_NOT_FOUND' }
      );
    }
    const rp = rpCheck.rows[0];
    if (rp.is_archived === true) {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error(`rate plan ${ratePlanId} is archived`),
        { statusCode: 409, code: 'RATE_PLAN_ARCHIVED' }
      );
    }
    if (rp.is_active === false) {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error(`rate plan ${ratePlanId} is inactive`),
        { statusCode: 409, code: 'RATE_PLAN_INACTIVE' }
      );
    }
    if (Number(rp.room_type_id) !== canonicalRoomTypeId) {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error(`rate plan ${ratePlanId} does not belong to room type ${canonicalRoomTypeId}`),
        { statusCode: 409, code: 'RATE_PLAN_ROOM_TYPE_MISMATCH' }
      );
    }

    // ── 5. Normalize dates ────────────────────────────────────────────────
    const stayType = payload.stay_type || 'OVERNIGHT';
    const checkIn = hotelDateKey(normalizeHotelDate(payload.check_in));
    const checkOut = hotelDateKey(normalizeHotelDate(payload.check_out));

    if (!checkIn || !checkOut) {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error('invalid check_in or check_out date'),
        { statusCode: 400, code: 'INVALID_DATES' }
      );
    }

    // DAY_USE: use addHotelDays for blockCheckOut (same as createCanonicalBooking)
    const blockCheckOut = stayType === 'DAY_USE' && (!payload.end_at || payload.end_at === payload.start_at)
      ? addHotelDays(checkIn, 1)
      : checkOut;
    if (!blockCheckOut) {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error(`room ${payload.room_id} has an invalid operational-block date range`),
        { statusCode: 400, code: 'INVALID_DATES' }
      );
    }

    // ── 6. Operational block check ────────────────────────────────────────
    const blockOverlap = await findActiveOperationalBlockOverlap(client, payload.room_id, checkIn, blockCheckOut);
    if (hasRows(blockOverlap)) {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error(`room ${roomInfo.room_number || payload.room_id} has an operational block for the requested dates`),
        { statusCode: 409, code: 'ROOM_OPERATIONAL_BLOCK' }
      );
    }

    // ── 7. Overlap check — EXACT canonical behavior, NO booking_id exclusion ──
    const overlapRes = await findActiveRoomOverlap(
      client,
      payload.room_id,
      checkIn,
      blockCheckOut,
      null, // excludeReservationId = null (no exclusion)
      { stayType, startAt: payload.start_at, endAt: payload.end_at, bufferMinutes: 60 }
    );

    if (hasRows(overlapRes)) {
      const conflict = overlapRes.rows[0];
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error(
          `room ${roomInfo.room_number || payload.room_id} already occupied ${checkIn}–${blockCheckOut} (conflicts with reservation ${conflict.booking_number || conflict.id})`
        ),
        { statusCode: 409, code: 'ROOM_OVERLAP', conflictDetails: [{ reservation_id: conflict.id, booking_number: conflict.booking_number, check_in: conflict.check_in, check_out: conflict.check_out, status: conflict.status }] }
      );
    }

    // ── 8. Price quote (with required rate_plan_id) ───────────────────────
    let quote: PriceQuoteResult | null = null;
    try {
      quote = await calculatePriceQuote(client, {
        property_id: propertyId,
        room_type_id: canonicalRoomTypeId,
        rate_plan_id: ratePlanId,
        check_in: checkIn,
        check_out: blockCheckOut,
        stay_type: stayType as 'DAY_USE' | 'OVERNIGHT' | undefined
      });
    } catch (quoteErr: any) {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error(quoteErr?.message || 'Tarif kamar tidak dapat dihitung'),
        { statusCode: 400, code: 'CANONICAL_PRICE_QUOTE_FAILED' }
      );
    }

    // ── 9. Canonical price fields (exact mapping from create flow) ────────
    // subtotal_amount = room_subtotal, service_amount / tax_amount from quote,
    // total_price = grand_total
    const subtotalAmount = quote.room_subtotal || 0;
    const serviceAmount = quote.service_amount || 0;
    const taxAmount = quote.tax_amount || 0;
    const totalPrice = quote.grand_total || subtotalAmount;

    // ── 10. Enumerate hotel dates (SAME as createCanonicalBooking line 1871) ──
    const dates = stayType === 'DAY_USE'
      ? []
      : enumerateHotelDates(checkIn, blockCheckOut);

    // ── 11. Lock inventory rows ───────────────────────────────────────────
    const lockKeys = dates.map(date => ({
      roomTypeId: canonicalRoomTypeId,
      roomTypeName: String(roomInfo.room_type || ''),
      date
    }));

    const availabilityRows = await lockCanonicalAvailabilityRows(client, lockKeys);

    for (const key of lockKeys) {
      const availability = availabilityRows.get(availKey(key.roomTypeId, key.date));
      if (!availability) {
        await client.query('ROLLBACK');
        throw Object.assign(
          new Error(`availability row missing for ${key.roomTypeName} on ${key.date}`),
          { statusCode: 500, code: 'INVENTORY_INTEGRITY_ERROR' }
        );
      }
      const blockedCountRes = await client.query(
        `SELECT COUNT(*)::int AS blocked_count
         FROM room_operational_blocks
         WHERE room_type_id = $1 AND status IN ('ACTIVE','RELEASED')
           AND start_date <= $2::date AND end_date > $2::date`,
        [key.roomTypeId, key.date]
      );
      const blockedCount = Number(blockedCountRes.rows[0]?.blocked_count || 0);
      const sellableCapacity = availability.totalRooms - blockedCount;
      if (availability.reservedQty + 1 > sellableCapacity) {
        await client.query('ROLLBACK');
        throw Object.assign(
          new Error(`insufficient inventory for ${key.roomTypeName} on ${key.date}`),
          { statusCode: 409, code: 'INSUFFICIENT_INVENTORY' }
        );
      }
    }

    // ── 12. Insert reservation ────────────────────────────────────────────
    const bookingNumber = generateBookingNumber(client, bookingSource);
    const correlationId = payload.correlation_id || `ADDROOM-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const createdBy = payload.created_by || 'PMS';

    let insertedRow: any;
    try {
      const insertRes = await client.query(
        `INSERT INTO reservations (
           room_id, guest_name, guest_phone, guest_segment, check_in, check_out,
           total_price, payment_status, discount_amount, discount_percent, amount_paid, remaining_balance,
           booking_number, booking_type, booking_id, stay_sequence, status, stay_status, correlation_id, ktp_path,
           booker_name, booker_phone, ota_source_id, referral,
           booked_room_type_id_snapshot, booked_room_type_code_snapshot, booked_room_type_name_snapshot,
           booked_room_category_id_snapshot, booked_room_category_code_snapshot, booked_room_category_name_snapshot,
           classification_snapshot_source, classification_snapshotted_at,
           stay_type, start_at, end_at,
           rate_plan_id, subtotal_amount, tax_amount, service_amount,
           is_manual_override, manual_override_reason, discount_reason, special_requests
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
           'BOOKED', 'RESERVED', $17, $18,
           $19, $20, $21, $22,
           $23, $24, $25, $26, $27, $28, $29, CURRENT_TIMESTAMP,
           $30, $31, $32,
           $33, $34, $35,
           $36, $37, $38, $39, $40
         )
         RETURNING *`,
        [
          payload.room_id,
          payload.guest_name,
          payload.guest_phone || null,
          payload.guest_segment || null,
          checkIn,
          blockCheckOut,
          totalPrice,
          'UNPAID',
          0, // discount_amount — full price, no discount
          0, // discount_percent
          0, // amount_paid — UNPAID
          totalPrice, // remaining_balance = full price
          bookingNumber,
          bookingSource,
          bookingId,
          nextStaySequence,
          correlationId,
          payload.ktp_path || null,
          null, // booker_name
          null, // booker_phone
          null, // ota_source_id
          null, // referral
          canonicalRoomTypeId,
          String(roomInfo.room_type_code || '').trim() || null,
          String(roomInfo.room_type || '').trim() || null,
          roomInfo.room_category_id ? Number(roomInfo.room_category_id) : null,
          roomInfo.room_category_code ? String(roomInfo.room_category_code).trim() : null,
          roomInfo.room_category_name ? String(roomInfo.room_category_name).trim() : null,
          null, // classification_snapshot_source
          stayType,
          payload.start_at || null,
          payload.end_at || null,
          ratePlanId, // rate_plan_id — explicit canonical selection
          subtotalAmount,
          taxAmount,
          serviceAmount,
          false, // is_manual_override
          null, // manual_override_reason
          null, // discount_reason
          payload.special_requests || null
        ]
      );
      insertedRow = insertRes.rows[0];
    } catch (err: any) {
      await client.query('ROLLBACK');
      throw err;
    }

    // ── 13. Rate snapshots ────────────────────────────────────────────────
    await createReservationRateSnapshots(client, insertedRow.id, propertyId, quote, {
      isManualOverride: false,
      manualOverrideReason: null
    });

    // ── 14. Mutate inventory ──────────────────────────────────────────────
    for (const key of lockKeys) {
      const availability = availabilityRows.get(availKey(key.roomTypeId, key.date));
      if (availability) {
        await mutateCanonicalAvailabilityRow(client, availability, 1);
      }
    }

    // ── 15. Canonical financial recalculation (ensure amount_paid=0, no deposit) ──
    await recalculateReservationFinancials(client, insertedRow.id, propertyId);
    // ── 16. Refresh reservation from DB ───────────────────────────────────
    const refreshRes = await client.query(
      `SELECT * FROM reservations WHERE id = $1`,
      [insertedRow.id]
    );
    const reservation = refreshRes.rows[0];

    // ── 17. Canonical guest resolution & linkage ─────────────────────────
    let stayingGuestId: number | null = null;
    const rawGuestPhone = payload.guest_phone ? String(payload.guest_phone).trim() : null;
    const normPhone = rawGuestPhone ? normalizeDigitsOnly(rawGuestPhone) : null;

    if (rawGuestPhone) {
      const existingGuestRes = await client.query(
        `SELECT id FROM guests WHERE phone = $1 OR (normalized_phone IS NOT NULL AND normalized_phone = $2) LIMIT 1`,
        [rawGuestPhone, normPhone || null]
      );
      if (hasRows(existingGuestRes)) {
        stayingGuestId = Number(existingGuestRes.rows[0].id);
      }
    }

    if (!stayingGuestId) {
      const normName = (payload.guest_name || '').toLowerCase().trim();
      const hasValidId = Boolean(payload.ktp_path);
      const newGuestRes = await client.query(
        `INSERT INTO guests (
           full_name, normalized_name, phone, normalized_phone, identity_type, identity_path,
           has_valid_identity, guest_segment, created_property_id, created_at, updated_at
         ) VALUES (
           $1::VARCHAR, $2::VARCHAR, $3::VARCHAR, $4::VARCHAR, 'KTP', $5::TEXT,
           $6::BOOLEAN, $7::VARCHAR, $8::INT, NOW(), NOW()
         )
         RETURNING id`,
        [
          payload.guest_name,
          normName,
          rawGuestPhone,
          normPhone,
          payload.ktp_path || null,
          hasValidId,
          payload.guest_segment || 'Reguler',
          propertyId
        ]
      );
      stayingGuestId = Number(newGuestRes.rows[0].id);
      const guestCode = `GST-${String(stayingGuestId).padStart(5, '0')}`;
      await client.query(`UPDATE guests SET guest_code = $1 WHERE id = $2`, [guestCode, stayingGuestId]);
    }

    await client.query(
      `INSERT INTO reservation_guests (
         reservation_id, guest_id, role, relationship, is_staying, identity_verified, relation_source
       ) VALUES ($1, $2, 'PRIMARY_GUEST', 'SELF', TRUE, $3, 'CANONICAL_BOOKING')
       ON CONFLICT (reservation_id) WHERE role = 'PRIMARY_GUEST' DO UPDATE
       SET guest_id = EXCLUDED.guest_id, identity_verified = EXCLUDED.identity_verified, updated_at = NOW()`,
      [
        reservation.id,
        stayingGuestId,
        Boolean(payload.ktp_path)
      ]
    );

    await syncPrimaryGuestFromReservation(client, reservation.id, {
      guestPhone: payload.guest_phone || null,
      guestName: payload.guest_name || null,
      propertyId,
      relationSource: 'CANONICAL_BOOKING'
    });

    // ── 18. Get effective payment state for new child ─────────────────────
    const effectivePaymentState = await getEffectivePaymentStateForReservation(
      client,
      reservation.id,
      propertyId
    );

    // ── 19. Recompute booking lifecycle status (AFTER insert) ─────────────
    const allChildrenRes = await client.query(
      `SELECT id, status FROM reservations WHERE booking_id = $1 ORDER BY stay_sequence ASC`,
      [bookingId]
    );
    const allChildren = allChildrenRes.rows;
    const newSummary = buildChildStatusSummary(allChildren);
    const newBookingStatus = deriveBookingLifecycleStatus(booking.booking_status, newSummary);

    // ── 19. Update booking status if changed ──────────────────────────────
    if (newBookingStatus !== booking.booking_status) {
      await client.query(
        `UPDATE bookings SET booking_status = $1, updated_at = NOW() WHERE id = $2`,
        [newBookingStatus, bookingId]
      );
    }

    // ── 20. Compute group financials (authoritative, per blueprint) ────────
    const existingChildrenBefore = children;
    let existingGroupTotal = 0;
    let existingGroupPaid = 0;

    for (const child of existingChildrenBefore) {
      const childFin = await getEffectivePaymentStateForReservation(
        client,
        Number(child.id),
        propertyId
      );

      existingGroupTotal += Number(child.total_price || 0);
      existingGroupPaid += Number(childFin.totalEffectivePaid || 0);
    }

    const existingGroupRemaining = Math.max(0, existingGroupTotal - existingGroupPaid);
    const newRoomPrice = totalPrice;
    const projectedGroupTotal = existingGroupTotal + newRoomPrice;
    const projectedGroupRemaining = Math.max(0, projectedGroupTotal - existingGroupPaid);

    // ── 21. Audit logs (inside transaction, no silent swallow) ────────────
    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'PMS',
        'ADD_ROOM',
        'BOOKING',
        bookingId,
        JSON.stringify({
          reservation_id: reservation.id,
          bid,
          booking_source: bookingSource,
          room_id: payload.room_id,
          guest_name: payload.guest_name,
          check_in: checkIn,
          check_out: blockCheckOut,
          stay_sequence: nextStaySequence,
          rate_plan_id: ratePlanId,
          total_price: totalPrice,
          existing_children_count: existingChildrenBefore.length,
          projected_group_total: projectedGroupTotal
        }),
        correlationId,
        propertyId
      ]
    );

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'PMS',
        'ADD_ROOM',
        'RESERVATION',
        Number(reservation.id),
        JSON.stringify({
          booking_id: bookingId,
          bid,
          booking_source: bookingSource,
          reservation_id: Number(reservation.id),
          stay_sequence: nextStaySequence,
          room_id: Number(reservation.room_id),
          guest_name: reservation.guest_name,
          check_in: reservation.check_in ? hotelDateKey(reservation.check_in) : checkIn,
          check_out: reservation.check_out ? hotelDateKey(reservation.check_out) : blockCheckOut,
          rate_plan_id: ratePlanId,
          total_price: Number(reservation.total_price ?? totalPrice),
          payment_status: reservation.payment_status || 'UNPAID'
        }),
        correlationId,
        propertyId
      ]
    );

    await client.query('COMMIT');

    return {
      status: 'SUCCESS',
      data: {
        reservation: {
          ...reservation,
          check_in: reservation.check_in ? hotelDateKey(reservation.check_in) : null,
          check_out: reservation.check_out ? hotelDateKey(reservation.check_out) : null
        },
        bid,
        booking_id: bookingId,
        stay_sequence: nextStaySequence,
        correlation_id: correlationId,
        effective_payment_state: effectivePaymentState,
        new_booking_status: newBookingStatus,
        group_financials: {
          existing_children_count: existingChildrenBefore.length,
          existing_group_total: existingGroupTotal,
          existing_group_paid: existingGroupPaid,
          existing_group_remaining: existingGroupRemaining,
          new_room_price: newRoomPrice,
          projected_group_total: projectedGroupTotal,
          projected_group_remaining: projectedGroupRemaining
        }
      }
    };

  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

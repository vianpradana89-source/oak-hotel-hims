import { Pool, PoolClient } from 'pg';
import { addDays, calculatePriceQuote, createReservationRateSnapshots, toHotelDateString } from '../pricing/pricingService';
import { validateEvidenceUpload, saveEvidenceFile, deleteEvidenceFile } from '../payments/evidenceStorageService';
import { createPaymentInTransaction } from '../payments/paymentDomainService';

export interface ReservationEditPayload {
  property_id?: number;
  guest_name?: string;
  guest_phone?: string;
  guest_segment?: string;
  booker_name?: string;
  booker_phone?: string;
  referral?: string;
  notes?: string;
  adults?: number;
  children?: number;
  room_id?: number | null;
  room_type_id?: number;
  rate_plan_id?: number | null;
  check_in?: string;
  check_out?: string;
  stay_type?: 'OVERNIGHT' | 'DAY_USE' | 'TRANSIT';
  check_in_time?: string;
  check_out_time?: string;
  ota_source_id?: number | null;
  actor?: string;
}

export interface ReservationEditAvailability {
  property_id: number;
  check_in: string;
  check_out: string;
  stay_type: 'OVERNIGHT' | 'DAY_USE' | 'TRANSIT';
  room_types: Array<{
    id: number;
    code: string;
    name: string;
    rooms: Array<{
      id: number;
      room_number: string;
      floor: string | null;
      name: string | null;
    }>;
  }>;
}

// ============================================================================
// SHARED CANONICAL EDIT RESULT (returned by internal applyReservationEdit)
// ============================================================================

interface CanonicalEditResult {
  reservation: any;
  old_total_price: number;
  new_total_price: number;
  price_difference: number;
  quoted_total_price: number;
  quoted_price_difference: number;
  current_row: any;
  property_id: number;
  booking_id: number;
}

function normalizeHotelDate(value: unknown): string {
  if (value instanceof Date) return toHotelDateString(value);
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : toHotelDateString(new Date(String(value)));
}

function isValidHotelDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Read-only selector projection for BOOKED reservation edits. This uses the
 * same half-open room-overlap predicate as preview/save and excludes only the
 * reservation currently being edited.
 */
export async function getReservationEditAvailability(
  pool: Pool,
  reservationId: number,
  propertyId: number,
  checkIn: string,
  checkOut: string,
  stayType: 'OVERNIGHT' | 'DAY_USE' | 'TRANSIT' = 'OVERNIGHT'
): Promise<ReservationEditAvailability> {
  if (!Number.isInteger(reservationId) || reservationId <= 0) {
    const err: any = new Error('ID reservasi tidak valid.');
    err.statusCode = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    const err: any = new Error('property_id tidak valid.');
    err.statusCode = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  if (!['OVERNIGHT', 'DAY_USE', 'TRANSIT'].includes(stayType) || !isValidHotelDate(checkIn) || !isValidHotelDate(checkOut)) {
    const err: any = new Error('Tanggal atau tipe menginap tidak valid.');
    err.statusCode = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  const effectiveCheckOut = stayType === 'DAY_USE' && checkIn === checkOut
    ? addDays(checkIn, 1)
    : checkOut;
  if (!checkIn || !effectiveCheckOut || checkIn >= effectiveCheckOut) {
    const err: any = new Error('Rentang tanggal menginap tidak valid.');
    err.statusCode = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  const reservation = await pool.query(
    `SELECT r.id, r.status, b.property_id
     FROM reservations r
     JOIN bookings b ON b.id = r.booking_id
     WHERE r.id = $1`,
    [reservationId]
  );
  if (reservation.rows.length === 0) {
    const err: any = new Error(`Reservasi #${reservationId} tidak ditemukan.`);
    err.statusCode = 404;
    err.code = 'RESERVATION_NOT_FOUND';
    throw err;
  }
  if (Number(reservation.rows[0].property_id) !== propertyId) {
    const err: any = new Error(`Reservasi #${reservationId} bukan milik properti #${propertyId}`);
    err.statusCode = 403;
    err.code = 'PROPERTY_MISMATCH';
    throw err;
  }
  if (String(reservation.rows[0].status || '').toUpperCase() !== 'BOOKED') {
    const err: any = new Error('Pemilihan kamar untuk edit hanya tersedia untuk reservasi BOOKED.');
    err.statusCode = 409;
    err.code = 'BOOKED_RESERVATION_REQUIRED';
    throw err;
  }

  const result = await pool.query(
    `SELECT rt.id AS room_type_id, rt.code AS room_type_code, rt.name AS room_type_name,
            r.id AS room_id, r.room_number, r.floor, r.name AS room_name
     FROM room_types rt
     JOIN rooms r ON r.room_type_id = rt.id
     WHERE rt.property_id = $1
       AND rt.is_active = TRUE
       AND COALESCE(r.is_active, TRUE) = TRUE
       AND UPPER(COALESCE(r.status, 'READY')) NOT IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE')
       AND NOT EXISTS (
         SELECT 1
         FROM room_operational_blocks rob
         WHERE rob.room_id = r.id
           AND rob.property_id = $1
           AND rob.status = 'ACTIVE'
           AND rob.start_date < $3::date
           AND rob.end_date > $2::date
       )
       AND NOT EXISTS (
         SELECT 1
         FROM reservations conflict
         WHERE conflict.room_id = r.id
           AND conflict.id <> $4
           AND conflict.status IN ('BOOKED', 'CHECKED_IN', 'GUARANTEED', 'CONFIRMED')
           AND conflict.check_in < $3::date
           AND conflict.check_out > $2::date
       )
     ORDER BY rt.display_order, rt.id, r.room_number`,
    [propertyId, checkIn, effectiveCheckOut, reservationId]
  );

  const roomTypes = new Map<number, ReservationEditAvailability['room_types'][number]>();
  for (const row of result.rows) {
    const roomTypeId = Number(row.room_type_id);
    let roomType = roomTypes.get(roomTypeId);
    if (!roomType) {
      roomType = { id: roomTypeId, code: row.room_type_code, name: row.room_type_name, rooms: [] };
      roomTypes.set(roomTypeId, roomType);
    }
    roomType.rooms.push({
      id: Number(row.room_id),
      room_number: String(row.room_number),
      floor: row.floor === null || row.floor === undefined ? null : String(row.floor),
      name: row.room_name || null
    });
  }

  return {
    property_id: propertyId,
    check_in: checkIn,
    check_out: effectiveCheckOut,
    stay_type: stayType,
    room_types: [...roomTypes.values()]
  };
}

async function refreshPreservedPriceSnapshotContext(
  client: PoolClient,
  reservationId: number,
  propertyId: number,
  roomTypeId: number,
  ratePlanId: number | null,
  manualOverrideReason: string
): Promise<void> {
  const roomTypeRes = await client.query(
    `SELECT id, code, name FROM room_types WHERE id = $1 AND property_id = $2`,
    [roomTypeId, propertyId]
  );
  if (roomTypeRes.rows.length === 0) {
    const err: any = new Error(`Tipe kamar #${roomTypeId} bukan milik properti #${propertyId}`);
    err.statusCode = 403;
    err.code = 'PROPERTY_MISMATCH';
    throw err;
  }

  let ratePlan: any = null;
  if (ratePlanId) {
    const ratePlanRes = await client.query(
      `SELECT rp.id, rp.code, rp.name, rp.meal_plan_id,
              mp.code AS meal_plan_code, mp.name AS meal_plan_name
       FROM rate_plans rp
       LEFT JOIN meal_plans mp ON mp.id = rp.meal_plan_id
       WHERE rp.id = $1 AND rp.property_id = $2 AND rp.room_type_id = $3`,
      [ratePlanId, propertyId, roomTypeId]
    );
    if (ratePlanRes.rows.length === 0) {
      const err: any = new Error('Rate Plan tidak sesuai dengan tipe kamar yang dipilih.');
      err.statusCode = 400;
      err.code = 'RATE_PLAN_ROOM_TYPE_MISMATCH';
      throw err;
    }
    ratePlan = ratePlanRes.rows[0];
  }

  const roomType = roomTypeRes.rows[0];
  await client.query(
    `UPDATE reservation_nightly_rates
     SET room_type_id = $1,
         room_type_code_snapshot = $2,
         room_type_name_snapshot = $3,
         rate_plan_id = $4,
         rate_plan_code_snapshot = $5,
         rate_plan_name_snapshot = $6,
         meal_plan_id = $7,
         meal_plan_code_snapshot = $8,
         meal_plan_name_snapshot = $9,
         is_manual_override = TRUE,
         manual_override_reason = $10
     WHERE reservation_id = $11`,
    [
      roomType.id,
      roomType.code,
      roomType.name,
      ratePlan?.id || null,
      ratePlan?.code || null,
      ratePlan?.name || null,
      ratePlan?.meal_plan_id || null,
      ratePlan?.meal_plan_code || null,
      ratePlan?.meal_plan_name || null,
      manualOverrideReason,
      reservationId
    ]
  );

  await client.query(
    `UPDATE reservations
     SET rate_plan_code_snapshot = $1,
         rate_plan_name_snapshot = $2,
         meal_plan_id = $3,
         meal_plan_code_snapshot = $4,
         meal_plan_name_snapshot = $5,
         is_manual_override = TRUE,
         manual_override_reason = $6
     WHERE id = $7`,
    [
      ratePlan?.code || null,
      ratePlan?.name || null,
      ratePlan?.meal_plan_id || null,
      ratePlan?.meal_plan_code || null,
      ratePlan?.meal_plan_name || null,
      manualOverrideReason,
      reservationId
    ]
  );
}

// ============================================================================
// SHARED CANONICAL RESERVATION EDIT (single source of truth)
// ============================================================================

/**
 * Internal shared canonical reservation edit operation.
 *
 * Called by both executeReservationEdit and executeReservationEditWithPayment.
 * Caller owns the transaction boundary (BEGIN/COMMIT/ROLLBACK).
 *
 * When keepCurrentPrice=true: the quote is validated, metadata changes apply,
 * and the existing selling price and snapshots are preserved.
 * When isOta=true: manual OTA rate is authoritative, no reprice from BAR/Rate Calendar.
 */
async function applyReservationEdit(
  client: PoolClient,
  reservationId: number,
  payload: ReservationEditPayload,
  opts: { keepCurrentPrice?: boolean; bookedOnly?: boolean; requireAssignedRoom?: boolean; actor?: string } = {}
): Promise<CanonicalEditResult> {
  const { keepCurrentPrice = false, bookedOnly = false, requireAssignedRoom = false, actor = 'USER' } = opts;

  // 1. Lock reservation row
  const rRes = await client.query(
    `SELECT r.*, b.property_id, b.booker_name AS b_booker_name, b.booker_phone AS b_booker_phone,
            rm.room_number, COALESCE(rm.room_type_id, r.booked_room_type_id_snapshot) AS current_room_type_id
     FROM reservations r
     JOIN bookings b ON b.id = r.booking_id
     LEFT JOIN rooms rm ON rm.id = r.room_id
     WHERE r.id = $1
     FOR UPDATE OF r, b`,
    [reservationId]
  );

  if (rRes.rows.length === 0) {
    throw new Error(`Reservasi #${reservationId} tidak ditemukan.`);
  }

  const current = rRes.rows[0];
  const propertyId = Number(current.property_id);
  const bookingId = Number(current.booking_id);
  const isOta = current.ota_source_id != null;

  if (payload.property_id !== undefined && payload.property_id !== null && Number(payload.property_id) !== propertyId) {
    const err: any = new Error(`Reservasi #${reservationId} bukan milik properti #${payload.property_id}`);
    err.statusCode = 403;
    err.code = 'PROPERTY_MISMATCH';
    throw err;
  }

  if (['CHECKED_OUT', 'CANCELLED'].includes(String(current.status).toUpperCase())) {
    throw new Error(`Reservasi berstatus ${current.status} tidak dapat diedit.`);
  }
  if (bookedOnly && String(current.status).toUpperCase() !== 'BOOKED') {
    const err: any = new Error('Alur edit dan pembayaran selisih hanya tersedia untuk reservasi BOOKED.');
    err.statusCode = 409;
    err.code = 'BOOKED_RESERVATION_REQUIRED';
    throw err;
  }

  // 2. Determine targets
  const targetGuestName = payload.guest_name !== undefined ? payload.guest_name.trim() : current.guest_name;
  const targetGuestPhone = payload.guest_phone !== undefined ? payload.guest_phone.trim() : current.guest_phone;
  const targetGuestSegment = payload.guest_segment !== undefined ? payload.guest_segment : current.guest_segment;
  const targetBookerName = payload.booker_name !== undefined ? payload.booker_name.trim() : current.booker_name;
  const targetBookerPhone = payload.booker_phone !== undefined ? payload.booker_phone.trim() : current.booker_phone;
  const targetReferral = payload.referral !== undefined ? payload.referral : current.referral;
  const targetAdults = payload.adults !== undefined ? Number(payload.adults) : current.adults;
  const targetChildren = payload.children !== undefined ? Number(payload.children) : current.children;
  const targetOtaSourceId = payload.ota_source_id !== undefined ? payload.ota_source_id : current.ota_source_id;

  const targetRoomTypeId = payload.room_type_id || current.current_room_type_id;
  let targetRatePlanId = payload.rate_plan_id !== undefined ? payload.rate_plan_id : current.rate_plan_id;
  const targetRoomId = payload.room_id !== undefined ? payload.room_id : current.room_id;
  const currentCheckIn = normalizeHotelDate(current.check_in);
  const currentCheckOut = normalizeHotelDate(current.check_out);
  const targetCheckIn = payload.check_in || currentCheckIn;
  const targetCheckOut = payload.check_out || currentCheckOut;
  const targetStayType = payload.stay_type || current.stay_type || 'OVERNIGHT';
  const targetCheckInTime = payload.check_in_time !== undefined ? payload.check_in_time : current.check_in_time;
  const targetCheckOutTime = payload.check_out_time !== undefined ? payload.check_out_time : current.check_out_time;

  const datesChanged = targetCheckIn !== currentCheckIn || targetCheckOut !== currentCheckOut;
  const roomTypeChanged = Number(targetRoomTypeId) !== Number(current.current_room_type_id);
  const availabilityCheckOut = targetStayType === 'DAY_USE' && targetCheckIn === targetCheckOut
    ? addDays(targetCheckIn, 1)
    : targetCheckOut;

  if (requireAssignedRoom && !targetRoomId) {
    const err: any = new Error('Kamar fisik yang tersedia wajib dipilih.');
    err.statusCode = 400;
    err.code = 'ROOM_ASSIGNMENT_REQUIRED';
    throw err;
  }

  const roomTypeCheck = await client.query(
    'SELECT is_active FROM room_types WHERE id = $1 AND property_id = $2',
    [targetRoomTypeId, propertyId]
  );
  if (roomTypeCheck.rows.length === 0 || (requireAssignedRoom && roomTypeCheck.rows[0].is_active === false)) {
    const err: any = new Error('Tipe kamar tidak aktif atau bukan milik properti ini.');
    err.statusCode = 400;
    err.code = 'ROOM_TYPE_NOT_SELLABLE';
    throw err;
  }

  // 3. OTA stale rate plan guard: if room type changed and current rate plan is incompatible, clear it
  if (targetRatePlanId && (roomTypeChanged || isOta)) {
    const rpCheck = await client.query(
      'SELECT id, room_type_id FROM rate_plans WHERE id = $1 AND property_id = $2',
      [targetRatePlanId, propertyId]
    );
    if (rpCheck.rows.length === 0 || Number(rpCheck.rows[0].room_type_id) !== Number(targetRoomTypeId)) {
      targetRatePlanId = null;
    }
  }
  const ratePlanChanged = Number(targetRatePlanId) !== Number(current.rate_plan_id);

  // 4. Overlap validation if physical room is assigned
  if (targetRoomId) {
    const roomPropRes = await client.query(
      'SELECT property_id, room_type_id, is_active, status FROM rooms WHERE id = $1',
      [targetRoomId]
    );
    if (roomPropRes.rows.length === 0 || Number(roomPropRes.rows[0].property_id) !== propertyId) {
      const err: any = new Error(`Kamar #${targetRoomId} bukan milik properti #${propertyId}`);
      err.statusCode = 403;
      err.code = 'PROPERTY_MISMATCH';
      throw err;
    }
    if (Number(roomPropRes.rows[0].room_type_id) !== Number(targetRoomTypeId)) {
      const err: any = new Error(`Kamar #${targetRoomId} tidak sesuai dengan tipe kamar yang dipilih.`);
      err.statusCode = 400;
      err.code = 'ROOM_TYPE_MISMATCH';
      throw err;
    }
    if (requireAssignedRoom && (
      roomPropRes.rows[0].is_active === false
      || ['OUT_OF_ORDER', 'OUT_OF_SERVICE'].includes(String(roomPropRes.rows[0].status || '').toUpperCase())
    )) {
      const err: any = new Error('Kamar fisik tidak aktif atau tidak dapat dijual.');
      err.statusCode = 409;
      err.code = 'ROOM_NOT_SELLABLE';
      throw err;
    }

    if (requireAssignedRoom) {
      const blockRes = await client.query(
        `SELECT 1 FROM room_operational_blocks
         WHERE room_id = $1
           AND property_id = $2
           AND status = 'ACTIVE'
           AND start_date < $4::date
           AND end_date > $3::date
         LIMIT 1`,
        [targetRoomId, propertyId, targetCheckIn, availabilityCheckOut]
      );
      if (blockRes.rows.length > 0) {
        const err: any = new Error('Kamar fisik sedang diblokir untuk tanggal menginap yang dipilih.');
        err.statusCode = 409;
        err.code = 'ROOM_OPERATIONALLY_BLOCKED';
        throw err;
      }
    }

    const overlapRes = await client.query(
      `SELECT r.id, r.guest_name
       FROM reservations r
       WHERE r.room_id = $1
         AND r.id != $2
         AND r.status IN ('BOOKED', 'CHECKED_IN', 'GUARANTEED', 'CONFIRMED')
         AND r.check_in < $3 AND r.check_out > $4`,
      [targetRoomId, reservationId, availabilityCheckOut, targetCheckIn]
    );

    if (overlapRes.rows.length > 0) {
      throw new Error(`Kamar sudah ditempati oleh reservasi lain (#${overlapRes.rows[0].id} - ${overlapRes.rows[0].guest_name})`);
    }
  }

  // 5. Inventory Ledger updates if dates or room_type changed
  if (datesChanged || roomTypeChanged) {
    await client.query(
      `UPDATE availability_dates SET reserved_qty = GREATEST(0, reserved_qty - 1)
       WHERE room_type_id = $1 AND date >= $2::date AND date < $3::date`,
      [current.current_room_type_id, currentCheckIn, currentCheckOut]
    );
    await client.query(
      `UPDATE availability_dates SET reserved_qty = reserved_qty + 1
       WHERE room_type_id = $1 AND date >= $2::date AND date < $3::date`,
      [targetRoomTypeId, targetCheckIn, targetCheckOut]
    );
  }

  // 6. Pricing calculation
  const oldTotalPrice = Number(current.total_price || 0);
  let finalSubtotal = Number(current.subtotal_amount || current.total_price || 0);
  let finalService = Number(current.service_amount || 0);
  let finalTax = Number(current.tax_amount || 0);
  let finalGrandTotal = oldTotalPrice;
  let quoteResult: any = null;

  const needsQuote = !isOta && (datesChanged || roomTypeChanged || ratePlanChanged || payload.stay_type);

  if (needsQuote) {
    quoteResult = await calculatePriceQuote(client, {
      property_id: propertyId,
      room_type_id: Number(targetRoomTypeId),
      rate_plan_id: targetRatePlanId ? Number(targetRatePlanId) : undefined,
      check_in: String(targetCheckIn),
      check_out: String(targetCheckOut),
      stay_type: targetStayType,
      adults: targetAdults ? Number(targetAdults) : undefined,
      children: targetChildren ? Number(targetChildren) : undefined
    });

    if (!keepCurrentPrice) {
      finalSubtotal = quoteResult.room_subtotal;
      finalService = quoteResult.service_amount;
      finalTax = quoteResult.tax_amount;
      finalGrandTotal = quoteResult.grand_total;
    }
  }

  const discountAmount = Number(current.discount_amount || 0);
  const amountPaid = Number(current.amount_paid || 0);
  const appliedDeposit = Number(current.applied_deposit || 0);
  const finalTotalAfterDiscount = quoteResult && !keepCurrentPrice
    ? Math.max(0, finalGrandTotal - discountAmount)
    : oldTotalPrice;
  const effectiveSettlement = amountPaid + appliedDeposit;
  const remainingBalance = Math.max(0, finalTotalAfterDiscount - effectiveSettlement);
  const paymentStatus = effectiveSettlement >= finalTotalAfterDiscount ? 'PAID' : (effectiveSettlement > 0 ? 'PARTIAL' : 'UNPAID');

  const priceDifference = finalTotalAfterDiscount - oldTotalPrice;
  const quotedTotalAfterDiscount = quoteResult
    ? Math.max(0, Number(quoteResult.grand_total) - discountAmount)
    : oldTotalPrice;
  const quotedPriceDifference = quotedTotalAfterDiscount - oldTotalPrice;

  if (keepCurrentPrice && !isOta && quotedPriceDifference >= 0) {
    const err: any = new Error('Harga lama hanya dapat dipertahankan ketika quote baru lebih rendah.');
    err.statusCode = 409;
    err.code = 'KEEP_PRICE_NOT_APPLICABLE';
    throw err;
  }
  if (keepCurrentPrice && datesChanged) {
    const err: any = new Error('Harga lama hanya dapat dipertahankan untuk perubahan kamar atau rate plan tanpa mengubah tanggal menginap.');
    err.statusCode = 409;
    err.code = 'KEEP_PRICE_DATE_CHANGE_NOT_SUPPORTED';
    throw err;
  }

  let startAt: string | null = null;
  let endAt: string | null = null;
  if (targetStayType === 'DAY_USE') {
    startAt = targetCheckInTime ? `${targetCheckIn}T${targetCheckInTime}:00` : null;
    endAt = targetCheckOutTime ? `${targetCheckOut}T${targetCheckOutTime}:00` : null;
  }

  // 7. Update reservation record
  const updatedRes = await client.query(
    `UPDATE reservations
     SET guest_name = $1, guest_phone = $2, guest_segment = $3,
         booker_name = $4, booker_phone = $5, referral = $6,
         ota_source_id = $7, room_id = $8, booked_room_type_id_snapshot = $9,
         rate_plan_id = $10, check_in = $11, check_out = $12,
         stay_type = $13, start_at = $14, end_at = $15,
         subtotal_amount = $16, service_amount = $17, tax_amount = $18,
         total_price = $19, remaining_balance = $20, payment_status = $21
     WHERE id = $22
     RETURNING *`,
    [
      targetGuestName, targetGuestPhone, targetGuestSegment,
      targetBookerName, targetBookerPhone, targetReferral,
      targetOtaSourceId, targetRoomId, targetRoomTypeId,
      targetRatePlanId, targetCheckIn, targetCheckOut,
      targetStayType, startAt, endAt,
      finalSubtotal, finalService, finalTax,
      finalTotalAfterDiscount, remainingBalance, paymentStatus,
      reservationId
    ]
  );

  // 8. Keep snapshot identity aligned with the selected assignment. The money
  // remains unchanged only for an explicit preserved-price or OTA-manual edit.
  if (keepCurrentPrice || isOta) {
    await refreshPreservedPriceSnapshotContext(
      client,
      reservationId,
      propertyId,
      Number(targetRoomTypeId),
      targetRatePlanId ? Number(targetRatePlanId) : null,
      keepCurrentPrice
        ? 'Harga lama dipertahankan saat perubahan reservasi.'
        : 'Tarif OTA manual dipertahankan saat perubahan reservasi.'
    );
    const refreshed = await client.query('SELECT * FROM reservations WHERE id = $1', [reservationId]);
    updatedRes.rows[0] = refreshed.rows[0];
  } else if (quoteResult && quoteResult.nightly_breakdown) {
    await client.query(`DELETE FROM reservation_nightly_rates WHERE reservation_id = $1`, [reservationId]);
    await createReservationRateSnapshots(client, reservationId, propertyId, quoteResult);

    await client.query(
      `UPDATE folio_entries
       SET amount = $1, base_amount = $2, tax_amount = $3, service_amount = $4
       WHERE reservation_id = $5 AND entry_type = 'ROOM_CHARGE' AND is_voided = FALSE`,
      [finalTotalAfterDiscount, finalSubtotal, finalTax, finalService, reservationId]
    );
  }

  // 9. Update parent booking booker info
  if (targetBookerName || targetBookerPhone) {
    await client.query(
      `UPDATE bookings SET booker_name = COALESCE($1, booker_name), booker_phone = COALESCE($2, booker_phone), updated_at = NOW()
       WHERE id = $3`,
      [targetBookerName, targetBookerPhone, bookingId]
    );
  }

  // 10. Audit log
  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'PMS', 'UPDATE_RESERVATION_DETAIL', 'RESERVATION', reservationId,
      JSON.stringify({
        before: { total_price: oldTotalPrice, amount_paid: amountPaid, payment_status: current.payment_status },
        after: { total_price: finalTotalAfterDiscount, amount_paid: updatedRes.rows[0].amount_paid, payment_status: updatedRes.rows[0].payment_status },
        price_difference: priceDifference,
        quoted_price_difference: quotedPriceDifference,
        keep_current_price: keepCurrentPrice,
        edited_by: actor
      }),
      `EDIT-RES-${reservationId}-${Date.now()}`,
      propertyId
    ]
  );

  return {
    reservation: updatedRes.rows[0],
    old_total_price: oldTotalPrice,
    new_total_price: finalTotalAfterDiscount,
    price_difference: priceDifference,
    quoted_total_price: quotedTotalAfterDiscount,
    quoted_price_difference: quotedPriceDifference,
    current_row: current,
    property_id: propertyId,
    booking_id: bookingId
  };
}

// ============================================================================
// PREVIEW (read-only, no mutation)
// ============================================================================

/**
 * Preview reservation edit changes and pricing comparison
 */
export async function previewReservationEdit(
  pool: Pool,
  reservationId: number,
  payload: ReservationEditPayload
) {
  const rRes = await pool.query(
    `SELECT r.*, b.property_id, b.booker_name AS b_booker_name, b.booker_phone AS b_booker_phone,
            rm.room_number, COALESCE(rm.room_type_id, r.booked_room_type_id_snapshot) AS current_room_type_id
     FROM reservations r
     JOIN bookings b ON b.id = r.booking_id
     LEFT JOIN rooms rm ON rm.id = r.room_id
     WHERE r.id = $1`,
    [reservationId]
  );

  if (rRes.rows.length === 0) {
    throw new Error(`Reservasi #${reservationId} tidak ditemukan.`);
  }

  const current = rRes.rows[0];
  const propertyId = Number(current.property_id);

  if (payload.property_id !== undefined && payload.property_id !== null && Number(payload.property_id) !== propertyId) {
    const err: any = new Error(`Reservasi #${reservationId} bukan milik properti #${payload.property_id}`);
    err.statusCode = 403;
    err.code = 'PROPERTY_MISMATCH';
    throw err;
  }

  const targetRoomTypeId = payload.room_type_id || current.current_room_type_id;
  let targetRatePlanId = payload.rate_plan_id !== undefined ? payload.rate_plan_id : current.rate_plan_id;
  const targetCheckIn = payload.check_in || normalizeHotelDate(current.check_in);
  const targetCheckOut = payload.check_out || normalizeHotelDate(current.check_out);
  const targetStayType = payload.stay_type || current.stay_type || 'OVERNIGHT';
  const targetAdults = payload.adults !== undefined ? payload.adults : current.adults;
  const targetChildren = payload.children !== undefined ? payload.children : current.children;

  // OTA stale rate plan guard in preview too
  const roomTypeChanged = Number(targetRoomTypeId) !== Number(current.current_room_type_id || current.room_type_id);
  const isOta = current.ota_source_id != null;
  if (targetRatePlanId && (roomTypeChanged || isOta)) {
    const rpCheck = await pool.query(
      'SELECT id, room_type_id FROM rate_plans WHERE id = $1 AND property_id = $2',
      [targetRatePlanId, propertyId]
    );
    if (rpCheck.rows.length === 0 || Number(rpCheck.rows[0].room_type_id) !== Number(targetRoomTypeId)) {
      targetRatePlanId = null;
    }
  }

  // Check room overlap if physical room is provided/changed
  let roomOverlapConflict = false;
  let overlapMessage: string | null = null;
  const targetRoomId = payload.room_id !== undefined ? payload.room_id : current.room_id;

  if (targetRoomId) {
    const roomPropRes = await pool.query('SELECT property_id, room_type_id FROM rooms WHERE id = $1', [targetRoomId]);
    if (roomPropRes.rows.length === 0 || Number(roomPropRes.rows[0].property_id) !== propertyId) {
      const err: any = new Error(`Kamar #${targetRoomId} bukan milik properti #${propertyId}`);
      err.statusCode = 403;
      err.code = 'PROPERTY_MISMATCH';
      throw err;
    }
    if (Number(roomPropRes.rows[0].room_type_id) !== Number(targetRoomTypeId)) {
      const err: any = new Error(`Kamar #${targetRoomId} tidak sesuai dengan tipe kamar yang dipilih.`);
      err.statusCode = 400;
      err.code = 'ROOM_TYPE_MISMATCH';
      throw err;
    }

    const overlapRes = await pool.query(
      `SELECT r.id, r.guest_name, r.check_in, r.check_out
       FROM reservations r
       WHERE r.room_id = $1
         AND r.id != $2
         AND r.status IN ('BOOKED', 'CHECKED_IN', 'GUARANTEED', 'CONFIRMED')
         AND r.check_in < $3 AND r.check_out > $4`,
      [targetRoomId, reservationId, targetCheckOut, targetCheckIn]
    );

    if (overlapRes.rows.length > 0) {
      roomOverlapConflict = true;
      overlapMessage = `Kamar sudah ditempati oleh reservasi lain (#${overlapRes.rows[0].id} - ${overlapRes.rows[0].guest_name})`;
    }
  }

  // Calculate new quote (skip for OTA — manual rate is authoritative)
  let quote: any;
  if (isOta) {
    const currentTotalPrice = Number(current.total_price || 0);
    quote = {
      rate_plan: { name: 'OTA Manual Rate' },
      nights: Math.max(1, Math.round((new Date(targetCheckOut).getTime() - new Date(targetCheckIn).getTime()) / 86400000)),
      room_subtotal: Number(current.subtotal_amount || current.total_price || 0),
      service_amount: Number(current.service_amount || 0),
      tax_amount: Number(current.tax_amount || 0),
      grand_total: currentTotalPrice,
      nightly_breakdown: []
    };
  } else {
    quote = await calculatePriceQuote(pool, {
      property_id: propertyId,
      room_type_id: Number(targetRoomTypeId),
      rate_plan_id: targetRatePlanId ? Number(targetRatePlanId) : undefined,
      check_in: String(targetCheckIn),
      check_out: String(targetCheckOut),
      stay_type: targetStayType,
      adults: targetAdults ? Number(targetAdults) : undefined,
      children: targetChildren ? Number(targetChildren) : undefined
    });
  }

  const currentTotalPrice = Number(current.total_price || 0);
  const currentSubtotal = Number(current.subtotal_amount || current.total_price || 0);
  const newTotalPrice = isOta
    ? currentTotalPrice
    : Math.max(0, Number(quote.grand_total || 0) - Number(current.discount_amount || 0));
  const settlement = calculateEditSettlement(
    currentTotalPrice,
    newTotalPrice,
    Number(current.amount_paid || 0),
    Number(current.applied_deposit || 0)
  );

  return {
    reservation_id: reservationId,
    property_id: propertyId,
    is_ota: isOta,
    current: {
      room_type_id: current.current_room_type_id || current.room_type_id,
      room_id: current.room_id,
      room_number: current.room_number,
      rate_plan_id: current.rate_plan_id,
      check_in: current.check_in,
      check_out: current.check_out,
      stay_type: current.stay_type,
      subtotal_amount: currentSubtotal,
      total_price: currentTotalPrice,
      amount_paid: Number(current.amount_paid || 0),
      applied_deposit: Number(current.applied_deposit || 0),
      remaining_balance: Number(current.remaining_balance || 0)
    },
    quote: {
      room_type_id: targetRoomTypeId,
      room_id: targetRoomId,
      rate_plan_id: targetRatePlanId,
      rate_plan_name: quote.rate_plan?.name || 'Standard Rate',
      check_in: targetCheckIn,
      check_out: targetCheckOut,
      stay_type: targetStayType,
      nights: quote.nights,
      room_subtotal: quote.room_subtotal,
      service_amount: quote.service_amount,
      tax_amount: quote.tax_amount,
      grand_total: newTotalPrice,
      nightly_breakdown: quote.nightly_breakdown
    },
    old_total: currentTotalPrice,
    new_total: newTotalPrice,
    price_difference: settlement.priceDifference,
    amount_paid: Number(current.amount_paid || 0),
    applied_deposit: Number(current.applied_deposit || 0),
    effective_settlement: settlement.effectiveSettlement,
    new_remaining_before_payment: settlement.newRemainingBeforePayment,
    payment_required: settlement.paymentRequired,
    room_overlap_conflict: roomOverlapConflict,
    overlap_message: overlapMessage
  };
}

// ============================================================================
// PUBLIC: NORMAL EDIT (no payment)
// ============================================================================

/**
 * Execute reservation edit with full ledger, rate snapshot, and folio reconciliation.
 * Used for standard edit-save (no difference payment).
 */
export async function executeReservationEdit(
  pool: Pool,
  reservationId: number,
  payload: ReservationEditPayload,
  actor: string = 'USER'
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await applyReservationEdit(client, reservationId, payload, {
      keepCurrentPrice: false,
      bookedOnly: true,
      requireAssignedRoom: true,
      actor
    });
    await client.query('COMMIT');
    return result.reservation;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================================
// PUBLIC: EDIT + DIFFERENCE PAYMENT (atomic)
// ============================================================================

export interface EditWithPaymentPayload extends ReservationEditPayload {
  payment_method?: string;
  payment_amount?: number;
  amount_tendered?: number;
  evidence_note?: string | null;
  evidence_type?: string;
  keep_current_price?: boolean;
  idempotency_key?: string;
  expected_new_total?: number;
}

export interface EditWithPaymentFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

export interface EditWithPaymentResult {
  reservation: any;
  payment: any | null;
  evidence: any | null;
  price_difference: number;
  old_total_price: number;
  new_total_price: number;
  effective_settlement: number;
  new_remaining_before_payment: number;
  payment_required: number;
}

function calculateEditSettlement(
  oldTotal: number,
  newTotal: number,
  amountPaid: number,
  appliedDeposit: number
) {
  const priceDifference = Math.round(newTotal - oldTotal);
  const effectiveSettlement = Math.max(0, Math.round(amountPaid) + Math.round(appliedDeposit));
  const newRemainingBeforePayment = Math.max(0, Math.round(newTotal) - effectiveSettlement);
  const paymentRequired = Math.min(Math.max(0, priceDifference), newRemainingBeforePayment);
  return { priceDifference, effectiveSettlement, newRemainingBeforePayment, paymentRequired };
}

/**
 * Atomic reservation edit + optional difference payment.
 *
 * Reuses applyReservationEdit for the core edit logic.
 * Adds payment orchestration in the SAME transaction.
 *
 * keep_current_price=true: metadata changes, price preserved, no payment.
 * keep_current_price=false + positive difference: PAYMENT required with evidence.
 * keep_current_price=false + negative difference: price lowered, no automatic refund.
 * OTA: manual rate is authoritative, no reprice regardless of keep_current_price.
 */
export async function executeReservationEditWithPayment(
  pool: Pool,
  reservationId: number,
  payload: EditWithPaymentPayload,
  file: EditWithPaymentFile | null,
  actor: string = 'USER'
): Promise<EditWithPaymentResult> {
  const client = await pool.connect();
  let savedStorageKey: string | null = null;

  try {
    await client.query('BEGIN');

    const idempotencyKey = String(payload.idempotency_key || '').trim();
    if (!idempotencyKey) {
      const err: any = new Error('Idempotency-Key wajib dikirim untuk menyimpan edit reservasi.');
      err.statusCode = 400;
      err.code = 'IDEMPOTENCY_KEY_REQUIRED';
      throw err;
    }
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('oak_edit_payment_' || $1 || '_' || $2))`,
      [reservationId, idempotencyKey]
    );

    const ownership = await client.query(
      `SELECT b.property_id
       FROM reservations r JOIN bookings b ON b.id = r.booking_id
       WHERE r.id = $1 FOR UPDATE OF r`,
      [reservationId]
    );
    if (ownership.rows.length === 0) {
      const err: any = new Error(`Reservasi #${reservationId} tidak ditemukan.`);
      err.statusCode = 404;
      throw err;
    }
    if (Number(ownership.rows[0].property_id) !== Number(payload.property_id)) {
      const err: any = new Error(`Reservasi #${reservationId} bukan milik properti #${payload.property_id}`);
      err.statusCode = 403;
      err.code = 'PROPERTY_MISMATCH';
      throw err;
    }

    const paymentCorrelationId = `edit-payment:${payload.property_id}:${reservationId}:${idempotencyKey}`;
    const existingPayment = await client.query(
      `SELECT * FROM payment_transactions
       WHERE reservation_id = $1 AND correction_group_id = $2 AND status = 'SUCCESS'
       ORDER BY id DESC LIMIT 1`,
      [reservationId, paymentCorrelationId]
    );
    if (existingPayment.rows.length > 0) {
      const existingReservation = await client.query('SELECT * FROM reservations WHERE id = $1', [reservationId]);
      const existingEvidence = await client.query(
        `SELECT * FROM payment_evidences
         WHERE payment_transaction_id = $1 AND is_active = TRUE
         ORDER BY id DESC LIMIT 1`,
        [existingPayment.rows[0].id]
      );
      await client.query('COMMIT');
      const paymentAmount = Number(existingPayment.rows[0].amount || 0);
      const currentTotal = Number(existingReservation.rows[0].total_price || 0);
      const currentAmountPaid = Number(existingReservation.rows[0].amount_paid || 0);
      const currentAppliedDeposit = Number(existingReservation.rows[0].applied_deposit || 0);
      return {
        reservation: existingReservation.rows[0],
        payment: existingPayment.rows[0],
        evidence: existingEvidence.rows[0] || null,
        price_difference: paymentAmount,
        old_total_price: currentTotal - paymentAmount,
        new_total_price: currentTotal,
        effective_settlement: currentAmountPaid + currentAppliedDeposit,
        new_remaining_before_payment: Math.max(0, currentTotal - currentAmountPaid - currentAppliedDeposit),
        payment_required: paymentAmount
      };
    }

    // Apply canonical edit (reuses shared logic)
    const editResult = await applyReservationEdit(client, reservationId, payload, {
      keepCurrentPrice: payload.keep_current_price === true,
      bookedOnly: true,
      requireAssignedRoom: true,
      actor
    });

    const { old_total_price, new_total_price, price_difference } = editResult;
    const propertyId = editResult.property_id;
    if (payload.expected_new_total !== undefined
      && Math.round(Number(payload.expected_new_total)) !== Math.round(editResult.quoted_total_price)) {
      const err: any = new Error('Quote harga telah berubah. Muat ulang quote sebelum menyimpan.');
      err.statusCode = 409;
      err.code = 'STALE_PRICE_QUOTE';
      err.details = {
        expected_new_total: Number(payload.expected_new_total),
        current_new_total: editResult.quoted_total_price
      };
      throw err;
    }

    const settlement = calculateEditSettlement(
      old_total_price,
      new_total_price,
      Number(editResult.current_row.amount_paid || 0),
      Number(editResult.current_row.applied_deposit || 0)
    );

    // Payment orchestration uses the server-derived required amount. A price
    // increase can be smaller than an existing outstanding balance, or fully
    // covered by prior settlement, so it must not post raw price_difference.
    let paymentRow: any = null;
    let evidenceRow: any = null;
    let savedEvidence: { storageKey: string; absolutePath: string; fileSizeBytes: number } | null = null;

    if (!payload.keep_current_price && settlement.paymentRequired > 0) {
      const paymentAmount = settlement.paymentRequired;
      const paymentMethod = String(payload.payment_method || '').trim();

      if (!paymentMethod) {
        const err: any = new Error('Metode pembayaran selisih wajib dipilih.');
        err.statusCode = 400;
        err.code = 'PAYMENT_METHOD_REQUIRED';
        throw err;
      }

      if (paymentMethod === 'CASH') {
        const tendered = Number(payload.amount_tendered);
        if (!Number.isInteger(tendered) || tendered < paymentAmount) {
          const shortage = Number.isFinite(tendered) ? Math.max(0, paymentAmount - tendered) : paymentAmount;
          const err: any = new Error(`Uang diterima kurang Rp${shortage.toLocaleString('id-ID')}.`);
          err.statusCode = 400;
          err.code = 'INSUFFICIENT_CASH_TENDER';
          err.details = { payment_required: paymentAmount, amount_tendered: Number.isFinite(tendered) ? tendered : null, shortage };
          throw err;
        }
      } else {
        const submittedAmount = Number(payload.payment_amount);
        if (!Number.isInteger(submittedAmount) || submittedAmount !== paymentAmount) {
          const err: any = new Error('Nominal pembayaran harus sama dengan jumlah yang wajib dibayar sekarang.');
          err.statusCode = 400;
          err.code = 'PAYMENT_AMOUNT_MISMATCH';
          err.details = { payment_required: paymentAmount, submitted_amount: Number.isFinite(submittedAmount) ? submittedAmount : null };
          throw err;
        }
      }

      // Backend evidence requirement
      if (!file) {
        const err: any = new Error('Bukti pembayaran selisih wajib dilampirkan.');
        err.statusCode = 400;
        err.code = 'PAYMENT_EVIDENCE_REQUIRED';
        throw err;
      }

      const fileValidation = validateEvidenceUpload(file);
      if (!fileValidation.valid) {
        const err: any = new Error(fileValidation.error || 'File bukti pembayaran tidak valid');
        err.statusCode = 400;
        err.code = fileValidation.code || 'INVALID_FILE';
        throw err;
      }

      // Save evidence file (outside transaction — filesystem)
      savedEvidence = await saveEvidenceFile(propertyId, file);
      savedStorageKey = savedEvidence.storageKey;

      const paymentResult = await createPaymentInTransaction(client, {
        propertyId,
        reservationId,
        amount: paymentAmount,
        paymentMethod,
        referenceCode: `TXN-EDIT-${idempotencyKey}`,
        transactionType: 'PAYMENT',
        requireEvidence: true,
        file,
        evidenceType: payload.evidence_type as any,
        evidenceNote: payload.evidence_note || null,
        actorNameSnapshot: actor,
        correlationId: paymentCorrelationId,
        recalculateFromFolio: true
      }, savedEvidence);
      paymentRow = paymentResult.payment;
      evidenceRow = paymentResult.evidence;
      editResult.reservation = paymentResult.reservation;
    }

    await client.query('COMMIT');

    return {
      reservation: editResult.reservation,
      payment: paymentRow,
      evidence: evidenceRow,
      price_difference,
      old_total_price,
      new_total_price,
      effective_settlement: settlement.effectiveSettlement,
      new_remaining_before_payment: settlement.newRemainingBeforePayment,
      payment_required: settlement.paymentRequired
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (savedStorageKey) {
      await deleteEvidenceFile(savedStorageKey).catch(() => {});
    }
    throw err;
  } finally {
    client.release();
  }
}

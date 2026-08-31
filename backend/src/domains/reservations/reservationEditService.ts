import { Pool, PoolClient } from 'pg';
import { calculatePriceQuote, createReservationRateSnapshots } from '../pricing/pricingService';

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
  room_id?: number;
  room_type_id?: number;
  rate_plan_id?: number;
  check_in?: string;
  check_out?: string;
  stay_type?: 'OVERNIGHT' | 'DAY_USE' | 'TRANSIT';
  check_in_time?: string;
  check_out_time?: string;
  ota_source_id?: number | null;
  actor?: string;
}

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
            rm.room_number, COALESCE(r.booked_room_type_id_snapshot, rm.room_type_id) AS current_room_type_id
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
  const targetRatePlanId = payload.rate_plan_id !== undefined ? payload.rate_plan_id : current.rate_plan_id;
  const targetCheckIn = payload.check_in || current.check_in;
  const targetCheckOut = payload.check_out || current.check_out;
  const targetStayType = payload.stay_type || current.stay_type || 'OVERNIGHT';
  const targetAdults = payload.adults !== undefined ? payload.adults : current.adults;
  const targetChildren = payload.children !== undefined ? payload.children : current.children;

  // Check room overlap if physical room is provided/changed
  let roomOverlapConflict = false;
  let overlapMessage: string | null = null;
  const targetRoomId = payload.room_id || current.room_id;

  if (targetRoomId) {
    const roomPropRes = await pool.query('SELECT property_id FROM rooms WHERE id = $1', [targetRoomId]);
    if (roomPropRes.rows.length === 0 || Number(roomPropRes.rows[0].property_id) !== propertyId) {
      const err: any = new Error(`Kamar #${targetRoomId} bukan milik properti #${propertyId}`);
      err.statusCode = 403;
      err.code = 'PROPERTY_MISMATCH';
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

  // Calculate new quote
  const quote = await calculatePriceQuote(pool, {
    property_id: propertyId,
    room_type_id: Number(targetRoomTypeId),
    rate_plan_id: targetRatePlanId ? Number(targetRatePlanId) : undefined,
    check_in: String(targetCheckIn),
    check_out: String(targetCheckOut),
    stay_type: targetStayType,
    adults: targetAdults ? Number(targetAdults) : undefined,
    children: targetChildren ? Number(targetChildren) : undefined
  });

  const currentTotalPrice = Number(current.total_price || 0);
  const currentSubtotal = Number(current.subtotal_amount || current.total_price || 0);
  const newTotalPrice = quote.grand_total;
  const priceDifference = newTotalPrice - currentTotalPrice;

  return {
    reservation_id: reservationId,
    property_id: propertyId,
    current: {
      room_type_id: current.current_room_type_id,
      room_id: current.room_id,
      room_number: current.room_number,
      rate_plan_id: current.rate_plan_id,
      check_in: current.check_in,
      check_out: current.check_out,
      stay_type: current.stay_type,
      subtotal_amount: currentSubtotal,
      total_price: currentTotalPrice,
      amount_paid: Number(current.amount_paid || 0),
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
      grand_total: quote.grand_total,
      nightly_breakdown: quote.nightly_breakdown
    },
    price_difference: priceDifference,
    room_overlap_conflict: roomOverlapConflict,
    overlap_message: overlapMessage
  };
}

/**
 * Execute reservation edit with full ledger, rate snapshot, and folio reconciliation
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

    // 1. Lock reservation row
    const rRes = await client.query(
      `SELECT r.*, b.property_id, b.booker_name AS b_booker_name, b.booker_phone AS b_booker_phone,
              COALESCE(r.booked_room_type_id_snapshot, rm.room_type_id) AS current_room_type_id
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

    if (payload.property_id !== undefined && payload.property_id !== null && Number(payload.property_id) !== propertyId) {
      const err: any = new Error(`Reservasi #${reservationId} bukan milik properti #${payload.property_id}`);
      err.statusCode = 403;
      err.code = 'PROPERTY_MISMATCH';
      throw err;
    }

    if (['CHECKED_OUT', 'CANCELLED'].includes(String(current.status).toUpperCase())) {
      throw new Error(`Reservasi berstatus ${current.status} tidak dapat diedit.`);
    }

    // Determine targets
    const targetGuestName = payload.guest_name !== undefined ? payload.guest_name.trim() : current.guest_name;
    const targetGuestPhone = payload.guest_phone !== undefined ? payload.guest_phone.trim() : current.guest_phone;
    const targetGuestSegment = payload.guest_segment !== undefined ? payload.guest_segment : current.guest_segment;
    const targetBookerName = payload.booker_name !== undefined ? payload.booker_name.trim() : current.booker_name;
    const targetBookerPhone = payload.booker_phone !== undefined ? payload.booker_phone.trim() : current.booker_phone;
    const targetReferral = payload.referral !== undefined ? payload.referral : current.referral;
    const targetNotes = payload.notes !== undefined ? payload.notes : current.notes;
    const targetAdults = payload.adults !== undefined ? Number(payload.adults) : current.adults;
    const targetChildren = payload.children !== undefined ? Number(payload.children) : current.children;
    const targetOtaSourceId = payload.ota_source_id !== undefined ? payload.ota_source_id : current.ota_source_id;

    const targetRoomTypeId = payload.room_type_id || current.current_room_type_id;
    const targetRatePlanId = payload.rate_plan_id !== undefined ? payload.rate_plan_id : current.rate_plan_id;
    const targetRoomId = payload.room_id !== undefined ? payload.room_id : current.room_id;
    const targetCheckIn = payload.check_in || current.check_in;
    const targetCheckOut = payload.check_out || current.check_out;
    const targetStayType = payload.stay_type || current.stay_type || 'OVERNIGHT';
    const targetCheckInTime = payload.check_in_time !== undefined ? payload.check_in_time : current.check_in_time;
    const targetCheckOutTime = payload.check_out_time !== undefined ? payload.check_out_time : current.check_out_time;

    // Check if dates or room changed
    const datesChanged = targetCheckIn !== current.check_in || targetCheckOut !== current.check_out;
    const roomChanged = Number(targetRoomId) !== Number(current.room_id);
    const roomTypeChanged = Number(targetRoomTypeId) !== Number(current.current_room_type_id);
    const ratePlanChanged = Number(targetRatePlanId) !== Number(current.rate_plan_id);

    // Overlap validation if physical room is assigned
    if (targetRoomId) {
      const roomPropRes = await client.query('SELECT property_id FROM rooms WHERE id = $1', [targetRoomId]);
      if (roomPropRes.rows.length === 0 || Number(roomPropRes.rows[0].property_id) !== propertyId) {
        const err: any = new Error(`Kamar #${targetRoomId} bukan milik properti #${propertyId}`);
        err.statusCode = 403;
        err.code = 'PROPERTY_MISMATCH';
        throw err;
      }

      const overlapRes = await client.query(
        `SELECT r.id, r.guest_name
         FROM reservations r
         WHERE r.room_id = $1
           AND r.id != $2
           AND r.status IN ('BOOKED', 'CHECKED_IN', 'GUARANTEED', 'CONFIRMED')
           AND r.check_in < $3 AND r.check_out > $4`,
        [targetRoomId, reservationId, targetCheckOut, targetCheckIn]
      );

      if (overlapRes.rows.length > 0) {
        throw new Error(`Kamar sudah ditempati oleh reservasi lain (#${overlapRes.rows[0].id} - ${overlapRes.rows[0].guest_name})`);
      }
    }

    // Inventory Ledger updates if dates or room_type changed
    if (datesChanged || roomTypeChanged) {
      // 1. Release old dates
      await client.query(
        `UPDATE availability_dates
         SET reserved_qty = GREATEST(0, reserved_qty - 1)
         WHERE room_type_id = $1
           AND date >= $2::date
           AND date < $3::date`,
        [current.current_room_type_id, current.check_in, current.check_out]
      );

      // 2. Claim new dates
      await client.query(
        `UPDATE availability_dates
         SET reserved_qty = reserved_qty + 1
         WHERE room_type_id = $1
           AND date >= $2::date
           AND date < $3::date`,
        [targetRoomTypeId, targetCheckIn, targetCheckOut]
      );
    }

    // Pricing calculation
    let finalSubtotal = Number(current.subtotal_amount || current.total_price || 0);
    let finalService = Number(current.service_amount || 0);
    let finalTax = Number(current.tax_amount || 0);
    let finalGrandTotal = Number(current.total_price || 0);
    let quoteResult: any = null;

    if (datesChanged || roomTypeChanged || ratePlanChanged || payload.stay_type) {
      quoteResult = await calculatePriceQuote(pool, {
        property_id: propertyId,
        room_type_id: Number(targetRoomTypeId),
        rate_plan_id: targetRatePlanId ? Number(targetRatePlanId) : undefined,
        check_in: String(targetCheckIn),
        check_out: String(targetCheckOut),
        stay_type: targetStayType,
        adults: targetAdults ? Number(targetAdults) : undefined,
        children: targetChildren ? Number(targetChildren) : undefined
      });

      finalSubtotal = quoteResult.room_subtotal;
      finalService = quoteResult.service_amount;
      finalTax = quoteResult.tax_amount;
      finalGrandTotal = quoteResult.grand_total;
    }

    const discountAmount = Number(current.discount_amount || 0);
    const amountPaid = Number(current.amount_paid || 0);
    const finalTotalAfterDiscount = Math.max(0, finalGrandTotal - discountAmount);
    const remainingBalance = Math.max(0, finalTotalAfterDiscount - amountPaid);
    const paymentStatus = amountPaid >= finalTotalAfterDiscount ? 'PAID' : (amountPaid > 0 ? 'PARTIAL' : 'UNPAID');

    let startAt: string | null = null;
    let endAt: string | null = null;
    if (targetStayType === 'DAY_USE') {
      startAt = targetCheckInTime ? `${targetCheckIn}T${targetCheckInTime}:00` : null;
      endAt = targetCheckOutTime ? `${targetCheckOut}T${targetCheckOutTime}:00` : null;
    }

    // Update reservation record
    const updatedRes = await client.query(
      `UPDATE reservations
       SET guest_name = $1,
           guest_phone = $2,
           guest_segment = $3,
           booker_name = $4,
           booker_phone = $5,
           referral = $6,
           ota_source_id = $7,
           room_id = $8,
           booked_room_type_id_snapshot = $9,
           rate_plan_id = $10,
           check_in = $11,
           check_out = $12,
           stay_type = $13,
           start_at = $14,
           end_at = $15,
           subtotal_amount = $16,
           service_amount = $17,
           tax_amount = $18,
           total_price = $19,
           remaining_balance = $20,
           payment_status = $21
       WHERE id = $22
       RETURNING *`,
      [
        targetGuestName,
        targetGuestPhone,
        targetGuestSegment,
        targetBookerName,
        targetBookerPhone,
        targetReferral,
        targetOtaSourceId,
        targetRoomId,
        targetRoomTypeId,
        targetRatePlanId,
        targetCheckIn,
        targetCheckOut,
        targetStayType,
        startAt,
        endAt,
        finalSubtotal,
        finalService,
        finalTax,
        finalTotalAfterDiscount,
        remainingBalance,
        paymentStatus,
        reservationId
      ]
    );

    // Update rate snapshots if quote changed
    if (quoteResult && quoteResult.nightly_breakdown) {
      await client.query(`DELETE FROM reservation_nightly_rates WHERE reservation_id = $1`, [reservationId]);
      await createReservationRateSnapshots(
        client,
        reservationId,
        propertyId,
        quoteResult
      );

      // Reconcile primary room folio entry
      await client.query(
        `UPDATE folio_entries
         SET amount = $1,
             base_amount = $2,
             tax_amount = $3,
             service_amount = $4
         WHERE reservation_id = $5
           AND entry_type = 'ROOM_CHARGE'
           AND is_voided = FALSE`,
        [finalGrandTotal, finalSubtotal, finalTax, finalService, reservationId]
      );
    }

    // Update parent booking booker info
    if (targetBookerName || targetBookerPhone) {
      await client.query(
        `UPDATE bookings
         SET booker_name = COALESCE($1, booker_name),
             booker_phone = COALESCE($2, booker_phone),
             updated_at = NOW()
         WHERE id = $3`,
        [targetBookerName, targetBookerPhone, bookingId]
      );
    }

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'PMS',
        'UPDATE_RESERVATION_DETAIL',
        'RESERVATION',
        reservationId,
        JSON.stringify({
          before: current,
          after: updatedRes.rows[0],
          edited_by: actor
        }),
        `EDIT-RES-${reservationId}-${Date.now()}`,
        propertyId
      ]
    );

    await client.query('COMMIT');
    return updatedRes.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

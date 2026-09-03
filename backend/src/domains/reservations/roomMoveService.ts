import type { Pool, PoolClient } from 'pg';
import { canonicalAvailabilityKey, lockCanonicalAvailabilityRows, mutateCanonicalAvailabilityRow } from '../inventory/canonicalAvailability';
import { calculatePriceQuote } from '../pricing/pricingService';
import { ensureDirtyRoomCleaningTask } from '../housekeeping/housekeepingService';
import { evaluateRoomReadiness } from '../turnover/turnoverService';
import { addHotelDays, enumerateHotelDates, hotelDateFromInstant, hotelDateKey } from '../../utils/hotelDate';

export const ROOM_MOVE_REASONS = [
  'GUEST_REQUEST', 'MAINTENANCE', 'ROOM_ISSUE', 'UPGRADE', 'DOWNGRADE', 'OPERATIONAL', 'OTHER'
] as const;
export type RoomMovePricingTreatment = 'KEEP_CURRENT_RATE' | 'APPLY_NEW_RATE';

type RoomMoveActor = { id?: number; username?: string; full_name?: string; role?: string };

function roomMoveError(message: string, code: string, statusCode = 400): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
}

function roomMoveActorName(actor?: RoomMoveActor): string {
  return String(actor?.full_name || actor?.username || 'USER').slice(0, 100);
}

async function getReservationForMove(client: Pool | PoolClient, reservationId: number, lock = false): Promise<any> {
  const result = await client.query(
    `SELECT r.*, b.property_id, b.bid, rm.room_number, rm.room_type_id AS current_room_type_id,
            rt.code AS current_room_type_code, rt.name AS current_room_type_name
     FROM reservations r
     JOIN bookings b ON b.id = r.booking_id
     JOIN rooms rm ON rm.id = r.room_id
     JOIN room_types rt ON rt.id = rm.room_type_id
     WHERE r.id = $1${lock ? ' FOR UPDATE OF r, b' : ''}`,
    [reservationId]
  );
  if (result.rowCount !== 1) throw roomMoveError('Reservasi tidak ditemukan.', 'RESERVATION_NOT_FOUND', 404);
  return result.rows[0];
}

async function listMoveEligibleRooms(
  client: Pool | PoolClient,
  reservation: any
): Promise<Array<{ id: number; room_number: string; floor: string | null; name: string | null; room_type_id: number; room_type_code: string; room_type_name: string }>> {
  const result = await client.query(
    `SELECT rm.id, rm.room_number, rm.floor, rm.name, rm.room_type_id,
            rt.code AS room_type_code, rt.name AS room_type_name
     FROM rooms rm
     JOIN room_types rt ON rt.id = rm.room_type_id
     WHERE rm.property_id = $1
       AND rt.property_id = $1
       AND COALESCE(rm.is_active, TRUE) = TRUE
       AND COALESCE(rt.is_active, TRUE) = TRUE
       AND UPPER(COALESCE(rm.status, 'VACANT_CLEAN')) NOT IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE')
       AND NOT EXISTS (
         SELECT 1 FROM room_operational_blocks rob
         WHERE rob.room_id = rm.id AND rob.property_id = $1 AND rob.status = 'ACTIVE'
           AND rob.start_date < $3::date AND rob.end_date > $2::date
       )
       AND NOT EXISTS (
         SELECT 1 FROM reservations conflict
         WHERE conflict.room_id = rm.id AND conflict.id <> $4
           AND conflict.status IN ('BOOKED', 'CHECKED_IN', 'GUARANTEED', 'CONFIRMED')
           AND conflict.check_in < $3::date AND conflict.check_out > $2::date
       )
     ORDER BY rt.display_order, rt.id, rm.room_number`,
    [Number(reservation.property_id), hotelDateKey(reservation.check_in), hotelDateKey(reservation.check_out), Number(reservation.id)]
  );

  const eligible: Array<{ id: number; room_number: string; floor: string | null; name: string | null; room_type_id: number; room_type_code: string; room_type_name: string }> = [];
  for (const row of result.rows) {
    if (Number(row.id) === Number(reservation.room_id)) continue;
    if (String(row.room_type_code) === '') continue;
    const readiness = await evaluateRoomReadiness(client, Number(row.id), Number(reservation.id));
    if (!readiness.is_ready) continue;
    eligible.push({
      id: Number(row.id), room_number: String(row.room_number), floor: row.floor == null ? null : String(row.floor),
      name: row.name || null, room_type_id: Number(row.room_type_id), room_type_code: String(row.room_type_code), room_type_name: String(row.room_type_name)
    });
  }
  return eligible;
}

export async function getRoomMoveAvailability(pool: Pool, reservationId: number, propertyId: number) {
  const reservation = await getReservationForMove(pool, reservationId);
  if (Number(reservation.property_id) !== propertyId) throw roomMoveError('Reservasi bukan milik properti aktif.', 'PROPERTY_MISMATCH', 403);
  if (String(reservation.status).toUpperCase() !== 'CHECKED_IN') {
    throw roomMoveError('Pindah kamar hanya tersedia untuk tamu yang sudah check-in.', 'CHECKED_IN_RESERVATION_REQUIRED', 409);
  }
  const rooms = await listMoveEligibleRooms(pool, reservation);
  const types = new Map<number, any>();
  for (const room of rooms) {
    let type = types.get(room.room_type_id);
    if (!type) {
      type = { id: room.room_type_id, code: room.room_type_code, name: room.room_type_name, rooms: [] };
      types.set(room.room_type_id, type);
    }
    type.rooms.push({ id: room.id, room_number: room.room_number, floor: room.floor, name: room.name });
  }
  return {
    reservation_id: Number(reservation.id), property_id: propertyId,
    current_room: { id: Number(reservation.room_id), room_number: reservation.room_number, room_type_id: Number(reservation.current_room_type_id), room_type_name: reservation.current_room_type_name },
    room_types: [...types.values()]
  };
}

export async function getRoomMoveHistory(pool: Pool, reservationId: number, propertyId: number) {
  const reservation = await getReservationForMove(pool, reservationId);
  if (Number(reservation.property_id) !== propertyId) throw roomMoveError('Reservasi bukan milik properti aktif.', 'PROPERTY_MISMATCH', 403);
  const result = await pool.query(
    `SELECT m.*, fr.room_number AS from_room_number, tr.room_number AS to_room_number,
            frt.name AS from_room_type_name, trt.name AS to_room_type_name
     FROM reservation_room_moves m
     JOIN rooms fr ON fr.id=m.from_room_id
     JOIN rooms tr ON tr.id=m.to_room_id
     JOIN room_types frt ON frt.id=m.from_room_type_id
     JOIN room_types trt ON trt.id=m.to_room_type_id
     WHERE m.reservation_id=$1 AND m.property_id=$2
     ORDER BY m.moved_at, m.id`,
    [reservationId, propertyId]
  );
  return result.rows;
}

async function getTargetRoom(client: PoolClient, targetRoomId: number, propertyId: number): Promise<any> {
  const result = await client.query(
    `SELECT rm.*, rt.code AS room_type_code, rt.name AS room_type_name, rt.is_active AS room_type_is_active
     FROM rooms rm JOIN room_types rt ON rt.id = rm.room_type_id
     WHERE rm.id = $1 AND rm.property_id = $2 AND rt.property_id = $2`,
    [targetRoomId, propertyId]
  );
  if (result.rowCount !== 1) throw roomMoveError('Kamar tujuan tidak ditemukan pada properti ini.', 'TARGET_ROOM_NOT_FOUND', 404);
  return result.rows[0];
}

async function assertTargetAvailable(client: PoolClient, reservation: any, target: any): Promise<void> {
  if (target.is_active === false || target.room_type_is_active === false) {
    throw roomMoveError('Kamar atau tipe kamar tujuan tidak aktif.', 'ROOM_MASTER_INACTIVE', 409);
  }
  const readiness = await evaluateRoomReadiness(client, Number(target.id), Number(reservation.id));
  if (!readiness.is_ready) {
    throw roomMoveError(readiness.reason_message || 'Kamar tujuan belum siap digunakan.', readiness.reason_code || 'ROOM_NOT_READY', 409);
  }
  const conflict = await client.query(
    `SELECT id FROM reservations
     WHERE room_id = $1 AND id <> $2
       AND status IN ('BOOKED', 'CHECKED_IN', 'GUARANTEED', 'CONFIRMED')
       AND check_in < $4::date AND check_out > $3::date
     LIMIT 1 FOR UPDATE`,
    [target.id, reservation.id, hotelDateKey(reservation.check_in), hotelDateKey(reservation.check_out)]
  );
  if (conflict.rowCount) throw roomMoveError('Kamar tujuan sudah digunakan reservasi lain.', 'ROOM_OVERLAP', 409);
  const block = await client.query(
    `SELECT id FROM room_operational_blocks
     WHERE room_id = $1 AND property_id = $2 AND status = 'ACTIVE'
       AND start_date < $4::date AND end_date > $3::date LIMIT 1 FOR UPDATE`,
    [target.id, reservation.property_id, hotelDateKey(reservation.check_in), hotelDateKey(reservation.check_out)]
  );
  if (block.rowCount) throw roomMoveError('Kamar tujuan sedang diblokir operasional.', 'ROOM_OPERATIONALLY_BLOCKED', 409);
}

function validateMoveInput(input: any) {
  const targetRoomId = Number(input.to_room_id);
  const category = String(input.reason_category || '').trim().toUpperCase();
  const detail = String(input.reason_detail || '').trim();
  const pricingTreatment = String(input.pricing_treatment || '').trim().toUpperCase() as RoomMovePricingTreatment;
  if (!Number.isInteger(targetRoomId) || targetRoomId <= 0) throw roomMoveError('Kamar tujuan wajib dipilih.', 'TARGET_ROOM_REQUIRED');
  if (!(ROOM_MOVE_REASONS as readonly string[]).includes(category)) throw roomMoveError('Kategori alasan pindah kamar tidak valid.', 'REASON_CATEGORY_INVALID');
  if (!detail) throw roomMoveError('Keterangan alasan pindah kamar wajib diisi.', 'REASON_DETAIL_REQUIRED');
  if (!['KEEP_CURRENT_RATE', 'APPLY_NEW_RATE'].includes(pricingTreatment)) throw roomMoveError('Treatment tarif wajib dipilih.', 'PRICING_TREATMENT_REQUIRED');
  return { targetRoomId, category, detail, pricingTreatment };
}

async function buildPricingPreview(client: Pool | PoolClient, reservation: any, targetRoomTypeId: number, targetRatePlanId?: number | null) {
  // A nightly ledger has one snapshot per hotel date. Use the next hotel date
  // so the already-started night is never rewritten as a retroactive move.
  const effectiveFrom = addHotelDays(hotelDateFromInstant(new Date()), 1);
  const checkOut = hotelDateKey(reservation.check_out);
  if (effectiveFrom >= checkOut || Number(targetRoomTypeId) === Number(reservation.current_room_type_id)) {
    return { effective_from_date: effectiveFrom, current_total: Number(reservation.total_price || 0), quoted_total: Number(reservation.total_price || 0), difference: 0, quote: null };
  }
  if (reservation.ota_source_id != null) {
    return { effective_from_date: effectiveFrom, current_total: Number(reservation.total_price || 0), quoted_total: Number(reservation.total_price || 0), difference: 0, quote: null, ota_manual_rate: true };
  }
  const quote = await calculatePriceQuote(client, {
    property_id: Number(reservation.property_id), room_type_id: targetRoomTypeId,
    rate_plan_id: targetRatePlanId ? Number(targetRatePlanId) : undefined,
    check_in: effectiveFrom, check_out: checkOut, stay_type: reservation.stay_type === 'DAY_USE' ? 'DAY_USE' : 'OVERNIGHT',
    adults: reservation.adults == null ? undefined : Number(reservation.adults), children: reservation.children == null ? undefined : Number(reservation.children)
  });
  const past = await client.query(
    `SELECT COALESCE(SUM(total_amount), 0) AS total FROM reservation_nightly_rates
     WHERE reservation_id = $1 AND stay_date < $2::date`,
    [reservation.id, effectiveFrom]
  );
  const quotedTotal = Math.max(0, Number(past.rows[0]?.total || 0) + Number(quote.grand_total) - Number(reservation.discount_amount || 0));
  return { effective_from_date: effectiveFrom, current_total: Number(reservation.total_price || 0), quoted_total: quotedTotal, difference: quotedTotal - Number(reservation.total_price || 0), quote };
}

export async function previewRoomMove(pool: Pool, reservationId: number, input: any) {
  const propertyId = Number(input.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) throw roomMoveError('property_id tidak valid.', 'VALIDATION_ERROR');
  const targetRoomId = Number(input.to_room_id);
  if (!Number.isInteger(targetRoomId) || targetRoomId <= 0) throw roomMoveError('Kamar tujuan wajib dipilih.', 'TARGET_ROOM_REQUIRED');
  const reservation = await getReservationForMove(pool, reservationId);
  if (Number(reservation.property_id) !== propertyId) throw roomMoveError('Reservasi bukan milik properti aktif.', 'PROPERTY_MISMATCH', 403);
  if (String(reservation.status).toUpperCase() !== 'CHECKED_IN') throw roomMoveError('Pindah kamar hanya tersedia untuk tamu yang sudah check-in.', 'CHECKED_IN_RESERVATION_REQUIRED', 409);
  const target = await pool.query('SELECT rm.room_type_id FROM rooms rm WHERE rm.id = $1 AND rm.property_id = $2', [targetRoomId, propertyId]);
  if (target.rowCount !== 1) throw roomMoveError('Kamar tujuan tidak ditemukan pada properti ini.', 'TARGET_ROOM_NOT_FOUND', 404);
  return buildPricingPreview(pool, reservation, Number(target.rows[0].room_type_id), input.rate_plan_id);
}

async function reassignMoveInventory(client: PoolClient, reservation: any, fromTypeId: number, toTypeId: number, effectiveFrom: string): Promise<void> {
  if (fromTypeId === toTypeId) return;
  const dates = enumerateHotelDates(effectiveFrom, hotelDateKey(reservation.check_out));
  const keys = dates.flatMap(date => [
    { roomTypeId: fromTypeId, date }, { roomTypeId: toTypeId, date }
  ]);
  const rows = await lockCanonicalAvailabilityRows(client, keys);
  for (const date of dates) {
    const from = rows.get(canonicalAvailabilityKey(fromTypeId, date))!;
    const to = rows.get(canonicalAvailabilityKey(toTypeId, date))!;
    if (from.reservedQty < 1) throw roomMoveError(`Inventori tipe kamar asal tidak konsisten pada ${date}.`, 'INVENTORY_INTEGRITY_ERROR', 409);
    if (to.reservedQty >= to.totalRooms) throw roomMoveError(`Tipe kamar tujuan penuh pada ${date}.`, 'CAPACITY_EXHAUSTED', 409);
  }
  for (const date of dates) {
    await mutateCanonicalAvailabilityRow(client, rows.get(canonicalAvailabilityKey(fromTypeId, date))!, -1);
    await mutateCanonicalAvailabilityRow(client, rows.get(canonicalAvailabilityKey(toTypeId, date))!, 1);
  }
}

async function applyFutureQuote(client: PoolClient, reservation: any, quote: any, effectiveFrom: string, actor: string): Promise<void> {
  await client.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = $1 AND stay_date >= $2::date', [reservation.id, effectiveFrom]);
  for (const night of quote.nightly_breakdown) {
    await client.query(
      `INSERT INTO reservation_nightly_rates (
        reservation_id, property_id, stay_date, room_type_id, room_type_code_snapshot, room_type_name_snapshot,
        rate_plan_id, rate_plan_code_snapshot, rate_plan_name_snapshot, meal_plan_id, meal_plan_code_snapshot, meal_plan_name_snapshot,
        base_rate, applied_override_rate, final_room_rate, service_amount, tax_amount, total_amount, is_manual_override, manual_override_reason
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,FALSE,NULL)`,
      [reservation.id, reservation.property_id, night.stay_date, quote.room_type.id, quote.room_type.code, quote.room_type.name,
        quote.rate_plan.id || null, quote.rate_plan.code, quote.rate_plan.name, quote.rate_plan.meal_plan_id || null,
        quote.rate_plan.meal_plan_code || quote.rate_plan.meal_plan, quote.rate_plan.meal_plan_name || quote.rate_plan.meal_plan,
        night.base_rate, night.applied_override_rate, night.final_room_rate, night.service_amount, night.tax_amount, night.total_amount]
    );
  }
  const summary = await client.query(
    `SELECT COALESCE(SUM(final_room_rate),0) AS subtotal, COALESCE(SUM(service_amount),0) AS service,
            COALESCE(SUM(tax_amount),0) AS tax, COALESCE(SUM(total_amount),0) AS grand
     FROM reservation_nightly_rates WHERE reservation_id = $1`, [reservation.id]
  );
  const totals = summary.rows[0];
  const totalPrice = Math.max(0, Number(totals.grand) - Number(reservation.discount_amount || 0));
  const paid = Number(reservation.amount_paid || 0) + Number(reservation.applied_deposit || 0);
  await client.query(
    `UPDATE reservations SET rate_plan_id=$1, rate_plan_code_snapshot=$2, rate_plan_name_snapshot=$3,
       meal_plan_id=$4, meal_plan_code_snapshot=$5, meal_plan_name_snapshot=$6,
       subtotal_amount=$7, service_amount=$8, tax_amount=$9, total_price=$10,
       remaining_balance=GREATEST(0,$10-COALESCE(amount_paid,0)-COALESCE(applied_deposit,0)),
       payment_status=CASE WHEN $11 >= $10 THEN 'PAID' WHEN $11 > 0 THEN 'PARTIAL' ELSE 'UNPAID' END,
       is_manual_override=FALSE, manual_override_reason=NULL WHERE id=$12`,
    [quote.rate_plan.id || null, quote.rate_plan.code, quote.rate_plan.name, quote.rate_plan.meal_plan_id || null,
      quote.rate_plan.meal_plan_code || quote.rate_plan.meal_plan, quote.rate_plan.meal_plan_name || quote.rate_plan.meal_plan,
      totals.subtotal, totals.service, totals.tax, totalPrice, paid, reservation.id]
  );
  await client.query(
    `UPDATE folio_entries SET amount=$1, base_amount=$2, tax_amount=$3, service_amount=$4,
       description=COALESCE(description, 'Room charge') || ' (Room move repriced)'
     WHERE reservation_id=$5 AND entry_type='ROOM_CHARGE' AND is_voided=FALSE`,
    [totalPrice, totals.subtotal, totals.tax, totals.service, reservation.id]
  );
}

export async function executeRoomMove(pool: Pool, reservationId: number, input: any, actor?: RoomMoveActor, correlationId?: string | null) {
  const propertyId = Number(input.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) throw roomMoveError('property_id tidak valid.', 'VALIDATION_ERROR');
  const { targetRoomId, category, detail, pricingTreatment } = validateMoveInput(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const initial = await client.query('SELECT room_id FROM reservations WHERE id = $1', [reservationId]);
    if (initial.rowCount !== 1) throw roomMoveError('Reservasi tidak ditemukan.', 'RESERVATION_NOT_FOUND', 404);
    const roomIds = Array.from(new Set([Number(initial.rows[0].room_id), targetRoomId])).sort((a, b) => a - b);
    for (const roomId of roomIds) await client.query('SELECT id FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
    const reservation = await getReservationForMove(client, reservationId, true);
    if (Number(reservation.property_id) !== propertyId) throw roomMoveError('Reservasi bukan milik properti aktif.', 'PROPERTY_MISMATCH', 403);
    if (String(reservation.status).toUpperCase() !== 'CHECKED_IN') throw roomMoveError('Pindah kamar hanya tersedia untuk tamu yang sudah check-in.', 'CHECKED_IN_RESERVATION_REQUIRED', 409);
    const idempotencyKey = input.idempotency_key || null;
    if (idempotencyKey) {
      const prior = await client.query(
        `SELECT id, reservation_id, from_room_id, to_room_id, effective_from_date
         FROM reservation_room_moves WHERE property_id=$1 AND idempotency_key=$2 FOR UPDATE`,
        [propertyId, idempotencyKey]
      );
      if (prior.rowCount === 1) {
        if (Number(prior.rows[0].reservation_id) !== Number(reservation.id)) {
          throw roomMoveError('Kunci permintaan sudah digunakan untuk perpindahan lain.', 'IDEMPOTENCY_KEY_CONFLICT', 409);
        }
        await client.query('COMMIT');
        return {
          movement: prior.rows[0], reservation_id: Number(reservation.id),
          from_room_id: Number(prior.rows[0].from_room_id), to_room_id: Number(prior.rows[0].to_room_id), pricing: null
        };
      }
    }
    if (Number(reservation.room_id) === targetRoomId) throw roomMoveError('Kamar tujuan sama dengan kamar saat ini.', 'TARGET_ROOM_SAME');
    const target = await getTargetRoom(client, targetRoomId, propertyId);
    await assertTargetAvailable(client, reservation, target);
    // Preserve the checked-in hotel date as historical context. The physical
    // move is immediate, while inventory/rate context takes effect next night.
    const effectiveFrom = addHotelDays(hotelDateFromInstant(new Date()), 1);
    const crossType = Number(reservation.current_room_type_id) !== Number(target.room_type_id);
    if (crossType && !pricingTreatment) throw roomMoveError('Treatment tarif wajib dipilih untuk perubahan tipe kamar.', 'PRICING_TREATMENT_REQUIRED');
    if (reservation.ota_source_id != null && pricingTreatment === 'APPLY_NEW_RATE') {
      throw roomMoveError('Tarif OTA manual tetap dipertahankan. Penyesuaian OTA memerlukan alur khusus.', 'OTA_MANUAL_RATE_PRESERVED', 409);
    }
    const pricing = await buildPricingPreview(client, reservation, Number(target.room_type_id), input.rate_plan_id);
    if (pricingTreatment === 'APPLY_NEW_RATE' && !pricing.quote) {
      throw roomMoveError('Quote tarif baru tidak tersedia untuk sisa masa inap.', 'NEW_RATE_QUOTE_UNAVAILABLE', 409);
    }
    await reassignMoveInventory(client, reservation, Number(reservation.current_room_type_id), Number(target.room_type_id), effectiveFrom);
    const oldRateContext = {
      total_price: Number(reservation.total_price || 0), rate_plan_id: reservation.rate_plan_id,
      rate_plan_name: reservation.rate_plan_name_snapshot, ota_manual_rate: reservation.ota_source_id != null
    };
    const newRateContext = pricingTreatment === 'APPLY_NEW_RATE'
      ? { quoted_total: pricing.quoted_total, difference: pricing.difference, rate_plan: pricing.quote?.rate_plan || null }
      : { preserved_total: Number(reservation.total_price || 0), target_room_type_id: Number(target.room_type_id) };
    const actorName = roomMoveActorName(actor);
    const movement = await client.query(
      `INSERT INTO reservation_room_moves (
        reservation_id, property_id, from_room_id, to_room_id, from_room_type_id, to_room_type_id,
        effective_from_date, moved_at, moved_by_user_id, moved_by, moved_by_role,
        reason_category, reason_detail, pricing_treatment, old_rate_context, new_rate_context, correlation_id, idempotency_key
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17) RETURNING *`,
      [reservation.id, propertyId, reservation.room_id, target.id, reservation.current_room_type_id, target.room_type_id,
        effectiveFrom, actor?.id || null, actorName, actor?.role || null, category, detail, pricingTreatment,
        JSON.stringify(oldRateContext), JSON.stringify(newRateContext), correlationId || null, idempotencyKey]
    );
    await client.query('UPDATE reservations SET room_id = $1 WHERE id = $2', [target.id, reservation.id]);
    await client.query(`UPDATE rooms SET status='VACANT_DIRTY' WHERE id=$1 AND property_id=$2 AND UPPER(COALESCE(status,'')) NOT IN ('OUT_OF_ORDER','OUT_OF_SERVICE')`, [reservation.room_id, propertyId]);
    await client.query(`UPDATE rooms SET status='OCCUPIED_CLEAN' WHERE id=$1 AND property_id=$2`, [target.id, propertyId]);
    await ensureDirtyRoomCleaningTask(client, propertyId, Number(reservation.room_id), {
      reservationId: Number(reservation.id), sourceType: 'ROOM_MOVE_EVENT', sourceEntityId: String(movement.rows[0].id),
      actor: { id: actor?.id, name: actorName, role: actor?.role }
    });
    if (pricingTreatment === 'APPLY_NEW_RATE') await applyFutureQuote(client, reservation, pricing.quote, effectiveFrom, actorName);
    if (pricingTreatment === 'KEEP_CURRENT_RATE' && crossType) {
      await client.query(
        `UPDATE reservation_nightly_rates
         SET room_type_id=$1, room_type_code_snapshot=$2, room_type_name_snapshot=$3,
             is_manual_override=TRUE, manual_override_reason=$4
         WHERE reservation_id=$5 AND stay_date >= $6::date`,
        [target.room_type_id, target.room_type_code, target.room_type_name,
          'Tarif dipertahankan saat pindah kamar.', reservation.id, effectiveFrom]
      );
      await client.query(`UPDATE reservations SET is_manual_override=TRUE, manual_override_reason=$1 WHERE id=$2`, ['Tarif dipertahankan saat pindah kamar.', reservation.id]);
    }
    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ('PMS','ROOM_MOVE','RESERVATION',$1,$2,$3,$4)`,
      [reservation.id, JSON.stringify({ room_move_id: movement.rows[0].id, from_room_id: reservation.room_id, to_room_id: target.id, reason_category: category, pricing_treatment: pricingTreatment, effective_from_date: effectiveFrom }), correlationId || null, propertyId]
    );
    await client.query('COMMIT');
    return { movement: movement.rows[0], reservation_id: Number(reservation.id), from_room_id: Number(reservation.room_id), to_room_id: Number(target.id), pricing };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function releaseReservationInventoryForCheckout(client: PoolClient, reservation: any): Promise<void> {
  const checkIn = hotelDateKey(reservation.check_in);
  const checkOut = hotelDateKey(reservation.check_out);
  const baseTypeId = Number(reservation.booked_room_type_id_snapshot || reservation.current_room_type_id);
  const moves = await client.query(
    `SELECT to_room_type_id, effective_from_date FROM reservation_room_moves
     WHERE reservation_id=$1 ORDER BY effective_from_date, id`, [reservation.id]
  );
  const movesByDate = new Map<string, number>();
  for (const move of moves.rows) movesByDate.set(hotelDateKey(move.effective_from_date), Number(move.to_room_type_id));
  let activeTypeId = baseTypeId;
  const datesByType = new Map<number, string[]>();
  for (const date of enumerateHotelDates(checkIn, checkOut)) {
    activeTypeId = movesByDate.get(date) || activeTypeId;
    const dates = datesByType.get(activeTypeId) || [];
    dates.push(date);
    datesByType.set(activeTypeId, dates);
  }
  const keys = [...datesByType.entries()].flatMap(([roomTypeId, dates]) => dates.map(date => ({ roomTypeId, date })));
  const rows = await lockCanonicalAvailabilityRows(client, keys);
  for (const [roomTypeId, dates] of datesByType) {
    for (const date of dates) {
      const row = rows.get(canonicalAvailabilityKey(roomTypeId, date))!;
      if (row.reservedQty < 1) throw roomMoveError(`Inventori tidak konsisten saat checkout pada ${date}.`, 'INVENTORY_INTEGRITY_ERROR', 409);
    }
  }
  for (const [roomTypeId, dates] of datesByType) {
    for (const date of dates) await mutateCanonicalAvailabilityRow(client, rows.get(canonicalAvailabilityKey(roomTypeId, date))!, -1);
  }
}

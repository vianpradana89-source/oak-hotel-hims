import { Pool, PoolClient } from 'pg';
import {
  CanonicalPriceQuoteError,
  CANONICAL_PRICE_QUOTE_FAILED,
  resolveAuthoritativeRoomGross
} from '../pricing/bookingPricingAuthority';
import { calculatePriceQuote, createReservationRateSnapshots, toHotelDateString } from '../pricing/pricingService';
import type { PriceQuoteResult } from '../pricing/pricingTypes';
import { projectFolioEntryToTransaction } from '../transactions/transactionService';
import {
  allocateCommercialDiscount,
  computeAuthoritativeDiscount,
  ReservationBillingError,
  roundIdr
} from './reservationBilling';

export { CANONICAL_PRICE_QUOTE_FAILED };

export const BOOKED_RESERVATION_REQUIRED = 'BOOKED_RESERVATION_REQUIRED';
export const MULTI_ROOM_GLOBAL_DISCOUNT_REPRICE_UNSUPPORTED = 'MULTI_ROOM_GLOBAL_DISCOUNT_REPRICE_UNSUPPORTED';
export const RATE_PLAN_ROOM_TYPE_MISMATCH = 'RATE_PLAN_ROOM_TYPE_MISMATCH';
export const OTA_REPRICE_NOT_SUPPORTED = 'OTA_REPRICE_NOT_SUPPORTED';
export const REPRICE_REASON_REQUIRED = 'REPRICE_REASON_REQUIRED';

export class BookedRepriceError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'BookedRepriceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface BookedRepriceInput {
  property_id: number;
  rate_plan_id?: number | null;
  reason?: string;
  actor?: string;
}

export interface BookedRepriceTotals {
  gross: number;
  discount: number;
  net: number;
  paid: number;
  remaining: number;
  payment_status: string;
  rate_plan_id: number | null;
}

export interface BookedRepricePlan {
  reservation_id: number;
  booking_id: number;
  bid: string | null;
  property_id: number;
  status: string;
  canonical_room_type_id: number;
  rate_plan_id: number;
  rate_plan_code: string | null;
  stay_type: string;
  check_in: string;
  check_out: string;
  is_manual_override: false;
  quote: {
    room_subtotal: number;
    grand_total: number;
    nights: number;
    stay_date: string | null;
    base_rate: number | null;
    applied_override_rate: number | null;
    rate_source: 'RATE_OVERRIDE' | 'BAR';
  };
  before: BookedRepriceTotals;
  after: BookedRepriceTotals;
  discount: {
    source: 'GLOBAL_DISCOUNT' | 'RESERVATION_DISCOUNT';
    type: string | null;
    value: number;
    reason: string | null;
  };
  quote_result: PriceQuoteResult;
  room_discount: number;
  stay_gross: number;
  current_row: any;
  booking_row: any;
}

function hotelDate(value: unknown): string {
  if (value instanceof Date) return toHotelDateString(value);
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : toHotelDateString(new Date(String(value)));
}

function paymentStatusFor(net: number, paid: number): string {
  const remaining = Math.max(0, net - paid);
  if (paid <= 0) return 'UNPAID';
  if (remaining <= 0.01) return 'PAID';
  return 'PARTIAL';
}

function throwHttp(statusCode: number, code: string, message: string): never {
  throw new BookedRepriceError(statusCode, code, message);
}

function assertBookedStatus(status: unknown): void {
  if (String(status || '').toUpperCase() !== 'BOOKED') {
    throwHttp(
      409,
      BOOKED_RESERVATION_REQUIRED,
      'Koreksi tarif hanya tersedia untuk reservasi BOOKED sebelum check-in.'
    );
  }
}

async function loadContext(
  client: PoolClient | Pool,
  reservationId: number,
  propertyId: number,
  forUpdate: boolean
) {
  const lockSql = forUpdate ? 'FOR UPDATE OF r, b' : '';
  const res = await client.query(
    `SELECT r.*, b.property_id, b.bid, b.global_discount_type, b.global_discount_value,
            b.global_discount_amount, b.global_discount_reason,
            b.global_discount_gross_before, b.global_discount_net_after,
            b.booking_channel, b.booking_source, b.ota_source_id AS booking_ota_source_id
     FROM reservations r
     JOIN bookings b ON b.id = r.booking_id
     WHERE r.id = $1
     ${lockSql}`,
    [reservationId]
  );
  if (res.rows.length === 0) {
    throwHttp(404, 'NOT_FOUND', `Reservasi #${reservationId} tidak ditemukan.`);
  }
  const row = res.rows[0];
  if (Number(row.property_id) !== Number(propertyId)) {
    throwHttp(403, 'PROPERTY_MISMATCH', `Reservasi #${reservationId} bukan milik properti #${propertyId}`);
  }
  assertBookedStatus(row.status);

  const isOta = row.ota_source_id != null
    || row.booking_ota_source_id != null
    || String(row.booking_channel || '').toUpperCase() === 'OTA'
    || String(row.booking_type || '').toUpperCase() === 'OTA';
  if (isOta) {
    throwHttp(409, OTA_REPRICE_NOT_SUPPORTED, 'Koreksi tarif canonical tidak tersedia untuk reservasi OTA.');
  }

  if (!row.room_id) {
    throwHttp(409, 'ROOM_ASSIGNMENT_REQUIRED', 'Reservasi belum memiliki kamar fisik.');
  }

  const roomSql = forUpdate
    ? `SELECT id, room_type_id, property_id, room_number, status FROM rooms WHERE id = $1 FOR UPDATE`
    : `SELECT id, room_type_id, property_id, room_number, status FROM rooms WHERE id = $1`;
  const roomRes = await client.query(roomSql, [row.room_id]);
  if (roomRes.rows.length === 0) {
    throwHttp(409, 'ROOM_NOT_FOUND', `Kamar #${row.room_id} tidak ditemukan.`);
  }
  const room = roomRes.rows[0];
  if (Number(room.property_id) !== Number(propertyId)) {
    throwHttp(403, 'PROPERTY_MISMATCH', `Kamar bukan milik properti #${propertyId}`);
  }
  const canonicalRoomTypeId = Number(room.room_type_id);
  if (!Number.isFinite(canonicalRoomTypeId) || canonicalRoomTypeId <= 0) {
    throwHttp(409, 'ROOM_TYPE_MISSING', 'Kamar fisik tidak memiliki room_type_id canonical.');
  }

  return { reservation: row, room, canonicalRoomTypeId, propertyId: Number(row.property_id) };
}

async function countActiveSiblings(client: PoolClient | Pool, bookingId: number, reservationId: number): Promise<number> {
  const res = await client.query(
    `SELECT COUNT(*)::int AS n
     FROM reservations
     WHERE booking_id = $1
       AND id <> $2
       AND UPPER(COALESCE(status, '')) <> 'CANCELLED'`,
    [bookingId, reservationId]
  );
  return Number(res.rows[0]?.n || 0);
}

async function stayDebitGross(client: PoolClient | Pool, reservationId: number): Promise<number> {
  const res = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS stay_gross
     FROM folio_entries
     WHERE reservation_id = $1
       AND COALESCE(is_voided, FALSE) = FALSE
       AND direction = 'DEBIT'
       AND entry_type NOT IN ('ROOM_CHARGE', 'PAYMENT', 'DISCOUNT')`,
    [reservationId]
  );
  return Math.max(0, roundIdr(res.rows[0]?.stay_gross));
}

async function resolveCompatibleRatePlan(
  client: PoolClient | Pool,
  propertyId: number,
  canonicalRoomTypeId: number,
  stayType: string,
  requestedPlanId: unknown
) {
  const planId = Number(requestedPlanId);
  if (!Number.isInteger(planId) || planId <= 0) {
    throwHttp(
      400,
      'RATE_PLAN_REQUIRED',
      'Pilih rate plan yang sesuai dengan tipe kamar canonical. Rate plan tidak boleh dikira dari nama atau kode.'
    );
  }
  const planRes = await client.query(
    `SELECT id, room_type_id, code, name, rate_type, is_active, is_archived, base_rate
     FROM rate_plans
     WHERE id = $1 AND property_id = $2`,
    [planId, propertyId]
  );
  if (planRes.rows.length === 0) {
    throwHttp(400, 'RATE_PLAN_NOT_FOUND', `Rate plan #${planId} tidak ditemukan untuk properti ini.`);
  }
  const plan = planRes.rows[0];
  if (Number(plan.room_type_id) !== Number(canonicalRoomTypeId)) {
    throwHttp(
      400,
      RATE_PLAN_ROOM_TYPE_MISMATCH,
      'Rate plan tidak sesuai dengan tipe kamar canonical. Pilih rate plan yang room_type_id-nya sama persis.'
    );
  }
  if (plan.is_active === false || plan.is_archived === true) {
    throwHttp(400, 'RATE_PLAN_INACTIVE', `Rate plan ${plan.code} tidak aktif.`);
  }
  const isDayUse = stayType === 'DAY_USE';
  if (isDayUse && plan.rate_type === 'OVERNIGHT') {
    throwHttp(400, 'RATE_PLAN_STAY_TYPE_MISMATCH', `Rate plan ${plan.code} adalah OVERNIGHT dan tidak dapat dipakai untuk DAY_USE.`);
  }
  if (!isDayUse && plan.rate_type === 'DAY_USE') {
    throwHttp(400, 'RATE_PLAN_STAY_TYPE_MISMATCH', `Rate plan ${plan.code} adalah DAY_USE dan tidak dapat dipakai untuk menginap overnight.`);
  }
  return plan;
}

function publicPlan(plan: BookedRepricePlan) {
  return {
    reservation_id: plan.reservation_id,
    booking_id: plan.booking_id,
    bid: plan.bid,
    property_id: plan.property_id,
    status: plan.status,
    canonical_room_type_id: plan.canonical_room_type_id,
    rate_plan_id: plan.rate_plan_id,
    rate_plan_code: plan.rate_plan_code,
    stay_type: plan.stay_type,
    check_in: plan.check_in,
    check_out: plan.check_out,
    is_manual_override: plan.is_manual_override,
    quote: plan.quote,
    before: plan.before,
    after: plan.after,
    discount: plan.discount
  };
}

export async function computeBookedReservationReprice(
  client: PoolClient | Pool,
  reservationId: number,
  input: BookedRepriceInput,
  forUpdate = false
): Promise<BookedRepricePlan> {
  const propertyId = Number(input.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throwHttp(400, 'VALIDATION_ERROR', 'property_id tidak valid.');
  }

  const ctx = await loadContext(client, reservationId, propertyId, forUpdate);
  const current = ctx.reservation;
  const stayType = String(current.stay_type || 'OVERNIGHT').toUpperCase();
  const checkIn = hotelDate(current.check_in);
  const checkOut = hotelDate(current.check_out);
  const requestedPlanId = input.rate_plan_id !== undefined ? input.rate_plan_id : current.rate_plan_id;
  const ratePlan = await resolveCompatibleRatePlan(
    client,
    ctx.propertyId,
    ctx.canonicalRoomTypeId,
    stayType,
    requestedPlanId
  );

  const siblingCount = await countActiveSiblings(client, Number(current.booking_id), reservationId);
  const hasGlobalDiscount = Boolean(current.global_discount_type);
  if (siblingCount > 0 && hasGlobalDiscount) {
    throwHttp(
      409,
      MULTI_ROOM_GLOBAL_DISCOUNT_REPRICE_UNSUPPORTED,
      'Koreksi tarif dengan diskon keseluruhan belum didukung untuk booking multi-kamar. Alokasi sibling tidak diubah diam-diam.'
    );
  }

  let quote: PriceQuoteResult;
  try {
    quote = await calculatePriceQuote(client, {
      property_id: ctx.propertyId,
      room_type_id: ctx.canonicalRoomTypeId,
      rate_plan_id: Number(ratePlan.id),
      check_in: checkIn,
      check_out: stayType === 'DAY_USE' && checkOut === checkIn ? checkIn : checkOut,
      stay_type: stayType === 'DAY_USE' ? 'DAY_USE' : 'OVERNIGHT'
    });
  } catch (err: any) {
    if (err instanceof CanonicalPriceQuoteError) {
      throwHttp(err.statusCode, err.code, err.message);
    }
    throwHttp(
      400,
      CANONICAL_PRICE_QUOTE_FAILED,
      err?.message || 'Tarif kamar tidak dapat dihitung. Periksa tipe kamar dan rate plan, lalu coba lagi.'
    );
  }

  const roomGross = resolveAuthoritativeRoomGross({
    isManualOverride: false,
    frontendRoomGross: current.subtotal_amount,
    quoteRoomSubtotal: quote.room_subtotal,
    quoteAvailable: true
  });
  const stayGross = await stayDebitGross(client, reservationId);
  const discountBase = roomGross + stayGross;

  let discountSource: 'GLOBAL_DISCOUNT' | 'RESERVATION_DISCOUNT' = 'RESERVATION_DISCOUNT';
  let discountTypeInput: unknown = current.discount_type;
  let discountValueInput: unknown = current.discount_value;
  let discountPercentInput: unknown = current.discount_percent;
  let discountAmountInput: unknown = current.discount_amount;
  let discountReasonInput: unknown = current.discount_reason;

  if (hasGlobalDiscount) {
    discountSource = 'GLOBAL_DISCOUNT';
    discountTypeInput = current.global_discount_type;
    discountValueInput = current.global_discount_value;
    discountPercentInput = current.global_discount_type === 'PERCENTAGE' ? current.global_discount_value : 0;
    discountAmountInput = current.global_discount_amount;
    discountReasonInput = current.global_discount_reason || 'Diskon keseluruhan';
  }

  let computed;
  try {
    computed = computeAuthoritativeDiscount({
      gross: discountBase,
      discountType: discountTypeInput,
      discountValue: discountValueInput,
      discountPercent: discountPercentInput,
      discountAmount: discountAmountInput,
      discountReason: discountReasonInput
    });
  } catch (err: any) {
    if (err instanceof ReservationBillingError) {
      throwHttp(err.statusCode, err.code, err.message);
    }
    throw err;
  }

  const paid = Math.max(0, roundIdr(current.amount_paid) + roundIdr(current.applied_deposit));
  const newNet = Math.max(0, discountBase - computed.discount);
  const remaining = Math.max(0, newNet - paid);
  const allocation = allocateCommercialDiscount(roomGross, stayGross > 0 ? [stayGross] : [], computed.discount);
  const nightly = quote.nightly_breakdown[0];

  return {
    reservation_id: reservationId,
    booking_id: Number(current.booking_id),
    bid: current.bid ? String(current.bid) : null,
    property_id: ctx.propertyId,
    status: String(current.status),
    canonical_room_type_id: ctx.canonicalRoomTypeId,
    rate_plan_id: Number(ratePlan.id),
    rate_plan_code: ratePlan.code || null,
    stay_type: stayType,
    check_in: checkIn,
    check_out: checkOut,
    is_manual_override: false,
    quote: {
      room_subtotal: roomGross,
      grand_total: roundIdr(quote.grand_total),
      nights: Number(quote.nights || 0),
      stay_date: nightly ? String(nightly.stay_date).slice(0, 10) : null,
      base_rate: nightly ? roundIdr(nightly.base_rate) : roundIdr(ratePlan.base_rate),
      applied_override_rate: nightly?.applied_override_rate == null ? null : roundIdr(nightly.applied_override_rate),
      rate_source: nightly?.applied_override_rate != null ? 'RATE_OVERRIDE' : 'BAR'
    },
    before: {
      gross: Math.max(0, roundIdr(current.subtotal_amount || current.total_price)),
      discount: Math.max(0, roundIdr(current.discount_amount)),
      net: Math.max(0, roundIdr(current.total_price)),
      paid: Math.max(0, roundIdr(current.amount_paid)),
      remaining: Math.max(0, roundIdr(current.remaining_balance)),
      payment_status: String(current.payment_status || 'UNPAID'),
      rate_plan_id: current.rate_plan_id ? Number(current.rate_plan_id) : null
    },
    after: {
      gross: roomGross,
      discount: computed.discount,
      net: newNet,
      paid: Math.max(0, roundIdr(current.amount_paid)),
      remaining,
      payment_status: paymentStatusFor(newNet, paid),
      rate_plan_id: Number(ratePlan.id)
    },
    discount: {
      source: discountSource,
      type: computed.discountType,
      value: computed.discountValue,
      reason: computed.reason
    },
    quote_result: quote,
    room_discount: allocation.roomDiscount,
    stay_gross: stayGross,
    current_row: current,
    booking_row: current
  };
}

export async function previewBookedReservationReprice(
  pool: Pool,
  reservationId: number,
  input: BookedRepriceInput
) {
  const plan = await computeBookedReservationReprice(pool, reservationId, input, false);
  return publicPlan(plan);
}

async function upsertRoomCharge(
  client: PoolClient,
  reservationId: number,
  propertyId: number,
  gross: number
): Promise<number> {
  const existing = await client.query(
    `SELECT id FROM folio_entries
     WHERE reservation_id = $1
       AND entry_type = 'ROOM_CHARGE'
       AND COALESCE(is_voided, FALSE) = FALSE
     ORDER BY id ASC
     FOR UPDATE`,
    [reservationId]
  );
  if (existing.rows.length > 1) {
    throwHttp(409, 'FOLIO_ROOM_CHARGE_AMBIGUOUS', 'Reservasi memiliki lebih dari satu ROOM_CHARGE aktif.');
  }
  if (existing.rows.length === 1) {
    await client.query(
      `UPDATE folio_entries
       SET amount = $1, base_amount = $1, unit_price = $1, quantity = 1, tax_amount = 0, service_amount = 0
       WHERE id = $2`,
      [gross, existing.rows[0].id]
    );
    return Number(existing.rows[0].id);
  }
  const inserted = await client.query(
    `INSERT INTO folio_entries (
       reservation_id, property_id, entry_type, source_type, description, amount, base_amount, unit_price, quantity, direction
     ) VALUES ($1, $2, 'ROOM_CHARGE', 'ROOM_CHARGE', 'Reservasi kamar', $3, $3, $3, 1, 'DEBIT')
     RETURNING id`,
    [reservationId, propertyId, gross]
  );
  return Number(inserted.rows[0].id);
}

async function upsertDiscountCredit(
  client: PoolClient,
  reservationId: number,
  propertyId: number,
  bookingId: number,
  discount: number,
  source: 'GLOBAL_DISCOUNT' | 'RESERVATION_DISCOUNT',
  reason: string | null
): Promise<void> {
  const existing = await client.query(
    `SELECT id FROM folio_entries
     WHERE reservation_id = $1
       AND entry_type = 'DISCOUNT'
       AND COALESCE(is_voided, FALSE) = FALSE
     ORDER BY id ASC
     FOR UPDATE`,
    [reservationId]
  );
  if (existing.rows.length > 1) {
    throwHttp(409, 'FOLIO_DISCOUNT_AMBIGUOUS', 'Reservasi memiliki lebih dari satu DISCOUNT CREDIT aktif.');
  }
  if (discount <= 0) {
    if (existing.rows.length === 1) {
      await client.query(
        `UPDATE folio_entries SET amount = 0 WHERE id = $1`,
        [existing.rows[0].id]
      );
    }
    return;
  }
  const description = source === 'GLOBAL_DISCOUNT'
    ? (reason ? `Diskon Keseluruhan: ${reason}` : 'Diskon Keseluruhan')
    : (reason ? `Diskon: ${reason}` : 'Diskon Reservasi');
  if (existing.rows.length === 1) {
    await client.query(
      `UPDATE folio_entries
       SET amount = $1, source_type = $2, source_id = $3, description = $4
       WHERE id = $5`,
      [discount, source, String(bookingId), description, existing.rows[0].id]
    );
    return;
  }
  await client.query(
    `INSERT INTO folio_entries (
       reservation_id, property_id, entry_type, source_type, source_id, description, amount, direction
     ) VALUES ($1, $2, 'DISCOUNT', $3, $4, $5, $6, 'CREDIT')`,
    [reservationId, propertyId, source, String(bookingId), description, discount]
  );
}

export async function executeBookedReservationReprice(
  pool: Pool,
  reservationId: number,
  input: BookedRepriceInput
) {
  const reason = String(input.reason || '').trim();
  if (!reason) {
    throwHttp(400, REPRICE_REASON_REQUIRED, 'Alasan koreksi tarif wajib diisi.');
  }
  const actor = String(input.actor || 'PMS');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const plan = await computeBookedReservationReprice(client, reservationId, input, true);

    const newNet = plan.after.net;
    const remaining = plan.after.remaining;
    const paymentStatus = plan.after.payment_status;

    if (plan.discount.source === 'GLOBAL_DISCOUNT') {
      await client.query(
        `UPDATE bookings
         SET global_discount_gross_before = $1,
             global_discount_amount = $2,
             global_discount_net_after = $3,
             updated_at = NOW()
         WHERE id = $4`,
        [plan.after.gross + plan.stay_gross, plan.after.discount, newNet, plan.booking_id]
      );
    }

    await client.query(`DELETE FROM reservation_nightly_rates WHERE reservation_id = $1`, [reservationId]);
    await createReservationRateSnapshots(client, reservationId, plan.property_id, plan.quote_result, {
      isManualOverride: false,
      manualOverrideReason: null
    });

    // createReservationRateSnapshots writes quote.grand_total onto reservations.
    // Commercial BOOKED correction must overwrite with room_subtotal / discount / net.
    await client.query(
      `UPDATE reservations
       SET rate_plan_id = $1,
           subtotal_amount = $2,
           discount_amount = $3,
           total_price = $4,
           remaining_balance = $5,
           payment_status = $6,
           is_manual_override = FALSE,
           tax_amount = 0,
           service_amount = 0
       WHERE id = $7`,
      [
        plan.rate_plan_id,
        plan.after.gross,
        plan.after.discount,
        newNet,
        remaining,
        paymentStatus,
        reservationId
      ]
    );

    const roomChargeId = await upsertRoomCharge(client, reservationId, plan.property_id, plan.after.gross);
    await upsertDiscountCredit(
      client,
      reservationId,
      plan.property_id,
      plan.booking_id,
      plan.after.discount,
      plan.discount.source,
      plan.discount.reason
    );

    await projectFolioEntryToTransaction(client, roomChargeId, {
      propertyId: plan.property_id,
      discountAmount: plan.room_discount,
      actorName: actor
    });

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'PMS',
        'BOOKED_RATE_CORRECTION',
        'RESERVATION',
        reservationId,
        JSON.stringify({
          reservation_id: reservationId,
          booking_id: plan.booking_id,
          bid: plan.bid,
          actor,
          reason,
          timestamp: new Date().toISOString(),
          canonical_room_type_id: plan.canonical_room_type_id,
          quote_source: plan.quote.rate_source,
          applied_override_rate: plan.quote.applied_override_rate,
          base_rate: plan.quote.base_rate,
          is_manual_override: false,
          before: plan.before,
          after: plan.after
        }),
        `REPRICE-${reservationId}-${Date.now()}`,
        plan.property_id
      ]
    );

    const updated = await client.query('SELECT * FROM reservations WHERE id = $1', [reservationId]);
    await client.query('COMMIT');
    return {
      reservation: updated.rows[0],
      preview: publicPlan(plan)
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'oak_hotel_db'
});

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function runUnitTests() {
  console.log('1. Unit tests: bookingPricingAuthority');
  const {
    shouldTrustFrontendRoomGross,
    resolveAuthoritativeRoomGross,
    CanonicalPriceQuoteError,
    CANONICAL_PRICE_QUOTE_FAILED,
    applyManualOverrideToQuote,
    commercialNetTotal
  } = require('../dist/domains/pricing/bookingPricingAuthority');

  expect(shouldTrustFrontendRoomGross(false) === false, 'C: override OFF does not trust frontend gross');
  expect(shouldTrustFrontendRoomGross(true) === true, 'F: override ON trusts frontend gross');

  const canonical = resolveAuthoritativeRoomGross({
    isManualOverride: false,
    frontendRoomGross: 510000,
    quoteRoomSubtotal: 640000,
    quoteAvailable: true
  });
  expect(canonical === 640000, 'C: override OFF uses quote 640000, not frontend 510000');

  const overridden = resolveAuthoritativeRoomGross({
    isManualOverride: true,
    frontendRoomGross: 510000,
    quoteRoomSubtotal: 640000,
    quoteAvailable: true
  });
  expect(overridden === 510000, 'F: override ON keeps explicit 510000');

  let failed = false;
  try {
    resolveAuthoritativeRoomGross({
      isManualOverride: false,
      frontendRoomGross: 510000,
      quoteAvailable: false
    });
  } catch (err) {
    failed = err instanceof CanonicalPriceQuoteError && err.code === CANONICAL_PRICE_QUOTE_FAILED;
  }
  expect(failed, 'E: override OFF + missing quote throws CanonicalPriceQuoteError');

  expect(commercialNetTotal(640000, 192000) === 448000, 'H: 640000 - 30% = 448000');

  const quote = {
    room_subtotal: 640000,
    tax_amount: 0,
    service_amount: 0,
    grand_total: 640000,
    nightly_breakdown: [
      { stay_date: '2026-09-12', final_room_rate: 640000, total_amount: 640000 }
    ]
  };
  applyManualOverrideToQuote(quote, 510000, 357000, 0, 0);
  expect(quote.room_subtotal === 510000, 'F: manual snapshot room_subtotal is override amount');
  expect(quote.nightly_breakdown[0].final_room_rate === 510000, 'F: nightly final_room_rate follows override');

  const indexSrc = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
  expect(!/child\.isManualOverride\s*\|\|\s*!child\.ratePlanId/.test(indexSrc), 'C: old quote-overwrite condition removed');
  expect(!indexSrc.includes('Number(child.roomGross ?? child.subtotalAmount ?? 0) > 0'), 'C: roomGross > 0 is not a reason to discard quote');
  expect(indexSrc.includes('resolveAuthoritativeRoomGross'), 'create path uses authoritative gross helper');
  expect(indexSrc.includes('allocateBookingPaymentToChildren'), 'M: payment allocation helper still used');
  expect(indexSrc.includes('buildBookingGlobalDiscount'), 'N: global discount helper still used');
  expect(indexSrc.includes("projectFolioEntryToTransaction"), 'K: Penjualan still projects booked folio');
}

async function runIntegrationTests() {
  console.log('2. Integration: quote override + booking create authority');
  const { initializeDatabase } = require('../dist/db/schema_v3');
  await initializeDatabase(pool);

  const { createCanonicalBooking } = require('../dist/index');
  const client = await pool.connect();
  const cleanup = {
    roomTypeIds: [],
    roomIds: [],
    ratePlanIds: [],
    overrideIds: [],
    bookingIds: [],
    reservationIds: [],
    mealPlanId: null
  };

  const fakeReq = (payload) => ({
    user: { username: 'FO.PBA', name: 'PBA Test' },
    body: payload,
    headers: { 'x-correlation-id': `PBA-${Date.now()}` }
  });

  const createBooking = async (payload) => {
    try {
      const result = await createCanonicalBooking(fakeReq(payload), payload, payload.reservations, { requirePropertyId: true });
      return { ok: true, status: 201, result, error: null };
    } catch (err) {
      return { ok: false, status: Number(err.statusCode || 500), result: null, error: err };
    }
  };

  try {
    await client.query("DELETE FROM rate_plans WHERE code IN ('TST-PBA-OUT-RO', 'TST-PBA-IN-RO')");
    await client.query("DELETE FROM rooms WHERE room_number IN ('971-PBA', '972-PBA')");
    await client.query("DELETE FROM room_types WHERE code IN ('TST-PBA-OUT', 'TST-PBA-IN')");
    await client.query("DELETE FROM meal_plans WHERE code = 'TST-PBA-BF'");

    const mpRes = await client.query(
      `INSERT INTO meal_plans (property_id, code, name, breakfast_included, is_active)
       VALUES (1, 'TST-PBA-BF', 'PBA Breakfast', true, true)
       RETURNING id`
    );
    cleanup.mealPlanId = mpRes.rows[0].id;

    const rtOut = (await client.query(
      `INSERT INTO room_types (property_id, code, name, base_rate, is_active)
       VALUES (1, 'TST-PBA-OUT', 'PBA PREMIERE TWIN ( OUT )', 0, true)
       RETURNING id`
    )).rows[0].id;
    cleanup.roomTypeIds.push(rtOut);

    const rtIn = (await client.query(
      `INSERT INTO room_types (property_id, code, name, base_rate, is_active)
       VALUES (1, 'TST-PBA-IN', 'PBA PREMIERE TWIN ( IN )', 510000, true)
       RETURNING id`
    )).rows[0].id;
    cleanup.roomTypeIds.push(rtIn);

    const roomOut = (await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES (1, $1, '971-PBA', 'PBA 971', 'VACANT_CLEAN', true)
       RETURNING id`,
      [rtOut]
    )).rows[0].id;
    cleanup.roomIds.push(roomOut);

    const roomIn = (await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES (1, $1, '972-PBA', 'PBA 972', 'VACANT_CLEAN', true)
       RETURNING id`,
      [rtIn]
    )).rows[0].id;
    cleanup.roomIds.push(roomIn);

    const planOut = (await client.query(
      `INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate, meal_plan, meal_plan_id, rate_type, is_active, sort_order)
       VALUES (1, $1, 'TST-PBA-OUT-RO', 'PBA OUT - RO', 588000, 'RO', $2, 'OVERNIGHT', true, 0)
       RETURNING id`,
      [rtOut, cleanup.mealPlanId]
    )).rows[0].id;
    cleanup.ratePlanIds.push(planOut);

    const planIn = (await client.query(
      `INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate, meal_plan, rate_type, is_active, sort_order)
       VALUES (1, $1, 'TST-PBA-IN-RO', 'PBA IN - RO', 510000, 'RO', 'OVERNIGHT', true, 0)
       RETURNING id`,
      [rtIn]
    )).rows[0].id;
    cleanup.ratePlanIds.push(planIn);

    const ov = (await client.query(
      `INSERT INTO rate_overrides (property_id, rate_plan_id, start_date, end_date, override_rate, reason, is_active)
       VALUES (1, $1, '2026-09-12', '2026-09-13', 640000, 'PBA 12 Sep override', true)
       RETURNING id`,
      [planOut]
    )).rows[0].id;
    cleanup.overrideIds.push(ov);

    for (const d of ['2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-20', '2026-09-21']) {
      await client.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES ($1, 'PBA PREMIERE TWIN ( OUT )', $2::date, 5, 0)`,
        [rtOut, d]
      );
      await client.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES ($1, 'PBA PREMIERE TWIN ( IN )', $2::date, 5, 0)`,
        [rtIn, d]
      );
    }

    const { calculatePriceQuote } = require('../dist/domains/pricing/pricingService');
    const quote = await calculatePriceQuote(client, {
      property_id: 1,
      room_type_id: rtOut,
      rate_plan_id: planOut,
      check_in: '2026-09-12',
      check_out: '2026-09-13',
      stay_type: 'OVERNIGHT'
    });
    expect(quote.nights === 1, 'I: 12 Sep -> 13 Sep is one night');
    expect(quote.nightly_breakdown[0].stay_date === '2026-09-12' || String(quote.nightly_breakdown[0].stay_date).slice(0, 10) === '2026-09-12', 'I: priced date is 12 Sep');
    expect(Number(quote.nightly_breakdown[0].final_room_rate) === 640000, 'D/I: 12 Sep override 640000 wins over BAR 588000');
    expect(Number(quote.room_subtotal) === 640000, 'D: room_subtotal is override');

    const barQuote = await calculatePriceQuote(client, {
      property_id: 1,
      room_type_id: rtOut,
      rate_plan_id: planOut,
      check_in: '2026-09-20',
      check_out: '2026-09-21',
      stay_type: 'OVERNIGHT'
    });
    expect(Number(barQuote.room_subtotal) === 588000, 'date without override uses BAR 588000');

    const walkinBase = {
      property_id: 1,
      guest_phone: '081200000001',
      booker_name: 'Booker PBA',
      booker_phone: '081200000001',
      guest_segment: 'Reguler',
      booking_source: 'WALKIN',
      booking_channel: 'WALK_IN',
      identity_number: '3275010101010001',
      payment_method: 'CASH',
      amount_paid: 0,
      currency_code: 'IDR'
    };

    const mismatchRes = await createBooking({
      ...walkinBase,
      guest_name: 'Tamu PBA Canonical',
      global_discount_type: 'PERCENTAGE',
      global_discount_value: 30,
      global_discount_reason: 'Tes otoritas tarif',
      reservations: [{
        room_id: roomOut,
        check_in: '2026-09-12',
        check_out: '2026-09-13',
        stay_type: 'OVERNIGHT',
        rate_plan_id: planOut,
        subtotal_amount: 510000,
        total_price: 510000,
        is_manual_override: false,
        qty: 1
      }]
    });
    expect(mismatchRes.ok, `C: booking create succeeded, got ${mismatchRes.status} ${mismatchRes.error?.message || ''}`);
    const bookingId = mismatchRes.result.booking.id;
    const reservationId = mismatchRes.result.reservations[0].id;
    cleanup.bookingIds.push(bookingId);
    cleanup.reservationIds.push(reservationId);

    const persisted = await client.query(
      `SELECT subtotal_amount, discount_amount, total_price, is_manual_override, rate_plan_id
       FROM reservations WHERE id = $1`,
      [reservationId]
    );
    expect(Number(persisted.rows[0].subtotal_amount) === 640000, 'C/J: reservation commercial gross is canonical 640000');
    expect(Number(persisted.rows[0].discount_amount) === 192000, 'H: 30% of 640000 = 192000');
    expect(Number(persisted.rows[0].total_price) === 448000, 'H: net is 448000');
    expect(persisted.rows[0].is_manual_override === false, 'C: manual override remains off');
    expect(Number(persisted.rows[0].rate_plan_id) === Number(planOut), 'rate plan is OUT RO');

    const folio = await client.query(
      `SELECT amount, entry_type FROM folio_entries
       WHERE reservation_id = $1 AND entry_type = 'ROOM_CHARGE' AND COALESCE(is_voided, FALSE) = FALSE`,
      [reservationId]
    );
    expect(folio.rows.length === 1, 'J: one ROOM_CHARGE');
    expect(Number(folio.rows[0].amount) === 640000, 'J: folio ROOM_CHARGE equals canonical 640000');

    const tx = await client.query(
      `SELECT amount, discount_amount FROM transactions
       WHERE reservation_id = $1 AND source_type = 'ROOM_CHARGE'
         AND reversal_of_transaction_id IS NULL`,
      [reservationId]
    );
    if (tx.rows.length > 0) {
      expect(Number(tx.rows[0].amount) === 640000, 'K: Penjualan booked gross is 640000');
      expect(Number(tx.rows[0].discount_amount || 0) === 192000, 'K: Penjualan discount follows booked 192000');
    }

    const failRes = await createBooking({
      ...walkinBase,
      guest_name: 'Tamu PBA QuoteFail',
      guest_phone: '081200000002',
      reservations: [{
        room_id: roomOut,
        check_in: '2026-09-13',
        check_out: '2026-09-14',
        stay_type: 'OVERNIGHT',
        rate_plan_id: planIn,
        subtotal_amount: 510000,
        total_price: 510000,
        is_manual_override: false,
        qty: 1
      }]
    });
    expect(failRes.status === 400, `E: wrong plan/type is rejected, got ${failRes.status} ${failRes.error?.message || ''}`);
    expect(failRes.error?.code === 'CANONICAL_PRICE_QUOTE_FAILED' || String(failRes.error?.message || '').includes('Rate Plan'), 'E: fail-closed pricing error');
    const leftover = await client.query(
      `SELECT id FROM reservations WHERE guest_name = 'Tamu PBA QuoteFail'`
    );
    expect(leftover.rows.length === 0, 'E: failed quote did not persist a reservation');

    const overrideRes = await createBooking({
      ...walkinBase,
      guest_name: 'Tamu PBA Override',
      guest_phone: '081200000003',
      reservations: [{
        room_id: roomIn,
        check_in: '2026-09-14',
        check_out: '2026-09-15',
        stay_type: 'OVERNIGHT',
        rate_plan_id: planIn,
        subtotal_amount: 510000,
        total_price: 510000,
        is_manual_override: true,
        manual_override_reason: 'Tes override harga manual',
        qty: 1
      }]
    });
    expect(overrideRes.ok, `F: manual override booking succeeded, got ${overrideRes.status} ${overrideRes.error?.message || ''}`);
    const overrideResId = overrideRes.result.reservations[0].id;
    cleanup.bookingIds.push(overrideRes.result.booking.id);
    cleanup.reservationIds.push(overrideResId);
    const overrideRow = await client.query(
      `SELECT subtotal_amount, is_manual_override, manual_override_reason FROM reservations WHERE id = $1`,
      [overrideResId]
    );
    expect(Number(overrideRow.rows[0].subtotal_amount) === 510000, 'F: explicit override 510000 persisted');
    expect(overrideRow.rows[0].is_manual_override === true, 'F: override flag stored');
    expect(overrideRow.rows[0].manual_override_reason === 'Tes override harga manual', 'F: override reason stored');

    const multiRes = await createBooking({
      ...walkinBase,
      guest_name: 'Tamu PBA Multi',
      guest_phone: '081200000004',
      reservations: [
        {
          room_id: roomOut,
          check_in: '2026-09-20',
          check_out: '2026-09-21',
          stay_type: 'OVERNIGHT',
          rate_plan_id: planOut,
          subtotal_amount: 1,
          total_price: 1,
          is_manual_override: false,
          qty: 1
        },
        {
          room_id: roomIn,
          check_in: '2026-09-20',
          check_out: '2026-09-21',
          stay_type: 'OVERNIGHT',
          rate_plan_id: planIn,
          subtotal_amount: 1,
          total_price: 1,
          is_manual_override: false,
          qty: 1
        }
      ]
    });
    expect(multiRes.ok, `L: multi-room succeeded, got ${multiRes.status} ${multiRes.error?.message || ''}`);
    const multiBookingId = multiRes.result.booking.id;
    cleanup.bookingIds.push(multiBookingId);
    const multiChildren = multiRes.result.reservations || [];
    for (const child of multiChildren) cleanup.reservationIds.push(child.id);
    const multiRows = await client.query(
      `SELECT r.id, r.room_id, r.subtotal_amount, r.rate_plan_id
       FROM reservations r
       WHERE r.booking_id = $1
       ORDER BY r.stay_sequence`,
      [multiBookingId]
    );
    const byRoom = new Map(multiRows.rows.map((row) => [Number(row.room_id), row]));
    expect(Number(byRoom.get(roomOut).subtotal_amount) === 588000, 'L: OUT child uses OUT BAR 588000');
    expect(Number(byRoom.get(roomIn).subtotal_amount) === 510000, 'L: IN child uses IN BAR 510000');
    expect(Number(byRoom.get(roomOut).rate_plan_id) === Number(planOut), 'L: OUT child keeps OUT plan');
    expect(Number(byRoom.get(roomIn).rate_plan_id) === Number(planIn), 'L: IN child keeps IN plan');
  } finally {
    try {
      if (cleanup.reservationIds.length > 0) {
        await client.query('DELETE FROM transactions WHERE reservation_id = ANY($1::int[])', [cleanup.reservationIds]).catch(() => {});
        await client.query('DELETE FROM payment_evidences WHERE reservation_id = ANY($1::int[])', [cleanup.reservationIds]).catch(() => {});
        await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [cleanup.reservationIds]).catch(() => {});
        await client.query('DELETE FROM reservation_guests WHERE reservation_id = ANY($1::int[])', [cleanup.reservationIds]).catch(() => {});
        await client.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])', [cleanup.reservationIds]).catch(() => {});
        await client.query('DELETE FROM availability_locks WHERE reservation_id = ANY($1::int[])', [cleanup.reservationIds]).catch(() => {});
        await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [cleanup.reservationIds]).catch(() => {});
        await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [cleanup.reservationIds]);
      }
      if (cleanup.bookingIds.length > 0) {
        await client.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [cleanup.bookingIds]);
      }
      if (cleanup.overrideIds.length > 0) {
        await client.query('DELETE FROM rate_overrides WHERE id = ANY($1::int[])', [cleanup.overrideIds]);
      }
      if (cleanup.ratePlanIds.length > 0) {
        await client.query('DELETE FROM rate_plans WHERE id = ANY($1::int[])', [cleanup.ratePlanIds]);
      }
      if (cleanup.roomIds.length > 0) {
        await client.query('DELETE FROM rooms WHERE id = ANY($1::int[])', [cleanup.roomIds]);
      }
      if (cleanup.roomTypeIds.length > 0) {
        await client.query('DELETE FROM availability_dates WHERE room_type_id = ANY($1::int[])', [cleanup.roomTypeIds]);
        await client.query('DELETE FROM room_types WHERE id = ANY($1::int[])', [cleanup.roomTypeIds]);
      }
      if (cleanup.mealPlanId) {
        await client.query('DELETE FROM meal_plans WHERE id = $1', [cleanup.mealPlanId]);
      }
    } catch (cleanErr) {
      console.warn('Cleanup warning:', cleanErr.message);
    }
    client.release();
  }
}

async function main() {
  console.log('=== QUICK-BOOKING-PRICING-AUTHORITY-1 backend ===\n');
  try {
    await runUnitTests();
    await runIntegrationTests();
    console.log('\nPASS booking pricing authority tests');
  } catch (err) {
    console.error('TEST FAILED:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
    setTimeout(() => process.exit(process.exitCode || 0), 50);
  }
}

main();

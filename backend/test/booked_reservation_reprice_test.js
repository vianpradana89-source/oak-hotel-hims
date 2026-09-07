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

async function run() {
  console.log('=== BOOKED-RESERVATION-REPRICE-1 backend ===\n');

  const serviceSrc = fs.readFileSync(path.resolve(__dirname, '../src/domains/reservations/bookedReservationRepriceService.ts'), 'utf8');
  expect(serviceSrc.includes('quote.room_subtotal'), 'M: commercial gross uses quote.room_subtotal');
  expect(!/after\.gross\s*=\s*.*grand_total/.test(serviceSrc), 'M: grand_total is not assigned as commercial gross');
  expect(serviceSrc.includes("status = BOOKED") || serviceSrc.includes("!== 'BOOKED'"), 'status guard uses BOOKED');
  expect(serviceSrc.includes('MULTI_ROOM_GLOBAL_DISCOUNT_REPRICE_UNSUPPORTED'), 'N: multi-room global discount fails closed');

  const indexSrc = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
  expect(indexSrc.includes("'/api/reservations/:id/reprice'"), 'dedicated reprice endpoint exists');
  expect(indexSrc.includes('executeBookedReservationReprice'), 'endpoint uses dedicated service');
  expect(!/reprice[\s\S]{0,400}executeReservationEditWithPayment/.test(indexSrc), 'reprice does not route through edit-with-payment');

  const { initializeDatabase } = require('../dist/db/schema_v3');
  await initializeDatabase(pool);
  const {
    executeBookedReservationReprice,
    previewBookedReservationReprice,
    BOOKED_RESERVATION_REQUIRED,
    RATE_PLAN_ROOM_TYPE_MISMATCH,
    MULTI_ROOM_GLOBAL_DISCOUNT_REPRICE_UNSUPPORTED,
    CANONICAL_PRICE_QUOTE_FAILED
  } = require('../dist/domains/reservations/bookedReservationRepriceService');
  const { projectFolioEntryToTransaction } = require('../dist/domains/transactions/transactionService');

  const client = await pool.connect();
  const cleanup = {
    roomTypeIds: [],
    roomIds: [],
    ratePlanIds: [],
    overrideIds: [],
    bookingIds: [],
    reservationIds: []
  };

  const checkIn = '2026-09-12';
  const checkOut = '2026-09-13';

  try {
    const propertyId = 1;
    const suffix = `BRP${Date.now().toString().slice(-8)}`;

    const rtOut = (await client.query(
      `INSERT INTO room_types (property_id, code, name, base_rate, is_active)
       VALUES ($1, $2, $3, 0, true) RETURNING id`,
      [propertyId, `${suffix}-OUT`, `BRP PREMIERE TWIN ( OUT ) ${suffix}`]
    )).rows[0].id;
    cleanup.roomTypeIds.push(rtOut);

    const rtIn = (await client.query(
      `INSERT INTO room_types (property_id, code, name, base_rate, is_active)
       VALUES ($1, $2, $3, 510000, true) RETURNING id`,
      [propertyId, `${suffix}-IN`, `BRP PREMIERE TWIN ( IN ) ${suffix}`]
    )).rows[0].id;
    cleanup.roomTypeIds.push(rtIn);

    const planOut = (await client.query(
      `INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate, meal_plan, rate_type, is_active, sort_order)
       VALUES ($1, $2, $3, $4, 588000, 'RO', 'OVERNIGHT', true, 0) RETURNING id`,
      [propertyId, rtOut, `${suffix}-OUT-RO`, `${suffix} OUT RO`]
    )).rows[0].id;
    cleanup.ratePlanIds.push(planOut);

    const planIn = (await client.query(
      `INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate, meal_plan, rate_type, is_active, sort_order)
       VALUES ($1, $2, $3, $4, 510000, 'RO', 'OVERNIGHT', true, 0) RETURNING id`,
      [propertyId, rtIn, `${suffix}-IN-RO`, `${suffix} IN RO`]
    )).rows[0].id;
    cleanup.ratePlanIds.push(planIn);

    const ov = (await client.query(
      `INSERT INTO rate_overrides (property_id, rate_plan_id, start_date, end_date, override_rate, reason, is_active)
       VALUES ($1, $2, $3, $4, 640000, 'BRP 12 Sep', true) RETURNING id`,
      [propertyId, planOut, checkIn, checkOut]
    )).rows[0].id;
    cleanup.overrideIds.push(ov);

    let roomSeq = 0;
    const insertPhysicalRoom = async () => {
      roomSeq += 1;
      const room = await client.query(
        `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
         VALUES ($1, $2, $3, $3, 'VACANT_CLEAN', true) RETURNING id`,
        [propertyId, rtOut, `BRP-${suffix}-R${roomSeq}`]
      );
      cleanup.roomIds.push(room.rows[0].id);
      return room.rows[0].id;
    };

    const insertBookedChild = async (extras = {}) => {
      const roomId = extras.room_id || await insertPhysicalRoom();
      const booking = await client.query(
        `INSERT INTO bookings (
           property_id, bid, guest_name_snapshot, booking_status, booking_channel, booking_source,
           global_discount_type, global_discount_value, global_discount_amount, global_discount_reason,
           global_discount_gross_before, global_discount_net_after
         ) VALUES ($1, $2, $3, 'ACTIVE', 'WALK_IN', 'WALKIN',
           'PERCENTAGE', 30, 153000, 'Promo 30%', 510000, 357000)
         RETURNING id, bid`,
        [propertyId, `BRP-${suffix}-${String(Date.now()).slice(-8)}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`, `Tamu ${suffix}`]
      );
      const bookingId = booking.rows[0].id;
      cleanup.bookingIds.push(bookingId);
      const reservation = await client.query(
        `INSERT INTO reservations (
           booking_id, room_id, booked_room_type_id_snapshot, rate_plan_id,
           guest_name, check_in, check_out, stay_type, status, stay_status,
           subtotal_amount, discount_amount, total_price, amount_paid, applied_deposit,
           remaining_balance, payment_status, stay_sequence, is_manual_override
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, 'OVERNIGHT', $8, 'RESERVED',
           510000, 153000, 357000, 357000, 0, 0, 'PAID', 1, FALSE
         ) RETURNING id`,
        [bookingId, roomId, rtOut, extras.rate_plan_id === undefined ? planOut : extras.rate_plan_id, `Tamu ${suffix}`, checkIn, checkOut, extras.status || 'BOOKED']
      );
      const reservationId = reservation.rows[0].id;
      cleanup.reservationIds.push(reservationId);
      const rc = await client.query(
        `INSERT INTO folio_entries (
           reservation_id, property_id, entry_type, source_type, description, amount, base_amount, unit_price, quantity, direction
         ) VALUES ($1, $2, 'ROOM_CHARGE', 'ROOM_CHARGE', 'Reservasi kamar', 510000, 510000, 510000, 1, 'DEBIT')
         RETURNING id`,
        [reservationId, propertyId]
      );
      await client.query(
        `INSERT INTO folio_entries (
           reservation_id, property_id, entry_type, source_type, source_id, description, amount, direction
         ) VALUES ($1, $2, 'DISCOUNT', 'GLOBAL_DISCOUNT', $3, 'Diskon Keseluruhan: Promo 30%', 153000, 'CREDIT')`,
        [reservationId, propertyId, String(bookingId)]
      );
      await projectFolioEntryToTransaction(client, rc.rows[0].id, {
        propertyId,
        discountAmount: 153000
      });
      await client.query(
        `INSERT INTO payment_transactions (reservation_id, amount, payment_method, status, transaction_type)
         VALUES ($1, 357000, 'CASH', 'SUCCESS', 'PAYMENT')`,
        [reservationId]
      );
      await client.query(
        `INSERT INTO folio_entries (
           reservation_id, property_id, entry_type, source_type, description, amount, direction
         ) VALUES ($1, $2, 'PAYMENT', 'PAYMENT', 'Pembayaran', 357000, 'CREDIT')`,
        [reservationId, propertyId]
      );
      return { bookingId, reservationId };
    };

    const target = await insertBookedChild();

    const preview = await previewBookedReservationReprice(pool, target.reservationId, {
      property_id: propertyId,
      rate_plan_id: planOut
    });
    expect(preview.after.gross === 640000, `A preview gross 640000, got ${preview.after.gross}`);
    expect(preview.after.discount === 192000, `A preview discount 192000, got ${preview.after.discount}`);
    expect(preview.after.net === 448000, `A preview net 448000, got ${preview.after.net}`);
    expect(preview.after.paid === 357000, 'A preview paid 357000');
    expect(preview.after.remaining === 91000, `A preview remaining 91000, got ${preview.after.remaining}`);
    expect(preview.after.payment_status === 'PARTIAL', 'A preview PARTIAL');
    expect(preview.before.gross === 510000, 'A preview old gross 510000');
    expect(preview.after.gross === 640000, 'M: commercial gross is 640000 room_subtotal');
    expect(preview.after.gross === preview.quote.room_subtotal, 'M: after.gross equals room_subtotal not a frontend amount');

    const committed = await executeBookedReservationReprice(pool, target.reservationId, {
      property_id: propertyId,
      rate_plan_id: planOut,
      reason: 'Koreksi tarif canonical Rate Calendar',
      actor: 'FO.BRP'
    });
    expect(Number(committed.reservation.subtotal_amount) === 640000, `A: subtotal 640000, got ${committed.reservation.subtotal_amount}`);
    expect(Number(committed.reservation.discount_amount) === 192000, `A: discount 192000, got ${committed.reservation.discount_amount}`);
    expect(Number(committed.reservation.total_price) === 448000, `A: net 448000, got ${committed.reservation.total_price}`);
    expect(Number(committed.reservation.amount_paid) === 357000, `A: paid unchanged 357000, got ${committed.reservation.amount_paid}`);
    expect(Number(committed.reservation.remaining_balance) === 91000, `A: remaining 91000, got ${committed.reservation.remaining_balance}`);
    expect(committed.reservation.payment_status === 'PARTIAL', 'A: PARTIAL');
    expect(committed.reservation.is_manual_override === false, 'canonical override remains off');

    const folio = await client.query(
      `SELECT entry_type, amount, direction FROM folio_entries
       WHERE reservation_id = $1 AND COALESCE(is_voided, FALSE) = FALSE
       ORDER BY id`,
      [target.reservationId]
    );
    const roomCharges = folio.rows.filter((row) => row.entry_type === 'ROOM_CHARGE');
    const discounts = folio.rows.filter((row) => row.entry_type === 'DISCOUNT');
    const payments = folio.rows.filter((row) => row.entry_type === 'PAYMENT');
    expect(roomCharges.length === 1, 'G: exactly one ROOM_CHARGE');
    expect(Number(roomCharges[0].amount) === 640000, 'G: ROOM_CHARGE 640000');
    expect(discounts.length === 1, 'H: exactly one DISCOUNT credit');
    expect(Number(discounts[0].amount) === 192000, 'H: DISCOUNT 192000');
    expect(payments.length === 1 && Number(payments[0].amount) === 357000, 'I: PAYMENT folio unchanged');

    const payRows = await client.query(
      `SELECT amount FROM payment_transactions WHERE reservation_id = $1 ORDER BY id`,
      [target.reservationId]
    );
    expect(payRows.rows.length === 1 && Number(payRows.rows[0].amount) === 357000, 'I: payment_transactions unchanged');

    const sales = await client.query(
      `SELECT amount, discount_amount, net_amount, transaction_type
       FROM transactions
       WHERE reservation_id = $1 AND reversal_of_transaction_id IS NULL`,
      [target.reservationId]
    );
    const saleRows = sales.rows.filter((row) => String(row.transaction_type || 'SALE').toUpperCase() !== 'PAYMENT');
    expect(saleRows.length === 1, 'J: exactly one SALE row');
    expect(Number(saleRows[0].amount) === 640000, 'J: Penjualan gross 640000');
    expect(Number(saleRows[0].discount_amount) === 192000, 'J: Penjualan discount 192000');
    expect(Number(saleRows[0].net_amount) === 448000, 'J: Penjualan net 448000');

    const audit = await client.query(
      `SELECT new_value FROM audit_logs
       WHERE entity = 'RESERVATION' AND record_id = $1 AND action = 'BOOKED_RATE_CORRECTION'
       ORDER BY audit_id DESC LIMIT 1`,
      [target.reservationId]
    );
    expect(audit.rows.length === 1, 'K: audit row exists');
    const auditJson = typeof audit.rows[0].new_value === 'string' ? JSON.parse(audit.rows[0].new_value) : audit.rows[0].new_value;
    expect(auditJson.reason === 'Koreksi tarif canonical Rate Calendar', 'K: reason stored');
    expect(Number(auditJson.before.gross) === 510000, 'K: before gross');
    expect(Number(auditJson.after.gross) === 640000, 'K: after gross');
    expect(auditJson.is_manual_override === false, 'K: override false');
    expect(auditJson.actor === 'FO.BRP', 'K: actor');

    const repeat = await executeBookedReservationReprice(pool, target.reservationId, {
      property_id: propertyId,
      rate_plan_id: planOut,
      reason: 'Ulangi koreksi yang sama',
      actor: 'FO.BRP'
    });
    expect(Number(repeat.reservation.subtotal_amount) === 640000, 'L: repeat gross still 640000');
    const folio2 = await client.query(
      `SELECT entry_type FROM folio_entries WHERE reservation_id = $1 AND COALESCE(is_voided, FALSE) = FALSE`,
      [target.reservationId]
    );
    expect(folio2.rows.filter((row) => row.entry_type === 'ROOM_CHARGE').length === 1, 'L: still one ROOM_CHARGE');
    expect(folio2.rows.filter((row) => row.entry_type === 'DISCOUNT').length === 1, 'L: still one DISCOUNT');
    const sales2 = await client.query(
      `SELECT id FROM transactions WHERE reservation_id = $1 AND reversal_of_transaction_id IS NULL AND COALESCE(transaction_type, 'SALE') <> 'PAYMENT'`,
      [target.reservationId]
    );
    expect(sales2.rows.length === 1, 'L: still one SALE');
    console.log('  ✓ A/G/H/I/J/K/L/M booked 510k -> 640k');

    const checkedIn = await insertBookedChild();
    await client.query(`UPDATE reservations SET status = 'CHECKED_IN' WHERE id = $1`, [checkedIn.reservationId]);
    let checkedInErr = null;
    try {
      await executeBookedReservationReprice(pool, checkedIn.reservationId, { property_id: propertyId, reason: 'x' });
    } catch (err) {
      checkedInErr = err;
    }
    expect(checkedInErr?.code === BOOKED_RESERVATION_REQUIRED && checkedInErr.statusCode === 409, 'B: CHECKED_IN 409');

    const checkedOut = await insertBookedChild();
    await client.query(`UPDATE reservations SET status = 'CHECKED_OUT' WHERE id = $1`, [checkedOut.reservationId]);
    let checkedOutErr = null;
    try {
      await executeBookedReservationReprice(pool, checkedOut.reservationId, { property_id: propertyId, reason: 'x' });
    } catch (err) {
      checkedOutErr = err;
    }
    expect(checkedOutErr?.code === BOOKED_RESERVATION_REQUIRED && checkedOutErr.statusCode === 409, 'C: CHECKED_OUT 409');

    const cancelled = await insertBookedChild();
    await client.query(`UPDATE reservations SET status = 'CANCELLED' WHERE id = $1`, [cancelled.reservationId]);
    let cancelledErr = null;
    try {
      await executeBookedReservationReprice(pool, cancelled.reservationId, { property_id: propertyId, reason: 'x' });
    } catch (err) {
      cancelledErr = err;
    }
    expect(cancelledErr?.code === BOOKED_RESERVATION_REQUIRED && cancelledErr.statusCode === 409, 'D: CANCELLED 409');
    console.log('  ✓ B/C/D status guards');

    const wrongPlan = await insertBookedChild();
    let wrongErr = null;
    try {
      await executeBookedReservationReprice(pool, wrongPlan.reservationId, {
        property_id: propertyId,
        rate_plan_id: planIn,
        reason: 'wrong plan'
      });
    } catch (err) {
      wrongErr = err;
    }
    expect(wrongErr?.code === RATE_PLAN_ROOM_TYPE_MISMATCH, `E: wrong plan/type fail closed, got ${wrongErr?.code}`);
    const wrongFolio = await client.query(
      `SELECT amount FROM folio_entries WHERE reservation_id = $1 AND entry_type = 'ROOM_CHARGE' AND COALESCE(is_voided, FALSE) = FALSE`,
      [wrongPlan.reservationId]
    );
    expect(Number(wrongFolio.rows[0].amount) === 510000, 'E: folio unchanged after wrong plan');

    const quoteFail = await insertBookedChild();
    const pricingService = require('../dist/domains/pricing/pricingService');
    const originalQuote = pricingService.calculatePriceQuote;
    pricingService.calculatePriceQuote = async () => {
      throw new Error('canonical quote unavailable');
    };
    let quoteErr = null;
    try {
      await executeBookedReservationReprice(pool, quoteFail.reservationId, {
        property_id: propertyId,
        rate_plan_id: planOut,
        reason: 'quote fail'
      });
    } catch (err) {
      quoteErr = err;
    } finally {
      pricingService.calculatePriceQuote = originalQuote;
    }
    expect(quoteErr?.code === CANONICAL_PRICE_QUOTE_FAILED || quoteErr?.statusCode === 400, `F: quote failure, got ${quoteErr?.code}`);
    const failFolio = await client.query(
      `SELECT amount FROM folio_entries WHERE reservation_id = $1 AND entry_type = 'ROOM_CHARGE' AND COALESCE(is_voided, FALSE) = FALSE`,
      [quoteFail.reservationId]
    );
    expect(Number(failFolio.rows[0].amount) === 510000, 'F: folio unchanged after quote failure');
    const failTx = await client.query(
      `SELECT amount FROM transactions WHERE reservation_id = $1 AND reversal_of_transaction_id IS NULL`,
      [quoteFail.reservationId]
    );
    expect(Number(failTx.rows[0].amount) === 510000, 'F: Penjualan unchanged after quote failure');
    console.log('  ✓ E/F fail-closed quote and plan mismatch');

    const multiA = await insertBookedChild();
    const siblingRoomId = await insertPhysicalRoom();
    const sibling = await client.query(
      `INSERT INTO reservations (
         booking_id, room_id, booked_room_type_id_snapshot, rate_plan_id,
         guest_name, check_in, check_out, stay_type, status,
         subtotal_amount, discount_amount, total_price, amount_paid, remaining_balance, payment_status, stay_sequence
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'OVERNIGHT', 'BOOKED', 510000, 0, 510000, 0, 510000, 'UNPAID', 2)
       RETURNING id`,
      [multiA.bookingId, siblingRoomId, rtOut, planOut, `Tamu sib ${suffix}`, checkIn, checkOut]
    );
    cleanup.reservationIds.push(sibling.rows[0].id);
    let multiErr = null;
    try {
      await executeBookedReservationReprice(pool, multiA.reservationId, {
        property_id: propertyId,
        rate_plan_id: planOut,
        reason: 'multi'
      });
    } catch (err) {
      multiErr = err;
    }
    expect(multiErr?.code === MULTI_ROOM_GLOBAL_DISCOUNT_REPRICE_UNSUPPORTED && multiErr.statusCode === 409, 'N: multi-room global discount fail closed');
    const multiFolio = await client.query(
      `SELECT amount FROM folio_entries WHERE reservation_id = $1 AND entry_type = 'ROOM_CHARGE' AND COALESCE(is_voided, FALSE) = FALSE`,
      [multiA.reservationId]
    );
    expect(Number(multiFolio.rows[0].amount) === 510000, 'N: sibling booking not mutated');
    console.log('  ✓ N multi-room global discount unsupported');

    console.log('\nPASS booked reservation reprice tests');
  } finally {
    try {
      if (cleanup.reservationIds.length) {
        await client.query('DELETE FROM transactions WHERE reservation_id = ANY($1::int[])', [cleanup.reservationIds]).catch(() => {});
        await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [cleanup.reservationIds]).catch(() => {});
        await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [cleanup.reservationIds]).catch(() => {});
        await client.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])', [cleanup.reservationIds]).catch(() => {});
        await client.query('DELETE FROM audit_logs WHERE entity = $1 AND record_id = ANY($2::int[])', ['RESERVATION', cleanup.reservationIds]).catch(() => {});
        await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [cleanup.reservationIds]);
      }
      if (cleanup.bookingIds.length) {
        await client.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [cleanup.bookingIds]);
      }
      if (cleanup.overrideIds.length) {
        await client.query('DELETE FROM rate_overrides WHERE id = ANY($1::int[])', [cleanup.overrideIds]);
      }
      if (cleanup.ratePlanIds.length) {
        await client.query('DELETE FROM rate_plans WHERE id = ANY($1::int[])', [cleanup.ratePlanIds]);
      }
      if (cleanup.roomIds.length) {
        await client.query('DELETE FROM rooms WHERE id = ANY($1::int[])', [cleanup.roomIds]);
      }
      if (cleanup.roomTypeIds.length) {
        await client.query('DELETE FROM availability_dates WHERE room_type_id = ANY($1::int[])', [cleanup.roomTypeIds]).catch(() => {});
        await client.query('DELETE FROM room_types WHERE id = ANY($1::int[])', [cleanup.roomTypeIds]);
      }
    } catch (cleanErr) {
      console.warn('Cleanup warning:', cleanErr.message);
    }
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

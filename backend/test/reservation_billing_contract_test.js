const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const assert = require('assert/strict');
const { Pool } = require('pg');
const {
  ReservationBillingError,
  allocateBookingPaymentToChildren,
  allocateCommercialDiscount,
  allocateGlobalDiscountToChildren,
  buildBookingGlobalDiscount,
  buildChildReservationBilling,
  computeAuthoritativeDiscount,
  hasBookingGlobalDiscountInput,
  hasBookingLevelPaymentInput,
  shouldApplyPostedCommercialDiscount
} = require('../dist/domains/reservations/reservationBilling');

function expectCode(fn, code) {
  try {
    fn();
    throw new Error(`expected ${code}`);
  } catch (err) {
    assert.equal(err instanceof ReservationBillingError, true, `expected ReservationBillingError for ${code}`);
    assert.equal(err.code, code);
  }
}

async function runHelperTests() {
  console.log('--- reservation billing helper contract ---');

  const percent = computeAuthoritativeDiscount({
    gross: 1000000,
    discountType: 'PERCENTAGE',
    discountValue: 10,
    discountAmount: 999999,
    discountReason: 'Promo 10%'
  });
  assert.equal(percent.discount, 100000, 'A: 10% of 1,000,000 is 100,000');
  assert.equal(percent.gross - percent.discount, 900000, 'A: net 900,000');
  assert.notEqual(percent.discount, 190000, 'B: does not apply discount twice');

  const fakeNet = buildChildReservationBilling({
    subtotalAmount: 1000000,
    totalPrice: 810000,
    discountType: 'PERCENTAGE',
    discountValue: 10,
    discountAmount: 190000,
    discountReason: 'Promo 10%'
  });
  assert.equal(fakeNet.discount, 100000, 'I: fake discount_amount ignored when type+value present');
  assert.equal(fakeNet.netTotal, 900000, 'J: fake net total_price ignored when subtotal is present');

  const nominal = computeAuthoritativeDiscount({
    gross: 1000000,
    discountType: 'NOMINAL',
    discountValue: 100000,
    discountAmount: 1,
    discountReason: 'Voucher'
  });
  assert.equal(nominal.discount, 100000, 'C: nominal 100,000');
  assert.equal(nominal.gross - nominal.discount, 900000, 'C: net 900,000');

  const zero = computeAuthoritativeDiscount({ gross: 1000000, discountType: 'NOMINAL', discountValue: 0 });
  assert.equal(zero.discount, 0, 'D: zero discount');
  assert.equal(zero.reason, null, 'D: blank reason allowed for zero');

  const full = computeAuthoritativeDiscount({
    gross: 1000000,
    discountType: 'PERCENTAGE',
    discountValue: 100,
    discountReason: 'Complimentary'
  });
  assert.equal(full.discount, 1000000, 'E: 100% allowed');
  assert.equal(full.gross - full.discount, 0, 'E: net 0');

  expectCode(
    () => computeAuthoritativeDiscount({ gross: 1000000, discountType: 'PERCENTAGE', discountValue: 101, discountReason: 'x' }),
    'DISCOUNT_PERCENT_INVALID'
  );
  expectCode(
    () => computeAuthoritativeDiscount({ gross: 1000000, discountType: 'NOMINAL', discountValue: -1, discountReason: 'x' }),
    'DISCOUNT_NEGATIVE'
  );
  expectCode(
    () => computeAuthoritativeDiscount({ gross: 1000000, discountType: 'PERCENTAGE', discountValue: 10 }),
    'DISCOUNT_REASON_REQUIRED'
  );

  const crmCompat = buildChildReservationBilling({
    subtotalAmount: 500000,
    totalPrice: 600000,
    stayCharges: [{ amount: 100000, quantity: 1 }],
    discountType: 'NOMINAL',
    discountAmount: 50000,
    discountReason: 'Voucher VIP Promo'
  });
  assert.equal(crmCompat.roomGross, 500000, 'S: room gross from subtotal_amount');
  assert.equal(crmCompat.stayGross, 100000, 'Q: stay charges are in discount base');
  assert.equal(crmCompat.discountBase, 600000, 'Q: discount base is room + stay');
  assert.equal(crmCompat.discount, 50000, 'CRM NOMINAL without discount_value uses discount_amount');
  assert.equal(crmCompat.netTotal, 550000, 'CRM net is gross - discount once');
  assert.equal(crmCompat.reason, 'Voucher VIP Promo', 'K: reason preserved');

  const allocated = allocateCommercialDiscount(1000000, [200000], 1200000);
  assert.equal(allocated.roomDiscount, 1000000, '100% room+stay allocates room first');
  assert.equal(allocated.stayDiscounts[0], 200000, 'remainder lands on stay sale, not a second discount tx');

  assert.equal(
    shouldApplyPostedCommercialDiscount({ roomChargePosted: 1000000, persistedSubtotal: 1000000 }),
    true,
    'new gross ROOM_CHARGE applies posted DISCOUNT'
  );
  assert.equal(
    shouldApplyPostedCommercialDiscount({ roomChargePosted: 810000, persistedSubtotal: 1000000 }),
    false,
    'legacy net ROOM_CHARGE does not double-subtract DISCOUNT'
  );
  assert.equal(
    shouldApplyPostedCommercialDiscount({ roomChargePosted: 550000, persistedSubtotal: 500000 }),
    false,
    'legacy ROOM_CHARGE posted at already-net total_price is not treated as gross'
  );

  const twoRoom = buildBookingGlobalDiscount({
    childGrosses: [385000, 534000],
    discountType: 'PERCENTAGE',
    discountValue: 10,
    discountAmount: 1,
    discountReason: 'Promo 10%'
  });
  assert.equal(twoRoom.gross, 919000, 'A: 2-room gross 919,000');
  assert.equal(twoRoom.discount, 91900, 'A: 10% of 919,000 is 91,900');
  assert.equal(twoRoom.net, 827100, 'A: net 827,100');
  assert.deepEqual(twoRoom.allocations, [38500, 53400], 'A: proportional 38,500 + 53,400');
  assert.notEqual(twoRoom.discount, 1, 'manipulated FE global amount is ignored');

  const thirty = buildBookingGlobalDiscount({
    childGrosses: [600000, 400000],
    discountType: 'PERCENTAGE',
    discountValue: 30,
    discountReason: 'Group 30%'
  });
  assert.equal(thirty.discount, 300000, 'B: 30% of 1,000,000 is 300,000');
  assert.equal(thirty.net, 700000, 'B: net 700,000');
  assert.deepEqual(thirty.allocations, [180000, 120000], 'B: 180,000 + 120,000');

  const threeRoom = allocateGlobalDiscountToChildren([500000, 300000, 200000], 100000);
  assert.deepEqual(threeRoom, [50000, 30000, 20000], 'C: 3-room 10% allocates 50+30+20');
  assert.equal(threeRoom.reduce((sum, value) => sum + value, 0), 100000, 'C: allocation sums exactly');

  const remainder = allocateGlobalDiscountToChildren([333333, 333333, 333334], 100000);
  assert.equal(remainder.reduce((sum, value) => sum + value, 0), 100000, 'rounding remainder sums exactly');
  assert.equal(remainder[2], 100000 - remainder[0] - remainder[1], 'last eligible child receives remainder');
  remainder.forEach((share, index) => {
    assert.ok(share >= 0, `share ${index} is not negative`);
    assert.ok(share <= [333333, 333333, 333334][index], `share ${index} does not exceed child gross`);
  });

  const fullGlobal = buildBookingGlobalDiscount({
    childGrosses: [500000, 500000],
    discountType: 'PERCENTAGE',
    discountValue: 100,
    discountReason: 'Complimentary'
  });
  assert.equal(fullGlobal.discount, 1000000, '100% discount equals gross');
  assert.equal(fullGlobal.net, 0, '100% net is 0');
  assert.deepEqual(fullGlobal.allocations, [500000, 500000], '100% allocates full child gross');
  assert.ok(fullGlobal.allocations.every((share) => share >= 0), '100% has no negative allocation');

  const zeroGlobal = buildBookingGlobalDiscount({
    childGrosses: [385000],
    discountType: 'PERCENTAGE',
    discountValue: 0
  });
  assert.equal(zeroGlobal.discount, 0, '0% discount is 0');
  assert.equal(zeroGlobal.net, 385000, '0% net equals gross');

  const single = buildBookingGlobalDiscount({
    childGrosses: [385000],
    discountType: 'PERCENTAGE',
    discountValue: 10,
    discountReason: 'Walk-in promo'
  });
  assert.equal(single.discount, 38500, 'single room 10% of 385,000');
  assert.equal(single.net, 346500, 'single room net 346,500');
  assert.deepEqual(single.allocations, [38500], 'single room allocation is the full discount');

  const extras = buildBookingGlobalDiscount({
    childGrosses: [500000, 700000],
    discountType: 'PERCENTAGE',
    discountValue: 10,
    discountReason: 'Promo extras'
  });
  assert.equal(extras.gross, 1200000, 'gross includes stay extras on children');
  assert.equal(extras.discount, 120000, '10% of 1.2M');
  assert.equal(extras.net, 1080000, 'net 1.08M');

  expectCode(
    () => buildBookingGlobalDiscount({
      childGrosses: [1000000],
      discountType: 'PERCENTAGE',
      discountValue: 101,
      discountReason: 'x'
    }),
    'DISCOUNT_PERCENT_INVALID'
  );
  expectCode(
    () => buildBookingGlobalDiscount({
      childGrosses: [1000000],
      discountType: 'NOMINAL',
      discountValue: -1,
      discountReason: 'x'
    }),
    'DISCOUNT_NEGATIVE'
  );
  expectCode(
    () => buildBookingGlobalDiscount({
      childGrosses: [1000000],
      discountType: 'PERCENTAGE',
      discountValue: 10
    }),
    'DISCOUNT_REASON_REQUIRED'
  );

  assert.equal(hasBookingGlobalDiscountInput({ global_discount_type: 'PERCENTAGE' }), true);
  assert.equal(hasBookingGlobalDiscountInput({ global_discount_value: 0 }), true);
  assert.equal(hasBookingGlobalDiscountInput({ discount_type: 'PERCENTAGE' }), false, 'child discount keys are not booking-global');

  const hadira = allocateBookingPaymentToChildren([368000, 427200], 460000);
  assert.deepEqual(hadira.allocations, [368000, 92000], 'A: sequential 368,000 then 92,000');
  assert.equal(hadira.totalAllocated, 460000, 'A: total allocated equals cash');
  assert.equal(hadira.remainingBalance, 335200, 'A: booking remaining 335,200');
  assert.equal(368000 - hadira.allocations[0], 0, 'A: first remaining 0');
  assert.equal(427200 - hadira.allocations[1], 335200, 'A: second remaining 335,200');

  const fullPay = allocateBookingPaymentToChildren([400000, 600000], 1000000);
  assert.deepEqual(fullPay.allocations, [400000, 600000], 'B: both children paid in full');
  assert.equal(fullPay.remainingBalance, 0, 'B: booking remaining 0');

  const zeroPay = allocateBookingPaymentToChildren([400000, 600000], 0);
  assert.deepEqual(zeroPay.allocations, [0, 0], 'C: payment 0 allocates nothing');
  assert.equal(zeroPay.totalAllocated, 0, 'C: total allocated 0');

  const firstPartial = allocateBookingPaymentToChildren([400000, 600000], 200000);
  assert.deepEqual(firstPartial.allocations, [200000, 0], 'D: first partial, second unpaid');

  const exactFirst = allocateBookingPaymentToChildren([400000, 600000], 400000);
  assert.deepEqual(exactFirst.allocations, [400000, 0], 'E: exact first child, second unpaid');

  const threeSpan = allocateBookingPaymentToChildren([100000, 200000, 300000], 350000);
  assert.deepEqual(threeSpan.allocations, [100000, 200000, 50000], 'F: spans first two and part of third');

  const noOverChild = allocateBookingPaymentToChildren([368000, 427200], 999999);
  assert.ok(noOverChild.allocations.every((take, index) => take <= [368000, 427200][index]), 'M: helper never exceeds child net');
  assert.ok(noOverChild.allocations.every((take) => take >= 0), 'helper never negative');

  assert.equal(hasBookingLevelPaymentInput({ amount_paid: 0 }), true);
  assert.equal(hasBookingLevelPaymentInput({ initial_payment: { amount: 1000 } }), true);
  assert.equal(hasBookingLevelPaymentInput({ reservations: [{ amount_paid: 1000 }] }), false, 'child amount_paid is not booking-level');

  console.log('   helper assertions passed');
}

async function runLedgerTests() {
  console.log('--- folio / recalc / penjualan contract ---');
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'secretpassword',
    database: process.env.DB_NAME || 'oak_hotel_db'
  });

  const { initializeDatabase } = require('../dist/db/schema_v3');
  await initializeDatabase(pool);
  const { recalculateReservationFinancials } = require('../dist/domains/stayCharges/stayChargesService');
  const { projectFolioEntryToTransaction } = require('../dist/domains/transactions/transactionService');

  const suffix = Date.now();
  const guestName = `QB Billing Contract ${suffix}`;
  const roomNumber = `QB-BC-${String(suffix).slice(-6)}`;
  const tracked = {
    propertyId: null,
    roomTypeId: null,
    roomId: null,
    bookingId: null,
    reservationId: null,
    folioIds: []
  };

  try {
    const propRes = await pool.query('SELECT id FROM properties ORDER BY id ASC LIMIT 1');
    tracked.propertyId = Number(propRes.rows[0]?.id || 1);

    const rtRes = await pool.query(
      `INSERT INTO room_types (property_id, code, name, base_rate, is_active)
       VALUES ($1, $2, $3, 1000000, true)
       RETURNING id`,
      [tracked.propertyId, `QB-BC-${suffix}`, 'QB Billing Contract Type']
    );
    tracked.roomTypeId = rtRes.rows[0].id;

    const rmRes = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES ($1, $2, $3, $3, 'Tersedia', true)
       RETURNING id`,
      [tracked.propertyId, tracked.roomTypeId, roomNumber]
    );
    tracked.roomId = rmRes.rows[0].id;

    const bookingRes = await pool.query(
      `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status)
       VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
      [`BID-QBC-${suffix}`, tracked.propertyId, guestName]
    );
    tracked.bookingId = bookingRes.rows[0].id;

    const resRes = await pool.query(
      `INSERT INTO reservations (
         booking_id, room_id, guest_name, check_in, check_out, status, stay_status, stay_sequence,
         booking_number, subtotal_amount, total_price, discount_amount, discount_percent, discount_reason,
         amount_paid, remaining_balance, payment_status, booked_room_type_id_snapshot
       ) VALUES (
         $1, $2, $3, '2026-12-01', '2026-12-02', 'BOOKED', 'RESERVED', 1,
         $5, 1000000, 900000, 100000, 10, 'Promo 10%',
         300000, 600000, 'PARTIAL', $4
       ) RETURNING id`,
      [tracked.bookingId, tracked.roomId, guestName, tracked.roomTypeId, `QBC-${suffix}`]
    );
    tracked.reservationId = resRes.rows[0].id;

    const roomFolio = await pool.query(
      `INSERT INTO folio_entries (
         reservation_id, property_id, entry_type, source_type, description, amount, base_amount, unit_price, quantity, direction
       ) VALUES ($1, $2, 'ROOM_CHARGE', 'ROOM_CHARGE', 'Reservasi kamar', 1000000, 1000000, 1000000, 1, 'DEBIT')
       RETURNING id`,
      [tracked.reservationId, tracked.propertyId]
    );
    tracked.folioIds.push(roomFolio.rows[0].id);

    const stayFolio = await pool.query(
      `INSERT INTO folio_entries (
         reservation_id, property_id, entry_type, source_type, description, amount, base_amount, unit_price, quantity, direction
       ) VALUES ($1, $2, 'EXTRA_BED', 'EXTRA_BED', 'Extra bed', 200000, 200000, 200000, 1, 'DEBIT')
       RETURNING id`,
      [tracked.reservationId, tracked.propertyId]
    );
    tracked.folioIds.push(stayFolio.rows[0].id);

    const discountFolio = await pool.query(
      `INSERT INTO folio_entries (
         reservation_id, property_id, entry_type, description, amount, direction
       ) VALUES ($1, $2, 'DISCOUNT', 'Diskon: Promo 10%', 120000, 'CREDIT')
       RETURNING id`,
      [tracked.reservationId, tracked.propertyId]
    );
    tracked.folioIds.push(discountFolio.rows[0].id);

    const paymentFolio = await pool.query(
      `INSERT INTO folio_entries (
         reservation_id, property_id, entry_type, description, amount, direction
       ) VALUES ($1, $2, 'PAYMENT', 'Pembayaran', 300000, 'CREDIT')
       RETURNING id`,
      [tracked.reservationId, tracked.propertyId]
    );
    tracked.folioIds.push(paymentFolio.rows[0].id);

    await pool.query(
      `INSERT INTO payment_transactions (reservation_id, transaction_type, amount, payment_method, status, created_by)
       VALUES ($1, 'PAYMENT', 300000, 'CASH', 'SUCCESS', 'TEST')`,
      [tracked.reservationId]
    );

    const roomTx = await projectFolioEntryToTransaction(pool, roomFolio.rows[0].id, {
      propertyId: tracked.propertyId,
      discountAmount: 100000
    });
    const stayTx = await projectFolioEntryToTransaction(pool, stayFolio.rows[0].id, {
      propertyId: tracked.propertyId,
      discountAmount: 20000
    });
    const discountTx = await projectFolioEntryToTransaction(pool, discountFolio.rows[0].id, {
      propertyId: tracked.propertyId
    });
    const paymentTx = await projectFolioEntryToTransaction(pool, paymentFolio.rows[0].id, {
      propertyId: tracked.propertyId
    });

    assert.equal(Number(roomTx.amount), 1000000, 'L: ROOM SALE amount is gross');
    assert.equal(Number(roomTx.discount_amount), 100000, 'P: discount lives on ROOM SALE, not a second tx');
    assert.equal(Number(roomTx.net_amount), 900000, 'P: ROOM SALE net is gross - discount');
    assert.equal(Number(stayTx.amount), 200000, 'Q: stay charge sale remains gross');
    assert.equal(Number(stayTx.discount_amount), 20000, 'Q: remaining discount allocated to stay sale');
    assert.equal(discountTx, null, 'P: DISCOUNT folio CREDIT is not projected as a second sale');
    assert.equal(paymentTx, null, 'O: PAYMENT CREDIT is not projected as penjualan');

    const financials = await recalculateReservationFinancials(pool, tracked.reservationId, tracked.propertyId);
    assert.equal(financials.total_price, 1080000, 'N: recalc = room + stay - DISCOUNT');
    assert.equal(financials.amount_paid, 300000, 'O: payment is settlement, not revenue');
    assert.equal(financials.remaining_balance, 780000, 'N: balance after discount and payment');

    const persisted = await pool.query(
      `SELECT subtotal_amount, discount_amount, discount_reason, total_price FROM reservations WHERE id = $1`,
      [tracked.reservationId]
    );
    assert.equal(Number(persisted.rows[0].subtotal_amount), 1000000, 'S: subtotal_amount remains room gross');
    assert.equal(persisted.rows[0].discount_reason, 'Promo 10%', 'K: discount_reason readable');

    const legacyBooking = await pool.query(
      `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status)
       VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
      [`BID-QBC-LEG-${suffix}`, tracked.propertyId, `${guestName} LEGACY`]
    );
    const legacyRes = await pool.query(
      `INSERT INTO reservations (
         booking_id, room_id, guest_name, check_in, check_out, status, stay_status, stay_sequence,
         booking_number, subtotal_amount, total_price, discount_amount, discount_reason,
         amount_paid, remaining_balance, payment_status, booked_room_type_id_snapshot
       ) VALUES (
         $1, $2, $3, '2026-12-03', '2026-12-04', 'BOOKED', 'RESERVED', 1,
         $5, 1000000, 810000, 100000, 'Legacy double-discount row',
         0, 810000, 'UNPAID', $4
       ) RETURNING id`,
      [legacyBooking.rows[0].id, tracked.roomId, `${guestName} LEGACY`, tracked.roomTypeId, `QBC-LEG-${suffix}`]
    );
    await pool.query(
      `INSERT INTO folio_entries (
         reservation_id, property_id, entry_type, source_type, description, amount, base_amount, unit_price, quantity, direction
       ) VALUES ($1, $2, 'ROOM_CHARGE', 'ROOM_CHARGE', 'Reservasi kamar', 810000, 810000, 810000, 1, 'DEBIT')`,
      [legacyRes.rows[0].id, tracked.propertyId]
    );
    await pool.query(
      `INSERT INTO folio_entries (
         reservation_id, property_id, entry_type, description, amount, direction
       ) VALUES ($1, $2, 'DISCOUNT', 'Diskon legacy', 100000, 'CREDIT')`,
      [legacyRes.rows[0].id, tracked.propertyId]
    );
    const legacyFinancials = await recalculateReservationFinancials(pool, legacyRes.rows[0].id, tracked.propertyId);
    assert.equal(legacyFinancials.total_price, 810000, 'S: legacy net ROOM_CHARGE is not reduced again by DISCOUNT');

    const cleanupReservationIds = [tracked.reservationId, legacyRes.rows[0].id];
    const cleanupBookingIds = [tracked.bookingId, legacyBooking.rows[0].id];
    await pool.query(
      'DELETE FROM transaction_items WHERE transaction_id IN (SELECT id FROM transactions WHERE reservation_id = ANY($1::int[]))',
      [cleanupReservationIds]
    ).catch(() => {});
    await pool.query('DELETE FROM transactions WHERE reservation_id = ANY($1::int[])', [cleanupReservationIds]);
    await pool.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [cleanupReservationIds]);
    await pool.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [cleanupReservationIds]);
    await pool.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [cleanupReservationIds]);
    await pool.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [cleanupBookingIds]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [tracked.roomId]);
    await pool.query('DELETE FROM room_types WHERE id = $1', [tracked.roomTypeId]);

    console.log('   ledger assertions passed');
  } catch (err) {
    try {
      if (tracked.reservationId) {
        await pool.query('DELETE FROM transactions WHERE reservation_id = $1', [tracked.reservationId]);
        await pool.query('DELETE FROM folio_entries WHERE reservation_id = $1', [tracked.reservationId]);
        await pool.query('DELETE FROM payment_transactions WHERE reservation_id = $1', [tracked.reservationId]);
        await pool.query('DELETE FROM reservations WHERE id = $1', [tracked.reservationId]);
      }
      if (tracked.bookingId) await pool.query('DELETE FROM bookings WHERE id = $1', [tracked.bookingId]);
      if (tracked.roomId) await pool.query('DELETE FROM rooms WHERE id = $1', [tracked.roomId]);
      if (tracked.roomTypeId) await pool.query('DELETE FROM room_types WHERE id = $1', [tracked.roomTypeId]);
    } catch {}
    throw err;
  } finally {
    await pool.end();
  }
}

async function run() {
  console.log('=== QUICK-BOOKING-FINANCIAL-CONTRACT-1 ===');
  await runHelperTests();
  await runLedgerTests();
  console.log('PASS reservation billing contract');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const http = require('http');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  console.log('=== QUICK-BOOKING-MULTIROOM-PAYMENT-ALLOCATION-1 backend contract ===\n');

  const { initializeDatabase } = require('../dist/db/schema_v3');
  await initializeDatabase(pool);

  const { app, createCanonicalBooking } = require('../dist/index');
  const { createPaymentCore } = require('../dist/domains/payments/paymentDomainService');
  const server = http.createServer(app);
  const serverPort = await new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });

  const httpRequest = (method, reqPath, body = null) => new Promise((resolve, reject) => {
    const payloadStr = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (payloadStr) headers['Content-Length'] = Buffer.byteLength(payloadStr);
    const req = http.request(
      { hostname: '127.0.0.1', port: serverPort, path: reqPath, method, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch (_e) { json = data; }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    if (payloadStr) req.write(payloadStr);
    req.end();
  });

  const httpProbe = await httpRequest('POST', '/api/bookings', {
    property_id: 1,
    guest_name: 'PAY Auth Probe',
    reservations: [{ room_id: 1, check_in: '2028-06-10', check_out: '2028-06-11' }]
  });
  if (httpProbe.status === 401) {
    console.log('  STALE HTTP 401 classified: POST /api/bookings is gated by operationalAccessGuard (Kalender). Not patched in this ticket.');
  } else {
    console.log(`  HTTP POST /api/bookings probe status ${httpProbe.status} (auth guard not blocking this environment)`);
  }

  const suffix = Date.now();
  const propertyRes = await pool.query('SELECT id FROM properties ORDER BY id ASC LIMIT 1');
  const propertyId = Number(propertyRes.rows[0].id);
  const checkIn = '2028-06-10';
  const checkOut = '2028-06-11';
  const roomIds = [];
  const roomTypeIds = [];
  const ratePlanIds = [];
  const bookingIds = [];

  const fakeReq = (payload) => ({
    user: { username: 'FO.TEST', name: 'Front Office Test' },
    body: payload,
    headers: { 'x-correlation-id': `PAY-${suffix}` }
  });

  const createBooking = async (payload) => {
    try {
      const result = await createCanonicalBooking(fakeReq(payload), payload, payload.reservations, { requirePropertyId: true });
      return { ok: true, status: 201, result, error: null };
    } catch (err) {
      return { ok: false, status: Number(err.statusCode || 500), result: null, error: err };
    }
  };

  const cleanupBooking = async (bookingId) => {
    if (!bookingId) return;
    const resIds = await pool.query('SELECT id FROM reservations WHERE booking_id = $1', [bookingId]);
    const ids = resIds.rows.map((row) => row.id);
    if (ids.length) {
      await pool.query('DELETE FROM transaction_items WHERE transaction_id IN (SELECT id FROM transactions WHERE reservation_id = ANY($1::int[]))', [ids]).catch(() => {});
      await pool.query('DELETE FROM transactions WHERE reservation_id = ANY($1::int[])', [ids]).catch(() => {});
      await pool.query('DELETE FROM payment_evidences WHERE reservation_id = ANY($1::int[])', [ids]).catch(() => {});
      await pool.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [ids]).catch(() => {});
      await pool.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [ids]).catch(() => {});
      await pool.query('DELETE FROM reservation_rate_snapshots WHERE reservation_id = ANY($1::int[])', [ids]).catch(() => {});
      await pool.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])', [ids]).catch(() => {});
      await pool.query('DELETE FROM reservation_guests WHERE reservation_id = ANY($1::int[])', [ids]).catch(() => {});
      await pool.query('DELETE FROM availability_locks WHERE reservation_id = ANY($1::int[])', [ids]).catch(() => {});
      await pool.query('DELETE FROM audit_logs WHERE entity = $1 AND record_id = ANY($2::int[])', ['RESERVATION', ids]).catch(() => {});
      await pool.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [ids]);
    }
    await pool.query('DELETE FROM audit_logs WHERE entity = $1 AND record_id = $2', ['BOOKING', bookingId]).catch(() => {});
    await pool.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
  };

  try {
    // Canonical 1-night rate_plan.base_rate (room_types.base_rate is a 500000 decoy).
    // Frontend subtotal_amount=1 is a decoy and must be ignored when override is OFF.
    const insertPricedRoom = async (canonicalGross) => {
      const index = roomIds.length;
      const typeName = `PAY Type ${suffix}-${index}`;
      const typeCode = `PAY-${suffix}-${index}`;
      const rt = await pool.query(
        `INSERT INTO room_types (property_id, code, name, base_rate, is_active)
         VALUES ($1, $2, $3, 500000, true) RETURNING id`,
        [propertyId, typeCode, typeName]
      );
      const roomTypeId = rt.rows[0].id;
      roomTypeIds.push(roomTypeId);
      const rm = await pool.query(
        `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
         VALUES ($1, $2, $3, $3, 'VACANT_CLEAN', true) RETURNING id`,
        [propertyId, roomTypeId, `PAY${index}-${String(suffix).slice(-4)}`]
      );
      const roomId = rm.rows[0].id;
      roomIds.push(roomId);
      const plan = await pool.query(
        `INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate, meal_plan, rate_type, is_active, sort_order)
         VALUES ($1, $2, $3, $4, $5, 'RO', 'OVERNIGHT', true, 0) RETURNING id`,
        [propertyId, roomTypeId, `${typeCode}-RO`, `${typeName} RO`, canonicalGross]
      );
      const ratePlanId = plan.rows[0].id;
      ratePlanIds.push(ratePlanId);
      await pool.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES ($1, $2, $3::date, 5, 0)
         ON CONFLICT (room_type, date) DO UPDATE SET total_rooms = 5, reserved_qty = 0`,
        [roomTypeId, typeName, checkIn]
      );
      return { roomId, roomTypeId, ratePlanId, canonicalGross };
    };

    const p460 = await insertPricedRoom(460000);
    const p534 = await insertPricedRoom(534000);
    const p400 = await insertPricedRoom(400000);
    const p600 = await insertPricedRoom(600000);
    const p100 = await insertPricedRoom(100000);
    const p200 = await insertPricedRoom(200000);
    const p300 = await insertPricedRoom(300000);
    const k600 = await insertPricedRoom(600000);
    const k400 = await insertPricedRoom(400000);

    const resetAvailability = async () => {
      for (let index = 0; index < roomTypeIds.length; index += 1) {
        await pool.query(
          `UPDATE availability_dates SET reserved_qty = 0 WHERE room_type_id = $1 AND date = $2::date`,
          [roomTypeIds[index], checkIn]
        );
      }
    };

    const childPayload = (priced, extras = {}) => ({
      room_id: priced.roomId,
      room_type_id: priced.roomTypeId,
      rate_plan_id: priced.ratePlanId,
      check_in: checkIn,
      check_out: checkOut,
      stay_type: 'OVERNIGHT',
      guest_name: `PAY Guest ${suffix}`,
      subtotal_amount: 1,
      total_price: 1,
      is_manual_override: false,
      qty: 1,
      ...extras
    });

    const bookingPayload = (overrides) => ({
      property_id: propertyId,
      guest_name: `PAY Guest ${suffix}`,
      guest_phone: '081200000002',
      guest_segment: 'Walk-in',
      booking_source: 'WALKIN',
      booking_channel: 'WALK_IN',
      has_valid_identity: true,
      identity_number: '3171010101990002',
      ktp_path: '/uploads/ktp-pay.jpg',
      payment_method: 'CASH',
      amount_paid: 0,
      ...overrides
    });

    const loadChildren = async (bookingId) => {
      const rows = await pool.query(
        `SELECT id, room_id, stay_sequence, total_price, subtotal_amount, discount_amount,
                amount_paid, remaining_balance, payment_status, is_manual_override
         FROM reservations WHERE booking_id = $1 ORDER BY stay_sequence ASC`,
        [bookingId]
      );
      return rows.rows;
    };

    const loadPayments = async (reservationIds) => pool.query(
      `SELECT id, reservation_id, amount, reference_code, correction_group_id, transaction_type, status
       FROM payment_transactions
       WHERE reservation_id = ANY($1::int[])
       ORDER BY id ASC`,
      [reservationIds]
    );

    const loadPaymentFolio = async (reservationIds) => pool.query(
      `SELECT reservation_id, entry_type, source_type, source_id, amount, direction, correction_group_id
       FROM folio_entries
       WHERE reservation_id = ANY($1::int[]) AND entry_type = 'PAYMENT'
       ORDER BY id ASC`,
      [reservationIds]
    );

    const created = [];
    const track = (bookingId) => {
      bookingIds.push(bookingId);
      created.push(bookingId);
      return bookingId;
    };

    // A / G / L / M / P / Q / R — HADIRA nets after 20% global discount
    // Canonical HADIRA: 460,000 + 534,000 = 994,000 gross; 20% = 198,800; net = 795,200
    // Booking cash 460,000 sequential on child NET: 368,000 then 92,000
    const hadira = await createBooking(bookingPayload({
      amount_paid: 460000,
      bukti_bayar_path: '/uploads/bukti-hadira.jpg',
      global_discount_type: 'PERCENTAGE',
      global_discount_value: 20,
      global_discount_reason: 'Promo 20%',
      reservations: [
        { ...childPayload(p460), amount_paid: 999999, payment_status: 'PAID' },
        childPayload(p534)
      ]
    }));
    expect(hadira.ok, `A/G/J HADIRA create failed ${hadira.status}: ${hadira.error?.message}`);
    const hadiraId = track(Number(hadira.result.booking.id));
    const hadiraChildren = await loadChildren(hadiraId);
    expect(Number(hadiraChildren[0].subtotal_amount) === 460000, 'canonical: frontend subtotal 1 ignored, quote 460000 used');
    expect(Number(hadiraChildren[1].subtotal_amount) === 534000, 'canonical: child 2 quote 534000 used');
    expect(hadiraChildren.every((row) => row.is_manual_override === false), 'canonical override remains off');
    expect(Number(hadiraChildren[0].discount_amount) === 92000, 'G: child 1 discount is 92,000 of net not gross');
    expect(Number(hadiraChildren[1].discount_amount) === 106800, 'G: child 2 discount is 106,800');
    expect(Number(hadiraChildren[0].total_price) === 368000, 'G: child 1 net 368,000');
    expect(Number(hadiraChildren[1].total_price) === 427200, 'G: child 2 net 427,200');
    expect(Number(hadiraChildren[0].amount_paid) === 368000, 'A/J: first allocation 368,000, fake child[0].amount_paid ignored');
    expect(Number(hadiraChildren[1].amount_paid) === 92000, 'A/J: second allocation 92,000');
    expect(Number(hadiraChildren[0].remaining_balance) === 0, 'A: first remaining 0');
    expect(Number(hadiraChildren[1].remaining_balance) === 335200, 'A: second remaining 335,200');
    expect(hadiraChildren[0].payment_status === 'PAID', 'R: first child PAID');
    expect(hadiraChildren[1].payment_status === 'PARTIAL', 'R: second child PARTIAL');
    expect(
      hadiraChildren.every((row) => Number(row.amount_paid) <= Number(row.total_price)),
      'M: no child amount_paid exceeds child net'
    );
    const hadiraPaidSum = hadiraChildren.reduce((sum, row) => sum + Number(row.amount_paid), 0);
    expect(hadiraPaidSum === 460000, `L: sum child paid = booking cash, got ${hadiraPaidSum}`);

    const hadiraPayments = await loadPayments(hadiraChildren.map((row) => row.id));
    expect(hadiraPayments.rows.length === 2, '7: one payment_transactions row per allocated child');
    expect(Number(hadiraPayments.rows[0].amount) === 368000, 'Room 101 PAYMENT 368,000');
    expect(Number(hadiraPayments.rows[1].amount) === 92000, 'Room 204 PAYMENT 92,000');
    expect(hadiraPayments.rows.every((row) => Number(row.amount) !== 460000), 'do not insert 460,000 on first child');
    const groupIds = [...new Set(hadiraPayments.rows.map((row) => row.correction_group_id))];
    expect(groupIds.length === 1 && Boolean(groupIds[0]), 'P: shared correction_group_id');
    const refCodes = [...new Set(hadiraPayments.rows.map((row) => row.reference_code))];
    expect(refCodes.length === 1 && Boolean(refCodes[0]), 'P: shared reference_code');

    const hadiraFolioPay = await loadPaymentFolio(hadiraChildren.map((row) => row.id));
    expect(hadiraFolioPay.rows.length === 2, '9: one PAYMENT CREDIT per allocated child');
    expect(hadiraFolioPay.rows.every((row) => row.source_type === 'BOOKING_PAYMENT'), 'folio source_type BOOKING_PAYMENT');
    expect(hadiraFolioPay.rows.every((row) => String(row.source_id) === String(hadiraId)), 'folio source_id is booking id');
    expect(hadiraFolioPay.rows.reduce((sum, row) => sum + Number(row.amount), 0) === 460000, 'PAYMENT credits sum to booking cash');

    const sales = await pool.query(
      `SELECT amount, discount_amount, net_amount, transaction_type
       FROM transactions
       WHERE reservation_id = ANY($1::int[]) AND reversal_of_transaction_id IS NULL`,
      [hadiraChildren.map((row) => row.id)]
    );
    const saleRows = sales.rows.filter((row) => String(row.transaction_type || 'SALE').toUpperCase() !== 'PAYMENT');
    expect(saleRows.reduce((sum, row) => sum + Number(row.amount || 0), 0) === 994000, 'N: Penjualan amount remains gross 994,000');
    expect(saleRows.reduce((sum, row) => sum + Number(row.discount_amount || 0), 0) === 198800, 'N: Penjualan discount unchanged');
    expect(saleRows.reduce((sum, row) => sum + Number(row.net_amount || 0), 0) === 795200, 'N: Penjualan net unchanged');
    expect(
      sales.rows.every((row) => String(row.transaction_type || 'SALE').toUpperCase() !== 'PAYMENT'),
      'N: PAYMENT credits do not project to Penjualan'
    );

    const evidence = await pool.query(
      `SELECT id, payment_transaction_id, reservation_id FROM payment_evidences WHERE reservation_id = ANY($1::int[])`,
      [hadiraChildren.map((row) => row.id)]
    );
    expect(evidence.rows.length === 1, 'Q: payment evidence attached only once');
    expect(Number(evidence.rows[0].payment_transaction_id) === Number(hadiraPayments.rows[0].id), 'Q: evidence on primary split row');
    console.log('  ✓ A/G/J/L/M/N/P/Q/R HADIRA sequential allocation');

    // Later payments remain reservation-specific
    let paidChildOverpay = null;
    try {
      await createPaymentCore(pool, {
        propertyId,
        reservationId: Number(hadiraChildren[0].id),
        amount: 1,
        paymentMethod: 'CASH',
        actorNameSnapshot: 'FO.TEST'
      });
    } catch (err) {
      paidChildOverpay = err;
    }
    expect(paidChildOverpay?.code === 'OVERPAYMENT_NOT_ALLOWED', '14: later payment on paid child rejects OVERPAYMENT_NOT_ALLOWED');

    const laterPay = await createPaymentCore(pool, {
      propertyId,
      reservationId: Number(hadiraChildren[1].id),
      amount: 335200,
      paymentMethod: 'CASH',
      actorNameSnapshot: 'FO.TEST'
    });
    expect(Number(laterPay.reservation.remaining_balance) === 0, '14: leftover is collected on unpaid sibling');
    expect(laterPay.reservation.payment_status === 'PAID', '14: sibling becomes PAID after later payment');
    await cleanupBooking(hadiraId);
    await resetAvailability();
    console.log('  ✓ later reservation-specific payments');

    // B — full pay two children
    const full = await createBooking(bookingPayload({
      amount_paid: 1000000,
      reservations: [childPayload(p400), childPayload(p600)]
    }));
    expect(full.ok, `B create failed ${full.status}: ${full.error?.message}`);
    const fullId = track(Number(full.result.booking.id));
    const fullChildren = await loadChildren(fullId);
    expect(Number(fullChildren[0].amount_paid) === 400000, 'B: first paid 400,000');
    expect(Number(fullChildren[1].amount_paid) === 600000, 'B: second paid 600,000');
    expect(fullChildren.every((row) => row.payment_status === 'PAID'), 'B/R: both PAID');
    await cleanupBooking(fullId);
    await resetAvailability();
    console.log('  ✓ B full payment');

    // C — payment 0
    const unpaid = await createBooking(bookingPayload({
      amount_paid: 0,
      reservations: [childPayload(p400), childPayload(p600)]
    }));
    expect(unpaid.ok, `C create failed ${unpaid.status}: ${unpaid.error?.message}`);
    const unpaidId = track(Number(unpaid.result.booking.id));
    const unpaidChildren = await loadChildren(unpaidId);
    expect(unpaidChildren.every((row) => Number(row.amount_paid) === 0), 'C: no child paid');
    expect(unpaidChildren.every((row) => row.payment_status === 'UNPAID'), 'C/R: both UNPAID');
    const unpaidPay = await loadPayments(unpaidChildren.map((row) => row.id));
    const unpaidFolio = await loadPaymentFolio(unpaidChildren.map((row) => row.id));
    expect(unpaidPay.rows.length === 0, 'C: no payment_transactions');
    expect(unpaidFolio.rows.length === 0, 'C: no PAYMENT folio credit');
    await cleanupBooking(unpaidId);
    await resetAvailability();
    console.log('  ✓ C payment 0');

    // D
    const partialFirst = await createBooking(bookingPayload({
      amount_paid: 200000,
      reservations: [childPayload(p400), childPayload(p600)]
    }));
    expect(partialFirst.ok, `D create failed ${partialFirst.status}: ${partialFirst.error?.message}`);
    const partialFirstId = track(Number(partialFirst.result.booking.id));
    const dChildren = await loadChildren(partialFirstId);
    expect(Number(dChildren[0].amount_paid) === 200000, 'D: first partial 200,000');
    expect(Number(dChildren[1].amount_paid) === 0, 'D: second 0');
    expect(dChildren[0].payment_status === 'PARTIAL', 'D/R: first PARTIAL');
    expect(dChildren[1].payment_status === 'UNPAID', 'D/R: second UNPAID');
    await cleanupBooking(partialFirstId);
    await resetAvailability();
    console.log('  ✓ D first partial');

    // E
    const exactFirst = await createBooking(bookingPayload({
      amount_paid: 400000,
      reservations: [childPayload(p400), childPayload(p600)]
    }));
    expect(exactFirst.ok, `E create failed ${exactFirst.status}: ${exactFirst.error?.message}`);
    const exactFirstId = track(Number(exactFirst.result.booking.id));
    const eChildren = await loadChildren(exactFirstId);
    expect(Number(eChildren[0].amount_paid) === 400000 && eChildren[0].payment_status === 'PAID', 'E: first PAID');
    expect(Number(eChildren[1].amount_paid) === 0 && eChildren[1].payment_status === 'UNPAID', 'E: second UNPAID');
    await cleanupBooking(exactFirstId);
    await resetAvailability();
    console.log('  ✓ E exact first child');

    // F — 3 children spanning first two and part of third
    const three = await createBooking(bookingPayload({
      amount_paid: 350000,
      reservations: [childPayload(p100), childPayload(p200), childPayload(p300)]
    }));
    expect(three.ok, `F create failed ${three.status}: ${three.error?.message}`);
    const threeId = track(Number(three.result.booking.id));
    const fChildren = await loadChildren(threeId);
    expect(fChildren.map((row) => Number(row.amount_paid)).join(',') === '100000,200000,50000', 'F: 100+200+50');
    expect(fChildren[0].payment_status === 'PAID', 'F/R: first PAID');
    expect(fChildren[1].payment_status === 'PAID', 'F/R: second PAID');
    expect(fChildren[2].payment_status === 'PARTIAL', 'F/R: third PARTIAL');
    const fPay = await loadPayments(fChildren.map((row) => row.id));
    expect(fPay.rows.length === 3, 'F: three payment rows for three allocations > 0');
    expect(new Set(fPay.rows.map((row) => row.correction_group_id)).size === 1, 'P: 3-way split shares group id');
    await cleanupBooking(threeId);
    await resetAvailability();
    console.log('  ✓ F three-child span');

    // H — 100% discount, payment 0
    const complimentary = await createBooking(bookingPayload({
      amount_paid: 0,
      global_discount_type: 'PERCENTAGE',
      global_discount_value: 100,
      global_discount_reason: 'Complimentary',
      reservations: [childPayload(p600), childPayload(p400)]
    }));
    expect(complimentary.ok, `H create failed ${complimentary.status}: ${complimentary.error?.message}`);
    const complimentaryId = track(Number(complimentary.result.booking.id));
    const hChildren = await loadChildren(complimentaryId);
    expect(hChildren.every((row) => Number(row.total_price) === 0), 'H: booking net 0');
    const hPay = await loadPayments(hChildren.map((row) => row.id));
    const hFolio = await loadPaymentFolio(hChildren.map((row) => row.id));
    expect(hPay.rows.length === 0, 'H: no payment rows against zero-net children');
    expect(hFolio.rows.length === 0, 'H: no PAYMENT folio CREDIT');
    await cleanupBooking(complimentaryId);
    await resetAvailability();
    console.log('  ✓ H 100% discount payment 0');

    // I — overpayment rejected
    const overpay = await createBooking(bookingPayload({
      amount_paid: 1,
      global_discount_type: 'PERCENTAGE',
      global_discount_value: 100,
      global_discount_reason: 'Complimentary',
      reservations: [childPayload(p300)]
    }));
    expect(overpay.ok === false, 'I: payment against net 0 is rejected');
    expect(overpay.status === 400, `I: status 400, got ${overpay.status}`);
    expect(overpay.error?.code === 'OVERPAYMENT_NOT_ALLOWED', 'I: OVERPAYMENT_NOT_ALLOWED');
    expect(overpay.error?.message === 'Nominal pembayaran melebihi sisa tagihan', 'I: existing overpayment message');

    const overpayPartial = await createBooking(bookingPayload({
      amount_paid: 795201,
      global_discount_type: 'PERCENTAGE',
      global_discount_value: 20,
      global_discount_reason: 'Promo 20%',
      reservations: [childPayload(p460), childPayload(p534)]
    }));
    expect(overpayPartial.error?.code === 'OVERPAYMENT_NOT_ALLOWED', 'I: cash > booking net rejected');
    console.log('  ✓ I overpayment rejected');

    // K — stay_sequence, not room_id
    expect(k400.roomId > k600.roomId, 'K fixture: 400k room has higher room_id');
    const orderCase = await createBooking(bookingPayload({
      amount_paid: 500000,
      reservations: [childPayload(k400), childPayload(k600)]
    }));
    expect(orderCase.ok, `K create failed ${orderCase.status}: ${orderCase.error?.message}`);
    const orderId = track(Number(orderCase.result.booking.id));
    const kChildren = await loadChildren(orderId);
    expect(Number(kChildren[0].room_id) === k400.roomId, 'K: stay_sequence 1 is higher room_id');
    expect(Number(kChildren[1].room_id) === k600.roomId, 'K: stay_sequence 2 is lower room_id');
    expect(Number(kChildren[0].amount_paid) === 400000, 'K: first payload child filled first');
    expect(Number(kChildren[1].amount_paid) === 100000, 'K: remainder on second payload child, not smaller room_id');
    await cleanupBooking(orderId);
    await resetAvailability();
    console.log('  ✓ K stay_sequence order, not room_id');

    // O — single room equivalent
    const single = await createBooking(bookingPayload({
      amount_paid: 300000,
      reservations: [childPayload(p300)]
    }));
    expect(single.ok, `O create failed ${single.status}: ${single.error?.message}`);
    const singleId = track(Number(single.result.booking.id));
    const oChildren = await loadChildren(singleId);
    expect(oChildren.length === 1, 'O: one child');
    expect(Number(oChildren[0].amount_paid) === 300000, 'O: single-room payment 300,000');
    expect(Number(oChildren[0].remaining_balance) === 0, 'O: remaining 0');
    expect(oChildren[0].payment_status === 'PAID', 'O: PAID');
    const oPay = await loadPayments(oChildren.map((row) => row.id));
    expect(oPay.rows.length === 1 && Number(oPay.rows[0].amount) === 300000, 'O: one payment row');
    await cleanupBooking(singleId);
    await resetAvailability();
    console.log('  ✓ O single-room unchanged');

    console.log('\nPASS booking payment allocation contract');
  } finally {
    for (const bookingId of bookingIds) {
      await cleanupBooking(bookingId).catch(() => {});
    }
    if (roomIds.length) {
      await pool.query('DELETE FROM availability_locks WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id = ANY($1::int[]))', [roomIds]).catch(() => {});
      await pool.query('DELETE FROM reservation_nightly_rates WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id = ANY($1::int[]))', [roomIds]).catch(() => {});
      await pool.query('DELETE FROM reservations WHERE room_id = ANY($1::int[])', [roomIds]).catch(() => {});
      await pool.query('DELETE FROM rooms WHERE id = ANY($1::int[])', [roomIds]);
    }
    if (ratePlanIds.length) {
      await pool.query('DELETE FROM rate_overrides WHERE rate_plan_id = ANY($1::bigint[])', [ratePlanIds]).catch(() => {});
      await pool.query('DELETE FROM rate_plans WHERE id = ANY($1::bigint[])', [ratePlanIds]).catch(() => {});
    }
    if (roomTypeIds.length) {
      await pool.query('DELETE FROM availability_dates WHERE room_type_id = ANY($1::int[])', [roomTypeIds]).catch(() => {});
      await pool.query('DELETE FROM room_types WHERE id = ANY($1::int[])', [roomTypeIds]);
    }
    server.close();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const http = require('http');
const { Pool } = require('pg');
const assert = require('assert/strict');

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
  console.log('=== QUICK-BOOKING-GLOBAL-DISCOUNT-1 backend contract ===\n');

  const { initializeDatabase } = require('../dist/db/schema_v3');
  await initializeDatabase(pool);

  const colRes = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'bookings'
      AND column_name LIKE 'global_discount_%'
    ORDER BY column_name
  `);
  const cols = colRes.rows.map((row) => row.column_name);
  for (const required of [
    'global_discount_type',
    'global_discount_value',
    'global_discount_amount',
    'global_discount_reason',
    'global_discount_gross_before',
    'global_discount_net_after'
  ]) {
    expect(cols.includes(required), `migration added bookings.${required}`);
  }
  console.log('  ✓ additive booking global-discount columns exist');

  const { app, createCanonicalBooking } = require('../dist/index');
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
    guest_name: 'GD Auth Probe',
    reservations: [{ room_id: 1, check_in: '2028-05-10', check_out: '2028-05-11' }]
  });
  if (httpProbe.status === 401) {
    console.log('  STALE HTTP 401 classified: POST /api/bookings is gated by operationalAccessGuard (Kalender). Not patched in this ticket.');
  } else {
    console.log(`  HTTP POST /api/bookings probe status ${httpProbe.status} (auth guard not blocking this environment)`);
  }

  const suffix = Date.now();
  const propertyRes = await pool.query('SELECT id FROM properties ORDER BY id ASC LIMIT 2');
  const propertyId = Number(propertyRes.rows[0].id);
  const otherPropertyId = propertyRes.rows[1] ? Number(propertyRes.rows[1].id) : null;
  const checkIn = '2028-05-10';
  const checkOut = '2028-05-11';
  const roomIds = [];
  const roomTypeIds = [];
  const bookingIds = [];

  const fakeReq = (payload) => ({
    user: { username: 'FO.TEST', name: 'Front Office Test' },
    body: payload,
    headers: { 'x-correlation-id': `GD-${suffix}` }
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
      await pool.query('DELETE FROM reservation_guests WHERE reservation_id = ANY($1::int[])', [ids]).catch(() => {});
      await pool.query('DELETE FROM availability_locks WHERE reservation_id = ANY($1::int[])', [ids]).catch(() => {});
      await pool.query('DELETE FROM audit_logs WHERE entity = $1 AND record_id = ANY($2::int[])', ['RESERVATION', ids]).catch(() => {});
      await pool.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [ids]);
    }
    await pool.query('DELETE FROM audit_logs WHERE entity = $1 AND record_id = $2', ['BOOKING', bookingId]).catch(() => {});
    await pool.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
  };

  try {
    for (let index = 0; index < 3; index += 1) {
      const typeName = `GD Type ${suffix}-${index}`;
      const rt = await pool.query(
        `INSERT INTO room_types (property_id, code, name, base_rate, is_active)
         VALUES ($1, $2, $3, 500000, true) RETURNING id`,
        [propertyId, `GD-${suffix}-${index}`, typeName]
      );
      roomTypeIds.push(rt.rows[0].id);
      const rm = await pool.query(
        `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
         VALUES ($1, $2, $3, $3, 'VACANT_CLEAN', true) RETURNING id`,
        [propertyId, rt.rows[0].id, `GD${index}-${String(suffix).slice(-4)}`]
      );
      roomIds.push(rm.rows[0].id);
      await pool.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES ($1, $2, $3::date, 5, 0)
         ON CONFLICT (room_type, date) DO UPDATE SET total_rooms = 5, reserved_qty = 0`,
        [rt.rows[0].id, typeName, checkIn]
      );
    }

    const resetAvailability = async () => {
      for (let index = 0; index < roomTypeIds.length; index += 1) {
        await pool.query(
          `UPDATE availability_dates SET reserved_qty = 0 WHERE room_type_id = $1 AND date = $2::date`,
          [roomTypeIds[index], checkIn]
        );
      }
    };

    const childPayload = (roomIndex, subtotal, extras = []) => ({
      room_id: roomIds[roomIndex],
      room_type_id: roomTypeIds[roomIndex],
      check_in: checkIn,
      check_out: checkOut,
      stay_type: 'OVERNIGHT',
      guest_name: `GD Guest ${suffix}`,
      subtotal_amount: subtotal,
      total_price: 1,
      discount_amount: 999999,
      stay_charges: extras,
      qty: 1
    });

    const bookingPayload = (overrides) => ({
      property_id: propertyId,
      guest_name: `GD Guest ${suffix}`,
      guest_phone: '081200000001',
      guest_segment: 'Walk-in',
      booking_source: 'WALKIN',
      booking_channel: 'WALK_IN',
      has_valid_identity: true,
      identity_number: '3171010101990001',
      ktp_path: '/uploads/ktp-gd.jpg',
      payment_method: 'CASH',
      amount_paid: 0,
      actor: 'HACKER',
      ...overrides
    });

    const rejectOver = await createBooking(bookingPayload({
      global_discount_type: 'PERCENTAGE',
      global_discount_value: 101,
      global_discount_reason: 'too much',
      reservations: [childPayload(0, 385000)]
    }));
    expect(rejectOver.status === 400, `>100 rejected, got ${rejectOver.status}`);
    expect(rejectOver.error?.code === 'DISCOUNT_PERCENT_INVALID', '>100 code DISCOUNT_PERCENT_INVALID');

    const rejectNeg = await createBooking(bookingPayload({
      global_discount_type: 'NOMINAL',
      global_discount_value: -1,
      global_discount_reason: 'neg',
      reservations: [childPayload(0, 385000)]
    }));
    expect(rejectNeg.status === 400, 'negative rejected');
    expect(rejectNeg.error?.code === 'DISCOUNT_NEGATIVE', 'negative code DISCOUNT_NEGATIVE');

    const rejectReason = await createBooking(bookingPayload({
      global_discount_type: 'PERCENTAGE',
      global_discount_value: 10,
      reservations: [childPayload(0, 385000)]
    }));
    expect(rejectReason.status === 400, 'missing reason rejected');
    expect(rejectReason.error?.code === 'DISCOUNT_REASON_REQUIRED', 'reason required code');
    console.log('  ✓ validation >100 / negative / reason required');

    const twoRoom = await createBooking(bookingPayload({
      amount_paid: 827100,
      global_discount_type: 'PERCENTAGE',
      global_discount_value: 10,
      global_discount_amount: 1,
      global_discount_reason: 'Promo 10%',
      grand_total: 1,
      reservations: [childPayload(0, 385000), childPayload(1, 534000)]
    }));
    if (!twoRoom.ok) {
      throw new Error(`2-room create failed ${twoRoom.status}: ${twoRoom.error?.message}`);
    }
    const twoBookingId = Number(twoRoom.result.booking.id);
    bookingIds.push(twoBookingId);
    expect(twoRoom.result.reservations.length === 2, '2 child reservations');

    const bookingRow = await pool.query(
      `SELECT property_id, created_by, global_discount_type, global_discount_value, global_discount_amount,
              global_discount_reason, global_discount_gross_before, global_discount_net_after
       FROM bookings WHERE id = $1`,
      [twoBookingId]
    );
    expect(Number(bookingRow.rows[0].property_id) === propertyId, 'property isolation: booking stays on source property');
    expect(bookingRow.rows[0].global_discount_type === 'PERCENTAGE', 'booking type persisted');
    expect(Number(bookingRow.rows[0].global_discount_value) === 10, 'booking input value persisted');
    expect(Number(bookingRow.rows[0].global_discount_amount) === 91900, 'computed amount persisted, fake FE 1 ignored');
    expect(bookingRow.rows[0].global_discount_reason === 'Promo 10%', 'reason persisted');
    expect(Number(bookingRow.rows[0].global_discount_gross_before) === 919000, 'gross before persisted');
    expect(Number(bookingRow.rows[0].global_discount_net_after) === 827100, 'net after persisted');
    expect(bookingRow.rows[0].created_by !== 'HACKER', 'client actor is not trusted on created_by');
    expect(bookingRow.rows[0].created_by === 'FO.TEST', 'created_by uses authenticated actor');

    const childRows = await pool.query(
      `SELECT id, discount_amount, total_price, subtotal_amount, amount_paid, remaining_balance
       FROM reservations WHERE booking_id = $1 ORDER BY stay_sequence ASC`,
      [twoBookingId]
    );
    expect(Number(childRows.rows[0].discount_amount) === 38500, 'child 1 allocated 38,500');
    expect(Number(childRows.rows[1].discount_amount) === 53400, 'child 2 allocated 53,400');
    expect(Number(childRows.rows[0].total_price) + Number(childRows.rows[1].total_price) === 827100, 'sum child net = booking net');
    expect(Number(childRows.rows[0].amount_paid) === 346500, 'sequential payment fills first child net, not booking cash');
    expect(Number(childRows.rows[1].amount_paid) === 480600, 'remainder of booking cash lands on second child');
    expect(Number(childRows.rows[0].amount_paid) + Number(childRows.rows[1].amount_paid) === 827100, 'sum child paid = booking net payment');
    expect(Number(childRows.rows[0].subtotal_amount) === 385000, 'child subtotal remains room gross');
    childRows.rows.forEach((row) => {
      expect(Number(row.total_price) >= 0, 'no child negative net');
    });

    const folio = await pool.query(
      `SELECT reservation_id, entry_type, source_type, source_id, amount, direction
       FROM folio_entries
       WHERE reservation_id = ANY($1::int[])
       ORDER BY id ASC`,
      [childRows.rows.map((row) => row.id)]
    );
    const discounts = folio.rows.filter((row) => row.entry_type === 'DISCOUNT');
    expect(discounts.length === 2, 'one DISCOUNT CREDIT per child');
    expect(discounts.every((row) => row.source_type === 'GLOBAL_DISCOUNT'), 'folio source_type GLOBAL_DISCOUNT');
    expect(discounts.every((row) => String(row.source_id) === String(twoBookingId)), 'folio source_id is booking id');
    expect(discounts.reduce((sum, row) => sum + Number(row.amount), 0) === 91900, 'folio discount exact 91,900');
    expect(folio.rows.filter((row) => row.entry_type === 'ROOM_CHARGE').every((row) => row.direction === 'DEBIT'), 'ROOM_CHARGE remains DEBIT gross');

    const sales = await pool.query(
      `SELECT amount, discount_amount, net_amount, transaction_type
       FROM transactions
       WHERE reservation_id = ANY($1::int[]) AND reversal_of_transaction_id IS NULL`,
      [childRows.rows.map((row) => row.id)]
    );
    const saleRows = sales.rows.filter((row) => String(row.transaction_type || 'SALE').toUpperCase() !== 'PAYMENT');
    const saleGross = saleRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const saleDiscount = saleRows.reduce((sum, row) => sum + Number(row.discount_amount || 0), 0);
    const saleNet = saleRows.reduce((sum, row) => sum + Number(row.net_amount || 0), 0);
    expect(saleGross === 919000, `Penjualan amount sums to booking gross, got ${saleGross}`);
    expect(saleDiscount === 91900, `Penjualan discount_amount sums to global discount, got ${saleDiscount}`);
    expect(saleNet === 827100, `Penjualan net_amount sums to booking net, got ${saleNet}`);
    const roomCharges = folio.rows.filter((row) => row.entry_type === 'ROOM_CHARGE');
    expect(saleRows.length === roomCharges.length, 'DISCOUNT CREDIT is not projected as another Penjualan row');

    const audit = await pool.query(
      `SELECT new_value FROM audit_logs WHERE entity = 'BOOKING' AND record_id = $1 ORDER BY audit_id DESC LIMIT 1`,
      [twoBookingId]
    );
    const auditJson = typeof audit.rows[0].new_value === 'string' ? JSON.parse(audit.rows[0].new_value) : audit.rows[0].new_value;
    expect(auditJson.bid === twoRoom.result.booking.bid, 'audit records BID');
    expect(Number(auditJson.gross_booking_total) === 919000, 'audit gross');
    expect(auditJson.global_discount_type === 'PERCENTAGE', 'audit type');
    expect(Number(auditJson.global_discount_value) === 10, 'audit input value');
    expect(Number(auditJson.global_discount_amount) === 91900, 'audit computed amount');
    expect(auditJson.global_discount_reason === 'Promo 10%', 'audit reason');
    expect(Number(auditJson.net_booking_total) === 827100, 'audit net');
    expect(auditJson.actor !== 'HACKER', 'audit actor is not client-supplied');
    expect(auditJson.actor === 'FO.TEST', 'audit actor is authenticated session');
    expect(Array.isArray(auditJson.child_allocation) && auditJson.child_allocation.length === 2, 'audit child allocation snapshot');
    console.log('  ✓ 2-room 10% persist / folio / penjualan / payment / audit');

    await cleanupBooking(twoBookingId);
    await resetAvailability();

    const threeRoom = await createBooking(bookingPayload({
      amount_paid: 900000,
      global_discount_type: 'PERCENTAGE',
      global_discount_value: 10,
      global_discount_reason: 'Group 10%',
      reservations: [childPayload(0, 500000), childPayload(1, 300000), childPayload(2, 200000)]
    }));
    expect(threeRoom.ok, `3-room create ${threeRoom.status} ${threeRoom.error?.message}`);
    const threeId = Number(threeRoom.result.booking.id);
    bookingIds.push(threeId);
    const threeChildren = await pool.query(
      `SELECT discount_amount, total_price FROM reservations WHERE booking_id = $1 ORDER BY stay_sequence`,
      [threeId]
    );
    expect(threeChildren.rows.map((row) => Number(row.discount_amount)).join(',') === '50000,30000,20000', '3-room allocation 50+30+20');
    expect(threeChildren.rows.reduce((sum, row) => sum + Number(row.discount_amount), 0) === 100000, '3-room allocation exact');
    expect(threeChildren.rows.reduce((sum, row) => sum + Number(row.total_price), 0) === 900000, '3-room net 900,000');
    await cleanupBooking(threeId);
    await resetAvailability();
    console.log('  ✓ 3-room proportional allocation');

    const extras = await createBooking(bookingPayload({
      amount_paid: 1080000,
      global_discount_type: 'PERCENTAGE',
      global_discount_value: 10,
      global_discount_reason: 'Promo extras',
      reservations: [
        childPayload(0, 500000),
        childPayload(1, 500000, [{ charge_type: 'EXTRA_BED', description: 'Extra bed', quantity: 1, unit_price: 200000, amount: 200000 }])
      ]
    }));
    expect(extras.ok, `extras create ${extras.status} ${extras.error?.message}`);
    const extrasId = Number(extras.result.booking.id);
    bookingIds.push(extrasId);
    const extrasBooking = await pool.query(
      `SELECT global_discount_gross_before, global_discount_amount, global_discount_net_after FROM bookings WHERE id = $1`,
      [extrasId]
    );
    expect(Number(extrasBooking.rows[0].global_discount_gross_before) === 1200000, 'gross includes stay extras');
    expect(Number(extrasBooking.rows[0].global_discount_amount) === 120000, '10% of 1.2M');
    expect(Number(extrasBooking.rows[0].global_discount_net_after) === 1080000, 'net 1.08M');
    await cleanupBooking(extrasId);
    await resetAvailability();
    console.log('  ✓ stay extras included in global discount base');

    const full = await createBooking(bookingPayload({
      amount_paid: 0,
      global_discount_type: 'PERCENTAGE',
      global_discount_value: 100,
      global_discount_reason: 'Complimentary',
      reservations: [childPayload(0, 600000), childPayload(1, 400000)]
    }));
    expect(full.ok, `100% create ${full.status} ${full.error?.message}`);
    const fullId = Number(full.result.booking.id);
    bookingIds.push(fullId);
    const fullBooking = await pool.query(
      `SELECT global_discount_amount, global_discount_net_after FROM bookings WHERE id = $1`,
      [fullId]
    );
    expect(Number(fullBooking.rows[0].global_discount_amount) === 1000000, '100% discount = gross');
    expect(Number(fullBooking.rows[0].global_discount_net_after) === 0, '100% net 0');
    const fullChildren = await pool.query(
      `SELECT total_price, discount_amount FROM reservations WHERE booking_id = $1`,
      [fullId]
    );
    expect(fullChildren.rows.every((row) => Number(row.total_price) === 0), '100% no child negative net');
    expect(fullChildren.rows.reduce((sum, row) => sum + Number(row.discount_amount), 0) === 1000000, '100% allocation exact');
    await cleanupBooking(fullId);
    await resetAvailability();
    console.log('  ✓ 100% global discount');

    const zero = await createBooking(bookingPayload({
      amount_paid: 385000,
      global_discount_type: 'PERCENTAGE',
      global_discount_value: 0,
      reservations: [childPayload(0, 385000)]
    }));
    expect(zero.ok, `0% create ${zero.status} ${zero.error?.message}`);
    const zeroId = Number(zero.result.booking.id);
    bookingIds.push(zeroId);
    const zeroBooking = await pool.query(
      `SELECT global_discount_amount, global_discount_net_after FROM bookings WHERE id = $1`,
      [zeroId]
    );
    expect(Number(zeroBooking.rows[0].global_discount_amount) === 0, '0% amount 0');
    expect(Number(zeroBooking.rows[0].global_discount_net_after) === 385000, '0% net equals gross');
    await cleanupBooking(zeroId);
    await resetAvailability();

    const historical = await createBooking(bookingPayload({
      amount_paid: 450000,
      reservations: [{
        ...childPayload(0, 500000),
        total_price: 500000,
        discount_amount: 50000,
        discount_type: 'NOMINAL',
        discount_value: 50000,
        discount_reason: 'Legacy room discount'
      }]
    }));
    expect(historical.ok, `historical per-room create ${historical.status} ${historical.error?.message}`);
    const histId = Number(historical.result.booking.id);
    bookingIds.push(histId);
    const histBooking = await pool.query(
      `SELECT global_discount_amount FROM bookings WHERE id = $1`,
      [histId]
    );
    expect(Number(histBooking.rows[0].global_discount_amount) === 0, 'legacy path does not write global discount');
    const histChild = await pool.query(
      `SELECT id, discount_amount, discount_reason FROM reservations WHERE booking_id = $1`,
      [histId]
    );
    expect(Number(histChild.rows[0].discount_amount) === 50000, 'historical per-room discount still applied');
    expect(histChild.rows[0].discount_reason === 'Legacy room discount', 'historical reason readable');
    const histFolio2 = await pool.query(
      `SELECT source_type FROM folio_entries WHERE reservation_id = $1 AND entry_type = 'DISCOUNT'`,
      [histChild.rows[0].id]
    );
    expect(histFolio2.rows[0].source_type !== 'GLOBAL_DISCOUNT', 'legacy DISCOUNT is not tagged GLOBAL_DISCOUNT');
    await cleanupBooking(histId);
    await resetAvailability();
    console.log('  ✓ historical per-room discount compatibility');

    if (otherPropertyId && otherPropertyId !== propertyId) {
      const leaked = await pool.query(
        `SELECT COUNT(*)::int AS n FROM bookings WHERE property_id = $1 AND guest_name_snapshot LIKE $2`,
        [otherPropertyId, `GD Guest ${suffix}%`]
      );
      expect(Number(leaked.rows[0].n) === 0, 'property isolation: no booking leaked to other property');
    }
    console.log('  ✓ property isolation');

    console.log('\nPASS booking global discount contract');
  } finally {
    for (const bookingId of bookingIds) {
      await cleanupBooking(bookingId).catch(() => {});
    }
    if (roomIds.length) {
      await pool.query('DELETE FROM availability_locks WHERE reservation_id IN (SELECT id FROM reservations WHERE room_id = ANY($1::int[]))', [roomIds]).catch(() => {});
      await pool.query('DELETE FROM reservations WHERE room_id = ANY($1::int[])', [roomIds]).catch(() => {});
      await pool.query('DELETE FROM rooms WHERE id = ANY($1::int[])', [roomIds]).catch(() => {});
    }
    if (roomTypeIds.length) {
      await pool.query('DELETE FROM availability_dates WHERE room_type_id = ANY($1::int[])', [roomTypeIds]).catch(() => {});
      await pool.query('DELETE FROM room_types WHERE id = ANY($1::int[])', [roomTypeIds]).catch(() => {});
    }
    server.close();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

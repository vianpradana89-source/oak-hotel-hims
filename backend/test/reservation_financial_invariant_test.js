const http = require('http');
const { once } = require('events');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db',
});

let server;
let baseUrl;
const createdReservationIds = new Set();
const createdBookingIds = new Set();

function expect(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`PASS | ${message}`);
}

async function request(method, path, body = null) {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const isMultipart = body && body.isMultipart;
    const headers = {};
    let payload = '';

    if (isMultipart) {
      headers['Content-Type'] = `multipart/form-data; boundary=${body.boundary}`;
      payload = body.buffer;
      headers['Content-Length'] = payload.length;
    } else if (body) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function buildMultipartBody(fields, fileField = null) {
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const chunks = [];

  for (const [key, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }

  if (fileField) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField.name}"; filename="${fileField.filename}"\r\n` +
      `Content-Type: ${fileField.contentType || 'image/png'}\r\n\r\n`
    ));
    chunks.push(fileField.buffer);
    chunks.push(Buffer.from('\r\n'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    isMultipart: true,
    boundary,
    buffer: Buffer.concat(chunks)
  };
}

async function cleanupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resIds = Array.from(createdReservationIds).map(Number).filter(id => Number.isFinite(id) && id > 0);
    const bookIds = Array.from(createdBookingIds).map(Number).filter(id => Number.isFinite(id) && id > 0);

    if (resIds.length > 0) {
      const resRows = await client.query('SELECT id, room_id, booked_room_type_id_snapshot, check_in, check_out, status FROM reservations WHERE id = ANY($1::int[])', [resIds]);
      for (const row of resRows.rows) {
        if (['BOOKED', 'CHECKED_IN'].includes(row.status)) {
          let cur = new Date(row.check_in);
          const end = new Date(row.check_out);
          while (cur < end) {
            const dStr = cur.toISOString().slice(0, 10);
            await client.query(
              `UPDATE availability_dates 
               SET reserved_qty = GREATEST(0, reserved_qty - 1)
               WHERE (room_type_id = $1 OR room_type = (SELECT name FROM room_types WHERE id = $1)) AND date = $2`,
              [row.booked_room_type_id_snapshot, dStr]
            );
            cur.setDate(cur.getDate() + 1);
          }
        }
      }

      await client.query('DELETE FROM transactions WHERE reservation_id = ANY($1::int[])', [resIds]);
      await client.query('DELETE FROM payment_evidences WHERE reservation_id = ANY($1::int[])', [resIds]);
      await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [resIds]);
      await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [resIds]);
      await client.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])', [resIds]);
      await client.query('DELETE FROM audit_logs WHERE record_id = ANY($1::text[])', [resIds.map(String)]);
      await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [resIds]);
    }

    if (bookIds.length > 0) {
      await client.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [bookIds]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Cleanup error:', err);
  } finally {
    client.release();
  }
}

async function runAuditTests() {
  console.log('=== Starting Reservation Financial Invariant Audit & Verification ===\n');

  const { app } = require('../dist/index');
  const { initializeDatabase } = require('../dist/db/schema_v3');
  const { reconcileCanonicalAvailability } = require('../dist/domains/inventory/canonicalReconciliation');
  await initializeDatabase(pool);

  server = http.createServer(app);
  server.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Pre-cleanup leftover audit fixtures
    const oldBookings = await pool.query("SELECT id FROM bookings WHERE booker_name LIKE 'Audit Booker%'");
    if (oldBookings.rowCount > 0) {
      const oldBids = oldBookings.rows.map(r => r.id);
      const oldRes = await pool.query('SELECT id, room_id, booked_room_type_id_snapshot, check_in, check_out, status FROM reservations WHERE booking_id = ANY($1::int[])', [oldBids]);
      for (const row of oldRes.rows) {
        if (['BOOKED', 'CHECKED_IN'].includes(row.status)) {
          let cur = new Date(row.check_in);
          const end = new Date(row.check_out);
          while (cur < end) {
            const dStr = cur.toISOString().slice(0, 10);
            await pool.query(
              `UPDATE availability_dates 
               SET reserved_qty = GREATEST(0, reserved_qty - 1)
               WHERE (room_type_id = $1 OR room_type = (SELECT name FROM room_types WHERE id = $1)) AND date = $2`,
              [row.booked_room_type_id_snapshot, dStr]
            );
            cur.setDate(cur.getDate() + 1);
          }
        }
      }
      const oldRids = oldRes.rows.map(r => r.id);
      if (oldRids.length > 0) {
        await pool.query('DELETE FROM transactions WHERE reservation_id = ANY($1::int[])', [oldRids]);
        await pool.query('DELETE FROM payment_evidences WHERE reservation_id = ANY($1::int[])', [oldRids]);
        await pool.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [oldRids]);
        await pool.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [oldRids]);
        await pool.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])', [oldRids]);
        await pool.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [oldRids]);
      }
      await pool.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [oldBids]);
    }

    await reconcileCanonicalAvailability(pool);

    // 1. Resolve Room 104 from Room Master
    const roomResult = await pool.query(`
      SELECT r.id, r.room_number, r.floor, r.room_type_id, rt.name as room_type_name
      FROM rooms r
      JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.room_number = '104' AND r.property_id = 1
      LIMIT 1
    `);
    expect(roomResult.rowCount > 0, 'Room 104 resolved from Room Master');
    const room104 = roomResult.rows[0];
    const roomId = room104.id;
    const rtId = room104.room_type_id;
    const propId = 1;

    // ────────────────────────────────────────────────────────────────────────
    // TEST SECTION 1: Asymmetric Payment Test (877,800 Charges vs 100,000 Payment)
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- Section 1: Asymmetric Payment Test (Rp877,800 vs Rp100,000) ---');

    // Create 2-night reservation (Rp438,900 * 2 = Rp877,800)
    const bookRes1 = await request('POST', '/api/bookings', {
      property_id: propId,
      booking_source: 'OTA',
      ota_source: 'Tiket.com',
      booker_name: 'Audit Booker 1',
      guest_name: 'Audit Guest 1',
      reservations: [
        {
          room_type_id: rtId,
          room_id: roomId,
          check_in: '2026-10-01',
          check_out: '2026-10-03',
          total_price: 877800,
          subtotal_amount: 877800,
          notes: 'Asymmetry Test'
        }
      ]
    });

    expect(bookRes1.status === 200 || bookRes1.status === 201, 'Booking 1 created successfully');
    const bookingId1 = bookRes1.body.data.booking_id;
    const resId1 = bookRes1.body.data.reservations[0].id;
    createdBookingIds.add(bookingId1);
    createdReservationIds.add(resId1);

    const resDb1 = await pool.query('SELECT total_price, amount_paid, remaining_balance, payment_status FROM reservations WHERE id = $1', [resId1]);
    expect(Number(resDb1.rows[0].total_price) === 877800, 'Initial Total Price = 877,800');
    expect(Number(resDb1.rows[0].amount_paid) === 0, 'Initial Paid = 0');
    expect(Number(resDb1.rows[0].remaining_balance) === 877800, 'Initial Outstanding = 877,800');
    expect(resDb1.rows[0].payment_status === 'UNPAID', 'Initial Status = UNPAID');

    // Pay Rp100,000
    const payMultipart1 = buildMultipartBody({
      amount: '100000',
      payment_method: 'BANK_TRANSFER',
      property_id: String(propId)
    }, {
      name: 'file',
      filename: 'slip1.png',
      buffer: Buffer.from('fake-slip-image')
    });
    const payRes1 = await request('POST', `/api/reservations/${resId1}/payments`, payMultipart1);
    if (payRes1.status !== 200 && payRes1.status !== 201) {
      console.error('payRes1 error:', payRes1.status, payRes1.body || payRes1.raw);
    }
    expect(payRes1.status === 200 || payRes1.status === 201, 'Payment Rp100,000 recorded');

    const resDb1AfterPay = await pool.query('SELECT total_price, amount_paid, remaining_balance, payment_status FROM reservations WHERE id = $1', [resId1]);
    expect(Number(resDb1AfterPay.rows[0].total_price) === 877800, 'Total Price remains 877,800');
    expect(Number(resDb1AfterPay.rows[0].amount_paid) === 100000, 'Paid = 100,000');
    expect(Number(resDb1AfterPay.rows[0].remaining_balance) === 777800, 'Outstanding = 777,800 (Exact Non-50/50 reconciliation)');
    expect(resDb1AfterPay.rows[0].payment_status === 'PARTIAL', 'Status = PARTIAL');

    // ────────────────────────────────────────────────────────────────────────
    // TEST SECTION 2: 50/50 Extension & Payment Reconciliation Test (877,800 / 438,900)
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- Section 2: 50/50 Extension & Dual Payment Test ---');

    // Create 1-night reservation @ Rp438,900
    const bookRes2 = await request('POST', '/api/bookings', {
      property_id: propId,
      booking_source: 'OTA',
      ota_source: 'Agoda',
      booker_name: 'Audit Booker 2',
      guest_name: 'Audit Guest 2',
      reservations: [
        {
          room_type_id: rtId,
          room_id: roomId,
          check_in: '2026-10-10',
          check_out: '2026-10-11',
          total_price: 438900,
          subtotal_amount: 438900
        }
      ]
    });
    expect(bookRes2.status === 200 || bookRes2.status === 201, 'Booking 2 created');
    const bookingId2 = bookRes2.body.data.booking_id;
    const resId2 = bookRes2.body.data.reservations[0].id;
    createdBookingIds.add(bookingId2);
    createdReservationIds.add(resId2);

    // Payment #1: Rp438,900
    const payMultipart2A = buildMultipartBody({
      amount: '438900',
      payment_method: 'CASH',
      property_id: String(propId)
    }, {
      name: 'file',
      filename: 'slip2a.png',
      buffer: Buffer.from('fake-slip-image-2a')
    });
    const payRes2A = await request('POST', `/api/reservations/${resId2}/payments`, payMultipart2A);
    expect(payRes2A.status === 200, 'Payment #1 (Rp438,900) recorded');

    let resDb2 = await pool.query('SELECT total_price, amount_paid, remaining_balance, payment_status FROM reservations WHERE id = $1', [resId2]);
    expect(Number(resDb2.rows[0].total_price) === 438900, 'Res 2 Total = 438,900');
    expect(Number(resDb2.rows[0].amount_paid) === 438900, 'Res 2 Paid = 438,900');
    expect(Number(resDb2.rows[0].remaining_balance) === 0, 'Res 2 Outstanding = 0');
    expect(resDb2.rows[0].payment_status === 'PAID', 'Res 2 Status = PAID');

    // Extend 1 night @ Rp438,900
    const extRes = await request('POST', `/api/reservations/${resId2}/extend`, {
      property_id: propId,
      new_check_out: '2026-10-12',
      additional_night_rate: 438900,
      reason: 'Guest wants to stay longer'
    });
    if (extRes.status !== 200) {
      console.error('extRes error:', extRes.status, extRes.body || extRes.raw);
    }
    expect(extRes.status === 200, 'Stay extended 1 night');

    resDb2 = await pool.query('SELECT total_price, amount_paid, remaining_balance, payment_status FROM reservations WHERE id = $1', [resId2]);
    expect(Number(resDb2.rows[0].total_price) === 877800, 'Post-Extension Total Charges = Rp877,800');
    expect(Number(resDb2.rows[0].amount_paid) === 438900, 'Payment #1 preserved = Rp438,900');
    expect(Number(resDb2.rows[0].remaining_balance) === 438900, 'Outstanding = Rp438,900');
    expect(resDb2.rows[0].payment_status === 'PARTIAL', 'Status transitions to PARTIAL');

    // Payment #2: Rp438,900
    const payMultipart2B = buildMultipartBody({
      amount: '438900',
      payment_method: 'QRIS',
      property_id: String(propId)
    }, {
      name: 'file',
      filename: 'slip2b.png',
      buffer: Buffer.from('fake-slip-image-2b')
    });
    const payRes2B = await request('POST', `/api/reservations/${resId2}/payments`, payMultipart2B);
    expect(payRes2B.status === 200, 'Payment #2 (Rp438,900) recorded');

    resDb2 = await pool.query('SELECT total_price, amount_paid, remaining_balance, payment_status FROM reservations WHERE id = $1', [resId2]);
    expect(Number(resDb2.rows[0].total_price) === 877800, 'Total Charges = Rp877,800');
    expect(Number(resDb2.rows[0].amount_paid) === 877800, 'Total Paid = Rp877,800');
    expect(Number(resDb2.rows[0].remaining_balance) === 0, 'Outstanding = Rp0');
    expect(resDb2.rows[0].payment_status === 'PAID', 'Status is PAID');

    // ────────────────────────────────────────────────────────────────────────
    // TEST SECTION 3: Extension Transaction SALE Projection Net Verification
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- Section 3: Extension Transaction SALE Net Proof ---');

    const folioEntriesRes = await pool.query('SELECT * FROM folio_entries WHERE reservation_id = $1', [resId2]);
    const txSalesRes = await pool.query(
      `SELECT id, transaction_no, transaction_type, net_amount, source_type, description
       FROM transactions
       WHERE (reservation_id = $1 OR source_id = ANY($2::text[])) AND transaction_type = 'SALE'`,
      [resId2, folioEntriesRes.rows.map(r => String(r.id))]
    );

    expect(txSalesRes.rows.length === 2, 'Exactly 2 SALE transactions exist (Initial + Extension)');
    const [txInitial, txExt] = txSalesRes.rows.sort((a, b) => a.id - b.id);
    expect(Number(txInitial.net_amount) === 438900, 'Initial SALE = Rp438,900');
    expect(Number(txExt.net_amount) === 438900, 'Extension SALE = Rp438,900');

    const totalSaleNet = txSalesRes.rows.reduce((sum, r) => sum + Number(r.net_amount), 0);
    expect(totalSaleNet === 877800, 'Aggregate Valid SALE = Rp877,800 (NOT Rp1,316,700)');

    // ────────────────────────────────────────────────────────────────────────
    // TEST SECTION 4: Payment Correction & Void Symmetry
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- Section 4: Payment Correction & Void Invariant Test ---');

    // Create 2-night reservation @ Rp877,800
    const bookRes3 = await request('POST', '/api/bookings', {
      property_id: propId,
      booking_source: 'DIRECT',
      booker_name: 'Audit Booker 3',
      guest_name: 'Audit Guest 3',
      reservations: [
        {
          room_type_id: rtId,
          room_id: roomId,
          check_in: '2026-10-20',
          check_out: '2026-10-22',
          total_price: 877800,
          subtotal_amount: 877800
        }
      ]
    });
    expect(bookRes3.status === 200 || bookRes3.status === 201, 'Booking 3 created');
    const bookingId3 = bookRes3.body.data.booking_id;
    const resId3 = bookRes3.body.data.reservations[0].id;
    createdBookingIds.add(bookingId3);
    createdReservationIds.add(resId3);

    // Payment: Rp500,000
    const payMultipart3 = buildMultipartBody({
      amount: '500000',
      payment_method: 'CASH',
      property_id: String(propId)
    }, {
      name: 'file',
      filename: 'slip3.png',
      buffer: Buffer.from('fake-slip-image-3')
    });
    const payRes3 = await request('POST', `/api/reservations/${resId3}/payments`, payMultipart3);
    const paymentId3 = payRes3.body.data.payment.id;

    let resDb3 = await pool.query('SELECT total_price, amount_paid, remaining_balance, payment_status FROM reservations WHERE id = $1', [resId3]);
    expect(Number(resDb3.rows[0].amount_paid) === 500000, 'Initial Paid = 500,000');
    expect(Number(resDb3.rows[0].remaining_balance) === 377800, 'Initial Outstanding = 377,800');

    // Correct Payment from 500k -> 100k
    const corrMultipart = buildMultipartBody({
      property_id: String(propId),
      amount: '100000',
      payment_method: 'CASH',
      reason_code: 'WRONG_AMOUNT',
      reason_text: 'Typo input awal',
      actor_name: 'Receptionist'
    }, {
      name: 'file',
      filename: 'slip3_corr.png',
      buffer: Buffer.from('fake-slip-image-3-corr')
    });
    const corrRes = await request('POST', `/api/reservations/${resId3}/payments/${paymentId3}/correct`, corrMultipart);
    expect(corrRes.status === 200, 'Payment corrected successfully');

    resDb3 = await pool.query('SELECT total_price, amount_paid, remaining_balance, payment_status FROM reservations WHERE id = $1', [resId3]);
    expect(Number(resDb3.rows[0].amount_paid) === 100000, 'After Correction Paid = 100,000');
    expect(Number(resDb3.rows[0].remaining_balance) === 777800, 'After Correction Outstanding = 777,800');

    const replacementPaymentId = corrRes.body.data.replacement.id;

    // Void the replacement payment
    const voidRes = await request('POST', `/api/reservations/${resId3}/payments/${replacementPaymentId}/void`, {
      property_id: propId,
      reason_code: 'PAYMENT_CANCELLED',
      reason_text: 'Tamu membatalkan pembayaran tunai',
      actor_name: 'Receptionist'
    });
    expect(voidRes.status === 200, 'Payment voided successfully');

    resDb3 = await pool.query('SELECT total_price, amount_paid, remaining_balance, payment_status FROM reservations WHERE id = $1', [resId3]);
    expect(Number(resDb3.rows[0].amount_paid) === 0, 'After Void Paid = 0');
    expect(Number(resDb3.rows[0].remaining_balance) === 877800, 'After Void Outstanding = 877,800');
    expect(resDb3.rows[0].payment_status === 'UNPAID', 'Status returns to UNPAID');

    // ────────────────────────────────────────────────────────────────────────
    // TEST SECTION 5: Shorten Stay Net Proof & Overpayment State
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- Section 5: Shorten Stay Net Proof ---');

    // Create 2-night reservation @ Rp877,800, fully paid Rp877,800
    const bookRes4 = await request('POST', '/api/bookings', {
      property_id: propId,
      booking_source: 'OTA',
      ota_source: 'Traveloka',
      booker_name: 'Audit Booker 4',
      guest_name: 'Audit Guest 4',
      reservations: [
        {
          room_type_id: rtId,
          room_id: roomId,
          check_in: '2026-11-01',
          check_out: '2026-11-03',
          total_price: 877800,
          subtotal_amount: 877800
        }
      ]
    });
    expect(bookRes4.status === 200 || bookRes4.status === 201, 'Booking 4 created');
    const bookingId4 = bookRes4.body.data.booking_id;
    const resId4 = bookRes4.body.data.reservations[0].id;
    createdBookingIds.add(bookingId4);
    createdReservationIds.add(resId4);

    const payMultipart4 = buildMultipartBody({
      amount: '877800',
      payment_method: 'BANK_TRANSFER',
      property_id: String(propId)
    }, {
      name: 'file',
      filename: 'slip4.png',
      buffer: Buffer.from('fake-slip-image-4')
    });
    await request('POST', `/api/reservations/${resId4}/payments`, payMultipart4);

    // Shorten stay from 2 nights to 1 night
    const shortenRes = await request('POST', `/api/reservations/${resId4}/shorten`, {
      property_id: propId,
      new_check_out: '2026-11-02',
      reason: 'Tamu pulang lebih awal'
    });
    expect(shortenRes.status === 200, 'Stay shortened successfully');

    const resDb4 = await pool.query('SELECT total_price, amount_paid, remaining_balance, payment_status FROM reservations WHERE id = $1', [resId4]);
    expect(Number(resDb4.rows[0].total_price) === 438900, 'Valid charges revised to Rp438,900');
    expect(Number(resDb4.rows[0].amount_paid) === 877800, 'Paid remains intact = Rp877,800');
    expect(Number(resDb4.rows[0].remaining_balance) === 0, 'Remaining balance = 0');
    expect(resDb4.rows[0].payment_status === 'OVERPAID', 'Payment status is OVERPAID');

    // Verify Folio Credit Entry
    const folioShortenRes = await pool.query(
      `SELECT entry_type, direction, amount
       FROM folio_entries
       WHERE reservation_id = $1 AND entry_type = 'STAY_SHORTEN_ADJUSTMENT'`,
      [resId4]
    );
    expect(folioShortenRes.rows.length === 1, 'Exactly 1 STAY_SHORTEN_ADJUSTMENT folio entry exists');
    expect(folioShortenRes.rows[0].direction === 'CREDIT', 'Adjustment direction is CREDIT');
    expect(Number(folioShortenRes.rows[0].amount) === 438900, 'Adjustment amount is Rp438,900');

    // Verify Payment Transactions count remains exactly 1 (No payment deletion)
    const pmtCountRes = await pool.query('SELECT COUNT(*)::int as count FROM payment_transactions WHERE reservation_id = $1', [resId4]);
    expect(pmtCountRes.rows[0].count === 1, 'Payment transaction preserved (0 payment deleted)');

    console.log('\n======================================================');
    console.log('ALL FINANCIAL INVARIANT AUDIT CHECKS PASSED PERFECTLY!');
    console.log('======================================================\n');
  } finally {
    await cleanupFixtures();
    if (server) {
      server.close();
    }
  }
}

runAuditTests().then(() => {
  console.log('Audit test completed with 0 errors.');
  process.exit(0);
}).catch(err => {
  console.error('Audit test failed:', err);
  process.exit(1);
});

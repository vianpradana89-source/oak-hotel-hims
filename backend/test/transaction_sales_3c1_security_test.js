'use strict';

const http = require('http');
const express = require('express');
const { createTransactionsRouter } = require('../dist/domains/transactions/transactionsRouter');
const {
  projectFolioEntryToTransaction,
  projectPosOrderToTransaction,
} = require('../dist/domains/transactions/transactionService');
const { getPlatformSuperAdminToken, staffToken } = require('./helpers/transactionReadAuth');

let assertions = 0;
function expect(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function request(port, urlPath, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        let json = null;
        const body = Buffer.concat(chunks).toString('utf8');
        try { json = JSON.parse(body); } catch { /* ignore */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  const pkg = require('../dist/index.js');
  const schemaPkg = require('../dist/db/schema_v3.js');
  const pool = pkg.pool;
  await schemaPkg.initializeDatabase(pool);

  const rand = Math.floor(1000 + Math.random() * 9000);
  const propA = await pool.query(
    "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('SALES-3C1-A', $1, 'Asia/Jakarta', 'IDR', 'Addr', TRUE) RETURNING id",
    [`A${rand}`]
  );
  const propB = await pool.query(
    "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('SALES-3C1-B', $1, 'Asia/Jakarta', 'IDR', 'Addr', TRUE) RETURNING id",
    [`B${rand}`]
  );
  const propertyA = Number(propA.rows[0].id);
  const propertyB = Number(propB.rows[0].id);

  const app = express();
  app.use('/api/transactions', createTransactionsRouter(pool));
  const { server, port } = await listen(app);

  try {
    const booking = await pool.query(
      "INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status) VALUES ($1, $2, 'TAMU 3C1', 'ACTIVE') RETURNING id",
      [`BID-3C1-${rand}`, propertyA]
    );
    const rc = await pool.query(
      "INSERT INTO room_categories (property_id, code, name) VALUES ($1, 'S3C1', 'Cat') RETURNING id",
      [propertyA]
    );
    const rt = await pool.query(
      `INSERT INTO room_types (property_id, code, name, room_category_id, capacity, max_adults, max_children, is_active, display_order, base_rate)
       VALUES ($1, 'RT-3C1', 'RT 3C1', $2, 2, 2, 0, TRUE, 10, 300000) RETURNING id`,
      [propertyA, rc.rows[0].id]
    );
    const room = await pool.query(
      "INSERT INTO rooms (property_id, room_number, room_type_id, is_active) VALUES ($1, '401', $2, TRUE) RETURNING id",
      [propertyA, rt.rows[0].id]
    );
    const reservation = await pool.query(
      `INSERT INTO reservations (
         booking_id, room_id, status, stay_status, check_in, check_out,
         booked_room_type_id_snapshot, guest_name, stay_sequence,
         total_price, amount_paid, remaining_balance, payment_status, stay_type
       ) VALUES (
         $1, $2, 'BOOKED', 'RESERVED', CURRENT_DATE, CURRENT_DATE + 1,
         $3, 'TAMU 3C1', 1, 300000, 0, 300000, 'UNPAID', 'OVERNIGHT'
       ) RETURNING id`,
      [booking.rows[0].id, room.rows[0].id, rt.rows[0].id]
    );
    const txA = await pool.query(
      `INSERT INTO transactions (
         property_id, transaction_no, transaction_date, transaction_type, source_type, source_id,
         category_code, category_name, department_code, description,
         amount, net_amount, payment_status, transaction_status, guest_name_snapshot,
         reservation_id, booking_id
       ) VALUES (
         $1, $2, CURRENT_DATE, 'SALE', 'ROOM_CHARGE', $3,
         'ROOM_SALES', 'Room', 'FRONT_OFFICE', 'Room 3C1',
         300000, 300000, 'UNPAID', 'POSTED', 'TAMU 3C1', $4, $5
       ) RETURNING id`,
      [propertyA, `TRX-3C1-A-${rand}`, `rc-${rand}`, reservation.rows[0].id, booking.rows[0].id]
    );
    const txB = await pool.query(
      `INSERT INTO transactions (
         property_id, transaction_no, transaction_date, transaction_type, source_type,
         category_code, category_name, department_code, description,
         amount, net_amount, payment_status, transaction_status
       ) VALUES (
         $1, $2, CURRENT_DATE, 'SALE', 'MANUAL_SALE',
         'OTHER_SALES', 'Other', 'GENERAL', 'Prop B sale',
         10000, 10000, 'PAID', 'POSTED'
       ) RETURNING id`,
      [propertyB, `TRX-3C1-B-${rand}`]
    );

    const samePropToken = staffToken(propertyA, 900041);
    const otherPropToken = staffToken(propertyB, 900042);
    const saToken = await getPlatformSuperAdminToken(pool, 1);
    const txId = Number(txA.rows[0].id);
    const foreignTxId = Number(txB.rows[0].id);

    const noTokenList = await request(port, `/api/transactions?property_id=${propertyA}`);
    expect(noTokenList.status === 401, 'A. GET list no token => 401');
    expect(noTokenList.json && noTokenList.json.code === 'UNAUTHORIZED', 'A. list missing token code UNAUTHORIZED');

    const badTokenList = await request(port, `/api/transactions?property_id=${propertyA}`, 'not-a-jwt');
    expect(badTokenList.status === 401, 'B. GET list invalid token => 401');
    expect(badTokenList.json && badTokenList.json.code === 'INVALID_TOKEN', 'B. invalid token code INVALID_TOKEN');

    const sameList = await request(port, `/api/transactions?property_id=${propertyA}`, samePropToken);
    expect(sameList.status === 200, 'C. GET list valid same-property => 200');
    expect(Array.isArray(sameList.json && sameList.json.data && sameList.json.data.transactions), 'C. list payload present');

    const crossList = await request(port, `/api/transactions?property_id=${propertyB}`, samePropToken);
    expect(crossList.status === 403, 'D. list other property ordinary user => 403');

    const missingProp = await request(port, '/api/transactions', samePropToken);
    expect(missingProp.status === 400, 'E. list missing property_id => 400');
    const invalidProp = await request(port, '/api/transactions?property_id=0', samePropToken);
    expect(invalidProp.status === 400, 'E. list invalid property_id => 400');

    const saList = await request(port, `/api/transactions?property_id=${propertyA}`, saToken);
    expect(saList.status === 200, 'F. Platform Super Admin allowed requested property');

    const noTokenDetail = await request(port, `/api/transactions/${txId}?property_id=${propertyA}`);
    expect(noTokenDetail.status === 401, 'G. GET detail no token => 401');

    const badTokenDetail = await request(port, `/api/transactions/${txId}?property_id=${propertyA}`, 'not-a-jwt');
    expect(badTokenDetail.status === 401, 'H. detail invalid token => 401');

    const sameDetail = await request(port, `/api/transactions/${txId}?property_id=${propertyA}`, samePropToken);
    expect(sameDetail.status === 200, 'I. detail same property => 200');
    expect(Number(sameDetail.json.data.id) === txId, 'I. detail returns the requested transaction');

    const crossDetail = await request(port, `/api/transactions/${txId}?property_id=${propertyB}`, samePropToken);
    expect(crossDetail.status === 403, 'J. detail cross property => 403');

    const missingDetailProp = await request(port, `/api/transactions/${txId}`, samePropToken);
    expect(missingDetailProp.status === 400, 'K. detail missing property_id => 400');

    const leak = await request(port, `/api/transactions/${foreignTxId}?property_id=${propertyA}`, samePropToken);
    expect(leak.status === 404, 'L. transaction id from another property cannot leak');

    const bookingNoToken = await request(port, `/api/transactions/sales/bookings/${booking.rows[0].id}?property_id=${propertyA}`);
    expect(bookingNoToken.status === 401, 'M. booking-sales-detail no token => 401');
    const bookingOk = await request(port, `/api/transactions/sales/bookings/${booking.rows[0].id}?property_id=${propertyA}`, samePropToken);
    expect(bookingOk.status === 200, 'M. booking-sales-detail same property => 200');

    const pos1 = await pool.query(
      `INSERT INTO pos_orders (property_id, reservation_id, order_number, table_number, guest_name, status, total_amount)
       VALUES ($1, $2, $3, 'T1', 'TAMU 3C1', 'PAID', 45000) RETURNING id`,
      [propertyA, reservation.rows[0].id, `POS-3C1-1-${rand}`]
    );
    const pos2 = await pool.query(
      `INSERT INTO pos_orders (property_id, reservation_id, order_number, table_number, guest_name, status, total_amount)
       VALUES ($1, $2, $3, 'T2', 'TAMU 3C1', 'PAID', 45000) RETURNING id`,
      [propertyA, reservation.rows[0].id, `POS-3C1-2-${rand}`]
    );
    const posAId = Number(pos1.rows[0].id);
    const posBId = Number(pos2.rows[0].id);

    const posSale1 = await projectPosOrderToTransaction(pool, posAId, { propertyId: propertyA });
    const posSale1b = await projectPosOrderToTransaction(pool, posAId, { propertyId: propertyA });
    expect(Number(posSale1.id) === Number(posSale1b.id), 'O. duplicate POS projection is idempotent');

    const folioLinked = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, source_id, description, amount, direction)
       VALUES ($1, $2, 'POS_ROOM_CHARGE', 'POS', $3, 'Charge to room POS', 45000, 'DEBIT') RETURNING id`,
      [reservation.rows[0].id, propertyA, String(posAId)]
    );
    const linkedProj = await projectFolioEntryToTransaction(pool, Number(folioLinked.rows[0].id), { propertyId: propertyA });
    expect(Number(linkedProj.id) === Number(posSale1.id), 'N. linked folio reuses canonical POS SALE');
    const posCount = await pool.query(
      `SELECT COUNT(*)::int AS n FROM transactions
       WHERE property_id = $1 AND source_type IN ('POS', 'POS_ORDER') AND source_id = $2 AND reversal_of_transaction_id IS NULL`,
      [propertyA, String(posAId)]
    );
    expect(Number(posCount.rows[0].n) === 1, 'N. exactly one SALE for the POS economic source');

    const posSale2 = await projectPosOrderToTransaction(pool, posBId, { propertyId: propertyA });
    expect(Number(posSale2.id) !== Number(posSale1.id), 'P. different POS order is a second SALE');
    const folioOther = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, source_id, description, amount, direction)
       VALUES ($1, $2, 'POS_ROOM_CHARGE', 'POS', $3, 'Other POS same amount', 45000, 'DEBIT') RETURNING id`,
      [reservation.rows[0].id, propertyA, String(posBId)]
    );
    const otherProj = await projectFolioEntryToTransaction(pool, Number(folioOther.rows[0].id), { propertyId: propertyA });
    expect(Number(otherProj.id) === Number(posSale2.id), 'Q. same booking/date different POS order stays the second SALE');

    const folioGuess = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, description, amount, direction)
       VALUES ($1, $2, 'POS_ROOM_CHARGE', 'POS_ROOM_CHARGE', 'POS-like without order id', 45000, 'DEBIT') RETURNING id`,
      [reservation.rows[0].id, propertyA]
    );
    const guessProj = await projectFolioEntryToTransaction(pool, Number(folioGuess.rows[0].id), { propertyId: propertyA });
    expect(Number(guessProj.id) !== Number(posSale1.id), 'R. folio without explicit POS identity is not guessed onto existing POS SALE');
    expect(String(guessProj.source_id) === String(folioGuess.rows[0].id), 'R. unlinked POS-like folio keeps folio source_id');

    const roomFolio = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, description, amount, direction)
       VALUES ($1, $2, 'ROOM_CHARGE', 'ROOM_CHARGE', 'Room', 300000, 'DEBIT') RETURNING id`,
      [reservation.rows[0].id, propertyA]
    );
    const roomProj = await projectFolioEntryToTransaction(pool, Number(roomFolio.rows[0].id), { propertyId: propertyA });
    expect(roomProj.source_type === 'ROOM_CHARGE', 'S. ROOM_CHARGE still projects as ROOM_CHARGE');

    const laundryFolio = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, description, amount, direction)
       VALUES ($1, $2, 'LAUNDRY', 'LAUNDRY', 'Laundry', 25000, 'DEBIT') RETURNING id`,
      [reservation.rows[0].id, propertyA]
    );
    const laundryProj = await projectFolioEntryToTransaction(pool, Number(laundryFolio.rows[0].id), { propertyId: propertyA });
    expect(laundryProj.source_type === 'LAUNDRY', 'T. LAUNDRY unaffected');

    const extraFolio = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, description, amount, direction)
       VALUES ($1, $2, 'EXTRA_BED', 'EXTRA_BED', 'Extra bed', 50000, 'DEBIT') RETURNING id`,
      [reservation.rows[0].id, propertyA]
    );
    const extraProj = await projectFolioEntryToTransaction(pool, Number(extraFolio.rows[0].id), { propertyId: propertyA });
    expect(extraProj.source_type === 'EXTRA_BED', 'U. EXTRA_BED unaffected');

    const payFolio = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, description, amount, direction)
       VALUES ($1, $2, 'PAYMENT', 'PAYMENT', 'Settlement', 100000, 'CREDIT') RETURNING id`,
      [reservation.rows[0].id, propertyA]
    );
    const payProj = await projectFolioEntryToTransaction(pool, Number(payFolio.rows[0].id), { propertyId: propertyA });
    expect(payProj === null, 'V. PAYMENT remains non-revenue');

    const posBProp = await pool.query(
      `INSERT INTO pos_orders (property_id, order_number, guest_name, status, total_amount)
       VALUES ($1, $2, 'WALKIN B', 'PAID', 45000) RETURNING id`,
      [propertyB, `POS-3C1-B-${rand}`]
    );
    const posBSale = await projectPosOrderToTransaction(pool, Number(posBProp.rows[0].id), { propertyId: propertyB });
    const crossFolio = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, source_id, description, amount, direction)
       VALUES ($1, $2, 'POS_ROOM_CHARGE', 'POS', $3, 'Same source id other property', 45000, 'DEBIT') RETURNING id`,
      [reservation.rows[0].id, propertyA, String(posBProp.rows[0].id)]
    );
    const crossProj = await projectFolioEntryToTransaction(pool, Number(crossFolio.rows[0].id), { propertyId: propertyA });
    expect(Number(crossProj.id) !== Number(posBSale.id), 'W. same POS source different property never cross-dedupes');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.query('DELETE FROM transactions WHERE property_id = ANY($1::int[])', [[propertyA, propertyB]]).catch(() => {});
    await pool.query('DELETE FROM folio_entries WHERE property_id = ANY($1::int[])', [[propertyA, propertyB]]).catch(() => {});
    await pool.query('DELETE FROM pos_orders WHERE property_id = ANY($1::int[])', [[propertyA, propertyB]]).catch(() => {});
    await pool.query('DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = ANY($1::int[]))', [[propertyA, propertyB]]).catch(() => {});
    await pool.query('DELETE FROM bookings WHERE property_id = ANY($1::int[])', [[propertyA, propertyB]]).catch(() => {});
    await pool.query('DELETE FROM rooms WHERE property_id = ANY($1::int[])', [[propertyA, propertyB]]).catch(() => {});
    await pool.query('DELETE FROM room_types WHERE property_id = ANY($1::int[])', [[propertyA, propertyB]]).catch(() => {});
    await pool.query('DELETE FROM room_categories WHERE property_id = ANY($1::int[])', [[propertyA, propertyB]]).catch(() => {});
    await pool.query('DELETE FROM properties WHERE id = ANY($1::int[])', [[propertyA, propertyB]]).catch(() => {});
  }

  console.log(`PASS | SALES-3C1 security/POS | ${assertions} assertions`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

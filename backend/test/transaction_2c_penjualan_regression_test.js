import assert from 'node:assert/strict';
import http from 'node:http';
import pkg from '../dist/index.js';
import schemaPkg from '../dist/db/schema_v3.js';
import {
  projectFolioEntryToTransaction,
  projectPosOrderToTransaction,
  createManualTransaction,
  getTransactions
} from '../dist/domains/transactions/transactionService.js';

const { app, pool } = pkg;
const { initializeDatabase } = schemaPkg;

async function runTests() {
  console.log('=== RUNNING TRANSACTION-2C PENJUALAN MERGE REGRESSION SUITE ===');

  await initializeDatabase(pool);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const randNum = Math.floor(1000 + Math.random() * 9000);
  const propCodeA = `CA${randNum}`;
  const propCodeB = `CB${randNum}`;
  const testBid = `BID-${randNum}-T2C`;

  const tracked = {
    properties: [],
    bookings: [],
    reservations: [],
    folioEntries: [],
    categories: [],
    menuItems: [],
    posOrders: [],
    transactions: []
  };

  try {
    // 0. Setup two isolated test properties
    const propARes = await pool.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('T2C Penjualan Prop A', $1, 'Asia/Jakarta', 'IDR', 'Addr A', TRUE) RETURNING id",
      [propCodeA]
    );
    const propAId = Number(propARes.rows[0].id);
    tracked.properties.push(propAId);

    const propBRes = await pool.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('T2C Penjualan Prop B', $1, 'Asia/Jakarta', 'IDR', 'Addr B', TRUE) RETURNING id",
      [propCodeB]
    );
    const propBId = Number(propBRes.rows[0].id);
    tracked.properties.push(propBId);

    // Setup Room Master & Booking for Property A
    const rcRes = await pool.query(
      "INSERT INTO room_categories (property_id, code, name) VALUES ($1, 'CAT-T2C-A', 'Cat T2C A') RETURNING id",
      [propAId]
    );
    const rtRes = await pool.query(
      `INSERT INTO room_types (property_id, code, name, room_category_id, capacity, max_adults, max_children, is_active, display_order, base_rate)
       VALUES ($1, 'RT-T2C-A', 'Room Type T2C A', $2, 2, 2, 0, TRUE, 10, 750000) RETURNING id`,
      [propAId, rcRes.rows[0].id]
    );
    const roomRes = await pool.query(
      "INSERT INTO rooms (property_id, room_number, room_type_id, is_active) VALUES ($1, '208', $2, TRUE) RETURNING id",
      [propAId, rtRes.rows[0].id]
    );

    const bookingRes = await pool.query(
      "INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status) VALUES ($1, $2, 'BUDI SANTOSO', 'ACTIVE') RETURNING id",
      [testBid, propAId]
    );
    const bookingId = Number(bookingRes.rows[0].id);
    tracked.bookings.push(bookingId);

    const resRes = await pool.query(
      `INSERT INTO reservations (booking_id, room_id, status, stay_status, check_in, check_out, booked_room_type_id_snapshot, guest_name, stay_sequence, total_price, amount_paid, remaining_balance, payment_status)
       VALUES ($1, $2, 'BOOKED', 'RESERVED', CURRENT_DATE, CURRENT_DATE + 2, $3, 'BUDI SANTOSO', 1, 1500000, 0, 1500000, 'UNPAID')
       RETURNING id`,
      [bookingId, roomRes.rows[0].id, rtRes.rows[0].id]
    );
    const reservationId = Number(resRes.rows[0].id);
    tracked.reservations.push(reservationId);

    // Setup POS Catalog
    const posCatRes = await pool.query(
      "INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, 'Resto & Cafe') RETURNING id",
      [propAId]
    );
    const posCatId = Number(posCatRes.rows[0].id);
    tracked.categories.push(posCatId);

    const menuItemRes = await pool.query(
      `INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, is_active)
       VALUES ($1, $2, 'NAS-GOR-T2C', 'Nasi Goreng Spesial', 45000, TRUE) RETURNING id`,
      [propAId, posCatId]
    );
    const menuItemId = Number(menuItemRes.rows[0].id);
    tracked.menuItems.push(menuItemId);

    console.log('✓ Test fixtures setup successfully');

    // -------------------------------------------------------------
    // Test 1: Reservation existence ALONE does NOT create a SALE
    // -------------------------------------------------------------
    console.log('Test 1: Reservation existence alone does NOT create a SALE');
    const initSales = await getTransactions(pool, {
      property_id: propAId,
      transaction_type: 'SALE'
    });
    assert.strictEqual(initSales.transactions.length, 0, 'No sales should exist before economic charge created');
    console.log('  PASS: 0 SALE rows when only reservation exists');

    // -------------------------------------------------------------
    // Test 2: Folio Room Charge -> exactly 1 SALE in Penjualan
    // -------------------------------------------------------------
    console.log('Test 2: Folio Room Charge -> exactly 1 SALE in Penjualan');
    const chargeRes = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, description, amount, direction)
       VALUES ($1, $2, 'ROOM_CHARGE', 'ROOM_CHARGE', 'Room Charge Malam 1', 750000, 'DEBIT')
       RETURNING id`,
      [reservationId, propAId]
    );
    const chargeId = Number(chargeRes.rows[0].id);
    tracked.folioEntries.push(chargeId);

    const proj1 = await projectFolioEntryToTransaction(pool, chargeId, { propertyId: propAId });
    assert.ok(proj1, 'Should create transaction record');
    assert.strictEqual(proj1.transaction_type, 'SALE');
    assert.strictEqual(proj1.category_code, 'ROOM_SALES');
    assert.strictEqual(Number(proj1.net_amount), 750000);
    assert.strictEqual(proj1.guest_name_snapshot, 'BUDI SANTOSO');
    assert.strictEqual(proj1.room_number_snapshot, '208');
    tracked.transactions.push(Number(proj1.id));

    // Verify through getTransactions that joined booking_bid is available
    const txFromGet = await getTransactions(pool, { property_id: propAId, transaction_type: 'SALE' });
    assert.strictEqual(txFromGet.transactions.length, 1);
    assert.strictEqual(txFromGet.transactions[0].booking_bid, testBid);
    console.log('  PASS: Exactly 1 SALE row created with BID, Guest, Room, Category');

    // -------------------------------------------------------------
    // Test 3: Folio Extra Bed -> exactly 1 SALE in Penjualan
    // -------------------------------------------------------------
    console.log('Test 3: Folio Extra Bed -> exactly 1 SALE in Penjualan');
    const extraBedRes = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, description, amount, direction)
       VALUES ($1, $2, 'EXTRA_BED', 'EXTRA_BED', 'Extra Bed 1 Set', 150000, 'DEBIT')
       RETURNING id`,
      [reservationId, propAId]
    );
    const extraBedId = Number(extraBedRes.rows[0].id);
    tracked.folioEntries.push(extraBedId);

    const projExtra = await projectFolioEntryToTransaction(pool, extraBedId, { propertyId: propAId });
    assert.strictEqual(projExtra.transaction_type, 'SALE');
    assert.strictEqual(projExtra.category_code, 'EXTRA_BED_SALES');
    assert.strictEqual(Number(projExtra.net_amount), 150000);
    tracked.transactions.push(Number(projExtra.id));
    console.log('  PASS: Extra Bed projected to EXTRA_BED_SALES correctly');

    // -------------------------------------------------------------
    // Test 4: Folio Laundry -> exactly 1 SALE in Penjualan
    // -------------------------------------------------------------
    console.log('Test 4: Folio Laundry -> exactly 1 SALE in Penjualan');
    const laundryRes = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, description, amount, direction)
       VALUES ($1, $2, 'LAUNDRY', 'LAUNDRY', 'Cuci Kemeja 2 Pcs', 50000, 'DEBIT')
       RETURNING id`,
      [reservationId, propAId]
    );
    const laundryId = Number(laundryRes.rows[0].id);
    tracked.folioEntries.push(laundryId);

    const projLaundry = await projectFolioEntryToTransaction(pool, laundryId, { propertyId: propAId });
    assert.strictEqual(projLaundry.transaction_type, 'SALE');
    assert.strictEqual(projLaundry.category_code, 'LAUNDRY_SALES');
    assert.strictEqual(Number(projLaundry.net_amount), 50000);
    tracked.transactions.push(Number(projLaundry.id));
    console.log('  PASS: Laundry projected to LAUNDRY_SALES correctly');

    // -------------------------------------------------------------
    // Test 5: POS Completed Order -> exactly 1 SALE in Penjualan
    // -------------------------------------------------------------
    console.log('Test 5: POS Completed Order -> exactly 1 SALE in Penjualan');
    const createPosRes = await fetch(`${baseUrl}/api/pos/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        property_id: propAId,
        table_number: 'Meja 01',
        guest_name: 'Andi Walkin',
        status: 'PAID',
        items: [
          { menu_item_id: menuItemId, quantity: 2 }
        ]
      })
    });
    const createPosData = await createPosRes.json();
    assert.strictEqual(createPosRes.status, 201);
    const posOrderId = Number(createPosData.data.id);
    tracked.posOrders.push(posOrderId);

    const posTxRes = await pool.query(
      "SELECT * FROM transactions WHERE property_id = $1 AND source_type = 'POS_ORDER' AND source_id = $2",
      [propAId, String(posOrderId)]
    );
    assert.strictEqual(posTxRes.rowCount, 1);
    const posTx = posTxRes.rows[0];
    assert.strictEqual(posTx.transaction_type, 'SALE');
    assert.strictEqual(posTx.category_code, 'FNB_SALES');
    assert.strictEqual(Number(posTx.net_amount), 90000);
    tracked.transactions.push(Number(posTx.id));
    console.log('  PASS: POS order projected to FNB_SALES with POS reference');

    // -------------------------------------------------------------
    // Test 6: Direct Payment / Settlement does NOT create a SALE
    // -------------------------------------------------------------
    console.log('Test 6: Direct Payment / Settlement does NOT create a SALE');
    const payRes = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, description, amount, direction)
       VALUES ($1, $2, 'PAYMENT', 'PAYMENT', 'Pembayaran Tunai Tamu', 750000, 'CREDIT')
       RETURNING id`,
      [reservationId, propAId]
    );
    const payId = Number(payRes.rows[0].id);
    tracked.folioEntries.push(payId);

    const projPay = await projectFolioEntryToTransaction(pool, payId, { propertyId: propAId });
    assert.strictEqual(projPay, null, 'Payment must NOT generate a transaction SALE row');
    console.log('  PASS: Payment returned null (no duplicate SALE created)');

    // -------------------------------------------------------------
    // Test 7: BID Search returns all linked sales
    // -------------------------------------------------------------
    console.log('Test 7: BID Search returns all linked sales');
    const searchBidRes = await getTransactions(pool, {
      property_id: propAId,
      transaction_type: 'SALE',
      search: testBid
    });
    assert.strictEqual(searchBidRes.transactions.length, 3, 'Should find 3 charges (Room, Extra Bed, Laundry)');
    searchBidRes.transactions.forEach((tx) => {
      assert.strictEqual(tx.booking_bid, testBid);
      assert.strictEqual(tx.guest_name_snapshot, 'BUDI SANTOSO');
      assert.strictEqual(tx.room_number_snapshot, '208');
    });
    console.log('  PASS: BID search returned exactly the 3 linked stay sales');

    // -------------------------------------------------------------
    // Test 8: Combined Penjualan Summary includes Room + Extra + Laundry + POS
    // -------------------------------------------------------------
    console.log('Test 8: Combined Penjualan Summary includes Room + Extra + Laundry + POS');
    const fullSalesRes = await getTransactions(pool, {
      property_id: propAId,
      transaction_type: 'SALE'
    });
    assert.strictEqual(fullSalesRes.transactions.length, 4, '4 sales total');
    // Expected total: 750000 + 150000 + 50000 + 90000 = 1040000
    assert.strictEqual(Number(fullSalesRes.summary.total_sale), 1040000, 'Total sale should equal sum of charges');
    assert.strictEqual(Number(fullSalesRes.summary.count_sale), 4);
    console.log('  PASS: Combined sales total is Rp 1.040.000 across 4 sales records');

    // -------------------------------------------------------------
    // Test 9: Voided Charge generates REVERSAL and nets Penjualan economic total to correct sum
    // -------------------------------------------------------------
    console.log('Test 9: Voided Charge generates REVERSAL and nets Penjualan economic total');
    const feRevRes = await pool.query(
      `INSERT INTO folio_entries (
        reservation_id, property_id, entry_type, source_type, source_id,
        description, amount, direction, reversal_of_entry_id, status
       ) VALUES (
        $1, $2, 'REVERSAL', 'LAUNDRY', $3,
        'Pembatalan: Cuci Kemeja 2 Pcs', 50000, 'CREDIT', $4, 'REVERSED'
       ) RETURNING id`,
      [reservationId, propAId, String(laundryId), laundryId]
    );
    const feRevId = Number(feRevRes.rows[0].id);
    tracked.folioEntries.push(feRevId);

    const projVoid = await projectFolioEntryToTransaction(pool, feRevId, { propertyId: propAId });
    assert.ok(projVoid, 'Reversal transaction must be created');
    assert.strictEqual(projVoid.transaction_status, 'REVERSED');
    assert.strictEqual(Number(projVoid.net_amount), -50000);
    tracked.transactions.push(Number(projVoid.id));

    const afterVoidRes = await getTransactions(pool, {
      property_id: propAId,
      transaction_type: 'SALE'
    });
    // Total sale net: 1040000 - 50000 = 990000
    assert.strictEqual(Number(afterVoidRes.summary.total_sale), 990000, 'Void correctly nets summary total');
    console.log('  PASS: Voided transaction net sum is exactly Rp 990.000');

    // -------------------------------------------------------------
    // Test 10: Operational Status Filters (PROSES, SELESAI, BATAL)
    // -------------------------------------------------------------
    console.log('Test 10: Operational Status Filters (PROSES, SELESAI, BATAL)');
    const selesaiRes = await getTransactions(pool, {
      property_id: propAId,
      transaction_type: 'SALE',
      operational_status: 'SELESAI'
    });
    assert.ok(selesaiRes.transactions.length >= 1, 'Should return completed sales');

    const batalRes = await getTransactions(pool, {
      property_id: propAId,
      transaction_type: 'SALE',
      operational_status: 'BATAL'
    });
    assert.ok(batalRes.transactions.length >= 1, 'Should return voided/reversed transactions');
    assert.ok(batalRes.transactions.some((t) => t.id === projVoid.id), 'Reversal transaction must be in BATAL filter');
    console.log('  PASS: Operational filters SELESAI and BATAL operate accurately');

    // -------------------------------------------------------------
    // Test 11: Property Isolation
    // -------------------------------------------------------------
    console.log('Test 11: Property Isolation');
    const propBSales = await getTransactions(pool, {
      property_id: propBId,
      transaction_type: 'SALE'
    });
    assert.strictEqual(propBSales.transactions.length, 0, 'Property B must have 0 sales');
    assert.strictEqual(Number(propBSales.summary.total_sale), 0);
    console.log('  PASS: Property B isolated with 0 leaked records');

    // -------------------------------------------------------------
    // Test 12: Manual insertion of operational category rejected
    // -------------------------------------------------------------
    console.log('Test 12: Manual insertion of operational category rejected');
    await assert.rejects(
      async () => {
        await createManualTransaction(
          pool,
          {
            property_id: propAId,
            transaction_type: 'SALE',
            category_code: 'ROOM_SALES',
            amount: 500000,
            transaction_date: '2026-08-30',
            description: 'Manual duplicate room sale attempt'
          },
          'Front Desk'
        );
      },
      {
        message: /tidak dapat dicatat manual/i
      }
    );
    console.log('  PASS: Manual creation of automated operational category properly blocked');

    // -------------------------------------------------------------
    // Test 13: HTTP REST API GET /api/transactions returns expected Penjualan schema
    // -------------------------------------------------------------
    console.log('Test 13: HTTP REST API GET /api/transactions returns expected Penjualan schema');
    const httpRes = await fetch(`${baseUrl}/api/transactions?property_id=${propAId}&transaction_type=SALE`);
    assert.strictEqual(httpRes.status, 200);
    const httpData = await httpRes.json();
    assert.ok(httpData.success);
    assert.ok(Array.isArray(httpData.data.transactions));
    const firstTx = httpData.data.transactions[0];
    assert.ok(firstTx.id);
    assert.ok(firstTx.transaction_no);
    assert.ok(firstTx.transaction_date);
    assert.ok(firstTx.net_amount !== undefined);
    assert.ok(firstTx.source_type);
    console.log('  PASS: HTTP endpoint response payload matches Penjualan contract');

    // -------------------------------------------------------------
    // Test 14: Stay charge Day Use & Early Checkin projection
    // -------------------------------------------------------------
    console.log('Test 14: Stay charge Day Use & Early Checkin projection');
    const dayUseRes = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, description, amount, direction)
       VALUES ($1, $2, 'DAY_USE_ROOM', 'DAY_USE_ROOM', 'Day Use 6 Jam', 400000, 'DEBIT')
       RETURNING id`,
      [reservationId, propAId]
    );
    const dayUseId = Number(dayUseRes.rows[0].id);
    tracked.folioEntries.push(dayUseId);
    const projDayUse = await projectFolioEntryToTransaction(pool, dayUseId, { propertyId: propAId });
    assert.strictEqual(projDayUse.category_code, 'DAY_USE_SALES');
    assert.strictEqual(Number(projDayUse.net_amount), 400000);
    tracked.transactions.push(Number(projDayUse.id));

    const earlyInRes = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, description, amount, direction)
       VALUES ($1, $2, 'EARLY_CHECKIN', 'EARLY_CHECKIN', 'Early Check In 09:00', 100000, 'DEBIT')
       RETURNING id`,
      [reservationId, propAId]
    );
    const earlyInId = Number(earlyInRes.rows[0].id);
    tracked.folioEntries.push(earlyInId);
    const projEarly = await projectFolioEntryToTransaction(pool, earlyInId, { propertyId: propAId });
    assert.strictEqual(projEarly.category_code, 'EARLY_CHECKIN_SALES');
    assert.strictEqual(Number(projEarly.net_amount), 100000);
    tracked.transactions.push(Number(projEarly.id));
    console.log('  PASS: DAY_USE_ROOM and EARLY_CHECKIN correctly mapped to canonical sales');

    console.log('\n=============================================================');
    console.log('>>> ALL 14 TRANSACTION-2C REGRESSION SUITE TESTS PASSED! <<<');
    console.log('=============================================================\n');
  } finally {
    console.log('Cleaning up fixtures...');
    try {
      if (tracked.properties.length > 0) {
        await pool.query('DELETE FROM transaction_attachments WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM transactions WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM transaction_daily_sequences WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM audit_logs WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM pos_order_items WHERE order_id IN (SELECT id FROM pos_orders WHERE property_id = ANY($1))', [tracked.properties]);
        await pool.query('DELETE FROM pos_orders WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM pos_menu_items WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM pos_menu_categories WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM folio_entries WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = ANY($1))', [tracked.properties]);
        await pool.query('DELETE FROM bookings WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM rooms WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM availability_dates WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id = ANY($1))', [tracked.properties]);
        await pool.query('DELETE FROM rate_plans WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM meal_plans WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM room_types WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM room_categories WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM property_features WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM property_brandings WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM property_pricing_settings WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM property_housekeeping_settings WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM property_attendance_settings WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM property_quick_booking_rules WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM property_day_use_durations WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM properties WHERE id = ANY($1)', [tracked.properties]);
      }
    } catch (cleanupErr) {
      console.error('Cleanup error (non-fatal):', cleanupErr.message);
    }
    server.close();
    await pool.end();
  }
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});

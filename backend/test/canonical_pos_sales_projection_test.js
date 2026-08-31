import assert from 'node:assert/strict';
import http from 'node:http';
import pkg from '../dist/index.js';
import schemaPkg from '../dist/db/schema_v3.js';
import {
  projectFolioEntryToTransaction,
  projectPosOrderToTransaction,
  createManualTransaction,
  getTransactions,
  reconcileHistoricalTransactions
} from '../dist/domains/transactions/transactionService.js';

const { app, pool } = pkg;
const { initializeDatabase } = schemaPkg;

async function runTests() {
  console.log('=== RUNNING CANONICAL POS & ROOM SALES PROJECTION INTEGRATION SUITE ===');

  await initializeDatabase(pool);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const tracked = {
    properties: [],
    bookings: [],
    reservations: [],
    folioEntries: [],
    categories: [],
    menuItems: [],
    posOrders: [],
    posOrderItems: [],
    transactions: []
  };

  try {
    // 0. Setup two isolated test properties
    const propARes = await pool.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('POS Sales Prop A', 'PSPA', 'Asia/Jakarta', 'IDR', 'Addr A', TRUE) RETURNING id"
    );
    const propAId = Number(propARes.rows[0].id);
    tracked.properties.push(propAId);

    const propBRes = await pool.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('POS Sales Prop B', 'PSPB', 'Asia/Jakarta', 'IDR', 'Addr B', TRUE) RETURNING id"
    );
    const propBId = Number(propBRes.rows[0].id);
    tracked.properties.push(propBId);

    // Setup Room Master & Booking for Property A
    const rcRes = await pool.query(
      "INSERT INTO room_categories (property_id, code, name) VALUES ($1, 'CAT-POS-A', 'Cat POS A') RETURNING id",
      [propAId]
    );
    const rtRes = await pool.query(
      `INSERT INTO room_types (property_id, code, name, room_category_id, capacity, max_adults, max_children, is_active, display_order, base_rate)
       VALUES ($1, 'RT-POS-A', 'Room Type POS A', $2, 2, 2, 0, TRUE, 10, 750000) RETURNING id`,
      [propAId, rcRes.rows[0].id]
    );
    const roomRes = await pool.query(
      "INSERT INTO rooms (property_id, room_number, room_type_id, is_active) VALUES ($1, '301', $2, TRUE) RETURNING id",
      [propAId, rtRes.rows[0].id]
    );

    const bookingRes = await pool.query(
      "INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status) VALUES ('BID-POS-TEST-01', $1, 'Bpk. Hendra Gunawan', 'ACTIVE') RETURNING id",
      [propAId]
    );
    const bookingId = Number(bookingRes.rows[0].id);
    tracked.bookings.push(bookingId);

    const resRes = await pool.query(
      `INSERT INTO reservations (booking_id, room_id, status, stay_status, check_in, check_out, booked_room_type_id_snapshot, guest_name, stay_sequence, total_price, amount_paid, remaining_balance, payment_status)
       VALUES ($1, $2, 'BOOKED', 'RESERVED', CURRENT_DATE, CURRENT_DATE + 2, $3, 'Bpk. Hendra Gunawan', 1, 1500000, 0, 1500000, 'UNPAID')
       RETURNING id`,
      [bookingId, roomRes.rows[0].id, rtRes.rows[0].id]
    );
    const reservationId = Number(resRes.rows[0].id);
    tracked.reservations.push(reservationId);

    // Setup POS Menu in Property A and Property B
    const catARes = await pool.query(
      "INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, 'Resto & Cafe') RETURNING id",
      [propAId]
    );
    const catAId = Number(catARes.rows[0].id);
    tracked.categories.push(catAId);

    const menu1Res = await pool.query(
      "INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, is_active) VALUES ($1, $2, 'NAS-GOR-01', 'Nasi Goreng Spesial', 45000, TRUE) RETURNING id",
      [propAId, catAId]
    );
    const menu1Id = Number(menu1Res.rows[0].id);
    tracked.menuItems.push(menu1Id);

    const menu2Res = await pool.query(
      "INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, is_active) VALUES ($1, $2, 'JUS-ALPUKAT', 'Jus Alpukat', 25000, TRUE) RETURNING id",
      [propAId, catAId]
    );
    const menu2Id = Number(menu2Res.rows[0].id);
    tracked.menuItems.push(menu2Id);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST A: Room charge -> exactly 1 SALE in Penjualan
    // ──────────────────────────────────────────────────────────────────────────
    console.log('Test A: Room charge -> exactly 1 SALE in Penjualan');
    const fe1Res = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, description, amount, direction)
       VALUES ($1, $2, 'ROOM_CHARGE', 'ROOM_CHARGE', 'Kamar Deluxe (2 Malam)', 1500000, 'DEBIT') RETURNING id`,
      [reservationId, propAId]
    );
    const fe1Id = Number(fe1Res.rows[0].id);
    tracked.folioEntries.push(fe1Id);

    const txRoom = await projectFolioEntryToTransaction(pool, fe1Id, { propertyId: propAId });
    assert.ok(txRoom, 'Room charge transaction must be created');
    assert.equal(txRoom.transaction_type, 'SALE', 'Room charge must be SALE');
    assert.equal(txRoom.source_type, 'ROOM_CHARGE', 'Source type must be ROOM_CHARGE');
    assert.equal(txRoom.category_code, 'ROOM_SALES', 'Category must be ROOM_SALES');
    assert.equal(Number(txRoom.net_amount), 1500000, 'Net amount must match 1,500,000 IDR');
    tracked.transactions.push(txRoom.id);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST B: Room payment -> no duplicate SALE (Settlement only)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('Test B: Room payment -> no duplicate SALE');
    const fePaymentRes = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, description, amount, direction)
       VALUES ($1, $2, 'PAYMENT', 'PAYMENT', 'Pembayaran Pelunasan Kamar via Transfer BCA', 1500000, 'CREDIT') RETURNING id`,
      [reservationId, propAId]
    );
    const fePayId = Number(fePaymentRes.rows[0].id);
    tracked.folioEntries.push(fePayId);

    const txPay = await projectFolioEntryToTransaction(pool, fePayId, { propertyId: propAId });
    assert.equal(txPay, null, 'Payment entry must return null and never create a SALE transaction');

    const totalTxsAfterPay = await pool.query('SELECT COUNT(*) as cnt FROM transactions WHERE property_id = $1', [propAId]);
    assert.equal(Number(totalTxsAfterPay.rows[0].cnt), 1, 'Total transactions must remain 1 after payment');

    // ──────────────────────────────────────────────────────────────────────────
    // TEST C: POS completed sale -> exactly 1 SALE (FNB_SALES)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('Test C: POS completed sale -> exactly 1 SALE (FNB_SALES)');
    // 2x Nasi Goreng (90,000) + 1x Jus Alpukat (25,000) = 115,000 IDR
    const createPosRes = await fetch(`${baseUrl}/api/pos/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        property_id: propAId,
        reservation_id: reservationId,
        table_number: 'Meja 05',
        guest_name: 'Bpk. Hendra Gunawan',
        status: 'PAID',
        items: [
          { menu_item_id: menu1Id, quantity: 2 },
          { menu_item_id: menu2Id, quantity: 1 }
        ]
      })
    });
    const createPosData = await createPosRes.json();
    assert.equal(createPosRes.status, 201, 'POS Order creation should return 201');
    assert.equal(createPosData.status, 'SUCCESS', 'POS Order creation should succeed');
    const posOrderId = Number(createPosData.data.id);
    tracked.posOrders.push(posOrderId);
    assert.equal(Number(createPosData.data.total_amount), 115000, 'POS order total must be 115,000 IDR');

    // Verify transaction created for POS order
    const posTxRes = await pool.query(
      "SELECT * FROM transactions WHERE property_id = $1 AND source_type = 'POS_ORDER' AND source_id = $2",
      [propAId, String(posOrderId)]
    );
    assert.equal(posTxRes.rowCount, 1, 'Exactly one transaction row must be created for POS order');
    const posTx = posTxRes.rows[0];
    assert.equal(posTx.transaction_type, 'SALE', 'POS transaction must be SALE');
    assert.equal(posTx.category_code, 'FNB_SALES', 'Category must be FNB_SALES');
    assert.equal(posTx.department_code, 'FNB', 'Department must be FNB');
    assert.equal(Number(posTx.net_amount), 115000, 'Net amount must match 115,000 IDR');
    assert.equal(posTx.payment_status, 'PAID', 'Payment status must be PAID');
    assert.equal(posTx.room_number_snapshot, '301', 'Room number snapshot should match linked reservation');
    tracked.transactions.push(posTx.id);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST D: POS payment -> no duplicate SALE
    // ──────────────────────────────────────────────────────────────────────────
    console.log('Test D: POS payment -> no duplicate SALE');
    // Calling status update with PAID again
    const patchPosRes = await fetch(`${baseUrl}/api/pos/orders/${posOrderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        property_id: propAId,
        status: 'PAID'
      })
    });
    assert.equal(patchPosRes.status, 200, 'POS status patch should succeed');

    const posTxCount = await pool.query(
      "SELECT COUNT(*) as cnt FROM transactions WHERE property_id = $1 AND source_type = 'POS_ORDER' AND source_id = $2",
      [propAId, String(posOrderId)]
    );
    assert.equal(Number(posTxCount.rows[0].cnt), 1, 'Payment / status update must NOT create duplicate transaction');

    // ──────────────────────────────────────────────────────────────────────────
    // TEST E: Idempotency (same POS source processed multiple times -> 1 transaction)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('Test E: Idempotency of projectPosOrderToTransaction');
    const idempTx1 = await projectPosOrderToTransaction(pool, posOrderId, { propertyId: propAId });
    const idempTx2 = await projectPosOrderToTransaction(pool, posOrderId, { propertyId: propAId });
    assert.equal(idempTx1.id, posTx.id, 'Idempotent projection must return the existing transaction ID');
    assert.equal(idempTx2.id, posTx.id, 'Idempotent projection second call must return the existing transaction ID');

    // ──────────────────────────────────────────────────────────────────────────
    // TEST F: POS Void -> Reversal generated, Net becomes 0
    // ──────────────────────────────────────────────────────────────────────────
    console.log('Test F: POS Void -> Reversal generated, Net becomes 0');
    // Create another POS order to test voiding
    const createVoidOrderRes = await fetch(`${baseUrl}/api/pos/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        property_id: propAId,
        table_number: 'Meja 10',
        guest_name: 'Tamu Void Test',
        status: 'PAID',
        items: [{ menu_item_id: menu2Id, quantity: 2 }] // 2x 25,000 = 50,000 IDR
      })
    });
    const voidOrderData = await createVoidOrderRes.json();
    const voidOrderId = Number(voidOrderData.data.id);
    tracked.posOrders.push(voidOrderId);

    // Void the order
    const patchVoidRes = await fetch(`${baseUrl}/api/pos/orders/${voidOrderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        property_id: propAId,
        status: 'VOIDED',
        reason: 'Pesanan salah input meja'
      })
    });
    assert.equal(patchVoidRes.status, 200, 'Voiding POS order should succeed');

    const voidedTxs = await pool.query(
      "SELECT * FROM transactions WHERE property_id = $1 AND source_type = 'POS_ORDER' AND source_id = $2 ORDER BY id ASC",
      [propAId, String(voidOrderId)]
    );
    assert.equal(voidedTxs.rowCount, 2, 'Should have 2 transaction records: Original + Reversal');
    const [origVoidTx, revVoidTx] = voidedTxs.rows;
    assert.equal(origVoidTx.transaction_status, 'VOIDED', 'Original transaction status must be VOIDED');
    assert.equal(revVoidTx.transaction_status, 'REVERSED', 'Reversal transaction status must be REVERSED');
    assert.equal(Number(revVoidTx.net_amount), -50000, 'Reversal net amount must be -50,000 IDR');
    assert.equal(Number(origVoidTx.net_amount) + Number(revVoidTx.net_amount), 0, 'Net total of original + reversal must equal 0');
    tracked.transactions.push(origVoidTx.id, revVoidTx.id);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST G: Room + POS combined sales summary correct
    // ──────────────────────────────────────────────────────────────────────────
    console.log('Test G: Room + POS combined sales summary correct');
    // Property A has:
    // 1. Room Charge: 1,500,000 IDR (POSTED)
    // 2. POS Order #1: 115,000 IDR (POSTED)
    // 3. POS Order #2 (Voided): 50,000 IDR (VOIDED) + -50,000 IDR (REVERSED) = 0
    // Total Net Sales for Property A must be: 1,500,000 + 115,000 = 1,615,000 IDR
    const txsResA = await getTransactions(pool, { property_id: propAId });
    const summaryA = txsResA.summary;
    assert.equal(Number(summaryA.total_sale), 1615000, 'Total sales in summary must be 1,615,000 IDR');

    const salesListA = await getTransactions(pool, { property_id: propAId, transaction_type: 'SALE' });
    const activePostedSales = salesListA.transactions.filter((t) => t.transaction_status === 'POSTED');
    assert.equal(activePostedSales.length, 2, 'Must have exactly 2 active POSTED sales (1 Room, 1 POS)');

    // ──────────────────────────────────────────────────────────────────────────
    // TEST H: Property isolation
    // ──────────────────────────────────────────────────────────────────────────
    console.log('Test H: Property isolation');
    const txsResB = await getTransactions(pool, { property_id: propBId });
    const summaryB = txsResB.summary;
    assert.equal(Number(summaryB.total_sale), 0, 'Property B must have 0 sales');

    const salesListB = await getTransactions(pool, { property_id: propBId });
    assert.equal(salesListB.transactions.length, 0, 'Property B must have 0 transactions');

    // Attempting cross-property POS projection throws 403
    await assert.rejects(
      async () => {
        await projectPosOrderToTransaction(pool, posOrderId, { propertyId: propBId });
      },
      /bukan milik properti/,
      'Cross-property POS order projection must be rejected with 403'
    );

    // ──────────────────────────────────────────────────────────────────────────
    // TEST I: Manual POS / Room sales category rejected (allowManual: false)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('Test I: Manual POS / Room sales category rejected');
    await assert.rejects(
      async () => {
        await createManualTransaction(pool, {
          property_id: propAId,
          transaction_type: 'SALE',
          category_code: 'FNB_SALES',
          amount: 50000,
          description: 'Penjualan POS Manual Palsu'
        });
      },
      /merupakan transaksi operasional otomatis dan tidak dapat dicatat manual/,
      'Manual FNB_SALES creation must be blocked'
    );

    await assert.rejects(
      async () => {
        await createManualTransaction(pool, {
          property_id: propAId,
          transaction_type: 'SALE',
          category_code: 'ROOM_SALES',
          amount: 500000,
          description: 'Penjualan Kamar Manual Palsu'
        });
      },
      /merupakan transaksi operasional otomatis dan tidak dapat dicatat manual/,
      'Manual ROOM_SALES creation must be blocked'
    );

    // ──────────────────────────────────────────────────────────────────────────
    // TEST J: BIGINT IDR preserved
    // ──────────────────────────────────────────────────────────────────────────
    console.log('Test J: BIGINT IDR preserved');
    const largePosRes = await fetch(`${baseUrl}/api/pos/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        property_id: propAId,
        table_number: 'VIP Ballroom',
        guest_name: 'Event Mega Banquet',
        status: 'PAID',
        items: [{ menu_item_id: menu1Id, quantity: 1000 }] // 1,000 * 45,000 = 45,000,000 IDR
      })
    });
    const largePosData = await largePosRes.json();
    const largeOrderId = Number(largePosData.data.id);
    tracked.posOrders.push(largeOrderId);

    const largeTxRes = await pool.query(
      "SELECT * FROM transactions WHERE property_id = $1 AND source_type = 'POS_ORDER' AND source_id = $2",
      [propAId, String(largeOrderId)]
    );
    assert.equal(largeTxRes.rowCount, 1, 'Large POS transaction must be created');
    assert.equal(Number(largeTxRes.rows[0].net_amount), 45000000, 'Net amount must be exactly 45,000,000 IDR with integer precision');
    tracked.transactions.push(largeTxRes.rows[0].id);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST K: Historical Reconciliation includes POS Orders
    // ──────────────────────────────────────────────────────────────────────────
    console.log('Test K: Historical Reconciliation includes POS Orders');
    const reconDry = await reconcileHistoricalTransactions(pool, propAId, true);
    assert.ok(reconDry.total_folio_charges > 0, 'Reconciliation dry-run should find historical charges and POS orders');
    assert.ok(reconDry.already_projected >= 3, 'Reconciliation dry-run should recognize already projected records');

    console.log('\n>>> ALL 11 TESTS (A through K) PASSED SUCCESSFULLY! <<<\n');
  } catch (err) {
    console.error('Test Suite Failed:', err);
    throw err;
  } finally {
    // Deterministic Cleanup
    console.log('Cleaning up test fixtures...');
    try {
      if (tracked.transactions.length > 0) {
        await pool.query('DELETE FROM transactions WHERE id = ANY($1)', [tracked.transactions]);
      }
      if (tracked.posOrders.length > 0) {
        await pool.query('DELETE FROM pos_order_items WHERE order_id = ANY($1)', [tracked.posOrders]);
        await pool.query('DELETE FROM pos_orders WHERE id = ANY($1)', [tracked.posOrders]);
      }
      if (tracked.menuItems.length > 0) {
        await pool.query('DELETE FROM pos_menu_items WHERE id = ANY($1)', [tracked.menuItems]);
      }
      if (tracked.categories.length > 0) {
        await pool.query('DELETE FROM pos_menu_categories WHERE id = ANY($1)', [tracked.categories]);
      }
      if (tracked.folioEntries.length > 0) {
        await pool.query('DELETE FROM folio_entries WHERE id = ANY($1)', [tracked.folioEntries]);
      }
      if (tracked.reservations.length > 0) {
        await pool.query('DELETE FROM reservations WHERE id = ANY($1)', [tracked.reservations]);
      }
      if (tracked.bookings.length > 0) {
        await pool.query('DELETE FROM bookings WHERE id = ANY($1)', [tracked.bookings]);
      }
      if (tracked.properties.length > 0) {
        await pool.query('DELETE FROM transaction_attachments WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM transactions WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM transaction_daily_sequences WHERE property_id = ANY($1)', [tracked.properties]);
        await pool.query('DELETE FROM audit_logs WHERE property_id = ANY($1)', [tracked.properties]);
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
      console.error('Cleanup error:', cleanupErr);
    }
    server.close();
  }
}

runTests()
  .then(() => {
    console.log('Canonical POS Sales Projection Test: ALL PASS');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Canonical POS Sales Projection Test: FAILED', err);
    process.exit(1);
  });

import assert from 'node:assert/strict';
import http from 'node:http';
import pkg from '../dist/index.js';
import schemaPkg from '../dist/db/schema_v3.js';
import {
  projectFolioEntryToTransaction,
  createManualTransaction,
  voidTransaction,
  getTransactions,
  getTransactionById
} from '../dist/domains/transactions/transactionService.js';

const { app, pool } = pkg;
const { initializeDatabase } = schemaPkg;

async function runTests() {
  console.log('=== RUNNING TRANSACTION-2B ANKA LAYOUT & FILTER REGRESSION SUITE ===\n');

  await initializeDatabase(pool);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const cleanupIds = {
    transactions: [],
    folioEntries: [],
    reservations: [],
    bookings: [],
    properties: []
  };

  try {
    const propRes = await pool.query('SELECT id FROM properties ORDER BY id ASC LIMIT 1');
    const propertyId = Number(propRes.rows[0]?.id || 1);

    // Create a secondary property for isolation tests
    const prop2Res = await pool.query(
      `INSERT INTO properties (property_code, name, address, is_active)
       VALUES ($1, $2, 'Secondary Address', true) RETURNING id`,
      [`P${Math.floor(10000 + Math.random() * 90000)}`, 'Property 2 Isolasi']
    );
    const propertyId2 = Number(prop2Res.rows[0].id);
    cleanupIds.properties.push(propertyId2);

    const now = new Date();
    const formatIsoDate = (d) => {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    const todayStr = formatIsoDate(now);
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = formatIsoDate(yesterday);

    const firstDayThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastDayThisMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const thisMonthStart = formatIsoDate(firstDayThisMonth);
    const thisMonthEnd = formatIsoDate(lastDayThisMonth);

    const firstDayLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastDayLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    const lastMonthStart = formatIsoDate(firstDayLastMonth);
    const lastMonthEnd = formatIsoDate(lastDayLastMonth);

    const uniqueSuffix = Date.now();
    const testBID = `BID-ANKA-${uniqueSuffix}`;
    const guestName = `Tamu ANKA ${uniqueSuffix}`;

    // Setup Test Booking & Reservation
    const bRes = await pool.query(
      `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status)
       VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
      [testBID, propertyId, guestName]
    );
    const bookingId = Number(bRes.rows[0].id);
    cleanupIds.bookings.push(bookingId);

    const rRes = await pool.query(
      `INSERT INTO reservations (booking_id, booking_number, stay_sequence, guest_name, total_price, amount_paid, remaining_balance, payment_status, status, check_in, check_out, stay_type)
       VALUES ($1, $2, 1, $3, 2000000, 0, 2000000, 'UNPAID', 'BOOKED', '2026-09-01', '2026-09-03', 'OVERNIGHT') RETURNING id`,
      [bookingId, `RES-ANKA-${uniqueSuffix}`, guestName]
    );
    const resId = Number(rRes.rows[0].id);
    cleanupIds.reservations.push(resId);

    // 1. Setup Transactions across different dates & statuses for testing
    // Tx A: Today SALE (POSTED, PAID -> SELESAI)
    const txToday = await createManualTransaction(pool, {
      property_id: propertyId,
      transaction_type: 'SALE',
      category_code: 'OTHER_SALES',
      department_code: 'FRONT_OFFICE',
      party_name: guestName,
      description: 'Penjualan Merchandise Hari Ini',
      amount: 500000,
      payment_method: 'CASH',
      actor_name: 'Tester',
      reservation_id: resId,
      booking_id: bookingId
    });
    cleanupIds.transactions.push(txToday.id);
    // Mark as PAID
    await pool.query('UPDATE transactions SET transaction_date = $1, payment_status = $2 WHERE id = $3', [todayStr, 'PAID', txToday.id]);

    // Tx B: Yesterday PURCHASE (POSTED, UNPAID -> PROSES)
    const txYesterday = await createManualTransaction(pool, {
      property_id: propertyId,
      transaction_type: 'PURCHASE',
      category_code: 'OPERATIONAL_SUPPLIES',
      department_code: 'HOUSEKEEPING',
      party_name: `Supplier Linen ${uniqueSuffix}`,
      description: 'Pembelian Linen Kemarin',
      amount: 750000,
      actor_name: 'Tester'
    });
    cleanupIds.transactions.push(txYesterday.id);
    await pool.query('UPDATE transactions SET transaction_date = $1, payment_status = $2 WHERE id = $3', [yesterdayStr, 'UNPAID', txYesterday.id]);

    // Tx C: Last Month EXPENSE (VOIDED -> BATAL)
    const txLastMonth = await createManualTransaction(pool, {
      property_id: propertyId,
      transaction_type: 'EXPENSE',
      category_code: 'UTILITIES',
      department_code: 'ENGINEERING',
      party_name: `PLN ${uniqueSuffix}`,
      description: 'Pengeluaran Listrik Bulan Lalu',
      amount: 1200000,
      actor_name: 'Tester'
    });
    cleanupIds.transactions.push(txLastMonth.id);
    await pool.query('UPDATE transactions SET transaction_date = $1, transaction_status = $2 WHERE id = $3', [lastMonthStart, 'VOIDED', txLastMonth.id]);

    // Tx D: Property 2 Transaction (Isolation test)
    const txProp2 = await createManualTransaction(pool, {
      property_id: propertyId2,
      transaction_type: 'SALE',
      category_code: 'OTHER_SALES',
      department_code: 'FRONT_OFFICE',
      party_name: `Tamu Hotel Lain ${uniqueSuffix}`,
      description: 'Penjualan di Properti Lain',
      amount: 900000,
      actor_name: 'Tester'
    });
    cleanupIds.transactions.push(txProp2.id);

    console.log('✓ Fixtures initialized successfully\n');

    // TEST 1: Hari Ini date filter
    console.log('Test 1: Level 2 - Hari Ini date filter');
    const resToday = await getTransactions(pool, {
      property_id: propertyId,
      start_date: todayStr,
      end_date: todayStr
    });
    assert.ok(resToday.transactions.some((t) => t.id === txToday.id), 'Hari Ini must include today transaction');
    assert.ok(!resToday.transactions.some((t) => t.id === txYesterday.id), 'Hari Ini must not include yesterday transaction');
    console.log('  PASS: Hari Ini returns strictly today transactions');

    // TEST 2: Kemarin date filter
    console.log('Test 2: Level 2 - Kemarin date filter');
    const resYesterday = await getTransactions(pool, {
      property_id: propertyId,
      start_date: yesterdayStr,
      end_date: yesterdayStr
    });
    assert.ok(resYesterday.transactions.some((t) => t.id === txYesterday.id), 'Kemarin must include yesterday transaction');
    assert.ok(!resYesterday.transactions.some((t) => t.id === txToday.id), 'Kemarin must not include today transaction');
    console.log('  PASS: Kemarin returns strictly yesterday transactions');

    // TEST 3: Bulan Ini date filter
    console.log('Test 3: Level 2 - Bulan Ini date filter');
    const resThisMonth = await getTransactions(pool, {
      property_id: propertyId,
      start_date: thisMonthStart,
      end_date: thisMonthEnd
    });
    assert.ok(resThisMonth.transactions.some((t) => t.id === txToday.id), 'Bulan Ini must include today transaction');
    assert.ok(!resThisMonth.transactions.some((t) => t.id === txLastMonth.id), 'Bulan Ini must not include last month transaction');
    console.log('  PASS: Bulan Ini returns strictly this month transactions');

    // TEST 4: Bulan Lalu date filter
    console.log('Test 4: Level 2 - Bulan Lalu date filter');
    const resLastMonth = await getTransactions(pool, {
      property_id: propertyId,
      start_date: lastMonthStart,
      end_date: lastMonthEnd
    });
    assert.ok(resLastMonth.transactions.some((t) => t.id === txLastMonth.id), 'Bulan Lalu must include last month transaction');
    assert.ok(!resLastMonth.transactions.some((t) => t.id === txToday.id), 'Bulan Lalu must not include today transaction');
    console.log('  PASS: Bulan Lalu returns strictly last month transactions');

    // TEST 5: All Time pagination
    console.log('Test 5: Level 2 - All Time pagination with limit/offset');
    const resAllTimePage1 = await getTransactions(pool, {
      property_id: propertyId,
      limit: 2,
      offset: 0
    });
    assert.equal(resAllTimePage1.limit, 2, 'Limit must be 2');
    assert.ok(resAllTimePage1.total_count >= 3, 'Total count must reflect all rows');
    assert.equal(resAllTimePage1.transactions.length, 2, 'Page 1 must return 2 rows');
    console.log('  PASS: All Time paginates properly with total count');

    // TEST 6: BID search
    console.log('Test 6: Level 3 - BID search');
    const resBidSearch = await getTransactions(pool, {
      property_id: propertyId,
      search: testBID
    });
    assert.ok(resBidSearch.transactions.some((t) => t.id === txToday.id), 'BID search must find transaction linked to booking');
    console.log('  PASS: BID search returns linked transactions');

    // TEST 7: Transaction number search
    console.log('Test 7: Level 3 - Transaction number search');
    const resTxNoSearch = await getTransactions(pool, {
      property_id: propertyId,
      search: txYesterday.transaction_no
    });
    assert.equal(resTxNoSearch.transactions.length, 1, 'Transaction number search must return exactly 1 transaction');
    assert.equal(resTxNoSearch.transactions[0].id, txYesterday.id);
    console.log('  PASS: Transaction number search returns exact match');

    // TEST 8: Guest name search
    console.log('Test 8: Level 3 - Guest name search');
    const resGuestSearch = await getTransactions(pool, {
      property_id: propertyId,
      search: guestName
    });
    assert.ok(resGuestSearch.transactions.some((t) => t.id === txToday.id), 'Guest name search must find transaction');
    console.log('  PASS: Guest name search returns matching transactions');

    // TEST 9: Operational status - PROSES mapping
    console.log('Test 9: Level 4 - PROSES operational status mapping');
    const resProses = await getTransactions(pool, {
      property_id: propertyId,
      operational_status: 'PROSES'
    });
    assert.ok(resProses.transactions.some((t) => t.id === txYesterday.id), 'UNPAID transaction must be in PROSES');
    assert.ok(!resProses.transactions.some((t) => t.id === txToday.id), 'PAID transaction must not be in PROSES');
    assert.ok(!resProses.transactions.some((t) => t.id === txLastMonth.id), 'VOIDED transaction must not be in PROSES');
    console.log('  PASS: PROSES status returns pending/unpaid transactions');

    // TEST 10: Operational status - SELESAI mapping
    console.log('Test 10: Level 4 - SELESAI operational status mapping');
    const resSelesai = await getTransactions(pool, {
      property_id: propertyId,
      operational_status: 'SELESAI'
    });
    assert.ok(resSelesai.transactions.some((t) => t.id === txToday.id), 'PAID transaction must be in SELESAI');
    assert.ok(!resSelesai.transactions.some((t) => t.id === txYesterday.id), 'UNPAID transaction must not be in SELESAI');
    assert.ok(!resSelesai.transactions.some((t) => t.id === txLastMonth.id), 'VOIDED transaction must not be in SELESAI');
    console.log('  PASS: SELESAI status returns completed/paid transactions');

    // TEST 11: Operational status - BATAL mapping
    console.log('Test 11: Level 4 - BATAL operational status mapping');
    const resBatal = await getTransactions(pool, {
      property_id: propertyId,
      operational_status: 'BATAL'
    });
    assert.ok(resBatal.transactions.some((t) => t.id === txLastMonth.id), 'VOIDED transaction must be in BATAL');
    assert.ok(!resBatal.transactions.some((t) => t.id === txToday.id), 'PAID transaction must not be in BATAL');
    assert.ok(!resBatal.transactions.some((t) => t.id === txYesterday.id), 'UNPAID transaction must not be in BATAL');
    console.log('  PASS: BATAL status returns voided/cancelled transactions');

    // TEST 12: Combined filter (Type + Period + BID + Status)
    console.log('Test 12: Combined filter (SALE + Hari Ini + BID + SELESAI)');
    const resCombined = await getTransactions(pool, {
      property_id: propertyId,
      transaction_type: 'SALE',
      start_date: todayStr,
      end_date: todayStr,
      search: testBID,
      operational_status: 'SELESAI'
    });
    assert.equal(resCombined.transactions.length, 1, 'Combined filter should return exactly 1 matching transaction');
    assert.equal(resCombined.transactions[0].id, txToday.id);
    console.log('  PASS: Combined filter operates seamlessly');

    // TEST 13: Property isolation
    console.log('Test 13: Property isolation');
    const resProp1 = await getTransactions(pool, { property_id: propertyId });
    const resProp2 = await getTransactions(pool, { property_id: propertyId2 });
    assert.ok(!resProp1.transactions.some((t) => t.id === txProp2.id), 'Property 1 must not see Property 2 transactions');
    assert.ok(!resProp2.transactions.some((t) => t.id === txToday.id), 'Property 2 must not see Property 1 transactions');
    console.log('  PASS: Property isolation strictly preserved');

    // TEST 14: HTTP endpoint API query verification
    console.log('Test 14: HTTP endpoint query parsing & response');
    const httpRes = await fetch(`${baseUrl}/api/transactions?property_id=${propertyId}&operational_status=SELESAI&search=${encodeURIComponent(testBID)}`);
    const httpJson = await httpRes.json();
    assert.equal(httpRes.status, 200);
    assert.ok(httpJson.success);
    assert.ok(httpJson.data.transactions.length >= 1);
    assert.equal(httpJson.data.transactions[0].id, txToday.id);
    console.log('  PASS: HTTP API endpoint serves filtered transactions accurately');

    // TEST 15: Room sales projection is singular
    console.log('Test 15: Single room sales projection');
    const feRes = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, description, amount, direction)
       VALUES ($1, $2, 'ROOM_CHARGE', 'ROOM_CHARGE', 'Kamar Deluxe 1 Malam', 600000, 'DEBIT') RETURNING id`,
      [resId, propertyId]
    );
    const feId = Number(feRes.rows[0].id);
    cleanupIds.folioEntries.push(feId);

    const proj1 = await projectFolioEntryToTransaction(pool, feId, { propertyId });
    cleanupIds.transactions.push(proj1.id);
    const proj2 = await projectFolioEntryToTransaction(pool, feId, { propertyId });
    assert.equal(proj1.id, proj2.id, 'Projecting twice must return identical transaction ID');
    console.log('  PASS: Single room sales projection preserved');

    // TEST 16: POS sales projection single projection
    console.log('Test 16: POS sales projection single projection');
    const fePosRes = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, description, amount, direction)
       VALUES ($1, $2, 'POS_ORDER', 'POS_ORDER', 'Room Service Nasi Goreng', 85000, 'DEBIT') RETURNING id`,
      [resId, propertyId]
    );
    const fePosId = Number(fePosRes.rows[0].id);
    cleanupIds.folioEntries.push(fePosId);

    const projPos1 = await projectFolioEntryToTransaction(pool, fePosId, { propertyId });
    cleanupIds.transactions.push(projPos1.id);
    const projPos2 = await projectFolioEntryToTransaction(pool, fePosId, { propertyId });
    assert.equal(projPos1.id, projPos2.id, 'POS projection must be idempotent');
    assert.equal(projPos1.category_code, 'FNB_SALES');
    console.log('  PASS: POS sales projection is singular');

    // TEST 17: Payment does not duplicate sales
    console.log('Test 17: Payment does not produce sales');
    const fePayRes = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, description, amount, direction)
       VALUES ($1, $2, 'PAYMENT', 'FOLIO_PAYMENT', 'Pembayaran QRIS', 685000, 'CREDIT') RETURNING id`,
      [resId, propertyId]
    );
    const fePayId = Number(fePayRes.rows[0].id);
    cleanupIds.folioEntries.push(fePayId);

    const projPay = await projectFolioEntryToTransaction(pool, fePayId, { propertyId });
    assert.equal(projPay, null, 'Folio payment must NOT project as SALE transaction');
    console.log('  PASS: Payment does not duplicate sales');

    // TEST 18: Reversal aggregation unchanged
    console.log('Test 18: Reversal aggregation excluded from net positive sales in summaryQuery');
    const voidedTx = await voidTransaction(pool, propertyId, projPos1.id, {
      reason: 'Void item test',
      actorName: 'Tester'
    });
    cleanupIds.transactions.push(voidedTx.reversal.id);

    const summaryAfterVoid = await getTransactions(pool, {
      property_id: propertyId,
      search: testBID
    });
    // Total sale for this BID should only be txToday (500,000) + proj1 (600,000) = 1,100,000 (POS is voided/reversed)
    assert.equal(Number(summaryAfterVoid.summary.total_sale), 1100000, 'Reversal/void must not inflate or corrupt total sale summary');
    console.log('  PASS: Reversal aggregation invariants intact');

    console.log('\n==================================================');
    console.log('ALL 18 ANKA LAYOUT & FILTER REGRESSION TESTS PASSED!');
    console.log('==================================================\n');
  } finally {
    console.log('Cleaning up fixtures...');
    for (const txId of cleanupIds.transactions) {
      await pool.query('DELETE FROM transactions WHERE id = $1', [txId]).catch(() => {});
    }
    for (const feId of cleanupIds.folioEntries) {
      await pool.query('DELETE FROM folio_entries WHERE id = $1', [feId]).catch(() => {});
    }
    for (const resId of cleanupIds.reservations) {
      await pool.query('DELETE FROM reservations WHERE id = $1', [resId]).catch(() => {});
    }
    for (const bId of cleanupIds.bookings) {
      await pool.query('DELETE FROM bookings WHERE id = $1', [bId]).catch(() => {});
    }
    if (cleanupIds.properties.length > 0) {
      await pool.query('DELETE FROM transaction_attachments WHERE property_id = ANY($1)', [cleanupIds.properties]);
      await pool.query('DELETE FROM transactions WHERE property_id = ANY($1)', [cleanupIds.properties]);
      await pool.query('DELETE FROM transaction_daily_sequences WHERE property_id = ANY($1)', [cleanupIds.properties]);
      await pool.query('DELETE FROM audit_logs WHERE property_id = ANY($1)', [cleanupIds.properties]);
      await pool.query('DELETE FROM property_features WHERE property_id = ANY($1)', [cleanupIds.properties]);
      await pool.query('DELETE FROM property_brandings WHERE property_id = ANY($1)', [cleanupIds.properties]);
      await pool.query('DELETE FROM property_pricing_settings WHERE property_id = ANY($1)', [cleanupIds.properties]);
      await pool.query('DELETE FROM property_housekeeping_settings WHERE property_id = ANY($1)', [cleanupIds.properties]);
      await pool.query('DELETE FROM property_attendance_settings WHERE property_id = ANY($1)', [cleanupIds.properties]);
      await pool.query('DELETE FROM property_quick_booking_rules WHERE property_id = ANY($1)', [cleanupIds.properties]);
      await pool.query('DELETE FROM property_day_use_durations WHERE property_id = ANY($1)', [cleanupIds.properties]);
      await pool.query('DELETE FROM rate_plans WHERE property_id = ANY($1)', [cleanupIds.properties]);
      await pool.query('DELETE FROM meal_plans WHERE property_id = ANY($1)', [cleanupIds.properties]);
      await pool.query('DELETE FROM properties WHERE id = ANY($1)', [cleanupIds.properties]);
    }
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
}

runTests().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});

import assert from 'node:assert/strict';
import http from 'node:http';
import pkg from '../dist/index.js';
import schemaPkg from '../dist/db/schema_v3.js';
import { projectFolioEntryToTransaction, createManualTransaction, voidTransaction, getTransactions, getTransactionById } from '../dist/domains/transactions/transactionService.js';

const { app, pool } = pkg;
const { initializeDatabase } = schemaPkg;

async function runTests() {
  console.log('=== RUNNING CANONICAL TRANSACTIONS INTEGRATION SUITE ===');

  await initializeDatabase(pool);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const cleanupIds = {
    transactions: [],
    folioEntries: [],
    reservations: [],
    bookings: []
  };

  try {
    const propRes = await pool.query('SELECT id FROM properties ORDER BY id ASC LIMIT 1');
    const propertyId = Number(propRes.rows[0]?.id || 1);

    // 1. Setup Test Booking & Reservation fixture
    const uniqueSuffix = Date.now();
    const guestName = `Test Guest TRX ${uniqueSuffix}`;
    const bRes = await pool.query(
      `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status)
       VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
      [`BID-TRX-${uniqueSuffix}`, propertyId, guestName]
    );
    const bookingId = Number(bRes.rows[0].id);
    cleanupIds.bookings.push(bookingId);

    const rRes = await pool.query(
      `INSERT INTO reservations (booking_id, booking_number, stay_sequence, guest_name, total_price, amount_paid, remaining_balance, payment_status, status, check_in, check_out, stay_type)
       VALUES ($1, $2, 1, $3, 1500000, 0, 1500000, 'UNPAID', 'BOOKED', '2026-09-01', '2026-09-03', 'OVERNIGHT') RETURNING id`,
      [bookingId, `RES-TRX-${uniqueSuffix}`, guestName]
    );
    const resId = Number(rRes.rows[0].id);
    cleanupIds.reservations.push(resId);

    // TEST 1: Project ROOM_CHARGE -> SALE
    console.log('Test 1: Project ROOM_CHARGE -> SALE');
    const fe1Res = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, description, amount, direction)
       VALUES ($1, $2, 'ROOM_CHARGE', 'ROOM_CHARGE', 'Kamar Deluxe King (2 Malam)', 1000000, 'DEBIT') RETURNING id`,
      [resId, propertyId]
    );
    const fe1Id = Number(fe1Res.rows[0].id);
    cleanupIds.folioEntries.push(fe1Id);

    const tx1 = await projectFolioEntryToTransaction(pool, fe1Id, { propertyId });
    assert.ok(tx1, 'Transaction 1 should be created');
    assert.equal(tx1.transaction_type, 'SALE', 'Room charge must be SALE');
    assert.equal(tx1.category_code, 'ROOM_SALES', 'Category must be ROOM_SALES');
    assert.equal(Number(tx1.net_amount), 1000000, 'Net amount must match 1,000,000 IDR');
    assert.match(tx1.transaction_no, /^TRX-\d{6}-\d{5}$/, 'Transaction number must match TRX-YYMMDD-XXXXX');
    cleanupIds.transactions.push(tx1.id);

    // TEST 2: Idempotency (Projecting the exact same folio entry again returns same row, no duplicate)
    console.log('Test 2: Idempotency of projection');
    const tx1Again = await projectFolioEntryToTransaction(pool, fe1Id, { propertyId });
    assert.equal(tx1Again.id, tx1.id, 'Idempotent projection must return identical transaction ID');
    
    const countCheck = await pool.query('SELECT COUNT(*) as cnt FROM transactions WHERE source_id = $1 AND property_id = $2', [String(fe1Id), propertyId]);
    assert.equal(Number(countCheck.rows[0].cnt), 1, 'Exactly one transaction row must exist for this folio entry');

    // TEST 3: Project STAY CHARGE (EXTRA_BED) -> SALE
    console.log('Test 3: Project EXTRA_BED -> SALE');
    const fe2Res = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, description, amount, direction, unit_price, quantity)
       VALUES ($1, $2, 'EXTRA_BED', 'EXTRA_BED', 'Extra Bed (1 Unit)', 150000, 'DEBIT', 150000, 1) RETURNING id`,
      [resId, propertyId]
    );
    const fe2Id = Number(fe2Res.rows[0].id);
    cleanupIds.folioEntries.push(fe2Id);

    const tx2 = await projectFolioEntryToTransaction(pool, fe2Id, { propertyId });
    assert.ok(tx2, 'Transaction 2 should be created');
    assert.equal(tx2.transaction_type, 'SALE', 'Extra bed must be SALE');
    assert.equal(tx2.category_code, 'EXTRA_BED_SALES', 'Category must be EXTRA_BED_SALES');
    assert.equal(Number(tx2.net_amount), 150000, 'Net amount must be 150,000 IDR');
    cleanupIds.transactions.push(tx2.id);

    // TEST 4: Project PENALTY -> INCOME (Pemasukan) (Never SALE)
    console.log('Test 4: Project PENALTY -> INCOME (Pemasukan)');
    const fe3Res = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, source_type, description, amount, direction, revenue_category)
       VALUES ($1, $2, 'PENALTY', 'PENALTY', 'Denda Rokok di Kamar Non-Smoking', 350000, 'DEBIT', 'OTHER_INCOME') RETURNING id`,
      [resId, propertyId]
    );
    const fe3Id = Number(fe3Res.rows[0].id);
    cleanupIds.folioEntries.push(fe3Id);

    const tx3 = await projectFolioEntryToTransaction(pool, fe3Id, { propertyId });
    assert.ok(tx3, 'Transaction 3 should be created');
    assert.equal(tx3.transaction_type, 'INCOME', 'PENALTY must be mapped to INCOME (Pemasukan)');
    assert.equal(tx3.category_code, 'PENALTY_INCOME', 'Category must be PENALTY_INCOME');
    assert.equal(Number(tx3.net_amount), 350000, 'Net amount must be 350,000 IDR');
    cleanupIds.transactions.push(tx3.id);

    // TEST 5: Payment Ledger Check (No Double Counting)
    console.log('Test 5: Payment is settlement, not a sale/income transaction');
    const fe4Res = await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, description, amount, direction)
       VALUES ($1, $2, 'PAYMENT', 'Pembayaran Transfer BCA', 1500000, 'CREDIT') RETURNING id`,
      [resId, propertyId]
    );
    const fe4Id = Number(fe4Res.rows[0].id);
    cleanupIds.folioEntries.push(fe4Id);

    const tx4 = await projectFolioEntryToTransaction(pool, fe4Id, { propertyId });
    assert.equal(tx4, null, 'Payment entry in folio must NOT create a transaction row (no double counting)');

    // TEST 6: Void Folio Charge creates Compensating Reversal Transaction
    console.log('Test 6: Void Folio Charge creates Compensating Reversal');
    const feRevRes = await pool.query(
      `INSERT INTO folio_entries (
        reservation_id, property_id, entry_type, source_type, source_id,
        description, amount, direction, reversal_of_entry_id, status
       ) VALUES (
        $1, $2, 'REVERSAL', 'EXTRA_BED', $3,
        'Pembatalan: Extra Bed (1 Unit)', 150000, 'CREDIT', $4, 'REVERSED'
       ) RETURNING id`,
      [resId, propertyId, String(fe2Id), fe2Id]
    );
    const feRevId = Number(feRevRes.rows[0].id);
    cleanupIds.folioEntries.push(feRevId);

    const txRev = await projectFolioEntryToTransaction(pool, feRevId, { propertyId });
    assert.ok(txRev, 'Reversal transaction must be created');
    assert.equal(txRev.transaction_status, 'REVERSED', 'Status must be REVERSED');
    assert.equal(Number(txRev.net_amount), -150000, 'Net amount must be negative (-150,000 IDR)');
    assert.equal(txRev.reversal_of_transaction_id, tx2.id, 'Must link to original transaction ID');
    cleanupIds.transactions.push(txRev.id);

    // Check original transaction updated
    const origCheck = await pool.query('SELECT transaction_status FROM transactions WHERE id = $1', [tx2.id]);
    assert.equal(origCheck.rows[0].transaction_status, 'REVERSED', 'Original transaction status must be REVERSED');

    // TEST 7: SALE 500,000 -> Void -> Net economic value 0
    console.log('Test 7: SALE 500000 -> void -> net economic value 0');
    const manualSale500k = await createManualTransaction(pool, {
      property_id: propertyId,
      transaction_type: 'SALE',
      category_code: 'OTHER_SALES',
      description: 'Penjualan Merchandise Mug Hotel',
      amount: 500000,
      payment_method: 'CASH',
      actor_name: 'Cashier Maya'
    });
    cleanupIds.transactions.push(manualSale500k.id);

    const voidRes500k = await voidTransaction(pool, propertyId, manualSale500k.id, {
      reason: 'Tamu membatalkan pembelian mug hotel',
      actorName: 'Manager Budi'
    });
    assert.equal(voidRes500k.original.transaction_status, 'VOIDED', 'Original must be marked VOIDED');
    assert.equal(voidRes500k.reversal.transaction_status, 'REVERSED', 'Reversal must be REVERSED');
    assert.equal(Number(voidRes500k.reversal.net_amount), -500000, 'Reversal amount must be -500,000 IDR');
    cleanupIds.transactions.push(voidRes500k.reversal.id);

    const sumAfterVoid = await getTransactions(pool, {
      property_id: propertyId,
      search: 'Mug Hotel'
    });
    assert.equal(sumAfterVoid.summary.total_sale, 0, 'Economic net of voided transaction (+500k -500k) must be exactly 0 IDR');

    // TEST 8: Replacement 600,000 after void -> Net 600,000
    console.log('Test 8: Original SALE 500000 + Reversal -500000 + Replacement 600000 -> net 600000');
    const replacementSale600k = await createManualTransaction(pool, {
      property_id: propertyId,
      transaction_type: 'SALE',
      category_code: 'OTHER_SALES',
      description: 'Penjualan Merchandise Mug Hotel Premium (Koreksi)',
      amount: 600000,
      payment_method: 'CASH',
      actor_name: 'Cashier Maya'
    });
    cleanupIds.transactions.push(replacementSale600k.id);

    const sumAfterReplacement = await getTransactions(pool, {
      property_id: propertyId,
      search: 'Mug Hotel'
    });
    assert.equal(
      sumAfterReplacement.summary.total_sale,
      600000,
      'Total net sale after replacement (+500k -500k +600k) must be exactly 600,000 IDR'
    );

    // TEST 9: Manual Operational Category Duplicate Rejection (Safety Gate)
    console.log('Test 9: Manual operational category duplicate rejection');
    let manualRoomSaleFailed = false;
    try {
      await createManualTransaction(pool, {
        property_id: propertyId,
        transaction_type: 'SALE',
        category_code: 'ROOM_SALES',
        description: 'Manual room charge bypass attempt',
        amount: 500000
      });
    } catch (e) {
      manualRoomSaleFailed = true;
    }
    assert.ok(manualRoomSaleFailed, 'Manual entry of auto-projected ROOM_SALES category must be rejected');

    let manualPenaltyFailed = false;
    try {
      await createManualTransaction(pool, {
        property_id: propertyId,
        transaction_type: 'INCOME',
        category_code: 'PENALTY_INCOME',
        description: 'Manual penalty bypass attempt',
        amount: 200000
      });
    } catch (e) {
      manualPenaltyFailed = true;
    }
    assert.ok(manualPenaltyFailed, 'Manual entry of auto-projected PENALTY_INCOME category must be rejected');

    // TEST 10: Manual Transactions (EXPENSE, PURCHASE) & Decimal Rejection (BIGINT IDR standard)
    console.log('Test 10: Manual Transactions & BIGINT IDR integer precision');
    const manualExpense = await createManualTransaction(pool, {
      property_id: propertyId,
      transaction_type: 'EXPENSE',
      category_code: 'PETTY_CASH',
      description: 'Beli air mineral galon dan kopi staf FO',
      amount: 75000,
      payment_method: 'CASH',
      actor_name: 'Receptionist Maya'
    });
    assert.equal(manualExpense.transaction_type, 'EXPENSE', 'Type must be EXPENSE');
    assert.equal(Number(manualExpense.net_amount), 75000, 'Amount must be 75,000 IDR');
    cleanupIds.transactions.push(manualExpense.id);

    const manualPurchase = await createManualTransaction(pool, {
      property_id: propertyId,
      transaction_type: 'PURCHASE',
      category_code: 'AMENITIES_PURCHASE',
      description: 'Pengadaan Dental Kit & Sabun Hotel (500 set)',
      amount: 2500000,
      payment_method: 'TRANSFER',
      actor_name: 'Purchasing Andi'
    });
    assert.equal(manualPurchase.transaction_type, 'PURCHASE', 'Type must be PURCHASE');
    assert.equal(Number(manualPurchase.net_amount), 2500000, 'Amount must be 2,500,000 IDR');
    cleanupIds.transactions.push(manualPurchase.id);

    // Decimal rejection test
    let decimalFailed = false;
    try {
      await createManualTransaction(pool, {
        property_id: propertyId,
        transaction_type: 'EXPENSE',
        category_code: 'PETTY_CASH',
        description: 'Uji desimal',
        amount: 75000.50
      });
    } catch (e) {
      decimalFailed = true;
    }
    assert.ok(decimalFailed, 'Decimal amounts must be strictly rejected by Integer IDR standard');

    // TEST 11: Cross-Property Isolation (Projection and Query)
    console.log('Test 11: Cross-property projection and query rejection');
    let crossPropProjFailed = false;
    try {
      await projectFolioEntryToTransaction(pool, fe1Id, { propertyId: 99999 });
    } catch (e) {
      crossPropProjFailed = true;
    }
    assert.ok(crossPropProjFailed, 'Cross-property folio projection must be strictly rejected');

    const wrongPropRes = await fetch(`${baseUrl}/api/transactions/${tx1.id}?property_id=99999`);
    assert.equal(wrongPropRes.status, 404, 'Mismatched property query must return 404');

    // TEST 12: REST API Query & Summary Calculation
    console.log('Test 12: REST API GET /api/transactions');
    const apiRes = await fetch(`${baseUrl}/api/transactions?property_id=${propertyId}&reservation_id=${resId}`);
    const apiJson = await apiRes.json();
    assert.equal(apiRes.status, 200, 'API response must be 200');
    assert.ok(apiJson.success, 'API success flag must be true');
    assert.ok(Array.isArray(apiJson.data.transactions), 'Transactions array must exist');

    // Net sale for this reservation: Room charge (1,000,000) + Extra bed (150,000) + Reversal (-150,000) = 1,000,000
    assert.equal(apiJson.data.summary.total_sale, 1000000, 'Summary total_sale must equal 1,000,000 IDR net');
    assert.equal(apiJson.data.summary.total_income, 350000, 'Summary total_income must equal 350,000 IDR (penalty)');

    // TEST 13: Summary aggregation is independent of pagination limit
    console.log('Test 13: Summary aggregation independent of pagination');
    const apiResLimit1 = await fetch(`${baseUrl}/api/transactions?property_id=${propertyId}&limit=1`);
    const apiJsonLimit1 = await apiResLimit1.json();
    assert.equal(apiResLimit1.status, 200);
    assert.equal(apiJsonLimit1.data.transactions.length, 1, 'Page length should be 1');
    assert.ok(
      apiJsonLimit1.data.summary.total_sale >= 1600000,
      'Summary total_sale must reflect full filtered dataset, not just the 1 row on the page'
    );

    // TEST 14: Manual Transaction with Party Name & Source Reference
    console.log('Test 14: Manual Transaction with party_name & source_reference');
    const manualExpenseParty = await createManualTransaction(pool, {
      property_id: propertyId,
      transaction_type: 'EXPENSE',
      category_code: 'PETTY_CASH',
      description: 'Beli kertas HVS & pulpen resepsionis',
      party_name: 'Toko ATK Berkah Mandiri',
      source_reference: 'NOTA-ATK-88219',
      amount: 120000,
      payment_method: 'CASH',
      actor_name: 'Receptionist Budi'
    });
    assert.equal(manualExpenseParty.party_name, 'Toko ATK Berkah Mandiri', 'Party name must match input');
    assert.equal(manualExpenseParty.source_reference, 'NOTA-ATK-88219', 'Source reference must match input');
    cleanupIds.transactions.push(manualExpenseParty.id);

    // TEST 15: Search filtering by party_name
    console.log('Test 15: Search filtering by party_name');
    const searchPartyRes = await getTransactions(pool, {
      property_id: propertyId,
      search: 'Berkah Mandiri'
    });
    assert.ok(searchPartyRes.transactions.length >= 1, 'Search by party_name should find the transaction');
    assert.equal(searchPartyRes.transactions[0].party_name, 'Toko ATK Berkah Mandiri');

    // TEST 16: Transaction Attachment Creation, Fetching & Deletion
    console.log('Test 16: Attachment upload & delete lifecycle');
    // Direct service call for attachment
    const { addTransactionAttachment, deleteTransactionAttachment } = await import('../dist/domains/transactions/transactionService.js');
    const attCreated = await addTransactionAttachment(pool, propertyId, manualExpenseParty.id, {
      fileName: 'tx-att-test-file.jpg',
      originalName: 'nota_pembelian.jpg',
      mimeType: 'image/jpeg',
      fileSize: 45000,
      storagePath: '/uploads/transactions/tx-att-test-file.jpg',
      uploadedBy: 'Receptionist Budi'
    });
    assert.ok(attCreated.id, 'Attachment ID should be generated');
    assert.equal(attCreated.original_name, 'nota_pembelian.jpg');

    // Fetch transaction by ID to verify attachment is included
    const fetchedTx = await getTransactionById(pool, propertyId, manualExpenseParty.id);
    assert.ok(fetchedTx, 'Transaction should exist');
    assert.ok(Array.isArray(fetchedTx.attachments), 'Attachments array should exist');
    assert.equal(fetchedTx.attachments.length, 1, 'Should have 1 attachment');
    assert.equal(fetchedTx.attachments[0].id, attCreated.id);

    // Delete attachment
    const delRes = await deleteTransactionAttachment(pool, propertyId, manualExpenseParty.id, attCreated.id, 'Receptionist Budi');
    assert.equal(delRes.success, true, 'Attachment should be deleted successfully');

    const fetchedTxAfterDel = await getTransactionById(pool, propertyId, manualExpenseParty.id);
    assert.equal(fetchedTxAfterDel.attachments.length, 0, 'Attachments should now be empty');

    console.log('ALL CANONICAL TRANSACTION TESTS PASSED SUCCESSFULLY!');
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
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
}

runTests().catch((e) => {
  console.error('FATAL TEST ERROR:', e);
  process.exit(1);
});

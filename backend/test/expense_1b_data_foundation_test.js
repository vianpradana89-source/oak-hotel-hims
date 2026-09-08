import assert from 'node:assert/strict';
import http from 'node:http';
import pkg from '../dist/index.js';
import schemaPkg from '../dist/db/schema_v3.js';
import {
  createExpenseTransaction,
  verifyTransaction,
  voidTransaction,
  softDeleteTransaction,
  getTransactionById,
  getTransactions
} from '../dist/domains/transactions/transactionService.js';
import {
  createSupplier
} from '../dist/domains/suppliers/supplierService.js';
import {
  createPurchaseTransaction
} from '../dist/domains/transactions/transactionService.js';

const { app, pool } = pkg;
const { initializeDatabase } = schemaPkg;

async function runTests() {
  console.log('=== RUNNING EXPENSE-1B DATA FOUNDATION TEST SUITE ===\n');

  await initializeDatabase(pool);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const randNum = Math.floor(1000 + Math.random() * 8999);
  const propCode = `XB${randNum}`;

  const tracked = {
    properties: [],
    suppliers: [],
    transactions: []
  };

  let assertions = 0;
  const check = (condition, message) => {
    assert.ok(condition, message);
    assertions += 1;
  };

  try {
    // Setup isolated test property
    const propRes = await pool.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('EXP1B Test Property', $1, 'Asia/Jakarta', 'IDR', 'Jl. Expense 1B No. 1', TRUE) RETURNING id",
      [propCode]
    );
    const propertyId = Number(propRes.rows[0].id);
    tracked.properties.push(propertyId);
    console.log(`[SETUP] Test property created (ID: ${propertyId}, Code: ${propCode})\n`);

    // Create a supplier to verify EXPENSE does NOT source bank from it
    const supplier = await createSupplier(pool, {
      property_id: propertyId,
      name: `Supplier ${randNum}`,
      bank_name: 'Bank Supplier Master',
      bank_account: '1234567890',
      bank_holder: 'Supplier Name',
      actor_name: 'Admin'
    });
    tracked.suppliers.push(Number(supplier.id));

    // =====================================================================
    // SCENARIO 1: Create EXPENSE with all 3 recipient bank snapshot fields
    // =====================================================================
    console.log('--- Scenario 1: Create EXPENSE with recipient bank snapshots ---');

    const expenseWithBank = await createExpenseTransaction(pool, {
      property_id: propertyId,
      category_code: 'UTILITIES_EXPENSE',
      department_code: 'MAINTENANCE',
      party_name: 'PT Listrik Jaya',
      description: 'Pembayaran listrik bulan Agustus',
      amount: 2500000,
      payment_method: 'TRANSFER',
      source_reference: 'NOTA-LISTRIK-001',
      recipient_bank_name: 'Bank Mandiri',
      recipient_bank_account: '1370001234567',
      recipient_bank_holder: 'PT Listrik Jaya',
      actor_name: 'Staff Maintenance'
    });
    tracked.transactions.push(Number(expenseWithBank.id));

    check(expenseWithBank.recipient_bank_name === 'Bank Mandiri',
      '1a. recipient_bank_name saved correctly');
    check(expenseWithBank.recipient_bank_account === '1370001234567',
      '1b. recipient_bank_account saved correctly');
    check(expenseWithBank.recipient_bank_holder === 'PT Listrik Jaya',
      '1c. recipient_bank_holder saved correctly');
    check(expenseWithBank.party_name === 'PT Listrik Jaya',
      '1d. party_name saved correctly');
    check(expenseWithBank.transaction_status === 'POSTED',
      '1e. transaction_status is POSTED');
    check(expenseWithBank.expense_workflow_status === 'PROSES',
      '1f. expense_workflow_status is PROSES (default)');

    console.log(`  [PASS] ${assertions - 5}/15 assertions passed so far\n`);

    // =====================================================================
    // SCENARIO 2: Read/detail returns exact snapshots
    // =====================================================================
    console.log('--- Scenario 2: Read/detail returns exact snapshots ---');

    const detail = await getTransactionById(pool, propertyId, expenseWithBank.id);
    check(detail.recipient_bank_name === 'Bank Mandiri',
      '2a. Detail read returns recipient_bank_name');
    check(detail.recipient_bank_account === '1370001234567',
      '2b. Detail read returns recipient_bank_account');
    check(detail.recipient_bank_holder === 'PT Listrik Jaya',
      '2c. Detail read returns recipient_bank_holder');
    check(detail.expense_workflow_status === 'PROSES',
      '2d. Detail read returns expense_workflow_status');
    check(detail.operational_sheet === 'PROSES',
      '2e. operational_sheet derives as PROSES before verification');

    console.log(`  [PASS] Assertions ${assertions - 10 + 1}-${assertions} passed\n`);

    // =====================================================================
    // SCENARIO 3: Create EXPENSE with fields omitted => null-safe
    // =====================================================================
    console.log('--- Scenario 3: Create EXPENSE without bank snapshots (null-safe) ---');

    const expenseNoBank = await createExpenseTransaction(pool, {
      property_id: propertyId,
      category_code: 'PETTY_CASH',
      party_name: 'Toko Grosir Berkah',
      description: 'Belanja ATK kantor',
      amount: 350000,
      payment_method: 'CASH',
      actor_name: 'Staff Admin'
    });
    tracked.transactions.push(Number(expenseNoBank.id));

    check(expenseNoBank.recipient_bank_name === null,
      '3a. recipient_bank_name is null when omitted');
    check(expenseNoBank.recipient_bank_account === null,
      '3b. recipient_bank_account is null when omitted');
    check(expenseNoBank.recipient_bank_holder === null,
      '3c. recipient_bank_holder is null when omitted');
    check(expenseNoBank.expense_workflow_status === 'PROSES',
      '3d. expense_workflow_status is PROSES even without bank fields');
    check(expenseNoBank.transaction_status === 'POSTED',
      '3e. transaction_status is POSTED');
    check(expenseNoBank.verification_status === 'UNVERIFIED',
      '3f. verification_status is UNVERIFIED');

    console.log(`  [PASS] Assertions ${assertions - 5 + 1}-${assertions} passed\n`);

    // =====================================================================
    // SCENARIO 4-6: Verify default statuses on new EXPENSE
    // =====================================================================
    console.log('--- Scenario 4: New EXPENSE status defaults ---');

    const expenseDefaults = await createExpenseTransaction(pool, {
      property_id: propertyId,
      category_code: 'TRANSPORT_EXPENSE',
      party_name: 'Driver Taxi',
      description: 'Transportasi rapat',
      amount: 150000,
      actor_name: 'Staff'
    });
    tracked.transactions.push(Number(expenseDefaults.id));

    check(expenseDefaults.transaction_status === 'POSTED',
      '4a. transaction_status remains POSTED');
    check(expenseDefaults.verification_status === 'UNVERIFIED',
      '4b. verification_status = UNVERIFIED');
    check(expenseDefaults.expense_workflow_status === 'PROSES',
      '4c. expense_workflow_status = PROSES');
    check(expenseDefaults.payment_status === 'PAID',
      '4d. payment_status = PAID (default is_paid=true)');

    console.log(`  [PASS] Assertions ${assertions - 3 + 1}-${assertions} passed\n`);

    // =====================================================================
    // SCENARIO 7-8: Verify EXPENSE => workflow becomes SELESAI
    // =====================================================================
    console.log('--- Scenario 7-8: Verify EXPENSE sets expense_workflow_status = SELESAI ---');

    const expenseToVerify = await createExpenseTransaction(pool, {
      property_id: propertyId,
      category_code: 'MAINTENANCE_EXPENSE',
      party_name: 'Toko Bangunan Sejahtera',
      description: 'Beli cat dan kuas',
      amount: 850000,
      recipient_bank_name: 'Bank BRI',
      recipient_bank_account: '9876543210',
      recipient_bank_holder: 'Toko Bangunan Sejahtera',
      actor_name: 'Staff'
    });
    tracked.transactions.push(Number(expenseToVerify.id));

    check(expenseToVerify.verification_status === 'UNVERIFIED',
      '7a. Before verify: verification_status = UNVERIFIED');
    check(expenseToVerify.expense_workflow_status === 'PROSES',
      '7b. Before verify: expense_workflow_status = PROSES');

    const verifiedExpense = await verifyTransaction(pool, expenseToVerify.id, {
      property_id: propertyId,
      verification_status: 'VERIFIED',
      actor_name: 'Supervisor Test',
      verification_note: 'Sudah diverifikasi'
    });

    check(verifiedExpense.verification_status === 'VERIFIED',
      '8a. After verify: verification_status = VERIFIED');
    check(verifiedExpense.expense_workflow_status === 'SELESAI',
      '8b. After verify: expense_workflow_status = SELESAI');
    check(verifiedExpense.operational_sheet === 'SELESAI',
      '8c. After verify: operational_sheet = SELESAI');

    console.log(`  [PASS] Assertions ${assertions - 4 + 1}-${assertions} passed\n`);

    // =====================================================================
    // SCENARIO 9-10: Expense operational sheet PROSES before, SELESAI after
    // =====================================================================
    console.log('--- Scenario 9-10: Operational sheet derivation ---');

    check(expenseToVerify.operational_sheet === 'PROSES',
      '9a. Before verify: operational_sheet = PROSES (expense_workflow_status=PROSES)');
    check(verifiedExpense.operational_sheet === 'SELESAI',
      '10a. After verify: operational_sheet = SELESAI (expense_workflow_status=SELESAI)');

    // =====================================================================
    // SCENARIO 11: Void/reversal => operational sheet = BATAL
    // =====================================================================
    console.log('--- Scenario 11: Void expense => BATAL ---');

    const expenseToVoid = await createExpenseTransaction(pool, {
      property_id: propertyId,
      category_code: 'CLEANING_SUPPLIES',
      party_name: 'UD Bersih Sentosa',
      description: 'Pembelian deterjen',
      amount: 420000,
      actor_name: 'Staff'
    });
    tracked.transactions.push(Number(expenseToVoid.id));

    const { original: voidedOriginal } = await voidTransaction(pool, propertyId, expenseToVoid.id, {
      reason: 'Nota dibatalkan',
      actor_name: 'Supervisor Test'
    });

    const voidedExpense = await getTransactionById(pool, propertyId, expenseToVoid.id);

    check(voidedExpense.transaction_status === 'VOIDED',
      '11a. After void: transaction_status = VOIDED');
    check(voidedExpense.operational_sheet === 'BATAL',
      '11b. After void: operational_sheet = BATAL');

    console.log(`  [PASS] Assertions ${assertions - 1 + 1}-${assertions} passed\n`);

    // =====================================================================
    // SCENARIO 12: deleted_at => operational sheet = HAPUS
    // =====================================================================
    console.log('--- Scenario 12: Soft delete expense => HAPUS ---');

    const expenseToDelete = await createExpenseTransaction(pool, {
      property_id: propertyId,
      category_code: 'OTHER_EXPENSE',
      party_name: 'Freelancer ABC',
      description: 'Jasa desain logo',
      amount: 500000,
      is_paid: false,
      actor_name: 'Staff'
    });
    tracked.transactions.push(Number(expenseToDelete.id));

    const deletedExpense = await softDeleteTransaction(pool, propertyId, expenseToDelete.id, {
      property_id: propertyId,
      delete_reason: 'Duplicate entry',
      actor_name: 'Staff'
    });

    check(deletedExpense.deleted_at !== null,
      '12a. After soft delete: deleted_at is set');
    check(deletedExpense.operational_sheet === 'HAPUS',
      '12b. After soft delete: operational_sheet = HAPUS');

    console.log(`  [PASS] Assertions ${assertions - 1 + 1}-${assertions} passed\n`);

    // =====================================================================
    // SCENARIO 13: PURCHASE lifecycle remains unchanged
    // =====================================================================
    console.log('--- Scenario 13: PURCHASE lifecycle unchanged ---');

    const purchase = await createPurchaseTransaction(pool, {
      property_id: propertyId,
      category_code: 'FNB_INGREDIENTS_PURCHASE',
      department_code: 'FNB',
      supplier_id: supplier.id,
      description: 'Beli bahan makanan',
      amount: 5000000,
      lines: [
        { description: 'Beras 5kg', quantity: 10, unit: 'sak', unit_price: 500000, discount_amount: 0 }
      ],
      actor_name: 'Purchasing'
    });
    tracked.transactions.push(Number(purchase.id));

    check(purchase.purchase_workflow_status === 'PROSES',
      '13a. PURCHASE: purchase_workflow_status = PROSES (unchanged)');
    check(purchase.expense_workflow_status === null,
      '13b. PURCHASE: expense_workflow_status = null (not affected by EXPENSE changes)');
    check(purchase.operational_sheet === 'PROSES',
      '13c. PURCHASE: operational_sheet = PROSES (unchanged)');

    console.log(`  [PASS] Assertions ${assertions - 2 + 1}-${assertions} passed\n`);

    // =====================================================================
    // SCENARIO 14: EXPENSE bank fields NOT sourced from Supplier Master
    // =====================================================================
    console.log('--- Scenario 14: EXPENSE bank fields are independent of Supplier Master ---');

    const expenseWithSupplier = await createExpenseTransaction(pool, {
      property_id: propertyId,
      category_code: 'UTILITIES_EXPENSE',
      supplier_id: supplier.id,
      party_name: 'PT Energi Nusantara',
      description: 'Listrik gedung A',
      amount: 3200000,
      recipient_bank_name: 'Bank Danamon',
      recipient_bank_account: '0012345678',
      recipient_bank_holder: 'PT Energi Nusantara',
      actor_name: 'Staff'
    });
    tracked.transactions.push(Number(expenseWithSupplier.id));

    check(expenseWithSupplier.recipient_bank_name === 'Bank Danamon',
      '14a. Bank name is from snapshot, NOT from supplier master');
    check(expenseWithSupplier.recipient_bank_account === '0012345678',
      '14b. Bank account is from snapshot, NOT from supplier master');
    check(expenseWithSupplier.recipient_bank_holder === 'PT Energi Nusantara',
      '14c. Bank holder is from snapshot, NOT from supplier master');
    // Supplier master still has its own values (unchanged)
    check(supplier.bank_name === 'Bank Supplier Master',
      '14d. Supplier master bank_name unchanged');
    check(supplier.bank_account === '1234567890',
      '14e. Supplier master bank_account unchanged');

    console.log(`  [PASS] Assertions ${assertions - 4 + 1}-${assertions} passed\n`);

    // =====================================================================
    // SCENARIO 15: Property scope enforced
    // =====================================================================
    console.log('--- Scenario 15: Property scope enforced ---');

    const otherPropCode = `XP${randNum.toString().substring(0,4)}`;
    const otherPropRes = await pool.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('Other Property', $1, 'Asia/Jakarta', 'IDR', 'Jl. Lain No. 2', TRUE) RETURNING id",
      [otherPropCode]
    );
    const otherPropertyId = Number(otherPropRes.rows[0].id);
    tracked.properties.push(otherPropertyId);

    const otherExpense = await createExpenseTransaction(pool, {
      property_id: otherPropertyId,
      category_code: 'PETTY_CASH',
      party_name: 'Toko Lain',
      description: 'Belanja lain',
      amount: 100000,
      actor_name: 'Staff'
    });
    tracked.transactions.push(Number(otherExpense.id));

    // Should NOT find other property's expense in this property
    const wrongScope = await getTransactionById(pool, propertyId, otherExpense.id).catch(() => null);
    check(wrongScope === null, '15a. Cannot access another property\'s transaction');

    // Should find own expense
    const ownExpense = await getTransactionById(pool, propertyId, expenseWithBank.id);
    check(ownExpense !== null, '15b. Can access own property\'s transaction');

    // Query with property filter
    const expenses = await getTransactions(pool, {
      property_id: propertyId,
      transaction_type: 'EXPENSE'
    });
    check(expenses.transactions.length >= 4, '15c. Property-scoped query returns correct count');

    console.log(`  [PASS] Assertions ${assertions - 2 + 1}-${assertions} passed\n`);

    // =====================================================================
    // SCENARIO 16: Unverify EXPENSE → expense_workflow_status = PROSES
    // =====================================================================
    console.log('--- Scenario 16: Unverify EXPENSE → PROSES ---');

    const unverifiedExpense = await verifyTransaction(pool, expenseToVerify.id, {
      property_id: propertyId,
      verification_status: 'UNVERIFIED',
      actor_name: 'Supervisor Test',
      verification_note: 'Dibatalkan verifikasi'
    });

    check(unverifiedExpense.verification_status === 'UNVERIFIED',
      '16a. After unverify: verification_status = UNVERIFIED');
    check(unverifiedExpense.expense_workflow_status === 'PROSES',
      '16b. After unverify: expense_workflow_status = PROSES');
    check(unverifiedExpense.operational_sheet === 'PROSES',
      '16c. After unverify: operational_sheet = PROSES');

    console.log(`  [PASS] Assertions ${assertions - 3 + 1}-${assertions} passed\n`);

    // =====================================================================
    // SCENARIO 17: Re-verify EXPENSE → expense_workflow_status = SELESAI
    // =====================================================================
    console.log('--- Scenario 17: Re-verify EXPENSE → SELESAI ---');

    const reVerifiedExpense = await verifyTransaction(pool, expenseToVerify.id, {
      property_id: propertyId,
      verification_status: 'VERIFIED',
      actor_name: 'Supervisor Test',
      verification_note: 'Diverifikasi ulang'
    });

    check(reVerifiedExpense.verification_status === 'VERIFIED',
      '17a. After re-verify: verification_status = VERIFIED');
    check(reVerifiedExpense.expense_workflow_status === 'SELESAI',
      '17b. After re-verify: expense_workflow_status = SELESAI');
    check(reVerifiedExpense.operational_sheet === 'SELESAI',
      '17c. After re-verify: operational_sheet = SELESAI');

    console.log(`  [PASS] Assertions ${assertions - 2 + 1}-${assertions} passed\n`);

    // =====================================================================
    // SCENARIO 18: Reject EXPENSE → expense_workflow_status = PROSES
    // =====================================================================
    console.log('--- Scenario 18: Reject EXPENSE → PROSES ---');

    const rejectedExpense = await verifyTransaction(pool, expenseToVerify.id, {
      property_id: propertyId,
      verification_status: 'REJECTED',
      actor_name: 'Supervisor Test',
      verification_note: 'Ditolak karena dokumen tidak lengkap'
    });

    check(rejectedExpense.verification_status === 'REJECTED',
      '18a. After reject: verification_status = REJECTED');
    check(rejectedExpense.expense_workflow_status === 'PROSES',
      '18b. After reject: expense_workflow_status = PROSES');
    check(rejectedExpense.operational_sheet === 'PROSES',
      '18c. After reject: operational_sheet = PROSES');

    console.log(`  [PASS] Assertions ${assertions - 2 + 1}-${assertions} passed\n`);

    // =====================================================================
    // SCENARIO 19: Re-verify after reject → back to SELESAI
    // =====================================================================
    console.log('--- Scenario 19: Re-verify after reject → SELESAI ---');

    const reVerifiedAgain = await verifyTransaction(pool, expenseToVerify.id, {
      property_id: propertyId,
      verification_status: 'VERIFIED',
      actor_name: 'Supervisor Test',
      verification_note: 'Diverifikasi setelah revisi'
    });

    check(reVerifiedAgain.verification_status === 'VERIFIED',
      '19a. After re-verify: verification_status = VERIFIED');
    check(reVerifiedAgain.expense_workflow_status === 'SELESAI',
      '19b. After re-verify: expense_workflow_status = SELESAI');

    console.log(`  [PASS] Assertions ${assertions - 1 + 1}-${assertions} passed\n`);

    // =====================================================================
    // SCENARIO 20: Historical backfill — verified expense with NULL workflow → SELESAI
    // =====================================================================
    console.log('--- Scenario 20: Backfill verified expense → SELESAI ---');

    const backfillNoV = `TX-BACKFILL-V-${Date.now()}`;
    const insertedVerifiedRes = await pool.query(
      `INSERT INTO transactions (
        property_id, transaction_no, transaction_date, transaction_time,
        transaction_type, source_type, source_reference, party_name,
        category_code, category_name, department_code, description,
        amount, discount_amount, service_amount, tax_amount, rounding_amount, net_amount,
        payment_status, payment_method, transaction_status,
        verification_status, expense_workflow_status,
        notes, metadata, created_by
      ) VALUES (
        $1, $2, CURRENT_DATE, NOW(),
        'EXPENSE', 'MANUAL_EXPENSE', 'BKL-V', 'Toko Peralatan ABC',
        'CLEANING_SUPPLIES', 'Cleaning Supplies', 'MAINTENANCE', 'Nota lama diverifikasi manual',
        250000, 0, 0, 0, 0, 250000,
        'PAID', 'CASH', 'POSTED',
        'VERIFIED', NULL,
        'Manual backfill', NULL, 'Admin'
      ) RETURNING id`,
      [propertyId, backfillNoV]
    );
    const backfilledVerTxId = Number(insertedVerifiedRes.rows[0].id);
    tracked.transactions.push(backfilledVerTxId);

    await pool.query(
      `UPDATE transactions
       SET expense_workflow_status =
         CASE
           WHEN UPPER(COALESCE(verification_status, '')) = 'VERIFIED'
             THEN 'SELESAI'
           ELSE 'PROSES'
         END
       WHERE UPPER(transaction_type) = 'EXPENSE'
         AND expense_workflow_status IS NULL`
    );

    const backfilledVerTx = await getTransactionById(pool, propertyId, backfilledVerTxId);
    check(backfilledVerTx.expense_workflow_status === 'SELESAI',
      '20a. Backfilled verified expense → expense_workflow_status = SELESAI');
    check(backfilledVerTx.verification_status === 'VERIFIED',
      '20b. Backfilled verified expense retains VERIFIED status');
    check(backfilledVerTx.operational_sheet === 'SELESAI',
      '20c. Backfilled verified expense → operational_sheet = SELESAI');

    console.log(`  [PASS] Assertions ${assertions - 2 + 1}-${assertions} passed\n`);

    // =====================================================================
    // SCENARIO 21: Historical backfill — unverified expense with NULL workflow → PROSES
    // =====================================================================
    console.log('--- Scenario 21: Backfill unverified expense → PROSES ---');

    const backfillNoU = `TX-BACKFILL-U-${Date.now()}`;
    const insertedUnverRes = await pool.query(
      `INSERT INTO transactions (
        property_id, transaction_no, transaction_date, transaction_time,
        transaction_type, source_type, source_reference, party_name,
        category_code, category_name, department_code, description,
        amount, discount_amount, service_amount, tax_amount, rounding_amount, net_amount,
        payment_status, payment_method, transaction_status,
        verification_status, expense_workflow_status,
        notes, metadata, created_by
      ) VALUES (
        $1, $2, CURRENT_DATE, NOW(),
        'EXPENSE', 'MANUAL_EXPENSE', 'BKL-U', 'Toko ATK Maju',
        'OFFICE_SUPPLIES', 'Office Supplies', 'ADMIN', 'Nota lama belum diverifikasi',
        175000, 0, 0, 0, 0, 175000,
        'UNPAID', 'CASH', 'POSTED',
        'UNVERIFIED', NULL,
        'Manual backfill', NULL, 'Admin'
      ) RETURNING id`,
      [propertyId, backfillNoU]
    );
    const backfilledUnverTxId = Number(insertedUnverRes.rows[0].id);
    tracked.transactions.push(backfilledUnverTxId);

    await pool.query(
      `UPDATE transactions
       SET expense_workflow_status =
         CASE
           WHEN UPPER(COALESCE(verification_status, '')) = 'VERIFIED'
             THEN 'SELESAI'
           ELSE 'PROSES'
         END
       WHERE UPPER(transaction_type) = 'EXPENSE'
         AND expense_workflow_status IS NULL`
    );

    const backfilledUnverTx = await getTransactionById(pool, propertyId, backfilledUnverTxId);
    check(backfilledUnverTx.expense_workflow_status === 'PROSES',
      '21a. Backfilled unverified expense → expense_workflow_status = PROSES');
    check(backfilledUnverTx.verification_status === 'UNVERIFIED',
      '21b. Backfilled unverified expense retains UNVERIFIED status');
    check(backfilledUnverTx.operational_sheet === 'PROSES',
      '21c. Backfilled unverified expense → operational_sheet = PROSES');

    console.log(`  [PASS] Assertions ${assertions - 2 + 1}-${assertions} passed\n`);

    // =====================================================================
    // SCENARIO 22: PURCHASE verification/workflow remains unchanged
    // =====================================================================
    console.log('--- Scenario 22: PURCHASE verification/workflow unchanged ---');

    const purchaseForVerify = await createPurchaseTransaction(pool, {
      property_id: propertyId,
      category_code: 'FNB_INGREDIENTS_PURCHASE',
      department_code: 'FNB',
      supplier_id: supplier.id,
      description: 'Beli bahan verifikasi',
      amount: 2000000,
      lines: [
        { description: 'Gula 25kg', quantity: 5, unit: 'karung', unit_price: 400000, discount_amount: 0 }
      ],
      actor_name: 'Purchasing'
    });
    tracked.transactions.push(Number(purchaseForVerify.id));

    check(purchaseForVerify.expense_workflow_status === null,
      '22a. PURCHASE expense_workflow_status = null before verify');
    check(purchaseForVerify.purchase_workflow_status === 'PROSES',
      '22b. PURCHASE purchase_workflow_status = PROSES before verify');

    const purchasedVerified = await verifyTransaction(pool, purchaseForVerify.id, {
      property_id: propertyId,
      verification_status: 'VERIFIED',
      actor_name: 'Supervisor Purchasing'
    });

    check(purchasedVerified.verification_status === 'VERIFIED',
      '22c. PURCHASE verification_status = VERIFIED after verify');
    check(purchasedVerified.expense_workflow_status === null,
      '22d. PURCHASE expense_workflow_status still null after verify');
    check(purchasedVerified.purchase_workflow_status === 'PROSES',
      '22e. PURCHASE purchase_workflow_status unchanged (PROSES)');
    check(purchasedVerified.operational_sheet === 'PROSES',
      '22f. PURCHASE operational_sheet = PROSES');

    console.log(`  [PASS] Assertions ${assertions - 4 + 1}-${assertions} passed\n`);

    // =====================================================================
    // SCENARIO 23: Cross-property verify cannot mutate expense_workflow_status
    // =====================================================================
    console.log('--- Scenario 23: Cross-property verify rejected ---');

    await assert.rejects(
      async () => {
        await verifyTransaction(pool, otherExpense.id, {
          property_id: propertyId,
          verification_status: 'VERIFIED',
          actor_name: 'Wrong Supervisor'
        });
      },
      /tidak ditemukan/i,
      '23a. Cross-property verify throws not-found error'
    );

    const otherVerified = await verifyTransaction(pool, otherExpense.id, {
      property_id: otherPropertyId,
      verification_status: 'VERIFIED',
      actor_name: 'Correct Supervisor'
    });
    check(otherVerified.verification_status === 'VERIFIED',
      '23b. Verify on correct property succeeds');
    check(otherVerified.expense_workflow_status === 'SELESAI',
      '23c. Verify on correct property sets expense_workflow_status = SELESAI');

    console.log(`  [PASS] Assertions ${assertions - 2 + 1}-${assertions} passed\n`);

    // =====================================================================
    // ADDITIONAL: Query list returns recipient bank fields
    // =====================================================================
    console.log('--- Additional: Query list returns recipient bank fields ---');

    const allExpenses = await getTransactions(pool, {
      property_id: propertyId,
      transaction_type: 'EXPENSE'
    });

    const withBank = allExpenses.transactions.find(t => t.id === String(expenseWithBank.id));
    check(withBank !== undefined, 'A1. Found expense with bank in list query');
    check(withBank.recipient_bank_name === 'Bank Mandiri', 'A2. List query returns recipient_bank_name');
    check(withBank.expense_workflow_status === 'PROSES', 'A3. List query returns expense_workflow_status');

    const noBank = allExpenses.transactions.find(t => t.id === String(expenseNoBank.id));
    check(noBank.recipient_bank_name === null, 'A4. Expense without bank has null snapshot fields');
    check(noBank.expense_workflow_status === 'PROSES', 'A5. Expense without bank still has PROSES workflow');

    console.log(`  [PASS] Additional assertions ${assertions - 5 + 1}-${assertions} passed\n`);

    // =====================================================================
    // SCENARIO 24: GENERIC verification (SALE/INCOME) preserves original behavior
    // =====================================================================
    console.log('--- Scenario 24: Generic verify semantics preserved ---');

    const { createIncomeTransaction } = await import('../dist/domains/transactions/transactionService.js');

    const incomeTx = await createIncomeTransaction(pool, {
      property_id: propertyId,
      category_code: 'RENTAL_INCOME',
      department_code: 'FRONT_OFFICE',
      customer_name: 'Tamu Regular',
      description: 'Pembayaran ruang tamu',
      amount: 500000,
      payment_method: 'CASH',
      actor_name: 'Resepsionis'
    });
    tracked.transactions.push(Number(incomeTx.id));

    check(incomeTx.verification_status === 'UNVERIFIED',
      '24a. New INCOME defaults to UNVERIFIED');
    check(incomeTx.expense_workflow_status === null,
      '24b. INCOME expense_workflow_status = null');

    // Verify INCOME — should stamp verified_at and NOT touch expense_workflow_status
    const incomeVerified = await verifyTransaction(pool, incomeTx.id, {
      property_id: propertyId,
      verification_status: 'VERIFIED',
      actor_name: 'Supervisor Test',
      verification_note: 'Verifikasi pemasukan'
    });
    check(incomeVerified.verification_status === 'VERIFIED',
      '24c. INCOME verification_status = VERIFIED after verify');
    check(incomeVerified.expense_workflow_status === null,
      '24d. INCOME expense_workflow_status remains null after verify');
    check(incomeVerified.verified_at !== null,
      '24e. INCOME verified_at is stamped on VERIFIED');
    const verifiedAtValue = incomeVerified.verified_at;

    // Unverify INCOME — generic behavior stamps NOW() on every verification mutation
    const incomeUnverified = await verifyTransaction(pool, incomeTx.id, {
      property_id: propertyId,
      verification_status: 'UNVERIFIED',
      actor_name: 'Supervisor Test',
      verification_note: 'Cabut verifikasi'
    });
    check(incomeUnverified.verification_status === 'UNVERIFIED',
      '24f. INCOME verification_status = UNVERIFIED after unverify');
    check(incomeUnverified.expense_workflow_status === null,
      '24g. INCOME expense_workflow_status remains null after unverify');
    check(incomeUnverified.verified_at !== null,
      '24h. INCOME verified_at is stamped on UNVERIFIED (generic behavior)');

    console.log(`  [PASS] Assertions ${assertions - 6 + 1}-${assertions} passed\n`);

    console.log(`\n=== All ${assertions} EXPENSE-1B Data Foundation Assertions PASSED ===\n`);

  } catch (err) {
    console.error('\n[Test FAILED]', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    console.log('\n--- Cleaning Up Test Fixtures ---');
    for (const propId of tracked.properties) {
      await pool.query('DELETE FROM transaction_attachments WHERE property_id = $1', [propId]).catch(() => {});
      await pool.query('DELETE FROM payment_transactions WHERE property_id = $1', [propId]).catch(() => {});
      await pool.query('DELETE FROM transaction_lines WHERE property_id = $1', [propId]).catch(() => {});
      await pool.query('DELETE FROM transactions WHERE property_id = $1', [propId]).catch(() => {});
      await pool.query('DELETE FROM suppliers WHERE property_id = $1', [propId]).catch(() => {});
      await pool.query('DELETE FROM audit_logs WHERE property_id = $1', [propId]).catch(() => {});
      await pool.query('DELETE FROM properties WHERE id = $1', [propId]).catch(() => {});
    }
    server.close();
    console.log('[CLEANUP] Done.');
  }
}

runTests().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

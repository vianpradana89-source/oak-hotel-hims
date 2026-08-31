import assert from 'node:assert/strict';
import http from 'node:http';
import pkg from '../dist/index.js';
import schemaPkg from '../dist/db/schema_v3.js';
import {
  createPurchaseTransaction,
  createExpenseTransaction,
  createIncomeTransaction,
  updatePurchaseReceivingStatus,
  settleTransactionPayment,
  verifyTransaction,
  getCustomCategories,
  createCustomCategory,
  toggleCustomCategory,
  addTransactionAttachment,
  deleteTransactionAttachment,
  getTransactionById,
  getTransactions
} from '../dist/domains/transactions/transactionService.js';
import {
  createSupplier,
  updateSupplier,
  toggleSupplier,
  getSuppliers
} from '../dist/domains/suppliers/supplierService.js';

const { app, pool } = pkg;
const { initializeDatabase } = schemaPkg;

async function runTests() {
  console.log('=== RUNNING TRANSACTION-2D OPERATIONAL WORKFLOW TEST SUITE ===');

  await initializeDatabase(pool);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const randNum = Math.floor(1000 + Math.random() * 8999);
  const propCode = `D${randNum}`; // max 6 chars for property_code

  const tracked = {
    properties: [],
    suppliers: [],
    customCategories: [],
    transactions: [],
    attachments: [],
    payments: []
  };

  try {
    // 0. Setup isolated test property
    const propRes = await pool.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('T2D Workflow Property', $1, 'Asia/Jakarta', 'IDR', 'Jl. Transaksi No. 2D', TRUE) RETURNING id",
      [propCode]
    );
    const propertyId = Number(propRes.rows[0].id);
    tracked.properties.push(propertyId);
    console.log(`[PASS] Isolated test property created (ID: ${propertyId}, Code: ${propCode})`);

    // 1. Supplier Domain Lifecycle
    console.log('\n--- 1. Testing Supplier Domain Lifecycle ---');
    const sup1 = await createSupplier(pool, {
      property_id: propertyId,
      name: `PT Mitra Berkah Sejahtera ${randNum}`,
      phone: '081234567890',
      bank_name: 'BCA',
      bank_account: '8877665544',
      address: 'Kawasan Industri Rungkut, Surabaya',
      actor_name: 'Admin Purchasing'
    });
    tracked.suppliers.push(Number(sup1.id));
    assert.ok(sup1.id, 'Supplier should have an ID');
    assert.strictEqual(sup1.is_active, true, 'Supplier should be active by default');

    // Test duplicate supplier name prevention
    await assert.rejects(
      async () => {
        await createSupplier(pool, {
          property_id: propertyId,
          name: `pt mitra berkah sejahtera ${randNum}`, // case-insensitive duplicate
          actor_name: 'Admin'
        });
      },
      /sudah terdaftar/i,
      'Should reject duplicate supplier name for same property'
    );
    console.log('[PASS] Supplier duplicate name prevented');

    // Update supplier
    const supUpdated = await updateSupplier(pool, propertyId, sup1.id, {
      phone: '081299998888',
      actor_name: 'Manager'
    });
    assert.strictEqual(supUpdated.phone, '081299998888', 'Supplier phone should be updated');

    // Toggle supplier active status
    const supToggled = await toggleSupplier(pool, propertyId, sup1.id, 'Manager');
    assert.strictEqual(supToggled.is_active, false, 'Supplier should now be inactive');
    const supToggledBack = await toggleSupplier(pool, propertyId, sup1.id, 'Manager');
    assert.strictEqual(supToggledBack.is_active, true, 'Supplier should now be active again');
    console.log('[PASS] Supplier CRUD & active toggle passed');

    // 2. Custom Categories Management
    console.log('\n--- 2. Testing Custom Categories Management ---');
    const customCatCode = `CUSTOM_MEETING_${randNum}`;
    const customCat = await createCustomCategory(pool, {
      property_id: propertyId,
      code: customCatCode,
      name: 'Penyewaan Meeting Room & Proyektor',
      transaction_type: 'INCOME',
      department_code: 'FNB'
    });
    tracked.customCategories.push(customCat.code);
    assert.strictEqual(customCat.code, customCatCode);
    assert.strictEqual(customCat.is_active, true);

    const categoriesList = await getCustomCategories(pool, propertyId, 'INCOME');
    assert.ok(categoriesList.some((c) => c.code === customCatCode), 'Custom category should appear in category list');

    const catToggled = await toggleCustomCategory(pool, propertyId, customCatCode, 'Admin');
    assert.strictEqual(catToggled.is_active, false, 'Custom category should be inactive after toggle');
    await toggleCustomCategory(pool, propertyId, customCatCode, 'Admin');
    console.log('[PASS] Custom category lifecycle passed');

    // 3. Multi-Line Purchase with PostgreSQL ROUND arithmetic & fractional quantities
    console.log('\n--- 3. Testing Multi-Line Purchase & Authoritative Math ---');
    // Line 1: 2.375 kg @ Rp 17.500 = ROUND(2.375 * 17500)::bigint = 41563
    // Line 2: 50 pcs @ Rp 1.250 - discount 5.000 = (50 * 1250) - 5000 = 57500
    // Lines sum = 41563 + 57500 = 99063
    // Overall discount: 2000
    // Rounding: 37
    // Net: 99063 - 2000 + 37 = 97100
    const purchaseTx = await createPurchaseTransaction(pool, {
      property_id: propertyId,
      transaction_date: '2026-08-30',
      category_code: 'FNB_INGREDIENTS_PURCHASE',
      category_name: 'Pembelian Bahan Baku Makanan & Minuman',
      department_code: 'FNB',
      supplier_id: sup1.id,
      source_reference: `PO-${randNum}-01`,
      receiving_status: 'BELUM_DITERIMA',
      description: 'Pembelian Daging Sapi & Bumbu Dapur',
      lines: [
        {
          description_snapshot: 'Daging Sapi Has Dalam (Tenderloin)',
          quantity: 2.375,
          unit: 'kg',
          unit_price: 17500,
          discount_amount: 0
        },
        {
          description_snapshot: 'Bumbu Racik Sachet',
          quantity: 50,
          unit: 'pcs',
          unit_price: 1250,
          discount_amount: 5000
        }
      ],
      transaction_discount: 2000,
      rounding_amount: 37,
      paid_amount: 0,
      notes: 'Pembelian tempo 14 hari',
      actor_name: 'Chef Purchasing',
      actor_user_id: 'USR-CHEF-01'
    });

    tracked.transactions.push(purchaseTx.id);
    assert.strictEqual(purchaseTx.transaction_type, 'PURCHASE', 'Transaction type should be PURCHASE');
    assert.strictEqual(String(purchaseTx.supplier_id), String(sup1.id), 'Supplier ID should match');
    assert.strictEqual(purchaseTx.receiving_status, 'BELUM_DITERIMA', 'Receiving status should be BELUM_DITERIMA');
    assert.strictEqual(purchaseTx.verification_status, 'UNVERIFIED', 'Verification status should be UNVERIFIED');
    assert.strictEqual(purchaseTx.payment_status, 'UNPAID', 'Payment status should be UNPAID');

    // Verify lines and mathematical calculations
    const purchaseDetail = await getTransactionById(pool, propertyId, purchaseTx.id);
    assert.strictEqual(purchaseDetail.lines.length, 2, 'Should have 2 lines');

    const l1 = purchaseDetail.lines[0];
    const l2 = purchaseDetail.lines[1];
    assert.strictEqual(Number(l1.line_total), 41563, 'Line 1 line_total must be integer 41563');
    assert.strictEqual(Number(l2.line_total), 57500, 'Line 2 line_total must be integer 57500');

    // Authoritative net amount: 41563 + 57500 - 2000 + 37 = 97100
    assert.strictEqual(Number(purchaseDetail.net_amount), 97100, 'Net amount must match authoritative math 97100');
    assert.strictEqual(Number(purchaseDetail.outstanding_amount), 97100, 'Outstanding must be 97100');
    console.log('[PASS] Multi-line purchase math & PostgreSQL rounding verified deterministic');

    // 4. Physical Receiving Lifecycle
    console.log('\n--- 4. Testing Physical Receiving Lifecycle ---');
    const recPartial = await updatePurchaseReceivingStatus(pool, purchaseTx.id, {
      property_id: propertyId,
      receiving_status: 'DITERIMA_SEBAGIAN',
      actor_name: 'Gudang Staff'
    });
    assert.strictEqual(recPartial.receiving_status, 'DITERIMA_SEBAGIAN');
    assert.ok(recPartial.received_at, 'received_at timestamp should be set');

    const recFull = await updatePurchaseReceivingStatus(pool, purchaseTx.id, {
      property_id: propertyId,
      receiving_status: 'DITERIMA',
      actor_name: 'Gudang Supervisor'
    });
    assert.strictEqual(recFull.receiving_status, 'DITERIMA');
    console.log('[PASS] Physical receiving status lifecycle passed');

    // 5. Authoritative Settlement Ledgering & Outstanding Calculation
    console.log('\n--- 5. Testing Payment Settlement Ledger ---');
    // Partial payment 50.000
    const settle1 = await settleTransactionPayment(pool, purchaseTx.id, {
      property_id: propertyId,
      amount: 50000,
      payment_method: 'TRANSFER',
      notes: 'DP 50%',
      actor_name: 'Finance Desk'
    });
    assert.strictEqual(settle1.payment_status, 'PARTIALLY_PAID', 'Payment status should be PARTIALLY_PAID');
    assert.strictEqual(Number(settle1.paid_amount), 50000, 'Paid amount should be 50000');
    assert.strictEqual(Number(settle1.outstanding_amount), 47100, 'Outstanding should be 47100');

    // Attempt overpayment
    await assert.rejects(
      async () => {
        await settleTransactionPayment(pool, purchaseTx.id, {
          property_id: propertyId,
          amount: 50000, // exceeds remaining 47.100
          payment_method: 'TRANSFER',
          actor_name: 'Finance Desk'
        });
      },
      /melebihi sisa tagihan/i,
      'Should reject overpayment exceeding outstanding balance'
    );
    console.log('[PASS] Overpayment guard verified');

    // Final settlement 47.100
    const settle2 = await settleTransactionPayment(pool, purchaseTx.id, {
      property_id: propertyId,
      amount: 47100,
      payment_method: 'TRANSFER',
      notes: 'Pelunasan Akhir',
      actor_name: 'Finance Desk'
    });
    assert.strictEqual(settle2.payment_status, 'PAID', 'Payment status should now be PAID');
    assert.strictEqual(Number(settle2.paid_amount), 97100, 'Paid amount should now be 97100');
    assert.strictEqual(Number(settle2.outstanding_amount), 0, 'Outstanding should now be 0');

    // Assert linked payments in detail
    const purchaseAfterSettle = await getTransactionById(pool, propertyId, purchaseTx.id);
    assert.strictEqual(purchaseAfterSettle.linked_payments.length, 2, 'Should have 2 payment ledger rows');
    console.log('[PASS] Authoritative payment settlement & dynamic ledger verified');

    // 6. Purpose-Aware Attachments & Verification Deletion Protection
    console.log('\n--- 6. Testing Purpose-Aware Attachments & Verification Safety ---');
    const att1 = await addTransactionAttachment(pool, propertyId, purchaseTx.id, {
      fileName: 'invoice-mitra-01.pdf',
      originalName: 'Invoice Mitra Berkah.pdf',
      mimeType: 'application/pdf',
      fileSize: 102400,
      storagePath: '/uploads/transactions/invoice-mitra-01.pdf',
      uploadedBy: 'Purchasing Staff',
      attachmentPurpose: 'INVOICE'
    });
    tracked.attachments.push(Number(att1.id));
    assert.strictEqual(att1.attachment_purpose, 'INVOICE', 'Attachment purpose should be INVOICE');

    const att2 = await addTransactionAttachment(pool, propertyId, purchaseTx.id, {
      fileName: 'struk-transfer.jpg',
      originalName: 'Bukti Transfer BCA.jpg',
      mimeType: 'image/jpeg',
      fileSize: 51200,
      storagePath: '/uploads/transactions/struk-transfer.jpg',
      uploadedBy: 'Finance Staff',
      attachmentPurpose: 'PAYMENT_PROOF'
    });
    tracked.attachments.push(Number(att2.id));
    assert.strictEqual(att2.attachment_purpose, 'PAYMENT_PROOF');

    // Verify transaction (UNVERIFIED -> VERIFIED)
    const verifiedTx = await verifyTransaction(pool, purchaseTx.id, {
      property_id: propertyId,
      verification_status: 'VERIFIED',
      verification_note: 'Dokumen lengkap dan barang sesuai spesifikasi',
      actor_name: 'Supervisor Accounting',
      actor_user_id: 'USR-SPV-01'
    });
    assert.strictEqual(verifiedTx.verification_status, 'VERIFIED');
    assert.strictEqual(verifiedTx.verified_by_name_snapshot, 'Supervisor Accounting');
    assert.ok(verifiedTx.verified_at, 'verified_at must be populated');

    // Attempt to delete attachment on VERIFIED transaction -> MUST FAIL
    await assert.rejects(
      async () => {
        await deleteTransactionAttachment(pool, propertyId, purchaseTx.id, att1.id, 'Staff');
      },
      /sudah dalam status TERVERIFIKASI/i,
      'Must protect attachments from deletion when transaction is VERIFIED'
    );
    console.log('[PASS] Attachment deletion lock on VERIFIED status verified');

    // Change verification to REJECTED or UNVERIFIED, then delete is allowed
    await verifyTransaction(pool, purchaseTx.id, {
      property_id: propertyId,
      verification_status: 'UNVERIFIED',
      verification_note: 'Buka verifikasi untuk revisi berkas',
      actor_name: 'Supervisor Accounting'
    });
    const deleted = await deleteTransactionAttachment(pool, propertyId, purchaseTx.id, att1.id, 'Staff');
    assert.strictEqual(deleted.success, true, 'Attachment deletion should succeed when UNVERIFIED');
    console.log('[PASS] Verification status toggle and attachment lifecycle passed');

    // 7. Operational Expense Workflow (Immediate Payment)
    console.log('\n--- 7. Testing Operational Expense Workflow ---');
    const expenseTx = await createExpenseTransaction(pool, {
      property_id: propertyId,
      transaction_date: '2026-08-30',
      category_code: 'PETTY_CASH',
      category_name: 'Kas Kecil / Operasional Harian',
      department_code: 'FRONT_OFFICE',
      supplier_id: sup1.id,
      party_name: 'Toko Buku Gramedia',
      description: 'Pembelian Kertas Thermal Struk & Map Arsip',
      amount: 150000,
      payment_method: 'CASH',
      source_reference: 'NOTA-GRM-88',
      is_paid: true,
      notes: 'Beli ATK darurat',
      actor_name: 'FO Staff',
      actor_user_id: 'USR-FO-02'
    });
    tracked.transactions.push(expenseTx.id);

    assert.strictEqual(expenseTx.transaction_type, 'EXPENSE');
    assert.strictEqual(Number(expenseTx.net_amount), 150000);
    assert.strictEqual(expenseTx.payment_status, 'PAID', 'Immediate paid expense should have payment_status PAID');
    assert.strictEqual(expenseTx.verification_status, 'UNVERIFIED');
    console.log('[PASS] Operational expense creation with immediate payment verified');

    // 8. Non-Room Income Workflow (Customer Details & Payment)
    console.log('\n--- 8. Testing Non-Room Income Workflow ---');
    const incomeTx = await createIncomeTransaction(pool, {
      property_id: propertyId,
      transaction_date: '2026-08-30',
      category_code: customCatCode,
      category_name: 'Penyewaan Meeting Room & Proyektor',
      department_code: 'FNB',
      customer_name: 'Bpk. Hendra Gunawan (PT Techno Indo)',
      phone: '081377889900',
      description: 'Sewa Ruang Garuda + Proyektor 4 Jam',
      amount: 750000,
      payment_method: 'QRIS',
      source_reference: 'QRIS-GOPAY-112233',
      notes: 'Acara presentasi produk internal',
      actor_name: 'Banquet Sales',
      actor_user_id: 'USR-SALES-01'
    });
    tracked.transactions.push(incomeTx.id);

    assert.strictEqual(incomeTx.transaction_type, 'INCOME');
    assert.strictEqual(incomeTx.party_name, 'Bpk. Hendra Gunawan (PT Techno Indo)');
    assert.strictEqual(incomeTx.phone, '081377889900');
    assert.strictEqual(Number(incomeTx.net_amount), 750000);
    assert.strictEqual(incomeTx.payment_status, 'PAID');
    console.log('[PASS] Non-room income workflow verified');

    // 9. Query & Filter Verification
    console.log('\n--- 9. Testing Query & Filtering ---');
    const allTxs = await getTransactions(pool, { property_id: propertyId });
    assert.strictEqual(allTxs.total_count, 3, 'Should list exactly 3 transactions for test property');
    assert.strictEqual(Number(allTxs.summary.count_purchase), 1);
    assert.strictEqual(Number(allTxs.summary.count_expense), 1);
    assert.strictEqual(Number(allTxs.summary.count_income), 1);
    assert.strictEqual(Number(allTxs.summary.total_purchase), 97100);
    assert.strictEqual(Number(allTxs.summary.total_expense), 150000);
    assert.strictEqual(Number(allTxs.summary.total_income), 750000);

    // Filter by transaction_type
    const purchaseQuery = await getTransactions(pool, { property_id: propertyId, transaction_type: 'PURCHASE' });
    assert.strictEqual(purchaseQuery.total_count, 1);

    // Filter by supplier_id
    const supplierQuery = await getTransactions(pool, { property_id: propertyId, supplier_id: Number(sup1.id) });
    assert.strictEqual(supplierQuery.total_count, 2, 'Should match purchase and expense linked to supplier');
    console.log('[PASS] Querying and operational summaries verified');

    console.log('\n=== ALL TRANSACTION-2D INTEGRATION TESTS PASSED PERFECTLY ===\n');
  } finally {
    // 10. Clean up test records
    console.log('--- Cleaning Up Test Fixtures ---');
    for (const propId of tracked.properties) {
      await pool.query('DELETE FROM transaction_attachments WHERE property_id = $1', [propId]);
      await pool.query('DELETE FROM payment_transactions WHERE property_id = $1', [propId]);
      await pool.query('DELETE FROM transaction_lines WHERE property_id = $1', [propId]);
      await pool.query('DELETE FROM transactions WHERE property_id = $1', [propId]);
      await pool.query('DELETE FROM transaction_custom_categories WHERE property_id = $1', [propId]);
      await pool.query('DELETE FROM suppliers WHERE property_id = $1', [propId]);
      await pool.query('DELETE FROM audit_logs WHERE property_id = $1', [propId]);
      await pool.query('DELETE FROM properties WHERE id = $1', [propId]);
    }
    server.close();
    console.log('[CLEANUP] Zero session residue confirmed.');
  }
}

runTests()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('TEST SUITE FAILED:', err);
    process.exit(1);
  });

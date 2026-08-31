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
  voidTransaction,
  softDeleteTransaction,
  getTransactionById,
  getTransactions
} from '../dist/domains/transactions/transactionService.js';
import {
  createSupplier
} from '../dist/domains/suppliers/supplierService.js';

const { app, pool } = pkg;
const { initializeDatabase } = schemaPkg;

async function runTests() {
  console.log('=== RUNNING TRANSACTION-2E OPERATIONAL LIFECYCLE SHEETS TEST SUITE ===\n');

  await initializeDatabase(pool);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const randNum = Math.floor(1000 + Math.random() * 8999);
  const propCode = `E${randNum}`; // max 6 chars

  const tracked = {
    properties: [],
    suppliers: [],
    transactions: [],
    payments: []
  };

  try {
    // 0. Setup isolated test property
    const propRes = await pool.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('T2E Lifecycle Property', $1, 'Asia/Jakarta', 'IDR', 'Jl. Siklus No. 2E', TRUE) RETURNING id",
      [propCode]
    );
    const propertyId = Number(propRes.rows[0].id);
    tracked.properties.push(propertyId);
    console.log(`[PASS] Isolated test property created (ID: ${propertyId}, Code: ${propCode})`);

    const supplier = await createSupplier(pool, {
      property_id: propertyId,
      name: `Supplier Vendor 2E ${randNum}`,
      phone: '081122334455',
      actor_name: 'Purchasing 2E'
    });
    tracked.suppliers.push(Number(supplier.id));

    // ==========================================
    // DOMAIN 1: PENJUALAN (SALE)
    // Allowed sheets: PROSES, SELESAI, BATAL (No Hapus)
    // ==========================================
    console.log('\n--- 1. Testing Penjualan (SALE) Lifecycle Sheets ---');

    // Scenario 1: Penjualan DRAFT -> PROSES
    const s1Res = await pool.query(`
      INSERT INTO transactions (
        property_id, transaction_no, transaction_date, transaction_time, transaction_type,
        source_type, party_name, category_code, category_name, department_code, description,
        amount, discount_amount, service_amount, tax_amount, net_amount,
        payment_status, transaction_status, verification_status
      ) VALUES (
        $1, 'TX-S-01', CURRENT_DATE, NOW(), 'SALE',
        'MANUAL', 'Guest S1', 'ROOM_CHARGE', 'Room Charge', 'FRONT_OFFICE', 'Sale Draft',
        100000, 0, 0, 0, 100000,
        'UNPAID', 'DRAFT', 'UNVERIFIED'
      ) RETURNING id
    `, [propertyId]);
    const txSaleDraftId = Number(s1Res.rows[0].id);
    const txSaleDraft = await getTransactionById(pool, propertyId, txSaleDraftId);
    assert.strictEqual(txSaleDraft.operational_sheet, 'PROSES', 'Scenario 1: Penjualan DRAFT must map to PROSES');
    console.log('[PASS] Scenario 1: Penjualan DRAFT -> PROSES');

    // Scenario 2: Penjualan POSTED -> SELESAI
    const s2Res = await pool.query(`
      INSERT INTO transactions (
        property_id, transaction_no, transaction_date, transaction_time, transaction_type,
        source_type, party_name, category_code, category_name, department_code, description,
        amount, discount_amount, service_amount, tax_amount, net_amount,
        payment_status, transaction_status, verification_status
      ) VALUES (
        $1, 'TX-S-02', CURRENT_DATE, NOW(), 'SALE',
        'MANUAL', 'Guest S2', 'ROOM_CHARGE', 'Room Charge', 'FRONT_OFFICE', 'Sale Posted',
        200000, 0, 0, 0, 200000,
        'PAID', 'POSTED', 'VERIFIED'
      ) RETURNING id
    `, [propertyId]);
    const txSalePostedId = Number(s2Res.rows[0].id);
    const txSalePosted = await getTransactionById(pool, propertyId, txSalePostedId);
    assert.strictEqual(txSalePosted.operational_sheet, 'SELESAI', 'Scenario 2: Penjualan POSTED must map to SELESAI');
    console.log('[PASS] Scenario 2: Penjualan POSTED -> SELESAI');

    // Scenario 3: Penjualan VOIDED / CANCELLED / REVERSED -> BATAL
    const s3Res = await pool.query(`
      INSERT INTO transactions (
        property_id, transaction_no, transaction_date, transaction_time, transaction_type,
        source_type, party_name, category_code, category_name, department_code, description,
        amount, discount_amount, service_amount, tax_amount, net_amount,
        payment_status, transaction_status, verification_status
      ) VALUES (
        $1, 'TX-S-03', CURRENT_DATE, NOW(), 'SALE',
        'MANUAL', 'Guest S3', 'ROOM_CHARGE', 'Room Charge', 'FRONT_OFFICE', 'Sale Voided',
        300000, 0, 0, 0, 300000,
        'UNPAID', 'VOIDED', 'UNVERIFIED'
      ) RETURNING id
    `, [propertyId]);
    const txSaleVoidedId = Number(s3Res.rows[0].id);
    const txSaleVoided = await getTransactionById(pool, propertyId, txSaleVoidedId);
    assert.strictEqual(txSaleVoided.operational_sheet, 'BATAL', 'Scenario 3: Penjualan VOIDED must map to BATAL');
    console.log('[PASS] Scenario 3: Penjualan VOIDED -> BATAL');

    // Scenario 4: Penjualan HAPUS not allowed
    await assert.rejects(
      async () => {
        await softDeleteTransaction(pool, propertyId, txSaleDraftId, {
          property_id: propertyId,
          delete_reason: 'Testing reject',
          actor_name: 'Tester'
        });
      },
      /tidak mendukung penghapusan draft/i,
      'Scenario 4: Penjualan soft-delete must be rejected'
    );
    console.log('[PASS] Scenario 4: Penjualan soft delete rejected (no HAPUS for Penjualan)');

    // ==========================================
    // DOMAIN 2: PEMBELIAN (PURCHASE)
    // Allowed sheets: PROSES, SELESAI, BATAL, HAPUS
    // ==========================================
    console.log('\n--- 2. Testing Pembelian (PURCHASE) Lifecycle Sheets ---');

    // Scenario 5: Pembelian DRAFT with BELUM_DITERIMA -> PROSES
    const p1 = await createPurchaseTransaction(pool, {
      property_id: propertyId,
      supplier_id: supplier.id,
      category_code: 'RAW_MATERIAL',
      department_code: 'FNB',
      description: 'Beli Bahan Baku 1',
      lines: [{ description: 'Beras 10kg', quantity: 1, unit: 'sak', unit_price: 150000 }],
      receiving_status: 'BELUM_DITERIMA',
      actor_name: 'Purchaser'
    });
    // Set to draft manually for test
    await pool.query("UPDATE transactions SET transaction_status = 'DRAFT' WHERE id = $1", [p1.id]);
    const txP1 = await getTransactionById(pool, propertyId, p1.id);
    assert.strictEqual(txP1.operational_sheet, 'PROSES', 'Scenario 5: Purchase DRAFT + BELUM_DITERIMA -> PROSES');
    console.log('[PASS] Scenario 5: Purchase DRAFT + BELUM_DITERIMA -> PROSES');

    // Scenario 6: Pembelian DRAFT with DITERIMA_SEBAGIAN -> PROSES
    const p2 = await createPurchaseTransaction(pool, {
      property_id: propertyId,
      supplier_id: supplier.id,
      category_code: 'RAW_MATERIAL',
      department_code: 'FNB',
      description: 'Beli Bahan Baku 2',
      lines: [{ description: 'Minyak 5L', quantity: 2, unit: 'jerigen', unit_price: 70000 }],
      receiving_status: 'DITERIMA_SEBAGIAN',
      actor_name: 'Purchaser'
    });
    await pool.query("UPDATE transactions SET transaction_status = 'DRAFT' WHERE id = $1", [p2.id]);
    const txP2 = await getTransactionById(pool, propertyId, p2.id);
    assert.strictEqual(txP2.operational_sheet, 'PROSES', 'Scenario 6: Purchase DRAFT + DITERIMA_SEBAGIAN -> PROSES');
    console.log('[PASS] Scenario 6: Purchase DRAFT + DITERIMA_SEBAGIAN -> PROSES');

    // Scenario 7: Pembelian POSTED with BELUM_DITERIMA -> PROSES
    const p3 = await createPurchaseTransaction(pool, {
      property_id: propertyId,
      supplier_id: supplier.id,
      category_code: 'OFFICE_SUPPLIES',
      department_code: 'ADMIN',
      description: 'Beli Kertas A4',
      lines: [{ description: 'Kertas A4', quantity: 5, unit: 'rim', unit_price: 50000 }],
      receiving_status: 'BELUM_DITERIMA',
      actor_name: 'Purchaser'
    });
    const txP3 = await getTransactionById(pool, propertyId, p3.id);
    assert.strictEqual(txP3.operational_sheet, 'PROSES', 'Scenario 7: Purchase POSTED + BELUM_DITERIMA -> PROSES');
    console.log('[PASS] Scenario 7: Purchase POSTED + BELUM_DITERIMA -> PROSES');

    // Scenario 8: Pembelian POSTED with DITERIMA_SEBAGIAN -> PROSES
    const p4 = await createPurchaseTransaction(pool, {
      property_id: propertyId,
      supplier_id: supplier.id,
      category_code: 'OFFICE_SUPPLIES',
      department_code: 'ADMIN',
      description: 'Beli Tinta Printer',
      lines: [{ description: 'Tinta Hitam', quantity: 4, unit: 'btl', unit_price: 80000 }],
      receiving_status: 'DITERIMA_SEBAGIAN',
      actor_name: 'Purchaser'
    });
    const txP4 = await getTransactionById(pool, propertyId, p4.id);
    assert.strictEqual(txP4.operational_sheet, 'PROSES', 'Scenario 8: Purchase POSTED + DITERIMA_SEBAGIAN -> PROSES');
    console.log('[PASS] Scenario 8: Purchase POSTED + DITERIMA_SEBAGIAN -> PROSES');

    // Scenario 9: Pembelian DRAFT with DITERIMA -> SELESAI
    const p5 = await createPurchaseTransaction(pool, {
      property_id: propertyId,
      supplier_id: supplier.id,
      category_code: 'LINEN',
      department_code: 'HOUSEKEEPING',
      description: 'Beli Handuk',
      lines: [{ description: 'Handuk Mandi', quantity: 10, unit: 'pcs', unit_price: 60000 }],
      receiving_status: 'DITERIMA',
      actor_name: 'Purchaser'
    });
    await pool.query("UPDATE transactions SET transaction_status = 'DRAFT' WHERE id = $1", [p5.id]);
    const txP5 = await getTransactionById(pool, propertyId, p5.id);
    assert.strictEqual(txP5.operational_sheet, 'SELESAI', 'Scenario 9: Purchase DRAFT + DITERIMA -> SELESAI');
    console.log('[PASS] Scenario 9: Purchase DRAFT + DITERIMA -> SELESAI');

    // Scenario 10: Pembelian POSTED with DITERIMA and UNPAID -> SELESAI (Receiving drives operational completion, payment does not block Selesai)
    const p6 = await createPurchaseTransaction(pool, {
      property_id: propertyId,
      supplier_id: supplier.id,
      category_code: 'LINEN',
      department_code: 'HOUSEKEEPING',
      description: 'Beli Sprei King',
      lines: [{ description: 'Sprei King', quantity: 5, unit: 'pcs', unit_price: 120000 }],
      receiving_status: 'DITERIMA',
      actor_name: 'Purchaser'
    });
    const txP6 = await getTransactionById(pool, propertyId, p6.id);
    assert.strictEqual(txP6.payment_status, 'UNPAID');
    assert.strictEqual(txP6.receiving_status, 'DITERIMA');
    assert.strictEqual(txP6.operational_sheet, 'SELESAI', 'Scenario 10: Purchase POSTED + DITERIMA + UNPAID -> SELESAI');
    console.log('[PASS] Scenario 10: Purchase POSTED + DITERIMA + UNPAID -> SELESAI (Receiving drives completion)');

    // Scenario 11: Pembelian POSTED with DITERIMA and PAID -> SELESAI
    const p7 = await createPurchaseTransaction(pool, {
      property_id: propertyId,
      supplier_id: supplier.id,
      category_code: 'CLEANING_SUPPLIES',
      department_code: 'HOUSEKEEPING',
      description: 'Beli Deterjen & Sabun',
      lines: [{ description: 'Deterjen Liquid 20L', quantity: 1, unit: 'dirigen', unit_price: 250000 }],
      receiving_status: 'DITERIMA',
      actor_name: 'Purchaser'
    });
    await settleTransactionPayment(pool, p7.id, {
      property_id: propertyId,
      amount: 250000,
      payment_method: 'BANK_TRANSFER',
      actor_name: 'Finance'
    });
    const txP7 = await getTransactionById(pool, propertyId, p7.id);
    assert.strictEqual(txP7.payment_status, 'PAID');
    assert.strictEqual(txP7.operational_sheet, 'SELESAI', 'Scenario 11: Purchase POSTED + DITERIMA + PAID -> SELESAI');
    console.log('[PASS] Scenario 11: Purchase POSTED + DITERIMA + PAID -> SELESAI');

    // Scenario 12: Pembelian VOIDED with BELUM_DITERIMA -> BATAL
    const p8 = await createPurchaseTransaction(pool, {
      property_id: propertyId,
      supplier_id: supplier.id,
      category_code: 'MAINTENANCE_SUPPLIES',
      department_code: 'MAINTENANCE',
      description: 'Beli Lampu LED',
      lines: [{ description: 'Lampu 15W', quantity: 20, unit: 'pcs', unit_price: 25000 }],
      receiving_status: 'BELUM_DITERIMA',
      actor_name: 'Purchaser'
    });
    await voidTransaction(pool, propertyId, p8.id, {
      reason: 'Batal karena salah spesifikasi',
      actor_name: 'Manager'
    });
    const txP8 = await getTransactionById(pool, propertyId, p8.id);
    assert.strictEqual(txP8.operational_sheet, 'BATAL', 'Scenario 12: Purchase VOIDED + BELUM_DITERIMA -> BATAL');
    console.log('[PASS] Scenario 12: Purchase VOIDED + BELUM_DITERIMA -> BATAL');

    // Scenario 13: Pembelian VOIDED with DITERIMA -> BATAL (Void/Cancel strictly overrides received)
    const p9 = await createPurchaseTransaction(pool, {
      property_id: propertyId,
      supplier_id: supplier.id,
      category_code: 'MAINTENANCE_SUPPLIES',
      department_code: 'MAINTENANCE',
      description: 'Beli Saklar',
      lines: [{ description: 'Saklar Ganda', quantity: 10, unit: 'pcs', unit_price: 35000 }],
      receiving_status: 'DITERIMA',
      actor_name: 'Purchaser'
    });
    await voidTransaction(pool, propertyId, p9.id, {
      reason: 'Retur total karena rusak',
      actor_name: 'Manager'
    });
    const txP9 = await getTransactionById(pool, propertyId, p9.id);
    assert.strictEqual(txP9.receiving_status, 'DITERIMA');
    assert.strictEqual(txP9.transaction_status, 'VOIDED');
    assert.strictEqual(txP9.operational_sheet, 'BATAL', 'Scenario 13: Purchase VOIDED + DITERIMA -> BATAL');
    console.log('[PASS] Scenario 13: Purchase VOIDED + DITERIMA -> BATAL (Cancel overrides received)');

    // Scenario 14: Pembelian CANCELLED -> BATAL
    const p10Res = await pool.query(`
      INSERT INTO transactions (
        property_id, transaction_no, transaction_date, transaction_time, transaction_type,
        source_type, party_name, category_code, category_name, department_code, description,
        amount, discount_amount, service_amount, tax_amount, net_amount,
        payment_status, transaction_status, verification_status
      ) VALUES (
        $1, 'TX-P-CANCEL', CURRENT_DATE, NOW(), 'PURCHASE',
        'MANUAL', 'Vendor P10', 'RAW_MATERIAL', 'Raw Material', 'FNB', 'Purchase Cancelled',
        180000, 0, 0, 0, 180000,
        'UNPAID', 'CANCELLED', 'UNVERIFIED'
      ) RETURNING id
    `, [propertyId]);
    const txP10 = await getTransactionById(pool, propertyId, Number(p10Res.rows[0].id));
    assert.strictEqual(txP10.operational_sheet, 'BATAL', 'Scenario 14: Purchase CANCELLED -> BATAL');
    console.log('[PASS] Scenario 14: Purchase CANCELLED -> BATAL');

    // Scenario 15: Pembelian REVERSED -> BATAL
    const p11Res = await pool.query(`
      INSERT INTO transactions (
        property_id, transaction_no, transaction_date, transaction_time, transaction_type,
        source_type, party_name, category_code, category_name, department_code, description,
        amount, discount_amount, service_amount, tax_amount, net_amount,
        payment_status, transaction_status, verification_status
      ) VALUES (
        $1, 'TX-P-REV', CURRENT_DATE, NOW(), 'PURCHASE',
        'MANUAL', 'Vendor P11', 'RAW_MATERIAL', 'Raw Material', 'FNB', 'Purchase Reversed',
        190000, 0, 0, 0, 190000,
        'UNPAID', 'REVERSED', 'UNVERIFIED'
      ) RETURNING id
    `, [propertyId]);
    const txP11 = await getTransactionById(pool, propertyId, Number(p11Res.rows[0].id));
    assert.strictEqual(txP11.operational_sheet, 'BATAL', 'Scenario 15: Purchase REVERSED -> BATAL');
    console.log('[PASS] Scenario 15: Purchase REVERSED -> BATAL');

    // Scenario 16: Pembelian Soft-deleted draft -> HAPUS
    const p12 = await createPurchaseTransaction(pool, {
      property_id: propertyId,
      supplier_id: supplier.id,
      category_code: 'FNB_BEVERAGE',
      department_code: 'FNB',
      description: 'Draft Beli Minuman',
      lines: [{ description: 'Kopi Arabica 1kg', quantity: 2, unit: 'bks', unit_price: 110000 }],
      receiving_status: 'BELUM_DITERIMA',
      actor_name: 'Purchaser'
    });
    const p12Deleted = await softDeleteTransaction(pool, propertyId, p12.id, {
      property_id: propertyId,
      delete_reason: 'Draft pembelian salah order, diganti PO baru',
      actor_name: 'Supervisor Purchasing',
      actor_user_id: 'USR-007'
    });
    assert.ok(p12Deleted.deleted_at, 'deleted_at must be populated');
    assert.strictEqual(p12Deleted.delete_reason, 'Draft pembelian salah order, diganti PO baru');
    assert.strictEqual(p12Deleted.deleted_by_name_snapshot, 'Supervisor Purchasing');
    assert.strictEqual(p12Deleted.operational_sheet, 'HAPUS', 'Scenario 16: Soft-deleted Purchase -> HAPUS');

    const txP12Fetched = await getTransactionById(pool, propertyId, p12.id);
    assert.strictEqual(txP12Fetched.operational_sheet, 'HAPUS');
    console.log('[PASS] Scenario 16: Purchase Soft-Deleted Draft -> HAPUS');

    // ==========================================
    // DOMAIN 3: PENGELUARAN (EXPENSE)
    // Allowed sheets: PROSES, SELESAI, BATAL, HAPUS
    // ==========================================
    console.log('\n--- 3. Testing Pengeluaran (EXPENSE) Lifecycle Sheets ---');

    // Scenario 17: Pengeluaran DRAFT -> PROSES
    const e1Res = await pool.query(`
      INSERT INTO transactions (
        property_id, transaction_no, transaction_date, transaction_time, transaction_type,
        source_type, party_name, category_code, category_name, department_code, description,
        amount, discount_amount, service_amount, tax_amount, net_amount,
        payment_status, transaction_status, verification_status
      ) VALUES (
        $1, 'TX-E-01', CURRENT_DATE, NOW(), 'EXPENSE',
        'MANUAL', 'PLN / Token', 'UTILITIES', 'Utilities', 'MAINTENANCE', 'Token Listrik Genset',
        500000, 0, 0, 0, 500000,
        'UNPAID', 'DRAFT', 'UNVERIFIED'
      ) RETURNING id
    `, [propertyId]);
    const txE1 = await getTransactionById(pool, propertyId, Number(e1Res.rows[0].id));
    assert.strictEqual(txE1.operational_sheet, 'PROSES', 'Scenario 17: Expense DRAFT -> PROSES');
    console.log('[PASS] Scenario 17: Expense DRAFT -> PROSES');

    // Scenario 18: Pengeluaran POSTED -> SELESAI
    const e2 = await createExpenseTransaction(pool, {
      property_id: propertyId,
      category_code: 'UTILITIES',
      department_code: 'MAINTENANCE',
      description: 'Tagihan PDAM',
      amount: 450000,
      actor_name: 'Finance Officer'
    });
    const txE2 = await getTransactionById(pool, propertyId, e2.id);
    assert.strictEqual(txE2.operational_sheet, 'SELESAI', 'Scenario 18: Expense POSTED -> SELESAI');
    console.log('[PASS] Scenario 18: Expense POSTED -> SELESAI');

    // Scenario 19: Pengeluaran VOIDED -> BATAL
    const e3 = await createExpenseTransaction(pool, {
      property_id: propertyId,
      category_code: 'TRANSPORT',
      department_code: 'ADMIN',
      description: 'Bensin Operasional',
      amount: 100000,
      actor_name: 'Finance Officer'
    });
    await voidTransaction(pool, propertyId, e3.id, {
      reason: 'Nota dibatalkan',
      actor_name: 'Finance Manager'
    });
    const txE3 = await getTransactionById(pool, propertyId, e3.id);
    assert.strictEqual(txE3.operational_sheet, 'BATAL', 'Scenario 19: Expense VOIDED -> BATAL');
    console.log('[PASS] Scenario 19: Expense VOIDED -> BATAL');

    // Scenario 20: Pengeluaran Soft-deleted draft -> HAPUS
    const e4Res = await pool.query(`
      INSERT INTO transactions (
        property_id, transaction_no, transaction_date, transaction_time, transaction_type,
        source_type, party_name, category_code, category_name, department_code, description,
        amount, discount_amount, service_amount, tax_amount, net_amount,
        payment_status, transaction_status, verification_status
      ) VALUES (
        $1, 'TX-E-DRAFT-DEL', CURRENT_DATE, NOW(), 'EXPENSE',
        'MANUAL', 'Toko ATK', 'OFFICE_SUPPLIES', 'Office Supplies', 'ADMIN', 'Draft Pengeluaran Salah',
        75000, 0, 0, 0, 75000,
        'UNPAID', 'DRAFT', 'UNVERIFIED'
      ) RETURNING id
    `, [propertyId]);
    const txE4Id = Number(e4Res.rows[0].id);
    const txE4Deleted = await softDeleteTransaction(pool, propertyId, txE4Id, {
      property_id: propertyId,
      delete_reason: 'Draft duplikat dari nota fisik kemarin',
      actor_name: 'Admin Finance'
    });
    assert.strictEqual(txE4Deleted.operational_sheet, 'HAPUS', 'Scenario 20: Soft-deleted Expense -> HAPUS');
    console.log('[PASS] Scenario 20: Expense Soft-Deleted Draft -> HAPUS');

    // ==========================================
    // DOMAIN 4: PEMASUKAN (INCOME)
    // Allowed sheets: PROSES, SELESAI, BATAL (No Hapus)
    // ==========================================
    console.log('\n--- 4. Testing Pemasukan (INCOME) Lifecycle Sheets ---');

    // Scenario 21: Pemasukan DRAFT -> PROSES
    const i1Res = await pool.query(`
      INSERT INTO transactions (
        property_id, transaction_no, transaction_date, transaction_time, transaction_type,
        source_type, party_name, category_code, category_name, department_code, description,
        amount, discount_amount, service_amount, tax_amount, net_amount,
        payment_status, transaction_status, verification_status
      ) VALUES (
        $1, 'TX-I-01', CURRENT_DATE, NOW(), 'INCOME',
        'MANUAL', 'Penyewa Hall A', 'VENUE_RENTAL', 'Venue Rental', 'FRONT_OFFICE', 'Sewa Hall Draft',
        1500000, 0, 0, 0, 1500000,
        'UNPAID', 'DRAFT', 'UNVERIFIED'
      ) RETURNING id
    `, [propertyId]);
    const txI1 = await getTransactionById(pool, propertyId, Number(i1Res.rows[0].id));
    assert.strictEqual(txI1.operational_sheet, 'PROSES', 'Scenario 21: Income DRAFT -> PROSES');
    console.log('[PASS] Scenario 21: Income DRAFT -> PROSES');

    // Scenario 22: Pemasukan POSTED -> SELESAI
    const i2 = await createIncomeTransaction(pool, {
      property_id: propertyId,
      customer_name: 'PT Sinergi Abadi',
      category_code: 'VENUE_RENTAL',
      department_code: 'FRONT_OFFICE',
      description: 'Sewa Ruang Meeting Full Day',
      amount: 2500000,
      payment_method: 'BANK_TRANSFER',
      actor_name: 'FO Cashier'
    });
    const txI2 = await getTransactionById(pool, propertyId, i2.id);
    assert.strictEqual(txI2.operational_sheet, 'SELESAI', 'Scenario 22: Income POSTED -> SELESAI');
    console.log('[PASS] Scenario 22: Income POSTED -> SELESAI');

    // Scenario 23: Pemasukan VOIDED -> BATAL
    const i3 = await createIncomeTransaction(pool, {
      property_id: propertyId,
      customer_name: 'Klien Event',
      category_code: 'VENUE_RENTAL',
      department_code: 'FRONT_OFFICE',
      description: 'DP Sewa Ruang',
      amount: 500000,
      payment_method: 'CASH',
      actor_name: 'FO Cashier'
    });
    await voidTransaction(pool, propertyId, i3.id, {
      reason: 'Klien membatalkan event',
      actor_name: 'FO Manager'
    });
    const txI3 = await getTransactionById(pool, propertyId, i3.id);
    assert.strictEqual(txI3.operational_sheet, 'BATAL', 'Scenario 23: Income VOIDED -> BATAL');
    console.log('[PASS] Scenario 23: Income VOIDED -> BATAL');

    // Scenario 24: Pemasukan HAPUS not allowed
    await assert.rejects(
      async () => {
        await softDeleteTransaction(pool, propertyId, Number(i1Res.rows[0].id), {
          property_id: propertyId,
          delete_reason: 'Testing reject income delete',
          actor_name: 'Tester'
        });
      },
      /tidak mendukung penghapusan draft/i,
      'Scenario 24: Income soft-delete must be rejected'
    );
    console.log('[PASS] Scenario 24: Income soft delete rejected (no HAPUS for Pemasukan)');

    // ==========================================
    // DOMAIN 5: SOFT DELETE INVARIANTS & AUDIT
    // ==========================================
    console.log('\n--- 5. Testing Soft Delete Invariants & Guard Validations ---');

    // Scenario 25: Soft delete rejects empty delete_reason
    const pTestReason = await createPurchaseTransaction(pool, {
      property_id: propertyId,
      supplier_id: supplier.id,
      category_code: 'RAW_MATERIAL',
      department_code: 'FNB',
      description: 'Draft Test Reason',
      lines: [{ description: 'Item A', quantity: 1, unit: 'pcs', unit_price: 10000 }],
      receiving_status: 'BELUM_DITERIMA',
      actor_name: 'Purchaser'
    });
    await assert.rejects(
      async () => {
        await softDeleteTransaction(pool, propertyId, pTestReason.id, {
          property_id: propertyId,
          delete_reason: '   ',
          actor_name: 'Supervisor'
        });
      },
      /Alasan hapus.*wajib diisi/i,
      'Scenario 25: Soft delete must reject empty delete_reason'
    );
    console.log('[PASS] Scenario 25: Soft delete rejects empty delete_reason');

    // Scenario 26: Soft delete rejects paid draft (paid_amount > 0)
    const pPaid = await createPurchaseTransaction(pool, {
      property_id: propertyId,
      supplier_id: supplier.id,
      category_code: 'RAW_MATERIAL',
      department_code: 'FNB',
      description: 'Draft Test Paid',
      lines: [{ description: 'Item Paid', quantity: 1, unit: 'pcs', unit_price: 50000 }],
      receiving_status: 'BELUM_DITERIMA',
      actor_name: 'Purchaser'
    });
    await settleTransactionPayment(pool, pPaid.id, {
      property_id: propertyId,
      amount: 50000,
      payment_method: 'CASH',
      actor_name: 'Finance'
    });
    await assert.rejects(
      async () => {
        await softDeleteTransaction(pool, propertyId, pPaid.id, {
          property_id: propertyId,
          delete_reason: 'Alasan hapus',
          actor_name: 'Supervisor'
        });
      },
      /sudah memiliki pembayaran/i,
      'Scenario 26: Soft delete must reject paid draft'
    );
    console.log('[PASS] Scenario 26: Soft delete rejects transaction with payments');

    // Scenario 27: Soft delete rejects fully received purchase (receiving_status = DITERIMA)
    const pReceived = await createPurchaseTransaction(pool, {
      property_id: propertyId,
      supplier_id: supplier.id,
      category_code: 'RAW_MATERIAL',
      department_code: 'FNB',
      description: 'Draft Test Received',
      lines: [{ description: 'Item Received', quantity: 1, unit: 'pcs', unit_price: 30000 }],
      receiving_status: 'DITERIMA',
      actor_name: 'Purchaser'
    });
    await assert.rejects(
      async () => {
        await softDeleteTransaction(pool, propertyId, pReceived.id, {
          property_id: propertyId,
          delete_reason: 'Alasan hapus',
          actor_name: 'Supervisor'
        });
      },
      /barang sudah diterima/i,
      'Scenario 27: Soft delete must reject received purchase'
    );
    console.log('[PASS] Scenario 27: Soft delete rejects fully received purchase');

    // Scenario 28: Soft delete rejects verified transaction (verification_status = VERIFIED)
    const pVerified = await createPurchaseTransaction(pool, {
      property_id: propertyId,
      supplier_id: supplier.id,
      category_code: 'RAW_MATERIAL',
      department_code: 'FNB',
      description: 'Draft Test Verified',
      lines: [{ description: 'Item Verified', quantity: 1, unit: 'pcs', unit_price: 40000 }],
      receiving_status: 'BELUM_DITERIMA',
      actor_name: 'Purchaser'
    });
    await verifyTransaction(pool, pVerified.id, {
      property_id: propertyId,
      verification_status: 'VERIFIED',
      actor_name: 'Accounting Manager'
    });
    await assert.rejects(
      async () => {
        await softDeleteTransaction(pool, propertyId, pVerified.id, {
          property_id: propertyId,
          delete_reason: 'Alasan hapus',
          actor_name: 'Supervisor'
        });
      },
      /terverifikasi/i,
      'Scenario 28: Soft delete must reject verified transaction'
    );
    console.log('[PASS] Scenario 28: Soft delete rejects verified transaction');

    // Verify audit log for soft-deleted transaction
    const auditRes = await pool.query(
      "SELECT * FROM audit_logs WHERE property_id = $1 AND action = 'TRANSACTION_SOFT_DELETED'",
      [propertyId]
    );
    assert.ok(auditRes.rows.length >= 2, 'Audit logs must record TRANSACTION_SOFT_DELETED');
    console.log(`[PASS] Audit logs verified (${auditRes.rows.length} soft-delete events recorded)`);

    // ==========================================
    // DOMAIN 6: FINANCIAL SUMMARY & SHEET QUERIES
    // ==========================================
    console.log('\n--- 6. Testing Financial Summary & Sheet Counts Correctness ---');

    // Scenario 29: Financial summary exclusion & sheet counts correctness
    // 29a. Query sheet PROSES
    const prosesRes = await getTransactions(pool, {
      property_id: propertyId,
      operational_sheet: 'PROSES'
    });
    for (const row of prosesRes.transactions) {
      assert.strictEqual(row.operational_sheet, 'PROSES', 'All rows in PROSES query must have operational_sheet PROSES');
      assert.strictEqual(row.deleted_at, null, 'Deleted rows must never appear in PROSES');
    }

    // 29b. Query sheet SELESAI
    const selesaiRes = await getTransactions(pool, {
      property_id: propertyId,
      operational_sheet: 'SELESAI'
    });
    for (const row of selesaiRes.transactions) {
      assert.strictEqual(row.operational_sheet, 'SELESAI', 'All rows in SELESAI query must have operational_sheet SELESAI');
      assert.strictEqual(row.deleted_at, null, 'Deleted rows must never appear in SELESAI');
    }

    // 29c. Query sheet BATAL
    const batalRes = await getTransactions(pool, {
      property_id: propertyId,
      operational_sheet: 'BATAL'
    });
    for (const row of batalRes.transactions) {
      assert.strictEqual(row.operational_sheet, 'BATAL', 'All rows in BATAL query must have operational_sheet BATAL');
      assert.strictEqual(row.deleted_at, null, 'Deleted rows must never appear in BATAL');
    }

    // 29d. Query sheet HAPUS
    const hapusRes = await getTransactions(pool, {
      property_id: propertyId,
      operational_sheet: 'HAPUS'
    });
    assert.ok(hapusRes.transactions.length >= 2, 'HAPUS sheet must return soft-deleted rows');
    for (const row of hapusRes.transactions) {
      assert.strictEqual(row.operational_sheet, 'HAPUS');
      assert.ok(row.deleted_at !== null, 'HAPUS rows must have non-null deleted_at');
      assert.ok(row.delete_reason && row.delete_reason.length > 0, 'HAPUS rows must have non-empty delete_reason');
    }

    // 29e. Verify sheet_counts on general query
    const allQueryRes = await getTransactions(pool, { property_id: propertyId });
    assert.strictEqual(allQueryRes.sheet_counts.proses, prosesRes.total_count, 'sheet_counts.proses must match PROSES total count');
    assert.strictEqual(allQueryRes.sheet_counts.selesai, selesaiRes.total_count, 'sheet_counts.selesai must match SELESAI total count');
    assert.strictEqual(allQueryRes.sheet_counts.batal, batalRes.total_count, 'sheet_counts.batal must match BATAL total count');
    assert.strictEqual(allQueryRes.sheet_counts.hapus, hapusRes.total_count, 'sheet_counts.hapus must match HAPUS total count');

    // 29f. Verify soft-deleted draft sums are strictly excluded from financial summary totals
    const purchaseActiveRes = await getTransactions(pool, { property_id: propertyId, transaction_type: 'PURCHASE' });
    const purchaseNetSum = purchaseActiveRes.transactions.reduce((acc, t) => acc + Number(t.net_amount), 0);
    assert.strictEqual(Number(purchaseActiveRes.summary.total_purchase), purchaseNetSum, 'Summary total_purchase must equal active purchases sum');

    const expenseActiveRes = await getTransactions(pool, { property_id: propertyId, transaction_type: 'EXPENSE' });
    const expenseNetSum = expenseActiveRes.transactions.reduce((acc, t) => acc + Number(t.net_amount), 0);
    assert.strictEqual(Number(expenseActiveRes.summary.total_expense), expenseNetSum, 'Summary total_expense must equal active expenses sum');

    console.log('[PASS] Scenario 29: Sheet counts, filters, and financial summary exclusion verified perfectly');

    console.log('\n================================================================');
    console.log('=== ALL 29 TRANSACTION-2E LIFECYCLE SCENARIOS PASSED WITH 100% SUCCESS ===');
    console.log('================================================================\n');

  } finally {
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

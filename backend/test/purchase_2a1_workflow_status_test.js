'use strict';

/**
 * PURCHASE-2A1 — Canonical purchase_workflow_status foundation.
 * Schema, backfill, create default, sheet derivation + list SQL parity.
 * Does NOT implement lifecycle mutation API (2A2).
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const assert = require('node:assert/strict');
const { pool } = require('../dist/index');
const { initializeDatabase } = require('../dist/db/schema_v3');
const {
  createPurchaseTransaction,
  createExpenseTransaction,
  updatePurchaseReceivingStatus,
  voidTransaction,
  softDeleteTransaction,
  getTransactionById,
  getTransactions,
  deriveOperationalSheet,
  resolvePurchaseWorkflowStatus
} = require('../dist/domains/transactions/transactionService');
const { createSupplier } = require('../dist/domains/suppliers/supplierService');
const { PURCHASE_WORKFLOW_SHEET_SQL } = require('../dist/domains/transactions/transactionTypes');

let passed = 0;
function pass(msg) {
  passed += 1;
  console.log(`  [PASS] ${msg}`);
}

async function run() {
  console.log('=== PURCHASE-2A1 WORKFLOW STATUS FOUNDATION ===\n');
  await initializeDatabase(pool);

  const runId = `${Date.now()}_${process.pid}`;
  const tracked = { properties: [], suppliers: [], transactions: [] };

  try {
    const propRes = await pool.query(
      `INSERT INTO properties (name, address, phone, property_code, timezone, currency, is_active)
       VALUES ($1, 'A', '0800', $2, 'Asia/Jakarta', 'IDR', TRUE) RETURNING id`,
      [`P2A1 Prop ${runId}`, `P${Math.floor(10000 + Math.random() * 90000)}`]
    );
    const propertyId = Number(propRes.rows[0].id);
    tracked.properties.push(propertyId);

    await pool.query(
      `INSERT INTO transaction_custom_categories (
         property_id, code, name, transaction_type, department_code, is_active
       ) VALUES
         ($1, 'RAW_MATERIAL', 'Raw Material', 'PURCHASE', 'FNB', TRUE),
         ($1, 'OFFICE_SUPPLIES', 'Office Supplies', 'PURCHASE', 'ADMIN', TRUE)
       ON CONFLICT (property_id, code) DO NOTHING`,
      [propertyId]
    );

    const supplier = await createSupplier(pool, {
      property_id: propertyId,
      name: `Vendor 2A1 ${runId}`,
      phone: '081200000001',
      actor_name: 'P2A1'
    });
    tracked.suppliers.push(Number(supplier.id));

    // A. Schema column exists
    const col = await pool.query(
      `SELECT data_type, character_maximum_length
       FROM information_schema.columns
       WHERE table_name = 'transactions' AND column_name = 'purchase_workflow_status'`
    );
    assert.ok(col.rowCount === 1, 'purchase_workflow_status column missing');
    assert.strictEqual(col.rows[0].data_type, 'character varying');
    pass('A. schema column purchase_workflow_status exists');

    const chk = await pool.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'chk_transactions_purchase_workflow_status'`
    );
    assert.ok((chk.rowCount ?? 0) === 1, 'CHECK constraint missing');
    pass('A. CHECK constraint chk_transactions_purchase_workflow_status exists');

    // B/C. Allowed PROSES / SELESAI
    const allowed = await pool.query(
      `INSERT INTO transactions (
         property_id, transaction_no, transaction_date, transaction_time,
         transaction_type, source_type, category_code, category_name, description,
         amount, net_amount, payment_status, transaction_status,
         receiving_status, verification_status, purchase_workflow_status
       ) VALUES
         ($1, $2, CURRENT_DATE, NOW(), 'PURCHASE', 'MANUAL_PURCHASE', 'RAW_MATERIAL', 'Raw Material', 'wf proses',
          1000, 1000, 'UNPAID', 'POSTED', 'BELUM_DITERIMA', 'UNVERIFIED', 'PROSES'),
         ($1, $3, CURRENT_DATE, NOW(), 'PURCHASE', 'MANUAL_PURCHASE', 'RAW_MATERIAL', 'Raw Material', 'wf selesai',
          2000, 2000, 'UNPAID', 'POSTED', 'DITERIMA', 'UNVERIFIED', 'SELESAI')
       RETURNING id, purchase_workflow_status`,
      [propertyId, `P2A1-PR-${runId}`, `P2A1-SL-${runId}`]
    );
    tracked.transactions.push(...allowed.rows.map((r) => Number(r.id)));
    assert.strictEqual(allowed.rows[0].purchase_workflow_status, 'PROSES');
    assert.strictEqual(allowed.rows[1].purchase_workflow_status, 'SELESAI');
    pass('B/C. allowed PROSES and SELESAI values persist');

    // D. Invalid workflow rejected by CHECK
    await assert.rejects(
      () => pool.query(
        `INSERT INTO transactions (
           property_id, transaction_no, transaction_date, transaction_time,
           transaction_type, source_type, category_code, category_name, description,
           amount, net_amount, payment_status, transaction_status,
           verification_status, purchase_workflow_status
         ) VALUES (
           $1, $2, CURRENT_DATE, NOW(), 'PURCHASE', 'MANUAL_PURCHASE', 'RAW_MATERIAL', 'Raw Material', 'bad',
           1, 1, 'UNPAID', 'POSTED', 'UNVERIFIED', 'BATAL'
         )`,
        [propertyId, `P2A1-BAD-${runId}`]
      ),
      /check|chk_transactions_purchase_workflow_status/i
    );
    pass('D. invalid workflow BATAL rejected by CHECK');

    // E. non-purchase remains NULL
    const expense = await createExpenseTransaction(pool, {
      property_id: propertyId,
      category_code: 'UTILITIES_EXPENSE',
      department_code: 'ADMIN',
      description: 'Listrik 2A1',
      amount: 50000,
      is_paid: true,
      payment_method: 'CASH',
      actor_name: 'P2A1'
    });
    tracked.transactions.push(Number(expense.id));
    assert.strictEqual(expense.purchase_workflow_status ?? null, null);
    const expenseDb = await pool.query(
      'SELECT purchase_workflow_status FROM transactions WHERE id = $1',
      [expense.id]
    );
    assert.strictEqual(expenseDb.rows[0].purchase_workflow_status, null);
    pass('E. non-purchase remains NULL');

    // BACKFILL F–J: insert NULL workflow rows mimicking pre-migration purchases, then re-run NULL-only backfill
    const legacy = await pool.query(
      `INSERT INTO transactions (
         property_id, transaction_no, transaction_date, transaction_time,
         transaction_type, source_type, category_code, category_name, description,
         amount, net_amount, payment_status, transaction_status,
         receiving_status, verification_status, purchase_workflow_status
       ) VALUES
         ($1, $2, CURRENT_DATE, NOW(), 'PURCHASE', 'MANUAL_PURCHASE', 'RAW_MATERIAL', 'Raw Material', 'legacy belum',
          10, 10, 'UNPAID', 'POSTED', 'BELUM_DITERIMA', 'VERIFIED', NULL),
         ($1, $3, CURRENT_DATE, NOW(), 'PURCHASE', 'MANUAL_PURCHASE', 'RAW_MATERIAL', 'Raw Material', 'legacy partial',
          20, 20, 'UNPAID', 'POSTED', 'DITERIMA_SEBAGIAN', 'UNVERIFIED', NULL),
         ($1, $4, CURRENT_DATE, NOW(), 'PURCHASE', 'MANUAL_PURCHASE', 'RAW_MATERIAL', 'Raw Material', 'legacy diterima',
          30, 30, 'UNPAID', 'POSTED', 'DITERIMA', 'UNVERIFIED', NULL),
         ($1, $5, CURRENT_DATE, NOW(), 'PURCHASE', 'MANUAL_PURCHASE', 'RAW_MATERIAL', 'Raw Material', 'legacy lengkap',
          40, 40, 'UNPAID', 'POSTED', 'DITERIMA_LENGKAP', 'UNVERIFIED', NULL)
       RETURNING id, receiving_status, verification_status`,
      [
        propertyId,
        `P2A1-L1-${runId}`,
        `P2A1-L2-${runId}`,
        `P2A1-L3-${runId}`,
        `P2A1-L4-${runId}`
      ]
    );
    tracked.transactions.push(...legacy.rows.map((r) => Number(r.id)));

    await pool.query(`
      UPDATE transactions
      SET purchase_workflow_status = CASE
        WHEN UPPER(COALESCE(receiving_status, '')) IN ('DITERIMA', 'DITERIMA_LENGKAP') THEN 'SELESAI'
        ELSE 'PROSES'
      END
      WHERE transaction_type = 'PURCHASE'
        AND purchase_workflow_status IS NULL
        AND property_id = $1
    `, [propertyId]);

    const legacyStates = await pool.query(
      `SELECT transaction_no, receiving_status, verification_status, purchase_workflow_status
       FROM transactions WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [legacy.rows.map((r) => r.id)]
    );
    const byNo = Object.fromEntries(legacyStates.rows.map((r) => [r.transaction_no, r]));
    assert.strictEqual(byNo[`P2A1-L1-${runId}`].purchase_workflow_status, 'PROSES');
    pass('F. BELUM_DITERIMA backfill => PROSES');
    assert.strictEqual(byNo[`P2A1-L2-${runId}`].purchase_workflow_status, 'PROSES');
    pass('G. DITERIMA_SEBAGIAN backfill => PROSES');
    assert.strictEqual(byNo[`P2A1-L3-${runId}`].purchase_workflow_status, 'SELESAI');
    pass('H. DITERIMA backfill => SELESAI');
    assert.strictEqual(byNo[`P2A1-L4-${runId}`].purchase_workflow_status, 'SELESAI');
    pass('I. DITERIMA_LENGKAP backfill => SELESAI');
    assert.strictEqual(byNo[`P2A1-L1-${runId}`].verification_status, 'VERIFIED');
    assert.strictEqual(byNo[`P2A1-L1-${runId}`].purchase_workflow_status, 'PROSES');
    pass('J. verification alone does not determine migration status');

    // Manual SELESAI must not be overwritten by NULL-only backfill re-run
    const protectId = allowed.rows[1].id;
    await pool.query(`
      UPDATE transactions
      SET purchase_workflow_status = CASE
        WHEN UPPER(COALESCE(receiving_status, '')) IN ('DITERIMA', 'DITERIMA_LENGKAP') THEN 'SELESAI'
        ELSE 'PROSES'
      END
      WHERE transaction_type = 'PURCHASE'
        AND purchase_workflow_status IS NULL
        AND property_id = $1
    `, [propertyId]);
    const protectedRow = await pool.query(
      'SELECT purchase_workflow_status FROM transactions WHERE id = $1',
      [protectId]
    );
    assert.strictEqual(protectedRow.rows[0].purchase_workflow_status, 'SELESAI');
    pass('idempotent backfill does not overwrite set workflow values');

    // K. new normal Purchase => PROSES
    const created = await createPurchaseTransaction(pool, {
      property_id: propertyId,
      supplier_id: supplier.id,
      category_code: 'RAW_MATERIAL',
      department_code: 'FNB',
      description: 'Create default workflow',
      lines: [{ description: 'Item A', quantity: 1, unit: 'pcs', unit_price: 15000 }],
      receiving_status: 'DITERIMA',
      actor_name: 'P2A1'
    });
    tracked.transactions.push(Number(created.id));
    assert.strictEqual(created.purchase_workflow_status, 'PROSES');
    assert.strictEqual(created.receiving_status, 'DITERIMA');
    assert.strictEqual(created.operational_sheet, 'PROSES');
    pass('K. new normal Purchase => PROSES even when receiving DITERIMA');

    // L/M sheet from workflow
    assert.strictEqual(
      deriveOperationalSheet({
        transaction_type: 'PURCHASE',
        transaction_status: 'POSTED',
        purchase_workflow_status: 'PROSES',
        receiving_status: 'DITERIMA'
      }),
      'PROSES'
    );
    pass('L. PROSES workflow => PROSES sheet (receiving ignored)');
    assert.strictEqual(
      deriveOperationalSheet({
        transaction_type: 'PURCHASE',
        transaction_status: 'POSTED',
        purchase_workflow_status: 'SELESAI',
        receiving_status: 'BELUM_DITERIMA'
      }),
      'SELESAI'
    );
    pass('M. SELESAI workflow => SELESAI sheet');

    // N/O void precedence
    assert.strictEqual(
      deriveOperationalSheet({
        transaction_type: 'PURCHASE',
        transaction_status: 'VOIDED',
        purchase_workflow_status: 'SELESAI'
      }),
      'BATAL'
    );
    pass('N. VOIDED wins => BATAL');
    assert.strictEqual(
      deriveOperationalSheet({
        transaction_type: 'PURCHASE',
        transaction_status: 'REVERSED',
        purchase_workflow_status: 'SELESAI'
      }),
      'BATAL'
    );
    pass('O. REVERSED wins => BATAL');

    // P. deleted wins
    assert.strictEqual(
      deriveOperationalSheet({
        transaction_type: 'PURCHASE',
        transaction_status: 'POSTED',
        purchase_workflow_status: 'SELESAI',
        deleted_at: new Date().toISOString()
      }),
      'HAPUS'
    );
    pass('P. deleted wins => HAPUS');

    // Q. NULL fail-safe
    assert.strictEqual(resolvePurchaseWorkflowStatus(null), 'PROSES');
    assert.strictEqual(
      deriveOperationalSheet({
        transaction_type: 'PURCHASE',
        transaction_status: 'POSTED',
        purchase_workflow_status: null,
        receiving_status: 'DITERIMA'
      }),
      'PROSES'
    );
    pass('Q. NULL workflow fail-safe => PROSES');

    // R/S list parity + sheet_counts
    const selesaiId = Number(allowed.rows[1].id);
    const prosesCreateId = Number(created.id);
    const listAll = await getTransactions(pool, {
      property_id: propertyId,
      transaction_type: 'PURCHASE'
    });
    const byId = Object.fromEntries(listAll.transactions.map((t) => [Number(t.id), t]));
    assert.strictEqual(byId[selesaiId].operational_sheet, 'SELESAI');
    assert.strictEqual(byId[prosesCreateId].operational_sheet, 'PROSES');

    const listSelesai = await getTransactions(pool, {
      property_id: propertyId,
      transaction_type: 'PURCHASE',
      operational_sheet: 'SELESAI'
    });
    assert.ok(listSelesai.transactions.every((t) => t.operational_sheet === 'SELESAI'));
    assert.ok(listSelesai.transactions.some((t) => Number(t.id) === selesaiId));
    assert.ok(!listSelesai.transactions.some((t) => Number(t.id) === prosesCreateId));
    pass('R. operational_sheet filter matches derived operational_sheet');

    assert.strictEqual(listAll.sheet_counts.selesai, listSelesai.total_count);
    const listProses = await getTransactions(pool, {
      property_id: propertyId,
      transaction_type: 'PURCHASE',
      operational_sheet: 'PROSES'
    });
    assert.strictEqual(listAll.sheet_counts.proses, listProses.total_count);
    pass('S. sheet_counts use new workflow semantics');

    assert.ok(
      String(PURCHASE_WORKFLOW_SHEET_SQL).includes('purchase_workflow_status'),
      'shared SQL fragment must reference purchase_workflow_status'
    );
    assert.ok(!String(PURCHASE_WORKFLOW_SHEET_SQL).includes("receiving_status"), 'shared SQL must not use receiving for sheet');

    // T/U receiving decoupling
    const beforeStatus = created.transaction_status;
    const beforePayment = created.payment_status;
    const afterRecv = await updatePurchaseReceivingStatus(pool, created.id, {
      property_id: propertyId,
      receiving_status: 'DITERIMA',
      actor_name: 'P2A1'
    });
    assert.strictEqual(afterRecv.receiving_status, 'DITERIMA');
    assert.strictEqual(afterRecv.purchase_workflow_status, 'PROSES');
    assert.strictEqual(afterRecv.operational_sheet, 'PROSES');
    assert.strictEqual(afterRecv.transaction_status, beforeStatus);
    assert.strictEqual(afterRecv.payment_status, beforePayment);
    pass('T. changing receiving to DITERIMA alone does not move sheet');

    const partial = await updatePurchaseReceivingStatus(pool, created.id, {
      property_id: propertyId,
      receiving_status: 'DITERIMA_SEBAGIAN',
      actor_name: 'P2A1'
    });
    assert.strictEqual(partial.receiving_status, 'DITERIMA_SEBAGIAN');
    assert.strictEqual(partial.purchase_workflow_status, 'PROSES');
    assert.strictEqual(partial.operational_sheet, 'PROSES');
    pass('U. DITERIMA_SEBAGIAN remains preserved and stays PROSES sheet');

    // V. financial safety of workflow column (direct SQL set, no 2A2 API)
    await pool.query(
      `UPDATE transactions
       SET purchase_workflow_status = 'SELESAI'
       WHERE id = $1 AND property_id = $2`,
      [created.id, propertyId]
    );
    const afterWf = await getTransactionById(pool, propertyId, created.id);
    assert.strictEqual(afterWf.purchase_workflow_status, 'SELESAI');
    assert.strictEqual(afterWf.operational_sheet, 'SELESAI');
    assert.strictEqual(afterWf.transaction_status, 'POSTED');
    assert.strictEqual(afterWf.payment_status, 'UNPAID');
    assert.strictEqual(afterWf.receiving_status, 'DITERIMA_SEBAGIAN');
    pass('V. workflow change does not alter transaction_status/payment/receiving');

    // Live void precedence with SELESAI workflow
    const voidTarget = await createPurchaseTransaction(pool, {
      property_id: propertyId,
      supplier_id: supplier.id,
      category_code: 'OFFICE_SUPPLIES',
      department_code: 'ADMIN',
      description: 'Void precedence',
      lines: [{ description: 'Kertas A4', quantity: 1, unit: 'rim', unit_price: 45000 }],
      receiving_status: 'BELUM_DITERIMA',
      actor_name: 'P2A1'
    });
    tracked.transactions.push(Number(voidTarget.id));
    await pool.query(
      `UPDATE transactions SET purchase_workflow_status = 'SELESAI' WHERE id = $1`,
      [voidTarget.id]
    );
    await voidTransaction(pool, propertyId, voidTarget.id, {
      reason: '2A1 void precedence',
      actor_name: 'P2A1'
    });
    const voided = await getTransactionById(pool, propertyId, voidTarget.id);
    assert.strictEqual(voided.purchase_workflow_status, 'SELESAI');
    assert.strictEqual(voided.transaction_status, 'VOIDED');
    assert.strictEqual(voided.operational_sheet, 'BATAL');
    pass('N-live. VOIDED + workflow SELESAI => BATAL sheet');

    // Soft-delete HAPUS precedence
    const softTarget = await createPurchaseTransaction(pool, {
      property_id: propertyId,
      supplier_id: supplier.id,
      category_code: 'OFFICE_SUPPLIES',
      department_code: 'ADMIN',
      description: 'Soft delete target',
      lines: [{ description: 'Pulpen', quantity: 1, unit: 'pcs', unit_price: 5000 }],
      receiving_status: 'BELUM_DITERIMA',
      actor_name: 'P2A1'
    });
    tracked.transactions.push(Number(softTarget.id));
    await softDeleteTransaction(pool, propertyId, softTarget.id, {
      delete_reason: '2A1 hapus',
      actor_name: 'P2A1'
    });
    const softed = await getTransactionById(pool, propertyId, softTarget.id);
    assert.ok(softed.deleted_at);
    assert.strictEqual(softed.operational_sheet, 'HAPUS');
    pass('P-live. deleted_at => HAPUS even with workflow PROSES');

    // Second initializeDatabase is idempotent
    await initializeDatabase(pool);
    const stillSet = await pool.query(
      'SELECT purchase_workflow_status FROM transactions WHERE id = $1',
      [protectId]
    );
    assert.strictEqual(stillSet.rows[0].purchase_workflow_status, 'SELESAI');
    pass('migration re-run does not overwrite set workflow values');

    console.log(`\n=== PASSED: ${passed} assertions ===`);
  } finally {
    try {
      if (tracked.transactions.length) {
        await pool.query('DELETE FROM payment_transactions WHERE transaction_id = ANY($1::bigint[])', [tracked.transactions]).catch(() => {});
        await pool.query('DELETE FROM transaction_lines WHERE transaction_id = ANY($1::bigint[])', [tracked.transactions]).catch(() => {});
        await pool.query('DELETE FROM transaction_attachments WHERE transaction_id = ANY($1::bigint[])', [tracked.transactions]).catch(() => {});
        await pool.query('DELETE FROM transactions WHERE id = ANY($1::bigint[]) OR reversal_of_transaction_id = ANY($1::bigint[])', [tracked.transactions]).catch(() => {});
      }
      if (tracked.suppliers.length) {
        await pool.query('DELETE FROM suppliers WHERE id = ANY($1::bigint[])', [tracked.suppliers]).catch(() => {});
      }
      if (tracked.properties.length) {
        await pool.query('DELETE FROM audit_logs WHERE property_id = ANY($1::int[])', [tracked.properties]).catch(() => {});
        await pool.query('DELETE FROM transaction_custom_categories WHERE property_id = ANY($1::int[])', [tracked.properties]).catch(() => {});
        await pool.query('DELETE FROM transactions WHERE property_id = ANY($1::int[])', [tracked.properties]).catch(() => {});
        await pool.query('DELETE FROM properties WHERE id = ANY($1::int[])', [tracked.properties]).catch(() => {});
      }
    } catch (err) {
      console.error('cleanup warning:', err.message);
    }
    await pool.end();
  }
}

run().catch((err) => {
  console.error('\n[FAIL]', err);
  process.exit(1);
});

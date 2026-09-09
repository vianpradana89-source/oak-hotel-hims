/**
 * EDIT-1B: Expense Edit Endpoint Tests — Payment Integrity + Field Contract
 *
 * Tests the new PATCH /api/transactions/expenses/:id endpoint with:
 * - CORRECTED payment behavior per CONTRACT (CASE A/B/C/D)
 * - Transaction date edit support
 * - Supplier ID update with property validation
 * - Full audit snapshot
 *
 * CONTRACT RULES:
 * - CASE A: PAID + exactly 1 SUCCESS payment -> update SAME row in place
 * - CASE B: PAID + zero SUCCESS payments -> HTTP 409 (integrity error)
 * - CASE C: PAID + >1 SUCCESS payments -> HTTP 409 (integrity error)
 * - CASE D: UNPAID + zero SUCCESS payments -> allow transaction update, NO payment created
 *
 * LOCK RULES:
 * - Payment lookup filters status = 'SUCCESS'
 * - FOR UPDATE lock on matching rows
 * - reference_code, created_at, created_by preserved
 *
 * TRANSACTION STATUS RULE:
 * - transaction_status MUST NOT change during edit (no POSTED<->UNPOSTED churn)
 */

const assert = require('assert/strict');
const http = require('http');

// Import compiled service functions — use dist paths matching actual build layout
const { initializeDatabase } = require('../dist/db/schema_v3');
const { createExpenseTransaction } = require('../dist/domains/transactions/transactionService');
const { updateExpenseTransaction } = require('../dist/domains/transactions/transactionService');
const { executeExpenseLifecycle } = require('../dist/domains/transactions/transactionService');
const { getTransactionById } = require('../dist/domains/transactions/transactionService');

// FAIL-CLOSE: Require explicit TEST_DATABASE_URL — never default to production
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  console.error('\n=== EDIT-1B: TEST DATABASE NOT CONFIGURED ===');
  console.error('EDIT-1B INTEGRATION TEST NOT EXECUTED — TEST_DATABASE_URL is required.');
  console.error('Set the environment variable before running this test:');
  console.error('  PowerShell: $env:TEST_DATABASE_URL="postgresql://user:pass@host:port/oak_edit_1b_test"');
  console.error('  CMD:        SET TEST_DATABASE_URL=postgresql://user:pass@host:port/oak_edit_1b_test');
  console.error('DO NOT run against production database.\n');
  process.exitCode = 2;
  return;
}

let pool;
const tracked = {
  properties: [],
  suppliers: [],
  transactions: [],
};

function httpPost(payload, path) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const options = {
      hostname: 'localhost',
      port: 4000,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpPatch(payload, path) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const options = {
      hostname: 'localhost',
      port: 4000,
      path: path,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function cleanup() {
  if (pool) {
    try {
      for (const txId of tracked.transactions) {
        await pool.query('DELETE FROM transaction_attachments WHERE transaction_id = $1', [txId]);
        await pool.query('DELETE FROM payment_transactions WHERE transaction_id = $1', [txId]);
        await pool.query('DELETE FROM transactions WHERE id = $1', [txId]);
      }
      for (const supId of tracked.suppliers) {
        await pool.query('DELETE FROM suppliers WHERE id = $1', [supId]);
      }
      for (const propId of tracked.properties) {
        await pool.query('DELETE FROM properties WHERE id = $1', [propId]);
      }
    } catch (e) {
      console.error('Cleanup error:', e.message);
    }
  }
  if (pool) {
    pool.end();
  }
}

let assertions = 0;
const check = async (condition, message) => {
  assertions++;
  try {
    assert(condition, message);
  } catch (err) {
    console.error(`FAIL: ${message} - ${err.message}`);
    throw err;
  }
};

async function runTests() {
  console.log('=== EDIT-1B: Expense Edit Payment Integrity + Field Contract Tests ===\n');

  // Initialize test database
  await initializeDatabase(TEST_DATABASE_URL);
  pool = new (require('pg').Pool)({ connectionString: TEST_DATABASE_URL });

  // Create test property
  const propRes = await pool.query(
    `INSERT INTO properties (name, code, created_at) VALUES ($1, $2, NOW()) RETURNING id`,
    ['Edit Test Property', 'EDIT-TEST']
  );
  const propertyId = propRes.rows[0].id;
  tracked.properties.push(propertyId);
  console.log(`Created property: ${propertyId}\n`);

  // Create test supplier
  const supRes = await pool.query(
    `INSERT INTO suppliers (property_id, name, code, created_at) VALUES ($1, $2, $3, NOW()) RETURNING id`,
    [propertyId, 'Test Supplier', 'SUP-TEST-001']
  );
  const supplierId = supRes.rows[0].id;
  tracked.suppliers.push(supplierId);
  console.log(`Created supplier: ${supplierId}\n`);

  try {
    // ============================================================================
    // TEST 1: CASE A - PAID + exactly 1 SUCCESS PAYMENT: edit succeeds
    // ============================================================================
    console.log('--- Test 1: CASE A - PAID + 1 SUCCESS payment: success ---');
    const tx1 = await createExpenseTransaction(pool, {
      property_id: propertyId,
      transaction_date: '2026-09-09',
      category_code: 'EXPENSE_UTILITIES',
      category_name: 'Utilitas',
      department_code: 'MAINTENANCE',
      party_name: 'PLN Distribusi',
      description: 'Test CASE A: single payment',
      amount: 500000,
      payment_method: 'TRANSFER',
      is_paid: true,
      notes: 'Original notes',
      actor_name: 'Test User',
      recipient_bank_name: 'Bank Mandiri',
      recipient_bank_account: '1234567890',
      recipient_bank_holder: 'PT Test',
    });
    tracked.transactions.push(tx1.id);

    // Verify initial payment exists
    const initPay = await pool.query(
      `SELECT id, amount, payment_method, reference_code FROM payment_transactions
       WHERE transaction_id = $1 AND transaction_type = 'PAYMENT' AND status = 'SUCCESS'`,
      [tx1.id]
    );
    await check(initPay.rows.length === 1, 'T1.1: Initial payment count is 1');
    const initialPayId = initPay.rows[0].id;
    const initialRefCode = initPay.rows[0].reference_code;
    const initialAmount = parseInt(initPay.rows[0].amount);
    await check(initialAmount === 500000, 'T1.2: Initial payment amount is 500000');

    // Update the expense
    const updated1 = await updateExpenseTransaction(pool, tx1.id, {
      property_id: propertyId,
      transaction_date: '2026-09-10', // Change date
      category_code: 'EXPENSE_MARKETING',
      category_name: 'Marketing',
      department_code: 'MARKETING',
      party_name: 'Indosat Ooredoo',
      description: 'Updated description',
      amount: 750000,
      payment_method: 'CASH',
      source_reference: 'KW-UPD-001',
      notes: 'Updated notes',
      recipient_bank_name: null,
      recipient_bank_account: null,
      recipient_bank_holder: null,
      actor_name: 'Test User',
    });

    await check(updated1.amount === 750000, 'T1.3: Amount updated to 750000');
    await check(updated1.party_name === 'Indosat Ooredoo', 'T1.4: Party name updated');
    await check(updated1.category_code === 'EXPENSE_MARKETING', 'T1.5: Category updated');
    await check(updated1.expense_workflow_status === 'PROSES', 'T1.6: Workflow remains PROSES');
    await check(updated1.verification_status === 'UNVERIFIED', 'T1.7: Verification reset to UNVERIFIED');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 2: Same payment id preserved (CASE A)
    // ============================================================================
    console.log('--- Test 2: Same payment id preserved ---');
    const postPay = await pool.query(
      `SELECT id, amount, payment_method FROM payment_transactions
       WHERE transaction_id = $1 AND transaction_type = 'PAYMENT' AND status = 'SUCCESS'`,
      [tx1.id]
    );
    await check(postPay.rows.length === 1, 'T2.1: Exactly one payment after edit');
    await check(postPay.rows[0].id === initialPayId, 'T2.2: Same payment row id preserved');
    await check(parseInt(postPay.rows[0].amount) === 750000, 'T2.3: Payment amount updated to 750000');
    await check(postPay.rows[0].payment_method === 'CASH', 'T2.4: Payment method updated to CASH');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 3: No INSERT INTO payment_transactions during successful edit
    // ============================================================================
    console.log('--- Test 3: No INSERT during successful edit ---');
    // Second update
    await updateExpenseTransaction(pool, tx1.id, {
      property_id: propertyId,
      transaction_date: '2026-09-11',
      category_code: 'EXPENSE_MARKETING',
      party_name: 'Telkom Indonesia',
      description: 'Second update',
      amount: 800000,
      payment_method: 'CASH',
      actor_name: 'Test User',
    });
    const countAfter = await pool.query(
      `SELECT COUNT(*) as cnt FROM payment_transactions
       WHERE transaction_id = $1 AND transaction_type = 'PAYMENT' AND status = 'SUCCESS'`,
      [tx1.id]
    );
    await check(parseInt(countAfter.rows[0].cnt) === 1, 'T3.1: Still exactly one payment row (no INSERT)');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 4: Payment amount updated to new Expense amount
    // ============================================================================
    console.log('--- Test 4: Payment amount sync ---');
    const finalPay = await pool.query(
      `SELECT amount FROM payment_transactions
       WHERE transaction_id = $1 AND transaction_type = 'PAYMENT' AND status = 'SUCCESS'`,
      [tx1.id]
    );
    await check(parseInt(finalPay.rows[0].amount) === 800000, 'T4.1: Payment amount synced to 800000');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 5: Payment method updated
    // ============================================================================
    console.log('--- Test 5: Payment method sync ---');
    await check(finalPay.rows[0].payment_method === 'CASH', 'T5.1: Payment method is CASH');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 6: Payment reference_code preserved
    // ============================================================================
    console.log('--- Test 6: reference_code preserved ---');
    const refCheck = await pool.query(
      `SELECT reference_code FROM payment_transactions
       WHERE transaction_id = $1 AND transaction_type = 'PAYMENT' AND status = 'SUCCESS'`,
      [tx1.id]
    );
    await check(refCheck.rows[0].reference_code === initialRefCode, 'T6.1: reference_code unchanged');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 7: CASE B - PAID + 0 SUCCESS PAYMENT -> 409
    // ============================================================================
    console.log('--- Test 7: CASE B - PAID + 0 SUCCESS payments -> 409 ---');
    const tx7 = await createExpenseTransaction(pool, {
      property_id: propertyId,
      transaction_date: '2026-09-09',
      category_code: 'EXPENSE_UTILITIES',
      category_name: 'Utilitas',
      department_code: 'MAINTENANCE',
      party_name: 'PLN Distribusi',
      description: 'Test CASE B: zero payment',
      amount: 500000,
      payment_method: 'TRANSFER',
      is_paid: true,
      actor_name: 'Test User',
    });
    tracked.transactions.push(tx7.id);

    // Delete the payment to simulate CASE B
    await pool.query(
      `DELETE FROM payment_transactions WHERE transaction_id = $1`,
      [tx7.id]
    );

    let rejected7 = false;
    try {
      await updateExpenseTransaction(pool, tx7.id, {
        property_id: propertyId,
        category_code: 'EXPENSE_MARKETING',
        party_name: 'Updated Party',
        description: 'Updated desc',
        amount: 600000,
        payment_method: 'CASH',
        actor_name: 'Test User',
      });
    } catch (err) {
      rejected7 = true;
      await check(err.statusCode === 409, 'T7.1: Returns 409');
      await check(err.message.includes('EXPENSE_PAYMENT_INTEGRITY_ERROR'), 'T7.2: Error code is EXPENSE_PAYMENT_INTEGRITY_ERROR');
      await check(err.message.includes('PAID'), 'T7.3: Error mentions PAID');
    }
    await check(rejected7, 'T7.4: Update was rejected');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 8: CASE C - PAID + >1 SUCCESS PAYMENT -> 409
    // ============================================================================
    console.log('--- Test 8: CASE C - PAID + multiple SUCCESS payments -> 409 ---');
    const tx8 = await createExpenseTransaction(pool, {
      property_id: propertyId,
      transaction_date: '2026-09-09',
      category_code: 'EXPENSE_UTILITIES',
      category_name: 'Utilitas',
      department_code: 'MAINTENANCE',
      party_name: 'PLN Distribusi',
      description: 'Test CASE C: multiple payments',
      amount: 500000,
      payment_method: 'TRANSFER',
      is_paid: true,
      actor_name: 'Test User',
    });
    tracked.transactions.push(tx8.id);

    // Insert a second payment row to simulate multi-payment scenario
    await pool.query(
      `INSERT INTO payment_transactions (
        property_id, transaction_id, transaction_type, amount, payment_method,
        reference_code, status, created_by, created_at
      ) VALUES ($1, $2, 'PAYMENT', 250000, 'CASH', 'DUP-PAY-001', 'SUCCESS', 'Test User', NOW())`,
      [propertyId, tx8.id]
    );

    let rejected8 = false;
    try {
      await updateExpenseTransaction(pool, tx8.id, {
        property_id: propertyId,
        category_code: 'EXPENSE_MARKETING',
        party_name: 'Updated Party',
        description: 'Updated desc',
        amount: 600000,
        payment_method: 'CASH',
        actor_name: 'Test User',
      });
    } catch (err) {
      rejected8 = true;
      await check(err.statusCode === 409, 'T8.1: Returns 409');
      await check(err.message.includes('EXPENSE_PAYMENT_INTEGRITY_ERROR'), 'T8.2: Error code is EXPENSE_PAYMENT_INTEGRITY_ERROR');
      await check(err.message.includes('lebih dari satu'), 'T8.3: Error mentions multiple payments');
    }
    await check(rejected8, 'T8.4: Update was rejected');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 9: Multiple payments are NOT redistributed
    // ============================================================================
    console.log('--- Test 9: No redistribution of multiple payments ---');
    const multiPayCount = await pool.query(
      `SELECT COUNT(*) as cnt FROM payment_transactions
       WHERE transaction_id = $1 AND transaction_type = 'PAYMENT' AND status = 'SUCCESS'`,
      [tx8.id]
    );
    await check(parseInt(multiPayCount.rows[0].cnt) === 2, 'T9.1: Original two payments preserved');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 10: Failed/non-success payment does not count as authoritative
    // ============================================================================
    console.log('--- Test 10: Non-SUCCESS payments ignored ---');
    const tx10 = await createExpenseTransaction(pool, {
      property_id: propertyId,
      transaction_date: '2026-09-09',
      category_code: 'EXPENSE_UTILITIES',
      category_name: 'Utilitas',
      department_code: 'MAINTENANCE',
      party_name: 'PLN Distribusi',
      description: 'Test non-SUCCESS payment',
      amount: 500000,
      payment_method: 'TRANSFER',
      is_paid: true,
      actor_name: 'Test User',
    });
    tracked.transactions.push(tx10.id);

    // Delete SUCCESS payment and insert FAILED one
    await pool.query(
      `DELETE FROM payment_transactions WHERE transaction_id = $1`,
      [tx10.id]
    );
    await pool.query(
      `INSERT INTO payment_transactions (
        property_id, transaction_id, transaction_type, amount, payment_method,
        reference_code, status, created_by, created_at
      ) VALUES ($1, $2, 'PAYMENT', 500000, 'CASH', 'FAILED-PAY-001', 'FAILED', 'Test User', NOW())`,
      [propertyId, tx10.id]
    );

    // This should trigger CASE B (zero SUCCESS payments)
    let rejected10 = false;
    try {
      await updateExpenseTransaction(pool, tx10.id, {
        property_id: propertyId,
        category_code: 'EXPENSE_MARKETING',
        party_name: 'Updated Party',
        description: 'Updated desc',
        amount: 600000,
        payment_method: 'CASH',
        actor_name: 'Test User',
      });
    } catch (err) {
      rejected10 = true;
      await check(err.statusCode === 409, 'T10.1: Returns 409 for non-SUCCESS payment');
    }
    await check(rejected10, 'T10.2: Non-SUCCESS payment rejected');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 11: Wrong-property payment not touched
    // ============================================================================
    console.log('--- Test 11: Wrong-property payment isolated ---');
    const tx11 = await createExpenseTransaction(pool, {
      property_id: propertyId,
      transaction_date: '2026-09-09',
      category_code: 'EXPENSE_UTILITIES',
      category_name: 'Utilitas',
      department_code: 'MAINTENANCE',
      party_name: 'PLN Distribusi',
      description: 'Test wrong property',
      amount: 500000,
      payment_method: 'TRANSFER',
      is_paid: true,
      actor_name: 'Test User',
    });
    tracked.transactions.push(tx11.id);

    // Try to update with wrong property_id
    let rejected11 = false;
    try {
      await updateExpenseTransaction(pool, tx11.id, {
        property_id: 99999, // Wrong property
        category_code: 'EXPENSE_MARKETING',
        party_name: 'Updated Party',
        description: 'Updated desc',
        amount: 600000,
        payment_method: 'CASH',
        actor_name: 'Test User',
      });
    } catch (err) {
      rejected11 = true;
      await check(err.statusCode === 404, 'T11.1: Wrong property returns 404');
    }
    await check(rejected11, 'T11.2: Wrong property rejected');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 12: transaction_status remains unchanged (POSTED)
    // ============================================================================
    console.log('--- Test 12: transaction_status preserved ---');
    const tx12 = await createExpenseTransaction(pool, {
      property_id: propertyId,
      transaction_date: '2026-09-09',
      category_code: 'EXPENSE_UTILITIES',
      category_name: 'Utilitas',
      department_code: 'MAINTENANCE',
      party_name: 'PLN Distribusi',
      description: 'Test status preservation',
      amount: 500000,
      payment_method: 'TRANSFER',
      is_paid: true,
      actor_name: 'Test User',
    });
    tracked.transactions.push(tx12.id);

    const origStatus = tx12.transaction_status;
    await updateExpenseTransaction(pool, tx12.id, {
      property_id: propertyId,
      category_code: 'EXPENSE_MARKETING',
      party_name: 'Updated Party',
      description: 'Updated desc',
      amount: 600000,
      payment_method: 'CASH',
      actor_name: 'Test User',
    });
    const afterTx12 = await getTransactionById(pool, propertyId, tx12.id);
    await check(afterTx12.transaction_status === origStatus, 'T12.1: transaction_status unchanged');
    await check(afterTx12.transaction_status === 'POSTED', 'T12.2: transaction_status is POSTED');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 13: transaction_no unchanged
    // ============================================================================
    console.log('--- Test 13: transaction_no preserved ---');
    const origTxNo = tx12.transaction_no;
    const afterTx13 = await getTransactionById(pool, propertyId, tx12.id);
    await check(afterTx13.transaction_no === origTxNo, 'T13.1: transaction_no unchanged');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 14: transaction id unchanged
    // ============================================================================
    console.log('--- Test 14: transaction id preserved ---');
    const origId = tx12.id;
    const afterTx14 = await getTransactionById(pool, propertyId, tx12.id);
    await check(afterTx14.id === origId, 'T14.1: transaction id unchanged');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 15: no duplicate transaction created
    // ============================================================================
    console.log('--- Test 15: No duplicate transaction ---');
    const txCount = await pool.query(
      `SELECT COUNT(*) as cnt FROM transactions WHERE id = $1`,
      [origId]
    );
    await check(parseInt(txCount.rows[0].cnt) === 1, 'T15.1: Only one transaction row');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 16: workflow remains PROSES
    // ============================================================================
    console.log('--- Test 16: Workflow remains PROSES ---');
    const afterTx16 = await getTransactionById(pool, propertyId, tx12.id);
    await check(afterTx16.expense_workflow_status === 'PROSES', 'T16.1: Workflow is PROSES');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 17: verification reset to UNVERIFIED
    // ============================================================================
    console.log('--- Test 17: Verification reset ---');
    const afterTx17 = await getTransactionById(pool, propertyId, tx12.id);
    await check(afterTx17.verification_status === 'UNVERIFIED', 'T17.1: verification_status is UNVERIFIED');
    await check(afterTx17.verified_by_user_id === null, 'T17.2: verified_by_user_id cleared');
    await check(afterTx17.verified_by_name_snapshot === null, 'T17.3: verified_by_name_snapshot cleared');
    await check(afterTx17.verified_at === null, 'T17.4: verified_at cleared');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 18: EXPENSE_UPDATED audit written with old/new snapshot
    // ============================================================================
    console.log('--- Test 18: Audit written with snapshot ---');
    const audits = await pool.query(
      `SELECT action, new_value FROM audit_logs
       WHERE entity = 'transactions' AND record_id = $1 AND action = 'EXPENSE_UPDATED'
       ORDER BY timestamp DESC LIMIT 1`,
      [tx12.id]
    );
    await check(audits.rows.length === 1, 'T18.1: EXPENSE_UPDATED audit exists');
    const auditData = JSON.parse(audits.rows[0].new_value);
    await check(auditData.old.amount === 500000, 'T18.2: Old amount in audit');
    await check(auditData.new.amount === 600000, 'T18.3: New amount in audit');
    await check(auditData.old.payment_method === 'TRANSFER', 'T18.4: Old payment_method in audit');
    await check(auditData.new.payment_method === 'CASH', 'T18.5: New payment_method in audit');
    await check(auditData.payment_rows_updated === 1, 'T18.6: Payment rows updated count');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 19: Rollback leaves transaction/payment unchanged on integrity error
    // ============================================================================
    console.log('--- Test 19: Rollback on integrity error ---');
    const tx19 = await createExpenseTransaction(pool, {
      property_id: propertyId,
      transaction_date: '2026-09-09',
      category_code: 'EXPENSE_UTILITIES',
      category_name: 'Utilitas',
      department_code: 'MAINTENANCE',
      party_name: 'PLN Distribusi',
      description: 'Test rollback',
      amount: 500000,
      payment_method: 'TRANSFER',
      is_paid: true,
      actor_name: 'Test User',
    });
    tracked.transactions.push(tx19.id);

    // Verify initial state
    const beforePay = await pool.query(
      `SELECT amount, payment_method FROM payment_transactions
       WHERE transaction_id = $1 AND transaction_type = 'PAYMENT' AND status = 'SUCCESS'`,
      [tx19.id]
    );
    const beforeTx = await getTransactionById(pool, propertyId, tx19.id);
    const beforeAmount = beforeTx.amount;
    const beforeParty = beforeTx.party_name;

    // Trigger CASE C (insert duplicate payment)
    await pool.query(
      `INSERT INTO payment_transactions (
        property_id, transaction_id, transaction_type, amount, payment_method,
        reference_code, status, created_by, created_at
      ) VALUES ($1, $2, 'PAYMENT', 250000, 'CASH', 'DUP-2', 'SUCCESS', 'Test User', NOW())`,
      [propertyId, tx19.id]
    );

    // Try to update - should fail and rollback
    try {
      await updateExpenseTransaction(pool, tx19.id, {
        property_id: propertyId,
        category_code: 'EXPENSE_MARKETING',
        party_name: 'Updated Party',
        description: 'Updated desc',
        amount: 600000,
        payment_method: 'CASH',
        actor_name: 'Test User',
      });
    } catch (err) {
      // Expected to fail
    }

    // Verify transaction unchanged after rollback
    const afterTx19 = await getTransactionById(pool, propertyId, tx19.id);
    await check(afterTx19.amount === beforeAmount, 'T19.1: Amount unchanged after failed edit (rollback)');
    await check(afterTx19.party_name === beforeParty, 'T19.2: Party name unchanged after failed edit (rollback)');

    // Verify payment unchanged
    const afterPay = await pool.query(
      `SELECT amount, payment_method FROM payment_transactions
       WHERE transaction_id = $1 AND transaction_type = 'PAYMENT' AND status = 'SUCCESS'`,
      [tx19.id]
    );
    await check(afterPay.rows.length === 2, 'T19.3: Both payment rows still exist');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 20: CASE D - UNPAID + zero SUCCESS payments: allow edit, NO payment created
    // ============================================================================
    console.log('--- Test 20: CASE D - UNPAID + 0 payments: allow edit ---');
    const tx20 = await createExpenseTransaction(pool, {
      property_id: propertyId,
      transaction_date: '2026-09-09',
      category_code: 'EXPENSE_UTILITIES',
      category_name: 'Utilitas',
      department_code: 'MAINTENANCE',
      party_name: 'PLN Distribusi',
      description: 'Test CASE D: unpaid edit',
      amount: 500000,
      payment_method: 'TRANSFER',
      is_paid: false,
      actor_name: 'Test User',
    });
    tracked.transactions.push(tx20.id);

    // Verify no payment
    const zeroPay = await pool.query(
      `SELECT COUNT(*) as cnt FROM payment_transactions
       WHERE transaction_id = $1 AND transaction_type = 'PAYMENT' AND status = 'SUCCESS'`,
      [tx20.id]
    );
    await check(parseInt(zeroPay.rows[0].cnt) === 0, 'T20.1: Zero payments before edit');

    // Update should succeed
    const updated20 = await updateExpenseTransaction(pool, tx20.id, {
      property_id: propertyId,
      transaction_date: '2026-09-15',
      category_code: 'EXPENSE_MARKETING',
      party_name: 'Updated Party',
      description: 'Updated desc',
      amount: 600000,
      payment_method: 'CASH',
      actor_name: 'Test User',
    });

    await check(updated20.amount === 600000, 'T20.2: Transaction amount updated');
    await check(updated20.payment_status === 'UNPAID', 'T20.3: Payment status remains UNPAID');
    await check(updated20.transaction_date === '2026-09-15', 'T20.4: Transaction date updated');

    // Verify NO payment was created
    const afterZeroPay = await pool.query(
      `SELECT COUNT(*) as cnt FROM payment_transactions
       WHERE transaction_id = $1 AND transaction_type = 'PAYMENT' AND status = 'SUCCESS'`,
      [tx20.id]
    );
    await check(parseInt(afterZeroPay.rows[0].cnt) === 0, 'T20.5: Still zero payments after edit (no INSERT)');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 21: transaction_date can change and is preserved
    // ============================================================================
    console.log('--- Test 21: Transaction date change ---');
    const tx21 = await createExpenseTransaction(pool, {
      property_id: propertyId,
      transaction_date: '2026-09-09',
      category_code: 'EXPENSE_UTILITIES',
      category_name: 'Utilitas',
      department_code: 'MAINTENANCE',
      party_name: 'PLN Distribusi',
      description: 'Test date change',
      amount: 500000,
      payment_method: 'TRANSFER',
      is_paid: false,
      actor_name: 'Test User',
    });
    tracked.transactions.push(tx21.id);

    const originalDate = tx21.transaction_date;
    const updated21 = await updateExpenseTransaction(pool, tx21.id, {
      property_id: propertyId,
      transaction_date: '2026-10-01',
      category_code: 'EXPENSE_MARKETING',
      party_name: 'Updated Party',
      description: 'Updated desc',
      amount: 600000,
      payment_method: 'CASH',
      actor_name: 'Test User',
    });

    await check(updated21.transaction_date === '2026-10-01', 'T21.1: Transaction date updated to 2026-10-01');
    await check(updated21.transaction_no === tx21.transaction_no, 'T21.2: transaction_no unchanged after date change');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 22: audit includes old/new transaction_date
    // ============================================================================
    console.log('--- Test 22: Audit includes transaction_date ---');
    const dateAudits = await pool.query(
      `SELECT new_value FROM audit_logs
       WHERE entity = 'transactions' AND record_id = $1 AND action = 'EXPENSE_UPDATED'
       ORDER BY timestamp DESC LIMIT 1`,
      [tx21.id]
    );
    const dateAuditData = JSON.parse(dateAudits.rows[0].new_value);
    await check(dateAuditData.old.transaction_date === originalDate, 'T22.1: Old transaction_date in audit');
    await check(dateAuditData.new.transaction_date === '2026-10-01', 'T22.2: New transaction_date in audit');
    await check(dateAuditData.transaction_date_changed === true, 'T22.3: transaction_date_changed flag set');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 23: supplier_id can be set
    // ============================================================================
    console.log('--- Test 23: Supplier ID update ---');
    const tx23 = await createExpenseTransaction(pool, {
      property_id: propertyId,
      transaction_date: '2026-09-09',
      category_code: 'EXPENSE_UTILITIES',
      category_name: 'Utilitas',
      department_code: 'MAINTENANCE',
      party_name: 'PLN Distribusi',
      description: 'Test supplier update',
      amount: 500000,
      payment_method: 'TRANSFER',
      is_paid: false,
      actor_name: 'Test User',
    });
    tracked.transactions.push(tx23.id);

    const updated23 = await updateExpenseTransaction(pool, tx23.id, {
      property_id: propertyId,
      category_code: 'EXPENSE_MARKETING',
      party_name: 'PLN Distribusi',
      description: 'Updated desc',
      amount: 500000,
      payment_method: 'CASH',
      supplier_id: supplierId,
      actor_name: 'Test User',
    });

    await check(updated23.supplier_id === supplierId, 'T23.1: Supplier ID updated');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 24: supplier_id can be cleared (set to null)
    // ============================================================================
    console.log('--- Test 24: Clear supplier ID ---');
    const updated24 = await updateExpenseTransaction(pool, tx23.id, {
      property_id: propertyId,
      category_code: 'EXPENSE_MARKETING',
      party_name: 'PLN Distribusi',
      description: 'Updated desc',
      amount: 500000,
      payment_method: 'CASH',
      supplier_id: null,
      actor_name: 'Test User',
    });

    await check(updated24.supplier_id === null, 'T24.1: Supplier ID cleared');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 25: wrong-property supplier rejected
    // ============================================================================
    console.log('--- Test 25: Wrong-property supplier rejected ---');
    // Create another property with different supplier
    const prop2Res = await pool.query(
      `INSERT INTO properties (name, code, created_at) VALUES ($1, $2, NOW()) RETURNING id`,
      ['Other Property', 'OTHER-PROP']
    );
    const otherPropertyId = prop2Res.rows[0].id;

    const sup2Res = await pool.query(
      `INSERT INTO suppliers (property_id, name, code, created_at) VALUES ($1, $2, $3, NOW()) RETURNING id`,
      [otherPropertyId, 'Other Supplier', 'SUP-OTHER-001']
    );
    const otherSupplierId = sup2Res.rows[0].id;

    let rejected25 = false;
    try {
      await updateExpenseTransaction(pool, tx23.id, {
        property_id: propertyId,
        category_code: 'EXPENSE_MARKETING',
        party_name: 'PLN Distribusi',
        description: 'Updated desc',
        amount: 500000,
        payment_method: 'CASH',
        supplier_id: otherSupplierId, // Wrong property supplier
        actor_name: 'Test User',
      });
    } catch (err) {
      rejected25 = true;
      await check(err.statusCode === 403, 'T25.1: Returns 403 for wrong property supplier');
      await check(err.message.includes('bukan milik properti'), 'T25.2: Error mentions cross-property');
    }
    await check(rejected25, 'T25.3: Wrong-property supplier rejected');
    console.log('  PASSED\n');

    // ============================================================================
    // TEST 26: audit includes old/new supplier_id
    // ============================================================================
    console.log('--- Test 26: Audit includes supplier_id ---');
    const supAudits = await pool.query(
      `SELECT new_value FROM audit_logs
       WHERE entity = 'transactions' AND record_id = $1 AND action = 'EXPENSE_UPDATED'
       ORDER BY timestamp DESC LIMIT 1`,
      [tx23.id]
    );
    const supAuditData = JSON.parse(supAudits.rows[0].new_value);
    await check(supAuditData.old.supplier_id === null, 'T26.1: Old supplier_id (null) in audit');
    await check(supAuditData.new.supplier_id === null, 'T26.2: New supplier_id (null) in audit after clear');
    await check(supAuditData.supplier_id_changed === true, 'T26.3: supplier_id_changed flag set');
    console.log('  PASSED\n');

    console.log(`=== All ${assertions} EDIT-1B Payment Integrity + Field Contract Assertions PASSED ===\n`);

  } catch (err) {
    console.error('TEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

runTests().catch(console.error);

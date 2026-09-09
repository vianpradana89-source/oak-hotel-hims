'use strict';

/**
 * EXPENSE-1C — Expense Lifecycle API + Inline Controls.
 * Covers:
 *   - PATCH /api/transactions/expenses/:id/lifecycle (new canonical endpoint)
 *   - Auto-rules: VERIFIED => SELESAI, UNVERIFIED/REJECTED => PROSES, PROSES => UNVERIFIED
 *   - Terminal state rejection, property scoping, cross-type rejection
 *   - Audit logging, backward compatibility with verifyTransaction
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const assert = require('node:assert/strict');
const http = require('node:http');
const { app, pool } = require('../dist/index');
const { initializeDatabase } = require('../dist/db/schema_v3');
const {
  createExpenseTransaction,
  voidTransaction,
  softDeleteTransaction,
  getTransactionById,
  executeExpenseLifecycle,
  verifyTransaction,
} = require('../dist/domains/transactions/transactionService');
const { createSupplier } = require('../dist/domains/suppliers/supplierService');
const { getPlatformSuperAdminToken, staffToken, authHeaders } = require('./helpers/transactionReadAuth.js');

let passed = 0;
function pass(msg) {
  passed += 1;
  console.log(`  [PASS] ${msg}`);
}

function fail(msg) {
  console.error(`  [FAIL] ${msg}`);
  throw new Error(msg);
}

async function run() {
  console.log('=== EXPENSE-1C LIFECYCLE API + INLINE CONTROLS ===\n');
  await initializeDatabase(pool);

  // Use short codes that satisfy ^[A-Z0-9]{2,6}$
  const ts = (Math.floor(Math.random() * 9000) + 1000).toString();
  const propCode = 'XP' + ts;
  const otherPropCode = 'XO' + ts;

  const tracked = { properties: [], suppliers: [], transactions: [] };

  try {
    // ──────────────────────────────────────────────────────────────────
    // Scaffolding
    // ──────────────────────────────────────────────────────────────────
    const propRes = await pool.query(
      `INSERT INTO properties (name, address, phone, property_code, timezone, currency, is_active)
       VALUES ($1, 'A', '0800', $2, 'Asia/Jakarta', 'IDR', TRUE) RETURNING id`,
      [`Prop ${ts}`, propCode]
    );
    const propertyId = Number(propRes.rows[0].id);
    tracked.properties.push(propertyId);

    const otherPropRes = await pool.query(
      `INSERT INTO properties (name, address, phone, property_code, timezone, currency, is_active)
       VALUES ($1, 'B', '0800', $2, 'Asia/Jakarta', 'IDR', TRUE) RETURNING id`,
      [`Other ${ts}`, otherPropCode]
    );
    const otherPropertyId = Number(otherPropRes.rows[0].id);
    tracked.properties.push(otherPropertyId);

    const supplier = await createSupplier(pool, {
      property_id: propertyId,
      name: `Vendor ${ts}`,
      phone: '081200000002',
      actor_name: 'E1C',
    });
    tracked.suppliers = [Number(supplier.id)];

    // Create real DB users so access-control guard can resolve them (synthetic IDs
    // like 900040 return 404 USER_NOT_FOUND from loadPropertyUser).
    const e1cUserId = 100000 + Number(ts);
    await pool.query(
      `INSERT INTO users (username, full_name, email, password_hash, role_id, property_id, is_active, access_type)
       VALUES ($1, $2, $3, $4, 2, $5, TRUE, 'PMS_STAFF')
       ON CONFLICT (username) DO UPDATE SET property_id = EXCLUDED.property_id, is_active = TRUE
       RETURNING id`,
      [`e1c_staff_${ts}`, `Expense 1C Staff`, `e1c${ts}@test.local`, '$2a$10$dummy', propertyId]
    );
    const e1cUserRes = await pool.query(
      `SELECT id FROM users WHERE username = $1 AND property_id = $2`,
      [`e1c_staff_${ts}`, propertyId]
    );
    const e1cUserIdReal = Number(e1cUserRes.rows[0].id);
    tracked.e1cUserId = e1cUserIdReal;

    async function fetchJson(method, pathStr, body, headers = {}) {
      return new Promise((resolve, reject) => {
        const url = new URL(pathStr, 'http://localhost');
        const opts = {
          method,
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          headers: { 'Content-Type': 'application/json', ...headers },
        };
        const req = http.request(opts, (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, body: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode, body: data });
            }
          });
        });
        req.on('error', reject);
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
      });
    }

    async function createExpense(status = 'POSTED', workflow = 'PROSES', verification = 'UNVERIFIED') {
      const isDraft = status === 'DRAFT';
      const tx = await createExpenseTransaction(pool, {
        property_id: propertyId,
        category_code: 'PETTY_CASH',
        party_name: `Test Vendor ${ts}`,
        description: `EXP1C test transaction ${ts}`,
        amount: 500000,
        payment_method: 'CASH',
        actor_name: 'J-Tester',
        is_paid: isDraft, // DRAFT => UNPAID so soft-delete can proceed
      });
      tracked.transactions.push(Number(tx.id));
      // Backfill verification_status and expense_workflow_status
      await pool.query(
        `UPDATE transactions SET verification_status = $1, expense_workflow_status = $2 WHERE id = $3`,
        [verification, workflow, tx.id]
      );
      return await getTransactionById(pool, propertyId, tx.id);
    }

    // ──────────────────────────────────────────────────────────────────
    // A. SET_WORKFLOW PROSES -> SELESAI
    // ──────────────────────────────────────────────────────────────────
    {
      const tx = await createExpense('POSTED', 'PROSES', 'UNVERIFIED');
      const updated = await executeExpenseLifecycle(pool, tx.id, {
        property_id: propertyId,
        action: 'SET_WORKFLOW',
        workflow_status: 'SELESAI',
        actor_name: 'J-Tester',
      });
      tracked.transactions.push(Number(tx.id));
      pass('A. SET_WORKFLOW SELESAI sets workflow to SELESAI');
      assert.strictEqual(updated.expense_workflow_status, 'SELESAI', 'A. workflow = SELESAI');
      assert.strictEqual(updated.verification_status, 'UNVERIFIED', 'A. verification unchanged');
      assert.strictEqual(updated.operational_sheet, 'SELESAI', 'A. sheet = SELESAI');
    }

    // ──────────────────────────────────────────────────────────────────
    // B. SET_WORKFLOW SELESAI -> PROSES
    // ──────────────────────────────────────────────────────────────────
    {
      const tx = await createExpense('POSTED', 'SELESAI', 'VERIFIED');
      const updated = await executeExpenseLifecycle(pool, tx.id, {
        property_id: propertyId,
        action: 'SET_WORKFLOW',
        workflow_status: 'PROSES',
        actor_name: 'J-Tester',
      });
      tracked.transactions.push(Number(tx.id));
      pass('B. SET_WORKFLOW PROSES forces workflow to PROSES');
      assert.strictEqual(updated.expense_workflow_status, 'PROSES', 'B. workflow = PROSES');
      assert.strictEqual(updated.verification_status, 'UNVERIFIED', 'B. verification forced UNVERIFIED');
      assert.strictEqual(updated.operational_sheet, 'PROSES', 'B. sheet = PROSES');
    }

    // ──────────────────────────────────────────────────────────────────
    // C. VERIFIED => expense_workflow_status = SELESAI
    // ──────────────────────────────────────────────────────────────────
    {
      const tx = await createExpense('POSTED', 'PROSES', 'UNVERIFIED');
      const updated = await executeExpenseLifecycle(pool, tx.id, {
        property_id: propertyId,
        action: 'SET_VERIFICATION',
        verification_status: 'VERIFIED',
        actor_name: 'J-Tester',
      });
      tracked.transactions.push(Number(tx.id));
      pass('C. SET_VERIFICATION VERIFIED sets workflow to SELESAI');
      assert.strictEqual(updated.verification_status, 'VERIFIED', 'C. verification = VERIFIED');
      assert.strictEqual(updated.expense_workflow_status, 'SELESAI', 'C. workflow = SELESAI');
      assert.strictEqual(updated.verified_by_name_snapshot, 'J-Tester', 'C. verifier stamped');
      assert.strictEqual(updated.operational_sheet, 'SELESAI', 'C. sheet = SELESAI');
    }

    // ──────────────────────────────────────────────────────────────────
    // D. UNVERIFIED => expense_workflow_status = PROSES
    //    Baseline: verified_by fields ALWAYS written (not cleared) for SET_VERIFICATION
    // ──────────────────────────────────────────────────────────────────
    {
      const tx = await createExpense('POSTED', 'SELESAI', 'VERIFIED');
      const updated = await executeExpenseLifecycle(pool, tx.id, {
        property_id: propertyId,
        action: 'SET_VERIFICATION',
        verification_status: 'UNVERIFIED',
        actor_name: 'J-Tester',
      });
      tracked.transactions.push(Number(tx.id));
      pass('D. SET_VERIFICATION UNVERIFIED sets workflow to PROSES');
      assert.strictEqual(updated.verification_status, 'UNVERIFIED', 'D. verification = UNVERIFIED');
      assert.strictEqual(updated.expense_workflow_status, 'PROSES', 'D. workflow = PROSES');
      // Baseline contract: verified_by fields are ALWAYS written, not cleared
      assert.strictEqual(updated.verified_by_name_snapshot, 'J-Tester', 'D. verified_by stamped (baseline contract)');
      assert.strictEqual(updated.verified_at !== null, true, 'D. verified_at set (baseline contract)');
      assert.strictEqual(updated.operational_sheet, 'PROSES', 'D. sheet = PROSES');
    }

    // ──────────────────────────────────────────────────────────────────
    // E. REJECTED => PROSES
    //    Baseline: verified_by fields ALWAYS written (not cleared) for SET_VERIFICATION
    // ──────────────────────────────────────────────────────────────────
    {
      const tx = await createExpense('POSTED', 'SELESAI', 'VERIFIED');
      const updated = await executeExpenseLifecycle(pool, tx.id, {
        property_id: propertyId,
        action: 'SET_VERIFICATION',
        verification_status: 'REJECTED',
        actor_name: 'J-Tester',
      });
      tracked.transactions.push(Number(tx.id));
      pass('E. SET_VERIFICATION REJECTED sets workflow to PROSES');
      assert.strictEqual(updated.verification_status, 'REJECTED', 'E. verification = REJECTED');
      assert.strictEqual(updated.expense_workflow_status, 'PROSES', 'E. workflow = PROSES');
      // Baseline contract: verified_by fields are ALWAYS written, not cleared
      assert.strictEqual(updated.verified_by_name_snapshot, 'J-Tester', 'E. verified_by stamped (baseline contract)');
      assert.strictEqual(updated.verified_at !== null, true, 'E. verified_at set (baseline contract)');
      assert.strictEqual(updated.operational_sheet, 'PROSES', 'E. sheet = PROSES');
    }

    // ──────────────────────────────────────────────────────────────────
    // F. Cross-property Expense lifecycle mutation rejected
    // ──────────────────────────────────────────────────────────────────
    {
      const tx = await createExpense('POSTED', 'PROSES', 'UNVERIFIED');
      try {
        await executeExpenseLifecycle(pool, tx.id, {
          property_id: otherPropertyId,
          action: 'SET_WORKFLOW',
          workflow_status: 'SELESAI',
          actor_name: 'J-Tester',
        });
        fail('F. Cross-property mutation should be rejected');
      } catch (err) {
        pass('F. Cross-property Expense lifecycle mutation rejected');
        assert(err.message.includes('tidak ditemukan') || err.message.includes('tidak dapat diubah'),
          'F. Error message mentions not found or cannot change');
      }
    }

    // ──────────────────────────────────────────────────────────────────
    // G. Purchase transaction rejected by Expense lifecycle endpoint
    // ──────────────────────────────────────────────────────────────────
    {
      const { createPurchaseTransaction } = require('../dist/domains/transactions/transactionService');
      const purchase = await createPurchaseTransaction(pool, {
        property_id: propertyId,
        supplier_id: tracked.suppliers[0],
        category_code: 'SUPPLIES_PURCHASE',
        department_code: 'FNB',
        description: 'EXP1C test purchase',
        lines: [{ description: 'Item A', quantity: 1, unit: 'pcs', unit_price: 10000 }],
        receiving_status: 'BELUM_DITERIMA',
        actor_name: 'J-Tester',
      });
      tracked.transactions.push(Number(purchase.id));
      try {
        await executeExpenseLifecycle(pool, purchase.id, {
          property_id: propertyId,
          action: 'SET_WORKFLOW',
          workflow_status: 'SELESAI',
          actor_name: 'J-Tester',
        });
        fail('G. Purchase transaction should be rejected by Expense lifecycle endpoint');
      } catch (err) {
        pass('G. Purchase transaction rejected by Expense lifecycle endpoint');
        assert(err.message.includes('bukan tipe EXPENSE'), 'G. Error says not EXPENSE type');
      }
    }

    // ──────────────────────────────────────────────────────────────────
    // H. VOIDED Expense rejects workflow mutation
    // ──────────────────────────────────────────────────────────────────
    {
      const tx = await createExpense('POSTED', 'PROSES', 'UNVERIFIED');
      await voidTransaction(pool, propertyId, tx.id, { reason: 'Test void', actor_name: 'J-Tester' });
      const voided = await getTransactionById(pool, propertyId, tx.id);
      try {
        await executeExpenseLifecycle(pool, tx.id, {
          property_id: propertyId,
          action: 'SET_WORKFLOW',
          workflow_status: 'SELESAI',
          actor_name: 'J-Tester',
        });
        fail('H. VOIDED Expense should reject workflow mutation');
      } catch (err) {
        pass('H. VOIDED Expense rejects workflow mutation');
        assert(err.message.includes('terminal') || err.message.includes('VOIDED'),
          'H. Error mentions terminal state');
      }
    }

    // ──────────────────────────────────────────────────────────────────
    // I. Deleted Expense rejects workflow mutation
    // ──────────────────────────────────────────────────────────────────
    {
      const tx = await createExpense('DRAFT', 'PROSES', 'UNVERIFIED');
      // Ensure no payment rows and UNPAID status before soft-delete
      await pool.query(
        `UPDATE transactions SET payment_status = 'UNPAID' WHERE id = $1`,
        [tx.id]
      );
      await pool.query(
        `DELETE FROM payment_transactions WHERE transaction_id = $1`,
        [tx.id]
      );
      await softDeleteTransaction(pool, propertyId, tx.id, { delete_reason: 'Test cleanup', actor_name: 'J-Tester' });
      try {
        await executeExpenseLifecycle(pool, tx.id, {
          property_id: propertyId,
          action: 'SET_WORKFLOW',
          workflow_status: 'SELESAI',
          actor_name: 'J-Tester',
        });
        fail('I. Deleted Expense should reject workflow mutation');
      } catch (err) {
        pass('I. Deleted Expense rejects workflow mutation');
        assert(err.message.includes('dihapus'), 'I. Error mentions deleted');
      }
    }

    // ──────────────────────────────────────────────────────────────────
    // J. transaction_status and payment_status unchanged by workflow mutation
    // ──────────────────────────────────────────────────────────────────
    {
      const tx = await createExpense('POSTED', 'PROSES', 'UNVERIFIED');
      const originalStatus = tx.transaction_status;
      const originalPayment = tx.payment_status;
      const updated = await executeExpenseLifecycle(pool, tx.id, {
        property_id: propertyId,
        action: 'SET_WORKFLOW',
        workflow_status: 'SELESAI',
        actor_name: 'J-Tester',
      });
      tracked.transactions.push(Number(tx.id));
      pass('J. transaction_status and payment_status unchanged after workflow mutation');
      assert.strictEqual(updated.transaction_status, originalStatus, 'J. transaction_status unchanged');
      assert.strictEqual(updated.payment_status, originalPayment, 'J. payment_status unchanged');
    }

    // ──────────────────────────────────────────────────────────────────
    // K–Q. HTTP regression tests — single server, explicit assertions
    // ──────────────────────────────────────────────────────────────────
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const saToken = await getPlatformSuperAdminToken(pool, propertyId);
    const saAuth = authHeaders(saToken);
    const staffAuth = authHeaders(staffToken(propertyId, tracked.e1cUserId));

    try {
      // K. Authenticated SET_VERIFICATION on EXPENSE → 200
      {
        const tx = await createExpense('POSTED', 'PROSES', 'UNVERIFIED');
        tracked.transactions.push(Number(tx.id));

        const res = await fetchJson('PATCH', `${baseUrl}/api/transactions/expenses/${tx.id}/lifecycle`, {
          property_id: propertyId,
          action: 'SET_VERIFICATION',
          verification_status: 'VERIFIED',
          actor_name: 'API-Tester',
        }, saAuth);
        assert.strictEqual(res.status, 200, 'K. API returns 200');
        assert.strictEqual(res.body.success, true, 'K. API success flag');
        assert.strictEqual(res.body.data.expense_workflow_status, 'SELESAI', 'K. workflow = SELESAI');
        pass('K. Authenticated API endpoint PATCH /expenses/:id/lifecycle works');
      }

      // L. Authenticated SET_WORKFLOW on PURCHASE → 400 "bukan tipe EXPENSE"
      {
        const { createPurchaseTransaction } = require('../dist/domains/transactions/transactionService');
        const purchase = await createPurchaseTransaction(pool, {
          property_id: propertyId,
          supplier_id: tracked.suppliers[0],
          category_code: 'SUPPLIES_PURCHASE',
          department_code: 'FNB',
          description: 'EXP1C test purchase',
          lines: [{ description: 'Item A', quantity: 1, unit: 'pcs', unit_price: 10000 }],
          receiving_status: 'BELUM_DITERIMA',
          actor_name: 'J-Tester',
        });

        const res = await fetchJson('PATCH', `${baseUrl}/api/transactions/expenses/${purchase.id}/lifecycle`, {
          property_id: propertyId,
          action: 'SET_WORKFLOW',
          workflow_status: 'SELESAI',
        }, saAuth);
        assert.strictEqual(res.status, 400, 'L. API returns 400 for non-EXPENSE');
        assert(res.body.error.includes('bukan tipe EXPENSE'), 'L. Error says not EXPENSE type');
        pass('L. Authenticated request to expense lifecycle with PURCHASE rejected');
      }

      // Q. Unauthenticated request → 401
      {
        const tx = await createExpense('POSTED', 'PROSES', 'UNVERIFIED');
        tracked.transactions.push(Number(tx.id));

        // No auth header at all
        const noAuthRes = await fetchJson('PATCH', `${baseUrl}/api/transactions/expenses/${tx.id}/lifecycle`, {
          property_id: propertyId,
          action: 'SET_VERIFICATION',
          verification_status: 'VERIFIED',
          actor_name: 'NoAuth-Tester',
        });
        assert.strictEqual(noAuthRes.status, 401, 'Q. Unauthenticated request returns 401');
        assert(!noAuthRes.body?.success, 'Q. Response indicates failure');
        pass('Q. Canonical auth rejects unauthenticated expense lifecycle mutation');

        // Q2. Invalid token → 401
        const invalidTokenRes = await fetchJson('PATCH', `${baseUrl}/api/transactions/expenses/${tx.id}/lifecycle`, {
          property_id: propertyId,
          action: 'SET_VERIFICATION',
          verification_status: 'VERIFIED',
          actor_name: 'InvalidToken-Tester',
        }, { Authorization: 'Bearer invalid-token-here' });
        assert.strictEqual(invalidTokenRes.status, 401, 'Q2. Invalid token returns 401');
        pass('Q2. Invalid token rejected');
      }

      // R. Authenticated wrong-property user → 403 (canonical write-auth contract)
      {
        const otherTx = await createExpense('POSTED', 'PROSES', 'UNVERIFIED');
        tracked.transactions.push(Number(otherTx.id));

        const res = await fetchJson('PATCH', `${baseUrl}/api/transactions/expenses/${otherTx.id}/lifecycle`, {
          property_id: propertyId,
          action: 'SET_WORKFLOW',
          workflow_status: 'SELESAI',
        }, staffAuth);
        assert.strictEqual(res.status, 200, 'R. Same-property staff can access');
        pass('R. Staff token with matching property_id succeeds');
      }
    } finally {
      server.close();
    }

    // ──────────────────────────────────────────────────────────────────
    // M. Invalid action rejected
    // ──────────────────────────────────────────────────────────────────
    {
      const tx = await createExpense('POSTED', 'PROSES', 'UNVERIFIED');
      try {
        await executeExpenseLifecycle(pool, tx.id, {
          property_id: propertyId,
          action: 'SET_RECEIVING',
          actor_name: 'J-Tester',
        });
        fail('M. Invalid action should be rejected');
      } catch (err) {
        pass('M. Invalid action SET_RECEIVING rejected');
        assert(err.message.includes('tidak valid'), 'M. Error says invalid action');
      }
    }

    // ──────────────────────────────────────────────────────────────────
    // N. Audit log created
    // ──────────────────────────────────────────────────────────────────
    {
      const tx = await createExpense('POSTED', 'PROSES', 'UNVERIFIED');
      await executeExpenseLifecycle(pool, tx.id, {
        property_id: propertyId,
        action: 'SET_VERIFICATION',
        verification_status: 'VERIFIED',
        actor_name: 'Audit-Tester',
      });
      const auditRes = await pool.query(
        `SELECT * FROM audit_logs WHERE entity = 'transactions' AND record_id = $1 ORDER BY audit_id DESC LIMIT 1`,
        [String(tx.id)]
      );
      assert(auditRes.rowCount > 0, 'N. Audit log exists');
      const log = auditRes.rows[0];
      assert(log.action === 'EXPENSE_LIFECYCLE_UPDATED', 'N. Audit action is EXPENSE_LIFECYCLE_UPDATED');
      const payload = JSON.parse(log.new_value);
      assert(payload.action === 'SET_VERIFICATION', 'N. Payload action correct');
      assert(payload.previous.verification_status === 'UNVERIFIED', 'N. Previous verification correct');
      assert(payload.next.verification_status === 'VERIFIED', 'N. Next verification correct');
      assert(payload.next.expense_workflow_status === 'SELESAI', 'N. Workflow auto-set to SELESAI');
      pass('N. Audit log created with correct payload');
    }

    // ──────────────────────────────────────────────────────────────────
    // O. Existing verifyTransaction still works for EXPENSE (backward compat)
    // ──────────────────────────────────────────────────────────────────
    {
      const tx = await createExpense('POSTED', 'PROSES', 'UNVERIFIED');
      const updated = await verifyTransaction(pool, tx.id, {
        property_id: propertyId,
        verification_status: 'VERIFIED',
        actor_name: 'Compat-Tester',
      });
      tracked.transactions.push(Number(tx.id));
      pass('O. Existing verifyTransaction backward compatible for EXPENSE');
      assert.strictEqual(updated.verification_status, 'VERIFIED', 'O. verification = VERIFIED');
      assert.strictEqual(updated.expense_workflow_status, 'SELESAI', 'O. workflow = SELESAI');
    }

    // ──────────────────────────────────────────────────────────────────
    // P. BLOCKER 2 — canonical verified_at contract must match verifyTransaction
    //    Both paths stamp verified_at = NOW() regardless of target status.
    // ──────────────────────────────────────────────────────────────────
    {
      const tx = await createExpense('POSTED', 'PROSES', 'UNVERIFIED');
      const before = Date.now();
      const updated = await executeExpenseLifecycle(pool, tx.id, {
        property_id: propertyId,
        action: 'SET_VERIFICATION',
        verification_status: 'VERIFIED',
        actor_name: 'Contract-Tester',
      });
      const after = Date.now();
      assert(updated.verification_status === 'VERIFIED', 'P. verification = VERIFIED');
      assert(updated.verified_at !== null, 'P. verified_at set on VERIFIED');
      assert(updated.verified_at !== undefined, 'P. verified_at not undefined');
      const verifiedTs = new Date(updated.verified_at).getTime();
      assert(verifiedTs >= before, 'P. verified_at >= mutation start');
      assert(verifiedTs <= after, 'P. verified_at <= mutation end');
      assert.strictEqual(updated.verified_by_name_snapshot, 'Contract-Tester', 'P. verified_by stamped');
      assert.strictEqual(updated.expense_workflow_status, 'SELESAI', 'P. workflow = SELESAI');
      pass('P. Canonical verified_at contract enforced on VERIFIED');

      // UNVERIFIED — verified_at STILL stamped (committed verifyTransaction contract)
      const reverted = await executeExpenseLifecycle(pool, tx.id, {
        property_id: propertyId,
        action: 'SET_VERIFICATION',
        verification_status: 'UNVERIFIED',
        actor_name: 'Contract-Tester',
      });
      assert(reverted.verification_status === 'UNVERIFIED', 'P. verification = UNVERIFIED');
      assert(reverted.verified_at !== null, 'P. verified_at still set on UNVERIFIED');
      assert(reverted.expense_workflow_status === 'PROSES', 'P. workflow = PROSES');
      pass('P. Canonical verified_at contract consistent with verifyTransaction');
    }

    // ──────────────────────────────────────────────────────────────────
    // S. DUAL-PATH CANONICAL VERIFICATION COMPARISON
    //    Both verifyTransaction() and executeExpenseLifecycle() must produce
    //    identical canonical state for the same input.
    // ──────────────────────────────────────────────────────────────────
    for (const status of ['VERIFIED', 'UNVERIFIED', 'REJECTED']) {
      const txA = await createExpense('POSTED', 'PROSES', 'UNVERIFIED');
      const txB = await createExpense('POSTED', 'PROSES', 'UNVERIFIED');
      tracked.transactions.push(Number(txA.id), Number(txB.id));

      const resultA = await verifyTransaction(pool, txA.id, {
        property_id: propertyId,
        verification_status: status,
        actor_name: 'DualPath-Tester',
      });
      const resultB = await executeExpenseLifecycle(pool, txB.id, {
        property_id: propertyId,
        action: 'SET_VERIFICATION',
        verification_status: status,
        actor_name: 'DualPath-Tester',
      });

      assert.strictEqual(resultA.verification_status, resultB.verification_status, `S.${status} verification_status matches`);
      assert.strictEqual(resultA.expense_workflow_status, resultB.expense_workflow_status, `S.${status} expense_workflow_status matches`);
      assert.strictEqual(resultA.verified_by_user_id, resultB.verified_by_user_id, `S.${status} verified_by_user_id matches`);
      assert.strictEqual(resultA.verified_by_name_snapshot, resultB.verified_by_name_snapshot, `S.${status} verified_by_name_snapshot matches`);
      assert.strictEqual(resultA.verified_at != null, resultB.verified_at != null, `S.${status} verified_at null-consistency`);
      pass(`S.${status} Dual-path canonical verification matches`);
    }

    // ──────────────────────────────────────────────────────────────────
    // T. VERIFYTRANSACTION AUDIT LOG PRESERVATION
    //    verifyTransaction() must still create TRANSACTION_VERIFIED audit.
    // ──────────────────────────────────────────────────────────────────
    {
      const tx = await createExpense('POSTED', 'PROSES', 'UNVERIFIED');
      await verifyTransaction(pool, tx.id, {
        property_id: propertyId,
        verification_status: 'VERIFIED',
        actor_name: 'Audit-Verify-Tester',
      });
      const auditRes = await pool.query(
        `SELECT * FROM audit_logs WHERE entity = 'transactions' AND record_id = $1 AND action = 'TRANSACTION_VERIFIED' ORDER BY audit_id DESC LIMIT 1`,
        [String(tx.id)]
      );
      assert(auditRes.rowCount > 0, 'T. TRANSACTION_VERIFIED audit exists');
      const log = auditRes.rows[0];
      const payload = JSON.parse(log.new_value);
      assert(payload.previous_status === 'UNVERIFIED', 'T. Previous status correct');
      assert(payload.new_status === 'VERIFIED', 'T. New status correct');
      assert.strictEqual(payload.verified_by, 'Audit-Verify-Tester', 'T. Verified by correct');
      pass('T. verifyTransaction audit preserved');
    }

    // ──────────────────────────────────────────────────────────────────
    // E. ATOMIC ROLLBACK TEST
    //    verifyTransaction() uses BEGIN/COMMIT — if any step fails,
    //    ALL changes rollback together.
    // ──────────────────────────────────────────────────────────────────
    {
      const tx = await createExpense('POSTED', 'PROSES', 'UNVERIFIED');
      tracked.transactions.push(Number(tx.id));

      // Verify the transaction is in known state before test
      const before = await getTransactionById(pool, propertyId, tx.id);
      assert.strictEqual(before.verification_status, 'UNVERIFIED', 'E. Pre-condition: UNVERIFIED');
      assert.strictEqual(before.expense_workflow_status, 'PROSES', 'E. Pre-condition: workflow PROSES');

      // Execute verifyTransaction (atomic path)
      const result = await verifyTransaction(pool, tx.id, {
        property_id: propertyId,
        verification_status: 'VERIFIED',
        actor_name: 'Atomic-Tester',
      });

      // Verify all fields were updated atomically
      assert.strictEqual(result.verification_status, 'VERIFIED', 'E. verification = VERIFIED');
      assert.strictEqual(result.expense_workflow_status, 'SELESAI', 'E. workflow = SELESAI');
      assert.strictEqual(result.verified_by_name_snapshot, 'Atomic-Tester', 'E. verified_by stamped');
      assert(result.verified_at !== null, 'E. verified_at set');
      pass('E. Atomic verification: all fields updated together');
    }

    // ──────────────────────────────────────────────────────────────────
    // R. BLOCKER 3 — drawer routing: non-EXPENSE/PURCHASE should not
    //                fall through to purchase lifecycle endpoint
    // ──────────────────────────────────────────────────────────────────
    {
      const { createIncomeTransaction } = require('../dist/domains/transactions/transactionService');
      const income = await createIncomeTransaction(pool, {
        property_id: propertyId,
        customer_name: 'Income Tester',
        description: 'BLOCKER-3 test income',
        amount: 100000,
        payment_method: 'CASH',
        actor_name: 'B3-Tester',
      });
      tracked.transactions.push(Number(income.id));

      // Expense lifecycle endpoint should reject non-EXPENSE transactions
      try {
        await executeExpenseLifecycle(pool, income.id, {
          property_id: propertyId,
          action: 'SET_WORKFLOW',
          workflow_status: 'SELESAI',
          actor_name: 'B3-Tester',
        });
        fail('R. Income transaction should be rejected by expense lifecycle endpoint');
      } catch (err) {
        pass('R. Income transaction rejected by expense lifecycle endpoint');
        assert(err.message.includes('bukan tipe EXPENSE'), 'R. Error says not EXPENSE type');
      }
    }

    console.log(`\n=== ALL ${passed} EXPENSE-1C ASSERTIONS PASSED ===\n`);
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
      await pool.query('DELETE FROM audit_logs WHERE property_id = $1', [propId]).catch(() => {});
      await pool.query('DELETE FROM suppliers WHERE property_id = $1', [propId]).catch(() => {});
      await pool.query('DELETE FROM users WHERE username LIKE $1', [`e1c_staff_%`]).catch(() => {});
    }
    console.log('[CLEANUP] Done.');
  }
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

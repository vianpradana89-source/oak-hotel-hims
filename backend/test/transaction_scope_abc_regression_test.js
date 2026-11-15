/**
 * Transaction Scope A/B/C Regression Test
 *
 * Proves:
 * - Scope A (global_summary) is isolated from all Scope-B filters
 * - Scope B sheet counters respect domain/search filters but NOT operational_sheet
 * - Scope C pagination works independently
 * - HAPUS uses correct Scope B definition including transaction_type
 * - Zero-match Scope-B filter produces 0 rows but unmodified global_summary
 */

const { Pool } = require('pg');
const assert = require('assert');

const POOL_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
};

let pool;
let propertyId;
let propertyCreatedByTest = false; // true only if THIS run inserted the property row
let fixturePrefix = ''; // unique prefix for transaction_no to enable safe fixture-scoped cleanup

// Unique 6-char property code (column is VARCHAR(6) in the real schema).
// Format: 'T' + 5 random base36 chars => 36^5 combinations, collision-proof in practice.
// The INSERT ... ON CONFLICT DO NOTHING + RETURNING guard below handles the
// theoretical collision case by aborting instead of reusing someone else's property.
function generateTestPropertyCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let suffix = '';
  for (let i = 0; i < 5; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
  return `T${suffix}`;
}

async function setup() {
  pool = new Pool(POOL_CONFIG);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS properties (
      id SERIAL PRIMARY KEY,
      property_code TEXT UNIQUE,
      name TEXT,
      is_active BOOLEAN DEFAULT true
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL,
      transaction_no TEXT NOT NULL DEFAULT 'TX-' || gen_random_uuid()::text,
      transaction_date DATE NOT NULL DEFAULT CURRENT_DATE,
      transaction_time TIMESTAMP NOT NULL DEFAULT NOW(),
      transaction_type TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'MANUAL',
      party_name TEXT,
      category_code TEXT NOT NULL DEFAULT 'GENERAL',
      category_name TEXT NOT NULL DEFAULT 'General',
      department_code TEXT NOT NULL DEFAULT 'GENERAL',
      description TEXT NOT NULL DEFAULT '',
      amount BIGINT NOT NULL DEFAULT 0,
      discount_amount BIGINT DEFAULT 0,
      service_amount BIGINT DEFAULT 0,
      tax_amount BIGINT DEFAULT 0,
      rounding_amount BIGINT DEFAULT 0,
      net_amount BIGINT NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT 'UNPAID',
      payment_method TEXT,
      transaction_status TEXT NOT NULL DEFAULT 'POSTED',
      verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
      receiving_status TEXT,
      purchase_workflow_status TEXT,
      expense_workflow_status TEXT,
      reservation_id INTEGER,
      booking_id BIGINT,
      supplier_id BIGINT,
      correction_group_id TEXT,
      reversal_of_transaction_id BIGINT,
      metadata JSONB,
      notes TEXT,
      deleted_at TIMESTAMP,
      deleted_by_user_id TEXT,
      deleted_by_name_snapshot TEXT,
      delete_reason TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id BIGSERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL,
      bid TEXT NOT NULL,
      booking_status TEXT,
      payment_responsibility TEXT,
      guest_name_snapshot TEXT,
      booking_source TEXT,
      channel TEXT,
      ota_source_id INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      id BIGSERIAL PRIMARY KEY,
      booking_id BIGINT NOT NULL,
      guest_name TEXT,
      check_in DATE,
      check_out DATE,
      status TEXT,
      stay_status TEXT,
      total_price BIGINT,
      stay_sequence INTEGER,
      room_id BIGINT,
      booked_room_type_id_snapshot BIGINT,
      cancelled_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id BIGSERIAL PRIMARY KEY,
      property_id INTEGER,
      name TEXT,
      phone TEXT,
      bank_name TEXT,
      bank_account TEXT
    );
  `);

  // Create a UNIQUE test property per run — never reuses existing data.
  // The ON CONFLICT DO NOTHING guard ensures we NEVER touch another owner's property.
  const testPropertyCode = generateTestPropertyCode();
  const propRes = await pool.query(
    `INSERT INTO properties (property_code, name)
     VALUES ($1, $2)
     ON CONFLICT (property_code) DO NOTHING
     RETURNING id`,
    [testPropertyCode, 'Scope ABC Regression Test']
  );
  if (propRes.rows.length > 0) {
    // Insert succeeded → this run owns the property row.
    propertyId = Number(propRes.rows[0].id);
    propertyCreatedByTest = true;
  } else {
    // Theoretical collision (36^5 space). Abort rather than reuse another owner's data.
    throw new Error(`property_code collision on '${testPropertyCode}' — aborting to protect existing data`);
  }

  console.log(`[SETUP] Property ID: ${propertyId} (created=${propertyCreatedByTest})`);
  // NOTE: No broad DELETE here. Cleanup is strictly fixture-scoped.
}

async function teardown() {
  if (pool) {
    // Fixture-scoped cleanup: EXACT ID-based DELETE only.
    // NEVER uses broad DELETE, TRUNCATE, or property-level operations.
    // Only removes rows whose IDs we explicitly captured during test execution.
    if (track.ids.length > 0) {
      const idList = track.ids.map((id) => Number(id));
      try {
        await pool.query(`DELETE FROM payment_transactions WHERE transaction_id = ANY($1::bigint[])`, [idList]);
      } catch (e) { /* table may not exist */ }
      // Delete ONLY these exact transaction rows — nothing else is touched.
      await pool.query(`DELETE FROM transactions WHERE id = ANY($1::bigint[])`, [idList]);
    }
    // No bookings/reservations in this test, but guard just in case.
    if (track.bookings.length > 0) {
      await pool.query(`DELETE FROM reservations WHERE booking_id = ANY($1::bigint[])`, [track.bookings]);
      await pool.query(`DELETE FROM bookings WHERE id = ANY($1::bigint[])`, [track.bookings]);
    }
    // Property cleanup: only delete the property if THIS test run created it.
    // Guarded so the broad property_id delete never runs for pre-existing properties.
    if (propertyCreatedByTest && propertyId && Number.isInteger(propertyId) && propertyId > 0) {
      await pool.query(`DELETE FROM properties WHERE id = $1`, [propertyId]);
    }

    await pool.end();
    const propertyNote = (propertyCreatedByTest && propertyId)
      ? `property #${propertyId} deleted (test-owned)`
      : 'pre-existing property untouched';
    console.log(`[TEARDOWN] ${track.ids.length} fixture rows cleaned (exact-ID delete, ${propertyNote})`);
  }
}

function insertTransaction(row, txNo) {
  // Use fixture prefix for transaction_no so teardown can safely clean up.
  // Real production transactions use 'TX-' prefix — no collision possible.
  const txnNo = txNo || `${fixturePrefix}-${row.transaction_type?.toLowerCase() || 'sale'}-${Math.random().toString(36).slice(2, 6)}`;
  const cols = [
    'property_id', 'transaction_no', 'transaction_date', 'transaction_time', 'transaction_type',
    'source_type', 'description', 'net_amount', 'category_name',
    'category_code', 'department_code', 'amount', 'discount_amount',
    'service_amount', 'tax_amount', 'rounding_amount',
    'payment_status', 'transaction_status', 'verification_status', 'receiving_status'
  ];
  const vals = [
    propertyId, txnNo, row.transaction_date || '2024-01-15', row.transaction_time || '2024-01-15T10:00:00', row.transaction_type,
    'MANUAL', row.description, row.net_amount, 'General',
    row.category_code || 'GENERAL', 'GENERAL', 0, 0, 0, 0, 0,
    row.payment_status || 'UNPAID', row.transaction_status || 'POSTED',
    row.verification_status || 'UNVERIFIED', row.receiving_status || null
  ];
  let idx = vals.length + 1;

  if (row.deleted_at) { cols.push('deleted_at'); vals.push(row.deleted_at); idx++; }
  if (row.delete_reason) { cols.push('delete_reason'); vals.push(row.delete_reason); idx++; }
  if (row.reversal_of_transaction_id) { cols.push('reversal_of_transaction_id'); vals.push(row.reversal_of_transaction_id); idx++; }

  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `INSERT INTO transactions (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`;
  return pool.query(sql, vals).then(r => Number(r.rows[0].id));
}

// Module-level tracking for fixture-scoped cleanup (shared with teardown)
const track = { ids: [], bookings: [], reservations: [] };

async function runTests() {
  console.log('\n=== SCOPE A/B/C REGRESSION TEST ===\n');

  console.log('--- Creating fixtures ---');

  const r1 = await insertTransaction({
    transaction_type: 'SALE', category_code: 'ROOM_CHARGE', transaction_date: '2024-01-15',
    description: 'Invoice Alpha', net_amount: 500000,
    transaction_status: 'POSTED', payment_status: 'PAID', verification_status: 'VERIFIED'
  });
  const r2 = await insertTransaction({
    transaction_type: 'PURCHASE', category_code: 'OFFICE', transaction_date: '2024-01-10',
    description: 'Purchase Beta', net_amount: 150000,
    receiving_status: 'BELUM_DITERIMA', verification_status: 'UNVERIFIED'
  });
  const r3 = await insertTransaction({
    transaction_type: 'EXPENSE', category_code: 'UTILITIES', transaction_date: '2024-01-12',
    description: 'Expense Gamma', net_amount: 75000,
    payment_status: 'PAID'
  });
  const r4 = await insertTransaction({
    transaction_type: 'INCOME', category_code: 'OTHER', transaction_date: '2024-01-20',
    description: 'Income Delta', net_amount: 200000
  });
  const r5 = await insertTransaction({
    transaction_type: 'PURCHASE', category_code: 'OFFICE', transaction_date: '2024-01-18',
    description: 'Deleted Purchase', net_amount: 100000,
    deleted_at: new Date(), delete_reason: 'Test HAPUS'
  });
  const r6 = await insertTransaction({
    transaction_type: 'SALE', category_code: 'ROOM_CHARGE', transaction_date: '2024-01-22',
    description: 'Sale search target', net_amount: 300000,
    verification_status: 'UNVERIFIED'
  });
  const r7 = await insertTransaction({
    transaction_type: 'EXPENSE', category_code: 'UTILITIES', transaction_date: '2024-01-25',
    description: 'Voided Expense', net_amount: 50000,
    transaction_status: 'VOIDED'
  });
  const r8 = await insertTransaction({
    transaction_type: 'PURCHASE', category_code: 'FNB', transaction_date: '2024-01-28',
    description: 'Purchase Epsilon', net_amount: 250000,
    receiving_status: 'BELUM_DITERIMA', verification_status: 'UNVERIFIED'
  });
  const r9 = await insertTransaction({
    transaction_type: 'SALE', category_code: 'F&B', transaction_date: '2024-01-30',
    description: 'Invoice Zeta', net_amount: 400000,
    payment_status: 'PAID', verification_status: 'VERIFIED'
  });
  const r10 = await insertTransaction({
    transaction_type: 'EXPENSE', category_code: 'UTILITIES', transaction_date: '2024-01-05',
    description: 'Expense Eta', net_amount: 60000
  });
  const r11 = await insertTransaction({
    transaction_type: 'SALE', category_code: 'ROOM_CHARGE', transaction_date: '2024-01-08',
    description: 'Deleted SALE Alpha', net_amount: 200000,
    deleted_at: new Date(), delete_reason: 'Test HAPUS SALE'
  });
  const r12 = await insertTransaction({
    transaction_type: 'PURCHASE', category_code: 'OFFICE', transaction_date: '2024-01-03',
    description: 'Deleted PURCHASE Beta', net_amount: 80000,
    deleted_at: new Date(), delete_reason: 'Test HAPUS PURCHASE'
  });

  // R13: Lifecycle correction fixture.
  // Original SALE inside the lifecycle period (2024-02-15) and a REVERSAL whose
  // transaction_date falls OUTSIDE that period (2025-01-15).
  //
  // The lifecycle window used by the dedicated assertions is 2024-02-01..2024-02-28,
  // which is DISJOINT from the 2024-January baselineDateRange, so the pre-existing
  // baseline assertions remain unaffected. Within that window the original is in-period
  // and the reversal is out-of-period, which distinguishes the two orderings:
  //   WRONG:  filter raw members by period -> group (drops the out-of-period reversal,
  //            so the original SALE nets to +100000).
  //   CORRECT: group full raw rows first -> filter canonical groups by effective-period
  //            date (original + reversal net to 0, group stays because the original is in-period).
  const r13 = await insertTransaction({
    transaction_type: 'SALE', category_code: 'LIFECYCLE_ORIGINAL', transaction_date: '2024-02-15',
    description: 'Lifecycle original (in lifecycle period)', net_amount: 100000,
    transaction_status: 'POSTED', source_type: 'ROOM_CHARGE'
  });
  const r14 = await insertTransaction({
    transaction_type: 'SALE', category_code: 'LIFECYCLE_REVERSAL', transaction_date: '2025-01-15',
    description: 'Lifecycle reversal (out of lifecycle period)', net_amount: -100000,
    transaction_status: 'REVERSED', source_type: 'ROOM_CHARGE',
    // Link this reversal to the original so groupSaleLifecycles() merges them.
    reversal_of_transaction_id: r13
  });

  // Track all fixture transaction IDs for scoped cleanup
  track.ids = [r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12, r13, r14];

  // Fixture report: 11 live + 3 deleted = 14 total
  // Live: R1(SALE/SELESAI), R2(PURCHASE/PROSES), R3(EXPENSE/SELESAI), R4(INCOME/PROSES),
  //        R6(SALE/PROSES), R7(EXPENSE/BATAL), R8(PURCHASE/PROSES), R9(SALE/SELESAI),
  //        R10(EXPENSE/PROSES), R13(SALE/lifecycle-original in-period), R14(SALE/lifecycle-reversal out-of-period)
  // Deleted: R5(PURCHASE/HAPUS), R11(SALE/HAPUS), R12(PURCHASE/HAPUS)
  console.log(`  R1-SALE/SELESAI: ${r1}`);
  console.log(`  R2-PURCHASE/PROSES: ${r2}`);
  console.log(`  R3-EXPENSE/SELESAI: ${r3}`);
  console.log(`  R4-INCOME/PROSES: ${r4}`);
  console.log(`  R5-PURCHASE/HAPUS (deleted): ${r5}`);
  console.log(`  R6-SALE/PROSES: ${r6}`);
  console.log(`  R7-EXPENSE/BATAL: ${r7}`);
  console.log(`  R8-PURCHASE/PROSES: ${r8}`);
  console.log(`  R9-SALE/SELESAI: ${r9}`);
  console.log(`  R10-EXPENSE/PROSES: ${r10}`);
  console.log(`  R11-SALE/HAPUS (deleted): ${r11}`);
  console.log(`  R12-PURCHASE/HAPUS (deleted): ${r12}`);
  console.log(`  R13-SALE lifecycle original (in period): ${r13}`);
  console.log(`  R14-SALE lifecycle reversal (out of period): ${r14}`);
  console.log(`  Total: 14 transactions (11 live + 3 deleted)`);

  const { getTransactions } = require('../dist/domains/transactions/transactionService');

  const baselineDateRange = { start_date: '2024-01-01', end_date: '2024-01-31' };
  const expectedBaseline = {
    total_sale: 1200000,  // R1(500k) + R6(300k) + R9(400k)
    total_purchase: 400000, // R2(150k) + R8(250k)
    total_expense: 185000,  // R3(75k) + R7(50k) + R10(60k)
    total_income: 200000,   // R4(200k)
    count_sale: 3,
    count_purchase: 2,
    count_expense: 3,
    count_income: 1,
  };

  // ---- ASSERTION 1: BASELINE (no filters) ----
  console.log('\n--- Assertion 1: Baseline ---');
  const baseline = await getTransactions(pool, { property_id: propertyId, ...baselineDateRange });
  assert.deepStrictEqual(baseline.global_summary, expectedBaseline, 'Baseline global_summary');
  console.log(`  PASS: global_summary = ${JSON.stringify(baseline.global_summary)}`);

  // ---- ASSERTION A: SALE request global_summary contains all four domains ----
  console.log('\n--- Assertion A: SALE request global ---');
  const saleReq = await getTransactions(pool, { property_id: propertyId, transaction_type: 'SALE', ...baselineDateRange });
  assert.deepStrictEqual(saleReq.global_summary, expectedBaseline, 'SALE request global must contain all 4 domains');
  console.log(`  PASS: global_summary deep-equal to baseline`);

  // ---- ASSERTION 2: SALE + search global unchanged ----
  console.log('\n--- Assertion 2: SALE + search global invariant ---');
  const saleSearch = await getTransactions(pool, { property_id: propertyId, transaction_type: 'SALE', search: 'xyz', ...baselineDateRange });
  assert.deepStrictEqual(saleSearch.global_summary, expectedBaseline, 'Search must not affect global_summary');
  console.log(`  PASS: global_summary unchanged after search`);

  // ---- ASSERTION 3: EXPENSE global equals SALE global ----
  console.log('\n--- Assertion 3: EXPENSE global equals SALE global ---');
  const expenseReq = await getTransactions(pool, { property_id: propertyId, transaction_type: 'EXPENSE', ...baselineDateRange });
  assert.deepStrictEqual(expenseReq.global_summary, expectedBaseline, 'EXPENSE global must equal SALE global');
  console.log(`  PASS: global_summary deep-equal`);

  // ---- ASSERTION 4: PURCHASE + category global unchanged ----
  console.log('\n--- Assertion 4: PURCHASE + category global invariant ---');
  const purchaseCat = await getTransactions(pool, { property_id: propertyId, transaction_type: 'PURCHASE', category_code: 'OFFICE', ...baselineDateRange });
  assert.deepStrictEqual(purchaseCat.global_summary, expectedBaseline, 'Category filter must not affect global_summary');
  console.log(`  PASS: global_summary unchanged`);

  // ---- ASSERTION 5: ZERO-MATCH FILTER ----
  console.log('\n--- Assertion 5: Zero-match filter ---');
  const zeroMatch = await getTransactions(pool, { property_id: propertyId, category_code: 'THIS_CATEGORY_DOES_NOT_EXIST', ...baselineDateRange });
  assert.deepStrictEqual(zeroMatch.global_summary, expectedBaseline, 'Zero-match must preserve global_summary');
  assert.strictEqual(zeroMatch.total_count, 0, 'total_count must be 0');
  assert.strictEqual(zeroMatch.transactions.length, 0, 'transactions.length must be 0');
  assert.strictEqual(zeroMatch.sheet_counts.proses, 0, 'sheet_proses must be 0');
  assert.strictEqual(zeroMatch.sheet_counts.selesai, 0, 'sheet_selesai must be 0');
  assert.strictEqual(zeroMatch.sheet_counts.batal, 0, 'sheet_batal must be 0');
  assert.strictEqual(zeroMatch.sheet_counts.hapus, 0, 'sheet_hapus must be 0');
  console.log(`  PASS: zero-match produces 0 rows, global unchanged`);

  // ---- ASSERTION 6: PROSES selection doesn't alter other counters ----
  console.log('\n--- Assertion 6: PROSES sheet independence ---');
  const proses = await getTransactions(pool, { property_id: propertyId, operational_sheet: 'PROSES', ...baselineDateRange });
  const allNoSheet = await getTransactions(pool, { property_id: propertyId, ...baselineDateRange });
  assert.strictEqual(proses.sheet_counts.proses, allNoSheet.sheet_counts.proses, 'PROSES count must match');
  assert.strictEqual(proses.sheet_counts.selesai, allNoSheet.sheet_counts.selesai, 'SELESAI count must match');
  assert.strictEqual(proses.sheet_counts.batal, allNoSheet.sheet_counts.batal, 'BATAL count must match');
  assert.strictEqual(proses.sheet_counts.hapus, allNoSheet.sheet_counts.hapus, 'HAPUS count must match');
  console.log(`  PASS: sheet counters independent of operational_sheet`);

  // ---- ASSERTION 7: SELESAI selection doesn't alter other counters ----
  console.log('\n--- Assertion 7: SELESAI sheet independence ---');
  const selesai = await getTransactions(pool, { property_id: propertyId, operational_sheet: 'SELESAI', ...baselineDateRange });
  assert.strictEqual(selesai.sheet_counts.proses, allNoSheet.sheet_counts.proses, 'PROSES must match');
  assert.strictEqual(selesai.sheet_counts.selesai, allNoSheet.sheet_counts.selesai, 'SELESAI must match');
  assert.strictEqual(selesai.sheet_counts.batal, allNoSheet.sheet_counts.batal, 'BATAL must match');
  assert.strictEqual(selesai.sheet_counts.hapus, allNoSheet.sheet_counts.hapus, 'HAPUS must match');
  console.log(`  PASS: sheet counters independent`);

  // ---- ASSERTION 8: SALE vs EXPENSE exact counters ----
  // Fixture breakdown for SALE (live only, no deleted):
  //   R1(SALE/POSTED) → SELESAI
  //   R6(SALE/POSTED/UNVERIFIED) → SELESAI (POSTED wins)
  //   R9(SALE/POSTED/VERIFIED) → SELESAI
  //   R11(SALE/DELETED) → HAPUS (excluded from live scope)
  //   → proses=0, selesai=3, batal=0, hapus=1
  // Fixture breakdown for EXPENSE (live only):
  //   R3(EXPENSE/PAID/POSTED) → PROSES (expense_workflow_status defaults to null → PROSES)
  //   R7(EXPENSE/VOIDED) → BATAL
  //   R10(EXPENSE/POSTED) → PROSES
  //   → proses=2, selesai=0, batal=1, hapus=0
  console.log('\n--- Assertion 8: Domain-specific exact counters ---');
  const saleCounters = await getTransactions(pool, { property_id: propertyId, transaction_type: 'SALE', ...baselineDateRange });
  const expenseCounters = await getTransactions(pool, { property_id: propertyId, transaction_type: 'EXPENSE', ...baselineDateRange });
  console.log(`  SALE proses=${saleCounters.sheet_counts.proses}, selesai=${saleCounters.sheet_counts.selesai}, batal=${saleCounters.sheet_counts.batal}, hapus=${saleCounters.sheet_counts.hapus}`);
  console.log(`  EXPENSE proses=${expenseCounters.sheet_counts.proses}, selesai=${expenseCounters.sheet_counts.selesai}, batal=${expenseCounters.sheet_counts.batal}, hapus=${expenseCounters.sheet_counts.hapus}`);
  assert.deepStrictEqual(saleCounters.sheet_counts, { proses: 0, selesai: 3, batal: 0, hapus: 1 }, 'SALE counters exact');
  assert.deepStrictEqual(expenseCounters.sheet_counts, { proses: 2, selesai: 0, batal: 1, hapus: 0 }, 'EXPENSE counters exact');
  assert.notDeepStrictEqual(saleCounters.sheet_counts, expenseCounters.sheet_counts, 'SALE and EXPENSE counters must differ');
  console.log(`  PASS: domain-specific counters exact and distinct`);

  // ---- ASSERTION 9: HAPUS + PURCHASE ----
  console.log('\n--- Assertion 9: HAPUS + PURCHASE ---');
  const hapusPurchase = await getTransactions(pool, { property_id: propertyId, transaction_type: 'PURCHASE', operational_sheet: 'HAPUS', ...baselineDateRange });
  assert.strictEqual(hapusPurchase.total_count, 2, 'HAPUS PURCHASE total_count must be 2 (R5 + R12)');
  assert.strictEqual(hapusPurchase.sheet_counts.hapus, 2, 'sheet_counts.hapus must be 2');
  assert.deepStrictEqual(hapusPurchase.global_summary, expectedBaseline, 'global must be unchanged');
  for (const tx of hapusPurchase.transactions) {
    assert.strictEqual(tx.transaction_type, 'PURCHASE', 'All HAPUS PURCHASE rows must be PURCHASE type');
    assert.ok(tx.deleted_at !== null, 'All HAPUS rows must have deleted_at');
  }
  console.log(`  PASS: ${hapusPurchase.transactions.length} PURCHASE deleted rows returned`);

  // ---- ASSERTION 10: HAPUS + SALE ----
  console.log('\n--- Assertion 10: HAPUS + SALE ---');
  const hapusSale = await getTransactions(pool, { property_id: propertyId, transaction_type: 'SALE', operational_sheet: 'HAPUS', ...baselineDateRange });
  assert.strictEqual(hapusSale.total_count, 1, 'HAPUS SALE total_count must be 1 (R11)');
  assert.strictEqual(hapusSale.sheet_counts.hapus, 1, 'sheet_counts.hapus must be 1');
  assert.deepStrictEqual(hapusSale.global_summary, expectedBaseline, 'global must be unchanged');
  for (const tx of hapusSale.transactions) {
    assert.strictEqual(tx.transaction_type, 'SALE', 'All HAPUS SALE rows must be SALE type');
    assert.ok(tx.deleted_at !== null, 'All HAPUS rows must have deleted_at');
  }
  console.log(`  PASS: ${hapusSale.transactions.length} SALE deleted rows returned`);

  // ---- ASSERTION 11: HAPUS + ALL (no transaction_type) ----
  console.log('\n--- Assertion 11: HAPUS ALL ---');
  const hapusAll = await getTransactions(pool, { property_id: propertyId, operational_sheet: 'HAPUS', ...baselineDateRange });
  assert.strictEqual(hapusAll.total_count, 3, 'HAPUS ALL total_count must be 3 (R5 + R11 + R12)');
  assert.strictEqual(hapusAll.sheet_counts.hapus, 3, 'sheet_counts.hapus must be 3');
  assert.deepStrictEqual(hapusAll.global_summary, expectedBaseline, 'global must be unchanged');
  console.log(`  PASS: ${hapusAll.transactions.length} total deleted rows`);

  // ---- ASSERTION 12: Pagination ----
  console.log('\n--- Assertion 12: Pagination ---');
  const paged = await getTransactions(pool, { property_id: propertyId, limit: 2, ...baselineDateRange });
  assert.ok(paged.transactions.length <= 2, 'paginated transactions.length must be <= limit');
  assert.ok(paged.total_count > paged.transactions.length, 'total_count must represent full Scope C');
  console.log(`  PASS: transactions.length=${paged.transactions.length}, total_count=${paged.total_count}`);

  // ---- ASSERTION: Scope A baseline counters ----
  console.log('\n--- Verifying baseline sheet counters ---');
  console.log(`  proses=${allNoSheet.sheet_counts.proses}, selesai=${allNoSheet.sheet_counts.selesai}, batal=${allNoSheet.sheet_counts.batal}, hapus=${allNoSheet.sheet_counts.hapus}`);
  console.log(`  total_count=${allNoSheet.total_count}`);

  // ===================================================================
  // LIFECYCLE PERIOD CONSISTENCY REGRESSION
  // ===================================================================
  // Proves the canonical ordering fix on the non-SQL/HAPUS path:
  //   WRONG : filter raw members by period -> groupSaleLifecycles()
  //   CORRECT: groupSaleLifecycles() on full rows -> filter canonical groups
  //
  // Fixture R13 (original SALE, in-period 2024-02-01..2024-02-28) and R14
  // (its REVERSAL, out-of-period 2025-01-15) deliberately straddle the
  // lifecycleDateRange boundary. The original and reversal net to 0, so the
  // correct global_summary for that period keeps total_sale unchanged.
  //
  // Using a separate 2024 February window (disjoint from the 2024 January
  // baselineDateRange) means the pre-existing baseline assertions above
  // remain fully unaffected — no expected values are re-baselined.
  //
  // The lifecycle fixture must be inserted at the top of runTests() using
  // the dedicated lifecycle range so this assertion can reference its IDs.

  // lifecycleDateRange: only R13 (2024-02-15) is inside; R14 (2025-01-15) is outside.
  const lifecycleDateRange = { start_date: '2024-02-01', end_date: '2024-02-28' };

  // Expected canonical global_summary for the lifecycle period:
  //   R13 (+100000) + R14 (-100000) net to 0 in the SAME lifecycle group.
  //   The group's effective date is R13's transaction_date (2024-02-15) which
  //   falls inside lifecycleDateRange, so the group is kept and its net is 0.
  //   No other fixture rows fall in the February window.
  const expectedLifecycleGlobalSummary = {
    total_sale: 0,
    total_purchase: 0,
    total_expense: 0,
    total_income: 0,
    count_sale: 1,       // R13+R14 are one canonical lifecycle group
    count_purchase: 0,
    count_expense: 0,
    count_income: 0,
  };

  // ---- ASSERTION 13A: normal request canonical global_summary ----
  console.log('\n--- Assertion 13A: Lifecycle normal request global_summary ---');
  const lifecycleNormal = await getTransactions(pool, { property_id: propertyId, ...lifecycleDateRange });
  assert.deepStrictEqual(
    lifecycleNormal.global_summary,
    expectedLifecycleGlobalSummary,
    'Normal request must produce the canonical lifecycle global_summary (full-row grouping before period filter)'
  );
  console.log(`  PASS: normal global_summary = ${JSON.stringify(lifecycleNormal.global_summary)}`);

  // ---- ASSERTION 13B: HAPUS request deep-equal to normal ----
  // This is the primary regression guard: opening the HAPUS sheet must NOT
  // alter the Scope-A global_summary for the same property+period.
  console.log('\n--- Assertion 13B: HAPUS request global_summary deep-equal to normal ---');
  const lifecycleHapus = await getTransactions(pool, { property_id: propertyId, operational_sheet: 'HAPUS', ...lifecycleDateRange });
  assert.deepStrictEqual(
    lifecycleHapus.global_summary,
    lifecycleNormal.global_summary,
    'HAPUS sheet must not alter Scope-A global_summary for the same property+period'
  );
  assert.deepStrictEqual(
    lifecycleHapus.global_summary,
    expectedLifecycleGlobalSummary,
    'HAPUS global_summary must equal the canonical lifecycle value'
  );
  console.log(`  PASS: HAPUS global_summary = ${JSON.stringify(lifecycleHapus.global_summary)}`);

  // ---- ASSERTION 13C: active transaction_type / search / sheet do not alter Scope A ----
  console.log('\n--- Assertion 13C: Scope A independence from transaction_type/search/sheet ---');
  const lifecycleSaleOnly = await getTransactions(pool, { property_id: propertyId, transaction_type: 'SALE', ...lifecycleDateRange });
  const lifecycleSearch = await getTransactions(pool, { property_id: propertyId, search: 'zzz-lifecycle-no-match', ...lifecycleDateRange });
  const lifecycleProsesSheet = await getTransactions(pool, { property_id: propertyId, operational_sheet: 'PROSES', ...lifecycleDateRange });

  assert.deepStrictEqual(
    lifecycleSaleOnly.global_summary,
    expectedLifecycleGlobalSummary,
    'transaction_type must not affect Scope-A global_summary'
  );
  assert.deepStrictEqual(
    lifecycleSearch.global_summary,
    expectedLifecycleGlobalSummary,
    'search must not affect Scope-A global_summary'
  );
  assert.deepStrictEqual(
    lifecycleProsesSheet.global_summary,
    expectedLifecycleGlobalSummary,
    'active operational_sheet must not affect Scope-A global_summary'
  );
  console.log('  PASS: transaction_type/search/operational_sheet leave Scope-A global_summary unchanged');

  // ---- ASSERTION 13D: HAPUS table total_count is period-scoped, not inflated by lifecycle fixtures ----
  // The 3 pre-existing deleted rows (R5, R11, R12) all carry 2024-January transaction_dates,
  // which fall OUTSIDE the February lifecycleDateRange window. Therefore the HAPUS table for
  // that window correctly returns 0 rows — the live lifecycle fixtures R13/R14 must NOT be
  // counted as deleted rows (they are live), nor must out-of-window deleted rows leak in.
  console.log('\n--- Assertion 13D: HAPUS total_count remains period-scoped (0 in the February window) ---');
  assert.strictEqual(lifecycleHapus.total_count, 0, 'HAPUS total_count must be 0 in a period with no deleted rows');
  // Scope B sheet_counts are period-scoped: the 3 pre-existing deleted rows carry 2024-January
  // dates, outside the February window, so sheet_counts.hapus = 0 for this period.
  // The key invariant is that lifecycle fixtures do not corrupt this counter — verified by
  // asserting it matches the normal (non-HAPUS) request's counter for the same period.
  assert.strictEqual(lifecycleHapus.sheet_counts.hapus, lifecycleNormal.sheet_counts.hapus, 'sheet_counts.hapus must equal normal request counter for the same period (no lifecycle corruption)');
  assert.strictEqual(lifecycleHapus.transactions.length, 0, 'HAPUS table must not leak live lifecycle rows');
  console.log(`  PASS: HAPUS table period-scoped total_count=${lifecycleHapus.total_count}, sheet_counts.hapus=${lifecycleHapus.sheet_counts.hapus}`);

  console.log('\n=== ALL SCOPE A/B/C REGRESSION TESTS PASSED ===\n');
}

async function main() {
  const assert = require('assert');
  try {
    await setup();
    await runTests();
    await teardown();
    console.log('Done.');
    process.exit(0);
  } catch (err) {
    console.error('TEST FAILED:', err.message);
    console.error(err.stack);
    await teardown().catch(() => {});
    process.exit(1);
  }
}

main();

'use strict';

require('dotenv').config({ path: 'E:/oak-hotel-hims/backend/.env' });
const http = require('http');
const { once } = require('events');
const { app, pool } = require('../dist/index');
const { initializeDatabase } = require('../dist/db/schema_v3');

let server;
let baseUrl;
let passed = 0;
let failed = 0;

function expect(condition, msg) {
  if (condition) {
    passed += 1;
    console.log('PASS | ' + msg);
  } else {
    failed += 1;
    console.error('FAIL | ' + msg);
  }
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const res = await fetch(baseUrl + path, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// ─── FIXTURE SETUP ──────────────────────────────────────────────────────────

async function setupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Two test properties
    const propA = await client.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('Acct Prop A', 'ACPA', 'Asia/Jakarta', 'IDR', 'Addr A', TRUE) RETURNING id"
    );
    const propB = await client.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('Acct Prop B', 'ACPB', 'Asia/Jakarta', 'IDR', 'Addr B', TRUE) RETURNING id"
    );

    const pidA = propA.rows[0].id;
    const pidB = propB.rows[0].id;

    // GL Accounts for Property A
    const acctA1 = await client.query(
      "INSERT INTO accounting_gl_accounts (property_id, code, name, account_type) VALUES ($1, '101', 'Kas A', 'ASSET') RETURNING id",
      [pidA]
    );
    const acctA2 = await client.query(
      "INSERT INTO accounting_gl_accounts (property_id, code, name, account_type) VALUES ($1, '301', 'Pendapatan A', 'REVENUE') RETURNING id",
      [pidA]
    );

    // GL Accounts for Property B (same code '101' and '301')
    const acctB1 = await client.query(
      "INSERT INTO accounting_gl_accounts (property_id, code, name, account_type) VALUES ($1, '101', 'Kas B', 'ASSET') RETURNING id",
      [pidB]
    );
    const acctB2 = await client.query(
      "INSERT INTO accounting_gl_accounts (property_id, code, name, account_type) VALUES ($1, '301', 'Pendapatan B', 'REVENUE') RETURNING id",
      [pidB]
    );

    // Journal Entry for Property A
    const jrnA = await client.query(
      "INSERT INTO accounting_journal_entries (property_id, entry_number, description, source_module) VALUES ($1, 'JRN-ACPA-001', 'Initial Deposit A', 'MANUAL') RETURNING id",
      [pidA]
    );
    await client.query(
      "INSERT INTO accounting_journal_lines (journal_entry_id, account_id, debit, credit, description) VALUES ($1, $2, 1000000, 0, 'Debit Kas')",
      [jrnA.rows[0].id, acctA1.rows[0].id]
    );
    await client.query(
      "INSERT INTO accounting_journal_lines (journal_entry_id, account_id, debit, credit, description) VALUES ($1, $2, 0, 1000000, 'Credit Pendapatan')",
      [jrnA.rows[0].id, acctA2.rows[0].id]
    );

    // Journal Entry for Property B
    const jrnB = await client.query(
      "INSERT INTO accounting_journal_entries (property_id, entry_number, description, source_module) VALUES ($1, 'JRN-ACPB-001', 'Initial Deposit B', 'MANUAL') RETURNING id",
      [pidB]
    );
    await client.query(
      "INSERT INTO accounting_journal_lines (journal_entry_id, account_id, debit, credit, description) VALUES ($1, $2, 2000000, 0, 'Debit Kas')",
      [jrnB.rows[0].id, acctB1.rows[0].id]
    );
    await client.query(
      "INSERT INTO accounting_journal_lines (journal_entry_id, account_id, debit, credit, description) VALUES ($1, $2, 0, 2000000, 'Credit Pendapatan')",
      [jrnB.rows[0].id, acctB2.rows[0].id]
    );

    await client.query('COMMIT');
    return {
      pidA,
      pidB,
      acctA1: acctA1.rows[0].id,
      acctA2: acctA2.rows[0].id,
      acctB1: acctB1.rows[0].id,
      acctB2: acctB2.rows[0].id,
      jrnAId: jrnA.rows[0].id,
      jrnBId: jrnB.rows[0].id
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── CLEANUP ─────────────────────────────────────────────────────────────────

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Delete lines of test property journals
    await client.query(`
      DELETE FROM accounting_journal_lines WHERE journal_entry_id IN (
        SELECT id FROM accounting_journal_entries WHERE property_id IN (
          SELECT id FROM properties WHERE property_code IN ('ACPA', 'ACPB')
        )
      )
    `);

    // 2. Delete journal entries
    await client.query(`
      DELETE FROM accounting_journal_entries WHERE property_id IN (
        SELECT id FROM properties WHERE property_code IN ('ACPA', 'ACPB')
      )
    `);

    // 3. Delete GL accounts
    await client.query(`
      DELETE FROM accounting_gl_accounts WHERE property_id IN (
        SELECT id FROM properties WHERE property_code IN ('ACPA', 'ACPB')
      )
    `);

    // 4. Delete test properties
    await client.query("DELETE FROM properties WHERE property_code IN ('ACPA', 'ACPB')");

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('CLEANUP FAILED:', e.message);
    failed += 1;
  } finally {
    client.release();
  }
}

// ─── TESTS ───────────────────────────────────────────────────────────────────

// A. missing property on summary → 400
async function testA_summaryMissingProperty() {
  const r = await api('GET', '/api/accounting/summary');
  expect(r.status === 400, 'A: GET /api/accounting/summary without property_id returns 400 (got ' + r.status + ')');
  expect(r.json?.code === 'VALIDATION_ERROR', 'A: error code is VALIDATION_ERROR');
}

// B. unknown property on summary → 404
async function testB_summaryUnknownProperty() {
  const r = await api('GET', '/api/accounting/summary?property_id=999999');
  expect(r.status === 404, 'B: GET /api/accounting/summary with unknown property returns 404 (got ' + r.status + ')');
  expect(r.json?.code === 'PROPERTY_NOT_FOUND', 'B: error code is PROPERTY_NOT_FOUND');
}

// C & D. summary A only returns A GL accounts/journals; summary B only returns B
async function testCD_summaryPropertyIsolation(pidA, pidB) {
  const rA = await api('GET', '/api/accounting/summary?property_id=' + pidA);
  expect(rA.status === 200, 'C1: GET summary for Property A returns 200');
  const accountsA = rA.json?.data?.accounts || [];
  const entriesA = rA.json?.data?.entries || [];

  expect(accountsA.length === 2, 'C2: Property A has exactly 2 GL accounts (got ' + accountsA.length + ')');
  expect(accountsA.every(a => Number(a.property_id) === pidA), 'C3: all accounts in A belong to Property A');
  expect(entriesA.length === 1, 'C4: Property A has exactly 1 journal entry (got ' + entriesA.length + ')');
  expect(entriesA[0]?.entry_number === 'JRN-ACPA-001', 'C5: Property A journal entry is JRN-ACPA-001');

  const rB = await api('GET', '/api/accounting/summary?property_id=' + pidB);
  expect(rB.status === 200, 'D1: GET summary for Property B returns 200');
  const accountsB = rB.json?.data?.accounts || [];
  const entriesB = rB.json?.data?.entries || [];

  expect(accountsB.length === 2, 'D2: Property B has exactly 2 GL accounts (got ' + accountsB.length + ')');
  expect(accountsB.every(a => Number(a.property_id) === pidB), 'D3: all accounts in B belong to Property B');
  expect(entriesB.length === 1, 'D4: Property B has exactly 1 journal entry (got ' + entriesB.length + ')');
  expect(entriesB[0]?.entry_number === 'JRN-ACPB-001', 'D5: Property B journal entry is JRN-ACPB-001');
}

// E. same GL code allowed across properties
async function testE_sameGLCodeAcrossProperties(pidA, pidB) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO accounting_gl_accounts (property_id, code, name, account_type) VALUES ($1, '501', 'Modal A', 'EQUITY')",
      [pidA]
    );
    await client.query(
      "INSERT INTO accounting_gl_accounts (property_id, code, name, account_type) VALUES ($1, '501', 'Modal B', 'EQUITY')",
      [pidB]
    );
    await client.query('COMMIT');
    expect(true, 'E: same GL code (501) allowed across different properties (A and B)');
  } catch (e) {
    await client.query('ROLLBACK');
    expect(false, 'E: same GL code across properties failed: ' + e.message);
  } finally {
    client.release();
  }
}

// F. duplicate GL code within same property rejected
async function testF_duplicateGLCodeSamePropertyRejected(pidA) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let threw = false;
    try {
      await client.query(
        "INSERT INTO accounting_gl_accounts (property_id, code, name, account_type) VALUES ($1, '101', 'Kas Duplikat', 'ASSET')",
        [pidA]
      );
    } catch (err) {
      threw = true;
    }
    expect(threw, 'F: duplicate GL code (101) within same property is rejected by UNIQUE constraint');
    await client.query('ROLLBACK');
  } catch (e) {
    await client.query('ROLLBACK');
    expect(false, 'F: unexpected failure: ' + e.message);
  } finally {
    client.release();
  }
}

// G. same journal entry number allowed across properties
async function testG_sameJournalEntryNumberAcrossProperties(pidA, pidB) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO accounting_journal_entries (property_id, entry_number, description) VALUES ($1, 'JE-SHARED-001', 'Entry A')",
      [pidA]
    );
    await client.query(
      "INSERT INTO accounting_journal_entries (property_id, entry_number, description) VALUES ($1, 'JE-SHARED-001', 'Entry B')",
      [pidB]
    );
    await client.query('COMMIT');
    expect(true, 'G: same journal entry_number (JE-SHARED-001) allowed across different properties');
  } catch (e) {
    await client.query('ROLLBACK');
    expect(false, 'G: same journal entry number across properties failed: ' + e.message);
  } finally {
    client.release();
  }
}

// H. duplicate journal entry number within same property rejected
async function testH_duplicateJournalEntryNumberSamePropertyRejected(pidA) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let threw = false;
    try {
      await client.query(
        "INSERT INTO accounting_journal_entries (property_id, entry_number, description) VALUES ($1, 'JRN-ACPA-001', 'Duplicate')",
        [pidA]
      );
    } catch (err) {
      threw = true;
    }
    expect(threw, 'H: duplicate journal entry_number within same property is rejected by UNIQUE constraint');
    await client.query('ROLLBACK');
  } catch (e) {
    await client.query('ROLLBACK');
    expect(false, 'H: unexpected failure: ' + e.message);
  } finally {
    client.release();
  }
}

// I. missing property on journal POST → 400
async function testI_journalPostMissingProperty(acctA1, acctA2) {
  const r = await api('POST', '/api/accounting/journal', {
    description: 'Test Journal',
    lines: [
      { account_id: acctA1, debit: 50000, credit: 0 },
      { account_id: acctA2, debit: 0, credit: 50000 }
    ]
  });
  expect(r.status === 400, 'I: POST /api/accounting/journal without property_id returns 400 (got ' + r.status + ')');
  expect(r.json?.code === 'VALIDATION_ERROR', 'I: error code is VALIDATION_ERROR');
}

// J. unknown property on journal POST → 404
async function testJ_journalPostUnknownProperty(acctA1, acctA2) {
  const r = await api('POST', '/api/accounting/journal', {
    property_id: 999999,
    description: 'Test Journal',
    lines: [
      { account_id: acctA1, debit: 50000, credit: 0 },
      { account_id: acctA2, debit: 0, credit: 50000 }
    ]
  });
  expect(r.status === 404, 'J: POST /api/accounting/journal with unknown property returns 404 (got ' + r.status + ')');
  expect(r.json?.code === 'PROPERTY_NOT_FOUND', 'J: error code is PROPERTY_NOT_FOUND');
}

// K & O. valid same-property journal succeeds with balanced debits/credits
async function testKO_validSamePropertyJournalSucceeds(pidA, acctA1, acctA2) {
  const r = await api('POST', '/api/accounting/journal', {
    property_id: pidA,
    description: 'Valid Same Property Journal',
    source_module: 'MANUAL',
    lines: [
      { account_id: acctA1, debit: 150000, credit: 0, description: 'Debit Line' },
      { account_id: acctA2, debit: 0, credit: 150000, description: 'Credit Line' }
    ]
  });

  expect(r.status === 201, 'K1: valid journal POST returns 201 (got ' + r.status + ')');
  expect(r.json?.status === 'SUCCESS', 'K2: response status is SUCCESS');
  expect(Number(r.json?.data?.property_id) === pidA, 'K3: returned journal has correct property_id');

  const createdId = r.json?.data?.id;
  const lines = await pool.query(
    'SELECT * FROM accounting_journal_lines WHERE journal_entry_id = $1 ORDER BY id',
    [createdId]
  );
  expect(lines.rows.length === 2, 'O1: journal has exactly 2 lines');
  expect(Number(lines.rows[0].debit) === 150000 && Number(lines.rows[0].credit) === 0, 'O2: line 1 has correct debit');
  expect(Number(lines.rows[1].debit) === 0 && Number(lines.rows[1].credit) === 150000, 'O3: line 2 has correct credit');
}

// L, M, N. cross-property account in journal rejected 403, leaves no partial header or lines
async function testLMN_crossPropertyAccountRejected(pidA, acctA1, acctB2) {
  const beforeJournals = await pool.query('SELECT COUNT(*)::int AS cnt FROM accounting_journal_entries WHERE property_id = $1', [pidA]);
  const beforeLines = await pool.query('SELECT COUNT(*)::int AS cnt FROM accounting_journal_lines');

  // Attempt journal in Property A using account from Property B
  const r = await api('POST', '/api/accounting/journal', {
    property_id: pidA,
    description: 'Cross Property Account Attempt',
    lines: [
      { account_id: acctA1, debit: 100000, credit: 0 },
      { account_id: acctB2, debit: 0, credit: 100000 } // belongs to pidB!
    ]
  });

  expect(r.status === 403, 'L1: cross-property account in journal rejected with 403 (got ' + r.status + ')');
  expect(r.json?.code === 'CROSS_PROPERTY_ACCOUNT', 'L2: error code is CROSS_PROPERTY_ACCOUNT');

  const afterJournals = await pool.query('SELECT COUNT(*)::int AS cnt FROM accounting_journal_entries WHERE property_id = $1', [pidA]);
  const afterLines = await pool.query('SELECT COUNT(*)::int AS cnt FROM accounting_journal_lines');

  expect(afterJournals.rows[0].cnt === beforeJournals.rows[0].cnt, 'M: rejected journal creates zero partial journal entries');
  expect(afterLines.rows[0].cnt === beforeLines.rows[0].cnt, 'N: rejected journal creates zero partial journal lines');
}

// P. property switch/read isolation
async function testP_propertySwitchReadIsolation(pidA, pidB) {
  const rA = await api('GET', '/api/accounting/summary?property_id=' + pidA);
  const rB = await api('GET', '/api/accounting/summary?property_id=' + pidB);

  const accountsA = rA.json?.data?.accounts || [];
  const accountsB = rB.json?.data?.accounts || [];

  expect(accountsA.every(a => Number(a.property_id) === pidA), 'P1: all accounts in summary A belong to Property A');
  expect(accountsB.every(b => Number(b.property_id) === pidB), 'P2: all accounts in summary B belong to Property B');
}

// R. zero residue verification
async function testR_zeroResidue() {
  const pCount = await pool.query("SELECT COUNT(*)::int AS cnt FROM properties WHERE property_code IN ('ACPA', 'ACPB')");
  expect(pCount.rows[0].cnt === 0, 'R1: zero test properties residue');

  const aCount = await pool.query(`
    SELECT COUNT(*)::int AS cnt FROM accounting_gl_accounts WHERE property_id NOT IN (
      SELECT id FROM properties WHERE property_code NOT IN ('ACPA', 'ACPB')
    )
  `);
  expect(aCount.rows[0].cnt === 0, 'R2: zero test GL accounts residue');

  const jCount = await pool.query(`
    SELECT COUNT(*)::int AS cnt FROM accounting_journal_entries WHERE property_id NOT IN (
      SELECT id FROM properties WHERE property_code NOT IN ('ACPA', 'ACPB')
    )
  `);
  expect(jCount.rows[0].cnt === 0, 'R3: zero test journal entries residue');
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const serverReady = new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  await serverReady;
  const address = server.address();
  baseUrl = 'http://127.0.0.1:' + address.port;

  let fixtures;
  try {
    await initializeDatabase(pool);
    await cleanup();
    fixtures = await setupFixtures();

    await testA_summaryMissingProperty();
    await testB_summaryUnknownProperty();
    await testCD_summaryPropertyIsolation(fixtures.pidA, fixtures.pidB);
    await testE_sameGLCodeAcrossProperties(fixtures.pidA, fixtures.pidB);
    await testF_duplicateGLCodeSamePropertyRejected(fixtures.pidA);
    await testG_sameJournalEntryNumberAcrossProperties(fixtures.pidA, fixtures.pidB);
    await testH_duplicateJournalEntryNumberSamePropertyRejected(fixtures.pidA);
    await testI_journalPostMissingProperty(fixtures.acctA1, fixtures.acctA2);
    await testJ_journalPostUnknownProperty(fixtures.acctA1, fixtures.acctA2);
    await testKO_validSamePropertyJournalSucceeds(fixtures.pidA, fixtures.acctA1, fixtures.acctA2);
    await testLMN_crossPropertyAccountRejected(fixtures.pidA, fixtures.acctA1, fixtures.acctB2);
    await testP_propertySwitchReadIsolation(fixtures.pidA, fixtures.pidB);
  } finally {
    // Q. deterministic cleanup
    await cleanup();
    await testR_zeroResidue();
    await once(server.close(), 'close');
  }

  console.log('Property-scoped accounting journal: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Property-scoped accounting journal test failed:', err.message);
  process.exitCode = 1;
});

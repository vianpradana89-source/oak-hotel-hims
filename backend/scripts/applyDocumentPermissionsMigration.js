#!/usr/bin/env node
/**
 * applyDocumentPermissionsMigration.js
 *
 * Minimal targeted migration runner for Document & Print permission rows.
 * Created for the Document & Print staging migration preparation phase.
 *
 * Intended environment:
 *   - Staging or development only (never production)
 *   - Connected via Cloud SQL Auth Proxy on localhost (default)
 *   - DB_* env vars required (see below)
 *
 * Required environment variables:
 *   DB_HOST     Default: 127.0.0.1
 *   DB_PORT     Default: 5432
 *   DB_USER     REQUIRED
 *   DB_PASSWORD REQUIRED
 *   DB_NAME     REQUIRED
 *
 * Mode control:
 *   CONFIRM_DOCUMENT_PERMISSIONS_MIGRATION=YES   Apply mode (write)
 *   (unset or any other value)                   Dry-run mode (verify-only)
 *
 * This script is idempotent and non-destructive:
 *   - INSERT ... ON CONFLICT (key) DO NOTHING
 *   - Skips cleanly if all four permission keys already exist
 *   - Inserts only missing keys if partial state detected
 *   - Rolls back entirely on any error
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ─── Hard-fail: NEVER run against production ────────────────────────────────
const nodeEnv = (process.env.NODE_ENV || '').trim().toLowerCase();
if (nodeEnv === 'production') {
  console.error(
    '[DOCUMENT PERMISSIONS MIGRATION] HARD FAIL: NODE_ENV=production detected.\n' +
    '  This script MUST NOT run against a production database.\n' +
    '  Abort.'
  );
  process.exit(1);
}

// ─── Resolve migration SQL ──────────────────────────────────────────────────
const MIGRATION_FILE = path.resolve(
  __dirname,
  '..',
  'src',
  'db',
  'migrations',
  'doc_1b_2b_documents_permission_rows.sql'
);

let migrationSQL;
try {
  migrationSQL = fs.readFileSync(MIGRATION_FILE, 'utf8');
} catch (err) {
  console.error(
    `[DOCUMENT PERMISSIONS MIGRATION] HARD FAIL: Migration file not found at:\n  ${MIGRATION_FILE}\n` +
    `  ${err.message}`
  );
  process.exit(1);
}

// ─── Verify migration contains ONLY intended safe DDL ───────────────────────
const safePatterns = [
  /INSERT\s+INTO/i,
  /ON\s+CONFLICT.*DO\s+NOTHING/i,
  /SELECT\s+1/i,
];

const destructivePatterns = [
  /DROP\s+/i,
  /TRUNCATE\s+/i,
  /DELETE\s+FROM\s+/i,
  /ALTER\s+TABLE/i,
  /UPDATE\s+\w+\s+SET/i,
];

const forbiddenMatches = [];
for (const pattern of destructivePatterns) {
  const matches = migrationSQL.match(pattern);
  if (matches) {
    forbiddenMatches.push(matches[0]);
  }
}

if (forbiddenMatches.length > 0) {
  console.error(
    '[DOCUMENT PERMISSIONS MIGRATION] HARD FAIL: Migration file contains unexpected statements:\n' +
    '  ' + forbiddenMatches.join('\n  ') + '\n' +
    '  Abort.'
  );
  process.exit(1);
}

// ─── Verify DB env vars ─────────────────────────────────────────────────────
const dbHost = (process.env.DB_HOST || '127.0.0.1').trim();
const dbPort = parseInt(process.env.DB_PORT || '5432', 10);
const dbUser = (process.env.DB_USER || '').trim();
const dbPassword = process.env.DB_PASSWORD || '';
const dbName = (process.env.DB_NAME || '').trim();

const missingVars = [];
if (!dbUser) missingVars.push('DB_USER');
if (!dbPassword) missingVars.push('DB_PASSWORD');
if (!dbName) missingVars.push('DB_NAME');

if (missingVars.length > 0) {
  console.error(
    '[DOCUMENT PERMISSIONS MIGRATION] Missing required environment variables:\n' +
    '  ' + missingVars.join('\n  ') + '\n' +
    '  Set them before running this script.'
  );
  process.exit(1);
}

// ─── Verify host is localhost / Cloud SQL proxy ─────────────────────────────
const ALLOWED_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
if (!ALLOWED_LOCAL_HOSTS.has(dbHost)) {
  console.error(
    '[DOCUMENT PERMISSIONS MIGRATION] HARD FAIL: DB_HOST is not a local address.\n' +
    `  Current DB_HOST: ${dbHost}\n` +
    '  Allowed values: localhost, 127.0.0.1, ::1\n' +
    '  Use Cloud SQL Auth Proxy and set DB_HOST=127.0.0.1.'
  );
  process.exit(1);
}

// ─── Define expected permission keys ────────────────────────────────────────
const EXPECTED_KEYS = ['documents.view', 'documents.create', 'documents.edit', 'documents.delete'];

// ─── Mode control ───────────────────────────────────────────────────────────
const confirmFlag = (process.env.CONFIRM_DOCUMENT_PERMISSIONS_MIGRATION || '').trim();
const isApplyMode = confirmFlag === 'YES';
const modeLabel = isApplyMode ? 'APPLY' : 'DRY-RUN';

console.log(`[DOCUMENT PERMISSIONS MIGRATION] Mode: ${modeLabel}`);
console.log(`[DOCUMENT PERMISSIONS MIGRATION] Target DB: ${dbName}@${dbHost}:${dbPort}`);
console.log(`[DOCUMENT PERMISSIONS MIGRATION] Migration file: ${MIGRATION_FILE}`);
console.log(`[DOCUMENT PERMISSIONS MIGRATION] Migration version: doc_1b_2b_documents_permission_rows_v1`);

if (!isApplyMode) {
  console.log(
    '[DOCUMENT PERMISSIONS MIGRATION] DRY-RUN active. No database changes will be made.\n' +
    '  To apply, set CONFIRM_DOCUMENT_PERMISSIONS_MIGRATION=YES and re-run.'
  );
}

// ─── Connect to database ────────────────────────────────────────────────────
const pool = new Pool({
  host: dbHost,
  port: dbPort,
  user: dbUser,
  password: dbPassword,
  database: dbName,
  connectionTimeoutMillis: 10000,
});

async function run() {
  let client;
  try {
    client = await pool.connect();

    // ─── Pre-flight: check which keys already exist ─────────────────────
    const existingCheck = await client.query(
      `SELECT key FROM permissions WHERE key = ANY($1::text[])`,
      [EXPECTED_KEYS]
    );
    const existingKeys = new Set(existingCheck.rows.map((row) => row.key));

    const missingKeys = EXPECTED_KEYS.filter((k) => !existingKeys.has(k));

    if (missingKeys.length === 0) {
      console.log(
        '[DOCUMENT PERMISSIONS MIGRATION] ALREADY_APPLIED\n' +
        '  All four permission keys already exist:\n' +
        '  ' + EXPECTED_KEYS.join(', ') + '\n' +
        '  No migration needed.'
      );
      return;
    }

    console.log(
      '[DOCUMENT PERMISSIONS MIGRATION] Detected state:\n' +
      `  Existing: ${[...existingKeys].join(', ') || '(none)'}\n` +
      `  Missing:  ${missingKeys.join(', ')}`
    );

    if (!isApplyMode) {
      console.log(
        '[DOCUMENT PERMISSIONS MIGRATION] DRY-RUN: Would execute the following SQL if CONFIRM_DOCUMENT_PERMISSIONS_MIGRATION=YES:\n' +
        migrationSQL.trim()
      );
      return;
    }

    // ─── Apply migration inside a transaction ───────────────────────────
    console.log('[DOCUMENT PERMISSIONS MIGRATION] Applying migration...');
    await client.query('BEGIN');

    try {
      await client.query(migrationSQL);
      await client.query('COMMIT');
      console.log('[DOCUMENT PERMISSIONS MIGRATION] SQL executed successfully.');
    } catch (ddlErr) {
      await client.query('ROLLBACK');
      throw ddlErr;
    }

    // ─── Post-flight: verify all four keys exist ────────────────────────
    const verifyCheck = await client.query(
      `SELECT key FROM permissions WHERE key = ANY($1::text[]) ORDER BY key`,
      [EXPECTED_KEYS]
    );
    const verifiedKeys = new Set(verifyCheck.rows.map((row) => row.key));

    const stillMissing = EXPECTED_KEYS.filter((k) => !verifiedKeys.has(k));
    if (stillMissing.length > 0) {
      throw new Error(
        `Post-migration verification failed: missing keys still not present: ${stillMissing.join(', ')}`
      );
    }

    console.log(
      '[DOCUMENT PERMISSIONS MIGRATION] Verified: all four permission keys exist:\n' +
      '  ' + [...verifiedKeys].join(', ')
    );
    console.log('[DOCUMENT PERMISSIONS MIGRATION] Done.');

  } catch (err) {
    console.error('[DOCUMENT PERMISSIONS MIGRATION] ERROR:', err.message);
    process.exit(1);
  } finally {
    if (client) client.release();
  }
}

run();

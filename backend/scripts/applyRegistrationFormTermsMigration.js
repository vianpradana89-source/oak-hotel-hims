#!/usr/bin/env node
/**
 * applyRegistrationFormTermsMigration.js
 *
 * Minimal targeted migration runner for property_registration_form_terms table.
 * Created for the Structured Registration Form Terms feature.
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
 *   CONFIRM_REGISTRATION_FORM_TERMS_MIGRATION=YES   Apply mode (write)
 *   (unset or any other value)                      Dry-run mode (verify-only)
 *
 * This script is idempotent and non-destructive:
 *   - CREATE TABLE IF NOT EXISTS
 *   - CREATE INDEX IF NOT EXISTS
 *   - Skips cleanly if table already exists
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
    '[REGISTRATION FORM TERMS MIGRATION] HARD FAIL: NODE_ENV=production detected.\n' +
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
  'doc_1c_registration_form_terms.sql'
);

let migrationSQL;
try {
  migrationSQL = fs.readFileSync(MIGRATION_FILE, 'utf8');
} catch (err) {
  console.error(
    `[REGISTRATION FORM TERMS MIGRATION] HARD FAIL: Migration file not found at:\n  ${MIGRATION_FILE}\n` +
    `  ${err.message}`
  );
  process.exit(1);
}

// ─── Verify migration contains ONLY intended DDL ────────────────────────────
const destructivePatterns = [
  /DROP\s+TABLE/i,
  /TRUNCATE\s+/i,
  /DELETE\s+FROM\s+/i,
  /UPDATE\s+\w+\s+SET/i,
  /INSERT\s+INTO/i,
  /ALTER\s+TABLE/i,
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
    '[REGISTRATION FORM TERMS MIGRATION] HARD FAIL: Migration file contains unexpected statements:\n' +
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
    '[REGISTRATION FORM TERMS MIGRATION] Missing required environment variables:\n' +
    '  ' + missingVars.join('\n  ') + '\n' +
    '  Set them before running this script.'
  );
  process.exit(1);
}

// ─── Verify host is localhost / Cloud SQL proxy ─────────────────────────────
const ALLOWED_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
if (!ALLOWED_LOCAL_HOSTS.has(dbHost)) {
  console.error(
    '[REGISTRATION FORM TERMS MIGRATION] HARD FAIL: DB_HOST is not a local address.\n' +
    `  Current DB_HOST: ${dbHost}\n` +
    '  Allowed values: localhost, 127.0.0.1, ::1\n' +
    '  Use Cloud SQL Auth Proxy and set DB_HOST=127.0.0.1.'
  );
  process.exit(1);
}

// ─── Mode control ───────────────────────────────────────────────────────────
const confirmFlag = (process.env.CONFIRM_REGISTRATION_FORM_TERMS_MIGRATION || '').trim();
const isApplyMode = confirmFlag === 'YES';
const modeLabel = isApplyMode ? 'APPLY' : 'DRY-RUN';

console.log('[REGISTRATION FORM TERMS MIGRATION] Mode: ' + modeLabel);
console.log('[REGISTRATION FORM TERMS MIGRATION] Target DB: ' + dbName + '@' + dbHost + ':' + dbPort);
console.log('[REGISTRATION FORM TERMS MIGRATION] Migration file: ' + MIGRATION_FILE);
console.log('[REGISTRATION FORM TERMS MIGRATION] Migration version: doc_1c_registration_form_terms_v1');

if (!isApplyMode) {
  console.log(
    '[REGISTRATION FORM TERMS MIGRATION] DRY-RUN active. No database changes will be made.\n' +
    '  To apply, set CONFIRM_REGISTRATION_FORM_TERMS_MIGRATION=YES and re-run.'
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

    // ─── Pre-flight: check if table already exists ───────────────────────
    const regclassCheck = await client.query(
      "SELECT to_regclass('public.property_registration_form_terms') AS tbl"
    );
    const tableExists = (regclassCheck.rows[0]?.tbl || null) === 'property_registration_form_terms';

    if (tableExists) {
      console.log(
        '[REGISTRATION FORM TERMS MIGRATION] Table public.property_registration_form_terms already exists.\n' +
        '  ALREADY_PRESENT — no migration needed.'
      );
      return;
    }

    if (!isApplyMode) {
      console.log(
        '[REGISTRATION FORM TERMS MIGRATION] DRY-RUN: Table does not exist.\n' +
        '  Would execute the following DDL if CONFIRM_REGISTRATION_FORM_TERMS_MIGRATION=YES:\n' +
        migrationSQL.trim()
      );
      return;
    }

    // ─── Apply migration inside a transaction ────────────────────────────
    console.log('[REGISTRATION FORM TERMS MIGRATION] Applying migration...');
    await client.query('BEGIN');

    try {
      await client.query(migrationSQL);
      await client.query('COMMIT');
      console.log('[REGISTRATION FORM TERMS MIGRATION] DDL executed successfully.');
    } catch (ddlErr) {
      await client.query('ROLLBACK');
      throw ddlErr;
    }

    // ─── Post-flight: verify table exists ────────────────────────────────
    const verifyCheck = await client.query(
      "SELECT to_regclass('public.property_registration_form_terms') AS tbl"
    );
    const verifyResult = verifyCheck.rows[0]?.tbl || null;

    if (verifyResult !== 'property_registration_form_terms') {
      throw new Error(
        `Post-migration verification failed: expected 'property_registration_form_terms', got '${verifyResult}'`
      );
    }

    console.log('[REGISTRATION FORM TERMS MIGRATION] Verified: table public.property_registration_form_terms exists.');
    console.log('[REGISTRATION FORM TERMS MIGRATION] Done.');

  } catch (err) {
    console.error('[REGISTRATION FORM TERMS MIGRATION] ERROR:', err.message);
    process.exit(1);
  } finally {
    if (client) client.release();
  }
}

run();

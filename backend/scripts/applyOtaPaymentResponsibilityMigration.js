#!/usr/bin/env node
/**
 * One-off targeted migration: OTA Payment Responsibility Foundation (Phase 1).
 *
 * Migration version: ota_payment_responsibility_v1
 *
 * What it does:
 * - Adds `payment_responsibility` column to `bookings` (nullable initially, then backfilled).
 * - Adds a CHECK constraint restricting values to 'HOTEL_COLLECT' | 'OTA_COLLECT'.
 * - Backfills all existing rows with 'HOTEL_COLLECT'.
 *
 * Run against the active database via:
 *   DB_HOST=<host> DB_PORT=<port> DB_USER=<user> DB_PASSWORD=<pass> DB_NAME=<name> \
 *   node scripts/applyOtaPaymentResponsibilityMigration.js
 *
 * All five DB_* env variables are REQUIRED — no fallback defaults.
 *
 * Idempotent: safe to run multiple times. Skips if already applied.
 * Safety: NEVER drops or truncates existing data. Only ALTER IF NOT EXISTS.
 */
require('dotenv').config();
const { Pool } = require('pg');

// ── 0. Require all DB env vars — no fallbacks ──────────────────────
const MISSING = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']
  .filter(k => !process.env[k] || !process.env[k].trim());

if (MISSING.length > 0) {
  console.error('[OTA PAYMENT RESPONSIBILITY MIGRATION] Missing required environment variables:');
  console.error('  ' + MISSING.join(', '));
  process.exit(1);
}

const pool = new Pool({
  host:     process.env.DB_HOST.trim(),
  port:     parseInt(process.env.DB_PORT, 10),
  user:     process.env.DB_USER.trim(),
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME.trim()
});

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Ensure schema_migrations table exists ────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    VARCHAR(100) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── 2. Check if already applied ─────────────────────────────────
    const already = await client.query(
      "SELECT 1 FROM schema_migrations WHERE version = $1",
      ['ota_payment_responsibility_v1']
    );
    if ((already.rowCount ?? 0) > 0) {
      console.log('[OTA PAYMENT RESPONSIBILITY MIGRATION] ota_payment_responsibility_v1 is already applied — re-verifying integrity …');
      await verifyIntegrity(client);
      await client.query('COMMIT');
      console.log('[OTA PAYMENT RESPONSIBILITY MIGRATION] ✅ Re-verification passed. Nothing to do.');
      return;
    }

    // ── 3. Add payment_responsibility column (nullable initially) ───
    await client.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS payment_responsibility VARCHAR(20) NULL
    `);
    console.log('[BOOKINGS] Column payment_responsibility ensured (nullable).');

    // ── 4. Backfill existing rows ──────────────────────────────────
    const backfillResult = await client.query(`
      UPDATE bookings
      SET payment_responsibility = 'HOTEL_COLLECT'
      WHERE payment_responsibility IS NULL
    `);
    console.log(`[BOOKINGS] Backfilled ${backfillResult.rowCount ?? 0} existing rows → HOTEL_COLLECT.`);

    // ── 5. Add CHECK constraint (safe: DO ... EXCEPTION) ────────────
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE bookings
          ADD CONSTRAINT bookings_payment_responsibility_chk
          CHECK (payment_responsibility IN ('HOTEL_COLLECT', 'OTA_COLLECT'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    console.log('[BOOKINGS] CHECK constraint bookings_payment_responsibility_chk ensured.');

    // ── 6. Set default on the column ───────────────────────────────
    await client.query(`
      ALTER TABLE bookings
        ALTER COLUMN payment_responsibility SET DEFAULT 'HOTEL_COLLECT';
    `);
    console.log('[BOOKINGS] Default value set to HOTEL_COLLECT.');

    // ── 7. Make column NOT NULL (after backfill ensures no NULLs) ───
    await client.query(`
      ALTER TABLE bookings
        ALTER COLUMN payment_responsibility SET NOT NULL;
    `);
    console.log('[BOOKINGS] Column payment_responsibility set to NOT NULL.');

    // ── 8. Full integrity verification ─────────────────────────────
    await verifyIntegrity(client);
    console.log('[INTEGRITY] ✅ All checks passed');

    // ── 9. Write migration marker LAST (only after everything succeeds) ──
    await client.query(
      "INSERT INTO schema_migrations (version) VALUES ($1)",
      ['ota_payment_responsibility_v1']
    );
    console.log('[MIGRATION] Marked ota_payment_responsibility_v1 as applied');

    await client.query('COMMIT');
    console.log('[OTA PAYMENT RESPONSIBILITY MIGRATION] ✅ Committed successfully.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[OTA PAYMENT RESPONSIBILITY MIGRATION] ❌ Failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

// ── Integrity verification helper ──────────────────────────────────
async function verifyIntegrity(client) {
  const errors = [];

  // Column exists and is NOT NULL
  const colCheck = await client.query(`
    SELECT is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'bookings'
      AND column_name  = 'payment_responsibility'
  `);
  if ((colCheck.rowCount ?? 0) === 0) {
    errors.push('bookings.payment_responsibility column missing');
  } else {
    const row = colCheck.rows[0];
    // Check NOT NULL: is_nullable must be 'NO'
    if (row.is_nullable !== 'NO') {
      errors.push(`bookings.payment_responsibility is not NOT NULL (is_nullable=${row.is_nullable})`);
    }
    // Check default
    const defVal = row.column_default;
    if (defVal !== "'HOTEL_COLLECT'::character varying") {
      errors.push(`bookings.payment_responsibility default mismatch: got ${defVal}, expected 'HOTEL_COLLECT'`);
    }
  }

  // CHECK constraint exists
  const chkCheck = await client.query(`
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'bookings'::regclass
      AND conname = 'bookings_payment_responsibility_chk'
  `);
  if ((chkCheck.rowCount ?? 0) === 0) {
    errors.push('CHECK constraint bookings_payment_responsibility_chk missing');
  }

  // No NULL rows remain
  const nullCount = await client.query(`
    SELECT COUNT(*) FROM bookings WHERE payment_responsibility IS NULL
  `);
  if ((nullCount.rows[0].count ?? 0) > 0) {
    errors.push(`${nullCount.rows[0].count} booking rows still have NULL payment_responsibility`);
  }

  // No invalid values
  const invalidCount = await client.query(`
    SELECT COUNT(*) FROM bookings
    WHERE payment_responsibility NOT IN ('HOTEL_COLLECT', 'OTA_COLLECT')
  `);
  if ((invalidCount.rows[0].count ?? 0) > 0) {
    errors.push(`${invalidCount.rows[0].count} booking rows have invalid payment_responsibility`);
  }

  if (errors.length > 0) {
    console.error('[INTEGRITY] ERRORS:', errors);
    throw new Error('Integrity check failed — see above');
  }
}

run();

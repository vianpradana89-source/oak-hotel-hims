#!/usr/bin/env node
/**
 * One-off targeted migration: OTA Booking Evidence Foundation.
 *
 * Migration version: ota_booking_evidence_v1
 *
 * Purpose:
 * - Creates canonical booking_evidences storage metadata.
 * - Keeps OTA voucher evidence separate from hotel payment evidence.
 * - Does NOT create or modify payment transactions.
 * - Does NOT change amount_paid or payment_method semantics.
 *
 * All five DB_* environment variables are REQUIRED.
 *
 * Idempotent: safe to run multiple times.
 * Safety: never drops or truncates existing data.
 */
require('dotenv').config();
const { Pool } = require('pg');

const MIGRATION_VERSION = 'ota_booking_evidence_v1';

const MISSING = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']
  .filter((key) => !process.env[key] || !process.env[key].trim());

if (MISSING.length > 0) {
  console.error('[OTA BOOKING EVIDENCE MIGRATION] Missing required environment variables:');
  console.error('  ' + MISSING.join(', '));
  process.exit(1);
}

const pool = new Pool({
  host: process.env.DB_HOST.trim(),
  port: parseInt(process.env.DB_PORT, 10),
  user: process.env.DB_USER.trim(),
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME.trim()
});

async function verifyIntegrity(client) {
  const errors = [];

  const tableCheck = await client.query(`
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'booking_evidences'
  `);

  if ((tableCheck.rowCount ?? 0) === 0) {
    errors.push('booking_evidences table missing');
  }

  const bookingFkCheck = await client.query(`
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'booking_evidences'::regclass
      AND conname = 'booking_evidences_booking_fk'
  `);

  if ((bookingFkCheck.rowCount ?? 0) === 0) {
    errors.push('booking_evidences_booking_fk missing');
  }

  const propertyFkCheck = await client.query(`
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'booking_evidences'::regclass
      AND conname = 'booking_evidences_property_fk'
  `);

  if ((propertyFkCheck.rowCount ?? 0) === 0) {
    errors.push('booking_evidences_property_fk missing');
  }

  const typeCheck = await client.query(`
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'booking_evidences'::regclass
      AND conname = 'booking_evidences_type_chk'
  `);

  if ((typeCheck.rowCount ?? 0) === 0) {
    errors.push('booking_evidences_type_chk missing');
  }

  const invalidTypeCount = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM booking_evidences
    WHERE evidence_type <> 'OTA_VOUCHER'
  `);

  if (Number(invalidTypeCount.rows[0]?.count || 0) > 0) {
    errors.push(`${invalidTypeCount.rows[0].count} booking_evidences rows have invalid evidence_type`);
  }

  const invalidSizeCount = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM booking_evidences
    WHERE file_size_bytes <= 0
  `);

  if (Number(invalidSizeCount.rows[0]?.count || 0) > 0) {
    errors.push(`${invalidSizeCount.rows[0].count} booking_evidences rows have invalid file_size_bytes`);
  }

  if (errors.length > 0) {
    console.error('[INTEGRITY] ERRORS:', errors);
    throw new Error('Integrity check failed - see above');
  }
}

async function ensureRuntimePrivileges(client) {
  await client.query(`
    GRANT SELECT, INSERT, UPDATE
    ON TABLE booking_evidences
    TO oak_app
  `);

  await client.query(`
    GRANT USAGE, SELECT
    ON SEQUENCE booking_evidences_id_seq
    TO oak_app
  `);

  console.log('[BOOKING EVIDENCES] Runtime privileges ensured for oak_app.');
}

async function run() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(100) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const already = await client.query(
      'SELECT 1 FROM schema_migrations WHERE version = $1',
      [MIGRATION_VERSION]
    );

    if ((already.rowCount ?? 0) > 0) {
      console.log(`[OTA BOOKING EVIDENCE MIGRATION] ${MIGRATION_VERSION} already applied - re-verifying integrity...`);
      await ensureRuntimePrivileges(client);
      await verifyIntegrity(client);
      await client.query('COMMIT');
      console.log('[OTA BOOKING EVIDENCE MIGRATION] Re-verification passed. Nothing to do.');
      return;
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS booking_evidences (
        id BIGSERIAL PRIMARY KEY,
        property_id INTEGER NOT NULL,
        booking_id BIGINT NOT NULL,
        evidence_type VARCHAR(50) NOT NULL,
        storage_key VARCHAR(500) NOT NULL,
        original_filename VARCHAR(255) NOT NULL,
        mime_type VARCHAR(100) NOT NULL,
        file_size_bytes BIGINT NOT NULL,
        note TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        uploaded_by_user_id VARCHAR(100),
        uploaded_by_name_snapshot VARCHAR(150),
        uploaded_by_role_snapshot VARCHAR(100),
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT booking_evidences_property_fk
          FOREIGN KEY (property_id)
          REFERENCES properties(id)
          ON DELETE RESTRICT,

        CONSTRAINT booking_evidences_booking_fk
          FOREIGN KEY (booking_id)
          REFERENCES bookings(id)
          ON DELETE RESTRICT,

        CONSTRAINT booking_evidences_type_chk
          CHECK (evidence_type IN ('OTA_VOUCHER')),

        CONSTRAINT booking_evidences_file_size_chk
          CHECK (file_size_bytes > 0)
      )
    `);

    console.log('[BOOKING EVIDENCES] Table ensured.');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_booking_evidences_booking
        ON booking_evidences (property_id, booking_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_booking_evidences_type_active
        ON booking_evidences (booking_id, evidence_type, is_active)
    `);

    console.log('[BOOKING EVIDENCES] Indexes ensured.');

    await ensureRuntimePrivileges(client);
    await verifyIntegrity(client);
    console.log('[INTEGRITY] All checks passed.');

    await client.query(
      'INSERT INTO schema_migrations (version) VALUES ($1)',
      [MIGRATION_VERSION]
    );

    console.log(`[MIGRATION] Marked ${MIGRATION_VERSION} as applied.`);

    await client.query('COMMIT');
    console.log('[OTA BOOKING EVIDENCE MIGRATION] Committed successfully.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[OTA BOOKING EVIDENCE MIGRATION] Failed:', err?.message || err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
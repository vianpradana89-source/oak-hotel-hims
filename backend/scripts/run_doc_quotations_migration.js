#!/usr/bin/env node
/**
 * Runner untuk migrasi doc_quotations_v1
 * 
 * Penggunaan:
 *   node backend/scripts/run_doc_quotations_migration.js --apply
 * atau dengan env:
 *   DB_HOST=... DB_PORT=... DB_USER=... DB_PASSWORD=... DB_NAME=... node backend/scripts/run_doc_quotations_migration.js --apply
 */

const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const argv = process.argv.slice(2);
const isApply = argv.includes('--apply');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db',
});

async function run() {
  const client = await pool.connect();
  try {
    console.log('[DOC QUOTATIONS MIGRATION] Connected to database:', process.env.DB_NAME || 'oak_hotel_db');

    const check = await client.query("SELECT 1 FROM schema_migrations WHERE version = 'doc_quotations_v1'");
    if ((check.rowCount ?? 0) > 0) {
      console.log('[DOC QUOTATIONS MIGRATION] Already applied (marker doc_quotations_v1 exists).');
      return;
    }

    if (!isApply) {
      console.log('[DOC QUOTATIONS MIGRATION] Dry run: migration is needed. Pass --apply to execute.');
      return;
    }

    console.log('[DOC QUOTATIONS MIGRATION] Applying migration doc_quotations_v1...');
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('oak_hims_migration_doc_quotations_v1'))");

    await client.query(`
      CREATE TABLE IF NOT EXISTS quotations (
        id BIGSERIAL PRIMARY KEY,
        property_id INT NOT NULL REFERENCES properties(id),
        quotation_number VARCHAR(50) NOT NULL,
        customer_name VARCHAR(150) NOT NULL,
        customer_email VARCHAR(150),
        customer_phone VARCHAR(50),
        customer_address TEXT,
        check_in_date DATE,
        check_out_date DATE,
        status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
        total_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
        version INT NOT NULL DEFAULT 1,
        notes TEXT,
        terms_conditions TEXT,
        created_by INT REFERENCES users(id),
        updated_by INT REFERENCES users(id),
        deleted_by INT REFERENCES users(id),
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_quotations_property_number UNIQUE (property_id, quotation_number)
      );

      ALTER TABLE quotations ADD COLUMN IF NOT EXISTS customer_email VARCHAR(150);
      ALTER TABLE quotations ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(50);
      ALTER TABLE quotations ADD COLUMN IF NOT EXISTS customer_address TEXT;
      ALTER TABLE quotations ADD COLUMN IF NOT EXISTS check_in_date DATE;
      ALTER TABLE quotations ADD COLUMN IF NOT EXISTS check_out_date DATE;
      ALTER TABLE quotations ADD COLUMN IF NOT EXISTS total_amount NUMERIC(15,2) NOT NULL DEFAULT 0;
      ALTER TABLE quotations ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;
      ALTER TABLE quotations ADD COLUMN IF NOT EXISTS notes TEXT;
      ALTER TABLE quotations ADD COLUMN IF NOT EXISTS terms_conditions TEXT;
      ALTER TABLE quotations ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(id);
      ALTER TABLE quotations ADD COLUMN IF NOT EXISTS updated_by INT REFERENCES users(id);
      ALTER TABLE quotations ADD COLUMN IF NOT EXISTS deleted_by INT REFERENCES users(id);
      ALTER TABLE quotations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

      CREATE TABLE IF NOT EXISTS quotation_revisions (
        id BIGSERIAL PRIMARY KEY,
        quotation_id BIGINT NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
        revision_number INT NOT NULL,
        revision_label VARCHAR(10) NOT NULL,
        snapshot JSONB NOT NULL,
        change_summary TEXT,
        created_by INT REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_quotation_revision UNIQUE (quotation_id, revision_number)
      );

      CREATE INDEX IF NOT EXISTS idx_quotations_property_status ON quotations (property_id, status);
      CREATE INDEX IF NOT EXISTS idx_quotations_number ON quotations (quotation_number);
      CREATE INDEX IF NOT EXISTS idx_quotations_customer ON quotations (customer_name);
      CREATE INDEX IF NOT EXISTS idx_quotation_revisions_quotation ON quotation_revisions (quotation_id, revision_number DESC);

      INSERT INTO permissions (resource, action, key, description, is_system)
      VALUES 
        ('documents', 'view',    'documents.view',    'Hak akses VIEW pada modul documents', TRUE),
        ('documents', 'create',  'documents.create',  'Hak akses CREATE pada modul documents', TRUE),
        ('documents', 'edit',    'documents.edit',    'Hak akses EDIT pada modul documents', TRUE),
        ('documents', 'delete',  'documents.delete',  'Hak akses DELETE pada modul documents', TRUE)
      ON CONFLICT (key) DO NOTHING;

      INSERT INTO role_permissions (role_id, permission_id, granted, created_by)
      SELECT r.id, p.id, TRUE, 'MIGRATION_DOC_QUOTATIONS'
      FROM roles r
      CROSS JOIN permissions p
      WHERE r.id IN (1, 2, 5)
        AND p.key IN ('documents.view', 'documents.create', 'documents.edit', 'documents.delete')
      ON CONFLICT DO NOTHING;

      INSERT INTO schema_migrations (version)
      VALUES ('doc_quotations_v1')
      ON CONFLICT (version) DO NOTHING;
    `);

    await client.query('COMMIT');
    console.log('[DOC QUOTATIONS MIGRATION] Migration applied successfully!');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[DOC QUOTATIONS MIGRATION] Error applying migration:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();

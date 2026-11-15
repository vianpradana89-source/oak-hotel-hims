/**
 * MIGRATION: doc_quotations_v1
 * 
 * Menambahkan tabel persistensi penawaran harga (Quotation):
 * - `quotations`: header data penawaran harga mandiri, terisolasi per properti,
 *   nomor unik server `QT-${prop}-${YYMMDD}-${seq4}`, soft delete status, optimistic concurrency version.
 * - `quotation_revisions`: snapshot JSONB lengkap per revisi (R1, R2, dst), tidak bisa ditimpa.
 * - Role permissions untuk Super Admin (1), Hotel Manager (2), Front Desk (5).
 * 
 * Idempoten: aman dijalankan berulang kali. Menggunakan advisory lock untuk mencegah race condition.
 */

import { PoolClient } from 'pg';

export const DOC_QUOTATIONS_MARKER = 'doc_quotations_v1';

export async function checkDocQuotationsPrerequisites(client: PoolClient): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];
  const res = await client.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_name IN ('schema_migrations', 'properties', 'users', 'roles', 'permissions', 'role_permissions')
  `);
  const found = new Set(res.rows.map((r: any) => r.table_name));
  for (const t of ['schema_migrations', 'properties', 'users', 'roles', 'permissions', 'role_permissions']) {
    if (!found.has(t)) {
      errors.push(`Prerequisite table missing: ${t}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export async function runDocQuotationsMigration(client: PoolClient): Promise<{ applied: boolean; marker: string }> {
  // 1. Check if already applied
  const checkMarker = await client.query(
    'SELECT 1 FROM schema_migrations WHERE version = $1',
    [DOC_QUOTATIONS_MARKER]
  );
  if ((checkMarker.rowCount ?? 0) > 0) {
    return { applied: false, marker: DOC_QUOTATIONS_MARKER };
  }

  // 2. Advisory lock for migration safety
  await client.query("SELECT pg_advisory_xact_lock(hashtext('oak_hims_migration_doc_quotations_v1'))");

  // Re-check under lock
  const recheck = await client.query(
    'SELECT 1 FROM schema_migrations WHERE version = $1',
    [DOC_QUOTATIONS_MARKER]
  );
  if ((recheck.rowCount ?? 0) > 0) {
    return { applied: false, marker: DOC_QUOTATIONS_MARKER };
  }

  // 3. DDL
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

    -- Ensure documents permissions exist
    INSERT INTO permissions (resource, action, key, description, is_system)
    VALUES 
      ('documents', 'view',    'documents.view',    'Hak akses VIEW pada modul documents', TRUE),
      ('documents', 'create',  'documents.create',  'Hak akses CREATE pada modul documents', TRUE),
      ('documents', 'edit',    'documents.edit',    'Hak akses EDIT pada modul documents', TRUE),
      ('documents', 'delete',  'documents.delete',  'Hak akses DELETE pada modul documents', TRUE)
    ON CONFLICT (key) DO NOTHING;

    -- Ensure role assignments for roles 1 (Super Admin), 2 (Hotel Manager), 5 (Front Desk)
    INSERT INTO role_permissions (role_id, permission_id, granted, created_by)
    SELECT r.id, p.id, TRUE, 'MIGRATION_DOC_QUOTATIONS'
    FROM roles r
    CROSS JOIN permissions p
    WHERE r.id IN (1, 2, 5)
      AND p.key IN ('documents.view', 'documents.create', 'documents.edit', 'documents.delete')
    ON CONFLICT DO NOTHING;

    -- Marker
    INSERT INTO schema_migrations (version)
    VALUES ('doc_quotations_v1')
    ON CONFLICT (version) DO NOTHING;
  `);

  return { applied: true, marker: DOC_QUOTATIONS_MARKER };
}

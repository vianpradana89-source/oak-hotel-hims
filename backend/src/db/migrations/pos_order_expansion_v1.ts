/**
 * POS ORDER EXPANSION — Tahap: Ekspansi Kolom Order + Settlement + Payment Config
 * DDL Authoritative:
 *   - pos_orders: +guest_phone, +notes, +discount_type/value/amount/reason
 *   - pos_order_items: +discount_type/value/amount
 *   - pos_settlements: +cash_received, +change_due, +payment_reference,
 *                     +verified_by, +verified_at
 *   - property_payment_instructions: +qris_enabled, +qris_terminal_name,
 *                                    +qris_merchant_id, +qris_image_path,
 *                                    +transfer_enabled, +transfer_ref_note,
 *                                    +debit_enabled, +debit_edc_terminal
 *
 * Kontrak:
 * - Additive only (ADD COLUMN IF NOT EXISTS). Tidak mengubah data historis.
 * - Idempoten: safe untuk re-run.
 * - Migration transactional dengan advisory lock.
 * - Marker: `pos_order_expansion_v1` pada `schema_migrations`.
 * - Verifikasi schema SETELAH marker (mismatch → gagal eksplisit).
 *
 * Prerequisite:
 *   - Tabel `property_payment_instructions` HARUS sudah ada (schema dasar).
 *   - Tabel `schema_migrations` HARUS sudah ada untuk marker.
 *   Jika tidak, migration GAGAL eksplisit — TIDAK membuat schema tebakan.
 *
 * Gunakan via runner CLI:
 *   node backend/scripts/run_pos_order_expansion_migration.js
 * dengan MIGRATION_DATABASE_URL eksplisit.
 *
 * Runner: backend/scripts/run_pos_order_expansion_migration.js.
 * Runner requires an explicit, allowlisted MIGRATION_DATABASE_URL.
 */

import { Pool, PoolClient } from 'pg';

const MARKER = 'pos_order_expansion_v1';

// =============================================================================
// Prerequisite check
// =============================================================================

/**
 * Verifikasi bahwa tabel prerequisite tersedia SEBELUM menjalankan DDL.
 * Jika tabel tidak ada, migration gagal eksplisit tanpa membuat schema tebakan.
 */
export async function checkPrerequisites(
  client: PoolClient
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  const tables = [
    'property_payment_instructions',
    'schema_migrations',
    'pos_orders',
    'pos_order_items',
    'pos_settlements',
    'permissions',
    'roles',
    'role_permissions',
  ];

  for (const t of tables) {
    const r = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1`,
      [t]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(
        `Tabel prerequisite '${t}' tidak ditemukan. ` +
        `Jalankan migrasi dasar terlebih dahulu.`
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

// =============================================================================
// DDL — semua statement dalam satu string; dieksekusi berurutan dalam 1 transaksi
// =============================================================================

export const POS_ORDER_EXPANSION_DDL = `
-- ── pos_orders: snapshot pelanggan + catatan + diskon order ─────────────
ALTER TABLE pos_orders
  ADD COLUMN IF NOT EXISTS guest_phone VARCHAR(50) NULL;

ALTER TABLE pos_orders
  ADD COLUMN IF NOT EXISTS notes TEXT NULL;

ALTER TABLE pos_orders
  ADD COLUMN IF NOT EXISTS discount_type VARCHAR(20) NULL;

ALTER TABLE pos_orders
  ADD COLUMN IF NOT EXISTS discount_value NUMERIC(12,2) NULL;

ALTER TABLE pos_orders
  ADD COLUMN IF NOT EXISTS discount_reason VARCHAR(100) NULL;

ALTER TABLE pos_orders
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

-- CHECK constraints untuk diskon order
ALTER TABLE pos_orders
  DROP CONSTRAINT IF EXISTS chk_pos_orders_discount_type;
ALTER TABLE pos_orders
  ADD CONSTRAINT chk_pos_orders_discount_type
  CHECK (discount_type IS NULL OR discount_type IN ('NOMINAL', 'PERCENT'));

ALTER TABLE pos_orders
  DROP CONSTRAINT IF EXISTS chk_pos_orders_discount_value;
ALTER TABLE pos_orders
  ADD CONSTRAINT chk_pos_orders_discount_value
  CHECK (discount_value IS NULL OR discount_value >= 0);

ALTER TABLE pos_orders
  DROP CONSTRAINT IF EXISTS chk_pos_orders_discount_percent;
ALTER TABLE pos_orders
  ADD CONSTRAINT chk_pos_orders_discount_percent
  CHECK (NOT (discount_type = 'PERCENT') OR discount_value <= 100);

ALTER TABLE pos_orders
  DROP CONSTRAINT IF EXISTS chk_pos_orders_discount_amount_nonneg;
ALTER TABLE pos_orders
  ADD CONSTRAINT chk_pos_orders_discount_amount_nonneg
  CHECK (discount_amount >= 0);

-- Index partial untuk filter order berdiskon
CREATE INDEX IF NOT EXISTS idx_pos_orders_discount
  ON pos_orders (property_id, discount_type)
  WHERE discount_type IS NOT NULL;

-- ── pos_order_items: diskon per baris ───────────────────────────────────
ALTER TABLE pos_order_items
  ADD COLUMN IF NOT EXISTS discount_type VARCHAR(20) NULL;

ALTER TABLE pos_order_items
  ADD COLUMN IF NOT EXISTS discount_value NUMERIC(12,2) NULL;

ALTER TABLE pos_order_items
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE pos_order_items
  DROP CONSTRAINT IF EXISTS chk_pos_order_items_discount_type;
ALTER TABLE pos_order_items
  ADD CONSTRAINT chk_pos_order_items_discount_type
  CHECK (discount_type IS NULL OR discount_type IN ('NOMINAL', 'PERCENT'));

ALTER TABLE pos_order_items
  DROP CONSTRAINT IF EXISTS chk_pos_order_items_discount_value;
ALTER TABLE pos_order_items
  ADD CONSTRAINT chk_pos_order_items_discount_value
  CHECK (discount_value IS NULL OR discount_value >= 0);

ALTER TABLE pos_order_items
  DROP CONSTRAINT IF EXISTS chk_pos_order_items_discount_percent;
ALTER TABLE pos_order_items
  ADD CONSTRAINT chk_pos_order_items_discount_percent
  CHECK (NOT (discount_type = 'PERCENT') OR discount_value <= 100);

ALTER TABLE pos_order_items
  DROP CONSTRAINT IF EXISTS chk_pos_order_items_discount_amount_nonneg;
ALTER TABLE pos_order_items
  ADD CONSTRAINT chk_pos_order_items_discount_amount_nonneg
  CHECK (discount_amount >= 0);

-- ── pos_settlements: metadata multi-metode pembayaran ───────────────────
ALTER TABLE pos_settlements
  ADD COLUMN IF NOT EXISTS cash_received NUMERIC(12,2) NULL;

ALTER TABLE pos_settlements
  ADD COLUMN IF NOT EXISTS change_due NUMERIC(12,2) NULL;

ALTER TABLE pos_settlements
  ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(100) NULL;

ALTER TABLE pos_settlements
  ADD COLUMN IF NOT EXISTS verified_by VARCHAR(100) NULL;

ALTER TABLE pos_settlements
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP NULL;

-- CHECK: cash_received ≥ 0 bila ada
ALTER TABLE pos_settlements
  DROP CONSTRAINT IF EXISTS chk_pos_settlements_cash_received_nonneg;
ALTER TABLE pos_settlements
  ADD CONSTRAINT chk_pos_settlements_cash_received_nonneg
  CHECK (cash_received IS NULL OR cash_received >= 0);

-- CHECK: change_due ≥ 0 bila ada
ALTER TABLE pos_settlements
  DROP CONSTRAINT IF EXISTS chk_pos_settlements_change_due_nonneg;
ALTER TABLE pos_settlements
  ADD CONSTRAINT chk_pos_settlements_change_due_nonneg
  CHECK (change_due IS NULL OR change_due >= 0);

-- ── property_payment_instructions: konfigurasi multi-metode ────────────
ALTER TABLE property_payment_instructions
  ADD COLUMN IF NOT EXISTS qris_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE property_payment_instructions
  ADD COLUMN IF NOT EXISTS qris_terminal_name VARCHAR(100) NULL;

ALTER TABLE property_payment_instructions
  ADD COLUMN IF NOT EXISTS qris_merchant_id VARCHAR(100) NULL;

ALTER TABLE property_payment_instructions
  ADD COLUMN IF NOT EXISTS qris_image_path TEXT NULL;

ALTER TABLE property_payment_instructions
  ADD COLUMN IF NOT EXISTS transfer_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE property_payment_instructions
  ADD COLUMN IF NOT EXISTS transfer_ref_note TEXT NULL;

ALTER TABLE property_payment_instructions
  ADD COLUMN IF NOT EXISTS debit_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE property_payment_instructions
  ADD COLUMN IF NOT EXISTS debit_edc_terminal VARCHAR(100) NULL;

-- ── POS discount permission: izin diskon terpisah dari pos.edit ─────────
INSERT INTO permissions (resource, action, key, description, is_system)
VALUES ('pos', 'discount.edit', 'pos.discount.edit', 'Hak memberikan diskon pada pesanan POS', TRUE)
ON CONFLICT (key) DO NOTHING;

-- Grant pos.discount.edit ke role yang sudah memiliki pos.edit
INSERT INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, TRUE
FROM roles r
JOIN permissions p ON p.key = 'pos.discount.edit'
WHERE r.name IN ('Super Admin', 'General Manager', 'POS / Resto')
  AND r.is_active = TRUE
ON CONFLICT (role_id, permission_id) DO UPDATE SET granted = TRUE;
`;

export const MARKER_SQL = `
INSERT INTO schema_migrations (version) VALUES ('pos_order_expansion_v1')
ON CONFLICT (version) DO NOTHING;
`;

// =============================================================================
// Verifikasi Schema — termasuk CHECK constraints, index, & default values
// =============================================================================

export interface VerificationResult {
  ok: boolean;
  errors: string[];
}

export type MigrationRunStatus =
  | 'applied'
  | 'already-applied'
  | 'mismatch'
  | 'verification-failed'
  | 'error'
  | 'prerequisite-failed';

/**
 * Verifikasi kolom, CHECK constraints, index, dan default values
 * yang ditambahkan oleh migration ini.
 *
 * CHECK constraint diverifikasi via pg_constraint:
 *   - convalidated = TRUE
 *   - conrelid merujuk tabel yang benar
 *   - conbin predicate sesuai
 */
export async function verifyPosOrderExpansionSchema(
  client: PoolClient
): Promise<VerificationResult> {
  const errors: string[] = [];

  // ── Helper: periksa kolom varchar ─────────────────────────────────────
  async function checkVarcharColumn(
    table: string,
    colName: string,
    expectedMaxLen: number,
    expectedNullable: boolean,
  ): Promise<void> {
    const r = await client.query(
      `SELECT character_maximum_length AS max_len,
              is_nullable            AS nullable,
              data_type,
              udt_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = $1
         AND column_name  = $2`,
      [table, colName]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(`Kolom ${table}.${colName} tidak ditemukan`);
      return;
    }
    const row = r.rows[0];
    if (row.data_type !== 'character varying') {
      errors.push(`Kolom ${table}.${colName}: data_type=${row.data_type}, ekspektasi 'character varying'`);
    }
    if (row.max_len !== expectedMaxLen) {
      errors.push(`Kolom ${table}.${colName}: max_len=${row.max_len}, ekspektasi ${expectedMaxLen}`);
    }
    if (row.nullable !== (expectedNullable ? 'YES' : 'NO')) {
      errors.push(`Kolom ${table}.${colName}: nullable=${row.nullable}, ekspektasi ${expectedNullable ? 'YES' : 'NO'}`);
    }
  }

  // ── Helper: periksa kolom numeric ─────────────────────────────────────
  async function checkNumericColumn(
    table: string,
    colName: string,
    expectedNullable: boolean,
    expectedDefault?: string,
  ): Promise<void> {
    const r = await client.query(
      `SELECT is_nullable AS nullable, data_type, udt_name, numeric_precision, numeric_scale, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = $1
         AND column_name  = $2`,
      [table, colName]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(`Kolom ${table}.${colName} tidak ditemukan`);
      return;
    }
    const row = r.rows[0];
    if (row.data_type !== 'numeric' && row.udt_name !== 'numeric') {
      errors.push(`Kolom ${table}.${colName}: data_type=${row.data_type}, ekspektasi numeric`);
    }
    if (row.numeric_precision !== 12 || row.numeric_scale !== 2) {
      errors.push(`Kolom ${table}.${colName}: precision=${row.numeric_precision}, scale=${row.numeric_scale}, ekspektasi 12,2`);
    }
    if (row.nullable !== (expectedNullable ? 'YES' : 'NO')) {
      errors.push(`Kolom ${table}.${colName}: nullable=${row.nullable}, ekspektasi ${expectedNullable ? 'YES' : 'NO'}`);
    }
    if (expectedDefault !== undefined) {
      const def = String(row.column_default ?? '').trim();
      if (def !== expectedDefault) {
        errors.push(`Kolom ${table}.${colName}: default='${def}', ekspektasi '${expectedDefault}'`);
      }
    }
  }

  // ── Helper: periksa kolom text ────────────────────────────────────────
  async function checkTextColumn(
    table: string,
    colName: string,
    expectedNullable: boolean,
  ): Promise<void> {
    const r = await client.query(
      `SELECT is_nullable AS nullable, udt_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = $1
         AND column_name  = $2`,
      [table, colName]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(`Kolom ${table}.${colName} tidak ditemukan`);
      return;
    }
    const row = r.rows[0];
    if (row.udt_name !== 'text') {
      errors.push(`Kolom ${table}.${colName}: udt_name=${row.udt_name}, ekspektasi text`);
    }
    if (row.nullable !== (expectedNullable ? 'YES' : 'NO')) {
      errors.push(`Kolom ${table}.${colName}: nullable=${row.nullable}, ekspektasi ${expectedNullable ? 'YES' : 'NO'}`);
    }
  }

  // ── Helper: periksa kolom boolean ─────────────────��───────────────────
  async function checkBooleanColumn(
    table: string,
    colName: string,
    expectedDefault: string,
  ): Promise<void> {
    const r = await client.query(
      `SELECT is_nullable AS nullable, column_default, udt_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = $1
         AND column_name  = $2`,
      [table, colName]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(`Kolom ${table}.${colName} tidak ditemukan`);
      return;
    }
    const row = r.rows[0];
    if (row.udt_name !== 'bool') {
      errors.push(`Kolom ${table}.${colName}: udt_name=${row.udt_name}, ekspektasi bool`);
    }
    if (row.nullable !== 'NO') {
      errors.push(`Kolom ${table}.${colName}: nullable=${row.nullable}, ekspektasi NOT NULL`);
    }
    if (row.column_default !== expectedDefault) {
      errors.push(`Kolom ${table}.${colName}: default=${row.column_default}, ekspektasi ${expectedDefault}`);
    }
  }

  // Canonicalize only formatting and known casts emitted by pg_get_expr.
  // Keep quoted literals case-sensitive; compare whole expressions, never substrings.
  function canonicalPredicate(sql: string): string {
    const tokens = sql.match(/'(?:[^']|'')*'|"(?:[^"]|"")*"|::|>=|<=|<>|!=|[a-z_][a-z0-9_]*|\d+(?:\.\d+)?|\S/gi) || [];
    const result: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === '::') {
        const type = (tokens[i + 1] || '').toLowerCase();
        if (!['text', 'varchar', 'character', 'numeric'].includes(type)) return '';
        i++;
        if (type === 'character') {
          if ((tokens[i + 1] || '').toLowerCase() !== 'varying') return '';
          i++;
        }
        if (tokens[i + 1] === '[' && tokens[i + 2] === ']') i += 2;
        continue;
      }
      if (token === '(' || token === ')') continue;
      if (token.startsWith("'")) {
        if (/^'\d+(?:\.\d+)?'$/.test(token) && tokens[i + 1] === '::' &&
            (tokens[i + 2] || '').toLowerCase() === 'numeric') {
          result.push(String(Number(token.slice(1, -1))));
        } else result.push(token);
      } else result.push(token.toLowerCase());
    }
    return result.join('');
  }

  async function checkConstraint(
    tableName: string,
    constraintName: string,
    expectedColumns: string[],
    expectedPredicates: string[],
  ): Promise<void> {
    const r = await client.query(
      `SELECT c.contype, c.convalidated,
              pg_get_expr(c.conbin, c.conrelid) AS predicate,
              t.relname AS table_name,
              (SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
               FROM unnest(c.conkey) AS k(attnum)
               JOIN pg_attribute a ON a.attnum = k.attnum AND a.attrelid = c.conrelid) AS columns
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE c.conname = $1 AND t.relname = $2 AND n.nspname = 'public'`,
      [constraintName, tableName]
    );
    if ((r.rowCount ?? 0) !== 1) {
      errors.push(`Constraint ${tableName}.${constraintName}: expected exactly one constraint`);
      return;
    }
    const row = r.rows[0];
    if (row.contype !== 'c' || row.convalidated !== true || row.table_name !== tableName) {
      errors.push(`Constraint ${constraintName}: type/table/validated mismatch`);
    }
    const actualColumns = String(row.columns || '').split(',').sort();
    if (JSON.stringify(actualColumns) !== JSON.stringify([...expectedColumns].sort())) {
      errors.push(`Constraint ${constraintName}: column mismatch (${row.columns})`);
    }
    const predicate = canonicalPredicate(String(row.predicate || ''));
    if (!predicate || !expectedPredicates.some((expected) => canonicalPredicate(expected) === predicate)) {
      errors.push(`Constraint ${constraintName}: expression mismatch (${row.predicate})`);
    }
  }

  async function checkIndex(
    indexName: string,
    tableName: string,
    expectedColumns: string[],
    expectedPredicate: string,
  ): Promise<void> {
    const r = await client.query(
      `SELECT c.relname AS table_name, x.indisvalid, x.indisready,
              x.indnatts AS attribute_count, x.indexprs IS NOT NULL AS has_expressions,
              pg_get_expr(x.indpred, x.indrelid) AS predicate,
              (SELECT string_agg(a.attname, ',' ORDER BY u.ord)
               FROM unnest(x.indkey) WITH ORDINALITY AS u(attnum, ord)
               JOIN pg_attribute a ON a.attnum = u.attnum AND a.attrelid = x.indrelid) AS columns
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class c ON c.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = i.relnamespace
       WHERE n.nspname = 'public' AND i.relname = $1`,
      [indexName]
    );
    if ((r.rowCount ?? 0) !== 1) {
      errors.push(`Index ${indexName}: expected exactly one index`);
      return;
    }
    const row = r.rows[0];
    if (row.table_name !== tableName || row.indisvalid !== true || row.indisready !== true) {
      errors.push(`Index ${indexName}: table/valid/ready mismatch`);
    }
    const actualColumns = String(row.columns || '').split(',');
    if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns) ||
        Number(row.attribute_count) !== expectedColumns.length || row.has_expressions !== false) {
      errors.push(`Index ${indexName}: column/expression mismatch (${row.columns})`);
    }
    const predicate = canonicalPredicate(String(row.predicate || ''));
    if (!predicate || predicate !== canonicalPredicate(expectedPredicate)) {
      errors.push(`Index ${indexName}: predicate mismatch (${row.predicate})`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────

  // ── pos_orders: columns ─────────────────────────────────────────────
  await checkVarcharColumn('pos_orders', 'guest_phone', 50, true);
  await checkTextColumn('pos_orders', 'notes', true);
  await checkVarcharColumn('pos_orders', 'discount_type', 20, true);
  await checkNumericColumn('pos_orders', 'discount_value', true);
  await checkVarcharColumn('pos_orders', 'discount_reason', 100, true);
  await checkNumericColumn('pos_orders', 'discount_amount', false, '0');

  // ── pos_order_items: columns ────────────────────────────────────────
  await checkVarcharColumn('pos_order_items', 'discount_type', 20, true);
  await checkNumericColumn('pos_order_items', 'discount_value', true);
  await checkNumericColumn('pos_order_items', 'discount_amount', false, '0');

  // ── pos_settlements: columns ────────────────────────────────────────
  await checkNumericColumn('pos_settlements', 'cash_received', true);
  await checkNumericColumn('pos_settlements', 'change_due', true);
  await checkVarcharColumn('pos_settlements', 'payment_reference', 100, true);
  await checkVarcharColumn('pos_settlements', 'verified_by', 100, true);

  // pos_settlements.verified_at: nullable TIMESTAMP (tanpa timezone)
  {
    const r = await client.query(
      `SELECT udt_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'pos_settlements' AND column_name = 'verified_at'`
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push('Kolom pos_settlements.verified_at tidak ditemukan');
    } else {
      const row = r.rows[0];
      const udt = String(row.udt_name || '');
      if (udt !== 'timestamp' && udt !== 'timestamp without time zone') {
        errors.push(`pos_settlements.verified_at: udt_name='${udt}', ekspektasi timestamp`);
      }
      // nullable sesuai DDL: TIMESTAMP NULL → is_nullable = 'YES'
      if (row.is_nullable !== 'YES') {
        errors.push(
          `pos_settlements.verified_at: is_nullable='${row.is_nullable}', ekspektasi 'YES'`
        );
      }
    }
  }

  // ── property_payment_instructions: columns ──────────────────────────
  await checkBooleanColumn('property_payment_instructions', 'qris_enabled', 'false');
  await checkVarcharColumn('property_payment_instructions', 'qris_terminal_name', 100, true);
  await checkVarcharColumn('property_payment_instructions', 'qris_merchant_id', 100, true);
  await checkTextColumn('property_payment_instructions', 'qris_image_path', true);
  await checkBooleanColumn('property_payment_instructions', 'transfer_enabled', 'false');
  await checkTextColumn('property_payment_instructions', 'transfer_ref_note', true);
  await checkBooleanColumn('property_payment_instructions', 'debit_enabled', 'false');
  await checkVarcharColumn('property_payment_instructions', 'debit_edc_terminal', 100, true);

  // Compare complete predicates and referenced columns.
  for (const table of ['pos_orders', 'pos_order_items']) {
    await checkConstraint(table, `chk_${table}_discount_type`, ['discount_type'], [
      "discount_type IS NULL OR discount_type IN ('NOMINAL', 'PERCENT')",
      "discount_type IS NULL OR discount_type = ANY (ARRAY['NOMINAL', 'PERCENT'])",
    ]);
    await checkConstraint(table, `chk_${table}_discount_value`, ['discount_value'], [
      'discount_value IS NULL OR discount_value >= 0',
    ]);
    await checkConstraint(table, `chk_${table}_discount_percent`, ['discount_type', 'discount_value'], [
      "NOT (discount_type = 'PERCENT') OR discount_value <= 100",
      "discount_type <> 'PERCENT' OR discount_value <= 100",
    ]);
    await checkConstraint(table, `chk_${table}_discount_amount_nonneg`, ['discount_amount'], [
      'discount_amount >= 0',
    ]);
  }
  for (const column of ['cash_received', 'change_due']) {
    await checkConstraint('pos_settlements', `chk_pos_settlements_${column}_nonneg`, [column], [
      `${column} IS NULL OR ${column} >= 0`,
    ]);
  }

  // ── Index partial ────────────────────────────────��───────────────────
  await checkIndex(
    'idx_pos_orders_discount',
    'pos_orders',
    ['property_id', 'discount_type'],
    'discount_type IS NOT NULL'
  );

  // ── Default 0 pada discount_amount (pos_orders & pos_order_items)
  //     (sudah diverifikasi di checkNumericColumn di atas dengan expectedDefault='0')

  // ── Permission pos.discount.edit: verifikasi definisi di jalur baru & already-applied
  {
    const permRes = await client.query(
      `SELECT p.resource, p.action, p.key, p.is_system
       FROM permissions p
       WHERE p.key = 'pos.discount.edit'`,
    );
    if ((permRes.rowCount ?? 0) === 0) {
      errors.push('Permission pos.discount.edit tidak ditemukan di tabel permissions');
    } else {
      const permRow = permRes.rows[0];
      if (permRow.resource !== 'pos') {
        errors.push(`Permission pos.discount.edit: resource='${permRow.resource}', ekspektasi 'pos'`);
      }
      if (permRow.action !== 'discount.edit') {
        errors.push(`Permission pos.discount.edit: action='${permRow.action}', ekspektasi 'discount.edit'`);
      }
      if (permRow.is_system !== true) {
        errors.push('Permission pos.discount.edit: is_system=false, ekspektasi true');
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// =============================================================================
// Runner Migration
// =============================================================================

/**
 * Jalankan migration pos order expansion. Transactional + advisory lock.
 *
 * Pre-flight: cek prerequisite (tabel-tabel dasar harus ada).
 *
 * Status:
 * - 'prerequisite-failed' : tabel dasar tidak tersedia.
 * - 'applied'             : DDL baru diterapkan + marker ditulis.
 * - 'already-applied'     : marker sudah ada, skema sesuai, tanpa re-DDL.
 * - 'mismatch'            : marker ada tetapi skema tidak sesuai → ROLLBACK.
 * - 'verification-failed' : DDL baru diterapkan tetapi verifikasi gagal → ROLLBACK.
 * - 'error'               : exception di tengah transaksi → ROLLBACK.
 *
 * @returns { ok, applied, status, errors }
 */
export async function runPosOrderExpansionMigration(
  pool: Pool,
): Promise<{
  ok: boolean;
  applied: boolean;
  status: MigrationRunStatus;
  errors: string[];
}> {
  let client: PoolClient | null = null;
  let txnActive = false;
  let discardClient = false;

  let result: {
    ok: boolean;
    applied: boolean;
    status: MigrationRunStatus;
    errors: string[];
  } = {
    ok: false,
    applied: false,
    status: 'error',
    errors: [],
  };

  try {
    client = await pool.connect();
  } catch (err: any) {
    result.errors.push(`Acquire client gagal: ${err?.message || err}`);
    return result;
  }

  try {
    const prereq = await checkPrerequisites(client);

    if (!prereq.ok) {
      result = {
        ok: false,
        applied: false,
        status: 'prerequisite-failed',
        errors: [...prereq.errors],
      };
    } else {
      await client.query('BEGIN');
      txnActive = true;

      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('oak_hims_schema_migrations_lock'))",
      );

      const markerCheck = await client.query(
        'SELECT 1 FROM schema_migrations WHERE version = $1',
        [MARKER],
      );
      const markerExists = (markerCheck.rowCount ?? 0) > 0;

      if (!markerExists) {
        await client.query(POS_ORDER_EXPANSION_DDL);
      }

      const verify = await verifyPosOrderExpansionSchema(client);

      if (!verify.ok) {
        result = {
          ok: false,
          applied: false,
          status: markerExists ? 'mismatch' : 'verification-failed',
          errors: [...verify.errors],
        };
        // Transaksi masih aktif; finally akan melakukan ROLLBACK.
      } else {
        if (!markerExists) {
          await client.query(MARKER_SQL);
        }

        await client.query('COMMIT');
        txnActive = false;

        result = {
          ok: true,
          applied: !markerExists,
          status: markerExists ? 'already-applied' : 'applied',
          errors: [],
        };
      }
    }
  } catch (err: any) {
    result = {
      ok: false,
      applied: false,
      status: 'error',
      errors: [`Exception: ${err?.message || err}`],
    };
  } finally {
    if (txnActive) {
      try {
        await client.query('ROLLBACK');
        txnActive = false;
      } catch (err: any) {
        discardClient = true;
        result.ok = false;
        result.errors.push(`ROLLBACK gagal: ${err?.message || err}`);
      }
    }

    // Satu-satunya panggilan release dalam fungsi ini.
    // true menghancurkan koneksi ketika ROLLBACK gagal.
    try {
      client.release(discardClient);
    } catch (err: any) {
      result.ok = false;
      result.status = 'error';
      result.errors.push(`Release client gagal: ${err?.message || err}`);
      // Tidak mencoba release kedua kali.
    }
  }

  return result;
}

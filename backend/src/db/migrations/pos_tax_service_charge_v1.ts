/**
 * POS TAX & SERVICE CHARGE v1 — Tahap: Kolom Canonical Tax/Service pada pos_orders
 * DDL Authoritative:
 *   - pos_orders: +tax_enabled BOOLEAN NOT NULL DEFAULT FALSE
 *                +tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0
 *                +tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0
 *                +service_charge_enabled BOOLEAN NOT NULL DEFAULT FALSE
 *                +service_charge_rate NUMERIC(5,2) NOT NULL DEFAULT 0
 *                +service_charge_amount NUMERIC(12,2) NOT NULL DEFAULT 0
 *
 * Kontrak:
 * - Migration menambah kolom baru pada pos_orders (ADD COLUMN IF NOT EXISTS).
 * - Tidak mengubah nilai finansial/order/item existing (total_amount, discount,
 *   quantity, unit_price, dll).
 * - Row historical tetap default: tax_enabled=FALSE, tax_rate=0, tax_amount=0,
 *   service_charge_enabled=FALSE, service_charge_rate=0, service_charge_amount=0.
 * - Idempoten: safe untuk re-run (marker ada → skip DDL, verifikasi saja).
 * - Migration transactional dengan advisory lock.
 * - Marker: `pos_tax_service_charge_v1` pada `schema_migrations`.
 * - Verifikasi marker & schema SETELAH marker (mismatch → gagal eksplisit).
 * - Tidak ada UPDATE/DELETE business data.
 *
 * CHECK constraints:
 *   - chk_pos_orders_tax_rate_nonneg:      tax_rate >= 0
 *   - chk_pos_orders_tax_amount_nonneg:    tax_amount >= 0
 *   - chk_pos_orders_svc_rate_nonneg:      service_charge_rate >= 0
 *   - chk_pos_orders_svc_amount_nonneg:    service_charge_amount >= 0
 *
 * Catatan:
 *   Constraint rate hanya memvalidasi non-negatif (>= 0).
 *   Canonical property_pricing_settings tidak menetapkan batas atas 100;
 *   POS tidak memperkenalkan constraint lebih ketat daripada pricing domain.
 *
 * Prerequisite:
 *   - Tabel `schema_migrations` HARUS sudah ada untuk marker.
 *   - Tabel `pos_orders` HARUS sudah ada (schema dasar).
 *   Jika tidak, migration GAGAL eksplisit — TIDAK membuat schema tebakan.
 *
 * Gunakan via runner CLI:
 *   node backend/scripts/run_pos_tax_service_charge_migration.js
 * dengan MIGRATION_DATABASE_URL eksplisit.
 *
 * Runner: backend/scripts/run_pos_tax_service_charge_migration.js.
 * Runner requires an explicit, allowlisted MIGRATION_DATABASE_URL.
 */

import { Pool, PoolClient } from 'pg';

const MARKER = 'pos_tax_service_charge_v1';

// =============================================================================
// Prerequisite check
// =============================================================================
// NOTE: information_schema / pg_tables sengaja tidak dipakai sebagai authority
// karena visibility filtering dapat memberi false-negative pada role runner staging.
// Semua structural checks memakai pg_catalog (pg_class, pg_namespace) secara langsung.

export async function checkPrerequisites(
  client: PoolClient
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  const tables = [
    'schema_migrations',
    'pos_orders',
  ];

  for (const t of tables) {
    const r = await client.query(
      `SELECT c.oid FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = $1
         AND c.relkind IN ('r','p')`,
      [t]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(
        `Tabel prerequisite '${t}' tidak ditemukan (pg_class, relkind r/p). ` +
        `Jalankan migrasi dasar terlebih dahulu.`
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

// =============================================================================
// DDL — semua statement dalam satu string; dieksekusi berurutan dalam 1 transaksi
// =============================================================================

export const POS_TAX_SERVICE_DDL = `
-- ── pos_orders: tax snapshot & flags ──────────────────────────────────────
ALTER TABLE pos_orders
  ADD COLUMN IF NOT EXISTS tax_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE pos_orders
  ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0;

ALTER TABLE pos_orders
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

-- CHECK constraints untuk tax
-- DROP versi lama (nama _rate_range) lalu versi baru (_rate_nonneg)
ALTER TABLE pos_orders
  DROP CONSTRAINT IF EXISTS chk_pos_orders_tax_rate_range;
ALTER TABLE pos_orders
  DROP CONSTRAINT IF EXISTS chk_pos_orders_tax_rate_nonneg;
ALTER TABLE pos_orders
  ADD CONSTRAINT chk_pos_orders_tax_rate_nonneg
  CHECK (tax_rate >= 0);

ALTER TABLE pos_orders
  DROP CONSTRAINT IF EXISTS chk_pos_orders_tax_amount_nonneg;
ALTER TABLE pos_orders
  ADD CONSTRAINT chk_pos_orders_tax_amount_nonneg
  CHECK (tax_amount >= 0);

-- ── pos_orders: service charge snapshot & flags ───────────────────────────
ALTER TABLE pos_orders
  ADD COLUMN IF NOT EXISTS service_charge_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE pos_orders
  ADD COLUMN IF NOT EXISTS service_charge_rate NUMERIC(5,2) NOT NULL DEFAULT 0;

ALTER TABLE pos_orders
  ADD COLUMN IF NOT EXISTS service_charge_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

-- CHECK constraints untuk service charge
-- DROP versi lama (nama _rate_range) lalu versi baru (_rate_nonneg)
ALTER TABLE pos_orders
  DROP CONSTRAINT IF EXISTS chk_pos_orders_svc_rate_range;
ALTER TABLE pos_orders
  DROP CONSTRAINT IF EXISTS chk_pos_orders_svc_rate_nonneg;
ALTER TABLE pos_orders
  ADD CONSTRAINT chk_pos_orders_svc_rate_nonneg
  CHECK (service_charge_rate >= 0);

ALTER TABLE pos_orders
  DROP CONSTRAINT IF EXISTS chk_pos_orders_svc_amount_nonneg;
ALTER TABLE pos_orders
  ADD CONSTRAINT chk_pos_orders_svc_amount_nonneg
  CHECK (service_charge_amount >= 0);
`;

export const MARKER_SQL = `
INSERT INTO schema_migrations (version) VALUES ('pos_tax_service_charge_v1')
ON CONFLICT (version) DO NOTHING;
`;

// =============================================================================
// Verifikasi Schema — pg_catalog only
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

export async function verifyPosTaxServiceSchema(
  client: PoolClient
): Promise<VerificationResult> {
  const errors: string[] = [];

  // ── Helper: periksa kolom boolean NOT NULL dengan default ────────────────
  async function checkBooleanColumn(
    table: string,
    colName: string,
    expectedDefault: string,
  ): Promise<void> {
    const r = await client.query(
      `SELECT a.attname AS column_name,
              t.typname AS udt_name,
              CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS nullable,
              pg_get_expr(ad.adbin, ad.adrelid) AS column_default
       FROM pg_attribute a
       JOIN pg_class c     ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t      ON t.oid = a.atttypid
       LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       WHERE n.nspname = 'public'
         AND c.relname = $1
         AND c.relkind IN ('r','p')
         AND a.attname = $2
         AND a.attnum > 0
         AND NOT a.attisdropped`,
      [table, colName]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(`Kolom ${table}.${colName} tidak ditemukan`);
      return;
    }
    const row = r.rows[0];
    if (row.udt_name !== 'bool') {
      errors.push(`Kolom ${table}.${colName}: udt_name=${row.udt_name}, ekspektasi 'bool'`);
    }
    if (row.nullable !== 'NO') {
      errors.push(`Kolom ${table}.${colName}: nullable=${row.nullable}, ekspektasi NOT NULL`);
    }
    if (String(row.column_default ?? '') !== expectedDefault) {
      errors.push(`Kolom ${table}.${colName}: default=${row.column_default}, ekspektasi ${expectedDefault}`);
    }
  }

  // ── Helper: periksa kolom NUMERIC(p,s) NOT NULL dengan default ───────────
  async function checkNumericColumn(
    table: string,
    colName: string,
    expectedPrecision: number,
    expectedScale: number,
    expectedNullable: boolean,
    expectedDefault?: string,
  ): Promise<void> {
    const r = await client.query(
      `SELECT a.attname AS column_name,
              t.typname AS udt_name,
              CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS nullable,
              a.atttypmod AS numeric_typmod,
              pg_get_expr(ad.adbin, ad.adrelid) AS column_default
       FROM pg_attribute a
       JOIN pg_class c     ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t      ON t.oid = a.atttypid
       LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       WHERE n.nspname = 'public'
         AND c.relname = $1
         AND c.relkind IN ('r','p')
         AND a.attname = $2
         AND a.attnum > 0
         AND NOT a.attisdropped`,
      [table, colName]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(`Kolom ${table}.${colName} tidak ditemukan`);
      return;
    }
    const row = r.rows[0];
    if (row.udt_name !== 'numeric') {
      errors.push(`Kolom ${table}.${colName}: udt_name=${row.udt_name}, ekspektasi numeric`);
    }
    // PostgreSQL: atttypmod untuk numeric(p,s) = ((p << 16) | s) + 4 (VARHDRSZ).
    const rawTypmod = Number(row.numeric_typmod ?? 0);
    if (!Number.isInteger(rawTypmod) || rawTypmod < 4) {
      errors.push(`Kolom ${table}.${colName}: atttypmod=${rawTypmod} tidak valid/unconstrained`);
    } else {
      const nm = rawTypmod - 4;
      const precision = (nm >> 16) & 0xffff;
      const scale = nm & 0x7ff;
      if (precision !== expectedPrecision || scale !== expectedScale) {
        errors.push(`Kolom ${table}.${colName}: precision=${precision}, scale=${scale}, ekspektasi ${expectedPrecision},${expectedScale}`);
      }
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

  // ── Helper: periksa CHECK constraint via pg_constraint ──────���────────────
  // Canonicalize hanya formatting & cast yang dikenal pg_get_expr.
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

  // ── pos_orders: tax columns ────────────────────────────────────────────
  await checkBooleanColumn('pos_orders', 'tax_enabled', 'false');
  await checkNumericColumn('pos_orders', 'tax_rate', 5, 2, false, '0');
  await checkNumericColumn('pos_orders', 'tax_amount', 12, 2, false, '0');

  // ── pos_orders: service charge columns ──────────────────────────────────
  await checkBooleanColumn('pos_orders', 'service_charge_enabled', 'false');
  await checkNumericColumn('pos_orders', 'service_charge_rate', 5, 2, false, '0');
  await checkNumericColumn('pos_orders', 'service_charge_amount', 12, 2, false, '0');

  // ── CHECK constraints ────────────────────────────────────────────────────
  await checkConstraint('pos_orders', 'chk_pos_orders_tax_rate_nonneg', ['tax_rate'], [
    'tax_rate >= 0',
  ]);
  await checkConstraint('pos_orders', 'chk_pos_orders_tax_amount_nonneg', ['tax_amount'], [
    'tax_amount >= 0',
  ]);
  await checkConstraint('pos_orders', 'chk_pos_orders_svc_rate_nonneg', ['service_charge_rate'], [
    'service_charge_rate >= 0',
  ]);
  await checkConstraint('pos_orders', 'chk_pos_orders_svc_amount_nonneg', ['service_charge_amount'], [
    'service_charge_amount >= 0',
  ]);

  return { ok: errors.length === 0, errors };
}

// =============================================================================
// Verifikasi Marker
// =============================================================================

export async function verifyPosTaxServiceMarker(
  client: PoolClient
): Promise<VerificationResult> {
  const errors: string[] = [];

  const r = await client.query(
    'SELECT 1 FROM schema_migrations WHERE version = $1',
    [MARKER]
  );
  const rowCount = r.rowCount ?? 0;

  if (rowCount !== 1) {
    errors.push(
      `Marker '${MARKER}' di schema_migrations: rowCount=${rowCount}, ` +
      `ekspektasi tepat 1 row`
    );
  }

  return { ok: errors.length === 0, errors };
}

// =============================================================================
// Runner Migration
// =============================================================================

/**
 * Jalankan migration pos tax & service charge. Transactional + advisory lock.
 *
 * Pre-flight: cek prerequisite (tabel-tabel dasar harus ada).
 *
 * Jalur "applied" (marker belum ada):
 *   1. BEGIN
 *   2. advisory lock
 *   3. DDL (ADD COLUMN IF NOT EXISTS + CHECK constraints)
 *   4. verify schema columns
 *   5. verify CHECK constraints
 *   6. INSERT MARKER
 *   7. verify marker
 *   8. COMMIT
 *
 * Jalur "already-applied" (marker sudah ada):
 *   1. BEGIN
 *   2. advisory lock
 *   3. verify schema final
 *   4. verify marker
 *   5. COMMIT → already-applied
 *
 * Status:
 * - 'prerequisite-failed' : tabel dasar tidak tersedia.
 * - 'applied'             : DDL baru diterapkan + marker diverifikasi.
 * - 'already-applied'     : marker sudah ada, skema & marker sesuai, tanpa re-DDL.
 * - 'mismatch'            : marker ada tetapi skema/marker tidak sesuai → ROLLBACK.
 * - 'verification-failed' : DDL baru diterapkan tetapi verifikasi gagal → ROLLBACK.
 * - 'error'              : exception di tengah transaksi → ROLLBACK.
 *
 * @returns { ok, applied, status, errors }
 */
export async function runPosTaxServiceMigration(
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
        // Jalur applied: DDL + verifikasi schema, lalu marker, lalu verifikasi marker.
        // Urutan kritis: verifyPosTaxServiceMarker hanya boleh dipanggil SETELAH
        // MARKER_SQL di-INSERT — marker belum ada pada titik DDL+verify schema.
        await client.query(POS_TAX_SERVICE_DDL);

        const verify = await verifyPosTaxServiceSchema(client);

        if (!verify.ok) {
          result = {
            ok: false,
            applied: false,
            status: 'verification-failed',
            errors: [...verify.errors],
          };
          // Transaksi masih aktif; finally akan melakukan ROLLBACK.
        } else {
          await client.query(MARKER_SQL);

          // Verify marker benar-benar ada SETELAH INSERT
          const markerVerify2 = await verifyPosTaxServiceMarker(client);

          if (!markerVerify2.ok) {
            result = {
              ok: false,
              applied: false,
              status: 'verification-failed',
              errors: [
                ...markerVerify2.errors,
                'Marker gagal diverifikasi setelah INSERT — transaksi di-ROLLBACK.',
              ],
            };
            // Transaksi masih aktif; finally akan melakukan ROLLBACK.
          } else {
            await client.query('COMMIT');
            txnActive = false;

            result = {
              ok: true,
              applied: true,
              status: 'applied',
              errors: [],
            };
          }
        }
      } else {
        // Jalur already-applied: marker sudah ada.
        // Verifikasi schema final + marker.
        const verify = await verifyPosTaxServiceSchema(client);
        const markerVerify = await verifyPosTaxServiceMarker(client);

        if (!verify.ok || !markerVerify.ok) {
          result = {
            ok: false,
            applied: false,
            status: 'mismatch',
            errors: [...verify.errors, ...markerVerify.errors],
          };
          // Transaksi masih aktif; finally akan melakukan ROLLBACK.
        } else {
          await client.query('COMMIT');
          txnActive = false;

          result = {
            ok: true,
            applied: false,
            status: 'already-applied',
            errors: [],
          };
        }
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
      client!.release(discardClient);
    } catch (err: any) {
      result.ok = false;
      result.status = 'error';
      result.errors.push(`Release client gagal: ${err?.message || err}`);
      // Tidak mencoba release kedua kali.
    }
  }

  return result;
}

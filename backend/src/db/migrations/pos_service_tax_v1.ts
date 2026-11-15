/**
 * POS SERVICE & TAX v1 — Fondasi Tabel Pengaturan Pricing POS/F&B
 * DDL Authoritative:
 *   - CREATE TABLE property_pos_pricing_settings
 *     (konfigurasi Service Charge & PPN per properti untuk order POS)
 *   - ALTER TABLE pos_orders ADD COLUMN (snapshot service/tax per order)
 *
 * Kontrak:
 * - Tabel baru standalone property_pos_pricing_settings;
 *   TIDAK menyentuh property_pricing_settings (authority PMS/room pricing).
 * - V1 hanya empat field bisnis:
 *   - service_charge_enabled BOOLEAN NOT NULL DEFAULT FALSE
 *     (default FALSE = order POS tidak terkena service charge hingga admin
 *      mengaktifkannya secara eksplisit; TIDAK auto-enable, TIDAK default 10%)
 *   - service_charge_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00
 *     CHECK (0 <= x <= 100); input max 2 desimal.
 *   - tax_enabled BOOLEAN NOT NULL DEFAULT FALSE
 *   - tax_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00
 *     CHECK (0 <= x <= 100); input max 2 desimal.
 * - Kolom snapshot pada pos_orders (semua NOT NULL DEFAULT 0/FALSE,
 *   order lama otomatis 0/false tanpa backfill):
 *   - service_amount, tax_amount DECIMAL(12,2) CHECK >= 0
 *   - service_charge_percent_snapshot, tax_percent_snapshot NUMERIC(5,2) CHECK 0..100
 *   - service_charge_enabled_snapshot, tax_enabled_snapshot BOOLEAN
 * - Satu baris per properti: UNIQUE (property_id), FK ke properties(id)
 *   dengan ON DELETE RESTRICT (integritas audit trail).
 * - V1 EXCLUSIVE ONLY: tidak ada kolom prices_include_service /
 *   prices_include_tax. Flag inclusive adalah fitur V2.
 * - Idempoten: CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS
 *   + marker → safe untuk re-run.
 * - Migration transactional dengan advisory lock.
 * - Marker: `pos_service_tax_v1` pada `schema_migrations`.
 * - Verifikasi struktur & marker SETELAH marker (mismatch → gagal eksplisit,
 *   tanpa repair otomatis).
 *
 * Prerequisite:
 *   - Tabel `properties` HARUS sudah ada (referensi FK).
 *   - Tabel `pos_orders` HARUS sudah ada (target ALTER).
 *   - Tabel `schema_migrations` HARUS sudah ada untuk marker.
 *   Jika tidak, migration GAGAL eksplisit — TIDAK membuat schema tebakan.
 *
 * Catatan untuk fase berikutnya (PHASE B — canonical pricing):
 * - id memakai `GENERATED ALWAYS AS IDENTITY`: service WAJIB menulis INSERT
 *   tanpa kolom `id` (biarkan identity menghasilkan).
 * - Kolom snapshot pos_orders diisi oleh order create handler PHASE B
 *   (PHASE A tidak mengubah jalur create order sama sekali).
 *
 * Gunakan via runner CLI:
 *   node backend/scripts/run_pos_service_tax_migration.js
 * dengan MIGRATION_DATABASE_URL eksplisit.
 *
 * Runner: backend/scripts/run_pos_service_tax_migration.js.
 * Runner staging: backend/scripts/run_pos_service_tax_migration_staging.js.
 */

import { Pool, PoolClient } from 'pg';

const MARKER = 'pos_service_tax_v1';

const SETTINGS_TABLE = 'property_pos_pricing_settings';
const ORDERS_TABLE = 'pos_orders';

// =============================================================================
// Prerequisite check
// =============================================================================
// NOTE: information_schema / pg_tables sengaja tidak dipakai sebagai authority
// karena visibility filtering dapat memberi false-negative pada role runner staging.
// Semua structural checks memakai pg_catalog (pg_class, pg_namespace) secara langsung.

/**
 * Verifikasi bahwa tabel prerequisite tersedia SEBELUM menjalankan DDL.
 * Jika tabel tidak ada, migration gagal eksplisit tanpa membuat schema tebakan.
 *
 * Otoritas: pg_class + pg_namespace — relkind 'r' (table) atau 'p' (partitioned table).
 */
export async function checkPrerequisites(
  client: PoolClient
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  const tables = [
    'properties',
    'pos_orders',
    'schema_migrations',
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
      continue; // jangan query kolom pada tabel yang tidak ada
    }

    if (t === 'schema_migrations') {
      // Verifikasi kolom 'applied_at' tersedia (dipakai runner --check).
      // Jika tidak, migration apply akan INSERT ke schema yang tidak sesuai
      // → gagal eksplisit di sini, bukan di tengah transaksi.
      const colR = await client.query(
        `SELECT a.attname FROM pg_attribute a
         JOIN pg_class c     ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = 'schema_migrations'
           AND c.relkind IN ('r','p')
           AND a.attname = 'applied_at'
           AND a.attnum > 0
           AND NOT a.attisdropped`
      );
      if ((colR.rowCount ?? 0) === 0) {
        errors.push(
          `Kolom schema_migrations.applied_at tidak ditemukan (pg_attribute). ` +
          `Tabel tidak sesuai kontrak yang diharapkan oleh migration ini.`
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// =============================================================================
// DDL — semua statement dalam satu string; dieksekusi berurutan dalam 1 transaksi
// =============================================================================

export const POS_SERVICE_TAX_DDL = `
-- Tabel konfigurasi Service Charge & PPN per properti untuk order POS/F&B.
-- Satu baris per properti; default enabled=FALSE menjaga zero behavioral
-- change: order POS tidak terkena service/tax hingga admin mengaktifkannya.
CREATE TABLE IF NOT EXISTS property_pos_pricing_settings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Scope properti: INTEGER sesuai properties.id (SERIAL)
  property_id INTEGER NOT NULL,

  -- V1: empat field bisnis (EXCLUSIVE mode only)
  service_charge_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  service_charge_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00
    CHECK (service_charge_percent >= 0 AND service_charge_percent <= 100),
  tax_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  tax_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00
    CHECK (tax_percent >= 0 AND tax_percent <= 100),

  -- Audit metadata
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by VARCHAR(100) NULL,

  -- FK eksplisit (ON DELETE RESTRICT: baris konfigurasi tidak boleh ditinggalkan
  -- saat properti dihapus — integritas audit trail).
  CONSTRAINT fk_pos_pricing_settings_property
    FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE RESTRICT,

  -- Satu baris per properti
  CONSTRAINT uq_pos_pricing_settings_property
    UNIQUE (property_id)
);

-- Kolom snapshot per order: order historis tidak berubah saat setting diubah.
-- NOT NULL DEFAULT 0/FALSE → baris pos_orders lama otomatis 0/false
-- (TANPA backfill dari setting properti apa pun).
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS service_amount DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS service_charge_percent_snapshot NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS tax_percent_snapshot NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS service_charge_enabled_snapshot BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS tax_enabled_snapshot BOOLEAN NOT NULL DEFAULT FALSE;
`;

// CHECK constraints pos_orders harus di-apply secara idempotent tersendiri
// (ADD CONSTRAINT tidak mendukung IF NOT EXISTS) — guard manual di bawah.
export const POS_SERVICE_TAX_ORDER_CHECKS_DDL = `
ALTER TABLE pos_orders ADD CONSTRAINT chk_pos_orders_service_amount_nonneg CHECK (service_amount >= 0);
ALTER TABLE pos_orders ADD CONSTRAINT chk_pos_orders_tax_amount_nonneg CHECK (tax_amount >= 0);
ALTER TABLE pos_orders ADD CONSTRAINT chk_pos_orders_service_percent_snapshot CHECK (service_charge_percent_snapshot >= 0 AND service_charge_percent_snapshot <= 100);
ALTER TABLE pos_orders ADD CONSTRAINT chk_pos_orders_tax_percent_snapshot CHECK (tax_percent_snapshot >= 0 AND tax_percent_snapshot <= 100);
`;

export const MARKER_SQL = `
INSERT INTO schema_migrations (version) VALUES ('pos_service_tax_v1')
ON CONFLICT (version) DO NOTHING;
`;

// =============================================================================
// Verifikasi Schema
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
 * Verifikasi definisi SKEMA AKTUAL:
 *  - property_pos_pricing_settings (tabel setting per properti)
 *  - kolom snapshot pada pos_orders
 *
 * Otoritas: pg_catalog (pg_attribute, pg_class, pg_namespace, pg_type,
 * pg_constraint, pg_index, pg_attrdef).
 * information_schema sengaja tidak digunakan sebagai authority structural
 * checks karena visibility filtering dapat memberi false-negative pada
 * role runner staging.
 */
export async function verifyPosServiceTaxSchema(
  client: PoolClient
): Promise<VerificationResult> {
  const errors: string[] = [];

  // ── Helper generik: kolom per kontrak ──────────────────────────────────
  // expected: { udt, nullable, default?, identity?, maxLen? }
  interface ColumnSpec {
    table: string;
    column: string;
    udt: string; // 'int4' | 'int8' | 'bool' | 'numeric' | 'timestamp' | 'varchar'
    nullable: boolean;
    /** Bentuk EXACT hasil pg_get_expr(ad.adbin, ad.adrelid) bila wajib. */
    default?: string;
    /** Identity option: 'a' = ALWAYS. */
    identity?: string;
    /** Max length untuk varchar (via atttypmod - 4). */
    maxLen?: number;
    /** Precision/scale untuk numeric via atttypmod (0x17 packed int). */
    numericPrecision?: number;
    numericScale?: number;
  }

  async function checkColumn(spec: ColumnSpec): Promise<void> {
    const r = await client.query(
      `SELECT t.typname AS udt_name,
              CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS nullable,
              pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
              a.attidentity,
              a.atttypmod,
              a.attlen
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
      [spec.table, spec.column]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(`Kolom ${spec.table}.${spec.column} tidak ditemukan`);
      return;
    }
    const row = r.rows[0];
    if (row.udt_name !== spec.udt) {
      errors.push(
        `Kolom ${spec.table}.${spec.column}: udt_name=${row.udt_name}, ` +
        `ekspektasi '${spec.udt}'`
      );
    }
    if (row.nullable !== (spec.nullable ? 'YES' : 'NO')) {
      errors.push(
        `Kolom ${spec.table}.${spec.column}: nullable=${row.nullable}, ` +
        `ekspektasi ${spec.nullable ? 'YES' : 'NO'}`
      );
    }
    if (spec.default !== undefined) {
      // PostgreSQL menyimpan default boolean/numeric secara lowercase ('false', '0.00').
      // TIMESTAMP default: current_timestamp (lowercase via pg_get_expr).
      if (String(row.column_default ?? '') !== spec.default) {
        errors.push(
          `Kolom ${spec.table}.${spec.column}: default=${row.column_default}, ` +
          `ekspektasi '${spec.default}'`
        );
      }
    }
    if (spec.identity !== undefined) {
      if (row.attidentity !== spec.identity) {
        errors.push(
          `Kolom ${spec.table}.${spec.column}: attidentity='${row.attidentity}', ` +
          `ekspektasi '${spec.identity}' (identity)`
        );
      }
    }
    if (spec.maxLen !== undefined && spec.udt === 'varchar') {
      const maxLen = row.atttypmod > 4 ? row.atttypmod - 4 : row.atttypmod;
      if (Number(maxLen) !== spec.maxLen) {
        errors.push(
          `Kolom ${spec.table}.${spec.column}: max_len=${maxLen}, ekspektasi ${spec.maxLen}`
        );
      }
    }
    if (spec.numericPrecision !== undefined && spec.udt === 'numeric') {
      // atttypmod packed: ((precision << 16) | scale) + VARHDRSZ(4)
      const mod = Number(row.atttypmod);
      if (mod <= 0) {
        errors.push(`Kolom ${spec.table}.${spec.column}: atttypmod=${mod}, ekspektasi precision/scale terdefinisi`);
      } else {
        const precision = Math.floor((mod - 4) / 65536);
        const scale = (mod - 4) % 65536;
        if (precision !== spec.numericPrecision) {
          errors.push(
            `Kolom ${spec.table}.${spec.column}: precision=${precision}, ` +
            `ekspektasi ${spec.numericPrecision}`
          );
        }
        if (spec.numericScale !== undefined && scale !== spec.numericScale) {
          errors.push(
            `Kolom ${spec.table}.${spec.column}: scale=${scale}, ` +
            `ekspektasi ${spec.numericScale}`
          );
        }
      }
    }
  }

  // ── Tabel setting harus ada di public ──────────────────────────────────
  const tblCheck = await client.query(
    `SELECT c.oid FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = $1
       AND c.relkind IN ('r','p')`,
    [SETTINGS_TABLE]
  );
  if ((tblCheck.rowCount ?? 0) === 0) {
    errors.push(`Tabel public.${SETTINGS_TABLE} tidak ditemukan`);
    return { ok: false, errors };
  }

  // ── Kolom property_pos_pricing_settings per kontrak ────────────────────
  await checkColumn({ table: SETTINGS_TABLE, column: 'id', udt: 'int8', nullable: false, identity: 'a' });
  await checkColumn({ table: SETTINGS_TABLE, column: 'property_id', udt: 'int4', nullable: false });
  await checkColumn({ table: SETTINGS_TABLE, column: 'service_charge_enabled', udt: 'bool', nullable: false, default: 'false' });
  await checkColumn({ table: SETTINGS_TABLE, column: 'service_charge_percent', udt: 'numeric', nullable: false, default: '0.00', numericPrecision: 5, numericScale: 2 });
  await checkColumn({ table: SETTINGS_TABLE, column: 'tax_enabled', udt: 'bool', nullable: false, default: 'false' });
  await checkColumn({ table: SETTINGS_TABLE, column: 'tax_percent', udt: 'numeric', nullable: false, default: '0.00', numericPrecision: 5, numericScale: 2 });
  await checkColumn({ table: SETTINGS_TABLE, column: 'created_at', udt: 'timestamp', nullable: false, default: 'CURRENT_TIMESTAMP' });
  await checkColumn({ table: SETTINGS_TABLE, column: 'updated_at', udt: 'timestamp', nullable: false, default: 'CURRENT_TIMESTAMP' });
  await checkColumn({ table: SETTINGS_TABLE, column: 'updated_by', udt: 'varchar', nullable: true, maxLen: 100 });

  // ── Kolom snapshot pada pos_orders per kontrak ─────────────────────────
  await checkColumn({ table: ORDERS_TABLE, column: 'service_amount', udt: 'numeric', nullable: false, default: '0', numericPrecision: 12, numericScale: 2 });
  await checkColumn({ table: ORDERS_TABLE, column: 'tax_amount', udt: 'numeric', nullable: false, default: '0', numericPrecision: 12, numericScale: 2 });
  await checkColumn({ table: ORDERS_TABLE, column: 'service_charge_percent_snapshot', udt: 'numeric', nullable: false, default: '0', numericPrecision: 5, numericScale: 2 });
  await checkColumn({ table: ORDERS_TABLE, column: 'tax_percent_snapshot', udt: 'numeric', nullable: false, default: '0', numericPrecision: 5, numericScale: 2 });
  await checkColumn({ table: ORDERS_TABLE, column: 'service_charge_enabled_snapshot', udt: 'bool', nullable: false, default: 'false' });
  await checkColumn({ table: ORDERS_TABLE, column: 'tax_enabled_snapshot', udt: 'bool', nullable: false, default: 'false' });

  // ── PRIMARY KEY identity pada id (settings) ────────────────────────────
  {
    const pkQ = await client.query(
      `SELECT con.conname,
              con.convalidated,
              con.condeferrable,
              a.attname AS col_name
       FROM pg_constraint con
       JOIN pg_class lt ON lt.oid = con.conrelid
       JOIN pg_namespace ln ON ln.oid = lt.relnamespace
       LEFT JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
       WHERE con.contype = 'p'
         AND con.conrelid = $1::regclass
         AND ln.nspname = 'public'
         AND lt.relname = $2`,
      ['public.' + SETTINGS_TABLE, SETTINGS_TABLE]
    );
    if ((pkQ.rowCount ?? 0) === 0) {
      errors.push(`PRIMARY KEY pada public.${SETTINGS_TABLE} tidak ditemukan (contype='p')`);
    } else {
      for (const pkRow of pkQ.rows) {
        if (pkRow.col_name !== 'id') {
          errors.push(`PK ${pkRow.conname}: kolom=${pkRow.col_name}, ekspektasi 'id'`);
        }
        if (pkRow.convalidated !== true) {
          errors.push(`PK ${pkRow.conname}: convalidated=false`);
        }
        if (pkRow.condeferrable !== false) {
          errors.push(`PK ${pkRow.conname}: condeferrable=true, ekspektasi false (non-deferrable)`);
        }
      }
    }
  }

  // ── UNIQUE constraint (property_id) + backing index (settings) ────────
  {
    const uqQ = await client.query(
      `WITH con AS (
         SELECT conname, contype, conrelid, conkey,
                condeferrable, convalidated, conindid
         FROM pg_constraint
         WHERE conname = $1 AND contype = 'u'
           AND conrelid = $2::regclass
       )
       SELECT con.conname,
              con.condeferrable,
              con.convalidated,
              (SELECT array_agg(a.attname ORDER BY x.ord)
                 FROM unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum) AS cols,
              i.indisvalid  AS idx_valid,
              i.indisready  AS idx_ready,
              i.indislive   AS idx_live,
              i.indisunique AS idx_unique
       FROM con
       LEFT JOIN pg_index i ON i.indexrelid = con.conindid`,
      ['uq_pos_pricing_settings_property', 'public.' + SETTINGS_TABLE]
    );
    if ((uqQ.rowCount ?? 0) === 0) {
      errors.push(
        `UNIQUE constraint uq_pos_pricing_settings_property tidak ditemukan (contype='u')`
      );
    } else {
      const row = uqQ.rows[0];
      const cols: string[] = Array.isArray(row.cols)
        ? row.cols.map(String)
        : String(row.cols || '')
            .replace(/^[{]+|\}+$/g, '')
            .split(',')
            .map((s: string) => s.trim());
      if (cols.length !== 1 || cols[0] !== 'property_id') {
        errors.push(
          `UNIQUE uq_pos_pricing_settings_property: kolom=[${cols.join(',')}], ` +
          `ekspektasi [property_id]`
        );
      }
      if (row.condeferrable !== false) {
        errors.push(`UNIQUE uq_pos_pricing_settings_property: condeferrable=true, ekspektasi false`);
      }
      if (row.convalidated !== true) {
        errors.push(`UNIQUE uq_pos_pricing_settings_property: convalidated=false`);
      }
      if (row.idx_valid !== true) errors.push(`UNIQUE uq_pos_pricing_settings_property: backing index indisvalid=false`);
      if (row.idx_ready !== true) errors.push(`UNIQUE uq_pos_pricing_settings_property: backing index indisready=false`);
      if (row.idx_live !== true) errors.push(`UNIQUE uq_pos_pricing_settings_property: backing index indislive=false`);
      if (row.idx_unique !== true) errors.push(`UNIQUE uq_pos_pricing_settings_property: backing index indisunique=false`);
    }
  }

  // ── FK constraint (property_id → properties.id, ON DELETE RESTRICT) ───
  {
    const fkQ = await client.query(
      `WITH con AS (
         SELECT conname, contype, conrelid, confrelid,
                conkey, confkey, confdeltype,
                condeferrable, convalidated
         FROM pg_constraint
         WHERE conname = $1 AND contype = 'f'
           AND conrelid = $2::regclass
       )
       SELECT con.confdeltype,
              con.condeferrable,
              con.convalidated,
              (SELECT array_agg(a.attname ORDER BY x.ord)
                 FROM unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum) AS local_cols,
              (SELECT array_agg(ra.attname ORDER BY x.ord)
                 FROM unnest(con.confkey) WITH ORDINALITY AS x(attnum, ord)
                 JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = x.attnum) AS ref_cols,
              rt.relname AS ref_table,
              rn.nspname AS ref_schema
       FROM con
       LEFT JOIN pg_class rt ON rt.oid = con.confrelid
       LEFT JOIN pg_namespace rn ON rn.oid = rt.relnamespace`,
      ['fk_pos_pricing_settings_property', 'public.' + SETTINGS_TABLE]
    );
    if ((fkQ.rowCount ?? 0) === 0) {
      errors.push(`FK constraint fk_pos_pricing_settings_property tidak ditemukan (contype='f')`);
    } else {
      const row = fkQ.rows[0];
      const localCols: string[] = Array.isArray(row.local_cols)
        ? row.local_cols.map(String)
        : String(row.local_cols || '')
            .replace(/^[{]+|\}+$/g, '')
            .split(',')
            .map((s: string) => s.trim());
      const refCols: string[] = Array.isArray(row.ref_cols)
        ? row.ref_cols.map(String)
        : String(row.ref_cols || '')
            .replace(/^[{]+|\}+$/g, '')
            .split(',')
            .map((s: string) => s.trim());
      if (localCols.length !== 1 || localCols[0] !== 'property_id') {
        errors.push(
          `FK fk_pos_pricing_settings_property: kolom lokal=[${localCols.join(',')}], ` +
          `ekspektasi [property_id]`
        );
      }
      if (row.ref_schema !== 'public' || row.ref_table !== 'properties') {
        errors.push(
          `FK fk_pos_pricing_settings_property: tabel referensi=${row.ref_schema}.${row.ref_table}, ` +
          `ekspektasi public.properties`
        );
      }
      if (refCols.length !== 1 || refCols[0] !== 'id') {
        errors.push(
          `FK fk_pos_pricing_settings_property: kolom referensi=[${refCols.join(',')}], ` +
          `ekspektasi [id]`
        );
      }
      // ON DELETE RESTRICT → confdeltype 'r'
      if (row.confdeltype !== 'r') {
        errors.push(
          `FK fk_pos_pricing_settings_property: confdeltype=${row.confdeltype}, ` +
          `ekspektasi 'r' (ON DELETE RESTRICT)`
        );
      }
      if (row.condeferrable !== false) {
        errors.push(`FK fk_pos_pricing_settings_property: condeferrable=true, ekspektasi false`);
      }
      if (row.convalidated !== true) {
        errors.push(`FK fk_pos_pricing_settings_property: convalidated=false`);
      }
    }
  }

  // ── CHECK constraints pada pos_orders (4 constraint bernama) ──────────
  const orderChecks = [
    'chk_pos_orders_service_amount_nonneg',
    'chk_pos_orders_tax_amount_nonneg',
    'chk_pos_orders_service_percent_snapshot',
    'chk_pos_orders_tax_percent_snapshot',
  ];
  for (const cname of orderChecks) {
    const chkQ = await client.query(
      `SELECT con.conname, con.contype, con.convalidated
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE con.conname = $1
         AND n.nspname = 'public'
         AND c.relname = $2`,
      [cname, ORDERS_TABLE]
    );
    if ((chkQ.rowCount ?? 0) === 0) {
      errors.push(`CHECK constraint ${cname} pada pos_orders tidak ditemukan`);
      continue;
    }
    const row = chkQ.rows[0];
    if (row.contype !== 'c') {
      errors.push(`CHECK constraint ${cname}: contype=${row.contype}, ekspektasi 'c'`);
    }
    if (row.convalidated !== true) {
      errors.push(`CHECK constraint ${cname}: convalidated=false`);
    }
  }

  // ── Verifikasi tidak ada kolom inclusive (V1 exclusive only) ──────────
  const inclusiveCols = await client.query(
    `SELECT a.attname FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = $1
       AND c.relkind IN ('r','p')
       AND a.attname IN ('prices_include_service', 'prices_include_tax')
       AND a.attnum > 0
       AND NOT a.attisdropped`,
    [SETTINGS_TABLE]
  );
  if ((inclusiveCols.rowCount ?? 0) > 0) {
    errors.push(
      `Kolom prices_include_* ditemukan pada ${SETTINGS_TABLE} — ` +
      `bertentangan dengan kontrak V1 EXCLUSIVE ONLY`
    );
  }

  return { ok: errors.length === 0, errors };
}

// =============================================================================
// Verifikasi Marker
// =============================================================================

/**
 * Verifikasi bahwa marker pos_service_tax_v1 tepat satu row
 * tersedia di schema_migrations.
 */
export async function verifyPosServiceTaxMarker(
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
 * Jalankan migration pos service & tax. Transactional + advisory lock.
 *
 * Pre-flight: cek prerequisite (properties, pos_orders & schema_migrations harus ada).
 *
 * Jalur "applied" (marker belum ada):
 *   1. BEGIN
 *   2. advisory lock
 *   3. DDL (CREATE TABLE + ALTER TABLE ADD COLUMN + CHECK constraints)
 *   4. verify schema
 *   5. INSERT MARKER
 *   6. verify marker
 *   7. COMMIT
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
 * - 'error'               : exception di tengah transaksi → ROLLBACK.
 *
 * @returns { ok, applied, status, errors }
 */
export async function runPosServiceTaxMigration(
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
        [MARKER]
      );
      const markerExists = (markerCheck.rowCount ?? 0) > 0;

      if (!markerExists) {
        // Jalur applied: DDL + verifikasi skema + marker
        await client.query(POS_SERVICE_TAX_DDL);

        // CHECK constraints: hanya apply constraint yang belum ada
        // (ADD CONSTRAINT tidak idempotent; guard per-constraint).
        const pendingChecks: string[] = [];
        const checkNames = [
          'chk_pos_orders_service_amount_nonneg',
          'chk_pos_orders_tax_amount_nonneg',
          'chk_pos_orders_service_percent_snapshot',
          'chk_pos_orders_tax_percent_snapshot',
        ];
        for (const cname of checkNames) {
          const existsQ = await client.query(
            `SELECT 1 FROM pg_constraint c
             JOIN pg_class t ON t.oid = c.conrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
             WHERE c.conname = $1 AND n.nspname = 'public' AND t.relname = $2`,
            [cname, ORDERS_TABLE]
          );
          if ((existsQ.rowCount ?? 0) === 0) {
            pendingChecks.push(cname);
          }
        }
        if (pendingChecks.length > 0) {
          // Terapkan satu per satu agar partial failure terdeteksi eksplisit.
          const statements = POS_SERVICE_TAX_ORDER_CHECKS_DDL
            .split(';')
            .map((s: string) => s.trim())
            .filter((s: string) => s.length > 0 && !s.startsWith('--'));
          for (const stmt of statements) {
            const m = stmt.match(/ADD CONSTRAINT (\w+)/);
            if (m && pendingChecks.includes(m[1])) {
              await client.query(stmt);
            }
          }
        }

        const verify = await verifyPosServiceTaxSchema(client);

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
          const markerVerify = await verifyPosServiceTaxMarker(client);

          if (!markerVerify.ok) {
            result = {
              ok: false,
              applied: false,
              status: 'verification-failed',
              errors: [
                ...markerVerify.errors,
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
        // JANGAN re-DDL secara diam-diam.
        // Verifikasi schema final + marker.
        const verify = await verifyPosServiceTaxSchema(client);
        const markerVerify = await verifyPosServiceTaxMarker(client);

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

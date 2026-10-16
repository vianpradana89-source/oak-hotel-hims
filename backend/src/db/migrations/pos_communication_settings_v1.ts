/**
 * POS COMMUNICATION SETTINGS v1 ΓÇö Fondasi Tabel Pengaturan Pesan WhatsApp POS
 * DDL Authoritative:
 *   - CREATE TABLE property_pos_communication_settings
 *     (konfigurasi pesan WhatsApp per properti untuk receipt POS)
 *
 * Kontrak:
 * - Tabel baru standalone; TIDAK mengubah tabel lain apa pun:
 *   pos_orders, pos_order_items, pos_settlements, transactions, properties,
 *   property_payment_instructions, audit_logs ΓÇö semua tidak disentuh.
 * - V1 hanya tiga field bisnis:
 *   - whatsapp_enabled BOOLEAN NOT NULL DEFAULT TRUE
 *     (default TRUE = backward compatibility: bila belum ada baris
 *      konfigurasi, perilaku dianggap aktif dengan pesan standar)
 *   - whatsapp_intro_message TEXT NULL
 *   - whatsapp_closing_message TEXT NULL
 * - Satu baris per properti: UNIQUE (property_id), FK ke properties(id)
 *   dengan ON DELETE RESTRICT (integritas audit trail).
 * - Idempoten: CREATE TABLE IF NOT EXISTS + marker ΓåÆ safe untuk re-run.
 * - Migration transactional dengan advisory lock.
 * - Marker: `pos_communication_settings_v1` pada `schema_migrations`.
 * - Verifikasi struktur & marker SETELAH marker (mismatch ΓåÆ gagal eksplisit,
 *   tanpa repair otomatis).
 *
 * Prerequisite:
 *   - Tabel `properties` HARUS sudah ada (referensi FK).
 *   - Tabel `schema_migrations` HARUS sudah ada untuk marker.
 *   Jika tidak, migration GAGAL eksplisit ΓÇö TIDAK membuat schema tebakan.
 *
 * Catatan untuk fase berikutnya (A2 ΓÇö service):
 * - id memakai `GENERATED ALWAYS AS IDENTITY`: service WAJIB menulis INSERT
 *   tanpa kolom `id` (biarkan identity menghasilkan).
 * - Batas panjang intro/closing (mis. 500 karakter) diverifikasi di lapisan
 *   service/frontend, bukan di DDL (kolom TEXT tanpa CHECK panjang ΓÇö
 *   konsisten dengan payment_note/transfer_ref_note yang juga TEXT).
 *
 * Gunakan via runner CLI:
 *   node backend/scripts/run_pos_communication_settings_migration.js
 * dengan MIGRATION_DATABASE_URL eksplisit.
 *
 * Runner: backend/scripts/run_pos_communication_settings_migration.js.
 * Runner staging: backend/scripts/run_pos_communication_settings_migration_staging.js.
 */

import { Pool, PoolClient } from 'pg';

const MARKER = 'pos_communication_settings_v1';

const TABLE = 'property_pos_communication_settings';

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
 * Otoritas: pg_class + pg_namespace ΓÇö relkind 'r' (table) atau 'p' (partitioned table).
 */
export async function checkPrerequisites(
  client: PoolClient
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  const tables = [
    'properties',
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
      // ΓåÆ gagal eksplisit di sini, bukan di tengah transaksi.
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
// DDL ΓÇö semua statement dalam satu string; dieksekusi berurutan dalam 1 transaksi
// =============================================================================

export const POS_COMMUNICATION_SETTINGS_DDL = `
-- Tabel konfigurasi pesan WhatsApp per properti untuk receipt POS.
-- Satu baris per properti; default enabled=TRUE menjaga backward compatibility.
CREATE TABLE IF NOT EXISTS property_pos_communication_settings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Scope properti: INTEGER sesuai properties.id (SERIAL)
  property_id INTEGER NOT NULL,

  -- V1: tiga field bisnis
  whatsapp_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  whatsapp_intro_message TEXT NULL,
  whatsapp_closing_message TEXT NULL,

  -- Audit metadata
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by VARCHAR(100) NULL,

  -- FK eksplisit (ON DELETE RESTRICT: baris konfigurasi tidak boleh ditinggalkan
  -- saat properti dihapus ΓÇö integritas audit trail).
  CONSTRAINT fk_pos_comm_settings_property
    FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE RESTRICT,

  -- Satu baris per properti
  CONSTRAINT uq_pos_comm_settings_property
    UNIQUE (property_id)
);
`;

export const MARKER_SQL = `
INSERT INTO schema_migrations (version) VALUES ('pos_communication_settings_v1')
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
 * Verifikasi definisi SKEMA AKTUAL property_pos_communication_settings:
 * - tabel ada di schema public
 * - tiap kolom: nama, tipe (udt_name), nullability, default
 * - PRIMARY KEY identity pada id
 * - UNIQUE constraint (property_id) + backing index valid
 * - FK constraint (property_id ΓåÆ properties.id, ON DELETE RESTRICT)
 *
 * Otoritas: pg_catalog (pg_attribute, pg_class, pg_namespace, pg_type,
 * pg_constraint, pg_index, pg_attrdef).
 * information_schema sengaja tidak digunakan sebagai authority structural
 * checks karena visibility filtering dapat memberi false-negative pada
 * role runner staging.
 */
export async function verifyPosCommunicationSettingsSchema(
  client: PoolClient
): Promise<VerificationResult> {
  const errors: string[] = [];

  // ΓöÇΓöÇ Tabel harus ada di public ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  const tblCheck = await client.query(
    `SELECT c.oid FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = $1
       AND c.relkind IN ('r','p')`,
    [TABLE]
  );
  if ((tblCheck.rowCount ?? 0) === 0) {
    errors.push(`Tabel public.${TABLE} tidak ditemukan`);
    return { ok: false, errors };
  }

  // ΓöÇΓöÇ Helper: periksa kolom integer ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  async function checkIntegerColumn(
    colName: string,
    expectedNullable: boolean
  ): Promise<void> {
    const r = await client.query(
      `SELECT t.typname AS udt_name,
              CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS nullable
       FROM pg_attribute a
       JOIN pg_class c     ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t      ON t.oid = a.atttypid
       WHERE n.nspname = 'public'
         AND c.relname = $1
         AND c.relkind IN ('r','p')
         AND a.attname = $2
         AND a.attnum > 0
         AND NOT a.attisdropped`,
      [TABLE, colName]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(`Kolom ${TABLE}.${colName} tidak ditemukan`);
      return;
    }
    const row = r.rows[0];
    if (row.udt_name !== 'int4') {
      errors.push(
        `Kolom ${TABLE}.${colName}: udt_name=${row.udt_name}, ekspektasi 'int4'`
      );
    }
    if (row.nullable !== (expectedNullable ? 'YES' : 'NO')) {
      errors.push(
        `Kolom ${TABLE}.${colName}: nullable=${row.nullable}, ` +
        `ekspektasi ${expectedNullable ? 'YES' : 'NO'}`
      );
    }
  }

  // ΓöÇΓöÇ Helper: periksa kolom bigint ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  async function checkBigIntColumn(colName: string): Promise<void> {
    const r = await client.query(
      `SELECT t.typname AS udt_name,
              CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS nullable
       FROM pg_attribute a
       JOIN pg_class c     ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t      ON t.oid = a.atttypid
       WHERE n.nspname = 'public'
         AND c.relname = $1
         AND c.relkind IN ('r','p')
         AND a.attname = $2
         AND a.attnum > 0
         AND NOT a.attisdropped`,
      [TABLE, colName]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(`Kolom ${TABLE}.${colName} tidak ditemukan`);
      return;
    }
    const row = r.rows[0];
    if (row.udt_name !== 'int8') {
      errors.push(
        `Kolom ${TABLE}.${colName}: udt_name=${row.udt_name}, ekspektasi 'int8'`
      );
    }
    if (row.nullable !== 'NO') {
      errors.push(`Kolom ${TABLE}.${colName}: nullable=${row.nullable}, ekspektasi 'NO'`);
    }
  }

  // ΓöÇΓöÇ Helper: periksa kolom boolean (dengan default) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  // expectedDefault: bentuk EXACT hasil pg_get_expr(ad.adbin, ad.adrelid).
  // PostgreSQL menyimpan default boolean secara lowercase ('true'/'false'),
  // sehingga ekspektasi wajib 'true' (bukan 'TRUE') ΓÇö pola pos_order_expansion_v1.
  async function checkBooleanColumn(
    colName: string,
    expectedDefault: string
  ): Promise<void> {
    const r = await client.query(
      `SELECT t.typname AS udt_name,
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
      [TABLE, colName]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(`Kolom ${TABLE}.${colName} tidak ditemukan`);
      return;
    }
    const row = r.rows[0];
    if (row.udt_name !== 'bool') {
      errors.push(
        `Kolom ${TABLE}.${colName}: udt_name=${row.udt_name}, ekspektasi 'bool'`
      );
    }
    if (row.nullable !== 'NO') {
      errors.push(`Kolom ${TABLE}.${colName}: nullable=${row.nullable}, ekspektasi 'NO'`);
    }
    if (String(row.column_default ?? '') !== expectedDefault) {
      errors.push(
        `Kolom ${TABLE}.${colName}: default=${row.column_default}, ` +
        `ekspektasi '${expectedDefault}'`
      );
    }
  }

  // ΓöÇΓöÇ Helper: periksa kolom text (nullable, tanpa default yang menyimpang) ΓöÇ
  // Kolom TEXT nullable wajib memiliki default NULL ΓÇö
  // DDL eksplisit `TEXT NULL` tidak boleh menghasilkan default lain apa pun.
  async function checkTextColumn(
    colName: string,
    expectedNullable: boolean
  ): Promise<void> {
    const r = await client.query(
      `SELECT t.typname AS udt_name,
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
      [TABLE, colName]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(`Kolom ${TABLE}.${colName} tidak ditemukan`);
      return;
    }
    const row = r.rows[0];
    if (row.udt_name !== 'text') {
      errors.push(
        `Kolom ${TABLE}.${colName}: udt_name=${row.udt_name}, ekspektasi 'text'`
      );
    }
    if (row.nullable !== (expectedNullable ? 'YES' : 'NO')) {
      errors.push(
        `Kolom ${TABLE}.${colName}: nullable=${row.nullable}, ` +
        `ekspektasi ${expectedNullable ? 'YES' : 'NO'}`
      );
    }
    // Kolom nullable TEXT tanpa default eksplisit: pg_attrdef tidak ada ΓåÆ NULL.
    // Jika default tidak NULL ditemukan, skema menyimpang dari DDL ekspektasi.
    if (expectedNullable && row.column_default !== null) {
      errors.push(
        `Kolom ${TABLE}.${colName}: default='${row.column_default}', ` +
        `ekspektasi NULL (kolom TEXT nullable tanpa default eksplisit)`
      );
    }
  }

  // ΓöÇΓöÇ Helper: periksa kolom varchar ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  async function checkVarcharColumn(
    colName: string,
    expectedMaxLen: number,
    expectedNullable: boolean
  ): Promise<void> {
    const r = await client.query(
      `SELECT t.typname AS udt_name,
              CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS nullable,
              CASE WHEN t.typname = 'varchar' AND a.atttypmod > 4
                   THEN a.atttypmod - 4 ELSE NULL
              END AS max_len
       FROM pg_attribute a
       JOIN pg_class c     ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t      ON t.oid = a.atttypid
       WHERE n.nspname = 'public'
         AND c.relname = $1
         AND c.relkind IN ('r','p')
         AND a.attname = $2
         AND a.attnum > 0
         AND NOT a.attisdropped`,
      [TABLE, colName]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(`Kolom ${TABLE}.${colName} tidak ditemukan`);
      return;
    }
    const row = r.rows[0];
    if (row.udt_name !== 'varchar') {
      errors.push(
        `Kolom ${TABLE}.${colName}: udt_name=${row.udt_name}, ekspektasi 'varchar'`
      );
    }
    if (Number(row.max_len) !== expectedMaxLen) {
      errors.push(
        `Kolom ${TABLE}.${colName}: max_len=${row.max_len}, ekspektasi ${expectedMaxLen}`
      );
    }
    if (row.nullable !== (expectedNullable ? 'YES' : 'NO')) {
      errors.push(
        `Kolom ${TABLE}.${colName}: nullable=${row.nullable}, ` +
        `ekspektasi ${expectedNullable ? 'YES' : 'NO'}`
      );
    }
  }

  // ΓöÇΓöÇ Helper: periksa kolom timestamp (dengan default CURRENT_TIMESTAMP) ΓöÇ
  async function checkTimestampColumn(colName: string): Promise<void> {
    const r = await client.query(
      `SELECT t.typname AS udt_name,
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
      [TABLE, colName]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(`Kolom ${TABLE}.${colName} tidak ditemukan`);
      return;
    }
    const row = r.rows[0];
    // TIMESTAMP (tanpa timezone) ΓÇö konsisten dengan property_payment_instructions.
    if (row.udt_name !== 'timestamp') {
      errors.push(
        `Kolom ${TABLE}.${colName}: udt_name=${row.udt_name}, ` +
        `ekspektasi 'timestamp' (tanpa timezone)`
      );
    }
    if (row.nullable !== 'NO') {
      errors.push(`Kolom ${TABLE}.${colName}: nullable=${row.nullable}, ekspektasi 'NO'`);
    }
    const def = String(row.column_default ?? '').trim().toLowerCase();
    if (def !== 'current_timestamp' && def !== 'now()' && def !== 'localtimestamp') {
      errors.push(
        `Kolom ${TABLE}.${colName}: default=${row.column_default}, ` +
        `ekspektasi current_timestamp`
      );
    }
  }

  // ΓöÇΓöÇ Kolom per kontrak ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  await checkBigIntColumn('id');
  await checkIntegerColumn('property_id', false);
  await checkBooleanColumn('whatsapp_enabled', 'true');
  await checkTextColumn('whatsapp_intro_message', true);
  await checkTextColumn('whatsapp_closing_message', true);
  await checkTimestampColumn('created_at');
  await checkTimestampColumn('updated_at');
  await checkVarcharColumn('updated_by', 100, true);

  // ΓöÇΓöÇ PRIMARY KEY identity pada id ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ∩┐╜∩┐╜ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
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
      ['public.' + TABLE, TABLE]
    );
    if ((pkQ.rowCount ?? 0) === 0) {
      errors.push(`PRIMARY KEY pada public.${TABLE} tidak ditemukan (contype='p')`);
    } else {
      for (const pkRow of pkQ.rows) {
        if (pkRow.col_name !== 'id') {
          errors.push(
            `PK ${pkRow.conname}: kolom=${pkRow.col_name}, ekspektasi 'id'`
          );
        }
        if (pkRow.convalidated !== true) {
          errors.push(`PK ${pkRow.conname}: convalidated=false`);
        }
        if (pkRow.condeferrable !== false) {
          errors.push(`PK ${pkRow.conname}: condeferrable=true, ekspektasi false (non-deferrable)`);
        }
      }
    }

    // Identity: kolom id harus memiliki identity (pg_attrdef tidak ada
    // untuk identity; cek via pg_attribute identity_option).
    const idOptQ = await client.query(
      `SELECT a.attidentity
       FROM pg_attribute a
       JOIN pg_class c     ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = $1
         AND c.relkind IN ('r','p')
         AND a.attname = 'id'
         AND a.attnum > 0
         AND NOT a.attisdropped`,
      [TABLE]
    );
    if ((idOptQ.rowCount ?? 0) === 0) {
      errors.push(`Kolom ${TABLE}.id tidak ditemukan untuk cek identity`);
    } else {
      // attidentity: 'a' = ALWAYS, 'd' = BY DEFAULT. Kontrak: ALWAYS.
      if (idOptQ.rows[0].attidentity !== 'a') {
        errors.push(
          `Kolom ${TABLE}.id: attidentity='${idOptQ.rows[0].attidentity}', ` +
          `ekspektasi 'a' (GENERATED ALWAYS)`
        );
      }
    }
  }

  // ΓöÇΓöÇ UNIQUE constraint (property_id) + backing index ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
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
      ['uq_pos_comm_settings_property', 'public.' + TABLE]
    );
    if ((uqQ.rowCount ?? 0) === 0) {
      errors.push(
        `UNIQUE constraint uq_pos_comm_settings_property tidak ditemukan (contype='u')`
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
          `UNIQUE uq_pos_comm_settings_property: kolom=[${cols.join(',')}], ` +
          `ekspektasi [property_id]`
        );
      }
      if (row.condeferrable !== false) {
        errors.push(`UNIQUE uq_pos_comm_settings_property: condeferrable=true, ekspektasi false`);
      }
      if (row.convalidated !== true) {
        errors.push(`UNIQUE uq_pos_comm_settings_property: convalidated=false`);
      }
      if (row.idx_valid !== true) errors.push(`UNIQUE uq_pos_comm_settings_property: backing index indisvalid=false`);
      if (row.idx_ready !== true) errors.push(`UNIQUE uq_pos_comm_settings_property: backing index indisready=false`);
      if (row.idx_live !== true) errors.push(`UNIQUE uq_pos_comm_settings_property: backing index indislive=false`);
      if (row.idx_unique !== true) errors.push(`UNIQUE uq_pos_comm_settings_property: backing index indisunique=false`);
    }
  }

  // ΓöÇΓöÇ FK constraint (property_id ΓåÆ properties.id, ON DELETE RESTRICT) ΓöÇΓöÇΓöÇ
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
      ['fk_pos_comm_settings_property', 'public.' + TABLE]
    );
    if ((fkQ.rowCount ?? 0) === 0) {
      errors.push(`FK constraint fk_pos_comm_settings_property tidak ditemukan (contype='f')`);
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
          `FK fk_pos_comm_settings_property: kolom lokal=[${localCols.join(',')}], ` +
          `ekspektasi [property_id]`
        );
      }
      if (row.ref_schema !== 'public' || row.ref_table !== 'properties') {
        errors.push(
          `FK fk_pos_comm_settings_property: tabel referensi=${row.ref_schema}.${row.ref_table}, ` +
          `ekspektasi public.properties`
        );
      }
      if (refCols.length !== 1 || refCols[0] !== 'id') {
        errors.push(
          `FK fk_pos_comm_settings_property: kolom referensi=[${refCols.join(',')}], ` +
          `ekspektasi [id]`
        );
      }
      // ON DELETE RESTRICT ΓåÆ confdeltype 'r'
      if (row.confdeltype !== 'r') {
        errors.push(
          `FK fk_pos_comm_settings_property: confdeltype=${row.confdeltype}, ` +
          `ekspektasi 'r' (ON DELETE RESTRICT)`
        );
      }
      if (row.condeferrable !== false) {
        errors.push(`FK fk_pos_comm_settings_property: condeferrable=true, ekspektasi false`);
      }
      if (row.convalidated !== true) {
        errors.push(`FK fk_pos_comm_settings_property: convalidated=false`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// =============================================================================
// Verifikasi Marker
// =============================================================================

/**
 * Verifikasi bahwa marker pos_communication_settings_v1 tepat satu row
 * tersedia di schema_migrations.
 *
 * Query eksak:
 *   SELECT 1 FROM schema_migrations WHERE version = 'pos_communication_settings_v1'
 *
 * Dipakai:
 * - Jalur "applied": dipanggil SETELAH INSERT MARKER_SQL, untuk memastikan
 *   marker benar-benar ditulis.
 * - Jalur "already-applied": dipanggil untuk memastikan marker tetap ada.
 *
 * Jika gagal: caller harus menandai status='verification-failed'/'mismatch'
 * dan membiarkan finally ROLLBACK.
 */
export async function verifyPosCommunicationSettingsMarker(
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
 * Jalankan migration pos communication settings. Transactional + advisory lock.
 *
 * Pre-flight: cek prerequisite (properties & schema_migrations harus ada).
 *
 * Jalur "applied" (marker belum ada):
 *   1. BEGIN
 *   2. advisory lock
 *   3. DDL (CREATE TABLE IF NOT EXISTS + constraint)
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
 *   5. COMMIT ΓåÆ already-applied
 *
 * Status:
 * - 'prerequisite-failed' : tabel dasar tidak tersedia.
 * - 'applied'             : DDL baru diterapkan + marker diverifikasi.
 * - 'already-applied'     : marker sudah ada, skema & marker sesuai, tanpa re-DDL.
 * - 'mismatch'            : marker ada tetapi skema/marker tidak sesuai ΓåÆ ROLLBACK.
 * - 'verification-failed' : DDL baru diterapkan tetapi verifikasi gagal ΓåÆ ROLLBACK.
 * - 'error'               : exception di tengah transaksi ΓåÆ ROLLBACK.
 *
 * @returns { ok, applied, status, errors }
 */
export async function runPosCommunicationSettingsMigration(
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
        await client.query(POS_COMMUNICATION_SETTINGS_DDL);

        const verify = await verifyPosCommunicationSettingsSchema(client);

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
          const markerVerify = await verifyPosCommunicationSettingsMarker(client);

          if (!markerVerify.ok) {
            result = {
              ok: false,
              applied: false,
              status: 'verification-failed',
              errors: [
                ...markerVerify.errors,
                'Marker gagal diverifikasi setelah INSERT ΓÇö transaksi di-ROLLBACK.',
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
        const verify = await verifyPosCommunicationSettingsSchema(client);
        const markerVerify = await verifyPosCommunicationSettingsMarker(client);

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

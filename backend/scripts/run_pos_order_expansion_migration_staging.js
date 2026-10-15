#!/usr/bin/env node
/**
 * RUNNER MIGRASI POS ORDER EXPANSION - STAGING (TERPISAH DARI RUNNER DISPOSABLE)
 *
 * Target:
 *   Project  : oak-lawang-pms
 *   Region   : asia-southeast2
 *   Instance : oak-lawang-pms:asia-southeast2:oak-hims-staging-db15
 *   Socket   : /cloudsql/oak-lawang-pms:asia-southeast2:oak-hims-staging-db15
 *   Port     : 5432
 *   Database : oak_hotel_db
 *   User     : postgres
 *
 * Koneksi:
 *   DB_HOST, DB_PORT, DB_USER, DB_NAME dari env (tanpa fallback).
 *   DB_PASSWORD dari env (tidak pernah dicetak).
 *   Tanpa dotenv, tanpa DATABASE_URL, tanpa PG* fallback.
 *
 * Argumen:
 *   WAJIB PERSIS SATU flag: --check atau --apply.
 *   - Tanpa flag               -> exit 1
 *   - Campuran (--check --apply) -> exit 1
 *   - Argumen tambahan         -> exit 1
 *
 * Keamanan:
 *   - Pool dibuat dari field eksplisit hasil validasi env.
 *   - Perbandingan env target, pool.options, dan identitas DB
 *     memakai equality EXACT (tanpa normalisasi case).
 *   - Semua kegagalan setelah pool dibuat dilempar sebagai exception;
 *     penutupan pool terpusat di jalur akhir main (sukses maupun gagal).
 *   - --check selalu dalam transaksi READ ONLY; client dilepas di finally.
 *   - DB_PASSWORD tidak pernah dicetak.
 */

'use strict';

const path = require('path');
const { Pool } = require('pg');

// Allowlist target staging (TEPAT, tanpa variasi)
const TARGET = {
  host:     '/cloudsql/oak-lawang-pms:asia-southeast2:oak-hims-staging-db15',
  port:     5432,
  user:     'postgres',
  database: 'oak_hotel_db',
};

const MARKER = 'pos_order_expansion_v1';

// ── 1. Parse argumen: WAJIB PERSIS SATU flag ─────────────────────────────────
const argv = process.argv.slice(2);
let mode = null;
if (argv.length === 1 && argv[0] === '--check') {
  mode = 'check';
} else if (argv.length === 1 && argv[0] === '--apply') {
  mode = 'apply';
}

if (!mode) {
  console.error(
    '[POS ORDER EXPANSION STAGING] Argumen tidak valid.\n' +
    '  WAJIB PERSIS SATU flag:\n' +
    '    node run_pos_order_expansion_migration_staging.js --check\n' +
    '    node run_pos_order_expansion_migration_staging.js --apply\n' +
    '  Argumen diterima: ' + JSON.stringify(argv)
  );
  process.exit(1);
}

// ── 2. Wajib env DB_* (tanpa fallback) ──────────��───────────────────────────
const MISSING = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME', 'DB_PASSWORD']
  .filter((k) => !process.env[k] || String(process.env[k]).trim() === '');

if (MISSING.length > 0) {
  console.error('[POS ORDER EXPANSION STAGING] Env wajib tidak tersedia: ' + MISSING.join(', '));
  process.exit(1);
}

const envHost    = String(process.env.DB_HOST).trim();
const envPortRaw = String(process.env.DB_PORT).trim();
const envUser    = String(process.env.DB_USER).trim();
const envDb      = String(process.env.DB_NAME).trim();
const envPass    = String(process.env.DB_PASSWORD); // tidak pernah dicetak

// ── 3. Verifikasi target: equality EXACT dengan allowlist staging ─────────
// (Sebelum pool dibuat; process.exit aman karena belum ada pool.)
const targetMismatches = [
  ['DB_HOST',   envHost,    TARGET.host],
  ['DB_PORT',   envPortRaw, '5432'],
  ['DB_USER',   envUser,    TARGET.user],
  ['DB_NAME',   envDb,      TARGET.database],
].filter(([, got, want]) => got !== want);

if (targetMismatches.length) {
  for (const [field, got, want] of targetMismatches) {
    console.error('[POS ORDER EXPANSION STAGING] DITOLAK: ' + field + '="' + got + '" != allowlist "' + want + '".');
  }
  console.error('[POS ORDER EXPANSION STAGING] Target tidak sesuai allowlist staging.');
  process.exit(1);
}

console.log(
  '[POS ORDER EXPANSION STAGING] Mode: ' + mode + ' | ' +
  'host=' + TARGET.host + ' port=' + TARGET.port + ' user=' + TARGET.user + ' db=' + TARGET.database
);

// ── 4. Pool (field eksplisit, tanpa connectionString) ───────────────────────
const pool = new Pool({
  host:     TARGET.host,
  port:     TARGET.port,
  user:     TARGET.user,
  password: envPass,
  database: TARGET.database,
});

/** Verifikasi pool.options sesuai target SEBELUM koneksi (equality exact). */
function verifyPoolOptions() {
  const got = pool.options;
  const mismatches = [
    ['host',     got.host,     TARGET.host],
    ['port',     got.port,     TARGET.port],
    ['user',     got.user,     TARGET.user],
    ['database', got.database, TARGET.database],
  ].filter(([, g, w]) => g !== w)
   .map(([field, g, w]) => field + '="' + String(g) + '" != allowlist "' + String(w) + '"');
  if (mismatches.length) {
    throw new Error('pool.options DITOLAK: ' + mismatches.join('; '));
  }
  console.log('[POS ORDER EXPANSION STAGING] pool.options terverifikasi.');
}

/** Tutup pool lalu exit (terpusat; satu-satunya jalur penutup pool). */
async function exitWith(code) {
  await pool.end().catch(() => {});
  process.exit(code);
}

// ── 5. Verifikasi identitas server (equality EXACT, sebelum mutasi) ────────
async function verifyIdentity() {
  const cfg = await pool.query(
    'SELECT current_database() AS db, current_user AS usr, ' +
    'inet_server_addr() AS srv_host, inet_server_port() AS srv_port'
  );
  const row = cfg.rows[0] || {};
  const db  = String(row.db ?? '');
  const usr = String(row.usr ?? '');
  if (db !== TARGET.database) {
    throw new Error('current_database "' + db + '" != allowlist "' + TARGET.database + '".');
  }
  if (usr !== TARGET.user) {
    throw new Error('current_user "' + usr + '" != allowlist "' + TARGET.user + '".');
  }
  console.log(
    '[POS ORDER EXPANSION STAGING] Identitas terverifikasi: db=' + db + ' user=' + usr +
    ' server=' + (row.srv_host ?? 'n/a') + ':' + (row.srv_port ?? 'n/a')
  );
}

// ── 6. Import modul migration dari dist ─────────────────────────────────────
function loadMigrationModule() {
  const distPath = path.resolve(__dirname, '..', 'dist', 'db', 'migrations', 'pos_order_expansion_v1');
  try {
    return require(distPath);
  } catch (err) {
    throw new Error(
      'Gagal import modul migration dari dist: ' + err.message + ' - ' +
      'pastikan dist/db/migrations/pos_order_expansion_v1.js tersedia (build TypeScript).'
    );
  }
}

// ── 7. Cek keberadaan struktur eksplisit (read-only, bukan parse error) ────
// Daftar struktur yang menjadi milik migration ini.
// Authority: pg_catalog (pg_attribute, pg_class, pg_namespace, pg_type,
// pg_constraint, pg_index, permissions).
//
// information_schema / pg_indexes view sengaja tidak digunakan sebagai
// authority structural checks karena visibility filtering dapat memberi
// false-negative pada role runner staging.
// Tidak ada DDL, tidak ada parse teks error.

const STRUCTURAL_COLUMNS = [
  // pos_orders
  { table: 'pos_orders', column: 'guest_phone' },
  { table: 'pos_orders', column: 'notes' },
  { table: 'pos_orders', column: 'discount_type' },
  { table: 'pos_orders', column: 'discount_value' },
  { table: 'pos_orders', column: 'discount_reason' },
  { table: 'pos_orders', column: 'discount_amount' },
  // pos_order_items
  { table: 'pos_order_items', column: 'discount_type' },
  { table: 'pos_order_items', column: 'discount_value' },
  { table: 'pos_order_items', column: 'discount_amount' },
  // pos_settlements
  { table: 'pos_settlements', column: 'cash_received' },
  { table: 'pos_settlements', column: 'change_due' },
  { table: 'pos_settlements', column: 'payment_reference' },
  { table: 'pos_settlements', column: 'verified_by' },
  { table: 'pos_settlements', column: 'verified_at' },
  // property_payment_instructions
  { table: 'property_payment_instructions', column: 'qris_enabled' },
  { table: 'property_payment_instructions', column: 'qris_terminal_name' },
  { table: 'property_payment_instructions', column: 'qris_merchant_id' },
  { table: 'property_payment_instructions', column: 'qris_image_path' },
  { table: 'property_payment_instructions', column: 'transfer_enabled' },
  { table: 'property_payment_instructions', column: 'transfer_ref_note' },
  { table: 'property_payment_instructions', column: 'debit_enabled' },
  { table: 'property_payment_instructions', column: 'debit_edc_terminal' },
];

const STRUCTURAL_CONSTRAINTS = [
  'chk_pos_orders_discount_type',
  'chk_pos_orders_discount_value',
  'chk_pos_orders_discount_percent',
  'chk_pos_orders_discount_amount_nonneg',
  'chk_pos_order_items_discount_type',
  'chk_pos_order_items_discount_value',
  'chk_pos_order_items_discount_percent',
  'chk_pos_order_items_discount_amount_nonneg',
  'chk_pos_settlements_cash_received_nonneg',
  'chk_pos_settlements_change_due_nonneg',
];

const STRUCTURAL_INDEXES = [
  'idx_pos_orders_discount',
];

const STRUCTURAL_PERMISSION = 'pos.discount.edit';

async function checkStructuralPresence(client) {
  // 1) Kolom: cek semua sekaligus via pg_catalog (pg_attribute + pg_class + pg_namespace)
  //    information_schema sengaja tidak dipakai — visibility filtering dapat memberi
  //    false-negative pada role runner staging.
  const colResult = await client.query(
    `SELECT c.relname AS table_name,
            a.attname AS column_name
     FROM pg_attribute a
     JOIN pg_class c     ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r','p')
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND (
         (c.relname = 'pos_orders'                 AND a.attname = ANY($1::text[]))
         OR (c.relname = 'pos_order_items'          AND a.attname = ANY($2::text[]))
         OR (c.relname = 'pos_settlements'          AND a.attname = ANY($3::text[]))
         OR (c.relname = 'property_payment_instructions' AND a.attname = ANY($4::text[]))
       )`,
    [
      ['guest_phone', 'notes', 'discount_type', 'discount_value', 'discount_reason', 'discount_amount'],
      ['discount_type', 'discount_value', 'discount_amount'],
      ['cash_received', 'change_due', 'payment_reference', 'verified_by', 'verified_at'],
      ['qris_enabled', 'qris_terminal_name', 'qris_merchant_id', 'qris_image_path',
       'transfer_enabled', 'transfer_ref_note', 'debit_enabled', 'debit_edc_terminal'],
    ]
  );
  const foundColumns = new Set(
    colResult.rows.map((r) => r.table_name + '.' + r.column_name)
  );

  const columnsPresent = STRUCTURAL_COLUMNS.filter(
    ({ table, column }) => foundColumns.has(table + '.' + column)
  );
  const columnsMissing = STRUCTURAL_COLUMNS.filter(
    ({ table, column }) => !foundColumns.has(table + '.' + column)
  );

  // 2) Constraints: cek via pg_constraint
  const consResult = await client.query(
    `SELECT c.conname, t.relname AS table_name
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND c.conname = ANY($1::text[])`,
    [STRUCTURAL_CONSTRAINTS]
  );
  const foundConstraints = new Set(consResult.rows.map((r) => r.conname));
  const constraintsPresent = STRUCTURAL_CONSTRAINTS.filter((n) => foundConstraints.has(n));
  const constraintsMissing = STRUCTURAL_CONSTRAINTS.filter((n) => !foundConstraints.has(n));

  // 3) Index: cek via pg_catalog (pg_class + pg_index + pg_namespace)
  //    Otoritas lebih authoritative daripada view pg_indexes.
  const idxResult = await client.query(
    `SELECT ic.relname AS indexname,
            tc.relname AS tablename
     FROM pg_class ic
     JOIN pg_namespace ins ON ins.oid = ic.relnamespace
     JOIN pg_index ix ON ix.indexrelid = ic.oid
     JOIN pg_class tc ON tc.oid = ix.indrelid
     WHERE ins.nspname = 'public'
       AND ic.relname = ANY($1::text[])`,
    [STRUCTURAL_INDEXES]
  );
  const foundIndexes = new Set(idxResult.rows.map((r) => r.indexname));
  const indexesPresent = STRUCTURAL_INDEXES.filter((n) => foundIndexes.has(n));
  const indexesMissing = STRUCTURAL_INDEXES.filter((n) => !foundIndexes.has(n));

  // 4) Permission: cek via permissions
  const permResult = await client.query(
    `SELECT key FROM permissions WHERE key = $1`,
    [STRUCTURAL_PERMISSION]
  );
  const permissionPresent = (permResult.rowCount ?? 0) > 0;

  const totalStructural =
    STRUCTURAL_COLUMNS.length +
    STRUCTURAL_CONSTRAINTS.length +
    STRUCTURAL_INDEXES.length +
    1; // permission
  const foundCount =
    columnsPresent.length +
    constraintsPresent.length +
    indexesPresent.length +
    (permissionPresent ? 1 : 0);

  return {
    columnsPresent,
    columnsMissing,
    constraintsPresent,
    constraintsMissing,
    indexesPresent,
    indexesMissing,
    permissionPresent,
    foundCount,
    totalStructural,
    nonePresent: foundCount === 0,
    allPresent: foundCount === totalStructural,
  };
}

// ── 8. Mode: --check (read-only readiness dalam transaksi READ ONLY) ──────
// Mengembalikan state string; semua kegagalan di-throw (bukan process.exit).
async function runCheck(pool, migration) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');

    // 1) checkPrerequisites dari modul migration
    const prereq = await migration.checkPrerequisites(client);
    if (!prereq.ok) {
      for (const e of prereq.errors) console.error('[CHECK] Prerequisite: ' + e);
      throw new Error('Prerequisite check gagal: ' + prereq.errors.join('; '));
    }
    console.log('[CHECK] Prerequisites: LULUS.');

    // 2) Tabel schema_migrations harus ada (pg_catalog authoritative)
    const hasTable = await client.query(
      `SELECT c.oid FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = 'schema_migrations'
         AND c.relkind IN ('r','p')`
    );
    if ((hasTable.rowCount ?? 0) === 0) {
      throw new Error('Tabel public.schema_migrations tidak ditemukan.');
    }
    console.log('[CHECK] public.schema_migrations: ada.');

    // 3) Marker
    const marker = await client.query(
      'SELECT applied_at FROM schema_migrations WHERE version = $1', [MARKER]
    );
    const markerExists = (marker.rowCount ?? 0) > 0;
    if (markerExists) {
      console.log('[CHECK] Marker ' + MARKER + ': ADA (applied_at=' + marker.rows[0].applied_at + ').');
    } else {
      console.log('[CHECK] Marker ' + MARKER + ': tidak ada.');
    }

    // 4) Keberadaan struktur eksplisit (read-only, via katalog PG)
    const structural = await checkStructuralPresence(client);
    if (structural.nonePresent) {
      console.log('[CHECK] Struktur migration: TIDAK ADA satu pun.');
    } else if (structural.allPresent) {
      console.log('[CHECK] Struktur migration: SEMUA ADA (' + structural.foundCount + '/' + structural.totalStructural + ').');
    } else {
      console.log('[CHECK] Struktur migration: SEBAGIAN ada (' + structural.foundCount + '/' + structural.totalStructural + ').');
      if (structural.columnsMissing.length) {
        console.log('  Kolom hilang: [' + structural.columnsMissing.map((c) => c.table + '.' + c.column).join(', ') + ']');
      }
      if (structural.constraintsMissing.length) {
        console.log('  Constraint hilang: [' + structural.constraintsMissing.join(', ') + ']');
      }
      if (structural.indexesMissing.length) {
        console.log('  Index hilang: [' + structural.indexesMissing.join(', ') + ']');
      }
      if (!structural.permissionPresent) {
        console.log('  Permission hilang: [' + STRUCTURAL_PERMISSION + ']');
      }
    }

    // 5) State determination
    if (markerExists) {
      // Marker ADA: jalankan verifier; jika gagal → mismatch EXIT 1
      const verify = await migration.verifyPosOrderExpansionSchema(client);
      if (verify.ok) {
        console.log('[CHECK] Verifikasi skema: LULUS.');
        await client.query('COMMIT');
        return 'ALREADY_APPLIED';
      }
      for (const e of verify.errors) console.error('[CHECK] GAGAL: ' + e);
      throw new Error('Marker ada tetapi verifikasi skema tidak lulus (mismatch - tolak, diagnosis manual diperlukan).');
    }

    // Marker TIDAK ADA:
    if (structural.nonePresent) {
      // Clean pre-migration: TIDAK SATU PUN struktur ada
      await client.query('COMMIT');
      return 'READY_TO_APPLY';
    }

    // Sebagian struktur ada → jalankan verifier untuk membedakan READY_TO_MARK vs PARTIAL
    const verify = await migration.verifyPosOrderExpansionSchema(client);
    if (verify.ok) {
      // Semua struktur ada + verifier lulus → READY_TO_MARK (jangan tulis marker)
      console.log('[CHECK] Verifikasi skema: LULUS.');
      await client.query('COMMIT');
      return 'READY_TO_MARK';
    }

    // Marker tidak ada + verifier gagal + struktur parsial → PARTIAL_OR_MISMATCHED
    for (const e of verify.errors) console.error('[CHECK] GAGAL: ' + e);
    throw new Error(
      'PARTIAL_OR_MISMATCHED_SCHEMA - marker tidak ada, ' +
      structural.foundCount + '/' + structural.totalStructural +
      ' struktur ada, verifikasi gagal - tolak, diagnosis manual diperlukan.'
    );
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* transaksi sudah berakhir */ }
    throw err;
  } finally {
    client.release();
  }
}

// ── 9. Mode: --apply (DDL + marker) ─────────────────────────────────────────
async function runApply(pool, migration) {
  const result = await migration.runPosOrderExpansionMigration(pool);
  if (result.ok) {
    console.log(
      '[APPLY] Berhasil - status: ' + result.status +
      (result.applied ? ' (DDL baru diterapkan)' : ' (marker sudah ada, skema sesuai)')
    );
  } else {
    console.error('[APPLY] GAGAL - status: ' + result.status);
    for (const e of result.errors) {
      console.error('  ' + e);
    }
    throw new Error('Migration gagal: ' + result.errors.join('; '));
  }
}

// ── 10. Main: semua kegagalan di-throw; penutupan pool terpusat ────────────
async function run() {
  verifyPoolOptions();
  const migration = loadMigrationModule();

  // Verifikasi identitas SEBELUM apa pun (check maupun apply)
  await verifyIdentity();

  if (mode === 'check') {
    const state = await runCheck(pool, migration);
    console.log('[POS ORDER EXPANSION STAGING] --check selesai: ' + state + '.');
    return;
  }

  // mode === 'apply'
  await runApply(pool, migration);
}

run()
  .then(async () => { await exitWith(0); })
  .catch(async (err) => {
    console.error('[POS ORDER EXPANSION STAGING] GAGAL: ' + ((err && err.message) || err));
    await exitWith(1);
  });

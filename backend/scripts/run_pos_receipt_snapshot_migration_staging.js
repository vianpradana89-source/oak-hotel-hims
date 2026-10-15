#!/usr/bin/env node
/**
 * RUNNER MIGRASI POS RECEIPT SNAPSHOT - STAGING (TERPISAH DARI RUNNER DISPOSABLE)
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

// ── Allowlist target staging (TEPAT, tanpa variasi) ─────────────────────
const TARGET = {
  host:     '/cloudsql/oak-lawang-pms:asia-southeast2:oak-hims-staging-db15',
  port:     5432,
  user:     'postgres',
  database: 'oak_hotel_db',
};

// NODE_ENV wajib production untuk staging runner
const REQUIRED_NODE_ENV = 'production';

const MARKER = 'pos_receipt_snapshot_v1';

// ── 1. NODE_ENV guard ───────────────────────────────────────────────────
const nodeEnv = String(process.env.NODE_ENV ?? '').trim();
if (nodeEnv !== REQUIRED_NODE_ENV) {
  console.error(
    '[POS RECEIPT SNAPSHOT STAGING] NODE_ENV="' + nodeEnv + '" tidak sesuai. ' +
    'Runner staging wajib NODE_ENV="' + REQUIRED_NODE_ENV + '".');
  process.exit(1);
}

// ── 2. Parse argumen: WAJIB PERSIS SATU flag ───────────────────────────
const argv = process.argv.slice(2);
let mode = null;
if (argv.length === 1 && argv[0] === '--check') {
  mode = 'check';
} else if (argv.length === 1 && argv[0] === '--apply') {
  mode = 'apply';
}

if (!mode) {
  console.error(
    '[POS RECEIPT SNAPSHOT STAGING] Argumen tidak valid.\n' +
    '  WAJIB PERSIS SATU flag:\n' +
    '    node run_pos_receipt_snapshot_migration_staging.js --check\n' +
    '    node run_pos_receipt_snapshot_migration_staging.js --apply\n' +
    '  Argumen diterima: ' + JSON.stringify(argv)
  );
  process.exit(1);
}

// ── 3. Wajib env DB_* (tanpa fallback) ─────────────────────────────────
const MISSING = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME', 'DB_PASSWORD']
  .filter((k) => !process.env[k] || String(process.env[k]).trim() === '');

if (MISSING.length > 0) {
  console.error('[POS RECEIPT SNAPSHOT STAGING] Env wajib tidak tersedia: ' + MISSING.join(', '));
  process.exit(1);
}

const envHost    = String(process.env.DB_HOST).trim();
const envPortRaw = String(process.env.DB_PORT).trim();
const envUser    = String(process.env.DB_USER).trim();
const envDb      = String(process.env.DB_NAME).trim();
const envPass    = String(process.env.DB_PASSWORD); // tidak pernah dicetak

// ── 4. Verifikasi target: equality EXACT dengan allowlist staging ──────
const targetMismatches = [
  ['DB_HOST',   envHost,    TARGET.host],
  ['DB_PORT',   envPortRaw, '5432'],
  ['DB_USER',   envUser,    TARGET.user],
  ['DB_NAME',   envDb,      TARGET.database],
].filter(([, got, want]) => got !== want);

if (targetMismatches.length) {
  for (const [field, got, want] of targetMismatches) {
    console.error('[POS RECEIPT SNAPSHOT STAGING] DITOLAK: ' + field + '="' + got + '" != allowlist "' + want + '".');
  }
  console.error('[POS RECEIPT SNAPSHOT STAGING] Target tidak sesuai allowlist staging.');
  process.exit(1);
}

console.log(
  '[POS RECEIPT SNAPSHOT STAGING] Mode: ' + mode + ' | ' +
  'host=' + TARGET.host + ' port=' + TARGET.port + ' user=' + TARGET.user + ' db=' + TARGET.database
);

// ── 5. Pool (field eksplisit, tanpa connectionString) ───────────────────
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
  console.log('[POS RECEIPT SNAPSHOT STAGING] pool.options terverifikasi.');
}

// ── 6. Verifikasi identitas server (equality EXACT, sebelum mutasi) ─────
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
    '[POS RECEIPT SNAPSHOT STAGING] Identitas terverifikasi: db=' + db + ' user=' + usr +
    ' server=' + (row.srv_host ?? 'n/a') + ':' + (row.srv_port ?? 'n/a')
  );
}

// ── 7. Import modul migration dari dist ────────────────────────────────
function loadMigrationModule() {
  const distPath = path.resolve(__dirname, '..', 'dist', 'db', 'migrations', 'pos_receipt_snapshot_v1');
  try {
    return require(distPath);
  } catch (err) {
    throw new Error(
      'Gagal import modul migration dari dist: ' + err.message + ' - ' +
      'pastikan dist/db/migrations/pos_receipt_snapshot_v1.js tersedia (build TypeScript).'
    );
  }
}

// ── 8. Structural presence check (pg_catalog authoritative) ─────────────
// Kolom structural yang ditambahkan migration ini.
// Authority: pg_catalog (pg_attribute + pg_class + pg_namespace).
// information_schema / pg_tables sengaja tidak dipakai — visibility filtering
// dapat memberi false-negative pada role runner staging.
const RECEIPT_SNAPSHOT_COLUMNS = [
  { table: 'pos_order_items', column: 'item_name_snapshot' },
  { table: 'pos_order_items', column: 'item_code_snapshot' },
];

async function checkStructuralPresence(client) {
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
       AND c.relname = 'pos_order_items'
       AND a.attname IN ('item_name_snapshot', 'item_code_snapshot')`
  );
  const found = new Set(colResult.rows.map((r) => r.table_name + '.' + r.column_name));
  const columnsPresent = RECEIPT_SNAPSHOT_COLUMNS.filter(
    ({ table, column }) => found.has(table + '.' + column)
  );
  const columnsMissing = RECEIPT_SNAPSHOT_COLUMNS.filter(
    ({ table, column }) => !found.has(table + '.' + column)
  );
  return {
    columnsPresent,
    columnsMissing,
    nonePresent: columnsPresent.length === 0,
    allPresent:  columnsMissing.length === 0,
  };
}

// ── 9. Historical resolution preflight (READ ONLY) ─────────────────────
// Hitung row pos_order_items yang TIDAK akan menghasilkan item_name_snapshot
// non-null dari BACKFILL_SQL. Backfill mengisi dari pos_menu_items.name;
// bila menu_item tidak ada atau pmi.name IS NULL → baris tetap NULL.
//
// Query:
//   SELECT COUNT(*) FROM pos_order_items poi
//   LEFT JOIN pos_menu_items pmi ON pmi.id = poi.menu_item_id
//   WHERE pmi.id IS NULL OR pmi.name IS NULL
//
// Jika hasil > 0 → migration akan ROLLBACK pada tahap unresolved check.
// Sample kecil (maks 20 row) dicetak hanya jika unresolved > 0.
// TIDAK MUTASI, TIDAK FILL, TIDAK PERBAIKI DATA.
async function countUnresolvedHistory(client) {
  const cntRes = await client.query(
    `SELECT COUNT(*) AS cnt
     FROM pos_order_items poi
     LEFT JOIN pos_menu_items pmi ON pmi.id = poi.menu_item_id
     WHERE pmi.id IS NULL OR pmi.name IS NULL`
  );
  const count = Number(cntRes.rows[0]?.cnt ?? 0);

  if (count > 0) {
    const sampleRes = await client.query(
      `SELECT poi.id AS poi_id,
              poi.menu_item_id,
              (pmi.id IS NULL) AS master_missing,
              pmi.name         AS master_name
       FROM pos_order_items poi
       LEFT JOIN pos_menu_items pmi ON pmi.id = poi.menu_item_id
       WHERE pmi.id IS NULL OR pmi.name IS NULL
       LIMIT 20`
    );
    console.log('[CHECK] ' + count + ' baris pos_order_items TIDAK dapat di-resolve ke pos_menu_items.name.');
    console.log('[CHECK] Sample (maks 20):');
    for (const r of sampleRes.rows) {
      const masterMissing = r.master_missing ? 'YA' : 'TIDAK';
      const name = r.master_name ?? '(NULL)';
      console.log(
        '  poi.id=' + r.poi_id +
        ' menu_item_id=' + (r.menu_item_id ?? '(NULL)') +
        ' master_missing=' + masterMissing +
        ' master_name=' + name
      );
    }
  }

  return count;
}

// ── 10. Mode: --check (read-only readiness dalam transaksi READ ONLY) ──
// runCheck TIDAK memanggil pool.end() atau process.exit().
// State non-zero dikembalikan sebagai { state, exitCode } melalui return value.
// finally selalu client.release(); penutupan pool terpusat di jalur main.
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

    // 2) schema_migrations existence (pg_catalog authoritative)
    const smRes = await client.query(
      `SELECT c.oid FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = 'schema_migrations'
         AND c.relkind IN ('r','p')`
    );
    if ((smRes.rowCount ?? 0) === 0) {
      throw new Error('Tabel public.schema_migrations tidak ditemukan (pg_class, relkind r/p).');
    }
    console.log('[CHECK] public.schema_migrations: ada.');

    // 3) Marker
    const markerRes = await client.query(
      'SELECT applied_at FROM schema_migrations WHERE version = $1', [MARKER]
    );
    const markerExists = (markerRes.rowCount ?? 0) > 0;
    if (markerExists) {
      console.log('[CHECK] Marker ' + MARKER + ': ADA (applied_at=' + markerRes.rows[0].applied_at + ').');
    } else {
      console.log('[CHECK] Marker ' + MARKER + ': tidak ada.');
    }

    // 4) Structural presence
    const structural = await checkStructuralPresence(client);
    if (structural.nonePresent) {
      console.log('[CHECK] Struktur receipt snapshot: TIDAK ADA satu pun.');
    } else if (structural.allPresent) {
      console.log('[CHECK] Struktur receipt snapshot: SEMUA ADA.');
    } else {
      console.log('[CHECK] Struktur receipt snapshot: SEBAGIAN ada.');
      console.log('[CHECK]  Ada:   [' + structural.columnsPresent.map((c) => c.table + '.' + c.column).join(', ') + ']');
      console.log('[CHECK]  Hilang: [' + structural.columnsMissing.map((c) => c.table + '.' + c.column).join(', ') + ']');
    }

    // ── State machine ─────────────────────────────────────────────────────────
    // (historical preflight hanya di-clean pre-migration branch, di bawah)

    if (markerExists) {
      // MARKER ADA → snapshot sudah authoritative.
      // Master menu boleh berubah/hilang setelah snapshot dibuat;
      // historical resolution TIDAK dipakai sebagai blocker di sini.
      const verify = await migration.verifyPosReceiptSnapshotSchema(client);
      const markerVerify = await migration.verifyPosReceiptSnapshotMarker(client);
      if (verify.ok && markerVerify.ok) {
        console.log('[CHECK] Verifikasi skema & marker: LULUS.');
        await client.query('COMMIT');
        return { state: 'ALREADY_APPLIED', exitCode: 0 };
      }
      for (const e of verify.errors) console.error('[CHECK] GAGAL skema: ' + e);
      for (const e of markerVerify.errors) console.error('[CHECK] GAGAL marker: ' + e);
      await client.query('COMMIT');
      throw new Error('MARKER_MISMATCH: marker ada tetapi verifikasi skema/marker gagal (tolak, diagnosis manual diperlukan).');
    }

    // MARKER TIDAK ADA + sebagian struktur ada → PARTIAL_OR_MISMATCHED_SCHEMA
    if (!structural.nonePresent && !structural.allPresent) {
      console.error('[CHECK] PARTIAL_OR_MISMATCHED_SCHEMA: sebagian struktur ada, marker tidak ada.');
      console.error('[CHECK]  Ada:   [' + structural.columnsPresent.map((c) => c.table + '.' + c.column).join(', ') + ']');
      console.error('[CHECK]  Hilang: [' + structural.columnsMissing.map((c) => c.table + '.' + c.column).join(', ') + ']');
      await client.query('COMMIT');
      return { state: 'PARTIAL_OR_MISMATCHED_SCHEMA', exitCode: 1 };
    }

    // MARKER TIDAK ADA + SEMUA structural columns ada (allPresent=true)
    if (structural.allPresent) {
      // Jangan memakai unresolved count di sini; snapshot columns sudah ada.
      const verify = await migration.verifyPosReceiptSnapshotSchema(client);
      if (verify.ok) {
        // FINAL SCHEMA VALID, MARKER HILANG → READY_TO_MARK_OR_RECONCILE
        console.error('[CHECK] READY_TO_MARK_OR_RECONCILE: kedua kolom ada & skema valid, tetapi marker ' + MARKER + ' tidak ada.');
        console.error('[CHECK] Migration TIDAK akan otomatis apply/mark. Review manual diperlukan sebelum lanjut.');
        await client.query('COMMIT');
        return { state: 'READY_TO_MARK_OR_RECONCILE', exitCode: 1 };
      }
      for (const e of verify.errors) console.error('[CHECK] GAGAL: ' + e);
      await client.query('COMMIT');
      return { state: 'SCHEMA_MISMATCH_MARKER_ABSENT', exitCode: 1 };
    }

    // MARKER TIDAK ADA + TIDAK ADA satu pun structural column (clean pre-migration)
    // Historical resolution preflight HANYA relevan di branch ini.
    const unresolvedCount = await countUnresolvedHistory(client);
    console.log('[CHECK] Unresolved historical pos_order_items (item_name_snapshot tetap NULL): ' + unresolvedCount + '.');
    if (unresolvedCount === 0) {
      await client.query('COMMIT');
      return { state: 'READY_TO_APPLY', exitCode: 0 };
    }
    // BLOCKED_BY_UNRESOLVED_HISTORY
    console.error('[CHECK] BLOCKED_BY_UNRESOLVED_HISTORY: ' + unresolvedCount + ' baris pos_order_items tidak dapat di-resolve.');
    console.error('[CHECK] Migration TIDAK AMAN dijalankan sebelum data diperbaiki (unresolved history harus di-correct pertama).');
    await client.query('COMMIT');
    return { state: 'BLOCKED_BY_UNRESOLVED_HISTORY', exitCode: 1 };


  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* transaksi sudah berakhir */ }
    throw err;
  } finally {
    client.release();
  }
}

// ── 11. Mode: --apply (DDL + backfill + marker) ────────────────────────
async function runApply(pool, migration) {
  const result = await migration.runPosReceiptSnapshotMigration(pool);
  if (result.ok) {
    console.log(
      '[APPLY] Berhasil - status: ' + result.status +
      (result.applied ? ' (DDL + backfill + SET NOT NULL + marker baru diterapkan)' : ' (marker sudah ada, skema sesuai)')
    );
  } else {
    console.error('[APPLY] GAGAL - status: ' + result.status);
    for (const e of result.errors) {
      console.error('  ' + e);
    }
    throw new Error('Migration gagal: ' + result.errors.join('; '));
  }
}

// ── 12. Main: semua kegagalan di-throw; penutupan pool terpusat ─────────
async function run() {
  verifyPoolOptions();
  const migration = loadMigrationModule();

  // Verifikasi identitas SEBELUM apa pun (check maupun apply)
  await verifyIdentity();

  if (mode === 'check') {
    const { state, exitCode } = await runCheck(pool, migration);
    pendingExitCode = exitCode;
    if (exitCode === 0) {
      console.log('[POS RECEIPT SNAPSHOT STAGING] --check selesai: ' + state + '.');
    } else {
      console.error('[POS RECEIPT SNAPSHOT STAGING] --check selesai: ' + state + ' (exit 1).');
    }
    return;
  }

  // mode === 'apply'
  await runApply(pool, migration);
}

let pendingExitCode = 0;

run()
  .then(async () => {
    if (mode === 'check') {
      // pendingExitCode sudah di-set di dalam run()
    }
    await pool.end().catch(() => {});
    process.exit(pendingExitCode);
  })
  .catch(async (err) => {
    console.error('[POS RECEIPT SNAPSHOT STAGING] GAGAL: ' + ((err && err.message) || err));
    await pool.end().catch(() => {});
    process.exit(1);
  });
#!/usr/bin/env node
/**
 * RUNNER MIGRASI POS IDEMPOTENCY - STAGING (TERPISAH DARI RUNNER DISPOSABLE)
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
 *   DB_PASSWORD dari Secret Manager (oak-hims-staging-db-postgres-password).
 *   Tanpa dotenv, tanpa URL credential, tanpa PG_DB fallback.
 *
 * Argumen:
 *   WAJIB PERSIS SATU flag: --check atau --apply.
 *   - Tanpa flag        -> exit 1
 *   - Campuran (--check --apply) -> exit 1
 *   - Argumen tambahan   -> exit 1
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

// KOLOM & INDEX EXPECTED (untuk state detection eksplisit, bukan teks error)
const EXPECTED_COLUMNS = ['idempotency_key', 'request_fingerprint'];
const EXPECTED_INDEXES = [
  'uq_pos_orders_idempotency',
  'idx_pos_orders_idempotency_key',
  'idx_pos_orders_reservation_id',
];

// ── 1. Parse argumen: WAJIB PERSIS SATU flag ────────────────────────────────
const argv = process.argv.slice(2);
let mode = null;
if (argv.length === 1 && argv[0] === '--check') {
  mode = 'check';
} else if (argv.length === 1 && argv[0] === '--apply') {
  mode = 'apply';
}

if (!mode) {
  console.error(
    '[POS IDEMPOTENCY STAGING] Argumen tidak valid.\n' +
    '  WAJIB PERSIS SATU flag:\n' +
    '    node run_pos_idempotency_migration_staging.js --check\n' +
    '    node run_pos_idempotency_migration_staging.js --apply\n' +
    '  Argumen diterima: ' + JSON.stringify(argv)
  );
  process.exit(1);
}

// ── 2. Wajib env DB_* (tanpa fallback) ─────────────────────────────────────
const MISSING = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME', 'DB_PASSWORD']
  .filter((k) => !process.env[k] || String(process.env[k]).trim() === '');

if (MISSING.length > 0) {
  console.error('[POS IDEMPOTENCY STAGING] Env wajib tidak tersedia: ' + MISSING.join(', '));
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
    console.error('[POS IDEMPOTENCY STAGING] DITOLAK: ' + field + '="' + got + '" != allowlist "' + want + '".');
  }
  console.error('[POS IDEMPOTENCY STAGING] Target tidak sesuai allowlist staging.');
  process.exit(1);
}

console.log(
  '[POS IDEMPOTENCY STAGING] Mode: ' + mode + ' | ' +
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
  console.log('[POS IDEMPOTENCY STAGING] pool.options terverifikasi.');
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
    '[POS IDEMPOTENCY STAGING] Identitas terverifikasi: db=' + db + ' user=' + usr +
    ' server=' + (row.srv_host ?? 'n/a') + ':' + (row.srv_port ?? 'n/a')
  );
}

// ── 6. Import modul migration dari dist ────────────────────────────────────
function loadMigrationModule() {
  const distPath = path.resolve(__dirname, '..', 'dist', 'db', 'migrations', 'pos_idempotency_v1');
  try {
    return require(distPath);
  } catch (err) {
    throw new Error(
      'Gagal import modul migration dari dist: ' + err.message + ' - ' +
      'pastikan dist/db/migrations/pos_idempotency_v1.js tersedia (build TypeScript).'
    );
  }
}

// ── 7. Cek keberadaan struktur eksplisit (bukan parse teks error) ─────────
// Index dicari pada SELURUH schema public (semua tabel) — nama index expected
// yang dipakai objek/tabel lain harus terdeteksi sebagai konflik/mismatch.
async function checkStructuralPresence(client) {
  // Kolom pada pos_orders
  const colResult = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'pos_orders'
       AND column_name = ANY($1::text[])`,
    [EXPECTED_COLUMNS]
  );
  const columnsPresent = colResult.rows.map((r) => r.column_name);

  // Nama index expected di seluruh schema public (tabel apa pun)
  const idxResult = await client.query(
    `SELECT indexname, tablename FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = ANY($1::text[])`,
    [EXPECTED_INDEXES]
  );
  const indexesOnPosOrders   = idxResult.rows.filter((r) => r.tablename === 'pos_orders').map((r) => r.indexname);
  const foreignIndexConflicts = idxResult.rows.filter((r) => r.tablename !== 'pos_orders');

  return {
    columnsPresent,
    indexesPresent: indexesOnPosOrders,
    foreignIndexConflicts,
    allColumnsPresent: columnsPresent.length === EXPECTED_COLUMNS.length,
    allIndexesPresent:  indexesOnPosOrders.length === EXPECTED_INDEXES.length,
    // Benar-benar kosong: kolom tidak ada DAN nama index expected tidak
    // dipakai objek mana pun di schema public.
    nonePresent: columnsPresent.length === 0 && idxResult.rows.length === 0,
  };
}

// ── 8. Mode: --check (read-only readiness dalam transaksi READ ONLY) ──────
// Mengembalikan state string; semua kegagalan di-throw (bukan process.exit).
async function runCheck(pool, migration) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');

    // 1) Tabel pos_orders harus ada
    const tblCheck = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'pos_orders'`
    );
    if ((tblCheck.rowCount ?? 0) === 0) {
      throw new Error('Tabel public.pos_orders tidak ditemukan.');
    }
    console.log('[CHECK] public.pos_orders: ada.');

    // 2) Tabel schema_migrations harus ada
    const hasTable = await client.query(
      "SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'schema_migrations'"
    );
    if ((hasTable.rowCount ?? 0) === 0) {
      throw new Error('Tabel public.schema_migrations tidak ditemukan.');
    }
    console.log('[CHECK] public.schema_migrations: ada.');

    // 3) Marker
    const marker = await client.query(
      'SELECT applied_at FROM schema_migrations WHERE version = $1',
      ['pos_idempotency_v1']
    );
    const markerExists = (marker.rowCount ?? 0) > 0;
    if (markerExists) {
      console.log('[CHECK] Marker pos_idempotency_v1: ADA (applied_at=' + marker.rows[0].applied_at + ').');
    } else {
      console.log('[CHECK] Marker pos_idempotency_v1: tidak ada.');
    }

    // 4) Keberadaan struktur eksplisit (index: seluruh schema public)
    const structural = await checkStructuralPresence(client);
    console.log('[CHECK] Kolom ada: [' + structural.columnsPresent.join(', ') + ']/' + EXPECTED_COLUMNS.length + '.');
    console.log('[CHECK] Index di pos_orders: [' + structural.indexesPresent.join(', ') + ']/' + EXPECTED_INDEXES.length + '.');

    // 5) Konflik nama index: expected name dipakai tabel/objek lain -> mismatch
    if (structural.foreignIndexConflicts.length > 0) {
      const detail = structural.foreignIndexConflicts
        .map((r) => r.indexname + '@' + r.tablename)
        .join(', ');
      throw new Error(
        'Nama index expected dipakai objek/tabel lain di schema public: ' + detail +
        ' (mismatch - migrasi tidak aman dijalankan).'
      );
    }

    // 6) Struktur benar-benar kosong + marker tidak ada:
    //    langsung READY_TO_APPLY tanpa menjalankan verifier (belum relevan).
    if (!markerExists && structural.nonePresent) {
      await client.query('COMMIT');
      return 'READY_TO_APPLY';
    }

    // 7) Verifikasi skema penuh (read-only)
    const verify = await migration.verifyPosIdempotencySchema(client);
    const verifyOk = verify.ok;

    if (markerExists) {
      // Marker ada: wajib verifier lulus, jika tidak -> mismatch
      if (!verifyOk) {
        for (const e of verify.errors) console.error('[CHECK] GAGAL: ' + e);
        throw new Error('Marker ada tetapi verifikasi skema tidak lulus (mismatch).');
      }
      console.log('[CHECK] Verifikasi skema POS idempotency: LULUS.');
      await client.query('COMMIT');
      return 'ALREADY_APPLIED';
    }

    // Marker tidak ada:
    if (structural.allColumnsPresent && structural.allIndexesPresent) {
      if (verifyOk) {
        console.log('[CHECK] Verifikasi skema POS idempotency: LULUS.');
        await client.query('COMMIT');
        return 'READY_TO_MARK';
      }
      for (const e of verify.errors) console.error('[CHECK] GAGAL: ' + e);
      throw new Error('Struktur lengkap tetapi verifikasi skema gagal (definisi salah).');
    }

    // Parsial (beberapa kolom/index ada, beberapa tidak)
    for (const e of verify.errors) console.error('[CHECK] GAGAL: ' + e);
    throw new Error(
      'Schema parsial (kolom=' + structural.columnsPresent.length + '/' + EXPECTED_COLUMNS.length +
      ', index=' + structural.indexesPresent.length + '/' + EXPECTED_INDEXES.length +
      ') dan marker belum ada - tolak, diagnosis manual diperlukan.'
    );
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* transaksi sudah berakhir */ }
    throw err;
  } finally {
    client.release();
  }
}

// ── 9. Mode: --apply (DDL + marker) ────────────────────────────────────────
async function runApply(pool, migration) {
  const result = await migration.runPosIdempotencyMigration(pool);
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
    console.log('[POS IDEMPOTENCY STAGING] --check selesai: ' + state + '.');
    return;
  }

  // mode === 'apply'
  await runApply(pool, migration);
}

run()
  .then(async () => { await exitWith(0); })
  .catch(async (err) => {
    console.error('[POS IDEMPOTENCY STAGING] GAGAL: ' + ((err && err.message) || err));
    await exitWith(1);
  });

#!/usr/bin/env node
/**
 * RUNNER MIGRASI POS ORDER UPDATE v1 - STAGING (TERPISAH DARI RUNNER DISPOSABLE)
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
 *   Tanpa dotenv, tanpa DATABASE_URL, tanpa PG* fallback, tanpa fallback lokal.
 *
 * Argumen:
 *   WAJIB PERSIS SATU flag: --check atau --apply.
 *   - Tanpa flag                 -> exit 1
 *   - Campuran (--check --apply)  -> exit 1
 *   - Argumen tambahan            -> exit 1
 *
 * Keamanan:
 *   - Pool dibuat dari field eksplisit hasil validasi env.
 *   - Perbandingan env target, pool.options, dan identitas DB
 *     memakai equality EXACT (tanpa normalisasi case).
 *   - Cocokkan DB_HOST dengan socket staging secara EXACT sebelum koneksi.
 *   - Semua kegagalan setelah pool dibuat dilempar sebagai exception;
 *     penutupan pool terpusat di jalur akhir (sukses maupun gagal).
 *   - --check selalu dalam transaksi READ ONLY; client dilepas di finally.
 *   - Kondisi mismatch berbahaya pada --check -> exit nonzero.
 *   - DB_PASSWORD tidak pernah dicetak.
 *
 * Catatan kontrak modul migration (pos_order_update_v1):
 *   - runPosOrderUpdateMigration(pool) mengembalikan { status, errors }
 *     (status: applied | already-applied | verification-failed | error |
 *      prerequisite-failed), BUKAN { ok, applied }.
 *   - Modul TIDAK mengekspor verifyMarker; marker schema_migrations
 *     diperiksa langsung oleh runner ini.
 */

'use strict';

const path = require('path');
const { Pool } = require('pg');

// ——— Allowlist target staging (TEPAT, tanpa variasi) ———————————————————————————
const TARGET = {
  host:     '/cloudsql/oak-lawang-pms:asia-southeast2:oak-hims-staging-db15',
  port:     5432,
  user:     'postgres',
  database: 'oak_hotel_db',
};

// NODE_ENV wajib production untuk staging runner
const REQUIRED_NODE_ENV = 'production';

const MARKER = 'pos_order_update_v1';
const ORDER_TABLE = 'pos_orders';
const EDIT_TABLE  = 'pos_order_edit_requests';
const EDIT_INDEX  = 'idx_pos_order_edit_requests_order';

// ——— 1. NODE_ENV guard ——————————————————————————————————————————————————————
const nodeEnv = String(process.env.NODE_ENV ?? '').trim();
if (nodeEnv !== REQUIRED_NODE_ENV) {
  console.error(
    '[POS ORDER UPDATE STAGING] NODE_ENV="' + nodeEnv + '" tidak sesuai. ' +
    'Runner staging wajib NODE_ENV="' + REQUIRED_NODE_ENV + '".');
  process.exit(1);
}

// ——— 2. Parse argumen: WAJIB PERSIS SATU flag ————————————————————————————————————
const argv = process.argv.slice(2);
let mode = null;
if (argv.length === 1 && argv[0] === '--check') {
  mode = 'check';
} else if (argv.length === 1 && argv[0] === '--apply') {
  mode = 'apply';
}

if (!mode) {
  console.error(
    '[POS ORDER UPDATE STAGING] Argumen tidak valid.\n' +
    '  WAJIB PERSIS SATU flag:\n' +
    '    node run_pos_order_update_migration_staging.js --check\n' +
    '    node run_pos_order_update_migration_staging.js --apply\n' +
    '  Argumen diterima: ' + JSON.stringify(argv)
  );
  process.exit(1);
}

// ——— 3. Wajib env DB_* (tanpa fallback) ————————————————————————————————————————
const MISSING = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME', 'DB_PASSWORD']
  .filter((k) => !process.env[k] || String(process.env[k]).trim() === '');

if (MISSING.length > 0) {
  console.error('[POS ORDER UPDATE STAGING] Env wajib tidak tersedia: ' + MISSING.join(', '));
  process.exit(1);
}

const envHost    = String(process.env.DB_HOST).trim();
const envPortRaw = String(process.env.DB_PORT).trim();
const envUser    = String(process.env.DB_USER).trim();
const envDb      = String(process.env.DB_NAME).trim();
const envPass    = String(process.env.DB_PASSWORD); // tidak pernah dicetak

// ——— 4. Verifikasi target: equality EXACT dengan allowlist staging ————————
const targetMismatches = [
  ['DB_HOST',   envHost,    TARGET.host],
  ['DB_PORT',   envPortRaw, '5432'],
  ['DB_USER',   envUser,    TARGET.user],
  ['DB_NAME',   envDb,      TARGET.database],
].filter(([, got, want]) => got !== want);

if (targetMismatches.length) {
  for (const [field, got, want] of targetMismatches) {
    console.error('[POS ORDER UPDATE STAGING] DITOLAK: ' + field + '="' + got + '" != allowlist "' + want + '".');
  }
  console.error('[POS ORDER UPDATE STAGING] Target tidak sesuai allowlist staging.');
  process.exit(1);
}

console.log(
  '[POS ORDER UPDATE STAGING] Mode: ' + mode + ' | ' +
  'host=' + TARGET.host + ' port=' + TARGET.port + ' user=' + TARGET.user + ' db=' + TARGET.database
);

// ——— 5. Pool (field eksplisit, tanpa connectionString) ———————————————————————
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
  console.log('[POS ORDER UPDATE STAGING] pool.options terverifikasi.');
}

// ——— 6. Verifikasi identitas server (equality EXACT, sebelum mutasi) ———————
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
    '[POS ORDER UPDATE STAGING] Identitas terverifikasi: db=' + db + ' user=' + usr +
    ' server=' + (row.srv_host ?? 'n/a') + ':' + (row.srv_port ?? 'n/a')
  );
}

// ——— 7. Import modul migration dari dist ————————————————————————————————————————
function loadMigrationModule() {
  const distPath = path.resolve(__dirname, '..', 'dist', 'db', 'migrations', 'pos_order_update_v1');
  try {
    return require(distPath);
  } catch (err) {
    throw new Error(
      'Gagal import modul migration dari dist: ' + err.message + ' - ' +
      'pastikan dist/db/migrations/pos_order_update_v1.js tersedia (build TypeScript).'
    );
  }
}

// ——— 8. Structural presence check (pg_catalog authoritative) ———————————————————
// Authority: pg_catalog (pg_attribute/pg_class/pg_namespace), pg_indexes untuk index.
// information_schema sengaja tidak dipakai — visibility filtering dapat memberi
// false-negative pada role runner staging.
async function checkStructuralPresence(client) {
  // 1) Kolom pos_orders.version
  const versionRes = await client.query(
    `SELECT a.attname
     FROM pg_attribute a
     JOIN pg_class c     ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = $1
       AND c.relkind IN ('r','p')
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND a.attname = 'version'`,
    [ORDER_TABLE]
  );
  const versionColumnExists = (versionRes.rowCount ?? 0) > 0;

  // 2) Tabel pos_order_edit_requests
  const tblRes = await client.query(
    `SELECT c.oid
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = $1
       AND c.relkind IN ('r','p')`,
    [EDIT_TABLE]
  );
  const tableExists = (tblRes.rowCount ?? 0) > 0;

  // 3) Index idx_pos_order_edit_requests_order + deteksi konflik nama
  const idxRes = await client.query(
    `SELECT indexname, tablename
     FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = $1`,
    [EDIT_INDEX]
  );
  const indexOnEditTable   = idxRes.rows.filter((r) => r.tablename === EDIT_TABLE).map((r) => r.indexname);
  const foreignIndexConflicts = idxRes.rows.filter((r) => r.tablename !== EDIT_TABLE);
  const indexPresent = indexOnEditTable.length > 0;

  return {
    versionColumnExists,
    tableExists,
    indexPresent,
    foreignIndexConflicts,
    // Benar-benar kosong (clean pre-migration): kolom version belum ada DAN
    // tabel pos_order_edit_requests belum ada.
    nonePresent: !versionColumnExists && !tableExists,
    // Struktur inti lengkap (kolom version + tabel). Index dilaporkan terpisah.
    allPresent: versionColumnExists && tableExists,
  };
}

// ——— 9. Mode: --check (read-only readiness dalam transaksi READ ONLY) ———————
// runCheck TIDAK memanggil pool.end() atau process.exit().
// State & exitCode dikembalikan via return value; kondisi mismatch berbahaya
// menghasilkan exitCode=1.
// Release klien: satu percobaan per koneksi — jalur error di catch
// (release(true) bila ROLLBACK gagal), jalur sukses di finally.
async function runCheck(pool, migration) {
  const client = await pool.connect();
  let released = false;
  let result = null;
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');

    // 1) Prerequisite dari modul migration (schema_migrations + pos_orders)
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
    console.log('[CHECK] pos_orders.version: ' + (structural.versionColumnExists ? 'ada' : 'tidak ada') + '.');
    console.log('[CHECK] public.' + EDIT_TABLE + ': ' + (structural.tableExists ? 'ada' : 'tidak ada') + '.');
    console.log('[CHECK] Index ' + EDIT_INDEX + ': ' + (structural.indexPresent ? 'ada' : 'tidak ada') + '.');

    // 5) Konflik nama index: nama expected dipakai tabel/objek lain -> mismatch berbahaya
    if (structural.foreignIndexConflicts.length > 0) {
      const detail = structural.foreignIndexConflicts
        .map((r) => r.indexname + '@' + r.tablename)
        .join(', ');
      console.error('[CHECK] INDEX_NAME_CONFLICT: nama index ' + EDIT_INDEX + ' dipakai objek lain: ' + detail);
      await client.query('COMMIT');
      result = { state: 'INDEX_NAME_CONFLICT', exitCode: 1 };
      return result;
    }

    // ——— State machine ——————————————————————————————————————————————————————
    if (markerExists) {
      // MARKER ADA -> verifikasi skema final wajib lulus.
      const verify = await migration.verifyPosOrderUpdateSchema(client);
      if (verify.ok) {
        console.log('[CHECK] Verifikasi skema: LULUS.');
        await client.query('COMMIT');
        result = { state: 'ALREADY_APPLIED', exitCode: 0 };
        return result;
      }
      for (const e of verify.errors) console.error('[CHECK] GAGAL skema: ' + e);
      await client.query('COMMIT');
      result = { state: 'MARKER_MISMATCH', exitCode: 1 };
      return result;
    }

    // MARKER TIDAK ADA + SEBAGIAN struktur ada -> mismatch berbahaya
    if (!structural.nonePresent && !structural.allPresent) {
      console.error('[CHECK] PARTIAL_OR_MISMATCHED_SCHEMA: sebagian struktur ada, marker tidak ada.');
      console.error('[CHECK]  version=' + (structural.versionColumnExists ? 'ada' : 'tidak ada') +
                    ' tabel=' + (structural.tableExists ? 'ada' : 'tidak ada'));
      await client.query('COMMIT');
      result = { state: 'PARTIAL_OR_MISMATCHED_SCHEMA', exitCode: 1 };
      return result;
    }

    // MARKER TIDAK ADA + SEMUA struktur ada -> perlu review manual (jangan auto-mark)
    if (structural.allPresent) {
      const verify = await migration.verifyPosOrderUpdateSchema(client);
      if (verify.ok) {
        console.error('[CHECK] READY_TO_MARK_OR_RECONCILE: struktur ada & skema valid, tetapi marker ' + MARKER + ' tidak ada.');
        console.error('[CHECK] Migration TIDAK akan otomatis apply/mark. Review manual diperlukan sebelum lanjut.');
        await client.query('COMMIT');
        result = { state: 'READY_TO_MARK_OR_RECONCILE', exitCode: 1 };
        return result;
      }
      for (const e of verify.errors) console.error('[CHECK] GAGAL: ' + e);
      await client.query('COMMIT');
      result = { state: 'SCHEMA_MISMATCH_MARKER_ABSENT', exitCode: 1 };
      return result;
    }

    // MARKER TIDAK ADA + TIDAK ADA struktur (clean pre-migration)
    console.log('[CHECK] Struktur belum ada & marker belum ada: siap apply.');
    await client.query('COMMIT');
    result = { state: 'READY_TO_APPLY', exitCode: 0 };
    return result;

  } catch (err) {
    // ROLLBACK eksplisit. Bila ROLLBACK gagal (koneksi rusak), koneksi WAJIB
    // di-discard (release(true)), bukan dikembalikan ke pool.
    let rollbackFailed = false;
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      rollbackFailed = true;
      console.error(
        '[POS ORDER UPDATE STAGING] ROLLBACK gagal: ' +
        String((rbErr && rbErr.message) || rbErr)
      );
    }
    released = true;
    try {
      client.release(rollbackFailed);
    } catch (relErr) {
      console.error(
        '[POS ORDER UPDATE STAGING] client.release gagal: ' +
        String((relErr && relErr.message) || relErr)
      );
    }
    throw err;
  } finally {
    if (!released) {
      released = true;
      try {
        client.release();
      } catch (relErr) {
        console.error(
          '[POS ORDER UPDATE STAGING] client.release gagal: ' +
          String((relErr && relErr.message) || relErr)
        );
        // Cleanup gagal -> paksa non-zero tanpa mengubah state.
        if (result !== null) {
          result.exitCode = 1;
        }
      }
    }
  }
}

// ——— 10. Mode: --apply (DDL + marker) ————————————————————————————————————————
// Adaptasi kontrak modul: runPosOrderUpdateMigration mengembalikan { status, errors }.
async function runApply(pool, migration) {
  const result = await migration.runPosOrderUpdateMigration(pool);
  if (result.status === 'applied' || result.status === 'already-applied') {
    console.log(
      '[APPLY] Berhasil - status: ' + result.status +
      (result.status === 'applied' ? ' (DDL + marker diterapkan)' : ' (marker sudah ada, skema sesuai)')
    );
    return;
  }
  console.error('[APPLY] GAGAL - status: ' + result.status);
  for (const e of result.errors) {
    console.error('  ' + e);
  }
  throw new Error('Migration gagal - status: ' + result.status + ': ' + result.errors.join('; '));
}

// ——— 11. Main: semua kegagalan di-throw; penutupan pool terpusat ————————
async function run() {
  verifyPoolOptions();
  const migration = loadMigrationModule();

  // Verifikasi identitas SEBELUM apa pun (check maupun apply)
  await verifyIdentity();

  if (mode === 'check') {
    const { state, exitCode } = await runCheck(pool, migration);
    pendingExitCode = exitCode;
    if (exitCode === 0) {
      console.log('[POS ORDER UPDATE STAGING] --check selesai: ' + state + '.');
    } else {
      console.error('[POS ORDER UPDATE STAGING] --check selesai: ' + state + ' (exit 1).');
    }
    return;
  }

  // mode === 'apply'
  await runApply(pool, migration);
}

let pendingExitCode = 0;

run()
  .then(async () => {
    try {
      await pool.end();
    } catch (endErr) {
      console.error(
        '[POS ORDER UPDATE STAGING] pool.end gagal: ' +
        String((endErr && endErr.message) || endErr)
      );
      pendingExitCode = 1; // kegagalan penutupan koneksi memaksa exit non-zero
    }
    process.exit(pendingExitCode);
  })
  .catch(async (err) => {
    console.error('[POS ORDER UPDATE STAGING] GAGAL: ' + ((err && err.message) || err));
    try {
      await pool.end();
    } catch (endErr) {
      console.error(
        '[POS ORDER UPDATE STAGING] pool.end gagal: ' +
        String((endErr && endErr.message) || endErr)
      );
    }
    process.exit(1);
  });

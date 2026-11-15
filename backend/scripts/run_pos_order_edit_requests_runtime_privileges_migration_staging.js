#!/usr/bin/env node
/**
 * RUNNER CORRECTIVE RUNTIME PRIVILEGES POS ORDER EDIT REQUESTS v1
 * — STAGING (TERPISAH DARI RUNNER DISPOSABLE)
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
 * Konteks:
 *   Migration DDL pos_order_update_v1 sudah diterapkan pada staging
 *   (marker 'pos_order_update_v1' ada). Runtime Cloud Run memakai role oak_app
 *   sehingga endpoint PUT /api/pos/orders/:id mengalami error:
 *   "permission denied for table pos_order_edit_requests".
 *
 *   Corrective GRANT minimum:
 *     GRANT SELECT, INSERT
 *     ON TABLE public.pos_order_edit_requests TO oak_app;
 *     GRANT USAGE, SELECT
 *     ON SEQUENCE public.pos_order_edit_requests_id_seq TO oak_app;
 *     GRANT UPDATE (dan SELECT jika diperlukan)
 *     ON TABLE public.pos_orders TO oak_app; (jika belum ada)
 *   Marker corrective: 'pos_order_edit_requests_runtime_privileges_v1'.
 *
 * Koneksi:
 *   DB_HOST, DB_PORT, DB_USER, DB_NAME dari env (tanpa fallback).
 *   DB_PASSWORD dari env (tidak pernah dicetak).
 *   Tanpa dotenv, tanpa DATABASE_URL, tanpa PG* fallback.
 *
 * Argumen:
 *   WAJIB PERSIS SATU flag: --check atau --apply.
 *   - Tanpa flag                 -> exit 1
 *   - Campuran (--check --apply)  -> exit 1
 *   - Argumen tambahan           -> exit 1
 *
 * --check (read-only, transaksi READ ONLY, TIDAK mutasi apa pun):
 *   READY_TO_APPLY    : prerequisites ok + marker corrective TIDAK ada  -> exit 0
 *   ALREADY_APPLIED   : marker corrective ada + privileges lengkap      -> exit 0
 *   INVALID_PARTIAL   : prerequisites gagal ATAU marker ada tetapi
 *                       privileges hilang                                -> exit 1
 *
 * --apply (idempotent + fail-closed):
 *   - GRANT hanya dijalankan bila prerequisites (role oak_app, tabel,
 *     sequence, tabel pos_orders, marker utama DDL) terpenuhi.
 *   - Marker corrective hanya ditulis SETELAH semua GRANT sukses.
 *   - Marker sudah ada + privileges lengkap -> 'already-applied' (tanpa mutasi).
 *   - Marker sudah ada tetapi privileges hilang -> GAGAL eksplisit
 *     (MARKER_EXISTS_BUT_PRIVILEGES_INCOMPLETE, diagnosis manual).
 *
 * Keamanan:
 *   - NODE_ENV wajib 'production' (runner staging).
 *   - Pool dibuat dari field eksplisit hasil validasi env.
 *   - Perbandingan env target, pool.options, dan identitas DB
 *     memakai equality EXACT (tanpa normalisasi case).
 *   - --check selalu dalam transaksi READ ONLY; client dilepas di finally.
 *   - DB_PASSWORD tidak pernah dicetak.
 *   - TIDAK ada auto-run saat aplikasi startup — hanya via runner CLI.
 */

'use strict';

const path = require('path');
const { Pool } = require('pg');

// ─── Allowlist target staging (TEPAT, tanpa variasi) ──────────────────────────
const TARGET = {
  host:     '/cloudsql/oak-lawang-pms:asia-southeast2:oak-hims-staging-db15',
  port:     5432,
  user:     'postgres',
  database: 'oak_hotel_db',
};

// NODE_ENV wajib production untuk staging runner
const REQUIRED_NODE_ENV = 'production';

const CORRECTIVE_MARKER = 'pos_order_edit_requests_runtime_privileges_v1';
const PRIMARY_MARKER    = 'pos_order_update_v1';

// ─── 1. NODE_ENV guard ─────────────────────────────────────────────────────────
const nodeEnv = String(process.env.NODE_ENV ?? '').trim();
if (nodeEnv !== REQUIRED_NODE_ENV) {
  console.error(
    '[POS EDIT PRIVILEGES STAGING] NODE_ENV="' + nodeEnv + '" tidak sesuai. ' +
    'Runner staging wajib NODE_ENV="' + REQUIRED_NODE_ENV + '".'
  );
  process.exit(1);
}

// ─── 2. Parse argumen: WAJIB PERSIS SATU flag ─────────────────────────────────
const argv = process.argv.slice(2);
let mode = null;
if (argv.length === 1 && argv[0] === '--check') {
  mode = 'check';
} else if (argv.length === 1 && argv[0] === '--apply') {
  mode = 'apply';
}

if (!mode) {
  console.error(
    '[POS EDIT PRIVILEGES STAGING] Argumen tidak valid.\n' +
    '  WAJIB PERSIS SATU flag:\n' +
    '    node run_pos_order_edit_requests_runtime_privileges_migration_staging.js --check\n' +
    '    node run_pos_order_edit_requests_runtime_privileges_migration_staging.js --apply\n' +
    '  Argumen diterima: ' + JSON.stringify(argv)
  );
  process.exit(1);
}

// ─── 3. Wajib env DB_* (tanpa fallback) ───────────────────────────────────────
const MISSING = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME', 'DB_PASSWORD']
  .filter((k) => !process.env[k] || String(process.env[k]).trim() === '');

if (MISSING.length > 0) {
  console.error('[POS EDIT PRIVILEGES STAGING] Env wajib tidak tersedia: ' + MISSING.join(', '));
  process.exit(1);
}

const envHost    = String(process.env.DB_HOST).trim();
const envPortRaw = String(process.env.DB_PORT).trim();
const envUser    = String(process.env.DB_USER).trim();
const envDb      = String(process.env.DB_NAME).trim();
const envPass    = String(process.env.DB_PASSWORD); // tidak pernah dicetak

// ─── 4. Verifikasi target: equality EXACT dengan allowlist staging ────────────
const targetMismatches = [
  ['DB_HOST',   envHost,    TARGET.host],
  ['DB_PORT',   envPortRaw, '5432'],
  ['DB_USER',   envUser,    TARGET.user],
  ['DB_NAME',   envDb,      TARGET.database],
].filter(([, got, want]) => got !== want);

if (targetMismatches.length) {
  for (const [field, got, want] of targetMismatches) {
    console.error('[POS EDIT PRIVILEGES STAGING] DITOLAK: ' + field + '="' + got + '" != allowlist "' + want + '".');
  }
  console.error('[POS EDIT PRIVILEGES STAGING] Target tidak sesuai allowlist staging.');
  process.exit(1);
}

console.log(
  '[POS EDIT PRIVILEGES STAGING] Mode: ' + mode + ' | ' +
  'host=' + TARGET.host + ' port=' + TARGET.port + ' user=' + TARGET.user + ' db=' + TARGET.database
);

// ─── 5. Pool (field eksplisit, tanpa connectionString) ─────────────────────────
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
  console.log('[POS EDIT PRIVILEGES STAGING] pool.options terverifikasi.');
}

// ─── 6. Verifikasi identitas server (equality EXACT, sebelum mutasi) ──────────
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
    '[POS EDIT PRIVILEGES STAGING] Identitas terverifikasi: db=' + db + ' user=' + usr +
    ' server=' + (row.srv_host ?? 'n/a') + ':' + (row.srv_port ?? 'n/a')
  );
}

// ─── 7. Import modul corrective dari dist ──────────────────────────────────────
function loadPrivilegesModule() {
  const distPath = path.resolve(
    __dirname, '..', 'dist', 'db', 'migrations',
    'pos_order_edit_requests_runtime_privileges_v1'
  );
  try {
    const m = require(distPath);
    const required = [
      'checkPrivilegesPrerequisites',
      'inspectPrivilegesState',
      'privilegesComplete',
      'runPosOrderEditRequestsRuntimePrivilegesMigration',
    ];
    for (const fn of required) {
      if (typeof m[fn] !== 'function') {
        throw new Error('Export ' + fn + ' tidak ditemukan. Jalankan build ulang (tsc).');
      }
    }
    return m;
  } catch (err) {
    throw new Error(
      'Gagal import modul corrective dari dist: ' + err.message + ' — ' +
      'pastikan dist/db/migrations/pos_order_edit_requests_runtime_privileges_v1.js tersedia (build TypeScript).'
    );
  }
}

// ─── 8. Mode: --check (state machine read-only) ───────────────────────────────
async function runCheck(pool, migration) {
  const client = await pool.connect();
  let txnActive = false;
  let released = false;
  let result = null;
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    txnActive = true;

    // 1) Status objek & prerequisites (tanpa memicu exception Postgres bila objek hilang)
    const state = await migration.inspectPrivilegesState(client);

    console.log('[CHECK] ─── Verifikasi Objek Database ───');
    console.log('[CHECK] public.schema_migrations : ' + (state.schemaMigrationsExists ? 'ADA' : 'MISSING'));
    console.log('[CHECK] role oak_app             : ' + (state.roleExists ? 'ADA' : 'MISSING'));
    console.log('[CHECK] pos_orders               : ' + (state.posOrdersExists ? 'ADA' : 'MISSING'));
    console.log('[CHECK] pos_order_edit_requests  : ' + (state.tableExists ? 'ADA' : 'MISSING'));
    console.log('[CHECK] sequence edit_requests_id: ' + (state.sequenceExists ? 'ADA' : 'MISSING'));
    console.log('[CHECK] marker pos_order_update_v1: ' + (state.primaryMarkerExists ? 'ADA' : 'MISSING'));

    if (state.missingObjects.length > 0) {
      console.error('[CHECK] Ditemukan objek/marker prerequisite MISSING: ' + state.missingObjects.join(', '));
      result = { state: 'INVALID_PARTIAL', exitCode: 1 };
      try {
        await client.query('ROLLBACK');
        txnActive = false;
      } catch (rbErr) {
        console.error('[POS EDIT PRIVILEGES STAGING] ROLLBACK check gagal: ' + String((rbErr && rbErr.message) || rbErr));
        released = true;
        try { client.release(true); } catch (_) {}
      }
      return result;
    }

    // 2) Detail hak akses role oak_app
    console.log('[CHECK] ─── Status Hak Akses Role oak_app ───');
    console.log('[CHECK] pos_order_edit_requests (SELECT) : ' + (state.hasSelect ? 'GRANTED' : 'MISSING'));
    console.log('[CHECK] pos_order_edit_requests (INSERT) : ' + (state.hasInsert ? 'GRANTED' : 'MISSING'));
    console.log('[CHECK] sequence id (USAGE)              : ' + (state.hasSeqUsage ? 'GRANTED' : 'MISSING'));
    console.log('[CHECK] sequence id (SELECT)             : ' + (state.hasSeqSelect ? 'GRANTED' : 'MISSING'));
    console.log('[CHECK] pos_orders (SELECT)              : ' + (state.posOrdersHasSelect ? 'GRANTED' : 'MISSING'));
    console.log('[CHECK] pos_orders (UPDATE)              : ' + (state.posOrdersHasUpdate ? 'GRANTED' : 'MISSING'));

    // 3) Evaluasi state marker corrective
    console.log('[CHECK] ─── Evaluasi State Marker Corrective ───');
    console.log('[CHECK] Marker ' + CORRECTIVE_MARKER + ' : ' + (state.markerExists ? 'ADA' : 'BELUM ADA'));

    if (state.markerExists) {
      if (migration.privilegesComplete(state)) {
        console.log('[CHECK] Status: ALREADY_APPLIED (Marker ada dan semua hak akses runtime lengkap).');
        result = { state: 'ALREADY_APPLIED', exitCode: 0 };
      } else {
        const missing = [];
        if (!state.hasSelect) missing.push('pos_order_edit_requests:SELECT');
        if (!state.hasInsert) missing.push('pos_order_edit_requests:INSERT');
        if (!state.hasSeqUsage) missing.push('sequence:USAGE');
        if (!state.hasSeqSelect) missing.push('sequence:SELECT');
        if (!state.posOrdersHasSelect) missing.push('pos_orders:SELECT');
        if (!state.posOrdersHasUpdate) missing.push('pos_orders:UPDATE');
        console.error(
          '[CHECK] MARKER_EXISTS_BUT_PRIVILEGES_INCOMPLETE: marker ada tetapi privilege hilang [' +
          missing.join(', ') + ']. Diagnosis manual diperlukan.'
        );
        result = { state: 'INVALID_PARTIAL', exitCode: 1 };
      }
    } else {
      // Marker belum ada
      console.log('[CHECK] Status: READY_TO_APPLY (Prerequisite lengkap, siap dieksekusi dengan --apply).');
      result = { state: 'READY_TO_APPLY', exitCode: 0 };
    }

    // Tutup transaksi secara eksplisit SEBELUM release (read-only rollback)
    try {
      await client.query('ROLLBACK');
      txnActive = false;
    } catch (rbErr) {
      console.error('[POS EDIT PRIVILEGES STAGING] ROLLBACK check gagal: ' + String((rbErr && rbErr.message) || rbErr));
      result.exitCode = 1;
      released = true;
      try { client.release(true); } catch (_) {}
      return result;
    }

    return result;
  } catch (err) {
    let rollbackFailed = false;
    try {
      await client.query('ROLLBACK');
      txnActive = false;
    } catch (rbErr) {
      rollbackFailed = true;
      console.error('[POS EDIT PRIVILEGES STAGING] ROLLBACK check gagal: ' + String((rbErr && rbErr.message) || rbErr));
    }
    released = true;
    try {
      client.release(rollbackFailed);
    } catch (relErr) {
      console.error('[POS EDIT PRIVILEGES STAGING] client.release gagal: ' + String((relErr && relErr.message) || relErr));
    }
    throw err;
  } finally {
    if (!released) {
      released = true;
      try {
        client.release();
      } catch (relErr) {
        console.error('[POS EDIT PRIVILEGES STAGING] client.release gagal: ' + String((relErr && relErr.message) || relErr));
        if (result !== null) {
          result.exitCode = 1;
        }
      }
    }
    void txnActive;
  }
}

// ─── 9. Mode: --apply (GRANT + marker corrective) ─────────────────────────────
async function runApply(pool, migration) {
  const result = await migration.runPosOrderEditRequestsRuntimePrivilegesMigration(pool);
  if (result.ok) {
    console.log(
      '[APPLY] Berhasil - status: ' + result.status +
      (result.applied ? ' (GRANT + marker corrective baru diterapkan)' : ' (marker sudah ada, privileges sesuai)')
    );
  } else {
    console.error('[APPLY] GAGAL - status: ' + result.status);
    for (const e of result.errors) {
      console.error('  ' + e);
    }
    throw new Error('Corrective migration gagal: ' + result.errors.join('; '));
  }
}

// ─── 10. Main: semua kegagalan di-throw; penutupan pool terpusat ──────────────
async function run() {
  verifyPoolOptions();
  const migration = loadPrivilegesModule();

  // Verifikasi identitas SEBELUM apa pun (check maupun apply)
  await verifyIdentity();

  if (mode === 'check') {
    const { state, exitCode } = await runCheck(pool, migration);
    pendingExitCode = exitCode;
    if (exitCode === 0) {
      console.log('[POS EDIT PRIVILEGES STAGING] --check selesai: ' + state + '.');
    } else {
      console.error('[POS EDIT PRIVILEGES STAGING] --check selesai: ' + state + ' (exit 1).');
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
        '[POS EDIT PRIVILEGES STAGING] pool.end gagal: ' +
        String((endErr && endErr.message) || endErr)
      );
      pendingExitCode = 1;
    }
    process.exit(pendingExitCode);
  })
  .catch(async (err) => {
    console.error('[POS EDIT PRIVILEGES STAGING] GAGAL: ' + ((err && err.message) || err));
    try {
      await pool.end();
    } catch (endErr) {
      console.error(
        '[POS EDIT PRIVILEGES STAGING] pool.end gagal: ' +
        String((endErr && endErr.message) || endErr)
      );
    }
    process.exit(1);
  });

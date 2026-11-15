#!/usr/bin/env node
/**
 * RUNNER CORRECTIVE RUNTIME PRIVILEGES POS COMMUNICATION SETTINGS v1
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
 *   Migration DDL utama pos_communication_settings_v1 sudah diterapkan
 *   pada staging (marker 'pos_communication_settings_v1' ada). Runtime
 *   Cloud Run memakai role oak_app → corrective GRANT minimum:
 *     GRANT SELECT, INSERT, UPDATE
 *     ON TABLE public.property_pos_communication_settings TO oak_app;
 *     GRANT USAGE, SELECT
 *     ON SEQUENCE public.property_pos_communication_settings_id_seq TO oak_app;
 *   Marker corrective: 'pos_communication_settings_runtime_privileges_v1'.
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
 * --check (read-only, transaksi READ ONLY, TIDAK mutasi apa pun):
 *   READY_TO_APPLY    : prerequisites ok + marker corrective TIDAK ada  -> exit 0
 *   ALREADY_APPLIED   : marker corrective ada + privileges lengkap      -> exit 0
 *   INVALID_PARTIAL   : prerequisites gagal ATAU marker ada tetapi
 *                       privileges hilang                                -> exit 1
 *
 * --apply (idempotent + fail-closed):
 *   - GRANT hanya dijalankan bila prerequisites (role oak_app, tabel,
 *     sequence, marker utama DDL) terpenuhi.
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

const CORRECTIVE_MARKER = 'pos_communication_settings_runtime_privileges_v1';
const PRIMARY_MARKER    = 'pos_communication_settings_v1';

// ─── 1. NODE_ENV guard ─────────────────────────────────────────────────────────
const nodeEnv = String(process.env.NODE_ENV ?? '').trim();
if (nodeEnv !== REQUIRED_NODE_ENV) {
  console.error(
    '[POS COMM PRIVILEGES STAGING] NODE_ENV="' + nodeEnv + '" tidak sesuai. ' +
    'Runner staging wajib NODE_ENV="' + REQUIRED_NODE_ENV + '".');
  process.exit(1);
}

// ─── 2. Parse argumen: WAJIB PERSIS SATU flag ──────────���───────────────────────
const argv = process.argv.slice(2);
let mode = null;
if (argv.length === 1 && argv[0] === '--check') {
  mode = 'check';
} else if (argv.length === 1 && argv[0] === '--apply') {
  mode = 'apply';
}

if (!mode) {
  console.error(
    '[POS COMM PRIVILEGES STAGING] Argumen tidak valid.\n' +
    '  WAJIB PERSIS SATU flag:\n' +
    '    node run_pos_communication_settings_runtime_privileges_migration_staging.js --check\n' +
    '    node run_pos_communication_settings_runtime_privileges_migration_staging.js --apply\n' +
    '  Argumen diterima: ' + JSON.stringify(argv)
  );
  process.exit(1);
}

// ─── 3. Wajib env DB_* (tanpa fallback) ───────────────────────────────────────
const MISSING = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME', 'DB_PASSWORD']
  .filter((k) => !process.env[k] || String(process.env[k]).trim() === '');

if (MISSING.length > 0) {
  console.error('[POS COMM PRIVILEGES STAGING] Env wajib tidak tersedia: ' + MISSING.join(', '));
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
    console.error('[POS COMM PRIVILEGES STAGING] DITOLAK: ' + field + '="' + got + '" != allowlist "' + want + '".');
  }
  console.error('[POS COMM PRIVILEGES STAGING] Target tidak sesuai allowlist staging.');
  process.exit(1);
}

console.log(
  '[POS COMM PRIVILEGES STAGING] Mode: ' + mode + ' | ' +
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
  console.log('[POS COMM PRIVILEGES STAGING] pool.options terverifikasi.');
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
    '[POS COMM PRIVILEGES STAGING] Identitas terverifikasi: db=' + db + ' user=' + usr +
    ' server=' + (row.srv_host ?? 'n/a') + ':' + (row.srv_port ?? 'n/a')
  );
}

// ─── 7. Import modul corrective dari dist ──────────────────────────────────────
function loadPrivilegesModule() {
  const distPath = path.resolve(
    __dirname, '..', 'dist', 'db', 'migrations',
    'pos_communication_settings_runtime_privileges_v1'
  );
  try {
    const m = require(distPath);
    const required = [
      'checkPrivilegesPrerequisites',
      'inspectPrivilegesState',
      'privilegesComplete',
      'runPosCommunicationSettingsRuntimePrivilegesMigration',
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
      'pastikan dist/db/migrations/pos_communication_settings_runtime_privileges_v1.js tersedia (build TypeScript).'
    );
  }
}

// ─── 8. Mode: --check (state machine read-only) ────���───────────────────────────
// runCheck TIDAK memanggil pool.end() atau process.exit().
// State & exitCode dikembalikan sebagai { state, exitCode } melalui return value;
// kegagalan cleanup (client.release) memaksa exitCode non-zero TANPA mengubah state.
// Release klien: satu percobaan per koneksi — jalur sukses di finally (release normal),
// jalur error di catch (release(true) = discard bila ROLLBACK gagal).
// Penutupan pool terpusat di jalur main.
async function runCheck(pool, migration) {
  const client = await pool.connect();
  let txnActive = false;
  let released = false;
  let result = null;
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    txnActive = true;

    // 1) Tabel schema_migrations ada?
    const smRes = await client.query(
      `SELECT c.oid FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = 'schema_migrations'
         AND c.relkind IN ('r','p')`
    );
    if ((smRes.rowCount ?? 0) === 0) {
      console.error('[CHECK] INVALID: tabel public.schema_migrations tidak ditemukan.');
      result = { state: 'INVALID_PARTIAL', exitCode: 1 };
      // Tutup transaksi secara eksplisit SEBELUM release.
      try {
        await client.query('ROLLBACK');
        txnActive = false;
      } catch (rbErr) {
        console.error(
          '[POS COMM PRIVILEGES STAGING] ROLLBACK check gagal: ' +
          String((rbErr && rbErr.message) || rbErr)
        );
        released = true;
        try { client.release(true); } catch (_) {}
      }
      return result;
    }
    console.log('[CHECK] public.schema_migrations: ada.');

    // 2) Prerequisites: role oak_app, tabel, sequence, marker utama DDL.
    const prereq = await migration.checkPrivilegesPrerequisites(client);
    if (!prereq.ok) {
      for (const e of prereq.errors) console.error('[CHECK] Prerequisite: ' + e);
      result = { state: 'INVALID_PARTIAL', exitCode: 1 };
      try {
        await client.query('ROLLBACK');
        txnActive = false;
      } catch (rbErr) {
        console.error(
          '[POS COMM PRIVILEGES STAGING] ROLLBACK check gagal: ' +
          String((rbErr && rbErr.message) || rbErr)
        );
        released = true;
        try { client.release(true); } catch (_) {}
      }
      return result;
    }
    console.log('[CHECK] Prerequisites: LULUS (role, tabel, sequence, marker utama).');

    // 3) State machine marker corrective.
    const state = await migration.inspectPrivilegesState(client);

    if (state.markerExists) {
      if (migration.privilegesComplete(state)) {
        console.log('[CHECK] Marker ' + CORRECTIVE_MARKER + ': ADA + privileges lengkap.');
        result = { state: 'ALREADY_APPLIED', exitCode: 0 };
      } else {
        const missing = [];
        if (!state.hasSelect) missing.push('TABLE:SELECT');
        if (!state.hasInsert) missing.push('TABLE:INSERT');
        if (!state.hasUpdate) missing.push('TABLE:UPDATE');
        if (!state.hasSeqUsage) missing.push('SEQ:USAGE');
        if (!state.hasSeqSelect) missing.push('SEQ:SELECT');
        console.error(
          '[CHECK] MARKER_EXISTS_BUT_PRIVILEGES_INCOMPLETE: marker ada tetapi privilege hilang [' +
          missing.join(', ') + ']. Diagnosis manual diperlukan.'
        );
        result = { state: 'INVALID_PARTIAL', exitCode: 1 };
      }
      // Tutup transaksi secara eksplisit SEBELUM release (ROLLBACK konsisten
      // untuk read-only check — tidak ada mutasi, ROLLBACK = no-op + bersih).
      try {
        await client.query('ROLLBACK');
        txnActive = false;
      } catch (rbErr) {
        console.error(
          '[POS COMM PRIVILEGES STAGING] ROLLBACK check gagal: ' +
          String((rbErr && rbErr.message) || rbErr)
        );
        // ROLLBACK gagal → discard koneksi + paksa non-zero (jangan laporkan sukses).
        result.exitCode = 1;
        released = true;
        try { client.release(true); } catch (_) {}
        return result;
      }
      return result;
    }

    // Marker corrective TIDAK ada + prerequisites ok → READY_TO_APPLY
    result = { state: 'READY_TO_APPLY', exitCode: 0 };
    // Tutup transaksi secara eksplisit SEBELUM release.
    try {
      await client.query('ROLLBACK');
      txnActive = false;
    } catch (rbErr) {
      console.error(
        '[POS COMM PRIVILEGES STAGING] ROLLBACK check gagal: ' +
        String((rbErr && rbErr.message) || rbErr)
      );
      result.exitCode = 1;
      released = true;
      try { client.release(true); } catch (_) {}
      return result;
    }
    return result;
  } catch (err) {
    // ROLLBACK eksplisit. Jika ROLLBACK gagal, koneksi WAJIB di-discard.
    let rollbackFailed = false;
    try {
      await client.query('ROLLBACK');
      txnActive = false;
    } catch (rbErr) {
      rollbackFailed = true;
      console.error(
        '[POS COMM PRIVILEGES STAGING] ROLLBACK check gagal: ' +
        String((rbErr && rbErr.message) || rbErr)
      );
    }
    released = true;
    try {
      client.release(rollbackFailed);
    } catch (relErr) {
      console.error(
        '[POS COMM PRIVILEGES STAGING] client.release gagal: ' +
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
          '[POS COMM PRIVILEGES STAGING] client.release gagal: ' +
          String((relErr && relErr.message) || relErr)
        );
        // Cleanup gagal → paksa non-zero tanpa mengubah state.
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
  const result = await migration.runPosCommunicationSettingsRuntimePrivilegesMigration(pool);
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
      console.log('[POS COMM PRIVILEGES STAGING] --check selesai: ' + state + '.');
    } else {
      console.error('[POS COMM PRIVILEGES STAGING] --check selesai: ' + state + ' (exit 1).');
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
        '[POS COMM PRIVILEGES STAGING] pool.end gagal: ' +
        String((endErr && endErr.message) || endErr)
      );
      pendingExitCode = 1; // kegagalan penutupan koneksi memaksa exit non-zero
    }
    process.exit(pendingExitCode);
  })
  .catch(async (err) => {
    console.error('[POS COMM PRIVILEGES STAGING] GAGAL: ' + ((err && err.message) || err));
    try {
      await pool.end();
    } catch (endErr) {
      console.error(
        '[POS COMM PRIVILEGES STAGING] pool.end gagal: ' +
        String((endErr && endErr.message) || endErr)
      );
    }
    process.exit(1);
  });

#!/usr/bin/env node
/**
 * RUNNER CORRECTIVE RUNTIME PRIVILEGES POS COMMUNICATION SETTINGS v1
 * (marker: pos_communication_settings_runtime_privileges_v1)
 * — CLI eksplisit untuk target DISPOSABLE (oak_minibar_test)
 *
 * Perbaikan: migration DDL utama pos_communication_settings_v1 dijalankan
 * sebagai owner; runtime memakai role oak_app → corrective GRANT minimum
 * (SELECT, INSERT, UPDATE pada tabel; USAGE, SELECT pada sequence).
 *
 * Penggunaan:
 *   MIGRATION_DATABASE_URL=postgres://user:pass@127.0.0.1:15434/oak_minibar_test \
 *   node backend/scripts/run_pos_communication_settings_runtime_privileges_migration.js --apply
 *
 * ATAU --check (read-only, tanpa mutasi):
 *   node backend/scripts/run_pos_communication_settings_runtime_privileges_migration.js --check
 *
 * Keamanan:
 * - Flag WAJIB PERSIS SATU: --apply atau --check. Flag lain/campuran → exit 1.
 * - Tidak membaca .env, DB_*, atau PG* environment variables (tanpa fallback
 *   apa pun; pool dibuat dari field eksplisit hasil parse URL, bukan
 *   connectionString — field yang hilang tidak mengambil fallback apa pun).
 * - Hanya menggunakan MIGRATION_DATABASE_URL (env eksplisit).
 * - Jika MIGRATION_DATABASE_URL tidak ada atau kosong → exit 1.
 * - URL diparse dengan URL API (decode %XX via decodeURIComponent);
 *   wajib postgres/postgresql, host 127.0.0.1, port 15434,
 *   database oak_minibar_test, user minibar_test.
 * - Allowlist target disposable: 127.0.0.1:15434 / oak_minibar_test / minibar_test.
 * - Password wajib; query parameter ditolak.
 * - Tidak mencetak URL lengkap/password — hanya nama database & user.
 * - Menolak nama DB/user/param mengandung staging|production|prod|live.
 * - --check: transaksi READ ONLY, state machine READY_TO_APPLY / ALREADY_APPLIED
 *   / INVALID_PARTIAL; tanpa mutasi apa pun.
 * - --apply: fail-closed; marker corrective hanya ditulis setelah semua
 *   GRANT sukses; tidak mengubah DDL utama pos_communication_settings_v1.
 * - Sebelum mutasi: cocokkan konfigurasi efektif pool (host/port/user/database)
 *   dengan target tervalidasi, lalu probe current_database(), current_user().
 * - Hasil: ok=false / error → exitCode=1.
 * - Pool selalu ditutup sebelum exit (sukses, gagal, atau error tak terduga).
 */

'use strict';

// ─── Validasi argumen: WAJIB PERSIS SATU flag (--apply | --check) ────────────
const argv = process.argv.slice(2);
let mode = null;
if (argv.length === 1 && (argv[0] === '--apply' || argv[0] === '--check')) {
  mode = argv[0] === '--apply' ? 'apply' : 'check';
}

if (!mode) {
  console.error(
    '[POS COMM PRIVILEGES MIGRATION] Argumen tak valid.\n' +
    '  Runner hanya menerima SATU flag: --apply atau --check.\n' +
    'Jalankan: node backend/scripts/run_pos_communication_settings_runtime_privileges_migration.js --apply\n' +
    '  dengan MIGRATION_DATABASE_URL eksplisit.'
  );
  process.exit(1);
}

// ─── Konstanta guard ─────────────────────────────────────────────
const FORBIDDEN = ['staging', 'production', 'prod', 'live'];

// Allowlist target disposable untuk tahap ini
const ALLOW = {
  host: '127.0.0.1',
  port: 15434,
  database: 'oak_minibar_test',
  user: 'minibar_test',
};

// ─── Parse MIGRATION_DATABASE_URL ─────────────────────────────────────────────
const migrationUrl = process.env.MIGRATION_DATABASE_URL;

function rejectMigration(errMsg, extra) {
  if (extra) console.error('[POS COMM PRIVILEGES MIGRATION] ' + extra);
  console.error('[POS COMM PRIVILEGES MIGRATION] ' + errMsg);
  console.error(
    'Jalankan: MIGRATION_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test ' +
    'node backend/scripts/run_pos_communication_settings_runtime_privileges_migration.js --apply'
  );
  process.exit(1);
}

if (!migrationUrl || !migrationUrl.trim()) {
  rejectMigration('MIGRATION_DATABASE_URL tidak di-set atau kosong.');
}

let target; // { host, port, user, database, password }
try {
  const u = new URL(migrationUrl.trim());
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    rejectMigration('Protocol URL wajib postgres:// atau postgresql://.', `Protocol diterima: ${u.protocol}`);
  }
  if (u.hostname !== ALLOW.host) {
    rejectMigration(
      `Host wajib ${ALLOW.host} (allowlist disposable).`,
      `Host diterima: ${u.hostname}`
    );
  }
  if (!u.port || !/^\d+$/.test(u.port)) {
    rejectMigration('Port eksplisit wajib dalam URL.');
  }
  const port = Number(u.port);
  if (port !== ALLOW.port) {
    rejectMigration(
      `Port wajib ${ALLOW.port} (allowlist disposable).`,
      `Port diterima: ${port}`
    );
  }
  // Tolak SEMUA query parameter — sslmode pun tidak diterapkan ke Pool field eksplisit.
  if (u.searchParams.size > 0) {
    const params = [...u.searchParams.keys()].join(', ');
    rejectMigration(
      'Query parameter tidak didukung dalam URL: ' + params +
      ' (hapus semua query parameter dari MIGRATION_DATABASE_URL)'
    );
  }
  const rawUser = u.username;
  const rawDb = u.pathname.replace(/^\//, '');
  const user = rawUser ? decodeURIComponent(rawUser) : '';
  const database = rawDb ? decodeURIComponent(rawDb) : '';
  const password = u.password ? decodeURIComponent(u.password) : '';
  if (!user) rejectMigration('User wajib lengkap dalam URL (tanpa fallback PGUSER/DB_*).');
  if (!password) rejectMigration('Password wajib lengkap dalam URL (tanpa fallback PGPASSWORD/DB_*).');
  // Allowlist database & user eksak
  if (database !== ALLOW.database) {
    rejectMigration(
      `Database wajib ${ALLOW.database} (allowlist disposable).`,
      `Database diterima: ${database}`
    );
  }
  if (user !== ALLOW.user) {
    rejectMigration(
      `User wajib ${ALLOW.user} (allowlist disposable).`,
      `User diterima: ${user}`
    );
  }
  const dbLower = database.toLowerCase();
  const userLower = user.toLowerCase();
  if (FORBIDDEN.some((p) => dbLower.includes(p) || userLower.includes(p))) {
    rejectMigration('Indikator staging/production/live terdeteksi pada database atau user.');
  }
  target = { host: u.hostname, port, user, database, password };
  // Tidak mencetak password/URL — hanya nama database & user.
  console.log(`[POS COMM PRIVILEGES MIGRATION] Mode: ${mode} | Target DB: ${database} (user: ${user}, port: ${port})`);
} catch (e) {
  rejectMigration('URL tidak valid: ' + e.message);
}

// ─── Pool dari field eksplisit — tanpa connectionString, tanpa fallback ───────
const { Pool } = require('pg');

const pool = new Pool({
  host: target.host,
  port: target.port,
  user: target.user,
  database: target.database,
  password: target.password,
});

async function exitWith(code) {
  let finalCode = code;

  try {
    await pool.end();
  } catch (endErr) {
    console.error(
      '[POS COMM PRIVILEGES MIGRATION] pool.end gagal: ' +
      String((endErr && endErr.message) || endErr)
    );
    finalCode = 1;
  }

  process.exit(finalCode);
}

// ─── Import modul corrective dari dist (bukan app/index) ─────────────────────
function loadPrivilegesModule() {
  let migration;
  try {
    migration = require('../dist/db/migrations/pos_communication_settings_runtime_privileges_v1');
  } catch (err) {
    console.error(
      '[POS COMM PRIVILEGES MIGRATION] Gagal import modul corrective dari dist.\n' +
      '  ' + err.message + '\n' +
      'Pastikan backend sudah di-build: cd backend && npm run build'
    );
    return null;
  }

  // Guard: pastikan export function tersedia
  const required = [
    'checkPrivilegesPrerequisites',
    'inspectPrivilegesState',
    'privilegesComplete',
    'runPosCommunicationSettingsRuntimePrivilegesMigration',
  ];
  for (const fn of required) {
    if (typeof migration[fn] !== 'function') {
      console.error(
        `[POS COMM PRIVILEGES MIGRATION] Export ${fn} tidak ditemukan. ` +
        'Jalankan build ulang (tsc).'
      );
      return null;
    }
  }
  return migration;
}

// ─── Mode: --check (state machine read-only) ─────────────────────────────────
// READY_TO_APPLY   : prerequisites ok (role/tabel/sequence/marker utama),
//                    marker corrective TIDAK ada → exit 0
// ALREADY_APPLIED  : marker corrective ada + privileges lengkap → exit 0
// INVALID_PARTIAL  : marker corrective ada TAPI privileges hilang /
//                    prerequisites gagal → exit 1
async function runCheck(migration) {
  const client = await pool.connect();
  let txnActive = false;
  let released = false;
  let result = null;

  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    txnActive = true;

    // 0) Tabel schema_migrations ada?
    const smR = await client.query(
      `SELECT c.oid FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = 'schema_migrations'
         AND c.relkind IN ('r','p')`
    );
    if ((smR.rowCount ?? 0) === 0) {
      console.error('[CHECK] TIDAK SIAP: tabel public.schema_migrations tidak ditemukan.');
      result = { state: 'INVALID_PARTIAL', exitCode: 1 };
      // Tutup transaksi secara eksplisit SEBELUM release.
      try {
        await client.query('ROLLBACK');
        txnActive = false;
      } catch (rbErr) {
        console.error('[POS COMM PRIVILEGES MIGRATION] ROLLBACK check gagal: ' + String((rbErr && rbErr.message) || rbErr));
        released = true;
        try { client.release(true); } catch (_) {}
      }
      return result;
    }

    // 1) Prerequisites (role oak_app, tabel target, sequence, marker utama)
    const prereq = await migration.checkPrivilegesPrerequisites(client);
    if (!prereq.ok) {
      for (const e of prereq.errors) console.error('[CHECK] Prerequisite: ' + e);
      result = { state: 'INVALID_PARTIAL', exitCode: 1 };
      try {
        await client.query('ROLLBACK');
        txnActive = false;
      } catch (rbErr) {
        console.error('[POS COMM PRIVILEGES MIGRATION] ROLLBACK check gagal: ' + String((rbErr && rbErr.message) || rbErr));
        released = true;
        try { client.release(true); } catch (_) {}
      }
      return result;
    }
    console.log('[CHECK] Prerequisites: LULUS.');

    // 2) State machine
    const state = await migration.inspectPrivilegesState(client);

    if (state.markerExists) {
      if (migration.privilegesComplete(state)) {
        console.log('[CHECK] Marker corrective: ADA + privileges lengkap.');
        result = { state: 'ALREADY_APPLIED', exitCode: 0 };
      } else {
        const missing = [];
        if (!state.hasSelect) missing.push('TABLE:SELECT');
        if (!state.hasInsert) missing.push('TABLE:INSERT');
        if (!state.hasUpdate) missing.push('TABLE:UPDATE');
        if (!state.hasSeqUsage) missing.push('SEQ:USAGE');
        if (!state.hasSeqSelect) missing.push('SEQ:SELECT');
        console.error('[CHECK] MARKER_TAPI_PRIVILEGE_HILANG: [' + missing.join(', ') + ']. Diagnosis manual diperlukan.');
        result = { state: 'INVALID_PARTIAL', exitCode: 1 };
      }
      // Tutup transaksi secara eksplisit SEBELUM release.
      try {
        await client.query('ROLLBACK');
        txnActive = false;
      } catch (rbErr) {
        console.error('[POS COMM PRIVILEGES MIGRATION] ROLLBACK check gagal: ' + String((rbErr && rbErr.message) || rbErr));
        result.exitCode = 1;
        released = true;
        try { client.release(true); } catch (_) {}
      }
      return result;
    }

    // marker corrective TIDAK ada → READY_TO_APPLY
    result = { state: 'READY_TO_APPLY', exitCode: 0 };
    try {
      await client.query('ROLLBACK');
      txnActive = false;
    } catch (rbErr) {
      console.error('[POS COMM PRIVILEGES MIGRATION] ROLLBACK check gagal: ' + String((rbErr && rbErr.message) || rbErr));
      result.exitCode = 1;
      released = true;
      try { client.release(true); } catch (_) {}
    }
    return result;
  } catch (err) {
    // Jalur exception: ROLLBACK eksplisit; jika ROLLBACK gagal, discard koneksi.
    let rollbackFailed = false;
    try {
      await client.query('ROLLBACK');
      txnActive = false;
    } catch (rbErr) {
      rollbackFailed = true;
      console.error('[POS COMM PRIVILEGES MIGRATION] ROLLBACK check gagal: ' + String((rbErr && rbErr.message) || rbErr));
    }
    released = true;
    try {
      client.release(rollbackFailed);
    } catch (relErr) {
      console.error('[POS COMM PRIVILEGES MIGRATION] client.release gagal: ' + String((relErr && relErr.message) || relErr));
    }
    throw err;
  } finally {
    // Jalur SUCCESS (return di atas sudah melakukan release): tidak ada
    // double release. Jalur exception sudah melakukan satu percobaan release
    // di catch; 'released' guard memastikan release hanya dicoba sekali.
    if (!released) {
      released = true;
      try {
        client.release();
      } catch (relErr) {
        console.error('[POS COMM PRIVILEGES MIGRATION] client.release gagal: ' + String((relErr && relErr.message) || relErr));
        if (result) result.exitCode = 1;
      }
    }
    void txnActive;
  }
}

// ─── Main ────────────────────────────────��────────────────────────────────────
async function main() {
  const migration = loadPrivilegesModule();
  if (!migration) {
    await exitWith(1);
    return;
  }

  // 0) Cocokkan KONFIGURASI POOL (pool.options) dengan target tervalidasi
  //    SEBELUM probe & mutasi apa pun.
  const optMismatches = [
    ['host', String(pool.options.host ?? ''), target.host],
    ['port', String(pool.options.port ?? ''), String(target.port)],
    ['user', String(pool.options.user ?? ''), target.user],
    ['database', String(pool.options.database ?? ''), target.database],
  ].filter(([, a, b]) => a !== b);
  if (optMismatches.length) {
    for (const [field, got, want] of optMismatches) {
      console.error(`[POS COMM PRIVILEGES MIGRATION] DITOLAK: pool.options.${field}="${got}" != target "${want}".`);
    }
    await exitWith(1);
    return;
  }

  // 1) Probe identitas server
  try {
    const cfg = await pool.query(
      `SELECT current_database() AS db, current_user AS usr`
    );
    const row = cfg.rows[0] || {};
    if (row.db !== target.database) {
      console.error(`[POS COMM PRIVILEGES MIGRATION] DITOLAK: current_database "${row.db}" != target "${target.database}".`);
      await exitWith(1);
      return;
    }
    if (row.usr !== target.user) {
      console.error(`[POS COMM PRIVILEGES MIGRATION] DITOLAK: current_user "${row.usr}" != target "${target.user}".`);
      await exitWith(1);
      return;
    }
    const dbLower = String(row.db ?? '').toLowerCase();
    if (FORBIDDEN.some((p) => dbLower.includes(p))) {
      console.error('[POS COMM PRIVILEGES MIGRATION] DITOLAK: database aktual terindikasi staging/prod/live.');
      await exitWith(1);
      return;
    }
    console.log(
      `[POS COMM PRIVILEGES MIGRATION] Koneksi terverifikasi: db=${row.db} user=${row.usr} ` +
      `(host: ${target.host}:${target.port})`
    );
  } catch (err) {
    console.error('[POS COMM PRIVILEGES MIGRATION] Koneksi DB gagal: ' + err.message);
    await exitWith(1);
    return;
  }

  // 2) Jalankan sesuai mode
  if (mode === 'check') {
    let checkResult;
    try {
      checkResult = await runCheck(migration);
    } catch (err) {
      console.error('[POS COMM PRIVILEGES MIGRATION] --check gagal: ' + ((err && err.message) || err));
      await exitWith(1);
      return;
    }
    if (checkResult.exitCode === 0) {
      console.log('[POS COMM PRIVILEGES MIGRATION] --check selesai: ' + checkResult.state + '.');
      await exitWith(0);
    } else {
      console.error('[POS COMM PRIVILEGES MIGRATION] --check selesai: ' + checkResult.state + ' (exit 1).');
      await exitWith(1);
    }
    return;
  }

  // mode === 'apply'
  const result = await migration.runPosCommunicationSettingsRuntimePrivilegesMigration(pool);

  if (result.ok) {
    console.log(
      '[POS COMM PRIVILEGES MIGRATION] Berhasil — status: ' + result.status +
      (result.applied ? ' (GRANT + marker baru diterapkan)' : ' (marker sudah ada, privileges sesuai)')
    );
    await exitWith(0);
  } else {
    console.error('[POS COMM PRIVILEGES MIGRATION] GAGAL — status: ' + result.status);
    for (const e of result.errors) {
      console.error('  ' + e);
    }
    await exitWith(1);
  }
}

main().catch(async (err) => {
  console.error('[POS COMM PRIVILEGES MIGRATION] Error tak terduga: ' + ((err && err.message) || err));
  await exitWith(1);
});

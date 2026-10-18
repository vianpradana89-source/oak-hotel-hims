#!/usr/bin/env node
/**
 * RUNNER CORRECTIVE RUNTIME PRIVILEGES POS ORDER EDIT REQUESTS v1
 * (marker: pos_order_edit_requests_runtime_privileges_v1)
 * — CLI eksplisit untuk target DISPOSABLE (oak_minibar_test)
 *
 * Penggunaan:
 *   MIGRATION_DATABASE_URL=postgres://user:pass@127.0.0.1:15434/oak_minibar_test \
 *   node backend/scripts/run_pos_order_edit_requests_runtime_privileges_migration.js --apply
 *
 * ATAU --check (read-only, tanpa mutasi):
 *   node backend/scripts/run_pos_order_edit_requests_runtime_privileges_migration.js --check
 *
 * Keamanan:
 * - Flag WAJIB PERSIS SATU: --apply atau --check. Flag lain/campuran → exit 1.
 * - Tidak membaca .env, DB_*, atau PG* environment variables.
 * - Hanya menggunakan MIGRATION_DATABASE_URL (env eksplisit).
 * - Allowlist target disposable: 127.0.0.1:15434 / oak_minibar_test / minibar_test.
 * - Menolak nama DB/user/param mengandung staging|production|prod|live.
 * - --check: transaksi READ ONLY; tanpa mutasi apa pun.
 * - --apply: fail-closed; transactional + advisory lock.
 */

'use strict';

const path = require('path');
const { Pool } = require('pg');

// ─── Validasi argumen: WAJIB PERSIS SATU flag (--apply | --check) ────────────
const argv = process.argv.slice(2);
let mode = null;
if (argv.length === 1 && (argv[0] === '--apply' || argv[0] === '--check')) {
  mode = argv[0] === '--apply' ? 'apply' : 'check';
}

if (!mode) {
  console.error(
    '[POS EDIT PRIVILEGES MIGRATION] Argumen tak valid.\n' +
    '  Runner hanya menerima SATU flag: --apply atau --check.\n' +
    'Jalankan: node backend/scripts/run_pos_order_edit_requests_runtime_privileges_migration.js --apply\n' +
    '  dengan MIGRATION_DATABASE_URL eksplisit.'
  );
  process.exit(1);
}

// ─── Konstanta guard ─────────────────────────────────────────────
const FORBIDDEN = ['staging', 'production', 'prod', 'live'];

const ALLOW = {
  host: '127.0.0.1',
  port: 15434,
  database: 'oak_minibar_test',
  user: 'minibar_test',
};

const CORRECTIVE_MARKER = 'pos_order_edit_requests_runtime_privileges_v1';
const PRIMARY_MARKER    = 'pos_order_update_v1';

// ─── Parse MIGRATION_DATABASE_URL ─────────────────────────────────────────────
const migrationUrl = process.env.MIGRATION_DATABASE_URL;

function rejectMigration(errMsg, extra) {
  if (extra) console.error('[POS EDIT PRIVILEGES MIGRATION] ' + extra);
  console.error('[POS EDIT PRIVILEGES MIGRATION] ' + errMsg);
  console.error(
    'Jalankan: MIGRATION_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test ' +
    'node backend/scripts/run_pos_order_edit_requests_runtime_privileges_migration.js --apply'
  );
  process.exit(1);
}

if (!migrationUrl || !migrationUrl.trim()) {
  rejectMigration('MIGRATION_DATABASE_URL tidak di-set atau kosong.');
}

let target;
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
  const portNum = u.port ? Number(u.port) : 5432;
  if (portNum !== ALLOW.port) {
    rejectMigration(
      `Port wajib ${ALLOW.port} (allowlist disposable).`,
      `Port diterima: ${portNum}`
    );
  }
  const dbName = u.pathname.replace(/^\//, '');
  if (dbName !== ALLOW.database) {
    rejectMigration(
      `Database wajib ${ALLOW.database} (allowlist disposable).`,
      `Database diterima: ${dbName}`
    );
  }
  const userName = decodeURIComponent(u.username || '');
  if (userName !== ALLOW.user) {
    rejectMigration(
      `User wajib ${ALLOW.user} (allowlist disposable).`,
      `User diterima: ${userName}`
    );
  }
  const password = decodeURIComponent(u.password || '');
  if (!password) {
    rejectMigration('Password wajib disertakan dalam MIGRATION_DATABASE_URL.');
  }

  for (const part of [u.hostname, dbName, userName]) {
    for (const bad of FORBIDDEN) {
      if (part.toLowerCase().includes(bad)) {
        rejectMigration(
          `URL mengandung kata terlarang "${bad}" — eksekusi ditolak.`,
          `Bagian: ${part}`
        );
      }
    }
  }

  target = {
    host: u.hostname,
    port: portNum,
    user: userName,
    password,
    database: dbName,
  };
} catch (err) {
  rejectMigration(`Gagal mem-parse MIGRATION_DATABASE_URL: ${err.message}`);
}

const pool = new Pool({
  host: target.host,
  port: target.port,
  user: target.user,
  password: target.password,
  database: target.database,
});

function verifyPoolOptions() {
  const got = pool.options;
  if (
    got.host !== target.host ||
    got.port !== target.port ||
    got.user !== target.user ||
    got.database !== target.database
  ) {
    throw new Error('Konfigurasi internal Pool tidak cocok dengan target tervalidasi.');
  }
}

async function verifyIdentity() {
  const cfg = await pool.query(
    'SELECT current_database() AS db, current_user AS usr, ' +
    'inet_server_addr() AS srv_host, inet_server_port() AS srv_port'
  );
  const row = cfg.rows[0] || {};
  if (row.db !== target.database) {
    throw new Error(`current_database() = "${row.db}" != target "${target.database}".`);
  }
  if (row.usr !== target.user) {
    throw new Error(`current_user() = "${row.usr}" != target "${target.user}".`);
  }
  console.log(
    `[POS EDIT PRIVILEGES MIGRATION] Identitas terverifikasi: db=${row.db} user=${row.usr}`
  );
}

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
        throw new Error(`Export ${fn} tidak ditemukan. Jalankan build ulang (tsc).`);
      }
    }
    return m;
  } catch (err) {
    throw new Error(
      `Gagal import modul: ${err.message} — ` +
      'pastikan dist/db/migrations/pos_order_edit_requests_runtime_privileges_v1.js tersedia.'
    );
  }
}

async function runCheck(pool, migration) {
  const client = await pool.connect();
  let txnActive = false;
  let released = false;
  let result = null;
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    txnActive = true;

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
      } catch (_) {
        released = true;
        try { client.release(true); } catch (_) {}
      }
      return result;
    }

    console.log('[CHECK] ─── Status Hak Akses Role oak_app ───');
    console.log('[CHECK] pos_order_edit_requests (SELECT) : ' + (state.hasSelect ? 'GRANTED' : 'MISSING'));
    console.log('[CHECK] pos_order_edit_requests (INSERT) : ' + (state.hasInsert ? 'GRANTED' : 'MISSING'));
    console.log('[CHECK] sequence id (USAGE)              : ' + (state.hasSeqUsage ? 'GRANTED' : 'MISSING'));
    console.log('[CHECK] sequence id (SELECT)             : ' + (state.hasSeqSelect ? 'GRANTED' : 'MISSING'));
    console.log('[CHECK] pos_orders (SELECT)              : ' + (state.posOrdersHasSelect ? 'GRANTED' : 'MISSING'));
    console.log('[CHECK] pos_orders (UPDATE)              : ' + (state.posOrdersHasUpdate ? 'GRANTED' : 'MISSING'));

    console.log('[CHECK] ─── Evaluasi State Marker Corrective ───');
    console.log('[CHECK] Marker ' + CORRECTIVE_MARKER + ' : ' + (state.markerExists ? 'ADA' : 'BELUM ADA'));

    if (state.markerExists) {
      if (migration.privilegesComplete(state)) {
        console.log('[CHECK] Status: ALREADY_APPLIED (Marker ada dan semua hak akses runtime lengkap).');
        result = { state: 'ALREADY_APPLIED', exitCode: 0 };
      } else {
        result = { state: 'INVALID_PARTIAL', exitCode: 1 };
      }
    } else {
      console.log('[CHECK] Status: READY_TO_APPLY (Prerequisite lengkap, siap dieksekusi dengan --apply).');
      result = { state: 'READY_TO_APPLY', exitCode: 0 };
    }

    try {
      await client.query('ROLLBACK');
      txnActive = false;
    } catch (_) {
      result.exitCode = 1;
      released = true;
      try { client.release(true); } catch (_) {}
      return result;
    }

    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
      txnActive = false;
    } catch (_) {}
    released = true;
    try { client.release(true); } catch (_) {}
    throw err;
  } finally {
    if (!released) {
      released = true;
      try { client.release(); } catch (_) {
        if (result !== null) result.exitCode = 1;
      }
    }
  }
}

async function runApply(pool, migration) {
  const result = await migration.runPosOrderEditRequestsRuntimePrivilegesMigration(pool);
  if (result.ok) {
    console.log(
      `[APPLY] Berhasil - status: ${result.status}` +
      (result.applied ? ' (GRANT + marker corrective baru diterapkan)' : ' (marker sudah ada, privileges sesuai)')
    );
  } else {
    console.error(`[APPLY] GAGAL - status: ${result.status}`);
    for (const e of result.errors) {
      console.error('  ' + e);
    }
    throw new Error(`Corrective migration gagal: ${result.errors.join('; ')}`);
  }
}

async function run() {
  verifyPoolOptions();
  const migration = loadPrivilegesModule();
  await verifyIdentity();

  if (mode === 'check') {
    const { state, exitCode } = await runCheck(pool, migration);
    pendingExitCode = exitCode;
    console.log(`[POS EDIT PRIVILEGES MIGRATION] --check selesai: ${state} (exit ${exitCode}).`);
    return;
  }

  await runApply(pool, migration);
}

let pendingExitCode = 0;

run()
  .then(async () => {
    try { await pool.end(); } catch (_) { pendingExitCode = 1; }
    process.exit(pendingExitCode);
  })
  .catch(async (err) => {
    console.error('[POS EDIT PRIVILEGES MIGRATION] GAGAL: ' + (err.message || err));
    try { await pool.end(); } catch (_) {}
    process.exit(1);
  });

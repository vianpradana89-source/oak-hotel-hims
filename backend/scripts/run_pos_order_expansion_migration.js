#!/usr/bin/env node
/**
 * RUNNER MIGRASI POS ORDER EXPANSION v1 — CLI eksplisit
 * (Ekspansi kolom order + settlement + payment config multi-metode)
 *
 * Penggunaan:
 *   MIGRATION_DATABASE_URL=postgres://user:pass@127.0.0.1:15434/oak_minibar_test \
 *   node backend/scripts/run_pos_order_expansion_migration.js --apply
 *
 * ATAU (Windows PowerShell):
 *   $env:MIGRATION_DATABASE_URL='postgres://user:pass@127.0.0.1:15434/oak_minibar_test'
 *   node backend/scripts/run_pos_order_expansion_migration.js --apply
 *
 * Keamanan:
 * - Flag --apply WAJIB. Tanpa --apply, atau dengan flag lain, → exit 1.
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
 * - Sebelum mutasi: cocokkan konfigurasi efektif pool (host/port/user/database)
 *   dengan target tervalidasi, lalu probe current_database(), current_user().
 * - Hasil migration.ok=false atau error → exitCode=1.
 * - Pool selalu ditutup sebelum exit (sukses, gagal, atau error tak terduga).
 */

'use strict';

// ─── Validasi argumen: wajib tepat --apply ─────────────────────────────────
const argv = process.argv.slice(2);
if (argv.length !== 1 || argv[0] !== '--apply') {
  console.error(
    '[POS ORDER EXPANSION MIGRATION] Argumen tak valid.\n' +
    '  Runner hanya menerima flag tunggal --apply.\n' +
    'Jalankan: node backend/scripts/run_pos_order_expansion_migration.js --apply\n' +
    '  dengan MIGRATION_DATABASE_URL eksplisit.'
  );
  process.exit(1);
}

// ─── Konstanta guard ─────────────────────────────────────���──────────────────
const FORBIDDEN = ['staging', 'production', 'prod', 'live'];

// Allowlist target disposable untuk tahap ini
const ALLOW = {
  host: '127.0.0.1',
  port: 15434,
  database: 'oak_minibar_test',
  user: 'minibar_test',
};

// ─── Parse MIGRATION_DATABASE_URL ───────────────────────────────────────────
const migrationUrl = process.env.MIGRATION_DATABASE_URL;

function rejectMigration(errMsg, extra) {
  if (extra) console.error('[POS ORDER EXPANSION MIGRATION] ' + extra);
  console.error('[POS ORDER EXPANSION MIGRATION] ' + errMsg);
  console.error(
    'Jalankan: MIGRATION_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test ' +
    'node backend/scripts/run_pos_order_expansion_migration.js --apply'
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
  console.log(`[POS ORDER EXPANSION MIGRATION] Target DB: ${database} (user: ${user}, port: ${port})`);
} catch (e) {
  rejectMigration('URL tidak valid: ' + e.message);
}

// ─── Pool dari field eksplisit — tanpa connectionString, tanpa fallback ────────
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
      '[POS ORDER EXPANSION MIGRATION] pool.end gagal: ' +
      String((endErr && endErr.message) || endErr)
    );
    finalCode = 1;
  }

  process.exit(finalCode);
}

// ─── Import modul migration dari dist (bukan app/index) ─────────────────────
async function main() {
  let migration;
  try {
    migration = require('../dist/db/migrations/pos_order_expansion_v1');
  } catch (err) {
    console.error(
      '[POS ORDER EXPANSION MIGRATION] Gagal import modul migration dari dist.\n' +
      '  ' + err.message + '\n' +
      'Pastikan backend sudah di-build: cd backend && npm run build'
    );
    await exitWith(1);
    return;
  }

  // Guard: pastikan export function tersedia
  if (typeof migration.runPosOrderExpansionMigration !== 'function') {
    console.error(
      '[POS ORDER EXPANSION MIGRATION] Export runPosOrderExpansionMigration tidak ditemukan. ' +
      'Jalankan build ulang (tsc).'
    );
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
      console.error(`[POS ORDER EXPANSION MIGRATION] DITOLAK: pool.options.${field}="${got}" != target "${want}".`);
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
      console.error(`[POS ORDER EXPANSION MIGRATION] DITOLAK: current_database "${row.db}" != target "${target.database}".`);
      await exitWith(1);
      return;
    }
    if (row.usr !== target.user) {
      console.error(`[POS ORDER EXPANSION MIGRATION] DITOLAK: current_user "${row.usr}" != target "${target.user}".`);
      await exitWith(1);
      return;
    }
    const dbLower = String(row.db ?? '').toLowerCase();
    if (FORBIDDEN.some((p) => dbLower.includes(p))) {
      console.error('[POS ORDER EXPANSION MIGRATION] DITOLAK: database aktual terindikasi staging/prod/live.');
      await exitWith(1);
      return;
    }
    console.log(
      `[POS ORDER EXPANSION MIGRATION] Koneksi terverifikasi: db=${row.db} user=${row.usr} ` +
      `(host: ${target.host}:${target.port})`
    );
  } catch (err) {
    console.error('[POS ORDER EXPANSION MIGRATION] Koneksi DB gagal: ' + err.message);
    await exitWith(1);
    return;
  }

  // 2) Jalankan migration
  const result = await migration.runPosOrderExpansionMigration(pool);

  if (result.ok) {
    console.log(
      '[POS ORDER EXPANSION MIGRATION] Berhasil — status: ' + result.status +
      (result.applied ? ' (DDL baru diterapkan)' : ' (marker sudah ada, skema sesuai)')
    );
    await exitWith(0);
  } else {
    console.error('[POS ORDER EXPANSION MIGRATION] GAGAL — status: ' + result.status);
    for (const e of result.errors) {
      console.error('  ' + e);
    }
    await exitWith(1);
  }
}

main().catch(async (err) => {
  console.error('[POS ORDER EXPANSION MIGRATION] Error tak terduga: ' + ((err && err.message) || err));
  await exitWith(1);
});

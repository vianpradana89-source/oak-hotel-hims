#!/usr/bin/env node
/**
 * RUNNER MIGRASI POS PAYMENT SETTLEMENT — CLI eksplisit (tahap: fondasi tabel CASH)
 *
 * Penggunaan:
 *   MIGRATION_DATABASE_URL=postgres://user:pass@127.0.0.1:15434/oak_minibar_test \
 *   node backend/scripts/run_pos_payment_settlement_migration.js --apply
 *
 * ATAU (Windows PowerShell):
 *   $env:MIGRATION_DATABASE_URL='postgres://user:pass@127.0.0.1:15434/oak_minibar_test'
 *   node backend/scripts/run_pos_payment_settlement_migration.js --apply
 *
 * Keamanan:
 * - Flag --apply WAJIB. Tanpa --apply, atau dengan flag lain, → exit 1.
 * - Tidak membaca .env, DB_*, atau PG* environment variables (tanpa fallback
 *   apa pun; pool dibuat dari field eksplisit hasil parse URL, bukan
 *   connectionString — field yang hilang tidak mengambil fallback apa pun).
 * - Hanya menggunakan MIGRATION_DATABASE_URL (env eksplisit).
 * - Jika MIGRATION_DATABASE_URL tidak ada atau kosong → exit 1.
 * - URL diparse dengan URL API (decode %XX via decodeURIComponent);
 *   wajib postgres/postgresql, host localhost/127.0.0.1, port eksplisit,
 *   user & password lengkap, database berakhiran '_test'.
 * - Allowlist target disposable: port 15434, database oak_minibar_test,
 *   user minibar_test. Target di luar allowlist ditolak.
 * - Tidak mencetak URL lengkap/password — hanya nama database & user.
 * - Menolak nama DB/user/param mengandung staging|production|prod|live.
 * - Sebelum mutasi: cocokkan konfigurasi efektif pool (host/port/user/database)
 *   dengan target tervalidasi, lalu probe current_database(), current_user().
 * - Pool selalu ditutup sebelum exit (sukses, gagal, atau error tak terduga).
 */

'use strict';

// ─── Validasi argumen: wajib tepat --apply ─────────────────────────────────
const argv = process.argv.slice(2);
if (argv.length !== 1 || argv[0] !== '--apply') {
  console.error(
    '[POS PAYMENT SETTLEMENT MIGRATION] Argumen tak valid.\n' +
    '  Runner hanya menerima flag tunggal --apply.\n' +
    'Jalankan: node backend/scripts/run_pos_payment_settlement_migration.js --apply\n' +
    '  dengan MIGRATION_DATABASE_URL eksplisit.'
  );
  process.exit(1);
}

// ─── Konstanta guard ────────────────────────────────────────────────────────
const FORBIDDEN = ['staging', 'production', 'prod', 'live'];

// Allowlist target disposable untuk tahap ini
const ALLOW = {
  hosts: ['localhost', '127.0.0.1'],
  port: 15434,
  database: 'oak_minibar_test',
  user: 'minibar_test',
};

// ─── Parse MIGRATION_DATABASE_URL ───────────────────────────────────────────
const migrationUrl = process.env.MIGRATION_DATABASE_URL;

function rejectMigration(errMsg, extra) {
  if (extra) console.error('[POS PAYMENT SETTLEMENT MIGRATION] ' + extra);
  console.error('[POS PAYMENT SETTLEMENT MIGRATION] ' + errMsg);
  console.error(
    'Jalankan: MIGRATION_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test ' +
    'node backend/scripts/run_pos_payment_settlement_migration.js --apply'
  );
  process.exit(1);
}

if (!migrationUrl || !migrationUrl.trim()) {
  rejectMigration('MIGRATION_DATABASE_URL tidak di-set atau kosong.');
}

let target; // host, port, user, database, password
try {
  const u = new URL(migrationUrl.trim());
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    rejectMigration('Protocol URL wajib postgres:// atau postgresql://.', `Protocol diterima: ${u.protocol}`);
  }
  if (!ALLOW.hosts.includes(u.hostname)) {
    rejectMigration(
      `Host wajib ${ALLOW.hosts.join('/')} (allowlist disposable).`,
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
  // Tidak mencetak password/URL — hanya database & user.
  console.log(`[POS PAYMENT SETTLEMENT MIGRATION] Target DB: ${database} (user: ${user})`);
} catch (e) {
  rejectMigration('URL tidak valid: ' + e.message);
}

// ─── Pool dari field eksplisit — tanpa connectionString, tanpa fallback ────────
// host/port/user/database/password diberikan eksplisit; field lain sengaja
// tidak diisi sehingga tidak ada jalan kembali ke PG*/DB*/.env.
const { Pool } = require('pg');

const pool = new Pool({
  host: target.host,
  port: target.port,
  user: target.user,
  database: target.database,
  password: target.password,
});

/** Tutup pool JAUH sebelum exit di semua jalur. */
async function exitWith(code) {
  await pool.end().catch(() => {});
  process.exit(code);
}

// ─── Import modul migration dari dist (bukan app/index) ─────────────────────
async function main() {
  let migration;
  try {
    migration = require('../dist/db/migrations/pos_payment_settlement_v1');
  } catch (err) {
    console.error(
      '[POS PAYMENT SETTLEMENT MIGRATION] Gagal import modul migration dari dist.\n' +
      '  ' + err.message + '\n' +
      'Pastikan backend sudah di-build: cd backend && npm run build'
    );
    await exitWith(1);
  }

  // 0) Cocokkan KONFIGURASI POOL (pool.options) dengan target tervalidasi
  //    SEBELUM probe & mutasi apa pun: host/port/user/database harus PERSIS
  //    (perbandingan eksak, tanpa normalisasi kapitalisasi).
  const optMismatches = [
    ['host', String(pool.options.host ?? ''), target.host],
    ['port', String(pool.options.port ?? ''), String(target.port)],
    ['user', String(pool.options.user ?? ''), target.user],
    ['database', String(pool.options.database ?? ''), target.database],
  ].filter(([, a, b]) => a !== b);
  if (optMismatches.length) {
    for (const [field, got, want] of optMismatches) {
      console.error(`[POS PAYMENT SETTLEMENT MIGRATION] DITOLAK: pool.options.${field}="${got}" != target "${want}".`);
    }
    await exitWith(1);
  }

  // 1) Cocokkan KONFIGURASI EFEKTIF pool dengan target tervalidasi,
  //    lalu probe identitas server. Perbandingan PERSIS (tanpa toLowerCase).
  //    toLowerCase hanya untuk deteksi kata FORBIDDEN, bukan equality identitas.
  try {
    const cfg = await pool.query(
      `SELECT current_database() AS db,
              current_user AS usr`
    );
    const row = cfg.rows[0] || {};
    if (row.db !== target.database) {
      console.error(`[POS PAYMENT SETTLEMENT MIGRATION] DITOLAK: current_database "${row.db}" != target "${target.database}".`);
      await exitWith(1);
    }
    if (row.usr !== target.user) {
      console.error(`[POS PAYMENT SETTLEMENT MIGRATION] DITOLAK: current_user "${row.usr}" != target "${target.user}".`);
      await exitWith(1);
    }
    const dbLower = String(row.db ?? '').toLowerCase();
    if (!/^[a-z0-9_]+_test$/.test(dbLower)) {
      console.error(`[POS PAYMENT SETTLEMENT MIGRATION] DITOLAK: database aktual "${row.db}" bukan *_test.`);
      await exitWith(1);
    }
    if (FORBIDDEN.some((p) => dbLower.includes(p))) {
      console.error('[POS PAYMENT SETTLEMENT MIGRATION] DITOLAK: database aktual terindikasi staging/prod/live.');
      await exitWith(1);
    }
    console.log(
      `[POS PAYMENT SETTLEMENT MIGRATION] Koneksi terverifikasi: db=${row.db} user=${row.usr} ` +
      `(mapping URL: ${target.host}:${target.port})`
    );
  } catch (err) {
    console.error('[POS PAYMENT SETTLEMENT MIGRATION] Koneksi DB gagal: ' + err.message);
    await exitWith(1);
  }

  // 2) Jalankan migration
  const result = await migration.runPosPaymentSettlementMigration(pool);

  if (result.ok) {
    console.log(
      '[POS PAYMENT SETTLEMENT MIGRATION] Berhasil — status: ' + result.status +
      (result.applied ? ' (DDL baru diterapkan)' : ' (marker sudah ada, skema sesuai)')
    );
    await exitWith(0);
  } else {
    console.error('[POS PAYMENT SETTLEMENT MIGRATION] GAGAL — status: ' + result.status);
    for (const e of result.errors) {
      console.error('  ' + e);
    }
    await exitWith(1);
  }
}

main().catch(async (err) => {
  console.error('[POS PAYMENT SETTLEMENT MIGRATION] Error tak terduga: ' + ((err && err.message) || err));
  await exitWith(1);
});

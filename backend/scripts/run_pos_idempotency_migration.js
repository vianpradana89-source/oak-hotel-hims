#!/usr/bin/env node
/**
 * RUNNER MIGRASI POS IDEMPOTENCY — CLI eksplisit
 *
 * Penggunaan:
 *   MIGRATION_DATABASE_URL=postgres://user:pass@host:15434/oak_minibar_test \
 *   node backend/scripts/run_pos_idempotency_migration.js
 *
 * ATAU (Windows PowerShell):
 *   $env:MIGRATION_DATABASE_URL='postgres://user:pass@localhost:15434/oak_minibar_test'
 *   node backend/scripts/run_pos_idempotency_migration.js
 *
 * Keamanan:
 * - Tidak membaca .env, DB_*, atau PG* environment variables (tanpa fallback
 *   apa pun; pool dibuat dari field eksplisit hasil parse URL, bukan
 *   connectionString — field yang hilang tidak mengambil fallback apa pun).
 * - Tidak menerima URL/password sebagai argument command line.
 * - Hanya menggunakan MIGRATION_DATABASE_URL (env eksplisit).
 * - Jika MIGRATION_DATABASE_URL tidak ada atau kosong → exit 1.
 * - URL diparse dengan URL API (decode %XX via decodeURIComponent);
 *   wajib postgres/postgresql, host localhost/127.0.0.1, port eksplisit,
 *   user & password lengkap, database berakhiran '_test'.
 * - Tidak mencetak URL lengkap/password — hanya nama database & user.
 * - Menolak nama DB/database user/param mengandung staging|production|prod|live.
 * - Sebelum mutasi: cocokkan konfigurasi efektif pool (host/port/user/database)
 *   dengan target tervalidasi, lalu probe current_database(), current_user().
 * - Pool selalu ditutup sebelum exit (sukses, gagal, atau error tak terduga).
 */

'use strict';

const { Pool } = require('pg');

// ─── Konstanta guard (top-level: akses oleh validasi URL & main()) ────────────
const FORBIDDEN = ['staging', 'production', 'prod', 'live'];

// ─── Validasi & parse MIGRATION_DATABASE_URL ──────────────────────────────────
const migrationUrl = process.env.MIGRATION_DATABASE_URL;

function rejectMigration(errMsg, extra) {
  if (extra) console.error('[POS IDEMPOTENCY MIGRATION] ' + extra);
  console.error('[POS IDEMPOTENCY MIGRATION] ' + errMsg);
  console.error('Jalankan: MIGRATION_DATABASE_URL=postgres://USER:PASS@localhost:PORT/<db>_test');
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
  if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
    rejectMigration('Host wajib localhost atau 127.0.0.1 (DB disposable lokal).', `Host diterima: ${u.hostname}`);
  }
   if (!u.port || !/^\d+$/.test(u.port)) {
     rejectMigration('Port eksplisit wajib dalam URL.');
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
  const dbLower = database.toLowerCase();
  if (!/^[a-z0-9_]+_test$/.test(dbLower)) {
    rejectMigration('Database wajib berakhiran "_test" (disposable).', `Database diterima: ${database}`);
  }
  const userLower = user.toLowerCase();
  if (FORBIDDEN.some((p) => dbLower.includes(p) || userLower.includes(p))) {
    rejectMigration(
      'Indikator staging/production/live terdeteksi pada database atau user.'
    );
  }
  target = { host: u.hostname, port: Number(u.port), user, database, password };
  console.log(`[POS IDEMPOTENCY MIGRATION] Target DB: ${database} (user: ${user})`);
} catch (e) {
  rejectMigration('URL tidak valid: ' + e.message);
}

// ─── Pool dari field eksplisit — tanpa connectionString, tanpa fallback ────────
// host/port/user/database/password diberikan eksplisit; field lain sengaja
// tidak diisi sehingga tidak ada jalan kembali ke PG*/DB*/.env.
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

// ─── Import migration dari dist ──────────────────────────────────────────────
async function main() {
  let migration;
  try {
    migration = require('../dist/db/migrations/pos_idempotency_v1');
  } catch (err) {
    console.error(
      '[POS IDEMPOTENCY MIGRATION] Gagal import modul migration dari dist.\n' +
      '  ' + err.message + '\n' +
      'Pastikan backend sudah di-build: cd backend && npm run build'
    );
    await exitWith(1);
  }

  // 0) Cocokkan KONFIGURASI POOL (pool.options) dengan target tervalidasi
  //    SEBELUM probe & mutasi apa pun: host/port/user/database harus persis.
  const optMismatches = [
    ['host', pool.options.host, target.host],
    ['port', String(pool.options.port), String(target.port)],
    ['user', pool.options.user, target.user],
    ['database', pool.options.database, target.database],
  ].filter(([, a, b]) => String(a ?? '').toLowerCase() !== String(b ?? '').toLowerCase());
  if (optMismatches.length) {
    for (const [field, got, want] of optMismatches) {
      console.error(`[POS IDEMPOTENCY MIGRATION] DITOLAK: pool.options.${field}="${got}" != target "${want}".`);
    }
    await exitWith(1);
  }

  // 1) Cocokkan KONFIGURASI EFEKTIF pool dengan target tervalidasi,
  //    lalu probe identitas server.
  try {
    const cfg = await pool.query(
      `SELECT current_setting('server_version_num') AS v,
              current_database() AS db,
              current_user AS usr,
              inet_server_addr() AS srv_host,
              inet_server_port() AS srv_port`
    );
    const row = cfg.rows[0] || {};
    const db = (row.db ?? '').toLowerCase();
    const usr = (row.usr ?? '').toLowerCase();
    if (db !== target.database.toLowerCase()) {
      console.error(`[POS IDEMPOTENCY MIGRATION] DITOLAK: current_database "${row.db}" != target "${target.database}".`);
      await exitWith(1);
    }
    if (usr !== target.user.toLowerCase()) {
      console.error(`[POS IDEMPOTENCY MIGRATION] DITOLAK: current_user "${row.usr}" != target "${target.user}".`);
      await exitWith(1);
    }
    if (!/^[a-z0-9_]+_test$/.test(db)) {
      console.error(`[POS IDEMPOTENCY MIGRATION] DITOLAK: database aktual "${row.db}" bukan *_test.`);
      await exitWith(1);
    }
    if (FORBIDDEN.some((p) => db.includes(p))) {
      console.error('[POS IDEMPOTENCY MIGRATION] DITOLAK: database aktual terindikasi staging/prod/live.');
      await exitWith(1);
    }
    console.log(
      `[POS IDEMPOTENCY MIGRATION] Koneksi terverifikasi: db=${row.db} user=${row.usr} ` +
      `server=${row.srv_host || 'n/a'}:${row.srv_port ?? 'n/a'} (mapping URL: ${target.host}:${target.port})`
    );
  } catch (err) {
    console.error('[POS IDEMPOTENCY MIGRATION] Koneksi DB gagal: ' + err.message);
    await exitWith(1);
  }

  const result = await migration.runPosIdempotencyMigration(pool);

  if (result.ok) {
    console.log(
      '[POS IDEMPOTENCY MIGRATION] Berhasil — status: ' + result.status +
      (result.applied ? ' (DDL baru diterapkan)' : ' (marker sudah ada, skema sesuai)')
    );
    await exitWith(0);
  } else {
    console.error('[POS IDEMPOTENCY MIGRATION] GAGAL — status: ' + result.status);
    for (const e of result.errors) {
      console.error('  ' + e);
    }
    await exitWith(1);
  }
}

main().catch(async (err) => {
  console.error('[POS IDEMPOTENCY MIGRATION] Error tak terduga: ' + ((err && err.message) || err));
  await exitWith(1);
});

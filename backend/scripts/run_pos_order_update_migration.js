#!/usr/bin/env node
/**
 * RUNNER MIGRASI POS ORDER UPDATE v1 — CLI eksplisit
 * (versioning + idempotency multi-siklus untuk PUT /api/pos/orders/:id)
 *
 * Penggunaan:
 *   MIGRATION_DATABASE_URL=postgres://user:pass@127.0.0.1:15434/oak_minibar_test \
 *   node backend/scripts/run_pos_order_update_migration.js --apply
 *
 * ATAU (Windows PowerShell):
 *   $env:MIGRATION_DATABASE_URL='postgres://user:pass@127.0.0.1:15434/oak_minibar_test'
 *   node backend/scripts/run_pos_order_update_migration.js --apply
 *
 * Keamanan:
 * - Flag --apply WAJIB. Tanpa --apply, atau dengan flag lain, → exit 1.
 * - Tidak membaca .env, DB_*, atau PG* environment variables (tanpa fallback
 *   apa pun; pool dibuat dari field eksplisit hasil parse URL, bukan
 *   connectionString — field yang hilang tidak mengambil fallback apa pun).
 * - Hanya menggunakan MIGRATION_DATABASE_URL (env eksplisit).
 * - Jika MIGRATION_DATABASE_URL tidak ada atau kosong → exit 1.
 * - URL diparse dengan URL API (decode %XX via decodeURIComponent);
 *   wajib postgres/postgresql, host 127.0.0.1, port 15434
 *   (disposable test DB allowlisted), database oak_minibar_test, user
 *   minibar_test, password WAJIB ada. Query parameter ditolak.
 * - Target DB hanya disposable test — production tidak di-touch.
 *
 * Mode:
 * - Tanpa --apply     : verifikasi saja (marker & schema di-inspeksi,
 *                       TIDAK ada DDL yang dijalankan).
 * - --apply           : jalankan migration (marker sudah ada → verifikasi
 *                       saja, tanpa re-DDL).
 */
'use strict';

const { Pool } = require('pg');
const {
  runPosOrderUpdateMigration,
  verifyPosOrderUpdateSchema,
  checkPrerequisites,
} = require('../dist/db/migrations/pos_order_update_v1');

// Allowlist target disposable.
const ALLOW = {
  protocol: ['postgres:', 'postgresql:'],
  host: '127.0.0.1',
  port: 15434,
  database: 'oak_minibar_test',
  user: 'minibar_test',
};

function rejectMigration(message, extra) {
  console.error(`SAFETY: ${message}${extra ? `\n  detail: ${extra}` : ''}`);
  process.exit(1);
}

// ── 1. Validasi flag ─────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const applyFlag = argv.includes('--apply');
if (argv.length > 0 && argv[0] !== '--apply') {
  rejectMigration(`Flag tak dikenal: ${argv[0]}. Hanya --apply yang didukung.`);
}
if (applyFlag && argv.length > 1) {
  rejectMigration(`Flag tambahan tak dikenal: ${argv[1]}. Gunakan hanya: --apply`);
}

// ── 2. Parse & validasi MIGRATION_DATABASE_URL ──────────────────────────────
const rawUrl = process.env.MIGRATION_DATABASE_URL;
if (!rawUrl || rawUrl.trim() === '') {
  rejectMigration(
    'MIGRATION_DATABASE_URL tidak di-set.\n' +
    'Jalankan: MIGRATION_DATABASE_URL=postgres://user:pass@127.0.0.1:15434/oak_minibar_test ' +
    'node backend/scripts/run_pos_order_update_migration.js --apply'
  );
}

let target;
try {
  const u = new URL(rawUrl.trim());
  if (!ALLOW.protocol.includes(u.protocol)) {
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
  if (u.searchParams.size > 0) {
    rejectMigration(
      'Query parameter tidak didukung dalam URL: ' +
      [...u.searchParams.keys()].join(', ') +
      ' (hapus semua query parameter dari MIGRATION_DATABASE_URL)'
    );
  }
  const rawUser = u.username;
  const rawDb = u.pathname.replace(/^\//, '');
  const user = rawUser ? decodeURIComponent(rawUser) : null;
  const database = rawDb ? decodeURIComponent(rawDb) : null;
  const password = u.password ? decodeURIComponent(u.password) : null;

  if (!user || user !== ALLOW.user) {
    rejectMigration(
      `User wajib '${ALLOW.user}' (allowlist disposable).`,
      `User diterima: ${user || '(kosong)'}`
    );
  }
  if (!database || database !== ALLOW.database) {
    rejectMigration(
      `Database wajib '${ALLOW.database}' (allowlist disposable).`,
      `Database diterima: ${database || '(kosong)'}`
    );
  }
  if (!password) {
    rejectMigration('Password wajib ada dalam URL (user + password eksplit).');
  }
  target = { host: u.hostname, port, user, password, database };
} catch (e) {
  if (e.code === 'ERR_INVALID_URL') {
    rejectMigration('MIGRATION_DATABASE_URL tidak valid — bukan URL legal.', e.message);
  }
  throw e;
}

// Pool dari FIELD EKSPSITIT — bukan connectionString — tanpa fallback env.
const pool = new Pool({
  host: target.host,
  port: target.port,
  user: target.user,
  password: target.password,
  database: target.database,
  application_name: 'pos-order-update-migration-runner',
  allowExit: false,
});

function printVerify(verify, prereq) {
  if (prereq && !prereq.ok) {
    console.log('\n[PREREQUISITE CHECK] GAGAL:');
    for (const err of prereq.errors) console.log(`  - ${err}`);
  }
  if (!verify.ok) {
    console.log('\n[VERIFIKASI SCHEMA] GAGAL:');
    for (const err of verify.errors) console.log(`  - ${err}`);
    return false;
  }
  console.log('\n[VERIFIKASI SCHEMA] OK — version + pos_order_edit_requests tersedia.');
  return true;
}

pool.connect().then(async (client) => {
  let rc = 0;
  try {
    // Verifikasi koneksi & database eksplisit (anti-ambiguitas).
    const dbRes = await client.query('SELECT current_database() AS db, current_user AS usr');
    const dbNow = dbRes.rows[0] && dbRes.rows[0].db;
    const usrNow = dbRes.rows[0] && dbRes.rows[0].usr;
    if (dbNow !== target.database) {
      console.log('SAFETY: current_database() tidak sesuai target — pool memakai URL lain.');
      rc = 1;
    }
    if (usrNow !== target.user) {
      console.log(`SAFETY: current_user '${usrNow}' !== target '${target.user}'.`);
      rc = 1;
    }
    if (rc !== 0) return;

    if (!applyFlag) {
      const prereq = await checkPrerequisites(client);
      const verify = await verifyPosOrderUpdateSchema(client);
      printVerify(verify, prereq);
      rc = verify.ok ? 0 : 1;
      console.log(`[MODE: verify-only] rc=${rc}`);
      return;
    }

    // --apply
    const result = await runPosOrderUpdateMigration(pool);
    const verify = await verifyPosOrderUpdateSchema(client);
    console.log(`[MODE: apply] status=${result.status}`);
    if (result.status === 'error') {
      for (const err of result.errors) console.log(`  ERROR: ${err}`);
      rc = 1;
    } else {
      printVerify(verify);
      rc = verify.ok ? 0 : 1;
    }
  } finally {
    client.release();
    await pool.end();
  }
  process.exitCode = rc;
}).catch((err) => {
  console.error('Migration runner error:', err.message);
  process.exitCode = 1;
});

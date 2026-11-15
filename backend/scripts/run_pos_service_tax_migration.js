#!/usr/bin/env node
/**
 * RUNNER MIGRASI POS SERVICE & TAX v1 — CLI eksplisit
 * (Fondasi tabel property_pos_pricing_settings + kolom snapshot pos_orders)
 *
 * Penggunaan:
 *   MIGRATION_DATABASE_URL=postgres://user:pass@127.0.0.1:15434/oak_minibar_test \
 *   node backend/scripts/run_pos_service_tax_migration.js --check
 *
 *   MIGRATION_DATABASE_URL=postgres://user:pass@127.0.0.1:15434/oak_minibar_test \
 *   node backend/scripts/run_pos_service_tax_migration.js --apply
 *
 * ATAU (Windows PowerShell):
 *   $env:MIGRATION_DATABASE_URL='postgres://user:pass@127.0.0.1:15434/oak_minibar_test'
 *   node backend/scripts/run_pos_service_tax_migration.js --check
 *   node backend/scripts/run_pos_service_tax_migration.js --apply
 *
 * Flag (saling eksklusif — tepat satu, keduanya ditolak bersamaan):
 *   --check  : READ-ONLY. Jalankan prerequisite check, cek marker & struktur
 *              schema tanpa CREATE/ALTER/INSERT/UPDATE/DELETE apa pun.
 *              Output status: READY_TO_APPLY | ALREADY_APPLIED |
 *              INVALID_PARTIAL | PREREQUISITE_FAILED
 *   --apply  : Jalankan runPosServiceTaxMigration() penuh (DDL + marker +
 *              verifikasi). Tidak menjalankan apa pun selain flag ini.
 *
 * Keamanan:
 * - Tepat satu flag WAJIB: --check ATAU --apply. Tanpa flag → exit 1.
 *   --check --apply bersamaan → exit 1. Argumen tambahan → exit 1.
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
 * - --check: gunakan BEGIN + SET TRANSACTION READ ONLY; jalankan
 *   checkPrerequisites, verifyPosServiceTaxSchema, verifyPosServiceTaxMarker
 *   dari modul migration dist; ROLLBACK tanpa efek; output status.
 * - --apply: jalankan runPosServiceTaxMigration() penuh.
 * - Hasil migration.ok=false atau error → exitCode=1.
 * - Pool selalu ditutup sebelum exit (sukses, gagal, atau error tak terduga).
 */

'use strict';

// ——— Validasi argumen: wajib tepat --check ATAU --apply (saling eksklusif) —
const argv = process.argv.slice(2);

const VALID_FLAGS = new Set(['--check', '--apply']);
if (argv.length !== 1 || !VALID_FLAGS.has(argv[0])) {
  const extra = argv.length > 0 ? argv.join(' ') : '(tanpa flag)';
  console.error(
    '[POS SERVICE TAX MIGRATION] Argumen tak valid: "' + extra + '"\n' +
    '  Runner WAJIB menerima tepat satu flag: --check ATAU --apply.\n' +
    'Jalankan: node backend/scripts/run_pos_service_tax_migration.js --check\n' +
    '       atau: node backend/scripts/run_pos_service_tax_migration.js --apply\n' +
    '  dengan MIGRATION_DATABASE_URL eksplisit.'
  );
  process.exit(1);
}

const mode = argv[0]; // '--check' | '--apply'

// ——— Guard konstanta disposable ————————————————————————————————————————————————
const FORBIDDEN = ['staging', 'production', 'prod', 'live'];

// Allowlist target disposable
const ALLOW = {
  host: '127.0.0.1',
  port: 15434,
  database: 'oak_minibar_test',
  user: 'minibar_test',
};

// ——— Parse MIGRATION_DATABASE_URL ——————————————————————————————————————————————
const migrationUrl = process.env.MIGRATION_DATABASE_URL;

function rejectMigration(errMsg, extra) {
  if (extra) console.error('[POS SERVICE TAX MIGRATION] ' + extra);
  console.error('[POS SERVICE TAX MIGRATION] ' + errMsg);
  console.error(
    'Jalankan: MIGRATION_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test ' +
    'node backend/scripts/run_pos_service_tax_migration.js --check | --apply'
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
  console.log(`[POS SERVICE TAX MIGRATION] Target DB: ${database} (user: ${user}, port: ${port})`);
} catch (e) {
  rejectMigration('URL tidak valid: ' + e.message);
}

// ——— Pool dari field eksplisit — tanpa connectionString, tanpa fallback ———
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
      '[POS SERVICE TAX MIGRATION] pool.end gagal: ' +
      String((endErr && endErr.message) || endErr)
    );
    finalCode = 1;
  }

  process.exit(finalCode);
}

/**
 * Variasi exit cepat: tidak menunggu pool.end() — cukup proses.exit().
 * Digunakan setelah semua work selesai (check atau apply) agar runner
 * tidak hang di pool teardown. Pool object GC akan membersihkan
 * koneksi saat process berakhir.
 */
function quickExit(code) {
  // Force close the pool without waiting (fire-and-forget).
  try { pool.end(); } catch (_) {}
  process.exit(code);
}

// ——— Import modul migration dari dist (bukan app/index) ——————————————————————
async function main() {
  let migration;
  try {
    migration = require('../dist/db/migrations/pos_service_tax_v1');
  } catch (err) {
    console.error(
      '[POS SERVICE TAX MIGRATION] Gagal import modul migration dari dist.\n' +
      '  ' + err.message + '\n' +
      'Pastikan backend sudah di-build: cd backend && npm run build'
    );
    await exitWith(1);
    return;
  }

  // Guard: pastikan export function tersedia
  if (typeof migration.runPosServiceTaxMigration !== 'function') {
    console.error(
      '[POS SERVICE TAX MIGRATION] Export runPosServiceTaxMigration tidak ditemukan. ' +
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
      console.error(`[POS SERVICE TAX MIGRATION] DITOLAK: pool.options.${field}="${got}" != target "${want}".`);
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
      console.error(`[POS SERVICE TAX MIGRATION] DITOLAK: current_database "${row.db}" != target "${target.database}".`);
      await exitWith(1);
      return;
    }
    if (row.usr !== target.user) {
      console.error(`[POS SERVICE TAX MIGRATION] DITOLAK: current_user "${row.usr}" != target "${target.user}".`);
      await exitWith(1);
      return;
    }
    const dbLower = String(row.db ?? '').toLowerCase();
    if (FORBIDDEN.some((p) => dbLower.includes(p))) {
      console.error('[POS SERVICE TAX MIGRATION] DITOLAK: database aktual terindikasi staging/prod/live.');
      await exitWith(1);
      return;
    }
    console.log(
      `[POS SERVICE TAX MIGRATION] Koneksi terverifikasi: db=${row.db} user=${row.usr} ` +
      `(host: ${target.host}:${target.port})`
    );
  } catch (err) {
    console.error('[POS SERVICE TAX MIGRATION] Koneksi DB gagal: ' + err.message);
    await exitWith(1);
    return;
  }

  if (mode === '--check') {
    // ── MODE --check : READ-ONLY ─────────────────────────────────────────────
    // Jalankan checkPrerequisites, verifyPosServiceTaxSchema,
    // verifyPosServiceTaxMarker dalam transaksi READ ONLY (BEGIN →
    // SET TRANSACTION READ ONLY → queries read-only → ROLLBACK).
    //
    // Status yang mungkin:
    //   READY_TO_APPLY    : prerequisites OK, marker belum ada → --apply aman
    //   ALREADY_APPLIED   : marker sudah ada, schema & marker sesuai
    //   INVALID_PARTIAL   : marker ada tetapi schema tidak sesuai
    //   PREREQUISITE_FAILED: tabel dasar tidak tersedia
    //
    // CATATAN:
    // - SET TRANSACTION READ ONLY hanya mengaktifkan untuk transaksi TERSEBUT.
    // - Semua query di dalam transaksi READ ONLY yang melanggar (CREATE, ALTER,
    //   INSERT, UPDATE, DELETE, v.v.) akan ditolak oleh Postgres — ini proteksi
    //   ganda selain hanya memanggil fungsi read-only dari modul migration.
    // - Tidak ada DDL atau mutasi apa pun dilakukan di sini.
    // ─────────────────────────────────────────────────────────────────────────
    let client = null;
    let checkDone = false;
    try {
      client = await pool.connect();

      // Perbarui checkPrerequisites — hanya boleh read-only di sini
      if (typeof migration.checkPrerequisites !== 'function') {
        console.error('[POS SERVICE TAX MIGRATION] checkPrerequisites tidak tersedia di modul dist.');
        checkDone = true;
        client.release();
        await exitWith(1);
        return;
      }

      const prereq = await migration.checkPrerequisites(client);
      if (!prereq.ok) {
        for (const e of prereq.errors) {
          console.error('  ' + e);
        }
        console.log('\n[POS SERVICE TAX MIGRATION] STATUS: PREREQUISITE_FAILED');
        console.log('[POS SERVICE TAX MIGRATION] Jalankan migrasi dasar terlebih dahulu sebelum --apply.');
        checkDone = true;
        client.release();
        await exitWith(1);
        return;
      }

      // Buka transaksi READ ONLY
      await client.query('BEGIN');
      await client.query('SET TRANSACTION READ ONLY');

      try {
        // Cek marker
        const markerRes = await client.query(
          'SELECT 1 FROM schema_migrations WHERE version = $1',
          ['pos_service_tax_v1']
        );
        const markerExists = (markerRes.rowCount ?? 0) > 0;

        if (markerExists) {
          // Marker ada → verifikasi schema final
          if (typeof migration.verifyPosServiceTaxSchema !== 'function') {
            console.error('[POS SERVICE TAX MIGRATION] verifyPosServiceTaxSchema tidak tersedia.');
            checkDone = true;
            try { await client.query('ROLLBACK'); } catch (_) {}
            client.release();
            await exitWith(1);
            return;
          }
          const schemaRes = await migration.verifyPosServiceTaxSchema(client);
          const markerVerify = await migration.verifyPosServiceTaxMarker(client);
          if (!schemaRes.ok || !markerVerify.ok) {
            const allErrors = [...schemaRes.errors, ...markerVerify.errors];
            for (const e of allErrors) {
              console.error('  ' + e);
            }
            console.log('\n[POS SERVICE TAX MIGRATION] STATUS: INVALID_PARTIAL');
            console.log('[POS SERVICE TAX MIGRATION] Marker ada tetapi skema tidak sesuai. Perbaiki manual sebelum --apply.');
            checkDone = true;
            try { await client.query('ROLLBACK'); } catch (_) {}
            client.release();
            await exitWith(1);
            return;
          }
          console.log('[POS SERVICE TAX MIGRATION] STATUS: ALREADY_APPLIED');
          console.log('[POS SERVICE TAX MIGRATION] Marker & skema sesuai. Tidak perlu --apply lagi.');
          checkDone = true;
          try { await client.query('ROLLBACK'); } catch (_) {}
          client.release();
          quickExit(0);
          return;
        }

        // Marker belum ada → verifikasi prerequisites sudah OK (di atas),
        // cek apakah tabel DDL belum pernah dibuat sebagian
        // (mendeteksi partial apply dari run sebelumnya yang gagal di tengah).
        const tblRes = await client.query(
          `SELECT 1 FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public'
             AND c.relname = 'property_pos_pricing_settings'
             AND c.relkind IN ('r','p')`
        );
        const tblExists = (tblRes.rowCount ?? 0) > 0;

        if (tblExists) {
          // Tabel sudah ada tetapi marker belum — partial state
          // Jalankan verifyPosServiceTaxSchema untuk memastikan struktur lengkap
          const schemaRes = await migration.verifyPosServiceTaxSchema(client);
          if (!schemaRes.ok) {
            for (const e of schemaRes.errors) {
              console.error('  ' + e);
            }
            console.log('\n[POS SERVICE TAX MIGRATION] STATUS: INVALID_PARTIAL');
            console.log('[POS SERVICE TAX MIGRATION] Tabel partially dibuat tanpa marker. Perbaiki manual.');
            checkDone = true;
            try { await client.query('ROLLBACK'); } catch (_) {}
            client.release();
            await exitWith(1);
            return;
          }
          // Schema lengkap tapi marker belum terpasang — tetap bisa --apply
          // (idempotent: marker ON CONFLICT DO NOTHING)
          console.log('[POS SERVICE TAX MIGRATION] Tabel & skema sudah ada, marker belum terpasang.');
          console.log('[POS SERVICE TAX MIGRATION] --apply akan melanjutkan (idempotent).');
        }

        console.log('\n[POS SERVICE TAX MIGRATION] STATUS: READY_TO_APPLY');
        console.log('[POS SERVICE TAX MIGRATION] Prerequisites OK, marker belum ada. --apply aman untuk dijalankan.');
        checkDone = true;
        try { await client.query('ROLLBACK'); } catch (_) {}
        client.release();
        quickExit(0);
        return;
      } finally {
        // ROLLBACK transaksi READ ONLY — aman karena tidak ada mutasi.
        // Hanya dijalankan jika quickExit/exitWith belum sempat release.
        if (!checkDone && client) {
          try { await client.query('ROLLBACK'); } catch (_) {}
          try { client.release(); } catch (_) {}
        }
      }
    } catch (err) {
      console.error('[POS SERVICE TAX MIGRATION] --check error: ' + ((err && err.message) || err));
      if (client) {
        // Transaksi READ-ONLY masih bisa aktif — ROLLBACK wajib sebelum release
        // agar client tidak dikembalikan ke pool dengan transaksi terbuka.
        try { await client.query('ROLLBACK'); } catch (_) {}
        try { client.release(); } catch (_) {}
      }
      await exitWith(1);
      return;
    }

  } else {
    // ── MODE --apply : jalankan migration penuh ──────────────────────────────
    const result = await migration.runPosServiceTaxMigration(pool);

    if (result.ok) {
      console.log(
        '[POS SERVICE TAX MIGRATION] Berhasil — status: ' + result.status +
        (result.applied ? ' (DDL + marker baru diterapkan)' : ' (marker sudah ada, skema sesuai)')
      );
      await exitWith(0);
    } else {
      console.error('[POS SERVICE TAX MIGRATION] GAGAL — status: ' + result.status);
      for (const e of result.errors) {
        console.error('  ' + e);
      }
      await exitWith(1);
    }
  }
}

main().catch(async (err) => {
  console.error('[POS SERVICE TAX MIGRATION] Error tak terduga: ' + ((err && err.message) || err));
  await exitWith(1);
});

#!/usr/bin/env node
/**
 * RUNNER MIGRASI POS COMMUNICATION SETTINGS v1 - STAGING (TERPISAH DARI RUNNER DISPOSABLE)
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
 *   DB_PASSWORD dari env (tidak pernah dicetak).
 *   Tanpa dotenv, tanpa DATABASE_URL, tanpa PG* fallback.
 *
 * Argumen:
 *   WAJIB PERSIS SATU flag: --check atau --apply.
 *   - Tanpa flag               -> exit 1
 *   - Campuran (--check --apply) -> exit 1
 *   - Argumen tambahan         -> exit 1
 *
 * Keamanan:
 *   - Pool dibuat dari field eksplisit hasil validasi env.
 *   - Perbandingan env target, pool.options, dan identitas DB
 *     memakai equality EXACT (tanpa normalisasi case).
 *   - Semua kegagalan setelah pool dibuat dilempar sebagai exception;
 *     penutupan pool terpusat di jalur akhir main (sukses maupun gagal).
 *   - --check selalu dalam transaksi READ ONLY; client dilepas di finally.
 *   - DB_PASSWORD tidak pernah dicetak.
 */

'use strict';

const path = require('path');
const { Pool } = require('pg');

// ΓöÇΓöÇ Allowlist target staging (TEPAT, tanpa variasi) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const TARGET = {
  host:     '/cloudsql/oak-lawang-pms:asia-southeast2:oak-hims-staging-db15',
  port:     5432,
  user:     'postgres',
  database: 'oak_hotel_db',
};

// NODE_ENV wajib production untuk staging runner
const REQUIRED_NODE_ENV = 'production';

const MARKER = 'pos_communication_settings_v1';
const TABLE = 'property_pos_communication_settings';

// ΓöÇΓöÇ 1. NODE_ENV guard ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const nodeEnv = String(process.env.NODE_ENV ?? '').trim();
if (nodeEnv !== REQUIRED_NODE_ENV) {
  console.error(
    '[POS COMMUNICATION SETTINGS STAGING] NODE_ENV="' + nodeEnv + '" tidak sesuai. ' +
    'Runner staging wajib NODE_ENV="' + REQUIRED_NODE_ENV + '".');
  process.exit(1);
}

// ΓöÇΓöÇ 2. Parse argumen: WAJIB PERSIS SATU flag ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const argv = process.argv.slice(2);
let mode = null;
if (argv.length === 1 && argv[0] === '--check') {
  mode = 'check';
} else if (argv.length === 1 && argv[0] === '--apply') {
  mode = 'apply';
}

if (!mode) {
  console.error(
    '[POS COMMUNICATION SETTINGS STAGING] Argumen tidak valid.\n' +
    '  WAJIB PERSIS SATU flag:\n' +
    '    node run_pos_communication_settings_migration_staging.js --check\n' +
    '    node run_pos_communication_settings_migration_staging.js --apply\n' +
    '  Argumen diterima: ' + JSON.stringify(argv)
  );
  process.exit(1);
}

// ΓöÇΓöÇ 3. Wajib env DB_* (tanpa fallback) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const MISSING = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME', 'DB_PASSWORD']
  .filter((k) => !process.env[k] || String(process.env[k]).trim() === '');

if (MISSING.length > 0) {
  console.error('[POS COMMUNICATION SETTINGS STAGING] Env wajib tidak tersedia: ' + MISSING.join(', '));
  process.exit(1);
}

const envHost    = String(process.env.DB_HOST).trim();
const envPortRaw = String(process.env.DB_PORT).trim();
const envUser    = String(process.env.DB_USER).trim();
const envDb      = String(process.env.DB_NAME).trim();
const envPass    = String(process.env.DB_PASSWORD); // tidak pernah dicetak

// ΓöÇΓöÇ 4. Verifikasi target: equality EXACT dengan allowlist staging ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const targetMismatches = [
  ['DB_HOST',   envHost,    TARGET.host],
  ['DB_PORT',   envPortRaw, '5432'],
  ['DB_USER',   envUser,    TARGET.user],
  ['DB_NAME',   envDb,      TARGET.database],
].filter(([, got, want]) => got !== want);

if (targetMismatches.length) {
  for (const [field, got, want] of targetMismatches) {
    console.error('[POS COMMUNICATION SETTINGS STAGING] DITOLAK: ' + field + '="' + got + '" != allowlist "' + want + '".');
  }
  console.error('[POS COMMUNICATION SETTINGS STAGING] Target tidak sesuai allowlist staging.');
  process.exit(1);
}

console.log(
  '[POS COMMUNICATION SETTINGS STAGING] Mode: ' + mode + ' | ' +
  'host=' + TARGET.host + ' port=' + TARGET.port + ' user=' + TARGET.user + ' db=' + TARGET.database
);

// ΓöÇΓöÇ 5. Pool (field eksplisit, tanpa connectionString) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
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
  console.log('[POS COMMUNICATION SETTINGS STAGING] pool.options terverifikasi.');
}

// ΓöÇΓöÇ 6. Verifikasi identitas server (equality EXACT, sebelum mutasi) ΓöÇΓöÇΓöÇΓöÇΓöÇ
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
    '[POS COMMUNICATION SETTINGS STAGING] Identitas terverifikasi: db=' + db + ' user=' + usr +
    ' server=' + (row.srv_host ?? 'n/a') + ':' + (row.srv_port ?? 'n/a')
  );
}

// ΓöÇΓöÇ 7. Import modul migration dari dist ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
function loadMigrationModule() {
  const distPath = path.resolve(__dirname, '..', 'dist', 'db', 'migrations', 'pos_communication_settings_v1');
  try {
    return require(distPath);
  } catch (err) {
    throw new Error(
      'Gagal import modul migration dari dist: ' + err.message + ' - ' +
      'pastikan dist/db/migrations/pos_communication_settings_v1.js tersedia (build TypeScript).'
    );
  }
}

// ΓöÇΓöÇ 8. Structural presence check (pg_catalog authoritative) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Cek kolom structural milik tabel property_pos_communication_settings.
// Authority: pg_catalog (pg_attribute + pg_class + pg_namespace).
// information_schema / pg_tables sengaja tidak dipakai ΓÇö visibility filtering
// dapat memberi false-negative pada role runner staging.
const COMM_SETTINGS_COLUMNS = [
  { column: 'property_id' },
  { column: 'whatsapp_enabled' },
  { column: 'whatsapp_intro_message' },
  { column: 'whatsapp_closing_message' },
];

async function checkStructuralPresence(client) {
  const colResult = await client.query(
    `SELECT c.relname AS table_name,
            a.attname AS column_name
     FROM pg_attribute a
     JOIN pg_class c     ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r','p')
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND c.relname = $1
       AND a.attname IN ('property_id', 'whatsapp_enabled', 'whatsapp_intro_message', 'whatsapp_closing_message')`,
    [TABLE]
  );
  const found = new Set(colResult.rows.map((r) => r.column_name));
  const columnsPresent = COMM_SETTINGS_COLUMNS.filter(({ column }) => found.has(column));
  const columnsMissing = COMM_SETTINGS_COLUMNS.filter(({ column }) => !found.has(column));
  return {
    columnsPresent,
    columnsMissing,
    nonePresent: columnsPresent.length === 0,
    allPresent:  columnsMissing.length === 0,
  };
}

// ΓöÇΓöÇ 9. Mode: --check (read-only readiness dalam transaksi READ ONLY) ΓöÇΓöÇ
// runCheck TIDAK memanggil pool.end() atau process.exit().
// State & exitCode dikembalikan sebagai { state, exitCode } melalui return value;
// kegagalan cleanup (client.release) memaksa exitCode non-zero TANPA mengubah state.
// Release klien: satu percobaan per koneksi ΓÇö jalur sukses di finally (release normal),
// jalur error di catch (release(true) = discard bila ROLLBACK gagal).
// Penutupan pool terpusat di jalur main.
async function runCheck(pool, migration) {
  const client = await pool.connect();
  let released = false;
  let result = null; // dipetakan di semua jalur return state-machine,
                     // dimodifikasi di finally bila cleanup gagal.
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');

    // 1) checkPrerequisites dari modul migration
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
    if (structural.nonePresent) {
      console.log('[CHECK] Struktur communication settings: TIDAK ADA satu pun.');
    } else if (structural.allPresent) {
      console.log('[CHECK] Struktur communication settings: SEMUA ADA.');
    } else {
      console.log('[CHECK] Struktur communication settings: SEBAGIAN ada.');
      console.log('[CHECK]  Ada:   [' + structural.columnsPresent.map((c) => c.column).join(', ') + ']');
      console.log('[CHECK]  Hilang: [' + structural.columnsMissing.map((c) => c.column).join(', ') + ']');
    }

    // ΓöÇΓöÇ State machine ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    if (markerExists) {
      // MARKER ADA ΓåÆ verifikasi skema final + marker.
      const verify = await migration.verifyPosCommunicationSettingsSchema(client);
      const markerVerify = await migration.verifyPosCommunicationSettingsMarker(client);
      if (verify.ok && markerVerify.ok) {
        console.log('[CHECK] Verifikasi skema & marker: LULUS.');
        await client.query('COMMIT');
        result = { state: 'ALREADY_APPLIED', exitCode: 0 };
        return result;
      }
      for (const e of verify.errors) console.error('[CHECK] GAGAL skema: ' + e);
      for (const e of markerVerify.errors) console.error('[CHECK] GAGAL marker: ' + e);
      await client.query('COMMIT');
      throw new Error('MARKER_MISMATCH: marker ada tetapi verifikasi skema/marker gagal (tolak, diagnosis manual diperlukan).');
    }

    // MARKER TIDAK ADA + sebagian struktur ada ΓåÆ PARTIAL_OR_MISMATCHED_SCHEMA
    if (!structural.nonePresent && !structural.allPresent) {
      console.error('[CHECK] PARTIAL_OR_MISMATCHED_SCHEMA: sebagian struktur ada, marker tidak ada.');
      console.error('[CHECK]  Ada:   [' + structural.columnsPresent.map((c) => c.column).join(', ') + ']');
      console.error('[CHECK]  Hilang: [' + structural.columnsMissing.map((c) => c.column).join(', ') + ']');
      await client.query('COMMIT');
      result = { state: 'PARTIAL_OR_MISMATCHED_SCHEMA', exitCode: 1 };
      return result;
    }

    // MARKER TIDAK ADA + SEMUA struktur ada (allPresent=true)
    if (structural.allPresent) {
      const verify = await migration.verifyPosCommunicationSettingsSchema(client);
      if (verify.ok) {
        // FINAL SCHEMA VALID, MARKER HILANG ΓåÆ READY_TO_MARK_OR_RECONCILE
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

    // MARKER TIDAK ADA + TIDAK ADA satu pun struktur (clean pre-migration)
    await client.query('COMMIT');
    result = { state: 'READY_TO_APPLY', exitCode: 0 };
    return result;

  } catch (err) {
    // ROLLBACK eksplisit. Jika ROLLBACK gagal (koneksi mati/transaksi rusak),
    // koneksi WAJIB di-discard (release(true)), bukan dikembalikan ke pool
    // dalam keadaan tidak sehat. Kegagalan ROLLBACK membuat --check gagal.
    let rollbackFailed = false;
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      rollbackFailed = true;
      console.error(
        '[POS COMMUNICATION SETTINGS STAGING] ROLLBACK gagal: ' +
        String((rbErr && rbErr.message) || rbErr)
      );
    }
    // Discard koneksi bila ROLLBACK gagal; normal bila berhasil.
    // Tandai released=true SEBELUM memanggil release() ΓÇö flag menandai
    // "satu percobaan release sudah dilakukan", sehingga finally tidak
    // akan mencoba release kedua kali, terlepas dari hasil percobaan ini.
    released = true;
    try {
      client.release(rollbackFailed);
    } catch (relErr) {
      console.error(
        '[POS COMMUNICATION SETTINGS STAGING] client.release gagal: ' +
        String((relErr && relErr.message) || relErr)
      );
      // Kegagalan cleanup tidak boleh menyembunyikan error asli:
      // error asli tetap di-throw; kegagalan release hanya dicatat.
      // (Status --check tetap gagal karena error asli di-throw di bawah.)
    }
    throw err;
  } finally {
    // Jalur SUKES (COMMIT + return): satu-satunya titik release untuk jalur ini.
    // Jalur ERROR sudah melakukan satu percobaan release di catch
    // (release(true) = discard bila ROLLBACK gagal); guard 'released'
    // memastikan release hanya dicoba sekali per koneksi.
    //
    // PENTING: bila release() pada jalur sukses gagal, kegagalan cleanup
    // WAJIB memaksa hasil --check menjadi non-zero. Tanpa ini, READY_TO_APPLY
    // (exitCode 0) tetap dapat dikembalikan meski pool dalam keadaan rusak.
    if (!released) {
      released = true;
      try {
        client.release();
      } catch (relErr) {
        console.error(
          '[POS COMMUNICATION SETTINGS STAGING] client.release gagal: ' +
          String((relErr && relErr.message) || relErr)
        );
        // Cleanup gagal ΓåÆ paksa non-zero tanpa mengubah state.
        if (result !== null) {
          result.exitCode = 1;
        }
      }
    }
  }
}

// ΓöÇΓöÇ 10. Mode: --apply (DDL + marker) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
async function runApply(pool, migration) {
  const result = await migration.runPosCommunicationSettingsMigration(pool);
  if (result.ok) {
    console.log(
      '[APPLY] Berhasil - status: ' + result.status +
      (result.applied ? ' (DDL + marker baru diterapkan)' : ' (marker sudah ada, skema sesuai)')
    );
  } else {
    console.error('[APPLY] GAGAL - status: ' + result.status);
    for (const e of result.errors) {
      console.error('  ' + e);
    }
    throw new Error('Migration gagal: ' + result.errors.join('; '));
  }
}

// ΓöÇΓöÇ 11. Main: semua kegagalan di-throw; penutupan pool terpusat ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
async function run() {
  verifyPoolOptions();
  const migration = loadMigrationModule();

  // Verifikasi identitas SEBELUM apa pun (check maupun apply)
  await verifyIdentity();

  if (mode === 'check') {
    const { state, exitCode } = await runCheck(pool, migration);
    pendingExitCode = exitCode;
    if (exitCode === 0) {
      console.log('[POS COMMUNICATION SETTINGS STAGING] --check selesai: ' + state + '.');
    } else {
      console.error('[POS COMMUNICATION SETTINGS STAGING] --check selesai: ' + state + ' (exit 1).');
    }
    return;
  }

  // mode === 'apply'
  await runApply(pool, migration);
}

let pendingExitCode = 0;

run()
  .then(async () => {
    if (mode === 'check') {
      // pendingExitCode sudah di-set di dalam run()
    }
    try {
      await pool.end();
    } catch (endErr) {
      console.error(
        '[POS COMMUNICATION SETTINGS STAGING] pool.end gagal: ' +
        String((endErr && endErr.message) || endErr)
      );
      pendingExitCode = 1; // kegagalan penutupan koneksi memaksa exit non-zero
    }
    process.exit(pendingExitCode);
  })
  .catch(async (err) => {
    console.error('[POS COMMUNICATION SETTINGS STAGING] GAGAL: ' + ((err && err.message) || err));
    try {
      await pool.end();
    } catch (endErr) {
      console.error(
        '[POS COMMUNICATION SETTINGS STAGING] pool.end gagal: ' +
        String((endErr && endErr.message) || endErr)
      );
    }
    process.exit(1);
  });

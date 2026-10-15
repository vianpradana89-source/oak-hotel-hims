#!/usr/bin/env node
/**
 * RUNNER MIGRASI PROPERTY PAYMENT INSTRUCTIONS - STAGING
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
 *   DB_HOST, DB_PORT, DB_USER, DB_NAME, DB_PASSWORD dari env (tanpa fallback).
 *   Tanpa dotenv, tanpa DATABASE_URL, tanpa PG* fallback.
 *
 * DDL Source:
 *   backend/src/db/migrations/doc_1b_2a_property_payment_instructions.sql
 *   (file authoritative - jangan duplikasi DDL sebagai string baru)
 *
 * Argumen:
 *   WAJIB PERSIS SATU flag: --check atau --apply.
 *   - Tanpa flag                  -> exit 1
 *   - Campuran (--check --apply)   -> exit 1
 *   - Argumen tambahan             -> exit 1
 *
 * Keamanan:
 *   - Exact equality env vs allowlist staging SEBELUM pool dibuat.
 *   - Pool dibuat dari field eksplisit, pool.options diverifikasi exact.
 *   - current_database() dan current_user() diverifikasi exact.
 *   - DB_PASSWORD tidak pernah dicetak.
 *   - --check selalu dalam transaksi READ ONLY.
 *   - --apply memvalidasi source SQL sebelum eksekusi (guard statement destructive).
 *   - Pool selalu ditutup di jalur akhir (sukses maupun gagal).
 *
 * Marker:
 *   DDL legacy ini TIDAK mempunyai schema_migrations marker authoritative.
 *   Runner JANGAN invent marker baru.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ── Allowlist target staging (TEPAT, tanpa variasi) ─────────────────────────
const TARGET = {
  host:     '/cloudsql/oak-lawang-pms:asia-southeast2:oak-hims-staging-db15',
  port:     5432,
  user:     'postgres',
  database: 'oak_hotel_db',
};

const LOG_PREFIX = '[PPI STAGING]';

// ── Path source SQL authoritative ──────────────────────────────────────────
const SOURCE_SQL_PATH = path.resolve(
  __dirname,
  '..',
  'src',
  'db',
  'migrations',
  'doc_1b_2a_property_payment_instructions.sql'
);

// ── 1. Parse argumen: WAJIB PERSIS SATU flag ────────────────────────────────
const argv = process.argv.slice(2);
let mode = null;
if (argv.length === 1 && argv[0] === '--check') {
  mode = 'check';
} else if (argv.length === 1 && argv[0] === '--apply') {
  mode = 'apply';
} else if (argv.length === 1 && argv[0] === '--diagnose') {
  mode = 'diagnose';
}

if (!mode) {
  console.error(
    LOG_PREFIX + ' Argumen tidak valid.\n' +
    '  WAJIB PERSIS SATU flag:\n' +
    '    node run_property_payment_instructions_migration_staging.js --check\n' +
    '    node run_property_payment_instructions_migration_staging.js --apply\n' +
    '    node run_property_payment_instructions_migration_staging.js --diagnose\n' +
    '  Argumen diterima: ' + JSON.stringify(argv)
  );
  process.exit(1);
}

// ── 2. Wajib env DB_* (tanpa fallback) ─────────────────────────────────────
const MISSING = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME', 'DB_PASSWORD']
  .filter((k) => !process.env[k] || String(process.env[k]).trim() === '');

if (MISSING.length > 0) {
  console.error(LOG_PREFIX + ' Env wajib tidak tersedia: ' + MISSING.join(', '));
  process.exit(1);
}

const envHost    = String(process.env.DB_HOST).trim();
const envPortRaw = String(process.env.DB_PORT).trim();
const envUser    = String(process.env.DB_USER).trim();
const envDb      = String(process.env.DB_NAME).trim();
const envPass    = String(process.env.DB_PASSWORD); // tidak pernah dicetak

// ── 3. Verifikasi target: equality EXACT dengan allowlist staging ─────────
// (Sebelum pool dibuat; process.exit aman karena belum ada pool.)
const targetMismatches = [
  ['DB_HOST',   envHost,    TARGET.host],
  ['DB_PORT',   envPortRaw, '5432'],
  ['DB_USER',   envUser,    TARGET.user],
  ['DB_NAME',   envDb,      TARGET.database],
].filter(([, got, want]) => got !== want);

if (targetMismatches.length) {
  for (const [field, got, want] of targetMismatches) {
    console.error(LOG_PREFIX + ' DITOLAK: ' + field + '="' + got + '" != allowlist "' + want + '".');
  }
  console.error(LOG_PREFIX + ' Target tidak sesuai allowlist staging.');
  process.exit(1);
}

console.log(
  LOG_PREFIX + ' Mode: ' + mode + ' | ' +
  'host=' + TARGET.host + ' port=' + TARGET.port +
  ' user=' + TARGET.user + ' db=' + TARGET.database
);

// ── 4. Pool (field eksplisit, tanpa connectionString) ──────────────────────
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
  console.log(LOG_PREFIX + ' pool.options terverifikasi.');
}

/** Tutup pool lalu exit (terpusat; satu-satunya jalur penutup pool). */
async function exitWith(code) {
  await pool.end().catch(() => {});
  process.exit(code);
}

// ── 5. Verifikasi identitas server (equality EXACT, sebelum mutasi) ────────
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
    LOG_PREFIX + ' Identitas terverifikasi: db=' + db + ' user=' + usr +
    ' server=' + (row.srv_host ?? 'n/a') + ':' + (row.srv_port ?? 'n/a')
  );
}

// ── 6. Baca & validasi source SQL authoritative ────────────────────────────
function loadSourceSql() {
  let sql;
  try {
    sql = fs.readFileSync(SOURCE_SQL_PATH, 'utf8');
  } catch (err) {
    throw new Error(
      'Gagal membaca source SQL: ' + SOURCE_SQL_PATH +
      ' - ' + err.message
    );
  }

  // ── Guard: statement yang DIIZINKAN hanya CREATE TABLE IF NOT EXISTS
  //    dan CREATE INDEX IF NOT EXISTS.
  //    Rejected (fail): DROP TABLE, DROP COLUMN, TRUNCATE, DELETE FROM,
  //    UPDATE...SET, INSERT INTO, ALTER TABLE.
  const forbiddenPatterns = [
    { regex: /DROP\s+TABLE/i,  label: 'DROP TABLE' },
    { regex: /DROP\s+COLUMN/i, label: 'DROP COLUMN' },
    { regex: /TRUNCATE/i,      label: 'TRUNCATE' },
    { regex: /DELETE\s+FROM/i, label: 'DELETE FROM' },
    { regex: /UPDATE\s+\w+\s+SET/i, label: 'UPDATE ... SET' },
    { regex: /INSERT\s+INTO/i, label: 'INSERT INTO' },
    { regex: /ALTER\s+TABLE/i, label: 'ALTER TABLE' },
  ];

  for (const { regex, label } of forbiddenPatterns) {
    if (regex.test(sql)) {
      throw new Error(
        'Source SQL mengandung statement yang TIDAK diizinkan: ' + label +
        '. Ditolak - hanya CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS yang dibenarkan.'
      );
    }
  }

  // ── Guard: harus ada CREATE TABLE IF NOT EXISTS property_payment_instructions
  if (!/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+property_payment_instructions/i.test(sql)) {
    throw new Error(
      'Source SQL tidak mengandung CREATE TABLE IF NOT EXISTS property_payment_instructions.'
    );
  }

  // ── Guard: harus ada CREATE INDEX IF NOT EXISTS idx_property_payment_instructions_property
  if (!/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_property_payment_instructions_property/i.test(sql)) {
    throw new Error(
      'Source SQL tidak mengandung CREATE INDEX IF NOT EXISTS idx_property_payment_instructions_property.'
    );
  }

  // Tidak boleh ada statement selain dua CREATE IF NOT EXISTS di atas.
  // Hitung statement (di luar komentar) dan pastikan hanya dua.
  // Strip single-line comments (-- sampai akhir baris) untuk hitung yang akurat.
  const stripped = sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
  const statements = stripped
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (statements.length !== 2) {
    throw new Error(
      'Source SQL mengandung ' + statements.length +
      ' statement; harus PERSIS 2 (CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS).'
    );
  }

  return sql;
}

// ── 7. Verifier struktur lengkap property_payment_instructions ─────────────
// Authority: pg_catalog (pg_class, pg_namespace, pg_attribute, pg_type,
// pg_attrdef, pg_constraint, pg_index).
//
// information_schema TIDAK digunakan untuk authority structural checks karena
// visibility filtering dapat memberi false-negative pada role runner staging.
// READ ONLY. Tidak ada DDL.

const EXPECTED_COLUMNS = [
  { name: 'id',                 udt: 'int4',    nullable: false, check: 'serialDefault' },
  { name: 'property_id',        udt: 'int4',    nullable: false, check: 'plain' },
  { name: 'bank_name',          udt: 'varchar', nullable: true,  maxLen: 100 },
  { name: 'bank_account_name',  udt: 'varchar', nullable: true,  maxLen: 150 },
  { name: 'bank_account_number', udt: 'varchar', nullable: true,  maxLen: 100 },
  { name: 'bank_branch',        udt: 'varchar', nullable: true,  maxLen: 100 },
  { name: 'payment_note',       udt: 'text',    nullable: true },
  { name: 'is_active',          udt: 'bool',    nullable: false, defaultVal: 'true' },
  { name: 'created_at',         udt: 'timestamp', nullable: true, check: 'currentTimestampDefault' },
  { name: 'updated_at',         udt: 'timestamp', nullable: true, check: 'currentTimestampDefault' },
  { name: 'updated_by',         udt: 'varchar', nullable: true,  maxLen: 100 },
];

async function verifyPpiStructure(client) {
  const errors = [];

  // ── 7a. Tabel harus ada (pg_catalog authoritative; relkind r=table, p=partitioned table)
  const tblRes = await client.query(
    `SELECT c.oid, c.relkind
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'property_payment_instructions'`
  );
  if ((tblRes.rowCount ?? 0) === 0) {
    return { ok: false, tableExists: false, errors: ['Tabel public.property_payment_instructions tidak ditemukan (pg_class).'], };
  }
  // Nama relation ada tetapi relkind bukan r/p → bukan tabel biasa/partitioned
  const relkind = String(tblRes.rows[0].relkind);
  if (relkind !== 'r' && relkind !== 'p') {
    return {
      ok: false,
      tableExists: true,
      errors: [
        'Relation "property_payment_instructions" ada tetapi relkind="' + relkind +
        '" - bukan tabel (relkind harap \'r\' table atau \'p\' partitioned). ' +
        'Verifier TIDAK melanjutkan. Diagnosis manual diperlukan.'
      ],
    };
  }

  // ── 7b. Kolom: periksa semua sekaligus (pg_attribute + pg_type + pg_attrdef)
  const colRes = await client.query(
    `SELECT a.attname AS column_name,
            t.typname AS udt_name,
            CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
            CASE WHEN t.typname IN ('varchar','bpchar') AND a.atttypmod > 4
                 THEN a.atttypmod - 4 ELSE NULL
            END AS character_maximum_length,
            CASE t.typname
              WHEN 'int4'      THEN 'integer'
              WHEN 'varchar'   THEN 'character varying'
              WHEN 'text'      THEN 'text'
              WHEN 'bool'      THEN 'boolean'
              WHEN 'timestamp' THEN 'timestamp without time zone'
              ELSE t.typname
            END AS data_type,
            pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
            a.attnum AS ordinal_position
     FROM pg_attribute a
     JOIN pg_class c     ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_type t     ON t.oid = a.atttypid
     LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
     WHERE n.nspname = 'public'
       AND c.relname = 'property_payment_instructions'
       AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY a.attnum`
  );
  const colMap = {};
  for (const r of colRes.rows) {
    colMap[r.column_name] = r;
  }

  for (const exp of EXPECTED_COLUMNS) {
    const col = colMap[exp.name];
    if (!col) {
      errors.push('Kolom ' + exp.name + ' tidak ditemukan.');
      continue;
    }
    // Type
    const udt = col.udt_name || '';
    const dt  = col.data_type || '';
    let typeOk = false;
    if (exp.udt === 'int4') {
      typeOk = (udt === 'int4' || dt === 'integer');
    } else if (exp.udt === 'varchar') {
      typeOk = (udt === 'varchar' || dt === 'character varying');
    } else if (exp.udt === 'text') {
      typeOk = (udt === 'text' || dt === 'text');
    } else if (exp.udt === 'bool') {
      typeOk = (udt === 'bool' || dt === 'boolean');
    } else if (exp.udt === 'timestamp') {
      typeOk = (udt === 'timestamp' || dt === 'timestamp without time zone' || udt === 'timestamp without time zone');
    }
    if (!typeOk) {
      errors.push('Kolom ' + exp.name + ': type="' + udt + '/' + dt + '", ekspektasi sesuai ' + exp.udt);
    }

    // Nullable
    const expectedNullable = exp.nullable ? 'YES' : 'NO';
    if (col.is_nullable !== expectedNullable) {
      errors.push('Kolom ' + exp.name + ': nullable="' + col.is_nullable + '", ekspektasi ' + expectedNullable);
    }

    // Varchar max length
    if (exp.maxLen !== undefined) {
      const maxLen = col.character_maximum_length;
      if (Number(maxLen) !== exp.maxLen) {
        errors.push('Kolom ' + exp.name + ': max_len=' + maxLen + ', ekspektasi ' + exp.maxLen);
      }
    }

    // Default checks
    if (exp.check === 'serialDefault') {
      const def = String(col.column_default ?? '').trim().toLowerCase();
      // SERIAL → nextval('property_payment_instructions_id_seq'::regclass)
      const isSerial = def.includes('nextval') && def.includes('_id_seq');
      if (!isSerial) {
        errors.push('Kolom id: default="' + (col.column_default ?? '(none)') + '", ekspektasi nextval (serial)');
      }
    } else if (exp.check === 'currentTimestampDefault') {
      const def = String(col.column_default ?? '').trim().toLowerCase();
      if (def !== 'now()' && def !== 'current_timestamp') {
        errors.push('Kolom ' + exp.name + ': default="' + (col.column_default ?? '(none)') + '", ekspektasi CURRENT_TIMESTAMP/now()');
      }
    }

    // Boolean default
    if (exp.defaultVal !== undefined) {
      const def = String(col.column_default ?? '').trim().toLowerCase();
      if (def !== exp.defaultVal) {
        errors.push('Kolom ' + exp.name + ': default="' + def + '", ekspektasi ' + exp.defaultVal);
      }
    }
  }

  // ── 7c. PRIMARY KEY
  const pkRes = await client.query(
    `SELECT a.attname AS column_name
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
     WHERE n.nspname = 'public'
       AND c.relname = 'property_payment_instructions'
       AND i.indisprimary`
  );
  const pkCols = pkRes.rows.map((r) => r.column_name);
  if (pkCols.length !== 1 || pkCols[0] !== 'id') {
    errors.push('PRIMARY KEY: ' + JSON.stringify(pkCols) + ', ekspektasi ["id"]');
  }

  // ── 7d. UNIQUE constraint pada property_id
  const uqRes = await client.query(
    `SELECT c.conname,
            (SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
             FROM unnest(c.conkey) AS k(attnum)
             JOIN pg_attribute a ON a.attnum = k.attnum AND a.attrelid = c.conrelid) AS columns
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'property_payment_instructions'
       AND c.contype = 'u'`
  );
  const uniqueOnProperty = uqRes.rows.find(
    (r) => String(r.columns) === 'property_id'
  );
  if (!uniqueOnProperty) {
    errors.push('UNIQUE constraint pada property_id tidak ditemukan.');
  }

  // ── 7e. FOREIGN KEY property_id → properties(id) ON DELETE CASCADE
  const fkRes = await client.query(
    `SELECT c.conname, c.confdeltype,
            (SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
             FROM unnest(c.conkey) AS k(attnum)
             JOIN pg_attribute a ON a.attnum = k.attnum AND a.attrelid = c.conrelid) AS local_cols,
            t2.relname AS ref_table,
            (SELECT string_agg(a2.attname, ',' ORDER BY a2.attnum)
             FROM unnest(c.confkey) AS k2(attnum)
             JOIN pg_attribute a2 ON a2.attnum = k2.attnum AND a2.attrelid = c.confrelid) AS ref_cols
     FROM pg_constraint c
     JOIN pg_class t  ON t.oid  = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     JOIN pg_class t2 ON t2.oid = c.confrelid
     WHERE n.nspname = 'public'
       AND t.relname = 'property_payment_instructions'
       AND c.contype = 'f'`
  );
  const fkRow = fkRes.rows.find(
    (r) => r.ref_table === 'properties'
       && String(r.local_cols) === 'property_id'
       && String(r.ref_cols)   === 'id'
       && r.confdeltype        === 'c'
  );
  if (!fkRow) {
    // Diagnostic: tampilkan semua FK yang ada agar jelas mana yang tidak cocok
    const fkDesc = fkRes.rows.map((r) =>
      'FK[' + r.conname + ']: ' + r.local_cols + ' → ' +
      r.ref_table + '(' + r.ref_cols + ') on_delete=' + r.confdeltype
    ).join('; ');
    errors.push(
      'FOREIGN KEY property_id → properties(id) ON DELETE CASCADE tidak ditemukan. ' +
      'FK yang ada: ' + (fkDesc || '(none)')
    );
  }

  // ── 7f. Index idx_property_payment_instructions_property
  // Memastikan:
  //   - schema public
  //   - index name exact
  //   - target table exact: property_payment_instructions
  //   - indisvalid + indisready = true
  //   - kolom persis property_id (bukan expression index)
  const idxRes = await client.query(
    `SELECT c.relname AS index_name,
            c2.relname AS table_name,
            x.indisvalid, x.indisready,
            x.indnatts,
            x.indexprs IS NOT NULL AS has_expression,
            (SELECT string_agg(a.attname, ',' ORDER BY u.ord)
             FROM unnest(x.indkey) WITH ORDINALITY AS u(attnum, ord)
             JOIN pg_attribute a ON a.attnum = u.attnum AND a.attrelid = x.indrelid
             WHERE u.attnum <> 0) AS columns
     FROM pg_index x
     JOIN pg_class c  ON c.oid  = x.indexrelid
     JOIN pg_class c2 ON c2.oid = x.indrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'idx_property_payment_instructions_property'`
  );
  if ((idxRes.rowCount ?? 0) !== 1) {
    errors.push('Index idx_property_payment_instructions_property: tidak ditemukan atau ada duplikat.');
  } else {
    const idxRow = idxRes.rows[0];

    // Target table harus persis property_payment_instructions
    if (idxRow.table_name !== 'property_payment_instructions') {
      errors.push(
        'Index idx_property_payment_instructions_property terpasang pada table "' +
        idxRow.table_name + '", ekspektasi "property_payment_instructions".'
      );
    }

    if (idxRow.indisvalid !== true || idxRow.indisready !== true) {
      errors.push('Index idx_property_payment_instructions_property: valid=' +
        idxRow.indisvalid + ' ready=' + idxRow.indisready + ', ekspektasi true/true.');
    }

    // Bukan expression index
    if (idxRow.has_expression !== false) {
      errors.push(
        'Index idx_property_payment_instructions_property: expression index terdeteksi, ' +
        'ekspektasi index biasa pada kolom property_id.'
      );
    }

    // Jumlah kolom: harus persis 1
    if (Number(idxRow.indnatts) !== 1) {
      errors.push(
        'Index idx_property_payment_instructions_property: indnatts=' +
        idxRow.indnatts + ', ekspektasi 1 (hanya property_id).'
      );
    }

    const cols = String(idxRow.columns || '');
    if (cols !== 'property_id') {
      errors.push('Index idx_property_payment_instructions_property: columns="' + cols + '", ekspektasi "property_id".');
    }
  }

  return { ok: errors.length === 0, tableExists: true, errors };
}

// ── 8. Cek keberadaan struktur dasar (read-only, via pg_catalog authoritative)
// Dipakai untuk membedakan READY_TO_APPLY vs PARTIAL sebelum verifier penuh.
// information_schema sengaja tidak digunakan karena visibility filtering dapat
// memberi false-negative pada role runner staging.
async function checkBasicStructuralState(client) {
  // Tabel ada? (pg_class authoritative; hanya relkind r/p dianggap tabel)
  const tblRes = await client.query(
    `SELECT c.oid FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'property_payment_instructions'
       AND c.relkind IN ('r','p')`
  );
  const tableExists = (tblRes.rowCount ?? 0) > 0;

  // Index: pakai pg_class + pg_index + pg_namespace (semantic sama dengan pg_indexes,
  // tetapi lebih authoritative dan konsisten dengan pg_catalog authority).
  // Ambil indexname + tablename untuk membedakan target vs foreign.
  const idxRes = await client.query(
    `SELECT ic.relname AS indexname,
            tc.relname AS tablename
     FROM pg_class ic
     JOIN pg_namespace ins ON ins.oid = ic.relnamespace
     JOIN pg_index ix ON ix.indexrelid = ic.oid
     JOIN pg_class tc ON tc.oid = ix.indrelid
     WHERE ins.nspname = 'public'
       AND ic.relname  = 'idx_property_payment_instructions_property'`
  );

  // targetIndexExists: index dengan nama exact DAN tablename = 'property_payment_instructions'
  const targetIndexExists = idxRes.rows.some(
    (r) => r.tablename === 'property_payment_instructions'
  );

  // foreignIndexConflicts: row dengan nama index exact tetapi tablename BUKAN target
  const foreignIndexConflicts = idxRes.rows
    .filter((r) => r.tablename !== 'property_payment_instructions')
    .map((r) => r.tablename);

  return { tableExists, targetIndexExists, foreignIndexConflicts };
}

// ── 9. Mode: --check (read-only) ────────────────────────────────────────────
// Mengembalikan state string; semua kegagalan di-throw (bukan process.exit).
async function runCheck() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');

    // Prerequisite: public.properties harus ada (pg_catalog authoritative)
    const propRes = await client.query(
      `SELECT c.oid FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = 'properties'
         AND c.relkind IN ('r','p')`
    );
    if ((propRes.rowCount ?? 0) === 0) {
      throw new Error('Prerequisite: tabel public.properties tidak ditemukan.');
    }
    console.log(LOG_PREFIX + ' [CHECK] Prerequisite properties: ada.');

    // State dasar
    const state = await checkBasicStructuralState(client);

    // FOREIGN_INDEX_NAME_CONFLICT: index nama exact dimiliki tabel lain → fail
    if (state.foreignIndexConflicts.length > 0) {
      console.error(
        LOG_PREFIX + ' [CHECK] FOREIGN_INDEX_NAME_CONFLICT - index ' +
        'idx_property_payment_instructions_property ditemukan pada tabel: ' +
        JSON.stringify(state.foreignIndexConflicts) +
        '. TIDAK AMAN untuk apply.'
      );
      throw new Error(
        'FOREIGN_INDEX_NAME_CONFLICT - index idx_property_payment_instructions_property ' +
        'dimiliki oleh tabel lain: ' + JSON.stringify(state.foreignIndexConflicts) +
        '. Tidak boleh apply. Diagnosis manual diperlukan.'
      );
    }

    // State A: tabel TIDAK ADA + targetIndex TIDAK ADA + foreign kosong → READY_TO_APPLY
    if (!state.tableExists && !state.targetIndexExists) {
      console.log(LOG_PREFIX + ' [CHECK] State: READY_TO_APPLY.');
      await client.query('COMMIT');
      return 'READY_TO_APPLY';
    }

    // State C: tabel TIDAK ADA tetapi targetIndex ADA → PARTIAL (fail-closed)
    if (!state.tableExists && state.targetIndexExists) {
      console.error(LOG_PREFIX + ' [CHECK] State: index target ada tetapi tabel TIDAK ada.');
      throw new Error(
        'PARTIAL_OR_MISMATCHED_SCHEMA - index idx_property_payment_instructions_property ada ' +
        'pada tabel property_payment_instructions tetapi tabel tidak ada di katalog. ' +
        'Kondisi anomali - TIDAK AMAN untuk apply. Diagnosis manual diperlukan.'
      );
    }

    // State D: tabel ADA → jalankan verifier struktur lengkap
    const verify = await verifyPpiStructure(client);
    if (verify.ok) {
      console.log(LOG_PREFIX + ' [CHECK] State: ALREADY_APPLIED - seluruh struktur lengkap.');
      await client.query('COMMIT');
      return 'ALREADY_APPLIED';
    }

    // Tabel ada tetapi verifier gagal
    for (const e of verify.errors) console.error(LOG_PREFIX + ' [CHECK] GAGAL: ' + e);
    throw new Error(
      'PARTIAL_OR_MISMATCHED_SCHEMA - tabel ada tetapi verifikasi struktur gagal. ' +
      'Diagnosis manual diperlukan - TIDAK AMAN untuk apply.'
    );
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* transaksi sudah berakhir */ }
    throw err;
  } finally {
    client.release();
  }
}

// ── 10. Mode: --apply ───────────────────────────────────────────────────────
async function runApply() {
  // 1) Validasi source SQL SEBELUM koneksi mutasi
  const sourceSql = loadSourceSql();
  console.log(LOG_PREFIX + ' [APPLY] Source SQL terduga & divalidasi. ' +
    'File: ' + SOURCE_SQL_PATH);

  const client = await pool.connect();
  let txnActive = false;

  try {
    // 2) Cek state dasar SEBELUM mutasi
    const state = await checkBasicStructuralState(client);

    // FOREIGN_INDEX_NAME_CONFLICT: fail-closed, jangan eksekusi DDL
    if (state.foreignIndexConflicts.length > 0) {
      throw new Error(
        'FOREIGN_INDEX_NAME_CONFLICT - index idx_property_payment_instructions_property ' +
        'dimiliki oleh tabel lain: ' + JSON.stringify(state.foreignIndexConflicts) +
        '. TIDAK AMAN untuk apply DDL. Diagnosis manual diperlukan.'
      );
    }

    if (state.tableExists) {
      // Tabel ada: jalankan verifier
      const verify = await verifyPpiStructure(client);
      if (verify.ok) {
        console.log(LOG_PREFIX + ' [APPLY] ALREADY_APPLIED - tabel + seluruh struktur sudah lengkap.');
        return;
      }
      for (const e of verify.errors) console.error(LOG_PREFIX + ' [APPLY] GAGAL: ' + e);
      throw new Error(
        'PARTIAL_OR_MISMATCHED_SCHEMA - tabel ada tetapi struktur tidak lengkap. ' +
        'TIDAK AMAN untuk apply DDL. Diagnosis manual diperlukan.'
      );
    }

    // Tabel tidak ada + targetIndex ada → anomali, fail-closed
    if (state.targetIndexExists && !state.tableExists) {
      throw new Error(
        'PARTIAL_OR_MISMATCHED_SCHEMA - index target ada pada property_payment_instructions ' +
        'tetapi tabel tidak ada di katalog. TIDAK AMAN untuk apply. Diagnosis manual diperlukan.'
      );
    }

    // 3) READY_TO_APPLY: jalankan DDL dalam transaksi
    await client.query('BEGIN');
    txnActive = true;

    // Advisory lock: sama dengan pola migration lain
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('oak_hims_schema_migrations_lock'))"
    );

    // Eksekusi source SQL authoritative
    await client.query(sourceSql);
    console.log(LOG_PREFIX + ' [APPLY] DDL dieksekusi.');

    // Verifikasi struktur setelah DDL
    const verify = await verifyPpiStructure(client);
    if (!verify.ok) {
      for (const e of verify.errors) console.error(LOG_PREFIX + ' [APPLY] VERIFIER GAGAL: ' + e);
      throw new Error('Verifier struktur gagal setelah DDL - ROLLBACK.');
    }

    await client.query('COMMIT');
    txnActive = false;
    console.log(LOG_PREFIX + ' [APPLY] APPLIED - seluruh struktur terverifikasi.');
  } catch (err) {
    if (txnActive) {
      try {
        await client.query('ROLLBACK');
      } catch (rbErr) {
        throw new Error('ROLLBACK gagal setelah ' + err.message + ': ' + rbErr.message);
      }
    }
    throw err;
  } finally {
    client.release();
  }
}

// ── 10b. Mode: --diagnose (read-only, diagnostik katalog PG authoritative) ──
// Hanya SELECT. Tidak pernah menjalankan source SQL / migration / DDL.
// Digunakan untuk mendiagnosis anomali staging di mana informasi_schema.tables
// mengatakan tabel TIDAK ADA tetapi pg_indexes/index katalog mengatakan index ada.
async function runDiagnose() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');

    // ── A. to_regclass ──
    const regRes = await client.query(
      `SELECT
         to_regclass('public.property_payment_instructions')::text AS table_regclass,
         to_regclass('public.idx_property_payment_instructions_property')::text AS index_regclass`
    );
    console.log(LOG_PREFIX + ' [DIAGNOSE A: to_regclass]');
    console.log(JSON.stringify(regRes.rows));

    // ── B. pg_class untuk nama tabel ──
    const clsRes = await client.query(
      `SELECT
         c.oid,
         n.nspname AS schema_name,
         c.relname,
         c.relkind,
         c.relpersistence,
         pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = 'property_payment_instructions'`
    );
    console.log(LOG_PREFIX + ' [DIAGNOSE B: pg_class tabel property_payment_instructions]');
    console.log(JSON.stringify(clsRes.rows));

    // ── C. information_schema.tables exact ──
    const isRes = await client.query(
      `SELECT table_schema, table_name, table_type
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name   = 'property_payment_instructions'`
    );
    console.log(LOG_PREFIX + ' [DIAGNOSE C: information_schema.tables]');
    console.log(JSON.stringify(isRes.rows));

    // ── D. index relation authoritative ──
    const idxRes = await client.query(
      `SELECT
         idx.oid AS index_oid,
         ns.nspname AS index_schema,
         idx.relname AS index_name,
         idx.relkind AS index_relkind,
         tbl.oid AS table_oid,
         tns.nspname AS table_schema,
         tbl.relname AS table_name,
         tbl.relkind AS table_relkind,
         i.indisvalid,
         i.indisready,
         i.indislive,
         pg_get_indexdef(idx.oid) AS indexdef
       FROM pg_class idx
       JOIN pg_namespace ns ON ns.oid = idx.relnamespace
       JOIN pg_index i ON i.indexrelid = idx.oid
       JOIN pg_class tbl ON tbl.oid = i.indrelid
       JOIN pg_namespace tns ON tns.oid = tbl.relnamespace
       WHERE ns.nspname = 'public'
         AND idx.relname = 'idx_property_payment_instructions_property'`
    );
    console.log(LOG_PREFIX + ' [DIAGNOSE D: index relation authoritative]');
    console.log(JSON.stringify(idxRes.rows));

    // ── E. inheritance / partition relation ──
    const inhRes = await client.query(
      `SELECT
         child.oid AS child_oid,
         child.relname AS child_name,
         parent.oid AS parent_oid,
         parent.relname AS parent_name
       FROM pg_inherits inh
       JOIN pg_class child ON child.oid = inh.inhrelid
       JOIN pg_class parent ON parent.oid = inh.inhparent
       WHERE child.relname = 'property_payment_instructions'
          OR parent.relname = 'property_payment_instructions'`
    );
    console.log(LOG_PREFIX + ' [DIAGNOSE E: inheritance/partition relation]');
    console.log(JSON.stringify(inhRes.rows));

    await client.query('COMMIT');
    console.log(LOG_PREFIX + ' [DIAGNOSE] Selesai - semua query read-only.');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* transaksi sudah berakhir */ }
    throw err;
  } finally {
    client.release();
  }
}

// ── 11. Main: semua kegagalan di-throw; penutupan pool terpusat ────────────
async function run() {
  verifyPoolOptions();
  await verifyIdentity();

  if (mode === 'check') {
    const state = await runCheck();
    console.log(LOG_PREFIX + ' --check selesai: ' + state + '.');
    return;
  }

  if (mode === 'diagnose') {
    await runDiagnose();
    return;
  }

  // mode === 'apply'
  await runApply();
}

run()
  .then(async () => { await exitWith(0); })
  .catch(async (err) => {
    console.error(LOG_PREFIX + ' GAGAL: ' + ((err && err.message) || err));
    await exitWith(1);
  });

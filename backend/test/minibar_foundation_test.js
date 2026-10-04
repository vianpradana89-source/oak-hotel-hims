/**
 * MINIBAR HK BILLING — Foundation Test (Tahap A)
 *
 * DB safety guard (diikuti pola repo: DB disposable *_test wajib eksplisit):
 * - Membaca TEST_DATABASE_URL (env eksplisit); tanpa fallback DB_/PG_/.env.
 * - Menolak DB tanpa 'test' atau mengandung production|prod|live|staging.
 * - TIDAK mencetak URL lengkap / password (hanya nama DB hasil parsing).
 * - Memverifikasi identitas koneksi (current_database) SEBELUM mutasi apa pun.
 *
 * Prasyarat bootstrap (DB disposable DIBUAT BARU, bukan shared):
 *   DB harus berisi skema master (properties, room_types, rooms,
 *   reservations, housekeeping_tasks, pos_menu_items, folio_entries,
 *   checklist_template_items, housekeeping_task_checklist_items,
 *   schema_migrations) — dibuat dengan runner skema master repo —
 *   namun TIDAK boleh berisi tabel minibar / marker 'minibar_hk_billing_v1'
 *   yang sudah ada. Test akan menolak DB yang sudah ter-bootstrap minibar
 *   karena cakupan TEST 1 (fresh migration) membutuhkan DDL yang benar-benar
 *   pertama.
 *
 * Cakupan (sesuai kontrak Tahap A, selaras DDL minibar_hk_billing_v1.ts):
 *  1. Fresh migration (DDL baru) + marker tertulis
 *     — bila GAGAL: test berhenti dengan error migration; suite yang
 *     membutuhkan schema tidak dijalankan (hanya cleanup).
 *  2. Rerun idempoten (marker ada, DDL tidak dijalankan ulang)
 *  3. Marker hilang → DDL ulang + marker kembali
 *  4. Rollback jalur "marker belum ada": verifikasi DDL gagal → ROLLBACK
 *     membuktikan TIDAK ADA tabel DDL yang dibuat + TIDAK ADA marker
 *     (status 'verification-failed'); berbeda dari mismatch marker existing.
 *  5. Marker ada tetapi schema mismatch → ok=false + ROLLBACK; recovery
 *  6. Constraint valid/invalid melalui INSERT aktual (assert SQLSTATE +
 *     nama constraint yang memang ditargetkan; INSERT negatif memenuhi
 *     constraint lain)
 *  7. Baseline range: anchor + event dalam/luar scope & rentang (anchor,
 *     cutoff] (helper filterBaselineRange/calcBaselineEffective)
 *  8. Baseline DB: beberapa record per scope sah (tanpa UNIQUE per scope)
 *  9. Residu = 0 (fixture dibersihkan, baik sukses maupun gagal; error
 *     cleanup/residu membuat test gagal)
 *
 * Run (hanya DB disposable *_test):
 *   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/<nama_..._test> \
 *   node backend/test/minibar_foundation_test.js
 */

'use strict';

// ─── DB SAFETY GUARD ──────────────────────────────────────────────────────────
const testUrl = process.env.TEST_DATABASE_URL;

if (!testUrl || !testUrl.trim()) {
  console.error(
    'SAFETY: TEST_DATABASE_URL tidak di-set.\n' +
    'Jalankan: TEST_DATABASE_URL=postgres://USER:PASS@localhost:PORT/<db>_test ' +
    'node backend/test/minibar_foundation_test.js'
  );
  process.exit(1);
}

const FORBIDDEN = ['staging', 'production', 'prod', 'live'];
/** Parameter query URL yang diterima; selain ini DITOLAK (tidak diabaikan). */
const SUPPORTED_QUERY_PARAMS = ['sslmode'];
let target; // { host, port, user, database, password }
try {
  const u = new URL(testUrl.trim());
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new Error('protocol URL wajib postgres:// atau postgresql://');
  }
  if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
    throw new Error(`host wajib localhost/127.0.0.1 (diterima: ${u.hostname})`);
  }
  if (!u.port || !/^\d+$/.test(u.port)) {
    throw new Error('port eksplisit wajib dalam URL');
  }
  // Tolak query parameter yang tidak didukung — JANGAN diabaikan diam-diam.
  const unsupportedParams = [];
  for (const key of u.searchParams.keys()) {
    if (!SUPPORTED_QUERY_PARAMS.includes(key.toLowerCase())) unsupportedParams.push(key);
  }
  if (unsupportedParams.length) {
    throw new Error(
      `query parameter tidak didukung: ${unsupportedParams.join(', ')} ` +
      `(yang didukung: ${SUPPORTED_QUERY_PARAMS.join(', ')})`
    );
  }
  const user = u.username ? decodeURIComponent(u.username) : '';
  const password = u.password ? decodeURIComponent(u.password) : '';
  const database = u.pathname ? decodeURIComponent(u.pathname.replace(/^\//, '')) : '';
  if (!user) throw new Error('user wajib lengkap dalam URL (tanpa fallback PGUSER/DB_*)');
  if (!password) throw new Error('password wajib lengkap dalam URL (tanpa fallback PGPASSWORD/DB_*)');
  const dbLower = database.toLowerCase();
  if (!/^[a-z0-9_]+_test$/.test(dbLower)) {
    throw new Error(`database wajib berakhiran "_test" (diterima: ${database})`);
  }
  if (FORBIDDEN.some((p) => dbLower.includes(p) || user.toLowerCase().includes(p))) {
    throw new Error('indikator staging/production/live terdeteksi pada database/user');
  }
  target = { host: u.hostname, port: Number(u.port), user, database, password };
  console.log(`[MINIBAR FOUNDATION TEST] Disposable DB target: ${database} (user: ${user})`);
} catch (e) {
  console.error('SAFETY: TEST_DATABASE_URL ditolak — ' + e.message + '. DITOLAK.');
  process.exit(1);
}

// ─── IMPORTS ──────────────────────────────────────────────────────────────────
const { Pool } = require('pg');

// Pool dari field eksplisit hasil parse URL (bukan connectionString): field
// yang hilang tidak mengambil fallback PG*/DB*/.env.
const pool = new Pool({
  host: target.host,
  port: target.port,
  user: target.user,
  database: target.database,
  password: target.password,
});

// ─── TEST STATE ────────────────────────────────────────────��──────────────────
let passed = 0;
let failed = 0;
const errors = [];
const tracked = {
  propertyIds: [],
  roomTypeIds: [],
  roomIds: [],
  reservationIds: [],
  bookingIds: [],
  taskIds: [],
  folioIds: [],
  menuItemIds: [],
  stdIds: [],
  baselineIds: [],
  eventIds: [],
  reportIds: [],
  lineIds: [],
  confIds: [],
};

function expect(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  PASS | ${msg}`);
  } else {
    failed++;
    errors.push(msg);
    console.error(`  FAIL | ${msg}`);
  }
}

/** Flag: bila ada, test wajib gagal (digunakan untuk error cleanup). */
let cleanupFailed = false;

/** Flag: fresh migration gagal → hentikan suite yang membutuhkan schema. */
let freshFailed = false;

/**
 * Assert INSERT ditolak: cek ok=false, SQLSTATE, dan (bila diberi)
 * nama constraint yang memang ditargetkan. Pesan pg:
 * "violates \"<conname>\" (relation <table>)" atau
 * "violates check constraint \"<conname>\"" (beberapa jalur) —
 * kita ambil constraintName dari detail pg saat tersedia.
 */
async function tryInsert(sql, params) {
  try {
    await api(sql, params);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e.code, conname: e.constraint || '', message: e.message };
  }
}

/** Assert ditolak: SQLSTATE + conname target (wajib bila diberikan). */
function expectRejected(res, sqlstate, conname, msg) {
  const cond = !res.ok && res.code === sqlstate && (conname === null || res.conname === conname);
  expect(
    cond,
    `${msg} — got SQLSTATE=${res.code ?? 'n/a'} constraint=${res.conname || '(pg tidak menyertakan; FK/PK)'}`
  );
}

async function api(sql, params) {
  return pool.query(sql, params);
}

// ─── HELPERS ───────────────────────────────────────────────────────────────────

/** Suffix unik per run (idempoten terhadap rerun di DB disposable). */
const RUN = Date.now().toString(36).toUpperCase();
let seq = 0;
function uniq(prefix) {
  seq += 1;
  return `${prefix}_${RUN}_${seq}`;
}

/**
 * property_code UNIQUE VARCHAR(6) CHECK ^[A-Z0-9]{2,6}$
 * RUN = Date.now().toString(36).toUpperCase() menghasilkan 7–8 karakter,
 * jadi JANGAN memotong prefix sama untuk beberapa property dalam satu run
 * (bisa tabrakan UNIQUE). Setiap property dapat 6 karakter berbeda dari
 * hash (FNV-1a base36) dari prefix+seq → deterministik & unik per run.
 */
function fnvBase36(input) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let rem = h >>> 0;
  let s = '';
  do {
    s = alphabet[rem % alphabet.length] + s;
    rem = Math.floor(rem / alphabet.length);
  } while (rem > 0);
  return s;
}

function makePropertyCode(prefix) {
  return ('MB' + fnvBase36(prefix + '_' + RUN)).slice(0, 6).toUpperCase();
}

async function createTestProperty() {
  const prefix = `prop_${seq++}`;
  const code = makePropertyCode(prefix);
  const r = await api(
    `INSERT INTO properties (name, property_code, address, is_active)
     VALUES ($1, $2, 'Minibar Foundation Test', TRUE) RETURNING id`,
    [uniq('Prop'), code]
  );
  const pid = r.rows[0].id;
  tracked.propertyIds.push(pid);
  return pid;
}

async function createTestRoomType(propertyId) {
  const r = await api(
    `INSERT INTO room_types (property_id, name, code, base_rate)
     VALUES ($1, $2, $3, 0) RETURNING id`,
    [propertyId, uniq('RoomType'), uniq('RT').slice(0, 20)]
  );
  const id = r.rows[0].id;
  tracked.roomTypeIds.push(id);
  return id;
}

async function createTestRoom(propertyId) {
  // rooms (RM-1C): property_id nullable (FK), room_number VARCHAR(10),
  // UNIQUE index (property_id, room_number) bila property terisi.
  // Pembeda utuh: 2 char run + seq 2 digit = 4 char, dalam batas 10.
  const rn = `${RUN.slice(-2)}${String(seq).padStart(2, '0')}`.slice(0, 10);
  const r = await api(
    `INSERT INTO rooms (property_id, room_number, name, status)
     VALUES ($1, $2, $3, 'Ready') RETURNING id`,
    [propertyId, rn, uniq('Room')]
  );
  const id = r.rows[0].id;
  tracked.roomIds.push(id);
  return id;
}

async function createTestBooking(propertyId) {
  // bookings (schema aktual): kolom wajib NOT NULL tanpa default:
  //   bid (VARCHAR, CHECK ^[A-Z0-9-]+$), property_id, guest_name_snapshot
  // dengan default: booking_source, booking_status, currency_code,
  //   payment_responsibility, global_discount_value/amount/gross_before/net_after.
  // Bid unik: prefix MB + RUN (sudah huruf besar) + seq, sesuai format CHECK.
  const bid = `MB${RUN}${String(seq).padStart(2, '0')}`;
  const r = await api(
    `INSERT INTO bookings (bid, property_id, guest_name_snapshot)
     VALUES ($1, $2, $3) RETURNING id`,
    [bid, propertyId, 'Minibar Test Guest']
  );
  const id = r.rows[0].id;
  tracked.bookingIds.push(id);
  return id;
}

async function createTestReservation(propertyId, roomId) {
  // reservations (schema aktual): room_id FK nullable, booking_number UNIQUE,
  // booking_type DEFAULT 'WALKIN'. property_id tidak ada di tabel ini —
  // argumen propertyId dicatat hanya untuk dokumentasi scope, tetapi booking
  // fixture WAJIB berasal dari property yang sama agar koheren dengan room.
  const bookingId = await createTestBooking(propertyId);
  const r = await api(
    `INSERT INTO reservations (room_id, guest_name, booking_number, booking_type,
                               booking_id, stay_sequence)
     VALUES ($1, 'Minibar Test Guest', $2, 'WALKIN', $3, 1) RETURNING id`,
    [roomId, uniq('BK'), bookingId]
  );
  const id = r.rows[0].id;
  tracked.reservationIds.push(id);
  return id;
}

async function createTestTask(propertyId, roomNumber) {
  // housekeeping_tasks (skema aktual): room_number VARCHAR(10),
  // task_type valid = ROOM_CLEANING/STAYOVER_CLEANING/DEEP_CLEAN/
  //                  VIP_ROOM_PREPARATION/CHECKOUT_ROOM_CHECK,
  // status awal valid = PENDING.
  const r = await api(
    `INSERT INTO housekeeping_tasks (property_id, room_number, task_type, status)
     VALUES ($1, $2, 'ROOM_CLEANING', 'PENDING') RETURNING id`,
    [propertyId, roomNumber ? String(roomNumber).slice(0, 10) : '1']
  );
  const id = r.rows[0].id;
  tracked.taskIds.push(id);
  return id;
}

async function createTestMenuItem(propertyId) {
  const r = await api(
    `INSERT INTO pos_menu_items (property_id, name, price, is_active)
     VALUES ($1, $2, 15000, TRUE) RETURNING id`,
    [propertyId, uniq('Item')]
  );
  const id = r.rows[0].id;
  tracked.menuItemIds.push(id);
  return id;
}

async function cleanup() {
  // Tahan-gagal: setiap step dicoba meskipun step sebelumnya error;
  // semua error dikumpulkan → cleanupFailed = true (test gagal).
  const problems = [];
  const steps = [
    tracked.confIds.length
      ? { sql: `DELETE FROM minibar_billing_confirmation WHERE id = ANY($1)`, params: [tracked.confIds], label: 'minibar_billing_confirmation' }
      : null,
    tracked.confIds.length
      ? { sql: `DELETE FROM folio_entries WHERE minibar_confirmation_id = ANY($1)`, params: [tracked.confIds], label: 'folio_entries (FK minibar)' }
      : null,
    tracked.lineIds.length
      ? { sql: `DELETE FROM minibar_inspection_report_line WHERE id = ANY($1)`, params: [tracked.lineIds], label: 'minibar_inspection_report_line' }
      : null,
    tracked.reportIds.length
      ? { sql: `DELETE FROM minibar_inspection_report WHERE id = ANY($1)`, params: [tracked.reportIds], label: 'minibar_inspection_report' }
      : null,
    tracked.eventIds.length
      ? { sql: `DELETE FROM minibar_stay_event WHERE id = ANY($1)`, params: [tracked.eventIds], label: 'minibar_stay_event' }
      : null,
    tracked.baselineIds.length
      ? { sql: `DELETE FROM minibar_baseline_verification WHERE id = ANY($1)`, params: [tracked.baselineIds], label: 'minibar_baseline_verification' }
      : null,
    tracked.stdIds.length
      ? { sql: `DELETE FROM room_type_minibar_standard WHERE id = ANY($1)`, params: [tracked.stdIds], label: 'room_type_minibar_standard' }
      : null,
    tracked.taskIds.length
      ? { sql: `DELETE FROM housekeeping_tasks WHERE id = ANY($1)`, params: [tracked.taskIds], label: 'housekeeping_tasks' }
      : null,
    tracked.folioIds.length
      ? { sql: `DELETE FROM folio_entries WHERE id = ANY($1)`, params: [tracked.folioIds], label: 'folio_entries (fixture)' }
      : null,
    tracked.reservationIds.length
      ? { sql: `DELETE FROM reservations WHERE id = ANY($1)`, params: [tracked.reservationIds], label: 'reservations' }
      : null,
    tracked.bookingIds.length
      ? { sql: `DELETE FROM bookings WHERE id = ANY($1)`, params: [tracked.bookingIds], label: 'bookings' }
      : null,
    tracked.menuItemIds.length
      ? { sql: `DELETE FROM pos_menu_items WHERE id = ANY($1)`, params: [tracked.menuItemIds], label: 'pos_menu_items' }
      : null,
    tracked.roomIds.length
      ? { sql: `DELETE FROM rooms WHERE id = ANY($1)`, params: [tracked.roomIds], label: 'rooms' }
      : null,
    tracked.roomTypeIds.length
      ? { sql: `DELETE FROM room_types WHERE id = ANY($1)`, params: [tracked.roomTypeIds], label: 'room_types' }
      : null,
    tracked.propertyIds.length
      ? { sql: `DELETE FROM properties WHERE id = ANY($1)`, params: [tracked.propertyIds], label: 'properties' }
      : null,
  ].filter(Boolean);

  for (const s of steps) {
    try {
      await pool.query(s.sql, s.params);
    } catch (e) {
      problems.push(`${s.label}: ${e.message}`);
    }
  }
  if (problems.length) {
    cleanupFailed = true;
    for (const p of problems) console.error('  CLEANUP ERROR (' + p + ')');
  }
}

// ─── TEST SUITES ──────────────────────────────────────────────────────────────

/**
 * Verifikasi identitas koneksi SEBELUM mutasi apa pun:
 * 0) Cocokkan KONFIGURASI POOL (pool.options) dengan target tervalidasi:
 *    host/port/user/database harus persis — memverifikasi pool tidak
 *    mengambil fallback env di luar target.
 * 1) Probe alamat & port server (inet_server_addr, inet_server_port) —
 *    hanya dilaporkan, TIDAK dipaksa sama dengan host mapping URL
 *    (mapping Docker host→container sah).
 * 2) current_database harus = target.database dan tetap *_test.
 */
async function verifyConnectionIdentity() {
  // 0) Cocokkan konfigurasi pool dengan target tervalidasi (sebelum probe).
  const optMismatches = [
    ['host', pool.options.host, target.host],
    ['port', String(pool.options.port), String(target.port)],
    ['user', pool.options.user, target.user],
    ['database', pool.options.database, target.database],
  ].filter(([, a, b]) => String(a ?? '').toLowerCase() !== String(b ?? '').toLowerCase());
  for (const [field, got, want] of optMismatches) {
    throw new Error(`pool.options.${field}="${got}" != target "${want}" — pool tidak sesuai target.`);
  }

  // 1) Probe identitas server aktual.
  const r = await api(
    `SELECT current_database() AS db,
            current_user AS usr,
            inet_server_addr() AS srv_host,
            inet_server_port() AS srv_port`
  );
  const row = r.rows[0] || {};
  const db = (row.db ?? '').toLowerCase();
  const usr = (row.usr ?? '').toLowerCase();
  if (db !== target.database.toLowerCase()) {
    throw new Error(
      `current_database "${row.db}" != target "${target.database}" — koneksi tidak valid.`
    );
  }
  if (usr !== target.user.toLowerCase()) {
    throw new Error(`current_user "${row.usr}" != target user "${target.user}"`);
  }
  if (!/^[a-z0-9_]+_test$/.test(db)) {
    throw new Error(`current_database "${row.db}" bukan *_test — DITOLAK`);
  }
  if (FORBIDDEN.some((p) => db.includes(p))) {
    throw new Error(`current_database="${row.db}" terindikasi forbidden — DITOLAK`);
  }
  console.log(
    `Koneksi terverifikasi: db=${row.db} user=${row.usr} ` +
    `server=${row.srv_host || 'n/a'}:${row.srv_port ?? 'n/a'} ` +
    `(mapping URL ${target.host}:${target.port})`
  );
}

/** Precondition: skema master ada, tabel minibar belum ada. */
async function assertBootstrapPrecondition() {
  const masterTables = [
    'properties', 'room_types', 'rooms', 'reservations',
    'housekeeping_tasks', 'pos_menu_items', 'folio_entries',
    'checklist_template_items', 'housekeeping_task_checklist_items',
    'schema_migrations',
  ];
  for (const t of masterTables) {
    const r = await api(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
      [t]
    );
    if ((r.rowCount ?? 0) === 0) {
      throw new Error(
        `Skema master "${t}" tidak ada di DB test. Bootstrap DB disposable dengan ` +
        'runner skema master repo (bukan shared DB), tanpa tabel minibar.'
      );
    }
  }
  const mini = await api(
    `SELECT COUNT(*)::int AS cnt FROM information_schema.tables
     WHERE table_schema='public' AND table_name IN (
       'room_type_minibar_standard','minibar_baseline_verification','minibar_stay_event',
       'minibar_inspection_report','minibar_inspection_report_line','minibar_billing_confirmation')`
  );
  if ((mini.rows[0]?.cnt ?? 0) > 0) {
    throw new Error(
      'DB sudah memiliki tabel minibar — bootstrap disposable DIBUAT BARU: ' +
      'hapus tabel minibar + marker, atau buat DB test baru.'
    );
  }
  console.log('  Precondition bootstrap OK (skema master ada, tabel minibar bersih).');
}

async function testFreshMigration() {
  console.log('\n[TEST 1] Fresh Migration');
  await assertBootstrapPrecondition();

  const migration = require('../dist/db/migrations/minibar_hk_billing_v1');
  const result = await migration.runMinibarHkBillingMigration(pool);

  const okRun = result.ok && result.status === 'applied' && result.applied === true;
  expect(okRun, okRun
    ? 'Migration fresh sukses (status "applied", applied=true)'
    : `Migration fresh GAGAL (status=${result.status}, ok=${result.ok})`);

  if (!okRun) {
    // KONTRAK: fresh migration gagal → HENTIKAN suite yang membutuhkan
    // schema; laporkan error migration; main() hanya menjalankan cleanup.
    freshFailed = true;
    for (const e of result.errors) console.error('  MIGRATION ERROR: ' + e);
    return;
  }

  // Marker tertulis
  const chk = await api("SELECT 1 FROM schema_migrations WHERE version='minibar_hk_billing_v1'");
  expect((chk.rowCount ?? 0) === 1, 'Marker "minibar_hk_billing_v1" tertulis');

  // Verifikasi tabel ada
  const tables = [
    'room_type_minibar_standard',
    'minibar_baseline_verification',
    'minibar_stay_event',
    'minibar_inspection_report',
    'minibar_inspection_report_line',
    'minibar_billing_confirmation',
  ];
  for (const t of tables) {
    const r = await api(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
      [t]
    );
    expect((r.rowCount ?? 0) === 1, `Tabel ${t} ada`);
  }

  // Verifikasi kolom additive T7
  const colR = await api(
    "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='folio_entries' AND column_name='hk_report_line_id'"
  );
  expect((colR.rowCount ?? 0) === 1, 'Kolom folio_entries.hk_report_line_id ada');

  const colR2 = await api(
    "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='folio_entries' AND column_name='minibar_confirmation_id'"
  );
  expect((colR2.rowCount ?? 0) === 1, 'Kolom folio_entries.minibar_confirmation_id ada');

  // Kolom additive T9/T10
  const colT9 = await api(
    "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='checklist_template_items' AND column_name='requires_minibar_report'"
  );
  expect((colT9.rowCount ?? 0) === 1, 'Kolom checklist_template_items.requires_minibar_report ada');
  const colT10 = await api(
    "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='housekeeping_task_checklist_items' AND column_name='requires_minibar_report'"
  );
  expect((colT10.rowCount ?? 0) === 1, 'Kolom housekeeping_task_checklist_items.requires_minibar_report ada');
}

async function testRerun() {
  console.log('\n[TEST 2] Rerun Migration (Idempoten)');
  const migration = require('../dist/db/migrations/minibar_hk_billing_v1');
  const result = await migration.runMinibarHkBillingMigration(pool);

  expect(result.ok, 'Rerun sukses');
  expect(result.status === 'already-applied', `Status = "already-applied" (got: ${result.status})`);
  expect(result.applied === false, 'Flag applied = false (tidak re-DDL)');
}

async function testMarkerRemoved() {
  console.log('\n[TEST 3] Marker Dihapus → DDL Ulang');
  const del = await api("DELETE FROM schema_migrations WHERE version='minibar_hk_billing_v1'");
  expect((del.rowCount ?? 0) >= 1, 'Marker dihapus');

  const migration = require('../dist/db/migrations/minibar_hk_billing_v1');
  const result = await migration.runMinibarHkBillingMigration(pool);

  expect(result.ok, 'Migration ulang sukses setelah marker dihapus');
  expect(result.status === 'applied', `Status = "applied" (got: ${result.status})`);

  // Pastikan marker kembali
  const chk = await api("SELECT 1 FROM schema_migrations WHERE version='minibar_hk_billing_v1'");
  expect((chk.rowCount ?? 0) === 1, 'Marker kembali setelah migration ulang');
}

/**
 * TEST 4a — jalur "marker belum ada" + verifikasi DDL gagal → ROLLBACK.
 * Bukti yang diuji (BERBEDA dari mismatch marker existing di TEST 4):
 *  - status 'verification-failed' (BUKAN 'mismatch'),
 *  - marker TIDAK ada setelah ROLLBACK,
 *  - index yang dibuat ulang oleh DDL IF NOT EXISTS selama migration
 *    ter-rollback (tetap tidak ada setelah migration gagal),
 *  - perubahan skema test sementara (drop kolom) TIDAK di-recreate
 *    oleh DDL IF NOT EXISTS (bukti: kolom tetap hilang setelah rollback).
 * Pemicu deterministik: DROP COLUMN standard_qty (diverifikasi
 * TABLE_COLUMNS oleh verifier).
 */
async function testRollbackOnMissingMarkerPath() {
  console.log('\n[TEST 4a] Jalur Marker Belum Ada + Verifikasi Gagal → ROLLBACK');

  // Prasyarat: marker SANGAT BUKAN ada.
  await api("DELETE FROM schema_migrations WHERE version='minibar_hk_billing_v1'");
  const markerPre = await api(
    "SELECT COUNT(*)::int AS cnt FROM schema_migrations WHERE version='minibar_hk_billing_v1'"
  );
  if ((markerPre.rows[0]?.cnt ?? 0) !== 0) {
    failed++;
    errors.push('PRASYARAT GAGAL: marker masih ada — kegagalan prasyarat.');
    console.error('  FAIL | PRASYARAT: marker masih ada');
    return;
  }

  // ── Setup kondisi mismatch terukur ──────────────────────────────────────────
  // 1) DROP satu index yang akan dibuat ulang oleh DDL (IF NOT EXISTS).
  //    Nama deterministik dari DDL aktual migration:
  //    CREATE INDEX IF NOT EXISTS idx_mb_stay_event_scope
  //      ON minibar_stay_event (property_id, reservation_id, room_id, menu_item_id, id);
  const droppedIndex = 'idx_mb_stay_event_scope';
  // Sebelum DROP: assert index ada pada public.minibar_stay_event.
  const idxExists = await api(
    `SELECT COUNT(*)::int AS cnt FROM pg_indexes
     WHERE schemaname='public' AND indexname='${droppedIndex}'`
  );
  if ((idxExists.rows[0]?.cnt ?? 0) !== 1) {
    failed++;
    errors.push(`PRASYARAT GAGAL: index ${droppedIndex} tidak ada sebelum drop.`);
    console.error(`  FAIL | PRASYARAT: index ${droppedIndex} tidak ada sebelum drop`);
    return;
  }
  await api(`DROP INDEX IF EXISTS ${droppedIndex}`);
  const idxPre = await api(
    `SELECT COUNT(*)::int AS cnt FROM pg_indexes
     WHERE schemaname='public' AND indexname='${droppedIndex}'`
  );
  if ((idxPre.rows[0]?.cnt ?? 0) !== 0) {
    failed++;
    errors.push(`PRASYARAT GAGAL: index ${droppedIndex} masih ada setelah drop.`);
    console.error(`  FAIL | PRASYARAT: index ${droppedIndex} masih ada setelah drop`);
    return;
  }
  expect((idxPre.rows[0]?.cnt ?? 0) === 0, 'Setup: index ' + droppedIndex + ' dihapus');

  // 2) DROP COLUMN standard_qty → diverifikasi TABLE_COLUMNS oleh verifier
  //    (pemicu deterministik; tanpa mengubah DDL migration).
  await api(`ALTER TABLE room_type_minibar_standard DROP COLUMN IF EXISTS standard_qty`);

  // ── Migration: jalur marker belum ada + verifikasi DDL gagal → ROLLBACK ───
  const migration = require('../dist/db/migrations/minibar_hk_billing_v1');
  const result = await migration.runMinibarHkBillingMigration(pool);

  expect(!result.ok, 'Jalur marker belum ada + verifikasi gagal: ok=false');
  expect(result.status === 'verification-failed',
    `Status = "verification-failed" (got: ${result.status})`);
  expect(result.errors.length > 0,
    `Ada error eksplisit verifikasi (${result.errors.length} pesan)`);

  // BUKTI ROLLBACK TOTAL pada jalur marker belum ada:
  // 1) marker TIDAK ada (INSERT marker dalam transaksi yang sama dibatalkan)
  const markerPost = await api(
    "SELECT COUNT(*)::int AS cnt FROM schema_migrations WHERE version='minibar_hk_billing_v1'"
  );
  expect((markerPost.rows[0]?.cnt ?? 0) === 0,
    'ROLLBACK jalur marker belum ada: marker TIDAK tertinggal');

  // 2) index yang dibuat ulang oleh DDL IF NOT EXISTS selama migration
  //    ter-rollback → index TETAP TIDAK ADA setelah migration gagal.
  const idxPost = await api(
    `SELECT COUNT(*)::int AS cnt FROM pg_indexes
     WHERE schemaname='public' AND indexname='${droppedIndex}'`
  );
  expect((idxPost.rows[0]?.cnt ?? 0) === 0,
    'Index ' + droppedIndex + ' TETAP TIDAK ADA setelah rollback (DDL recreate index ter-rollback)');

  // 3) Kolom standard_qty yang dihapus di luar transaksi migration
  //    TETAP HILANG (perubahan skema test di luar migration tidak disentuh).
  const colGone = await api(
    `SELECT COUNT(*)::int AS cnt FROM information_schema.columns
     WHERE table_schema='public' AND table_name='room_type_minibar_standard'
       AND column_name='standard_qty'`
  );
  expect((colGone.rows[0]?.cnt ?? 0) === 0,
    'Kolom standard_qty masih hilang (DDL tidak auto-recreate; bukti rollback total)');

  // ── Restore skema test untuk test berikutnya ───────────────────────────────
  // 1) Kembalikan kolom standard_qty (tanpa constraint agar recovery migration
  //    yang menjalankan DDL penuh — termasuk CREATE CONSTRAINT — tetap sukses).
  await api(`ALTER TABLE room_type_minibar_standard
             ADD COLUMN IF NOT EXISTS standard_qty INTEGER NOT NULL DEFAULT 0`);
  // 2) Pulihkan CHECK constraint ck_rt_minibar_std_qty yang hilang bersama
  //    DROP COLUMN (CREATE TABLE IF NOT EXISTS tidak merecreate constraint
  //    bila tabel sudah ada; ALTER TABLE ADD CONSTRAINT wajib eksplisit).
  await api(`ALTER TABLE room_type_minibar_standard
             ADD CONSTRAINT ck_rt_minibar_std_qty CHECK (standard_qty >= 0)`);
  // 3) Recovery: jalankan migration (jalur marker belum ada + DDL IF NOT EXISTS
  //    merecreate index + constraint yang hilang) → status 'applied'.
  const mig = require('../dist/db/migrations/minibar_hk_billing_v1');
  const restored = await mig.runMinibarHkBillingMigration(pool);
  expect(restored.ok && restored.status === 'applied',
    'Recovery: migration sukses setelah skema dipulihkan (index + marker ditulis)');
  if (!restored.ok || restored.status !== 'applied') {
    // Recovery gagal → catat FAIL dan hentikan test yang bergantung pada schema.
    // Cleanup tetap dijalankan oleh main() di finally block.
    console.error('  Recovery TEST 4a gagal — test berikutnya yang membutuhkan schema dilewati.');
    return;
  }
  // 4) Setelah recovery migration sukses: index kembali ada.
  const idxRestored = await api(
    `SELECT COUNT(*)::int AS cnt FROM pg_indexes
     WHERE schemaname='public' AND indexname='${droppedIndex}'`
  );
  expect((idxRestored.rows[0]?.cnt ?? 0) === 1,
    'Index ' + droppedIndex + ' KEMBALI ADA setelah recovery migration sukses');
}

async function testSchemaMismatchRollback() {
  console.log('\n[TEST 4] Schema Mismatch (marker existing) → ok=false + ROLLBACK');

  // Hapus satu named UNIQUE constraint (bukan PK/other)
  await api(`ALTER TABLE minibar_stay_event DROP CONSTRAINT IF EXISTS uq_minibar_stay_event`);

  const migration = require('../dist/db/migrations/minibar_hk_billing_v1');
  const result = await migration.runMinibarHkBillingMigration(pool);

  expect(!result.ok, 'Mismatch terdeteksi (result.ok = false)');
  expect(result.status === 'mismatch', `Status = "mismatch" (got: ${result.status})`);
  expect(result.errors.length > 0, `Ada error eksplisit (${result.errors.length} pesan)`);

  // Karena ROLLBACK: DDL baru & marker tidak tertinggal.
  // Hapus marker yang ada (untuk memisahkan "marker hilang" dari "mismatch")
  await api("DELETE FROM schema_migrations WHERE version='minibar_hk_billing_v1'");

  // Constraint masih hilang (ROLLBACK mengembalikannya ke state pre-DDL —
  // DDL IF NOT EXISTS tidak mengulang CREATE UNIQUE). Test ini memverifikasi
  // bahwa constraint yang di-drop TIDAK direstore otomatis.
  const stillMissing = await api(
    `SELECT COUNT(*)::int AS cnt FROM pg_constraint
     WHERE conname='uq_minibar_stay_event' AND contype='u'`
  );
  expect((stillMissing.rows[0]?.cnt ?? 0) === 0, 'Constraint tetap hilang setelah rollback (tidak di-re-DDL otomatis)');

  // Recovery: pulihkan constraint, jalankan lagi → sukses + marker
  await api(`
    ALTER TABLE minibar_stay_event
    ADD CONSTRAINT uq_minibar_stay_event UNIQUE (
      property_id, reservation_id, room_id, menu_item_id,
      event_type, source_type, source_id
    )
  `);
  const result2 = await migration.runMinibarHkBillingMigration(pool);
  expect(result2.ok, 'Recovery: migration sukses setelah constraint dipulihkan');
  expect(result2.status === 'applied', `Recovery status = "applied" (got: ${result2.status})`);
}

async function testRumusBaseline() {
  console.log('\n[TEST 5] Rumus Baseline Efektif (helper)');

  const { calcBaselineEffective, filterBaselineRange } = require('../dist/domains/housekeeping/minibarTypes');

  // Fixture: anchor verified_qty = 4
  // Event range (anchor_event_id=3, cutoff_event_id=5; range = id>3 AND id<=5):
  //   id 2: CONSUMPTION_CONFIRMED -1 (di luar range — di bawah anchor)
  //   id 3: ANCHOR (verification) — tidak dihitung (id > anchor tidak termasuk)
  //   id 4: CONSUMPTION_CONFIRMED -1 (dalam range)
  //   id 5: ADDED_TO_ROOM +2      (dalam range, = cutoff)
  //   id 6: CONSUMPTION_CONFIRMED -1 (di luar range — setelah cutoff)
  //   id 7: REMOVED_FROM_ROOM -5   (di luar scope — room berbeda)

  const eventsInRange = filterBaselineRange(
    [
      { propertyId: 1, reservationId: 10, roomId: 100, menuItemId: 50, id: 2, quantityDelta: -1 },
      { propertyId: 1, reservationId: 10, roomId: 100, menuItemId: 50, id: 3, quantityDelta: 0 }, // anchor
      { propertyId: 1, reservationId: 10, roomId: 100, menuItemId: 50, id: 4, quantityDelta: -1 }, // in range
      { propertyId: 1, reservationId: 10, roomId: 100, menuItemId: 50, id: 5, quantityDelta: +2 }, // in range (= cutoff)
      { propertyId: 1, reservationId: 10, roomId: 100, menuItemId: 50, id: 6, quantityDelta: -1 }, // after cutoff
      { propertyId: 1, reservationId: 10, roomId: 101, menuItemId: 50, id: 7, quantityDelta: -5 }, // out of scope
    ],
    { propertyId: 1, reservationId: 10, roomId: 100, menuItemId: 50 },
    3, // anchorEventId
    5, // cutoffEventId
  );

  const anchorVerifiedQty = 4;
  const baseline = calcBaselineEffective(anchorVerifiedQty, eventsInRange);

  // eventsInRange: id 4 (-1) + id 5 (+2) = +1
  // baseline = 4 + 1 = 5
  expect(baseline === 5, `baseline_effective = 5 (got: ${baseline})`);
  expect(eventsInRange.length === 2, `2 event dalam range (got: ${eventsInRange.length})`);
  expect(eventsInRange.reduce((a, e) => a + e.quantityDelta, 0) === 1, 'SUM delta range = +1');
  // Anchor (id 3) TIDAK masuk (id > anchor), out-of-scope (id 7) TIDAK masuk
  const ids = eventsInRange.map(e => e.id);
  expect(!ids.includes(3), 'Anchor id 3 tidak dihitung');
  expect(!ids.includes(7), 'Out-of-scope id 7 tidak dihitung');
}

async function testScopeIsolation() {
  console.log('\n[TEST 6] Isolasi Scope (4 kolom) + Event DB Range');

  const { filterBaselineRange } = require('../dist/domains/housekeeping/minibarTypes');

  // events: campur antara property/reservation/room/menu_item
  const events = [
    { propertyId: 1, reservationId: 1, roomId: 1, menuItemId: 1, id: 1, quantityDelta: -1 },
    { propertyId: 1, reservationId: 1, roomId: 1, menuItemId: 2, id: 2, quantityDelta: -2 }, // beda menu
    { propertyId: 1, reservationId: 2, roomId: 1, menuItemId: 1, id: 3, quantityDelta: -3 }, // beda res
    { propertyId: 2, reservationId: 1, roomId: 1, menuItemId: 1, id: 4, quantityDelta: -4 }, // beda prop
    { propertyId: 1, reservationId: 1, roomId: 2, menuItemId: 1, id: 5, quantityDelta: -5 }, // beda room
    { propertyId: 1, reservationId: 1, roomId: 1, menuItemId: 1, id: 6, quantityDelta: +1 }, // sesuai scope, in range
    { propertyId: 1, reservationId: 1, roomId: 1, menuItemId: 1, id: 7, quantityDelta: +1 }, // sesuai scope, after cutoff
  ];

  const filtered = filterBaselineRange(
    events,
    { propertyId: 1, reservationId: 1, roomId: 1, menuItemId: 1 },
    3,  // anchor
    6,  // cutoff
  );

  // Hanya id 6 (id 7 > cutoff, id 1-5 out of scope)
  expect(filtered.length === 1, `1 event sesuai scope+range (got: ${filtered.length})`);
  expect(filtered[0]?.quantityDelta === 1, 'Qty delta = +1 (event id 6)');

  // ── Verifikasi DB: beberapa baseline per scope sah (tanpa UNIQUE per scope),
  //    dan helper filter selaras rentang (anchor, cutoff] yang disimpan ──
  const propId = await createTestProperty();
  const rtId = await createTestRoomType(propId);
  const room = await createTestRoom(propId);
  const res = await createTestReservation(propId, room);
  const menu = await createTestMenuItem(propId);

  // 2 baseline record untuk scope yang sama (verifikasi ulang ≠ replace)
  const b1 = await api(
    `INSERT INTO minibar_baseline_verification
       (property_id, reservation_id, room_id, menu_item_id, verified_qty, source_type, source_id, verified_by)
     VALUES ($1,$2,$3,$4, 10, 'MANUAL_VERIFICATION', 1, $5) RETURNING id`,
    [propId, res, room, menu, 'HK-SEED']
  );
  tracked.baselineIds.push(b1.rows[0].id);
  const b2 = await api(
    `INSERT INTO minibar_baseline_verification
       (property_id, reservation_id, room_id, menu_item_id, verified_qty, source_type, source_id, verified_by)
     VALUES ($1,$2,$3,$4, 8, 'EXPLICIT_RESTOCK', 2, $5) RETURNING id`,
    [propId, res, room, menu, 'FO-RESEED']
  );
  tracked.baselineIds.push(b2.rows[0].id);
  const bcnt = await api(
    `SELECT COUNT(*)::int AS cnt FROM minibar_baseline_verification
     WHERE property_id=$1 AND reservation_id=$2 AND room_id=$3 AND menu_item_id=$4`,
    [propId, res, room, menu]
  );
  expect(bcnt.rows[0].cnt === 2, '2 baseline record per scope (tanpa UNIQUE per scope)');

  // event DB (rentang formal: id > anchor AND id <= cutoff, yaitu (anchor, cutoff])
  const evAnchor = await api(
    `INSERT INTO minibar_stay_event
       (property_id, reservation_id, room_id, menu_item_id, event_type, quantity_delta, source_type, source_id)
     VALUES ($1,$2,$3,$4, 'EXPLICIT_CHECKIN', 0, 'VERIFICATION', 1) RETURNING id`,
    [propId, res, room, menu]
  );
  const aId = evAnchor.rows[0].id;
  tracked.eventIds.push(aId);

  const evIn = await api(
    `INSERT INTO minibar_stay_event
       (property_id, reservation_id, room_id, menu_item_id, event_type, quantity_delta, source_type, source_id)
     VALUES ($1,$2,$3,$4, 'CONSUMPTION_CONFIRMED', -2, 'REPORT', 10) RETURNING id`,
    [propId, res, room, menu]
  );
  const inId = evIn.rows[0].id;
  tracked.eventIds.push(inId);

  const evOutScope = await api(
    `INSERT INTO minibar_stay_event
       (property_id, reservation_id, room_id, menu_item_id, event_type, quantity_delta, source_type, source_id)
     VALUES ($1,$2,$3,$4, 'REMOVED_FROM_ROOM', -3, 'VERIFICATION', 20) RETURNING id`,
    [propId, res, room, menu]
  );
  tracked.eventIds.push(evOutScope.rows[0].id);
  // Event di ruang lain (out of scope): dibuat di ruang kedua
  const room2 = await createTestRoom(propId);
  const evRoom2 = await api(
    `INSERT INTO minibar_stay_event
       (property_id, reservation_id, room_id, menu_item_id, event_type, quantity_delta, source_type, source_id)
     VALUES ($1,$2,$3,$4, 'ADDED_TO_ROOM', +5, 'RESTOCK', 30) RETURNING id`,
    [propId, res, room2, menu]
  );
  tracked.eventIds.push(evRoom2.rows[0].id);

  const dbEvents = await api(
    `SELECT id, quantity_delta FROM minibar_stay_event
     WHERE property_id=$1 AND reservation_id=$2 AND room_id=$3 AND menu_item_id=$4
       AND id > $5 AND id <= $6 ORDER BY id`,
    [propId, res, room, menu, aId, inId]
  );
  const dbFiltered = dbEvents.rows.map((r) => ({ quantityDelta: r.quantity_delta }));
  expect(dbFiltered.length === 1, `DB: 1 event dalam (anchor, cutoff] (got: ${dbFiltered.length})`);
  expect(dbFiltered[0]?.quantityDelta === -2, 'DB: delta dalam rentang = -2 (CONSUMPTION_CONFIRMED)');

  const dbHonor = filterBaselineRange(
    dbEvents.rows.map((r) => ({ propertyId: propId, reservationId: res, roomId: room, menuItemId: menu, id: r.id, quantityDelta: r.quantity_delta })),
    { propertyId: propId, reservationId: res, roomId: room, menuItemId: menu },
    aId,
    inId,
  );
  expect(dbHonor.length === dbFiltered.length, 'Helper selaras dengan hasil rentang DB');
}

// ── Constraint melalui INSERT aktual (valid/invalid) ────────────────────────
// Setiap INSERT negatif HANYA melanggar satu constraint yang ditargetkan
// (field lain tetap valid) sehingga assert conname tepat; SQLSTATE 23514.
// Pengecualian terukur: record (event_type invalid, delta=0) melanggar DUA
// constraint sekaligus — ck_mb_event_type DAN ck_mb_event_delta_sign
// (nilai tak dikenal tidak termasuk cabang mana pun dari CHECK tanda).
// PostgreSQL hanya melaporkan SATU constraint (pilih acak di antara yang
// dilanggar), jadi assert menerima kedua conname; constraint kasus lain tetap
// di-assert presisi — tidak dilonggarkan.
// ────────────────────────────────────────────────────────────────────────────
async function testConstraintInserts() {
  console.log('\n[TEST 7] Constraint melalui INSERT aktual (valid/invalid)');

  const propId = await createTestProperty();
  const rtId = await createTestRoomType(propId);
  const room = await createTestRoom(propId);
  const res = await createTestReservation(propId, room);
  const menu = await createTestMenuItem(propId);
  const roomNo = `${RUN.slice(-2)}${String(seq).padStart(2, '0')}`.slice(0, 10);
  const task = await createTestTask(propId, roomNo);
  // Fixture folio untuk T6 (kolom folio_entries: reservation_id, property_id,
  // entry_type, description, amount, direction). property_id NOT NULL (skema
  // aktual) — wajib diisi dengan propId yang sama dengan reservation fixture.
  // Folio dipantau untuk cleanup (dihapus setelah confirmation-nya, atau
  // langsung bila tidak dipakai).
  const folioA = await api(
    `INSERT INTO folio_entries (reservation_id, property_id, entry_type, description, amount, direction)
     VALUES ($1, $2, 'MINIBAR', 'Minibar posted', 10000, 'DEBIT') RETURNING id`,
    [res, propId]
  );
  const folioB = await api(
    `INSERT INTO folio_entries (reservation_id, property_id, entry_type, description, amount, direction)
     VALUES ($1, $2, 'MINIBAR', 'Minibar replacement', 10000, 'DEBIT') RETURNING id`,
    [res, propId]
  );
  tracked.folioIds.push(folioA.rows[0].id, folioB.rows[0].id);
  const FOLIO_A = folioA.rows[0].id;
  const FOLIO_B = folioB.rows[0].id;
  const fcnt = await api(
    `SELECT COUNT(*)::int AS cnt FROM folio_entries WHERE id IN ($1, $2)`,
    [FOLIO_A, FOLIO_B]
  );
  expect(fcnt.rows[0].cnt === 2, 'Fixture folio_entries valid (2 baris, skema aktual)');

  // ── T1 valid ──
  const insT1 = await api(
    `INSERT INTO room_type_minibar_standard
       (property_id, room_type_id, menu_item_id, standard_qty)
     VALUES ($1,$2,$3, 6) RETURNING id`,
    [propId, rtId, menu]
  );
  tracked.stdIds.push(insT1.rows[0].id);
  expect(insT1.rowCount === 1, 'T1 INSERT valid (standard_qty=6)');

  // ── T1 invalid: standard_qty < 0 (selain nilai, semua constraint lain terpenuhi)
  const t1bad = await tryInsert(
    `INSERT INTO room_type_minibar_standard (property_id, room_type_id, menu_item_id, standard_qty)
     VALUES ($1,$2,$3, -1)`,
    [propId, rtId, menu]
  );
  expectRejected(t1bad, '23514', 'ck_rt_minibar_std_qty', 'T1 standard_qty=-1 ditolak');

  // ── T2: baseline valid + 2 record per scope sah ──
  const b1 = await api(
    `INSERT INTO minibar_baseline_verification
       (property_id, reservation_id, room_id, menu_item_id, verified_qty, source_type, source_id, verified_by)
     VALUES ($1,$2,$3,$4, 5, 'MANUAL_VERIFICATION', 101, 'HK') RETURNING id`,
    [propId, res, room, menu]
  );
  tracked.baselineIds.push(b1.rows[0].id);
  const b2 = await api(
    `INSERT INTO minibar_baseline_verification
       (property_id, reservation_id, room_id, menu_item_id, verified_qty, source_type, source_id)
     VALUES ($1,$2,$3,$4, 4, 'EXPLICIT_RESTOCK', 102) RETURNING id`,
    [propId, res, room, menu]
  );
  tracked.baselineIds.push(b2.rows[0].id);
  expect(b1.rowCount === 1 && b2.rowCount === 1, 'T2 2 baseline per scope (tanpa UNIQUE per scope)');

  const bBadSrc = await tryInsert(
    `INSERT INTO minibar_baseline_verification
       (property_id, reservation_id, room_id, menu_item_id, verified_qty, source_type, source_id)
     VALUES ($1,$2,$3,$4, 3, 'ADJUSTMENT', 103)`,
    [propId, res, room, menu]
  );
  expectRejected(bBadSrc, '23514', 'ck_mb_baseline_source_type', 'T2 source_type di luar CHECK ditolak');

  const bBadQty = await tryInsert(
    `INSERT INTO minibar_baseline_verification
       (property_id, reservation_id, room_id, menu_item_id, verified_qty, source_type, source_id)
     VALUES ($1,$2,$3,$4, -2, 'MANUAL_VERIFICATION', 104)`,
    [propId, res, room, menu]
  );
  expectRejected(bBadQty, '23514', 'ck_mb_baseline_qty', 'T2 verified_qty=-2 ditolak');

  // ── T3: event valid (anchor INSPECTION_SNAPSHOT delta=0) ──
  const ev1 = await api(
    `INSERT INTO minibar_stay_event
       (property_id, reservation_id, room_id, menu_item_id, event_type, quantity_delta, source_type, source_id)
     VALUES ($1,$2,$3,$4, 'INSPECTION_SNAPSHOT', 0, 'REPORT', 201) RETURNING id`,
    [propId, res, room, menu]
  );
  tracked.eventIds.push(ev1.rows[0].id);
  expect(ev1.rowCount === 1, 'T3 event valid (INSPECTION_SNAPSHOT, delta=0)');

  // delta sign salah (CONSUMPTION_CONFIRMED harus < 0; constraint lain terpenuhi)
  const evBadSign = await tryInsert(
    `INSERT INTO minibar_stay_event
       (property_id, reservation_id, room_id, menu_item_id, event_type, quantity_delta, source_type, source_id)
     VALUES ($1,$2,$3,$4, 'CONSUMPTION_CONFIRMED', +1, 'REPORT', 202)`,
    [propId, res, room, menu]
  );
  expectRejected(evBadSign, '23514', 'ck_mb_event_delta_sign', 'T3 CONSUMPTION_CONFIRMED delta=+1 ditolak');

  // event_type di luar 8 nilai valid.
  // CATATAN: record (event_type='CONSUMPTION', delta=0) melanggar DUA
  // constraint sekaligus — ck_mb_event_type (nilai tak dikenal) DAN
  // ck_mb_event_delta_sign (nilai tak dikenal tidak termasuk cabang mana
  // pun dari CHECK tanda). PostgreSQL melarang HANYA SATU constraint (pilih
  // acak di antara yang dilanggar) → assert menerima keduanya, SQLSTATE 23514.
  const evBadType = await tryInsert(
    `INSERT INTO minibar_stay_event
       (property_id, reservation_id, room_id, menu_item_id, event_type, quantity_delta, source_type, source_id)
     VALUES ($1,$2,$3,$4, 'CONSUMPTION', 0, 'REPORT', 203)`,
    [propId, res, room, menu]
  );
  expect(
    !evBadType.ok &&
      evBadType.code === '23514' &&
      (evBadType.conname === 'ck_mb_event_type' ||
       evBadType.conname === 'ck_mb_event_delta_sign'),
    `T3 event_type='CONSUMPTION' (nilai lama) ditolak — got SQLSTATE=${evBadType.code ?? 'n/a'} constraint=${evBadType.conname || '(pg tidak menyertakan)'}`
  );

  // source_type di luar 3 nilai valid
  const evBadSrc = await tryInsert(
    `INSERT INTO minibar_stay_event
       (property_id, reservation_id, room_id, menu_item_id, event_type, quantity_delta, source_type, source_id)
     VALUES ($1,$2,$3,$4, 'INSPECTION_SNAPSHOT', 0, 'ADJUSTMENT', 204)`,
    [propId, res, room, menu]
  );
  expectRejected(evBadSrc, '23514', 'ck_mb_event_source_type', "T3 source_type='ADJUSTMENT' (nilai lama) ditolak");

  // ── T4: report valid + status CHECK (anonim → pg memberikan nama auto-generated)
  const rep = await api(
    `INSERT INTO minibar_inspection_report
       (property_id, reservation_id, room_id, task_id, hk_user_id, status)
     VALUES ($1,$2,$3,$4, 'hk-1', 'DRAFT') RETURNING id`,
    [propId, res, room, task]
  );
  tracked.reportIds.push(rep.rows[0].id);
  expect(rep.rowCount === 1, 'T4 report DRAFT valid');

  // status di luar DDL (DRAFT|SUBMITTED|SUPERSEDED); task FK tetap valid
  const task2 = await createTestTask(propId);
  const repBad = await tryInsert(
    `INSERT INTO minibar_inspection_report
       (property_id, reservation_id, room_id, task_id, status)
     VALUES ($1,$2,$3, $4, 'APPROVED')`,
    [propId, res, room, task2]
  );
  expectRejected(repBad, '23514', null, "T4 status='APPROVED' (nilai lama) ditolak");
  // Nama CHECK anonim adalah auto-generated pg; pastikan salah satu yang eksis
  const repCheckName = await api(
    `SELECT conname FROM pg_constraint
     WHERE conrelid = 'minibar_inspection_report'::regclass AND contype = 'c'
       AND conname LIKE 'minibar_inspection_report_%_check' LIMIT 1`
  );
  expect(
    repCheckName.rowCount === 1 && repBad.conname === repCheckName.rows[0].conname,
    `T4 CHECK anonim dipatuhi (conname=${repBad.conname || 'n/a'})`
  );

  // ── T5: line valid (DRAFT: qty turunan nullable) + invalid ──
  const lnOk = await api(
    `INSERT INTO minibar_inspection_report_line
       (report_id, property_id, menu_item_id, counted_qty,
        baseline_verification_id, baseline_status, baseline_qty, baseline_effective,
        anchor_event_id, cutoff_event_id)
     VALUES ($1,$2,$3, 4, $4, 'VERIFIED', 5, 3, $5, $5) RETURNING id`,
    [rep.rows[0].id, propId, menu, b1.rows[0].id, ev1.rows[0].id]
  );
  tracked.lineIds.push(lnOk.rows[0].id);
  expect(lnOk.rowCount === 1, 'T5 line valid (DRAFT: qty turunan NULL, unit_price NULL)');

  // counted_qty < 0; baseline_status 'UNKNOWN' valid → CHECK qty-lah yang ditarget
  const lnBadQty = await tryInsert(
    `INSERT INTO minibar_inspection_report_line
       (report_id, property_id, menu_item_id, counted_qty, baseline_status)
     VALUES ($1,$2,$3, -1, 'UNKNOWN')`,
    [rep.rows[0].id, propId, menu]
  );
  expectRejected(lnBadQty, '23514', 'ck_mb_line_counted_qty', 'T5 counted_qty=-1 ditolak');

  // baseline_status di luar 3 nilai valid; counted_qty=0 valid → bukan qty
  const lnBadStatus = await tryInsert(
    `INSERT INTO minibar_inspection_report_line
       (report_id, property_id, menu_item_id, counted_qty, baseline_status)
     VALUES ($1,$2,$3, 0, 'DRAFT')`,
    [rep.rows[0].id, propId, menu]
  );
  expectRejected(lnBadStatus, '23514', 'ck_mb_line_baseline_status', "T5 baseline_status='DRAFT' ditolak");

  // billing_status di luar 5 nilai T5
  const lnBadBilling = await tryInsert(
    `INSERT INTO minibar_inspection_report_line
       (report_id, property_id, menu_item_id, counted_qty, baseline_status, billing_status)
     VALUES ($1,$2,$3, 0, 'UNKNOWN', 'APPROVED')`,
    [rep.rows[0].id, propId, menu]
  );
  expectRejected(lnBadBilling, '23514', 'ck_mb_line_billing_status', "T5 billing_status='APPROVED' ditolak");

  // ── T6: confirmation valid (NOT_BILLED) + aturan CHECK ──
  // CATATAN: uq_minibar_billing_confirmation UNIQUE (property_id, report_line_id)
  //          — SATU confirmation per report line. Untuk menguji CHECK
  //          dengan kondisi folio berbeda, siapkan line tambahan (menu item
  //          kedua) agar tiap kasus CHECK memakai report line sendiri.
  const menu2 = await createTestMenuItem(propId);
  const ln2 = await api(
    `INSERT INTO minibar_inspection_report_line
       (report_id, property_id, menu_item_id, counted_qty, baseline_status)
     VALUES ($1,$2,$3, 0, 'UNKNOWN') RETURNING id`,
    [rep.rows[0].id, propId, menu2]
  );
  tracked.lineIds.push(ln2.rows[0].id);
  // ln3 memakai menu item KETIGA yang berbeda — uq_minibar_report_line
  // UNIQUE (report_id, menu_item_id): tiap line dalam satu report harus
  // punya menu_item_id berbeda. (lnOk=menu, ln2=menu2, ln3=menu3.)
  const menu3 = await createTestMenuItem(propId);
  const ln3 = await api(
    `INSERT INTO minibar_inspection_report_line
       (report_id, property_id, menu_item_id, counted_qty, baseline_status)
     VALUES ($1,$2,$3, 0, 'UNKNOWN') RETURNING id`,
    [rep.rows[0].id, propId, menu3]
  );
  tracked.lineIds.push(ln3.rows[0].id);

  const confOk = await api(
    `INSERT INTO minibar_billing_confirmation
       (property_id, reservation_id, report_line_id, confirmed_consumed_qty,
        confirmed_subtotal, billing_status, reduction_reason)
     VALUES ($1,$2,$3, 0, 0, 'NOT_BILLED', $4) RETURNING id`,
    [propId, res, lnOk.rows[0].id, 'minibar tidak ada']
  );
  tracked.confIds.push(confOk.rows[0].id);
  expect(confOk.rowCount === 1, 'T6 confirmation NOT_BILLED valid (qty=0, folio NULL, alasan terisi)');

  // NOT_BILLED tanpa alasan → ck_mb_conf_not_billed (line sendiri → bukan UNIQUE)
  const confNoReason = await tryInsert(
    `INSERT INTO minibar_billing_confirmation
       (property_id, reservation_id, report_line_id, confirmed_consumed_qty,
        confirmed_subtotal, billing_status, reduction_reason)
     VALUES ($1,$2,$3, 0, 0, 'NOT_BILLED', $4)`,
    [propId, res, ln2.rows[0].id, '  ']
  );
  expectRejected(confNoReason, '23514', 'ck_mb_conf_not_billed', "T6 NOT_BILLED alasan btrim='' ditolak");

  // POSTED tanpa folio → ck_mb_conf_posted (line sendiri)
  const confNoFolio = await tryInsert(
    `INSERT INTO minibar_billing_confirmation
       (property_id, reservation_id, report_line_id, confirmed_consumed_qty,
        confirmed_subtotal, billing_status, reduction_reason)
     VALUES ($1,$2,$3, 1, 10000, 'POSTED', $4)`,
    [propId, res, ln3.rows[0].id, null]
  );
  expectRejected(confNoFolio, '23514', 'ck_mb_conf_posted', 'T6 POSTED tanpa folio_entry_id ditolak');

  // CORRECTED tanpa correction_group_id → ck_mb_conf_corrected_group;
  // folio valid (FOLIO_A/FOLIO_B) sehingga group-lah satu-satunya yang ditarget.
  // Pakai ln3 (belum dikonsumsi — confNoFolio di ln3 ditolak CHECK, tidak consuming).
  const confNoGroup = await tryInsert(
    `INSERT INTO minibar_billing_confirmation
       (property_id, reservation_id, report_line_id, confirmed_consumed_qty,
        confirmed_subtotal, billing_status, folio_entry_id, original_folio_entry_id,
        reduction_reason)
     VALUES ($1,$2,$3, 1, 10000, 'CORRECTED', $4, $5, $6)`,
    [propId, res, ln3.rows[0].id, FOLIO_A, FOLIO_B, 'kor']
  );
  expectRejected(confNoGroup, '23514', 'ck_mb_conf_corrected_group', 'T6 CORRECTED tanpa correction_group_id ditolak');

  // CORRECTED group valid + folio valid → SAH (bukti group-lah satu-satunya yang ditolak di atas)
  const confCorrectedOk = await api(
    `INSERT INTO minibar_billing_confirmation
       (property_id, reservation_id, report_line_id, confirmed_consumed_qty,
        confirmed_subtotal, billing_status, folio_entry_id, original_folio_entry_id,
        correction_group_id, reduction_reason)
     VALUES ($1,$2,$3, 1, 10000, 'CORRECTED', $4, $5, $6, $7) RETURNING id`,
    [propId, res, ln3.rows[0].id, FOLIO_A, FOLIO_B, 'CORR-' + RUN, 'koreksi qty']
  );
  expect(confCorrectedOk.rowCount === 1, 'T6 CORRECTED group valid + folio valid → diterima');
  tracked.confIds.push(confCorrectedOk.rows[0].id);

  // VOIDED tanpa folio → ck_mb_conf_voided_corrected.
  // Pakai ln2 (belum dikonsumsi — confNoReason ditolak, tidak consuming).
  const confVoidNoFolio = await tryInsert(
    `INSERT INTO minibar_billing_confirmation
       (property_id, reservation_id, report_line_id, confirmed_consumed_qty,
        confirmed_subtotal, billing_status, reduction_reason)
     VALUES ($1,$2,$3, 1, 10000, 'VOIDED', $4)`,
    [propId, res, ln2.rows[0].id, 'void']
  );
  expectRejected(confVoidNoFolio, '23514', 'ck_mb_conf_voided_corrected', 'T6 VOIDED tanpa folio ditolak');

  // billing_status di luar union T6 (PENDING milik T5, bukan T6).
  // UNIQUE per (property_id, report_line_id) → butuh line baru di property baru.
  const prop2 = await createTestProperty();
  const room2 = await createTestRoom(prop2);
  const res2 = await createTestReservation(prop2, room2);
  const task3 = await createTestTask(prop2);
  const rep2 = await api(
    `INSERT INTO minibar_inspection_report
       (property_id, reservation_id, room_id, task_id, status)
     VALUES ($1,$2,$3,$4, 'DRAFT') RETURNING id`,
    [prop2, res2, room2, task3]
  );
  tracked.reportIds.push(rep2.rows[0].id);
  const menu4 = await createTestMenuItem(prop2);
  const lnNew = await api(
    `INSERT INTO minibar_inspection_report_line
       (report_id, property_id, menu_item_id, counted_qty, baseline_status)
     VALUES ($1,$2,$3, 0, 'UNKNOWN') RETURNING id`,
    [rep2.rows[0].id, prop2, menu4]
  );
  tracked.lineIds.push(lnNew.rows[0].id);
  const confBadStatus = await tryInsert(
    `INSERT INTO minibar_billing_confirmation
       (property_id, reservation_id, report_line_id, confirmed_consumed_qty,
        confirmed_subtotal, billing_status)
     VALUES ($1,$2,$3, 0, 0, 'PENDING')`,
    [prop2, res2, lnNew.rows[0].id]
  );
  expectRejected(confBadStatus, '23514', 'ck_mb_conf_billing_status', "T6 billing_status='PENDING' (bukan union T6) ditolak");

  // FK negatif: folio_entry_id menunjuk id yang tidak ada (FK bukan CHECK;
  // 23503 foreign_key_violation). Line yang sama (belum dikonsumsi CHECK-nya).
  const confBadFk = await tryInsert(
    `INSERT INTO minibar_billing_confirmation
       (property_id, reservation_id, report_line_id, confirmed_consumed_qty,
        confirmed_subtotal, billing_status, folio_entry_id, original_folio_entry_id,
        reduction_reason)
     VALUES ($1,$2,$3, 1, 10000, 'POSTED', 999999999, 999999999, 'x')`,
    [prop2, res2, lnNew.rows[0].id]
  );
  expectRejected(confBadFk, '23503', null, 'T6 folio FK tidak valid ditolak (23503)');
}

async function testResidueCheck() {
  console.log('\n[TEST 8] Residu = 0');
  await cleanup();

  const tables = [
    'room_type_minibar_standard',
    'minibar_baseline_verification',
    'minibar_stay_event',
    'minibar_inspection_report',
    'minibar_inspection_report_line',
    'minibar_billing_confirmation',
  ];
  for (const t of tables) {
    const r = await api(`SELECT COUNT(*)::int AS cnt FROM ${t}`);
    const cnt = (r.rows[0]?.cnt ?? 0);
    expect(cnt === 0, `Residu ${t} = 0 (got: ${cnt})`);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  // Verifikasi koneksi & identitas SEBELUM mutasi apa pun
  try {
    await pool.query('SELECT 1');
    console.log('[MINIBAR FOUNDATION TEST] Koneksi DB terverifikasi.');
    await verifyConnectionIdentity();
  } catch (err) {
    console.error('[MINIBAR FOUNDATION TEST] Koneksi/identitas DB gagal: ' + err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  }

  try {
    await testFreshMigration();
    if (freshFailed) {
      // Fresh migration gagal → HENTIKAN suite yang membutuhkan schema.
      // Tidak menjalankan TEST 2–8; hanya cleanup + laporan gagal.
      console.error(
        '\n[MINIBAR FOUNDATION TEST] Fresh migration GAGAL — suite dihentikan ' +
        '(suite berikutnya membutuhkan schema minibar).'
      );
    } else {
      await testRerun();
      await testMarkerRemoved();
      await testRollbackOnMissingMarkerPath();
      await testSchemaMismatchRollback();
      await testRumusBaseline();
      await testScopeIsolation();
      await testConstraintInserts();
      await testResidueCheck();
    }
  } finally {
    // Residu = 0: bersihkan fixture apa pun (baik sukses maupun gagal)
    await cleanup();
    await pool.end();
  }

  console.log('\n' + '='.repeat(60));
  console.log(`[MINIBAR FOUNDATION TEST] Hasil: ${passed} PASS, ${failed} FAIL`);
  if (errors.length) {
    console.error('Errors:');
    for (const e of errors) console.error('  - ' + e);
  }
  // Error cleanup/residu WAJIB membuat test gagal
  process.exit(failed > 0 || cleanupFailed ? 1 : 0);
}

main();

/**
 * POS Order Foundation — Tahap A (Fondasi Idempotency Domain)
 *
 * DB safety guard (pola repo, identik dengan master_product_management_test.js):
 * - TEST_DATABASE_URL eksplisit: postgres://, localhost/127.0.0.1, port eksplisit,
 *   user & password lengkap, database berakhiran '_test'.
 * - Tanpa query parameter, tanpa fallback .env / DB_* / PG*.
 * - Menolak nama DB/user mengandung staging|production|prod|live.
 * - Verifikasi pool.options dan identitas DB SEBELUM mutasi.
 * - Tanpa initialize/reset/migration schema (migration sudah di-apply terpisah).
 *
 * Cakupan suite:
 *  1. Bypass cache global: POST /api/pos/orders TIDAK melewati idempotency_keys.
 *  2. Auth/scope: replay tanpa token ditolak; cross-property ditolak sebelum replay.
 *  3. Concurrent: key+payload sama → satu order + replay; konkuren → satu order.
 *  4. Konflik fingerprint: key sama + payload berbeda → 409.
 *  5. Retry setelah commit tanpa respons: retry key sama → replay, tetap satu order.
 *  6. Validasi quantity integer positif + produk aktif + rollback tanpa order parsial.
 *  7. Order OPEN tidak menambah transaksi/folio.
 *  8. GET filter reservation_id + ownership check.
 *  9. Format order_number: POS-YYYYMMDD-<UUID penuh> (49 char, muat VARCHAR(50)).
 * 10. Konkuren key BERBEDA: semua 201, ID & order_number unik, tanpa order hilang.
 * 11. GET cross-property scope: token A → properti B existing maupun nonexistent → 403.
 * 12. Replay setelah produk nonaktif: 200 snapshot lama; key baru → 404; payload beda → 409.
 * 13. Filter & ownership reservasi: GET/POST dengan reservation_id (A1, A2, B, malformed, 404).
 * 14. Produk tidak valid: tidak ditemukan (404) & cross-property (403), tanpa order parsial.
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test \
 *   node backend/test/pos_order_foundation_test.js
 */

'use strict';

const crypto = require('crypto');

// ─── DB SAFETY GUARD ─────────────────────────────────────────────────────────
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !testUrl.trim()) {
  console.error(
    'SAFETY: TEST_DATABASE_URL tidak di-set.\n' +
    'Jalankan: TEST_DATABASE_URL=postgres://USER:PASS@localhost:PORT/<db>_test ' +
    'node backend/test/pos_order_foundation_test.js'
  );
  process.exit(1);
}

const FORBIDDEN = ['staging', 'production', 'prod', 'live'];
let target;
try {
  const u = new URL(testUrl.trim());
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new Error('protocol wajib postgres/postgresql');
  }
  if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
    throw new Error(`host wajib localhost/127.0.0.1 (diterima: ${u.hostname})`);
  }
  if (u.searchParams.size > 0) {
    const keys = [...u.searchParams.keys()].join(', ');
    throw new Error(`query parameter tidak didukung: "${keys}"`);
  }
  const user = u.username ? decodeURIComponent(u.username) : '';
  const password = u.password ? decodeURIComponent(u.password) : '';
  const database = u.pathname ? decodeURIComponent(u.pathname.replace(/^\//, '')) : '';
  if (!user) throw new Error('user wajib lengkap');
  if (!password) throw new Error('password wajib lengkap');
  if (!/^[a-z0-9_]+_test$/.test(database.toLowerCase())) {
    throw new Error(`database wajib berakhiran "_test" (diterima: ${database})`);
  }
  if (FORBIDDEN.some((p) => database.toLowerCase().includes(p))) {
    throw new Error('indikator staging/production/live terdeteksi');
  }
  if (!u.port) throw new Error('port wajib eksplisit (tanpa fallback 5432)');
  const port = Number(u.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`port tidak valid (diterima: ${u.port})`);
  }
  target = { host: u.hostname, port, user, database, password };
  console.log(`[POS FOUNDATION TEST] Target DB: ${database} (user: ${user}, port: ${port})`);
} catch (e) {
  console.error('SAFETY: TEST_DATABASE_URL ditolak — ' + e.message);
  process.exit(1);
}

process.env.DB_HOST = target.host;
process.env.DB_PORT = String(target.port);
process.env.DB_USER = target.user;
process.env.DB_PASSWORD = target.password;
process.env.DB_NAME = target.database;
process.env.RUN_SCHEMA_INITIALIZATION = 'false';

const http = require('http');
const { once } = require('events');
const { app, pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');

let server;
let baseUrl;
let passed = 0;
let failed = 0;

// ── Tracked fixture IDs untuk cleanup deterministik ────────────────────────
const tracked = {
  properties: [],
  users: [],
  roles: [],
  items: [],
  categories: [],
  bookings: [],
  reservations: [],
  orders: [],
  idempotencyKeys: [],
};

// ── Identitas unik per run (menghindari kolisi run paralel/berurutan) ──────
// properties.property_code: VARCHAR(6) + CHECK ^[A-Z0-9]{2,6}$
// users.username: VARCHAR(100); users.email: VARCHAR(150)
// roles.name: VARCHAR(50)
// pos_menu_items.item_code: VARCHAR(50); name: VARCHAR(100)
const RUN_ID = Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
const RUN_4 = RUN_ID.slice(0, 4); // 4 char [A-Z0-9] untuk property_code (dengan suffix = 5 char)
const runCode = (suffix) => `${RUN_4}${suffix}`; // maks 5 char, semua [A-Z0-9]

// ── Assertion helper ────────────────────────────────────────────────────────
function expect(condition, msg) {
  if (condition) { passed += 1; console.log('PASS | ' + msg); }
  else { failed += 1; console.error('FAIL | ' + msg); }
}

// ── HTTP helper (AbortController timeout, Idempotency-Key & Authorization) ─
const HTTP_TIMEOUT_MS = 15000;
async function api(method, path, body, opts) {
  const headers = { 'Content-Type': 'application/json' };
  const auth = opts && opts.auth;
  if (auth) headers.Authorization = `Bearer ${auth}`;
  const idempKey = opts && opts.idempotencyKey;
  if (idempKey) headers['Idempotency-Key'] = idempKey;
  const finalOpts = { method, headers };
  if (body !== undefined && body !== null && method !== 'GET') {
    finalOpts.body = JSON.stringify(body);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  finalOpts.signal = controller.signal;
  try {
    const res = await fetch(baseUrl + path, finalOpts);
    const json = await res.json().catch(() => null);
    return { status: res.status, json, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

// ── HTTP helper RAW (tanpa membaca body) untuk simulasi "respons tidak dibaca" ─
// Mengembalikan { status, response } supaya caller bisa me-release body.
async function apiRaw(method, path, body, opts) {
  const headers = { 'Content-Type': 'application/json' };
  const auth = opts && opts.auth;
  if (auth) headers.Authorization = `Bearer ${auth}`;
  const idempKey = opts && opts.idempotencyKey;
  if (idempKey) headers['Idempotency-Key'] = idempKey;
  const finalOpts = { method, headers };
  if (body !== undefined && body !== null && method !== 'GET') {
    finalOpts.body = JSON.stringify(body);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  finalOpts.signal = controller.signal;
  try {
    const res = await fetch(baseUrl + path, finalOpts);
    // Sengaja TIDAK membaca res.json() di sini — caller yang memutuskan.
    return { status: res.status, response: res };
  } finally {
    clearTimeout(timer);
  }
}

// ── Cleanup (dipanggil di finally) ──────────────────────────────────────────
async function cleanup() {
  const client = await pool.connect();
  const errors = [];
  // pos_order_items dihapus berdasarkan tracked.orders (order_id),
  // bukan ID item terpisah — FK order_id → pos_orders.id.
  // idempotency_keys global hanya dihapus untuk key milik run ini (tracked).
  const steps = [
    ['pos_order_items', 'DELETE FROM pos_order_items WHERE order_id = $1', tracked.orders],
    ['pos_orders', 'DELETE FROM pos_orders WHERE id = $1', tracked.orders],
    ['pos_menu_items', 'DELETE FROM pos_menu_items WHERE id = $1', tracked.items],
    ['pos_menu_categories', 'DELETE FROM pos_menu_categories WHERE id = $1', tracked.categories],
    ['reservations', 'DELETE FROM reservations WHERE id = $1', tracked.reservations],
    ['bookings', 'DELETE FROM bookings WHERE id = $1', tracked.bookings],
    ['users', 'DELETE FROM users WHERE id = $1', tracked.users],
    ['role_permissions', 'DELETE FROM role_permissions WHERE role_id = $1', tracked.roles],
    ['roles', 'DELETE FROM roles WHERE id = $1', tracked.roles],
    ['properties', 'DELETE FROM properties WHERE id = $1', tracked.properties],
  ];
  try {
    for (const [label, sql, ids] of steps) {
      for (const id of ids) {
        try {
          await client.query(sql, [id]);
        } catch (e) {
          errors.push(`${label}[id=${id}]: ${e.message}`);
          console.error('CLEANUP ERROR | ' + `${label}[id=${id}]: ${e.message}`);
        }
      }
    }
    // idempotency_keys: hanya key fixture milik run ini (tracked, unik per run).
    for (const key of tracked.idempotencyKeys) {
      try {
        await client.query('DELETE FROM idempotency_keys WHERE key = $1', [key]);
      } catch (e) {
        errors.push(`idempotency_keys[key=${key}]: ${e.message}`);
        console.error('CLEANUP ERROR | ' + `idempotency_keys[key=${key}]: ${e.message}`);
      }
    }
  } finally {
    client.release();
  }
  if (errors.length > 0) {
    failed += 1;
    console.error(`CLEANUP: ${errors.length} langkah gagal. Residu mungkin tersisa.`);
  }
}

// ── Verifikasi residu nol ───────────────────────────────────────────────────
async function verifyResidue() {
  const client = await pool.connect();
  try {
    for (const [label, table, idCol, ids] of [
      ['orders', 'pos_orders', 'id', tracked.orders],
      ['order_items', 'pos_order_items', 'order_id', tracked.orders],
      ['menu_items', 'pos_menu_items', 'id', tracked.items],
      ['menu_categories', 'pos_menu_categories', 'id', tracked.categories],
      ['reservations', 'reservations', 'id', tracked.reservations],
      ['bookings', 'bookings', 'id', tracked.bookings],
      ['users', 'users', 'id', tracked.users],
      ['roles', 'roles', 'id', tracked.roles],
      ['role_permissions', 'role_permissions', 'role_id', tracked.roles],
      ['properties', 'properties', 'id', tracked.properties],
      ['idempotency_keys', 'idempotency_keys', 'key', tracked.idempotencyKeys],
    ]) {
      for (const id of ids) {
        const r = await client.query(
          `SELECT COUNT(*)::int AS c FROM ${table} WHERE ${idCol} = $1`,
          [id]
        );
        if (r.rows[0].c > 0) {
          failed += 1;
          console.error(`RESIDUE | ${label}[${id}] = ${r.rows[0].c} baris tersisa`);
        }
      }
    }
  } finally {
    client.release();
  }
}

// ── Fixture: create user + role dengan permission POS untuk property ──────
// Key permission yang benar (bukan 'POS'): pos.view, pos.create, pos.edit.
// Lihat: accessControlService.ts RESOURCE_PERMISSION_KEYS.POS dan seed schema_v3.ts.
const POS_PERMISSION_KEYS = ['pos.view', 'pos.create', 'pos.edit'];
async function createPosUser(client, propertyId, tag) {
  const roleRes = await client.query(
    `INSERT INTO roles (property_id, name, is_system_role, is_active)
     VALUES ($1, $2, FALSE, TRUE) RETURNING id`,
    [propertyId, `POSF-${tag}-ROLE`]
  );
  const roleId = roleRes.rows[0].id;
  tracked.roles.push(roleId);

  const userRes = await client.query(
    `INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING id`,
    [
      propertyId,
      roleId,
      `posf_${RUN_ID}_${tag.toLowerCase()}`.slice(0, 100),
      `posf_${RUN_ID}_${tag.toLowerCase()}@oak.test`.slice(0, 150),
      'x',
      `POSF ${tag}`,
    ]
  );
  const userId = userRes.rows[0].id;
  tracked.users.push(userId);

  // Grant permission POS — gagal eksplisit bila key tidak ditemukan di DB.
  const permRes = await client.query(
    `SELECT id, key FROM permissions WHERE key = ANY($1)`,
    [POS_PERMISSION_KEYS]
  );
  if (permRes.rows.length === 0) {
    await client.query('ROLLBACK');
    throw new Error(
      `FIXTURE GAGAL: permission key ${POS_PERMISSION_KEYS.join(', ')} tidak ada di tabel permissions. ` +
      'Seed permissions (schema_v3) belum diterapkan atau DB bermigrasi tidak lengkap.'
    );
  }
  const missing = new Set(POS_PERMISSION_KEYS);
  for (const p of permRes.rows) {
    missing.delete(p.key);
  }
  if (missing.size > 0) {
    await client.query('ROLLBACK');
    throw new Error(`FIXTURE GAGAL: permission key tidak ditemukan: ${[...missing].join(', ')}`);
  }
  for (const p of permRes.rows) {
    await client.query(
      `INSERT INTO role_permissions (role_id, permission_id, granted, created_by)
       VALUES ($1, $2, TRUE, 'posf-test')
       ON CONFLICT (role_id, permission_id) DO NOTHING`,
      [roleId, p.id]
    );
  }
  return { userId, roleId };
}

// ── Token helper ────────────────────────────────────────────────────────────
function tokenFor(userId, propertyId) {
  return generateToken({
    id: userId,
    email: `posf_${userId}@oak.test`,
    username: `posf_${userId}`,
    full_name: `POSF ${userId}`,
    role: 'Front Office',
    role_id: null,
    property_id: propertyId,
    scope: 'FULL',
  });
}

// ── Verifikasi identitas DB & pool.options SEBELUM mutasi apa pun ──────────
async function verifyDbIdentity() {
  // 1) pool.options harus persis sesuai target (tidak ada fallback env).
  const mismatches = [
    ['host', pool.options.host, target.host],
    ['port', String(pool.options.port), String(target.port)],
    ['user', pool.options.user, target.user],
    ['database', pool.options.database, target.database],
  ].filter(([, a, b]) => String(a ?? '').toLowerCase() !== String(b ?? '').toLowerCase());
  if (mismatches.length > 0) {
    for (const [field, got, want] of mismatches) {
      console.error(`SAFETY DITOLAK: pool.options.${field}="${got}" != target "${want}"`);
    }
    process.exit(1);
  }

  // 2) Probe identitas server aktual.
  const client = await pool.connect();
  try {
    const r = await client.query(
      'SELECT current_database() AS db, current_user AS usr, inet_server_addr() AS srv_host, inet_server_port() AS srv_port'
    );
    const row = r.rows[0] || {};
    const db = (row.db ?? '').toLowerCase();
    const usr = (row.usr ?? '').toLowerCase();
    if (db !== target.database.toLowerCase()) {
      console.error(`SAFETY DITOLAK: current_database "${row.db}" != target "${target.database}"`);
      process.exit(1);
    }
    if (usr !== target.user.toLowerCase()) {
      console.error(`SAFETY DITOLAK: current_user "${row.usr}" != target "${target.user}"`);
      process.exit(1);
    }
    if (!/^[a-z0-9_]+_test$/.test(db)) {
      console.error(`SAFETY DITOLAK: database aktual "${row.db}" bukan *_test`);
      process.exit(1);
    }
    // Tolak indikator forbidden pada database DAN user.
    if (FORBIDDEN.some((p) => db.includes(p) || usr.includes(p))) {
      console.error(`SAFETY DITOLAK: database/user terindikasi staging/prod/live`);
      process.exit(1);
    }
    console.log(
      `[POS FOUNDATION TEST] DB terverifikasi: db=${row.db} user=${row.usr} ` +
      `server=${row.srv_host || 'n/a'}:${row.srv_port ?? 'n/a'}`
    );
  } finally {
    client.release();
  }
}

// ── Discovery order berdasarkan property fixture / key test ────────────────
// Untuk cleanup kasus respons hilang (order sudah commit tapi ID tidak diterima
// client): carilah order dengan property_id milik fixture ini.
// HANYA hapus baris yang property_id-nya ada di tracked.properties —
// jangan sentuh data properti lain.
async function discoverAndTrackOrders() {
  const client = await pool.connect();
  try {
    if (tracked.properties.length === 0) return;
    const r = await client.query(
      `SELECT id FROM pos_orders WHERE property_id = ANY($1)`,
      [tracked.properties]
    );
    for (const row of r.rows) {
      if (!tracked.orders.includes(row.id)) {
        tracked.orders.push(row.id);
      }
    }
  } finally {
    client.release();
  }
}

// ── Fixture: create user TANPA permission POS (untuk skenario 403) ─────────
async function createPosUserNoPerm(client, propertyId, tag) {
  const roleRes = await client.query(
    `INSERT INTO roles (property_id, name, is_system_role, is_active)
     VALUES ($1, $2, FALSE, TRUE) RETURNING id`,
    [propertyId, `POSF-${tag}-NOPEM-ROLE`]
  );
  const roleId = roleRes.rows[0].id;
  tracked.roles.push(roleId);

  const userRes = await client.query(
    `INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING id`,
    [
      propertyId,
      roleId,
      `posf_${RUN_ID}_nope_${tag.toLowerCase()}`.slice(0, 100),
      `posf_${RUN_ID}_nope_${tag.toLowerCase()}@oak.test`.slice(0, 150),
      'x',
      `POSF NoPerm ${tag}`,
    ]
  );
  const userId = userRes.rows[0].id;
  tracked.users.push(userId);

  // TIDAK grant permission POS — sengaja dikosongkan untuk test 403.
  return { userId, roleId };
}

// ── Fixture: user dengan permission 'Master Produk' (inventory.view/create/edit) ──
// Dipakai Skenario 20 (regresi middleware global di POST /api/pos/menu/items).
// createOperationalAccessGuard untuk /api/pos/menu/items resource 'Master Produk'
// mensyaratkan inventory.edit (action=edit).
async function createMasterProdukUser(client, propertyId, tag) {
  const MP_KEYS = ['inventory.view', 'inventory.create', 'inventory.edit'];

  const roleRes = await client.query(
    `INSERT INTO roles (property_id, name, is_system_role, is_active)
     VALUES ($1, $2, FALSE, TRUE) RETURNING id`,
    [propertyId, `POSF-${tag}-MP-ROLE`]
  );
  const roleId = roleRes.rows[0].id;
  tracked.roles.push(roleId);

  const userRes = await client.query(
    `INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING id`,
    [
      propertyId,
      roleId,
      `posf_${RUN_ID}_${tag.toLowerCase()}_mp`.slice(0, 100),
      `posf_${RUN_ID}_${tag.toLowerCase()}_mp@oak.test`.slice(0, 150),
      'x',
      `POSF MP ${tag}`,
    ]
  );
  const userId = userRes.rows[0].id;
  tracked.users.push(userId);

  const permRes = await client.query(
    `SELECT id, key FROM permissions WHERE key = ANY($1)`,
    [MP_KEYS]
  );
  const missing = new Set(MP_KEYS);
  for (const p of permRes.rows) {
    missing.delete(p.key);
    await client.query(
      `INSERT INTO role_permissions (role_id, permission_id, granted, created_by)
       VALUES ($1, $2, TRUE, 'posf-mp-test')
       ON CONFLICT (role_id, permission_id) DO NOTHING`,
      [roleId, p.id]
    );
  }
  if (missing.size > 0) {
    await client.query('ROLLBACK');
    throw new Error(`FIXTURE GAGAL: permission key Master Produk tidak ditemukan: ${[...missing].join(', ')}`);
  }
  return { userId, roleId };
}

// ── Setup fixtures (properti + user POS + menu items) ──────────────────────
async function setupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Dua properti terisolasi — identitas unik per run (RUN_ID global).
    const propA = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ($1, $2, 'Asia/Jakarta', 'IDR', $3, TRUE) RETURNING id`,
      [`POSF ${runCode('A')}`, runCode('A'), `Addr ${runCode('A')}`]
    );
    const pidA = propA.rows[0].id;
    tracked.properties.push(pidA);

    const propB = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ($1, $2, 'Asia/Jakarta', 'IDR', $3, TRUE) RETURNING id`,
      [`POSF ${runCode('B')}`, runCode('B'), `Addr ${runCode('B')}`]
    );
    const pidB = propB.rows[0].id;
    tracked.properties.push(pidB);

    // Menu categories & items per properti (kode unik per run).
    const catA = await client.query(
      'INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, $2) RETURNING id',
      [pidA, `POSF ${runCode('A')} Cat`]
    );
    tracked.categories.push(catA.rows[0].id);

    const itemA = await client.query(
      'INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, is_active) VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id',
      [pidA, catA.rows[0].id, `${runCode('A')}A1`, 'Item A', 25000]
    );
    tracked.items.push(itemA.rows[0].id);

    const itemA2 = await client.query(
      'INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, is_active) VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id',
      [pidA, catA.rows[0].id, `${runCode('A')}A2`, 'Item A2', 15000]
    );
    tracked.items.push(itemA2.rows[0].id);

    const catB = await client.query(
      'INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, $2) RETURNING id',
      [pidB, `POSF ${runCode('B')} Cat`]
    );
    tracked.categories.push(catB.rows[0].id);

    const itemB = await client.query(
      'INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, is_active) VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id',
      [pidB, catB.rows[0].id, `${runCode('B')}B1`, 'Item B', 30000]
    );
    tracked.items.push(itemB.rows[0].id);

    // User POS dengan permission per properti
    const userA = await createPosUser(client, pidA, 'A');
    const userB = await createPosUser(client, pidB, 'B');

    // User tanpa permission POS (untuk skenario 403)
    const userNoPerm = await createPosUserNoPerm(client, pidA, 'NP');

    // User Master Produk (inventory.edit + inventory.create) — untuk Skenario 20
    const userMp = await createMasterProdukUser(client, pidA, 'MP');

    // ─── Booking & Reservation fixtures ───────────────────────────────────
    // bookings.bid: CHECK ^[A-Z0-9-]+$ (tanpa lowercase), UNIQUE.
    // Gunakan prefix RUN_4 + tag agar unik per run.
    const bidBase = `${RUN_4}-POSF`;

    // Property A: 2 booking + 2 reservation
    const bkA1 = await client.query(
      `INSERT INTO bookings (bid, property_id, guest_name_snapshot)
       VALUES ($1, $2, $3) RETURNING id`,
      [`${bidBase}-A1`, pidA, 'Guest A1']
    );
    tracked.bookings.push(bkA1.rows[0].id);

    const rsA1 = await client.query(
      `INSERT INTO reservations (booking_id, stay_sequence, guest_name)
       VALUES ($1, 1, $2) RETURNING id`,
      [bkA1.rows[0].id, 'Guest A1']
    );
    tracked.reservations.push(rsA1.rows[0].id);

    const bkA2 = await client.query(
      `INSERT INTO bookings (bid, property_id, guest_name_snapshot)
       VALUES ($1, $2, $3) RETURNING id`,
      [`${bidBase}-A2`, pidA, 'Guest A2']
    );
    tracked.bookings.push(bkA2.rows[0].id);

    const rsA2 = await client.query(
      `INSERT INTO reservations (booking_id, stay_sequence, guest_name)
       VALUES ($1, 1, $2) RETURNING id`,
      [bkA2.rows[0].id, 'Guest A2']
    );
    tracked.reservations.push(rsA2.rows[0].id);

    // Property B: 1 booking + 1 reservation
    const bkB1 = await client.query(
      `INSERT INTO bookings (bid, property_id, guest_name_snapshot)
       VALUES ($1, $2, $3) RETURNING id`,
      [`${bidBase}-B1`, pidB, 'Guest B1']
    );
    tracked.bookings.push(bkB1.rows[0].id);

    const rsB1 = await client.query(
      `INSERT INTO reservations (booking_id, stay_sequence, guest_name)
       VALUES ($1, 1, $2) RETURNING id`,
      [bkB1.rows[0].id, 'Guest B1']
    );
    tracked.reservations.push(rsB1.rows[0].id);

    await client.query('COMMIT');
    return {
      pidA, pidB,
      itemA: itemA.rows[0].id,
      itemA2: itemA2.rows[0].id,
      itemB: itemB.rows[0].id,
      userA: userA.userId,
      userB: userB.userId,
      userNoPerm: userNoPerm.userId,
      userMp: userMp.userId,
      noPermRoleId: userNoPerm.roleId,
      // Booking & Reservation fixture
      bkA1: bkA1.rows[0].id,
      rsA1: rsA1.rows[0].id,
      bkA2: bkA2.rows[0].id,
      rsA2: rsA2.rows[0].id,
      bkB1: bkB1.rows[0].id,
      rsB1: rsB1.rows[0].id,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ── Count helper (per property + source_type='POS') ────────────────────────
async function countRows(table, whereSql, params) {
  const client = await pool.connect();
  try {
    const r = await client.query(
      `SELECT COUNT(*)::int AS c FROM ${table} WHERE ${whereSql}`,
      params
    );
    return r.rows[0].c;
  } finally {
    client.release();
  }
}

// ── main() ─────────────────────────────────────────────────────────────────
async function main() {
  // 1) Verifikasi identitas DB SEBELUM fixture/mutasi apa pun.
  await verifyDbIdentity();

  // 2) Periksa prasyarat schema: kolom idempotency & permission.
  const client = await pool.connect();
  try {
    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'pos_orders' AND table_schema = 'public'
       AND column_name IN ('idempotency_key', 'request_fingerprint')`
    );
    const colNames = cols.rows.map((r) => r.column_name);
    expect(
      colNames.includes('idempotency_key') && colNames.includes('request_fingerprint'),
      `Prasyarat: kolom idempotency di pos_orders (ada: ${colNames.join(', ') || 'NONE'})`
    );
    if (colNames.length < 2) {
      console.error('SKENARIO: prasyarat tidak terpenuhi, lanjut tanpa idempotency test.');
    }

    const permCheck = await client.query(
      `SELECT key FROM permissions WHERE key = ANY($1)`,
      [POS_PERMISSION_KEYS]
    );
    expect(
      permCheck.rows.length === POS_PERMISSION_KEYS.length,
      `Prasyarat: permission ${POS_PERMISSION_KEYS.join(', ')} ada di DB (ditemukan: ${permCheck.rows.length})`
    );
  } finally {
    client.release();
  }

  // 3) Setup fixture.
  let fx;
  try {
    fx = await setupFixtures();
    console.log('[FIXTURE] setup OK:', JSON.stringify({ pidA: fx.pidA, pidB: fx.pidB }));
  } catch (e) {
    console.error('[FIXTURE] GAGAL:', e.message);
    await cleanup();
    process.exit(1);
  }

  // 4) Start server pada port 0.
  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  console.log(`[SERVER] listening di ${baseUrl}`);

  // Token helpers
  const tokenA = tokenFor(fx.userA, fx.pidA);
  const tokenB = tokenFor(fx.userB, fx.pidB);
  const tokenNoPerm = tokenFor(fx.userNoPerm, fx.pidA);

  let txnBefore = 0;
  let folioBefore = 0;

  try {
    // ─── Skenario 1: GET/POST tanpa token → 401 ───────────────────────────
    console.log('\n── Skenario 1: Tanpa token ──');
    {
      const rGet = await api('GET', `/api/pos/orders?property_id=${fx.pidA}`);
      expect(
        rGet.status === 401,
        `GET tanpa token → 401 (dapat: ${rGet.status})`
      );

      const rPost = await api('POST', '/api/pos/orders', {
        property_id: fx.pidA,
        items: [{ menu_item_id: fx.itemA, quantity: 1 }],
      });
      expect(
        rPost.status === 401,
        `POST tanpa token → 401 (dapat: ${rPost.status})`
      );
    }

    // ─── Skenario 2: User tanpa permission → 403 ─────────────────────────
    console.log('\n── Skenario 2: Tanpa permission POS ──');
    {
      const rGet = await api('GET', `/api/pos/orders?property_id=${fx.pidA}`, null, { auth: tokenNoPerm });
      expect(
        rGet.status === 403,
        `GET tanpa permission → 403 (dapat: ${rGet.status})`
      );

      const rPost = await api('POST', '/api/pos/orders', {
        property_id: fx.pidA,
        items: [{ menu_item_id: fx.itemA, quantity: 1 }],
      }, { auth: tokenNoPerm });
      expect(
        rPost.status === 403,
        `POST tanpa permission → 403 (dapat: ${rPost.status})`
      );
    }

    // ─── Skenario 3: Cross-property → 403, tanpa perubahan DB ────────────
    console.log('\n── Skenario 3: Cross-property ──');
    {
      const ordersBefore = await countRows('pos_orders', 'property_id = $1', [fx.pidB]);

      const rGet = await api('GET', `/api/pos/orders?property_id=${fx.pidB}`, null, { auth: tokenA });
      expect(
        rGet.status === 403,
        `GET properti B dengan token A → 403 (dapat: ${rGet.status})`
      );

      const rPost = await api('POST', '/api/pos/orders', {
        property_id: fx.pidB,
        items: [{ menu_item_id: fx.itemB, quantity: 1 }],
      }, { auth: tokenA });
      expect(
        rPost.status === 403,
        `POST properti B dengan token A → 403 (dapat: ${rPost.status})`
      );

      // GET properti B (existing) dengan token A → 403, tanpa data order.
      // (assertPropertyScope sekarang berjalan SEBELUM query keberadaan properti,
      //  jadi properti B ada atau tidak, token A → properti B selalu 403.)
      expect(
        rGet.json && !rGet.json.data,
        `GET properti B dengan token A tidak membawa data order (data: ${rGet.json ? JSON.stringify(rGet.json.data ?? null) : 'null'})`
      );

      // GET properti nonexistent (id sangat besar) dengan token A → 403, bukan 404.
      // Menjamin scope check benar-benar mendahului query properti.
      const rNonexist = await api('GET', '/api/pos/orders?property_id=999999', null, { auth: tokenA });
      expect(
        rNonexist.status === 403,
        `GET properti nonexistent dengan token A → 403, bukan 404 (dapat: ${rNonexist.status})`
      );
      expect(
        rNonexist.json && !rNonexist.json.data,
        `GET properti nonexistent tidak membawa data order`
      );

      const ordersAfter = await countRows('pos_orders', 'property_id = $1', [fx.pidB]);
      expect(
        ordersBefore === ordersAfter,
        `Cross-property tidak menambah order di properti B (sebelum: ${ordersBefore}, setelah: ${ordersAfter})`
      );
    }

    // ─── Skenario 4: CREATE properti sendiri → status OPEN ──────────────
    console.log('\n── Skenario 4: Create order properti sendiri ──');
    {
      txnBefore = await countRows('transactions', "property_id = $1 AND source_type = 'POS'", [fx.pidA]);
      folioBefore = await countRows('folio_entries', "property_id = $1 AND source_type = 'POS'", [fx.pidA]);

      // Payload dengan status PAID — backend tetap paksa OPEN.
      const rPost = await api('POST', '/api/pos/orders', {
        property_id: fx.pidA,
        status: 'PAID',  // sengaja coba override — backend harus abaikan
        items: [{ menu_item_id: fx.itemA, quantity: 2 }],
      }, { auth: tokenA });

      expect(
        rPost.status === 201,
        `POST create → 201 (dapat: ${rPost.status})`
      );
      const order = rPost.json && rPost.json.data;
      expect(
        order && order.status === 'OPEN',
        `Status dipaksa OPEN meskipun payload PAID (dapat: ${order ? order.status : 'null'})`
      );

      if (order) {
        tracked.orders.push(order.id);
      }

      // Harga dari backend, bukan payload — cek pos_order_items.unit_price
      const itemPrice = await countRows(
        'pos_order_items',
        'order_id = $1 AND unit_price = 25000',
        [order ? order.id : -1]
      );
      expect(
        itemPrice === 1,
        `unit_price di pos_order_items = 25000 (harga master backend, bukan payload) — baris ditemukan: ${itemPrice}`
      );

      // Regresi format order_number: POS-YYYYMMDD-<UUID(36 char)> = 49 char, muat VARCHAR(50).
      // Pastikan UUID penuh (tidak dipotong) dan prefix tanggal benar.
      if (order && order.order_number) {
        const on = order.order_number;
        expect(
          /^POS-\d{8}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(on),
          `format order_number = POS-YYYYMMDD-<UUID penuh> (dapat: "${on}")`
        );
        expect(
          on.length <= 50,
          `panjang order_number ≤ 50 (VARCHAR kolom) (dapat: ${on.length})`
        );
      }
    }

    // ─── Skenario 5: Order OPEN tidak menambah transaksi/folio ───────────
    console.log('\n── Skenario 5: OPEN tidak memicu transaksi/folio ──');
    {
      const txnAfter = await countRows('transactions', "property_id = $1 AND source_type = 'POS'", [fx.pidA]);
      const folioAfter = await countRows('folio_entries', "property_id = $1 AND source_type = 'POS'", [fx.pidA]);
      expect(
        txnAfter === txnBefore,
        `transactions tidak bertambah setelah order OPEN (sebelum: ${txnBefore}, setelah: ${txnAfter})`
      );
      expect(
        folioAfter === folioBefore,
        `folio_entries tidak bertambah setelah order OPEN (sebelum: ${folioBefore}, setelah: ${folioAfter})`
      );
    }

    // ─── Skenario 6: Quantity invalid → 400, tanpa order/item parsial ───
    console.log('\n── Skenario 6: Quantity invalid ──');
    {
      const badQuantities = [0, -1, 0.5, 'abc'];
      for (const qty of badQuantities) {
        const beforeOrders = await countRows('pos_orders', 'property_id = $1', [fx.pidA]);
        const beforeItems = await countRows('pos_order_items', 'order_id IN (SELECT id FROM pos_orders WHERE property_id = $1)', [fx.pidA]);

        const r = await api('POST', '/api/pos/orders', {
          property_id: fx.pidA,
          items: [{ menu_item_id: fx.itemA, quantity: qty }],
        }, { auth: tokenA });

        const label = JSON.stringify(qty);
        expect(
          r.status === 400,
          `quantity=${label} → 400 (dapat: ${r.status})`
        );

        const afterOrders = await countRows('pos_orders', 'property_id = $1', [fx.pidA]);
        const afterItems = await countRows('pos_order_items', 'order_id IN (SELECT id FROM pos_orders WHERE property_id = $1)', [fx.pidA]);
        expect(
          afterOrders === beforeOrders && afterItems === beforeItems,
          `quantity=${label}: tanpa order/item parsial (orders ${beforeOrders}→${afterOrders}, items ${beforeItems}→${afterItems})`
        );
      }
    }

    // ─── Skenario 7: GET dengan token A → 200 + data ───────────────────
    console.log('\n── Skenario 7: GET properti sendiri ──');
    {
      const rGet = await api('GET', `/api/pos/orders?property_id=${fx.pidA}`, null, { auth: tokenA });
      expect(
        rGet.status === 200,
        `GET properti A dengan token A → 200 (dapat: ${rGet.status})`
      );
      const data = rGet.json && rGet.json.data;
      expect(
        Array.isArray(data) && data.length >= 1,
        `GET mengembalikan array order (panjang: ${Array.isArray(data) ? data.length : 'non-array'})`
      );
    }

    // ─── Skenario 8: Idempotency — dua POST berurutan, key & payload sama ─
    // Buat order baru dengan Idempotency-Key unik per run; quantity 3 agar
    // berbeda dari Skenario 4 (quantity 2). Kedua request harus menunjuk
    // order yang sama: tepat 1 order, item tidak berlipat.
    console.log('\n── Skenario 8: Idempotency berurutan (key + payload sama) ──');
    {
      const idemKey = `posf_${RUN_ID}_idem1`;
      const payload = {
        property_id: fx.pidA,
        items: [{ menu_item_id: fx.itemA, quantity: 3 }],
      };

      const first = await api('POST', '/api/pos/orders', payload, { auth: tokenA, idempotencyKey: idemKey });
      expect(
        first.status === 201,
        `create pertama → 201 (dapat: ${first.status})`
      );
      const firstOrder = first.json && first.json.data;
      const orderId1 = firstOrder ? firstOrder.id : null;
      expect(
        orderId1 !== null,
        `create pertama mengembalikan order id (dapat: ${orderId1})`
      );
      if (orderId1) tracked.orders.push(orderId1);

      // Item count setelah create pertama.
      const itemCountAfterFirst = await countRows(
        'pos_order_items',
        'order_id = $1 AND menu_item_id = $2',
        [orderId1, fx.itemA]
      );
      expect(
        itemCountAfterFirst === 1,
        `setelah create pertama: tepat 1 baris item (dapat: ${itemCountAfterFirst})`
      );

      // Request kedua: key & payload identik → replay, menunjuk order yang sama.
      const second = await api('POST', '/api/pos/orders', payload, { auth: tokenA, idempotencyKey: idemKey });
      expect(
        second.status === 200,
        `create kedua → 200 replay (dapat: ${second.status})`
      );
      const secondOrder = second.json && second.json.data;
      expect(
        secondOrder && secondOrder.id === orderId1,
        `replay menunjuk order id yang sama (${orderId1}) (dapat: ${secondOrder ? secondOrder.id : 'null'})`
      );

      // Secara agregat: untuk property_id + idempotency_key, tetap hanya 1 order.
      const orderCountByKey = await countRows(
        'pos_orders',
        'property_id = $1 AND idempotency_key = $2',
        [fx.pidA, idemKey]
      );
      expect(
        orderCountByKey === 1,
        `tepat 1 order untuk key "${idemKey}" (dapat: ${orderCountByKey})`
      );

      // Item tidak berlipat setelah replay.
      const itemCountAfterSecond = await countRows(
        'pos_order_items',
        'order_id = $1 AND menu_item_id = $2',
        [orderId1, fx.itemA]
      );
      expect(
        itemCountAfterSecond === 1,
        `item tidak berlipat setelah replay (baris item: ${itemCountAfterSecond})`
      );
    }

    // ─── Skenario 9: Idempotency — key sama, quantity berbeda → 409 ──────
    // Reuse key Skenario 8; ubah quantity (10) sehingga fingerprint berbeda.
    // Harus 409 dengan code konflik aktual; order/items awal tidak berubah.
    console.log('\n── Skenario 9: Konflik fingerprint (key sama, quantity beda) ──');
    {
      const idemKey = `posf_${RUN_ID}_idem1`; // key yang sama dengan Skenario 8.
      const beforeOrders = await countRows('pos_orders', 'property_id = $1', [fx.pidA]);
      const beforeItems = await countRows(
        'pos_order_items',
        'order_id IN (SELECT id FROM pos_orders WHERE property_id = $1)',
        [fx.pidA]
      );

      const conflictPayload = {
        property_id: fx.pidA,
        items: [{ menu_item_id: fx.itemA, quantity: 10 }], // quantity beda → fingerprint beda
      };
      const r = await api('POST', '/api/pos/orders', conflictPayload, { auth: tokenA, idempotencyKey: idemKey });
      expect(
        r.status === 409,
        `key sama + quantity berbeda → 409 (dapat: ${r.status})`
      );
      expect(
        r.json && r.json.code === 'IDEMPOTENCY_KEY_CONFLICT',
        `code konflik aktual = IDEMPOTENCY_KEY_CONFLICT (dapat: ${r.json ? r.json.code : 'null'})`
      );

      const afterOrders = await countRows('pos_orders', 'property_id = $1', [fx.pidA]);
      const afterItems = await countRows(
        'pos_order_items',
        'order_id IN (SELECT id FROM pos_orders WHERE property_id = $1)',
        [fx.pidA]
      );
      expect(
        afterOrders === beforeOrders,
        `order awal tidak bertambah setelah 409 (${beforeOrders}→${afterOrders})`
      );
      expect(
        afterItems === beforeItems,
        `items awal tidak berubah setelah 409 (${beforeItems}→${afterItems})`
      );
    }

    // ─── Skenario 10: Konkurensi — key & payload SAMA per pasangan ───────
    // 20 pasangan, masing-masing 2 request konkuren dengan key & payload identik.
    // Harapkan tepat satu 201 + satu 200, ID sama, satu order, items utuh.
    // 409/500 pada payload identik TIDAK dianggap lulus.
    // Bila gagal: tampilkan status/body aktual dan BERHENTI; jangan mengulang run.
    console.log('\n── Skenario 10: Konkurensi (20 pasangan, key sama per pasangan, berhenti di kegagalan) ──');
    {
      const CONC_PAIRS = 20;
      let concFailed = false;

      for (let pair = 1; pair <= CONC_PAIRS && !concFailed; pair++) {
        const idemKey = `posf_${RUN_ID}_conc${pair}`;
        const payload = {
          property_id: fx.pidA,
          items: [{ menu_item_id: fx.itemA, quantity: 4 }],
        };
        const [ra, rb] = await Promise.all([
          api('POST', '/api/pos/orders', payload, { auth: tokenA, idempotencyKey: idemKey }),
          api('POST', '/api/pos/orders', payload, { auth: tokenA, idempotencyKey: idemKey }),
        ]);

        const statuses = [ra.status, rb.status].slice().sort((a, b) => a - b);
        const ok = statuses[0] === 200 && statuses[1] === 201;
        expect(ok, `konkuren pair ${pair}: satu 200 + satu 201 (dapat: [${statuses.join(', ')}])`);

        if (!ok) {
          // Tampilkan body kedua respons untuk forensik; jangan tutupi dengan rerun.
          console.error(`pair ${pair} GAGAL. Status: [${ra.status}, ${rb.status}]`);
          console.error(`pair ${pair} GAGAL. Body respons A: ${JSON.stringify(ra.json)}`);
          console.error(`pair ${pair} GAGAL. Body respons B: ${JSON.stringify(rb.json)}`);
          concFailed = true;
          break;
        }

        const winner = ra.status === 201 ? ra : rb;
        const replay = ra.status === 201 ? rb : ra;
        const winOrder = winner.json && winner.json.data;
        const repOrder = replay.json && replay.json.data;
        const winId = winOrder ? winOrder.id : null;
        const repId = repOrder ? repOrder.id : null;

        expect(winId !== null, `pair ${pair}: winner (201) mengembalikan order id (dapat: ${winId})`);
        if (winId) tracked.orders.push(winId);
        expect(repId === winId, `pair ${pair}: replay (200) menunjuk order id yang sama (${winId}) (dapat: ${repId})`);

        const orderCountByKey = await countRows(
          'pos_orders',
          'property_id = $1 AND idempotency_key = $2',
          [fx.pidA, idemKey]
        );
        expect(orderCountByKey === 1, `pair ${pair}: tepat 1 order untuk key "${idemKey}" (dapat: ${orderCountByKey})`);

        const itemRows = await countRows(
          'pos_order_items',
          'order_id = $1 AND menu_item_id = $2',
          [winId, fx.itemA]
        );
        expect(
          itemRows === 1,
          `pair ${pair}: item tidak berlipat (1 baris, qty=4) — baris: ${itemRows}`
        );
      }
      if (concFailed) {
        console.error('Skenario 10 berhenti pada kegagalan pertama — lihat status/body di atas.');
      } else {
        console.log(`Skenario 10: ${CONC_PAIRS}/${CONC_PAIRS} pasangan konkuren LULAS (satu 200 + satu 201 per pasangan).`);
      }
    }

    // ─── Skenario 11: Retry setelah respons tidak dibaca ─────────────────
    // Label: SIMULASI RESPONS TIDAK DIBACA, BUKAN process crash.
    // Request pertama memakai apiRaw (body tidak dibaca) → verifikasi commit
    // via query DB → release response → retry key/payload sama → 200 replay.
    console.log('\n── Skenario 11: Retry setelah respons tidak dibaca (simulasi, BUKAN crash) ──');
    {
      const idemKey = `posf_${RUN_ID}_lostresp`;
      const payload = {
        property_id: fx.pidA,
        items: [{ menu_item_id: fx.itemA, quantity: 5 }],
      };

      // Request pertama: TIDAK baca body (simulasi respons tidak dibaca).
      const raw = await apiRaw('POST', '/api/pos/orders', payload, { auth: tokenA, idempotencyKey: idemKey });
      expect(
        raw.status === 201,
        `request pertama (body tidak dibaca) → 201 (dapat: ${raw.status})`
      );

      // Pastikan order sudah committed via query DB (bukan asumsi dari respons).
      const committedCount = await countRows(
        'pos_orders',
        'property_id = $1 AND idempotency_key = $2',
        [fx.pidA, idemKey]
      );
      expect(
        committedCount === 1,
        `order sudah committed di DB sebelum retry (baris: ${committedCount})`
      );

      // Lepaskan resource response (body pertama tidak pernah dibaca).
      try {
        await raw.response.body.cancel(); // Node 18+ / fetch: cancel body stream.
      } catch (e) {
        // Di lingkungan undici, .cancel() bisa menolak bila sudah berakhir — aman diabaikan.
      }

      // Ambil order id dari DB untuk verifikasi retry.
      const idClient = await (async () => {
        const c = await pool.connect();
        try {
          const q = await c.query(
            `SELECT id FROM pos_orders WHERE property_id = $1 AND idempotency_key = $2`,
            [fx.pidA, idemKey]
          );
          return q.rows[0] ? q.rows[0].id : null;
        } finally { c.release(); }
      })();
      expect(
        idClient !== null,
        `order id dari DB ditemukan untuk retry (dapat: ${idClient})`
      );
      if (idClient && !tracked.orders.includes(idClient)) tracked.orders.push(idClient);

      // Retry: key & payload sama → 200 replay, ID sama, tepat satu order.
      const retry = await api('POST', '/api/pos/orders', payload, { auth: tokenA, idempotencyKey: idemKey });
      const retryOrder = retry.json && retry.json.data;
      expect(
        retry.status === 200,
        `retry (respons tidak dibaca) → 200 replay (dapat: ${retry.status})`
      );
      expect(
        retryOrder && retryOrder.id === idClient,
        `retry menunjuk order id yang sama (${idClient}) (dapat: ${retryOrder ? retryOrder.id : 'null'})`
      );

      const finalOrderCount = await countRows(
        'pos_orders',
        'property_id = $1 AND idempotency_key = $2',
        [fx.pidA, idemKey]
      );
      const finalItemRows = await countRows(
        'pos_order_items',
        'order_id = $1 AND menu_item_id = $2',
        [idClient, fx.itemA]
      );
      expect(
        finalOrderCount === 1,
        `tepat 1 order setelah retry (dapat: ${finalOrderCount})`
      );
      expect(
        finalItemRows === 1,
        `items utuh (1 baris) setelah retry (dapat: ${finalItemRows})`
      );
    }

    // ─── Helper: baca snapshot order + item detail dari DB ────────────────
    async function readOrderSnapshot(orderId) {
      const c = await pool.connect();
      try {
        const o = await c.query(
          `SELECT id, total_amount FROM pos_orders WHERE id = $1`, [orderId]
        );
        const i = await c.query(
          `SELECT unit_price, quantity FROM pos_order_items WHERE order_id = $1 ORDER BY id`, [orderId]
        );
        return {
          orderId,
          total: o.rows[0] ? Number(o.rows[0].total_amount) : null,
          items: i.rows.map((r) => ({ unit_price: Number(r.unit_price), quantity: Number(r.quantity) })),
        };
      } finally { c.release(); }
    }

    // ─── Skenario 12: Replay setelah harga master berubah ─────────────────
    // Buat order (key baru) → ubah harga master di DB → retry key+payload sama
    // → 200 replay dengan ID/unit_price/quantity/total tetap seperti awal.
    // Request key BARU memakai harga master terbaru (verifikasi snapshot per request).
    console.log('\n── Skenario 12: Replay setelah harga master berubah ──');
    {
      const keyA = `posf_${RUN_ID}_pricemaster`;
      const payload = {
        property_id: fx.pidA,
        items: [{ menu_item_id: fx.itemA, quantity: 2 }],
      };

      // (a) Buat order pertama (201). Simpan snapshot.
      const create = await api('POST', '/api/pos/orders', payload, { auth: tokenA, idempotencyKey: keyA });
      expect(create.status === 201, `order pertama → 201 (dapat: ${create.status})`);
      const orderFirst = create.json && create.json.data;
      expect(orderFirst && orderFirst.id, `order pertama id ada (dapat: ${orderFirst ? orderFirst.id : 'null'})`);
      if (orderFirst && orderFirst.id) tracked.orders.push(orderFirst.id);

      const snapBefore = await readOrderSnapshot(orderFirst.id);
      const origUnit = snapBefore.items[0].unit_price;
      const origTotal = snapBefore.total;
      const origQty = snapBefore.items[0].quantity;
      // Simpan harga asli item A untuk di-restore (sebelum cleanup).
      const c0 = await pool.connect();
      let origMasterPrice;
      try {
        const mp = await c0.query(`SELECT price FROM pos_menu_items WHERE id = $1`, [fx.itemA]);
        origMasterPrice = Number(mp.rows[0].price);
      } finally { c0.release(); }

      // (b) Ubah harga master via DB (naikkan).
      const c1 = await pool.connect();
      try {
        await c1.query(`UPDATE pos_menu_items SET price = $1 WHERE id = $2`, [99999, fx.itemA]);
      } finally { c1.release(); }

      // (c) Retry key & payload SAMA → 200 replay; snapshot tidak berubah.
      const replay = await api('POST', '/api/pos/orders', payload, { auth: tokenA, idempotencyKey: keyA });
      expect(replay.status === 200, `replay setelah harga berubah → 200 (dapat: ${replay.status})`);
      const repData = replay.json && replay.json.data;
      expect(
        repData && repData.id === orderFirst.id,
        `replay ID sama (${orderFirst.id}) (dapat: ${repData ? repData.id : 'null'})`
      );
      // Verifikasi snapshot dari DB tidak berubah (unit/qty/total).
      const snapAfter = await readOrderSnapshot(orderFirst.id);
      expect(
        snapAfter.items[0] && snapAfter.items[0].unit_price === origUnit,
        `unit_price tetap snapshot (${origUnit}) meski master berubah (DB: ${snapAfter.items[0] ? snapAfter.items[0].unit_price : 'n/a'})`
      );
      expect(
        snapAfter.items[0] && snapAfter.items[0].quantity === origQty,
        `quantity tetap (${origQty}) (DB: ${snapAfter.items[0] ? snapAfter.items[0].quantity : 'n/a'})`
      );
      expect(
        snapAfter.total === origTotal,
        `total_amount tetap (${origTotal}) (DB: ${snapAfter.total})`
      );
      // Data replay juga membawa snapshot lama (bukan harga master 99999).
      expect(
        repData && repData.items && repData.items.length === 1 &&
        Number(repData.items[0].unit_price) === origUnit,
        `respons replay memuat unit_price snapshot lama (${origUnit}), bukan master 99999`
      );

      // (d) Request dengan key BARU → memakai harga master terbaru (99999).
      const keyB = `posf_${RUN_ID}_pricemaster2`;
      const newReq = await api('POST', '/api/pos/orders', payload, { auth: tokenA, idempotencyKey: keyB });
      expect(newReq.status === 201, `request key baru → 201 (dapat: ${newReq.status})`);
      const newOrder = newReq.json && newReq.json.data;
      expect(newOrder && newOrder.id && newOrder.id !== orderFirst.id, `order kedua id beda (dapat: ${newOrder ? newOrder.id : 'null'})`);
      if (newOrder && newOrder.id) tracked.orders.push(newOrder.id);
      const snapNew = await readOrderSnapshot(newOrder.id);
      expect(
        snapNew.items[0] && snapNew.items[0].unit_price === 99999,
        `order baru memakai harga master terbaru (99999) (DB: ${snapNew.items[0] ? snapNew.items[0].unit_price : 'n/a'})`
      );
      // Verifikasi jumlah order & item: 2 order, masing-masing 1 baris item.
      const totalOrdersByKey = await countRows('pos_orders', 'property_id = $1 AND idempotency_key IN ($2,$3)', [fx.pidA, keyA, keyB]);
      expect(totalOrdersByKey === 2, `tepat 2 order untuk kedua key (dapat: ${totalOrdersByKey})`);
      const itemsKeyA = await countRows('pos_order_items', 'order_id = $1 AND menu_item_id = $2', [orderFirst.id, fx.itemA]);
      const itemsKeyB = await countRows('pos_order_items', 'order_id = $1 AND menu_item_id = $2', [newOrder.id, fx.itemA]);
      expect(itemsKeyA === 1 && itemsKeyB === 1, `masing-masing order 1 baris item tanpa duplikat (A:${itemsKeyA} B:${itemsKeyB})`);

      // (e) Restore harga master asli agar tidak memengaruhi skenario lain di run ini.
      const c2 = await pool.connect();
      try {
        await c2.query(`UPDATE pos_menu_items SET price = $1 WHERE id = $2`, [origMasterPrice, fx.itemA]);
      } finally { c2.release(); }
    }

    // ─── Skenario 13: Authorization pada replay ────────────────────────────
    // Guard auth/scope berjalan SEBELUM replay → 401/403 tidak membocorkan
    // data order; jumlah & isi order/items tidak berubah.
    // Kontrol: token berizin + properti benar → 200 replay.
    console.log('\n── Skenario 13: Authorization pada replay ──');
    {
      const keyAuth = `posf_${RUN_ID}_authreplay`;
      const payload = {
        property_id: fx.pidA,
        items: [{ menu_item_id: fx.itemA, quantity: 3 }],
      };

      // (a) Buat order sukses dengan key baru.
      const create = await api('POST', '/api/pos/orders', payload, { auth: tokenA, idempotencyKey: keyAuth });
      expect(create.status === 201, `order awal → 201 (dapat: ${create.status})`);
      const authOrder = create.json && create.json.data;
      expect(authOrder && authOrder.id, `order awal id ada (dapat: ${authOrder ? authOrder.id : 'null'})`);
      if (authOrder && authOrder.id) tracked.orders.push(authOrder.id);

      const beforeOrders = await countRows('pos_orders', 'property_id = $1', [fx.pidA]);
      const beforeItems = await countRows('pos_order_items', 'order_id IN (SELECT id FROM pos_orders WHERE property_id = $1)', [fx.pidA]);
      const snapBefore = await readOrderSnapshot(authOrder.id);

      // (b) Key/payload sama TANPA token → 401, tanpa data order.
      const noTok = await api('POST', '/api/pos/orders', payload, { idempotencyKey: keyAuth });
      expect(noTok.status === 401, `replay tanpa token → 401 (dapat: ${noTok.status})`);
      expect(
        noTok.json && !noTok.json.data,
        `respons 401 tidak membawa data order (data: ${noTok.json ? JSON.stringify(noTok.json.data ?? null) : 'null'})`
      );

      // (c) User tanpa permission POS → 403.
      const noPerm = await api('POST', '/api/pos/orders', payload, { auth: tokenNoPerm, idempotencyKey: keyAuth });
      expect(noPerm.status === 403, `replay tanpa permission → 403 (dapat: ${noPerm.status})`);
      expect(noPerm.json && !noPerm.json.data, `respons 403 tanpa permission tidak membawa data order`);

      // (d) Token A menarget properti B dengan key tersebut → 403.
      // (tokenA property A; property_id di payload diubah ke pidB → scope mismatch.)
      const crossPayload = { property_id: fx.pidB, items: [{ menu_item_id: fx.itemB, quantity: 3 }] };
      const cross = await api('POST', '/api/pos/orders', crossPayload, { auth: tokenA, idempotencyKey: keyAuth });
      expect(cross.status === 403, `cross-property (token A → properti B) → 403 (dapat: ${cross.status})`);
      expect(cross.json && !cross.json.data, `respons cross-property 403 tidak membawa data order`);

      // (e) Jumlah & isi order/items tidak berubah setelah semua penolakan.
      const afterOrders = await countRows('pos_orders', 'property_id = $1', [fx.pidA]);
      const afterItems = await countRows('pos_order_items', 'order_id IN (SELECT id FROM pos_orders WHERE property_id = $1)', [fx.pidA]);
      const snapAfter = await readOrderSnapshot(authOrder.id);
      expect(afterOrders === beforeOrders, `jumlah order tidak berubah (${beforeOrders}→${afterOrders})`);
      expect(afterItems === beforeItems, `jumlah items tidak berubah (${beforeItems}→${afterItems})`);
      expect(
        snapAfter.total === snapBefore.total &&
        snapAfter.items.length === snapBefore.items.length &&
        snapAfter.items[0].unit_price === snapBefore.items[0].unit_price &&
        snapAfter.items[0].quantity === snapBefore.items[0].quantity,
        `isi order tidak berubah setelah penolakan (total ${snapBefore.total}→${snapAfter.total})`
      );

      // (f) Kontrol: token berizin + properti benar → 200 replay.
      const okReplay = await api('POST', '/api/pos/orders', payload, { auth: tokenA, idempotencyKey: keyAuth });
      expect(okReplay.status === 200, `kontrol replay (token benar) → 200 (dapat: ${okReplay.status})`);
      const okData = okReplay.json && okReplay.json.data;
      expect(okData && okData.id === authOrder.id, `kontrol replay ID sama (${authOrder.id}) (dapat: ${okData ? okData.id : 'null'})`);
    }

    // ─── Skenario 14: Konkurensi — key BERBEDA, semua request sukses ──────
    // 5 request konkuren, masing-masing key berbeda.
    // Harapkan: semua 201, ID semua berbeda, order_number semua berbeda,
    // tepat 5 order di DB, masing-masing 1 baris item utuh.
    console.log('\n── Skenario 14: Konkurensi key berbeda (5 request, semua harus 201 & order berbeda) ──');
    {
      const CONC_REQ = 5;
      const keys = [];
      for (let i = 1; i <= CONC_REQ; i++) keys.push(`posf_${RUN_ID}_diffkey${i}`);

      const responses = await Promise.all(
        keys.map((k) =>
          api('POST', '/api/pos/orders', {
            property_id: fx.pidA,
            items: [{ menu_item_id: fx.itemA, quantity: 6 }],
          }, { auth: tokenA, idempotencyKey: k })
        )
      );

      // Semua harus 201.
      responses.forEach((r, i) => {
        expect(
          r.status === 201,
          `key berbeda req ${i + 1}: status 201 (dapat: ${r.status}${r.status !== 201 ? ` body: ${JSON.stringify(r.json)}` : ''})`
        );
      });

      const ids = responses.map((r) => r.json && r.json.data ? r.json.data.id : null);
      const orderNumbers = responses.map((r) => r.json && r.json.data ? r.json.data.order_number : null);

      // Semua ID valid & unik.
      const allIdsValid = ids.every((id) => id !== null);
      expect(allIdsValid, `semua ${CONC_REQ} respons mengembalikan order id (id: ${JSON.stringify(ids)})`);

      const uniqueIds = new Set(ids).size;
      expect(
        uniqueIds === CONC_REQ,
        `semua ${CONC_REQ} order id berbeda (unik: ${uniqueIds}/${CONC_REQ})`
      );

      // Semua order_number valid & unik.
      const allNumsValid = orderNumbers.every((n) => typeof n === 'string' && n.length > 0);
      expect(allNumsValid, `semua ${CONC_REQ} order_number valid (nilai: ${JSON.stringify(orderNumbers)})`);

      const uniqueNums = new Set(orderNumbers).size;
      expect(
        uniqueNums === CONC_REQ,
        `semua ${CONC_REQ} order_number berbeda (unik: ${uniqueNums}/${CONC_REQ})`
      );

      // Track semua order untuk cleanup.
      ids.forEach((id) => { if (id !== null && !tracked.orders.includes(id)) tracked.orders.push(id); });

      // Verifikasi DB: tepat CONC_REQ order untuk key-key ini.
      const dbCount = await (async () => {
        const c = await pool.connect();
        try {
          const q = await c.query(
            `SELECT COUNT(*)::int AS c FROM pos_orders WHERE property_id = $1 AND idempotency_key = ANY($2)`,
            [fx.pidA, keys]
          );
          return q.rows[0].c;
        } finally { c.release(); }
      })();
      expect(
        dbCount === CONC_REQ,
        `tepat ${CONC_REQ} order di DB untuk ${CONC_REQ} key berbeda (DB: ${dbCount})`
      );

      // Items utuh: masing-masing order tepat 1 baris item.
      for (let i = 0; i < CONC_REQ; i++) {
        const itemRows = await countRows(
          'pos_order_items',
          'order_id = $1 AND menu_item_id = $2',
          [ids[i], fx.itemA]
        );
        expect(
          itemRows === 1,
          `order ke-${i + 1} (id=${ids[i]}): tepat 1 baris item qty=6 (baris: ${itemRows})`
        );
       }
    }

    // ─── Skenario 15: Replay setelah produk fixture dinonaktifkan ─────────
    // (a) Buat order sukses dengan key baru (produk masih aktif).
    // (b) Nonaktifkan produk fixture di DB.
    // (c) Key/payload sama → 200 replay, ID/harga/qty/total lama tetap.
    // (d) Key baru + produk nonaktif → 404 MENU_ITEM_NOT_FOUND, tanpa order baru.
    // (e) Key lama + payload berbeda → 409 IDEMPOTENCY_KEY_CONFLICT.
    // (f) Restore produk fixture di finally (agar tidak memengaruhi skenario lain).
    console.log('\n── Skenario 15: Replay tidak bergantung status aktif produk ──');
    {
      const keyInact = `posf_${RUN_ID}_inact`;
      const payloadInact = {
        property_id: fx.pidA,
        items: [{ menu_item_id: fx.itemA, quantity: 7 }],
      };

      // (a) Buat order sukses (produk masih aktif saat ini).
      const createRes = await api('POST', '/api/pos/orders', payloadInact, { auth: tokenA, idempotencyKey: keyInact });
      expect(createRes.status === 201, `(a) create awal → 201 (dapat: ${createRes.status})`);
      const created = createRes.json && createRes.json.data;
      expect(created && created.id, `(a) order awal id ada (dapat: ${created ? created.id : 'null'})`);
      if (created && created.id) tracked.orders.push(created.id);

      const snapBefore = await readOrderSnapshot(created.id);
      const origTotal = snapBefore.total;
      const origQty = snapBefore.items[0].quantity;
      const origUnit = snapBefore.items[0].unit_price;

      // (b) Nonaktifkan produk fixture di DB.
      const cInactive = await pool.connect();
      try {
        await cInactive.query(`UPDATE pos_menu_items SET is_active = FALSE WHERE id = $1`, [fx.itemA]);
      } finally { cInactive.release(); }

      try {
        // (c) Replay: key/payload sama → 200, snapshot tidak berubah.
        const replay = await api('POST', '/api/pos/orders', payloadInact, { auth: tokenA, idempotencyKey: keyInact });
        expect(replay.status === 200, `(c) replay produk nonaktif → 200 (dapat: ${replay.status})`);
        const repData = replay.json && replay.json.data;
        expect(
          repData && repData.id === created.id,
          `(c) replay ID sama (${created.id}) (dapat: ${repData ? repData.id : 'null'})`
        );
        const snapAfter = await readOrderSnapshot(created.id);
        expect(
          snapAfter.total === origTotal,
          `(c) total_amount tetap (${origTotal}) (DB: ${snapAfter.total})`
        );
        expect(
          snapAfter.items[0] && snapAfter.items[0].quantity === origQty,
          `(c) quantity tetap (${origQty}) (DB: ${snapAfter.items[0] ? snapAfter.items[0].quantity : 'n/a'})`
        );
        expect(
          snapAfter.items[0] && snapAfter.items[0].unit_price === origUnit,
          `(c) unit_price tetap (${origUnit}) (DB: ${snapAfter.items[0] ? snapAfter.items[0].unit_price : 'n/a'})`
        );

        // (d) Key baru + produk nonaktif → 404 MENU_ITEM_NOT_FOUND, tanpa order/items baru.
        const ordersBeforeD = await countRows('pos_orders', 'property_id = $1', [fx.pidA]);
        const itemsBeforeD = await countRows(
          'pos_order_items',
          'order_id IN (SELECT id FROM pos_orders WHERE property_id = $1)',
          [fx.pidA]
        );
        const keyNew = `posf_${RUN_ID}_inact_new`;
        const rNewKey = await api('POST', '/api/pos/orders', payloadInact, { auth: tokenA, idempotencyKey: keyNew });
        expect(
          rNewKey.status === 404,
          `(d) key baru + produk nonaktif → 404 (dapat: ${rNewKey.status})`
        );
        expect(
          rNewKey.json && rNewKey.json.code === 'MENU_ITEM_NOT_FOUND',
          `(d) code = MENU_ITEM_NOT_FOUND (dapat: ${rNewKey.json ? rNewKey.json.code : 'null'})`
        );
        const ordersAfterD = await countRows('pos_orders', 'property_id = $1', [fx.pidA]);
        const itemsAfterD = await countRows(
          'pos_order_items',
          'order_id IN (SELECT id FROM pos_orders WHERE property_id = $1)',
          [fx.pidA]
        );
        expect(
          ordersAfterD === ordersBeforeD && itemsAfterD === itemsBeforeD,
          `(d) tanpa order/items baru setelah 404 (orders ${ordersBeforeD}→${ordersAfterD}, items ${itemsBeforeD}→${itemsAfterD})`
        );

        // (e) Key lama (keyInact) + payload berbeda → 409 IDEMPOTENCY_KEY_CONFLICT.
        const payloadDiff = {
          property_id: fx.pidA,
          items: [{ menu_item_id: fx.itemA, quantity: 8 }],
        };
        const rConflict = await api('POST', '/api/pos/orders', payloadDiff, { auth: tokenA, idempotencyKey: keyInact });
        expect(
          rConflict.status === 409,
          `(e) key lama + payload berbeda → 409 (dapat: ${rConflict.status})`
        );
        expect(
          rConflict.json && rConflict.json.code === 'IDEMPOTENCY_KEY_CONFLICT',
          `(e) code = IDEMPOTENCY_KEY_CONFLICT (dapat: ${rConflict.json ? rConflict.json.code : 'null'})`
        );
      } finally {
        // (f) Restore produk fixture agar tidak memengaruhi skenario lain di run ini.
        const cRestore = await pool.connect();
        try {
          await cRestore.query(`UPDATE pos_menu_items SET is_active = TRUE WHERE id = $1`, [fx.itemA]);
        } finally { cRestore.release(); }
      }
    }

    // ─── Skenario 16: Filter & ownership reservasi (GET/POST) ────────────
    // Buat order terkait masing-masing reservasi A, serta order tanpa reservasi.
    // GET + filter reservation A1 hanya mengembalikan order A1.
    // GET tanpa filter memuat seluruh order properti A.
    // GET + reservation B → 403, tanpa data order.
    // POST + reservation B → 403, tanpa order/items baru.
    // reservation_id malformed → 400; ID tidak ditemukan → 404.
    console.log('\n── Skenario 16: Filter & ownership reservasi ──');
    {
      // Buat order terkait reservasi A1 (token A, property A)
      const rOrd1 = await api('POST', '/api/pos/orders', {
        property_id: fx.pidA,
        reservation_id: fx.rsA1,
        items: [{ menu_item_id: fx.itemA, quantity: 2 }],
      }, { auth: tokenA });
      expect(rOrd1.status === 201, `create order res A1 → 201 (dapat: ${rOrd1.status})`);
      const ord1 = rOrd1.json && rOrd1.json.data;
      expect(ord1 && ord1.id, `order res A1 id ada (dapat: ${ord1 ? ord1.id : 'null'})`);
      if (ord1 && ord1.id) tracked.orders.push(ord1.id);

      // Buat order terkait reservasi A2
      const rOrd2 = await api('POST', '/api/pos/orders', {
        property_id: fx.pidA,
        reservation_id: fx.rsA2,
        items: [{ menu_item_id: fx.itemA2, quantity: 1 }],
      }, { auth: tokenA });
      expect(rOrd2.status === 201, `create order res A2 → 201 (dapat: ${rOrd2.status})`);
      const ord2 = rOrd2.json && rOrd2.json.data;
      expect(ord2 && ord2.id, `order res A2 id ada (dapat: ${ord2 ? ord2.id : 'null'})`);
      if (ord2 && ord2.id) tracked.orders.push(ord2.id);

      // Buat order TANPA reservasi
      const rOrd3 = await api('POST', '/api/pos/orders', {
        property_id: fx.pidA,
        items: [{ menu_item_id: fx.itemA, quantity: 1 }],
      }, { auth: tokenA });
      expect(rOrd3.status === 201, `create order tanpa res → 201 (dapat: ${rOrd3.status})`);
      const ord3 = rOrd3.json && rOrd3.json.data;
      expect(ord3 && ord3.id, `order tanpa res id ada (dapat: ${ord3 ? ord3.id : 'null'})`);
      if (ord3 && ord3.id) tracked.orders.push(ord3.id);

      // GET property A + reservation A1 → hanya order A1, dengan nested items.
      const rGetA1 = await api('GET', `/api/pos/orders?property_id=${fx.pidA}&reservation_id=${fx.rsA1}`, null, { auth: tokenA });
      expect(
        rGetA1.status === 200,
        `GET res A1 → 200 (dapat: ${rGetA1.status})`
      );
      const dataA1 = rGetA1.json && rGetA1.json.data;
      expect(
        Array.isArray(dataA1),
        `GET res A1 mengembalikan array (dapat: ${Array.isArray(dataA1) ? `panjang ${dataA1.length}` : 'non-array'})`
      );
      if (Array.isArray(dataA1)) {
        // Harus tepat satu order (ord1), dan reservation_id-nya = rsA1.
        const matchingRes = dataA1.filter((o) => o.reservation_id === fx.rsA1);
        expect(
          matchingRes.length === 1,
          `GET res A1: tepat 1 order dengan reservation_id=${fx.rsA1} (dapat: ${matchingRes.length})`
        );
        if (matchingRes.length === 1) {
          const o = matchingRes[0];
          expect(
            o.id === ord1.id,
            `order res A1 id sesuai (${ord1.id}) (dapat: ${o.id})`
          );
          expect(
            Array.isArray(o.items) && o.items.length === 1,
            `order res A1 nested items utuh (1 baris) (dapat: ${Array.isArray(o.items) ? o.items.length : 'non-array'})`
          );
          if (Array.isArray(o.items) && o.items.length === 1) {
            expect(
              Number(o.items[0].quantity) === 2,
              `order res A1 item quantity = 2 (dapat: ${o.items[0].quantity})`
            );
          }
        }
      }

      // GET property A TANPA filter → memuat seluruh order properti A (termasuk ord1, ord2, ord3).
      const rGetAll = await api('GET', `/api/pos/orders?property_id=${fx.pidA}`, null, { auth: tokenA });
      expect(
        rGetAll.status === 200,
        `GET tanpa filter → 200 (dapat: ${rGetAll.status})`
      );
      const dataAll = rGetAll.json && rGetAll.json.data;
      expect(
        Array.isArray(dataAll) && dataAll.length >= 3,
        `GET tanpa filter memuat ≥3 order properti A (dapat: ${Array.isArray(dataAll) ? dataAll.length : 'non-array'})`
      );
      if (Array.isArray(dataAll)) {
        const ids = dataAll.map((o) => o.id);
        expect(
          ids.includes(ord1.id) && ids.includes(ord2.id) && ids.includes(ord3.id),
          `GET tanpa filter memuat ord1(${ord1.id}), ord2(${ord2.id}), ord3(${ord3.id}) (id: ${JSON.stringify(ids)})`
        );
      }

      // GET property A + reservation B → 403 CROSS_PROPERTY_RESERVATION, tanpa data order.
      const rGetB = await api('GET', `/api/pos/orders?property_id=${fx.pidA}&reservation_id=${fx.rsB1}`, null, { auth: tokenA });
      expect(
        rGetB.status === 403,
        `GET res B dengan token A → 403 (dapat: ${rGetB.status})`
      );
      expect(
        rGetB.json && !rGetB.json.data,
        `GET res B tidak membawa data order (data: ${rGetB.json ? JSON.stringify(rGetB.json.data ?? null) : 'null'})`
      );

      // POST property A + reservation B → 403, tanpa order/items baru.
      const ordersBeforePost = await countRows('pos_orders', 'property_id = $1', [fx.pidA]);
      const itemsBeforePost = await countRows(
        'pos_order_items',
        'order_id IN (SELECT id FROM pos_orders WHERE property_id = $1)',
        [fx.pidA]
      );
      const rPostB = await api('POST', '/api/pos/orders', {
        property_id: fx.pidA,
        reservation_id: fx.rsB1,
        items: [{ menu_item_id: fx.itemA, quantity: 1 }],
      }, { auth: tokenA });
      expect(
        rPostB.status === 403,
        `POST res B dengan token A → 403 (dapat: ${rPostB.status})`
      );
      expect(
        rPostB.json && rPostB.json.code === 'CROSS_PROPERTY_RESERVATION',
        `code POST res B = CROSS_PROPERTY_RESERVATION (dapat: ${rPostB.json ? rPostB.json.code : 'null'})`
      );
      const ordersAfterPost = await countRows('pos_orders', 'property_id = $1', [fx.pidA]);
      const itemsAfterPost = await countRows(
        'pos_order_items',
        'order_id IN (SELECT id FROM pos_orders WHERE property_id = $1)',
        [fx.pidA]
      );
      expect(
        ordersAfterPost === ordersBeforePost && itemsAfterPost === itemsBeforePost,
        `POST res B tidak menambah order/items (orders ${ordersBeforePost}→${ordersAfterPost}, items ${itemsBeforePost}→${itemsAfterPost})`
      );

      // reservation_id malformed → 400.
      const rMalformed = await api('GET', '/api/pos/orders?property_id=abc', null, { auth: tokenA });
      expect(
        rMalformed.status === 400,
        `GET property_id malformed → 400 (dapat: ${rMalformed.status})`
      );
      expect(
        rMalformed.json && !rMalformed.json.data,
        `GET property_id malformed tidak membawa data order`
      );

      // reservation_id malformed (property_id valid, reservation_id='abc') → 400 VALIDATION_ERROR.
      const rMalformedRes = await api('GET', `/api/pos/orders?property_id=${fx.pidA}&reservation_id=abc`, null, { auth: tokenA });
      expect(
        rMalformedRes.status === 400,
        `GET reservation_id='abc' → 400 (dapat: ${rMalformedRes.status})`
      );
      expect(
        rMalformedRes.json && rMalformedRes.json.code === 'VALIDATION_ERROR',
        `code = VALIDATION_ERROR (dapat: ${rMalformedRes.json ? rMalformedRes.json.code : 'null'})`
      );
      expect(
        rMalformedRes.json && !rMalformedRes.json.data,
        `GET reservation_id='abc' tidak membawa data order`
      );

      // reservation_id tidak ditemukan → 404.
      const rNotFound = await api('GET', `/api/pos/orders?property_id=${fx.pidA}&reservation_id=999999`, null, { auth: tokenA });
      expect(
        rNotFound.status === 404,
        `GET reservation_id tidak ditemukan → 404 (dapat: ${rNotFound.status})`
      );
      expect(
        rNotFound.json && rNotFound.json.code === 'RESERVATION_NOT_FOUND',
        `code = RESERVATION_NOT_FOUND (dapat: ${rNotFound.json ? rNotFound.json.code : 'null'})`
      );
    }

    // ─── Skenario 17: Produk tidak valid ────────────────────────────────
    // (a) Payload: produk valid + produk tidak ditemukan → ditolak, tanpa order parsial.
    // (b) Payload: produk valid + produk properti B (token A) → 403, tanpa order parsial.
    // (c) transactions/folio tidak bertambah.
    console.log('\n── Skenario 17: Produk tidak valid ──');
    {
      const txnBefore17 = await countRows('transactions', "property_id = $1 AND source_type = 'POS'", [fx.pidA]);
      const folioBefore17 = await countRows('folio_entries', "property_id = $1 AND source_type = 'POS'", [fx.pidA]);
      const ordersBefore17 = await countRows('pos_orders', 'property_id = $1', [fx.pidA]);
      const itemsBefore17 = await countRows(
        'pos_order_items',
        'order_id IN (SELECT id FROM pos_orders WHERE property_id = $1)',
        [fx.pidA]
      );

      // (a) Produk valid + produk tidak ditemukan (menu_item_id = 999999 tidak ada).
      const rNotF = await api('POST', '/api/pos/orders', {
        property_id: fx.pidA,
        items: [
          { menu_item_id: fx.itemA, quantity: 1 },
          { menu_item_id: 999999, quantity: 1 },
        ],
      }, { auth: tokenA });
      expect(
        rNotF.status === 404,
        `(a) produk tidak ditemukan → 404 (dapat: ${rNotF.status})`
      );
      expect(
        rNotF.json && rNotF.json.code === 'MENU_ITEM_NOT_FOUND',
        `(a) code = MENU_ITEM_NOT_FOUND (dapat: ${rNotF.json ? rNotF.json.code : 'null'})`
      );

      const ordersAfterA = await countRows('pos_orders', 'property_id = $1', [fx.pidA]);
      const itemsAfterA = await countRows(
        'pos_order_items',
        'order_id IN (SELECT id FROM pos_orders WHERE property_id = $1)',
        [fx.pidA]
      );
      expect(
        ordersAfterA === ordersBefore17 && itemsAfterA === itemsBefore17,
        `(a) tanpa order/items parsial setelah 404 (orders ${ordersBefore17}→${ordersAfterA}, items ${itemsBefore17}→${itemsAfterA})`
      );

      // (b) Produk valid + produk properti B (fx.itemB) dengan token A → 403.
      const rCross = await api('POST', '/api/pos/orders', {
        property_id: fx.pidA,
        items: [
          { menu_item_id: fx.itemA, quantity: 1 },
          { menu_item_id: fx.itemB, quantity: 1 },
        ],
      }, { auth: tokenA });
      expect(
        rCross.status === 403,
        `(b) produk properti B dengan token A → 403 (dapat: ${rCross.status})`
      );
      expect(
        rCross.json && rCross.json.code === 'CROSS_PROPERTY_MENU_ITEM',
        `(b) code = CROSS_PROPERTY_MENU_ITEM (dapat: ${rCross.json ? rCross.json.code : 'null'})`
      );

      const ordersAfterB = await countRows('pos_orders', 'property_id = $1', [fx.pidA]);
      const itemsAfterB = await countRows(
        'pos_order_items',
        'order_id IN (SELECT id FROM pos_orders WHERE property_id = $1)',
        [fx.pidA]
      );
      expect(
        ordersAfterB === ordersBefore17 && itemsAfterB === itemsBefore17,
        `(b) tanpa order/items parsial setelah 403 (orders ${ordersBefore17}→${ordersAfterB}, items ${itemsBefore17}→${itemsAfterB})`
      );

      // (c) transactions/folio tidak bertambah.
      const txnAfter17 = await countRows('transactions', "property_id = $1 AND source_type = 'POS'", [fx.pidA]);
      const folioAfter17 = await countRows('folio_entries', "property_id = $1 AND source_type = 'POS'", [fx.pidA]);
      expect(
        txnAfter17 === txnBefore17,
        `(c) transactions tidak bertambah (${txnBefore17}→${txnAfter17})`
      );
      expect(
        folioAfter17 === folioBefore17,
        `(c) folio_entries tidak bertambah (${folioBefore17}→${folioAfter17})`
      );
    }

    // ─── Skenario 19: Bypass cache global POS ─────────────────────────────
    // POST /api/pos/orders bypass cache global (idempotency_keys) — dedup ditangani
    // di domain (pos_orders.idempotency_key + request_fingerprint).
    // Buktikan:
    //   (a) entry cache global dengan key POSF-…-BYPASS + sentinel response_body
    //       tidak dipakai oleh POST POS (order dibuat normal, bukan sentinel).
    //   (b) retry key+payload sama → replay dari pos_orders (REPLAY), bukan sentinel.
    //   (c) tanpa token → 401, tanpa data order.
    //   (d) entry cache global TIDAK ditimpa oleh handler POS.
    //   (e) POST POS tanpa key → tidak ada baris baru idempotency_keys.
    console.log('\n── Skenario 19: Bypass cache global POS ──');
    {
      const bypassKey = `POSF-${RUN_ID}-BYPASS`;
      tracked.idempotencyKeys.push(bypassKey);

      // Hitung request_hash sesuai kontrak global middleware:
      // computeRequestHash('POST', '/api/pos/orders', req.body)
      // = sha256('POST|/api/pos/orders|' + JSON.stringify(body))
      const body19 = { property_id: fx.pidA, items: [{ menu_item_id: fx.itemA, quantity: 3 }] };
      const reqHash19 = crypto
        .createHash('sha256')
        .update('POST|/api/pos/orders|' + JSON.stringify(body19))
        .digest('hex');

      // Buat entry fixture cache global dengan sentinel.
      const sentinel = JSON.stringify({ status: 'SENTINEL', code: 'POSF_CACHE_SENTINEL', data: null });
      const insRes = await pool.query(
        `INSERT INTO idempotency_keys (key, request_hash, response_body, status_code, expires_at)
         VALUES ($1, $2, $3, 200, NOW() + INTERVAL '1 day')
         ON CONFLICT (key) DO UPDATE SET request_hash = $2, response_body = $3, status_code = 200
         RETURNING key`,
        [bypassKey, reqHash19, sentinel]
      );
      expect(
        (insRes.rowCount ?? 0) === 1,
        '(a) entry cache global fixture dibuat (rowCount: ' + (insRes.rowCount ?? 0) + ')'
      );

      // orders sebelum
      const ordersBefore19 = await countRows('pos_orders', 'property_id = $1', [fx.pidA]);

      // (a) POST POS dengan key + token A → harus 201 (bypass, bukan sentinel).
      const rPost19 = await api('POST', '/api/pos/orders', body19, { auth: tokenA, idempotencyKey: bypassKey });
      expect(
        rPost19.status === 201,
        '(a) POST POS dengan key bypass → 201 (dapat: ' + rPost19.status + ')'
      );
      expect(
        rPost19.json && rPost19.json.status === 'SUCCESS',
        '(a) respons = SUCCESS (status: ' + (rPost19.json ? rPost19.json.status : 'null') + ')'
      );
      expect(
        rPost19.json && rPost19.json.data && rPost19.json.data.id > 0,
        '(a) respons membawa order id valid'
      );
      if (rPost19.json && rPost19.json.data && rPost19.json.data.id) {
        tracked.orders.push(rPost19.json.data.id);
      }

      const ordersAfter19a = await countRows('pos_orders', 'property_id = $1', [fx.pidA]);
      expect(
        ordersAfter19a === ordersBefore19 + 1,
        '(a) tepat 1 order baru (orders: ' + ordersBefore19 + ' → ' + ordersAfter19a + ')'
      );

      // (b) retry key+payload sama → replay dari pos_orders (REPLAY), bukan sentinel.
      const rRetry19 = await api('POST', '/api/pos/orders', body19, { auth: tokenA, idempotencyKey: bypassKey });
      expect(
        rRetry19.status === 200,
        '(b) retry → 200 (dapat: ' + rRetry19.status + ')'
      );
      expect(
        rRetry19.json && rRetry19.json.status === 'REPLAY',
        '(b) respons = REPLAY (status: ' + (rRetry19.json ? rRetry19.json.status : 'null') + ')'
      );
      expect(
        rRetry19.json && rRetry19.json.data && rRetry19.json.data.id > 0,
        '(b) replay membawa order id valid'
      );

      const ordersAfter19b = await countRows('pos_orders', 'property_id = $1', [fx.pidA]);
      expect(
        ordersAfter19b === ordersAfter19a,
        '(b) retry tidak menambah order (orders: ' + ordersAfter19a + ' → ' + ordersAfter19b + ')'
      );

      // (c) tanpa token → 401, tanpa data order.
      const rNoAuth19 = await api('POST', '/api/pos/orders', body19, { idempotencyKey: bypassKey });
      expect(
        rNoAuth19.status === 401,
        '(c) tanpa token → 401 (dapat: ' + rNoAuth19.status + ')'
      );
      expect(
        !rNoAuth19.json || !rNoAuth19.json.data,
        '(c) tanpa token tidak membawa data order'
      );

      // (d) entry cache global TIDAK ditimpa oleh handler POS.
      const cacheCheck = await pool.query(
        'SELECT response_body FROM idempotency_keys WHERE key = $1',
        [bypassKey]
      );
      expect(
        (cacheCheck.rowCount ?? 0) === 1 && cacheCheck.rows[0].response_body === sentinel,
        '(d) entry cache global masih sentinel (response_body cocok: ' +
        (cacheCheck.rowCount ?? 0) === 1 ? 'ya' : 'tidak' + ')'
      );

      // (e) POST POS tanpa key → tidak ada baris baru idempotency_keys.
      const idemBefore19 = await pool.query('SELECT COUNT(*)::int AS c FROM idempotency_keys').then(r => r.rows[0].c);
      const body19e = { property_id: fx.pidA, items: [{ menu_item_id: fx.itemA, quantity: 1 }] };
      const rNoKey19 = await api('POST', '/api/pos/orders', body19e, { auth: tokenA });
      expect(
        rNoKey19.status === 201,
        '(e) POST tanpa key → 201 (dapat: ' + rNoKey19.status + ')'
      );
      if (rNoKey19.json && rNoKey19.json.data && rNoKey19.json.data.id) {
        tracked.orders.push(rNoKey19.json.data.id);
      }
      const idemAfter19 = await pool.query('SELECT COUNT(*)::int AS c FROM idempotency_keys').then(r => r.rows[0].c);
      expect(
        idemAfter19 === idemBefore19,
        '(e) tidak ada baris baru idempotency_keys (' + idemBefore19 + ' → ' + idemAfter19 + ')'
      );
    }

    // ─── Skenario 20: Regresi middleware global di POST /api/pos/menu/items ──
    // Endpoint ini TIDAK bypass cache global → Idempotency-Key diintersepsi
    // middleware global: replay dari idempotency_keys.response_body, mutasi sekali.
    console.log('\n── Skenario 20: Regresi middleware global (menu items) ──');
    {
      const mpKey = `POSF-${RUN_ID}-MP`;
      tracked.idempotencyKeys.push(mpKey);
      const tokenMp = tokenFor(fx.userMp, fx.pidA);

      const menuBody = {
        property_id: fx.pidA,
        name: `POSF MP ${RUN_4} X`,
        item_code: `${RUN_4}MP1`,
        price: 5000,
      };

      const itemsBefore20 = await countRows('pos_menu_items', 'property_id = $1', [fx.pidA]);

      // (a) POST menu items dengan key + tokenMp → 201, mutasi terjadi.
      // Middleware global insert placeholder, lalu update response_body setelah handler selesai.
      const rMenu1 = await api('POST', '/api/pos/menu/items', menuBody, { auth: tokenMp, idempotencyKey: mpKey });
      expect(
        rMenu1.status === 201,
        '(a) POST menu items (key+tokenMp) → 201 (dapat: ' + rMenu1.status + ' ' +
        (rMenu1.json ? JSON.stringify(rMenu1.json).slice(0, 200) : 'null') + ')'
      );
      expect(
        rMenu1.json && rMenu1.json.status === 'OK' && rMenu1.json.data && rMenu1.json.data.id > 0,
        '(a) respons OK + item id valid'
      );
      let newItemId = rMenu1.json && rMenu1.json.data ? rMenu1.json.data.id : null;
      if (newItemId) tracked.items.push(newItemId);

      const itemsAfter20a = await countRows('pos_menu_items', 'property_id = $1', [fx.pidA]);
      expect(
        itemsAfter20a === itemsBefore20 + 1,
        '(a) tepat 1 item baru (' + itemsBefore20 + ' → ' + itemsAfter20a + ')'
      );

      // (b) retry key+payload sama → X-Idempotency: HIT, status 201 (replay dari cache).
      const rMenu2 = await api('POST', '/api/pos/menu/items', menuBody, { auth: tokenMp, idempotencyKey: mpKey });
      expect(
        rMenu2.status === 201,
        '(b) retry → 201 (dapat: ' + rMenu2.status + ')'
      );
      const cacheHit = rMenu2.headers && rMenu2.headers.get ? rMenu2.headers.get('x-idempotency') : null;
      expect(
        cacheHit === 'HIT',
        '(b) header X-Idempotency = HIT (dapat: ' + cacheHit + ')'
      );
      // Respons replay harus membawa item id yang sama (bukan item baru).
      expect(
        rMenu2.json && rMenu2.json.data && Number(rMenu2.json.data.id) === Number(newItemId),
        '(b) replay item id sama (' + newItemId + ' vs ' +
        (rMenu2.json && rMenu2.json.data ? rMenu2.json.data.id : 'null') + ')'
      );

      const itemsAfter20b = await countRows('pos_menu_items', 'property_id = $1', [fx.pidA]);
      expect(
        itemsAfter20b === itemsAfter20a,
        '(b) retry tidak menambah item (' + itemsAfter20a + ' → ' + itemsAfter20b + ')'
      );

      // (c) tanpa token → 401 (createOperationalAccessGuard menolak sebelum handler).
      // Gunakan key BARU tanpa entry cache agar middleware global pass-through ke guard.
      const mp401Key = `POSF-${RUN_ID}-MP401`;
      tracked.idempotencyKeys.push(mp401Key);
      const rNoAuth20 = await api('POST', '/api/pos/menu/items', menuBody, { idempotencyKey: mp401Key });
      expect(
        rNoAuth20.status === 401,
        '(c) tanpa token → 401 (dapat: ' + rNoAuth20.status + ')'
      );
      expect(
        !rNoAuth20.json || !rNoAuth20.json.data,
        '(c) tanpa token tidak membawa data item'
      );
    }

    // ─── Skenario 21: POST POS tanpa key → tidak ada baris idempotency_keys ──
    // Bypass cache global berarti handler POS TIDAK menulis idempotency_keys.
    console.log('\n── Skenario 21: POS tanpa key → tidak ada baris cache global ──');
    {
      const idemBefore21 = await pool.query('SELECT COUNT(*)::int AS c FROM idempotency_keys').then(r => r.rows[0].c);
      const rNoKey21 = await api('POST', '/api/pos/orders', {
        property_id: fx.pidA,
        items: [{ menu_item_id: fx.itemA, quantity: 1 }],
      }, { auth: tokenA });
      expect(
        rNoKey21.status === 201,
        'POST tanpa key → 201 (dapat: ' + rNoKey21.status + ')'
      );
      if (rNoKey21.json && rNoKey21.json.data && rNoKey21.json.data.id) {
        tracked.orders.push(rNoKey21.json.data.id);
      }
      const idemAfter21 = await pool.query('SELECT COUNT(*)::int AS c FROM idempotency_keys').then(r => r.rows[0].c);
      expect(
        idemAfter21 === idemBefore21,
        'tidak ada baris baru idempotency_keys (' + idemBefore21 + ' → ' + idemAfter21 + ')'
      );
    }

    // ─── Skenario 22: Batas bypass cache global POS — non-canonical path ─
    // Express default (case-sensitive routing=false, strict routing=false) routes
    // varian case / trailing-slash ke handler yang sama, tapi middleware idempotency
    // sekarang menolak 404 untuk non-canonical SEBELUM lookup cache global.
    //
    // (a) Canonical /api/pos/orders + cache sentinel pre-seeded + tanpa token → 401.
    //     Bypass cache aktif: sentinel tidak dibaca, auth guard menolak.
    // (b) POST /api/pos/orders/ (trailing slash) + sentinel → 404,
    //     tanpa sentinel di response, tanpa order baru, tanpa baris cache baru.
    // (c) POST /API/POS/ORDERS (case variant) + sentinel → 404, cek sama.
    // (d) POST /api/pos/orders (canonical) + token valid → 201 create normal.
    // (e) POST /api/pos/orders (canonical) + token valid + key sama → 200 replay.
    // (f) sentinel tetap utuh di idempotency_keys setelah semua sub-test.
    console.log('\n── Skenario 22: Batas bypass cache global POS (non-canonical 404) ──');
    {
      const sc22Key = `POSF-${RUN_ID}-SC22`;
      tracked.idempotencyKeys.push(sc22Key);

      const sc22Body = { property_id: fx.pidA, items: [{ menu_item_id: fx.itemA, quantity: 2 }] };
      const sc22ReqHash = crypto
        .createHash('sha256')
        .update('POST|/api/pos/orders|' + JSON.stringify(sc22Body))
        .digest('hex');
      const sc22Sentinel = JSON.stringify({ status: 'SENTINEL', code: 'POSF_SC22_SENTINEL', data: null });

      // Pre-seed cache global dengan sentinel (menggantikan request_hash sesuai canonical).
      const insSc22 = await pool.query(
        `INSERT INTO idempotency_keys (key, request_hash, response_body, status_code, expires_at)
         VALUES ($1, $2, $3, 200, NOW() + INTERVAL '1 day')
         ON CONFLICT (key) DO UPDATE SET request_hash = $2, response_body = $3, status_code = 200
         RETURNING key`,
        [sc22Key, sc22ReqHash, sc22Sentinel]
      );
      expect((insSc22.rowCount ?? 0) === 1, '(setup) entry cache global sc22 dibuat');

      const ordersBefore22 = await countRows('pos_orders', 'property_id = $1', [fx.pidA]);
      const idemBefore22 = await pool.query('SELECT COUNT(*)::int AS c FROM idempotency_keys').then(r => r.rows[0].c);

      // (a) Canonical + sentinel + tanpa token → 401 (bypass, auth guard menolak).
      const rA = await api('POST', '/api/pos/orders', sc22Body, { idempotencyKey: sc22Key });
      expect(rA.status === 401, '(a) canonical tanpa token → 401 (dapat: ' + rA.status + ')');
      expect(
        !rA.json || !rA.json.data,
        '(a) respons 401 tidak membawa data order'
      );
      // Sentinel tidak dibaca: baris idempotency_keys tetap.
      const cacheAfterA = await pool.query(
        'SELECT response_body FROM idempotency_keys WHERE key = $1', [sc22Key]
      );
      expect(
        (cacheAfterA.rowCount ?? 0) === 1 && cacheAfterA.rows[0].response_body === sc22Sentinel,
        '(a) sentinel tidak diubah oleh canonical tanpa token'
      );

      // (b) Trailing slash + sentinel → 404, tanpa sentinel, tanpa order baru.
      const rB = await api('POST', '/api/pos/orders/', sc22Body, { auth: tokenA, idempotencyKey: sc22Key });
      expect(
        rB.status === 404,
        '(b) POST /api/pos/orders/ → 404 (dapat: ' + rB.status + ')'
      );
      // Respons 404 tidak membawa sentinel/data bisnis.
      const bBody = rB.json ? JSON.stringify(rB.json) : '';
      expect(
        !bBody.includes('SENTINEL') && !bBody.includes('POSF_SC22_SENTINEL'),
        '(b) respons tidak memuat sentinel'
      );
      const ordersAfterB = await countRows('pos_orders', 'property_id = $1', [fx.pidA]);
      expect(
        ordersAfterB === ordersBefore22,
        '(b) trailing slash tidak menambah order (' + ordersBefore22 + ' → ' + ordersAfterB + ')'
      );
      const idemAfterB = await pool.query('SELECT COUNT(*)::int AS c FROM idempotency_keys').then(r => r.rows[0].c);
      expect(
        idemAfterB === idemBefore22,
        '(b) trailing slash tidak membuat baris cache baru (' + idemBefore22 + ' → ' + idemAfterB + ')'
      );

      // (c) Case variant + sentinel → 404, cek sama.
      const rC = await api('POST', '/API/POS/ORDERS', sc22Body, { auth: tokenA, idempotencyKey: sc22Key });
      expect(
        rC.status === 404,
        '(c) POST /API/POS/ORDERS → 404 (dapat: ' + rC.status + ')'
      );
      const cBody = rC.json ? JSON.stringify(rC.json) : '';
      expect(
        !cBody.includes('SENTINEL') && !cBody.includes('POSF_SC22_SENTINEL'),
        '(c) respons tidak memuat sentinel'
      );
      const ordersAfterC = await countRows('pos_orders', 'property_id = $1', [fx.pidA]);
      expect(
        ordersAfterC === ordersBefore22,
        '(c) case variant tidak menambah order (' + ordersBefore22 + ' → ' + ordersAfterC + ')'
      );
      const idemAfterC = await pool.query('SELECT COUNT(*)::int AS c FROM idempotency_keys').then(r => r.rows[0].c);
      expect(
        idemAfterC === idemBefore22,
        '(c) case variant tidak membuat baris cache baru (' + idemBefore22 + ' → ' + idemAfterC + ')'
      );

      // (d) Canonical + token valid + key baru → 201 create normal (kontrol bypass).
      const sc22KeyD = `POSF-${RUN_ID}-SC22D`;
      tracked.idempotencyKeys.push(sc22KeyD);
      const rD = await api('POST', '/api/pos/orders', sc22Body, { auth: tokenA, idempotencyKey: sc22KeyD });
      expect(
        rD.status === 201,
        '(d) canonical token valid → 201 (dapat: ' + rD.status + ' ' +
        (rD.json ? JSON.stringify(rD.json).slice(0, 150) : 'null') + ')'
      );
      const dOrder = rD.json && rD.json.data;
      expect(dOrder && dOrder.id > 0, '(d) order id valid');
      if (dOrder && dOrder.id) tracked.orders.push(dOrder.id);

      // (e) Canonical + token valid + key sama → 200 replay.
      const rE = await api('POST', '/api/pos/orders', sc22Body, { auth: tokenA, idempotencyKey: sc22KeyD });
      expect(
        rE.status === 200,
        '(e) replay canonical → 200 (dapat: ' + rE.status + ')'
      );
      expect(
        rE.json && rE.json.data && rE.json.data.id === dOrder.id,
        '(e) replay menunjuk order id yang sama'
      );
      const ordersAfterE = await countRows('pos_orders', 'property_id = $1', [fx.pidA]);
      expect(
        ordersAfterE === ordersBefore22 + 1,
        '(e) hanya 1 order baru total (' + ordersBefore22 + ' → ' + ordersAfterE + ')'
      );

      // (f) sentinel tetap utuh di idempotency_keys.
      const cacheFinal = await pool.query(
        'SELECT response_body FROM idempotency_keys WHERE key = $1', [sc22Key]
      );
      expect(
        (cacheFinal.rowCount ?? 0) === 1 && cacheFinal.rows[0].response_body === sc22Sentinel,
        '(f) sentinel masih utuh setelah semua sub-test'
      );
    }

  } finally {
    // 5) Shutdown server.
    if (server) {
      try {
        server.close();
        await once(server, 'close').catch(() => {});
      } catch (e) {
        console.error('SERVER CLOSE ERROR:', e.message);
      }
    }

    // 6) Discover orders yang belum tracked (respon hilang).
    try {
      await discoverAndTrackOrders();
    } catch (e) {
      console.error('DISCOVER ERROR:', e.message);
    }

    // 7) Cleanup.
    try {
      await cleanup();
    } catch (e) {
      console.error('CLEANUP ERROR:', e.message);
      failed += 1;
    }

    // 8) Verifikasi residu.
    try {
      await verifyResidue();
    } catch (e) {
      console.error('RESIDUE VERIFY ERROR:', e.message);
      failed += 1;
    }

    // 9) Tutup pool.
    try {
      await pool.end();
    } catch (e) {
      console.error('POOL END ERROR:', e.message);
      failed += 1;
    }

    // 10) Ringkasan.
    console.log('\n── RINGKASAN ──');
    console.log(`PASS: ${passed}  FAIL: ${failed}`);
    console.log('Tracked fixture IDs:');
    for (const [k, ids] of Object.entries(tracked)) {
      if (ids.length > 0) console.log(`  ${k}: [${ids.join(', ')}]`);
    }

    process.exit(failed > 0 ? 1 : 0);
  }
}

main().catch((e) => {
  console.error('UNCAUGHT ERROR:', e);
  process.exit(1);
});

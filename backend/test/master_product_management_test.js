/**
 * Master Produk Tahap 2 — PATCH item, status filter, kategori, permission
 *
 * DB safety guard (pola repo):
 * - TEST_DATABASE_URL eksplisit, localhost, port eksplisit, *_test, tanpa query parameter.
 * - Menolak DB tanpa '_test' atau mengandung staging|production|prod|live.
 * - TIDAK mencetak URL lengkap / password.
 * - Verifikasi pool.options dan identitas DB/user SEBELUM mutasi.
 * - Tanpa initialize/reset/migration schema.
 *
 * Cakupan:
 *  1. PATCH parsial mempertahankan field lain.
 *  2. Edit nama/harga/deskripsi/kode/kategori, termasuk category_id=null.
 *  3. Kode duplikat → 409; kategori asing dan item properti lain tidak dapat dimutasi.
 *  4. Nonaktif/reaktivasi; GET default active, inactive, all.
 *  5. Tambah/rename kategori; duplikat case-insensitive setelah trim → 409.
 *  6. Hapus kategori terpakai (aktif MAUPUN nonaktif) → 409. Hapus kategori kosong → 200.
 *  7. Tanpa token dan tanpa permission sesuai operasi ditolak.
 *
 * Handler/middleware AKTUAL via dist/index — TIDAK menyalin logika.
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://USER:PASS@localhost:PORT/<db>_test \
 *   node backend/test/master_product_management_test.js
 */

'use strict';

// ─── DB SAFETY GUARD ──────────────────────────────────────────────────────────
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !testUrl.trim()) {
  console.error(
    'SAFETY: TEST_DATABASE_URL tidak di-set.\n' +
    'Jalankan: TEST_DATABASE_URL=postgres://USER:PASS@localhost:PORT/<db>_test ' +
    'node backend/test/master_product_management_test.js'
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
  console.log(`[MASTER PRODUCT MGMT TEST] Target DB: ${database} (user: ${user}, port: ${port})`);
} catch (e) {
  console.error('SAFETY: TEST_DATABASE_URL ditolak — ' + e.message);
  process.exit(1);
}

process.env.DB_HOST = target.host;
process.env.DB_PORT = String(target.port);
process.env.DB_USER = target.user;
process.env.DB_PASSWORD = target.password;
process.env.DB_NAME = target.database;

const http = require('http');
const { once } = require('events');
const { app, pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');

let server;
let baseUrl;
let passed = 0;
let failed = 0;
const tracked = { properties: [], users: [], roles: [], items: [], categories: [] };

function expect(condition, msg) {
  if (condition) { passed += 1; console.log('PASS | ' + msg); }
  else { failed += 1; console.error('FAIL | ' + msg); }
}

async function api(method, path, body, authToken) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (authToken) opts.headers.Authorization = `Bearer ${authToken}`;
  if (body !== undefined && body !== null && method !== 'GET') opts.body = JSON.stringify(body);
  const res = await fetch(baseUrl + path, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// ── cleanup ───────────────────────────────────────────────────────────────────
async function cleanup() {
  const client = await pool.connect();
  const errors = [];
  const cleanupQueries = [
    ['pos_menu_items', (id) => `DELETE FROM pos_menu_items WHERE id = $1`, tracked.items],
    ['pos_menu_categories', (id) => `DELETE FROM pos_menu_categories WHERE id = $1`, tracked.categories],
    ['users', (id) => `DELETE FROM users WHERE id = $1`, tracked.users],
    ['role_permissions', (id) => `DELETE FROM role_permissions WHERE role_id = $1`, tracked.roles],
    ['roles', (id) => `DELETE FROM roles WHERE id = $1`, tracked.roles],
    ['properties', (id) => `DELETE FROM properties WHERE id = $1`, tracked.properties],
  ];
  try {
    for (const [label, sqlFor, ids] of cleanupQueries) {
      for (const id of ids) {
        try {
          await client.query(sqlFor(id), [id]);
        } catch (e) {
          errors.push(`${label}[id=${id}]: ${e.message}`);
          console.error('CLEANUP ERROR | ' + `${label}[id=${id}]: ${e.message}`);
        }
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

// ── fixture helpers ───────────────────────────────────────────────────────────
async function createUserForProperty(client, propertyId, tag, grantKeys) {
  const roleRes = await client.query(
    `INSERT INTO roles (property_id, name, is_system_role, is_active)
     VALUES ($1, $2, FALSE, TRUE) RETURNING id`,
    [propertyId, `MPM-${tag}-ROLE`]
  );
  const roleId = roleRes.rows[0].id;
  tracked.roles.push(roleId);

  const userRes = await client.query(
    `INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING id`,
    [propertyId, roleId, `mpm_${tag.toLowerCase()}_${Date.now() % 100000}`, `mpm_${tag.toLowerCase()}@oak.test`, 'x', `MPM ${tag}`]
  );
  const userId = userRes.rows[0].id;
  tracked.users.push(userId);

  if (grantKeys && grantKeys.length > 0) {
    const permRes = await client.query(
      `SELECT id FROM permissions WHERE key = ANY($1)`,
      [grantKeys]
    );
    for (const p of permRes.rows) {
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id, granted, created_by)
         VALUES ($1, $2, TRUE, 'mpm-test')
         ON CONFLICT (role_id, permission_id) DO NOTHING`,
        [roleId, p.id]
      );
    }
  }
  return { userId, roleId };
}

function tokenFor(userId, propertyId) {
  return generateToken({
    id: userId,
    email: `mpm_${userId}@oak.test`,
    username: `mpm_${userId}`,
    full_name: `MPM ${userId}`,
    role: 'Front Office',
    role_id: null,
    property_id: propertyId,
    scope: 'FULL',
  });
}

async function setupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const propA = await client.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('MPM Prop A', 'MPMA', 'Asia/Jakarta', 'IDR', 'MPM A', TRUE) RETURNING id"
    );
    tracked.properties.push(propA.rows[0].id);
    const pidA = propA.rows[0].id;

    const propB = await client.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('MPM Prop B', 'MPMB', 'Asia/Jakarta', 'IDR', 'MPM B', TRUE) RETURNING id"
    );
    tracked.properties.push(propB.rows[0].id);
    const pidB = propB.rows[0].id;

    // User A: full Master Produk access (view+create+edit+delete)
    const userA = await createUserForProperty(client, pidA, 'A', [
      'inventory.view', 'inventory.create', 'inventory.edit', 'inventory.delete',
    ]);
    // User B: hanya view (tidak bisa PATCH/POST/DELETE)
    const userB = await createUserForProperty(client, pidB, 'B', ['inventory.view']);
    // User C di properti B, tanpa permission apa pun
    const userC = await createUserForProperty(client, pidB, 'C', []);

    // Item di properti A
    const itemA1 = await client.query(
      `INSERT INTO pos_menu_items (property_id, item_code, name, description, price, is_active)
       VALUES ($1, 'MPMA-001', 'Item Alpha', 'Deskripsi Alpha', 5000, TRUE) RETURNING id`,
      [pidA]
    );
    tracked.items.push(itemA1.rows[0].id);

    const itemA2 = await client.query(
      `INSERT INTO pos_menu_items (property_id, item_code, name, description, price, is_active)
       VALUES ($1, 'MPMA-002', 'Item Beta', 'Deskripsi Beta', 7000, FALSE) RETURNING id`,
      [pidA]
    );
    tracked.items.push(itemA2.rows[0].id);

    // Item di properti B
    const itemB1 = await client.query(
      `INSERT INTO pos_menu_items (property_id, item_code, name, price, is_active)
       VALUES ($1, 'MPMB-001', 'Item Gamma', 9000, TRUE) RETURNING id`,
      [pidB]
    );
    tracked.items.push(itemB1.rows[0].id);

    // Kategori di properti A
    const catA1 = await client.query(
      `INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, 'F&B') RETURNING id`,
      [pidA]
    );
    tracked.categories.push(catA1.rows[0].id);

    const catA2 = await client.query(
      `INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, 'Minibar') RETURNING id`,
      [pidA]
    );
    tracked.categories.push(catA2.rows[0].id);

    // Kategori di properti B (untuk uji cross-property)
    const catB1 = await client.query(
      `INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, 'Minibar B') RETURNING id`,
      [pidB]
    );
    tracked.categories.push(catB1.rows[0].id);

    // Item A1 dikaitkan dengan catA1
    await client.query(
      'UPDATE pos_menu_items SET category_id = $1 WHERE id = $2',
      [catA1.rows[0].id, itemA1.rows[0].id]
    );

    await client.query('COMMIT');
    return {
      pidA, pidB,
      tokenA: tokenFor(userA.userId, pidA),
      tokenB: tokenFor(userB.userId, pidB),
      tokenC: tokenFor(userC.userId, pidB),
      itemA1: itemA1.rows[0].id,
      itemA2: itemA2.rows[0].id,
      itemB1: itemB1.rows[0].id,
      catA1: catA1.rows[0].id,
      catA2: catA2.rows[0].id,
      catB1: catB1.rows[0].id,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function verifyPoolConfig() {
  const cfg = pool.options || pool.config || {};
  const mismatches = [];
  if (String(cfg.host || '') !== target.host) mismatches.push(`host: pool="${cfg.host}" target="${target.host}"`);
  if (Number(cfg.port) !== target.port) mismatches.push(`port: pool="${cfg.port}" target="${target.port}"`);
  if (String(cfg.user || '') !== target.user) mismatches.push(`user: pool="${cfg.user}" target="${target.user}"`);
  if (String(cfg.database || '') !== target.database) mismatches.push(`database: pool="${cfg.database}" target="${target.database}"`);
  return mismatches;
}

// ── Test scenarios will be added in next sections ────────────────────────────
// (placeholder — see testPatch, testStatusFilter, testCategories, testAuth)

async function main() {
  const poolMismatches = verifyPoolConfig();
  if (poolMismatches.length > 0) {
    console.error('POOL CONFIG MISMATCH:\n  - ' + poolMismatches.join('\n  - '));
    try { await pool.end(); } catch (e) { console.error('POOL END ERROR | ' + (e && e.message)); }
    process.exitCode = 1;
    return;
  }

  server = http.createServer(app);
  const serverReady = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  let identityVerified = false;

  try {
    await serverReady;
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    const idCheck = await pool.query('SELECT current_database() AS db, current_user AS usr');
    const idRow = (idCheck.rows && idCheck.rows[0]) || {};
    const dbOk = String(idRow.db || '').toLowerCase() === target.database.toLowerCase();
    const usrOk = String(idRow.usr || '').toLowerCase() === target.user.toLowerCase();
    if (!dbOk || !usrOk) {
      console.error(`IDENTITY MISMATCH: db="${idRow.db}" (target "${target.database}"), usr="${idRow.usr}" (target "${target.user}")`);
      process.exitCode = 1;
      throw new Error('identity mismatch');
    }
    identityVerified = true;
    console.log(`Koneksi terverifikasi: db=${idRow.db} user=${idRow.usr}`);

    const fx = await setupFixtures();
    await testAuth(fx);
    await testPatch(fx);
    await testStatusFilter(fx);
    await testCategories(fx);
    await testPermission(fx);
    await testCrossProperty(fx);
    await testCreateCategoryId(fx);
    await testTypeValidation(fx);
    await testConcurrency(fx);
    await testDeleteCategoryInactiveOnly(fx);
    await testPutCategoryPermission(fx);
    await testConcurrentCompatRename(fx);
    await testEditOnlyPatchIsActive(fx);
  } catch (e) {
    console.error('TEST STAGE ERROR | ' + (e && e.message));
    process.exitCode = 1;
  } finally {
    if (identityVerified) {
      try { await cleanup(); } catch (e) { console.error('CLEANUP ERROR | ' + (e && e.message)); process.exitCode = 1; }
      try { await verifyResidue(); } catch (e) { console.error('RESIDUE CHECK ERROR | ' + (e && e.message)); process.exitCode = 1; }
    }
    try {
      if (server && !server.closed) {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        await once(server.close(), 'close');
      }
    } catch (e) {
      // server.close() gagal => proses tidak bisa berakhir bersih: exit nonzero.
      console.error('SERVER CLOSE ERROR | ' + (e && e.message));
      process.exitCode = 1;
    }
    try { await pool.end(); } catch (e) { console.error('POOL END ERROR | ' + (e && e.message)); process.exitCode = 1; }
  }

  if (identityVerified) {
    console.log('\n' + '='.repeat(60));
    console.log(`[MASTER PRODUCT MGMT TEST] Hasil: ${passed} PASS, ${failed} FAIL`);
    if (failed > 0) process.exitCode = 1;
  }
  // Exit eksplisit: proses tidak boleh menggantung karena pool/SSE/realtime.
  process.exit(process.exitCode || 0);
}

async function verifyResidue() {
  const client = await pool.connect();
  const residue = [];
  try {
    const counts = [
      { label: 'pos_menu_items', ids: tracked.items, q: `SELECT COUNT(*)::int AS c FROM pos_menu_items WHERE id = ANY($1)` },
      { label: 'pos_menu_categories', ids: tracked.categories, q: `SELECT COUNT(*)::int AS c FROM pos_menu_categories WHERE id = ANY($1)` },
      { label: 'users', ids: tracked.users, q: `SELECT COUNT(*)::int AS c FROM users WHERE id = ANY($1)` },
      { label: 'role_permissions', ids: tracked.roles, q: `SELECT COUNT(*)::int AS c FROM role_permissions WHERE role_id = ANY($1)` },
      { label: 'roles', ids: tracked.roles, q: `SELECT COUNT(*)::int AS c FROM roles WHERE id = ANY($1)` },
      { label: 'properties', ids: tracked.properties, q: `SELECT COUNT(*)::int AS c FROM properties WHERE id = ANY($1)` },
    ];
    for (const { label, ids, q } of counts) {
      if (ids.length === 0) continue;
      const r = await client.query(q, [ids]);
      const c = Number(r.rows[0].c);
      residue.push({ label, remaining: c });
      if (c > 0) failed += 1;
      console.log(`${c > 0 ? 'FAIL' : 'PASS'} | residu ${label}: ${c} baris tersisa`);
    }
  } finally {
    client.release();
  }
}

// ── [2] PATCH item scenarios ─────────────────────────────────────────────────
async function testPatch(fx) {
  console.log('\n[2] PATCH item parsial & full');

  // 2a. PATCH hanya name — field lain tidak berubah
  const patchName = await api('PATCH', `/api/pos/menu/items/${fx.itemA1}?property_id=${fx.pidA}`,
    { name: 'Item Alpha Edit' }, fx.tokenA);
  expect(patchName.status === 200, `PATCH hanya name -> 200 (got ${patchName.status})`);
  const p1 = (patchName.json && patchName.json.data) || {};
  expect(p1.name === 'Item Alpha Edit', 'PATCH name tersimpan');

  // Verifikasi field lain tetap (price tetap 5000, description tetap)
  const dbCheck1 = await pool.query(
    'SELECT price, description, item_code, category_id, is_active FROM pos_menu_items WHERE id = $1',
    [fx.itemA1]
  );
  const r1 = dbCheck1.rows[0];
  expect(Number(r1.price) === 5000, `PATCH parsial: price tidak berubah (got ${r1.price})`);
  expect(r1.description === 'Deskripsi Alpha', 'PATCH parsial: description tidak berubah');
  expect(r1.item_code === 'MPMA-001', 'PATCH parsial: item_code tidak berubah');
  expect(r1.is_active === true, 'PATCH parsial: is_active tetap TRUE');

  // 2b. PATCH harga
  const patchPrice = await api('PATCH', `/api/pos/menu/items/${fx.itemA1}?property_id=${fx.pidA}`,
    { price: 6500 }, fx.tokenA);
  expect(patchPrice.status === 200, `PATCH price -> 200 (got ${patchPrice.status})`);

  // 2c. PATCH description
  const patchDesc = await api('PATCH', `/api/pos/menu/items/${fx.itemA1}?property_id=${fx.pidA}`,
    { description: 'Deskripsi baru' }, fx.tokenA);
  expect(patchDesc.status === 200, `PATCH description -> 200 (got ${patchDesc.status})`);

  // 2d. PATCH item_code
  const patchCode = await api('PATCH', `/api/pos/menu/items/${fx.itemA1}?property_id=${fx.pidA}`,
    { item_code: 'MPMA-001X' }, fx.tokenA);
  expect(patchCode.status === 200, `PATCH item_code -> 200 (got ${patchCode.status})`);

  // 2e. PATCH category_id (kategori milik properti A)
  const patchCat = await api('PATCH', `/api/pos/menu/items/${fx.itemA1}?property_id=${fx.pidA}`,
    { category_id: fx.catA2 }, fx.tokenA);
  expect(patchCat.status === 200, `PATCH category_id -> 200 (got ${patchCat.status})`);

  // 2f. PATCH category_id = null (hapus kategori)
  const patchCatNull = await api('PATCH', `/api/pos/menu/items/${fx.itemA1}?property_id=${fx.pidA}`,
    { category_id: null }, fx.tokenA);
  expect(patchCatNull.status === 200, `PATCH category_id=null -> 200 (got ${patchCatNull.status})`);
  const dbCat = await pool.query('SELECT category_id FROM pos_menu_items WHERE id = $1', [fx.itemA1]);
  expect(dbCat.rows[0].category_id === null, 'PATCH category_id=null tersimpan');

  // 2g. PATCH is_active false (nonaktifkan)
  const patchInactive = await api('PATCH', `/api/pos/menu/items/${fx.itemA1}?property_id=${fx.pidA}`,
    { is_active: false }, fx.tokenA);
  expect(patchInactive.status === 200, `PATCH is_active=false -> 200 (got ${patchInactive.status})`);

  // 2h. PATCH is_active true (aktifkan kembali)
  const patchActive = await api('PATCH', `/api/pos/menu/items/${fx.itemA1}?property_id=${fx.pidA}`,
    { is_active: true }, fx.tokenA);
  expect(patchActive.status === 200, `PATCH is_active=true -> 200 (got ${patchActive.status})`);

  // 2i. PATCH item di properti B oleh user A → item tidak ada di properti A,
  // UPDATE 0 baris → 404 (tidak bocor keberadaan item B, pola tahap 1).
  const patchCross = await api('PATCH', `/api/pos/menu/items/${fx.itemB1}?property_id=${fx.pidA}`,
    { name: 'Hacked' }, fx.tokenA);
  expect([403, 404].includes(patchCross.status), `PATCH item B oleh user A -> 403/404 (got ${patchCross.status})`);
  const dbB = await pool.query('SELECT name FROM pos_menu_items WHERE id = $1', [fx.itemB1]);
  expect(dbB.rows[0].name === 'Item Gamma', 'Item B tidak berubah setelah PATCH cross-property');

  // 2j. Kode duplikat → 409 (itemA2 punya kode MPMA-002, coba patch itemA1 ke kode itu)
  const dupCode = await api('PATCH', `/api/pos/menu/items/${fx.itemA1}?property_id=${fx.pidA}`,
    { item_code: 'MPMA-002' }, fx.tokenA);
  expect(dupCode.status === 409, `PATCH item_code duplikat -> 409 (got ${dupCode.status})`);
  const dupCodeCode = (dupCode.json && dupCode.json.code) || '';
  expect(dupCodeCode === 'ITEM_CODE_DUPLICATE', `409 code=ITEM_CODE_DUPLICATE (got "${dupCodeCode}")`);

  // 2k. PATCH kategori asing (catB1 milik properti B) → ditolak eksplisit + DB tidak berubah
  const beforeCat = await pool.query('SELECT category_id FROM pos_menu_items WHERE id = $1', [fx.itemA1]);
  const foreignCat = await api('PATCH', `/api/pos/menu/items/${fx.itemA1}?property_id=${fx.pidA}`,
    { category_id: fx.catB1 }, fx.tokenA);
  expect(foreignCat.status === 400, `PATCH category asing -> 400 (got ${foreignCat.status})`);
  const foreignCatCode = (foreignCat.json && foreignCat.json.code) || '';
  expect(foreignCatCode === 'CATEGORY_NOT_FOUND', `400 code=CATEGORY_NOT_FOUND (got "${foreignCatCode}")`);
  const afterCat = await pool.query('SELECT category_id FROM pos_menu_items WHERE id = $1', [fx.itemA1]);
  expect(String(afterCat.rows[0].category_id) === String(beforeCat.rows[0].category_id),
    'Kategori item tidak berubah setelah penolakan kategori asing');

  // 2l. PATCH item di properti B oleh user B (properti B, view-only)
  const patchViewOnly = await api('PATCH', `/api/pos/menu/items/${fx.itemB1}?property_id=${fx.pidB}`,
    { name: 'ViewOnly' }, fx.tokenB);
  expect(patchViewOnly.status === 403, `PATCH oleh user view-only -> 403 (got ${patchViewOnly.status})`);
}

// ── [3] Status filter scenarios ──────────────────────────────────────────────
async function testStatusFilter(fx) {
  console.log('\n[3] GET /api/pos/menu status filter');

  // Pastikan state awal: itemA1=aktif, itemA2=nonaktif
  const dbState = await pool.query(
    'SELECT is_active FROM pos_menu_items WHERE id IN ($1, $2)',
    [fx.itemA1, fx.itemA2]
  );
  const stateMap = {};
  for (const row of dbState.rows) stateMap[row.id] = row.is_active;
  // itemA1 mungkin sudah diaktifkan kembali di 2h; pastikan
  if (!stateMap[fx.itemA1]) {
    await api('PATCH', `/api/pos/menu/items/${fx.itemA1}?property_id=${fx.pidA}`, { is_active: true }, fx.tokenA);
  }

  // 3a. Default (tanpa param) → active only
  const defaultGet = await api('GET', `/api/pos/menu?property_id=${fx.pidA}`, null, fx.tokenA);
  expect(defaultGet.status === 200, `GET default -> 200 (got ${defaultGet.status})`);
  const defaultItems = ((defaultGet.json && defaultGet.json.data && defaultGet.json.data.items) || []).map((i) => i.id);
  expect(defaultItems.includes(fx.itemA1), 'Default (active): item aktif ada');
  expect(!defaultItems.includes(fx.itemA2), 'Default (active): item nonaktif tidak ada');

  // 3b. ?status=inactive → hanya yang nonaktif
  const inactiveGet = await api('GET', `/api/pos/menu?property_id=${fx.pidA}&status=inactive`, null, fx.tokenA);
  expect(inactiveGet.status === 200, `GET status=inactive -> 200 (got ${inactiveGet.status})`);
  const inactiveItems = ((inactiveGet.json && inactiveGet.json.data && inactiveGet.json.data.items) || []).map((i) => i.id);
  expect(inactiveItems.includes(fx.itemA2), 'inactive: item nonaktif ada');
  expect(!inactiveItems.includes(fx.itemA1), 'inactive: item aktif tidak ada');

  // 3c. ?status=all → semua
  const allGet = await api('GET', `/api/pos/menu?property_id=${fx.pidA}&status=all`, null, fx.tokenA);
  expect(allGet.status === 200, `GET status=all -> 200 (got ${allGet.status})`);
  const allItems = ((allGet.json && allGet.json.data && allGet.json.data.items) || []).map((i) => i.id);
  expect(allItems.includes(fx.itemA1), 'all: item aktif ada');
  expect(allItems.includes(fx.itemA2), 'all: item nonaktif ada');

  // 3d. ?status=active → eksplisit
  const activeGet = await api('GET', `/api/pos/menu?property_id=${fx.pidA}&status=active`, null, fx.tokenA);
  expect(activeGet.status === 200, `GET status=active -> 200 (got ${activeGet.status})`);
  const activeItems = ((activeGet.json && activeGet.json.data && activeGet.json.data.items) || []).map((i) => i.id);
  expect(activeItems.includes(fx.itemA1), 'active: item aktif ada');
  expect(!activeItems.includes(fx.itemA2), 'active: item nonaktif tidak ada');

  // 3e. Status tidak valid → default active (tidak error, tidak 400)
  const badStatus = await api('GET', `/api/pos/menu?property_id=${fx.pidA}&status=invalid_val`, null, fx.tokenA);
  expect(badStatus.status === 200, `GET status=invalid -> 200 (default active) (got ${badStatus.status})`);
  const badItems = ((badStatus.json && badStatus.json.data && badStatus.json.data.items) || []).map((i) => i.id);
  expect(!badItems.includes(fx.itemA2), 'status invalid -> default active (nonaktif tidak ada)');
}

// ── [4] Category scenarios ──────────────────────────────────────────────────
async function testCategories(fx) {
  console.log('\n[4] Kategori CRUD');

  // 4a. Tambah kategori baru
  const postCat = await api('POST', '/api/pos/menu/categories',
    { property_id: fx.pidA, name: 'Barang Ritel' }, fx.tokenA);
  expect(postCat.status === 201 || postCat.status === 200,
    `POST kategori baru -> 201/200 (got ${postCat.status})`);
  const newCat = (postCat.json && postCat.json.data) || {};
  const newCatId = newCat.id;
  if (newCatId && !tracked.categories.includes(newCatId)) tracked.categories.push(newCatId);

  // 4b. Duplikat case-insensitive dengan trim
  const dupCat = await api('POST', '/api/pos/menu/categories',
    { property_id: fx.pidA, name: '  f&b ' }, fx.tokenA);
  expect(dupCat.status === 409, `POST duplikat kategori (case-insensitive+trim) -> 409 (got ${dupCat.status})`);

  // 4c. Rename kategori
  const rename = await api('PUT', `/api/pos/menu/categories/${fx.catA1}?property_id=${fx.pidA}`,
    { name: 'Makanan & Minuman' }, fx.tokenA);
  expect(rename.status === 200, `PUT rename kategori -> 200 (got ${rename.status})`);
  const dbCat1 = await pool.query('SELECT name FROM pos_menu_categories WHERE id = $1', [fx.catA1]);
  expect(dbCat1.rows[0].name === 'Makanan & Minuman', 'Rename tersimpan');

  // 4d. Rename ke nama yang sudah ada → 409
  const renameDup = await api('PUT', `/api/pos/menu/categories/${fx.catA1}?property_id=${fx.pidA}`,
    { name: 'Minibar' }, fx.tokenA);
  expect(renameDup.status === 409, `Rename ke nama duplikat -> 409 (got ${renameDup.status})`);
  // Kembalikan nama
  await api('PUT', `/api/pos/menu/categories/${fx.catA1}?property_id=${fx.pidA}`,
    { name: 'Makanan & Minuman' }, fx.tokenA);

  // 4e. Hapus kategori terpakai item AKTIF (catA1 dipakai itemA1... itemA1 tidak pakai
  // kategori setelah 2f/2g. Buat item baru yang pakai catA1)
  const client = await pool.connect();
  let usedCatItemId;
  try {
    const itemRes = await client.query(
      `INSERT INTO pos_menu_items (property_id, item_code, name, price, category_id, is_active)
       VALUES ($1, 'MPMA-USED-ACTIVE', 'Item Pakai Kat Aktif', 1000, $2, TRUE) RETURNING id`,
      [fx.pidA, fx.catA1]
    );
    usedCatItemId = itemRes.rows[0].id;
    tracked.items.push(usedCatItemId);
  } finally { client.release(); }

  const delUsedActive = await api('DELETE', `/api/pos/menu/categories/${fx.catA1}?property_id=${fx.pidA}`, null, fx.tokenA);
  expect(delUsedActive.status === 409, `Hapus kategori terpakai item aktif -> 409 (got ${delUsedActive.status})`);
  const delUsedCode = (delUsedActive.json && delUsedActive.json.code) || '';
  expect(delUsedCode === 'CATEGORY_IN_USE', `409 code=CATEGORY_IN_USE (got "${delUsedCode}")`);

  // 4f. Hapus kategori terpakai item NONAKTIF → 409 juga
  let usedCatInactiveItemId;
  {
    const c2 = await pool.connect();
    try {
      const itemRes2 = await c2.query(
        `INSERT INTO pos_menu_items (property_id, item_code, name, price, category_id, is_active)
         VALUES ($1, 'MPMA-USED-INACT', 'Item Pakai Kat Nonaktif', 1000, $2, FALSE) RETURNING id`,
        [fx.pidA, fx.catA1]
      );
      usedCatInactiveItemId = itemRes2.rows[0].id;
      tracked.items.push(usedCatInactiveItemId);
    } finally { c2.release(); }
  }
  const delUsedInactive = await api('DELETE', `/api/pos/menu/categories/${fx.catA1}?property_id=${fx.pidA}`, null, fx.tokenA);
  expect(delUsedInactive.status === 409, `Hapus kategori terpakai item nonaktif -> 409 (got ${delUsedInactive.status})`);

  // 4g. Hapus kategori kosong (catA2 tidak dipakai item mana pun)
  const delEmpty = await api('DELETE', `/api/pos/menu/categories/${fx.catA2}?property_id=${fx.pidA}`, null, fx.tokenA);
  expect(delEmpty.status === 200, `Hapus kategori kosong -> 200 (got ${delEmpty.status})`);
  const dbCatGone = await pool.query('SELECT COUNT(*)::int AS c FROM pos_menu_categories WHERE id = $1', [fx.catA2]);
  expect(Number(dbCatGone.rows[0].c) === 0, 'Kategori kosong terhapus dari DB');
}

// ── [5] Permission scenarios ────────────────────────────────────────────────
async function testPermission(fx) {
  console.log('\n[5] Permission (view-only / tanpa akses)');

  // User B (view-only) di properti B:
  const getB = await api('GET', `/api/pos/menu?property_id=${fx.pidB}`, null, fx.tokenB);
  expect(getB.status === 200, `GET menu oleh view-only -> 200 (got ${getB.status})`);

  const postB = await api('POST', '/api/pos/menu/categories',
    { property_id: fx.pidB, name: 'New Cat' }, fx.tokenB);
  expect(postB.status === 403, `POST kategori oleh view-only -> 403 (got ${postB.status})`);

  const patchB = await api('PATCH', `/api/pos/menu/items/${fx.itemB1}?property_id=${fx.pidB}`,
    { name: 'Hacked' }, fx.tokenB);
  expect(patchB.status === 403, `PATCH item oleh view-only -> 403 (got ${patchB.status})`);

  const delB = await api('DELETE', `/api/pos/menu/categories/${fx.catB1}?property_id=${fx.pidB}`, null, fx.tokenB);
  expect(delB.status === 403, `DELETE kategori oleh view-only -> 403 (got ${delB.status})`);

  // User C (tanpa permission apa pun) di properti B:
  const getC = await api('GET', `/api/pos/menu?property_id=${fx.pidB}`, null, fx.tokenC);
  expect(getC.status === 403, `GET menu oleh user tanpa akses -> 403 (got ${getC.status})`);
}

// ── [6] Cross-property scenarios ────────────────────────────────────────────
async function testCrossProperty(fx) {
  console.log('\n[6] Cross-property');

  // User A (properti A) tidak boleh melihat/operasi properti B
  const getB = await api('GET', `/api/pos/menu?property_id=${fx.pidB}`, null, fx.tokenA);
  expect(getB.status === 403, `GET menu properti B oleh user A -> 403 (got ${getB.status})`);

  const postCatB = await api('POST', '/api/pos/menu/categories',
    { property_id: fx.pidB, name: 'X' }, fx.tokenA);
  expect(postCatB.status === 403, `POST kategori properti B oleh user A -> 403 (got ${postCatB.status})`);

  // User A tidak bisa hapus kategori properti B
  const delCatB = await api('DELETE', `/api/pos/menu/categories/${fx.catB1}?property_id=${fx.pidB}`, null, fx.tokenA);
  expect(delCatB.status === 403, `DELETE kategori properti B oleh user A -> 403 (got ${delCatB.status})`);
}

// ── [1] Auth scenarios ─────────────────────────────────────────────────────
async function testAuth(fx) {
  console.log('\n[1] Tanpa autentikasi');
  const noAuth = await api('PATCH', `/api/pos/menu/items/${fx.itemA1}?property_id=${fx.pidA}`, { name: 'NoAuth' }, null);
  expect(noAuth.status === 401, `PATCH tanpa token -> 401 (got ${noAuth.status})`);

  const noAuthPost = await api('POST', '/api/pos/menu/categories', { property_id: fx.pidA, name: 'NoAuthCat' }, null);
  expect(noAuthPost.status === 401, `POST kategori tanpa token -> 401 (got ${noAuthPost.status})`);

  const noAuthDel = await api('DELETE', `/api/pos/menu/categories/${fx.catA1}?property_id=${fx.pidA}`, null, null);
  expect(noAuthDel.status === 401, `DELETE kategori tanpa token -> 401 (got ${noAuthDel.status})`);

  // PUT kategori tanpa token
  const noAuthPut = await api('PUT', `/api/pos/menu/categories/${fx.catA1}?property_id=${fx.pidA}`,
    { name: 'NoAuthRename' }, null);
  expect(noAuthPut.status === 401, `PUT kategori tanpa token -> 401 (got ${noAuthPut.status})`);
}

// ── [7] CREATE dengan category_id ──────────────────────────────────────────
async function testCreateCategoryId(fx) {
  console.log('\n[7] CREATE produk dengan category_id');

  // 7a. CREATE dengan category_id milik properti sendiri → tersimpan + category_name aktual
  const mkCat = await api('POST', '/api/pos/menu/categories',
    { property_id: fx.pidA, name: 'Kategori 7x' }, fx.tokenA);
  const cat7 = (mkCat.json && mkCat.json.data) || {};
  if (cat7.id && !tracked.categories.includes(cat7.id)) tracked.categories.push(cat7.id);

  const create = await api('POST', '/api/pos/menu/items', {
    property_id: fx.pidA,
    name: 'Item Delta',
    item_code: 'MPMA-700',
    category_id: cat7.id,
    price: 0,
    description: null
  }, fx.tokenA);
  expect(create.status === 201, `CREATE dengan category_id sendiri -> 201 (got ${create.status})`);
  const createdRow = (create.json && create.json.data) || {};
  if (createdRow.id) tracked.items.push(createdRow.id);
  const dbCreated = await pool.query(
    `SELECT mi.category_id, mi.price, pmc.name AS category_name
     FROM pos_menu_items mi LEFT JOIN pos_menu_categories pmc ON pmc.id = mi.category_id
     WHERE mi.id = $1`,
    [createdRow.id]
  );
  expect(dbCreated.rows.length === 1 && Number(dbCreated.rows[0].category_id) === Number(cat7.id),
    'CREATE: category_id tersimpan benar');
  expect(Number(createdRow.price) === 0, 'CREATE: harga 0 tersimpan (bukan null/kosong)');
  const createdCatName = String(createdRow.category_name || '');
  expect(createdCatName === 'Kategori 7x', `CREATE: category_name aktual dari DB (got "${createdCatName}")`);

  // 7b. CREATE dengan category_id = null → tetap null (bukan fallback)
  const createNull = await api('POST', '/api/pos/menu/items', {
    property_id: fx.pidA,
    name: 'Item Epsilon',
    item_code: 'MPMA-701',
    category_id: null,
    price: 12000
  }, fx.tokenA);
  expect(createNull.status === 201, `CREATE category_id=null -> 201 (got ${createNull.status})`);
  const nullRow = (createNull.json && createNull.json.data) || {};
  if (nullRow.id) tracked.items.push(nullRow.id);
  expect(nullRow.category_id === null, 'CREATE category_id=null tetap null');
  expect(nullRow.category_name === null || nullRow.category_name === undefined || nullRow.category_name === '',
    `CREATE category_id=null tidak memalsukan category_name (got "${nullRow.category_name}")`);

  // 7c. CREATE dengan category_id asing (catB1 milik properti B) → 400 eksplisit, tidak ada item
  const createForeign = await api('POST', '/api/pos/menu/items', {
    property_id: fx.pidA,
    name: 'Item Zeta',
    item_code: 'MPMA-702',
    category_id: fx.catB1,
    price: 5000
  }, fx.tokenA);
  expect(createForeign.status === 400, `CREATE category asing -> 400 (got ${createForeign.status})`);
  const foreignCode = (createForeign.json && createForeign.json.code) || '';
  expect(foreignCode === 'CATEGORY_NOT_FOUND', `400 code=CATEGORY_NOT_FOUND (got "${foreignCode}")`);
  const leaked = await pool.query(
    'SELECT COUNT(*)::int AS c FROM pos_menu_items WHERE property_id = $1 AND item_code = $2',
    [fx.pidA, 'MPMA-702']
  );
  expect(Number(leaked.rows[0].c) === 0, 'CREATE kategori asing tidak membuat item');

  // 7d. Precedence: category_id dikirim bersama category_name → category_id menang
  const createPrec = await api('POST', '/api/pos/menu/items', {
    property_id: fx.pidA,
    name: 'Item Eta',
    item_code: 'MPMA-703',
    category_id: cat7.id,
    category_name: 'Kategori Lain 7y',
    price: 3000
  }, fx.tokenA);
  expect(createPrec.status === 201, `CREATE dgn keduanya -> 201 (got ${createPrec.status})`);
  const precRow = (createPrec.json && createPrec.json.data) || {};
  if (precRow.id) tracked.items.push(precRow.id);
  expect(Number(precRow.category_id) === Number(cat7.id),
    'Precedence: category_id menang atas category_name');
  // Kategori 'Kategori Lain 7y' TIDAK boleh terbuat
  const noGhost = await pool.query(
    'SELECT COUNT(*)::int AS c FROM pos_menu_categories WHERE property_id = $1 AND name = $2',
    [fx.pidA, 'Kategori Lain 7y']
  );
  expect(Number(noGhost.rows[0].c) === 0, 'Precedence: kategori ghost dari category_name tidak dibuat');

  // 7e. Compat: category_name tanpa category_id → kategori dibuat & dipakai
  const createCompat = await api('POST', '/api/pos/menu/items', {
    property_id: fx.pidA,
    name: 'Item Theta',
    item_code: 'MPMA-704',
    category_name: 'Kategori Compat 7z',
    price: 4000
  }, fx.tokenA);
  expect(createCompat.status === 201, `CREATE compat category_name -> 201 (got ${createCompat.status})`);
  const compatRow = (createCompat.json && createCompat.json.data) || {};
  if (compatRow.id) tracked.items.push(compatRow.id);
  const compatCat = await pool.query(
    'SELECT id FROM pos_menu_categories WHERE property_id = $1 AND LOWER(name) = LOWER($2)',
    [fx.pidA, 'Kategori Compat 7z']
  );
  expect(compatCat.rows.length === 1, 'Compat: kategori dibuat tepat satu');
  if (compatCat.rows[0] && !tracked.categories.includes(compatCat.rows[0].id)) tracked.categories.push(compatCat.rows[0].id);
  expect(Number(compatRow.category_id) === Number(compatCat.rows[0]?.id || 0), 'Compat: item memakai kategori baru');
}

// ── [8] Validasi tipe input ────────────────────────────────────────────────
async function testTypeValidation(fx) {
  console.log('\n[8] Validasi tipe input (CREATE/PATCH/kategori)');

  const badNameCases = [
    { label: 'name object', name: { id: 1 } },
    { label: 'name array', name: ['x'] },
    { label: 'name boolean', name: true },
    { label: 'name null', name: null },
    { label: 'name number', name: 123 },
  ];
  for (const c of badNameCases) {
    const before = await pool.query('SELECT name FROM pos_menu_items WHERE id = $1', [fx.itemA1]);
    const r = await api('PATCH', `/api/pos/menu/items/${fx.itemA1}?property_id=${fx.pidA}`,
      { name: c.name }, fx.tokenA);
    expect(r.status === 400, `PATCH ${c.label} -> 400 (got ${r.status})`);
    const after = await pool.query('SELECT name FROM pos_menu_items WHERE id = $1', [fx.itemA1]);
    expect(after.rows[0].name === before.rows[0].name, `PATCH ${c.label}: DB tidak berubah`);
  }

  // item_code salah tipe
  for (const c of [{ label: 'item_code object', item_code: { x: 1 } }, { label: 'item_code number', item_code: 42 }]) {
    const r = await api('PATCH', `/api/pos/menu/items/${fx.itemA1}?property_id=${fx.pidA}`,
      { item_code: c.item_code }, fx.tokenA);
    expect(r.status === 400, `PATCH ${c.label} -> 400 (got ${r.status})`);
  }
  // description salah tipe
  const badDesc = await api('PATCH', `/api/pos/menu/items/${fx.itemA1}?property_id=${fx.pidA}`,
    { description: ['arr'] }, fx.tokenA);
  expect(badDesc.status === 400, `PATCH description array -> 400 (got ${badDesc.status})`);

  // item_code whitespace-only dinormalisasi null
  const wsCode = await api('PATCH', `/api/pos/menu/items/${fx.itemA1}?property_id=${fx.pidA}`,
    { item_code: '   ' }, fx.tokenA);
  expect(wsCode.status === 200, `PATCH item_code whitespace -> 200 (got ${wsCode.status})`);
  const wsRow = await pool.query('SELECT item_code FROM pos_menu_items WHERE id = $1', [fx.itemA1]);
  expect(wsRow.rows[0].item_code === null, 'PATCH item_code whitespace dinormalisasi NULL');

  // CREATE name salah tipe → 400 tanpa item
  const badCreate = await api('POST', '/api/pos/menu/items', {
    property_id: fx.pidA, name: { evil: true }, price: 1000
  }, fx.tokenA);
  expect(badCreate.status === 400, `CREATE name object -> 400 (got ${badCreate.status})`);
  const cnt = await pool.query('SELECT COUNT(*)::int AS c FROM pos_menu_items WHERE property_id = $1 AND name = $2', [fx.pidA, '[object Object]']);
  expect(Number(cnt.rows[0].c) === 0, 'CREATE name object tidak menghasilkan item');

  // POST kategori name salah tipe → 400
  for (const c of [{ label: 'object', v: { a: 1 } }, { label: 'array', v: ['a'] }, { label: 'boolean', v: true }, { label: 'number', v: 9 }]) {
    const r = await api('POST', '/api/pos/menu/categories', { property_id: fx.pidA, name: c.v }, fx.tokenA);
    expect(r.status === 400, `POST kategori name ${c.label} -> 400 (got ${r.status})`);
  }
  // PUT kategori name salah tipe → 400
  const badPut = await api('PUT', `/api/pos/menu/categories/${fx.catA1}?property_id=${fx.pidA}`,
    { name: { x: 1 } }, fx.tokenA);
  expect(badPut.status === 400, `PUT kategori name object -> 400 (got ${badPut.status})`);
}

// ── [9] Concurrency ────────────────────────────────────────────────────────
async function testConcurrency(fx) {
  console.log('\n[9] Concurrency (kode & kategori)');

  // 9a. Dua CREATE dengan kode sama secara paralel → tepat satu 201, satu 409
  const code9 = 'MPMA-CONC-9';
  const [r1, r2] = await Promise.all([
    api('POST', '/api/pos/menu/items', { property_id: fx.pidA, name: 'Item Conc A', item_code: code9, price: 1000 }, fx.tokenA),
    api('POST', '/api/pos/menu/items', { property_id: fx.pidA, name: 'Item Conc B', item_code: code9, price: 1000 }, fx.tokenA),
  ]);
  const statuses = [r1.status, r2.status].sort();
  for (const r of [r1, r2]) {
    const row = (r.json && r.json.data) || {};
    if (r.status === 201 && row.id) tracked.items.push(row.id);
  }
  expect(statuses[0] === 201 && statuses[1] === 409,
    `CREATE concurrent kode sama -> satu 201 + satu 409 (got ${statuses.join(',')})`);
  const cnt9 = await pool.query('SELECT COUNT(*)::int AS c FROM pos_menu_items WHERE property_id = $1 AND item_code = $2', [fx.pidA, code9]);
  expect(Number(cnt9.rows[0].c) === 1, `Concurrent code: tepat 1 item tersimpan (got ${cnt9.rows[0].c})`);

  // 9b. Dua PATCH concurrent ke kode yang sama → tepat satu 200 dan satu 409.
  // Pre-check duplikat (di luar transaksi) membuat keduanya bisa lolos pre-check
  // lalu bersaing pada UPDATE; unique constraint uq_pmi_property_code menjamin
  // hanya satu menang. Kalah race = 409 ITEM_CODE_DUPLICATE (pre-check) ATAU
  // 409 dari constraint (race antar UPDATE). DB wajib konsisten: tepat satu item
  // memakai kode target.
  const itemX = await pool.query(
    `INSERT INTO pos_menu_items (property_id, item_code, name, price) VALUES ($1, 'MPMA-CONC-X', 'Conc X', 1000) RETURNING id`,
    [fx.pidA]
  );
  const xId = itemX.rows[0].id;
  tracked.items.push(xId);
  const itemY = await pool.query(
    `INSERT INTO pos_menu_items (property_id, item_code, name, price) VALUES ($1, 'MPMA-CONC-Y', 'Conc Y', 1000) RETURNING id`,
    [fx.pidA]
  );
  const yId = itemY.rows[0].id;
  tracked.items.push(yId);
  const target = 'MPMA-CONC-Z';
  const [p1, p2] = await Promise.all([
    api('PATCH', `/api/pos/menu/items/${xId}?property_id=${fx.pidA}`, { item_code: target }, fx.tokenA),
    api('PATCH', `/api/pos/menu/items/${yId}?property_id=${fx.pidA}`, { item_code: target }, fx.tokenA),
  ]);
  const pStatuses = [p1.status, p2.status].sort();
  expect(pStatuses[0] === 200 && pStatuses[1] === 409,
    `PATCH concurrent ke kode sama -> tepat satu 200 + satu 409 (got ${pStatuses.join(',')})`);
  const loser = [p1, p2].find((r) => r.status === 409);
  if (loser) {
    expect(((loser.json && loser.json.code) || '') === 'ITEM_CODE_DUPLICATE',
      `PATCH concurrent kalah race code=ITEM_CODE_DUPLICATE (got "${(loser.json && loser.json.code) || ''}")`);
  }
  const cntZ = await pool.query('SELECT COUNT(*)::int AS c FROM pos_menu_items WHERE property_id = $1 AND item_code = $2', [fx.pidA, target]);
  expect(Number(cntZ.rows[0].c) === 1, `PATCH concurrent: hanya 1 item memakai kode target (got ${cntZ.rows[0].c})`);

  // 9c. Dua POST kategori nama sama paralel → tepat satu 201, satu 409, tidak duplikat
  const catName = 'Kategori Concurrent 9';
  const [c1, c2] = await Promise.all([
    api('POST', '/api/pos/menu/categories', { property_id: fx.pidA, name: catName }, fx.tokenA),
    api('POST', '/api/pos/menu/categories', { property_id: fx.pidA, name: catName }, fx.tokenA),
  ]);
  const catStatuses = [c1.status, c2.status].sort();
  for (const r of [c1, c2]) {
    const row = (r.json && r.json.data) || {};
    if (r.status === 201 && row.id && !tracked.categories.includes(row.id)) tracked.categories.push(row.id);
  }
  expect(catStatuses[0] === 201 && catStatuses[1] === 409,
    `POST kategori concurrent -> satu 201 + satu 409 (got ${catStatuses.join(',')})`);
  const cntCat = await pool.query(
    'SELECT COUNT(*)::int AS c FROM pos_menu_categories WHERE property_id = $1 AND LOWER(name) = LOWER($2)',
    [fx.pidA, catName]
  );
  expect(Number(cntCat.rows[0].c) === 1, `Kategori concurrent: tidak duplikat (got ${cntCat.rows[0].c})`);

  // 9d. Concurrent CREATE produk via category_name sama → tidak membuat kategori duplikat
  const catName2 = 'Kategori Compat Concurrent';
  const [d1, d2] = await Promise.all([
    api('POST', '/api/pos/menu/items', { property_id: fx.pidA, name: 'Item CC 1', item_code: 'MPMA-CC1', price: 1000, category_name: catName2 }, fx.tokenA),
    api('POST', '/api/pos/menu/items', { property_id: fx.pidA, name: 'Item CC 2', item_code: 'MPMA-CC2', price: 1000, category_name: catName2 }, fx.tokenA),
  ]);
  for (const r of [d1, d2]) {
    const row = (r.json && r.json.data) || {};
    if (r.status === 201 && row.id) tracked.items.push(row.id);
  }
  expect(d1.status === 201 && d2.status === 201, `CREATE compat concurrent kedua 201 (got ${d1.status},${d2.status})`);
  const cntCat2 = await pool.query(
    'SELECT COUNT(*)::int AS c FROM pos_menu_categories WHERE property_id = $1 AND LOWER(name) = LOWER($2)',
    [fx.pidA, catName2]
  );
  expect(Number(cntCat2.rows[0].c) === 1, `Compat concurrent: kategori hanya satu (got ${cntCat2.rows[0].c})`);
  const catsCC = await pool.query(
    'SELECT id FROM pos_menu_categories WHERE property_id = $1 AND LOWER(name) = LOWER($2)',
    [fx.pidA, catName2]
  );
  if (catsCC.rows[0] && !tracked.categories.includes(catsCC.rows[0].id)) tracked.categories.push(catsCC.rows[0].id);
}

// ── [10] DELETE kategori hanya nonaktif (fixture terpisah) ─────────────────
async function testDeleteCategoryInactiveOnly(fx) {
  console.log('\n[10] Hapus kategori HANYA dipakai produk nonaktif');

  // Kategori khusus test ini
  const mk = await api('POST', '/api/pos/menu/categories', { property_id: fx.pidA, name: 'Kategori Nonaktif Only' }, fx.tokenA);
  const catId = ((mk.json && mk.json.data) || {}).id;
  if (catId && !tracked.categories.includes(catId)) tracked.categories.push(catId);

  const ins = await pool.query(
    `INSERT INTO pos_menu_items (property_id, item_code, name, price, category_id, is_active)
     VALUES ($1, 'MPMA-INACT-ONLY', 'Item Nonaktif Only', 1000, $2, FALSE) RETURNING id`,
    [fx.pidA, catId]
  );
  tracked.items.push(ins.rows[0].id);

  const del = await api('DELETE', `/api/pos/menu/categories/${catId}?property_id=${fx.pidA}`, null, fx.tokenA);
  expect(del.status === 409, `Hapus kategori hanya dipakai item nonaktif -> 409 (got ${del.status})`);
  const delCode = (del.json && del.json.code) || '';
  expect(delCode === 'CATEGORY_IN_USE', `409 code=CATEGORY_IN_USE (got "${delCode}")`);
  const still = await pool.query('SELECT COUNT(*)::int AS c FROM pos_menu_categories WHERE id = $1', [catId]);
  expect(Number(still.rows[0].c) === 1, 'Kategori tidak terhapus (masih ada)');
}

// ── [11] PUT kategori: permission & cross-property ─────────────────────────
async function testPutCategoryPermission(fx) {
  console.log('\n[11] PUT kategori permission & cross-property');

  // view-only (user B) PUT kategori properti B → 403
  const putView = await api('PUT', `/api/pos/menu/categories/${fx.catB1}?property_id=${fx.pidB}`,
    { name: 'Rename ViewOnly' }, fx.tokenB);
  expect(putView.status === 403, `PUT kategori oleh view-only -> 403 (got ${putView.status})`);

  // user A (properti A) PUT kategori properti B → 403
  const putCross = await api('PUT', `/api/pos/menu/categories/${fx.catB1}?property_id=${fx.pidB}`,
    { name: 'Rename Cross' }, fx.tokenA);
  expect(putCross.status === 403, `PUT kategori cross-property -> 403 (got ${putCross.status})`);
  const dbB = await pool.query('SELECT name FROM pos_menu_categories WHERE id = $1', [fx.catB1]);
  expect(dbB.rows[0].name !== 'Rename Cross', 'Kategori B tidak berubah setelah PUT cross');

  // user tanpa akses (tokenC) PUT → 403
  const putNo = await api('PUT', `/api/pos/menu/categories/${fx.catA1}?property_id=${fx.pidA}`,
    { name: 'Rename NoPerm' }, fx.tokenC);
  expect(putNo.status === 403, `PUT kategori oleh user tanpa akses -> 403 (got ${putNo.status})`);
}

// ── [12] Concurrent CREATE via category_name + rename kategori ──────────────
async function testConcurrentCompatRename(fx) {
  console.log('\n[12] Konkurensi campuran: CREATE compat category_name + rename kategori');

  // 12a. CREATE compat (category_name baru) paralel dengan rename kategori lain
  // → kategori compat tepat satu dibuat; rename tetap sukses; tidak ada duplikat.
  const compatName = 'Kategori Compat Race';
  const mk = await api('POST', '/api/pos/menu/categories', { property_id: fx.pidA, name: 'Kategori Race Base' }, fx.tokenA);
  const baseCat = ((mk.json && mk.json.data) || {}).id;
  if (baseCat && !tracked.categories.includes(baseCat)) tracked.categories.push(baseCat);

  const [createRes, renameRes] = await Promise.all([
    api('POST', '/api/pos/menu/items', { property_id: fx.pidA, name: 'Item Race C1', item_code: 'MPMA-RACE-C1', price: 1000, category_name: compatName }, fx.tokenA),
    api('PUT', `/api/pos/menu/categories/${baseCat}?property_id=${fx.pidA}`, { name: 'Kategori Race Renamed' }, fx.tokenA),
  ]);
  const createdRow = (createRes.json && createRes.json.data) || {};
  if (createRes.status === 201 && createdRow.id) tracked.items.push(createdRow.id);
  expect(createRes.status === 201, `CREATE compat saat rename paralel -> 201 (got ${createRes.status})`);
  expect(renameRes.status === 200, `Rename kategori saat CREATE compat paralel -> 200 (got ${renameRes.status})`);
  const cntCompat = await pool.query(
    'SELECT COUNT(*)::int AS c, MIN(id) AS id FROM pos_menu_categories WHERE property_id = $1 AND LOWER(name) = LOWER($2)',
    [fx.pidA, compatName]
  );
  expect(Number(cntCompat.rows[0].c) === 1, `Compat race: kategori compat tepat satu (got ${cntCompat.rows[0].c})`);
  if (cntCompat.rows[0].id && !tracked.categories.includes(Number(cntCompat.rows[0].id))) {
    tracked.categories.push(Number(cntCompat.rows[0].id));
  }
  const renamedCat = await pool.query('SELECT name FROM pos_menu_categories WHERE id = $1', [baseCat]);
  expect(renamedCat.rows[0].name === 'Kategori Race Renamed', 'Rename tetap tersimpan pasca-race');

  // 12b. Dua CREATE compat dengan category_name yang sama secara paralel
  // → kategori dibuat tepat satu, kedua item 201, tidak ada duplikat.
  const compatName2 = 'Kategori Compat Race 2';
  const [cc1, cc2] = await Promise.all([
    api('POST', '/api/pos/menu/items', { property_id: fx.pidA, name: 'Item Race D1', item_code: 'MPMA-RACE-D1', price: 1000, category_name: compatName2 }, fx.tokenA),
    api('POST', '/api/pos/menu/items', { property_id: fx.pidA, name: 'Item Race D2', item_code: 'MPMA-RACE-D2', price: 1000, category_name: compatName2 }, fx.tokenA),
  ]);
  for (const r of [cc1, cc2]) {
    const row = (r.json && r.json.data) || {};
    if (r.status === 201 && row.id) tracked.items.push(row.id);
  }
  expect(cc1.status === 201 && cc2.status === 201,
    `Dua CREATE compat paralel dengan nama kategori sama -> kedua 201 (got ${cc1.status},${cc2.status})`);
  const cnt2 = await pool.query(
    'SELECT COUNT(*)::int AS c FROM pos_menu_categories WHERE property_id = $1 AND LOWER(name) = LOWER($2)',
    [fx.pidA, compatName2]
  );
  expect(Number(cnt2.rows[0].c) === 1, `Compat race 2: kategori tepat satu (got ${cnt2.rows[0].c})`);
  const cats2 = await pool.query(
    'SELECT id FROM pos_menu_categories WHERE property_id = $1 AND LOWER(name) = LOWER($2)',
    [fx.pidA, compatName2]
  );
  if (cats2.rows[0] && !tracked.categories.includes(cats2.rows[0].id)) tracked.categories.push(cats2.rows[0].id);

  // 12c. Rename kategori (baseCat → nama baru) paralel dengan CREATE compat
  // memakai NAMA BARU itu → tepat satu kategori dengan nama akhir; item compat
  // merujuk ke satu-satunya kategori tersebut.
  const compatName3 = 'Kategori Compat Race 3';
  const mk3 = await api('POST', '/api/pos/menu/categories', { property_id: fx.pidA, name: 'Kategori Race Base 3' }, fx.tokenA);
  const baseCat3 = ((mk3.json && mk3.json.data) || {}).id;
  if (baseCat3 && !tracked.categories.includes(baseCat3)) tracked.categories.push(baseCat3);
  const [cr, r3] = await Promise.all([
    api('POST', '/api/pos/menu/items', { property_id: fx.pidA, name: 'Item Race E1', item_code: 'MPMA-RACE-E1', price: 1000, category_name: compatName3 }, fx.tokenA),
    api('PUT', `/api/pos/menu/categories/${baseCat3}?property_id=${fx.pidA}`, { name: compatName3 }, fx.tokenA),
  ]);
  if (cr.status === 201) {
    const row = (cr.json && cr.json.data) || {};
    if (row.id) tracked.items.push(row.id);
  }
  const cnt3 = await pool.query(
    'SELECT COUNT(*)::int AS c, MIN(id) AS id FROM pos_menu_categories WHERE property_id = $1 AND LOWER(name) = LOWER($2)',
    [fx.pidA, compatName3]
  );
  expect(Number(cnt3.rows[0].c) === 1,
    `Rename ke nama baru + CREATE compat nama sama: kategori tepat satu (got ${cnt3.rows[0].c}, cr=${cr.status} rn=${r3.status})`);
  if (cnt3.rows[0].id && !tracked.categories.includes(Number(cnt3.rows[0].id))) {
    tracked.categories.push(Number(cnt3.rows[0].id));
  }
  // DB konsisten: tidak ada duplikat nama kategori (case-insensitive) properti A.
  const dupCheck = await pool.query(
    `SELECT LOWER(name) AS n, COUNT(*)::int AS c FROM pos_menu_categories
     WHERE property_id = $1 GROUP BY LOWER(name) HAVING COUNT(*) > 1`,
    [fx.pidA]
  );
  expect(dupCheck.rows.length === 0, 'Tidak ada duplikat nama kategori (case-insensitive) pasca-race');
}

// ── [13] Role edit-only: PATCH is_active & batasan kebijakan aktual ────────
async function testEditOnlyPatchIsActive(fx) {
  console.log('\n[13] Role edit-only: PATCH is_active & batasan kebijakan aktual');

  // Kebijakan aktual (operationalAccessGuard.ts + accessControlService.ts):
  //   resource 'Master Produk', action 'edit' = inventory.create ATAU
  //   inventory.edit (RESOURCE_PERMISSION_KEYS.edit; hasAnyEffectivePermission
  //   memakai "ANY" antar key per action). Maka:
  //   - PATCH item (termasuk is_active) → action edit → cukup inventory.edit.
  //   - POST item / POST kategori → inferAccessAction(POST) = edit → user
  //     edit-only DAPAT POST (201/200).
  //   - DELETE kategori → action delete → hanya inventory.delete → edit-only
  //     ditolak 403.
  const client = await pool.connect();
  let editOnlyToken;
  let noPermToken;
  try {
    const editOnly = await createUserForProperty(client, fx.pidA, 'EDITONLY', ['inventory.edit']);
    editOnlyToken = tokenFor(editOnly.userId, fx.pidA);
    // User kontrol: properti A, TANPA permission apa pun → POST apa pun 403
    // (bukti bahwa izin di 13c memang grant policy, bukan bypass).
    const noPerm = await createUserForProperty(client, fx.pidA, 'NOPERM', []);
    noPermToken = tokenFor(noPerm.userId, fx.pidA);
  } finally {
    client.release();
  }

  const ins = await pool.query(
    `INSERT INTO pos_menu_items (property_id, item_code, name, price, is_active)
     VALUES ($1, 'MPMA-EDITONLY', 'Item EditOnly', 1000, TRUE) RETURNING id`,
    [fx.pidA]
  );
  tracked.items.push(ins.rows[0].id);
  const itemEO = ins.rows[0].id;

  // 13a. Edit-only menonaktifkan item existing → 200 (cukup inventory.edit).
  const patchDeactivate = await api('PATCH', `/api/pos/menu/items/${itemEO}?property_id=${fx.pidA}`,
    { is_active: false }, editOnlyToken);
  expect(patchDeactivate.status === 200,
    `PATCH is_active=false oleh edit-only -> 200 (kebijakan aktual: action edit) (got ${patchDeactivate.status})`);
  const dbState1 = await pool.query('SELECT is_active FROM pos_menu_items WHERE id = $1', [itemEO]);
  expect(dbState1.rows[0].is_active === false, 'is_active=false tersimpan oleh edit-only');

  // 13b. Edit-only mengaktifkan kembali → 200.
  const patchActivate = await api('PATCH', `/api/pos/menu/items/${itemEO}?property_id=${fx.pidA}`,
    { is_active: true }, editOnlyToken);
  expect(patchActivate.status === 200, `PATCH is_active=true oleh edit-only -> 200 (got ${patchActivate.status})`);
  const dbState2 = await pool.query('SELECT is_active FROM pos_menu_items WHERE id = $1', [itemEO]);
  expect(dbState2.rows[0].is_active === true, 'is_active=true tersimpan oleh edit-only');

  // 13c. Sesuai kebijakan aktual: edit-only (inventory.edit) DAPAT POST item &
  // POST kategori (action edit mencakup create).
  const postItemEO = await api('POST', '/api/pos/menu/items',
    { property_id: fx.pidA, name: 'Item EditOnly Create', item_code: 'MPMA-EO-CREATE', price: 1000 }, editOnlyToken);
  expect([200, 201].includes(postItemEO.status),
    `POST item oleh edit-only -> 201 (kebijakan aktual: edit mencakup create) (got ${postItemEO.status})`);
  const postItemRow = (postItemEO.json && postItemEO.json.data) || {};
  if (postItemRow.id && !tracked.items.includes(postItemRow.id)) tracked.items.push(postItemRow.id);

  const postCatEO = await api('POST', '/api/pos/menu/categories',
    { property_id: fx.pidA, name: 'Kategori EditOnly' }, editOnlyToken);
  expect([200, 201].includes(postCatEO.status),
    `POST kategori oleh edit-only -> 201 (kebijakan aktual: edit mencakup create) (got ${postCatEO.status})`);
  const postCatRow = (postCatEO.json && postCatEO.json.data) || {};
  if (postCatRow.id && !tracked.categories.includes(postCatRow.id)) tracked.categories.push(postCatRow.id);

  // 13d. Kontrol: user TANPA permission apa pun → POST item/kategori 403.
  const postItemNo = await api('POST', '/api/pos/menu/items',
    { property_id: fx.pidA, name: 'Item NoPerm Create', price: 1000 }, noPermToken);
  expect(postItemNo.status === 403,
    `POST item oleh user tanpa permission -> 403 (got ${postItemNo.status})`);
  const postCatNo = await api('POST', '/api/pos/menu/categories',
    { property_id: fx.pidA, name: 'Kategori NoPerm' }, noPermToken);
  expect(postCatNo.status === 403,
    `POST kategori oleh user tanpa permission -> 403 (got ${postCatNo.status})`);

  // 13e. Tanpa inventory.delete, DELETE kategori → 403.
  const delCatEO = await api('DELETE', `/api/pos/menu/categories/${fx.catA1}?property_id=${fx.pidA}`,
    null, editOnlyToken);
  expect(delCatEO.status === 403,
    `DELETE kategori oleh edit-only (tanpa inventory.delete) -> 403 (got ${delCatEO.status})`);
}

main().catch((err) => {
  console.error('MASTER PRODUCT MGMT TEST crashed:', err && err.message, err && err.stack ? '\n' + err.stack : '');
  process.exitCode = 1;
});

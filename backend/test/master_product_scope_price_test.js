/**
 * Master Produk (POS menu) — Property Scope + Price Validation Regression
 *
 * DB safety guard (pola repo: DB disposable *_test wajib eksplisit):
 * - Membaca TEST_DATABASE_URL (env eksplisit); tanpa fallback DB_/PG_/.env.
 * - Menolak DB tanpa '_test' atau mengandung staging|production|prod|live.
 * - TIDAK mencetak URL lengkap / password.
 * - Memverifikasi identitas koneksi (current_database) SEBELUM mutasi.
 *
 * Cakupan (patch pertama Master Produk di backend/src/index.ts):
 *  1. Tanpa autentikasi (tanpa Bearer token) → route menu ditolak (401).
 *  2. Token properti A menarget property_id B (GET/CREATE/DELETE) → 403.
 *  3. Token properti A memakai property_id A tetapi item ID milik B → item B
 *     TIDAK termodifikasi (UPDATE 0 baris karena WHERE property_id=A).
 *  4. CREATE harga negatif/non-finite/malformed (boolean/array/object/''/null)
 *     → 400; harga 0 & valid → 201.
 *  5. Operasi properti sendiri (GET/CREATE/DELETE) tetap berhasil.
 *
 * Test menjalankan handler/middleware AKTUAL via dist/index (app + pool) —
 * TIDAK menyalin logika validasi; TIDAK memeriksa teks source.
 *
 * Run (hanya DB disposable *_test):
 *   TEST_DATABASE_URL=postgres://USER:PASS@localhost:PORT/<db>_test \
 *   node backend/test/master_product_scope_price_test.js
 */

'use strict';

// ─── DB SAFETY GUARD ──────────────────────────────────────────────────────────
// Membaca TEST_DATABASE_URL (env eksplisit). Tanpa fallback DB_/PG_/.env.
// - Menolak DB tanpa '_test' atau mengandung staging|production|prod|live.
// - Port WAJIB eksplisit; TIDAK ada fallback 5432.
// - Parameter URL yang tidak didukung ditolak (bukan diabaikan diam-diam).
// - TIDAK mencetak URL lengkap / password.

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !testUrl.trim()) {
  console.error(
    'SAFETY: TEST_DATABASE_URL tidak di-set.\n' +
    'Jalankan: TEST_DATABASE_URL=postgres://USER:PASS@localhost:PORT/<db>_test ' +
    'node backend/test/master_product_scope_price_test.js'
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
  // Test lokal ini tidak memerlukan query parameter apa pun.
  // Tolak SEMUA parameter agar tidak ada opsi yang diabaikan diam-diam.
  if (u.searchParams.size > 0) {
    const keys = [...u.searchParams.keys()].join(', ');
    throw new Error(`query parameter tidak didukung: "${keys}" (test ini tidak memerlukan query parameter)`);
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
  // Port WAJIB eksplisit — tidak ada fallback 5432.
  if (!u.port) throw new Error('port wajib eksplisit di TEST_DATABASE_URL (tanpa fallback 5432)');
  const port = Number(u.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`port tidak valid (diterima: ${u.port})`);
  }
  target = { host: u.hostname, port, user, database, password };
  console.log(`[MASTER PRODUCT TEST] Target DB disposable: ${database} (user: ${user}, port: ${port})`);
} catch (e) {
  console.error('SAFETY: TEST_DATABASE_URL ditolak — ' + e.message);
  process.exit(1);
}

// Set pool override SEBELUM memuat dist/index agar app + pool memakai target.
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
  if (condition) {
    passed += 1;
    console.log('PASS | ' + msg);
  } else {
    failed += 1;
    console.error('FAIL | ' + msg);
  }
}

async function api(method, path, body, authToken) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (authToken) opts.headers.Authorization = `Bearer ${authToken}`;
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const res = await fetch(baseUrl + path, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function cleanup() {
  // Setiap langkah (urut FK: child → parent) tetap dicoba walau langkah
  // sebelumnya gagal; error dikumpulkan, TIDAK ditelan. Dijalankan di luar
  // transaksi (tidak BEGIN/COMMIT) agar satu kegagalan tidak meng-abort
  // sisa langkah. Hanya dipanggil SETELAH identitas DB terverifikasi.
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
    // Urutan FK: child → parent. Setiap item dicoba satu per satu.
    for (const [label, sqlFor, ids] of cleanupQueries) {
      for (const id of ids) {
        try {
          await client.query(sqlFor(id), [id]);
        } catch (e) {
          const msg = `${label}[id=${id}]: ${e.message}`;
          errors.push(msg);
          console.error('CLEANUP ERROR | ' + msg);
        }
      }
    }
  } finally {
    client.release();
  }
  if (errors.length > 0) {
    failed += 1;
    console.error(`CLEANUP: ${errors.length} langkah gagal di atas. Residu fixture mungkin tersisa.`);
  }
}

/** Membuat role + user di properti tertentu (fixture token yang lolos guard). */
async function createUserForProperty(client, propertyId, tag) {
  const roleRes = await client.query(
    `INSERT INTO roles (property_id, name, is_system_role, is_active)
     VALUES ($1, $2, FALSE, TRUE) RETURNING id`,
    [propertyId, `MP-${tag}-ROLE`]
  );
  const roleId = roleRes.rows[0].id;
  tracked.roles.push(roleId);

  const userRes = await client.query(
    `INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING id`,
    [propertyId, roleId, `mp_${tag.toLowerCase()}_${Date.now() % 100000}`, `mp_${tag.toLowerCase()}@oak.test`, 'x', `MP ${tag}`]
  );
  const userId = userRes.rows[0].id;
  tracked.users.push(userId);
  return { userId, roleId };
}

/** Menempeli akses resource 'Master Produk' (semua action) pada role via
 *  permission keys inventory.view/create/edit/delete (skema role_permissions
 *  memakai permission_id FK, bukan resource/action string). */
async function grantMasterProdukAccess(client, propertyId, roleId) {
  const keys = ['inventory.view', 'inventory.create', 'inventory.edit', 'inventory.delete'];
  const permRes = await client.query(
    `SELECT id FROM permissions WHERE key = ANY($1)`,
    [keys]
  );
  const permIds = permRes.rows.map((r) => r.id);
  for (const permissionId of permIds) {
    await client.query(
      `INSERT INTO role_permissions (role_id, permission_id, granted, created_by)
       VALUES ($1, $2, TRUE, 'master-product-scope-test')
       ON CONFLICT (role_id, permission_id) DO NOTHING`,
      [roleId, permissionId]
    );
  }
}

function tokenFor(userId, propertyId) {
  return generateToken({
    id: userId,
    email: `mp_${userId}@oak.test`,
    username: `mp_${userId}`,
    full_name: `MP ${userId}`,
    role: 'Front Office',
    role_id: null,
    property_id: propertyId,
    scope: 'FULL',
  });
}

/** Track kategori hasil request produk (POST /api/pos/menu/items dengan
 *  category_name). Bila kategori ada/ dibuat, simpan ID-nya ke
 *  tracked.categories agar cleanup tidak bergantung cascade.
 */
async function trackCreatedCategoryForRequest(propertyId, categoryName) {
  if (!categoryName || !String(categoryName).trim()) return;
  const client = await pool.connect();
  try {
    const res = await client.query(
      'SELECT id FROM pos_menu_categories WHERE property_id = $1 AND LOWER(name) = LOWER($2)',
      [propertyId, String(categoryName).trim()]
    );
    for (const row of res.rows) {
      if (!tracked.categories.includes(row.id)) tracked.categories.push(row.id);
    }
  } finally {
    client.release();
  }
}

async function setupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const propA = await client.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('MP Prop A', 'MPA', 'Asia/Jakarta', 'IDR', 'MP A', TRUE) RETURNING id"
    );
    tracked.properties.push(propA.rows[0].id);
    const pidA = propA.rows[0].id;

    const propB = await client.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('MP Prop B', 'MPB', 'Asia/Jakarta', 'IDR', 'MP B', TRUE) RETURNING id"
    );
    tracked.properties.push(propB.rows[0].id);
    const pidB = propB.rows[0].id;

    // User A (properti A) & User B (properti B), masing-masing pegang akses Master Produk.
    const userA = await createUserForProperty(client, pidA, 'A');
    await grantMasterProdukAccess(client, pidA, userA.roleId);
    const userB = await createUserForProperty(client, pidB, 'B');
    await grantMasterProdukAccess(client, pidB, userB.roleId);

    // Item di properti A & B.
    const itemA = await client.query(
      `INSERT INTO pos_menu_items (property_id, item_code, name, price, is_active)
       VALUES ($1, 'MPA-001', 'Item A', 1000, TRUE) RETURNING id`,
      [pidA]
    );
    tracked.items.push(itemA.rows[0].id);
    const itemB = await client.query(
      `INSERT INTO pos_menu_items (property_id, item_code, name, price, is_active)
       VALUES ($1, 'MPB-001', 'Item B', 2000, TRUE) RETURNING id`,
      [pidB]
    );
    tracked.items.push(itemB.rows[0].id);

    await client.query('COMMIT');
    return {
      pidA, pidB,
      tokenA: tokenFor(userA.userId, pidA),
      tokenB: tokenFor(userB.userId, pidB),
      itemA: itemA.rows[0].id,
      itemB: itemB.rows[0].id,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Item masih aktif di DB untuk properti pemilik aslinya. */
async function itemActiveInDb(itemId, propertyId) {
  const client = await pool.connect();
  try {
    const r = await client.query(
      'SELECT is_active FROM pos_menu_items WHERE id = $1 AND property_id = $2',
      [itemId, propertyId]
    );
    return (r.rowCount ?? 0) === 1 && r.rows[0].is_active === true;
  } finally {
    client.release();
  }
}

/**
 * Verifikasi konfigurasi EFEKTIF pool (host/port/user/database) cocok dengan
 * target. Pool node-postgres menyimpan opsi awal di `pool.options`
 * (dist/index membangun Pool dari env DB_* yang di-set guard di atas), jadi
 * pool.options memantulkan konfigurasi yang benar-benar akan dipakai.
 */
function verifyPoolConfig() {
  const cfg = pool.options || pool.config || {};
  const mismatches = [];
  if (String(cfg.host || '') !== target.host) {
    mismatches.push(`host: pool="${cfg.host}" target="${target.host}"`);
  }
  if (Number(cfg.port) !== target.port) {
    mismatches.push(`port: pool="${cfg.port}" target="${target.port}"`);
  }
  if (String(cfg.user || '') !== target.user) {
    mismatches.push(`user: pool="${cfg.user}" target="${target.user}"`);
  }
  if (String(cfg.database || '') !== target.database) {
    mismatches.push(`database: pool="${cfg.database}" target="${target.database}"`);
  }
  return mismatches;
}

/**
 * Persepsi precondition schema + permission tanpa menjalankan
 * initializeDatabase/migration. Memeriksa tabel, kolom, dan permission
 * inventory.* yang dibutuhkan fixture & handler. Bila tak lengkap,
 * melembar error agar fixture TIDAK dibuat.
 */
async function verifySchemaPreconditions() {
  const client = await pool.connect();
  const missing = [];
  try {
    const tables = ['properties', 'users', 'roles', 'permissions', 'role_permissions', 'pos_menu_items', 'pos_menu_categories'];
    const tRes = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [tables]
    );
    const haveTables = new Set(tRes.rows.map((r) => r.table_name));
    for (const t of tables) {
      if (!haveTables.has(t)) missing.push(`tabel "${t}" tidak ada`);
    }

    // Kolom wajib per tabel.
    const neededCols = [
      ['properties', ['id', 'name', 'property_code']],
      ['users', ['id', 'property_id', 'role_id', 'username', 'email', 'password_hash', 'full_name', 'is_active']],
      ['roles', ['id', 'property_id', 'name', 'is_system_role', 'is_active']],
      ['permissions', ['id', 'key']],
      ['role_permissions', ['role_id', 'permission_id', 'granted', 'created_by']],
      ['pos_menu_items', ['id', 'property_id', 'item_code', 'name', 'price', 'is_active']],
      ['pos_menu_categories', ['id', 'property_id', 'name']],
    ];
    for (const [tbl, cols] of neededCols) {
      if (!haveTables.has(tbl)) continue;
      const cRes = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 AND column_name = ANY($2)`,
        [tbl, cols]
      );
      const have = new Set(cRes.rows.map((r) => r.column_name));
      for (const c of cols) {
        if (!have.has(c)) missing.push(`kolom "${tbl}.${c}" tidak ada`);
      }
    }

    // Permission keys inventory.* harus tersedia untuk grant fixture.
    const pRes = await client.query(
      `SELECT key FROM permissions WHERE key = ANY($1)`,
      [['inventory.view', 'inventory.create', 'inventory.edit', 'inventory.delete']]
    );
    const haveKeys = new Set(pRes.rows.map((r) => r.key));
    for (const k of ['inventory.view', 'inventory.create', 'inventory.edit', 'inventory.delete']) {
      if (!haveKeys.has(k)) missing.push(`permission "${k}" tidak ada di DB (disclaimer: seed permission hilang)`);
    }

    if (missing.length > 0) {
      throw new Error(
        'SCHEMA PRECONDITION GAGAL (beberapa tabel/kolom/permission tidak lengkap — jalankan migration terpisah, BUKAN dari test ini):\n  - ' +
        missing.join('\n  - ')
      );
    }
  } finally {
    client.release();
  }
}

/** Cek residu fixture berdasarkan ID yang di-track; residu >0 → FAIL. */
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
    return residue;
  } finally {
    client.release();
  }
}

// ── 1. Tanpa autentikasi ditolak ─────────────────────────────────────────────
async function testUnauthenticated(fx) {
  console.log('\n[1] Tanpa autentikasi');
  const g = await api('GET', `/api/pos/menu?property_id=${fx.pidA}`, undefined, null);
  expect(g.status === 401, `GET tanpa token -> 401 (got ${g.status})`);

  const c = await api('POST', '/api/pos/menu/items', {
    property_id: fx.pidA, name: 'NoAuth', price: 100,
  }, null);
  expect(c.status === 401, `CREATE tanpa token -> 401 (got ${c.status})`);

  const d = await api('DELETE', `/api/pos/menu/items/${fx.itemA}?property_id=${fx.pidA}`, undefined, null);
  expect(d.status === 401, `DELETE tanpa token -> 401 (got ${d.status})`);
}

// ── 2. Token A menarget properti B ditolak ──────────────────────────────────
async function testCrossPropertyDenied(fx) {
  console.log('\n[2] Token A -> properti B ditolak');
  const g = await api('GET', `/api/pos/menu?property_id=${fx.pidB}`, undefined, fx.tokenA);
  expect(g.status === 403 && g.json && g.json.code === 'PROPERTY_SCOPE_REQUIRED',
    `GET menu B dgn token A -> 403 (got ${g.status}/${g.json && g.json.code})`);

  // REGRESI: GET properti DI LUAR SCOPE — baik ID existing (B) maupun
  // nonexistent (999999) — harus 403, ditolak SEBELUM pembacaan data.
  const gNonexistent = await api('GET', `/api/pos/menu?property_id=999999`, undefined, fx.tokenA);
  expect(gNonexistent.status === 403 && gNonexistent.json && gNonexistent.json.code === 'PROPERTY_SCOPE_REQUIRED',
    `GET properti nonexistent dgn token A -> 403 (got ${gNonexistent.status}/${gNonexistent.json && gNonexistent.json.code})`);

  const c = await api('POST', '/api/pos/menu/items', {
    property_id: fx.pidB, name: 'Cross', price: 500,
  }, fx.tokenA);
  expect(c.status === 403 && c.json && c.json.code === 'PROPERTY_SCOPE_REQUIRED',
    `CREATE di B dgn token A -> 403 (got ${c.status}/${c.json && c.json.code})`);

  const d = await api('DELETE', `/api/pos/menu/items/${fx.itemB}?property_id=${fx.pidB}`, undefined, fx.tokenA);
  expect(d.status === 403 && d.json && d.json.code === 'PROPERTY_SCOPE_REQUIRED',
    `DELETE item B dgn token A -> 403 (got ${d.status}/${d.json && d.json.code})`);

  // Bukti: tidak ada item 'Cross' dibuat di properti B oleh token A.
  const chk = await api('GET', `/api/pos/menu?property_id=${fx.pidB}`, undefined, fx.tokenB);
  const createdLeak = chk.json && chk.json.data && chk.json.data.items
    ? chk.json.data.items.some((i) => i.name === 'Cross') : false;
  expect(chk.status === 200 && !createdLeak, 'Item Cross tidak bocor ke properti B');
}

// ── 2b. Harga whitespace-only ditolak, tak membuat item/kategori ──────────
async function testWhitespacePriceRejected(fx) {
  console.log('\n[2b] Harga whitespace-only -> 400, tanpa residu');
  const samples = ['   ', '\t', '\n', ' \t\n ', '  \t '];
  for (const ws of samples) {
    const r = await api('POST', '/api/pos/menu/items', {
      property_id: fx.pidA, name: 'WhitespacePrice', item_code: 'WS-PRICE',
      category_name: 'WS-Category', price: ws,
    }, fx.tokenA);
    expect(r.status === 400, `harga ${JSON.stringify(ws)} -> 400 (got ${r.status})`);
  }
  // Buktikan tak ada item/kategori yang tercipta akibat percobaan di atas.
  const chk = await api('GET', `/api/pos/menu?property_id=${fx.pidA}`, undefined, fx.tokenA);
  expect(chk.status === 200, 'GET menu A pasca-penolakan -> 200');
  const items = (chk.json && chk.json.data && chk.json.data.items) || [];
  const cats = (chk.json && chk.json.data && chk.json.data.categories) || [];
  expect(!items.some((i) => i.name === 'WhitespacePrice'),
    'Tidak ada item WhitespacePrice (penolakan harga tak membuat item)');
  expect(!items.some((i) => i.item_code === 'WS-PRICE'),
    'Tidak ada item kode WS-PRICE');
  expect(!cats.some((c) => c.name === 'WS-Category'),
    'Tidak ada kategori WS-Category');
}

// ── 3. Token A, property A, item ID milik B -> item B tak termodifikasi ───
async function testForeignItemNoMutation(fx) {
  console.log('\n[3] Token A + property A + itemID B -> item B tetap utuh');
  const r = await api('DELETE', `/api/pos/menu/items/${fx.itemB}?property_id=${fx.pidA}`, undefined, fx.tokenA);
  expect(r.status === 404, `DELETE item B dgn property A -> 404 (got ${r.status})`);
  const stillActive = await itemActiveInDb(fx.itemB, fx.pidB);
  expect(stillActive === true, 'Item B masih is_active=TRUE (tak termodifikasi)');
}

// ── 4. Validasi harga CREATE ────────────────────────────────────────────────
async function testPriceValidation(fx) {
  console.log('\n[4] Validasi harga CREATE');
  const base = { property_id: fx.pidA, name: 'Pricing' };

  const neg = await api('POST', '/api/pos/menu/items', { ...base, price: -1 }, fx.tokenA);
  expect(neg.status === 400, `harga -1 -> 400 (got ${neg.status})`);

  const nanStr = await api('POST', '/api/pos/menu/items', { ...base, price: 'abc' }, fx.tokenA);
  expect(nanStr.status === 400, `harga 'abc' -> 400 (got ${nanStr.status})`);

  const inf = await api('POST', '/api/pos/menu/items', { ...base, price: Infinity }, fx.tokenA);
  expect(inf.status === 400, `harga Infinity (JSON null) -> 400 (got ${inf.status})`);

  const bool = await api('POST', '/api/pos/menu/items', { ...base, price: true }, fx.tokenA);
  expect(bool.status === 400, `harga boolean -> 400 (got ${bool.status})`);

  const arr = await api('POST', '/api/pos/menu/items', { ...base, price: [1, 2] }, fx.tokenA);
  expect(arr.status === 400, `harga array -> 400 (got ${arr.status})`);

  const obj = await api('POST', '/api/pos/menu/items', { ...base, price: { v: 1 } }, fx.tokenA);
  expect(obj.status === 400, `harga object -> 400 (got ${obj.status})`);

  const empty = await api('POST', '/api/pos/menu/items', { ...base, price: '' }, fx.tokenA);
  expect(empty.status === 400, `harga '' -> 400 (got ${empty.status})`);

  const nullP = await api('POST', '/api/pos/menu/items', { ...base, price: null }, fx.tokenA);
  expect(nullP.status === 400, `harga null -> 400 (got ${nullP.status})`);

  // Bolehnya: harga 0 dan harga valid diterima di properti sendiri.
  const zero = await api('POST', '/api/pos/menu/items', { ...base, price: 0 }, fx.tokenA);
  expect(zero.status === 201, `harga 0 -> 201 (got ${zero.status})`);
  if (zero.status === 201 && zero.json && zero.json.data && zero.json.data.id) {
    tracked.items.push(zero.json.data.id);
  }

  const valid = await api('POST', '/api/pos/menu/items', { ...base, price: 15000 }, fx.tokenA);
  expect(valid.status === 201, `harga 15000 -> 201 (got ${valid.status})`);
  if (valid.status === 201 && valid.json && valid.json.data && valid.json.data.id) {
    tracked.items.push(valid.json.data.id);
    if (valid.json.data.category_name) {
      await trackCreatedCategoryForRequest(fx.pidA, valid.json.data.category_name);
    }
  }

  // Harga numerik string tetap valid (Number('15000') finite & >=0).
  const strNum = await api('POST', '/api/pos/menu/items', { ...base, name: 'PStr', price: '2500' }, fx.tokenA);
  expect(strNum.status === 201, `harga '2500' (numeric string) -> 201 (got ${strNum.status})`);
  if (strNum.status === 201 && strNum.json && strNum.json.data && strNum.json.data.id) {
    tracked.items.push(strNum.json.data.id);
  }

  // REGRESI: string numerik nonkosong dengan eko Number() — diterima & tersimpan.
  const trailingDot = await api('POST', '/api/pos/menu/items', { ...base, name: 'PTrail', price: '2500.' }, fx.tokenA);
  expect(trailingDot.status === 201, `harga '2500.' -> 201 (got ${trailingDot.status})`);
  expect(Number(trailingDot.json && trailingDot.json.data && trailingDot.json.data.price) === 2500,
    `harga '2500.' tersimpan sebagai 2500 (got ${trailingDot.json && trailingDot.json.data && trailingDot.json.data.price})`);
  if (trailingDot.status === 201 && trailingDot.json && trailingDot.json.data && trailingDot.json.data.id) {
    tracked.items.push(trailingDot.json.data.id);
  }

  const exp = await api('POST', '/api/pos/menu/items', { ...base, name: 'PExp', price: '2.5e3' }, fx.tokenA);
  expect(exp.status === 201, `harga '2.5e3' -> 201 (got ${exp.status})`);
  expect(Number(exp.json && exp.json.data && exp.json.data.price) === 2500,
    `harga '2.5e3' tersimpan sebagai 2500 (got ${exp.json && exp.json.data && exp.json.data.price})`);
  if (exp.status === 201 && exp.json && exp.json.data && exp.json.data.id) {
    tracked.items.push(exp.json.data.id);
  }

  // REGRESI: string dengan trim kosong / hasil Number() NaN tetap ditolak.
  const ws1 = await api('POST', '/api/pos/menu/items', { ...base, price: '   ' }, fx.tokenA);
  expect(ws1.status === 400, `harga '   ' (whitespace) -> 400 (got ${ws1.status})`);
  const ws2 = await api('POST', '/api/pos/menu/items', { ...base, price: '\t\n' }, fx.tokenA);
  expect(ws2.status === 400, `harga '\t\n' (whitespace) -> 400 (got ${ws2.status})`);
  const nanStr2 = await api('POST', '/api/pos/menu/items', { ...base, price: '12x' }, fx.tokenA);
  expect(nanStr2.status === 400, `harga '12x' (NaN) -> 400 (got ${nanStr2.status})`);

  // REGRESI: string non-finite hasil Number() — Infinity JSON menjadi null,
  // jadi uji konversi non-finite secara LANGSUNG lewat string.
  const infStr = await api('POST', '/api/pos/menu/items', { ...base, price: 'Infinity' }, fx.tokenA);
  expect(infStr.status === 400, `harga 'Infinity' (string, Number -> Infinity) -> 400 (got ${infStr.status})`);
  const overflowStr = await api('POST', '/api/pos/menu/items', { ...base, price: '1e309' }, fx.tokenA);
  expect(overflowStr.status === 400, `harga '1e309' (string, Number -> Infinity) -> 400 (got ${overflowStr.status})`);
}

// ── 5. Operasi properti sendiri tetap berhasil ──────────────────────────────
async function testSelfPropertyWorks(fx) {
  console.log('\n[5] Operasi properti sendiri');
  const g = await api('GET', `/api/pos/menu?property_id=${fx.pidA}`, undefined, fx.tokenA);
  expect(g.status === 200 && g.json && g.json.data && Array.isArray(g.json.data.items),
    `GET menu A dgn token A -> 200 (got ${g.status})`);

  const created = await api('POST', '/api/pos/menu/items', {
    property_id: fx.pidA, name: 'SelfItem', price: 750,
  }, fx.tokenA);
  expect(created.status === 201, `CREATE di A dgn token A -> 201 (got ${created.status})`);
  let selfItem = null;
  if (created.status === 201 && created.json && created.json.data && created.json.data.id) {
    selfItem = created.json.data.id;
    tracked.items.push(selfItem);
  }

  // Nonaktifkan item milik sendiri.
  if (selfItem != null) {
    const d = await api('DELETE', `/api/pos/menu/items/${selfItem}?property_id=${fx.pidA}`, undefined, fx.tokenA);
    expect(d.status === 200, `nonaktifkan item A dgn token A -> 200 (got ${d.status})`);
    const client = await pool.connect();
    try {
      const r = await client.query(
        'SELECT is_active FROM pos_menu_items WHERE id = $1 AND property_id = $2',
        [selfItem, fx.pidA]
      );
      expect((r.rowCount ?? 0) === 1 && r.rows[0].is_active === false,
        'Item A is_active=FALSE setelah nonaktifkan');
    } finally {
      client.release();
    }
  }
}

async function main() {
  // 1. Verifikasi konfigurasi pool efektif. Kegagalan di sini WAJIB tetap
  //    menutup pool (sudah diimport & pool sudah dibuat), jangan langsung
  //    return / exitCode=0.
  const poolMismatches = verifyPoolConfig();
  if (poolMismatches.length > 0) {
    console.error('POOL CONFIG MISMATCH:\n  - ' + poolMismatches.join('\n  - '));
    try {
      await pool.end();
    } catch (e) {
      console.error('POOL END ERROR | ' + (e && e.message));
    }
    process.exitCode = 1;
    return;
  }

  // 2. Buka server. Promise listen TIDAK BOLEH menggantung: tangani error.
  server = http.createServer(app);
  const serverReady = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  let identityVerified = false; // false → jangan jalankan cleanup/residue DB.
  let fx = null;

  try {
    await serverReady;
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    // Verifikasi identitas koneksi aktual (current_database + current_user)
    // SEBELUM mutasi.
    const idCheck = await pool.query('SELECT current_database() AS db, current_user AS usr');
    const idRow = (idCheck.rows && idCheck.rows[0]) || {};
    const dbOk = String(idRow.db || '').toLowerCase() === target.database.toLowerCase();
    const usrOk = String(idRow.usr || '').toLowerCase() === target.user.toLowerCase();
    if (!dbOk || !usrOk) {
      console.error(
        `IDENTITY MISMATCH: current_database="${idRow.db}" (target "${target.database}"), ` +
        `current_user="${idRow.usr}" (target "${target.user}")`
      );
      process.exitCode = 1;
      // Identitas TIDAK terverifikasi → jangan jalankan cleanup/residue DB.
      // Tetap lanjut ke finally (menutup server & pool).
      throw new Error('identity mismatch');
    }
    identityVerified = true;
    console.log(`Koneksi terverifikasi: db=${idRow.db} user=${idRow.usr}`);

    // Precondition schema + permission (TANPA initializeDatabase/migration).
    await verifySchemaPreconditions();

    // 3. Setup fixture & jalankan skenario.
    fx = await setupFixtures();
    await testUnauthenticated(fx);
    await testCrossPropertyDenied(fx);
    await testWhitespacePriceRejected(fx);
    await testForeignItemNoMutation(fx);
    await testPriceValidation(fx);
    await testSelfPropertyWorks(fx);
  } catch (e) {
    // Tangkap error tahap; jangan menimpa exitCode=1.
    console.error('TEST STAGE ERROR | ' + (e && e.message));
    process.exitCode = 1;
    // Identitas gagal / fixture gagal → tracked kosong / tidak lengkap.
    // Tetap coba cleanup/residue bila identitas terverifikasi (idempoten &
    // aman karena di luar transaksi).
  } finally {
    // 4. Cleanup + residue hanya bila identitas terverifikasi.
    if (identityVerified) {
      try {
        await cleanup();
      } catch (e) {
        console.error('CLEANUP STAGE ERROR | ' + (e && e.message));
        process.exitCode = 1;
      }
      try {
        await verifyResidue();
      } catch (e) {
        console.error('RESIDUE CHECK ERROR | ' + (e && e.message));
        process.exitCode = 1;
      }
    }

    // Tutup server & pool; kegagalan tahap di atas TIDAK menghalangi ini.
    try {
      if (server && !server.closed) {
        await once(server.close(), 'close');
      }
    } catch (e) {
      console.error('SERVER CLOSE ERROR | ' + (e && e.message));
    }
    try {
      await pool.end();
    } catch (e) {
      console.error('POOL END ERROR | ' + (e && e.message));
      process.exitCode = 1;
    }
  }

  // Ringkasan hanya bila semua tahap selesai (tidak crash / tidak mismatch).
  if (identityVerified) {
    console.log('\n' + '='.repeat(60));
    console.log(`[MASTER PRODUCT TEST] Hasil: ${passed} PASS, ${failed} FAIL`);
    if (failed > 0) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('MASTER PRODUCT TEST crashed:', err && err.message, err && err.stack ? '\n' + err.stack : '');
  process.exitCode = 1;
});

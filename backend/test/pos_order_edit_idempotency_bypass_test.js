/**
 * POS-EDIT-1A — S20 SECURITY INTEGRATION TEST
 * PUT /api/pos/orders/:id — middleware idempotency global TIDAK boleh melewati
 * autentikasi, permission, dan property scope.
 *
 * Pola keamanan mengikuti backend/test/pos_order_foundation_test.js:
 *  - TEST_DATABASE_URL eksplisit (postgres://, localhost/127.0.0.1, port eksplisit,
 *    user+password lengkap, database berakhiran "_test"); tanpa fallback .env / DB_* / PG*.
 *  - Menolak indikator staging|production|prod|live.
 *  - DB_* + RUN_SCHEMA_INITIALIZATION=false di-set SEBELUM import dist/index.
 *  - Import { app, pool } dari dist/index; http.createServer(app).listen(0,'127.0.0.1').
 *    startServer() TIDAK dipanggil (tidak ada seedSuperAdmin/sweep/reconcile/LISTEN/port 5000).
 *  - Verifikasi pool.options + current_database()/current_user() SEBELUM fixture.
 *
 * Metode pembuktian: "sentinel cache". Sebuah baris idempotency_keys di-seed dengan
 * response_body sentinel untuk key tertentu. Jika bypass PUT bekerja, middleware global
 * mengembalikan next() TANPA membaca cache → request lanjut ke auth/scope dan ditolak
 * (401/403), bukan 200 sentinel dan bukan X-Idempotency: HIT.
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test \
 *   node backend/test/pos_order_edit_idempotency_bypass_test.js
 */

'use strict';

const crypto = require('crypto');

// ─── DB SAFETY GUARD ─────────────────────────────────────────────────────────
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !testUrl.trim()) {
  console.error(
    'BLOCKED: TEST_DATABASE_URL tidak di-set.\n' +
    'Jalankan: TEST_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test ' +
    'node backend/test/pos_order_edit_idempotency_bypass_test.js'
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
  console.log(`[POS-EDIT S20] Target DB: ${database} (user: ${user}, port: ${port})`);
} catch (e) {
  console.error('BLOCKED: TEST_DATABASE_URL ditolak — ' + e.message);
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
const blockedLog = [];

// ── Tracked fixture IDs untuk cleanup deterministik ────────────────────────
const tracked = {
  properties: [],
  users: [],
  roles: [],
  categories: [],
  items: [],
  orders: [],
  idempotencyKeys: [],
};

// ── Identitas unik per run ─────────────────────────────────────────────────
const RUN_ID = Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
const RUN_4 = RUN_ID.slice(0, 4);
const runCode = (suffix) => `${RUN_4}${suffix}`; // property_code ^[A-Z0-9]{2,6}$

// ── Assertion helpers ──────────────────────────────────────────────────────
function expect(condition, msg) {
  if (condition) { passed += 1; console.log('PASS | ' + msg); }
  else { failed += 1; console.error('FAIL | ' + msg); }
}
function blocked(msg) {
  blockedLog.push(msg);
  console.error('BLOCKED | ' + msg);
}

// ── HTTP helper ────────────────────────────────────────────────────────────
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

// ── request_hash kontrak middleware global: sha256(METHOD|path|JSON.stringify(body)) ─
function reqHash(method, path, body) {
  const bodyStr = body ? JSON.stringify(body) : '';
  return crypto.createHash('sha256').update(method.toUpperCase() + '|' + path + '|' + bodyStr).digest('hex');
}

// ── Seed + baca sentinel cache global ──────────────────────────────────────
async function seedSentinel(key, requestHash, marker) {
  const responseBody = JSON.stringify({ status: 'SENTINEL', code: marker, data: null });
  const r = await pool.query(
    `INSERT INTO idempotency_keys (key, request_hash, response_body, status_code, expires_at)
     VALUES ($1, $2, $3, 200, NOW() + INTERVAL '1 day')
     ON CONFLICT (key) DO UPDATE
       SET request_hash = EXCLUDED.request_hash,
           response_body = EXCLUDED.response_body,
           status_code = 200
     RETURNING key`,
    [key, requestHash, responseBody]
  );
  return { responseBody, rowCount: r.rowCount ?? 0 };
}
async function readIdem(key) {
  const r = await pool.query(
    'SELECT key, request_hash, response_body, status_code FROM idempotency_keys WHERE key = $1',
    [key]
  );
  return r.rows[0] || null;
}
async function countIdem() {
  const r = await pool.query('SELECT COUNT(*)::int AS c FROM idempotency_keys');
  return r.rows[0].c;
}
async function countEditRequests(orderId, key) {
  const r = await pool.query(
    'SELECT COUNT(*)::int AS c FROM pos_order_edit_requests WHERE pos_order_id = $1 AND idempotency_key = $2',
    [orderId, key]
  );
  return r.rows[0].c;
}

// ── Fixture: role + user dengan permission tertentu ────────────────────────
async function createRoleWithPermissions(client, propertyId, tag, permKeys) {
  const roleRes = await client.query(
    `INSERT INTO roles (property_id, name, is_system_role, is_active)
     VALUES ($1, $2, FALSE, TRUE) RETURNING id`,
    [propertyId, `PEDS20-${tag}`]
  );
  const roleId = roleRes.rows[0].id;
  tracked.roles.push(roleId);

  const userRes = await client.query(
    `INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING id`,
    [
      propertyId,
      roleId,
      `peds20_${RUN_ID}_${tag}`.toLowerCase().slice(0, 100),
      `peds20_${RUN_ID}_${tag}`.toLowerCase().slice(0, 140) + '@oak.test',
      'x',
      `PEDS20 ${tag}`,
    ]
  );
  const userId = userRes.rows[0].id;
  tracked.users.push(userId);

  if (permKeys.length > 0) {
    const permRes = await client.query('SELECT id, key FROM permissions WHERE key = ANY($1)', [permKeys]);
    const found = new Set(permRes.rows.map((p) => p.key));
    const missing = permKeys.filter((k) => !found.has(k));
    if (missing.length > 0) {
      throw new Error(`FIXTURE GAGAL: permission key tidak ada: ${missing.join(', ')}`);
    }
    for (const p of permRes.rows) {
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id, granted, created_by)
         VALUES ($1, $2, TRUE, 'peds20-test')
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
    email: `peds20_${userId}@oak.test`,
    username: `peds20_${userId}`,
    full_name: `PEDS20 ${userId}`,
    role: 'Front Office',
    role_id: null,
    property_id: propertyId,
    scope: 'FULL',
  });
}

// ── Verifikasi identitas DB & pool.options SEBELUM mutasi apa pun ──────────
async function verifyDbIdentity() {
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
    if (FORBIDDEN.some((p) => db.includes(p) || usr.includes(p))) {
      console.error('SAFETY DITOLAK: database/user terindikasi staging/prod/live');
      process.exit(1);
    }
    console.log(
      `[POS-EDIT S20] DB terverifikasi: db=${row.db} user=${row.usr} ` +
      `server=${row.srv_host || 'n/a'}:${row.srv_port ?? 'n/a'}`
    );
  } finally {
    client.release();
  }
}

// ── Fixture utama ──────────────────────────────────────────────────────────
async function setupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const propA = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ($1, $2, 'Asia/Jakarta', 'IDR', $3, TRUE) RETURNING id`,
      [`PEDS20 ${runCode('A')}`, runCode('A'), `Addr ${runCode('A')}`]
    );
    const pidA = propA.rows[0].id;
    tracked.properties.push(pidA);

    const propB = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ($1, $2, 'Asia/Jakarta', 'IDR', $3, TRUE) RETURNING id`,
      [`PEDS20 ${runCode('B')}`, runCode('B'), `Addr ${runCode('B')}`]
    );
    const pidB = propB.rows[0].id;
    tracked.properties.push(pidB);

    // Menu category + item di properti A (snapshot + validasi item PUT).
    const catA = await client.query(
      'INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, $2) RETURNING id',
      [pidA, `PEDS20 ${runCode('A')} Cat`]
    );
    tracked.categories.push(catA.rows[0].id);

    const itemA = await client.query(
      `INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, is_active)
       VALUES ($1, $2, $3, $4, 25000, TRUE) RETURNING id`,
      [pidA, catA.rows[0].id, `${runCode('A')}A1`, 'PEDS20 Item A']
    );
    const itemAId = itemA.rows[0].id;
    tracked.items.push(itemAId);

    // Users:
    const uA = await createRoleWithPermissions(client, pidA, 'USERA', ['pos.view', 'pos.create', 'pos.edit']);
    const uB = await createRoleWithPermissions(client, pidB, 'USERB', ['pos.view', 'pos.create', 'pos.edit']);
    const uNo = await createRoleWithPermissions(client, pidA, 'NOPERM', []);
    const uMp = await createRoleWithPermissions(client, pidA, 'USERMP', ['inventory.view', 'inventory.create', 'inventory.edit']);

    // Order OPEN di properti A + 1 item (fixture SQL langsung, tanpa create handler).
    const orderRes = await client.query(
      `INSERT INTO pos_orders (property_id, order_number, status, total_amount, version)
       VALUES ($1, $2, 'OPEN', 25000, 1) RETURNING id`,
      [pidA, `PEDS20-${RUN_ID}-ORD-A`]
    );
    const orderId = orderRes.rows[0].id;
    tracked.orders.push(orderId);

    const orderItemRes = await client.query(
      `INSERT INTO pos_order_items (order_id, menu_item_id, quantity, unit_price, item_name_snapshot)
       VALUES ($1, $2, 1, 25000, 'PEDS20 Item A') RETURNING id`,
      [orderId, itemAId]
    );
    const orderItemId = orderItemRes.rows[0].id;

    await client.query('COMMIT');
    return {
      pidA, pidB, itemAId, orderId, orderItemId,
      userA: uA.userId, userB: uB.userId, userNoPerm: uNo.userId, userMp: uMp.userId,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ── Cleanup (dipanggil di finally) ─────────────────────────────────────────
async function cleanup() {
  const client = await pool.connect();
  const errors = [];
  const steps = [
    ['pos_order_edit_requests', 'DELETE FROM pos_order_edit_requests WHERE pos_order_id = $1', tracked.orders],
    ['pos_order_items', 'DELETE FROM pos_order_items WHERE order_id = $1', tracked.orders],
    ['pos_orders', 'DELETE FROM pos_orders WHERE id = $1', tracked.orders],
    ['pos_menu_items', 'DELETE FROM pos_menu_items WHERE id = $1', tracked.items],
    ['pos_menu_categories', 'DELETE FROM pos_menu_categories WHERE id = $1', tracked.categories],
    ['audit_logs', 'DELETE FROM audit_logs WHERE property_id = $1', tracked.properties],
    ['role_permissions', 'DELETE FROM role_permissions WHERE role_id = $1', tracked.roles],
    ['users', 'DELETE FROM users WHERE id = $1', tracked.users],
    ['roles', 'DELETE FROM roles WHERE id = $1', tracked.roles],
    ['properties', 'DELETE FROM properties WHERE id = $1', tracked.properties],
  ];
  try {
    for (const [label, sql, ids] of steps) {
      for (const id of ids) {
        try { await client.query(sql, [id]); }
        catch (e) { errors.push(`${label}[id=${id}]: ${e.message}`); }
      }
    }
    for (const key of tracked.idempotencyKeys) {
      try { await client.query('DELETE FROM idempotency_keys WHERE key = $1', [key]); }
      catch (e) { errors.push(`idempotency_keys[key=${key}]: ${e.message}`); }
    }
  } finally {
    client.release();
  }
  if (errors.length > 0) {
    failed += 1;
    console.error('CLEANUP: ' + errors.length + ' langkah gagal.');
    errors.forEach((e) => console.error('  CLEANUP ERROR | ' + e));
  }
}

// ── Verifikasi residu nol ──────────────────────────────────────────────────
async function verifyResidue() {
  const client = await pool.connect();
  try {
    const checks = [
      ['edit_requests', 'pos_order_edit_requests', 'pos_order_id', tracked.orders],
      ['order_items', 'pos_order_items', 'order_id', tracked.orders],
      ['orders', 'pos_orders', 'id', tracked.orders],
      ['menu_items', 'pos_menu_items', 'id', tracked.items],
      ['menu_categories', 'pos_menu_categories', 'id', tracked.categories],
      ['role_permissions', 'role_permissions', 'role_id', tracked.roles],
      ['users', 'users', 'id', tracked.users],
      ['roles', 'roles', 'id', tracked.roles],
      ['properties', 'properties', 'id', tracked.properties],
      ['idempotency_keys', 'idempotency_keys', 'key', tracked.idempotencyKeys],
    ];
    for (const [label, table, idCol, ids] of checks) {
      for (const id of ids) {
        const r = await client.query(
          `SELECT COUNT(*)::int AS c FROM ${table} WHERE ${idCol} = $1`,
          [id]
        );
        if (r.rows[0].c > 0) {
          failed += 1;
          console.error(`RESIDUE | ${label}[${id}] = ${r.rows[0].c} baris tersisa`);
        } else {
          passed += 1;
          console.log(`PASS | residue bersih: ${label}[${id}]`);
        }
      }
    }
  } finally {
    client.release();
  }
}

// ── MAIN ───────────────────────────────────────────────────────────────────
async function main() {
  try {
    await verifyDbIdentity();

    const fx = await setupFixtures();
    const tokenA = tokenFor(fx.userA, fx.pidA);
    const tokenB = tokenFor(fx.userB, fx.pidB);
    const tokenNoPerm = tokenFor(fx.userNoPerm, fx.pidA);
    const tokenMp = tokenFor(fx.userMp, fx.pidA);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
    console.log(`[POS-EDIT S20] Server: ${baseUrl} (tanpa startServer)`);

    const canonicalPath = `/api/pos/orders/${fx.orderId}`;
    const baseBody = {
      property_id: fx.pidA,
      expected_version: 1,
      items: [{ id: fx.orderItemId, menu_item_id: fx.itemAId, quantity: 1 }],
    };

    // ═══ A. PUT + Idempotency-Key, TANPA Authorization → 401, bukan sentinel ═══
    console.log('\n=== A: PUT tanpa Authorization → 401 (bukan cache HIT) ===');
    {
      const keyA = `PEDS20-${RUN_ID}-A`;
      tracked.idempotencyKeys.push(keyA);
      const bodyA = { ...baseBody, idempotency_key: keyA };
      const hashA = reqHash('PUT', canonicalPath, bodyA);
      const seed = await seedSentinel(keyA, hashA, 'SENTINEL_A');
      expect(seed.rowCount === 1, '(A) sentinel cache di-seed untuk key A');

      const rA = await api('PUT', canonicalPath, bodyA, { idempotencyKey: keyA });
      expect(rA.status === 401, `(A) status 401 (dapat: ${rA.status})`);
      expect(rA.json && rA.json.code === 'UNAUTHORIZED', `(A) code=UNAUTHORIZED (dapat: ${rA.json ? rA.json.code : 'null'})`);
      const hitA = rA.headers.get('x-idempotency');
      expect(!hitA, `(A) TIDAK ada X-Idempotency: HIT (dapat: ${hitA})`);
      const bodyStrA = rA.json ? JSON.stringify(rA.json) : '';
      expect(!bodyStrA.includes('SENTINEL') && !bodyStrA.includes('SENTINEL_A'), '(A) respons tidak memuat sentinel');

      const rowA = await readIdem(keyA);
      expect(
        rowA && rowA.response_body === seed.responseBody && rowA.request_hash === hashA,
        '(A) sentinel tidak berubah setelah request PUT tanpa auth'
      );
    }

    // ═══ B. PUT dengan token properti lain / tanpa permission → ditolak ═══
    console.log('\n=== B: token tanpa permission & cross-property → ditolak (bukan cache HIT) ===');
    {
      // B1: token tanpa permission POS (properti A) → 403 FORBIDDEN (guard)
      const keyB1 = `PEDS20-${RUN_ID}-B1`;
      tracked.idempotencyKeys.push(keyB1);
      const bodyB1 = { ...baseBody, idempotency_key: keyB1 };
      const hashB1 = reqHash('PUT', canonicalPath, bodyB1);
      const seedB1 = await seedSentinel(keyB1, hashB1, 'SENTINEL_B1');
      expect(seedB1.rowCount === 1, '(B1) sentinel cache di-seed untuk key B1');

      const rB1 = await api('PUT', canonicalPath, bodyB1, { auth: tokenNoPerm, idempotencyKey: keyB1 });
      expect(rB1.status === 403, `(B1) token tanpa permission → 403 (dapat: ${rB1.status})`);
      expect(rB1.json && rB1.json.code === 'FORBIDDEN', `(B1) code=FORBIDDEN (dapat: ${rB1.json ? rB1.json.code : 'null'})`);
      expect(!rB1.headers.get('x-idempotency'), `(B1) TIDAK ada X-Idempotency: HIT (dapat: ${rB1.headers.get('x-idempotency')})`);
      expect(!(rB1.json && JSON.stringify(rB1.json).includes('SENTINEL')), '(B1) respons tidak memuat sentinel');
      const rowB1 = await readIdem(keyB1);
      expect(rowB1 && rowB1.response_body === seedB1.responseBody, '(B1) sentinel tidak berubah');

      // B2: token properti B (punya permission), order milik properti A → 403 CROSS_PROPERTY_ORDER
      const keyB2 = `PEDS20-${RUN_ID}-B2`;
      tracked.idempotencyKeys.push(keyB2);
      const bodyB2 = { ...baseBody, property_id: fx.pidB, idempotency_key: keyB2 };
      const hashB2 = reqHash('PUT', canonicalPath, bodyB2);
      const seedB2 = await seedSentinel(keyB2, hashB2, 'SENTINEL_B2');
      expect(seedB2.rowCount === 1, '(B2) sentinel cache di-seed untuk key B2');

      const rB2 = await api('PUT', canonicalPath, bodyB2, { auth: tokenB, idempotencyKey: keyB2 });
      expect(rB2.status === 403, `(B2) cross-property order → 403 (dapat: ${rB2.status})`);
      expect(
        rB2.json && (rB2.json.code === 'CROSS_PROPERTY_ORDER' || rB2.json.code === 'PROPERTY_SCOPE_REQUIRED'),
        `(B2) code scope denied (dapat: ${rB2.json ? rB2.json.code : 'null'})`
      );
      expect(!rB2.headers.get('x-idempotency'), `(B2) TIDAK ada X-Idempotency: HIT (dapat: ${rB2.headers.get('x-idempotency')})`);
      expect(!(rB2.json && JSON.stringify(rB2.json).includes('SENTINEL')), '(B2) respons tidak memuat sentinel');
      const rowB2 = await readIdem(keyB2);
      expect(rowB2 && rowB2.response_body === seedB2.responseBody, '(B2) sentinel tidak berubah');
    }

    // ═══ F. Varian trailing slash & kapitalisasi (routing Express) ═══
    console.log('\n=== F: varian trailing slash & kapitalisasi → tetap ditolak ===');
    {
      // F1: trailing slash, tanpa auth
      const keyF1 = `PEDS20-${RUN_ID}-F1`;
      tracked.idempotencyKeys.push(keyF1);
      const pathF1 = `/api/pos/orders/${fx.orderId}/`;
      const bodyF1 = { ...baseBody, idempotency_key: keyF1 };
      const hashF1 = reqHash('PUT', pathF1, bodyF1);
      const seedF1 = await seedSentinel(keyF1, hashF1, 'SENTINEL_F1');
      expect(seedF1.rowCount === 1, '(F1) sentinel cache di-seed');

      const rF1 = await api('PUT', pathF1, bodyF1, { idempotencyKey: keyF1 });
      expect(rF1.status === 401, `(F1) trailing slash tanpa auth → 401 (dapat: ${rF1.status})`);
      const hitF1 = rF1.headers.get('x-idempotency');
      expect(!hitF1, `(F1) TIDAK ada X-Idempotency: HIT (dapat: ${hitF1})`);
      expect(!(rF1.json && JSON.stringify(rF1.json).includes('SENTINEL')), '(F1) respons tidak memuat sentinel');
      const rowF1 = await readIdem(keyF1);
      expect(rowF1 && rowF1.response_body === seedF1.responseBody, '(F1) sentinel tidak berubah');

      // F2: kapitalisasi (routing Express case-insensitive), tanpa auth
      const keyF2 = `PEDS20-${RUN_ID}-F2`;
      tracked.idempotencyKeys.push(keyF2);
      const pathF2 = `/API/POS/ORDERS/${fx.orderId}`;
      const bodyF2 = { ...baseBody, idempotency_key: keyF2 };
      const hashF2 = reqHash('PUT', pathF2, bodyF2);
      const seedF2 = await seedSentinel(keyF2, hashF2, 'SENTINEL_F2');
      expect(seedF2.rowCount === 1, '(F2) sentinel cache di-seed');

      const rF2 = await api('PUT', pathF2, bodyF2, { idempotencyKey: keyF2 });
      expect(rF2.status >= 400 && rF2.status !== 200, `(F2) kapitalisasi tanpa auth ditolak (dapat: ${rF2.status})`);
      expect([401, 403, 404].includes(rF2.status), `(F2) status auth/scope/lookup (dapat: ${rF2.status})`);
      const hitF2 = rF2.headers.get('x-idempotency');
      expect(!hitF2, `(F2) TIDAK ada X-Idempotency: HIT (dapat: ${hitF2})`);
      expect(!(rF2.json && JSON.stringify(rF2.json).includes('SENTINEL')), '(F2) respons tidak memuat sentinel');
      const rowF2 = await readIdem(keyF2);
      expect(rowF2 && rowF2.response_body === seedF2.responseBody, '(F2) sentinel tidak berubah');
    }

    // ═══ C. Sentinel tidak berubah & PUT tidak menambah record idempotency_keys ═══
    console.log('\n=== C: PUT tidak menulis cache global ===');
    const idemBeforePuts = await countIdem();
    {
      // (count diambil setelah semua sentinel ter-seed; delta dihitung pada blok berikut)
      expect(typeof idemBeforePuts === 'number', `(C) baseline idempotency_keys = ${idemBeforePuts}`);
    }

    // ═══ D. PUT sah → idempotency milik handler (pos_order_edit_requests), bukan cache global ═══
    console.log('\n=== D: PUT sah memakai idempotency handler, bukan cache global ===');
    {
      const keyD = `PEDS20-${RUN_ID}-D`;
      const bodyD = {
        property_id: fx.pidA,
        expected_version: 1,
        idempotency_key: keyD,
        items: [{ id: fx.orderItemId, menu_item_id: fx.itemAId, quantity: 2 }],
      };
      const rD = await api('PUT', canonicalPath, bodyD, { auth: tokenA, idempotencyKey: keyD });
      expect(rD.status === 200, `(D) PUT sah → 200 (dapat: ${rD.status} ${rD.json ? rD.json.code || '' : ''})`);
      expect(rD.json && rD.json.data && rD.json.data.replayed === false, '(D) replayed=false saat pertama');
      expect(!rD.headers.get('x-idempotency'), `(D) TIDAK ada X-Idempotency: HIT (dapat: ${rD.headers.get('x-idempotency')})`);

      const cacheRowD = await readIdem(keyD);
      expect(cacheRowD === null, '(D) key PUT TIDAK ditulis ke idempotency_keys global');
      const editReqD = await countEditRequests(fx.orderId, keyD);
      expect(editReqD === 1, `(D) 1 record pos_order_edit_requests untuk key (dapat: ${editReqD})`);

      // Replay identik → replayed=true, tetap tanpa baris cache global, tetap 1 record handler.
      const rD2 = await api('PUT', canonicalPath, bodyD, { auth: tokenA, idempotencyKey: keyD });
      expect(rD2.status === 200, `(D) replay → 200 (dapat: ${rD2.status})`);
      expect(rD2.json && rD2.json.data && rD2.json.data.replayed === true, '(D) replay replayed=true');
      const cacheRowD2 = await readIdem(keyD);
      expect(cacheRowD2 === null, '(D) replay tetap TIDAK menulis idempotency_keys');
      const editReqD2 = await countEditRequests(fx.orderId, keyD);
      expect(editReqD2 === 1, `(D) replay tetap 1 record handler (dapat: ${editReqD2})`);
    }

    // C (lanjutan): total idempotency_keys TIDAK berubah oleh seluruh rangkaian PUT.
    {
      const idemAfterPuts = await countIdem();
      expect(
        idemAfterPuts === idemBeforePuts,
        `(C) PUT tidak menambah/mengurangi idempotency_keys (${idemBeforePuts} → ${idemAfterPuts})`
      );
    }

    // ═══ E. Control: endpoint non-bypass tetap menghasilkan X-Idempotency: HIT ═══
    console.log('\n=== E: kontrol harness — endpoint non-bypass menghasilkan cache HIT ===');
    {
      const keyE = `PEDS20-${RUN_ID}-E`;
      tracked.idempotencyKeys.push(keyE);
      const menuBody = {
        property_id: fx.pidA,
        name: `PEDS20 MP ${RUN_4}`,
        item_code: `${runCode('E')}1`.slice(0, 50),
        price: 5000,
      };
      const idemBeforeE = await countIdem();

      const rE1 = await api('POST', '/api/pos/menu/items', menuBody, { auth: tokenMp, idempotencyKey: keyE });
      expect(rE1.status === 201, `(E) POST menu items → 201 (dapat: ${rE1.status})`);
      if (rE1.json && rE1.json.data && rE1.json.data.id) {
        tracked.items.push(rE1.json.data.id);
      }

      const rE2 = await api('POST', '/api/pos/menu/items', menuBody, { auth: tokenMp, idempotencyKey: keyE });
      const hitE = rE2.headers.get('x-idempotency');
      expect(hitE === 'HIT', `(E) retry non-bypass → X-Idempotency: HIT (dapat: ${hitE})`);

      const idemAfterE = await countIdem();
      expect(idemAfterE === idemBeforeE + 1, `(E) tepat 1 baris cache global dibuat (${idemBeforeE} → ${idemAfterE})`);

      // Bukti harness sensitif: bila bypass PUT gagal, idempotency_keys akan dikembalikan
      // sebagai 200 HIT — mekanisme yang sama terdeteksi di sini.
      expect(hitE === 'HIT', '(E) harness mampu mendeteksi HIT cache (deteksi kegagalan bypass valid)');
    }

    // Precondition gate
    if (blockedLog.length > 0) {
      console.error('\n[BLOCKED] ' + blockedLog.length + ' prasyarat tidak terpenuhi.');
    }
  } finally {
    if (server) {
      try {
        server.close();
        await once(server, 'close').catch(() => {});
      } catch (e) {
        console.error('SERVER CLOSE ERROR:', e.message);
      }
    }
    try { await cleanup(); } catch (e) { console.error('CLEANUP ERROR:', e.message); failed += 1; }
    try { await verifyResidue(); } catch (e) { console.error('RESIDUE VERIFY ERROR:', e.message); failed += 1; }
    try { await pool.end(); } catch (e) { console.error('POOL END ERROR:', e.message); failed += 1; }

    console.log('\n── RINGKASAN ──');
    console.log(`PASS: ${passed}  FAIL: ${failed}  BLOCKED: ${blockedLog.length}`);
    if (blockedLog.length > 0) {
      blockedLog.forEach((b) => console.error('  BLOCKED | ' + b));
    }
    process.exit(failed > 0 || blockedLog.length > 0 ? 1 : 0);
  }
}

main().catch((e) => {
  console.error('BLOCKED/UNCAUGHT ERROR:', e && e.message ? e.message : e);
  process.exit(1);
});

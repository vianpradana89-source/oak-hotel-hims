'use strict';

// ──────────────────────────────────────────────────────────────────────────────
// Regression: GET /api/reservations property scope enforcement
// DB: disposable oak_minibar_test:15434 (user minibar_test)
// ──────────────────────────────────────────────────────────────────────────────

// ── DB SAFETY GUARD (pola pos_order_foundation_test.js) ──────────────────────
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !testUrl.trim()) {
  console.error(
    'SAFETY: TEST_DATABASE_URL tidak di-set.\n' +
    'Jalankan: TEST_DATABASE_URL=postgres://minibar_test:OakMinibarLocalOnly2026@127.0.0.1:15434/oak_minibar_test ' +
    'node backend/test/reservations_property_scope_test.js'
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
  console.log(`[RSPO TEST] Target DB: ${database} (user: ${user}, port: ${port})`);
} catch (e) {
  console.error('SAFETY: TEST_DATABASE_URL ditolak — ' + e.message);
  process.exit(1);
}

// Setel DB_* dari URL — tidak ada hardcoded credential di source.
process.env.DB_HOST = target.host;
process.env.DB_PORT = String(target.port);
process.env.DB_USER = target.user;
process.env.DB_PASSWORD = target.password;
process.env.DB_NAME = target.database;
// Jangan jalankan initializeDatabase / seed permission dari dist/index.
process.env.RUN_SCHEMA_INITIALIZATION = 'false';

const http = require('http');
const { once } = require('events');
const { app, pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');

// ── Identity unik per run ─────────────────────────────────────────────────────
// properties.property_code: VARCHAR(6) CHECK ^[A-Z0-9]{2,6}$
// roles.name: VARCHAR(50); users.username: VARCHAR(100); users.email: VARCHAR(150)
const RUN_4 = Date.now().toString(36).toUpperCase().slice(0, 4) +
  Math.random().toString(36).slice(2, 5).toUpperCase();
const runCode = (suffix) => `${RUN_4.slice(-5)}${suffix}`;

const PROP_A_CODE = runCode('A');
const PROP_B_CODE = runCode('B');
const ROLE_A_NAME = `RSA${RUN_4}A`;
const ROLE_NOCAL_NAME = `RSN${RUN_4}N`;
const USER_A_NAME = `rsa${RUN_4.toLowerCase()}`;
const USER_NOCAL_NAME = `rsn${RUN_4.toLowerCase()}`;
const USER_SA_NAME = `rsa${RUN_4.toLowerCase()}sa`;

// Guard: validasi kode fixture SEBELUM membuka resource / mutasi apa pun.
const PROP_CODE_RE = /^[A-Z0-9]{2,6}$/;
if (!PROP_CODE_RE.test(PROP_A_CODE)) {
  throw new Error(`runCode invalid: PROP_A_CODE="${PROP_A_CODE}" tidak cocok ${PROP_CODE_RE}`);
}
if (!PROP_CODE_RE.test(PROP_B_CODE)) {
  throw new Error(`runCode invalid: PROP_B_CODE="${PROP_B_CODE}" tidak cocok ${PROP_CODE_RE}`);
}
if (PROP_A_CODE === PROP_B_CODE) {
  throw new Error(`runCode duplikat: PROP_A_CODE === PROP_B_CODE === "${PROP_A_CODE}"`);
}

let server;
let baseUrl;
let passed = 0;
let failed = 0;
let cleanupExitCode = 0;
let propAId = null;
let propBId = null;
let roleAId = null;
let roleNoCalId = null;
let userAId = null;
let userNoCalId = null;
let userSaId = null;
let saRoleId = null;

function assert(condition, message) {
  if (condition) {
    console.log(`PASS | ${message}`);
    passed++;
  } else {
    console.error(`FAIL | ${message}`);
    failed++;
  }
}

async function api(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const res = await fetch(baseUrl + path, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

function makeToken(userRow, roleObj) {
  return generateToken({
    id: Number(userRow.id),
    username: userRow.username,
    email: userRow.email,
    full_name: userRow.full_name,
    role: roleObj.name,
    role_id: Number(roleObj.id),
    property_id: Number(userRow.property_id),
    scope: 'FULL',
    account_status: 'READY',
    access_type: 'PMS_STAFF'
  });
}

async function main() {
  console.log('=== GET /api/reservations Property Scope Regression ===\n');

  let identityVerified = false;

  try {
    // ── Guard: verifikasi pool.options cocok target ─────────────────────────────
    const opts = pool.options || {};
    if (opts.host !== target.host || Number(opts.port) !== target.port ||
        opts.user !== target.user || opts.database !== target.database) {
      throw new Error(
        'GUARD GAGAL: pool.options tidak cocok target.\n' +
        `  expected: ${JSON.stringify({ host: target.host, port: target.port, user: target.user, database: target.database })}\n` +
        `  actual:   ${JSON.stringify({ host: opts.host, port: Number(opts.port), user: opts.user, database: opts.database })}`
      );
    }

    server = http.createServer(app);
    server.listen(0);
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    // ── Guard: verify test DB identity before any mutation ──���────────────────
    const guardCheck = await pool.query(
      'SELECT current_database() AS db, current_user AS usr'
    );
    const currentDb = guardCheck.rows[0].db;
    const currentUser = guardCheck.rows[0].usr;
    if (currentDb !== target.database) {
      throw new Error(`ABORT: current_database()=${currentDb} ≠ target "${target.database}"`);
    }
    if (currentUser !== target.user) {
      throw new Error(`ABORT: current_user=${currentUser} ≠ target "${target.user}"`);
    }
    identityVerified = true;

    // ── Prasyarat READ-ONLY: permission rows untuk granular keys ────────────────
    // getRoleAccessGrid membaca permissions.key untuk cek role grants.
    // Test TIDAK INSERT permission — hanya verifikasi eksistensi.
    // Jika missing → throw, karena itu prasyarat skema, bukan fixture test.
    const granularKeys = ['reservations.view', 'rooms.view'];
    const missingKeys = [];
    for (const key of granularKeys) {
      const existing = await pool.query('SELECT id FROM permissions WHERE key = $1', [key]);
      if (existing.rows.length === 0) {
        missingKeys.push(key);
      }
    }
    if (missingKeys.length > 0) {
      throw new Error(
        `Prasyarat GAGAL: permission key tidak ada: ${missingKeys.join(', ')}. ` +
        'Jalankan seed/migration permission sebelum test ini.'
      );
    }
    assert(true, `Prasyarat: granular permission keys tersedia (${granularKeys.join(', ')})`);

    // ── Fixtures ──────────────────────────────────────────────────────────────
    // Properties A & B
    const propA = await pool.query(
      `INSERT INTO properties (property_code, name, address, is_active) VALUES ($1, 'Scope Test A', 'Addr A', TRUE) RETURNING id`,
      [PROP_A_CODE]
    );
    propAId = propA.rows[0].id;

    const propB = await pool.query(
      `INSERT INTO properties (property_code, name, address, is_active) VALUES ($1, 'Scope Test B', 'Addr B', TRUE) RETURNING id`,
      [PROP_B_CODE]
    );
    propBId = propB.rows[0].id;

    // Role A: property-scoped, will receive granular permission grants
    const roleA = await pool.query(
      `INSERT INTO roles (property_id, name, is_active, is_system_role) VALUES ($1, $2, TRUE, FALSE) RETURNING id`,
      [propAId, ROLE_A_NAME]
    );
    roleAId = roleA.rows[0].id;

    // Role NoCal: property-scoped, no permissions
    const roleNoCal = await pool.query(
      `INSERT INTO roles (property_id, name, is_active, is_system_role) VALUES ($1, $2, TRUE, FALSE) RETURNING id`,
      [propAId, ROLE_NOCAL_NAME]
    );
    roleNoCalId = roleNoCal.rows[0].id;

    // Platform Super Admin role: is_system_role=true, property_id=NULL, name='Super Admin'
    // Use existing system role if present, otherwise create.
    const saRoleCheck = await pool.query(
      `SELECT id FROM roles WHERE LOWER(TRIM(name)) = 'super admin' AND is_system_role = TRUE AND property_id IS NULL LIMIT 1`
    );
    if (saRoleCheck.rows.length > 0) {
      saRoleId = saRoleCheck.rows[0].id;
    } else {
      const saRoleInsert = await pool.query(
        `INSERT INTO roles (property_id, name, is_active, is_system_role) VALUES (NULL, 'Super Admin', TRUE, TRUE) RETURNING id`
      );
      saRoleId = saRoleInsert.rows[0].id;
    }

    // Users
    // User A: property A, role A (has Kalender:view via granular permission)
    const userA = await pool.query(
      `INSERT INTO users (property_id, role_id, username, email, full_name, is_active, account_status)
       VALUES ($1, $2, $3, $4, 'User A', TRUE, 'READY')
       RETURNING id, property_id, role_id, username, email, full_name`,
       [propAId, roleAId, USER_A_NAME, `${USER_A_NAME}@test.local`]
    );
    userAId = userA.rows[0].id;

    // Grant granular permissions to Role A (reservations.view + rooms.view = Kalender:view)
    for (const key of granularKeys) {
      const permRow = await pool.query('SELECT id FROM permissions WHERE key = $1', [key]);
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission_id, granted) VALUES ($1, $2, TRUE) ON CONFLICT DO NOTHING`,
        [roleAId, permRow.rows[0].id]
      );
    }

    // User NoCal: property A, role NoCal (no permissions at all)
    const userNoCal = await pool.query(
      `INSERT INTO users (property_id, role_id, username, email, full_name, is_active, account_status)
       VALUES ($1, $2, $3, $4, 'User NoCal', TRUE, 'READY')
       RETURNING id, property_id, role_id, username, email, full_name`,
       [propAId, roleNoCalId, USER_NOCAL_NAME, `${USER_NOCAL_NAME}@test.local`]
    );
    userNoCalId = userNoCal.rows[0].id;

    // User SA: Platform Super Admin (role='Super Admin', system role)
    const userSa = await pool.query(
      `INSERT INTO users (property_id, role_id, username, email, full_name, is_active, account_status)
       VALUES ($1, $2, $3, $4, 'Platform SA', TRUE, 'READY')
       RETURNING id, property_id, role_id, username, email, full_name`,
       [propAId, saRoleId, USER_SA_NAME, `${USER_SA_NAME}@test.local`]
    );
    userSaId = userSa.rows[0].id;

    // ── Generate tokens ───────────────────────────────────────────────────────
    const roleObjA = { id: roleAId, name: ROLE_A_NAME };
    const roleObjNoCal = { id: roleNoCalId, name: ROLE_NOCAL_NAME };
    const roleObjSA = { id: saRoleId, name: 'Super Admin' };

    const tokenA = makeToken(userA.rows[0], roleObjA);
    const tokenNoCal = makeToken(userNoCal.rows[0], roleObjNoCal);
    const tokenSa = makeToken(userSa.rows[0], roleObjSA);

    // ════════════════════════════════════════════════════════════════════════
    // TEST 1: No token → 401
    // ════════════════════════════════════════════════════════════════════════
    console.log('--- Test 1: No token → 401 ---');
    const r1 = await api('GET', `/api/reservations?property_id=${propAId}`);
    assert(r1.status === 401, `1A. No auth header → 401 (got ${r1.status})`);
    assert(r1.body?.code === 'UNAUTHORIZED', `1B. No auth header code=UNAUTHORIZED (got ${r1.body?.code})`);

    // ════════════════════════════════════════════════════════════════════════
    // TEST 2: Token A (property A, has Kalender:view) requests property B → 403 scope
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n--- Test 2: Token A requests property B → 403 scope ---');
    const r2 = await api('GET', `/api/reservations?property_id=${propBId}`, { token: tokenA });
    assert(r2.status === 403, `2A. Token A + prop B → 403 (got ${r2.status})`);
    assert(r2.body?.code === 'PROPERTY_SCOPE_REQUIRED', `2B. Code=PROPERTY_SCOPE_REQUIRED (got ${r2.body?.code})`);
    assert(r2.body?.data === undefined, '2C. No reservation data leaked');

    // ════════════════════════════════════════════════════════════════════════
    // TEST 3: Token A requests nonexistent property (out-of-scope) → 403, NOT 404
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n--- Test 3: Token A requests nonexistent out-of-scope property → 403 ---');
    const r3 = await api('GET', '/api/reservations?property_id=999999', { token: tokenA });
    assert(r3.status === 403, `3A. Token A + nonexistent prop → 403 (got ${r3.status})`);
    assert(r3.body?.code === 'PROPERTY_SCOPE_REQUIRED', `3B. Code=PROPERTY_SCOPE_REQUIRED (got ${r3.body?.code})`);
    assert(r3.body?.code !== 'PROPERTY_NOT_FOUND', '3C. NOT 404 PROPERTY_NOT_FOUND');

    // ════════════════════════════════════════════════════════════════════════
    // TEST 4: Token A requests own property → 200
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n--- Test 4: Token A requests own property → 200 ---');
    const r4 = await api('GET', `/api/reservations?property_id=${propAId}`, { token: tokenA });
    assert(r4.status === 200, `4A. Token A + own prop → 200 (got ${r4.status}) ${r4.body?.code ? 'code=' + r4.body.code : ''}`);
    if (r4.status === 200) {
      assert(Array.isArray(r4.body?.data), '4B. Response data is an array');
      assert(r4.body?.data?.length === 0, `4C. Empty list (got ${r4.body?.data?.length})`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // TEST 5: Token NoCal (no Kalender:view) → 403 FORBIDDEN
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n--- Test 5: No Kalender:view permission → 403 FORBIDDEN ---');
    const r5 = await api('GET', `/api/reservations?property_id=${propAId}`, { token: tokenNoCal });
    assert(r5.status === 403, `5A. No permission → 403 (got ${r5.status})`);
    assert(r5.body?.code === 'FORBIDDEN', `5B. Code=FORBIDDEN (got ${r5.body?.code})`);
    assert(r5.body?.data === undefined, '5C. No data in permission-denied response');

    // ════════════════════════════════════════════════════════════════════════
    // TEST 6: Platform Super Admin bypasses property scope
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n--- Test 6: Platform Super Admin bypasses property scope ---');
    const r6 = await api('GET', `/api/reservations?property_id=${propBId}`, { token: tokenSa });
    assert(r6.status === 200, `6A. SA + prop B (out of token scope) → 200 (got ${r6.status}) ${r6.body?.code ? 'code=' + r6.body.code : ''}`);
    if (r6.status === 200) {
      assert(Array.isArray(r6.body?.data), '6B. SA response data is an array');
      assert(r6.body?.data?.length === 0, `6C. Empty list (got ${r6.body?.data?.length})`);
    }

    const r6b = await api('GET', `/api/reservations?property_id=${propAId}`, { token: tokenSa });
    assert(r6b.status === 200, `6D. SA + own prop A → 200 (got ${r6b.status})`);

    // ════════════════════════════════════════════════════════════════════════
    // Catch handler verification: 403 code is preserved, not swallowed to 500
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n--- Catch handler verification ---');
    assert(r2.status === 403 && r2.body?.code === 'PROPERTY_SCOPE_REQUIRED',
      'Catch preserves 403 PROPERTY_SCOPE_REQUIRED (not 500)');
    assert(r3.status === 403 && r3.body?.code === 'PROPERTY_SCOPE_REQUIRED',
      'Catch preserves 403 for nonexistent out-of-scope (not 404/500)');

  } finally {
    if (server) {
      server.close();
      await once(server, 'close');
    }

    // Cleanup mutasi hanya jika identity guard lolos.
    // Server/pool tetap ditutup di bawah.
    if (identityVerified) {
      // ── Cleanup fixtures in a transaction; rollback on failure ───────────────
      console.log('\n--- Cleaning up Fixtures ---');
      try {
        await pool.query('BEGIN');

        // Delete users (FK: property_id → properties, role_id → roles)
        const userIds = [userAId, userNoCalId, userSaId].filter(Boolean);
        if (userIds.length > 0) {
          await pool.query(
            `DELETE FROM users WHERE id = ANY($1::int[])`,
            [userIds]
          );
        }

        // Delete role_permissions for created roles
        const roleIds = [roleAId, roleNoCalId].filter(Boolean);
        if (roleIds.length > 0) {
          await pool.query(
            `DELETE FROM role_permissions WHERE role_id = ANY($1::int[])`,
            [roleIds]
          );
        }

        // Delete roles (only the ones we created; NOT the system 'Super Admin' role)
        if (roleIds.length > 0) {
          await pool.query(
            `DELETE FROM roles WHERE id = ANY($1::int[])`,
            [roleIds]
          );
        }
        // Do NOT delete SA role if it pre-existed (id from system seed).
        // We only created it if missing; if pre-existing, leave it.

        // Delete properties
        const propIds = [propAId, propBId].filter(Boolean);
        if (propIds.length > 0) {
          await pool.query(
            `DELETE FROM properties WHERE id = ANY($1::int[])`,
            [propIds]
          );
        }

        await pool.query('COMMIT');
        console.log('Cleanup committed.');
      } catch (cleanErr) {
        await pool.query('ROLLBACK').catch(() => {});
        console.error('Cleanup error:', cleanErr.message);
        cleanupExitCode = 1;
      }

      // ── Verify zero residue ──────────────────────────────────────────────────
      const residueCheck = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM properties WHERE property_code IN ($1, $2)`,
        [PROP_A_CODE, PROP_B_CODE]
      );
      const residueCount = residueCheck.rows[0].cnt;
      assert(residueCount === 0, `Residue check: zero test properties (got ${residueCount})`);
      if (residueCount !== 0) cleanupExitCode = 1;

      // Verify no user residue
      const userResidue = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM users WHERE username = ANY($1::text[])`,
        [[USER_A_NAME, USER_NOCAL_NAME, USER_SA_NAME]]
      );
      const userResidueCount = userResidue.rows[0].cnt;
      assert(userResidueCount === 0, `Residue check: zero test users (got ${userResidueCount})`);
      if (userResidueCount !== 0) cleanupExitCode = 1;

      // Verify no role/role_permissions residue for test-created roles
      const roleResidue = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM roles WHERE name IN ($1, $2)`,
        [ROLE_A_NAME, ROLE_NOCAL_NAME]
      );
      const roleResidueCount = roleResidue.rows[0].cnt;
      assert(roleResidueCount === 0, `Residue check: zero test roles (got ${roleResidueCount})`);
      if (roleResidueCount !== 0) cleanupExitCode = 1;

      const rolePermResidue = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         WHERE r.name IN ($1, $2)`,
        [ROLE_A_NAME, ROLE_NOCAL_NAME]
      );
      const rolePermResidueCount = rolePermResidue.rows[0].cnt;
      assert(rolePermResidueCount === 0, `Residue check: zero test role_permissions (got ${rolePermResidueCount})`);
      if (rolePermResidueCount !== 0) cleanupExitCode = 1;
    } else {
      console.log('\n--- Cleanup SKIPPED: identity guard tidak lolos; hanya menutup pool ---');
    }

    await pool.end();
  }

  console.log(`\n=== Property Scope Regression Test Summary: ${passed} passed, ${failed} failed ===`);
  // Exit code: 1 if any test failed OR cleanup failed
  process.exitCode = (failed > 0 || cleanupExitCode === 1) ? 1 : 0;
}

main().catch((err) => {
  console.error('Test execution error:', err);
  try { pool.end().catch(() => {}); } catch {}
  process.exitCode = 1;
});

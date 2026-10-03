/**
 * RESERVATION-AUDIT-LOG REGRESSION (v4)
 * Tests for GET /api/reservations/:id/audit
 *
 * Backend coverage:
 *  S1  Property scope rejection (403) — user of property A, requests property B
 *  S2  Reservation ownership (404 / 403)
 *  S3  Entity ID collision same-property (RESERVATION_GUEST excluded)
 *  S4  Timestamp tie broken by audit_id (DESC ordering)
 *  S5  Timestamp reversed vs audit_id (timestamp rules over ID)
 *  S6  Microsecond precision across pages (boundary .123456/.123457, 6-digit µs)
 *  S7  Invalid cursor variants → 400 INVALID_CURSOR (incl. leap-year calendar checks)
 *  S8  Invalid limit variants → 400 INVALID_LIMIT
 *  S9  Invalid JSON new_value does not break response
 *  S10 Actor: snapshot name preferred; actor_user_id NEVER shown as name
 *  S11 Redaction: no PII from new_value anywhere in response
 *  S12 Reservation ID non-integer → 400
 *  S13 next_cursor null on last page; has_more flag correctness
 *  S14 Response shape: {status:'OK', data:[DTO...], has_more, next_cursor}
 *
 * Frontend: hook-level tests in the frontend test suite (useAuditLog hook).
 *
 * SAFETY:
 *  - TEST_DATABASE_URL must be set explicitly (no fallback construction from DB_*).
 *  - Parsed with new URL(); database name is decodeURI'd before validation.
 *  - Hostname AND database name must not contain staging/production/prod/live.
 *  - Database name must contain "test".
 *  - All pool configuration (app + test) derives from the single validated URL.
 *  - RUN_SCHEMA_INITIALIZATION=false prevents bootstrap at import time.
 *  - Disposable test DB bootstrap happens explicitly after verification.
 *  - No .env read; no dotenv; no inheritance from application config.
 *  - No password or full URL printed in output.
 */
'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');

// ── Safety gate: TEST_DATABASE_URL is MANDATORY and EXPLICIT ──
// No fallback that assembles a URL from individual DB_* variables.
// The test refuses to run without a fully-qualified, explicit connection string.
const FORBIDDEN_PATTERNS = [/staging/i, /production/i, /prod/i, /live/i];

const RAW_TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!RAW_TEST_DATABASE_URL) {
  console.error('\n[FAIL] SAFETY: TEST_DATABASE_URL environment variable must be set explicitly.');
  console.error('  Example: postgres://user:pass@localhost:5432/oak_hotel_test');
  console.error('  Do NOT set DB_* variables as a substitute; provide the full URL.');
  process.exit(1);
}

// Parse the URL properly using the URL constructor.
let parsedUrl;
try {
  parsedUrl = new URL(RAW_TEST_DATABASE_URL);
} catch (e) {
  console.error(`\n[FAIL] SAFETY: TEST_DATABASE_URL is not a valid URL: ${e.message}`);
  process.exit(1);
}

// Extract and validate components from the parsed URL.
const urlHost = parsedUrl.hostname;
const urlPort = parsedUrl.port;
// decodeURIComponent on the database path (strip leading slash, decode).
const urlDatabase = decodeURIComponent(parsedUrl.pathname.replace(/^\//, ''));
// WHATWG URL already percent-decodes username/password, but decode again
// (idempotent) to be explicit about the requirement.
const urlUser = parsedUrl.username ? decodeURIComponent(parsedUrl.username) : '';
const urlPassword = parsedUrl.password ? decodeURIComponent(parsedUrl.password) : ''; // NEVER printed

// Validate: database name must contain "test".
if (!/test/i.test(urlDatabase)) {
  console.error(`\n[FAIL] SAFETY: database "${urlDatabase}" does not contain "test". Refusing to run.`);
  process.exit(1);
}

// Validate: hostname must not match forbidden patterns.
for (const re of FORBIDDEN_PATTERNS) {
  if (re.test(urlHost)) {
    console.error(`\n[FAIL] SAFETY: hostname "${urlHost}" matches forbidden pattern ${re}. Refusing to run.`);
    process.exit(1);
  }
}

// Validate: database name must not match forbidden patterns.
for (const re of FORBIDDEN_PATTERNS) {
  if (re.test(urlDatabase)) {
    console.error(`\n[FAIL] SAFETY: database "${urlDatabase}" matches forbidden pattern ${re}. Refusing to run.`);
    process.exit(1);
  }
}

// Validate: user must be present in the URL.
if (!urlUser) {
  console.error('\n[FAIL] SAFETY: TEST_DATABASE_URL must include a username (postgres://user:pass@host:port/db).');
  process.exit(1);
}

// Validate: password must be present (we do not print it).
if (!urlPassword) {
  console.error('\n[FAIL] SAFETY: TEST_DATABASE_URL must include a password (postgres://user:pass@host:port/db).');
  process.exit(1);
}

// ── Derive ALL pool configuration from the validated URL ──
// The app pool (created inside dist/index.js from env vars) and the test pool
// must resolve to the same validated target. We set process.env before import.

// Set DB target BEFORE loading the app so the app pool targets the test DB.
// RUN_SCHEMA_INITIALIZATION=false: do NOT run schema bootstrap at import time.
// The disposable test DB bootstrap is done explicitly after pool verification.
process.env.DB_NAME = urlDatabase;
process.env.DB_HOST = urlHost;
process.env.DB_PORT = urlPort || '5432';
process.env.DB_USER = urlUser;
process.env.DB_PASSWORD = urlPassword; // set but never printed
process.env.RUN_SCHEMA_INITIALIZATION = 'false';

// No .env — no dotenv. Connection parameters come exclusively from the
// validated TEST_DATABASE_URL parsed above.
const { Pool } = require('pg');
const { app, pool } = require('../dist/index');
const { initializeDatabase } = require('../dist/db/schema_v3');
const { generateToken } = require('../dist/domains/auth/authService');

const runId = `AUDITLOG-V4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// testPool uses the same validated URL directly.
const testPool = new Pool({
  connectionString: RAW_TEST_DATABASE_URL,
});

// ── Verify BOTH pools target the same validated database before any mutation ──
// Two independent checks, run BEFORE any mutation (setupFixtures / insertAudit):
//
//  (1) EFFECTIVE CONFIGURATION — the host/port/database/user each pool is
//      configured with must equal the validated target. The app pool is
//      constructed from env vars (host/port/user/database options); the test
//      pool from a connection string (parsed, not printed). Password is never
//      read or printed here.
//  (2) SERVER PROBE — current_database(), current_user(), inet_server_addr(),
//      inet_server_port(). The database and user on the live server MUST equal
//      the validated target. The two pools MUST reach the same server endpoint
//      (same server address + port). The server address is NOT forced to equal
//      the URL host: in a disposable Docker container inet_server_addr() is the
//      container's internal IP, not the client-side 127.0.0.1.
//
// Neither check is bypassed or its result coerced.
function effectiveConfig(p) {
  const o = (p && p.options) || {};
  // Explicit options win; otherwise parse the connection string.
  if (o.host || o.database || o.user) {
    return {
      host: o.host || '',
      port: String(o.port || ''),
      database: o.database || '',
      user: o.user || '',
    };
  }
  const cs = o.connectionString;
  if (cs) {
    const u = new URL(cs);
    return {
      host: u.hostname,
      port: u.port || '5432',
      database: decodeURIComponent(u.pathname.replace(/^\//, '')),
      user: u.username ? decodeURIComponent(u.username) : '',
    };
  }
  throw new Error('Cannot determine effective pool configuration');
}

async function verifyPoolsMatch() {
  const appPool = pool;
  const testP = testPool;

  // (1) Effective configuration must equal the validated target.
  for (const [label, p] of [['app', appPool], ['test', testP]]) {
    const c = effectiveConfig(p);
    if (c.database !== urlDatabase) {
      throw new Error(`Pool ${label} configured database ${c.database} ≠ validated ${urlDatabase}`);
    }
    if (c.user !== urlUser) {
      throw new Error(`Pool ${label} configured user ${c.user} ≠ validated ${urlUser}`);
    }
    if (String(c.port) !== String(urlPort || '5432')) {
      throw new Error(`Pool ${label} configured port ${c.port} ≠ validated ${urlPort || '5432'}`);
    }
    if (c.host !== urlHost) {
      throw new Error(`Pool ${label} configured host ${c.host} ≠ validated ${urlHost}`);
    }
  }

  // (2) Live server probe: db + user must equal the target; both pools must
  // reach the same server endpoint (address + port). Server address is not
  // forced equal to the URL host (Docker internal IP case).
  const probe = (p) =>
    p.query(
      `SELECT current_database() AS db,
              current_user AS usr,
              inet_server_addr() AS server_addr,
              inet_server_port() AS server_port`
    );
  const [a, t] = await Promise.all([probe(appPool), probe(testP)]);
  for (const [label, row] of [['app', a.rows[0]], ['test', t.rows[0]]]) {
    if (row.db !== urlDatabase) {
      throw new Error(`Probe ${label}: current_database ${row.db} ≠ validated ${urlDatabase}`);
    }
    if (row.usr !== urlUser) {
      throw new Error(`Probe ${label}: current_user ${row.usr} ≠ validated ${urlUser}`);
    }
  }
  // Same server endpoint: both pools must see identical server address+port.
  if (String(a.rows[0].server_addr) !== String(t.rows[0].server_addr) ||
      String(a.rows[0].server_port) !== String(t.rows[0].server_port)) {
    throw new Error(
      `Probe endpoint mismatch: app→${a.rows[0].server_addr}:${a.rows[0].server_port}, ` +
      `test→${t.rows[0].server_addr}:${t.rows[0].server_port} (must reach the same server)`
    );
  }
  console.log(
    `[verify] pools reach ${a.rows[0].server_addr}:${a.rows[0].server_port} ` +
    `db=${urlDatabase} user=${urlUser}`
  );
}

// ── Explicit disposable test DB bootstrap (only after pool verification) ──
async function bootstrapTestDb() {
  // initializeDatabase is idempotent; run it explicitly on the validated target.
  // Errors are NOT swallowed — a bootstrap failure must stop the test.
  await initializeDatabase(testPool);
  console.log(`[setup] initializeDatabase completed on target database`);
}

let server, baseUrl;
let testPropertyId = null;
let otherPropertyId = null;
const createdAuditIds = [];
const createdReservationIds = [];
const createdBookingIds = [];
const createdRoomIds = [];
const createdPropertyIds = [];
let createdFouUserIds = [];
let createdS1RoleIds = [];
let createdSuperAdminUserIds = [];

let passed = 0, failed = 0;
function pass(n, d) { passed++; console.log(`  PASS #${n}: ${d}`); }
function fail(n, d, err) {
  failed++;
  console.error(`  FAIL #${n}: ${d}`);
  if (err) console.error(`    ${err.message || err}`);
}

function genId() {
  return `${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).toUpperCase().slice(2, 8)}`;
}

async function authHeaders(propertyId, userFilter = {}) {
  // Default: any system-role Super Admin (property-scoped role_id user OK —
  // platform check reads role.is_system_role + role.property_id IS NULL;
  // user's own property is irrelevant to assertPropertyScope for system-role holders).
  const params = [];
  let whereClause;
  if (userFilter.username) {
    whereClause = `u.username = $1`;
    params.push(userFilter.username);
  } else {
    whereClause = "r.name = 'Super Admin' AND r.is_system_role = TRUE";
  }
  const saRes = await testPool.query(`
    SELECT u.id, u.username, u.full_name, u.email, u.property_id,
           r.id AS role_id, r.name AS role
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE ${whereClause}
    ORDER BY u.id LIMIT 1
  `, params);
  if (!saRes.rows[0]) throw new Error('Required user not found in test DB');
  const u = saRes.rows[0];
  // Token property: the property the token is bound to.
  const tokenPropertyId = userFilter.tokenProperty ?? propertyId;
  const token = generateToken({
    id: u.id, username: u.username, full_name: u.full_name,
    email: u.email || 'sa@test.local', role_id: u.role_id, role: u.role,
    property_id: tokenPropertyId, access_type: 'PMS_STAFF', scope: 'FULL'
  });
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function getAudit(propertyId, reservationId, opts = {}) {
  const headers = await authHeaders(opts.tokenProperty ?? propertyId);
  const params = new URLSearchParams();
  params.set('property_id', String(propertyId));
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.cursor) params.set('cursor', opts.cursor);
  const url = `${baseUrl}/api/reservations/${reservationId}/audit?${params.toString()}`;
  const res = await fetch(url, { method: 'GET', headers });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, raw: await res.text().catch(() => '') };
}

async function insertAudit(fields) {
  const r = await testPool.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id, actor_user_id, timestamp)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING audit_id`,
    [
      fields.module, fields.action, fields.entity, String(fields.recordId),
      fields.newValue === undefined ? null : JSON.stringify(fields.newValue),
      `CORR-${genId()}`, fields.propertyId,
      fields.actorUserId === undefined ? null : String(fields.actorUserId),
      fields.timestamp,
    ]
  );
  createdAuditIds.push(r.rows[0].audit_id);
  return r.rows[0].audit_id;
}

async function createReservation(propertyId) {
  const room = await testPool.query(
    `INSERT INTO rooms (property_id, room_number, name, status, is_active)
     VALUES ($1, $2, 'AuditV2 Room', 'VACANT_CLEAN', TRUE) RETURNING id`,
      [propertyId, `A2${Date.now().toString(36).slice(-6).toUpperCase()}`]
  );
  createdRoomIds.push(room.rows[0].id);

  const booking = await testPool.query(
    `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status, created_at, updated_at)
     VALUES ($1, $2, 'AuditV2 Guest', 'ACTIVE', NOW(), NOW()) RETURNING id`,
      [propertyId, `A2BK${Date.now().toString(36).slice(-6).toUpperCase()}`]
  );
  createdBookingIds.push(booking.rows[0].id);

  const resv = await testPool.query(
    `INSERT INTO reservations (booking_id, room_id, guest_name, check_in, check_out,
       total_price, amount_paid, remaining_balance, status, stay_status, payment_status, stay_sequence)
     VALUES ($1, $2, 'AuditV2 Guest', '2030-09-01', '2030-09-03', 1000000, 0, 1000000,
       'BOOKED', 'RESERVED', 'UNPAID', 1) RETURNING id`,
    [booking.rows[0].id, room.rows[0].id]
  );
  createdReservationIds.push(resv.rows[0].id);
  return resv.rows[0].id;
}

async function initServer() {
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

async function setupFixtures() {
  // Verify both pools target the same validated database before any mutation.
  await verifyPoolsMatch();
  console.log('[setup] Pool verification passed: both pools target the same validated test DB');

  // Explicit disposable test DB bootstrap (idempotent, NOT swallowed on error).
  await bootstrapTestDb();

  // Keep roles_id_seq in sync with explicit-id rows so sequence-based
  // inserts (S1 fixture role) never collide.
  await testPool.query(`SELECT setval('roles_id_seq', COALESCE((SELECT MAX(id) FROM roles), 1))`);

  // Seed a deterministic Super Admin system role + user if missing.
  // `initializeDatabase` only inserts the "HRD Admin" system role; the other
  // system roles are UPDATEd only (no INSERT), so a fresh test DB has no
  // "Super Admin". `authHeaders` requires a user whose role is "Super Admin".
  // Both the role and the user are tracked for cleanup and residue checks.
  const { hashPassword } = require('../dist/domains/auth/authService');
  const existingSaRole = await testPool.query(
    `SELECT id FROM roles WHERE name = 'Super Admin' AND is_system_role = TRUE AND property_id IS NULL LIMIT 1`
  );
  let saRoleId = existingSaRole.rows[0]?.id;
  if (!saRoleId) {
    const saRoleIns = await testPool.query(
      `INSERT INTO roles (property_id, name, description, is_system_role, is_active, is_test_data, created_at, updated_at)
       VALUES (NULL, 'Super Admin', 'Audit-Log test fixture: platform admin role', TRUE, TRUE, TRUE, NOW(), NOW())
       RETURNING id`
    );
    saRoleId = saRoleIns.rows[0].id;
    createdS1RoleIds.push(saRoleId);
    console.log(`[setup] seeded Super Admin system role id=${saRoleId}`);
  }

  const props = await testPool.query('SELECT id FROM properties ORDER BY id LIMIT 2');
  if (props.rows.length < 2) {
    const target = 2 - props.rows.length;
    for (let i = 1; i <= target; i++) {
      // property_code is VARCHAR(6) with CHECK ~ '^[A-Z0-9]{2,6}$'.
      // Build a unique 6-char uppercase alphanumeric code within that limit.
      const suffix = (Date.now().toString(36) + Math.random().toString(36))
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 5) + String(i);
      const res = await testPool.query(
        `INSERT INTO properties (name, address, phone, property_code, timezone, currency_code)
          VALUES ($1, 'Addr', '081', $2, 'Asia/Jakarta', 'IDR') RETURNING id`,
        [`AuditV2 Prop${i}`, suffix]
      );
      createdPropertyIds.push(Number(res.rows[0].id));
    }
  }
  const re = await testPool.query('SELECT id FROM properties ORDER BY id LIMIT 2');
  testPropertyId = Number(re.rows[0].id);
  otherPropertyId = Number(re.rows[1].id);
  console.log(`properties: test=${testPropertyId}, other=${otherPropertyId}`);

  // Seed the Super Admin user NOW (after testPropertyId is known): the users
  // table requires a non-NULL property_id, so the fixture user is bound to
  // this run's property (which cleanup will remove).
  const existingSaUser = await testPool.query(
    `SELECT id FROM users WHERE role_id = $1 LIMIT 1`,
    [saRoleId]
  );
  if (!existingSaUser.rows[0]) {
    const saSuffix = Date.now().toString(36);
    const saHash = await hashPassword('AuditSa2026!');
    const saIns = await testPool.query(
      `INSERT INTO users (property_id, role_id, username, email, password_hash,
                          full_name, is_active, account_status, must_change_password,
                          access_type, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'Audit SA', TRUE, 'READY', FALSE, 'PMS_STAFF', NOW(), NOW())
       RETURNING id`,
      [testPropertyId, saRoleId, `audit_sa_${saSuffix}`, `audit.sa.${saSuffix}@t.local`, saHash]
    );
    createdSuperAdminUserIds.push(saIns.rows[0].id);
    console.log(`[setup] seeded Super Admin user id=${saIns.rows[0].id} (property ${testPropertyId})`);
  } else {
    console.log(`[setup] reusing existing Super Admin user id=${existingSaUser.rows[0].id}`);
  }
}

async function cleanup() {
  // Collect cleanup errors instead of silently swallowing them. Ordering:
  // users BEFORE role_permissions/roles (a user may reference the role),
  // reservations before bookings/rooms/properties.
  const cleanupErrors = [];
  const del = async (label, sql, params) => {
    try {
      await testPool.query(sql, params);
    } catch (e) {
      cleanupErrors.push(`${label} (${sql.replace(/\s+/g, ' ').slice(0, 60)}...): ${e.message}`);
    }
  };

  for (const id of createdAuditIds) await del('audit_logs', 'DELETE FROM audit_logs WHERE audit_id = $1', [id]);
  // Users first (they reference role_id); role rows are deleted only after.
  // Seeded Super Admin users are cleaned up FIRST (before S1 users/roles) so
  // the system role is not left without a fixture user.
  for (const id of createdSuperAdminUserIds) await del('users', 'DELETE FROM users WHERE id = $1', [id]);
  for (const id of createdFouUserIds) await del('users', 'DELETE FROM users WHERE id = $1', [id]);
  // A role ID stays tracked even if its DELETE fails so residue can be
  // reported below — never dropped from tracking on failure.
  for (const id of createdS1RoleIds) {
    await del('role_permissions', 'DELETE FROM role_permissions WHERE role_id = $1', [id]);
    await del('roles', 'DELETE FROM roles WHERE id = $1', [id]);
  }
  for (const id of createdReservationIds) {
    await del('reservation_nightly_rates', 'DELETE FROM reservation_nightly_rates WHERE reservation_id = $1', [id]);
    await del('folio_entries', 'DELETE FROM folio_entries WHERE reservation_id = $1', [id]);
    await del('payment_transactions', 'DELETE FROM payment_transactions WHERE reservation_id = $1', [id]);
    await del('reservations', 'DELETE FROM reservations WHERE id = $1', [id]);
  }
  for (const id of createdBookingIds) await del('bookings', 'DELETE FROM bookings WHERE id = $1', [id]);
  for (const id of createdRoomIds) await del('rooms', 'DELETE FROM rooms WHERE id = $1', [id]);
  for (const id of createdPropertyIds) await del('properties', 'DELETE FROM properties WHERE id = $1', [id]);

  if (cleanupErrors.length) {
    console.error(`[cleanup] ${cleanupErrors.length} cleanup error(s):`);
    for (const e of cleanupErrors) console.error('  - ' + e);
  }
  await verifyNoResidue(cleanupErrors);
  return cleanupErrors;
}

// Confirm that no fixture owned by THIS run remains in the disposable DB.
async function verifyNoResidue(cleanupErrors) {
  const residue = [];
  const check = async (label, sql, params) => {
    try {
      const r = await testPool.query(sql, params);
      if (r.rowCount > 0) residue.push(`${label} (${r.rowCount} row(s))`);
    } catch (e) {
      residue.push(`${label}: check failed (${e.message})`);
    }
  };
  await check('audit_logs', 'SELECT 1 FROM audit_logs WHERE audit_id = $1 LIMIT 1', createdAuditIds.length ? [createdAuditIds[0]] : [0]);
  await check('users', 'SELECT 1 FROM users WHERE id = $1 LIMIT 1', createdFouUserIds.length ? [createdFouUserIds[0]] : [0]);
  for (const id of createdSuperAdminUserIds) {
    await check('users', 'SELECT 1 FROM users WHERE id = $1 LIMIT 1', [id]);
  }
  for (const id of createdS1RoleIds) {
    await check('roles', 'SELECT 1 FROM roles WHERE id = $1 LIMIT 1', [id]);
    await check('role_permissions', 'SELECT 1 FROM role_permissions WHERE role_id = $1 LIMIT 1', [id]);
  }
  if (residue.length) {
    console.error(`[cleanup] RESIDUE DETECTED: ${residue.join('; ')}`);
    cleanupErrors.push('residue: ' + residue.join('; '));
  } else if (!cleanupErrors.length) {
    console.log('[cleanup] no fixture residue detected');
  }
}

async function teardown() {
  await cleanup();
  if (server) { server.close(); await new Promise(r => setTimeout(r, 200)); }
  await testPool.end().catch(() => {});
  await pool.end().catch(() => {});
}

// Frontend hook-level tests (useAuditLog) live in the frontend test suite.
// This file covers the backend endpoint only (S1–S14).

async function main() {
  console.log(`\n=== OAK HIMS RESERVATION AUDIT LOG REGRESSION v4 (${runId}) ===`);
  console.log(`DB: ${urlDatabase}\n`);

  try {
    await initServer();
    await setupFixtures();

    // Reservation in testPropertyId; reservation B in otherPropertyId
    const resIdA = await createReservation(testPropertyId);
    const resIdB = await createReservation(otherPropertyId);
    console.log(`reservations: A=${resIdA} (prop ${testPropertyId}), B=${resIdB} (prop ${otherPropertyId})\n`);

    // Deterministic audit rows for A (timestamp tie + reversed cases):
    //  t1 2030-09-01 10:00:00.000000  (tie pair — ID decides)
    //  t2 2030-09-01 10:00:00.000000  (tie pair — ID decides)
    //  t3 2030-09-01 10:00:01.000000  (higher ts, inserted with LOWER id later)
    //  t4 2030-09-01 09:59:59.999999  (older page-2 boundary microsecond)
    //  t5 2030-09-01 10:00:00.123456  (page boundary, lower microsecond)
    //  t6 2030-09-01 10:00:00.123457  (page boundary, higher microsecond — must sort after t5)
    const t1 = '2030-09-01 10:00:00.000000';
    const t3 = '2030-09-01 10:00:01.000000';
    const t4 = '2030-09-01 09:59:59.999999';

    const id1 = await insertAudit({ module: 'PMS', action: 'CREATE', entity: 'RESERVATION', recordId: resIdA, propertyId: testPropertyId, actorUserId: '42', newValue: { guest_name: 'AuditV2 Guest', guest_phone: '081234567890', identity_number: '3273010101990001', ktp_path: '/uploads/ktp/x.jpg' }, timestamp: t1 });
    const id2 = await insertAudit({ module: 'PMS', action: 'CREATE', entity: 'RESERVATION', recordId: resIdA, propertyId: testPropertyId, actorUserId: '42', newValue: { amount: 500000, actor_name_snapshot: 'Rina Front Office' }, timestamp: t1 }); // tie with id1
    const id3 = await insertAudit({ module: 'PAYMENT', action: 'PAYMENT_CREATED', entity: 'RESERVATION', recordId: resIdA, propertyId: testPropertyId, actorUserId: '42', newValue: { amount: 750000 }, timestamp: t3 }); // higher ts despite being inserted after id2 (reversed case anchor)
    const id4 = await insertAudit({ module: 'DEPOSIT', action: 'DEPOSIT_RECEIVED', entity: 'RESERVATION', recordId: resIdA, propertyId: testPropertyId, actorUserId: '7', newValue: { amount: 100000 }, timestamp: t4 });
    // Page-boundary microsecond pair:
    //   .123456 and .123457 share the same second (2030-09-01 10:00:00) but
    //   differ in the last microsecond digit — the keyset must not collapse
    //   them when the page boundary falls between the two rows.
    await insertAudit({ module: 'PAYMENT', action: 'PAYMENT_CREATED', entity: 'RESERVATION', recordId: resIdA, propertyId: testPropertyId, actorUserId: '42', newValue: { amount: 250000 }, timestamp: '2030-09-01 10:00:00.500000' }); // between t1 and t3
    const idT5 = await insertAudit({ module: 'DEPOSIT', action: 'DEPOSIT_APPLIED', entity: 'RESERVATION', recordId: resIdA, propertyId: testPropertyId, actorUserId: '42', newValue: { amount: 10000 }, timestamp: '2030-09-01 10:00:00.123456' });
    const idT6 = await insertAudit({ module: 'DEPOSIT', action: 'DEPOSIT_APPLIED', entity: 'RESERVATION', recordId: resIdA, propertyId: testPropertyId, actorUserId: '42', newValue: { amount: 20000 }, timestamp: '2030-09-01 10:00:00.123457' });
    // same-property, same record_id, DIFFERENT entity → must be excluded
    const guestRowId = await insertAudit({ module: 'PMS', action: 'GUEST_ADDED', entity: 'RESERVATION_GUEST', recordId: resIdA, propertyId: testPropertyId, actorUserId: '42', newValue: { guest_phone: '081999999999' }, timestamp: t3 });
    // invalid JSON row (raw literal, not via insertAudit's stringify)
    const badJsonRow = await testPool.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id, actor_user_id, timestamp)
       VALUES ('PMS','UPDATE','RESERVATION',$1,'{not-valid-json',$2,'42',$3) RETURNING audit_id`,
      [String(resIdA), testPropertyId, '2030-09-01 10:00:00.250000']
    );
    createdAuditIds.push(badJsonRow.rows[0].audit_id);

    // ── S1: property scope rejection — user of property A, token property A,
    //   requests audit of a reservation in property B with query property B.
    //   Must get 403 PROPERTY_SCOPE_REQUIRED from the ENDPOINT (not a helper).
    //   Positive control: same user requests property A reservation → 200.
    //
    //   Fixture strategy: a property-scoped role "AuditV3 S1" is created for
    //   testPropertyId and granted reservations.view (Kalender view), so the
    //   operational access guard passes and the test reaches the endpoint's
    //   assertPropertyScope. The role + user are cleaned up in finally.
    {
      const { hashPassword } = require('../dist/domains/auth/authService');
      const suffix = Date.now().toString(36);
      const roleName = `AuditV3_S1_${suffix}`;
      const permRes = await testPool.query(
        `SELECT id FROM permissions WHERE key = 'reservations.view' LIMIT 1`
      );
      assert(permRes.rows.length > 0, 'S1 requires reservations.view permission in test DB');
      const permId = permRes.rows[0].id;

      // Create property-scoped role (id comes from the sequence; the
      // sequence is synced to MAX(id) in setupFixtures so no-id inserts
      // can never collide with explicit-id rows).
      const roleIns = await testPool.query(`
        INSERT INTO roles (name, description, property_id, is_system_role, is_active, is_test_data, created_at, updated_at)
        VALUES ($1, 'S1 scope fixture', $2, FALSE, TRUE, TRUE, NOW(), NOW())
        RETURNING id`,
        [roleName, testPropertyId]
      );
      const roleId = roleIns.rows[0].id;
      createdS1RoleIds.push(roleId);

      // Grant reservations.view to the role
      await testPool.query(`
        INSERT INTO role_permissions (role_id, permission_id, granted, created_by)
        VALUES ($1, $2, TRUE, 's1-fixture')
        ON CONFLICT (role_id, permission_id) DO UPDATE SET granted = TRUE`,
        [roleId, permId]
      );

      // Create user on testPropertyId with the new role
      const hash = await hashPassword('AuditFo2026!');
      const foIns = await testPool.query(`
        INSERT INTO users (property_id, role_id, username, email, password_hash,
                           full_name, is_active, account_status, must_change_password,
                           access_type, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 'Audit V3 S1', TRUE, 'READY', FALSE, 'PMS_STAFF', NOW(), NOW())
        RETURNING id`,
        [testPropertyId, roleId, `audit_v3_s1_${suffix}`, `audit.s1${suffix}@t.local`, hash]
      );
      createdFouUserIds.push(foIns.rows[0].id);
      const userId = foIns.rows[0].id;

      try {
        // Token: user belongs to property A (testPropertyId), token also property A.
        const token = generateToken({
          id: userId,
          username: `audit_v3_s1_${suffix}`,
          full_name: 'Audit V3 S1',
          email: `audit.s1${suffix}@t.local`,
          role_id: roleId,
          role: roleName,
          property_id: testPropertyId,
          access_type: 'PMS_STAFF',
          scope: 'FULL'
        });

        // Cross-property request: property A user asks for property B reservation.
        const crossRes = await fetch(
          `${baseUrl}/api/reservations/${resIdB}/audit?property_id=${otherPropertyId}`,
          { method: 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
        );
        const crossBody = await crossRes.json().catch(() => null);
        assert.strictEqual(crossRes.status, 403, `S1 cross-property expected 403 got ${crossRes.status}`);
        assert.strictEqual(
          crossBody?.code, 'PROPERTY_SCOPE_REQUIRED',
          `S1 code must be PROPERTY_SCOPE_REQUIRED, got ${crossBody?.code}`
        );
        pass('S1a', 'user of property A, token property A, requests property B → 403 PROPERTY_SCOPE_REQUIRED');

        // Positive control: same user requests their own property A reservation.
        const ownRes = await fetch(
          `${baseUrl}/api/reservations/${resIdA}/audit?property_id=${testPropertyId}&limit=5`,
          { method: 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
        );
        assert.strictEqual(ownRes.status, 200, `S1 own-property expected 200 got ${ownRes.status}`);
        const ownBody = await ownRes.json().catch(() => null);
        assert.strictEqual(ownBody.status, 'OK', 'S1 own-body.status must be OK');
        assert(Array.isArray(ownBody.data), 'S1 own-body.data must be array');
        pass('S1b', `user of property A, own property A reservation → 200 OK (${ownBody.data.length} entries)`);
      } finally {
        // Fixture teardown is owned by the single global cleanup() at the end
        // of the run, which deletes users before role rows, reports errors,
        // and verifies no residue. The role/user IDs stay in tracking so
        // cleanup() can confirm they are gone — never splice them here even
        // on failure.
      }
    }

    // ── S2: reservation ownership ──
    {
      const res = await getAudit(testPropertyId, resIdB);
      assert(res.status === 403 || res.status === 404, `S2 expected 403/404 got ${res.status}`);
      pass(2, `reservation of another property rejected (${res.status})`);
    }

    // ── S3: entity collision excluded ──
    {
      const res = await getAudit(testPropertyId, resIdA, { limit: 100 });
      assert.strictEqual(res.status, 200);
      for (const e of res.body.data) {
        // If a RESERVATION_GUEST row leaked, its action would surface.
        assert(e.action !== 'GUEST_ADDED', 'S3 RESERVATION_GUEST row leaked');
      }
      assert(!res.body.data.find(e => e.audit_id === guestRowId), 'S3 guest row id must be absent');
      pass(3, `entity collision excluded (${res.body.data.length} rows, no GUEST_ADDED, guest row ${guestRowId} absent)`);
    }

    // ── S4: timestamp tie broken by audit_id DESC ──
    {
      const res = await getAudit(testPropertyId, resIdA, { limit: 100 });
      const idx1 = res.body.data.findIndex(e => e.audit_id === id1); // lower ID
      const idx2 = res.body.data.findIndex(e => e.audit_id === id2); // higher ID
      assert(idx1 !== -1 && idx2 !== -1, 'S4 tie rows present');
      // DESC on (timestamp, audit_id): the higher audit_id at the same timestamp comes FIRST.
      assert(idx2 < idx1, `S4 tie: higher audit_id must come before lower (idx2=${idx2}, idx1=${idx1})`);
      pass(4, `timestamp tie broken by audit_id DESC (id2=${id2} before id1=${id1})`);
    }

    // ── S5: timestamp rules over ID ──
    {
      const res = await getAudit(testPropertyId, resIdA, { limit: 100 });
      const idx3 = res.body.data.findIndex(e => e.audit_id === id3); // t3 higher ts
      const idx2 = res.body.data.findIndex(e => e.audit_id === id2); // t1
      assert(idx3 < idx2, 'S5 higher timestamp must sort first');
      pass(5, 'timestamp DESC dominates over audit_id');
    }

    // ── S6: microsecond keyset pagination, no dup/skip ──
    {
      const all = await getAudit(testPropertyId, resIdA, { limit: 100 });
      const expectedIds = all.body.data.map(e => e.audit_id);

      // Explicitly verify that the .123457 row comes before the .123456 row
      // in the full-order result (higher microsecond = earlier in DESC).
      const idxT6 = expectedIds.indexOf(idT6); // .123457 — earlier
      const idxT5 = expectedIds.indexOf(idT5); // .123456 — later
      assert(idxT6 !== -1 && idxT5 !== -1, 'S6 boundary rows .123456/.123457 must be in expected order');
      assert(idxT6 < idxT5, `S6 .123457 (idx=${idxT6}) must come before .123456 (idx=${idxT5})`);

      let cursor = null, collected = [], pages = 0;
      const MAX_PAGES = 30; // bounded to prevent infinite loops
      while (true) {
        const page = await getAudit(testPropertyId, resIdA, { limit: 2, cursor });
        assert.strictEqual(page.status, 200, 'S6 page fetch failed');
        collected.push(...page.body.data.map(e => e.audit_id));
        pages++;
        if (pages > MAX_PAGES) {
          assert.fail(`S6 pagination exceeded ${MAX_PAGES} pages — possible infinite loop`);
        }
        if (page.body.has_more && page.body.next_cursor) {
          // Verify cursor preserves 6-digit microsecond
          const cursorTsPart = page.body.next_cursor.split('|')[0];
          assert.strictEqual(cursorTsPart.length, 26, `S6 cursor timestamp must be 26 chars, got "${cursorTsPart}" (${cursorTsPart.length})`);
          assert(/\.\d{6}$/.test(cursorTsPart), `S6 cursor must end with 6-digit microsecond, got "${cursorTsPart}"`);
          cursor = page.body.next_cursor;
        } else {
          assert.strictEqual(page.body.next_cursor, null, 'S6 last page next_cursor must be null');
          break;
        }
      }
      assert.deepStrictEqual(collected, expectedIds, 'S6 keyset pages must equal single-shot order, no dup/skip');
      pass(6, `keyset pagination across ${pages} pages matches single-shot (boundary .123456/.123457 microsecond preserved, 6-digit µs in cursor)`);
    }

    // ── S7: invalid cursor variants ──
    {
      const bad = [
        'no-pipe',
        '2030-09-01 10:00:00.000000|',            // empty ID
        '2030-09-01 10:00:00.000000|abc',         // non-numeric ID
        '2030-09-01 10:00:00.000000|12abc',       // suffix junk
        '2030-09-01 10:00:00.000000|0',           // zero ID
        '2030-09-01 10:00:00.000000|-5',          // negative
        '2030-09-01 10:00:00.000000|2147483648',  // > INTEGER max
        '2030-09-01 10:00:00|1',                  // missing microseconds
        '2030-09-01T10:00:00.000000|1',           // ISO 'T' separator
        // Calendar validation (leap-year aware, day-per-month):
        '2030-13-01 10:00:00.000000|1',           // month 13
        '2030-04-31 10:00:00.000000|1',           // April 31 — no such day
        '2030-02-30 10:00:00.000000|1',           // Feb 30 — no such day
        '2030-02-31 10:00:00.000000|1',           // Feb 31 — no such day
        '2023-02-29 10:00:00.000000|1',           // Feb 29 in non-leap year
        '2024-02-30 10:00:00.000000|1',           // Feb 30 in leap year
        '0000-06-15 10:00:00.000000|1',           // year 0000 (not AD)
        '2030-06-31 10:00:00.000000|1',           // June 31
        '2030-09-31 10:00:00.000000|1',           // September 31 — no such day (Sept has 30)
        '2030-09-32 10:00:00.000000|1',           // day 32
        '2030-01-00 10:00:00.000000|1',           // day 0
        '2030-09-01 24:00:00.000000|1',           // hour 24
        '2030-09-01 10:60:00.000000|1',           // minute 60
        '2030-09-01 10:00:60.000000|1',           // second 60
        `${t1}|${id1}|junk`,                      // double pipe junk suffix
        `${t1}0|1`,                                // 7-digit microseconds
        `${t1.replace(/\.0+$/, '')}0|1`,           // 5-digit microseconds
      ];
      for (const c of bad) {
        const res = await getAudit(testPropertyId, resIdA, { cursor: c });
        assert.strictEqual(res.status, 400, `S7 cursor "${c}" expected 400 got ${res.status}`);
        assert.strictEqual(res.body.code, 'INVALID_CURSOR', `S7 "${c}" code`);
      }
      // Feb 29 in a LEAP year (2024) is VALID and must be accepted
      {
        const okLeap = await getAudit(testPropertyId, resIdA, { cursor: '2024-02-29 10:00:00.000000|1' });
        assert.strictEqual(okLeap.status, 200, `S7 valid Feb 29 leap-year cursor got ${okLeap.status}`);
      }
      // Valid-format but arbitrary cursor must still be ACCEPTED (keyset just returns rows after it)
      const okRes = await getAudit(testPropertyId, resIdA, { cursor: `${t1}|999999999` });
      assert.strictEqual(okRes.status, 200, 'S7 well-formed cursor must be accepted');
      pass(7, `${bad.length} invalid cursor variants rejected; Feb 29 leap + well-formed accepted`);
    }

    // ── S8: invalid limit variants ──
    {
      const bad = ['0', '-1', '101', 'abc', '1.5', ' 5', '5 ', '2e1', 'null'];
      for (const l of bad) {
        const res = await getAudit(testPropertyId, resIdA, { limit: l });
        assert.strictEqual(res.status, 400, `S8 limit "${l}" expected 400 got ${res.status}`);
        assert.strictEqual(res.body.code, 'INVALID_LIMIT', `S8 limit "${l}" code`);
      }
      for (const l of ['1', '30', '100']) {
        const res = await getAudit(testPropertyId, resIdA, { limit: l });
        assert.strictEqual(res.status, 200, `S8 valid limit "${l}" expected 200 got ${res.status}`);
      }
      pass(8, `${bad.length} invalid limit values rejected; 1/30/100 accepted`);
    }

    // ── S9: invalid JSON new_value does not break response ──
    {
      const res = await getAudit(testPropertyId, resIdA, { limit: 100 });
      assert.strictEqual(res.status, 200);
      const bad = res.body.data.find(e => e.audit_id === badJsonRow.rows[0].audit_id);
      assert(bad, 'S9 invalid-JSON row must still be returned');
      assert.strictEqual(bad.summary, 'Reservasi diperbarui', `S9 got "${bad.summary}"`);
      pass(9, 'invalid JSON new_value handled gracefully (generic summary)');
    }

    // ── S10: actor derivation ──
    {
      const res = await getAudit(testPropertyId, resIdA, { limit: 100 });
      const withSnapshot = res.body.data.find(e => e.audit_id === id2);
      assert.strictEqual(withSnapshot.actor, 'Rina Front Office', `S10 snapshot expected, got "${withSnapshot.actor}"`);
      const idOnly = res.body.data.find(e => e.audit_id === id3);
      assert.strictEqual(idOnly.actor, 'Tidak tercatat', `S10 ID-only row must not show ID as name, got "${idOnly.actor}"`);
      pass(10, 'actor: snapshot name preferred; actor_user_id never displayed');
    }

    // ── S11: redaction ──
    {
      const res = await getAudit(testPropertyId, resIdA, { limit: 100 });
      const raw = JSON.stringify(res.body);
      const secrets = ['081234567890', '3273010101990001', '/uploads/ktp/', '081999999999', 'new_value', 'correlation_id', 'actor_user_id'];
      for (const s of secrets) {
        assert(!raw.includes(s), `S11 leaked "${s}"`);
      }
      const dtoKeys = Object.keys(res.body.data[0]).sort();
      assert.deepStrictEqual(dtoKeys, ['action', 'actor', 'audit_id', 'formatted_time', 'module', 'summary'], `S11 DTO keys: ${dtoKeys}`);
      pass(11, 'redaction: PII / new_value / correlation_id / actor_user_id absent from response');
    }

    // ── S12: reservation ID validation ──
    {
      for (const badId of ['abc', '0', '-3', '1.5', '99999999999999999999']) {
        const res = await getAudit(testPropertyId, badId);
        assert.strictEqual(res.status, 400, `S12 id "${badId}" expected 400 got ${res.status}`);
      }
      pass(12, 'non-integer / non-positive reservation IDs rejected 400');
    }

    // ── S13: has_more + next_cursor correctness ──
    {
      const p1 = await getAudit(testPropertyId, resIdA, { limit: 2 });
      assert.strictEqual(p1.body.has_more, true, 'S13 page1 has_more');
      assert(p1.body.next_cursor, 'S13 page1 next_cursor');
      const last = await getAudit(testPropertyId, resIdA, { limit: 100 });
      assert.strictEqual(last.body.has_more, false, 'S13 full page has_more=false');
      assert.strictEqual(last.body.next_cursor, null, 'S13 last page next_cursor=null');
      pass(13, 'has_more / next_cursor(null on last page) correct');
    }

    // ── S14: response shape ──
    {
      const res = await getAudit(testPropertyId, resIdA, { limit: 2 });
      assert.strictEqual(res.body.status, 'OK');
      assert(Array.isArray(res.body.data), 'S14 data must be plain array');
      assert('has_more' in res.body, 'S14 has_more at top level');
      assert('next_cursor' in res.body, 'S14 next_cursor at top level');
      // Own property 'entries' must not exist (Array.prototype.entries is inherited, not own)
      assert.strictEqual(Object.prototype.hasOwnProperty.call(res.body.data, 'entries'), false,
        'S14 data must NOT carry data.entries nesting');
      pass(14, 'response shape {status, data:[DTO], has_more, next_cursor}');
    }

    // ── Frontend state-machine tests are now in the frontend hook suite
    //    (frontend/src/features/calendar/__tests__/useAuditLog.test.ts).
    //    No standalone copy lives in this backend test file.

  } catch (err) {
    fail(-1, 'unexpected error', err);
  } finally {
    await teardown();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

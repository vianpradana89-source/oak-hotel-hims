/**
 * POS Communication Settings ΓÇö focused integration test.
 *
 * Real app/JWT/RBAC against disposable oak_minibar_test ONLY.
 * No dotenv reads. Requires TEST_DATABASE_URL matching the disposable guard.
 *
 * Usage (from backend/):
 *   TEST_DATABASE_URL=postgres://minibar_test:***@127.0.0.1:15434/oak_minibar_test \
 *     node test/pos_communication_settings_endpoint_test.js
 */
'use strict';
const crypto = require('crypto');
const run = crypto.randomBytes(6).toString('hex');
let target;
try {
  const u = new URL((process.env.TEST_DATABASE_URL || '').trim());
  target = {
    host: u.hostname,
    port: Number(u.port),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
  };
  if (
    !['postgres:', 'postgresql:'].includes(u.protocol) || u.search || u.hash ||
    target.host !== '127.0.0.1' || target.port !== 15434 ||
    target.user !== 'minibar_test' || target.database !== 'oak_minibar_test' || !target.password
  ) throw new Error();
} catch (_) {
  console.error('SAFETY: TEST_DATABASE_URL tidak sesuai target disposable.');
  process.exit(1);
}
// Block transitive dotenv/config imports before loading the production app.
const dotenv = require('dotenv');
dotenv.config = () => ({ parsed: {} });
dotenv.configDotenv = () => ({ parsed: {} });
const dc = require.resolve('dotenv/config');
require.cache[dc] = { id: dc, filename: dc, loaded: true, exports: {} };
Object.assign(process.env, {
  DB_HOST: target.host,
  DB_PORT: String(target.port),
  DB_USER: target.user,
  DB_PASSWORD: target.password,
  DB_NAME: target.database,
  RUN_SCHEMA_INITIALIZATION: 'false',
  JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});

const { app, pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');
const { setRoleAccess, ACCESS_RESOURCES } = require('../dist/domains/settings/accessControlService');
const http = require('http');

const fixtures = [];
const failures = [];
let passed = 0;

function check(label, cond) {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else { failures.push(label); console.error('  FAIL  ' + label); }
}
function problem(label, e) {
  const msg = label + ': ' + String(e && e.message || e);
  failures.push(msg);
  console.error('[ERROR] ' + msg);
}

async function identity(c) {
  for (const k of ['host', 'port', 'user', 'database'])
    if (String(pool.options[k]) !== String(target[k]))
      throw new Error('pool.options tidak sesuai: ' + k);
  const r = (await c.query('SELECT current_database() AS db, current_user AS usr')).rows[0];
  if (r.db !== target.database || r.usr !== target.user)
    throw new Error('identitas DB tidak sesuai');
}

async function property(c, label) {
  const r = await c.query(
    `INSERT INTO properties(name, property_code, timezone, currency_code, is_active)
     VALUES($1, $2, 'Asia/Jakarta', 'IDR', TRUE) RETURNING id`,
    ['Comm Settings ' + label + ' ' + run, crypto.randomBytes(3).toString('hex').toUpperCase()]
  );
  const f = { p: Number(r.rows[0].id), roles: [], users: [] };
  fixtures.push(f);
  return f;
}

function grid(resource, view, edit) {
  const g = {};
  for (const r of ACCESS_RESOURCES) g[r.key] = { view: false, edit: false, delete: false };
  g[resource] = { view, edit, delete: false };
  return g;
}

async function makeUser(c, f, label, resource, view, edit) {
  const roleId = Number((await c.query(
    `INSERT INTO roles(property_id, name, is_active, is_system_role, is_test_data)
     VALUES($1, $2, TRUE, FALSE, TRUE) RETURNING id`,
    [f.p, 'CommSettings ' + label + ' ' + run]
  )).rows[0].id);
  f.roles.push(roleId);
  await setRoleAccess(c, f.p, roleId, grid(resource, view, edit),
    { id: 0, name: 'Settings fixture', property_id: f.p, is_platform_super_admin: false });
  const username = 'cmtg_' + label + '_' + run;
  const uid = Number((await c.query(
    `INSERT INTO users(property_id, role_id, username, email, full_name, is_active, is_test_data, account_status, must_change_password, access_type)
     VALUES($1, $2, $3, $4, $5, TRUE, TRUE, 'READY', FALSE, 'PMS_STAFF') RETURNING id`,
    [f.p, roleId, username, username + '@test.local', 'Comm ' + label]
  )).rows[0].id);
  f.users.push(uid);
  return {
    id: uid,
    username,
    token: generateToken({
      id: uid, property_id: f.p, role_id: roleId,
      email: username + '@test.local', username,
      full_name: 'Comm ' + label,
      role: 'Comm Settings Fixture', scope: 'FULL',
      account_status: 'READY', must_change_password: false, access_type: 'PMS_STAFF',
    }),
  };
}

async function req(port, url, method, token, body) {
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  let payload;
  if (body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const r = await fetch('http://127.0.0.1:' + port + url,
    { method, headers, body: payload, signal: AbortSignal.timeout(15000) });
  const type = r.headers.get('content-type') || '';
  return {
    status: r.status,
    type,
    body: type.includes('application/json') ? await r.json() : null,
  };
}

/**
 * pg returns TIMESTAMP columns as JS Date objects; strict Date===Date is
 * always false, so compare in milliseconds.
 */
function ts(v) {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.getTime() : Date.parse(String(v));
}

async function snapshot(c) {
  const ps = fixtures.map(f => f.p);
  const out = {};
  for (const table of ['property_pos_communication_settings', 'audit_logs']) {
    const rows = (await c.query(
      `SELECT * FROM ${table} WHERE property_id = ANY($1::int[])`, [ps]
    )).rows;
    out[table] = rows.map(r => JSON.stringify(r)).sort();
  }
  return JSON.stringify(out);
}

async function rejected(c, port, url, method, token, body, status, code, label) {
  const before = await snapshot(c);
  const r = await req(port, url, method, token, body);
  check(label + ' status/code', r.status === status && (!code || r.body?.code === code));
  check(label + ' state tetap', before === await snapshot(c));
  check(label + ' tanpa data', !r.body?.data);
}

async function dropAuditTrigger(c) {
  try {
    await c.query(`DROP TRIGGER IF EXISTS comm_settings_audit_block ON audit_logs`);
    await c.query(`DROP FUNCTION IF EXISTS comm_settings_audit_block()`);
  } catch (e) {
    console.error('[WARN] dropAuditTrigger:', e.message);
  }
}

async function clean(c, f) {
  await c.query('BEGIN');
  try {
    await dropAuditTrigger(c);
    await c.query(`DELETE FROM property_pos_communication_settings WHERE property_id=$1`, [f.p]);
    await c.query(`DELETE FROM audit_logs WHERE property_id=$1`, [f.p]);
    await c.query(`DELETE FROM user_permission_overrides WHERE property_id=$1 AND user_id=ANY($2::int[])`, [f.p, f.users]);
    await c.query(`DELETE FROM users WHERE property_id=$1 AND id=ANY($2::int[])`, [f.p, f.users]);
    await c.query(`DELETE FROM roles WHERE property_id=$1 AND id=ANY($2::int[])`, [f.p, f.roles]);
    await c.query(`DELETE FROM properties WHERE id=$1`, [f.p]);
    await c.query('COMMIT');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (rb) { e.discardClient = true; problem('cleanup rollback ' + f.p, rb); }
    throw e;
  }
}

async function residue(c) {
  const ps = fixtures.map(f => f.p);
  const roles = fixtures.flatMap(f => f.roles);
  const tables = ['property_pos_communication_settings', 'audit_logs', 'users', 'roles', 'user_permission_overrides'];
  for (const table of tables) {
    const n = Number((await c.query(
      `SELECT COUNT(*) AS n FROM ${table} WHERE property_id=ANY($1::int[])`, [ps]
    )).rows[0].n);
    check('Residue ' + table + '=0', n === 0);
  }
  check('Residue properties=0',
    Number((await c.query(`SELECT COUNT(*) AS n FROM properties WHERE id=ANY($1::int[])`, [ps])).rows[0].n) === 0);
  check('Residue role_permissions=0',
    Number((await c.query(`SELECT COUNT(*) AS n FROM role_permissions WHERE role_id=ANY($1::int[])`, [roles])).rows[0].n) === 0);
}

function release(c, label, discard = false) {
  if (c) try { c.release(discard); } catch (e) { problem(label + ' release', e); }
}

async function main() {
  let c = null, server = null, verified = false;
  console.log('[POS COMMUNICATION SETTINGS TEST] oak_minibar_test/minibar_test @ 127.0.0.1:15434');
  try {
    c = await pool.connect();
    await identity(c);
    verified = true;

    // Prerequisite: table exists (A1 migration applied)
    await c.query('SELECT whatsapp_enabled FROM property_pos_communication_settings LIMIT 0');
    const perms = (await c.query(
      "SELECT key FROM permissions WHERE key=ANY($1::text[])",
      [['settings.view', 'settings.edit']]
    )).rows;
    if (perms.length !== 2) throw new Error('Settings permissions prerequisite tidak lengkap');
    console.log('[IDENTITY/SCHEMA] terverifikasi.');

    const a = await property(c, 'A');
    const b = await property(c, 'B');

    // adminA: Pengaturan view+edit  ΓåÆ full access
    // viewerA: Pengaturan view only  ΓåÆ GET ok, PUT 403
    // cashierA: POS view only        ΓåÆ GET 200 (C2B-0), PUT 403
    // restrictedA: Housekeeping only (no POS/Pengaturan/Dokumen view) ΓåÆ GET 403
    // adminB: Pengaturan view+edit on property B ΓåÆ isolation tests
    const adminA = await makeUser(c, a, 'adminA', 'Pengaturan', true, true);
    const viewerA = await makeUser(c, a, 'viewerA', 'Pengaturan', true, false);
    const cashierA = await makeUser(c, a, 'cashierA', 'POS', true, false);
    const restrictedA = await makeUser(c, a, 'restrictedA', 'Housekeeping', true, false);
    const adminB = await makeUser(c, b, 'adminB', 'Pengaturan', true, true);

    server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;

    const url = '/api/pos/communication-settings';
    const urlA = url + '?property_id=' + a.p;
    const urlB = url + '?property_id=' + b.p;

    // ΓöÇΓöÇ 401: no JWT ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    await rejected(c, port, urlA, 'GET', null, null, 401, 'UNAUTHORIZED', 'GET tanpa JWT');
    await rejected(c, port, urlA, 'PUT', null, { property_id: a.p, whatsapp_enabled: false }, 401, null, 'PUT tanpa JWT');

    // ΓöÇΓöÇ Permission gates ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    // Cashier (POS view only, no Pengaturan/Dokumen&Print view) ΓåÆ GET 200 (C2B-0)
    const cashierGet = await req(port, urlA, 'GET', cashierA.token);
    check('Kasir POS:view dapat GET communication settings',
      cashierGet.status === 200 &&
      cashierGet.body?.data?.whatsapp_enabled === true);
    // Cashier (POS view only) ΓåÆ PUT 403 (only Pengaturan:edit can write)
    await rejected(c, port, urlA, 'PUT', cashierA.token, { property_id: a.p, whatsapp_enabled: false }, 403, 'FORBIDDEN', 'PUT tanpa Pengaturan:edit (cashierA)');
    // Restricted (Housekeeping only, no POS/Pengaturan/Dokumen view) ΓåÆ GET 403
    await rejected(c, port, urlA, 'GET', restrictedA.token, null, 403, 'FORBIDDEN', 'GET tanpa POS/Pengaturan/Dokumen view');
    // Viewer (no edit) ΓåÆ PUT 403
    await rejected(c, port, urlA, 'PUT', viewerA.token, { property_id: a.p, whatsapp_enabled: false }, 403, 'FORBIDDEN', 'PUT tanpa Pengaturan:edit');
    // Cross-property: adminB trying property A ΓåÆ 403 PROPERTY_SCOPE_REQUIRED
    await rejected(c, port, urlA, 'GET', adminB.token, null, 403, 'PROPERTY_SCOPE_REQUIRED', 'GET cross-property adminBΓåÆA');
    await rejected(c, port, urlA, 'PUT', adminB.token, { property_id: a.p, whatsapp_enabled: false }, 403, 'PROPERTY_SCOPE_REQUIRED', 'PUT cross-property adminBΓåÆA');
    // Cross-property: cashierA (POS property A) trying property B ΓåÆ 403 PROPERTY_SCOPE_REQUIRED
    await rejected(c, port, urlB, 'GET', cashierA.token, null, 403, 'PROPERTY_SCOPE_REQUIRED', 'GET cross-property cashierA(A)ΓåÆB');

    // ΓöÇΓöÇ Validation rejects ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    // whatsapp_enabled as string
    await rejected(c, port, urlA, 'PUT', adminA.token,
      { property_id: a.p, whatsapp_enabled: 'false' }, 400, 'VALIDATION_ERROR', 'whatsapp_enabled string ditolak');
    // intro > 500 chars
    await rejected(c, port, urlA, 'PUT', adminA.token,
      { property_id: a.p, whatsapp_intro_message: 'x'.repeat(501) }, 400, 'VALIDATION_ERROR', 'intro >500 ditolak');
    // closing > 500 chars
    await rejected(c, port, urlA, 'PUT', adminA.token,
      { property_id: a.p, whatsapp_closing_message: 'y'.repeat(501) }, 400, 'VALIDATION_ERROR', 'closing >500 ditolak');
    // unknown field
    await rejected(c, port, urlA, 'PUT', adminA.token,
      { property_id: a.p, unknown_field: 'x' }, 400, 'VALIDATION_ERROR', 'field unknown ditolak');
    // whatsapp_intro_message as number
    await rejected(c, port, urlA, 'PUT', adminA.token,
      { property_id: a.p, whatsapp_intro_message: 12345 }, 400, 'VALIDATION_ERROR', 'intro non-string ditolak');

    // ΓöÇΓöÇ GET default (no row yet) ΓåÆ canonical defaults, no INSERT ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    const defaults = await req(port, urlA, 'GET', adminA.token);
    check('GET tanpa row: default enabled=true, pesan null',
      defaults.status === 200 &&
      defaults.body?.data?.whatsapp_enabled === true &&
      defaults.body?.data?.whatsapp_intro_message === null &&
      defaults.body?.data?.whatsapp_closing_message === null);
    const rowCountAfterGet = Number((await c.query(
      `SELECT COUNT(*) AS n FROM property_pos_communication_settings WHERE property_id=$1`, [a.p]
    )).rows[0].n);
    check('GET tidak membuat row DB', rowCountAfterGet === 0);

    // ΓöÇΓöÇ PUT create ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    const putCreate = await req(port, urlA, 'PUT', adminA.token, {
      property_id: a.p,
      whatsapp_enabled: false,
      whatsapp_intro_message: '  Halo, Selamat datang!  ',
      whatsapp_closing_message: null,
    });
    check('PUT create: 200 OK, trim efektif',
      putCreate.status === 200 &&
      putCreate.body?.data?.whatsapp_enabled === false &&
      putCreate.body?.data?.whatsapp_intro_message === 'Halo, Selamat datang!' &&
      putCreate.body?.data?.whatsapp_closing_message === null);

    const createdRow = (await c.query(
      `SELECT * FROM property_pos_communication_settings WHERE property_id=$1`, [a.p]
    )).rows[0];
    check('Row tersimpan: whatsapp_enabled=false, intro trimmed',
      createdRow &&
      createdRow.whatsapp_enabled === false &&
      createdRow.whatsapp_intro_message === 'Halo, Selamat datang!' &&
      createdRow.whatsapp_closing_message === null);
    check('updated_by dari JWT username', createdRow?.updated_by === adminA.username);
    check('created_at Γëê updated_at pada row baru',
      createdRow && Math.abs(new Date(createdRow.created_at) - new Date(createdRow.updated_at)) < 5000);

    // GET after create ΓåÆ returns saved values
    const afterGet = await req(port, urlA, 'GET', viewerA.token);
    check('GET setelah create: nilai tersimpan terbaca',
      afterGet.status === 200 &&
      afterGet.body?.data?.whatsapp_enabled === false &&
      afterGet.body?.data?.whatsapp_intro_message === 'Halo, Selamat datang!');

    // Audit written on create
    const auditAfterCreate = (await c.query(
      `SELECT * FROM audit_logs WHERE property_id=$1 AND module='POS_COMMUNICATION'
       AND action='POS_COMMUNICATION_SETTINGS_UPDATED' ORDER BY audit_id DESC LIMIT 1`, [a.p]
    )).rows[0];
    check('Audit log ditulis setelah PUT create',
      auditAfterCreate &&
      auditAfterCreate.record_id === String(a.p) &&
      auditAfterCreate.actor_user_id === String(adminA.id));

    // ΓöÇΓöÇ PUT update ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    const beforeUpdate = (await c.query(
      `SELECT created_at, updated_at FROM property_pos_communication_settings WHERE property_id=$1`, [a.p]
    )).rows[0];
    const beforeCreatedAt = ts(beforeUpdate.created_at);
    const beforeUpdatedAt = ts(beforeUpdate.updated_at);
    await new Promise(r => setTimeout(r, 1100)); // ensure updated_at differs

    const putUpdate = await req(port, urlA, 'PUT', adminA.token, {
      property_id: a.p,
      whatsapp_closing_message: 'Terima kasih telah berbelanja!',
    });
    check('PUT update: closing tersimpan, enabled tetap false (merge)',
      putUpdate.status === 200 &&
      putUpdate.body?.data?.whatsapp_enabled === false &&
      putUpdate.body?.data?.whatsapp_closing_message === 'Terima kasih telah berbelanja!' &&
      putUpdate.body?.data?.whatsapp_intro_message === 'Halo, Selamat datang!');

    const afterUpdate = (await c.query(
      `SELECT created_at, updated_at, whatsapp_closing_message FROM property_pos_communication_settings WHERE property_id=$1`, [a.p]
    )).rows[0];
    check('created_at tidak berubah saat update',
      ts(afterUpdate.created_at) === beforeCreatedAt);
    check('updated_at diperbarui saat PUT',
      ts(afterUpdate.updated_at) !== beforeUpdatedAt && ts(afterUpdate.updated_at) > beforeUpdatedAt);

    // ΓöÇΓöÇ Audit failure ΓåÆ full rollback ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    // BEFORE INSERT trigger on audit_logs raises for POS_COMMUNICATION + property A.
    // Simulates audit write failure; the settings upsert must roll back entirely.
    await c.query(
      `CREATE OR REPLACE FUNCTION comm_settings_audit_block()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.property_id = ${a.p} AND NEW.module = 'POS_COMMUNICATION' THEN
           RAISE EXCEPTION 'audit blocked (test fixture)';
         END IF;
         RETURN NEW;
       END $$`
    );
    await c.query(
      `CREATE TRIGGER comm_settings_audit_block
       BEFORE INSERT ON audit_logs
       FOR EACH ROW EXECUTE FUNCTION comm_settings_audit_block()`
    );

    const auditFail = await req(port, urlA, 'PUT', adminA.token, {
      property_id: a.p,
      whatsapp_intro_message: 'SHOULD NOT BE SAVED',
    });
    check('Audit gagal ΓåÆ 500 INTERNAL_ERROR',
      auditFail.status === 500 && auditFail.body?.code === 'INTERNAL_ERROR');

    // Rollback verification: intro must still be the pre-attempt value
    const afterRollback = (await c.query(
      `SELECT whatsapp_intro_message FROM property_pos_communication_settings WHERE property_id=$1`, [a.p]
    )).rows[0];
    check('Rollback: intro tidak berubah setelah audit gagal',
      afterRollback?.whatsapp_intro_message === 'Halo, Selamat datang!');

    // No orphan audit row for the rolled-back attempt
    const orphanAudit = Number((await c.query(
      `SELECT COUNT(*) AS n FROM audit_logs
       WHERE property_id=$1 AND module='POS_COMMUNICATION'
         AND new_value LIKE '%SHOULD NOT BE SAVED%'`, [a.p]
    )).rows[0].n);
    check('Rollback: tidak ada audit row yatim', orphanAudit === 0);

    await dropAuditTrigger(c);

    // ΓöÇΓöÇ Property isolation ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    // adminB writes property B settings; verify B is independent of A
    const putB = await req(port, urlB, 'PUT', adminB.token, {
      property_id: b.p,
      whatsapp_enabled: true,
      whatsapp_intro_message: 'Property B greeting',
      whatsapp_closing_message: 'Property B farewell',
    });
    check('Property B PUT create berhasil', putB.status === 200 && putB.body?.data?.whatsapp_intro_message === 'Property B greeting');

    const getA = await req(port, urlA, 'GET', adminA.token);
    check('Isolasi: GET property A tidak terpengaruh oleh B',
      getA.status === 200 && getA.body?.data?.whatsapp_intro_message === 'Halo, Selamat datang!');

    const getB = await req(port, urlB, 'GET', adminB.token);
    check('Isolasi: GET property B mengembalikan nilai B',
      getB.status === 200 && getB.body?.data?.whatsapp_intro_message === 'Property B greeting');

    // B's audit row is also stored
    const auditB = (await c.query(
      `SELECT * FROM audit_logs WHERE property_id=$1 AND module='POS_COMMUNICATION' AND action='POS_COMMUNICATION_SETTINGS_UPDATED'`, [b.p]
    )).rows;
    check('Property B: audit log tersimpan', auditB.length >= 1);

    // ΓöÇΓöÇ Empty-string normalization (PUT with whitespace intro) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    const putEmpty = await req(port, urlB, 'PUT', adminB.token, {
      property_id: b.p,
      whatsapp_intro_message: '   ',
    });
    check('Intro whitespace-only dinormalisasi ke null',
      putEmpty.status === 200 && putEmpty.body?.data?.whatsapp_intro_message === null);

    // ΓöÇΓöÇ Property not found / cross-access (403) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    // Use a valid integer property_id that does not exist in properties table.
    // run is a hex string ΓåÆ parseInt(..., 16); range [1000000, 1999998] avoids
    // collision with the small ids used by real properties in the shared DB.
    const missingProp = 1000000 + (parseInt(run.slice(-6), 16) % 999999);
    const missingRes = await req(port, url + '?property_id=' + missingProp, 'GET', adminA.token);
    check('GET property_id tidak ada/akses lintas ΓåÆ 403 PROPERTY_SCOPE_REQUIRED',
      missingRes.status === 403 && missingRes.body?.code === 'PROPERTY_SCOPE_REQUIRED');

  } catch (e) {
    problem('main', e);
  } finally {
    if (server) {
      try { await new Promise((resolve, reject) => server.close(e2 => e2 ? reject(e2) : resolve())); }
      catch (e2) { problem('server.close', e2); }
    }
    release(c, 'main', true);
    c = null;

    if (verified) {
      for (const f of fixtures) {
        let cc = null, bad = false;
        try {
          cc = await pool.connect();
          await identity(cc);
          await clean(cc, f);
        } catch (e) {
          bad = Boolean(e.discardClient);
          problem('cleanup ' + f.p, e);
        } finally { release(cc, 'cleanup', bad); }
      }
      let rc = null;
      try {
        rc = await pool.connect();
        await identity(rc);
        await residue(rc);
      } catch (e) { problem('residue', e); }
      finally { release(rc, 'residue'); }
    }
    try { await pool.end(); } catch (e) { problem('pool.end', e); }
  }

  console.log('\n[RESULT] ' + passed + ' PASS, ' + failures.length + ' FAIL');
  for (const f of failures) console.error('  - ' + f);
  if (!failures.length) console.log('[CLEANUP/RESIDUE] 0 ΓÇö seluruh fixture bersih.');
  process.exitCode = failures.length ? 1 : 0;
}

main().catch(e => {
  console.error('[CRASH]', e.message);
  process.exitCode = 1;
});

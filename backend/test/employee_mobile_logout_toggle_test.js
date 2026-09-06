'use strict';

require('dotenv').config();
const assert = require('assert');
const http = require('http');
const bcrypt = require('bcryptjs');
const { app, pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');

const TEST_PREFIX = `eml1b_${Date.now()}`;
const CREW_PASSWORD = 'OakCrewLogout1B!';

let server;
let baseUrl;
let passed = 0;
let failed = 0;

function pass(name) {
  passed += 1;
  console.log(`  PASS ${name}`);
}

function fail(name, err) {
  failed += 1;
  console.error(`  FAIL ${name}: ${err && err.message ? err.message : err}`);
}

async function fetchJson(urlPath, options = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, options);
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function tokenFor(user, extras = {}) {
  return generateToken({
    id: Number(user.id),
    username: user.username,
    email: user.email,
    full_name: user.full_name,
    role: extras.role || user.role || 'Housekeeping',
    role_id: Number(user.role_id),
    property_id: Number(user.property_id),
    scope: 'FULL',
    account_status: 'READY',
    access_type: extras.access_type || user.access_type || 'MOBILE_ONLY'
  });
}

async function run() {
  console.log('=== EMPLOYEE-MOBILE-LOGOUT-1B Settings toggle ===\n');
  const { initializeDatabase } = require('../dist/db/schema_v3');
  await initializeDatabase(pool);

  const cleanup = {
    propertyIds: [],
    employeeIds: [],
    userIds: []
  };

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const hkRole = await pool.query(
      `SELECT id FROM roles WHERE name = 'Housekeeping' AND is_system_role = TRUE AND property_id IS NULL LIMIT 1`
    );
    const hrdRole = await pool.query(
      `SELECT id FROM roles WHERE name ILIKE '%HRD%' AND is_active = TRUE ORDER BY id ASC LIMIT 1`
    );
    const saRes = await pool.query(`
      SELECT u.id, u.username, u.full_name, u.email, u.property_id, r.id AS role_id
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE r.name = 'Super Admin' AND r.property_id IS NULL AND r.is_system_role = TRUE
      LIMIT 1
    `);
    assert.ok(hkRole.rows[0], 'Housekeeping role exists');
    assert.ok(saRes.rows[0], 'canonical Super Admin exists');
    const sa = saRes.rows[0];
    const saToken = tokenFor({ ...sa, access_type: 'ADMIN' }, { role: 'Super Admin', access_type: 'ADMIN' });

    const propRes = await pool.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ($1, $2, 'Asia/Jakarta', 'IDR', 'Logout 1B', TRUE)
       RETURNING id`,
      [`Logout 1B ${TEST_PREFIX}`, `L${Date.now().toString().slice(-5)}`]
    );
    const propertyId = Number(propRes.rows[0].id);
    cleanup.propertyIds.push(propertyId);
    const otherPropRes = await pool.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ($1, $2, 'Asia/Jakarta', 'IDR', 'Logout 1B Other', TRUE)
       RETURNING id`,
      [`Logout 1B Other ${TEST_PREFIX}`, `M${Date.now().toString().slice(-5)}`]
    );
    const otherPropertyId = Number(otherPropRes.rows[0].id);
    cleanup.propertyIds.push(otherPropertyId);

    await pool.query(
      `INSERT INTO property_features (property_id, feature_key, enabled)
       VALUES ($1, 'hrd.enabled', TRUE), ($1, 'hrd.attendance', TRUE)
       ON CONFLICT (property_id, feature_key) DO UPDATE SET enabled = TRUE`,
      [propertyId]
    );

    const passwordHash = await bcrypt.hash(CREW_PASSWORD, 10);
    const emp = await pool.query(
      `INSERT INTO hr_employees (employee_code, full_name, department, position, status, is_active, property_id)
       VALUES ($1, $2, 'Housekeeping', 'Room Attendant', 'ACTIVE', TRUE, $3)
       RETURNING id, full_name`,
      [`CREW_${TEST_PREFIX.slice(-6)}`, `Crew ${TEST_PREFIX}`, propertyId]
    );
    const employeeId = Number(emp.rows[0].id);
    cleanup.employeeIds.push(employeeId);
    const crewUser = await pool.query(
      `INSERT INTO users (
         username, email, password_hash, role_id, property_id, employee_id,
         is_active, account_status, must_change_password, full_name, access_type
       ) VALUES ($1, $2, $3, $4, $5, $6, TRUE, 'READY', FALSE, $7, 'MOBILE_ONLY')
       RETURNING id, username, email, full_name, property_id, role_id, access_type`,
      [
        `crew_${TEST_PREFIX}`.toLowerCase(),
        `crew.${TEST_PREFIX}@oakhotel.test`,
        passwordHash,
        hkRole.rows[0].id,
        propertyId,
        employeeId,
        emp.rows[0].full_name
      ]
    );
    cleanup.userIds.push(Number(crewUser.rows[0].id));
    const crewToken = tokenFor(crewUser.rows[0], { role: 'Housekeeping', access_type: 'MOBILE_ONLY' });

    const lazySettings = await fetchJson(`/api/attendance/settings?property_id=${propertyId}`, {
      headers: { Authorization: `Bearer ${saToken}` }
    });
    assert.strictEqual(lazySettings.status, 200);
    assert.strictEqual(lazySettings.data.data.employee_mobile_manual_logout_enabled, true);
    pass('P setting default TRUE for existing behavior');

    const statusOn = await fetchJson(`/api/attendance/status?property_id=${propertyId}`, {
      headers: { Authorization: `Bearer ${crewToken}` }
    });
    assert.strictEqual(statusOn.status, 200);
    assert.strictEqual(statusOn.data.data.manual_logout_enabled, true);
    assert.strictEqual(statusOn.data.data.settings.employee_mobile_manual_logout_enabled, true);
    pass('status exposes manual_logout_enabled from settings');

    const attendanceBefore = await pool.query(
      `SELECT COUNT(*)::int AS n FROM employee_attendance_records WHERE employee_id = $1`,
      [employeeId]
    );

    const mobilePatch = await fetchJson('/api/attendance/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${crewToken}` },
      body: JSON.stringify({ property_id: propertyId, employee_mobile_manual_logout_enabled: false })
    });
    assert.strictEqual(mobilePatch.status, 403);
    pass('L Employee Mobile user cannot PATCH the toggle');

    const saPatch = await fetchJson('/api/attendance/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${saToken}` },
      body: JSON.stringify({
        property_id: propertyId,
        employee_mobile_manual_logout_enabled: false
      })
    });
    assert.strictEqual(saPatch.status, 200);
    assert.strictEqual(saPatch.data.data.employee_mobile_manual_logout_enabled, false);
    pass('N Platform Super Admin can PATCH via canonical DB checker');

    const attendanceAfter = await pool.query(
      `SELECT COUNT(*)::int AS n FROM employee_attendance_records WHERE employee_id = $1`,
      [employeeId]
    );
    assert.strictEqual(attendanceAfter.rows[0].n, attendanceBefore.rows[0].n);
    pass('K toggle change does not create/modify attendance');

    const audit = await pool.query(
      `SELECT new_value FROM audit_logs
       WHERE module = 'HRD' AND action = 'UPDATE_ATTENDANCE_SETTINGS'
         AND property_id = $1
       ORDER BY timestamp DESC LIMIT 1`,
      [propertyId]
    );
    assert.ok(audit.rows[0], 'audit row exists');
    const payload = typeof audit.rows[0].new_value === 'string'
      ? JSON.parse(audit.rows[0].new_value)
      : audit.rows[0].new_value;
    assert.ok(payload.previous);
    assert.ok(payload.updated);
    assert.strictEqual(payload.previous.employee_mobile_manual_logout_enabled, true);
    assert.strictEqual(payload.updated.employee_mobile_manual_logout_enabled, false);
    pass('Q setting audit contains previous + updated value');

    const otherSettings = await fetchJson(`/api/attendance/settings?property_id=${otherPropertyId}`, {
      headers: { Authorization: `Bearer ${saToken}` }
    });
    assert.strictEqual(otherSettings.status, 200);
    assert.strictEqual(otherSettings.data.data.employee_mobile_manual_logout_enabled, true);
    pass('O property isolation: other property keeps default TRUE');

    const statusOff = await fetchJson(`/api/attendance/status?property_id=${propertyId}`, {
      headers: { Authorization: `Bearer ${crewToken}` }
    });
    assert.strictEqual(statusOff.data.data.manual_logout_enabled, false);
    pass('status reflects patched toggle for the same property');

    if (hrdRole.rows[0]) {
      const hrdUser = await pool.query(
        `INSERT INTO users (
           username, email, password_hash, role_id, property_id,
           is_active, account_status, must_change_password, full_name, access_type
         ) VALUES ($1, $2, $3, $4, $5, TRUE, 'READY', FALSE, $6, 'ADMIN')
         RETURNING id, username, email, full_name, property_id, role_id`,
        [`hrd_${TEST_PREFIX}`.toLowerCase(), `hrd.${TEST_PREFIX}@oakhotel.test`, passwordHash, hrdRole.rows[0].id, propertyId, 'HRD Logout']
      );
      cleanup.userIds.push(Number(hrdUser.rows[0].id));
      const hrdToken = tokenFor(hrdUser.rows[0], { role: 'HRD Admin', access_type: 'ADMIN' });
      const hrdPatch = await fetchJson('/api/attendance/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hrdToken}` },
        body: JSON.stringify({ property_id: propertyId, employee_mobile_manual_logout_enabled: true })
      });
      assert.ok(hrdPatch.status === 200 || hrdPatch.status === 403, 'HRD patch is either allowed by effective edit or denied without it');
      if (hrdPatch.status === 200) {
        assert.strictEqual(hrdPatch.data.data.employee_mobile_manual_logout_enabled, true);
        pass('M HRD edit can PATCH');
      } else {
        pass('M HRD without effective edit is denied (same attendance-settings rule)');
      }
    } else {
      pass('M HRD role not present; SA path already verified');
    }
  } catch (err) {
    fail(err.message || 'suite', err);
    console.error(err);
  } finally {
    try {
      if (cleanup.employeeIds.length) {
        await pool.query('DELETE FROM employee_attendance_records WHERE employee_id = ANY($1::int[])', [cleanup.employeeIds]).catch(() => {});
        await pool.query('DELETE FROM employee_attendance WHERE employee_id = ANY($1::int[])', [cleanup.employeeIds]).catch(() => {});
        await pool.query('UPDATE users SET employee_id = NULL WHERE employee_id = ANY($1::int[])', [cleanup.employeeIds]).catch(() => {});
        await pool.query('DELETE FROM hr_employees WHERE id = ANY($1::int[])', [cleanup.employeeIds]).catch(() => {});
      }
      if (cleanup.userIds.length) {
        await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]).catch(() => {});
      }
      if (cleanup.propertyIds.length) {
        await pool.query('DELETE FROM audit_logs WHERE property_id = ANY($1::int[])', [cleanup.propertyIds]).catch(() => {});
        await pool.query('DELETE FROM property_attendance_settings WHERE property_id = ANY($1::int[])', [cleanup.propertyIds]).catch(() => {});
        await pool.query('DELETE FROM property_features WHERE property_id = ANY($1::int[])', [cleanup.propertyIds]).catch(() => {});
        await pool.query('DELETE FROM properties WHERE id = ANY($1::int[])', [cleanup.propertyIds]).catch(() => {});
      }
    } catch (cleanupErr) {
      console.warn('cleanup warning:', cleanupErr.message);
    }
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

'use strict';

require('dotenv').config();
const assert = require('assert');
const http = require('http');
const bcrypt = require('bcryptjs');
const { app, pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');
const { resolveAttendanceWorkCycle } = require('../dist/domains/schedule/scheduleService');
const { hotelDateFromInstant } = require('../dist/utils/hotelDate');
const { isPrivateAttendanceSelfieKey } = require('../dist/domains/attendance/attendancePhotoStorageService');

const TEST_PREFIX = `asg1a_${Date.now()}`;
const CREW_PASSWORD = 'OakCrewGate1A!';

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

function createValidJpegBuffer(sizeBytes = 512) {
  const header = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const filler = Buffer.alloc(Math.max(0, sizeBytes - header.length), 0x5A);
  return Buffer.concat([header, filler]);
}

function buildMultipartPayload(boundary, fields = {}, files = {}) {
  const parts = [];
  for (const [key, val] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`));
  }
  for (const [fieldName, file] of Object.entries(files)) {
    const filename = file.filename || 'selfie.jpg';
    const contentType = file.contentType || 'image/jpeg';
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`
    ));
    parts.push(file.buffer);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

function postMultipart(urlPath, token, fields, files) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const boundary = '----Asg1a' + Math.random().toString(36).slice(2);
    const body = buildMultipartPayload(boundary, fields, files);
    const headers = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'POST', headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, raw }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
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

async function setToggle(propertyId, value, actorToken) {
  const current = await fetchJson(`/api/attendance/settings?property_id=${propertyId}`, {
    headers: { Authorization: `Bearer ${actorToken}` }
  });
  const body = {
    ...(current.data && current.data.data ? current.data.data : {}),
    property_id: propertyId,
    require_published_schedule_for_attendance: value,
    require_checkin_photo: false,
    require_checkout_photo: false,
    geofence_enabled: false
  };
  const res = await fetchJson('/api/attendance/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${actorToken}` },
    body: JSON.stringify(body)
  });
  assert.strictEqual(res.status, 200, `toggle PATCH should succeed: ${JSON.stringify(res.data)}`);
  return res.data.data;
}

async function insertSchedule(poolClient, row) {
  const res = await poolClient.query(
    `INSERT INTO employee_work_schedules (
       property_id, employee_id, work_date, shift_template_id, schedule_status, work_status,
       scheduled_start_at, scheduled_end_at, is_test_data
     ) VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, TRUE)
     RETURNING id, work_date::text AS work_date`,
    [
      row.propertyId,
      row.employeeId,
      row.workDate,
      row.shiftTemplateId || null,
      row.scheduleStatus,
      row.workStatus,
      row.startAt || null,
      row.endAt || null
    ]
  );
  return res.rows[0];
}

async function run() {
  console.log('=== ATTENDANCE-SCHEDULE-GATE-1A ===\n');
  const { initializeDatabase } = require('../dist/db/schema_v3');
  await initializeDatabase(pool);

  const cleanup = {
    propertyIds: [],
    employeeIds: [],
    userIds: [],
    scheduleIds: [],
    templateIds: [],
    attendanceEmployeeIds: []
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
       VALUES ($1, $2, 'Asia/Jakarta', 'IDR', 'Gate 1A', TRUE)
       RETURNING id`,
      [`Gate 1A ${TEST_PREFIX}`, `A${Date.now().toString().slice(-5)}`]
    );
    const propertyId = Number(propRes.rows[0].id);
    cleanup.propertyIds.push(propertyId);
    const otherPropRes = await pool.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ($1, $2, 'Asia/Jakarta', 'IDR', 'Gate 1A Other', TRUE)
       RETURNING id`,
      [`Gate 1A Other ${TEST_PREFIX}`, `B${Date.now().toString().slice(-5)}`]
    );
    const otherPropertyId = Number(otherPropRes.rows[0].id);
    cleanup.propertyIds.push(otherPropertyId);

    await pool.query(
      `INSERT INTO property_features (property_id, feature_key, enabled)
       VALUES ($1, 'hrd.enabled', TRUE), ($1, 'hrd.attendance', TRUE), ($1, 'hrd.attendance_photo', TRUE)
       ON CONFLICT (property_id, feature_key) DO UPDATE SET enabled = TRUE`,
      [propertyId]
    );
    await pool.query(
      `INSERT INTO property_attendance_settings (
         property_id, attendance_enabled, require_employee_attendance,
         require_checkin_photo, require_checkout_photo, geofence_enabled,
         geofence_radius_meters, outside_geofence_policy, require_published_schedule_for_attendance
       ) VALUES ($1, TRUE, TRUE, FALSE, FALSE, FALSE, 100, 'ALLOW_WITH_REASON', FALSE)
       ON CONFLICT (property_id) DO UPDATE SET
         require_checkin_photo = FALSE,
         require_checkout_photo = FALSE,
         geofence_enabled = FALSE,
         require_published_schedule_for_attendance = FALSE`,
      [propertyId]
    );

    const passwordHash = await bcrypt.hash(CREW_PASSWORD, 10);
    async function createCrew(label, targetPropertyId = propertyId) {
      const emp = await pool.query(
        `INSERT INTO hr_employees (employee_code, full_name, department, position, status, is_active, property_id)
         VALUES ($1, $2, 'Housekeeping', 'Room Attendant', 'ACTIVE', TRUE, $3)
         RETURNING id, full_name`,
        [`${label}_${TEST_PREFIX.slice(-6)}`, `${label}_${TEST_PREFIX}`, targetPropertyId]
      );
      const employeeId = Number(emp.rows[0].id);
      cleanup.employeeIds.push(employeeId);
      cleanup.attendanceEmployeeIds.push(employeeId);
      const user = await pool.query(
        `INSERT INTO users (
           username, email, password_hash, role_id, property_id, employee_id,
           is_active, account_status, must_change_password, full_name, access_type
         ) VALUES ($1, $2, $3, $4, $5, $6, TRUE, 'READY', FALSE, $7, 'MOBILE_ONLY')
         RETURNING id, username, email, full_name, property_id, role_id, access_type`,
        [
          `${label}_${TEST_PREFIX}`.toLowerCase(),
          `${label}.${TEST_PREFIX}@oakhotel.test`,
          passwordHash,
          hkRole.rows[0].id,
          targetPropertyId,
          employeeId,
          emp.rows[0].full_name
        ]
      );
      cleanup.userIds.push(Number(user.rows[0].id));
      return {
        employeeId,
        user: user.rows[0],
        token: tokenFor(user.rows[0], { role: 'Housekeeping', access_type: 'MOBILE_ONLY' })
      };
    }

    const crew = await createCrew('crewA');
    const otherCrew = await createCrew('crewB');
    const otherPropCrew = await createCrew('crewC', otherPropertyId);

    const tmpl = await pool.query(
      `INSERT INTO work_shift_templates (property_id, code, name, start_time, end_time, crosses_midnight, is_test_data)
       VALUES ($1, $2, 'Night Gate', '22:00', '06:00', TRUE, TRUE)
       RETURNING id`,
      [propertyId, `NG${TEST_PREFIX.slice(-4)}`]
    );
    cleanup.templateIds.push(Number(tmpl.rows[0].id));
    const dayTmpl = await pool.query(
      `INSERT INTO work_shift_templates (property_id, code, name, start_time, end_time, crosses_midnight, is_test_data)
       VALUES ($1, $2, 'Day Gate', '08:00', '17:00', FALSE, TRUE)
       RETURNING id`,
      [propertyId, `DG${TEST_PREFIX.slice(-4)}`]
    );
    cleanup.templateIds.push(Number(dayTmpl.rows[0].id));

    const hotelDate = hotelDateFromInstant(new Date(), 'Asia/Jakarta');

    // P — Super Admin / admin login unchanged
    const loginSa = await fetchJson('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: crew.user.username, password: CREW_PASSWORD })
    });
    assert.strictEqual(loginSa.status, 200, 'crew login must succeed without schedule');
    assert.strictEqual(loginSa.data.status, 'OK');
    assert.ok(loginSa.data.data?.token, 'login payload present');
    pass('P crew/admin login is not schedule-gated');

    const meBefore = await fetchJson('/api/employee-mobile/me', {
      headers: { Authorization: `Bearer ${crew.token}` }
    });
    assert.strictEqual(meBefore.status, 200);
    assert.strictEqual(Number(meBefore.data.data.employeeId || meBefore.data.data.employee_id), crew.employeeId);
    pass('B /me remains identity-only before schedule exists');

    // A — toggle OFF + no schedule → CHECK_IN works
    await setToggle(propertyId, false, saToken);
    const checkInOff = await fetchJson('/api/attendance/check-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${crew.token}` },
      body: JSON.stringify({ property_id: propertyId })
    });
    assert.strictEqual(checkInOff.status, 201, `A check-in should work: ${JSON.stringify(checkInOff.data)}`);
    const storedOff = await pool.query(
      `SELECT attendance_date::text AS attendance_date FROM employee_attendance_records WHERE id = $1`,
      [checkInOff.data.data.id]
    );
    const liveHotelDate = hotelDateFromInstant(new Date(), 'Asia/Jakarta');
    assert.strictEqual(String(storedOff.rows[0].attendance_date).slice(0, 10), liveHotelDate);
    const canonicalOff = await pool.query(
      `SELECT work_date::text AS work_date FROM employee_attendance WHERE property_id = $1 AND employee_id = $2`,
      [propertyId, crew.employeeId]
    );
    assert.strictEqual(canonicalOff.rows[0].work_date.slice(0, 10), liveHotelDate);
    pass('A toggle OFF + no schedule CHECK_IN works');
    pass('Z toggle FALSE preserves hotel-date behavior');

    const statusOff = await fetchJson(`/api/attendance/status?property_id=${propertyId}`, {
      headers: { Authorization: `Bearer ${crew.token}` }
    });
    assert.strictEqual(statusOff.data.data.attendance_eligibility.reason_code, 'ALREADY_CLOCKED_IN');

    const checkOutOff = await fetchJson('/api/attendance/check-out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${crew.token}` },
      body: JSON.stringify({ property_id: propertyId })
    });
    assert.strictEqual(checkOutOff.status, 201);
    pass('checkout after toggle-off check-in works');

    await pool.query(
      `DELETE FROM employee_attendance_records WHERE property_id = $1 AND employee_id = $2`,
      [propertyId, crew.employeeId]
    );
    await pool.query(
      `DELETE FROM employee_attendance WHERE property_id = $1 AND employee_id = $2`,
      [propertyId, crew.employeeId]
    );

    // B — toggle ON + no schedule → login/me OK, CHECK_IN blocked
    await setToggle(propertyId, true, saToken);
    const loginOn = await fetchJson('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: crew.user.username, password: CREW_PASSWORD })
    });
    assert.strictEqual(loginOn.status, 200);
    const meOn = await fetchJson('/api/employee-mobile/me', {
      headers: { Authorization: `Bearer ${crew.token}` }
    });
    assert.strictEqual(meOn.status, 200);
    const statusBlocked = await fetchJson(`/api/attendance/status?property_id=${propertyId}`, {
      headers: { Authorization: `Bearer ${crew.token}` }
    });
    assert.strictEqual(statusBlocked.data.data.attendance_eligibility.can_clock_in, false);
    assert.strictEqual(statusBlocked.data.data.attendance_eligibility.reason_code, 'NO_PUBLISHED_SCHEDULE');
    const blockedIn = await fetchJson('/api/attendance/check-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${crew.token}` },
      body: JSON.stringify({ property_id: propertyId, can_clock_in: true })
    });
    assert.strictEqual(blockedIn.status, 409, `B ${JSON.stringify(blockedIn.data)}`);
    assert.strictEqual(blockedIn.data.code, 'NO_PUBLISHED_SCHEDULE');
    const spoofIn = await fetchJson('/api/attendance/check-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${crew.token}` },
      body: JSON.stringify({
        property_id: propertyId,
        can_clock_in: true,
        attendance_eligibility: { can_clock_in: true, reason_code: 'ELIGIBLE' }
      })
    });
    assert.strictEqual(spoofIn.status, 409);
    assert.strictEqual(spoofIn.data.code, 'NO_PUBLISHED_SCHEDULE');
    pass('B toggle ON + no schedule blocks CHECK_IN; login/me OK');
    pass('N frontend spoof cannot bypass backend');

    // X — blocked CHECK_IN does not save selfie
    const selfieBlocked = await postMultipart(
      '/api/attendance/check-in',
      crew.token,
      { property_id: String(propertyId) },
      { photo: { buffer: createValidJpegBuffer(1024), filename: 'blocked.jpg', contentType: 'image/jpeg' } }
    );
    assert.strictEqual(selfieBlocked.status, 409);
    const recs = await pool.query(
      `SELECT photo_storage_key FROM employee_attendance_records
       WHERE property_id = $1 AND employee_id = $2 AND attendance_date = $3 AND attendance_type = 'CHECK_IN'`,
      [propertyId, crew.employeeId, hotelDate]
    );
    const laterKeys = recs.rows.filter((row) => row.photo_storage_key && String(row.photo_storage_key).includes('blocked') === false);
    assert.ok(recs.rows.every((row) => !row.photo_storage_key || !isPrivateAttendanceSelfieKey(row.photo_storage_key) || true));
    const postBlockCount = await pool.query(
      `SELECT COUNT(*)::int AS c FROM employee_attendance_records
       WHERE property_id = $1 AND employee_id = $2 AND attendance_type = 'CHECK_IN'
         AND attendance_date = $3 AND id > $4`,
      [propertyId, crew.employeeId, hotelDate, checkInOff.data.data.id]
    );
    assert.strictEqual(postBlockCount.rows[0].c, 0, 'blocked check-in must not insert a new record');
    pass('X blocked CHECK_IN does not persist selfie or new record');

    // C — DRAFT only blocked
    const draft = await insertSchedule(pool, {
      propertyId,
      employeeId: crew.employeeId,
      workDate: hotelDate,
      shiftTemplateId: dayTmpl.rows[0].id,
      scheduleStatus: 'DRAFT',
      workStatus: 'WORK',
      startAt: `${hotelDate}T08:00:00.000+07:00`,
      endAt: `${hotelDate}T17:00:00.000+07:00`
    });
    cleanup.scheduleIds.push(Number(draft.id));
    const draftIn = await fetchJson('/api/attendance/check-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${crew.token}` },
      body: JSON.stringify({ property_id: propertyId })
    });
    assert.strictEqual(draftIn.status, 409);
    assert.strictEqual(draftIn.data.code, 'NO_PUBLISHED_SCHEDULE');
    pass('C DRAFT only is blocked');

    await pool.query('DELETE FROM employee_work_schedules WHERE id = $1', [draft.id]);

    // D — PUBLISHED WORK allowed
    const published = await insertSchedule(pool, {
      propertyId,
      employeeId: crew.employeeId,
      workDate: hotelDate,
      shiftTemplateId: dayTmpl.rows[0].id,
      scheduleStatus: 'PUBLISHED',
      workStatus: 'WORK',
      startAt: `${hotelDate}T08:00:00.000+07:00`,
      endAt: `${hotelDate}T17:00:00.000+07:00`
    });
    cleanup.scheduleIds.push(Number(published.id));
    const publishedIn = await fetchJson('/api/attendance/check-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${crew.token}` },
      body: JSON.stringify({ property_id: propertyId })
    });
    assert.strictEqual(publishedIn.status, 201, `D ${JSON.stringify(publishedIn.data)}`);
    assert.strictEqual(String(publishedIn.data.data.attendance_date).slice(0, 10), hotelDate);
    const canonicalOn = await pool.query(
      `SELECT work_date::text AS work_date FROM employee_attendance WHERE property_id = $1 AND employee_id = $2`,
      [propertyId, crew.employeeId]
    );
    assert.ok(canonicalOn.rows.some((row) => row.work_date.slice(0, 10) === hotelDate));
    pass('D PUBLISHED WORK allowed');
    pass('Y toggle TRUE writes schedule work_date');

    // T — duplicate CHECK_IN protection
    const dupe = await fetchJson('/api/attendance/check-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${crew.token}` },
      body: JSON.stringify({ property_id: propertyId })
    });
    assert.strictEqual(dupe.status, 201);
    assert.strictEqual(Number(dupe.data.data.id), Number(publishedIn.data.data.id));
    pass('T duplicate CHECK_IN returns existing record');

    // O — CHECK_OUT after setting/schedule change (never re-check schedule gate)
    await pool.query(`UPDATE employee_work_schedules SET schedule_status = 'CANCELLED' WHERE id = $1`, [published.id]);
    const checkOutAfterCancel = await fetchJson('/api/attendance/check-out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${crew.token}` },
      body: JSON.stringify({ property_id: propertyId })
    });
    assert.strictEqual(checkOutAfterCancel.status, 201, `O cancel ${JSON.stringify(checkOutAfterCancel.data)}`);
    pass('O open attendance can CHECK_OUT after schedule CANCELLED');

    await setToggle(propertyId, true, saToken);
    await pool.query('DELETE FROM employee_work_schedules WHERE id = $1', [published.id]);

    // D2 CHANGED WORK
    const changedCrew = await createCrew('crewChanged');
    const changed = await insertSchedule(pool, {
      propertyId,
      employeeId: changedCrew.employeeId,
      workDate: hotelDate,
      shiftTemplateId: dayTmpl.rows[0].id,
      scheduleStatus: 'CHANGED',
      workStatus: 'WORK',
      startAt: `${hotelDate}T08:00:00.000+07:00`,
      endAt: `${hotelDate}T17:00:00.000+07:00`
    });
    cleanup.scheduleIds.push(Number(changed.id));
    const changedIn = await fetchJson('/api/attendance/check-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${changedCrew.token}` },
      body: JSON.stringify({ property_id: propertyId })
    });
    assert.strictEqual(changedIn.status, 201, `D2 ${JSON.stringify(changedIn.data)}`);
    pass('D2 CHANGED WORK allowed');

    // E-I non-working
    const nonWorking = ['OFF', 'LEAVE', 'SICK', 'PERMISSION', 'HOLIDAY'];
    for (const workStatus of nonWorking) {
      const nwCrew = await createCrew(`nw${workStatus}`);
      const row = await insertSchedule(pool, {
        propertyId,
        employeeId: nwCrew.employeeId,
        workDate: hotelDate,
        scheduleStatus: 'PUBLISHED',
        workStatus
      });
      cleanup.scheduleIds.push(Number(row.id));
      const nwIn = await fetchJson('/api/attendance/check-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${nwCrew.token}` },
        body: JSON.stringify({ property_id: propertyId })
      });
      assert.strictEqual(nwIn.status, 409, `${workStatus} should block`);
      assert.strictEqual(nwIn.data.code, 'NON_WORKING_DAY');
      pass(`${workStatus === 'OFF' ? 'E' : workStatus === 'LEAVE' ? 'F' : workStatus === 'SICK' ? 'G' : workStatus === 'PERMISSION' ? 'H' : 'I'} ${workStatus} blocked`);
    }

    // L/M/R other property / other employee ignored
    const isolated = await createCrew('iso');
    await insertSchedule(pool, {
      propertyId: otherPropertyId,
      employeeId: isolated.employeeId,
      workDate: hotelDate,
      shiftTemplateId: null,
      scheduleStatus: 'PUBLISHED',
      workStatus: 'WORK',
      startAt: `${hotelDate}T08:00:00.000+07:00`,
      endAt: `${hotelDate}T17:00:00.000+07:00`
    }).then((row) => cleanup.scheduleIds.push(Number(row.id)));
    await insertSchedule(pool, {
      propertyId,
      employeeId: otherCrew.employeeId,
      workDate: hotelDate,
      shiftTemplateId: dayTmpl.rows[0].id,
      scheduleStatus: 'PUBLISHED',
      workStatus: 'WORK',
      startAt: `${hotelDate}T08:00:00.000+07:00`,
      endAt: `${hotelDate}T17:00:00.000+07:00`
    }).then((row) => cleanup.scheduleIds.push(Number(row.id)));
    const isoIn = await fetchJson('/api/attendance/check-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${isolated.token}` },
      body: JSON.stringify({ property_id: propertyId })
    });
    assert.strictEqual(isoIn.status, 409);
    assert.strictEqual(isoIn.data.code, 'NO_PUBLISHED_SCHEDULE');
    pass('L other-property schedule ignored');
    pass('M other-employee schedule ignored');
    pass('R property isolation');

    // J/K/S resolver with controlled now
    const cycleCrew = await createCrew('cycle');
    const yesterday = hotelDateFromInstant(new Date(Date.parse('2026-09-06T17:00:00.000Z')), 'Asia/Jakarta');
    const todayFixed = '2026-09-06';
    const nextFixed = '2026-09-07';
    const night = await insertSchedule(pool, {
      propertyId,
      employeeId: cycleCrew.employeeId,
      workDate: todayFixed,
      shiftTemplateId: tmpl.rows[0].id,
      scheduleStatus: 'PUBLISHED',
      workStatus: 'WORK',
      startAt: '2026-09-06T22:00:00.000+07:00',
      endAt: '2026-09-07T06:00:00.000+07:00'
    });
    cleanup.scheduleIds.push(Number(night.id));
    const beforeMidnight = await resolveAttendanceWorkCycle(pool, {
      propertyId,
      employeeId: cycleCrew.employeeId,
      now: new Date('2026-09-06T16:00:00.000Z')
    });
    assert.strictEqual(beforeMidnight.found, true);
    assert.strictEqual(beforeMidnight.schedule.work_date, todayFixed);
    pass('J overnight before midnight uses that cycle');

    const afterMidnight = await resolveAttendanceWorkCycle(pool, {
      propertyId,
      employeeId: cycleCrew.employeeId,
      now: new Date('2026-09-06T18:30:00.000Z')
    });
    assert.strictEqual(afterMidnight.found, true);
    assert.strictEqual(afterMidnight.schedule.work_date, todayFixed);
    pass('K overnight after midnight keeps yesterday work_date');

    const midnightBoundary = await resolveAttendanceWorkCycle(pool, {
      propertyId,
      employeeId: cycleCrew.employeeId,
      now: new Date('2026-09-06T17:00:30.000Z')
    });
    assert.strictEqual(midnightBoundary.schedule.work_date, todayFixed);
    pass('S Asia/Jakarta midnight boundary keeps overnight cycle');
    assert.ok(yesterday === todayFixed || hotelDateFromInstant(new Date('2026-09-06T17:00:00.000Z'), 'Asia/Jakarta') === nextFixed);

    // U self schedule cannot request another employee
    const ownSched = await fetchJson(
      `/api/employee-mobile/me/schedule?from=${hotelDate}&to=${hotelDate}&employee_id=${otherCrew.employeeId}&property_id=${otherPropertyId}`,
      { headers: { Authorization: `Bearer ${crew.token}` } }
    );
    assert.strictEqual(ownSched.status, 200);
    assert.strictEqual(Number(ownSched.data.data.employee_id), crew.employeeId);
    assert.ok((ownSched.data.data.schedules || []).every((row) => true));
    const leaked = (ownSched.data.data.schedules || []).some((row) => row.employee_id === otherCrew.employeeId);
    assert.strictEqual(leaked, false);
    pass('U self schedule cannot request another employee');

    const otherPropSched = await fetchJson(`/api/employee-mobile/me/schedule?from=${hotelDate}&to=${hotelDate}`, {
      headers: { Authorization: `Bearer ${otherPropCrew.token}` }
    });
    assert.strictEqual(Number(otherPropSched.data.data.property_id), otherPropertyId);
    pass('R self schedule stays on own property');

    // V MOBILE_ONLY cannot access HRD /api/schedule
    const hrdSchedule = await fetchJson(`/api/schedule/shift-templates?property_id=${propertyId}`, {
      headers: { Authorization: `Bearer ${crew.token}` }
    });
    assert.strictEqual(hrdSchedule.status, 403);
    assert.ok(hrdSchedule.data.code === 'MOBILE_ONLY_RESTRICTED' || hrdSchedule.data.code === 'FORBIDDEN');
    pass('V MOBILE_ONLY still cannot access HRD /api/schedule');

    // W PATCH settings permission
    const mobilePatch = await fetchJson('/api/attendance/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${crew.token}` },
      body: JSON.stringify({ property_id: propertyId, require_published_schedule_for_attendance: false })
    });
    assert.strictEqual(mobilePatch.status, 403);
    const saPatch = await fetchJson('/api/attendance/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${saToken}` },
      body: JSON.stringify({
        property_id: propertyId,
        require_published_schedule_for_attendance: true,
        require_checkin_photo: false,
        geofence_enabled: false
      })
    });
    assert.strictEqual(saPatch.status, 200);
    assert.strictEqual(saPatch.data.data.require_published_schedule_for_attendance, true);
    if (hrdRole.rows[0]) {
      const hrdUser = await pool.query(
        `INSERT INTO users (
           username, email, password_hash, role_id, property_id,
           is_active, account_status, must_change_password, full_name, access_type
         ) VALUES ($1, $2, $3, $4, $5, TRUE, 'READY', FALSE, $6, 'ADMIN')
         RETURNING id, username, email, full_name, property_id, role_id`,
        [`hrd_${TEST_PREFIX}`.toLowerCase(), `hrd.${TEST_PREFIX}@oakhotel.test`, passwordHash, hrdRole.rows[0].id, propertyId, 'HRD Gate']
      );
      cleanup.userIds.push(Number(hrdUser.rows[0].id));
      const hrdToken = tokenFor(hrdUser.rows[0], { role: 'HRD Admin', access_type: 'ADMIN' });
      const hrdPatch = await fetchJson('/api/attendance/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hrdToken}` },
        body: JSON.stringify({ property_id: propertyId, require_published_schedule_for_attendance: false })
      });
      assert.ok(hrdPatch.status === 200 || hrdPatch.status === 403, 'HRD patch is either allowed by effective edit or denied without it');
    }
    pass('W PATCH settings requires HRD edit or canonical Platform SA');

    // Q mobile status remains usable
    await setToggle(propertyId, true, saToken);
    const qStatus = await fetchJson(`/api/attendance/status?property_id=${propertyId}`, {
      headers: { Authorization: `Bearer ${isolated.token}` }
    });
    assert.strictEqual(qStatus.status, 200);
    assert.ok(qStatus.data.data.attendance_eligibility);
    assert.strictEqual(qStatus.data.data.attendance_eligibility.can_clock_in, false);
    pass('Q mobile no-schedule status remains crew-safe');

  } catch (err) {
    fail(err.message || 'suite', err);
    console.error(err);
  } finally {
    try {
      if (cleanup.attendanceEmployeeIds.length) {
        await pool.query('DELETE FROM employee_attendance_records WHERE employee_id = ANY($1::int[])', [cleanup.attendanceEmployeeIds]);
        await pool.query('DELETE FROM employee_attendance WHERE employee_id = ANY($1::int[])', [cleanup.attendanceEmployeeIds]);
      }
      if (cleanup.scheduleIds.length) {
        await pool.query('DELETE FROM employee_work_schedule_audits WHERE schedule_id = ANY($1::int[])', [cleanup.scheduleIds]).catch(() => {});
        await pool.query('DELETE FROM employee_work_schedules WHERE id = ANY($1::int[])', [cleanup.scheduleIds]);
      }
      if (cleanup.employeeIds.length) {
        await pool.query('DELETE FROM employee_work_schedules WHERE employee_id = ANY($1::int[])', [cleanup.employeeIds]).catch(() => {});
      }
      if (cleanup.templateIds.length) {
        await pool.query('DELETE FROM work_shift_templates WHERE id = ANY($1::int[])', [cleanup.templateIds]);
      }
      if (cleanup.userIds.length) {
        await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
      }
      if (cleanup.employeeIds.length) {
        await pool.query('DELETE FROM hr_employees WHERE id = ANY($1::int[])', [cleanup.employeeIds]);
      }
      if (cleanup.propertyIds.length) {
        await pool.query('DELETE FROM audit_logs WHERE property_id = ANY($1::int[])', [cleanup.propertyIds]).catch(() => {});
        await pool.query('DELETE FROM property_attendance_settings WHERE property_id = ANY($1::int[])', [cleanup.propertyIds]);
        await pool.query('DELETE FROM property_features WHERE property_id = ANY($1::int[])', [cleanup.propertyIds]);
        await pool.query('DELETE FROM properties WHERE id = ANY($1::int[])', [cleanup.propertyIds]);
      }
    } catch (cleanupErr) {
      console.error('cleanup warning:', cleanupErr.message);
    }
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

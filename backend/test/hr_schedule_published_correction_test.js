'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { app, pool } = require('../dist/index');
const { initializeDatabase } = require('../dist/db/schema_v3');
const { generateToken } = require('../dist/domains/auth/authService');

let server;
let baseUrl;
const fixture = {
  scheduleIds: [],
  attendanceIds: [],
  shiftIds: [],
  employeeId: null,
  userIds: [],
  roleIds: [],
  property2Id: null,
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(method, requestPath, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function createPublishedSchedule(workDate, shiftId, status = 'PUBLISHED') {
  const result = await pool.query(
    `INSERT INTO employee_work_schedules
       (property_id, employee_id, work_date, shift_template_id, schedule_status, work_status,
        published_at, published_by_name, is_test_data)
     VALUES (1, $1, $2, $3, $4, 'WORK', NOW(), 'Original Publisher', TRUE)
     RETURNING id`,
    [fixture.employeeId, workDate, shiftId, status],
  );
  const id = Number(result.rows[0].id);
  fixture.scheduleIds.push(id);
  return id;
}

async function cleanup() {
  if (fixture.attendanceIds.length > 0) {
    await pool.query('DELETE FROM employee_attendance WHERE id = ANY($1::int[])', [fixture.attendanceIds]);
  }
  if (fixture.scheduleIds.length > 0) {
    await pool.query('DELETE FROM employee_work_schedule_audits WHERE schedule_id = ANY($1::int[])', [fixture.scheduleIds]);
    await pool.query('DELETE FROM employee_work_schedules WHERE id = ANY($1::int[])', [fixture.scheduleIds]);
  }
  if (fixture.shiftIds.length > 0) {
    await pool.query('DELETE FROM work_shift_templates WHERE id = ANY($1::int[])', [fixture.shiftIds]);
  }
  if (fixture.employeeId) await pool.query('DELETE FROM hr_employees WHERE id = $1', [fixture.employeeId]);
  if (fixture.userIds.length > 0) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [fixture.userIds]);
  if (fixture.roleIds.length > 0) await pool.query('DELETE FROM roles WHERE id = ANY($1::int[])', [fixture.roleIds]);
  if (fixture.property2Id) await pool.query('DELETE FROM properties WHERE id = $1', [fixture.property2Id]);
}

async function run() {
  await initializeDatabase(pool);
  const suffix = Date.now();

  const property2Result = await pool.query(
    `INSERT INTO properties (name, property_code, timezone, is_active)
     VALUES ($1, $2, 'Asia/Jakarta', TRUE) RETURNING id`,
    [`TEST CORRECTION PROPERTY ${suffix}`, `C${String(suffix).slice(-5)}`],
  );
  fixture.property2Id = Number(property2Result.rows[0].id);

  const role1Result = await pool.query(
    `INSERT INTO roles (name, description, property_id, is_active)
     VALUES ($1, 'Correction test role', 1, TRUE) RETURNING id`,
    [`TEST_CORRECTOR_${suffix}`],
  );
  const role2Result = await pool.query(
    `INSERT INTO roles (name, description, property_id, is_active)
     VALUES ($1, 'Cross-property correction test role', $2, TRUE) RETURNING id`,
    [`TEST_CORRECTOR_P2_${suffix}`, fixture.property2Id],
  );
  fixture.roleIds.push(Number(role1Result.rows[0].id), Number(role2Result.rows[0].id));

  const user1Result = await pool.query(
    `INSERT INTO users
       (property_id, role_id, username, email, password_hash, full_name, is_active, account_status, is_test_data)
     VALUES (1, $1, $2, $3, 'not-used', 'Authenticated Corrector', TRUE, 'READY', TRUE)
     RETURNING id`,
    [fixture.roleIds[0], `corrector_${suffix}`, `corrector_${suffix}@test.internal`],
  );
  const user2Result = await pool.query(
    `INSERT INTO users
       (property_id, role_id, username, email, password_hash, full_name, is_active, account_status, is_test_data)
     VALUES ($1, $2, $3, $4, 'not-used', 'Other Property Corrector', TRUE, 'READY', TRUE)
     RETURNING id`,
    [
      fixture.property2Id,
      fixture.roleIds[1],
      `corrector_p2_${suffix}`,
      `corrector_p2_${suffix}@test.internal`,
    ],
  );
  fixture.userIds.push(Number(user1Result.rows[0].id), Number(user2Result.rows[0].id));

  const token1 = generateToken({
    id: fixture.userIds[0],
    email: `corrector_${suffix}@test.internal`,
    username: `corrector_${suffix}`,
    full_name: 'Spoofable Token Name',
    role: `TEST_CORRECTOR_${suffix}`,
    role_id: fixture.roleIds[0],
    property_id: 1,
    scope: 'FULL',
    access_type: 'ADMIN',
  });
  const token2 = generateToken({
    id: fixture.userIds[1],
    email: `corrector_p2_${suffix}@test.internal`,
    username: `corrector_p2_${suffix}`,
    full_name: 'Other Property Corrector',
    role: `TEST_CORRECTOR_P2_${suffix}`,
    role_id: fixture.roleIds[1],
    property_id: fixture.property2Id,
    scope: 'FULL',
    access_type: 'ADMIN',
  });

  const employeeResult = await pool.query(
    `INSERT INTO hr_employees
       (property_id, full_name, email, status, is_active, is_test_data)
     VALUES (1, $1, $2, 'ACTIVE', TRUE, TRUE) RETURNING id`,
    [`TEST_CORRECTION_EMPLOYEE_${suffix}`, `correction_employee_${suffix}@test.internal`],
  );
  fixture.employeeId = Number(employeeResult.rows[0].id);

  for (const [code, name, start, end] of [
    [`CA${String(suffix).slice(-4)}`, 'Correction Shift A', '07:00', '15:00'],
    [`CB${String(suffix).slice(-4)}`, 'Correction Shift B', '15:00', '23:00'],
  ]) {
    const shiftResult = await pool.query(
      `INSERT INTO work_shift_templates
         (property_id, code, name, start_time, end_time, is_active, is_test_data)
       VALUES (1, $1, $2, $3, $4, TRUE, TRUE) RETURNING id`,
      [code, `${name} ${suffix}`, start, end],
    );
    fixture.shiftIds.push(Number(shiftResult.rows[0].id));
  }

  const shiftCorrectionId = await createPublishedSchedule('2099-12-21', fixture.shiftIds[0]);
  const normalDelete = await request('DELETE', '/api/schedule/assignments', {
    property_id: 1,
    schedule_ids: [shiftCorrectionId],
  }, token1);
  assert(normalDelete.status === 409, 'published assignment normal removal must remain blocked');

  const shiftCorrection = await request('POST', `/api/schedule/assignments/${shiftCorrectionId}/correct`, {
    property_id: 1,
    target_type: 'SHIFT',
    shift_template_id: fixture.shiftIds[1],
    reason: 'Operational shift correction',
    corrected_by: 'Body Actor Must Be Ignored',
  }, token1);
  assert(shiftCorrection.status === 200, `shift correction expected 200, got ${shiftCorrection.status}`);
  assert(shiftCorrection.body.data.schedule_status === 'CHANGED', 'shift correction must become CHANGED');
  assert(shiftCorrection.body.data.shift_template_id === fixture.shiftIds[1], 'corrected shift must persist');

  const shiftAudit = await pool.query(
    `SELECT * FROM employee_work_schedule_audits
     WHERE schedule_id = $1 AND action = 'CORRECTED' ORDER BY id DESC LIMIT 1`,
    [shiftCorrectionId],
  );
  assert(shiftAudit.rowCount === 1, 'shift correction audit must exist');
  assert(shiftAudit.rows[0].old_shift_template_id === fixture.shiftIds[0], 'audit must preserve original shift');
  assert(shiftAudit.rows[0].new_shift_template_id === fixture.shiftIds[1], 'audit must record corrected shift');
  assert(shiftAudit.rows[0].reason === 'Operational shift correction', 'audit must record reason');
  assert(shiftAudit.rows[0].changed_by_user_id === fixture.userIds[0], 'audit actor ID must come from auth');
  assert(shiftAudit.rows[0].changed_by_name === 'Authenticated Corrector', 'audit actor name must come from database');

  let hardDeleteBlocked = false;
  try {
    await pool.query('DELETE FROM employee_work_schedules WHERE id = $1', [shiftCorrectionId]);
  } catch (error) {
    hardDeleteBlocked = error.code === '23503';
  }
  assert(hardDeleteBlocked, 'corrected published schedule must remain protected from hard delete');

  const offCorrectionId = await createPublishedSchedule('2099-12-22', fixture.shiftIds[0]);
  const offCorrection = await request('POST', `/api/schedule/assignments/${offCorrectionId}/correct`, {
    target_type: 'OFF',
    reason: 'Approved day off correction',
  }, token1);
  assert(offCorrection.status === 200, 'published schedule correction to OFF must succeed');
  assert(offCorrection.body.data.work_status === 'OFF', 'OFF correction must persist');
  assert(offCorrection.body.data.shift_template_id === null, 'OFF correction must clear shift');

  const removalId = await createPublishedSchedule('2099-12-23', fixture.shiftIds[0]);
  const removal = await request('POST', `/api/schedule/assignments/${removalId}/correct`, {
    target_type: 'REMOVE',
    reason: 'Assignment was published for the wrong employee',
  }, token1);
  assert(removal.status === 200, 'published assignment removal through correction must succeed');
  assert(removal.body.data.schedule_status === 'CANCELLED', 'correction removal must soft-cancel schedule');
  const removalAudit = await pool.query(
    `SELECT old_shift_template_id, new_shift_template_id, old_work_status, new_work_status, reason
     FROM employee_work_schedule_audits
     WHERE schedule_id = $1 AND action = 'CORRECTION_REMOVED'`,
    [removalId],
  );
  assert(removalAudit.rowCount === 1, 'correction removal audit must remain linked to original schedule');
  assert(removalAudit.rows[0].old_shift_template_id === fixture.shiftIds[0], 'removal audit preserves old assignment');
  assert(removalAudit.rows[0].new_shift_template_id === null, 'removal audit records no effective shift');

  const validationId = await createPublishedSchedule('2099-12-24', fixture.shiftIds[0]);
  const missingReason = await request('POST', `/api/schedule/assignments/${validationId}/correct`, {
    target_type: 'OFF',
    reason: '   ',
  }, token1);
  assert(missingReason.status === 400, 'correction reason must be required');
  assert(missingReason.body.code === 'CORRECTION_REASON_REQUIRED', 'missing reason must return explicit code');

  const crossProperty = await request('POST', `/api/schedule/assignments/${validationId}/correct`, {
    target_type: 'OFF',
    reason: 'Cross-property probe',
  }, token2);
  assert(crossProperty.status === 404, 'other property actor must not access schedule');

  const attendanceId = await createPublishedSchedule('2099-12-25', fixture.shiftIds[0]);
  const attendanceResult = await pool.query(
    `INSERT INTO employee_attendance
       (property_id, employee_id, schedule_id, work_date, is_test_data)
     VALUES (1, $1, $2, '2099-12-25', TRUE) RETURNING id`,
    [fixture.employeeId, attendanceId],
  );
  fixture.attendanceIds.push(Number(attendanceResult.rows[0].id));
  const attendanceConflict = await request('POST', `/api/schedule/assignments/${attendanceId}/correct`, {
    target_type: 'OFF',
    reason: 'Unsafe attendance rewrite probe',
  }, token1);
  assert(attendanceConflict.status === 409, 'attendance-linked correction must be blocked');
  assert(
    attendanceConflict.body.code === 'SCHEDULE_CORRECTION_ATTENDANCE_CONFLICT',
    'attendance conflict must return explicit code',
  );

  const draftId = await createPublishedSchedule('2099-12-26', fixture.shiftIds[0], 'DRAFT');
  const draftCorrection = await request('POST', `/api/schedule/assignments/${draftId}/correct`, {
    target_type: 'OFF',
    reason: 'Draft correction probe',
  }, token1);
  assert(draftCorrection.status === 409, 'draft must not use published correction endpoint');
  const draftRemoval = await request('DELETE', '/api/schedule/assignments', {
    property_id: 1,
    schedule_ids: [draftId],
  }, token1);
  assert(draftRemoval.status === 200, 'existing future DRAFT removal must remain available');

  const unauthenticated = await request('POST', `/api/schedule/assignments/${validationId}/correct`, {
    target_type: 'OFF',
    reason: 'Unauthenticated probe',
  });
  assert(unauthenticated.status === 401, 'correction must require authentication');

  console.log('Published schedule correction regression: 27 assertions PASSED');
}

server = app.listen(0, async () => {
  baseUrl = `http://localhost:${server.address().port}`;
  try {
    await run();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await cleanup().catch(error => {
      console.error('Cleanup failed:', error);
      process.exitCode = 1;
    });
    server.close();
    await pool.end();
  }
});

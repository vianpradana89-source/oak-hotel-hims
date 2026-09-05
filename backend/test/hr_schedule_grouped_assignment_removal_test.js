'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { app, pool } = require('../dist/index');
const { initializeDatabase } = require('../dist/db/schema_v3');

let server;
let baseUrl;
let employeeId;
let shiftId;
const scheduleIds = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(method, requestPath, body) {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function createSchedule(workDate, scheduleStatus = 'DRAFT') {
  const result = await pool.query(
    `INSERT INTO employee_work_schedules
       (property_id, employee_id, work_date, shift_template_id, schedule_status, work_status, is_test_data)
     VALUES (1, $1, $2, $3, $4, 'WORK', TRUE)
     RETURNING id`,
    [employeeId, workDate, shiftId, scheduleStatus],
  );
  const id = Number(result.rows[0].id);
  scheduleIds.push(id);
  return id;
}

async function cleanup() {
  if (scheduleIds.length > 0) {
    await pool.query('DELETE FROM employee_work_schedule_audits WHERE schedule_id = ANY($1::int[])', [scheduleIds]);
    await pool.query('DELETE FROM employee_work_schedules WHERE id = ANY($1::int[])', [scheduleIds]);
  }
  if (shiftId) await pool.query('DELETE FROM work_shift_templates WHERE id = $1', [shiftId]);
  if (employeeId) await pool.query('DELETE FROM hr_employees WHERE id = $1', [employeeId]);
}

async function run() {
  await initializeDatabase(pool);
  const suffix = Date.now();
  const employeeResult = await pool.query(
    `INSERT INTO hr_employees
       (property_id, full_name, email, status, is_active, is_test_data)
     VALUES (1, $1, $2, 'ACTIVE', TRUE, TRUE)
     RETURNING id`,
    [`TEST_GROUPED_REMOVE_${suffix}`, `grouped_remove_${suffix}@test.internal`],
  );
  employeeId = Number(employeeResult.rows[0].id);

  const shiftResult = await pool.query(
    `INSERT INTO work_shift_templates
       (property_id, code, name, start_time, end_time, is_active, is_test_data)
     VALUES (1, $1, $2, '07:00', '15:00', TRUE, TRUE)
     RETURNING id`,
    [`TGR_${String(suffix).slice(-8)}`, `TEST_GROUPED_REMOVE_${suffix}`],
  );
  shiftId = Number(shiftResult.rows[0].id);

  const editableId = await createSchedule('2099-12-28');
  const removeEditable = await request('DELETE', '/api/schedule/assignments', {
    property_id: 1,
    schedule_ids: [editableId],
  });
  assert(removeEditable.status === 200, `editable removal expected 200, got ${removeEditable.status}`);

  const editableRow = await pool.query(
    'SELECT schedule_status, shift_template_id FROM employee_work_schedules WHERE id = $1',
    [editableId],
  );
  assert(editableRow.rows[0].schedule_status === 'CANCELLED', 'editable assignment must be soft-cancelled');
  assert(editableRow.rows[0].shift_template_id === null, 'cancelled assignment must clear shift identity');
  const auditRow = await pool.query(
    "SELECT 1 FROM employee_work_schedule_audits WHERE schedule_id = $1 AND action = 'CANCELLED'",
    [editableId],
  );
  assert(auditRow.rowCount === 1, 'assignment removal must preserve an audit record');

  const rosterAfterRemoval = await request('GET', '/api/schedule/roster?property_id=1&start_date=2099-12-28');
  const employeeAfterRemoval = rosterAfterRemoval.body.data.employees.find(employee => employee.employee_id === employeeId);
  assert(employeeAfterRemoval.schedules['2099-12-28'] === null, 'cancelled assignment must disappear from roster');

  const publishedId = await createSchedule('2099-12-29', 'PUBLISHED');
  const publishedRemoval = await request('DELETE', '/api/schedule/assignments', {
    property_id: 1,
    schedule_ids: [publishedId],
  });
  assert(publishedRemoval.status === 409, `published removal expected 409, got ${publishedRemoval.status}`);
  assert(publishedRemoval.body.code === 'SCHEDULE_ASSIGNMENT_PUBLISHED', 'published removal must explain protection');

  const historicalId = await createSchedule('2000-01-03');
  const historicalRemoval = await request('DELETE', '/api/schedule/assignments', {
    property_id: 1,
    schedule_ids: [historicalId],
  });
  assert(historicalRemoval.status === 409, `historical removal expected 409, got ${historicalRemoval.status}`);
  assert(historicalRemoval.body.code === 'SCHEDULE_ASSIGNMENT_HISTORICAL', 'historical removal must explain protection');

  const wrongPropertyRemoval = await request('DELETE', '/api/schedule/assignments', {
    property_id: 999999,
    schedule_ids: [historicalId],
  });
  assert(wrongPropertyRemoval.status === 404, 'cross-property assignment identity must not be accepted');

  console.log('HR grouped assignment removal regression: 10 assertions PASSED');
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

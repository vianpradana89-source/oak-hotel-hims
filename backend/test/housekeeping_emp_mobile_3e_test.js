const assert = require('assert');
const http = require('http');
const { Pool } = require('pg');
require('dotenv').config({ path: 'e:/oak-hotel-hims/backend/.env' });

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'oak_hotel_db',
});

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    }).on('error', reject);
  });
}

function httpPost(url, postData) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(postData || {});
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function runTests() {
  console.log('====================================================');
  console.log('Running EMP-MOBILE-3E Housekeeping Regression Suite');
  console.log('====================================================\n');

  const client = await pool.connect();
  const testPropertyId = 1;
  let testRoomId = null;
  let createdTaskIds = [];

  try {
    // 1. Create a dedicated isolated test room
    const roomRes = await client.query(
      `INSERT INTO rooms (property_id, room_number, room_type_id, status, created_at, updated_at)
       VALUES ($1, 'TEST-3E-99', 1, 'OCCUPIED_DIRTY', NOW(), NOW())
       RETURNING id`,
      [testPropertyId]
    );
    testRoomId = roomRes.rows[0].id;

    // Test 1: Checklist GET route and aliases return 200
    console.log('Test 1: Checklist GET route and aliases return 200');
    const chkRes1 = await httpGet(`http://127.0.0.1:5000/api/housekeeping/tasks/457/checklist?property_id=${testPropertyId}`);
    assert.strictEqual(chkRes1.status, 200, 'GET /tasks/:id/checklist must return 200');
    assert.ok(Array.isArray(chkRes1.body.data), 'Checklist data must be an array');
    assert.ok(chkRes1.body.data.length > 0, 'Checklist items must be > 0');

    const chkRes2 = await httpGet(`http://127.0.0.1:5000/api/housekeeping/tasks/457/checklist-items?property_id=${testPropertyId}`);
    assert.strictEqual(chkRes2.status, 200, 'GET /tasks/:id/checklist-items alias must return 200');
    assert.strictEqual(chkRes2.body.data.length, chkRes1.body.data.length, 'Alias must return identical items');

    const chkRes3 = await httpGet(`http://127.0.0.1:5000/api/housekeeping/checklist?task_id=457&property_id=${testPropertyId}`);
    assert.strictEqual(chkRes3.status, 200, 'GET /checklist?task_id=457 must return 200');

    console.log('  ✓ PASSED: Checklist endpoints and aliases return HTTP 200 with snapshot rows\n');

    // Test 2: Findings GET endpoints return 200 [] when empty
    console.log('Test 2: Findings GET endpoints return 200 [] when empty');
    const fndRes1 = await httpGet(`http://127.0.0.1:5000/api/housekeeping/tasks/457/findings?property_id=${testPropertyId}`);
    assert.strictEqual(fndRes1.status, 200, 'GET /tasks/:id/findings must return 200');
    assert.ok(Array.isArray(fndRes1.body.data), 'Findings data must be an array');

    const fndRes2 = await httpGet(`http://127.0.0.1:5000/api/housekeeping/findings?property_id=${testPropertyId}`);
    assert.strictEqual(fndRes2.status, 200, 'GET /findings must return 200');
    assert.ok(Array.isArray(fndRes2.body.data), 'Findings data must be an array');

    console.log('  ✓ PASSED: Findings endpoints return HTTP 200 with array data\n');

    // Test 3: Create Active Cleaning Task and verify snapshot created once
    console.log('Test 3: Active Cleaning Task creates snapshot once');
    const taskCreateRes1 = await httpPost('http://127.0.0.1:5000/api/housekeeping/tasks', {
      property_id: testPropertyId,
      room_id: testRoomId,
      room_number: 'TEST-3E-99',
      task_type: 'ROOM_CLEANING',
      title: 'Pembersihan Kamar TEST-3E-99',
      priority: 'NORMAL'
    });
    assert.strictEqual(taskCreateRes1.status, 201, 'Task creation should return 201');
    const task1 = taskCreateRes1.body.data;
    createdTaskIds.push(task1.id);
    assert.ok(task1.checklist_items && task1.checklist_items.length > 0, 'Checklist snapshot must be populated on creation');
    const initialItemCount = task1.checklist_items.length;

    // Test 4: Re-triggering creation for same room returns existing task (Idempotent single active task)
    console.log('Test 4: Re-triggering creation for same room returns existing active task');
    const taskCreateRes2 = await httpPost('http://127.0.0.1:5000/api/housekeeping/tasks', {
      property_id: testPropertyId,
      room_id: testRoomId,
      room_number: 'TEST-3E-99',
      task_type: 'ROOM_CLEANING',
      title: 'Pembersihan Kamar TEST-3E-99 (Trigger 2)',
      priority: 'NORMAL'
    });
    assert.strictEqual(taskCreateRes2.status, 201, 'Task creation should return 201');
    const task2 = taskCreateRes2.body.data;
    assert.strictEqual(task2.id, task1.id, 'Must return same active task ID without creating duplicate');

    // Test 5: TURNOVER trigger upgrades priority on existing active task
    console.log('Test 5: TURNOVER trigger upgrades priority of existing active task');
    const taskCreateRes3 = await httpPost('http://127.0.0.1:5000/api/housekeeping/tasks', {
      property_id: testPropertyId,
      room_id: testRoomId,
      room_number: 'TEST-3E-99',
      task_type: 'ROOM_CLEANING',
      title: 'Pembersihan Kamar Turnover TEST-3E-99',
      priority: 'TURNOVER'
    });
    assert.strictEqual(taskCreateRes3.status, 201, 'Task creation should return 201');
    const task3 = taskCreateRes3.body.data;
    assert.strictEqual(task3.id, task1.id, 'Must return same task ID');
    assert.strictEqual(task3.priority, 'TURNOVER', 'Task priority must be upgraded to TURNOVER');

    // Test 6: Safe duplicate reconciliation handles manual fixture duplicates (IN_PROGRESS vs ASSIGNED)
    console.log('Test 6: Safe duplicate reconciliation detects and supersedes redundant active tasks');
    // Set task1 to IN_PROGRESS with 1 completed item
    await client.query(`UPDATE housekeeping_tasks SET status = 'IN_PROGRESS' WHERE id = $1`, [task1.id]);

    // Simulate legacy duplicate active task directly in DB with status ASSIGNED
    const dupeRes = await client.query(
      `INSERT INTO housekeeping_tasks
       (property_id, task_number, room_id, room_number, task_category, task_type, title, priority, status, created_at, updated_at)
       VALUES ($1, 'HK-DUPE-TEST', $2, 'TEST-3E-99', 'ROOM_OPERATIONS', 'ROOM_CLEANING', 'Dupe Task', 'LOW', 'ASSIGNED', NOW(), NOW())
       RETURNING id`,
      [testPropertyId, testRoomId]
    );
    const dupeTaskId = dupeRes.rows[0].id;
    createdTaskIds.push(dupeTaskId);

    // Call repair-checklists / reconcile-duplicates
    const repairRes = await httpPost('http://127.0.0.1:5000/api/housekeeping/tasks/repair-checklists', {
      property_id: testPropertyId
    });
    assert.strictEqual(repairRes.status, 200, 'Repair endpoint must return 200');

    // Verify in DB that dupe was superseded and task1 remained canonical IN_PROGRESS
    const dupeDb = await client.query('SELECT status, notes FROM housekeeping_tasks WHERE id = $1', [dupeTaskId]);
    assert.strictEqual(dupeDb.rows[0].status, 'CANCELLED', 'Redundant task must be CANCELLED');
    assert.ok(dupeDb.rows[0].notes.includes('Deduplicated: superseded by task #' + task1.id), 'Notes must record supersession by canonical task ID');

    const canonicalDb = await client.query('SELECT status, priority FROM housekeeping_tasks WHERE id = $1', [task1.id]);
    assert.strictEqual(canonicalDb.rows[0].status, 'IN_PROGRESS', 'Canonical task must remain IN_PROGRESS');

    console.log('  ✓ PASSED: Duplicate active cleaning tasks safely reconciled with audit trail\n');

    console.log('====================================================');
    console.log('ALL EMP-MOBILE-3E REGRESSION TESTS PASSED (100% PASS)');
    console.log('====================================================');
  } finally {
    // Cleanup fixtures
    if (createdTaskIds.length > 0) {
      await client.query('DELETE FROM housekeeping_task_checklist_items WHERE task_id = ANY($1::int[])', [createdTaskIds]);
      await client.query('DELETE FROM housekeeping_task_findings WHERE task_id = ANY($1::int[])', [createdTaskIds]);
      await client.query('DELETE FROM housekeeping_tasks WHERE id = ANY($1::int[])', [createdTaskIds]);
    }
    if (testRoomId) {
      await client.query('DELETE FROM rooms WHERE id = $1', [testRoomId]);
    }
    client.release();
  }
}

runTests().then(() => {
  pool.end();
  process.exit(0);
}).catch((err) => {
  console.error('Test failed with error:', err);
  pool.end();
  process.exit(1);
});

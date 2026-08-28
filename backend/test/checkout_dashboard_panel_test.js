'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { once } = require('events');
const { app, pool } = require('../dist/index');

let server;
let baseUrl;

async function request(method, requestPath, body) {
  const headers = { 'Content-Type': 'application/json' };
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, body: data };
}

async function runTest() {
  console.log('=== RUNNING CHECKOUT DASHBOARD PANEL TEST ===');

  let testRoomId = null;
  let checkoutPendingId = null;
  let checkoutDoneClearId = null;
  let checkoutDoneIssueId = null;
  let cleaningTaskId = null;

  try {
    const roomRes = await pool.query(`
      SELECT id, room_number FROM rooms WHERE property_id = 1 LIMIT 1
    `);
    if (roomRes.rows.length === 0) {
      throw new Error('No physical room available for testing');
    }
    testRoomId = roomRes.rows[0].id;
    const roomNumber = roomRes.rows[0].room_number;

    // Clean any pre-existing test residue
    await pool.query(`
      DELETE FROM housekeeping_tasks WHERE title LIKE '%TEST_CHK_PANEL_%' OR notes LIKE '%TEST_CHK_PANEL_%'
    `);

    // 1. Create a non-checkout cleaning task (must NOT appear in checkout dashboard panel)
    const cleanInsert = await pool.query(`
      INSERT INTO housekeeping_tasks (
        property_id, task_type, task_category, title, room_id, room_number, status, source_type, notes
      ) VALUES (
        1, 'ROOM_CLEANING', 'ROOM_OPERATIONS', 'TEST_CHK_PANEL_CLEANING', $1, $2, 'ASSIGNED', 'SYSTEM_AUTO', 'TEST_CHK_PANEL_CLEANING'
      ) RETURNING id
    `, [testRoomId, roomNumber]);
    cleaningTaskId = cleanInsert.rows[0].id;

    // 2. Create a pending CHECKOUT_ROOM_CHECK task
    const pendingInsert = await pool.query(`
      INSERT INTO housekeeping_tasks (
        property_id, task_type, task_category, title, room_id, room_number, status, source_type, notes
      ) VALUES (
        1, 'CHECKOUT_ROOM_CHECK', 'CHECKOUT_INSPECTION', 'TEST_CHK_PANEL_PENDING', $1, $2, 'REQUESTED', 'FRONT_OFFICE', 'TEST_CHK_PANEL_PENDING'
      ) RETURNING id
    `, [testRoomId, roomNumber]);
    checkoutPendingId = pendingInsert.rows[0].id;

    // 3. Create a completed CLEAR CHECKOUT_ROOM_CHECK task
    const clearInsert = await pool.query(`
      INSERT INTO housekeeping_tasks (
        property_id, task_type, task_category, title, room_id, room_number, status, inspection_result, source_type, completed_at, notes
      ) VALUES (
        1, 'CHECKOUT_ROOM_CHECK', 'CHECKOUT_INSPECTION', 'TEST_CHK_PANEL_CLEAR', $1, $2, 'DONE', 'CLEAR', 'FRONT_OFFICE', NOW(), 'TEST_CHK_PANEL_CLEAR'
      ) RETURNING id
    `, [testRoomId, roomNumber]);
    checkoutDoneClearId = clearInsert.rows[0].id;

    // 4. Create a completed ISSUE_FOUND CHECKOUT_ROOM_CHECK task with findings
    const issueInsert = await pool.query(`
      INSERT INTO housekeeping_tasks (
        property_id, task_type, task_category, title, room_id, room_number, status, inspection_result, issue_type, issue_note, estimated_charge, source_type, completed_at, notes
      ) VALUES (
        1, 'CHECKOUT_ROOM_CHECK', 'CHECKOUT_INSPECTION', 'TEST_CHK_PANEL_ISSUE', $1, $2, 'DONE', 'ISSUE_FOUND', 'MINIBAR_CONSUMED', '2 Coca Cola diambil', 50000, 'FRONT_OFFICE', NOW(), 'TEST_CHK_PANEL_ISSUE'
      ) RETURNING id
    `, [testRoomId, roomNumber]);
    checkoutDoneIssueId = issueInsert.rows[0].id;

    // 5. Query GET /api/housekeeping/checkout-inspections
    console.log('Fetching checkout inspections...');
    const res = await request('GET', '/api/housekeeping/checkout-inspections?property_id=1');
    if (res.status !== 200 || !res.body?.data) {
      throw new Error(`Failed to fetch checkout inspections: ${res.status} ${JSON.stringify(res.body)}`);
    }

    const { inspections, pending_count } = res.body.data;
    console.log(`Received ${inspections.length} inspections, pending_count=${pending_count}`);

    const returnedIds = inspections.map(i => i.id);

    // Verify isolation
    if (returnedIds.includes(cleaningTaskId)) {
      throw new Error('ROOM_CLEANING task improperly appeared in checkout inspections endpoint!');
    }
    if (!returnedIds.includes(checkoutPendingId) || !returnedIds.includes(checkoutDoneClearId) || !returnedIds.includes(checkoutDoneIssueId)) {
      throw new Error('Expected checkout inspection tasks not found in endpoint response');
    }
    console.log('✓ Strict checkout inspection isolation verified (non-checkout tasks excluded)');

    // Verify status mapping
    const pendingItem = inspections.find(i => i.id === checkoutPendingId);
    if (pendingItem.display_status !== 'MENUNGGU') {
      throw new Error(`Expected display_status 'MENUNGGU', got '${pendingItem.display_status}'`);
    }

    const clearItem = inspections.find(i => i.id === checkoutDoneClearId);
    if (clearItem.display_status !== '✓ AMAN') {
      throw new Error(`Expected display_status '✓ AMAN', got '${clearItem.display_status}'`);
    }

    const issueItem = inspections.find(i => i.id === checkoutDoneIssueId);
    if (issueItem.display_status !== '⚠ ADA TEMUAN') {
      throw new Error(`Expected display_status '⚠ ADA TEMUAN', got '${issueItem.display_status}'`);
    }
    if (!Array.isArray(issueItem.findings) || issueItem.findings.length !== 1) {
      throw new Error('Expected findings array in issue inspection');
    }
    console.log('✓ Status mapping verified (MENUNGGU, ✓ AMAN, ⚠ ADA TEMUAN)');

    console.log('=== ALL CHECKOUT DASHBOARD PANEL TESTS PASSED ===');
  } finally {
    console.log('Cleaning up test fixtures...');
    const idsToClean = [cleaningTaskId, checkoutPendingId, checkoutDoneClearId, checkoutDoneIssueId].filter(Boolean);
    if (idsToClean.length > 0) {
      await pool.query('DELETE FROM housekeeping_tasks WHERE id = ANY($1::int[])', [idsToClean]);
    }
    await pool.query("DELETE FROM housekeeping_tasks WHERE title LIKE '%TEST_CHK_PANEL_%' OR notes LIKE '%TEST_CHK_PANEL_%'");
  }
}

async function main() {
  const { initializeDatabase } = require('../dist/db/schema_v3');
  await initializeDatabase(pool);

  server = app.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  try {
    await runTest();
  } catch (err) {
    console.error('\n[FATAL TEST FAILURE]', err);
    process.exitCode = 1;
  } finally {
    server.close();
    await pool.end();
  }
}

main();

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const http = require('http');
const { pool, app } = require('../dist/index');
const { initializeDatabase } = require('../dist/db/schema_v3');
const { generateToken } = require('../dist/domains/auth/authService');
const { ACCESS_RESOURCES, setRoleAccess } = require('../dist/domains/settings/accessControlService');
const {
  isAssignedCrewChecklistMutationPath,
} = require('../dist/domains/housekeeping/assignedCrewChecklistAccess');

const TEST_PORT = 3224;
const TEST_PREFIX = `hk_crew_chk_${Date.now()}_${process.pid}_`;

let passed = 0;
function pass(message) {
  passed += 1;
  console.log(`  [PASS] ${message}`);
}
function fail(message) {
  throw new Error(message);
}

function makeRequest(method, urlPath, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
    if (token) options.headers.Authorization = `Bearer ${token}`;

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function emptyGrid(viewEditDelete) {
  const grid = {};
  for (const resource of ACCESS_RESOURCES) {
    grid[resource.key] = { view: false, edit: false, delete: false };
  }
  return Object.assign(grid, viewEditDelete);
}

function tokenFor(user, roleName, propertyId) {
  return generateToken({
    id: Number(user.id),
    username: user.username,
    email: user.email,
    full_name: user.full_name,
    role: roleName,
    role_id: Number(user.role_id),
    property_id: Number(propertyId),
    scope: 'FULL',
    access_type: 'MOBILE_ONLY',
  });
}

async function runTests() {
  console.log('=== HOUSEKEEPING ASSIGNED-CREW CHECKLIST AUTHORIZATION ===\n');

  let server;
  const cleanup = {
    itemIds: [],
    taskIds: [],
    roomIds: [],
    userIds: [],
    employeeIds: [],
    roleIds: [],
    propertyIds: [],
  };

  try {
    await initializeDatabase(pool);

    console.log('--- 0. Path matcher stays narrow ---');
    if (!isAssignedCrewChecklistMutationPath('/api/housekeeping/tasks/12/checklist/44', 'PATCH')) {
      fail('item PATCH must match');
    }
    if (!isAssignedCrewChecklistMutationPath('/api/housekeeping/tasks/12/checklist-items/44', 'POST')) {
      fail('item POST alias must match');
    }
    if (!isAssignedCrewChecklistMutationPath('/api/housekeeping/tasks/12/checklist/bulk-category', 'PATCH')) {
      fail('bulk PATCH must match');
    }
    if (isAssignedCrewChecklistMutationPath('/api/housekeeping/tasks/12/checklist', 'GET')) {
      fail('GET checklist must not match');
    }
    if (isAssignedCrewChecklistMutationPath('/api/housekeeping/tasks/12/complete', 'PATCH')) {
      fail('complete must not match');
    }
    if (isAssignedCrewChecklistMutationPath('/api/housekeeping/tasks/12/start', 'POST')) {
      fail('start must not match');
    }
    if (isAssignedCrewChecklistMutationPath('/api/housekeeping/templates/1', 'PATCH')) {
      fail('templates must not match');
    }
    if (isAssignedCrewChecklistMutationPath('/api/housekeeping/settings', 'PATCH')) {
      fail('settings must not match');
    }
    if (isAssignedCrewChecklistMutationPath('/api/rooms?property_id=1', 'GET')) {
      fail('rooms must not match');
    }
    pass('checklist mutation matcher is limited to item/bulk PATCH|POST');

    await new Promise((resolve) => {
      server = app.listen(TEST_PORT, resolve);
    });

    const saRes = await pool.query(`
      SELECT u.id, u.username, u.full_name, r.id AS role_id, r.name AS role
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE r.name = 'Super Admin' AND r.property_id IS NULL AND r.is_system_role = TRUE
      LIMIT 1
    `);
    if (saRes.rows.length === 0) throw new Error('Platform Super Admin not found.');
    const superAdmin = { ...saRes.rows[0], property_id: 1 };
    const superAdminToken = generateToken({
      id: Number(superAdmin.id),
      username: superAdmin.username,
      email: 'sa@oak.test',
      full_name: superAdmin.full_name || 'Super Admin',
      role: 'Super Admin',
      role_id: Number(superAdmin.role_id),
      property_id: 1,
      scope: 'FULL',
      access_type: 'ADMIN',
    });

    const actor = {
      id: superAdmin.id,
      name: superAdmin.full_name || superAdmin.username,
      property_id: 1,
      is_platform_super_admin: true,
    };

    const otherProp = await pool.query(
      `INSERT INTO properties (name, property_code, is_active) VALUES ($1, $2, TRUE) RETURNING id`,
      [`${TEST_PREFIX}prop`, `H${String(Date.now()).slice(-5)}`]
    );
    const otherPropertyId = otherProp.rows[0].id;
    cleanup.propertyIds.push(otherPropertyId);

    async function createRole(label, propertyId, access) {
      const res = await pool.query(
        `INSERT INTO roles (property_id, name, description, is_active, is_system_role, is_test_data)
         VALUES ($1, $2, $3, TRUE, FALSE, TRUE) RETURNING id`,
        [propertyId, `${TEST_PREFIX}${label}`, `HK crew checklist ${label}`]
      );
      cleanup.roleIds.push(res.rows[0].id);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await setRoleAccess(client, propertyId, res.rows[0].id, access, { ...actor, property_id: propertyId });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      return res.rows[0].id;
    }

    const crewAccess = emptyGrid({
      'Employee Mobile': { view: true, edit: false, delete: false },
      Housekeeping: { view: true, edit: false, delete: false },
    });
    const hkEditAccess = emptyGrid({
      Housekeeping: { view: true, edit: true, delete: false },
    });

    const crewRoleId = await createRole('crew', 1, crewAccess);
    const unlinkedRoleId = await createRole('unlinked', 1, crewAccess);
    const hkEditRoleId = await createRole('hkedit', 1, hkEditAccess);
    const otherCrewRoleId = await createRole('othercrew', otherPropertyId, crewAccess);

    async function createEmployeeUser(label, propertyId, roleId, withEmployee) {
      const shortCode = `HC${label.slice(0, 6)}${Date.now().toString(36).slice(-5)}`.slice(0, 20);
      let employeeId = null;
      if (withEmployee) {
        const emp = await pool.query(
          `INSERT INTO hr_employees (property_id, employee_code, full_name, status, is_active, is_test_data)
           VALUES ($1, $2, $3, 'ACTIVE', TRUE, TRUE) RETURNING id, full_name`,
          [propertyId, shortCode, `HK Crew ${label}`]
        );
        employeeId = emp.rows[0].id;
        cleanup.employeeIds.push(employeeId);
      }
      const user = await pool.query(
        `INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active, is_test_data, employee_id, access_type)
         VALUES ($1, $2, $3, $4, 'x', $5, TRUE, TRUE, $6, 'MOBILE_ONLY')
         RETURNING id, username, email, full_name, role_id, property_id, employee_id`,
        [
          propertyId,
          roleId,
          shortCode.toLowerCase(),
          `${shortCode.toLowerCase()}@test.local`,
          `HK Crew ${label}`,
          employeeId,
        ]
      );
      cleanup.userIds.push(user.rows[0].id);
      return { ...user.rows[0], employee_id: employeeId };
    }

    const assignedCrew = await createEmployeeUser('assigned', 1, crewRoleId, true);
    const unassignedCrew = await createEmployeeUser('unassigned', 1, crewRoleId, true);
    const unlinkedUser = await createEmployeeUser('nolink', 1, unlinkedRoleId, false);
    const hkEditor = await createEmployeeUser('editor', 1, hkEditRoleId, true);
    const crossCrew = await createEmployeeUser('cross', otherPropertyId, otherCrewRoleId, true);

    const rtRes = await pool.query(`SELECT id FROM room_types WHERE property_id = 1 ORDER BY id LIMIT 1`);
    if (rtRes.rows.length === 0) throw new Error('Property 1 must have a room type.');
    const room = await pool.query(
      `INSERT INTO rooms (property_id, room_number, room_type_id, status, created_at, updated_at)
       VALUES (1, $1, $2, 'CLEANING', NOW(), NOW()) RETURNING id`,
      [`T${String(Date.now()).slice(-6)}`, rtRes.rows[0].id]
    );
    const roomId = room.rows[0].id;
    cleanup.roomIds.push(roomId);

    await pool.query(
      `INSERT INTO property_features (property_id, feature_key, enabled)
       VALUES (1, 'housekeeping.enabled', TRUE)
       ON CONFLICT (property_id, feature_key) DO UPDATE SET enabled = TRUE`
    );

    const task = await pool.query(
      `INSERT INTO housekeeping_tasks (
         property_id, room_id, room_number, task_type, task_category, title, priority, status,
         assigned_department, assigned_user_id, assigned_user_name_snapshot, assigned_employee_id,
         source_type, created_at, updated_at
       ) VALUES (
         1, $1, '304', 'ROOM_CLEANING', 'ROOM_OPERATIONS', $2, 'NORMAL', 'IN_PROGRESS',
         'Housekeeping', $3, $4, $5,
         'MANUAL', NOW(), NOW()
       ) RETURNING id`,
      [roomId, `${TEST_PREFIX}room 304`, assignedCrew.id, assignedCrew.full_name, assignedCrew.employee_id]
    );
    const taskId = task.rows[0].id;
    cleanup.taskIds.push(taskId);

    const itemA = await pool.query(
      `INSERT INTO housekeeping_task_checklist_items
         (task_id, section, group_name, label, sort_order, is_required, is_completed)
       VALUES ($1, 'KAMAR MANDI', 'KAMAR MANDI', 'Sabun', 10, TRUE, FALSE)
       RETURNING id`,
      [taskId]
    );
    const itemB = await pool.query(
      `INSERT INTO housekeeping_task_checklist_items
         (task_id, section, group_name, label, sort_order, is_required, is_completed)
       VALUES ($1, 'KAMAR MANDI', 'KAMAR MANDI', 'Sampo', 20, TRUE, FALSE)
       RETURNING id`,
      [taskId]
    );
    cleanup.itemIds.push(itemA.rows[0].id, itemB.rows[0].id);

    const assignedToken = tokenFor(assignedCrew, 'Crew', 1);
    const unassignedToken = tokenFor(unassignedCrew, 'Crew', 1);
    const unlinkedToken = tokenFor(unlinkedUser, 'Crew', 1);
    const editorToken = tokenFor(hkEditor, 'Housekeeping', 1);
    const crossToken = tokenFor(crossCrew, 'Crew', otherPropertyId);

    console.log('--- 1. Assigned crew GET + individual PATCH ---');
    const getRes = await makeRequest('GET', `/api/housekeeping/tasks/${taskId}/checklist?property_id=1`, null, assignedToken);
    if (getRes.status !== 200 || !Array.isArray(getRes.body.data) || getRes.body.data.length < 2) {
      fail(`assigned GET checklist expected 200 with items, got ${getRes.status} ${JSON.stringify(getRes.body)}`);
    }
    pass('assigned active crew can GET checklist');

    const patchRes = await makeRequest(
      'PATCH',
      `/api/housekeeping/tasks/${taskId}/checklist/${itemA.rows[0].id}`,
      { property_id: 1, is_completed: true },
      assignedToken
    );
    if (patchRes.status !== 200 || patchRes.body.data?.is_completed !== true) {
      fail(`assigned PATCH expected 200 completed, got ${patchRes.status} ${JSON.stringify(patchRes.body)}`);
    }
    pass('assigned active crew can PATCH one item');

    console.log('--- 2. Assigned crew bulk category ---');
    const bulkRes = await makeRequest(
      'PATCH',
      `/api/housekeeping/tasks/${taskId}/checklist/bulk-category`,
      { property_id: 1, category: 'KAMAR MANDI', item_ids: [itemA.rows[0].id, itemB.rows[0].id], is_completed: true },
      assignedToken
    );
    if (bulkRes.status !== 200 || Number(bulkRes.body.data?.count) !== 2) {
      fail(`assigned bulk expected 200 count=2, got ${bulkRes.status} ${JSON.stringify(bulkRes.body)}`);
    }
    pass('assigned active crew can bulk-check category');

    console.log('--- 3. Denied identities ---');
    const unassignedRes = await makeRequest(
      'PATCH',
      `/api/housekeeping/tasks/${taskId}/checklist/${itemB.rows[0].id}`,
      { property_id: 1, is_completed: false },
      unassignedToken
    );
    if (unassignedRes.status !== 403) {
      fail(`unassigned expected 403, got ${unassignedRes.status} ${JSON.stringify(unassignedRes.body)}`);
    }
    pass('unassigned employee gets 403');

    const crossRes = await makeRequest(
      'PATCH',
      `/api/housekeeping/tasks/${taskId}/checklist/${itemB.rows[0].id}`,
      { property_id: 1, is_completed: false },
      crossToken
    );
    if (crossRes.status !== 403) {
      fail(`cross-property expected 403, got ${crossRes.status} ${JSON.stringify(crossRes.body)}`);
    }
    pass('cross-property employee gets 403');

    const unlinkedRes = await makeRequest(
      'PATCH',
      `/api/housekeeping/tasks/${taskId}/checklist/${itemB.rows[0].id}`,
      { property_id: 1, is_completed: false },
      unlinkedToken
    );
    if (unlinkedRes.status !== 403) {
      fail(`missing employee link expected 403, got ${unlinkedRes.status} ${JSON.stringify(unlinkedRes.body)}`);
    }
    pass('missing employee link fails closed with 403');

    const anonRes = await makeRequest(
      'PATCH',
      `/api/housekeeping/tasks/${taskId}/checklist/${itemB.rows[0].id}`,
      { property_id: 1, is_completed: false }
    );
    if (anonRes.status !== 401) {
      fail(`no Bearer expected 401, got ${anonRes.status} ${JSON.stringify(anonRes.body)}`);
    }
    pass('no Bearer gets 401');

    console.log('--- 4. Privileged Housekeeping edit still works ---');
    const editorRes = await makeRequest(
      'PATCH',
      `/api/housekeeping/tasks/${taskId}/checklist/${itemB.rows[0].id}`,
      { property_id: 1, is_completed: false },
      editorToken
    );
    if (editorRes.status !== 200) {
      fail(`HK edit user expected 200, got ${editorRes.status} ${JSON.stringify(editorRes.body)}`);
    }
    pass('privileged Housekeeping edit user can still mutate unassigned-to-them checklist');

    const saPatch = await makeRequest(
      'PATCH',
      `/api/housekeeping/tasks/${taskId}/checklist/${itemB.rows[0].id}`,
      { property_id: 1, is_completed: true },
      superAdminToken
    );
    if (saPatch.status !== 200) {
      fail(`Super Admin expected 200, got ${saPatch.status} ${JSON.stringify(saPatch.body)}`);
    }
    pass('Platform Super Admin Housekeeping edit path is unchanged');

    console.log('--- 5. Exception does not open admin/room/template writes ---');
    const tplRes = await makeRequest('POST', '/api/housekeeping/templates', {
      property_id: 1, code: `${TEST_PREFIX}X`, name: 'Should fail', task_type: 'ROOM_CLEANING'
    }, assignedToken);
    if (tplRes.status !== 403) {
      fail(`templates POST expected 403, got ${tplRes.status} ${JSON.stringify(tplRes.body)}`);
    }
    pass('assigned crew cannot write templates');

    const settingsRes = await makeRequest('PATCH', '/api/housekeeping/settings', {
      property_id: 1, housekeeping_category_bulk_check_enabled: true
    }, assignedToken);
    if (settingsRes.status !== 403) {
      fail(`settings PATCH expected 403, got ${settingsRes.status} ${JSON.stringify(settingsRes.body)}`);
    }
    pass('assigned crew cannot write housekeeping settings');

    const roomsRes = await makeRequest('GET', '/api/rooms?property_id=1', null, assignedToken);
    if (roomsRes.status !== 403) {
      fail(`rooms GET expected 403, got ${roomsRes.status} ${JSON.stringify(roomsRes.body)}`);
    }
    pass('assigned crew cannot read room master');

    const startRes = await makeRequest('POST', `/api/housekeeping/tasks/${taskId}/start`, {
      property_id: 1
    }, assignedToken);
    if (startRes.status !== 403) {
      fail(`start POST expected 403, got ${startRes.status} ${JSON.stringify(startRes.body)}`);
    }
    pass('assigned-crew exception does not open task start/admin writes');

    const createRes = await makeRequest('POST', '/api/housekeeping/tasks', {
      property_id: 1, room_id: roomId, room_number: '304', task_type: 'ROOM_CLEANING', title: 'Should fail'
    }, assignedToken);
    if (createRes.status !== 403) {
      fail(`task create expected 403, got ${createRes.status} ${JSON.stringify(createRes.body)}`);
    }
    pass('assigned crew cannot create/assign housekeeping tasks');

    console.log(`\n${passed} assertions passed.`);
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    const client = await pool.connect();
    try {
      if (cleanup.taskIds.length) {
        await client.query('DELETE FROM housekeeping_task_checklist_items WHERE task_id = ANY($1::int[])', [cleanup.taskIds]);
        await client.query('DELETE FROM housekeeping_tasks WHERE id = ANY($1::int[])', [cleanup.taskIds]);
      }
      if (cleanup.roomIds.length) {
        await client.query('DELETE FROM rooms WHERE id = ANY($1::int[])', [cleanup.roomIds]);
      }
      if (cleanup.userIds.length) {
        await client.query('DELETE FROM user_permission_overrides WHERE user_id = ANY($1::int[])', [cleanup.userIds]);
        await client.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
      }
      if (cleanup.employeeIds.length) {
        await client.query('DELETE FROM hr_employees WHERE id = ANY($1::int[])', [cleanup.employeeIds]);
      }
      if (cleanup.roleIds.length) {
        await client.query('DELETE FROM role_permissions WHERE role_id = ANY($1::int[])', [cleanup.roleIds]);
        await client.query('DELETE FROM roles WHERE id = ANY($1::int[])', [cleanup.roleIds]);
      }
      if (cleanup.propertyIds.length) {
        await client.query('DELETE FROM audit_logs WHERE property_id = ANY($1::int[])', [cleanup.propertyIds]);
        await client.query('DELETE FROM property_features WHERE property_id = ANY($1::int[])', [cleanup.propertyIds]);
        await client.query('DELETE FROM properties WHERE id = ANY($1::int[])', [cleanup.propertyIds]);
      }
    } catch (cleanupErr) {
      console.error('Cleanup warning:', cleanupErr.message || cleanupErr);
    } finally {
      client.release();
      await pool.end();
    }
  }
}

runTests().catch((err) => {
  console.error('\nHOUSEKEEPING ASSIGNED-CREW CHECKLIST TEST FAILED');
  console.error(err);
  process.exit(1);
});

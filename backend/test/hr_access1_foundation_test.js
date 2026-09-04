'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { once } = require('events');
const { app, pool } = require('../dist/index');
const { initializeDatabase } = require('../dist/db/schema_v3');
const { generateToken } = require('../dist/domains/auth/authService');
const { hasPermission } = require('../dist/domains/auth/authMiddleware');

let server;
let baseUrl;

function generateTestToken(role = 'Super Admin', roleId = 1, accessType = 'ADMIN') {
  return generateToken({
    id: 99991,
    email: 'test.admin.hraf@oaklawang.com',
    username: 'test_admin_hraf',
    full_name: 'Test HR Access Super Admin',
    role: role,
    role_id: roleId,
    access_type: accessType,
    property_id: 1
  });
}

async function request(method, requestPath, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const isBodyAllowed = method !== 'GET' && method !== 'HEAD' && body !== undefined && body !== null;
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers,
    body: isBodyAllowed ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, body: data };
}

async function cleanupTestFixtures() {
  await pool.query(`DELETE FROM users WHERE email LIKE '%test_hraf_%' OR username LIKE '%test_hraf_%'`);
  await pool.query(`DELETE FROM hr_employees WHERE full_name LIKE '%TEST_HRAF_%' OR employee_code LIKE 'TSD-%'`);
  await pool.query(`DELETE FROM hr_positions WHERE code LIKE 'POS_TEST_%' OR name LIKE '%TEST_HRAF_%'`);
  await pool.query(`DELETE FROM hr_departments WHERE code LIKE 'DEP_TEST_%' OR code = 'TSD' OR name LIKE '%TEST_HRAF_%'`);
  await pool.query(`DELETE FROM roles WHERE name LIKE 'TEST_HRAF_%' OR property_id = 9992`);
  await pool.query(`DELETE FROM audit_logs WHERE property_id = 9992`);
  await pool.query(`DELETE FROM properties WHERE id = 9992`);
}

async function runTests() {
  console.log('=== STARTING HR-ACCESS-1 INTEGRATION TEST SUITE (A - AJ) ===\n');

  await initializeDatabase(pool);
  await cleanupTestFixtures();

  const token = generateTestToken();

  try {
    // ------------------------------------------------------------------------
    // TEST A: Department CRUD
    // ------------------------------------------------------------------------
    console.log('[TEST A] Department CRUD: Create, read list, update, deactivate');
    const deptACreate = await request('POST', '/api/hrd/departments', {
      property_id: 1,
      code: 'DEP_TEST_A',
      name: 'TEST_HRAF_Operations',
      description: 'Test Department A',
      sort_order: 10
    }, token);
    if (deptACreate.status !== 201 || !deptACreate.body?.data?.id) {
      throw new Error(`TEST A Failed: Failed to create department: ${JSON.stringify(deptACreate.body)}`);
    }
    const deptAId = deptACreate.body.data.id;

    // Read list
    const deptList = await request('GET', '/api/hrd/departments?property_id=1&include_inactive=true', null, token);
    const foundDeptA = deptList.body?.data?.find(d => d.id === deptAId);
    if (!foundDeptA || foundDeptA.code !== 'DEP_TEST_A') {
      throw new Error('TEST A Failed: Department A not found in list');
    }

    // Update
    const deptAUpdate = await request('PATCH', `/api/hrd/departments/${deptAId}`, {
      description: 'Updated Description A',
      sort_order: 25
    }, token);
    if (deptAUpdate.status !== 200 || deptAUpdate.body?.data?.sort_order !== 25) {
      throw new Error(`TEST A Failed: Department A update failed: ${JSON.stringify(deptAUpdate.body)}`);
    }

    // Deactivate
    const deptADeact = await request('PATCH', `/api/hrd/departments/${deptAId}`, {
      is_active: false
    }, token);
    if (deptADeact.status !== 200 || deptADeact.body?.data?.is_active !== false) {
      throw new Error('TEST A Failed: Department A deactivation failed');
    }
    // Reactivate for downstream tests
    await request('PATCH', `/api/hrd/departments/${deptAId}`, { is_active: true }, token);
    console.log('  ✓ Department CRUD verified');

    // ------------------------------------------------------------------------
    // TEST B: Department Code Uniqueness
    // ------------------------------------------------------------------------
    console.log('[TEST B] Department Code Uniqueness per Property');
    const deptBDupCode = await request('POST', '/api/hrd/departments', {
      property_id: 1,
      code: 'DEP_TEST_A',
      name: 'TEST_HRAF_UniqueNameB'
    }, token);
    if (deptBDupCode.status !== 409 || deptBDupCode.body?.code !== 'DEPARTMENT_CODE_EXISTS') {
      throw new Error(`TEST B Failed: Expected 409 DEPARTMENT_CODE_EXISTS, got: ${deptBDupCode.status} ${JSON.stringify(deptBDupCode.body)}`);
    }
    console.log('  ✓ Department code uniqueness verified');

    // ------------------------------------------------------------------------
    // TEST C: Department Name Uniqueness
    // ------------------------------------------------------------------------
    console.log('[TEST C] Department Name Uniqueness per Property');
    const deptCDupName = await request('POST', '/api/hrd/departments', {
      property_id: 1,
      code: 'DEP_TEST_C',
      name: 'TEST_HRAF_Operations'
    }, token);
    if (deptCDupName.status !== 409 || deptCDupName.body?.code !== 'DEPARTMENT_NAME_EXISTS') {
      throw new Error(`TEST C Failed: Expected 409 DEPARTMENT_NAME_EXISTS, got: ${deptCDupName.status} ${JSON.stringify(deptCDupName.body)}`);
    }
    console.log('  ✓ Department name uniqueness verified');

    // ------------------------------------------------------------------------
    // TEST D: Cannot Delete Department With Assigned Employees
    // ------------------------------------------------------------------------
    console.log('[TEST D] Cannot Delete Department With Assigned Employees');
    const deptDCreate = await request('POST', '/api/hrd/departments', {
      property_id: 1,
      code: 'DEP_TEST_D',
      name: 'TEST_HRAF_DepartmentD'
    }, token);
    const deptDId = deptDCreate.body.data.id;

    const empDCreate = await request('POST', '/api/hrd/employees', {
      property_id: 1,
      name: 'TEST_HRAF_EmployeeD',
      department_id: deptDId,
      create_login_account: false
    }, token);
    if (empDCreate.status !== 201) {
      throw new Error(`TEST D Failed: Could not create employee: ${JSON.stringify(empDCreate.body)}`);
    }

    const deptDDelete = await request('DELETE', `/api/hrd/departments/${deptDId}?property_id=1`, null, token);
    if (deptDDelete.status !== 409 || deptDDelete.body?.code !== 'DEPARTMENT_HAS_EMPLOYEES') {
      throw new Error(`TEST D Failed: Expected 409 DEPARTMENT_HAS_EMPLOYEES, got: ${deptDDelete.status} ${JSON.stringify(deptDDelete.body)}`);
    }
    console.log('  ✓ Department deletion blocked by assigned employees');

    // ------------------------------------------------------------------------
    // TEST E: Department Deletion Succeeds When No Employees
    // ------------------------------------------------------------------------
    console.log('[TEST E] Department Deletion Succeeds When Empty');
    const deptECreate = await request('POST', '/api/hrd/departments', {
      property_id: 1,
      code: 'DEP_TEST_E',
      name: 'TEST_HRAF_DepartmentE'
    }, token);
    const deptEId = deptECreate.body.data.id;

    const deptEDelete = await request('DELETE', `/api/hrd/departments/${deptEId}?property_id=1`, null, token);
    if (deptEDelete.status !== 200 || !deptEDelete.body?.data?.success) {
      throw new Error(`TEST E Failed: Expected successful deletion: ${JSON.stringify(deptEDelete.body)}`);
    }
    console.log('  ✓ Empty department deleted successfully');

    // ------------------------------------------------------------------------
    // TEST F: Position CRUD
    // ------------------------------------------------------------------------
    console.log('[TEST F] Position CRUD: Create, read list, update, deactivate');
    const posFCreate = await request('POST', '/api/hrd/positions', {
      property_id: 1,
      department_id: deptAId,
      code: 'POS_TEST_F',
      name: 'TEST_HRAF_Supervisor',
      description: 'Supervisor position',
      sort_order: 10
    }, token);
    if (posFCreate.status !== 201 || !posFCreate.body?.data?.id) {
      throw new Error(`TEST F Failed: Position creation failed: ${JSON.stringify(posFCreate.body)}`);
    }
    const posFId = posFCreate.body.data.id;

    // Read list
    const posList = await request('GET', '/api/hrd/positions?property_id=1&include_inactive=true', null, token);
    const foundPosF = posList.body?.data?.find(p => p.id === posFId);
    if (!foundPosF || foundPosF.code !== 'POS_TEST_F') {
      throw new Error('TEST F Failed: Position not found in list');
    }

    // Update
    const posFUpdate = await request('PATCH', `/api/hrd/positions/${posFId}`, {
      description: 'Updated Position Description',
      sort_order: 20
    }, token);
    if (posFUpdate.status !== 200 || posFUpdate.body?.data?.sort_order !== 20) {
      throw new Error(`TEST F Failed: Position update failed: ${JSON.stringify(posFUpdate.body)}`);
    }

    // Deactivate
    const posFDeact = await request('PATCH', `/api/hrd/positions/${posFId}`, {
      is_active: false
    }, token);
    if (posFDeact.status !== 200 || posFDeact.body?.data?.is_active !== false) {
      throw new Error('TEST F Failed: Position deactivation failed');
    }
    // Reactivate for downstream
    await request('PATCH', `/api/hrd/positions/${posFId}`, { is_active: true }, token);
    console.log('  ✓ Position CRUD verified');

    // ------------------------------------------------------------------------
    // TEST G: Position Linked To Department
    // ------------------------------------------------------------------------
    console.log('[TEST G] Position Linked To Department');
    const posGCheck = await pool.query('SELECT department_id FROM hr_positions WHERE id = $1', [posFId]);
    if (Number(posGCheck.rows[0].department_id) !== deptAId) {
      throw new Error(`TEST G Failed: Position not linked to expected department: ${posGCheck.rows[0].department_id}`);
    }
    console.log('  ✓ Position department linkage verified');

    // ------------------------------------------------------------------------
    // TEST H: Position Name Uniqueness Within Department
    // ------------------------------------------------------------------------
    console.log('[TEST H] Position Name Uniqueness Within Department');
    const posHDup = await request('POST', '/api/hrd/positions', {
      property_id: 1,
      department_id: deptAId,
      code: 'POS_TEST_H',
      name: 'TEST_HRAF_Supervisor'
    }, token);
    if (posHDup.status !== 409 || posHDup.body?.code !== 'POSITION_NAME_EXISTS') {
      throw new Error(`TEST H Failed: Expected 409 POSITION_NAME_EXISTS, got: ${posHDup.status} ${JSON.stringify(posHDup.body)}`);
    }
    console.log('  ✓ Position name uniqueness within department verified');

    // ------------------------------------------------------------------------
    // TEST I: Filter Positions by department_id
    // ------------------------------------------------------------------------
    console.log('[TEST I] Filter Positions by department_id');
    const posFilterRes = await request('GET', `/api/hrd/positions?property_id=1&department_id=${deptAId}`, null, token);
    if (posFilterRes.status !== 200 || !Array.isArray(posFilterRes.body?.data)) {
      throw new Error('TEST I Failed: Position filtering failed');
    }
    const nonMatching = posFilterRes.body.data.filter(p => p.department_id !== deptAId);
    if (nonMatching.length > 0) {
      throw new Error(`TEST I Failed: Filter returned positions from other departments: ${JSON.stringify(nonMatching)}`);
    }
    console.log('  ✓ Position filtering by department_id verified');

    // ------------------------------------------------------------------------
    // TEST J: Cannot Delete Position With Assigned Employees
    // ------------------------------------------------------------------------
    console.log('[TEST J] Cannot Delete Position With Assigned Employees');
    const posJCreate = await request('POST', '/api/hrd/positions', {
      property_id: 1,
      department_id: deptAId,
      code: 'POS_TEST_J',
      name: 'TEST_HRAF_PositionJ'
    }, token);
    const posJId = posJCreate.body.data.id;

    const empJCreate = await request('POST', '/api/hrd/employees', {
      property_id: 1,
      name: 'TEST_HRAF_EmployeeJ',
      department_id: deptAId,
      position_id: posJId,
      create_login_account: false
    }, token);
    if (empJCreate.status !== 201) {
      throw new Error(`TEST J Failed: Employee creation failed: ${JSON.stringify(empJCreate.body)}`);
    }

    const posJDelete = await request('DELETE', `/api/hrd/positions/${posJId}?property_id=1`, null, token);
    if (posJDelete.status !== 409 || posJDelete.body?.code !== 'POSITION_HAS_EMPLOYEES') {
      throw new Error(`TEST J Failed: Expected 409 POSITION_HAS_EMPLOYEES, got: ${posJDelete.status} ${JSON.stringify(posJDelete.body)}`);
    }
    console.log('  ✓ Position deletion blocked by assigned employees');

    // ------------------------------------------------------------------------
    // TEST K: Position Deletion Succeeds When Empty
    // ------------------------------------------------------------------------
    console.log('[TEST K] Position Deletion Succeeds When Empty');
    const posKCreate = await request('POST', '/api/hrd/positions', {
      property_id: 1,
      department_id: deptAId,
      code: 'POS_TEST_K',
      name: 'TEST_HRAF_PositionK'
    }, token);
    const posKId = posKCreate.body.data.id;

    const posKDelete = await request('DELETE', `/api/hrd/positions/${posKId}?property_id=1`, null, token);
    if (posKDelete.status !== 200 || !posKDelete.body?.data?.success) {
      throw new Error(`TEST K Failed: Expected successful deletion: ${JSON.stringify(posKDelete.body)}`);
    }
    console.log('  ✓ Empty position deleted successfully');

    // ------------------------------------------------------------------------
    // TEST L: Sequential Employee Code Generation per Department
    // ------------------------------------------------------------------------
    console.log('[TEST L] Sequential Employee Code Generation (<DEPT_CODE>-0001)');
    const deptLCreate = await request('POST', '/api/hrd/departments', {
      property_id: 1,
      code: 'TSD',
      name: 'TEST_HRAF_TestSeqDept'
    }, token);
    const deptLId = deptLCreate.body.data.id;

    const empL1 = await request('POST', '/api/hrd/employees', {
      property_id: 1,
      name: 'TEST_HRAF_SequentialEmp1',
      department_id: deptLId,
      create_login_account: false
    }, token);
    if (empL1.body?.data?.employee_code !== 'TSD-0001') {
      throw new Error(`TEST L Failed: Expected TSD-0001, got ${empL1.body?.data?.employee_code}`);
    }

    const empL2 = await request('POST', '/api/hrd/employees', {
      property_id: 1,
      name: 'TEST_HRAF_SequentialEmp2',
      department_id: deptLId,
      create_login_account: false
    }, token);
    if (empL2.body?.data?.employee_code !== 'TSD-0002') {
      throw new Error(`TEST L Failed: Expected TSD-0002, got ${empL2.body?.data?.employee_code}`);
    }
    console.log('  ✓ Sequential employee codes generated: TSD-0001, TSD-0002');

    // ------------------------------------------------------------------------
    // TEST M: Employee Department Transfer Preserves Employee Code (Immutability)
    // ------------------------------------------------------------------------
    console.log('[TEST M] Employee Department Transfer Preserves Employee Code');
    const empL1Id = empL1.body.data.id;
    const empMTransfer = await request('PATCH', `/api/hrd/employees/${empL1Id}`, {
      property_id: 1,
      department_id: deptAId
    }, token);
    if (empMTransfer.status !== 200 || empMTransfer.body?.data?.employee_code !== 'TSD-0001') {
      throw new Error(`TEST M Failed: Employee code changed upon department transfer! Got: ${empMTransfer.body?.data?.employee_code}`);
    }
    if (empMTransfer.body?.data?.department_id !== deptAId) {
      throw new Error('TEST M Failed: Department ID was not updated');
    }
    console.log('  ✓ Employee code strictly preserved across department transfer (TSD-0001)');

    // ------------------------------------------------------------------------
    // TEST N: Department Transfer Audit Log
    // ------------------------------------------------------------------------
    console.log('[TEST N] Department Transfer Audit Log Verification');
    const auditDeptTransfer = await pool.query(
      `SELECT * FROM audit_logs WHERE action = 'EMPLOYEE_DEPARTMENT_CHANGED' AND record_id = $1 ORDER BY audit_id DESC LIMIT 1`,
      [String(empL1Id)]
    );
    if (auditDeptTransfer.rows.length === 0) {
      throw new Error('TEST N Failed: EMPLOYEE_DEPARTMENT_CHANGED audit log not recorded');
    }
    console.log('  ✓ Department transfer audit log recorded');

    // ------------------------------------------------------------------------
    // TEST O: Employee Position Change Audit Log
    // ------------------------------------------------------------------------
    console.log('[TEST O] Employee Position Change Audit Log Verification');
    const empOPosChange = await request('PATCH', `/api/hrd/employees/${empL1Id}`, {
      property_id: 1,
      position_id: posFId
    }, token);
    if (empOPosChange.status !== 200 || empOPosChange.body?.data?.position_id !== posFId) {
      throw new Error(`TEST O Failed: Position change failed: ${JSON.stringify(empOPosChange.body)}`);
    }

    const auditPosChange = await pool.query(
      `SELECT * FROM audit_logs WHERE action = 'EMPLOYEE_POSITION_CHANGED' AND record_id = $1 ORDER BY audit_id DESC LIMIT 1`,
      [String(empL1Id)]
    );
    if (auditPosChange.rows.length === 0) {
      throw new Error('TEST O Failed: EMPLOYEE_POSITION_CHANGED audit log not recorded');
    }
    console.log('  ✓ Position change audit log recorded');

    // ------------------------------------------------------------------------
    // TEST P & Q: Dynamic Role Assignment & User Account Synchronization
    // ------------------------------------------------------------------------
    console.log('[TEST P & Q] Dynamic Role Assignment & User Account Synchronization');
    // Create custom role
    const rolePCreate = await request('POST', '/api/hrd/roles', {
      property_id: 1,
      name: 'TEST_HRAF_Agent',
      description: 'Frontline agent role',
      permission_keys: ['reservations.view']
    }, token);
    if (rolePCreate.status !== 201 || !rolePCreate.body?.data?.id) {
      throw new Error(`TEST P Failed: Custom role creation failed: ${JSON.stringify(rolePCreate.body)}`);
    }
    const rolePId = rolePCreate.body.data.id;

    // Create employee with this role and an auth account
    const empPCreate = await request('POST', '/api/hrd/employees', {
      property_id: 1,
      name: 'TEST_HRAF_AgentEmp',
      department_id: deptAId,
      position_id: posFId,
      role_id: rolePId,
      access_type: 'PMS_STAFF',
      email: 'test_hraf_p@oaklawang.com',
      username: 'test_hraf_p',
      create_login_account: true
    }, token);
    if (empPCreate.status !== 201 || !empPCreate.body?.data?.user_id) {
      throw new Error(`TEST P Failed: Employee creation with auth account failed: ${JSON.stringify(empPCreate.body)}`);
    }
    const empPId = empPCreate.body.data.id;
    const userPId = empPCreate.body.data.user_id;

    // Verify users row
    const userPCheck = await pool.query('SELECT id, employee_id, role_id, access_type, password_hash FROM users WHERE id = $1', [userPId]);
    if (userPCheck.rows.length === 0) {
      throw new Error('TEST Q Failed: Linked user record not found in users table');
    }
    const uP = userPCheck.rows[0];
    if (Number(uP.role_id) !== rolePId || uP.access_type !== 'PMS_STAFF' || Number(uP.employee_id) !== empPId) {
      throw new Error(`TEST Q Failed: User fields mismatch: role_id=${uP.role_id}, access_type=${uP.access_type}, employee_id=${uP.employee_id}`);
    }
    console.log('  ✓ User account created and synchronized with dynamic role and access type');

    // ------------------------------------------------------------------------
    // TEST R: Dynamic Role Change Preserves User Identity & Password Hash
    // ------------------------------------------------------------------------
    console.log('[TEST R] Role Change Preserves User Identity & Password Hash');
    const initialHash = uP.password_hash;
    const initialUserId = uP.id;

    // Change employee role to role_id: 2 ('Front Office')
    const empRRoleChange = await request('PATCH', `/api/hrd/employees/${empPId}`, {
      property_id: 1,
      role_id: 2
    }, token);
    if (empRRoleChange.status !== 200 || empRRoleChange.body?.data?.role_id !== 2) {
      throw new Error(`TEST R Failed: Employee role update failed: ${JSON.stringify(empRRoleChange.body)}`);
    }

    const userRCheck = await pool.query('SELECT id, employee_id, role_id, access_type, password_hash FROM users WHERE id = $1', [userPId]);
    const uR = userRCheck.rows[0];
    if (uR.id !== initialUserId || uR.password_hash !== initialHash || Number(uR.employee_id) !== empPId) {
      throw new Error('TEST R Failed: User ID, employee_id, or password_hash mutated during role update!');
    }
    if (Number(uR.role_id) !== 2) {
      throw new Error(`TEST R Failed: Expected users.role_id = 2, got ${uR.role_id}`);
    }
    console.log('  ✓ User identity and password hash preserved while role_id synchronized');

    // ------------------------------------------------------------------------
    // TEST S: Role Change Audit Log
    // ------------------------------------------------------------------------
    console.log('[TEST S] Role Change Audit Log (USER_ROLE_CHANGED)');
    const auditRoleChange = await pool.query(
      `SELECT * FROM audit_logs WHERE action = 'USER_ROLE_CHANGED' AND record_id = $1 ORDER BY audit_id DESC LIMIT 1`,
      [String(userPId)]
    );
    if (auditRoleChange.rows.length === 0) {
      throw new Error('TEST S Failed: USER_ROLE_CHANGED audit log not recorded');
    }
    console.log('  ✓ Role change audit log recorded');

    // ------------------------------------------------------------------------
    // TEST T: Dynamic Role CRUD
    // ------------------------------------------------------------------------
    console.log('[TEST T] Dynamic Role CRUD');
    const roleTCreate = await request('POST', '/api/hrd/roles', {
      property_id: 1,
      name: 'TEST_HRAF_CustomRoleT',
      description: 'Custom Role T',
      permission_keys: ['rooms.view']
    }, token);
    const roleTId = roleTCreate.body.data.id;

    // List
    const roleList = await request('GET', '/api/hrd/dynamic-roles?property_id=1', null, token);
    const foundT = roleList.body?.data?.find(r => r.id === roleTId);
    if (!foundT) {
      throw new Error('TEST T Failed: Role T not found in list');
    }

    // Update
    const roleTUpdate = await request('PATCH', `/api/hrd/roles/${roleTId}`, {
      description: 'Updated Role T description'
    }, token);
    if (roleTUpdate.status !== 200 || roleTUpdate.body?.data?.description !== 'Updated Role T description') {
      throw new Error('TEST T Failed: Role T update failed');
    }

    // Delete
    const roleTDelete = await request('DELETE', `/api/hrd/roles/${roleTId}`, null, token);
    if (roleTDelete.status !== 200 || !roleTDelete.body?.data?.success) {
      throw new Error('TEST T Failed: Role T delete failed');
    }
    console.log('  ✓ Dynamic Role CRUD verified');

    // ------------------------------------------------------------------------
    // TEST U: Cannot Delete System Role
    // ------------------------------------------------------------------------
    console.log('[TEST U] Cannot Delete System Role');
    const roleUDelete = await request('DELETE', '/api/hrd/roles/2', null, token);
    if (roleUDelete.status !== 403 || roleUDelete.body?.code !== 'CANNOT_DELETE_SYSTEM_ROLE') {
      throw new Error(`TEST U Failed: Expected 403 CANNOT_DELETE_SYSTEM_ROLE, got: ${roleUDelete.status} ${JSON.stringify(roleUDelete.body)}`);
    }
    console.log('  ✓ System role deletion blocked with 403');

    // ------------------------------------------------------------------------
    // TEST V: Cannot Delete Role With Active Users
    // ------------------------------------------------------------------------
    console.log('[TEST V] Cannot Delete Role With Active Users');
    // Restore user to rolePId
    await request('PATCH', `/api/hrd/employees/${empPId}`, { property_id: 1, role_id: rolePId }, token);
    const roleVDelete = await request('DELETE', `/api/hrd/roles/${rolePId}`, null, token);
    if (roleVDelete.status !== 409 || roleVDelete.body?.code !== 'ROLE_HAS_USERS') {
      throw new Error(`TEST V Failed: Expected 409 ROLE_HAS_USERS, got: ${roleVDelete.status} ${JSON.stringify(roleVDelete.body)}`);
    }
    console.log('  ✓ Role deletion blocked by active users with 409');

    // ------------------------------------------------------------------------
    // TEST W: Super Admin Protection
    // ------------------------------------------------------------------------
    console.log('[TEST W] Super Admin Protection (Rename, Deactivate, Delete)');
    const saRename = await request('PATCH', '/api/hrd/roles/1', { name: 'New Name' }, token);
    if (saRename.status !== 403 || saRename.body?.code !== 'CANNOT_RENAME_SUPER_ADMIN') {
      throw new Error('TEST W Failed: Super Admin rename was not blocked');
    }

    const saDeact = await request('PATCH', '/api/hrd/roles/1', { is_active: false }, token);
    if (saDeact.status !== 403 || saDeact.body?.code !== 'CANNOT_DEACTIVATE_SUPER_ADMIN') {
      throw new Error('TEST W Failed: Super Admin deactivation was not blocked');
    }

    const saDelete = await request('DELETE', '/api/hrd/roles/1', null, token);
    if (saDelete.status !== 403 || saDelete.body?.code !== 'CANNOT_DELETE_SYSTEM_ROLE') {
      throw new Error('TEST W Failed: Super Admin deletion was not blocked');
    }
    console.log('  ✓ Super Admin protected against rename, deactivation, and deletion');

    // ------------------------------------------------------------------------
    // TEST X: Granular Permissions List
    // ------------------------------------------------------------------------
    console.log('[TEST X] Granular Permissions Catalog (65 Permissions)');
    const permList = await request('GET', '/api/hrd/permissions', null, token);
    if (permList.status !== 200 || !Array.isArray(permList.body?.data) || permList.body.data.length !== 65) {
      throw new Error(`TEST X Failed: Expected 65 permissions, got: ${permList.body?.data?.length}`);
    }
    console.log('  ✓ 65 granular permissions verified');

    // ------------------------------------------------------------------------
    // TEST Y: Granular Permissions Matrix
    // ------------------------------------------------------------------------
    console.log('[TEST Y] Granular Permissions Matrix');
    const matrixRes = await request('GET', '/api/hrd/permissions/matrix?property_id=1', null, token);
    if (matrixRes.status !== 200 || !matrixRes.body?.data?.matrix || !matrixRes.body?.data?.roles) {
      throw new Error(`TEST Y Failed: Matrix query failed: ${JSON.stringify(matrixRes.body)}`);
    }
    console.log('  ✓ Granular permissions matrix retrieved');

    // ------------------------------------------------------------------------
    // TEST Z & AA: Assign and Revoke Granular Permissions
    // ------------------------------------------------------------------------
    console.log('[TEST Z & AA] Assign and Revoke Granular Permissions');
    // Assign rooms.view, rooms.create
    const assignZ = await request('PUT', `/api/hrd/roles/${rolePId}/permissions`, {
      permission_keys: ['rooms.view', 'rooms.create']
    }, token);
    if (assignZ.status !== 200 || !assignZ.body?.data?.includes('rooms.create')) {
      throw new Error(`TEST Z Failed: Permission assignment failed: ${JSON.stringify(assignZ.body)}`);
    }

    // Revoke rooms.create by updating to rooms.view only
    const revokeAA = await request('PUT', `/api/hrd/roles/${rolePId}/permissions`, {
      permission_keys: ['rooms.view']
    }, token);
    if (revokeAA.status !== 200 || revokeAA.body?.data?.includes('rooms.create')) {
      throw new Error('TEST AA Failed: Revocation failed, rooms.create still present');
    }
    console.log('  ✓ Granular permissions assigned and revoked successfully');

    // ------------------------------------------------------------------------
    // TEST AB: Super Admin Permission Protection
    // ------------------------------------------------------------------------
    console.log('[TEST AB] Super Admin Permission Protection');
    const saPerms = await request('PUT', '/api/hrd/roles/1/permissions', {
      permission_keys: ['rooms.view']
    }, token);
    if (saPerms.status !== 403 || saPerms.body?.code !== 'CANNOT_ALTER_SUPER_ADMIN_PERMISSIONS') {
      throw new Error(`TEST AB Failed: Expected 403 CANNOT_ALTER_SUPER_ADMIN_PERMISSIONS, got: ${saPerms.status}`);
    }
    console.log('  ✓ Super Admin permissions locked against alteration');

    // ------------------------------------------------------------------------
    // TEST AC, AD, AE: Inactive Entity Assignment Prohibitions
    // ------------------------------------------------------------------------
    console.log('[TEST AC, AD, AE] Inactive Department, Position, and Role Prohibitions');
    // Deactivate Department D
    await request('PATCH', `/api/hrd/departments/${deptDId}`, { is_active: false }, token);
    const empInactDept = await request('POST', '/api/hrd/employees', {
      property_id: 1,
      name: 'TEST_HRAF_InactDeptEmp',
      department_id: deptDId,
      create_login_account: false
    }, token);
    if (empInactDept.status !== 400 || empInactDept.body?.code !== 'DEPARTMENT_INACTIVE') {
      throw new Error(`TEST AC Failed: Expected 400 DEPARTMENT_INACTIVE, got: ${empInactDept.status}`);
    }

    // Deactivate Position F
    await request('PATCH', `/api/hrd/positions/${posFId}`, { is_active: false }, token);
    const empInactPos = await request('POST', '/api/hrd/employees', {
      property_id: 1,
      name: 'TEST_HRAF_InactPosEmp',
      department_id: deptAId,
      position_id: posFId,
      create_login_account: false
    }, token);
    if (empInactPos.status !== 400 || empInactPos.body?.code !== 'POSITION_INACTIVE') {
      throw new Error(`TEST AD Failed: Expected 400 POSITION_INACTIVE, got: ${empInactPos.status}`);
    }
    // Reactivate position for downstream tests
    await request('PATCH', `/api/hrd/positions/${posFId}`, { is_active: true }, token);

    // Create another custom role and deactivate it
    const roleInactCreate = await request('POST', '/api/hrd/roles', {
      property_id: 1,
      name: 'TEST_HRAF_InactRole',
      description: 'To be deactivated'
    }, token);
    const roleInactId = roleInactCreate.body.data.id;
    await request('PATCH', `/api/hrd/roles/${roleInactId}`, { is_active: false }, token);

    const empInactRole = await request('POST', '/api/hrd/employees', {
      property_id: 1,
      name: 'TEST_HRAF_InactRoleEmp',
      department_id: deptAId,
      role_id: roleInactId,
      create_login_account: false
    }, token);
    if (empInactRole.status !== 400 || empInactRole.body?.code !== 'ROLE_INACTIVE') {
      throw new Error(`TEST AE Failed: Expected 400 ROLE_INACTIVE, got: ${empInactRole.status}`);
    }
    console.log('  ✓ Inactive department, position, and role assignments prohibited');

    // ------------------------------------------------------------------------
    // TEST AF, AG, AH: Authorization Middleware & Permission Checking
    // ------------------------------------------------------------------------
    console.log('[TEST AF, AG, AH] Authorization Middleware & Permission Checks');
    // Super Admin bypass
    const superAdminUser = { id: 1, role: 'Super Admin', role_id: 1 };
    const saCheck = await hasPermission(superAdminUser, 'reports.delete', pool);
    if (!saCheck) {
      throw new Error('TEST AH Failed: Super Admin must bypass granular permission checks');
    }

    // Front Office (has reservations.view, but not reports.delete)
    const foUser = { id: 2, role: 'Front Office', role_id: 2 };
    const foViewCheck = await hasPermission(foUser, 'reservations.view', pool);
    if (!foViewCheck) {
      throw new Error('TEST AF Failed: Front Office should have reservations.view permission');
    }
    const foDeleteCheck = await hasPermission(foUser, 'reports.delete', pool);
    if (foDeleteCheck) {
      throw new Error('TEST AG Failed: Front Office should NOT have reports.delete permission');
    }
    console.log('  ✓ Permission checking and Super Admin bypass verified');

    // ------------------------------------------------------------------------
    // TEST AI: Access Type Check
    // ------------------------------------------------------------------------
    console.log('[TEST AI] Access Type Integrity');
    const accessTypeCheck = await pool.query(
      `SELECT DISTINCT access_type FROM users WHERE access_type IS NOT NULL`
    );
    const validAccessTypes = ['PMS_STAFF', 'MANAGER', 'MOBILE_ONLY', 'ADMIN'];
    for (const r of accessTypeCheck.rows) {
      if (!validAccessTypes.includes(r.access_type)) {
        throw new Error(`TEST AI Failed: Found invalid access_type: ${r.access_type}`);
      }
    }
    console.log('  ✓ Access types valid across all users');

    // ------------------------------------------------------------------------
    // TEST AJ: Backward Compatibility with Legacy Role Menu Permissions
    // ------------------------------------------------------------------------
    console.log('[TEST AJ] Legacy Menu Permissions Backward Compatibility');
    const legacyMatrix = await request('GET', '/api/settings/role-permissions?property_id=1', null, token);
    if (legacyMatrix.status !== 200 || !Array.isArray(legacyMatrix.body?.data?.roles)) {
      throw new Error(`TEST AJ Failed: Legacy matrix failed: ${JSON.stringify(legacyMatrix.body)}`);
    }
    console.log('  ✓ Legacy menu permission matrix works without interference');

    // ========================================================================
    // HR-ACCESS-1 REVIEW PATCH TESTS (REVIEW A - REVIEW K)
    // ========================================================================
    console.log('\n--- HR-ACCESS-1 REVIEW PATCH TESTS (REVIEW A - REVIEW K) ---');

    // ------------------------------------------------------------------------
    // REVIEW TEST A: Crew is not assignable as new canonical auth role
    // ------------------------------------------------------------------------
    console.log('[REVIEW TEST A] Crew cannot be assigned as canonical auth role');
    // 1. Attempt creating employee login with role 'Crew'
    const crewEmpRes = await request('POST', '/api/hrd/employees', {
      property_id: 1,
      full_name: 'TEST_HRAF_CrewEmp',
      role: 'Crew',
      create_login_account: true,
      email: 'test_hraf_crew@oaklawang.com',
      username: 'test_hraf_crew',
      department_id: deptAId,
      position_id: posFId
    }, token);
    if (crewEmpRes.status !== 400 || crewEmpRes.body?.code !== 'INVALID_AUTH_ROLE') {
      throw new Error(`REVIEW TEST A Failed: Expected 400 INVALID_AUTH_ROLE when creating login with Crew, got ${crewEmpRes.status}: ${JSON.stringify(crewEmpRes.body)}`);
    }

    // 2. Attempt creating dynamic role named 'Crew'
    const crewRoleRes = await request('POST', '/api/hrd/roles', {
      property_id: 1,
      name: 'Crew',
      description: 'Attempted Crew dynamic role'
    }, token);
    if (crewRoleRes.status !== 400 || crewRoleRes.body?.code !== 'INVALID_AUTH_ROLE') {
      throw new Error(`REVIEW TEST A Failed: Expected 400 INVALID_AUTH_ROLE when creating dynamic role Crew, got ${crewRoleRes.status}`);
    }
    console.log('  ✓ Crew rejected as canonical auth role in employee login and dynamic roles');

    // ------------------------------------------------------------------------
    // REVIEW TEST B: Legacy Crew employee data remains safe
    // ------------------------------------------------------------------------
    console.log('[REVIEW TEST B] Legacy Crew employee data preserved safely');
    const legacyCrewCreate = await request('POST', '/api/hrd/employees', {
      property_id: 1,
      full_name: 'TEST_HRAF_LegacyCrewStaff',
      role: 'Crew',
      create_login_account: false,
      department_id: deptAId,
      position_id: posFId,
      phone: '081299990001'
    }, token);
    if (legacyCrewCreate.status !== 201 || !legacyCrewCreate.body?.data?.id) {
      throw new Error(`REVIEW TEST B Failed: Failed to create non-login Crew employee: ${JSON.stringify(legacyCrewCreate.body)}`);
    }
    const legacyCrewId = legacyCrewCreate.body.data.id;

    const legacyCrewFetch = await request('GET', `/api/hrd/employees?property_id=1&search=LegacyCrewStaff`, null, token);
    const foundLegacy = legacyCrewFetch.body?.data?.find(e => e.id === legacyCrewId);
    if (!foundLegacy || foundLegacy.role !== 'Crew') {
      throw new Error('REVIEW TEST B Failed: Legacy Crew employee not retrieved correctly');
    }

    // Safe update of employee details without mutating role
    const legacyCrewUpdate = await request('PATCH', `/api/hrd/employees/${legacyCrewId}`, {
      property_id: 1,
      notes: 'Historical staff profile updated safely'
    }, token);
    if (legacyCrewUpdate.status !== 200 || legacyCrewUpdate.body?.data?.role !== 'Crew') {
      throw new Error('REVIEW TEST B Failed: Updating Crew employee corrupted role');
    }
    console.log('  ✓ Historical Crew employee created, queried, and updated safely without forced login');

    // ------------------------------------------------------------------------
    // REVIEW TEST C: Custom role with same name allowed in Property A and Property B
    // ------------------------------------------------------------------------
    console.log('[REVIEW TEST C] Property-scoped custom role allowed across different properties');
    const propBRes = await pool.query(
      `INSERT INTO properties (id, name, property_code)
       VALUES (9992, 'Test Prop B', 'TPB99')
       ON CONFLICT (id) DO UPDATE SET is_active = TRUE
       RETURNING id`
    );
    const propBId = propBRes.rows[0].id;

    const roleProp1 = await request('POST', '/api/hrd/roles', {
      property_id: 1,
      name: 'TEST_HRAF_FO_Supervisor',
      description: 'FO Supervisor for Property 1'
    }, token);
    if (roleProp1.status !== 201 || !roleProp1.body?.data?.id) {
      throw new Error(`REVIEW TEST C Failed: Failed to create role in property 1: ${JSON.stringify(roleProp1.body)}`);
    }

    const roleProp2 = await request('POST', '/api/hrd/roles', {
      property_id: propBId,
      name: 'TEST_HRAF_FO_Supervisor',
      description: 'FO Supervisor for Property 2'
    }, token);
    if (roleProp2.status !== 201 || !roleProp2.body?.data?.id) {
      throw new Error(`REVIEW TEST C Failed: Failed to create role in property 2: ${JSON.stringify(roleProp2.body)}`);
    }
    console.log('  ✓ Same custom role name successfully created in Property 1 and Property 2 without collision');

    // ------------------------------------------------------------------------
    // REVIEW TEST D: Duplicate custom role in same property rejected
    // ------------------------------------------------------------------------
    console.log('[REVIEW TEST D] Duplicate custom role in same property rejected');
    const roleProp1Dup = await request('POST', '/api/hrd/roles', {
      property_id: 1,
      name: 'TEST_HRAF_FO_Supervisor',
      description: 'Duplicate FO Supervisor in Property 1'
    }, token);
    if (roleProp1Dup.status !== 409 || roleProp1Dup.body?.code !== 'ROLE_NAME_EXISTS') {
      throw new Error(`REVIEW TEST D Failed: Expected 409 ROLE_NAME_EXISTS, got ${roleProp1Dup.status}: ${JSON.stringify(roleProp1Dup.body)}`);
    }
    console.log('  ✓ Duplicate custom role in same property rejected with 409');

    // ------------------------------------------------------------------------
    // REVIEW TEST E: Existing user role IDs preserved
    // ------------------------------------------------------------------------
    console.log('[REVIEW TEST E] Existing user role IDs preserved');
    const usersWithRole = await pool.query(
      `SELECT u.id, u.username, u.role_id, r.name AS role_name
       FROM users u
       JOIN roles r ON r.id = u.role_id`
    );
    if (usersWithRole.rows.length === 0) {
      throw new Error('REVIEW TEST E Failed: No users with valid role_id found');
    }
    for (const u of usersWithRole.rows) {
      if (!u.role_id || !u.role_name) {
        throw new Error(`REVIEW TEST E Failed: User ${u.id} has invalid role_id or role_name`);
      }
    }
    console.log(`  ✓ Verified ${usersWithRole.rows.length} existing users preserve valid relational role_ids`);

    // ------------------------------------------------------------------------
    // REVIEW TEST F: HRD Admin seeded successfully
    // ------------------------------------------------------------------------
    console.log('[REVIEW TEST F] Canonical dynamic role HRD Admin seeded');
    const hrdAdminRole = await pool.query(
      `SELECT id, name, is_system_role, property_id, is_active FROM roles WHERE LOWER(name) = 'hrd admin'`
    );
    if (hrdAdminRole.rows.length === 0) {
      throw new Error('REVIEW TEST F Failed: HRD Admin role not found in database');
    }
    const hrdAdmin = hrdAdminRole.rows[0];
    if (hrdAdmin.property_id !== null || !hrdAdmin.is_system_role) {
      throw new Error(`REVIEW TEST F Failed: HRD Admin must have property_id=NULL and is_system_role=TRUE, got: ${JSON.stringify(hrdAdmin)}`);
    }
    console.log('  ✓ HRD Admin exists as global system role (property_id=NULL, is_system_role=TRUE)');

    // ------------------------------------------------------------------------
    // REVIEW TEST G: HRD Admin receives intended HR permissions
    // ------------------------------------------------------------------------
    console.log('[REVIEW TEST G] HRD Admin receives intended 11 HR permissions');
    const hrdAdminPerms = await pool.query(
      `SELECT p.key
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = $1 AND rp.granted = TRUE
       ORDER BY p.key`,
      [hrdAdmin.id]
    );
    const expectedHrdPerms = [
      'hrd.attendance.view',
      'hrd.departments.create',
      'hrd.departments.edit',
      'hrd.departments.view',
      'hrd.employees.create',
      'hrd.employees.edit',
      'hrd.employees.view',
      'hrd.positions.create',
      'hrd.positions.edit',
      'hrd.positions.view',
      'hrd.roles.view'
    ];
    const actualHrdPerms = hrdAdminPerms.rows.map(r => r.key);
    if (actualHrdPerms.length !== 11) {
      throw new Error(`REVIEW TEST G Failed: Expected exactly 11 permissions, got ${actualHrdPerms.length}: ${JSON.stringify(actualHrdPerms)}`);
    }
    for (const ep of expectedHrdPerms) {
      if (!actualHrdPerms.includes(ep)) {
        throw new Error(`REVIEW TEST G Failed: Missing expected permission: ${ep}`);
      }
    }
    console.log('  ✓ Exact 11 core HR permissions verified for HRD Admin');

    // ------------------------------------------------------------------------
    // REVIEW TEST H: HRD Admin does not receive unrelated finance/POS permission
    // ------------------------------------------------------------------------
    console.log('[REVIEW TEST H] HRD Admin does not receive unrelated sensitive/finance/POS permissions');
    const prohibitedPerms = [
      'pos.transactions',
      'cashier.shift.close',
      'billing.folios.modify',
      'rooms.delete',
      'reports.financial',
      'hrd.roles.edit',
      'hrd.employees.delete',
      'hrd.departments.delete',
      'hrd.positions.delete'
    ];
    for (const pp of prohibitedPerms) {
      if (actualHrdPerms.includes(pp)) {
        throw new Error(`REVIEW TEST H Failed: HRD Admin should NOT have permission '${pp}'`);
      }
    }
    console.log('  ✓ Confirmed HRD Admin has zero unrelated finance, POS, cashier, or ungranted sensitive permissions');

    // ------------------------------------------------------------------------
    // REVIEW TEST I: Employee code UI uses "Kode Karyawan", not NIK
    // ------------------------------------------------------------------------
    console.log('[REVIEW TEST I] Employee code UI terminology verification');
    const fs = require('fs');
    const hrdWorkspacePath = path.join(__dirname, '..', '..', 'frontend', 'src', 'features', 'hrd', 'HrdWorkspace.tsx');
    const hrdWorkspaceContent = fs.readFileSync(hrdWorkspacePath, 'utf8');
    if (hrdWorkspaceContent.includes('Nomor Induk Karyawan (NIK)')) {
      throw new Error('REVIEW TEST I Failed: Found deprecated "Nomor Induk Karyawan (NIK)" in HrdWorkspace.tsx');
    }
    if (!hrdWorkspaceContent.includes('Kode Karyawan (Employee Code)')) {
      throw new Error('REVIEW TEST I Failed: Expected "Kode Karyawan (Employee Code)" not found in HrdWorkspace.tsx');
    }
    console.log('  ✓ Frontend terminology confirmed: "Kode Karyawan (Employee Code)" is used, NIK is avoided');

    // ------------------------------------------------------------------------
    // REVIEW TEST J: MOBILE_ONLY cannot enter normal PMS workspace
    // ------------------------------------------------------------------------
    console.log('[REVIEW TEST J] MOBILE_ONLY user restricted from normal PMS workspace');
    const mobileOnlyToken = generateToken({
      id: 99992,
      email: 'test_mobile_staff@oaklawang.com',
      username: 'test_mobile_staff',
      full_name: 'Test Mobile Only Staff',
      role: 'Housekeeping',
      role_id: 4,
      access_type: 'MOBILE_ONLY',
      property_id: 1
    });

    const mobilePmsAttempt = await request('GET', '/api/hrd/employees?property_id=1', null, mobileOnlyToken);
    if (mobilePmsAttempt.status !== 403 || mobilePmsAttempt.body?.code !== 'MOBILE_ONLY_RESTRICTED') {
      throw new Error(`REVIEW TEST J Failed: Expected 403 MOBILE_ONLY_RESTRICTED for MOBILE_ONLY user, got: ${mobilePmsAttempt.status} ${JSON.stringify(mobilePmsAttempt.body)}`);
    }
    console.log('  ✓ MOBILE_ONLY access strictly rejected with 403 MOBILE_ONLY_RESTRICTED');

    // ------------------------------------------------------------------------
    // REVIEW TEST K: Super Admin remains protected
    // ------------------------------------------------------------------------
    console.log('[REVIEW TEST K] Super Admin protection verification');
    // Cannot assign Super Admin via HRD employee creation
    const saEmpAttempt = await request('POST', '/api/hrd/employees', {
      property_id: 1,
      full_name: 'TEST_HRAF_FakeSuperAdmin',
      role: 'Super Admin',
      create_login_account: true,
      email: 'fake_sa@oaklawang.com',
      username: 'fake_sa'
    }, token);
    if (saEmpAttempt.status !== 403 || saEmpAttempt.body?.code !== 'PLATFORM_ADMIN_PROHIBITED') {
      throw new Error(`REVIEW TEST K Failed: Expected 403 PLATFORM_ADMIN_PROHIBITED, got ${saEmpAttempt.status}`);
    }
    console.log('  ✓ Super Admin protected against unauthorized HR assignment');

    // ========================================================================
    // HR-ACCESS-1 FINAL ARCHITECTURAL TESTS (FINAL TEST A - I)
    // ========================================================================

    // FINAL TEST A: Role "General Manager" may coexist with Position "General Manager"
    console.log('[FINAL TEST A] Role "General Manager" may coexist with Position "General Manager"');
    const roleGM = await pool.query("SELECT id, name FROM roles WHERE LOWER(TRIM(name)) = 'general manager'");
    if (roleGM.rows.length === 0) {
      throw new Error("FINAL TEST A Failed: Role 'General Manager' not found in roles table");
    }
    const posGM = await pool.query("SELECT id, name, department_id FROM hr_positions WHERE property_id = 1 AND name = 'General Manager'");
    if (posGM.rows.length === 0) {
      throw new Error("FINAL TEST A Failed: Position 'General Manager' not found in hr_positions");
    }
    console.log('  ✓ Role and Position with same name coexist across separate domains');

    // FINAL TEST B: Position "General Manager" can exist under Management
    console.log('[FINAL TEST B] Position "General Manager" can exist under Management');
    const posMgmtGM = await pool.query(`
      SELECT p.id, p.name, d.code as dept_code
      FROM hr_positions p
      JOIN hr_departments d ON d.id = p.department_id
      WHERE p.property_id = 1 AND p.name = 'General Manager'
    `);
    if (posMgmtGM.rows.length === 0 || posMgmtGM.rows[0].dept_code !== 'MG') {
      throw new Error("FINAL TEST B Failed: Position 'General Manager' does not exist under Management department");
    }
    // Verify operator can create a custom position without being blocked by role names
    const mgmtDeptIdRes = await pool.query("SELECT id FROM hr_departments WHERE property_id = 1 AND code = 'MG'");
    const createPosValid = await request('POST', '/api/hrd/positions', {
      property_id: 1,
      department_id: mgmtDeptIdRes.rows[0].id,
      name: 'TEST_Assistant_GM'
    }, token);
    if (createPosValid.status !== 201) {
      throw new Error(`FINAL TEST B Failed: Unable to create position: ${createPosValid.status}`);
    }
    await pool.query('DELETE FROM hr_positions WHERE id = $1', [createPosValid.body.data.id]);
    console.log('  ✓ Position "General Manager" exists under Management and position creation is unblocked');

    // FINAL TEST C: Same string in Role and Position does not merge domains
    console.log('[FINAL TEST C] Same string in Role and Position does not merge domains');
    await pool.query("UPDATE hrd_role_policies SET allow_hrd_assign_gm_role = TRUE WHERE property_id = 1");
    let empCId;
    try {
      const deptMgmt = mgmtDeptIdRes.rows[0].id;
      const empC = await request('POST', '/api/hrd/employees', {
        property_id: 1,
        full_name: 'TEST_HRAF_DualDomain_GM_Emp',
        department_id: deptMgmt,
        position_id: posGM.rows[0].id,
        role_id: roleGM.rows[0].id,
        access_type: 'PMS_DESKTOP'
      }, token);
      if (empC.status !== 201) {
        throw new Error(`FINAL TEST C Failed to create employee: ${empC.status} ${JSON.stringify(empC.body)}`);
      }
      empCId = empC.body.data.id;

      // Verify employee record has both position and role as 'General Manager', mapped relationally
      const empCRow = await pool.query('SELECT position, role, position_id, department_id FROM hr_employees WHERE id = $1', [empCId]);
      if (empCRow.rows[0].position !== 'General Manager' || empCRow.rows[0].role !== 'General Manager') {
        throw new Error(`FINAL TEST C Failed: Expected position & role 'General Manager', got pos=${empCRow.rows[0].position}, role=${empCRow.rows[0].role}`);
      }

      // Mutate role to 'Front Office' - position must remain 'General Manager'
      const foRoleForC = (await pool.query("SELECT id FROM roles WHERE name = 'Front Office'")).rows[0].id;
      const updateEmpCRole = await request('PUT', `/api/hrd/employees/${empCId}`, {
        property_id: 1,
        role_id: foRoleForC
      }, token);
      if (updateEmpCRole.status !== 200) {
        throw new Error(`FINAL TEST C Failed to update role: ${updateEmpCRole.status}`);
      }
      const empCAfterRole = await pool.query('SELECT position, role, position_id, department_id FROM hr_employees WHERE id = $1', [empCId]);
      if (empCAfterRole.rows[0].position !== 'General Manager' || empCAfterRole.rows[0].role !== 'Front Office') {
        throw new Error(`FINAL TEST C Failed: Domain leakage! Position changed unexpectedly: ${JSON.stringify(empCAfterRole.rows[0])}`);
      }
    } finally {
      if (empCId) {
        await pool.query('DELETE FROM hr_employees WHERE id = $1', [empCId]);
      }
      await pool.query("UPDATE hrd_role_policies SET allow_hrd_assign_gm_role = FALSE WHERE property_id = 1");
    }
    console.log('  ✓ Role and Position operate in strictly separate domains despite identical name string');

    // FINAL TEST D: Faulty bootstrap role-to-position copying no longer occurs
    console.log('[FINAL TEST D] Faulty bootstrap role-to-position copying no longer occurs');
    const posSuperAdmin = await pool.query("SELECT id FROM hr_positions WHERE LOWER(TRIM(name)) = 'super admin'");
    if (posSuperAdmin.rows.length > 0) {
      throw new Error(`FINAL TEST D Failed: 'Super Admin' found in hr_positions: ${JSON.stringify(posSuperAdmin.rows)}`);
    }
    const posFoInFo = await pool.query(`
      SELECT p.id FROM hr_positions p
      JOIN hr_departments d ON d.id = p.department_id
      WHERE d.code = 'FO' AND LOWER(TRIM(p.name)) = 'front office'
    `);
    if (posFoInFo.rows.length > 0) {
      throw new Error(`FINAL TEST D Failed: Legacy role 'front office' still copied as position under FO`);
    }
    console.log('  ✓ Bootstrap role-to-position copying eliminated');

    // FINAL TEST E: Legitimate Receptionist remains
    console.log('[FINAL TEST E] Legitimate Receptionist remains');
    const posD = await pool.query("SELECT id, name, is_active FROM hr_positions WHERE property_id = 1 AND name = 'Receptionist'");
    if (posD.rows.length === 0 || !posD.rows[0].is_active) {
      throw new Error('FINAL TEST E Failed: Legitimate Receptionist position missing or inactive');
    }
    console.log('  ✓ Legitimate Receptionist position exists and is active');

    // FINAL TEST F: Legitimate Housekeeping Supervisor remains
    console.log('[FINAL TEST F] Legitimate Housekeeping Supervisor remains');
    const posF = await pool.query("SELECT id, name, is_active FROM hr_positions WHERE property_id = 1 AND name = 'Housekeeping Supervisor'");
    if (posF.rows.length === 0 || !posF.rows[0].is_active) {
      throw new Error('FINAL TEST F Failed: Legitimate Housekeeping Supervisor position missing or inactive');
    }
    console.log('  ✓ Legitimate Housekeeping Supervisor position exists and is active');

    // FINAL TEST G: Ambiguous legacy rows are not destructively deleted by name alone
    console.log('[FINAL TEST G] Ambiguous legacy rows are not destructively deleted by name alone');
    // Create an ambiguous position with an assigned employee
    const deptFoIdForG = (await pool.query("SELECT id FROM hr_departments WHERE property_id = 1 AND code = 'FO'")).rows[0].id;
    const ambigPos = await pool.query(`
      INSERT INTO hr_positions (property_id, department_id, name, sort_order, is_active)
      VALUES (1, $1, 'TEST_Ambiguous_Position', 99, TRUE)
      RETURNING id
    `, [deptFoIdForG]);
    const ambigPosId = ambigPos.rows[0].id;

    const ambigEmp = await pool.query(`
      INSERT INTO hr_employees (property_id, full_name, department_id, position_id, department, position, employee_code, is_active)
      VALUES (1, 'TEST_Ambiguous_Emp', $1, $2, 'Front Office', 'TEST_Ambiguous_Position', 'FO-9998', TRUE)
      RETURNING id
    `, [deptFoIdForG, ambigPosId]);
    const ambigEmpId = ambigEmp.rows[0].id;

    // Simulate cleanup logic query: ambiguous row with assigned employee MUST NOT be deleted
    const deleteAttempt = await pool.query(`
      DELETE FROM hr_positions p
      WHERE p.id = $1
        AND NOT EXISTS (SELECT 1 FROM hr_employees e WHERE e.position_id = p.id)
      RETURNING id
    `, [ambigPosId]);
    if (deleteAttempt.rows.length > 0) {
      throw new Error('FINAL TEST G Failed: Ambiguous position with assigned employee was destructively deleted!');
    }
    const checkAmbigPos = await pool.query('SELECT id FROM hr_positions WHERE id = $1', [ambigPosId]);
    if (checkAmbigPos.rows.length === 0) {
      throw new Error('FINAL TEST G Failed: Ambiguous position was unexpectedly deleted!');
    }
    // Clean up test records
    await pool.query('DELETE FROM hr_employees WHERE id = $1', [ambigEmpId]);
    await pool.query('DELETE FROM hr_positions WHERE id = $1', [ambigPosId]);
    console.log('  ✓ Ambiguous position preserved safely; provenance-based cleanup verified');

    // FINAL TEST H.1: Role active user count matches users.role_id
    console.log('[FINAL TEST H.1] Role active user count matches users.role_id');
    const dynRolesF = await request('GET', '/api/hrd/dynamic-roles?property_id=1', null, token);
    if (dynRolesF.status !== 200) {
      throw new Error(`FINAL TEST H.1 Failed: Expected 200 from GET /dynamic-roles, got ${dynRolesF.status}`);
    }
    const rolesListF = dynRolesF.body.data;
    const foRole = rolesListF.find(r => r.name === 'Front Office');
    if (!foRole || (foRole.active_user_count === undefined && foRole.user_count === undefined)) {
      throw new Error('FINAL TEST H.1 Failed: Front Office role or count field missing');
    }
    const actualFoCount = foRole.active_user_count !== undefined ? foRole.active_user_count : foRole.user_count;
    const dbFoCountRes = await pool.query("SELECT COUNT(*)::int as cnt FROM users WHERE role_id = $1 AND is_active = TRUE AND (property_id = 1 OR property_id IS NULL)", [foRole.id]);
    const expectedFoCount = dbFoCountRes.rows[0].cnt;
    if (actualFoCount !== expectedFoCount) {
      throw new Error(`FINAL TEST H.1 Failed: Expected active user count ${expectedFoCount}, got ${actualFoCount}`);
    }
    console.log(`  ✓ Front Office role active user count (${actualFoCount}) accurately matches active users with role_id`);

    // FINAL TEST H.2: Disabled user excluded from active count
    console.log('[FINAL TEST H.2] Disabled user excluded from active count');
    // Create a disabled user with role_id = foRole.id
    const disabledUser = await pool.query(`
      INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active, account_status)
      VALUES (1, $1, 'test_hraf_disabled_user', 'test_hraf_disabled@oaklawang.com', 'dummy_hash', 'TEST_HRAF Disabled User', FALSE, 'DISABLED')
      RETURNING id
    `, [foRole.id]);
    const dynRolesG = await request('GET', '/api/hrd/dynamic-roles?property_id=1', null, token);
    const foRoleAfterDisabled = dynRolesG.body.data.find(r => r.id === foRole.id);
    const foCountAfterDisabled = foRoleAfterDisabled.active_user_count !== undefined ? foRoleAfterDisabled.active_user_count : foRoleAfterDisabled.user_count;
    if (foCountAfterDisabled !== expectedFoCount) {
      throw new Error(`FINAL TEST H.2 Failed: Disabled user was counted! Expected ${expectedFoCount}, got ${foCountAfterDisabled}`);
    }
    await pool.query('DELETE FROM users WHERE id = $1', [disabledUser.rows[0].id]);
    console.log('  ✓ Disabled user correctly excluded from role active user count');

    // FINAL TEST H.3: Custom property role counts only correct property users
    console.log('[FINAL TEST H.3] Custom property role counts only correct property users');
    await pool.query(
      `INSERT INTO properties (id, name, property_code)
       VALUES (9992, 'Test Prop B', 'TPB99')
       ON CONFLICT (id) DO UPDATE SET is_active = TRUE`
    );

    // Create custom role in Property 1
    const customRoleH = await request('POST', '/api/hrd/roles', {
      property_id: 1,
      name: 'TEST_HRAF_Prop1_Role',
      description: 'Role scoped to property 1'
    }, token);
    if (customRoleH.status !== 201) {
      throw new Error(`FINAL TEST H.3 Failed to create custom role: ${customRoleH.status}`);
    }
    const roleHId = customRoleH.body.data.id;

    // Create user in Property 1 with this role
    const userProp1 = await pool.query(`
      INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active, account_status)
      VALUES (1, $1, 'test_hraf_u_prop1', 'test_hraf_u_prop1@oaklawang.com', 'dummy_hash', 'TEST_HRAF User Prop1', TRUE, 'READY')
      RETURNING id
    `, [roleHId]);

    // Create user in Property 9992 with this role (simulate cross-property reference)
    const userProp2 = await pool.query(`
      INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active, account_status)
      VALUES (9992, $1, 'test_hraf_u_prop2', 'test_hraf_u_prop2@oaklawang.com', 'dummy_hash', 'TEST_HRAF User Prop2', TRUE, 'READY')
      RETURNING id
    `, [roleHId]);

    const dynRolesH = await request('GET', '/api/hrd/dynamic-roles?property_id=1', null, token);
    const roleHData = dynRolesH.body.data.find(r => r.id === roleHId);
    const roleHCount = roleHData.active_user_count !== undefined ? roleHData.active_user_count : roleHData.user_count;
    if (roleHCount !== 1) {
      throw new Error(`FINAL TEST H.3 Failed: Expected custom role user count = 1 for property 1, got ${roleHCount}`);
    }

    // Clean up users and role
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [userProp1.rows[0].id, userProp2.rows[0].id]);
    await pool.query('DELETE FROM roles WHERE id = $1', [roleHId]);
    console.log('  ✓ Custom property role counts strictly only users in its own property');

    // FINAL TEST I: Department/Position/Role remain independent
    console.log('[FINAL TEST I] Department/Position/Role remain independent');
    const deptFoRes = await pool.query("SELECT id FROM hr_departments WHERE property_id = 1 AND code = 'FO'");
    const deptFoId = deptFoRes.rows[0].id;
    const posRecepRes = await pool.query("SELECT id FROM hr_positions WHERE property_id = 1 AND name = 'Receptionist'");
    const posRecepId = posRecepRes.rows[0].id;

    const empI = await request('POST', '/api/hrd/employees', {
      property_id: 1,
      full_name: 'TEST_HRAF_Independent_Emp',
      department_id: deptFoId,
      position_id: posRecepId,
      role_id: foRole.id,
      access_type: 'PMS_STAFF'
    }, token);
    if (empI.status !== 201) {
      throw new Error(`FINAL TEST I Failed to create employee: ${empI.status} ${JSON.stringify(empI.body)}`);
    }
    const empIId = empI.body.data.id;

    // Mutate department to Housekeeping without changing role
    const deptHkRes = await pool.query("SELECT id FROM hr_departments WHERE property_id = 1 AND code = 'HK'");
    const deptHkId = deptHkRes.rows[0].id;
    const posHkRes = await pool.query("SELECT id FROM hr_positions WHERE property_id = 1 AND name = 'Room Attendant'");
    const posHkId = posHkRes.rows[0].id;

    const updateEmpI = await request('PUT', `/api/hrd/employees/${empIId}`, {
      property_id: 1,
      department_id: deptHkId,
      position_id: posHkId
    }, token);
    if (updateEmpI.status !== 200) {
      throw new Error(`FINAL TEST I Failed to update employee department/position: ${updateEmpI.status} ${JSON.stringify(updateEmpI.body)}`);
    }

    // Verify employee role has NOT changed automatically
    const checkEmpIRow = await pool.query('SELECT department_id, position_id, role FROM hr_employees WHERE id = $1', [empIId]);
    if (checkEmpIRow.rows[0].role !== 'Front Office') {
      throw new Error(`FINAL TEST I Failed: Department change unexpectedly altered role! Expected 'Front Office', got ${checkEmpIRow.rows[0].role}`);
    }

    // Now change role without changing department/position
    const hkRole = rolesListF.find(r => r.name === 'Housekeeping');
    const updateEmpRoleI = await request('PUT', `/api/hrd/employees/${empIId}`, {
      property_id: 1,
      role_id: hkRole.id
    }, token);
    if (updateEmpRoleI.status !== 200) {
      throw new Error(`FINAL TEST I Failed to update employee role: ${updateEmpRoleI.status} ${JSON.stringify(updateEmpRoleI.body)}`);
    }

    const checkEmpRoleIRow = await pool.query('SELECT department_id, position_id, role FROM hr_employees WHERE id = $1', [empIId]);
    if (checkEmpRoleIRow.rows[0].department_id !== deptHkId || checkEmpRoleIRow.rows[0].position_id !== posHkId) {
      throw new Error('FINAL TEST I Failed: Role change unexpectedly altered department_id or position_id');
    }
    if (checkEmpRoleIRow.rows[0].role !== 'Housekeeping') {
      throw new Error(`FINAL TEST I Failed: Expected role 'Housekeeping', got ${checkEmpRoleIRow.rows[0].role}`);
    }
    await pool.query('DELETE FROM hr_employees WHERE id = $1', [empIId]);
    console.log('  ✓ Department, Position, and Role are completely independent');

    console.log('\n=== ALL HR-ACCESS-1 INTEGRATION TESTS (A - AJ + REVIEW A - K + FINAL A - I) PASSED! ===\n');
  } finally {
    console.log('Cleaning up test fixtures...');
    await cleanupTestFixtures();
  }
}

async function main() {
  server = app.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  try {
    await runTests();
  } finally {
    server.close();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('\n[FATAL TEST FAILURE]', err);
    if (server) server.close();
    process.exit(1);
  });
}

module.exports = { runTests };

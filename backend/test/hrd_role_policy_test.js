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
  console.log('=== RUNNING HRD ACCOUNT & ROLE POLICY TEST ===');

  let createdEmployeeIds = [];

  try {
    // 0. Ensure default policy for property 1
    await pool.query(`
      INSERT INTO hrd_role_policies (property_id, allow_hrd_assign_owner_role, allow_hrd_assign_gm_role)
      VALUES (1, FALSE, FALSE)
      ON CONFLICT (property_id) DO UPDATE SET
        allow_hrd_assign_owner_role = FALSE,
        allow_hrd_assign_gm_role = FALSE
    `);

    // Clean old test residues
    await pool.query(`
      DELETE FROM hr_employees WHERE full_name LIKE '%TEST_HRD_%' OR username LIKE '%test_hrd_%'
    `);

    // 1. Check available roles for HRD (Owner & GM should be omitted)
    console.log('Checking default available roles for HRD...');
    const rolesRes = await request('GET', '/api/hrd/roles?property_id=1');
    if (rolesRes.status !== 200 || !Array.isArray(rolesRes.body?.data)) {
      throw new Error(`Failed to fetch roles: ${rolesRes.status} ${JSON.stringify(rolesRes.body)}`);
    }

    const availableRoleKeys = rolesRes.body.data.map(r => r.key);
    if (availableRoleKeys.includes('Owner') || availableRoleKeys.includes('General Manager')) {
      throw new Error('Owner or GM role should not be available by default in HRD');
    }
    if (!availableRoleKeys.includes('Crew') || !availableRoleKeys.includes('Head Department / Supervisor')) {
      throw new Error('Standard roles missing from available roles');
    }
    console.log('✓ Owner and GM roles properly hidden by default');

    // 2. Attempt assigning Owner role (should be rejected with 403)
    console.log('Attempting to create employee with Owner role (expecting 403)...');
    const rejectOwnerRes = await request('POST', '/api/hrd/employees', {
      property_id: 1,
      name: 'TEST_HRD_Owner',
      role: 'Owner',
      department: 'Management',
      username: 'test_hrd_owner_reject'
    });
    if (rejectOwnerRes.status !== 403 || rejectOwnerRes.body?.code !== 'ROLE_ASSIGNMENT_RESTRICTED') {
      throw new Error(`Expected 403 ROLE_ASSIGNMENT_RESTRICTED, got ${rejectOwnerRes.status}: ${JSON.stringify(rejectOwnerRes.body)}`);
    }
    console.log('✓ Assignment of Owner role blocked with 403');

    // 3. Attempt assigning Platform Admin role (must be rejected unconditionally with 403)
    console.log('Attempting to create employee with Admin role (expecting 403)...');
    const rejectAdminRes = await request('POST', '/api/hrd/employees', {
      property_id: 1,
      name: 'TEST_HRD_Admin',
      role: 'Administrator',
      department: 'Management'
    });
    if (rejectAdminRes.status !== 403 || rejectAdminRes.body?.code !== 'PLATFORM_ADMIN_PROHIBITED') {
      throw new Error(`Expected 403 PLATFORM_ADMIN_PROHIBITED, got ${rejectAdminRes.status}: ${JSON.stringify(rejectAdminRes.body)}`);
    }
    console.log('✓ Assignment of platform Administrator role strictly prohibited with 403');

    // 4. Create standard employee (Crew)
    console.log('Creating standard employee (Crew)...');
    const createCrewRes = await request('POST', '/api/hrd/employees', {
      property_id: 1,
      name: 'TEST_HRD_Crew Ahmad',
      role: 'Crew',
      department: 'Housekeeping',
      username: 'test_hrd_ahmad',
      phone: '08123456789'
    });
    if (createCrewRes.status !== 201 || !createCrewRes.body?.data?.id) {
      throw new Error(`Failed to create crew employee: ${createCrewRes.status} ${JSON.stringify(createCrewRes.body)}`);
    }
    createdEmployeeIds.push(createCrewRes.body.data.id);
    console.log(`✓ Crew employee created successfully with ID ${createCrewRes.body.data.id}`);

    // 5. Update policy to allow Owner assignment
    console.log('Updating policy to allow Owner assignment...');
    const policyUpdateRes = await request('PATCH', '/api/hrd/policies', {
      property_id: 1,
      allow_hrd_assign_owner_role: true,
      updated_by: 'SuperAdmin'
    });
    if (policyUpdateRes.status !== 200 || !policyUpdateRes.body?.data?.allow_hrd_assign_owner_role) {
      throw new Error(`Failed to update policy: ${policyUpdateRes.status} ${JSON.stringify(policyUpdateRes.body)}`);
    }
    console.log('✓ Policy updated to allow Owner assignment');

    // Verify audit log for policy change
    const auditRes = await pool.query(`
      SELECT * FROM audit_logs WHERE action = 'HRD_ROLE_POLICIES_UPDATED' ORDER BY audit_id DESC LIMIT 1
    `);
    if (auditRes.rows.length === 0) {
      throw new Error('Audit log for HRD_ROLE_POLICIES_UPDATED was not written');
    }
    console.log('✓ Audit log for HRD_ROLE_POLICIES_UPDATED verified');

    // 6. Check available roles again (Owner should now appear)
    const rolesRes2 = await request('GET', '/api/hrd/roles?property_id=1');
    const roleKeys2 = rolesRes2.body.data.map(r => r.key);
    if (!roleKeys2.includes('Owner')) {
      throw new Error('Owner role should now be available in HRD');
    }
    console.log('✓ Owner role now visible in HRD available roles list');

    // 7. Create employee with Owner role now that policy allows it
    console.log('Creating employee with Owner role...');
    const createOwnerRes = await request('POST', '/api/hrd/employees', {
      property_id: 1,
      name: 'TEST_HRD_Owner Pak Budi',
      role: 'Owner',
      department: 'Management',
      username: 'test_hrd_owner_budi',
      phone: '081999888777'
    });
    if (createOwnerRes.status !== 201 || !createOwnerRes.body?.data?.id) {
      throw new Error(`Failed to create Owner employee: ${createOwnerRes.status} ${JSON.stringify(createOwnerRes.body)}`);
    }
    createdEmployeeIds.push(createOwnerRes.body.data.id);
    console.log(`✓ Owner employee created successfully with ID ${createOwnerRes.body.data.id}`);

    // Verify high-privilege audit log
    const auditPrivRes = await pool.query(`
      SELECT * FROM audit_logs WHERE action = 'PRIVILEGED_ROLE_ASSIGNED' ORDER BY audit_id DESC LIMIT 1
    `);
    if (auditPrivRes.rows.length === 0) {
      throw new Error('Audit log for PRIVILEGED_ROLE_ASSIGNED was not written');
    }
    console.log('✓ High-privilege role assignment audit log verified');

    console.log('=== ALL HRD ROLE POLICY TESTS PASSED ===');
  } finally {
    console.log('Cleaning up test fixtures and restoring default policy...');
    if (createdEmployeeIds.length > 0) {
      await pool.query('DELETE FROM hr_employees WHERE id = ANY($1::int[])', [createdEmployeeIds]);
    }
    await pool.query("DELETE FROM hr_employees WHERE full_name LIKE '%TEST_HRD_%' OR username LIKE '%test_hrd_%'");

    // Restore default policy
    await pool.query(`
      UPDATE hrd_role_policies
      SET allow_hrd_assign_owner_role = FALSE, allow_hrd_assign_gm_role = FALSE
      WHERE property_id = 1
    `);
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

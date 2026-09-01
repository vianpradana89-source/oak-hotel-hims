'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { once } = require('events');
const { app, pool } = require('../dist/index');
const { initializeDatabase } = require('../dist/db/schema_v3');
const { generateToken } = require('../dist/domains/auth/authService');

let server;
let baseUrl;

function generateTestToken(role = 'Super Admin') {
  return generateToken({
    id: 99999,
    email: 'test.admin@oaklawang.com',
    username: 'test_admin',
    full_name: 'Test Super Admin',
    role: role,
    role_id: 1,
    property_id: 1
  });
}

async function request(method, requestPath, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, body: data };
}

async function runTest() {
  console.log('=== RUNNING DYNAMIC ROLE PERMISSIONS MATRIX TEST ===');

  await initializeDatabase(pool);

  try {
    // 1. Fetch initial permissions matrix
    console.log('1. Fetching role permissions matrix for property 1...');
    const getRes = await request('GET', '/api/settings/role-permissions?property_id=1');
    if (getRes.status !== 200 || !getRes.body?.data?.roles) {
      throw new Error(`Failed to fetch matrix: ${getRes.status} ${JSON.stringify(getRes.body)}`);
    }

    const roles = getRes.body.data.roles;
    console.log(`✓ Fetched ${roles.length} roles and ${getRes.body.data.available_menus.length} system menus`);

    const superAdmin = roles.find(r => r.role === 'Super Admin');
    if (!superAdmin || !superAdmin.is_system_locked) {
      throw new Error('Super Admin must be present and marked is_system_locked');
    }
    if (superAdmin.permissions.length !== getRes.body.data.available_menus.length) {
      throw new Error('Super Admin must have all menu permissions');
    }
    console.log('✓ Super Admin is locked with full system access');

    // 2. Update permissions with Super Admin token
    console.log('2. Updating Front Office permissions to custom subset...');
    const adminToken = generateTestToken('Super Admin');
    const updatePayload = {
      property_id: 1,
      roles: [
        {
          role: 'Front Office',
          permissions: ['Kalender', 'Transaksi', 'Pelanggan']
        },
        {
          role: 'Housekeeping',
          permissions: ['Housekeeping', 'Employee Mobile']
        }
      ]
    };

    const putRes = await request('PUT', '/api/settings/role-permissions', updatePayload, adminToken);
    if (putRes.status !== 200 || putRes.body?.status !== 'OK') {
      throw new Error(`Failed to update permissions: ${putRes.status} ${JSON.stringify(putRes.body)}`);
    }

    const updatedFo = putRes.body.data.roles.find(r => r.role === 'Front Office');
    if (!updatedFo || updatedFo.permissions.length !== 3) {
      throw new Error(`Front Office permissions not updated correctly: ${JSON.stringify(updatedFo)}`);
    }
    console.log('✓ Custom role permissions updated and persisted successfully');

    // 3. Reset to SOP defaults
    console.log('3. Resetting permissions back to SOP default standard...');
    const resetRes = await request('POST', '/api/settings/role-permissions/reset', { property_id: 1 }, adminToken);
    if (resetRes.status !== 200 || resetRes.body?.status !== 'OK') {
      throw new Error(`Failed to reset permissions: ${resetRes.status} ${JSON.stringify(resetRes.body)}`);
    }

    const resetFo = resetRes.body.data.roles.find(r => r.role === 'Front Office');
    if (!resetFo || !resetFo.permissions.includes('POS') || !resetFo.permissions.includes('Employee Mobile')) {
      throw new Error(`Front Office permissions did not reset to SOP default: ${JSON.stringify(resetFo)}`);
    }
    console.log('✓ Reset to default SOP restored standard hotel baseline');

    console.log('=== ALL ROLE PERMISSIONS MATRIX TESTS PASSED ===');
  } finally {
    // Cleanup audit log test entries if any
    await pool.query(`DELETE FROM audit_logs WHERE actor_name = 'Test Super Admin'`).catch(() => {});
  }
}

async function main() {
  server = app.listen(0);
  await once(server, 'listening');
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await runTest();
  } catch (err) {
    console.error('TEST FAILED:', err);
    process.exitCode = 1;
  } finally {
    server.close();
    await pool.end();
  }
}

main();

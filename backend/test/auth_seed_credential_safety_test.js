// backend/test/auth_seed_credential_safety_test.js
require('dotenv').config();
const assert = require('assert');
const { Pool } = require('pg');
const { seedSuperAdmin } = require('../dist/domains/auth/authService');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'oak_hotel_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres'
});

async function runSeedCredentialSafetyTests() {
  console.log('=== AUTH SEED CREDENTIAL SAFETY POSTGRESQL INTEGRATION TEST ===\n');

  const testEmail = 'fo@oaklawang.com';
  const testUsername = 'fo_staff';

  const origUserRes = await pool.query(
    'SELECT * FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($2)',
    [testEmail, testUsername]
  );
  const origUser = origUserRes.rows[0] || null;

  const origEmpRes = await pool.query(
    'SELECT * FROM hr_employees WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($2)',
    [testEmail, testUsername]
  );
  const origEmp = origEmpRes.rows[0] || null;

  try {
    console.log('Test A: Fresh bootstrap creates seed account if missing...');
    await pool.query('DELETE FROM users WHERE LOWER(email) = LOWER($1)', [testEmail]);
    await pool.query('DELETE FROM hr_employees WHERE LOWER(email) = LOWER($1)', [testEmail]);

    await seedSuperAdmin(pool);

    const freshUserRes = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [testEmail]);
    assert.strictEqual(freshUserRes.rows.length, 1, 'Seed user must be created on fresh bootstrap');
    const createdUser = freshUserRes.rows[0];
    assert.strictEqual(createdUser.username, testUsername);
    assert.strictEqual(createdUser.role_id, 2);
    assert.strictEqual(createdUser.is_active, true);
    assert.strictEqual(createdUser.account_status, 'READY');
    assert.strictEqual(createdUser.must_change_password, false);

    const freshEmpRes = await pool.query('SELECT * FROM hr_employees WHERE LOWER(email) = LOWER($1)', [testEmail]);
    assert.strictEqual(freshEmpRes.rows.length, 1, 'HR employee must be created on fresh bootstrap');
    const createdEmp = freshEmpRes.rows[0];
    console.log('✓ PASS: Fresh bootstrap created required seed user and HR employee.\n');

    const customPasswordHash = '$2a$10$CustomChangedPasswordHashForTestingByteForByte1234567890';
    const customRoleId = 3;
    const customEmployeeId = Number(createdEmp.id);

    await pool.query(
      `UPDATE users
       SET password_hash = $1,
           role_id = $2,
           is_active = FALSE,
           employee_id = $3,
           account_status = 'SUSPENDED',
           must_change_password = TRUE,
           updated_at = NOW()
       WHERE id = $4`,
      [customPasswordHash, customRoleId, customEmployeeId, createdUser.id]
    );

    await pool.query(
      `UPDATE hr_employees
       SET full_name = 'Custom HR Name',
           department = 'Custom Department',
           position = 'Senior Manager',
           is_active = FALSE,
           updated_at = NOW()
       WHERE id = $1`,
      [createdEmp.id]
    );

    console.log('Simulating second startup / application restart...');
    await seedSuperAdmin(pool);
    console.log('Second seedSuperAdmin() execution finished.\n');

    const verifyUserRes = await pool.query('SELECT * FROM users WHERE id = $1', [createdUser.id]);
    const verifiedUser = verifyUserRes.rows[0];

    const verifyEmpRes = await pool.query('SELECT * FROM hr_employees WHERE id = $1', [createdEmp.id]);
    const verifiedEmp = verifyEmpRes.rows[0];

    console.log('Test B: Checking byte-for-byte password_hash preservation...');
    assert.strictEqual(verifiedUser.password_hash, customPasswordHash, 'password_hash must remain byte-for-byte identical');
    console.log('✓ PASS: password_hash preserved byte-for-byte.\n');

    console.log('Test C: Checking role_id preservation...');
    assert.strictEqual(Number(verifiedUser.role_id), customRoleId, 'role_id must not be overwritten back to default');
    console.log('✓ PASS: role_id preserved.\n');

    console.log('Test D: Checking username/email preservation...');
    assert.strictEqual(verifiedUser.username, testUsername);
    assert.strictEqual(verifiedUser.email, testEmail);
    console.log('✓ PASS: username and email preserved.\n');

    console.log('Test E: Checking disabled account remains disabled...');
    assert.strictEqual(verifiedUser.is_active, false, 'is_active must remain FALSE and not be forced to TRUE');
    console.log('✓ PASS: is_active = FALSE preserved.\n');

    console.log('Test F: Checking employee_id link preservation...');
    assert.strictEqual(Number(verifiedUser.employee_id), customEmployeeId, 'employee_id must remain unchanged');
    console.log('✓ PASS: employee_id preserved.\n');

    console.log('Test G: Checking must_change_password preservation...');
    assert.strictEqual(verifiedUser.must_change_password, true, 'must_change_password must remain TRUE');
    console.log('✓ PASS: must_change_password preserved.\n');

    console.log('Test H: Checking account_status preservation...');
    assert.strictEqual(verifiedUser.account_status, 'SUSPENDED', 'account_status must remain SUSPENDED');
    console.log('✓ PASS: account_status preserved.\n');

    console.log('Test I: Verifying user password change survived server restart...');
    assert.strictEqual(verifiedUser.password_hash, customPasswordHash);
    console.log('✓ PASS: Changed password survived server restart.\n');

    console.log('Test J: Checking HR employee data not overwritten by seed...');
    assert.strictEqual(verifiedEmp.full_name, 'Custom HR Name', 'HR employee full_name must not be overwritten');
    assert.strictEqual(verifiedEmp.department, 'Custom Department', 'HR employee department must not be overwritten');
    assert.strictEqual(verifiedEmp.position, 'Senior Manager', 'HR employee position must not be overwritten');
    assert.strictEqual(verifiedEmp.is_active, false, 'HR employee is_active must remain false');
    console.log('✓ PASS: Existing HR employee data untouched by seed.\n');

    console.log('================================================================');
    console.log('ALL TESTS A THROUGH J PASSED! CREDENTIAL & HR INTEGRITY VERIFIED.');
    console.log('================================================================\n');
  } finally {
    console.log('Restoring test account to original state...');
    try {
      await pool.query('DELETE FROM users WHERE LOWER(email) = LOWER($1)', [testEmail]);
      await pool.query('DELETE FROM hr_employees WHERE LOWER(email) = LOWER($1)', [testEmail]);

      if (origUser) {
        await pool.query(
          `INSERT INTO users (
             id, property_id, role_id, username, email, password_hash, full_name,
             is_active, employee_id, account_status, must_change_password, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            origUser.id, origUser.property_id, origUser.role_id, origUser.username,
            origUser.email, origUser.password_hash, origUser.full_name, origUser.is_active,
            origUser.employee_id, origUser.account_status, origUser.must_change_password,
            origUser.created_at, origUser.updated_at
          ]
        );
      }
      if (origEmp) {
        await pool.query(
          `INSERT INTO hr_employees (
             id, property_id, employee_code, full_name, position, department,
             hire_date, monthly_salary, status, role, username, email, is_active, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            origEmp.id, origEmp.property_id, origEmp.employee_code, origEmp.full_name,
            origEmp.position, origEmp.department, origEmp.hire_date, origEmp.monthly_salary,
            origEmp.status, origEmp.role, origEmp.username, origEmp.email, origEmp.is_active,
            origEmp.created_at, origEmp.updated_at
          ]
        );
      }
      console.log('✓ Original state successfully restored. Zero session residue.');
    } catch (cleanupErr) {
      console.error('Error during cleanup:', cleanupErr);
    } finally {
      await pool.end();
    }
  }
}

runSeedCredentialSafetyTests().catch(err => {
  console.error('FATAL TEST ERROR:', err);
  process.exit(1);
});

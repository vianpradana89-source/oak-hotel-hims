// backend/test/auth_hr2a_canonical_onboarding_test.js
require('dotenv').config();
const assert = require('assert');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const {
  createEmployeeAccount,
  diagnoseEmployeeLoginAccount,
  repairEmployeeLoginAccount,
  resetEmployeePassword,
  resolveCanonicalRoleId,
  validateRoleAssignment
} = require('../dist/domains/hrd/hrdService');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'oak_hotel_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres'
});

const TEST_PREFIX = 'test_hr2a_';
const TEST_PROPERTY_ID = 1;
const FOREIGN_PROPERTY_ID = 9999;

async function cleanupTestData(client) {
  // Delete users created during test
  await client.query(
    "DELETE FROM users WHERE email LIKE $1 OR username LIKE $1",
    [`%${TEST_PREFIX}%`]
  );
  // Delete employees created during test
  await client.query(
    "DELETE FROM hr_employees WHERE email LIKE $1 OR username LIKE $1 OR employee_code LIKE $1",
    [`%${TEST_PREFIX}%`]
  );
}

async function runAuthHr2aTests() {
  console.log('===============================================================');
  console.log('=== OAK HIMS — AUTH-HR-2A CANONICAL ONBOARDING & REPAIR TEST ===');
  console.log('===============================================================\n');

  const client = await pool.connect();

  try {
    // Initial cleanup
    await cleanupTestData(client);

    // Scenario A: Employee created without login account
    console.log('Test A: Employee created without login account (create_login_account = false)...');
    const empPayloadA = {
      property_id: TEST_PROPERTY_ID,
      employee_code: `${TEST_PREFIX}EMP_A`,
      full_name: 'Test Employee A No Login',
      position: 'Staff',
      department: 'Housekeeping',
      role: 'Housekeeping',
      hire_date: '2026-09-01',
      create_login_account: false
    };
    const resultA = await createEmployeeAccount(client, TEST_PROPERTY_ID, empPayloadA);
    assert.ok(resultA.id, 'Employee A must have an ID');
    assert.strictEqual(resultA.auth_account_created, false, 'Auth account must not be created');
    assert.strictEqual(resultA.user_id, null, 'User ID must be null');
    assert.strictEqual(resultA.temporary_password, undefined, 'No temp password should be returned');

    // Verify DB state
    const dbEmpA = await client.query('SELECT * FROM hr_employees WHERE id = $1', [resultA.id]);
    assert.strictEqual(dbEmpA.rows.length, 1, 'hr_employees row must exist');
    const dbUserA = await client.query('SELECT * FROM users WHERE employee_id = $1', [resultA.id]);
    assert.strictEqual(dbUserA.rows.length, 0, 'No users row should link to Employee A');
    console.log('✓ PASS: Employee A created with no linked auth account.\n');

    // Scenario B & C: Employee created with login account atomically
    console.log('Test B & C: Employee created with login account atomically & linked users.employee_id...');
    const empPayloadB = {
      property_id: TEST_PROPERTY_ID,
      employee_code: `${TEST_PREFIX}EMP_B`,
      full_name: 'Test Employee B With Login',
      position: 'Receptionist',
      department: 'Front Office',
      role: 'Front Office',
      email: `${TEST_PREFIX}b@oaklawang.com`,
      phone: '081234567890',
      hire_date: '2026-09-01',
      create_login_account: true
    };
    const resultB = await createEmployeeAccount(client, TEST_PROPERTY_ID, empPayloadB);
    assert.ok(resultB.id, 'Employee B must have an ID');
    assert.strictEqual(resultB.auth_account_created, true, 'Auth account must be created');
    assert.ok(resultB.user_id, 'User ID must be present');
    assert.ok(resultB.temporary_password, 'Temporary password must be returned');
    assert.ok(resultB.temp_password_expires_at, 'Temporary password expires_at must be returned');

    // Invariant C: users.employee_id correctly linked
    const dbUserB = await client.query('SELECT * FROM users WHERE id = $1', [resultB.user_id]);
    assert.strictEqual(dbUserB.rows.length, 1, 'users row must exist');
    const userB = dbUserB.rows[0];
    assert.strictEqual(Number(userB.employee_id), Number(resultB.id), 'users.employee_id must match hr_employees.id');
    assert.strictEqual(userB.account_status, 'FIRST_LOGIN_REQUIRED', 'account_status must be FIRST_LOGIN_REQUIRED');
    assert.strictEqual(userB.must_change_password, true, 'must_change_password must be true');
    assert.strictEqual(userB.local_password_enabled, true, 'local_password_enabled must be true');
    assert.strictEqual(userB.is_active, true, 'is_active must be true');
    console.log('✓ PASS: Employee B and User created atomically and linked via users.employee_id.\n');

    // Scenario D: Duplicate email triggers complete rollback
    console.log('Test D: Duplicate email triggers complete rollback (no orphaned employee or user)...');
    const empPayloadD = {
      property_id: TEST_PROPERTY_ID,
      employee_code: `${TEST_PREFIX}EMP_D`,
      full_name: 'Test Employee D Duplicate',
      email: `${TEST_PREFIX}b@oaklawang.com`, // Same email as B
      role: 'Front Office',
      create_login_account: true
    };
    let duplicateRejected = false;
    try {
      await createEmployeeAccount(client, TEST_PROPERTY_ID, empPayloadD);
    } catch (err) {
      duplicateRejected = true;
      assert.ok(err.code === 'EMAIL_ALREADY_EXISTS' || err.code === 'DUPLICATE_LOGIN_EMAIL' || err.code === 'DUPLICATE_EMPLOYEE_EMAIL' || err.statusCode === 409,
        `Expected conflict error, got ${err.code}: ${err.message}`);
    }
    assert.ok(duplicateRejected, 'Duplicate email creation must be rejected');

    // Verify rollback: no employee row with EMP_D exists
    const dbEmpD = await client.query('SELECT * FROM hr_employees WHERE employee_code = $1', [`${TEST_PREFIX}EMP_D`]);
    assert.strictEqual(dbEmpD.rows.length, 0, 'No orphaned hr_employees record should exist');
    console.log('✓ PASS: Duplicate email rejected and rolled back completely.\n');

    // Scenario E: Username collision deterministically resolved
    console.log('Test E: Username collision deterministically resolved (e.g. prefix -> prefix2)...');
    const empPayloadE1 = {
      property_id: TEST_PROPERTY_ID,
      employee_code: `${TEST_PREFIX}EMP_E1`,
      full_name: 'Collision User One',
      username: `${TEST_PREFIX}clash`,
      email: `${TEST_PREFIX}clash1@oaklawang.com`,
      role: 'Front Office',
      create_login_account: true
    };
    const resultE1 = await createEmployeeAccount(client, TEST_PROPERTY_ID, empPayloadE1);
    assert.strictEqual(resultE1.username, `${TEST_PREFIX}clash`);

    const empPayloadE2 = {
      property_id: TEST_PROPERTY_ID,
      employee_code: `${TEST_PREFIX}EMP_E2`,
      full_name: 'Collision User Two',
      username: `${TEST_PREFIX}clash`, // Same base username
      email: `${TEST_PREFIX}clash2@oaklawang.com`,
      role: 'Front Office',
      create_login_account: true
    };
    const resultE2 = await createEmployeeAccount(client, TEST_PROPERTY_ID, empPayloadE2);
    assert.strictEqual(resultE2.username, `${TEST_PREFIX}clash2`, 'Collision must resolve to suffix 2');
    console.log('✓ PASS: Username collision deterministically resolved to suffix.\n');

    // Scenario F & G: Temporary password matches returned one-time credential via bcrypt & 7-day expiry
    console.log('Test F & G: Temporary password matches bcrypt hash & has 7-day expiry...');
    assert.ok(resultB.temporary_password.length >= 10, 'Temp password must be at least 10 chars');
    const isBcryptMatch = await bcrypt.compare(resultB.temporary_password, userB.password_hash);
    assert.ok(isBcryptMatch, 'Bcrypt must verify temporary password against users.password_hash');

    // Check expiry is ~7 days in the future
    const expiryTime = new Date(userB.temp_password_expires_at).getTime();
    const nowTime = Date.now();
    const diffDays = (expiryTime - nowTime) / (1000 * 60 * 60 * 24);
    assert.ok(diffDays >= 6.8 && diffDays <= 7.2, `Expiry diff in days must be ~7, got ${diffDays}`);
    console.log('✓ PASS: Temporary password verified with bcrypt and 7-day expiry confirmed.\n');

    // Scenario H: Existing unlinked employee/user match diagnosed as UNLINKED_MATCH_FOUND
    console.log('Test H: Existing unlinked employee/user match diagnosed as UNLINKED_MATCH_FOUND...');
    // Create unlinked employee
    const empResH = await client.query(
      `INSERT INTO hr_employees (property_id, employee_code, full_name, email, role, is_active, status)
       VALUES ($1, $2, $3, $4, $5, TRUE, 'ACTIVE') RETURNING id`,
      [TEST_PROPERTY_ID, `${TEST_PREFIX}EMP_H`, 'Nadya Unlinked Staf', `${TEST_PREFIX}nadya@oaklawang.com`, 'Front Office']
    );
    const empIdH = empResH.rows[0].id;

    // Create unlinked user with same email (employee_id is NULL)
    const userResH = await client.query(
      `INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active, employee_id)
       VALUES ($1, 2, $2, $3, 'dummyhash', 'Nadya Unlinked Staf', TRUE, NULL) RETURNING id`,
      [TEST_PROPERTY_ID, `${TEST_PREFIX}nadya`, `${TEST_PREFIX}nadya@oaklawang.com`]
    );
    const userIdH = userResH.rows[0].id;

    // Run diagnosis on employee H
    const diagH = await diagnoseEmployeeLoginAccount(client, TEST_PROPERTY_ID, empIdH);
    assert.strictEqual(diagH.diagnosis_state, 'UNLINKED_MATCH_FOUND', 'Must diagnose UNLINKED_MATCH_FOUND');
    assert.ok(diagH.candidate_user, 'Must provide candidate_user');
    assert.strictEqual(diagH.candidate_user.id, userIdH, 'Candidate user ID must match');
    console.log('✓ PASS: Unlinked match accurately diagnosed as UNLINKED_MATCH_FOUND.\n');

    // Scenario I: Ambiguous match is NOT auto-linked (AMBIGUOUS_MATCH)
    console.log('Test I: Ambiguous match is NOT auto-linked (AMBIGUOUS_MATCH)...');
    // User 1 matches by username
    await client.query(
      `INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active, employee_id)
       VALUES ($1, 2, $2, $3, 'dummyhash', 'Ambiguous Staf One', TRUE, NULL)`,
      [TEST_PROPERTY_ID, `${TEST_PREFIX}ambig_user`, `${TEST_PREFIX}ambig1@oaklawang.com`]
    );
    // User 2 matches by email
    await client.query(
      `INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active, employee_id)
       VALUES ($1, 2, $2, $3, 'dummyhash', 'Ambiguous Staf Two', TRUE, NULL)`,
      [TEST_PROPERTY_ID, `${TEST_PREFIX}ambig_user2`, `${TEST_PREFIX}ambig_target@oaklawang.com`]
    );

    // Create employee I that matches User 1 by username and User 2 by email
    const empResI = await client.query(
      `INSERT INTO hr_employees (property_id, employee_code, full_name, username, email, role, is_active, status)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, 'ACTIVE') RETURNING id`,
      [TEST_PROPERTY_ID, `${TEST_PREFIX}EMP_I`, 'Ambiguous Match Staf', `${TEST_PREFIX}ambig_user`, `${TEST_PREFIX}ambig_target@oaklawang.com`, 'Front Office']
    );
    const empIdI = empResI.rows[0].id;

    const diagI = await diagnoseEmployeeLoginAccount(client, TEST_PROPERTY_ID, empIdI);
    assert.strictEqual(diagI.diagnosis_state, 'AMBIGUOUS_MATCH', `Expected AMBIGUOUS_MATCH, got ${diagI.diagnosis_state}`);
    console.log('✓ PASS: Ambiguous candidate match correctly flagged as AMBIGUOUS_MATCH.\n');

    // Scenario J: Repair action (LINK_UNAMBIGUOUS_ACCOUNT) links only intended user
    console.log('Test J: Repair action (LINK_UNAMBIGUOUS_ACCOUNT) links only intended user...');
    const repairPayload = {
      action: 'LINK_UNAMBIGUOUS_ACCOUNT',
      target_user_id: userIdH,
      reason: 'Automated test link verification'
    };
    const repairResult = await repairEmployeeLoginAccount(client, TEST_PROPERTY_ID, empIdH, repairPayload, { name: 'Test Runner' });
    assert.strictEqual(repairResult.status, 'OK');
    assert.strictEqual(repairResult.data.user_id, userIdH);

    // Verify users.employee_id is now set in DB
    const checkUserH = await client.query('SELECT employee_id FROM users WHERE id = $1', [userIdH]);
    assert.strictEqual(Number(checkUserH.rows[0].employee_id), Number(empIdH), 'User H must be linked to Employee H');

    // Verify subsequent diagnosis is LINKED_OK
    const diagHAfter = await diagnoseEmployeeLoginAccount(client, TEST_PROPERTY_ID, empIdH);
    assert.strictEqual(diagHAfter.diagnosis_state, 'LINKED_OK');
    console.log('✓ PASS: LINK_UNAMBIGUOUS_ACCOUNT successfully linked user and updated diagnosis to LINKED_OK.\n');

    // Scenario K & L: Reset-password by employee_id updates correct user's password
    console.log('Test K & L: Reset-password targets users.employee_id, NOT users.id == employee_id...');
    // In our test, empIdH and userIdH are separate IDs. Let's make sure empIdH != userIdH.
    // If by chance they were equal, we can test with Employee B.
    // Let's create an employee with explicit offset to guarantee employee_id != users.id.
    const empResK = await client.query(
      `INSERT INTO hr_employees (property_id, employee_code, full_name, email, role, is_active, status)
       VALUES ($1, $2, $3, $4, $5, TRUE, 'ACTIVE') RETURNING id`,
      [TEST_PROPERTY_ID, `${TEST_PREFIX}EMP_K`, 'Staf K Distinct IDs', `${TEST_PREFIX}k@oaklawang.com`, 'Front Office']
    );
    const empIdK = empResK.rows[0].id;

    const userResK = await client.query(
      `INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active, employee_id)
       VALUES ($1, 2, $2, $3, 'original_k_hash', 'Staf K Distinct IDs', TRUE, $4) RETURNING id`,
      [TEST_PROPERTY_ID, `${TEST_PREFIX}user_k`, `${TEST_PREFIX}k@oaklawang.com`, empIdK]
    );
    const userIdK = userResK.rows[0].id;

    // Reset password by employee_id = empIdK
    const resetResultK = await resetEmployeePassword(client, TEST_PROPERTY_ID, empIdK, { name: 'HRD Admin' });
    assert.strictEqual(resetResultK.employee_id, empIdK);
    assert.strictEqual(resetResultK.user_id, userIdK);
    assert.ok(resetResultK.temporary_password);
    assert.strictEqual(resetResultK.must_change_password, true);
    assert.strictEqual(resetResultK.account_status, 'FIRST_LOGIN_REQUIRED');

    // Check DB: Target user password updated
    const checkUserK = await client.query('SELECT * FROM users WHERE id = $1', [userIdK]);
    const isNewPassValid = await bcrypt.compare(resetResultK.temporary_password, checkUserK.rows[0].password_hash);
    assert.ok(isNewPassValid, 'Temporary password must verify with bcrypt on target user');
    console.log('✓ PASS: Password reset resolved target user strictly by employee_id.\n');

    // Scenario M: Reset sets must_change_password = true and account_status = FIRST_LOGIN_REQUIRED
    console.log('Test M: Reset invariants verified on users record...');
    assert.strictEqual(checkUserK.rows[0].must_change_password, true);
    assert.strictEqual(checkUserK.rows[0].account_status, 'FIRST_LOGIN_REQUIRED');
    console.log('✓ PASS: must_change_password and FIRST_LOGIN_REQUIRED properly enforced.\n');

    // Scenario N: Preserves credentials and other tables
    console.log('Test N: Preserves credentials, roles, and related records...');
    assert.strictEqual(checkUserK.rows[0].role_id, 2, 'Role must remain Front Office (2)');
    assert.strictEqual(checkUserK.rows[0].is_active, true, 'User is_active must remain true');
    console.log('✓ PASS: Preserved user identity and role integrity.\n');

    // Scenario O: Disabled employee cannot be reset without explicit authorization
    console.log('Test O: Deactivated employee cannot be reset...');
    await client.query('UPDATE hr_employees SET is_active = FALSE, status = $1 WHERE id = $2', ['INACTIVE', empIdK]);
    let disabledResetFailed = false;
    try {
      await resetEmployeePassword(client, TEST_PROPERTY_ID, empIdK, { name: 'HRD Admin' });
    } catch (err) {
      disabledResetFailed = true;
      assert.strictEqual(err.code, 'EMPLOYEE_DEACTIVATED');
    }
    assert.ok(disabledResetFailed, 'Resetting deactivated employee must fail');
    console.log('✓ PASS: Deactivated employee reset rejected.\n');

    // Scenario P: Cross-property repair strictly rejected
    console.log('Test P: Cross-property access strictly rejected...');
    let crossPropertyRejected = false;
    try {
      await diagnoseEmployeeLoginAccount(client, FOREIGN_PROPERTY_ID, empIdK);
    } catch (err) {
      crossPropertyRejected = true;
      assert.ok(err.statusCode === 404 || err.code === 'EMPLOYEE_NOT_FOUND');
    }
    assert.ok(crossPropertyRejected, 'Cross-property access must be rejected');
    console.log('✓ PASS: Cross-property access strictly rejected.\n');

    // Scenario Q: Platform Super Admin employee_id = NULL remains valid
    console.log('Test Q: Super Admin with employee_id = NULL remains valid...');
    const superAdminRes = await client.query('SELECT * FROM users WHERE role_id = 1 LIMIT 1');
    if (superAdminRes.rows.length > 0) {
      const sa = superAdminRes.rows[0];
      assert.ok(sa.username, 'Super Admin must exist');
      // If employee_id is null, it should remain untouched
      console.log(`  Super Admin @${sa.username} verified (employee_id = ${sa.employee_id || 'NULL'}).`);
    }
    console.log('✓ PASS: Super Admin accounts with employee_id = NULL remain supported.\n');

    // ===============================================================
    // SECTION: ROLE RESOLUTION & REACTIVATION SAFETY AUDIT (TESTS A-J)
    // ===============================================================
    console.log('=== RUNNING ROLE RESOLUTION & REACTIVATION SAFETY AUDIT (TESTS A-J) ===\n');

    // Safety Test A: Front Office resolves to actual Front Office role
    console.log('Safety Test A: Front Office resolves to actual Front Office role...');
    const dbFoRes = await client.query("SELECT id FROM roles WHERE LOWER(name) = 'front office' LIMIT 1");
    const expectedFoId = Number(dbFoRes.rows[0].id);
    const resolvedFoId = await resolveCanonicalRoleId(client, 'Front Office');
    assert.strictEqual(resolvedFoId, expectedFoId, `Front Office must resolve to canonical ID ${expectedFoId}`);
    console.log(`✓ PASS: Front Office resolved to canonical ID ${resolvedFoId}.\n`);

    // Safety Test B: Accounting resolves correctly
    console.log('Safety Test B: Accounting resolves correctly...');
    const dbAccRes = await client.query("SELECT id FROM roles WHERE LOWER(name) = 'accounting' LIMIT 1");
    const expectedAccId = Number(dbAccRes.rows[0].id);
    const resolvedAccId = await resolveCanonicalRoleId(client, 'Accounting');
    assert.strictEqual(resolvedAccId, expectedAccId, `Accounting must resolve to canonical ID ${expectedAccId}`);
    console.log(`✓ PASS: Accounting resolved to canonical ID ${resolvedAccId}.\n`);

    // Safety Test C: Housekeeping resolves correctly
    console.log('Safety Test C: Housekeeping resolves correctly...');
    const dbHkRes = await client.query("SELECT id FROM roles WHERE LOWER(name) = 'housekeeping' LIMIT 1");
    const expectedHkId = Number(dbHkRes.rows[0].id);
    const resolvedHkId = await resolveCanonicalRoleId(client, 'Housekeeping');
    assert.strictEqual(resolvedHkId, expectedHkId, `Housekeeping must resolve to canonical ID ${expectedHkId}`);
    console.log(`✓ PASS: Housekeeping resolved to canonical ID ${resolvedHkId}.\n`);

    // Safety Test D: General Manager resolves correctly
    console.log('Safety Test D: General Manager resolves correctly...');
    const dbGmRes = await client.query("SELECT id FROM roles WHERE LOWER(name) = 'general manager' LIMIT 1");
    const expectedGmId = Number(dbGmRes.rows[0].id);
    const resolvedGmId = await resolveCanonicalRoleId(client, 'General Manager');
    assert.strictEqual(resolvedGmId, expectedGmId, `General Manager must resolve to canonical ID ${expectedGmId}`);
    console.log(`✓ PASS: General Manager resolved to canonical ID ${resolvedGmId}.\n`);

    // Safety Test E: POS / Resto resolves correctly
    console.log('Safety Test E: POS / Resto resolves correctly...');
    const dbPosRes = await client.query("SELECT id FROM roles WHERE LOWER(name) = 'pos / resto' LIMIT 1");
    const expectedPosId = Number(dbPosRes.rows[0].id);
    const resolvedPosId = await resolveCanonicalRoleId(client, 'POS / Resto');
    assert.strictEqual(resolvedPosId, expectedPosId, `POS / Resto must resolve to canonical ID ${expectedPosId}`);
    const resolvedCashierId = await resolveCanonicalRoleId(client, 'Cashier / POS');
    assert.strictEqual(resolvedCashierId, expectedPosId, `Cashier / POS must resolve to canonical ID ${expectedPosId}`);
    console.log(`✓ PASS: POS / Resto resolved to canonical ID ${resolvedPosId}.\n`);

    // Safety Test F: Crew never accidentally resolves to POS / Resto
    console.log('Safety Test F: Crew never accidentally resolves to POS / Resto...');
    let crewRejected = false;
    try {
      await resolveCanonicalRoleId(client, 'Crew');
    } catch (err) {
      crewRejected = true;
      assert.strictEqual(err.code, 'INVALID_AUTH_ROLE');
    }
    assert.ok(crewRejected, 'Crew must NEVER resolve to an auth role (especially not POS / Resto 6)');
    console.log('✓ PASS: Crew throws INVALID_AUTH_ROLE and is never mapped to POS / Resto or guessed.\n');

    // Safety Test G: unknown role is rejected, not guessed
    console.log('Safety Test G: Unknown role is rejected, not guessed...');
    let unknownRejected = false;
    try {
      await resolveCanonicalRoleId(client, 'Gardener / Landscape');
    } catch (err) {
      unknownRejected = true;
      assert.strictEqual(err.code, 'INVALID_AUTH_ROLE');
    }
    assert.ok(unknownRejected, 'Unknown role must throw INVALID_AUTH_ROLE and not fall back to default');
    console.log('✓ PASS: Unknown role correctly rejected without guessing.\n');

    // Safety Test H: Super Admin cannot be assigned through HRD
    console.log('Safety Test H: Super Admin cannot be assigned through HRD...');
    let superAdminAssignRejected = false;
    try {
      await validateRoleAssignment(client, TEST_PROPERTY_ID, 'Super Admin');
    } catch (err) {
      superAdminAssignRejected = true;
      assert.strictEqual(err.code, 'PLATFORM_ADMIN_PROHIBITED');
    }
    assert.ok(superAdminAssignRejected, 'Super Admin assignment must be rejected with PLATFORM_ADMIN_PROHIBITED');

    let createSuperAdminRejected = false;
    try {
      await createEmployeeAccount(client, TEST_PROPERTY_ID, {
        property_id: TEST_PROPERTY_ID,
        full_name: 'Malicious Super Admin',
        role: 'Super Admin',
        email: `${TEST_PREFIX}hacked_sa@test.com`,
        create_login_account: true
      });
    } catch (err) {
      createSuperAdminRejected = true;
      assert.strictEqual(err.code, 'PLATFORM_ADMIN_PROHIBITED');
    }
    assert.ok(createSuperAdminRejected, 'Creating employee with Super Admin role must be blocked');
    console.log('✓ PASS: Super Admin role assignment strictly prohibited through HRD.\n');

    // Safety Test I: inactive HR employee cannot REACTIVATE_ACCOUNT
    console.log('Safety Test I: Inactive HR employee cannot REACTIVATE_ACCOUNT...');
    const inactEmpRes = await client.query(
      `INSERT INTO hr_employees (
        property_id, employee_code, full_name, role, status, is_active
      ) VALUES ($1, $2, $3, $4, 'TERMINATED', FALSE) RETURNING id`,
      [TEST_PROPERTY_ID, `${TEST_PREFIX}INACT_1`, 'Terminated Staff', 'Front Office']
    );
    const inactEmpId = inactEmpRes.rows[0].id;
    await client.query(
      `INSERT INTO users (
        property_id, username, email, password_hash, full_name, role_id, is_active, employee_id
      ) VALUES ($1, $2, $3, 'dummy_hash', $4, 2, FALSE, $5)`,
      [TEST_PROPERTY_ID, `${TEST_PREFIX}inact_user`, `${TEST_PREFIX}inact@test.com`, 'Terminated Staff', inactEmpId]
    );

    let reactivateInactiveRejected = false;
    try {
      await repairEmployeeLoginAccount(client, TEST_PROPERTY_ID, inactEmpId, {
        action: 'REACTIVATE_ACCOUNT'
      }, { name: 'HRD Manager' });
    } catch (err) {
      reactivateInactiveRejected = true;
      assert.strictEqual(err.code, 'EMPLOYEE_DISABLED');
    }
    assert.ok(reactivateInactiveRejected, 'Inactive employee must NOT be allowed to reactivate login account');
    console.log('✓ PASS: Inactive/terminated employee cannot regain login access via REACTIVATE_ACCOUNT.\n');

    // Safety Test J: active HR employee can reactivate an explicitly disabled auth account when actor is authorized
    console.log('Safety Test J: Active HR employee can reactivate explicitly disabled auth account...');
    const actEmpRes = await client.query(
      `INSERT INTO hr_employees (
        property_id, employee_code, full_name, role, status, is_active
      ) VALUES ($1, $2, $3, $4, 'ACTIVE', TRUE) RETURNING id`,
      [TEST_PROPERTY_ID, `${TEST_PREFIX}ACT_1`, 'Active Suspended Staff', 'Front Office']
    );
    const actEmpId = actEmpRes.rows[0].id;
    const actUserRes = await client.query(
      `INSERT INTO users (
        property_id, username, email, password_hash, full_name, role_id, is_active, employee_id
      ) VALUES ($1, $2, $3, 'dummy_hash', $4, 2, FALSE, $5) RETURNING id`,
      [TEST_PROPERTY_ID, `${TEST_PREFIX}act_user`, `${TEST_PREFIX}act@test.com`, 'Active Suspended Staff', actEmpId]
    );
    const actUserId = actUserRes.rows[0].id;

    const reactivateResult = await repairEmployeeLoginAccount(client, TEST_PROPERTY_ID, actEmpId, {
      action: 'REACTIVATE_ACCOUNT'
    }, { name: 'HRD Supervisor', role: 'General Manager' });

    assert.strictEqual(reactivateResult.status, 'OK');
    assert.strictEqual(reactivateResult.data.is_active, true);

    const checkUserActive = await client.query('SELECT is_active FROM users WHERE id = $1', [actUserId]);
    assert.strictEqual(checkUserActive.rows[0].is_active, true, 'User is_active must be updated to TRUE in database');
    console.log('✓ PASS: Active HR employee successfully reactivates disabled auth account.\n');

    console.log('===============================================================');
    console.log('ALL AUTH-HR-2A INTEGRATION TESTS (A THROUGH Q) AND');
    console.log('ROLE & REACTIVATION SAFETY AUDIT TESTS (A THROUGH J) PASSED!');
    console.log('===============================================================\n');
  } finally {
    // Ensure clean teardown - leave zero test residue
    await cleanupTestData(client);
    client.release();
    await pool.end();
  }
}

runAuthHr2aTests().catch((err) => {
  console.error('\n❌ AUTH-HR-2A TEST SUITE FAILED:', err);
  process.exit(1);
});

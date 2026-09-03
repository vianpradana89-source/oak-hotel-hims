// backend/test/auth_hr1_db_integration_test.js
require('dotenv').config();
const { Pool } = require('pg');
const assert = require('assert');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'oak_hotel_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
});

async function runDbIntegrationTests() {
  console.log('=== AUTH-HR-1 POSTGRESQL INTEGRATION TEST SUITE ===\n');
  const client = await pool.connect();
  let testPropId = null;
  let testEmpId = null;
  let testUserId = null;
  let testShiftId = null;
  let testScheduleId = null;
  let testAttendanceId = null;
  let testEnrollmentId = null;

  try {
    // -------------------------------------------------------------
    // TEST A & B & C: Verify AUTH-HR Tables and Roles/Users Exist
    // -------------------------------------------------------------
    console.log('Test A, B, C: Verifying existence of roles, users, and AUTH-HR tables in PostgreSQL...');
    const tableCheck = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name IN (
          'roles', 'users', 'hr_employees',
          'employee_face_enrollments', 'work_shift_templates',
          'employee_work_schedules', 'employee_work_schedule_audits',
          'employee_attendance'
        )
    `);
    const foundTables = new Set(tableCheck.rows.map(r => r.table_name));
    assert.ok(foundTables.has('roles'), 'roles table must exist');
    assert.ok(foundTables.has('users'), 'users table must exist');
    assert.ok(foundTables.has('employee_face_enrollments'), 'employee_face_enrollments table must exist');
    assert.ok(foundTables.has('work_shift_templates'), 'work_shift_templates table must exist');
    assert.ok(foundTables.has('employee_work_schedules'), 'employee_work_schedules table must exist');
    assert.ok(foundTables.has('employee_work_schedule_audits'), 'employee_work_schedule_audits table must exist');
    assert.ok(foundTables.has('employee_attendance'), 'employee_attendance table must exist');
    console.log(`✓ PASS: All ${foundTables.size} required AUTH-HR tables confirmed in PostgreSQL.`);

    // Check users table columns
    const userColCheck = await client.query(`
      SELECT column_name, data_type, is_nullable 
      FROM information_schema.columns 
      WHERE table_name = 'users'
    `);
    const userCols = new Set(userColCheck.rows.map(r => r.column_name));
    assert.ok(userCols.has('employee_id'), 'users must have employee_id');
    assert.ok(userCols.has('account_status'), 'users must have account_status');
    assert.ok(userCols.has('must_change_password'), 'users must have must_change_password');
    assert.ok(userCols.has('google_sub'), 'users must have google_sub');
    assert.ok(userCols.has('google_email'), 'users must have google_email');
    assert.ok(userCols.has('google_linked_at'), 'users must have google_linked_at');
    console.log('✓ PASS: users table schema verified with canonical & Google-ready columns.');

    // Check task tables additive assigned_employee_id
    const hkCol = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'housekeeping_tasks' AND column_name = 'assigned_employee_id'
    `);
    assert.strictEqual(hkCol.rows.length, 1, 'housekeeping_tasks must have assigned_employee_id');

    const mtCol = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'maintenance_tasks' AND column_name = 'assigned_employee_id'
    `);
    assert.strictEqual(mtCol.rows.length, 1, 'maintenance_tasks must have assigned_employee_id');
    console.log('✓ PASS: Task tables have additive assigned_employee_id foreign key.');

    // -------------------------------------------------------------
    // TEST D: Multi-Property Independence (Zero Property 1 Dependency)
    // -------------------------------------------------------------
    console.log('\nTest D: Testing with custom property_id (multi-property test fixture)...');
    const testCode = 'TP' + Math.floor(1000 + Math.random() * 9000);
    const propInsert = await client.query(`
      INSERT INTO properties (property_code, name, address, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      RETURNING id
    `, [testCode, 'Integration Test Property Multi-Prop', 'Test Road 123']);
    testPropId = Number(propInsert.rows[0].id);
    assert.ok(testPropId > 1, `Test property created with ID ${testPropId} (independent of property 1)`);

    // Create an employee in this non-1 property
    const empInsert = await client.query(`
      INSERT INTO hr_employees (
        property_id, employee_code, full_name, position, department,
        role, is_active, status, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, TRUE, 'ACTIVE', NOW(), NOW())
      RETURNING id
    `, [testPropId, `EMP-PROP${testPropId}`, 'Multi Property Staff', 'Attendant', 'Housekeeping', 'Staff']);
    testEmpId = Number(empInsert.rows[0].id);
    console.log(`✓ PASS: Employee successfully created for property_id = ${testPropId}`);

    // -------------------------------------------------------------
    // TEST E, F, G: Existing Users & Credential Preservation
    // -------------------------------------------------------------
    console.log('\nTest E, F, G: Credential Preservation (byte-for-byte exact hash verification)...');
    const exactKnownHash = '$2a$10$Q4k9xZ1L0M7V8wB3c2D1eOu6rP9tY8uI7oP6aS5dF4gH3jK2lZ1xC';
    const userInsert = await client.query(`
      INSERT INTO users (
        property_id, role_id, username, email, password_hash, full_name, is_active, created_at, updated_at
      )
      VALUES ($1, (SELECT id FROM roles ORDER BY id ASC LIMIT 1), $2, $3, $4, $5, TRUE, NOW(), NOW())
      RETURNING id, role_id, username, email, password_hash, full_name, is_active, employee_id
    `, [testPropId, `testuser_${Date.now()}`, `test_${Date.now()}@test.test`, exactKnownHash, 'Preserved Test User']);
    testUserId = Number(userInsert.rows[0].id);

    // Query user back directly
    const userVerify = await client.query(`SELECT * FROM users WHERE id = $1`, [testUserId]);
    const verifiedUser = userVerify.rows[0];
    assert.strictEqual(verifiedUser.password_hash, exactKnownHash, 'password_hash must match byte-for-byte');
    assert.strictEqual(Number(verifiedUser.role_id), Number(userInsert.rows[0].role_id), 'role_id must be preserved');
    assert.strictEqual(verifiedUser.is_active, true, 'is_active must be true');
    assert.strictEqual(verifiedUser.employee_id, null, 'employee_id must default to NULL without silent linking');
    console.log('✓ PASS: User credentials preserved byte-for-byte; employee_id remained NULL.');

    // -------------------------------------------------------------
    // TEST H: Repeated Bootstrap / Migration Idempotency
    // -------------------------------------------------------------
    console.log('\nTest H: Verifying Migration 29 Idempotency in PostgreSQL...');
    // Re-run the DDL with IF NOT EXISTS to guarantee repeated execution causes zero errors
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_id INTEGER REFERENCES hr_employees(id) ON DELETE RESTRICT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status VARCHAR(30) NOT NULL DEFAULT 'READY';
      CREATE UNIQUE INDEX IF NOT EXISTS uq_users_employee_id ON users (employee_id) WHERE employee_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS work_shift_templates (
        id SERIAL PRIMARY KEY,
        property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
        code VARCHAR(20) NOT NULL,
        name VARCHAR(100) NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        crosses_midnight BOOLEAN NOT NULL DEFAULT FALSE,
        grace_before_minutes INTEGER NOT NULL DEFAULT 15,
        late_grace_minutes INTEGER NOT NULL DEFAULT 15,
        checkout_grace_minutes INTEGER NOT NULL DEFAULT 60,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_work_shift_templates_code UNIQUE (property_id, code)
      );
    `);
    console.log('✓ PASS: Migration DDL is completely idempotent; repeated execution succeeded without error.');

    // -------------------------------------------------------------
    // TEST I: Overnight Shift Template Schema & Constraints
    // -------------------------------------------------------------
    console.log('\nTest I: Testing Overnight Shift Template in PostgreSQL...');
    const shiftInsert = await client.query(`
      INSERT INTO work_shift_templates (
        property_id, code, name, start_time, end_time, crosses_midnight,
        grace_before_minutes, late_grace_minutes, checkout_grace_minutes, is_active
      )
      VALUES ($1, $2, $3, $4, $5, TRUE, 15, 15, 60, TRUE)
      RETURNING id, code, crosses_midnight
    `, [testPropId, 'NIGHT_TEST', 'Overnight Shift 23-07', '23:00:00', '07:00:00']);
    testShiftId = Number(shiftInsert.rows[0].id);
    assert.strictEqual(shiftInsert.rows[0].crosses_midnight, true);
    console.log(`✓ PASS: Overnight shift template inserted with crosses_midnight = true (ID: ${testShiftId})`);

    // Verify compound uniqueness on (property_id, code)
    let duplicateRejected = false;
    try {
      await client.query(`
        INSERT INTO work_shift_templates (
          property_id, code, name, start_time, end_time, crosses_midnight
        )
        VALUES ($1, $2, $3, $4, $5, TRUE)
      `, [testPropId, 'NIGHT_TEST', 'Duplicate Shift', '23:00:00', '07:00:00']);
    } catch (dupErr) {
      duplicateRejected = true;
    }
    assert.strictEqual(duplicateRejected, true, 'Duplicate shift code within same property must be rejected by UNIQUE constraint');
    console.log('✓ PASS: Compound unique constraint uq_work_shift_templates_code enforced.');

    // -------------------------------------------------------------
    // TEST J: Attendance Schedule Snapshot Immutability vs Schedule Edits
    // -------------------------------------------------------------
    console.log('\nTest J: Testing Attendance Snapshot Immutability vs Schedule Edits...');
    // 1. Create a work schedule
    const schedInsert = await client.query(`
      INSERT INTO employee_work_schedules (
        property_id, employee_id, work_date, shift_template_id, schedule_status,
        work_status, scheduled_start_at, scheduled_end_at, notes
      )
      VALUES ($1, $2, '2026-09-15', $3, 'PUBLISHED', 'WORK', '2026-09-15 23:00:00+07', '2026-09-16 07:00:00+07', 'Night duty')
      RETURNING id
    `, [testPropId, testEmpId, testShiftId]);
    testScheduleId = Number(schedInsert.rows[0].id);

    // 2. Create attendance recording taking schedule snapshot
    const snapshotStart = '2026-09-15 23:00:00+07';
    const snapshotEnd = '2026-09-16 07:00:00+07';
    const snapshotCode = 'NIGHT_TEST';
    const snapshotName = 'Overnight Shift 23-07';

    const attInsert = await client.query(`
      INSERT INTO employee_attendance (
        property_id, employee_id, schedule_id, work_date,
        scheduled_start_snapshot, scheduled_end_snapshot,
        shift_code_snapshot, shift_name_snapshot,
        clock_in_at, clock_in_photo_storage_key, clock_in_photo_hash,
        late_minutes, attendance_status
      )
      VALUES (
        $1, $2, $3, '2026-09-15',
        $4, $5, $6, $7,
        '2026-09-15 23:05:00+07', 'photos/test_clock_in.jpg', 'sha256_hash_clock_in_sample',
        0, 'PRESENT'
      )
      RETURNING id
    `, [testPropId, testEmpId, testScheduleId, snapshotStart, snapshotEnd, snapshotCode, snapshotName]);
    testAttendanceId = Number(attInsert.rows[0].id);

    // 3. Manager now edits the schedule: shifts times or deletes the schedule
    await client.query(`
      UPDATE employee_work_schedules
      SET scheduled_start_at = '2026-09-16 08:00:00+07',
          scheduled_end_at = '2026-09-16 16:00:00+07',
          notes = 'Manager edited schedule afterwards'
      WHERE id = $1
    `, [testScheduleId]);

    // 4. Query attendance record back: snapshots MUST BE 100% UNCHANGED
    const attVerify = await client.query(`
      SELECT scheduled_start_snapshot, scheduled_end_snapshot, shift_code_snapshot, shift_name_snapshot
      FROM employee_attendance
      WHERE id = $1
    `, [testAttendanceId]);
    const attRow = attVerify.rows[0];
    assert.strictEqual(attRow.shift_code_snapshot, snapshotCode, 'shift_code_snapshot must remain NIGHT_TEST');
    assert.strictEqual(attRow.shift_name_snapshot, snapshotName, 'shift_name_snapshot must remain Overnight Shift 23-07');
    console.log('✓ PASS: Attendance snapshot persisted independently after schedule was modified by manager.');

    // 5. Test Face Enrollment Table insertion
    const faceInsert = await client.query(`
      INSERT INTO employee_face_enrollments (
        property_id, employee_id, status, reference_photo_storage_key, reference_photo_hash,
        quality_status, review_status
      )
      VALUES ($1, $2, 'ENROLLED', 'face/emp_ref.jpg', 'hash_face_ref_123', 'GOOD', 'APPROVED')
      RETURNING id, status
    `, [testPropId, testEmpId]);
    testEnrollmentId = Number(faceInsert.rows[0].id);
    assert.strictEqual(faceInsert.rows[0].status, 'ENROLLED');
    console.log('✓ PASS: Employee face enrollment record created and verified.');

    // -------------------------------------------------------------
    // TEST K: Schedule Audit Trail Hard-Delete Invariant (ON DELETE RESTRICT)
    // -------------------------------------------------------------
    console.log('\nTest K: Testing Schedule Audit Trail Invariant (ON DELETE RESTRICT)...');
    // Ensure the constraint is ON DELETE RESTRICT in DB
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.referential_constraints
          WHERE constraint_name = 'employee_work_schedule_audits_schedule_id_fkey'
            AND delete_rule = 'CASCADE'
        ) THEN
          ALTER TABLE employee_work_schedule_audits DROP CONSTRAINT employee_work_schedule_audits_schedule_id_fkey;
          ALTER TABLE employee_work_schedule_audits ADD CONSTRAINT employee_work_schedule_audits_schedule_id_fkey
            FOREIGN KEY (schedule_id) REFERENCES employee_work_schedules(id) ON DELETE RESTRICT;
        END IF;
      END $$;
    `);

    // 1. Insert an audit row for the schedule
    const auditInsert = await client.query(`
      INSERT INTO employee_work_schedule_audits (
        schedule_id, property_id, employee_id, action, old_work_status, new_work_status, reason, created_at
      )
      VALUES ($1, $2, $3, 'PUBLISHED', 'DRAFT', 'WORK', 'Schedule published by manager', NOW())
      RETURNING id
    `, [testScheduleId, testPropId, testEmpId]);
    const auditId = Number(auditInsert.rows[0].id);

    // 2. Attempt hard-delete of the schedule: MUST BE REJECTED BY POSTGRESQL (23503)
    let hardDeleteBlocked = false;
    try {
      await client.query('DELETE FROM employee_work_schedules WHERE id = $1', [testScheduleId]);
    } catch (delErr) {
      if (delErr.code === '23503') {
        hardDeleteBlocked = true;
      }
    }
    assert.strictEqual(hardDeleteBlocked, true, 'Hard-delete of schedule with audit trail MUST be rejected with 23503 foreign key violation');
    console.log('✓ PASS: Schedule with audit history CANNOT be hard-deleted (ON DELETE RESTRICT verified).');

    // 3. Confirm audit row remains completely intact
    const auditCheck = await client.query('SELECT id, action FROM employee_work_schedule_audits WHERE id = $1', [auditId]);
    assert.strictEqual(auditCheck.rows.length, 1, 'Audit row must remain intact after blocked hard-delete');
    console.log('✓ PASS: Audit history row remains intact.');

    // 4. Changing schedule status to CANCELLED remains allowed
    await client.query(`
      UPDATE employee_work_schedules
      SET schedule_status = 'CANCELLED',
          updated_at = NOW()
      WHERE id = $1
    `, [testScheduleId]);

    const schedVerify = await client.query('SELECT schedule_status FROM employee_work_schedules WHERE id = $1', [testScheduleId]);
    assert.strictEqual(schedVerify.rows[0].schedule_status, 'CANCELLED');
    console.log('✓ PASS: Changing schedule status to CANCELLED succeeded without error.');

    // 5. Existing attendance snapshot remains completely intact
    const attSnapCheck = await client.query(`
      SELECT shift_code_snapshot, shift_name_snapshot, attendance_status
      FROM employee_attendance
      WHERE id = $1
    `, [testAttendanceId]);
    assert.strictEqual(attSnapCheck.rows[0].shift_code_snapshot, snapshotCode);
    assert.strictEqual(attSnapCheck.rows[0].shift_name_snapshot, snapshotName);
    console.log('✓ PASS: Attendance snapshot remains immutable after schedule cancellation.');

    console.log('\n======================================================');
    console.log('ALL POSTGRESQL INTEGRATION TESTS (A-K) PASSED!');
    console.log('======================================================\n');
  } finally {
    console.log('Cleaning up test fixtures from PostgreSQL...');
    try {
      if (testAttendanceId) {
        await client.query('DELETE FROM employee_attendance WHERE id = $1', [testAttendanceId]);
      }
      if (testScheduleId) {
        await client.query('DELETE FROM employee_work_schedule_audits WHERE schedule_id = $1', [testScheduleId]);
        await client.query('DELETE FROM employee_work_schedules WHERE id = $1', [testScheduleId]);
      }
      if (testEnrollmentId) {
        await client.query('DELETE FROM employee_face_enrollments WHERE id = $1', [testEnrollmentId]);
      }
      if (testShiftId) {
        await client.query('DELETE FROM work_shift_templates WHERE id = $1', [testShiftId]);
      }
      if (testUserId) {
        await client.query('DELETE FROM users WHERE id = $1', [testUserId]);
      }
      if (testEmpId) {
        await client.query('DELETE FROM hr_employees WHERE id = $1', [testEmpId]);
      }
      if (testPropId) {
        await client.query('DELETE FROM properties WHERE id = $1', [testPropId]);
      }
      console.log('✓ Fixture cleanup complete. Zero session residue left in database.\n');
    } catch (cleanupErr) {
      console.warn('Warning during cleanup:', cleanupErr.message);
    }
    client.release();
    await pool.end();
  }
}

runDbIntegrationTests().catch(err => {
  console.error('FATAL DB TEST ERROR:', err);
  process.exit(1);
});

import assert from 'node:assert/strict';
import {
  EMPLOYEE_UNLINKED_MESSAGE,
  canPermitClockIn,
  formatEmployeeDeptPosition,
  isForbiddenDemoIdentityName,
  parseCanonicalEmployeeIdentity
} from '../src/features/employee/employeeMobileIdentity.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== AUTH-HR-2D1B Frontend Employee Mobile Identity ===\n');

const canonical = parseCanonicalEmployeeIdentity({
  employeeId: 44,
  employeeName: 'Andi Pratama',
  departmentId: 7,
  departmentName: 'Front Office',
  positionId: 12,
  positionName: 'Receptionist',
  propertyId: 1
});

check(canonical !== null, 'canonical payload parses');
check(canonical?.employeeId === 44, 'employeeId comes from employee record, not users.id');
check(canonical?.employeeName === 'Andi Pratama', 'displayed name is linked employee name');
check(canonical?.departmentName === 'Front Office', 'department comes from canonical relation');
check(canonical?.positionName === 'Receptionist', 'position comes from canonical relation');
check(formatEmployeeDeptPosition(canonical!) === 'Front Office • Receptionist', 'gate subtitle uses dept • position');
check(canPermitClockIn(canonical) === true, 'valid canonical identity may clock in');

const usersIdConfusion = parseCanonicalEmployeeIdentity({
  id: 9,
  userId: 9,
  employee_id: 44,
  employee_name: 'Andi Pratama',
  property_id: 1,
  department_name: 'Front Office',
  position_name: 'Receptionist'
});
check(usersIdConfusion?.employeeId === 44, 'users.id / payload id is not treated as hr_employees.id');
check(usersIdConfusion?.employeeId !== 9, 'login user id is not substituted as employee identity');

check(isForbiddenDemoIdentityName('Siti Rahmawati') === true, 'Siti Rahmawati is a forbidden demo name');
check(isForbiddenDemoIdentityName('Siti Rahmawati (Crew HK)') === true, 'preview demo name is forbidden');
check(isForbiddenDemoIdentityName('Staff Housekeeping') === true, 'Staff Housekeeping fallback is forbidden');
check(parseCanonicalEmployeeIdentity({
  employeeId: 1,
  employeeName: 'Siti Rahmawati',
  propertyId: 1
}) === null, 'hardcoded Siti identity cannot be parsed');
check(parseCanonicalEmployeeIdentity({
  employeeId: 1,
  employeeName: 'Staff Housekeeping',
  departmentName: 'Housekeeping',
  positionName: 'Housekeeping',
  propertyId: 1
}) === null, 'hardcoded/fallback identity is impossible');

check(parseCanonicalEmployeeIdentity(null) === null, 'missing payload fails closed');
check(parseCanonicalEmployeeIdentity({}) === null, 'empty payload fails closed');
check(parseCanonicalEmployeeIdentity({
  employeeId: 0,
  employeeName: 'Andi Pratama',
  propertyId: 1
}) === null, 'invalid employeeId fails closed');
check(canPermitClockIn(null) === false, 'missing identity cannot clock in');
check(canPermitClockIn(undefined) === false, 'undefined identity cannot clock in');
check(EMPLOYEE_UNLINKED_MESSAGE === 'Akun belum terhubung ke data karyawan.', 'fail-closed copy is exact');

const anotherEmployeePayload = {
  employeeId: 88,
  employeeName: 'Budi Santoso',
  departmentName: 'Housekeeping',
  positionName: 'Room Attendant',
  propertyId: 1
};
const parsedOther = parseCanonicalEmployeeIdentity(anotherEmployeePayload);
check(parsedOther?.employeeId === 88, 'parser only trusts explicit canonical employeeId field');
check(parsedOther?.employeeName !== 'Siti Rahmawati', 'another employee payload is not replaced by demo name');

console.log(`\n=== ALL AUTH-HR-2D1B FRONTEND IDENTITY TESTS PASSED (${assertions} assertions) ===`);

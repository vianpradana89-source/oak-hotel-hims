import assert from 'node:assert/strict';
import {
  getCellAssignments,
  mergeCandidatesWithAssignments,
} from '../src/features/hrd/scheduleCellAssignments.ts';
import type {
  HrEmployee,
  OperationalRosterResponse,
  WeeklyRosterEmployee,
} from '../src/features/hrd/scheduleTypes.ts';

const date = '2027-12-31';
const shiftTemplate = {
  id: 10,
  property_id: 1,
  code: 'PAGI',
  name: 'Pagi',
  start_time: '07:00',
  end_time: '15:00',
  crosses_midnight: false,
  grace_before_minutes: 15,
  late_grace_minutes: 15,
  checkout_grace_minutes: 60,
  is_active: true,
  department_id: null,
  color_key: 'soft_green',
};

function rosterEmployee(id: number, name: string, departmentId: number): WeeklyRosterEmployee {
  return {
    employee_id: id,
    employee_name: name,
    employee_code: `EMP-${id}`,
    department_id: departmentId,
    department_name: `Department ${departmentId}`,
    position_name: 'Staff',
    schedules: {
      [date]: {
        id: 100 + id,
        property_id: 1,
        employee_id: id,
        work_date: date,
        shift_template_id: shiftTemplate.id,
        schedule_status: 'DRAFT',
        work_status: 'WORK',
        scheduled_start_at: null,
        scheduled_end_at: null,
      },
    },
  };
}

const groupedRoster: OperationalRosterResponse = {
  dates: [date],
  shift_templates: [shiftTemplate],
  non_operational_groups: [],
  groups: [
    {
      group_id: 1,
      group_name: 'Front Office',
      group_code: 'FO',
      department_ids: [1],
      employees: [rosterEmployee(1, 'Nadya Nur Fadilah', 1)],
    },
    {
      group_id: 2,
      group_name: 'Support',
      group_code: 'SUP',
      department_ids: [2],
      employees: [rosterEmployee(2, 'Cross Department Employee', 2)],
    },
  ],
};

const assignments = getCellAssignments(null, groupedRoster, date, 'shift', shiftTemplate.id);
assert.deepEqual(
  assignments.map(employee => employee.id).sort(),
  [1, 2],
  'fresh Grouped data must initialize all assignments without a Per Shift roster',
);

const departmentOneCandidate: HrEmployee = {
  id: 1,
  property_id: 1,
  employee_code: 'EMP-1',
  full_name: 'Nadya Nur Fadilah',
  department_id: 1,
  department_name: 'Department 1',
  position_id: null,
  position_name: 'Staff',
  is_active: true,
};
const visibleEmployees = mergeCandidatesWithAssignments([departmentOneCandidate], assignments);
assert.deepEqual(
  visibleEmployees.map(employee => employee.id).sort(),
  [1, 2],
  'candidate filtering must not hide a selected cross-department assignment',
);

groupedRoster.groups[0].employees[0].schedules[date]!.schedule_status = 'CANCELLED';
const activeAssignments = getCellAssignments(null, groupedRoster, date, 'shift', shiftTemplate.id);
assert.deepEqual(activeAssignments.map(employee => employee.id), [2], 'cancelled assignments must not remain selected');

console.log('HR grouped schedule cell regression: 3 assertions PASSED');

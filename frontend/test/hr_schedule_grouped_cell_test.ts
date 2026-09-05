import assert from 'node:assert/strict';
import {
  getCellAssignmentPermissions,
  getCellAssignments,
  getCorrectionTarget,
  mergeCandidatesWithAssignments,
} from '../src/features/hrd/scheduleCellAssignments.ts';
import type {
  HrEmployee,
  OperationalRosterResponse,
  ScheduleStatus,
  WeeklyRosterResponse,
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

function rosterEmployee(
  id: number,
  name: string,
  departmentId: number,
  scheduleId: number,
  scheduleStatus: ScheduleStatus,
): WeeklyRosterEmployee {
  return {
    employee_id: id,
    employee_name: name,
    employee_code: `EMP-${id}`,
    department_id: departmentId,
    department_name: `Department ${departmentId}`,
    position_name: 'Staff',
    schedules: {
      [date]: {
        id: scheduleId,
        property_id: 1,
        employee_id: id,
        work_date: date,
        shift_template_id: shiftTemplate.id,
        schedule_status: scheduleStatus,
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
      employees: [
        rosterEmployee(1, 'Draft Employee', 1, 501, 'DRAFT'),
        rosterEmployee(2, 'Published Employee', 1, 602, 'PUBLISHED'),
        rosterEmployee(3, 'Changed Employee', 1, 703, 'CHANGED'),
      ],
    },
    {
      group_id: 2,
      group_name: 'Support',
      group_code: 'SUP',
      department_ids: [2],
      employees: [rosterEmployee(4, 'Other Group Employee', 2, 804, 'PUBLISHED')],
    },
  ],
};

const staleRoster: WeeklyRosterResponse = {
  start_date: date,
  end_date: date,
  dates: [date],
  shift_templates: [shiftTemplate],
  employees: [rosterEmployee(5, 'Stale Per-Shift Employee', 1, 905, 'PUBLISHED')],
};

const assignments = getCellAssignments(staleRoster, groupedRoster, date, 'shift', shiftTemplate.id, 1);
assert.deepEqual(
  assignments.map(assignment => ({
    employee_id: assignment.id,
    schedule_id: assignment.schedule_id,
    schedule_status: assignment.schedule_status,
    work_status: assignment.schedule.work_status,
    shift_template_id: assignment.schedule.shift_template_id,
  })),
  [
    { employee_id: 1, schedule_id: 501, schedule_status: 'DRAFT', work_status: 'WORK', shift_template_id: 10 },
    { employee_id: 2, schedule_id: 602, schedule_status: 'PUBLISHED', work_status: 'WORK', shift_template_id: 10 },
    { employee_id: 3, schedule_id: 703, schedule_status: 'CHANGED', work_status: 'WORK', shift_template_id: 10 },
  ],
  'a Grouped cell must retain each selected employee canonical assignment from the clicked group only',
);

const departmentOneCandidate: HrEmployee = {
  id: 1,
  property_id: 1,
  employee_code: 'EMP-1',
  full_name: 'Draft Employee',
  department_id: 1,
  department_name: 'Department 1',
  position_id: null,
  position_name: 'Staff',
  is_active: true,
};
const visibleEmployees = mergeCandidatesWithAssignments([departmentOneCandidate], assignments);
assert.deepEqual(
  visibleEmployees.map(employee => employee.id).sort(),
  [1, 2, 3],
  'candidate filtering must not hide selected assignments',
);

const draft = assignments.find(assignment => assignment.id === 1)!;
const published = assignments.find(assignment => assignment.id === 2)!;
const changed = assignments.find(assignment => assignment.id === 3)!;

assert.deepEqual(
  getCellAssignmentPermissions(draft),
  { canToggle: true, canCorrect: false, correctionBlockedReason: null },
  'DRAFT assignments must keep normal checkbox editing',
);
assert.deepEqual(
  getCellAssignmentPermissions(published),
  { canToggle: false, canCorrect: true, correctionBlockedReason: null },
  'PUBLISHED assignments must expose correction and not direct removal',
);
assert.equal(
  getCorrectionTarget(published)?.schedule_id,
  602,
  'the PUBLISHED row correction action must target its exact canonical schedule_id',
);
assert.equal(
  getCellAssignmentPermissions(changed).canCorrect,
  false,
  'CHANGED assignments cannot be corrected again until backend business rules permit it',
);
assert.match(
  getCellAssignmentPermissions(changed).correctionBlockedReason || '',
  /Publish ulang/,
  'CHANGED assignments must explain how another correction becomes available',
);

groupedRoster.groups[0].employees[0].schedules[date]!.schedule_status = 'CANCELLED';
const activeAssignments = getCellAssignments(null, groupedRoster, date, 'shift', shiftTemplate.id, 1);
assert.deepEqual(activeAssignments.map(employee => employee.id), [2, 3], 'cancelled assignments must not remain selected');

console.log('HR grouped schedule mixed-cell regression: 8 assertions PASSED');

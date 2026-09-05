// backend/src/domains/schedule/scheduleService.ts
import type { PoolClient } from 'pg';
import type {
  CreateShiftTemplatePayload,
  UpdateShiftTemplatePayload,
  WeeklyRosterQuery,
  WeeklyRosterResponse,
  WeeklyRosterEmployee,
  AssignSchedulePayload,
  BulkAssignSchedulePayload,
  CopyWeekPayload,
  CopyWeekResult,
  PublishSchedulePayload,
  PublishScheduleResult,
  GetScheduleForAttendanceQuery,
  AttendanceScheduleResult,
  MonthlyRosterQuery,
  MonthlyRosterResponse,
  MonthlyRosterEmployee,
  WorkShiftTemplate,
  EmployeeWorkSchedule,
  ShiftTemplateTeamMember,
} from './scheduleTypes';

export const VALID_COLOR_KEYS = [
  'soft_green', 'soft_blue', 'soft_amber', 'soft_purple',
  'soft_rose', 'soft_cyan', 'soft_slate',
] as const;

export type ColorKey = typeof VALID_COLOR_KEYS[number];

export function isValidColorKey(val: any): val is ColorKey {
  return typeof val === 'string' && (VALID_COLOR_KEYS as readonly string[]).includes(val);
}

function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function computeCrossesMidnight(start: string, end: string): boolean {
  return parseTimeToMinutes(end) <= parseTimeToMinutes(start);
}

/**
 * Resolve IANA timezone to its UTC offset string (e.g. 'Asia/Jakarta' → '+07:00').
 * Uses a reference date of 2000-01-01T12:00:00 to avoid DST ambiguity at midnight.
 */
function resolveTimezoneOffset(timezone: string): string {
  const ref = new Date('2000-01-01T12:00:00Z');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'shortOffset',
  }).formatToParts(ref);
  const tzPart = parts.find((p) => p.type === 'timeZoneName');
  if (tzPart) {
    const m = tzPart.value.match(/GMT([+-]\d{1,2}(?::\d{2})?)/);
    if (m) {
      const raw = m[1];
      const hasColon = raw.includes(':');
      if (hasColon) {
        const sign = raw.startsWith('-') ? '-' : '+';
        const nums = raw.slice(1);
        const [hh, mm] = nums.split(':');
        return `${sign}${hh.padStart(2, '0')}:${mm.padStart(2, '0')}`;
      }
      const num = parseInt(raw, 10);
      const sign = num >= 0 ? '+' : '-';
      const absNum = Math.abs(num);
      return `${sign}${String(absNum).padStart(2, '0')}:00`;
    }
    if (tzPart.value === 'GMT' || tzPart.value === 'UTC') return '+00:00';
  }
  return '+07:00';
}

function buildScheduledTimestamps(
  workDate: string,
  startTime: string,
  endTime: string,
  crossesMidnight: boolean,
  timezone = 'Asia/Jakarta'
): { scheduled_start_at: string; scheduled_end_at: string } {
  const offset = resolveTimezoneOffset(timezone);

  const startParts = startTime.split(':');
  const startHHMM = `${startParts[0]}:${startParts[1]}`;
  const endParts = endTime.split(':');
  const endHHMM = `${endParts[0]}:${endParts[1]}`;

  const scheduled_start_at = `${workDate}T${startHHMM}:00.000${offset}`;
  let endDate = workDate;
  if (crossesMidnight) {
    endDate = addDays(workDate, 1);
  }
  const scheduled_end_at = `${endDate}T${endHHMM}:00.000${offset}`;
  return { scheduled_start_at, scheduled_end_at };
}

async function fetchPropertyTimezone(client: PoolClient, propertyId: number): Promise<string> {
  const res = await client.query( 'SELECT timezone FROM properties WHERE id = $1', [propertyId]);
  return (res.rows[0]?.timezone as string) || 'Asia/Jakarta';
}

async function resolveValidUserId(client: PoolClient, userId?: number | null): Promise<number | null> {
  if (!userId) return null;
  const res = await client.query( 'SELECT id FROM users WHERE id = $1', [userId]);
  return (res.rowCount ?? 0) > 0 ? userId : null;
}

function toDateStr(val: any): string {
  if (typeof val === 'string') return val.split('T')[0];
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(val);
}

function formatShiftTemplate(row: any): WorkShiftTemplate {
  return {
    id: row.id,
    property_id: row.property_id,
    code: row.code,
    name: row.name,
    start_time: row.start_time,
    end_time: row.end_time,
    crosses_midnight: row.crosses_midnight,
    grace_before_minutes: row.grace_before_minutes,
    late_grace_minutes: row.late_grace_minutes,
    checkout_grace_minutes: row.checkout_grace_minutes,
    is_active: row.is_active,
    department_id: row.department_id ?? null,
    color_key: row.color_key || 'soft_slate',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function formatSchedule(row: any): EmployeeWorkSchedule {
  // work_date is a PostgreSQL DATE — it is a business calendar date, NOT a timestamp.
  // All canonical queries MUST return work_date::text AS work_date (YYYY-MM-DD string).
  // We must NEVER timezone-convert, shift, or guess from a Date object.
  const raw = row.work_date;

  if (raw instanceof Date) {
    // A Date object means the query did not use work_date::text.
    // This is a programming integrity error — not a data error.
    throw new Error(
      'SCHEDULE_WORK_DATE_FORMAT_ERROR: work_date must be returned as YYYY-MM-DD text via work_date::text AS work_date. ' +
      'Received a Date object instead. Check that all employee_work_schedules SELECT queries use work_date::text.'
    );
  }

  if (typeof raw !== 'string') {
    throw new Error(
      `SCHEDULE_WORK_DATE_FORMAT_ERROR: work_date must be a string, got ${typeof raw}`
    );
  }

  // work_date is a string: preserve YYYY-MM-DD, or extract date part from ISO timestamp.
  const workDate = raw.includes('T') ? raw.split('T')[0] : raw;

  return {
    id: row.id,
    property_id: row.property_id,
    employee_id: row.employee_id,
    work_date: workDate,
    shift_template_id: row.shift_template_id,
    schedule_status: row.schedule_status,
    work_status: row.work_status,
    scheduled_start_at: row.scheduled_start_at,
    scheduled_end_at: row.scheduled_end_at,
    department_snapshot: row.department_snapshot,
    position_snapshot: row.position_snapshot,
    published_at: row.published_at,
    published_by_user_id: row.published_by_user_id,
    published_by_name: row.published_by_name,
    notes: row.notes,
    created_by_user_id: row.created_by_user_id,
    updated_by_user_id: row.updated_by_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseDateParts(dateStr: string): { year: number; month: number; day: number } {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { year: y, month: m, day: d };
}

function toDateString(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** UTC-based calendar day number (days since epoch). Used for pure date arithmetic. */
function calendarDayNumber(dateStr: string): number {
  const { year, month, day } = parseDateParts(dateStr);
  return Math.floor(Date.UTC(year, month - 1, day) / (1000 * 60 * 60 * 24));
}

function addDays(dateStr: string, days: number): string {
  const { year, month, day } = parseDateParts(dateStr);
  const utcMs = Date.UTC(year, month - 1, day + days);
  const d = new Date(utcMs);
  return toDateString(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function getMonday(dateStr: string): string {
  const { year, month, day } = parseDateParts(dateStr);
  const utcMs = Date.UTC(year, month - 1, day);
  const dow = new Date(utcMs).getUTCDay(); // 0=Sun, 1=Mon, ...
  const diff = dow === 0 ? -6 : 1 - dow;
  const monMs = Date.UTC(year, month - 1, day + diff);
  const mon = new Date(monMs);
  return toDateString(mon.getUTCFullYear(), mon.getUTCMonth() + 1, mon.getUTCDate());
}

function getSunday(dateStr: string): string {
  const monday = getMonday(dateStr);
  return addDays(monday, 6);
}

// ─── Shift Template CRUD ───

export async function getShiftTemplates(
  client: PoolClient,
  propertyId: number,
  includeInactive = false,
  departmentId?: number | null
): Promise<WorkShiftTemplate[]> {
  const conditions: string[] = ['wst.property_id = $1'];
  const params: any[] = [propertyId];
  let idx = 2;

  if (!includeInactive) {
    conditions.push('wst.is_active = TRUE');
  }

  if (departmentId !== undefined && departmentId !== null) {
    if (departmentId === 0) {
      // Global templates only
      conditions.push('wst.department_id IS NULL');
    } else {
      // Specific department + global templates
      conditions.push(`(wst.department_id = $${idx} OR wst.department_id IS NULL)`);
      params.push(departmentId);
      idx++;
    }
  }

  const where = conditions.join(' AND ');
  const res = await client.query(
    `SELECT wst.* FROM work_shift_templates wst WHERE ${where} ORDER BY wst.code ASC`,
    params
  );
  return res.rows.map(formatShiftTemplate);
}

export async function getShiftTemplateById(
  client: PoolClient,
  propertyId: number,
  templateId: number
): Promise<WorkShiftTemplate | null> {
  const res = await client.query(
    'SELECT * FROM work_shift_templates WHERE id = $1 AND property_id = $2',
    [templateId, propertyId]
  );
  return res.rows.length > 0 ? formatShiftTemplate(res.rows[0]) : null;
}

export async function createShiftTemplate(
  client: PoolClient,
  payload: CreateShiftTemplatePayload,
  actor: { id?: number; name: string }
): Promise<WorkShiftTemplate> {
  const {
    property_id, code, name, start_time, end_time,
    crosses_midnight: forceCrossesMidnight,
    grace_before_minutes = 15,
    late_grace_minutes = 15,
    checkout_grace_minutes = 60,
    is_active = true,
    department_id = null,
    color_key = 'soft_slate',
  } = payload;

  // Validate color_key
  if (!isValidColorKey(color_key)) {
    throw Object.assign(
      new Error(`Warna tidak valid. Pilihan: ${VALID_COLOR_KEYS.join(', ')}`),
      { statusCode: 422, code: 'SHIFT_TEMPLATE_COLOR_INVALID' }
    );
  }

  const crosses_midnight = forceCrossesMidnight !== undefined
    ? forceCrossesMidnight
    : computeCrossesMidnight(start_time, end_time);

  // Cross-property department validation
  if (department_id != null) {
    const deptCheck = await client.query(
      'SELECT id, property_id FROM hr_departments WHERE id = $1', [department_id]
    );
    if (deptCheck.rowCount === 0) {
      throw Object.assign(new Error('Departemen tidak ditemukan.'), { statusCode: 404, code: 'DEPARTMENT_NOT_FOUND' });
    }
    if (deptCheck.rows[0].property_id !== property_id) {
      throw Object.assign(
        new Error('Departemen bukan milik properti ini.'),
        { statusCode: 422, code: 'DEPARTMENT_PROPERTY_MISMATCH' }
      );
    }
  }

  const res = await client.query(
    `INSERT INTO work_shift_templates
      (property_id, code, name, start_time, end_time, crosses_midnight,
       grace_before_minutes, late_grace_minutes, checkout_grace_minutes, is_active, department_id, color_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [property_id, code, name, start_time, end_time, crosses_midnight,
     grace_before_minutes, late_grace_minutes, checkout_grace_minutes, is_active, department_id, color_key]
  );

  const template = formatShiftTemplate(res.rows[0]);

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
     VALUES ('HR_SCHEDULE', 'SHIFT_TEMPLATE_CREATED', 'work_shift_templates', $1, $2, $3)`,
    [template.id, JSON.stringify(template), property_id]
  );

  return template;
}

const SHIFT_TEMPLATE_MUTABLE_FIELDS = [
  'code', 'name', 'start_time', 'end_time', 'crosses_midnight',
  'grace_before_minutes', 'late_grace_minutes', 'checkout_grace_minutes', 'is_active',
  'department_id', 'color_key',
] as const;

export async function updateShiftTemplate(
  client: PoolClient,
  propertyId: number,
  templateId: number,
  payload: UpdateShiftTemplatePayload,
  actor: { id?: number; name: string }
): Promise<WorkShiftTemplate> {
  const existing = await getShiftTemplateById(client, propertyId, templateId);
  if (!existing) {
    throw Object.assign(new Error('Shift template tidak ditemukan.'), { statusCode: 404, code: 'NOT_FOUND' });
  }

  // Cross-property department validation
  if (payload.department_id !== undefined && payload.department_id !== null) {
    const deptCheck = await client.query(
      'SELECT id, property_id FROM hr_departments WHERE id = $1', [payload.department_id]
    );
    if (deptCheck.rowCount === 0) {
      throw Object.assign(new Error('Departemen tidak ditemukan.'), { statusCode: 404, code: 'DEPARTMENT_NOT_FOUND' });
    }
    if (deptCheck.rows[0].property_id !== propertyId) {
      throw Object.assign(
        new Error('Departemen bukan milik properti ini.'),
        { statusCode: 422, code: 'DEPARTMENT_PROPERTY_MISMATCH' }
      );
    }
  }

  // Color key validation
  if (payload.color_key !== undefined && !isValidColorKey(payload.color_key)) {
    throw Object.assign(
      new Error(`Warna tidak valid. Pilihan: ${VALID_COLOR_KEYS.join(', ')}`),
      { statusCode: 422, code: 'SHIFT_TEMPLATE_COLOR_INVALID' }
    );
  }

  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;

  for (const [key, val] of Object.entries(payload)) {
    if (val !== undefined && (SHIFT_TEMPLATE_MUTABLE_FIELDS as readonly string[]).includes(key)) {
      fields.push(`${key} = $${idx}`);
      values.push(val);
      idx++;
    }
  }

  if (fields.length === 0) return existing;

  fields.push(`updated_at = NOW()`);
  values.push(propertyId, templateId);

  const res = await client.query(
    `UPDATE work_shift_templates SET ${fields.join(', ')}
     WHERE property_id = $${idx} AND id = $${idx + 1}
     RETURNING *`,
    values
  );

  const updated = formatShiftTemplate(res.rows[0]);

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
     VALUES ('HR_SCHEDULE', 'SHIFT_TEMPLATE_UPDATED', 'work_shift_templates', $1, $2, $3)`,
    [templateId, JSON.stringify({ before: existing, after: updated }), propertyId]
  );

  return updated;
}

export async function deactivateShiftTemplate(
  client: PoolClient,
  propertyId: number,
  templateId: number,
  actor: { id?: number; name: string }
): Promise<void> {
  const existing = await getShiftTemplateById(client, propertyId, templateId);
  if (!existing) {
    throw Object.assign(new Error('Shift template tidak ditemukan.'), { statusCode: 404, code: 'NOT_FOUND' });
  }

  await client.query(
    `UPDATE work_shift_templates SET is_active = FALSE, updated_at = NOW()
     WHERE id = $1 AND property_id = $2`,
    [templateId, propertyId]
  );

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
     VALUES ('HR_SCHEDULE', 'SHIFT_TEMPLATE_DEACTIVATED', 'work_shift_templates', $1, $2, $3)`,
    [templateId, JSON.stringify(existing), propertyId]
  );
}

// ─── Shift Template Team (employees assigned to a template in a period) ───

export async function getShiftTemplateTeam(
  client: PoolClient,
  propertyId: number,
  templateId: number,
  startDate: string,
  endDate: string
): Promise<ShiftTemplateTeamMember[]> {
  const template = await getShiftTemplateById(client, propertyId, templateId);
  if (!template) {
    throw Object.assign(new Error('Shift template tidak ditemukan.'), { statusCode: 404, code: 'NOT_FOUND' });
  }

  const res = await client.query(
    `SELECT
       e.id as employee_id,
       e.full_name as employee_name,
       e.employee_code,
       p.name as position_name,
       e.department_id,
       d.name as department_name,
       COUNT(s.id)::int as schedule_count
     FROM employee_work_schedules s
     JOIN hr_employees e ON e.id = s.employee_id
     LEFT JOIN hr_positions p ON p.id = e.position_id
     LEFT JOIN hr_departments d ON d.id = e.department_id
     WHERE s.property_id = $1
       AND s.shift_template_id = $2
       AND s.work_date >= $3
       AND s.work_date <= $4
     GROUP BY e.id, e.full_name, e.employee_code, p.name, e.department_id, d.name
     ORDER BY e.full_name ASC`,
    [propertyId, templateId, startDate, endDate]
  );

  return res.rows.map((r) => ({
    employee_id: r.employee_id,
    employee_name: r.employee_name,
    employee_code: r.employee_code,
    position_name: r.position_name,
    department_id: r.department_id,
    department_name: r.department_name,
    schedule_count: r.schedule_count,
  }));
}

// ─── Employee Schedule CRUD ───

export async function getWeeklyRoster(
  client: PoolClient,
  query: WeeklyRosterQuery
): Promise<WeeklyRosterResponse> {
  const monday = getMonday(query.start_date);
  const sunday = getSunday(query.start_date);
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    dates.push(addDays(monday, i));
  }

  // Fetch employees
  let empQuery = `
    SELECT e.id as employee_id, e.full_name as employee_name, e.employee_code,
           e.department_id, d.name as department_name, p.name as position_name
    FROM hr_employees e
    LEFT JOIN hr_departments d ON d.id = e.department_id
    LEFT JOIN hr_positions p ON p.id = e.position_id
    WHERE e.property_id = $1 AND e.is_active = TRUE
  `;
  const empParams: any[] = [query.property_id];
  let paramIdx = 2;

  if (query.department_id) {
    empQuery += ` AND e.department_id = $${paramIdx}`;
    empParams.push(query.department_id);
    paramIdx++;
  }

  if (query.employee_ids && query.employee_ids.length > 0) {
    empQuery += ` AND e.id = ANY($${paramIdx})`;
    empParams.push(query.employee_ids);
    paramIdx++;
  }

  empQuery += ' ORDER BY d.sort_order, e.full_name ASC';

  const empRes = await client.query(empQuery, empParams);

  // Fetch schedules for the date range
  const schedRes = await client.query(
    `SELECT id, property_id, employee_id, work_date::text AS work_date, shift_template_id,
            schedule_status, work_status, scheduled_start_at, scheduled_end_at,
            department_snapshot, position_snapshot, published_at, published_by_user_id,
            published_by_name, notes, created_by_user_id, updated_by_user_id,
            created_at, updated_at
     FROM employee_work_schedules
     WHERE property_id = $1 AND work_date >= $2 AND work_date <= $3`,
     [query.property_id, monday, sunday]
  );

  const scheduleMap = new Map<string, EmployeeWorkSchedule>();
  for (const row of schedRes.rows) {
    const sched = formatSchedule(row);
    const key = `${sched.employee_id}_${sched.work_date}`;
    scheduleMap.set(key, sched);
  }

  const employees: WeeklyRosterEmployee[] = empRes.rows.map((emp) => {
    const schedules: Record<string, EmployeeWorkSchedule | null> = {};
    for (const date of dates) {
      const key = `${emp.employee_id}_${date}`;
      schedules[date] = scheduleMap.get(key) || null;
    }
    return {
      employee_id: emp.employee_id,
      employee_name: emp.employee_name,
      employee_code: emp.employee_code,
      department_id: emp.department_id,
      department_name: emp.department_name,
      position_name: emp.position_name,
      schedules,
    };
  });

  const shift_templates = await getShiftTemplates(client, query.property_id);

  return { start_date: monday, end_date: sunday, dates, employees, shift_templates };
}

export async function getMonthlyRoster(
  client: PoolClient,
  query: MonthlyRosterQuery
): Promise<MonthlyRosterResponse> {
  const { property_id, year, month, department_id } = query;

  const firstDay = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0);
  const lastDateStr = `${year}-${String(month).padStart(2, '0')}-${String(lastDay.getDate()).padStart(2, '0')}`;

  const dates: string[] = [];
  for (let d = 1; d <= lastDay.getDate(); d++) {
    dates.push(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }

  // Fetch employees
  let empQuery = `
    SELECT e.id as employee_id, e.full_name as employee_name, e.employee_code,
           e.department_id, d.name as department_name, p.name as position_name
    FROM hr_employees e
    LEFT JOIN hr_departments d ON d.id = e.department_id
    LEFT JOIN hr_positions p ON p.id = e.position_id
    WHERE e.property_id = $1 AND e.is_active = TRUE
  `;
  const empParams: any[] = [property_id];
  let paramIdx = 2;

  if (department_id) {
    empQuery += ` AND e.department_id = $${paramIdx}`;
    empParams.push(department_id);
    paramIdx++;
  }

  empQuery += ' ORDER BY d.sort_order, e.full_name ASC';

  const empRes = await client.query(empQuery, empParams);

  // Fetch schedules for the month
  const schedRes = await client.query(
    `SELECT id, property_id, employee_id, work_date::text AS work_date, shift_template_id,
            schedule_status, work_status, scheduled_start_at, scheduled_end_at,
            department_snapshot, position_snapshot, published_at, published_by_user_id,
            published_by_name, notes, created_by_user_id, updated_by_user_id,
            created_at, updated_at
     FROM employee_work_schedules
     WHERE property_id = $1 AND work_date >= $2 AND work_date <= $3`,
    [property_id, firstDay, lastDateStr]
  );

  const scheduleMap = new Map<string, EmployeeWorkSchedule>();
  for (const row of schedRes.rows) {
    const sched = formatSchedule(row);
    const key = `${sched.employee_id}_${sched.work_date}`;
    scheduleMap.set(key, sched);
  }

  const employees: MonthlyRosterEmployee[] = empRes.rows.map((emp) => {
    const schedules: Record<string, EmployeeWorkSchedule | null> = {};
    for (const date of dates) {
      const key = `${emp.employee_id}_${date}`;
      schedules[date] = scheduleMap.get(key) || null;
    }
    return {
      employee_id: emp.employee_id,
      employee_name: emp.employee_name,
      employee_code: emp.employee_code,
      department_id: emp.department_id,
      department_name: emp.department_name,
      position_name: emp.position_name,
      schedules,
    };
  });

  const shift_templates = await getShiftTemplates(client, property_id);

  return { year, month, dates, employees, shift_templates };
}

export async function assignSchedule(
  client: PoolClient,
  payload: AssignSchedulePayload,
  actor: { id?: number; name: string }
): Promise<EmployeeWorkSchedule> {
  const { property_id, employee_id, work_date, shift_template_id, work_status, notes } = payload;

  const validUserId = await resolveValidUserId(client, actor.id);
  const propertyTimezone = await fetchPropertyTimezone(client, property_id);

  const existingRes = await client.query(
    'SELECT id, property_id, employee_id, work_date::text AS work_date, shift_template_id, schedule_status, work_status, scheduled_start_at, scheduled_end_at, department_snapshot, position_snapshot, published_at, published_by_user_id, published_by_name, notes, created_by_user_id, updated_by_user_id, created_at, updated_at FROM employee_work_schedules WHERE property_id = $1 AND employee_id = $2 AND work_date = $3',
    [property_id, employee_id, work_date]
  );
  const existing = existingRes.rows.length > 0 ? formatSchedule(existingRes.rows[0]) : null;

  if (existing && existing.schedule_status === 'PUBLISHED') {
    let scheduled_start_at = existing.scheduled_start_at;
    let scheduled_end_at = existing.scheduled_end_at;
    let newShiftTemplateId = shift_template_id !== undefined ? shift_template_id : existing.shift_template_id;
    let newWorkStatus = work_status || existing.work_status;

    if (shift_template_id !== undefined && shift_template_id !== null && shift_template_id !== existing.shift_template_id) {
      const tmpl = await client.query(
        'SELECT * FROM work_shift_templates WHERE id = $1 AND property_id = $2', [shift_template_id, property_id]
      );
      if (tmpl.rows.length === 0) {
        throw Object.assign(new Error('Shift template tidak ditemukan.'), { statusCode: 404, code: 'SHIFT_TEMPLATE_NOT_FOUND' });
      }
      const t = tmpl.rows[0];
      if (!t.is_active) {
        throw Object.assign(new Error('Shift template sudah tidak aktif.'), { statusCode: 422, code: 'SHIFT_TEMPLATE_INACTIVE' });
      }
      // Department scope validation: template must be global or match employee's department
      if (t.department_id != null) {
        const empDeptRes = await client.query(
          'SELECT department_id FROM hr_employees WHERE id = $1', [employee_id]
        );
        const empDeptId = empDeptRes.rows[0]?.department_id ?? null;
        if (empDeptId !== t.department_id) {
          throw Object.assign(
            new Error('Shift template tidak cocok dengan departemen karyawan.'),
            { statusCode: 422, code: 'SHIFT_TEMPLATE_DEPARTMENT_MISMATCH' }
          );
        }
      }
      const ts = buildScheduledTimestamps(work_date, t.start_time, t.end_time, t.crosses_midnight, propertyTimezone);
      scheduled_start_at = ts.scheduled_start_at;
      scheduled_end_at = ts.scheduled_end_at;
      newWorkStatus = 'WORK';
    } else if (work_status === 'OFF' || work_status === 'LEAVE' || work_status === 'SICK' || work_status === 'PERMISSION' || work_status === 'HOLIDAY') {
      newShiftTemplateId = null;
      scheduled_start_at = null;
      scheduled_end_at = null;
    }

    await client.query(
      `UPDATE employee_work_schedules
       SET shift_template_id = $1, work_status = $2, schedule_status = 'CHANGED',
           scheduled_start_at = $3, scheduled_end_at = $4, notes = COALESCE($5, notes),
           updated_by_user_id = $6, updated_at = NOW()
       WHERE id = $7`,
       [newShiftTemplateId, newWorkStatus, scheduled_start_at, scheduled_end_at, notes, validUserId, existing.id]
    );

    await client.query(
      `INSERT INTO employee_work_schedule_audits
        (schedule_id, property_id, employee_id, action, old_shift_template_id, new_shift_template_id,
         old_work_status, new_work_status, reason, changed_by_user_id, changed_by_name)
       VALUES ($1,$2,$3,'SHIFT_CHANGED',$4,$5,$6,$7,$8,$9,$10)`,
      [existing.id, property_id, employee_id, existing.shift_template_id, newShiftTemplateId,
       existing.work_status, newWorkStatus, notes || null, validUserId, actor.name]
    );

    const updatedRes = await client.query( 'SELECT id, property_id, employee_id, work_date::text AS work_date, shift_template_id, schedule_status, work_status, scheduled_start_at, scheduled_end_at, department_snapshot, position_snapshot, published_at, published_by_user_id, published_by_name, notes, created_by_user_id, updated_by_user_id, created_at, updated_at FROM employee_work_schedules WHERE id = $1', [existing.id]);
    return formatSchedule(updatedRes.rows[0]);
  }

  const empRes = await client.query(
    `SELECT e.*, d.name as dept_name, p.name as pos_name
     FROM hr_employees e
     LEFT JOIN hr_departments d ON d.id = e.department_id
     LEFT JOIN hr_positions p ON p.id = e.position_id
     WHERE e.id = $1 AND e.property_id = $2`,
    [employee_id, property_id]
  );
  if (empRes.rows.length === 0) {
    throw Object.assign(new Error('Karyawan tidak ditemukan.'), { statusCode: 404, code: 'EMPLOYEE_NOT_FOUND' });
  }
  const emp = empRes.rows[0];

  let resolvedWorkStatus = work_status || 'WORK';
  let resolvedShiftTemplateId = shift_template_id || null;
  let scheduled_start_at: string | null = null;
  let scheduled_end_at: string | null = null;

  if (resolvedWorkStatus === 'OFF' || resolvedWorkStatus === 'LEAVE' || resolvedWorkStatus === 'SICK' || resolvedWorkStatus === 'PERMISSION' || resolvedWorkStatus === 'HOLIDAY') {
    resolvedShiftTemplateId = null;
    scheduled_start_at = null;
    scheduled_end_at = null;
  } else if (resolvedShiftTemplateId) {
    const tmpl = await client.query(
      'SELECT * FROM work_shift_templates WHERE id = $1 AND property_id = $2', [resolvedShiftTemplateId, property_id]
    );
    if (tmpl.rows.length === 0) {
      throw Object.assign(new Error('Shift template tidak ditemukan.'), { statusCode: 404, code: 'SHIFT_TEMPLATE_NOT_FOUND' });
    }
    const t = tmpl.rows[0];
    if (!t.is_active) {
      throw Object.assign(new Error('Shift template sudah tidak aktif.'), { statusCode: 422, code: 'SHIFT_TEMPLATE_INACTIVE' });
    }
    // Department scope validation: template must be global or match employee's department
    if (t.department_id != null && t.department_id !== emp.department_id) {
      throw Object.assign(
        new Error('Shift template tidak cocok dengan departemen karyawan.'),
        { statusCode: 422, code: 'SHIFT_TEMPLATE_DEPARTMENT_MISMATCH' }
      );
    }
    const ts = buildScheduledTimestamps(work_date, t.start_time, t.end_time, t.crosses_midnight, propertyTimezone);
    scheduled_start_at = ts.scheduled_start_at;
    scheduled_end_at = ts.scheduled_end_at;
    resolvedWorkStatus = 'WORK';
  }

  if (existing) {
    await client.query(
      `UPDATE employee_work_schedules
       SET shift_template_id = $1, work_status = $2, scheduled_start_at = $3, scheduled_end_at = $4,
           notes = COALESCE($5, notes), department_snapshot = $6, position_snapshot = $7,
           updated_by_user_id = $8, updated_at = NOW()
       WHERE id = $9`,
      [resolvedShiftTemplateId, resolvedWorkStatus, scheduled_start_at, scheduled_end_at,
       notes, emp.dept_name, emp.pos_name, validUserId, existing.id]
    );

    await client.query(
      `INSERT INTO employee_work_schedule_audits
        (schedule_id, property_id, employee_id, action, old_shift_template_id, new_shift_template_id,
         old_work_status, new_work_status, reason, changed_by_user_id, changed_by_name)
       VALUES ($1,$2,$3,'CREATED',$4,$5,$6,$7,$8,$9,$10)`,
      [existing.id, property_id, employee_id, existing.shift_template_id, resolvedShiftTemplateId,
       existing.work_status, resolvedWorkStatus, notes || null, validUserId, actor.name]
    );

    const updatedRes = await client.query( 'SELECT id, property_id, employee_id, work_date::text AS work_date, shift_template_id, schedule_status, work_status, scheduled_start_at, scheduled_end_at, department_snapshot, position_snapshot, published_at, published_by_user_id, published_by_name, notes, created_by_user_id, updated_by_user_id, created_at, updated_at FROM employee_work_schedules WHERE id = $1', [existing.id]);
    return formatSchedule(updatedRes.rows[0]);
  }

  const insertRes = await client.query(
    `INSERT INTO employee_work_schedules
      (property_id, employee_id, work_date, shift_template_id, schedule_status, work_status,
       scheduled_start_at, scheduled_end_at, department_snapshot, position_snapshot, notes,
       created_by_user_id, updated_by_user_id)
     VALUES ($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id, property_id, employee_id, work_date::text AS work_date, shift_template_id,
               schedule_status, work_status, scheduled_start_at, scheduled_end_at,
               department_snapshot, position_snapshot, published_at, published_by_user_id,
               published_by_name, notes, created_by_user_id, updated_by_user_id,
               created_at, updated_at`,
    [property_id, employee_id, work_date, resolvedShiftTemplateId, resolvedWorkStatus,
     scheduled_start_at, scheduled_end_at, emp.dept_name, emp.pos_name, notes, validUserId, validUserId]
  );

  const schedule = formatSchedule(insertRes.rows[0]);

  await client.query(
    `INSERT INTO employee_work_schedule_audits
      (schedule_id, property_id, employee_id, action, old_shift_template_id, new_shift_template_id,
       old_work_status, new_work_status, reason, changed_by_user_id, changed_by_name)
     VALUES ($1,$2,$3,'CREATED',NULL,$4,NULL,$5,$6,$7,$8)`,
    [schedule.id, property_id, employee_id, resolvedShiftTemplateId, resolvedWorkStatus, notes || null, validUserId, actor.name]
  );

  return schedule;
}

export async function bulkAssignSchedule(
  client: PoolClient,
  payload: BulkAssignSchedulePayload,
  actor: { id?: number; name: string }
): Promise<{ assigned_count: number }> {
  const {
    property_id, employee_ids, shift_template_id, work_status,
    start_date, end_date, days_of_week, notes,
  } = payload;

  const resolvedWorkStatus = work_status || 'WORK';

  // Pre-validate: shift template exists and is active (if provided)
  if (shift_template_id) {
    const tmpl = await client.query(
      'SELECT * FROM work_shift_templates WHERE id = $1 AND property_id = $2',
      [shift_template_id, property_id]
    );
    if (tmpl.rows.length === 0) {
      throw Object.assign(new Error('Shift template tidak ditemukan.'), { statusCode: 404, code: 'SHIFT_TEMPLATE_NOT_FOUND' });
    }
    if (!tmpl.rows[0].is_active) {
      throw Object.assign(new Error('Shift template sudah tidak aktif.'), { statusCode: 422, code: 'SHIFT_TEMPLATE_INACTIVE' });
    }
  }

  // Pre-validate: all employees exist and belong to this property
  const empRes = await client.query(
    'SELECT id FROM hr_employees WHERE id = ANY($1) AND property_id = $2',
    [employee_ids, property_id]
  );
  if (empRes.rowCount !== employee_ids.length) {
    const foundIds = new Set(empRes.rows.map((r) => r.id));
    const missing = employee_ids.filter((id) => !foundIds.has(id));
    throw Object.assign(
      new Error(`Karyawan tidak ditemukan atau bukan milik properti ini: ${missing.join(', ')}`),
      { statusCode: 404, code: 'EMPLOYEE_NOT_FOUND', details: { missing_ids: missing } }
    );
  }

  // Generate all dates in range
  const allDates: string[] = [];
  let current = start_date;
  while (current <= end_date) {
    if (!days_of_week || days_of_week.length === 0) {
      allDates.push(current);
    } else {
      const { year, month, day } = parseDateParts(current);
      const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      if (days_of_week.includes(dow)) {
        allDates.push(current);
      }
    }
    current = addDays(current, 1);
  }

  if (allDates.length === 0) {
    throw Object.assign(new Error('Tidak ada tanggal yang valid untuk assign.'), { statusCode: 400, code: 'NO_VALID_DATES' });
  }

  // ALL-OR-NOTHING: perform all assignments, throw on first error
  let assignedCount = 0;
  for (const empId of employee_ids) {
    for (const date of allDates) {
      await assignSchedule(client, {
        property_id,
        employee_id: empId,
        work_date: date,
        shift_template_id: shift_template_id !== undefined ? shift_template_id : undefined,
        work_status: resolvedWorkStatus,
        notes,
      }, actor);
      assignedCount++;
    }
  }

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
     VALUES ('HR_SCHEDULE', 'EMPLOYEE_SCHEDULE_BULK_ASSIGNED', 'employee_work_schedules', 'bulk', $1, $2)`,
    [JSON.stringify({ employee_count: employee_ids.length, date_count: allDates.length, assigned_count: assignedCount }), property_id]
  );

  return { assigned_count: assignedCount };
}

export async function copyWeek(
  client: PoolClient,
  payload: CopyWeekPayload,
  actor: { id?: number; name: string }
): Promise<CopyWeekResult> {
  const { property_id, source_start_date, target_start_date } = payload;

  const sourceMonday = getMonday(source_start_date);
  const targetMonday = getMonday(target_start_date);
  const sourceSunday = addDays(sourceMonday, 6);

  const validUserId = await resolveValidUserId(client, actor.id);
  const propertyTimezone = await fetchPropertyTimezone(client, property_id);

  // Fetch source schedules
  const sourceRes = await client.query(
    `SELECT id, property_id, employee_id, work_date::text AS work_date, shift_template_id,
            schedule_status, work_status, scheduled_start_at, scheduled_end_at,
            department_snapshot, position_snapshot, published_at, published_by_user_id,
            published_by_name, notes, created_by_user_id, updated_by_user_id,
            created_at, updated_at
     FROM employee_work_schedules
     WHERE property_id = $1 AND work_date >= $2 AND work_date <= $3`,
    [property_id, sourceMonday, sourceSunday]
  );

  // Pre-fetch all shift templates referenced by source schedules for timestamp rebuilding
  const templateIds = [...new Set(sourceRes.rows.map((r) => r.shift_template_id).filter(Boolean))];
  const templateMap = new Map<number, any>();
  if (templateIds.length > 0) {
    const tmplRes = await client.query(
      'SELECT * FROM work_shift_templates WHERE id = ANY($1) AND property_id = $2',
      [templateIds, property_id]
    );
    for (const t of tmplRes.rows) {
      templateMap.set(t.id, t);
    }
  }

  let copiedCount = 0;
  let skippedConflicts = 0;
  const conflicts: Array<{ employee_id: number; employee_name: string; work_date: string }> = [];

  for (const sourceRow of sourceRes.rows) {
    const sourceDate = toDateStr(sourceRow.work_date);
    const dayOffset = calendarDayNumber(sourceDate) - calendarDayNumber(sourceMonday);
    const targetDate = addDays(targetMonday, dayOffset);

    const existingRes = await client.query(
      'SELECT id FROM employee_work_schedules WHERE property_id = $1 AND employee_id = $2 AND work_date = $3',
      [property_id, sourceRow.employee_id, targetDate]
    );

    if (existingRes.rows.length > 0) {
      skippedConflicts++;
      const empRes = await client.query( 'SELECT full_name FROM hr_employees WHERE id = $1', [sourceRow.employee_id]);
      conflicts.push({
        employee_id: sourceRow.employee_id,
        employee_name: empRes.rows[0]?.full_name || 'Unknown',
        work_date: targetDate,
      });
      continue;
    }

    // Rebuild timestamps for target date using template + property timezone
    let scheduled_start_at: string | null = null;
    let scheduled_end_at: string | null = null;
    const workStatus = sourceRow.work_status as string;

    if (sourceRow.shift_template_id && workStatus !== 'OFF' && workStatus !== 'LEAVE' && workStatus !== 'SICK' && workStatus !== 'PERMISSION' && workStatus !== 'HOLIDAY') {
      const template = templateMap.get(sourceRow.shift_template_id);
      if (template) {
        const ts = buildScheduledTimestamps(
          targetDate, template.start_time, template.end_time, template.crosses_midnight, propertyTimezone
        );
        scheduled_start_at = ts.scheduled_start_at;
        scheduled_end_at = ts.scheduled_end_at;
      }
    }

    await client.query(
      `INSERT INTO employee_work_schedules
        (property_id, employee_id, work_date, shift_template_id, schedule_status, work_status,
         scheduled_start_at, scheduled_end_at, department_snapshot, position_snapshot, notes,
         created_by_user_id, updated_by_user_id)
       VALUES ($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        property_id, sourceRow.employee_id, targetDate,
        sourceRow.shift_template_id, workStatus,
        scheduled_start_at, scheduled_end_at,
        sourceRow.department_snapshot, sourceRow.position_snapshot,
        sourceRow.notes, validUserId, validUserId,
      ]
    );

    copiedCount++;
  }

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
     VALUES ('HR_SCHEDULE', 'WEEK_SCHEDULE_COPIED', 'employee_work_schedules', 'copy', $1, $2)`,
    [JSON.stringify({
      source_week: `${sourceMonday} to ${sourceSunday}`,
      target_week: `${targetMonday} to ${addDays(targetMonday, 6)}`,
      copied_count: copiedCount,
      skipped_conflicts: skippedConflicts,
    }), property_id]
  );

  return { copied_count: copiedCount, skipped_conflicts: skippedConflicts, conflicts };
}

export async function publishSchedule(
  client: PoolClient,
  payload: PublishSchedulePayload,
  actor: { id?: number; name: string }
): Promise<PublishScheduleResult> {
  const { property_id, start_date, end_date } = payload;
  const monday = getMonday(start_date);
  const sunday = getSunday(start_date);

  const validUserId = await resolveValidUserId(client, actor.id);

  // Validate: no overlapping schedules for same employee/date
  const overlapRes = await client.query(
    `SELECT employee_id, work_date, COUNT(*) as cnt
     FROM employee_work_schedules
     WHERE property_id = $1 AND work_date >= $2 AND work_date <= $3
     GROUP BY employee_id, work_date
     HAVING COUNT(*) > 1`,
    [property_id, monday, sunday]
  );

  if (overlapRes.rows.length > 0) {
    throw Object.assign(
      new Error(`Ditemukan ${overlapRes.rows.length} konflik jadwal ganda. Periksa dan perbaiki terlebih dahulu.`),
      { statusCode: 409, code: 'SCHEDULE_CONFLICT', details: overlapRes.rows }
    );
  }

  // Transition all non-PUBLISHED schedules to PUBLISHED and return each updated row
  const publishRes = await client.query(
    `UPDATE employee_work_schedules
     SET schedule_status = 'PUBLISHED', published_at = NOW(),
         published_by_user_id = $1, published_by_name = $2, updated_at = NOW()
     WHERE property_id = $3 AND work_date >= $4 AND work_date <= $5
       AND schedule_status != 'PUBLISHED'
     RETURNING id, employee_id`,
     [validUserId, actor.name, property_id, monday, sunday]
  );

  const publishedCount = publishRes.rowCount ?? 0;

  // Create audit record for EACH schedule that transitioned to PUBLISHED
  for (const row of publishRes.rows) {
    await client.query(
      `INSERT INTO employee_work_schedule_audits
        (schedule_id, property_id, employee_id, action, changed_by_user_id, changed_by_name)
       VALUES ($1,$2,$3,'PUBLISHED',$4,$5)`,
       [row.id, property_id, row.employee_id, validUserId, actor.name]
    );
  }

  // Count already published
  const alreadyRes = await client.query(
    `SELECT COUNT(*) as cnt FROM employee_work_schedules
     WHERE property_id = $1 AND work_date >= $2 AND work_date <= $3 AND schedule_status = 'PUBLISHED'`,
    [property_id, monday, sunday]
  );
  const alreadyPublishedCount = parseInt(alreadyRes.rows[0]?.cnt || '0', 10) - publishedCount;

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
     VALUES ('HR_SCHEDULE', 'SCHEDULE_PUBLISHED', 'employee_work_schedules', 'publish', $1, $2)`,
    [JSON.stringify({ week: `${monday} to ${sunday}`, published_count: publishedCount }), property_id]
  );

  return { published_count: publishedCount, already_published_count: alreadyPublishedCount };
}

export async function getScheduleForAttendance(
  client: PoolClient,
  query: GetScheduleForAttendanceQuery
): Promise<AttendanceScheduleResult> {
  const { property_id, employee_id, work_date } = query;

  const schedRes = await client.query(
    `SELECT id, property_id, employee_id, work_date::text AS work_date, shift_template_id,
            schedule_status, work_status, scheduled_start_at, scheduled_end_at,
            department_snapshot, position_snapshot, published_at, published_by_user_id,
            published_by_name, notes, created_by_user_id, updated_by_user_id,
            created_at, updated_at
     FROM employee_work_schedules
     WHERE property_id = $1 AND employee_id = $2 AND work_date = $3
       AND schedule_status = 'PUBLISHED'`,
    [property_id, employee_id, work_date]
  );

  if (schedRes.rows.length === 0) {
    return { found: false, schedule: null, shift_template: null };
  }

  const schedule = formatSchedule(schedRes.rows[0]);
  let shiftTemplate: WorkShiftTemplate | null = null;

  if (schedule.shift_template_id) {
    const tmplRes = await client.query(
      'SELECT * FROM work_shift_templates WHERE id = $1 AND property_id = $2',
      [schedule.shift_template_id, property_id]
    );
    if (tmplRes.rows.length > 0) {
      shiftTemplate = formatShiftTemplate(tmplRes.rows[0]);
    }
  }

  return { found: true, schedule, shift_template: shiftTemplate };
}

export async function getScheduleAuditHistory(
  client: PoolClient,
  propertyId: number,
  employeeId: number
): Promise<any[]> {
  const res = await client.query(
    `SELECT a.*, e.full_name as employee_name
     FROM employee_work_schedule_audits a
     LEFT JOIN hr_employees e ON e.id = a.employee_id
     WHERE a.property_id = $1 AND a.employee_id = $2
     ORDER BY a.created_at DESC
     LIMIT 100`,
    [propertyId, employeeId]
  );
  return res.rows;
}

// ─── HR-SCHEDULE-1F: Operational/Non-Operational Schedule Groups ───

import type {
  ScheduleGroup,
  ScheduleGroupDepartmentInfo,
  CreateScheduleGroupPayload,
  UpdateScheduleGroupPayload,
  DepartmentWorkPattern,
  CreateDepartmentWorkPatternPayload,
  UpdateDepartmentWorkPatternPayload,
  PropertyHoliday,
  CreatePropertyHolidayPayload,
  UpdatePropertyHolidayPayload,
  NonOpBulkPatternPayload,
  NonOpBulkPatternPreview,
  NonOpBulkPatternResult,
  OperationalRosterResponse,
  OperationalGroupRoster,
  NonOperationalGroupRoster,
  NonOpRosterEmployee,
  UpdateDepartmentCategoryPayload,
  GroupedRosterQuery,
  ScheduleCategory,
} from './scheduleTypes';

// ─── Department Schedule Category ───

export async function updateDepartmentCategory(
  client: PoolClient,
  propertyId: number,
  departmentId: number,
  payload: UpdateDepartmentCategoryPayload,
  actor: { id?: number; name: string }
): Promise<void> {
  const deptCheck = await client.query(
    'SELECT id, property_id FROM hr_departments WHERE id = $1 AND property_id = $2',
    [departmentId, propertyId]
  );
  if (deptCheck.rowCount === 0) {
    throw Object.assign(new Error('Departemen tidak ditemukan.'), { statusCode: 404, code: 'DEPARTMENT_NOT_FOUND' });
  }

  if (payload.schedule_category !== null && payload.schedule_category !== 'OPERATIONAL' && payload.schedule_category !== 'NON_OPERATIONAL') {
    throw Object.assign(new Error('Kategori jadwal tidak valid. Pilihan: OPERATIONAL, NON_OPERATIONAL, atau null.'), { statusCode: 422, code: 'INVALID_CATEGORY' });
  }

  await client.query(
    `UPDATE hr_departments SET schedule_category = $1, updated_at = NOW(), updated_by = $2
     WHERE id = $3 AND property_id = $4`,
    [payload.schedule_category, actor.name, departmentId, propertyId]
  );

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
     VALUES ('HR_SCHEDULE', 'DEPARTMENT_CATEGORY_UPDATED', 'hr_departments', $1, $2, $3)`,
    [departmentId, JSON.stringify({ schedule_category: payload.schedule_category }), propertyId]
  );
}

export async function getDepartmentCategories(
  client: PoolClient,
  propertyId: number
): Promise<{ operational: number[]; non_operational: number[]; unclassified: number[] }> {
  const res = await client.query(
    'SELECT id, schedule_category FROM hr_departments WHERE property_id = $1 AND is_active = TRUE',
    [propertyId]
  );
  const result = { operational: [] as number[], non_operational: [] as number[], unclassified: [] as number[] };
  for (const row of res.rows) {
    if (row.schedule_category === 'OPERATIONAL') result.operational.push(row.id);
    else if (row.schedule_category === 'NON_OPERATIONAL') result.non_operational.push(row.id);
    else result.unclassified.push(row.id);
  }
  return result;
}

// ─── Schedule Groups (Operational) ───

export async function getScheduleGroups(
  client: PoolClient,
  propertyId: number,
  includeInactive = false
): Promise<ScheduleGroup[]> {
  const conditions = ['sg.property_id = $1'];
  const params: any[] = [propertyId];
  if (!includeInactive) conditions.push('sg.is_active = TRUE');

  const res = await client.query(
    `SELECT sg.* FROM schedule_groups sg
     WHERE ${conditions.join(' AND ')}
     ORDER BY sg.display_order ASC, sg.name ASC`,
    params
  );

  const groups: ScheduleGroup[] = [];
  for (const row of res.rows) {
    const deptRes = await client.query(
      `SELECT sgd.department_id, d.name as department_name, d.code as department_code
       FROM schedule_group_departments sgd
       JOIN hr_departments d ON d.id = sgd.department_id
       WHERE sgd.group_id = $1`,
      [row.id]
    );
    groups.push({
      id: row.id,
      property_id: row.property_id,
      name: row.name,
      code: row.code,
      is_active: row.is_active,
      display_order: row.display_order,
      created_at: row.created_at,
      updated_at: row.updated_at,
      created_by: row.created_by,
      updated_by: row.updated_by,
      departments: deptRes.rows.map((d: any) => ({
        department_id: d.department_id,
        department_name: d.department_name,
        department_code: d.department_code,
      })),
    });
  }
  return groups;
}

export async function getScheduleGroupById(
  client: PoolClient,
  propertyId: number,
  groupId: number
): Promise<ScheduleGroup | null> {
  const res = await client.query(
    'SELECT * FROM schedule_groups WHERE id = $1 AND property_id = $2',
    [groupId, propertyId]
  );
  if (res.rows.length === 0) return null;

  const row = res.rows[0];
  const deptRes = await client.query(
    `SELECT sgd.department_id, d.name as department_name, d.code as department_code
     FROM schedule_group_departments sgd
     JOIN hr_departments d ON d.id = sgd.department_id
     WHERE sgd.group_id = $1`,
    [row.id]
  );
  return {
    id: row.id,
    property_id: row.property_id,
    name: row.name,
    code: row.code,
    is_active: row.is_active,
    display_order: row.display_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
    departments: deptRes.rows.map((d: any) => ({
      department_id: d.department_id,
      department_name: d.department_name,
      department_code: d.department_code,
    })),
  };
}

export async function createScheduleGroup(
  client: PoolClient,
  payload: CreateScheduleGroupPayload,
  actor: { id?: number; name: string }
): Promise<ScheduleGroup> {
  const code = payload.code.trim().toUpperCase();
  const name = payload.name.trim();
  if (!code || !name) {
    throw Object.assign(new Error('Kode dan nama group wajib diisi.'), { statusCode: 400, code: 'INVALID_INPUT' });
  }

  const codeCheck = await client.query(
    'SELECT id FROM schedule_groups WHERE property_id = $1 AND UPPER(code) = $2',
    [payload.property_id, code]
  );
  if (codeCheck.rows.length > 0) {
    throw Object.assign(new Error(`Kode group '${code}' sudah digunakan.`), { statusCode: 409, code: 'GROUP_CODE_EXISTS' });
  }

  // Validate all departments belong to same property
  if (payload.department_ids && payload.department_ids.length > 0) {
    const deptCheck = await client.query(
      'SELECT id FROM hr_departments WHERE id = ANY($1) AND property_id = $2',
      [payload.department_ids, payload.property_id]
    );
    if (deptCheck.rowCount !== payload.department_ids.length) {
      throw Object.assign(new Error('Salah satu departemen tidak ditemukan atau bukan milik properti ini.'), { statusCode: 422, code: 'DEPARTMENT_PROPERTY_MISMATCH' });
    }
  }

  const res = await client.query(
    `INSERT INTO schedule_groups (property_id, name, code, is_active, display_order, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [payload.property_id, name, code, payload.is_active !== false, payload.display_order || 0, actor.name]
  );

  const group = res.rows[0];

  // Map departments
  if (payload.department_ids && payload.department_ids.length > 0) {
    for (const deptId of payload.department_ids) {
      await client.query(
        'INSERT INTO schedule_group_departments (group_id, department_id) VALUES ($1, $2)',
        [group.id, deptId]
      );
    }
  }

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
     VALUES ('HR_SCHEDULE', 'SCHEDULE_GROUP_CREATED', 'schedule_groups', $1, $2, $3)`,
    [group.id, JSON.stringify({ name, code, department_ids: payload.department_ids || [] }), payload.property_id]
  );

  return (await getScheduleGroupById(client, payload.property_id, group.id))!;
}

export async function updateScheduleGroup(
  client: PoolClient,
  propertyId: number,
  groupId: number,
  payload: UpdateScheduleGroupPayload,
  actor: { id?: number; name: string }
): Promise<ScheduleGroup> {
  const existing = await getScheduleGroupById(client, propertyId, groupId);
  if (!existing) {
    throw Object.assign(new Error('Group tidak ditemukan.'), { statusCode: 404, code: 'NOT_FOUND' });
  }

  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (payload.name !== undefined) { fields.push(`name = $${idx}`); values.push(payload.name.trim()); idx++; }
  if (payload.code !== undefined) {
    const code = payload.code.trim().toUpperCase();
    const codeCheck = await client.query(
      'SELECT id FROM schedule_groups WHERE property_id = $1 AND UPPER(code) = $2 AND id != $3',
      [propertyId, code, groupId]
    );
    if (codeCheck.rows.length > 0) {
      throw Object.assign(new Error(`Kode group '${code}' sudah digunakan.`), { statusCode: 409, code: 'GROUP_CODE_EXISTS' });
    }
    fields.push(`code = $${idx}`); values.push(code); idx++;
  }
  if (payload.is_active !== undefined) { fields.push(`is_active = $${idx}`); values.push(payload.is_active); idx++; }
  if (payload.display_order !== undefined) { fields.push(`display_order = $${idx}`); values.push(payload.display_order); idx++; }

  if (fields.length > 0) {
    fields.push(`updated_at = NOW()`, `updated_by = $${idx}`);
    values.push(actor.name);
    idx++;
    const propIdx = idx;
    values.push(propertyId);
    idx++;
    const groupIdx = idx;
    values.push(groupId);
    await client.query(
      `UPDATE schedule_groups SET ${fields.join(', ')} WHERE property_id = $${propIdx} AND id = $${groupIdx}`,
      values
    );
  }

  // Update department mapping if provided
  if (payload.department_ids !== undefined) {
    await client.query('DELETE FROM schedule_group_departments WHERE group_id = $1', [groupId]);
    if (payload.department_ids.length > 0) {
      // Validate departments
      const deptCheck = await client.query(
        'SELECT id FROM hr_departments WHERE id = ANY($1) AND property_id = $2',
        [payload.department_ids, propertyId]
      );
      if (deptCheck.rowCount !== payload.department_ids.length) {
        throw Object.assign(new Error('Salah satu departemen tidak ditemukan atau bukan milik properti ini.'), { statusCode: 422, code: 'DEPARTMENT_PROPERTY_MISMATCH' });
      }
      for (const deptId of payload.department_ids) {
        await client.query(
          'INSERT INTO schedule_group_departments (group_id, department_id) VALUES ($1, $2)',
          [groupId, deptId]
        );
      }
    }
  }

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
     VALUES ('HR_SCHEDULE', 'SCHEDULE_GROUP_UPDATED', 'schedule_groups', $1, $2, $3)`,
    [groupId, JSON.stringify(payload), propertyId]
  );

  return (await getScheduleGroupById(client, propertyId, groupId))!;
}

export async function deactivateScheduleGroup(
  client: PoolClient,
  propertyId: number,
  groupId: number,
  actor: { id?: number; name: string }
): Promise<void> {
  const existing = await getScheduleGroupById(client, propertyId, groupId);
  if (!existing) {
    throw Object.assign(new Error('Group tidak ditemukan.'), { statusCode: 404, code: 'NOT_FOUND' });
  }

  await client.query(
    'UPDATE schedule_groups SET is_active = FALSE, updated_at = NOW(), updated_by = $1 WHERE id = $2 AND property_id = $3',
    [actor.name, groupId, propertyId]
  );

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
     VALUES ('HR_SCHEDULE', 'SCHEDULE_GROUP_DEACTIVATED', 'schedule_groups', $1, $2, $3)`,
    [groupId, JSON.stringify(existing), propertyId]
  );
}

// ─── Department Work Patterns (Non-Operational Office Hours) ───

export async function getDepartmentWorkPatterns(
  client: PoolClient,
  propertyId: number,
  includeInactive = false
): Promise<DepartmentWorkPattern[]> {
  const conditions = ['dwp.property_id = $1'];
  const params: any[] = [propertyId];
  if (!includeInactive) conditions.push('dwp.is_active = TRUE');

  const res = await client.query(
    `SELECT dwp.*, d.name as department_name
     FROM department_work_patterns dwp
     JOIN hr_departments d ON d.id = dwp.department_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY d.name ASC`,
    params
  );

  return res.rows.map(r => ({
    id: r.id,
    property_id: r.property_id,
    department_id: r.department_id,
    department_name: r.department_name,
    default_start_time: r.default_start_time,
    default_end_time: r.default_end_time,
    crosses_midnight: r.crosses_midnight,
    is_active: r.is_active,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

export async function getDepartmentWorkPatternByDept(
  client: PoolClient,
  departmentId: number
): Promise<DepartmentWorkPattern | null> {
  const res = await client.query(
    `SELECT dwp.*, d.name as department_name
     FROM department_work_patterns dwp
     JOIN hr_departments d ON d.id = dwp.department_id
     WHERE dwp.department_id = $1 AND dwp.is_active = TRUE`,
    [departmentId]
  );
  return res.rows.length > 0 ? {
    id: res.rows[0].id,
    property_id: res.rows[0].property_id,
    department_id: res.rows[0].department_id,
    department_name: res.rows[0].department_name,
    default_start_time: res.rows[0].default_start_time,
    default_end_time: res.rows[0].default_end_time,
    crosses_midnight: res.rows[0].crosses_midnight,
    is_active: res.rows[0].is_active,
    created_at: res.rows[0].created_at,
    updated_at: res.rows[0].updated_at,
  } : null;
}

export async function upsertDepartmentWorkPattern(
  client: PoolClient,
  payload: CreateDepartmentWorkPatternPayload,
  actor: { id?: number; name: string }
): Promise<DepartmentWorkPattern> {
  const deptCheck = await client.query(
    'SELECT id, property_id, name FROM hr_departments WHERE id = $1 AND property_id = $2',
    [payload.department_id, payload.property_id]
  );
  if (deptCheck.rowCount === 0) {
    throw Object.assign(new Error('Departemen tidak ditemukan.'), { statusCode: 404, code: 'DEPARTMENT_NOT_FOUND' });
  }

  const existing = await client.query(
    'SELECT id FROM department_work_patterns WHERE department_id = $1',
    [payload.department_id]
  );

  const startTime = payload.default_start_time || '08:00';
  const endTime = payload.default_end_time || '16:00';
  const crossesMidnight = payload.crosses_midnight || (parseTimeToMinutes(endTime) <= parseTimeToMinutes(startTime));

  let resultId: number;
  if (existing.rows.length > 0) {
    await client.query(
      `UPDATE department_work_patterns
       SET default_start_time = $1, default_end_time = $2, crosses_midnight = $3,
           is_active = $4, updated_at = NOW()
       WHERE id = $5`,
      [startTime, endTime, crossesMidnight, payload.is_active !== false, existing.rows[0].id]
    );
    resultId = existing.rows[0].id;
  } else {
    const res = await client.query(
      `INSERT INTO department_work_patterns (property_id, department_id, default_start_time, default_end_time, crosses_midnight, is_active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [payload.property_id, payload.department_id, startTime, endTime, crossesMidnight, payload.is_active !== false]
    );
    resultId = res.rows[0].id;
  }

  return (await getDepartmentWorkPatternByDept(client, payload.department_id))!;
}

// ─── Property Holidays ───

export async function getPropertyHolidays(
  client: PoolClient,
  propertyId: number,
  options?: { include_inactive?: boolean; year?: number; month?: number }
): Promise<PropertyHoliday[]> {
  const conditions: string[] = ['ph.property_id = $1'];
  const params: any[] = [propertyId];
  let idx = 2;

  if (!options?.include_inactive) { conditions.push('ph.is_active = TRUE'); }
  if (options?.year && options?.month) {
    const firstDay = `${options.year}-${String(options.month).padStart(2, '0')}-01`;
    const lastDay = new Date(options.year, options.month, 0);
    const lastDate = `${options.year}-${String(options.month).padStart(2, '0')}-${String(lastDay.getDate()).padStart(2, '0')}`;
    conditions.push(`ph.holiday_date >= $${idx} AND ph.holiday_date <= $${idx + 1}`);
    params.push(firstDay, lastDate);
    idx += 2;
  } else if (options?.year) {
    conditions.push(`ph.holiday_date >= $${idx} AND ph.holiday_date <= $${idx + 1}`);
    params.push(`${options.year}-01-01`, `${options.year}-12-31`);
    idx += 2;
  }

  const res = await client.query(
    `SELECT * FROM property_holidays ph
     WHERE ${conditions.join(' AND ')}
     ORDER BY ph.holiday_date ASC`,
    params
  );

  return res.rows.map(r => ({
    id: r.id,
    property_id: r.property_id,
    holiday_date: typeof r.holiday_date === 'string' ? r.holiday_date.split('T')[0] : new Date(r.holiday_date).toISOString().split('T')[0],
    name: r.name,
    holiday_type: r.holiday_type,
    is_active: r.is_active,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: r.created_by,
    updated_by: r.updated_by,
  }));
}

export async function createPropertyHoliday(
  client: PoolClient,
  payload: CreatePropertyHolidayPayload,
  actor: { id?: number; name: string }
): Promise<PropertyHoliday> {
  const name = payload.name.trim();
  const holidayDate = payload.holiday_date;
  const holidayType = payload.holiday_type || 'NATIONAL';

  if (!name || !holidayDate) {
    throw Object.assign(new Error('Nama dan tanggal libur wajib diisi.'), { statusCode: 400, code: 'INVALID_INPUT' });
  }

  const dateCheck = await client.query(
    'SELECT id FROM property_holidays WHERE property_id = $1 AND holiday_date = $2',
    [payload.property_id, holidayDate]
  );
  if (dateCheck.rows.length > 0) {
    throw Object.assign(new Error('Tanggal libur ini sudah ada.'), { statusCode: 409, code: 'HOLIDAY_DATE_EXISTS' });
  }

  const res = await client.query(
    `INSERT INTO property_holidays (property_id, holiday_date, name, holiday_type, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [payload.property_id, holidayDate, name, holidayType, payload.is_active !== false, actor.name]
  );

  const holiday = res.rows[0];
  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
     VALUES ('HR_SCHEDULE', 'HOLIDAY_CREATED', 'property_holidays', $1, $2, $3)`,
    [holiday.id, JSON.stringify({ holiday_date: holidayDate, name, holiday_type: holidayType }), payload.property_id]
  );

  return {
    id: holiday.id,
    property_id: holiday.property_id,
    holiday_date: typeof holiday.holiday_date === 'string' ? holiday.holiday_date.split('T')[0] : new Date(holiday.holiday_date).toISOString().split('T')[0],
    name: holiday.name,
    holiday_type: holiday.holiday_type,
    is_active: holiday.is_active,
    created_at: holiday.created_at,
    updated_at: holiday.updated_at,
    created_by: holiday.created_by,
    updated_by: holiday.updated_by,
  };
}

export async function updatePropertyHoliday(
  client: PoolClient,
  propertyId: number,
  holidayId: number,
  payload: UpdatePropertyHolidayPayload,
  actor: { id?: number; name: string }
): Promise<PropertyHoliday> {
  const existing = await client.query(
    'SELECT * FROM property_holidays WHERE id = $1 AND property_id = $2',
    [holidayId, propertyId]
  );
  if (existing.rows.length === 0) {
    throw Object.assign(new Error('Hari libur tidak ditemukan.'), { statusCode: 404, code: 'NOT_FOUND' });
  }

  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (payload.holiday_date !== undefined) {
    const dateCheck = await client.query(
      'SELECT id FROM property_holidays WHERE property_id = $1 AND holiday_date = $2 AND id != $3',
      [propertyId, payload.holiday_date, holidayId]
    );
    if (dateCheck.rows.length > 0) {
      throw Object.assign(new Error('Tanggal libur ini sudah ada.'), { statusCode: 409, code: 'HOLIDAY_DATE_EXISTS' });
    }
    fields.push(`holiday_date = $${idx}`); values.push(payload.holiday_date); idx++;
  }
  if (payload.name !== undefined) { fields.push(`name = $${idx}`); values.push(payload.name.trim()); idx++; }
  if (payload.holiday_type !== undefined) { fields.push(`holiday_type = $${idx}`); values.push(payload.holiday_type); idx++; }
  if (payload.is_active !== undefined) { fields.push(`is_active = $${idx}`); values.push(payload.is_active); idx++; }

  if (fields.length > 0) {
    fields.push(`updated_at = NOW()`, `updated_by = $${idx}`);
    values.push(actor.name); idx++;
    values.push(propertyId);
    const propParamIdx = idx; idx++;
    values.push(holidayId);
    const holParamIdx = idx; idx++;
    await client.query(
      `UPDATE property_holidays SET ${fields.join(', ')} WHERE property_id = $${propParamIdx} AND id = $${holParamIdx}`,
      values
    );
  }

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
     VALUES ('HR_SCHEDULE', 'HOLIDAY_UPDATED', 'property_holidays', $1, $2, $3)`,
    [holidayId, JSON.stringify(payload), propertyId]
  );

  const updated = await client.query(
    'SELECT * FROM property_holidays WHERE id = $1 AND property_id = $2',
    [holidayId, propertyId]
  );
  const r = updated.rows[0];
  return {
    id: r.id,
    property_id: r.property_id,
    holiday_date: typeof r.holiday_date === 'string' ? r.holiday_date.split('T')[0] : new Date(r.holiday_date).toISOString().split('T')[0],
    name: r.name,
    holiday_type: r.holiday_type,
    is_active: r.is_active,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: r.created_by,
    updated_by: r.updated_by,
  };
}

// ─── Non-Operational Multi-Month Bulk Pattern ───

export async function previewNonOpBulkPattern(
  client: PoolClient,
  propertyId: number,
  employeeIds: number[],
  startDate: string,
  endDate: string,
  workingDays: number[],
  startTime?: string,
  endTime?: string
): Promise<NonOpBulkPatternPreview> {
  // Generate all dates in range
  const allDates: string[] = [];
  let current = startDate;
  while (current <= endDate) {
    allDates.push(current);
    current = addDays(current, 1);
  }

  // Filter to working days only
  const workingDates = allDates.filter(date => {
    const { year, month, day } = parseDateParts(date);
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return workingDays.includes(dow);
  });

  // Fetch existing schedules
  const existingRes = await client.query(
    `SELECT employee_id, work_date::text AS work_date, work_status, schedule_status
     FROM employee_work_schedules
     WHERE property_id = $1 AND employee_id = ANY($2)
       AND work_date >= $3 AND work_date <= $4`,
    [propertyId, employeeIds, startDate, endDate]
  );

  const existingMap = new Map<string, { work_status: string; schedule_status: string }>();
  for (const row of existingRes.rows) {
    const wd = typeof row.work_date === 'string' ? row.work_date.split('T')[0] : new Date(row.work_date).toISOString().split('T')[0];
    existingMap.set(`${row.employee_id}_${wd}`, { work_status: row.work_status, schedule_status: row.schedule_status });
  }

  // Fetch holidays
  const holidayRes = await client.query(
    'SELECT holiday_date::text AS holiday_date FROM property_holidays WHERE property_id = $1 AND is_active = TRUE AND holiday_date >= $2 AND holiday_date <= $3',
    [propertyId, startDate, endDate]
  );
  const holidayDates = new Set<string>();
  for (const row of holidayRes.rows) {
    const hd = typeof row.holiday_date === 'string' ? row.holiday_date.split('T')[0] : new Date(row.holiday_date).toISOString().split('T')[0];
    holidayDates.add(hd);
  }

  let newSchedules = 0;
  let existingSchedules = 0;
  let skippedProtected = 0;
  const conflicts: NonOpBulkPatternPreview['conflicts'] = [];

  for (const empId of employeeIds) {
    for (const date of workingDates) {
      const key = `${empId}_${date}`;
      const existing = existingMap.get(key);

      if (existing) {
        existingSchedules++;
        // Protected statuses
        if (existing.schedule_status === 'PUBLISHED' || existing.schedule_status === 'CHANGED' ||
            existing.work_status === 'LEAVE' || existing.work_status === 'SICK' || existing.work_status === 'PERMISSION') {
          skippedProtected++;
          const empRes = await client.query('SELECT full_name FROM hr_employees WHERE id = $1', [empId]);
          conflicts.push({
            employee_id: empId,
            employee_name: empRes.rows[0]?.full_name || 'Unknown',
            work_date: date,
            current_status: existing.work_status,
            current_schedule_status: existing.schedule_status,
          });
        } else {
          newSchedules++;
        }
      } else {
        newSchedules++;
      }
    }
  }

  return {
    total_dates: workingDates.length * employeeIds.length,
    new_schedules: newSchedules,
    existing_schedules: existingSchedules,
    skipped_protected: skippedProtected,
    conflicts,
  };
}

export async function applyNonOpBulkPattern(
  client: PoolClient,
  payload: NonOpBulkPatternPayload,
  actor: { id?: number; name: string }
): Promise<NonOpBulkPatternResult> {
  const {
    property_id, department_id, employee_ids, start_date, end_date,
    working_days, default_start_time = '08:00', default_end_time = '16:00',
    crosses_midnight: forceCrossesMidnight, notes,
  } = payload;

  // Validate department
  const deptCheck = await client.query(
    'SELECT id, name FROM hr_departments WHERE id = $1 AND property_id = $2',
    [department_id, property_id]
  );
  if (deptCheck.rowCount === 0) {
    throw Object.assign(new Error('Departemen tidak ditemukan.'), { statusCode: 404, code: 'DEPARTMENT_NOT_FOUND' });
  }

  // Validate employees
  const empRes = await client.query(
    'SELECT id, full_name FROM hr_employees WHERE id = ANY($1) AND property_id = $2 AND is_active = TRUE',
    [employee_ids, property_id]
  );
  if (empRes.rowCount !== employee_ids.length) {
    throw Object.assign(new Error('Salah satu karyawan tidak ditemukan.'), { statusCode: 404, code: 'EMPLOYEE_NOT_FOUND' });
  }

  const propertyTimezone = await fetchPropertyTimezone(client, property_id);

  // Get department work pattern or use provided times
  const patternRes = await client.query(
    'SELECT * FROM department_work_patterns WHERE department_id = $1 AND is_active = TRUE',
    [department_id]
  );

  let startTime = default_start_time;
  let endTime = default_end_time;
  let crossesMidnight = forceCrossesMidnight !== undefined ? forceCrossesMidnight : false;

  if (patternRes.rows.length > 0) {
    const p = patternRes.rows[0];
    startTime = p.default_start_time;
    endTime = p.default_end_time;
    crossesMidnight = p.crosses_midnight;
  }

  // Generate working dates
  const allDates: string[] = [];
  let current = start_date;
  while (current <= end_date) {
    allDates.push(current);
    current = addDays(current, 1);
  }

  const workingDates = allDates.filter(date => {
    const { year, month, day } = parseDateParts(date);
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return working_days.includes(dow);
  });

  if (workingDates.length === 0) {
    throw Object.assign(new Error('Tidak ada tanggal yang valid untuk diterapkan.'), { statusCode: 400, code: 'NO_VALID_DATES' });
  }

  // Fetch holidays
  const holidayRes = await client.query(
    'SELECT holiday_date::text AS holiday_date FROM property_holidays WHERE property_id = $1 AND is_active = TRUE AND holiday_date >= $2 AND holiday_date <= $3',
    [property_id, start_date, end_date]
  );
  const holidayDates = new Set<string>();
  for (const row of holidayRes.rows) {
    const hd = typeof row.holiday_date === 'string' ? row.holiday_date.split('T')[0] : new Date(row.holiday_date).toISOString().split('T')[0];
    holidayDates.add(hd);
  }

  // Fetch existing schedules
  const existingRes = await client.query(
    `SELECT employee_id, work_date::text AS work_date, work_status, schedule_status
     FROM employee_work_schedules
     WHERE property_id = $1 AND employee_id = ANY($2)
       AND work_date >= $3 AND work_date <= $4`,
    [property_id, employee_ids, start_date, end_date]
  );
  const existingMap = new Map<string, { work_status: string; schedule_status: string }>();
  for (const row of existingRes.rows) {
    const wd = typeof row.work_date === 'string' ? row.work_date.split('T')[0] : new Date(row.work_date).toISOString().split('T')[0];
    existingMap.set(`${row.employee_id}_${wd}`, { work_status: row.work_status, schedule_status: row.schedule_status });
  }

  const validUserId = await resolveValidUserId(client, actor.id);
  let createdCount = 0;
  let skippedCount = 0;
  let skippedProtected = 0;
  let skippedHoliday = 0;

  for (const empId of employee_ids) {
    for (const date of workingDates) {
      const key = `${empId}_${date}`;
      const existing = existingMap.get(key);

      // Skip protected
      if (existing && (
        existing.schedule_status === 'PUBLISHED' ||
        existing.schedule_status === 'CHANGED' ||
        existing.work_status === 'LEAVE' ||
        existing.work_status === 'SICK' ||
        existing.work_status === 'PERMISSION'
      )) {
        skippedProtected++;
        continue;
      }

      if (existing) {
        skippedCount++;
        continue;
      }

      // Check holiday
      if (holidayDates.has(date)) {
        // Create HOLIDAY schedule
        await client.query(
          `INSERT INTO employee_work_schedules
            (property_id, employee_id, work_date, shift_template_id, schedule_status, work_status,
             scheduled_start_at, scheduled_end_at, department_snapshot, notes, created_by_user_id, updated_by_user_id)
           VALUES ($1,$2,$3,NULL,'DRAFT','HOLIDAY',NULL,NULL,$4,$5,$6,$7)`,
          [property_id, empId, date, deptCheck.rows[0].name, notes || null, validUserId, validUserId]
        );
        skippedHoliday++;
        createdCount++;
        continue;
      }

      // Create WORK schedule
      const ts = buildScheduledTimestamps(date, startTime, endTime, crossesMidnight, propertyTimezone);
      await client.query(
        `INSERT INTO employee_work_schedules
          (property_id, employee_id, work_date, shift_template_id, schedule_status, work_status,
           scheduled_start_at, scheduled_end_at, department_snapshot, notes, created_by_user_id, updated_by_user_id)
         VALUES ($1,$2,$3,NULL,'DRAFT','WORK',$4,$5,$6,$7,$8,$9)`,
        [property_id, empId, date, ts.scheduled_start_at, ts.scheduled_end_at, deptCheck.rows[0].name, notes || null, validUserId, validUserId]
      );
      createdCount++;
    }
  }

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
     VALUES ('HR_SCHEDULE', 'NON_OP_BULK_PATTERN_APPLIED', 'employee_work_schedules', 'bulk', $1, $2)`,
    [JSON.stringify({
      department_id,
      employee_count: employee_ids.length,
      date_range: `${start_date} to ${end_date}`,
      created_count: createdCount,
      skipped_protected: skippedProtected,
      skipped_holiday: skippedHoliday,
    }), property_id]
  );

  return {
    created_count: createdCount,
    skipped_count: skippedCount,
    skipped_protected: skippedProtected,
    skipped_holiday: skippedHoliday,
  };
}

// ─── Grouped Roster (Operational + Non-Operational) ───

export async function getGroupedRoster(
  client: PoolClient,
  query: GroupedRosterQuery
): Promise<OperationalRosterResponse> {
  const { property_id, start_date, end_date, view_mode = 'all', group_id, department_id } = query;

  const monday = getMonday(start_date);
  const sunday = getSunday(start_date);
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    dates.push(addDays(monday, i));
  }

  const groups: OperationalGroupRoster[] = [];
  const nonOperationalGroups: NonOperationalGroupRoster[] = [];

  // Fetch operational groups
  if (view_mode === 'operational' || view_mode === 'all') {
    let groupQuery = 'SELECT * FROM schedule_groups WHERE property_id = $1 AND is_active = TRUE';
    const groupParams: any[] = [property_id];
    let gIdx = 2;
    if (group_id) {
      groupQuery += ` AND id = $${gIdx}`;
      groupParams.push(group_id);
      gIdx++;
    }
    groupQuery += ' ORDER BY display_order ASC, name ASC';

    const groupRes = await client.query(groupQuery, groupParams);

    for (const group of groupRes.rows) {
      // Get departments for this group
      const deptRes = await client.query(
        'SELECT department_id FROM schedule_group_departments WHERE group_id = $1',
        [group.id]
      );
      const deptIds = deptRes.rows.map((r: any) => r.department_id);

      if (deptIds.length === 0) continue;

      // Get employees in these departments
      let empQuery = `
        SELECT e.id as employee_id, e.full_name as employee_name, e.employee_code,
               e.department_id, d.name as department_name, p.name as position_name
        FROM hr_employees e
        LEFT JOIN hr_departments d ON d.id = e.department_id
        LEFT JOIN hr_positions p ON p.id = e.position_id
        WHERE e.property_id = $1 AND e.is_active = TRUE AND e.department_id = ANY($2)
      `;
      const empParams: any[] = [property_id, deptIds];

      const empRes = await client.query(empQuery, empParams);

      // Get schedules for these employees
      const empIds = empRes.rows.map((e: any) => e.employee_id);
      if (empIds.length === 0) {
        groups.push({
          group_id: group.id,
          group_name: group.name,
          group_code: group.code,
          department_ids: deptIds,
          employees: [],
        });
        continue;
      }

      const schedRes = await client.query(
        `SELECT id, property_id, employee_id, work_date::text AS work_date, shift_template_id,
                schedule_status, work_status, scheduled_start_at, scheduled_end_at,
                department_snapshot, position_snapshot, published_at, published_by_user_id,
                published_by_name, notes, created_by_user_id, updated_by_user_id,
                created_at, updated_at
         FROM employee_work_schedules
         WHERE property_id = $1 AND employee_id = ANY($2) AND work_date >= $3 AND work_date <= $4`,
        [property_id, empIds, monday, sunday]
      );

      const scheduleMap = new Map<string, EmployeeWorkSchedule>();
      for (const row of schedRes.rows) {
        const sched = formatSchedule(row);
        scheduleMap.set(`${sched.employee_id}_${sched.work_date}`, sched);
      }

      const employees: WeeklyRosterEmployee[] = empRes.rows.map((emp: any) => {
        const schedules: Record<string, EmployeeWorkSchedule | null> = {};
        for (const date of dates) {
          schedules[date] = scheduleMap.get(`${emp.employee_id}_${date}`) || null;
        }
        return {
          employee_id: emp.employee_id,
          employee_name: emp.employee_name,
          employee_code: emp.employee_code,
          department_id: emp.department_id,
          department_name: emp.department_name,
          position_name: emp.position_name,
          schedules,
        };
      });

      groups.push({
        group_id: group.id,
        group_name: group.name,
        group_code: group.code,
        department_ids: deptIds,
        employees,
      });
    }
  }

  // Fetch non-operational departments
  if (view_mode === 'non_operational' || view_mode === 'all') {
    let nonOpDeptQuery = `
      SELECT id, name FROM hr_departments
      WHERE property_id = $1 AND is_active = TRUE AND schedule_category = 'NON_OPERATIONAL'
    `;
    const nonOpDeptParams: any[] = [property_id];
    let nIdx = 2;
    if (department_id) {
      nonOpDeptQuery += ` AND id = $${nIdx}`;
      nonOpDeptParams.push(department_id);
      nIdx++;
    }
    nonOpDeptQuery += ' ORDER BY sort_order ASC, name ASC';

    const nonOpDeptRes = await client.query(nonOpDeptQuery, nonOpDeptParams);

    for (const dept of nonOpDeptRes.rows) {
      const empRes = await client.query(
        `SELECT e.id as employee_id, e.full_name as employee_name, e.employee_code,
                e.department_id, d.name as department_name, p.name as position_name
         FROM hr_employees e
         LEFT JOIN hr_departments d ON d.id = e.department_id
         LEFT JOIN hr_positions p ON p.id = e.position_id
         WHERE e.property_id = $1 AND e.is_active = TRUE AND e.department_id = $2
         ORDER BY e.full_name ASC`,
        [property_id, dept.id]
      );

      const empIds = empRes.rows.map((e: any) => e.employee_id);
      if (empIds.length === 0) {
        nonOperationalGroups.push({
          department_id: dept.id,
          department_name: dept.name,
          employees: [],
        });
        continue;
      }

      const schedRes = await client.query(
        `SELECT id, property_id, employee_id, work_date::text AS work_date, shift_template_id,
                schedule_status, work_status, scheduled_start_at, scheduled_end_at,
                department_snapshot, position_snapshot, published_at, published_by_user_id,
                published_by_name, notes, created_by_user_id, updated_by_user_id,
                created_at, updated_at
         FROM employee_work_schedules
         WHERE property_id = $1 AND employee_id = ANY($2) AND work_date >= $3 AND work_date <= $4`,
        [property_id, empIds, monday, sunday]
      );

      const scheduleMap = new Map<string, EmployeeWorkSchedule>();
      for (const row of schedRes.rows) {
        const sched = formatSchedule(row);
        scheduleMap.set(`${sched.employee_id}_${sched.work_date}`, sched);
      }

      const employees: NonOpRosterEmployee[] = empRes.rows.map((emp: any) => {
        const schedules: Record<string, EmployeeWorkSchedule | null> = {};
        for (const date of dates) {
          schedules[date] = scheduleMap.get(`${emp.employee_id}_${date}`) || null;
        }
        return {
          employee_id: emp.employee_id,
          employee_name: emp.employee_name,
          employee_code: emp.employee_code,
          position_name: emp.position_name,
          schedules,
        };
      });

      nonOperationalGroups.push({
        department_id: dept.id,
        department_name: dept.name,
        employees,
      });
    }
  }

  const shift_templates = await getShiftTemplates(client, property_id);

  return { groups, non_operational_groups: nonOperationalGroups, dates, shift_templates };
}

// ─── Non-Operational Cell Editing ───

export interface NonOpAssignPayload {
  property_id: number;
  employee_id: number;
  work_date: string;
  work_status: 'WORK' | 'OFF' | 'LEAVE' | 'SICK' | 'PERMISSION' | 'HOLIDAY';
}

export async function nonOpAssignSchedule(
  client: PoolClient,
  payload: NonOpAssignPayload,
  actor: { id?: number; name: string }
): Promise<EmployeeWorkSchedule> {
  const { property_id, employee_id, work_date, work_status } = payload;

  const validUserId = await resolveValidUserId(client, actor.id);
  const propertyTimezone = await fetchPropertyTimezone(client, property_id);

  // Validate employee belongs to property and is active
  const empRes = await client.query(
    `SELECT e.id, e.full_name, e.department_id, d.name as dept_name, p.name as pos_name
     FROM hr_employees e
     LEFT JOIN hr_departments d ON d.id = e.department_id
     LEFT JOIN hr_positions p ON p.id = e.position_id
     WHERE e.id = $1 AND e.property_id = $2 AND e.is_active = TRUE`,
    [employee_id, property_id]
  );
  if (empRes.rows.length === 0) {
    throw Object.assign(new Error('Karyawan tidak ditemukan atau tidak aktif.'), { statusCode: 404, code: 'EMPLOYEE_NOT_FOUND' });
  }
  const emp = empRes.rows[0];

  // Validate department is NON_OPERATIONAL
  const deptCheck = await client.query(
    "SELECT schedule_category FROM hr_departments WHERE id = $1 AND property_id = $2",
    [emp.department_id, property_id]
  );
  if (deptCheck.rows.length > 0 && deptCheck.rows[0].schedule_category !== 'NON_OPERATIONAL') {
    throw Object.assign(
      new Error('Endpoint ini hanya untuk departemen non-operasional.'),
      { statusCode: 422, code: 'NOT_NON_OPERATIONAL_DEPT' }
    );
  }

  // Check for existing schedule
  const existingRes = await client.query(
    `SELECT id, property_id, employee_id, work_date::text AS work_date, shift_template_id,
            schedule_status, work_status, scheduled_start_at, scheduled_end_at,
            department_snapshot, position_snapshot, published_at, published_by_user_id,
            published_by_name, notes, created_by_user_id, updated_by_user_id,
            created_at, updated_at
     FROM employee_work_schedules
     WHERE property_id = $1 AND employee_id = $2 AND work_date = $3`,
    [property_id, employee_id, work_date]
  );
  const existing = existingRes.rows.length > 0 ? formatSchedule(existingRes.rows[0]) : null;

  let resolvedWorkStatus = work_status;
  let resolvedShiftTemplateId: number | null = null;
  let scheduled_start_at: string | null = null;
  let scheduled_end_at: string | null = null;

  if (work_status === 'WORK') {
    // For non-op WORK: use department work pattern times
    const patternRes = await client.query(
      'SELECT * FROM department_work_patterns WHERE department_id = $1 AND is_active = TRUE',
      [emp.department_id]
    );

    if (patternRes.rows.length > 0) {
      const p = patternRes.rows[0];
      const ts = buildScheduledTimestamps(work_date, p.default_start_time, p.default_end_time, p.crosses_midnight, propertyTimezone);
      scheduled_start_at = ts.scheduled_start_at;
      scheduled_end_at = ts.scheduled_end_at;
    }
    // If no pattern, timestamps remain null (acceptable for non-op)
  } else {
    // OFF/LEAVE/SICK/PERMISSION/HOLIDAY: clear shift and timestamps
    resolvedShiftTemplateId = null;
    scheduled_start_at = null;
    scheduled_end_at = null;
  }

  if (existing) {
    // Update existing schedule
    const newStatus = existing.schedule_status === 'PUBLISHED' ? 'CHANGED' : existing.schedule_status;

    await client.query(
      `UPDATE employee_work_schedules
       SET shift_template_id = $1, work_status = $2, schedule_status = $3,
           scheduled_start_at = $4, scheduled_end_at = $5,
           notes = COALESCE($6, notes),
           updated_by_user_id = $7, updated_at = NOW()
       WHERE id = $8`,
      [resolvedShiftTemplateId, resolvedWorkStatus, newStatus,
       scheduled_start_at, scheduled_end_at, null, validUserId, existing.id]
    );

    await client.query(
      `INSERT INTO employee_work_schedule_audits
        (schedule_id, property_id, employee_id, action, old_shift_template_id, new_shift_template_id,
         old_work_status, new_work_status, reason, changed_by_user_id, changed_by_name)
       VALUES ($1,$2,$3,'NON_OP_STATUS_CHANGED',$4,$5,$6,$7,$8,$9,$10)`,
      [existing.id, property_id, employee_id, existing.shift_template_id, resolvedShiftTemplateId,
       existing.work_status, resolvedWorkStatus, null, validUserId, actor.name]
    );

    const updatedRes = await client.query(
      `SELECT id, property_id, employee_id, work_date::text AS work_date, shift_template_id,
              schedule_status, work_status, scheduled_start_at, scheduled_end_at,
              department_snapshot, position_snapshot, published_at, published_by_user_id,
              published_by_name, notes, created_by_user_id, updated_by_user_id,
              created_at, updated_at
       FROM employee_work_schedules WHERE id = $1`,
      [existing.id]
    );
    return formatSchedule(updatedRes.rows[0]);
  }

  // Insert new schedule
  const insertRes = await client.query(
    `INSERT INTO employee_work_schedules
      (property_id, employee_id, work_date, shift_template_id, schedule_status, work_status,
       scheduled_start_at, scheduled_end_at, department_snapshot, position_snapshot, notes,
       created_by_user_id, updated_by_user_id)
     VALUES ($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id, property_id, employee_id, work_date::text AS work_date, shift_template_id,
               schedule_status, work_status, scheduled_start_at, scheduled_end_at,
               department_snapshot, position_snapshot, published_at, published_by_user_id,
               published_by_name, notes, created_by_user_id, updated_by_user_id,
               created_at, updated_at`,
    [property_id, employee_id, work_date, resolvedShiftTemplateId, resolvedWorkStatus,
     scheduled_start_at, scheduled_end_at, emp.dept_name, emp.pos_name, null, validUserId, validUserId]
  );

  const schedule = formatSchedule(insertRes.rows[0]);

  await client.query(
    `INSERT INTO employee_work_schedule_audits
      (schedule_id, property_id, employee_id, action, old_shift_template_id, new_shift_template_id,
       old_work_status, new_work_status, reason, changed_by_user_id, changed_by_name)
     VALUES ($1,$2,$3,'NON_OP_STATUS_CREATED',NULL,$4,NULL,$5,$6,$7,$8)`,
    [schedule.id, property_id, employee_id, resolvedShiftTemplateId, resolvedWorkStatus, null, validUserId, actor.name]
  );

  return schedule;
}

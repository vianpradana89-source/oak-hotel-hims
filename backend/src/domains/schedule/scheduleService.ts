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
  WorkShiftTemplate,
  EmployeeWorkSchedule,
} from './scheduleTypes';

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
    const d = new Date(workDate + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    endDate = `${y}-${mo}-${da}`;
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
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function formatSchedule(row: any): EmployeeWorkSchedule {
  return {
    id: row.id,
    property_id: row.property_id,
    employee_id: row.employee_id,
    work_date: typeof row.work_date === 'string' ? row.work_date.split('T')[0] : row.work_date,
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

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

function getMonday(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

function getSunday(dateStr: string): string {
  const monday = getMonday(dateStr);
  return addDays(monday, 6);
}

// ─── Shift Template CRUD ───

export async function getShiftTemplates(
  client: PoolClient,
  propertyId: number,
  includeInactive = false
): Promise<WorkShiftTemplate[]> {
  const where = includeInactive
    ? 'WHERE wst.property_id = $1'
    : 'WHERE wst.property_id = $1 AND wst.is_active = TRUE';
  const res = await client.query(
    `SELECT wst.* FROM work_shift_templates wst ${where} ORDER BY wst.code ASC`,
    [propertyId]
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
  } = payload;

  const crosses_midnight = forceCrossesMidnight !== undefined
    ? forceCrossesMidnight
    : computeCrossesMidnight(start_time, end_time);

  const res = await client.query(
    `INSERT INTO work_shift_templates
      (property_id, code, name, start_time, end_time, crosses_midnight,
       grace_before_minutes, late_grace_minutes, checkout_grace_minutes, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [property_id, code, name, start_time, end_time, crosses_midnight,
     grace_before_minutes, late_grace_minutes, checkout_grace_minutes, is_active]
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
    `SELECT * FROM employee_work_schedules
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

export async function assignSchedule(
  client: PoolClient,
  payload: AssignSchedulePayload,
  actor: { id?: number; name: string }
): Promise<EmployeeWorkSchedule> {
  const { property_id, employee_id, work_date, shift_template_id, work_status, notes } = payload;

  const validUserId = await resolveValidUserId(client, actor.id);
  const propertyTimezone = await fetchPropertyTimezone(client, property_id);

  const existingRes = await client.query(
    'SELECT * FROM employee_work_schedules WHERE property_id = $1 AND employee_id = $2 AND work_date = $3',
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

    const updatedRes = await client.query( 'SELECT * FROM employee_work_schedules WHERE id = $1', [existing.id]);
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

    const updatedRes = await client.query( 'SELECT * FROM employee_work_schedules WHERE id = $1', [existing.id]);
    return formatSchedule(updatedRes.rows[0]);
  }

  const insertRes = await client.query(
    `INSERT INTO employee_work_schedules
      (property_id, employee_id, work_date, shift_template_id, schedule_status, work_status,
       scheduled_start_at, scheduled_end_at, department_snapshot, position_snapshot, notes,
       created_by_user_id, updated_by_user_id)
     VALUES ($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
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
      const d = new Date(current + 'T00:00:00');
      if (days_of_week.includes(d.getDay())) {
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
    `SELECT * FROM employee_work_schedules
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
    const srcD = new Date(sourceDate + 'T00:00:00');
    const srcMonday = new Date(sourceMonday + 'T00:00:00');
    const dayOffset = Math.round((srcD.getTime() - srcMonday.getTime()) / (1000 * 60 * 60 * 24));
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
    `SELECT * FROM employee_work_schedules
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

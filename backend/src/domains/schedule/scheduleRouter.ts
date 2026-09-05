// backend/src/domains/schedule/scheduleRouter.ts
import { Router, Request, Response } from 'express';
import type { Pool } from 'pg';
import { verifyToken } from '../auth/authService';
import {
  getShiftTemplates,
  getShiftTemplateById,
  createShiftTemplate,
  updateShiftTemplate,
  deactivateShiftTemplate,
  getShiftTemplateTeam,
  getWeeklyRoster,
  getMonthlyRoster,
  assignSchedule,
  bulkAssignSchedule,
  copyWeek,
  publishSchedule,
  getScheduleForAttendance,
  getScheduleAuditHistory,
  updateDepartmentCategory,
  getDepartmentCategories,
  getScheduleGroups,
  getScheduleGroupById,
  createScheduleGroup,
  updateScheduleGroup,
  deactivateScheduleGroup,
  getDepartmentWorkPatterns,
  upsertDepartmentWorkPattern,
  getPropertyHolidays,
  createPropertyHoliday,
  updatePropertyHoliday,
  previewNonOpBulkPattern,
  applyNonOpBulkPattern,
  getGroupedRoster,
  nonOpAssignSchedule,
} from './scheduleService';
import type {
  CreateShiftTemplatePayload,
  UpdateShiftTemplatePayload,
  AssignSchedulePayload,
  BulkAssignSchedulePayload,
  CopyWeekPayload,
  PublishSchedulePayload,
  CreateScheduleGroupPayload,
  UpdateScheduleGroupPayload,
  CreateDepartmentWorkPatternPayload,
  CreatePropertyHolidayPayload,
  UpdatePropertyHolidayPayload,
  NonOpBulkPatternPayload,
} from './scheduleTypes';

function parsePropertyId(val: any, req?: Request): number {
  const candidate = val ?? (req as any)?.user?.property_id ?? req?.query?.property_id ?? req?.query?.propertyId ?? req?.body?.property_id ?? req?.body?.propertyId;
  const p = Number(candidate);
  if (isNaN(p) || p <= 0) {
    const err: any = new Error('Property ID is required and must be a positive integer.');
    err.statusCode = 400;
    err.code = 'INVALID_PROPERTY_ID';
    throw err;
  }
  return p;
}

export function createScheduleRouter(pool: Pool): Router {
  const router = Router();

  // Attach token authentication context
  router.use((req: Request, _res: Response, next: Function) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.split(' ')[1];
        const decoded = verifyToken(token);
        (req as any).user = decoded;
      } catch {
        // ignore
      }
    }
    next();
  });

  // Strict access boundary: MOBILE_ONLY users cannot access desktop HRD schedule routes
  router.use((req: Request, res: Response, next: Function) => {
    const user = (req as any).user;
    if (user && user.access_type === 'MOBILE_ONLY' && user.role !== 'Super Admin') {
      res.status(403).json({
        status: 'ERROR',
        code: 'MOBILE_ONLY_RESTRICTED',
        message: 'Akses ditolak: Akun dengan tipe akses MOBILE_ONLY tidak diizinkan mengakses fitur jadwal kerja.'
      });
      return;
    }
    next();
  });

  // 1. List shift templates
  router.get('/shift-templates', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.query.property_id, req);
      const includeInactive = req.query.include_inactive === 'true';
      const departmentId = req.query.department_id !== undefined && req.query.department_id !== ''
        ? Number(req.query.department_id)
        : undefined;
      const templates = await getShiftTemplates(client, propertyId, includeInactive, departmentId);
      res.json({ status: 'OK', data: templates });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 2. Get single shift template
  router.get('/shift-templates/:id', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.query.property_id, req);
      const templateId = Number(req.params.id);
      if (isNaN(templateId) || templateId <= 0) {
        throw Object.assign(new Error('ID template tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }
      const template = await getShiftTemplateById(client, propertyId, templateId);
      if (!template) {
        throw Object.assign(new Error('Shift template tidak ditemukan.'), { statusCode: 404, code: 'NOT_FOUND' });
      }
      res.json({ status: 'OK', data: template });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 3. Create shift template
  router.post('/shift-templates', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const payload: CreateShiftTemplatePayload = {
        property_id: parsePropertyId(req.body.property_id, req),
        code: req.body.code,
        name: req.body.name,
        start_time: req.body.start_time,
        end_time: req.body.end_time,
        crosses_midnight: req.body.crosses_midnight,
        grace_before_minutes: req.body.grace_before_minutes,
        late_grace_minutes: req.body.late_grace_minutes,
        checkout_grace_minutes: req.body.checkout_grace_minutes,
        is_active: req.body.is_active,
        department_id: req.body.department_id,
        color_key: req.body.color_key,
      };
      const actor = {
        id: (req as any).user?.id,
        name: (req as any).user?.full_name || 'HRD Admin',
      };
      const template = await createShiftTemplate(client, payload, actor);
      await client.query('COMMIT');
      res.status(201).json({ status: 'OK', data: template });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 4. Update shift template
  router.patch('/shift-templates/:id', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId(req.body.property_id || req.query.property_id, req);
      const templateId = Number(req.params.id);
      if (isNaN(templateId) || templateId <= 0) {
        throw Object.assign(new Error('ID template tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }
      const payload: UpdateShiftTemplatePayload = {};
      if (req.body.code !== undefined) payload.code = req.body.code;
      if (req.body.name !== undefined) payload.name = req.body.name;
      if (req.body.start_time !== undefined) payload.start_time = req.body.start_time;
      if (req.body.end_time !== undefined) payload.end_time = req.body.end_time;
      if (req.body.crosses_midnight !== undefined) payload.crosses_midnight = req.body.crosses_midnight;
      if (req.body.grace_before_minutes !== undefined) payload.grace_before_minutes = req.body.grace_before_minutes;
      if (req.body.late_grace_minutes !== undefined) payload.late_grace_minutes = req.body.late_grace_minutes;
      if (req.body.checkout_grace_minutes !== undefined) payload.checkout_grace_minutes = req.body.checkout_grace_minutes;
      if (req.body.is_active !== undefined) payload.is_active = req.body.is_active;
      if (req.body.department_id !== undefined) payload.department_id = req.body.department_id;
      if (req.body.color_key !== undefined) payload.color_key = req.body.color_key;

      const actor = {
        id: (req as any).user?.id,
        name: (req as any).user?.full_name || 'HRD Admin',
      };
      const template = await updateShiftTemplate(client, propertyId, templateId, payload, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', data: template });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 5. Deactivate shift template
  router.delete('/shift-templates/:id', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId(req.body.property_id || req.query.property_id, req);
      const templateId = Number(req.params.id);
      if (isNaN(templateId) || templateId <= 0) {
        throw Object.assign(new Error('ID template tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }
      const actor = {
        id: (req as any).user?.id,
        name: (req as any).user?.full_name || 'HRD Admin',
      };
      await deactivateShiftTemplate(client, propertyId, templateId, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', message: 'Shift template berhasil dinonaktifkan.' });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 5b. Get shift template team (employees assigned for a period)
  router.get('/shift-templates/:id/team', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.query.property_id, req);
      const templateId = Number(req.params.id);
      if (isNaN(templateId) || templateId <= 0) {
        throw Object.assign(new Error('ID template tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }
      const startDate = req.query.start_date as string;
      const endDate = req.query.end_date as string;
      if (!startDate || !endDate) {
        throw Object.assign(new Error('start_date dan end_date wajib diisi.'), { statusCode: 400, code: 'MISSING_DATES' });
      }
      const team = await getShiftTemplateTeam(client, propertyId, templateId, startDate, endDate);
      res.json({ status: 'OK', data: team });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 6. Get weekly roster
  router.get('/roster', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.query.property_id, req);
      const startDate = req.query.start_date as string;
      if (!startDate) {
        throw Object.assign(new Error('start_date wajib diisi.'), { statusCode: 400, code: 'MISSING_START_DATE' });
      }
      const departmentId = req.query.department_id ? Number(req.query.department_id) : undefined;
      const employeeIds = req.query.employee_ids
        ? (req.query.employee_ids as string).split(',').map(Number).filter(n => !isNaN(n))
        : undefined;

      const roster = await getWeeklyRoster(client, {
        property_id: propertyId,
        start_date: startDate,
        end_date: startDate,
        department_id: departmentId,
        employee_ids: employeeIds,
      });
      res.json({ status: 'OK', data: roster });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 6b. Get monthly roster
  router.get('/roster-monthly', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.query.property_id, req);
      const year = Number(req.query.year);
      const month = Number(req.query.month);
      if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
        throw Object.assign(new Error('year dan month wajib diisi valid.'), { statusCode: 400, code: 'INVALID_YEAR_MONTH' });
      }
      const departmentId = req.query.department_id ? Number(req.query.department_id) : undefined;

      const roster = await getMonthlyRoster(client, {
        property_id: propertyId,
        year,
        month,
        department_id: departmentId,
      });
      res.json({ status: 'OK', data: roster });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 7. Assign schedule (single cell)
  router.post('/assign', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const payload: AssignSchedulePayload = {
        property_id: parsePropertyId(req.body.property_id, req),
        employee_id: req.body.employee_id,
        work_date: req.body.work_date,
        shift_template_id: req.body.shift_template_id,
        work_status: req.body.work_status,
        notes: req.body.notes,
      };
      if (!payload.employee_id || !payload.work_date) {
        throw Object.assign(new Error('employee_id dan work_date wajib diisi.'), { statusCode: 400, code: 'MISSING_FIELDS' });
      }
      const actor = {
        id: (req as any).user?.id,
        name: (req as any).user?.full_name || 'HRD Admin',
      };
      const schedule = await assignSchedule(client, payload, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', data: schedule });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 8. Bulk assign schedule
  router.post('/bulk-assign', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const payload: BulkAssignSchedulePayload = {
        property_id: parsePropertyId(req.body.property_id, req),
        employee_ids: req.body.employee_ids,
        shift_template_id: req.body.shift_template_id,
        work_status: req.body.work_status,
        start_date: req.body.start_date,
        end_date: req.body.end_date,
        days_of_week: req.body.days_of_week,
        notes: req.body.notes,
      };
      if (!payload.employee_ids || !Array.isArray(payload.employee_ids) || payload.employee_ids.length === 0) {
        throw Object.assign(new Error('employee_ids wajib diisi dan harus array.'), { statusCode: 400, code: 'MISSING_EMPLOYEES' });
      }
      if (!payload.start_date || !payload.end_date) {
        throw Object.assign(new Error('start_date dan end_date wajib diisi.'), { statusCode: 400, code: 'MISSING_DATES' });
      }
      const actor = {
        id: (req as any).user?.id,
        name: (req as any).user?.full_name || 'HRD Admin',
      };
      const result = await bulkAssignSchedule(client, payload, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', data: result });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 8b. Non-operational cell assign
  router.post('/non-op-assign', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId(req.body.property_id, req);
      const employeeId = req.body.employee_id;
      const workDate = req.body.work_date;
      const workStatus = req.body.work_status;
      if (!employeeId || !workDate || !workStatus) {
        throw Object.assign(new Error('employee_id, work_date, work_status wajib diisi.'), { statusCode: 400, code: 'MISSING_FIELDS' });
      }
      const validStatuses = ['WORK', 'OFF', 'LEAVE', 'SICK', 'PERMISSION', 'HOLIDAY'];
      if (!validStatuses.includes(workStatus)) {
        throw Object.assign(new Error('work_status tidak valid.'), { statusCode: 400, code: 'INVALID_WORK_STATUS' });
      }
      const actor = { id: (req as any).user?.id, name: (req as any).user?.full_name || 'HRD Admin' };
      const schedule = await nonOpAssignSchedule(client, {
        property_id: propertyId,
        employee_id: employeeId,
        work_date: workDate,
        work_status: workStatus,
      }, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', data: schedule });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 9. Copy previous week
  router.post('/copy-week', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const payload: CopyWeekPayload = {
        property_id: parsePropertyId(req.body.property_id, req),
        source_start_date: req.body.source_start_date,
        target_start_date: req.body.target_start_date,
      };
      if (!payload.source_start_date || !payload.target_start_date) {
        throw Object.assign(new Error('source_start_date dan target_start_date wajib diisi.'), { statusCode: 400, code: 'MISSING_DATES' });
      }
      const actor = {
        id: (req as any).user?.id,
        name: (req as any).user?.full_name || 'HRD Admin',
      };
      const result = await copyWeek(client, payload, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', data: result });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 10. Publish schedule
  router.post('/publish', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const payload: PublishSchedulePayload = {
        property_id: parsePropertyId(req.body.property_id, req),
        start_date: req.body.start_date,
        end_date: req.body.end_date,
      };
      if (!payload.start_date || !payload.end_date) {
        throw Object.assign(new Error('start_date dan end_date wajib diisi.'), { statusCode: 400, code: 'MISSING_DATES' });
      }
      const actor = {
        id: (req as any).user?.id,
        name: (req as any).user?.full_name || 'HRD Admin',
      };
      const result = await publishSchedule(client, payload, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', data: result });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 11. Get schedule for attendance (integration contract)
  router.get('/attendance-schedule', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.query.property_id, req);
      const employeeId = Number(req.query.employee_id);
      const workDate = req.query.work_date as string;
      if (isNaN(employeeId) || employeeId <= 0 || !workDate) {
        throw Object.assign(new Error('employee_id dan work_date wajib diisi.'), { statusCode: 400, code: 'MISSING_FIELDS' });
      }
      const result = await getScheduleForAttendance(client, {
        property_id: propertyId,
        employee_id: employeeId,
        work_date: workDate,
      });
      res.json({ status: 'OK', data: result });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 12. Get audit history for an employee
  router.get('/audit/:employeeId', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.query.property_id, req);
      const employeeId = Number(req.params.employeeId);
      if (isNaN(employeeId) || employeeId <= 0) {
        throw Object.assign(new Error('ID karyawan tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }
      const audits = await getScheduleAuditHistory(client, propertyId, employeeId);
      res.json({ status: 'OK', data: audits });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // ─── HR-SCHEDULE-1F: Department Classification ───

  // 13. Get department schedule categories
  router.get('/department-categories', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.query.property_id, req);
      const categories = await getDepartmentCategories(client, propertyId);
      res.json({ status: 'OK', data: categories });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 14. Update department schedule category
  router.patch('/department-categories/:departmentId', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId(req.body.property_id || req.query.property_id, req);
      const departmentId = Number(req.params.departmentId);
      if (isNaN(departmentId) || departmentId <= 0) {
        throw Object.assign(new Error('ID departemen tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }
      const actor = { id: (req as any).user?.id, name: (req as any).user?.full_name || 'HRD Admin' };
      await updateDepartmentCategory(client, propertyId, departmentId, { schedule_category: req.body.schedule_category }, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', message: 'Kategori jadwal departemen berhasil diperbarui.' });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // ─── Schedule Groups (Operational) ───

  // 15. List schedule groups
  router.get('/groups', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.query.property_id, req);
      const includeInactive = req.query.include_inactive === 'true';
      const groups = await getScheduleGroups(client, propertyId, includeInactive);
      res.json({ status: 'OK', data: groups });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 16. Get single schedule group
  router.get('/groups/:id', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.query.property_id, req);
      const groupId = Number(req.params.id);
      if (isNaN(groupId) || groupId <= 0) {
        throw Object.assign(new Error('ID group tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }
      const group = await getScheduleGroupById(client, propertyId, groupId);
      if (!group) {
        throw Object.assign(new Error('Group tidak ditemukan.'), { statusCode: 404, code: 'NOT_FOUND' });
      }
      res.json({ status: 'OK', data: group });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 17. Create schedule group
  router.post('/groups', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const payload: CreateScheduleGroupPayload = {
        property_id: parsePropertyId(req.body.property_id, req),
        name: req.body.name,
        code: req.body.code,
        is_active: req.body.is_active,
        display_order: req.body.display_order,
        department_ids: req.body.department_ids,
      };
      const actor = { id: (req as any).user?.id, name: (req as any).user?.full_name || 'HRD Admin' };
      const group = await createScheduleGroup(client, payload, actor);
      await client.query('COMMIT');
      res.status(201).json({ status: 'OK', data: group });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 18. Update schedule group
  router.patch('/groups/:id', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId(req.body.property_id || req.query.property_id, req);
      const groupId = Number(req.params.id);
      if (isNaN(groupId) || groupId <= 0) {
        throw Object.assign(new Error('ID group tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }
      const payload: UpdateScheduleGroupPayload = {};
      if (req.body.name !== undefined) payload.name = req.body.name;
      if (req.body.code !== undefined) payload.code = req.body.code;
      if (req.body.is_active !== undefined) payload.is_active = req.body.is_active;
      if (req.body.display_order !== undefined) payload.display_order = req.body.display_order;
      if (req.body.department_ids !== undefined) payload.department_ids = req.body.department_ids;
      const actor = { id: (req as any).user?.id, name: (req as any).user?.full_name || 'HRD Admin' };
      const group = await updateScheduleGroup(client, propertyId, groupId, payload, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', data: group });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 19. Deactivate schedule group
  router.delete('/groups/:id', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId(req.body.property_id || req.query.property_id, req);
      const groupId = Number(req.params.id);
      if (isNaN(groupId) || groupId <= 0) {
        throw Object.assign(new Error('ID group tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }
      const actor = { id: (req as any).user?.id, name: (req as any).user?.full_name || 'HRD Admin' };
      await deactivateScheduleGroup(client, propertyId, groupId, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', message: 'Group berhasil dinonaktifkan.' });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // ─── Department Work Patterns (Non-Operational Office Hours) ───

  // 20. List department work patterns
  router.get('/work-patterns', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.query.property_id, req);
      const includeInactive = req.query.include_inactive === 'true';
      const patterns = await getDepartmentWorkPatterns(client, propertyId, includeInactive);
      res.json({ status: 'OK', data: patterns });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 21. Upsert department work pattern
  router.post('/work-patterns', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const payload: CreateDepartmentWorkPatternPayload = {
        property_id: parsePropertyId(req.body.property_id, req),
        department_id: req.body.department_id,
        default_start_time: req.body.default_start_time,
        default_end_time: req.body.default_end_time,
        crosses_midnight: req.body.crosses_midnight,
        is_active: req.body.is_active,
      };
      const actor = { id: (req as any).user?.id, name: (req as any).user?.full_name || 'HRD Admin' };
      const pattern = await upsertDepartmentWorkPattern(client, payload, actor);
      await client.query('COMMIT');
      res.status(201).json({ status: 'OK', data: pattern });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // ─── Property Holidays ───

  // 22. List property holidays
  router.get('/holidays', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.query.property_id, req);
      const includeInactive = req.query.include_inactive === 'true';
      const year = req.query.year ? Number(req.query.year) : undefined;
      const month = req.query.month ? Number(req.query.month) : undefined;
      const holidays = await getPropertyHolidays(client, propertyId, { include_inactive: includeInactive, year, month });
      res.json({ status: 'OK', data: holidays });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 23. Create property holiday
  router.post('/holidays', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const payload: CreatePropertyHolidayPayload = {
        property_id: parsePropertyId(req.body.property_id, req),
        holiday_date: req.body.holiday_date,
        name: req.body.name,
        holiday_type: req.body.holiday_type,
        is_active: req.body.is_active,
      };
      const actor = { id: (req as any).user?.id, name: (req as any).user?.full_name || 'HRD Admin' };
      const holiday = await createPropertyHoliday(client, payload, actor);
      await client.query('COMMIT');
      res.status(201).json({ status: 'OK', data: holiday });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 24. Update property holiday
  router.patch('/holidays/:id', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId(req.body.property_id || req.query.property_id, req);
      const holidayId = Number(req.params.id);
      if (isNaN(holidayId) || holidayId <= 0) {
        throw Object.assign(new Error('ID hari libur tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }
      const payload: UpdatePropertyHolidayPayload = {};
      if (req.body.holiday_date !== undefined) payload.holiday_date = req.body.holiday_date;
      if (req.body.name !== undefined) payload.name = req.body.name;
      if (req.body.holiday_type !== undefined) payload.holiday_type = req.body.holiday_type;
      if (req.body.is_active !== undefined) payload.is_active = req.body.is_active;
      const actor = { id: (req as any).user?.id, name: (req as any).user?.full_name || 'HRD Admin' };
      const holiday = await updatePropertyHoliday(client, propertyId, holidayId, payload, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', data: holiday });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // ─── Non-Operational Bulk Pattern ───

  // 25. Preview non-op bulk pattern
  router.post('/non-op-bulk/preview', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.body.property_id, req);
      const { employee_ids, start_date, end_date, working_days, start_time, end_time } = req.body;
      if (!employee_ids || !start_date || !end_date || !working_days) {
        throw Object.assign(new Error('employee_ids, start_date, end_date, working_days wajib diisi.'), { statusCode: 400, code: 'MISSING_FIELDS' });
      }
      const preview = await previewNonOpBulkPattern(client, propertyId, employee_ids, start_date, end_date, working_days, start_time, end_time);
      res.json({ status: 'OK', data: preview });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 26. Apply non-op bulk pattern
  router.post('/non-op-bulk/apply', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const payload: NonOpBulkPatternPayload = {
        property_id: parsePropertyId(req.body.property_id, req),
        department_id: req.body.department_id,
        employee_ids: req.body.employee_ids,
        start_date: req.body.start_date,
        end_date: req.body.end_date,
        working_days: req.body.working_days,
        default_start_time: req.body.default_start_time,
        default_end_time: req.body.default_end_time,
        crosses_midnight: req.body.crosses_midnight,
        notes: req.body.notes,
      };
      const actor = { id: (req as any).user?.id, name: (req as any).user?.full_name || 'HRD Admin' };
      const result = await applyNonOpBulkPattern(client, payload, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', data: result });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // ─── Grouped Roster ───

  // 27. Get grouped roster (operational groups + non-operational departments)
  router.get('/grouped-roster', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.query.property_id, req);
      const startDate = req.query.start_date as string;
      if (!startDate) {
        throw Object.assign(new Error('start_date wajib diisi.'), { statusCode: 400, code: 'MISSING_START_DATE' });
      }
      const endDate = req.query.end_date as string || startDate;
      const viewMode = (req.query.view_mode as string) || 'all';
      const groupId = req.query.group_id ? Number(req.query.group_id) : undefined;
      const departmentId = req.query.department_id ? Number(req.query.department_id) : undefined;

      const roster = await getGroupedRoster(client, {
        property_id: propertyId,
        start_date: startDate,
        end_date: endDate,
        view_mode: viewMode as any,
        group_id: groupId,
        department_id: departmentId,
      });
      res.json({ status: 'OK', data: roster });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  return router;
}

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
  getWeeklyRoster,
  assignSchedule,
  bulkAssignSchedule,
  copyWeek,
  publishSchedule,
  getScheduleForAttendance,
  getScheduleAuditHistory,
} from './scheduleService';
import type {
  CreateShiftTemplatePayload,
  UpdateShiftTemplatePayload,
  AssignSchedulePayload,
  BulkAssignSchedulePayload,
  CopyWeekPayload,
  PublishSchedulePayload,
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
      const templates = await getShiftTemplates(client, propertyId, includeInactive);
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

  return router;
}

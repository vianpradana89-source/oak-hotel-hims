import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import multer from 'multer';
import {
  getAttendanceSettings,
  updateAttendanceSettings,
  getEmployeeAttendanceStatus,
  recordAttendance,
  getAttendanceRecords,
  getAttendancePhotoFilePath
} from './attendanceService';
import { RecordAttendancePayload } from './attendanceTypes';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

function parsePropertyId(raw: any): number {
  const parsed = Number(raw);
  if (!parsed || isNaN(parsed) || parsed <= 0) {
    const err: any = new Error('Invalid or missing property_id');
    err.statusCode = 400;
    err.code = 'INVALID_PROPERTY_ID';
    throw err;
  }
  return parsed;
}

export function createAttendanceRouter(pool: Pool): Router {
  const router = Router();

  // 1. Get Property Attendance Settings
  router.get('/settings', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      const settings = await getAttendanceSettings(pool, propertyId);
      res.json({ status: 'OK', data: settings });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  // 2. Update Property Attendance Settings
  router.patch('/settings', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId);
      const actor = {
        id: req.body.actor_id ? Number(req.body.actor_id) : undefined,
        name: req.body.actor_name || 'Admin',
        role: req.body.actor_role || 'Admin'
      };
      const updated = await updateAttendanceSettings(client, propertyId, req.body, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', data: updated });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  // 3. Employee Attendance Status for Today
  router.get('/status', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      const employeeId = req.query.employee_id ? Number(req.query.employee_id) : null;
      const employeeRole = typeof req.query.role === 'string' ? req.query.role : undefined;

      const status = await getEmployeeAttendanceStatus(pool, propertyId, employeeId, employeeRole);
      res.json({ status: 'OK', data: status });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  // 4. Record Check-In Attendance (with optional/required selfie photo)
  router.post('/check-in', upload.single('photo') as any, async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId);
      const payload: RecordAttendancePayload = {
        property_id: propertyId,
        employee_id: req.body.employee_id ? Number(req.body.employee_id) : null,
        employee_name: req.body.employee_name,
        department: req.body.department,
        attendance_type: 'CHECK_IN',
        latitude: req.body.latitude ? Number(req.body.latitude) : null,
        longitude: req.body.longitude ? Number(req.body.longitude) : null,
        location_accuracy_meters: req.body.location_accuracy_meters ? Number(req.body.location_accuracy_meters) : null,
        reason: req.body.reason || null
      };

      const actor = {
        id: req.body.actor_id ? Number(req.body.actor_id) : undefined,
        name: req.body.actor_name || payload.employee_name,
        role: req.body.actor_role || 'Staff'
      };

      const record = await recordAttendance(pool, propertyId, payload, req.file, actor);
      res.status(201).json({ status: 'OK', data: record });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  // 5. Record Check-Out Attendance
  router.post('/check-out', upload.single('photo') as any, async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId);
      const payload: RecordAttendancePayload = {
        property_id: propertyId,
        employee_id: req.body.employee_id ? Number(req.body.employee_id) : null,
        employee_name: req.body.employee_name,
        department: req.body.department,
        attendance_type: 'CHECK_OUT',
        latitude: req.body.latitude ? Number(req.body.latitude) : null,
        longitude: req.body.longitude ? Number(req.body.longitude) : null,
        location_accuracy_meters: req.body.location_accuracy_meters ? Number(req.body.location_accuracy_meters) : null,
        reason: req.body.reason || null
      };

      const actor = {
        id: req.body.actor_id ? Number(req.body.actor_id) : undefined,
        name: req.body.actor_name || payload.employee_name,
        role: req.body.actor_role || 'Staff'
      };

      const record = await recordAttendance(pool, propertyId, payload, req.file, actor);
      res.status(201).json({ status: 'OK', data: record });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  // 6. Get Attendance Records
  router.get('/records', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      const filters = {
        start_date: typeof req.query.start_date === 'string' ? req.query.start_date : undefined,
        end_date: typeof req.query.end_date === 'string' ? req.query.end_date : undefined,
        department: typeof req.query.department === 'string' ? req.query.department : undefined,
        employee_id: req.query.employee_id ? Number(req.query.employee_id) : undefined,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        attendance_type: typeof req.query.attendance_type === 'string' ? req.query.attendance_type : undefined
      };

      const records = await getAttendanceRecords(pool, propertyId, filters);
      res.json({ status: 'OK', data: records });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  // 7. Get Attendance Photo (Private stream)
  router.get('/records/:id/photo', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      const recordId = Number(req.params.id);

      const recRes = await pool.query(
        'SELECT photo_storage_key FROM employee_attendance_records WHERE id = $1 AND property_id = $2',
        [recordId, propertyId]
      );

      if (!recRes.rows.length || !recRes.rows[0].photo_storage_key) {
        return res.status(404).json({ status: 'ERROR', code: 'PHOTO_NOT_FOUND', message: 'Foto absensi tidak ditemukan' });
      }

      const filePath = getAttendancePhotoFilePath(recRes.rows[0].photo_storage_key);
      if (!filePath) {
        return res.status(404).json({ status: 'ERROR', code: 'FILE_NOT_FOUND', message: 'File foto tidak ditemukan di storage' });
      }

      res.sendFile(filePath);
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  return router;
}

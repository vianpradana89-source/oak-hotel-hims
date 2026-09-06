import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import multer from 'multer';
import {
  getAttendanceSettings,
  updateAttendanceSettings,
  getEmployeeAttendanceStatus,
  recordAttendance,
  getAttendanceRecords,
  getAttendancePhotoFilePath,
  getAttendanceRecordById
} from './attendanceService';
import { RecordAttendancePayload } from './attendanceTypes';
import type { AuthUserPayload } from '../auth/authService';
import {
  canAdministerAttendancePhotos,
  canChangeAttendanceSettings,
  loadAuthenticatedAttendanceUser,
  parseOptionalPositiveInt,
  rejectEmployeeImpersonation,
  requireAuthenticatedUser,
  resolveAuthoritativePropertyId,
  resolveSelfAttendanceActor
} from './attendanceIdentity';
import {
  inferMimeFromStorageKey,
  isPrivateAttendanceSelfieKey,
  readAttendanceSelfieBuffer
} from './attendancePhotoStorageService';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

function parseRequestedPropertyId(raw: any): number | null {
  return parseOptionalPositiveInt(raw);
}

export function createAttendanceRouter(pool: Pool): Router {
  const router = Router();

  router.get('/settings', async (req: Request, res: Response) => {
    try {
      const user = requireAuthenticatedUser((req as any).user as AuthUserPayload);
      const authUser = await loadAuthenticatedAttendanceUser(pool, user);
      const propertyId = resolveAuthoritativePropertyId({
        tokenPropertyId: authUser.propertyId,
        requestedPropertyId: parseRequestedPropertyId(req.query.property_id || req.query.propertyId),
        isPlatformSuperAdmin: authUser.isPlatformSuperAdmin,
        allowAdminPropertyOverride: true
      });
      const settings = await getAttendanceSettings(pool, propertyId);
      res.json({ status: 'OK', data: settings });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  router.patch('/settings', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const user = requireAuthenticatedUser((req as any).user as AuthUserPayload);
      const authUser = await loadAuthenticatedAttendanceUser(pool, user);
      const propertyId = resolveAuthoritativePropertyId({
        tokenPropertyId: authUser.propertyId,
        requestedPropertyId: parseRequestedPropertyId(req.body.property_id || req.body.propertyId),
        isPlatformSuperAdmin: authUser.isPlatformSuperAdmin,
        allowAdminPropertyOverride: true
      });
      const canMutate = await canChangeAttendanceSettings(pool, authUser.userId, propertyId);
      if (!canMutate) {
        await client.query('ROLLBACK');
        res.status(403).json({
          status: 'ERROR',
          code: 'FORBIDDEN',
          message: 'Akses ditolak. Perubahan pengaturan absensi memerlukan hak HRD edit atau Platform Super Admin.'
        });
        return;
      }
      const actor = {
        id: authUser.userId,
        name: authUser.fullName,
        role: authUser.roleName || 'Admin'
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

  router.get('/status', async (req: Request, res: Response) => {
    try {
      const user = requireAuthenticatedUser((req as any).user as AuthUserPayload);
      const authUser = await loadAuthenticatedAttendanceUser(pool, user);
      const requestedEmployeeId = parseOptionalPositiveInt(req.query.employee_id);
      const requestedPropertyId = parseRequestedPropertyId(req.query.property_id || req.query.propertyId);

      if (authUser.employeeId) {
        rejectEmployeeImpersonation(authUser.employeeId, authUser.userId, requestedEmployeeId);
        const actor = await resolveSelfAttendanceActor(pool, user);
        const propertyId = resolveAuthoritativePropertyId({
          tokenPropertyId: actor.propertyId,
          requestedPropertyId,
          isPlatformSuperAdmin: actor.isPlatformSuperAdmin,
          allowAdminPropertyOverride: false
        });
        const status = await getEmployeeAttendanceStatus(
          pool,
          propertyId,
          actor.employeeId,
          actor.roleName || undefined
        );
        res.json({ status: 'OK', data: status });
        return;
      }

      const propertyId = resolveAuthoritativePropertyId({
        tokenPropertyId: authUser.propertyId,
        requestedPropertyId,
        isPlatformSuperAdmin: authUser.isPlatformSuperAdmin,
        allowAdminPropertyOverride: true
      });

      if (requestedEmployeeId) {
        const canAdmin = await canAdministerAttendancePhotos(pool, authUser.userId, propertyId);
        if (!canAdmin) {
          res.status(403).json({
            status: 'ERROR',
            code: 'EMPLOYEE_IMPERSONATION_FORBIDDEN',
            message: 'Absensi mandiri hanya dapat dicatat untuk karyawan yang sedang login.'
          });
          return;
        }
      }

      const status = await getEmployeeAttendanceStatus(
        pool,
        propertyId,
        requestedEmployeeId,
        typeof req.query.role === 'string' ? req.query.role : authUser.roleName || undefined
      );
      res.json({ status: 'OK', data: status });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  router.post('/check-in', upload.single('photo') as any, async (req: Request, res: Response) => {
    try {
      const user = requireAuthenticatedUser((req as any).user as AuthUserPayload);
      const actor = await resolveSelfAttendanceActor(pool, user);
      rejectEmployeeImpersonation(actor.employeeId, actor.userId, parseOptionalPositiveInt(req.body.employee_id));
      const propertyId = resolveAuthoritativePropertyId({
        tokenPropertyId: actor.propertyId,
        requestedPropertyId: parseRequestedPropertyId(req.body.property_id || req.body.propertyId),
        isPlatformSuperAdmin: actor.isPlatformSuperAdmin,
        allowAdminPropertyOverride: false
      });

      const payload: RecordAttendancePayload = {
        property_id: propertyId,
        employee_id: actor.employeeId,
        employee_name: actor.employeeName,
        department: actor.department || undefined,
        attendance_type: 'CHECK_IN',
        latitude: req.body.latitude ? Number(req.body.latitude) : null,
        longitude: req.body.longitude ? Number(req.body.longitude) : null,
        location_accuracy_meters: req.body.location_accuracy_meters
          ? Number(req.body.location_accuracy_meters)
          : null,
        reason: req.body.reason || null
      };

      const record = await recordAttendance(pool, propertyId, payload, req.file, actor);
      res.status(201).json({ status: 'OK', data: record });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  router.post('/check-out', upload.single('photo') as any, async (req: Request, res: Response) => {
    try {
      const user = requireAuthenticatedUser((req as any).user as AuthUserPayload);
      const actor = await resolveSelfAttendanceActor(pool, user);
      rejectEmployeeImpersonation(actor.employeeId, actor.userId, parseOptionalPositiveInt(req.body.employee_id));
      const propertyId = resolveAuthoritativePropertyId({
        tokenPropertyId: actor.propertyId,
        requestedPropertyId: parseRequestedPropertyId(req.body.property_id || req.body.propertyId),
        isPlatformSuperAdmin: actor.isPlatformSuperAdmin,
        allowAdminPropertyOverride: false
      });

      const payload: RecordAttendancePayload = {
        property_id: propertyId,
        employee_id: actor.employeeId,
        employee_name: actor.employeeName,
        department: actor.department || undefined,
        attendance_type: 'CHECK_OUT',
        latitude: req.body.latitude ? Number(req.body.latitude) : null,
        longitude: req.body.longitude ? Number(req.body.longitude) : null,
        location_accuracy_meters: req.body.location_accuracy_meters
          ? Number(req.body.location_accuracy_meters)
          : null,
        reason: req.body.reason || null
      };

      const record = await recordAttendance(pool, propertyId, payload, req.file, actor);
      res.status(201).json({ status: 'OK', data: record });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  router.get('/records', async (req: Request, res: Response) => {
    try {
      const user = requireAuthenticatedUser((req as any).user as AuthUserPayload);
      const authUser = await loadAuthenticatedAttendanceUser(pool, user);
      const requestedPropertyId = parseRequestedPropertyId(req.query.property_id || req.query.propertyId);
      const requestedEmployeeId = parseOptionalPositiveInt(req.query.employee_id);

      let propertyId: number;
      let employeeFilter: number | undefined;

      if (authUser.employeeId && !authUser.isPlatformSuperAdmin) {
        const actor = await resolveSelfAttendanceActor(pool, user);
        rejectEmployeeImpersonation(actor.employeeId, actor.userId, requestedEmployeeId);
        propertyId = resolveAuthoritativePropertyId({
          tokenPropertyId: actor.propertyId,
          requestedPropertyId,
          isPlatformSuperAdmin: false,
          allowAdminPropertyOverride: false
        });
        employeeFilter = actor.employeeId;
      } else {
        propertyId = resolveAuthoritativePropertyId({
          tokenPropertyId: authUser.propertyId,
          requestedPropertyId,
          isPlatformSuperAdmin: authUser.isPlatformSuperAdmin,
          allowAdminPropertyOverride: true
        });
        const canAdmin = await canAdministerAttendancePhotos(pool, authUser.userId, propertyId);
        if (!canAdmin && authUser.employeeId) {
          rejectEmployeeImpersonation(authUser.employeeId, authUser.userId, requestedEmployeeId);
          employeeFilter = authUser.employeeId;
        } else if (!canAdmin) {
          res.status(403).json({
            status: 'ERROR',
            code: 'FORBIDDEN',
            message: 'Tidak diizinkan melihat daftar absensi karyawan lain.'
          });
          return;
        } else {
          employeeFilter = requestedEmployeeId || undefined;
        }
      }

      const records = await getAttendanceRecords(pool, propertyId, {
        start_date: typeof req.query.start_date === 'string' ? req.query.start_date : undefined,
        end_date: typeof req.query.end_date === 'string' ? req.query.end_date : undefined,
        department: typeof req.query.department === 'string' ? req.query.department : undefined,
        employee_id: employeeFilter,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        attendance_type: typeof req.query.attendance_type === 'string' ? req.query.attendance_type : undefined
      });
      res.json({ status: 'OK', data: records });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  router.get('/records/:id/photo', async (req: Request, res: Response) => {
    try {
      const user = requireAuthenticatedUser((req as any).user as AuthUserPayload);
      const recordId = Number(req.params.id);
      const record = await getAttendanceRecordById(pool, recordId);
      if (!record || !record.photo_storage_key) {
        res.status(404).json({ status: 'ERROR', code: 'PHOTO_NOT_FOUND', message: 'Foto absensi tidak ditemukan' });
        return;
      }

      const authUser = await loadAuthenticatedAttendanceUser(pool, user);
      const isOwner =
        authUser.employeeId != null &&
        record.employee_id != null &&
        authUser.employeeId === record.employee_id &&
        authUser.propertyId === record.property_id;
      const isAdmin = await canAdministerAttendancePhotos(pool, authUser.userId, record.property_id);

      if (!isOwner && !isAdmin) {
        res.status(403).json({
          status: 'ERROR',
          code: 'FORBIDDEN',
          message: 'Tidak diizinkan melihat foto absensi karyawan lain.'
        });
        return;
      }

      res.setHeader('Cache-Control', 'private, max-age=0, no-store');

      if (isPrivateAttendanceSelfieKey(record.photo_storage_key)) {
        const stored = await readAttendanceSelfieBuffer(record.photo_storage_key);
        if (!stored) {
          res.status(404).json({ status: 'ERROR', code: 'FILE_NOT_FOUND', message: 'File foto tidak ditemukan di storage' });
          return;
        }
        res.setHeader('Content-Type', record.photo_mime_type || stored.mimeType);
        res.send(stored.buffer);
        return;
      }

      const filePath = getAttendancePhotoFilePath(record.photo_storage_key);
      if (!filePath) {
        res.status(404).json({ status: 'ERROR', code: 'FILE_NOT_FOUND', message: 'File foto tidak ditemukan di storage' });
        return;
      }
      res.setHeader('Content-Type', record.photo_mime_type || inferMimeFromStorageKey(record.photo_storage_key));
      res.sendFile(filePath);
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  return router;
}

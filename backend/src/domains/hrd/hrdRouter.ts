import { Router, Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import {
  getHrdRolePolicies,
  updateHrdRolePolicies,
  getAvailableRolesForHrd,
  getEmployees,
  createEmployeeAccount,
  updateEmployeeAccount,
  deactivateEmployeeAccount,
  reactivateEmployeeAccount,
  hardDeleteAuthAccount,
  diagnoseEmployeeLoginAccount,
  repairEmployeeLoginAccount,
  resetEmployeePassword,
  validateAndNormalizeCalendarDate,
  getDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  getPositions,
  createPosition,
  updatePosition,
  deletePosition,
  getDynamicRoles,
  createDynamicRole,
  updateDynamicRole,
  deleteDynamicRole,
  getGranularPermissions,
  getRoleGranularPermissions,
  getGranularPermissionsMatrix,
  updateRoleGranularPermissions
} from './hrdService';
import { auditWhatsAppCredentialOpened } from './hrdWhatsapp';
import type {
  CreateEmployeePayload,
  UpdateEmployeePayload,
  AccountRepairActionPayload,
  DeactivateEmployeePayload,
  HardDeleteLoginAccountPayload,
  CreateDepartmentPayload,
  UpdateDepartmentPayload,
  CreatePositionPayload,
  UpdatePositionPayload,
  CreateRolePayload,
  UpdateRolePayload
} from './hrdTypes';
import { verifyToken } from '../auth/authService';

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

export function createHrdRouter(pool: Pool): Router {
  const router = Router();

  // Attach token authentication context if present
  router.use((req: Request, _res: Response, next: NextFunction) => {
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

  // Strict access boundary: MOBILE_ONLY users cannot access desktop HR management routes
  router.use((req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;
    if (user && user.access_type === 'MOBILE_ONLY' && user.role !== 'Super Admin') {
      res.status(403).json({
        status: 'ERROR',
        code: 'MOBILE_ONLY_RESTRICTED',
        message: 'Akses ditolak: Akun dengan tipe akses MOBILE_ONLY tidak diizinkan mengakses fitur operasional desktop HRD.'
      });
      return;
    }
    next();
  });

  // 1. Get HRD Role Policies
  router.get('/policies', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      const policies = await getHrdRolePolicies(client, propertyId);
      res.json({ status: 'OK', data: policies });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 2. Update HRD Role Policies
  router.patch('/policies', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId);
      const actor = {
        id: req.body.actor_id ? Number(req.body.actor_id) : undefined,
        name: req.body.actor_name || 'Management Admin',
        role: req.body.actor_role || 'Admin'
      };
      const updated = await updateHrdRolePolicies(client, propertyId, req.body, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', data: updated });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 3. Get Roles (assignable for HRD or full dynamic list for management)
  router.get('/roles', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      if (req.query.all === 'true' || req.query.scope === 'all' || req.query.manage === 'true' || req.query.mode === 'matrix') {
        const roles = await getDynamicRoles(client, propertyId);
        res.json({ status: 'OK', data: roles });
      } else {
        const roles = await getAvailableRolesForHrd(client, propertyId);
        res.json({ status: 'OK', data: roles });
      }
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 4. Get Employees List
  router.get('/employees', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      const scope = typeof req.query.scope === 'string' ? req.query.scope : 'active';
      const department = typeof req.query.department === 'string' ? req.query.department : undefined;
      const role = typeof req.query.role === 'string' ? req.query.role : undefined;
      const department_id = req.query.department_id ? Number(req.query.department_id) : undefined;

      const employees = await getEmployees(client, propertyId, { scope, department, role, department_id });
      res.json({ status: 'OK', data: employees });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 5. Create Employee Account
  router.post('/employees', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId((req as any).user?.property_id || req.body.property_id || req.body.propertyId);
      const payload: CreateEmployeePayload = {
        property_id: propertyId,
        employee_code: req.body.employee_code,
        full_name: req.body.full_name || req.body.name,
        department_id: req.body.department_id ? Number(req.body.department_id) : undefined,
        position_id: req.body.position_id ? Number(req.body.position_id) : undefined,
        position: req.body.position,
        department: req.body.department,
        role: req.body.role,
        role_id: req.body.role_id ? Number(req.body.role_id) : undefined,
        access_type: req.body.access_type,
        username: req.body.username,
        email: req.body.email,
        phone: req.body.phone,
        hire_date: req.body.hire_date !== undefined
          ? validateAndNormalizeCalendarDate(req.body.hire_date, 'hire_date')
          : undefined,
        monthly_salary: req.body.monthly_salary ? Number(req.body.monthly_salary) : 0,
        status: req.body.status || 'ACTIVE',
        create_login_account: req.body.create_login_account !== undefined
          ? Boolean(req.body.create_login_account)
          : (Boolean(req.body.email) && req.body.role?.toLowerCase() !== 'crew')
      };

      const actor = {
        id: (req as any).user?.id || (req.body.actor_id ? Number(req.body.actor_id) : undefined),
        name: (req as any).user?.full_name || req.body.actor_name || 'HRD Admin',
        role: (req as any).user?.role || req.body.actor_role || 'HRD'
      };

      const created = await createEmployeeAccount(client, propertyId, payload, actor);
      await client.query('COMMIT');
      res.status(201).json({ status: 'OK', data: created });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      let sc = err.statusCode || 500;
      let code = err.code || 'INTERNAL_ERROR';
      let msg = err.message;
      if (err.code === '22007' || err.code === '22008') {
        sc = 400;
        code = 'INVALID_DATE_FORMAT';
        msg = 'Format tanggal tidak valid. Gunakan format YYYY-MM-DD.';
      }
      res.status(sc).json({ status: 'ERROR', code, message: msg });
    } finally {
      client.release();
    }
  });

  // 6. Update Employee Account
  const handleUpdateEmployee = async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId || req.query.property_id);
      const employeeId = Number(req.params.id);
      if (isNaN(employeeId) || employeeId <= 0) {
        throw Object.assign(new Error('ID Karyawan tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }

      const payload: UpdateEmployeePayload = {
        employee_code: req.body.employee_code,
        full_name: req.body.full_name || req.body.name,
        department_id: req.body.department_id !== undefined ? (req.body.department_id ? Number(req.body.department_id) : null) : undefined,
        position_id: req.body.position_id !== undefined ? (req.body.position_id ? Number(req.body.position_id) : null) : undefined,
        position: req.body.position,
        department: req.body.department,
        role: req.body.role,
        role_id: req.body.role_id !== undefined ? (req.body.role_id ? Number(req.body.role_id) : null) : undefined,
        access_type: req.body.access_type,
        username: req.body.username,
        email: req.body.email,
        phone: req.body.phone,
        hire_date: req.body.hire_date !== undefined
          ? validateAndNormalizeCalendarDate(req.body.hire_date, 'hire_date')
          : undefined,
        monthly_salary: req.body.monthly_salary !== undefined ? Number(req.body.monthly_salary) : undefined,
        status: req.body.status,
        is_active: req.body.is_active !== undefined ? Boolean(req.body.is_active) : undefined
      };

      const actor = {
        id: (req as any).user?.id || (req.body.actor_id ? Number(req.body.actor_id) : undefined),
        name: (req as any).user?.full_name || req.body.actor_name || 'HRD Admin',
        role: (req as any).user?.role || req.body.actor_role || 'HRD'
      };

      const updated = await updateEmployeeAccount(client, propertyId, employeeId, payload, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', data: updated });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      let sc = err.statusCode || 500;
      let code = err.code || 'INTERNAL_ERROR';
      let msg = err.message;
      if (err.code === '22007' || err.code === '22008') {
        sc = 400;
        code = 'INVALID_DATE_FORMAT';
        msg = 'Format tanggal tidak valid. Gunakan format YYYY-MM-DD.';
      }
      res.status(sc).json({ status: 'ERROR', code, message: msg });
    } finally {
      client.release();
    }
  };

  router.patch('/employees/:id', handleUpdateEmployee);
  router.put('/employees/:id', handleUpdateEmployee);

  // 7. Deactivate Employee (Soft Delete / Archive) - both DELETE and POST supported
  const handleDeactivate = async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId((req as any).user?.property_id || req.query.property_id || req.query.propertyId || req.body.property_id);
      const employeeId = Number(req.params.id);
      if (isNaN(employeeId) || employeeId <= 0) {
        throw Object.assign(new Error('ID Karyawan tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }

      const actor = {
        id: (req as any).user?.id || (req.body.actor_id ? Number(req.body.actor_id) : undefined),
        name: (req as any).user?.full_name || req.body.actor_name || 'HRD Admin',
        role: (req as any).user?.role || req.body.actor_role || 'HRD'
      };

      const options: DeactivateEmployeePayload = {
        reason: req.body.reason,
        effective_date: req.body.effective_date !== undefined
          ? validateAndNormalizeCalendarDate(req.body.effective_date, 'effective_date')
          : undefined
      };

      const deactivated = await deactivateEmployeeAccount(client, propertyId, employeeId, options, actor);
      await client.query('COMMIT');
      res.json({
        status: 'OK',
        message: 'Karyawan berhasil dinonaktifkan dan dipindahkan ke arsip.',
        data: deactivated
      });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      let sc = err.statusCode || 500;
      let code = err.code || 'INTERNAL_ERROR';
      let msg = err.message;
      if (err.code === '22007' || err.code === '22008') {
        sc = 400;
        code = 'INVALID_DATE_FORMAT';
        msg = 'Format tanggal tidak valid. Gunakan format YYYY-MM-DD.';
      }
      res.status(sc).json({ status: 'ERROR', code, message: msg });
    } finally {
      client.release();
    }
  };

  router.delete('/employees/:id', handleDeactivate);
  router.post('/employees/:id/deactivate', handleDeactivate);

  // 7b. Reactivate Employee Personnel Record
  router.post('/employees/:id/reactivate', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId((req as any).user?.property_id || req.query.property_id || req.query.propertyId || req.body.property_id);
      const employeeId = Number(req.params.id);
      if (isNaN(employeeId) || employeeId <= 0) {
        throw Object.assign(new Error('ID Karyawan tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }

      const actor = {
        id: (req as any).user?.id || (req.body.actor_id ? Number(req.body.actor_id) : undefined),
        name: (req as any).user?.full_name || req.body.actor_name || 'HRD Admin',
        role: (req as any).user?.role || req.body.actor_role || 'HRD'
      };

      const reactivated = await reactivateEmployeeAccount(client, propertyId, employeeId, actor);
      await client.query('COMMIT');
      res.json({
        status: 'OK',
        message: 'Data kepegawaian berhasil diaktifkan kembali. Akun login tetap nonaktif sampai dilakukan verifikasi/perbaikan.',
        data: reactivated
      });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 7c. Hard Delete Auth Login Account (Super Admin / GM only)
  router.delete('/employees/:id/login-account', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId((req as any).user?.property_id || req.query.property_id || req.query.propertyId || req.body.property_id);
      const employeeId = Number(req.params.id);
      if (isNaN(employeeId) || employeeId <= 0) {
        throw Object.assign(new Error('ID Karyawan tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }

      let actorUser = (req as any).user;
      if (!actorUser && req.headers.authorization?.startsWith('Bearer ')) {
        try {
          const { verifyToken } = require('../auth/authService');
          actorUser = verifyToken(req.headers.authorization.split(' ')[1]);
          (req as any).user = actorUser;
        } catch {}
      }

      const actorRole = actorUser?.role || req.body.actor_role;
      const normalizedRole = actorRole ? actorRole.toLowerCase().trim() : '';
      const isPrivileged =
        normalizedRole.includes('admin') ||
        normalizedRole.includes('owner') ||
        normalizedRole.includes('general manager') ||
        normalizedRole === 'gm';

      if (!isPrivileged) {
        throw Object.assign(
          new Error('Akses ditolak: Hanya Super Admin atau General Manager yang diizinkan menghapus permanen akun login.'),
          { statusCode: 403, code: 'FORBIDDEN' }
        );
      }

      const confirmIdentity = req.body.confirm_identity || req.body.confirmIdentity;
      if (!confirmIdentity) {
        throw Object.assign(
          new Error('Konfirmasi identitas (email atau username) wajib diisi untuk menghapus akun login.'),
          { statusCode: 400, code: 'CONFIRMATION_REQUIRED' }
        );
      }

      const actor = {
        id: (req as any).user?.id || (req.body.actor_id ? Number(req.body.actor_id) : undefined),
        name: (req as any).user?.full_name || req.body.actor_name || 'Super Admin',
        role: actorRole || 'Super Admin'
      };

      const result = await hardDeleteAuthAccount(client, propertyId, employeeId, confirmIdentity, actor);
      await client.query('COMMIT');
      res.json({
        status: 'OK',
        message: 'Akun login berhasil dihapus permanen. Data karyawan tetap tersimpan.',
        data: result
      });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({
        status: 'ERROR',
        code: err.code || 'INTERNAL_ERROR',
        message: err.message,
        details: err.details
      });
    } finally {
      client.release();
    }
  });

  // 8. Diagnose Employee Login Account
  router.get('/employees/:id/login-account-diagnosis', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId((req as any).user?.property_id || req.query.property_id || req.query.propertyId);
      const employeeId = Number(req.params.id);
      if (isNaN(employeeId) || employeeId <= 0) {
        throw Object.assign(new Error('ID Karyawan tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }

      const diagnosis = await diagnoseEmployeeLoginAccount(client, propertyId, employeeId);
      res.json({ status: 'OK', data: diagnosis });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 9. Repair Employee Login Account
  router.post('/employees/:id/repair-login-account', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId((req as any).user?.property_id || req.body.property_id || req.body.propertyId);
      const employeeId = Number(req.params.id);
      if (isNaN(employeeId) || employeeId <= 0) {
        throw Object.assign(new Error('ID Karyawan tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }

      const actor = {
        id: (req as any).user?.id || (req.body.actor_id ? Number(req.body.actor_id) : undefined),
        name: (req as any).user?.full_name || req.body.actor_name || 'HRD Admin',
        role: (req as any).user?.role || req.body.actor_role || 'HRD'
      };

      const payload: AccountRepairActionPayload = {
        action: req.body.action,
        target_user_id: req.body.target_user_id ? Number(req.body.target_user_id) : undefined,
        reason: req.body.reason
      };

      const result = await repairEmployeeLoginAccount(client, propertyId, employeeId, payload, actor);
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

  // 10. Reset Employee Password
  router.post('/employees/:id/reset-password', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const actorUser = (req as any).user;
      const actorRole = actorUser?.role || req.body.actor_role;
      const normalizedRole = actorRole ? actorRole.toLowerCase().trim() : '';
      const isAuthorized =
        Boolean(normalizedRole) && (
          normalizedRole.includes('admin') ||
          normalizedRole.includes('owner') ||
          normalizedRole.includes('general manager') ||
          normalizedRole === 'gm' ||
          normalizedRole.includes('hr') ||
          normalizedRole.includes('hrd')
        );

      if (!isAuthorized) {
        const statusCode = actorUser ? 403 : 401;
        const code = actorUser ? 'FORBIDDEN' : 'UNAUTHORIZED';
        const msg = actorUser
          ? 'Akses ditolak: Hanya HRD atau Admin yang diizinkan mereset password karyawan.'
          : 'Autentikasi diperlukan untuk mereset password karyawan.';
        throw Object.assign(new Error(msg), { statusCode, code });
      }

      const propertyId = parsePropertyId((req as any).user?.property_id || req.body.property_id || req.body.propertyId);
      const employeeId = Number(req.params.id);
      if (isNaN(employeeId) || employeeId <= 0) {
        throw Object.assign(new Error('ID Karyawan tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }

      const actor = {
        id: actorUser?.id || (req.body.actor_id ? Number(req.body.actor_id) : undefined),
        name: actorUser?.full_name || req.body.actor_name || 'HRD Admin',
        role: actorRole || 'HRD'
      };

      const result = await resetEmployeePassword(client, propertyId, employeeId, actor);
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

  // 11. Audit WhatsApp Credential Opened (click-to-chat audit)
  router.post('/employees/:id/audit-whatsapp-opened', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId((req as any).user?.property_id || req.body.property_id || req.body.propertyId);
      const employeeId = Number(req.params.id);
      if (isNaN(employeeId) || employeeId <= 0) {
        throw Object.assign(new Error('ID Karyawan tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }

      const phone = req.body.phone;
      const actor = {
        id: (req as any).user?.id || (req.body.actor_id ? Number(req.body.actor_id) : undefined),
        name: (req as any).user?.full_name || req.body.actor_name || 'HRD Admin',
        role: (req as any).user?.role || req.body.actor_role || 'HRD'
      };

      await auditWhatsAppCredentialOpened(client, propertyId, employeeId, phone, actor);
      res.json({ status: 'OK', message: 'Audit recorded' });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // ==========================================================================
  // HR-ACCESS-1: DEPARTMENTS ROUTES
  // ==========================================================================

  // 12. List Departments
  router.get('/departments', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      const includeInactive = req.query.include_inactive === 'true';
      const departments = await getDepartments(client, propertyId, { include_inactive: includeInactive });
      res.json({ status: 'OK', data: departments });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 13. Create Department
  router.post('/departments', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId);
      const actor = {
        id: (req as any).user?.id || (req.body.actor_id ? Number(req.body.actor_id) : undefined),
        name: (req as any).user?.full_name || req.body.actor_name || 'HRD Admin',
        role: (req as any).user?.role || req.body.actor_role || 'HRD'
      };

      const payload: CreateDepartmentPayload = {
        property_id: propertyId,
        code: req.body.code,
        name: req.body.name,
        description: req.body.description,
        sort_order: req.body.sort_order ? Number(req.body.sort_order) : 0,
        is_active: req.body.is_active !== false
      };

      const dept = await createDepartment(client, payload, actor);
      await client.query('COMMIT');
      res.status(201).json({ status: 'OK', data: dept });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 14. Update Department
  router.patch('/departments/:id', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId || req.query.property_id, req);
      const departmentId = Number(req.params.id);
      if (isNaN(departmentId) || departmentId <= 0) {
        throw Object.assign(new Error('ID Departemen tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }

      const actor = {
        id: (req as any).user?.id || (req.body.actor_id ? Number(req.body.actor_id) : undefined),
        name: (req as any).user?.full_name || req.body.actor_name || 'HRD Admin',
        role: (req as any).user?.role || req.body.actor_role || 'HRD'
      };

      const updated = await updateDepartment(client, propertyId, departmentId, req.body, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', data: updated });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 15. Delete Department
  router.delete('/departments/:id', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId(req.query.property_id || req.body.property_id, req);
      const departmentId = Number(req.params.id);
      if (isNaN(departmentId) || departmentId <= 0) {
        throw Object.assign(new Error('ID Departemen tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }

      const actor = {
        id: (req as any).user?.id || (req.body.actor_id ? Number(req.body.actor_id) : undefined),
        name: (req as any).user?.full_name || req.body.actor_name || 'HRD Admin',
        role: (req as any).user?.role || req.body.actor_role || 'HRD'
      };

      const result = await deleteDepartment(client, propertyId, departmentId, actor);
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

  // ==========================================================================
  // HR-ACCESS-1: POSITIONS ROUTES
  // ==========================================================================

  // 16. List Positions
  router.get('/positions', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId, req);
      const deptId = req.query.department_id ? Number(req.query.department_id) : undefined;
      const includeInactive = req.query.include_inactive === 'true';
      const positions = await getPositions(client, propertyId, { department_id: deptId, include_inactive: includeInactive });
      res.json({ status: 'OK', data: positions });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 17. Create Position
  router.post('/positions', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId, req);
      const actor = {
        id: (req as any).user?.id || (req.body.actor_id ? Number(req.body.actor_id) : undefined),
        name: (req as any).user?.full_name || req.body.actor_name || 'HRD Admin',
        role: (req as any).user?.role || req.body.actor_role || 'HRD'
      };

      const payload: CreatePositionPayload = {
        property_id: propertyId,
        department_id: req.body.department_id ? Number(req.body.department_id) : null,
        code: req.body.code,
        name: req.body.name,
        description: req.body.description,
        sort_order: req.body.sort_order ? Number(req.body.sort_order) : 0,
        is_active: req.body.is_active !== false
      };

      const pos = await createPosition(client, payload, actor);
      await client.query('COMMIT');
      res.status(201).json({ status: 'OK', data: pos });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 18. Update Position
  router.patch('/positions/:id', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId || req.query.property_id, req);
      const positionId = Number(req.params.id);
      if (isNaN(positionId) || positionId <= 0) {
        throw Object.assign(new Error('ID Jabatan tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }

      const actor = {
        id: (req as any).user?.id || (req.body.actor_id ? Number(req.body.actor_id) : undefined),
        name: (req as any).user?.full_name || req.body.actor_name || 'HRD Admin',
        role: (req as any).user?.role || req.body.actor_role || 'HRD'
      };

      const updated = await updatePosition(client, propertyId, positionId, req.body, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', data: updated });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 19. Delete Position
  router.delete('/positions/:id', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId(req.query.property_id || req.body.property_id, req);
      const positionId = Number(req.params.id);
      if (isNaN(positionId) || positionId <= 0) {
        throw Object.assign(new Error('ID Jabatan tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }

      const actor = {
        id: (req as any).user?.id || (req.body.actor_id ? Number(req.body.actor_id) : undefined),
        name: (req as any).user?.full_name || req.body.actor_name || 'HRD Admin',
        role: (req as any).user?.role || req.body.actor_role || 'HRD'
      };

      const result = await deletePosition(client, propertyId, positionId, actor);
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

  // ==========================================================================
  // HR-ACCESS-1: DYNAMIC ROLES & GRANULAR PERMISSIONS
  // ==========================================================================

  // 20. List Dynamic Roles (explicit endpoint)
  router.get('/dynamic-roles', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId || 1);
      const roles = await getDynamicRoles(client, propertyId);
      res.json({ status: 'OK', data: roles });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 21. Create Dynamic Role
  router.post('/roles', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = req.body.property_id ? Number(req.body.property_id) : undefined;
      const actor = {
        id: (req as any).user?.id || (req.body.actor_id ? Number(req.body.actor_id) : undefined),
        name: (req as any).user?.full_name || req.body.actor_name || 'HRD Admin',
        role: (req as any).user?.role || req.body.actor_role || 'HRD'
      };

      const payload: CreateRolePayload = {
        property_id: propertyId,
        name: req.body.name,
        description: req.body.description,
        is_active: req.body.is_active !== false,
        permission_keys: req.body.permission_keys || []
      };

      const created = await createDynamicRole(client, payload, actor);
      await client.query('COMMIT');
      res.status(201).json({ status: 'OK', data: created });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 22. Update Dynamic Role
  router.patch('/roles/:id', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const roleId = Number(req.params.id);
      if (isNaN(roleId) || roleId <= 0) {
        throw Object.assign(new Error('ID Role tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }

      const actor = {
        id: (req as any).user?.id || (req.body.actor_id ? Number(req.body.actor_id) : undefined),
        name: (req as any).user?.full_name || req.body.actor_name || 'HRD Admin',
        role: (req as any).user?.role || req.body.actor_role || 'HRD'
      };

      const updated = await updateDynamicRole(client, roleId, req.body, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', data: updated });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 23. Delete Dynamic Role
  router.delete('/roles/:id', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const roleId = Number(req.params.id);
      if (isNaN(roleId) || roleId <= 0) {
        throw Object.assign(new Error('ID Role tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }

      const actor = {
        id: (req as any).user?.id || (req.body.actor_id ? Number(req.body.actor_id) : undefined),
        name: (req as any).user?.full_name || req.body.actor_name || 'HRD Admin',
        role: (req as any).user?.role || req.body.actor_role || 'HRD'
      };

      const result = await deleteDynamicRole(client, roleId, actor);
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

  // 24. List All Granular Permissions
  router.get('/permissions', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const perms = await getGranularPermissions(client);
      res.json({ status: 'OK', data: perms });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 25. Granular Permission Matrix (roles x permissions x granted)
  router.get('/permissions/matrix', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = req.query.property_id ? Number(req.query.property_id) : 1;
      const matrix = await getGranularPermissionsMatrix(client, propertyId);
      res.json({ status: 'OK', data: matrix });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 26. Get Permissions for a specific Role
  router.get('/roles/:id/permissions', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const roleId = Number(req.params.id);
      if (isNaN(roleId) || roleId <= 0) {
        throw Object.assign(new Error('ID Role tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }
      const permKeys = await getRoleGranularPermissions(client, roleId);
      res.json({ status: 'OK', data: permKeys });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 27. Update Permissions for a specific Role
  router.put('/roles/:id/permissions', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const roleId = Number(req.params.id);
      if (isNaN(roleId) || roleId <= 0) {
        throw Object.assign(new Error('ID Role tidak valid.'), { statusCode: 400, code: 'INVALID_ID' });
      }

      const actor = {
        id: (req as any).user?.id || (req.body.actor_id ? Number(req.body.actor_id) : undefined),
        name: (req as any).user?.full_name || req.body.actor_name || 'HRD Admin',
        role: (req as any).user?.role || req.body.actor_role || 'HRD'
      };

      const keys: string[] = Array.isArray(req.body.permission_keys) ? req.body.permission_keys : [];
      const updatedKeys = await updateRoleGranularPermissions(client, roleId, keys, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', data: updatedKeys });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  return router;
}

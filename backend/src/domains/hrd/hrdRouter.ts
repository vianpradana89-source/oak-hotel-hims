import { Router, Request, Response } from 'express';
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
  resetEmployeePassword
} from './hrdService';
import { auditWhatsAppCredentialOpened } from './hrdWhatsapp';
import type {
  CreateEmployeePayload,
  UpdateEmployeePayload,
  AccountRepairActionPayload,
  DeactivateEmployeePayload,
  HardDeleteLoginAccountPayload
} from './hrdTypes';

function parsePropertyId(val: any): number {
  const p = Number(val);
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

  // 3. Get Permitted Roles for HRD
  router.get('/roles', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      const roles = await getAvailableRolesForHrd(client, propertyId);
      res.json({ status: 'OK', data: roles });
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

      const employees = await getEmployees(client, propertyId, { scope, department, role });
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
        position: req.body.position,
        department: req.body.department,
        role: req.body.role,
        username: req.body.username,
        email: req.body.email,
        phone: req.body.phone,
        hire_date: req.body.hire_date,
        monthly_salary: req.body.monthly_salary ? Number(req.body.monthly_salary) : 0,
        status: req.body.status || 'ACTIVE',
        create_login_account: req.body.create_login_account !== undefined ? Boolean(req.body.create_login_account) : true
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
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // 6. Update Employee Account
  router.patch('/employees/:id', async (req: Request, res: Response) => {
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
        position: req.body.position,
        department: req.body.department,
        role: req.body.role,
        username: req.body.username,
        email: req.body.email,
        phone: req.body.phone,
        hire_date: req.body.hire_date,
        monthly_salary: req.body.monthly_salary !== undefined ? Number(req.body.monthly_salary) : undefined,
        status: req.body.status,
        is_active: req.body.is_active !== undefined ? Boolean(req.body.is_active) : undefined
      };

      const actor = {
        id: req.body.actor_id ? Number(req.body.actor_id) : undefined,
        name: req.body.actor_name || 'HRD Admin',
        role: req.body.actor_role || 'HRD'
      };

      const updated = await updateEmployeeAccount(client, propertyId, employeeId, payload, actor);
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
        effective_date: req.body.effective_date
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
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
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

  return router;
}

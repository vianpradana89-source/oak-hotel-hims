import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { hashPassword } from '../auth/authService';
import { requireAuth, type AuthenticatedRequest } from '../auth/authMiddleware';

export function createUsersRouter(pool: Pool): Router {
  const router = Router();

  // All user management endpoints require authentication
  router.use(requireAuth);

  // 1. GET /api/users
  router.get('/', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const propertyId = Number(req.query.property_id || req.query.propertyId || req.user?.property_id || 1);
      
      const result = await pool.query(
        `SELECT u.id, u.property_id, u.role_id, u.username, u.email,
                u.full_name, u.is_active, u.created_at, u.updated_at,
                r.name AS role_name,
                e.position, e.department, e.phone, e.employee_code
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
         LEFT JOIN hr_employees e ON (LOWER(e.email) = LOWER(u.email) OR LOWER(e.username) = LOWER(u.username))
         WHERE u.property_id = $1
         ORDER BY u.id ASC`,
        [propertyId]
      );

      return res.json({
        status: 'OK',
        data: result.rows.map(row => ({
          id: Number(row.id),
          property_id: Number(row.property_id),
          role_id: row.role_id ? Number(row.role_id) : 1,
          role_name: row.role_name || 'Staff',
          username: row.username,
          email: row.email,
          full_name: row.full_name,
          position: row.position || row.role_name || 'Staff',
          department: row.department || 'Front Office',
          phone: row.phone || '',
          employee_code: row.employee_code || `EMP-${row.id}`,
          is_active: row.is_active !== false,
          created_at: row.created_at,
          updated_at: row.updated_at
        }))
      });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', code: 'INTERNAL_ERROR', message: err.message });
    }
  });

  // 2. POST /api/users - Create new employee / user
  router.post('/', async (req: AuthenticatedRequest, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const {
        email,
        username,
        password,
        full_name,
        role,
        role_id,
        department,
        position,
        phone,
        property_id
      } = req.body;

      const propId = Number(property_id || req.user?.property_id || 1);
      const cleanEmail = (email || '').trim().toLowerCase();
      const cleanUsername = (username || cleanEmail.split('@')[0] || '').trim().toLowerCase();
      const cleanFullName = (full_name || '').trim();
      const initialPassword = password || 'OakHotel2026!';

      if (!cleanEmail || !cleanFullName) {
        throw Object.assign(new Error('Email dan Nama Lengkap wajib diisi.'), { statusCode: 400, code: 'INVALID_INPUT' });
      }

      // Resolve role_id
      let targetRoleId = Number(role_id);
      let targetRoleName = role || 'Front Office';

      if (!targetRoleId) {
        const roleQuery = await client.query(`SELECT id, name FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1`, [targetRoleName]);
        if (roleQuery.rows.length > 0) {
          targetRoleId = Number(roleQuery.rows[0].id);
          targetRoleName = roleQuery.rows[0].name;
        } else {
          targetRoleId = 2; // Default to Front Office
          targetRoleName = 'Front Office';
        }
      }

      // Check existing email / username
      const dupCheck = await client.query(
        `SELECT id FROM users WHERE LOWER(email) = $1 OR LOWER(username) = $2 LIMIT 1`,
        [cleanEmail, cleanUsername]
      );

      if (dupCheck.rows.length > 0) {
        throw Object.assign(new Error(`Pengguna dengan email '${cleanEmail}' atau username '${cleanUsername}' sudah terdaftar.`), {
          statusCode: 400,
          code: 'USER_ALREADY_EXISTS'
        });
      }

      const passwordHash = await hashPassword(initialPassword);

      // Insert into users
      const userRes = await client.query(
        `INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW(), NOW())
         RETURNING id, property_id, role_id, username, email, full_name, is_active, created_at`,
        [propId, targetRoleId, cleanUsername, cleanEmail, passwordHash, cleanFullName]
      );

      const createdUser = userRes.rows[0];

      // Sync into hr_employees table for unified staff directory
      const empCode = `EMP-${String(createdUser.id).padStart(3, '0')}`;
      await client.query(
        `INSERT INTO hr_employees (
           property_id, employee_code, full_name, position, department,
           hire_date, monthly_salary, status, role, username, email, phone, is_active, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, 0, 'ACTIVE', $6, $7, $8, $9, TRUE, NOW(), NOW())
         ON CONFLICT DO NOTHING`,
        [
          propId,
          empCode,
          cleanFullName,
          position || targetRoleName,
          department || (targetRoleName === 'Housekeeping' ? 'Housekeeping' : 'Front Office'),
          targetRoleName,
          cleanUsername,
          cleanEmail,
          phone || null
        ]
      );

      // Audit Log
      await client.query(
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
         VALUES ('USER_MANAGEMENT', 'USER_CREATED', 'USER', $1, $2, $3, $4)`,
        [
          String(createdUser.id),
          JSON.stringify({ email: cleanEmail, role: targetRoleName, full_name: cleanFullName }),
          req.user?.username || 'admin',
          propId
        ]
      );

      await client.query('COMMIT');

      return res.status(201).json({
        status: 'OK',
        message: 'Akun karyawan baru berhasil dibuat.',
        data: {
          id: Number(createdUser.id),
          username: createdUser.username,
          email: createdUser.email,
          full_name: createdUser.full_name,
          role_name: targetRoleName,
          role_id: targetRoleId,
          is_active: true,
          created_at: createdUser.created_at
        }
      });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err.code || 'USER_CREATION_FAILED',
        message: err.message || 'Gagal membuat akun karyawan.'
      });
    } finally {
      client.release();
    }
  });

  // 3. PUT /api/users/:id - Update employee / user
  router.put('/:id', async (req: AuthenticatedRequest, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userId = Number(req.params.id);
      const { full_name, role, role_id, email, phone, position, department } = req.body;

      let targetRoleId = role_id ? Number(role_id) : undefined;
      let targetRoleName = role;

      if (!targetRoleId && targetRoleName) {
        const rRes = await client.query(`SELECT id, name FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1`, [targetRoleName]);
        if (rRes.rows.length > 0) {
          targetRoleId = Number(rRes.rows[0].id);
          targetRoleName = rRes.rows[0].name;
        }
      }

      const updateRes = await client.query(
        `UPDATE users
         SET full_name = COALESCE($1, full_name),
             email = COALESCE($2, email),
             role_id = COALESCE($3, role_id),
             updated_at = NOW()
         WHERE id = $4
         RETURNING id, username, email, full_name, role_id, is_active`,
        [full_name, email ? email.trim().toLowerCase() : null, targetRoleId, userId]
      );

      if (updateRes.rows.length === 0) {
        throw Object.assign(new Error('User tidak ditemukan.'), { statusCode: 404, code: 'USER_NOT_FOUND' });
      }

      // Sync with hr_employees
      await client.query(
        `UPDATE hr_employees
         SET full_name = COALESCE($1, full_name),
             role = COALESCE($2, role),
             email = COALESCE($3, email),
             phone = COALESCE($4, phone),
             position = COALESCE($5, position),
             department = COALESCE($6, department),
             updated_at = NOW()
         WHERE email = $7 OR username = (SELECT username FROM users WHERE id = $8)`,
        [full_name, targetRoleName, email, phone, position, department, email, userId]
      );

      await client.query('COMMIT');

      return res.json({
        status: 'OK',
        message: 'Data karyawan berhasil diperbarui.',
        data: updateRes.rows[0]
      });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err.code || 'UPDATE_FAILED',
        message: err.message
      });
    } finally {
      client.release();
    }
  });

  // 4. PATCH /api/users/:id/status - Toggle active/inactive
  router.patch('/:id/status', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = Number(req.params.id);
      const { is_active } = req.body;
      const targetActive = Boolean(is_active);

      // Prevent disabling own account
      if (userId === req.user?.id && !targetActive) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'CANNOT_DEACTIVATE_SELF',
          message: 'Anda tidak dapat menonaktifkan akun Anda sendiri yang sedang aktif digunakan.'
        });
      }

      const resUpdate = await pool.query(
        `UPDATE users SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, full_name, is_active`,
        [targetActive, userId]
      );

      if (resUpdate.rows.length === 0) {
        return res.status(404).json({ status: 'ERROR', code: 'USER_NOT_FOUND', message: 'User tidak ditemukan.' });
      }

      // Sync hr_employees
      await pool.query(
        `UPDATE hr_employees SET is_active = $1, updated_at = NOW() WHERE email = $2`,
        [targetActive, resUpdate.rows[0].email]
      );

      return res.json({
        status: 'OK',
        message: `Akun karyawan berhasil ${targetActive ? 'diaktifkan' : 'dinonaktifkan'}.`,
        data: resUpdate.rows[0]
      });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', code: 'INTERNAL_ERROR', message: err.message });
    }
  });

  // 5. POST /api/users/:id/reset-password - Admin password reset
  router.post('/:id/reset-password', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = Number(req.params.id);
      const { new_password } = req.body;
      const passwordToSet = new_password || 'OakHotel2026!';

      if (passwordToSet.length < 6) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'WEAK_PASSWORD',
          message: 'Password minimal harus 6 karakter.'
        });
      }

      const passwordHash = await hashPassword(passwordToSet);
      const resUpdate = await pool.query(
        `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2 RETURNING id, username, email`,
        [passwordHash, userId]
      );

      if (resUpdate.rows.length === 0) {
        return res.status(404).json({ status: 'ERROR', code: 'USER_NOT_FOUND', message: 'User tidak ditemukan.' });
      }

      return res.json({
        status: 'OK',
        message: 'Password karyawan berhasil direset.',
        data: {
          user: resUpdate.rows[0],
          temporary_password: passwordToSet
        }
      });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', code: 'INTERNAL_ERROR', message: err.message });
    }
  });

  return router;
}

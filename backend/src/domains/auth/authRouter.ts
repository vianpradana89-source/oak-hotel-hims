import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import multer from 'multer';
import {
  loginUser,
  hashPassword,
  comparePassword,
  completeInitialPassword,
  getOnboardingStatus
} from './authService';
import { requireAuth, type AuthenticatedRequest } from './authMiddleware';
import { enrollFace } from './faceEnrollmentService';

export function createAuthRouter(pool: Pool): Router {
  const router = Router();

  // 1. POST /api/auth/login
  router.post('/login', async (req: Request, res: Response) => {
    try {
      const { email, username, password } = req.body;
      const emailOrUsername = email || username;

      if (!emailOrUsername || !password) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'INVALID_INPUT',
          message: 'Email/username dan password wajib diisi.'
        });
      }

      const result = await loginUser(pool, { emailOrUsername, password });
      return res.json({
        status: 'OK',
        message: 'Login berhasil.',
        data: result
      });
    } catch (err: any) {
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err.code || 'LOGIN_ERROR',
        message: err.message || 'Gagal memproses login.'
      });
    }
  });

  // 2. GET /api/auth/me (Protected)
  router.get('/me', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.id;
      const result = await pool.query(
        `SELECT u.id, u.property_id, u.role_id, u.username, u.email,
                u.full_name, u.is_active, u.account_status, u.must_change_password,
                u.access_type,
                r.name AS role_name
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
         WHERE u.id = $1
         LIMIT 1`,
        [userId]
      );

      if (result.rows.length === 0 || result.rows[0].is_active === false) {
        return res.status(401).json({
          status: 'ERROR',
          code: 'USER_NOT_FOUND_OR_INACTIVE',
          message: 'Pengguna tidak ditemukan atau sudah dinonaktifkan.'
        });
      }

      const row = result.rows[0];
      const scope = req.user?.scope || (row.account_status === 'READY' || !row.account_status ? 'FULL' : 'ONBOARDING');
      return res.json({
        status: 'OK',
        data: {
          user: {
            id: Number(row.id),
            email: row.email,
            username: row.username,
            full_name: row.full_name,
            role: row.role_name || 'Super Admin',
            role_id: row.role_id ? Number(row.role_id) : 1,
            property_id: row.property_id ? Number(row.property_id) : 1,
            scope,
            account_status: row.account_status || 'READY',
            must_change_password: Boolean(row.must_change_password),
            access_type: row.access_type || 'PMS_STAFF'
          }
        }
      });
    } catch (err: any) {
      return res.status(500).json({
        status: 'ERROR',
        code: 'INTERNAL_ERROR',
        message: err.message
      });
    }
  });

  // 3. GET /api/auth/onboarding-status (Protected - allows ONBOARDING scope)
  router.get('/onboarding-status', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ status: 'ERROR', code: 'UNAUTHORIZED', message: 'User ID tidak ditemukan.' });
      }

      const statusData = await getOnboardingStatus(pool, userId);
      return res.json({
        status: 'OK',
        data: statusData
      });
    } catch (err: any) {
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err.code || 'ONBOARDING_STATUS_ERROR',
        message: err.message || 'Gagal mengambil status onboarding.'
      });
    }
  });

  // 4. POST /api/auth/complete-initial-password (Protected - ONBOARDING scope)
  router.post('/complete-initial-password', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ status: 'ERROR', code: 'UNAUTHORIZED', message: 'User ID tidak ditemukan.' });
      }

      const result = await completeInitialPassword(pool, userId, req.body || {});
      return res.json({
        status: 'OK',
        message: 'Password pribadi berhasil dibuat. Silakan lanjutkan pendaftaran wajah.',
        data: result
      });
    } catch (err: any) {
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err.code || 'COMPLETE_PASSWORD_ERROR',
        message: err.message || 'Gagal memperbarui password awal.'
      });
    }
  });

  // 4b. POST /api/auth/face-enrollment (Protected - ONBOARDING scope allowed)
  const faceUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 5 * 1024 * 1024 // 5 MB
    }
  });

  router.post(
    '/face-enrollment',
    requireAuth,
    (req: AuthenticatedRequest, res: Response, next) => {
      faceUpload.single('photo')(req, res, (err: any) => {
        if (err) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
              status: 'ERROR',
              code: 'FILE_TOO_LARGE',
              message: 'Ukuran file melebihi batas maksimal 5 MB.'
            });
          }
          return res.status(400).json({
            status: 'ERROR',
            code: 'UPLOAD_ERROR',
            message: err.message || 'Gagal mengunggah file foto wajah.'
          });
        }
        next();
      });
    },
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const userId = req.user?.id;
        if (!userId) {
          return res.status(401).json({
            status: 'ERROR',
            code: 'UNAUTHORIZED',
            message: 'User ID tidak ditemukan.'
          });
        }

        const result = await enrollFace(pool, userId, req.file);
        return res.json({
          status: 'OK',
          message: 'Pendaftaran foto wajah berhasil. Akun Anda siap digunakan.',
          data: result
        });
      } catch (err: any) {
        const statusCode = err.statusCode || 500;
        return res.status(statusCode).json({
          status: 'ERROR',
          code: err.code || 'FACE_ENROLLMENT_ERROR',
          message: err.message || 'Gagal memproses pendaftaran foto wajah.'
        });
      }
    }
  );

  // 5. POST /api/auth/logout (Protected / Public safe)
  router.post('/logout', async (_req: Request, res: Response) => {
    return res.json({
      status: 'OK',
      message: 'Logout berhasil.'
    });
  });

  // 6. POST /api/auth/change-password (Protected - FULL scope only)
  router.post('/change-password', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.id;
      const { current_password, new_password } = req.body;

      if (!current_password || !new_password) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'INVALID_INPUT',
          message: 'Password saat ini dan password baru wajib diisi.'
        });
      }

      if (new_password.length < 6) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'WEAK_PASSWORD',
          message: 'Password baru minimal harus 6 karakter.'
        });
      }

      const userRes = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
      if (userRes.rows.length === 0) {
        return res.status(404).json({ status: 'ERROR', code: 'USER_NOT_FOUND', message: 'User tidak ditemukan.' });
      }

      const isValid = await comparePassword(current_password, userRes.rows[0].password_hash);
      if (!isValid) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'INVALID_CURRENT_PASSWORD',
          message: 'Password saat ini tidak sesuai.'
        });
      }

      const newHash = await hashPassword(new_password);
      await pool.query(`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [newHash, userId]);

      return res.json({
        status: 'OK',
        message: 'Password berhasil diperbarui.'
      });
    } catch (err: any) {
      return res.status(500).json({
        status: 'ERROR',
        code: 'INTERNAL_ERROR',
        message: err.message
      });
    }
  });

  return router;
}

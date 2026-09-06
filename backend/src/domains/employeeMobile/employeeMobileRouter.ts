import { Router, Request, Response } from 'express';
import multer from 'multer';
import type { Pool } from 'pg';
import { requireAuth } from '../auth/authMiddleware';
import { enrollFace, type FaceEnrollmentResult } from '../auth/faceEnrollmentService';
import { getActiveFaceEnrollment } from '../auth/faceEnrollmentService';
import {
  getCanonicalEmployeeIdentity,
  presentCanonicalEmployeeIdentity
} from './employeeMobileIdentity';

export function createEmployeeMobileRouter(pool: Pool): Router {
  const router = Router();

  // SECURITY: Use canonical requireAuth middleware instead of custom token parser.
  // requireAuth rejects unauthenticated requests with 401, never silently ignores failures.
  router.use(requireAuth);

  const faceUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }
  });

  // GET /api/employee-mobile/me
  // Canonical authenticated employee identity for Employee Mobile / attendance UI.
  // Identity is derived exclusively from JWT users.id → users.employee_id.
  router.get('/me', async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      // Identity is JWT-authoritative. Query/body employee_id is never used as authority.
      const identity = await getCanonicalEmployeeIdentity(pool, Number(user.id));
      res.json({
        status: 'OK',
        data: presentCanonicalEmployeeIdentity(identity)
      });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({
        status: 'ERROR',
        code: err.code || 'INTERNAL_ERROR',
        message: err.message || 'Gagal memuat identitas karyawan.'
      });
    }
  });

  // GET /api/employee-mobile/me/face-enrollment
  // Returns the authenticated employee's own face enrollment status
  // Dual-route intent: self-enrollment uses canonical enrollFace() from faceEnrollmentService,
  // the same service used by the auth/face-enrollment onboarding route.
  router.get('/me/face-enrollment', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const user = (req as any).user;

      // Resolve the employee linked to this user
      const userRes = await client.query(
        `SELECT u.id, u.employee_id, u.property_id, u.account_status, u.is_active,
                e.id AS emp_id, e.full_name, e.is_active AS emp_is_active
         FROM users u
         LEFT JOIN hr_employees e ON e.id = u.employee_id
         WHERE u.id = $1`,
        [user.id]
      );

      if (userRes.rows.length === 0 || userRes.rows[0].is_active === false) {
        res.status(401).json({ status: 'ERROR', code: 'USER_INACTIVE', message: 'Akun tidak aktif.' });
        return;
      }

      const userData = userRes.rows[0];

      if (!userData.employee_id || !userData.emp_id) {
        res.status(400).json({
          status: 'ERROR',
          code: 'NO_EMPLOYEE_LINK',
          message: 'Akun tidak terhubung dengan data karyawan.',
          data: {
            has_login_account: true,
            has_employee_link: false,
            face_enrollment_status: 'NO_ACCOUNT',
            face_enrollment_required: false
          }
        });
        return;
      }

      if (userData.emp_is_active === false) {
        res.status(400).json({
          status: 'ERROR',
          code: 'EMPLOYEE_DEACTIVATED',
          message: 'Data karyawan tidak aktif.',
          data: {
            has_login_account: true,
            has_employee_link: true,
            face_enrollment_status: 'NO_ACCOUNT',
            face_enrollment_required: false
          }
        });
        return;
      }

      // Check active face enrollment
      const activeEnrollment = await getActiveFaceEnrollment(
        client,
        userData.property_id,
        userData.employee_id
      );

      const enrollmentRequired = userData.account_status === 'FACE_ENROLLMENT_REQUIRED';

      res.json({
        status: 'OK',
        data: {
          employee_id: userData.employee_id,
          employee_name: userData.full_name,
          property_id: userData.property_id,
          account_status: userData.account_status,
          has_login_account: true,
          has_employee_link: true,
          face_enrollment_status: activeEnrollment ? 'ENROLLED' : (enrollmentRequired ? 'NOT_ENROLLED' : 'UNKNOWN'),
          face_enrollment_required: enrollmentRequired,
          enrolled_at: activeEnrollment?.enrolled_at || null,
          enrollment_id: activeEnrollment?.id || null
        }
      });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // POST /api/employee-mobile/me/face-enrollment
  // Self-enroll face - derives identity exclusively from authenticated session.
  // Dual-route intent: uses canonical enrollFace() from faceEnrollmentService,
  // the same service used by the auth/face-enrollment onboarding route.
  router.post('/me/face-enrollment', async (req: Request, res: Response) => {
    const user = (req as any).user;

    // Handle multipart upload inline
    faceUpload.single('photo')(req, res, async (uploadErr) => {
      if (uploadErr) {
        if (uploadErr instanceof multer.MulterError && uploadErr.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({ status: 'ERROR', code: 'FILE_TOO_LARGE', message: 'Ukuran file melebihi batas maksimal 5 MB.' });
        } else {
          res.status(400).json({ status: 'ERROR', code: 'UPLOAD_ERROR', message: uploadErr.message || 'Gagal mengunggah file.' });
        }
        return;
      }

      if (!req.file) {
        res.status(400).json({ status: 'ERROR', code: 'FILE_REQUIRED', message: 'Foto wajah wajib diunggah.' });
        return;
      }

      try {
        // Self-enrollment: always uses the authenticated user's identity
        // Never trusts employee_id from body
        const result: FaceEnrollmentResult = await enrollFace(pool, user.id, req.file);
        res.json({ status: 'OK', data: result });
      } catch (err: any) {
        const sc = err.statusCode || 500;
        res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
      }
    });
  });

  return router;
}

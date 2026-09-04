import type { Pool } from 'pg';
import {
  saveFaceEnrollmentPhoto,
  deleteFaceEnrollmentPhoto,
  validateFacePhotoUpload
} from './faceEnrollmentStorageService';
import { generateToken, type AuthUserPayload } from './authService';

export interface FaceEnrollmentResult {
  token: string;
  user: AuthUserPayload;
  account_status: 'READY';
  next_step: 'COMPLETE';
  enrollment: {
    id: number;
    enrolled_at: string;
    quality_status: string;
    status: string;
  };
}

export async function enrollFace(
  pool: Pool,
  userId: number,
  file?: Express.Multer.File
): Promise<FaceEnrollmentResult> {
  // 1. Validate file presence & basic characteristics first
  const fileValidation = validateFacePhotoUpload(file);
  if (!fileValidation.valid) {
    const err: any = new Error(fileValidation.error || 'File foto tidak valid.');
    err.statusCode = 400;
    err.code = fileValidation.code || 'INVALID_FILE';
    throw err;
  }

  // 2. Resolve user and linked HR employee
  const userRes = await pool.query(
    `SELECT u.id, u.property_id, u.employee_id, u.account_status, u.is_active,
            u.username, u.full_name, u.email, u.access_type, u.role_id,
            r.name AS role_name,
            e.id AS emp_id, e.property_id AS emp_property_id, e.full_name AS emp_name,
            e.is_active AS emp_is_active
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     LEFT JOIN hr_employees e ON e.id = u.employee_id
     WHERE u.id = $1`,
    [userId]
  );

  if (userRes.rows.length === 0 || userRes.rows[0].is_active === false) {
    const err: any = new Error('Pengguna tidak ditemukan atau sudah dinonaktifkan.');
    err.statusCode = 401;
    err.code = 'USER_INACTIVE';
    throw err;
  }

  const user = userRes.rows[0];

  // 3. User -> Employee link validation
  if (!user.employee_id || !user.emp_id) {
    const err: any = new Error('Pengguna tidak terhubung dengan data karyawan HR (users.employee_id kosong).');
    err.statusCode = 400;
    err.code = 'EMPLOYEE_LINK_REQUIRED';
    throw err;
  }

  if (user.emp_is_active === false) {
    const err: any = new Error('Data karyawan HR terkait sudah tidak aktif.');
    err.statusCode = 403;
    err.code = 'EMPLOYEE_DISABLED';
    throw err;
  }

  // 4. Property consistency check
  if (Number(user.property_id) !== Number(user.emp_property_id)) {
    const err: any = new Error('Scope properti akun tidak cocok dengan data properti karyawan.');
    err.statusCode = 400;
    err.code = 'PROPERTY_MISMATCH';
    throw err;
  }

  // 5. Account state validation
  if (user.account_status === 'READY') {
    const err: any = new Error('Pendaftaran foto wajah sudah selesai. Akun sudah dalam status READY.');
    err.statusCode = 409;
    err.code = 'FACE_ENROLLMENT_ALREADY_COMPLETED';
    throw err;
  }

  if (user.account_status !== 'FACE_ENROLLMENT_REQUIRED') {
    const err: any = new Error('Harap selesaikan pembuatan password terlebih dahulu sebelum pendaftaran foto wajah.');
    err.statusCode = 400;
    err.code = 'INVALID_ACCOUNT_STATUS';
    throw err;
  }

  // 6. Pre-check: existing active master face enrollment
  const existingRes = await pool.query(
    `SELECT id FROM employee_face_enrollments
     WHERE employee_id = $1 AND status = 'ACTIVE'
     LIMIT 1`,
    [user.employee_id]
  );

  if (existingRes.rows.length > 0) {
    const err: any = new Error('Karyawan sudah memiliki master foto wajah aktif.');
    err.statusCode = 409;
    err.code = 'FACE_ENROLLMENT_ALREADY_COMPLETED';
    throw err;
  }

  // 7. Save photo file to private storage
  const savedPhoto = await saveFaceEnrollmentPhoto(
    Number(user.property_id),
    Number(user.employee_id),
    {
      mimetype: file!.mimetype,
      size: file!.size,
      buffer: file!.buffer
    }
  );

  // 8. Database transaction for enrollment record & account readiness
  const client = await pool.connect();
  let enrollmentRow: any;

  try {
    await client.query('BEGIN');

    // Concurrency defense: lock active enrollment rows for this employee
    const lockCheck = await client.query(
      `SELECT id FROM employee_face_enrollments
       WHERE employee_id = $1 AND status = 'ACTIVE'
       FOR UPDATE`,
      [user.employee_id]
    );

    if (lockCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      await deleteFaceEnrollmentPhoto(savedPhoto.storageKey).catch(() => {});
      const err: any = new Error('Karyawan sudah memiliki master foto wajah aktif.');
      err.statusCode = 409;
      err.code = 'FACE_ENROLLMENT_ALREADY_COMPLETED';
      throw err;
    }

    // Insert canonical master face enrollment
    const insertRes = await client.query(
      `INSERT INTO employee_face_enrollments (
         property_id, employee_id, status,
         reference_photo_storage_key, reference_photo_hash,
         enrolled_at, enrolled_by_user_id, enrolled_by_name,
         verification_provider, verification_version,
         quality_status, review_status,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'ACTIVE',
         $3, $4,
         NOW(), $5, $6,
         NULL, NULL,
         'VALID_BASIC', 'AUTO_ACCEPTED',
         NOW(), NOW()
       )
       RETURNING id, enrolled_at, quality_status, status`,
      [
        Number(user.property_id),
        Number(user.employee_id),
        savedPhoto.storageKey,
        savedPhoto.hash,
        Number(user.id),
        user.full_name || user.username
      ]
    );

    enrollmentRow = insertRes.rows[0];

    // Transition user account status to READY
    await client.query(
      `UPDATE users
       SET account_status = 'READY',
           updated_at = NOW()
       WHERE id = $1`,
      [user.id]
    );

    // Audit log: sensitive enrollment event (NO raw photo bytes, NO base64, NO passwords)
    await client.query(
      `INSERT INTO audit_logs (
         module, action, entity, record_id, new_value, correlation_id, property_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'AUTH',
        'FACE_ENROLLMENT_CREATED',
        'EMPLOYEE_FACE_ENROLLMENT',
        String(enrollmentRow.id),
        JSON.stringify({
          user_id: Number(user.id),
          employee_id: Number(user.employee_id),
          property_id: Number(user.property_id),
          enrollment_id: Number(enrollmentRow.id),
          old_status: 'FACE_ENROLLMENT_REQUIRED',
          new_status: 'READY',
          quality_status: 'VALID_BASIC',
          timestamp: new Date().toISOString()
        }),
        user.username || 'FACE_ENROLLMENT',
        Number(user.property_id) || 1
      ]
    );

    await client.query('COMMIT');
  } catch (txErr: any) {
    await client.query('ROLLBACK').catch(() => {});
    // Clean orphan file if DB write fails
    await deleteFaceEnrollmentPhoto(savedPhoto.storageKey).catch(() => {});
    throw txErr;
  } finally {
    client.release();
  }

  // 9. Issue refreshed token with scope = 'FULL' and account_status = 'READY'
  const refreshedUser: AuthUserPayload = {
    id: Number(user.id),
    email: user.email,
    username: user.username,
    full_name: user.full_name,
    role: user.role_name || 'Staff',
    role_id: user.role_id ? Number(user.role_id) : 1,
    property_id: user.property_id ? Number(user.property_id) : 1,
    scope: 'FULL',
    account_status: 'READY',
    must_change_password: false,
    access_type: user.access_type || 'PMS_STAFF'
  };

  const newToken = generateToken(refreshedUser);

  return {
    token: newToken,
    user: refreshedUser,
    account_status: 'READY',
    next_step: 'COMPLETE',
    enrollment: {
      id: Number(enrollmentRow.id),
      enrolled_at: new Date(enrollmentRow.enrolled_at).toISOString(),
      quality_status: enrollmentRow.quality_status,
      status: enrollmentRow.status
    }
  };
}

export interface ActiveFaceEnrollmentRecord {
  id: number;
  property_id: number;
  employee_id: number;
  status: string;
  reference_photo_storage_key: string;
  reference_photo_hash: string;
  enrolled_at: string;
  quality_status: string;
  review_status: string;
}

/**
 * Authoritative face resolution for attendance verification.
 * Always resolves the employee's current ACTIVE master face.
 * Returns null if the employee has no active face enrollment (e.g. revoked or not yet enrolled).
 */
export async function getActiveFaceEnrollment(
  poolOrClient: Pool | import('pg').PoolClient,
  propertyId: number,
  employeeId: number
): Promise<ActiveFaceEnrollmentRecord | null> {
  const res = await poolOrClient.query(
    `SELECT id, property_id, employee_id, status, reference_photo_storage_key,
            reference_photo_hash, enrolled_at, quality_status, review_status
     FROM employee_face_enrollments
     WHERE employee_id = $1 AND property_id = $2 AND status = 'ACTIVE'
     LIMIT 1`,
    [employeeId, propertyId]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    id: Number(row.id),
    property_id: Number(row.property_id),
    employee_id: Number(row.employee_id),
    status: row.status,
    reference_photo_storage_key: row.reference_photo_storage_key,
    reference_photo_hash: row.reference_photo_hash,
    enrolled_at: new Date(row.enrolled_at).toISOString(),
    quality_status: row.quality_status,
    review_status: row.review_status
  };
}

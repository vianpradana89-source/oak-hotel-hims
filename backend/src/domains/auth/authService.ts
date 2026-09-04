import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Pool, PoolClient } from 'pg';

export const JWT_SECRET = process.env.JWT_SECRET || 'oak-hotel-hims-jwt-secret-key-2026-secure-staging';
const JWT_EXPIRES_IN = '7d';

export interface AuthUserPayload {
  id: number;
  email: string;
  username: string;
  full_name: string;
  role: string;
  role_id: number | null;
  property_id: number;
  scope: 'FULL' | 'ONBOARDING';
  account_status?: string | null;
  must_change_password?: boolean;
  access_type?: 'MOBILE_ONLY' | 'PMS_STAFF' | 'MANAGER' | 'ADMIN' | string;
}

export interface LoginResult {
  token: string;
  user: AuthUserPayload;
  scope: 'FULL' | 'ONBOARDING';
  account_status: string;
  must_change_password: boolean;
  next_step: 'CHANGE_PASSWORD' | 'ENROLL_FACE' | 'COMPLETE';
}

export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateToken(payload: AuthUserPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): AuthUserPayload {
  return jwt.verify(token, JWT_SECRET) as AuthUserPayload;
}

export async function loginUser(
  pool: Pool | PoolClient,
  credentials: { emailOrUsername: string; password: string }
): Promise<LoginResult> {
  const term = (credentials.emailOrUsername || '').trim().toLowerCase();
  
  if (!term || !credentials.password) {
    const err: any = new Error('Email/username dan password wajib diisi.');
    err.statusCode = 400;
    err.code = 'INVALID_INPUT';
    throw err;
  }

  const res = await pool.query(
    `SELECT u.id, u.property_id, u.role_id, u.username, u.email, u.password_hash,
            u.full_name, u.is_active, u.employee_id, u.account_status,
            u.must_change_password, u.temp_password_expires_at, u.access_type,
            r.name AS role_name
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE LOWER(u.email) = $1 OR LOWER(u.username) = $1
     LIMIT 1`,
    [term]
  );

  if (res.rows.length === 0) {
    const err: any = new Error('Email atau username tidak ditemukan.');
    err.statusCode = 401;
    err.code = 'INVALID_CREDENTIALS';
    throw err;
  }

  const userRow = res.rows[0];

  // 1. Check account disabled
  if (userRow.is_active === false || userRow.account_status === 'DISABLED') {
    const err: any = new Error('Akun login Anda dinonaktifkan. Hubungi HRD/Administrator.');
    err.statusCode = 403;
    err.code = 'ACCOUNT_DISABLED';
    throw err;
  }

  // 2. Check account suspended
  if (userRow.account_status === 'SUSPENDED') {
    const err: any = new Error('Akun Anda sedang ditangguhkan. Hubungi HRD/Administrator.');
    err.statusCode = 403;
    err.code = 'ACCOUNT_SUSPENDED';
    throw err;
  }

  // 3. Check linked employee status
  if (userRow.employee_id) {
    const empRes = await pool.query(
      'SELECT is_active, status FROM hr_employees WHERE id = $1',
      [userRow.employee_id]
    );
    if (empRes.rows.length > 0) {
      const emp = empRes.rows[0];
      if (emp.is_active === false || (emp.status && emp.status !== 'ACTIVE')) {
        const err: any = new Error('Data kepegawaian Anda berstatus non-aktif. Hubungi HRD.');
        err.statusCode = 403;
        err.code = 'EMPLOYEE_DISABLED';
        throw err;
      }
    }
  }

  // 4. Verify password
  const isValid = await comparePassword(credentials.password, userRow.password_hash);
  if (!isValid) {
    const err: any = new Error('Password yang dimasukkan salah.');
    err.statusCode = 401;
    err.code = 'INVALID_CREDENTIALS';
    throw err;
  }

  // 5. Check temporary password expiry (applies ONLY to temporary password)
  if (userRow.must_change_password && userRow.temp_password_expires_at) {
    const expiresAt = new Date(userRow.temp_password_expires_at);
    if (expiresAt.getTime() < Date.now()) {
      const err: any = new Error('Password sementara sudah kedaluwarsa. Hubungi HRD untuk membuat ulang akses login.');
      err.statusCode = 401;
      err.code = 'TEMP_PASSWORD_EXPIRED';
      throw err;
    }
  }

  // 6. Determine scope & next_step
  let scope: 'FULL' | 'ONBOARDING' = 'FULL';
  let nextStep: 'CHANGE_PASSWORD' | 'ENROLL_FACE' | 'COMPLETE' = 'COMPLETE';
  let effectiveAccountStatus = userRow.account_status || 'READY';

  if (userRow.account_status === 'FIRST_LOGIN_REQUIRED' || userRow.must_change_password === true) {
    scope = 'ONBOARDING';
    nextStep = 'CHANGE_PASSWORD';
    effectiveAccountStatus = 'FIRST_LOGIN_REQUIRED';
  } else if (userRow.account_status === 'FACE_ENROLLMENT_REQUIRED') {
    scope = 'ONBOARDING';
    nextStep = 'ENROLL_FACE';
    effectiveAccountStatus = 'FACE_ENROLLMENT_REQUIRED';
  } else {
    scope = 'FULL';
    nextStep = 'COMPLETE';
    effectiveAccountStatus = 'READY';
  }

  const user: AuthUserPayload = {
    id: Number(userRow.id),
    email: userRow.email,
    username: userRow.username,
    full_name: userRow.full_name,
    role: userRow.role_name || 'Super Admin',
    role_id: userRow.role_id ? Number(userRow.role_id) : 1,
    property_id: userRow.property_id ? Number(userRow.property_id) : 1,
    scope,
    account_status: effectiveAccountStatus,
    must_change_password: Boolean(userRow.must_change_password),
    access_type: userRow.access_type || 'PMS_STAFF'
  };

  const token = generateToken(user);
  return {
    token,
    user,
    scope,
    account_status: effectiveAccountStatus,
    must_change_password: Boolean(userRow.must_change_password),
    next_step: nextStep
  };
}

export async function completeInitialPassword(
  pool: Pool | PoolClient,
  userId: number,
  payload: { new_password?: string; confirm_password?: string }
): Promise<{
  token: string;
  account_status: string;
  must_change_password: boolean;
  next_step: 'ENROLL_FACE';
}> {
  const { new_password, confirm_password } = payload;
  if (!new_password || !confirm_password) {
    const err: any = new Error('Password baru dan konfirmasi password wajib diisi.');
    err.statusCode = 400;
    err.code = 'INVALID_INPUT';
    throw err;
  }

  if (new_password !== confirm_password) {
    const err: any = new Error('Konfirmasi password tidak cocok dengan password baru.');
    err.statusCode = 400;
    err.code = 'PASSWORD_CONFIRMATION_MISMATCH';
    throw err;
  }

  if (new_password.length < 8) {
    const err: any = new Error('Password baru minimal harus 8 karakter.');
    err.statusCode = 400;
    err.code = 'INVALID_PASSWORD';
    throw err;
  }

  const hasUpper = /[A-Z]/.test(new_password);
  const hasLower = /[a-z]/.test(new_password);
  const hasNumber = /[0-9]/.test(new_password);
  const hasSpecial = /[^A-Za-z0-9]/.test(new_password);

  if (!hasUpper || !hasLower || !hasNumber || !hasSpecial) {
    const err: any = new Error('Password harus mengandung huruf besar, huruf kecil, angka, dan simbol/karakter khusus.');
    err.statusCode = 400;
    err.code = 'INVALID_PASSWORD';
    throw err;
  }

  const userRes = await pool.query(
    `SELECT u.id, u.property_id, u.role_id, u.username, u.email, u.full_name,
            u.password_hash, u.is_active, u.account_status, u.access_type, r.name AS role_name
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1`,
    [userId]
  );

  if (userRes.rows.length === 0) {
    const err: any = new Error('User tidak ditemukan.');
    err.statusCode = 404;
    err.code = 'USER_NOT_FOUND';
    throw err;
  }

  const user = userRes.rows[0];

  const isSame = await comparePassword(new_password, user.password_hash);
  if (isSame) {
    const err: any = new Error('Password baru tidak boleh sama dengan password sementara sebelumnya.');
    err.statusCode = 400;
    err.code = 'PASSWORD_MUST_BE_NEW';
    throw err;
  }

  const newHash = await hashPassword(new_password);

  // Update user: personal password set, temp expiry cleared, status -> FACE_ENROLLMENT_REQUIRED
  await pool.query(
    `UPDATE users
     SET password_hash = $1,
         must_change_password = FALSE,
         temp_password_expires_at = NULL,
         account_status = 'FACE_ENROLLMENT_REQUIRED',
         updated_at = NOW()
     WHERE id = $2`,
    [newHash, userId]
  );

  // Audit log: NEVER log plaintext password or hash
  await pool.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'AUTH',
      'INITIAL_PASSWORD_CHANGED',
      'USER_AUTH',
      String(userId),
      JSON.stringify({
        user_id: userId,
        username: user.username,
        account_status: 'FACE_ENROLLMENT_REQUIRED',
        must_change_password: false,
        temp_password_expires_at: null,
        timestamp: new Date().toISOString()
      }),
      user.username || 'ONBOARDING',
      user.property_id || 1
    ]
  );

  // Issue refreshed ONBOARDING token with updated state
  const updatedPayload: AuthUserPayload = {
    id: Number(user.id),
    email: user.email,
    username: user.username,
    full_name: user.full_name,
    role: user.role_name || 'Crew',
    role_id: user.role_id ? Number(user.role_id) : 1,
    property_id: user.property_id ? Number(user.property_id) : 1,
    scope: 'ONBOARDING',
    account_status: 'FACE_ENROLLMENT_REQUIRED',
    must_change_password: false,
    access_type: user.access_type || 'PMS_STAFF'
  };

  const newToken = generateToken(updatedPayload);

  return {
    token: newToken,
    account_status: 'FACE_ENROLLMENT_REQUIRED',
    must_change_password: false,
    next_step: 'ENROLL_FACE'
  };
}

export async function getOnboardingStatus(
  pool: Pool | PoolClient,
  userId: number
): Promise<{
  account_status: string;
  must_change_password: boolean;
  next_step: 'CHANGE_PASSWORD' | 'ENROLL_FACE' | 'COMPLETE';
}> {
  const res = await pool.query(
    `SELECT account_status, must_change_password, is_active
     FROM users WHERE id = $1`,
    [userId]
  );

  if (res.rows.length === 0) {
    const err: any = new Error('User tidak ditemukan.');
    err.statusCode = 404;
    err.code = 'USER_NOT_FOUND';
    throw err;
  }

  const row = res.rows[0];
  const accountStatus = row.account_status || 'READY';
  const mustChange = Boolean(row.must_change_password);

  let nextStep: 'CHANGE_PASSWORD' | 'ENROLL_FACE' | 'COMPLETE' = 'COMPLETE';
  if (accountStatus === 'FIRST_LOGIN_REQUIRED' || mustChange) {
    nextStep = 'CHANGE_PASSWORD';
  } else if (accountStatus === 'FACE_ENROLLMENT_REQUIRED') {
    nextStep = 'ENROLL_FACE';
  } else {
    nextStep = 'COMPLETE';
  }

  return {
    account_status: accountStatus,
    must_change_password: mustChange,
    next_step: nextStep
  };
}

export async function seedSuperAdmin(pool: Pool): Promise<void> {
  try {
    // 1. Ensure all standard roles exist
    await pool.query(`
      INSERT INTO roles (id, name, description)
      VALUES 
        (1, 'Super Admin', 'Full system access'),
        (2, 'Front Office', 'Manages check-in, check-out, and reservations'),
        (3, 'Accounting', 'Manages finance, ledger, and reconciliation'),
        (4, 'Housekeeping', 'Manages room cleaning and turnover'),
        (5, 'General Manager', 'Management and operations oversight'),
        (6, 'POS / Resto', 'Manages POS and restaurant inventory')
      ON CONFLICT (id) DO UPDATE SET 
        name = EXCLUDED.name,
        description = EXCLUDED.description;
    `);

    // 2. Define standard accounts to seed / upsert
    const seedAccounts = [
      {
        email: 'info@oaklawang.com',
        username: 'vian',
        full_name: 'Vian Pradana',
        role_id: 1,
        role_name: 'Super Admin',
        department: 'Management',
        position: null,
        password: 'OakLawang2026!'
      },
      {
        email: 'fo@oaklawang.com',
        username: 'fo_staff',
        full_name: 'Front Desk Staff',
        role_id: 2,
        role_name: 'Front Office',
        department: 'Front Office',
        position: 'Receptionist',
        password: 'FrontOffice2026!'
      },
      {
        email: 'hk@oaklawang.com',
        username: 'hk_staff',
        full_name: 'Housekeeping Staff',
        role_id: 4,
        role_name: 'Housekeeping',
        department: 'Housekeeping',
        position: 'Room Attendant',
        password: 'Housekeeping2026!'
      }
    ];

    for (const acc of seedAccounts) {
      try {
        // Safe query: check if user already exists by email or username
        const existingUser = await pool.query(
          `SELECT id, role_id, username, email, password_hash, full_name, is_active,
                  employee_id, account_status, must_change_password
           FROM users
           WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($2)
           LIMIT 1`,
          [acc.email, acc.username]
        );

        let userId: number;
        if (existingUser.rows.length === 0) {
          // Only hash password upon first-time creation of missing bootstrap account
          const passwordHash = await hashPassword(acc.password);
          const ins = await pool.query(
            `INSERT INTO users (
               property_id, role_id, username, email, password_hash,
               full_name, is_active, account_status, must_change_password, created_at, updated_at
             )
             VALUES (1, $1, $2, $3, $4, $5, TRUE, 'READY', FALSE, NOW(), NOW())
             RETURNING id`,
            [acc.role_id, acc.username, acc.email, passwordHash, acc.full_name]
          );
          userId = Number(ins.rows[0].id);
          console.log(`[AUTH SEED] User created: ${acc.email} / ${acc.username} (Role: ${acc.role_name})`);
        } else {
          // Established account: DO NOT mutate credentials, role, status, or identity
          userId = Number(existingUser.rows[0].id);
          console.log(`[AUTH SEED] User preserved: ${acc.email} / ${acc.username} (Role ID: ${existingUser.rows[0].role_id}, Status: ${existingUser.rows[0].account_status || 'READY'})`);
        }

        // Safe HR Employee Sync: Create if missing only. NEVER mutate established HR records.
        const existingEmp = await pool.query(
          `SELECT id, employee_code, full_name, role, department, is_active
           FROM hr_employees
           WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($2)
           LIMIT 1`,
          [acc.email, acc.username]
        );

        if (existingEmp.rows.length === 0) {
          let empCode = `EMP-U${String(userId).padStart(3, '0')}`;
          const codeCheck = await pool.query('SELECT id FROM hr_employees WHERE employee_code = $1', [empCode]);
          if (codeCheck.rows.length > 0) {
            empCode = `EMP-U${userId}-${Date.now().toString().slice(-4)}`;
          }

          await pool.query(
            `INSERT INTO hr_employees (
               property_id, employee_code, full_name, position, department,
               hire_date, monthly_salary, status, role, username, email, is_active, created_at, updated_at
             )
             VALUES (1, $1, $2, $3, $4, CURRENT_DATE, 0, 'ACTIVE', $5, $6, $7, TRUE, NOW(), NOW())`,
            [empCode, acc.full_name, acc.position, acc.department, acc.role_name, acc.username, acc.email]
          );
          console.log(`[AUTH SEED] HR Employee created: ${acc.email} / ${acc.username}`);
        } else {
          // Established HR employee: NEVER overwrite name, role, department, username, or active status
          console.log(`[AUTH SEED] HR Employee preserved: ${existingEmp.rows[0].employee_code || existingEmp.rows[0].id}`);
        }
      } catch (userErr: any) {
        console.warn(`[AUTH SEED] Note on seeding user ${acc.email}:`, userErr.message);
      }
    }
  } catch (err: any) {
    console.warn(`[AUTH SEED] Note on seeding users & roles:`, err.message);
  }
}

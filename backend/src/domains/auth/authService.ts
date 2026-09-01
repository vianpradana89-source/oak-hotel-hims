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
): Promise<{ token: string; user: AuthUserPayload }> {
  const term = (credentials.emailOrUsername || '').trim().toLowerCase();
  
  if (!term || !credentials.password) {
    const err: any = new Error('Email/username dan password wajib diisi.');
    err.statusCode = 400;
    err.code = 'INVALID_INPUT';
    throw err;
  }

  const res = await pool.query(
    `SELECT u.id, u.property_id, u.role_id, u.username, u.email, u.password_hash,
            u.full_name, u.is_active, r.name AS role_name
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

  if (userRow.is_active === false) {
    const err: any = new Error('Akun ini telah dinonaktifkan. Hubungi Administrator.');
    err.statusCode = 403;
    err.code = 'ACCOUNT_DISABLED';
    throw err;
  }

  const isValid = await comparePassword(credentials.password, userRow.password_hash);
  if (!isValid) {
    const err: any = new Error('Password yang dimasukkan salah.');
    err.statusCode = 401;
    err.code = 'INVALID_CREDENTIALS';
    throw err;
  }

  const user: AuthUserPayload = {
    id: Number(userRow.id),
    email: userRow.email,
    username: userRow.username,
    full_name: userRow.full_name,
    role: userRow.role_name || 'Super Admin',
    role_id: userRow.role_id ? Number(userRow.role_id) : 1,
    property_id: userRow.property_id ? Number(userRow.property_id) : 1
  };

  const token = generateToken(user);
  return { token, user };
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
        password: 'OakLawang2026!'
      },
      {
        email: 'fo@oaklawang.com',
        username: 'fo_staff',
        full_name: 'Front Desk Staff',
        role_id: 2,
        role_name: 'Front Office',
        department: 'Front Office',
        password: 'FrontOffice2026!'
      },
      {
        email: 'hk@oaklawang.com',
        username: 'hk_staff',
        full_name: 'Housekeeping Staff',
        role_id: 4,
        role_name: 'Housekeeping',
        department: 'Housekeeping',
        password: 'Housekeeping2026!'
      }
    ];

    for (const acc of seedAccounts) {
      try {
        const passwordHash = await hashPassword(acc.password);
        
        // Upsert into users (by email or username)
        const existingUser = await pool.query(
          `SELECT id FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($2) LIMIT 1`,
          [acc.email, acc.username]
        );

        let userId: number;
        if (existingUser.rows.length === 0) {
          const ins = await pool.query(
            `INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active, created_at, updated_at)
             VALUES (1, $1, $2, $3, $4, $5, TRUE, NOW(), NOW())
             RETURNING id`,
            [acc.role_id, acc.username, acc.email, passwordHash, acc.full_name]
          );
          userId = Number(ins.rows[0].id);
          console.log(`[AUTH SEED] User created: ${acc.email} / ${acc.username} (Role: ${acc.role_name})`);
        } else {
          userId = Number(existingUser.rows[0].id);
          await pool.query(
            `UPDATE users 
             SET role_id = $1, username = $2, password_hash = $3, full_name = $4, is_active = TRUE, updated_at = NOW()
             WHERE id = $5`,
            [acc.role_id, acc.username, passwordHash, acc.full_name, userId]
          );
          console.log(`[AUTH SEED] User updated: ${acc.email} / ${acc.username} (Role: ${acc.role_name})`);
        }

        // Sync into hr_employees
        const existingEmp = await pool.query(
          `SELECT id, employee_code FROM hr_employees WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($2) LIMIT 1`,
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
             VALUES (1, $1, $2, $3, $4, CURRENT_DATE, 0, 'ACTIVE', $3, $5, $6, TRUE, NOW(), NOW())`,
            [empCode, acc.full_name, acc.role_name, acc.department, acc.username, acc.email]
          );
        } else {
          await pool.query(
            `UPDATE hr_employees
             SET full_name = $1, position = $2, department = $3, role = $2, username = $4, is_active = TRUE, updated_at = NOW()
             WHERE id = $5`,
            [acc.full_name, acc.role_name, acc.department, acc.username, existingEmp.rows[0].id]
          );
        }
      } catch (userErr: any) {
        console.warn(`[AUTH SEED] Failed to seed user ${acc.email}:`, userErr.message);
      }
    }
  } catch (err: any) {
    console.warn(`[AUTH SEED] Note on seeding users & roles:`, err.message);
  }
}

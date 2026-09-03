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
             VALUES (1, $1, $2, $3, $4, CURRENT_DATE, 0, 'ACTIVE', $3, $5, $6, TRUE, NOW(), NOW())`,
            [empCode, acc.full_name, acc.role_name, acc.department, acc.username, acc.email]
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

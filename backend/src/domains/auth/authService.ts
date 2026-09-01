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
  const email = 'info@oaklawang.com';
  const username = 'admin';
  const defaultPassword = 'OakHotel2026!';
  const fullName = 'Super Admin OAK';

  try {
    // Ensure roles exist
    await pool.query(`
      INSERT INTO roles (id, name, description)
      VALUES 
        (1, 'Super Admin', 'Full system access'),
        (2, 'Front Office', 'Manages check-in, check-out, and reservations'),
        (3, 'Accounting', 'Manages finance, ledger, and reconciliation'),
        (4, 'Housekeeping', 'Manages room cleaning and turnover'),
        (5, 'General Manager', 'Management and operations oversight')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Check if Super Admin user already exists
    const existing = await pool.query(
      `SELECT id, password_hash FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($2) LIMIT 1`,
      [email, username]
    );

    if (existing.rows.length === 0) {
      const passwordHash = await hashPassword(defaultPassword);
      await pool.query(
        `INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active, created_at, updated_at)
         VALUES (1, 1, $1, $2, $3, $4, TRUE, NOW(), NOW())`,
        [username, email, passwordHash, fullName]
      );
      console.log(`[AUTH SEED] Super Admin user seeded successfully: ${email} (Password: ${defaultPassword})`);
    } else {
      console.log(`[AUTH SEED] Super Admin user already present in database.`);
    }
  } catch (err: any) {
    console.warn(`[AUTH SEED] Note on seeding users:`, err.message);
  }
}

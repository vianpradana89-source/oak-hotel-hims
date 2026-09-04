import type { Request, Response, NextFunction } from 'express';
import { verifyToken, type AuthUserPayload } from './authService';

export interface AuthenticatedRequest extends Request {
  user?: AuthUserPayload;
}

const ALLOWED_ONBOARDING_PATHS = [
  '/api/auth/onboarding-status',
  '/api/auth/complete-initial-password',
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/face-enrollment'
];

export function isOnboardingAllowedPath(url: string): boolean {
  const cleanPath = (url || '').split('?')[0];
  return ALLOWED_ONBOARDING_PATHS.some(p => cleanPath === p || cleanPath.startsWith(p + '/'));
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      status: 'ERROR',
      code: 'UNAUTHORIZED',
      message: 'Akses ditolak. Silakan login terlebih dahulu untuk mengakses sistem HIMS.'
    });
    return;
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = verifyToken(token);
    req.user = decoded;

    // Strict ONBOARDING scope gate: onboarding tokens cannot access operational routes
    if (decoded.scope === 'ONBOARDING') {
      const url = req.originalUrl || req.url || '';
      if (!isOnboardingAllowedPath(url)) {
        res.status(403).json({
          status: 'ERROR',
          code: 'ACCOUNT_ONBOARDING_INCOMPLETE',
          message: 'Akses ditolak: Anda harus menyelesaikan proses onboarding akun terlebih dahulu.'
        });
        return;
      }
    }

    next();
  } catch (err: any) {
    res.status(401).json({
      status: 'ERROR',
      code: 'INVALID_TOKEN',
      message: 'Sesi login telah kedaluwarsa atau token tidak valid. Silakan login kembali.'
    });
  }
}

export function onboardingSecurityGuard(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = verifyToken(token);
      (req as any).user = decoded;
      if (decoded && decoded.scope === 'ONBOARDING') {
        const url = req.originalUrl || req.url || '';
        if (!isOnboardingAllowedPath(url)) {
          res.status(403).json({
            status: 'ERROR',
            code: 'ACCOUNT_ONBOARDING_INCOMPLETE',
            message: 'Akses ditolak: Anda harus menyelesaikan proses onboarding akun terlebih dahulu.'
          });
          return;
        }
      }
    } catch {
      // Let downstream route handlers/middlewares handle invalid tokens
    }
  }
  next();
}

export function normalizeRoleName(roleName?: string | null): string {
  if (!roleName) return 'Crew';
  const r = roleName.trim().toUpperCase().replace(/[\s_-]+/g, '');
  if (r === 'SUPERADMIN' || r === 'OWNER' || r === 'ADMIN') return 'Super Admin';
  if (r === 'GM' || r === 'GENERALMANAGER' || r === 'MANAGER') return 'General Manager';
  if (r === 'FRONTOFFICE' || r === 'FO' || r === 'RECEPTIONIST') return 'Front Office';
  if (r === 'HOUSEKEEPING' || r === 'HK') return 'Housekeeping';
  if (r === 'ACCOUNTING' || r === 'FINANCE' || r === 'ACCOUNTANT') return 'Accounting';
  if (r === 'POSRESTO' || r === 'POS' || r === 'POSCREW' || r === 'FB' || r === 'FOODANDBEVERAGE') return 'POS / Resto';
  if (r === 'HRDADMIN' || r === 'HRD') return 'HRD Admin';
  return roleName;
}

export function requireRole(allowedRoles: string[]) {
  const normalizedAllowed = allowedRoles.map(normalizeRoleName);
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        status: 'ERROR',
        code: 'UNAUTHORIZED',
        message: 'Akses ditolak. Silakan login terlebih dahulu.'
      });
      return;
    }

    const userRole = normalizeRoleName(req.user.role);

    // Super Admin always has full bypass
    if (userRole === 'Super Admin') {
      next();
      return;
    }

    // Strict MOBILE_ONLY boundary: MOBILE_ONLY users cannot access desktop PMS role-protected operational endpoints
    if (req.user.access_type === 'MOBILE_ONLY') {
      res.status(403).json({
        status: 'ERROR',
        code: 'MOBILE_ONLY_RESTRICTED',
        message: 'Akses ditolak: Akun dengan tipe akses MOBILE_ONLY tidak diizinkan mengakses fitur desktop PMS ini.'
      });
      return;
    }

    if (userRole === 'General Manager' || normalizedAllowed.includes(userRole)) {
      next();
      return;
    }

    res.status(403).json({
      status: 'ERROR',
      code: 'FORBIDDEN',
      message: `Akses ditolak. Fitur ini memerlukan salah satu hak akses: ${allowedRoles.join(', ')}.`
    });
  };
}

export function requirePmsAccess(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({
      status: 'ERROR',
      code: 'UNAUTHORIZED',
      message: 'Akses ditolak. Silakan login terlebih dahulu.'
    });
    return;
  }

  if (normalizeRoleName(req.user.role) === 'Super Admin') {
    next();
    return;
  }

  if (req.user.access_type === 'MOBILE_ONLY') {
    res.status(403).json({
      status: 'ERROR',
      code: 'MOBILE_ONLY_RESTRICTED',
      message: 'Akses ditolak: Akun dengan tipe akses MOBILE_ONLY tidak diizinkan mengakses workspace operasional desktop PMS.'
    });
    return;
  }

  next();
}

export function optionalAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      req.user = verifyToken(token);
    } catch {
      // Ignore token error for optional auth
    }
  }
  next();
}

export async function hasPermission(
  user: AuthUserPayload | undefined,
  permissionKey: string,
  clientOrPool?: any
): Promise<boolean> {
  if (!user) return false;
  const roleName = normalizeRoleName(user.role);
  if (roleName === 'Super Admin') return true;

  // Dynamically resolve pool to avoid circular dependencies
  const db = clientOrPool || require('../../index').pool;
  if (!db) return false;

  if (user.role_id) {
    const res = await db.query(
      `SELECT rp.granted
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = $1 AND p.key = $2 AND rp.granted = TRUE`,
      [user.role_id, permissionKey]
    );
    if ((res.rowCount ?? 0) > 0) return true;
  }

  if (user.role) {
    const res = await db.query(
      `SELECT rp.granted
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       JOIN roles r ON r.id = rp.role_id
       WHERE r.name = $1 AND p.key = $2 AND rp.granted = TRUE`,
      [user.role, permissionKey]
    );
    if ((res.rowCount ?? 0) > 0) return true;
  }

  return false;
}

export function requirePermission(permissionKey: string) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({
        status: 'ERROR',
        code: 'UNAUTHORIZED',
        message: 'Akses ditolak. Silakan login terlebih dahulu.'
      });
      return;
    }

    if (normalizeRoleName(req.user.role) === 'Super Admin') {
      next();
      return;
    }

    // Strict MOBILE_ONLY boundary: MOBILE_ONLY users cannot access desktop PMS permissions
    if (req.user.access_type === 'MOBILE_ONLY') {
      res.status(403).json({
        status: 'ERROR',
        code: 'MOBILE_ONLY_RESTRICTED',
        message: 'Akses ditolak: Akun dengan tipe akses MOBILE_ONLY tidak diizinkan mengakses fitur operasional desktop PMS.'
      });
      return;
    }

    try {
      const allowed = await hasPermission(req.user, permissionKey);
      if (allowed) {
        next();
        return;
      }

      res.status(403).json({
        status: 'ERROR',
        code: 'FORBIDDEN',
        message: `Akses ditolak. Akun Anda tidak memiliki izin '${permissionKey}'.`
      });
    } catch (err: any) {
      console.error('Permission check failure:', err);
      res.status(500).json({
        status: 'ERROR',
        code: 'AUTH_ERROR',
        message: 'Gagal memverifikasi izin hak akses.'
      });
    }
  };
}

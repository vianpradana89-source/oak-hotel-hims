import type { Request, Response, NextFunction } from 'express';
import { verifyToken, type AuthUserPayload } from './authService';

export interface AuthenticatedRequest extends Request {
  user?: AuthUserPayload;
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
    next();
  } catch (err: any) {
    res.status(401).json({
      status: 'ERROR',
      code: 'INVALID_TOKEN',
      message: 'Sesi login telah kedaluwarsa atau token tidak valid. Silakan login kembali.'
    });
  }
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
    // Super Admin and General Manager always have full bypass
    if (userRole === 'Super Admin' || userRole === 'General Manager' || normalizedAllowed.includes(userRole)) {
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

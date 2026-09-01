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

import type { Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import type { AuthenticatedRequest } from '../auth/authMiddleware';
import { hasEffectivePermission, type AccessAction } from './accessControlService';

/**
 * Canonical API enforcement for a navigation resource + View/Edit/Delete action.
 *
 * Resolves through the same effective-permission source the UI reads, so a
 * denied user receives 403 from the API regardless of what the UI shows.
 */
export function requireEffectiveAccess(pool: Pool, resource: string, action: AccessAction) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user || !user.id) {
      res.status(401).json({
        status: 'ERROR',
        code: 'UNAUTHORIZED',
        message: 'Akses ditolak. Silakan login terlebih dahulu.',
      });
      return;
    }

    const propertyId = Number(user.property_id);
    if (!Number.isInteger(propertyId) || propertyId <= 0) {
      res.status(403).json({
        status: 'ERROR',
        code: 'PROPERTY_SCOPE_REQUIRED',
        message: 'Akses ditolak: akun tidak terkait properti yang valid.',
      });
      return;
    }

    try {
      const allowed = await hasEffectivePermission(pool, propertyId, Number(user.id), resource, action);
      if (!allowed) {
        res.status(403).json({
          status: 'ERROR',
          code: 'FORBIDDEN',
          message: `Akses ditolak. Akun Anda tidak memiliki hak akses ${action.toUpperCase()} pada '${resource}'.`,
        });
        return;
      }
      next();
    } catch (err: any) {
      const statusCode = err.statusCode || 500;
      res.status(statusCode).json({
        status: 'ERROR',
        code: err.code || 'ACCESS_CONTROL_ERROR',
        message: err.message || 'Gagal memverifikasi hak akses.',
      });
    }
  };
}

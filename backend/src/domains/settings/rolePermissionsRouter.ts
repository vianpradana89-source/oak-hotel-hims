import { Router, Response } from 'express';
import type { Pool } from 'pg';
import { requireAuth, requireRole, type AuthenticatedRequest } from '../auth/authMiddleware';
import {
  getRolePermissionsMatrix,
  updateRolePermissionsMatrix,
  resetRolePermissionsToDefault
} from './rolePermissionsService';

function parsePropertyId(val: any): number {
  const p = Number(val);
  if (isNaN(p) || p <= 0) {
    return 1; // Default to property 1 if unspecified
  }
  return p;
}

export function createRolePermissionsRouter(pool: Pool): Router {
  const router = Router();

  // 1. GET /api/settings/role-permissions
  router.get('/', async (req: AuthenticatedRequest, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      const matrix = await getRolePermissionsMatrix(client, propertyId);
      return res.json({
        status: 'OK',
        data: matrix
      });
    } catch (err: any) {
      const statusCode = err.statusCode || 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err.code || 'ROLE_PERMISSIONS_FETCH_FAILED',
        message: err.message || 'Gagal memuat matriks hak akses role.'
      });
    } finally {
      client.release();
    }
  });

  // 2. PUT /api/settings/role-permissions - Update custom matrix
  router.put(
    '/',
    requireAuth,
    requireRole(['Super Admin', 'General Manager']),
    async (req: AuthenticatedRequest, res: Response) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId);
        const rolesPayload = Array.isArray(req.body.roles) ? req.body.roles : [];

        const actor = {
          id: req.user?.id,
          name: req.user?.full_name || req.user?.username || 'Admin',
          role: req.user?.role || 'Super Admin'
        };

        const updated = await updateRolePermissionsMatrix(client, propertyId, rolesPayload, actor);
        await client.query('COMMIT');

        return res.json({
          status: 'OK',
          message: 'Pengaturan hak akses role berhasil disimpan.',
          data: updated
        });
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        const statusCode = err.statusCode || 500;
        return res.status(statusCode).json({
          status: 'ERROR',
          code: err.code || 'ROLE_PERMISSIONS_UPDATE_FAILED',
          message: err.message || 'Gagal menyimpan hak akses role.'
        });
      } finally {
        client.release();
      }
    }
  );

  // 3. POST /api/settings/role-permissions/reset - Reset to default SOP
  router.post(
    '/reset',
    requireAuth,
    requireRole(['Super Admin', 'General Manager']),
    async (req: AuthenticatedRequest, res: Response) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId);

        const actor = {
          id: req.user?.id,
          name: req.user?.full_name || req.user?.username || 'Admin',
          role: req.user?.role || 'Super Admin'
        };

        const resetResult = await resetRolePermissionsToDefault(client, propertyId, actor);
        await client.query('COMMIT');

        return res.json({
          status: 'OK',
          message: 'Hak akses role berhasil direset ke standar default SOP OAK.',
          data: resetResult
        });
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        const statusCode = err.statusCode || 500;
        return res.status(statusCode).json({
          status: 'ERROR',
          code: err.code || 'ROLE_PERMISSIONS_RESET_FAILED',
          message: err.message || 'Gagal mereset hak akses role.'
        });
      } finally {
        client.release();
      }
    }
  );

  return router;
}

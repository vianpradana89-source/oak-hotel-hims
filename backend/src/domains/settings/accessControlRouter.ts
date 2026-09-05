import { Router, Response } from 'express';
import type { Pool } from 'pg';
import { requireAuth, type AuthenticatedRequest } from '../auth/authMiddleware';
import { isPlatformSuperAdmin } from '../auth/authService';
import { requireEffectiveAccess } from './accessControlMiddleware';
import {
  ACCESS_ACTIONS,
  ACCESS_RESOURCES,
  getRoleAccessMatrix,
  listAccessUsers,
  resetUserOverrides,
  resolveEffectiveAccess,
  setRoleAccess,
  setUserOverrides,
  type AccessActor,
  type AccessGrid,
  type UserOverrideInput,
} from './accessControlService';

const ACCESS_RESOURCE_SCOPE = 'Pengaturan';

/**
 * Property scope always comes from the authenticated identity, never from the
 * request body or query, so a property user cannot read or edit another
 * property's roles and overrides.
 */
function resolvePropertyScope(req: AuthenticatedRequest): number {
  const propertyId = Number(req.user?.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw Object.assign(new Error('Akun tidak terkait properti yang valid.'), {
      statusCode: 403,
      code: 'PROPERTY_SCOPE_REQUIRED',
    });
  }

  const requested = req.method === 'GET' ? req.query.property_id : req.body?.property_id;
  if (requested !== undefined && requested !== null && String(requested).trim() !== '') {
    if (Number(requested) !== propertyId) {
      throw Object.assign(new Error('Akses lintas properti tidak diizinkan.'), {
        statusCode: 403,
        code: 'CROSS_PROPERTY_FORBIDDEN',
      });
    }
  }
  return propertyId;
}

async function resolveActor(pool: Pool, req: AuthenticatedRequest, propertyId: number): Promise<AccessActor> {
  const userId = Number(req.user?.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw Object.assign(new Error('Autentikasi diperlukan.'), { statusCode: 401, code: 'UNAUTHORIZED' });
  }
  return {
    id: userId,
    name: req.user?.full_name || req.user?.username || 'Admin',
    property_id: propertyId,
    is_platform_super_admin: await isPlatformSuperAdmin(pool, userId),
  };
}

function sendError(res: Response, err: any, fallbackCode: string, fallbackMessage: string): Response {
  const statusCode = err.statusCode || 500;
  return res.status(statusCode).json({
    status: 'ERROR',
    code: err.code || fallbackCode,
    message: err.message || fallbackMessage,
  });
}

function parseAccessGrid(raw: any): AccessGrid {
  const grid: AccessGrid = {};
  for (const resource of ACCESS_RESOURCES) {
    const requested = raw?.[resource.key];
    grid[resource.key] = {
      view: requested?.view === true,
      edit: requested?.edit === true,
      delete: requested?.delete === true,
    };
  }
  return grid;
}

function parseOverrideInputs(raw: any): UserOverrideInput[] {
  if (!Array.isArray(raw)) {
    throw Object.assign(new Error('Daftar override tidak valid.'), {
      statusCode: 422,
      code: 'INVALID_OVERRIDE_PAYLOAD',
    });
  }
  return raw.map((item: any) => ({
    resource: String(item?.resource || ''),
    action: String(item?.action || '') as UserOverrideInput['action'],
    effect: String(item?.effect || '') as UserOverrideInput['effect'],
    reason: typeof item?.reason === 'string' ? item.reason.trim() || null : null,
  }));
}

export function createAccessControlRouter(pool: Pool): Router {
  const router = Router();

  const canView = [requireAuth, requireEffectiveAccess(pool, ACCESS_RESOURCE_SCOPE, 'view')];
  const canEdit = [requireAuth, requireEffectiveAccess(pool, ACCESS_RESOURCE_SCOPE, 'edit')];

  // 1. Canonical resource catalog (navigation + View/Edit/Delete mapping)
  router.get('/resources', requireAuth, (_req: AuthenticatedRequest, res: Response) => {
    res.json({ status: 'OK', data: { actions: ACCESS_ACTIONS, resources: ACCESS_RESOURCES } });
  });

  // 2. Effective permissions for the authenticated user.
  //    Dashboard and mobile navigation both read this, so UI visibility and API
  //    enforcement resolve from one source.
  router.get('/me', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const propertyId = Number(req.user?.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        throw Object.assign(new Error('Akun tidak terkait properti yang valid.'), {
          statusCode: 403,
          code: 'PROPERTY_SCOPE_REQUIRED',
        });
      }
      const effective = await resolveEffectiveAccess(pool, propertyId, Number(req.user?.id));
      res.json({ status: 'OK', data: effective });
    } catch (err: any) {
      sendError(res, err, 'EFFECTIVE_ACCESS_FAILED', 'Gagal memuat hak akses efektif.');
    }
  });

  // ─── Hak Akses Role ───

  router.get('/roles', ...canView, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const propertyId = resolvePropertyScope(req);
      const matrix = await getRoleAccessMatrix(pool, propertyId);
      res.json({ status: 'OK', data: matrix });
    } catch (err: any) {
      sendError(res, err, 'ROLE_ACCESS_FETCH_FAILED', 'Gagal memuat hak akses role.');
    }
  });

  router.put('/roles/:roleId', ...canEdit, async (req: AuthenticatedRequest, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = resolvePropertyScope(req);
      const actor = await resolveActor(pool, req, propertyId);
      const roleId = Number(req.params.roleId);
      if (!Number.isInteger(roleId) || roleId <= 0) {
        throw Object.assign(new Error('ID role tidak valid.'), { statusCode: 400, code: 'INVALID_ROLE_ID' });
      }

      await client.query('BEGIN');
      const updated = await setRoleAccess(client, propertyId, roleId, parseAccessGrid(req.body?.access), actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', message: 'Hak akses role berhasil disimpan.', data: updated });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      sendError(res, err, 'ROLE_ACCESS_UPDATE_FAILED', 'Gagal menyimpan hak akses role.');
    } finally {
      client.release();
    }
  });

  // ─── Hak Akses Pengguna ───

  router.get('/users', ...canView, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const propertyId = resolvePropertyScope(req);
      const users = await listAccessUsers(pool, propertyId);
      res.json({ status: 'OK', data: { property_id: propertyId, users } });
    } catch (err: any) {
      sendError(res, err, 'ACCESS_USERS_FETCH_FAILED', 'Gagal memuat daftar pengguna.');
    }
  });

  router.get('/users/:userId', ...canView, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const propertyId = resolvePropertyScope(req);
      const userId = Number(req.params.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        throw Object.assign(new Error('ID pengguna tidak valid.'), { statusCode: 400, code: 'INVALID_USER_ID' });
      }
      const effective = await resolveEffectiveAccess(pool, propertyId, userId);
      res.json({ status: 'OK', data: effective });
    } catch (err: any) {
      sendError(res, err, 'ACCESS_USER_FETCH_FAILED', 'Gagal memuat hak akses pengguna.');
    }
  });

  router.put('/users/:userId/overrides', ...canEdit, async (req: AuthenticatedRequest, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = resolvePropertyScope(req);
      const actor = await resolveActor(pool, req, propertyId);
      const userId = Number(req.params.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        throw Object.assign(new Error('ID pengguna tidak valid.'), { statusCode: 400, code: 'INVALID_USER_ID' });
      }

      await client.query('BEGIN');
      const updated = await setUserOverrides(client, propertyId, userId, parseOverrideInputs(req.body?.overrides), actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', message: 'Hak akses pengguna berhasil disimpan.', data: updated });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      sendError(res, err, 'USER_OVERRIDE_UPDATE_FAILED', 'Gagal menyimpan hak akses pengguna.');
    } finally {
      client.release();
    }
  });

  router.post('/users/:userId/overrides/reset', ...canEdit, async (req: AuthenticatedRequest, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = resolvePropertyScope(req);
      const actor = await resolveActor(pool, req, propertyId);
      const userId = Number(req.params.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        throw Object.assign(new Error('ID pengguna tidak valid.'), { statusCode: 400, code: 'INVALID_USER_ID' });
      }

      await client.query('BEGIN');
      const updated = await resetUserOverrides(client, propertyId, userId, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', message: 'Hak akses pengguna dikembalikan ke default role.', data: updated });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      sendError(res, err, 'USER_OVERRIDE_RESET_FAILED', 'Gagal mereset hak akses pengguna.');
    } finally {
      client.release();
    }
  });

  return router;
}

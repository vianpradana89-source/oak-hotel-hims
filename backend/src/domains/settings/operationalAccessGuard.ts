import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import { verifyToken } from '../auth/authService';
import { hasAnyEffectivePermission, type AccessAction } from './accessControlService';

export interface OperationalAccessRule {
  pattern: RegExp;
  resources: string[];
  /** When set, overrides HTTP-method inference for this path. */
  action?: AccessAction;
  methods?: string[];
}

const VIEW_LIKE_POST = [
  /\/duplicate-check$/,
  /\/match$/,
  /\/edit-preview$/,
  /\/edit-availability$/,
  /\/room-move-preview$/,
  /\/room-move-availability$/,
  /\/non-op-bulk\/preview$/,
];

const DELETE_LIKE = [
  /\/cancel$/,
  /\/void$/,
  /\/archive$/,
  /\/soft-delete$/,
  /\/deactivate$/,
  /\/hard-delete$/,
  /\/purge$/,
];

/**
 * Path → Hak Akses resource mapping traced from routers mounted in index.ts.
 * First match wins. Unlisted /api routes stay on their existing auth helpers.
 */
export const OPERATIONAL_ACCESS_RULES: OperationalAccessRule[] = [
  { pattern: /^\/api\/reservations\/[^/]+\/(folio|payments)/, resources: ['Transaksi'] },
  { pattern: /^\/api\/deposits/, resources: ['Transaksi'] },
  { pattern: /^\/api\/transactions/, resources: ['Transaksi'] },

  { pattern: /^\/api\/guest-profiles/, resources: ['Pelanggan'] },
  { pattern: /^\/api\/guests/, resources: ['Pelanggan'] },

  { pattern: /^\/api\/housekeeping/, resources: ['Housekeeping'] },

  { pattern: /^\/api\/hr(\/|$)/, resources: ['HRD'] },
  { pattern: /^\/api\/hrd/, resources: ['HRD'] },
  { pattern: /^\/api\/schedule/, resources: ['HRD'] },
  { pattern: /^\/api\/users/, resources: ['HRD'] },

  { pattern: /^\/api\/attendance/, resources: ['Employee Mobile'] },

  { pattern: /^\/api\/pos\/menu\/items/, resources: ['Master Produk'] },
  { pattern: /^\/api\/pos\/menu(\/|$)/, resources: ['POS', 'Master Produk'] },
  { pattern: /^\/api\/pos/, resources: ['POS'] },

  { pattern: /^\/api\/rooms\/[^/]+\/status$/, resources: ['Kalender', 'Housekeeping', 'Master Kamar'] },
  { pattern: /^\/api\/room-categories/, resources: ['Kalender', 'Master Kamar'], methods: ['GET', 'HEAD'] },
  { pattern: /^\/api\/room-types/, resources: ['Kalender', 'Master Kamar'], methods: ['GET', 'HEAD'] },
  { pattern: /^\/api\/rooms/, resources: ['Kalender', 'Master Kamar'], methods: ['GET', 'HEAD'] },
  { pattern: /^\/api\/room-categories/, resources: ['Master Kamar'] },
  { pattern: /^\/api\/room-types/, resources: ['Master Kamar'] },
  { pattern: /^\/api\/rooms/, resources: ['Master Kamar'] },

  { pattern: /^\/api\/reports/, resources: ['Laporan'] },
  { pattern: /^\/api\/accounting/, resources: ['Laporan'] },

  { pattern: /^\/api\/access-control/, resources: ['Pengaturan'] },
  { pattern: /^\/api\/settings/, resources: ['Pengaturan'] },
  { pattern: /^\/api\/front-office/, resources: ['Pengaturan'] },
  { pattern: /^\/api\/properties\/[^/]+\/(branding|features|quick-booking-rules|day-use)/, resources: ['Pengaturan'], methods: ['POST', 'PUT', 'PATCH', 'DELETE'] },

  { pattern: /^\/api\/reservations/, resources: ['Kalender'] },
  { pattern: /^\/api\/bookings/, resources: ['Kalender'] },
  { pattern: /^\/api\/availability/, resources: ['Kalender'] },
  { pattern: /^\/api\/tapechart/, resources: ['Kalender'] },
  { pattern: /^\/api\/room-operational-blocks/, resources: ['Kalender'] },
  { pattern: /^\/api\/identity/, resources: ['Kalender'] },
  { pattern: /^\/api\/ocr/, resources: ['Kalender'] },
  { pattern: /^\/api\/maintenance/, resources: ['Kalender'] },
];

const SKIP_PATTERNS = [
  /^\/api\/auth(\/|$)/,
  /^\/api\/access-control\/me$/,
  /^\/api\/access-control\/resources$/,
  /^\/api\/events$/,
  /^\/api\/properties\/?$/,
  /^\/api\/properties\/\d+$/,
];

function cleanPath(url: string): string {
  return (url || '').split('?')[0];
}

export function inferAccessAction(method: string, path: string): AccessAction {
  const verb = (method || 'GET').toUpperCase();
  if (verb === 'GET' || verb === 'HEAD') return 'view';
  if (verb === 'DELETE') return 'delete';
  if (verb === 'POST' && VIEW_LIKE_POST.some(pattern => pattern.test(path))) return 'view';
  if (DELETE_LIKE.some(pattern => pattern.test(path))) return 'delete';
  return 'edit';
}

export function matchOperationalAccessRule(
  path: string,
  method: string
): { resources: string[]; action: AccessAction } | null {
  const verb = (method || 'GET').toUpperCase();
  for (const rule of OPERATIONAL_ACCESS_RULES) {
    if (!rule.pattern.test(path)) continue;
    if (rule.methods && !rule.methods.includes(verb)) continue;
    return {
      resources: rule.resources,
      action: rule.action || inferAccessAction(verb, path),
    };
  }
  return null;
}

export function shouldSkipOperationalAccessGuard(path: string): boolean {
  return SKIP_PATTERNS.some(pattern => pattern.test(path));
}

/**
 * Fail-closed guard for Hak Akses navigation resources.
 * Unmapped routes are left untouched for their existing helpers.
 */
export function createOperationalAccessGuard(pool: Pool) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const path = cleanPath(req.originalUrl || req.url || '');
    if (!path.startsWith('/api/')) {
      next();
      return;
    }
    if (shouldSkipOperationalAccessGuard(path)) {
      next();
      return;
    }

    const matched = matchOperationalAccessRule(path, req.method);
    if (!matched) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        status: 'ERROR',
        code: 'UNAUTHORIZED',
        message: 'Akses ditolak. Silakan login terlebih dahulu.',
      });
      return;
    }

    try {
      const user = verifyToken(authHeader.split(' ')[1]);
      (req as any).user = user;

      const propertyId = Number(user.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        res.status(403).json({
          status: 'ERROR',
          code: 'PROPERTY_SCOPE_REQUIRED',
          message: 'Akses ditolak: akun tidak terkait properti yang valid.',
        });
        return;
      }

      const allowed = await hasAnyEffectivePermission(
        pool,
        propertyId,
        Number(user.id),
        matched.resources,
        matched.action
      );
      if (!allowed) {
        res.status(403).json({
          status: 'ERROR',
          code: 'FORBIDDEN',
          message: `Akses ditolak. Akun Anda tidak memiliki hak akses ${matched.action.toUpperCase()} pada '${matched.resources.join(', ')}'.`,
        });
        return;
      }
      next();
    } catch (err: any) {
      if (err?.name === 'JsonWebTokenError' || err?.name === 'TokenExpiredError') {
        res.status(401).json({
          status: 'ERROR',
          code: 'INVALID_TOKEN',
          message: 'Sesi login telah kedaluwarsa atau token tidak valid. Silakan login kembali.',
        });
        return;
      }
      const statusCode = err.statusCode || 500;
      res.status(statusCode).json({
        status: 'ERROR',
        code: err.code || 'ACCESS_CONTROL_ERROR',
        message: err.message || 'Gagal memverifikasi hak akses.',
      });
    }
  };
}

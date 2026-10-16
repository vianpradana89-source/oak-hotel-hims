import { Router, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { isPlatformSuperAdmin } from '../auth/authService';
import { requireEffectiveAccess } from '../settings/accessControlMiddleware';
import { hasAnyEffectivePermission } from '../settings/accessControlService';
import {
  getPosCommunicationSettings,
  updatePosCommunicationSettings,
  PosCommunicationSettingsError,
} from './posCommunicationSettingsService';
import type { PosCommunicationSettingsData } from './posCommunicationSettingsTypes';

/**
 * POS Communication Settings router.
 *
 * Mounted at:  /api/pos/communication-settings
 *
 * GET / ΓÇö read-only.
 *   Permission: `POS` view OR `Pengaturan` view OR `Dokumen & Print` view
 *   (POS:view mirrors the /api/pos/payment-config runtime-config pattern;
 *   Pengaturan/Dokumen & Print retained for settings UI consumption).
 *
 * PUT / ΓÇö upsert settings + audit log (single transaction).
 *   Permission: `Pengaturan` edit.
 *
 * Property scope: `property_id` resolved from req.query or req.body,
 * cross-checked against the authenticated user's property token
 * (Platform Super Admin bypasses via isPlatformSuperAdmin).
 *
 * Response contract (both GET and PUT):
 *   data: { whatsapp_enabled, whatsapp_intro_message, whatsapp_closing_message }
 */

const MODULE = '[POS COMM SETTINGS]';

/**
 * Error handler ΓÇö mirrors the paymentError pattern from propertyPaymentInstructionsRouter.
 * Handles both PosCommunicationSettingsError (service layer) and errors thrown
 * by scopedCommProperty (Object.assign(new Error(...), {statusCode, code})).
 */
function commSettingsError(res: Response, err: unknown): void {
  const e = err as { statusCode?: number; code?: string; message?: string };
  const statusCode = Number(e?.statusCode) || 500;
  if (statusCode >= 500) {
    console.error(MODULE, 'unhandled:', err);
    res.status(500).json({
      status: 'ERROR',
      code: 'INTERNAL_ERROR',
      message: 'Pengaturan komunikasi POS belum dapat diproses.',
    });
    return;
  }
  res.status(statusCode).json({
    status: 'ERROR',
    code: e?.code || 'VALIDATION_ERROR',
    message: e?.message || 'Validasi gagal.',
  });
}

/**
 * Resolve and verify target property_id from query/body.
 * - Missing/invalid property_id ΓåÆ 400 VALIDATION_ERROR
 * - Cross-property access (non-super-admin) ΓåÆ 403 PROPERTY_SCOPE_REQUIRED
 */
async function scopedCommProperty(req: AuthenticatedRequest, pool: Pool): Promise<number> {
  const raw = req.query.property_id ?? req.body?.property_id;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error('property_id wajib integer positif.'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (
    !req.user ||
    (!await isPlatformSuperAdmin(pool, req.user.id) &&
      Number(req.user.property_id) !== id)
  ) {
    throw Object.assign(new Error('Tidak memiliki akses ke properti ini.'), {
      statusCode: 403,
      code: 'PROPERTY_SCOPE_REQUIRED',
    });
  }
  return id;
}

/**
 * View gate: allows users who have effective `view` permission on `POS`,
 * `Pengaturan`, or `Dokumen & Print` (mirrors the POS:view pattern of
 * /api/pos/payment-config, since communication settings are runtime config
 * consumed by the POS receipt workflow).
 */
function commSettingsView(pool: Pool) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        res.status(403).json({
          status: 'ERROR',
          code: 'FORBIDDEN',
          message: 'Tidak memiliki izin membaca pengaturan komunikasi POS.',
        });
        return;
      }
      if (await isPlatformSuperAdmin(pool, req.user.id)) {
        next();
        return;
      }
      if (
        !await hasAnyEffectivePermission(
          pool,
          Number(req.user.property_id),
          req.user.id,
          ['POS', 'Pengaturan', 'Dokumen & Print'],
          'view',
        )
      ) {
        res.status(403).json({
          status: 'ERROR',
          code: 'FORBIDDEN',
          message: 'Tidak memiliki izin membaca pengaturan komunikasi POS.',
        });
        return;
      }
      next();
    } catch (err) {
      commSettingsError(res, err);
    }
  };
}

export function createPosCommunicationSettingsRouter(pool: Pool): Router {
  const router = Router();

  const handleGet = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const propertyId = await scopedCommProperty(req, pool);
      const record = await getPosCommunicationSettings(pool, propertyId);
      const data: PosCommunicationSettingsData = {
        whatsapp_enabled: record.whatsapp_enabled,
        whatsapp_intro_message: record.whatsapp_intro_message,
        whatsapp_closing_message: record.whatsapp_closing_message,
      };
      res.status(200).json({ status: 'OK', data });
    } catch (err) {
      commSettingsError(res, err);
    }
  };

  const handlePut = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const propertyId = await scopedCommProperty(req, pool);
      const actorName = req.user?.username || req.user?.full_name || null;
      const actorUserId = req.user?.id?.toString() || null;
      const updated = await updatePosCommunicationSettings(
        pool,
        propertyId,
        req.body || {},
        actorName,
        actorUserId,
      );
      const data: PosCommunicationSettingsData = {
        whatsapp_enabled: updated.whatsapp_enabled,
        whatsapp_intro_message: updated.whatsapp_intro_message,
        whatsapp_closing_message: updated.whatsapp_closing_message,
      };
      res.status(200).json({
        status: 'OK',
        message: 'Pengaturan komunikasi POS berhasil disimpan.',
        data,
      });
    } catch (err) {
      commSettingsError(res, err);
    }
  };

  // GET ΓÇö read-only; tri-resource view gate (POS | Pengaturan | Dokumen & Print)
  router.get('/', requireAuth, commSettingsView(pool), handleGet);

  // PUT ΓÇö upsert + audit; strict Pengaturan:edit gate; property scope enforced in handler
  router.put('/', requireAuth, requireEffectiveAccess(pool, 'Pengaturan', 'edit'), handlePut);

  return router;
}

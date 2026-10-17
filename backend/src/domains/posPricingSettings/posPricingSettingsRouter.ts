import { Router, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { isPlatformSuperAdmin } from '../auth/authService';
import { requireEffectiveAccess } from '../settings/accessControlMiddleware';
import { hasAnyEffectivePermission } from '../settings/accessControlService';
import {
  getPosPricingSettings,
  updatePosPricingSettings,
  PosPricingSettingsError,
} from './posPricingSettingsService';
import type { PosPricingSettingsData } from './posPricingSettingsTypes';

/**
 * POS Pricing Settings router.
 *
 * Mounted at:  /api/pos/pricing-settings
 *
 * GET / — read-only.
 *   Permission: `POS` view OR `Pengaturan` view OR `Dokumen & Print` view
 *   (POS:view mirrors the /api/pos/payment-config runtime-config pattern;
 *   Pengaturan/Dokumen & Print retained for settings UI consumption).
 *   Returns in-memory defaults if no row exists for the property (no INSERT).
 *
 * PUT / — upsert settings + audit log (single transaction).
 *   Permission: `Pengaturan` edit.
 *
 * Property scope: `property_id` resolved from req.query or req.body,
 * cross-checked against the authenticated user's property token
 * (Platform Super Admin bypasses via isPlatformSuperAdmin).
 *
 * Response contract (both GET and PUT):
 *   data: {
 *     service_charge_enabled: boolean,
 *     service_charge_percent: number,
 *     tax_enabled: boolean,
 *     tax_percent: number
 *   }
 */

const MODULE = '[POS PRICING SETTINGS]';

/**
 * Error handler — mirrors the paymentError pattern from propertyPaymentInstructionsRouter.
 * Handles both PosPricingSettingsError (service layer) and errors thrown
 * by scopedPricingProperty (Object.assign(new Error(...), {statusCode, code})).
 */
function pricingSettingsError(res: Response, err: unknown): void {
  const e = err as { statusCode?: number; code?: string; message?: string };
  const statusCode = Number(e?.statusCode) || 500;
  if (statusCode >= 500) {
    console.error(MODULE, 'unhandled:', err);
    res.status(500).json({
      status: 'ERROR',
      code: 'INTERNAL_ERROR',
      message: 'Pengaturan pricing POS belum dapat diproses.',
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
 * - Missing/invalid property_id → 400 VALIDATION_ERROR
 * - Cross-property access (non-super-admin) → 403 PROPERTY_SCOPE_REQUIRED
 */
async function scopedPricingProperty(req: AuthenticatedRequest, pool: Pool): Promise<number> {
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
 * /api/pos/payment-config, since pricing settings are runtime config
 * consumed by the POS order workflow).
 */
function pricingSettingsView(pool: Pool) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        res.status(403).json({
          status: 'ERROR',
          code: 'FORBIDDEN',
          message: 'Tidak memiliki izin membaca pengaturan pricing POS.',
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
          message: 'Tidak memiliki izin membaca pengaturan pricing POS.',
        });
        return;
      }
      next();
    } catch (err) {
      pricingSettingsError(res, err);
    }
  };
}

export function createPosPricingSettingsRouter(pool: Pool): Router {
  const router = Router();

  const handleGet = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const propertyId = await scopedPricingProperty(req, pool);
      const record = await getPosPricingSettings(pool, propertyId);
      const data: PosPricingSettingsData = {
        service_charge_enabled: record.service_charge_enabled,
        service_charge_percent: record.service_charge_percent,
        tax_enabled: record.tax_enabled,
        tax_percent: record.tax_percent,
      };
      res.status(200).json({ status: 'OK', data });
    } catch (err) {
      pricingSettingsError(res, err);
    }
  };

  const handlePut = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const propertyId = await scopedPricingProperty(req, pool);
      const actorName = req.user?.username || req.user?.full_name || null;
      const actorUserId = req.user?.id?.toString() || null;
      const updated = await updatePosPricingSettings(
        pool,
        propertyId,
        req.body || {},
        actorName,
        actorUserId,
      );
      const data: PosPricingSettingsData = {
        service_charge_enabled: updated.service_charge_enabled,
        service_charge_percent: updated.service_charge_percent,
        tax_enabled: updated.tax_enabled,
        tax_percent: updated.tax_percent,
      };
      res.status(200).json({
        status: 'OK',
        message: 'Pengaturan pricing POS berhasil disimpan.',
        data,
      });
    } catch (err) {
      pricingSettingsError(res, err);
    }
  };

  // GET — read-only; tri-resource view gate (POS | Pengaturan | Dokumen & Print)
  router.get('/', requireAuth, pricingSettingsView(pool), handleGet);

  // PUT — upsert + audit; strict Pengaturan:edit gate; property scope enforced in handler
  router.put('/', requireAuth, requireEffectiveAccess(pool, 'Pengaturan', 'edit'), handlePut);

  return router;
}

import { Router, type Response } from 'express';
import type { Pool } from 'pg';
import { requireAuth } from '../auth/authMiddleware';
import { isPlatformSuperAdmin } from '../auth/authService';
import { normalizeRole } from './guestService';
import type { AuthUserPayload } from '../auth/authService';
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  prepareWhatsAppCommunication,
  markWhatsAppOpened,
  getCommunicationHistory,
} from './guestCommunicationService';
import type {
  GuestCommunicationTemplateCreateInput,
  GuestCommunicationTemplateUpdateInput,
  PrepareCommunicationInput,
  CommunicationHistoryFilters,
  ActorSnapshot,
  GuestCommunicationScope,
  GuestCommunicationCategory,
  GuestCommunicationStatus,
} from './guestCommunicationTypes';

// ─── Route helpers ───────────────────────────────────────────────────────────

function positiveInt(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw Object.assign(new Error(`${field} must be a positive integer`), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  return parsed;
}

/**
 * Correlation ID sourced from request header, never from body.
 * Falls back to a deterministic synthetic ID when absent.
 */
function correlationId(req: any): string {
  return String(
    (req.headers?.['x-correlation-id'] as string | undefined) ||
    `CORR-${Date.now()}`
  );
}

async function propertyIdFor(req: any, pool: Pool): Promise<number> {
  const requested = positiveInt(
    req.body?.property_id ?? req.query?.property_id,
    'property_id'
  );
  // Normalize token-side property_id to number for strict comparison
  const tokenPropertyId = Number((req.user as AuthUserPayload | undefined)?.property_id);
  if (!Number.isFinite(tokenPropertyId) || tokenPropertyId <= 0) {
    throw Object.assign(new Error('Invalid user property_id in token'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (requested !== tokenPropertyId) {
    const userId = (req.user as AuthUserPayload | undefined)?.id;
    const isSuperAdmin = userId ? await isPlatformSuperAdmin(pool, userId) : false;
    if (!isSuperAdmin) {
      throw Object.assign(new Error('Cross-property access is not allowed'), {
        statusCode: 403,
        code: 'CROSS_PROPERTY_ACCESS',
      });
    }
  }
  return requested;
}

function actorFor(req: any): ActorSnapshot {
  const user = req.user as AuthUserPayload;
  return {
    userId: user.id,
    name: user.full_name,
    role: normalizeRole(user.role),
  };
}

function sendError(res: Response, error: unknown): Response {
  const e = error as { statusCode?: number; status?: number; code?: string; message?: string };
  const statusCode = Number(e?.statusCode || e?.status || 500);
  return res.status(statusCode).json({
    success: false,
    code: e?.code || 'INTERNAL_ERROR',
    message: e?.message || 'Internal server error',
  });
}

/**
 * Strictly validates is_active query parameter:
 * accepts only the literal strings "true" and "false".
 * Rejects 1, yes, abc, numeric values, etc.
 */
function parseIsActiveQuery(value: unknown): boolean | null {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  const s = String(value).trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  throw Object.assign(new Error('is_active must be "true" or "false"'), {
    statusCode: 400,
    code: 'VALIDATION_ERROR',
  });
}

// ─── Router factory ──────────────────────────────────────────────────────────

export function createGuestCommunicationRouter(pool: Pool) {
  const router = Router();

  // GET /communication-templates
  router.get('/communication-templates', requireAuth, async (req: any, res: Response) => {
    try {
      const property_id = await propertyIdFor(req, pool);
      const scopeRaw = req.query?.scope as string | undefined;
      const categoryRaw = req.query?.category as string | undefined;
      const isActiveRaw = req.query?.is_active;

      let scope: GuestCommunicationScope | null = null;
      if (scopeRaw !== undefined && scopeRaw !== null && String(scopeRaw).trim() !== '') {
        scope = scopeRaw as GuestCommunicationScope;
        // Validate scope value against allowed set
        if (!['STAY_OPERATIONAL','CRM_CAMPAIGN','BIRTHDAY','POST_STAY','PROMOTION'].includes(scope)) {
          throw Object.assign(new Error(`Invalid scope: ${scope}`), {
            statusCode: 400, code: 'VALIDATION_ERROR',
          });
        }
      }

      let category: GuestCommunicationCategory | null = null;
      if (categoryRaw !== undefined && categoryRaw !== null && String(categoryRaw).trim() !== '') {
        category = categoryRaw as GuestCommunicationCategory;
        if (!['CHECKOUT_REMINDER','DINNER_PROMO','BREAKFAST_INFO','LAUNDRY_PROMO',
               'LATE_CHECKOUT','BIRTHDAY','PROMOTION','POST_STAY','CUSTOM'].includes(category)) {
          throw Object.assign(new Error(`Invalid category: ${category}`), {
            statusCode: 400, code: 'VALIDATION_ERROR',
          });
        }
      }

      const isActive = parseIsActiveQuery(isActiveRaw);

      const templates = await listTemplates(pool, property_id, scope, category, isActive);
      return res.json({ success: true, data: templates });
    } catch (error) {
      return sendError(res, error);
    }
  });

  // POST /communication-templates
  router.post('/communication-templates', requireAuth, async (req: any, res: Response) => {
    try {
      const property_id = await propertyIdFor(req, pool);
      const actor = actorFor(req);
      const corrId = correlationId(req);

      const input: GuestCommunicationTemplateCreateInput = {
        property_id,
        code: req.body?.code,
        name: req.body?.name,
        scope: req.body?.scope,
        category: req.body?.category,
        message_body: req.body?.message_body,
        allowed_reservation_statuses: req.body?.allowed_reservation_statuses,
        template_variables: req.body?.template_variables,
        display_order: req.body?.display_order,
        is_active: req.body?.is_active,
      };
      const template = await createTemplate(pool, input, actor, corrId);
      return res.status(201).json({ success: true, data: template });
    } catch (error) {
      return sendError(res, error);
    }
  });

  // GET /communication-templates/:templateId
  router.get('/communication-templates/:templateId', requireAuth, async (req: any, res: Response) => {
    try {
      const property_id = await propertyIdFor(req, pool);
      const templateId = positiveInt(req.params.templateId, 'templateId');
      const template = await getTemplate(pool, templateId, property_id);
      return res.json({ success: true, data: template });
    } catch (error) {
      return sendError(res, error);
    }
  });

  // PATCH /communication-templates/:templateId
  router.patch('/communication-templates/:templateId', requireAuth, async (req: any, res: Response) => {
    try {
      const property_id = await propertyIdFor(req, pool);
      const templateId = positiveInt(req.params.templateId, 'templateId');
      const actor = actorFor(req);
      const corrId = correlationId(req);

      const input: GuestCommunicationTemplateUpdateInput = {
        code: req.body?.code,
        name: req.body?.name,
        scope: req.body?.scope,
        category: req.body?.category,
        message_body: req.body?.message_body,
        allowed_reservation_statuses: req.body?.allowed_reservation_statuses,
        template_variables: req.body?.template_variables,
        display_order: req.body?.display_order,
        is_active: req.body?.is_active,
      };
      const template = await updateTemplate(pool, templateId, property_id, input, actor, corrId);
      return res.json({ success: true, data: template });
    } catch (error) {
      return sendError(res, error);
    }
  });

  // POST /communications/prepare-whatsapp
  router.post('/communications/prepare-whatsapp', requireAuth, async (req: any, res: Response) => {
    try {
      const property_id = await propertyIdFor(req, pool);
      const actor = actorFor(req);
      const corrId = correlationId(req);

      const input: PrepareCommunicationInput = {
        property_id,
        guest_id: positiveInt(req.body?.guest_id, 'guest_id'),
        reservation_id: req.body?.reservation_id != null
          ? positiveInt(req.body?.reservation_id, 'reservation_id')
          : null,
        template_id: positiveInt(req.body?.template_id, 'template_id'),
        metadata: req.body?.metadata,
      };
      const result = await prepareWhatsAppCommunication(pool, input, actor, corrId);
      return res.status(201).json({ success: true, data: result });
    } catch (error) {
      return sendError(res, error);
    }
  });

  // POST /communications/:communicationId/opened-whatsapp
  router.post('/communications/:communicationId/opened-whatsapp', requireAuth, async (req: any, res: Response) => {
    try {
      const property_id = await propertyIdFor(req, pool);
      const communicationId = positiveInt(req.params.communicationId, 'communicationId');
      const actor = actorFor(req);
      const corrId = correlationId(req);

      const log = await markWhatsAppOpened(pool, property_id, communicationId, actor, corrId);
      return res.json({ success: true, data: log });
    } catch (error) {
      return sendError(res, error);
    }
  });

  // GET /communication-history
  router.get('/communication-history', requireAuth, async (req: any, res: Response) => {
    try {
      const property_id = await propertyIdFor(req, pool);
      const rawGuestId = req.query?.guest_id;
      const rawReservationId = req.query?.reservation_id;
      const rawTemplateId = req.query?.template_id;
      const rawStatus = req.query?.status;
      const rawLimit = req.query?.limit;
      const rawOffset = req.query?.offset;

      // Validate guest_id if supplied
      const guest_id = rawGuestId != null ? positiveInt(rawGuestId, 'guest_id') : null;
      // Validate reservation_id if supplied
      const reservation_id = rawReservationId != null ? positiveInt(rawReservationId, 'reservation_id') : null;
      // Validate template_id if supplied
      const template_id = rawTemplateId != null ? positiveInt(rawTemplateId, 'template_id') : null;

      // Validate status
      let status: GuestCommunicationStatus | null = null;
      if (rawStatus != null && String(rawStatus).trim() !== '') {
        const s = String(rawStatus).trim() as GuestCommunicationStatus;
        if (s !== 'INITIATED' && s !== 'OPENED_WHATSAPP') {
          throw Object.assign(new Error(`Invalid status: ${s}. Must be INITIATED or OPENED_WHATSAPP`), {
            statusCode: 400, code: 'VALIDATION_ERROR',
          });
        }
        status = s;
      }

      // Validate limit — strict 1..100, no clamping
      const limit = rawLimit != null
        ? (() => {
            const n = Number(rawLimit);
            if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 100) {
              throw Object.assign(new Error('limit must be a finite integer between 1 and 100'), {
                statusCode: 400, code: 'VALIDATION_ERROR',
              });
            }
            return n;
          })()
        : 20;

      // Validate offset
      const offset = rawOffset != null
        ? (() => {
            const n = Number(rawOffset);
            if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
              throw Object.assign(new Error('offset must be a finite integer >= 0'), {
                statusCode: 400, code: 'VALIDATION_ERROR',
              });
            }
            return n;
          })()
        : 0;

      const filters: CommunicationHistoryFilters = {
        property_id,
        guest_id,
        reservation_id,
        template_id,
        status,
        limit,
        offset,
      };

      const result = await getCommunicationHistory(pool, filters);
      return res.json({ success: true, data: result });
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

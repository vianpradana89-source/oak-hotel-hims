import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import {
  getQuickBookingRules,
  updateQuickBookingRules,
  getDayUseDurations,
  createDayUseDuration,
  updateDayUseDuration,
  deleteDayUseDuration
} from './frontOfficeSettingsService';

export function createFrontOfficeSettingsRouter(pool: Pool): Router {
  const router = Router({ mergeParams: true });

  const parsePropertyId = (req: Request): number => {
    const raw = req.params.propertyId || req.params.id || req.query.property_id || req.body?.property_id;
    const num = Number(raw);
    if (!raw || isNaN(num) || num <= 0) {
      return 1; // Default fallback to primary property
    }
    return num;
  };

  // ==========================================================================
  // QUICK BOOKING FIELD RULES
  // ==========================================================================

  // GET /api/properties/:propertyId/quick-booking-rules
  router.get('/:propertyId/quick-booking-rules', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req);
      const data = await getQuickBookingRules(pool, propertyId);
      res.json({ success: true, status: 'OK', data });
    } catch (err: any) {
      res.status(400).json({ success: false, status: 'ERROR', error: err.message });
    }
  });

  // PUT /api/properties/:propertyId/quick-booking-rules
  router.put('/:propertyId/quick-booking-rules', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req);
      const { channel_type, rules, actor_name } = req.body;
      const actor = actor_name || (req as any).user?.username || 'USER';

      if (!channel_type || !['WALK_IN', 'OTA'].includes(channel_type)) {
        return res.status(400).json({ success: false, error: 'channel_type (WALK_IN atau OTA) wajib diisi' });
      }
      if (!rules || typeof rules !== 'object') {
        return res.status(400).json({ success: false, error: 'rules object wajib diisi' });
      }

      const data = await updateQuickBookingRules(pool, propertyId, channel_type, rules, actor);
      res.json({ success: true, status: 'OK', data });
    } catch (err: any) {
      res.status(400).json({ success: false, status: 'ERROR', error: err.message });
    }
  });

  // ==========================================================================
  // DAY USE DURATION PRESETS MASTER
  // ==========================================================================

  // GET /api/properties/:propertyId/day-use-durations
  router.get('/:propertyId/day-use-durations', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req);
      const includeArchived = req.query.include_archived === 'true';
      const data = await getDayUseDurations(pool, propertyId, includeArchived);
      res.json({ success: true, status: 'OK', data });
    } catch (err: any) {
      res.status(400).json({ success: false, status: 'ERROR', error: err.message });
    }
  });

  // POST /api/properties/:propertyId/day-use-durations
  router.post('/:propertyId/day-use-durations', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req);
      const actor = req.body.actor_name || (req as any).user?.username || 'USER';
      const data = await createDayUseDuration(pool, propertyId, req.body, actor);
      res.status(201).json({ success: true, status: 'OK', data });
    } catch (err: any) {
      res.status(400).json({ success: false, status: 'ERROR', error: err.message });
    }
  });

  // PATCH /api/properties/:propertyId/day-use-durations/:id
  router.patch('/:propertyId/day-use-durations/:id', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req);
      const id = Number(req.params.id);
      const actor = req.body.actor_name || (req as any).user?.username || 'USER';
      const data = await updateDayUseDuration(pool, propertyId, id, req.body, actor);
      res.json({ success: true, status: 'OK', data });
    } catch (err: any) {
      res.status(400).json({ success: false, status: 'ERROR', error: err.message });
    }
  });

  // DELETE /api/properties/:propertyId/day-use-durations/:id
  router.delete('/:propertyId/day-use-durations/:id', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req);
      const id = Number(req.params.id);
      const actor = req.body?.actor_name || (req as any).user?.username || 'USER';
      const result = await deleteDayUseDuration(pool, propertyId, id, actor);
      res.json({ success: true, status: 'OK', data: result });
    } catch (err: any) {
      res.status(400).json({ success: false, status: 'ERROR', error: err.message });
    }
  });

  return router;
}

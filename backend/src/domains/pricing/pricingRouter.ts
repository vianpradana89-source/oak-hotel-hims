import { Router, Request, Response } from 'express';
import type { Pool } from 'pg';
import {
  calculatePriceQuote,
  createMealPlan,
  createRatePlan,
  deleteMealPlan,
  deleteRateOverride,
  deleteRatePlan,
  duplicateRatePlan,
  getMealPlanById,
  getPropertyPricingSettings,
  getRateCalendarMatrix,
  getRatePlanById,
  getReservationRateSnapshots,
  listMealPlans,
  listRatePlans,
  setMealPlanActive,
  setRatePlanActive,
  updateMealPlan,
  updatePropertyPricingSettings,
  updateRatePlan,
  upsertRateOverride
} from './pricingService';

export function createPricingRouter(pool: Pool): Router {
  const router = Router();

  // Helper to extract & validate property_id
  function getPropertyId(req: Request): number {
    const raw = req.query.property_id || req.body.property_id || req.headers['x-property-id'];
    const num = Number(raw);
    if (!raw || isNaN(num) || num <= 0) {
      throw new Error('property_id is required and must be a positive integer.');
    }
    return num;
  }

  // ==========================================================================
  // PROPERTY PRICING SETTINGS (Tax & Service Charge)
  // ==========================================================================

  router.get('/settings', async (req: Request, res: Response) => {
    try {
      const propertyId = getPropertyId(req);
      const settings = await getPropertyPricingSettings(pool, propertyId);
      res.json(settings);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to fetch pricing settings' });
    }
  });

  router.patch('/settings', async (req: Request, res: Response) => {
    try {
      const propertyId = getPropertyId(req);
      const actor = (req as any).user?.username || req.body.actor || 'USER';
      const settings = await updatePropertyPricingSettings(pool, propertyId, req.body, actor);
      res.json(settings);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to update pricing settings' });
    }
  });

  // ==========================================================================
  // MEAL PLAN MASTER CRUD & LIFECYCLE
  // ==========================================================================

  router.get('/meal-plans', async (req: Request, res: Response) => {
    try {
      const propertyId = getPropertyId(req);
      const isActive = req.query.is_active !== undefined ? req.query.is_active === 'true' : undefined;
      const includeArchived = req.query.include_archived === 'true';

      const plans = await listMealPlans(pool, propertyId, {
        is_active: isActive,
        include_archived: includeArchived
      });
      res.json(plans);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to list meal plans' });
    }
  });

  router.post('/meal-plans', async (req: Request, res: Response) => {
    try {
      const propertyId = getPropertyId(req);
      const actor = (req as any).user?.username || req.body.actor || 'USER';
      const plan = await createMealPlan(pool, propertyId, req.body, actor);
      res.status(201).json(plan);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to create meal plan' });
    }
  });

  router.get('/meal-plans/:id', async (req: Request, res: Response) => {
    try {
      const propertyId = getPropertyId(req);
      const id = Number(req.params.id);
      const plan = await getMealPlanById(pool, propertyId, id);
      if (!plan) {
        return res.status(404).json({ error: `Meal Plan ${id} not found.` });
      }
      res.json(plan);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to fetch meal plan' });
    }
  });

  router.patch('/meal-plans/:id', async (req: Request, res: Response) => {
    try {
      const propertyId = getPropertyId(req);
      const id = Number(req.params.id);
      const actor = (req as any).user?.username || req.body.actor || 'USER';
      const plan = await updateMealPlan(pool, propertyId, id, req.body, actor);
      res.json(plan);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to update meal plan' });
    }
  });

  router.patch('/meal-plans/:id/status', async (req: Request, res: Response) => {
    try {
      const propertyId = getPropertyId(req);
      const id = Number(req.params.id);
      const { is_active } = req.body;
      if (is_active === undefined) {
        return res.status(400).json({ error: 'is_active is required.' });
      }
      const actor = (req as any).user?.username || req.body.actor || 'USER';
      const plan = await setMealPlanActive(pool, propertyId, id, Boolean(is_active), actor);
      res.json(plan);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to update meal plan status' });
    }
  });

  router.delete('/meal-plans/:id', async (req: Request, res: Response) => {
    try {
      const propertyId = getPropertyId(req);
      const id = Number(req.params.id);
      const actor = (req as any).user?.username || req.body.actor || 'USER';
      const result = await deleteMealPlan(pool, propertyId, id, actor);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to delete meal plan' });
    }
  });

  // ==========================================================================
  // RATE PLAN CRUD
  // ==========================================================================

  router.get('/rate-plans', async (req: Request, res: Response) => {
    try {
      const propertyId = getPropertyId(req);
      const roomTypeId = req.query.room_type_id ? Number(req.query.room_type_id) : undefined;
      const isActive = req.query.is_active !== undefined ? req.query.is_active === 'true' : undefined;
      const includeArchived = req.query.include_archived === 'true';

      const plans = await listRatePlans(pool, propertyId, {
        room_type_id: roomTypeId,
        is_active: isActive,
        include_archived: includeArchived
      });
      res.json(plans);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to list rate plans' });
    }
  });

  router.post('/rate-plans', async (req: Request, res: Response) => {
    try {
      const propertyId = getPropertyId(req);
      const actor = (req as any).user?.username || req.body.actor || 'USER';
      const plan = await createRatePlan(pool, propertyId, req.body, actor);
      res.status(201).json(plan);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to create rate plan' });
    }
  });

  router.get('/rate-plans/:id', async (req: Request, res: Response) => {
    try {
      const propertyId = getPropertyId(req);
      const id = Number(req.params.id);
      const plan = await getRatePlanById(pool, propertyId, id);
      if (!plan) {
        return res.status(404).json({ error: `Rate Plan ${id} not found.` });
      }
      res.json(plan);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to get rate plan' });
    }
  });

  router.patch('/rate-plans/:id', async (req: Request, res: Response) => {
    try {
      const propertyId = getPropertyId(req);
      const id = Number(req.params.id);
      const actor = (req as any).user?.username || req.body.actor || 'USER';
      const plan = await updateRatePlan(pool, propertyId, id, req.body, actor);
      res.json(plan);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to update rate plan' });
    }
  });

  router.post('/rate-plans/:id/duplicate', async (req: Request, res: Response) => {
    try {
      const propertyId = getPropertyId(req);
      const id = Number(req.params.id);
      const actor = (req as any).user?.username || req.body.actor || 'USER';
      const plan = await duplicateRatePlan(pool, propertyId, id, req.body, actor);
      res.status(201).json(plan);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to duplicate rate plan' });
    }
  });

  router.patch('/rate-plans/:id/status', async (req: Request, res: Response) => {
    try {
      const propertyId = getPropertyId(req);
      const id = Number(req.params.id);
      const isActive = Boolean(req.body.is_active);
      const actor = (req as any).user?.username || req.body.actor || 'USER';
      const plan = await setRatePlanActive(pool, propertyId, id, isActive, actor);
      res.json(plan);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to update rate plan status' });
    }
  });

  router.delete('/rate-plans/:id', async (req: Request, res: Response) => {
    try {
      const propertyId = getPropertyId(req);
      const id = Number(req.params.id);
      const actor = (req as any).user?.username || req.body.actor || 'USER';
      const result = await deleteRatePlan(pool, propertyId, id, actor);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to delete rate plan' });
    }
  });

  // ==========================================================================
  // RATE CALENDAR & OVERRIDES
  // ==========================================================================

  router.get('/rate-plans/:id/calendar', async (req: Request, res: Response) => {
    try {
      const propertyId = getPropertyId(req);
      const id = Number(req.params.id);
      const startDate = req.query.start_date as string;
      const endDate = req.query.end_date as string;

      if (!startDate || !endDate) {
        return res.status(400).json({ error: 'start_date and end_date are required (YYYY-MM-DD).' });
      }

      const matrix = await getRateCalendarMatrix(pool, propertyId, id, startDate, endDate);
      res.json(matrix);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to get rate calendar' });
    }
  });

  router.post('/rate-plans/:id/overrides', async (req: Request, res: Response) => {
    try {
      const propertyId = getPropertyId(req);
      const ratePlanId = Number(req.params.id);
      const actor = (req as any).user?.username || req.body.actor || 'USER';
      const override = await upsertRateOverride(pool, propertyId, ratePlanId, req.body, actor);
      res.status(201).json(override);
    } catch (err: any) {
      if (err.message && err.message.includes('bertabrakan')) {
        return res.status(409).json({ error: err.message, collision: true });
      }
      res.status(400).json({ error: err.message || 'Failed to create rate override' });
    }
  });

  router.delete('/rate-overrides/:id', async (req: Request, res: Response) => {
    try {
      const propertyId = getPropertyId(req);
      const id = Number(req.params.id);
      const actor = (req as any).user?.username || req.body.actor || 'USER';
      const result = await deleteRateOverride(pool, propertyId, id, actor);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to delete rate override' });
    }
  });

  // ==========================================================================
  // AUTHORITATIVE PRICE QUOTE
  // ==========================================================================

  const handlePriceQuote = async (req: Request, res: Response) => {
    try {
      const propertyId = getPropertyId(req);
      const room_type_id = req.body?.room_type_id || req.query?.room_type_id;
      const rate_plan_id = req.body?.rate_plan_id || req.query?.rate_plan_id;
      const check_in = req.body?.check_in || req.query?.check_in;
      const check_out = req.body?.check_out || req.query?.check_out;
      const stay_type = req.body?.stay_type || req.query?.stay_type;
      const adults = req.body?.adults || req.query?.adults;
      const children = req.body?.children || req.query?.children;

      if (!room_type_id || !check_in || !check_out) {
        return res.status(400).json({ error: 'room_type_id, check_in, and check_out are required.' });
      }

      const quote = await calculatePriceQuote(pool, {
        property_id: propertyId,
        room_type_id: Number(room_type_id),
        rate_plan_id: rate_plan_id ? Number(rate_plan_id) : undefined,
        check_in: String(check_in),
        check_out: String(check_out),
        stay_type: stay_type || 'OVERNIGHT',
        adults: adults ? Number(adults) : undefined,
        children: children ? Number(children) : undefined
      });

      res.json({ success: true, data: quote, ...quote });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to calculate price quote' });
    }
  };

  router.post('/quote', handlePriceQuote);
  router.get('/quote', handlePriceQuote);

  // ==========================================================================
  // RESERVATION NIGHTLY SNAPSHOTS
  // ==========================================================================

  router.get('/reservations/:id/rate-snapshots', async (req: Request, res: Response) => {
    try {
      const reservationId = Number(req.params.id);
      const snapshots = await getReservationRateSnapshots(pool, reservationId);
      res.json(snapshots);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to fetch reservation rate snapshots' });
    }
  });

  return router;
}

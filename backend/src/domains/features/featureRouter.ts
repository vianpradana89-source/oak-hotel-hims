import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { getPropertyFeatures, setFeatureFlag, setBatchFeatureFlags } from './featureService';

export function createFeatureRouter(pool: Pool): Router {
  const router = Router({ mergeParams: true });

  const parsePropertyId = (val: any): number => {
    const pId = Number(val);
    if (!Number.isInteger(pId) || pId <= 0) {
      throw Object.assign(new Error('Property ID is required and must be positive integer'), {
        statusCode: 400,
        code: 'INVALID_PROPERTY_ID',
      });
    }
    return pId;
  };

  // 1. Get all feature flags for property
  router.get('/:propertyId/features', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.params.propertyId);
      const features = await getPropertyFeatures(pool, propertyId);
      res.json({ status: 'OK', data: features });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  // 2. Batch update feature flags for property
  router.patch('/:propertyId/features', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.params.propertyId);
      const updates = req.body.features || req.body;
      if (!updates || typeof updates !== 'object') {
        return res.status(400).json({ status: 'ERROR', code: 'INVALID_PAYLOAD', message: 'Features object is required' });
      }

      const actorName = req.body.actor_name || req.body.updated_by || 'Staff';
      const updatedFeatures = await setBatchFeatureFlags(pool, propertyId, updates, actorName);
      res.json({ status: 'OK', data: updatedFeatures });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  // 3. Single key update
  router.patch('/:propertyId/features/:featureKey', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.params.propertyId);
      const featureKey = req.params.featureKey;
      const { enabled, actor_name } = req.body;

      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ status: 'ERROR', code: 'INVALID_ENABLED_VALUE', message: 'enabled boolean is required' });
      }

      const record = await setFeatureFlag(pool, propertyId, featureKey, enabled, actor_name);
      res.json({ status: 'OK', data: record });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  return router;
}

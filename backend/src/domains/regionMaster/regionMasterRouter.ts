import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../auth/authMiddleware';
import { listProvinces, listRegencies, searchRegencies } from './regionMasterService';

const INTERNAL_ERROR_MSG = 'Terjadi kesalahan pada region master.';

function normalizeLimit(raw: string | undefined): number {
  if (raw == null) return 20;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return 20;
  return Math.min(n, 50);
}

function normalizeQuery(raw: string | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed.length < 2) return null;
  if (trimmed.length > 100) return trimmed.slice(0, 100);
  return trimmed;
}

export function createRegionMasterRouter(pool: Pool): Router {
  const router = Router();

  // SECURITY: all /api/regions endpoints require authenticated user
  router.use(requireAuth);

  // GET /api/regions/provinces — list all provinces
  router.get('/provinces', async (_req: Request, res: Response) => {
    try {
      const provinces = await listProvinces(pool);
      return res.json({ success: true, data: provinces });
    } catch (err: any) {
      console.error('[RegionMasterRouter] /provinces error:', err.message);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: INTERNAL_ERROR_MSG });
    }
  });

  // GET /api/regions/regencies?province_bps_code=XX — list regencies for a province
  router.get('/regencies', async (req: Request, res: Response) => {
    try {
      const provinceBpsCode = req.query.province_bps_code as string | undefined;
      const regencies = await listRegencies(pool, provinceBpsCode);
      return res.json({ success: true, data: regencies });
    } catch (err: any) {
      console.error('[RegionMasterRouter] /regencies error:', err.message);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: INTERNAL_ERROR_MSG });
    }
  });

  // GET /api/regions/regencies/search?q=...&limit=20 — search regencies by name
  router.get('/regencies/search', async (req: Request, res: Response) => {
    try {
      const q = normalizeQuery(req.query.q as string | undefined);
      if (q === null) {
        return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'Parameter q minimal 2 karakter' });
      }
      const limit = normalizeLimit(req.query.limit as string | undefined);
      const results = await searchRegencies(pool, q, limit);
      return res.json({ success: true, data: results });
    } catch (err: any) {
      console.error('[RegionMasterRouter] /regencies/search error:', err.message);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: INTERNAL_ERROR_MSG });
    }
  });

  return router;
}

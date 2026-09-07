import { Router } from 'express';
import type { Pool } from 'pg';
import { requireAuth, type AuthenticatedRequest } from '../auth/authMiddleware';
import {
  ReservationSpecialRequestsError,
  updateReservationSpecialRequests,
} from './reservationSpecialRequests';

export function createReservationSpecialRequestsRouter(pool: Pool) {
  const router = Router();

  router.patch('/:id/special-requests', requireAuth, async (req: AuthenticatedRequest, res) => {
    const client = await pool.connect();
    try {
      const reservationId = Number(req.params.id);
      const propertyId = Number(req.body?.property_id ?? req.query?.property_id);
      await client.query('BEGIN');
      const result = await updateReservationSpecialRequests(client, {
        reservationId,
        propertyId,
        specialRequests: req.body?.special_requests,
        actor: req.user?.username || req.user?.full_name || 'PMS',
        correlationId: String(req.headers['x-correlation-id'] || req.headers['X-Correlation-Id'] || '') || null,
      });
      await client.query('COMMIT');
      res.json({ status: 'SUCCESS', data: result.reservation, unchanged: result.unchanged });
    } catch (error: any) {
      await client.query('ROLLBACK').catch(() => {});
      const statusCode = Number(error?.statusCode || (error instanceof ReservationSpecialRequestsError ? error.statusCode : 500));
      res.status(statusCode).json({
        status: statusCode >= 500 ? 'ERROR' : 'ERROR',
        code: error?.code || 'INTERNAL_ERROR',
        message: String(error?.message || 'Gagal memperbarui catatan reservasi.'),
      });
    } finally {
      client.release();
    }
  });

  return router;
}

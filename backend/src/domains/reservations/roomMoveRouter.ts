import { Router } from 'express';
import type { Pool } from 'pg';
import { requireAuth, type AuthenticatedRequest } from '../auth/authMiddleware';
import { executeRoomMove, getRoomMoveAvailability, getRoomMoveHistory, previewRoomMove } from './roomMoveService';

export function createRoomMoveRouter(pool: Pool, broadcastEvent?: (eventType: string, payload: any, propertyId?: number) => void) {
  const router = Router();
  const allowed = [requireAuth];

  router.get('/reservations/:id/room-move-availability', ...allowed, async (req: AuthenticatedRequest, res) => {
    try {
      const data = await getRoomMoveAvailability(pool, Number(req.params.id), Number(req.query.property_id));
      res.json({ status: 'OK', data });
    } catch (error: any) {
      res.status(error.statusCode || 400).json({ status: 'ERROR', code: error.code, message: error.message });
    }
  });
  router.get('/reservations/:id/room-moves', ...allowed, async (req: AuthenticatedRequest, res) => {
    try {
      const data = await getRoomMoveHistory(pool, Number(req.params.id), Number(req.query.property_id));
      res.json({ status: 'OK', data });
    } catch (error: any) {
      res.status(error.statusCode || 400).json({ status: 'ERROR', code: error.code, message: error.message });
    }
  });
  router.post('/reservations/:id/room-move-preview', ...allowed, async (req: AuthenticatedRequest, res) => {
    try {
      const data = await previewRoomMove(pool, Number(req.params.id), req.body || {});
      res.json({ status: 'OK', data });
    } catch (error: any) {
      res.status(error.statusCode || 400).json({ status: 'ERROR', code: error.code, message: error.message });
    }
  });
  router.post('/reservations/:id/move', ...allowed, async (req: AuthenticatedRequest, res) => {
    try {
      const data = await executeRoomMove(pool, Number(req.params.id), {
        ...(req.body || {}), idempotency_key: String(req.headers['idempotency-key'] || '') || null
      }, req.user, String(req.headers['x-correlation-id'] || '') || null);
      // Broadcast room move event
      const propertyId = Number(req.body.property_id);
      if (broadcastEvent && Number.isInteger(propertyId) && propertyId > 0) {
        broadcastEvent('ReservationUpdated', {
          reservation_id: data.reservation_id,
          from_room_id: data.from_room_id,
          to_room_id: data.to_room_id,
          operation: 'ROOM_MOVE',
          timestamp: new Date().toISOString()
        }, propertyId);
      }
      // The client refreshes the canonical reservation/tape-chart projections.
      res.json({ status: 'OK', data });
    } catch (error: any) {
      res.status(error.statusCode || 400).json({ status: 'ERROR', code: error.code, message: error.message });
    }
  });
  return router;
}

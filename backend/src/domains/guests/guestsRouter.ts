import { Router } from 'express';
import type { Pool } from 'pg';
import {
  addReservationGuest,
  createGuest,
  deleteReservationGuest,
  getCrmSummary,
  getDuplicateCandidates,
  getGuestById,
  httpError,
  listReservationGuests,
  matchGuest,
  parsePropertyId,
  searchGuests,
  updateGuest,
  updateReservationGuest
} from './guestService';

function getCorrelationId(req: any): string {
  return String(
    (req.headers && req.headers['x-correlation-id']) ||
    req.headers?.['X-Correlation-Id'] ||
    `CORR-${Date.now()}`
  );
}

function handleRouterError(err: any, res: any) {
  const statusCode = Number(err?.statusCode || (err?.status && typeof err.status === 'number' ? err.status : 500));
  const code = err?.code || 'INTERNAL_ERROR';
  const message = String(err?.message || err || 'unknown error');
  return res.status(statusCode).json({
    status: statusCode >= 500 ? 'ERROR' : (statusCode >= 400 && statusCode < 500 ? 'FAIL' : 'ERROR'),
    code,
    message
  });
}

export function createGuestsRouter(pool: Pool) {
  const router = Router();

  // GET /api/guests/crm-summary?property_id=X&hotel_date=YYYY-MM-DD
  router.get('/crm-summary', async (req: any, res: any) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id, 'property_id');
      const hotelDate = typeof req.query.hotel_date === 'string' ? req.query.hotel_date : undefined;
      const summary = await getCrmSummary(pool, propertyId, hotelDate);
      return res.json({
        status: 'SUCCESS',
        data: summary
      });
    } catch (err: any) {
      return handleRouterError(err, res);
    }
  });

  // GET /api/guests/duplicate-candidates?property_id=X
  router.get('/duplicate-candidates', async (req: any, res: any) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id, 'property_id');
      const clusters = await getDuplicateCandidates(pool, propertyId);
      return res.json({
        status: 'SUCCESS',
        data: clusters
      });
    } catch (err: any) {
      return handleRouterError(err, res);
    }
  });

  // GET /api/guests?property_id=X&search=...&limit=...&offset=...&vip_status=...
  router.get('/', async (req: any, res: any) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id, 'property_id');
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const vipStatus = typeof req.query.vip_status === 'string' ? req.query.vip_status : undefined;
      const limit = req.query.limit !== undefined ? Number(req.query.limit) : 50;
      const offset = req.query.offset !== undefined ? Number(req.query.offset) : 0;

      const result = await searchGuests(pool, propertyId, search, limit, offset, vipStatus);
      return res.json({
        status: 'SUCCESS',
        data: result.guests,
        meta: {
          total: result.total,
          limit: Math.max(1, Math.min(limit, 100)),
          offset: Math.max(0, offset)
        }
      });
    } catch (err: any) {
      return handleRouterError(err, res);
    }
  });

  // POST /api/guests/match
  router.post('/match', async (req: any, res: any) => {
    try {
      const propertyId = parsePropertyId(req.body?.property_id, 'property_id');
      const result = await matchGuest(pool, propertyId, {
        name: req.body?.name,
        phone: req.body?.phone,
        email: req.body?.email
      });
      return res.json({
        status: 'SUCCESS',
        data: result
      });
    } catch (err: any) {
      return handleRouterError(err, res);
    }
  });

  // POST /api/guests
  router.post('/', async (req: any, res: any) => {
    try {
      const correlationId = getCorrelationId(req);
      const guest = await createGuest(pool, req.body || {}, correlationId);
      return res.status(201).json({
        status: 'SUCCESS',
        data: guest
      });
    } catch (err: any) {
      return handleRouterError(err, res);
    }
  });

  // GET /api/guests/:id?property_id=X
  router.get('/:id', async (req: any, res: any) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id, 'property_id');
      const guestId = Number(req.params.id);
      if (!Number.isInteger(guestId) || guestId <= 0) {
        throw httpError(400, 'VALIDATION_ERROR', 'invalid guest id');
      }

      const guest = await getGuestById(pool, guestId, propertyId);
      return res.json({
        status: 'SUCCESS',
        data: guest
      });
    } catch (err: any) {
      return handleRouterError(err, res);
    }
  });

  // PATCH /api/guests/:id
  router.patch('/:id', async (req: any, res: any) => {
    try {
      const guestId = Number(req.params.id);
      if (!Number.isInteger(guestId) || guestId <= 0) {
        throw httpError(400, 'VALIDATION_ERROR', 'invalid guest id');
      }
      const correlationId = getCorrelationId(req);
      const guest = await updateGuest(pool, guestId, req.body || {}, correlationId);
      return res.json({
        status: 'SUCCESS',
        data: guest
      });
    } catch (err: any) {
      return handleRouterError(err, res);
    }
  });

  return router;
}

export function createReservationGuestsRouter(pool: Pool) {
  const router = Router({ mergeParams: true });

  // GET /api/reservations/:id/guests?property_id=X
  router.get('/:id/guests', async (req: any, res: any) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id, 'property_id');
      const reservationId = Number(req.params.id);
      if (!Number.isInteger(reservationId) || reservationId <= 0) {
        throw httpError(400, 'VALIDATION_ERROR', 'invalid reservation id');
      }

      const guests = await listReservationGuests(pool, reservationId, propertyId);
      return res.json({
        status: 'SUCCESS',
        data: guests
      });
    } catch (err: any) {
      return handleRouterError(err, res);
    }
  });

  // POST /api/reservations/:id/guests
  router.post('/:id/guests', async (req: any, res: any) => {
    try {
      const reservationId = Number(req.params.id);
      if (!Number.isInteger(reservationId) || reservationId <= 0) {
        throw httpError(400, 'VALIDATION_ERROR', 'invalid reservation id');
      }
      const propertyId = parsePropertyId(req.body?.property_id, 'property_id');
      const correlationId = getCorrelationId(req);

      const relation = await addReservationGuest(pool, reservationId, propertyId, req.body || {}, correlationId);
      return res.status(201).json({
        status: 'SUCCESS',
        data: relation
      });
    } catch (err: any) {
      return handleRouterError(err, res);
    }
  });

  // PATCH /api/reservations/:id/guests/:relationId
  router.patch('/:id/guests/:relationId', async (req: any, res: any) => {
    try {
      const reservationId = Number(req.params.id);
      const relationId = Number(req.params.relationId);
      if (!Number.isInteger(reservationId) || reservationId <= 0) {
        throw httpError(400, 'VALIDATION_ERROR', 'invalid reservation id');
      }
      if (!Number.isInteger(relationId) || relationId <= 0) {
        throw httpError(400, 'VALIDATION_ERROR', 'invalid relation id');
      }
      const propertyId = parsePropertyId(req.body?.property_id, 'property_id');
      const correlationId = getCorrelationId(req);

      const updated = await updateReservationGuest(pool, reservationId, relationId, propertyId, req.body || {}, correlationId);
      return res.json({
        status: 'SUCCESS',
        data: updated
      });
    } catch (err: any) {
      return handleRouterError(err, res);
    }
  });

  // DELETE /api/reservations/:id/guests/:relationId
  router.delete('/:id/guests/:relationId', async (req: any, res: any) => {
    try {
      const reservationId = Number(req.params.id);
      const relationId = Number(req.params.relationId);
      if (!Number.isInteger(reservationId) || reservationId <= 0) {
        throw httpError(400, 'VALIDATION_ERROR', 'invalid reservation id');
      }
      if (!Number.isInteger(relationId) || relationId <= 0) {
        throw httpError(400, 'VALIDATION_ERROR', 'invalid relation id');
      }
      const propertyId = parsePropertyId(req.query.property_id || req.body?.property_id, 'property_id');
      const correlationId = getCorrelationId(req);

      await deleteReservationGuest(pool, reservationId, relationId, propertyId, correlationId);
      return res.json({
        status: 'SUCCESS',
        message: 'relation removed'
      });
    } catch (err: any) {
      return handleRouterError(err, res);
    }
  });

  return router;
}

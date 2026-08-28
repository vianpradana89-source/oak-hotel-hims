import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import {
  getHousekeepingDailyOperations,
  createHousekeepingTask,
  requestCheckoutRoomCheck,
  acknowledgeHousekeepingTask,
  startHousekeepingTask,
  updateTaskChecklistItem,
  completeHousekeepingTask,
  getChecklistTemplates,
  getPropertyHousekeepingSettings,
  updatePropertyHousekeepingSettings
} from './housekeepingService';

function parsePropertyId(raw: any, fieldName = 'property_id'): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const err: any = new Error(`${fieldName} must be a positive integer`);
    err.statusCode = 400;
    err.code = 'INVALID_PROPERTY_ID';
    throw err;
  }
  return parsed;
}

export function createHousekeepingRouter(pool: Pool): Router {
  const router = Router();

  // Helper for assert property
  async function assertPropertyExists(propertyId: number): Promise<void> {
    const res = await pool.query('SELECT id, is_active FROM properties WHERE id = $1', [propertyId]);
    if (!res.rows || res.rows.length === 0) {
      const err: any = new Error(`Property ${propertyId} not found`);
      err.statusCode = 404;
      err.code = 'PROPERTY_NOT_FOUND';
      throw err;
    }
  }

  // 1. Daily Operations & Metrics Board
  router.get('/daily-operations', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      await assertPropertyExists(propertyId);
      const dateStr = String(req.query.date || new Date().toISOString().slice(0, 10));

      const data = await getHousekeepingDailyOperations(pool, propertyId, dateStr);
      res.json({ status: 'OK', data });
    } catch (err: any) {
      console.error('daily-operations route error:', err);
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  // 1b. Legacy/Generic GET /tasks
  router.get('/tasks', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      await assertPropertyExists(propertyId);
      const tasks = await pool.query(
        'SELECT * FROM housekeeping_tasks WHERE property_id = $1 ORDER BY due_at ASC NULLS LAST, created_at DESC',
        [propertyId]
      );
      res.json({ status: 'OK', data: tasks.rows });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  // 2. Single Task Detail
  router.get('/tasks/:id', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      await assertPropertyExists(propertyId);
      const taskId = Number(req.params.id);

      const taskRes = await pool.query('SELECT * FROM housekeeping_tasks WHERE id = $1 AND property_id = $2', [taskId, propertyId]);
      if (!taskRes.rows || taskRes.rows.length === 0) {
        return res.status(404).json({ status: 'ERROR', code: 'TASK_NOT_FOUND', message: 'Task not found' });
      }
      const task = taskRes.rows[0];

      const itemsRes = await pool.query(
        'SELECT * FROM housekeeping_task_checklist_items WHERE task_id = $1 ORDER BY sort_order ASC, id ASC',
        [taskId]
      );
      task.checklist_items = itemsRes.rows;

      res.json({ status: 'OK', data: task });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  // 3. Create Task (Manual room cleaning, FO service request, department task)
  router.post('/tasks', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId);
      await assertPropertyExists(propertyId);

      await client.query('BEGIN');
      const actor = {
        id: req.body.requested_by_user_id || req.body.actor_id,
        name: req.body.requested_by_name || req.body.actor_name || 'Staff',
        role: req.body.requested_by_role || req.body.actor_role || 'Staff'
      };

      const task = await createHousekeepingTask(client, propertyId, req.body, actor);
      await client.query('COMMIT');

      res.status(201).json({ status: 'SUCCESS', data: task });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  // 4. Request Checkout Room Inspection
  router.post('/checkout-room-check', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId);
      await assertPropertyExists(propertyId);

      const reservationId = Number(req.body.reservation_id);
      if (!Number.isInteger(reservationId) || reservationId <= 0) {
        return res.status(400).json({ status: 'ERROR', code: 'INVALID_RESERVATION_ID', message: 'reservation_id is required' });
      }

      let roomId = Number(req.body.room_id);
      if (!Number.isInteger(roomId) || roomId <= 0) {
        const resCheck = await client.query('SELECT room_id FROM reservations WHERE id = $1', [reservationId]);
        if (resCheck.rowCount && resCheck.rows[0].room_id) {
          roomId = Number(resCheck.rows[0].room_id);
        } else {
          return res.status(400).json({ status: 'ERROR', code: 'INVALID_ROOM_ID', message: 'room_id is required or could not be determined from reservation' });
        }
      }

      await client.query('BEGIN');
      const actor = {
        id: req.body.requested_by_user_id || req.body.actor_id,
        name: req.body.requested_by_name || req.body.requested_by_name_snapshot || req.body.actor_name || 'Front Office',
        role: req.body.requested_by_role || req.body.requested_by_role_snapshot || req.body.actor_role || 'Receptionist'
      };

      const task = await requestCheckoutRoomCheck(client, propertyId, reservationId, roomId, actor);
      await client.query('COMMIT');

      res.status(201).json({ status: 'SUCCESS', data: task });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  // 5. Acknowledge Task
  router.patch('/tasks/:id/acknowledge', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId);
      await assertPropertyExists(propertyId);
      const taskId = Number(req.params.id);

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id,
        name: req.body.actor_name || 'Staff',
        role: req.body.actor_role || 'Staff'
      };
      const task = await acknowledgeHousekeepingTask(client, propertyId, taskId, actor);
      await client.query('COMMIT');

      res.json({ status: 'SUCCESS', data: task });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  // 6. Start Task
  router.patch('/tasks/:id/start', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId);
      await assertPropertyExists(propertyId);
      const taskId = Number(req.params.id);

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id,
        name: req.body.actor_name || 'Staff',
        role: req.body.actor_role || 'Staff'
      };
      const task = await startHousekeepingTask(client, propertyId, taskId, actor);
      await client.query('COMMIT');

      res.json({ status: 'SUCCESS', data: task });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  // 7. Update Checklist Item
  router.patch('/tasks/:id/checklist-items/:itemId', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId);
      await assertPropertyExists(propertyId);
      const taskId = Number(req.params.id);
      const itemId = Number(req.params.itemId);

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id,
        name: req.body.actor_name || 'Staff',
        role: req.body.actor_role || 'Staff'
      };
      const item = await updateTaskChecklistItem(
        client,
        propertyId,
        taskId,
        itemId,
        {
          is_completed: req.body.is_completed === true,
          note: req.body.note,
          photo_storage_key: req.body.photo_storage_key
        },
        actor
      );
      await client.query('COMMIT');

      res.json({ status: 'SUCCESS', data: item });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  // 8. Complete Task
  router.patch('/tasks/:id/complete', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId);
      await assertPropertyExists(propertyId);
      const taskId = Number(req.params.id);

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id,
        name: req.body.actor_name || 'Staff',
        role: req.body.actor_role || 'Staff'
      };
      const task = await completeHousekeepingTask(
        client,
        propertyId,
        taskId,
        {
          completion_note: req.body.completion_note,
          inspection_result: req.body.inspection_result,
          issue_type: req.body.issue_type,
          issue_note: req.body.issue_note,
          estimated_charge: req.body.estimated_charge
        },
        actor
      );
      await client.query('COMMIT');

      res.json({ status: 'SUCCESS', data: task });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({
        status: 'ERROR',
        code: err.code || 'INTERNAL',
        message: err.message,
        incomplete_items: err.incomplete_items
      });
    } finally {
      client.release();
    }
  });

  // 9. History
  router.get('/history', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      await assertPropertyExists(propertyId);

      const tasksRes = await pool.query(
        `SELECT t.*, r.room_number, COALESCE(rt.name, r.name) as room_type_name
         FROM housekeeping_tasks t
         LEFT JOIN rooms r ON r.id = t.room_id
         LEFT JOIN room_types rt ON rt.id = r.room_type_id
         WHERE t.property_id = $1 AND t.status IN ('DONE', 'VERIFIED', 'CANCELLED')
         ORDER BY t.completed_at DESC NULLS LAST, t.updated_at DESC
         LIMIT 200`,
        [propertyId]
      );

      res.json({ status: 'OK', data: tasksRes.rows });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  // 10. Checklist Templates
  router.get('/templates', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      await assertPropertyExists(propertyId);

      const templates = await getChecklistTemplates(pool, propertyId);
      res.json({ status: 'OK', data: templates });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  // 11. Property Settings
  router.get('/settings', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      await assertPropertyExists(propertyId);

      const settings = await getPropertyHousekeepingSettings(pool, propertyId);
      res.json({ status: 'OK', data: settings });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  router.patch('/settings', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId);
      await assertPropertyExists(propertyId);

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id,
        name: req.body.actor_name || 'Admin',
        role: req.body.actor_role || 'Admin'
      };
      const settings = await updatePropertyHousekeepingSettings(client, propertyId, req.body, actor);
      await client.query('COMMIT');

      res.json({ status: 'OK', data: settings });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  return router;
}

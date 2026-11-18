import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import {
  getHousekeepingDailyOperations,
  createHousekeepingTask,
  requestCheckoutRoomCheck,
  acknowledgeHousekeepingTask,
  startHousekeepingTask,
  getTaskChecklistItems,
  updateTaskChecklistItem,
  bulkUpdateCategoryChecklistItems,
  completeHousekeepingTask,
  getChecklistTemplates,
  createChecklistTemplate,
  updateChecklistTemplate,
  duplicateChecklistTemplate,
  deleteChecklistTemplate,
  getPropertyHousekeepingSettings,
  updatePropertyHousekeepingSettings,
  updateTaskHistoryRecord,
  archiveHousekeepingTask,
  unarchiveHousekeepingTask,
  getFindingTypes,
  createFindingType,
  updateFindingType,
  reorderFindingTypes,
  createTaskFinding,
  getTaskFindings,
  getRoomActiveFindings,
  getAllFindings,
  resolveFinding,
  verifyFinding,
  addChecklistTemplateItem,
  updateChecklistTemplateItem,
  deleteChecklistTemplateItem,
  reorderChecklistTemplateItems,
  getChecklistTemplateGroups,
  addChecklistTemplateGroup,
  updateChecklistTemplateGroup,
  deleteChecklistTemplateGroup,
  reorderChecklistTemplateGroups,
  repairActiveCleaningChecklistSnapshots,
  reconcileDuplicateActiveCleaningTasks,
  ensureDirtyRoomCleaningTask
} from './housekeepingService';
import { authorizeHousekeepingChecklistMutation } from './assignedCrewChecklistAccess';
import {
  assertRoomTypeBelongsToProperty,
  assertSellableCapacitySafe,
  findActiveRoomBlockOverlap,
  findActiveRoomReservationOverlap,
  getTodayJakartaDate,
  httpError as blockHttpError,
  normalizeHotelDate,
  writeRoomBlockAudit
} from '../roomBlocks/roomOperationalBlocksService';

function parsePropertyId(raw: any, fieldName = 'property_id'): number {
  if (raw === undefined || raw === null || raw === '') {
    const err: any = new Error(`${fieldName} is required`);
    err.statusCode = 400;
    err.code = 'MISSING_PROPERTY_ID';
    throw err;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const err: any = new Error(`${fieldName} must be a positive integer`);
    err.statusCode = 400;
    err.code = 'INVALID_PROPERTY_ID';
    throw err;
  }
  return parsed;
}

export type HousekeepingBroadcastEvent = (
  eventType: string,
  payload: any,
  propertyId?: number
) => void;

export function createHousekeepingRouter(pool: Pool, broadcastEvent?: HousekeepingBroadcastEvent): Router {
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

  async function resolvePropertyId(req: Request, templateId?: number, taskId?: number): Promise<number> {
    const raw = req.body?.property_id || req.body?.propertyId || req.query?.property_id || req.query?.propertyId;
    if (raw !== undefined && raw !== null && raw !== '') {
      return parsePropertyId(raw);
    }
    if (templateId && Number.isInteger(Number(templateId)) && Number(templateId) > 0) {
      const tplRes = await pool.query('SELECT property_id FROM checklist_templates WHERE id = $1', [templateId]);
      if (tplRes.rows && tplRes.rows.length > 0) {
        return Number(tplRes.rows[0].property_id);
      }
    }
    if (taskId && Number.isInteger(Number(taskId)) && Number(taskId) > 0) {
      const taskRes = await pool.query('SELECT property_id FROM housekeeping_tasks WHERE id = $1', [taskId]);
      if (taskRes.rows && taskRes.rows.length > 0) {
        return Number(taskRes.rows[0].property_id);
      }
    }
    const err: any = new Error('property_id is required');
    err.statusCode = 400;
    err.code = 'MISSING_PROPERTY_ID';
    throw err;
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

  // 1b. GET /tasks (Inbox / Active list with query params & legacy isolation)
  router.get('/tasks', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      await assertPropertyExists(propertyId);

      const scope = String(req.query.scope || 'active').toLowerCase();
      const filter = req.query.filter ? String(req.query.filter).toUpperCase() : 'ALL';
      const statusParam = req.query.status ? String(req.query.status).toUpperCase() : null;
      const assignedTo = req.query.assigned_to ? String(req.query.assigned_to).trim() : null;
      const includeArchived = req.query.include_archived === 'true';

      let sql = `
        SELECT
          t.*,
          r.room_number,
          r.status as room_status,
          rt.name as room_type_name
        FROM housekeeping_tasks t
        LEFT JOIN rooms r ON r.id = t.room_id
        LEFT JOIN room_types rt ON rt.id = r.room_type_id
        WHERE t.property_id = $1
      `;
      const params: any[] = [propertyId];

      // 1. Archive filter
      if (!includeArchived) {
        sql += ` AND COALESCE(t.is_archived, FALSE) = FALSE`;
      }

      // 2. Legacy isolation: room operations with room_id IS NULL are strictly excluded from active operational lists
      sql += ` AND (t.room_id IS NOT NULL OR (t.task_category <> 'ROOM_OPERATIONS' AND t.task_type NOT IN ('ROOM_CLEANING', 'TURN_DOWN', 'DEEP_CLEAN', 'MAKEUP', 'STAYOVER_CLEANING', 'VIP_ROOM_PREPARATION', 'FINAL_INSPECTION', 'CHECKOUT_ROOM_CHECK')))`;

      // 3. Scope / Status filter
      if (statusParam) {
        params.push(statusParam);
        sql += ` AND t.status = $${params.length}`;
      } else if (scope === 'active') {
        sql += ` AND t.status IN ('REQUESTED', 'PENDING', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'BLOCKED')`;
      } else if (scope === 'history') {
        sql += ` AND t.status IN ('DONE', 'VERIFIED', 'CANCELLED')`;
      }

      // 4. Operational Filter / Stream Type
      const streamParam = req.query.stream ? String(req.query.stream).toUpperCase() : null;
      if (streamParam === 'CLEANING' || filter === 'CLEANING') {
        sql += ` AND t.room_id IS NOT NULL AND t.task_type = 'ROOM_CLEANING'`;
        if (!statusParam && scope !== 'history') {
          sql += ` AND r.status IN ('VACANT_DIRTY', 'DIRTY', 'CLEANING')`;
        }
      } else if (streamParam === 'CHECKOUT' || filter === 'CHECKOUT_CHECK' || filter === 'CHECKOUT') {
        sql += ` AND t.task_type = 'CHECKOUT_ROOM_CHECK'`;
      } else if (streamParam === 'TASK' || filter === 'TASK') {
        sql += ` AND t.task_type NOT IN ('ROOM_CLEANING', 'CHECKOUT_ROOM_CHECK', 'FINAL_INSPECTION') AND (t.source_type = 'MANUAL' OR t.task_category NOT IN ('ROOM_OPERATIONS', 'CHECKOUT_INSPECTION'))`;
      } else if (filter === 'PRIORITY') {
        sql += ` AND (t.priority IN ('CRITICAL', 'TURNOVER', 'VIP', 'HIGH') OR t.task_type = 'CHECKOUT_ROOM_CHECK')`;
      }

      // 5. Assigned User Filter
      if (assignedTo) {
        params.push(assignedTo);
        sql += ` AND (t.assigned_user_name_snapshot = $${params.length} OR t.assigned_user_name_snapshot IS NULL)`;
      }

      // 6. Urgency Ordering
      if (scope === 'history') {
        sql += `
          ORDER BY
            COALESCE(t.completed_at, t.updated_at, t.created_at) DESC,
            t.id DESC
        `;
      } else {
        sql += `
          ORDER BY
            CASE
              WHEN t.task_type = 'CHECKOUT_ROOM_CHECK' AND t.status IN ('REQUESTED', 'PENDING', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS') THEN 1
              WHEN t.priority = 'TURNOVER' THEN 2
              WHEN t.due_at IS NOT NULL AND t.due_at < NOW() THEN 3
              WHEN t.priority IN ('CRITICAL', 'HIGH', 'VIP') THEN 4
              WHEN t.task_type = 'ROOM_CLEANING' THEN 5
              ELSE 6
            END,
            t.due_at ASC NULLS LAST,
            t.created_at ASC
        `;
      }

      const tasksRes = await pool.query(sql, params);

      // Enforce backend single active cleaning task invariant per physical room
      let taskRows = tasksRes.rows;
      if (scope !== 'history') {
        const canonicalByRoom = new Map<number, any>();
        const otherTasks: any[] = [];
        for (const t of taskRows) {
          if (t.task_type === 'ROOM_CLEANING' && t.room_id) {
            const rid = Number(t.room_id);
            const existing = canonicalByRoom.get(rid);
            if (!existing) {
              canonicalByRoom.set(rid, t);
            } else {
              const statusRank = (s: string) => (s === 'IN_PROGRESS' ? 1 : s === 'ACKNOWLEDGED' ? 2 : s === 'BLOCKED' ? 3 : s === 'ASSIGNED' ? 4 : 5);
              if (statusRank(t.status) < statusRank(existing.status)) {
                canonicalByRoom.set(rid, t);
              }
            }
          } else {
            otherTasks.push(t);
          }
        }
        taskRows = [...Array.from(canonicalByRoom.values()), ...otherTasks];
      }

      // Check checklist summaries
      const taskIds = taskRows.map((t: any) => t.id);
      const checklistSummaryMap = new Map<number, { total: number; completed: number; required_total: number; required_completed: number }>();
      if (taskIds.length > 0) {
        const itemsRes = await pool.query(
          `SELECT task_id, is_completed, is_required FROM housekeeping_task_checklist_items WHERE task_id = ANY($1::int[])`,
          [taskIds]
        );
        for (const item of itemsRes.rows) {
          const tid = Number(item.task_id);
          if (!checklistSummaryMap.has(tid)) {
            checklistSummaryMap.set(tid, { total: 0, completed: 0, required_total: 0, required_completed: 0 });
          }
          const sum = checklistSummaryMap.get(tid)!;
          sum.total++;
          if (item.is_completed) sum.completed++;
          if (item.is_required) {
            sum.required_total++;
            if (item.is_completed) sum.required_completed++;
          }
        }
      }

      // Same-day arrivals for room metadata
      const todayStr = new Date().toISOString().slice(0, 10);
      const arrivalsRes = await pool.query(
        `SELECT r.id, r.room_id, r.guest_name, r.check_in
         FROM reservations r
         JOIN bookings b ON b.id = r.booking_id
         WHERE b.property_id = $1
           AND r.status = 'BOOKED'
           AND r.check_in::date = $2::date`,
        [propertyId, todayStr]
      );
      const arrivalMap = new Map<number, any>();
      for (const arr of arrivalsRes.rows) {
        if (arr.room_id) arrivalMap.set(Number(arr.room_id), arr);
      }

      const enriched = taskRows.map((t: any) => {
        const arr = t.room_id ? arrivalMap.get(Number(t.room_id)) : null;
        return {
          ...t,
          next_arrival: arr ? {
            reservation_id: arr.id,
            guest_name: arr.guest_name,
            check_in: arr.check_in,
            expected_arrival_time: '14:00'
          } : null,
          checklist_summary: checklistSummaryMap.get(Number(t.id)) || { total: 0, completed: 0, required_total: 0, required_completed: 0 }
        };
      });

      res.json({ status: 'OK', data: enriched });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  // 2. Single Task Detail
  router.get('/tasks/:id', async (req: Request, res: Response) => {
    try {
      const taskId = Number(req.params.id);
      const propertyId = await resolvePropertyId(req, undefined, taskId);
      await assertPropertyExists(propertyId);

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

  // 2b. Reconciled Workstream Counts
  router.get('/workstream-counts', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      await assertPropertyExists(propertyId);

      const [cleaningRes, checkoutRes, taskRes, historyRes] = await Promise.all([
        pool.query(`
          SELECT COUNT(DISTINCT t.room_id)::int AS count FROM housekeeping_tasks t
          LEFT JOIN rooms r ON r.id = t.room_id
          WHERE t.property_id = $1
            AND COALESCE(t.is_archived, FALSE) = FALSE
            AND t.status IN ('REQUESTED', 'PENDING', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'BLOCKED')
            AND t.room_id IS NOT NULL
            AND t.task_type = 'ROOM_CLEANING'
            AND r.status IN ('VACANT_DIRTY', 'DIRTY', 'CLEANING')
        `, [propertyId]),
        pool.query(`
          SELECT COUNT(*)::int AS count FROM housekeeping_tasks t
          WHERE t.property_id = $1
            AND COALESCE(t.is_archived, FALSE) = FALSE
            AND (t.room_id IS NOT NULL OR (t.task_category <> 'ROOM_OPERATIONS' AND t.task_type NOT IN ('ROOM_CLEANING', 'TURN_DOWN', 'DEEP_CLEAN', 'MAKEUP', 'STAYOVER_CLEANING', 'VIP_ROOM_PREPARATION', 'FINAL_INSPECTION', 'CHECKOUT_ROOM_CHECK')))
            AND t.status IN ('REQUESTED', 'PENDING', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'BLOCKED')
            AND t.task_type = 'CHECKOUT_ROOM_CHECK'
        `, [propertyId]),
        pool.query(`
          SELECT COUNT(*)::int AS count FROM housekeeping_tasks t
          WHERE t.property_id = $1
            AND COALESCE(t.is_archived, FALSE) = FALSE
            AND (t.room_id IS NOT NULL OR (t.task_category <> 'ROOM_OPERATIONS' AND t.task_type NOT IN ('ROOM_CLEANING', 'TURN_DOWN', 'DEEP_CLEAN', 'MAKEUP', 'STAYOVER_CLEANING', 'VIP_ROOM_PREPARATION', 'FINAL_INSPECTION', 'CHECKOUT_ROOM_CHECK')))
            AND t.status IN ('REQUESTED', 'PENDING', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'BLOCKED')
            AND t.task_type NOT IN ('ROOM_CLEANING', 'CHECKOUT_ROOM_CHECK', 'FINAL_INSPECTION')
            AND (t.source_type = 'MANUAL' OR t.task_category NOT IN ('ROOM_OPERATIONS', 'CHECKOUT_INSPECTION'))
        `, [propertyId]),
        pool.query(`
          SELECT COUNT(*)::int AS count FROM housekeeping_tasks t
          WHERE t.property_id = $1
            AND COALESCE(t.is_archived, FALSE) = FALSE
            AND (t.room_id IS NOT NULL OR (t.task_category <> 'ROOM_OPERATIONS' AND t.task_type NOT IN ('ROOM_CLEANING', 'TURN_DOWN', 'DEEP_CLEAN', 'MAKEUP', 'STAYOVER_CLEANING', 'VIP_ROOM_PREPARATION', 'FINAL_INSPECTION', 'CHECKOUT_ROOM_CHECK')))
            AND t.status IN ('DONE', 'VERIFIED', 'CANCELLED')
        `, [propertyId])
      ]);

      res.json({
        status: 'OK',
        data: {
          cleaning: Number(cleaningRes.rows[0]?.count || 0),
          checkout: Number(checkoutRes.rows[0]?.count || 0),
          task: Number(taskRes.rows[0]?.count || 0),
          history: Number(historyRes.rows[0]?.count || 0)
        }
      });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    }
  });

  // 2c. Dashboard Checkout Inspections Panel
  router.get('/checkout-inspections', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      await assertPropertyExists(propertyId);

      const limit = Math.min(Number(req.query.limit) || 20, 50);

      const tasksRes = await pool.query(`
        SELECT
          t.*,
          r.room_number,
          r.status as room_status,
          rt.name as room_type_name,
          res.guest_name,
          res.booking_id,
          res.check_in,
          res.check_out
        FROM housekeeping_tasks t
        LEFT JOIN rooms r ON r.id = t.room_id
        LEFT JOIN room_types rt ON rt.id = r.room_type_id
        LEFT JOIN reservations res ON res.id = t.reservation_id
        WHERE t.property_id = $1
          AND t.task_type = 'CHECKOUT_ROOM_CHECK'
          AND COALESCE(t.is_archived, FALSE) = FALSE
        ORDER BY
          CASE
            WHEN t.status IN ('REQUESTED', 'PENDING', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS') THEN 1
            ELSE 2
          END,
          t.created_at DESC
        LIMIT $2
      `, [propertyId, limit]);

      const taskIds = tasksRes.rows.map((r: any) => r.id);
      const checklistSummaryMap = new Map<number, { total: number; completed: number; required_total: number; required_completed: number }>();
      const findingsMap = new Map<number, any[]>();

      if (taskIds.length > 0) {
        const itemsRes = await pool.query(
          `SELECT * FROM housekeeping_task_checklist_items WHERE task_id = ANY($1::int[]) ORDER BY sort_order ASC, id ASC`,
          [taskIds]
        );

        for (const item of itemsRes.rows) {
          const tid = Number(item.task_id);
          if (!checklistSummaryMap.has(tid)) {
            checklistSummaryMap.set(tid, { total: 0, completed: 0, required_total: 0, required_completed: 0 });
          }
          const sum = checklistSummaryMap.get(tid)!;
          sum.total++;
          if (item.is_completed) sum.completed++;
          if (item.is_required) {
            sum.required_total++;
            if (item.is_completed) sum.required_completed++;
          }

          if (item.note || item.photo_storage_key) {
            if (!findingsMap.has(tid)) {
              findingsMap.set(tid, []);
            }
            findingsMap.get(tid)!.push({
              finding_type: item.label,
              notes: item.note,
              photo_storage_key: item.photo_storage_key,
              is_checklist_item: true
            });
          }
        }
      }

      let pendingCount = 0;
      const inspections = tasksRes.rows.map((t: any) => {
        const isPending = ['REQUESTED', 'PENDING', 'ASSIGNED'].includes(t.status);
        const isInProgress = ['ACKNOWLEDGED', 'IN_PROGRESS'].includes(t.status);
        const isClear = t.status === 'DONE' && t.inspection_result === 'CLEAR';
        const isIssue = t.status === 'DONE' && t.inspection_result === 'ISSUE_FOUND';

        if (['REQUESTED', 'PENDING', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS'].includes(t.status)) {
          pendingCount++;
        }

        let displayStatus = t.status;
        if (isPending) displayStatus = 'MENUNGGU';
        else if (isInProgress) displayStatus = 'SEDANG DICEK';
        else if (isClear) displayStatus = '✓ AMAN';
        else if (isIssue) displayStatus = '⚠ ADA TEMUAN';

        const findings = findingsMap.get(Number(t.id)) || [];
        if (t.issue_type) {
          findings.unshift({
            finding_type: t.issue_type,
            notes: t.issue_note,
            estimated_charge: t.estimated_charge ? Number(t.estimated_charge) : 0
          });
        }

        return {
          ...t,
          display_status: displayStatus,
          checklist_summary: checklistSummaryMap.get(Number(t.id)) || { total: 0, completed: 0, required_total: 0, required_completed: 0 },
          findings
        };
      });

      res.json({
        status: 'OK',
        data: {
          pending_count: pendingCount,
          total_count: inspections.length,
          inspections
        }
      });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL_ERROR', message: err.message });
    }
  });

  // 3. Create Task (Standard / Automatic)
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

      res.status(201).json({ status: 'OK', success: true, data: task });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  // 3b. Create Manual Management Task (HOD / GM / Owner / Admin only)
  router.post('/manual-tasks', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId);
      await assertPropertyExists(propertyId);

      const creatorRole = req.body.requested_by_role || req.body.actor_role || req.body.creator_role || '';
      const creatorName = req.body.requested_by_name || req.body.actor_name || req.body.creator_name || 'Management';
      const creatorId = req.body.requested_by_user_id || req.body.actor_id || null;

      const isAuthorized = (
        creatorRole.toUpperCase().includes('HOD') ||
        creatorRole.toUpperCase().includes('HEAD') ||
        creatorRole.toUpperCase().includes('SUPERVISOR') ||
        creatorRole.toUpperCase().includes('GM') ||
        creatorRole.toUpperCase().includes('GENERAL MANAGER') ||
        creatorRole.toUpperCase().includes('OWNER') ||
        creatorRole.toUpperCase().includes('ADMIN') ||
        creatorRole.toUpperCase().includes('MANAGER') ||
        creatorRole.toUpperCase().includes('DIRECTOR')
      );

      if (!isAuthorized) {
        return res.status(403).json({
          status: 'ERROR',
          code: 'UNAUTHORIZED_TASK_CREATOR',
          message: 'Hanya HOD, Supervisor, General Manager, atau Owner yang memiliki wewenang membuat tugas manual.'
        });
      }

      if (!req.body.title || !String(req.body.title).trim()) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'TITLE_REQUIRED',
          message: 'Judul tugas manual wajib diisi.'
        });
      }

      await client.query('BEGIN');
      const payload = {
        ...req.body,
        task_category: 'DEPARTMENT_TASK',
        task_type: req.body.task_type || 'GENERAL_HK_REQUEST',
        source_type: 'MANUAL',
        requested_by_user_id: creatorId,
        requested_by_name_snapshot: creatorName,
        requested_by_role_snapshot: creatorRole
      };

      const actor = {
        id: creatorId,
        name: creatorName,
        role: creatorRole
      };

      const task = await createHousekeepingTask(client, propertyId, payload as any, actor);
      await client.query('COMMIT');

      res.status(201).json({ status: 'OK', success: true, data: task });
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

      // Post-COMMIT realtime projection: canonical inspection state now = REQUESTED.
      // Fire-and-forget; a realtime failure must NOT fail the request.
      const taskId = Number(task?.id);
      const taskRoomId = Number(task?.room_id);
      const taskReservationId = Number(task?.reservation_id || reservationId);
      if (broadcastEvent && Number.isInteger(taskId) && taskId > 0 && Number.isInteger(taskReservationId) && taskReservationId > 0) {
        try {
          broadcastEvent(
            'CheckoutInspectionUpdated',
            {
              reservation_id: taskReservationId,
              room_id: Number.isInteger(taskRoomId) && taskRoomId > 0 ? taskRoomId : null,
              task_id: taskId,
              clearance_state: 'REQUESTED',
              inspection_result: null,
              source: 'FO_REQUEST',
              timestamp: new Date().toISOString()
            },
            propertyId
          );
        } catch (_e) {
          // realtime failure must not surface as a request failure
        }
      }

      res.status(201).json({ status: 'OK', success: true, data: task });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  // 5. Acknowledge Task (Supports PATCH and POST)
  const acknowledgeTaskHandler = async (req: Request, res: Response) => {
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

      res.json({ status: 'OK', success: true, data: task });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  };
  router.patch('/tasks/:id/acknowledge', acknowledgeTaskHandler);
  router.post('/tasks/:id/acknowledge', acknowledgeTaskHandler);

  // 6. Start Task (Supports PATCH and POST)
  const startTaskHandler = async (req: Request, res: Response) => {
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

      res.json({ status: 'OK', success: true, data: task });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  };
  router.patch('/tasks/:id/start', startTaskHandler);
  router.post('/tasks/:id/start', startTaskHandler);

  // 6b. Get Task Checklist Items (supports /tasks/:id/checklist, /tasks/:id/checklist-items, /checklist, /checklist-items)
  const getTaskChecklistHandler = async (req: Request, res: Response) => {
    try {
      const rawTaskId = req.params.id || req.query.task_id || req.query.taskId;
      if (!rawTaskId) {
        return res.json({ status: 'OK', data: [] });
      }
      const taskId = Number(rawTaskId);
      const propertyId = await resolvePropertyId(req, undefined, taskId);
      await assertPropertyExists(propertyId);
      const items = await getTaskChecklistItems(pool, propertyId, taskId);
      res.json({ status: 'OK', data: items });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  };
  router.get('/tasks/:id/checklist', getTaskChecklistHandler);
  router.get('/tasks/:id/checklist-items', getTaskChecklistHandler);
  router.get('/checklist', getTaskChecklistHandler);
  router.get('/checklist-items', getTaskChecklistHandler);

  // 7. Update Checklist Item (supports /tasks/:id/checklist/:itemId, /tasks/:id/checklist-items/:itemId, PATCH and POST)
  const updateChecklistItemHandler = async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const taskId = Number(req.params.id || req.body.task_id || req.body.taskId);
      const propertyId = await resolvePropertyId(req, undefined, taskId);
      await assertPropertyExists(propertyId);
      const itemId = Number(req.params.itemId || req.body.item_id || req.body.itemId);
      const authz = await authorizeHousekeepingChecklistMutation(
        pool,
        (req as any).user,
        propertyId,
        taskId
      );

      await client.query('BEGIN');
      const actor = {
        id: authz.userId,
        name: req.body.actor_name || req.body.checked_by || authz.employeeName || 'Staff',
        role: authz.mode === 'ASSIGNED_CREW' ? 'Employee Mobile' : (req.body.actor_role || 'Staff')
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

      res.json({ status: 'OK', success: true, data: item });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  };

  // 7b. Bulk Update Category Checklist Items (must be declared before :itemId route)
  const bulkUpdateCategoryChecklistHandler = async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const taskId = Number(req.params.id || req.body.task_id || req.body.taskId);
      const propertyId = await resolvePropertyId(req, undefined, taskId);
      await assertPropertyExists(propertyId);
      const authz = await authorizeHousekeepingChecklistMutation(
        pool,
        (req as any).user,
        propertyId,
        taskId
      );

      await client.query('BEGIN');
      const actor = {
        id: authz.userId,
        name: req.body.actor_name || req.body.checked_by || authz.employeeName || 'Staff',
        role: authz.mode === 'ASSIGNED_CREW' ? 'Employee Mobile' : (req.body.actor_role || 'Staff')
      };
      const items = await bulkUpdateCategoryChecklistItems(
        client,
        propertyId,
        taskId,
        {
          category: req.body.category,
          group_name: req.body.group_name,
          group_id: req.body.group_id,
          section: req.body.section,
          item_ids: req.body.item_ids,
          is_completed: req.body.is_completed === true
        },
        actor
      );
      await client.query('COMMIT');

      res.json({ status: 'OK', success: true, data: { updated_items: items, count: items.length } });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  };
  router.patch('/tasks/:id/checklist/bulk-category', bulkUpdateCategoryChecklistHandler);
  router.post('/tasks/:id/checklist/bulk-category', bulkUpdateCategoryChecklistHandler);
  router.patch('/tasks/:id/checklist-items/bulk-category', bulkUpdateCategoryChecklistHandler);
  router.post('/tasks/:id/checklist-items/bulk-category', bulkUpdateCategoryChecklistHandler);

  router.patch('/tasks/:id/checklist-items/:itemId', updateChecklistItemHandler);
  router.post('/tasks/:id/checklist-items/:itemId', updateChecklistItemHandler);
  router.patch('/tasks/:id/checklist/:itemId', updateChecklistItemHandler);
  router.post('/tasks/:id/checklist/:itemId', updateChecklistItemHandler);

  // 8. Complete Task (Supports PATCH and POST)
  const completeTaskHandler = async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId);
      await assertPropertyExists(propertyId);
      const taskId = Number(req.params.id);

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id,
        name: req.body.actor_name || req.body.inspector_name || 'Staff',
        role: req.body.actor_role || 'Staff'
      };
      const task = await completeHousekeepingTask(
        client,
        propertyId,
        taskId,
        {
          completion_note: req.body.completion_note,
          cleaning_note: req.body.cleaning_note,
          inspection_result: req.body.inspection_result,
          issue_type: req.body.issue_type,
          issue_note: req.body.issue_note,
          estimated_charge: req.body.estimated_charge
        },
        actor
      );
      await client.query('COMMIT');

      // Post-COMMIT realtime projection: read canonical room state and broadcast
      // so Calendar/KPI subscribers refresh without waiting for the next poll.
      // A failure here must NOT turn a successful task completion into an error.
      const roomId = Number(task.room_id);
      if (broadcastEvent && Number.isInteger(roomId) && roomId > 0) {
        try {
          const roomRes = await pool.query(
            'SELECT id, status FROM rooms WHERE id = $1 AND property_id = $2',
            [roomId, propertyId]
          );
          const room = roomRes.rows[0];
          if (room && room.status) {
            broadcastEvent(
              'RoomStatusUpdated',
              {
                room_id: roomId,
                status: room.status,
                source: 'HOUSEKEEPING_TASK_COMPLETED',
                task_id: task.id,
                task_type: task.task_type,
                timestamp: new Date().toISOString(),
              },
              propertyId,
            );
          }
        } catch (rtErr: any) {
          console.warn(`[Housekeeping] post-commit RoomStatusUpdated broadcast failed for room ${roomId}: ${rtErr?.message || String(rtErr)}`);
        }
      }

      // Post-COMMIT realtime projection: emit canonical inspection-clearance
      // event ONLY for checkout room checks (RoomStatusUpdated above remains
      // exclusively for canonical room operational state).
      if (broadcastEvent && task.task_type === 'CHECKOUT_ROOM_CHECK') {
        const taskReservationId = Number(task.reservation_id);
        const completedTaskId = Number(task.id);
        if (Number.isInteger(taskReservationId) && taskReservationId > 0 && Number.isInteger(completedTaskId) && completedTaskId > 0) {
          try {
            const inspectionResult = task.inspection_result || 'CLEAR';
            broadcastEvent(
              'CheckoutInspectionUpdated',
              {
                reservation_id: taskReservationId,
                room_id: Number.isInteger(roomId) && roomId > 0 ? roomId : null,
                task_id: completedTaskId,
                clearance_state: inspectionResult === 'ISSUE_FOUND' ? 'ISSUE_FOUND' : 'CLEAR',
                inspection_result: inspectionResult,
                source: 'HOUSEKEEPING_TASK_COMPLETED',
                timestamp: new Date().toISOString(),
              },
              propertyId,
            );
          } catch (rtErr: any) {
            console.warn(`[Housekeeping] post-commit CheckoutInspectionUpdated broadcast failed for task ${completedTaskId}: ${rtErr?.message || String(rtErr)}`);
          }
        }
      }

      res.json({ status: 'OK', success: true, data: task });
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
  };
  router.patch('/tasks/:id/complete', completeTaskHandler);
  router.post('/tasks/:id/complete', completeTaskHandler);
  router.patch('/checkout-inspections/:id/submit', completeTaskHandler);
  router.post('/checkout-inspections/:id/submit', completeTaskHandler);

  // 8b. Legacy/Direct Status Update Compatibility (Supports PATCH and POST)
  const statusUpdateHandler = async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId || req.query.property_id);
      await assertPropertyExists(propertyId);
      const taskId = Number(req.params.id);
      const { status } = req.body;
      const upd = await pool.query(
        `UPDATE housekeeping_tasks SET status = $1, updated_at = NOW() WHERE id = $2 AND property_id = $3 RETURNING *`,
        [status, taskId, propertyId]
      );
      if (!upd.rows.length) {
        const existCheck = await pool.query('SELECT property_id FROM housekeeping_tasks WHERE id = $1', [taskId]);
        if (existCheck.rows.length > 0 && Number(existCheck.rows[0].property_id) !== propertyId) {
          return res.status(403).json({ status: 'ERROR', code: 'CROSS_PROPERTY_FORBIDDEN', message: 'Cross-property task modification forbidden' });
        }
        return res.status(404).json({ status: 'ERROR', code: 'TASK_NOT_FOUND', message: 'Task not found' });
      }
      res.json({ status: 'OK', data: upd.rows[0] });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  };
  router.patch('/tasks/:id/status', statusUpdateHandler);
  router.post('/tasks/:id/status', statusUpdateHandler);

  // 8f. Safe Idempotent Repair of Active Tasks Checklist Snapshots & Duplicate Active Cleaning Tasks
  router.post(['/tasks/repair-checklists', '/tasks/reconcile-duplicates'], async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId || req.query.property_id);
      await assertPropertyExists(propertyId);

      const actor = {
        id: req.body.actor_id ? Number(req.body.actor_id) : undefined,
        name: req.body.actor_name || 'Admin Safe Repair',
        role: req.body.actor_role || 'Admin'
      };

      const result = await repairActiveCleaningChecklistSnapshots(client, propertyId, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', data: result });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  // 8c. History Edit / Safe Correction
  router.patch('/tasks/:id/history-edit', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId);
      await assertPropertyExists(propertyId);
      const taskId = Number(req.params.id);

      const actor = {
        id: req.body.actor_id ? Number(req.body.actor_id) : undefined,
        name: req.body.actor_name || 'Supervisor',
        role: req.body.actor_role || 'Supervisor'
      };

      const updated = await updateTaskHistoryRecord(client, propertyId, taskId, req.body, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', data: updated });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  // 8d. Task Soft Archive
  router.post('/tasks/:id/archive', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId);
      await assertPropertyExists(propertyId);
      const taskId = Number(req.params.id);

      const actor = {
        id: req.body.actor_id ? Number(req.body.actor_id) : undefined,
        name: req.body.actor_name || 'Staff',
        role: req.body.actor_role || 'Staff'
      };

      const updated = await archiveHousekeepingTask(client, propertyId, taskId, req.body.reason, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', data: updated });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  // 8e. Task Unarchive
  router.post('/tasks/:id/unarchive', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId);
      await assertPropertyExists(propertyId);
      const taskId = Number(req.params.id);

      const actor = {
        id: req.body.actor_id ? Number(req.body.actor_id) : undefined,
        name: req.body.actor_name || 'Staff',
        role: req.body.actor_role || 'Staff'
      };

      const updated = await unarchiveHousekeepingTask(client, propertyId, taskId, actor);
      await client.query('COMMIT');
      res.json({ status: 'OK', data: updated });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  // 9. History with Presets & Rich Filters
  router.get('/history', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      await assertPropertyExists(propertyId);

      const conditions: string[] = ['t.property_id = $1'];
      const values: any[] = [propertyId];
      let pIdx = 2;

      // Archive filter
      const includeArchived = req.query.include_archived === 'true' || req.query.includeArchived === 'true';
      if (!includeArchived) {
        conditions.push(`COALESCE(t.is_archived, FALSE) = FALSE`);
      }

      // Status filter (default: terminal statuses)
      if (req.query.status) {
        conditions.push(`t.status = $${pIdx}`);
        values.push(req.query.status);
        pIdx++;
      } else {
        conditions.push(`t.status IN ('DONE', 'VERIFIED', 'CANCELLED')`);
      }

      // Preset / Date filter
      const preset = req.query.preset as string;
      const startDate = req.query.start_date as string;
      const endDate = req.query.end_date as string;

      if (preset === 'today') {
        conditions.push(`(t.completed_at AT TIME ZONE 'Asia/Jakarta')::date = (NOW() AT TIME ZONE 'Asia/Jakarta')::date`);
      } else if (preset === 'yesterday') {
        conditions.push(`(t.completed_at AT TIME ZONE 'Asia/Jakarta')::date = ((NOW() AT TIME ZONE 'Asia/Jakarta')::date - INTERVAL '1 day')::date`);
      } else if (preset === '7days') {
        conditions.push(`(t.completed_at AT TIME ZONE 'Asia/Jakarta')::date >= ((NOW() AT TIME ZONE 'Asia/Jakarta')::date - INTERVAL '7 days')::date`);
      } else if (preset === '30days') {
        conditions.push(`(t.completed_at AT TIME ZONE 'Asia/Jakarta')::date >= ((NOW() AT TIME ZONE 'Asia/Jakarta')::date - INTERVAL '30 days')::date`);
      } else if (preset === 'this_month') {
        conditions.push(`date_trunc('month', t.completed_at AT TIME ZONE 'Asia/Jakarta') = date_trunc('month', NOW() AT TIME ZONE 'Asia/Jakarta')`);
      } else if (startDate || endDate) {
        if (startDate) {
          conditions.push(`(t.completed_at AT TIME ZONE 'Asia/Jakarta')::date >= $${pIdx}::date`);
          values.push(startDate);
          pIdx++;
        }
        if (endDate) {
          conditions.push(`(t.completed_at AT TIME ZONE 'Asia/Jakarta')::date <= $${pIdx}::date`);
          values.push(endDate);
          pIdx++;
        }
      }

      // Other filters
      if (req.query.task_number) {
        conditions.push(`t.task_number ILIKE $${pIdx}`);
        values.push(`%${req.query.task_number}%`);
        pIdx++;
      }
      if (req.query.room_number) {
        conditions.push(`(r.room_number ILIKE $${pIdx} OR t.room_number ILIKE $${pIdx})`);
        values.push(`%${req.query.room_number}%`);
        pIdx++;
      }
      if (req.query.pic) {
        conditions.push(`t.assigned_user_name_snapshot ILIKE $${pIdx}`);
        values.push(`%${req.query.pic}%`);
        pIdx++;
      }
      if (req.query.task_type) {
        conditions.push(`t.task_type = $${pIdx}`);
        values.push(req.query.task_type);
        pIdx++;
      }
      if (req.query.priority) {
        conditions.push(`t.priority = $${pIdx}`);
        values.push(req.query.priority);
        pIdx++;
      }
      if (req.query.inspection_result) {
        conditions.push(`t.inspection_result = $${pIdx}`);
        values.push(req.query.inspection_result);
        pIdx++;
      }
      if (req.query.source_type) {
        conditions.push(`t.source_type = $${pIdx}`);
        values.push(req.query.source_type);
        pIdx++;
      }

      const query = `
        SELECT t.*, r.room_number, COALESCE(rt.name, r.name) as room_type_name
        FROM housekeeping_tasks t
        LEFT JOIN rooms r ON r.id = t.room_id
        LEFT JOIN room_types rt ON rt.id = r.room_type_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY t.completed_at DESC NULLS LAST, t.updated_at DESC
        LIMIT 300
      `;

      const tasksRes = await pool.query(query, values);
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

  // 10b. Create Checklist Template Master
  router.post('/templates', async (req: Request, res: Response) => {
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
      const created = await createChecklistTemplate(client, propertyId, req.body, actor);
      await client.query('COMMIT');

      res.status(201).json({ status: 'OK', data: created });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  // 10c. Update Checklist Template Master
  router.patch('/templates/:templateId', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const templateId = Number(req.params.templateId);
      const propertyId = await resolvePropertyId(req, templateId);
      await assertPropertyExists(propertyId);

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id,
        name: req.body.actor_name || 'Admin',
        role: req.body.actor_role || 'Admin'
      };
      const updated = await updateChecklistTemplate(client, propertyId, templateId, req.body, actor);
      await client.query('COMMIT');

      res.json({ status: 'OK', data: updated });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  // 10d. Duplicate Checklist Template Master
  router.post('/templates/:templateId/duplicate', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const templateId = Number(req.params.templateId);
      const propertyId = await resolvePropertyId(req, templateId);
      await assertPropertyExists(propertyId);

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id,
        name: req.body.actor_name || 'Admin',
        role: req.body.actor_role || 'Admin'
      };
      const duplicated = await duplicateChecklistTemplate(client, propertyId, templateId, actor);
      await client.query('COMMIT');

      res.status(201).json({ status: 'OK', data: duplicated });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  // 10e. Delete / Safe Archive Checklist Template Master
  router.delete('/templates/:templateId', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const templateId = Number(req.params.templateId);
      const propertyId = await resolvePropertyId(req, templateId);
      await assertPropertyExists(propertyId);
      await assertPropertyExists(propertyId);

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id,
        name: req.body.actor_name || 'Admin',
        role: req.body.actor_role || 'Admin'
      };
      const result = await deleteChecklistTemplate(client, propertyId, templateId, actor);
      await client.query('COMMIT');

      res.json({ status: 'OK', data: result });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
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

  const updateSettingsHandler = async (req: Request, res: Response) => {
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
  };
  router.patch('/settings', updateSettingsHandler);
  router.put('/settings', updateSettingsHandler);

  // 12. Finding Types (Jenis Temuan) Catalog
  router.get('/finding-types', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      await assertPropertyExists(propertyId);
      const scope = (req.query.scope === 'active' ? 'active' : 'all') as 'all' | 'active';

      const items = await getFindingTypes(pool, propertyId, { scope });
      res.json({ status: 'OK', data: items });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  router.post('/finding-types', async (req: Request, res: Response) => {
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
      const created = await createFindingType(client, propertyId, req.body, actor);
      await client.query('COMMIT');

      res.status(201).json({ status: 'OK', data: created });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  router.patch('/finding-types/:id', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId || req.query.property_id);
      const id = Number(req.params.id);
      await assertPropertyExists(propertyId);

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id,
        name: req.body.actor_name || 'Admin',
        role: req.body.actor_role || 'Admin'
      };
      const updated = await updateFindingType(client, propertyId, id, req.body, actor);
      await client.query('COMMIT');

      res.json({ status: 'OK', data: updated });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  router.post('/finding-types/reorder', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId);
      await assertPropertyExists(propertyId);
      const itemIds = Array.isArray(req.body.item_ids) ? req.body.item_ids.map(Number) : [];

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id,
        name: req.body.actor_name || 'Admin',
        role: req.body.actor_role || 'Admin'
      };
      const reordered = await reorderFindingTypes(client, propertyId, itemIds, actor);
      await client.query('COMMIT');

      res.json({ status: 'OK', data: reordered });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  // 12b. Task Findings & Blocking Lifecycle
  const getTaskFindingsHandler = async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      await assertPropertyExists(propertyId);
      const rawTaskId = req.params.id || req.query.task_id || req.query.taskId;
      const rawRoomId = req.params.roomId || req.query.room_id || req.query.roomId;

      if (rawTaskId) {
        const taskId = Number(rawTaskId);
        const findings = await getTaskFindings(pool, propertyId, taskId);
        return res.json({ status: 'OK', data: findings || [] });
      }

      if (rawRoomId) {
        const roomId = Number(rawRoomId);
        const findings = await getRoomActiveFindings(pool, propertyId, roomId);
        return res.json({ status: 'OK', data: findings || [] });
      }

      const statusFilter = req.query.status ? String(req.query.status).toUpperCase() : undefined;
      const findings = await getAllFindings(pool, propertyId, statusFilter);
      return res.json({ status: 'OK', data: findings || [] });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  };
  router.get('/tasks/:id/findings', getTaskFindingsHandler);
  router.get('/findings', getTaskFindingsHandler);

  router.get('/rooms/:roomId/findings', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      const roomId = Number(req.params.roomId);
      await assertPropertyExists(propertyId);

      const findings = await getRoomActiveFindings(pool, propertyId, roomId);
      res.json({ status: 'OK', data: findings || [] });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  const createTaskFindingHandler = async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId || req.query.property_id || req.query.propertyId);
      const taskId = Number(req.params.id || req.body.task_id || req.body.taskId);
      await assertPropertyExists(propertyId);

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id,
        name: req.body.actor_name || 'Staff',
        role: req.body.actor_role || 'Staff'
      };
      const created = await createTaskFinding(client, propertyId, taskId, req.body, actor);
      await client.query('COMMIT');

      res.status(201).json({ status: 'OK', data: created });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  };
  router.post('/tasks/:id/findings', createTaskFindingHandler);
  router.post('/findings', createTaskFindingHandler);

  router.patch('/findings/:id/resolve', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId || req.query.property_id);
      const id = Number(req.params.id);
      await assertPropertyExists(propertyId);

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id,
        name: req.body.actor_name || 'Staff',
        role: req.body.actor_role || 'Staff'
      };
      const resolved = await resolveFinding(client, propertyId, id, req.body, actor);
      await client.query('COMMIT');

      res.json({ status: 'OK', data: resolved });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  router.patch('/findings/:id/verify', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId || req.query.property_id);
      const id = Number(req.params.id);
      await assertPropertyExists(propertyId);

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id,
        name: req.body.actor_name || 'Supervisor',
        role: req.body.actor_role || 'Supervisor'
      };
      const verified = await verifyFinding(client, propertyId, id, req.body, actor);
      await client.query('COMMIT');

      res.json({ status: 'OK', data: verified });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  // 13. Template Groups Management (EMP-MOBILE-3F)
  router.get('/templates/:templateId/groups', async (req: Request, res: Response) => {
    try {
      const templateId = Number(req.params.templateId);
      const propertyId = await resolvePropertyId(req, templateId);
      await assertPropertyExists(propertyId);

      const groups = await getChecklistTemplateGroups(pool, propertyId, templateId);
      res.json({ status: 'OK', data: groups });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  router.post('/templates/:templateId/groups', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const templateId = Number(req.params.templateId);
      const propertyId = await resolvePropertyId(req, templateId);
      await assertPropertyExists(propertyId);

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id,
        name: req.body.actor_name || 'Admin',
        role: req.body.actor_role || 'Admin'
      };
      const created = await addChecklistTemplateGroup(client, propertyId, templateId, req.body, actor);
      await client.query('COMMIT');

      res.status(201).json({ status: 'OK', data: created });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  router.patch('/templates/:templateId/groups/:groupId', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const templateId = Number(req.params.templateId);
      const propertyId = await resolvePropertyId(req, templateId);
      const groupId = Number(req.params.groupId);
      await assertPropertyExists(propertyId);

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id,
        name: req.body.actor_name || 'Admin',
        role: req.body.actor_role || 'Admin'
      };
      const updated = await updateChecklistTemplateGroup(client, propertyId, templateId, groupId, req.body, actor);
      await client.query('COMMIT');

      res.json({ status: 'OK', data: updated });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  router.delete('/templates/:templateId/groups/:groupId', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const templateId = Number(req.params.templateId);
      const propertyId = await resolvePropertyId(req, templateId);
      const groupId = Number(req.params.groupId);
      await assertPropertyExists(propertyId);

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id,
        name: req.body.actor_name || 'Admin',
        role: req.body.actor_role || 'Admin'
      };
      const result = await deleteChecklistTemplateGroup(client, propertyId, templateId, groupId, actor);
      await client.query('COMMIT');

      res.json({ status: 'OK', data: result });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  router.post('/templates/:templateId/groups/reorder', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const templateId = Number(req.params.templateId);
      const propertyId = await resolvePropertyId(req, templateId);
      await assertPropertyExists(propertyId);
      const rawGroups = req.body.groups || req.body.group_ids || req.body.groupIds || req.body.items || [];

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id,
        name: req.body.actor_name || 'Admin',
        role: req.body.actor_role || 'Admin'
      };
      const reordered = await reorderChecklistTemplateGroups(client, propertyId, templateId, rawGroups, actor);
      await client.query('COMMIT');

      res.json({ status: 'OK', data: reordered });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  // 14. Template Items Management
  router.post('/templates/:templateId/items', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const templateId = Number(req.params.templateId);
      const propertyId = await resolvePropertyId(req, templateId);
      await assertPropertyExists(propertyId);

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id,
        name: req.body.actor_name || 'Admin',
        role: req.body.actor_role || 'Admin'
      };
      const created = await addChecklistTemplateItem(client, propertyId, templateId, req.body, actor);
      await client.query('COMMIT');

      res.status(201).json({ status: 'OK', data: created });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  router.patch('/templates/:templateId/items/:itemId', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const templateId = Number(req.params.templateId);
      const propertyId = await resolvePropertyId(req, templateId);
      const itemId = Number(req.params.itemId);
      await assertPropertyExists(propertyId);

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id,
        name: req.body.actor_name || 'Admin',
        role: req.body.actor_role || 'Admin'
      };
      const updated = await updateChecklistTemplateItem(client, propertyId, templateId, itemId, req.body, actor);
      await client.query('COMMIT');

      res.json({ status: 'OK', data: updated });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  router.delete('/templates/:templateId/items/:itemId', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const templateId = Number(req.params.templateId);
      const propertyId = await resolvePropertyId(req, templateId);
      const itemId = Number(req.params.itemId);
      await assertPropertyExists(propertyId);

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id,
        name: req.body.actor_name || 'Admin',
        role: req.body.actor_role || 'Admin'
      };
      const result = await deleteChecklistTemplateItem(client, propertyId, templateId, itemId, actor);
      await client.query('COMMIT');

      res.json({ status: 'OK', data: result });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  const reorderItemsHandler = async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const templateId = Number(req.params.templateId);
      const propertyId = await resolvePropertyId(req, templateId);
      await assertPropertyExists(propertyId);
      const rawItems = req.body.items || (Array.isArray(req.body.item_ids) ? req.body.item_ids.map(Number) : []);

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id,
        name: req.body.actor_name || 'Admin',
        role: req.body.actor_role || 'Admin'
      };
      const reordered = await reorderChecklistTemplateItems(client, propertyId, templateId, rawItems, actor);
      await client.query('COMMIT');

      res.json({ status: 'OK', data: reordered });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  };

  router.post('/templates/:templateId/reorder', reorderItemsHandler);
  router.post('/templates/:templateId/items/reorder', reorderItemsHandler);

  // 15. Staff List for Housekeeping PIC Assignment
  router.get('/staff', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId || 1);
      await assertPropertyExists(propertyId);

      const staffNames = new Map<string, { id?: number | null; name: string; role: string; department: string }>();

      // Users table
      try {
        const usersRes = await pool.query(
          `SELECT id, username, full_name, role
           FROM users
           WHERE COALESCE(is_active, TRUE) = TRUE
           ORDER BY COALESCE(NULLIF(TRIM(full_name), ''), username) ASC`
        );
        for (const u of usersRes.rows) {
          const name = String(u.full_name || u.username || '').trim();
          if (!name) continue;
          const key = name.toUpperCase();
          if (!staffNames.has(key)) {
            staffNames.set(key, {
              id: Number(u.id),
              name,
              role: String(u.role || 'Staff'),
              department: 'System User'
            });
          }
        }
      } catch (_e) { /* ignore if users table schema differs */ }

      // HR Employees table
      try {
        const empRes = await pool.query(
          `SELECT id, user_id, name, role, department
           FROM hr_employees
           WHERE COALESCE(property_id, $1) = $1
             AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
           ORDER BY name ASC`,
          [propertyId]
        );
        for (const e of empRes.rows) {
          const name = String(e.name || '').trim();
          if (!name) continue;
          const key = name.toUpperCase();
          staffNames.set(key, {
            id: e.user_id ? Number(e.user_id) : null,
            name,
            role: String(e.role || 'Housekeeping'),
            department: String(e.department || 'Housekeeping')
          });
        }
      } catch (_e) { /* ignore if hr_employees table schema differs */ }

      res.json({ status: 'OK', data: Array.from(staffNames.values()) });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  // 16. Assign / Change PIC on Active or Historical Task
  const assignTaskPicHandler = async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const taskId = Number(req.params.id);
      const propertyId = await resolvePropertyId(req, undefined, taskId);
      await assertPropertyExists(propertyId);

      const assignedName = req.body.assigned_user_name_snapshot !== undefined
        ? (req.body.assigned_user_name_snapshot ? String(req.body.assigned_user_name_snapshot).trim() : null)
        : (req.body.assigned_to ? String(req.body.assigned_to).trim() : null);
      const assignedUserId = req.body.assigned_user_id ? Number(req.body.assigned_user_id) : null;
      const actorName = req.body.actor_name || assignedName || 'Staff';

      await client.query('BEGIN');
      const upd = await client.query(
        `UPDATE housekeeping_tasks
         SET assigned_user_name_snapshot = $1,
             assigned_user_id = COALESCE($2, assigned_user_id),
             updated_at = NOW()
         WHERE id = $3 AND property_id = $4
         RETURNING *`,
        [assignedName, assignedUserId, taskId, propertyId]
      );
      if (!upd.rows.length) {
        throw Object.assign(new Error('Tugas tidak ditemukan'), { statusCode: 404, code: 'NOT_FOUND' });
      }
      await client.query(
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['HOUSEKEEPING', 'HK_TASK_ASSIGNED', 'HOUSEKEEPING_TASK', String(taskId), JSON.stringify({ assigned_user_name_snapshot: assignedName }), actorName, propertyId]
      );
      await client.query('COMMIT');
      res.json({ status: 'OK', data: upd.rows[0] });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  };
  router.patch('/tasks/:id/assign', assignTaskPicHandler);
  router.post('/tasks/:id/assign', assignTaskPicHandler);

  // 17. Ensure Dirty Room Cleaning Task (1-Click Create/Ensure from Dirty Room)
  router.post('/ensure-dirty-task', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const propertyId = parsePropertyId(req.body.property_id || req.body.propertyId);
      await assertPropertyExists(propertyId);
      const roomId = Number(req.body.room_id);
      if (!Number.isInteger(roomId) || roomId <= 0) {
        return res.status(400).json({ status: 'ERROR', code: 'INVALID_ROOM_ID', message: 'room_id wajib valid' });
      }

      await client.query('BEGIN');
      const actor = {
        id: req.body.actor_id ? Number(req.body.actor_id) : undefined,
        name: req.body.actor_name || 'Staff',
        role: req.body.actor_role || 'Housekeeping'
      };
      const task = await ensureDirtyRoomCleaningTask(client, propertyId, roomId, {
        sourceType: 'HK_MANUAL_SYNC',
        actor
      });
      if (task && actor.name && (!task.assigned_user_name_snapshot || ['HOUSEKEEPING STAFF', 'STAFF', 'SYSTEM'].includes(String(task.assigned_user_name_snapshot).toUpperCase()))) {
        const upd = await client.query(
          `UPDATE housekeeping_tasks SET assigned_user_name_snapshot = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
          [actor.name, task.id]
        );
        if (upd.rows[0]) Object.assign(task, upd.rows[0]);
      }
      await client.query('COMMIT');
      res.json({ status: 'OK', data: task });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  });

  // 18. Housekeeping OO / OOS Room Operational Blocks (Integrated with Calendar & Reports)
  router.get('/room-blocks', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePropertyId(req.query.property_id || req.query.propertyId);
      await assertPropertyExists(propertyId);

      const statusFilter = req.query.status ? String(req.query.status).trim().toUpperCase() : 'ALL';
      const conditions: string[] = ['b.property_id = $1'];
      const params: any[] = [propertyId];

      if (statusFilter !== 'ALL' && ['ACTIVE', 'RELEASED', 'CANCELLED'].includes(statusFilter)) {
        params.push(statusFilter);
        conditions.push(`b.status = $${params.length}`);
      }

      if (req.query.room_id) {
        const rid = Number(req.query.room_id);
        if (Number.isInteger(rid) && rid > 0) {
          params.push(rid);
          conditions.push(`b.room_id = $${params.length}`);
        }
      }

      const result = await pool.query(
        `SELECT b.id, b.property_id, b.room_id, b.room_type_id,
                b.block_type,
                to_char(b.start_date, 'YYYY-MM-DD') AS start_date,
                to_char(b.end_date, 'YYYY-MM-DD') AS end_date,
                GREATEST(0, (b.end_date - b.start_date))::int AS duration_days,
                b.reason, b.maintenance_task_id, b.status,
                b.created_by, b.created_at, b.released_by, b.released_at,
                r.room_number, r.status AS current_room_status,
                rt.code AS room_type_code,
                rt.name AS room_type_name
         FROM room_operational_blocks b
         JOIN rooms r ON r.id = b.room_id
         LEFT JOIN room_types rt ON rt.id = b.room_type_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY
           CASE WHEN b.status = 'ACTIVE' THEN 0 ELSE 1 END ASC,
           b.start_date DESC,
           b.id DESC`,
        params
      );

      res.json({ status: 'OK', data: result.rows });
    } catch (err: any) {
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    }
  });

  router.post('/room-blocks', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const body = req.body || {};
      const propertyId = parsePropertyId(body.property_id || body.propertyId);
      await assertPropertyExists(propertyId);

      const roomId = Number(body.room_id);
      if (!Number.isInteger(roomId) || roomId <= 0) {
        throw blockHttpError(400, 'VALIDATION_ERROR', 'Kamar wajib dipilih.');
      }

      const blockType = String(body.block_type || 'OUT_OF_ORDER').trim().toUpperCase();
      if (!['OUT_OF_ORDER', 'OUT_OF_SERVICE'].includes(blockType)) {
        throw blockHttpError(400, 'VALIDATION_ERROR', 'Tipe blokir wajib OUT_OF_ORDER (OO) atau OUT_OF_SERVICE (OOS).');
      }

      const startDate = normalizeHotelDate(body.start_date);
      const endDate = normalizeHotelDate(body.end_date);
      if (!startDate || !endDate) {
        throw blockHttpError(400, 'VALIDATION_ERROR', 'Tanggal mulai dan tanggal selesai wajib diisi (YYYY-MM-DD).');
      }
      if (endDate <= startDate) {
        throw blockHttpError(400, 'VALIDATION_ERROR', 'Tanggal selesai wajib setelah tanggal mulai (minimal 1 malam).');
      }

      const reason = body.reason ? String(body.reason).trim().slice(0, 255) : 'Ditetapkan OO melalui Housekeeping';
      const createdBy = body.created_by || body.actor_name
        ? String(body.created_by || body.actor_name).trim().slice(0, 100)
        : 'Housekeeping';

      await client.query('BEGIN');

      const roomResult = await client.query('SELECT * FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
      if ((roomResult.rowCount ?? 0) === 0) {
        throw blockHttpError(404, 'ROOM_NOT_FOUND', `Kamar tidak ditemukan.`);
      }
      const room = roomResult.rows[0];
      if (room.property_id != null && Number(room.property_id) !== propertyId) {
        throw blockHttpError(403, 'PROPERTY_MISMATCH', `Kamar tidak berada di properti ini.`);
      }

      const roomTypeId = Number(room.room_type_id);
      if (!Number.isInteger(roomTypeId) || roomTypeId <= 0) {
        throw blockHttpError(409, 'ROOM_HAS_NO_TYPE', `Kamar ${room.room_number} belum memiliki tipe kamar.`);
      }

      const roomType = await assertRoomTypeBelongsToProperty(client, roomTypeId, propertyId);

      const reservationOverlaps = await findActiveRoomReservationOverlap(client, roomId, startDate, endDate);
      if (reservationOverlaps.length > 0) {
        const ov = reservationOverlaps[0];
        throw blockHttpError(
          409,
          'ROOM_HAS_ACTIVE_RESERVATIONS',
          `Kamar ${room.room_number} memiliki reservasi aktif (${ov.guest_name}, ${ov.check_in} s/d ${ov.check_out}) pada rentang tanggal tersebut.`
        );
      }

      const blockOverlaps = await findActiveRoomBlockOverlap(client, roomId, startDate, endDate);
      if (blockOverlaps.length > 0) {
        const b = blockOverlaps[0];
        throw blockHttpError(
          409,
          'OVERLAPPING_BLOCK',
          `Kamar ${room.room_number} sudah memiliki status ${b.block_type} aktif pada tanggal tersebut.`
        );
      }

      await assertSellableCapacitySafe(client, roomTypeId, startDate, endDate);

      const inserted = await client.query(
        `INSERT INTO room_operational_blocks (
           property_id, room_id, room_type_id, block_type,
           start_date, end_date, reason, status, created_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8)
         RETURNING *`,
        [propertyId, roomId, roomTypeId, blockType, startDate, endDate, reason, createdBy]
      );
      const createdBlock = inserted.rows[0];

      // Sync physical room status if the block covers today
      const hotelToday = getTodayJakartaDate();
      if (startDate <= hotelToday && endDate > hotelToday) {
        await client.query(
          `UPDATE rooms SET status = $1 WHERE id = $2 AND property_id = $3`,
          [blockType, roomId, propertyId]
        );
      }

      await writeRoomBlockAudit(client, {
        action: 'CREATE',
        blockId: createdBlock.id,
        newValue: {
          room_id: roomId,
          room_number: room.room_number,
          room_type_id: roomTypeId,
          room_type_code: roomType.code,
          block_type: blockType,
          start_date: startDate,
          end_date: endDate,
          reason,
          created_by: createdBy,
          source: 'HOUSEKEEPING'
        },
        propertyId,
        correlationId: (req.headers['x-correlation-id'] as string) || null
      });

      await client.query('COMMIT');

      if (broadcastEvent) {
        try {
          broadcastEvent(
            'RoomStatusUpdated',
            {
              room_id: roomId,
              status: blockType,
              source: 'HOUSEKEEPING_OO_BLOCK_CREATED',
              block_id: createdBlock.id,
              timestamp: new Date().toISOString()
            },
            propertyId
          );
        } catch (_e) { /* ignore */ }
      }

      res.status(201).json({
        status: 'OK',
        data: {
          ...createdBlock,
          start_date: startDate,
          end_date: endDate,
          room_number: room.room_number,
          room_type_code: roomType.code,
          room_type_name: roomType.name
        }
      });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({
        status: sc === 409 ? 'CONFLICT' : 'ERROR',
        code: err.code || 'INTERNAL',
        message: err.message
      });
    } finally {
      client.release();
    }
  });

  const releaseHkRoomBlockHandler = async (req: Request, res: Response) => {
    const blockId = Number(req.params.id);
    if (!Number.isInteger(blockId) || blockId <= 0) {
      return res.status(400).json({ status: 'ERROR', code: 'VALIDATION_ERROR', message: 'ID blokir kamar tidak valid' });
    }

    const client = await pool.connect();
    try {
      const body = req.body || {};
      const propertyId = parsePropertyId(body.property_id || body.propertyId);
      await assertPropertyExists(propertyId);

      const releasedBy = body.released_by || body.actor_name
        ? String(body.released_by || body.actor_name).trim().slice(0, 100)
        : 'Housekeeping';
      const releaseDate = body.effective_release_date
        ? normalizeHotelDate(body.effective_release_date)
        : getTodayJakartaDate();
      if (!releaseDate) {
        throw blockHttpError(400, 'VALIDATION_ERROR', 'Tanggal pelepasan OO tidak valid');
      }

      const targetRoomStatus = body.target_room_status && ['VACANT_DIRTY', 'VACANT_CLEAN', 'INSPECTED'].includes(String(body.target_room_status).toUpperCase())
        ? String(body.target_room_status).toUpperCase()
        : 'VACANT_DIRTY';

      await client.query('BEGIN');

      const blockResult = await client.query(
        'SELECT * FROM room_operational_blocks WHERE id = $1 FOR UPDATE',
        [blockId]
      );
      if ((blockResult.rowCount ?? 0) === 0) {
        throw blockHttpError(404, 'NOT_FOUND', `Data blokir OO #${blockId} tidak ditemukan`);
      }

      const block = blockResult.rows[0];
      if (Number(block.property_id) !== propertyId) {
        throw blockHttpError(403, 'PROPERTY_MISMATCH', `Blokir kamar tidak berada pada properti ini`);
      }
      if (block.status !== 'ACTIVE') {
        throw blockHttpError(409, 'BLOCK_NOT_ACTIVE', `Blokir kamar sudah berstatus ${block.status}`);
      }

      const blockStart = normalizeHotelDate(block.start_date)!;
      const blockEnd = normalizeHotelDate(block.end_date)!;

      let nextStatus = 'RELEASED';
      let nextEndDate = blockEnd;

      if (releaseDate <= blockStart) {
        nextStatus = 'CANCELLED';
        nextEndDate = blockEnd;
      } else if (releaseDate < blockEnd) {
        nextStatus = 'RELEASED';
        nextEndDate = releaseDate;
      } else {
        nextStatus = 'RELEASED';
        nextEndDate = blockEnd;
      }

      const updated = await client.query(
        `UPDATE room_operational_blocks
         SET status = $1,
             end_date = $2,
             released_by = $3,
             released_at = CURRENT_TIMESTAMP
         WHERE id = $4
         RETURNING *`,
        [nextStatus, nextEndDate, releasedBy, blockId]
      );
      const updatedBlock = updated.rows[0];

      // Update physical room status back to targetRoomStatus (VACANT_DIRTY or VACANT_CLEAN)
      await client.query(
        `UPDATE rooms SET status = $1 WHERE id = $2 AND property_id = $3`,
        [targetRoomStatus, block.room_id, propertyId]
      );

      // If targetRoomStatus is VACANT_DIRTY, automatically ensure an active ROOM_CLEANING task exists
      if (targetRoomStatus === 'VACANT_DIRTY') {
        await ensureDirtyRoomCleaningTask(client, propertyId, Number(block.room_id), {
          sourceType: 'OO_RELEASED',
          sourceEntityId: String(blockId),
          actor: { name: releasedBy }
        });
      }

      await writeRoomBlockAudit(client, {
        action: nextStatus === 'CANCELLED' ? 'CANCEL' : 'RELEASE',
        blockId,
        newValue: {
          before: { status: block.status, start_date: blockStart, end_date: blockEnd },
          after: { status: updatedBlock.status, start_date: blockStart, end_date: nextEndDate, released_by: releasedBy, target_room_status: targetRoomStatus },
          effective_release_date: releaseDate,
          reason: body.reason || null
        },
        propertyId,
        correlationId: (req.headers['x-correlation-id'] as string) || null
      });

      await client.query('COMMIT');

      if (broadcastEvent) {
        try {
          broadcastEvent(
            'RoomStatusUpdated',
            {
              room_id: Number(block.room_id),
              status: targetRoomStatus,
              source: 'HOUSEKEEPING_OO_BLOCK_RELEASED',
              block_id: blockId,
              timestamp: new Date().toISOString()
            },
            propertyId
          );
        } catch (_e) { /* ignore */ }
      }

      res.json({
        status: 'OK',
        data: {
          ...updatedBlock,
          start_date: blockStart,
          end_date: nextEndDate,
          target_room_status: targetRoomStatus
        }
      });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({
        status: sc === 409 ? 'CONFLICT' : 'ERROR',
        code: err.code || 'INTERNAL',
        message: err.message
      });
    } finally {
      client.release();
    }
  };
  router.patch('/room-blocks/:id/release', releaseHkRoomBlockHandler);
  router.post('/room-blocks/:id/release', releaseHkRoomBlockHandler);
  router.patch('/room-blocks/:id/cancel', releaseHkRoomBlockHandler);
  router.post('/room-blocks/:id/cancel', releaseHkRoomBlockHandler);

  return router;
}

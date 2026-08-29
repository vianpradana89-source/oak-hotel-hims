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
  reconcileDuplicateActiveCleaningTasks
} from './housekeepingService';

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

      res.json({ status: 'OK', success: true, data: item });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const sc = err.statusCode || 500;
      res.status(sc).json({ status: 'ERROR', code: err.code || 'INTERNAL', message: err.message });
    } finally {
      client.release();
    }
  };
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

      // If neither task_id nor room_id is specified, return empty array safely (never 404)
      return res.json({ status: 'OK', data: [] });
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

  return router;
}

import { Pool, PoolClient } from 'pg';
import {
  HousekeepingDailyMetrics,
  HousekeepingTaskRecord,
  HkTaskCategory,
  HkTaskType,
  HkTaskPriority,
  HkTaskStatus,
  HkInspectionResult,
  HkIssueType,
  ChecklistTemplate,
  ChecklistTemplateItem,
  TaskChecklistItem,
  PropertyHousekeepingSettings
} from './housekeepingTypes';
import { isFeatureEnabled } from '../features/featureService';

function hasRows(result: any): boolean {
  return Array.isArray(result?.rows) && result.rows.length > 0;
}

export async function getPropertyHousekeepingSettings(
  client: PoolClient | Pool,
  propertyId: number
): Promise<PropertyHousekeepingSettings> {
  const res = await client.query(
    'SELECT * FROM property_housekeeping_settings WHERE property_id = $1',
    [propertyId]
  );
  if (hasRows(res)) {
    return res.rows[0];
  }
  // Default fallback
  const inserted = await client.query(
    `INSERT INTO property_housekeeping_settings (property_id, require_final_inspection, require_checkout_room_check, allow_calendar_room_status_override)
     VALUES ($1, false, false, false)
     ON CONFLICT (property_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [propertyId]
  );
  return inserted.rows[0];
}

export async function updatePropertyHousekeepingSettings(
  client: PoolClient,
  propertyId: number,
  settings: Partial<PropertyHousekeepingSettings>,
  actor?: { id?: number; name?: string; role?: string }
): Promise<PropertyHousekeepingSettings> {
  const current = await getPropertyHousekeepingSettings(client, propertyId);
  const requireFinalInspection = settings.require_final_inspection !== undefined ? settings.require_final_inspection : current.require_final_inspection;
  const requireCheckoutRoomCheck = settings.require_checkout_room_check !== undefined ? settings.require_checkout_room_check : current.require_checkout_room_check;
  const allowCalendarOverride = settings.allow_calendar_room_status_override !== undefined ? settings.allow_calendar_room_status_override : current.allow_calendar_room_status_override;
  const defaultCleaningTemplate = settings.default_cleaning_template_code || current.default_cleaning_template_code;
  const defaultCheckoutTemplate = settings.default_checkout_template_code || current.default_checkout_template_code;

  const res = await client.query(
    `UPDATE property_housekeeping_settings
     SET require_final_inspection = $1,
         require_checkout_room_check = $2,
         allow_calendar_room_status_override = $3,
         default_cleaning_template_code = $4,
         default_checkout_template_code = $5,
         updated_at = NOW()
     WHERE property_id = $6
     RETURNING *`,
    [requireFinalInspection, requireCheckoutRoomCheck, allowCalendarOverride, defaultCleaningTemplate, defaultCheckoutTemplate, propertyId]
  );

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'UPDATE_SETTINGS', 'PROPERTY_SETTINGS', String(propertyId), JSON.stringify(res.rows[0]), actor?.name || 'System', propertyId]
  );

  return res.rows[0];
}

export async function getChecklistTemplates(
  client: PoolClient | Pool,
  propertyId: number
): Promise<ChecklistTemplate[]> {
  const tRes = await client.query(
    `SELECT * FROM checklist_templates WHERE property_id = $1 ORDER BY id ASC`,
    [propertyId]
  );
  const templates: ChecklistTemplate[] = tRes.rows;

  if (templates.length === 0) return [];

  const templateIds = templates.map((t) => t.id);
  const itemsRes = await client.query(
    `SELECT * FROM checklist_template_items WHERE template_id = ANY($1::int[]) ORDER BY sort_order ASC, id ASC`,
    [templateIds]
  );

  const itemsByTemplate: Record<number, ChecklistTemplateItem[]> = {};
  for (const item of itemsRes.rows) {
    if (!itemsByTemplate[item.template_id]) {
      itemsByTemplate[item.template_id] = [];
    }
    itemsByTemplate[item.template_id].push(item);
  }

  return templates.map((t) => ({
    ...t,
    items: itemsByTemplate[t.id] || []
  }));
}

export async function getChecklistTemplateByCode(
  client: PoolClient | Pool,
  propertyId: number,
  code: string
): Promise<ChecklistTemplate | null> {
  const tRes = await client.query(
    `SELECT * FROM checklist_templates WHERE property_id = $1 AND code = $2`,
    [propertyId, code]
  );
  if (!hasRows(tRes)) return null;
  const template: ChecklistTemplate = tRes.rows[0];
  const itemsRes = await client.query(
    `SELECT * FROM checklist_template_items WHERE template_id = $1 ORDER BY sort_order ASC, id ASC`,
    [template.id]
  );
  template.items = itemsRes.rows;
  return template;
}

export async function snapshotTemplateToChecklist(
  client: PoolClient,
  taskId: number,
  propertyId: number,
  templateCode: string
): Promise<TaskChecklistItem[]> {
  const template = await getChecklistTemplateByCode(client, propertyId, templateCode);
  if (!template || !template.items || template.items.length === 0) {
    return [];
  }

  const snapshotItems: TaskChecklistItem[] = [];
  for (const item of template.items) {
    if (!item.is_active) continue;
    const insertRes = await client.query(
      `INSERT INTO housekeeping_task_checklist_items
        (task_id, template_item_id, section, label, sort_order, is_required, requires_note, requires_photo, is_completed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)
       RETURNING *`,
      [taskId, item.id, item.section, item.label, item.sort_order, item.is_required, item.requires_note, item.requires_photo]
    );
    snapshotItems.push(insertRes.rows[0]);
  }
  return snapshotItems;
}

export async function getHousekeepingDailyOperations(
  client: PoolClient | Pool,
  propertyId: number,
  dateStr: string
): Promise<{ metrics: HousekeepingDailyMetrics; tasks: HousekeepingTaskRecord[] }> {
  // 1. Query rooms for property
  const roomsRes = await client.query(
    `SELECT r.id, r.room_number, r.status, r.room_type_id, COALESCE(rt.name, r.name) as room_type_name
     FROM rooms r
     LEFT JOIN room_types rt ON rt.id = r.room_type_id
     WHERE r.property_id = $1
     ORDER BY r.room_number ASC`,
    [propertyId]
  );
  const rooms = roomsRes.rows;
  const roomMap = new Map<number, any>();
  const roomByNumberMap = new Map<string, any>();
  for (const r of rooms) {
    roomMap.set(Number(r.id), r);
    if (r.room_number) {
      roomByNumberMap.set(String(r.room_number).trim(), r);
    }
  }

  // 2. Query today's reservations for arrival / departure / stayover context
  const resQuery = await client.query(
    `SELECT r.id, r.room_id, r.guest_name, r.check_in, r.check_out, r.status, r.stay_status
     FROM reservations r
     JOIN bookings b ON b.id = r.booking_id
     WHERE b.property_id = $1
       AND r.status IN ('BOOKED', 'CHECKED_IN', 'CHECKED_OUT')
       AND NOT (r.check_out < $2::timestamp OR r.check_in >= ($2::timestamp + interval '1 day'))`,
    [propertyId, dateStr]
  );
  const reservations = resQuery.rows;

  const arrivalsByRoom = new Map<number, any>();
  const departuresByRoom = new Map<number, any>();

  for (const r of reservations) {
    if (!r.room_id) continue;
    const ciKey = new Date(r.check_in).toISOString().slice(0, 10);
    const coKey = new Date(r.check_out).toISOString().slice(0, 10);
    if (ciKey === dateStr && r.status === 'BOOKED') {
      arrivalsByRoom.set(Number(r.room_id), r);
    }
    if (coKey === dateStr) {
      departuresByRoom.set(Number(r.room_id), r);
    }
  }

  // 3. Query housekeeping tasks for property
  const tasksRes = await client.query(
    `SELECT t.*
     FROM housekeeping_tasks t
     WHERE t.property_id = $1
     ORDER BY
       CASE
         WHEN t.priority = 'CRITICAL' THEN 1
         WHEN t.priority = 'TURNOVER' THEN 2
         WHEN t.priority = 'VIP' THEN 3
         WHEN t.priority = 'HIGH' THEN 4
         WHEN t.priority = 'NORMAL' THEN 5
         ELSE 6
       END,
       t.due_at ASC NULLS LAST,
       t.created_at DESC`,
    [propertyId]
  );

  const taskIds = tasksRes.rows.map((t: any) => t.id);
  let checklistSummaryMap = new Map<number, { total: number; completed: number; required_total: number; required_completed: number }>();
  let checklistItemsMap = new Map<number, TaskChecklistItem[]>();

  if (taskIds.length > 0) {
    const itemsRes = await client.query(
      `SELECT * FROM housekeeping_task_checklist_items WHERE task_id = ANY($1::int[]) ORDER BY sort_order ASC, id ASC`,
      [taskIds]
    );
    for (const item of itemsRes.rows) {
      const tid = Number(item.task_id);
      if (!checklistItemsMap.has(tid)) {
        checklistItemsMap.set(tid, []);
      }
      checklistItemsMap.get(tid)!.push(item);

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

  const enrichedTasks: HousekeepingTaskRecord[] = tasksRes.rows.map((t: any) => {
    let targetRoom: any = null;
    if (t.room_id) {
      targetRoom = roomMap.get(Number(t.room_id));
    } else if (t.room_number) {
      targetRoom = roomByNumberMap.get(String(t.room_number).trim());
    }

    const roomId = targetRoom ? Number(targetRoom.id) : (t.room_id ? Number(t.room_id) : null);
    const nextArr = roomId ? arrivalsByRoom.get(roomId) : null;

    return {
      ...t,
      room_status: targetRoom ? targetRoom.status : null,
      room_type_name: targetRoom ? targetRoom.room_type_name : null,
      next_arrival: nextArr ? {
        reservation_id: nextArr.id,
        guest_name: nextArr.guest_name,
        check_in: nextArr.check_in,
        expected_arrival_time: '14:00'
      } : null,
      checklist_summary: checklistSummaryMap.get(Number(t.id)) || { total: 0, completed: 0, required_total: 0, required_completed: 0 },
      checklist_items: checklistItemsMap.get(Number(t.id)) || []
    };
  });

  // 4. Calculate operational summary metrics
  let dirtyCount = 0;
  let cleaningCount = 0;
  let vacantCleanCount = 0;
  let inspectedCount = 0;
  let waitingInspectionCount = 0;
  let readyCount = 0;
  let checkoutCheckCount = 0;
  let overdueCount = 0;
  let priorityTurnoverCount = 0;

  for (const r of rooms) {
    const s = String(r.status || '').toUpperCase();
    if (s === 'VACANT_DIRTY' || s === 'OCCUPIED_DIRTY') dirtyCount++;
    else if (s === 'CLEANING') cleaningCount++;
    else if (s === 'VACANT_CLEAN') vacantCleanCount++;
    else if (s === 'INSPECTED') inspectedCount++;
  }
  readyCount = vacantCleanCount + inspectedCount;

  const now = new Date();
  for (const t of enrichedTasks) {
    const isComplete = t.status === 'DONE' || t.status === 'VERIFIED' || t.status === 'CANCELLED';
    if (!isComplete) {
      if (t.task_type === 'CHECKOUT_ROOM_CHECK') checkoutCheckCount++;
      if (t.task_type === 'FINAL_INSPECTION') waitingInspectionCount++;
      if (t.priority === 'TURNOVER') priorityTurnoverCount++;
      if (t.due_at && new Date(t.due_at) < now) overdueCount++;
    }
  }

  return {
    metrics: {
      date: dateStr,
      dirty: dirtyCount,
      cleaning: cleaningCount,
      waiting_inspection: waitingInspectionCount,
      vacant_clean: vacantCleanCount,
      inspected: inspectedCount,
      ready: readyCount,
      checkout_check: checkoutCheckCount,
      overdue: overdueCount,
      priority_turnover: priorityTurnoverCount
    },
    tasks: enrichedTasks
  };
}

export async function generateTaskNumber(client: PoolClient | Pool, propertyId: number): Promise<string> {
  const propRes = await client.query('SELECT property_code FROM properties WHERE id = $1', [propertyId]);
  const code = (propRes.rows[0]?.property_code || 'HOTEL').toUpperCase();
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const dateStr = `${yy}${mm}${dd}`;

  const countRes = await client.query(
    `SELECT COUNT(*)::int as count FROM housekeeping_tasks WHERE property_id = $1 AND task_number LIKE $2`,
    [propertyId, `HK-${code}-${dateStr}-%`]
  );
  const nextSeq = (countRes.rows[0]?.count || 0) + 1;
  return `HK-${code}-${dateStr}-${String(nextSeq).padStart(4, '0')}`;
}

export async function createHousekeepingTask(
  client: PoolClient,
  propertyId: number,
  payload: {
    task_category?: HkTaskCategory;
    task_type: HkTaskType;
    room_id?: number | null;
    room_number?: string | null;
    reservation_id?: number | null;
    guest_id?: number | null;
    title?: string;
    description?: string | null;
    priority?: HkTaskPriority;
    assigned_department?: string;
    assigned_user_id?: number | null;
    assigned_user_name_snapshot?: string | null;
    requested_by_user_id?: number | null;
    requested_by_name_snapshot?: string | null;
    requested_by_role_snapshot?: string | null;
    due_at?: string | null;
    scheduled_at?: string | null;
    source_type?: string;
    source_entity_id?: string | null;
    template_code?: string | null;
  },
  actor?: { id?: number; name?: string; role?: string }
): Promise<HousekeepingTaskRecord> {
  const category: HkTaskCategory = payload.task_category || (
    payload.task_type === 'GUEST_SERVICE_DELIVERY' || payload.task_type === 'DELIVERY_SUPPORT'
      ? 'SERVICE_REQUEST'
      : payload.task_type === 'GENERAL_HK_REQUEST' || payload.task_type === 'INTERNAL_SUPPORT'
      ? 'DEPARTMENT_TASK'
      : 'ROOM_OPERATIONS'
  );

  // Authoritative feature flag checks
  const hkMasterEnabled = await isFeatureEnabled(client, propertyId, 'housekeeping.enabled');
  if (!hkMasterEnabled) {
    throw Object.assign(new Error('Modul Housekeeping sedang dinonaktifkan untuk properti ini.'), { statusCode: 403, code: 'FEATURE_DISABLED' });
  }

  if (category === 'SERVICE_REQUEST') {
    const isServiceEnabled = await isFeatureEnabled(client, propertyId, 'housekeeping.service_requests');
    if (!isServiceEnabled) {
      throw Object.assign(new Error('Fitur Permintaan Layanan Tamu sedang dinonaktifkan.'), { statusCode: 403, code: 'FEATURE_DISABLED' });
    }
  } else if (category === 'DEPARTMENT_TASK') {
    const isDeptEnabled = await isFeatureEnabled(client, propertyId, 'housekeeping.department_tasks');
    if (!isDeptEnabled) {
      throw Object.assign(new Error('Fitur Tugas Departemen sedang dinonaktifkan.'), { statusCode: 403, code: 'FEATURE_DISABLED' });
    }
  } else if (payload.task_type === 'FINAL_INSPECTION') {
    const isInspEnabled = await isFeatureEnabled(client, propertyId, 'housekeeping.final_inspection');
    if (!isInspEnabled) {
      throw Object.assign(new Error('Fitur Final Inspeksi sedang dinonaktifkan.'), { statusCode: 403, code: 'FEATURE_DISABLED' });
    }
  } else if (payload.task_type === 'CHECKOUT_ROOM_CHECK') {
    const isChkEnabled = await isFeatureEnabled(client, propertyId, 'housekeeping.checkout_inspection');
    if (!isChkEnabled) {
      throw Object.assign(new Error('Fitur Pemeriksaan Checkout sedang dinonaktifkan.'), { statusCode: 403, code: 'FEATURE_DISABLED' });
    }
  } else if (category === 'ROOM_OPERATIONS') {
    const isRoomOpsEnabled = await isFeatureEnabled(client, propertyId, 'housekeeping.room_operations');
    if (!isRoomOpsEnabled) {
      throw Object.assign(new Error('Fitur Operasi Kamar sedang dinonaktifkan.'), { statusCode: 403, code: 'FEATURE_DISABLED' });
    }
  }

  let roomId = payload.room_id ? Number(payload.room_id) : null;
  let roomNumber = payload.room_number ? String(payload.room_number).trim() : null;

  if (roomId && !roomNumber) {
    const rRes = await client.query('SELECT room_number FROM rooms WHERE id = $1 AND property_id = $2', [roomId, propertyId]);
    if (hasRows(rRes)) {
      roomNumber = rRes.rows[0].room_number;
    }
  } else if (roomNumber && !roomId) {
    const rRes = await client.query('SELECT id FROM rooms WHERE room_number = $1 AND property_id = $2', [roomNumber, propertyId]);
    if (hasRows(rRes)) {
      roomId = Number(rRes.rows[0].id);
    }
  }

  const title = payload.title || (
    payload.task_type === 'ROOM_CLEANING' ? `Pembersihan Kamar ${roomNumber || ''}` :
    payload.task_type === 'CHECKOUT_ROOM_CHECK' ? `Pemeriksaan Checkout Kamar ${roomNumber || ''}` :
    payload.task_type === 'FINAL_INSPECTION' ? `Inspeksi Akhir Kamar ${roomNumber || ''}` :
    payload.task_type === 'GUEST_SERVICE_DELIVERY' ? `Layanan Tamu Kamar ${roomNumber || ''}` :
    `Tugas Housekeeping ${roomNumber ? 'Kamar ' + roomNumber : ''}`
  );

  const priority = payload.priority || (
    payload.task_type === 'CHECKOUT_ROOM_CHECK' ? 'CRITICAL' : 'NORMAL'
  );

  const taskNumber = await generateTaskNumber(client, propertyId);

  const insertRes = await client.query(
    `INSERT INTO housekeeping_tasks (
      property_id, task_number, room_id, room_number, reservation_id, guest_id,
      task_category, task_type, title, description, priority, status,
      assigned_department, assigned_user_id, assigned_user_name_snapshot,
      requested_by_user_id, requested_by_name_snapshot, requested_by_role_snapshot,
      scheduled_at, due_at, source_type, source_entity_id
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11, 'ASSIGNED',
      $12, $13, $14,
      $15, $16, $17,
      $18, $19, $20, $21
    ) RETURNING *`,
    [
      propertyId, taskNumber, roomId, roomNumber, payload.reservation_id || null, payload.guest_id || null,
      category, payload.task_type, title, payload.description || null, priority,
      payload.assigned_department || 'Housekeeping', payload.assigned_user_id || null, payload.assigned_user_name_snapshot || null,
      payload.requested_by_user_id || actor?.id || null, payload.requested_by_name_snapshot || actor?.name || null, payload.requested_by_role_snapshot || actor?.role || null,
      payload.scheduled_at || null, payload.due_at || null, payload.source_type || 'MANUAL', payload.source_entity_id || null
    ]
  );

  const createdTask: HousekeepingTaskRecord = insertRes.rows[0];

  // Snapshot checklist template
  const settings = await getPropertyHousekeepingSettings(client, propertyId);
  let templateCodeToUse = payload.template_code;
  if (!templateCodeToUse) {
    if (payload.task_type === 'ROOM_CLEANING' || payload.task_type === 'STAYOVER_CLEANING' || payload.task_type === 'DEEP_CLEAN' || payload.task_type === 'VIP_ROOM_PREPARATION') {
      templateCodeToUse = settings.default_cleaning_template_code;
    } else if (payload.task_type === 'CHECKOUT_ROOM_CHECK') {
      templateCodeToUse = settings.default_checkout_template_code;
    } else if (payload.task_type === 'FINAL_INSPECTION') {
      templateCodeToUse = 'FINAL_INSPECTION';
    }
  }

  let items: TaskChecklistItem[] = [];
  if (templateCodeToUse) {
    items = await snapshotTemplateToChecklist(client, createdTask.id, propertyId, templateCodeToUse);
  }
  createdTask.checklist_items = items;

  // Audit log
  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_TASK_CREATED', 'HOUSEKEEPING_TASK', String(createdTask.id), JSON.stringify(createdTask), actor?.name || 'System', propertyId]
  );

  return createdTask;
}

export async function ensureCheckoutRoomCleaningTask(
  client: PoolClient,
  propertyId: number,
  roomId: number,
  reservationId?: number | null
): Promise<HousekeepingTaskRecord | null> {
  const isRoomOpsEnabled = await isFeatureEnabled(client, propertyId, 'housekeeping.room_operations');
  if (!isRoomOpsEnabled) {
    return null;
  }

  // Idempotency check: check if active ROOM_CLEANING task already exists for this room
  const existingRes = await client.query(
    `SELECT * FROM housekeeping_tasks
     WHERE property_id = $1
       AND room_id = $2
       AND task_type = 'ROOM_CLEANING'
       AND status IN ('ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'BLOCKED')
     ORDER BY id DESC LIMIT 1`,
    [propertyId, roomId]
  );

  if (hasRows(existingRes)) {
    return existingRes.rows[0];
  }

  // Get room details
  const roomRes = await client.query('SELECT room_number FROM rooms WHERE id = $1 AND property_id = $2', [roomId, propertyId]);
  const roomNumber = hasRows(roomRes) ? roomRes.rows[0].room_number : null;

  // Check if incoming check-in today exists for this room
  const todayStr = new Date().toISOString().slice(0, 10);
  const arrivalCheck = await client.query(
    `SELECT r.id, r.guest_name, r.check_in
     FROM reservations r
     JOIN bookings b ON b.id = r.booking_id
     WHERE b.property_id = $1
       AND r.room_id = $2
       AND r.status = 'BOOKED'
       AND r.check_in::date = $3::date
     LIMIT 1`,
    [propertyId, roomId, todayStr]
  );

  const hasIncomingArrival = hasRows(arrivalCheck);
  const priority: HkTaskPriority = hasIncomingArrival ? 'TURNOVER' : 'NORMAL';
  const title = hasIncomingArrival
    ? `Turnover Pembersihan Kamar ${roomNumber || ''} (Arrival Hari Ini)`
    : `Pembersihan Kamar ${roomNumber || ''}`;

  return await createHousekeepingTask(
    client,
    propertyId,
    {
      task_category: 'ROOM_OPERATIONS',
      task_type: 'ROOM_CLEANING',
      room_id: roomId,
      room_number: roomNumber,
      reservation_id: reservationId || null,
      title,
      priority,
      source_type: 'CHECKOUT_EVENT',
      source_entity_id: reservationId ? String(reservationId) : null
    },
    { name: 'System (Checkout Trigger)' }
  );
}

export async function requestCheckoutRoomCheck(
  client: PoolClient,
  propertyId: number,
  reservationId: number,
  roomId: number,
  requestedBy?: { id?: number; name?: string; role?: string }
): Promise<HousekeepingTaskRecord> {
  const isChkEnabled = await isFeatureEnabled(client, propertyId, 'housekeeping.checkout_inspection');
  if (!isChkEnabled) {
    throw Object.assign(new Error('Fitur Pemeriksaan Checkout sedang dinonaktifkan.'), { statusCode: 403, code: 'FEATURE_DISABLED' });
  }

  // Check if already requested and active
  const existingRes = await client.query(
    `SELECT * FROM housekeeping_tasks
     WHERE property_id = $1
       AND reservation_id = $2
       AND task_type = 'CHECKOUT_ROOM_CHECK'
       AND status IN ('ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS')
     LIMIT 1`,
    [propertyId, reservationId]
  );
  if (hasRows(existingRes)) {
    return existingRes.rows[0];
  }

  const roomRes = await client.query('SELECT room_number FROM rooms WHERE id = $1 AND property_id = $2', [roomId, propertyId]);
  const roomNumber = hasRows(roomRes) ? roomRes.rows[0].room_number : null;

  const task = await createHousekeepingTask(
    client,
    propertyId,
    {
      task_category: 'ROOM_OPERATIONS',
      task_type: 'CHECKOUT_ROOM_CHECK',
      room_id: roomId,
      room_number: roomNumber,
      reservation_id: reservationId,
      title: `Pemeriksaan Checkout Kamar ${roomNumber || ''}`,
      priority: 'CRITICAL',
      source_type: 'FO_REQUEST',
      source_entity_id: String(reservationId),
      requested_by_user_id: requestedBy?.id || null,
      requested_by_name_snapshot: requestedBy?.name || 'Front Office',
      requested_by_role_snapshot: requestedBy?.role || 'Receptionist'
    },
    requestedBy
  );

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['PMS', 'CHECKOUT_ROOM_CHECK_REQUESTED', 'RESERVATION', String(reservationId), JSON.stringify({ task_id: task.id, room_id: roomId }), requestedBy?.name || 'Front Office', propertyId]
  );

  return task;
}

export async function acknowledgeHousekeepingTask(
  client: PoolClient,
  propertyId: number,
  taskId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<HousekeepingTaskRecord> {
  const hkEnabled = await isFeatureEnabled(client, propertyId, 'housekeeping.enabled');
  if (!hkEnabled) {
    throw Object.assign(new Error('Modul Housekeeping sedang dinonaktifkan untuk properti ini.'), { statusCode: 403, code: 'FEATURE_DISABLED' });
  }

  const taskRes = await client.query('SELECT * FROM housekeeping_tasks WHERE id = $1 AND property_id = $2 FOR UPDATE', [taskId, propertyId]);
  if (!hasRows(taskRes)) {
    throw Object.assign(new Error('Task not found in this property'), { statusCode: 404 });
  }

  const updateRes = await client.query(
    `UPDATE housekeeping_tasks
     SET status = 'ACKNOWLEDGED',
         acknowledged_at = COALESCE(acknowledged_at, NOW()),
         assigned_user_name_snapshot = COALESCE(assigned_user_name_snapshot, $1),
         updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [actor?.name || null, taskId]
  );

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_TASK_ACKNOWLEDGED', 'HOUSEKEEPING_TASK', String(taskId), JSON.stringify(updateRes.rows[0]), actor?.name || 'System', propertyId]
  );

  return updateRes.rows[0];
}

export async function startHousekeepingTask(
  client: PoolClient,
  propertyId: number,
  taskId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<HousekeepingTaskRecord> {
  const hkEnabled = await isFeatureEnabled(client, propertyId, 'housekeeping.enabled');
  if (!hkEnabled) {
    throw Object.assign(new Error('Modul Housekeeping sedang dinonaktifkan untuk properti ini.'), { statusCode: 403, code: 'FEATURE_DISABLED' });
  }

  const taskRes = await client.query('SELECT * FROM housekeeping_tasks WHERE id = $1 AND property_id = $2 FOR UPDATE', [taskId, propertyId]);
  if (!hasRows(taskRes)) {
    throw Object.assign(new Error('Task not found in this property'), { statusCode: 404 });
  }
  const task = taskRes.rows[0];

  const updateRes = await client.query(
    `UPDATE housekeeping_tasks
     SET status = 'IN_PROGRESS',
         started_at = COALESCE(started_at, NOW()),
         assigned_user_name_snapshot = COALESCE(assigned_user_name_snapshot, $1),
         updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [actor?.name || null, taskId]
  );

  // If room operations cleaning, atomically transition room status to CLEANING
  if (task.room_id && (task.task_type === 'ROOM_CLEANING' || task.task_type === 'STAYOVER_CLEANING' || task.task_type === 'DEEP_CLEAN')) {
    await client.query('UPDATE rooms SET status = $1 WHERE id = $2 AND property_id = $3', ['CLEANING', task.room_id, propertyId]);
    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['HOUSEKEEPING', 'ROOM_CLEANING_STARTED', 'ROOM', String(task.room_id), JSON.stringify({ status: 'CLEANING', task_id: taskId }), actor?.name || 'System', propertyId]
    );
  }

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_TASK_STARTED', 'HOUSEKEEPING_TASK', String(taskId), JSON.stringify(updateRes.rows[0]), actor?.name || 'System', propertyId]
  );

  return updateRes.rows[0];
}

export async function updateTaskChecklistItem(
  client: PoolClient,
  propertyId: number,
  taskId: number,
  itemId: number,
  payload: { is_completed: boolean; note?: string | null; photo_storage_key?: string | null },
  actor?: { id?: number; name?: string; role?: string }
): Promise<TaskChecklistItem> {
  const hkEnabled = await isFeatureEnabled(client, propertyId, 'housekeeping.enabled');
  if (!hkEnabled) {
    throw Object.assign(new Error('Modul Housekeeping sedang dinonaktifkan untuk properti ini.'), { statusCode: 403, code: 'FEATURE_DISABLED' });
  }

  const taskCheck = await client.query('SELECT id FROM housekeeping_tasks WHERE id = $1 AND property_id = $2', [taskId, propertyId]);
  if (!hasRows(taskCheck)) {
    throw Object.assign(new Error('Task not found in this property'), { statusCode: 404 });
  }

  const res = await client.query(
    `UPDATE housekeeping_task_checklist_items
     SET is_completed = $1,
         completed_at = CASE WHEN $1 = true THEN COALESCE(completed_at, NOW()) ELSE NULL END,
         completed_by_name = CASE WHEN $1 = true THEN COALESCE(completed_by_name, $2) ELSE NULL END,
         note = COALESCE($3, note),
         photo_storage_key = COALESCE($4, photo_storage_key)
     WHERE id = $5 AND task_id = $6
     RETURNING *`,
    [payload.is_completed, actor?.name || 'Staff', payload.note || null, payload.photo_storage_key || null, itemId, taskId]
  );

  if (!hasRows(res)) {
    throw Object.assign(new Error('Checklist item not found for this task'), { statusCode: 404 });
  }

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_CHECKLIST_ITEM_UPDATED', 'CHECKLIST_ITEM', String(itemId), JSON.stringify(res.rows[0]), actor?.name || 'System', propertyId]
  );

  return res.rows[0];
}

export async function completeHousekeepingTask(
  client: PoolClient,
  propertyId: number,
  taskId: number,
  payload: {
    completion_note?: string | null;
    inspection_result?: HkInspectionResult | null;
    issue_type?: HkIssueType | null;
    issue_note?: string | null;
    estimated_charge?: number | null;
  },
  actor?: { id?: number; name?: string; role?: string }
): Promise<HousekeepingTaskRecord> {
  const hkEnabled = await isFeatureEnabled(client, propertyId, 'housekeeping.enabled');
  if (!hkEnabled) {
    throw Object.assign(new Error('Modul Housekeeping sedang dinonaktifkan untuk properti ini.'), { statusCode: 403, code: 'FEATURE_DISABLED' });
  }

  const taskRes = await client.query('SELECT * FROM housekeeping_tasks WHERE id = $1 AND property_id = $2 FOR UPDATE', [taskId, propertyId]);
  if (!hasRows(taskRes)) {
    throw Object.assign(new Error('Task not found in this property'), { statusCode: 404 });
  }
  const task = taskRes.rows[0];

  // 1. Mandatory checklist validation (enforced for room cleaning and inspection pass)
  const isRework = payload.inspection_result === 'RETURN_TO_CLEANING';
  const isCheckoutCheck = task.task_type === 'CHECKOUT_ROOM_CHECK';
  if (!isRework && !isCheckoutCheck) {
    const incompleteItems = await client.query(
      `SELECT id, label, section
       FROM housekeeping_task_checklist_items
       WHERE task_id = $1 AND is_required = true AND is_completed = false`,
      [taskId]
    );
    if (hasRows(incompleteItems)) {
      throw Object.assign(
        new Error(`Tidak dapat menyelesaikan tugas. Ada ${incompleteItems.rows.length} checklist wajib yang belum lengkap.`),
        {
          statusCode: 400,
          code: 'CHECKLIST_INCOMPLETE',
          incomplete_items: incompleteItems.rows
        }
      );
    }
  }

  // 2. Specific validations per task_type
  let nextStatus: HkTaskStatus = 'DONE';
  let inspectionResult = payload.inspection_result || task.inspection_result || null;
  let issueType = payload.issue_type || task.issue_type || null;
  let issueNote = payload.issue_note || task.issue_note || null;
  let estimatedCharge = payload.estimated_charge !== undefined ? payload.estimated_charge : task.estimated_charge;

  if (task.task_type === 'CHECKOUT_ROOM_CHECK') {
    if (!inspectionResult) {
      inspectionResult = 'CLEAR';
    }
    if (inspectionResult === 'ISSUE_FOUND' && !issueType) {
      throw Object.assign(new Error('Tipe temuan (issue_type) wajib diisi jika hasil pemeriksaan terdapat temuan.'), { statusCode: 400, code: 'ISSUE_TYPE_REQUIRED' });
    }
  } else if (task.task_type === 'FINAL_INSPECTION') {
    if (!inspectionResult) {
      inspectionResult = 'PASS';
    }
    if (inspectionResult === 'RETURN_TO_CLEANING' && !payload.completion_note) {
      throw Object.assign(new Error('Alasan pengembalian ke pembersihan (completion_note) wajib diisi.'), { statusCode: 400, code: 'RETURN_REASON_REQUIRED' });
    }
  }

  // 3. Update task
  const updateRes = await client.query(
    `UPDATE housekeeping_tasks
     SET status = $1,
         completed_at = NOW(),
         completion_note = COALESCE($2, completion_note),
         inspection_result = $3,
         issue_type = $4,
         issue_note = $5,
         estimated_charge = $6,
         updated_at = NOW()
     WHERE id = $7
     RETURNING *`,
    [nextStatus, payload.completion_note || null, inspectionResult, issueType, issueNote, estimatedCharge, taskId]
  );
  const updatedTask = updateRes.rows[0];

  // 4. Room readiness transitions based on task type
  if (task.room_id) {
    const roomId = Number(task.room_id);

    if (task.task_type === 'ROOM_CLEANING' || task.task_type === 'DEEP_CLEAN' || task.task_type === 'VIP_ROOM_PREPARATION') {
      // Check if stayover / in-house guest exists
      const inHouseRes = await client.query(
        `SELECT 1 FROM reservations
         WHERE room_id = $1 AND status = 'CHECKED_IN' AND stay_status = 'IN_HOUSE'
         LIMIT 1`,
        [roomId]
      );
      const targetRoomStatus = hasRows(inHouseRes) ? 'OCCUPIED_CLEAN' : 'VACANT_CLEAN';
      await client.query('UPDATE rooms SET status = $1 WHERE id = $2 AND property_id = $3', [targetRoomStatus, roomId, propertyId]);

      await client.query(
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['HOUSEKEEPING', 'ROOM_CLEANING_COMPLETED', 'ROOM', String(roomId), JSON.stringify({ status: targetRoomStatus, task_id: taskId }), actor?.name || 'System', propertyId]
      );

      // Final inspection workflow integration
      if (targetRoomStatus === 'VACANT_CLEAN') {
        const isHkFinalInsp = await isFeatureEnabled(client, propertyId, 'housekeeping.final_inspection');
        const hkSettings = await getPropertyHousekeepingSettings(client, propertyId);
        if (isHkFinalInsp && hkSettings.require_final_inspection) {
          await createHousekeepingTask(
            client,
            propertyId,
            {
              task_category: 'ROOM_OPERATIONS',
              task_type: 'FINAL_INSPECTION',
              room_id: roomId,
              room_number: task.room_number,
              title: `Inspeksi Akhir Kamar ${task.room_number || ''}`,
              priority: 'NORMAL',
              source_type: 'AUTO_POST_CLEANING',
              source_entity_id: String(taskId),
              template_code: 'SUPERVISOR_FINAL_INSPECTION'
            },
            actor
          );
        }
      }
    } else if (task.task_type === 'FINAL_INSPECTION') {
      if (inspectionResult === 'PASS') {
        await client.query('UPDATE rooms SET status = $1 WHERE id = $2 AND property_id = $3', ['INSPECTED', roomId, propertyId]);
        await client.query(
          `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          ['HOUSEKEEPING', 'ROOM_INSPECTION_PASSED', 'ROOM', String(roomId), JSON.stringify({ status: 'INSPECTED', task_id: taskId }), actor?.name || 'Supervisor', propertyId]
        );
      } else if (inspectionResult === 'RETURN_TO_CLEANING') {
        await client.query('UPDATE rooms SET status = $1 WHERE id = $2 AND property_id = $3', ['VACANT_DIRTY', roomId, propertyId]);
        await client.query(
          `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          ['HOUSEKEEPING', 'ROOM_RETURNED_TO_CLEANING', 'ROOM', String(roomId), JSON.stringify({ status: 'VACANT_DIRTY', task_id: taskId, reason: payload.completion_note }), actor?.name || 'Supervisor', propertyId]
        );
        // Automatically create follow-up cleaning task
        await createHousekeepingTask(
          client,
          propertyId,
          {
            task_category: 'ROOM_OPERATIONS',
            task_type: 'ROOM_CLEANING',
            room_id: roomId,
            room_number: task.room_number,
            title: `Pembersihan Ulang Kamar ${task.room_number || ''} (Rework Inspeksi)`,
            priority: 'HIGH',
            description: `Perlu pembersihan ulang: ${payload.completion_note || 'Inspeksi belum lolos standard.'}`,
            source_type: 'INSPECTION_REWORK',
            source_entity_id: String(taskId)
          },
          actor
        );
      }
    } else if (task.task_type === 'CHECKOUT_ROOM_CHECK') {
      const actionCode = inspectionResult === 'ISSUE_FOUND' ? 'CHECKOUT_ROOM_CHECK_ISSUE_FOUND' : 'CHECKOUT_ROOM_CHECK_CLEARED';
      await client.query(
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['PMS', actionCode, 'RESERVATION', String(task.reservation_id), JSON.stringify({ task_id: taskId, inspection_result: inspectionResult, issue_type: issueType, issue_note: issueNote, estimated_charge: estimatedCharge }), actor?.name || 'Housekeeping Staff', propertyId]
      );
    }
  }

  // 5. Audit task completion
  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_TASK_COMPLETED', 'HOUSEKEEPING_TASK', String(taskId), JSON.stringify(updatedTask), actor?.name || 'System', propertyId]
  );

  return updatedTask;
}

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
  ChecklistTemplateGroup,
  ChecklistTemplateItem,
  TaskChecklistItem,
  PropertyHousekeepingSettings,
  HistoryEditPayload,
  HousekeepingFindingType,
  CreateFindingTypePayload,
  UpdateFindingTypePayload,
  HousekeepingTaskFinding,
  CreateChecklistTemplatePayload,
  UpdateChecklistTemplatePayload,
  CreateChecklistTemplateGroupPayload,
  UpdateChecklistTemplateGroupPayload,
  CreateChecklistTemplateItemPayload,
  UpdateChecklistTemplateItemPayload
} from './housekeepingTypes';
import { isFeatureEnabled } from '../features/featureService';

function hasRows(result: any): boolean {
  return Array.isArray(result?.rows) && result.rows.length > 0;
}

export function formatSettingsRecord(row: any): PropertyHousekeepingSettings {
  return {
    id: Number(row.id),
    property_id: Number(row.property_id),
    require_final_inspection: Boolean(row.require_final_inspection),
    require_checkout_room_check: Boolean(row.require_checkout_room_check),
    allow_calendar_room_status_override: Boolean(row.allow_calendar_room_status_override),
    default_cleaning_template_code: row.default_cleaning_template_code || 'STANDARD_ROOM_CLEANING',
    default_room_cleaning_template_code: row.default_cleaning_template_code || 'STANDARD_ROOM_CLEANING',
    default_checkout_template_code: row.default_checkout_template_code || 'CHECKOUT_INSPECTION',
    default_checkout_inspection_template_code: row.default_checkout_template_code || 'CHECKOUT_INSPECTION',
    created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString()
  };
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
    return formatSettingsRecord(res.rows[0]);
  }
  // Default fallback upsert
  const inserted = await client.query(
    `INSERT INTO property_housekeeping_settings (
       property_id,
       require_final_inspection,
       require_checkout_room_check,
       allow_calendar_room_status_override,
       default_cleaning_template_code,
       default_checkout_template_code
     )
     VALUES ($1, false, false, false, 'STANDARD_ROOM_CLEANING', 'CHECKOUT_INSPECTION')
     ON CONFLICT (property_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [propertyId]
  );
  return formatSettingsRecord(inserted.rows[0]);
}

export async function updatePropertyHousekeepingSettings(
  client: PoolClient,
  propertyId: number,
  settings: Partial<PropertyHousekeepingSettings>,
  actor?: { id?: number; name?: string; role?: string }
): Promise<PropertyHousekeepingSettings> {
  const current = await getPropertyHousekeepingSettings(client, propertyId);

  // 1. Explicit boolean semantics: true -> false, false -> true, preserving existing if undefined
  const requireFinalInspection = typeof settings.require_final_inspection === 'boolean'
    ? settings.require_final_inspection
    : current.require_final_inspection;

  const requireCheckoutRoomCheck = typeof settings.require_checkout_room_check === 'boolean'
    ? settings.require_checkout_room_check
    : current.require_checkout_room_check;

  const allowCalendarOverride = typeof settings.allow_calendar_room_status_override === 'boolean'
    ? settings.allow_calendar_room_status_override
    : current.allow_calendar_room_status_override;

  // 2. Default template code resolution & validation against active templates of this property
  const inputCleaningTemplate = settings.default_room_cleaning_template_code || settings.default_cleaning_template_code;
  const inputCheckoutTemplate = settings.default_checkout_inspection_template_code || settings.default_checkout_template_code;

  let defaultCleaningTemplate = current.default_cleaning_template_code || 'STANDARD_ROOM_CLEANING';
  if (inputCleaningTemplate && typeof inputCleaningTemplate === 'string' && inputCleaningTemplate.trim().length > 0) {
    const trimmed = inputCleaningTemplate.trim();
    const tplCheck = await client.query(
      'SELECT id, code, is_active FROM checklist_templates WHERE property_id = $1 AND code = $2',
      [propertyId, trimmed]
    );
    if (!hasRows(tplCheck)) {
      const err: any = new Error(`Template code '${trimmed}' is invalid or does not belong to property ${propertyId}`);
      err.statusCode = 400;
      err.code = 'INVALID_TEMPLATE_CODE';
      throw err;
    }
    defaultCleaningTemplate = trimmed;
  }

  let defaultCheckoutTemplate = current.default_checkout_template_code || 'CHECKOUT_INSPECTION';
  if (inputCheckoutTemplate && typeof inputCheckoutTemplate === 'string' && inputCheckoutTemplate.trim().length > 0) {
    const trimmed = inputCheckoutTemplate.trim();
    const tplCheck = await client.query(
      'SELECT id, code, is_active FROM checklist_templates WHERE property_id = $1 AND code = $2',
      [propertyId, trimmed]
    );
    if (!hasRows(tplCheck)) {
      const err: any = new Error(`Template code '${trimmed}' is invalid or does not belong to property ${propertyId}`);
      err.statusCode = 400;
      err.code = 'INVALID_TEMPLATE_CODE';
      throw err;
    }
    defaultCheckoutTemplate = trimmed;
  }

  // 3. Atomic UPSERT
  const res = await client.query(
    `INSERT INTO property_housekeeping_settings (
       property_id,
       require_final_inspection,
       require_checkout_room_check,
       allow_calendar_room_status_override,
       default_cleaning_template_code,
       default_checkout_template_code,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (property_id) DO UPDATE
     SET require_final_inspection = EXCLUDED.require_final_inspection,
         require_checkout_room_check = EXCLUDED.require_checkout_room_check,
         allow_calendar_room_status_override = EXCLUDED.allow_calendar_room_status_override,
         default_cleaning_template_code = EXCLUDED.default_cleaning_template_code,
         default_checkout_template_code = EXCLUDED.default_checkout_template_code,
         updated_at = NOW()
     RETURNING *`,
    [propertyId, requireFinalInspection, requireCheckoutRoomCheck, allowCalendarOverride, defaultCleaningTemplate, defaultCheckoutTemplate]
  );

  const formatted = formatSettingsRecord(res.rows[0]);

  // 4. Audit Trail
  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'UPDATE_SETTINGS', 'PROPERTY_SETTINGS', String(propertyId), JSON.stringify(formatted), actor?.name || 'System', propertyId]
  );

  return formatted;
}

export async function getChecklistTemplates(
  client: PoolClient | Pool,
  propertyId: number
): Promise<ChecklistTemplate[]> {
  const tRes = await client.query(
    `SELECT * FROM checklist_templates WHERE property_id = $1 ORDER BY sort_order ASC, id ASC`,
    [propertyId]
  );
  const templates: ChecklistTemplate[] = tRes.rows;

  if (templates.length === 0) return [];

  const templateIds = templates.map((t) => t.id);

  // Groups
  const groupsRes = await client.query(
    `SELECT * FROM checklist_template_groups WHERE template_id = ANY($1::int[]) AND is_archived = FALSE ORDER BY sort_order ASC, id ASC`,
    [templateIds]
  );
  const groupsByTemplate: Record<number, ChecklistTemplateGroup[]> = {};
  for (const grp of groupsRes.rows) {
    if (!groupsByTemplate[grp.template_id]) {
      groupsByTemplate[grp.template_id] = [];
    }
    grp.items = [];
    groupsByTemplate[grp.template_id].push(grp);
  }

  // Items joined with group info
  const itemsRes = await client.query(
    `SELECT i.*, g.name AS group_name, g.code AS group_code, COALESCE(g.sort_order, 0) AS group_sort_order
     FROM checklist_template_items i
     LEFT JOIN checklist_template_groups g ON g.id = i.group_id
     WHERE i.template_id = ANY($1::int[]) AND i.is_archived = FALSE
     ORDER BY COALESCE(g.sort_order, 0) ASC, i.sort_order ASC, i.id ASC`,
    [templateIds]
  );

  const itemsByTemplate: Record<number, ChecklistTemplateItem[]> = {};
  const itemsByGroup: Record<number, ChecklistTemplateItem[]> = {};
  for (const item of itemsRes.rows) {
    if (!itemsByTemplate[item.template_id]) {
      itemsByTemplate[item.template_id] = [];
    }
    itemsByTemplate[item.template_id].push(item);
    if (item.group_id) {
      if (!itemsByGroup[item.group_id]) {
        itemsByGroup[item.group_id] = [];
      }
      itemsByGroup[item.group_id].push(item);
    }
  }

  return templates.map((t) => {
    const tplGroups = (groupsByTemplate[t.id] || []).map((grp) => ({
      ...grp,
      items: itemsByGroup[grp.id] || []
    }));
    return {
      ...t,
      items: itemsByTemplate[t.id] || [],
      groups: tplGroups
    };
  });
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

  const groupsRes = await client.query(
    `SELECT * FROM checklist_template_groups WHERE template_id = $1 AND is_archived = FALSE ORDER BY sort_order ASC, id ASC`,
    [template.id]
  );
  const groups: ChecklistTemplateGroup[] = groupsRes.rows.map(g => ({ ...g, items: [] }));
  const groupMap = new Map<number, ChecklistTemplateGroup>();
  for (const g of groups) {
    groupMap.set(g.id, g);
  }

  const itemsRes = await client.query(
    `SELECT i.*, g.name AS group_name, g.code AS group_code, COALESCE(g.sort_order, 0) AS group_sort_order
     FROM checklist_template_items i
     LEFT JOIN checklist_template_groups g ON g.id = i.group_id
     WHERE i.template_id = $1 AND i.is_archived = FALSE
     ORDER BY COALESCE(g.sort_order, 0) ASC, i.sort_order ASC, i.id ASC`,
    [template.id]
  );

  for (const item of itemsRes.rows) {
    if (item.group_id && groupMap.has(item.group_id)) {
      groupMap.get(item.group_id)!.items!.push(item);
    }
  }

  template.items = itemsRes.rows;
  template.groups = groups;
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

  // Find active group IDs
  const activeGroupIds = new Set(
    (template.groups || [])
      .filter((g) => g.is_active && !g.is_archived)
      .map((g) => g.id)
  );

  const snapshotItems: TaskChecklistItem[] = [];
  for (const item of template.items) {
    if (!item.is_active || item.is_archived) continue;
    // If item belongs to a group that is inactive or archived, exclude it!
    if (item.group_id && !activeGroupIds.has(item.group_id)) continue;

    const groupName = item.group_name || item.section || 'RUANGAN KAMAR';
    const groupSort = item.group_sort_order !== undefined ? item.group_sort_order : 10;

    const insertRes = await client.query(
      `INSERT INTO housekeeping_task_checklist_items
        (task_id, template_item_id, group_id, source_group_id, group_code, group_name, group_sort_order, section, label, sort_order, is_required, requires_note, requires_photo, is_completed, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, false, NOW(), NOW())
       RETURNING *`,
      [
        taskId,
        item.id,
        item.group_id || null,
        item.group_id || null,
        item.group_code || null,
        groupName,
        groupSort,
        item.section,
        item.label,
        item.sort_order,
        item.is_required,
        item.requires_note,
        item.requires_photo
      ]
    );
    snapshotItems.push(insertRes.rows[0]);
  }
  return snapshotItems;
}

export async function getTaskChecklistItems(
  client: PoolClient | Pool,
  propertyId: number,
  taskId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<TaskChecklistItem[]> {
  const taskCheck = await client.query('SELECT * FROM housekeeping_tasks WHERE id = $1 AND property_id = $2', [taskId, propertyId]);
  if (!hasRows(taskCheck)) {
    throw Object.assign(new Error('Tugas housekeeping tidak ditemukan pada properti ini.'), { statusCode: 404, code: 'NOT_FOUND' });
  }
  const task = taskCheck.rows[0];

  const res = await client.query(
    `SELECT * FROM housekeeping_task_checklist_items WHERE task_id = $1 ORDER BY COALESCE(group_sort_order, 0) ASC, sort_order ASC, id ASC`,
    [taskId]
  );

  // Lazy snapshot if task has no items and is an active operational task
  if (res.rows.length === 0 && ['REQUESTED', 'PENDING', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'BLOCKED'].includes(task.status) && !task.is_archived) {
    const settings = await getPropertyHousekeepingSettings(client, propertyId);
    let templateCodeToUse: string | null = null;
    if (['ROOM_CLEANING', 'STAYOVER_CLEANING', 'DEEP_CLEAN', 'VIP_ROOM_PREPARATION'].includes(task.task_type)) {
      templateCodeToUse = settings.default_cleaning_template_code || 'STANDARD_ROOM_CLEANING';
    } else if (task.task_type === 'CHECKOUT_ROOM_CHECK') {
      templateCodeToUse = settings.default_checkout_template_code || 'CHECKOUT_INSPECTION';
    } else if (task.task_type === 'FINAL_INSPECTION') {
      templateCodeToUse = 'FINAL_INSPECTION';
    }

    if (templateCodeToUse) {
      const template = await getChecklistTemplateByCode(client, propertyId, templateCodeToUse);
      if (template && template.is_active && !template.is_archived && template.items && template.items.length > 0) {
        const activeGroupIds = new Set(
          (template.groups || [])
            .filter((g) => g.is_active && !g.is_archived)
            .map((g) => g.id)
        );

        const createdItems: TaskChecklistItem[] = [];
        for (const item of template.items) {
          if (!item.is_active || item.is_archived) continue;
          if (item.group_id && !activeGroupIds.has(item.group_id)) continue;

          const groupName = item.group_name || item.section || 'RUANGAN KAMAR';
          const groupSort = item.group_sort_order !== undefined ? item.group_sort_order : 10;

          const ins = await client.query(
            `INSERT INTO housekeeping_task_checklist_items
              (task_id, template_item_id, group_id, source_group_id, group_code, group_name, group_sort_order, section, label, sort_order, is_required, requires_note, requires_photo, is_completed, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, false, NOW(), NOW())
             RETURNING *`,
            [
              taskId,
              item.id,
              item.group_id || null,
              item.group_id || null,
              item.group_code || null,
              groupName,
              groupSort,
              item.section,
              item.label,
              item.sort_order,
              item.is_required,
              item.requires_note,
              item.requires_photo
            ]
          );
          createdItems.push(ins.rows[0]);
        }
        if (createdItems.length > 0) {
          await client.query(
            `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            ['HOUSEKEEPING', 'HK_TASK_CHECKLIST_REPAIRED', 'HOUSEKEEPING_TASK', String(taskId), JSON.stringify({ repaired_items_count: createdItems.length, template_code: templateCodeToUse }), actor?.name || 'System Auto-Repair', propertyId]
          );
        }
        return createdItems;
      }
    }
  }

  return res.rows;
}

export async function reconcileDuplicateActiveCleaningTasks(
  client: PoolClient | Pool,
  propertyId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<{ reconciledCount: number; duplicateGroups: number }> {
  // Find all rooms with > 1 active ROOM_CLEANING task
  const dupesRes = await client.query(
    `SELECT room_id, COUNT(*) as cnt
     FROM housekeeping_tasks
     WHERE property_id = $1
       AND task_type = 'ROOM_CLEANING'
       AND room_id IS NOT NULL
       AND status IN ('REQUESTED', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'BLOCKED')
       AND COALESCE(is_archived, FALSE) = FALSE
     GROUP BY room_id
     HAVING COUNT(*) > 1`,
    [propertyId]
  );

  let reconciledCount = 0;
  for (const row of dupesRes.rows) {
    const roomId = Number(row.room_id);
    const tasksRes = await client.query(
      `SELECT t.*,
              (SELECT COUNT(*) FROM housekeeping_task_checklist_items WHERE task_id = t.id AND is_completed = TRUE) as completed_items_count
       FROM housekeeping_tasks t
       WHERE t.property_id = $1
         AND t.room_id = $2
         AND t.task_type = 'ROOM_CLEANING'
         AND t.status IN ('REQUESTED', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'BLOCKED')
         AND COALESCE(t.is_archived, FALSE) = FALSE
       ORDER BY
         CASE
           WHEN t.status = 'IN_PROGRESS' THEN 1
           WHEN t.status = 'ACKNOWLEDGED' THEN 2
           WHEN t.status = 'BLOCKED' THEN 3
           WHEN t.status = 'ASSIGNED' THEN 4
           ELSE 5
         END ASC,
         (SELECT COUNT(*) FROM housekeeping_task_checklist_items WHERE task_id = t.id AND is_completed = TRUE) DESC,
         t.updated_at DESC,
         t.id DESC`,
      [propertyId, roomId]
    );

    if (tasksRes.rows.length > 1) {
      const canonical = tasksRes.rows[0];
      for (const redundant of tasksRes.rows.slice(1)) {
        await client.query(
          `UPDATE housekeeping_tasks
           SET status = 'CANCELLED',
               notes = COALESCE(notes, '') || ' [Deduplicated: superseded by task #' || $1 || ']',
               updated_at = NOW()
           WHERE id = $2`,
          [canonical.id, redundant.id]
        );

        await client.query(
          `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            'HOUSEKEEPING',
            'HK_TASK_DEDUPLICATED',
            'HOUSEKEEPING_TASK',
            String(redundant.id),
            JSON.stringify({ status: 'CANCELLED', previous_status: redundant.status, superseded_by_task_id: canonical.id }),
            actor?.name || 'System Reconciler',
            propertyId
          ]
        );
        reconciledCount++;
      }
    }
  }

  return { reconciledCount, duplicateGroups: dupesRes.rows.length };
}

export async function repairActiveCleaningChecklistSnapshots(
  client: PoolClient | Pool,
  propertyId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<{ repaired_task_ids: number[]; count: number; template_code: string | null; duplicate_reconciliation: { reconciledCount: number; duplicateGroups: number } }> {
  // First reconcile any duplicate active cleaning tasks safely
  const dupeReconcile = await reconcileDuplicateActiveCleaningTasks(client, propertyId, actor);

  const settings = await getPropertyHousekeepingSettings(client, propertyId);
  const templateCodeToUse = settings.default_cleaning_template_code || 'STANDARD_ROOM_CLEANING';
  const template = await getChecklistTemplateByCode(client, propertyId, templateCodeToUse);

  if (!template || !template.is_active || template.is_archived || !template.items || template.items.length === 0) {
    return { repaired_task_ids: [], count: 0, template_code: templateCodeToUse, duplicate_reconciliation: dupeReconcile };
  }

  const activeTemplateItems = template.items.filter(it => it.is_active && !it.is_archived);
  if (activeTemplateItems.length === 0) {
    return { repaired_task_ids: [], count: 0, template_code: templateCodeToUse, duplicate_reconciliation: dupeReconcile };
  }

  const tasksRes = await client.query(
    `SELECT t.id, t.task_number, t.room_id, t.task_type, t.status
     FROM housekeeping_tasks t
     WHERE t.property_id = $1
       AND COALESCE(t.is_archived, FALSE) = FALSE
       AND t.task_type IN ('ROOM_CLEANING', 'STAYOVER_CLEANING', 'DEEP_CLEAN', 'VIP_ROOM_PREPARATION')
       AND t.status IN ('REQUESTED', 'PENDING', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'BLOCKED')
       AND NOT EXISTS (
         SELECT 1 FROM housekeeping_task_checklist_items ci WHERE ci.task_id = t.id
       )
     ORDER BY t.id ASC`,
    [propertyId]
  );

  const repairedIds: number[] = [];
  for (const t of tasksRes.rows) {
    for (const item of activeTemplateItems) {
      const groupName = item.group_name || item.section || 'RUANGAN KAMAR';
      const groupSort = item.group_sort_order !== undefined ? item.group_sort_order : 10;
      await client.query(
        `INSERT INTO housekeeping_task_checklist_items
          (task_id, template_item_id, group_id, source_group_id, group_code, group_name, group_sort_order, section, label, sort_order, is_required, requires_note, requires_photo, is_completed, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, false, NOW(), NOW())`,
        [
          t.id,
          item.id,
          item.group_id || null,
          item.group_id || null,
          item.group_code || null,
          groupName,
          groupSort,
          item.section,
          item.label,
          item.sort_order,
          item.is_required,
          item.requires_note,
          item.requires_photo
        ]
      );
    }
    repairedIds.push(t.id);

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['HOUSEKEEPING', 'HK_TASK_CHECKLIST_REPAIRED', 'HOUSEKEEPING_TASK', String(t.id), JSON.stringify({ repaired_items_count: activeTemplateItems.length, template_code: templateCodeToUse }), actor?.name || 'Admin Safe Repair', propertyId]
    );
  }

  return {
    repaired_task_ids: repairedIds,
    count: repairedIds.length,
    template_code: templateCodeToUse,
    duplicate_reconciliation: dupeReconcile
  };
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

  // 3. Query housekeeping tasks for property (active, non-archived, legacy-isolated)
  const tasksRes = await client.query(
    `SELECT t.*
     FROM housekeeping_tasks t
     WHERE t.property_id = $1
       AND COALESCE(t.is_archived, FALSE) = FALSE
       AND (t.room_id IS NOT NULL OR (t.task_category <> 'ROOM_OPERATIONS' AND t.task_type NOT IN ('ROOM_CLEANING', 'TURN_DOWN', 'DEEP_CLEAN', 'MAKEUP', 'STAYOVER_CLEANING', 'VIP_ROOM_PREPARATION', 'FINAL_INSPECTION', 'CHECKOUT_ROOM_CHECK')))
     ORDER BY
       CASE
         WHEN t.task_type = 'CHECKOUT_ROOM_CHECK' AND t.status IN ('ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS') THEN 1
         WHEN t.priority = 'TURNOVER' THEN 2
         WHEN t.due_at IS NOT NULL AND t.due_at < NOW() THEN 3
         WHEN t.priority IN ('CRITICAL', 'HIGH', 'VIP') THEN 4
         WHEN t.task_type = 'ROOM_CLEANING' THEN 5
         ELSE 6
       END,
       t.due_at ASC NULLS LAST,
       t.created_at ASC`,
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
  const rawCode = propRes.rows[0]?.property_code;
  const code = (rawCode && String(rawCode).trim() ? String(rawCode).trim() : `P${propertyId}`).toUpperCase();
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const dateStr = `${yy}${mm}${dd}`;
  const prefix = `HK-${code}-${dateStr}-`;

  const maxRes = await client.query(
    `SELECT MAX(SUBSTRING(task_number FROM '[0-9]+$')::int) as max_seq
     FROM housekeeping_tasks
     WHERE task_number LIKE $1`,
    [`${prefix}%`]
  );
  const maxSeq = maxRes.rows[0]?.max_seq ? Number(maxRes.rows[0].max_seq) : 0;
  const nextSeq = maxSeq + 1;
  return `${prefix}${String(nextSeq).padStart(4, '0')}`;
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

  // Authoritative data integrity rule: ROOM_CLEANING must require a valid room_id
  if (payload.task_type === 'ROOM_CLEANING' && !roomId) {
    throw Object.assign(
      new Error('Tugas pembersihan kamar (ROOM_CLEANING) membutuhkan data kamar (room_id) yang valid.'),
      { statusCode: 400, code: 'ROOM_ID_REQUIRED' }
    );
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

  // Concurrency & single active task rule for ROOM_CLEANING
  if (payload.task_type === 'ROOM_CLEANING' && roomId) {
    // Lock the room row to prevent race conditions from concurrent triggers
    await client.query('SELECT id FROM rooms WHERE id = $1 AND property_id = $2 FOR UPDATE', [roomId, propertyId]);

    const existingActive = await client.query(
      `SELECT t.*,
              (SELECT COUNT(*) FROM housekeeping_task_checklist_items WHERE task_id = t.id AND is_completed = TRUE) as completed_items_count
       FROM housekeeping_tasks t
       WHERE t.property_id = $1
         AND t.room_id = $2
         AND t.task_type = 'ROOM_CLEANING'
         AND t.status IN ('ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'BLOCKED')
         AND COALESCE(t.is_archived, FALSE) = FALSE
       ORDER BY
         CASE
           WHEN t.status = 'IN_PROGRESS' THEN 1
           WHEN t.status = 'ACKNOWLEDGED' THEN 2
           WHEN t.status = 'BLOCKED' THEN 3
           WHEN t.status = 'ASSIGNED' THEN 4
           ELSE 5
         END ASC,
         (SELECT COUNT(*) FROM housekeeping_task_checklist_items WHERE task_id = t.id AND is_completed = TRUE) DESC,
         t.updated_at DESC,
         t.id DESC`,
      [propertyId, roomId]
    );

    if (hasRows(existingActive)) {
      const canonicalTask = existingActive.rows[0];

      // Cancel and supersede any surplus duplicate active tasks for this room to enforce invariant <= 1
      if (existingActive.rows.length > 1) {
        for (const redundant of existingActive.rows.slice(1)) {
          await client.query(
            `UPDATE housekeeping_tasks
             SET status = 'CANCELLED',
                 notes = COALESCE(notes, '') || ' [Deduplicated: superseded by task #' || $1 || ']',
                 updated_at = NOW()
             WHERE id = $2`,
            [canonicalTask.id, redundant.id]
          );
          await client.query(
            `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              'HOUSEKEEPING',
              'HK_TASK_DEDUPLICATED',
              'HOUSEKEEPING_TASK',
              String(redundant.id),
              JSON.stringify({ status: 'CANCELLED', previous_status: redundant.status, superseded_by_task_id: canonicalTask.id }),
              actor?.name || 'System Deduplication',
              propertyId
            ]
          );
        }
      }

      if (priority === 'TURNOVER' && canonicalTask.priority !== 'TURNOVER') {
        const upd = await client.query(
          `UPDATE housekeeping_tasks SET priority = 'TURNOVER', title = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
          [title, canonicalTask.id]
        );
        return upd.rows[0];
      }
      return canonicalTask;
    }
  }

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

export async function ensureDirtyRoomCleaningTask(
  client: PoolClient,
  propertyId: number,
  roomId: number,
  options?: {
    reservationId?: number | null;
    sourceType?: string;
    sourceEntityId?: string | null;
    actor?: { id?: number; name?: string; role?: string };
  }
): Promise<HousekeepingTaskRecord | null> {
  const isRoomOpsEnabled = await isFeatureEnabled(client, propertyId, 'housekeeping.room_operations');
  if (!isRoomOpsEnabled) {
    return null;
  }

  // Row lock on room to prevent concurrency races
  await client.query('SELECT id FROM rooms WHERE id = $1 AND property_id = $2 FOR UPDATE', [roomId, propertyId]);

  // Check if active ROOM_CLEANING task already exists for this room
  const existingRes = await client.query(
    `SELECT * FROM housekeeping_tasks
     WHERE property_id = $1
       AND room_id = $2
       AND task_type = 'ROOM_CLEANING'
       AND status IN ('ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'BLOCKED')
       AND COALESCE(is_archived, FALSE) = FALSE
     ORDER BY id DESC LIMIT 1`,
    [propertyId, roomId]
  );

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

  if (hasRows(existingRes)) {
    const existingTask = existingRes.rows[0];

    // Reconcile and cancel any surplus duplicate active tasks for this room to enforce the invariant <= 1
    await client.query(
      `UPDATE housekeeping_tasks
       SET status = 'CANCELLED', notes = COALESCE(notes, '') || ' [Deduplicated by active cleaning invariant]', updated_at = NOW()
       WHERE property_id = $1 AND room_id = $2 AND task_type = 'ROOM_CLEANING'
         AND status IN ('REQUESTED', 'PENDING', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'BLOCKED')
         AND id <> $3`,
      [propertyId, roomId, existingTask.id]
    );

    if (hasIncomingArrival && existingTask.priority !== 'TURNOVER') {
      const updated = await client.query(
        `UPDATE housekeeping_tasks
         SET priority = 'TURNOVER',
             title = COALESCE(title, '') || ' (Arrival Hari Ini)',
             updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [existingTask.id]
      );
      return updated.rows[0];
    }
    return existingTask;
  }

  // Get room details
  const roomRes = await client.query('SELECT room_number FROM rooms WHERE id = $1 AND property_id = $2', [roomId, propertyId]);
  const roomNumber = hasRows(roomRes) ? roomRes.rows[0].room_number : null;

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
      reservation_id: options?.reservationId || null,
      title,
      priority,
      source_type: options?.sourceType || 'DIRTY_ROOM_EVENT',
      source_entity_id: options?.sourceEntityId || (options?.reservationId ? String(options.reservationId) : null)
    },
    options?.actor || { name: 'System (Dirty Event)' }
  );
}

export async function ensureCheckoutRoomCleaningTask(
  client: PoolClient,
  propertyId: number,
  roomId: number,
  reservationId?: number | null
): Promise<HousekeepingTaskRecord | null> {
  return await ensureDirtyRoomCleaningTask(client, propertyId, roomId, {
    reservationId,
    sourceType: 'CHECKOUT_EVENT',
    sourceEntityId: reservationId ? String(reservationId) : null,
    actor: { name: 'System (Checkout Trigger)' }
  });
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
       AND status IN ('ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'BLOCKED')
       AND COALESCE(is_archived, FALSE) = FALSE
     ORDER BY id DESC LIMIT 1`,
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
  actor?: { id?: number; name?: string; role?: string } | string
): Promise<HousekeepingTaskRecord> {
  const actorObj = typeof actor === 'string' ? { name: actor } : actor;
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
    [actorObj?.name || null, taskId]
  );

  // If room operations cleaning, atomically transition room status to CLEANING
  if (task.room_id && (task.task_type === 'ROOM_CLEANING' || task.task_type === 'STAYOVER_CLEANING' || task.task_type === 'DEEP_CLEAN')) {
    await client.query('UPDATE rooms SET status = $1 WHERE id = $2 AND property_id = $3', ['CLEANING', task.room_id, propertyId]);
    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['HOUSEKEEPING', 'ROOM_CLEANING_STARTED', 'ROOM', String(task.room_id), JSON.stringify({ status: 'CLEANING', task_id: taskId }), actorObj?.name || 'System', propertyId]
    );
  }

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_TASK_STARTED', 'HOUSEKEEPING_TASK', String(taskId), JSON.stringify(updateRes.rows[0]), actorObj?.name || 'System', propertyId]
  );

  return updateRes.rows[0];
}

export async function updateTaskChecklistItem(
  client: PoolClient | Pool,
  arg2: any,
  arg3: any,
  arg4?: any,
  arg5?: any,
  arg6?: any
): Promise<TaskChecklistItem> {
  let propertyId: number;
  let taskId: number;
  let itemId: number;
  let payload: { is_completed: boolean; note?: string | null; photo_storage_key?: string | null; checked_by?: string; property_id?: number };
  let actor: { id?: number; name?: string; role?: string } | undefined;

  if (typeof arg4 === 'object' && arg4 !== null && !arg5) {
    // 4-argument call: (client, taskId, itemId, payload)
    taskId = Number(arg2);
    itemId = Number(arg3);
    payload = arg4;
    actor = typeof arg5 === 'object' ? arg5 : (payload.checked_by ? { name: payload.checked_by } : undefined);
    const tCheck = await client.query('SELECT property_id FROM housekeeping_tasks WHERE id = $1', [taskId]);
    propertyId = hasRows(tCheck) ? Number(tCheck.rows[0].property_id) : (payload.property_id || 1);
  } else {
    // 5+ argument call: (client, propertyId, taskId, itemId, payload, actor)
    propertyId = Number(arg2);
    taskId = Number(arg3);
    itemId = Number(arg4);
    payload = arg5 || {};
    actor = typeof arg6 === 'string' ? { name: arg6 } : (typeof arg6 === 'object' ? arg6 : (payload.checked_by ? { name: payload.checked_by } : undefined));
  }

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
  payloadOrActorName?: any,
  completionNoteOrActor?: any
): Promise<HousekeepingTaskRecord> {
  let payload: {
    completion_note?: string | null;
    cleaning_note?: string | null;
    completed_by_user_id?: number | null;
    completed_by_name?: string | null;
    inspection_result?: HkInspectionResult | null;
    issue_type?: HkIssueType | null;
    issue_note?: string | null;
    estimated_charge?: number | null;
  } = {};
  let actor: { id?: number; name?: string; role?: string } | undefined;

  if (typeof payloadOrActorName === 'string') {
    actor = { name: payloadOrActorName };
    payload = {
      completed_by_name: payloadOrActorName,
      completion_note: typeof completionNoteOrActor === 'string' ? completionNoteOrActor : null
    };
  } else if (typeof payloadOrActorName === 'object' && payloadOrActorName !== null) {
    payload = payloadOrActorName;
    if (typeof completionNoteOrActor === 'object' && completionNoteOrActor !== null) {
      actor = completionNoteOrActor;
    } else if (typeof completionNoteOrActor === 'string') {
      actor = { name: completionNoteOrActor };
    }
  }
  const hkEnabled = await isFeatureEnabled(client, propertyId, 'housekeeping.enabled');
  if (!hkEnabled) {
    throw Object.assign(new Error('Modul Housekeeping sedang dinonaktifkan untuk properti ini.'), { statusCode: 403, code: 'FEATURE_DISABLED' });
  }

  const taskRes = await client.query('SELECT * FROM housekeeping_tasks WHERE id = $1 AND property_id = $2 FOR UPDATE', [taskId, propertyId]);
  if (!hasRows(taskRes)) {
    throw Object.assign(new Error('Task not found in this property'), { statusCode: 404 });
  }
  const task = taskRes.rows[0];

  // 1. Mandatory checklist validation
  const isRework = payload.inspection_result === 'RETURN_TO_CLEANING';
  const isCheckoutCheck = task.task_type === 'CHECKOUT_ROOM_CHECK';
  const isCheckoutClear = isCheckoutCheck && (payload.inspection_result === 'CLEAR' || (!payload.inspection_result && !task.inspection_result));

  if (!isRework) {
    if (!isCheckoutCheck || isCheckoutClear) {
      const incompleteItems = await client.query(
        `SELECT id, label, section
         FROM housekeeping_task_checklist_items
         WHERE task_id = $1 AND is_required = true AND is_completed = false`,
        [taskId]
      );
      if (hasRows(incompleteItems)) {
        throw Object.assign(
          new Error(
            isCheckoutClear
              ? `Tidak dapat menyatakan kamar aman. Ada ${incompleteItems.rows.length} butir checklist wajib yang belum diperiksa.`
              : `Tidak dapat menyelesaikan tugas. Ada ${incompleteItems.rows.length} checklist wajib yang belum lengkap.`
          ),
          {
            statusCode: 400,
            code: 'CHECKLIST_INCOMPLETE',
            incomplete_items: incompleteItems.rows
          }
        );
      }
    }
  }

  // 2. Specific validations per task_type
  let nextStatus: HkTaskStatus = 'DONE';
  let inspectionResult = payload.inspection_result || task.inspection_result || null;
  let issueType = payload.issue_type || task.issue_type || null;
  let issueNote = payload.issue_note || task.issue_note || null;
  let estimatedCharge = payload.estimated_charge !== undefined ? payload.estimated_charge : task.estimated_charge;
  const cleaningNote = payload.cleaning_note !== undefined ? (payload.cleaning_note ? payload.cleaning_note.trim() : null) : null;
  const cleaningNoteBy = payload.completed_by_name || actor?.name || 'Staff';
  const completionNote = payload.completion_note || cleaningNote || null;

  if (task.task_type === 'CHECKOUT_ROOM_CHECK') {
    if (!inspectionResult) {
      inspectionResult = 'CLEAR';
    }
    if (inspectionResult === 'ISSUE_FOUND') {
      if (!issueType) {
        throw Object.assign(new Error('Jenis kendala (issue_type) wajib dipilih jika status pemeriksaan ada masalah.'), { statusCode: 400, code: 'ISSUE_TYPE_REQUIRED' });
      }

      // Check against finding types catalog
      const ftRes = await client.query(
        `SELECT * FROM housekeeping_finding_types WHERE property_id = $1 AND (code = $2 OR label = $2)`,
        [propertyId, issueType]
      );
      if (hasRows(ftRes)) {
        const ft = ftRes.rows[0];
        if (ft.note_required && (!issueNote || issueNote.trim().length === 0)) {
          throw Object.assign(new Error(`Catatan temuan wajib diisi untuk jenis temuan '${ft.label}'.`), { statusCode: 400, code: 'NOTE_REQUIRED' });
        }
        if (!ft.estimated_charge_allowed) {
          estimatedCharge = 0;
        }
      }
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
         cleaning_note = COALESCE($3, cleaning_note),
         cleaning_note_by = CASE WHEN $3 IS NOT NULL THEN $4 ELSE cleaning_note_by END,
         cleaning_note_at = CASE WHEN $3 IS NOT NULL THEN NOW() ELSE cleaning_note_at END,
         inspection_result = $5,
         issue_type = $6,
         issue_note = $7,
         estimated_charge = $8,
         updated_at = NOW()
     WHERE id = $9
     RETURNING *`,
    [nextStatus, completionNote, cleaningNote, cleaningNoteBy, inspectionResult, issueType, issueNote, estimatedCharge, taskId]
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

      // Ensure any remaining active cleaning tasks for this room are marked completed
      await client.query(
        `UPDATE housekeeping_tasks
         SET status = 'DONE', completed_at = NOW(), completion_note = 'Automatically completed with room cleaning completion', updated_at = NOW()
         WHERE property_id = $1 AND room_id = $2 AND task_type = 'ROOM_CLEANING'
           AND status IN ('REQUESTED', 'PENDING', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'BLOCKED')
           AND id <> $3`,
        [propertyId, roomId, taskId]
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

export async function updateTaskHistoryRecord(
  client: PoolClient,
  propertyId: number,
  taskId: number,
  payload: HistoryEditPayload,
  actor?: { id?: number; name?: string; role?: string }
): Promise<HousekeepingTaskRecord> {
  if (!payload.reason || String(payload.reason).trim() === '') {
    throw Object.assign(new Error('Alasan perbaikan riwayat tugas wajib diisi.'), {
      statusCode: 400,
      code: 'REASON_REQUIRED'
    });
  }

  const currentRes = await client.query(
    'SELECT * FROM housekeeping_tasks WHERE id = $1 AND property_id = $2',
    [taskId, propertyId]
  );
  if (!hasRows(currentRes)) {
    throw Object.assign(new Error('Tugas housekeeping tidak ditemukan.'), {
      statusCode: 404,
      code: 'TASK_NOT_FOUND'
    });
  }
  const currentTask = currentRes.rows[0];

  const assignedUserId = payload.assigned_user_id !== undefined ? payload.assigned_user_id : currentTask.assigned_user_id;
  const assignedName = payload.assigned_user_name_snapshot !== undefined ? payload.assigned_user_name_snapshot : currentTask.assigned_user_name_snapshot;
  const priority = payload.priority || currentTask.priority;
  const title = payload.title || currentTask.title;
  const description = payload.description !== undefined ? payload.description : currentTask.description;
  const scheduledAt = payload.scheduled_at !== undefined ? payload.scheduled_at : currentTask.scheduled_at;
  const dueAt = payload.due_at !== undefined ? payload.due_at : currentTask.due_at;
  const completionNote = payload.completion_note !== undefined ? payload.completion_note : currentTask.completion_note;

  const updateRes = await client.query(
    `UPDATE housekeeping_tasks
     SET assigned_user_id = $1,
         assigned_user_name_snapshot = $2,
         priority = $3,
         title = $4,
         description = $5,
         scheduled_at = $6,
         due_at = $7,
         completion_note = $8,
         updated_at = NOW()
     WHERE id = $9 AND property_id = $10
     RETURNING *`,
    [
      assignedUserId,
      assignedName,
      priority,
      title,
      description,
      scheduledAt,
      dueAt,
      completionNote,
      taskId,
      propertyId
    ]
  );

  const updatedTask = updateRes.rows[0];

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'HOUSEKEEPING',
      'HK_TASK_HISTORY_CORRECTED',
      'HOUSEKEEPING_TASK',
      Number(taskId),
      JSON.stringify({ previous: currentTask, updated_fields: payload, updated_task: updatedTask, reason: payload.reason }),
      actor?.name || 'Supervisor',
      propertyId
    ]
  );

  return updatedTask;
}

export async function archiveHousekeepingTask(
  client: PoolClient,
  propertyId: number,
  taskId: number,
  reason?: string,
  actor?: { id?: number; name?: string; role?: string }
): Promise<HousekeepingTaskRecord> {
  const currentRes = await client.query(
    'SELECT * FROM housekeeping_tasks WHERE id = $1 AND property_id = $2',
    [taskId, propertyId]
  );
  if (!hasRows(currentRes)) {
    throw Object.assign(new Error('Tugas housekeeping tidak ditemukan.'), {
      statusCode: 404,
      code: 'TASK_NOT_FOUND'
    });
  }

  const updateRes = await client.query(
    `UPDATE housekeeping_tasks
     SET is_archived = TRUE,
         archived_at = NOW(),
         archived_by = $1,
         archive_reason = $2,
         updated_at = NOW()
     WHERE id = $3 AND property_id = $4
     RETURNING *`,
    [actor?.name || 'Staff', reason || null, taskId, propertyId]
  );

  const updatedTask = updateRes.rows[0];

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'HOUSEKEEPING',
      'HK_TASK_ARCHIVED',
      'HOUSEKEEPING_TASK',
      Number(taskId),
      JSON.stringify({ reason: reason, archived_by: actor?.name || 'Staff' }),
      actor?.name || 'Staff',
      propertyId
    ]
  );

  return updatedTask;
}

export async function unarchiveHousekeepingTask(
  client: PoolClient,
  propertyId: number,
  taskId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<HousekeepingTaskRecord> {
  const currentRes = await client.query(
    'SELECT * FROM housekeeping_tasks WHERE id = $1 AND property_id = $2',
    [taskId, propertyId]
  );
  if (!hasRows(currentRes)) {
    throw Object.assign(new Error('Tugas housekeeping tidak ditemukan.'), {
      statusCode: 404,
      code: 'TASK_NOT_FOUND'
    });
  }

  const updateRes = await client.query(
    `UPDATE housekeeping_tasks
     SET is_archived = FALSE,
         archived_at = NULL,
         archived_by = NULL,
         archive_reason = NULL,
         updated_at = NOW()
     WHERE id = $1 AND property_id = $2
     RETURNING *`,
    [taskId, propertyId]
  );

  const updatedTask = updateRes.rows[0];

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'HOUSEKEEPING',
      'HK_TASK_UNARCHIVED',
      'HOUSEKEEPING_TASK',
      Number(taskId),
      JSON.stringify({ unarchived_by: actor?.name || 'Staff' }),
      actor?.name || 'Staff',
      propertyId
    ]
  );

  return updatedTask;
}

// -----------------------------------------------------------------------------
// Finding Types Catalog Management
// -----------------------------------------------------------------------------

export async function getFindingTypes(
  client: PoolClient | Pool,
  propertyId: number,
  options?: 'all' | 'active' | { scope?: 'all' | 'active' }
): Promise<HousekeepingFindingType[]> {
  const scope = typeof options === 'string' ? options : (options?.scope || 'all');
  let sql = `SELECT * FROM housekeeping_finding_types WHERE property_id = $1`;
  if (scope === 'active') {
    sql += ` AND is_active = TRUE`;
  }
  sql += ` ORDER BY sort_order ASC, id ASC`;
  const res = await client.query(sql, [propertyId]);
  return res.rows;
}

export async function createFindingType(
  client: PoolClient,
  propertyId: number,
  payload: CreateFindingTypePayload,
  actor?: { id?: number; name?: string; role?: string }
): Promise<HousekeepingFindingType> {
  const code = (payload.code || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const label = (payload.label || '').trim();
  if (!code) {
    throw Object.assign(new Error('Kode jenis temuan wajib diisi.'), { statusCode: 400, code: 'CODE_REQUIRED' });
  }
  if (!label) {
    throw Object.assign(new Error('Nama label jenis temuan wajib diisi.'), { statusCode: 400, code: 'LABEL_REQUIRED' });
  }

  const existing = await client.query(
    'SELECT id FROM housekeeping_finding_types WHERE property_id = $1 AND code = $2',
    [propertyId, code]
  );
  if (hasRows(existing)) {
    throw Object.assign(new Error(`Jenis temuan dengan kode '${code}' sudah ada pada properti ini.`), { statusCode: 400, code: 'DUPLICATE_CODE' });
  }

  let sortOrder = payload.sort_order;
  if (sortOrder === undefined || sortOrder === null) {
    const maxRes = await client.query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort FROM housekeeping_finding_types WHERE property_id = $1',
      [propertyId]
    );
    sortOrder = Number(maxRes.rows[0]?.next_sort || 1);
  }

  const res = await client.query(
    `INSERT INTO housekeeping_finding_types (
      property_id, code, label, description, severity, is_active,
      sort_order, note_required, photo_required, estimated_charge_allowed, supervisor_review_required, block_room_ready,
      created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11, $12,
      NOW(), NOW()
    ) RETURNING *`,
    [
      propertyId,
      code,
      label,
      payload.description || null,
      payload.severity || 'MEDIUM',
      payload.is_active !== undefined ? Boolean(payload.is_active) : true,
      sortOrder,
      payload.note_required !== undefined ? Boolean(payload.note_required) : false,
      payload.photo_required !== undefined ? Boolean(payload.photo_required) : false,
      payload.estimated_charge_allowed !== undefined ? Boolean(payload.estimated_charge_allowed) : true,
      payload.supervisor_review_required !== undefined ? Boolean(payload.supervisor_review_required) : false,
      payload.block_room_ready !== undefined ? Boolean(payload.block_room_ready) : false
    ]
  );

  const created: HousekeepingFindingType = res.rows[0];

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_FINDING_TYPE_CREATED', 'FINDING_TYPE', String(created.id), JSON.stringify(created), actor?.name || 'Admin', propertyId]
  );

  return created;
}

export async function updateFindingType(
  client: PoolClient,
  propertyId: number,
  id: number,
  payload: UpdateFindingTypePayload,
  actor?: { id?: number; name?: string; role?: string }
): Promise<HousekeepingFindingType> {
  const currentRes = await client.query(
    'SELECT * FROM housekeeping_finding_types WHERE id = $1 AND property_id = $2',
    [id, propertyId]
  );
  if (!hasRows(currentRes)) {
    throw Object.assign(new Error('Jenis temuan tidak ditemukan.'), { statusCode: 404, code: 'NOT_FOUND' });
  }
  const current = currentRes.rows[0];

  let code = current.code;
  if (payload.code && payload.code.trim()) {
    code = payload.code.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (code !== current.code) {
      const dup = await client.query(
        'SELECT id FROM housekeeping_finding_types WHERE property_id = $1 AND code = $2 AND id <> $3',
        [propertyId, code, id]
      );
      if (hasRows(dup)) {
        throw Object.assign(new Error(`Kode jenis temuan '${code}' sudah digunakan.`), { statusCode: 400, code: 'DUPLICATE_CODE' });
      }
    }
  }

  const label = payload.label !== undefined ? payload.label.trim() : current.label;
  const description = payload.description !== undefined ? payload.description : current.description;
  const severity = payload.severity !== undefined ? payload.severity : current.severity;
  const isActive = payload.is_active !== undefined ? Boolean(payload.is_active) : current.is_active;
  const sortOrder = payload.sort_order !== undefined ? Number(payload.sort_order) : current.sort_order;
  const noteRequired = payload.note_required !== undefined ? Boolean(payload.note_required) : current.note_required;
  const photoRequired = payload.photo_required !== undefined ? Boolean(payload.photo_required) : current.photo_required;
  const chargeAllowed = payload.estimated_charge_allowed !== undefined ? Boolean(payload.estimated_charge_allowed) : current.estimated_charge_allowed;
  const supReview = payload.supervisor_review_required !== undefined ? Boolean(payload.supervisor_review_required) : current.supervisor_review_required;
  const blockReady = payload.block_room_ready !== undefined ? Boolean(payload.block_room_ready) : current.block_room_ready;

  const res = await client.query(
    `UPDATE housekeeping_finding_types
     SET code = $1, label = $2, description = $3, severity = $4, is_active = $5,
         sort_order = $6, note_required = $7, photo_required = $8,
         estimated_charge_allowed = $9, supervisor_review_required = $10, block_room_ready = $11,
         updated_at = NOW()
     WHERE id = $12 AND property_id = $13
     RETURNING *`,
    [code, label, description, severity, isActive, sortOrder, noteRequired, photoRequired, chargeAllowed, supReview, blockReady, id, propertyId]
  );

  const updated: HousekeepingFindingType = res.rows[0];

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_FINDING_TYPE_UPDATED', 'FINDING_TYPE', String(id), JSON.stringify(updated), actor?.name || 'Admin', propertyId]
  );

  return updated;
}

export async function reorderFindingTypes(
  client: PoolClient | Pool,
  propertyId: number,
  items: (number | { id: number; sort_order?: number })[],
  actor?: { id?: number; name?: string; role?: string }
): Promise<HousekeepingFindingType[]> {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const id = typeof it === 'number' ? it : Number(it.id);
    const sortOrder = typeof it === 'number' ? (i + 1) : (it.sort_order !== undefined ? Number(it.sort_order) : (i + 1));
    await client.query(
      `UPDATE housekeeping_finding_types SET sort_order = $1, updated_at = NOW() WHERE id = $2 AND property_id = $3`,
      [sortOrder, id, propertyId]
    );
  }
  return getFindingTypes(client, propertyId, { scope: 'all' });
}

// -------------------------------------------------------------------------
// Task Findings & Room Readiness Blocking Lifecycle
// -------------------------------------------------------------------------

export async function createTaskFinding(
  client: PoolClient,
  propertyId: number,
  taskId: number,
  payload: {
    finding_type_id?: number | null;
    finding_type_code?: string;
    finding_type_label?: string;
    severity?: string;
    notes?: string | null;
    photo_storage_key?: string | null;
    estimated_charge?: number | null;
    block_room_ready?: boolean;
  },
  actor?: { id?: number; name?: string; role?: string }
): Promise<HousekeepingTaskFinding> {
  const taskRes = await client.query(
    'SELECT id, property_id, room_id, room_number, reservation_id FROM housekeeping_tasks WHERE id = $1 AND property_id = $2',
    [taskId, propertyId]
  );
  if (!hasRows(taskRes)) {
    throw Object.assign(new Error('Tugas housekeeping tidak ditemukan.'), { statusCode: 404, code: 'TASK_NOT_FOUND' });
  }
  const task = taskRes.rows[0];

  let findingTypeId = payload.finding_type_id || null;
  let findingCode = payload.finding_type_code || 'LAINNYA';
  let findingLabel = payload.finding_type_label || 'Temuan Khusus';
  let severity = payload.severity || 'MEDIUM';
  let blockRoomReady = payload.block_room_ready !== undefined ? Boolean(payload.block_room_ready) : false;
  let estimatedCharge = payload.estimated_charge !== undefined && payload.estimated_charge !== null ? Number(payload.estimated_charge) : 0;

  // Lookup in finding catalog if code or id is provided
  if (findingTypeId || payload.finding_type_code) {
    const ftRes = await client.query(
      `SELECT * FROM housekeeping_finding_types WHERE property_id = $1 AND (id = $2 OR code = $3) LIMIT 1`,
      [propertyId, findingTypeId || -1, payload.finding_type_code || '']
    );
    if (hasRows(ftRes)) {
      const ft = ftRes.rows[0];
      findingTypeId = ft.id;
      findingCode = ft.code;
      findingLabel = ft.label;
      severity = ft.severity;
      blockRoomReady = Boolean(ft.block_room_ready);

      if (ft.note_required && (!payload.notes || payload.notes.trim().length === 0)) {
        throw Object.assign(new Error(`Catatan temuan wajib diisi untuk jenis temuan '${ft.label}'.`), { statusCode: 400, code: 'NOTE_REQUIRED' });
      }
      if (!ft.estimated_charge_allowed) {
        estimatedCharge = 0;
      }
    }
  }

  const res = await client.query(
    `INSERT INTO housekeeping_task_findings (
      property_id, task_id, room_id, room_number, reservation_id,
      finding_type_id, finding_type_code, finding_type_label, severity,
      notes, photo_storage_key, estimated_charge, block_room_ready, status,
      reported_by_user_id, reported_by_name, reported_by_role, reported_at,
      created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9,
      $10, $11, $12, $13, 'OPEN',
      $14, $15, $16, NOW(),
      NOW(), NOW()
    ) RETURNING *`,
    [
      propertyId,
      taskId,
      task.room_id || null,
      task.room_number || null,
      task.reservation_id || null,
      findingTypeId,
      findingCode,
      findingLabel,
      severity,
      payload.notes || null,
      payload.photo_storage_key || null,
      estimatedCharge,
      blockRoomReady,
      actor?.id || null,
      actor?.name || 'Staff',
      actor?.role || 'Housekeeping Staff'
    ]
  );

  const finding: HousekeepingTaskFinding = res.rows[0];

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_FINDING_REPORTED', 'FINDING', String(finding.id), JSON.stringify(finding), actor?.name || 'Staff', propertyId]
  );

  return finding;
}

export async function getTaskFindings(
  client: PoolClient | Pool,
  propertyId: number,
  taskId: number
): Promise<HousekeepingTaskFinding[]> {
  const res = await client.query(
    `SELECT * FROM housekeeping_task_findings
     WHERE property_id = $1 AND task_id = $2
     ORDER BY id ASC`,
    [propertyId, taskId]
  );
  return res.rows;
}

export async function getRoomActiveFindings(
  client: PoolClient | Pool,
  propertyId: number,
  roomId: number
): Promise<HousekeepingTaskFinding[]> {
  const res = await client.query(
    `SELECT * FROM housekeeping_task_findings
     WHERE property_id = $1 AND room_id = $2 AND status = 'OPEN'
     ORDER BY id DESC`,
    [propertyId, roomId]
  );
  return res.rows;
}

export async function resolveFinding(
  client: PoolClient,
  propertyId: number,
  findingId: number,
  payload: { resolution_note: string },
  actor?: { id?: number; name?: string; role?: string }
): Promise<HousekeepingTaskFinding> {
  const findingRes = await client.query(
    'SELECT * FROM housekeeping_task_findings WHERE id = $1 AND property_id = $2 FOR UPDATE',
    [findingId, propertyId]
  );
  if (!hasRows(findingRes)) {
    throw Object.assign(new Error('Temuan kendala tidak ditemukan.'), { statusCode: 404, code: 'FINDING_NOT_FOUND' });
  }

  const res = await client.query(
    `UPDATE housekeeping_task_findings
     SET status = 'RESOLVED',
         resolved_by_user_id = $1,
         resolved_by_name = $2,
         resolved_by_role = $3,
         resolved_at = NOW(),
         resolution_note = $4,
         updated_at = NOW()
     WHERE id = $5 AND property_id = $6
     RETURNING *`,
    [actor?.id || null, actor?.name || 'Staff', actor?.role || 'Staff', payload.resolution_note || 'Resolved', findingId, propertyId]
  );

  const resolved: HousekeepingTaskFinding = res.rows[0];

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_FINDING_RESOLVED', 'FINDING', String(findingId), JSON.stringify(resolved), actor?.name || 'Staff', propertyId]
  );

  return resolved;
}

export async function verifyFinding(
  client: PoolClient,
  propertyId: number,
  findingId: number,
  payload: { verification_note?: string },
  actor?: { id?: number; name?: string; role?: string }
): Promise<HousekeepingTaskFinding> {
  const findingRes = await client.query(
    'SELECT * FROM housekeeping_task_findings WHERE id = $1 AND property_id = $2 FOR UPDATE',
    [findingId, propertyId]
  );
  if (!hasRows(findingRes)) {
    throw Object.assign(new Error('Temuan kendala tidak ditemukan.'), { statusCode: 404, code: 'FINDING_NOT_FOUND' });
  }

  const res = await client.query(
    `UPDATE housekeeping_task_findings
     SET status = 'VERIFIED',
         verified_by_user_id = $1,
         verified_by_name = $2,
         verified_by_role = $3,
         verified_at = NOW(),
         updated_at = NOW()
     WHERE id = $4 AND property_id = $5
     RETURNING *`,
    [actor?.id || null, actor?.name || 'Supervisor', actor?.role || 'Supervisor', findingId, propertyId]
  );

  const verified: HousekeepingTaskFinding = res.rows[0];

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_FINDING_VERIFIED', 'FINDING', String(findingId), JSON.stringify(verified), actor?.name || 'Supervisor', propertyId]
  );

  return verified;
}

// -----------------------------------------------------------------------------
// Checklist Template Management
// -----------------------------------------------------------------------------

export async function createChecklistTemplate(
  client: PoolClient,
  propertyId: number,
  payload: CreateChecklistTemplatePayload,
  actor?: { id?: number; name?: string; role?: string }
): Promise<ChecklistTemplate> {
  const name = (payload.name || '').trim();
  const code = (payload.code || name.replace(/[^a-zA-Z0-9]/g, '_')).trim().toUpperCase();
  const taskType = (payload.task_type || 'ROOM_CLEANING').trim().toUpperCase();
  const description = payload.description ? payload.description.trim() : null;
  const sortOrder = payload.sort_order !== undefined ? Number(payload.sort_order) : 0;
  const isActive = payload.is_active !== undefined ? Boolean(payload.is_active) : true;
  const reqVerif = payload.requires_verification !== undefined ? Boolean(payload.requires_verification) : false;

  if (!name) {
    throw Object.assign(new Error('Nama template checklist wajib diisi.'), { statusCode: 400, code: 'NAME_REQUIRED' });
  }
  if (!code) {
    throw Object.assign(new Error('Kode template checklist wajib diisi.'), { statusCode: 400, code: 'CODE_REQUIRED' });
  }

  const existing = await client.query(
    'SELECT id FROM checklist_templates WHERE property_id = $1 AND code = $2',
    [propertyId, code]
  );
  if (hasRows(existing)) {
    throw Object.assign(new Error(`Template checklist dengan kode '${code}' sudah ada pada properti ini.`), {
      statusCode: 400,
      code: 'DUPLICATE_CODE'
    });
  }

  const res = await client.query(
    `INSERT INTO checklist_templates (
      property_id, code, name, task_type, description, sort_order, is_active, is_system_template, is_archived, requires_verification, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, FALSE, FALSE, $8, NOW(), NOW()
    ) RETURNING *`,
    [propertyId, code, name, taskType, description, sortOrder, isActive, reqVerif]
  );

  const created: ChecklistTemplate = res.rows[0];
  created.items = [];

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_TEMPLATE_CREATED', 'CHECKLIST_TEMPLATE', String(created.id), JSON.stringify(created), actor?.name || 'Admin', propertyId]
  );

  return created;
}

export async function updateChecklistTemplate(
  client: PoolClient,
  propertyId: number,
  templateId: number,
  payload: UpdateChecklistTemplatePayload,
  actor?: { id?: number; name?: string; role?: string }
): Promise<ChecklistTemplate> {
  const tplCheck = await client.query(
    'SELECT * FROM checklist_templates WHERE id = $1 AND property_id = $2',
    [templateId, propertyId]
  );
  if (!hasRows(tplCheck)) {
    throw Object.assign(new Error('Template checklist tidak ditemukan.'), { statusCode: 404, code: 'NOT_FOUND' });
  }
  const current = tplCheck.rows[0];

  const name = payload.name !== undefined ? payload.name.trim() : current.name;
  const description = payload.description !== undefined ? (payload.description ? payload.description.trim() : null) : current.description;
  const taskType = payload.task_type !== undefined ? payload.task_type.trim().toUpperCase() : current.task_type;
  const sortOrder = payload.sort_order !== undefined ? Number(payload.sort_order) : current.sort_order;
  const isActive = payload.is_active !== undefined ? Boolean(payload.is_active) : current.is_active;
  const isArchived = payload.is_archived !== undefined ? Boolean(payload.is_archived) : current.is_archived;
  const reqVerif = payload.requires_verification !== undefined ? Boolean(payload.requires_verification) : current.requires_verification;

  if (!name) {
    throw Object.assign(new Error('Nama template checklist tidak boleh kosong.'), { statusCode: 400, code: 'NAME_REQUIRED' });
  }

  const res = await client.query(
    `UPDATE checklist_templates
     SET name = $1, description = $2, task_type = $3, sort_order = $4, is_active = $5, is_archived = $6, requires_verification = $7, updated_at = NOW()
     WHERE id = $8 AND property_id = $9
     RETURNING *`,
    [name, description, taskType, sortOrder, isActive, isArchived, reqVerif, templateId, propertyId]
  );

  const updated: ChecklistTemplate = res.rows[0];
  const itemsRes = await client.query(
    'SELECT * FROM checklist_template_items WHERE template_id = $1 ORDER BY sort_order ASC, id ASC',
    [templateId]
  );
  updated.items = itemsRes.rows;

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_TEMPLATE_UPDATED', 'CHECKLIST_TEMPLATE', String(templateId), JSON.stringify(updated), actor?.name || 'Admin', propertyId]
  );

  return updated;
}

export async function duplicateChecklistTemplate(
  client: PoolClient,
  propertyId: number,
  templateId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<ChecklistTemplate> {
  const tplCheck = await client.query(
    'SELECT * FROM checklist_templates WHERE id = $1 AND property_id = $2',
    [templateId, propertyId]
  );
  if (!hasRows(tplCheck)) {
    throw Object.assign(new Error('Template checklist tidak ditemukan.'), { statusCode: 404, code: 'NOT_FOUND' });
  }
  const original = tplCheck.rows[0];

  const suffix = Math.floor(1000 + Math.random() * 9000);
  let duplicateCode = `${original.code}_COPY_${suffix}`;
  let duplicateName = `${original.name} (Salinan)`;

  const res = await client.query(
    `INSERT INTO checklist_templates (
      property_id, code, name, task_type, description, sort_order, is_active, is_system_template, is_archived, requires_verification, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, TRUE, FALSE, FALSE, $7, NOW(), NOW()
    ) RETURNING *`,
    [propertyId, duplicateCode, duplicateName, original.task_type, original.description, (original.sort_order || 0) + 1, original.requires_verification]
  );

  const newTemplate: ChecklistTemplate = res.rows[0];

  // Duplicate groups
  const groupsRes = await client.query(
    `SELECT * FROM checklist_template_groups WHERE template_id = $1 AND is_archived = FALSE ORDER BY sort_order ASC, id ASC`,
    [templateId]
  );
  const oldToNewGroupMap = new Map<number, number>();
  const copiedGroups: ChecklistTemplateGroup[] = [];

  for (const grp of groupsRes.rows) {
    const insGrp = await client.query(
      `INSERT INTO checklist_template_groups (
        property_id, template_id, code, name, description, sort_order, is_active, is_archived, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, NOW(), NOW())
      RETURNING *`,
      [propertyId, newTemplate.id, grp.code, grp.name, grp.description, grp.sort_order, grp.is_active]
    );
    const newGrp = insGrp.rows[0];
    newGrp.items = [];
    oldToNewGroupMap.set(grp.id, newGrp.id);
    copiedGroups.push(newGrp);
  }

  // Duplicate items
  const itemsRes = await client.query(
    `SELECT * FROM checklist_template_items WHERE template_id = $1 AND is_archived = FALSE ORDER BY sort_order ASC, id ASC`,
    [templateId]
  );

  const copiedItems: ChecklistTemplateItem[] = [];
  for (const item of itemsRes.rows) {
    const newGroupId = item.group_id ? oldToNewGroupMap.get(item.group_id) || null : null;
    const insItem = await client.query(
      `INSERT INTO checklist_template_items (
        template_id, group_id, section, label, description, sort_order, is_required, requires_note, requires_photo, is_active, is_archived, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE, NOW(), NOW())
      RETURNING *`,
      [newTemplate.id, newGroupId, item.section, item.label, item.description, item.sort_order, item.is_required, item.requires_note, item.requires_photo, item.is_active]
    );
    copiedItems.push(insItem.rows[0]);
  }
  newTemplate.groups = copiedGroups;
  newTemplate.items = copiedItems;

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_TEMPLATE_DUPLICATED', 'CHECKLIST_TEMPLATE', String(newTemplate.id), JSON.stringify({ source_template_id: templateId, duplicate: newTemplate }), actor?.name || 'Admin', propertyId]
  );

  return newTemplate;
}

export async function deleteChecklistTemplate(
  client: PoolClient,
  propertyId: number,
  templateId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<{ success: boolean; archived?: boolean; deleted?: boolean; message: string }> {
  const tplCheck = await client.query(
    'SELECT * FROM checklist_templates WHERE id = $1 AND property_id = $2',
    [templateId, propertyId]
  );
  if (!hasRows(tplCheck)) {
    throw Object.assign(new Error('Template checklist tidak ditemukan.'), { statusCode: 404, code: 'NOT_FOUND' });
  }
  const tpl = tplCheck.rows[0];

  // 1. Check if configured as default in settings
  const settingsCheck = await client.query(
    `SELECT 1 FROM property_housekeeping_settings
     WHERE property_id = $1 AND (default_cleaning_template_code = $2 OR default_checkout_template_code = $2 OR default_final_inspection_template_code = $2)`,
    [propertyId, tpl.code]
  );
  const isConfiguredDefault = hasRows(settingsCheck);

  // 2. Check if referenced by task snapshot items
  const taskRefCheck = await client.query(
    `SELECT 1 FROM housekeeping_task_checklist_items tci
     JOIN checklist_template_items ti ON ti.id = tci.template_item_id
     WHERE ti.template_id = $1
     LIMIT 1`,
    [templateId]
  );
  const isReferencedInTasks = hasRows(taskRefCheck);

  if (tpl.is_system_template || isConfiguredDefault || isReferencedInTasks) {
    // Soft archive / deactivate template, groups, and items
    await client.query(
      `UPDATE checklist_templates SET is_active = FALSE, is_archived = TRUE, updated_at = NOW() WHERE id = $1 AND property_id = $2`,
      [templateId, propertyId]
    );
    await client.query(
      `UPDATE checklist_template_groups SET is_active = FALSE, is_archived = TRUE, updated_at = NOW() WHERE template_id = $1 AND property_id = $2`,
      [templateId, propertyId]
    );
    await client.query(
      `UPDATE checklist_template_items SET is_active = FALSE, is_archived = TRUE, updated_at = NOW() WHERE template_id = $1`,
      [templateId]
    );

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['HOUSEKEEPING', 'HK_TEMPLATE_ARCHIVED', 'CHECKLIST_TEMPLATE', String(templateId), JSON.stringify({ is_archived: true, is_active: false }), actor?.name || 'Admin', propertyId]
    );

    return {
      success: true,
      archived: true,
      deleted: false,
      message: 'Template checklist telah diarsipkan dengan aman karena memiliki riwayat tugas atau merupakan template standard.'
    };
  }

  // Safe hard delete for unreferenced custom template
  await client.query('DELETE FROM checklist_template_items WHERE template_id = $1', [templateId]);
  await client.query('DELETE FROM checklist_template_groups WHERE template_id = $1 AND property_id = $2', [templateId, propertyId]);
  await client.query('DELETE FROM checklist_templates WHERE id = $1 AND property_id = $2', [templateId, propertyId]);

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_TEMPLATE_DELETED', 'CHECKLIST_TEMPLATE', String(templateId), JSON.stringify({ deleted: true }), actor?.name || 'Admin', propertyId]
  );

  return {
    success: true,
    archived: false,
    deleted: true,
    message: 'Template checklist berhasil dihapus permanen.'
  };
}

// -----------------------------------------------------------------------------
// Checklist Template Group Management (EMP-MOBILE-3F)
// -----------------------------------------------------------------------------

export async function getChecklistTemplateGroups(
  client: PoolClient | Pool,
  propertyId: number,
  templateId: number
): Promise<ChecklistTemplateGroup[]> {
  const groupsRes = await client.query(
    `SELECT * FROM checklist_template_groups
     WHERE property_id = $1 AND template_id = $2 AND is_archived = FALSE
     ORDER BY sort_order ASC, id ASC`,
    [propertyId, templateId]
  );

  const groups: ChecklistTemplateGroup[] = groupsRes.rows;
  if (groups.length === 0) return [];

  const groupIds = groups.map((g) => g.id);
  const itemsRes = await client.query(
    `SELECT i.*, g.name AS group_name, g.code AS group_code, COALESCE(g.sort_order, 0) AS group_sort_order
     FROM checklist_template_items i
     LEFT JOIN checklist_template_groups g ON g.id = i.group_id
     WHERE i.group_id = ANY($1::int[]) AND i.is_archived = FALSE
     ORDER BY i.sort_order ASC, i.id ASC`,
    [groupIds]
  );

  const itemsByGroup: Record<number, ChecklistTemplateItem[]> = {};
  for (const item of itemsRes.rows) {
    if (!itemsByGroup[item.group_id]) {
      itemsByGroup[item.group_id] = [];
    }
    itemsByGroup[item.group_id].push(item);
  }

  return groups.map((g) => ({
    ...g,
    items: itemsByGroup[g.id] || []
  }));
}

export async function addChecklistTemplateGroup(
  client: PoolClient | Pool,
  propertyId: number,
  templateId: number,
  payload: CreateChecklistTemplateGroupPayload,
  actor?: { id?: number; name?: string; role?: string }
): Promise<ChecklistTemplateGroup> {
  const tplCheck = await client.query(
    'SELECT id, name FROM checklist_templates WHERE id = $1 AND property_id = $2',
    [templateId, propertyId]
  );
  if (!hasRows(tplCheck)) {
    throw Object.assign(new Error('Template checklist tidak ditemukan pada properti ini.'), { statusCode: 404, code: 'NOT_FOUND' });
  }

  const name = (payload.name || '').trim();
  if (!name) {
    throw Object.assign(new Error('Nama grup checklist wajib diisi.'), { statusCode: 400, code: 'NAME_REQUIRED' });
  }

  let code = (payload.code || '').trim().toUpperCase();
  if (!code) {
    code = name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase().slice(0, 40);
  }

  let sortOrder = payload.sort_order;
  if (sortOrder === undefined || sortOrder === null) {
    const maxRes = await client.query(
      'SELECT COALESCE(MAX(sort_order), 0) + 10 AS next_sort FROM checklist_template_groups WHERE template_id = $1',
      [templateId]
    );
    sortOrder = Number(maxRes.rows[0]?.next_sort || 10);
  }

  const isActive = payload.is_active !== undefined ? Boolean(payload.is_active) : true;

  const res = await client.query(
    `INSERT INTO checklist_template_groups (
      property_id, template_id, code, name, description, sort_order, is_active, is_archived, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, NOW(), NOW())
    RETURNING *`,
    [propertyId, templateId, code, name, payload.description ? payload.description.trim() : null, sortOrder, isActive]
  );

  const created: ChecklistTemplateGroup = res.rows[0];
  created.items = [];

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_TEMPLATE_GROUP_CREATED', 'TEMPLATE_GROUP', String(created.id), JSON.stringify(created), actor?.name || 'Admin', propertyId]
  );

  return created;
}

export async function updateChecklistTemplateGroup(
  client: PoolClient | Pool,
  propertyId: number,
  templateId: number,
  groupId: number,
  payload: UpdateChecklistTemplateGroupPayload,
  actor?: { id?: number; name?: string; role?: string }
): Promise<ChecklistTemplateGroup> {
  const grpCheck = await client.query(
    'SELECT * FROM checklist_template_groups WHERE id = $1 AND template_id = $2 AND property_id = $3',
    [groupId, templateId, propertyId]
  );
  if (!hasRows(grpCheck)) {
    throw Object.assign(new Error('Grup checklist tidak ditemukan.'), { statusCode: 404, code: 'NOT_FOUND' });
  }
  const current = grpCheck.rows[0];

  const name = payload.name !== undefined ? payload.name.trim() : current.name;
  if (!name) {
    throw Object.assign(new Error('Nama grup checklist wajib diisi.'), { statusCode: 400, code: 'NAME_REQUIRED' });
  }
  const code = payload.code !== undefined ? payload.code.trim().toUpperCase() : current.code;
  const description = payload.description !== undefined ? (payload.description ? payload.description.trim() : null) : current.description;
  const sortOrder = payload.sort_order !== undefined ? Number(payload.sort_order) : current.sort_order;
  const isActive = payload.is_active !== undefined ? Boolean(payload.is_active) : current.is_active;
  const isArchived = payload.is_archived !== undefined ? Boolean(payload.is_archived) : (current.is_archived || false);

  const res = await client.query(
    `UPDATE checklist_template_groups
     SET name = $1, code = $2, description = $3, sort_order = $4, is_active = $5, is_archived = $6, updated_at = NOW()
     WHERE id = $7 AND template_id = $8 AND property_id = $9
     RETURNING *`,
    [name, code, description, sortOrder, isActive, isArchived, groupId, templateId, propertyId]
  );

  const updated: ChecklistTemplateGroup = res.rows[0];

  const itemsRes = await client.query(
    'SELECT * FROM checklist_template_items WHERE group_id = $1 AND is_archived = FALSE ORDER BY sort_order ASC, id ASC',
    [groupId]
  );
  updated.items = itemsRes.rows;

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_TEMPLATE_GROUP_UPDATED', 'TEMPLATE_GROUP', String(groupId), JSON.stringify(updated), actor?.name || 'Admin', propertyId]
  );

  return updated;
}

export async function deleteChecklistTemplateGroup(
  client: PoolClient | Pool,
  propertyId: number,
  templateId: number,
  groupId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<{ success: boolean; archived?: boolean; deleted?: boolean; message: string }> {
  const grpCheck = await client.query(
    'SELECT * FROM checklist_template_groups WHERE id = $1 AND template_id = $2 AND property_id = $3',
    [groupId, templateId, propertyId]
  );
  if (!hasRows(grpCheck)) {
    throw Object.assign(new Error('Grup checklist tidak ditemukan.'), { statusCode: 404, code: 'NOT_FOUND' });
  }

  // Check if any items belonging to this group are referenced in task snapshots
  const taskRefCheck = await client.query(
    `SELECT 1 FROM housekeeping_task_checklist_items tci
     WHERE tci.group_id = $1 OR tci.source_group_id = $1
        OR EXISTS (
          SELECT 1 FROM checklist_template_items ti WHERE ti.id = tci.template_item_id AND ti.group_id = $1
        )
     LIMIT 1`,
    [groupId]
  );

  if (hasRows(taskRefCheck)) {
    // Soft archive / deactivate group and all its template items
    await client.query(
      `UPDATE checklist_template_groups SET is_active = FALSE, is_archived = TRUE, updated_at = NOW() WHERE id = $1 AND template_id = $2 AND property_id = $3`,
      [groupId, templateId, propertyId]
    );
    await client.query(
      `UPDATE checklist_template_items SET is_active = FALSE, is_archived = TRUE, updated_at = NOW() WHERE group_id = $1 AND template_id = $2`,
      [groupId, templateId]
    );

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['HOUSEKEEPING', 'HK_TEMPLATE_GROUP_ARCHIVED', 'TEMPLATE_GROUP', String(groupId), JSON.stringify({ is_archived: true, is_active: false }), actor?.name || 'Admin', propertyId]
    );

    return {
      success: true,
      archived: true,
      deleted: false,
      message: 'Grup checklist telah diarsipkan dengan aman karena memiliki riwayat tugas operasional.'
    };
  }

  // Hard delete if never referenced
  await client.query('DELETE FROM checklist_template_items WHERE group_id = $1 AND template_id = $2', [groupId, templateId]);
  await client.query('DELETE FROM checklist_template_groups WHERE id = $1 AND template_id = $2 AND property_id = $3', [groupId, templateId, propertyId]);

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_TEMPLATE_GROUP_DELETED', 'TEMPLATE_GROUP', String(groupId), JSON.stringify({ deleted: true }), actor?.name || 'Admin', propertyId]
  );

  return {
    success: true,
    archived: false,
    deleted: true,
    message: 'Grup checklist berhasil dihapus permanen.'
  };
}

export async function reorderChecklistTemplateGroups(
  client: PoolClient | Pool,
  propertyId: number,
  templateId: number,
  groups: (number | { id: number; sort_order?: number })[],
  actor?: { id?: number; name?: string; role?: string }
): Promise<ChecklistTemplateGroup[]> {
  const tplCheck = await client.query(
    'SELECT id FROM checklist_templates WHERE id = $1 AND property_id = $2',
    [templateId, propertyId]
  );
  if (!hasRows(tplCheck)) {
    throw Object.assign(new Error('Template tidak ditemukan.'), { statusCode: 404, code: 'NOT_FOUND' });
  }

  for (let i = 0; i < groups.length; i++) {
    const grp = groups[i];
    const id = typeof grp === 'number' ? grp : Number(grp.id);
    const sortOrder = typeof grp === 'number' ? (i + 1) * 10 : (grp.sort_order !== undefined ? Number(grp.sort_order) : (i + 1) * 10);
    await client.query(
      `UPDATE checklist_template_groups SET sort_order = $1, updated_at = NOW() WHERE id = $2 AND template_id = $3 AND property_id = $4`,
      [sortOrder, id, templateId, propertyId]
    );
  }

  const groupsRes = await client.query(
    'SELECT * FROM checklist_template_groups WHERE template_id = $1 AND is_archived = FALSE ORDER BY sort_order ASC, id ASC',
    [templateId]
  );

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_TEMPLATE_GROUPS_REORDERED', 'CHECKLIST_TEMPLATE', String(templateId), JSON.stringify({ count: groups.length }), actor?.name || 'Admin', propertyId]
  );

  return groupsRes.rows;
}

// -----------------------------------------------------------------------------
// Checklist Template Item Management
// -----------------------------------------------------------------------------

export async function addChecklistTemplateItem(
  client: PoolClient,
  propertyId: number,
  templateId: number,
  payload: CreateChecklistTemplateItemPayload,
  actor?: { id?: number; name?: string; role?: string }
): Promise<ChecklistTemplateItem> {
  const tplCheck = await client.query(
    'SELECT id, name FROM checklist_templates WHERE id = $1 AND property_id = $2',
    [templateId, propertyId]
  );
  if (!hasRows(tplCheck)) {
    throw Object.assign(new Error('Template checklist tidak ditemukan pada properti ini.'), { statusCode: 404, code: 'NOT_FOUND' });
  }

  const label = (payload.label || '').trim();
  const description = payload.description ? payload.description.trim() : null;
  let section = (payload.section || '').trim().toUpperCase();
  const groupId = payload.group_id ? Number(payload.group_id) : null;

  if (groupId && !section) {
    const gRes = await client.query('SELECT name FROM checklist_template_groups WHERE id = $1', [groupId]);
    if (hasRows(gRes)) {
      section = gRes.rows[0].name.toUpperCase();
    }
  }
  if (!section) section = 'CHECKLIST';

  if (!label) {
    throw Object.assign(new Error('Label butir checklist wajib diisi.'), { statusCode: 400, code: 'LABEL_REQUIRED' });
  }

  let sortOrder = payload.sort_order;
  if (sortOrder === undefined || sortOrder === null) {
    const maxRes = await client.query(
      'SELECT COALESCE(MAX(sort_order), 0) + 10 AS next_sort FROM checklist_template_items WHERE template_id = $1 AND ($2::int IS NULL OR group_id = $2)',
      [templateId, groupId]
    );
    sortOrder = Number(maxRes.rows[0]?.next_sort || 10);
  }

  const res = await client.query(
    `INSERT INTO checklist_template_items (
      template_id, group_id, section, label, description, sort_order, is_required, requires_note, requires_photo, is_active, is_archived, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE, NOW(), NOW()
    ) RETURNING *`,
    [
      templateId,
      groupId,
      section,
      label,
      description,
      sortOrder,
      payload.is_required !== undefined && payload.is_required !== null ? Boolean(payload.is_required) : true,
      payload.requires_note !== undefined && payload.requires_note !== null ? Boolean(payload.requires_note) : false,
      payload.requires_photo !== undefined && payload.requires_photo !== null ? Boolean(payload.requires_photo) : false,
      payload.is_active !== undefined && payload.is_active !== null ? Boolean(payload.is_active) : true
    ]
  );

  const created: ChecklistTemplateItem = res.rows[0];

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_TEMPLATE_ITEM_CREATED', 'TEMPLATE_ITEM', String(created.id), JSON.stringify(created), actor?.name || 'Admin', propertyId]
  );

  return created;
}

export async function updateChecklistTemplateItem(
  client: PoolClient,
  propertyId: number,
  templateId: number,
  itemId: number,
  payload: UpdateChecklistTemplateItemPayload,
  actor?: { id?: number; name?: string; role?: string }
): Promise<ChecklistTemplateItem> {
  const itemCheck = await client.query(
    `SELECT i.* FROM checklist_template_items i
     JOIN checklist_templates t ON t.id = i.template_id
     WHERE i.id = $1 AND i.template_id = $2 AND t.property_id = $3`,
    [itemId, templateId, propertyId]
  );
  if (!hasRows(itemCheck)) {
    throw Object.assign(new Error('Butir checklist tidak ditemukan.'), { statusCode: 404, code: 'NOT_FOUND' });
  }
  const current = itemCheck.rows[0];

  let groupId = current.group_id;
  if (payload.group_id !== undefined) {
    groupId = payload.group_id ? Number(payload.group_id) : null;
  }

  let section = payload.section !== undefined ? payload.section.trim().toUpperCase() : current.section;
  if (groupId && (!section || payload.group_id !== undefined)) {
    const gRes = await client.query('SELECT name FROM checklist_template_groups WHERE id = $1', [groupId]);
    if (hasRows(gRes)) {
      section = gRes.rows[0].name.toUpperCase();
    }
  }

  const label = payload.label !== undefined ? payload.label.trim() : current.label;
  const description = payload.description !== undefined ? (payload.description ? payload.description.trim() : null) : current.description;
  const sortOrder = payload.sort_order !== undefined ? Number(payload.sort_order) : current.sort_order;
  const isRequired = payload.is_required !== undefined ? Boolean(payload.is_required) : current.is_required;
  const reqNote = payload.requires_note !== undefined ? Boolean(payload.requires_note) : current.requires_note;
  const reqPhoto = payload.requires_photo !== undefined ? Boolean(payload.requires_photo) : current.requires_photo;
  const isActive = payload.is_active !== undefined ? Boolean(payload.is_active) : current.is_active;
  const isArchived = payload.is_archived !== undefined ? Boolean(payload.is_archived) : (current.is_archived || false);

  const res = await client.query(
    `UPDATE checklist_template_items
     SET group_id = $1, section = $2, label = $3, description = $4, sort_order = $5, is_required = $6,
         requires_note = $7, requires_photo = $8, is_active = $9, is_archived = $10, updated_at = NOW()
     WHERE id = $11 AND template_id = $12
     RETURNING *`,
    [groupId, section, label, description, sortOrder, isRequired, reqNote, reqPhoto, isActive, isArchived, itemId, templateId]
  );

  const updated: ChecklistTemplateItem = res.rows[0];

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_TEMPLATE_ITEM_UPDATED', 'TEMPLATE_ITEM', String(itemId), JSON.stringify(updated), actor?.name || 'Admin', propertyId]
  );

  return updated;
}

export async function deleteChecklistTemplateItem(
  client: PoolClient,
  propertyId: number,
  templateId: number,
  itemId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<{ success: boolean; archived?: boolean; deleted?: boolean; deactivated?: boolean; message: string }> {
  const itemCheck = await client.query(
    `SELECT i.* FROM checklist_template_items i
     JOIN checklist_templates t ON t.id = i.template_id
     WHERE i.id = $1 AND i.template_id = $2 AND t.property_id = $3`,
    [itemId, templateId, propertyId]
  );
  if (!hasRows(itemCheck)) {
    throw Object.assign(new Error('Butir checklist tidak ditemukan.'), { statusCode: 404, code: 'NOT_FOUND' });
  }

  // Check if already referenced in task snapshot items
  const taskRef = await client.query(
    `SELECT 1 FROM housekeeping_task_checklist_items WHERE template_item_id = $1 LIMIT 1`,
    [itemId]
  );

  if (hasRows(taskRef)) {
    // Soft archive / deactivate to preserve historical snapshot references
    await client.query(
      `UPDATE checklist_template_items SET is_active = FALSE, is_archived = TRUE, updated_at = NOW() WHERE id = $1 AND template_id = $2`,
      [itemId, templateId]
    );
    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['HOUSEKEEPING', 'HK_TEMPLATE_ITEM_ARCHIVED', 'TEMPLATE_ITEM', String(itemId), JSON.stringify({ is_archived: true, is_active: false }), actor?.name || 'Admin', propertyId]
    );
    return { success: true, archived: true, deleted: false, deactivated: true, message: 'Butir checklist telah diarsipkan karena memiliki riwayat tugas operasional.' };
  }

  // Hard delete if never referenced
  await client.query(
    `DELETE FROM checklist_template_items WHERE id = $1 AND template_id = $2`,
    [itemId, templateId]
  );

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_TEMPLATE_ITEM_DELETED', 'TEMPLATE_ITEM', String(itemId), JSON.stringify({ deleted: true }), actor?.name || 'Admin', propertyId]
  );

  return { success: true, archived: false, deleted: true, message: 'Butir checklist berhasil dihapus permanen.' };
}

export async function reorderChecklistTemplateItems(
  client: PoolClient | Pool,
  propertyId: number,
  templateId: number,
  items: (number | { id: number; sort_order?: number; group_id?: number | null })[],
  actor?: { id?: number; name?: string; role?: string }
): Promise<ChecklistTemplateItem[]> {
  const tplCheck = await client.query(
    'SELECT id FROM checklist_templates WHERE id = $1 AND property_id = $2',
    [templateId, propertyId]
  );
  if (!hasRows(tplCheck)) {
    throw Object.assign(new Error('Template tidak ditemukan.'), { statusCode: 404, code: 'NOT_FOUND' });
  }

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const id = typeof it === 'number' ? it : Number(it.id);
    const sortOrder = typeof it === 'number' ? (i + 1) * 10 : (it.sort_order !== undefined ? Number(it.sort_order) : (i + 1) * 10);
    const groupId = typeof it === 'object' && it.group_id !== undefined ? it.group_id : undefined;

    if (groupId !== undefined) {
      if (groupId) {
        const gRes = await client.query('SELECT name FROM checklist_template_groups WHERE id = $1', [groupId]);
        const gName = gRes.rows[0]?.name || 'CHECKLIST';
        await client.query(
          `UPDATE checklist_template_items SET sort_order = $1, group_id = $2, section = $3, updated_at = NOW() WHERE id = $4 AND template_id = $5`,
          [sortOrder, groupId, gName, id, templateId]
        );
      } else {
        await client.query(
          `UPDATE checklist_template_items SET sort_order = $1, group_id = NULL, updated_at = NOW() WHERE id = $2 AND template_id = $3`,
          [sortOrder, id, templateId]
        );
      }
    } else {
      await client.query(
        `UPDATE checklist_template_items SET sort_order = $1, updated_at = NOW() WHERE id = $2 AND template_id = $3`,
        [sortOrder, id, templateId]
      );
    }
  }

  const itemsRes = await client.query(
    `SELECT i.*, g.name AS group_name, g.code AS group_code, COALESCE(g.sort_order, 0) AS group_sort_order
     FROM checklist_template_items i
     LEFT JOIN checklist_template_groups g ON g.id = i.group_id
     WHERE i.template_id = $1 AND i.is_archived = FALSE
     ORDER BY COALESCE(g.sort_order, 0) ASC, i.sort_order ASC, i.id ASC`,
    [templateId]
  );

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HOUSEKEEPING', 'HK_TEMPLATE_ITEMS_REORDERED', 'CHECKLIST_TEMPLATE', String(templateId), JSON.stringify({ count: items.length }), actor?.name || 'Admin', propertyId]
  );

  return itemsRes.rows;
}

export type HkTaskCategory =
  | 'ROOM_OPERATIONS'
  | 'SERVICE_REQUEST'
  | 'DEPARTMENT_TASK';

export type HkTaskType =
  | 'ROOM_CLEANING'
  | 'STAYOVER_CLEANING'
  | 'CHECKOUT_ROOM_CHECK'
  | 'FINAL_INSPECTION'
  | 'DEEP_CLEAN'
  | 'VIP_ROOM_PREPARATION'
  | 'TURNDOWN_SERVICE'
  | 'GUEST_SERVICE_DELIVERY'
  | 'DELIVERY_SUPPORT'
  | 'GENERAL_HK_REQUEST'
  | 'INTERNAL_SUPPORT';

export type HkTaskPriority =
  | 'LOW'
  | 'NORMAL'
  | 'HIGH'
  | 'CRITICAL'
  | 'TURNOVER'
  | 'VIP';

export type HkTaskStatus =
  | 'ASSIGNED'
  | 'ACKNOWLEDGED'
  | 'IN_PROGRESS'
  | 'BLOCKED'
  | 'DONE'
  | 'VERIFIED'
  | 'CANCELLED';

export type HkInspectionResult =
  | 'CLEAR'
  | 'ISSUE_FOUND'
  | 'PASS'
  | 'RETURN_TO_CLEANING';

export type HkIssueType =
  | 'MINIBAR'
  | 'DAMAGE'
  | 'LINEN'
  | 'MISSING_HOTEL_ITEM'
  | 'LOST_AND_FOUND'
  | 'OTHER';

export interface TaskChecklistItem {
  id: number;
  task_id: number;
  template_item_id?: number | null;
  group_id?: number | null;
  source_group_id?: number | null;
  group_code?: string | null;
  group_name?: string | null;
  group_sort_order?: number;
  section: string;
  label: string;
  sort_order: number;
  is_required: boolean;
  requires_note: boolean;
  requires_photo: boolean;
  is_completed: boolean;
  completed_at?: string | null;
  completed_by_name?: string | null;
  note?: string | null;
  photo_storage_key?: string | null;
  created_at: string;
  updated_at?: string;
}

export interface HousekeepingTaskRecord {
  id: number;
  property_id: number;
  task_number?: string | null;
  room_id?: number | null;
  room_number?: string | null;
  reservation_id?: number | null;
  guest_id?: number | null;
  task_category: HkTaskCategory;
  task_type: HkTaskType;
  title: string;
  description?: string | null;
  priority: HkTaskPriority;
  status: HkTaskStatus;
  assigned_department: string;
  assigned_user_id?: number | null;
  assigned_user_name_snapshot?: string | null;
  requested_by_user_id?: number | null;
  requested_by_name_snapshot?: string | null;
  requested_by_role_snapshot?: string | null;
  scheduled_at?: string | null;
  due_at?: string | null;
  acknowledged_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  verified_at?: string | null;
  completion_note?: string | null;
  cleaning_note?: string | null;
  cleaning_note_by?: string | null;
  cleaning_note_at?: string | null;
  blocked_reason?: string | null;
  source_type: string;
  source_entity_id?: string | null;
  inspection_result?: HkInspectionResult | null;
  issue_type?: HkIssueType | null;
  issue_note?: string | null;
  estimated_charge?: number | null;
  is_archived?: boolean;
  archived_at?: string | null;
  archived_by?: string | null;
  archive_reason?: string | null;
  created_at: string;
  updated_at: string;

  // Enriched operational fields
  room_status?: string | null;
  room_type_name?: string | null;
  next_arrival?: {
    reservation_id: number;
    guest_name: string;
    check_in: string;
    expected_arrival_time?: string;
  } | null;
  checklist_summary?: {
    total: number;
    completed: number;
    required_total: number;
    required_completed: number;
  };
  checklist_items?: TaskChecklistItem[];
}

export interface HousekeepingDailyMetrics {
  date: string;
  dirty: number;
  cleaning: number;
  waiting_inspection: number;
  vacant_clean?: number;
  inspected?: number;
  ready: number;
  checkout_check: number;
  overdue: number;
  priority_turnover: number;
}

export interface ChecklistTemplateGroup {
  id: number;
  property_id: number;
  template_id: number;
  code?: string | null;
  name: string;
  description?: string | null;
  sort_order: number;
  is_active: boolean;
  is_archived?: boolean;
  created_at: string;
  updated_at?: string;
  items?: ChecklistTemplateItem[];
}

export interface ChecklistTemplateItem {
  id: number;
  template_id: number;
  group_id?: number | null;
  group_name?: string | null;
  group_code?: string | null;
  group_sort_order?: number;
  section: string;
  label: string;
  description?: string | null;
  sort_order: number;
  is_required: boolean;
  requires_note: boolean;
  requires_photo: boolean;
  is_active: boolean;
  is_archived?: boolean;
  created_at: string;
  updated_at?: string;
}

export interface ChecklistTemplate {
  id: number;
  property_id: number;
  code: string;
  name: string;
  task_type: HkTaskType | string;
  description?: string | null;
  sort_order?: number;
  is_system_template?: boolean;
  is_active: boolean;
  is_archived?: boolean;
  requires_verification: boolean;
  created_at: string;
  updated_at: string;
  items?: ChecklistTemplateItem[];
  groups?: ChecklistTemplateGroup[];
}

export interface PropertyHousekeepingSettings {
  id: number;
  property_id: number;
  require_final_inspection: boolean;
  require_checkout_room_check: boolean;
  allow_calendar_room_status_override: boolean;
  default_cleaning_template_code: string;
  default_room_cleaning_template_code?: string;
  default_checkout_template_code: string;
  default_checkout_inspection_template_code?: string;
  default_final_inspection_template_code?: string;
  created_at: string;
  updated_at: string;
}

export interface HistoryEditPayload {
  assigned_user_id?: number | null;
  assigned_user_name_snapshot?: string | null;
  priority?: HkTaskPriority;
  title?: string;
  description?: string;
  scheduled_at?: string | null;
  due_at?: string | null;
  completion_note?: string | null;
  reason: string;
}

export type FindingSeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface HousekeepingFindingType {
  id: number;
  property_id: number;
  code: string;
  label: string;
  description?: string | null;
  severity: FindingSeverity;
  is_active: boolean;
  sort_order: number;
  note_required: boolean;
  photo_required: boolean;
  estimated_charge_allowed: boolean;
  supervisor_review_required: boolean;
  block_room_ready: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateFindingTypePayload {
  code: string;
  label: string;
  description?: string | null;
  severity?: FindingSeverity;
  is_active?: boolean;
  sort_order?: number;
  note_required?: boolean;
  photo_required?: boolean;
  estimated_charge_allowed?: boolean;
  supervisor_review_required?: boolean;
  block_room_ready?: boolean;
}

export interface UpdateFindingTypePayload {
  code?: string;
  label?: string;
  description?: string | null;
  severity?: FindingSeverity;
  is_active?: boolean;
  sort_order?: number;
  note_required?: boolean;
  photo_required?: boolean;
  estimated_charge_allowed?: boolean;
  supervisor_review_required?: boolean;
  block_room_ready?: boolean;
}

export interface HousekeepingTaskFinding {
  id: number;
  property_id: number;
  task_id?: number | null;
  room_id?: number | null;
  room_number?: string | null;
  reservation_id?: number | null;
  finding_type_id?: number | null;
  finding_type_code: string;
  finding_type_label: string;
  severity: FindingSeverity;
  notes?: string | null;
  photo_storage_key?: string | null;
  estimated_charge?: number;
  block_room_ready: boolean;
  status: 'OPEN' | 'RESOLVED' | 'VERIFIED' | 'CANCELLED';
  reported_by_user_id?: number | null;
  reported_by_name?: string | null;
  reported_by_role?: string | null;
  reported_at: string;
  resolved_by_user_id?: number | null;
  resolved_by_name?: string | null;
  resolved_by_role?: string | null;
  resolved_at?: string | null;
  resolution_note?: string | null;
  verified_by_user_id?: number | null;
  verified_by_name?: string | null;
  verified_by_role?: string | null;
  verified_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTaskFindingPayload {
  finding_type_id?: number | null;
  finding_type_code?: string;
  finding_type_label?: string;
  severity?: FindingSeverity;
  notes?: string | null;
  photo_storage_key?: string | null;
  estimated_charge?: number;
  block_room_ready?: boolean;
}

export interface ResolveFindingPayload {
  resolution_note: string;
}

export interface VerifyFindingPayload {
  verification_note?: string;
}

export interface CreateChecklistTemplatePayload {
  code: string;
  name: string;
  task_type?: HkTaskType | string;
  description?: string | null;
  sort_order?: number;
  is_active?: boolean;
  requires_verification?: boolean;
}

export interface UpdateChecklistTemplatePayload {
  name?: string;
  task_type?: HkTaskType | string;
  description?: string | null;
  sort_order?: number;
  is_active?: boolean;
  is_archived?: boolean;
  requires_verification?: boolean;
}

export interface CreateChecklistTemplateGroupPayload {
  name: string;
  code?: string;
  description?: string | null;
  sort_order?: number;
  is_active?: boolean;
}

export interface UpdateChecklistTemplateGroupPayload {
  name?: string;
  code?: string;
  description?: string | null;
  sort_order?: number;
  is_active?: boolean;
  is_archived?: boolean;
}

export interface CreateChecklistTemplateItemPayload {
  group_id?: number | null;
  section?: string;
  label: string;
  description?: string | null;
  sort_order?: number;
  is_required?: boolean;
  requires_note?: boolean;
  requires_photo?: boolean;
  is_active?: boolean;
}

export interface UpdateChecklistTemplateItemPayload {
  group_id?: number | null;
  section?: string;
  label?: string;
  description?: string | null;
  sort_order?: number;
  is_required?: boolean;
  requires_note?: boolean;
  requires_photo?: boolean;
  is_active?: boolean;
  is_archived?: boolean;
}

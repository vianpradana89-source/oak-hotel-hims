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
  blocked_reason?: string | null;
  source_type: string;
  source_entity_id?: string | null;
  inspection_result?: HkInspectionResult | null;
  issue_type?: HkIssueType | null;
  issue_note?: string | null;
  estimated_charge?: number | null;
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

export interface ChecklistTemplateItem {
  id: number;
  template_id: number;
  section: string;
  label: string;
  sort_order: number;
  is_required: boolean;
  requires_note: boolean;
  requires_photo: boolean;
  is_active: boolean;
  created_at: string;
}

export interface ChecklistTemplate {
  id: number;
  property_id: number;
  code: string;
  name: string;
  task_type: HkTaskType;
  is_active: boolean;
  requires_verification: boolean;
  created_at: string;
  updated_at: string;
  items?: ChecklistTemplateItem[];
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
  created_at: string;
  updated_at: string;
}

export type HousekeepingTab =
  | 'room_operations'
  | 'checkout_inspection'
  | 'service_requests'
  | 'department_tasks'
  | 'history'
  | 'templates_settings';

// backend/src/domains/attendance/attendanceTypes.ts

/**
 * Mobile Attendance Types (Preserved for compatibility)
 */
export type AttendanceType = 'CHECK_IN' | 'CHECK_OUT';

export type GeofenceResult = 'INSIDE' | 'OUTSIDE' | 'DISABLED' | 'UNKNOWN';

export type OutsideGeofencePolicy = 'BLOCK' | 'ALLOW_WITH_REASON' | 'REQUIRE_APPROVAL';

export interface PropertyAttendanceSettings {
  id?: number;
  property_id: number;
  attendance_enabled: boolean;
  require_employee_attendance: boolean;
  require_checkin_photo: boolean;
  require_checkout_photo: boolean;
  geofence_enabled: boolean;
  geofence_latitude: number | null;
  geofence_longitude: number | null;
  geofence_radius_meters: number;
  outside_geofence_policy: OutsideGeofencePolicy;
  exempt_roles: string[];
  created_at?: string;
  updated_at?: string;
}

export interface EmployeeAttendanceRecord {
  id: number;
  property_id: number;
  employee_id: number | null;
  employee_name: string;
  department: string | null;
  attendance_date: string; // YYYY-MM-DD (hotel date in Asia/Jakarta)
  attendance_type: AttendanceType;
  server_recorded_at: string;
  latitude: number | null;
  longitude: number | null;
  location_accuracy_meters: number | null;
  property_distance_meters: number | null;
  geofence_result: GeofenceResult;
  photo_storage_key: string | null;
  source: string;
  status: AttendanceStatus;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface AttendanceStatusResponse {
  property_id: number;
  employee_id: number;
  employee_name: string;
  department: string;
  hotel_date: string;
  server_time: string;
  timezone: string;
  attendance_required: boolean;
  is_exempt: boolean;
  has_checked_in: boolean;
  has_checked_out: boolean;
  check_in_record: EmployeeAttendanceRecord | null;
  check_out_record: EmployeeAttendanceRecord | null;
  settings: PropertyAttendanceSettings;
}

export interface RecordAttendancePayload {
  property_id: number;
  employee_id?: number | null;
  employee_name?: string;
  department?: string;
  attendance_type: AttendanceType;
  latitude?: number | null;
  longitude?: number | null;
  location_accuracy_meters?: number | null;
  reason?: string | null;
}

/**
 * Account Lifecycle States
 */
export type AccountStatus =
  | 'INVITED'
  | 'FIRST_LOGIN_REQUIRED'
  | 'FACE_ENROLLMENT_REQUIRED'
  | 'READY'
  | 'SUSPENDED'
  | 'DISABLED';

/**
 * Face Enrollment Statuses
 */
export type FaceEnrollmentStatus =
  | 'PENDING'
  | 'ENROLLED'
  | 'NEEDS_REVIEW'
  | 'REVOKED';

export type FaceQualityStatus =
  | 'NOT_EVALUATED'
  | 'GOOD'
  | 'FAIR'
  | 'POOR'
  | 'UNACCEPTABLE';

export type FaceReviewStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED';

/**
 * Face Verification Result (for attendance clock-in / clock-out)
 */
export type FaceVerificationStatus =
  | 'VERIFIED'
  | 'REVIEW_REQUIRED'
  | 'REJECTED'
  | 'NOT_PROCESSED';

/**
 * Work Schedule Statuses
 */
export type ScheduleStatus =
  | 'DRAFT'
  | 'PUBLISHED'
  | 'CHANGED'
  | 'CANCELLED';

/**
 * Work Schedule Type / Day Status
 */
export type WorkStatusType =
  | 'WORK'
  | 'OFF'
  | 'LEAVE'
  | 'SICK'
  | 'PERMISSION'
  | 'HOLIDAY'
  | 'OTHER';

/**
 * Authoritative Canonical Attendance Statuses (incorporates legacy + canonical)
 */
export type AttendanceStatus =
  | 'ACCEPTED'
  | 'OUTSIDE_GEOFENCE'
  | 'PENDING_APPROVAL'
  | 'REJECTED'
  | 'PRESENT'
  | 'LATE'
  | 'ABSENT'
  | 'LEAVE'
  | 'SICK'
  | 'PERMISSION'
  | 'OFF'
  | 'INCOMPLETE'
  | 'REVIEW_REQUIRED';

export type AttendanceReviewStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'ESCALATED';

/**
 * Work Shift Template Model
 */
export interface WorkShiftTemplate {
  id: number;
  property_id: number;
  code: string;
  name: string;
  start_time: string; // HH:MM:SS
  end_time: string;   // HH:MM:SS
  crosses_midnight: boolean;
  grace_before_minutes: number;
  late_grace_minutes: number;
  checkout_grace_minutes: number;
  is_active: boolean;
  department_id: number | null; // null = global/shared, number = department-scoped
  color_key: string; // manual soft color token e.g. 'soft_green', 'soft_blue', etc.
  created_at?: string;
  updated_at?: string;
}

/**
 * Employee Work Schedule Model
 */
export interface EmployeeWorkSchedule {
  id: number;
  property_id: number;
  employee_id: number;
  work_date: string; // YYYY-MM-DD
  shift_template_id: number | null;
  schedule_status: ScheduleStatus;
  work_status: WorkStatusType;
  scheduled_start_at: string | null; // ISO timestamp
  scheduled_end_at: string | null;   // ISO timestamp
  department_snapshot?: string | null;
  position_snapshot?: string | null;
  published_at?: string | null;
  published_by_user_id?: number | null;
  published_by_name?: string | null;
  notes?: string | null;
  created_by_user_id?: number | null;
  updated_by_user_id?: number | null;
  created_at?: string;
  updated_at?: string;
}

/**
 * Schedule Change Audit
 */
export interface WorkScheduleAudit {
  id: number;
  schedule_id: number;
  property_id: number;
  employee_id: number;
  action:
    | 'CREATED'
    | 'PUBLISHED'
    | 'SHIFT_CHANGED'
    | 'STATUS_CHANGED'
    | 'CANCELLED'
    | 'CORRECTED'
    | 'CORRECTION_REMOVED';
  old_shift_template_id?: number | null;
  new_shift_template_id?: number | null;
  old_work_status?: WorkStatusType | null;
  new_work_status?: WorkStatusType | null;
  reason?: string | null;
  changed_by_user_id?: number | null;
  changed_by_name?: string | null;
  created_at?: string;
}

/**
 * Employee Face Enrollment Model
 */
export interface EmployeeFaceEnrollment {
  id: number;
  property_id: number;
  employee_id: number;
  status: FaceEnrollmentStatus;
  reference_photo_storage_key: string;
  reference_photo_hash: string;
  enrolled_at?: string | null;
  enrolled_by_user_id?: number | null;
  enrolled_by_name?: string | null;
  verification_provider?: string | null;
  verification_version?: string | null;
  quality_status: FaceQualityStatus;
  review_status: FaceReviewStatus;
  reviewed_by_user_id?: number | null;
  reviewed_at?: string | null;
  review_notes?: string | null;
  revoked_at?: string | null;
  revoked_by_user_id?: number | null;
  revocation_reason?: string | null;
  created_at?: string;
  updated_at?: string;
}

/**
 * Canonical Employee Attendance Record (Full Work-Cycle)
 */
export interface EmployeeAttendance {
  id: number;
  property_id: number;
  employee_id: number;
  schedule_id?: number | null;
  work_date: string; // YYYY-MM-DD

  // Immutability snapshots from published schedule
  scheduled_start_snapshot?: string | null;
  scheduled_end_snapshot?: string | null;
  shift_code_snapshot?: string | null;
  shift_name_snapshot?: string | null;

  // Actual clock events
  clock_in_at?: string | null;
  clock_out_at?: string | null;

  // Photos (stored separately, never overwrite)
  clock_in_photo_storage_key?: string | null;
  clock_out_photo_storage_key?: string | null;
  clock_in_photo_hash?: string | null;
  clock_out_photo_hash?: string | null;

  // Face & Liveness
  clock_in_face_status: FaceVerificationStatus;
  clock_out_face_status: FaceVerificationStatus;
  clock_in_liveness_status: FaceVerificationStatus;
  clock_out_liveness_status: FaceVerificationStatus;

  // Location / Geofence
  clock_in_location_status?: string | null;
  clock_out_location_status?: string | null;

  // Calculated Metrics
  late_minutes: number;
  early_leave_minutes: number;
  overtime_minutes: number;
  worked_minutes: number;

  attendance_status: AttendanceStatus;
  review_status: AttendanceReviewStatus;
  reviewed_by_user_id?: number | null;
  reviewed_at?: string | null;
  review_note?: string | null;

  created_at?: string;
  updated_at?: string;
}

/**
 * Monthly Attendance & Task Performance Projection
 */
export interface EmployeeMonthlyReportProjection {
  property_id: number;
  employee_id: number;
  employee_name: string;
  employee_code: string;
  department: string;
  position: string;
  year: number;
  month: number; // 1-12

  // Attendance metrics
  scheduled_work_days: number;
  present_days: number;
  late_days: number;
  total_late_minutes: number;
  absent_days: number;
  leave_days: number;
  sick_days: number;
  permission_days: number;
  off_days: number;

  total_worked_minutes: number;
  approved_overtime_minutes: number;
  early_leave_count: number;

  // Face verification metrics
  clock_in_face_verified_count: number;
  clock_out_face_verified_count: number;
  face_review_required_count: number;

  // Operational task performance (projected from operational tables)
  tasks_assigned: number;
  tasks_completed: number;
  tasks_late: number;
  task_completion_rate: number; // 0.0 - 100.0%
}

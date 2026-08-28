// frontend/src/features/employee/attendanceTypes.ts

export type AttendanceType = 'CHECK_IN' | 'CHECK_OUT';
export type GeofenceResult = 'INSIDE' | 'OUTSIDE' | 'UNKNOWN' | 'DISABLED';
export type AttendanceStatus = 'ACCEPTED' | 'OUTSIDE_GEOFENCE' | 'PENDING_APPROVAL' | 'REJECTED';
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
  updated_at?: string;
}

export interface EmployeeAttendanceStatus {
  attendance_enabled: boolean;
  require_employee_attendance: boolean;
  is_exempt: boolean;
  attendance_required: boolean;
  has_checked_in: boolean;
  has_checked_out: boolean;
  today_check_in: EmployeeAttendanceRecord | null;
  today_check_out: EmployeeAttendanceRecord | null;
  hotel_date: string;
  server_time: string;
  timezone: string;
  settings: PropertyAttendanceSettings;
}

export interface EmployeeAttendanceRecord {
  id: number;
  property_id: number;
  employee_id: number | null;
  employee_name: string;
  department: string | null;
  attendance_date: string;
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

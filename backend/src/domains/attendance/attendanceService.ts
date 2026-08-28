import path from 'path';
import fs from 'fs';
import { Pool, PoolClient } from 'pg';
import {
  PropertyAttendanceSettings,
  EmployeeAttendanceRecord,
  AttendanceStatusResponse,
  RecordAttendancePayload,
  GeofenceResult,
  AttendanceStatus
} from './attendanceTypes';
import { isFeatureEnabled } from '../features/featureService';
import { hotelDateFromInstant } from '../../utils/hotelDate';

const UPLOADS_DIR = path.resolve(__dirname, '../../../uploads');
const ATTENDANCE_UPLOADS_DIR = path.join(UPLOADS_DIR, 'attendance');

function ensureAttendanceUploadsDir() {
  if (!fs.existsSync(ATTENDANCE_UPLOADS_DIR)) {
    fs.mkdirSync(ATTENDANCE_UPLOADS_DIR, { recursive: true });
  }
}

/**
 * Haversine formula to calculate distance between two coordinates in meters.
 */
export function calculateHaversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // Earth radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

export function formatAttendanceSettings(row: any): PropertyAttendanceSettings {
  let exemptRoles: string[] = ['Owner', 'General Manager'];
  if (Array.isArray(row.exempt_roles)) {
    exemptRoles = row.exempt_roles;
  } else if (typeof row.exempt_roles === 'string') {
    try {
      exemptRoles = JSON.parse(row.exempt_roles);
    } catch {
      exemptRoles = ['Owner', 'General Manager'];
    }
  }

  return {
    id: row.id,
    property_id: Number(row.property_id),
    attendance_enabled: Boolean(row.attendance_enabled),
    require_employee_attendance: Boolean(row.require_employee_attendance),
    require_checkin_photo: Boolean(row.require_checkin_photo),
    require_checkout_photo: Boolean(row.require_checkout_photo),
    geofence_enabled: Boolean(row.geofence_enabled),
    geofence_latitude: row.geofence_latitude !== null && row.geofence_latitude !== undefined ? Number(row.geofence_latitude) : null,
    geofence_longitude: row.geofence_longitude !== null && row.geofence_longitude !== undefined ? Number(row.geofence_longitude) : null,
    geofence_radius_meters: Number(row.geofence_radius_meters || 100),
    outside_geofence_policy: row.outside_geofence_policy || 'ALLOW_WITH_REASON',
    exempt_roles: exemptRoles,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export async function getAttendanceSettings(
  db: Pool | PoolClient,
  propertyId: number
): Promise<PropertyAttendanceSettings> {
  const res = await db.query(
    'SELECT * FROM property_attendance_settings WHERE property_id = $1',
    [propertyId]
  );
  if (res.rows.length > 0) {
    return formatAttendanceSettings(res.rows[0]);
  }

  // Create default
  const insertRes = await db.query(
    `INSERT INTO property_attendance_settings (
       property_id, attendance_enabled, require_employee_attendance,
       require_checkin_photo, require_checkout_photo, geofence_enabled,
       geofence_radius_meters, outside_geofence_policy
     ) VALUES ($1, TRUE, TRUE, TRUE, FALSE, FALSE, 100, 'ALLOW_WITH_REASON')
     ON CONFLICT (property_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [propertyId]
  );
  return formatAttendanceSettings(insertRes.rows[0]);
}

export async function updateAttendanceSettings(
  client: PoolClient,
  propertyId: number,
  patch: Partial<PropertyAttendanceSettings>,
  actor: { id?: number; name?: string; role?: string }
): Promise<PropertyAttendanceSettings> {
  const current = await getAttendanceSettings(client, propertyId);

  const attendanceEnabled = typeof patch.attendance_enabled === 'boolean' ? patch.attendance_enabled : current.attendance_enabled;
  const requireEmployeeAttendance = typeof patch.require_employee_attendance === 'boolean' ? patch.require_employee_attendance : current.require_employee_attendance;
  const requireCheckinPhoto = typeof patch.require_checkin_photo === 'boolean' ? patch.require_checkin_photo : current.require_checkin_photo;
  const requireCheckoutPhoto = typeof patch.require_checkout_photo === 'boolean' ? patch.require_checkout_photo : current.require_checkout_photo;
  const geofenceEnabled = typeof patch.geofence_enabled === 'boolean' ? patch.geofence_enabled : current.geofence_enabled;
  const geofenceLat = patch.geofence_latitude !== undefined ? patch.geofence_latitude : current.geofence_latitude;
  const geofenceLng = patch.geofence_longitude !== undefined ? patch.geofence_longitude : current.geofence_longitude;
  const geofenceRadius = patch.geofence_radius_meters !== undefined ? Number(patch.geofence_radius_meters) : current.geofence_radius_meters;
  const outsidePolicy = patch.outside_geofence_policy || current.outside_geofence_policy;
  const exemptRoles = patch.exempt_roles || current.exempt_roles;

  const res = await client.query(
    `INSERT INTO property_attendance_settings (
       property_id, attendance_enabled, require_employee_attendance,
       require_checkin_photo, require_checkout_photo, geofence_enabled,
       geofence_latitude, geofence_longitude, geofence_radius_meters,
       outside_geofence_policy, exempt_roles, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
     ON CONFLICT (property_id) DO UPDATE SET
       attendance_enabled = EXCLUDED.attendance_enabled,
       require_employee_attendance = EXCLUDED.require_employee_attendance,
       require_checkin_photo = EXCLUDED.require_checkin_photo,
       require_checkout_photo = EXCLUDED.require_checkout_photo,
       geofence_enabled = EXCLUDED.geofence_enabled,
       geofence_latitude = EXCLUDED.geofence_latitude,
       geofence_longitude = EXCLUDED.geofence_longitude,
       geofence_radius_meters = EXCLUDED.geofence_radius_meters,
       outside_geofence_policy = EXCLUDED.outside_geofence_policy,
       exempt_roles = EXCLUDED.exempt_roles,
       updated_at = NOW()
     RETURNING *`,
    [
      propertyId,
      attendanceEnabled,
      requireEmployeeAttendance,
      requireCheckinPhoto,
      requireCheckoutPhoto,
      geofenceEnabled,
      geofenceLat,
      geofenceLng,
      geofenceRadius,
      outsidePolicy,
      JSON.stringify(exemptRoles)
    ]
  );

  const updatedSettings = formatAttendanceSettings(res.rows[0]);

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'HRD',
      'UPDATE_ATTENDANCE_SETTINGS',
      'PROPERTY_ATTENDANCE_SETTINGS',
      Number(propertyId),
      JSON.stringify({ previous: current, updated: updatedSettings }),
      actor?.name || 'Admin',
      propertyId
    ]
  );

  return updatedSettings;
}

export async function getEmployeeAttendanceStatus(
  db: Pool | PoolClient,
  propertyId: number,
  employeeId: number | null,
  employeeRole?: string
): Promise<AttendanceStatusResponse> {
  const settings = await getAttendanceSettings(db, propertyId);
  const hotelDate = hotelDateFromInstant(new Date());
  const serverTime = new Date().toISOString();

  let employeeName = 'Employee';
  let department = 'General';

  if (employeeId) {
    const empRes = await db.query('SELECT full_name, department, position FROM hr_employees WHERE id = $1', [employeeId]);
    if (empRes.rows.length > 0) {
      employeeName = empRes.rows[0].full_name;
      department = empRes.rows[0].department || department;
      if (!employeeRole && empRes.rows[0].position) {
        employeeRole = empRes.rows[0].position;
      }
    }
  }

  const isExempt = Boolean(
    !settings.require_employee_attendance ||
    (employeeRole && settings.exempt_roles.some(r => r.toLowerCase() === employeeRole?.toLowerCase()))
  );

  let checkInRecord: EmployeeAttendanceRecord | null = null;
  let checkOutRecord: EmployeeAttendanceRecord | null = null;

  if (employeeId) {
    const recordsRes = await db.query(
      `SELECT * FROM employee_attendance_records
       WHERE property_id = $1 AND employee_id = $2 AND attendance_date = $3
       ORDER BY id ASC`,
      [propertyId, employeeId, hotelDate]
    );

    for (const r of recordsRes.rows) {
      if (r.attendance_type === 'CHECK_IN' && !checkInRecord) {
        checkInRecord = r;
      } else if (r.attendance_type === 'CHECK_OUT') {
        checkOutRecord = r;
      }
    }
  }

  return {
    property_id: propertyId,
    employee_id: employeeId || 0,
    employee_name: employeeName,
    department: department,
    hotel_date: hotelDate,
    server_time: serverTime,
    timezone: 'Asia/Jakarta',
    attendance_required: settings.attendance_enabled && !isExempt,
    is_exempt: isExempt,
    has_checked_in: Boolean(checkInRecord),
    has_checked_out: Boolean(checkOutRecord),
    check_in_record: checkInRecord,
    check_out_record: checkOutRecord,
    settings: settings
  };
}

export function saveAttendancePhotoFile(
  propertyId: number,
  file: Express.Multer.File
): string {
  ensureAttendanceUploadsDir();
  const ext = path.extname(file.originalname) || '.jpg';
  const filename = `att_p${propertyId}_${Date.now()}_${Math.round(Math.random() * 1e9)}${ext}`;
  const fullPath = path.join(ATTENDANCE_UPLOADS_DIR, filename);

  fs.writeFileSync(fullPath, file.buffer);
  return `attendance/${filename}`;
}

export async function recordAttendance(
  pool: Pool,
  propertyId: number,
  payload: RecordAttendancePayload,
  file?: Express.Multer.File,
  actor?: { id?: number; name?: string; role?: string }
): Promise<EmployeeAttendanceRecord> {
  // 1. Feature Flag Check
  const isHrdEnabled = await isFeatureEnabled(pool, propertyId, 'hrd.enabled');
  const isAttEnabled = isHrdEnabled && (await isFeatureEnabled(pool, propertyId, 'hrd.attendance'));
  if (!isAttEnabled) {
    const err: any = new Error('Attendance module is disabled for this property');
    err.statusCode = 403;
    err.code = 'FEATURE_DISABLED';
    throw err;
  }

  const settings = await getAttendanceSettings(pool, propertyId);
  const hotelDate = hotelDateFromInstant(new Date());
  const attType = payload.attendance_type;

  if (attType !== 'CHECK_IN' && attType !== 'CHECK_OUT') {
    const err: any = new Error('Invalid attendance_type. Must be CHECK_IN or CHECK_OUT');
    err.statusCode = 400;
    err.code = 'INVALID_ATTENDANCE_TYPE';
    throw err;
  }

  let employeeId = payload.employee_id ? Number(payload.employee_id) : null;
  let employeeName = payload.employee_name || actor?.name || 'Staff';
  let department = payload.department || 'Housekeeping';

  if (employeeId) {
    const empRes = await pool.query('SELECT full_name, department, position FROM hr_employees WHERE id = $1', [employeeId]);
    if (empRes.rows.length > 0) {
      employeeName = empRes.rows[0].full_name;
      department = empRes.rows[0].department || department;
    }
  }

  // Check duplicate CHECK_IN
  if (attType === 'CHECK_IN' && employeeId) {
    const existingCheckIn = await pool.query(
      `SELECT * FROM employee_attendance_records
       WHERE property_id = $1 AND employee_id = $2 AND attendance_date = $3 AND attendance_type = 'CHECK_IN'`,
      [propertyId, employeeId, hotelDate]
    );
    if (existingCheckIn.rows.length > 0) {
      // Return existing record idempotently
      return existingCheckIn.rows[0];
    }
  }

  // 2. Photo validation
  const isPhotoFeatureEnabled = await isFeatureEnabled(pool, propertyId, 'hrd.attendance_photo');
  let photoStorageKey: string | null = null;

  if (file && isPhotoFeatureEnabled) {
    photoStorageKey = saveAttendancePhotoFile(propertyId, file);
  }

  if (attType === 'CHECK_IN' && settings.require_checkin_photo && isPhotoFeatureEnabled && !photoStorageKey) {
    const err: any = new Error('Selfie photo is required for attendance check-in');
    err.statusCode = 400;
    err.code = 'PHOTO_REQUIRED';
    throw err;
  }

  if (attType === 'CHECK_OUT' && settings.require_checkout_photo && isPhotoFeatureEnabled && !photoStorageKey) {
    const err: any = new Error('Photo is required for attendance check-out');
    err.statusCode = 400;
    err.code = 'PHOTO_REQUIRED';
    throw err;
  }

  // 3. Geofence & Location evaluation
  let geofenceResult: GeofenceResult = 'DISABLED';
  let status: AttendanceStatus = 'ACCEPTED';
  let distanceMeters: number | null = null;
  const lat = payload.latitude !== undefined && payload.latitude !== null ? Number(payload.latitude) : null;
  const lng = payload.longitude !== undefined && payload.longitude !== null ? Number(payload.longitude) : null;
  const accuracy = payload.location_accuracy_meters !== undefined && payload.location_accuracy_meters !== null ? Number(payload.location_accuracy_meters) : null;

  if (settings.geofence_enabled && settings.geofence_latitude && settings.geofence_longitude) {
    if (lat !== null && lng !== null) {
      distanceMeters = calculateHaversineDistanceMeters(
        lat,
        lng,
        settings.geofence_latitude,
        settings.geofence_longitude
      );

      if (distanceMeters <= settings.geofence_radius_meters) {
        geofenceResult = 'INSIDE';
        status = 'ACCEPTED';
      } else {
        geofenceResult = 'OUTSIDE';
        if (settings.outside_geofence_policy === 'BLOCK') {
          const err: any = new Error(`Lokasi di luar batas geofence (${distanceMeters}m dari properti, maks ${settings.geofence_radius_meters}m)`);
          err.statusCode = 400;
          err.code = 'OUTSIDE_GEOFENCE_BLOCKED';
          throw err;
        } else if (settings.outside_geofence_policy === 'ALLOW_WITH_REASON') {
          if (!payload.reason || String(payload.reason).trim() === '') {
            const err: any = new Error('Alasan diperlukan karena absensi dilakukan di luar lokasi hotel');
            err.statusCode = 400;
            err.code = 'GEOFENCE_REASON_REQUIRED';
            throw err;
          }
          status = 'OUTSIDE_GEOFENCE';
        } else if (settings.outside_geofence_policy === 'REQUIRE_APPROVAL') {
          status = 'PENDING_APPROVAL';
        }
      }
    } else {
      geofenceResult = 'UNKNOWN';
      if (settings.outside_geofence_policy === 'BLOCK') {
        const err: any = new Error('Izin lokasi GPS diperlukan untuk absensi');
        err.statusCode = 400;
        err.code = 'LOCATION_REQUIRED';
        throw err;
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const insertRes = await client.query(
      `INSERT INTO employee_attendance_records (
         property_id, employee_id, employee_name, department,
         attendance_date, attendance_type, server_recorded_at,
         latitude, longitude, location_accuracy_meters, property_distance_meters,
         geofence_result, photo_storage_key, source, status, reason, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, NOW() AT TIME ZONE 'Asia/Jakarta',
         $7, $8, $9, $10,
         $11, $12, 'MOBILE_WEB', $13, $14, NOW(), NOW()
       ) RETURNING *`,
      [
        propertyId,
        employeeId,
        employeeName,
        department,
        hotelDate,
        attType,
        lat,
        lng,
        accuracy,
        distanceMeters,
        geofenceResult,
        photoStorageKey,
        status,
        payload.reason || null
      ]
    );

    const record = insertRes.rows[0];

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'HRD',
        attType === 'CHECK_IN' ? 'EMPLOYEE_ATTENDANCE_CHECKIN' : 'EMPLOYEE_ATTENDANCE_CHECKOUT',
        'EMPLOYEE_ATTENDANCE_RECORD',
        Number(record.id),
        JSON.stringify({
          employee_id: employeeId,
          employee_name: employeeName,
          attendance_type: attType,
          status: status,
          geofence_result: geofenceResult,
          distance_meters: distanceMeters,
          hotel_date: hotelDate
        }),
        actor?.name || employeeName,
        propertyId
      ]
    );

    await client.query('COMMIT');
    return record;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getAttendanceRecords(
  pool: Pool,
  propertyId: number,
  filters: {
    start_date?: string;
    end_date?: string;
    department?: string;
    employee_id?: number;
    status?: string;
    attendance_type?: string;
  }
): Promise<EmployeeAttendanceRecord[]> {
  const conditions: string[] = ['property_id = $1'];
  const values: any[] = [propertyId];
  let idx = 2;

  if (filters.start_date) {
    conditions.push(`attendance_date >= $${idx}`);
    values.push(filters.start_date);
    idx++;
  }
  if (filters.end_date) {
    conditions.push(`attendance_date <= $${idx}`);
    values.push(filters.end_date);
    idx++;
  }
  if (filters.department) {
    conditions.push(`department = $${idx}`);
    values.push(filters.department);
    idx++;
  }
  if (filters.employee_id) {
    conditions.push(`employee_id = $${idx}`);
    values.push(filters.employee_id);
    idx++;
  }
  if (filters.status) {
    conditions.push(`status = $${idx}`);
    values.push(filters.status);
    idx++;
  }
  if (filters.attendance_type) {
    conditions.push(`attendance_type = $${idx}`);
    values.push(filters.attendance_type);
    idx++;
  }

  const query = `
    SELECT * FROM employee_attendance_records
    WHERE ${conditions.join(' AND ')}
    ORDER BY server_recorded_at DESC, id DESC
    LIMIT 200
  `;

  const res = await pool.query(query, values);
  return res.rows;
}

export function getAttendancePhotoFilePath(storageKey: string): string | null {
  if (!storageKey || storageKey.includes('..')) {
    return null;
  }
  const cleanKey = storageKey.replace(/^attendance\//, '');
  const fullPath = path.join(ATTENDANCE_UPLOADS_DIR, cleanKey);
  if (fs.existsSync(fullPath)) {
    return fullPath;
  }
  return null;
}

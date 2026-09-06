import { Pool, PoolClient } from 'pg';
import {
  PropertyAttendanceSettings,
  EmployeeAttendanceRecord,
  AttendanceStatusResponse,
  RecordAttendancePayload,
  GeofenceResult,
  AttendanceStatus,
  FaceVerificationStatus
} from './attendanceTypes';
import { isFeatureEnabled } from '../features/featureService';
import { hotelDateFromInstant } from '../../utils/hotelDate';
import { ATTENDANCE_FACE_NOT_PROCESSED, type SelfAttendanceActor } from './attendanceIdentity';
import {
  deleteAttendanceSelfie,
  getLegacyAttendancePhotoFilePath,
  saveAttendanceSelfie
} from './attendancePhotoStorageService';

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

  let employeeName = '';
  let department = '';
  let departmentId: number | null = null;
  let departmentName: string | null = null;
  let positionId: number | null = null;
  let positionName: string | null = null;

  if (employeeId) {
    const empRes = await db.query(
      `SELECT e.full_name, e.department, e.position, e.department_id, e.position_id,
              d.name AS department_name, p.name AS position_name
       FROM hr_employees e
       LEFT JOIN hr_departments d ON d.id = e.department_id
       LEFT JOIN hr_positions p ON p.id = e.position_id
       WHERE e.id = $1 AND ($2::int IS NULL OR e.property_id = $2 OR e.property_id IS NULL)`,
      [employeeId, propertyId]
    );
    if (empRes.rows.length > 0) {
      const emp = empRes.rows[0];
      employeeName = emp.full_name;
      departmentName = emp.department_name || emp.department || null;
      positionName = emp.position_name || emp.position || null;
      departmentId = emp.department_id != null ? Number(emp.department_id) : null;
      positionId = emp.position_id != null ? Number(emp.position_id) : null;
      department = departmentName || '';
      if (!employeeRole && positionName) {
        employeeRole = positionName;
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
        checkInRecord = formatAttendanceRecord(r);
      } else if (r.attendance_type === 'CHECK_OUT') {
        checkOutRecord = formatAttendanceRecord(r);
      }
    }
  }

  return {
    property_id: propertyId,
    employee_id: employeeId || 0,
    employee_name: employeeName,
    department: department,
    department_id: departmentId,
    department_name: departmentName,
    position_id: positionId,
    position_name: positionName,
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

export function formatAttendanceRecord(row: any): EmployeeAttendanceRecord {
  const faceStatus = normalizeUnverifiedFaceStatus(row.face_status);
  const livenessStatus = normalizeUnverifiedFaceStatus(row.liveness_status);
  return {
    ...row,
    id: Number(row.id),
    property_id: Number(row.property_id),
    employee_id: row.employee_id != null ? Number(row.employee_id) : null,
    photo_storage_key: row.photo_storage_key || null,
    photo_hash: row.photo_hash || null,
    photo_mime_type: row.photo_mime_type || null,
    photo_captured_at: row.photo_captured_at ? new Date(row.photo_captured_at).toISOString() : null,
    face_status: faceStatus,
    liveness_status: livenessStatus
  };
}

function normalizeUnverifiedFaceStatus(raw: unknown): FaceVerificationStatus {
  const value = String(raw || ATTENDANCE_FACE_NOT_PROCESSED).toUpperCase();
  if (value === 'VERIFIED' || value === 'MATCH') {
    return ATTENDANCE_FACE_NOT_PROCESSED;
  }
  if (value === 'REVIEW_REQUIRED' || value === 'REJECTED' || value === 'NOT_PROCESSED') {
    return value;
  }
  return ATTENDANCE_FACE_NOT_PROCESSED;
}

function mapLocationStatus(geofenceResult: GeofenceResult): string {
  if (geofenceResult === 'INSIDE') return 'INSIDE';
  if (geofenceResult === 'OUTSIDE') return 'OUTSIDE';
  if (geofenceResult === 'UNKNOWN') return 'UNKNOWN';
  return 'NOT_EVALUATED';
}

async function upsertCanonicalAttendance(
  client: PoolClient,
  params: {
    propertyId: number;
    employeeId: number;
    workDate: string;
    attendanceType: 'CHECK_IN' | 'CHECK_OUT';
    photoStorageKey: string | null;
    photoHash: string | null;
    geofenceResult: GeofenceResult;
  }
): Promise<void> {
  const locationStatus = mapLocationStatus(params.geofenceResult);
  const isCheckIn = params.attendanceType === 'CHECK_IN';

  await client.query(
    `INSERT INTO employee_attendance (
       property_id, employee_id, work_date,
       clock_in_at, clock_out_at,
       clock_in_photo_storage_key, clock_out_photo_storage_key,
       clock_in_photo_hash, clock_out_photo_hash,
       clock_in_face_status, clock_out_face_status,
       clock_in_liveness_status, clock_out_liveness_status,
       clock_in_location_status, clock_out_location_status,
       attendance_status, review_status,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3,
       CASE WHEN $4 THEN NOW() ELSE NULL END,
       CASE WHEN $4 THEN NULL ELSE NOW() END,
       CASE WHEN $4 THEN $5 ELSE NULL END,
       CASE WHEN $4 THEN NULL ELSE $5 END,
       CASE WHEN $4 THEN $6 ELSE NULL END,
       CASE WHEN $4 THEN NULL ELSE $6 END,
       $7, $7, $7, $7,
       CASE WHEN $4 THEN $8 ELSE NULL END,
       CASE WHEN $4 THEN NULL ELSE $8 END,
       'PRESENT', 'PENDING',
       NOW(), NOW()
     )
     ON CONFLICT (property_id, employee_id, work_date) DO UPDATE SET
       clock_in_at = CASE
         WHEN $4 AND employee_attendance.clock_in_at IS NULL THEN NOW()
         ELSE employee_attendance.clock_in_at
       END,
       clock_out_at = CASE
         WHEN NOT $4 AND employee_attendance.clock_out_at IS NULL THEN NOW()
         ELSE employee_attendance.clock_out_at
       END,
       clock_in_photo_storage_key = CASE
         WHEN $4 THEN COALESCE(employee_attendance.clock_in_photo_storage_key, EXCLUDED.clock_in_photo_storage_key)
         ELSE employee_attendance.clock_in_photo_storage_key
       END,
       clock_out_photo_storage_key = CASE
         WHEN NOT $4 THEN COALESCE(employee_attendance.clock_out_photo_storage_key, EXCLUDED.clock_out_photo_storage_key)
         ELSE employee_attendance.clock_out_photo_storage_key
       END,
       clock_in_photo_hash = CASE
         WHEN $4 THEN COALESCE(employee_attendance.clock_in_photo_hash, EXCLUDED.clock_in_photo_hash)
         ELSE employee_attendance.clock_in_photo_hash
       END,
       clock_out_photo_hash = CASE
         WHEN NOT $4 THEN COALESCE(employee_attendance.clock_out_photo_hash, EXCLUDED.clock_out_photo_hash)
         ELSE employee_attendance.clock_out_photo_hash
       END,
       clock_in_face_status = CASE
         WHEN $4 AND employee_attendance.clock_in_at IS NULL THEN $7
         ELSE employee_attendance.clock_in_face_status
       END,
       clock_out_face_status = CASE
         WHEN NOT $4 AND employee_attendance.clock_out_at IS NULL THEN $7
         ELSE employee_attendance.clock_out_face_status
       END,
       clock_in_liveness_status = CASE
         WHEN $4 AND employee_attendance.clock_in_at IS NULL THEN $7
         ELSE employee_attendance.clock_in_liveness_status
       END,
       clock_out_liveness_status = CASE
         WHEN NOT $4 AND employee_attendance.clock_out_at IS NULL THEN $7
         ELSE employee_attendance.clock_out_liveness_status
       END,
       clock_in_location_status = CASE
         WHEN $4 AND employee_attendance.clock_in_at IS NULL THEN $8
         ELSE employee_attendance.clock_in_location_status
       END,
       clock_out_location_status = CASE
         WHEN NOT $4 AND employee_attendance.clock_out_at IS NULL THEN $8
         ELSE employee_attendance.clock_out_location_status
       END,
       updated_at = NOW()`,
    [
      params.propertyId,
      params.employeeId,
      params.workDate,
      isCheckIn,
      params.photoStorageKey,
      params.photoHash,
      ATTENDANCE_FACE_NOT_PROCESSED,
      locationStatus
    ]
  );
}

export async function recordAttendance(
  pool: Pool,
  propertyId: number,
  payload: RecordAttendancePayload,
  file: Express.Multer.File | undefined,
  actor: SelfAttendanceActor
): Promise<EmployeeAttendanceRecord> {
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

  const employeeId = actor.employeeId;
  const employeeName = actor.employeeName;
  const department = actor.department || payload.department || 'Housekeeping';

  if (attType === 'CHECK_IN') {
    const existingCheckIn = await pool.query(
      `SELECT * FROM employee_attendance_records
       WHERE property_id = $1 AND employee_id = $2 AND attendance_date = $3 AND attendance_type = 'CHECK_IN'`,
      [propertyId, employeeId, hotelDate]
    );
    if (existingCheckIn.rows.length > 0) {
      const existing = formatAttendanceRecord(existingCheckIn.rows[0]);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await upsertCanonicalAttendance(client, {
          propertyId,
          employeeId,
          workDate: hotelDate,
          attendanceType: 'CHECK_IN',
          photoStorageKey: existing.photo_storage_key,
          photoHash: existing.photo_hash || null,
          geofenceResult: existing.geofence_result
        });
        await client.query('COMMIT');
      } catch (healErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw healErr;
      } finally {
        client.release();
      }
      return existing;
    }
  }

  const isPhotoFeatureEnabled = await isFeatureEnabled(pool, propertyId, 'hrd.attendance_photo');
  let photoStorageKey: string | null = null;
  let photoHash: string | null = null;
  let photoMimeType: string | null = null;
  let photoCapturedAt: string | null = null;

  if (file && isPhotoFeatureEnabled) {
    const saved = await saveAttendanceSelfie({
      propertyId,
      employeeId,
      file: {
        mimetype: file.mimetype,
        size: file.size,
        buffer: file.buffer
      }
    });
    photoStorageKey = saved.storageKey;
    photoHash = saved.hash;
    photoMimeType = saved.mimeType;
    photoCapturedAt = saved.capturedAt;
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
         geofence_result, photo_storage_key, photo_hash, photo_mime_type, photo_captured_at,
         face_status, liveness_status, source, status, reason, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, NOW() AT TIME ZONE 'Asia/Jakarta',
         $7, $8, $9, $10,
         $11, $12, $13, $14, $15,
         $16, $16, 'MOBILE_WEB', $17, $18, NOW(), NOW()
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
        photoHash,
        photoMimeType,
        photoCapturedAt,
        ATTENDANCE_FACE_NOT_PROCESSED,
        status,
        payload.reason || null
      ]
    );

    const record = formatAttendanceRecord(insertRes.rows[0]);

    await upsertCanonicalAttendance(client, {
      propertyId,
      employeeId,
      workDate: hotelDate,
      attendanceType: attType,
      photoStorageKey,
      photoHash,
      geofenceResult
    });

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'HRD',
        attType === 'CHECK_IN' ? 'EMPLOYEE_ATTENDANCE_CHECKIN' : 'EMPLOYEE_ATTENDANCE_CHECKOUT',
        'EMPLOYEE_ATTENDANCE_RECORD',
        Number(record.id),
        JSON.stringify({
          user_id: actor.userId,
          employee_id: employeeId,
          employee_name: employeeName,
          attendance_type: attType,
          status,
          geofence_result: geofenceResult,
          distance_meters: distanceMeters,
          hotel_date: hotelDate,
          photo_storage_key: photoStorageKey,
          photo_hash: photoHash,
          face_status: ATTENDANCE_FACE_NOT_PROCESSED,
          liveness_status: ATTENDANCE_FACE_NOT_PROCESSED,
          biometric_verified: false
        }),
        actor.employeeName,
        propertyId
      ]
    );

    await client.query('COMMIT');
    return record;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (photoStorageKey) {
      await deleteAttendanceSelfie(photoStorageKey).catch(() => {});
    }
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
  return res.rows.map(formatAttendanceRecord);
}

export function getAttendancePhotoFilePath(storageKey: string): string | null {
  return getLegacyAttendancePhotoFilePath(storageKey);
}

export async function getAttendanceRecordById(
  db: Pool | PoolClient,
  recordId: number
): Promise<EmployeeAttendanceRecord | null> {
  if (!Number.isInteger(recordId) || recordId <= 0) {
    return null;
  }
  const res = await db.query('SELECT * FROM employee_attendance_records WHERE id = $1', [recordId]);
  if (res.rows.length === 0) {
    return null;
  }
  return formatAttendanceRecord(res.rows[0]);
}

import type { Pool, PoolClient } from 'pg';
import { hotelDateKey } from '../../utils/hotelDate';
import type { OutgoingReservationInfo, ReadinessReasonCode, RoomReadinessInfo, TurnoverState } from './turnoverTypes';

export function normalizePhysicalRoomStatus(value: unknown): string {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!raw) return 'VACANT_CLEAN';
  if (raw === 'READY' || raw === 'VACANT' || raw === 'VACANT_CLEAN') return 'VACANT_CLEAN';
  if (raw === 'KOTOR' || raw === 'DIRTY' || raw === 'VACANT_DIRTY') return 'VACANT_DIRTY';
  if (raw === 'OCCUPIED' || raw === 'BOOKED' || raw === 'OCCUPIED_CLEAN') return 'OCCUPIED_CLEAN';
  if (raw === 'OCCUPIED_DIRTY') return 'OCCUPIED_DIRTY';
  if (raw === 'CLEANING') return 'CLEANING';
  if (raw === 'INSPECTED') return 'INSPECTED';
  if (raw === 'MAINT' || raw === 'MAINTENANCE' || raw === 'OUT_OF_ORDER') return 'OUT_OF_ORDER';
  if (raw === 'OUT_OF_SERVICE') return 'OUT_OF_SERVICE';
  return raw;
}

export function isReadyPhysicalStatus(normalizedStatus: string): boolean {
  return normalizedStatus === 'VACANT_CLEAN' || normalizedStatus === 'INSPECTED';
}

export async function evaluateRoomReadiness(
  client: Pool | PoolClient,
  roomId: number,
  reservationId?: number | null
): Promise<RoomReadinessInfo> {
  const roomRes = await client.query(
    'SELECT id, status, is_active FROM rooms WHERE id = $1',
    [roomId]
  );
  if (roomRes.rowCount === 0) {
    return {
      is_ready: false,
      turnover_state: 'NONE',
      reason_code: 'ROOM_NOT_READY',
      reason_message: `Kamar ${roomId} tidak ditemukan.`,
      room_status: 'UNKNOWN',
      outgoing_reservation: null
    };
  }

  const room = roomRes.rows[0];
  const rawStatus = String(room.status || 'VACANT_CLEAN');
  const normalized = normalizePhysicalRoomStatus(rawStatus);

  // If reservationId is provided, retrieve its check_in date to accurately identify relevant outgoing reservation
  let incomingCheckIn: string | null = null;
  if (reservationId) {
    const incRes = await client.query('SELECT check_in FROM reservations WHERE id = $1', [reservationId]);
    if (incRes.rowCount && incRes.rowCount > 0 && incRes.rows[0].check_in) {
      incomingCheckIn = hotelDateKey(incRes.rows[0].check_in);
    }
  }

  // Check if an active outgoing reservation is currently CHECKED_IN
  const outgoingRes = await client.query(
    `SELECT id, guest_name, check_out, checked_out_at, status
     FROM reservations
     WHERE room_id = $1
       AND status = 'CHECKED_IN'
       AND ($2::int IS NULL OR id <> $2)
       AND (
         $3::date IS NULL OR
         check_out::date >= $3::date OR
         (check_in::date <= $3::date AND check_out::date >= $3::date)
       )
     ORDER BY check_out ASC, id ASC
     LIMIT 1`,
    [roomId, reservationId ?? null, incomingCheckIn]
  );

  let outgoingInfo: OutgoingReservationInfo | null = null;
  if ((outgoingRes.rowCount ?? 0) > 0) {
    const row = outgoingRes.rows[0];
    outgoingInfo = {
      id: Number(row.id),
      guest_name: String(row.guest_name || 'Tamu'),
      check_out: hotelDateKey(row.check_out),
      checked_out_at: row.checked_out_at ? new Date(row.checked_out_at).toISOString() : null,
      status: String(row.status)
    };
  }

  if (outgoingInfo !== null) {
    return {
      is_ready: false,
      turnover_state: 'OUTGOING_OCCUPIED',
      reason_code: 'OUTGOING_NOT_CHECKED_OUT',
      reason_message: 'Tamu sebelumnya belum check-out.',
      room_status: rawStatus,
      outgoing_reservation: outgoingInfo
    };
  }

  if (normalized === 'VACANT_DIRTY' || normalized === 'CLEANING') {
    return {
      is_ready: false,
      turnover_state: 'CLEANING',
      reason_code: 'HOUSEKEEPING_IN_PROGRESS',
      reason_message: 'Kamar sedang dipersiapkan Housekeeping.',
      room_status: rawStatus,
      outgoing_reservation: null
    };
  }

  if (normalized === 'OUT_OF_ORDER' || normalized === 'OUT_OF_SERVICE') {
    return {
      is_ready: false,
      turnover_state: 'OUT_OF_SERVICE',
      reason_code: 'ROOM_OUT_OF_SERVICE',
      reason_message: 'Kamar sedang dalam pemeliharaan (Out of Order / Out of Service).',
      room_status: rawStatus,
      outgoing_reservation: null
    };
  }

  if (normalized === 'OCCUPIED_CLEAN' || normalized === 'OCCUPIED_DIRTY') {
    return {
      is_ready: false,
      turnover_state: 'OUTGOING_OCCUPIED',
      reason_code: 'OUTGOING_NOT_CHECKED_OUT',
      reason_message: 'Tamu sebelumnya belum check-out.',
      room_status: rawStatus,
      outgoing_reservation: null
    };
  }

  // Check for unresolved blocking findings
  try {
    const blockingRes = await client.query(
      `SELECT f.id, f.finding_type_label, f.notes, f.severity
       FROM housekeeping_task_findings f
       WHERE f.room_id = $1
         AND f.status = 'OPEN'
         AND f.block_room_ready = TRUE
       ORDER BY f.id DESC
       LIMIT 1`,
      [roomId]
    );

    if ((blockingRes.rowCount ?? 0) > 0) {
      const bf = blockingRes.rows[0];
      return {
        is_ready: false,
        turnover_state: 'OUT_OF_SERVICE',
        reason_code: 'BLOCKING_FINDING_ACTIVE',
        reason_message: `Kamar memiliki kendala aktif (${bf.finding_type_label}${bf.notes ? ': ' + bf.notes : ''}) yang belum diselesaikan.`,
        room_status: rawStatus,
        outgoing_reservation: null
      };
    }
  } catch {
    // Ignore if table not yet initialized during migration
  }

  if (isReadyPhysicalStatus(normalized)) {
    return {
      is_ready: true,
      turnover_state: 'READY',
      reason_code: null,
      reason_message: null,
      room_status: rawStatus,
      outgoing_reservation: null
    };
  }

  return {
    is_ready: false,
    turnover_state: 'NONE',
    reason_code: 'ROOM_NOT_READY',
    reason_message: 'Kamar belum siap untuk check-in.',
    room_status: rawStatus,
    outgoing_reservation: null
  };
}

export async function assertCheckInEligible(
  client: PoolClient,
  roomId: number,
  reservationId: number
): Promise<RoomReadinessInfo> {
  const readiness = await evaluateRoomReadiness(client, roomId, reservationId);
  if (!readiness.is_ready) {
    const error: any = new Error(readiness.reason_message || 'Kamar belum siap untuk check-in.');
    error.statusCode = 409;
    error.code = readiness.reason_code || 'ROOM_NOT_READY';
    throw error;
  }
  return readiness;
}

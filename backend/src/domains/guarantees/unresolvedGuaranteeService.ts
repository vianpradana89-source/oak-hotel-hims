/**
 * unresolvedGuaranteeService.ts — Batch query for unresolved guarantee work items.
 *
 * Returns a flat list of canonical work items representing guarantees that have
 * not been settled (outstanding deposit or held identity custody) for the given
 * property. Operates entirely in SQL — no N+1 per-reservation round trips.
 *
 * CANONICAL PROPERTY OWNERSHIP (OAK rule):
 *   ROOM_RESERVATION: guarantee record -> reservation -> booking -> property
 *   BOOKING_GROUP:    guarantee record -> booking -> property
 *
 * Inclusion rules (mirrors frontend guaranteeScopePolicy):
 *   ROOM_RESERVATION: active deposit (status RECEIVED/PARTIALLY_USED) with remaining > 0
 *                     OR ROOM_RESERVATION custody with status = 'HELD'
 *   BOOKING_GROUP:    active deposit (status RECEIVED/PARTIALLY_USED) with remaining > 0
 *                     OR BOOKING_GROUP custody with status = 'HELD'
 *
 * BOOKING_GROUP items are deduplicated to ONE row per booking (anchor = earliest
 * check_in child, then lowest reservation id).
 *
 * NOTE: Deposits and identity_custody both have NOT NULL property_id columns.
 * Legacy records from before migration v1 may have NULL property_id but valid
 * reservation/booking links. Canonical joins through reservations->bookings
 * ensure such records are still discoverable under the correct property.
 */

import type { Pool } from 'pg';

export type GuaranteeScope = 'ROOM_RESERVATION' | 'BOOKING_GROUP';

export interface UnresolvedGuaranteeItem {
  scope: GuaranteeScope;
  reservation_id: number;
  anchor_reservation_id: number;
  booking_id: number;
  bid: string;
  guest_name: string;
  room_number: string | null;
  room_type_name: string | null;
  /** Only set for BOOKING_GROUP — number of children in the booking. */
  room_count: number | null;
  reservation_status: string;
  unresolved_deposit_amount: number;
  identity_held: boolean;
  deposit_count: number;
  custody_count: number;
  last_activity_at: string | null;
}

function domainError(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

/**
 * Returns all unresolved guarantee work items for a property.
 *
 * Single-batch read — no N+1 per-reservation API calls.
 * Uses CTEs to compute per-reservation and per-booking aggregated data in one query.
 *
 * PROPERTY OWNERSHIP JOIN PATHS:
 *   ROOM deposits:     deposits → reservations → bookings.property_id
 *   ROOM custody:      identity_custody → reservations → bookings.property_id
 *   GROUP deposits:    deposits → bookings.property_id
 *   GROUP custody:     identity_custody → bookings.property_id
 */
export async function getUnresolvedGuaranteesByProperty(
  pool: Pool,
  propertyId: number
): Promise<UnresolvedGuaranteeItem[]> {
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw domainError(400, 'VALIDATION_ERROR', 'property_id must be a positive integer');
  }

  const sql = `
WITH room_deposits AS (
  -- Active ROOM_RESERVATION deposits with unresolved balance.
  -- Canonical ownership: deposits → reservations → bookings.property_id
  SELECT
    d.reservation_id,
    d.id AS deposit_id,
    COALESCE(SUM(CASE WHEN e.event_type = 'RECEIVED' THEN e.amount ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN e.event_type = 'REVERSAL' THEN e.amount ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN e.event_type = 'APPLY' THEN e.amount ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN e.event_type = 'REFUND' THEN e.amount ELSE 0 END), 0)
      AS unresolved_amount
  FROM deposits d
  JOIN deposit_events e ON e.deposit_id = d.id
  JOIN reservations r ON r.id = d.reservation_id
  JOIN bookings b ON b.id = r.booking_id
  WHERE b.property_id = $1
    AND d.scope = 'ROOM_RESERVATION'
    AND d.status IN ('RECEIVED', 'PARTIALLY_USED')
  GROUP BY d.reservation_id, d.id
  HAVING COALESCE(SUM(CASE WHEN e.event_type = 'RECEIVED' THEN e.amount ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN e.event_type = 'REVERSAL' THEN e.amount ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN e.event_type = 'APPLY' THEN e.amount ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN e.event_type = 'REFUND' THEN e.amount ELSE 0 END), 0) > 0
),
room_custody AS (
  -- HELD ROOM_RESERVATION identity custody records.
  -- Canonical ownership: identity_custody → reservations → bookings.property_id
  SELECT
    ic.reservation_id,
    COUNT(*) AS held_count,
    MAX(ic.received_at) AS latest_held_at
  FROM identity_custody ic
  JOIN reservations r ON r.id = ic.reservation_id
  JOIN bookings b ON b.id = r.booking_id
  WHERE b.property_id = $1
    AND ic.scope = 'ROOM_RESERVATION'
    AND ic.status = 'HELD'
  GROUP BY ic.reservation_id
),
room_unresolved AS (
  -- One row per reservation that has either unresolved deposit or held custody
  SELECT
    r.id                                                          AS reservation_id,
    r.booking_id                                                  AS booking_id,
    b.bid                                                         AS bid,
    r.guest_name,
    ro.room_number,
    rt.name                                                       AS room_type_name,
    NULL::integer                                                 AS room_count,
    r.status                                                      AS reservation_status,
    COALESCE(SUM(rd.unresolved_amount), 0)                        AS unresolved_deposit_amount,
    rc.held_count > 0                                             AS identity_held,
    COALESCE(COUNT(DISTINCT rd.deposit_id), 0)                    AS deposit_count,
    COALESCE(rc.held_count, 0)                                    AS custody_count,
    GREATEST(
      MAX(CASE WHEN COALESCE(rd.unresolved_amount, 0) > 0 THEN r.check_in ELSE NULL END),
      MAX(rc.latest_held_at),
      r.check_in
    )                                                             AS last_activity_at
  FROM reservations r
  JOIN bookings b ON b.id = r.booking_id
  LEFT JOIN rooms ro ON ro.id = r.room_id
  LEFT JOIN room_types rt ON rt.id = COALESCE(ro.room_type_id, r.booked_room_type_id_snapshot)
  LEFT JOIN room_deposits rd ON rd.reservation_id = r.id
  LEFT JOIN room_custody rc ON rc.reservation_id = r.id
  WHERE b.property_id = $1
    AND (rd.deposit_id IS NOT NULL OR rc.held_count > 0)
  GROUP BY r.id, r.booking_id, b.bid, r.guest_name,
           ro.room_number, rt.name, r.status, r.check_in, rc.held_count, rc.latest_held_at
),
group_anchor AS (
  -- For each booking, find the anchor reservation (earliest check_in, then lowest id)
  SELECT b.id AS booking_id,
    b.bid,
    (SELECT r.id FROM reservations r
     JOIN bookings b2 ON b2.id = r.booking_id
     WHERE r.booking_id = b.id AND b2.property_id = $1
     ORDER BY r.check_in ASC, r.id ASC LIMIT 1) AS anchor_id,
    (SELECT COUNT(*) FROM reservations r2
     JOIN bookings b3 ON b3.id = r2.booking_id
     WHERE r2.booking_id = b.id AND b3.property_id = $1) AS child_count,
    (SELECT r.guest_name FROM reservations r
     WHERE r.id = (SELECT r3.id FROM reservations r3
                   JOIN bookings b4 ON b4.id = r3.booking_id
                   WHERE r3.booking_id = b.id AND b4.property_id = $1
                   ORDER BY r3.check_in ASC, r3.id ASC LIMIT 1)
     LIMIT 1) AS anchor_guest_name,
    (SELECT r.status FROM reservations r
     WHERE r.id = (SELECT r3.id FROM reservations r3
                   JOIN bookings b5 ON b5.id = r3.booking_id
                   WHERE r3.booking_id = b.id AND b5.property_id = $1
                   ORDER BY r3.check_in ASC, r3.id ASC LIMIT 1)
     LIMIT 1) AS anchor_status
  FROM bookings b
  WHERE b.property_id = $1
),
group_deposits AS (
  -- Active BOOKING_GROUP deposits with unresolved balance.
  -- Canonical ownership: deposits → bookings.property_id
  SELECT
    d.booking_id,
    d.id AS deposit_id,
    COALESCE(SUM(CASE WHEN e.event_type = 'RECEIVED' THEN e.amount ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN e.event_type = 'REVERSAL' THEN e.amount ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN e.event_type = 'APPLY' THEN e.amount ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN e.event_type = 'REFUND' THEN e.amount ELSE 0 END), 0)
      AS unresolved_amount
  FROM deposits d
  JOIN deposit_events e ON e.deposit_id = d.id
  JOIN bookings b ON b.id = d.booking_id
  WHERE b.property_id = $1
    AND d.scope = 'BOOKING_GROUP'
    AND d.status IN ('RECEIVED', 'PARTIALLY_USED')
  GROUP BY d.booking_id, d.id
  HAVING COALESCE(SUM(CASE WHEN e.event_type = 'RECEIVED' THEN e.amount ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN e.event_type = 'REVERSAL' THEN e.amount ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN e.event_type = 'APPLY' THEN e.amount ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN e.event_type = 'REFUND' THEN e.amount ELSE 0 END), 0) > 0
),
group_custody AS (
  -- HELD BOOKING_GROUP identity custody records.
  -- Canonical ownership: identity_custody → bookings.property_id
  SELECT
    ic.booking_id,
    COUNT(*) AS held_count,
    MAX(ic.received_at) AS latest_held_at
  FROM identity_custody ic
  JOIN bookings b ON b.id = ic.booking_id
  WHERE b.property_id = $1
    AND ic.scope = 'BOOKING_GROUP'
    AND ic.status = 'HELD'
  GROUP BY ic.booking_id
),
group_unresolved AS (
  -- One row per booking with unresolved group guarantee
  SELECT
    anchor_id                                                       AS anchor_reservation_id,
    booking_id,
    bid,
    guest_name,
    room_number,
    room_type_name,
    room_count,
    reservation_status,
    unresolved_deposit_amount,
    identity_held,
    deposit_count,
    custody_count,
    last_activity_at
  FROM (
    SELECT
      ga.anchor_id,
      ga.booking_id,
      ga.bid,
      ga.anchor_guest_name                                          AS guest_name,
      NULL::varchar                                                 AS room_number,
      NULL::varchar                                                 AS room_type_name,
      ga.child_count                                                AS room_count,
      ga.anchor_status                                              AS reservation_status,
      COALESCE(SUM(gd.unresolved_amount), 0)                        AS unresolved_deposit_amount,
      gc.held_count > 0                                             AS identity_held,
      COALESCE(COUNT(DISTINCT gd.deposit_id), 0)                    AS deposit_count,
      COALESCE(gc.held_count, 0)                                    AS custody_count,
      GREATEST(
        MAX(CASE WHEN COALESCE(gd.unresolved_amount, 0) > 0 THEN b.created_at ELSE NULL END),
        MAX(gc.latest_held_at),
        b.created_at
      )                                                             AS last_activity_at
    FROM group_anchor ga
    JOIN bookings b ON b.id = ga.booking_id
    LEFT JOIN group_deposits gd ON gd.booking_id = ga.booking_id
    LEFT JOIN group_custody gc ON gc.booking_id = ga.booking_id
    WHERE gd.deposit_id IS NOT NULL OR gc.held_count > 0
    GROUP BY ga.anchor_id, ga.booking_id, ga.bid, ga.anchor_guest_name,
             ga.child_count, ga.anchor_status, b.created_at,
             gc.held_count, gc.latest_held_at
  ) sub
)

-- Final UNION ALL: ROOM_RESERVATION first, then BOOKING_GROUP
SELECT * FROM (
  SELECT
    'ROOM_RESERVATION'::varchar AS scope,
    reservation_id,
    reservation_id::bigint AS anchor_reservation_id,
    booking_id,
    bid,
    guest_name,
    room_number,
    room_type_name,
    room_count,
    reservation_status,
    unresolved_deposit_amount,
    identity_held,
    deposit_count,
    custody_count,
    last_activity_at
  FROM room_unresolved

  UNION ALL

  SELECT
    'BOOKING_GROUP'::varchar AS scope,
    anchor_reservation_id::int AS reservation_id,
    anchor_reservation_id,
    booking_id,
    bid,
    guest_name,
    room_number,
    room_type_name,
    room_count,
    reservation_status,
    unresolved_deposit_amount,
    identity_held,
    deposit_count,
    custody_count,
    last_activity_at
  FROM group_unresolved
) AS all_items

ORDER BY
  CASE all_items.reservation_status
    WHEN 'CHECKED_OUT' THEN 1
    WHEN 'CANCELLED'   THEN 2
    ELSE 3
  END,
  COALESCE(all_items.last_activity_at, '2000-01-01'::timestamptz) ASC,
  all_items.booking_id ASC;
  `;

  const result = await pool.query<Record<string, unknown>>(sql, [propertyId]);

  return result.rows.map((row) => ({
    scope: String(row.scope) as GuaranteeScope,
    reservation_id: Number(row.reservation_id),
    anchor_reservation_id: Number(row.anchor_reservation_id),
    booking_id: Number(row.booking_id),
    bid: String(row.bid),
    guest_name: String(row.guest_name ?? ''),
    room_number: row.room_number ? String(row.room_number) : null,
    room_type_name: row.room_type_name ? String(row.room_type_name) : null,
    room_count: row.room_count !== null && row.room_count !== undefined
      ? Number(row.room_count) : null,
    reservation_status: String(row.reservation_status),
    unresolved_deposit_amount: Number(row.unresolved_deposit_amount ?? 0),
    identity_held: row.identity_held === true || row.identity_held === 'true',
    deposit_count: Number(row.deposit_count ?? 0),
    custody_count: Number(row.custody_count ?? 0),
    last_activity_at: row.last_activity_at
      ? new Date(String(row.last_activity_at)).toISOString()
      : null,
  }));
}

/**
 * bookingGroupReleaseEligibility.ts
 *
 * Canonical helper for BOOKING_GROUP guarantee lifecycle state.
 *
 * Returns eligibility and diagnostic metadata derived from the current
 * reservation children of a booking.  Used by read paths (deposit / custody
 * list) to attach release-enabling metadata; mutation paths will consume
 * this same helper in later phases (1B-B / 1B-C).
 *
 * Rules (GROUP-GUARANTEE-RELEASE-1B):
 *   Active child states    : BOOKED | CHECKED_IN
 *   Terminal child states  : CHECKED_OUT | CANCELLED
 *   releaseEligible        : totalChildCount > 0 AND activeChildCount === 0
 *                            AND zero unknown children AND all children recognized terminal
 *   lifecycleTerminal      : same as releaseEligible
 *   lifecycleStatus        : 'COMPLETED' when at least one CHECKED_OUT exists,
 *                            'CANCELLED' when all children are CANCELLED,
 *                            otherwise 'ACTIVE'.
 */

import type { PoolClient } from 'pg';

// ─── Types ───────────────────────────────────────────────────────────────────

export type BookingLifecycleStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

export interface BookingGroupGuaranteeState {
  /** The booking id that was queried. */
  bookingId: number;
  /** The property id that was validated. */
  propertyId: number;
  /** Derived lifecycle status from reservation children. */
  lifecycleStatus: BookingLifecycleStatus;
  /** True when no child is active AND all children are recognized terminal states. */
  lifecycleTerminal: boolean;
  /** releaseEligible === true means a manual operator release MAY be considered.
   *  This does NOT imply automatic refund / auto-return. */
  releaseEligible: boolean;
  /** Count of children still in an active state (BOOKED | CHECKED_IN). */
  activeChildCount: number;
  /** IDs of children blocking release (active ones). Empty when eligible. */
  blockingChildIds: number[];
  /** Total number of reservations in this booking. */
  totalChildCount: number;
  /** Count of CHECKED_OUT children. */
  checkedOutCount: number;
  /** Count of CANCELLED children. */
  cancelledCount: number;
  /** Count of children with unrecognized/unknown status. */
  unknownStatusCount: number;
  /** IDs of children with unrecognized status. Empty when all known. */
  unknownChildIds: number[];
  /** Human-readable reason shown to the operator when not eligible. */
  releaseBlockReason: string | null;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function deriveLifecycleStatus(
  activeCount: number,
  checkedOutCount: number,
  cancelledCount: number,
  unknownCount: number,
  totalCount: number
): BookingLifecycleStatus {
  if (activeCount > 0 || unknownCount > 0) return 'ACTIVE';
  // All terminal (no active, no unknown).
  if (checkedOutCount > 0) return 'COMPLETED';
  if (cancelledCount === totalCount && totalCount > 0) return 'CANCELLED';
  // Unknown count but no active — still ACTIVE to be safe.
  return 'ACTIVE';
}

function domainError(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Compute the canonical release state for a BOOKING_GROUP guarantee.
 *
 * @param client  a pooled PgClient (read-only — no FOR UPDATE).
 *                For mutation-time re-checks the caller should pass a
 *                transaction client that already holds the relevant locks.
 * @param bookingId  the booking that owns the group guarantee.
 * @param propertyId  used to enforce cross-property isolation.
 *
 * Rules:
 *   - releaseEligible requires at least one covered child AND zero active children
 *   - Zero children → lifecycleTerminal=false, releaseEligible=false (empty set not terminal)
 *   - Property isolation enforced via booking ownership validation
 */
export async function getBookingGroupGuaranteeReleaseState(
  client: PoolClient,
  bookingId: number,
  propertyId: number
): Promise<BookingGroupGuaranteeState> {
  // Validate the booking exists and belongs to the requesting property.
  const bRes = await client.query(
    `SELECT id, booking_status FROM bookings WHERE id = $1 AND property_id = $2 LIMIT 1`,
    [bookingId, propertyId]
  );
  if ((bRes.rowCount ?? 0) === 0) {
    throw domainError(404, 'BOOKING_NOT_FOUND', 'Booking not found or does not belong to this property');
  }

  // Query ALL children canonically (no lock — read-path only).
  const childrenRes = await client.query(
    `SELECT id, status
     FROM reservations
     WHERE booking_id = $1
     ORDER BY stay_sequence ASC, id ASC`,
    [bookingId]
  );
  const children = childrenRes.rows as Array<{ id: number; status: string }>;

  let activeCount = 0;
  let checkedOutCount = 0;
  let cancelledCount = 0;
  let unknownCount = 0;
  const blockingIds: number[] = [];
  const unknownIds: number[] = [];

  for (const c of children) {
    const s = String(c.status || '').toUpperCase();
    if (s === 'BOOKED' || s === 'CHECKED_IN') {
      activeCount++;
      blockingIds.push(Number(c.id));
    } else if (s === 'CHECKED_OUT') {
      checkedOutCount++;
    } else if (s === 'CANCELLED') {
      cancelledCount++;
    } else {
      // Unrecognized status — fail closed, do NOT treat as terminal.
      unknownCount++;
      unknownIds.push(Number(c.id));
    }
  }

  const total = children.length;

  // Zero children is NOT terminal — an empty covered set cannot be released.
  // This prevents a booking with no reservations from appearing eligible.
  if (total === 0) {
    return {
      bookingId,
      propertyId,
      lifecycleStatus: 'ACTIVE',
      lifecycleTerminal: false,
      releaseEligible: false,
      activeChildCount: 0,
      blockingChildIds: [],
      totalChildCount: 0,
      checkedOutCount: 0,
      cancelledCount: 0,
      unknownStatusCount: 0,
      unknownChildIds: [],
      releaseBlockReason: 'Booking tidak memiliki reservasi tercakup',
    };
  }

  // CANONICAL SAFETY RULE: releaseEligible requires ALL children to be recognized terminal states.
  // Unknown/unrecognized statuses fail CLOSED (not eligible).
  const recognizedTerminalCount = checkedOutCount + cancelledCount;
  const allChildrenRecognizedTerminal = recognizedTerminalCount === total;
  const terminal = activeCount === 0 && unknownCount === 0 && allChildrenRecognizedTerminal;
  const releaseEligible = terminal;
  const lifecycleStatus = deriveLifecycleStatus(activeCount, checkedOutCount, cancelledCount, unknownCount, total);
  const releaseBlockReason = terminal
    ? null
    : activeCount > 0
      ? activeCount === 1
        ? '1 kamar masih aktif'
        : `${activeCount} kamar masih aktif`
      : unknownCount > 0
        ? 'Status reservasi tercakup tidak dikenali'
        : 'Data tidak lengkap';

  return {
    bookingId,
    propertyId,
    lifecycleStatus,
    lifecycleTerminal: terminal,
    releaseEligible,
    activeChildCount: activeCount,
    blockingChildIds: blockingIds,
    totalChildCount: total,
    checkedOutCount,
    cancelledCount,
    unknownStatusCount: unknownCount,
    unknownChildIds: unknownIds,
    releaseBlockReason,
  };
}

/**
 * Enrich a list of group-scope rows (deposits or identity_custody) with
 * release metadata.  Non-group rows are left untouched.
 *
 * Uses a local Map keyed by booking_id so we query each booking only once
 * even when multiple rows share the same group.
 *
 * Mutates each enriched row in-place by appending:
 *   releaseEligible, releaseBlockReason, activeChildCount, groupLifecycleStatus
 *
 * Integrity rules:
 *   - BOOKING_GROUP rows MUST have a valid positive booking_id
 *   - Missing/invalid booking_id throws BOOKING_GROUP_INTEGRITY_ERROR
 *   - All helper errors propagate (do NOT silently convert to release-blocked state)
 */
export async function enrichGroupRowsWithReleaseMetadata<T extends Record<string, unknown>>(
  rows: T[],
  client: PoolClient,
  propertyId: number
): Promise<void> {
  // Collect unique booking_ids from group-scope rows with integrity validation.
  const seenBookings = new Set<number>();
  for (const row of rows) {
    const scope = String(row.scope ?? '');
    if (scope !== 'BOOKING_GROUP') continue;
    // Validate canonical integer ID — must be a positive integer, not float/string
    const bid = Number((row as any).booking_id);
    if (!Number.isInteger(bid) || bid <= 0) {
      throw domainError(
        400,
        'BOOKING_GROUP_INTEGRITY_ERROR',
        `BOOKING_GROUP row missing/invalid booking_id (must be positive integer): ${JSON.stringify((row as any).booking_id)}`
      );
    }
    seenBookings.add(bid);
  }

  if (seenBookings.size === 0) return;

  // Fetch state for each unique booking once.
  // Errors propagate — do NOT catch and convert to release-blocked state.
  const stateCache = new Map<number, BookingGroupGuaranteeState>();
  for (const bid of seenBookings) {
    stateCache.set(bid, await getBookingGroupGuaranteeReleaseState(client, bid, propertyId));
  }

  // Attach metadata to each row.
  for (const row of rows) {
    const scope = String(row.scope ?? '');
    if (scope !== 'BOOKING_GROUP') continue;
    const bid = Number((row as any).booking_id);
    const state = stateCache.get(bid);
    if (!state) continue;
    (row as any).releaseEligible = state.releaseEligible;
    (row as any).releaseBlockReason = state.releaseBlockReason;
    (row as any).activeChildCount = state.activeChildCount;
    (row as any).groupLifecycleStatus = state.lifecycleStatus;
  }
}

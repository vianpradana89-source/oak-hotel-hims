import { enumerateHotelDates, normalizeHotelDate } from '../../utils/hotelDate';

const LEGACY_BACKFILL_CREATOR = 'phase1d2-backfill';
const LEGACY_BACKFILL_REASON = 'LEGACY_ONE_TO_ONE_BACKFILL';

type QueryClient = {
  query: (text: string, params?: any[]) => Promise<any>;
};

type AvailabilityRelease = {
  availabilityId: number;
  date: string;
  source: 'CANONICAL' | 'LEGACY_NULL_ID';
};

export type CancellationInventoryPlan = {
  eligible: boolean;
  mode: 'NORMAL' | 'LEGACY_PRE_LEDGER' | 'BLOCKED';
  reason: string | null;
  occupiedDates: string[];
  normalReleases: AvailabilityRelease[];
  legacyNoLedgerDates: string[];
  evidence: {
    reservationId: number;
    bookingId: number;
    bid: string;
    roomId: number;
    roomNumber: string;
    propertyId: number;
    roomTypeId: number;
    roomTypeName: string;
    canonicalCoverageStart: string | null;
    hotelToday: string;
    backfillAuditId: number | null;
    backfillCorrelationId: string | null;
  } | null;
};

function blocked(reason: string, occupiedDates: string[] = []): CancellationInventoryPlan {
  return {
    eligible: false,
    mode: 'BLOCKED',
    reason,
    occupiedDates,
    normalReleases: [],
    legacyNoLedgerDates: [],
    evidence: null
  };
}

function parseAuditPayload(value: unknown): Record<string, any> | null {
  if (value && typeof value === 'object') return value as Record<string, any>;
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function propertyLocalDateFromBackfill(value: unknown): string | null {
  const raw = String(value || '');
  if (!/^\d{6}$/.test(raw)) return null;
  return normalizeHotelDate(`20${raw.slice(0, 2)}-${raw.slice(2, 4)}-${raw.slice(4, 6)}`);
}

export async function planReservationCancellationInventory(
  client: QueryClient,
  reservation: any,
  booking: any,
  options: { lockRows?: boolean } = {}
): Promise<CancellationInventoryPlan> {
  const reservationId = Number(reservation?.id);
  const bookingId = Number(booking?.id);
  const occupiedDates = enumerateHotelDates(reservation?.check_in, reservation?.check_out);
  const lockClause = options.lockRows === false ? '' : 'FOR UPDATE';

  if (!Number.isInteger(reservationId) || reservationId <= 0) {
    return blocked('reservation identity is invalid', occupiedDates);
  }
  if (String(reservation?.status || '').toUpperCase() !== 'BOOKED') {
    return blocked(`reservation status ${String(reservation?.status || 'UNKNOWN').toUpperCase()} is not cancellable`, occupiedDates);
  }
  if (!Number.isInteger(bookingId) || bookingId <= 0 || Number(reservation?.booking_id) !== bookingId) {
    return blocked('reservation is not canonically linked to the locked booking', occupiedDates);
  }
  if (occupiedDates.length === 0) {
    return blocked('reservation stay range is invalid', occupiedDates);
  }

  const roomResult = await client.query(
    `SELECT r.id, r.room_number, r.property_id AS room_property_id, r.room_type_id,
            rt.property_id AS room_type_property_id, rt.name AS room_type_name
     FROM rooms r
     JOIN room_types rt ON rt.id = r.room_type_id
     WHERE r.id = $1`,
    [reservation.room_id]
  );
  if (roomResult.rowCount !== 1) {
    return blocked('reservation room or canonical room type is missing', occupiedDates);
  }

  const room = roomResult.rows[0];
  const roomId = Number(room.id);
  const roomTypeId = Number(room.room_type_id);
  const propertyId = Number(booking.property_id);
  const roomPropertyId = Number(room.room_property_id);
  const roomTypePropertyId = Number(room.room_type_property_id);
  const roomTypeName = String(room.room_type_name || '');

  if (
    !Number.isInteger(roomTypeId) || roomTypeId <= 0 || !roomTypeName ||
    !Number.isInteger(propertyId) || propertyId <= 0 ||
    propertyId !== roomPropertyId || propertyId !== roomTypePropertyId
  ) {
    return blocked('reservation room, room type, and booking property identity do not agree', occupiedDates);
  }

  const normalReleases: AvailabilityRelease[] = [];
  const missingDates: string[] = [];

  for (const date of occupiedDates) {
    const availability = await client.query(
      `SELECT ad.id, ad.room_type_id, ad.reserved_qty
       FROM availability_dates ad
       WHERE ad.date = $1::date
         AND ad.room_type_id = $2
       ORDER BY ad.id
       ${lockClause}`,
      [date, roomTypeId]
    );

    if (availability.rowCount > 1) {
      return blocked(`multiple availability rows resolve to room type ${roomTypeId} on ${date}`, occupiedDates);
    }
    if (availability.rowCount === 1) {
      const row = availability.rows[0];
      if (Number(row.reserved_qty || 0) < 1) {
        return blocked(`reserved_qty underflow for room type ${roomTypeId} on ${date}`, occupiedDates);
      }
      normalReleases.push({
        availabilityId: Number(row.id),
        date,
        source: 'CANONICAL'
      });
      continue;
    }

    missingDates.push(date);
  }

  if (missingDates.length === 0) {
    return {
      eligible: true,
      mode: 'NORMAL',
      reason: null,
      occupiedDates,
      normalReleases,
      legacyNoLedgerDates: [],
      evidence: {
        reservationId,
        bookingId,
        bid: String(booking.bid || ''),
        roomId,
        roomNumber: String(room.room_number || ''),
        propertyId,
        roomTypeId,
        roomTypeName,
        canonicalCoverageStart: null,
        hotelToday: '',
        backfillAuditId: null,
        backfillCorrelationId: null
      }
    };
  }

  const unresolvedLegacyRows = await client.query(
    `SELECT ad.id, ad.room_type, ad.date
     FROM availability_dates ad
     WHERE ad.room_type_id IS NULL
       AND ad.date = ANY($1::date[])
     ${lockClause}`,
    [missingDates]
  );
  if (unresolvedLegacyRows.rowCount > 0) {
    return blocked('an unresolved NULL-ID legacy availability row exists on a missing hotel date', occupiedDates);
  }

  const todayResult = await client.query(
    "SELECT to_char((NOW() AT TIME ZONE 'Asia/Jakarta')::date, 'YYYY-MM-DD') AS hotel_today"
  );
  const hotelToday = String(todayResult.rows[0]?.hotel_today || '');
  if (!hotelToday || missingDates.some((date) => date >= hotelToday)) {
    return blocked('missing current or future canonical availability remains an inventory integrity error', occupiedDates);
  }

  if (String(booking.created_by || '') !== LEGACY_BACKFILL_CREATOR) {
    return blocked('booking lacks Phase 1D.2 legacy provenance', occupiedDates);
  }

  const auditResult = await client.query(
    `SELECT audit_id, new_value, correlation_id
     FROM audit_logs
     WHERE module = 'PMS'
       AND action = 'BACKFILL'
       AND entity = 'BOOKING'
       AND record_id = $1
     ORDER BY audit_id`,
    [String(bookingId)]
  );
  const matchingAudit = auditResult.rows.find((row: any) => {
    const payload = parseAuditPayload(row.new_value);
    return payload
      && String(payload.source_reason || '') === LEGACY_BACKFILL_REASON
      && Number(payload.booking_id) === bookingId
      && Number(payload.reservation_id) === reservationId
      && Number(payload.property_id) === propertyId
      && String(payload.original_reservation_status || '').toUpperCase() === 'BOOKED';
  });
  if (!matchingAudit) {
    return blocked('matching Phase 1D.2 booking backfill audit is absent', occupiedDates);
  }

  const backfillPayload = parseAuditPayload(matchingAudit.new_value)!;
  const legacyCreationDate = propertyLocalDateFromBackfill(backfillPayload.property_local_creation_date);
  if (!legacyCreationDate) {
    return blocked('legacy booking audit lacks a valid property-local creation date', occupiedDates);
  }

  const coverageResult = await client.query(
    `WITH bounds AS (
       SELECT MIN(ad.date)::date AS start_date
       FROM availability_dates ad
       WHERE ad.room_type_id = $1
     )
     SELECT to_char(b.start_date, 'YYYY-MM-DD') AS start_date,
            COALESCE((
              SELECT COUNT(*)::int
              FROM generate_series(b.start_date, $2::date, INTERVAL '1 day') AS day(d)
              WHERE NOT EXISTS (
                SELECT 1
                FROM availability_dates ad
                WHERE ad.room_type_id = $1 AND ad.date = day.d::date
              )
            ), 0)::int AS missing_coverage_rows
     FROM bounds b`,
    [roomTypeId, hotelToday]
  );
  const canonicalCoverageStart = String(coverageResult.rows[0]?.start_date || '');
  const missingCoverageRows = Number(coverageResult.rows[0]?.missing_coverage_rows || 0);
  if (!canonicalCoverageStart) {
    return blocked('canonical coverage start cannot be established for the room type', occupiedDates);
  }
  if (canonicalCoverageStart > hotelToday || missingCoverageRows !== 0) {
    return blocked('canonical coverage is not continuous from its observed start through hotel today', occupiedDates);
  }
  if (legacyCreationDate >= canonicalCoverageStart) {
    return blocked('legacy reservation was not created before canonical ledger coverage', occupiedDates);
  }
  if (missingDates.some((date) => date >= canonicalCoverageStart)) {
    return blocked('missing date is within observed canonical ledger coverage', occupiedDates);
  }

  for (const date of missingDates) {
    const lockResult = await client.query(
      `SELECT al.id
       FROM availability_locks al
       WHERE al.date = $1::date
         AND (
           al.room_type_id = $2
           OR al.room_type_id IS NULL
         )
       ${lockClause}`,
      [date, roomTypeId]
    );
    if (lockResult.rowCount > 0) {
      return blocked(`availability lock exists for room type ${roomTypeId} on ${date}`, occupiedDates);
    }

    // Any nonterminal overlap is a potential consumer. Checking more than the
    // currently active statuses prevents a concurrent legacy status transition
    // from appearing after this proof; new API bookings cannot pass a missing cell.
    const potentialConsumers = await client.query(
      `SELECT res.id
       FROM reservations res
       JOIN rooms rm ON rm.id = res.room_id
       WHERE rm.room_type_id = $1
         AND UPPER(COALESCE(res.status, '')) NOT IN ('CANCELLED', 'CHECKED_OUT')
         AND res.check_in::date <= $2::date
         AND res.check_out::date > $2::date
       ORDER BY res.id`,
      [roomTypeId, date]
    );
    if (potentialConsumers.rowCount !== 1 || Number(potentialConsumers.rows[0].id) !== reservationId) {
      return blocked(`missing ledger date ${date} is not consumed exclusively by reservation ${reservationId}`, occupiedDates);
    }
  }

  return {
    eligible: true,
    mode: 'LEGACY_PRE_LEDGER',
    reason: null,
    occupiedDates,
    normalReleases,
    legacyNoLedgerDates: missingDates,
    evidence: {
      reservationId,
      bookingId,
      bid: String(booking.bid || ''),
      roomId,
      roomNumber: String(room.room_number || ''),
      propertyId,
      roomTypeId,
      roomTypeName,
      canonicalCoverageStart,
      hotelToday,
      backfillAuditId: Number(matchingAudit.audit_id),
      backfillCorrelationId: matchingAudit.correlation_id == null ? null : String(matchingAudit.correlation_id)
    }
  };
}

export async function applyCancellationInventoryPlan(
  client: QueryClient,
  plan: CancellationInventoryPlan
): Promise<void> {
  if (!plan.eligible || plan.mode === 'BLOCKED') {
    throw new Error(`INVENTORY_INTEGRITY_ERROR: ${plan.reason || 'cancellation inventory plan is blocked'}`);
  }

  for (const release of plan.normalReleases) {
    const updated = await client.query(
      `UPDATE availability_dates
       SET reserved_qty = reserved_qty - 1
       WHERE id = $1 AND reserved_qty >= 1
       RETURNING id`,
      [release.availabilityId]
    );
    if (updated.rowCount !== 1) {
      throw new Error(
        `INVENTORY_INTEGRITY_ERROR: exact inventory release failed for availability ${release.availabilityId} on ${release.date}`
      );
    }
  }
}

export function buildLegacyPreLedgerCancellationAudit(
  plan: CancellationInventoryPlan,
  previousStatus: string,
  newStatus: string
) {
  if (plan.mode !== 'LEGACY_PRE_LEDGER' || !plan.evidence) return null;
  return {
    action: 'LEGACY_PRE_LEDGER_CANCELLATION',
    reservation_id: plan.evidence.reservationId,
    booking_id: plan.evidence.bookingId,
    bid: plan.evidence.bid,
    room_id: plan.evidence.roomId,
    room_number: plan.evidence.roomNumber,
    property_id: plan.evidence.propertyId,
    room_type_id: plan.evidence.roomTypeId,
    room_type_name: plan.evidence.roomTypeName,
    affected_hotel_dates: plan.legacyNoLedgerDates,
    occupied_hotel_dates: plan.occupiedDates,
    normally_released_hotel_dates: plan.normalReleases.map((release) => release.date),
    missing_ledger_condition: 'NO_CANONICAL_OR_NULL_ID_AVAILABILITY_ROW',
    eligibility_reason: 'PHASE1D2_LEGACY_RESERVATION_BEFORE_CONTINUOUS_CANONICAL_COVERAGE',
    canonical_coverage_start: plan.evidence.canonicalCoverageStart,
    hotel_today: plan.evidence.hotelToday,
    backfill_audit_id: plan.evidence.backfillAuditId,
    backfill_correlation_id: plan.evidence.backfillCorrelationId,
    previous_status: previousStatus,
    new_status: newStatus,
    inventory_action: 'NO_LEDGER_ROW_CREATED_OR_DECREMENTED_FOR_MISSING_DATES'
  };
}

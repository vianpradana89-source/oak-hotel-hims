import type { Pool, PoolClient } from 'pg';
import { enrichGroupRowsWithReleaseMetadata, deriveGroupGuaranteeStateFromChildren } from '../guarantees/bookingGroupReleaseEligibility';

export type IdentityDocumentType = 'KTP' | 'SIM' | 'PASSPORT' | 'OTHER';
export type IdentityScope = 'ROOM_RESERVATION' | 'BOOKING_GROUP';

const DOCUMENT_TYPES = new Set<IdentityDocumentType>(['KTP', 'SIM', 'PASSPORT', 'OTHER']);

function domainError(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

function maskDocumentNumber(value?: string | null): string | null {
  const input = String(value || '').trim();
  if (!input) return null;
  const visible = input.replace(/[^A-Za-z0-9]/g, '').slice(-4);
  return `${'*'.repeat(8)}${visible}`.slice(0, 50);
}

function validateScope(value: unknown): IdentityScope {
  if (value === undefined || value === null) return 'ROOM_RESERVATION';
  const s = String(value);
  if (s === 'ROOM_RESERVATION' || s === 'BOOKING_GROUP') return s as IdentityScope;
  throw domainError(400, 'INVALID_SCOPE', `Invalid custody scope: ${value}. Allowed values: ROOM_RESERVATION, BOOKING_GROUP`);
}

async function assertReservationOwnership(client: PoolClient, propertyId: number, reservationId: number): Promise<any> {
  const result = await client.query(
    `SELECT r.id, r.status, r.booking_id
     FROM reservations r
     JOIN bookings b ON b.id = r.booking_id
     WHERE r.id = $1 AND b.property_id = $2
     FOR UPDATE OF r`,
    [reservationId, propertyId]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw domainError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found for this property');
  }
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Lock-strategy: NOWAIT to prevent checkout ↔ group-mutation deadlock
// ---------------------------------------------------------------------------
//
// Checkout path (index.ts):
//   target reservation FOR UPDATE → booking FOR UPDATE → all children FOR UPDATE
//
// If returnIdentity used the same order (booking → children), we get:
//   TX-return: holds booking, waits for child
//   TX-checkout: holds child, waits for booking  ← deadlock
//
// Safe strategy — returnIdentity uses a booking-first, NOWAIT approach:
//   1. Lock owning booking FOR UPDATE (no reservation held yet)
//   2. Try locking each child FOR UPDATE NOWAIT, in deterministic ORDER BY
//   3. If any child is currently held by checkout: PG lock_not_available (55P03)
//      → catch and raise BOOKING_GROUP_LIFECYCLE_BUSY (409) so the caller retries
//   4. Derive eligibility from the locked child rows (no unlocked decision)
//
// This cannot deadlock because:
//   - returnIdentity never waits while holding booking FOR a reservation
//   - if any child is locked by checkout, we abort immediately, releasing booking
//   - lock order is always: booking → (NOWAIT) children
//
// The same strategy is replicated in refundDeposit.
// ---------------------------------------------------------------------------

const PG_LOCK_NOT_AVAILABLE = '55P03';

function isLockNotAvailable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return String((err as Record<string, unknown>).code) === PG_LOCK_NOT_AVAILABLE;
}

/**
 * Lock all children of a booking in deterministic order using FOR UPDATE NOWAIT.
 * Returns locked rows or throws BOOKING_GROUP_LIFECYCLE_BUSY on lock contention.
 */
async function lockGroupChildrenNowait(
  client: PoolClient,
  bookingId: number
): Promise<Array<{ id: number; status: string }>> {
  const res = await client.query(
    `SELECT id, status
     FROM reservations
     WHERE booking_id = $1
     ORDER BY stay_sequence ASC, id ASC
     FOR UPDATE NOWAIT`,
    [bookingId]
  );
  return res.rows as Array<{ id: number; status: string }>;
}

async function audit(
  client: PoolClient,
  propertyId: number,
  reservationId: number,
  action: string,
  payload: Record<string, unknown>
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ('IDENTITY_CUSTODY', $1, 'RESERVATION', $2, $3, NULL, $4)`,
    [action, String(reservationId), JSON.stringify(payload), propertyId]
  );
}

export async function holdIdentity(pool: Pool, input: {
  propertyId: number;
  reservationId: number;
  documentType: string;
  documentHolderName: string;
  documentNumberMasked?: string | null;
  storageLocation?: string | null;
  notes?: string | null;
  actor: { userId: string; name: string; role: string };
  scope?: 'ROOM_RESERVATION' | 'BOOKING_GROUP';
}): Promise<any> {
  const documentType = String(input.documentType || '').trim().toUpperCase() as IdentityDocumentType;
  const holderName = String(input.documentHolderName || '').trim();
  const maskedNumber = maskDocumentNumber(input.documentNumberMasked);
  if (!DOCUMENT_TYPES.has(documentType)) throw domainError(400, 'INVALID_DOCUMENT_TYPE', 'Unsupported identity document type');
  if (!holderName) throw domainError(400, 'DOCUMENT_HOLDER_REQUIRED', 'Document holder name is required');
  const scope = validateScope(input.scope);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reservation = await assertReservationOwnership(client, input.propertyId, input.reservationId);
    if (['CHECKED_OUT', 'CANCELLED'].includes(String(reservation.status || '').toUpperCase())) {
      throw domainError(409, 'IDENTITY_CUSTODY_RESERVATION_CLOSED', 'Cannot hold identity for a closed reservation');
    }
    const bookingId = reservation.booking_id ? Number(reservation.booking_id) : null;
    if (scope === 'BOOKING_GROUP' && !bookingId) {
      throw domainError(400, 'BOOKING_REQUIRED', 'BOOKING_GROUP custody requires reservation to be linked to a booking');
    }
    const result = await client.query(
      `INSERT INTO identity_custody (
         property_id, reservation_id, document_type, document_holder_name,
         document_number_masked, status, received_by, storage_location, notes,
         booking_id, scope
       ) VALUES ($1, $2, $3, $4, $5, 'HELD', $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        input.propertyId,
        input.reservationId,
        documentType,
        holderName,
        maskedNumber,
        input.actor.name,
        input.storageLocation || null,
        input.notes || null,
        bookingId,
        scope
      ]
    );
    const custody = result.rows[0];
    await audit(client, input.propertyId, input.reservationId, 'IDENTITY_CUSTODY_HELD', {
      identity_custody_id: custody.id,
      document_type: documentType,
      document_holder_name: holderName,
      document_number_masked: maskedNumber,
      actor_user_id: input.actor.userId,
      actor_name: input.actor.name
    });
    await client.query('COMMIT');
    return custody;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function returnIdentity(pool: Pool, input: {
  propertyId: number;
  custodyId: number;
  actor: { userId: string; name: string; role: string };
}): Promise<any> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT * FROM identity_custody
       WHERE id = $1 AND property_id = $2
       FOR UPDATE`,
      [input.custodyId, input.propertyId]
    );
    if ((result.rowCount ?? 0) === 0) throw domainError(404, 'IDENTITY_CUSTODY_NOT_FOUND', 'Identity custody record not found');
    const custody = result.rows[0];
    if (custody.status !== 'HELD') throw domainError(409, 'IDENTITY_ALREADY_RETURNED', 'Identity document has already been returned');

    // BOOKING_GROUP guard: verify canonical release eligibility before allowing return.
    if (String(custody.scope || '') === 'BOOKING_GROUP') {
      const bookingId = Number(custody.booking_id);
      if (!Number.isInteger(bookingId) || bookingId <= 0) {
        throw domainError(400, 'BOOKING_GROUP_INTEGRITY_ERROR', 'BOOKING_GROUP custody requires a valid positive booking_id');
      }
      // Lock owning booking to validate cross-property isolation.
      const bookingCheck = await client.query(
        `SELECT id FROM bookings WHERE id = $1 AND property_id = $2 LIMIT 1 FOR UPDATE`,
        [bookingId, input.propertyId]
      );
      if ((bookingCheck.rowCount ?? 0) === 0) {
        throw domainError(404, 'BOOKING_NOT_FOUND', 'Booking not found or does not belong to this property');
      }
      // Lock children with NOWAIT — if any child is held by checkout, fail fast
      // instead of holding the booking while waiting (prevents deadlock).
      let children: Array<{ id: number; status: string }>;
      try {
        children = await lockGroupChildrenNowait(client, bookingId);
      } catch (err: unknown) {
        if (isLockNotAvailable(err)) {
          throw domainError(409, 'BOOKING_GROUP_LIFECYCLE_BUSY', 'Group lifecycle is currently being modified by another operation (e.g. checkout). Please retry.');
        }
        throw err;
      }
      const state = deriveGroupGuaranteeStateFromChildren(children, bookingId, input.propertyId);
      if (!state.releaseEligible) {
        throw domainError(409, 'BOOKING_GROUP_GUARANTEE_NOT_RELEASE_ELIGIBLE',
          state.releaseBlockReason || 'Group guarantee is not eligible for release');
      }
    }

    await assertReservationOwnership(client, input.propertyId, Number(custody.reservation_id));
    const updated = await client.query(
      `UPDATE identity_custody
       SET status = 'RETURNED', returned_by = $1, returned_at = NOW(), updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [input.actor.name, input.custodyId]
    );
    await audit(client, input.propertyId, Number(custody.reservation_id), 'IDENTITY_CUSTODY_RETURNED', {
      identity_custody_id: input.custodyId,
      document_type: custody.document_type,
      actor_user_id: input.actor.userId,
      actor_name: input.actor.name
    });
    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getIdentityCustodyByReservation(
  pool: Pool,
  propertyId: number,
  reservationId: number
): Promise<any[]> {
  // Canonical ownership: reservation -> booking -> property (INNER JOIN; schema enforces booking_id NOT NULL)
  const ownership = await pool.query(
    `SELECT b.id AS booking_id FROM reservations r
     INNER JOIN bookings b ON b.id = r.booking_id
     WHERE r.id = $1 AND b.property_id = $2`,
    [reservationId, propertyId]
  );
  if ((ownership.rowCount ?? 0) === 0) throw domainError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found for this property');
  const targetBookingId = ownership.rows[0].booking_id;
  // ROOM_RESERVATION: direct custody for this reservation
  const resCustody = await pool.query(
    `SELECT ic.* FROM identity_custody ic
     WHERE ic.property_id = $1 AND ic.reservation_id = $2 AND ic.scope = 'ROOM_RESERVATION'`,
    [propertyId, reservationId]
  );
  // BOOKING_GROUP: shared custody for this booking
  let groupCustody: any = { rows: [] };
  if (targetBookingId != null && Number(targetBookingId) > 0) {
    groupCustody = await pool.query(
      `SELECT ic.* FROM identity_custody ic
       WHERE ic.property_id = $1 AND ic.booking_id = $2 AND ic.scope = 'BOOKING_GROUP'`,
      [propertyId, targetBookingId]
    );
  }
  // Merge, deduplicate, and globally sort by numeric id ascending
  const seen = new Set<number>();
  const rows: any[] = [];
  for (const row of [...resCustody.rows, ...groupCustody.rows]) {
    const id = Number(row.id);
    if (!seen.has(id)) { seen.add(id); rows.push(row); }
  }
  rows.sort((a, b) => Number(a.id) - Number(b.id));
  // Enrich group-scope rows with release metadata (read-only, no lock required).
  const client = await pool.connect();
  try {
    await enrichGroupRowsWithReleaseMetadata(rows, client, propertyId);
  } finally {
    client.release();
  }
  return rows;
}

export async function getHeldIdentityCustodyForCheckout(
  client: PoolClient,
  propertyId: number,
  reservationId: number
): Promise<any[]> {
  // Only ROOM_RESERVATION custody blocks a specific child reservation checkout.
  // BOOKING_GROUP custody is scoped to the group lifecycle and must NOT block
  // individual child checkouts — it is enforced separately at refund time.
  const result = await client.query(
    `SELECT id, document_type, document_holder_name, document_number_masked, storage_location
     FROM identity_custody
     WHERE property_id = $1 AND reservation_id = $2 AND scope = 'ROOM_RESERVATION' AND status = 'HELD'
     ORDER BY id
     FOR UPDATE`,
    [propertyId, reservationId]
  );
  return result.rows;
}

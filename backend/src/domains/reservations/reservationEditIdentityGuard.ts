import type { PoolClient } from 'pg';

/**
 * Server-side identity guard for reservation edit paths.
 *
 * Mirrors checkinGateService Gate 3:
 *   valid identity = guests.identity_storage_key non-empty
 *                  AND guests.has_valid_identity = TRUE
 *                  for the PRIMARY_GUEST (role = 'PRIMARY_GUEST').
 *
 * The guard is placed inside applyReservationEdit AFTER guest resolution
 * (guest swap / free-text create) so that a newly-created or swapped
 * guest that lacks a stored document is rejected before commit.
 *
 * Behaviour:
 *   - If a PRIMARY_GUEST relation exists for the reservation, the linked
 *     guest must have a non-empty identity_storage_key AND
 *     has_valid_identity = TRUE.  Reject (409) if either is missing.
 *   - If NO PRIMARY_GUEST relation exists, the guard FAILS CLOSED. A missing
 *     relation is not proof that the staying guest is identified; the caller
 *     must resolve a valid target guest first.
 *   - When the caller supplies the selected guest_id, the linked guest must
 *     match it, so a stale relation can never validate a different guest.
 *
 * The guard does NOT touch price, billing, discount, tax, or payment
 * fields — it only rejects the save when the staying guest's document is
 * missing.
 *
 * Supported document types: any value in guests.identity_storage_key
 * (KTP, passport, other valid identity documents). The guard checks the
 * storage key + validation flag, NOT the specific identity_type, so
 * WNA passport holders pass as well.
 */
export interface PrimaryGuestIdentityGuardResult {
  ok: boolean;
  /** Present when ok === true and a guest was verified. */
  guestId?: number;
  /** Reason code when ok === false. */
  code?: 'IDENTITY_DOCUMENT_MISSING' | 'PRIMARY_GUEST_NOT_LINKED' | 'IDENTITY_TARGET_MISMATCH';
  /** Human-readable reason when ok === false. */
  message?: string;
}

export async function assertPrimaryGuestIdentityForEdit(
  client: PoolClient,
  reservationId: number,
  propertyId: number,
  expectedGuestId?: number | null
): Promise<PrimaryGuestIdentityGuardResult> {
  // Resolve the PRIMARY_GUEST relation for this reservation.
  const pgRes = await client.query(
    `SELECT rg.guest_id
     FROM reservation_guests rg
     WHERE rg.reservation_id = $1
       AND rg.role = 'PRIMARY_GUEST'
     LIMIT 1`,
    [reservationId]
  );

  if ((pgRes.rowCount ?? 0) === 0) {
    // A missing link is NOT a licence to skip the check: without a canonical
    // staying guest there is no target identity to validate.
    return {
      ok: false,
      code: 'PRIMARY_GUEST_NOT_LINKED',
      message:
        'Tamu menginap belum terhubung ke data tamu. Pilih tamu menginap atau lengkapi identitas sebelum menyimpan perubahan.'
    };
  }

  const guestId = Number(pgRes.rows[0].guest_id);

  // The resolved relation must be the guest the operator actually selected.
  if (expectedGuestId !== undefined && expectedGuestId !== null
    && Number.isInteger(Number(expectedGuestId)) && Number(expectedGuestId) !== guestId) {
    return {
      ok: false,
      code: 'IDENTITY_TARGET_MISMATCH',
      message:
        'Tamu menginap yang tersimpan tidak sesuai dengan tamu yang dipilih. Muat ulang data reservasi lalu pilih tamu kembali.'
    };
  }

  // Property guard: guest must belong to this property's scope.
  const propGuard = await client.query(
    `SELECT 1
     FROM guests g
     WHERE g.id = $1
       AND (
         g.created_property_id = $2
         OR EXISTS (
           SELECT 1
           FROM reservation_guests rg2
           JOIN reservations r2 ON rg2.reservation_id = r2.id
           JOIN bookings b2 ON r2.booking_id = b2.id
           WHERE rg2.guest_id = g.id AND b2.property_id = $2
         )
       )`,
    [guestId, propertyId]
  );

  if ((propGuard.rowCount ?? 0) === 0) {
    // Linked guest is not in this property's scope — reject.
    return {
      ok: false,
      code: 'IDENTITY_DOCUMENT_MISSING',
      message: 'Tamu menginap tidak valid untuk properti ini. Lengkapi identitas tamu.'
    };
  }

  // Authoritative identity check (Gate 3): stored document + validation flag.
  const identRes = await client.query(
    `SELECT g.identity_storage_key, g.has_valid_identity
     FROM guests g
     WHERE g.id = $1`,
    [guestId]
  );

  if ((identRes.rowCount ?? 0) === 0) {
    return {
      ok: false,
      code: 'IDENTITY_DOCUMENT_MISSING',
      message: 'Dokumen identitas tamu menginap belum tersedia. Lengkapi KTP / identitas sebelum menyimpan.'
    };
  }

  const row = identRes.rows[0];
  const storageKey = row.identity_storage_key;
  const hasValidIdentity = Boolean(row.has_valid_identity);

  // Gate 3: BOTH a stored document file AND the validation flag are required.
  const identityOk =
    Boolean(storageKey && String(storageKey).trim().length > 0) && hasValidIdentity;

  if (!identityOk) {
    return {
      ok: false,
      code: 'IDENTITY_DOCUMENT_MISSING',
      message:
        'Dokumen identitas (KTP / paspor) tamu menginap belum tersedia atau belum diverifikasi. ' +
        'Lengkapi identitas sebelum menyimpan perubahan.'
    };
  }

  return { ok: true, guestId };
}

/**
 * Shorthand that throws on missing identity. Use inside applyReservationEdit
 * so the error propagates through the transaction rollback path.
 *
 * Fails closed when the reservation has no PRIMARY_GUEST relation: the
 * caller must resolve a valid target guest through the existing edit flow.
 */
export async function requirePrimaryGuestIdentity(
  client: PoolClient,
  reservationId: number,
  propertyId: number,
  expectedGuestId?: number | null
): Promise<void> {
  const result = await assertPrimaryGuestIdentityForEdit(client, reservationId, propertyId, expectedGuestId);
  if (!result.ok) {
    const err: any = new Error(
      result.message || 'Dokumen identitas tamu menginap belum tersedia.'
    );
    err.statusCode = 409;
    err.code = result.code || 'IDENTITY_DOCUMENT_MISSING';
    err.details = {
      reservation_id: reservationId,
      property_id: propertyId,
      reason: 'IDENTITY_DOCUMENT_REQUIRED'
    };
    throw err;
  }
}

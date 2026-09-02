import type { Pool, PoolClient } from 'pg';

export type IdentityDocumentType = 'KTP' | 'SIM' | 'PASSPORT' | 'OTHER';

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

async function assertReservationOwnership(client: PoolClient, propertyId: number, reservationId: number): Promise<any> {
  const result = await client.query(
    `SELECT r.id, r.status
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
}): Promise<any> {
  const documentType = String(input.documentType || '').trim().toUpperCase() as IdentityDocumentType;
  const holderName = String(input.documentHolderName || '').trim();
  const maskedNumber = maskDocumentNumber(input.documentNumberMasked);
  if (!DOCUMENT_TYPES.has(documentType)) throw domainError(400, 'INVALID_DOCUMENT_TYPE', 'Unsupported identity document type');
  if (!holderName) throw domainError(400, 'DOCUMENT_HOLDER_REQUIRED', 'Document holder name is required');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reservation = await assertReservationOwnership(client, input.propertyId, input.reservationId);
    if (['CHECKED_OUT', 'CANCELLED'].includes(String(reservation.status || '').toUpperCase())) {
      throw domainError(409, 'IDENTITY_CUSTODY_RESERVATION_CLOSED', 'Cannot hold identity for a closed reservation');
    }
    const result = await client.query(
      `INSERT INTO identity_custody (
         property_id, reservation_id, document_type, document_holder_name,
         document_number_masked, status, received_by, storage_location, notes
       ) VALUES ($1, $2, $3, $4, $5, 'HELD', $6, $7, $8)
       RETURNING *`,
      [
        input.propertyId,
        input.reservationId,
        documentType,
        holderName,
        maskedNumber,
        input.actor.name,
        input.storageLocation || null,
        input.notes || null
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
  const result = await pool.query(
    `SELECT ic.*
     FROM identity_custody ic
     JOIN reservations r ON r.id = ic.reservation_id
     JOIN bookings b ON b.id = r.booking_id
     WHERE ic.property_id = $1 AND ic.reservation_id = $2 AND b.property_id = $1
     ORDER BY ic.id`,
    [propertyId, reservationId]
  );
  return result.rows;
}

export async function getHeldIdentityCustodyForCheckout(
  client: PoolClient,
  propertyId: number,
  reservationId: number
): Promise<any[]> {
  const result = await client.query(
    `SELECT id, document_type, document_holder_name, document_number_masked, storage_location
     FROM identity_custody
     WHERE property_id = $1 AND reservation_id = $2 AND status = 'HELD'
     ORDER BY id
     FOR UPDATE`,
    [propertyId, reservationId]
  );
  return result.rows;
}

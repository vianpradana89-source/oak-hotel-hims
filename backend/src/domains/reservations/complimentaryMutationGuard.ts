import type { PoolClient } from 'pg';

export const COMPLIMENTARY_APPROVED_MUTATION_LOCK = 'COMPLIMENTARY_APPROVED_MUTATION_LOCK';

/**
 * Throws if the given reservation has an APPROVED complimentary request.
 * Callers must already be inside the transaction that the caller owns.
 * This helper does NOT begin/commit/rollback its own transaction.
 */
export async function assertNoApprovedComplimentaryForMutation(
  client: PoolClient,
  reservationId: number,
  propertyId: number
): Promise<void> {
  const result = await client.query(
    `SELECT id, status
     FROM reservation_complimentary_requests
     WHERE reservation_id = $1
       AND property_id = $2
       AND status = 'APPROVED'
     LIMIT 1`,
    [reservationId, propertyId]
  );
  if (result.rows.length > 0) {
    const err: any = new Error(
      'Reservasi dengan Complimentary yang sudah disetujui tidak dapat mengubah kamar, tanggal, atau tarif. Revoke Complimentary terlebih dahulu.'
    );
    err.statusCode = 409;
    err.code = COMPLIMENTARY_APPROVED_MUTATION_LOCK;
    throw err;
  }
}

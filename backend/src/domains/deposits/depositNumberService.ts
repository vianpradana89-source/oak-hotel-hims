import type { PoolClient } from 'pg';

export type DepositNumberPrefix = 'DEP' | 'RFD';

export async function generateDepositNumber(
  client: PoolClient,
  propertyId: number,
  prefix: DepositNumberPrefix
): Promise<string> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('oak_deposit_number_' || $1 || '_' || $2))`,
    [propertyId, prefix]
  );

  const propertyResult = await client.query(
    'SELECT property_code FROM properties WHERE id = $1',
    [propertyId]
  );
  if ((propertyResult.rowCount ?? 0) === 0) {
    throw Object.assign(new Error(`property ${propertyId} not found`), {
      statusCode: 404,
      code: 'PROPERTY_NOT_FOUND'
    });
  }

  const propertyCode = String(propertyResult.rows[0].property_code || '').trim().toUpperCase();
  if (!propertyCode) {
    throw Object.assign(new Error('Property code is required for deposit numbering'), {
      statusCode: 422,
      code: 'PROPERTY_CODE_REQUIRED'
    });
  }

  const sequenceResult = prefix === 'DEP'
    ? await client.query(
      `SELECT COALESCE(MAX(
         CASE
           WHEN deposit_number ~ ('^' || $2 || '-' || $3 || '-[0-9]+$')
           THEN SUBSTRING(deposit_number FROM ('^' || $2 || '-' || $3 || '-([0-9]+)$'))::BIGINT
           ELSE 0
         END
       ), 0) AS max_num
       FROM deposits
       WHERE property_id = $1
         AND deposit_number LIKE ($2 || '-' || $3 || '-%')`,
      [propertyId, prefix, propertyCode]
    )
    : await client.query(
      `SELECT COALESCE(MAX(
         CASE
           WHEN reference_code ~ ('^' || $2 || '-' || $3 || '-[0-9]+$')
           THEN SUBSTRING(reference_code FROM ('^' || $2 || '-' || $3 || '-([0-9]+)$'))::BIGINT
           ELSE 0
         END
       ), 0) AS max_num
       FROM payment_transactions
       WHERE property_id = $1
         AND transaction_type = 'DEPOSIT_REFUND'
         AND reference_code LIKE ($2 || '-' || $3 || '-%')`,
      [propertyId, prefix, propertyCode]
    );

  const next = Number(sequenceResult.rows[0]?.max_num || 0) + 1;
  return `${prefix}-${propertyCode}-${String(next).padStart(5, '0')}`;
}

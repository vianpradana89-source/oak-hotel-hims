import { Pool, PoolClient } from 'pg';

/**
 * Returns today hotel date string formatted as YYMMDD in Asia/Jakarta timezone.
 */
export function getHotelDateKey(date?: Date | string): string {
  const d = date ? (typeof date === 'string' ? new Date(date) : date) : new Date();
  
  // Format to Jakarta date parts
  const formatter = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    year: '2-digit',
    month: '2-digit',
    day: '2-digit'
  });
  
  const parts = formatter.formatToParts(d);
  const day = parts.find(p => p.type === 'day')?.value || '01';
  const month = parts.find(p => p.type === 'month')?.value || '01';
  const year = parts.find(p => p.type === 'year')?.value || '26';
  
  return `${year}${month}${day}`;
}

/**
 * Returns today hotel date formatted as YYYY-MM-DD in Asia/Jakarta timezone.
 */
export function getHotelDateToday(date?: Date | string): string {
  const d = date ? (typeof date === 'string' ? new Date(date) : date) : new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(d);
}

/**
 * Generates an atomic, unique transaction number for a property and date.
 * Format: TRX-YYMMDD-XXXXX
 */
export async function generateTransactionNumber(
  client: PoolClient | Pool,
  propertyId: number,
  customDate?: Date | string
): Promise<string> {
  const dateKey = getHotelDateKey(customDate);

  const seqRes = await client.query(
    `INSERT INTO transaction_daily_sequences (property_id, date_key, last_seq)
     VALUES ($1, $2, (
       SELECT COALESCE(MAX(
         CAST(SUBSTRING(transaction_no FROM 'TRX-[0-9]{6}-([0-9]{5})') AS INTEGER)
       ), 0) + 1
       FROM transactions
       WHERE transaction_no LIKE $3
     ))
     ON CONFLICT (property_id, date_key)
     DO UPDATE SET last_seq = GREATEST(
       transaction_daily_sequences.last_seq + 1,
       (
         SELECT COALESCE(MAX(
           CAST(SUBSTRING(transaction_no FROM 'TRX-[0-9]{6}-([0-9]{5})') AS INTEGER)
         ), 0) + 1
         FROM transactions
         WHERE transaction_no LIKE $3
       )
     )
     RETURNING last_seq`,
    [propertyId, dateKey, `TRX-${dateKey}-%`]
  );

  const seqNumber = Number(seqRes.rows[0].last_seq);
  const paddedSeq = String(seqNumber).padStart(5, '0');
  return `TRX-${dateKey}-${paddedSeq}`;
}

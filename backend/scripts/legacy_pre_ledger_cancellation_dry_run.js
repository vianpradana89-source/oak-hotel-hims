require('dotenv').config();
const { Pool } = require('pg');
const { planReservationCancellationInventory } = require('../dist/domains/reservations/cancellationInventoryPolicy');

const reservationId = Number(process.argv[2]);
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

async function main() {
  if (!Number.isInteger(reservationId) || reservationId <= 0) {
    throw new Error('reservation id must be a positive integer');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const target = await client.query(
    `SELECT r.*, b.id AS joined_booking_id, b.bid, b.property_id,
            b.booking_status, b.created_by, b.correlation_id AS booking_correlation_id
     FROM reservations r
     JOIN bookings b ON b.id = r.booking_id
     WHERE r.id = $1`,
    [reservationId]
  );
    if (target.rowCount !== 1) {
      throw new Error(`reservation ${reservationId} or its booking was not found`);
    }

    const row = target.rows[0];
    const booking = {
      id: Number(row.joined_booking_id),
      bid: row.bid,
      property_id: row.property_id,
      booking_status: row.booking_status,
      created_by: row.created_by,
      correlation_id: row.booking_correlation_id
    };
    const plan = await planReservationCancellationInventory(client, row, booking, { lockRows: false });
    await client.query('COMMIT');
    console.log(JSON.stringify({
      dry_run: true,
      reservation_id: reservationId,
      reservation_status: row.status,
      booking_id: booking.id,
      bid: booking.bid,
      booking_status: booking.booking_status,
      eligible: plan.eligible,
      mode: plan.mode,
      reason: plan.reason,
      occupied_hotel_dates: plan.occupiedDates,
      normal_release_dates: plan.normalReleases.map((release) => release.date),
      legacy_no_ledger_dates: plan.legacyNoLedgerDates,
      evidence: plan.evidence
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

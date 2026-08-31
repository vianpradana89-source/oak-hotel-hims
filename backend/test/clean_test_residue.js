'use strict';

require('dotenv').config({ path: 'E:/oak-hotel-hims/backend/.env' });
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resProps = await client.query(`
      SELECT id, name FROM properties
      WHERE name LIKE 'Isolation Prop%' OR name LIKE 'Idempotency Prop%' OR name LIKE 'Anka Prop%'
    `);
    console.log(`Found ${resProps.rows.length} test residue properties to clean up.`);

    for (const row of resProps.rows) {
      const propId = row.id;
      console.log(`Cleaning test property ${propId} (${row.name})...`);
      await client.query('DELETE FROM pos_order_items WHERE order_id IN (SELECT id FROM pos_orders WHERE property_id = $1)', [propId]);
      await client.query('DELETE FROM pos_orders WHERE property_id = $1', [propId]);
      await client.query('DELETE FROM pos_menu_items WHERE property_id = $1', [propId]);
      await client.query('DELETE FROM pos_menu_categories WHERE property_id = $1', [propId]);
      await client.query('DELETE FROM housekeeping_tasks WHERE room_id IN (SELECT id FROM rooms WHERE property_id = $1)', [propId]);
      await client.query('DELETE FROM transactions WHERE property_id = $1', [propId]);
      await client.query('DELETE FROM folio_entries WHERE property_id = $1', [propId]);
      await client.query('DELETE FROM payment_evidences WHERE payment_transaction_id IN (SELECT id FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1)))', [propId]);
      await client.query('DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1))', [propId]);
      await client.query('DELETE FROM reservation_guests WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1))', [propId]);
      await client.query('DELETE FROM availability_dates WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id = $1)', [propId]);
      await client.query('DELETE FROM audit_logs WHERE property_id = $1', [propId]);
      await client.query('DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1)', [propId]);
      await client.query('DELETE FROM bookings WHERE property_id = $1', [propId]);
      await client.query('DELETE FROM rooms WHERE property_id = $1', [propId]);
      await client.query('DELETE FROM room_types WHERE property_id = $1', [propId]);
      await client.query('DELETE FROM room_categories WHERE property_id = $1', [propId]);
      await client.query('DELETE FROM property_housekeeping_settings WHERE property_id = $1', [propId]);
      await client.query('DELETE FROM property_pricing_settings WHERE property_id = $1', [propId]);
      await client.query('DELETE FROM properties WHERE id = $1', [propId]);
    }

    await client.query('COMMIT');
    console.log('Cleanup committed successfully.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Cleanup error:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

main();

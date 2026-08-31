const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db',
});

async function run() {
  const res = await pool.query("DELETE FROM bookings WHERE correlation_id LIKE 'RM1B-CHECKOUT-FIX%' AND id NOT IN (SELECT DISTINCT booking_id FROM reservations WHERE booking_id IS NOT NULL)");
  console.log('Deleted orphan test bookings:', res.rowCount);
  await pool.end();
}

run();

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
  const res = await pool.query("SELECT id, correlation_id, room_id, check_in, check_out FROM reservations WHERE correlation_id LIKE 'RM1B-%'");
  console.log('Found leftover RM1B reservations:', res.rows.length);
  for (const row of res.rows) {
    await pool.query('DELETE FROM folio_entries WHERE reservation_id = $1', [row.id]);
    await pool.query('DELETE FROM reservations WHERE id = $1', [row.id]);
  }
  await pool.end();
}

main();

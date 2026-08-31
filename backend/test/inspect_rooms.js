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
  const rooms = await pool.query(`
    SELECT r.id, r.room_number, r.name, r.floor, r.room_type_id, rt.name as room_type_name, r.property_id, r.status
    FROM rooms r
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    ORDER BY r.id
  `);
  console.log('--- ROOMS ---');
  console.table(rooms.rows);

  const roomTypes = await pool.query('SELECT id, name, code, property_id FROM room_types ORDER BY id');
  console.log('--- ROOM TYPES ---');
  console.table(roomTypes.rows);

  const res = await pool.query(`
    SELECT r.id, r.booking_id, r.room_id, ro.room_number, r.guest_name, r.check_in, r.check_out,
           r.booked_room_type_id_snapshot, r.booked_room_type_name_snapshot, r.status
    FROM reservations r
    LEFT JOIN rooms ro ON ro.id = r.room_id
    ORDER BY r.id DESC LIMIT 15
  `);
  console.log('--- RECENT RESERVATIONS ---');
  console.table(res.rows);

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

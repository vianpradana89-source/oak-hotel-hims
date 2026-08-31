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
  const reservationId = 10830;
  const result = await pool.query(`
    SELECT
      r.*,
      r.id as reservation_id,
      r.booking_number as legacy_booking_number,
      b.bid,
      b.id as booking_id_value,
      COALESCE(r.booker_name, b.booker_name) AS booker_name,
      COALESCE(r.booker_phone, b.booker_phone) AS booker_phone,
      ota.name as ota_source_name,
      ro.room_number,
      COALESCE(r.booked_room_type_id_snapshot, ro.room_type_id) AS room_type_id,
      COALESCE(r.booked_room_type_name_snapshot, rt.name, ro.name, 'Standard Room') AS room_type,
      COALESCE(r.booked_room_type_name_snapshot, rt.name, ro.name, 'Standard Room') AS room_type_name,
      COALESCE(r.booked_room_type_code_snapshot, rt.code) AS room_type_code
    FROM reservations r
    LEFT JOIN bookings b ON b.id = r.booking_id
    LEFT JOIN ota_sources ota ON ota.id = r.ota_source_id
    LEFT JOIN rooms ro ON ro.id = r.room_id
    LEFT JOIN room_types rt ON rt.id = COALESCE(r.booked_room_type_id_snapshot, ro.room_type_id)
    WHERE r.id = $1
  `, [reservationId]);

  console.log('Result for reservation 10830:');
  console.log(JSON.stringify(result.rows[0], null, 2));

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

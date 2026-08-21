// backend/src/db/schema.ts
import { Pool } from 'pg';

export async function initializeDatabase(pool: Pool) {
  const query = `
    -- Tabel Kamar
    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      room_number VARCHAR(10),
      name VARCHAR(100),
      status VARCHAR(20) DEFAULT 'Ready'
    );

    -- Tabel Reservasi dengan penambahan kolom penomoran
    CREATE TABLE IF NOT EXISTS reservations (
      id SERIAL PRIMARY KEY,
      room_id INTEGER REFERENCES rooms(id),
      guest_name VARCHAR(100),
      guest_phone VARCHAR(20),
      check_in TIMESTAMP,
      check_out TIMESTAMP,
      total_price DECIMAL,
      payment_status VARCHAR(20),
      booking_number VARCHAR(50) UNIQUE,
      correlation_id VARCHAR(100)
    );

    -- Tabel Audit Trail (Point 6)
    CREATE TABLE IF NOT EXISTS audit_logs (
      audit_id SERIAL PRIMARY KEY,
      module VARCHAR(50),
      action VARCHAR(50),
      entity VARCHAR(50),
      record_id VARCHAR(50),
      new_value TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      correlation_id VARCHAR(100)
    );
  `;
  
  await pool.query(query);

  // Migrasi kolom baru pada tabel yang sudah ada sebelumnya
  await pool.query(`
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS booking_number VARCHAR(50);
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(100);
  `);

  // Otomatis isi data kamar (Seeding) jika tabel masih kosong
  const roomCheck = await pool.query('SELECT COUNT(*) FROM rooms');
  if (parseInt(roomCheck.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO rooms (room_number, name, status) VALUES
      ('101', 'Standard Room', 'Ready'),
      ('102', 'Standard Room', 'Ready'),
      ('103', 'Deluxe Room', 'Ready'),
      ('104', 'Deluxe Room', 'Ready'),
      ('105', 'Suite Room', 'Ready'),
      ('106', 'Suite Room', 'Ready'),
      ('107', 'Standard Room', 'Ready'),
      ('108', 'Deluxe Room', 'Ready'),
      ('109', 'Suite Room', 'Ready');
    `);
    console.log('Default rooms seeded successfully.');
  }

  console.log('Database schema & tables initialized successfully.');
}
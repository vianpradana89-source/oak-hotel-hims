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
      guest_segment VARCHAR(20) NOT NULL DEFAULT 'Reguler',
      check_in TIMESTAMP,
      check_out TIMESTAMP,
      total_price DECIMAL,
      payment_status VARCHAR(20),
      booking_number VARCHAR(50) UNIQUE,
      booking_type VARCHAR(20) DEFAULT 'WALKIN',
      correlation_id VARCHAR(100)
    );

    -- Tabel Audit Trail
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

    -- Availability engine tables
    CREATE TABLE IF NOT EXISTS availability_dates (
      id SERIAL PRIMARY KEY,
      room_type VARCHAR(100) NOT NULL,
      date DATE NOT NULL,
      total_rooms INTEGER NOT NULL DEFAULT 0,
      reserved_qty INTEGER NOT NULL DEFAULT 0,
      UNIQUE (room_type, date)
    );

    CREATE TABLE IF NOT EXISTS availability_locks (
      id SERIAL PRIMARY KEY,
      reservation_id INTEGER,
      room_type VARCHAR(100) NOT NULL,
      date DATE NOT NULL,
      qty_locked INTEGER NOT NULL,
      lock_expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  await pool.query(query);

  // RM-1B: canonical inventory identity (additive, idempotent)
  // Adds room_type_id alongside legacy room_type name; never drops legacy columns.
  if (
    (
      await pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'room_types'`
      )
    ).rowCount! > 0
  ) {
    await pool.query(`
      ALTER TABLE availability_dates ADD COLUMN IF NOT EXISTS room_type_id INTEGER;
      ALTER TABLE availability_locks ADD COLUMN IF NOT EXISTS room_type_id INTEGER;

      UPDATE availability_dates ad
      SET room_type_id = rt.id
      FROM room_types rt
      WHERE ad.room_type_id IS NULL AND rt.name = ad.room_type;

      UPDATE availability_locks al
      SET room_type_id = rt.id
      FROM room_types rt
      WHERE al.room_type_id IS NULL AND rt.name = al.room_type;

      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rm_1b_availability_dates_room_type_id_fkey') THEN
          ALTER TABLE availability_dates
            ADD CONSTRAINT rm_1b_availability_dates_room_type_id_fkey
            FOREIGN KEY (room_type_id) REFERENCES room_types(id) NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rm_1b_availability_locks_room_type_id_fkey') THEN
          ALTER TABLE availability_locks
            ADD CONSTRAINT rm_1b_availability_locks_room_type_id_fkey
            FOREIGN KEY (room_type_id) REFERENCES room_types(id) NOT VALID;
        END IF;
      END $$;

      CREATE UNIQUE INDEX IF NOT EXISTS rm_1b_availability_dates_room_type_id_date_key
        ON availability_dates (room_type_id, date)
        WHERE room_type_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS rm_1b_availability_locks_room_type_id_date_idx
        ON availability_locks (room_type_id, date);
    `);
  }

  // Migrasi kolom baru pada tabel yang sudah ada sebelumnya
  await pool.query(`
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS booking_number VARCHAR(50);
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS booking_type VARCHAR(20) DEFAULT 'WALKIN';
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(100);
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS guest_segment VARCHAR(20) DEFAULT 'Reguler';
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS ktp_path VARCHAR(500);
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS bukti_bayar_path VARCHAR(500);
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS discount_amount DECIMAL(12,2) DEFAULT 0;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS discount_percent DECIMAL(5,2) DEFAULT 0;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS amount_paid DECIMAL(12,2) DEFAULT 0;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS remaining_balance DECIMAL(12,2) DEFAULT 0;
  `);

  // Compatibility migration for newer hotel schema variants
  const roomColumns = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'rooms'
  `);
  const hasRoomName = roomColumns.rows.some((r: any) => r.column_name === 'name');
  if (!hasRoomName) {
    await pool.query('ALTER TABLE rooms ADD COLUMN IF NOT EXISTS name VARCHAR(100)');
  }

  // Backfill room names from room_types if the table is using a normalized hotel schema
  await pool.query(`
    UPDATE rooms r
    SET name = rt.name
    FROM room_types rt
    WHERE r.room_type_id = rt.id AND (r.name IS NULL OR r.name = '')
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

  // Seed availability_dates for next 180 days based on room types present
  const roomTypesRes = await pool.query(`
    SELECT DISTINCT COALESCE(rt.name, r.name) AS room_type, rt.id AS room_type_id
    FROM rooms r
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    WHERE COALESCE(rt.name, r.name) IS NOT NULL
  `);
  const roomTypes = roomTypesRes.rows.map((r: any) => ({ name: r.room_type, id: r.room_type_id }));
  const today = new Date();
  const days = 180; // seed for 180 days

  for (const rt of roomTypes) {
    const cntRes = await pool.query(
      `SELECT COUNT(*) as cnt
       FROM rooms r
       LEFT JOIN room_types rt2 ON rt2.id = r.room_type_id
       WHERE COALESCE(rt2.name, r.name) = $1`,
      [rt.name]
    );
    const totalRooms = parseInt(cntRes.rows[0].cnt) || 0;

    for (let i = 0; i < days; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const dateStr = d.toISOString().slice(0, 10);
      await pool.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES ($1, $2, $3, $4, 0)
         ON CONFLICT (room_type, date) DO UPDATE
           SET room_type_id = COALESCE(availability_dates.room_type_id, EXCLUDED.room_type_id)`,
        [rt.id ?? null, rt.name, dateStr, totalRooms]
      );
    }
  }

  console.log('Database schema & tables initialized successfully (schema_v2).');
}

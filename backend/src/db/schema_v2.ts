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

  // RM-1C: Room Master foundation (additive, idempotent).
  // Ensures room_types exists on fresh environments and extends both masters
  // with operational fields without touching existing lifecycle semantics.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_types (
      id SERIAL PRIMARY KEY,
      property_id INTEGER,
      name VARCHAR(100) NOT NULL,
      code VARCHAR(20) NOT NULL,
      base_rate DECIMAL(12,2) NOT NULL DEFAULT 0,
      capacity INTEGER DEFAULT 2,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE room_types ADD COLUMN IF NOT EXISTS description VARCHAR(500);
    ALTER TABLE room_types ADD COLUMN IF NOT EXISTS max_adults INTEGER;
    ALTER TABLE room_types ADD COLUMN IF NOT EXISTS max_children INTEGER DEFAULT 0;
    ALTER TABLE room_types ADD COLUMN IF NOT EXISTS bed_type VARCHAR(50);
    ALTER TABLE room_types ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE room_types ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE room_types ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

    ALTER TABLE rooms ADD COLUMN IF NOT EXISTS property_id INTEGER;
    ALTER TABLE rooms ADD COLUMN IF NOT EXISTS room_type_id INTEGER;
    ALTER TABLE rooms ADD COLUMN IF NOT EXISTS floor VARCHAR(10);
    ALTER TABLE rooms ADD COLUMN IF NOT EXISTS notes VARCHAR(500);
    ALTER TABLE rooms ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE rooms ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

    UPDATE room_types SET max_adults = COALESCE(max_adults, COALESCE(capacity, 2));
    UPDATE room_types SET max_children = COALESCE(max_children, 0);

    SELECT setval(
      pg_get_serial_sequence('room_types', 'id'),
      GREATEST(
        COALESCE((SELECT MAX(id) FROM room_types), 1),
        COALESCE((SELECT last_value FROM room_types_id_seq), 1)
      )
    );
    SELECT setval(
      pg_get_serial_sequence('rooms', 'id'),
      GREATEST(
        COALESCE((SELECT MAX(id) FROM rooms), 1),
        COALESCE((SELECT last_value FROM rooms_id_seq), 1)
      )
    );

    DO $$
    DECLARE
      v_has_properties BOOLEAN;
    BEGIN
      SELECT COUNT(*) > 0 INTO v_has_properties
        FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'properties';

      IF v_has_properties THEN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rm_1c_room_types_property_id_fkey') THEN
          ALTER TABLE room_types
            ADD CONSTRAINT rm_1c_room_types_property_id_fkey
            FOREIGN KEY (property_id) REFERENCES properties(id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rooms_property_id_fkey') THEN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'rooms' AND column_name = 'property_id'
          ) THEN
            ALTER TABLE rooms
              ADD CONSTRAINT rooms_property_id_fkey
              FOREIGN KEY (property_id) REFERENCES properties(id);
          END IF;
        END IF;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rooms_room_type_id_fkey') THEN
        ALTER TABLE rooms
          ADD CONSTRAINT rooms_room_type_id_fkey
          FOREIGN KEY (room_type_id) REFERENCES room_types(id);
      END IF;
    END $$;

    CREATE UNIQUE INDEX IF NOT EXISTS rm_1c_room_types_property_code_key
      ON room_types (property_id, code);

    CREATE UNIQUE INDEX IF NOT EXISTS rm_1c_rooms_property_room_number_key
      ON rooms (property_id, room_number);

    CREATE INDEX IF NOT EXISTS rm_1c_rooms_room_type_id_idx ON rooms (room_type_id);
    CREATE INDEX IF NOT EXISTS rm_1c_rooms_property_id_idx ON rooms (property_id);
    CREATE INDEX IF NOT EXISTS rm_1c_rooms_status_idx ON rooms (status);
    CREATE INDEX IF NOT EXISTS rm_1c_room_types_property_id_idx ON room_types (property_id);
  `);

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

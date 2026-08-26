import { Pool } from 'pg';

export async function initializeDatabase(pool: Pool) {
  const query = `
    -- Property foundation (required by room_categories, bookings, room_types, rooms FKs)
    CREATE TABLE IF NOT EXISTS properties (
      id SERIAL PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      property_code VARCHAR(6) NOT NULL,
      address TEXT,
      phone VARCHAR(50),
      email VARCHAR(150),
      timezone VARCHAR(50) DEFAULT 'Asia/Jakarta',
      currency_code CHAR(3) DEFAULT 'IDR',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT properties_property_code_format_check
        CHECK (property_code ~ '^[A-Z0-9]{2,6}$')
    );
    CREATE UNIQUE INDEX IF NOT EXISTS properties_property_code_key
      ON properties (property_code);

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

  // C3C canonical identity hardening for fresh DB.
  // Ensures availability_dates/availability_locks have room_type_id NOT NULL
  // even when the RM-1B guarded block was skipped (room_types didn't exist yet).
  await pool.query(`
    ALTER TABLE availability_dates ADD COLUMN IF NOT EXISTS room_type_id INTEGER;
    ALTER TABLE availability_locks ADD COLUMN IF NOT EXISTS room_type_id INTEGER;

    DO $$ BEGIN
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

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'c3c_ad_room_type_id_not_null') THEN
        ALTER TABLE availability_dates
          ADD CONSTRAINT c3c_ad_room_type_id_not_null
          CHECK (room_type_id IS NOT NULL) NOT VALID;
      END IF;
    END $$;
    ALTER TABLE availability_dates VALIDATE CONSTRAINT c3c_ad_room_type_id_not_null;
    ALTER TABLE availability_dates ALTER COLUMN room_type_id SET NOT NULL;
    ALTER TABLE availability_dates DROP CONSTRAINT c3c_ad_room_type_id_not_null;

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'c3c_al_room_type_id_not_null') THEN
        ALTER TABLE availability_locks
          ADD CONSTRAINT c3c_al_room_type_id_not_null
          CHECK (room_type_id IS NOT NULL) NOT VALID;
      END IF;
    END $$;
    ALTER TABLE availability_locks VALIDATE CONSTRAINT c3c_al_room_type_id_not_null;
    ALTER TABLE availability_locks ALTER COLUMN room_type_id SET NOT NULL;
    ALTER TABLE availability_locks DROP CONSTRAINT c3c_al_room_type_id_not_null;
  `);

  // RM-2C.2: additive category/snapshot schema only. The approved production
  // category seed and explicit room_type_id mapping live in the guarded SQL
  // migration so normal startup never rewrites editable Room Master data.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_categories (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL,
      code VARCHAR(20) NOT NULL,
      name VARCHAR(100) NOT NULL,
      description VARCHAR(500),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE room_types ADD COLUMN IF NOT EXISTS room_category_id INTEGER;

    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS booked_room_type_id_snapshot INTEGER;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS booked_room_type_code_snapshot VARCHAR(20);
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS booked_room_type_name_snapshot VARCHAR(100);
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS booked_room_category_id_snapshot INTEGER;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS booked_room_category_code_snapshot VARCHAR(20);
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS booked_room_category_name_snapshot VARCHAR(100);
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS classification_snapshot_source VARCHAR(30);
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS classification_snapshotted_at TIMESTAMPTZ;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'room_categories'::regclass
          AND conname = 'room_categories_property_id_fkey'
      ) THEN
        ALTER TABLE room_categories
          ADD CONSTRAINT room_categories_property_id_fkey
          FOREIGN KEY (property_id) REFERENCES properties(id)
          ON UPDATE NO ACTION ON DELETE NO ACTION;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'room_types'::regclass
          AND conname = 'room_types_room_category_property_check'
      ) THEN
        ALTER TABLE room_types
          ADD CONSTRAINT room_types_room_category_property_check
          CHECK (room_category_id IS NULL OR property_id IS NOT NULL);
      END IF;
    END $$;

    CREATE UNIQUE INDEX IF NOT EXISTS room_categories_property_code_key
      ON room_categories (property_id, code);
    CREATE UNIQUE INDEX IF NOT EXISTS room_categories_property_normalized_name_key
      ON room_categories (property_id, lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')));
    CREATE UNIQUE INDEX IF NOT EXISTS room_categories_property_id_id_key
      ON room_categories (property_id, id);
    CREATE INDEX IF NOT EXISTS room_categories_property_id_idx
      ON room_categories (property_id);
    CREATE INDEX IF NOT EXISTS room_categories_is_active_idx
      ON room_categories (is_active);

    CREATE INDEX IF NOT EXISTS room_types_room_category_id_idx
      ON room_types (room_category_id);
    CREATE INDEX IF NOT EXISTS room_types_property_room_category_id_idx
      ON room_types (property_id, room_category_id);

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'room_types'::regclass
          AND conname = 'room_types_property_room_category_fkey'
      ) THEN
        ALTER TABLE room_types
          ADD CONSTRAINT room_types_property_room_category_fkey
          FOREIGN KEY (property_id, room_category_id)
          REFERENCES room_categories (property_id, id)
          ON UPDATE NO ACTION ON DELETE NO ACTION;
      END IF;
    END $$;

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

  // RM-1C.2: canonical availability seeding.
  await seedAvailabilityDates(pool);

  console.log('Database schema & tables initialized successfully (schema_v2).');
}

// Seeds today/future availability rows from canonical Room Master authority:
//   room_types.id is the identity; total_rooms counts ONLY active physical
//   rooms attached by room_type_id. Legacy room_type text is kept purely as
//   compatibility/display data. Temporary housekeeping/maintenance statuses
//   are irrelevant here and must never influence physical capacity.
//
// - Inactive room types are skipped so they cannot seed sellable future capacity.
// - Existing rows are never rewritten. Startup's RM-1B compatibility backfill
//   adopts exact-name legacy rows; this seeder arbitrates only on canonical
//   (room_type_id, date). total_rooms and reserved_qty of existing rows stay
//   untouched; safe today/future drift is owned by RM-1C.1 reconciliation.
// - Duplicate display names remain valid because they are not identity. Their
//   new legacy text mirrors are disambiguated while canonical ids stay primary.
// - Dates are derived from Asia/Jakarta hotel-date semantics.
export async function seedAvailabilityDates(pool: Pool) {
  const todayResult = await pool.query(
    "SELECT to_char((NOW() AT TIME ZONE 'Asia/Jakarta')::date, 'YYYY-MM-DD') AS d"
  );
  const todayKey = String(todayResult.rows[0].d);

  const canonicalTypes = await pool.query(`
    SELECT rt.id AS room_type_id,
           CASE
             WHEN COUNT(*) OVER (PARTITION BY rt.name) > 1
               THEN LEFT(rt.name, 80) || ' [RT-' || rt.id || ']'
             ELSE rt.name
           END AS room_type,
           COUNT(r.id) FILTER (WHERE COALESCE(r.is_active, TRUE))::int AS active_rooms
    FROM room_types rt
    LEFT JOIN rooms r ON r.room_type_id = rt.id
    WHERE rt.is_active
    GROUP BY rt.id
    ORDER BY rt.id
  `);

  const horizonDays = 180;
  for (const rt of canonicalTypes.rows) {
    const totalRooms = Number(rt.active_rooms || 0);
    for (let i = 0; i < horizonDays; i += 1) {
      await pool.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES ($1, $2, ($3::date + ($4 || ' days')::interval), $5, 0)
         ON CONFLICT (room_type_id, date) WHERE room_type_id IS NOT NULL DO NOTHING`,
        [rt.room_type_id, rt.room_type, todayKey, String(i), totalRooms]
      );
    }
  }
}

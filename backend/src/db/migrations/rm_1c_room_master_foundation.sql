-- =====================================================================
-- RM-1C: ROOM MASTER DOMAIN & BACKEND API FOUNDATION
-- Additive, idempotent schema foundation for the Room Master domain.
--
-- Applied automatically at backend boot via schema_v2.ts (RM-1C block).
-- This file mirrors that block for operational reference and manual
-- application. Safe to re-run; never drops legacy columns or data.
--
-- Canonical identity: room_types.id (room_type_id). Display names are
-- labels only (see AGENTS.md section 2).
-- =====================================================================

BEGIN;

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

-- Dump-restored databases can carry sequences behind their max(id);
-- resync so new master rows never collide on the primary key.
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

COMMIT;

-- Phase B4C2-B1: Dated Room Operational Blocks Migration
-- Authoritative date-aware operational blocking for OUT_OF_ORDER and OUT_OF_SERVICE

CREATE TABLE IF NOT EXISTS room_operational_blocks (
  id SERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  room_type_id INTEGER NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
  block_type VARCHAR(20) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reason VARCHAR(255),
  maintenance_task_id INTEGER REFERENCES maintenance_tasks(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  created_by VARCHAR(100),
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  released_by VARCHAR(100),
  released_at TIMESTAMP WITHOUT TIME ZONE,
  CONSTRAINT chk_room_operational_blocks_dates CHECK (end_date > start_date),
  CONSTRAINT chk_room_operational_blocks_type CHECK (block_type IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE')),
  CONSTRAINT chk_room_operational_blocks_status CHECK (status IN ('ACTIVE', 'RELEASED', 'CANCELLED'))
);

CREATE INDEX IF NOT EXISTS idx_room_operational_blocks_prop_status_dates
  ON room_operational_blocks (property_id, status, start_date, end_date);

CREATE INDEX IF NOT EXISTS idx_room_operational_blocks_room_status_dates
  ON room_operational_blocks (room_id, status, start_date, end_date);

CREATE INDEX IF NOT EXISTS idx_room_operational_blocks_room_type_dates
  ON room_operational_blocks (room_type_id, status, start_date, end_date);

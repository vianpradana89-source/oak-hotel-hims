-- Phase GO-LIVE-GUEST-B1: Guest Master & Reservation-Guest Relational Foundation
-- Establishes canonical guests and reservation_guests tables with primary guest invariant

CREATE TABLE IF NOT EXISTS guests (
  id SERIAL PRIMARY KEY,
  full_name VARCHAR(255) NOT NULL,
  preferred_name VARCHAR(100),
  gender VARCHAR(20),
  birth_place VARCHAR(100),
  birth_date DATE,
  nationality VARCHAR(100) DEFAULT 'ID',
  phone VARCHAR(50),
  email VARCHAR(255),
  address TEXT,
  city VARCHAR(100),
  province VARCHAR(100),
  country VARCHAR(100) DEFAULT 'Indonesia',
  vip_status VARCHAR(50) NOT NULL DEFAULT 'STANDARD',
  is_blacklisted BOOLEAN NOT NULL DEFAULT FALSE,
  blacklist_reason TEXT,
  notes TEXT,
  created_property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  created_by VARCHAR(100),
  CONSTRAINT chk_guests_vip_status CHECK (vip_status IN ('STANDARD', 'VIP', 'VVIP')),
  CONSTRAINT chk_guests_gender CHECK (gender IS NULL OR gender IN ('MALE', 'FEMALE', 'OTHER'))
);

CREATE INDEX IF NOT EXISTS idx_guests_phone ON guests (phone);
CREATE INDEX IF NOT EXISTS idx_guests_email ON guests (email);
CREATE INDEX IF NOT EXISTS idx_guests_full_name_lower ON guests (LOWER(full_name));
CREATE INDEX IF NOT EXISTS idx_guests_created_property_id ON guests (created_property_id);

CREATE TABLE IF NOT EXISTS reservation_guests (
  id SERIAL PRIMARY KEY,
  reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE RESTRICT,
  role VARCHAR(50) NOT NULL,
  relationship VARCHAR(100),
  is_staying BOOLEAN NOT NULL DEFAULT TRUE,
  identity_verified BOOLEAN NOT NULL DEFAULT FALSE,
  relation_source VARCHAR(100) NOT NULL DEFAULT 'MANUAL_ENTRY',
  is_legacy_inferred BOOLEAN NOT NULL DEFAULT FALSE,
  checked_in_at TIMESTAMP WITH TIME ZONE,
  checked_out_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_reservation_guests_role CHECK (role IN ('BOOKER', 'PRIMARY_GUEST', 'ADDITIONAL_GUEST'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservation_single_primary_guest
  ON reservation_guests (reservation_id)
  WHERE role = 'PRIMARY_GUEST';

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservation_guest_role
  ON reservation_guests (reservation_id, guest_id, role);

CREATE INDEX IF NOT EXISTS idx_reservation_guests_reservation_id
  ON reservation_guests (reservation_id);

CREATE INDEX IF NOT EXISTS idx_reservation_guests_guest_id
  ON reservation_guests (guest_id);

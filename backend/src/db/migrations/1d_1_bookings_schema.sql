BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'bookings'
  ) THEN
    RAISE EXCEPTION 'Phase 1D.1 aborted: public.bookings already exists';
  END IF;
END $$;

CREATE TABLE bookings (
  id BIGSERIAL PRIMARY KEY,
  bid VARCHAR(32) NOT NULL,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  guest_name_snapshot VARCHAR(150) NOT NULL,
  guest_phone_snapshot VARCHAR(50) NULL,
  booking_source VARCHAR(20) NOT NULL DEFAULT 'WALKIN',
  channel VARCHAR(40) NULL,
  booking_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  currency_code CHAR(3) NOT NULL DEFAULT 'IDR',
  legacy_booking_number VARCHAR(50) NULL,
  created_by VARCHAR(100) NULL,
  correlation_id VARCHAR(100) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bookings_bid_unique UNIQUE (bid),
  CONSTRAINT bookings_status_check CHECK (booking_status IN ('ACTIVE', 'CANCELLED', 'COMPLETED')),
  CONSTRAINT bookings_currency_upper_check CHECK (currency_code = upper(currency_code)),
  CONSTRAINT bookings_bid_format_check CHECK (bid ~ '^[A-Z0-9-]+$')
);

CREATE OR REPLACE FUNCTION bookings_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bookings_set_updated_at
BEFORE UPDATE ON bookings
FOR EACH ROW
EXECUTE FUNCTION bookings_set_updated_at();

CREATE OR REPLACE FUNCTION bookings_prevent_bid_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.bid IS DISTINCT FROM NEW.bid THEN
    RAISE EXCEPTION 'booking BID is immutable: % -> %', OLD.bid, NEW.bid;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bookings_prevent_bid_change
BEFORE UPDATE OF bid ON bookings
FOR EACH ROW
EXECUTE FUNCTION bookings_prevent_bid_change();

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS booking_id BIGINT NULL;

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS stay_sequence SMALLINT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reservations_booking_id_fkey'
  ) THEN
    ALTER TABLE reservations
      ADD CONSTRAINT reservations_booking_id_fkey
      FOREIGN KEY (booking_id) REFERENCES bookings(id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reservations_stay_sequence_check'
  ) THEN
    ALTER TABLE reservations
      ADD CONSTRAINT reservations_stay_sequence_check
      CHECK (stay_sequence IS NULL OR stay_sequence > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS reservations_booking_id_idx
  ON reservations (booking_id);

CREATE UNIQUE INDEX IF NOT EXISTS reservations_booking_id_stay_sequence_key
  ON reservations (booking_id, stay_sequence)
  WHERE booking_id IS NOT NULL AND stay_sequence IS NOT NULL;

CREATE INDEX IF NOT EXISTS bookings_property_id_idx
  ON bookings (property_id);

COMMIT;

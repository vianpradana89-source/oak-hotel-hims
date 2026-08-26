-- =====================================================================
-- C3C: CANONICAL IDENTITY HARDENING
-- Enforce room_type_id NOT NULL on availability_dates / availability_locks.
-- Idempotent, transactional, non-destructive.
-- - Validates existing FKs
-- - No data rewrite beyond constraint enforcement
-- - No reservation mutations, no Room Master mutations
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Validate existing FKs if still NOT VALID
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'rm_1b_availability_dates_room_type_id_fkey' AND NOT convalidated
  ) THEN
    ALTER TABLE availability_dates VALIDATE CONSTRAINT rm_1b_availability_dates_room_type_id_fkey;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'rm_1b_availability_locks_room_type_id_fkey' AND NOT convalidated
  ) THEN
    ALTER TABLE availability_locks VALIDATE CONSTRAINT rm_1b_availability_locks_room_type_id_fkey;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2. Pre-flight: verify no NULL-ID rows exist before hardening
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_dates_null int;
  v_locks_null int;
BEGIN
  SELECT COUNT(*) INTO v_dates_null FROM availability_dates WHERE room_type_id IS NULL;
  SELECT COUNT(*) INTO v_locks_null FROM availability_locks WHERE room_type_id IS NULL;

  IF v_dates_null > 0 THEN
    RAISE EXCEPTION 'C3C aborted: % availability_dates rows have NULL room_type_id', v_dates_null;
  END IF;
  IF v_locks_null > 0 THEN
    RAISE EXCEPTION 'C3C aborted: % availability_locks rows have NULL room_type_id', v_locks_null;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 3. NOT NULL via CHECK NOT VALID -> validate -> SET NOT NULL -> drop CHECK
--    PostgreSQL 12+ skips the full-table scan on SET NOT NULL when a
--    validated CHECK (col IS NOT NULL) already exists.
-- ---------------------------------------------------------------------

-- availability_dates.room_type_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'availability_dates'::regclass
      AND conname = 'c3c_ad_room_type_id_not_null'
  ) THEN
    ALTER TABLE availability_dates
      ADD CONSTRAINT c3c_ad_room_type_id_not_null
      CHECK (room_type_id IS NOT NULL) NOT VALID;
  END IF;
END $$;

ALTER TABLE availability_dates VALIDATE CONSTRAINT c3c_ad_room_type_id_not_null;
ALTER TABLE availability_dates ALTER COLUMN room_type_id SET NOT NULL;
ALTER TABLE availability_dates DROP CONSTRAINT c3c_ad_room_type_id_not_null;

-- availability_locks.room_type_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'availability_locks'::regclass
      AND conname = 'c3c_al_room_type_id_not_null'
  ) THEN
    ALTER TABLE availability_locks
      ADD CONSTRAINT c3c_al_room_type_id_not_null
      CHECK (room_type_id IS NOT NULL) NOT VALID;
  END IF;
END $$;

ALTER TABLE availability_locks VALIDATE CONSTRAINT c3c_al_room_type_id_not_null;
ALTER TABLE availability_locks ALTER COLUMN room_type_id SET NOT NULL;
ALTER TABLE availability_locks DROP CONSTRAINT c3c_al_room_type_id_not_null;

-- ---------------------------------------------------------------------
-- 4. Canonical uniqueness index
--    rm_1b_availability_dates_room_type_id_date_key (partial, WHERE room_type_id IS NOT NULL)
--    Already protects (room_type_id, date) uniqueness.
--    After NOT NULL, this is equivalent to a full UNIQUE index.
--    KEEP AS-IS for minimum safe schema; no redundant index created.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 5. Legacy text column
--    UNIQUE(room_type, date) remains as historical constraint.
--    KEEP TEMPORARILY. No change in this migration.
-- ---------------------------------------------------------------------

COMMIT;

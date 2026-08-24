-- =====================================================================
-- PHASE RM-1B: CANONICAL INVENTORY IDENTITY
-- Additive migration: room_type_id on availability_dates / availability_locks
-- Idempotent, transactional, non-destructive.
-- - Legacy room_type (name) columns are KEPT and remain authoritative fallback
-- - No table drops, no column drops, no data resets
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Add nullable canonical room_type_id columns (additive)
-- ---------------------------------------------------------------------
ALTER TABLE availability_dates
  ADD COLUMN IF NOT EXISTS room_type_id INTEGER;

ALTER TABLE availability_locks
  ADD COLUMN IF NOT EXISTS room_type_id INTEGER;

-- ---------------------------------------------------------------------
-- 2. Guarded backfill from room_types by exact name match
--    Only fills NULLs; never overwrites an existing canonical id.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'room_types'
  ) THEN
    RAISE EXCEPTION 'RM-1B aborted: public.room_types does not exist; cannot backfill canonical ids';
  END IF;
END $$;

UPDATE availability_dates ad
SET room_type_id = rt.id
FROM room_types rt
WHERE ad.room_type_id IS NULL
  AND rt.name = ad.room_type;

UPDATE availability_locks al
SET room_type_id = rt.id
FROM room_types rt
WHERE al.room_type_id IS NULL
  AND rt.name = al.room_type;

-- ---------------------------------------------------------------------
-- 3. Verification: every legacy name must have resolved to a canonical id
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_unmatched_dates INTEGER;
  v_unmatched_locks INTEGER;
  v_ambiguous INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_unmatched_dates
  FROM availability_dates ad
  WHERE ad.room_type_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM room_types rt WHERE rt.name = ad.room_type);

  SELECT COUNT(*) INTO v_unmatched_locks
  FROM availability_locks al
  WHERE al.room_type_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM room_types rt WHERE rt.name = al.room_type);

  IF v_unmatched_dates > 0 OR v_unmatched_locks > 0 THEN
    RAISE EXCEPTION 'RM-1B aborted: % availability_dates row(s) and % availability_locks row(s) have unmatched room_type names', v_unmatched_dates, v_unmatched_locks;
  END IF;

  SELECT COUNT(*) INTO v_ambiguous
  FROM (
    SELECT name FROM room_types GROUP BY name HAVING COUNT(DISTINCT id) > 1
  ) dup;

  IF v_ambiguous > 0 THEN
    RAISE EXCEPTION 'RM-1B aborted: room_types.name is ambiguous (%) duplicate name(s); resolve duplicates before canonical identity', v_ambiguous;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4. Foreign keys (NOT VALID: additive, no validation scan of history)
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rm_1b_availability_dates_room_type_id_fkey'
  ) THEN
    ALTER TABLE availability_dates
      ADD CONSTRAINT rm_1b_availability_dates_room_type_id_fkey
      FOREIGN KEY (room_type_id) REFERENCES room_types(id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rm_1b_availability_locks_room_type_id_fkey'
  ) THEN
    ALTER TABLE availability_locks
      ADD CONSTRAINT rm_1b_availability_locks_room_type_id_fkey
      FOREIGN KEY (room_type_id) REFERENCES room_types(id) NOT VALID;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 5. Canonical lookup indexes (partial unique keeps legacy NULL rows legal)
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS rm_1b_availability_dates_room_type_id_date_key
  ON availability_dates (room_type_id, date)
  WHERE room_type_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS rm_1b_availability_locks_room_type_id_date_idx
  ON availability_locks (room_type_id, date);

COMMIT;

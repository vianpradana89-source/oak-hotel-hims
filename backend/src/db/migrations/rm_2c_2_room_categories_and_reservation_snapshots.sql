-- =====================================================================
-- RM-2C.2: ROOM CATEGORY CLASSIFICATION + RESERVATION SNAPSHOTS
-- Additive and idempotent. No existing identifier is replaced.
-- Category assignment uses only the approved room_type_id/code mapping.
-- =====================================================================

BEGIN;

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

-- Lock and verify every approved identity before category or mapping data is
-- written. A changed/missing ID-code pair aborts and rolls back all DDL above.
DO $$
DECLARE
  v_mismatch TEXT;
  v_category_conflict TEXT;
  v_mapping_conflict TEXT;
  v_mapped_count INTEGER;
  v_legacy_prm_id INTEGER;
  v_legacy_prm_reference_count INTEGER;
  v_transitioned_legacy_prm BOOLEAN := FALSE;
BEGIN
  PERFORM rt.id
    FROM room_types rt
   WHERE rt.property_id = 1
     AND rt.id IN (1, 2, 3, 4, 5, 22, 23, 51, 52)
   ORDER BY rt.id
   FOR UPDATE;

  WITH expected(room_type_id, room_type_code) AS (
    VALUES
      (1, 'DLXK'),
      (2, 'STDT'),
      (3, 'PRMK'),
      (4, 'PRMT'),
      (5, 'DLXT'),
      (22, 'STDK'),
      (23, 'DLXTR'),
      (51, 'PRMKO'),
      (52, 'PRMTO')
  )
  SELECT string_agg(
           format('id=%s expected=%s actual=%s', e.room_type_id, e.room_type_code, COALESCE(rt.code, '<missing>')),
           ', ' ORDER BY e.room_type_id
         )
    INTO v_mismatch
    FROM expected e
    LEFT JOIN room_types rt ON rt.id = e.room_type_id AND rt.property_id = 1
   WHERE rt.id IS NULL OR rt.code IS DISTINCT FROM e.room_type_code;

  IF v_mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'RM-2C.2 aborted before mapping: approved room type identity mismatch: %', v_mismatch;
  END IF;

  -- A prior interrupted RM-2C draft created one exact PRM category for both
  -- Premiere classifications. Preserve that category id for PRM-IN and move
  -- only the two explicitly approved OUT variants to the new PRM-OUT id.
  SELECT id
    INTO v_legacy_prm_id
    FROM room_categories
   WHERE property_id = 1 AND code = 'PRM'
   FOR UPDATE;

  IF v_legacy_prm_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
        FROM room_categories
       WHERE property_id = 1
         AND (
           code = 'PRM-IN'
           OR lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')) = 'premiere (in)'
         )
    ) THEN
      RAISE EXCEPTION 'RM-2C.2 legacy PRM transition is ambiguous: PRM-IN already exists';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM room_categories
       WHERE id = v_legacy_prm_id
         AND property_id = 1
         AND lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')) = 'premiere'
         AND display_order = 30
    ) THEN
      RAISE EXCEPTION 'RM-2C.2 legacy PRM transition rejected: category state is not the approved prior draft';
    END IF;

    SELECT COUNT(*)::int
      INTO v_legacy_prm_reference_count
      FROM room_types
     WHERE room_category_id = v_legacy_prm_id;

    WITH expected(room_type_id, room_type_code) AS (
      VALUES (3, 'PRMK'), (4, 'PRMT'), (51, 'PRMKO'), (52, 'PRMTO')
    )
    SELECT string_agg(
             format('id=%s expected=%s actual=%s/category=%s', e.room_type_id, e.room_type_code,
                    COALESCE(rt.code, '<missing>'), COALESCE(rt.room_category_id::text, '<none>')),
             ', ' ORDER BY e.room_type_id
           )
      INTO v_mapping_conflict
      FROM expected e
      LEFT JOIN room_types rt ON rt.id = e.room_type_id AND rt.property_id = 1
     WHERE rt.id IS NULL
        OR rt.code IS DISTINCT FROM e.room_type_code
        OR rt.room_category_id IS DISTINCT FROM v_legacy_prm_id;

    IF v_legacy_prm_reference_count <> 4 OR v_mapping_conflict IS NOT NULL THEN
      RAISE EXCEPTION 'RM-2C.2 legacy PRM transition rejected: references=% mapping=%',
        v_legacy_prm_reference_count, COALESCE(v_mapping_conflict, '<unexpected extra reference>');
    END IF;

    UPDATE room_categories
       SET code = 'PRM-IN',
           name = 'PREMIERE (IN)',
           updated_at = CURRENT_TIMESTAMP
     WHERE id = v_legacy_prm_id;
    v_transitioned_legacy_prm := TRUE;
    v_mapping_conflict := NULL;
  END IF;

  WITH approved(code, name) AS (
    VALUES
      ('DLX', 'DELUXE'),
      ('STD', 'STANDARD'),
      ('PRM-IN', 'PREMIERE (IN)'),
      ('PRM-OUT', 'PREMIERE (OUT)')
  )
  SELECT string_agg(
           format('approved=%s/%s existing=%s/%s', a.code, a.name, rc.code, rc.name),
           ', ' ORDER BY a.code
         )
    INTO v_category_conflict
    FROM approved a
    JOIN room_categories rc
      ON rc.property_id = 1
     AND (
       rc.code = a.code
       OR lower(regexp_replace(btrim(rc.name), '[[:space:]]+', ' ', 'g'))
          = lower(regexp_replace(btrim(a.name), '[[:space:]]+', ' ', 'g'))
     )
   WHERE rc.code IS DISTINCT FROM a.code
      OR lower(regexp_replace(btrim(rc.name), '[[:space:]]+', ' ', 'g'))
         IS DISTINCT FROM lower(regexp_replace(btrim(a.name), '[[:space:]]+', ' ', 'g'));

  IF v_category_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'RM-2C.2 category seed conflict: %', v_category_conflict;
  END IF;

  INSERT INTO room_categories (property_id, code, name, description, is_active, display_order)
  VALUES
    (1, 'DLX', 'DELUXE', NULL, TRUE, 10),
    (1, 'STD', 'STANDARD', NULL, TRUE, 20),
    (1, 'PRM-IN', 'PREMIERE (IN)', NULL, TRUE, 30),
    (1, 'PRM-OUT', 'PREMIERE (OUT)', NULL, TRUE, 40)
  ON CONFLICT (property_id, code) DO NOTHING;

  WITH approved(room_type_id, category_code) AS (
    VALUES
      (1, 'DLX'),
      (2, 'STD'),
      (3, 'PRM-IN'),
      (4, 'PRM-IN'),
      (5, 'DLX'),
      (22, 'STD'),
      (23, 'DLX'),
      (51, 'PRM-OUT'),
      (52, 'PRM-OUT')
  )
  SELECT string_agg(
           format('room_type_id=%s current_category=%s expected=%s', rt.id, COALESCE(current_category.code, '<none>'), a.category_code),
           ', ' ORDER BY rt.id
         )
    INTO v_mapping_conflict
    FROM approved a
    JOIN room_types rt ON rt.id = a.room_type_id AND rt.property_id = 1
    LEFT JOIN room_categories current_category ON current_category.id = rt.room_category_id
   WHERE rt.room_category_id IS NOT NULL
      AND current_category.code IS DISTINCT FROM a.category_code
      AND NOT (
        v_transitioned_legacy_prm
        AND a.room_type_id IN (51, 52)
        AND current_category.code = 'PRM-IN'
      );

  IF v_mapping_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'RM-2C.2 existing category mapping conflict: %', v_mapping_conflict;
  END IF;

  UPDATE room_types rt
     SET room_category_id = rc.id
    FROM (
      VALUES
        (1, 'DLXK', 'DLX'),
        (2, 'STDT', 'STD'),
        (3, 'PRMK', 'PRM-IN'),
        (4, 'PRMT', 'PRM-IN'),
        (5, 'DLXT', 'DLX'),
        (22, 'STDK', 'STD'),
        (23, 'DLXTR', 'DLX'),
        (51, 'PRMKO', 'PRM-OUT'),
        (52, 'PRMTO', 'PRM-OUT')
    ) AS approved(room_type_id, room_type_code, category_code)
    JOIN room_categories rc
      ON rc.property_id = 1 AND rc.code = approved.category_code
   WHERE rt.id = approved.room_type_id
     AND rt.property_id = 1
     AND rt.code = approved.room_type_code
      AND (
        rt.room_category_id IS NULL
        OR (
          v_transitioned_legacy_prm
          AND approved.room_type_id IN (51, 52)
          AND rt.room_category_id = v_legacy_prm_id
        )
      );

  SELECT COUNT(*)::int
    INTO v_mapped_count
    FROM room_types rt
    JOIN room_categories rc ON rc.id = rt.room_category_id AND rc.property_id = rt.property_id
    JOIN (
      VALUES
        (1, 'DLX'),
        (2, 'STD'),
        (3, 'PRM-IN'),
        (4, 'PRM-IN'),
        (5, 'DLX'),
        (22, 'STD'),
        (23, 'DLX'),
        (51, 'PRM-OUT'),
        (52, 'PRM-OUT')
    ) AS approved(room_type_id, category_code)
      ON approved.room_type_id = rt.id AND approved.category_code = rc.code
   WHERE rt.property_id = 1;

  IF v_mapped_count <> 9 THEN
    RAISE EXCEPTION 'RM-2C.2 mapping postcondition failed: expected 9 mapped room types, found %', v_mapped_count;
  END IF;
END $$;

COMMIT;

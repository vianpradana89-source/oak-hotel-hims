BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'properties'
      AND column_name = 'property_code'
  ) THEN
    RAISE EXCEPTION 'Phase 1D.1B aborted: public.properties.property_code already exists';
  END IF;

  IF (SELECT COUNT(*) FROM properties) <> 1 THEN
    RAISE EXCEPTION 'Phase 1D.1B aborted: expected exactly one property row';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM properties WHERE id = 1) THEN
    RAISE EXCEPTION 'Phase 1D.1B aborted: expected properties.id = 1';
  END IF;
END $$;

ALTER TABLE properties
  ADD COLUMN property_code VARCHAR(6);

ALTER TABLE properties
  ADD CONSTRAINT properties_property_code_format_check
  CHECK (property_code IS NULL OR property_code ~ '^[A-Z0-9]{2,6}$');

CREATE UNIQUE INDEX properties_property_code_key
  ON properties (property_code);

UPDATE properties
SET property_code = 'LWG',
    name = 'OAK Lawang'
WHERE id = 1;

ALTER TABLE properties
  ALTER COLUMN property_code SET NOT NULL;

CREATE OR REPLACE FUNCTION properties_prevent_property_code_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.property_code IS DISTINCT FROM NEW.property_code THEN
    RAISE EXCEPTION 'property_code is immutable: % -> %', OLD.property_code, NEW.property_code;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER properties_prevent_property_code_change
BEFORE UPDATE OF property_code ON properties
FOR EACH ROW
EXECUTE FUNCTION properties_prevent_property_code_change();

COMMIT;

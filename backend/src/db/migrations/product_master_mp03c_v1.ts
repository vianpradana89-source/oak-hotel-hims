import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

type MigrationStep = {
  id: string;
  description: string;
  sql: string;
};

export const PRODUCT_MASTER_MP03C_STEPS: MigrationStep[] = [
  {
    id: '01_add_canonical_base_unit_code_column',
    description: 'Add nullable canonical_base_unit_code column to pos_menu_items',
    sql: `
      ALTER TABLE pos_menu_items
      ADD COLUMN IF NOT EXISTS canonical_base_unit_code VARCHAR(20) NULL;
    `,
  },
  {
    id: '02_add_canonical_base_unit_check_constraint',
    description: 'Add check constraint for canonical_base_unit_code on pos_menu_items (15 canonical units)',
    sql: `
      DO $$
      BEGIN
        ALTER TABLE pos_menu_items
          DROP CONSTRAINT IF EXISTS chk_pos_menu_items_canonical_base_unit;

        ALTER TABLE pos_menu_items
          ADD CONSTRAINT chk_pos_menu_items_canonical_base_unit
          CHECK (
            canonical_base_unit_code IS NULL
            OR canonical_base_unit_code IN (
              'PCS', 'PORSI', 'GELAS', 'CUP', 'BOTOL', 'KALENG',
              'PACK', 'BOX', 'ROLL', 'SET', 'LEMBAR',
              'KG', 'GRAM',
              'LITER', 'ML'
            )
          );
      END $$;
    `,
  },
  {
    id: '03_create_composite_unique_indexes_on_parents',
    description: 'Create composite unique indexes on pos_menu_items(property_id, id) and rooms(property_id, id)',
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_menu_items_property_id_id
        ON pos_menu_items(property_id, id);

      CREATE UNIQUE INDEX IF NOT EXISTS uq_rooms_property_id_id
        ON rooms(property_id, id);
    `,
  },
  {
    id: '04_create_product_packaging_conversions_table',
    description: 'Create product_packaging_conversions table for item-specific packaging conversions',
    sql: `
      CREATE TABLE IF NOT EXISTS product_packaging_conversions (
        id SERIAL PRIMARY KEY,
        property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
        menu_item_id INTEGER NOT NULL,
        packaging_code VARCHAR(30) NOT NULL,
        packaging_label VARCHAR(60) NOT NULL,
        base_unit_code VARCHAR(20) NOT NULL,
        to_base_factor NUMERIC(12, 3) NOT NULL,
        is_default_purchase BOOLEAN NOT NULL DEFAULT FALSE,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        idempotency_key VARCHAR(150) NOT NULL,
        create_payload_hash VARCHAR(64) NULL,
        create_payload_snapshot JSONB NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );

      ALTER TABLE product_packaging_conversions
        ADD COLUMN IF NOT EXISTS create_payload_hash VARCHAR(64) NULL,
        ADD COLUMN IF NOT EXISTS create_payload_snapshot JSONB NULL;
    `,
  },
  {
    id: '05_add_product_packaging_conversions_constraints_and_indexes',
    description: 'Add constraints and unique indexes to product_packaging_conversions',
    sql: `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'fk_ppc_property_menu_item'
            AND conrelid = 'product_packaging_conversions'::regclass
        ) THEN
          ALTER TABLE product_packaging_conversions
          ADD CONSTRAINT fk_ppc_property_menu_item
          FOREIGN KEY (property_id, menu_item_id)
          REFERENCES pos_menu_items(property_id, id) ON DELETE CASCADE;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_ppc_packaging_code_format'
            AND conrelid = 'product_packaging_conversions'::regclass
        ) THEN
          ALTER TABLE product_packaging_conversions
          ADD CONSTRAINT chk_ppc_packaging_code_format
          CHECK (
            BTRIM(packaging_code) <> ''
            AND CHAR_LENGTH(BTRIM(packaging_code)) <= 30
            AND packaging_code ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$'
          );
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_ppc_packaging_label_non_empty'
            AND conrelid = 'product_packaging_conversions'::regclass
        ) THEN
          ALTER TABLE product_packaging_conversions
          ADD CONSTRAINT chk_ppc_packaging_label_non_empty
          CHECK (
            BTRIM(packaging_label) <> ''
            AND CHAR_LENGTH(BTRIM(packaging_label)) <= 60
          );
        END IF;

        ALTER TABLE product_packaging_conversions
          DROP CONSTRAINT IF EXISTS chk_ppc_base_unit_code_valid;

        ALTER TABLE product_packaging_conversions
          ADD CONSTRAINT chk_ppc_base_unit_code_valid
          CHECK (
            base_unit_code IN (
              'PCS', 'PORSI', 'GELAS', 'CUP', 'BOTOL', 'KALENG',
              'PACK', 'BOX', 'ROLL', 'SET', 'LEMBAR',
              'KG', 'GRAM',
              'LITER', 'ML'
            )
          );

        ALTER TABLE product_packaging_conversions
          DROP CONSTRAINT IF EXISTS chk_ppc_factor_positive;

        ALTER TABLE product_packaging_conversions
          ADD CONSTRAINT chk_ppc_factor_positive
          CHECK (to_base_factor > 0 AND to_base_factor <= 100000.000);

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_ppc_idempotency_key_non_empty'
            AND conrelid = 'product_packaging_conversions'::regclass
        ) THEN
          ALTER TABLE product_packaging_conversions
          ADD CONSTRAINT chk_ppc_idempotency_key_non_empty
          CHECK (
            BTRIM(idempotency_key) <> ''
            AND CHAR_LENGTH(BTRIM(idempotency_key)) <= 150
          );
        END IF;
      END $$;

      CREATE UNIQUE INDEX IF NOT EXISTS uq_ppc_item_packaging_code
        ON product_packaging_conversions(property_id, menu_item_id, UPPER(BTRIM(packaging_code)));

      CREATE UNIQUE INDEX IF NOT EXISTS uq_ppc_item_packaging_label
        ON product_packaging_conversions(property_id, menu_item_id, LOWER(BTRIM(packaging_label)));

      CREATE UNIQUE INDEX IF NOT EXISTS uq_ppc_item_idempotency_key
        ON product_packaging_conversions(property_id, menu_item_id, BTRIM(idempotency_key));

      CREATE UNIQUE INDEX IF NOT EXISTS uq_ppc_default_purchase_per_item
        ON product_packaging_conversions(property_id, menu_item_id)
        WHERE is_default_purchase = TRUE AND is_active = TRUE;
    `,
  },
  {
    id: '06_create_packaging_and_base_unit_guard_triggers',
    description: 'Create DB-level guard triggers for base unit lock and packaging conversion consistency',
    sql: `
      CREATE OR REPLACE FUNCTION trg_fn_guard_pos_menu_item_base_unit()
      RETURNS TRIGGER AS $$
      DECLARE
        v_old_base_trimmed TEXT := LOWER(BTRIM(COALESCE(OLD.base_unit, '')));
        v_new_base_trimmed TEXT := LOWER(BTRIM(COALESCE(NEW.base_unit, '')));
        v_is_initial_assignment BOOLEAN := FALSE;
        v_is_equivalent_promotion BOOLEAN := FALSE;
        v_is_unit_changing BOOLEAN := FALSE;
        v_has_minibar_usage BOOLEAN := FALSE;
      BEGIN
        v_is_initial_assignment := (
          OLD.canonical_base_unit_code IS NULL
          AND v_old_base_trimmed = ''
        );

        IF (
          OLD.canonical_base_unit_code IS NULL
          AND NEW.canonical_base_unit_code IS NOT NULL
          AND v_old_base_trimmed <> ''
        ) THEN
          v_is_equivalent_promotion := (
            v_old_base_trimmed = LOWER(NEW.canonical_base_unit_code)
            OR (NEW.canonical_base_unit_code = 'PCS' AND v_old_base_trimmed IN ('pcs', 'pc', 'piece', 'pieces', 'buah', 'biji', 'unit'))
            OR (NEW.canonical_base_unit_code = 'PORSI' AND v_old_base_trimmed IN ('porsi', 'portion', 'serving', 'piring', 'plate', 'mangkuk', 'bowl'))
            OR (NEW.canonical_base_unit_code = 'GELAS' AND v_old_base_trimmed IN ('gelas', 'glass'))
            OR (NEW.canonical_base_unit_code = 'CUP' AND v_old_base_trimmed IN ('cup', 'cups', 'cangkir'))
            OR (NEW.canonical_base_unit_code = 'BOTOL' AND v_old_base_trimmed IN ('botol', 'btl', 'bottle', 'bottles'))
            OR (NEW.canonical_base_unit_code = 'KALENG' AND v_old_base_trimmed IN ('kaleng', 'klg', 'can', 'cans', 'tin'))
            OR (NEW.canonical_base_unit_code = 'PACK' AND v_old_base_trimmed IN ('pack', 'pak', 'bungkus', 'bks', 'sachet', 'sct', 'pouch'))
            OR (NEW.canonical_base_unit_code = 'BOX' AND v_old_base_trimmed IN ('box', 'kotak', 'dus', 'doos', 'karton', 'ctn', 'carton', 'crate', 'krat'))
            OR (NEW.canonical_base_unit_code = 'ROLL' AND v_old_base_trimmed IN ('roll', 'rol', 'gulung'))
            OR (NEW.canonical_base_unit_code = 'SET' AND v_old_base_trimmed IN ('set', 'pasang', 'pair', 'kit'))
            OR (NEW.canonical_base_unit_code = 'LEMBAR' AND v_old_base_trimmed IN ('lembar', 'lbr', 'sheet', 'sheets', 'helai', 'slice'))
            OR (NEW.canonical_base_unit_code = 'KG' AND v_old_base_trimmed IN ('kg', 'kilogram', 'kilo', 'kgs'))
            OR (NEW.canonical_base_unit_code = 'GRAM' AND v_old_base_trimmed IN ('gram', 'gr', 'g', 'gm', 'grams'))
            OR (NEW.canonical_base_unit_code = 'LITER' AND v_old_base_trimmed IN ('liter', 'ltr', 'l', 'lt', 'litre', 'liters'))
            OR (NEW.canonical_base_unit_code = 'ML' AND v_old_base_trimmed IN ('ml', 'milliliter', 'mililiter', 'millilitre', 'cc'))
          );
        END IF;

        IF NOT v_is_initial_assignment AND NOT v_is_equivalent_promotion THEN
          IF OLD.canonical_base_unit_code IS DISTINCT FROM NEW.canonical_base_unit_code THEN
            v_is_unit_changing := TRUE;
          ELSIF OLD.canonical_base_unit_code IS NULL AND NEW.canonical_base_unit_code IS NULL AND v_old_base_trimmed IS DISTINCT FROM v_new_base_trimmed THEN
            v_is_unit_changing := TRUE;
          END IF;
        END IF;

        IF v_is_unit_changing THEN
          IF EXISTS (
            SELECT 1
            FROM product_packaging_conversions ppc
            WHERE ppc.property_id = NEW.property_id
              AND ppc.menu_item_id = NEW.id
              AND ppc.is_active = TRUE
          ) THEN
            RAISE EXCEPTION 'BASE_UNIT_LOCKED_BY_USAGE: Satuan dasar tidak dapat diubah selama produk memiliki kemasan aktif';
          END IF;

          IF to_regclass('public.room_type_minibar_standard') IS NOT NULL THEN
            EXECUTE 'SELECT EXISTS (SELECT 1 FROM room_type_minibar_standard WHERE property_id = $1 AND menu_item_id = $2)'
              INTO v_has_minibar_usage USING NEW.property_id, NEW.id;
            IF v_has_minibar_usage THEN
              RAISE EXCEPTION 'BASE_UNIT_LOCKED_BY_USAGE: Satuan dasar tidak dapat diubah karena produk digunakan pada standar minibar kamar';
            END IF;
          END IF;

          IF to_regclass('public.minibar_baseline_verification') IS NOT NULL THEN
            EXECUTE 'SELECT EXISTS (SELECT 1 FROM minibar_baseline_verification WHERE property_id = $1 AND menu_item_id = $2)'
              INTO v_has_minibar_usage USING NEW.property_id, NEW.id;
            IF v_has_minibar_usage THEN
              RAISE EXCEPTION 'BASE_UNIT_LOCKED_BY_USAGE: Satuan dasar tidak dapat diubah karena produk tercatat pada verifikasi baseline minibar';
            END IF;
          END IF;

          IF to_regclass('public.minibar_stay_event') IS NOT NULL THEN
            EXECUTE 'SELECT EXISTS (SELECT 1 FROM minibar_stay_event WHERE property_id = $1 AND menu_item_id = $2)'
              INTO v_has_minibar_usage USING NEW.property_id, NEW.id;
            IF v_has_minibar_usage THEN
              RAISE EXCEPTION 'BASE_UNIT_LOCKED_BY_USAGE: Satuan dasar tidak dapat diubah karena produk tercatat pada riwayat stay event minibar';
            END IF;
          END IF;

          IF to_regclass('public.minibar_inspection_report_line') IS NOT NULL THEN
            EXECUTE 'SELECT EXISTS (SELECT 1 FROM minibar_inspection_report_line WHERE property_id = $1 AND menu_item_id = $2)'
              INTO v_has_minibar_usage USING NEW.property_id, NEW.id;
            IF v_has_minibar_usage THEN
              RAISE EXCEPTION 'BASE_UNIT_LOCKED_BY_USAGE: Satuan dasar tidak dapat diubah karena produk tercatat pada laporan inspeksi minibar';
            END IF;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_guard_pos_menu_item_base_unit ON pos_menu_items;
      CREATE TRIGGER trg_guard_pos_menu_item_base_unit
        BEFORE UPDATE OF canonical_base_unit_code, base_unit ON pos_menu_items
        FOR EACH ROW
        EXECUTE FUNCTION trg_fn_guard_pos_menu_item_base_unit();

      CREATE OR REPLACE FUNCTION trg_fn_guard_product_packaging_conversion()
      RETURNS TRIGGER AS $$
      DECLARE
        v_item_base_unit VARCHAR(20);
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF OLD.base_unit_code IS DISTINCT FROM NEW.base_unit_code THEN
            RAISE EXCEPTION 'IMMUTABLE_PACKAGING_BASE_UNIT: base_unit_code pada kemasan tidak dapat diubah';
          END IF;
          IF BTRIM(OLD.idempotency_key) IS DISTINCT FROM BTRIM(NEW.idempotency_key) THEN
            RAISE EXCEPTION 'IMMUTABLE_IDEMPOTENCY_KEY: idempotency_key pada kemasan tidak dapat diubah';
          END IF;
          IF OLD.create_payload_hash IS DISTINCT FROM NEW.create_payload_hash
             OR OLD.create_payload_snapshot IS DISTINCT FROM NEW.create_payload_snapshot THEN
            RAISE EXCEPTION 'IMMUTABLE_CREATE_PAYLOAD_SNAPSHOT: snapshot penciptaan kemasan tidak dapat diubah';
          END IF;
        END IF;

        SELECT canonical_base_unit_code
          INTO v_item_base_unit
          FROM pos_menu_items
         WHERE id = NEW.menu_item_id
           AND property_id = NEW.property_id
         FOR UPDATE;

        IF v_item_base_unit IS NULL AND (TG_OP = 'INSERT' OR NEW.is_active = TRUE) THEN
          RAISE EXCEPTION 'BASE_UNIT_NOT_CANONICAL: Produk wajib memiliki satuan dasar kanonik sebelum kemasan aktif disimpan';
        END IF;

        IF (TG_OP = 'INSERT' OR NEW.is_active = TRUE OR (TG_OP = 'UPDATE' AND OLD.to_base_factor IS DISTINCT FROM NEW.to_base_factor)) THEN
          IF NEW.base_unit_code IS DISTINCT FROM v_item_base_unit THEN
            RAISE EXCEPTION 'PACKAGING_BASE_UNIT_MISMATCH: Satuan dasar kemasan (%) tidak cocok dengan satuan dasar produk saat ini (%)', NEW.base_unit_code, v_item_base_unit;
          END IF;
        END IF;

        IF NEW.base_unit_code IN ('PCS', 'PORSI', 'GELAS', 'CUP', 'BOTOL', 'KALENG', 'PACK', 'BOX', 'ROLL', 'SET', 'LEMBAR') THEN
          IF MOD(NEW.to_base_factor * 1000, 1000) <> 0 THEN
            RAISE EXCEPTION 'INTEGER_UNIT_REQUIRES_WHOLE_NUMBER: Satuan hitung diskrit wajib memiliki faktor konversi bilangan bulat';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_guard_product_packaging_conversion ON product_packaging_conversions;
      CREATE TRIGGER trg_guard_product_packaging_conversion
        BEFORE INSERT OR UPDATE ON product_packaging_conversions
        FOR EACH ROW
        EXECUTE FUNCTION trg_fn_guard_product_packaging_conversion();
    `,
  },
  {
    id: '07_create_stock_locations_table',
    description: 'Create stock_locations table for property-scoped storage locations and room minibars',
    sql: `
      CREATE TABLE IF NOT EXISTS stock_locations (
        id SERIAL PRIMARY KEY,
        property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
        code VARCHAR(40) NOT NULL,
        name VARCHAR(100) NOT NULL,
        location_type VARCHAR(30) NOT NULL,
        room_id INTEGER NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        notes TEXT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    id: '08_add_stock_locations_constraints_indexes_and_trigger',
    description: 'Add constraints, unique indexes, and identity immutability trigger to stock_locations',
    sql: `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'fk_stock_locations_property_room'
            AND conrelid = 'stock_locations'::regclass
        ) THEN
          ALTER TABLE stock_locations
          ADD CONSTRAINT fk_stock_locations_property_room
          FOREIGN KEY (property_id, room_id)
          REFERENCES rooms(property_id, id) ON DELETE RESTRICT;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_stock_locations_code_format'
            AND conrelid = 'stock_locations'::regclass
        ) THEN
          ALTER TABLE stock_locations
          ADD CONSTRAINT chk_stock_locations_code_format
          CHECK (
            BTRIM(code) <> ''
            AND CHAR_LENGTH(BTRIM(code)) <= 40
            AND code ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'
          );
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_stock_locations_name_non_empty'
            AND conrelid = 'stock_locations'::regclass
        ) THEN
          ALTER TABLE stock_locations
          ADD CONSTRAINT chk_stock_locations_name_non_empty
          CHECK (
            BTRIM(name) <> ''
            AND CHAR_LENGTH(BTRIM(name)) <= 100
          );
        END IF;

        ALTER TABLE stock_locations
          DROP CONSTRAINT IF EXISTS chk_stock_locations_type;

        ALTER TABLE stock_locations
          ADD CONSTRAINT chk_stock_locations_type
          CHECK (
            location_type IN (
              'WAREHOUSE',
              'KITCHEN',
              'POS_OUTLET',
              'HK_PANTRY',
              'ROOM_MINIBAR'
            )
          );

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_stock_locations_room_minibar_rule'
            AND conrelid = 'stock_locations'::regclass
        ) THEN
          ALTER TABLE stock_locations
          ADD CONSTRAINT chk_stock_locations_room_minibar_rule
          CHECK (
            (location_type = 'ROOM_MINIBAR' AND room_id IS NOT NULL)
            OR (location_type <> 'ROOM_MINIBAR' AND room_id IS NULL)
          );
        END IF;
      END $$;

      CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_locations_property_code
        ON stock_locations(property_id, UPPER(BTRIM(code)));

      CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_locations_property_name
        ON stock_locations(property_id, LOWER(BTRIM(name)));

      CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_locations_property_room_minibar
        ON stock_locations(property_id, room_id)
        WHERE location_type = 'ROOM_MINIBAR' AND room_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_stock_locations_property_type_active
        ON stock_locations(property_id, location_type, is_active);

      CREATE OR REPLACE FUNCTION trg_fn_guard_stock_location_identity()
      RETURNS TRIGGER AS $$
      BEGIN
        IF OLD.property_id IS DISTINCT FROM NEW.property_id
           OR OLD.location_type IS DISTINCT FROM NEW.location_type
           OR OLD.room_id IS DISTINCT FROM NEW.room_id THEN
          RAISE EXCEPTION 'IMMUTABLE_LOCATION_IDENTITY: property_id, location_type, dan room_id pada stock_locations tidak dapat diubah setelah dibuat';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_guard_stock_location_identity ON stock_locations;
      CREATE TRIGGER trg_guard_stock_location_identity
        BEFORE UPDATE ON stock_locations
        FOR EACH ROW
        EXECUTE FUNCTION trg_fn_guard_stock_location_identity();
    `,
  },
];

async function verifyPrerequisites(client: PoolClient) {
  const requiredTables = ['pos_menu_items', 'properties', 'rooms'];
  for (const tableName of requiredTables) {
    const res = await client.query(
      `SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1`,
      [tableName]
    );
    if (res.rowCount === 0) {
      throw new Error(`Prerequisite failed: table ${tableName} does not exist in public schema.`);
    }
  }
}

async function verifyPostState(client: PoolClient) {
  const colRes = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'pos_menu_items'
       AND column_name = 'canonical_base_unit_code'`
  );
  if (colRes.rowCount === 0) {
    throw new Error('Post-check failed: column canonical_base_unit_code missing on pos_menu_items');
  }

  const tablesRes = await client.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('product_packaging_conversions', 'stock_locations')`
  );
  const foundTables = new Set((tablesRes.rows || []).map((r: any) => r.table_name));
  for (const required of ['product_packaging_conversions', 'stock_locations']) {
    if (!foundTables.has(required)) {
      throw new Error(`Post-check failed: table ${required} was not created`);
    }
  }
}

export async function runProductMasterMp03cMigration(existingPool?: Pool) {
  const pool =
    existingPool ??
    new Pool({
      user: process.env.DB_USER || 'postgres',
      host: process.env.DB_HOST || 'localhost',
      database: process.env.DB_NAME || 'oak_hotel_db',
      password: process.env.DB_PASSWORD || 'password',
      port: parseInt(process.env.DB_PORT || '5432', 10),
    });

  const client = await pool.connect();
  try {
    console.log('Starting Product Master MP-03C migration...');
    await client.query('BEGIN');
    await verifyPrerequisites(client);

    for (const step of PRODUCT_MASTER_MP03C_STEPS) {
      console.log(`Applying ${step.id}: ${step.description}`);
      await client.query(step.sql);
    }

    await verifyPostState(client);
    await client.query('COMMIT');
    console.log('Product Master MP-03C migration completed successfully.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    if (!existingPool) {
      await pool.end();
    }
  }
}

export async function runProductMasterMp03cMigrationCli(options?: {
  createPool?: () => Pick<Pool, 'connect' | 'end'>;
  onError?: (err: unknown) => void;
  setExitCode?: (code: number) => void;
}): Promise<number> {
  const pool = options?.createPool
    ? options.createPool()
    : new Pool({
        user: process.env.DB_USER || 'postgres',
        host: process.env.DB_HOST || 'localhost',
        database: process.env.DB_NAME || 'oak_hotel_db',
        password: process.env.DB_PASSWORD || 'password',
        port: parseInt(process.env.DB_PORT || '5432', 10),
      });

  const handleError = options?.onError ?? ((err: unknown) => console.error('Product Master MP-03C migration failed:', err));
  const applyExitCode = options?.setExitCode ?? ((code: number) => { process.exitCode = code; });

  try {
    await runProductMasterMp03cMigration(pool as Pool);
    return 0;
  } catch (err) {
    handleError(err);
    applyExitCode(1);
    return 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void runProductMasterMp03cMigrationCli();
}

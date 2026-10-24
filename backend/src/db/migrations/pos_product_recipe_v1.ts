import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const MIGRATION_VERSION = 'pos_product_recipe_v1';

export type MigrationStep = {
  id: string;
  description: string;
  sql: string;
};

export const POS_PRODUCT_RECIPE_STEPS: MigrationStep[] = [
  {
    id: '01_create_pos_product_uoms_table',
    description: 'Create pos_product_uoms table for recipe ingredient measurement units',
    sql: `
      CREATE TABLE IF NOT EXISTS pos_product_uoms (
        id SERIAL PRIMARY KEY,
        property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE,
        code VARCHAR(20) NOT NULL,
        name VARCHAR(50) NOT NULL,
        category VARCHAR(30) DEFAULT 'GENERAL',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_product_uoms_prop_code
        ON pos_product_uoms (COALESCE(property_id, 0), UPPER(code));
    `,
  },
  {
    id: '02_seed_pos_product_uoms_standard',
    description: 'Seed standard units of measurement (Gram, ML, Pcs, etc.)',
    sql: `
      INSERT INTO pos_product_uoms (property_id, code, name, category)
      VALUES
        (NULL, 'GRAM', 'Gram', 'WEIGHT'),
        (NULL, 'KG', 'Kilogram', 'WEIGHT'),
        (NULL, 'ML', 'Mililiter', 'VOLUME'),
        (NULL, 'LITER', 'Liter', 'VOLUME'),
        (NULL, 'PCS', 'Pieces', 'COUNT'),
        (NULL, 'PORSI', 'Porsi', 'COUNT'),
        (NULL, 'CUP', 'Cup', 'COUNT'),
        (NULL, 'GELAS', 'Gelas', 'COUNT'),
        (NULL, 'BOTOL', 'Botol', 'COUNT'),
        (NULL, 'KALENG', 'Kaleng', 'COUNT'),
        (NULL, 'PACK', 'Pack', 'COUNT'),
        (NULL, 'BOX', 'Box', 'COUNT'),
        (NULL, 'ROLL', 'Roll', 'COUNT'),
        (NULL, 'SET', 'Set', 'COUNT'),
        (NULL, 'LEMBAR', 'Lembar', 'COUNT')
      ON CONFLICT DO NOTHING;
    `,
  },
  {
    id: '03_add_is_raw_material_to_pos_menu_items',
    description: 'Add is_raw_material flag to pos_menu_items for raw material identification',
    sql: `
      ALTER TABLE pos_menu_items
        ADD COLUMN IF NOT EXISTS is_raw_material BOOLEAN NOT NULL DEFAULT FALSE;

      UPDATE pos_menu_items
         SET is_raw_material = TRUE
       WHERE product_type = 'RAW_MATERIAL' AND is_raw_material = FALSE;

      CREATE INDEX IF NOT EXISTS idx_pos_menu_items_property_raw_material
        ON pos_menu_items (property_id, is_raw_material)
        WHERE is_raw_material = TRUE;
    `,
  },
  {
    id: '04_create_pos_product_recipes_table',
    description: 'Create pos_product_recipes table for Bill of Materials (BOM)',
    sql: `
      CREATE TABLE IF NOT EXISTS pos_product_recipes (
        id SERIAL PRIMARY KEY,
        property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL REFERENCES pos_menu_items(id) ON DELETE CASCADE,
        ingredient_product_id INTEGER NOT NULL REFERENCES pos_menu_items(id) ON DELETE RESTRICT,
        quantity NUMERIC(12, 4) NOT NULL,
        uom_id INTEGER REFERENCES pos_product_uoms(id) ON DELETE SET NULL,
        notes VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_pos_product_recipes_quantity_positive CHECK (quantity > 0),
        CONSTRAINT chk_pos_product_recipes_no_self_ref CHECK (product_id <> ingredient_product_id),
        CONSTRAINT uq_pos_product_recipes_prop_prod_ing UNIQUE (property_id, product_id, ingredient_product_id)
      );

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_pos_product_recipes_quantity_positive'
            AND conrelid = 'pos_product_recipes'::regclass
        ) THEN
          ALTER TABLE pos_product_recipes
            ADD CONSTRAINT chk_pos_product_recipes_quantity_positive CHECK (quantity > 0);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_pos_product_recipes_no_self_ref'
            AND conrelid = 'pos_product_recipes'::regclass
        ) THEN
          ALTER TABLE pos_product_recipes
            ADD CONSTRAINT chk_pos_product_recipes_no_self_ref CHECK (product_id <> ingredient_product_id);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'uq_pos_product_recipes_prop_prod_ing'
            AND conrelid = 'pos_product_recipes'::regclass
        ) THEN
          ALTER TABLE pos_product_recipes
            ADD CONSTRAINT uq_pos_product_recipes_prop_prod_ing UNIQUE (property_id, product_id, ingredient_product_id);
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_pos_product_recipes_product
        ON pos_product_recipes (property_id, product_id);

      CREATE INDEX IF NOT EXISTS idx_pos_product_recipes_ingredient
        ON pos_product_recipes (property_id, ingredient_product_id);
    `,
  },
  {
    id: '05_create_pos_products_compatibility_view',
    description: 'Create pos_products view pointing to pos_menu_items for backward/dual naming compatibility',
    sql: `
      CREATE OR REPLACE VIEW pos_products AS
        SELECT * FROM pos_menu_items;
    `,
  },
  {
    id: '06_record_schema_migrations_version',
    description: 'Record pos_product_recipe_v1 in schema_migrations table',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      INSERT INTO schema_migrations (version, applied_at)
      VALUES ('${MIGRATION_VERSION}', NOW())
      ON CONFLICT (version) DO UPDATE SET applied_at = NOW();
    `,
  },
];

export async function runPosProductRecipeMigration(poolOrClient: Pool | PoolClient): Promise<void> {
  const isPool = 'connect' in poolOrClient && typeof (poolOrClient as Pool).connect === 'function';
  const client: PoolClient = isPool ? await (poolOrClient as Pool).connect() : (poolOrClient as PoolClient);

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const checkMigration = await client.query(
      `SELECT version FROM schema_migrations WHERE version = $1`,
      [MIGRATION_VERSION]
    );

    if (checkMigration.rows.length > 0) {
      return;
    }

    await client.query('BEGIN');
    for (const step of POS_PRODUCT_RECIPE_STEPS) {
      await client.query(step.sql);
    }
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw err;
  } finally {
    if (isPool) {
      client.release();
    }
  }
}

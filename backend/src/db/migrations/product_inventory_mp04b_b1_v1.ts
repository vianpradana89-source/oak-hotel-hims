import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const MIGRATION_VERSION = 'product_inventory_mp04b_b1_v1';

export type MigrationStep = {
  id: string;
  description: string;
  sql: string;
};

export const PRODUCT_INVENTORY_MP04B_B1_STEPS: MigrationStep[] = [
  {
    id: '01_add_track_stock_to_pos_menu_items',
    description: 'Add track_stock column with default FALSE to pos_menu_items table',
    sql: `
      ALTER TABLE pos_menu_items
      ADD COLUMN IF NOT EXISTS track_stock BOOLEAN NOT NULL DEFAULT FALSE;

      CREATE INDEX IF NOT EXISTS idx_pos_menu_items_property_track_stock
        ON pos_menu_items(property_id, track_stock)
        WHERE track_stock = TRUE;
    `,
  },
  {
    id: '02_create_stock_operations_table',
    description: 'Create stock_operations table for ledger operation headers with idempotency constraint',
    sql: `
      CREATE TABLE IF NOT EXISTS stock_operations (
        id BIGSERIAL PRIMARY KEY,
        property_id INTEGER NOT NULL REFERENCES properties(id),
        operation_type VARCHAR(50) NOT NULL,
        operation_key VARCHAR(100) NOT NULL,
        payload_fingerprint VARCHAR(128) NOT NULL,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_stock_operations_prop_key UNIQUE (property_id, operation_key)
      );

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'uq_stock_operations_prop_key'
            AND conrelid = 'stock_operations'::regclass
        ) THEN
          ALTER TABLE stock_operations
            ADD CONSTRAINT uq_stock_operations_prop_key UNIQUE (property_id, operation_key);
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_stock_operations_property_type
        ON stock_operations(property_id, operation_type);
    `,
  },
  {
    id: '03_create_stock_movements_table',
    description: 'Create stock_movements table for append-only inventory ledger mutations',
    sql: `
      CREATE TABLE IF NOT EXISTS stock_movements (
        id BIGSERIAL PRIMARY KEY,
        operation_id BIGINT NOT NULL REFERENCES stock_operations(id),
        property_id INTEGER NOT NULL REFERENCES properties(id),
        product_id INTEGER NOT NULL REFERENCES pos_menu_items(id),
        location_id INTEGER NOT NULL REFERENCES stock_locations(id),
        packaging_id INTEGER REFERENCES product_packaging_conversions(id),
        packaging_code VARCHAR(30),
        packaging_label VARCHAR(60),
        quantity_delta NUMERIC(12, 3) NOT NULL,
        base_unit_code VARCHAR(20) NOT NULL,
        unit_cost NUMERIC(14, 2),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_stock_movements_property_product_location
        ON stock_movements(property_id, product_id, location_id);

      CREATE INDEX IF NOT EXISTS idx_stock_movements_operation_id
        ON stock_movements(operation_id);
    `,
  },
  {
    id: '04_create_stock_balances_table',
    description: 'Create stock_balances table for projected stock quantities with non-negative check constraint',
    sql: `
      CREATE TABLE IF NOT EXISTS stock_balances (
        id BIGSERIAL PRIMARY KEY,
        property_id INTEGER NOT NULL REFERENCES properties(id),
        product_id INTEGER NOT NULL REFERENCES pos_menu_items(id),
        location_id INTEGER NOT NULL REFERENCES stock_locations(id),
        quantity NUMERIC(12, 3) NOT NULL DEFAULT 0.000,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_stock_balance_non_negative CHECK (quantity >= 0),
        CONSTRAINT uq_stock_balances_product_location UNIQUE (property_id, product_id, location_id)
      );

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_stock_balance_non_negative'
            AND conrelid = 'stock_balances'::regclass
        ) THEN
          ALTER TABLE stock_balances
            ADD CONSTRAINT chk_stock_balance_non_negative CHECK (quantity >= 0);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'uq_stock_balances_product_location'
            AND conrelid = 'stock_balances'::regclass
        ) THEN
          ALTER TABLE stock_balances
            ADD CONSTRAINT uq_stock_balances_product_location UNIQUE (property_id, product_id, location_id);
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_stock_balances_property_product
        ON stock_balances(property_id, product_id);
    `,
  },
  {
    id: '05_create_stock_cutover_windows_table',
    description: 'Create stock_cutover_windows table for cutover management and active window constraint',
    sql: `
      CREATE TABLE IF NOT EXISTS stock_cutover_windows (
        id BIGSERIAL PRIMARY KEY,
        property_id INTEGER NOT NULL REFERENCES properties(id),
        cutover_at TIMESTAMPTZ NOT NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'OPEN',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_stock_cutover_prop_active UNIQUE (property_id, status)
      );

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'uq_stock_cutover_prop_active'
            AND conrelid = 'stock_cutover_windows'::regclass
        ) THEN
          ALTER TABLE stock_cutover_windows
            ADD CONSTRAINT uq_stock_cutover_prop_active UNIQUE (property_id, status);
        END IF;
      END $$;
    `,
  },
  {
    id: '06_create_stock_movements_append_only_trigger',
    description: 'Create trigger function and trigger to enforce append-only rule on stock_movements (reject UPDATE, DELETE, TRUNCATE)',
    sql: `
      CREATE OR REPLACE FUNCTION trg_fn_stock_movements_append_only()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          RAISE EXCEPTION 'STOCK_MOVEMENTS_APPEND_ONLY: Perubahan (UPDATE) pada stock_movements dilarang';
        ELSIF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'STOCK_MOVEMENTS_APPEND_ONLY: Penghapusan (DELETE) pada stock_movements dilarang';
        ELSIF TG_OP = 'TRUNCATE' THEN
          RAISE EXCEPTION 'STOCK_MOVEMENTS_APPEND_ONLY: Pembersihan (TRUNCATE) pada stock_movements dilarang';
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_guard_stock_movements_append_only ON stock_movements;
      CREATE TRIGGER trg_guard_stock_movements_append_only
        BEFORE UPDATE OR DELETE ON stock_movements
        FOR EACH ROW
        EXECUTE FUNCTION trg_fn_stock_movements_append_only();

      DROP TRIGGER IF EXISTS trg_guard_stock_movements_no_truncate ON stock_movements;
      CREATE TRIGGER trg_guard_stock_movements_no_truncate
        BEFORE TRUNCATE ON stock_movements
        FOR EACH STATEMENT
        EXECUTE FUNCTION trg_fn_stock_movements_append_only();
    `,
  },
  {
    id: '07_record_schema_migrations_version',
    description: 'Record product_inventory_mp04b_b1_v1 in schema_migrations table',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(120) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      INSERT INTO schema_migrations (version)
      VALUES ('product_inventory_mp04b_b1_v1')
      ON CONFLICT (version) DO NOTHING;
    `,
  },
];

async function verifyPrerequisites(client: PoolClient): Promise<void> {
  const requiredTables = [
    'properties',
    'pos_menu_items',
    'stock_locations',
    'product_packaging_conversions',
  ];

  const res = await client.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])`,
    [requiredTables]
  );

  const found = new Set(res.rows.map((r: { table_name: string }) => r.table_name));
  for (const table of requiredTables) {
    if (!found.has(table)) {
      throw new Error(`Prerequisite check failed: required table "${table}" not found.`);
    }
  }
}

async function verifyPostState(client: PoolClient): Promise<void> {
  const colCheck = await client.query(`
    SELECT column_name, data_type, column_default
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'pos_menu_items'
       AND column_name = 'track_stock'
  `);
  if (colCheck.rowCount === 0) {
    throw new Error('Post-check failed: column "pos_menu_items.track_stock" was not created.');
  }

  const createdTables = [
    'stock_operations',
    'stock_movements',
    'stock_balances',
    'stock_cutover_windows',
  ];

  const res = await client.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])`,
    [createdTables]
  );

  const foundTables = new Set(res.rows.map((r: { table_name: string }) => r.table_name));
  for (const required of createdTables) {
    if (!foundTables.has(required)) {
      throw new Error(`Post-check failed: table "${required}" was not created.`);
    }
  }

  const constraintCheck = await client.query(`
    SELECT conname
      FROM pg_constraint
     WHERE conname IN (
       'uq_stock_operations_prop_key',
       'chk_stock_balance_non_negative',
       'uq_stock_balances_product_location',
       'uq_stock_cutover_prop_active'
     )
  `);
  const foundConstraints = new Set(constraintCheck.rows.map((r: { conname: string }) => r.conname));
  for (const con of [
    'uq_stock_operations_prop_key',
    'chk_stock_balance_non_negative',
    'uq_stock_balances_product_location',
    'uq_stock_cutover_prop_active',
  ]) {
    if (!foundConstraints.has(con)) {
      throw new Error(`Post-check failed: constraint "${con}" not found.`);
    }
  }

  const triggerCheck = await client.query(`
    SELECT tgname
      FROM pg_trigger
     WHERE tgname = 'trg_guard_stock_movements_append_only'
       AND tgrelid = 'stock_movements'::regclass
  `);
  if (triggerCheck.rowCount === 0) {
    throw new Error('Post-check failed: trigger "trg_guard_stock_movements_append_only" not found.');
  }
}

export async function runProductInventoryMp04bB1Migration(existingPool?: Pool): Promise<void> {
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
    console.log(`Starting Product Inventory MP-04B Batch 1 migration (${MIGRATION_VERSION})...`);
    await client.query('BEGIN');

    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('oak_migration'), hashtext($1))`,
      [MIGRATION_VERSION]
    );

    await verifyPrerequisites(client);

    for (const step of PRODUCT_INVENTORY_MP04B_B1_STEPS) {
      console.log(`Applying ${step.id}: ${step.description}`);
      await client.query(step.sql);
    }

    await verifyPostState(client);
    await client.query('COMMIT');
    console.log(`Product Inventory MP-04B Batch 1 migration (${MIGRATION_VERSION}) completed successfully.`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    if (!existingPool) {
      await pool.end();
    }
  }
}

export async function runProductInventoryMp04bB1MigrationCli(options?: {
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

  const handleError = options?.onError ?? ((err: unknown) => console.error('Product Inventory MP-04B Batch 1 migration failed:', err));
  const applyExitCode = options?.setExitCode ?? ((code: number) => { process.exitCode = code; });

  try {
    await runProductInventoryMp04bB1Migration(pool as Pool);
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
  void runProductInventoryMp04bB1MigrationCli();
}

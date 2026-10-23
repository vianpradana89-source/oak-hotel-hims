import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const MIGRATION_VERSION = 'product_inventory_mp04b_b3_v1';

export type MigrationStep = {
  id: string;
  description: string;
  sql: string;
};

export const PRODUCT_INVENTORY_MP04B_B3_STEPS: MigrationStep[] = [
  {
    id: '01_create_stock_purchase_line_bindings_table',
    description: 'Create stock_purchase_line_bindings table for line-level purchase receipt tracking (MP-04B B-3)',
    sql: `
      CREATE TABLE IF NOT EXISTS stock_purchase_line_bindings (
        id BIGSERIAL PRIMARY KEY,
        property_id INTEGER NOT NULL REFERENCES properties(id),
        transaction_id INTEGER NOT NULL,
        transaction_line_id INTEGER NOT NULL,
        line_type VARCHAR(30) NOT NULL DEFAULT 'STOCK',
        product_id INTEGER REFERENCES pos_menu_items(id),
        destination_location_id INTEGER REFERENCES stock_locations(id),
        packaging_id INTEGER REFERENCES product_packaging_conversions(id),
        ordered_quantity NUMERIC(12, 3) NOT NULL,
        received_quantity NUMERIC(12, 3) NOT NULL DEFAULT 0.000,
        base_unit_code VARCHAR(20) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_purchase_line_type CHECK (line_type IN ('STOCK', 'NON_STOCK_PHYSICAL', 'SERVICE')),
        CONSTRAINT chk_purchase_line_quantities CHECK (ordered_quantity >= 0 AND received_quantity >= 0),
        CONSTRAINT uq_purchase_line_binding UNIQUE (property_id, transaction_id, transaction_line_id)
      );

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'uq_purchase_line_binding'
            AND conrelid = 'stock_purchase_line_bindings'::regclass
        ) THEN
          ALTER TABLE stock_purchase_line_bindings
            ADD CONSTRAINT uq_purchase_line_binding UNIQUE (property_id, transaction_id, transaction_line_id);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_purchase_line_type'
            AND conrelid = 'stock_purchase_line_bindings'::regclass
        ) THEN
          ALTER TABLE stock_purchase_line_bindings
            ADD CONSTRAINT chk_purchase_line_type CHECK (line_type IN ('STOCK', 'NON_STOCK_PHYSICAL', 'SERVICE'));
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_purchase_line_quantities'
            AND conrelid = 'stock_purchase_line_bindings'::regclass
        ) THEN
          ALTER TABLE stock_purchase_line_bindings
            ADD CONSTRAINT chk_purchase_line_quantities CHECK (ordered_quantity >= 0 AND received_quantity >= 0);
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_purchase_line_bindings_tx
        ON stock_purchase_line_bindings(property_id, transaction_id);

      CREATE INDEX IF NOT EXISTS idx_purchase_line_bindings_prod
        ON stock_purchase_line_bindings(property_id, product_id);
    `,
  },
  {
    id: '02_add_stock_operations_purchase_receipt_columns',
    description: 'Add transaction_id, notes, and metadata columns to stock_operations for purchase receipt auditability',
    sql: `
      ALTER TABLE stock_operations
        ADD COLUMN IF NOT EXISTS transaction_id BIGINT,
        ADD COLUMN IF NOT EXISTS notes TEXT,
        ADD COLUMN IF NOT EXISTS metadata JSONB;

      CREATE INDEX IF NOT EXISTS idx_stock_operations_property_tx
        ON stock_operations(property_id, transaction_id)
        WHERE transaction_id IS NOT NULL;
    `,
  },
  {
    id: '03_ensure_transactions_receiving_columns',
    description: 'Ensure receiving_status and received_at exist on transactions table if present',
    sql: `
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = current_schema() AND table_name = 'transactions'
        ) THEN
          ALTER TABLE transactions
            ADD COLUMN IF NOT EXISTS receiving_status VARCHAR(50) DEFAULT NULL,
            ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ DEFAULT NULL;
        END IF;
      END $$;
    `,
  },
  {
    id: '04_record_schema_migrations_version',
    description: 'Record product_inventory_mp04b_b3_v1 in schema_migrations table',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      INSERT INTO schema_migrations (version)
      VALUES ('product_inventory_mp04b_b3_v1')
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
    'stock_operations',
    'stock_movements',
    'stock_balances',
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
  const tableCheck = await client.query(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name = 'stock_purchase_line_bindings'
  `);
  if (tableCheck.rowCount === 0) {
    throw new Error('Post-check failed: table "stock_purchase_line_bindings" was not created.');
  }

  const constraintCheck = await client.query(`
    SELECT conname
      FROM pg_constraint
     WHERE conname = 'uq_purchase_line_binding'
       AND conrelid = 'stock_purchase_line_bindings'::regclass
  `);
  if (constraintCheck.rowCount === 0) {
    throw new Error('Post-check failed: constraint "uq_purchase_line_binding" not found.');
  }
}

export async function runProductInventoryMp04bB3Migration(existingPool?: Pool): Promise<void> {
  const pool =
    existingPool ??
    new Pool({
      user: process.env.DB_USER || 'postgres',
      host: process.env.DB_HOST || 'localhost',
      database: process.env.DB_NAME || 'oak_hotel_db',
      password: process.env.DB_PASSWORD || 'postgres',
      port: Number(process.env.DB_PORT) || 5432,
    });

  const client = await pool.connect();
  try {
    console.log(`Starting Product Inventory MP-04B Batch 3 migration (${MIGRATION_VERSION})...`);

    await verifyPrerequisites(client);

    await client.query('BEGIN');
    for (const step of PRODUCT_INVENTORY_MP04B_B3_STEPS) {
      console.log(`Applying ${step.id}: ${step.description}`);
      await client.query(step.sql);
    }
    await client.query('COMMIT');

    await verifyPostState(client);
    console.log(`Product Inventory MP-04B Batch 3 migration (${MIGRATION_VERSION}) completed successfully.`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`Migration ${MIGRATION_VERSION} failed:`, error);
    throw error;
  } finally {
    client.release();
    if (!existingPool) {
      await pool.end();
    }
  }
}

import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const MIGRATION_VERSION = 'pos_purchase_orders_v1';

export type MigrationStep = {
  id: string;
  description: string;
  sql: string;
};

export const POS_PURCHASE_ORDER_STEPS: MigrationStep[] = [
  {
    id: '01_create_pos_suppliers_table',
    description: 'Create pos_suppliers table for property-scoped vendor/supplier management',
    sql: `
      CREATE TABLE IF NOT EXISTS pos_suppliers (
        id SERIAL PRIMARY KEY,
        property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
        code VARCHAR(50) NOT NULL,
        name VARCHAR(150) NOT NULL,
        contact_person VARCHAR(100),
        phone VARCHAR(50),
        email VARCHAR(100),
        address TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_pos_suppliers_property_code UNIQUE (property_id, code)
      );

      CREATE INDEX IF NOT EXISTS idx_pos_suppliers_property ON pos_suppliers(property_id);
      CREATE INDEX IF NOT EXISTS idx_pos_suppliers_property_active ON pos_suppliers(property_id, is_active);
    `,
  },
  {
    id: '02_add_cost_columns_to_pos_menu_items',
    description: 'Add average_cost and last_cost columns to pos_menu_items for inventory valuation',
    sql: `
      ALTER TABLE pos_menu_items
        ADD COLUMN IF NOT EXISTS average_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_cost NUMERIC(14,2) NOT NULL DEFAULT 0;
    `,
  },
  {
    id: '03_create_pos_purchase_orders_table',
    description: 'Create pos_purchase_orders table for purchase order headers',
    sql: `
      CREATE TABLE IF NOT EXISTS pos_purchase_orders (
        id SERIAL PRIMARY KEY,
        property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
        po_number VARCHAR(50) NOT NULL,
        supplier_id INTEGER NOT NULL REFERENCES pos_suppliers(id),
        order_date DATE NOT NULL DEFAULT CURRENT_DATE,
        expected_date DATE,
        status VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
        notes TEXT,
        total_estimated_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        created_by VARCHAR(100),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_pos_purchase_orders_property_po UNIQUE (property_id, po_number),
        CONSTRAINT chk_pos_purchase_orders_status
          CHECK (status IN ('DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'COMPLETED', 'CANCELLED'))
      );

      CREATE INDEX IF NOT EXISTS idx_pos_purchase_orders_prop_status ON pos_purchase_orders(property_id, status);
      CREATE INDEX IF NOT EXISTS idx_pos_purchase_orders_prop_supplier ON pos_purchase_orders(property_id, supplier_id);
    `,
  },
  {
    id: '04_create_pos_purchase_order_items_table',
    description: 'Create pos_purchase_order_items table for purchase order line items',
    sql: `
      CREATE TABLE IF NOT EXISTS pos_purchase_order_items (
        id SERIAL PRIMARY KEY,
        po_id INTEGER NOT NULL REFERENCES pos_purchase_orders(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL REFERENCES pos_menu_items(id),
        ordered_qty NUMERIC(12,4) NOT NULL CHECK (ordered_qty > 0),
        received_qty NUMERIC(12,4) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
        unit_cost NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
        uom_id INTEGER REFERENCES pos_product_uoms(id),
        notes VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_pos_purchase_order_items_po_prod UNIQUE (po_id, product_id)
      );

      CREATE INDEX IF NOT EXISTS idx_pos_po_items_po_id ON pos_purchase_order_items(po_id);
    `,
  },
  {
    id: '05_create_pos_goods_receipts_table',
    description: 'Create pos_goods_receipts table for Goods Receipt Note (GRN) headers',
    sql: `
      CREATE TABLE IF NOT EXISTS pos_goods_receipts (
        id SERIAL PRIMARY KEY,
        property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
        grn_number VARCHAR(50) NOT NULL,
        po_id INTEGER REFERENCES pos_purchase_orders(id),
        supplier_id INTEGER REFERENCES pos_suppliers(id),
        location_id INTEGER REFERENCES stock_locations(id),
        receipt_date DATE NOT NULL DEFAULT CURRENT_DATE,
        invoice_no VARCHAR(100),
        received_by VARCHAR(100),
        status VARCHAR(30) NOT NULL DEFAULT 'COMPLETED',
        notes TEXT,
        idempotency_key VARCHAR(120),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_pos_goods_receipts_property_grn UNIQUE (property_id, grn_number),
        CONSTRAINT chk_pos_goods_receipts_status
          CHECK (status IN ('COMPLETED', 'CANCELLED'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_goods_receipts_idemp
        ON pos_goods_receipts(property_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_pos_goods_receipts_prop ON pos_goods_receipts(property_id);
      CREATE INDEX IF NOT EXISTS idx_pos_goods_receipts_po ON pos_goods_receipts(po_id);
    `,
  },
  {
    id: '06_create_pos_goods_receipt_items_table',
    description: 'Create pos_goods_receipt_items table for GRN line details',
    sql: `
      CREATE TABLE IF NOT EXISTS pos_goods_receipt_items (
        id SERIAL PRIMARY KEY,
        receipt_id INTEGER NOT NULL REFERENCES pos_goods_receipts(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL REFERENCES pos_menu_items(id),
        po_item_id INTEGER REFERENCES pos_purchase_order_items(id),
        received_qty NUMERIC(12,4) NOT NULL CHECK (received_qty > 0),
        unit_cost NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
        subtotal NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
        uom_id INTEGER REFERENCES pos_product_uoms(id),
        location_id INTEGER NOT NULL REFERENCES stock_locations(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_pos_grn_items_receipt ON pos_goods_receipt_items(receipt_id);
      CREATE INDEX IF NOT EXISTS idx_pos_grn_items_prod ON pos_goods_receipt_items(product_id);
    `,
  },
  {
    id: '07_record_schema_migrations_version',
    description: 'Record pos_purchase_orders_v1 in schema_migrations table',
    sql: `
      INSERT INTO schema_migrations (version, applied_at)
      VALUES ('pos_purchase_orders_v1', NOW())
      ON CONFLICT (version) DO NOTHING;
    `,
  },
];

export async function runPosPurchaseOrdersMigration(
  clientOrPool: Pool | PoolClient
): Promise<{ applied: string[]; skipped: string[] }> {
  const applied: string[] = [];
  const skipped: string[] = [];

  const checkVersion = await clientOrPool.query(
    `SELECT 1 FROM schema_migrations WHERE version = $1`,
    [MIGRATION_VERSION]
  );
  if (checkVersion.rows.length > 0) {
    return { applied: [], skipped: [MIGRATION_VERSION] };
  }

  for (const step of POS_PURCHASE_ORDER_STEPS) {
    await clientOrPool.query(step.sql);
    applied.push(step.id);
  }

  return { applied, skipped };
}

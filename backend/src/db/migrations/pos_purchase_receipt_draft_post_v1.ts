import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';

if (require.main === module) {
  dotenv.config();
}

export const MIGRATION_VERSION = 'pos_purchase_receipt_draft_post_v1';

export type MigrationStep = {
  id: string;
  description: string;
  sql: string;
};

export const POS_PURCHASE_RECEIPT_DRAFT_POST_STEPS: MigrationStep[] = [
  {
    id: '01_add_approval_columns_to_transactions',
    description: 'Add approval_status and approval metadata to transactions for purchasing approval workflow',
    sql: `
      ALTER TABLE transactions
        ADD COLUMN IF NOT EXISTS approval_status VARCHAR(30) DEFAULT 'PENDING_APPROVAL',
        ADD COLUMN IF NOT EXISTS approved_by_user_id VARCHAR(100),
        ADD COLUMN IF NOT EXISTS approved_by_name_snapshot VARCHAR(150),
        ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_transactions_approval_status'
        ) THEN
          ALTER TABLE transactions ADD CONSTRAINT chk_transactions_approval_status
            CHECK (approval_status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED'));
        END IF;
      EXCEPTION
        WHEN OTHERS THEN NULL;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_transactions_approval_status
        ON transactions(property_id, approval_status);

      -- Backfill only historically completed and fully received purchases to APPROVED
      -- Unreceived or open purchases remain PENDING_APPROVAL pending explicit management approval
      UPDATE transactions
         SET approval_status = 'APPROVED'
       WHERE transaction_type = 'PURCHASE'
         AND transaction_status = 'COMPLETED'
         AND receiving_status = 'SUDAH_DITERIMA'
         AND approval_status IS NULL;

      UPDATE transactions
         SET approval_status = 'PENDING_APPROVAL'
       WHERE transaction_type = 'PURCHASE'
         AND approval_status IS NULL;
    `,
  },
  {
    id: '02_expand_pos_goods_receipts_status_and_columns',
    description: 'Allow DRAFT and POSTED in pos_goods_receipts status and add transaction_id and posting metadata',
    sql: `
      ALTER TABLE pos_goods_receipts DROP CONSTRAINT IF EXISTS chk_pos_goods_receipts_status;
      ALTER TABLE pos_goods_receipts ADD CONSTRAINT chk_pos_goods_receipts_status
        CHECK (status IN ('DRAFT', 'POSTED', 'COMPLETED', 'CANCELLED'));

      ALTER TABLE pos_goods_receipts
        ADD COLUMN IF NOT EXISTS transaction_id BIGINT REFERENCES transactions(id),
        ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS posted_by VARCHAR(100),
        ADD COLUMN IF NOT EXISTS operation_key VARCHAR(120),
        ADD COLUMN IF NOT EXISTS payload_fingerprint VARCHAR(64);

      CREATE INDEX IF NOT EXISTS idx_pos_goods_receipts_status
        ON pos_goods_receipts(property_id, status);

      CREATE INDEX IF NOT EXISTS idx_pos_goods_receipts_tx
        ON pos_goods_receipts(property_id, transaction_id);
    `,
  },
  {
    id: '03_expand_pos_goods_receipt_items_columns',
    description: 'Add transaction_line_id, packaging_id, and base_quantity to pos_goods_receipt_items',
    sql: `
      ALTER TABLE pos_goods_receipt_items
        ADD COLUMN IF NOT EXISTS transaction_line_id BIGINT REFERENCES transaction_lines(id),
        ADD COLUMN IF NOT EXISTS packaging_id INTEGER REFERENCES product_packaging_conversions(id),
        ADD COLUMN IF NOT EXISTS base_quantity NUMERIC(12,4);

      CREATE INDEX IF NOT EXISTS idx_pos_grn_items_tx_line
        ON pos_goods_receipt_items(transaction_line_id);
    `,
  },
  {
    id: '04_record_schema_migrations_version',
    description: 'Record pos_purchase_receipt_draft_post_v1 in schema_migrations table',
    sql: `
      INSERT INTO schema_migrations (version, applied_at)
      VALUES ('pos_purchase_receipt_draft_post_v1', NOW())
      ON CONFLICT (version) DO NOTHING;
    `,
  },
];

export async function runPosPurchaseReceiptDraftPostMigration(
  clientOrPool: Pool | PoolClient
): Promise<{ applied: string[]; skipped: string[] }> {
  const applied: string[] = [];
  const skipped: string[] = [];

  const checkVersion = await clientOrPool.query(
    `SELECT 1 FROM schema_migrations WHERE version = $1`,
    [MIGRATION_VERSION]
  );
  if ((checkVersion.rowCount ?? 0) > 0) {
    return { applied: [], skipped: [MIGRATION_VERSION] };
  }

  for (const step of POS_PURCHASE_RECEIPT_DRAFT_POST_STEPS) {
    await clientOrPool.query(step.sql);
    applied.push(step.id);
  }

  return { applied, skipped };
}

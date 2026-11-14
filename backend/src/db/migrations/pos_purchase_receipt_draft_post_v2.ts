import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';

if (require.main === module) {
  dotenv.config();
}

export const MIGRATION_VERSION = 'pos_purchase_receipt_draft_post_v2';

export type MigrationStep = {
  id: string;
  description: string;
  sql: string;
};

export const POS_PURCHASE_RECEIPT_DRAFT_POST_V2_STEPS: MigrationStep[] = [
  {
    id: '01_add_source_revision_and_packaging_columns',
    description: 'Add source_revision to transactions, packaging_id and line_type to transaction_lines, source_revision_snapshot to pos_goods_receipts, and source_allocated_qty/conversion_factor_snapshot to pos_goods_receipt_items',
    sql: `
      ALTER TABLE transactions
        ADD COLUMN IF NOT EXISTS source_revision INTEGER NOT NULL DEFAULT 1;

      ALTER TABLE transaction_lines
        ADD COLUMN IF NOT EXISTS packaging_id INTEGER REFERENCES product_packaging_conversions(id),
        ADD COLUMN IF NOT EXISTS line_type VARCHAR(30) DEFAULT 'STOCK';

      ALTER TABLE pos_goods_receipts
        ADD COLUMN IF NOT EXISTS source_revision_snapshot INTEGER;

      ALTER TABLE pos_goods_receipt_items
        ADD COLUMN IF NOT EXISTS source_allocated_qty NUMERIC(12,4),
        ADD COLUMN IF NOT EXISTS conversion_factor_snapshot NUMERIC(12,4);

      CREATE TABLE IF NOT EXISTS stock_migration_reconciliation_audit (
        id BIGSERIAL PRIMARY KEY,
        migration_version VARCHAR(100) NOT NULL,
        issue_type VARCHAR(60) NOT NULL,
        severity VARCHAR(20) NOT NULL DEFAULT 'INFO',
        property_id INTEGER,
        entity_table VARCHAR(80) NOT NULL,
        entity_id BIGINT,
        reference_key VARCHAR(200),
        resolution_action VARCHAR(80) NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    id: '02_reconcile_legacy_unapproved_purchases',
    description: 'Reconcile legacy open purchase transactions that were defaulted to APPROVED without explicit approval metadata back to PENDING_APPROVAL',
    sql: `
      UPDATE transactions
         SET approval_status = 'PENDING_APPROVAL'
       WHERE transaction_type = 'PURCHASE'
         AND approval_status = 'APPROVED'
         AND approved_at IS NULL
         AND approved_by_user_id IS NULL
         AND approved_by_name_snapshot IS NULL
         AND NOT (
           transaction_status = 'COMPLETED'
           AND receiving_status IN ('SUDAH_DITERIMA', 'DITERIMA', 'DITERIMA_LENGKAP')
         );
    `,
  },
  {
    id: '03_unique_operation_key_index_on_pos_goods_receipts',
    description: 'Classify and audit duplicate operation_key/idempotency_key in pos_goods_receipts before creating unique partial indexes without silently mutating posted receipts',
    sql: `
      -- 1. Audit and quarantine any duplicate operation_key where BOTH rows are POSTED/COMPLETED
      INSERT INTO stock_migration_reconciliation_audit (
        migration_version, issue_type, severity, property_id, entity_table, entity_id, reference_key, resolution_action, details
      )
      SELECT
        'pos_purchase_receipt_draft_post_v2',
        'DUPLICATE_POSTED_OPERATION_KEY',
        'NEEDS_MANUAL_REVIEW',
        pgr.property_id,
        'pos_goods_receipts',
        pgr.id,
        pgr.operation_key,
        'QUARANTINED_NEEDS_REVIEW',
        jsonb_build_object(
          'grn_number', pgr.grn_number,
          'status', pgr.status,
          'operation_key', pgr.operation_key,
          'transaction_id', pgr.transaction_id,
          'po_id', pgr.po_id
        )
      FROM (
        SELECT id, property_id, operation_key, grn_number, status, transaction_id, po_id,
               COUNT(*) OVER (PARTITION BY property_id, operation_key) AS posted_dup_cnt
          FROM pos_goods_receipts
         WHERE operation_key IS NOT NULL
           AND status IN ('POSTED', 'COMPLETED')
      ) pgr
      WHERE pgr.posted_dup_cnt > 1;

      -- 2. Audit, quarantine, and cancel non-posted (DRAFT/CANCELLED) duplicate operation_key rows so they cannot be posted later
      WITH ranked_ops AS (
        SELECT id, property_id, operation_key, grn_number, status,
               ROW_NUMBER() OVER (
                 PARTITION BY property_id, operation_key
                 ORDER BY CASE WHEN status IN ('POSTED', 'COMPLETED') THEN 0 ELSE 1 END, id ASC
               ) AS rn
          FROM pos_goods_receipts
         WHERE operation_key IS NOT NULL
      ),
      audited_draft_dups AS (
        INSERT INTO stock_migration_reconciliation_audit (
          migration_version, issue_type, severity, property_id, entity_table, entity_id, reference_key, resolution_action, details
        )
        SELECT
          'pos_purchase_receipt_draft_post_v2',
          'DUPLICATE_NON_POSTED_OPERATION_KEY',
          'WARNING',
          ro.property_id,
          'pos_goods_receipts',
          ro.id,
          ro.operation_key,
          'CANCELLED_DUPLICATE_NON_POSTED_KEY',
          jsonb_build_object(
            'grn_number', ro.grn_number,
            'status', ro.status,
            'previous_status', ro.status,
            'new_status', 'CANCELLED',
            'old_operation_key', ro.operation_key,
            'new_operation_key', ro.operation_key || '_dup_draft_' || ro.id::text
          )
        FROM ranked_ops ro
        WHERE ro.rn > 1
          AND ro.status NOT IN ('POSTED', 'COMPLETED')
        RETURNING entity_id
      )
      UPDATE pos_goods_receipts pgr
         SET status = 'CANCELLED',
             operation_key = pgr.operation_key || '_dup_draft_' || pgr.id::text,
             notes = CASE
                       WHEN pgr.notes IS NULL OR btrim(pgr.notes) = ''
                         THEN '[AUTO-CANCELLED DUPLICATE OPERATION_KEY: ' || ro.operation_key || ']'
                       WHEN position('[AUTO-CANCELLED DUPLICATE OPERATION_KEY:' in pgr.notes) > 0
                         THEN pgr.notes
                       ELSE pgr.notes || ' | [AUTO-CANCELLED DUPLICATE OPERATION_KEY: ' || ro.operation_key || ']'
                     END,
             updated_at = NOW()
        FROM ranked_ops ro
       WHERE pgr.id = ro.id
         AND ro.rn > 1
         AND pgr.status NOT IN ('POSTED', 'COMPLETED');

      -- 2b. Audit, quarantine, and cancel non-posted duplicate idempotency_key rows
      WITH ranked_idems AS (
        SELECT id, property_id, idempotency_key, grn_number, status,
               ROW_NUMBER() OVER (
                 PARTITION BY property_id, idempotency_key
                 ORDER BY CASE WHEN status IN ('POSTED', 'COMPLETED') THEN 0 ELSE 1 END, id ASC
               ) AS rn
          FROM pos_goods_receipts
         WHERE idempotency_key IS NOT NULL
      ),
      audited_idem_dups AS (
        INSERT INTO stock_migration_reconciliation_audit (
          migration_version, issue_type, severity, property_id, entity_table, entity_id, reference_key, resolution_action, details
        )
        SELECT
          'pos_purchase_receipt_draft_post_v2',
          'DUPLICATE_NON_POSTED_IDEMPOTENCY_KEY',
          'WARNING',
          ri.property_id,
          'pos_goods_receipts',
          ri.id,
          ri.idempotency_key,
          'CANCELLED_DUPLICATE_NON_POSTED_IDEMPOTENCY_KEY',
          jsonb_build_object(
            'grn_number', ri.grn_number,
            'status', ri.status,
            'previous_status', ri.status,
            'new_status', 'CANCELLED',
            'old_idempotency_key', ri.idempotency_key,
            'new_idempotency_key', ri.idempotency_key || '_dup_draft_' || ri.id::text
          )
        FROM ranked_idems ri
        WHERE ri.rn > 1
          AND ri.status NOT IN ('POSTED', 'COMPLETED')
        RETURNING entity_id
      )
      UPDATE pos_goods_receipts pgr
         SET status = 'CANCELLED',
             idempotency_key = pgr.idempotency_key || '_dup_draft_' || pgr.id::text,
             updated_at = NOW()
        FROM ranked_idems ri
       WHERE pgr.id = ri.id
         AND ri.rn > 1
         AND pgr.status NOT IN ('POSTED', 'COMPLETED');

      -- 3. Create unique partial indexes if no duplicate POSTED keys remain
      DO $$
      DECLARE
        v_posted_op_dups INTEGER := 0;
        v_posted_idem_dups INTEGER := 0;
      BEGIN
        SELECT COUNT(*) INTO v_posted_op_dups
          FROM (
            SELECT property_id, operation_key
              FROM pos_goods_receipts
             WHERE operation_key IS NOT NULL
             GROUP BY property_id, operation_key
            HAVING COUNT(*) > 1
          ) d;

        IF v_posted_op_dups = 0 THEN
          CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_goods_receipts_prop_op_key
            ON pos_goods_receipts(property_id, operation_key)
            WHERE operation_key IS NOT NULL;
        END IF;

        SELECT COUNT(*) INTO v_posted_idem_dups
          FROM (
            SELECT property_id, idempotency_key
              FROM pos_goods_receipts
             WHERE idempotency_key IS NOT NULL
             GROUP BY property_id, idempotency_key
            HAVING COUNT(*) > 1
          ) d;

        IF v_posted_idem_dups = 0 THEN
          CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_goods_receipts_prop_idem_key
            ON pos_goods_receipts(property_id, idempotency_key)
            WHERE idempotency_key IS NOT NULL;
        END IF;
      END $$;
    `,
  },
  {
    id: '04_backfill_missing_purchase_line_bindings',
    description: 'Backfill and reconcile stock_purchase_line_bindings using canonical line_type and actual historical posted received_quantity',
    sql: `
      -- 1. Backfill gri.source_allocated_qty on historical posted GRN items where NULL
      WITH gri_calc AS (
        SELECT
          gri.id,
          ROUND(
            CASE
              WHEN tl.packaging_id IS NOT NULL AND src_pkg.to_base_factor IS NOT NULL AND src_pkg.to_base_factor > 0 THEN
                COALESCE(gri.base_quantity, gri.received_qty * COALESCE(grn_pkg.to_base_factor, 1)) / src_pkg.to_base_factor
              ELSE
                COALESCE(gri.base_quantity, gri.received_qty)
            END,
            4
          ) AS calc_alloc_qty
        FROM pos_goods_receipt_items gri
        JOIN transaction_lines tl ON tl.id = gri.transaction_line_id
        LEFT JOIN product_packaging_conversions src_pkg ON src_pkg.id = tl.packaging_id
        LEFT JOIN product_packaging_conversions grn_pkg ON grn_pkg.id = gri.packaging_id
        WHERE gri.source_allocated_qty IS NULL
      )
      UPDATE pos_goods_receipt_items gri
         SET source_allocated_qty = gri_calc.calc_alloc_qty
        FROM gri_calc
       WHERE gri.id = gri_calc.id;

      -- 2. Insert missing stock_purchase_line_bindings with historical received_quantity calculated from posted GRNs
      WITH hist_grn_alloc AS (
        SELECT
          gri.transaction_line_id,
          SUM(
            COALESCE(
              gri.source_allocated_qty,
              CASE
                WHEN tl.packaging_id IS NOT NULL AND src_pkg.to_base_factor IS NOT NULL AND src_pkg.to_base_factor > 0 THEN
                  COALESCE(gri.base_quantity, gri.received_qty * COALESCE(grn_pkg.to_base_factor, 1)) / src_pkg.to_base_factor
                ELSE
                  COALESCE(gri.base_quantity, gri.received_qty)
              END
            )
          ) AS total_received_in_source_unit
        FROM pos_goods_receipt_items gri
        JOIN pos_goods_receipts gr ON gr.id = gri.receipt_id
        JOIN transaction_lines tl ON tl.id = gri.transaction_line_id
        LEFT JOIN product_packaging_conversions src_pkg ON src_pkg.id = tl.packaging_id
        LEFT JOIN product_packaging_conversions grn_pkg ON grn_pkg.id = gri.packaging_id
        WHERE gr.status IN ('POSTED', 'COMPLETED')
          AND gri.transaction_line_id IS NOT NULL
        GROUP BY gri.transaction_line_id
      ),
      inserted_bindings AS (
        INSERT INTO stock_purchase_line_bindings (
          property_id,
          transaction_id,
          transaction_line_id,
          line_type,
          product_id,
          packaging_id,
          ordered_quantity,
          received_quantity,
          base_unit_code
        )
        SELECT
          t.property_id,
          t.id AS transaction_id,
          tl.id AS transaction_line_id,
          CASE
            WHEN UPPER(COALESCE(tl.line_type, '')) IN ('SERVICE') THEN 'SERVICE'
            WHEN UPPER(COALESCE(tl.line_type, '')) IN ('NON_STOCK', 'NON_STOCK_EXPENSE', 'NON_STOCK_PHYSICAL') THEN 'NON_STOCK_PHYSICAL'
            ELSE 'STOCK'
          END AS line_type,
          tl.product_id,
          tl.packaging_id,
          GREATEST(0, COALESCE(tl.quantity, 0)) AS ordered_quantity,
          ROUND(COALESCE(hga.total_received_in_source_unit, 0), 4) AS received_quantity,
          COALESCE(NULLIF(TRIM(tl.unit), ''), pmi.canonical_base_unit_code, pmi.base_unit, 'PCS') AS base_unit_code
        FROM transaction_lines tl
        JOIN transactions t ON t.id = tl.transaction_id
        LEFT JOIN pos_menu_items pmi ON pmi.id = tl.product_id AND pmi.property_id = t.property_id
        LEFT JOIN hist_grn_alloc hga ON hga.transaction_line_id = tl.id
        WHERE t.transaction_type = 'PURCHASE'
          AND tl.product_id IS NOT NULL
          AND UPPER(COALESCE(tl.line_type, 'STOCK')) NOT IN ('NON_STOCK', 'NON_STOCK_EXPENSE', 'NON_STOCK_PHYSICAL', 'SERVICE')
          AND NOT EXISTS (
            SELECT 1
              FROM stock_purchase_line_bindings b
             WHERE b.property_id = t.property_id
               AND b.transaction_id = t.id
               AND b.transaction_line_id = tl.id
          )
        ON CONFLICT (property_id, transaction_id, transaction_line_id) DO NOTHING
        RETURNING id, property_id, transaction_id, transaction_line_id, received_quantity
      )
      INSERT INTO stock_migration_reconciliation_audit (
        migration_version, issue_type, severity, property_id, entity_table, entity_id, reference_key, resolution_action, details
      )
      SELECT
        'pos_purchase_receipt_draft_post_v2',
        'MISSING_BINDING_BACKFILLED',
        'INFO',
        ib.property_id,
        'stock_purchase_line_bindings',
        ib.id,
        'tx_line:' || ib.transaction_line_id::text,
        'BACKFILLED_WITH_HISTORICAL_RECEIVED_QTY',
        jsonb_build_object(
          'transaction_id', ib.transaction_id,
          'transaction_line_id', ib.transaction_line_id,
          'received_quantity', ib.received_quantity
        )
      FROM inserted_bindings ib;

      -- 3. Reconcile existing bindings where received_quantity is lagging behind historical posted GRNs
      WITH hist_grn_alloc AS (
        SELECT
          gri.transaction_line_id,
          ROUND(
            SUM(
              COALESCE(
                gri.source_allocated_qty,
                CASE
                  WHEN tl.packaging_id IS NOT NULL AND src_pkg.to_base_factor IS NOT NULL AND src_pkg.to_base_factor > 0 THEN
                    COALESCE(gri.base_quantity, gri.received_qty * COALESCE(grn_pkg.to_base_factor, 1)) / src_pkg.to_base_factor
                  ELSE
                    COALESCE(gri.base_quantity, gri.received_qty)
                END
              )
            ),
            4
          ) AS total_received_in_source_unit
        FROM pos_goods_receipt_items gri
        JOIN pos_goods_receipts gr ON gr.id = gri.receipt_id
        JOIN transaction_lines tl ON tl.id = gri.transaction_line_id
        LEFT JOIN product_packaging_conversions src_pkg ON src_pkg.id = tl.packaging_id
        LEFT JOIN product_packaging_conversions grn_pkg ON grn_pkg.id = gri.packaging_id
        WHERE gr.status IN ('POSTED', 'COMPLETED')
          AND gri.transaction_line_id IS NOT NULL
        GROUP BY gri.transaction_line_id
      ),
      reconciled_bindings AS (
        UPDATE stock_purchase_line_bindings b
           SET received_quantity = hga.total_received_in_source_unit,
               updated_at = NOW()
          FROM hist_grn_alloc hga
         WHERE b.transaction_line_id = hga.transaction_line_id
           AND b.received_quantity < hga.total_received_in_source_unit
        RETURNING b.id, b.property_id, b.transaction_id, b.transaction_line_id, b.received_quantity
      )
      INSERT INTO stock_migration_reconciliation_audit (
        migration_version, issue_type, severity, property_id, entity_table, entity_id, reference_key, resolution_action, details
      )
      SELECT
        'pos_purchase_receipt_draft_post_v2',
        'BINDING_RECEIVED_QTY_RECONCILED',
        'INFO',
        rb.property_id,
        'stock_purchase_line_bindings',
        rb.id,
        'tx_line:' || rb.transaction_line_id::text,
        'RECONCILED_FROM_POSTED_GRN',
        jsonb_build_object(
          'transaction_id', rb.transaction_id,
          'transaction_line_id', rb.transaction_line_id,
          'reconciled_received_quantity', rb.received_quantity
        )
      FROM reconciled_bindings rb;
    `,
  },
  {
    id: '05_record_schema_migrations_version',
    description: 'Record pos_purchase_receipt_draft_post_v2 in schema_migrations table',
    sql: `
      INSERT INTO schema_migrations (version, applied_at)
      VALUES ('pos_purchase_receipt_draft_post_v2', NOW())
      ON CONFLICT (version) DO NOTHING;
    `,
  },
];

export async function runPosPurchaseReceiptDraftPostV2Migration(
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

  for (const step of POS_PURCHASE_RECEIPT_DRAFT_POST_V2_STEPS) {
    await clientOrPool.query(step.sql);
    applied.push(step.id);
  }

  return { applied, skipped };
}

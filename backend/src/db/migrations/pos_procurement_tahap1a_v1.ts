import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';

if (require.main === module) {
  dotenv.config();
}

export const MIGRATION_VERSION = 'pos_procurement_tahap1a_v1';

export type MigrationStep = {
  id: string;
  description: string;
  sql: string;
};

export const POS_PROCUREMENT_TAHAP1A_V1_STEPS: MigrationStep[] = [
  {
    id: '01_canonical_supplier_mapping_schema_and_migration',
    description: 'Create pos_supplier_canonical_mappings, map pos_suppliers to canonical suppliers per property with ambiguity quarantine, and point pos_purchase_orders/pos_goods_receipts to canonical suppliers',
    sql: `
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

      CREATE TABLE IF NOT EXISTS pos_supplier_canonical_mappings (
        id SERIAL PRIMARY KEY,
        property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
        pos_supplier_id INTEGER NOT NULL REFERENCES pos_suppliers(id) ON DELETE CASCADE,
        canonical_supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
        mapping_method VARCHAR(50) NOT NULL,
        mapping_status VARCHAR(40) NOT NULL DEFAULT 'MAPPED',
        reconciliation_status VARCHAR(40) NOT NULL DEFAULT 'MAPPED',
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_pos_supplier_canonical_mappings_prop_pos UNIQUE (property_id, pos_supplier_id)
      );

      ALTER TABLE pos_supplier_canonical_mappings
        ADD COLUMN IF NOT EXISTS mapping_status VARCHAR(40) NOT NULL DEFAULT 'MAPPED',
        ADD COLUMN IF NOT EXISTS reconciliation_status VARCHAR(40) NOT NULL DEFAULT 'MAPPED';

      CREATE INDEX IF NOT EXISTS idx_pos_supplier_canonical_map_prop_canon
        ON pos_supplier_canonical_mappings(property_id, canonical_supplier_id);

      ALTER TABLE suppliers
        ADD COLUMN IF NOT EXISTS partner_type VARCHAR(20) DEFAULT 'SUPPLIER',
        ADD COLUMN IF NOT EXISTS payment_terms VARCHAR(100);

      UPDATE suppliers
         SET partner_type = COALESCE(partner_type, entity_type, 'SUPPLIER')
       WHERE partner_type IS NULL;

      ALTER TABLE pos_suppliers
        ADD COLUMN IF NOT EXISTS canonical_supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS contact_name VARCHAR(100),
        ADD COLUMN IF NOT EXISTS payment_terms VARCHAR(100),
        ADD COLUMN IF NOT EXISTS notes TEXT;

      UPDATE pos_suppliers
         SET contact_name = COALESCE(contact_name, contact_person)
       WHERE contact_name IS NULL AND contact_person IS NOT NULL;

      ALTER TABLE pos_purchase_orders
        ADD COLUMN IF NOT EXISTS legacy_pos_supplier_id INTEGER,
        ADD COLUMN IF NOT EXISTS canonical_supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL;

      ALTER TABLE pos_goods_receipts
        ADD COLUMN IF NOT EXISTS legacy_pos_supplier_id INTEGER,
        ADD COLUMN IF NOT EXISTS canonical_supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL;

      ALTER TABLE transactions
        ADD COLUMN IF NOT EXISTS canonical_supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL;

      -- Drop legacy FKs that forced supplier_id to reference pos_suppliers(id)
      ALTER TABLE pos_purchase_orders
        DROP CONSTRAINT IF EXISTS pos_purchase_orders_supplier_id_fkey;

      ALTER TABLE pos_goods_receipts
        DROP CONSTRAINT IF EXISTS pos_goods_receipts_supplier_id_fkey;

      -- Widen supplier_id on pos_purchase_orders and pos_goods_receipts to BIGINT to match canonical suppliers.id
      ALTER TABLE pos_purchase_orders
        ALTER COLUMN supplier_id TYPE BIGINT;

      ALTER TABLE pos_goods_receipts
        ALTER COLUMN supplier_id TYPE BIGINT;

      -- Deterministic per-property reconciliation of pos_suppliers -> canonical suppliers
      DO $$
      DECLARE
        rec RECORD;
        v_name_match_count INTEGER;
        v_pos_dup_name_count INTEGER;
        v_code_match_count INTEGER;
        v_matched_id BIGINT;
        v_code_matched_id BIGINT;
        v_new_code VARCHAR(50);
        v_new_supplier_id BIGINT;
      BEGIN
        FOR rec IN
          SELECT ps.*
            FROM pos_suppliers ps
            LEFT JOIN pos_supplier_canonical_mappings m
              ON m.property_id = ps.property_id AND m.pos_supplier_id = ps.id
           WHERE m.id IS NULL
           ORDER BY ps.property_id ASC, ps.id ASC
        LOOP
          SELECT COUNT(*)
            INTO v_pos_dup_name_count
            FROM pos_suppliers ps2
           WHERE ps2.property_id = rec.property_id
             AND LOWER(TRIM(ps2.name)) = LOWER(TRIM(rec.name));

          SELECT COUNT(*), MIN(s.id)
            INTO v_name_match_count, v_matched_id
            FROM suppliers s
           WHERE s.property_id = rec.property_id
             AND s.deleted_at IS NULL
             AND LOWER(TRIM(s.name)) = LOWER(TRIM(rec.name));

          SELECT COUNT(*), MIN(s.id)
            INTO v_code_match_count, v_code_matched_id
            FROM suppliers s
           WHERE s.property_id = rec.property_id
             AND s.deleted_at IS NULL
             AND TRIM(COALESCE(rec.code, '')) <> ''
             AND UPPER(TRIM(COALESCE(s.code, ''))) = UPPER(TRIM(rec.code));

          IF v_name_match_count > 1 OR v_pos_dup_name_count > 1 THEN
            -- Ambiguous: multiple suppliers share the same normalized name in this property
            INSERT INTO pos_supplier_canonical_mappings (
              property_id, pos_supplier_id, canonical_supplier_id, mapping_method, mapping_status, reconciliation_status, notes
            ) VALUES (
              rec.property_id, rec.id, NULL, 'AMBIGUOUS_NAME_MULTIPLE', 'QUARANTINED_AMBIGUOUS', 'QUARANTINED_AMBIGUOUS',
              'Multiple suppliers matched normalized name: ' || rec.name
            ) ON CONFLICT (property_id, pos_supplier_id) DO NOTHING;

            INSERT INTO stock_migration_reconciliation_audit (
              migration_version, issue_type, severity, property_id, entity_table, entity_id, reference_key, resolution_action, details
            ) VALUES (
              'pos_procurement_tahap1a_v1',
              'AMBIGUOUS_SUPPLIER_MAPPING',
              'NEEDS_MANUAL_REVIEW',
              rec.property_id,
              'pos_suppliers',
              rec.id,
              rec.code,
              'QUARANTINED_NEEDS_REVIEW',
              jsonb_build_object(
                'pos_supplier_id', rec.id,
                'pos_supplier_code', rec.code,
                'pos_supplier_name', rec.name,
                'reason', 'MULTIPLE_SUPPLIER_NAME_MATCHES',
                'canonical_match_count', v_name_match_count,
                'pos_duplicate_name_count', v_pos_dup_name_count
              )
            );

          ELSIF v_name_match_count = 1 THEN
            IF v_code_match_count > 0 AND v_code_matched_id IS DISTINCT FROM v_matched_id THEN
              -- Ambiguous: name matches one canonical supplier, but code matches a different canonical supplier
              INSERT INTO pos_supplier_canonical_mappings (
                property_id, pos_supplier_id, canonical_supplier_id, mapping_method, mapping_status, reconciliation_status, notes
              ) VALUES (
                rec.property_id, rec.id, NULL, 'AMBIGUOUS_CODE_NAME_CONFLICT', 'QUARANTINED_AMBIGUOUS', 'QUARANTINED_AMBIGUOUS',
                'Name matched canonical supplier ' || v_matched_id::text || ' but code matched canonical supplier ' || v_code_matched_id::text
              ) ON CONFLICT (property_id, pos_supplier_id) DO NOTHING;

              INSERT INTO stock_migration_reconciliation_audit (
                migration_version, issue_type, severity, property_id, entity_table, entity_id, reference_key, resolution_action, details
              ) VALUES (
                'pos_procurement_tahap1a_v1',
                'AMBIGUOUS_SUPPLIER_MAPPING',
                'NEEDS_MANUAL_REVIEW',
                rec.property_id,
                'pos_suppliers',
                rec.id,
                rec.code,
                'QUARANTINED_NEEDS_REVIEW',
                jsonb_build_object(
                  'pos_supplier_id', rec.id,
                  'pos_supplier_code', rec.code,
                  'pos_supplier_name', rec.name,
                  'reason', 'CODE_AND_NAME_MATCH_DIFFERENT_SUPPLIERS',
                  'name_matched_supplier_id', v_matched_id,
                  'code_matched_supplier_id', v_code_matched_id
                )
              );
            ELSIF (v_code_match_count = 1 AND v_code_matched_id = v_matched_id)
               OR (rec.canonical_supplier_id IS NOT NULL AND rec.canonical_supplier_id = v_matched_id) THEN
              -- Exact single unambiguous match confirmed by both name and code (or explicit prior canonical_supplier_id)
              UPDATE pos_suppliers
                 SET canonical_supplier_id = v_matched_id
               WHERE id = rec.id;

              INSERT INTO pos_supplier_canonical_mappings (
                property_id, pos_supplier_id, canonical_supplier_id, mapping_method, mapping_status, reconciliation_status, notes
              ) VALUES (
                rec.property_id, rec.id, v_matched_id, 'EXACT_SINGLE_MATCH', 'MAPPED', 'MAPPED',
                'Mapped deterministically to single matching canonical supplier confirmed by name and code'
              ) ON CONFLICT (property_id, pos_supplier_id) DO NOTHING;
            ELSE
              -- Name matched a canonical supplier, but code is missing or does not match -> quarantine instead of auto-merging on name alone
              INSERT INTO pos_supplier_canonical_mappings (
                property_id, pos_supplier_id, canonical_supplier_id, mapping_method, mapping_status, reconciliation_status, notes
              ) VALUES (
                rec.property_id, rec.id, NULL, 'AMBIGUOUS_NAME_ONLY_UNVERIFIED', 'QUARANTINED_AMBIGUOUS', 'QUARANTINED_NAME_ONLY',
                'Name matched canonical supplier ' || v_matched_id::text || ' without matching supplier code confirmation; quarantined for review'
              ) ON CONFLICT (property_id, pos_supplier_id) DO NOTHING;

              INSERT INTO stock_migration_reconciliation_audit (
                migration_version, issue_type, severity, property_id, entity_table, entity_id, reference_key, resolution_action, details
              ) VALUES (
                'pos_procurement_tahap1a_v1',
                'AMBIGUOUS_SUPPLIER_NAME_ONLY',
                'NEEDS_MANUAL_REVIEW',
                rec.property_id,
                'pos_suppliers',
                rec.id,
                rec.code,
                'QUARANTINED_NEEDS_REVIEW',
                jsonb_build_object(
                  'pos_supplier_id', rec.id,
                  'pos_supplier_code', rec.code,
                  'pos_supplier_name', rec.name,
                  'reason', 'NAME_ONLY_MATCH_WITHOUT_CODE_CONFIRMATION',
                  'name_matched_supplier_id', v_matched_id
                )
              );
            END IF;

          ELSE
            -- v_name_match_count = 0
            IF v_code_match_count > 0 THEN
              -- Code exists in canonical suppliers under a different company name -> quarantine as ambiguous code collision
              INSERT INTO pos_supplier_canonical_mappings (
                property_id, pos_supplier_id, canonical_supplier_id, mapping_method, mapping_status, reconciliation_status, notes
              ) VALUES (
                rec.property_id, rec.id, NULL, 'AMBIGUOUS_CODE_COLLISION', 'QUARANTINED_AMBIGUOUS', 'QUARANTINED_AMBIGUOUS',
                'Code ' || rec.code || ' already belongs to canonical supplier ' || v_code_matched_id::text || ' with a different name'
              ) ON CONFLICT (property_id, pos_supplier_id) DO NOTHING;

              INSERT INTO stock_migration_reconciliation_audit (
                migration_version, issue_type, severity, property_id, entity_table, entity_id, reference_key, resolution_action, details
              ) VALUES (
                'pos_procurement_tahap1a_v1',
                'AMBIGUOUS_SUPPLIER_CODE_COLLISION',
                'NEEDS_MANUAL_REVIEW',
                rec.property_id,
                'pos_suppliers',
                rec.id,
                rec.code,
                'QUARANTINED_NEEDS_REVIEW',
                jsonb_build_object(
                  'pos_supplier_id', rec.id,
                  'pos_supplier_code', rec.code,
                  'pos_supplier_name', rec.name,
                  'reason', 'CODE_COLLISION_WITH_DIFFERENT_NAME',
                  'code_matched_supplier_id', v_code_matched_id
                )
              );
            ELSE
              -- No match in canonical suppliers -> create canonical supplier row preserving all attributes
              v_new_code := UPPER(TRIM(COALESCE(rec.code, '')));
              IF v_new_code = '' THEN
                v_new_code := 'POS-SUP-' || rec.id::text;
              END IF;

              INSERT INTO suppliers (
                property_id, code, name, legal_name, entity_type, partner_type, category, contact_person,
                phone, email, address, status, is_active, notes, created_by, updated_by, created_at, updated_at
              ) VALUES (
                rec.property_id,
                v_new_code,
                TRIM(rec.name),
                NULL,
                'SUPPLIER',
                'SUPPLIER',
                'Inventory POS',
                COALESCE(rec.contact_person, rec.contact_name),
                rec.phone,
                rec.email,
                rec.address,
                CASE WHEN rec.is_active THEN 'ACTIVE' ELSE 'INACTIVE' END,
                rec.is_active,
                COALESCE(rec.notes, 'Dimigrasikan dari pos_suppliers #' || rec.id::text),
                'SYSTEM_MIGRATION',
                'SYSTEM_MIGRATION',
                rec.created_at,
                NOW()
              ) RETURNING id INTO v_new_supplier_id;

              UPDATE pos_suppliers
                 SET canonical_supplier_id = v_new_supplier_id
               WHERE id = rec.id;

              INSERT INTO pos_supplier_canonical_mappings (
                property_id, pos_supplier_id, canonical_supplier_id, mapping_method, mapping_status, reconciliation_status, notes
              ) VALUES (
                rec.property_id, rec.id, v_new_supplier_id, 'CREATED_CANONICAL_SUPPLIER', 'MAPPED', 'MAPPED',
                'Created canonical supplier from legacy pos_suppliers record'
              ) ON CONFLICT (property_id, pos_supplier_id) DO NOTHING;
            END IF;
          END IF;
        END LOOP;
      END $$;

      -- Backfill legacy_pos_supplier_id and update supplier_id on pos_purchase_orders where mapped
      UPDATE pos_purchase_orders po
         SET legacy_pos_supplier_id = po.supplier_id::integer,
             supplier_id = m.canonical_supplier_id,
             canonical_supplier_id = m.canonical_supplier_id,
             updated_at = NOW()
        FROM pos_supplier_canonical_mappings m
       WHERE po.property_id = m.property_id
         AND po.supplier_id = m.pos_supplier_id
         AND po.canonical_supplier_id IS NULL
         AND po.legacy_pos_supplier_id IS NULL
         AND m.canonical_supplier_id IS NOT NULL;

      -- Preserve legacy_pos_supplier_id even when quarantined (without overwriting supplier_id or linking canonical_supplier_id)
      UPDATE pos_purchase_orders po
         SET legacy_pos_supplier_id = po.supplier_id::integer,
             canonical_supplier_id = NULL
        FROM pos_supplier_canonical_mappings m
       WHERE po.property_id = m.property_id
         AND po.supplier_id = m.pos_supplier_id
         AND po.canonical_supplier_id IS NULL
         AND po.legacy_pos_supplier_id IS NULL
         AND m.canonical_supplier_id IS NULL;

      -- Backfill legacy_pos_supplier_id and update supplier_id on pos_goods_receipts where mapped
      UPDATE pos_goods_receipts gr
         SET legacy_pos_supplier_id = gr.supplier_id::integer,
             supplier_id = m.canonical_supplier_id,
             canonical_supplier_id = m.canonical_supplier_id,
             updated_at = NOW()
        FROM pos_supplier_canonical_mappings m
       WHERE gr.property_id = m.property_id
         AND gr.supplier_id = m.pos_supplier_id
         AND gr.canonical_supplier_id IS NULL
         AND gr.legacy_pos_supplier_id IS NULL
         AND m.canonical_supplier_id IS NOT NULL;

      UPDATE transactions t
         SET canonical_supplier_id = t.supplier_id
        FROM suppliers s
       WHERE t.property_id = s.property_id
         AND t.supplier_id = s.id
         AND t.canonical_supplier_id IS NULL;

      UPDATE pos_goods_receipts gr
         SET legacy_pos_supplier_id = gr.supplier_id::integer,
             canonical_supplier_id = NULL
        FROM pos_supplier_canonical_mappings m
       WHERE gr.property_id = m.property_id
         AND gr.supplier_id = m.pos_supplier_id
         AND gr.canonical_supplier_id IS NULL
         AND gr.legacy_pos_supplier_id IS NULL
         AND m.canonical_supplier_id IS NULL;
    `,
  },
  {
    id: '02_expand_pos_purchase_orders_and_items_for_tahap1a',
    description: 'Expand pos_purchase_orders with approval/workflow/archive columns and allow multi-line same-SKU with different packaging on pos_purchase_order_items',
    sql: `
      ALTER TABLE pos_purchase_orders
        DROP CONSTRAINT IF EXISTS chk_pos_purchase_orders_status;

      ALTER TABLE pos_purchase_orders
        ADD CONSTRAINT chk_pos_purchase_orders_status
        CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'ORDERED', 'PARTIALLY_RECEIVED', 'COMPLETED', 'CANCELLED'));

      ALTER TABLE pos_purchase_orders
        ADD COLUMN IF NOT EXISTS destination_location_id INTEGER REFERENCES stock_locations(id),
        ADD COLUMN IF NOT EXISTS subtotal_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS total_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS approved_by VARCHAR(100),
        ADD COLUMN IF NOT EXISTS approval_status VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
        ADD COLUMN IF NOT EXISTS submitted_by_user_id VARCHAR(100),
        ADD COLUMN IF NOT EXISTS submitted_by_name_snapshot VARCHAR(150),
        ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS approved_by_user_id VARCHAR(100),
        ADD COLUMN IF NOT EXISTS approved_by_name_snapshot VARCHAR(150),
        ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
        ADD COLUMN IF NOT EXISTS source_revision INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS receiving_status VARCHAR(30) NOT NULL DEFAULT 'BELUM_DITERIMA',
        ADD COLUMN IF NOT EXISTS category_code VARCHAR(80),
        ADD COLUMN IF NOT EXISTS category_name VARCHAR(150),
        ADD COLUMN IF NOT EXISTS department_code VARCHAR(50),
        ADD COLUMN IF NOT EXISTS purchase_category_id BIGINT,
        ADD COLUMN IF NOT EXISTS department_id BIGINT,
        ADD COLUMN IF NOT EXISTS department_name_snapshot VARCHAR(150),
        ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS archived_by_user_id VARCHAR(100),
        ADD COLUMN IF NOT EXISTS archived_by_name_snapshot VARCHAR(150),
        ADD COLUMN IF NOT EXISTS archive_reason TEXT;

      UPDATE pos_purchase_orders
         SET total_amount = COALESCE(NULLIF(total_amount, 0), total_estimated_amount, 0),
             subtotal_amount = COALESCE(NULLIF(subtotal_amount, 0), total_estimated_amount, 0)
       WHERE total_amount = 0 AND COALESCE(total_estimated_amount, 0) > 0;

      UPDATE pos_purchase_orders
         SET approval_status = CASE
               WHEN status IN ('APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED', 'COMPLETED') THEN 'APPROVED'
               WHEN status = 'PENDING_APPROVAL' THEN 'PENDING_APPROVAL'
               WHEN status = 'REJECTED' THEN 'REJECTED'
               ELSE 'DRAFT'
             END,
             receiving_status = CASE
               WHEN status = 'COMPLETED' THEN 'DITERIMA_LENGKAP'
               WHEN status = 'PARTIALLY_RECEIVED' THEN 'DITERIMA_SEBAGIAN'
               ELSE 'BELUM_DITERIMA'
             END
       WHERE approval_status = 'DRAFT' AND status <> 'DRAFT';

      CREATE INDEX IF NOT EXISTS idx_pos_purchase_orders_approval
        ON pos_purchase_orders(property_id, approval_status);

      -- Allow multiple lines of the same SKU with different packaging/units in a single PO
      ALTER TABLE pos_purchase_order_items
        DROP CONSTRAINT IF EXISTS uq_pos_purchase_order_items_po_prod;

      DROP INDEX IF EXISTS uq_pos_purchase_order_items_po_prod;

      ALTER TABLE pos_purchase_order_items
        ADD COLUMN IF NOT EXISTS property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE,
        ADD COLUMN IF NOT EXISTS packaging_id INTEGER REFERENCES product_packaging_conversions(id),
        ADD COLUMN IF NOT EXISTS packaging_label_snapshot VARCHAR(100),
        ADD COLUMN IF NOT EXISTS conversion_factor_snapshot NUMERIC(12,4),
        ADD COLUMN IF NOT EXISTS base_unit VARCHAR(40) NOT NULL DEFAULT 'PCS',
        ADD COLUMN IF NOT EXISTS base_unit_code VARCHAR(32),
        ADD COLUMN IF NOT EXISTS ordered_unit VARCHAR(32),
        ADD COLUMN IF NOT EXISTS line_type VARCHAR(32) NOT NULL DEFAULT 'STOCK',
        ADD COLUMN IF NOT EXISTS description_snapshot TEXT,
        ADD COLUMN IF NOT EXISTS discount_amount BIGINT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS line_total NUMERIC(14,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS destination_location_id INTEGER REFERENCES stock_locations(id),
        ADD COLUMN IF NOT EXISTS notes TEXT,
        ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

      UPDATE pos_purchase_order_items poi
         SET property_id = po.property_id
        FROM pos_purchase_orders po
       WHERE poi.po_id = po.id
         AND poi.property_id IS NULL;

      UPDATE pos_purchase_order_items poi
         SET base_unit = COALESCE(NULLIF(poi.base_unit, ''), pmi.base_unit, 'PCS'),
             base_unit_code = COALESCE(poi.base_unit_code, pmi.base_unit, 'PCS'),
             ordered_unit = COALESCE(
               poi.ordered_unit,
               (SELECT pkg.packaging_code FROM product_packaging_conversions pkg WHERE pkg.id = poi.packaging_id),
               pmi.base_unit,
               'PCS'
             ),
             conversion_factor_snapshot = CASE
               WHEN poi.conversion_factor_snapshot IS NOT NULL AND poi.conversion_factor_snapshot > 0
                 THEN poi.conversion_factor_snapshot
               ELSE COALESCE(
                 (SELECT pkg.to_base_factor FROM product_packaging_conversions pkg WHERE pkg.id = poi.packaging_id),
                 1
               )
             END,
             description_snapshot = COALESCE(poi.description_snapshot, pmi.name),
             line_total = CASE
               WHEN COALESCE(poi.line_total, 0) > 0 THEN poi.line_total
               ELSE GREATEST(0, (COALESCE(poi.ordered_qty, 0) * COALESCE(poi.unit_cost, 0)) - COALESCE(poi.discount_amount, 0))
             END
        FROM pos_menu_items pmi
       WHERE poi.product_id = pmi.id;

      UPDATE pos_purchase_order_items
         SET conversion_factor_snapshot = 1
       WHERE conversion_factor_snapshot IS NULL OR conversion_factor_snapshot <= 0;

      ALTER TABLE pos_purchase_order_items
        ALTER COLUMN conversion_factor_snapshot SET DEFAULT 1,
        ALTER COLUMN conversion_factor_snapshot SET NOT NULL;

      -- Ensure pos_goods_receipts and pos_goods_receipt_items have all required columns
      ALTER TABLE pos_goods_receipts
        ADD COLUMN IF NOT EXISTS total_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS created_by VARCHAR(100);

      ALTER TABLE pos_goods_receipt_items
        ADD COLUMN IF NOT EXISTS property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE,
        ADD COLUMN IF NOT EXISTS transaction_line_id BIGINT,
        ADD COLUMN IF NOT EXISTS packaging_id INTEGER REFERENCES product_packaging_conversions(id),
        ADD COLUMN IF NOT EXISTS packaging_label_snapshot VARCHAR(100),
        ADD COLUMN IF NOT EXISTS ordered_unit VARCHAR(40),
        ADD COLUMN IF NOT EXISTS base_unit VARCHAR(40) NOT NULL DEFAULT 'PCS',
        ADD COLUMN IF NOT EXISTS base_quantity NUMERIC(14,4) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS source_allocated_qty NUMERIC(14,4),
        ADD COLUMN IF NOT EXISTS conversion_factor_snapshot NUMERIC(12,4) NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS line_total NUMERIC(14,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS uom_id INTEGER,
        ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES stock_locations(id),
        ADD COLUMN IF NOT EXISTS notes TEXT,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

      UPDATE pos_goods_receipt_items gri
         SET property_id = gr.property_id
        FROM pos_goods_receipts gr
       WHERE gri.receipt_id = gr.id
         AND gri.property_id IS NULL;
    `,
  },
  {
    id: '03_link_transactions_and_bindings_to_po',
    description: 'Add po_id, is_legacy_without_po, variance and archive metadata to transactions, and po_item_id to transaction_lines and stock_purchase_line_bindings',
    sql: `
      ALTER TABLE transactions
        ADD COLUMN IF NOT EXISTS po_id INTEGER REFERENCES pos_purchase_orders(id),
        ADD COLUMN IF NOT EXISTS is_legacy_without_po BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS has_po_variance BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS po_variance_summary JSONB,
        ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS archived_by_user_id VARCHAR(100),
        ADD COLUMN IF NOT EXISTS archived_by_name_snapshot VARCHAR(150),
        ADD COLUMN IF NOT EXISTS archive_reason TEXT;

      ALTER TABLE transaction_lines
        ADD COLUMN IF NOT EXISTS po_item_id INTEGER REFERENCES pos_purchase_order_items(id),
        ADD COLUMN IF NOT EXISTS packaging_label_snapshot VARCHAR(100),
        ADD COLUMN IF NOT EXISTS conversion_factor_snapshot NUMERIC(12,4);

      ALTER TABLE stock_purchase_line_bindings
        ADD COLUMN IF NOT EXISTS po_item_id INTEGER REFERENCES pos_purchase_order_items(id),
        ADD COLUMN IF NOT EXISTS packaging_label_snapshot VARCHAR(100),
        ADD COLUMN IF NOT EXISTS conversion_factor_snapshot NUMERIC(12,4);

      -- Backfill base-unit lines (packaging_id IS NULL -> factor 1)
      UPDATE transaction_lines tl
         SET conversion_factor_snapshot = 1,
             packaging_label_snapshot = COALESCE(tl.packaging_label_snapshot, tl.unit)
       WHERE tl.packaging_id IS NULL
         AND (tl.conversion_factor_snapshot IS NULL OR tl.conversion_factor_snapshot <= 0);

      UPDATE stock_purchase_line_bindings b
         SET conversion_factor_snapshot = 1,
             packaging_label_snapshot = COALESCE(b.packaging_label_snapshot, tl.unit)
        FROM transaction_lines tl
       WHERE tl.id = b.transaction_line_id
         AND b.packaging_id IS NULL
         AND (b.conversion_factor_snapshot IS NULL OR b.conversion_factor_snapshot <= 0);

      -- Backfill packaged lines from linked PO item snapshot when packaging_id matches
      UPDATE transaction_lines tl
         SET conversion_factor_snapshot = poi.conversion_factor_snapshot,
             packaging_label_snapshot = COALESCE(tl.packaging_label_snapshot, poi.packaging_label_snapshot, tl.unit)
        FROM pos_purchase_order_items poi
       WHERE tl.po_item_id = poi.id
         AND tl.packaging_id IS NOT NULL
         AND poi.packaging_id = tl.packaging_id
         AND COALESCE(poi.conversion_factor_snapshot, 0) > 0
         AND (tl.conversion_factor_snapshot IS NULL OR tl.conversion_factor_snapshot <= 0);

      -- Backfill packaged lines from verified binding snapshot when packaging_id matches and not flagged in audit
      UPDATE transaction_lines tl
         SET conversion_factor_snapshot = b.conversion_factor_snapshot,
             packaging_label_snapshot = COALESCE(tl.packaging_label_snapshot, b.packaging_label_snapshot, tl.unit)
        FROM stock_purchase_line_bindings b
       WHERE b.transaction_line_id = tl.id
         AND tl.packaging_id IS NOT NULL
         AND b.packaging_id = tl.packaging_id
         AND COALESCE(b.conversion_factor_snapshot, 0) > 0
         AND (tl.conversion_factor_snapshot IS NULL OR tl.conversion_factor_snapshot <= 0)
         AND NOT EXISTS (
           SELECT 1
             FROM stock_migration_reconciliation_audit a
            WHERE a.migration_version = 'pos_procurement_tahap1a_v1'
              AND a.issue_type IN ('AMBIGUOUS_PACKAGING_SNAPSHOT_BACKFILL', 'UNVERIFIED_PACKAGING_SNAPSHOT_BACKFILL')
              AND a.entity_table = 'transaction_lines'
              AND a.entity_id = tl.id
         );

      -- Backfill packaged lines from unambiguous POSTED/COMPLETED GRN item snapshot when packaging_id matches
      WITH grn_pkg_snap AS (
        SELECT gri.transaction_line_id,
               gri.packaging_id,
               MIN(gri.conversion_factor_snapshot) AS min_factor,
               MAX(gri.conversion_factor_snapshot) AS max_factor,
               MAX(gri.packaging_label_snapshot) AS pkg_label
          FROM pos_goods_receipt_items gri
          JOIN pos_goods_receipts gr ON gr.id = gri.receipt_id
         WHERE gri.transaction_line_id IS NOT NULL
           AND gri.packaging_id IS NOT NULL
           AND COALESCE(gri.conversion_factor_snapshot, 0) > 0
           AND UPPER(COALESCE(gr.status, 'POSTED')) IN ('POSTED', 'COMPLETED')
         GROUP BY gri.transaction_line_id, gri.packaging_id
      )
      UPDATE transaction_lines tl
         SET conversion_factor_snapshot = gs.min_factor,
             packaging_label_snapshot = COALESCE(tl.packaging_label_snapshot, gs.pkg_label, tl.unit)
        FROM grn_pkg_snap gs
       WHERE gs.transaction_line_id = tl.id
         AND gs.packaging_id = tl.packaging_id
         AND gs.min_factor = gs.max_factor
         AND (tl.conversion_factor_snapshot IS NULL OR tl.conversion_factor_snapshot <= 0);

      -- Clear any previously contaminated packaged snapshot that was flagged as ambiguous/unverified or overwritten by master factor
      UPDATE transaction_lines tl
         SET conversion_factor_snapshot = NULL
       WHERE tl.packaging_id IS NOT NULL
         AND (
           EXISTS (
             SELECT 1
               FROM stock_migration_reconciliation_audit a
              WHERE a.migration_version = 'pos_procurement_tahap1a_v1'
                AND a.issue_type IN ('AMBIGUOUS_PACKAGING_SNAPSHOT_BACKFILL', 'UNVERIFIED_PACKAGING_SNAPSHOT_BACKFILL')
                AND a.entity_table = 'transaction_lines'
                AND a.entity_id = tl.id
           )
           OR (
             EXISTS (
               SELECT 1
                 FROM pos_goods_receipt_items gri
                 JOIN pos_goods_receipts gr ON gr.id = gri.receipt_id
                WHERE gri.transaction_line_id = tl.id
                  AND gri.packaging_id = tl.packaging_id
                  AND COALESCE(gri.conversion_factor_snapshot, 0) > 0
                  AND UPPER(COALESCE(gr.status, 'POSTED')) IN ('POSTED', 'COMPLETED')
                GROUP BY gri.transaction_line_id, gri.packaging_id
               HAVING MIN(gri.conversion_factor_snapshot) <> MAX(gri.conversion_factor_snapshot)
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM pos_goods_receipt_items gri2
                 JOIN pos_goods_receipts gr2 ON gr2.id = gri2.receipt_id
                WHERE gri2.transaction_line_id = tl.id
                  AND gri2.packaging_id = tl.packaging_id
                  AND UPPER(COALESCE(gr2.status, 'POSTED')) IN ('POSTED', 'COMPLETED')
                  AND gri2.conversion_factor_snapshot = tl.conversion_factor_snapshot
             )
           )
         );

      -- Audit any ambiguous or unverified packaged line where historical conversion_factor_snapshot cannot be proven
      INSERT INTO stock_migration_reconciliation_audit (
        migration_version, issue_type, severity, property_id, entity_table, entity_id, reference_key, resolution_action, details
      )
      SELECT
        'pos_procurement_tahap1a_v1',
        CASE
          WHEN gs.min_factor IS NOT NULL AND gs.min_factor <> gs.max_factor THEN 'AMBIGUOUS_PACKAGING_SNAPSHOT_BACKFILL'
          ELSE 'UNVERIFIED_PACKAGING_SNAPSHOT_BACKFILL'
        END,
        'NEEDS_MANUAL_REVIEW',
        tl.property_id,
        'transaction_lines',
        tl.id,
        tl.transaction_id::text,
        'PRESERVED_FOR_REVIEW',
        jsonb_build_object(
          'transaction_id', tl.transaction_id,
          'transaction_line_id', tl.id,
          'packaging_id', tl.packaging_id,
          'min_grn_factor', gs.min_factor,
          'max_grn_factor', gs.max_factor
        )
      FROM transaction_lines tl
      LEFT JOIN (
        SELECT gri.transaction_line_id,
               gri.packaging_id,
               MIN(gri.conversion_factor_snapshot) AS min_factor,
               MAX(gri.conversion_factor_snapshot) AS max_factor
          FROM pos_goods_receipt_items gri
          JOIN pos_goods_receipts gr ON gr.id = gri.receipt_id
         WHERE gri.transaction_line_id IS NOT NULL
           AND gri.packaging_id IS NOT NULL
           AND COALESCE(gri.conversion_factor_snapshot, 0) > 0
           AND UPPER(COALESCE(gr.status, 'POSTED')) IN ('POSTED', 'COMPLETED')
         GROUP BY gri.transaction_line_id, gri.packaging_id
      ) gs ON gs.transaction_line_id = tl.id AND gs.packaging_id = tl.packaging_id
      WHERE tl.packaging_id IS NOT NULL
        AND (tl.conversion_factor_snapshot IS NULL OR tl.conversion_factor_snapshot <= 0)
        AND NOT EXISTS (
          SELECT 1
            FROM stock_migration_reconciliation_audit a
           WHERE a.migration_version = 'pos_procurement_tahap1a_v1'
             AND a.issue_type IN ('AMBIGUOUS_PACKAGING_SNAPSHOT_BACKFILL', 'UNVERIFIED_PACKAGING_SNAPSHOT_BACKFILL')
             AND a.entity_table = 'transaction_lines'
             AND a.entity_id = tl.id
        );

      -- Synchronize packaged bindings strictly from verified transaction_lines snapshot (keep NULL if unresolved)
      UPDATE stock_purchase_line_bindings b
         SET conversion_factor_snapshot = CASE
               WHEN tl.conversion_factor_snapshot IS NOT NULL AND tl.conversion_factor_snapshot > 0 THEN tl.conversion_factor_snapshot
               ELSE NULL
             END,
             packaging_label_snapshot = COALESCE(
               b.packaging_label_snapshot,
               tl.packaging_label_snapshot,
               (SELECT ppc.packaging_label FROM product_packaging_conversions ppc WHERE ppc.id = b.packaging_id AND ppc.property_id = b.property_id),
               tl.unit
             )
        FROM transaction_lines tl
       WHERE tl.id = b.transaction_line_id
         AND b.packaging_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_transactions_po_id
        ON transactions(property_id, po_id);

      CREATE INDEX IF NOT EXISTS idx_transaction_lines_po_item_id
        ON transaction_lines(po_item_id);

      CREATE INDEX IF NOT EXISTS idx_stock_purchase_line_bindings_po_item_id
        ON stock_purchase_line_bindings(po_item_id);

      CREATE INDEX IF NOT EXISTS idx_pos_grn_items_po_item_id
        ON pos_goods_receipt_items(po_item_id);

      -- Mark pre-existing PURCHASE transactions without PO as legacy_without_po and audit them
      WITH legacy_purchases AS (
        UPDATE transactions
           SET is_legacy_without_po = TRUE
         WHERE transaction_type = 'PURCHASE'
           AND po_id IS NULL
           AND is_legacy_without_po = FALSE
         RETURNING id, property_id, transaction_no, transaction_status, approval_status, receiving_status
      )
      INSERT INTO stock_migration_reconciliation_audit (
        migration_version, issue_type, severity, property_id, entity_table, entity_id, reference_key, resolution_action, details
      )
      SELECT
        'pos_procurement_tahap1a_v1',
        'LEGACY_PURCHASE_WITHOUT_PO',
        'INFO',
        lp.property_id,
        'transactions',
        lp.id,
        lp.transaction_no,
        'PRESERVED_AS_LEGACY_WITHOUT_PO',
        jsonb_build_object(
          'transaction_no', lp.transaction_no,
          'transaction_status', lp.transaction_status,
          'approval_status', lp.approval_status,
          'receiving_status', lp.receiving_status
        )
      FROM legacy_purchases lp;
    `,
  },
  {
    id: '04_record_schema_migrations_version',
    description: 'Record pos_procurement_tahap1a_v1 in schema_migrations table',
    sql: `
      INSERT INTO schema_migrations (version, applied_at)
      VALUES
        ('pos_procurement_tahap1a_v1', NOW()),
        ('pos_procurement_tahap1a_v1_m01_snapshot_authority', NOW())
      ON CONFLICT (version) DO NOTHING;
    `,
  },
];

export async function runPosProcurementTahap1aV1Migration(
  clientOrPool: Pool | PoolClient
): Promise<{ applied: string[]; skipped: string[] }> {
  const applied: string[] = [];
  const skipped: string[] = [];

  const checkVersion = await clientOrPool.query(
    `SELECT 1 FROM schema_migrations WHERE version = $1`,
    [MIGRATION_VERSION]
  );
  if ((checkVersion.rowCount ?? 0) > 0) {
    const pendingLegacyCheck = await clientOrPool.query(`
      SELECT
        EXISTS (
          SELECT 1
            FROM pos_suppliers ps
            LEFT JOIN pos_supplier_canonical_mappings m
              ON m.property_id = ps.property_id AND m.pos_supplier_id = ps.id
           WHERE m.id IS NULL
        ) AS has_unmapped_suppliers,
        EXISTS (
          SELECT 1
            FROM transactions
           WHERE transaction_type = 'PURCHASE'
             AND po_id IS NULL
             AND is_legacy_without_po = FALSE
        ) AS has_unflagged_legacy_purchases,
        NOT EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_name = 'transaction_lines'
             AND column_name = 'conversion_factor_snapshot'
        ) AS missing_tl_snapshot_col,
        NOT EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_name = 'stock_purchase_line_bindings'
             AND column_name = 'conversion_factor_snapshot'
        ) AS missing_binding_snapshot_col,
        NOT EXISTS (
          SELECT 1
            FROM schema_migrations
           WHERE version = 'pos_procurement_tahap1a_v1_m01_snapshot_authority'
        ) AS missing_m01_snapshot_authority
    `);
    const row = pendingLegacyCheck.rows[0];
    if (
      !row?.has_unmapped_suppliers &&
      !row?.has_unflagged_legacy_purchases &&
      !row?.missing_tl_snapshot_col &&
      !row?.missing_binding_snapshot_col &&
      !row?.missing_m01_snapshot_authority
    ) {
      return { applied: [], skipped: [MIGRATION_VERSION] };
    }
  }

  for (const step of POS_PROCUREMENT_TAHAP1A_V1_STEPS) {
    await clientOrPool.query(step.sql);
    applied.push(step.id);
  }

  return { applied, skipped };
}

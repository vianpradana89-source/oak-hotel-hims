import { Pool } from 'pg';

export const MIGRATION_VERSION = 'product_master_stage1_v1';

/**
 * Migration: Product Master Stage 1 (product_master_stage1_v1)
 *
 * Prinsip Keamanan:
 * - Additive & idempotent.
 * - Tidak mengubah, membulatkan, atau menebak nilai klasifikasi/satuan/harga pada data existing.
 * - Data existing mempertahankan product_type = NULL, product_kind = NULL, base_unit = NULL
 *   ("Belum diatur") dan is_sellable_pos = TRUE agar tetap tersedia di POS seperti sebelumnya.
 * - Kolom price diubah menjadi nullable (tanpa default 0) sehingga produk internal baru
 *   (is_sellable_pos = FALSE) dapat disimpan dengan price = NULL tanpa ditampilkan sebagai Rp 0 / gratis.
 */
export async function runProductMasterStage1Migration(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Advisory lock untuk mencegah eksekusi paralel
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('oak_migration'), hashtext($1))`,
      [MIGRATION_VERSION]
    );

    // 2. Prasyarat tabel pos_menu_items
    const tableCheck = await client.query(`
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = 'pos_menu_items'
    `);
    if (tableCheck.rowCount === 0) {
      throw new Error('Prerequisite failed: table pos_menu_items does not exist.');
    }

    // 3. Pastikan tabel schema_migrations tersedia
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(120) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // 4. Penambahan kolom additive & penyesuaian nullable price
    await client.query(`
      ALTER TABLE pos_menu_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE pos_menu_items ADD COLUMN IF NOT EXISTS is_sellable_pos BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE pos_menu_items ADD COLUMN IF NOT EXISTS product_type VARCHAR(30);
      ALTER TABLE pos_menu_items ADD COLUMN IF NOT EXISTS product_kind VARCHAR(30);
      ALTER TABLE pos_menu_items ADD COLUMN IF NOT EXISTS base_unit VARCHAR(50);
      ALTER TABLE pos_menu_items ALTER COLUMN price DROP NOT NULL;
      ALTER TABLE pos_menu_items ALTER COLUMN price DROP DEFAULT;
    `);

    // 5. Constraint idempotent (NOT VALID agar tidak memodifikasi/menggagalkan data historis jika ada, lalu divalidasi bila aman)
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_pos_menu_items_product_type'
            AND conrelid = 'pos_menu_items'::regclass
        ) THEN
          ALTER TABLE pos_menu_items ADD CONSTRAINT chk_pos_menu_items_product_type
            CHECK (product_type IS NULL OR product_type IN ('RAW_MATERIAL', 'SEMI_FINISHED', 'FINISHED_GOOD')) NOT VALID;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_pos_menu_items_product_kind'
            AND conrelid = 'pos_menu_items'::regclass
        ) THEN
          ALTER TABLE pos_menu_items ADD CONSTRAINT chk_pos_menu_items_product_kind
            CHECK (product_kind IS NULL OR product_kind IN ('STANDARD')) NOT VALID;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_pos_menu_items_base_unit_non_empty'
            AND conrelid = 'pos_menu_items'::regclass
        ) THEN
          ALTER TABLE pos_menu_items ADD CONSTRAINT chk_pos_menu_items_base_unit_non_empty
            CHECK (base_unit IS NULL OR (LENGTH(BTRIM(base_unit)) >= 1 AND LENGTH(BTRIM(base_unit)) <= 50)) NOT VALID;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_pos_menu_items_price_sellable'
            AND conrelid = 'pos_menu_items'::regclass
        ) THEN
          ALTER TABLE pos_menu_items ADD CONSTRAINT chk_pos_menu_items_price_sellable
            CHECK ((price IS NULL OR price >= 0) AND (NOT is_sellable_pos OR price IS NOT NULL)) NOT VALID;
        END IF;
      END $$;
    `);

    // 6. Index pendukung filter POS & Master Produk
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pmi_property_sellable_active
        ON pos_menu_items(property_id, is_active, is_sellable_pos);
      CREATE INDEX IF NOT EXISTS idx_pmi_property_product_type
        ON pos_menu_items(property_id, product_type);
    `);

    // 7. Catat versi migration
    await client.query(
      `INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
      [MIGRATION_VERSION]
    );

    // 8. Verifikasi pasca-DDL
    const verifyCols = await client.query(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'pos_menu_items'
        AND column_name IN ('product_type', 'product_kind', 'base_unit', 'is_sellable_pos', 'price')
    `);
    const colMap = new Map<string, string>(
      verifyCols.rows.map((r: any) => [String(r.column_name), String(r.is_nullable)])
    );
    for (const requiredCol of ['product_type', 'product_kind', 'base_unit', 'is_sellable_pos', 'price']) {
      if (!colMap.has(requiredCol)) {
        throw new Error(`Post-DDL verification failed: column pos_menu_items.${requiredCol} missing`);
      }
    }
    if (colMap.get('price') !== 'YES') {
      throw new Error('Post-DDL verification failed: pos_menu_items.price must be nullable');
    }

    await client.query('COMMIT');
    console.log(`[Migration ${MIGRATION_VERSION}] Successfully applied and verified.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

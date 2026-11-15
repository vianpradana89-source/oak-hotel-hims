import { Pool } from 'pg';

export const MIGRATION_VERSION = 'product_master_mp02b_v1';

/**
 * Migration: Product Master MP-02B — Barcode & Foto Produk (product_master_mp02b_v1)
 *
 * Prinsip Keamanan:
 * - Additive & idempotent.
 * - Menambahkan kolom opsional barcode VARCHAR(100) dan photo_storage_key TEXT pada pos_menu_items.
 * - Tidak mengubah, menebak, atau mengisi otomatis barcode dari item_code/SKU.
 * - Unik per properti (mencakup produk aktif dan nonaktif) melalui unique partial index
 *   uq_pmi_property_barcode ON pos_menu_items(property_id, barcode) WHERE barcode IS NOT NULL.
 */
export async function runProductMasterMp02bMigration(pool: Pool): Promise<void> {
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

    // 4. Penambahan kolom additive barcode & photo_storage_key
    await client.query(`
      ALTER TABLE pos_menu_items ADD COLUMN IF NOT EXISTS barcode VARCHAR(100);
      ALTER TABLE pos_menu_items ADD COLUMN IF NOT EXISTS photo_storage_key TEXT;
    `);

    // 5. Constraint idempotent untuk panjang barcode non-kosong (1..100 karakter setelah trim)
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_pos_menu_items_barcode_non_empty'
            AND conrelid = 'pos_menu_items'::regclass
        ) THEN
          ALTER TABLE pos_menu_items ADD CONSTRAINT chk_pos_menu_items_barcode_non_empty
            CHECK (barcode IS NULL OR (LENGTH(BTRIM(barcode)) >= 1 AND LENGTH(BTRIM(barcode)) <= 100)) NOT VALID;
        END IF;
      END $$;
    `);

    // 6. Unique partial index barcode per properti (termasuk produk nonaktif)
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_pmi_property_barcode
        ON pos_menu_items(property_id, barcode)
        WHERE barcode IS NOT NULL;
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
        AND column_name IN ('barcode', 'photo_storage_key')
    `);
    const colMap = new Map<string, string>(
      verifyCols.rows.map((r: any) => [String(r.column_name), String(r.is_nullable)])
    );
    for (const requiredCol of ['barcode', 'photo_storage_key']) {
      if (!colMap.has(requiredCol)) {
        throw new Error(`Post-DDL verification failed: column pos_menu_items.${requiredCol} missing`);
      }
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

export interface ProductMasterMp02bMigrationCliOptions {
  createPool?: () => Pick<Pool, 'connect' | 'end'>;
  runMigration?: (pool: Pool) => Promise<void>;
  onError?: (err: unknown) => void;
  setExitCode?: (code: number) => void;
}

export async function runProductMasterMp02bMigrationCli(
  options: ProductMasterMp02bMigrationCliOptions = {}
): Promise<number> {
  const createPool =
    options.createPool ||
    (() =>
      new Pool(
        process.env.DATABASE_URL
          ? { connectionString: process.env.DATABASE_URL }
          : {
              host: process.env.DB_HOST || 'localhost',
              port: Number(process.env.DB_PORT || 5432),
              database: process.env.DB_NAME || 'oak_hotel_db',
              user: process.env.DB_USER || 'postgres',
              password: process.env.DB_PASSWORD || 'postgres',
            }
      ));
  const runMigration = options.runMigration || runProductMasterMp02bMigration;
  const onError =
    options.onError ||
    ((err: unknown) => {
      console.error('[Migration Runner] Failed:', err);
    });
  const setExitCode =
    options.setExitCode ||
    ((code: number) => {
      process.exitCode = code;
    });

  const pool = createPool();
  try {
    await runMigration(pool as Pool);
    return 0;
  } catch (err) {
    onError(err);
    setExitCode(1);
    return 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv/config');
  runProductMasterMp02bMigrationCli().then((code) => {
    if (code !== 0) {
      process.exit(code);
    }
  });
}

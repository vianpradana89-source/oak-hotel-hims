/**
 * POS RECEIPT SNAPSHOT v1 — Tahap: Snapshot nama & kode item untuk receipt
 * DDL Authoritative:
 *   - pos_order_items: +item_name_snapshot VARCHAR(100) NOT NULL
 *                     +item_code_snapshot VARCHAR(50) NULL
 *
 * Kontrak:
 * - Migration menambah kolom baru item_name_snapshot & item_code_snapshot
 *   pada pos_order_items (ADD COLUMN IF NOT EXISTS).
 * - Tidak mengubah nilai finansial/order/item existing (quantity, unit_price,
 *   discount, total, dll).
 * - Mengisi kolom snapshot baru pada row historical HANYA bila snapshot masih
 *   NULL dan item masih dapat di-resolve dari pos_menu_items (backfill).
 * - Tidak menebak snapshot bila master item tidak dapat di-resolve
 *   ('Unknown Item', 'Deleted Item', menu_item_id, placeholder apa pun).
 * - Idempoten: safe untuk re-run (marker ada → skip DDL, verifikasi saja).
 * - Migration transactional dengan advisory lock.
 * - Marker: `pos_receipt_snapshot_v1` pada `schema_migrations`.
 * - Jika setelah backfill masih ada row dengan item_name_snapshot IS NULL
 *   (menu item tidak ditemukan / tidak dapat di-resolve), migration GAGAL
 *   eksplisit dan ROLLBACK.
 * - Verifikasi marker & schema SETELAH marker (mismatch → gagal eksplisit).
 *
 * Prerequisite:
 *   - Tabel `schema_migrations` HARUS sudah ada untuk marker.
 *   - Tabel `pos_order_items` HARUS sudah ada (schema dasar).
 *   - Tabel `pos_menu_items` HARUS sudah ada (master menu).
 *   Jika tidak, migration GAGAL eksplisit — TIDAK membuat schema tebakan.
 *
 * Gunakan via runner CLI:
 *   node backend/scripts/run_pos_receipt_snapshot_migration.js
 * dengan MIGRATION_DATABASE_URL eksplisit.
 *
 * Runner: backend/scripts/run_pos_receipt_snapshot_migration.js.
 * Runner requires an explicit, allowlisted MIGRATION_DATABASE_URL.
 */

import { Pool, PoolClient } from 'pg';

const MARKER = 'pos_receipt_snapshot_v1';

// =============================================================================
// Prerequisite check
// =============================================================================

/**
 * Verifikasi bahwa tabel prerequisite tersedia SEBELUM menjalankan DDL.
 * Jika tabel tidak ada, migration gagal eksplisit tanpa membuat schema tebakan.
 */
export async function checkPrerequisites(
  client: PoolClient
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  const tables = [
    'schema_migrations',
    'pos_order_items',
    'pos_menu_items',
  ];

  for (const t of tables) {
    const r = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1`,
      [t]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(
        `Tabel prerequisite '${t}' tidak ditemukan. ` +
        `Jalankan migrasi dasar terlebih dahulu.`
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

// =============================================================================
// DDL — semua statement dalam satu string; dieksekusi berurutan dalam 1 transaksi
// =============================================================================

export const POS_RECEIPT_SNAPSHOT_DDL = `
-- ── pos_order_items: snapshot item name & code untuk receipt ─────────────
ALTER TABLE pos_order_items
  ADD COLUMN IF NOT EXISTS item_name_snapshot VARCHAR(100) NULL;

ALTER TABLE pos_order_items
  ADD COLUMN IF NOT EXISTS item_code_snapshot VARCHAR(50) NULL;
`;

/**
 * Backfill: isi item_name_snapshot & item_code_snapshot dari pos_menu_items
 * HANYA untuk row yang snapshot-nya masih NULL.
 *
 * RULE:
 * - Tidak menggunakan fallback 'Unknown Item', 'Deleted Item', menu_item_id,
 *   atau teks placeholder lainnya.
 * - Jika menu item tidak ada / tidak dapat di-resolve, baris tetap NULL
 *   dan akan dideteksi oleh langkah verifikasi setelah backfill.
 */
export const BACKFILL_SQL = `
UPDATE pos_order_items poi
SET
  item_name_snapshot = pmi.name,
  item_code_snapshot = pmi.item_code
FROM pos_menu_items pmi
WHERE pmi.id = poi.menu_item_id
  AND poi.item_name_snapshot IS NULL;
`;

export const MARKER_SQL = `
INSERT INTO schema_migrations (version) VALUES ('pos_receipt_snapshot_v1')
ON CONFLICT (version) DO NOTHING;
`;

// =============================================================================
// Verifikasi Schema — termasuk NOT NULL constraint & tipe kolom
// =============================================================================

export interface VerificationResult {
  ok: boolean;
  errors: string[];
}

export type MigrationRunStatus =
  | 'applied'
  | 'already-applied'
  | 'mismatch'
  | 'verification-failed'
  | 'error'
  | 'prerequisite-failed';

/**
 * Verifikasi kolom item_name_snapshot & item_code_snapshot
 * pada pos_order_items.
 *
 * Ekspektasi final:
 *   - item_name_snapshot: data_type='character varying', max_len=100, NOT NULL
 *   - item_code_snapshot: data_type='character varying', max_len=50, nullable
 *
 * Untuk jalur "applied" (marker belum ada), setelah backfill, item_name_snapshot
 * akan di-ALTER SET NOT NULL sehingga verifikasi memeriksa NOT NULL.
 * Untuk jalur "already-applied" (marker sudah ada), verifikasi sama —
 * skema harus sudah di posisi final.
 */
export async function verifyPosReceiptSnapshotSchema(
  client: PoolClient
): Promise<VerificationResult> {
  const errors: string[] = [];

  async function checkVarcharColumn(
    table: string,
    colName: string,
    expectedMaxLen: number,
    expectedNullable: boolean,
  ): Promise<void> {
    const r = await client.query(
      `SELECT character_maximum_length AS max_len,
              is_nullable            AS nullable,
              data_type,
              udt_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = $1
         AND column_name  = $2`,
      [table, colName]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(`Kolom ${table}.${colName} tidak ditemukan`);
      return;
    }
    const row = r.rows[0];
    if (row.data_type !== 'character varying') {
      errors.push(
        `Kolom ${table}.${colName}: data_type=${row.data_type}, ` +
        `ekspektasi 'character varying'`
      );
    }
    if (row.max_len !== expectedMaxLen) {
      errors.push(
        `Kolom ${table}.${colName}: max_len=${row.max_len}, ` +
        `ekspektasi ${expectedMaxLen}`
      );
    }
    if (row.nullable !== (expectedNullable ? 'YES' : 'NO')) {
      errors.push(
        `Kolom ${table}.${colName}: nullable=${row.nullable}, ` +
        `ekspektasi ${expectedNullable ? 'YES' : 'NO'}`
      );
    }
  }

  // item_name_snapshot: VARCHAR(100) NOT NULL
  await checkVarcharColumn('pos_order_items', 'item_name_snapshot', 100, false);

  // item_code_snapshot: VARCHAR(50) nullable
  await checkVarcharColumn('pos_order_items', 'item_code_snapshot', 50, true);

  return { ok: errors.length === 0, errors };
}

// =============================================================================
// Verifikasi Marker
// =============================================================================

/**
 * Verifikasi bahwa marker pos_receipt_snapshot_v1 tepat satu row
 * tersedia di schema_migrations.
 *
 * Query eksak:
 *   SELECT 1 FROM schema_migrations WHERE version = 'pos_receipt_snapshot_v1'
 *
 * Dipakai:
 * - Jalur "applied": dipanggil SETELAH INSERT MARKER_SQL, untuk memastikan
 *   marker benar-benar ditulis (bukan hilang / di-cancel oleh error).
 * - Jalur "already-applied": dipanggil untuk memastikan marker tetap ada
 *   (tidak terhapus di antara checkpoint).
 *
 * Jika gagal: caller harus menandai status='verification-failed' /
 * 'mismatch' dan membiarkan finally ROLLBACK.
 */
export async function verifyPosReceiptSnapshotMarker(
  client: PoolClient
): Promise<VerificationResult> {
  const errors: string[] = [];

  const r = await client.query(
    'SELECT 1 FROM schema_migrations WHERE version = $1',
    [MARKER]
  );
  const rowCount = r.rowCount ?? 0;

  if (rowCount !== 1) {
    errors.push(
      `Marker '${MARKER}' di schema_migrations: rowCount=${rowCount}, ` +
      `ekspektasi tepat 1 row`
    );
  }

  return { ok: errors.length === 0, errors };
}

// =============================================================================
// Runner Migration
// =============================================================================

/**
 * Jalankan migration pos receipt snapshot. Transactional + advisory lock.
 *
 * Pre-flight: cek prerequisite (tabel-tabel dasar harus ada).
 *
 * Jalur "applied" (marker belum ada):
 *   1. BEGIN
 *   2. advisory lock
 *   3. DDL (ADD COLUMN)
 *   4. backfill
 *   5. unresolved check (COUNT item_name_snapshot IS NULL)
 *   6. SET NOT NULL
 *   7. verify schema columns
 *   8. INSERT MARKER
 *   9. verify marker
 *  10. COMMIT
 *
 * Jalur "already-applied" (marker sudah ada):
 *   1. BEGIN
 *   2. advisory lock
 *   3. verify schema final
 *   4. verify marker
 *   5. COMMIT → already-applied
 *
 * Status:
 * - 'prerequisite-failed' : tabel dasar tidak tersedia.
 * - 'applied'             : DDL baru diterapkan + backfill + SET NOT NULL + marker diverifikasi.
 * - 'already-applied'     : marker sudah ada, skema & marker sesuai, tanpa re-DDL/re-backfill.
 * - 'mismatch'            : marker ada tetapi skema/marker tidak sesuai → ROLLBACK.
 * - 'verification-failed' : DDL baru diterapkan tetapi verifikasi gagal → ROLLBACK.
 * - 'error'               : exception di tengah transaksi → ROLLBACK.
 *
 * @returns { ok, applied, status, errors }
 */
export async function runPosReceiptSnapshotMigration(
  pool: Pool,
): Promise<{
  ok: boolean;
  applied: boolean;
  status: MigrationRunStatus;
  errors: string[];
}> {
  let client: PoolClient | null = null;
  let txnActive = false;
  let discardClient = false;

  let result: {
    ok: boolean;
    applied: boolean;
    status: MigrationRunStatus;
    errors: string[];
  } = {
    ok: false,
    applied: false,
    status: 'error',
    errors: [],
  };

  try {
    client = await pool.connect();
  } catch (err: any) {
    result.errors.push(`Acquire client gagal: ${err?.message || err}`);
    return result;
  }

  try {
    const prereq = await checkPrerequisites(client);

    if (!prereq.ok) {
      result = {
        ok: false,
        applied: false,
        status: 'prerequisite-failed',
        errors: [...prereq.errors],
      };
    } else {
      await client.query('BEGIN');
      txnActive = true;

      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('oak_hims_schema_migrations_lock'))",
      );

      const markerCheck = await client.query(
        'SELECT 1 FROM schema_migrations WHERE version = $1',
        [MARKER],
      );
      const markerExists = (markerCheck.rowCount ?? 0) > 0;

      if (!markerExists) {
        // Jalur applied: DDL + backfill + verifikasi data + SET NOT NULL
        await client.query(POS_RECEIPT_SNAPSHOT_DDL);

        // Backfill hanya untuk row snapshot masih NULL
        await client.query(BACKFILL_SQL);

        // Verifikasi: pastikan tidak ada row pos_order_items dengan
        // item_name_snapshot masih NULL setelah backfill.
        // Jika ada, berarti menu item tidak dapat di-resolve → gagal eksplisit.
        const unresolvedCheck = await client.query(
          `SELECT COUNT(*) AS cnt FROM pos_order_items WHERE item_name_snapshot IS NULL`
        );
        const unresolvedCount = Number(unresolvedCheck.rows[0]?.cnt ?? 0);

        if (unresolvedCount > 0) {
          result = {
            ok: false,
            applied: false,
            status: 'verification-failed',
            errors: [
              `${unresolvedCount} baris pos_order_items masih memiliki item_name_snapshot NULL ` +
              `setelah backfill. Item-item ini tidak dapat di-resolve ke master pos_menu_items. ` +
              `Migration tidak akan menebak snapshot (tidak menggunakan 'Unknown Item', ` +
              `'Deleted Item', menu_item_id, atau placeholder lain). ` +
              `Perbaiki data menu item terlebih dahulu lalu jalankan ulang migration.`,
            ],
          };
          // Transaksi masih aktif; finally akan melakukan ROLLBACK.
        } else {
          // SET NOT NULL: item_name_snapshot sudah terisi di semua row.
          // item_code_snapshot tetap nullable karena pos_menu_items.item_code memang nullable.
          await client.query(
            'ALTER TABLE pos_order_items ALTER COLUMN item_name_snapshot SET NOT NULL'
          );

          const verify = await verifyPosReceiptSnapshotSchema(client);

          if (!verify.ok) {
            result = {
              ok: false,
              applied: false,
              status: 'verification-failed',
              errors: [...verify.errors],
            };
            // Transaksi masih aktif; finally akan melakukan ROLLBACK.
          } else {
            await client.query(MARKER_SQL);

            // Verify marker benar-benar ada SETELAH INSERT
            const markerVerify = await verifyPosReceiptSnapshotMarker(client);

            if (!markerVerify.ok) {
              result = {
                ok: false,
                applied: false,
                status: 'verification-failed',
                errors: [
                  ...markerVerify.errors,
                  'Marker gagal diverifikasi setelah INSERT — transaksi di-ROLLBACK.',
                ],
              };
              // Transaksi masih aktif; finally akan melakukan ROLLBACK.
            } else {
              await client.query('COMMIT');
              txnActive = false;

              result = {
                ok: true,
                applied: true,
                status: 'applied',
                errors: [],
              };
            }
          }
        }
      } else {
        // Jalur already-applied: marker sudah ada.
        // JANGAN re-backfill secara diam-diam.
        // Verifikasi schema final + marker.
        const verify = await verifyPosReceiptSnapshotSchema(client);
        const markerVerify = await verifyPosReceiptSnapshotMarker(client);

        if (!verify.ok || !markerVerify.ok) {
          result = {
            ok: false,
            applied: false,
            status: 'mismatch',
            errors: [...verify.errors, ...markerVerify.errors],
          };
          // Transaksi masih aktif; finally akan melakukan ROLLBACK.
        } else {
          await client.query('COMMIT');
          txnActive = false;

          result = {
            ok: true,
            applied: false,
            status: 'already-applied',
            errors: [],
          };
        }
      }
    }
  } catch (err: any) {
    result = {
      ok: false,
      applied: false,
      status: 'error',
      errors: [`Exception: ${err?.message || err}`],
    };
  } finally {
    if (txnActive) {
      try {
        await client.query('ROLLBACK');
        txnActive = false;
      } catch (err: any) {
        discardClient = true;
        result.ok = false;
        result.errors.push(`ROLLBACK gagal: ${err?.message || err}`);
      }
    }

    // Satu-satunya panggilan release dalam fungsi ini.
    // true menghancurkan koneksi ketika ROLLBACK gagal.
    try {
      client!.release(discardClient);
    } catch (err: any) {
      result.ok = false;
      result.status = 'error';
      result.errors.push(`Release client gagal: ${err?.message || err}`);
      // Tidak mencoba release kedua kali.
    }
  }

  return result;
}

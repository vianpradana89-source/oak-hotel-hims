/**
 * pos_order_update_v1.ts
 *
 * POS ORDER UPDATE v1 — Tahap: versioning + idempotency multi-siklus untuk PUT /api/pos/orders/:id
 *
 * DDL Authoritative:
 *   - pos_orders: +version INTEGER NOT NULL DEFAULT 1
 *   - CREATE TABLE pos_order_edit_requests (idempotency multi-siklus)
 *
 * Kontrak:
 * - Migration menambah kolom version + tabel pos_order_edit_requests (ADD/CREATE IF NOT EXISTS).
 * - Tidak mengubah nilai finansial/order/item existing (quantity, unit_price, discount, total, dll).
 * - Idempoten: safe untuk re-run (marker ada → skip DDL, verifikasi saja).
 * - Migration transactional dengan advisory lock.
 * - Marker: `pos_order_update_v1` pada `schema_migrations`.
 * - Verifikasi marker & schema SETELAH marker (mismatch → gagal eksplisit).
 *
 * Prerequisite:
 *   - Tabel `schema_migrations` HARUS sudah ada untuk marker.
 *   - Tabel `pos_orders` HARUS sudah ada (schema dasar).
 *   - Jika tidak, migration GAGAL eksplisit — TIDAK membuat schema tebakan.
 *
 * Gunakan via runner CLI:
 *   node backend/scripts/run_pos_order_update_migration.js
 * dengan MIGRATION_DATABASE_URL eksplisit.
 *
 * Runner: backend/scripts/run_pos_order_update_migration.js.
 * Runner requires an explicit, allowlisted MIGRATION_DATABASE_URL.
 */

import { Pool, PoolClient } from 'pg';

const MARKER = 'pos_order_update_v1';

// =============================================================================
// Prerequisite check
// =============================================================================

export async function checkPrerequisites(
  client: PoolClient
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];
  const tables = ['schema_migrations', 'pos_orders'];
  for (const t of tables) {
    const r = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1`,
      [t]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(`Tabel prerequisite '${t}' tidak ditemukan.`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// =============================================================================
// DDL — semua statement dalam satu string; dieksekusi berurutan dalam 1 transaksi
// =============================================================================

export const POS_ORDER_UPDATE_DDL = `
-- ── pos_orders: optimistic concurrency version ───────────────────────────
ALTER TABLE pos_orders
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- ── Tabel idempotency multi-siklus untuk PUT edit order ───────────────────
CREATE TABLE IF NOT EXISTS pos_order_edit_requests (
  id                  BIGSERIAL PRIMARY KEY,
  property_id         INTEGER NOT NULL,
  pos_order_id        INTEGER NOT NULL,
  idempotency_key     VARCHAR(150) NOT NULL,
  request_fingerprint VARCHAR(128) NOT NULL,
  resulting_version   INTEGER NOT NULL,
  resulting_total     NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_pos_order_edit_requests_key
    UNIQUE (property_id, pos_order_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_pos_order_edit_requests_order
  ON pos_order_edit_requests (property_id, pos_order_id);
`;

export const MARKER_SQL = `
INSERT INTO schema_migrations (version) VALUES ('pos_order_update_v1')
ON CONFLICT (version) DO NOTHING;
`;

// =============================================================================
// Verifikasi Schema
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

export async function verifyPosOrderUpdateSchema(
  client: PoolClient
): Promise<VerificationResult> {
  const errors: string[] = [];

  // ── pos_orders.version ────────────────────────────────────────────────────
  {
    const r = await client.query(
      `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'pos_orders' AND column_name = 'version'`
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push('Kolom pos_orders.version tidak ditemukan');
    } else {
      const col = r.rows[0];
      if (col.data_type !== 'integer') errors.push(`pos_orders.version: data_type=${col.data_type} (ekspektasi integer)`);
      if (col.is_nullable !== 'NO') errors.push(`pos_orders.version: nullable=${col.is_nullable} (ekspektasi NO)`);
      if (String(col.column_default) !== '1') errors.push(`pos_orders.version: default=${col.column_default} (ekspektasi 1)`);
    }
  }

  // ── pos_order_edit_requests ───────────────────────────────────────────────
  {
    const tblCheck = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'pos_order_edit_requests'`
    );
    if ((tblCheck.rowCount ?? 0) === 0) {
      errors.push('Tabel public.pos_order_edit_requests tidak ditemukan');
    } else {
      // Catatan tipe id: PostgreSQL melaporkan BIGSERIAL pada
      // information_schema.columns sebagai data_type='bigint' (udt_name='int8').
      // 'bigserial' BUKAN nilai yang pernah dikembalikan information_schema
      // (ia pseudo-type saat DDL). DDL di file ini memakai BIGSERIAL PRIMARY KEY,
      // jadi ekspektasi verifikasi yang benar adalah 'bigint'.
      const requiredCols: Array<[string, string]> = [
        ['id', 'bigint'],
        ['property_id', 'integer'],
        ['pos_order_id', 'integer'],
        ['idempotency_key', 'character varying'],
        ['request_fingerprint', 'character varying'],
        ['resulting_version', 'integer'],
        ['resulting_total', 'numeric'],
        ['created_at', 'timestamp without time zone'],
      ];
      for (const [colName, expType] of requiredCols) {
        const cr = await client.query(
          `SELECT data_type, is_nullable
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'pos_order_edit_requests' AND column_name = $1`,
          [colName]
        );
        if ((cr.rowCount ?? 0) === 0) {
          errors.push(`Kolom pos_order_edit_requests.${colName} tidak ditemukan`);
        } else if (cr.rows[0].data_type !== expType) {
          errors.push(`Kolom pos_order_edit_requests.${colName}: data_type=${cr.rows[0].data_type} (ekspektasi ${expType})`);
        }
      }
      // UNIQUE constraint
      const uqRes = await client.query(
        `SELECT COUNT(*)::int AS n FROM information_schema.table_constraints
         WHERE table_schema = 'public' AND table_name = 'pos_order_edit_requests'
           AND constraint_name = 'uq_pos_order_edit_requests_key'
           AND constraint_type = 'UNIQUE'`
      );
      if (Number((uqRes.rows[0] as any).n) === 0) {
        errors.push('UNIQUE constraint uq_pos_order_edit_requests_key tidak ditemukan');
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// =============================================================================
// Runner
// =============================================================================

// Advisory lock: hash dari string deterministik (mengikuti pola migration lain).
const ADVISORY_LOCK_ID = 325127; // nilai konstan unik untuk pos_order_update_v1

export async function runPosOrderUpdateMigration(
  pool: Pool
): Promise<{ status: MigrationRunStatus; errors: string[] }> {
  const client = await pool.connect();
  let txnActive = false;
  try {
    await client.query('BEGIN');
    txnActive = true;

    // Advisory lock (transaksional — dilepas otomatis saat commit/rollback)
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [ADVISORY_LOCK_ID]);

    // Prerequisite check
    const prereq = await checkPrerequisites(client);
    if (!prereq.ok) {
      await client.query('ROLLBACK');
      txnActive = false;
      return { status: 'prerequisite-failed', errors: prereq.errors };
    }

    // Check marker
    const markerCheck = await client.query(
      `SELECT 1 FROM schema_migrations WHERE version = $1`,
      [MARKER]
    );

    if ((markerCheck.rowCount ?? 0) > 0) {
      // Already applied — verify schema
      const verify = await verifyPosOrderUpdateSchema(client);
      await client.query('ROLLBACK');
      txnActive = false;
      if (!verify.ok) {
        return { status: 'verification-failed', errors: verify.errors };
      }
      return { status: 'already-applied', errors: [] };
    }

    // Execute DDL
    await client.query(POS_ORDER_UPDATE_DDL);
    await client.query(MARKER_SQL);

    // Verify after apply
    const verify = await verifyPosOrderUpdateSchema(client);
    if (!verify.ok) {
      await client.query('ROLLBACK');
      txnActive = false;
      return { status: 'verification-failed', errors: verify.errors };
    }

    await client.query('COMMIT');
    txnActive = false;
    return { status: 'applied', errors: [] };
  } catch (err: any) {
    if (txnActive) {
      try { await client.query('ROLLBACK'); } catch (_) { /* sudah terminated */ }
    }
    return { status: 'error', errors: [err.message] };
  } finally {
    client.release();
  }
}

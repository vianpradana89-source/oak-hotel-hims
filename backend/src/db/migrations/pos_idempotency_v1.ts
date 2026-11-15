/**
 * POS IDEMPOTENCY — Tahap A: Fondasi Idempotency Domain
 * DDL Authoritative: tambah kolom idempotency_key + request_fingerprint di pos_orders
 *                    + unique partial index untuk replay/retry atomik.
 *
 * Kontrak:
 * - Tidak mengubah schema_v3.ts, index.ts, stayCharges, atau file lain.
 * - Migration transactional dengan advisory lock (pola repo:
 *   `SELECT pg_advisory_xact_lock(hashtext('oak_hims_schema_migrations_lock'))`).
 * - Marker: `pos_idempotency_v1` pada `schema_migrations`.
 * - Verifikasi schema SEBELUM dan SETELAH marker (mismatch → gagal eksplisit).
 * - Idempoten: jika marker ada dan schema sesuai → skip DDL, status 'already-applied'.
 *
 * Gunakan via runner CLI:
 *   node backend/scripts/run_pos_idempotency_migration.js
 * dengan MIGRATION_DATABASE_URL eksplisit.
 */

import { Pool, PoolClient } from 'pg';

const MARKER = 'pos_idempotency_v1';

// =============================================================================
// DDL — semua statement dalam satu string; dieksekusi berurutan dalam 1 transaksi
// =============================================================================

export const POS_IDEMPOTENCY_DDL = `
-- Kolom baru di pos_orders: idempotency_key (key request dari client)
ALTER TABLE pos_orders
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(150);

-- Kolom baru di pos_orders: request_fingerprint (hash payload bisnis untuk deteksi konflik)
ALTER TABLE pos_orders
  ADD COLUMN IF NOT EXISTS request_fingerprint VARCHAR(128);

-- Unique partial index: cegah dua order dengan key sama di properti yang sama.
-- WHERE IS NOT NULL → request tanpa key tetap boleh banyak (backward compat).
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_orders_idempotency
  ON pos_orders (property_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Index biasa untuk lookup cepat saat replay
CREATE INDEX IF NOT EXISTS idx_pos_orders_idempotency_key
  ON pos_orders (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Index untuk filter per reservasi di GET
CREATE INDEX IF NOT EXISTS idx_pos_orders_reservation_id
  ON pos_orders (property_id, reservation_id)
  WHERE reservation_id IS NOT NULL;
`;

export const MARKER_SQL = `
INSERT INTO schema_migrations (version) VALUES ('pos_idempotency_v1')
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
  | 'error';

/**
 * Verifikasi definisi SKEMA AKTUAL: tipe/nullability/default kolom,
 * AM/uniqueness/urutan-kolom/predicate/indisvalid/indisready/indislive index.
 * Objek hilang atau definisi salah → error eksplisit, ok=false.
 * Nama index saja BUKAN bukti valid; tiap sub-komponen DDL diperiksa.
 */
export async function verifyPosIdempotencySchema(client: PoolClient): Promise<VerificationResult> {
  const errors: string[] = [];

  // ── Tabel pos_orders harus ada ─────────────────────────────────────────
  const tblCheck = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'pos_orders'`
  );
  if ((tblCheck.rowCount ?? 0) === 0) {
    errors.push('Tabel public.pos_orders tidak ditemukan');
    return { ok: false, errors };
  }

  // ── Helper: periksa kolom (nama, tipe, nullable, default) ─────────────
  async function checkColumn(
    colName: string,
    expectedMaxLen: number,
    expectedNullable: boolean,
    expectedDefault: boolean,
  ): Promise<void> {
    const r = await client.query(
      `SELECT character_maximum_length AS max_len,
              is_nullable            AS nullable,
              column_default         AS default_val,
              data_type,
              udt_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'pos_orders'
         AND column_name  = $1`,
      [colName]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(`Kolom pos_orders.${colName} tidak ditemukan`);
      return;
    }
    const row = r.rows[0];
    // tipe: data_type dan udt_name wajib 'character varying' / 'varchar'
    if (row.data_type !== 'character varying') {
      errors.push(
        `Kolom pos_orders.${colName}: data_type=${row.data_type}, ekspektasi 'character varying'`
      );
    }
    if (row.udt_name !== 'varchar') {
      errors.push(
        `Kolom pos_orders.${colName}: udt_name=${row.udt_name}, ekspektasi 'varchar'`
      );
    }
    // panjang: character_maximum_length = expected (VARCHAR(150) / VARCHAR(128))
    if (row.max_len !== expectedMaxLen) {
      errors.push(
        `Kolom pos_orders.${colName}: character_maximum_length=${row.max_len}, ` +
        `ekspektasi ${expectedMaxLen}`
      );
    }
    // nullable
    if (row.nullable !== (expectedNullable ? 'YES' : 'NO')) {
      errors.push(
        `Kolom pos_orders.${colName}: nullable=${row.nullable}, ` +
        `ekspektasi ${expectedNullable ? 'nullable' : 'NOT NULL'}`
      );
    }
    // default
    if (expectedDefault === false && row.default_val !== null) {
      errors.push(
        `Kolom pos_orders.${colName}: default=${JSON.stringify(row.default_val)}, ` +
        `ekspektasi tanpa default`
      );
    }
  }

  await checkColumn('idempotency_key', 150, true, false);
  await checkColumn('request_fingerprint', 128, true, false);

  // ── Helper: periksa satu index btree eksplisit ──────────────────────────
  // expCols  : urutan kolom key (tanpa INCLUDE)
  // expUnique: uniqueness yang diharapkan
  // expPred  : predicate WHERE (string SQL, dinormalisasi), null jika tak ada
  async function checkIndex(
    idxName: string,
    expCols: string[],
    expUnique: boolean,
    expPred: string | null,
  ): Promise<void> {
    const q = await client.query(
      `SELECT
         c.oid                AS idx_oid,
         am.amname            AS am_name,
         i.indisunique       AS indisunique,
         i.indisvalid        AS indisvalid,
         i.indisready        AS indisready,
         i.indislive         AS indislive,
         i.indnatts          AS indnatts,
         i.indnkeyatts       AS indnkeyatts,
         i.indrelid         AS indrelid,
         i.indkey::text      AS indkey_text,
         pg_get_expr(i.indpred, i.indrelid) AS pred,
         c.relpersistence    AS persistence,
         tn.nspname          AS table_schema,
         tc.relname          AS table_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_index   i ON i.indexrelid = c.oid
       JOIN pg_am      am ON am.oid = c.relam
       LEFT JOIN pg_class tc ON tc.oid = i.indrelid
       LEFT JOIN pg_namespace tn ON tn.oid = tc.relnamespace
       WHERE c.relname = $1
         AND n.nspname = 'public'
         AND c.relkind = 'i'`,
      [idxName]
    );

    if ((q.rowCount ?? 0) === 0) {
      errors.push(`Index public.${idxName} tidak ditemukan (relkind='i')`);
      return;
    }
    const row = q.rows[0];

    // Tabel asal wajib public.pos_orders (via pg_index.indrelid)
    if (row.table_schema !== 'public' || row.table_name !== 'pos_orders') {
      errors.push(
        `Index ${idxName}: tabel asal=${row.table_schema}.${row.table_name}, ` +
        `ekspektasi public.pos_orders`
      );
      return;
    }

    // AM = btree
    if (row.am_name !== 'btree') {
      errors.push(`Index ${idxName}: AM=${row.am_name}, ekspektasi btree`);
    }

    // uniqueness
    if (row.indisunique !== expUnique) {
      errors.push(
        `Index ${idxName}: indisunique=${row.indisunique}, ` +
        `ekspektasi ${expUnique ? 'UNIQUE' : 'non-unique'}`
      );
    }

    // indisvalid / indisready / indislive
    if (row.indisvalid !== true) errors.push(`Index ${idxName}: indisvalid=false (belum valid)`);
    if (row.indisready !== true) errors.push(`Index ${idxName}: indisready=false (build belum selesai)`);
    if (row.indislive  !== true) errors.push(`Index ${idxName}: indislive=false (index tidak aktif)`);

    // INCLUDE: indnkeyatts = jumlah kolom key.
    // Wajib: indnatts === indnkeyatts === expCols.length.
    const natts = Number(row.indnatts);
    const nkey = Number(row.indnkeyatts);
    if (natts !== nkey) {
      errors.push(
        `Index ${idxName}: indnatts=${natts} != indnkeyatts=${nkey} — ` +
        `INCLUDE/ekstra kolom terdeteksi (indnatts harus = indnkeyatts = ${expCols.length})`
      );
    } else if (nkey !== expCols.length) {
      errors.push(
        `Index ${idxName}: indnkeyatts=${nkey}, ekspektasi ${expCols.length} ` +
        `(INCLUDE/ekstra kolom terdeteksi?)`
      );
    }

    // Parsing indkey::text → array smallint.
    // int2vector::text menghasilkan "2 11" (space-separated, tanpa kurung).
    // Handle juga format curly-brace untuk robustness: "{2,11}".
    const rawIndkey = String(row.indkey_text ?? '');
    const inner = rawIndkey.replace(/^[{]/, '').replace(/}$/, '');
    const attnums: number[] = inner
      .split(/[\s,]+/)
      .map((s: string) => Number(s.trim()))
      .filter((n: number) => !Number.isNaN(n));

    // Jumlah attnums WAJIB = expCols.length.
    if (attnums.length !== expCols.length) {
      errors.push(
        `Index ${idxName}: indkey menghasilkan ${attnums.length} attnum, ` +
        `ekspektasi ${expCols.length} (indkey="${rawIndkey}")`
      );
    }

    // Setiap attnum harus > 0 (0 = kolom expression / tidak valid).
    const hasExpr = attnums.some((n) => n === 0);
    if (hasExpr) {
      errors.push(`Index ${idxName}: mengandung kolom expression (indkey attnum=0)`);
    }

    // Resolusi attnum → attname via pg_attribute dengan indrelid index aktual.
    if (attnums.length === expCols.length && !hasExpr) {
      // Bangun $2, $3, ... placeholder untuk IN clause; $1 = indrelid.
      const placeholders = attnums.map((_: number, i: number) => `$${i + 2}`).join(',');
      const nameQ = await client.query(
        `SELECT a.attnum, a.attname
         FROM pg_attribute a
         WHERE a.attrelid = $1
           AND a.attnum IN (${placeholders})
         ORDER BY a.attnum`,
        [Number(row.indrelid), ...attnums]
      );
      const attnumToName: Record<number, string> = {};
      for (const r of nameQ.rows) attnumToName[Number(r.attnum)] = r.attname;
      const colNames = attnums.map((n: number) => attnumToName[n] ?? `(attnum=${n} tidak ditemukan)`);
      const mismatch = expCols
        .map((c, i) => ({ expected: c, actual: colNames[i] ?? '(kosong)' }))
        .filter((m) => m.expected !== m.actual);
      if (mismatch.length) {
        errors.push(
          `Index ${idxName}: urutan/nama kolom = [${colNames.join(', ')}], ` +
          `ekspektasi [${expCols.join(', ')}]`
        );
      }
    }

    // Predicate WHERE
    const actualPred = row.pred ? String(row.pred).trim() : null;
    if (expPred === null) {
      if (actualPred !== null && actualPred !== '') {
        errors.push(`Index ${idxName}: predicate="${actualPred}", ekspektasi tanpa WHERE`);
      }
    } else {
      // Normalisasi: strip kurung luar pg_get_expr, rapikan whitespace, case-insensitive.
      const stripParens = (s: string) => {
        let t = s.trim();
        while (t.startsWith('(') && t.endsWith(')')) {
          const inner = t.slice(1, -1);
          // Hanya strip bila kurung berpasangan (heuristic sederhana: tanpa kurung dalam).
          if ((inner.match(/\(/g) || []).length === (inner.match(/\)/g) || []).length) {
            t = inner.trim();
          } else {
            break;
          }
        }
        return t;
      };
      const norm = (s: string) => stripParens(s).replace(/\s+/g, ' ').trim().toUpperCase();
      if (actualPred === null || norm(actualPred) !== norm(expPred)) {
        errors.push(
          `Index ${idxName}: predicate="${actualPred}", ` +
          `ekspektasi "${expPred}"`
        );
      }
    }
  }

  await checkIndex(
    'uq_pos_orders_idempotency',
    ['property_id', 'idempotency_key'],
    true,   // UNIQUE
    'idempotency_key IS NOT NULL'
  );

  await checkIndex(
    'idx_pos_orders_idempotency_key',
    ['idempotency_key'],
    false,  // non-unique
    'idempotency_key IS NOT NULL'
  );

  await checkIndex(
    'idx_pos_orders_reservation_id',
    ['property_id', 'reservation_id'],
    false,  // non-unique
    'reservation_id IS NOT NULL'
  );

  return { ok: errors.length === 0, errors };
}

// =============================================================================
// Runner Migration
// =============================================================================

/**
 * Jalankan migration pos idempotency. Transactional + advisory lock.
 *
 * Status:
 * - 'applied'             : DDL baru diterapkan + marker ditulis.
 * - 'already-applied'     : marker sudah ada, skema sesuai, tanpa re-DDL.
 * - 'mismatch'            : marker ada tetapi skema tidak sesuai → ROLLBACK.
 * - 'verification-failed' : DDL baru diterapkan tetapi verifikasi gagal → ROLLBACK.
 * - 'error'               : exception di tengah transaksi → ROLLBACK.
 *
 * @returns { ok, applied, status, errors }
 */
export async function runPosIdempotencyMigration(
  pool: Pool,
): Promise<{ ok: boolean; applied: boolean; status: MigrationRunStatus; errors: string[] }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('oak_hims_schema_migrations_lock'))",
    );

    const markerCheck = await client.query(
      'SELECT 1 FROM schema_migrations WHERE version = $1',
      [MARKER],
    );
    const markerExists = (markerCheck.rowCount ?? 0) > 0;

    if (!markerExists) {
      await client.query(POS_IDEMPOTENCY_DDL);
    }

    const verify = await verifyPosIdempotencySchema(client);
    if (!verify.ok) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        applied: false,
        status: markerExists ? 'mismatch' : 'verification-failed',
        errors: verify.errors,
      };
    }

    if (!markerExists) {
      await client.query(MARKER_SQL);
    }

    await client.query('COMMIT');

    if (markerExists) {
      return { ok: true, applied: false, status: 'already-applied', errors: [] };
    }
    return { ok: true, applied: true, status: 'applied', errors: [] };
  } catch (err: any) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* sudah rollback */
    }
    return {
      ok: false,
      applied: false,
      status: 'error',
      errors: [`Exception: ${err.message}`],
    };
  } finally {
    client.release();
  }
}

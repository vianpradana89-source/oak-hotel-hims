/**
 * POS ORDER EDIT REQUESTS — CORRECTIVE RUNTIME PRIVILEGES v1
 * (marker: pos_order_edit_requests_runtime_privileges_v1)
 *
 * ROOT CAUSE yang diperbaiki:
 *   Migration DDL pos_order_update_v1 dijalankan sebagai postgres (owner).
 *   Runtime Cloud Run backend berjalan di bawah database role `oak_app`.
 *   Ketika endpoint PUT /api/pos/orders/:id dipanggil, handler mengakses
 *   tabel `pos_order_edit_requests` untuk verifikasi idempotency multi-siklus,
 *   namun runtime menerima error:
 *     "permission denied for table pos_order_edit_requests".
 *
 * Kebijakan corrective (pola resmi repo — grant eksplisit minimum ke role
 * runtime, marker terpisah, marker hanya ditulis SETELAH GRANT sukses):
 *   GRANT SELECT, INSERT
 *   ON TABLE public.pos_order_edit_requests
 *   TO oak_app;
 *
 *   GRANT USAGE, SELECT
 *   ON SEQUENCE public.pos_order_edit_requests_id_seq
 *   TO oak_app;
 *
 *   GRANT UPDATE (dan SELECT jika belum ada)
 *   ON TABLE public.pos_orders
 *   TO oak_app; (hanya jika verifikasi membuktikan diperlukan)
 *
 * Sifat:
 *   - TERPISAH dari DDL utama: TIDAK menjalankan ulang DDL pos_order_update_v1,
 *     TIDAK mengubah struktur, TIDAK menghapus atau memutasi data order/payment.
 *   - Additive: hanya GRANT minimum (tanpa DELETE, tanpa ALL, tanpa
 *     ALTER OWNER, tanpa ALTER DEFAULT PRIVILEGES).
 *   - Idempotent: GRANT dapat diulang tanpa efek; marker ON CONFLICT DO NOTHING.
 *   - Fail-closed: precondition (role oak_app, tabel pos_order_edit_requests,
 *     sequence pos_order_edit_requests_id_seq, tabel pos_orders, marker utama
 *     pos_order_update_v1) diverifikasi SEBELUM mutasi.
 *   - Safe against missing objects: jika role atau relasi belum ada, inspect
 *     melaporkan status MISSING tanpa memicu exception PostgreSQL has_*_privilege.
 *   - Transactional + advisory lock mengikuti pola migration repo
 *     (pg_advisory_xact_lock pada kunci shared schema_migrations).
 *
 * Prerequisite:
 *   - Marker utama 'pos_order_update_v1' HARUS sudah ada di schema_migrations.
 *     Jika tidak, corrective GAGAL eksplisit (status 'prerequisite-failed').
 */

import { Pool, PoolClient } from 'pg';

export const MARKER = 'pos_order_edit_requests_runtime_privileges_v1';
export const PRIMARY_MARKER = 'pos_order_update_v1';

export const TABLE_EDIT_REQUESTS = 'pos_order_edit_requests';
export const SEQUENCE_EDIT_REQUESTS = 'pos_order_edit_requests_id_seq';
export const TABLE_POS_ORDERS = 'pos_orders';
export const ROLE = 'oak_app';

// Advisory lock key shared dengan pola migration repo (oak_hims_schema_migrations_lock).
const ADVISORY_LOCK = "SELECT pg_advisory_xact_lock(hashtext('oak_hims_schema_migrations_lock'))";

export type RuntimePrivilegesRunStatus =
  | 'applied'
  | 'already-applied'
  | 'prerequisite-failed'
  | 'error';

export interface RuntimePrivilegesResult {
  ok: boolean;
  applied: boolean;
  status: RuntimePrivilegesRunStatus;
  errors: string[];
}

export interface RuntimePrivilegesState {
  /** Marker corrective sudah ada di schema_migrations */
  markerExists: boolean;
  /** Marker utama pos_order_update_v1 ada di schema_migrations */
  primaryMarkerExists: boolean;
  /** Tabel schema_migrations ada */
  schemaMigrationsExists: boolean;
  /** Role oak_app ada */
  roleExists: boolean;
  /** Tabel pos_order_edit_requests ada */
  tableExists: boolean;
  /** Sequence pos_order_edit_requests_id_seq ada */
  sequenceExists: boolean;
  /** Tabel pos_orders ada */
  posOrdersExists: boolean;
  /** Privileges table pos_order_edit_requests */
  hasSelect: boolean;
  hasInsert: boolean;
  /** Privileges sequence pos_order_edit_requests_id_seq */
  hasSeqUsage: boolean;
  hasSeqSelect: boolean;
  /** Privileges table pos_orders */
  posOrdersHasSelect: boolean;
  posOrdersHasUpdate: boolean;
  /** Daftar objek atau peran yang tidak ditemukan */
  missingObjects: string[];
}

/**
 * Pre-condition check:
 *   - role oak_app ada di pg_roles
 *   - tabel schema_migrations ada
 *   - tabel pos_orders ada
 *   - tabel pos_order_edit_requests ada
 *   - sequence pos_order_edit_requests_id_seq ada
 *   - marker utama DDL (pos_order_update_v1) ada di schema_migrations
 *
 * TOCTOU-safety:
 *   Wajib dipanggil di dalam transaksi yang telah mengunci advisory lock,
 *   atau transaksi READ ONLY untuk mode --check.
 */
export async function checkPrivilegesPrerequisites(
  client: PoolClient
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  // 1. Role oak_app
  const roleR = await client.query(
    'SELECT 1 FROM pg_roles WHERE rolname = $1',
    [ROLE]
  );
  if ((roleR.rowCount ?? 0) === 0) {
    errors.push(`Role '${ROLE}' tidak ditemukan (pg_roles).`);
  }

  // 2. Tabel schema_migrations
  const smR = await client.query(
    `SELECT c.oid FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'schema_migrations'
       AND c.relkind IN ('r','p')`
  );
  if ((smR.rowCount ?? 0) === 0) {
    errors.push("Tabel public.schema_migrations tidak ditemukan.");
    // Bila schema_migrations tidak ada, pemeriksaan marker tidak dapat dilakukan
    return { ok: false, errors };
  }

  // 3. Tabel pos_orders
  const ordersR = await client.query(
    `SELECT c.oid FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = $1
       AND c.relkind IN ('r','p')`,
    [TABLE_POS_ORDERS]
  );
  if ((ordersR.rowCount ?? 0) === 0) {
    errors.push(`Tabel public.${TABLE_POS_ORDERS} tidak ditemukan (pg_class, relkind r/p).`);
  }

  // 4. Tabel pos_order_edit_requests
  const tblR = await client.query(
    `SELECT c.oid FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = $1
       AND c.relkind IN ('r','p')`,
    [TABLE_EDIT_REQUESTS]
  );
  if ((tblR.rowCount ?? 0) === 0) {
    errors.push(`Tabel public.${TABLE_EDIT_REQUESTS} tidak ditemukan (pg_class, relkind r/p).`);
  }

  // 5. Sequence pos_order_edit_requests_id_seq
  const seqR = await client.query(
    `SELECT c.oid FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = $1
       AND c.relkind = 'S'`,
    [SEQUENCE_EDIT_REQUESTS]
  );
  if ((seqR.rowCount ?? 0) === 0) {
    errors.push(`Sequence public.${SEQUENCE_EDIT_REQUESTS} tidak ditemukan (pg_class, relkind S).`);
  }

  // 6. Marker utama DDL pos_order_update_v1
  const primaryMarkerR = await client.query(
    'SELECT 1 FROM schema_migrations WHERE version = $1',
    [PRIMARY_MARKER]
  );
  if ((primaryMarkerR.rowCount ?? 0) === 0) {
    errors.push(
      `Marker utama '${PRIMARY_MARKER}' tidak ada di schema_migrations. ` +
      `Terapkan DDL utama pos_order_update_v1 terlebih dahulu — ` +
      `corrective runtime privileges tidak akan berjalan tanpa DDL utama.`
    );
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Status efektif privileges saat ini (dipakai --check dan --apply).
 *
 * Keamanan Anti-Exception:
 *   has_table_privilege dan has_sequence_privilege akan memicu PostgreSQL exception
 *   apabila role atau tabel/sequence target belum ada di database.
 *   Fungsi ini memverifikasi keberadaan entitas terlebih dahulu. Jika tidak ada,
 *   ditandai false dan dicatat ke `missingObjects` tanpa throw exception.
 */
export async function inspectPrivilegesState(
  client: PoolClient
): Promise<RuntimePrivilegesState> {
  const missingObjects: string[] = [];

  // 1. Cek role
  const roleR = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE]);
  const roleExists = (roleR.rowCount ?? 0) > 0;
  if (!roleExists) {
    missingObjects.push(`Role '${ROLE}'`);
  }

  // 2. Cek schema_migrations
  const smR = await client.query(
    `SELECT c.oid FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'schema_migrations' AND c.relkind IN ('r','p')`
  );
  const schemaMigrationsExists = (smR.rowCount ?? 0) > 0;
  if (!schemaMigrationsExists) {
    missingObjects.push('Table public.schema_migrations');
  }

  let markerExists = false;
  let primaryMarkerExists = false;
  if (schemaMigrationsExists) {
    const markerR = await client.query(
      'SELECT 1 FROM schema_migrations WHERE version = $1',
      [MARKER]
    );
    markerExists = (markerR.rowCount ?? 0) > 0;

    const pmR = await client.query(
      'SELECT 1 FROM schema_migrations WHERE version = $1',
      [PRIMARY_MARKER]
    );
    primaryMarkerExists = (pmR.rowCount ?? 0) > 0;
    if (!primaryMarkerExists) {
      missingObjects.push(`Primary marker '${PRIMARY_MARKER}'`);
    }
  }

  // 3. Cek tabel pos_order_edit_requests
  const tblR = await client.query(
    `SELECT c.oid FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind IN ('r','p')`,
    [TABLE_EDIT_REQUESTS]
  );
  const tableExists = (tblR.rowCount ?? 0) > 0;
  if (!tableExists) {
    missingObjects.push(`Table public.${TABLE_EDIT_REQUESTS}`);
  }

  // 4. Cek sequence pos_order_edit_requests_id_seq
  const seqR = await client.query(
    `SELECT c.oid FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind = 'S'`,
    [SEQUENCE_EDIT_REQUESTS]
  );
  const sequenceExists = (seqR.rowCount ?? 0) > 0;
  if (!sequenceExists) {
    missingObjects.push(`Sequence public.${SEQUENCE_EDIT_REQUESTS}`);
  }

  // 5. Cek tabel pos_orders
  const ordersR = await client.query(
    `SELECT c.oid FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind IN ('r','p')`,
    [TABLE_POS_ORDERS]
  );
  const posOrdersExists = (ordersR.rowCount ?? 0) > 0;
  if (!posOrdersExists) {
    missingObjects.push(`Table public.${TABLE_POS_ORDERS}`);
  }

  // Privileges awal false
  let hasSelect = false;
  let hasInsert = false;
  let hasSeqUsage = false;
  let hasSeqSelect = false;
  let posOrdersHasSelect = false;
  let posOrdersHasUpdate = false;

  // Hanya periksa privilege bila role dan objek terkait memang ada
  if (roleExists && tableExists) {
    const selR = await client.query(
      `SELECT has_table_privilege($1, 'public.${TABLE_EDIT_REQUESTS}', 'SELECT') AS v`,
      [ROLE]
    );
    hasSelect = selR.rows[0]?.v === true;

    const insR = await client.query(
      `SELECT has_table_privilege($1, 'public.${TABLE_EDIT_REQUESTS}', 'INSERT') AS v`,
      [ROLE]
    );
    hasInsert = insR.rows[0]?.v === true;
  }

  if (roleExists && sequenceExists) {
    const seqUseR = await client.query(
      `SELECT has_sequence_privilege($1, 'public.${SEQUENCE_EDIT_REQUESTS}', 'USAGE') AS v`,
      [ROLE]
    );
    hasSeqUsage = seqUseR.rows[0]?.v === true;

    const seqSelR = await client.query(
      `SELECT has_sequence_privilege($1, 'public.${SEQUENCE_EDIT_REQUESTS}', 'SELECT') AS v`,
      [ROLE]
    );
    hasSeqSelect = seqSelR.rows[0]?.v === true;
  }

  if (roleExists && posOrdersExists) {
    const ordSelR = await client.query(
      `SELECT has_table_privilege($1, 'public.${TABLE_POS_ORDERS}', 'SELECT') AS v`,
      [ROLE]
    );
    posOrdersHasSelect = ordSelR.rows[0]?.v === true;

    const ordUpdR = await client.query(
      `SELECT has_table_privilege($1, 'public.${TABLE_POS_ORDERS}', 'UPDATE') AS v`,
      [ROLE]
    );
    posOrdersHasUpdate = ordUpdR.rows[0]?.v === true;
  }

  return {
    markerExists,
    primaryMarkerExists,
    schemaMigrationsExists,
    roleExists,
    tableExists,
    sequenceExists,
    posOrdersExists,
    hasSelect,
    hasInsert,
    hasSeqUsage,
    hasSeqSelect,
    posOrdersHasSelect,
    posOrdersHasUpdate,
    missingObjects,
  };
}

/**
 * Apakah seluruh privileges minimum untuk operasi POS order edit requests sudah terpenuhi:
 *   - pos_order_edit_requests: SELECT, INSERT
 *   - pos_order_edit_requests_id_seq: USAGE, SELECT
 *   - pos_orders: SELECT, UPDATE
 */
export function privilegesComplete(s: RuntimePrivilegesState): boolean {
  return (
    s.hasSelect &&
    s.hasInsert &&
    s.hasSeqUsage &&
    s.hasSeqSelect &&
    s.posOrdersHasSelect &&
    s.posOrdersHasUpdate
  );
}

/**
 * Jalankan corrective migration. Transactional + advisory lock.
 *
 * Alur (fail-closed, TOCTOU-safe):
 *   1. client = pool.connect()
 *   2. BEGIN
 *   3. pg_advisory_xact_lock(hashtext('oak_hims_schema_migrations_lock'))
 *   4. checkPrivilegesPrerequisites() di dalam transaksi
 *      -> Gagal: ROLLBACK, return 'prerequisite-failed'
 *   5. marker corrective check:
 *      - Bila sudah ada: inspectPrivilegesState()
 *        - Lengkap -> COMMIT, return 'already-applied'
 *        - Belum lengkap -> ROLLBACK, return 'error' (MARKER_EXISTS_BUT_PRIVILEGES_INCOMPLETE)
 *      - Bila belum ada:
 *        - GRANT SELECT, INSERT ON TABLE public.pos_order_edit_requests TO oak_app
 *        - GRANT USAGE, SELECT ON SEQUENCE public.pos_order_edit_requests_id_seq TO oak_app
 *        - GRANT UPDATE ON TABLE public.pos_orders TO oak_app (hanya bila belum ada)
 *        - GRANT SELECT ON TABLE public.pos_orders TO oak_app (hanya bila belum ada)
 *        - INSERT INTO schema_migrations (version) VALUES (MARKER) ON CONFLICT DO NOTHING
 *        - Verifikasi marker tercatat
 *        - Verifikasi privilegesComplete() efektif
 *        - COMMIT, return 'applied'
 */
export async function runPosOrderEditRequestsRuntimePrivilegesMigration(
  pool: Pool
): Promise<RuntimePrivilegesResult> {
  let client: PoolClient | null = null;
  let txnActive = false;
  let discardClient = false;

  let result: RuntimePrivilegesResult = {
    ok: false,
    applied: false,
    status: 'error',
    errors: [],
  };

  try {
    client = await pool.connect();
  } catch (err: unknown) {
    result.errors.push(`Acquire client gagal: ${(err as Error)?.message || err}`);
    return result;
  }

  try {
    await client.query('BEGIN');
    txnActive = true;

    // Advisory lock sebelum pembacaan/mutasi apapun
    await client.query(ADVISORY_LOCK);

    // Prerequisite check di dalam transaksi (menutup celah TOCTOU)
    const prereq = await checkPrivilegesPrerequisites(client);
    if (!prereq.ok) {
      result = {
        ok: false,
        applied: false,
        status: 'prerequisite-failed',
        errors: [...prereq.errors],
      };
      return result;
    }

    const markerCheck = await client.query(
      'SELECT 1 FROM schema_migrations WHERE version = $1',
      [MARKER]
    );
    const markerExists = (markerCheck.rowCount ?? 0) > 0;

    if (markerExists) {
      // ALREADY-APPLIED: verifikasi state privileges masih utuh
      const state = await inspectPrivilegesState(client);
      if (!privilegesComplete(state)) {
        const missing: string[] = [];
        if (!state.hasSelect) missing.push('pos_order_edit_requests:SELECT');
        if (!state.hasInsert) missing.push('pos_order_edit_requests:INSERT');
        if (!state.hasSeqUsage) missing.push('pos_order_edit_requests_id_seq:USAGE');
        if (!state.hasSeqSelect) missing.push('pos_order_edit_requests_id_seq:SELECT');
        if (!state.posOrdersHasSelect) missing.push('pos_orders:SELECT');
        if (!state.posOrdersHasUpdate) missing.push('pos_orders:UPDATE');

        result = {
          ok: false,
          applied: false,
          status: 'error',
          errors: [
            `MARKER_EXISTS_BUT_PRIVILEGES_INCOMPLETE: marker '${MARKER}' ada tetapi privilege hilang [${missing.join(', ')}]. ` +
            `Diagnosis manual diperlukan (privilege di-revoke setelah marker ditulis, atau marker ditulis tanpa GRANT).`
          ],
        };
        return result;
      }

      await client.query('COMMIT');
      txnActive = false;
      result = { ok: true, applied: false, status: 'already-applied', errors: [] };
      return result;
    }

    // Jalur APPLIED:
    // 1. Grant SELECT, INSERT pada pos_order_edit_requests
    await client.query(
      `GRANT SELECT, INSERT
       ON TABLE public.${TABLE_EDIT_REQUESTS}
       TO ${ROLE}`
    );

    // 2. Grant USAGE, SELECT pada sequence pos_order_edit_requests_id_seq
    await client.query(
      `GRANT USAGE, SELECT
       ON SEQUENCE public.${SEQUENCE_EDIT_REQUESTS}
       TO ${ROLE}`
    );

    // 3. Cek apakah UPDATE pada pos_orders diperlukan
    const currentOrdersUpdate = await client.query(
      `SELECT has_table_privilege($1, 'public.${TABLE_POS_ORDERS}', 'UPDATE') AS v`,
      [ROLE]
    );
    if (currentOrdersUpdate.rows[0]?.v !== true) {
      await client.query(
        `GRANT UPDATE
         ON TABLE public.${TABLE_POS_ORDERS}
         TO ${ROLE}`
      );
    }

    // 4. Cek apakah SELECT pada pos_orders diperlukan (guard tambahan)
    const currentOrdersSelect = await client.query(
      `SELECT has_table_privilege($1, 'public.${TABLE_POS_ORDERS}', 'SELECT') AS v`,
      [ROLE]
    );
    if (currentOrdersSelect.rows[0]?.v !== true) {
      await client.query(
        `GRANT SELECT
         ON TABLE public.${TABLE_POS_ORDERS}
         TO ${ROLE}`
      );
    }

    // 5. Marker hanya ditulis SETELAH seluruh GRANT sukses
    await client.query(
      `INSERT INTO schema_migrations (version)
       VALUES ($1)
       ON CONFLICT (version) DO NOTHING`,
      [MARKER]
    );

    // 6. Verifikasi marker benar-benar tercatat SETELAH INSERT
    const markerVerify = await client.query(
      'SELECT 1 FROM schema_migrations WHERE version = $1',
      [MARKER]
    );
    if ((markerVerify.rowCount ?? 0) === 0) {
      result = {
        ok: false,
        applied: false,
        status: 'error',
        errors: [`Marker '${MARKER}' gagal diverifikasi setelah INSERT — transaksi di-ROLLBACK.`],
      };
      return result;
    }

    // 7. Verifikasi privileges efektif setelah GRANT (fail-closed)
    const afterState = await inspectPrivilegesState(client);
    if (!privilegesComplete(afterState)) {
      result = {
        ok: false,
        applied: false,
        status: 'error',
        errors: [
          'GRANT dijalankan tetapi verifikasi has_*_privilege gagal setelahnya — ' +
          'transaksi di-ROLLBACK untuk menjaga konsistensi marker/privilege.'
        ],
      };
      return result;
    }

    await client.query('COMMIT');
    txnActive = false;

    result = { ok: true, applied: true, status: 'applied', errors: [] };
    return result;
  } catch (err: unknown) {
    result = {
      ok: false,
      applied: false,
      status: 'error',
      errors: [`Exception: ${(err as Error)?.message || err}`],
    };
    return result;
  } finally {
    if (txnActive) {
      try {
        await client!.query('ROLLBACK');
        txnActive = false;
      } catch (err: unknown) {
        discardClient = true;
        result.ok = false;
        result.status = 'error';
        result.errors.push(`ROLLBACK gagal: ${(err as Error)?.message || err}`);
      }
    }
    try {
      client!.release(discardClient);
    } catch (err: unknown) {
      result.ok = false;
      result.status = 'error';
      result.errors.push(`Release client gagal: ${(err as Error)?.message || err}`);
    }
  }
}

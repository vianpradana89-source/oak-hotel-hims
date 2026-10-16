/**
 * POS COMMUNICATION SETTINGS — CORRECTIVE RUNTIME PRIVILEGES v1
 * (marker: pos_communication_settings_runtime_privileges_v1)
 *
 * ROOT CAUSE yang diperbaiki:
 *   Migration utama pos_communication_settings_v1 dijalankan sebagai
 *   superuser/owner (postgres). Runtime Cloud Run memakai role `oak_app`,
 *   sehingga endpoint /api/pos/communication-settings gagal dengan
 *   "permission denied for table property_pos_communication_settings".
 *
 * Kebijakan corrective (pola resmi repo — grant eksplisit minimum ke role
 * runtime, marker terpisah, marker hanya ditulis SETELAH GRANT sukses):
 *   GRANT SELECT, INSERT, UPDATE
 *   ON TABLE public.property_pos_communication_settings
 *   TO oak_app;
 *
 *   GRANT USAGE, SELECT
 *   ON SEQUENCE public.property_pos_communication_settings_id_seq
 *   TO oak_app;
 *
 * Sifat:
 *   - TERPISAH dari DDL utama: TIDAK menjalankan ulang CREATE TABLE utama,
 *     TIDAK mengubah struktur, TIDAK touching DDL pos_communication_settings_v1.
 *   - Additive: hanya GRANT minimum (tanpa DELETE, tanpa ALL, tanpa
 *     ALTER OWNER, tanpa ALTER DEFAULT PRIVILEGES, tanpa ubah objek lain).
 *   - Idempotent: GRANT dapat diulang tanpa efek; marker ON CONFLICT DO NOTHING.
 *   - Fail-closed: precondition (role oak_app, tabel, sequence, tabel
 *     schema_migrations, marker utama DDL sudah ada) diverifikasi SEBELUM
 *     mutasi; marker corrective TIDAK ditulis jika precondition gagal.
 *   - Transactional + advisory lock mengikuti pola migration repo
 *     (pg_advisory_xact_lock pada kunci shared schema_migrations).
 *
 * Prerequisite:
 *   - Marker utama 'pos_communication_settings_v1' HARUS sudah ada di
 *     schema_migrations (DDL utama sudah diterapkan). Jika tidak, corrective
 *     GAGAL eksplis (status 'prerequisite-failed') — bukan menebak/menjalankan
 *     DDL utama di sini.
 *
 * Gunakan via runner CLI (bukan auto-run saat startup):
 *   node backend/scripts/run_pos_communication_settings_runtime_privileges_migration.js --apply
 *   runner staging:
 *   node backend/scripts/run_pos_communication_settings_runtime_privileges_migration_staging.js --check
 *   node backend/scripts/run_pos_communication_settings_runtime_privileges_migration_staging.js --apply
 */

import { Pool, PoolClient } from 'pg';

const MARKER = 'pos_communication_settings_runtime_privileges_v1';
const PRIMARY_MARKER = 'pos_communication_settings_v1';

const TABLE = 'property_pos_communication_settings';
const SEQUENCE = 'property_pos_communication_settings_id_seq';
const ROLE = 'oak_app';

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
  /** Marker corrective sudah ada di schema_migrations. */
  markerExists: boolean;
  /** Role oak_app ada. */
  roleExists: boolean;
  /** Tabel target ada. */
  tableExists: boolean;
  /** Sequence identity ada. */
  sequenceExists: boolean;
  /** Privileges table (SELECT) sudah diberikan ke oak_app. */
  hasSelect: boolean;
  hasInsert: boolean;
  hasUpdate: boolean;
  /** Privileges sequence (USAGE, SELECT) sudah diberikan ke oak_app. */
  hasSeqUsage: boolean;
  hasSeqSelect: boolean;
}

/**
 * Pre-condition check:
 *   - role oak_app ada
 *   - tabel target ada
 *   - sequence identity ada
 *   - marker utama DDL (pos_communication_settings_v1) ada di schema_migrations
 *
 * PENTING (TOCTOU-safety):
 *   Fungsi ini HANYA boleh dipanggil DI DALAM transaksi yang telah
 *   mengunci advisory lock, ATAU di transaksi READ ONLY terpisah.
 *   Panggilan di luar transaksi (mis. sebelum BEGIN) hanya aman untuk
 *   --check, tidak untuk jalur --apply karena ada celah TOCTOU antara
 *   prerequisite check dan advisory lock.
 *
 * Semua memakai pg_catalog (pg_roles, pg_class, pg_namespace) —
 * authoritative, tanpa information_schema (visibility filtering dapat
 * memberi false-negative pada role runner terbatas).
 */
export async function checkPrivilegesPrerequisites(
  client: PoolClient
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  const roleR = await client.query(
    'SELECT 1 FROM pg_roles WHERE rolname = $1',
    [ROLE]
  );
  if ((roleR.rowCount ?? 0) === 0) {
    errors.push(`Role '${ROLE}' tidak ditemukan (pg_roles).`);
  }

  const tblR = await client.query(
    `SELECT c.oid FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = $1
       AND c.relkind IN ('r','p')`,
    [TABLE]
  );
  if ((tblR.rowCount ?? 0) === 0) {
    errors.push(`Tabel public.${TABLE} tidak ditemukan (pg_class, relkind r/p).`);
  }

  const seqR = await client.query(
    `SELECT c.oid FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = $1
       AND c.relkind = 'S'`,
    [SEQUENCE]
  );
  if ((seqR.rowCount ?? 0) === 0) {
    errors.push(`Sequence public.${SEQUENCE} tidak ditemukan (pg_class, relkind S).`);
  }

  // Marker utama DDL: corrective HANYA valid bila DDL utama sudah diterapkan.
  const primaryMarkerR = await client.query(
    'SELECT 1 FROM schema_migrations WHERE version = $1',
    [PRIMARY_MARKER]
  );
  if ((primaryMarkerR.rowCount ?? 0) === 0) {
    errors.push(
      `Marker utama '${PRIMARY_MARKER}' tidak ada di schema_migrations. ` +
      `Terapkan DDL utama pos_communication_settings_v1 terlebih dahulu — ` +
      `corrective privileges tidak akan berjalan tanpa DDL utama.`
    );
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Status efektif privileges saat ini (dipakai --check untuk menentukan
 * READY_TO_APPLY / ALREADY_APPLIED / INVALID_PARTIAL).
 *
 * Authority:
 *   - table:  has_table_privilege('oak_app', '<tbl>', '<priv>')
 *   - seq:    has_sequence_privilege('oak_app', '<seq>', '<priv>')
 * has_*_privilege mengembalikan true hanya bila privilege efektif ada
 * (langsung dari GRANT, atau via membership yang memilikinya).
 */
export async function inspectPrivilegesState(client: PoolClient): Promise<RuntimePrivilegesState> {
  const markerR = await client.query(
    'SELECT 1 FROM schema_migrations WHERE version = $1',
    [MARKER]
  );

  const roleR = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE]);

  const tblR = await client.query(
    `SELECT c.oid FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind IN ('r','p')`,
    [TABLE]
  );

  const seqR = await client.query(
    `SELECT c.oid FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind = 'S'`,
    [SEQUENCE]
  );

  const privChecks: Array<{ key: 'hasSelect' | 'hasInsert' | 'hasUpdate' | 'hasSeqUsage' | 'hasSeqSelect'; sql: string }> = [
    { key: 'hasSelect', sql: `SELECT has_table_privilege($1, 'public.${TABLE}', 'SELECT') AS v` },
    { key: 'hasInsert', sql: `SELECT has_table_privilege($1, 'public.${TABLE}', 'INSERT') AS v` },
    { key: 'hasUpdate', sql: `SELECT has_table_privilege($1, 'public.${TABLE}', 'UPDATE') AS v` },
    { key: 'hasSeqUsage', sql: `SELECT has_sequence_privilege($1, 'public.${SEQUENCE}', 'USAGE') AS v` },
    { key: 'hasSeqSelect', sql: `SELECT has_sequence_privilege($1, 'public.${SEQUENCE}', 'SELECT') AS v` },
  ];

  const state: RuntimePrivilegesState = {
    markerExists: (markerR.rowCount ?? 0) > 0,
    roleExists: (roleR.rowCount ?? 0) > 0,
    tableExists: (tblR.rowCount ?? 0) > 0,
    sequenceExists: (seqR.rowCount ?? 0) > 0,
    hasSelect: false,
    hasInsert: false,
    hasUpdate: false,
    hasSeqUsage: false,
    hasSeqSelect: false,
  };
  for (const c of privChecks) {
    const r = await client.query(c.sql, [ROLE]);
    state[c.key] = r.rows[0]?.v === true;
  }
  return state;
}

/** Apakah semua privileges minimum sudah terpenuhi (idempotency check)? */
export function privilegesComplete(s: RuntimePrivilegesState): boolean {
  return s.hasSelect && s.hasInsert && s.hasUpdate && s.hasSeqUsage && s.hasSeqSelect;
}

/**
 * Jalankan corrective migration. Transactional + advisory lock.
 *
 * Urutan (fail-closed, TOCTOU-safe):
 *   1. pool.connect()
 *   2. BEGIN
 *   3. pg_advisory_xact_lock(hashtext('oak_hims_schema_migrations_lock'))
 *   4. prerequisite checks (role oak_app, tabel, sequence, marker utama)
 *      - diverifikasi DI DALAM transaksi + setelah advisory lock,
 *        sehingga kondisi tidak bisa berubah oleh proses lain sebelum GRANT.
 *      Gagal -> status 'prerequisite-failed', ROLLBACK, TIDAK ada GRANT, TIDAK ada marker.
 *   5. marker corrective check
 *      - jika marker sudah ada (already-applied): verifikasi state privileges;
 *        jika ada yang hilang -> status 'error' (diagnosis manual), ROLLBACK,
 *        TIDAK menimpa/merawat secara diam-diam.
 *      - jika marker belum ada: GRANT + marker dalam satu transaksi.
 *   6. marker hanya ditulis SETELAH semua GRANT sukses (INSERT + verifikasi).
 *   7. Verifikasi privileges efektif setelah GRANT (fail-closed).
 *   8. COMMIT
 */
export async function runPosCommunicationSettingsRuntimePrivilegesMigration(
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

    // Advisory lock DULU, sebelum apa pun yang membaca/memutasi.
    await client.query(ADVISORY_LOCK);

    // Prerequisite check dilakukan DI DALAM transaksi + setelah advisory lock.
    // Ini menutup celah TOCTOU: kondisi yang divalidasi tidak bisa berubah
    // oleh proses lain sebelum GRANT/marker dijalankan.
    const prereq = await checkPrivilegesPrerequisites(client);
    if (!prereq.ok) {
      result = {
        ok: false,
        applied: false,
        status: 'prerequisite-failed',
        errors: [...prereq.errors],
      };
      // ROLLBACK via finally (txnActive masih true).
      return result;
    }

    const markerCheck = await client.query(
      'SELECT 1 FROM schema_migrations WHERE version = $1',
      [MARKER]
    );
    const markerExists = (markerCheck.rowCount ?? 0) > 0;

    if (markerExists) {
      // ALREADY-APPLIED: verifikasi state privileges masih utuh.
      const state = await inspectPrivilegesState(client);
      if (!privilegesComplete(state)) {
        const missing: string[] = [];
        if (!state.hasSelect) missing.push('TABLE:SELECT');
        if (!state.hasInsert) missing.push('TABLE:INSERT');
        if (!state.hasUpdate) missing.push('TABLE:UPDATE');
        if (!state.hasSeqUsage) missing.push('SEQ:USAGE');
        if (!state.hasSeqSelect) missing.push('SEQ:SELECT');
        result = {
          ok: false,
          applied: false,
          status: 'error',
          errors: [
            `MARKER_EXISTS_BUT_PRIVILEGES_INCOMPLETE: marker '${MARKER}' ada tetapi privilege hilang [${missing.join(', ')}]. ` +
            `Diagnosis manual diperlukan (privilege di-revoke setelah marker ditulis, atau marker ditulis tanpa GRANT).`
          ],
        };
        // ROLLBACK via finally (txnActive masih true).
        return result;
      }

      await client.query('COMMIT');
      txnActive = false;
      result = { ok: true, applied: false, status: 'already-applied', errors: [] };
      return result;
    }

    // Jalur APPLIED: marker belum ada: GRANT + marker dalam satu transaksi.
    await client.query(
      `GRANT SELECT, INSERT, UPDATE
       ON TABLE public.${TABLE}
       TO ${ROLE}`
    );
    await client.query(
      `GRANT USAGE, SELECT
       ON SEQUENCE public.${SEQUENCE}
       TO ${ROLE}`
    );

    // Marker hanya ditulis SETELAH semua GRANT sukses.
    await client.query(
      `INSERT INTO schema_migrations (version)
       VALUES ($1)
       ON CONFLICT (version) DO NOTHING`,
      [MARKER]
    );

    // Verifikasi marker benar-benar tercatat SETELAH INSERT.
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

    // Verifikasi privileges efektif setelah GRANT (fail-closed).
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

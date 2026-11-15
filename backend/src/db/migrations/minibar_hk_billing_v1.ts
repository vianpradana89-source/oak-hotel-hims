/**
 * MINIBAR HK → FO → FOLIO — Tahap A: Foundation
 * DDL Authoritative: satu-satunya sumber skema untuk fitur minibar.
 *
 * Kontrak:
 * - Tidak mengubah schema_v3.ts, index.ts, stayCharges, atau file lain.
 * - Migration transactional dengan advisory lock (pola repo:
 *   `SELECT pg_advisory_xact_lock(hashtext('oak_hims_schema_migrations_lock'))`).
 * - Marker: `minibar_hk_billing_v1` pada `schema_migrations`.
 * - Verifikasi schema SEBELUM dan SETELAH marker (mismatch → gagal eksplisit).
 * - Idempoten: jika marker ada dan schema sesuai → skip DDL, status 'already-applied'.
 *
 * Gunakan via runner CLI:
 *   node backend/scripts/run_minibar_migration.js
 * dengan MIGRATION_DATABASE_URL eksplisit.
 */

import { Pool, PoolClient } from 'pg';

const MARKER = 'minibar_hk_billing_v1';

// =============================================================================
// DDL — semua statement dalam satu string; dieksekusi berurutan dalam 1 transaksi
// =============================================================================

export const MINIBAR_DDL = `
-- T1: Standar minibar per room type per property
CREATE TABLE IF NOT EXISTS room_type_minibar_standard (
  id            SERIAL PRIMARY KEY,
  property_id   INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  room_type_id  INTEGER NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
  menu_item_id  INTEGER NOT NULL REFERENCES pos_menu_items(id) ON DELETE RESTRICT,
  standard_qty  INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_room_type_minibar_standard UNIQUE (property_id, room_type_id, menu_item_id),
  CONSTRAINT ck_rt_minibar_std_qty CHECK (standard_qty >= 0)
);
CREATE INDEX IF NOT EXISTS idx_rt_minibar_std_property ON room_type_minibar_standard (property_id);
CREATE INDEX IF NOT EXISTS idx_rt_minibar_std_room_type ON room_type_minibar_standard (room_type_id);

-- T2: Baseline verification (baris baru per verifikasi; anchor lama tidak ditimpa)
CREATE TABLE IF NOT EXISTS minibar_baseline_verification (
  id                SERIAL PRIMARY KEY,
  property_id       INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  reservation_id    INTEGER NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
  room_id           INTEGER NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  menu_item_id      INTEGER NOT NULL REFERENCES pos_menu_items(id) ON DELETE RESTRICT,
  verified_qty      INTEGER NOT NULL,
  source_type       VARCHAR(30) NOT NULL,
  source_id         INTEGER NOT NULL,
  verified_by       VARCHAR(150),
  verified_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes             TEXT,
  CONSTRAINT ck_mb_baseline_qty CHECK (verified_qty >= 0),
  CONSTRAINT ck_mb_baseline_source_type CHECK (source_type IN ('EXPLICIT_CHECKIN','MANUAL_VERIFICATION','EXPLICIT_RESTOCK'))
);
CREATE INDEX IF NOT EXISTS idx_mb_baseline_scope ON minibar_baseline_verification (property_id, reservation_id, room_id, menu_item_id, id);
CREATE INDEX IF NOT EXISTS idx_mb_baseline_res ON minibar_baseline_verification (reservation_id);
CREATE INDEX IF NOT EXISTS idx_mb_baseline_prop ON minibar_baseline_verification (property_id);

-- T3: Event stay (append-only, scope 4 kolom)
CREATE TABLE IF NOT EXISTS minibar_stay_event (
  id              SERIAL PRIMARY KEY,
  property_id     INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  reservation_id  INTEGER NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
  room_id         INTEGER NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  menu_item_id    INTEGER NOT NULL REFERENCES pos_menu_items(id) ON DELETE RESTRICT,
  event_type      VARCHAR(30) NOT NULL,
  quantity_delta  INTEGER NOT NULL,
  source_type     VARCHAR(30) NOT NULL,
  source_id       INTEGER NOT NULL,
  event_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_minibar_stay_event UNIQUE (property_id, reservation_id, room_id, menu_item_id, event_type, source_type, source_id),
  CONSTRAINT ck_mb_event_source_type CHECK (source_type IN ('REPORT','RESTOCK','VERIFICATION')),
  CONSTRAINT ck_mb_event_type CHECK (event_type IN (
    'EXPLICIT_CHECKIN','ADDED_TO_ROOM','REMOVED_FROM_ROOM','DAMAGED_RECORDED',
    'LOST_RECORDED','CONSUMPTION_CONFIRMED','CORRECTION_RECORDED','INSPECTION_SNAPSHOT'
  )),
  CONSTRAINT ck_mb_event_delta_sign CHECK (
    (event_type = 'ADDED_TO_ROOM' AND quantity_delta > 0)
    OR (event_type IN ('REMOVED_FROM_ROOM','DAMAGED_RECORDED','LOST_RECORDED','CONSUMPTION_CONFIRMED') AND quantity_delta < 0)
    OR (event_type IN ('INSPECTION_SNAPSHOT','EXPLICIT_CHECKIN') AND quantity_delta = 0)
    OR (event_type = 'CORRECTION_RECORDED' AND quantity_delta <> 0)
  )
);
CREATE INDEX IF NOT EXISTS idx_mb_stay_event_scope ON minibar_stay_event (property_id, reservation_id, room_id, menu_item_id, id);
CREATE INDEX IF NOT EXISTS idx_mb_stay_event_source ON minibar_stay_event (source_type, source_id);

-- T4: Inspection report (header per stay per property)
CREATE TABLE IF NOT EXISTS minibar_inspection_report (
  id               SERIAL PRIMARY KEY,
  property_id      INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  reservation_id   INTEGER NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
  room_id          INTEGER NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  task_id          INTEGER NOT NULL REFERENCES housekeeping_tasks(id) ON DELETE RESTRICT,
  hk_user_id       VARCHAR(100),
  hk_user_name     VARCHAR(150),
  status           VARCHAR(20) NOT NULL DEFAULT 'DRAFT',   -- 'DRAFT' | 'SUBMITTED' | 'SUPERSEDED'
  submitted_at     TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_minibar_inspection_report UNIQUE (task_id),
  CHECK (status IN ('DRAFT','SUBMITTED','SUPERSEDED'))
);
CREATE INDEX IF NOT EXISTS idx_mb_report_prop ON minibar_inspection_report (property_id, status);
CREATE INDEX IF NOT EXISTS idx_mb_report_res ON minibar_inspection_report (reservation_id);

-- T5: Inspection report line (per menu item per report)
CREATE TABLE IF NOT EXISTS minibar_inspection_report_line (
  id                 SERIAL PRIMARY KEY,
  report_id          INTEGER NOT NULL REFERENCES minibar_inspection_report(id) ON DELETE RESTRICT,
  property_id        INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  menu_item_id       INTEGER NOT NULL REFERENCES pos_menu_items(id) ON DELETE RESTRICT,

  -- Rujukan baseline
  baseline_verification_id INTEGER REFERENCES minibar_baseline_verification(id) ON DELETE RESTRICT,
  baseline_status        VARCHAR(20) NOT NULL,   -- VERIFIED | UNKNOWN | PENDING_VERIFICATION
  baseline_qty           INTEGER,               -- verified_qty pada anchor (snapshot)
  baseline_effective     INTEGER,               -- hasil kalkulasi; NULL bila baseline unknown
  anchor_event_id        INTEGER REFERENCES minibar_stay_event(id) ON DELETE RESTRICT,
  cutoff_event_id        INTEGER REFERENCES minibar_stay_event(id) ON DELETE RESTRICT,

  -- Hitungan fisik & klasifikasi konsumsi
  counted_qty           INTEGER NOT NULL,        -- hitungan fisik (bukan kalkulasi)
  consumed_qty          INTEGER,                 -- NULL bila belum diketahui
  damaged_qty           INTEGER,
  lost_qty              INTEGER,
  correction_qty        INTEGER,
  unresolved_qty        INTEGER,

  -- Surplus
  surplus_qty           INTEGER,
  surplus_status        VARCHAR(20),            -- NONE | UNVERIFIED | VERIFIED

  -- Snapshot harga (wajib terisi sebelum submit; nullable selama DRAFT)
  unit_price_snapshot   NUMERIC(12,2),

  -- Status billing & audit
  billing_status        VARCHAR(20) NOT NULL DEFAULT 'PENDING',  -- PENDING|NOT_BILLED|BILLED|VOIDED|CORRECTED
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_minibar_report_line UNIQUE (report_id, menu_item_id),
  CONSTRAINT ck_mb_line_baseline_status CHECK (baseline_status IN ('VERIFIED','UNKNOWN','PENDING_VERIFICATION')),
  CONSTRAINT ck_mb_line_baseline_qty CHECK (baseline_qty IS NULL OR baseline_qty >= 0),
  CONSTRAINT ck_mb_line_baseline_effective CHECK (baseline_effective IS NULL OR baseline_effective >= 0),
  CONSTRAINT ck_mb_line_counted_qty CHECK (counted_qty >= 0),
  CONSTRAINT ck_mb_line_consumed_qty CHECK (consumed_qty  IS NULL OR consumed_qty  >= 0),
  CONSTRAINT ck_mb_line_damaged_qty  CHECK (damaged_qty   IS NULL OR damaged_qty   >= 0),
  CONSTRAINT ck_mb_line_lost_qty     CHECK (lost_qty      IS NULL OR lost_qty      >= 0),
  CONSTRAINT ck_mb_line_correction_qty CHECK (correction_qty IS NULL OR correction_qty >= 0),
  CONSTRAINT ck_mb_line_unresolved_qty CHECK (unresolved_qty IS NULL OR unresolved_qty >= 0),
  CONSTRAINT ck_mb_line_surplus_qty  CHECK (surplus_qty   IS NULL OR surplus_qty   >= 0),
  CONSTRAINT ck_mb_line_surplus_status CHECK (surplus_status IS NULL OR surplus_status IN ('NONE','UNVERIFIED','VERIFIED')),
  CONSTRAINT ck_mb_line_unit_price CHECK (unit_price_snapshot IS NULL OR unit_price_snapshot >= 0),
  CONSTRAINT ck_mb_line_billing_status CHECK (billing_status IN ('PENDING','NOT_BILLED','BILLED','VOIDED','CORRECTED'))
);
CREATE INDEX IF NOT EXISTS idx_mb_report_line_prop ON minibar_inspection_report_line (property_id, menu_item_id);

-- T6: Billing confirmation (idempotent, UNIQUE per report line)
CREATE TABLE IF NOT EXISTS minibar_billing_confirmation (
  id                   SERIAL PRIMARY KEY,
  property_id          INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  reservation_id       INTEGER NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
  report_line_id       INTEGER NOT NULL REFERENCES minibar_inspection_report_line(id) ON DELETE RESTRICT,

  -- Aktor billing (snapshot; ID mengikuti user existing)
  billing_actor_user_id      VARCHAR(100),
  billing_actor_name_snapshot VARCHAR(150),
  billing_actor_role_snapshot VARCHAR(100),

  -- Qty & nominal terkonfirmasi
  confirmed_consumed_qty INTEGER NOT NULL,
  confirmed_subtotal     NUMERIC(12,2) NOT NULL,
  reduction_reason       TEXT,

  billing_status       VARCHAR(20) NOT NULL DEFAULT 'POSTED',  -- POSTED|NOT_BILLED|VOIDED|CORRECTED

  -- Rujukan folio (nullable selama NOT_BILLED)
  folio_entry_id       INTEGER,
  original_folio_entry_id INTEGER,   -- referensi posting pertama saat folio_entry_id menunjuk replacement
  correction_group_id  VARCHAR(100),

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_minibar_billing_confirmation UNIQUE (property_id, report_line_id),
  CONSTRAINT ck_mb_conf_consumed_qty CHECK (confirmed_consumed_qty >= 0),
  CONSTRAINT ck_mb_conf_subtotal CHECK (confirmed_subtotal >= 0),
  CONSTRAINT ck_mb_conf_billing_status CHECK (billing_status IN ('POSTED','NOT_BILLED','VOIDED','CORRECTED')),
  -- NOT_BILLED: qty=0, subtotal=0, folio & original_folio NULL, alasan tidak kosong
  CONSTRAINT ck_mb_conf_not_billed CHECK (
    billing_status <> 'NOT_BILLED'
    OR (confirmed_consumed_qty = 0 AND confirmed_subtotal = 0
        AND folio_entry_id IS NULL AND original_folio_entry_id IS NULL
        AND reduction_reason IS NOT NULL AND btrim(reduction_reason) <> '')
  ),
  -- POSTED: qty>0, folio & original_folio terisi
  CONSTRAINT ck_mb_conf_posted CHECK (
    billing_status <> 'POSTED'
    OR (confirmed_consumed_qty > 0 AND folio_entry_id IS NOT NULL AND original_folio_entry_id IS NOT NULL)
  ),
  -- VOIDED/CORRECTED: qty>0 dan kedua referensi folio NOT NULL
  CONSTRAINT ck_mb_conf_voided_corrected CHECK (
    billing_status NOT IN ('VOIDED','CORRECTED')
    OR (confirmed_consumed_qty > 0 AND folio_entry_id IS NOT NULL AND original_folio_entry_id IS NOT NULL)
  ),
  -- CORRECTED: correction_group_id tidak NULL/kosong
  CONSTRAINT ck_mb_conf_corrected_group CHECK (
    billing_status <> 'CORRECTED'
    OR (correction_group_id IS NOT NULL AND btrim(correction_group_id) <> '')
  )
);
CREATE INDEX IF NOT EXISTS idx_mb_billing_conf_prop ON minibar_billing_confirmation (property_id, billing_status);
CREATE INDEX IF NOT EXISTS idx_mb_billing_conf_folio ON minibar_billing_confirmation (folio_entry_id);

-- T7: Kolom additive pada folio_entries (two-way nullable)
ALTER TABLE folio_entries
  ADD COLUMN IF NOT EXISTS hk_report_line_id       INTEGER,
  ADD COLUMN IF NOT EXISTS minibar_confirmation_id INTEGER;

-- T8: Constraint FK two-way (idempoten: lewati jika sudah ada)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conname = 'fk_folio_entries_hk_report_line'
      AND c.connamespace = 'public'::regnamespace
      AND c.conrelid = 'public.folio_entries'::regclass
  ) THEN
    ALTER TABLE public.folio_entries
      ADD CONSTRAINT fk_folio_entries_hk_report_line
      FOREIGN KEY (hk_report_line_id)
      REFERENCES public.minibar_inspection_report_line(id) ON DELETE RESTRICT;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conname = 'fk_folio_entries_minibar_confirmation'
      AND c.connamespace = 'public'::regnamespace
      AND c.conrelid = 'public.folio_entries'::regclass
  ) THEN
    ALTER TABLE public.folio_entries
      ADD CONSTRAINT fk_folio_entries_minibar_confirmation
      FOREIGN KEY (minibar_confirmation_id)
      REFERENCES public.minibar_billing_confirmation(id) ON DELETE RESTRICT;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conname = 'fk_minibar_conf_folio'
      AND c.connamespace = 'public'::regnamespace
      AND c.conrelid = 'public.minibar_billing_confirmation'::regclass
  ) THEN
    ALTER TABLE public.minibar_billing_confirmation
      ADD CONSTRAINT fk_minibar_conf_folio
      FOREIGN KEY (folio_entry_id)
      REFERENCES public.folio_entries(id) ON DELETE RESTRICT;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conname = 'fk_minibar_conf_original_folio'
      AND c.connamespace = 'public'::regnamespace
      AND c.conrelid = 'public.minibar_billing_confirmation'::regclass
  ) THEN
    ALTER TABLE public.minibar_billing_confirmation
      ADD CONSTRAINT fk_minibar_conf_original_folio
      FOREIGN KEY (original_folio_entry_id)
      REFERENCES public.folio_entries(id) ON DELETE RESTRICT;
  END IF;
END;
$$;

-- T9: Flag requires_minibar_report pada checklist template item
ALTER TABLE checklist_template_items
  ADD COLUMN IF NOT EXISTS requires_minibar_report BOOLEAN NOT NULL DEFAULT FALSE;

-- T10: Flag requires_minibar_report pada task checklist item (snapshot)
ALTER TABLE housekeeping_task_checklist_items
  ADD COLUMN IF NOT EXISTS requires_minibar_report BOOLEAN NOT NULL DEFAULT FALSE;
`;

// Marker di-INSERT terpisah oleh runner setelah verifikasi, bukan dalam DDL
export const MARKER_SQL = `
  INSERT INTO schema_migrations (version)
  VALUES ('minibar_hk_billing_v1')
  ON CONFLICT (version) DO NOTHING;
`;

// =============================================================================
// Verifikasi Schema
// =============================================================================

export interface VerificationResult {
  ok: boolean;
  errors: string[];
  status: 'applied' | 'already-applied' | 'mismatch';
}

/** Status migration runner (lebih rinci dari VerificationResult.status). */
export type MigrationRunStatus =
  | 'applied'
  | 'already-applied'
  | 'mismatch'
  | 'verification-failed'
  | 'error';

/**
 * Verifikasi semua objek DDL. Dipanggil SEBELUM marker (setelah DDL)
 * dan SETELAH marker (untuk konfirmasi status 'already-applied').
 *
 * Mismatch → ok=false dengan daftar error eksplisit (bukan skip diam-diam).
 */
/**
 * Ekspektasi kolom per tabel (fokus tabel & kolom tahap ini).
 * field: data_type, udt_name, maximum_character_length (VARCHAR),
 *        numeric_precision/numeric_scale (NUMERIC), is_nullable,
 *        column_default (hanya periksa default yang diwajibkan kontrak).
 */
interface ColExpect {
  data_type?: string;
  udt_name?: string;
  varchar_len?: number;
  num_prec?: number;
  num_scale?: number;
  not_null?: boolean;
  /** Default persis yang diwajibkan kontrak (jika null = jangan periksa). */
  expect_default?: string;
}

const TABLE_COLUMNS: Record<string, Record<string, ColExpect>> = {
  // T1
  room_type_minibar_standard: {
    id: { udt_name: 'int4', not_null: true },
    property_id: { udt_name: 'int4', not_null: true },
    room_type_id: { udt_name: 'int4', not_null: true },
    menu_item_id: { udt_name: 'int4', not_null: true },
    standard_qty: { udt_name: 'int4', not_null: true, expect_default: '0' },
    notes: { udt_name: 'text', not_null: false },
    is_active: { udt_name: 'bool', not_null: true, expect_default: 'true' },
    created_at: { udt_name: 'timestamptz', not_null: true, expect_default: 'NOW()' },
    updated_at: { udt_name: 'timestamptz', not_null: true, expect_default: 'NOW()' },
  },
  // T2
  minibar_baseline_verification: {
    id: { udt_name: 'int4', not_null: true },
    property_id: { udt_name: 'int4', not_null: true },
    reservation_id: { udt_name: 'int4', not_null: true },
    room_id: { udt_name: 'int4', not_null: true },
    menu_item_id: { udt_name: 'int4', not_null: true },
    verified_qty: { udt_name: 'int4', not_null: true },
    source_type: { udt_name: 'varchar', varchar_len: 30, not_null: true },
    source_id: { udt_name: 'int4', not_null: true },
    verified_by: { udt_name: 'varchar', varchar_len: 150, not_null: false },
    verified_at: { udt_name: 'timestamptz', not_null: true, expect_default: 'NOW()' },
    notes: { udt_name: 'text', not_null: false },
  },
  // T3
  minibar_stay_event: {
    id: { udt_name: 'int4', not_null: true },
    property_id: { udt_name: 'int4', not_null: true },
    reservation_id: { udt_name: 'int4', not_null: true },
    room_id: { udt_name: 'int4', not_null: true },
    menu_item_id: { udt_name: 'int4', not_null: true },
    event_type: { udt_name: 'varchar', varchar_len: 30, not_null: true },
    quantity_delta: { udt_name: 'int4', not_null: true },
    source_type: { udt_name: 'varchar', varchar_len: 30, not_null: true },
    source_id: { udt_name: 'int4', not_null: true },
    event_at: { udt_name: 'timestamptz', not_null: true, expect_default: 'NOW()' },
    notes: { udt_name: 'text', not_null: false },
    created_at: { udt_name: 'timestamptz', not_null: true, expect_default: 'NOW()' },
  },
  // T4
  minibar_inspection_report: {
    id: { udt_name: 'int4', not_null: true },
    property_id: { udt_name: 'int4', not_null: true },
    reservation_id: { udt_name: 'int4', not_null: true },
    room_id: { udt_name: 'int4', not_null: true },
    task_id: { udt_name: 'int4', not_null: true },
    hk_user_id: { udt_name: 'varchar', varchar_len: 100, not_null: false },
    hk_user_name: { udt_name: 'varchar', varchar_len: 150, not_null: false },
    status: { udt_name: 'varchar', varchar_len: 20, not_null: true, expect_default: "'DRAFT'::character varying" },
    submitted_at: { udt_name: 'timestamptz', not_null: false },
    notes: { udt_name: 'text', not_null: false },
    created_at: { udt_name: 'timestamptz', not_null: true, expect_default: 'NOW()' },
    updated_at: { udt_name: 'timestamptz', not_null: true, expect_default: 'NOW()' },
  },
  // T5
  minibar_inspection_report_line: {
    id: { udt_name: 'int4', not_null: true },
    report_id: { udt_name: 'int4', not_null: true },
    property_id: { udt_name: 'int4', not_null: true },
    menu_item_id: { udt_name: 'int4', not_null: true },
    baseline_verification_id: { udt_name: 'int4', not_null: false },
    baseline_status: { udt_name: 'varchar', varchar_len: 20, not_null: true },
    baseline_qty: { udt_name: 'int4', not_null: false },
    baseline_effective: { udt_name: 'int4', not_null: false },
    anchor_event_id: { udt_name: 'int4', not_null: false },
    cutoff_event_id: { udt_name: 'int4', not_null: false },
    counted_qty: { udt_name: 'int4', not_null: true },
    consumed_qty: { udt_name: 'int4', not_null: false },
    damaged_qty: { udt_name: 'int4', not_null: false },
    lost_qty: { udt_name: 'int4', not_null: false },
    correction_qty: { udt_name: 'int4', not_null: false },
    unresolved_qty: { udt_name: 'int4', not_null: false },
    surplus_qty: { udt_name: 'int4', not_null: false },
    surplus_status: { udt_name: 'varchar', varchar_len: 20, not_null: false },
    unit_price_snapshot: { udt_name: 'numeric', num_prec: 12, num_scale: 2, not_null: false },
    billing_status: { udt_name: 'varchar', varchar_len: 20, not_null: true, expect_default: "'PENDING'::character varying" },
    notes: { udt_name: 'text', not_null: false },
    created_at: { udt_name: 'timestamptz', not_null: true, expect_default: 'NOW()' },
    updated_at: { udt_name: 'timestamptz', not_null: true, expect_default: 'NOW()' },
  },
  // T6
  minibar_billing_confirmation: {
    id: { udt_name: 'int4', not_null: true },
    property_id: { udt_name: 'int4', not_null: true },
    reservation_id: { udt_name: 'int4', not_null: true },
    report_line_id: { udt_name: 'int4', not_null: true },
    billing_actor_user_id: { udt_name: 'varchar', varchar_len: 100, not_null: false },
    billing_actor_name_snapshot: { udt_name: 'varchar', varchar_len: 150, not_null: false },
    billing_actor_role_snapshot: { udt_name: 'varchar', varchar_len: 100, not_null: false },
    confirmed_consumed_qty: { udt_name: 'int4', not_null: true },
    confirmed_subtotal: { udt_name: 'numeric', num_prec: 12, num_scale: 2, not_null: true },
    reduction_reason: { udt_name: 'text', not_null: false },
    billing_status: { udt_name: 'varchar', varchar_len: 20, not_null: true, expect_default: "'POSTED'::character varying" },
    folio_entry_id: { udt_name: 'int4', not_null: false },
    original_folio_entry_id: { udt_name: 'int4', not_null: false },
    correction_group_id: { udt_name: 'varchar', varchar_len: 100, not_null: false },
    created_at: { udt_name: 'timestamptz', not_null: true, expect_default: 'NOW()' },
    updated_at: { udt_name: 'timestamptz', not_null: true, expect_default: 'NOW()' },
  },
  // T7 (kolom additive folio_entries)
  folio_entries: {
    hk_report_line_id: { udt_name: 'int4', not_null: false },
    minibar_confirmation_id: { udt_name: 'int4', not_null: false },
  },
  // T9
  checklist_template_items: {
    requires_minibar_report: { udt_name: 'bool', not_null: true, expect_default: 'false' },
  },
  // T10
  housekeeping_task_checklist_items: {
    requires_minibar_report: { udt_name: 'bool', not_null: true, expect_default: 'false' },
  },
};

async function verifyTableColumns(
  client: PoolClient,
  tableName: string,
  expected: Record<string, ColExpect>,
  errors: string[],
): Promise<void> {
  const r = await client.query(
    `SELECT column_name, data_type, udt_name,
            character_maximum_length,
            numeric_precision, numeric_scale,
            is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName],
  );

  // Kumpulan kolom eksisting
  const existing: Record<string, any> = {};
  for (const row of r.rows) {
    existing[row.column_name] = row;
  }

  for (const colName of Object.keys(expected)) {
    const exp = expected[colName];
    const row = existing[colName];
    if (!row) {
      errors.push(`Kolom ${tableName}.${colName} tidak ada`);
      continue;
    }
    // tipe
    if (exp.data_type && row.data_type !== exp.data_type) {
      errors.push(`Kolom ${tableName}.${colName} tipe ${row.data_type} != ${exp.data_type}`);
    }
    if (exp.udt_name && row.udt_name !== exp.udt_name) {
      errors.push(`Kolom ${tableName}.${colName} udt ${row.udt_name} != ${exp.udt_name}`);
    }
    // panjang VARCHAR
    if (exp.varchar_len !== undefined && row.character_maximum_length !== exp.varchar_len) {
      errors.push(
        `Kolom ${tableName}.${colName} panjang VARCHAR ${row.character_maximum_length} != ${exp.varchar_len}`,
      );
    }
    // precision/scale NUMERIC
    if (exp.num_prec !== undefined && Number(row.numeric_precision) !== exp.num_prec) {
      errors.push(
        `Kolom ${tableName}.${colName} precision ${row.numeric_precision} != ${exp.num_prec}`,
      );
    }
    if (exp.num_scale !== undefined && Number(row.numeric_scale) !== exp.num_scale) {
      errors.push(`Kolom ${tableName}.${colName} scale ${row.numeric_scale} != ${exp.num_scale}`);
    }
    // nullability: NOT NULL dan nullable dibandingkan dua arah.
    // exp.not_null === undefined → nullability tidak di-spekifikasi; lewati.
    if (exp.not_null === true && row.is_nullable !== 'NO') {
      errors.push(`Kolom ${tableName}.${colName} harus NOT NULL (actual nullable: ${row.is_nullable})`);
    } else if (exp.not_null === false && row.is_nullable !== 'YES') {
      errors.push(`Kolom ${tableName}.${colName} harus nullable (actual NOT NULL)`);
    }
    // default yang diwajibkan (normalisasi: strip ::type cast, normalisasi timestamp)
    if (exp.expect_default !== undefined) {
      let actual: string = String(row.column_default ?? '');
      actual = actual.replace(/::[a-z_ ]+$/i, '').trim(); // buang cast ::type
      let want = exp.expect_default;
      want = want.replace(/::[a-z_ ]+$/i, '').trim();
      // Ekuivalen timestamp default: now() / CURRENT_TIMESTAMP
      const tsNorm = (s: string) =>
        s.toLowerCase() === 'now()' || s.toLowerCase() === 'current_timestamp' ? '__TS_NOW__' : s;
      if (tsNorm(actual) !== tsNorm(want)) {
        errors.push(
          `Kolom ${tableName}.${colName} default '${actual}' != '${want}'`,
        );
      }
    }
  }
}


/**
 * Muat definisi constraint milik SATU tabel (schema public) dari katalog PG:
 * contype, conname, kolom terurut, convalidated, dan (untuk FK) tujuan FK:
 * tabel/kolom target + aturan ON DELETE (berdasarkan definisi, bukan nama).
 * Tabel tidak ada → hasil kosong (mismatch terkendali, tanpa cast regclass).
 */
interface LoadedConstraint {
  contype: string;
  conname: string;
  columns: string[];
  convalidated: boolean;
  /** FK only */
  refTable: string | null;
  refColumns: string[];
  /** 'r'=RESTRICT, 'a'=NO ACTION, 'c'=CASCADE, 'n'=SET NULL, 'd'=SET DEFAULT */
  refDeleteAction: string;
  /** Definisi CHECK aktual (pg_get_constraintdef), kosong bila bukan CHECK */
  checkDef: string;
  /** OID constraint (c.oid), 0 bila tidak tersedia */
  conoid: number;
  /**
   * Representasi CHECK via `pg_get_expr(c.conbin, c.conrelid, false)` —
   * string persis yang dihasilkan deparser PostgreSQL (tanpa prefix
   * "CONSTRAINT <nama> CHECK"). Kosong bila bukan contype='c'.
   * Dipakai perbandingan exact dengan hasil `materializeExpectedCheckExprs`.
   */
  checkExpr: string;
}
async function loadTableConstraints(
  client: PoolClient,
  tableName: string,
): Promise<LoadedConstraint[]> {
  const r = await client.query(
    `SELECT c.conname, c.contype, c.convalidated,
            c.oid AS con_oid,
            ARRAY(
              SELECT a.attname
              FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a
                ON a.attrelid = c.conrelid AND a.attnum = k.attnum
              ORDER BY k.ord
            ) AS columns,
            CASE c.contype
              WHEN 'f' THEN (
                SELECT ns.nspname || '.' || rc.relname
                FROM pg_class rc
                JOIN pg_namespace ns ON ns.oid = rc.relnamespace
                WHERE rc.oid = c.confrelid
              )
              ELSE NULL
            END AS ref_table,
            CASE c.contype
              WHEN 'f' THEN ARRAY(
                SELECT a.attname
                FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a
                  ON a.attrelid = c.confrelid AND a.attnum = k.attnum
                ORDER BY k.ord
              )
              ELSE ARRAY[]::text[]
            END AS ref_columns,
            CASE c.contype
              WHEN 'f' THEN c.confdeltype
              ELSE ' '
            END AS ref_delete_action,
            CASE c.contype
              WHEN 'c' THEN pg_get_constraintdef(c.oid)
              ELSE ''
            END AS check_def,
            CASE c.contype
              WHEN 'c' THEN pg_get_expr(c.conbin, c.conrelid, false)
              ELSE ''
            END AS check_expr
       FROM pg_constraint c
      WHERE c.conrelid = (
        SELECT cl.oid FROM pg_class cl
        WHERE cl.relname = $1
          AND cl.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
      )`,
    [tableName],
  );
  return r.rows.map((row: any) => ({
    contype: row.contype,
    conname: row.conname,
    convalidated: row.convalidated,
    refTable: row.ref_table ?? null,
    refDeleteAction: row.ref_delete_action ?? ' ',
    checkDef: row.check_def ?? '',
    conoid: Number(row.con_oid ?? 0),
    checkExpr: row.check_expr ?? '',
    // Kolom dari PG array → JS array (parsePgArray defensif)
    columns: parsePgArray(row.columns ?? []),
    refColumns: parsePgArray(row.ref_columns ?? []),
  }));
}

/**
 * Perbarui ekspresi CHECK "expected" menjadi representasi kanonik PostgreSQL
 * via `pg_get_expr(conbin, conrelid, false)` pada tabel REFERENSI sementara
 * (TEMP) yang dibuat khusus untuk pemanggilan ini.
 *
 * Tidak ada normalisasi buatan (tanpa strip cast / kurung / ANY↔IN / regex).
 * Representasi yang dikembalikan ADALAH output deparser PostgreSQL atas
 * constraint yang SAMA persis (tipe kolom) seperti yang tersimpan pada
 * tabel bisnis, sehingga perbandingan menjadi string-exact pada dua sisi
 * yang dihasilkan oleh PostgreSQL sendiri.
 *
 * Syarat:
 *  - Dipanggil DALAM transaksi yang sama yang digunakan runner (client
 *    transaksi yang diberikan; fungsi ini tidak membuat pool/koneksi baru).
 *  - Tabel referensi dibuat dengan `CREATE TEMP TABLE ... ON COMMIT DROP`
 *    (skema pg_my_temp_schema) sehingga tidak ada residu skema publik,
 *    dan ON COMMIT DROP menjamin penghapusan otomatis saat transaksi COMMIT.
 *  - Nama tabel referensi unik per pemanggilan (suffix counter), sehingga
 *    tidak ada DROP TABLE lintas pemanggilan dan tidak ada tabrakan.
 *  - Seluruh kolom tabel kontrak (dari TABLE_COLUMNS) dibuat pada tabel
 *    referensi; CHECK expected ditanam pada tabel referensi itu.
 *  - OID tabel referensi dicari dengan relname + relnamespace =
 *    pg_my_temp_schema() + relkind='r'; WAJIB tepat satu hasil.
 *  - Tipe kolom tabel referensi berasal dari TABLE_COLUMNS (kontrak), bukan
 *    dari tabel aktual (independen terhadap skema yang diverifikasi).
 *  - Input (tableName, daftar CHECK expected) hanya konstanta kontrak.
 *
 * Mengembalikan Map: `nama constraint expected → ekspresi hasil pg_get_expr`.
 * CHECK anonim di label dengan `__anon__:<label>` (nama otomatik PG tidak
 * diasumsikan; verifier mencocokkan berdasarkan definisi saja).
 */
interface ExpectedCheckSpec {
  /** Nama constraint named (coso conname eksplisit); kosong/undefined untuk anonim. */
  conname?: string;
  /** Ekspresi SQL CHECK (tanpa prefix CHECK(...)), persis seperti DDL kontrak. */
  expr: string;
  /** Label manusia untuk CHECK anonim (opsional, untuk error message). */
  label?: string;
}

/** Quote identifier PostgreSQL (input hanya konstanta kontrak; tetap aman). */
function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/** Salin spec tipe kolom (udt_name + length/precision) ke definisi kolom
 *  DDL tabel referensi (tanpa NOT NULL/DEFAULT/FK/UNIQUE — cukup untuk
 *  menghasilkan representasi CHECK yang identik).
 *  Tipe yang tidak didukung → error (bukan fallback TEXT). */
function colTypeDDL(colName: string, spec: ColExpect): string {
  let base: string;
  if (spec.udt_name === 'varchar' && spec.varchar_len !== undefined) {
    base = `VARCHAR(${spec.varchar_len})`;
  } else if (spec.udt_name === 'numeric' && spec.num_prec !== undefined && spec.num_scale !== undefined) {
    base = `NUMERIC(${spec.num_prec},${spec.num_scale})`;
  } else if (spec.udt_name === 'int4') {
    base = 'INTEGER';
  } else if (spec.udt_name === 'bool') {
    base = 'BOOLEAN';
  } else if (spec.udt_name === 'text') {
    base = 'TEXT';
  } else if (spec.udt_name === 'timestamptz') {
    base = 'TIMESTAMP WITH TIME ZONE';
  } else {
    throw new Error(
      `colTypeDDL: tipe kolom tidak didukung untuk "${colName}" (udt_name=${spec.udt_name ?? 'n/a'}); ` +
        'dukung hanya udt_name yang eksplisit didukung (int4/bool/text/timestamptz/varchar(n)/numeric(p,s)).',
    );
  }
  return `${quoteIdent(colName)} ${base}`;
}

/** Counter global untuk nama tabel referensi unik per pemanggilan. */
let mbRefTableCounter = 0;

/**
 * Buat satu tabel referensi sementara (TEMP) per pemanggilan, tanam semua
 * CHECK expected, lalu ambil representasi `pg_get_expr(conbin, conrelid, false)`
 * per constraint (dibatasi OID tabel referensi yang tepat).
 *
 * @returns `Map<conname, expr>`. Kunci `__anon__:<label>` untuk CHECK anonim.
 * @throws bila DDL tabel referensi gagal, atau OID tidak tepat satu, atau
 *          constraint tidak ditemukan di tabel referensi.
 */
async function materializeExpectedCheckExprs(
  client: PoolClient,
  tableName: string,
  expectedChecks: ExpectedCheckSpec[],
): Promise<Map<string, string>> {
  const tableColSpecs = TABLE_COLUMNS[tableName];
  if (!tableColSpecs) {
    throw new Error(
      `materializeExpectedCheckExprs: tabel kontrak "${tableName}" tidak ada di TABLE_COLUMNS`,
    );
  }

  // Nama unik per pemanggilan: _mb_ref_<tableName>_<n>. Tabel TEMP
  // (skema pg_my_temp_schema) tidak akan bertabrakan dengan tabel bisnis,
  // dan ON COMMIT DROP menjamin tidak ada residu setelah transaksi.
  mbRefTableCounter += 1;
  const refTableName = `_mb_ref_${tableName}_${mbRefTableCounter}`;

  // Seluruh kolom dari TABLE_COLUMNS tabel kontrak (identitas: nama + tipe;
  // tanpa NOT NULL/DEFAULT/FK/UNIQUE — CHECK representasi cukup dengan tipe).
  const colDefs = Object.keys(tableColSpecs)
    .map((c) => colTypeDDL(c, tableColSpecs[c]))
    .join(',\n  ');

  // Tanam semua CHECK expected pada tabel referensi.
  const checkDefs = expectedChecks
    .map((ck, idx) => {
      const cname = ck.conname
        ? `CONSTRAINT ${quoteIdent(ck.conname)}`
        : `CONSTRAINT ${quoteIdent(`__anon_${idx}`)}`;
      // Ekspresi dimasukkan apa adanya (input konstanta kontrak, bukan
      // interpolasi user). Identifier di dalam expr sudah berupa identifier
      // sederhana; quote hanya diterapkan ke nama constraint.
      return `${cname} CHECK (${ck.expr})`;
    })
    .join(',\n  ');

  // CREATE TEMP TABLE ... ON COMMIT DROP. Nama unik per pemanggilan, jadi
  // tidak perlu DROP TABLE sebelum CREATE.
  await client.query(
    `CREATE TEMP TABLE ${refTableName} (\n  ${colDefs},\n  ${checkDefs}) ON COMMIT DROP;`,
  );

  // Cari OID tabel referensi: relname + relnamespace = pg_my_temp_schema()
  // + relkind='r'. WAJIB tepat satu hasil.
  const oidR = await client.query(
    `SELECT c.oid AS table_oid
       FROM pg_class c
      WHERE c.relname = $1
        AND c.relnamespace = pg_my_temp_schema()
        AND c.relkind = 'r'`,
    [refTableName],
  );
  if ((oidR.rowCount ?? 0) !== 1) {
    throw new Error(
      `materializeExpectedCheckExprs: pencarian OID tabel referensi "${refTableName}" menghasilkan ` +
        `${oidR.rowCount ?? 0} hasil (wajib tepat 1).`,
    );
  }
  const refTableOid = oidR.rows[0].table_oid;

  // Temukan constraint named / anonim pada tabel referensi (hanya contype='c',
  // dibatasi OID tabel referensi yang tepat).
  const conR = await client.query(
    `SELECT c.conname,
            pg_get_expr(c.conbin, c.conrelid, false) AS expr
       FROM pg_constraint c
      WHERE c.conrelid = $1
        AND c.contype = 'c'
      ORDER BY c.conname`,
    [refTableOid],
  );

  const out = new Map<string, string>();
  for (const ck of expectedChecks) {
    const key = ck.conname ?? `__anon__:${ck.label ?? ck.expr}`;
    const wantedName = ck.conname
      ? ck.conname
      : `__anon_${expectedChecks.indexOf(ck)}`;
    const row = conR.rows.find((r: any) => r.conname === wantedName);
    if (!row) {
      throw new Error(
        `materializeExpectedCheckExprs: constraint "${wantedName}" pada tabel referensi "${refTableName}" tidak ditemukan (DDL referensi tidak menghasilkan constraint?)`,
      );
    }
    out.set(key, row.expr);
  }
  return out;
}

/**
 * Defensif: pastikan nilai kolom constraint/index berupa JS array of string.
 * node-pg umumnya sudah mengurai text[] menjadi JS array; fungsi ini menangani
 * fallback bila tiba sebagai string PG array ("{a,b,c}").
 */
function parsePgArray(val: any): string[] {
  if (Array.isArray(val)) return val.map((x) => String(x));
  if (typeof val !== 'string') return [];
  const s = val.trim();
  if (!s || s === '{}' || s === '[]') return [];
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1);
    if (!inner.trim()) return [];
    const parts: string[] = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (inQuote) {
        if (ch === '"' && i + 1 < inner.length && inner[i + 1] === '"') {
          cur += '"';
          i++;
          continue;
        }
        if (ch === '"') { inQuote = false; continue; }
        cur += ch;
        continue;
      }
      if (ch === '"') { inQuote = true; continue; }
      if (ch === ',') { parts.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    parts.push(cur.trim());
    return parts.filter((p) => p.length > 0);
  }
  return [s];
}

export async function verifyMinibarSchema(client: PoolClient): Promise<VerificationResult> {
  const errors: string[] = [];

  const q = async (sql: string, params?: any[]) => {
    const r = await client.query(sql, params);
    return (r.rows ?? [] as any[]).length;
  };

    // Tabel wajib ada
    const requiredTables = [
      'room_type_minibar_standard',
      'minibar_baseline_verification',
      'minibar_stay_event',
      'minibar_inspection_report',
      'minibar_inspection_report_line',
      'minibar_billing_confirmation',
    ];
    for (const t of requiredTables) {
      const cnt = await q(
        "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
        [t],
      );
      if (cnt === 0) errors.push(`Tabel tidak ada: ${t}`);
    }

    // Fokus tabel & kolom: periksa seluruh kolom T1–T6 + additive T7/T9/T10
    // (skema, nama, tipe, panjang/precision, nullability, default kontrak)
    for (const [tname, cols] of Object.entries(TABLE_COLUMNS)) {
      await verifyTableColumns(client, tname, cols, errors);
    }

    // PRIMARY KEY: setiap tabel minibar (id), periksa jenis + kolom, tervalidasi
    for (const t of requiredTables) {
      const cons = await loadTableConstraints(client, t);
      const pk = cons.find((c) => c.contype === 'p');
      if (!pk) {
        errors.push(`PRIMARY KEY tidak ada pada ${t}`);
      } else {
        if (JSON.stringify(pk.columns) !== JSON.stringify(['id'])) {
          errors.push(`PRIMARY KEY ${t} kolom ${JSON.stringify(pk.columns)} != ["id"]`);
        }
        if (!pk.convalidated) {
          errors.push(`PRIMARY KEY ${t} belum tervalidasi`);
        }
      }
    }

    // UNIQUE yang diwajibkan DDL: periksa tabel yang tepat + urutan kolom + tervalidasi
    const requiredUnique: Array<{ conname: string; table: string; columns: string[] }> = [
      { conname: 'uq_room_type_minibar_standard', table: 'room_type_minibar_standard', columns: ['property_id', 'room_type_id', 'menu_item_id'] },
      { conname: 'uq_minibar_stay_event', table: 'minibar_stay_event', columns: ['property_id', 'reservation_id', 'room_id', 'menu_item_id', 'event_type', 'source_type', 'source_id'] },
      { conname: 'uq_minibar_inspection_report', table: 'minibar_inspection_report', columns: ['task_id'] },
      { conname: 'uq_minibar_report_line', table: 'minibar_inspection_report_line', columns: ['report_id', 'menu_item_id'] },
      { conname: 'uq_minibar_billing_confirmation', table: 'minibar_billing_confirmation', columns: ['property_id', 'report_line_id'] },
    ];
    for (const u of requiredUnique) {
      const cons = await loadTableConstraints(client, u.table);
      const uc = cons.find((c) => c.contype === 'u' && c.conname === u.conname);
      if (!uc) {
        errors.push(`UNIQUE ${u.conname} tidak ada pada ${u.table}`);
        continue;
      }
      if (JSON.stringify(uc.columns) !== JSON.stringify(u.columns)) {
        errors.push(`UNIQUE ${u.conname} kolom ${JSON.stringify(uc.columns)} != ${JSON.stringify(u.columns)}`);
      }
      if (!uc.convalidated) {
        errors.push(`UNIQUE ${u.conname} belum tervalidasi`);
      }
    }

    // Index: verifikasi definisi aktual dari DDL (12 index, semua B-tree biasa,
    // non-unique, tanpa predicate). Nama index yang salah di tabel lain tidak
    // diterima; index hilang → mismatch terkendali, tanpa cast regclass.
    const requiredIdx: Array<{
      index: string;
      table: string;
      columns: string[];
    }> = [
      // T1
      { index: 'idx_rt_minibar_std_property', table: 'room_type_minibar_standard', columns: ['property_id'] },
      { index: 'idx_rt_minibar_std_room_type', table: 'room_type_minibar_standard', columns: ['room_type_id'] },
      // T2
      { index: 'idx_mb_baseline_scope', table: 'minibar_baseline_verification', columns: ['property_id', 'reservation_id', 'room_id', 'menu_item_id', 'id'] },
      { index: 'idx_mb_baseline_res', table: 'minibar_baseline_verification', columns: ['reservation_id'] },
      { index: 'idx_mb_baseline_prop', table: 'minibar_baseline_verification', columns: ['property_id'] },
      // T3
      { index: 'idx_mb_stay_event_scope', table: 'minibar_stay_event', columns: ['property_id', 'reservation_id', 'room_id', 'menu_item_id', 'id'] },
      { index: 'idx_mb_stay_event_source', table: 'minibar_stay_event', columns: ['source_type', 'source_id'] },
      // T4
      { index: 'idx_mb_report_prop', table: 'minibar_inspection_report', columns: ['property_id', 'status'] },
      { index: 'idx_mb_report_res', table: 'minibar_inspection_report', columns: ['reservation_id'] },
      // T5
      { index: 'idx_mb_report_line_prop', table: 'minibar_inspection_report_line', columns: ['property_id', 'menu_item_id'] },
      // T6
      { index: 'idx_mb_billing_conf_prop', table: 'minibar_billing_confirmation', columns: ['property_id', 'billing_status'] },
      { index: 'idx_mb_billing_conf_folio', table: 'minibar_billing_confirmation', columns: ['folio_entry_id'] },
    ];
    for (const ix of requiredIdx) {
      const r = await client.query(
        `SELECT ic.relname,
                n.nspname AS table_schema,
                tc.relname AS table_name,
                am.amname AS method,
                ic.relnatts AS natts,
                 t.indisunique, t.indislive, t.indisvalid, t.indisready,
                t.indpred, t.indnkeyatts,
                ARRAY(
                  SELECT a.attname
                  FROM unnest(t.indkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a
                    ON a.attrelid = tc.oid AND a.attnum = k.attnum
                  WHERE k.ord <= t.indnkeyatts
                  ORDER BY k.ord
                ) AS columns
          FROM pg_class ic
          JOIN pg_namespace n ON n.oid = ic.relnamespace
          JOIN pg_index t ON t.indexrelid = ic.oid
          JOIN pg_class tc ON tc.oid = t.indrelid
          JOIN pg_am am ON am.oid = ic.relam
         WHERE ic.relkind = 'i' AND ic.relname = $1
           AND n.nspname = 'public'`,
        [ix.index],
      );
      if (r.rows.length === 0) {
        errors.push(`Index tidak ada: ${ix.index} (tabel ${ix.table})`);
        continue;
      }
      const row = r.rows[0];
      if (row.table_schema !== 'public' || row.table_name !== ix.table) {
        errors.push(`Index ${ix.index} berada pada ${row.table_schema}.${row.table_name} != public.${ix.table}`);
      }
      if (row.method !== 'btree') {
        errors.push(`Index ${ix.index} metode ${row.method} != btree (DDL)`);
      }
      if (row.indisunique === true) {
        errors.push(`Index ${ix.index} unique, DDL menetapkan non-unique`);
      }
      if (row.indislive !== true) {
        errors.push(`Index ${ix.index} tidak live (indislive=false)`);
      }
      if (row.indisvalid !== true) {
        errors.push(`Index ${ix.index} tidak valid (indisvalid=false)`);
      }
      if (row.indisready !== true) {
        errors.push(`Index ${ix.index} tidak ready (indisready=false)`);
      }
      if (row.indpred !== null) {
        errors.push(`Index ${ix.index} memiliki predicate, DDL tidak menetapkannya`);
      }
      if (Number(row.natts) !== ix.columns.length) {
        errors.push(`Index ${ix.index} natts ${row.natts} != ${ix.columns.length} kolom DDL`);
      }
      const actualCols: string[] = parsePgArray(row.columns ?? []);
      if (JSON.stringify(actualCols) !== JSON.stringify(ix.columns)) {
        errors.push(`Index ${ix.index} kolom ${JSON.stringify(actualCols)} != ${JSON.stringify(ix.columns)}`);
      }
      if (Number(row.indnkeyatts) !== ix.columns.length) {
        errors.push(`Index ${ix.index} indnkeyatts ${row.indnkeyatts} != ${ix.columns.length} (expression/INCLUDE terdeteksi, DDL tidak)`);
      }
    }

    // FK: periksa definisi aktual (skema/tabel asal, kolom asal,
    // skema/tabel/kolom tujuan, ON DELETE RESTRICT, tervalidasi).
    // FK inline auto-generated dikenali berdasarkan definisi, bukan nama.
    const requiredFks: Array<{
      table: string;
      columns: string[];
      refTable: string;
      refColumns: string[];
    }> = [
      // T1
      { table: 'room_type_minibar_standard', columns: ['property_id'], refTable: 'properties', refColumns: ['id'] },
      { table: 'room_type_minibar_standard', columns: ['room_type_id'], refTable: 'room_types', refColumns: ['id'] },
      { table: 'room_type_minibar_standard', columns: ['menu_item_id'], refTable: 'pos_menu_items', refColumns: ['id'] },
      // T2
      { table: 'minibar_baseline_verification', columns: ['property_id'], refTable: 'properties', refColumns: ['id'] },
      { table: 'minibar_baseline_verification', columns: ['reservation_id'], refTable: 'reservations', refColumns: ['id'] },
      { table: 'minibar_baseline_verification', columns: ['room_id'], refTable: 'rooms', refColumns: ['id'] },
      { table: 'minibar_baseline_verification', columns: ['menu_item_id'], refTable: 'pos_menu_items', refColumns: ['id'] },
      // T3
      { table: 'minibar_stay_event', columns: ['property_id'], refTable: 'properties', refColumns: ['id'] },
      { table: 'minibar_stay_event', columns: ['reservation_id'], refTable: 'reservations', refColumns: ['id'] },
      { table: 'minibar_stay_event', columns: ['room_id'], refTable: 'rooms', refColumns: ['id'] },
      { table: 'minibar_stay_event', columns: ['menu_item_id'], refTable: 'pos_menu_items', refColumns: ['id'] },
      // T4
      { table: 'minibar_inspection_report', columns: ['property_id'], refTable: 'properties', refColumns: ['id'] },
      { table: 'minibar_inspection_report', columns: ['reservation_id'], refTable: 'reservations', refColumns: ['id'] },
      { table: 'minibar_inspection_report', columns: ['room_id'], refTable: 'rooms', refColumns: ['id'] },
      { table: 'minibar_inspection_report', columns: ['task_id'], refTable: 'housekeeping_tasks', refColumns: ['id'] },
      // T5
      { table: 'minibar_inspection_report_line', columns: ['report_id'], refTable: 'minibar_inspection_report', refColumns: ['id'] },
      { table: 'minibar_inspection_report_line', columns: ['property_id'], refTable: 'properties', refColumns: ['id'] },
      { table: 'minibar_inspection_report_line', columns: ['menu_item_id'], refTable: 'pos_menu_items', refColumns: ['id'] },
      { table: 'minibar_inspection_report_line', columns: ['baseline_verification_id'], refTable: 'minibar_baseline_verification', refColumns: ['id'] },
      { table: 'minibar_inspection_report_line', columns: ['anchor_event_id'], refTable: 'minibar_stay_event', refColumns: ['id'] },
      { table: 'minibar_inspection_report_line', columns: ['cutoff_event_id'], refTable: 'minibar_stay_event', refColumns: ['id'] },
      // T6
      { table: 'minibar_billing_confirmation', columns: ['property_id'], refTable: 'properties', refColumns: ['id'] },
      { table: 'minibar_billing_confirmation', columns: ['reservation_id'], refTable: 'reservations', refColumns: ['id'] },
      { table: 'minibar_billing_confirmation', columns: ['report_line_id'], refTable: 'minibar_inspection_report_line', refColumns: ['id'] },
      { table: 'minibar_billing_confirmation', columns: ['folio_entry_id'], refTable: 'folio_entries', refColumns: ['id'] },
      { table: 'minibar_billing_confirmation', columns: ['original_folio_entry_id'], refTable: 'folio_entries', refColumns: ['id'] },
      // T7 (kolom additive folio_entries → dua tabel minibar)
      { table: 'folio_entries', columns: ['hk_report_line_id'], refTable: 'minibar_inspection_report_line', refColumns: ['id'] },
      { table: 'folio_entries', columns: ['minibar_confirmation_id'], refTable: 'minibar_billing_confirmation', refColumns: ['id'] },
    ];
    for (const fk of requiredFks) {
      const cons = await loadTableConstraints(client, fk.table);
      const match = cons.find(
        (c) =>
          c.contype === 'f' &&
          c.columns.length === fk.columns.length &&
          c.columns.every((col, i) => col === fk.columns[i]) &&
          c.refTable === 'public.' + fk.refTable &&
          c.refColumns.length === fk.refColumns.length &&
          c.refColumns.every((col, i) => col === fk.refColumns[i]),
      );
      if (!match) {
        errors.push(
          `FK tidak ada pada ${fk.table}(${fk.columns.join(',')}) → ${fk.refTable}(${fk.refColumns.join(',')})`,
        );
        continue;
      }
      if (match.refDeleteAction !== 'r') {
        errors.push(
          `FK ${fk.table}(${fk.columns.join(',')}) → ${fk.refTable} ON DELETE ${match.refDeleteAction} != RESTRICT`,
        );
      }
      if (!match.convalidated) {
        errors.push(`FK ${fk.table}(${fk.columns.join(',')}) → ${fk.refTable} belum tervalidasi`);
      }
    }

    // Verifikasi CHECK penuh (DDL aktual): named CHECK dipverifikasi per
    // nama + definisi; CHECK anonim (T4 status report) dipverifikasi per
    // definisi saja. Nama benar tetapi ekspresi berbeda → mismatch eksplisit.
    // Kecocokan representasi deparser (mis. cast ::character varying pada
    // IN-list varchar, cast ::numeric pada 0) belum diklaim lulus —
    // harus dibuktikan pada pengujian DB disposable.
    const requiredQuantityChecks: Array<{ table: string; conname: string; expr: string }> = [
      // T2
      { table: 'minibar_baseline_verification', conname: 'ck_mb_baseline_source_type', expr: "source_type IN ('EXPLICIT_CHECKIN','MANUAL_VERIFICATION','EXPLICIT_RESTOCK')" },
      // T3
      { table: 'minibar_stay_event', conname: 'ck_mb_event_source_type', expr: "source_type IN ('REPORT','RESTOCK','VERIFICATION')" },
      { table: 'minibar_stay_event', conname: 'ck_mb_event_type', expr: "event_type IN ('EXPLICIT_CHECKIN','ADDED_TO_ROOM','REMOVED_FROM_ROOM','DAMAGED_RECORDED','LOST_RECORDED','CONSUMPTION_CONFIRMED','CORRECTION_RECORDED','INSPECTION_SNAPSHOT')" },
      { table: 'minibar_stay_event', conname: 'ck_mb_event_delta_sign', expr: "(event_type = 'ADDED_TO_ROOM' AND quantity_delta > 0) OR (event_type IN ('REMOVED_FROM_ROOM','DAMAGED_RECORDED','LOST_RECORDED','CONSUMPTION_CONFIRMED') AND quantity_delta < 0) OR (event_type IN ('INSPECTION_SNAPSHOT','EXPLICIT_CHECKIN') AND quantity_delta = 0) OR (event_type = 'CORRECTION_RECORDED' AND quantity_delta <> 0)" },
      // T5
      { table: 'minibar_inspection_report_line', conname: 'ck_mb_line_baseline_status', expr: "baseline_status IN ('VERIFIED','UNKNOWN','PENDING_VERIFICATION')" },
      { table: 'minibar_inspection_report_line', conname: 'ck_mb_line_surplus_status', expr: "surplus_status IS NULL OR surplus_status IN ('NONE','UNVERIFIED','VERIFIED')" },
      { table: 'minibar_inspection_report_line', conname: 'ck_mb_line_billing_status', expr: "billing_status IN ('PENDING','NOT_BILLED','BILLED','VOIDED','CORRECTED')" },
      // T6
      { table: 'minibar_billing_confirmation', conname: 'ck_mb_conf_billing_status', expr: "billing_status IN ('POSTED','NOT_BILLED','VOIDED','CORRECTED')" },
      { table: 'minibar_billing_confirmation', conname: 'ck_mb_conf_not_billed', expr: "billing_status <> 'NOT_BILLED' OR (confirmed_consumed_qty = 0 AND confirmed_subtotal = 0 AND folio_entry_id IS NULL AND original_folio_entry_id IS NULL AND reduction_reason IS NOT NULL AND btrim(reduction_reason) <> '')" },
      { table: 'minibar_billing_confirmation', conname: 'ck_mb_conf_posted', expr: "billing_status <> 'POSTED' OR (confirmed_consumed_qty > 0 AND folio_entry_id IS NOT NULL AND original_folio_entry_id IS NOT NULL)" },
      { table: 'minibar_billing_confirmation', conname: 'ck_mb_conf_voided_corrected', expr: "billing_status NOT IN ('VOIDED','CORRECTED') OR (confirmed_consumed_qty > 0 AND folio_entry_id IS NOT NULL AND original_folio_entry_id IS NOT NULL)" },
      { table: 'minibar_billing_confirmation', conname: 'ck_mb_conf_corrected_group', expr: "billing_status <> 'CORRECTED' OR (correction_group_id IS NOT NULL AND btrim(correction_group_id) <> '')" },
      // T1
      { table: 'room_type_minibar_standard', conname: 'ck_rt_minibar_std_qty', expr: 'standard_qty >= 0' },
      // T2
      { table: 'minibar_baseline_verification', conname: 'ck_mb_baseline_qty', expr: 'verified_qty >= 0' },
      // T5
      { table: 'minibar_inspection_report_line', conname: 'ck_mb_line_baseline_qty', expr: 'baseline_qty IS NULL OR baseline_qty >= 0' },
      { table: 'minibar_inspection_report_line', conname: 'ck_mb_line_baseline_effective', expr: 'baseline_effective IS NULL OR baseline_effective >= 0' },
      { table: 'minibar_inspection_report_line', conname: 'ck_mb_line_counted_qty', expr: 'counted_qty >= 0' },
      { table: 'minibar_inspection_report_line', conname: 'ck_mb_line_consumed_qty', expr: 'consumed_qty IS NULL OR consumed_qty >= 0' },
      { table: 'minibar_inspection_report_line', conname: 'ck_mb_line_damaged_qty', expr: 'damaged_qty IS NULL OR damaged_qty >= 0' },
      { table: 'minibar_inspection_report_line', conname: 'ck_mb_line_lost_qty', expr: 'lost_qty IS NULL OR lost_qty >= 0' },
      { table: 'minibar_inspection_report_line', conname: 'ck_mb_line_correction_qty', expr: 'correction_qty IS NULL OR correction_qty >= 0' },
      { table: 'minibar_inspection_report_line', conname: 'ck_mb_line_unresolved_qty', expr: 'unresolved_qty IS NULL OR unresolved_qty >= 0' },
      { table: 'minibar_inspection_report_line', conname: 'ck_mb_line_surplus_qty', expr: 'surplus_qty IS NULL OR surplus_qty >= 0' },
      { table: 'minibar_inspection_report_line', conname: 'ck_mb_line_unit_price', expr: 'unit_price_snapshot IS NULL OR unit_price_snapshot >= 0' },
      // T6
      { table: 'minibar_billing_confirmation', conname: 'ck_mb_conf_consumed_qty', expr: 'confirmed_consumed_qty >= 0' },
      { table: 'minibar_billing_confirmation', conname: 'ck_mb_conf_subtotal', expr: 'confirmed_subtotal >= 0' },
    ];
    // CHECK non-quantity: T4 status report TIDAK named di DDL
    // (CHECK (status IN ...)) → nama otomatis PG tidak boleh diasumsikan;
    // verifikasi berdasarkan definisi, bukan conname.
    const requiredAnonChecks: Array<{ table: string; expr: string; label: string }> = [
      {
        table: 'minibar_inspection_report',
        label: 'status_report (anonim di DDL)',
        expr: "status IN ('DRAFT','SUBMITTED','SUPERSEDED')",
      },
    ];
    // Verifikasi CHECK (representasi deparser PG):
    // - Named CHECK: cocok nama + tabel + contype + convalidated, lalu bandingkan
    //   representasi `pg_get_expr(conbin, conrelid, false)` dari constraint AKTUAL
    //   dengan expected yang dimaterialisasi via tabel referensi sementara (TEMP).
    // - Cek anonym (T4 status report): DDL T4 mendefinisikan CHECK status tanpa
    //   nama constraint eksplisit → nama otomatik PG tidak boleh diasumsikan;
    //   verifikasi berdasarkan definisi (pg_get_expr) saja.
    // Kelompokkan expected per tabel agar helper dipanggil sekali per tabel.
    const expectedByTable = new Map<string, ExpectedCheckSpec[]>();
    const pushExpected = (table: string, spec: ExpectedCheckSpec) => {
      const arr = expectedByTable.get(table) ?? [];
      arr.push(spec);
      expectedByTable.set(table, arr);
    };
    for (const ck of requiredQuantityChecks) {
      pushExpected(ck.table, { conname: ck.conname, expr: ck.expr });
    }
    for (const ck of requiredAnonChecks) {
      pushExpected(ck.table, { expr: ck.expr, label: ck.label });
    }

    for (const [tableName, specs] of expectedByTable) {
      // 1) Materialisasi expected (representasi PG via tabel TEMP).
      let expectedMap: Map<string, string>;
      try {
        expectedMap = await materializeExpectedCheckExprs(client, tableName, specs);
      } catch (e: any) {
        errors.push(`CHECK expected pada ${tableName} gagal dimaterialisasi: ${e.message}`);
        continue;
      }

      // 2) Muat constraint aktual tabel (representasi pg_get_expr + metadatum).
      const cons = await loadTableConstraints(client, tableName);

      // 3) Bandingkan per spec.
      for (const spec of specs) {
        const key = spec.conname ?? `__anon__:${spec.label ?? spec.expr}`;
        const expectedExpr = expectedMap.get(key);
        if (expectedExpr === undefined) {
          errors.push(`CHECK ${key} pada ${tableName}: representasi expected tidak ditemukan (bug internal helper).`);
          continue;
        }

        if (spec.conname) {
          // Named: cocok nama + contype + convalidated + representasi.
          const found = cons.find(
            (c) => c.contype === 'c' && c.conname === spec.conname,
          );
          if (!found) {
            errors.push(`CHECK ${spec.conname} tidak ada pada ${tableName} (contype='c')`);
            continue;
          }
          if (!found.convalidated) {
            errors.push(`CHECK ${spec.conname} pada ${tableName} belum tervalidasi`);
          }
          if (found.checkExpr !== expectedExpr) {
            errors.push(
              `CHECK ${spec.conname} pada ${tableName} representasi '${found.checkExpr}' != expected '${expectedExpr}'`,
            );
          }
        } else {
          // Anonym: cari constraint CHECK yang representasinya SAMA PERSIS.
          const match = cons.find(
            (c) => c.contype === 'c' && c.checkExpr === expectedExpr,
          );
          if (!match) {
            errors.push(
              `CHECK ${spec.label ?? '(anonim)'} tidak ditemukan pada ${tableName} ` +
                `(representasi expected '${expectedExpr}')`,
            );
            continue;
          }
          if (!match.convalidated) {
            errors.push(
              `CHECK ${spec.label ?? '(anonim)'} pada ${tableName} belum tervalidasi`,
            );
          }
        }
      }
    }

    // Marker
    const markerCnt = await q(
      "SELECT 1 FROM schema_migrations WHERE version=$1",
      [MARKER],
    );

    return {
      ok: errors.length === 0,
      errors,
      status: markerCnt > 0 ? 'already-applied' : 'applied',
    };
}

// =============================================================================
// Runner Migration
// =============================================================================

/**
 * Jalankan migration minibar. Transactional + advisory lock.
 *
 * Status:
 * - 'applied'             : DDL baru diterapkan + marker ditulis.
 * - 'already-applied'     : marker sudah ada, skema sesuai, tanpa re-DDL.
 * - 'mismatch'            : marker ada tetapi skema tidak sesuai → ROLLBACK.
 * - 'verification-failed' : DDL baru diterapkan tetapi verifikasi gagal → ROLLBACK
 *                           (tidak ada DDL/marker tertinggal).
 * - 'error'               : exception di tengah transaksi → ROLLBACK.
 *
 * @returns { ok, applied, status, errors }
 */
export async function runMinibarHkBillingMigration(
  pool: Pool,
): Promise<{ ok: boolean; applied: boolean; status: MigrationRunStatus; errors: string[] }> {
  const client = await pool.connect();
  try {
    // Urutan atomik: BEGIN → lock → cek marker → DDL bila perlu
    //               → verifikasi → INSERT marker → COMMIT
    // Marker existing: verifikasi sambil lock masih dipegang (tanpa ROLLBACK).
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
      // Jalankan DDL dalam transaksi yang sama (tanpa marker di dalam string DDL)
      await client.query(MINIBAR_DDL);
    }

    // Verifikasi schema menggunakan client transaksi yang SAMA
    const verify = await verifyMinibarSchema(client);
    if (!verify.ok) {
      // Verifikasi gagal → ROLLBACK; tidak ada DDL/marker tertinggal
      await client.query('ROLLBACK');
      return {
        ok: false,
        applied: false,
        status: markerExists ? 'mismatch' : 'verification-failed',
        errors: verify.errors,
      };
    }

    // Tulis marker (hanya bila belum ada; idempoten)
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

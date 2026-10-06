/**
 * POS PAYMENT SETTLEMENT — Tahap 1: Fondasi Tabel Settlement CASH
 * DDL Authoritative: buat tabel pos_settlements untuk settlement pembayaran
 *                    langsung POS (tanpa transaksi PAYMENT terpisah).
 *
 * Kontrak:
 * - Tidak mengubah payment_transactions, payment_evidences, folio_entries,
 *   reservations, atau tabel lain.
 * - Tidak menambahkan receiving_account_id (keputusan terbuka).
 * - Settlement meng-referensikan SALE yang sudah ada di transactions
 *   (via transaction_id), tidak membuat revenue kedua.
 * - Tidak ada tabel upload bukti — bukti CASH dirender dari settlement tersimpan.
 *
 * Tipe FK sesuai source aktual:
 *   properties.id  = SERIAL  → INTEGER
 *   pos_orders.id  = SERIAL  → INTEGER
 *   transactions.id = BIGSERIAL → BIGINT
 *
 * Constraint:
 * - pos_order_id UNIQUE → satu settlement sukses per order (tahap full-payment sekali)
 * - UNIQUE(property_id, pos_order_id, idempotency_key) → dedup key per properti+order
 * - CHECK (amount > 0)
 * - status NOT NULL, tahap ini hanya 'SUCCESS'
 *
 * Migration:
 * - BEGIN/COMMIT/ROLLBACK + advisory lock (pola repo)
 * - Marker: `pos_payment_settlement_v1` pada `schema_migrations`
 * - Verifikasi SEBELUM dan SETELAH marker; mismatch → gagal eksplisit (tanpa repair otomatis)
 * - Idempoten: jika marker ada dan skema sesuai → skip DDL, status 'already-applied'
 *
 * Gunakan via runner CLI (belum dibuat di tahap ini):
 *   node backend/scripts/run_pos_payment_settlement_migration.js
 * dengan MIGRATION_DATABASE_URL eksplisit.
 */

import { Pool, PoolClient } from 'pg';

const MARKER = 'pos_payment_settlement_v1';

// =============================================================================
// DDL — semua statement dalam satu string; dieksekusi berurutan dalam 1 transaksi
// =============================================================================

export const POS_PAYMENT_SETTLEMENT_DDL = `
-- Tabel settlement pembayaran langsung POS.
-- Meng-referensikan SALE yang sudah diproyeksikan dari pos_orders.
CREATE TABLE IF NOT EXISTS pos_settlements (
  id SERIAL PRIMARY KEY,

  -- Scope properti: INTEGER sesuai properties.id (SERIAL)
  property_id INTEGER NOT NULL,

  -- Relasi ke order POS: INTEGER sesuai pos_orders.id (SERIAL), UNIQUE per order
  pos_order_id INTEGER NOT NULL,

  -- Relasi ke SALE transactions: BIGINT sesuai transactions.id (BIGSERIAL)
  transaction_id BIGINT NOT NULL,

  -- Nominal dari order tersimpan, harus > 0
  amount NUMERIC(12,2) NOT NULL,

  -- Metode pembayaran: tahap ini 'CASH', kolom VARCHAR(30) untuk ekstensi
  payment_method VARCHAR(30) NOT NULL,

  -- Status settlement: tahap ini hanya 'SUCCESS'
  status VARCHAR(30) NOT NULL DEFAULT 'SUCCESS',

  -- Idempotency key (dari klien) + fingerprint payload bisnis
  idempotency_key VARCHAR(150) NOT NULL,
  request_fingerprint VARCHAR(128) NOT NULL,

  -- Identitas aktor mengikuti kontrak existing (created_by VARCHAR(100))
  created_by VARCHAR(100),

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- FK constraint eksplisit (ON DELETE RESTRICT: settlement tidak boleh dihapus
-- bila order/properti/SALE masih ada — integritas audit trail).
ALTER TABLE pos_settlements
  ADD CONSTRAINT fk_pos_settlements_property
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE RESTRICT;

ALTER TABLE pos_settlements
  ADD CONSTRAINT fk_pos_settlements_order
  FOREIGN KEY (pos_order_id) REFERENCES pos_orders(id) ON DELETE RESTRICT;

ALTER TABLE pos_settlements
  ADD CONSTRAINT fk_pos_settlements_transaction
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE RESTRICT;

-- CHECK: nominal harus > 0 (nominal dari order tersimpan, bukan input klien bebas)
ALTER TABLE pos_settlements
  ADD CONSTRAINT chk_pos_settlements_amount_positive
  CHECK (amount > 0);

-- CHECK: status tahap ini hanya 'SUCCESS'
ALTER TABLE pos_settlements
  ADD CONSTRAINT chk_pos_settlements_status
  CHECK (status IN ('SUCCESS'));

-- UNIQUE: satu settlement per order (penjaga konkurensi di tingkat DB,
-- tidak bergantung idempotency_key)
ALTER TABLE pos_settlements
  ADD CONSTRAINT uq_pos_settlements_order
  UNIQUE (pos_order_id);

-- UNIQUE: dedup key per (property, order, key)
-- Mencegah dua settlement dengan idempotency_key sama di properti+order yang sama
ALTER TABLE pos_settlements
  ADD CONSTRAINT uq_pos_settlements_idempotency
  UNIQUE (property_id, pos_order_id, idempotency_key);

-- Index untuk lookup cepat saat replay per order
CREATE INDEX IF NOT EXISTS idx_pos_settlements_order
  ON pos_settlements (property_id, pos_order_id);
`;

export const MARKER_SQL = `
INSERT INTO schema_migrations (version) VALUES ('pos_payment_settlement_v1')
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
 * Verifikasi definisi SKEMA AKTUAL pos_settlements:
 * - tabel ada di schema public
 * - tiap kolom: nama, tipe (data_type/udt_name), nullability
 * - FK constraint (nama, kolom referensi, tabel referensi)
 * - CHECK constraint (nama, predikat dinormalisasi)
 * - UNIQUE constraint (nama, urutan kolom)
 * - index btree (AM, uniqueness, kolom, predicate)
 *
 * Nama constraint/index saja BUKAN bukti valid; tiap sub-komponen diperiksa.
 */
export async function verifyPosPaymentSettlementSchema(
  client: PoolClient,
): Promise<VerificationResult> {
  const errors: string[] = [];

  // ── Tabel pos_settlements harus ada di public ───────────────────────────
  const tblCheck = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'pos_settlements'`
  );
  if ((tblCheck.rowCount ?? 0) === 0) {
    errors.push('Tabel public.pos_settlements tidak ditemukan');
    return { ok: false, errors };
  }

  // ── Helper: periksa kolom (nama, tipe, nullable) ───────────────────────
  // expType: data_type aktual di information_schema
  // expUdt : udt_name aktual
  // expNullable: apakah kolom boleh NULL
  // expMaxLen: character_maximum_length (hanya untuk varchar), null jika tidak berlaku
  async function checkColumn(
    colName: string,
    expType: string,
    expUdt: string,
    expNullable: boolean,
    expMaxLen: number | null,
  ): Promise<void> {
    const r = await client.query(
      `SELECT character_maximum_length AS max_len,
              is_nullable            AS nullable,
              data_type,
              udt_name,
              numeric_precision,
              numeric_scale
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'pos_settlements'
         AND column_name  = $1`,
      [colName]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(`Kolom pos_settlements.${colName} tidak ditemukan`);
      return;
    }
    const row = r.rows[0];
    if (row.data_type !== expType) {
      errors.push(
        `Kolom pos_settlements.${colName}: data_type=${row.data_type}, ` +
        `ekspektasi '${expType}'`
      );
    }
    if (row.udt_name !== expUdt) {
      errors.push(
        `Kolom pos_settlements.${colName}: udt_name=${row.udt_name}, ` +
        `ekspektasi '${expUdt}'`
      );
    }
    if (row.nullable !== (expNullable ? 'YES' : 'NO')) {
      errors.push(
        `Kolom pos_settlements.${colName}: nullable=${row.nullable}, ` +
        `ekspektasi ${expNullable ? 'nullable' : 'NOT NULL'}`
      );
    }
    if (expMaxLen !== null && row.max_len !== expMaxLen) {
      errors.push(
        `Kolom pos_settlements.${colName}: character_maximum_length=${row.max_len}, ` +
        `ekspektasi ${expMaxLen}`
      );
    }
    // numeric_precision / numeric_scale untuk NUMERIC(12,2)
    if (expUdt === 'numeric') {
      if (Number(row.numeric_precision) !== 12) {
        errors.push(
          `Kolom pos_settlements.${colName}: numeric_precision=${row.numeric_precision}, ` +
          `ekspektasi 12`
        );
      }
      if (Number(row.numeric_scale) !== 2) {
        errors.push(
          `Kolom pos_settlements.${colName}: numeric_scale=${row.numeric_scale}, ` +
          `ekspektasi 2`
        );
      }
    }
  }

  // Kolom-kolom pos_settlements
  await checkColumn('id', 'integer', 'int4', false, null);
  await checkColumn('property_id', 'integer', 'int4', false, null);
  await checkColumn('pos_order_id', 'integer', 'int4', false, null);
  await checkColumn('transaction_id', 'bigint', 'int8', false, null);
  await checkColumn('amount', 'numeric', 'numeric', false, null);
  await checkColumn('payment_method', 'character varying', 'varchar', false, 30);
  await checkColumn('status', 'character varying', 'varchar', false, 30);
  await checkColumn('idempotency_key', 'character varying', 'varchar', false, 150);
  await checkColumn('request_fingerprint', 'character varying', 'varchar', false, 128);
  await checkColumn('created_by', 'character varying', 'varchar', true, 100);
  await checkColumn('created_at', 'timestamp without time zone', 'timestamp', true, null);

  // ── Helper: periksa FK constraint ───────────────────────────────────────
  // Query katalog PostgreSQL 15: pakai pg_constraint (conrelid/confrelid/
  // conkey/confkey) + pg_attribute. Tidak memakai alias pg_class yang salah
  // (pg_class tidak punya kolom confrelid/conkey/confkey/confeq/confupda).
  //
  // Verifikasi: tabel asal public.pos_settlements, seluruh kolom lokal &
  // referensi (urutan + jumlah), tabel referensi di schema public, ON DELETE
  // RESTRICT ('r'), non-deferrable, dan tervalidasi.
  async function checkFk(
    fkName: string,
    expCols: string[],
    expRefSchema: string,
    expRefTable: string,
    expRefCols: string[],
  ): Promise<void> {
    const r = await client.query(
      `WITH con AS (
         SELECT conname, contype, conrelid, confrelid,
                conkey, confkey, confdeltype,
                condeferrable, convalidated
         FROM pg_constraint
         WHERE conname = $1 AND contype = 'f'
           AND conrelid = 'public.pos_settlements'::regclass
       )
       SELECT con.conname,
              con.confdeltype,
              con.condeferrable,
              con.convalidated,
              con.conkey,
              con.confkey,
              lt.relname  AS local_table,
              ln.nspname  AS local_schema,
              rt.relname  AS ref_table,
              rn.nspname  AS ref_schema,
              (SELECT array_agg(a.attname ORDER BY x.ord)
                 FROM unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum) AS local_cols,
              (SELECT array_agg(ra.attname ORDER BY x.ord)
                 FROM unnest(con.confkey) WITH ORDINALITY AS x(attnum, ord)
                 JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = x.attnum) AS ref_cols
       FROM con
       LEFT JOIN pg_class lt ON lt.oid = con.conrelid
       LEFT JOIN pg_namespace ln ON ln.oid = lt.relnamespace
       LEFT JOIN pg_class rt ON rt.oid = con.confrelid
       LEFT JOIN pg_namespace rn ON rn.oid = rt.relnamespace`,
      [fkName]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(`FK constraint ${fkName} tidak ditemukan (contype='f')`);
      return;
    }
    const row = r.rows[0];

    // Terikat ke public.pos_settlements
    if (row.local_schema !== 'public' || row.local_table !== 'pos_settlements') {
      errors.push(
        `FK ${fkName}: tabel asal=${row.local_schema}.${row.local_table}, ` +
        `ekspektasi public.pos_settlements`
      );
      return;
    }

    const localCols: string[] = Array.isArray(row.local_cols)
      ? row.local_cols.map(String)
      : String(row.local_cols || '')
          .replace(/^[{]+|\}+$/g, '')
          .split(',')
          .map((s: string) => s.trim());
    const refCols: string[] = Array.isArray(row.ref_cols)
      ? row.ref_cols.map(String)
      : String(row.ref_cols || '')
          .replace(/^[{]+|\}+$/g, '')
          .split(',')
          .map((s: string) => s.trim());

    // Urutan & jumlah kolom lokal
    if (localCols.length !== expCols.length) {
      errors.push(
        `FK ${fkName}: kolom lokal=[${localCols.join(',')}], ` +
        `ekspektasi [${expCols.join(',')}], jumlah=${localCols.length} ekspektasi ${expCols.length}`
      );
    } else {
      for (let i = 0; i < expCols.length; i++) {
        if (localCols[i] !== expCols[i]) {
          errors.push(
            `FK ${fkName}: kolom lokal index ${i}=${localCols[i]}, ekspektasi '${expCols[i]}'`
          );
        }
      }
    }

    // Tabel & schema referensi
    if (row.ref_schema !== expRefSchema || row.ref_table !== expRefTable) {
      errors.push(
        `FK ${fkName}: tabel referensi=${row.ref_schema}.${row.ref_table}, ` +
        `ekspektasi ${expRefSchema}.${expRefTable}`
      );
    }

    // Urutan & jumlah kolom referensi
    if (refCols.length !== expRefCols.length) {
      errors.push(
        `FK ${fkName}: kolom referensi=[${refCols.join(',')}], ` +
        `ekspektasi [${expRefCols.join(',')}], jumlah=${refCols.length} ekspektasi ${expRefCols.length}`
      );
    } else {
      for (let i = 0; i < expRefCols.length; i++) {
        if (refCols[i] !== expRefCols[i]) {
          errors.push(
            `FK ${fkName}: kolom referensi index ${i}=${refCols[i]}, ekspektasi '${expRefCols[i]}'`
          );
        }
      }
    }

    // ON DELETE RESTRICT ('r')
    if (row.confdeltype !== 'r') {
      errors.push(
        `FK ${fkName}: confdeltype=${row.confdeltype}, ekspektasi 'r' (ON DELETE RESTRICT)`
      );
    }

    // Non-deferrable
    if (row.condeferrable !== false) {
      errors.push(`FK ${fkName}: condeferrable=${row.condeferrable}, ekspektasi false (non-deferrable)`);
    }

    // Tervalidasi
    if (row.convalidated !== true) {
      errors.push(`FK ${fkName}: convalidated=false (belum tervalidasi)`);
    }
  }

  await checkFk('fk_pos_settlements_property', ['property_id'], 'public', 'properties', ['id']);
  await checkFk('fk_pos_settlements_order', ['pos_order_id'], 'public', 'pos_orders', ['id']);
  await checkFk('fk_pos_settlements_transaction', ['transaction_id'], 'public', 'transactions', ['id']);

  // ── Helper: periksa CHECK constraint ────────────────────────────────────
  // Query katalog: pg_get_expr(conbin, conrelid). Tidak memakai consrc
  // (consrc hanya untuk constraint dengan operator biner tambahan; CHECK
  // murni cukup lewat conbin).
  // Perbandingan ketat terhadap definisi ter-normalisasi (bukan substring),
  // agar tidak menerima predicate tambahan / OR TRUE.
  //
  // Catatan representasi PostgreSQL untuk status satu nilai:
  //   CHECK (status IN ('SUCCESS')) pada domain VARCHAR dapat tersimpan sebagai
  //   "((status = 'SUCCESS'::character varying))" (IN tunggal diringkas).
  // Karena itu, untuk status satu nilai, kedua bentuk dianggap ekivalen
  // lewat parameter expPredAlt.
  async function checkCheckConstraint(
    constraintName: string,
    expPred: string,
    expPredAlt: string | null,
  ): Promise<void> {
    const r = await client.query(
      `SELECT con.conname,
              con.contype,
              con.convalidated,
              con.condeferrable,
              pg_get_expr(con.conbin, con.conrelid) AS pred,
              lt.relname  AS local_table,
              ln.nspname  AS local_schema
       FROM pg_constraint con
       LEFT JOIN pg_class lt ON lt.oid = con.conrelid
       LEFT JOIN pg_namespace ln ON ln.oid = lt.relnamespace
       WHERE con.conname = $1
         AND con.contype = 'c'
         AND con.conrelid = 'public.pos_settlements'::regclass`,
      [constraintName]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(`CHECK constraint ${constraintName} tidak ditemukan (contype='c')`);
      return;
    }
    const row = r.rows[0];

    // Terikat ke public.pos_settlements
    if (row.local_schema !== 'public' || row.local_table !== 'pos_settlements') {
      errors.push(
        `CHECK ${constraintName}: tabel asal=${row.local_schema}.${row.local_table}, ` +
        `ekspektasi public.pos_settlements`
      );
      return;
    }

    if (row.convalidated !== true) {
      errors.push(`CHECK ${constraintName}: convalidated=false (belum tervalidasi)`);
    }

    // Non-deferrable
    if (row.condeferrable !== false) {
      errors.push(`CHECK ${constraintName}: condeferrable=${row.condeferrable}, ekspektasi false (non-deferrable)`);
    }

    // ── Pencocokan bentuk terbatas ────────────────────────────────────────
    // Tidak memakai regex generik "buang cast". Masing-masing bentuk yang
    // diizinkan diuji eksplisit sehingga:
    //  - OR/AND di dalam predikat WAJIB ditolak.
    //  - Cast yang dikenal (per bentuk) diterima; yang lain ditolak.
    //  - Huruf & whitespace DI DALAM literal string tidak diubah.
    //
    // pg_get_expr sering mengembalikan bentuk terkurung, mis.
    //   "(amount > (0)::numeric)"          untuk  CHECK (amount > 0)
    //   "((status = 'SUCCESS'::character varying))"  untuk  status IN ('SUCCESS')
    // Kita menerima bentuk-bentuk tersebut secara eksplisit.

    const pred = String(row.pred ?? '');
    // Tolak OR/AND apa pun di dalam predikat CHECK (menandakan ekspresi
    // tambahan yang melemahkan constraint).
    if (/\bOR\b|\bAND\b/.test(pred)) {
      errors.push(
        `CHECK ${constraintName}: predikat mengandung OR/AND — bentuk tidak diizinkan: "${pred.trim()}"`
      );
      return;
    }

    // Bentuk-bentuk yang diizinkan per constraint (regex penuh, case-insensitif
    // untuk keyword SQL, LITERAL string case-sensitif, cast dikenal).
    const allowedShapes: RegExp[] = [];

    if (constraintName === 'chk_pos_settlements_amount_positive') {
      // CHECK (amount > 0): PostgreSQL menyimpan sebagai "(amount > (0)::numeric)"
      // Terima: amount > 0  dengan (0) boleh ber-cast ::numeric
      // Bentuk DDL & bentuk ter-parenthesize:
      allowedShapes.push(
        // (amount > (0)::numeric)  atau  amount > (0)::numeric
        /\(\s*amount\s*>\s*\(\s*0\s*\)\s*::\s*numeric\s*\)/i,
        /\(\s*amount\s*>\s*0\s*\)/i,
        /^\s*amount\s*>\s*\(\s*0\s*\)\s*::\s*numeric\s*$/i,
        /^\s*amount\s*>\s*0\s*$/i,
      );
    } else if (constraintName === 'chk_pos_settlements_status') {
      // status IN ('SUCCESS')  atau  status = 'SUCCESS'
      // Di PostgreSQL 15, IN tunggal diringkas jadi bentuk equality dengan
      // cast ::text pada KEDUA sisi, mis. ((status)::text = 'SUCCESS'::text).
      // Cast ::text diterima secara eksplisit (bukan regex generik); OR/AND
      // tetap ditolak di atas.
      allowedShapes.push(
        // IN form
        /\(\s*status\s+IN\s*\(\s*'SUCCESS'\s*\)\s*\)/i,
        // equality form, dengan cast ::text pada kedua sisi (bentuk PG 15)
        /\(\s*\(\s*status\s*\)\s*::\s*text\s*=\s*'SUCCESS'\s*::\s*text\s*\)/i,
        // equality form, dengan cast char yang dikenal:
        /\(\s*status\s*=\s*'SUCCESS'::character\s+varying\s*\)/i,
        // equality form, tanpa cast:
        /\(\s*status\s*=\s*'SUCCESS'\s*\)/i,
        // versi tanpa kurung terluar
        /^\s*status\s+IN\s*\(\s*'SUCCESS'\s*\)\s*$/i,
        /^\s*status\s*=\s*'SUCCESS'::character\s+varying\s*$/i,
        /^\s*status\s*=\s*'SUCCESS'\s*$/i,
      );
    }

    // Jika constraint tak dikenal, tidak ada bentuk yang diizinkan.
    if (allowedShapes.length === 0) {
      errors.push(
        `CHECK ${constraintName}: predikat tak dikenal untuk pencocokan bentuk — periksa helper`
      );
      return;
    }

    const matched = allowedShapes.some((re) => re.test(pred));

    if (!matched) {
      errors.push(
        `CHECK ${constraintName}: predikat="${pred.trim()}", ` +
        `bentuk tidak diizinkan (ekspansi OR/AND/cast-asing ditolak)`
      );
    }
  }

  // amount > 0 — bentuk tunggal, tanpa varian.
  await checkCheckConstraint('chk_pos_settlements_amount_positive', 'amount > 0', null);
  // status satu nilai: terima IN('SUCCESS') MAUPUN representasi ter-rewrite
  // "((status = 'SUCCESS'::character varying))".
  await checkCheckConstraint(
    'chk_pos_settlements_status',
    "status IN ('SUCCESS')",
    "status = 'SUCCESS'",
  );

  // ── Helper: periksa UNIQUE constraint ───────────────────────────────────
  // Query katalog: resolusi kolom melalui unnest(conkey) WITH ORDINALITY
  // (preserving urutan kolom key), bukan "ORDER BY attnum".
  // Verifikasi: tabel public.pos_settlements, urutan & jumlah kolom,
  // non-deferrable, tervalidasi, dan backing index valid/ready/live/unique.
  async function checkUniqueConstraint(
    constraintName: string,
    expCols: string[],
  ): Promise<void> {
    const r = await client.query(
      `WITH con AS (
         SELECT conname, contype, conrelid, conkey,
                condeferrable, convalidated, conindid
         FROM pg_constraint
         WHERE conname = $1 AND contype = 'u'
           AND conrelid = 'public.pos_settlements'::regclass
       )
       SELECT con.conname,
              con.condeferrable,
              con.convalidated,
              con.conkey,
              lt.relname  AS local_table,
              ln.nspname  AS local_schema,
              (SELECT array_agg(a.attname ORDER BY x.ord)
                 FROM unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum) AS cols,
              i.indisvalid  AS idx_valid,
              i.indisready  AS idx_ready,
              i.indislive   AS idx_live,
              i.indisunique AS idx_unique
       FROM con
       LEFT JOIN pg_class lt ON lt.oid = con.conrelid
       LEFT JOIN pg_namespace ln ON ln.oid = lt.relnamespace
       LEFT JOIN pg_index i ON i.indexrelid = con.conindid`,
      [constraintName]
    );
    if ((r.rowCount ?? 0) === 0) {
      errors.push(`UNIQUE constraint ${constraintName} tidak ditemukan (contype='u')`);
      return;
    }
    const row = r.rows[0];

    // Terikat ke public.pos_settlements
    if (row.local_schema !== 'public' || row.local_table !== 'pos_settlements') {
      errors.push(
        `UNIQUE ${constraintName}: tabel asal=${row.local_schema}.${row.local_table}, ` +
        `ekspektasi public.pos_settlements`
      );
      return;
    }

    const actualCols: string[] = Array.isArray(row.cols)
      ? row.cols.map(String)
      : String(row.cols || '')
          .replace(/^[{]+|\}+$/g, '')
          .split(',')
          .map((s: string) => s.trim());

    if (actualCols.length !== expCols.length) {
      errors.push(
        `UNIQUE ${constraintName}: kolom=[${actualCols.join(',')}], ` +
        `ekspektasi [${expCols.join(',')}], jumlah=${actualCols.length} ekspektasi ${expCols.length}`
      );
    } else {
      for (let i = 0; i < expCols.length; i++) {
        if (actualCols[i] !== expCols[i]) {
          errors.push(
            `UNIQUE ${constraintName}: kolom index ${i}=${actualCols[i]}, ekspektasi '${expCols[i]}'`
          );
        }
      }
    }

    // Non-deferrable
    if (row.condeferrable !== false) {
      errors.push(`UNIQUE ${constraintName}: condeferrable=${row.condeferrable}, ekspektasi false (non-deferrable)`);
    }

    // Tervalidasi
    if (row.convalidated !== true) {
      errors.push(`UNIQUE ${constraintName}: convalidated=false (belum tervalidasi)`);
    }

    // Backing index: valid/ready/live/unique
    if (row.idx_valid !== true) errors.push(`UNIQUE ${constraintName}: backing index indisvalid=false`);
    if (row.idx_ready !== true) errors.push(`UNIQUE ${constraintName}: backing index indisready=false`);
    if (row.idx_live !== true) errors.push(`UNIQUE ${constraintName}: backing index indislive=false`);
    if (row.idx_unique !== true) errors.push(`UNIQUE ${constraintName}: backing index indisunique=false`);
  }

  await checkUniqueConstraint('uq_pos_settlements_order', ['pos_order_id']);
  await checkUniqueConstraint('uq_pos_settlements_idempotency', ['property_id', 'pos_order_id', 'idempotency_key']);

  // ── Helper: periksa index btree ─────────────────────────────────────────
  // Query katalog: namespace diambil dari tabel ASAL (i.indrelid), bukan dari
  // namespace index. Tolak predicate (index non-partial), expression
  // (attnum=0), INCLUDE (indnatts != indnkeyatts), serta jumlah/urutan
  // kolom yang berbeda dari ekspektasi.
  async function checkIndex(
    idxName: string,
    expCols: string[],
    expUnique: boolean,
  ): Promise<void> {
    const q = await client.query(
      `SELECT
          am.amname            AS am_name,
          i.indisunique        AS indisunique,
          i.indisvalid         AS indisvalid,
          i.indisready         AS indisready,
          i.indislive          AS indislive,
          i.indnatts           AS indnatts,
          i.indnkeyatts        AS indnkeyatts,
          i.indrelid           AS indrelid,
          i.indkey::text       AS indkey_text,
          pg_get_expr(i.indpred, i.indrelid) AS indpred,
          tn.nspname           AS src_schema,
          tc.relname           AS src_table
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

    // Namespace dari tabel ASAL (bukan dari index)
    if (row.src_schema !== 'public' || row.src_table !== 'pos_settlements') {
      errors.push(
        `Index ${idxName}: tabel asal=${row.src_schema}.${row.src_table}, ` +
        `ekspektasi public.pos_settlements`
      );
      return;
    }

    if (row.am_name !== 'btree') {
      errors.push(`Index ${idxName}: AM=${row.am_name}, ekspektasi btree`);
    }

    if (row.indisunique !== expUnique) {
      errors.push(
        `Index ${idxName}: indisunique=${row.indisunique}, ` +
        `ekspektasi ${expUnique ? 'UNIQUE' : 'non-unique'}`
      );
    }

    if (row.indisvalid !== true) errors.push(`Index ${idxName}: indisvalid=false`);
    if (row.indisready !== true) errors.push(`Index ${idxName}: indisready=false`);
    if (row.indislive !== true) errors.push(`Index ${idxName}: indislive=false`);

    // Tolak predicate (index harus non-partial)
    const pred = row.indpred ? String(row.indpred).trim() : '';
    if (pred !== '') {
      errors.push(`Index ${idxName}: predicate="${pred}", ekspektasi tanpa predicate`);
    }

    // INCLUDE ditolak: indnatts === indnkeyatts
    const natts = Number(row.indnatts);
    const nkey = Number(row.indnkeyatts);
    if (natts !== nkey) {
      errors.push(
        `Index ${idxName}: indnatts=${natts} != indnkeyatts=${nkey} — INCLUDE/ekstra kolom terdeteksi`
      );
    } else if (nkey !== expCols.length) {
      errors.push(
        `Index ${idxName}: indnkeyatts=${nkey}, ekspektasi ${expCols.length}`
      );
    }

    const rawIndkey = String(row.indkey_text ?? '');
    const inner = rawIndkey.replace(/^[{]/, '').replace(/}$/, '');
    const attnums: number[] = inner
      .split(/[\s,]+/)
      .map((s: string) => Number(s.trim()))
      .filter((n: number) => !Number.isNaN(n));

    // Expression ditolak (attnum=0)
    if (attnums.some((n: number) => n === 0)) {
      errors.push(`Index ${idxName}: mengandung kolom expression (attnum=0)`);
    }

    // Jumlah kolom
    if (attnums.length !== expCols.length) {
      errors.push(
        `Index ${idxName}: indkey menghasilkan ${attnums.length} attnum, ` +
        `ekspektasi ${expCols.length}`
      );
    }

    // Resolusi nama kolom & urutan
    if (attnums.length === expCols.length && !attnums.some((n: number) => n === 0)) {
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
      for (const rr of nameQ.rows) attnumToName[Number(rr.attnum)] = rr.attname;
      const colNames = attnums.map((n: number) => attnumToName[n] ?? `(attnum=${n})`);
      for (let i = 0; i < expCols.length; i++) {
        if (colNames[i] !== expCols[i]) {
          errors.push(
            `Index ${idxName}: kolom index ${i}=${colNames[i]}, ekspektasi '${expCols[i]}'`
          );
        }
      }
    }
  }

  await checkIndex('idx_pos_settlements_order', ['property_id', 'pos_order_id'], false);

  // ── Verifikasi PRIMARY KEY (id) ─────────────────────────────────────────
  // PK harus ada di public.pos_settlements, terikat kolom id, dan valid.
  {
    const pkQ = await client.query(
      `SELECT con.conname,
              con.convalidated,
              con.condeferrable,
              a.attname AS col_name,
              i.indisvalid AS idx_valid,
              i.indisready AS idx_ready,
              i.indislive  AS idx_live
       FROM pg_constraint con
       JOIN pg_class lt ON lt.oid = con.conrelid
       JOIN pg_namespace ln ON ln.oid = lt.relnamespace
       LEFT JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
       LEFT JOIN pg_index i ON i.indexrelid = con.conindid
       WHERE con.contype = 'p'
         AND con.conrelid = 'public.pos_settlements'::regclass`,
    );
    if ((pkQ.rowCount ?? 0) === 0) {
      errors.push('PRIMARY KEY pada public.pos_settlements tidak ditemukan (contype="p")');
    } else {
      for (const pkRow of pkQ.rows) {
        const pkName = String(pkRow.conname || '');
        if (pkRow.col_name !== 'id') {
          errors.push(`PK ${pkName}: kolom=${pkRow.col_name}, ekspektasi 'id'`);
        }
        if (pkRow.convalidated !== true) {
          errors.push(`PK ${pkName}: convalidated=false`);
        }
        if (pkRow.condeferrable !== false) {
          errors.push(`PK ${pkName}: condeferrable=${pkRow.condeferrable}, ekspektasi false (non-deferrable)`);
        }
        if (pkRow.idx_valid !== true) errors.push(`PK ${pkName}: backing index indisvalid=false`);
        if (pkRow.idx_ready !== true) errors.push(`PK ${pkName}: backing index indisready=false`);
        if (pkRow.idx_live !== true) errors.push(`PK ${pkName}: backing index indislive=false`);
      }
    }
  }

  // ── Verifikasi DEFAULT kolom ────────────────────────────────────────────
  // Kolom yang boleh punya default:
  //   id          : nextval('pos_settlements_id_seq'::regclass) — sequence valid
  //   status      : 'SUCCESS'
  //   created_at  : CURRENT_TIMESTAMP / now() / localtimestamp
  // Kolom lain : default wajib NULL.
  {
    const defaultQ = await client.query(
      `SELECT c.column_name,
              c.column_default,
              s.relname AS seq_relname,
              s.relkind AS seq_relkind
       FROM information_schema.columns c
       LEFT JOIN pg_attribute a
         ON a.attrelid = 'public.pos_settlements'::regclass
        AND a.attname = c.column_name
       LEFT JOIN pg_attrdef ad
         ON ad.adrelid = a.attrelid
        AND ad.adnum = a.attnum
       LEFT JOIN pg_depend d
         ON d.classid = 'pg_attrdef'::regclass
        AND d.objid = ad.oid
        AND d.refclassid = 'pg_class'::regclass
        AND d.deptype = 'n'
       LEFT JOIN pg_class s ON s.oid = d.refobjid
       WHERE c.table_schema = 'public'
         AND c.table_name = 'pos_settlements'
       ORDER BY c.ordinal_position`,
    );

    // Normalisasi default: buang whitespace berlebih, uppercase
    const normDef = (s: string | null): string =>
      (s || '').replace(/\s+/g, ' ').trim().toUpperCase();

    // Default yang DILENGKAPIKANKAN per kolom
    const expectedDefaults: Record<string, string[]> = {
      id: [
        // nextval('pos_settlements_id_seq'::regclass) atau representasi ekuivalen
        "nextval('pos_settlements_id_seq'::regclass)",
      ],
      status: [
        "'success'",
        "'success'::character varying",
      ],
      created_at: [
        'current_timestamp',
        'now()',
        'localtimestamp',
      ],
    };

    for (const dRow of defaultQ.rows) {
      const col = String(dRow.column_name || '');
      const rawDef = dRow.column_default as string | null;
      const normalized = normDef(rawDef);

      // Tolak kolom selain expected dengan default tak terduga
      if (!(col in expectedDefaults)) {
        if (rawDef !== null) {
          errors.push(
            `Kolom pos_settlements.${col}: default=${JSON.stringify(rawDef)}, ` +
            `ekspektasi tanpa default`
          );
        }
        continue;
      }

      // Cek default untuk kolom expected
      const allowed = expectedDefaults[col];
      // Normalisasi allowed untuk perbandingan
      const allowedNorm = allowed.map((a) => normDef(a));

      // Untuk id: verifikasi default = nextval + sequence valid milik kolom id
      if (col === 'id') {
        if (!normalized.startsWith('NEXTVAL(')) {
          errors.push(
            `Kolom pos_settlements.id: default="${rawDef}", ` +
            `ekspektasi nextval('pos_settlements_id_seq'::regclass)`
          );
        } else {
          // Verifikasi dari hasil defaultQ: sequence terikat harus relkind='S'
          // dan bernama pos_settlements_id_seq (dependency dideklarasikan
          // oleh DDL SERIAL — deptype='i' dari kolom id).
          const seqRelname = dRow.seq_relname as string | null;
          const seqRelkind = dRow.seq_relkind as string | null;
          if (seqRelkind !== 'S') {
            errors.push(
              `Kolom pos_settlements.id: dependency sequence relkind=${seqRelkind}, ` +
              `ekspektasi 'S' (sequence); relname=${seqRelname}`
            );
          }
          if (seqRelname !== 'pos_settlements_id_seq') {
            errors.push(
              `Kolom pos_settlements.id: sequence dependency relname=${seqRelname}, ` +
              `ekspektasi 'pos_settlements_id_seq'`
            );
          }
        }
      }

      if (!allowedNorm.includes(normalized)) {
        errors.push(
          `Kolom pos_settlements.${col}: default="${rawDef}", ` +
          `ekspektasi salah satu: ${allowed.join(' | ')}`
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// =============================================================================
// Runner Migration
// =============================================================================

/**
 * Jalankan migration pos payment settlement. Transactional + advisory lock.
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
export async function runPosPaymentSettlementMigration(
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
      await client.query(POS_PAYMENT_SETTLEMENT_DDL);
    }

    const verify = await verifyPosPaymentSettlementSchema(client);
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

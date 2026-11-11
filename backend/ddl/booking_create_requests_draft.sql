-- DRAFT: booking_create_requests
-- Fase 2B-1 Unit 2 R1 — domain replay storage untuk booking create.
-- ADDITIVE & REVERSIBLE. TIDAK DIJALANKAN. Review hanya.
--
-- Prerequisite:
--   * Tabel bookings, properties sudah ada.
--   * bookings(id, property_id) UNIQUE composite — DIBUAT pada draft ini
--     bila belum ada (additive, idempotent via IF NOT EXISTS check).
--     Referensi composite FK (booking_id, property_id) → (id, property_id)
--     sama dengan yang sudah menjadi target payment_allocations.
--
-- Kontrak:
--   * Unique(property_id, request_key) — satu request per property per key.
--     Constraint ini juga menjadi index lookup (idx_bcr_prop_key tidak perlu
--     dibuat terpisah; UNIQUE constraint sudah menghasilkan index).
--   * Status lifecycle: PENDING → FINAL (terminal; tidak ada CANCELLED/EXPIRED).
--     PENDING: booking_id IS NULL, result IS NULL, finalized_at IS NULL.
--     FINAL:   booking_id NOT NULL, result NOT NULL (JSON object, bukan array),
--              response_status 200–399, finalized_at NOT NULL.
--   * fingerprint CHAR(64) SHA-256 hex64 lowercase; fingerprint_version > 0.
--   * request_key nonblank (min 1 karakter) dan hanya karakter aman
--     (alphanumeric, dot, underscore, hyphen) — sesuai validator service.
--   * Composite FK (booking_id, property_id) → bookings(id, property_id)
--     mencegah request property A menunjuk booking milik property B.
--   * payment_intent disimpan untuk audit, TIDAK bagian dari fingerprint
--     (caller wajib memasukkan field payment-intent ke dalam FP snapshot).
--   * Tidak ada auto-expires: replay domain tidak memakai timeout/polling.
--   * Tidak menggantikan cache global idempotency_keys (middleware layer).
--
-- Rollback draft (lihat bagian akhir): jaga history replay setelah tabel berisi data.
-- DROP CASCADE hanya boleh dijalankan secara eksplisit oleh DBA setelah
-- verifikasi bahwa tidak ada row yang perlu diarsipkan.

BEGIN;

-- Prerequisite: composite unique pada bookings(id, property_id)
-- Diperlukan untuk composite FK booking_create_requests(booking_id, property_id).
-- Idempotent: hanya dibuat bila belum ada.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_bookings_id_property'
  ) THEN
    ALTER TABLE bookings
      ADD CONSTRAINT uq_bookings_id_property UNIQUE (id, property_id);
  END IF;
END $$;

-- Tabel utama
CREATE TABLE IF NOT EXISTS booking_create_requests (
  id            BIGSERIAL    PRIMARY KEY,
  property_id   INTEGER      NOT NULL
    REFERENCES properties(id) ON DELETE RESTRICT,

  -- request_key: 1-200 char, alphanumeric + dot/underscore/hyphen
  request_key   VARCHAR(200) NOT NULL
    CHECK (request_key ~ '^[a-zA-Z0-9._-]+$' AND length(request_key) >= 1),

  -- Lifecycle: PENDING → FINAL (terminal)
  status        VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'FINAL')),

  -- Deterministic SHA-256 hex64 lowercase fingerprint
  fingerprint   CHAR(64)     NOT NULL
    CHECK (fingerprint ~ '^[a-f0-9]{64}$'),

  -- Bump saat snapshot shape berubah; harus > 0
  fingerprint_version INTEGER NOT NULL DEFAULT 1
    CHECK (fingerprint_version > 0),

  -- Normalized payment intent (JSON snapshot untuk audit; TIDAK bagian FP)
  payment_intent  JSONB      NULL,

  -- Set saat FINAL
  booking_id      BIGINT     NULL
    CHECK (booking_id IS NULL OR booking_id > 0),
  result          JSONB      NULL
    CHECK (
      status = 'PENDING'
      OR (
        result IS NOT NULL
        AND jsonb_typeof(result) = 'object'
        AND NOT (result = 'null'::jsonb)
      )
    ),
  response_status INTEGER    NULL
    CHECK (
      status = 'PENDING'
      OR (response_status IS NOT NULL AND response_status >= 200 AND response_status <= 399)
    ),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_at  TIMESTAMPTZ NULL
    CHECK (status = 'PENDING' OR finalized_at IS NOT NULL),

  -- State consistency: PENDING tidak boleh menyimpan FINAL fields
  CONSTRAINT chk_bcr_pending_clean CHECK (
    status = 'FINAL'
    OR (booking_id IS NULL AND result IS NULL AND finalized_at IS NULL)
  ),

  -- BU-R2-06: FINAL harus memiliki booking_id valid (> 0)
  CONSTRAINT chk_bcr_final_complete CHECK (
    status = 'PENDING'
    OR (booking_id IS NOT NULL AND booking_id > 0)
  ),

  -- Unique per property per key (juga berfungsi sebagai index lookup)
  CONSTRAINT uq_bcr_property_key UNIQUE (property_id, request_key),

  -- Composite FK: booking_id+property_id harus merujuk ke bookings yang ada
  -- Mencegah request property A menunjuk booking milik property B
  CONSTRAINT fk_bcr_booking_composite
    FOREIGN KEY (booking_id, property_id)
    REFERENCES bookings(id, property_id)
    ON DELETE RESTRICT
);

-- Index untuk finalize: PENDING rows per property
-- uq_bcr_property_key (UNIQUE constraint) sudah menyediakan index lookup
-- (property_id, request_key) — idx_bcr_prop_key TIDAK dibuat terpisah.
CREATE INDEX IF NOT EXISTS idx_bcr_prop_status
  ON booking_create_requests (property_id, status);

-- Index audit: lookup FINAL rows per fingerprint (opsional, murah)
CREATE INDEX IF NOT EXISTS idx_bcr_fp_lookup
  ON booking_create_requests (fingerprint, fingerprint_version);

COMMIT;

-- REVERSAL (hanya dokumentasi; TIDAK dijalankan otomatis)
-- Peringatan: DROP menghapus seluruh riwayat replay yang mungkin masih
-- dibutuhkan untuk audit. DBA harus backup atau arsipkan row FINAL
-- sebelum menjalankan rollback.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_bcr_fp_lookup;
--   DROP INDEX IF EXISTS idx_bcr_prop_status;
--   DROP TABLE IF EXISTS booking_create_requests;
--   (JANGAN gunakan CASCADE: FK composite terdefinisi pada booking_create_requests,
--    bukan pada bookings. bookings tetap utuh tanpa dampak.)
--
-- Composite constraint uq_bookings_id_property pada bookings TIDAK dihapus
-- saat rollback (additive constraint pada tabel yang sudah ada).
-- Jalankan secara terpisah hanya bila tidak ada pengguna lain:
--   ALTER TABLE bookings DROP CONSTRAINT uq_bookings_id_property;

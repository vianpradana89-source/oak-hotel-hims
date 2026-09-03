import { Pool } from 'pg';
import { initializeDatabase as initializeV2 } from './schema_v2';
import { seedBaselineStayChargeRules } from '../domains/stayCharges/stayChargeRuleDefaults';

export async function initializeDatabase(pool: Pool) {
  // Run v2 initialization first (creates availability tables)
  await initializeV2(pool);

  // Add idempotency_keys table
  const q = `
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      request_hash VARCHAR(128) NOT NULL,
      response_body TEXT,
      response_headers TEXT,
      status_code INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payment_transactions (
      id SERIAL PRIMARY KEY,
      reservation_id INTEGER REFERENCES reservations(id),
      transaction_type VARCHAR(30) NOT NULL DEFAULT 'PAYMENT',
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      payment_method VARCHAR(30) DEFAULT 'CASH',
      reference_code VARCHAR(100),
      status VARCHAR(30) DEFAULT 'SUCCESS',
      reference_payment_id INTEGER REFERENCES payment_transactions(id) ON DELETE SET NULL,
      correction_group_id VARCHAR(100),
      reason_code VARCHAR(50),
      reason_text TEXT,
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS folio_entries (
      id SERIAL PRIMARY KEY,
      reservation_id INTEGER REFERENCES reservations(id),
      entry_type VARCHAR(30) NOT NULL,
      description VARCHAR(200),
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      direction VARCHAR(10) NOT NULL DEFAULT 'DEBIT',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payment_evidences (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
      reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
      payment_transaction_id INTEGER NOT NULL REFERENCES payment_transactions(id) ON DELETE RESTRICT,
      evidence_type VARCHAR(50) NOT NULL,
      storage_key VARCHAR(500) NOT NULL,
      original_filename VARCHAR(255) NOT NULL,
      mime_type VARCHAR(100) NOT NULL,
      file_size_bytes BIGINT NOT NULL,
      note TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      uploaded_by_user_id VARCHAR(100),
      uploaded_by_name_snapshot VARCHAR(150),
      uploaded_by_role_snapshot VARCHAR(100),
      uploaded_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      deactivated_by_user_id VARCHAR(100),
      deactivated_by_name_snapshot VARCHAR(150),
      deactivated_by_role_snapshot VARCHAR(100),
      deactivated_at TIMESTAMP WITHOUT TIME ZONE,
      deactivation_reason TEXT,
      created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_payment_evidences_payment ON payment_evidences (payment_transaction_id);
    CREATE INDEX IF NOT EXISTS idx_payment_evidences_reservation ON payment_evidences (reservation_id);
    CREATE INDEX IF NOT EXISTS idx_payment_evidences_property ON payment_evidences (property_id);
    CREATE INDEX IF NOT EXISTS idx_payment_evidences_uploaded_at ON payment_evidences (uploaded_at);
    CREATE INDEX IF NOT EXISTS idx_payment_evidences_active ON payment_evidences (is_active);

    DO $$
    BEGIN
      ALTER TABLE properties ALTER COLUMN address DROP NOT NULL;
    EXCEPTION
      WHEN OTHERS THEN NULL;
    END $$;

    DO $$
    BEGIN
      ALTER TABLE properties ALTER COLUMN phone DROP NOT NULL;
    EXCEPTION
      WHEN OTHERS THEN NULL;
    END $$;

    CREATE TABLE IF NOT EXISTS property_brandings (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL UNIQUE REFERENCES properties(id) ON DELETE CASCADE,
      display_name VARCHAR(200),
      short_name VARCHAR(20),
      tagline VARCHAR(255),
      primary_color VARCHAR(20) DEFAULT '#1b4332',
      accent_color VARCHAR(20) DEFAULT '#c5a880',
      logo_url VARCHAR(500),
      compact_logo_url VARCHAR(500),
      created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_property_brandings_property ON property_brandings (property_id);

    CREATE TABLE IF NOT EXISTS housekeeping_tasks (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id),
      room_number VARCHAR(10),
      task_type VARCHAR(30) NOT NULL DEFAULT 'ROOM_SERVICE',
      priority VARCHAR(20) DEFAULT 'MEDIUM',
      status VARCHAR(20) DEFAULT 'PENDING',
      assignee VARCHAR(100),
      notes TEXT,
      due_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS task_number VARCHAR(60);
    CREATE INDEX IF NOT EXISTS idx_housekeeping_tasks_task_number ON housekeeping_tasks (task_number);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_housekeeping_tasks_task_number ON housekeeping_tasks (task_number) WHERE task_number IS NOT NULL;

    CREATE TABLE IF NOT EXISTS maintenance_tasks (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id),
      room_number VARCHAR(10),
      issue_type VARCHAR(30) NOT NULL DEFAULT 'GENERAL',
      priority VARCHAR(20) DEFAULT 'MEDIUM',
      status VARCHAR(20) DEFAULT 'OPEN',
      assignee VARCHAR(100),
      notes TEXT,
      due_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS room_operational_blocks (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
      room_type_id INTEGER NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
      block_type VARCHAR(20) NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      reason VARCHAR(255),
      maintenance_task_id INTEGER REFERENCES maintenance_tasks(id) ON DELETE SET NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
      created_by VARCHAR(100),
      created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      released_by VARCHAR(100),
      released_at TIMESTAMP WITHOUT TIME ZONE,
      CONSTRAINT chk_room_operational_blocks_dates CHECK (end_date > start_date),
      CONSTRAINT chk_room_operational_blocks_type CHECK (block_type IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE')),
      CONSTRAINT chk_room_operational_blocks_status CHECK (status IN ('ACTIVE', 'RELEASED', 'CANCELLED'))
    );

    CREATE INDEX IF NOT EXISTS idx_room_operational_blocks_prop_status_dates
      ON room_operational_blocks (property_id, status, start_date, end_date);
    CREATE INDEX IF NOT EXISTS idx_room_operational_blocks_room_status_dates
      ON room_operational_blocks (room_id, status, start_date, end_date);
    CREATE INDEX IF NOT EXISTS idx_room_operational_blocks_room_type_dates
      ON room_operational_blocks (room_type_id, status, start_date, end_date);

    CREATE TABLE IF NOT EXISTS pos_menu_categories (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id),
      name VARCHAR(100) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pos_menu_items (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id),
      category_id INTEGER REFERENCES pos_menu_categories(id),
      item_code VARCHAR(50),
      name VARCHAR(100) NOT NULL,
      description TEXT,
      price DECIMAL(12,2) NOT NULL DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pos_orders (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id),
      reservation_id INTEGER REFERENCES reservations(id),
      order_number VARCHAR(50),
      table_number VARCHAR(20),
      guest_name VARCHAR(100),
      status VARCHAR(30) DEFAULT 'OPEN',
      total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_pos_order_number_per_property UNIQUE (property_id, order_number)
    );

    CREATE TABLE IF NOT EXISTS pos_order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES pos_orders(id),
      menu_item_id INTEGER REFERENCES pos_menu_items(id),
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price DECIMAL(12,2) NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS accounting_gl_accounts (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id),
      code VARCHAR(50) NOT NULL,
      name VARCHAR(150) NOT NULL,
      account_type VARCHAR(40) NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_accounting_gl_accounts_code_per_property UNIQUE (property_id, code)
    );

    CREATE TABLE IF NOT EXISTS accounting_journal_entries (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id),
      entry_number VARCHAR(50),
      entry_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      description VARCHAR(200),
      source_module VARCHAR(50),
      source_ref VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_journal_entries_number_per_property UNIQUE (property_id, entry_number)
    );

    CREATE TABLE IF NOT EXISTS accounting_journal_lines (
      id SERIAL PRIMARY KEY,
      journal_entry_id INTEGER REFERENCES accounting_journal_entries(id),
      account_id INTEGER REFERENCES accounting_gl_accounts(id),
      debit DECIMAL(12,2) DEFAULT 0,
      credit DECIMAL(12,2) DEFAULT 0,
      description VARCHAR(200),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vendor_payables (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id),
      vendor_name VARCHAR(150) NOT NULL,
      invoice_number VARCHAR(100),
      due_date TIMESTAMP,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      status VARCHAR(30) DEFAULT 'OPEN',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS guest_receivables (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id),
      reservation_id INTEGER REFERENCES reservations(id),
      guest_name VARCHAR(150),
      total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      paid_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      status VARCHAR(30) DEFAULT 'OPEN',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- @deprecated: Legacy unlinked guest_profiles table superseded by canonical guests & reservation_guests tables (Phase GO-LIVE-GUEST-B1)
    CREATE TABLE IF NOT EXISTS guest_profiles (
      id SERIAL PRIMARY KEY,
      full_name VARCHAR(150) NOT NULL,
      email VARCHAR(150),
      phone VARCHAR(50),
      id_number VARCHAR(50),
      nationality VARCHAR(80),
      birth_date DATE,
      preferences TEXT,
      loyalty_tier VARCHAR(30) DEFAULT 'REGULAR',
      notes TEXT,
      is_blacklisted BOOLEAN DEFAULT FALSE,
      privacy_flags TEXT DEFAULT '{}',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Phase GO-LIVE-GUEST-B1: Canonical Guest Master table
    CREATE TABLE IF NOT EXISTS guests (
      id SERIAL PRIMARY KEY,
      full_name VARCHAR(255) NOT NULL,
      preferred_name VARCHAR(100),
      gender VARCHAR(20),
      birth_place VARCHAR(100),
      birth_date DATE,
      nationality VARCHAR(100) DEFAULT 'ID',
      phone VARCHAR(50),
      email VARCHAR(255),
      address TEXT,
      city VARCHAR(100),
      province VARCHAR(100),
      country VARCHAR(100) DEFAULT 'Indonesia',
      vip_status VARCHAR(50) NOT NULL DEFAULT 'STANDARD',
      is_blacklisted BOOLEAN NOT NULL DEFAULT FALSE,
      blacklist_reason TEXT,
      notes TEXT,
      created_property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      created_by VARCHAR(100),
      CONSTRAINT chk_guests_vip_status CHECK (vip_status IN ('STANDARD', 'VIP', 'VVIP')),
      CONSTRAINT chk_guests_gender CHECK (gender IS NULL OR gender IN ('MALE', 'FEMALE', 'OTHER'))
    );

    ALTER TABLE guests ADD COLUMN IF NOT EXISTS created_property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL;
    UPDATE guests SET created_property_id = 1 WHERE created_property_id IS NULL AND created_by = 'MIGRATION_GUEST_B1';

    CREATE INDEX IF NOT EXISTS idx_guests_phone ON guests (phone);
    CREATE INDEX IF NOT EXISTS idx_guests_email ON guests (email);
    CREATE INDEX IF NOT EXISTS idx_guests_full_name_lower ON guests (LOWER(full_name));
    CREATE INDEX IF NOT EXISTS idx_guests_created_property_id ON guests (created_property_id);

    -- Phase GO-LIVE-GUEST-B1: Reservation-Guest Relational Bridge
    CREATE TABLE IF NOT EXISTS reservation_guests (
      id SERIAL PRIMARY KEY,
      reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
      guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE RESTRICT,
      role VARCHAR(50) NOT NULL,
      relationship VARCHAR(100),
      is_staying BOOLEAN NOT NULL DEFAULT TRUE,
      identity_verified BOOLEAN NOT NULL DEFAULT FALSE,
      relation_source VARCHAR(100) NOT NULL DEFAULT 'MANUAL_ENTRY',
      is_legacy_inferred BOOLEAN NOT NULL DEFAULT FALSE,
      checked_in_at TIMESTAMP WITH TIME ZONE,
      checked_out_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_reservation_guests_role CHECK (role IN ('BOOKER', 'PRIMARY_GUEST', 'ADDITIONAL_GUEST'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_reservation_single_primary_guest
      ON reservation_guests (reservation_id)
      WHERE role = 'PRIMARY_GUEST';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_reservation_guest_role
      ON reservation_guests (reservation_id, guest_id, role);

    CREATE INDEX IF NOT EXISTS idx_reservation_guests_reservation_id
      ON reservation_guests (reservation_id);

    CREATE INDEX IF NOT EXISTS idx_reservation_guests_guest_id
      ON reservation_guests (guest_id);

    CREATE TABLE IF NOT EXISTS guest_profile_history (
      id SERIAL PRIMARY KEY,
      guest_id INTEGER REFERENCES guest_profiles(id),
      changed_by VARCHAR(100),
      change_type VARCHAR(50),
      old_value TEXT,
      new_value TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS hr_employees (
      id SERIAL PRIMARY KEY,
      employee_code VARCHAR(30) UNIQUE,
      full_name VARCHAR(150) NOT NULL,
      position VARCHAR(100),
      department VARCHAR(80),
      hire_date DATE,
      monthly_salary DECIMAL(12,2) DEFAULT 0,
      status VARCHAR(30) DEFAULT 'ACTIVE',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payroll_records (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER REFERENCES hr_employees(id),
      period VARCHAR(30),
      base_salary DECIMAL(12,2) DEFAULT 0,
      bonus DECIMAL(12,2) DEFAULT 0,
      deductions DECIMAL(12,2) DEFAULT 0,
      net_salary DECIMAL(12,2) DEFAULT 0,
      status VARCHAR(30) DEFAULT 'DRAFT',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS roles (
      id SERIAL PRIMARY KEY,
      name VARCHAR(50) UNIQUE NOT NULL,
      description TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
      employee_id INTEGER REFERENCES hr_employees(id) ON DELETE RESTRICT,
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
      username VARCHAR(100) NOT NULL,
      email VARCHAR(150) NOT NULL,
      password_hash VARCHAR(255),
      full_name VARCHAR(150) NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      account_status VARCHAR(30) NOT NULL DEFAULT 'READY',
      must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
      activated_at TIMESTAMP WITH TIME ZONE,
      temp_password_expires_at TIMESTAMP WITH TIME ZONE,
      google_sub VARCHAR(255),
      google_email VARCHAR(150),
      google_linked_at TIMESTAMP WITH TIME ZONE,
      local_password_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      last_login_at TIMESTAMP WITH TIME ZONE,
      last_login_provider VARCHAR(20),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  await pool.query(q);

  // Property Master owns the canonical currency field. Preserve the legacy
  // currency_code column for compatibility while backfilling only absent data.
  await pool.query(`
    ALTER TABLE properties ADD COLUMN IF NOT EXISTS currency VARCHAR(3);

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'properties'
          AND column_name = 'currency_code'
      ) THEN
        UPDATE properties
        SET currency = UPPER(BTRIM(currency_code))
        WHERE (currency IS NULL OR BTRIM(currency) = '')
          AND currency_code IS NOT NULL
          AND BTRIM(currency_code) <> '';
      END IF;
    END $$;

    UPDATE properties
    SET currency = 'IDR'
    WHERE currency IS NULL OR BTRIM(currency) = '';

    ALTER TABLE properties ALTER COLUMN currency SET DEFAULT 'IDR';
  `);

  // Bookings foundation: canonical booking entity required by reservation FK.
  // Idempotent CREATE TABLE + triggers. Mirrors 1d_1_bookings_schema.sql
  // production migration but lives in bootstrap for fresh-DB support.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id BIGSERIAL PRIMARY KEY,
      bid VARCHAR(32) NOT NULL,
      property_id INTEGER NOT NULL REFERENCES properties(id),
      guest_name_snapshot VARCHAR(150) NOT NULL,
      guest_phone_snapshot VARCHAR(50) NULL,
      booking_source VARCHAR(20) NOT NULL DEFAULT 'WALKIN',
      channel VARCHAR(40) NULL,
      booking_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
      currency_code CHAR(3) NOT NULL DEFAULT 'IDR',
      legacy_booking_number VARCHAR(50) NULL,
      created_by VARCHAR(100) NULL,
      correlation_id VARCHAR(100) NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT bookings_bid_unique UNIQUE (bid),
      CONSTRAINT bookings_status_check CHECK (booking_status IN ('ACTIVE', 'CANCELLED', 'COMPLETED')),
      CONSTRAINT bookings_currency_upper_check CHECK (currency_code = upper(currency_code)),
      CONSTRAINT bookings_bid_format_check CHECK (bid ~ '^[A-Z0-9-]+$')
    );

    CREATE OR REPLACE FUNCTION bookings_set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'bookings_set_updated_at') THEN
        CREATE TRIGGER bookings_set_updated_at
        BEFORE UPDATE ON bookings
        FOR EACH ROW
        EXECUTE FUNCTION bookings_set_updated_at();
      END IF;
    END $$;

    CREATE OR REPLACE FUNCTION bookings_prevent_bid_change()
    RETURNS TRIGGER AS $$
    BEGIN
      IF OLD.bid IS DISTINCT FROM NEW.bid THEN
        RAISE EXCEPTION 'booking BID is immutable: % -> %', OLD.bid, NEW.bid;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'bookings_prevent_bid_change') THEN
        CREATE TRIGGER bookings_prevent_bid_change
        BEFORE UPDATE OF bid ON bookings
        FOR EACH ROW
        EXECUTE FUNCTION bookings_prevent_bid_change();
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS bookings_property_id_idx
      ON bookings (property_id);
  `);

  // Ensure reservation columns exist for older deployments and fresh DB.
  // booking_id and stay_sequence MUST exist before NOT NULL enforcement.
  await pool.query(`
    ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS response_headers TEXT;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS booking_id BIGINT NULL;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS stay_sequence SMALLINT NULL;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS booking_type VARCHAR(20) DEFAULT 'WALKIN';
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'CONFIRMED';
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMP;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS checked_out_at TIMESTAMP;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS stay_status VARCHAR(30) DEFAULT 'RESERVED';
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS guest_segment VARCHAR(20) DEFAULT 'Reguler';
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS ktp_path VARCHAR(500);
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS bukti_bayar_path VARCHAR(500);
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS discount_amount DECIMAL(12,2) DEFAULT 0;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS discount_percent DECIMAL(5,2) DEFAULT 0;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS discount_reason VARCHAR(255);
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS amount_paid DECIMAL(12,2) DEFAULT 0;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS applied_deposit DECIMAL(12,2) DEFAULT 0;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS remaining_balance DECIMAL(12,2) DEFAULT 0;
  `);

  // The applied-deposit backfill below predicates on canonical financial state.
  // These definitions match their later additive migrations so fresh databases
  // have the required columns before the historical correction can run.
  await pool.query(`
    ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS is_voided BOOLEAN DEFAULT FALSE;
    ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS reversal_of_entry_id INTEGER REFERENCES folio_entries(id) ON DELETE SET NULL;
    ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'POSTED';
  `);

  // ==========================================================================
  // Financial invariant backfill: applied_deposit + amount_paid correction.
  // Wrapped in migration_marker so it runs ONCE per database, not every start.
  // On subsequent startups, the marker prevents re-execution entirely.
  // ==========================================================================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(100) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const _depMarker = await pool.query(
    "SELECT 1 FROM schema_migrations WHERE version = 'applied_deposit_financial_correction_v1'"
  );
  if ((_depMarker.rowCount ?? 0) === 0) {
    const _depClient = await pool.connect();
    try {
      await _depClient.query('BEGIN');
      await _depClient.query("SELECT pg_advisory_xact_lock(hashtext('oak_hims_applied_deposit_backfill_lock'))");

      const _depRecheck = await _depClient.query(
        "SELECT 1 FROM schema_migrations WHERE version = 'applied_deposit_financial_correction_v1'"
      );
      if ((_depRecheck.rowCount ?? 0) === 0) {
        // Predicate alignment note:
        // All fallback guards below match stayChargesService.ts recalculateReservationFinancials exactly:
        //   Payment fallback: row existence (NOT SUM) → matches runtime hasPaymentTx.rowCount === 0
        //   Folio fallback guard: v_folio_ordinary > 0 → matches runtime folioPaid > 0
        //   Charges fallback: row existence (NOT SUM) → matches runtime chargeCount > 0
        await _depClient.query(`
          DO $$
          DECLARE
            rec RECORD;
            v_ordinary NUMERIC;
            v_applied NUMERIC;
            v_charges NUMERIC;
            v_remain NUMERIC;
            v_status TEXT;
            v_folio_ordinary NUMERIC;
            v_has_pmt_rows BOOLEAN;
            v_has_charge_rows BOOLEAN;
          BEGIN
            FOR rec IN
              WITH deposit_calc AS (
                SELECT
                  fe.reservation_id,
                  COALESCE(SUM(CASE
                    WHEN fe.direction = 'CREDIT' AND fe.entry_type = 'DEPOSIT_APPLY'
                      AND fe.status = 'POSTED' AND fe.is_voided = FALSE
                      AND fe.reversal_of_entry_id IS NULL
                    THEN fe.amount ELSE 0
                  END), 0) AS new_applied_deposit
                FROM folio_entries fe
                WHERE fe.entry_type = 'DEPOSIT_APPLY'
                GROUP BY fe.reservation_id
              )
              SELECT DISTINCT r.id AS rid, r.total_price AS tp,
                COALESCE(dc.new_applied_deposit, 0) AS ad
              FROM reservations r
              LEFT JOIN deposit_calc dc ON dc.reservation_id = r.id
              WHERE COALESCE(dc.new_applied_deposit, 0) > 0
            LOOP
              -- A. Ordinary payment from payment_transactions (authoritative source)
              SELECT COALESCE(SUM(CASE
                WHEN pt.status = 'SUCCESS' AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
                THEN pt.amount ELSE 0
              END), 0) INTO v_ordinary
              FROM payment_transactions pt WHERE pt.reservation_id = rec.rid;

              -- B. Payment fallback: ONLY if NO payment_transactions rows exist
              --    (matches runtime hasPaymentTx check — row existence, NOT sum)
              SELECT EXISTS (
                SELECT 1 FROM payment_transactions
                WHERE reservation_id = rec.rid
                  AND transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
                LIMIT 1
              ) INTO v_has_pmt_rows;

              IF NOT v_has_pmt_rows THEN
                SELECT COALESCE(SUM(CASE WHEN fe.direction = 'CREDIT' AND fe.entry_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT') AND fe.reversal_of_entry_id IS NULL THEN fe.amount ELSE 0 END), 0)
                  - COALESCE(SUM(CASE WHEN fe.direction = 'DEBIT' AND fe.entry_type IN ('PAYMENT_VOID', 'PAYMENT_REVERSAL') THEN fe.amount ELSE 0 END), 0)
                INTO v_folio_ordinary
                FROM folio_entries fe WHERE fe.reservation_id = rec.rid;

                IF v_folio_ordinary > 0 THEN
                  v_ordinary := v_folio_ordinary;
                END IF;
              END IF;

              -- C. Effective total charges from folio
              SELECT GREATEST(0,
                COALESCE(SUM(CASE WHEN fe.direction = 'DEBIT' AND fe.entry_type NOT IN ('PAYMENT_VOID','PAYMENT_REVERSAL','REFUND_DEBIT') THEN fe.amount ELSE 0 END), 0)
                - COALESCE(SUM(CASE WHEN fe.direction = 'CREDIT' AND (fe.reversal_of_entry_id IS NOT NULL OR fe.entry_type = 'REVERSAL' OR fe.entry_type LIKE '%_REVERSAL') THEN fe.amount ELSE 0 END), 0)
              ) INTO v_charges
              FROM folio_entries fe WHERE fe.reservation_id = rec.rid;

              -- D. Charges fallback: ONLY if NO folio charge DEBIT rows exist
              --    (matches runtime chargeCount check — row existence, NOT sum)
              SELECT EXISTS (
                SELECT 1 FROM folio_entries
                WHERE reservation_id = rec.rid
                  AND direction = 'DEBIT'
                  AND entry_type NOT IN ('PAYMENT_VOID','PAYMENT_REVERSAL','REFUND_DEBIT')
                LIMIT 1
              ) INTO v_has_charge_rows;

              IF NOT v_has_charge_rows THEN
                SELECT COALESCE(SUM(total_amount), 0) INTO v_charges
                FROM reservation_nightly_rates WHERE reservation_id = rec.rid;
                IF v_charges = 0 THEN
                  v_charges := rec.tp;
                END IF;
              END IF;

              v_applied := rec.ad;
              v_remain := GREATEST(0, v_charges - v_ordinary - v_applied);
              IF v_ordinary + v_applied <= 0 THEN v_status := 'UNPAID';
              ELSIF v_remain = 0 THEN v_status := 'PAID';
              ELSE v_status := 'PARTIAL';
              END IF;

              UPDATE reservations SET
                amount_paid = GREATEST(0, ROUND(v_ordinary)),
                applied_deposit = GREATEST(0, ROUND(v_applied)),
                remaining_balance = GREATEST(0, ROUND(v_remain)),
                payment_status = v_status
              WHERE id = rec.rid;
            END LOOP;
          END $$;
        `);

        await _depClient.query(
          "INSERT INTO schema_migrations (version) VALUES ('applied_deposit_financial_correction_v1') ON CONFLICT (version) DO NOTHING"
        );
      }

      await _depClient.query('COMMIT');
    } catch (_depErr) {
      await _depClient.query('ROLLBACK');
      throw _depErr;
    } finally {
      _depClient.release();
    }
  }

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reservations_booking_id_fkey') THEN
        ALTER TABLE reservations
          ADD CONSTRAINT reservations_booking_id_fkey
          FOREIGN KEY (booking_id) REFERENCES bookings(id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reservations_stay_sequence_check') THEN
        ALTER TABLE reservations
          ADD CONSTRAINT reservations_stay_sequence_check
          CHECK (stay_sequence IS NULL OR stay_sequence > 0);
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS reservations_booking_id_idx
      ON reservations (booking_id);
    CREATE UNIQUE INDEX IF NOT EXISTS reservations_booking_id_stay_sequence_key
      ON reservations (booking_id, stay_sequence)
      WHERE booking_id IS NOT NULL AND stay_sequence IS NOT NULL;

    DO $$
    BEGIN
      IF (SELECT COUNT(*) FROM reservations WHERE booking_id IS NULL) > 0 THEN
        RAISE EXCEPTION 'Cannot enforce NOT NULL on reservations.booking_id because null values still exist';
      END IF;
      IF (SELECT COUNT(*) FROM reservations WHERE stay_sequence IS NULL) > 0 THEN
        RAISE EXCEPTION 'Cannot enforce NOT NULL on reservations.stay_sequence because null values still exist';
      END IF;
      ALTER TABLE reservations ALTER COLUMN booking_id SET NOT NULL;
      ALTER TABLE reservations ALTER COLUMN stay_sequence SET NOT NULL;
    END $$;
  `);

  // Housekeeping and maintenance seed data removed — property_id required
  // POS menu seed data removed — property_id required

  // POS menu property isolation (idempotent for existing DBs)
  await pool.query(`
    ALTER TABLE pos_menu_categories ADD COLUMN IF NOT EXISTS property_id INTEGER;
    ALTER TABLE pos_menu_items ADD COLUMN IF NOT EXISTS property_id INTEGER;

    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pos_menu_categories' AND column_name='property_id' AND is_nullable='YES') THEN
        UPDATE pos_menu_categories pmc
        SET property_id = p.id
        FROM properties p
        WHERE pmc.property_id IS NULL
          AND (
            p.property_code = 'LWG'
            OR p.name = 'OAK Lawang'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM properties p2
            WHERE p2.id <> p.id
              AND (p2.property_code = 'LWG' OR p2.name = 'OAK Lawang')
          );
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pos_menu_items' AND column_name='property_id' AND is_nullable='YES') THEN
        UPDATE pos_menu_items pmi
        SET property_id = p.id
        FROM properties p
        WHERE pmi.property_id IS NULL
          AND (
            p.property_code = 'LWG'
            OR p.name = 'OAK Lawang'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM properties p2
            WHERE p2.id <> p.id
              AND (p2.property_code = 'LWG' OR p2.name = 'OAK Lawang')
          );
      END IF;
    END $$;

    ALTER TABLE pos_menu_categories ALTER COLUMN property_id SET NOT NULL;
    ALTER TABLE pos_menu_items ALTER COLUMN property_id SET NOT NULL;

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_pmc_property') THEN
        ALTER TABLE pos_menu_categories ADD CONSTRAINT fk_pmc_property FOREIGN KEY (property_id) REFERENCES properties(id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_pmi_property') THEN
        ALTER TABLE pos_menu_items ADD CONSTRAINT fk_pmi_property FOREIGN KEY (property_id) REFERENCES properties(id);
      END IF;
    END $$;

    CREATE UNIQUE INDEX IF NOT EXISTS uq_pmc_property_name ON pos_menu_categories(property_id, name);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_pmi_property_code ON pos_menu_items(property_id, item_code) WHERE item_code IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_pmc_property ON pos_menu_categories(property_id);
    CREATE INDEX IF NOT EXISTS idx_pmi_property ON pos_menu_items(property_id);

    CREATE OR REPLACE FUNCTION pos_menu_items_enforce_property_scope()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.category_id IS NOT NULL THEN
        IF (SELECT property_id FROM pos_menu_categories WHERE id = NEW.category_id) IS DISTINCT FROM NEW.property_id THEN
          RAISE EXCEPTION 'POS menu item property_id must match its category property_id';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'pos_menu_items_enforce_property_scope') THEN
        CREATE TRIGGER pos_menu_items_enforce_property_scope
        BEFORE INSERT OR UPDATE OF property_id, category_id ON pos_menu_items
        FOR EACH ROW
        EXECUTE FUNCTION pos_menu_items_enforce_property_scope();
      END IF;
    END $$;
  `);

  // POS order property isolation (idempotent for existing DBs)
  // pos_orders row count MUST be zero before property_id can be backfilled.
  // If rows unexpectedly exist, abort to force manual classification.
  await pool.query(`
    DO $$
    DECLARE
      v_count BIGINT;
    BEGIN
      SELECT COUNT(*) INTO v_count FROM pos_orders;
      IF v_count > 0 THEN
        -- Only abort if column is still missing (not yet migrated)
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'pos_orders' AND column_name = 'property_id'
        ) THEN
          RAISE EXCEPTION 'pos_orders has % rows but property_id column is missing. Classify ownership before migration.', v_count;
        END IF;
      END IF;
    END $$;

    ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS property_id INTEGER;

    -- Drop legacy global unique constraint if it still exists (replaced by per-property unique)
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pos_orders_order_number_key') THEN
        ALTER TABLE pos_orders DROP CONSTRAINT pos_orders_order_number_key;
      END IF;
    END $$;

    -- Enforce NOT NULL only after column exists (fresh DB already has it NOT NULL from CREATE TABLE)
    ALTER TABLE pos_orders ALTER COLUMN property_id SET NOT NULL;

    -- FK to properties
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_pos_orders_property') THEN
        ALTER TABLE pos_orders ADD CONSTRAINT fk_pos_orders_property FOREIGN KEY (property_id) REFERENCES properties(id);
      END IF;
    END $$;

    -- Per-property unique on order_number
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_pos_order_number_per_property') THEN
        ALTER TABLE pos_orders ADD CONSTRAINT uq_pos_order_number_per_property UNIQUE (property_id, order_number);
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_pos_orders_property ON pos_orders(property_id);
    CREATE INDEX IF NOT EXISTS idx_pos_orders_property_status ON pos_orders(property_id, status);
  `);

  // GL accounts and journal property isolation (idempotent for existing DBs)
  await pool.query(`
    -- 1. GL Accounts column & guarded historical backfill
    ALTER TABLE accounting_gl_accounts ADD COLUMN IF NOT EXISTS property_id INTEGER;

    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='accounting_gl_accounts' AND column_name='property_id' AND is_nullable='YES') THEN
        UPDATE accounting_gl_accounts aga
        SET property_id = p.id
        FROM properties p
        WHERE aga.property_id IS NULL
          AND (
            p.property_code = 'LWG'
            OR p.name = 'OAK Lawang'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM properties p2
            WHERE p2.id <> p.id
              AND (p2.property_code = 'LWG' OR p2.name = 'OAK Lawang')
          );
      END IF;
    END $$;

    -- Drop legacy global unique constraint on code if present
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounting_gl_accounts_code_key') THEN
        ALTER TABLE accounting_gl_accounts DROP CONSTRAINT accounting_gl_accounts_code_key;
      END IF;
    END $$;

    ALTER TABLE accounting_gl_accounts ALTER COLUMN property_id SET NOT NULL;

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_aga_property') THEN
        ALTER TABLE accounting_gl_accounts ADD CONSTRAINT fk_aga_property FOREIGN KEY (property_id) REFERENCES properties(id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_accounting_gl_accounts_code_per_property') THEN
        ALTER TABLE accounting_gl_accounts ADD CONSTRAINT uq_accounting_gl_accounts_code_per_property UNIQUE (property_id, code);
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_accounting_gl_accounts_property ON accounting_gl_accounts(property_id);

    -- 2. Journal entries column
    ALTER TABLE accounting_journal_entries ADD COLUMN IF NOT EXISTS property_id INTEGER;

    -- Drop legacy global unique constraint on entry_number if present
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounting_journal_entries_entry_number_key') THEN
        ALTER TABLE accounting_journal_entries DROP CONSTRAINT accounting_journal_entries_entry_number_key;
      END IF;
    END $$;

    ALTER TABLE accounting_journal_entries ALTER COLUMN property_id SET NOT NULL;

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_aje_property') THEN
        ALTER TABLE accounting_journal_entries ADD CONSTRAINT fk_aje_property FOREIGN KEY (property_id) REFERENCES properties(id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_journal_entries_number_per_property') THEN
        ALTER TABLE accounting_journal_entries ADD CONSTRAINT uq_journal_entries_number_per_property UNIQUE (property_id, entry_number);
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_journal_entries_property ON accounting_journal_entries(property_id);
    CREATE INDEX IF NOT EXISTS idx_journal_entries_property_date ON accounting_journal_entries(property_id, entry_date);

    -- 3. Vendor payables column & indexes
    ALTER TABLE vendor_payables ADD COLUMN IF NOT EXISTS property_id INTEGER;

    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vendor_payables' AND column_name='property_id' AND is_nullable='YES') THEN
        UPDATE vendor_payables vp
        SET property_id = p.id
        FROM properties p
        WHERE vp.property_id IS NULL
          AND (
            p.property_code = 'LWG'
            OR p.name = 'OAK Lawang'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM properties p2
            WHERE p2.id <> p.id
              AND (p2.property_code = 'LWG' OR p2.name = 'OAK Lawang')
          );
      END IF;
    END $$;

    ALTER TABLE vendor_payables ALTER COLUMN property_id SET NOT NULL;

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vp_property') THEN
        ALTER TABLE vendor_payables ADD CONSTRAINT fk_vp_property FOREIGN KEY (property_id) REFERENCES properties(id);
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_vendor_payables_property ON vendor_payables(property_id);
    CREATE INDEX IF NOT EXISTS idx_vendor_payables_property_status ON vendor_payables(property_id, status);

    -- 4. Guest receivables column & indexes
    ALTER TABLE guest_receivables ADD COLUMN IF NOT EXISTS property_id INTEGER;

    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='guest_receivables' AND column_name='property_id' AND is_nullable='YES') THEN
        UPDATE guest_receivables gr
        SET property_id = p.id
        FROM properties p
        WHERE gr.property_id IS NULL
          AND (
            p.property_code = 'LWG'
            OR p.name = 'OAK Lawang'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM properties p2
            WHERE p2.id <> p.id
              AND (p2.property_code = 'LWG' OR p2.name = 'OAK Lawang')
          );
      END IF;
    END $$;

    ALTER TABLE guest_receivables ALTER COLUMN property_id SET NOT NULL;

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_gr_property') THEN
        ALTER TABLE guest_receivables ADD CONSTRAINT fk_gr_property FOREIGN KEY (property_id) REFERENCES properties(id);
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_guest_receivables_property ON guest_receivables(property_id);
    CREATE INDEX IF NOT EXISTS idx_guest_receivables_property_status ON guest_receivables(property_id, status);
  `);

  // 5. Audit logs property_id column, indexes, and permanently sealed one-time migration
  const auditMigrationClient = await pool.connect();
  try {
    await auditMigrationClient.query('BEGIN');
    await auditMigrationClient.query("SELECT pg_advisory_xact_lock(hashtext('oak_hims_schema_migrations_lock'))");

    await auditMigrationClient.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(100) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const markerCheck = await auditMigrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'b4b_historical_audit_backfill'"
    );
    const markerExists = (markerCheck.rowCount ?? 0) > 0;

    // Inspect pre-migration schema & data state before ensuring DDL
    const colCheck = await auditMigrationClient.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'property_id'"
    );
    const propertyColExisted = (colCheck.rowCount ?? 0) > 0;

    const fkCheck = await auditMigrationClient.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'fk_audit_logs_property'"
    );
    const fkExisted = (fkCheck.rowCount ?? 0) > 0;

    const idxCheck = await auditMigrationClient.query(
      "SELECT 1 FROM pg_class WHERE relname = 'idx_audit_logs_property_entity_record'"
    );
    const idxExisted = (idxCheck.rowCount ?? 0) > 0;

    const auditCountRes = await auditMigrationClient.query(
      "SELECT COUNT(*)::bigint AS cnt FROM audit_logs"
    );
    const totalAuditRows = BigInt(auditCountRes.rows[0]?.cnt || 0);

    // Ensure idempotent DDL: column, FK constraint, and indexes
    await auditMigrationClient.query(`
      ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS property_id INTEGER;
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_audit_logs_property'
        ) THEN
          IF EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_property_id_fkey'
          ) THEN
            ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_property_id_fkey;
          END IF;
          ALTER TABLE audit_logs ADD CONSTRAINT fk_audit_logs_property FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE RESTRICT;
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS idx_audit_logs_property_entity_record ON audit_logs (property_id, entity, record_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_property_timestamp ON audit_logs (property_id, timestamp DESC);
    `);

    if (!markerExists) {
      const isAlreadyMigrated = propertyColExisted && (fkExisted || idxExisted);
      const isFreshDb = totalAuditRows === 0n;

      if (!isAlreadyMigrated && !isFreshDb) {
        // Genuine Pre-B4B Legacy DB: execute deterministic Tier A/Tier B backfill ONCE
        await auditMigrationClient.query(`
          -- Priority 1: Relational Deterministic Backfill
          UPDATE audit_logs a
          SET property_id = b.property_id
          FROM bookings b
          WHERE a.property_id IS NULL
            AND a.entity = 'BOOKING'
            AND a.record_id ~ '^[0-9]+$'
            AND b.id = a.record_id::bigint;

          UPDATE audit_logs a
          SET property_id = b.property_id
          FROM reservations r
          JOIN bookings b ON b.id = r.booking_id
          WHERE a.property_id IS NULL
            AND a.entity = 'RESERVATION'
            AND a.record_id ~ '^[0-9]+$'
            AND r.id = a.record_id::integer;

          UPDATE audit_logs a
          SET property_id = rm.property_id
          FROM rooms rm
          WHERE a.property_id IS NULL
            AND a.entity = 'ROOM'
            AND a.record_id ~ '^[0-9]+$'
            AND rm.id = a.record_id::integer;

          UPDATE audit_logs a
          SET property_id = rt.property_id
          FROM room_types rt
          WHERE a.property_id IS NULL
            AND a.entity = 'ROOM_TYPE'
            AND a.record_id ~ '^[0-9]+$'
            AND rt.id = a.record_id::integer;

          UPDATE audit_logs a
          SET property_id = rc.property_id
          FROM room_categories rc
          WHERE a.property_id IS NULL
            AND a.entity = 'ROOM_CATEGORY'
            AND a.record_id ~ '^[0-9]+$'
            AND rc.id = a.record_id::integer;

          -- Priority 2: Payload Deterministic Backfill (crash-safe regex extraction, zero JSON casting failure)
          UPDATE audit_logs a
          SET property_id = p.id
          FROM properties p
          WHERE a.property_id IS NULL
            AND a.new_value IS NOT NULL
            AND (
              COALESCE(SUBSTRING(a.new_value FROM '"property_id"[[:space:]]*:[[:space:]]*([0-9]+)'), '0')::bigint = p.id
              OR
              COALESCE(SUBSTRING(a.new_value FROM '"propertyId"[[:space:]]*:[[:space:]]*([0-9]+)'), '0')::bigint = p.id
            );
        `);
      }

      // Record sealed migration marker for b4b
      await auditMigrationClient.query(`
        INSERT INTO schema_migrations (version)
        VALUES ('b4b_historical_audit_backfill')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // B4C2-B1: Dated Room Operational Blocks migration sealing
    await auditMigrationClient.query(`
      CREATE TABLE IF NOT EXISTS room_operational_blocks (
        id SERIAL PRIMARY KEY,
        property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
        room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
        room_type_id INTEGER NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
        block_type VARCHAR(20) NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        reason VARCHAR(255),
        maintenance_task_id INTEGER REFERENCES maintenance_tasks(id) ON DELETE SET NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
        created_by VARCHAR(100),
        created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        released_by VARCHAR(100),
        released_at TIMESTAMP WITHOUT TIME ZONE,
        CONSTRAINT chk_room_operational_blocks_dates CHECK (end_date > start_date),
        CONSTRAINT chk_room_operational_blocks_type CHECK (block_type IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE')),
        CONSTRAINT chk_room_operational_blocks_status CHECK (status IN ('ACTIVE', 'RELEASED', 'CANCELLED'))
      );

      CREATE INDEX IF NOT EXISTS idx_room_operational_blocks_prop_status_dates
        ON room_operational_blocks (property_id, status, start_date, end_date);
      CREATE INDEX IF NOT EXISTS idx_room_operational_blocks_room_status_dates
        ON room_operational_blocks (room_id, status, start_date, end_date);
      CREATE INDEX IF NOT EXISTS idx_room_operational_blocks_room_type_dates
        ON room_operational_blocks (room_type_id, status, start_date, end_date);

      INSERT INTO schema_migrations (version)
      VALUES ('b4c2_1_room_operational_blocks')
      ON CONFLICT (version) DO NOTHING;
    `);

    // Phase GO-LIVE-GUEST-B1: Guest Master & Reservation-Guest Relational Foundation
    const guestMarkerCheck = await auditMigrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'guest_b1_relational_foundation'"
    );
    const guestMarkerExists = (guestMarkerCheck.rowCount ?? 0) > 0;

    await auditMigrationClient.query(`
      CREATE TABLE IF NOT EXISTS guests (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(255) NOT NULL,
        preferred_name VARCHAR(100),
        gender VARCHAR(20),
        birth_place VARCHAR(100),
        birth_date DATE,
        nationality VARCHAR(100) DEFAULT 'ID',
        phone VARCHAR(50),
        email VARCHAR(255),
        address TEXT,
        city VARCHAR(100),
        province VARCHAR(100),
        country VARCHAR(100) DEFAULT 'Indonesia',
        vip_status VARCHAR(50) NOT NULL DEFAULT 'STANDARD',
        is_blacklisted BOOLEAN NOT NULL DEFAULT FALSE,
        blacklist_reason TEXT,
        notes TEXT,
        created_property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        created_by VARCHAR(100),
        CONSTRAINT chk_guests_vip_status CHECK (vip_status IN ('STANDARD', 'VIP', 'VVIP')),
        CONSTRAINT chk_guests_gender CHECK (gender IS NULL OR gender IN ('MALE', 'FEMALE', 'OTHER'))
      );

      ALTER TABLE guests ADD COLUMN IF NOT EXISTS created_property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL;
      UPDATE guests SET created_property_id = 1 WHERE created_property_id IS NULL AND created_by = 'MIGRATION_GUEST_B1';

      CREATE INDEX IF NOT EXISTS idx_guests_phone ON guests (phone);
      CREATE INDEX IF NOT EXISTS idx_guests_email ON guests (email);
      CREATE INDEX IF NOT EXISTS idx_guests_full_name_lower ON guests (LOWER(full_name));
      CREATE INDEX IF NOT EXISTS idx_guests_created_property_id ON guests (created_property_id);

      CREATE TABLE IF NOT EXISTS reservation_guests (
        id SERIAL PRIMARY KEY,
        reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
        guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE RESTRICT,
        role VARCHAR(50) NOT NULL,
        relationship VARCHAR(100),
        is_staying BOOLEAN NOT NULL DEFAULT TRUE,
        identity_verified BOOLEAN NOT NULL DEFAULT FALSE,
        relation_source VARCHAR(100) NOT NULL DEFAULT 'MANUAL_ENTRY',
        is_legacy_inferred BOOLEAN NOT NULL DEFAULT FALSE,
        checked_in_at TIMESTAMP WITH TIME ZONE,
        checked_out_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_reservation_guests_role CHECK (role IN ('BOOKER', 'PRIMARY_GUEST', 'ADDITIONAL_GUEST'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_reservation_single_primary_guest
        ON reservation_guests (reservation_id)
        WHERE role = 'PRIMARY_GUEST';

      CREATE UNIQUE INDEX IF NOT EXISTS idx_reservation_guest_role
        ON reservation_guests (reservation_id, guest_id, role);

      CREATE INDEX IF NOT EXISTS idx_reservation_guests_reservation_id
        ON reservation_guests (reservation_id);

      CREATE INDEX IF NOT EXISTS idx_reservation_guests_guest_id
        ON reservation_guests (guest_id);
    `);

    if (!guestMarkerExists) {
      // Deterministic legacy migration: link existing reservations to guest master
      await auditMigrationClient.query(`
        WITH distinct_legacy_guests AS (
          SELECT
            MIN(TRIM(guest_name)) AS full_name,
            NULLIF(TRIM(guest_phone), '') AS phone
          FROM reservations
          WHERE guest_name IS NOT NULL AND TRIM(guest_name) != ''
          GROUP BY LOWER(TRIM(guest_name)), NULLIF(TRIM(guest_phone), '')
        )
        INSERT INTO guests (full_name, phone, vip_status, is_blacklisted, created_at, updated_at, created_by)
        SELECT
          full_name,
          phone,
          'STANDARD',
          false,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP,
          'MIGRATION_GUEST_B1'
        FROM distinct_legacy_guests
        ON CONFLICT DO NOTHING;

        WITH res_mapping AS (
          SELECT
            r.id AS reservation_id,
            g.id AS guest_id,
            r.checked_in_at,
            r.checked_out_at
          FROM reservations r
          JOIN guests g ON
            LOWER(TRIM(r.guest_name)) = LOWER(TRIM(g.full_name))
            AND (
              (NULLIF(TRIM(r.guest_phone), '') IS NULL AND g.phone IS NULL)
              OR
              (NULLIF(TRIM(r.guest_phone), '') = g.phone)
            )
        )
        INSERT INTO reservation_guests (
          reservation_id,
          guest_id,
          role,
          relationship,
          is_staying,
          identity_verified,
          relation_source,
          is_legacy_inferred,
          checked_in_at,
          checked_out_at,
          created_at,
          updated_at
        )
        SELECT
          reservation_id,
          guest_id,
          'PRIMARY_GUEST',
          'SELF',
          true,
          false,
          'LEGACY_RESERVATION_SNAPSHOT',
          true,
          checked_in_at,
          checked_out_at,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        FROM res_mapping
        ON CONFLICT (reservation_id, guest_id, role) DO NOTHING;

        INSERT INTO schema_migrations (version)
        VALUES ('guest_b1_relational_foundation')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // 7. Payment correction, void & immutable reversal schema migration
    const paymentCorrMarkerCheck = await auditMigrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'payment_correction_void_schema_v1'"
    );
    if ((paymentCorrMarkerCheck.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS reference_payment_id INTEGER REFERENCES payment_transactions(id) ON DELETE SET NULL;
        ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS correction_group_id VARCHAR(100);
        ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS reason_code VARCHAR(50);
        ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS reason_text TEXT;
        ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS created_by VARCHAR(100);

        CREATE INDEX IF NOT EXISTS idx_payment_transactions_reservation ON payment_transactions (reservation_id);
        CREATE INDEX IF NOT EXISTS idx_payment_transactions_ref_payment ON payment_transactions (reference_payment_id);
        CREATE INDEX IF NOT EXISTS idx_payment_transactions_correction_group ON payment_transactions (correction_group_id);

        INSERT INTO schema_migrations (version)
        VALUES ('payment_correction_void_schema_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // 8. Payment evidence schema migration
    const paymentEvidenceMarkerCheck = await auditMigrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'payment_evidence_schema_v1'"
    );
    if ((paymentEvidenceMarkerCheck.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        CREATE TABLE IF NOT EXISTS payment_evidences (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
          reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
          payment_transaction_id INTEGER NOT NULL REFERENCES payment_transactions(id) ON DELETE RESTRICT,
          evidence_type VARCHAR(50) NOT NULL,
          storage_key VARCHAR(500) NOT NULL,
          original_filename VARCHAR(255) NOT NULL,
          mime_type VARCHAR(100) NOT NULL,
          file_size_bytes BIGINT NOT NULL,
          note TEXT,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          uploaded_by_user_id VARCHAR(100),
          uploaded_by_name_snapshot VARCHAR(150),
          uploaded_by_role_snapshot VARCHAR(100),
          uploaded_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          deactivated_by_user_id VARCHAR(100),
          deactivated_by_name_snapshot VARCHAR(150),
          deactivated_by_role_snapshot VARCHAR(100),
          deactivated_at TIMESTAMP WITHOUT TIME ZONE,
          deactivation_reason TEXT,
          created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_payment_evidences_payment ON payment_evidences (payment_transaction_id);
        CREATE INDEX IF NOT EXISTS idx_payment_evidences_reservation ON payment_evidences (reservation_id);
        CREATE INDEX IF NOT EXISTS idx_payment_evidences_property ON payment_evidences (property_id);
        CREATE INDEX IF NOT EXISTS idx_payment_evidences_uploaded_at ON payment_evidences (uploaded_at);
        CREATE INDEX IF NOT EXISTS idx_payment_evidences_active ON payment_evidences (is_active);

        INSERT INTO schema_migrations (version)
        VALUES ('payment_evidence_schema_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // 9. Housekeeping operations & checklist schema migration (HK-OPS-1)
    const hkOpsMarkerCheck = await auditMigrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'housekeeping_operations_schema_v1'"
    );
    if ((hkOpsMarkerCheck.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        -- Upgrade housekeeping_tasks table
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS task_category VARCHAR(30) NOT NULL DEFAULT 'ROOM_OPERATIONS';
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL;
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL;
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL;
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS title VARCHAR(255);
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS description TEXT;
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS assigned_department VARCHAR(50) DEFAULT 'Housekeeping';
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS assigned_user_id INTEGER;
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS assigned_user_name_snapshot VARCHAR(150);
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS requested_by_user_id INTEGER;
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS requested_by_name_snapshot VARCHAR(150);
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS requested_by_role_snapshot VARCHAR(100);
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP WITHOUT TIME ZONE;
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP WITHOUT TIME ZONE;
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS started_at TIMESTAMP WITHOUT TIME ZONE;
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITHOUT TIME ZONE;
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP WITHOUT TIME ZONE;
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS completion_note TEXT;
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS blocked_reason TEXT;
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS source_type VARCHAR(50) DEFAULT 'MANUAL';
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS source_entity_id VARCHAR(100);
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS inspection_result VARCHAR(30);
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS issue_type VARCHAR(50);
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS issue_note TEXT;
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS estimated_charge NUMERIC(12, 2);
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP;
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS task_number VARCHAR(60);

        CREATE INDEX IF NOT EXISTS idx_housekeeping_tasks_property_status ON housekeeping_tasks (property_id, status);
        CREATE INDEX IF NOT EXISTS idx_housekeeping_tasks_room ON housekeeping_tasks (room_id);
        CREATE INDEX IF NOT EXISTS idx_housekeeping_tasks_reservation ON housekeeping_tasks (reservation_id);
        CREATE INDEX IF NOT EXISTS idx_housekeeping_tasks_category ON housekeeping_tasks (task_category);
        CREATE INDEX IF NOT EXISTS idx_housekeeping_tasks_type ON housekeeping_tasks (task_type);
        CREATE INDEX IF NOT EXISTS idx_housekeeping_tasks_task_number ON housekeeping_tasks (task_number);
        CREATE UNIQUE INDEX IF NOT EXISTS uq_housekeeping_tasks_task_number ON housekeeping_tasks (task_number) WHERE task_number IS NOT NULL;

        -- Checklist Templates
        CREATE TABLE IF NOT EXISTS checklist_templates (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
          code VARCHAR(50) NOT NULL,
          name VARCHAR(150) NOT NULL,
          task_type VARCHAR(50) NOT NULL,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          requires_verification BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT uq_checklist_templates_prop_code UNIQUE (property_id, code)
        );
        CREATE INDEX IF NOT EXISTS idx_checklist_templates_prop ON checklist_templates (property_id);

        -- Checklist Template Groups
        CREATE TABLE IF NOT EXISTS checklist_template_groups (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
          template_id INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
          code VARCHAR(50),
          name VARCHAR(150) NOT NULL,
          description TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          is_archived BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_checklist_template_groups_template ON checklist_template_groups (template_id);
        CREATE INDEX IF NOT EXISTS idx_checklist_template_groups_prop ON checklist_template_groups (property_id);

        -- Checklist Template Items
        CREATE TABLE IF NOT EXISTS checklist_template_items (
          id SERIAL PRIMARY KEY,
          template_id INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
          group_id INTEGER REFERENCES checklist_template_groups(id) ON DELETE SET NULL,
          section VARCHAR(100) NOT NULL,
          label VARCHAR(255) NOT NULL,
          description TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          is_required BOOLEAN NOT NULL DEFAULT TRUE,
          requires_note BOOLEAN NOT NULL DEFAULT FALSE,
          requires_photo BOOLEAN NOT NULL DEFAULT FALSE,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          is_archived BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_checklist_template_items_template ON checklist_template_items (template_id);
        CREATE INDEX IF NOT EXISTS idx_checklist_template_items_group ON checklist_template_items (group_id);

        -- Task Checklist Snapshot Items
        CREATE TABLE IF NOT EXISTS housekeeping_task_checklist_items (
          id SERIAL PRIMARY KEY,
          task_id INTEGER NOT NULL REFERENCES housekeeping_tasks(id) ON DELETE CASCADE,
          template_item_id INTEGER REFERENCES checklist_template_items(id) ON DELETE SET NULL,
          group_id INTEGER,
          source_group_id INTEGER,
          group_code VARCHAR(50),
          group_name VARCHAR(150),
          group_sort_order INTEGER NOT NULL DEFAULT 0,
          section VARCHAR(100) NOT NULL,
          label VARCHAR(255) NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          is_required BOOLEAN NOT NULL DEFAULT TRUE,
          requires_note BOOLEAN NOT NULL DEFAULT FALSE,
          requires_photo BOOLEAN NOT NULL DEFAULT FALSE,
          is_completed BOOLEAN NOT NULL DEFAULT FALSE,
          completed_at TIMESTAMP WITHOUT TIME ZONE,
          completed_by_name VARCHAR(150),
          note TEXT,
          photo_storage_key VARCHAR(500),
          created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_task_checklist_items_task ON housekeeping_task_checklist_items (task_id);

        -- Property Housekeeping Settings
        CREATE TABLE IF NOT EXISTS property_housekeeping_settings (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL UNIQUE REFERENCES properties(id) ON DELETE RESTRICT,
          require_final_inspection BOOLEAN NOT NULL DEFAULT FALSE,
          require_checkout_room_check BOOLEAN NOT NULL DEFAULT FALSE,
          allow_calendar_room_status_override BOOLEAN NOT NULL DEFAULT FALSE,
          default_cleaning_template_code VARCHAR(50) NOT NULL DEFAULT 'STANDARD_ROOM_CLEANING',
          default_checkout_template_code VARCHAR(50) NOT NULL DEFAULT 'CHECKOUT_INSPECTION',
          housekeeping_category_bulk_check_enabled BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_property_hk_settings_prop ON property_housekeeping_settings (property_id);

        INSERT INTO schema_migrations (version)
        VALUES ('housekeeping_operations_schema_v1')
        ON CONFLICT (version) DO NOTHING;
      `);

      // Seed standard default templates and settings for all existing properties
      const propsRes = await auditMigrationClient.query('SELECT id FROM properties');
      for (const prop of propsRes.rows) {
        const propId = prop.id;

        // Settings
        await auditMigrationClient.query(`
          INSERT INTO property_housekeeping_settings (property_id, require_final_inspection, require_checkout_room_check, allow_calendar_room_status_override)
          VALUES ($1, false, false, false)
          ON CONFLICT (property_id) DO NOTHING
        `, [propId]);

        // Template 1: STANDARD_ROOM_CLEANING
        const t1Res = await auditMigrationClient.query(`
          INSERT INTO checklist_templates (property_id, code, name, task_type, is_active, requires_verification)
          VALUES ($1, 'STANDARD_ROOM_CLEANING', 'Standard Room Cleaning', 'ROOM_CLEANING', true, false)
          ON CONFLICT (property_id, code) DO UPDATE SET updated_at = NOW()
          RETURNING id
        `, [propId]);
        const t1Id = t1Res.rows[0]?.id;
        if (t1Id) {
          const count1 = await auditMigrationClient.query('SELECT COUNT(*) as c FROM checklist_template_items WHERE template_id = $1', [t1Id]);
          if (Number(count1.rows[0].c) === 0) {
            await auditMigrationClient.query(`
              INSERT INTO checklist_template_items (template_id, section, label, sort_order, is_required)
              VALUES
                ($1, 'BEDROOM', 'Sprei diganti / diperiksa', 1, true),
                ($1, 'BEDROOM', 'Bed dibuat rapi', 2, true),
                ($1, 'BEDROOM', 'Bantal diperiksa', 3, true),
                ($1, 'BEDROOM', 'Lantai dibersihkan', 4, true),
                ($1, 'BEDROOM', 'Debu furniture dibersihkan', 5, true),
                ($1, 'BATHROOM', 'Toilet dibersihkan', 6, true),
                ($1, 'BATHROOM', 'Shower dibersihkan', 7, true),
                ($1, 'BATHROOM', 'Handuk diganti / diperiksa', 8, true),
                ($1, 'BATHROOM', 'Amenities dilengkapi', 9, true),
                ($1, 'BATHROOM', 'Air panas diperiksa', 10, true),
                ($1, 'ROOM_AMENITIES', 'Air mineral tersedia', 11, true),
                ($1, 'ROOM_AMENITIES', 'Coffee / tea replenished', 12, false),
                ($1, 'ROOM_AMENITIES', 'Trash bin kosong', 13, true),
                ($1, 'ROOM_AMENITIES', 'AC diperiksa', 14, true),
                ($1, 'ROOM_AMENITIES', 'TV / remote tersedia', 15, true),
                ($1, 'FINAL_CHECK', 'Tidak ada barang tamu tertinggal', 16, true),
                ($1, 'FINAL_CHECK', 'Tidak ada kerusakan terlihat', 17, true),
                ($1, 'FINAL_CHECK', 'Kondisi kamar siap untuk tamu berikutnya', 18, true)
            `, [t1Id]);
          }
        }

        // Template 2: CHECKOUT_INSPECTION
        const t2Res = await auditMigrationClient.query(`
          INSERT INTO checklist_templates (property_id, code, name, task_type, is_active, requires_verification)
          VALUES ($1, 'CHECKOUT_INSPECTION', 'Checkout Inspection', 'CHECKOUT_ROOM_CHECK', true, false)
          ON CONFLICT (property_id, code) DO UPDATE SET updated_at = NOW()
          RETURNING id
        `, [propId]);
        const t2Id = t2Res.rows[0]?.id;
        if (t2Id) {
          const count2 = await auditMigrationClient.query('SELECT COUNT(*) as c FROM checklist_template_items WHERE template_id = $1', [t2Id]);
          if (Number(count2.rows[0].c) === 0) {
            await auditMigrationClient.query(`
              INSERT INTO checklist_template_items (template_id, section, label, sort_order, is_required)
              VALUES
                ($1, 'CHECKOUT_INSPECTION', 'Minibar checked', 1, true),
                ($1, 'CHECKOUT_INSPECTION', 'Linen / towel checked', 2, true),
                ($1, 'CHECKOUT_INSPECTION', 'Hotel inventory complete', 3, true),
                ($1, 'CHECKOUT_INSPECTION', 'No visible room damage', 4, true),
                ($1, 'CHECKOUT_INSPECTION', 'No hotel property missing', 5, true),
                ($1, 'CHECKOUT_INSPECTION', 'Guest belongings / Lost & Found checked', 6, true),
                ($1, 'CHECKOUT_INSPECTION', 'Other room condition checked', 7, false)
            `, [t2Id]);
          }
        }

        // Template 3: FINAL_INSPECTION
        const t3Res = await auditMigrationClient.query(`
          INSERT INTO checklist_templates (property_id, code, name, task_type, is_active, requires_verification)
          VALUES ($1, 'FINAL_INSPECTION', 'Supervisor Final Inspection', 'FINAL_INSPECTION', true, false)
          ON CONFLICT (property_id, code) DO UPDATE SET updated_at = NOW()
          RETURNING id
        `, [propId]);
        const t3Id = t3Res.rows[0]?.id;
        if (t3Id) {
          const count3 = await auditMigrationClient.query('SELECT COUNT(*) as c FROM checklist_template_items WHERE template_id = $1', [t3Id]);
          if (Number(count3.rows[0].c) === 0) {
            await auditMigrationClient.query(`
              INSERT INTO checklist_template_items (template_id, section, label, sort_order, is_required)
              VALUES
                ($1, 'SUPERVISOR_INSPECTION', 'Bed presentation sesuai standard', 1, true),
                ($1, 'SUPERVISOR_INSPECTION', 'Bathroom standard', 2, true),
                ($1, 'SUPERVISOR_INSPECTION', 'Amenities complete', 3, true),
                ($1, 'SUPERVISOR_INSPECTION', 'No odor', 4, true),
                ($1, 'SUPERVISOR_INSPECTION', 'AC / TV / lighting normal', 5, true),
                ($1, 'SUPERVISOR_INSPECTION', 'No visible defect', 6, true)
            `, [t3Id]);
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // MIGRATION 10: Property Modular Features & Sub-Feature Flags
    // -------------------------------------------------------------------------
    const hasFeaturesMigration = await auditMigrationClient.query(
      `SELECT 1 FROM schema_migrations WHERE version = 'property_feature_flags_v1'`
    );

    if ((hasFeaturesMigration.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        CREATE TABLE IF NOT EXISTS property_features (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
          feature_key VARCHAR(100) NOT NULL,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_by VARCHAR(255),
          CONSTRAINT uq_property_feature UNIQUE (property_id, feature_key)
        );
        CREATE INDEX IF NOT EXISTS idx_property_features_prop ON property_features (property_id);

        INSERT INTO schema_migrations (version)
        VALUES ('property_feature_flags_v1')
        ON CONFLICT (version) DO NOTHING;
      `);

      // Seed standard default feature flags for all existing properties
      const propsRes = await auditMigrationClient.query('SELECT id FROM properties');
      for (const prop of propsRes.rows) {
        const propId = prop.id;
        await auditMigrationClient.query(`
          INSERT INTO property_features (property_id, feature_key, enabled)
          VALUES
            ($1, 'housekeeping.enabled', TRUE),
            ($1, 'housekeeping.room_operations', TRUE),
            ($1, 'housekeeping.checkout_inspection', TRUE),
            ($1, 'housekeeping.final_inspection', TRUE),
            ($1, 'housekeeping.service_requests', TRUE),
            ($1, 'housekeeping.department_tasks', TRUE),
            ($1, 'housekeeping.public_area_cleaning', FALSE),
            ($1, 'housekeeping.recurring_cleaning', FALSE),
            ($1, 'housekeeping.laundry', FALSE),
            ($1, 'housekeeping.laundry_internal', FALSE),
            ($1, 'housekeeping.laundry_vendor', FALSE),
            ($1, 'housekeeping.guest_laundry', FALSE),
            ($1, 'housekeeping.linen_inventory', FALSE),
            ($1, 'housekeeping.amenities_inventory', FALSE),
            ($1, 'housekeeping.chemical_inventory', FALSE),
            ($1, 'housekeeping.hk_pantry_inventory', FALSE),
            ($1, 'housekeeping.lost_and_found', FALSE),
            ($1, 'housekeeping.linen', FALSE),
            ($1, 'housekeeping.amenities', FALSE),
            ($1, 'front_office.enabled', TRUE),
            ($1, 'pos.enabled', TRUE),
            ($1, 'finance.enabled', TRUE),
            ($1, 'hrd.enabled', TRUE),
            ($1, 'events_banquet.enabled', FALSE),
            ($1, 'marketing.enabled', TRUE),
            ($1, 'purchasing.enabled', FALSE),
            ($1, 'general_affair.enabled', FALSE)
          ON CONFLICT (property_id, feature_key) DO NOTHING
        `, [propId]);
      }
    }

    // -------------------------------------------------------------------------
    // MIGRATION 11: Employee Attendance Records, Settings & HK Task Archive (EMP-MOBILE-1)
    // -------------------------------------------------------------------------
    const hasAttendanceMigration = await auditMigrationClient.query(
      `SELECT 1 FROM schema_migrations WHERE version = 'employee_attendance_schema_v1'`
    );

    if ((hasAttendanceMigration.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        -- 1. Employee Attendance Records
        CREATE TABLE IF NOT EXISTS employee_attendance_records (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
          employee_id INTEGER REFERENCES hr_employees(id) ON DELETE SET NULL,
          employee_name VARCHAR(150) NOT NULL,
          department VARCHAR(80),
          attendance_date DATE NOT NULL,
          attendance_type VARCHAR(30) NOT NULL,
          server_recorded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          latitude NUMERIC(10, 7),
          longitude NUMERIC(10, 7),
          location_accuracy_meters NUMERIC(10, 2),
          property_distance_meters NUMERIC(10, 2),
          geofence_result VARCHAR(30) NOT NULL DEFAULT 'DISABLED',
          photo_storage_key TEXT,
          source VARCHAR(30) NOT NULL DEFAULT 'MOBILE_WEB',
          status VARCHAR(30) NOT NULL DEFAULT 'ACCEPTED',
          reason TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_attendance_records_prop_date ON employee_attendance_records (property_id, attendance_date);
        CREATE INDEX IF NOT EXISTS idx_attendance_records_employee ON employee_attendance_records (employee_id);
        CREATE INDEX IF NOT EXISTS idx_attendance_records_status ON employee_attendance_records (status);

        -- 2. Property Attendance Settings
        CREATE TABLE IF NOT EXISTS property_attendance_settings (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL UNIQUE REFERENCES properties(id) ON DELETE RESTRICT,
          attendance_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          require_employee_attendance BOOLEAN NOT NULL DEFAULT TRUE,
          require_checkin_photo BOOLEAN NOT NULL DEFAULT TRUE,
          require_checkout_photo BOOLEAN NOT NULL DEFAULT FALSE,
          geofence_enabled BOOLEAN NOT NULL DEFAULT FALSE,
          geofence_latitude NUMERIC(10, 7),
          geofence_longitude NUMERIC(10, 7),
          geofence_radius_meters NUMERIC(10, 2) DEFAULT 100,
          outside_geofence_policy VARCHAR(30) NOT NULL DEFAULT 'ALLOW_WITH_REASON',
          exempt_roles JSONB DEFAULT '["Owner", "General Manager"]'::jsonb,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_property_attendance_settings_prop ON property_attendance_settings (property_id);

        -- 3. Housekeeping Tasks Archive / Correction columns
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP WITH TIME ZONE;
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS archived_by VARCHAR(150);
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS archive_reason TEXT;
        CREATE INDEX IF NOT EXISTS idx_housekeeping_tasks_archived ON housekeeping_tasks (is_archived);

        INSERT INTO schema_migrations (version)
        VALUES ('employee_attendance_schema_v1')
        ON CONFLICT (version) DO NOTHING;
      `);

      // Seed standard attendance settings and feature flags for all existing properties
      const propsRes = await auditMigrationClient.query('SELECT id FROM properties');
      for (const prop of propsRes.rows) {
        const propId = prop.id;
        // Attendance Settings
        await auditMigrationClient.query(`
          INSERT INTO property_attendance_settings (
            property_id, attendance_enabled, require_employee_attendance,
            require_checkin_photo, require_checkout_photo, geofence_enabled,
            geofence_radius_meters, outside_geofence_policy
          )
          VALUES ($1, TRUE, TRUE, TRUE, FALSE, FALSE, 100, 'ALLOW_WITH_REASON')
          ON CONFLICT (property_id) DO NOTHING
        `, [propId]);

        // Feature flags for Employee Mobile & Attendance
        await auditMigrationClient.query(`
          INSERT INTO property_features (property_id, feature_key, enabled)
          VALUES
            ($1, 'hrd.attendance', TRUE),
            ($1, 'hrd.attendance_photo', TRUE),
            ($1, 'hrd.attendance_geofence', FALSE),
            ($1, 'employee_mobile.enabled', TRUE),
            ($1, 'employee_mobile.notifications', TRUE)
          ON CONFLICT (property_id, feature_key) DO NOTHING
        `, [propId]);
      }
    }

    // -------------------------------------------------------------------------
    // MIGRATION 12: Housekeeping Finding Types Catalog & Checklist Configuration
    // -------------------------------------------------------------------------
    const hasFindingTypesMigration = await auditMigrationClient.query(
      `SELECT 1 FROM schema_migrations WHERE version = 'housekeeping_finding_types_schema_v1'`
    );

    if ((hasFindingTypesMigration.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        CREATE TABLE IF NOT EXISTS housekeeping_finding_types (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
          code VARCHAR(50) NOT NULL,
          label VARCHAR(150) NOT NULL,
          description TEXT,
          severity VARCHAR(30) NOT NULL DEFAULT 'MEDIUM',
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          note_required BOOLEAN NOT NULL DEFAULT FALSE,
          photo_required BOOLEAN NOT NULL DEFAULT FALSE,
          estimated_charge_allowed BOOLEAN NOT NULL DEFAULT TRUE,
          supervisor_review_required BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT uq_housekeeping_finding_types_prop_code UNIQUE (property_id, code)
        );
        CREATE INDEX IF NOT EXISTS idx_hk_finding_types_prop ON housekeeping_finding_types (property_id);
        CREATE INDEX IF NOT EXISTS idx_hk_finding_types_active ON housekeeping_finding_types (property_id, is_active);

        INSERT INTO schema_migrations (version)
        VALUES ('housekeeping_finding_types_schema_v1')
        ON CONFLICT (version) DO NOTHING;
      `);

      // Seed standard default finding types for all existing properties
      const propsRes = await auditMigrationClient.query('SELECT id FROM properties');
      for (const prop of propsRes.rows) {
        const propId = prop.id;
        const findingSeeds = [
          { code: 'MINIBAR', label: 'Minibar / Konsumsi Tamu', desc: 'Item minibar terkonsumsi atau belum terisi', severity: 'LOW', sort: 1, noteReq: false, photoReq: false, chargeAllowed: true, supReview: false },
          { code: 'REMOTE_TV_HILANG', label: 'Remote TV Hilang / Rusak', desc: 'Remote TV tidak ditemukan di kamar atau rusak fisik', severity: 'MEDIUM', sort: 2, noteReq: false, photoReq: false, chargeAllowed: true, supReview: false },
          { code: 'REMOTE_AC_HILANG', label: 'Remote AC Hilang / Rusak', desc: 'Remote AC tidak ditemukan di kamar atau rusak fisik', severity: 'MEDIUM', sort: 3, noteReq: false, photoReq: false, chargeAllowed: true, supReview: false },
          { code: 'HANDUK_KURANG', label: 'Handuk Kurang / Rusak', desc: 'Handuk mandi/wajah hilang, sobek, atau noda permanen', severity: 'LOW', sort: 4, noteReq: false, photoReq: false, chargeAllowed: true, supReview: false },
          { code: 'LINEN_RUSAK', label: 'Linen / Sprei Rusak / Noda Berat', desc: 'Sprei, duvet cover, atau sarung bantal sobek/terbakar/noda darah/luntur', severity: 'MEDIUM', sort: 5, noteReq: false, photoReq: false, chargeAllowed: true, supReview: false },
          { code: 'BARANG_HILANG', label: 'Barang Hotel Hilang', desc: 'Inventaris kamar (mug, ketel, hair dryer, hanger) hilang', severity: 'HIGH', sort: 6, noteReq: true, photoReq: false, chargeAllowed: true, supReview: true },
          { code: 'KERUSAKAN_FURNITURE', label: 'Kerusakan Furniture', desc: 'Meja, kursi, lemari, ranjang patah/tergores berat', severity: 'HIGH', sort: 7, noteReq: true, photoReq: true, chargeAllowed: true, supReview: true },
          { code: 'KERUSAKAN_ELEKTRONIK', label: 'Kerusakan Elektronik', desc: 'TV, AC, Water Heater, Lampu tidak berfungsi karena kerusakan fisik', severity: 'HIGH', sort: 8, noteReq: true, photoReq: true, chargeAllowed: true, supReview: true },
          { code: 'LOST_AND_FOUND', label: 'Lost & Found (Barang Tamu Tertinggal)', desc: 'Barang milik tamu tertinggal di kamar saat checkout', severity: 'INFO', sort: 9, noteReq: true, photoReq: false, chargeAllowed: false, supReview: false },
          { code: 'LAINNYA', label: 'Lainnya / Catatan Khusus', desc: 'Temuan atau insiden khusus lainnya di kamar', severity: 'INFO', sort: 10, noteReq: true, photoReq: false, chargeAllowed: true, supReview: false }
        ];

        for (const item of findingSeeds) {
          await auditMigrationClient.query(`
            INSERT INTO housekeeping_finding_types (
              property_id, code, label, description, severity, sort_order,
              note_required, photo_required, estimated_charge_allowed, supervisor_review_required, is_active
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
            ON CONFLICT (property_id, code) DO NOTHING
          `, [
            propId, item.code, item.label, item.desc, item.severity, item.sort,
            item.noteReq, item.photoReq, item.chargeAllowed, item.supReview
          ]);
        }
      }
    }

    // -------------------------------------------------------------
    // MIGRATION 13: hrd_account_and_role_policy_schema_v1
    // -------------------------------------------------------------
    const m13Res = await auditMigrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'hrd_account_and_role_policy_schema_v1'"
    );
    if (m13Res.rows.length === 0) {
      await auditMigrationClient.query(`
        CREATE TABLE IF NOT EXISTS hrd_role_policies (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
          allow_hrd_assign_owner_role BOOLEAN NOT NULL DEFAULT FALSE,
          allow_hrd_assign_gm_role BOOLEAN NOT NULL DEFAULT FALSE,
          allow_hrd_assign_dept_manager_role BOOLEAN NOT NULL DEFAULT TRUE,
          allow_hrd_assign_accountant_role BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT uq_hrd_role_policies_prop UNIQUE (property_id)
        );
        CREATE INDEX IF NOT EXISTS idx_hrd_role_policies_prop ON hrd_role_policies (property_id);

        ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE;
        ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'Crew';
        ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS username VARCHAR(100);
        ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS email VARCHAR(150);
        ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
        ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
        ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
        CREATE INDEX IF NOT EXISTS idx_hr_employees_prop ON hr_employees (property_id);
        CREATE INDEX IF NOT EXISTS idx_hr_employees_active ON hr_employees (property_id, is_active);

        INSERT INTO schema_migrations (version)
        VALUES ('hrd_account_and_role_policy_schema_v1')
        ON CONFLICT (version) DO NOTHING;
      `);

      // Seed default HRD role policy for all existing properties
      const propsRes = await auditMigrationClient.query('SELECT id FROM properties');
      for (const prop of propsRes.rows) {
        await auditMigrationClient.query(`
          INSERT INTO hrd_role_policies (
            property_id, allow_hrd_assign_owner_role, allow_hrd_assign_gm_role,
            allow_hrd_assign_dept_manager_role, allow_hrd_assign_accountant_role
          )
          VALUES ($1, FALSE, FALSE, TRUE, TRUE)
          ON CONFLICT (property_id) DO NOTHING
        `, [prop.id]);
      }
    }

    // Employees must always receive their property from the creating flow.
    // Drop the legacy implicit Property 1 default without rewriting rows.
    await auditMigrationClient.query(`
      ALTER TABLE hr_employees ALTER COLUMN property_id DROP DEFAULT;
    `);

    // -------------------------------------------------------------
    // MIGRATION 14: housekeeping_finding_blocking_schema_v1
    // -------------------------------------------------------------
    const m14Res = await auditMigrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'housekeeping_finding_blocking_schema_v1'"
    );
    if (m14Res.rows.length === 0) {
      await auditMigrationClient.query(`
        ALTER TABLE housekeeping_finding_types ADD COLUMN IF NOT EXISTS block_room_ready BOOLEAN NOT NULL DEFAULT FALSE;

        CREATE TABLE IF NOT EXISTS housekeeping_task_findings (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
          task_id INTEGER REFERENCES housekeeping_tasks(id) ON DELETE SET NULL,
          room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
          room_number VARCHAR(50),
          reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
          finding_type_id INTEGER REFERENCES housekeeping_finding_types(id) ON DELETE SET NULL,
          finding_type_code VARCHAR(50) NOT NULL,
          finding_type_label VARCHAR(150) NOT NULL,
          severity VARCHAR(30) NOT NULL DEFAULT 'MEDIUM',
          notes TEXT,
          photo_storage_key TEXT,
          estimated_charge NUMERIC(12, 2) DEFAULT 0,
          block_room_ready BOOLEAN NOT NULL DEFAULT FALSE,
          status VARCHAR(30) NOT NULL DEFAULT 'OPEN',
          reported_by_user_id INTEGER,
          reported_by_name VARCHAR(150),
          reported_by_role VARCHAR(100),
          reported_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          resolved_by_user_id INTEGER,
          resolved_by_name VARCHAR(150),
          resolved_by_role VARCHAR(100),
          resolved_at TIMESTAMP WITH TIME ZONE,
          resolution_note TEXT,
          verified_by_user_id INTEGER,
          verified_by_name VARCHAR(150),
          verified_by_role VARCHAR(100),
          verified_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_hk_task_findings_task ON housekeeping_task_findings (task_id);
        CREATE INDEX IF NOT EXISTS idx_hk_task_findings_room_status ON housekeeping_task_findings (room_id, status);
        CREATE INDEX IF NOT EXISTS idx_hk_task_findings_prop_status ON housekeeping_task_findings (property_id, status);

        UPDATE housekeeping_finding_types
        SET block_room_ready = TRUE
        WHERE code IN ('KERUSAKAN_FURNITURE', 'KERUSAKAN_ELEKTRONIK', 'AC_TIDAK_DINGIN', 'KEBOCORAN_AIR', 'KELISTRIKAN_RUSAK');

        INSERT INTO schema_migrations (version)
        VALUES ('housekeeping_finding_blocking_schema_v1')
        ON CONFLICT (version) DO NOTHING;
      `);

      // Seed blocking finding types for all properties if not already present
      const allProps = await auditMigrationClient.query('SELECT id FROM properties');
      for (const p of allProps.rows) {
        const blockingSeeds = [
          { code: 'AC_TIDAK_DINGIN', label: 'AC Tidak Dingin / Rusak', desc: 'Unit pendingin ruangan tidak dingin, bising, atau mati total', severity: 'HIGH', sort: 11, blockReady: true, noteReq: true, photoReq: false, chargeAllowed: false, supReview: true },
          { code: 'KEBOCORAN_AIR', label: 'Kebocoran Air / Pipa Rusak', desc: 'Kebocoran pipa, wastafel, toilet, atau rembesan plafon', severity: 'HIGH', sort: 12, blockReady: true, noteReq: true, photoReq: true, chargeAllowed: false, supReview: true },
          { code: 'KELISTRIKAN_RUSAK', label: 'Kelistrikan Rusak / Korsleting', desc: 'Saklar, stop kontak, atau instalasi listrik bermasalah dan berbahaya', severity: 'CRITICAL', sort: 13, blockReady: true, noteReq: true, photoReq: false, chargeAllowed: false, supReview: true }
        ];

        for (const item of blockingSeeds) {
          await auditMigrationClient.query(`
            INSERT INTO housekeeping_finding_types (
              property_id, code, label, description, severity, sort_order,
              note_required, photo_required, estimated_charge_allowed, supervisor_review_required, block_room_ready, is_active
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE)
            ON CONFLICT (property_id, code) DO UPDATE
            SET block_room_ready = EXCLUDED.block_room_ready,
                updated_at = NOW();
          `, [
            p.id, item.code, item.label, item.desc, item.severity, item.sort,
            item.noteReq, item.photoReq, item.chargeAllowed, item.supReview, item.blockReady
          ]);
        }
      }
    }

    // -------------------------------------------------------------------------
    // MIGRATION 15: Housekeeping Checklist Template Hardening (EMP-MOBILE-3C)
    // -------------------------------------------------------------------------
    const hasHkChecklistHardening = await auditMigrationClient.query(
      `SELECT 1 FROM schema_migrations WHERE version = 'housekeeping_checklist_template_hardening_v1'`
    );

    if ((hasHkChecklistHardening.rowCount ?? 0) === 0) {
      // 1. Column additions
      await auditMigrationClient.query(`
        ALTER TABLE checklist_templates
          ADD COLUMN IF NOT EXISTS description TEXT,
          ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS is_system_template BOOLEAN NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;

        ALTER TABLE checklist_template_items
          ADD COLUMN IF NOT EXISTS description TEXT,
          ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP;

        ALTER TABLE housekeeping_tasks
          ADD COLUMN IF NOT EXISTS cleaning_note TEXT,
          ADD COLUMN IF NOT EXISTS cleaning_note_by VARCHAR(150),
          ADD COLUMN IF NOT EXISTS cleaning_note_at TIMESTAMP WITHOUT TIME ZONE;

        ALTER TABLE property_housekeeping_settings
          ADD COLUMN IF NOT EXISTS default_final_inspection_template_code VARCHAR(50) NOT NULL DEFAULT 'FINAL_INSPECTION',
          ADD COLUMN IF NOT EXISTS housekeeping_category_bulk_check_enabled BOOLEAN NOT NULL DEFAULT FALSE;
      `);

      // 2. Mark system templates
      await auditMigrationClient.query(`
        UPDATE checklist_templates
        SET is_system_template = TRUE
        WHERE code IN ('STANDARD_ROOM_CLEANING', 'CHECKOUT_INSPECTION', 'FINAL_INSPECTION');
      `);

      // 3. Ensure all default items are active for STANDARD_ROOM_CLEANING across all properties
      await auditMigrationClient.query(`
        UPDATE checklist_template_items
        SET is_active = TRUE
        WHERE template_id IN (
          SELECT id FROM checklist_templates WHERE code = 'STANDARD_ROOM_CLEANING'
        ) AND is_archived = FALSE;
      `);

      // 4. Seed 'Isi Minibar / Kulkas' for all STANDARD_ROOM_CLEANING templates if not exists
      const stdTemplates = await auditMigrationClient.query(`
        SELECT id, property_id FROM checklist_templates WHERE code = 'STANDARD_ROOM_CLEANING'
      `);

      for (const tpl of stdTemplates.rows) {
        const itemExists = await auditMigrationClient.query(`
          SELECT 1 FROM checklist_template_items
          WHERE template_id = $1 AND (label ILIKE '%minibar%' OR label ILIKE '%kulkas%')
        `, [tpl.id]);

        if ((itemExists.rowCount ?? 0) === 0) {
          await auditMigrationClient.query(`
            INSERT INTO checklist_template_items (
              template_id, section, label, sort_order, is_required, requires_note, requires_photo, is_active
            ) VALUES ($1, 'ROOM_AMENITIES', 'Isi Minibar / Kulkas', 16, FALSE, FALSE, FALSE, TRUE)
          `, [tpl.id]);
        }
      }

      await auditMigrationClient.query(`
        INSERT INTO schema_migrations (version)
        VALUES ('housekeeping_checklist_template_hardening_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // Migration 16: Grouped Housekeeping Checklist + Drag & Drop Sync (EMP-MOBILE-3F)
    const m16Check = await auditMigrationClient.query(
      `SELECT 1 FROM schema_migrations WHERE version = 'housekeeping_checklist_groups_v1'`
    );
    if ((m16Check.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        CREATE TABLE IF NOT EXISTS checklist_template_groups (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
          template_id INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
          code VARCHAR(50),
          name VARCHAR(150) NOT NULL,
          description TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          is_archived BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_checklist_template_groups_template ON checklist_template_groups (template_id);
        CREATE INDEX IF NOT EXISTS idx_checklist_template_groups_prop ON checklist_template_groups (property_id);

        ALTER TABLE checklist_template_items ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES checklist_template_groups(id) ON DELETE SET NULL;
        ALTER TABLE checklist_template_items ADD COLUMN IF NOT EXISTS description TEXT;
        ALTER TABLE checklist_template_items ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE checklist_template_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP;

        ALTER TABLE housekeeping_task_checklist_items ADD COLUMN IF NOT EXISTS group_id INTEGER;
        ALTER TABLE housekeeping_task_checklist_items ADD COLUMN IF NOT EXISTS source_group_id INTEGER;
        ALTER TABLE housekeeping_task_checklist_items ADD COLUMN IF NOT EXISTS group_code VARCHAR(50);
        ALTER TABLE housekeeping_task_checklist_items ADD COLUMN IF NOT EXISTS group_name VARCHAR(150);
        ALTER TABLE housekeeping_task_checklist_items ADD COLUMN IF NOT EXISTS group_sort_order INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE housekeeping_task_checklist_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      `);

      // Seed & structure canonical groups for standard room cleaning templates
      const stdTemplates = await auditMigrationClient.query(`
        SELECT id, property_id FROM checklist_templates WHERE code = 'STANDARD_ROOM_CLEANING'
      `);

      for (const tpl of stdTemplates.rows) {
        // Group definitions
        const groupDefs = [
          {
            code: 'KAMAR_MANDI',
            name: 'KAMAR MANDI',
            sort_order: 10,
            items: [
              { label: 'Sabun', sort_order: 10, is_required: true },
              { label: 'Sampo', sort_order: 20, is_required: true },
              { label: 'Handuk', sort_order: 30, is_required: true },
              { label: 'Toilet', sort_order: 40, is_required: true },
              { label: 'Shower', sort_order: 50, is_required: true },
              { label: 'Wastafel', sort_order: 60, is_required: true }
            ]
          },
          {
            code: 'RUANGAN_KAMAR',
            name: 'RUANGAN KAMAR',
            sort_order: 20,
            items: [
              { label: 'Kebersihan Lantai', sort_order: 10, is_required: true },
              { label: 'Kasur / Bed', sort_order: 20, is_required: true },
              { label: 'Sprei', sort_order: 30, is_required: true },
              { label: 'Bantal', sort_order: 40, is_required: true },
              { label: 'Selimut', sort_order: 50, is_required: true },
              { label: 'Furniture', sort_order: 60, is_required: true },
              { label: 'Lampu', sort_order: 70, is_required: true },
              { label: 'AC', sort_order: 80, is_required: true },
              { label: 'TV', sort_order: 90, is_required: true },
              { label: 'Remote TV', sort_order: 100, is_required: true },
              { label: 'Remote AC', sort_order: 110, is_required: true }
            ]
          },
          {
            code: 'AMENITIES',
            name: 'AMENITIES',
            sort_order: 30,
            items: [
              { label: 'Teh', sort_order: 10, is_required: false },
              { label: 'Kopi', sort_order: 20, is_required: false },
              { label: 'Gula', sort_order: 30, is_required: false },
              { label: 'Air Mineral', sort_order: 40, is_required: true },
              { label: 'Tissue', sort_order: 50, is_required: true },
              { label: 'Perlengkapan Mandi', sort_order: 60, is_required: true }
            ]
          },
          {
            code: 'MINIBAR_KULKAS',
            name: 'MINIBAR / KULKAS',
            sort_order: 40,
            items: [
              { label: 'Coca-Cola', sort_order: 10, is_required: false },
              { label: 'Sprite', sort_order: 20, is_required: false },
              { label: 'UHT', sort_order: 30, is_required: false }
            ]
          }
        ];

        const canonicalItemIds: number[] = [];
        for (const gDef of groupDefs) {
          let groupId: number;
          const gRes = await auditMigrationClient.query(
            `SELECT id FROM checklist_template_groups WHERE template_id = $1 AND code = $2`,
            [tpl.id, gDef.code]
          );

          if ((gRes.rowCount ?? 0) > 0) {
            groupId = gRes.rows[0].id;
            await auditMigrationClient.query(
              `UPDATE checklist_template_groups SET name = $1, sort_order = $2, is_active = TRUE, is_archived = FALSE WHERE id = $3`,
              [gDef.name, gDef.sort_order, groupId]
            );
          } else {
            const insG = await auditMigrationClient.query(
              `INSERT INTO checklist_template_groups (property_id, template_id, code, name, sort_order, is_active, is_archived, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, TRUE, FALSE, NOW(), NOW())
               RETURNING id`,
              [tpl.property_id, tpl.id, gDef.code, gDef.name, gDef.sort_order]
            );
            groupId = insG.rows[0].id;
          }

          // Insert or assign items
          for (const itemDef of gDef.items) {
            const itCheck = await auditMigrationClient.query(
              `SELECT id FROM checklist_template_items WHERE template_id = $1 AND (label ILIKE $2 OR label = $3)`,
              [tpl.id, `%${itemDef.label}%`, itemDef.label]
            );

            if ((itCheck.rowCount ?? 0) > 0) {
              const itemId = itCheck.rows[0].id;
              canonicalItemIds.push(itemId);
              await auditMigrationClient.query(
                `UPDATE checklist_template_items
                 SET group_id = $1, section = $2, label = $3, sort_order = $4, is_required = $5, is_active = TRUE, is_archived = FALSE, updated_at = NOW()
                 WHERE id = $6`,
                [groupId, gDef.name, itemDef.label, itemDef.sort_order, itemDef.is_required, itemId]
              );
            } else {
              const insItem = await auditMigrationClient.query(
                `INSERT INTO checklist_template_items (
                   template_id, group_id, section, label, sort_order, is_required, requires_note, requires_photo, is_active, is_archived, created_at, updated_at
                 ) VALUES ($1, $2, $3, $4, $5, $6, FALSE, FALSE, TRUE, FALSE, NOW(), NOW())
                 RETURNING id`,
                [tpl.id, groupId, gDef.name, itemDef.label, itemDef.sort_order, itemDef.is_required]
              );
              canonicalItemIds.push(insItem.rows[0].id);
            }
          }
        }

        if (canonicalItemIds.length > 0) {
          await auditMigrationClient.query(
            `UPDATE checklist_template_items
             SET is_archived = TRUE, is_active = FALSE
             WHERE template_id = $1 AND id NOT IN (${canonicalItemIds.join(',')})`,
            [tpl.id]
          );
        }
      }

      // For all other templates, create a default group if items exist without group
      const allTemplates = await auditMigrationClient.query(`SELECT id, property_id, name, code FROM checklist_templates`);
      for (const tpl of allTemplates.rows) {
        const ungroupedItems = await auditMigrationClient.query(
          `SELECT id, section, label FROM checklist_template_items WHERE template_id = $1 AND group_id IS NULL`,
          [tpl.id]
        );
        if ((ungroupedItems.rowCount ?? 0) > 0) {
          let grpRes = await auditMigrationClient.query(
            `SELECT id FROM checklist_template_groups WHERE template_id = $1 LIMIT 1`,
            [tpl.id]
          );
          let gid: number;
          if ((grpRes.rowCount ?? 0) > 0) {
            gid = grpRes.rows[0].id;
          } else {
            const ins = await auditMigrationClient.query(
              `INSERT INTO checklist_template_groups (property_id, template_id, code, name, sort_order, is_active, is_archived, created_at, updated_at)
               VALUES ($1, $2, 'PEMERIKSAAN', 'PEMERIKSAAN', 10, TRUE, FALSE, NOW(), NOW())
               RETURNING id`,
              [tpl.property_id, tpl.id]
            );
            gid = ins.rows[0].id;
          }
          await auditMigrationClient.query(
            `UPDATE checklist_template_items SET group_id = $1 WHERE template_id = $2 AND group_id IS NULL`,
            [gid, tpl.id]
          );
        }
      }

      // Backfill historical snapshot tasks group_name if missing
      await auditMigrationClient.query(`
        UPDATE housekeeping_task_checklist_items
        SET group_name = CASE
          WHEN section ILIKE '%BATHROOM%' OR section ILIKE '%MANDI%' OR label ILIKE '%sabun%' OR label ILIKE '%sampo%' OR label ILIKE '%handuk%' OR label ILIKE '%toilet%' OR label ILIKE '%shower%' OR label ILIKE '%wastafel%' THEN 'KAMAR MANDI'
          WHEN section ILIKE '%MINIBAR%' OR label ILIKE '%coca%' OR label ILIKE '%sprite%' OR label ILIKE '%uht%' OR label ILIKE '%kulkas%' THEN 'MINIBAR / KULKAS'
          WHEN section ILIKE '%AMENITIES%' OR label ILIKE '%teh%' OR label ILIKE '%kopi%' OR label ILIKE '%gula%' OR label ILIKE '%mineral%' OR label ILIKE '%tissue%' THEN 'AMENITIES'
          ELSE 'RUANGAN KAMAR'
        END,
        group_sort_order = CASE
          WHEN section ILIKE '%BATHROOM%' OR section ILIKE '%MANDI%' OR label ILIKE '%sabun%' OR label ILIKE '%sampo%' OR label ILIKE '%handuk%' OR label ILIKE '%toilet%' OR label ILIKE '%shower%' OR label ILIKE '%wastafel%' THEN 10
          WHEN section ILIKE '%MINIBAR%' OR label ILIKE '%coca%' OR label ILIKE '%sprite%' OR label ILIKE '%uht%' OR label ILIKE '%kulkas%' THEN 40
          WHEN section ILIKE '%AMENITIES%' OR label ILIKE '%teh%' OR label ILIKE '%kopi%' OR label ILIKE '%gula%' OR label ILIKE '%mineral%' OR label ILIKE '%tissue%' THEN 30
          ELSE 20
        END
        WHERE group_name IS NULL OR group_name = '';
      `);

      await auditMigrationClient.query(`
        INSERT INTO schema_migrations (version)
        VALUES ('housekeeping_checklist_groups_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // Migration 17 / Canonical Content Sync: Canonical Housekeeping Checklist Content (EMP-MOBILE-3G)
    const stdTemplates = await auditMigrationClient.query(`
      SELECT id, property_id FROM checklist_templates WHERE code = 'STANDARD_ROOM_CLEANING'
    `);

    const canonicalStructure = [
      {
        code: 'KAMAR_MANDI',
        name: 'KAMAR MANDI',
        sort_order: 10,
        items: [
          { label: 'Sabun', sort_order: 10, is_required: true, aliases: ['Sabun'] },
          { label: 'Sampo', sort_order: 20, is_required: true, aliases: ['Sampo'] },
          { label: 'Handuk', sort_order: 30, is_required: true, aliases: ['Handuk', 'Handuk diganti / diperiksa'] },
          { label: 'Toilet', sort_order: 40, is_required: true, aliases: ['Toilet', 'Toilet dibersihkan'] },
          { label: 'Shower', sort_order: 50, is_required: true, aliases: ['Shower', 'Shower dibersihkan'] },
          { label: 'Wastafel', sort_order: 60, is_required: true, aliases: ['Wastafel'] },
          { label: 'Air Panas', sort_order: 70, is_required: true, aliases: ['Air Panas', 'Air panas diperiksa'] },
          { label: 'Kebersihan Lantai Kamar Mandi', sort_order: 80, is_required: true, aliases: ['Kebersihan Lantai Kamar Mandi'] }
        ]
      },
      {
        code: 'RUANGAN_KAMAR',
        name: 'RUANGAN KAMAR',
        sort_order: 20,
        items: [
          { label: 'Kebersihan Lantai', sort_order: 10, is_required: true, aliases: ['Kebersihan Lantai'] },
          { label: 'Kasur / Bed', sort_order: 20, is_required: true, aliases: ['Kasur / Bed'] },
          { label: 'Sprei', sort_order: 30, is_required: true, aliases: ['Sprei', 'Sprei diganti / diperiksa'] },
          { label: 'Bantal', sort_order: 40, is_required: true, aliases: ['Bantal', 'Bantal diperiksa'] },
          { label: 'Selimut', sort_order: 50, is_required: true, aliases: ['Selimut'] },
          { label: 'Furniture', sort_order: 60, is_required: true, aliases: ['Furniture', 'Debu furniture dibersihkan'] },
          { label: 'Lampu', sort_order: 70, is_required: true, aliases: ['Lampu'] },
          { label: 'AC', sort_order: 80, is_required: true, aliases: ['AC', 'AC diperiksa'] },
          { label: 'TV', sort_order: 90, is_required: true, aliases: ['TV'] },
          { label: 'Remote TV', sort_order: 100, is_required: true, aliases: ['Remote TV'] },
          { label: 'Remote AC', sort_order: 110, is_required: true, aliases: ['Remote AC'] },
          { label: 'Tirai / Ventilasi', sort_order: 120, is_required: true, aliases: ['Tirai / Ventilasi'] },
          { label: 'Tempat Sampah', sort_order: 130, is_required: true, aliases: ['Tempat Sampah', 'Trash bin kosong'] }
        ]
      },
      {
        code: 'AMENITIES',
        name: 'AMENITIES',
        sort_order: 30,
        items: [
          { label: 'Teh', sort_order: 10, is_required: false, aliases: ['Teh'] },
          { label: 'Kopi', sort_order: 20, is_required: false, aliases: ['Kopi'] },
          { label: 'Gula', sort_order: 30, is_required: false, aliases: ['Gula'] },
          { label: 'Air Mineral', sort_order: 40, is_required: true, aliases: ['Air Mineral', 'Air mineral tersedia'] },
          { label: 'Tissue', sort_order: 50, is_required: true, aliases: ['Tissue'] },
          { label: 'Perlengkapan Mandi', sort_order: 60, is_required: true, aliases: ['Perlengkapan Mandi'] },
          { label: 'Hanger', sort_order: 70, is_required: false, aliases: ['Hanger'] }
        ]
      },
      {
        code: 'MINIBAR_KULKAS',
        name: 'MINIBAR / KULKAS',
        sort_order: 40,
        items: [
          { label: 'Coca-Cola', sort_order: 10, is_required: false, aliases: ['Coca-Cola'] },
          { label: 'Sprite', sort_order: 20, is_required: false, aliases: ['Sprite'] },
          { label: 'UHT', sort_order: 30, is_required: false, aliases: ['UHT'] }
        ]
      }
    ];

    for (const tpl of stdTemplates.rows) {
      const canonicalItemIds: number[] = [];
      const usedExistingIds = new Set<number>();

      for (const gDef of canonicalStructure) {
        let groupId: number;
        const gRes = await auditMigrationClient.query(
          `SELECT id FROM checklist_template_groups WHERE template_id = $1 AND code = $2`,
          [tpl.id, gDef.code]
        );
        if ((gRes.rowCount ?? 0) > 0) {
          groupId = gRes.rows[0].id;
          await auditMigrationClient.query(
            `UPDATE checklist_template_groups
             SET name = $1, sort_order = $2, is_active = TRUE, is_archived = FALSE, updated_at = NOW()
             WHERE id = $3`,
            [gDef.name, gDef.sort_order, groupId]
          );
        } else {
          const insG = await auditMigrationClient.query(
            `INSERT INTO checklist_template_groups (property_id, template_id, code, name, sort_order, is_active, is_archived, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, TRUE, FALSE, NOW(), NOW())
             RETURNING id`,
            [tpl.property_id, tpl.id, gDef.code, gDef.name, gDef.sort_order]
          );
          groupId = insG.rows[0].id;
        }

        for (const itemDef of gDef.items) {
          let existingId: number | null = null;
          for (const alias of itemDef.aliases) {
            const matchRes = await auditMigrationClient.query(
              `SELECT id FROM checklist_template_items
               WHERE template_id = $1 AND (label = $2 OR label ILIKE $3)
               ORDER BY CASE WHEN label = $2 THEN 0 ELSE 1 END, id ASC`,
              [tpl.id, alias, `%${alias}%`]
            );
            for (const row of matchRes.rows) {
              if (!usedExistingIds.has(row.id)) {
                existingId = row.id;
                break;
              }
            }
            if (existingId) break;
          }

          if (existingId) {
            usedExistingIds.add(existingId);
            canonicalItemIds.push(existingId);
            await auditMigrationClient.query(
              `UPDATE checklist_template_items
               SET group_id = $1, section = $2, label = $3, sort_order = $4, is_required = $5,
                   is_active = TRUE, is_archived = FALSE, updated_at = NOW()
               WHERE id = $6`,
              [groupId, gDef.name, itemDef.label, itemDef.sort_order, itemDef.is_required, existingId]
            );
          } else {
            const insItem = await auditMigrationClient.query(
              `INSERT INTO checklist_template_items (
                 template_id, group_id, section, label, sort_order, is_required, requires_note, requires_photo, is_active, is_archived, created_at, updated_at
               ) VALUES ($1, $2, $3, $4, $5, $6, FALSE, FALSE, TRUE, FALSE, NOW(), NOW())
               RETURNING id`,
              [tpl.id, groupId, gDef.name, itemDef.label, itemDef.sort_order, itemDef.is_required]
            );
            const newId = insItem.rows[0].id;
            usedExistingIds.add(newId);
            canonicalItemIds.push(newId);
          }
        }
      }

      if (canonicalItemIds.length > 0) {
        await auditMigrationClient.query(
          `UPDATE checklist_template_items
           SET is_archived = TRUE, is_active = FALSE, updated_at = NOW()
           WHERE template_id = $1 AND id NOT IN (${canonicalItemIds.join(',')})`,
          [tpl.id]
        );
      }
    }

    await auditMigrationClient.query(`
      INSERT INTO schema_migrations (version)
      VALUES ('housekeeping_canonical_checklist_content_v1')
      ON CONFLICT (version) DO NOTHING;
    `);

    // Always ensure active system templates have active items
    await auditMigrationClient.query(`
      UPDATE checklist_template_items
      SET is_active = TRUE, is_archived = FALSE
      WHERE template_id IN (
        SELECT id FROM checklist_templates WHERE is_system_template = TRUE AND is_archived = FALSE
      ) AND is_archived = FALSE;

      UPDATE housekeeping_finding_types
      SET is_active = TRUE
      WHERE code IN ('MINIBAR', 'REMOTE_TV_HILANG', 'REMOTE_AC_HILANG', 'HANDUK_KURANG', 'LINEN_RUSAK', 'BARANG_HILANG', 'KERUSAKAN_FURNITURE', 'KERUSAKAN_ELEKTRONIK', 'LOST_AND_FOUND', 'LAINNYA', 'AC_TIDAK_DINGIN', 'KEBOCORAN_AIR', 'KELISTRIKAN_RUSAK');

      UPDATE housekeeping_finding_types
      SET estimated_charge_allowed = TRUE
      WHERE code IN ('MINIBAR', 'REMOTE_TV_HILANG', 'REMOTE_AC_HILANG', 'HANDUK_KURANG', 'LINEN_RUSAK', 'BARANG_HILANG', 'KERUSAKAN_FURNITURE', 'KERUSAKAN_ELEKTRONIK', 'LAINNYA');
    `);

    // -------------------------------------------------------------------------
    // MIGRATION 18: Rate Plan & Room Pricing Foundation (RATE-1)
    // -------------------------------------------------------------------------
    const ratePlanMigRes = await auditMigrationClient.query(
      `SELECT 1 FROM schema_migrations WHERE version = 'rate_plans_and_pricing_foundation_v1'`
    );

    if (ratePlanMigRes.rows.length === 0) {
      await auditMigrationClient.query(`
        -- 1. Property Pricing Settings (Tax & Service Charge configuration)
        CREATE TABLE IF NOT EXISTS property_pricing_settings (
          property_id INTEGER PRIMARY KEY REFERENCES properties(id),
          tax_percent NUMERIC(5, 2) NOT NULL DEFAULT 10.00,
          service_charge_percent NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
          prices_include_tax BOOLEAN NOT NULL DEFAULT false,
          prices_include_service BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        -- 2. Rate Plans master table
        CREATE TABLE IF NOT EXISTS rate_plans (
          id BIGSERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id),
          room_type_id INTEGER NOT NULL REFERENCES room_types(id),
          code VARCHAR(50) NOT NULL,
          name VARCHAR(150) NOT NULL,
          description TEXT,
          base_rate BIGINT NOT NULL CHECK (base_rate >= 0),
          currency VARCHAR(10) NOT NULL DEFAULT 'IDR',
          meal_plan VARCHAR(50) NOT NULL DEFAULT 'RO',
          refundable BOOLEAN NOT NULL DEFAULT true,
          cancellation_policy TEXT,
          payment_policy TEXT,
          valid_from DATE,
          valid_until DATE,
          min_stay INTEGER NOT NULL DEFAULT 1 CHECK (min_stay >= 1),
          max_stay INTEGER CHECK (max_stay IS NULL OR max_stay >= min_stay),
          min_advance_days INTEGER DEFAULT 0 CHECK (min_advance_days >= 0),
          max_advance_days INTEGER CHECK (max_advance_days IS NULL OR max_advance_days >= min_advance_days),
          extra_person_rate BIGINT NOT NULL DEFAULT 0 CHECK (extra_person_rate >= 0),
          extra_bed_rate BIGINT NOT NULL DEFAULT 0 CHECK (extra_bed_rate >= 0),
          days_of_week INTEGER[],
          is_active BOOLEAN NOT NULL DEFAULT true,
          is_archived BOOLEAN NOT NULL DEFAULT false,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_by VARCHAR(100),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by VARCHAR(100),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE UNIQUE INDEX IF NOT EXISTS uq_rate_plans_prop_code_active 
          ON rate_plans(property_id, UPPER(TRIM(code))) 
          WHERE (is_archived = FALSE);

        CREATE INDEX IF NOT EXISTS idx_rate_plans_property_room_type 
          ON rate_plans(property_id, room_type_id, is_active, is_archived);

        -- 3. Rate Calendar Overrides table
        CREATE TABLE IF NOT EXISTS rate_overrides (
          id BIGSERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id),
          rate_plan_id BIGINT NOT NULL REFERENCES rate_plans(id) ON DELETE CASCADE,
          start_date DATE NOT NULL,
          end_date DATE NOT NULL,
          override_rate BIGINT NOT NULL CHECK (override_rate >= 0),
          days_of_week INTEGER[],
          reason VARCHAR(255),
          is_active BOOLEAN NOT NULL DEFAULT true,
          is_archived BOOLEAN NOT NULL DEFAULT false,
          created_by VARCHAR(100),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by VARCHAR(100),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT chk_rate_overrides_date_range CHECK (end_date > start_date)
        );

        CREATE INDEX IF NOT EXISTS idx_rate_overrides_plan_dates 
          ON rate_overrides(property_id, rate_plan_id, start_date, end_date, is_active, is_archived);

        -- 4. Reservation Nightly Rate Snapshots (Immutable Financial Ledger)
        CREATE TABLE IF NOT EXISTS reservation_nightly_rates (
          id BIGSERIAL PRIMARY KEY,
          reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
          property_id INTEGER NOT NULL REFERENCES properties(id),
          stay_date DATE NOT NULL,
          room_type_id INTEGER NOT NULL REFERENCES room_types(id),
          room_type_code_snapshot VARCHAR(50),
          room_type_name_snapshot VARCHAR(150),
          rate_plan_id BIGINT REFERENCES rate_plans(id),
          rate_plan_code_snapshot VARCHAR(50),
          rate_plan_name_snapshot VARCHAR(150),
          base_rate BIGINT NOT NULL,
          applied_override_rate BIGINT,
          final_room_rate BIGINT NOT NULL,
          service_amount BIGINT NOT NULL DEFAULT 0,
          tax_amount BIGINT NOT NULL DEFAULT 0,
          total_amount BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT uq_reservation_stay_date UNIQUE (reservation_id, stay_date)
        );

        CREATE INDEX IF NOT EXISTS idx_res_nightly_rates_property_stay 
          ON reservation_nightly_rates(property_id, stay_date);

        -- 5. Extend reservations columns safely
        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS rate_plan_id BIGINT REFERENCES rate_plans(id);
        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS rate_plan_code_snapshot VARCHAR(50);
        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS rate_plan_name_snapshot VARCHAR(150);
        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS subtotal_amount NUMERIC(12, 2) DEFAULT 0;
        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(12, 2) DEFAULT 0;
        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS service_amount NUMERIC(12, 2) DEFAULT 0;

        -- 6. Seed Property Pricing Settings for all existing properties
        INSERT INTO property_pricing_settings (property_id, tax_percent, service_charge_percent, prices_include_tax, prices_include_service)
        SELECT p.id, 10.00, 0.00, false, false
        FROM properties p
        ON CONFLICT (property_id) DO NOTHING;

        -- 7. Seed baseline BAR rate plans for active room types of Property 1 (if none exist)
        INSERT INTO rate_plans (property_id, room_type_id, code, name, description, base_rate, meal_plan, refundable, is_active, is_archived, sort_order, created_by)
        SELECT 
          rt.property_id,
          rt.id,
          'BAR-' || UPPER(REPLACE(COALESCE(rt.code, 'RT' || rt.id), ' ', '-')),
          COALESCE(rt.name, 'Room Type ' || rt.id) || ' - Best Available Rate',
          'Standard Best Available Rate (Room Only)',
          COALESCE(ROUND(rt.base_rate), 0)::BIGINT,
          'RO',
          TRUE,
          TRUE,
          FALSE,
          COALESCE(rt.display_order, 0),
          'SYSTEM_SEED'
        FROM room_types rt
        WHERE rt.property_id = 1 AND rt.is_active = TRUE
          AND NOT EXISTS (
            SELECT 1 FROM rate_plans rp WHERE rp.property_id = rt.property_id AND rp.room_type_id = rt.id
          );

        INSERT INTO schema_migrations (version)
        VALUES ('rate_plans_and_pricing_foundation_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // MIGRATION 19: Meal Plan Master & Rate Plan Relational Link (RATE-1C)
    const mealPlanMigrationCheck = await auditMigrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'meal_plans_and_rate_plan_relational_link_v1'"
    );
    if ((mealPlanMigrationCheck.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        -- 1. Meal Plans Master table
        CREATE TABLE IF NOT EXISTS meal_plans (
          id BIGSERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id),
          code VARCHAR(50) NOT NULL,
          name VARCHAR(150) NOT NULL,
          description TEXT,
          breakfast_included BOOLEAN NOT NULL DEFAULT false,
          lunch_included BOOLEAN NOT NULL DEFAULT false,
          dinner_included BOOLEAN NOT NULL DEFAULT false,
          is_active BOOLEAN NOT NULL DEFAULT true,
          is_archived BOOLEAN NOT NULL DEFAULT false,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_by VARCHAR(100),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by VARCHAR(100),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE UNIQUE INDEX IF NOT EXISTS uq_meal_plans_prop_code_active 
          ON meal_plans(property_id, UPPER(TRIM(code))) 
          WHERE (is_archived = FALSE);

        CREATE INDEX IF NOT EXISTS idx_meal_plans_prop_active_archived
          ON meal_plans(property_id, is_active, is_archived);

        -- 2. Seed baseline standard meal plans for existing properties (e.g. Property 1)
        INSERT INTO meal_plans (property_id, code, name, description, breakfast_included, lunch_included, dinner_included, is_active, is_archived, sort_order, created_by)
        SELECT p.id, 'RO', 'Room Only', 'Hanya sewa kamar tanpa makan', false, false, false, true, false, 1, 'SYSTEM_SEED'
        FROM properties p
        WHERE NOT EXISTS (SELECT 1 FROM meal_plans mp WHERE mp.property_id = p.id AND mp.code = 'RO');

        INSERT INTO meal_plans (property_id, code, name, description, breakfast_included, lunch_included, dinner_included, is_active, is_archived, sort_order, created_by)
        SELECT p.id, 'BB', 'Bed & Breakfast', 'Kamar termasuk sarapan pagi (Breakfast)', true, false, false, true, false, 2, 'SYSTEM_SEED'
        FROM properties p
        WHERE NOT EXISTS (SELECT 1 FROM meal_plans mp WHERE mp.property_id = p.id AND mp.code = 'BB');

        INSERT INTO meal_plans (property_id, code, name, description, breakfast_included, lunch_included, dinner_included, is_active, is_archived, sort_order, created_by)
        SELECT p.id, 'HB', 'Half Board', 'Kamar termasuk sarapan pagi dan makan malam', true, false, true, true, false, 3, 'SYSTEM_SEED'
        FROM properties p
        WHERE NOT EXISTS (SELECT 1 FROM meal_plans mp WHERE mp.property_id = p.id AND mp.code = 'HB');

        INSERT INTO meal_plans (property_id, code, name, description, breakfast_included, lunch_included, dinner_included, is_active, is_archived, sort_order, created_by)
        SELECT p.id, 'FB', 'Full Board', 'Kamar termasuk sarapan, makan siang, dan makan malam', true, true, true, true, false, 4, 'SYSTEM_SEED'
        FROM properties p
        WHERE NOT EXISTS (SELECT 1 FROM meal_plans mp WHERE mp.property_id = p.id AND mp.code = 'FB');

        INSERT INTO meal_plans (property_id, code, name, description, breakfast_included, lunch_included, dinner_included, is_active, is_archived, sort_order, created_by)
        SELECT p.id, 'AI', 'All Inclusive', 'Kamar termasuk semua makan, camilan, dan minuman', true, true, true, true, false, 5, 'SYSTEM_SEED'
        FROM properties p
        WHERE NOT EXISTS (SELECT 1 FROM meal_plans mp WHERE mp.property_id = p.id AND mp.code = 'AI');

        -- 3. Extend rate_plans with meal_plan_id relational foreign key
        ALTER TABLE rate_plans ADD COLUMN IF NOT EXISTS meal_plan_id BIGINT REFERENCES meal_plans(id);

        -- Backward compatibility backfill: link existing rate_plans to meal_plans
        UPDATE rate_plans rp
        SET meal_plan_id = mp.id
        FROM meal_plans mp
        WHERE rp.meal_plan_id IS NULL
          AND mp.property_id = rp.property_id
          AND UPPER(TRIM(rp.meal_plan)) = UPPER(TRIM(mp.code));

        -- 4. Extend reservation snapshots and reservations table for meal plan auditability
        ALTER TABLE reservation_nightly_rates ADD COLUMN IF NOT EXISTS meal_plan_id BIGINT REFERENCES meal_plans(id);
        ALTER TABLE reservation_nightly_rates ADD COLUMN IF NOT EXISTS meal_plan_code_snapshot VARCHAR(50);
        ALTER TABLE reservation_nightly_rates ADD COLUMN IF NOT EXISTS meal_plan_name_snapshot VARCHAR(150);

        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS meal_plan_id BIGINT REFERENCES meal_plans(id);
        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS meal_plan_code_snapshot VARCHAR(50);
        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS meal_plan_name_snapshot VARCHAR(150);

        INSERT INTO schema_migrations (version)
        VALUES ('meal_plans_and_rate_plan_relational_link_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // Migration 20: Stay charges & Day Use / Transit foundation (STAY-CHARGE-1)
    const stayChargeMigrationRes = await auditMigrationClient.query(
      `SELECT version FROM schema_migrations WHERE version = 'stay_charge_and_day_use_foundation_v1'`
    );
    if (stayChargeMigrationRes.rowCount === 0) {
      await auditMigrationClient.query(`
        -- 1. Extend reservations table with stay_type and datetime timestamps
        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS stay_type VARCHAR(20) DEFAULT 'OVERNIGHT';
        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS start_at TIMESTAMP WITH TIME ZONE;
        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS end_at TIMESTAMP WITH TIME ZONE;

        ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_check_out_after_check_in;
        ALTER TABLE reservations ADD CONSTRAINT reservations_check_out_after_check_in CHECK ((stay_type = 'DAY_USE' AND check_out >= check_in) OR (check_out > check_in)) NOT VALID;

        CREATE INDEX IF NOT EXISTS idx_reservations_stay_type ON reservations (stay_type);
        CREATE INDEX IF NOT EXISTS idx_reservations_room_time ON reservations (room_id, start_at, end_at);

        -- 2. Extend rate_plans table with Day Use rate configuration
        ALTER TABLE rate_plans ADD COLUMN IF NOT EXISTS rate_type VARCHAR(20) NOT NULL DEFAULT 'OVERNIGHT';
        ALTER TABLE rate_plans ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;
        ALTER TABLE rate_plans ADD COLUMN IF NOT EXISTS earliest_start_time VARCHAR(10);
        ALTER TABLE rate_plans ADD COLUMN IF NOT EXISTS latest_start_time VARCHAR(10);
        ALTER TABLE rate_plans ADD COLUMN IF NOT EXISTS turnaround_buffer_minutes INTEGER DEFAULT 60;
        CREATE INDEX IF NOT EXISTS idx_rate_plans_rate_type ON rate_plans (property_id, rate_type, is_active, is_archived);

        -- 3. Create stay_charge_rules table
        CREATE TABLE IF NOT EXISTS stay_charge_rules (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
          charge_type VARCHAR(30) NOT NULL, -- EXTRA_BED, EXTRA_PERSON, EARLY_CHECKIN, LATE_CHECKOUT, PENALTY
          code VARCHAR(50) NOT NULL,
          name VARCHAR(150) NOT NULL,
          description TEXT,
          charge_method VARCHAR(30) NOT NULL DEFAULT 'FIXED_AMOUNT', -- FIXED_AMOUNT, PERCENTAGE_OF_NIGHTLY_RATE, FULL_NIGHT, FREE, MANUAL
          default_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
          percentage_rate NUMERIC(5, 2) DEFAULT 0,
          cutoff_time VARCHAR(10),
          taxable BOOLEAN NOT NULL DEFAULT TRUE,
          service_chargeable BOOLEAN NOT NULL DEFAULT TRUE,
          requires_note BOOLEAN NOT NULL DEFAULT FALSE,
          requires_photo BOOLEAN NOT NULL DEFAULT FALSE,
          requires_supervisor_approval BOOLEAN NOT NULL DEFAULT FALSE,
          approval_threshold NUMERIC(12, 2) DEFAULT 0,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          is_archived BOOLEAN NOT NULL DEFAULT FALSE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_by VARCHAR(100),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_by VARCHAR(100),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE UNIQUE INDEX IF NOT EXISTS uq_stay_charge_rules_property_code 
          ON stay_charge_rules (property_id, UPPER(TRIM(code))) 
          WHERE is_archived = FALSE;

        CREATE INDEX IF NOT EXISTS idx_stay_charge_rules_property_type 
          ON stay_charge_rules (property_id, charge_type, is_active, is_archived);

        -- 4. Extend folio_entries with financial & source metadata
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS property_id INTEGER REFERENCES properties(id);
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS source_type VARCHAR(50);
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS source_id VARCHAR(100);
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS unit_price NUMERIC(12, 2) DEFAULT 0;
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS quantity NUMERIC(6, 2) DEFAULT 1;
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(12, 2) DEFAULT 0;
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS service_amount NUMERIC(12, 2) DEFAULT 0;
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS actor_user_id VARCHAR(100);
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS actor_name_snapshot VARCHAR(150);
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS actor_role_snapshot VARCHAR(100);
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS is_voided BOOLEAN DEFAULT FALSE;
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS void_reason TEXT;
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP WITH TIME ZONE;
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS voided_by VARCHAR(100);

        CREATE INDEX IF NOT EXISTS idx_folio_entries_res_type ON folio_entries (reservation_id, entry_type, is_voided);
        CREATE INDEX IF NOT EXISTS idx_folio_entries_prop_source ON folio_entries (property_id, source_type);

      `);
      await seedBaselineStayChargeRules(auditMigrationClient);
      await auditMigrationClient.query(`
        INSERT INTO schema_migrations (version)
        VALUES ('stay_charge_and_day_use_foundation_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // Existing properties may have received the migration before defaults were
    // provisioned centrally; add only missing baseline codes without edits.
    await seedBaselineStayChargeRules(auditMigrationClient);

    // Migration: stay_charge_financial_ledger_safety_v1
    const stayChargeSafetyCheck = await auditMigrationClient.query(
      `SELECT 1 FROM schema_migrations WHERE version = 'stay_charge_financial_ledger_safety_v1'`
    );
    if ((stayChargeSafetyCheck.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        -- 1. Extend folio_entries with reversal & correction linkages
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS reversal_of_entry_id INTEGER REFERENCES folio_entries(id) ON DELETE SET NULL;
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS correction_group_id VARCHAR(100);
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS base_amount NUMERIC(12, 2) DEFAULT 0;
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'POSTED';
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS notes TEXT;

        CREATE INDEX IF NOT EXISTS idx_folio_entries_reversal_of ON folio_entries (reversal_of_entry_id);
        CREATE INDEX IF NOT EXISTS idx_folio_entries_corr_group ON folio_entries (correction_group_id);
        CREATE INDEX IF NOT EXISTS idx_folio_entries_status ON folio_entries (status);

        -- Backfill base_amount for existing entries where base_amount is 0
        UPDATE folio_entries
        SET base_amount = COALESCE(unit_price * quantity, amount)
        WHERE (base_amount IS NULL OR base_amount = 0) AND amount > 0;

        INSERT INTO schema_migrations (version)
        VALUES ('stay_charge_financial_ledger_safety_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // Migration: rate_plan_quick_booking_integration_v1
    const ratePlanQuickBookingCheck = await auditMigrationClient.query(
      `SELECT 1 FROM schema_migrations WHERE version = 'rate_plan_quick_booking_integration_v1'`
    );
    if ((ratePlanQuickBookingCheck.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS is_manual_override BOOLEAN DEFAULT FALSE;
        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS manual_override_reason TEXT;
        ALTER TABLE reservation_nightly_rates ADD COLUMN IF NOT EXISTS is_manual_override BOOLEAN DEFAULT FALSE;
        ALTER TABLE reservation_nightly_rates ADD COLUMN IF NOT EXISTS manual_override_reason TEXT;

        INSERT INTO schema_migrations (version)
        VALUES ('rate_plan_quick_booking_integration_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // Migration: booking_ux_ota_identity_gate_v1
    const bookingUxOtaIdentityCheck = await auditMigrationClient.query(
      `SELECT 1 FROM schema_migrations WHERE version = 'booking_ux_ota_identity_gate_v1'`
    );
    if ((bookingUxOtaIdentityCheck.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        CREATE TABLE IF NOT EXISTS ota_sources (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
          code VARCHAR(50) NOT NULL,
          name VARCHAR(100) NOT NULL,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          is_archived BOOLEAN NOT NULL DEFAULT FALSE,
          display_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (property_id, code)
        );

        CREATE INDEX IF NOT EXISTS idx_ota_sources_property ON ota_sources (property_id);
        CREATE INDEX IF NOT EXISTS idx_ota_sources_active ON ota_sources (is_active, is_archived);

        -- Add columns to guests table for CRM Identity
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS identity_type VARCHAR(30) DEFAULT 'KTP';
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS identity_number VARCHAR(100);
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS identity_path TEXT;
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS has_valid_identity BOOLEAN DEFAULT FALSE;

        -- Add columns to bookings table
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booker_name VARCHAR(150);
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booker_phone VARCHAR(50);
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_channel VARCHAR(50);
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS ota_source_id INTEGER REFERENCES ota_sources(id) ON DELETE SET NULL;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS referral VARCHAR(100);

        -- Add columns to reservations table
        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS booker_name VARCHAR(150);
        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS booker_phone VARCHAR(50);
        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS booking_channel VARCHAR(50);
        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS ota_source_id INTEGER REFERENCES ota_sources(id) ON DELETE SET NULL;
        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS referral VARCHAR(100);

        -- Seed standard OTA sources for all existing properties
        INSERT INTO ota_sources (property_id, code, name, display_order)
        SELECT p.id, s.code, s.name, s.display_order
        FROM properties p
        CROSS JOIN (
          VALUES 
            ('TIKET_COM', 'Tiket.com', 1),
            ('BOOKING_COM', 'Booking.com', 2),
            ('AGODA', 'Agoda', 3)
        ) AS s(code, name, display_order)
        ON CONFLICT (property_id, code) DO NOTHING;

        INSERT INTO schema_migrations (version)
        VALUES ('booking_ux_ota_identity_gate_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    const appliedBookingUxV2 = await auditMigrationClient.query(
      `SELECT 1 FROM schema_migrations WHERE version = 'booking_ux_ota_channel_v2' LIMIT 1;`
    );
    if (!appliedBookingUxV2.rows.length) {
      await auditMigrationClient.query(`
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_channel VARCHAR(50);
        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS booking_channel VARCHAR(50);

        INSERT INTO schema_migrations (version)
        VALUES ('booking_ux_ota_channel_v2')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    const appliedBookingUxV3 = await auditMigrationClient.query(
      `SELECT 1 FROM schema_migrations WHERE version = 'booking_ux_ota_fields_v3' LIMIT 1;`
    );
    if (!appliedBookingUxV3.rows.length) {
      await auditMigrationClient.query(`
        ALTER TABLE ota_sources ADD COLUMN IF NOT EXISTS description TEXT;
        ALTER TABLE ota_sources ADD COLUMN IF NOT EXISTS commission_rate_percent NUMERIC(5,2);

        -- Delete unreferenced TRAVELOKA seed if it has 0 bookings/reservations
        DELETE FROM ota_sources
        WHERE code = 'TRAVELOKA'
          AND id NOT IN (SELECT ota_source_id FROM bookings WHERE ota_source_id IS NOT NULL)
          AND id NOT IN (SELECT ota_source_id FROM reservations WHERE ota_source_id IS NOT NULL);

        INSERT INTO schema_migrations (version)
        VALUES ('booking_ux_ota_fields_v3')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    const appliedBookingUxV4 = await auditMigrationClient.query(
      `SELECT 1 FROM schema_migrations WHERE version = 'booking_ux_property_rules_v4' LIMIT 1;`
    );
    if (!appliedBookingUxV4.rows.length) {
      await auditMigrationClient.query(`
        CREATE TABLE IF NOT EXISTS property_quick_booking_rules (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
          channel_type VARCHAR(32) NOT NULL,
          field_key VARCHAR(64) NOT NULL,
          field_mode VARCHAR(16) NOT NULL DEFAULT 'REQUIRED',
          created_by VARCHAR(64),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by VARCHAR(64),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT uq_prop_booking_rules UNIQUE (property_id, channel_type, field_key)
        );
        CREATE INDEX IF NOT EXISTS idx_prop_booking_rules_lookup ON property_quick_booking_rules (property_id, channel_type);

        -- Seed default rules for all properties
        -- WALK-IN defaults
        INSERT INTO property_quick_booking_rules (property_id, channel_type, field_key, field_mode)
        SELECT p.id, 'WALK_IN', f.key, f.mode
        FROM properties p
        CROSS JOIN (
          VALUES
            ('booker_name', 'REQUIRED'),
            ('booker_phone', 'REQUIRED'),
            ('guest_name', 'REQUIRED'),
            ('guest_phone', 'REQUIRED'),
            ('guest_segment', 'OPTIONAL'),
            ('referral', 'OPTIONAL'),
            ('identity', 'REQUIRED'),
            ('payment_method', 'REQUIRED'),
            ('payment_amount', 'OPTIONAL'),
            ('payment_evidence', 'REQUIRED'),
            ('rate_plan', 'REQUIRED')
        ) AS f(key, mode)
        ON CONFLICT (property_id, channel_type, field_key) DO NOTHING;

        -- OTA defaults
        INSERT INTO property_quick_booking_rules (property_id, channel_type, field_key, field_mode)
        SELECT p.id, 'OTA', f.key, f.mode
        FROM properties p
        CROSS JOIN (
          VALUES
            ('booker_name', 'REQUIRED'),
            ('booker_phone', 'OPTIONAL'),
            ('guest_name', 'REQUIRED'),
            ('guest_phone', 'OPTIONAL'),
            ('guest_segment', 'OPTIONAL'),
            ('referral', 'OPTIONAL'),
            ('identity', 'OPTIONAL'),
            ('payment_method', 'OPTIONAL'),
            ('payment_amount', 'OPTIONAL'),
            ('payment_evidence', 'OPTIONAL'),
            ('rate_plan', 'REQUIRED')
        ) AS f(key, mode)
        ON CONFLICT (property_id, channel_type, field_key) DO NOTHING;

        -- Day Use Durations Master Table
        CREATE TABLE IF NOT EXISTS property_day_use_durations (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
          name VARCHAR(64) NOT NULL,
          duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
          sort_order INTEGER NOT NULL DEFAULT 0,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          is_archived BOOLEAN NOT NULL DEFAULT FALSE,
          created_by VARCHAR(64),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by VARCHAR(64),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT uq_prop_day_use_durations UNIQUE (property_id, duration_minutes)
        );
        CREATE INDEX IF NOT EXISTS idx_prop_day_use_durations_lookup ON property_day_use_durations (property_id, is_active, is_archived);

        -- Seed default Day Use presets
        INSERT INTO property_day_use_durations (property_id, name, duration_minutes, sort_order)
        SELECT p.id, d.name, d.mins, d.ord
        FROM properties p
        CROSS JOIN (
          VALUES
            ('3 Jam', 180, 1),
            ('4 Jam', 240, 2),
            ('6 Jam', 360, 3),
            ('8 Jam', 480, 4),
            ('12 Jam', 720, 5)
        ) AS d(name, mins, ord)
        ON CONFLICT (property_id, duration_minutes) DO NOTHING;

        INSERT INTO schema_migrations (version)
        VALUES ('booking_ux_property_rules_v4')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // Migration: stay_charge_authoritative_override_snapshot_v1
    const stayChargeSnapshotCheck = await auditMigrationClient.query(
      `SELECT 1 FROM schema_migrations WHERE version = 'stay_charge_authoritative_override_snapshot_v1'`
    );
    if ((stayChargeSnapshotCheck.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        -- 1. Extend folio_entries with snapshot and override columns
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS rule_id INTEGER REFERENCES stay_charge_rules(id) ON DELETE SET NULL;
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS rule_code_snapshot VARCHAR(50);
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS rule_name_snapshot VARCHAR(200);
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS calculation_method_snapshot VARCHAR(50);
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS original_rule_amount NUMERIC(12, 2);
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS is_override BOOLEAN DEFAULT FALSE;
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS override_amount NUMERIC(12, 2);
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS override_reason TEXT;
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS override_by VARCHAR(100);
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS override_at TIMESTAMP WITH TIME ZONE;
        ALTER TABLE folio_entries ADD COLUMN IF NOT EXISTS revenue_category VARCHAR(50) DEFAULT 'ROOM_SALES';

        CREATE INDEX IF NOT EXISTS idx_folio_entries_rule ON folio_entries (rule_id);
        CREATE INDEX IF NOT EXISTS idx_folio_entries_rev_cat ON folio_entries (revenue_category);

        INSERT INTO schema_migrations (version)
        VALUES ('stay_charge_authoritative_override_snapshot_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // Migration: crm_guest_canonicalization_v1
    const crmGuestCheck = await auditMigrationClient.query(
      `SELECT 1 FROM schema_migrations WHERE version = 'crm_guest_canonicalization_v1'`
    );
    if ((crmGuestCheck.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        -- 1. Extend guests with canonical CRM fields
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS guest_code VARCHAR(50);
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS normalized_name VARCHAR(255);
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS normalized_phone VARCHAR(50);
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS normalized_email VARCHAR(255);
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS normalized_identity_number VARCHAR(100);
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE;
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS preferences TEXT;
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS guest_segment VARCHAR(50) DEFAULT 'Reguler';

        -- 2. Populate guest_code and normalized values for existing records
        UPDATE guests SET guest_code = 'GST-' || LPAD(id::text, 5, '0') WHERE guest_code IS NULL;
        UPDATE guests SET normalized_phone = REGEXP_REPLACE(phone, '[^0-9]', '', 'g') WHERE normalized_phone IS NULL AND phone IS NOT NULL;
        UPDATE guests SET normalized_identity_number = UPPER(REGEXP_REPLACE(identity_number, '[^0-9A-Za-z]', '', 'g')) WHERE normalized_identity_number IS NULL AND identity_number IS NOT NULL;
        UPDATE guests SET normalized_name = LOWER(TRIM(full_name)) WHERE normalized_name IS NULL AND full_name IS NOT NULL;
        UPDATE guests SET normalized_email = LOWER(TRIM(email)) WHERE normalized_email IS NULL AND email IS NOT NULL;

        -- 3. Indexes for high-performance CRM searches & duplicate detection
        CREATE INDEX IF NOT EXISTS idx_guests_normalized_phone ON guests (normalized_phone);
        CREATE INDEX IF NOT EXISTS idx_guests_normalized_identity ON guests (normalized_identity_number);
        CREATE INDEX IF NOT EXISTS idx_guests_guest_code ON guests (guest_code);
        CREATE INDEX IF NOT EXISTS idx_guests_is_archived ON guests (is_archived);
        CREATE INDEX IF NOT EXISTS idx_guests_is_active ON guests (is_active);

        INSERT INTO schema_migrations (version)
        VALUES ('crm_guest_canonicalization_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // Migration: crm_guest_ktp_details_v1
    const crmGuestKtpCheck = await auditMigrationClient.query(
      `SELECT 1 FROM schema_migrations WHERE version = 'crm_guest_ktp_details_v1'`
    );
    if ((crmGuestKtpCheck.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        -- 1. Extend guests with full KTP fields
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS rt_rw VARCHAR(50);
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS village_kelurahan VARCHAR(100);
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS district_kecamatan VARCHAR(100);
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS religion VARCHAR(50);
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS marital_status VARCHAR(50);
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS occupation VARCHAR(100);
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS citizenship VARCHAR(50);
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS valid_until VARCHAR(50);
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS ktp_extracted_at TIMESTAMP WITH TIME ZONE;
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS ktp_ocr_provider VARCHAR(50);
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS ktp_ocr_confidence NUMERIC(4,2);

        -- 2. Indexes for search
        CREATE INDEX IF NOT EXISTS idx_guests_district_kecamatan ON guests (district_kecamatan);
        CREATE INDEX IF NOT EXISTS idx_guests_has_valid_identity ON guests (has_valid_identity);

        INSERT INTO schema_migrations (version)
        VALUES ('crm_guest_ktp_details_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // Migration: transaction_domain_foundation_v1
    const txDomainCheck = await auditMigrationClient.query(
      `SELECT 1 FROM schema_migrations WHERE version = 'transaction_domain_foundation_v1'`
    );
    if ((txDomainCheck.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        -- 1. Create transaction_daily_sequences table for atomic transaction numbering
        CREATE TABLE IF NOT EXISTS transaction_daily_sequences (
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
          date_key VARCHAR(8) NOT NULL, -- 'YYMMDD'
          last_seq INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (property_id, date_key)
        );

        -- 2. Create canonical transactions table
        CREATE TABLE IF NOT EXISTS transactions (
          id BIGSERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
          transaction_no VARCHAR(50) NOT NULL UNIQUE,
          transaction_date DATE NOT NULL,
          transaction_time TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
          transaction_type VARCHAR(20) NOT NULL, -- 'SALE', 'PURCHASE', 'EXPENSE', 'INCOME'
          source_type VARCHAR(50) NOT NULL, -- 'ROOM_CHARGE', 'DAY_USE_ROOM', 'EXTRA_BED', 'EXTRA_PERSON', 'EARLY_CHECKIN', 'LATE_CHECKOUT', 'PENALTY', 'POS', 'MANUAL_INCOME', 'MANUAL_EXPENSE', 'MANUAL_PURCHASE', 'MANUAL_SALE', 'OTHER_SALE'
          source_id VARCHAR(100),
          source_reference VARCHAR(100),
          category_code VARCHAR(50) NOT NULL,
          category_name VARCHAR(150) NOT NULL,
          department_code VARCHAR(50) NOT NULL DEFAULT 'FRONT_OFFICE',
          description TEXT NOT NULL,
          amount BIGINT NOT NULL DEFAULT 0,
          discount_amount BIGINT NOT NULL DEFAULT 0,
          service_amount BIGINT NOT NULL DEFAULT 0,
          tax_amount BIGINT NOT NULL DEFAULT 0,
          net_amount BIGINT NOT NULL DEFAULT 0,
          payment_status VARCHAR(30) NOT NULL DEFAULT 'UNPAID',
          payment_method VARCHAR(50),
          transaction_status VARCHAR(30) NOT NULL DEFAULT 'POSTED', -- 'POSTED', 'VOIDED', 'REVERSED', 'CORRECTED'
          guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
          guest_name_snapshot VARCHAR(150),
          room_number_snapshot VARCHAR(50),
          reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
          booking_id BIGINT REFERENCES bookings(id) ON DELETE SET NULL,
          reversal_of_transaction_id BIGINT REFERENCES transactions(id) ON DELETE SET NULL,
          correction_group_id VARCHAR(100),
          notes TEXT,
          metadata JSONB DEFAULT '{}'::jsonb,
          created_by VARCHAR(100),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_by VARCHAR(100),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_prop_source 
          ON transactions (property_id, source_type, source_id) 
          WHERE source_id IS NOT NULL AND reversal_of_transaction_id IS NULL;

        CREATE INDEX IF NOT EXISTS idx_transactions_prop_type_date 
          ON transactions (property_id, transaction_type, transaction_date DESC);

        CREATE INDEX IF NOT EXISTS idx_transactions_prop_res 
          ON transactions (property_id, reservation_id);

        CREATE INDEX IF NOT EXISTS idx_transactions_prop_status 
          ON transactions (property_id, transaction_status);

        CREATE INDEX IF NOT EXISTS idx_transactions_prop_cat 
          ON transactions (property_id, category_code);

        CREATE INDEX IF NOT EXISTS idx_transactions_prop_dept 
          ON transactions (property_id, department_code);

        INSERT INTO schema_migrations (version)
        VALUES ('transaction_domain_foundation_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // Migration: transaction_domain_attachments_v1
    const txAttCheck = await auditMigrationClient.query(
      `SELECT 1 FROM schema_migrations WHERE version = 'transaction_domain_attachments_v1'`
    );
    if ((txAttCheck.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        -- Add party_name to transactions if not present
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS party_name VARCHAR(150);

        -- Create transaction_attachments table
        CREATE TABLE IF NOT EXISTS transaction_attachments (
          id BIGSERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
          transaction_id BIGINT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
          file_name VARCHAR(255) NOT NULL,
          original_name VARCHAR(255) NOT NULL,
          mime_type VARCHAR(100) NOT NULL,
          file_size BIGINT NOT NULL,
          storage_path VARCHAR(500) NOT NULL,
          uploaded_by VARCHAR(100),
          uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_transaction_attachments_tx 
          ON transaction_attachments (property_id, transaction_id);

        INSERT INTO schema_migrations (version)
        VALUES ('transaction_domain_attachments_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // 25. Transaction-2D: Canonical Suppliers, Transaction Lines, Custom Categories, Verification & Multi-Purpose Attachments
    const tx2dMarkerCheck = await auditMigrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'transaction_2d_operational_workflow_v1'"
    );
    if ((tx2dMarkerCheck.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        -- Canonical Suppliers Master
        CREATE TABLE IF NOT EXISTS suppliers (
          id BIGSERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          phone VARCHAR(50),
          bank_name VARCHAR(100),
          bank_account VARCHAR(100),
          address TEXT,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_suppliers_property ON suppliers(property_id, is_active);

        -- Transaction Line Items (Multi-line purchases, integer IDR math with decimal quantity)
        CREATE TABLE IF NOT EXISTS transaction_lines (
          id BIGSERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
          transaction_id BIGINT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
          product_id BIGINT DEFAULT NULL,
          description_snapshot VARCHAR(255) NOT NULL,
          quantity NUMERIC(12, 3) NOT NULL DEFAULT 1,
          unit VARCHAR(50) NOT NULL DEFAULT 'pcs',
          unit_price BIGINT NOT NULL DEFAULT 0,
          discount_amount BIGINT NOT NULL DEFAULT 0,
          line_total BIGINT NOT NULL DEFAULT 0,
          sort_order INT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_tx_lines_transaction ON transaction_lines(transaction_id);

        -- Custom Operational Categories
        CREATE TABLE IF NOT EXISTS transaction_custom_categories (
          id BIGSERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
          code VARCHAR(50) NOT NULL,
          name VARCHAR(100) NOT NULL,
          transaction_type VARCHAR(20) NOT NULL,
          department_code VARCHAR(50) NOT NULL DEFAULT 'GENERAL',
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT uq_property_category_code UNIQUE (property_id, code)
        );
        CREATE INDEX IF NOT EXISTS idx_tx_custom_cat_property ON transaction_custom_categories(property_id, transaction_type);

        -- Extend transactions table
        ALTER TABLE transactions
          ADD COLUMN IF NOT EXISTS supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
          ADD COLUMN IF NOT EXISTS receiving_status VARCHAR(50) DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS verification_status VARCHAR(50) NOT NULL DEFAULT 'UNVERIFIED',
          ADD COLUMN IF NOT EXISTS verified_by_user_id VARCHAR(100) DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS verified_by_name_snapshot VARCHAR(100) DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS verification_note TEXT DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS rounding_amount BIGINT NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS phone VARCHAR(50) DEFAULT NULL;

        -- Extend transaction_attachments table
        ALTER TABLE transaction_attachments
          ADD COLUMN IF NOT EXISTS attachment_purpose VARCHAR(50) NOT NULL DEFAULT 'RECEIPT';

        -- Extend payment_transactions table for non-folio transaction settlement linkage
        ALTER TABLE payment_transactions
          ADD COLUMN IF NOT EXISTS transaction_id BIGINT REFERENCES transactions(id) ON DELETE SET NULL,
          ADD COLUMN IF NOT EXISTS property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE;

        CREATE INDEX IF NOT EXISTS idx_payment_transactions_tx ON payment_transactions (transaction_id);

        INSERT INTO schema_migrations (version)
        VALUES ('transaction_2d_operational_workflow_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // TRANSACTION-2E: ANKA Operational Lifecycle Sheets (PROSES, SELESAI, BATAL, HAPUS) & Soft Delete Support
    const tx2eMarkerCheck = await auditMigrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'transaction_2e_operational_lifecycle_sheets_v1'"
    );
    if ((tx2eMarkerCheck.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        -- Soft Delete Support for transactions
        ALTER TABLE transactions
          ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS deleted_by_user_id VARCHAR(100) DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS deleted_by_name_snapshot VARCHAR(100) DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS delete_reason TEXT DEFAULT NULL;

        CREATE INDEX IF NOT EXISTS idx_transactions_deleted ON transactions (property_id, deleted_at);

        INSERT INTO schema_migrations (version)
        VALUES ('transaction_2e_operational_lifecycle_sheets_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // Migration: transaction_reversal_index_v1
    const txRevIdxCheck = await auditMigrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'transaction_reversal_index_v1'"
    );
    if ((txRevIdxCheck.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        CREATE INDEX IF NOT EXISTS idx_transactions_reversal ON transactions (property_id, reversal_of_transaction_id) WHERE reversal_of_transaction_id IS NOT NULL;

        INSERT INTO schema_migrations (version)
        VALUES ('transaction_reversal_index_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // FOLIO PROPERTY ID BACKFILL & NOT NULL NORMALIZATION
    const folioPropCheck = await auditMigrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'folio_entries_property_id_backfill_and_not_null_v1'"
    );
    if ((folioPropCheck.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        -- 1. Idempotent historical backfill from reservations -> bookings
        UPDATE folio_entries fe
        SET property_id = b.property_id
        FROM reservations r
        JOIN bookings b ON r.booking_id = b.id
        WHERE fe.reservation_id = r.id
          AND fe.property_id IS NULL
          AND b.property_id IS NOT NULL;

        -- 2. Fallback safety backfill for any isolated rows
        UPDATE folio_entries
        SET property_id = 1
        WHERE property_id IS NULL;

        -- 3. Enforce NOT NULL on property_id
        ALTER TABLE folio_entries ALTER COLUMN property_id SET NOT NULL;

        -- 4. Ensure FK and indexes exist
        CREATE INDEX IF NOT EXISTS idx_folio_entries_property_id ON folio_entries(property_id);
        CREATE INDEX IF NOT EXISTS idx_folio_entries_prop_source ON folio_entries(property_id, source_type);

        INSERT INTO schema_migrations (version)
        VALUES ('folio_entries_property_id_backfill_and_not_null_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // HOUSEKEEPING: Category Bulk Check Setting
    const hkBulkCheckMarker = await auditMigrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'housekeeping_category_bulk_check_v1'"
    );
    if ((hkBulkCheckMarker.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        ALTER TABLE property_housekeeping_settings
          ADD COLUMN IF NOT EXISTS housekeeping_category_bulk_check_enabled BOOLEAN NOT NULL DEFAULT FALSE;

        INSERT INTO schema_migrations (version)
        VALUES ('housekeeping_category_bulk_check_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // ROLE PERMISSIONS: Dynamic Role Permissions Matrix
    const rolePermMarker = await auditMigrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'role_permissions_matrix_v1'"
    );
    if ((rolePermMarker.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        CREATE TABLE IF NOT EXISTS role_permissions (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
          role_name VARCHAR(100) NOT NULL,
          permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
          updated_by VARCHAR(150),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT uq_role_permissions_prop_role UNIQUE (property_id, role_name)
        );
        CREATE INDEX IF NOT EXISTS idx_role_permissions_prop ON role_permissions (property_id);

        INSERT INTO schema_migrations (version)
        VALUES ('role_permissions_matrix_v1')
        ON CONFLICT (version) DO NOTHING;
      `);

      const sopRoleDefaults: Record<string, string[]> = {
        'Super Admin': [
          'Kalender', 'Transaksi', 'Pelanggan', 'Housekeeping', 'HRD', 'POS',
          'Master Kamar', 'Master Produk', 'Laporan', 'Employee Mobile', 'Pengaturan'
        ],
        'General Manager': [
          'Kalender', 'Transaksi', 'Pelanggan', 'Housekeeping', 'HRD', 'POS',
          'Master Kamar', 'Master Produk', 'Laporan', 'Employee Mobile', 'Pengaturan'
        ],
        'Front Office': [
          'Kalender', 'Transaksi', 'Pelanggan', 'POS', 'Employee Mobile'
        ],
        'Housekeeping': [
          'Housekeeping', 'Employee Mobile'
        ],
        'Accounting': [
          'Transaksi', 'Laporan'
        ],
        'POS / Resto': [
          'POS', 'Master Produk'
        ],
        'Crew': [
          'Employee Mobile'
        ]
      };

      const props = await auditMigrationClient.query('SELECT id FROM properties');
      for (const p of props.rows) {
        for (const [rName, perms] of Object.entries(sopRoleDefaults)) {
          await auditMigrationClient.query(`
            INSERT INTO role_permissions (property_id, role_name, permissions, updated_by)
            VALUES ($1, $2, $3, 'SYSTEM_INIT')
            ON CONFLICT (property_id, role_name) DO NOTHING
          `, [p.id, rName, JSON.stringify(perms)]);
        }
      }
    }

    // 26. VENDOR & SUPPLIER CANONICAL MASTER FOUNDATION (Phase 1)
    const vendorMasterMarker = await auditMigrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'vendor_supplier_canonical_master_v1'"
    );
    if ((vendorMasterMarker.rowCount ?? 0) === 0) {
      // 1. Additive column extensions on suppliers table
      await auditMigrationClient.query(`
        ALTER TABLE suppliers
          ADD COLUMN IF NOT EXISTS code VARCHAR(50) DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS legal_name VARCHAR(255) DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS entity_type VARCHAR(20) NOT NULL DEFAULT 'SUPPLIER',
          ADD COLUMN IF NOT EXISTS category VARCHAR(100) DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS contact_person VARCHAR(100) DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS whatsapp VARCHAR(50) DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS email VARCHAR(150) DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS city VARCHAR(100) DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS province VARCHAR(100) DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS tax_id VARCHAR(50) DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS bank_holder VARCHAR(150) DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER DEFAULT 0,
          ADD COLUMN IF NOT EXISTS default_department_code VARCHAR(50) DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
          ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS created_by VARCHAR(100) DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS updated_by VARCHAR(100) DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

        -- 2. Constraints for entity_type and status
        ALTER TABLE suppliers DROP CONSTRAINT IF EXISTS chk_suppliers_entity_type;
        ALTER TABLE suppliers ADD CONSTRAINT chk_suppliers_entity_type 
          CHECK (entity_type IN ('SUPPLIER', 'VENDOR', 'BOTH'));

        ALTER TABLE suppliers DROP CONSTRAINT IF EXISTS chk_suppliers_status;
        ALTER TABLE suppliers ADD CONSTRAINT chk_suppliers_status 
          CHECK (status IN ('ACTIVE', 'INACTIVE', 'BLACKLISTED'));

        -- 3. Synchronize status & is_active for existing legacy rows
        UPDATE suppliers
        SET status = CASE WHEN is_active = FALSE THEN 'INACTIVE' ELSE 'ACTIVE' END;

        UPDATE suppliers
        SET is_active = (status = 'ACTIVE');

        UPDATE suppliers
        SET code = 'SUP-' || LPAD(id::text, 4, '0')
        WHERE code IS NULL;
      `);

      // 4. Preflight Guard: Check for duplicate normalized names before creating unique index
      const normNameDuplicates = await auditMigrationClient.query(`
        SELECT property_id, LOWER(TRIM(name)) AS norm_name, COUNT(*) AS dup_count, ARRAY_AGG(id) AS supplier_ids
        FROM suppliers
        WHERE deleted_at IS NULL
        GROUP BY property_id, LOWER(TRIM(name))
        HAVING COUNT(*) > 1
      `);
      if ((normNameDuplicates.rowCount ?? 0) > 0) {
        const conflictDetails = normNameDuplicates.rows
          .map((r: any) => `Property ${r.property_id}: "${r.norm_name}" (${r.dup_count} data, IDs: [${(r.supplier_ids || []).join(', ')}])`)
          .join('; ');
        throw new Error(
          `[MIGRATION HALTED - VENDOR/SUPPLIER CANONICAL MASTER] Ditemukan duplikasi nama supplier sebelum pembuatan unique index uq_suppliers_property_norm_name: ${conflictDetails}. Silakan tinjau dan rapikan data duplikat secara manual tanpa menghapus riwayat audit.`
        );
      }

      // 5. Preflight Guard: Check for duplicate codes before creating unique index
      const codeDuplicates = await auditMigrationClient.query(`
        SELECT property_id, UPPER(TRIM(code)) AS norm_code, COUNT(*) AS dup_count, ARRAY_AGG(id) AS supplier_ids
        FROM suppliers
        WHERE code IS NOT NULL AND deleted_at IS NULL
        GROUP BY property_id, UPPER(TRIM(code))
        HAVING COUNT(*) > 1
      `);
      if ((codeDuplicates.rowCount ?? 0) > 0) {
        const conflictDetails = codeDuplicates.rows
          .map((r: any) => `Property ${r.property_id}: "${r.norm_code}" (${r.dup_count} data, IDs: [${(r.supplier_ids || []).join(', ')}])`)
          .join('; ');
        throw new Error(
          `[MIGRATION HALTED - VENDOR/SUPPLIER CANONICAL MASTER] Ditemukan duplikasi kode supplier sebelum pembuatan unique index uq_suppliers_property_code: ${conflictDetails}. Silakan perbaiki kode duplikat sebelum melanjutkan migration.`
        );
      }

      // 6. Indexes & Unique constraints
      await auditMigrationClient.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_property_norm_name 
          ON suppliers(property_id, LOWER(TRIM(name))) 
          WHERE deleted_at IS NULL;

        CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_property_code
          ON suppliers(property_id, UPPER(TRIM(code)))
          WHERE code IS NOT NULL AND deleted_at IS NULL;

        CREATE INDEX IF NOT EXISTS idx_suppliers_prop_entity ON suppliers(property_id, entity_type);
        CREATE INDEX IF NOT EXISTS idx_suppliers_prop_status ON suppliers(property_id, status);
        CREATE INDEX IF NOT EXISTS idx_suppliers_prop_code ON suppliers(property_id, code);
        CREATE INDEX IF NOT EXISTS idx_suppliers_prop_deleted ON suppliers(property_id, deleted_at);

        INSERT INTO schema_migrations (version)
        VALUES ('vendor_supplier_canonical_master_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // 27. FRONT OFFICE DEPOSIT + PHYSICAL IDENTITY CUSTODY FOUNDATION
    const depositFoundationMarker = await auditMigrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'front_office_deposit_identity_custody_v1'"
    );
    if ((depositFoundationMarker.rowCount ?? 0) === 0) {
      const legacyDepositPayments = await auditMigrationClient.query(`
        SELECT id, property_id, reservation_id, transaction_type, amount, reference_code, status
        FROM payment_transactions
        WHERE UPPER(TRIM(transaction_type)) IN ('DEPOSIT', 'DEPOSIT_REFUND')
        ORDER BY id
      `);
      if ((legacyDepositPayments.rowCount ?? 0) > 0) {
        const details = legacyDepositPayments.rows
          .map((row: any) => `payment=${row.id}, property=${row.property_id ?? 'NULL'}, reservation=${row.reservation_id ?? 'NULL'}, type=${row.transaction_type}, amount=${row.amount}, status=${row.status}`)
          .join('; ');
        throw new Error(
          `[MIGRATION HALTED - CANONICAL DEPOSIT FOUNDATION] Existing DEPOSIT/DEPOSIT_REFUND payment transactions require explicit classification before migration: ${details}`
        );
      }
      await auditMigrationClient.query(`
        CREATE TABLE IF NOT EXISTS deposits (
          id BIGSERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
          reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
          deposit_number VARCHAR(40) NOT NULL,
          original_amount BIGINT NOT NULL CHECK (original_amount > 0),
          payment_method VARCHAR(30) NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'RECEIVED'
            CHECK (status IN ('RECEIVED', 'PARTIALLY_USED', 'CLOSED', 'CANCELLED')),
          received_by VARCHAR(100) NOT NULL,
          received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          notes TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT uq_deposits_property_number UNIQUE (property_id, deposit_number),
          CONSTRAINT uq_deposits_event_identity UNIQUE (id, property_id, reservation_id)
        );

        CREATE TABLE IF NOT EXISTS deposit_events (
          id BIGSERIAL PRIMARY KEY,
          deposit_id BIGINT NOT NULL,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
          reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
          event_type VARCHAR(30) NOT NULL
            CHECK (event_type IN ('RECEIVED', 'APPLY', 'REFUND', 'REVERSAL')),
          amount BIGINT NOT NULL CHECK (amount > 0),
          payment_transaction_id INTEGER REFERENCES payment_transactions(id) ON DELETE RESTRICT,
          folio_entry_id INTEGER REFERENCES folio_entries(id) ON DELETE RESTRICT,
          reversal_of_event_id BIGINT REFERENCES deposit_events(id) ON DELETE RESTRICT,
          idempotency_key VARCHAR(150) NOT NULL,
          performed_by VARCHAR(100) NOT NULL,
          performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          notes TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT fk_deposit_events_deposit_ownership
            FOREIGN KEY (deposit_id, property_id, reservation_id)
            REFERENCES deposits(id, property_id, reservation_id) ON DELETE RESTRICT,
          CONSTRAINT uq_deposit_events_property_idempotency UNIQUE (property_id, idempotency_key),
          CONSTRAINT chk_deposit_event_projection CHECK (
            (event_type = 'RECEIVED' AND payment_transaction_id IS NOT NULL AND folio_entry_id IS NULL AND reversal_of_event_id IS NULL)
            OR (event_type = 'APPLY' AND payment_transaction_id IS NULL AND folio_entry_id IS NOT NULL AND reversal_of_event_id IS NULL)
            OR (event_type = 'REFUND' AND payment_transaction_id IS NOT NULL AND folio_entry_id IS NULL AND reversal_of_event_id IS NULL)
            OR (event_type = 'REVERSAL' AND payment_transaction_id IS NOT NULL AND folio_entry_id IS NULL AND reversal_of_event_id IS NOT NULL)
          )
        );

        CREATE INDEX IF NOT EXISTS idx_deposits_property_reservation
          ON deposits(property_id, reservation_id);
        CREATE INDEX IF NOT EXISTS idx_deposits_property_status
          ON deposits(property_id, status);
        CREATE INDEX IF NOT EXISTS idx_deposit_events_deposit
          ON deposit_events(deposit_id, id);
        CREATE INDEX IF NOT EXISTS idx_deposit_events_reservation
          ON deposit_events(property_id, reservation_id);
        CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_events_payment_projection
          ON deposit_events(payment_transaction_id)
          WHERE payment_transaction_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_events_folio_projection
          ON deposit_events(folio_entry_id)
          WHERE folio_entry_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_events_single_reversal
          ON deposit_events(reversal_of_event_id)
          WHERE event_type = 'REVERSAL';
        CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_refund_reference
          ON payment_transactions(property_id, reference_code)
          WHERE transaction_type = 'DEPOSIT_REFUND' AND reference_code IS NOT NULL;

        CREATE TABLE IF NOT EXISTS identity_custody (
          id BIGSERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
          reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
          document_type VARCHAR(30) NOT NULL
            CHECK (document_type IN ('KTP', 'SIM', 'PASSPORT', 'OTHER')),
          document_holder_name VARCHAR(255) NOT NULL,
          document_number_masked VARCHAR(50),
          status VARCHAR(20) NOT NULL DEFAULT 'HELD'
            CHECK (status IN ('HELD', 'RETURNED')),
          received_by VARCHAR(100) NOT NULL,
          received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          returned_by VARCHAR(100),
          returned_at TIMESTAMPTZ,
          storage_location VARCHAR(255),
          notes TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT chk_identity_custody_return CHECK (
            (status = 'HELD' AND returned_by IS NULL AND returned_at IS NULL)
            OR (status = 'RETURNED' AND returned_by IS NOT NULL AND returned_at IS NOT NULL)
          )
        );

        CREATE INDEX IF NOT EXISTS idx_identity_custody_reservation
          ON identity_custody(property_id, reservation_id, status);

        INSERT INTO schema_migrations(version)
        VALUES ('front_office_deposit_identity_custody_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // 28. CHECKED-IN AUDITED ROOM MOVE LEDGER
    const roomMoveMarker = await auditMigrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'checked_in_audited_room_move_v1'"
    );
    if ((roomMoveMarker.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        CREATE TABLE IF NOT EXISTS reservation_room_moves (
          id BIGSERIAL PRIMARY KEY,
          reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
          from_room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
          to_room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
          from_room_type_id INTEGER NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
          to_room_type_id INTEGER NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
          effective_from_date DATE NOT NULL,
          moved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          moved_by_user_id INTEGER,
          moved_by VARCHAR(100) NOT NULL,
          moved_by_role VARCHAR(100),
          reason_category VARCHAR(30) NOT NULL CHECK (reason_category IN ('GUEST_REQUEST', 'MAINTENANCE', 'ROOM_ISSUE', 'UPGRADE', 'DOWNGRADE', 'OPERATIONAL', 'OTHER')),
          reason_detail TEXT NOT NULL CHECK (LENGTH(TRIM(reason_detail)) > 0),
          pricing_treatment VARCHAR(30) NOT NULL CHECK (pricing_treatment IN ('KEEP_CURRENT_RATE', 'APPLY_NEW_RATE')),
          old_rate_context JSONB NOT NULL,
          new_rate_context JSONB NOT NULL,
          correlation_id VARCHAR(150),
          idempotency_key VARCHAR(150),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT chk_room_move_distinct_rooms CHECK (from_room_id <> to_room_id)
        );
        CREATE INDEX IF NOT EXISTS idx_reservation_room_moves_reservation
          ON reservation_room_moves(reservation_id, effective_from_date, id);
        CREATE INDEX IF NOT EXISTS idx_reservation_room_moves_property
          ON reservation_room_moves(property_id, moved_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS uq_reservation_room_moves_idempotency
          ON reservation_room_moves(property_id, idempotency_key)
          WHERE idempotency_key IS NOT NULL;
        INSERT INTO schema_migrations(version)
        VALUES ('checked_in_audited_room_move_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    // 29. AUTH-HR-1 CANONICAL FOUNDATION: EMPLOYEES, USERS, SHIFTS, SCHEDULES, FACE ENROLLMENTS, ATTENDANCE
    const authHr1Marker = await auditMigrationClient.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'auth_hr1_canonical_foundation_v1'"
    );
    if ((authHr1Marker.rowCount ?? 0) === 0) {
      await auditMigrationClient.query(`
        -- Ensure roles and users tables exist
        CREATE TABLE IF NOT EXISTS roles (
          id SERIAL PRIMARY KEY,
          name VARCHAR(50) UNIQUE NOT NULL,
          description TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
          role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
          username VARCHAR(100) NOT NULL,
          email VARCHAR(150) NOT NULL,
          password_hash VARCHAR(255),
          full_name VARCHAR(150) NOT NULL,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        -- Add canonical employee link & lifecycle & google-ready fields to users
        ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_id INTEGER REFERENCES hr_employees(id) ON DELETE RESTRICT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status VARCHAR(30) NOT NULL DEFAULT 'READY';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS activated_at TIMESTAMP WITH TIME ZONE;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS temp_password_expires_at TIMESTAMP WITH TIME ZONE;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub VARCHAR(255);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS google_email VARCHAR(150);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS google_linked_at TIMESTAMP WITH TIME ZONE;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS local_password_enabled BOOLEAN NOT NULL DEFAULT TRUE;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP WITH TIME ZONE;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_provider VARCHAR(20);

        CREATE UNIQUE INDEX IF NOT EXISTS uq_users_employee_id ON users (employee_id) WHERE employee_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS uq_users_google_sub ON users (google_sub) WHERE google_sub IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_users_account_status ON users (account_status);
        CREATE INDEX IF NOT EXISTS idx_users_property ON users (property_id);

        -- Canonical Employee Face Enrollments
        CREATE TABLE IF NOT EXISTS employee_face_enrollments (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
          employee_id INTEGER NOT NULL REFERENCES hr_employees(id) ON DELETE RESTRICT,
          status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
          reference_photo_storage_key TEXT,
          reference_photo_hash VARCHAR(128),
          enrolled_at TIMESTAMP WITH TIME ZONE,
          enrolled_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          enrolled_by_name VARCHAR(150),
          verification_provider VARCHAR(50),
          verification_version VARCHAR(50),
          quality_status VARCHAR(30) NOT NULL DEFAULT 'NOT_EVALUATED',
          review_status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
          reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          reviewed_at TIMESTAMP WITH TIME ZONE,
          review_notes TEXT,
          revoked_at TIMESTAMP WITH TIME ZONE,
          revoked_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          revocation_reason TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_face_enrollments_emp ON employee_face_enrollments (employee_id);
        CREATE INDEX IF NOT EXISTS idx_face_enrollments_prop ON employee_face_enrollments (property_id);

        -- Work Shift Master
        CREATE TABLE IF NOT EXISTS work_shift_templates (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
          code VARCHAR(20) NOT NULL,
          name VARCHAR(100) NOT NULL,
          start_time TIME NOT NULL,
          end_time TIME NOT NULL,
          crosses_midnight BOOLEAN NOT NULL DEFAULT FALSE,
          grace_before_minutes INTEGER NOT NULL DEFAULT 15,
          late_grace_minutes INTEGER NOT NULL DEFAULT 15,
          checkout_grace_minutes INTEGER NOT NULL DEFAULT 60,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT uq_work_shift_templates_code UNIQUE (property_id, code)
        );
        CREATE INDEX IF NOT EXISTS idx_work_shift_templates_prop ON work_shift_templates (property_id);

        -- Employee Work Schedules & Audits
        CREATE TABLE IF NOT EXISTS employee_work_schedules (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
          employee_id INTEGER NOT NULL REFERENCES hr_employees(id) ON DELETE RESTRICT,
          work_date DATE NOT NULL,
          shift_template_id INTEGER REFERENCES work_shift_templates(id) ON DELETE RESTRICT,
          schedule_status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
          work_status VARCHAR(20) NOT NULL DEFAULT 'WORK',
          scheduled_start_at TIMESTAMP WITH TIME ZONE,
          scheduled_end_at TIMESTAMP WITH TIME ZONE,
          department_snapshot VARCHAR(100),
          position_snapshot VARCHAR(100),
          published_at TIMESTAMP WITH TIME ZONE,
          published_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          published_by_name VARCHAR(150),
          notes TEXT,
          created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT uq_employee_work_schedules_emp_date UNIQUE (property_id, employee_id, work_date)
        );
        CREATE INDEX IF NOT EXISTS idx_employee_work_schedules_prop_date ON employee_work_schedules (property_id, work_date);
        CREATE INDEX IF NOT EXISTS idx_employee_work_schedules_emp ON employee_work_schedules (employee_id);

        CREATE TABLE IF NOT EXISTS employee_work_schedule_audits (
          id BIGSERIAL PRIMARY KEY,
          schedule_id INTEGER NOT NULL REFERENCES employee_work_schedules(id) ON DELETE RESTRICT,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
          employee_id INTEGER NOT NULL REFERENCES hr_employees(id) ON DELETE RESTRICT,
          action VARCHAR(30) NOT NULL,
          old_shift_template_id INTEGER,
          new_shift_template_id INTEGER,
          old_work_status VARCHAR(20),
          new_work_status VARCHAR(20),
          reason TEXT,
          changed_by_user_id INTEGER,
          changed_by_name VARCHAR(150),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_schedule_audits_schedule ON employee_work_schedule_audits (schedule_id);

        -- Ensure immutable audit invariant: schedule_id must be ON DELETE RESTRICT
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.referential_constraints
            WHERE constraint_name = 'employee_work_schedule_audits_schedule_id_fkey'
              AND delete_rule = 'CASCADE'
          ) THEN
            ALTER TABLE employee_work_schedule_audits DROP CONSTRAINT employee_work_schedule_audits_schedule_id_fkey;
            ALTER TABLE employee_work_schedule_audits ADD CONSTRAINT employee_work_schedule_audits_schedule_id_fkey
              FOREIGN KEY (schedule_id) REFERENCES employee_work_schedules(id) ON DELETE RESTRICT;
          END IF;
        END $$;

        -- Canonical Employee Attendance Work-Cycle
        CREATE TABLE IF NOT EXISTS employee_attendance (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
          employee_id INTEGER NOT NULL REFERENCES hr_employees(id) ON DELETE RESTRICT,
          schedule_id INTEGER REFERENCES employee_work_schedules(id) ON DELETE SET NULL,
          work_date DATE NOT NULL,
          scheduled_start_snapshot TIMESTAMP WITH TIME ZONE,
          scheduled_end_snapshot TIMESTAMP WITH TIME ZONE,
          shift_code_snapshot VARCHAR(20),
          shift_name_snapshot VARCHAR(100),
          clock_in_at TIMESTAMP WITH TIME ZONE,
          clock_out_at TIMESTAMP WITH TIME ZONE,
          clock_in_photo_storage_key TEXT,
          clock_out_photo_storage_key TEXT,
          clock_in_photo_hash VARCHAR(128),
          clock_out_photo_hash VARCHAR(128),
          clock_in_face_status VARCHAR(30) NOT NULL DEFAULT 'NOT_PROCESSED',
          clock_out_face_status VARCHAR(30) NOT NULL DEFAULT 'NOT_PROCESSED',
          clock_in_liveness_status VARCHAR(30) NOT NULL DEFAULT 'NOT_PROCESSED',
          clock_out_liveness_status VARCHAR(30) NOT NULL DEFAULT 'NOT_PROCESSED',
          clock_in_location_status VARCHAR(30) DEFAULT 'NOT_EVALUATED',
          clock_out_location_status VARCHAR(30) DEFAULT 'NOT_EVALUATED',
          late_minutes INTEGER NOT NULL DEFAULT 0,
          early_leave_minutes INTEGER NOT NULL DEFAULT 0,
          overtime_minutes INTEGER NOT NULL DEFAULT 0,
          worked_minutes INTEGER NOT NULL DEFAULT 0,
          attendance_status VARCHAR(30) NOT NULL DEFAULT 'PRESENT',
          review_status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
          reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          reviewed_at TIMESTAMP WITH TIME ZONE,
          review_note TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT uq_employee_attendance_emp_date UNIQUE (property_id, employee_id, work_date)
        );
        CREATE INDEX IF NOT EXISTS idx_employee_attendance_prop_date ON employee_attendance (property_id, work_date);
        CREATE INDEX IF NOT EXISTS idx_employee_attendance_emp ON employee_attendance (employee_id);
        CREATE INDEX IF NOT EXISTS idx_employee_attendance_status ON employee_attendance (attendance_status);

        -- Additive link for operational tasks
        ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS assigned_employee_id INTEGER REFERENCES hr_employees(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_housekeeping_tasks_assigned_emp ON housekeeping_tasks (assigned_employee_id);

        ALTER TABLE maintenance_tasks ADD COLUMN IF NOT EXISTS assigned_employee_id INTEGER REFERENCES hr_employees(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_assigned_emp ON maintenance_tasks (assigned_employee_id);

        INSERT INTO schema_migrations(version)
        VALUES ('auth_hr1_canonical_foundation_v1')
        ON CONFLICT (version) DO NOTHING;
      `);
    }

    await auditMigrationClient.query('COMMIT');
  } catch (err) {
    await auditMigrationClient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    auditMigrationClient.release();
  }

  // Ensure reservations constraint allows DAY_USE stays
  await pool.query(`
    ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_check_out_after_check_in;
    ALTER TABLE reservations ADD CONSTRAINT reservations_check_out_after_check_in CHECK ((stay_type = 'DAY_USE' AND check_out >= check_in) OR (check_out > check_in)) NOT VALID;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS identity_number VARCHAR(100);
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS has_valid_identity BOOLEAN DEFAULT FALSE;
  `).catch((e) => console.warn('reservations identity and constraint migration warning:', e.message));

  // GL accounts & guest seeds removed — fresh DB must remain data-neutral (Rule 11)

  console.log('Schema v3: idempotency, payment, folio, housekeeping, maintenance, POS catalog, accounting basics, guest CRM, HR, and check-in/out fields ensured');
}

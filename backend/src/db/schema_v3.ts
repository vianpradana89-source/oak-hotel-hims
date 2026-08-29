import { Pool } from 'pg';
import { initializeDatabase as initializeV2 } from './schema_v2';

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
  `;

  await pool.query(q);

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
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS amount_paid DECIMAL(12,2) DEFAULT 0;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS remaining_balance DECIMAL(12,2) DEFAULT 0;

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

        ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE DEFAULT 1;
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
          ADD COLUMN IF NOT EXISTS default_final_inspection_template_code VARCHAR(50) NOT NULL DEFAULT 'FINAL_INSPECTION';
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

    await auditMigrationClient.query('COMMIT');
  } catch (err) {
    await auditMigrationClient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    auditMigrationClient.release();
  }

  // GL accounts & guest seeds removed — fresh DB must remain data-neutral (Rule 11)

  const employeeCount = await pool.query('SELECT COUNT(*) AS total FROM hr_employees');
  if (Number(employeeCount.rows[0].total) === 0) {
    await pool.query(`
      INSERT INTO hr_employees (employee_code, full_name, position, department, hire_date, monthly_salary, status)
      VALUES
        ('EMP-001', 'Rina Fitri', 'Front Office Manager', 'Front Office', '2023-01-15', 8500000, 'ACTIVE'),
        ('EMP-002', 'Dewi Lestari', 'Housekeeping Supervisor', 'Housekeeping', '2023-03-10', 7000000, 'ACTIVE'),
        ('EMP-003', 'Andi Pratama', 'Technician', 'Maintenance', '2022-11-20', 7500000, 'ACTIVE')
    `);
  }

  console.log('Schema v3: idempotency, payment, folio, housekeeping, maintenance, POS catalog, accounting basics, guest CRM, HR, and check-in/out fields ensured');
}

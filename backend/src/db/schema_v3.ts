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

        -- Checklist Template Items
        CREATE TABLE IF NOT EXISTS checklist_template_items (
          id SERIAL PRIMARY KEY,
          template_id INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
          section VARCHAR(100) NOT NULL,
          label VARCHAR(255) NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          is_required BOOLEAN NOT NULL DEFAULT TRUE,
          requires_note BOOLEAN NOT NULL DEFAULT FALSE,
          requires_photo BOOLEAN NOT NULL DEFAULT FALSE,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_checklist_template_items_template ON checklist_template_items (template_id);

        -- Task Checklist Snapshot Items
        CREATE TABLE IF NOT EXISTS housekeeping_task_checklist_items (
          id SERIAL PRIMARY KEY,
          task_id INTEGER NOT NULL REFERENCES housekeeping_tasks(id) ON DELETE CASCADE,
          template_item_id INTEGER REFERENCES checklist_template_items(id) ON DELETE SET NULL,
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
          created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
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

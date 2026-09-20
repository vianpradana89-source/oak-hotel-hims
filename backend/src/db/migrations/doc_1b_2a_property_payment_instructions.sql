-- DOCUMENT-1B.2A: Property Payment Instructions Settings
-- Adds canonical property-scoped payment instruction configuration table
-- for prefilling bank/payment information in quotations and invoices.

CREATE TABLE IF NOT EXISTS property_payment_instructions (
  id SERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL UNIQUE REFERENCES properties(id) ON DELETE CASCADE,
  bank_name VARCHAR(100),
  bank_account_name VARCHAR(150),
  bank_account_number VARCHAR(100),
  bank_branch VARCHAR(100),
  payment_note TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_by VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_property_payment_instructions_property
  ON property_payment_instructions (property_id);

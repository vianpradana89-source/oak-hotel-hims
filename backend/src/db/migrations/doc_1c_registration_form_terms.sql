-- DOCUMENT-1C: Property Registration Form Terms Settings (Structured Clauses)
-- Stores per-property default Terms & Conditions as a JSONB array of clauses.
-- Each clause: { "text": "..." }
-- Safe to run multiple times: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS property_registration_form_terms (
  id SERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL UNIQUE REFERENCES properties(id) ON DELETE CASCADE,
  terms_content JSONB NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_by VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_property_registration_form_terms_property
  ON property_registration_form_terms (property_id);

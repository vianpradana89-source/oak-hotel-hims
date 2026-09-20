-- DOCUMENT-1B.2B: Document & Print Permission Rows
-- Registers canonical permission keys for the Documents & Print module.
-- Safe to run multiple times: ON CONFLICT (key) DO NOTHING.

INSERT INTO permissions (resource, action, key, description, is_system)
VALUES
  ('documents', 'view',    'documents.view',    'Hak akses VIEW pada modul documents', TRUE),
  ('documents', 'create',  'documents.create',  'Hak akses CREATE pada modul documents', TRUE),
  ('documents', 'edit',    'documents.edit',    'Hak akses EDIT pada modul documents', TRUE),
  ('documents', 'delete',  'documents.delete',  'Hak akses DELETE pada modul documents', TRUE)
ON CONFLICT (key) DO NOTHING;

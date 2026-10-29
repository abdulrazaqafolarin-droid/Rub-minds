-- Remove table-maintenance privileges from public API roles.
-- RLS never protects TRUNCATE, and TRIGGER/REFERENCES are not required for
-- ordinary browser access to room, participant, message, invitation or memory data.
-- This is deliberately additive and contains no DROP/DELETE/TRUNCATE operation.
REVOKE TRUNCATE, TRIGGER, REFERENCES
  ON ALL TABLES IN SCHEMA public
  FROM anon, authenticated;

-- Restrict privileges inherited by newly created tables for the migration role.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE TRUNCATE, TRIGGER, REFERENCES
  ON TABLES FROM anon, authenticated;

-- Privileges of the application role. Run by the migrate job (scripts/db/migrate.sh) as the
-- migration role, which owns every table, after `prisma migrate deploy`. Idempotent.
--
-- The ledger guards (packages/db/prisma/migrations/*_ledger_guards) already reject the changes
-- below; the role is a second line of defence (docs/design/06-architecture.md §3.1, §6).

GRANT USAGE ON SCHEMA public TO niho_finance_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO niho_finance_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO niho_finance_app;

-- Tables that are created by later migrations get the same privileges.
ALTER DEFAULT PRIVILEGES FOR ROLE niho_finance_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO niho_finance_app;
ALTER DEFAULT PRIVILEGES FOR ROLE niho_finance_migrate IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO niho_finance_app;

-- Append-only and immutable tables: the app never rewrites history.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM niho_finance_app;
REVOKE UPDATE, DELETE, TRUNCATE ON journal_line FROM niho_finance_app;
REVOKE DELETE, TRUNCATE ON journal_entry FROM niho_finance_app;
REVOKE DELETE, TRUNCATE ON document FROM niho_finance_app;
-- The daily export records the last applied migration; nothing else touches this table.
REVOKE ALL ON _prisma_migrations FROM niho_finance_app;
GRANT SELECT ON _prisma_migrations TO niho_finance_app;

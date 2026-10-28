-- Ledger guards that Prisma cannot express (hand-written; Prisma leaves functions, triggers and
-- CHECK constraints alone when it diffs the schema). Rules: docs/design/02-accounting-rules.md §1,
-- docs/design/01-domain-model.md §3, docs/design/06-architecture.md §10.
--
-- 1. journal_line is append-only: UPDATE / DELETE / TRUNCATE are rejected, and lines can only be
--    inserted right after their entry in the same transaction (a posted entry never gains lines).
-- 2. journal_entry cannot be deleted; an UPDATE may only void it (status posted -> voided,
--    voided_at, void_reason) and set replaced_by_id once.
-- 3. audit_log is append-only.
-- 4. document cannot be deleted; storage_key / sha256 / byte_size / mime never change.
-- 5. Every entry has 2+ lines and debit total = credit total, checked at COMMIT (deferred).

-- ---------------------------------------------------------------------------
-- CHECK constraints
-- ---------------------------------------------------------------------------

ALTER TABLE "journal_line"
  ADD CONSTRAINT "journal_line_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "journal_line_tax_amount_range" CHECK ("tax_amount" >= 0 AND "tax_amount" <= "amount"),
  ADD CONSTRAINT "journal_line_line_no_positive" CHECK ("line_no" >= 1);

ALTER TABLE "journal_entry"
  ADD CONSTRAINT "journal_entry_no_positive" CHECK ("no" >= 1),
  ADD CONSTRAINT "journal_entry_reversal_link" CHECK (("kind" = 'reversal') = ("reversal_of_id" IS NOT NULL)),
  ADD CONSTRAINT "journal_entry_void_fields" CHECK (
    ("status" = 'voided') = ("voided_at" IS NOT NULL)
    AND ("status" = 'posted' OR "void_reason" IS NOT NULL)
    AND ("replaced_by_id" IS NULL OR "status" = 'voided')
  );

ALTER TABLE "fiscal_year"
  ADD CONSTRAINT "fiscal_year_period" CHECK ("start_date" <= "end_date"),
  ADD CONSTRAINT "fiscal_year_next_entry_no_positive" CHECK ("next_entry_no" >= 1),
  ADD CONSTRAINT "fiscal_year_exempt_is_tax_inclusive"
    CHECK ("consumption_tax" <> 'exempt' OR "accounting_method" = 'tax_inclusive');

ALTER TABLE "tax_rate_rule"
  ADD CONSTRAINT "tax_rate_rule_period" CHECK ("effective_to" IS NULL OR "effective_from" <= "effective_to"),
  ADD CONSTRAINT "tax_rate_rule_rate_range" CHECK ("rate_percent" BETWEEN 0 AND 100),
  ADD CONSTRAINT "tax_rate_rule_deductible_range"
    CHECK ("deductible_percent" IS NULL OR "deductible_percent" BETWEEN 0 AND 100);

ALTER TABLE "document"
  ADD CONSTRAINT "document_byte_size_nonnegative" CHECK ("byte_size" >= 0);

ALTER TABLE "document_link"
  ADD CONSTRAINT "document_link_one_target"
    CHECK (num_nonnulls("journal_entry_id", "wallet_transaction_id", "invoice_id") = 1);

-- ---------------------------------------------------------------------------
-- Shared: TRUNCATE bypasses row triggers, so it is rejected on every guarded table.
-- ---------------------------------------------------------------------------

CREATE FUNCTION "ledger_reject_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger guard: TRUNCATE on % is not allowed', TG_TABLE_NAME;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1. journal_line: append-only
-- ---------------------------------------------------------------------------

CREATE FUNCTION "ledger_journal_line_reject_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger guard: journal_line is append-only (% of line % rejected)', TG_OP, OLD."id";
END;
$$;

CREATE TRIGGER "journal_line_reject_change"
  BEFORE UPDATE OR DELETE ON "journal_line"
  FOR EACH ROW EXECUTE FUNCTION "ledger_journal_line_reject_change"();

CREATE TRIGGER "journal_line_reject_truncate"
  BEFORE TRUNCATE ON "journal_line"
  FOR EACH STATEMENT EXECUTE FUNCTION "ledger_reject_truncate"();

-- An entry is opened for lines only by its own INSERT, and only until the next entry is inserted
-- in the transaction (transaction-local setting). Lines are inserted right after their entry.
CREATE FUNCTION "ledger_journal_entry_open_for_lines"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'posted' THEN
    RAISE EXCEPTION 'ledger guard: journal_entry % must be inserted as posted', NEW."id";
  END IF;
  PERFORM set_config('niho_finance.open_journal_entry', NEW."id", true);
  RETURN NEW;
END;
$$;

CREATE TRIGGER "journal_entry_open_for_lines"
  BEFORE INSERT ON "journal_entry"
  FOR EACH ROW EXECUTE FUNCTION "ledger_journal_entry_open_for_lines"();

CREATE FUNCTION "ledger_journal_line_require_open_entry"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."journal_entry_id" IS DISTINCT FROM nullif(current_setting('niho_finance.open_journal_entry', true), '') THEN
    RAISE EXCEPTION 'ledger guard: lines can only be added together with their entry (journal_entry %)',
      NEW."journal_entry_id";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "journal_line_require_open_entry"
  BEFORE INSERT ON "journal_line"
  FOR EACH ROW EXECUTE FUNCTION "ledger_journal_line_require_open_entry"();

-- ---------------------------------------------------------------------------
-- 2. journal_entry: no DELETE; UPDATE only voids
-- ---------------------------------------------------------------------------

CREATE FUNCTION "ledger_journal_entry_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  voiding boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger guard: journal_entry % cannot be deleted (void it instead)', OLD."id";
  END IF;

  -- Deny by default: every column except the four void columns must stay as it is.
  IF (to_jsonb(NEW) - 'status' - 'voided_at' - 'void_reason' - 'replaced_by_id')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'voided_at' - 'void_reason' - 'replaced_by_id') THEN
    RAISE EXCEPTION 'ledger guard: journal_entry % is immutable (only status, voided_at, void_reason and replaced_by_id may change)',
      OLD."id";
  END IF;

  voiding := OLD."status" = 'posted' AND NEW."status" = 'voided';
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT voiding THEN
    RAISE EXCEPTION 'ledger guard: journal_entry % status can only change from posted to voided', OLD."id";
  END IF;
  IF (NEW."voided_at" IS DISTINCT FROM OLD."voided_at" OR NEW."void_reason" IS DISTINCT FROM OLD."void_reason")
     AND NOT voiding THEN
    RAISE EXCEPTION 'ledger guard: voided_at and void_reason of journal_entry % are set only when it is voided', OLD."id";
  END IF;
  IF NEW."replaced_by_id" IS DISTINCT FROM OLD."replaced_by_id" AND OLD."replaced_by_id" IS NOT NULL THEN
    RAISE EXCEPTION 'ledger guard: replaced_by_id of journal_entry % is already set', OLD."id";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "journal_entry_guard"
  BEFORE UPDATE OR DELETE ON "journal_entry"
  FOR EACH ROW EXECUTE FUNCTION "ledger_journal_entry_guard"();

CREATE TRIGGER "journal_entry_reject_truncate"
  BEFORE TRUNCATE ON "journal_entry"
  FOR EACH STATEMENT EXECUTE FUNCTION "ledger_reject_truncate"();

-- ---------------------------------------------------------------------------
-- 3. audit_log: append-only
-- ---------------------------------------------------------------------------

CREATE FUNCTION "ledger_audit_log_reject_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger guard: audit_log is append-only (% of % rejected)', TG_OP, OLD."id";
END;
$$;

CREATE TRIGGER "audit_log_reject_change"
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "ledger_audit_log_reject_change"();

CREATE TRIGGER "audit_log_reject_truncate"
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "ledger_reject_truncate"();

-- ---------------------------------------------------------------------------
-- 4. document: no DELETE (void instead); the stored file's identity never changes
-- ---------------------------------------------------------------------------

CREATE FUNCTION "ledger_document_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger guard: document % cannot be deleted (void it instead)', OLD."id";
  END IF;
  IF NEW."storage_key" IS DISTINCT FROM OLD."storage_key"
     OR NEW."sha256" IS DISTINCT FROM OLD."sha256"
     OR NEW."byte_size" IS DISTINCT FROM OLD."byte_size"
     OR NEW."mime" IS DISTINCT FROM OLD."mime" THEN
    RAISE EXCEPTION 'ledger guard: storage_key, sha256, byte_size and mime of document % cannot change', OLD."id";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "document_guard"
  BEFORE UPDATE OR DELETE ON "document"
  FOR EACH ROW EXECUTE FUNCTION "ledger_document_guard"();

CREATE TRIGGER "document_reject_truncate"
  BEFORE TRUNCATE ON "document"
  FOR EACH STATEMENT EXECUTE FUNCTION "ledger_reject_truncate"();

-- ---------------------------------------------------------------------------
-- 5. Balanced entries with 2+ lines, verified at COMMIT
-- ---------------------------------------------------------------------------

CREATE FUNCTION "ledger_check_entry_balanced"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  entry_id text;
  line_count integer;
  debit_total numeric;
  credit_total numeric;
BEGIN
  IF TG_TABLE_NAME = 'journal_line' THEN
    entry_id := NEW."journal_entry_id";
  ELSE
    entry_id := NEW."id";
  END IF;

  SELECT count(*),
         coalesce(sum("amount") FILTER (WHERE "side" = 'debit'), 0),
         coalesce(sum("amount") FILTER (WHERE "side" = 'credit'), 0)
    INTO line_count, debit_total, credit_total
    FROM "journal_line"
   WHERE "journal_entry_id" = entry_id;

  IF line_count < 2 THEN
    RAISE EXCEPTION 'ledger guard: journal_entry % has % line(s); at least 2 are required', entry_id, line_count;
  END IF;
  IF debit_total <> credit_total THEN
    RAISE EXCEPTION 'ledger guard: journal_entry % is unbalanced (debit %, credit %)', entry_id, debit_total, credit_total;
  END IF;
  RETURN NULL;
END;
$$;

-- On the line: a later line cannot unbalance an entry. On the entry: an entry without lines fails too.
CREATE CONSTRAINT TRIGGER "journal_line_balanced"
  AFTER INSERT ON "journal_line"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "ledger_check_entry_balanced"();

CREATE CONSTRAINT TRIGGER "journal_entry_balanced"
  AFTER INSERT ON "journal_entry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "ledger_check_entry_balanced"();

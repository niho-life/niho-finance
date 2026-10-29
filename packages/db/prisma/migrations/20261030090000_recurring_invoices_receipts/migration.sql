-- 定期請求と領収書 (docs/design/18-invoicing.md §14, §15).
-- The tables, columns, indexes and foreign keys are what `prisma migrate diff` generates from the
-- schema; what Prisma cannot express is added by hand after them:
--
-- 1. recurring_invoice: CHECK constraints of its rules (§14.6), and no DELETE / TRUNCATE (a
--    recurring invoice is paused, never deleted).
-- 2. invoice.recurring_invoice_id / recurring_month: set together, only on an invoice, the month as
--    `YYYY-MM`, and one invoice per recurring invoice and month (partial unique index). The body
--    trigger `ledger_invoice_guard` (*_invoicing) is deny by default after the issue: every column
--    that is not a state column must stay as it is, so the two new columns change only while the
--    invoice is a draft, without replacing the function.
-- 3. receipt: CHECK constraints, one receipt in force per invoice (partial unique index), and
--    `ledger_receipt_guard`: no DELETE / TRUNCATE; after the issue only the void (voided_at and
--    void_reason, once) and the stored PDF (pdf_document_id, once from NULL) change; a void
--    receipt never changes again.

-- CreateEnum
CREATE TYPE "recurring_invoice_frequency" AS ENUM ('monthly', 'bimonthly', 'yearly');

-- AlterTable
ALTER TABLE "invoice" ADD COLUMN     "recurring_invoice_id" TEXT,
ADD COLUMN     "recurring_month" TEXT;

-- CreateTable
CREATE TABLE "recurring_invoice" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "partner_id" TEXT NOT NULL,
    "title" TEXT,
    "lines" JSONB NOT NULL,
    "prices_include_tax" BOOLEAN NOT NULL DEFAULT false,
    "revenue_account_id" TEXT,
    "segment_id" TEXT,
    "note" TEXT,
    "frequency" "recurring_invoice_frequency" NOT NULL,
    "issue_day" INTEGER NOT NULL,
    "target_month_offset" INTEGER NOT NULL DEFAULT 0,
    "due_months" INTEGER NOT NULL DEFAULT 1,
    "due_day" INTEGER NOT NULL DEFAULT 31,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "recurring_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "issue_date" DATE NOT NULL,
    "received_on" DATE NOT NULL,
    "amount" BIGINT NOT NULL,
    "proviso" TEXT NOT NULL,
    "recipient_snapshot" JSONB NOT NULL,
    "issuer_snapshot" JSONB NOT NULL,
    "subtotal_by_rate" JSONB NOT NULL,
    "tax_by_rate" JSONB NOT NULL,
    "pdf_document_id" TEXT,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_by" TEXT NOT NULL,
    "voided_at" TIMESTAMPTZ(6),
    "void_reason" TEXT,

    CONSTRAINT "receipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recurring_invoice_partner_id_idx" ON "recurring_invoice"("partner_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_number_key" ON "receipt"("number");

-- CreateIndex
CREATE INDEX "receipt_invoice_id_idx" ON "receipt"("invoice_id");

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_recurring_invoice_id_fkey" FOREIGN KEY ("recurring_invoice_id") REFERENCES "recurring_invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_invoice" ADD CONSTRAINT "recurring_invoice_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_invoice" ADD CONSTRAINT "recurring_invoice_revenue_account_id_fkey" FOREIGN KEY ("revenue_account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_invoice" ADD CONSTRAINT "recurring_invoice_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_pdf_document_id_fkey" FOREIGN KEY ("pdf_document_id") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 1. recurring_invoice: the rules of §14.1 / §14.6; never deleted (paused instead)
-- ---------------------------------------------------------------------------

ALTER TABLE "recurring_invoice"
  ADD CONSTRAINT "recurring_invoice_issue_day_range" CHECK ("issue_day" BETWEEN 1 AND 31),
  ADD CONSTRAINT "recurring_invoice_due_day_range" CHECK ("due_day" BETWEEN 1 AND 31),
  ADD CONSTRAINT "recurring_invoice_due_months_range" CHECK ("due_months" BETWEEN 0 AND 3),
  ADD CONSTRAINT "recurring_invoice_target_month_offset_range"
    CHECK ("target_month_offset" BETWEEN -1 AND 1),
  ADD CONSTRAINT "recurring_invoice_period" CHECK ("end_date" IS NULL OR "end_date" >= "start_date"),
  -- A due date in the month of the issue date is on the issue day or later (never before the issue).
  ADD CONSTRAINT "recurring_invoice_due_after_issue"
    CHECK ("due_months" > 0 OR "due_day" >= "issue_day");

CREATE FUNCTION "ledger_recurring_invoice_reject_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger guard: recurring_invoice % cannot be deleted (pause it instead)', OLD."id";
END;
$$;

CREATE TRIGGER "recurring_invoice_reject_delete"
  BEFORE DELETE ON "recurring_invoice"
  FOR EACH ROW EXECUTE FUNCTION "ledger_recurring_invoice_reject_delete"();

CREATE TRIGGER "recurring_invoice_reject_truncate"
  BEFORE TRUNCATE ON "recurring_invoice"
  FOR EACH STATEMENT EXECUTE FUNCTION "ledger_reject_truncate"();

-- ---------------------------------------------------------------------------
-- 2. invoice: the recurring invoice and its month, one invoice per month
-- ---------------------------------------------------------------------------

ALTER TABLE "invoice"
  ADD CONSTRAINT "invoice_recurring_pair"
    CHECK (("recurring_invoice_id" IS NULL) = ("recurring_month" IS NULL)),
  ADD CONSTRAINT "invoice_recurring_doc_type"
    CHECK ("recurring_invoice_id" IS NULL OR "doc_type" = 'invoice'),
  ADD CONSTRAINT "invoice_recurring_month_format"
    CHECK ("recurring_month" IS NULL OR "recurring_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

-- A discarded draft and a void invoice keep their month: the month stays 作成済み (§14.2).
CREATE UNIQUE INDEX "invoice_recurring_month_key"
  ON "invoice"("recurring_invoice_id", "recurring_month")
  WHERE "recurring_invoice_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. receipt: one in force per invoice; after the issue only the void and the PDF change
-- ---------------------------------------------------------------------------

ALTER TABLE "receipt"
  ADD CONSTRAINT "receipt_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "receipt_void_fields" CHECK (("voided_at" IS NULL) = ("void_reason" IS NULL)),
  ADD CONSTRAINT "receipt_received_before_issue" CHECK ("received_on" <= "issue_date");

CREATE UNIQUE INDEX "receipt_invoice_in_force_key"
  ON "receipt"("invoice_id")
  WHERE "voided_at" IS NULL;

CREATE FUNCTION "ledger_receipt_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger guard: receipt % cannot be deleted (void it instead)', OLD."id";
  END IF;

  IF OLD."voided_at" IS NOT NULL THEN
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'ledger guard: receipt % is void and cannot change', OLD."id";
    END IF;
    RETURN NEW;
  END IF;

  -- Deny by default: every column except the void and the stored PDF must stay as it is.
  IF (to_jsonb(NEW) - 'voided_at' - 'void_reason' - 'pdf_document_id')
     IS DISTINCT FROM (to_jsonb(OLD) - 'voided_at' - 'void_reason' - 'pdf_document_id') THEN
    RAISE EXCEPTION 'ledger guard: receipt % was issued; its body is immutable (only voided_at, void_reason and pdf_document_id may change)',
      OLD."id";
  END IF;

  IF OLD."pdf_document_id" IS NOT NULL AND NEW."pdf_document_id" IS DISTINCT FROM OLD."pdf_document_id" THEN
    RAISE EXCEPTION 'ledger guard: pdf_document_id of receipt % is already set', OLD."id";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "receipt_guard"
  BEFORE UPDATE OR DELETE ON "receipt"
  FOR EACH ROW EXECUTE FUNCTION "ledger_receipt_guard"();

CREATE TRIGGER "receipt_reject_truncate"
  BEFORE TRUNCATE ON "receipt"
  FOR EACH STATEMENT EXECUTE FUNCTION "ledger_reject_truncate"();

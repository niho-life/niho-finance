-- CreateEnum
CREATE TYPE "fiscal_year_status" AS ENUM ('open', 'closing', 'closed');

-- CreateEnum
CREATE TYPE "consumption_tax_method" AS ENUM ('exempt', 'general', 'simplified');

-- CreateEnum
CREATE TYPE "accounting_method" AS ENUM ('tax_inclusive', 'tax_exclusive');

-- CreateEnum
CREATE TYPE "account_kind" AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense', 'internal');

-- CreateEnum
CREATE TYPE "account_group" AS ENUM ('current_assets', 'fixed_assets', 'deferred_assets', 'current_liabilities', 'fixed_liabilities', 'shareholders_equity', 'sales', 'cost_of_sales', 'sga', 'non_operating_income', 'non_operating_expenses', 'extraordinary_income', 'extraordinary_losses', 'income_taxes', 'internal');

-- CreateEnum
CREATE TYPE "tax_direction" AS ENUM ('sales', 'purchase', 'none');

-- CreateEnum
CREATE TYPE "tax_kind" AS ENUM ('taxable', 'exempt', 'out_of_scope', 'export', 'na');

-- CreateEnum
CREATE TYPE "partner_kind" AS ENUM ('customer', 'vendor', 'both', 'other');

-- CreateEnum
CREATE TYPE "invoice_registration_status" AS ENUM ('unknown', 'verified', 'not_found', 'revoked');

-- CreateEnum
CREATE TYPE "wallet_kind" AS ENUM ('bank', 'card', 'cash', 'stripe', 'owner', 'other');

-- CreateEnum
CREATE TYPE "wallet_transaction_status" AS ENUM ('pending', 'registered', 'transfer', 'ignored');

-- CreateEnum
CREATE TYPE "import_source" AS ENUM ('csv', 'stripe', 'api');

-- CreateEnum
CREATE TYPE "entry_kind" AS ENUM ('opening', 'normal', 'transfer', 'adjusting', 'closing', 'reversal');

-- CreateEnum
CREATE TYPE "source_kind" AS ENUM ('manual', 'wallet_txn', 'stripe', 'invoice', 'fixed_asset', 'recurring', 'import', 'system');

-- CreateEnum
CREATE TYPE "entry_status" AS ENUM ('posted', 'voided');

-- CreateEnum
CREATE TYPE "side" AS ENUM ('debit', 'credit');

-- CreateEnum
CREATE TYPE "document_kind" AS ENUM ('receipt', 'invoice_in', 'invoice_out', 'contract', 'statement', 'other');

-- CreateEnum
CREATE TYPE "document_source" AS ENUM ('upload', 'camera', 'email', 'stripe', 'generated');

-- CreateEnum
CREATE TYPE "document_status" AS ENUM ('inbox', 'linked', 'voided');

-- CreateEnum
CREATE TYPE "invoice_doc_type" AS ENUM ('quote', 'delivery', 'invoice');

-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('draft', 'issued', 'sent', 'paid', 'void');

-- CreateEnum
CREATE TYPE "depreciation_method" AS ENUM ('straight_line', 'declining_balance', 'immediate', 'lump_sum_3y');

-- CreateEnum
CREATE TYPE "recurrence_frequency" AS ENUM ('monthly', 'yearly');

-- CreateEnum
CREATE TYPE "calendar_item_kind" AS ENUM ('filing', 'payment', 'notification', 'meeting', 'other');

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('owner', 'accountant', 'viewer');

-- CreateTable
CREATE TABLE "company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_kana" TEXT,
    "corporate_number" TEXT,
    "invoice_registration_number" TEXT,
    "address" TEXT,
    "representative" TEXT,
    "fiscal_year_start_month" INTEGER NOT NULL,
    "bank_account_for_invoice" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_year" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "no" INTEGER NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "status" "fiscal_year_status" NOT NULL DEFAULT 'open',
    "consumption_tax" "consumption_tax_method" NOT NULL,
    "accounting_method" "accounting_method" NOT NULL,
    "locked_through" DATE,
    "next_entry_no" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fiscal_year_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "account_kind" NOT NULL,
    "statement_group" "account_group" NOT NULL,
    "default_tax_category_code" TEXT,
    "default_segment_id" TEXT,
    "is_cash_like" BOOLEAN NOT NULL DEFAULT false,
    "e_tax_code" TEXT,
    "e_tax_hierarchy" INTEGER,
    "e_tax_row_kind" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sub_account" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "partner_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sub_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_category" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "direction" "tax_direction" NOT NULL,
    "kind" "tax_kind" NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rate_rule" (
    "id" TEXT NOT NULL,
    "tax_category_code" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "rate_percent" INTEGER NOT NULL,
    "deductible_percent" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_rate_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "segment" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "segment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_kana" TEXT,
    "kind" "partner_kind" NOT NULL,
    "invoice_registration_number" TEXT,
    "invoice_registration_status" "invoice_registration_status" NOT NULL DEFAULT 'unknown',
    "invoice_registration_checked_at" TIMESTAMPTZ(6),
    "default_account_id" TEXT,
    "default_segment_id" TEXT,
    "default_tax_category_code" TEXT,
    "email" TEXT,
    "address" TEXT,
    "note" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "partner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memo_tag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memo_tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "wallet_kind" NOT NULL,
    "account_id" TEXT NOT NULL,
    "sub_account_id" TEXT,
    "importer" TEXT,
    "default_segment_id" TEXT,
    "opening_balance_date" DATE,
    "opening_balance" BIGINT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_account_link" (
    "id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "stripe_account_id" TEXT NOT NULL,
    "secret_name" TEXT NOT NULL,
    "sync_cursor" TEXT,
    "last_synced_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stripe_account_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transaction" (
    "id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "txn_date" DATE NOT NULL,
    "amount" BIGINT NOT NULL,
    "description_raw" TEXT NOT NULL,
    "counterparty_raw" TEXT,
    "balance_after" BIGINT,
    "external_id" TEXT NOT NULL,
    "import_batch_id" TEXT,
    "status" "wallet_transaction_status" NOT NULL DEFAULT 'pending',
    "journal_entry_id" TEXT,
    "suggestion" JSONB,
    "ignored_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "wallet_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batch" (
    "id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "source" "import_source" NOT NULL,
    "importer" TEXT,
    "document_id" TEXT,
    "file_sha256" TEXT,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "imported_count" INTEGER NOT NULL DEFAULT 0,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "executed_by" TEXT NOT NULL,
    "executed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "wallet_id" TEXT,
    "match" JSONB NOT NULL,
    "action" JSONB NOT NULL,
    "auto_post" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "hit_count" INTEGER NOT NULL DEFAULT 0,
    "last_hit_at" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entry" (
    "id" TEXT NOT NULL,
    "fiscal_year_id" TEXT NOT NULL,
    "no" INTEGER NOT NULL,
    "entry_date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "kind" "entry_kind" NOT NULL,
    "source_kind" "source_kind" NOT NULL,
    "source_id" TEXT,
    "status" "entry_status" NOT NULL DEFAULT 'posted',
    "reversal_of_id" TEXT,
    "replaced_by_id" TEXT,
    "void_reason" TEXT,
    "voided_at" TIMESTAMPTZ(6),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "posted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_line" (
    "id" TEXT NOT NULL,
    "journal_entry_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "side" "side" NOT NULL,
    "account_id" TEXT NOT NULL,
    "sub_account_id" TEXT,
    "amount" BIGINT NOT NULL,
    "tax_category_code" TEXT NOT NULL,
    "tax_amount" BIGINT NOT NULL DEFAULT 0,
    "segment_id" TEXT,
    "partner_id" TEXT,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_line_memo_tag" (
    "journal_line_id" TEXT NOT NULL,
    "memo_tag_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_line_memo_tag_pkey" PRIMARY KEY ("journal_line_id","memo_tag_id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" TEXT NOT NULL,
    "kind" "document_kind" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "original_name" TEXT,
    "uploaded_by" TEXT NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "document_source" NOT NULL,
    "txn_date" DATE,
    "amount" BIGINT,
    "partner_id" TEXT,
    "partner_name" TEXT,
    "invoice_registration_number" TEXT,
    "extraction" JSONB,
    "status" "document_status" NOT NULL DEFAULT 'inbox',
    "supersedes_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_link" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "journal_entry_id" TEXT,
    "wallet_transaction_id" TEXT,
    "invoice_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice" (
    "id" TEXT NOT NULL,
    "doc_type" "invoice_doc_type" NOT NULL,
    "number" TEXT NOT NULL,
    "partner_id" TEXT NOT NULL,
    "issue_date" DATE NOT NULL,
    "due_date" DATE,
    "title" TEXT,
    "lines" JSONB NOT NULL,
    "subtotal_by_rate" JSONB NOT NULL,
    "tax_by_rate" JSONB NOT NULL,
    "total" BIGINT NOT NULL,
    "issuer_snapshot" JSONB,
    "status" "invoice_status" NOT NULL DEFAULT 'draft',
    "source_invoice_id" TEXT,
    "pdf_document_id" TEXT,
    "journal_entry_id" TEXT,
    "payments" JSONB,
    "stripe_payment_link_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fixed_asset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "acquisition_date" DATE NOT NULL,
    "cost" BIGINT NOT NULL,
    "method" "depreciation_method" NOT NULL,
    "useful_life_years" INTEGER,
    "residual_value" BIGINT NOT NULL DEFAULT 1,
    "schedule" JSONB,
    "is_depreciable_asset_taxed" BOOLEAN NOT NULL DEFAULT false,
    "segment_id" TEXT,
    "disposed_at" DATE,
    "disposal_entry_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fixed_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_item" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "frequency" "recurrence_frequency" NOT NULL,
    "day_of_month" INTEGER,
    "month_of_year" INTEGER,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "wallet_id" TEXT,
    "tax_category_code" TEXT,
    "segment_id" TEXT,
    "partner_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "recurring_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_item" (
    "id" TEXT NOT NULL,
    "fiscal_year_id" TEXT,
    "kind" "calendar_item_kind" NOT NULL,
    "title" TEXT NOT NULL,
    "due_date" DATE NOT NULL,
    "rule_key" TEXT,
    "completed_at" TIMESTAMPTZ(6),
    "completed_by" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "calendar_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "user_role" NOT NULL DEFAULT 'owner',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fiscal_year_start_date_end_date_idx" ON "fiscal_year"("start_date", "end_date");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_year_company_id_no_key" ON "fiscal_year"("company_id", "no");

-- CreateIndex
CREATE UNIQUE INDEX "account_code_key" ON "account"("code");

-- CreateIndex
CREATE UNIQUE INDEX "sub_account_account_id_name_key" ON "sub_account"("account_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "tax_category_code_key" ON "tax_category"("code");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rate_rule_tax_category_code_effective_from_rate_percent_key" ON "tax_rate_rule"("tax_category_code", "effective_from", "rate_percent");

-- CreateIndex
CREATE UNIQUE INDEX "segment_code_key" ON "segment"("code");

-- CreateIndex
CREATE UNIQUE INDEX "memo_tag_name_key" ON "memo_tag"("name");

-- CreateIndex
CREATE UNIQUE INDEX "stripe_account_link_wallet_id_key" ON "stripe_account_link"("wallet_id");

-- CreateIndex
CREATE INDEX "wallet_transaction_wallet_id_status_txn_date_idx" ON "wallet_transaction"("wallet_id", "status", "txn_date");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transaction_wallet_id_external_id_key" ON "wallet_transaction"("wallet_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "import_batch_file_sha256_key" ON "import_batch"("file_sha256");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entry_reversal_of_id_key" ON "journal_entry"("reversal_of_id");

-- CreateIndex
CREATE INDEX "journal_entry_fiscal_year_id_entry_date_idx" ON "journal_entry"("fiscal_year_id", "entry_date");

-- CreateIndex
CREATE INDEX "journal_entry_source_kind_source_id_idx" ON "journal_entry"("source_kind", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entry_fiscal_year_id_no_key" ON "journal_entry"("fiscal_year_id", "no");

-- CreateIndex
CREATE INDEX "journal_line_account_id_idx" ON "journal_line"("account_id");

-- CreateIndex
CREATE INDEX "journal_line_segment_id_idx" ON "journal_line"("segment_id");

-- CreateIndex
CREATE UNIQUE INDEX "journal_line_journal_entry_id_line_no_key" ON "journal_line"("journal_entry_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "document_storage_key_key" ON "document"("storage_key");

-- CreateIndex
CREATE INDEX "document_txn_date_amount_partner_id_idx" ON "document"("txn_date", "amount", "partner_id");

-- CreateIndex
CREATE INDEX "document_sha256_idx" ON "document"("sha256");

-- CreateIndex
CREATE INDEX "document_status_idx" ON "document"("status");

-- CreateIndex
CREATE INDEX "document_link_journal_entry_id_idx" ON "document_link"("journal_entry_id");

-- CreateIndex
CREATE INDEX "document_link_wallet_transaction_id_idx" ON "document_link"("wallet_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_link_document_id_journal_entry_id_key" ON "document_link"("document_id", "journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_link_document_id_wallet_transaction_id_key" ON "document_link"("document_id", "wallet_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_link_document_id_invoice_id_key" ON "document_link"("document_id", "invoice_id");

-- CreateIndex
CREATE INDEX "invoice_partner_id_idx" ON "invoice"("partner_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_doc_type_number_key" ON "invoice"("doc_type", "number");

-- CreateIndex
CREATE INDEX "calendar_item_due_date_idx" ON "calendar_item"("due_date");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_item_fiscal_year_id_rule_key_key" ON "calendar_item"("fiscal_year_id", "rule_key");

-- CreateIndex
CREATE INDEX "audit_log_entity_entity_id_idx" ON "audit_log"("entity", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_at_idx" ON "audit_log"("at");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- AddForeignKey
ALTER TABLE "fiscal_year" ADD CONSTRAINT "fiscal_year_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_default_tax_category_code_fkey" FOREIGN KEY ("default_tax_category_code") REFERENCES "tax_category"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_default_segment_id_fkey" FOREIGN KEY ("default_segment_id") REFERENCES "segment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sub_account" ADD CONSTRAINT "sub_account_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sub_account" ADD CONSTRAINT "sub_account_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rate_rule" ADD CONSTRAINT "tax_rate_rule_tax_category_code_fkey" FOREIGN KEY ("tax_category_code") REFERENCES "tax_category"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner" ADD CONSTRAINT "partner_default_account_id_fkey" FOREIGN KEY ("default_account_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner" ADD CONSTRAINT "partner_default_segment_id_fkey" FOREIGN KEY ("default_segment_id") REFERENCES "segment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner" ADD CONSTRAINT "partner_default_tax_category_code_fkey" FOREIGN KEY ("default_tax_category_code") REFERENCES "tax_category"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet" ADD CONSTRAINT "wallet_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet" ADD CONSTRAINT "wallet_sub_account_id_fkey" FOREIGN KEY ("sub_account_id") REFERENCES "sub_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet" ADD CONSTRAINT "wallet_default_segment_id_fkey" FOREIGN KEY ("default_segment_id") REFERENCES "segment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stripe_account_link" ADD CONSTRAINT "stripe_account_link_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transaction" ADD CONSTRAINT "wallet_transaction_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transaction" ADD CONSTRAINT "wallet_transaction_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "import_batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transaction" ADD CONSTRAINT "wallet_transaction_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule" ADD CONSTRAINT "rule_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "fiscal_year"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "journal_entry"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "journal_entry"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entry"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_sub_account_id_fkey" FOREIGN KEY ("sub_account_id") REFERENCES "sub_account"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_tax_category_code_fkey" FOREIGN KEY ("tax_category_code") REFERENCES "tax_category"("code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partner"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "journal_line_memo_tag" ADD CONSTRAINT "journal_line_memo_tag_journal_line_id_fkey" FOREIGN KEY ("journal_line_id") REFERENCES "journal_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_line_memo_tag" ADD CONSTRAINT "journal_line_memo_tag_memo_tag_id_fkey" FOREIGN KEY ("memo_tag_id") REFERENCES "memo_tag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_link" ADD CONSTRAINT "document_link_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_link" ADD CONSTRAINT "document_link_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_link" ADD CONSTRAINT "document_link_wallet_transaction_id_fkey" FOREIGN KEY ("wallet_transaction_id") REFERENCES "wallet_transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_link" ADD CONSTRAINT "document_link_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_source_invoice_id_fkey" FOREIGN KEY ("source_invoice_id") REFERENCES "invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_pdf_document_id_fkey" FOREIGN KEY ("pdf_document_id") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_asset" ADD CONSTRAINT "fixed_asset_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_asset" ADD CONSTRAINT "fixed_asset_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_asset" ADD CONSTRAINT "fixed_asset_disposal_entry_id_fkey" FOREIGN KEY ("disposal_entry_id") REFERENCES "journal_entry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_item" ADD CONSTRAINT "recurring_item_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_item" ADD CONSTRAINT "recurring_item_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_item" ADD CONSTRAINT "recurring_item_tax_category_code_fkey" FOREIGN KEY ("tax_category_code") REFERENCES "tax_category"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_item" ADD CONSTRAINT "recurring_item_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_item" ADD CONSTRAINT "recurring_item_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_item" ADD CONSTRAINT "calendar_item_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "fiscal_year"("id") ON DELETE SET NULL ON UPDATE CASCADE;

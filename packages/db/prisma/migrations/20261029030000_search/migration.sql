-- 全体検索 (docs/design/10-settings-and-setup.md §7.4). Indexes only, written by hand: Prisma cannot
-- express an extension's operator class on an expression.
--
-- The search compares `lower(normalize(<column>, NFKC))` with `LIKE '%…%'` (packages/db/src/search.ts),
-- so each index is on that same expression. pg_trgm serves a partial match of 3 characters or more
-- from the index; a 2-character query reads the table (one company's rows stay within a second).
-- Amounts need no new B-tree: each kind's amount condition is its own arm of a UNION and compares an
-- integer column (or the debit total of the lines), which a sequential read does without normalizing.
-- pg_trgm is a trusted extension (Cloud SQL included): the owner of the database can create it.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "search_journal_entry_description_trgm"
    ON "journal_entry" USING gin ((lower(normalize("description", NFKC))) gin_trgm_ops);

CREATE INDEX "search_journal_line_description_trgm"
    ON "journal_line" USING gin ((lower(normalize("description", NFKC))) gin_trgm_ops);

CREATE INDEX "search_wallet_transaction_description_raw_trgm"
    ON "wallet_transaction" USING gin ((lower(normalize("description_raw", NFKC))) gin_trgm_ops);

CREATE INDEX "search_wallet_transaction_counterparty_raw_trgm"
    ON "wallet_transaction" USING gin ((lower(normalize("counterparty_raw", NFKC))) gin_trgm_ops);

CREATE INDEX "search_document_partner_name_trgm"
    ON "document" USING gin ((lower(normalize("partner_name", NFKC))) gin_trgm_ops);

CREATE INDEX "search_document_original_name_trgm"
    ON "document" USING gin ((lower(normalize("original_name", NFKC))) gin_trgm_ops);

CREATE INDEX "search_document_note_trgm"
    ON "document" USING gin ((lower(normalize("note", NFKC))) gin_trgm_ops);

CREATE INDEX "search_partner_name_trgm"
    ON "partner" USING gin ((lower(normalize("name", NFKC))) gin_trgm_ops);

CREATE INDEX "search_partner_name_kana_trgm"
    ON "partner" USING gin ((lower(normalize("name_kana", NFKC))) gin_trgm_ops);

CREATE INDEX "search_invoice_number_trgm"
    ON "invoice" USING gin ((lower(normalize("number", NFKC))) gin_trgm_ops);

CREATE INDEX "search_invoice_title_trgm"
    ON "invoice" USING gin ((lower(normalize("title", NFKC))) gin_trgm_ops);

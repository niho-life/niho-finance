-- 支払 (v2 #48, docs/design/25-payables.md §8.1): a received invoice (a document `invoice_in`)
-- carries its payable. Written by hand; columns only:
--
-- 1. document gets payable_entry_id (the 計上 entry, kept after a cancel), payable_due_date
--    (支払期日) and payable_wallet_id (支払元の予定), with an index on the due date. The rest and
--    the state are derived from the ledger and never stored (25 §1). ledger_document_guard is left
--    as it is: these columns are not part of the stored file's identity.
-- 2. partner gets its payment terms (締め日・何か月後・支払日; 31 = 末日). CHECK
--    partner_payment_terms: all three or none, 締め日 and 支払日 1–31, 何か月後 0–3.

-- AlterTable
ALTER TABLE "document" ADD COLUMN     "payable_due_date" DATE,
ADD COLUMN     "payable_entry_id" TEXT,
ADD COLUMN     "payable_wallet_id" TEXT;

-- AlterTable
ALTER TABLE "partner" ADD COLUMN     "payment_closing_day" INTEGER,
ADD COLUMN     "payment_due_day" INTEGER,
ADD COLUMN     "payment_due_months" INTEGER;

-- CreateIndex
CREATE INDEX "document_payable_due_date_idx" ON "document"("payable_due_date");

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_payable_entry_id_fkey" FOREIGN KEY ("payable_entry_id") REFERENCES "journal_entry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_payable_wallet_id_fkey" FOREIGN KEY ("payable_wallet_id") REFERENCES "wallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- CHECK constraints
-- ---------------------------------------------------------------------------

ALTER TABLE "partner"
  ADD CONSTRAINT "partner_payment_terms" CHECK (
    (
      "payment_closing_day" IS NULL
      AND "payment_due_months" IS NULL
      AND "payment_due_day" IS NULL
    )
    OR (
      -- IS NOT NULL: a NULL comparison would let the CHECK pass.
      "payment_closing_day" IS NOT NULL
      AND "payment_due_months" IS NOT NULL
      AND "payment_due_day" IS NOT NULL
      AND "payment_closing_day" BETWEEN 1 AND 31
      AND "payment_due_months" BETWEEN 0 AND 3
      AND "payment_due_day" BETWEEN 1 AND 31
    )
  );

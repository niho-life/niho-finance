-- 決算書の設定 per fiscal year (#15, docs/design/17-financial-statements.md §3.1, §11).

-- AlterTable
ALTER TABLE "fiscal_year" ADD COLUMN "statement_settings" JSONB;

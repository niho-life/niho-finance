-- AlterTable
ALTER TABLE "import_batch" ADD COLUMN     "error" TEXT,
ADD COLUMN     "failures" JSONB,
ADD COLUMN     "file_bytes" BYTEA,
ADD COLUMN     "original_name" TEXT,
ADD COLUMN     "period_from" DATE,
ADD COLUMN     "period_to" DATE,
ADD COLUMN     "warnings" JSONB;

-- AlterTable
ALTER TABLE "wallet" ADD COLUMN     "importer_config" JSONB;

-- AlterTable
ALTER TABLE "wallet_transaction" ADD COLUMN     "category" TEXT,
ADD COLUMN     "occurred_at" TIMESTAMPTZ(6),
ADD COLUMN     "raw" JSONB,
ADD COLUMN     "value_date" DATE;

-- CreateIndex
CREATE INDEX "import_batch_wallet_id_executed_at_idx" ON "import_batch"("wallet_id", "executed_at");

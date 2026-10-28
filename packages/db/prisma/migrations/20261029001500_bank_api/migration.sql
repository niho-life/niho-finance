-- AlterTable
ALTER TABLE "wallet" ADD COLUMN     "bank_api_account_id" TEXT,
ADD COLUMN     "bank_api_account_label" TEXT,
ADD COLUMN     "bank_api_balance" BIGINT,
ADD COLUMN     "bank_api_balance_date" DATE,
ADD COLUMN     "bank_api_env" TEXT,
ADD COLUMN     "bank_api_error" TEXT,
ADD COLUMN     "bank_api_last_synced_at" TIMESTAMPTZ(6),
ADD COLUMN     "bank_api_status" TEXT,
ADD COLUMN     "bank_api_synced_through" DATE,
ADD COLUMN     "bank_api_tokens" TEXT;

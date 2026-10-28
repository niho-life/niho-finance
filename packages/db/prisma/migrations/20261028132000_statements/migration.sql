-- AlterTable
ALTER TABLE "wallet_transaction" ADD COLUMN     "auto_posted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "rule_id" TEXT,
ADD COLUMN     "settled_at" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "wallet_transaction_status_txn_date_idx" ON "wallet_transaction"("status", "txn_date");

-- AddForeignKey
ALTER TABLE "wallet_transaction" ADD CONSTRAINT "wallet_transaction_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "rule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

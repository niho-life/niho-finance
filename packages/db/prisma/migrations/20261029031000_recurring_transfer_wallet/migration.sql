-- AlterTable
ALTER TABLE "recurring_item" ADD COLUMN     "transfer_wallet_id" TEXT;

-- AddForeignKey
ALTER TABLE "recurring_item" ADD CONSTRAINT "recurring_item_transfer_wallet_id_fkey" FOREIGN KEY ("transfer_wallet_id") REFERENCES "wallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

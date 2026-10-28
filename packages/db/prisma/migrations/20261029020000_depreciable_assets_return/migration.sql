-- 償却資産申告の元データ (#49, docs/design/16-year-end.md §14). Additive only: the municipality the
-- return goes to, and per fixed asset the kind of the return form (1–6) and an explicit exclusion.
-- Named after 20261029001500_bank_api so that it sorts after it.

-- AlterTable
ALTER TABLE "company" ADD COLUMN     "property_tax_municipality" TEXT;

-- AlterTable
ALTER TABLE "fixed_asset" ADD COLUMN     "property_tax_asset_type" INTEGER,
ADD COLUMN     "property_tax_excluded_reason" TEXT;

-- 資産の種類 of the 種類別明細書: 1 構築物 … 6 工具、器具及び備品 (null = from the account).
ALTER TABLE "fixed_asset" ADD CONSTRAINT "fixed_asset_property_tax_asset_type_range"
  CHECK ("property_tax_asset_type" IS NULL OR "property_tax_asset_type" BETWEEN 1 AND 6);

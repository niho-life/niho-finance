import { listTaxCategories, todayInJapan } from "@niho-finance/db";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { formatDate } from "@/lib/format";
import { TaxCategoriesTable } from "./tax-categories-table";

export const metadata: Metadata = { title: "税区分" };

/** 設定 › 税区分: rules are added or switched on and off, never edited (10 §4.4). */
export default async function TaxCategoriesPage() {
  const today = todayInJapan();
  const categories = await listTaxCategories(await db(), { on: today });
  return (
    <>
      <PageHeader
        title="税区分"
        meta={`${formatDate(today)} 時点の税率`}
        back={{ href: "/settings", label: "設定" }}
      />
      <TaxCategoriesTable categories={categories} />
    </>
  );
}

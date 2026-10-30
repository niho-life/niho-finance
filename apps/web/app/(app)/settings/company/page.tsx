import { getCompany, listFiscalYears } from "@niho-finance/db";
import type { Metadata } from "next";
import { CompanyForm } from "@/components/settings/company-form";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { toCompanyFormValues } from "@/lib/form-values";
import { FirstMonthGuideSetting } from "@/app/(app)/_components/first-month-guide-setting";
import { saveCompanyAction } from "../actions";

export const metadata: Metadata = { title: "事業所" };

/** 設定 › 事業所: one form (10 §4.1). */
export default async function CompanySettingsPage() {
  const prisma = await db();
  const company = await getCompany(prisma);
  const fiscalYears = await listFiscalYears(prisma);
  const initial = toCompanyFormValues(company);
  return (
    <>
      <PageHeader title="事業所" back={{ href: "/settings", label: "設定" }} />
      <section className="rounded-card border border-border bg-surface px-5 py-5">
        {/* Remounted with the saved values after a save (normalized numbers show as stored). */}
        <CompanyForm
          key={JSON.stringify(initial)}
          action={saveCompanyAction}
          initial={initial}
          locked={fiscalYears.length > 0}
          submitLabel="保存"
          showRegisteredOn
          savedMessage="事業所を保存しました"
        />
      </section>
      <FirstMonthGuideSetting />
    </>
  );
}

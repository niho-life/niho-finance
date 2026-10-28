import {
  countCheckablePartners,
  listAccountOptions,
  listPartnerRegistrations,
  listPartners,
  listSegmentOptions,
  listTaxCategoryOptions,
  registrationStatusLabel,
} from "@niho-finance/db";
import type { Metadata } from "next";
import Form from "next/form";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { formatDateTime } from "@/lib/format";
import { ntaStatus } from "@/lib/reader/config";
import { PartnersTable, type RegistrationCell } from "./partners-table";
import { RegistryCheckButton } from "./registry-check-button";

export const metadata: Metadata = { title: "取引先" };

/** `2026/11/01`: the JST day of a lookup. */
function checkedDay(at: Date): string {
  return formatDateTime(at).slice(0, 10);
}

/** 設定 › 取引先: search, edit in the list, add at the end (10 §4.6). */
export default async function PartnersPage({ searchParams }: PageProps<"/settings/partners">) {
  const { q } = await searchParams;
  const query = typeof q === "string" ? q.trim() : "";
  const prisma = await db();
  const partners = await listPartners(prisma, { query });
  const accounts = await listAccountOptions(prisma);
  const segments = await listSegmentOptions(prisma);
  const taxOptions = await listTaxCategoryOptions(prisma);
  // 照合 (20-reader §10.3): the stored lookups, and 照合する while the application ID is set.
  const nta = ntaStatus();
  const views = await listPartnerRegistrations(prisma);
  const registrations = new Map<string, RegistrationCell>();
  let lastCheckedAt: Date | null = null;
  for (const [id, view] of views) {
    registrations.set(id, {
      label: registrationStatusLabel(view),
      checkedOn: view.checkedAt ? checkedDay(view.checkedAt) : null,
    });
    if (view.checkedAt && (lastCheckedAt === null || view.checkedAt > lastCheckedAt)) {
      lastCheckedAt = view.checkedAt;
    }
  }
  const checkable = nta.enabled ? await countCheckablePartners(prisma) : 0;
  return (
    <>
      <PageHeader title="取引先" back={{ href: "/settings", label: "設定" }} />
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Form action="/settings/partners" className="flex w-full max-w-md gap-2" role="search">
          <label className="min-w-0 flex-1">
            <span className="sr-only">取引先を探す</span>
            <input
              name="q"
              type="search"
              defaultValue={query}
              placeholder="名前・カナ・登録番号"
              className="control"
            />
          </label>
          <Button type="submit">検索</Button>
        </Form>
        {checkable > 0 ? (
          <RegistryCheckButton
            count={checkable}
            lastChecked={lastCheckedAt ? checkedDay(lastCheckedAt) : null}
          />
        ) : null}
      </div>
      {query ? (
        <p className="mb-3 text-[13px] text-muted">
          「{query}」の結果 {partners.length} 件
        </p>
      ) : null}
      <PartnersTable
        key={query}
        partners={partners}
        accounts={accounts}
        segments={segments}
        taxOptions={taxOptions}
        registrations={registrations}
        ntaEnabled={nta.enabled}
      />
    </>
  );
}

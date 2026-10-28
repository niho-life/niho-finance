import {
  listAccountOptions,
  listPartners,
  listSegmentOptions,
  listTaxCategoryOptions,
} from "@niho-finance/db";
import type { Metadata } from "next";
import Form from "next/form";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { PartnersTable } from "./partners-table";

export const metadata: Metadata = { title: "取引先" };

/** 設定 › 取引先: search, edit in the list, add at the end (10 §4.6). */
export default async function PartnersPage({ searchParams }: PageProps<"/settings/partners">) {
  const { q } = await searchParams;
  const query = typeof q === "string" ? q.trim() : "";
  const prisma = await db();
  const partners = await listPartners(prisma, { query });
  const accounts = await listAccountOptions(prisma);
  const segments = await listSegmentOptions(prisma);
  const taxOptions = await listTaxCategoryOptions(prisma);
  return (
    <>
      <PageHeader title="取引先" back={{ href: "/settings", label: "設定" }} />
      <Form action="/settings/partners" className="mb-3 flex max-w-md gap-2" role="search">
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
      />
    </>
  );
}

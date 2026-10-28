import { listMemoTags } from "@niho-finance/db";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { MemoTagsTable } from "./memo-tags-table";

export const metadata: Metadata = { title: "タグ" };

/** 設定 › タグ: free tags on journal lines (10 §4.8). */
export default async function MemoTagsPage() {
  const tags = await listMemoTags(await db());
  return (
    <>
      <PageHeader title="タグ" back={{ href: "/settings", label: "設定" }} />
      <MemoTagsTable tags={tags} />
    </>
  );
}

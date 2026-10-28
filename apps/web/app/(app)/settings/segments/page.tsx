import { listSegments } from "@niho-finance/db";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { SegmentsTable } from "./segments-table";

export const metadata: Metadata = { title: "セグメント" };

/** 設定 › セグメント: the 4 standard ones stay active (10 §4.7). */
export default async function SegmentsPage() {
  const segments = await listSegments(await db());
  return (
    <>
      <PageHeader title="セグメント" back={{ href: "/settings", label: "設定" }} />
      <SegmentsTable segments={segments} />
    </>
  );
}

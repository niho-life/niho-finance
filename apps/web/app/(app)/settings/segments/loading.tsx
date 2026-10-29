import { PageSkeleton } from "@/components/ui/skeleton";

/** セグメント while it loads: the rows of the table (05-ui-ux §3.1). */
export default function SegmentsLoading() {
  return <PageSkeleton variant="table" title="セグメント" back="設定" />;
}

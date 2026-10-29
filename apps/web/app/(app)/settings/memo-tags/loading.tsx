import { PageSkeleton } from "@/components/ui/skeleton";

/** タグ while it loads: the rows of the table (05-ui-ux §3.1). */
export default function MemoTagsLoading() {
  return <PageSkeleton variant="table" title="タグ" back="設定" />;
}

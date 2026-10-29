import { PageSkeleton } from "@/components/ui/skeleton";

/** 取引 while it loads: the filters and the rows of the list (05-ui-ux §3.1). */
export default function EntriesLoading() {
  return <PageSkeleton variant="list" title="取引" actions={4} />;
}

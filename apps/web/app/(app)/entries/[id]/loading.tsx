import { PageSkeleton } from "@/components/ui/skeleton";

/** An entry while it loads: the shape of the record (05-ui-ux §3.1). */
export default function EntryLoading() {
  return <PageSkeleton variant="detail" back="取引" actions={2} />;
}

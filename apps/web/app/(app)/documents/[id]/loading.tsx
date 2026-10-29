import { PageSkeleton } from "@/components/ui/skeleton";

/** A document while it loads: the shape of the record (05-ui-ux §3.1). */
export default function DocumentLoading() {
  return <PageSkeleton variant="detail" back="証憑" actions={2} />;
}

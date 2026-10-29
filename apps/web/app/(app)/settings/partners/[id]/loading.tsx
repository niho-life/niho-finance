import { PageSkeleton } from "@/components/ui/skeleton";

/** A partner while it loads: the shape of the record (05-ui-ux §3.1). */
export default function PartnerLoading() {
  return <PageSkeleton variant="detail" back="取引先" actions={1} />;
}

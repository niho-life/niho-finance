import { PageSkeleton } from "@/components/ui/skeleton";

/** A fixed asset while it loads: the shape of the record (05-ui-ux §3.1). */
export default function FixedAssetLoading() {
  return <PageSkeleton variant="detail" back="固定資産台帳" actions={1} />;
}

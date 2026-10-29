import { PageSkeleton } from "@/components/ui/skeleton";

/** 固定資産台帳 while it loads: the rows of the table (05-ui-ux §3.1). */
export default function FixedAssetsLoading() {
  return <PageSkeleton variant="table" title="固定資産台帳" back="決算" actions={1} />;
}

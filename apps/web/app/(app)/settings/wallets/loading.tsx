import { PageSkeleton } from "@/components/ui/skeleton";

/** 口座 while it loads: the rows of the table (05-ui-ux §3.1). */
export default function WalletsLoading() {
  return <PageSkeleton variant="table" title="口座" back="設定" />;
}

import { PageSkeleton } from "@/components/ui/skeleton";

/** 定期取引 while it loads: the rows of the table (05-ui-ux §3.1). */
export default function RecurringLoading() {
  return <PageSkeleton variant="table" title="定期取引" back="設定" />;
}

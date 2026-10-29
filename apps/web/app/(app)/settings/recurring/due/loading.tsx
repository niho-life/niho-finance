import { PageSkeleton } from "@/components/ui/skeleton";

/** 定期取引の登録 while it loads: the rows of the table (05-ui-ux §3.1). */
export default function RecurringDueLoading() {
  return <PageSkeleton variant="table" title="定期取引の登録" back="定期取引" />;
}

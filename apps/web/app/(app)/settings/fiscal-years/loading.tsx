import { PageSkeleton } from "@/components/ui/skeleton";

/** 会計期間 while it loads: the rows of the table (05-ui-ux §3.1). */
export default function FiscalYearsLoading() {
  return <PageSkeleton variant="table" title="会計期間" back="設定" />;
}

import { PageSkeleton } from "@/components/ui/skeleton";

/** 勘定科目 while it loads: the rows of the table (05-ui-ux §3.1). */
export default function AccountsLoading() {
  return <PageSkeleton variant="table" title="勘定科目" back="設定" />;
}

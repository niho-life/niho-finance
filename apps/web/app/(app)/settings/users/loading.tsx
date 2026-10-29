import { PageSkeleton } from "@/components/ui/skeleton";

/** 利用者 while it loads: the rows of the table (05-ui-ux §3.1). */
export default function UsersLoading() {
  return <PageSkeleton variant="table" title="利用者" back="設定" />;
}

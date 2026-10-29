import { PageSkeleton } from "@/components/ui/skeleton";

/** 監査ログ while it loads: the filters and the rows of the list (05-ui-ux §3.1). */
export default function AuditLogLoading() {
  return <PageSkeleton variant="list" title="監査ログ" back="設定" />;
}

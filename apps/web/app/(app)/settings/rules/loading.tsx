import { PageSkeleton } from "@/components/ui/skeleton";

/** ルール while it loads: the rows of the table (05-ui-ux §3.1). */
export default function RulesLoading() {
  return <PageSkeleton variant="table" title="ルール" back="設定" />;
}

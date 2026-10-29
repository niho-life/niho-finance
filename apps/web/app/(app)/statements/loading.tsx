import { PageSkeleton } from "@/components/ui/skeleton";

/** 明細 while it loads: the filters and the rows of the list (05-ui-ux §3.1). */
export default function StatementsLoading() {
  return <PageSkeleton variant="list" title="明細" actions={1} />;
}

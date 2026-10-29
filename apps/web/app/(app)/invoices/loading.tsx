import { PageSkeleton } from "@/components/ui/skeleton";

/** 請求 while it loads: the filters and the rows of the list (05-ui-ux §3.1). */
export default function InvoicesLoading() {
  return <PageSkeleton variant="list" title="請求" actions={4} />;
}

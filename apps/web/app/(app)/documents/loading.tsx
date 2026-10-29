import { PageSkeleton } from "@/components/ui/skeleton";

/** 証憑 while it loads: the filters and the rows of the list (05-ui-ux §3.1). */
export default function DocumentsLoading() {
  return <PageSkeleton variant="list" title="証憑" />;
}

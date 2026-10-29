import { PageSkeleton } from "@/components/ui/skeleton";

/** 検索 while it loads: the filters and the rows of the list (05-ui-ux §3.1). */
export default function SearchLoading() {
  return <PageSkeleton variant="list" title="検索" />;
}

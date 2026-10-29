import { PageSkeleton } from "@/components/ui/skeleton";

/** 税区分 while it loads: the rows of the table (05-ui-ux §3.1). */
export default function TaxCategoriesLoading() {
  return <PageSkeleton variant="table" title="税区分" back="設定" />;
}

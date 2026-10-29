import { PageSkeleton } from "@/components/ui/skeleton";

/** 取込の結果 while it loads: the shape of the record (05-ui-ux §3.1). */
export default function ImportBatchLoading() {
  return <PageSkeleton variant="detail" title="取込の結果" back="明細の取込" />;
}

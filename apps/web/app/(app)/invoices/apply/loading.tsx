import { PageSkeleton } from "@/components/ui/skeleton";

/** 明細を請求に充てる while it loads: the shape of the record (05-ui-ux §3.1). */
export default function ApplyInvoiceLoading() {
  return <PageSkeleton variant="detail" title="明細を請求に充てる" back="明細" />;
}

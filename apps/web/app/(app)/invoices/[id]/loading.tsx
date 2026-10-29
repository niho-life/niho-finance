import { PageSkeleton } from "@/components/ui/skeleton";

/** A document of 請求 while it loads: the shape of the record (05-ui-ux §3.1). */
export default function InvoiceLoading() {
  return <PageSkeleton variant="detail" back="請求" actions={2} />;
}

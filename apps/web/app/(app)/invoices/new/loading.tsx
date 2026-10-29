import { PageSkeleton } from "@/components/ui/skeleton";

/** The new document of 請求 while it loads: the fields of the form (05-ui-ux §3.1). */
export default function NewInvoiceLoading() {
  return <PageSkeleton variant="form" back />;
}

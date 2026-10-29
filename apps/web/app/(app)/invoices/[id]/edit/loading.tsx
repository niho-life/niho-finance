import { PageSkeleton } from "@/components/ui/skeleton";

/** The draft being edited while it loads: the fields of the form (05-ui-ux §3.1). */
export default function EditInvoiceLoading() {
  return <PageSkeleton variant="form" back />;
}

import { PageSkeleton } from "@/components/ui/skeleton";

/** The new 支給 while it loads: the fields of the form (05-ui-ux §3.1). */
export default function NewPayrollRunLoading() {
  return <PageSkeleton variant="form" back="給与" />;
}

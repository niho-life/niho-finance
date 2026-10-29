import { PageSkeleton } from "@/components/ui/skeleton";

/** A 支給 while it loads: the shape of the record (05-ui-ux §3.1). */
export default function PayrollRunLoading() {
  return <PageSkeleton variant="detail" back="給与" />;
}

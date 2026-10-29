import { PageSkeleton } from "@/components/ui/skeleton";

/** 従業員 while it loads: the rows of the table (05-ui-ux §3.1). */
export default function EmployeesLoading() {
  return <PageSkeleton variant="table" title="従業員" back="給与" />;
}

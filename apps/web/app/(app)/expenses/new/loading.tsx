import { PageSkeleton } from "@/components/ui/skeleton";

/** 立替を出す while it loads: the fields of the form (05-ui-ux §3.1). */
export default function NewExpenseLoading() {
  return <PageSkeleton variant="form" title="立替を出す" back="立替精算" />;
}

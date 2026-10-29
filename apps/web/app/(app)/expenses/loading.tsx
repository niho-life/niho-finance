import { PageSkeleton } from "@/components/ui/skeleton";

/** 立替精算 while it loads: the sections (05-ui-ux §3.1). */
export default function ExpensesLoading() {
  return <PageSkeleton variant="sections" title="立替精算" actions={1} />;
}

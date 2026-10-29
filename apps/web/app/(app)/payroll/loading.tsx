import { PageSkeleton } from "@/components/ui/skeleton";

/** 給与 while it loads: the sections (05-ui-ux §3.1). */
export default function PayrollLoading() {
  return <PageSkeleton variant="sections" title="給与" actions={1} />;
}

import { PageSkeleton } from "@/components/ui/skeleton";

/** 決算 while it loads: the steps (05-ui-ux §3.1). */
export default function ClosingLoading() {
  return <PageSkeleton variant="checklist" title="決算" actions={1} />;
}

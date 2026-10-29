import { PageSkeleton } from "@/components/ui/skeleton";

/** 報告 while it loads: the frame and the table (05-ui-ux §3.1). */
export default function ReportsLoading() {
  return <PageSkeleton variant="report" title="報告" />;
}

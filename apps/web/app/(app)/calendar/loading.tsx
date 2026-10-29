import { PageSkeleton } from "@/components/ui/skeleton";

/** 期限 while it loads: the sections (05-ui-ux §3.1). */
export default function CalendarLoading() {
  return <PageSkeleton variant="sections" title="期限" />;
}

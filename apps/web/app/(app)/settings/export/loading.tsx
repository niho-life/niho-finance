import { PageSkeleton } from "@/components/ui/skeleton";

/** 書き出し while it loads: the sections (05-ui-ux §3.1). */
export default function ExportLoading() {
  return <PageSkeleton variant="sections" back />;
}

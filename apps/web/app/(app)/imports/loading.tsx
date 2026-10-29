import { PageSkeleton } from "@/components/ui/skeleton";

/** 明細の取込 while it loads: the sections (05-ui-ux §3.1). */
export default function ImportsLoading() {
  return <PageSkeleton variant="sections" title="明細の取込" actions={1} />;
}

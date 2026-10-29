import { PageSkeleton } from "@/components/ui/skeleton";

/** 決算書 while it loads: the sections (05-ui-ux §3.1). */
export default function FinancialStatementsLoading() {
  return <PageSkeleton variant="sections" title="決算書" actions={1} />;
}

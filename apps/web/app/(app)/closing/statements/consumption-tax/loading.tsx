import { PageSkeleton } from "@/components/ui/skeleton";

/** 消費税の集計 while it loads: the sections (05-ui-ux §3.1). */
export default function ConsumptionTaxLoading() {
  return <PageSkeleton variant="sections" title="消費税の集計" back="決算書" />;
}

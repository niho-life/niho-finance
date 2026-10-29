import { PageSkeleton } from "@/components/ui/skeleton";

/** 事業所 while it loads: the fields of the form (05-ui-ux §3.1). */
export default function CompanyLoading() {
  return <PageSkeleton variant="form" title="事業所" back="設定" />;
}

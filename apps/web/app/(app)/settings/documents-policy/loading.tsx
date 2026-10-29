import { PageSkeleton } from "@/components/ui/skeleton";

/** 証憑の規程 while it loads: the fields of the form (05-ui-ux §3.1). */
export default function DocumentsPolicyLoading() {
  return <PageSkeleton variant="form" title="証憑の規程" back="設定" />;
}

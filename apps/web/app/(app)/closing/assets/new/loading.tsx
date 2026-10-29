import { PageSkeleton } from "@/components/ui/skeleton";

/** 固定資産の登録 while it loads: the fields of the form (05-ui-ux §3.1). */
export default function NewFixedAssetLoading() {
  return <PageSkeleton variant="form" title="固定資産の登録" back="固定資産台帳" />;
}

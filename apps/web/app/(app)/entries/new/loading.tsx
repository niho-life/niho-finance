import { PageSkeleton } from "@/components/ui/skeleton";

/** 取引の登録 while it loads: the fields of the form (05-ui-ux §3.1). */
export default function NewEntryLoading() {
  return <PageSkeleton variant="form" title="取引の登録" back="取引" />;
}

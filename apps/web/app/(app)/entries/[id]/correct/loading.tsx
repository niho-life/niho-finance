import { PageSkeleton } from "@/components/ui/skeleton";

/** 訂正 of an entry while it loads: the fields of the form (05-ui-ux §3.1). */
export default function CorrectEntryLoading() {
  return <PageSkeleton variant="form" back />;
}

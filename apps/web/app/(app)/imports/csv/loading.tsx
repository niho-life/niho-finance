import { PageSkeleton } from "@/components/ui/skeleton";

/** CSV の取込 while it loads: the fields of the form (05-ui-ux §3.1). */
export default function CsvImportLoading() {
  return <PageSkeleton variant="form" title="CSV の取込" back="明細の取込" />;
}

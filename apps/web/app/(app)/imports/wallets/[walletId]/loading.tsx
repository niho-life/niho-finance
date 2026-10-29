import { PageSkeleton } from "@/components/ui/skeleton";

/** 取込の設定 while it loads: the fields of the form (05-ui-ux §3.1). */
export default function ImportSettingsLoading() {
  return <PageSkeleton variant="form" title="取込の設定" back="明細の取込" actions={1} />;
}

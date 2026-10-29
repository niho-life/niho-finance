import { PageSkeleton } from "@/components/ui/skeleton";

/** 請求の設定 while it loads: the fields of the form (05-ui-ux §3.1). */
export default function InvoiceSettingsLoading() {
  return <PageSkeleton variant="form" title="請求の設定" back="請求" />;
}

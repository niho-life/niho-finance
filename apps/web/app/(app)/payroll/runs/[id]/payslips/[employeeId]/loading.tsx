import { PageSkeleton } from "@/components/ui/skeleton";

/** 給与明細 while it loads: the shape of the record (05-ui-ux §3.1). */
export default function PayslipLoading() {
  return <PageSkeleton variant="detail" title="給与明細" back actions={1} />;
}

import { PageSkeleton } from "@/components/ui/skeleton";

/** 銀行 API の接続 while it loads: the fields of the form (05-ui-ux §3.1). */
export default function BankConnectionLoading() {
  return <PageSkeleton variant="form" title="銀行 API の接続" back="口座" />;
}

import { PageSkeleton } from "@/components/ui/skeleton";

/** 設定 while it loads: the rows of the sections (05-ui-ux §3.1). */
export default function SettingsLoading() {
  return <PageSkeleton variant="index" title="設定" />;
}

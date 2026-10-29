import { PageSkeleton } from "@/components/ui/skeleton";

/** 受け渡しパッケージ while it loads: the sections (05-ui-ux §3.1). */
export default function HandoverPackageLoading() {
  return (
    <PageSkeleton variant="sections" title="受け渡しパッケージ" back="書き出しとバックアップ" />
  );
}

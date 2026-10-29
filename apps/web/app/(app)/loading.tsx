import { PageSkeleton } from "@/components/ui/skeleton";

/** ホーム while it loads: the shape of the home (05-ui-ux §3.1). */
export default function HomeLoading() {
  return <PageSkeleton variant="home" title="ホーム" />;
}

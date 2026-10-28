import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

/** No fiscal year at all (the setup creates the first one, so this is an odd state). */
export function NoFiscalYear() {
  return (
    <>
      <PageHeader title="報告" />
      <EmptyState
        title="会計期間がありません"
        description="会計期間を作ると、報告を表示します。"
        action={
          <ButtonLink href="/settings/fiscal-years" size="sm">
            会計期間を作る
          </ButtonLink>
        }
      />
    </>
  );
}

/** Nothing posted in the period (14-reports §3). The 取引 screen is S3's: no link yet. */
export function NoEntries() {
  return <EmptyState title="この期間に仕訳がありません" description="取引から登録します。" />;
}

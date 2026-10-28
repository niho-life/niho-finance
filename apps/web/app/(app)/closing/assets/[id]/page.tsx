import {
  FIXED_ASSET_STATUS_LABELS,
  getFixedAssetDetail,
  loadEntryFormOptions,
  todayInJapan,
  type FixedAssetDetail,
  type FixedAssetHistoryRow,
  type FixedAssetScheduleRow,
} from "@niho-finance/db";
import { ENTRY_KIND_LABELS, formatYen, formatYenInput } from "@niho-finance/ledger";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { JsonPair } from "@/components/ui/json-pair";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { db } from "@/lib/data";
import { formatDate, formatDateTime, formatPeriod, walletLabel } from "@/lib/format";
import { Band, EntryLink, Facts } from "../../_components/parts";
import { DisposeAssetSheet, EditAssetSheet, VoidAssetButton } from "../_components/asset-actions";
import { depreciableAccounts, methodLabel } from "../_components/asset-kit";

export const metadata: Metadata = { title: "固定資産の詳細" };

function methodText(detail: FixedAssetDetail): string {
  const label = methodLabel(detail.method, detail.cost);
  return detail.usefulLifeYears !== null ? `${label}（${detail.usefulLifeYears} 年）` : label;
}

/** 除却済み / 売却済み（日付・仕訳 No.）, 登録を取り消した（理由） (16 §5.2). */
function Bands({ detail }: { detail: FixedAssetDetail }) {
  const bands: ReactNode[] = [];
  if (detail.status === "voided") {
    bands.push(
      <Band key="voided">登録を取り消しました（理由: {detail.voidReason ?? "—"}）。</Band>,
    );
  }
  if ((detail.status === "disposed" || detail.status === "sold") && detail.disposedAt) {
    bands.push(
      <Band key="disposed">
        {FIXED_ASSET_STATUS_LABELS[detail.status]}（{formatDate(detail.disposedAt)}
        {detail.disposalEntry ? (
          <>
            ・<EntryLink entry={detail.disposalEntry} />
          </>
        ) : (
          "・仕訳なし"
        )}
        ）。
        {detail.method === "lump_sum_3y"
          ? "一括償却（3 年）のため、償却は 3 年まで続けます。"
          : null}
      </Band>,
    );
  }
  if (bands.length === 0) return null;
  return <div className="mb-4 flex flex-col gap-2">{bands}</div>;
}

const SCHEDULE_COLUMNS = {
  columns: "minmax(0,1.2fr) 128px 112px 128px minmax(0,1.2fr)",
  mobileColumns: "minmax(0,1fr) auto",
};

function ScheduleState({ row }: { row: FixedAssetScheduleRow }) {
  switch (row.state) {
    case "posted":
      return (
        <span className="flex flex-wrap items-center gap-x-2 text-[13px]">
          計上済み
          {row.entries.map((entry) => (
            <EntryLink key={entry.id} entry={entry} />
          ))}
        </span>
      );
    case "unposted":
      return <span className="text-[13px]">未計上</span>;
    case "projected":
      return <span className="text-[13px] text-muted">予定</span>;
    case "none":
      return <span className="text-[13px] text-muted">計上なし</span>;
  }
}

/** 予定表 (§5.2): past years from what was posted, then 12-month years until the floor. */
function Schedule({ rows }: { rows: readonly FixedAssetScheduleRow[] }) {
  return (
    <section aria-labelledby="asset-schedule" className="mt-6">
      <h2 id="asset-schedule" className="mb-2 text-[15px] font-extrabold">
        予定表
      </h2>
      {rows.length === 0 ? (
        <p className="text-[13px] text-muted">償却の予定はありません。</p>
      ) : (
        <Table label="償却の予定表">
          <TableHead {...SCHEDULE_COLUMNS}>
            <Th>期</Th>
            <Th align="right" sm="hide">
              期首帳簿価額（円）
            </Th>
            <Th align="right">償却額（円）</Th>
            <Th align="right" sm="hide">
              期末帳簿価額（円）
            </Th>
            <Th>状態</Th>
          </TableHead>
          {rows.map((row) => (
            <TableRow
              key={`${row.startDate}-${row.endDate}`}
              {...SCHEDULE_COLUMNS}
              muted={row.projected}
            >
              <Td>
                <span className="font-semibold">
                  {row.fiscalYearNo !== null ? `第 ${row.fiscalYearNo} 期` : "（仮の期）"}
                </span>
                <span className="num block text-[11px] text-muted-2">
                  {formatPeriod(row.startDate, row.endDate)}
                </span>
              </Td>
              <Td align="right" sm="hide">
                {formatYen(row.opening)}
              </Td>
              <Td align="right" className="font-bold">
                {formatYen(row.posted ?? row.amount)}
              </Td>
              <Td align="right" sm="hide">
                {formatYen(row.closing)}
              </Td>
              <Td sm="full">
                <ScheduleState row={row} />
                <span className="num ml-2 text-[12px] text-muted md:hidden">
                  {formatYen(row.opening)} → {formatYen(row.closing)}
                </span>
              </Td>
            </TableRow>
          ))}
        </Table>
      )}
      <p className="mt-2 text-[12px] text-muted">
        まだない期は 12
        か月の期を仮に置いて、償却が終わるまで出します。計上しなかった期があれば、以後の額はその実績から計算し直します。
      </p>
    </section>
  );
}

/** 償却・除却の仕訳 (取消済みと反対仕訳を含む). */
function Entries({ detail }: { detail: FixedAssetDetail }) {
  if (detail.entries.length === 0) return null;
  return (
    <section aria-labelledby="asset-entries" className="mt-6">
      <h2 id="asset-entries" className="mb-2 text-[15px] font-extrabold">
        償却・除却の仕訳
      </h2>
      <ul className="overflow-hidden rounded-card border border-border">
        {detail.entries.map((entry) => (
          <li
            key={entry.id}
            className={`flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-border px-3.5 py-2.5 text-[14px] last:border-b-0 ${
              entry.status === "voided" ? "text-muted" : ""
            }`}
          >
            <span className="num text-[13px] text-muted">{formatDate(entry.entryDate)}</span>
            <EntryLink entry={entry} />
            <span className="min-w-0 flex-1 break-words">{entry.description}</span>
            <span className="text-[12px] text-muted">
              {ENTRY_KIND_LABELS[entry.kind]}
              {entry.status === "voided" ? " · 取消済み" : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const OPERATIONS: Readonly<Record<string, string>> = {
  "fixed_asset.create": "登録",
  "fixed_asset.update": "編集",
  "fixed_asset.void": "登録の取消",
  "fixed_asset.dispose": "除却・売却",
};

const HISTORY_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 md:grid-cols-[136px_150px_minmax(0,0.8fr)_minmax(0,1.2fr)]";

/** 履歴 (§5.2): the audit log of the asset, oldest first; a row opens to its before / after. */
function History({ rows }: { rows: readonly FixedAssetHistoryRow[] }) {
  return (
    <section aria-labelledby="asset-history" className="mt-8">
      <h2 id="asset-history" className="mb-2 text-[15px] font-extrabold">
        履歴
      </h2>
      {rows.length === 0 ? (
        <p className="text-[13px] text-muted">履歴がありません</p>
      ) : (
        <ul className="overflow-hidden rounded-card border border-border">
          <li
            aria-hidden="true"
            className={`${HISTORY_GRID} hidden bg-surface-2 px-3.5 py-2 text-[11px] font-bold text-muted-2 md:grid`}
          >
            <span>日時</span>
            <span>操作</span>
            <span>実行者</span>
            <span>理由</span>
          </li>
          {rows.map((row) => (
            <li key={row.id} className="border-b border-border last:border-b-0">
              <details>
                <summary
                  className={`${HISTORY_GRID} cursor-pointer list-none px-3.5 py-2.5 text-[14px] hover:bg-black/[0.02] [&::-webkit-details-marker]:hidden`}
                >
                  <span className="num text-[13px] text-muted">{formatDateTime(row.at)}</span>
                  <span className="text-right font-bold md:text-left">
                    {OPERATIONS[row.action] ?? "変更"}
                  </span>
                  <span className="truncate text-[13px] text-muted">{row.actor}</span>
                  <span className="text-[13px] break-words">{row.reason ?? "—"}</span>
                </summary>
                <div className="px-3.5 pb-3">
                  <JsonPair before={row.before} after={row.after} />
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 固定資産の詳細 (16 §5.2–§5.3): the facts, the schedule, 編集・除却・売却・登録の取消 and the history. */
export default async function FixedAssetDetailPage({ params }: PageProps<"/closing/assets/[id]">) {
  const { id } = await params;
  const prisma = await db();
  const detail = await getFixedAssetDetail(prisma, id);
  if (!detail) notFound();
  const options = await loadEntryFormOptions(prisma, {
    includeIds: [detail.accountId, ...(detail.segmentId ? [detail.segmentId] : [])],
  });

  const voided = detail.status === "voided";
  const accounts = depreciableAccounts(options.accounts);
  if (!accounts.some((account) => account.id === detail.accountId)) {
    const current = options.accounts.find((account) => account.id === detail.accountId);
    if (current) accounts.unshift(current);
  }
  const posted = detail.schedule.reduce((sum, row) => sum + (row.posted ?? 0n), 0n);
  const bookValue = detail.method === "lump_sum_3y" ? 0n : detail.cost - posted;
  const meta = [
    detail.accountName,
    `取得日 ${formatDate(detail.acquisitionDate)}`,
    `取得価額 ${formatYen(detail.cost)} 円`,
    methodText(detail),
  ].join(" · ");

  return (
    <>
      <PageHeader
        title={detail.name}
        meta={meta}
        back={{ href: "/closing/assets", label: "固定資産台帳" }}
        actions={
          voided ? undefined : (
            <>
              <EditAssetSheet
                asset={{
                  id: detail.id,
                  name: detail.name,
                  segmentId: detail.segmentId ?? "",
                  note: detail.note ?? "",
                  accountId: detail.accountId,
                  acquisitionDate: detail.acquisitionDate,
                  cost: formatYenInput(detail.cost),
                  method: detail.method,
                  usefulLifeYears:
                    detail.usefulLifeYears !== null ? String(detail.usefulLifeYears) : "",
                }}
                canEditParameters={detail.canEditParameters}
                editBlockedReason={detail.editBlockedReason}
                accounts={accounts.map((account) => ({
                  id: account.id,
                  code: account.code,
                  label: `${account.code} ${account.name}${account.isActive ? "" : "（無効）"}`,
                }))}
                segments={options.segments.map((segment) => ({
                  id: segment.id,
                  name: segment.isActive ? segment.name : `${segment.name}（無効）`,
                }))}
                fiscalYears={options.fiscalYears}
              />
              {detail.disposeBlockedReason === null ? (
                <DisposeAssetSheet
                  assetId={detail.id}
                  name={detail.name}
                  method={detail.method}
                  bookValue={bookValue.toString()}
                  wallets={options.wallets
                    .filter((wallet) => wallet.isActive)
                    .map((wallet) => ({ id: wallet.id, label: walletLabel(wallet) }))}
                  fiscalYears={options.fiscalYears}
                  taxRules={options.taxRules}
                  today={todayInJapan()}
                />
              ) : null}
              {detail.canVoid ? <VoidAssetButton assetId={detail.id} name={detail.name} /> : null}
            </>
          )
        }
      />
      <Bands detail={detail} />
      <Facts
        label="固定資産の内容"
        items={[
          { label: "状態", value: FIXED_ASSET_STATUS_LABELS[detail.status] },
          {
            label: "帳簿価額（今期末・円）",
            value: detail.bookValue === null ? "—" : formatYen(detail.bookValue),
            strong: true,
          },
          { label: "セグメント", value: detail.segmentName ?? "—" },
          {
            label: "取得の仕訳",
            value: detail.acquisitionEntry ? (
              <>
                <EntryLink entry={detail.acquisitionEntry} />
                {detail.acquisitionEntry.status === "voided" ? (
                  <span className="ml-1 text-[12px] text-muted">取消済み</span>
                ) : null}
              </>
            ) : (
              "—"
            ),
          },
          { label: "償却資産税", value: detail.isDepreciableAssetTaxed ? "対象" : "対象外" },
          {
            label: "中小企業者の特例（別表十六(七)）",
            value: detail.isSpecialSmallAsset ? "該当" : "—",
          },
        ]}
      />
      {detail.note ? (
        <p className="mt-3 text-[13px] break-words whitespace-pre-wrap text-muted">
          メモ: {detail.note}
        </p>
      ) : null}
      <Schedule rows={detail.schedule} />
      <Entries detail={detail} />
      <History rows={detail.history} />
    </>
  );
}

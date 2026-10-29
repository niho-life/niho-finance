import { listHandoverRequests, todayInJapan, type HandoverRequest } from "@niho-finance/db";
import {
  handoverDelivery,
  HANDOVER_INDEX_PATH,
  HANDOVER_MANIFEST_PATH,
  HANDOVER_README_PATH,
} from "@niho-finance/reports";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AutoSubmitSelect } from "@/components/ui/auto-submit-select";
import { Button, ButtonLink, buttonClass } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { db } from "@/lib/data";
import { formatPeriod } from "@/lib/format";
import { formatDateTime } from "../../../reports/_lib/format";
import { AutoSubmitCheckbox } from "./_components/auto-submit-checkbox";
import { requestHandoverPackage } from "./actions";
import { loadPackageBasis, packageBooks, packageEstimate } from "./_lib/collect";
import {
  PACKAGE_ERRORS,
  PACKAGE_NOTICES,
  REQUEST_STATE_LABELS,
  STALE_MESSAGE,
} from "./_lib/labels";
import { conditionsOfParams, largePackageMode } from "./_lib/query";

export const metadata: Metadata = { title: "受け渡しパッケージ" };

const REQUEST_COLUMNS = {
  columns: "9.5rem minmax(7rem,1fr) 4.5rem minmax(8rem,1.3fr) 6.5rem minmax(6rem,1fr) 7.5rem",
  mobileColumns: "minmax(0,0.8fr) minmax(0,1.4fr) auto",
};

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024)
    return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("ja-JP")} KB`;
  return `${(bytes / 1024 / 1024).toLocaleString("ja-JP", { maximumFractionDigits: 1 })} MB`;
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="border-t border-border pt-5 pb-7">
      <h2 id={`${id}-title`} className="text-[15px] font-extrabold">
        {title}
      </h2>
      {description ? <div className="mt-1 text-[13px] text-muted">{description}</div> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function ContentItem({
  path,
  description,
  detail,
}: {
  path: string;
  description: string;
  detail: string;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-0.5 border-b border-border px-4 py-2.5 last:border-b-0">
      <span className="text-[14px] font-bold break-words">{description}</span>
      <span className="text-[12px] break-all text-muted">
        <code>{path}</code> · {detail}
      </span>
    </li>
  );
}

function RequestState({ request }: { request: HandoverRequest }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className={request.state === "failed" ? "font-bold text-danger" : "font-bold"}>
        {REQUEST_STATE_LABELS[request.state]}
      </span>
      {request.state === "stale" ? (
        <span className="text-[12px] break-words text-warn">{STALE_MESSAGE}</span>
      ) : null}
      {request.state === "failed" && request.reason ? (
        <span className="text-[12px] break-words text-muted">{request.reason}</span>
      ) : null}
    </span>
  );
}

/**
 * The form's action: a form can only take a `void` action, and a refusal (an unregistered or
 * unverified user, whom the proxy already keeps off this page) has nothing to show here.
 */
async function submitPackageRequest(formData: FormData): Promise<void> {
  "use server";
  await requestHandoverPackage(formData);
}

/**
 * 設定 › 書き出しとバックアップ › 受け渡しパッケージ (14-reports §16.1): the year and whether to include
 * the document files (a GET form), what the zip will hold, 「書き出す」 (direct, up to 20 MB) or
 * 「作成を依頼」 (a job), and the latest requests with their state and download.
 */
export default async function HandoverPackagePage({
  searchParams,
}: PageProps<"/settings/export/package">) {
  // 閲覧 may open it: `/settings/export/*` passes the proxy for viewers (23 §3.3).
  const params = await searchParams;
  const conditions = conditionsOfParams(params);
  const prisma = await db();
  const basis = await loadPackageBasis(prisma, {
    fiscalYearNo: conditions.fiscalYearNo,
    today: todayInJapan(),
  });
  const requests = await listHandoverRequests(prisma, { limit: 10 });
  const error = typeof params.error === "string" ? PACKAGE_ERRORS[params.error] : undefined;
  const notice = typeof params.done === "string" ? PACKAGE_NOTICES[params.done] : undefined;

  const header = (
    <PageHeader
      title="受け渡しパッケージ"
      back={{ href: "/settings/export", label: "書き出しとバックアップ" }}
    />
  );
  if (!basis) {
    return (
      <>
        {header}
        <EmptyState
          title="会計期間がありません"
          description="設定 › 会計期間 で期を作ってから書き出します。"
          action={<ButtonLink href="/settings/fiscal-years">会計期間を開く</ButtonLink>}
        />
      </>
    );
  }

  const { year, source } = basis;
  const includeDocuments = conditions.includeDocuments;
  const books = await packageBooks(prisma, basis, { render: false, createdAt: new Date() });
  const estimate = packageEstimate(basis, includeDocuments);
  const delivery = handoverDelivery(estimate);
  const mode = largePackageMode();
  const years = [...source.fiscalYears].sort((a, b) => b.no - a.no);
  const documentSummary =
    basis.documents.length === 0
      ? "0 件"
      : `${basis.documents.length.toLocaleString("ja-JP")} 件・約 ${formatSize(basis.documentBytes)}`;
  const hidden = (
    <>
      <input type="hidden" name="fy" value={year.no} />
      {includeDocuments ? <input type="hidden" name="documents" value="1" /> : null}
    </>
  );

  return (
    <>
      {header}
      <p className="mb-4 text-[14px] text-muted">
        税理士や経理の担当に渡すため、1 つの期の帳簿・決算書・証憑の索引簿を 1 つの zip
        にまとめます。中身はほかの書き出しと同じ形式で、README.txt に一覧と形式の説明が入ります。
      </p>
      {error ? (
        <p role="alert" className="mb-4 rounded-card bg-warn-soft px-4 py-3 text-[14px] text-warn">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mb-4 rounded-card bg-surface-2 px-4 py-3 text-[14px]">
          {notice}
        </p>
      ) : null}

      <Section id="conditions" title="条件">
        <form
          method="get"
          action="/settings/export/package"
          className="flex flex-wrap items-end gap-x-4 gap-y-3"
        >
          <FormField label="期" htmlFor="package-fy" className="w-full sm:w-80">
            <AutoSubmitSelect id="package-fy" name="fy" defaultValue={String(year.no)}>
              {years.map((candidate) => (
                <option key={candidate.id} value={candidate.no}>
                  第{candidate.no}期 {formatPeriod(candidate.startDate, candidate.endDate)}
                </option>
              ))}
            </AutoSubmitSelect>
          </FormField>
          <AutoSubmitCheckbox
            id="package-documents"
            name="documents"
            value="1"
            defaultChecked={includeDocuments}
            label={`証憑のファイルを含める（${documentSummary}）`}
            className="min-w-0 break-words"
          />
          <Button type="submit">中身を表示</Button>
        </form>
      </Section>

      <Section
        id="contents"
        title="中身"
        description={`第${year.no}期 ${formatPeriod(year.startDate, year.endDate)}。ファイルの一覧と SHA-256 は README.txt と manifest.json にも入ります。`}
      >
        <ul className="overflow-hidden rounded-card border border-border bg-surface">
          {books.entries.map((entry) => (
            <ContentItem
              key={entry.path}
              path={entry.path}
              description={entry.description}
              detail={
                entry.rows === undefined
                  ? entry.format
                  : `${entry.format}・${entry.rows.toLocaleString("ja-JP")} 件`
              }
            />
          ))}
          {includeDocuments ? (
            <ContentItem
              path="documents/files/"
              description="証憑のファイル（索引簿の行と 1 対 1）"
              detail={`元の形式・${documentSummary}`}
            />
          ) : null}
          <ContentItem
            path={HANDOVER_INDEX_PATH}
            description="証憑の索引簿（無効にした証憑を含む）"
            detail={`UTF-8（BOM 付き）・CSV・${basis.documents.length.toLocaleString("ja-JP")} 件`}
          />
          <ContentItem
            path={HANDOVER_README_PATH}
            description="README（会社・期・中身の一覧・形式・注意）"
            detail="UTF-8（BOM 付き）・テキスト"
          />
          <ContentItem
            path={HANDOVER_MANIFEST_PATH}
            description="機械向けの一覧（パス・件数・バイト数・SHA-256）"
            detail="JSON"
          />
        </ul>
        <ul className="mt-3 flex list-disc flex-col gap-1 pl-5 text-[13px] text-muted">
          {year.status !== "closed" ? <li>決算書は締めた期だけ入ります。</li> : null}
          {!includeDocuments ? <li>証憑のファイルは含めません（索引簿だけ）。</li> : null}
          {books.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </Section>

      <Section
        id="make"
        title="書き出し"
        description={`大きさの見積り: 約 ${formatSize(estimate)}（帳簿の分 2 MB を含む）`}
      >
        {delivery === "direct" || mode === "none" ? (
          <form
            method="get"
            action="/settings/export/package/download"
            className="flex flex-col gap-2"
          >
            {hidden}
            {delivery === "job" ? (
              <p className="text-[13px] text-warn">{PACKAGE_ERRORS["no-queue"]}</p>
            ) : null}
            <div>
              <Button type="submit" variant="primary">
                書き出す
              </Button>
            </div>
          </form>
        ) : (
          <form action={submitPackageRequest} className="flex flex-col gap-2">
            {hidden}
            <p className="text-[13px] text-muted">
              20 MB
              を超えるため、作成を依頼します。作成済みになったら下の一覧からダウンロードします。
            </p>
            <div>
              <Button type="submit" variant="primary">
                作成を依頼
              </Button>
            </div>
          </form>
        )}
      </Section>

      <section
        id="packages"
        aria-labelledby="packages-title"
        className="border-t border-border pt-5"
      >
        <h2 id="packages-title" className="mb-3 text-[15px] font-extrabold">
          作成した受け渡しパッケージ
        </h2>
        {requests.length === 0 ? (
          <EmptyState
            title="作成を依頼したパッケージはまだありません"
            description="20 MB を超えるパッケージは「作成を依頼」で作り、ここからダウンロードします。"
          />
        ) : (
          <Table label="作成した受け渡しパッケージ">
            <TableHead {...REQUEST_COLUMNS}>
              <Th sm="hide">日時</Th>
              <Th>期</Th>
              <Th sm="hide">証憑</Th>
              <Th>状態</Th>
              <Th sm="hide" align="right">
                大きさ
              </Th>
              <Th sm="hide">依頼者</Th>
              <Th>
                <span className="sr-only">ダウンロード</span>
              </Th>
            </TableHead>
            {requests.map((request) => (
              <TableRow key={request.requestId} {...REQUEST_COLUMNS}>
                <Td sm="hide" className="num text-[13px] text-muted">
                  {formatDateTime(request.requestedAt)}
                </Td>
                <Td className="min-w-0 text-[13px]">
                  <span className="font-bold">第{request.fiscalYearNo}期</span>
                  <span className="hidden text-muted md:inline">
                    {" "}
                    {formatPeriod(request.from, request.to)}
                  </span>
                </Td>
                <Td sm="hide" className="text-[13px]">
                  {request.includeDocuments ? "含む" : "含まない"}
                </Td>
                <Td className="min-w-0 text-[13px]">
                  <RequestState request={request} />
                </Td>
                <Td sm="hide" align="right" className="num text-[13px]">
                  {request.bytes !== null
                    ? formatSize(request.bytes)
                    : `約 ${formatSize(request.estimateBytes)}`}
                </Td>
                <Td sm="hide" className="truncate text-[13px] text-muted">
                  {request.requestedBy}
                </Td>
                <Td align="right">
                  {request.state === "ready" ? (
                    <a
                      href={`/settings/export/package/download?request=${request.requestId}`}
                      className={buttonClass({ size: "sm" })}
                    >
                      ダウンロード
                    </a>
                  ) : null}
                </Td>
              </TableRow>
            ))}
          </Table>
        )}
      </section>
    </>
  );
}

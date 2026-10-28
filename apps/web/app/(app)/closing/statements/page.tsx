import {
  announcementDeadline,
  asOfLabel,
  buildFinancialStatements,
  DEEMED_PURCHASE_PERCENT,
  ETAX_STATEMENT_NAMES,
  ETAX_STATEMENTS,
  formatStatementAmount,
  japaneseDate,
  SIMPLIFIED_TAX_CLASS_LABELS,
  SIMPLIFIED_TAX_CLASSES,
  type FinancialStatementsReport,
  type StatementIssue,
  type StatementIssueKind,
} from "@niho-finance/reports";
import { loadFixedAssetRegister } from "@niho-finance/db";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { formatDate, formatPeriod } from "@/lib/format";
import { WarningBand } from "../../reports/_components/notices";
import {
  AlertBand,
  FiscalYearSelect,
  NoFiscalYear,
  Section,
  SubSection,
} from "./_components/parts";
import {
  StatementSettingsForm,
  type StatementSettingsFormValues,
} from "./_components/settings-form";
import {
  AmountRows,
  BalanceSheetView,
  DownloadLink,
  EquityStatementView,
  IncomeStatementView,
  NotesView,
} from "./_components/statement-tables";
import { consumptionTaxHref, STATEMENT_EXPORT_ERRORS, statementExportHref } from "./_lib/links";
import { etaxCharacterProblem, loadStatementsBook } from "./_lib/load";
import { firstParam, resolveStatementsYear } from "./_lib/query";

export const metadata: Metadata = { title: "決算書" };

const FILING_GUIDE = "docs/ops/filing.md";

/** Where each 確認 row is fixed (17 §3 item 1); `null` for what has no screen yet. */
function issueLink(
  kind: StatementIssueKind,
  fyNo: number,
): { href: string; label: string; anchor?: boolean } | null {
  switch (kind) {
    case "identity":
    case "internal":
      return { href: `/reports/trial-balance?fy=${fyNo}`, label: "試算表" };
    case "etaxCode":
      return { href: "/settings/accounts", label: "設定 › 勘定科目" };
    case "taxBalance":
      return { href: "/entries/new", label: "取引の登録" };
    case "equity":
    case "openingEntries":
      return { href: `/reports/journal?fy=${fyNo}`, label: "仕訳帳" };
    case "issuedShares":
    case "notesTemplate":
    case "businessReportTemplate":
      return { href: "#settings", label: "決算書の設定", anchor: true };
    case "fixedAssets":
      return null;
  }
}

function IssueList({
  issues,
  extra,
  fyNo,
}: {
  issues: readonly StatementIssue[];
  /** Rows without a screen of their own (the characters e-Tax refuses). */
  extra: readonly string[];
  fyNo: number;
}) {
  return (
    <ul className="divide-y divide-border rounded-card border border-border bg-surface">
      {issues.map((issue, index) => {
        const link = issueLink(issue.kind, fyNo);
        const linkClass = "shrink-0 text-[13px] font-bold text-primary-ink hover:underline";
        return (
          <li
            key={`${issue.kind}-${index}`}
            className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-2.5 text-[14px]"
          >
            <span className="min-w-0 flex-1">{issue.message}</span>
            {link ? (
              link.anchor ? (
                <a href={link.href} className={linkClass}>
                  {link.label}
                </a>
              ) : (
                <Link href={link.href} className={linkClass}>
                  {link.label}
                </Link>
              )
            ) : null}
          </li>
        );
      })}
      {extra.map((message) => (
        <li key={message} className="px-4 py-2.5 text-[14px]">
          {message}
        </li>
      ))}
    </ul>
  );
}

const EXPORT_COLUMNS = {
  columns: "minmax(0,1fr) minmax(9rem,auto)",
  mobileColumns: "minmax(0,1fr)",
};

function ExportRow({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description: ReactNode;
  actions: ReactNode;
  children?: ReactNode;
}) {
  return (
    <TableRow {...EXPORT_COLUMNS} className="py-3">
      <Td>
        <span className="block font-bold">{title}</span>
        <span className="mt-0.5 block text-[13px] text-muted">{description}</span>
        {children}
      </Td>
      <Td>
        <span className="flex flex-wrap items-center gap-2 md:justify-end">{actions}</span>
      </Td>
    </TableRow>
  );
}

function formValues(report: FinancialStatementsReport): StatementSettingsFormValues {
  const { settings } = report;
  return {
    issuedShares: settings.issuedShares === null ? "" : String(settings.issuedShares),
    shareholdersMeetingOn: settings.shareholdersMeetingOn ?? "",
    announcementPublishedOn: settings.announcementPublishedOn ?? "",
    announcementUrl: settings.announcementUrl ?? "",
    notes: {
      ...settings.notes,
      otherNotes: settings.notes.otherNotes.map((note) => ({ title: note.title, body: note.body })),
    },
    businessReport: { ...settings.businessReport },
    simplifiedTaxClass: String(settings.simplifiedTaxClass),
  };
}

const TAX_CLASS_OPTIONS = SIMPLIFIED_TAX_CLASSES.map((taxClass) => ({
  value: String(taxClass),
  label: `${SIMPLIFIED_TAX_CLASS_LABELS[taxClass]}・みなし仕入率 ${DEEMED_PURCHASE_PERCENT[taxClass]}%`,
}));

const CODE_COLUMNS = {
  columns: "minmax(9rem,1.2fr) minmax(7rem,0.9fr) 8.5rem minmax(8rem,1.2fr) minmax(6rem,0.8fr)",
  mobileColumns: "minmax(0,1fr) auto",
};

function safeUrl(url: string | null): string | null {
  return url && /^https?:\/\/[^\s]+$/.test(url) ? url : null;
}

/**
 * 決算書 (17-financial-statements §3): 確認 → 計算書類 → 事業報告・附属明細書 → 書き出し → 勘定科目コード →
 * 決算書の設定, for one fiscal year (`fy`, by default the year being closed).
 */
export default async function StatementsPage({ searchParams }: PageProps<"/closing/statements">) {
  const raw = await searchParams;
  const { prisma, source, today } = await loadStatementsBook();
  const years = [...source.fiscalYears].sort((a, b) => a.no - b.no);
  const fiscalYear = resolveStatementsYear(years, firstParam(raw.fy), today);
  if (!fiscalYear) return <NoFiscalYear title="決算書" />;

  const report = buildFinancialStatements(source, fiscalYear.id, {
    fixedAssets: await loadFixedAssetRegister(prisma, fiscalYear.id),
  });
  const fyNo = fiscalYear.no;
  const etaxProblem = report.empty ? null : etaxCharacterProblem(report);
  const errorKey = firstParam(raw.error);
  const errorMessage =
    errorKey === "etax"
      ? (etaxProblem ?? "財務諸表 CSV を書き出せませんでした。もう一度試してください。")
      : errorKey
        ? STATEMENT_EXPORT_ERRORS[errorKey]
        : undefined;
  const identity = report.issues.filter((issue) => issue.kind === "identity");
  const others = report.issues.filter((issue) => issue.kind !== "identity");
  const pdf = statementExportHref(fyNo, "statements", "pdf");
  const pdfLink = <DownloadLink href={pdf}>PDF</DownloadLink>;
  const { settings, schedules, edition } = report;
  const deadline = announcementDeadline(settings.shareholdersMeetingOn);
  const announcementUrl = safeUrl(settings.announcementUrl);
  const periodText = `自 ${japaneseDate(fiscalYear.startDate)}\u3000至 ${japaneseDate(fiscalYear.endDate)}`;

  return (
    <>
      <PageHeader
        title="決算書"
        meta={`第${fyNo}期 ${formatPeriod(fiscalYear.startDate, fiscalYear.endDate)}`}
        actions={
          <FiscalYearSelect action="/closing/statements" years={years} current={fiscalYear} />
        }
      />
      {report.stateNote ? (
        <p className="-mt-3 mb-5 text-[13px] text-muted">{report.stateNote}</p>
      ) : null}
      {errorMessage ? <AlertBand>{errorMessage}</AlertBand> : null}
      {identity.length > 0 ? (
        <WarningBand messages={identity.map((issue) => issue.message)} />
      ) : null}

      {report.empty ? (
        <div className="mb-8">
          <EmptyState
            title="この期の仕訳がありません"
            description="取引から登録します。"
            action={
              <ButtonLink href="/entries/new" size="sm">
                取引を登録
              </ButtonLink>
            }
          />
        </div>
      ) : (
        <>
          {others.length > 0 || etaxProblem ? (
            <Section id="checks" title="確認">
              <IssueList issues={others} extra={etaxProblem ? [etaxProblem] : []} fyNo={fyNo} />
            </Section>
          ) : null}

          <Section id="statements" title="計算書類" aside="（単位：円）">
            {report.openingBalanceSheet ? (
              <details className="mb-6 rounded-card border border-border px-4 py-3">
                <summary className="cursor-pointer text-[15px] font-bold">
                  開始貸借対照表（成立の日 {formatDate(report.openingBalanceSheet.asOf)}）
                </summary>
                <div className="mt-3">
                  <SubSection
                    title="貸借対照表（成立の日）"
                    aside={asOfLabel(report.openingBalanceSheet.asOf)}
                    actions={
                      <DownloadLink href={statementExportHref(fyNo, "opening", "pdf")}>
                        PDF
                      </DownloadLink>
                    }
                  >
                    <BalanceSheetView
                      sheet={report.openingBalanceSheet}
                      edition={edition}
                      label="開始貸借対照表"
                    />
                  </SubSection>
                </div>
              </details>
            ) : null}
            <SubSection
              title="貸借対照表"
              aside={asOfLabel(report.balanceSheet.asOf)}
              actions={pdfLink}
            >
              <BalanceSheetView sheet={report.balanceSheet} edition={edition} label="貸借対照表" />
            </SubSection>
            <SubSection title="損益計算書" aside={periodText} actions={pdfLink}>
              <IncomeStatementView
                statement={report.incomeStatement}
                matchesTrialBalance={report.checks.netIncomeMatchesTrialBalance}
                trialBalanceNetIncome={report.checks.trialBalanceNetIncome}
              />
            </SubSection>
            <SubSection title="株主資本等変動計算書" aside={periodText} actions={pdfLink}>
              <EquityStatementView statement={report.equityStatement} />
            </SubSection>
            <SubSection title="個別注記表" aside={periodText} actions={pdfLink}>
              <NotesView notes={report.notes} />
            </SubSection>
          </Section>

          <Section id="business-report" title="事業報告・附属明細書">
            <div className="grid gap-6 md:grid-cols-2">
              <SubSection
                title="事業報告"
                actions={
                  <DownloadLink href={statementExportHref(fyNo, "business-report", "pdf")}>
                    PDF
                  </DownloadLink>
                }
              >
                <dl className="flex flex-col gap-2 rounded-card border border-border bg-surface px-4 py-3 text-[14px]">
                  {report.businessReport.sections.map((section) => (
                    <div key={section.heading}>
                      <dt className="text-[13px] font-bold text-muted">{section.heading}</dt>
                      {section.items.map((item, index) => (
                        <dd key={`${section.heading}-${index}`} className="mt-0.5">
                          {item.label ? (
                            <span className="font-semibold">{item.label}: </span>
                          ) : null}
                          <span className="whitespace-pre-line">{item.body}</span>
                        </dd>
                      ))}
                    </div>
                  ))}
                </dl>
              </SubSection>
              <SubSection
                title="附属明細書"
                actions={
                  <DownloadLink href={statementExportHref(fyNo, "schedules", "pdf")}>
                    PDF
                  </DownloadLink>
                }
              >
                <dl className="flex flex-col gap-2 rounded-card border border-border bg-surface px-4 py-3 text-[14px]">
                  <div>
                    <dt className="text-[13px] font-bold text-muted">
                      有形固定資産及び無形固定資産の明細
                    </dt>
                    <dd className="mt-0.5">
                      {schedules.fixedAssets.message ??
                        `期末帳簿価額 ${formatStatementAmount(
                          schedules.fixedAssets.tangible.closingBookValue +
                            schedules.fixedAssets.intangible.closingBookValue,
                        )} 円（${schedules.fixedAssets.rows.length} 種類）`}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[13px] font-bold text-muted">引当金の明細</dt>
                    <dd className="mt-0.5">
                      {schedules.provisions.message ??
                        schedules.provisions.rows
                          .map((row) => `${row.label} ${formatStatementAmount(row.closing)} 円`)
                          .join("、")}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[13px] font-bold text-muted">販売費及び一般管理費の明細</dt>
                    <dd className="mt-0.5">
                      {schedules.sga.rows.length} 科目・合計{" "}
                      <span className="num">{formatStatementAmount(schedules.sga.total)}</span> 円
                      <span
                        className={`ml-2 text-[12px] ${
                          schedules.sga.matchesIncomeStatement ? "text-muted-2" : "text-warn"
                        }`}
                      >
                        {schedules.sga.matchesIncomeStatement
                          ? "損益計算書と一致"
                          : "損益計算書と合いません"}
                      </span>
                    </dd>
                  </div>
                </dl>
                {schedules.sga.rows.length > 0 ? (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-[13px] font-bold text-muted">
                      販売費及び一般管理費の内訳
                    </summary>
                    <div className="mt-2">
                      <AmountRows
                        label="販売費及び一般管理費の明細"
                        rows={schedules.sga.rows.map((row) => ({
                          key: row.accountId,
                          label: row.label,
                          amount: row.amount,
                        }))}
                        total={{ label: "合計", amount: schedules.sga.total }}
                      />
                    </div>
                  </details>
                ) : null}
              </SubSection>
            </div>
          </Section>

          <Section id="exports" title="書き出し">
            <Table label="書き出し">
              <TableHead {...EXPORT_COLUMNS}>
                <Th>書類</Th>
                <Th align="right">形式</Th>
              </TableHead>
              <ExportRow
                title="計算書類"
                description="貸借対照表・損益計算書・株主資本等変動計算書・個別注記表・附属明細書・事業報告を 1 つの PDF にします。株主総会の承認と保存に使います。"
                actions={
                  <DownloadLink href={pdf} primary>
                    PDF
                  </DownloadLink>
                }
              />
              {report.openingBalanceSheet ? (
                <ExportRow
                  title="開始貸借対照表"
                  description={`成立の日（${formatDate(report.openingBalanceSheet.asOf)}）現在の貸借対照表です。`}
                  actions={
                    <DownloadLink href={statementExportHref(fyNo, "opening", "pdf")}>
                      PDF
                    </DownloadLink>
                  }
                />
              ) : null}
              <ExportRow
                title="財務諸表 CSV（e-Tax）"
                description={`e-Tax ソフトの「財務諸表等の組み込み」で読み込みます。提出前に国税庁の CSV ファイルチェックコーナーで確かめます（手順は ${FILING_GUIDE}）。`}
                actions={
                  <DownloadLink href={statementExportHref(fyNo, "etax", "zip")} primary>
                    zip
                  </DownloadLink>
                }
              >
                <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                  <span className="text-muted">種類ごとの CSV:</span>
                  {ETAX_STATEMENTS.map((statement) => (
                    <a
                      key={statement}
                      href={statementExportHref(fyNo, "etax", "csv", statement)}
                      className="font-bold text-primary-ink hover:underline"
                    >
                      {ETAX_STATEMENT_NAMES[statement]}
                    </a>
                  ))}
                </span>
                {etaxProblem ? (
                  <span role="alert" className="mt-1.5 block text-[13px] font-bold text-warn">
                    {etaxProblem}
                  </span>
                ) : null}
              </ExportRow>
              <ExportRow
                title="勘定科目内訳の元データ"
                description="税理士が勘定科目内訳明細書を作るための元データです（科目・補助科目・取引先ごとの残高と動き）。"
                actions={
                  <DownloadLink href={statementExportHref(fyNo, "account-details", "csv")}>
                    CSV
                  </DownloadLink>
                }
              />
              <ExportRow
                title="消費税の集計"
                description={
                  <>
                    税区分ごとの売上・仕入と、本則課税・簡易課税の概算です。
                    <Link
                      href={consumptionTaxHref(fyNo)}
                      className="ml-1 font-bold text-primary-ink hover:underline"
                    >
                      画面で見る
                    </Link>
                  </>
                }
                actions={
                  <DownloadLink href={statementExportHref(fyNo, "consumption-tax", "csv")}>
                    CSV
                  </DownloadLink>
                }
              />
              <ExportRow
                title="決算公告"
                description={`電子公告で会社のサイトに載せる HTML です（貸借対照表の全文と注記）。置く手順は ${FILING_GUIDE} にあります。`}
                actions={
                  <DownloadLink href={statementExportHref(fyNo, "announcement", "html")}>
                    HTML
                  </DownloadLink>
                }
              >
                <span className="mt-1.5 block text-[13px]">
                  {deadline
                    ? `掲載期限: ${formatDate(deadline)}（株主総会の日 ${formatDate(settings.shareholdersMeetingOn)} の 5 年後の日）`
                    : "掲載期限: 決算書の設定に株主総会の日を入れると出します"}
                </span>
                {announcementUrl ? (
                  <span className="mt-0.5 block text-[13px]">
                    掲載先:{" "}
                    <a
                      href={announcementUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all text-primary-ink hover:underline"
                    >
                      {announcementUrl}
                    </a>
                  </span>
                ) : null}
              </ExportRow>
            </Table>
          </Section>

          <section id="codes" className="pb-8">
            <details className="rounded-card border border-border px-4 py-3">
              <summary className="cursor-pointer">
                <span className="text-[16px] font-extrabold">勘定科目コード</span>
                <span className="ml-3 text-[12px] text-muted">{edition.label}</span>
              </summary>
              <p className="mt-2 mb-3 text-[13px] text-muted">
                この期に使う勘定科目コード表は{edition.label}です。上書きは
                <Link href="/settings/accounts" className="mx-1 font-bold text-primary-ink">
                  設定 › 勘定科目
                </Link>
                で行います。
              </p>
              <Table label="勘定科目コード">
                <TableHead {...CODE_COLUMNS}>
                  <Th>科目</Th>
                  <Th sm="hide">区分</Th>
                  <Th>勘定科目コード</Th>
                  <Th sm="hide">コード表の科目名</Th>
                  <Th sm="hide">出どころ</Th>
                </TableHead>
                {report.codeViews.map((view) => (
                  <TableRow key={view.accountId} {...CODE_COLUMNS}>
                    <Td>
                      <span className="num mr-2 text-muted">{view.accountCode}</span>
                      {view.accountName}
                    </Td>
                    <Td sm="hide" className="text-[13px] text-muted">
                      {view.groupLabel}
                    </Td>
                    <Td className="num text-[13px]">{view.displayCode}</Td>
                    <Td sm="hide" className="text-[13px]">
                      {view.tableLabel}
                    </Td>
                    <Td sm="hide" className="text-[13px] text-muted">
                      {view.originLabel}
                      {view.note ? (
                        <span className="mt-0.5 block text-[12px] text-warn">{view.note}</span>
                      ) : null}
                    </Td>
                  </TableRow>
                ))}
              </Table>
            </details>
          </section>
        </>
      )}

      <Section
        id="settings"
        title="決算書の設定"
        aside={`第${fyNo}期の注記・事業報告の文と日付（数字は変わりません）`}
      >
        <StatementSettingsForm
          key={fiscalYear.id}
          fiscalYearId={fiscalYear.id}
          initial={formValues(report)}
          hints={{
            issuedSharesFromEarlierYear: settings.issuedSharesFromEarlierYear,
            deadline: deadline ? formatDate(deadline) : null,
            notesFromTemplate: settings.notesFromTemplate,
            businessReportFromTemplate: settings.businessReportFromTemplate,
          }}
          taxClassOptions={TAX_CLASS_OPTIONS}
        />
      </Section>
    </>
  );
}

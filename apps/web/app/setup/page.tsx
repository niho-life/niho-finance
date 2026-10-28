import {
  getCompany,
  listAccounts,
  listFiscalYears,
  listSegmentOptions,
  listTaxCategoryOptions,
  listWallets,
  loadOpeningEntries,
  loadTrialBalance,
  previewOpeningEntries,
  proposeFirstFiscalYear,
  type PrismaClient,
  type SetupProgress,
} from "@niho-finance/db";
import {
  ACCOUNT_KIND_LABELS,
  ACCOUNTING_METHOD_LABELS,
  CHART_TEMPLATE,
  CONSUMPTION_TAX_METHOD_LABELS,
  formatYen,
  STANDARD_SEGMENTS,
  STANDARD_TAX_RATE_RULES,
  TAX_CATEGORIES,
  WALLET_DEFAULT_ACCOUNT_CODES,
  WALLET_KIND_LABELS,
} from "@niho-finance/ledger";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ActionButton } from "@/components/settings/action-button";
import { CompanyForm } from "@/components/settings/company-form";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { attempt } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { db, loadSetupProgress } from "@/lib/data";
import { formatPeriod } from "@/lib/format";
import { toCompanyFormValues } from "@/lib/form-values";
import { toOpeningPreviewView, type OpeningPreviewView } from "@/lib/opening-view";
import { ChartPreview } from "./_components/chart-preview";
import { FiscalYearStep } from "./_components/fiscal-year-step";
import { OpeningStep } from "./_components/opening-step";
import { OpeningEntriesTable } from "./_components/opening-table";
import { SetupProgressBar } from "./_components/progress";
import { WalletsStep } from "./_components/wallets-step";
import { bootstrapStandardDataAction, saveCompanyStepAction, skipOpeningAction } from "./actions";
import { isReachable, stepFromSlug, stepHref, type WizardStep } from "./steps";

const HEADINGS: Record<WizardStep, { title: string; lead: string }> = {
  company: {
    title: "事業所",
    lead: "会社の基本情報を登録します。法人番号とインボイス登録番号はあとからでも入れられます。",
  },
  fiscal_year: {
    title: "会計期間",
    lead: "設立日と決算月から第 1 期を作ります。",
  },
  accounts: {
    title: "勘定科目",
    lead: "標準の勘定科目で帳簿を作ります。科目はあとから追加・無効にできます。",
  },
  wallets: {
    title: "口座",
    lead: "お金が出入りする口座を登録します。口座ごとに勘定科目と補助科目が決まります。",
  },
  opening: {
    title: "開始仕訳",
    lead: "設立時の資本金の払込と、設立・開業の費用を登録します。",
  },
  complete: {
    title: "初期設定が終わりました",
    lead: "試算表で、登録した開始仕訳の貸借が一致していることを確かめてください。",
  },
};

/**
 * The setup wizard (10 §3): `/setup` opens the first step that is not done, `/setup?step=…` a
 * step that can be reached. Progress is derived from the database, so the wizard resumes.
 */
export default async function SetupPage({ searchParams }: PageProps<"/setup">) {
  const { step: slug } = await searchParams;
  const progress = await loadSetupProgress();
  const requested = stepFromSlug(slug);
  let step: WizardStep;
  if (requested === null) {
    if (progress.current === "complete") redirect("/");
    step = progress.current;
  } else if (isReachable(requested, progress)) {
    step = requested;
  } else {
    redirect(progress.current === "complete" ? "/" : stepHref(progress.current));
  }

  const prisma = await db();
  const heading = HEADINGS[step];
  return (
    <>
      <SetupProgressBar current={step} progress={progress} />
      <section className="rounded-card border border-border bg-surface px-5 py-6 md:px-7">
        <h1 className="text-[20px] font-extrabold">{heading.title}</h1>
        <p className="mt-1 mb-6 text-[14px] text-muted">{heading.lead}</p>
        <StepContent step={step} prisma={prisma} progress={progress} />
      </section>
    </>
  );
}

function StepContent({
  step,
  prisma,
  progress,
}: {
  step: WizardStep;
  prisma: PrismaClient;
  progress: SetupProgress;
}): ReactNode {
  switch (step) {
    case "company":
      return <CompanyStep prisma={prisma} />;
    case "fiscal_year":
      return <FiscalYearStepContent prisma={prisma} />;
    case "accounts":
      return <AccountsStep prisma={prisma} done={progress.done.accounts} />;
    case "wallets":
      return <WalletsStepContent prisma={prisma} />;
    case "opening":
      return <OpeningStepContent prisma={prisma} />;
    case "complete":
      return <DoneStep prisma={prisma} />;
  }
}

function NextLink({ step, label = "次へ" }: { step: WizardStep; label?: string }) {
  return (
    <div className="mt-6 flex justify-end">
      <ButtonLink href={stepHref(step)} variant="primary">
        {label}
      </ButtonLink>
    </div>
  );
}

async function CompanyStep({ prisma }: { prisma: PrismaClient }) {
  const company = await getCompany(prisma);
  const fiscalYears = await listFiscalYears(prisma);
  return (
    <CompanyForm
      action={saveCompanyStepAction}
      initial={toCompanyFormValues(company)}
      locked={fiscalYears.length > 0}
      submitLabel="次へ"
      showRegisteredOn={false}
    />
  );
}

async function FiscalYearStepContent({ prisma }: { prisma: PrismaClient }) {
  const company = await getCompany(prisma);
  if (!company) redirect(stepHref("company"));
  const [first] = await listFiscalYears(prisma);
  if (first) {
    return (
      <>
        <dl className="grid gap-4 md:grid-cols-3">
          <div>
            <dt className="text-[12px] font-bold text-muted">第 1 期</dt>
            <dd className="num mt-1 font-bold">{formatPeriod(first.startDate, first.endDate)}</dd>
          </div>
          <div>
            <dt className="text-[12px] font-bold text-muted">消費税の区分</dt>
            <dd className="mt-1 font-bold">
              {CONSUMPTION_TAX_METHOD_LABELS[first.consumptionTax]}
            </dd>
          </div>
          <div>
            <dt className="text-[12px] font-bold text-muted">経理方式</dt>
            <dd className="mt-1 font-bold">{ACCOUNTING_METHOD_LABELS[first.accountingMethod]}</dd>
          </div>
        </dl>
        <p className="mt-4 text-[13px] text-muted">
          作成済みです。期間は変えられません。消費税の区分と経理方式は 設定 › 会計期間
          で変えられます。
        </p>
        <NextLink step="accounts" />
      </>
    );
  }
  return (
    <FiscalYearStep
      startDate={company.foundedOn}
      proposedEndDate={proposeFirstFiscalYear(company).endDate}
      fiscalYearEndMonth={company.fiscalYearEndMonth}
    />
  );
}

async function AccountsStep({ prisma, done }: { prisma: PrismaClient; done: boolean }) {
  if (done) {
    const accounts = (await listAccounts(prisma)).filter((account) => account.isActive);
    return (
      <>
        <ChartPreview accounts={accounts} />
        <p className="mt-4 text-[13px] text-muted">
          作成済みです（{accounts.length} 科目）。追加・名前の変更・無効化は 設定 › 勘定科目
          で行います。
        </p>
        <NextLink step="wallets" />
      </>
    );
  }
  return (
    <>
      <ChartPreview accounts={CHART_TEMPLATE} />
      <p className="mt-4 text-[13px] text-muted">
        {CHART_TEMPLATE.length} 科目と、税区分 {TAX_CATEGORIES.length}・税率規則{" "}
        {STANDARD_TAX_RATE_RULES.length}・セグメント {STANDARD_SEGMENTS.length}
        （プラットフォーム・鎌倉・受託・共通）を作ります。すでにあるものはそのままです。
      </p>
      <div className="mt-6 flex justify-end">
        <ActionButton
          action={bootstrapStandardDataAction}
          label="この内容で作成"
          pendingLabel="作成中…"
        />
      </div>
    </>
  );
}

async function WalletsStepContent({ prisma }: { prisma: PrismaClient }) {
  const wallets = await listWallets(prisma);
  if (wallets.length > 0) {
    const columns = {
      columns: "minmax(0,1.2fr) 100px minmax(0,1.2fr)",
      mobileColumns: "minmax(0,1fr) auto",
    };
    return (
      <>
        <Table label="口座">
          <TableHead {...columns}>
            <Th>名前</Th>
            <Th>種類</Th>
            <Th>紐づく科目・補助科目</Th>
          </TableHead>
          {wallets.map((wallet) => (
            <TableRow key={wallet.id} {...columns} muted={!wallet.isActive}>
              <Td className="font-bold">{wallet.name}</Td>
              <Td>{WALLET_KIND_LABELS[wallet.kind]}</Td>
              <Td sm="full" className="text-muted">
                {wallet.accountCode} {wallet.accountName}
                {wallet.subAccountName ? ` / ${wallet.subAccountName}` : ""}
              </Td>
            </TableRow>
          ))}
        </Table>
        <p className="mt-4 text-[13px] text-muted">
          登録済みです。口座の追加・変更は 設定 › 口座 で行います。
        </p>
        <NextLink step="opening" />
      </>
    );
  }
  const accounts = await listAccounts(prisma);
  const accountNames: Record<string, string> = {};
  for (const code of Object.values(WALLET_DEFAULT_ACCOUNT_CODES)) {
    const account = code ? accounts.find((item) => item.code === code) : undefined;
    if (code && account) accountNames[code] = account.name;
  }
  return <WalletsStep segments={await listSegmentOptions(prisma)} accountNames={accountNames} />;
}

async function OpeningStepContent({ prisma }: { prisma: PrismaClient }) {
  const registered = await loadOpeningEntries(prisma);
  if (registered.entries.length > 0) {
    return (
      <>
        <OpeningEntriesTable preview={toOpeningPreviewView(registered)} />
        <p className="mt-4 text-[13px] text-muted">
          登録済みです。登録した仕訳は書き換えられません。直しは取引の訂正（反対仕訳）で行います（取引の画面は準備中）。
        </p>
        <NextLink step="complete" />
      </>
    );
  }

  const company = await getCompany(prisma);
  if (!company) redirect(stepHref("company"));
  const wallets = (await listWallets(prisma)).filter((wallet) => wallet.isActive);
  const deposits = wallets.filter((wallet) => wallet.accountIsCashLike);
  const deposit = deposits.find((wallet) => wallet.kind === "bank") ?? deposits[0];
  if (!deposit) {
    return (
      <EmptyState
        title="資本金の入金先になる口座がありません"
        description="銀行の口座を登録してから開始仕訳を登録します。開始仕訳はあとで登録することもできます。"
        action={
          <>
            <ButtonLink href={stepHref("wallets")} variant="primary">
              口座を登録
            </ButtonLink>
            <ActionButton action={skipOpeningAction} label="あとで" variant="secondary" />
          </>
        }
      />
    );
  }

  const option = (wallet: (typeof wallets)[number]) => ({
    value: wallet.id,
    label: `${wallet.name}（${wallet.accountName}）`,
  });
  const owner = wallets.find((wallet) => wallet.kind === "owner");
  const payerOptions = [
    ...(owner ? [] : [{ value: "", label: "役員立替（役員借入金）" }]),
    ...wallets.map(option),
  ];
  const initial = await attempt(() =>
    previewOpeningEntries(prisma, {
      capital: { date: company.foundedOn, amount: "50000", walletId: deposit.id },
      formationCosts: [],
      startupCosts: [],
    }),
  );
  const initialPreview: ActionResult<OpeningPreviewView> = initial.ok
    ? { ok: true, data: toOpeningPreviewView(initial.data) }
    : initial;
  return (
    <OpeningStep
      foundedOn={company.foundedOn}
      wallets={deposits.map(option)}
      payerOptions={payerOptions}
      taxOptions={await listTaxCategoryOptions(prisma, { directions: ["purchase", "none"] })}
      defaultCapitalWalletId={deposit.id}
      defaultPayerWalletId={owner?.id ?? ""}
      initialPreview={initialPreview}
    />
  );
}

async function DoneStep({ prisma }: { prisma: PrismaClient }) {
  const [first] = await listFiscalYears(prisma);
  if (!first) redirect(stepHref("fiscal_year"));
  const tb = await loadTrialBalance(prisma, first.id);
  const names = new Map((await listAccounts(prisma)).map((account) => [account.id, account]));
  const { totals } = tb;
  const balanced = totals.assets === totals.liabilities + totals.equity + totals.netIncome;
  const tiles = [
    { label: "資産", value: totals.assets },
    { label: "負債", value: totals.liabilities },
    { label: "純資産", value: totals.equity },
    { label: "当期純利益", value: totals.netIncome },
  ];
  const rows = tb.rows.filter((row) => row.balance !== 0n);
  const columns = { columns: "56px minmax(0,1fr) 72px 120px", mobileColumns: "minmax(0,1fr) auto" };
  return (
    <>
      <h2 className="mb-2 text-[13px] font-bold text-muted">
        試算表 · 第 {first.no} 期 {formatPeriod(first.startDate, first.endDate)}
      </h2>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-[10px] border border-border px-3.5 py-3">
            <dt className="text-[12px] text-muted">{tile.label}</dt>
            <dd className="num mt-0.5 text-[20px] font-extrabold">{formatYen(tile.value)}</dd>
          </div>
        ))}
      </dl>
      <p className={`mt-3 text-[13px] font-bold ${balanced ? "text-primary-ink" : "text-danger"}`}>
        {balanced
          ? "資産 = 負債 + 純資産 + 当期純利益 で一致しています"
          : "資産と負債・純資産が一致しません。開始仕訳を確かめてください"}
      </p>
      {rows.length > 0 ? (
        <div className="mt-4">
          <Table label="科目ごとの残高">
            <TableHead {...columns}>
              <Th>コード</Th>
              <Th>科目</Th>
              <Th>区分</Th>
              <Th align="right">残高（円）</Th>
            </TableHead>
            {rows.map((row) => (
              <TableRow key={row.accountId} {...columns}>
                <Td sm="hide" className="num text-muted">
                  {row.code}
                </Td>
                <Td>{names.get(row.accountId)?.name ?? row.code}</Td>
                <Td sm="hide" className="text-muted">
                  {ACCOUNT_KIND_LABELS[row.kind]}
                </Td>
                <Td align="right" className="font-bold">
                  {formatYen(row.balance)}
                </Td>
              </TableRow>
            ))}
          </Table>
        </div>
      ) : (
        <p className="mt-4 text-[13px] text-muted">
          まだ仕訳がありません。開始仕訳はホームの「やること」から登録できます。
        </p>
      )}
      <div className="mt-6 flex justify-end">
        <ButtonLink href="/" variant="primary">
          ホームへ
        </ButtonLink>
      </div>
    </>
  );
}

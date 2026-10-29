import {
  BANK_TOKEN_KEY_VARIABLE,
  getBankLink,
  listLinkableBankAccounts,
  listWallets,
  resolveBankApiConfig,
  resolveBankTokenKey,
  SettingsError,
  type BankApiStatus,
  type BankLinkSettings,
  type ImportBatchSummary,
  type PrismaClient,
} from "@niho-finance/db";
import { GMO_AOZORA_ENVIRONMENT_LABELS, type GmoAozoraEnvironment } from "@niho-finance/importers";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { firstLine } from "@/app/(app)/imports/_lib/format";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { isBankReturnCode, type BankReturnCode } from "@/lib/bank/oauth-routes";
import { db } from "@/lib/data";
import { formatAmountDisplay, formatDate, formatDateTime } from "@/lib/format";
import { BankAccountChoice, BankLinkActions, ConnectBankControl } from "./bank-forms";
import { BankOutcomeBanner, type BankOutcome } from "./feedback";
import type { BankAccountOption } from "./types";

export const metadata: Metadata = { title: "銀行 API の接続" };

const HISTORY_COLUMNS = {
  columns: "136px minmax(0,1fr) 120px minmax(0,1.2fr)",
  mobileColumns: "minmax(0,1fr) auto",
};

/** Where the bank API stands in this environment (19-bank-api §2.1, §5). */
type BankSetup =
  | { ok: true; mode: "token" | "oauth"; env: GmoAozoraEnvironment }
  | { ok: false; title: string; message: string | null; variables: string[] };

const UNSET_TITLE = "銀行 API が設定されていません。環境変数を設定してから接続する";

function bankSetup(): BankSetup {
  const resolved = resolveBankApiConfig();
  if (!resolved.ok) {
    if (resolved.reason === "unset") {
      return {
        ok: false,
        title: UNSET_TITLE,
        // 「銀行 API が設定されていません」 says nothing the title does not.
        message: UNSET_TITLE.startsWith(resolved.message) ? null : resolved.message,
        variables: resolved.variables,
      };
    }
    return {
      ok: false,
      title: "銀行 API の設定が正しくありません。環境変数を直してから接続する",
      message: resolved.message,
      variables: resolved.variables,
    };
  }
  // The authorization code flow seals the tokens it gets: without the key nothing can be saved.
  if (resolved.config.mode === "oauth" && resolveBankTokenKey() === null) {
    return {
      ok: false,
      title: UNSET_TITLE,
      message: "銀行の認可で受け取るトークンを暗号化する鍵がありません",
      variables: [BANK_TOKEN_KEY_VARIABLE],
    };
  }
  return { ok: true, mode: resolved.config.mode, env: resolved.config.env };
}

/** How the bank's authorization ended (`?bank=…`, 19-bank-api §2.2): a fixed text per code. */
function returnNotice(
  code: BankReturnCode | null,
  status: BankApiStatus | null,
): BankOutcome | null {
  switch (code) {
    case "authorized":
      if (status === "connected") {
        return {
          tone: "success",
          text: "銀行 API に再接続しました。次の同期は前回の続きから取り込みます",
        };
      }
      return status === "authorized"
        ? { tone: "success", text: "銀行の認可が完了しました。接続する口座を選んでください" }
        : null;
    case "denied":
      return {
        tone: "error",
        text: "銀行の認可が完了しませんでした。接続するには、もう一度「接続する」から始めます",
      };
    case "invalid":
      return {
        tone: "error",
        text: "銀行の応答を確かめられませんでした。接続していません。もう一度「接続する」から始めます",
      };
    case "failed":
      return {
        tone: "error",
        text: "銀行の認可を完了できませんでした。時間をおいて、もう一度「接続する」から始めます",
      };
    case "unavailable":
      return {
        tone: "error",
        text: "銀行の認可を始められませんでした。口座が有効か、銀行 API の環境変数が揃っているかを確かめてください",
      };
    case null:
      return null;
  }
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mb-8">
      <h2 id={id} className="mb-3 text-[15px] font-extrabold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A row of the state table: heading and value side by side on PC, one above the other at 320px. */
function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border py-2 last:border-b-0 sm:grid sm:grid-cols-[144px_minmax(0,1fr)] sm:gap-3">
      <dt className="text-[12px] font-bold text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-[14px]">{children}</dd>
    </div>
  );
}

function envLabel(env: GmoAozoraEnvironment | null): string {
  return env === null ? "—" : GMO_AOZORA_ENVIRONMENT_LABELS[env];
}

const STATUS_LABELS: Readonly<Record<BankApiStatus, string>> = {
  authorized: "口座の選択待ち",
  connected: "接続済み",
  reauth_required: "再接続が必要",
};

/**
 * 状態 (19-bank-api §1.1): 接続・口座・環境・最終同期・取得済みの期間・銀行の残高, and the reason
 * of the last failure unless the 再接続 band above already shows it (`reasonShown`).
 */
function StatusTable({
  link,
  setup,
  reasonShown,
}: {
  link: BankLinkSettings;
  setup: BankSetup;
  reasonShown: boolean;
}) {
  const otherEnvironment = setup.ok && link.env !== null && link.env !== setup.env;
  return (
    <dl className="mb-4 max-w-2xl">
      {link.status ? (
        <Item label="接続">
          {link.status === "reauth_required" ? (
            <span className="font-bold text-warn">{STATUS_LABELS[link.status]}</span>
          ) : (
            STATUS_LABELS[link.status]
          )}
        </Item>
      ) : null}
      <Item label="口座">{link.accountLabel ?? <span className="text-muted">未選択</span>}</Item>
      <Item label="環境">
        {envLabel(link.env)}
        {otherEnvironment ? (
          <span className="mt-0.5 block text-[13px] font-bold text-warn">
            今の環境は {envLabel(setup.env)} です。同期するには再接続します
          </span>
        ) : null}
      </Item>
      {link.status === "authorized" ? null : (
        <>
          <Item label="最終同期">
            {link.lastSyncedAt ? (
              <span className="num">{formatDateTime(link.lastSyncedAt)}</span>
            ) : (
              <span className="text-muted">まだ同期していません</span>
            )}
          </Item>
          <Item label="取得済みの期間">
            <span className="num">
              {link.syncedThrough ? `〜 ${formatDate(link.syncedThrough)}` : "—"}
            </span>
          </Item>
          <Item label="銀行の残高（円）">
            {link.balance !== null ? (
              <>
                <span className="num font-bold">{formatAmountDisplay(link.balance)}</span>
                {link.balanceDate ? (
                  <span className="num ml-2 text-[13px] text-muted">
                    {formatDate(link.balanceDate)} 時点
                  </span>
                ) : null}
              </>
            ) : (
              "—"
            )}
          </Item>
          {link.error && !reasonShown ? (
            <Item label="直近の失敗">
              <span className="text-[13px] text-danger">{firstLine(link.error)}</span>
            </Item>
          ) : null}
        </>
      )}
    </dl>
  );
}

function SetupNotice({ setup }: { setup: Extract<BankSetup, { ok: false }> }) {
  return (
    <div className="mb-8 flex max-w-2xl flex-col gap-2 rounded-card border border-border px-5 py-4">
      <p className="text-[15px] font-bold">{setup.title}</p>
      {setup.message ? <p className="text-[14px]">{setup.message}</p> : null}
      <div className="text-[13px] text-muted">
        <p>
          {setup.variables.length > 1
            ? "設定する環境変数（どれか、または全部）"
            : "設定する環境変数"}
        </p>
        <ul className="mt-1 flex flex-col gap-0.5">
          {setup.variables.map((name) => (
            <li key={name}>
              <code className="break-all font-mono text-[13px] text-text">{name}</code>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** 期間: `2026/11/01 – 2026/11/30`. */
function batchPeriod(batch: ImportBatchSummary): string {
  if (!batch.periodFrom || !batch.periodTo) return "—";
  return batch.periodFrom === batch.periodTo
    ? formatDate(batch.periodFrom)
    : `${formatDate(batch.periodFrom)} – ${formatDate(batch.periodTo)}`;
}

function BatchStatus({ batch }: { batch: ImportBatchSummary }) {
  if (!batch.error) return <span className="text-muted">完了</span>;
  const reason = firstLine(batch.error);
  return (
    <span className="block min-w-0 truncate" title={reason}>
      <span className="font-bold text-danger">失敗</span>
      {/* Phones keep the status column narrow (`auto`): the reason is on the batch's result. */}
      <span className="ml-1.5 hidden text-[12px] text-muted md:inline">{reason}</span>
    </span>
  );
}

/**
 * 直近の同期 (19-bank-api §1.1): the latest 5 bank API batches. PC: 日時・期間・新規 / 重複 / 失敗・
 * 状態; phones: 日時 and 状態, then 期間 and the counts. A row opens the batch's result.
 */
function RecentSyncs({ batches }: { batches: readonly ImportBatchSummary[] }) {
  if (batches.length === 0) {
    return (
      <p className="text-[13px] text-muted">
        まだ履歴がありません。新規 0 件の同期は履歴を作らないので、最終同期の日時で確かめます。
      </p>
    );
  }
  return (
    <>
      <Table label="直近の同期">
        <TableHead {...HISTORY_COLUMNS}>
          <Th>日時</Th>
          <Th sm="hide">期間</Th>
          <Th sm="hide" align="right">
            新規 / 重複 / 失敗
          </Th>
          <Th>状態</Th>
        </TableHead>
        {batches.map((batch) => (
          <TableRow key={batch.id} {...HISTORY_COLUMNS} className="relative hover:bg-black/[0.02]">
            <Td className="text-[13px]">
              <Link
                href={`/imports/${batch.id}`}
                className="num font-semibold after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-sm focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-primary"
              >
                {formatDateTime(batch.executedAt)}
              </Link>
            </Td>
            <Td sm="hide" className="num truncate text-[13px] text-muted">
              {batchPeriod(batch)}
            </Td>
            <Td sm="hide" align="right">
              {batch.importedCount} / {batch.duplicateCount} / {batch.failedCount}
            </Td>
            <Td className="text-[13px]">
              <BatchStatus batch={batch} />
            </Td>
            <span
              role="cell"
              data-sm="full"
              className="num min-w-0 truncate text-[12px] text-muted md:hidden"
            >
              {batchPeriod(batch)} · 新規 {batch.importedCount}・重複 {batch.duplicateCount}・失敗{" "}
              {batch.failedCount}
            </span>
          </TableRow>
        ))}
      </Table>
    </>
  );
}

/** 口座の選択: the bank's accounts for the wallet's authorization, or why they cannot be listed. */
async function linkableAccounts(
  prisma: PrismaClient,
  walletId: string,
): Promise<{ ok: true; accounts: BankAccountOption[] } | { ok: false; error: string }> {
  try {
    const accounts = await listLinkableBankAccounts(prisma, { walletId });
    return {
      ok: true,
      accounts: accounts.map(({ accountId, label, linkedWalletName }) => ({
        accountId,
        label,
        linkedWalletName,
      })),
    };
  } catch (error) {
    if (error instanceof SettingsError) return { ok: false, error: error.message };
    throw error;
  }
}

/**
 * 銀行 API の接続 (19-bank-api §1.1): the connection of a bank wallet to its account at GMO
 * あおぞらネット銀行. From the top: the outcome of the last operation, 状態, 操作, 直近の同期.
 * The bank's account ID and the tokens never reach the page (the account ID only as a radio's
 * value).
 */
export default async function BankLinkPage({
  params,
  searchParams,
}: PageProps<"/settings/wallets/[walletId]/bank">) {
  const { walletId } = await params;
  const { bank } = await searchParams;
  const prisma = await db();
  const wallet = (await listWallets(prisma)).find((item) => item.id === walletId);
  if (!wallet || wallet.kind !== "bank") notFound();
  const link = await getBankLink(prisma, wallet.id);
  if (!link) notFound();

  const setup = bankSetup();
  const notice = returnNotice(isBankReturnCode(bank) ? bank : null, link.status);
  const usable = wallet.isActive && setup.ok;
  const mode = setup.ok ? setup.mode : "token";
  const choice =
    usable && link.status === "authorized" ? await linkableAccounts(prisma, wallet.id) : null;
  const connectedOrLapsed = link.status === "connected" || link.status === "reauth_required";
  const reauthBand = usable && link.status === "reauth_required";

  return (
    <>
      <PageHeader
        title="銀行 API の接続"
        meta={wallet.name}
        back={{ href: "/settings/wallets", label: "口座" }}
      />
      <BankOutcomeBanner notice={notice} />

      {!wallet.isActive ? (
        <div className="mb-8">
          <EmptyState
            title="この口座は無効です"
            description="設定 › 口座 で有効にすると、接続・同期できます"
            action={
              <ButtonLink href="/settings/wallets" size="sm">
                口座の設定を開く
              </ButtonLink>
            }
          />
        </div>
      ) : !setup.ok ? (
        <SetupNotice setup={setup} />
      ) : null}

      {usable && link.status === null ? (
        <Section id="bank-connect" title="接続">
          <p className="mb-4 max-w-2xl text-[14px]">
            GMO あおぞらネット銀行の API で入出金明細を毎日取り込みます。接続すると CSV
            の取込は要りません。
          </p>
          <ConnectBankControl
            walletId={wallet.id}
            walletName={wallet.name}
            mode={mode}
            label="接続する"
          />
        </Section>
      ) : null}

      {reauthBand ? (
        <div
          role="alert"
          className="mb-8 flex max-w-2xl flex-col gap-2 rounded-card bg-warn-soft px-4 py-3 text-[14px] text-warn"
        >
          <p className="font-bold">
            銀行 API の認可が切れています。再接続すると、前回の続きから取り込みます
          </p>
          {link.error ? <p className="text-[13px] break-words">{firstLine(link.error)}</p> : null}
          {mode === "token" ? (
            <p className="text-[13px]">
              sunabar
              にログインしてトークンを確かめ、環境変数を差し替えてから「再接続する」を押します
            </p>
          ) : null}
          <div className="mt-1">
            <ConnectBankControl
              walletId={wallet.id}
              walletName={wallet.name}
              mode={mode}
              label="再接続する"
            />
          </div>
        </div>
      ) : null}

      {link.status !== null ? (
        <Section id="bank-status" title="状態">
          <StatusTable link={link} setup={setup} reasonShown={reauthBand} />
          {connectedOrLapsed || !usable ? (
            <BankLinkActions
              walletId={wallet.id}
              walletName={wallet.name}
              sync={usable && link.status === "connected"}
            />
          ) : null}
          {link.status === "connected" ? (
            <p className="mt-3 max-w-2xl text-[12px] text-muted">
              接続中は CSV の取込は要りません。銀行 API で取り込んだ期間の CSV
              を取り込むと、明細が二重になります。
            </p>
          ) : null}
        </Section>
      ) : null}

      {choice ? (
        <Section id="bank-account" title="口座の選択">
          {!choice.ok ? (
            <div className="flex max-w-2xl flex-col gap-3">
              <p
                role="alert"
                className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger"
              >
                {choice.error}
              </p>
              <ConnectBankControl
                walletId={wallet.id}
                walletName={wallet.name}
                mode={mode}
                label="再接続する"
              />
            </div>
          ) : choice.accounts.length === 0 ? (
            <p className="text-[14px]">接続できる円普通預金の口座がありません</p>
          ) : (
            <BankAccountChoice
              walletId={wallet.id}
              walletName={wallet.name}
              accounts={choice.accounts}
            />
          )}
          <div className="mt-6">
            <BankLinkActions walletId={wallet.id} walletName={wallet.name} sync={false} />
          </div>
        </Section>
      ) : null}

      {link.status !== null || link.recentBatches.length > 0 ? (
        <Section id="bank-history" title="直近の同期">
          <RecentSyncs batches={link.recentBatches} />
        </Section>
      ) : null}
    </>
  );
}

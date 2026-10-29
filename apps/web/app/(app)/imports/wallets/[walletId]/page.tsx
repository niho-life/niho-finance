import {
  getStripeAccountLink,
  listImportableWallets,
  listWallets,
  type StripeAccountLinkSettings,
  type WalletSettings,
} from "@niho-finance/db";
import { WALLET_KIND_LABELS } from "@niho-finance/ledger";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { formatDate, formatDateTime } from "@/lib/format";
import { countsText, firstLine, formatJapanDate } from "../../_lib/format";
import { csvFormatOptions, isCsvFormatKey, isCsvWalletKind } from "../../_lib/labels";
import { ImporterForm } from "./importer-form";
import { StripeLinkActions, StripeLinkForm } from "./stripe-forms";

export const metadata: Metadata = { title: "取込の設定" };

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 border-b border-border py-2 last:border-b-0 md:grid-cols-[144px_minmax(0,1fr)]">
      <dt className="text-[12px] font-bold text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-[14px]">{children}</dd>
    </div>
  );
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

/** 取得の起点: the cursor's day; without one, the wallet's statement opening date (§4.2). */
function syncStart(link: StripeAccountLinkSettings, wallet: WalletSettings): string {
  if (link.syncCursor) {
    return `${formatJapanDate(link.syncCursor.created)}（次の同期はこの 7 日前から取り直します）`;
  }
  if (wallet.openingBalanceDate) {
    return `${formatDate(wallet.openingBalanceDate)}（明細の残高の日付）`;
  }
  return "全期間";
}

/** 状態 of a connected Stripe wallet: the key, the last sync, where the next starts, the result. */
function StripeStatus({
  link,
  wallet,
}: {
  link: StripeAccountLinkSettings;
  wallet: WalletSettings;
}) {
  const batch = link.lastBatch;
  return (
    <dl className="mb-4 max-w-2xl">
      <Item label="鍵">
        {link.keyConfigured ? (
          "設定済み"
        ) : (
          <span className="font-bold text-danger">
            見つかりません（環境変数 {link.secretName}）
          </span>
        )}
      </Item>
      <Item label="最終同期">
        {link.lastSyncedAt ? (
          <span className="num">{formatDateTime(link.lastSyncedAt)}</span>
        ) : (
          "まだ同期していません"
        )}
      </Item>
      <Item label="取得の起点">
        <span className="num">{syncStart(link, wallet)}</span>
      </Item>
      <Item label="直近の同期の結果">
        {batch ? (
          <>
            <span className="num text-muted">{formatDateTime(batch.executedAt)}</span>{" "}
            {batch.error ? (
              <>
                <span className="font-bold text-danger">失敗</span>{" "}
                <span className="text-[13px]">{firstLine(batch.error)}</span>
              </>
            ) : (
              <span className="num">{countsText(batch)}</span>
            )}{" "}
            <Link
              href={`/imports/${batch.id}`}
              className="whitespace-nowrap font-bold underline underline-offset-4"
            >
              結果を見る
            </Link>
          </>
        ) : (
          "—"
        )}
      </Item>
    </dl>
  );
}

/**
 * 取込の設定 (12-imports §1.4): the format and mapping of a bank / card / other wallet, or the
 * connection of a Stripe wallet. The wallet itself (name, account, balance) is edited in 設定 › 口座.
 */
export default async function WalletImportSettingsPage({
  params,
}: PageProps<"/imports/wallets/[walletId]">) {
  const { walletId } = await params;
  const prisma = await db();
  const wallet = (await listWallets(prisma)).find((item) => item.id === walletId);
  if (!wallet) notFound();
  const csvWallet = isCsvWalletKind(wallet.kind);
  const back = { href: "/imports", label: "明細の取込" };
  const meta = `${wallet.name}（${WALLET_KIND_LABELS[wallet.kind]}）`;

  if (wallet.kind !== "stripe" && !csvWallet) {
    return (
      <>
        <PageHeader title="取込の設定" meta={meta} back={back} />
        <EmptyState
          title="この口座は取り込みません（現金・役員立替は手入力）"
          description="取引の登録で、口座を選んで入力します"
          action={
            <ButtonLink href="/entries/new?type=expense" size="sm">
              取引を登録
            </ButtonLink>
          }
        />
      </>
    );
  }
  if (!wallet.isActive) {
    return (
      <>
        <PageHeader title="取込の設定" meta={meta} back={back} />
        <EmptyState
          title="この口座は無効です"
          description="設定 › 口座 で有効にすると、取り込めます"
          action={
            <ButtonLink href="/settings/wallets" size="sm">
              口座の設定を開く
            </ButtonLink>
          }
        />
      </>
    );
  }

  if (wallet.kind === "stripe") {
    const link = await getStripeAccountLink(prisma, wallet.id);
    return (
      <>
        <PageHeader title="取込の設定" meta={meta} back={back} />
        <Section id="stripe-link" title="Stripe の接続">
          <StripeLinkForm
            key={link ? `${link.stripeAccountId}:${link.secretName}` : "new"}
            walletId={wallet.id}
            stripeAccountId={link?.stripeAccountId ?? ""}
            secretName={link?.secretName ?? ""}
          />
        </Section>
        <Section id="stripe-status" title="状態">
          {link ? (
            <>
              <StripeStatus link={link} wallet={wallet} />
              <StripeLinkActions walletId={wallet.id} walletName={wallet.name} />
            </>
          ) : (
            <p className="text-[14px] text-muted">
              未接続です。アカウント ID と鍵の名前を保存すると同期できます。
            </p>
          )}
        </Section>
      </>
    );
  }

  const importable = (await listImportableWallets(prisma)).find((item) => item.id === wallet.id);
  const saved = importable?.importer ?? null;
  const importer = isCsvFormatKey(saved) ? saved : null;
  const formats = csvFormatOptions()
    .filter((format) => format.walletKinds.includes(wallet.kind))
    .map(({ key, label }) => ({ key, label }));
  return (
    <>
      <PageHeader
        title="取込の設定"
        meta={meta}
        back={back}
        actions={
          <ButtonLink href={`/imports/csv?wallet=${wallet.id}`} size="sm">
            CSV を取り込む
          </ButtonLink>
        }
      />
      <Section id="csv-importer" title="取込形式">
        <ImporterForm
          walletId={wallet.id}
          formats={formats}
          importer={importer}
          config={importable?.importerConfig ?? null}
        />
      </Section>
    </>
  );
}

import { WALLET_KIND_LABELS, type Money } from "@niho-finance/ledger";
import type { CashWalletRow } from "@niho-finance/reports";
import Link from "next/link";
import { formatAmountDisplay, formatDate } from "@/lib/format";
import { formatShortDateTime } from "../reports/_lib/format";

function abs(value: Money): Money {
  return value < 0n ? -value : value;
}

function activityLine(wallet: CashWalletRow): string[] {
  const parts: string[] = [];
  if (wallet.kind === "stripe") parts.push("入金待ち");
  if (wallet.lastActivityAt) {
    // A bank wallet on the bank API syncs like Stripe (19-bank-api §1.2).
    const syncs =
      wallet.kind === "stripe" ||
      wallet.bankApiStatus === "connected" ||
      wallet.bankApiStatus === "reauth_required";
    const label = syncs ? "最終同期" : "最終取込";
    parts.push(`${label} ${formatShortDateTime(wallet.lastActivityAt)}`);
  }
  if (wallet.pendingCount > 0) parts.push(`未処理 ${wallet.pendingCount} 件`);
  return parts;
}

/** 明細の残高との差異 (14-reports §6): 一致, the difference in the warning colour, or 明細なし. */
function StatementLine({ wallet }: { wallet: CashWalletRow }) {
  const statement = wallet.statement;
  if (!statement) return <p className="text-[11px] text-muted">明細なし</p>;
  if (statement.difference === 0n) {
    return (
      <p className="text-[11px] text-muted">明細の残高と一致（{formatDate(statement.date)}）</p>
    );
  }
  // difference = 明細の残高 − 帳簿の残高: say which side is larger, not just the gap.
  const larger = statement.difference > 0n ? "明細" : "帳簿";
  return (
    <p className="text-[11px] font-bold text-warn">
      {larger}の残高が <span className="num">{formatAmountDisplay(abs(statement.difference))}</span>{" "}
      円多い（{formatDate(statement.date)} 時点）
    </p>
  );
}

/**
 * The wallets on cash accounts (14-reports §6, §9): name, kind, balance, 入金待ち for Stripe, the
 * last sync or import, 未処理 n 件, 再接続が必要 for a lapsed bank API connection (19-bank-api
 * §1.2), and on the 現預金 tab the difference to the statement balance. Items are divided by thin
 * lines, not boxes (no cards inside cards, D14).
 */
export function WalletCards({
  wallets,
  showStatement = false,
}: {
  wallets: readonly CashWalletRow[];
  showStatement?: boolean;
}) {
  if (wallets.length === 0) return null;
  return (
    <ul className="grid grid-cols-2 gap-x-4 lg:grid-cols-3">
      {wallets.map((wallet) => {
        const activity = activityLine(wallet);
        return (
          <li
            key={wallet.walletId}
            className="flex min-w-0 flex-col gap-0.5 border-t border-border py-2.5"
          >
            <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[12px] text-muted">
              <span className="min-w-0 truncate">{wallet.name}</span>
              <span className="shrink-0 text-muted">{WALLET_KIND_LABELS[wallet.kind]}</span>
            </p>
            <p className="num text-[18px] leading-snug font-extrabold">
              {formatAmountDisplay(wallet.balance)}
              <span className="ml-1 text-[11px] font-semibold text-muted">円</span>
            </p>
            {activity.length > 0 ? (
              <p className="text-[11px] text-muted">{activity.join(" · ")}</p>
            ) : null}
            {wallet.bankApiStatus === "reauth_required" ? (
              <Link
                href={`/settings/wallets/${wallet.walletId}/bank`}
                className="inline-flex min-h-6 w-fit items-center text-[11px] font-bold text-warn underline-offset-4 hover:underline"
              >
                再接続が必要
              </Link>
            ) : null}
            {showStatement ? <StatementLine wallet={wallet} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** 「カード未払 n 円 · 役員立替 n 円」: the balances owed on the wallets that are not cash. */
export function owedSummary(otherWallets: readonly CashWalletRow[]): string | null {
  const byKind = new Map<string, Money>();
  for (const wallet of otherWallets) {
    const label =
      wallet.kind === "card" ? "カード未払" : wallet.kind === "owner" ? "役員立替" : wallet.name;
    byKind.set(label, (byKind.get(label) ?? 0n) + wallet.balance);
  }
  if (byKind.size === 0) return null;
  return [...byKind]
    .map(([label, total]) => `${label} ${formatAmountDisplay(total)} 円`)
    .join(" · ");
}

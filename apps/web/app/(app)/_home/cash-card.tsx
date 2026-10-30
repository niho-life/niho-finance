import type { CalendarDate, Money } from "@niho-finance/ledger";
import type { CashWalletRow } from "@niho-finance/reports";
import { formatAmount, formatDate } from "@/lib/format";
import { HomeCard } from "./card";
import { WalletCards } from "./wallet-cards";

/**
 * 現預金 (14-reports §9): one card with the total on `asOf` (the same number as the cash tab), 「…
 * 時点」, the balances owed on the wallets that are not cash, and the cash wallets underneath,
 * divided by thin lines (no cards inside it, D14).
 */
export function CashCard({
  href,
  total,
  asOf,
  owed,
  wallets,
  className = "",
}: {
  /** The cash tab on the same day. */
  href?: string;
  total: Money;
  asOf: CalendarDate;
  /** 「カード未払 n 円 · 役員立替 n 円」 (`owedSummary`). */
  owed: string | null;
  wallets: readonly CashWalletRow[];
  className?: string;
}) {
  return (
    <HomeCard id="home-cash" title="現預金" href={href} className={className}>
      <p className="num text-[32px] leading-tight font-extrabold tracking-tight">
        {formatAmount(total)}
        <span className="ml-1 text-[14px] font-semibold text-muted">円</span>
      </p>
      <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-muted">
        <span>{formatDate(asOf)} 時点</span>
        {owed ? <span className="num">{owed}</span> : null}
      </p>
      {wallets.length > 0 ? (
        <div className="mt-3">
          <WalletCards wallets={wallets} />
        </div>
      ) : (
        <p className="mt-3 border-t border-border pt-3 text-[14px] text-muted">
          現預金の口座はまだありません
        </p>
      )}
    </HomeCard>
  );
}

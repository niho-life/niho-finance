import type {
  ExpenseClaimantGroup,
  ExpenseClaimRow,
  ExpenseEntryRef,
  ExpensePaymentRow,
} from "@niho-finance/db";
import type { CalendarDate } from "@niho-finance/ledger";

/*
 * What the client components of /expenses receive: plain values, amounts as decimal text
 * (23-users-and-expenses §6).
 */

export interface EntryLinkView {
  id: string;
  no: number;
  voided: boolean;
}

export interface ClaimView {
  id: string;
  spentOn: CalendarDate;
  description: string;
  /** 「5360 旅費交通費」 */
  account: string;
  amount: string;
  hasDocument: boolean;
  /** 計上の仕訳; `voided` when the transaction screen voided it (the claim cannot be paid). */
  entry: EntryLinkView;
}

export interface ClaimantGroupView {
  claimantId: string;
  claimantName: string;
  count: number;
  total: string;
  claims: ClaimView[];
}

export interface PaymentView {
  id: string;
  paidOn: CalendarDate;
  claimantName: string;
  count: number;
  total: string;
  walletName: string;
  entry: EntryLinkView;
  cancelled: boolean;
  cancelReason: string | null;
  reversalNo: number | null;
}

export interface VoidedClaimView extends ClaimView {
  claimantName: string;
  voidReason: string | null;
  reversalNo: number | null;
}

export interface WalletOption {
  id: string;
  /** 「架空銀行 普通（普通預金 / 架空銀行 普通）」 */
  label: string;
  /** 「架空銀行 普通」 */
  name: string;
}

function toEntryLink(entry: ExpenseEntryRef): EntryLinkView {
  return { id: entry.id, no: entry.no, voided: entry.status === "voided" };
}

export function toClaimView(row: ExpenseClaimRow): ClaimView {
  return {
    id: row.id,
    spentOn: row.spentOn,
    description: row.description,
    account: `${row.accountCode} ${row.accountName}`,
    amount: row.amount.toString(),
    hasDocument: row.hasDocument,
    entry: toEntryLink(row.entry),
  };
}

export function toGroupView(group: ExpenseClaimantGroup): ClaimantGroupView {
  return {
    claimantId: group.claimant.id,
    claimantName: group.claimant.displayName,
    count: group.count,
    total: group.total.toString(),
    claims: group.claims.map(toClaimView),
  };
}

export function toPaymentView(row: ExpensePaymentRow): PaymentView {
  return {
    id: row.id,
    paidOn: row.paidOn,
    claimantName: row.claimant.displayName,
    count: row.count,
    total: row.total.toString(),
    walletName: row.walletName,
    entry: toEntryLink(row.entry),
    cancelled: row.cancelled,
    cancelReason: row.cancelReason,
    reversalNo: row.reversalEntry?.no ?? null,
  };
}

export function toVoidedView(row: ExpenseClaimRow): VoidedClaimView {
  return {
    ...toClaimView(row),
    claimantName: row.claimant.displayName,
    voidReason: row.voidReason,
    reversalNo: row.reversalEntry?.no ?? null,
  };
}

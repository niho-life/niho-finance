"use server";

import {
  getPrismaClient,
  ignoreWalletTransaction,
  loadStatementDocuments,
  registerWalletTransaction,
  reopenWalletTransaction,
  transferWalletTransaction,
  updateWalletTransactionNote,
  type IgnoreStatementInput,
  type RegisterStatementInput,
  type ReopenStatementInput,
  type StatementNoteInput,
  type StatementSettleResult,
  type TransferStatementInput,
} from "@niho-finance/db";
import {
  DOCUMENT_KIND_LABELS,
  DOCUMENT_STATUS_LABELS,
  formatYen,
  type CalendarDate,
  type DocumentKind,
  type DocumentStatus,
  type Money,
} from "@niho-finance/ledger";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { attempt, parseId } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { actor } from "@/lib/actor";
import { formatDate } from "@/lib/format";

/*
 * Server Actions of /statements (15 §5, §7). The repository validates every input with its Zod
 * schemas, locks the line, posts through the ledger and writes the audit log as
 * `NIHO_FINANCE_ACTOR`. Expected failures come back as `{ ok: false }` with the field of each problem
 * (`lines.0.accountId`, `entryDate`, `counterpart`, `reason` …).
 */

const prisma = () => getPrismaClient();
const by = async () => ({ actor: await actor() });

/** Form values from the client: a plain object (the repository checks every field). */
const valuesSchema = z.record(z.string(), z.unknown());

async function write<T, R>(
  run: () => Promise<T>,
  toData: (value: T) => R,
): Promise<ActionResult<R>> {
  const result = await attempt(run);
  if (!result.ok) return result;
  // The list, the home (やること), the journal and the reports read what was posted.
  revalidatePath("/", "layout");
  return { ok: true, data: toData(result.data) };
}

export interface SettledStatement {
  /** The entry posted or linked (登録・振替); `null` for 無視. */
  entry: { id: string; no: number } | null;
  /** The lines settled (2 for a pair of transfer lines); the first is the line acted on. */
  transactionIds: string[];
}

const settled = (result: StatementSettleResult): SettledStatement => ({
  entry: { id: result.entry.id, no: result.entry.no },
  transactionIds: result.transactionIds,
});

/** 登録 (one line, or several for 分割). */
export async function registerStatementAction(
  id: string,
  values: unknown,
): Promise<ActionResult<SettledStatement>> {
  return write(
    async () =>
      registerWalletTransaction(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as RegisterStatementInput,
        await by(),
      ),
    settled,
  );
}

/** 振替 to a pending line (`txn:`), a posted transfer entry (`entry:`) or a wallet (`wallet:`). */
export async function transferStatementAction(
  id: string,
  values: unknown,
): Promise<ActionResult<SettledStatement>> {
  return write(
    async () =>
      transferWalletTransaction(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as TransferStatementInput,
        await by(),
      ),
    settled,
  );
}

/** 無視 (the reason is optional). */
export async function ignoreStatementAction(
  id: string,
  values: unknown,
): Promise<ActionResult<SettledStatement>> {
  return write(
    async () =>
      ignoreWalletTransaction(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as IgnoreStatementInput,
        await by(),
      ),
    (result) => ({ entry: null, transactionIds: result.transactionIds }),
  );
}

export interface ReopenedStatement {
  reopenedIds: string[];
  /** The reversal that cancelled the entry; `null` when nothing was voided (無視・照合). */
  reversal: { no: number; entryDate: CalendarDate } | null;
}

/** 未処理に戻す and the 5-second 取消 (reason 「登録直後の取消」). */
export async function reopenStatementAction(
  id: string,
  values: unknown,
): Promise<ActionResult<ReopenedStatement>> {
  return write(
    async () =>
      reopenWalletTransaction(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as ReopenStatementInput,
        await by(),
      ),
    (result) => ({
      reopenedIds: result.reopenedIds,
      reversal: result.reversal
        ? { no: result.reversal.no, entryDate: result.reversal.entryDate }
        : null,
    }),
  );
}

/** メモ (any state; never written to the entry). */
export async function noteStatementAction(
  id: string,
  values: unknown,
): Promise<ActionResult<{ note: string | null }>> {
  return write(
    async () =>
      updateWalletTransactionNote(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as StatementNoteInput,
        await by(),
      ),
    (result) => ({ note: result.note }),
  );
}

/** A document as the 証憑 sheet of a line lists it (formatted on the server). */
export interface StatementDocumentItem {
  id: string;
  /** The file name, or the kind when there is none. */
  title: string;
  /** 領収書 … */
  kind: string;
  /** 2026/11/07, or `null` (未整理). */
  date: string | null;
  /** With grouping, or `null` (未整理). */
  amount: string | null;
  partner: string | null;
  /** 未紐づけ / 紐づけ済み / 無効（理由）. */
  status: string;
  voided: boolean;
  /** The same amount as the line (inbox): listed first. */
  sameAmount: boolean;
}

export interface StatementDocumentsView {
  linked: StatementDocumentItem[];
  inbox: StatementDocumentItem[];
}

function documentItem(document: {
  id: string;
  kind: DocumentKind;
  status: DocumentStatus;
  originalName: string | null;
  txnDate: CalendarDate | null;
  amount: Money | null;
  partnerName: string | null;
  voidReason: string | null;
  sameAmount?: boolean;
}): StatementDocumentItem {
  const voided = document.status === "voided";
  return {
    id: document.id,
    title: document.originalName ?? DOCUMENT_KIND_LABELS[document.kind],
    kind: DOCUMENT_KIND_LABELS[document.kind],
    date: document.txnDate ? formatDate(document.txnDate) : null,
    amount: document.amount === null ? null : formatYen(document.amount),
    partner: document.partnerName,
    status:
      voided && document.voidReason
        ? `無効（${document.voidReason}）`
        : DOCUMENT_STATUS_LABELS[document.status],
    voided,
    sameAmount: document.sameAmount ?? false,
  };
}

/** 証憑 of a line (15 §5): the linked documents and the inbox to link from. Reads only. */
export async function loadStatementDocumentsAction(
  id: string,
): Promise<ActionResult<StatementDocumentsView>> {
  const result = await attempt(() => loadStatementDocuments(prisma(), parseId(id)));
  if (!result.ok) return result;
  return {
    ok: true,
    data: {
      linked: result.data.linked.map(documentItem),
      inbox: result.data.inbox.map(documentItem),
    },
  };
}

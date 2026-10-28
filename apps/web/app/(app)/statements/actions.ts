"use server";

import {
  getPrismaClient,
  ignoreWalletTransaction,
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
import type { CalendarDate } from "@niho-finance/ledger";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { attempt, parseId } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { actor } from "@/lib/env";

/*
 * Server Actions of /statements (15 §5, §7). The repository validates every input with its Zod
 * schemas, locks the line, posts through the ledger and writes the audit log as
 * `NIHO_FINANCE_ACTOR`. Expected failures come back as `{ ok: false }` with the field of each problem
 * (`lines.0.accountId`, `entryDate`, `counterpart`, `reason` …).
 */

const prisma = () => getPrismaClient();
const by = () => ({ actor: actor() });

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
    () =>
      registerWalletTransaction(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as RegisterStatementInput,
        by(),
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
    () =>
      transferWalletTransaction(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as TransferStatementInput,
        by(),
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
    () =>
      ignoreWalletTransaction(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as IgnoreStatementInput,
        by(),
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
    () =>
      reopenWalletTransaction(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as ReopenStatementInput,
        by(),
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
    () =>
      updateWalletTransactionNote(
        prisma(),
        parseId(id),
        valuesSchema.parse(values) as StatementNoteInput,
        by(),
      ),
    (result) => ({ note: result.note }),
  );
}

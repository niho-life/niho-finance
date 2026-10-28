"use server";

import {
  cancelExpensePayment,
  getPrismaClient,
  loadExpensePaymentCandidates,
  payExpenseClaims,
  submitExpenseClaim,
  voidExpenseClaim,
  type ExpenseClaimSubmitInput,
  type ExpensePaymentInput,
} from "@niho-finance/db";
import { isCalendarDate, parseYenInput, type CalendarDate } from "@niho-finance/ledger";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { attempt, parseId } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { actor } from "@/lib/actor";
import { authorizeAction } from "@/lib/authz";

/*
 * Server Actions of 立替精算 (23-users-and-expenses §5–§6), 経理 and up. The repository validates
 * every input with its Zod schemas, posts through the ledger and writes the audit log
 * (`expense_claim.*`) as the signed-in user; expected failures come back as `{ ok: false }` with the
 * field of each problem.
 */

const prisma = () => getPrismaClient();
const by = async () => ({ actor: await actor() });

/** Form values from the client: a plain object (the repository checks every field). */
const valuesSchema = z.record(z.string(), z.unknown());
const reasonSchema = z.object({ reason: z.unknown() });

async function write<T, R>(
  run: () => Promise<T>,
  toData: (value: T) => R,
): Promise<ActionResult<R>> {
  const result = await attempt(run);
  if (!result.ok) return result;
  // The list, the entries, the statements (a matched line) and the home read what changed.
  revalidatePath("/", "layout");
  return { ok: true, data: toData(result.data) };
}

export interface PostedExpenseEntry {
  /** The entry's id (取引の詳細) and number. */
  entryId: string;
  entryNo: number;
}

/** 提出 (23 §6): the accrual entry is posted on 利用日. */
export async function submitExpenseClaimAction(
  values: unknown,
): Promise<ActionResult<PostedExpenseEntry>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(
    async () =>
      submitExpenseClaim(
        prisma(),
        valuesSchema.parse(values) as ExpenseClaimSubmitInput,
        await by(),
      ),
    (result) => ({ entryId: result.entry.id, entryNo: result.entry.no }),
  );
}

export interface PaidExpenses extends PostedExpenseEntry {
  /** The total as decimal text. */
  amount: string;
}

/** 支払う: one claimant's claims in one entry. */
export async function payExpenseClaimsAction(values: unknown): Promise<ActionResult<PaidExpenses>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(
    async () =>
      payExpenseClaims(prisma(), valuesSchema.parse(values) as ExpensePaymentInput, await by()),
    (result) => ({
      entryId: result.entry.id,
      entryNo: result.entry.no,
      amount: result.payment.amount.toString(),
    }),
  );
}

export interface ReversedExpense {
  /** The reversal's number, when one was posted here or on the transaction screen. */
  reversalNo: number | null;
}

/** 支払の取消: the payment entry is reversed and the claims are unpaid again. */
export async function cancelExpensePaymentAction(
  paymentId: string,
  values: { reason: string },
): Promise<ActionResult<ReversedExpense>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(
    async () =>
      cancelExpensePayment(
        prisma(),
        parseId(paymentId),
        reasonSchema.parse(values) as { reason: string },
        await by(),
      ),
    (result) => ({ reversalNo: result.reversal?.no ?? null }),
  );
}

/** 取消 (unpaid claims only): the accrual entry is reversed. */
export async function voidExpenseClaimAction(
  claimId: string,
  values: { reason: string },
): Promise<ActionResult<ReversedExpense>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(
    async () =>
      voidExpenseClaim(
        prisma(),
        parseId(claimId),
        reasonSchema.parse(values) as { reason: string },
        await by(),
      ),
    (result) => ({ reversalNo: result.reversal?.no ?? null }),
  );
}

/** A statement line the payment can be matched with (amounts as decimal text). */
export interface ExpenseCandidateView {
  id: string;
  txnDate: CalendarDate;
  description: string;
  /** The withdrawal as a positive amount. */
  amount: string;
}

const candidatesSchema = z.object({
  walletId: z.string().min(1).max(64),
  amount: z.string().max(20),
  notBefore: z.string().max(10).optional(),
});

/** 明細から選ぶ (23 §5.2): unhandled withdrawals of the wallet of exactly the total. Read only. */
export async function loadExpenseCandidatesAction(values: {
  walletId: string;
  amount: string;
  notBefore?: string;
}): Promise<ActionResult<ExpenseCandidateView[]>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return attempt(async () => {
    const input = candidatesSchema.parse(values);
    const amount = parseYenInput(input.amount);
    if (amount === null || amount <= 0n) return [];
    const rows = await loadExpensePaymentCandidates(prisma(), {
      walletId: input.walletId,
      amount,
      notBefore: input.notBefore && isCalendarDate(input.notBefore) ? input.notBefore : null,
    });
    return rows.map((row) => ({
      id: row.id,
      txnDate: row.txnDate,
      description: row.description,
      amount: (-row.amount).toString(),
    }));
  });
}

"use server";

import {
  authorizeBankToken,
  bankAccountChoiceSchema,
  bankWalletInputSchema,
  connectBankAccount,
  disconnectBankLink,
  getBankLink,
  getPrismaClient,
  settleAfterImport,
  syncBankWallet,
  type ImportOutcome,
} from "@niho-finance/db";
import { revalidatePath } from "next/cache";
import { attempt } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { actor } from "@/lib/actor";
import type { BankAuthorizedView, BankSyncView } from "./types";

/*
 * Server Actions of 銀行 API の接続 (19-bank-api §1.1, §6.4). Inputs are checked with the
 * repository's Zod schemas and written through `@niho-finance/db` with the audit log (as
 * `NIHO_FINANCE_ACTOR`). Expected failures come back as `{ ok: false }`, never thrown; a sync that
 * failed is `ok: true` with `error` (recorded as a batch, like the Stripe sync).
 */

const prisma = () => getPrismaClient();
const by = async () => ({ actor: await actor() });

async function write<T, R>(
  run: () => Promise<T>,
  toData: (value: T) => R,
): Promise<ActionResult<R>> {
  const result = await attempt(run);
  if (!result.ok) return result;
  // 設定 › 口座, this page, the home's cards and やること and /imports read the connection; a
  // sync's new lines reach 明細 and the reports too.
  revalidatePath("/", "layout");
  return { ok: true, data: toData(result.data) };
}

function toSyncView({
  batchId,
  importedCount,
  duplicateCount,
  failedCount,
  warnings,
  error,
}: ImportOutcome): BankSyncView {
  return { batchId, importedCount, duplicateCount, failedCount, warnings, error };
}

/**
 * 「接続する」/「再接続する」 of the token method (sunabar): the token is tried on the bank and
 * saved only when it passes. The authorization code flow starts at `/api/bank/gmo-aozora/authorize`.
 */
export async function connectBankAction(
  walletId: unknown,
): Promise<ActionResult<BankAuthorizedView>> {
  return write(
    async () => {
      const input = bankWalletInputSchema.parse({ walletId });
      await authorizeBankToken(prisma(), input, await by());
      const link = await getBankLink(prisma(), input.walletId);
      return link?.status === "connected" ? "connected" : "authorized";
    },
    (status) => ({ status }),
  );
}

/** 「この口座を接続する」: `{ walletId, accountId }`, then the first sync and its outcome. */
export async function chooseBankAccountAction(
  values: unknown,
): Promise<ActionResult<BankSyncView>> {
  return write(
    async () =>
      connectBankAccount(
        prisma(),
        bankAccountChoiceSchema.parse(values),
        // 取込時の自動登録 (15 §11): the new lines an `autoPost` rule wins are settled in the import.
        { ...(await by()), afterImport: settleAfterImport },
      ),
    toSyncView,
  );
}

/** 今すぐ同期 (`syncBankWalletAction`, 19-bank-api §3.5). */
export async function syncBankWalletAction(walletId: unknown): Promise<ActionResult<BankSyncView>> {
  return write(
    async () =>
      syncBankWallet(prisma(), bankWalletInputSchema.parse({ walletId }), {
        ...(await by()),
        afterImport: settleAfterImport,
      }),
    toSyncView,
  );
}

/** 接続を外す: the lines and the history stay; the tokens and the account go with the connection. */
export async function disconnectBankAction(walletId: unknown): Promise<ActionResult> {
  return write(
    async () => disconnectBankLink(prisma(), bankWalletInputSchema.parse({ walletId }), await by()),
    () => null,
  );
}

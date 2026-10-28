import type { ImportableWallet } from "@niho-finance/db";
import {
  CSV_FORMAT_KEYS,
  CSV_FORMAT_LABELS,
  CSV_FORMATS,
  type CsvFormatKey,
} from "@niho-finance/importers";
import type { WalletKind } from "@niho-finance/ledger";
import type { CsvFormatOption } from "./types";

/*
 * Labels of the import screens computed on the server (Server Components and Server Actions only:
 * `@niho-finance/importers` must not reach a client bundle). Format keys are never shown (12 §2).
 */

/** The wallet kinds that import CSV files (現金・役員立替 are entered by hand). */
export const CSV_WALLET_KINDS: readonly WalletKind[] = ["bank", "card", "other"];

export function isCsvWalletKind(kind: WalletKind): boolean {
  return CSV_WALLET_KINDS.includes(kind);
}

export function isCsvFormatKey(value: string | null | undefined): value is CsvFormatKey {
  return typeof value === "string" && (CSV_FORMAT_KEYS as readonly string[]).includes(value);
}

/** 取込形式 of a CSV wallet: 自動判別 / the format's name / 汎用. */
export function csvImporterLabel(importer: string | null): string {
  if (importer === null) return "自動判別";
  return isCsvFormatKey(importer) ? CSV_FORMAT_LABELS[importer] : "自動判別";
}

/** 取込形式 of a Stripe wallet. */
export function stripeImporterLabel(connected: boolean): string {
  return connected ? "Stripe 接続済み" : "未接続";
}

/** 取込形式 as the list of importable wallets shows it (12-imports §1.1). */
export function importerLabel(wallet: Pick<ImportableWallet, "importer" | "stripe">): string {
  return wallet.stripe
    ? stripeImporterLabel(wallet.stripe.connected)
    : csvImporterLabel(wallet.importer);
}

/** The formats of the select, in `CSV_FORMATS` order (汎用 last). */
export function csvFormatOptions(): CsvFormatOption[] {
  return CSV_FORMATS.map((format) => ({
    key: format.key,
    label: format.label,
    walletKinds: [...format.walletKinds],
  }));
}

import { describe, expect, it } from "vitest";
import type { ZodError } from "zod";
import {
  csvImportInputSchema,
  genericCsvConfigSchema,
  MAX_CSV_FILE_BYTES,
  stripeAccountLinkInputSchema,
  walletImporterInputSchema,
} from "../src/schemas";

function messagesOf(result: { success: boolean; error?: ZodError }): string[] {
  return result.error?.issues.map((issue) => issue.message) ?? [];
}

describe("genericCsvConfigSchema", () => {
  it("reads a mapping sent as form values and fills the defaults", () => {
    const config = genericCsvConfigSchema.parse({
      headerRows: "",
      columns: {
        date: "0",
        description: "１",
        amount: "2",
        deposit: "",
        withdrawal: null,
        balance: 3,
      },
      order: "",
    });
    // Not mapped columns are left out: the output is a GenericCsvConfig to save on the wallet.
    expect(config).toEqual({
      headerRows: 1,
      columns: { date: 0, description: 1, amount: 2, balance: 3 },
      invertSign: false,
      order: "auto",
    });
    expect(
      genericCsvConfigSchema.parse({
        headerRows: 0,
        columns: { date: 0, description: 1, withdrawal: 2, deposit: 3 },
        invertSign: "on",
        order: "desc",
      }),
    ).toEqual({
      headerRows: 0,
      columns: { date: 0, description: 1, withdrawal: 2, deposit: 3 },
      invertSign: true,
      order: "desc",
    });
  });

  it("asks for either the signed amount or the withdrawal / deposit columns", () => {
    const both = genericCsvConfigSchema.safeParse({
      columns: { date: 0, description: 1, amount: 2, deposit: 3 },
    });
    expect(messagesOf(both)).toEqual([
      "金額（符号付き）と出金・入金は、どちらか一方だけを選んでください",
    ]);
    const neither = genericCsvConfigSchema.safeParse({ columns: { date: 0, description: 1 } });
    expect(messagesOf(neither)).toEqual(["金額（符号付き）か、出金・入金の列を選んでください"]);
    const same = genericCsvConfigSchema.safeParse({
      columns: { date: 0, description: 1, withdrawal: 2, deposit: 2 },
    });
    expect(same.error?.issues[0]).toMatchObject({
      path: ["columns", "withdrawal"],
      message: "同じ列を 2 つの項目に選んでいます。列の対応を確かめてください",
    });
  });

  it("rejects missing, negative and fractional columns and a bad header count", () => {
    expect(messagesOf(genericCsvConfigSchema.safeParse({ columns: { amount: 2 } }))).toEqual(
      expect.arrayContaining(["日付の列を選んでください", "摘要の列を選んでください"]),
    );
    expect(
      messagesOf(
        genericCsvConfigSchema.safeParse({ columns: { date: -1, description: 1.5, amount: 2 } }),
      ),
    ).toEqual(["日付の列は整数で入力してください", "摘要の列は整数で入力してください"]);
    expect(
      messagesOf(
        genericCsvConfigSchema.safeParse({
          headerRows: 51,
          columns: { date: 0, description: 1, amount: 2 },
        }),
      ),
    ).toEqual(["ヘッダ行の数は 0〜50 にしてください"]);
    expect(messagesOf(genericCsvConfigSchema.safeParse(null))).toEqual([
      "列の対応を指定してください",
    ]);
  });
});

describe("walletImporterInputSchema", () => {
  it("turns 自動判別 (empty) into null and checks the format key", () => {
    expect(walletImporterInputSchema.parse({ walletId: "w1", importer: "" })).toEqual({
      walletId: "w1",
      importer: null,
      importerConfig: null,
    });
    expect(
      walletImporterInputSchema.parse({
        walletId: "w1",
        importer: "generic",
        importerConfig: { columns: { date: "0", description: "1", amount: "2" } },
      }),
    ).toMatchObject({ importer: "generic", importerConfig: { columns: { amount: 2 } } });
    expect(
      messagesOf(walletImporterInputSchema.safeParse({ walletId: "w1", importer: "stripe" })),
    ).toEqual(["取込形式を選んでください"]);
  });
});

describe("stripeAccountLinkInputSchema", () => {
  it("accepts an account ID and the name of the variable that holds the key", () => {
    expect(
      stripeAccountLinkInputSchema.parse({
        walletId: "w1",
        stripeAccountId: " acct_FICTIONAL0001 ",
        secretName: "NIHO_FINANCE_STRIPE_KEY_PLATFORM",
      }),
    ).toEqual({
      walletId: "w1",
      stripeAccountId: "acct_FICTIONAL0001",
      secretName: "NIHO_FINANCE_STRIPE_KEY_PLATFORM",
    });
  });

  it("explains a wrong account ID, a key pasted as the name and a bad name", () => {
    const result = stripeAccountLinkInputSchema.safeParse({
      walletId: "w1",
      stripeAccountId: "acct_123",
      secretName: "rk_test_FAKE",
    });
    expect(messagesOf(result)).toEqual([
      "アカウント ID は acct_ で始まる Stripe のアカウント ID です",
      "鍵そのものは入力しません。鍵を置いた環境変数の名前を入力してください",
    ]);
    expect(
      messagesOf(
        stripeAccountLinkInputSchema.safeParse({
          walletId: "w1",
          stripeAccountId: "acct_FICTIONAL0001",
          secretName: "stripe-key",
        }),
      ),
    ).toEqual([
      "鍵の名前は NIHO_FINANCE_STRIPE_ で始まる環境変数の名前にします（大文字の英数字と _。例 NIHO_FINANCE_STRIPE_KEY_PLATFORM）",
    ]);
    // Another secret of the app can never be named as the key.
    expect(
      stripeAccountLinkInputSchema.safeParse({
        walletId: "w1",
        stripeAccountId: "acct_FICTIONAL0001",
        secretName: "DATABASE_URL",
      }).success,
    ).toBe(false);
  });
});

describe("csvImportInputSchema", () => {
  const bytes = new TextEncoder().encode("日付,摘要,金額\n");

  it("defaults to remembering the format and reads form values", () => {
    expect(
      csvImportInputSchema.parse({ walletId: "w1", fileName: " 明細.csv ", bytes, format: "" }),
    ).toEqual({
      walletId: "w1",
      fileName: "明細.csv",
      bytes,
      format: null,
      config: null,
      rememberFormat: true,
    });
    expect(
      csvImportInputSchema.parse({
        walletId: "w1",
        fileName: "明細.csv",
        bytes: Buffer.from(bytes),
        format: "docomo_smtb",
        rememberFormat: "false",
      }),
    ).toMatchObject({ format: "docomo_smtb", rememberFormat: false });
  });

  it("refuses an empty file, a file over 10 MB and a missing file", () => {
    const empty = csvImportInputSchema.safeParse({
      walletId: "w1",
      fileName: "a.csv",
      bytes: new Uint8Array(),
    });
    expect(messagesOf(empty)).toEqual(["ファイルが空です"]);
    const large = csvImportInputSchema.safeParse({
      walletId: "w1",
      fileName: "a.csv",
      bytes: new Uint8Array(MAX_CSV_FILE_BYTES + 1),
    });
    expect(messagesOf(large)).toEqual(["ファイルが大きすぎます（10 MB まで）"]);
    const missing = csvImportInputSchema.safeParse({
      walletId: "w1",
      fileName: "",
      bytes: "text",
    });
    expect(messagesOf(missing)).toEqual([
      "ファイル名を入力してください",
      "ファイルを選んでください",
    ]);
  });
});

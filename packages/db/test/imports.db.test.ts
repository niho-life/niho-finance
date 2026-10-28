import { sha256Hex, type GenericCsvConfig } from "@niho-finance/importers";
import type { PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createWallet,
  getImportBatch,
  importCsv,
  listImportableWallets,
  listImportBatches,
  newId,
  previewCsvImport,
  setWalletActive,
  SettingsError,
  updateWalletImporter,
  type AfterImportHook,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";

const actor = "importer@example.com";

const SMTB_HEADER = '"日付","内容","出金金額(円)","入金金額(円)","残高(円)","メモ"';

/** A fictional ドコモ SMTB statement (UTF-8), newest first like the bank's download. */
function smtbFile(...lines: string[]): Uint8Array {
  return new TextEncoder().encode(`${[SMTB_HEADER, ...lines].join("\r\n")}\r\n`);
}

const FILE_A = smtbFile(
  '"2026/11/10","口座振替 テストリース","22,000","","471,255",""',
  '"2026/11/04","デビット テストストア","3,300","","493,255",""',
  '"2026/11/04","デビット テストストア","3,300","","496,555",""',
  '"2026/11/04","振込手数料","145","","499,855",""',
  '"2026/11/02","振込 カ）テストショウジ","","500,000","500,000","初回入金"',
);

/** Overlaps FILE_A from 11/04: four lines are already stored, two are new. */
const FILE_B = smtbFile(
  '"2026/11/20","振込＊テストデンキ（カ","54,000","","417,267",""',
  '"2026/11/15","利息","","12","471,267",""',
  '"2026/11/10","口座振替 テストリース","22,000","","471,255",""',
  '"2026/11/04","デビット テストストア","3,300","","493,255",""',
  '"2026/11/04","デビット テストストア","3,300","","496,555",""',
  '"2026/11/04","振込手数料","145","","499,855",""',
);

/** Follows FILE_B, with one unreadable date (row 3). */
const FILE_C = smtbFile(
  '"2026/11/25","ATM 現金引出","10,000","","406,067",""',
  '"2026/13/45","不明な取引","500","","405,567",""',
  '"2026/11/22","カード利用 テストカフェ","1,200","","416,067",""',
);

/** Does not follow FILE_C: 406,067 + 30,000 would be 436,067. */
const FILE_D = smtbFile(
  '"2026/12/03","振込手数料","145","","499,855",""',
  '"2026/12/01","振込 テストサービス","","30,000","500,000",""',
);

function cardFile(...lines: string[]): Uint8Array {
  return new TextEncoder().encode(`${["利用日,利用先,利用金額,備考", ...lines].join("\r\n")}\r\n`);
}

/** The card's mapping as saved: 利用金額 is positive for a purchase. */
const CARD_CONFIG: GenericCsvConfig = {
  headerRows: 1,
  columns: { date: 0, description: 1, amount: 2 },
  invertSign: true,
  order: "auto",
};

function dateOf(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/** CSV imports on the seeded book. Other files share the database: each test adds its own rows. */
describe.skipIf(!hasTestDatabase)("imports repository", () => {
  let prisma: PrismaClient;
  let bankId: string;
  let cardId: string;
  let cashId: string;
  let stripeId: string;
  const batches = { a: "", b: "", c: "", d: "" };

  beforeAll(async () => {
    prisma = testPrisma();
    const wallets = await prisma.wallet.findMany();
    const idOf = (name: string): string => {
      const wallet = wallets.find((item) => item.name === name);
      if (!wallet) throw new Error(`not seeded: ${name}`);
      return wallet.id;
    };
    bankId = idOf("架空銀行 普通");
    cardId = idOf("架空カード");
    cashId = idOf("現金");
    stripeId = idOf("Stripe platform");
  });

  describe("a bank statement (ドコモ SMTB)", () => {
    it("previews a file without writing anything", async () => {
      const batchCount = await prisma.importBatch.count();
      const preview = await previewCsvImport(prisma, {
        walletId: bankId,
        fileName: "smtb-2026-11a.csv",
        bytes: FILE_A,
      });
      expect(preview).toMatchObject({
        walletId: bankId,
        fileName: "smtb-2026-11a.csv",
        fileSha256: sha256Hex(FILE_A),
        byteSize: FILE_A.byteLength,
        encoding: "utf-8",
        format: "docomo_smtb",
        detectedFormat: "docomo_smtb",
        config: null,
        columnCount: 6,
        rowCount: 5,
        duplicateCount: 0,
        failures: [],
        warnings: [],
        period: { from: "2026-11-02", to: "2026-11-10" },
        openingBalance: null,
        closingBalance: null,
        alreadyImported: null,
      });
      expect(preview.table).toHaveLength(6);
      expect(preview.rows.map((row) => [row.txnDate, row.amount, row.balanceAfter])).toEqual([
        ["2026-11-02", 500_000n, 500_000n],
        ["2026-11-04", -145n, 499_855n],
        ["2026-11-04", -3_300n, 496_555n],
        ["2026-11-04", -3_300n, 493_255n],
        ["2026-11-10", -22_000n, 471_255n],
      ]);
      expect(preview.rows[0]).toMatchObject({
        descriptionRaw: "振込 カ）テストショウジ",
        counterpartyRaw: null,
        duplicate: false,
      });
      expect(await prisma.importBatch.count()).toBe(batchCount);
    });

    it("imports pending lines in one batch, saves the format and runs the hook inside", async () => {
      const calls: {
        batch: Parameters<AfterImportHook>[1];
        actor: string;
        linesInside: number;
        visibleOutside: boolean;
      }[] = [];
      const afterImport: AfterImportHook = async (tx, batch, options) => {
        calls.push({
          batch,
          actor: options.actor,
          linesInside: await tx.walletTransaction.count({ where: { importBatchId: batch.id } }),
          visibleOutside:
            (await prisma.importBatch.findUnique({ where: { id: batch.id } })) !== null,
        });
      };
      const journalEntries = await prisma.journalEntry.count();
      const outcome = await importCsv(
        prisma,
        { walletId: bankId, fileName: "smtb-2026-11a.csv", bytes: FILE_A, rememberFormat: true },
        { actor, afterImport },
      );
      expect(outcome).toMatchObject({
        walletId: bankId,
        source: "csv",
        rowCount: 5,
        importedCount: 5,
        duplicateCount: 0,
        failedCount: 0,
        warnings: [],
        error: null,
      });
      batches.a = outcome.batchId ?? "";

      const lines = await prisma.walletTransaction.findMany({
        where: { importBatchId: batches.a },
        orderBy: { id: "asc" },
      });
      expect(calls).toEqual([
        {
          batch: {
            id: batches.a,
            walletId: bankId,
            source: "csv",
            transactionIds: lines.map((line) => line.id),
          },
          actor,
          linesInside: 5,
          visibleOutside: false,
        },
      ]);
      expect(lines.every((line) => line.status === "pending" && line.journalEntryId === null)).toBe(
        true,
      );
      expect(lines[0]).toMatchObject({
        walletId: bankId,
        amount: 500_000n,
        balanceAfter: 500_000n,
        descriptionRaw: "振込 カ）テストショウジ",
        counterpartyRaw: null,
        category: null,
        valueDate: null,
        occurredAt: null,
        raw: ["2026/11/02", "振込 カ）テストショウジ", "", "500,000", "500,000", "初回入金"],
      });
      expect(await prisma.journalEntry.count()).toBe(journalEntries);

      const stored = await prisma.importBatch.findUniqueOrThrow({ where: { id: batches.a } });
      expect(stored).toMatchObject({
        source: "csv",
        importer: "docomo_smtb",
        originalName: "smtb-2026-11a.csv",
        fileSha256: sha256Hex(FILE_A),
        rowCount: 5,
        importedCount: 5,
        duplicateCount: 0,
        failedCount: 0,
        failures: [],
        warnings: [],
        error: null,
        executedBy: actor,
      });
      expect(dateOf(stored.periodFrom)).toBe("2026-11-02");
      expect(dateOf(stored.periodTo)).toBe("2026-11-10");
      expect(Buffer.from(stored.fileBytes ?? new Uint8Array()).equals(Buffer.from(FILE_A))).toBe(
        true,
      );

      const audit = await prisma.auditLog.findMany({ where: { entityId: batches.a } });
      expect(audit.map((row) => [row.action, row.actor])).toEqual([["import_batch.import", actor]]);
      expect(audit[0]?.after).toMatchObject({ id: batches.a, importedCount: 5, transactionIds: 5 });
      expect(audit[0]?.after).not.toHaveProperty("fileBytes");

      expect(await prisma.wallet.findUniqueOrThrow({ where: { id: bankId } })).toMatchObject({
        importer: "docomo_smtb",
        importerConfig: null,
      });
      const saved = await prisma.auditLog.findMany({
        where: { entityId: bankId, action: "wallet.update_importer" },
      });
      expect(saved).toMatchObject([
        {
          actor,
          before: { importer: null, importerConfig: null },
          after: { importer: "docomo_smtb", importerConfig: null },
        },
      ]);
    });

    it("stops the same file a second time", async () => {
      const preview = await previewCsvImport(prisma, {
        walletId: bankId,
        fileName: "smtb-copy.csv",
        bytes: FILE_A,
      });
      expect(preview.alreadyImported?.batchId).toBe(batches.a);
      expect(preview.alreadyImported?.executedAt).toBeInstanceOf(Date);
      expect(preview).toMatchObject({ rowCount: 5, duplicateCount: 5 });
      expect(preview.rows.every((row) => row.duplicate)).toBe(true);

      const error = await rejectionOf(
        importCsv(
          prisma,
          { walletId: bankId, fileName: "smtb-copy.csv", bytes: FILE_A, rememberFormat: true },
          { actor },
        ),
      );
      expect(error).toBeInstanceOf(SettingsError);
      expect(error).toMatchObject({
        message: "このファイルは取り込み済みです。取込の履歴を確かめてください",
      });
    });

    it("rolls the whole import back when the hook fails", async () => {
      const lines = await prisma.walletTransaction.count({ where: { walletId: bankId } });
      await expect(
        importCsv(
          prisma,
          { walletId: bankId, fileName: "smtb-2026-11b.csv", bytes: FILE_B, rememberFormat: true },
          { actor, afterImport: () => Promise.reject(new Error("rule failed")) },
        ),
      ).rejects.toThrow("rule failed");
      expect(
        await prisma.importBatch.findUnique({ where: { fileSha256: sha256Hex(FILE_B) } }),
      ).toBeNull();
      expect(await prisma.walletTransaction.count({ where: { walletId: bankId } })).toBe(lines);
    });

    it("counts the lines an overlapping file shares with the previous one", async () => {
      const preview = await previewCsvImport(prisma, {
        walletId: bankId,
        fileName: "smtb-2026-11b.csv",
        bytes: FILE_B,
      });
      // The first line is already stored: the file's own balances cover the junction.
      expect(preview).toMatchObject({
        format: "docomo_smtb",
        rowCount: 6,
        duplicateCount: 4,
        warnings: [],
        alreadyImported: null,
      });

      const outcome = await importCsv(
        prisma,
        { walletId: bankId, fileName: "smtb-2026-11b.csv", bytes: FILE_B, rememberFormat: true },
        { actor },
      );
      expect(outcome).toMatchObject({
        rowCount: 6,
        importedCount: 2,
        duplicateCount: 4,
        failedCount: 0,
        warnings: [],
      });
      batches.b = outcome.batchId ?? "";
      const lines = await prisma.walletTransaction.findMany({
        where: { importBatchId: batches.b },
        orderBy: { id: "asc" },
      });
      expect(lines.map((line) => [line.descriptionRaw, line.amount])).toEqual([
        ["利息", 12n],
        ["振込＊テストデンキ（カ", -54_000n],
      ]);
    });

    it("keeps an unreadable row on the batch and imports the rest", async () => {
      const outcome = await importCsv(
        prisma,
        { walletId: bankId, fileName: "smtb-2026-11c.csv", bytes: FILE_C, rememberFormat: true },
        { actor },
      );
      expect(outcome).toMatchObject({
        rowCount: 3,
        importedCount: 2,
        duplicateCount: 0,
        failedCount: 1,
        warnings: [],
      });
      batches.c = outcome.batchId ?? "";

      const detail = await getImportBatch(prisma, batches.c);
      expect(detail).toMatchObject({
        id: batches.c,
        walletId: bankId,
        walletName: "架空銀行 普通",
        source: "csv",
        importer: "docomo_smtb",
        originalName: "smtb-2026-11c.csv",
        periodFrom: "2026-11-22",
        periodTo: "2026-11-25",
        rowCount: 3,
        importedCount: 2,
        duplicateCount: 0,
        failedCount: 1,
        error: null,
        executedBy: actor,
        warnings: [],
      });
      expect(detail?.executedAt).toBeInstanceOf(Date);
      expect(detail?.failures).toEqual([
        {
          rowNumber: 3,
          reason: "日付が読めません",
          raw: ["2026/13/45", "不明な取引", "500", "", "405,567", ""],
        },
      ]);
      expect(detail).not.toHaveProperty("fileBytes");
      expect(await getImportBatch(prisma, newId())).toBeNull();
    });

    it("warns when the next file does not follow on, and imports it anyway", async () => {
      const warning =
        "前回の取込（2026/11/25 の残高 406,067）と最初の行の残高がつながりません。取りこぼしがないか確かめてください";
      const preview = await previewCsvImport(prisma, {
        walletId: bankId,
        fileName: "smtb-2026-12.csv",
        bytes: FILE_D,
      });
      expect(preview.warnings).toEqual([warning]);

      const outcome = await importCsv(
        prisma,
        { walletId: bankId, fileName: "smtb-2026-12.csv", bytes: FILE_D, rememberFormat: true },
        { actor },
      );
      expect(outcome).toMatchObject({ importedCount: 2, warnings: [warning] });
      batches.d = outcome.batchId ?? "";
      expect((await getImportBatch(prisma, batches.d))?.warnings).toEqual([warning]);
      // The format was saved once, by the first import.
      expect(
        await prisma.auditLog.count({
          where: { entityId: bankId, action: "wallet.update_importer" },
        }),
      ).toBe(1);
    });

    it("refuses a file without lines, wallets that cannot import and a card format", async () => {
      await expect(
        importCsv(
          prisma,
          { walletId: bankId, fileName: "smtb-empty.csv", bytes: smtbFile(), rememberFormat: true },
          { actor },
        ),
      ).rejects.toMatchObject({
        message: "取り込める明細がありません。形式か列の対応を確かめてください",
      });
      for (const walletId of [cashId, stripeId]) {
        await expect(
          previewCsvImport(prisma, { walletId, fileName: "a.csv", bytes: FILE_A }),
        ).rejects.toMatchObject({
          message: "この口座は取り込めません。銀行・カード・その他の口座を選んでください",
          field: "walletId",
        });
      }
      await expect(
        previewCsvImport(prisma, {
          walletId: bankId,
          fileName: "a.csv",
          bytes: FILE_A,
          format: "rakuten_card",
        }),
      ).rejects.toMatchObject({
        message:
          "「楽天カード（e-NAVI）」はカードの口座の形式です。口座か取込形式を選び直してください",
        field: "format",
      });
      await expect(
        previewCsvImport(prisma, { walletId: newId(), fileName: "a.csv", bytes: FILE_A }),
      ).rejects.toThrow("口座が見つかりません");
    });
  });

  describe("a card statement with the generic format", () => {
    const first = cardFile(
      '2026/11/03,テストスーパー,"1,980",',
      '2026/11/08,テスト書店,"3,300",ポイント利用',
    );
    const second = cardFile("2026/11/12,テストカフェ,880,");

    it("asks for a format and a mapping before importing", async () => {
      const unknown = await previewCsvImport(prisma, {
        walletId: cardId,
        fileName: "card-2026-11.csv",
        bytes: first,
      });
      expect(unknown).toMatchObject({
        format: null,
        detectedFormat: null,
        config: null,
        rows: [],
        rowCount: 0,
        columnCount: 4,
        warnings: [],
      });
      expect(unknown.table[0]).toEqual(["利用日", "利用先", "利用金額", "備考"]);
      const unmapped = await previewCsvImport(prisma, {
        walletId: cardId,
        fileName: "card-2026-11.csv",
        bytes: first,
        format: "generic",
      });
      expect(unmapped).toMatchObject({ format: "generic", config: null, rows: [], rowCount: 0 });

      const input = { walletId: cardId, fileName: "card-2026-11.csv", bytes: first };
      await expect(
        importCsv(prisma, { ...input, rememberFormat: true }, { actor }),
      ).rejects.toMatchObject({ message: "取込形式を選んでください", field: "format" });
      await expect(
        importCsv(prisma, { ...input, format: "generic", rememberFormat: true }, { actor }),
      ).rejects.toMatchObject({ message: "列の対応を指定してください", field: "config" });
    });

    it("imports with the mapping and uses the saved mapping next time", async () => {
      // As the mapping editor sends it: column numbers as text, 「なし」 as "".
      const config = {
        headerRows: "1",
        columns: {
          date: "0",
          description: "1",
          amount: "2",
          deposit: "",
          withdrawal: "",
          balance: "",
          counterparty: "",
        },
        invertSign: "on",
        order: "",
      };
      const outcome = await importCsv(
        prisma,
        {
          walletId: cardId,
          fileName: "card-2026-11.csv",
          bytes: first,
          format: "generic",
          config,
          rememberFormat: true,
        },
        { actor },
      );
      expect(outcome).toMatchObject({ rowCount: 2, importedCount: 2, failedCount: 0 });
      const lines = await prisma.walletTransaction.findMany({
        where: { importBatchId: outcome.batchId ?? "" },
        orderBy: { id: "asc" },
      });
      expect(
        lines.map((line) => [
          dateOf(line.txnDate),
          line.descriptionRaw,
          line.amount,
          line.balanceAfter,
        ]),
      ).toEqual([
        ["2026-11-03", "テストスーパー", -1_980n, null],
        ["2026-11-08", "テスト書店", -3_300n, null],
      ]);
      expect(await prisma.wallet.findUniqueOrThrow({ where: { id: cardId } })).toMatchObject({
        importer: "generic",
        importerConfig: CARD_CONFIG,
      });

      // Nothing chosen: the saved format and mapping are used, without detection.
      const next = await previewCsvImport(prisma, {
        walletId: cardId,
        fileName: "card-2026-11b.csv",
        bytes: second,
      });
      expect(next).toMatchObject({
        format: "generic",
        detectedFormat: null,
        config: CARD_CONFIG,
        rowCount: 1,
      });
      expect(next.rows[0]).toMatchObject({
        txnDate: "2026-11-12",
        amount: -880n,
        duplicate: false,
      });

      // Without rememberFormat, another mapping is used once and the saved one stays.
      const once = await importCsv(
        prisma,
        {
          walletId: cardId,
          fileName: "card-2026-11b.csv",
          bytes: second,
          format: "generic",
          config: { ...CARD_CONFIG, order: "asc" },
          rememberFormat: false,
        },
        { actor },
      );
      expect(once).toMatchObject({ importedCount: 1 });
      expect(await prisma.wallet.findUniqueOrThrow({ where: { id: cardId } })).toMatchObject({
        importerConfig: CARD_CONFIG,
      });
      expect(
        await prisma.auditLog.count({
          where: { entityId: cardId, action: "wallet.update_importer" },
        }),
      ).toBe(1);
    });
  });

  it("checks a file against the wallet's statement opening balance", async () => {
    const wallet = await createWallet(
      prisma,
      {
        name: "架空銀行 照合",
        kind: "bank",
        openingBalance: "100,000",
        openingBalanceDate: "2026-11-01",
      },
      { actor },
    );
    const off = await previewCsvImport(prisma, {
      walletId: wallet.id,
      fileName: "a.csv",
      bytes: smtbFile('"2026/11/05","振込 テストショウジ","","50,000","160,000",""'),
    });
    expect(off.warnings).toEqual([
      "口座の明細の残高（2026/11/01 の残高 100,000）と最初の行の残高がつながりません。明細の残高の設定と、取りこぼしがないかを確かめてください",
    ]);
    const on = await previewCsvImport(prisma, {
      walletId: wallet.id,
      fileName: "b.csv",
      bytes: smtbFile('"2026/11/05","振込 テストショウジ","","50,000","150,000",""'),
    });
    expect(on.warnings).toEqual([]);
    await setWalletActive(prisma, { id: wallet.id, isActive: false }, { actor });
  });

  it("lists the importable wallets and the history, without the files", async () => {
    const wallets = await listImportableWallets(prisma);
    const names = wallets.map((wallet) => wallet.name);
    expect(names).toEqual(
      expect.arrayContaining(["架空銀行 普通", "架空カード", "Stripe platform"]),
    );
    expect(names).not.toContain("現金");
    expect(names).not.toContain("役員立替");
    expect(names).not.toContain("架空銀行 照合");
    expect(wallets.find((wallet) => wallet.id === bankId)).toMatchObject({
      kind: "bank",
      importer: "docomo_smtb",
      importerConfig: null,
      stripe: null,
      lastBatch: { id: batches.d, walletName: "架空銀行 普通", importedCount: 2 },
    });
    expect(wallets.find((wallet) => wallet.id === cardId)).toMatchObject({
      kind: "card",
      importer: "generic",
      importerConfig: CARD_CONFIG,
    });
    const stripeWallet = wallets.find((wallet) => wallet.id === stripeId);
    expect(stripeWallet).toMatchObject({
      kind: "stripe",
      importer: "stripe",
      importerConfig: null,
    });
    expect(typeof stripeWallet?.stripe?.connected).toBe("boolean");

    const history = await listImportBatches(prisma, { walletId: bankId });
    expect(history.map((batch) => batch.id)).toEqual([batches.d, batches.c, batches.b, batches.a]);
    expect(history[3]).toMatchObject({
      walletName: "架空銀行 普通",
      source: "csv",
      originalName: "smtb-2026-11a.csv",
      periodFrom: "2026-11-02",
      periodTo: "2026-11-10",
    });
    expect(history[0]).not.toHaveProperty("fileBytes");
    expect(await listImportBatches(prisma, { walletId: bankId, limit: 2 })).toHaveLength(2);
    const recent = await listImportBatches(prisma);
    expect(recent.length).toBeLessThanOrEqual(20);
    expect(recent[0]?.executedAt.getTime()).toBeGreaterThanOrEqual(
      recent[recent.length - 1]?.executedAt.getTime() ?? 0,
    );
  });

  describe("取込の設定", () => {
    let walletId: string;

    beforeAll(async () => {
      walletId = (
        await createWallet(prisma, { name: "架空銀行 取込設定", kind: "bank" }, { actor })
      ).id;
    });

    it("saves a format or 汎用 with its mapping, and refuses what does not fit", async () => {
      await expect(
        updateWalletImporter(prisma, { walletId: stripeId, importer: "docomo_smtb" }, { actor }),
      ).rejects.toMatchObject({
        message: "この口座は取り込めません。銀行・カード・その他の口座を選んでください",
        field: "walletId",
      });
      await expect(
        updateWalletImporter(prisma, { walletId, importer: "generic" }, { actor }),
      ).rejects.toMatchObject({ message: "列の対応を指定してください", field: "importerConfig" });
      await expect(
        updateWalletImporter(prisma, { walletId, importer: "rakuten_card" }, { actor }),
      ).rejects.toMatchObject({ field: "importer" });

      expect(
        await updateWalletImporter(prisma, { walletId, importer: "gmo_aozora_zengin" }, { actor }),
      ).toEqual({
        id: walletId,
        name: "架空銀行 取込設定",
        kind: "bank",
        importer: "gmo_aozora_zengin",
        importerConfig: null,
        stripe: null,
        lastBatch: null,
      });
      const mapping = {
        headerRows: 2,
        columns: { date: 1, description: 3, withdrawal: 4, deposit: 5, balance: 6 },
      };
      const generic = await updateWalletImporter(
        prisma,
        { walletId, importer: "generic", importerConfig: mapping },
        { actor },
      );
      expect(generic.importerConfig).toEqual({ ...mapping, invertSign: false, order: "auto" });
      // The same mapping from the form changes nothing.
      await updateWalletImporter(
        prisma,
        {
          walletId,
          importer: "generic",
          importerConfig: {
            headerRows: "2",
            columns: { date: "1", description: "3", withdrawal: "4", deposit: "5", balance: "6" },
          },
        },
        { actor },
      );
      // A format of its own drops the mapping; 自動判別 clears both.
      expect(
        await updateWalletImporter(
          prisma,
          { walletId, importer: "docomo_smtb", importerConfig: mapping },
          { actor },
        ),
      ).toMatchObject({ importer: "docomo_smtb", importerConfig: null });
      expect(
        await updateWalletImporter(prisma, { walletId, importer: "" }, { actor }),
      ).toMatchObject({ importer: null, importerConfig: null });

      const audits = await prisma.auditLog.findMany({
        where: { entityId: walletId },
        orderBy: [{ at: "asc" }, { id: "asc" }],
      });
      expect(audits.map((row) => [row.action, row.actor])).toEqual([
        ["wallet.create", actor],
        ["wallet.update_importer", actor],
        ["wallet.update_importer", actor],
        ["wallet.update_importer", actor],
        ["wallet.update_importer", actor],
      ]);
      expect(audits[2]).toMatchObject({
        before: { importer: "gmo_aozora_zengin", importerConfig: null },
        after: { importer: "generic", importerConfig: { headerRows: 2, invertSign: false } },
      });
      expect(audits[4]).toMatchObject({ after: { importer: null, importerConfig: null } });
    });

    it("reads stored failures and warnings defensively", async () => {
      const broken = await prisma.importBatch.create({
        data: {
          id: newId(),
          walletId,
          source: "csv",
          executedBy: actor,
          failures: { rowNumber: 1 },
          warnings: "残高",
        },
      });
      expect(await getImportBatch(prisma, broken.id)).toMatchObject({ failures: [], warnings: [] });
      const mixed = await prisma.importBatch.create({
        data: {
          id: newId(),
          walletId,
          source: "csv",
          executedBy: actor,
          failures: [
            { rowNumber: 2, reason: "日付が読めません", raw: "2026/13/45" },
            "壊れた行",
            { reason: "行番号なし" },
          ],
          warnings: ["2 行目で残高がつながりません", 3],
        },
      });
      const detail = await getImportBatch(prisma, mixed.id);
      expect(detail?.failures).toEqual([{ rowNumber: 2, reason: "日付が読めません" }]);
      expect(detail?.warnings).toEqual(["2 行目で残高がつながりません"]);
    });

    it("refuses a wallet that is no longer active", async () => {
      await setWalletActive(prisma, { id: walletId, isActive: false }, { actor });
      await expect(
        updateWalletImporter(prisma, { walletId, importer: "docomo_smtb" }, { actor }),
      ).rejects.toMatchObject({ message: "この口座は無効です。設定 › 口座 で有効にしてください" });
      await expect(
        previewCsvImport(prisma, { walletId, fileName: "a.csv", bytes: FILE_A }),
      ).rejects.toMatchObject({ field: "walletId" });
    });
  });
});

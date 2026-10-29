import { LedgerValidationError, type CalendarDate } from "@niho-finance/ledger";
import { CSV_FORMAT_KEYS } from "@niho-finance/importers";
import type { PrismaClient, Wallet } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  countDueRecurringOccurrences,
  createAccount,
  createRecurringItem,
  correctJournalEntry,
  createWallet,
  describeRecurringSource,
  getWalletTransaction,
  listDueRecurringOccurrences,
  listRecurringEntries,
  listRecurringEntryTemplates,
  listRecurringItems,
  postRecurringOccurrence,
  recurringDueTodo,
  recurringEntryTemplate,
  registerWalletTransaction,
  SettingsError,
  toDbDate,
  updateRecurringItem,
  voidJournalEntryWithOpenDate,
  type RecurringItemCreateInput,
  type RecurringItemSettings,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";
import { createFiscalYear, seededRefs, type SeededRefs } from "./support/refs";

const actor = "tester@example.com";

/**
 * 定期取引からの登録 (21-cashflow §10). The items live on wallets of their own and in years of their
 * own (第 82・83 期), so that other files' statements and items are not matched; they are
 * deactivated at the end (other files share the database).
 */
describe.skipIf(!hasTestDatabase)("registering recurring items (21 §10)", () => {
  let prisma: PrismaClient;
  let refs: SeededRefs;
  let bank: Wallet;
  let card: Wallet;
  let importing: Wallet;
  const created: string[] = [];
  let externalNo = 0;

  /** 第 82 期 (open from 2082-04-01) is where most tests register. */
  const TODAY: CalendarDate = "2082-06-10";

  beforeAll(async () => {
    prisma = testPrisma();
    refs = await seededRefs(prisma);
    await createFiscalYear(prisma, { no: 82, startDate: "2082-04-01", endDate: "2083-03-31" });
    await createFiscalYear(prisma, {
      no: 83,
      startDate: "2083-04-01",
      endDate: "2084-03-31",
      lockedThrough: "2083-04-30",
    });
    const walletRow = async (name: string, kind: "bank" | "card", accountId?: string) => {
      const wallet = await createWallet(prisma, { name, kind, accountId }, { actor });
      return prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    };
    bank = await walletRow("定期試験 銀行", "bank");
    card = await walletRow("定期試験 カード", "card");
    importing = await walletRow("定期試験 取込の銀行", "bank");
    importing = await prisma.wallet.update({
      where: { id: importing.id },
      data: { importer: CSV_FORMAT_KEYS[0] },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.recurringItem.updateMany({
      where: { id: { in: created } },
      data: { isActive: false },
    });
    await prisma.walletTransaction.updateMany({
      where: { externalId: { startsWith: "test-recurring-post-" }, status: "pending" },
      data: { status: "ignored", ignoredReason: "試験の後片付け" },
    });
  });

  async function item(
    overrides: Partial<RecurringItemCreateInput>,
  ): Promise<RecurringItemSettings> {
    const row = await createRecurringItem(
      prisma,
      {
        name: "定期試験 家賃",
        direction: "withdrawal",
        amount: "123,400",
        frequency: "monthly",
        dayOfMonth: "31",
        startDate: "2082-04-01",
        walletId: bank.id,
        accountId: refs.account("5300"),
        taxCategoryCode: "purchase_10",
        segmentId: refs.segment("corporate"),
        ...overrides,
      },
      { actor },
    );
    created.push(row.id);
    return row;
  }

  const post = (
    recurringItemId: string,
    month: string,
    amount: string,
    today: CalendarDate = TODAY,
  ) => postRecurringOccurrence(prisma, { recurringItemId, month, amount }, { actor, today });

  async function dueOf(itemId: string, today: CalendarDate = TODAY) {
    return (await listDueRecurringOccurrences(prisma, today)).filter(
      (row) => row.recurringItemId === itemId,
    );
  }

  async function linesOf(entryId: string) {
    const lines = await prisma.journalLine.findMany({
      where: { journalEntryId: entryId },
      orderBy: { lineNo: "asc" },
      select: {
        side: true,
        amount: true,
        taxCategoryCode: true,
        subAccountId: true,
        account: { select: { code: true } },
      },
    });
    return lines.map((line) => [
      line.side,
      line.account.code,
      line.amount,
      line.taxCategoryCode,
      line.subAccountId,
    ]);
  }

  async function addLine(
    wallet: { id: string },
    txnDate: CalendarDate,
    amount: bigint,
    text: string,
  ) {
    externalNo += 1;
    const row = await prisma.walletTransaction.create({
      data: {
        id: `01TESTRCP${String(externalNo).padStart(17, "0")}`,
        walletId: wallet.id,
        txnDate: toDbDate(txnDate),
        amount,
        descriptionRaw: text,
        externalId: `test-recurring-post-${externalNo}`,
      },
    });
    return row.id;
  }

  it("lists the due occurrences and posts one as 支出 with its audit log", async () => {
    const rent = await item({});
    const due = await dueOf(rent.id);
    expect(due).toEqual([
      expect.objectContaining({
        key: `${rent.id}:2082-04`,
        date: "2082-04-30",
        month: "2082-04",
        type: "expense",
        walletId: bank.id,
        walletName: "定期試験 銀行",
        counterpartName: "地代家賃",
        amount: 123_400n,
        mode: "post",
      }),
      expect.objectContaining({ date: "2082-05-31", month: "2082-05" }),
    ]);
    // 2082-06-30 is not due yet; before the start (2082-03) nothing happens.
    expect(due.map((row) => row.month)).not.toContain("2082-06");

    const result = await post(rent.id, "2082-04", "123,400");
    expect(result).toMatchObject({ recurringItemId: rent.id, month: "2082-04" });
    const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: result.entry.id } });
    expect(entry).toMatchObject({
      kind: "normal",
      status: "posted",
      sourceKind: "recurring",
      sourceId: `${rent.id}:2082-04`,
      entryDate: toDbDate("2082-04-30"),
      description: "定期試験 家賃（2082 年 4 月分）",
      createdBy: actor,
    });
    expect(await linesOf(entry.id)).toEqual([
      ["debit", "5300", 123_400n, "purchase_10", null],
      ["credit", "1100", 123_400n, "na", bank.subAccountId],
    ]);
    const audit = await prisma.auditLog.findMany({
      where: { OR: [{ entityId: entry.id }, { entityId: rent.id, action: "recurring_item.post" }] },
      orderBy: [{ at: "asc" }, { id: "asc" }],
      select: { action: true, entity: true, actor: true, after: true },
    });
    expect(audit.map((row) => row.action).sort()).toEqual([
      "journal_entry.post",
      "recurring_item.post",
    ]);
    expect(audit.find((row) => row.action === "recurring_item.post")).toMatchObject({
      entity: "recurring_item",
      actor,
      after: { month: "2082-04", journalEntryId: entry.id, amount: "123400" },
    });

    expect((await dueOf(rent.id)).map((row) => row.month)).toEqual(["2082-05"]);
    expect(await describeRecurringSource(prisma, entry.sourceId)).toEqual({
      recurringItemId: rent.id,
      name: "定期試験 家賃",
      month: "2082-04",
    });
    // The amount can be changed on the row: 2082-05 with what the bank actually took.
    const may = await post(rent.id, "2082-05", "120,000");
    expect(await linesOf(may.entry.id)).toEqual([
      ["debit", "5300", 120_000n, "purchase_10", null],
      ["credit", "1100", 120_000n, "na", bank.subAccountId],
    ]);
    expect(await dueOf(rent.id)).toEqual([]);
  });

  it("refuses a second registration of the same month, also when two arrive at once", async () => {
    const fee = await item({ name: "定期試験 保守料", amount: "8,800", dayOfMonth: "5" });
    const first = await post(fee.id, "2082-05", "8,800");
    const again = await rejectionOf(post(fee.id, "2082-05", "8,800"));
    expect(again).toBeInstanceOf(SettingsError);
    expect((again as Error).message).toBe(
      `定期試験 保守料の 2082 年 5 月分は登録済みです（No. ${first.entry.no}）`,
    );

    const results = await Promise.allSettled([
      post(fee.id, "2082-06", "8,800"),
      post(fee.id, "2082-06", "8,800"),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((result) => result.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(SettingsError);
    expect(
      await prisma.journalEntry.count({
        where: { sourceKind: "recurring", sourceId: `${fee.id}:2082-06` },
      }),
    ).toBe(1);
  });

  it("refuses months that are not due: future, too old, before the start, after the end", async () => {
    const short = await item({
      name: "定期試験 短期",
      amount: "1,100",
      dayOfMonth: "10",
      startDate: "2082-04-15",
      endDate: "2082-06-30",
    });
    const message = async (month: string, today: CalendarDate = TODAY) =>
      ((await rejectionOf(post(short.id, month, "1,100", today))) as Error).message;
    expect(await message("2082-04")).toBe(
      "定期試験 短期の 2082 年 4 月分は開始日（2082/04/15）より前です",
    );
    expect(await message("2082-07", "2082-08-01")).toBe(
      "定期試験 短期の 2082 年 7 月分は終了日（2082/06/30）より後です",
    );
    expect(await message("2082-06", "2082-06-09")).toBe(
      "定期試験 短期の 2082 年 6 月分はまだ予定日が来ていません（2082/06/10）",
    );
    expect(await message("2082-05", "2082-08-11")).toBe(
      "定期試験 短期の 2082 年 5 月分は 3 か月より前の予定日です。取引の画面で登録してください",
    );
    const yearly = await item({
      name: "定期試験 年払い",
      frequency: "yearly",
      monthOfYear: "5",
      dayOfMonth: "1",
    });
    expect(((await rejectionOf(post(yearly.id, "2082-04", "1,100"))) as Error).message).toBe(
      "定期試験 年払いは 2082 年 4 月に予定日がありません",
    );
    await updateRecurringItem(prisma, yearly.id, { isActive: false }, { actor });
    expect(((await rejectionOf(post(yearly.id, "2082-05", "1,100"))) as Error).message).toBe(
      "定期試験 年払いは無効です。設定 › 定期取引 で有効にしてから登録してください",
    );
    expect(await rejectionOf(post(short.id, "2082-05", "0"))).toMatchObject({
      name: "ZodError",
    });
  });

  it("can register a month again after its entry is voided, and keeps the history", async () => {
    const lease = await item({ name: "定期試験 リース", amount: "33,000", dayOfMonth: "20" });
    const first = await post(lease.id, "2082-05", "33,000");
    expect((await dueOf(lease.id)).map((row) => row.month)).toEqual(["2082-04"]);
    await voidJournalEntryWithOpenDate(prisma, first.entry.id, { reason: "金額の誤り" }, { actor });
    expect((await dueOf(lease.id)).map((row) => row.month)).toEqual(["2082-04", "2082-05"]);
    const second = await post(lease.id, "2082-05", "30,000");
    expect(second.entry.no).toBeGreaterThan(first.entry.no);
    const june = await post(lease.id, "2082-06", "33,000", "2082-06-25");

    const history = await listRecurringEntries(prisma, lease.id);
    expect(history.map((row) => [row.no, row.month, row.amount, row.voided])).toEqual([
      [june.entry.no, "2082-06", 33_000n, false],
      [second.entry.no, "2082-05", 30_000n, false],
      [first.entry.no, "2082-05", 33_000n, true],
    ]);

    // 訂正 is not 取消: the corrected month stays registered through its replacement.
    const corrected = await correctJournalEntry(
      prisma,
      june.entry.id,
      {
        reason: "金額の誤り",
        replacement: {
          kind: "normal",
          entryDate: "2082-06-20",
          description: "定期試験 リース（2082 年 6 月分）",
          partnerId: "",
          memoTagIds: [],
          lines: [
            {
              side: "debit",
              accountId: refs.account("5300"),
              amount: "31,000",
              taxCategoryCode: "purchase_10",
              segmentId: refs.segment("corporate"),
            },
            {
              side: "credit",
              accountId: bank.accountId,
              subAccountId: bank.subAccountId ?? "",
              amount: "31,000",
              taxCategoryCode: "na",
            },
          ],
        },
      },
      { actor },
    );
    expect((await dueOf(lease.id, "2082-06-25")).map((row) => row.month)).toEqual(["2082-04"]);
    const refused = await rejectionOf(post(lease.id, "2082-06", "31,000", "2082-06-25"));
    expect((refused as Error).message).toBe(
      `定期試験 リースの 2082 年 6 月分は登録済みです（No. ${corrected.replacement.no}）`,
    );
    expect((await listRecurringEntries(prisma, lease.id))[0]).toMatchObject({
      no: june.entry.no,
      voided: true,
      replacedByNo: corrected.replacement.no,
    });
  });

  it("matches the item on a statement line, and a month registered from it is no longer due", async () => {
    const telecom = await item({
      name: "定期試験 回線",
      amount: "7,700",
      dayOfMonth: "15",
      accountId: refs.account("5320"),
    });
    expect((await dueOf(telecom.id)).map((row) => row.month)).toEqual(["2082-04", "2082-05"]);

    const lineId = await addLine(bank, "2082-05-17", -7_700n, "定期試験 回線料 05/17");
    const row = await getWalletTransaction(prisma, lineId);
    expect(row?.suggestion).toMatchObject({
      mode: "register",
      source: "recurring",
      recurringItemId: telecom.id,
      autoPost: false,
      accountId: refs.account("5320"),
      taxCategoryCode: "purchase_10",
      segmentId: refs.segment("corporate"),
    });
    expect(row?.recurring).toEqual({ id: telecom.id, name: "定期試験 回線" });

    await registerWalletTransaction(
      prisma,
      lineId,
      {
        description: "",
        partnerId: "",
        lines: [
          {
            accountId: refs.account("5320"),
            amount: "",
            taxCategoryCode: "purchase_10",
            segmentId: refs.segment("corporate"),
          },
        ],
      },
      { actor },
    );
    // (b): the statement's entry has the wallet's line and the item's account line of 7,700.
    expect((await dueOf(telecom.id)).map((row) => row.month)).toEqual(["2082-04"]);
    const other = await addLine(bank, "2082-05-20", -7_700n, "定期試験 別の出金");
    expect((await getWalletTransaction(prisma, other))?.suggestion).toMatchObject({
      recurringItemId: null,
    });
    expect((await getWalletTransaction(prisma, other))?.recurring).toBeNull();

    // A hand-written entry of the month counts too, whatever its source.
    const april = await addLine(bank, "2082-04-15", -7_700n, "定期試験 回線料 04/15");
    expect((await getWalletTransaction(prisma, april))?.suggestion?.recurringItemId).toBe(
      telecom.id,
    );
  });

  it("leaves a wallet that imports its statements to 明細で登録する", async () => {
    const imported = await item({
      name: "定期試験 取込口座の家賃",
      amount: "45,000",
      dayOfMonth: "25",
      walletId: importing.id,
    });
    expect(await dueOf(imported.id)).toEqual([
      expect.objectContaining({ month: "2082-04", mode: "statement", walletId: importing.id }),
      expect.objectContaining({ month: "2082-05", mode: "statement" }),
    ]);
    const refused = await rejectionOf(post(imported.id, "2082-05", "45,000"));
    expect(refused).toBeInstanceOf(SettingsError);
    expect((refused as Error).message).toBe("この口座は明細から登録します。明細を開いてください");
    expect(await countDueRecurringOccurrences(prisma, TODAY)).toBe(
      (await listDueRecurringOccurrences(prisma, TODAY)).length,
    );
    expect(await recurringDueTodo(prisma, TODAY)).toEqual([
      expect.objectContaining({
        key: "recurring-due",
        tone: "count",
        label: "定期取引を登録する",
        href: "/settings/recurring/due",
      }),
    ]);
  });

  it("posts a 振替 to the other wallet, chosen as the item's account", async () => {
    await expect(
      item({ name: "定期試験 同じ口座", transferWalletId: bank.id, accountId: "" }),
    ).rejects.toMatchObject({ field: "accountId" });
    const withdrawal = await item({
      name: "定期試験 カードの引落し",
      amount: "45,600",
      dayOfMonth: "27",
      accountId: "",
      transferWalletId: card.id,
      taxCategoryCode: "",
    });
    expect(withdrawal).toMatchObject({
      transferWalletId: card.id,
      transferWalletName: "定期試験 カード",
      accountId: card.accountId,
      cashEffect: -45_600n,
    });
    expect(await dueOf(withdrawal.id)).toEqual([
      expect.objectContaining({
        month: "2082-04",
        type: "transfer",
        counterpartName: "定期試験 カード",
      }),
      expect.objectContaining({ month: "2082-05" }),
    ]);
    const result = await post(withdrawal.id, "2082-04", "45,600");
    const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: result.entry.id } });
    expect(entry).toMatchObject({ kind: "transfer", sourceKind: "recurring" });
    expect(await linesOf(entry.id)).toEqual([
      ["debit", "2100", 45_600n, "na", card.subAccountId],
      ["credit", "1100", 45_600n, "na", bank.subAccountId],
    ]);
    const line = await addLine(bank, "2082-05-26", -45_600n, "定期試験 カード引落");
    expect((await getWalletTransaction(prisma, line))?.suggestion).toMatchObject({
      mode: "transfer",
      source: "recurring",
      recurringItemId: withdrawal.id,
      transferToWalletId: card.id,
      sources: { transfer: "recurring" },
    });

    // A new 科目 alone turns it back into 支出.
    const back = await updateRecurringItem(
      prisma,
      withdrawal.id,
      { accountId: refs.account("5320") },
      { actor },
    );
    expect(back).toMatchObject({ transferWalletId: null, accountId: refs.account("5320") });
    const again = await updateRecurringItem(
      prisma,
      withdrawal.id,
      { transferWalletId: card.id },
      { actor },
    );
    expect(again).toMatchObject({ transferWalletId: card.id, accountId: card.accountId });
    expect(
      (await listRecurringItems(prisma)).find((row) => row.id === withdrawal.id),
    ).toMatchObject({ transferWalletName: "定期試験 カード" });
  });

  it("takes the only wallet on a #19 row's account as the other wallet, and asks when there are two", async () => {
    const account = await createAccount(
      prisma,
      {
        code: "2187",
        name: "未払金（定期の試験）",
        kind: "liability",
        group: "current_liabilities",
      },
      { actor },
    );
    const own = await createWallet(
      prisma,
      { name: "定期試験 カード B", kind: "card", accountId: account.id },
      { actor },
    );
    const ownWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: own.id } });
    const legacy = await item({
      name: "定期試験 カード B の引落し",
      amount: "31,000",
      dayOfMonth: "25",
      accountId: account.id,
      taxCategoryCode: "",
    });
    expect(legacy.transferWalletId).toBeNull();
    const result = await post(legacy.id, "2082-05", "31,000");
    const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: result.entry.id } });
    expect(entry.kind).toBe("transfer");
    expect(await linesOf(entry.id)).toEqual([
      ["debit", "2187", 31_000n, "na", ownWallet.subAccountId],
      ["credit", "1100", 31_000n, "na", bank.subAccountId],
    ]);
    expect(await recurringEntryTemplate(prisma, legacy.id)).toMatchObject({
      type: "transfer",
      fromWalletId: bank.id,
      toWalletId: own.id,
    });

    await createWallet(
      prisma,
      { name: "定期試験 カード C", kind: "card", accountId: account.id },
      { actor },
    );
    expect(await dueOf(legacy.id)).toEqual([
      expect.objectContaining({ month: "2082-04", type: null, counterpartName: "相手の口座" }),
    ]);
    const refused = await rejectionOf(post(legacy.id, "2082-04", "31,000"));
    expect((refused as Error).message).toBe("相手の口座を選んでください（設定 › 定期取引）");
    expect(await recurringEntryTemplate(prisma, legacy.id)).toBeNull();
  });

  it("leaves closed months out and refuses them as the ledger does", async () => {
    const closed = await item({
      name: "定期試験 締めた月",
      amount: "9,900",
      dayOfMonth: "20",
      startDate: "2083-04-01",
    });
    const today: CalendarDate = "2083-05-25";
    expect((await dueOf(closed.id, today)).map((row) => row.month)).toEqual(["2083-05"]);
    const refused = await rejectionOf(post(closed.id, "2083-04", "9,900", today));
    expect(refused).toBeInstanceOf(LedgerValidationError);
    expect((refused as LedgerValidationError).errors).toEqual([
      expect.objectContaining({
        code: "PERIOD_LOCKED",
        message:
          "2083/04/30 までは締めています。登録するには 設定 › 会計期間 で締めを戻してください",
        field: "entryDate",
      }),
    ]);
  });

  it("refuses an item without a tax category or segment, saying where to fix it", async () => {
    const bareAccount = await createAccount(
      prisma,
      { code: "5987", name: "定期試験費", kind: "expense", group: "sga" },
      { actor },
    );
    // An account without a default tax category (the screens give every new account one).
    await prisma.account.update({
      where: { id: bareAccount.id },
      data: { defaultTaxCategoryCode: null },
    });
    const bare = await item({
      name: "定期試験 税区分なし",
      amount: "2,200",
      dayOfMonth: "1",
      accountId: bareAccount.id,
      taxCategoryCode: "",
    });
    expect(((await rejectionOf(post(bare.id, "2082-05", "2,200"))) as Error).message).toBe(
      "税区分を選んでください（設定 › 定期取引）",
    );
    const noSegment = await item({
      name: "定期試験 セグメントなし",
      amount: "2,300",
      dayOfMonth: "1",
      accountId: bareAccount.id,
      segmentId: "",
    });
    expect(noSegment.segmentId).toBeNull();
    const refused = (await rejectionOf(
      post(noSegment.id, "2082-05", "2,300"),
    )) as LedgerValidationError;
    expect(refused).toBeInstanceOf(LedgerValidationError);
    expect(refused.errors).toEqual([
      expect.objectContaining({
        code: "SEGMENT_REQUIRED",
        field: "segmentId",
        message: "セグメントを選んでください（設定 › 定期取引）",
      }),
    ]);
  });

  it("posts a 収入 and offers the templates of the entries it can build", async () => {
    const sales = await item({
      name: "定期試験 保守の売上",
      direction: "deposit",
      amount: "330,000",
      dayOfMonth: "10",
      accountId: refs.account("4010"),
      taxCategoryCode: "sales_10",
    });
    const result = await post(sales.id, "2082-05", "330,000");
    expect(await linesOf(result.entry.id)).toEqual([
      ["debit", "1100", 330_000n, "na", bank.subAccountId],
      ["credit", "4010", 330_000n, "sales_10", null],
    ]);
    const wrong = await item({
      name: "定期試験 売上の出金",
      amount: "1,000",
      accountId: refs.account("4010"),
      taxCategoryCode: "sales_10",
    });
    const templates = await listRecurringEntryTemplates(prisma);
    const names = templates.map((template) => template.name);
    expect(names).toContain("定期試験 保守の売上");
    expect(names).not.toContain("定期試験 売上の出金");
    expect(await recurringEntryTemplate(prisma, sales.id)).toEqual({
      recurringItemId: sales.id,
      name: "定期試験 保守の売上",
      type: "income",
      walletId: bank.id,
      accountId: refs.account("4010"),
      taxCategoryCode: "sales_10",
      partnerId: null,
      segmentId: refs.segment("corporate"),
      amount: 330_000n,
      description: "定期試験 保守の売上",
    });
    expect(await recurringEntryTemplate(prisma, wrong.id)).toBeNull();
    expect(await recurringEntryTemplate(prisma, "missing")).toBeNull();
  });
});

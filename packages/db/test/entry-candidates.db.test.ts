import type { PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createAccount,
  loadEntryCandidates,
  postSimpleEntry,
  setAccountActive,
  setPartnerActive,
  voidJournalEntryWithOpenDate,
  type EntryCandidates,
} from "../src";
import { newId } from "../src/ids";
import { hasTestDatabase } from "./support/database";
import { testPrisma } from "./support/prisma";
import { createFiscalYear, seededRefs, type SeededRefs } from "./support/refs";

const actor = "tester@example.com";

/**
 * 最近の候補と取引先の前回の値 (11 §4.7). The candidates read the newest lines of the whole book, so
 * this file works in 第 300 期 (2190), later than every other test's entries.
 */
describe.skipIf(!hasTestDatabase)("loadEntryCandidates (最近の候補)", () => {
  let prisma: PrismaClient;
  let refs: SeededRefs;
  let candidates: EntryCandidates;
  const partners = new Map<string, string>();
  const partner = (key: string) => {
    const id = partners.get(key);
    if (!id) throw new Error(`no partner ${key}`);
    return id;
  };
  let retiredAccountId: string;

  beforeAll(async () => {
    prisma = testPrisma();
    refs = await seededRefs(prisma);
    await createFiscalYear(prisma, { no: 300, startDate: "2190-04-01", endDate: "2191-03-31" });
    const wallet = async (name: string) =>
      (await prisma.wallet.findFirstOrThrow({ where: { name } })).id;
    const card = `wallet:${await wallet("架空カード")}`;
    for (const key of [
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "client",
      "dormant",
      "voided",
    ]) {
      const row = await prisma.partner.create({
        data: { id: newId(), name: `架空候補 ${key}`, kind: "vendor" },
      });
      partners.set(key, row.id);
    }
    retiredAccountId = (
      await createAccount(
        prisma,
        { code: "5961", name: "架空の候補費", kind: "expense", group: "sga" },
        { actor },
      )
    ).id;

    const post = (values: Record<string, unknown>) =>
      postSimpleEntry(
        prisma,
        {
          type: "expense",
          entryDate: "2190-05-01",
          description: "候補の試験",
          counterpart: card,
          accountId: refs.account("5320"),
          amount: "1,100",
          taxCategoryCode: "purchase_10",
          segmentId: refs.segment("corporate"),
          partnerId: "",
          memoTagIds: [],
          ...values,
        },
        { actor },
      );
    const expense = (date: string, code: string, key: string, segment = "corporate") =>
      post({
        entryDate: date,
        accountId: refs.account(code),
        partnerId: partner(key),
        segmentId: refs.segment(segment),
      });

    await expense("2190-05-01", "5320", "one", "platform");
    // The client's 支出 is older than its 収入; the 収入 goes to 売掛金, whose line has the partner too.
    await expense("2190-05-02", "5330", "client", "contract");
    await post({
      type: "income",
      entryDate: "2190-05-03",
      counterpart: `account:${refs.account("1200")}`,
      accountId: refs.account("4040"),
      taxCategoryCode: "sales_10",
      segmentId: refs.segment("contract"),
      partnerId: partner("client"),
    });
    await expense("2190-05-04", "5300", "two");
    await expense("2190-05-05", "5310", "three");
    await expense("2190-05-06", "5340", "four");
    await expense("2190-05-07", "5350", "five");
    await expense("2190-05-08", "5360", "six");
    // Then made inactive: the account and the partner are not offered any more.
    await post({ entryDate: "2190-05-09", accountId: retiredAccountId, partnerId: partner("six") });
    await expense("2190-05-09", "5320", "dormant");
    await setAccountActive(prisma, { id: retiredAccountId, isActive: false }, { actor });
    await setPartnerActive(prisma, { id: partner("dormant"), isActive: false }, { actor });
    // Voided: neither the entry nor its reversal counts.
    const voided = await expense("2190-05-10", "5370", "voided");
    await voidJournalEntryWithOpenDate(prisma, voided.id, { reason: "二重計上" }, { actor });

    candidates = await loadEntryCandidates(prisma);
  });

  it("lists the accounts used last, five at most, without inactive or voided ones", () => {
    expect(candidates.recentAccounts.expense).toEqual(
      ["5320", "5360", "5350", "5340", "5310"].map((code) => refs.account(code)),
    );
    // 伝票: every account not tied to a wallet (the card's 未払金 is left out).
    expect(candidates.recentAccounts.voucher).toEqual(
      ["5320", "5360", "5350", "5340", "5310"].map((code) => refs.account(code)),
    );
    expect(candidates.recentAccounts.income[0]).toBe(refs.account("4040"));
    expect(candidates.recentAccounts.income).toHaveLength(
      new Set(candidates.recentAccounts.income).size,
    );
    for (const list of Object.values(candidates.recentAccounts)) {
      expect(list.length).toBeLessThanOrEqual(5);
      expect(list).not.toContain(refs.account("5370"));
      expect(list).not.toContain(retiredAccountId);
    }
    // The receivable of a sale is not something a 支出 chose.
    expect(candidates.recentAccounts.expense).not.toContain(refs.account("1200"));
  });

  it("lists the partners used last, five at most, without inactive or voided ones", () => {
    expect(candidates.recentPartnerIds).toEqual(
      ["six", "five", "four", "three", "two"].map(partner),
    );
  });

  it("keeps each partner's last 収入 and 支出 apart", () => {
    expect(candidates.partnerPresets[partner("client")]).toEqual({
      income: {
        accountId: refs.account("4040"),
        taxCategoryCode: "sales_10",
        segmentId: refs.segment("contract"),
      },
      // Not the 売掛金 line of the newer 収入.
      expense: {
        accountId: refs.account("5330"),
        taxCategoryCode: "purchase_10",
        segmentId: refs.segment("contract"),
      },
    });
    expect(candidates.partnerPresets[partner("one")]).toEqual({
      expense: {
        accountId: refs.account("5320"),
        taxCategoryCode: "purchase_10",
        segmentId: refs.segment("platform"),
      },
    });
  });

  it("keeps the last values as they were, and leaves out inactive and voided partners", () => {
    // The form no longer offers the account and skips it; the preset says what was used.
    expect(candidates.partnerPresets[partner("six")]?.expense?.accountId).toBe(retiredAccountId);
    expect(candidates.partnerPresets[partner("dormant")]).toBeUndefined();
    expect(candidates.partnerPresets[partner("voided")]).toBeUndefined();
  });
});

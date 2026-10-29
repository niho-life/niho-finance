import type { CalendarDate } from "@niho-finance/ledger";
import { describe, expect, it } from "vitest";
import {
  buildFirstMonthGuide,
  FIRST_MONTH_STEP_KEYS,
  readSetupGuideState,
  type FirstMonthFacts,
  type FirstMonthStepKey,
  type SetupGuideState,
} from "../src/first-month";

const today: CalendarDate = "2026-11-20";

/** A book just out of the setup wizard: nothing of the guide is done yet. */
const NEW_BOOK: FirstMonthFacts = {
  hasImportBatch: false,
  stripe: { hasWallet: false, connected: false },
  activeRecurringCount: 0,
  policyEffectiveOn: null,
  activePartnerCount: 0,
  foundingDeadlines: [],
};

const EMPTY: SetupGuideState = { checked: {}, shownAt: null };

const ALL_DONE: FirstMonthFacts = {
  hasImportBatch: true,
  stripe: { hasWallet: true, connected: true },
  activeRecurringCount: 2,
  policyEffectiveOn: "2026-11-10",
  activePartnerCount: 3,
  foundingDeadlines: [
    { id: "d1", title: "法人設立届出書（税務署）", dueDate: "2027-01-02", completed: true },
  ],
};

function step(guide: ReturnType<typeof buildFirstMonthGuide>, key: FirstMonthStepKey) {
  const found = guide.steps.find((item) => item.key === key);
  if (!found) throw new Error(`no step ${key}`);
  return found;
}

function checked(...keys: FirstMonthStepKey[]): SetupGuideState {
  return {
    checked: Object.fromEntries(
      keys.map((key) => [key, { at: "2026-11-15T01:00:00.000Z", by: "owner@example.com" }]),
    ),
    shownAt: null,
  };
}

function deadline(id: string, dueDate: CalendarDate, completed = false) {
  return { id, title: `届出 ${id}`, dueDate, completed };
}

describe("buildFirstMonthGuide (10 §3.1)", () => {
  it("lists the six steps of a new book, none done, and shows the card", () => {
    const guide = buildFirstMonthGuide(NEW_BOOK, EMPTY, today);
    expect(guide.steps.map((item) => item.key)).toEqual([...FIRST_MONTH_STEP_KEYS]);
    expect(guide.steps.map((item) => item.title)).toEqual([
      "税務の届出",
      "明細の取込",
      "Stripe の接続",
      "定期取引の登録（家賃・役員報酬）",
      "証憑の規程",
      "取引先の登録",
    ]);
    expect(guide.total).toBe(6);
    expect(guide.doneCount).toBe(0);
    expect(guide.allDone).toBe(false);
    expect(guide.shownAgain).toBe(false);
    expect(guide.visible).toBe(true);
    for (const item of guide.steps) {
      expect(item.done).toBe(false);
      expect(item.doneBy).toBeNull();
      expect(item.checkedAt).toBeNull();
      // Owner-facing text: no internal identifiers.
      expect(item.description).not.toMatch(/[a-z]+[._][a-z]+/);
    }
    expect(guide.steps.map((item) => [item.href, item.cta])).toEqual([
      ["/calendar", "期限を見る"],
      ["/imports", "取り込む"],
      ["/settings/wallets", "口座を作る"],
      ["/settings/recurring", "登録する"],
      ["/settings/documents-policy", "定める"],
      ["/settings/partners", "登録する"],
    ]);
  });

  it("marks the import, the policy and the recurring items done from the book", () => {
    const guide = buildFirstMonthGuide(
      {
        ...NEW_BOOK,
        hasImportBatch: true,
        policyEffectiveOn: "2026-11-10",
        activeRecurringCount: 1,
      },
      EMPTY,
      today,
    );
    expect(guide.doneCount).toBe(3);
    for (const key of ["import", "records-policy", "recurring"] as const) {
      expect(step(guide, key)).toMatchObject({ done: true, doneBy: "auto" });
    }
    for (const key of ["filings", "stripe", "partners"] as const) {
      expect(step(guide, key)).toMatchObject({ done: false, doneBy: null });
    }
    expect(guide.visible).toBe(true);
  });

  it("marks partners and the Stripe connection done from the book", () => {
    const guide = buildFirstMonthGuide(
      { ...NEW_BOOK, activePartnerCount: 1, stripe: { hasWallet: true, connected: true } },
      EMPTY,
      today,
    );
    expect(step(guide, "partners").doneBy).toBe("auto");
    expect(step(guide, "stripe").doneBy).toBe("auto");
  });

  it("counts a step checked by hand as manual, and the book's own as auto when both apply", () => {
    const guide = buildFirstMonthGuide(
      { ...NEW_BOOK, activePartnerCount: 2 },
      checked("stripe", "partners"),
      today,
    );
    expect(step(guide, "stripe")).toMatchObject({
      done: true,
      doneBy: "manual",
      checkedAt: "2026-11-15T01:00:00.000Z",
    });
    expect(step(guide, "partners")).toMatchObject({
      done: true,
      doneBy: "auto",
      checkedAt: "2026-11-15T01:00:00.000Z",
    });
    expect(guide.doneCount).toBe(2);
  });

  it("hides the card once every step is done, and shows it again after ホームに表示する", () => {
    const done = buildFirstMonthGuide(ALL_DONE, EMPTY, today);
    expect(done).toMatchObject({ doneCount: 6, allDone: true, shownAgain: false, visible: false });

    const byHand = buildFirstMonthGuide(
      NEW_BOOK,
      checked("filings", "import", "stripe", "recurring", "records-policy", "partners"),
      today,
    );
    expect(byHand).toMatchObject({ doneCount: 6, allDone: true, visible: false });

    const shown = buildFirstMonthGuide(
      ALL_DONE,
      { checked: {}, shownAt: "2026-11-21T00:00:00.000Z" },
      today,
    );
    expect(shown).toMatchObject({ allDone: true, shownAgain: true, visible: true });

    // Shown again while something is left: the card shows for that reason anyway.
    const left = buildFirstMonthGuide(
      NEW_BOOK,
      { checked: {}, shownAt: "2026-11-21T00:00:00.000Z" },
      today,
    );
    expect(left).toMatchObject({ allDone: false, shownAgain: true, visible: true });
  });

  it("says the Stripe step's entry once a Stripe wallet exists", () => {
    const guide = buildFirstMonthGuide(
      { ...NEW_BOOK, stripe: { hasWallet: true, connected: false } },
      EMPTY,
      today,
    );
    expect(step(guide, "stripe")).toMatchObject({
      href: "/imports",
      cta: "接続する",
      done: false,
    });
    const none = step(buildFirstMonthGuide(NEW_BOOK, EMPTY, today), "stripe");
    expect(none).toMatchObject({ href: "/settings/wallets", cta: "口座を作る" });
    expect(none.description).toContain("設定 › 口座");
  });

  describe("filings", () => {
    it("is not done before the morning sync made the deadlines", () => {
      const filings = step(buildFirstMonthGuide(NEW_BOOK, EMPTY, today), "filings");
      expect(filings).toMatchObject({
        done: false,
        noDeadlinesYet: true,
        deadlines: [],
        moreDeadlines: 0,
      });
    });

    it("lists the three nearest open deadlines and counts the rest", () => {
      const facts: FirstMonthFacts = {
        ...NEW_BOOK,
        foundingDeadlines: [
          deadline("e", "2027-03-31"),
          deadline("a", "2026-12-01"),
          deadline("done", "2026-11-01", true),
          deadline("c", "2027-01-02"),
          deadline("b", "2026-12-20"),
          deadline("d", "2027-02-28"),
        ],
      };
      const filings = step(buildFirstMonthGuide(facts, EMPTY, today), "filings");
      expect(filings.done).toBe(false);
      expect(filings.noDeadlinesYet).toBe(false);
      expect(filings.deadlines.map((item) => item.id)).toEqual(["a", "b", "c"]);
      expect(filings.deadlines[0]).toMatchObject({
        title: "届出 a",
        dueDate: "2026-12-01",
        statusText: "未完了",
        status: "open",
      });
      expect(filings.moreDeadlines).toBe(2);
    });

    it("says the state of each deadline on today (24 §1)", () => {
      const facts: FirstMonthFacts = {
        ...NEW_BOOK,
        foundingDeadlines: [
          deadline("overdue", "2026-11-19"),
          deadline("today", "2026-11-20"),
          deadline("soon", "2026-11-23"),
        ],
      };
      const filings = step(buildFirstMonthGuide(facts, EMPTY, today), "filings");
      expect(filings.deadlines.map((item) => [item.statusText, item.status])).toEqual([
        ["期限切れ", "overdue"],
        ["今日まで", "today"],
        ["あと 3 日", "soon"],
      ]);
      expect(filings.moreDeadlines).toBe(0);
    });

    it("is done when every founding deadline is completed", () => {
      const facts: FirstMonthFacts = {
        ...NEW_BOOK,
        foundingDeadlines: [deadline("a", "2026-12-01", true), deadline("b", "2027-01-02", true)],
      };
      const filings = step(buildFirstMonthGuide(facts, EMPTY, today), "filings");
      expect(filings).toMatchObject({
        done: true,
        doneBy: "auto",
        deadlines: [],
        moreDeadlines: 0,
        noDeadlinesYet: false,
      });
    });

    it("can be checked by hand while deadlines are open", () => {
      const facts: FirstMonthFacts = {
        ...NEW_BOOK,
        foundingDeadlines: [deadline("a", "2026-12-01")],
      };
      const filings = step(buildFirstMonthGuide(facts, checked("filings"), today), "filings");
      expect(filings).toMatchObject({ done: true, doneBy: "manual" });
    });
  });
});

describe("readSetupGuideState", () => {
  it("reads a stored state", () => {
    expect(
      readSetupGuideState({
        checked: { stripe: { at: "2026-11-15T01:00:00.000Z", by: "owner@example.com" } },
        shownAt: "2026-11-21T00:00:00.000Z",
      }),
    ).toEqual({
      checked: { stripe: { at: "2026-11-15T01:00:00.000Z", by: "owner@example.com" } },
      shownAt: "2026-11-21T00:00:00.000Z",
    });
  });

  it("reads null and broken values as nothing checked, without throwing", () => {
    for (const value of [null, undefined, "checked", 42, [], { checked: "all" }, { shownAt: 1 }]) {
      expect(readSetupGuideState(value)).toEqual({ checked: {}, shownAt: null });
    }
  });

  it("ignores unknown keys and broken checks", () => {
    expect(
      readSetupGuideState({
        checked: {
          payroll: { at: "2026-11-15T01:00:00.000Z", by: "owner@example.com" },
          partners: { at: "2026-11-15T01:00:00.000Z" },
          import: "yes",
          recurring: { at: "2026-11-16T01:00:00.000Z", by: "owner@example.com", extra: true },
        },
        shownAt: null,
        other: 1,
      }),
    ).toEqual({
      checked: { recurring: { at: "2026-11-16T01:00:00.000Z", by: "owner@example.com" } },
      shownAt: null,
    });
  });
});

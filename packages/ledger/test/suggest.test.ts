/**
 * 明細の推定とルール (docs/design/15-statements.md §4, §10).
 */
import { describe, expect, it } from "vitest";
import {
  allowedStatementAccount,
  AUDIT_ENTITY_LABELS,
  auditActionLabel,
  bestTransferCandidate,
  compareRules,
  describeRuleAction,
  describeRuleMatch,
  descriptionKey,
  isValidRuleRegex,
  matchesRule,
  normalizeText,
  partnerNameKey,
  RULE_MODE_LABELS,
  RULE_MODES,
  suggest,
  WALLET_TRANSACTION_STATUS_LABELS,
  WALLET_TRANSACTION_STATUSES,
  type RuleAction,
  type RuleMatch,
  type StatementLine,
  type SuggestAccount,
  type SuggestContext,
  type SuggestHistoryItem,
  type SuggestPartner,
  type SuggestRecurringItem,
  type SuggestRule,
  type SuggestWallet,
  type TransferCandidate,
} from "../src";

const account = (
  id: string,
  code: string,
  kind: SuggestAccount["kind"],
  defaultTaxCategoryCode: string | null,
  overrides: Partial<SuggestAccount> = {},
): SuggestAccount => ({
  id,
  code,
  kind,
  defaultTaxCategoryCode,
  defaultSegmentId: null,
  isCashLike: false,
  isActive: true,
  ...overrides,
});

const ACCOUNTS = new Map(
  [
    account("acc_cash", "1000", "asset", "na", { isCashLike: true }),
    account("acc_bank", "1100", "asset", "na", { isCashLike: true }),
    account("acc_stripe", "1150", "asset", "na", { isCashLike: true }),
    account("acc_prepaid", "1300", "asset", "na"),
    account("acc_input_tax", "1400", "asset", "na"),
    account("acc_card", "2100", "liability", "na"),
    account("acc_output_tax", "2310", "liability", "na"),
    account("acc_capital", "3000", "equity", "na"),
    account("acc_sales", "4010", "revenue", "sales_10", { defaultSegmentId: "seg_kamakura" }),
    account("acc_contract", "4040", "revenue", "sales_10", { defaultSegmentId: "seg_contract" }),
    account("acc_rent", "5300", "expense", "purchase_10"),
    account("acc_comm", "5320", "expense", "purchase_10"),
    account("acc_fee", "5400", "expense", "purchase_10"),
    account("acc_old", "5490", "expense", "purchase_10", { isActive: false }),
  ].map((item) => [item.id, item]),
);

const WALLETS = new Map<string, SuggestWallet>(
  [
    { id: "w_bank", accountId: "acc_bank", defaultSegmentId: null, isActive: true },
    { id: "w_card", accountId: "acc_card", defaultSegmentId: null, isActive: true },
    { id: "w_cash", accountId: "acc_cash", defaultSegmentId: "seg_corporate", isActive: true },
    { id: "w_stripe", accountId: "acc_stripe", defaultSegmentId: "seg_platform", isActive: true },
    { id: "w_old", accountId: "acc_bank", defaultSegmentId: null, isActive: false },
  ].map((item) => [item.id, item]),
);

const partner = (overrides: Partial<SuggestPartner> & { id: string; name: string }) => ({
  nameKana: null,
  defaultAccountId: null,
  defaultTaxCategoryCode: null,
  defaultSegmentId: null,
  isActive: true,
  ...overrides,
});

const PARTNERS: SuggestPartner[] = [
  partner({ id: "p_realty", name: "架空不動産株式会社", nameKana: "カクウフドウサン" }),
  partner({
    id: "p_design",
    name: "架空デザイン合同会社",
    nameKana: "カクウデザイン",
    defaultAccountId: "acc_contract",
    defaultTaxCategoryCode: "sales_10",
    defaultSegmentId: "seg_contract",
  }),
  partner({ id: "p_design_lab", name: "架空デザインラボ株式会社", nameKana: "カクウデザインラボ" }),
  partner({ id: "p_cloud", name: "架空クラウド株式会社", nameKana: "カクウクラウド" }),
  partner({ id: "p_short", name: "AB", nameKana: null }),
  partner({ id: "p_gone", name: "架空閉店株式会社", nameKana: "カクウヘイテン", isActive: false }),
];

const NO_MATCH: RuleMatch = {
  descriptionContains: null,
  descriptionRegex: null,
  counterpartyContains: null,
  amountMin: null,
  amountMax: null,
  sign: null,
};

const REGISTER: RuleAction = {
  mode: "register",
  accountId: null,
  taxCategoryCode: null,
  partnerId: null,
  segmentId: null,
  descriptionTemplate: null,
  transferToWalletId: null,
  ignoredReason: null,
};

function rule(overrides: Partial<SuggestRule> & { id: string }): SuggestRule {
  return {
    walletId: null,
    match: { ...NO_MATCH, descriptionContains: "家賃" },
    action: REGISTER,
    autoPost: false,
    priority: 0,
    ...overrides,
  };
}

function line(overrides: Partial<StatementLine> = {}): StatementLine {
  return {
    id: "t_1",
    walletId: "w_bank",
    txnDate: "2027-01-05",
    amount: -88_000n,
    descriptionRaw: "振込 ｶ)ｶｸｳﾌﾄﾞｳｻﾝ",
    counterpartyRaw: null,
    ...overrides,
  };
}

function context(overrides: Partial<SuggestContext> = {}): SuggestContext {
  return {
    rules: [],
    history: new Map(),
    partners: PARTNERS,
    accounts: ACCOUNTS,
    wallets: WALLETS,
    candidates: [],
    ...overrides,
  };
}

function history(items: (Partial<SuggestHistoryItem> & { key: string })[]) {
  const map = new Map<string, SuggestHistoryItem[]>();
  for (const item of items) {
    const full: SuggestHistoryItem = {
      walletId: "w_bank",
      txnDate: "2026-12-05",
      mode: "register",
      accountId: null,
      taxCategoryCode: null,
      partnerId: null,
      segmentId: null,
      transferToWalletId: null,
      ...item,
    };
    map.set(full.key, [...(map.get(full.key) ?? []), full]);
  }
  return map;
}

const candidate = (overrides: Partial<TransferCandidate> & { id: string }): TransferCandidate => ({
  kind: "txn",
  walletId: "w_card",
  date: "2027-01-05",
  amount: 88_000n,
  description: "口座振替",
  entryNo: null,
  ...overrides,
});

describe("descriptionKey and normalizeText", () => {
  it("give lines that differ only by date, case, width or symbols the same key", () => {
    expect(descriptionKey("Vデビット GOOGLE CLOUD JAPAN 11/05")).toBe("vデビットgooglecloudjapan");
    expect(descriptionKey("Vデビット GOOGLE CLOUD JAPAN 12/05")).toBe(
      descriptionKey("Ｖデビット　google cloud japan 1205"),
    );
    expect(descriptionKey("振込 ｶ)ｶｸｳﾌﾄﾞｳｻﾝ")).toBe("振込カカクウフドウサン");
    expect(descriptionKey("振込 ｶｸｳﾃﾞｻﾞｲﾝ(ﾄﾞ")).toBe("振込カクウデザインド");
    expect(descriptionKey("charge 月会費 11月")).toBe(descriptionKey("charge 月会費 1月"));
    expect(descriptionKey("・ー")).toBe("ー");
  });

  it("normalize width and case and trim", () => {
    expect(normalizeText("  ＡＴＭ　ｼｭｯｷﾝ ")).toBe("atm シュッキン");
  });
});

describe("matchesRule", () => {
  const match = (overrides: Partial<RuleMatch>, target: Partial<StatementLine> = {}) =>
    matchesRule({ walletId: null, match: { ...NO_MATCH, ...overrides } }, line(target));

  it("never matches without any condition", () => {
    expect(match({})).toBe(false);
    expect(match({ descriptionContains: "  " })).toBe(false);
  });

  it("checks the wallet (null = every wallet)", () => {
    const condition = { ...NO_MATCH, sign: "out" as const };
    expect(matchesRule({ walletId: "w_bank", match: condition }, line())).toBe(true);
    expect(matchesRule({ walletId: "w_card", match: condition }, line())).toBe(false);
    expect(matchesRule({ walletId: null, match: condition }, line({ walletId: "w_card" }))).toBe(
      true,
    );
  });

  it("checks the sign: in is amount > 0, out is amount < 0", () => {
    expect(match({ sign: "out" })).toBe(true);
    expect(match({ sign: "in" })).toBe(false);
    expect(match({ sign: "in" }, { amount: 1n })).toBe(true);
    expect(match({ sign: "in" }, { amount: 0n })).toBe(false);
    expect(match({ sign: "out" }, { amount: 0n })).toBe(false);
  });

  it("checks |amount| against inclusive bounds", () => {
    expect(match({ amountMin: 50_000n, amountMax: 100_000n })).toBe(true);
    expect(match({ amountMin: 88_000n })).toBe(true);
    expect(match({ amountMax: 88_000n })).toBe(true);
    expect(match({ amountMin: 88_001n })).toBe(false);
    expect(match({ amountMax: 87_999n })).toBe(false);
    expect(match({ amountMin: 1_000n }, { amount: 1_000n })).toBe(true);
  });

  it("finds 「摘要に含む」 ignoring width, case, whitespace, and the digits between words", () => {
    expect(match({ descriptionContains: "カクウフドウサン" })).toBe(true);
    expect(match({ descriptionContains: "ｶｸｳ ﾌﾄﾞｳｻﾝ" })).toBe(true);
    expect(match({ descriptionContains: "カクウデザイン" })).toBe(false);
    expect(
      match(
        { descriptionContains: "vデビットgoogle" },
        { descriptionRaw: "Vデビット 1205 GOOGLE" },
      ),
    ).toBe(true);
    // A condition with digits keeps them: 「11/05」 is not 「12/05」.
    expect(match({ descriptionContains: "11/05" }, { descriptionRaw: "GOOGLE 11/05" })).toBe(true);
    expect(match({ descriptionContains: "11/05" }, { descriptionRaw: "GOOGLE 12/05" })).toBe(false);
  });

  it("tests the regular expression on the normalized description, case-insensitively", () => {
    expect(match({ descriptionRegex: "^振込 カ\\)" })).toBe(true);
    expect(match({ descriptionRegex: "ﾌﾄﾞｳｻﾝ$" })).toBe(false);
    expect(match({ descriptionRegex: "フドウサン$" })).toBe(true);
    expect(match({ descriptionRegex: "ATM" }, { descriptionRaw: "atm 引出" })).toBe(true);
  });

  it("treats an invalid regular expression as no match without throwing", () => {
    expect(() => match({ descriptionRegex: "(" })).not.toThrow();
    expect(match({ descriptionRegex: "(" })).toBe(false);
    expect(match({ descriptionRegex: "(", sign: "out" })).toBe(false);
  });

  it("checks 「振込人に含む」 and never matches a line without a counterparty", () => {
    expect(match({ counterpartyContains: "カクウデザイン" })).toBe(false);
    expect(
      match({ counterpartyContains: "カクウデザイン" }, { counterpartyRaw: "ｶｸｳﾃﾞｻﾞｲﾝ(ﾄﾞ" }),
    ).toBe(true);
  });

  it("requires every set condition (AND)", () => {
    expect(match({ descriptionContains: "カクウフドウサン", sign: "in" })).toBe(false);
    expect(
      match({ descriptionContains: "カクウフドウサン", sign: "out", amountMin: 50_000n }),
    ).toBe(true);
  });
});

describe("rules", () => {
  it("accept regular expressions that compile with iu and are at most 200 characters", () => {
    expect(isValidRuleRegex("^振込\\s+カ\\)")).toBe(true);
    expect(isValidRuleRegex("(")).toBe(false);
    expect(isValidRuleRegex("\\p{Letter}+")).toBe(true);
    expect(isValidRuleRegex("a".repeat(200))).toBe(true);
    expect(isValidRuleRegex("a".repeat(201))).toBe(false);
  });

  it("are tried by priority, highest first, then in creation order", () => {
    const rules = [
      { id: "01B", priority: 0 },
      { id: "01C", priority: 10 },
      { id: "01A", priority: 0 },
      { id: "01D", priority: -5 },
    ];
    expect([...rules].sort(compareRules).map((item) => item.id)).toEqual([
      "01C",
      "01A",
      "01B",
      "01D",
    ]);
  });

  it("are summarized for the table and the display name", () => {
    expect(
      describeRuleMatch({
        ...NO_MATCH,
        descriptionContains: "カクウフドウサン",
        sign: "out",
        amountMin: 50_000n,
        amountMax: 100_000n,
      }),
    ).toBe("摘要に「カクウフドウサン」 · 出金 · 50,000〜100,000");
    expect(describeRuleMatch({ ...NO_MATCH, amountMin: 1_000n })).toBe("1,000 以上");
    expect(describeRuleMatch({ ...NO_MATCH, counterpartyContains: "カクウ", sign: "in" })).toBe(
      "振込人に「カクウ」 · 入金",
    );
    expect(describeRuleMatch(NO_MATCH)).toBe("条件なし");

    const names = {
      accounts: new Map([["acc_rent", "地代家賃"]]),
      partners: new Map([["p_realty", "架空不動産"]]),
      segments: new Map([["seg_kamakura", "鎌倉"]]),
      wallets: new Map([["w_cash", "現金"]]),
    };
    expect(
      describeRuleAction(
        {
          ...REGISTER,
          accountId: "acc_rent",
          taxCategoryCode: "purchase_10",
          partnerId: "p_realty",
          segmentId: "seg_kamakura",
        },
        names,
      ),
    ).toBe("登録: 地代家賃 / 課税仕入 10% / 架空不動産 / 鎌倉");
    expect(
      describeRuleAction({ ...REGISTER, mode: "transfer", transferToWalletId: "w_cash" }, names),
    ).toBe("振替 → 現金");
    expect(describeRuleAction({ ...REGISTER, mode: "ignore" }, names)).toBe("無視");
    expect(describeRuleAction({ ...REGISTER, mode: "ignore", ignoredReason: "私用" }, names)).toBe(
      "無視（私用）",
    );
    expect(describeRuleAction({ ...REGISTER, mode: "suggest", accountId: "acc_x" }, names)).toBe(
      "候補: 不明",
    );
  });

  it("have owner-facing labels for modes, statuses and audit actions", () => {
    for (const mode of RULE_MODES) expect(RULE_MODE_LABELS[mode]).toMatch(/[^\x20-\x7e]/);
    for (const status of WALLET_TRANSACTION_STATUSES) {
      expect(WALLET_TRANSACTION_STATUS_LABELS[status]).toMatch(/[^\x20-\x7e]/);
    }
    expect(AUDIT_ENTITY_LABELS.wallet_transaction).toBe("明細");
    expect(AUDIT_ENTITY_LABELS.rule).toBe("ルール");
    expect(auditActionLabel("wallet_transaction.register")).toBe("明細の登録");
    expect(auditActionLabel("wallet_transaction.reopen")).toBe("明細を未処理に戻す");
    expect(auditActionLabel("rule.apply")).toBe("ルールの適用");
    expect(auditActionLabel("rule.deactivate")).toBe("無効化");
  });
});

describe("allowedStatementAccount", () => {
  const walletAccountIds = new Set(["acc_bank", "acc_card", "acc_cash", "acc_stripe"]);
  const allowed = (id: string, direction: "in" | "out") => {
    const item = ACCOUNTS.get(id);
    if (!item) throw new Error(id);
    return allowedStatementAccount(item, direction, walletAccountIds);
  };

  it("takes revenue, assets, liabilities and equity for money in", () => {
    expect(allowed("acc_sales", "in")).toBe(true);
    expect(allowed("acc_capital", "in")).toBe(true);
    expect(allowed("acc_prepaid", "in")).toBe(true);
    expect(allowed("acc_rent", "in")).toBe(false);
  });

  it("takes expenses, assets and liabilities for money out", () => {
    expect(allowed("acc_rent", "out")).toBe(true);
    expect(allowed("acc_prepaid", "out")).toBe(true);
    expect(allowed("acc_sales", "out")).toBe(false);
    expect(allowed("acc_capital", "out")).toBe(false);
  });

  it("refuses wallets' accounts, cash, the tax lines and inactive accounts", () => {
    for (const id of ["acc_bank", "acc_card", "acc_stripe", "acc_input_tax", "acc_output_tax"]) {
      expect(allowed(id, "out")).toBe(false);
      expect(allowed(id, "in")).toBe(false);
    }
    expect(allowed("acc_old", "out")).toBe(false);
  });
});

describe("partnerNameKey", () => {
  it("leaves out legal forms, also the abbreviations of bank statements", () => {
    expect(partnerNameKey("架空デザイン合同会社")).toBe("架空デザイン");
    expect(partnerNameKey("株式会社架空商店")).toBe("架空商店");
    expect(partnerNameKey("（株）架空商店")).toBe("架空商店");
    expect(partnerNameKey("㈱架空商店")).toBe("架空商店");
    expect(partnerNameKey("ｶ)ｶｸｳﾌﾄﾞｳｻﾝ")).toBe("カクウフドウサン");
    expect(partnerNameKey("ｶｸｳﾃﾞｻﾞｲﾝ(ﾄﾞ")).toBe("カクウデザイン");
    expect(partnerNameKey("カクウデザインゴウドウガイシャ")).toBe("カクウデザイン");
    expect(partnerNameKey("一般社団法人 架空協会")).toBe("架空協会");
  });
});

describe("bestTransferCandidate", () => {
  const candidates = [
    candidate({ id: "c_far", date: "2027-01-10" }),
    candidate({ id: "c_b", date: "2027-01-03" }),
    candidate({ id: "c_a", date: "2027-01-07" }),
    candidate({ id: "c_cash", walletId: "w_cash", date: "2027-01-05" }),
  ];

  it("takes the nearest date, then the smallest id", () => {
    expect(bestTransferCandidate(candidates, "2027-01-05")?.id).toBe("c_cash");
    expect(bestTransferCandidate(candidates, "2027-01-05", "w_card")?.id).toBe("c_a");
    expect(bestTransferCandidate(candidates, "2027-01-09", "w_card")?.id).toBe("c_far");
    expect(bestTransferCandidate(candidates, "2027-01-05", "w_stripe")).toBeNull();
    expect(bestTransferCandidate([], "2027-01-05")).toBeNull();
  });
});

describe("suggest", () => {
  const rentRule = rule({
    id: "r_rent",
    walletId: "w_bank",
    match: { ...NO_MATCH, descriptionContains: "カクウフドウサン", sign: "out" },
    action: {
      ...REGISTER,
      accountId: "acc_rent",
      taxCategoryCode: "purchase_10",
      partnerId: "p_realty",
      segmentId: "seg_kamakura",
    },
  });

  it("1. takes the first matching rule by priority, with solid chips", () => {
    const low = rule({
      id: "r_z_any",
      match: { ...NO_MATCH, sign: "out" },
      action: { ...REGISTER, mode: "ignore" },
      autoPost: true,
    });
    const result = suggest(line(), context({ rules: [low, rentRule] }));
    expect(result).toMatchObject({
      mode: "register",
      source: "rule",
      ruleId: "r_rent",
      autoPost: false,
      accountId: "acc_rent",
      taxCategoryCode: "purchase_10",
      partnerId: "p_realty",
      segmentId: "seg_kamakura",
      sources: { account: "rule", taxCategory: "rule", partner: "rule", segment: "rule" },
    });
    const urgent = { ...low, priority: 10 };
    expect(suggest(line(), context({ rules: [rentRule, urgent] }))).toMatchObject({
      mode: "ignore",
      source: "rule",
      ruleId: "r_z_any",
      autoPost: true,
    });
  });

  it("1. a rule beats a transfer candidate; a transfer rule picks the nearest candidate of its wallet", () => {
    const candidates = [
      candidate({ id: "c_card", walletId: "w_card", date: "2027-01-05" }),
      candidate({ id: "c_cash_far", walletId: "w_cash", date: "2027-01-09" }),
      candidate({ id: "c_cash", walletId: "w_cash", date: "2027-01-06" }),
    ];
    expect(suggest(line(), context({ rules: [rentRule], candidates }))).toMatchObject({
      mode: "register",
      source: "rule",
      candidate: null,
    });
    const atm = rule({
      id: "r_atm",
      match: { ...NO_MATCH, sign: "out" },
      action: { ...REGISTER, mode: "transfer", transferToWalletId: "w_cash" },
      autoPost: true,
    });
    expect(suggest(line(), context({ rules: [atm], candidates }))).toMatchObject({
      mode: "transfer",
      source: "rule",
      autoPost: true,
      transferToWalletId: "w_cash",
      candidate: { kind: "txn", id: "c_cash" },
      sources: { transfer: "rule" },
    });
    expect(suggest(line(), context({ rules: [atm] }))).toMatchObject({
      mode: "transfer",
      transferToWalletId: "w_cash",
      candidate: null,
    });
  });

  it("1. a 候補 rule fills the chips but never posts by itself", () => {
    const hint = rule({
      id: "r_hint",
      match: { ...NO_MATCH, descriptionContains: "カクウフドウサン" },
      action: { ...REGISTER, mode: "suggest", accountId: "acc_rent", descriptionTemplate: "家賃" },
      autoPost: true,
    });
    expect(suggest(line(), context({ rules: [hint] }))).toMatchObject({
      mode: "register",
      source: "rule",
      autoPost: false,
      accountId: "acc_rent",
      description: "家賃",
      // Filled by the later stages: the partner named in the text, the account's tax category.
      partnerId: "p_realty",
      taxCategoryCode: "purchase_10",
      sources: { account: "rule", partner: "partner", taxCategory: "default" },
    });
  });

  it("2. without a rule, the nearest transfer candidate beats the history", () => {
    const candidates = [
      candidate({ id: "c_late", date: "2027-01-08" }),
      candidate({
        id: "c_entry",
        kind: "entry",
        walletId: "w_card",
        date: "2027-01-04",
        entryNo: 13,
      }),
    ];
    const past = history([
      {
        key: descriptionKey("振込 ｶ)ｶｸｳﾌﾄﾞｳｻﾝ"),
        accountId: "acc_rent",
        taxCategoryCode: "purchase_10",
      },
    ]);
    expect(suggest(line(), context({ candidates, history: past }))).toMatchObject({
      mode: "transfer",
      source: "candidate",
      transferToWalletId: "w_card",
      candidate: { kind: "entry", id: "c_entry" },
      accountId: null,
      sources: { transfer: "candidate", account: null },
    });
  });

  it("3. copies the newest settled line with the same key, preferring the same wallet", () => {
    const key = descriptionKey("カクウクラウド 利用料");
    const past = history([
      { key, walletId: "w_bank", accountId: "acc_fee", taxCategoryCode: "purchase_10" },
      {
        key,
        walletId: "w_card",
        accountId: "acc_comm",
        taxCategoryCode: "purchase_10",
        partnerId: "p_cloud",
        segmentId: "seg_platform",
      },
    ]);
    const card = line({
      walletId: "w_card",
      amount: -1_650n,
      descriptionRaw: "カクウクラウド 利用料",
    });
    expect(suggest(card, context({ history: past }))).toMatchObject({
      mode: "register",
      source: "history",
      accountId: "acc_comm",
      taxCategoryCode: "purchase_10",
      partnerId: "p_cloud",
      segmentId: "seg_platform",
      sources: { account: "history", partner: "history", segment: "history" },
    });
    const cash = { ...card, walletId: "w_cash" };
    expect(suggest(cash, context({ history: past }))).toMatchObject({
      source: "history",
      accountId: "acc_fee",
      // Not copied: a later stage fills it (the account has none, so the wallet's segment).
      segmentId: "seg_corporate",
      sources: { segment: "default" },
    });
  });

  it("3. a settled transfer suggests the same other wallet", () => {
    const past = history([
      {
        key: descriptionKey("カード引落 カクウカード"),
        mode: "transfer",
        transferToWalletId: "w_card",
      },
    ]);
    const bank = line({ amount: -9_870n, descriptionRaw: "カード引落 カクウカード 02/27" });
    expect(suggest(bank, context({ history: past }))).toMatchObject({
      mode: "transfer",
      source: "history",
      transferToWalletId: "w_card",
      candidate: null,
      sources: { transfer: "history" },
    });
  });

  it("4. fills only the empty fields from the partner named in the text, the longest name winning", () => {
    const deposit = line({
      amount: 330_000n,
      descriptionRaw: "振込 ｶｸｳﾃﾞｻﾞｲﾝ(ﾄﾞ",
      counterpartyRaw: "ｶｸｳﾃﾞｻﾞｲﾝ(ﾄﾞ",
    });
    expect(suggest(deposit, context())).toMatchObject({
      mode: "register",
      source: "partner",
      partnerId: "p_design",
      accountId: "acc_contract",
      taxCategoryCode: "sales_10",
      segmentId: "seg_contract",
      sources: { partner: "partner", account: "partner", segment: "partner" },
    });
    const lab = { ...deposit, descriptionRaw: "振込 ｶｸｳﾃﾞｻﾞｲﾝﾗﾎﾞ(ｶ", counterpartyRaw: null };
    expect(suggest(lab, context()).partnerId).toBe("p_design_lab");

    const past = history([
      {
        key: descriptionKey(deposit.descriptionRaw),
        accountId: "acc_sales",
        segmentId: "seg_kamakura",
      },
    ]);
    expect(suggest(deposit, context({ history: past }))).toMatchObject({
      source: "history",
      accountId: "acc_sales",
      segmentId: "seg_kamakura",
      partnerId: "p_design",
      taxCategoryCode: "sales_10",
      sources: { account: "history", partner: "partner", taxCategory: "partner" },
    });
  });

  it("4. ignores inactive partners and names shorter than 3 characters", () => {
    expect(
      suggest(line({ descriptionRaw: "AB 振込", amount: -500n }), context()).partnerId,
    ).toBeNull();
    expect(
      suggest(line({ descriptionRaw: "ｶｸｳﾍｲﾃﾝ", amount: -500n }), context()).partnerId,
    ).toBeNull();
  });

  it("5. fills the tax from the account's default only when it fits the direction", () => {
    const hint = (accountId: string) =>
      rule({
        id: "r_hint",
        match: { ...NO_MATCH, descriptionContains: "テスト" },
        action: { ...REGISTER, mode: "suggest", accountId },
      });
    const deposit = line({ amount: 11_000n, descriptionRaw: "テスト 入金" });
    expect(suggest(deposit, context({ rules: [hint("acc_sales")] }))).toMatchObject({
      accountId: "acc_sales",
      taxCategoryCode: "sales_10",
      segmentId: "seg_kamakura",
      sources: { taxCategory: "default", segment: "default" },
    });
    // 前払費用 (default 対象外) for a payment; the wallet's segment fills the segment.
    const paid = line({ walletId: "w_stripe", amount: -1_000n, descriptionRaw: "テスト 前払" });
    expect(suggest(paid, context({ rules: [hint("acc_prepaid")] }))).toMatchObject({
      accountId: "acc_prepaid",
      taxCategoryCode: "na",
      segmentId: "seg_platform",
    });
  });

  it("drops accounts and tax categories that cannot take the line's direction", () => {
    const wrong = rule({
      id: "r_wrong",
      match: { ...NO_MATCH, descriptionContains: "テスト" },
      action: { ...REGISTER, accountId: "acc_sales", taxCategoryCode: "sales_10" },
    });
    const paid = line({ amount: -1_000n, descriptionRaw: "テスト 出金" });
    expect(suggest(paid, context({ rules: [wrong] }))).toMatchObject({
      source: "rule",
      accountId: null,
      taxCategoryCode: null,
    });
    for (const accountId of ["acc_bank", "acc_input_tax", "acc_old"]) {
      const reserved = rule({ ...wrong, action: { ...REGISTER, accountId } });
      expect(suggest(paid, context({ rules: [reserved] })).accountId).toBeNull();
    }
  });

  it("leaves everything empty when nothing is known, except the wallet's segment", () => {
    const shopping = line({ walletId: "w_card", amount: -1_200n, descriptionRaw: "コンビニ 私用" });
    expect(suggest(shopping, context())).toMatchObject({
      mode: "register",
      source: "none",
      accountId: null,
      taxCategoryCode: null,
      partnerId: null,
      segmentId: null,
      candidate: null,
    });
    const cash = { ...shopping, walletId: "w_cash" };
    expect(suggest(cash, context())).toMatchObject({
      source: "default",
      segmentId: "seg_corporate",
      accountId: null,
    });
  });

  it("only ignores a line of 0 yen", () => {
    expect(suggest(line({ amount: 0n }), context({ rules: [rentRule] }))).toMatchObject({
      mode: "ignore",
      source: "none",
    });
  });
});

/** 定期取引の段 (21-cashflow §10.6): rule → candidate → recurring → history → partner → default. */
describe("suggest: the recurring stage", () => {
  const recurring = (
    overrides: Partial<SuggestRecurringItem> & { id: string },
  ): SuggestRecurringItem => ({
    name: "家賃",
    walletId: "w_bank",
    amount: -88_000n,
    frequency: "monthly",
    dayOfMonth: 31,
    monthOfYear: null,
    startDate: "2026-01-01",
    endDate: null,
    transferWalletId: null,
    accountId: "acc_rent",
    taxCategoryCode: "purchase_10",
    partnerId: "p_realty",
    segmentId: "seg_kamakura",
    bookedMonths: new Set(),
    ...overrides,
  });
  const rent = recurring({ id: "rc_rent" });
  // 2027-01-05 is 5 days after the 12/31 occurrence.
  const january = line({ descriptionRaw: "振込 カクウ 01/05" });

  it("3. matches the same wallet and signed amount within ±7 days of an occurrence, dotted", () => {
    expect(suggest(january, context({ recurring: [rent] }))).toMatchObject({
      mode: "register",
      source: "recurring",
      recurringItemId: "rc_rent",
      autoPost: false,
      ruleId: null,
      accountId: "acc_rent",
      taxCategoryCode: "purchase_10",
      partnerId: "p_realty",
      segmentId: "seg_kamakura",
      description: null,
      sources: {
        account: "recurring",
        taxCategory: "recurring",
        partner: "recurring",
        segment: "recurring",
      },
    });
    // 8 days away from 12/31 and from 1/31: no occurrence near enough.
    const far = line({ txnDate: "2027-01-08", descriptionRaw: "振込 カクウ" });
    expect(suggest(far, context({ recurring: [rent] }))).toMatchObject({
      source: "none",
      recurringItemId: null,
    });
    expect(
      suggest(
        line({ txnDate: "2027-01-07", descriptionRaw: "振込" }),
        context({ recurring: [rent] }),
      ).recurringItemId,
    ).toBe("rc_rent");
  });

  it("3. needs the same signed amount and the same wallet", () => {
    for (const other of [
      line({ amount: -88_001n, descriptionRaw: "振込" }),
      line({ amount: 88_000n, descriptionRaw: "振込" }),
      line({ walletId: "w_cash", descriptionRaw: "振込" }),
    ]) {
      expect(suggest(other, context({ recurring: [rent] })).recurringItemId).toBeNull();
    }
  });

  it("3. leaves out the months already registered", () => {
    const booked = recurring({ id: "rc_rent", bookedMonths: new Set(["2026-12"]) });
    expect(suggest(january, context({ recurring: [booked] })).recurringItemId).toBeNull();
    // The 1/31 occurrence is still open for a line near it.
    const late = line({ txnDate: "2027-01-29", descriptionRaw: "振込" });
    expect(suggest(late, context({ recurring: [booked] })).recurringItemId).toBe("rc_rent");
  });

  it("3. takes the nearest occurrence, then the name", () => {
    const tenth = recurring({ id: "rc_b", name: "駐車場", dayOfMonth: 3 });
    const same = recurring({ id: "rc_a", name: "倉庫", dayOfMonth: 3 });
    expect(suggest(january, context({ recurring: [rent, tenth] })).recurringItemId).toBe("rc_b");
    expect(suggest(january, context({ recurring: [tenth, same, rent] })).recurringItemId).toBe(
      "rc_a",
    );
  });

  it("3. a 振替 item suggests its other wallet", () => {
    const withdrawal = recurring({
      id: "rc_card",
      name: "カードの引落し",
      dayOfMonth: 5,
      transferWalletId: "w_card",
      accountId: null,
      taxCategoryCode: null,
      partnerId: null,
      segmentId: null,
    });
    expect(suggest(january, context({ recurring: [withdrawal] }))).toMatchObject({
      mode: "transfer",
      source: "recurring",
      recurringItemId: "rc_card",
      transferToWalletId: "w_card",
      candidate: null,
      accountId: null,
      sources: { transfer: "recurring" },
    });
    const inactive = { ...withdrawal, transferWalletId: "w_old" };
    expect(suggest(january, context({ recurring: [inactive] })).recurringItemId).toBeNull();
  });

  it("3. runs after a rule and a transfer candidate, and before the history", () => {
    const rentRule = rule({
      id: "r_rent",
      walletId: "w_bank",
      match: { ...NO_MATCH, descriptionContains: "カクウフドウサン", sign: "out" },
      action: { ...REGISTER, accountId: "acc_fee" },
    });
    const viaRule = suggest(line(), context({ rules: [rentRule], recurring: [rent] }));
    expect(viaRule).toMatchObject({
      source: "rule",
      ruleId: "r_rent",
      accountId: "acc_fee",
      recurringItemId: null,
    });
    const candidates = [candidate({ id: "c_card" })];
    expect(suggest(january, context({ candidates, recurring: [rent] }))).toMatchObject({
      source: "candidate",
      recurringItemId: null,
    });
    const past = history([
      { key: descriptionKey(january.descriptionRaw), accountId: "acc_fee", taxCategoryCode: null },
    ]);
    expect(suggest(january, context({ history: past, recurring: [rent] }))).toMatchObject({
      source: "recurring",
      accountId: "acc_rent",
    });
  });

  it("3. leaves empty fields to the partner and the defaults, never posting by itself", () => {
    const bare = recurring({
      id: "rc_sales",
      name: "保守",
      amount: 330_000n,
      dayOfMonth: 5,
      accountId: "acc_sales",
      taxCategoryCode: null,
      partnerId: null,
      segmentId: null,
    });
    const deposit = line({ amount: 330_000n, descriptionRaw: "振込 ｶｸｳﾃﾞｻﾞｲﾝ(ﾄﾞ" });
    expect(suggest(deposit, context({ recurring: [bare] }))).toMatchObject({
      mode: "register",
      source: "recurring",
      autoPost: false,
      accountId: "acc_sales",
      partnerId: "p_design",
      taxCategoryCode: "sales_10",
      segmentId: "seg_contract",
      sources: { account: "recurring", partner: "partner", taxCategory: "partner" },
    });
    // An account the line cannot take (a 収益 for money out) is not a match at all.
    const wrong = recurring({ id: "rc_wrong", accountId: "acc_sales" });
    expect(suggest(january, context({ recurring: [wrong] })).recurringItemId).toBeNull();
  });
});

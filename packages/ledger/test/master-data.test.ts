import { describe, expect, it } from "vitest";
import {
  ACCOUNT_GROUP_LABELS,
  ACCOUNT_GROUPS,
  ACCOUNT_GROUPS_BY_KIND,
  ACCOUNT_KINDS,
  accountKindForCode,
  AUDIT_ENTITIES,
  AUDIT_ENTITY_LABELS,
  auditActionLabel,
  CHART_TEMPLATE,
  defaultAccountingMethod,
  ENTRY_KIND_LABELS,
  ENTRY_KINDS,
  ENTRY_STATUS_LABELS,
  ENTRY_STATUSES,
  findTemplateAccount,
  formatYenInput,
  INPUT_TAX_ACCOUNT_CODE,
  isAccountGroupOf,
  isStandardSegmentCode,
  OUTPUT_TAX_ACCOUNT_CODE,
  parseYenInput,
  SOURCE_KIND_LABELS,
  SOURCE_KINDS,
  TRANSFER_FEE_ACCOUNT_CODE,
  WALLET_DEFAULT_ACCOUNT_CODES,
  WALLET_KINDS,
} from "../src";

describe("labels of entries and the audit log", () => {
  it("name every kind, source and status without showing the enum values", () => {
    for (const kind of ENTRY_KINDS) expect(ENTRY_KIND_LABELS[kind]).toMatch(/[^\x20-\x7e]/);
    for (const source of SOURCE_KINDS) expect(SOURCE_KIND_LABELS[source]).toBeTruthy();
    for (const status of ENTRY_STATUSES) expect(ENTRY_STATUS_LABELS[status]).toBeTruthy();
    for (const entity of AUDIT_ENTITIES) expect(AUDIT_ENTITY_LABELS[entity]).toBeTruthy();
    expect(SOURCE_KIND_LABELS.system).toBe("初期設定");
  });

  it("label audit actions by their own name or by the shared verb", () => {
    expect(auditActionLabel("journal_entry.post")).toBe("仕訳の登録");
    expect(auditActionLabel("journal_entry.void")).toBe("仕訳の取消");
    expect(auditActionLabel("journal_entry.correct")).toBe("仕訳の訂正");
    expect(auditActionLabel("fiscal_year.close")).toBe("締め");
    expect(auditActionLabel("fiscal_year.reopen")).toBe("締めを戻す");
    expect(auditActionLabel("account.create")).toBe("追加");
    expect(auditActionLabel("fiscal_year.update")).toBe("変更");
    expect(auditActionLabel("wallet.deactivate")).toBe("無効化");
    expect(auditActionLabel("tax_rate_rule.enable")).toBe("有効化");
    expect(auditActionLabel("setup.skip")).toBe("初期設定を後回し");
    expect(auditActionLabel("seed.apply")).toBeNull();
    expect(auditActionLabel("create")).toBeNull();
  });

  it("finds the accounts the transaction forms add in the standard chart", () => {
    expect(findTemplateAccount(OUTPUT_TAX_ACCOUNT_CODE)?.name).toBe("仮受消費税");
    expect(findTemplateAccount(INPUT_TAX_ACCOUNT_CODE)?.name).toBe("仮払消費税");
    expect(findTemplateAccount(TRANSFER_FEE_ACCOUNT_CODE)?.name).toBe("支払手数料");
  });
});

describe("account kinds and statement groups", () => {
  it("puts every statement group under exactly one kind", () => {
    const grouped = ACCOUNT_KINDS.flatMap((kind) => ACCOUNT_GROUPS_BY_KIND[kind]);
    expect([...grouped].sort()).toEqual([...ACCOUNT_GROUPS].sort());
    for (const group of ACCOUNT_GROUPS) expect(ACCOUNT_GROUP_LABELS[group]).toBeTruthy();
  });

  it("agrees with the standard chart", () => {
    for (const account of CHART_TEMPLATE) {
      expect(isAccountGroupOf(account.kind, account.group), account.code).toBe(true);
      expect(accountKindForCode(account.code), account.code).toBe(account.kind);
    }
    expect(accountKindForCode("0100")).toBeNull();
    expect(accountKindForCode("123")).toBeNull();
    expect(accountKindForCode("6100")).toBe("expense");
  });
});

describe("wallet kinds", () => {
  it("map to the accounts of 02-accounting-rules §2", () => {
    const names = Object.fromEntries(
      WALLET_KINDS.map((kind) => {
        const code = WALLET_DEFAULT_ACCOUNT_CODES[kind];
        return [kind, code ? findTemplateAccount(code)?.name : null];
      }),
    );
    expect(names).toEqual({
      bank: "普通預金",
      card: "未払金",
      cash: "現金",
      stripe: "Stripe 残高",
      owner: "役員借入金",
      other: null,
    });
  });
});

describe("fiscal year methods and segments", () => {
  it("fixes exempt years to tax-inclusive and defaults taxable years to tax-exclusive", () => {
    expect(defaultAccountingMethod("exempt")).toBe("tax_inclusive");
    expect(defaultAccountingMethod("general")).toBe("tax_exclusive");
    expect(defaultAccountingMethod("simplified")).toBe("tax_exclusive");
  });

  it("knows the standard segments", () => {
    expect(isStandardSegmentCode("corporate")).toBe(true);
    expect(isStandardSegmentCode("kamakura")).toBe(true);
    expect(isStandardSegmentCode("hayama")).toBe(false);
  });
});

describe("amount input", () => {
  it("accepts plain digits, 3-digit groups and full-width input", () => {
    expect(parseYenInput("50000")).toBe(50_000n);
    expect(parseYenInput("50,000")).toBe(50_000n);
    expect(parseYenInput(" ５０，０００ ")).toBe(50_000n);
    expect(parseYenInput("¥150,000")).toBe(150_000n);
    expect(parseYenInput("15,000円")).toBe(15_000n);
    expect(parseYenInput("0")).toBe(0n);
  });

  it("rejects blanks, decimals and words", () => {
    expect(parseYenInput("")).toBeNull();
    expect(parseYenInput("  ")).toBeNull();
    expect(parseYenInput("1.5")).toBeNull();
    expect(parseYenInput("5万")).toBeNull();
    expect(parseYenInput("abc")).toBeNull();
    expect(parseYenInput("1234567890123456")).toBeNull();
  });

  it("accepts a minus only when allowed", () => {
    expect(parseYenInput("-3,000")).toBeNull();
    expect(parseYenInput("-3,000", { allowNegative: true })).toBe(-3_000n);
    expect(parseYenInput("－３０００", { allowNegative: true })).toBe(-3_000n);
  });

  it("formats with 3-digit grouping", () => {
    expect(formatYenInput(50_000n)).toBe("50,000");
    expect(formatYenInput(-1_234n)).toBe("-1,234");
    expect(formatYenInput(null)).toBe("");
  });
});

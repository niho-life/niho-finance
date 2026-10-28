import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assignExternalIds, rowExternalId } from "../src/csv/external-id";
import { sha256Hex } from "../src/hash";
import { draft } from "./support/drafts";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("sha256Hex", () => {
  it("hashes strings as UTF-8 and bytes as they are", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("日付")).toBe(sha256Hex(new TextEncoder().encode("日付")));
  });
});

describe("rowExternalId (12-imports §3.3)", () => {
  it("is SHA-256 of date|amount|description|counterparty|occurrence", () => {
    const row = draft("2026-11-02", -1100n, {
      descriptionRaw: "ｼｽﾃﾑﾘﾖｳﾘｮｳ",
      counterpartyRaw: "ｶ)ﾃｽﾄ",
    });
    expect(rowExternalId(row, 0)).toBe(sha256("2026-11-02|-1100|ｼｽﾃﾑﾘﾖｳﾘｮｳ|ｶ)ﾃｽﾄ|0"));
    expect(rowExternalId({ ...row, counterpartyRaw: null }, 3)).toBe(
      sha256("2026-11-02|-1100|ｼｽﾃﾑﾘﾖｳﾘｮｳ||3"),
    );
  });

  it("does not depend on the balance", () => {
    const withBalance = draft("2026-11-02", 500n, { balanceAfter: 1000n });
    expect(rowExternalId(withBalance, 0)).toBe(rowExternalId(draft("2026-11-02", 500n), 0));
  });
});

describe("assignExternalIds", () => {
  it("counts look-alike rows in order, per date, amount, description and counterparty", () => {
    const rows = assignExternalIds([
      draft("2026-11-02", -1100n),
      draft("2026-11-02", -1100n),
      draft("2026-11-02", -1100n, { counterpartyRaw: "ｶ)ﾃｽﾄ" }),
      draft("2026-11-03", -1100n),
      draft("2026-11-02", -1100n),
    ]);
    expect(rows.map((row) => row.externalId)).toEqual([
      sha256("2026-11-02|-1100|テスト||0"),
      sha256("2026-11-02|-1100|テスト||1"),
      sha256("2026-11-02|-1100|テスト|ｶ)ﾃｽﾄ|0"),
      sha256("2026-11-03|-1100|テスト||0"),
      sha256("2026-11-02|-1100|テスト||2"),
    ]);
  });

  it("treats a missing counterparty like an empty one, as the hash does", () => {
    const rows = assignExternalIds([
      draft("2026-11-02", 1n, { counterpartyRaw: null }),
      draft("2026-11-02", 1n, { counterpartyRaw: "" }),
    ]);
    expect(new Set(rows.map((row) => row.externalId)).size).toBe(2);
  });

  it("keeps rows apart whose fields only join to the same text", () => {
    const rows = assignExternalIds([
      draft("2026-11-02", 1n, { descriptionRaw: "A|B", counterpartyRaw: null }),
      draft("2026-11-02", 1n, { descriptionRaw: "A", counterpartyRaw: "B|" }),
    ]);
    expect(rows[0]?.externalId).not.toBe(rows[1]?.externalId);
  });

  it("is stable: other days do not change a row's ID", () => {
    const november = draft("2026-11-30", -500n);
    const alone = assignExternalIds([november]);
    const withOthers = assignExternalIds([
      draft("2026-11-29", -500n),
      november,
      draft("2026-12-01", -500n),
    ]);
    expect(withOthers[1]?.externalId).toBe(alone[0]?.externalId);
  });

  it("returns new drafts and leaves the input untouched", () => {
    const input = [draft("2026-11-02", 1n)];
    const [output] = assignExternalIds(input);
    expect(input[0]?.externalId).toBe("");
    expect(output?.externalId).toMatch(/^[0-9a-f]{64}$/);
  });
});

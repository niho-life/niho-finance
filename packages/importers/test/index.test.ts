import { describe, expect, it } from "vitest";
import { IMPORT_SOURCES, type ImportResult } from "../src";

describe("importers skeleton", () => {
  it("lists the import sources of ImportBatch", () => {
    expect(IMPORT_SOURCES).toEqual(["csv", "stripe", "api"]);
  });

  it("describes a parsed statement line with a signed bigint amount", () => {
    const result: ImportResult = {
      source: "csv",
      rows: [
        { txnDate: "2026-11-30", amount: -145n, descriptionRaw: "振込手数料", externalId: "row-1" },
      ],
      failed: [],
    };
    expect(result.rows[0]?.amount).toBe(-145n);
  });
});

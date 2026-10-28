import { describe, expect, it } from "vitest";
import { REPORT_KINDS, type ReportRequest } from "../src";

describe("reports skeleton", () => {
  it("lists the planned report kinds", () => {
    expect(REPORT_KINDS).toContain("trial_balance");
    expect(new Set(REPORT_KINDS).size).toBe(REPORT_KINDS.length);
  });

  it("describes a report request over calendar dates", () => {
    const request: ReportRequest = {
      kind: "trial_balance",
      fiscalYearId: "fy_1",
      period: { from: "2026-11-02", to: "2027-03-31" },
    };
    expect(request.period.from < request.period.to).toBe(true);
  });
});

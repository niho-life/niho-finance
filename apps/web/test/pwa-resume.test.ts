import { describe, expect, it } from "vitest";
import { RESUME_REFRESH_AFTER_MS, shouldRefreshOnResume } from "@/lib/pwa/resume";

describe("shouldRefreshOnResume (10 §1.1)", () => {
  const hiddenAt = 1_000_000;

  it("reads the page again after 60 seconds or more hidden", () => {
    expect(RESUME_REFRESH_AFTER_MS).toBe(60_000);
    expect(shouldRefreshOnResume(hiddenAt, hiddenAt + 60_000)).toBe(true);
    expect(shouldRefreshOnResume(hiddenAt, hiddenAt + 3_600_000)).toBe(true);
  });

  it("keeps the page after a shorter time", () => {
    expect(shouldRefreshOnResume(hiddenAt, hiddenAt)).toBe(false);
    expect(shouldRefreshOnResume(hiddenAt, hiddenAt + 59_999)).toBe(false);
  });

  it("keeps the page when it was not hidden or the clock went backwards", () => {
    expect(shouldRefreshOnResume(null, hiddenAt)).toBe(false);
    expect(shouldRefreshOnResume(hiddenAt, hiddenAt - 120_000)).toBe(false);
  });
});

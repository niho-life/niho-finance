import { tryToParsePath } from "next/dist/lib/try-to-parse-path";
import { describe, expect, it } from "vitest";
import { config } from "@/proxy";

/*
 * Which paths `proxy.ts` sees (23 §3.3, 10 §1.1). The matcher is compiled with Next's own
 * path-to-regexp step, as `next build` does. The home-screen app's static files are left out; the
 * screens, APIs and 書き出し stay checked.
 */

const matchers = config.matcher.map((source) => {
  // `regexStr` is missing when Next cannot parse the source.
  const { regexStr } = tryToParsePath(source);
  if (regexStr === undefined) throw new Error(`proxy matcher not parsed: ${source}`);
  return new RegExp(regexStr);
});
const checked = (pathname: string) => matchers.some((matcher) => matcher.test(pathname));

describe("proxy config.matcher", () => {
  it("checks the screens, the APIs and the exports", () => {
    for (const pathname of [
      "/",
      "/documents",
      "/documents/doc_1",
      "/api/documents/prepare",
      "/settings/export",
      "/settings/export/download",
      "/reports",
      "/forbidden",
    ]) {
      expect(checked(pathname), pathname).toBe(true);
    }
  });

  it("leaves out the home-screen app's static files", () => {
    for (const pathname of [
      "/sw.js",
      "/app.webmanifest",
      "/offline.html",
      "/icons/icon-192.png",
      "/icons/apple-touch-icon.png",
    ]) {
      expect(checked(pathname), pathname).toBe(false);
    }
  });

  it("leaves out the build's files, the health check, the jobs and the favicon as before", () => {
    for (const pathname of [
      "/_next/static/chunk.js",
      "/api/health",
      "/api/jobs/run",
      "/favicon.ico",
    ]) {
      expect(checked(pathname), pathname).toBe(false);
    }
  });

  it("does not leave out paths that only start like those files", () => {
    for (const pathname of ["/sw.jsx", "/offline", "/offline.html/more", "/app.webmanifest2"]) {
      expect(checked(pathname), pathname).toBe(true);
    }
  });
});

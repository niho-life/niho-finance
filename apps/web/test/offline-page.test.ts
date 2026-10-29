import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/* 接続がない画面 (10 §1.1): `public/offline.html`, cached by the Service Worker. */

const html = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/offline.html"),
  "utf8",
);

describe("offline.html", () => {
  it("says what happened and what to do, in Japanese", () => {
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain('<meta charset="utf-8" />');
    expect(html).toContain("<title>接続がありません | NIHO finance</title>");
    expect(html).toContain("<h1>接続がありません</h1>");
    expect(html).toContain(
      "帳簿は最新の内容だけを表示するため、つながっていない間は開けません。つながったら開き直してください。",
    );
    expect(html).toMatch(/<button type="button" id="reopen">開き直す<\/button>/);
  });

  it("fits the phone: viewport, safe areas and a button of 44px or more", () => {
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
    );
    expect(html).toContain('<meta name="theme-color" content="#ffffff" />');
    expect(html).toContain("env(safe-area-inset-bottom)");
    const buttonRule = /\n\s*button \{([^}]*)\}/.exec(html)?.[1] ?? "";
    const minHeight = Number(/min-height:\s*(\d+)px/.exec(buttonRule)?.[1]);
    expect(minHeight).toBeGreaterThanOrEqual(44);
  });

  it("reads nothing from outside: no link, no src, no URL, no web font", () => {
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/\bsrc\s*=/i);
    expect(html).not.toMatch(/https?:/i);
    expect(html).not.toMatch(/url\(/i);
    expect(html).not.toMatch(/@import|@font-face/i);
  });

  it("opens the page again on 開き直す and when the connection comes back", () => {
    expect(html).toContain('location.pathname === "/offline.html"');
    expect(html).toContain('location.assign("/")');
    expect(html).toContain("location.reload()");
    expect(html).toContain('addEventListener("click", reopen)');
    expect(html).toContain('addEventListener("online", reopen)');
  });
});

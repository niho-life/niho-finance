import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  POLICY_CHAPTERS,
  POLICY_PLACEHOLDERS,
  POLICY_VERSION,
  renderPolicyBlocks,
  renderPolicyMarkdown,
} from "@/lib/documents/policy";

const policyFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/ops/electronic-records-policy.md",
);

describe("records policy text", () => {
  it("is the body of docs/ops/electronic-records-policy.md (after ---)", async () => {
    const markdown = await readFile(policyFile, "utf8");
    const [, body] = markdown.split("\n---\n");
    expect(body).toBeDefined();
    expect(renderPolicyMarkdown().trim()).toBe(body?.trim());
  });

  it("fills the company, the people responsible and the effective date", () => {
    const text = renderPolicyMarkdown({
      company: "架空商会株式会社",
      manager: "代表取締役 架空 太郎",
      operator: "架空 花子",
      effectiveOn: "2026年11月10日",
    });
    expect(text).toContain("架空商会株式会社（以下「当社」という。）");
    expect(text).toContain("第3条 この規程の管理責任者は、代表取締役 架空 太郎とする。");
    expect(text).toContain("一 管理責任者 代表取締役 架空 太郎");
    expect(text).toContain("二 処理責任者 架空 花子");
    expect(text).toContain("第12条 この規程は、2026年11月10日から施行する。");
    // The heading of 第3条 is not a slot.
    expect(text).toContain("\n\n（管理責任者）\n\n");
    expect(text).not.toMatch(/[{}]/);
    expect(text).not.toContain("（商号）");
  });

  it("keeps the placeholders for empty values", () => {
    const blocks = renderPolicyBlocks({ company: " ", manager: null, operator: undefined });
    const paragraphs = blocks.filter((block) => block.type === "paragraph").map((b) => b.text);
    expect(paragraphs.join("\n")).toContain(
      `${POLICY_PLACEHOLDERS.company}（以下「当社」という。）`,
    );
    expect(paragraphs).toContain(`二 処理責任者 ${POLICY_PLACEHOLDERS.operator}`);
    expect(paragraphs).toContain(
      `第12条 この規程は、${POLICY_PLACEHOLDERS.effectiveOn}から施行する。`,
    );
  });

  it("is a title, the version, 5 chapters and 12 articles", () => {
    const blocks = renderPolicyBlocks();
    expect(blocks.slice(0, 2)).toEqual([
      { type: "title", text: "電子取引データの訂正及び削除の防止に関する事務処理規程" },
      { type: "version", text: `（版 ${POLICY_VERSION}）` },
    ]);
    expect(blocks.filter((block) => block.type === "chapter").map((block) => block.text)).toEqual(
      POLICY_CHAPTERS.map((chapter) => chapter.title),
    );
    expect(POLICY_CHAPTERS).toHaveLength(5);
    const articles = POLICY_CHAPTERS.flatMap((chapter) => chapter.articles);
    expect(articles.map((article) => article.paragraphs[0]?.split(" ")[0])).toEqual(
      Array.from({ length: 12 }, (_, index) => `第${index + 1}条`),
    );
  });
});

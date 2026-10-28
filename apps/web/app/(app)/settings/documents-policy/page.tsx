import { getRecordsPolicy } from "@niho-finance/db";
import { dateParts, type CalendarDate } from "@niho-finance/ledger";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { POLICY_VERSION, renderPolicyBlocks, type PolicyBlock } from "@/lib/documents/policy";
import { formatDate } from "@/lib/format";
import { PolicyForm } from "./policy-form";
import { PrintButton } from "./print-button";

export const metadata: Metadata = { title: "証憑の規程" };

const COMPLIANCE_URL =
  "https://github.com/niho-life/niho-finance/blob/main/docs/ops/electronic-records-compliance.md";

/** `2026年11月10日` (the Western calendar, as the text is written). */
function japaneseDate(date: CalendarDate): string {
  const { year, month, day } = dateParts(date);
  return `${year}年${month}月${day}日`;
}

/** 一 / 二 … : the items of an article, indented under it. */
const ITEM = /^[一二三四五六七八九十]+ /;

function PolicyText({ blocks }: { blocks: readonly PolicyBlock[] }) {
  return (
    <article
      data-print-root
      className="flex flex-col gap-2 rounded-card border border-border px-5 py-6 text-[14px] leading-relaxed md:px-8"
    >
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        switch (block.type) {
          case "title":
            return (
              <h2 key={key} className="text-[18px] font-extrabold leading-snug">
                {block.text}
              </h2>
            );
          case "version":
            return (
              <p key={key} className="text-[12px] text-muted">
                {block.text}
              </p>
            );
          case "chapter":
            return (
              <h3 key={key} className="mt-4 text-[15px] font-extrabold">
                {block.text}
              </h3>
            );
          case "heading":
            return (
              <p key={key} className="mt-2 font-bold">
                {block.text}
              </p>
            );
          case "paragraph":
            return (
              <p key={key} className={ITEM.test(block.text) ? "pl-4" : undefined}>
                {block.text}
              </p>
            );
        }
      })}
    </article>
  );
}

const SUPPORTS = [
  {
    label: "追記のみ",
    text: "証憑は削除できません。誤りは理由つきで無効にし、直したファイルは差し替え（新しい証憑）で残します。",
  },
  {
    label: "SHA-256",
    text: "保存するときにファイルの SHA-256 を記録し、受け取ったファイルと照合します。同じファイルは二重に保存しません。",
  },
  {
    label: "監査ログ",
    text: "保存・変更・紐づけ・無効化・差し替えを、誰がいつ行ったか、変更前と変更後とともに残します。",
  },
  {
    label: "検索と索引簿",
    text: "取引年月日・金額の範囲と取引先を組み合わせて検索でき、同じ条件の索引簿を CSV で書き出せます。",
  },
] as const;

/**
 * 設定 › 証憑の規程 (13 §5): the state (未制定 / 制定済み), the form (施行日・責任者), how the system
 * backs the policy, and the whole text with the company and the people filled in, printable.
 */
export default async function DocumentsPolicyPage() {
  const policy = await getRecordsPolicy(await db());
  const blocks = renderPolicyBlocks({
    company: policy.companyName,
    manager: policy.manager,
    operator: policy.operator,
    effectiveOn: policy.effectiveOn ? japaneseDate(policy.effectiveOn) : null,
  });
  const inForce = policy.effectiveOn !== null;
  const outdated = inForce && policy.version !== POLICY_VERSION;
  const state = inForce
    ? [
        "制定済み",
        `施行日 ${formatDate(policy.effectiveOn)}`,
        `版 ${policy.version ?? "—"}`,
        `管理責任者 ${policy.manager ?? "—"}`,
        `処理責任者 ${policy.operator ?? "—"}`,
      ].join(" · ")
    : "未制定です。施行日を入れて保存すると制定済みになります";

  return (
    <>
      <PageHeader title="証憑の規程" back={{ href: "/settings", label: "設定" }} />
      <div className="mb-4 flex flex-col gap-2">
        <p
          className={`rounded-lg px-3.5 py-2.5 text-[14px] break-words ${
            inForce ? "bg-surface-2" : "bg-surface-2 font-bold"
          }`}
        >
          {state}
        </p>
        {outdated ? (
          <p className="rounded-lg bg-warn-soft px-3.5 py-2.5 text-[14px] text-warn">
            規程の文面が更新されています。読み直して施行日を入れ直してください
          </p>
        ) : null}
      </div>
      <PolicyForm
        key={`${policy.effectiveOn ?? ""}|${policy.manager ?? ""}|${policy.operator ?? ""}|${policy.version ?? ""}`}
        values={{
          effectiveOn: policy.effectiveOn ?? "",
          manager: policy.manager ?? "",
          operator: policy.operator ?? "",
        }}
        representative={policy.representative}
      />

      <section aria-labelledby="policy-support" className="mt-8">
        <h2 id="policy-support" className="mb-2 text-[15px] font-extrabold">
          この規程をシステムがどう支えるか
        </h2>
        <ul className="overflow-hidden rounded-card border border-border">
          {SUPPORTS.map((item) => (
            <li
              key={item.label}
              className="grid gap-x-4 gap-y-0.5 border-b border-border px-3.5 py-2.5 text-[14px] last:border-b-0 md:grid-cols-[140px_minmax(0,1fr)]"
            >
              <span className="font-bold">{item.label}</span>
              <span className="text-muted">{item.text}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[13px]">
          規則ごとの対応と証跡は{" "}
          <a
            href={COMPLIANCE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-bold underline underline-offset-4"
          >
            要件対応表
          </a>{" "}
          にまとめています。
        </p>
      </section>

      <section aria-labelledby="policy-text" className="mt-8">
        <div className="mb-2 flex items-center gap-3">
          <h2 id="policy-text" className="text-[15px] font-extrabold">
            全文
          </h2>
          <span className="ml-auto">
            <PrintButton />
          </span>
        </div>
        <PolicyText blocks={blocks} />
      </section>
    </>
  );
}

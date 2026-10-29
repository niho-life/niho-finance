import { loadFeeReports } from "@niho-finance/db";
import { formatYen } from "@niho-finance/ledger";
import { FEE_CATEGORIES } from "@niho-finance/payroll";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buttonClass } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { pathYear, readCategories, searchEntries } from "../../../_lib/params";

export const metadata: Metadata = { title: "支払調書の CSV" };

/**
 * 報酬、料金、契約金及び賞金の支払調書の CSV (e-Tax 309, 22-payroll §12.2): the payees with a 支払調書,
 * the 区分 chosen on 法定調書 (hidden fields), and a box per payee for the 個人番号又は法人番号 used by
 * this one download only (POST, never stored, never logged, not cached).
 */
export default async function FeeReportCsvPage({
  params,
  searchParams,
}: {
  params: Promise<{ year: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const year = pathYear((await params).year);
  if (year === null) notFound();
  const categories = readCategories(searchEntries(await searchParams));
  const overview = await loadFeeReports(await db(), year, categories);
  const payees = overview.aggregation.payees.filter((payee) => payee.reportable);

  return (
    <>
      <PageHeader
        title="支払調書の CSV"
        meta={`${year} 年分 · e-Tax の法定調書（309）`}
        back={{ href: `/payroll/statements?year=${year}`, label: "法定調書" }}
      />
      <form
        action={`/payroll/statements/${year}/fees/csv/download`}
        method="post"
        autoComplete="off"
        className="flex flex-col gap-5"
      >
        {Object.entries(categories).map(([key, value]) => (
          <input key={key} type="hidden" name={`cat.${key}`} value={value} />
        ))}
        <p className="rounded-lg bg-surface-2 px-3.5 py-2.5 text-[13px]">
          支払を受ける者の個人番号（12 桁）又は法人番号（13 桁）は、この書き出しの 1
          回だけに使います。保存も記録もしません。空欄のままでも書き出せます。
        </p>
        {payees.length === 0 ? (
          <p className="rounded-card border border-dashed border-border-2 bg-surface px-5 py-4 text-[14px]">
            支払調書を出す取引先がありません（個人で年間 5 万円を超える人だけ）。
          </p>
        ) : (
          payees.map((payee) => (
            <fieldset
              key={payee.partner.id}
              className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4"
            >
              <legend className="px-1 text-[14px] font-extrabold">{payee.partner.name}</legend>
              <label className="inline-flex items-center gap-2 text-[14px]">
                <input
                  type="checkbox"
                  name="include"
                  value={payee.partner.id}
                  defaultChecked
                  className="size-4 accent-[var(--primary)]"
                />
                CSV に入れる（
                {payee.items
                  .map(
                    (item) =>
                      `${FEE_CATEGORIES[item.category].label} ${formatYen(item.paid)} 円・源泉 ${formatYen(item.withheld)} 円`,
                  )
                  .join("、")}
                ）
              </label>
              {payee.partner.address ? null : (
                <p role="status" className="text-[12px] font-bold text-warn">
                  住所がありません（設定 › 取引先 で入れます）。
                </p>
              )}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="flex flex-col gap-1 text-[12px]">
                  <span className="text-muted">個人番号又は法人番号</span>
                  <Input
                    name={`pn.${payee.partner.id}`}
                    inputMode="numeric"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={15}
                    className="num max-w-[200px]"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12px]">
                  <span className="text-muted">摘要（任意）</span>
                  <Input name={`remarks.${payee.partner.id}`} maxLength={100} />
                </label>
              </div>
            </fieldset>
          ))
        )}
        <div className="flex flex-wrap items-end gap-4 rounded-card border border-border bg-surface px-5 py-4">
          <label className="flex flex-col gap-1 text-[12px]">
            <span className="font-bold text-muted">文字コード</span>
            <Select name="encoding" defaultValue="sjis" className="w-[180px]">
              <option value="sjis">Shift_JIS（e-Tax）</option>
              <option value="utf8">UTF-8</option>
            </Select>
          </label>
          <button
            type="submit"
            disabled={payees.length === 0}
            className={buttonClass({ variant: "primary", size: "sm" })}
          >
            CSV を書き出す
          </button>
        </div>
      </form>
    </>
  );
}

import { loadStatements, type StatementsOverview } from "@niho-finance/db";
import { formatYen } from "@niho-finance/ledger";
import { PayrollTableMissingError } from "@niho-finance/payroll";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buttonClass } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { TABLE_MISSING_HINT } from "../../../_lib/labels";
import { pathYear } from "../../_lib/params";

export const metadata: Metadata = { title: "給与支払報告書の CSV" };

function NumberInput({ name, label }: { name: string; label: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[12px]">
      <span className="text-muted">{label}</span>
      <Input
        name={name}
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        maxLength={14}
        className="num w-full max-w-[180px]"
      />
    </label>
  );
}

/**
 * 給与支払報告書‐源泉徴収票の統一 CSV (eLTAX, 22-payroll §12.2): the recipients in range and, for
 * each, the マイナンバー boxes. The numbers go to this one download only (POST, never stored, never
 * logged, not cached); empty boxes stay empty in the file and are completed in eLTAX.
 */
export default async function SalaryReportCsvPage({
  params,
}: {
  params: Promise<{ year: string }>;
}) {
  const year = pathYear((await params).year);
  if (year === null) notFound();
  let overview: StatementsOverview | null = null;
  let missing: string | null = null;
  try {
    overview = await loadStatements(await db(), year);
  } catch (error) {
    if (!(error instanceof PayrollTableMissingError)) throw error;
    missing = `${error.message}。${TABLE_MISSING_HINT}`;
  }
  const ready =
    overview?.recipients.filter((row) => row.inSalaryReport && row.state !== "pending") ?? [];
  const left =
    overview?.recipients.filter((row) => !row.inSalaryReport || row.state === "pending") ?? [];

  return (
    <>
      <PageHeader
        title="給与支払報告書の CSV"
        meta={`${year} 年分 · eLTAX の統一 CSV`}
        back={{ href: `/payroll/statements?year=${year}`, label: "法定調書" }}
      />
      {missing ? (
        <p role="alert" className="rounded-lg bg-danger-soft px-3.5 py-2.5 text-[14px] text-danger">
          {missing}
        </p>
      ) : (
        <form
          action={`/payroll/statements/${year}/csv/download`}
          method="post"
          autoComplete="off"
          className="flex flex-col gap-5"
        >
          <p className="rounded-lg bg-surface-2 px-3.5 py-2.5 text-[13px]">
            マイナンバーはこの画面で入れ、書き出す 1
            回だけに使います。保存も記録もしません。空欄のまま書き出して、eLTAX
            で補うこともできます。作成区分は「国税・地方税の双方」（源泉徴収票のみなし提出）です。
          </p>
          {ready.length === 0 ? (
            <p className="rounded-card border border-dashed border-border-2 bg-surface px-5 py-4 text-[14px]">
              書き出せる受給者がいません。
            </p>
          ) : (
            ready.map((recipient) => {
              const slip = recipient.slip;
              const id = recipient.employee.id;
              return (
                <fieldset
                  key={id}
                  className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4"
                >
                  <legend className="px-1 text-[14px] font-extrabold">
                    {recipient.employee.name}
                  </legend>
                  <label className="inline-flex items-center gap-2 text-[14px]">
                    <input
                      type="checkbox"
                      name="include"
                      value={id}
                      defaultChecked
                      className="size-4 accent-[var(--primary)]"
                    />
                    CSV に入れる（支払金額 {formatYen(slip.paid)} 円・提出先{" "}
                    {slip.recipient.municipalityCode || "未入力"}）
                  </label>
                  {recipient.missing.length > 0 ? (
                    <p role="status" className="text-[12px] font-bold text-warn">
                      足りない欄: {recipient.missing.join("・")}（源泉徴収票の画面で入れます）
                    </p>
                  ) : null}
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    <NumberInput name={`mn.${id}.recipient`} label="本人の個人番号（12 桁）" />
                    {slip.spousePerson ? (
                      <NumberInput
                        name={`mn.${id}.spouse`}
                        label={`配偶者 ${slip.spousePerson.name || ""} の個人番号`}
                      />
                    ) : null}
                    {slip.dependentPersons.slice(0, 4).map((person, index) => (
                      <NumberInput
                        key={`dep-${index}`}
                        name={`mn.${id}.dep.${index}`}
                        label={`控除対象扶養親族 (${index + 1}) ${person.name} の個人番号`}
                      />
                    ))}
                    {slip.minorPersons.slice(0, 4).map((person, index) => (
                      <NumberInput
                        key={`minor-${index}`}
                        name={`mn.${id}.minor.${index}`}
                        label={`16 歳未満 (${index + 1}) ${person.name} の個人番号`}
                      />
                    ))}
                  </div>
                </fieldset>
              );
            })
          )}
          {left.length > 0 ? (
            <div className="rounded-card border border-border bg-surface p-4 text-[13px]">
              <p className="font-bold">CSV に入れない人</p>
              <ul className="mt-1 list-disc pl-5">
                {left.map((recipient) => (
                  <li key={recipient.employee.id}>
                    {recipient.employee.name}:{" "}
                    {recipient.state === "pending"
                      ? "年末調整が未確定"
                      : "年の中途の退職で支払金額が 30 万円以下（給与支払報告書を出さない）"}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-wrap items-end gap-4 rounded-card border border-border bg-surface px-5 py-4">
            <label className="flex flex-col gap-1 text-[12px]">
              <span className="font-bold text-muted">提出区分</span>
              <Select name="submissionKind" defaultValue="0" className="w-[140px]">
                <option value="0">新規</option>
                <option value="1">追加</option>
                <option value="2">訂正</option>
                <option value="3">取消</option>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-[12px]">
              <span className="font-bold text-muted">文字コード</span>
              <Select name="encoding" defaultValue="sjis" className="w-[180px]">
                <option value="sjis">Shift_JIS（eLTAX PCdesk）</option>
                <option value="utf8">UTF-8</option>
              </Select>
            </label>
            <button
              type="submit"
              disabled={ready.length === 0}
              className={buttonClass({ variant: "primary", size: "sm" })}
            >
              CSV を書き出す
            </button>
          </div>
        </form>
      )}
    </>
  );
}

import { loadWithholdingSlip } from "@niho-finance/db";
import {
  DEPENDENT_CATEGORY_LABELS,
  defaultRecipientNo,
  PayrollTableMissingError,
  type YearEndPerson,
} from "@niho-finance/payroll";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonClass } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { PrintButton } from "../../../_components/print-button";
import { TABLE_MISSING_HINT } from "../../../_lib/labels";
import {
  STATEMENT_FORM_PRINT_CSS,
  StatementFormSheet,
} from "../../_components/statement-form-sheet";
import {
  StatementFieldsForm,
  type PersonDraft,
  type StatementFieldsDraft,
} from "../../_components/statement-fields-form";
import { pathYear } from "../../_lib/params";
import { withholdingSlipForm } from "../../_lib/statement-forms";

export const metadata: Metadata = { title: "源泉徴収票" };

const draftPerson = (label: string, person: YearEndPerson | undefined): PersonDraft => ({
  label,
  name: person?.name ?? "",
  furigana: person?.furigana ?? "",
  nonResident: person?.nonResident ?? false,
});

/**
 * 源泉徴収票 of one person and year (22-payroll §12.2): the 受給者交付用 slip (printable, PDF), the
 * 給与支払報告書（個人別明細書）PDF, and the 法定調書の欄 (フリガナ・住所・市町村コード・受給者番号・
 * 親族の氏名) to save.
 */
export default async function WithholdingSlipPage({
  params,
}: {
  params: Promise<{ year: string; employeeId: string }>;
}) {
  const { year: yearText, employeeId } = await params;
  const year = pathYear(yearText);
  if (year === null) notFound();
  let recipient;
  try {
    recipient = await loadWithholdingSlip(await db(), year, employeeId);
  } catch (error) {
    if (!(error instanceof PayrollTableMissingError)) throw error;
    return (
      <>
        <PageHeader
          title="源泉徴収票"
          meta={`${year} 年分`}
          back={{ href: `/payroll/statements?year=${year}`, label: "法定調書" }}
        />
        <p role="alert" className="rounded-lg bg-danger-soft px-3.5 py-2.5 text-[14px] text-danger">
          {error.message}。{TABLE_MISSING_HINT}
        </p>
      </>
    );
  }
  if (!recipient) notFound();
  const declaration = recipient.declaration?.declaration ?? null;
  const declared = recipient.declaration?.declared ?? false;
  const initial: StatementFieldsDraft = {
    recipient: {
      furigana: declaration?.recipient?.furigana ?? "",
      address: declaration?.recipient?.address ?? "",
      municipalityCode: declaration?.recipient?.municipalityCode ?? "",
      recipientNo: declaration?.recipient?.recipientNo ?? "",
    },
    defaultRecipientNo: defaultRecipientNo(recipient.employee.id),
    spouse:
      declared && declaration?.spouse ? draftPerson("配偶者", declaration.spouse.person) : null,
    dependents:
      declared && declaration
        ? declaration.dependents.map((dependent, index) =>
            draftPerson(
              `扶養親族 (${index + 1}) · ${DEPENDENT_CATEGORY_LABELS[dependent.category]}`,
              dependent.person,
            ),
          )
        : [],
    specificRelatives:
      declared && declaration
        ? declaration.specificRelatives.map((relative, index) =>
            draftPerson(`特定親族 (${index + 1})`, relative.person),
          )
        : [],
    previousPayer:
      declared && declaration?.previousEmployer
        ? {
            name: declaration.previousEmployer.payer?.name ?? "",
            address: declaration.previousEmployer.payer?.address ?? "",
            leftOn: declaration.previousEmployer.payer?.leftOn ?? "",
          }
        : null,
  };
  const pending = recipient.state === "pending";
  const base = `/payroll/statements/${year}/${recipient.employee.id}`;
  const form = withholdingSlipForm(recipient, "recipient");

  return (
    <>
      <style>{STATEMENT_FORM_PRINT_CSS}</style>
      <div data-print="hide">
        <PageHeader
          title="源泉徴収票"
          meta={`${recipient.employee.name} · ${year} 年分`}
          back={{ href: `/payroll/statements?year=${year}`, label: "法定調書" }}
          actions={
            pending ? null : (
              <>
                <PrintButton />
                {/* Plain links: a download must not be prefetched (the audit log records it). */}
                <a
                  href={`${base}/slip/pdf`}
                  className={buttonClass({ variant: "primary", size: "sm" })}
                >
                  源泉徴収票の PDF を書き出す
                </a>
                {recipient.inSalaryReport ? (
                  <a href={`${base}/report/pdf`} className={buttonClass({ size: "sm" })}>
                    給与支払報告書の PDF を書き出す
                  </a>
                ) : null}
              </>
            )
          }
        />
      </div>
      <div className="flex flex-col gap-6">
        {pending ? (
          <p
            data-print="hide"
            role="status"
            className="rounded-lg bg-warn-soft px-3.5 py-2.5 text-[14px] text-warn"
          >
            {recipient.reason}{" "}
            <Link
              href={`/payroll/year-end/${year}/${recipient.employee.id}`}
              className="font-bold underline underline-offset-4"
            >
              年末調整を開く
            </Link>
          </p>
        ) : (
          <>
            {recipient.inSalaryReport && recipient.missing.length > 0 ? (
              <p
                data-print="hide"
                role="status"
                className="rounded-lg bg-warn-soft px-3.5 py-2.5 text-[13px] text-warn"
              >
                給与支払報告書に足りない欄: {recipient.missing.join("・")}
                。下の「法定調書の欄」で入れます。
              </p>
            ) : null}
            {!recipient.inSalaryReport ? (
              <p data-print="hide" className="rounded-lg bg-surface-2 px-3.5 py-2.5 text-[13px]">
                年の中途で退職し支払金額が 30
                万円以下なので、給与支払報告書は出しません。源泉徴収票は本人に渡します。
              </p>
            ) : null}
            <StatementFormSheet form={form} />
          </>
        )}
        <section data-print="hide" className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-[15px] font-extrabold">法定調書の欄</h2>
            <p className="text-[13px] text-muted">
              源泉徴収票と給与支払報告書に載せる住所・フリガナ・親族の氏名です。年末調整の確定後も直せます（税額は変わりません）。
            </p>
          </div>
          <div className="rounded-card border border-border bg-surface p-4">
            <StatementFieldsForm year={year} employeeId={recipient.employee.id} initial={initial} />
          </div>
        </section>
      </div>
    </>
  );
}

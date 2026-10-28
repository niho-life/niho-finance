import { listEmployees, todayInJapan } from "@niho-finance/db";
import { formatYenInput } from "@niho-finance/ledger";
import {
  findKenpoTable,
  findPensionTable,
  PayrollTableMissingError,
  yearMonthOf,
} from "@niho-finance/payroll";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { TABLE_MISSING_HINT } from "../_lib/labels";
import { EmployeesTable, type EmployeeRow, type GradeTool } from "./employees-table";

export const metadata: Metadata = { title: "従業員" };

/** Whether 「報酬月額から求める」 works this month (the kenpo and pension tables in force). */
function gradeTool(): GradeTool {
  const month = yearMonthOf(todayInJapan());
  try {
    const tables = [findKenpoTable(month), findPensionTable(month)];
    return { available: true, basis: tables.map((table) => table.title).join(" / ") };
  } catch (error) {
    if (!(error instanceof PayrollTableMissingError)) throw error;
    return {
      available: false,
      reason: `${error.message}。それまでは標準報酬月額を直接入れてください（${TABLE_MISSING_HINT}）`,
    };
  }
}

/** 従業員 (22-payroll §6.2): the list (役員を含む), and a sheet to add or edit. */
export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { add } = await searchParams;
  const employees = await listEmployees(await db());
  const rows: EmployeeRow[] = employees.map((employee) => ({
    id: employee.id,
    name: employee.name,
    kind: employee.kind,
    birthDate: employee.birthDate,
    basePay: formatYenInput(employee.basePay),
    commuteAllowance: formatYenInput(employee.commuteAllowance),
    socialInsured: employee.socialInsured,
    insuredFrom: employee.insuredFrom ?? "",
    healthSmr: formatYenInput(employee.healthSmr),
    pensionSmr: formatYenInput(employee.pensionSmr),
    employmentInsured: employee.employmentInsured,
    taxColumn: employee.taxColumn,
    dependents: employee.dependents,
    residentTax: formatYenInput(employee.residentTax),
    isActive: employee.isActive,
  }));
  return (
    <>
      <PageHeader title="従業員" back={{ href: "/payroll", label: "給与" }} />
      <EmployeesTable employees={rows} gradeTool={gradeTool()} startAdding={add === "1"} />
    </>
  );
}

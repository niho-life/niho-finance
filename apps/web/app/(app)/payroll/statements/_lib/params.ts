import { isFeeCategory, type FeeCategory } from "@niho-finance/payroll";

/*
 * The query of the 法定調書 pages (22-payroll §12.2): the year and the 区分 chosen per payee and
 * account (`cat.<partnerId>.<accountCode>`, passed to the PDF / CSV and never stored).
 */

export function readYear(value: string | string[] | undefined | null, fallback: number): number {
  if (typeof value !== "string" || !/^\d{4}$/.test(value)) return fallback;
  const year = Number(value);
  return year >= 2000 && year <= 2100 ? year : fallback;
}

/** `/payroll/statements/<year>/…`: the path's year, or `null`. */
export function pathYear(value: string): number | null {
  if (!/^\d{4}$/.test(value)) return null;
  const year = Number(value);
  return year >= 2000 && year <= 2100 ? year : null;
}

const CATEGORY_KEY = /^cat\.([0-9A-Za-z_-]{1,64})\.(5410|5110)$/;

/** The chosen 区分 from query parameters or form fields (unknown keys and values are ignored). */
export function readCategories(
  entries: Iterable<[string, FormDataEntryValue | string]>,
): Record<string, FeeCategory> {
  const categories: Record<string, FeeCategory> = {};
  for (const [key, value] of entries) {
    const match = CATEGORY_KEY.exec(key);
    if (!match || typeof value !== "string" || !isFeeCategory(value)) continue;
    categories[`${match[1]}.${match[2]}`] = value;
  }
  return categories;
}

/** Search params of a Server Component page as entries. */
export function searchEntries(
  params: Record<string, string | string[] | undefined>,
): [string, string][] {
  return Object.entries(params).flatMap(([key, value]) =>
    typeof value === "string" ? [[key, value] as [string, string]] : [],
  );
}

/** `cat.<id>.<code>=<category>&…` for the links to the PDFs. */
export function categoryQuery(categories: Readonly<Record<string, FeeCategory>>): string {
  return new URLSearchParams(
    Object.entries(categories).map(([key, value]) => [`cat.${key}`, value]),
  ).toString();
}

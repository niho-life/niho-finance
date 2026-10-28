import { redirect } from "next/navigation";

/** `/reports` opens 試算表 with the same conditions (14-reports §2). */
export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      params.append(key, item);
    }
  }
  const query = params.toString();
  redirect(query ? `/reports/trial-balance?${query}` : "/reports/trial-balance");
}

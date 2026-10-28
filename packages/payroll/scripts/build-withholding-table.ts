/**
 * Generates `data/<year>/withholding-monthly.json` from the CSV snapshot
 * `data/<year>/source/withholding-monthly.csv` (22-payroll §3.1・§3.3).
 *
 *     node --experimental-strip-types scripts/build-withholding-table.ts <year>
 *
 * The conversion validates the whole table first and throws on any problem, so nothing is written
 * unless the table is complete. Run `prettier --write data` afterwards (`npm run build:data` does).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { convertWithholdingCsv } from "./withholding-csv.ts";

function main(args: readonly string[]): void {
  const [year, ...rest] = args;
  if (year === undefined || rest.length > 0 || !/^\d{4}$/.test(year)) {
    console.error(
      "usage: node --experimental-strip-types scripts/build-withholding-table.ts <year>",
    );
    process.exitCode = 2;
    return;
  }
  const directory = new URL(`../data/${year}/`, import.meta.url);
  const csvPath = fileURLToPath(new URL("source/withholding-monthly.csv", directory));
  const jsonPath = fileURLToPath(new URL("withholding-monthly.json", directory));
  const table = convertWithholdingCsv(readFileSync(csvPath, "utf8"), Number(year));
  writeFileSync(jsonPath, `${JSON.stringify(table, null, 2)}\n`);
  console.log(
    `${table.id}: ${table.bands.length} rows, ${table.kouPoints.length} points -> ${jsonPath}`,
  );
}

main(process.argv.slice(2));

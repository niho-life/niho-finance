/**
 * Generates `data/<year>/withholding-bonus.json` from the CSV snapshot
 * `data/<year>/source/withholding-bonus.csv` (22-payroll §10.1).
 *
 *     node --experimental-strip-types scripts/build-withholding-bonus-table.ts <year>
 *
 * The conversion validates the whole table first and throws on any problem, so nothing is written
 * unless the table is complete. Run `prettier --write data` afterwards (`npm run build:data` does).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { convertWithholdingBonusCsv } from "./withholding-bonus-csv.ts";

function main(args: readonly string[]): void {
  const [year, ...rest] = args;
  if (year === undefined || rest.length > 0 || !/^\d{4}$/.test(year)) {
    console.error(
      "usage: node --experimental-strip-types scripts/build-withholding-bonus-table.ts <year>",
    );
    process.exitCode = 2;
    return;
  }
  const directory = new URL(`../data/${year}/`, import.meta.url);
  const csvPath = fileURLToPath(new URL("source/withholding-bonus.csv", directory));
  const jsonPath = fileURLToPath(new URL("withholding-bonus.json", directory));
  const table = convertWithholdingBonusCsv(readFileSync(csvPath, "utf8"), Number(year));
  writeFileSync(jsonPath, `${JSON.stringify(table, null, 2)}\n`);
  console.log(`${table.id}: ${table.rows.length} rows -> ${jsonPath}`);
}

main(process.argv.slice(2));

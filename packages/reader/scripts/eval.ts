/**
 * `npm -w @niho-finance/reader run eval [recordings.json]`: compares recorded answers with the
 * gold set's expected readings (20-reader §12) and shows, per fixture, whether the date, the
 * total and the per-rate breakdown match and which warnings the validation raised. Exits 1 when
 * fewer than 8 fixtures match or a mismatch goes without a warning.
 */
import { resolve } from "node:path";
import { defaultRecordingsPath, isReaderModel } from "../src/config";
import {
  evaluateGoldSet,
  GOLD_SET_REQUIRED_MATCHES,
  loadGoldSet,
  summarizeGoldSet,
  type GoldSetResult,
} from "../src/gold-set";
import { costNanoUsd, formatUsd } from "../src/pricing";
import { createRecordedReader, loadRecordingFile } from "../src/recorded";

const path = process.argv[2] ? resolve(process.argv[2]) : defaultRecordingsPath();
const recordings = loadRecordingFile(path);
const reader = createRecordedReader({ recordings });
const results = await evaluateGoldSet(reader, loadGoldSet());
const summary = summarizeGoldSet(results);

const mark = (value: boolean | undefined) => (value === undefined ? "-" : value ? "ok" : "NG");

function row(result: GoldSetResult): string[] {
  const c = result.comparison;
  const notes = result.error
    ? `読み取れず: ${result.error.message}`
    : result.issues.map((issue) => issue.code).join(", ");
  return [
    result.id,
    result.file,
    mark(c?.date),
    mark(c?.total),
    mark(c?.rates),
    mark(c?.registrationNumber),
    mark(c?.issuerName),
    notes,
  ];
}

const header = ["id", "file", "date", "total", "rates", "reg.no", "issuer", "warnings"];
const rows = [header, ...results.map(row)];
const widths = header.map((_, column) =>
  Math.max(...rows.map((cells) => (cells[column] ?? "").length)),
);
const format = (cells: string[]) =>
  cells
    .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
    .join("  ");

const tokens = results.reduce(
  (total, result) => ({
    inputTokens: total.inputTokens + (result.usage?.inputTokens ?? 0),
    outputTokens: total.outputTokens + (result.usage?.outputTokens ?? 0),
  }),
  { inputTokens: 0, outputTokens: 0 },
);
const cost = isReaderModel(recordings.model)
  ? `約 ${formatUsd(costNanoUsd(recordings.model, tokens))}`
  : "合成の応答のため費用なし";
const mismatches = summary.count - summary.matched;

console.log(`記録: ${path}`);
console.log(`モデル: ${recordings.model}`);
console.log("");
for (const cells of rows) console.log(format(cells));
console.log("");
console.log(
  `日付 ${summary.date}/${summary.count} · 合計 ${summary.total}/${summary.count} · ` +
    `内訳 ${summary.rates}/${summary.count} · 3 項目とも一致 ${summary.matched}/${summary.count}` +
    `（登録番号 ${summary.registrationNumber}/${summary.count} · 発行者 ${summary.issuerName}/${summary.count}）`,
);
console.log(
  `一致しない ${mismatches} 枚のうち、警告か読み取れずで知らせるもの ${summary.flaggedMismatches} 枚` +
    (summary.failed > 0 ? `（読み取れず ${summary.failed} 枚）` : ""),
);
console.log(
  `トークン 入力 ${tokens.inputTokens.toLocaleString("ja-JP")} · 出力 ${tokens.outputTokens.toLocaleString("ja-JP")} · ${cost}`,
);
console.log(
  summary.passed
    ? `合格（${GOLD_SET_REQUIRED_MATCHES} 枚以上が一致し、一致しない分はすべて知らせる）`
    : `不合格（${GOLD_SET_REQUIRED_MATCHES} 枚以上の一致と、一致しない分への警告が要る）`,
);
process.exitCode = summary.passed ? 0 : 1;

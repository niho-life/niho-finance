/**
 * `npm -w @niho-finance/reader run record`: reads the gold set with the real Anthropic API and
 * writes the answers to `fixtures/receipts/recorded.<model>.json` (20-reader §12). Needs
 * `ANTHROPIC_API_KEY`; the model is `NIHO_FINANCE_READER_MODEL` (default claude-haiku-5-5).
 * Costs about $0.01 with Haiku. Compare the result with `npm run eval <file>`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAnthropicReader } from "../src/anthropic";
import { DEFAULT_READER_MODEL, isReaderModel, READER_MODELS } from "../src/config";
import { GOLD_SET_DIR, loadGoldSet } from "../src/gold-set";
import { costNanoUsd, formatUsd } from "../src/pricing";
import { ReaderError } from "../src/provider";
import type { RecordingFile } from "../src/recorded";

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) {
  console.error(
    "ANTHROPIC_API_KEY がありません。実 API で記録するには鍵を設定して、もう一度実行してください。",
  );
  console.error(
    "鍵がない間は、合成の記録（fixtures/receipts/recorded.json）で npm run eval が動きます。",
  );
  process.exit(1);
}
const model = process.env.NIHO_FINANCE_READER_MODEL?.trim() || DEFAULT_READER_MODEL;
if (!isReaderModel(model)) {
  console.error(
    `NIHO_FINANCE_READER_MODEL は ${READER_MODELS.join(" / ")} のどれかにしてください。`,
  );
  process.exit(1);
}

const reader = createAnthropicReader({ apiKey, model });
const responses: RecordingFile["responses"] = {};
const total = { inputTokens: 0, outputTokens: 0 };
let failures = 0;
for (const entry of loadGoldSet()) {
  try {
    const { raw, usage } = await reader.read(entry);
    responses[entry.sha256] = { fixture: entry.id, raw, usage };
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    console.log(`${entry.id}  ok  入力 ${usage.inputTokens} · 出力 ${usage.outputTokens}`);
  } catch (error) {
    if (!(error instanceof ReaderError)) throw error;
    failures += 1;
    if (error.usage) {
      total.inputTokens += error.usage.inputTokens;
      total.outputTokens += error.usage.outputTokens;
    }
    console.log(`${entry.id}  ${error.code}  ${error.message}`);
  }
}

const recordedOn = new Date().toISOString().slice(0, 10);
const file: RecordingFile = {
  model,
  note: `${model} の実 API の応答（${recordedOn} に npm -w @niho-finance/reader run record で記録）。`,
  responses,
};
const out = join(GOLD_SET_DIR, `recorded.${model}.json`);
writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);

console.log("");
console.log(`${Object.keys(responses).length} 件を記録しました（失敗 ${failures} 件）: ${out}`);
console.log(`費用 約 ${formatUsd(costNanoUsd(model, total))}`);
console.log(`比べる: npm -w @niho-finance/reader run eval ${out}`);
console.log(
  `既定の記録にする: cp ${out} ${join(GOLD_SET_DIR, "recorded.json")}（npx prettier --write で整形）`,
);

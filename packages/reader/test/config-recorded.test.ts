import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createReader, defaultRecordingsPath, readerConfig } from "../src/config";
import { GOLD_SET_DIR, loadGoldSet } from "../src/gold-set";
import { ReaderError } from "../src/provider";
import {
  createRecordedReader,
  loadRecordingFile,
  parseRecordingFile,
  type RecordingFile,
} from "../src/recorded";

const KEY = "sk-ant-test-fictional-key";

describe("readerConfig (20-reader §2.2)", () => {
  it("is off without a key and without a provider", () => {
    expect(readerConfig({})).toEqual({ status: "off" });
    expect(readerConfig({ ANTHROPIC_API_KEY: " " })).toEqual({ status: "off" });
    expect(readerConfig({ NIHO_FINANCE_READER_PROVIDER: "off", ANTHROPIC_API_KEY: KEY })).toEqual({
      status: "off",
    });
  });

  it("uses Anthropic with Haiku when a key is set, and never returns the key", () => {
    const config = readerConfig({ ANTHROPIC_API_KEY: KEY });
    expect(config).toEqual({ status: "on", provider: "anthropic", model: "claude-haiku-5-5" });
    expect(JSON.stringify(config)).not.toContain(KEY);
    expect(
      readerConfig({ ANTHROPIC_API_KEY: KEY, NIHO_FINANCE_READER_MODEL: "claude-sonnet-5-5" }),
    ).toEqual({ status: "on", provider: "anthropic", model: "claude-sonnet-5-5" });
  });

  it("is off when Anthropic is chosen without a key", () => {
    expect(readerConfig({ NIHO_FINANCE_READER_PROVIDER: "anthropic" })).toEqual({ status: "off" });
  });

  it("reports an unknown model or provider as a setting error", () => {
    expect(
      readerConfig({ ANTHROPIC_API_KEY: KEY, NIHO_FINANCE_READER_MODEL: "claude-opus-5-5" }),
    ).toEqual({
      status: "invalid",
      reason: "読み取りの設定が正しくありません（NIHO_FINANCE_READER_MODEL）",
    });
    expect(readerConfig({ NIHO_FINANCE_READER_PROVIDER: "openai" })).toEqual({
      status: "invalid",
      reason: "読み取りの設定が正しくありません（NIHO_FINANCE_READER_PROVIDER）",
    });
  });

  it("uses recorded answers outside production only, from the gold set by default", () => {
    expect(readerConfig({ NIHO_FINANCE_READER_PROVIDER: "recorded" })).toEqual({
      status: "on",
      provider: "recorded",
      model: "claude-haiku-5-5",
      recordingsPath: defaultRecordingsPath(),
    });
    expect(defaultRecordingsPath()).toBe(join(GOLD_SET_DIR, "recorded.json"));
    expect(
      readerConfig({
        NIHO_FINANCE_READER_PROVIDER: "recorded",
        NIHO_FINANCE_READER_RECORDINGS: "/tmp/answers.json",
      }),
    ).toMatchObject({ recordingsPath: "/tmp/answers.json" });
    expect(
      readerConfig({ NIHO_FINANCE_READER_PROVIDER: "recorded", NIHO_FINANCE_ENV: "prod" }),
    ).toEqual({ status: "off" });
  });
});

describe("createReader", () => {
  it("returns null when off or misconfigured", () => {
    expect(createReader({})).toBeNull();
    expect(
      createReader({ ANTHROPIC_API_KEY: KEY, NIHO_FINANCE_READER_MODEL: "claude-unknown" }),
    ).toBeNull();
  });

  it("builds the Anthropic provider with the model", () => {
    expect(createReader({ ANTHROPIC_API_KEY: KEY })).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-5-5",
    });
  });

  it("builds the recorded provider with the model of its file", () => {
    expect(createReader({ NIHO_FINANCE_READER_PROVIDER: "recorded" })).toMatchObject({
      provider: "recorded",
      model: "synthetic",
    });
  });

  it("reports a missing recording file", () => {
    expect(() =>
      createReader({
        NIHO_FINANCE_READER_PROVIDER: "recorded",
        NIHO_FINANCE_READER_RECORDINGS: join(GOLD_SET_DIR, "missing.json"),
      }),
    ).toThrow(ReaderError);
  });
});

describe("createRecordedReader", () => {
  const [entry] = loadGoldSet();
  if (!entry) throw new Error("the gold set is empty");
  const recordings: RecordingFile = {
    model: "claude-haiku-5-5",
    note: "test",
    responses: {
      [entry.sha256]: {
        fixture: entry.id,
        raw: { answer: 1 },
        usage: { inputTokens: 1500, outputTokens: 400 },
      },
    },
  };

  it("answers by SHA-256 with a copy of the recorded answer", async () => {
    const reader = createRecordedReader({ recordings });
    expect(reader).toMatchObject({ provider: "recorded", model: "claude-haiku-5-5" });
    const result = await reader.read(entry);
    expect(result).toEqual({ raw: { answer: 1 }, usage: { inputTokens: 1500, outputTokens: 400 } });
    (result.raw as { answer: number }).answer = 2;
    expect((await reader.read(entry)).raw).toEqual({ answer: 1 });
    expect(createRecordedReader({ recordings, model: "override" }).model).toBe("override");
  });

  it("fails with not_recorded for an unknown file and checks the format first", async () => {
    const reader = createRecordedReader({ recordings });
    await expect(reader.read({ ...entry, sha256: "f".repeat(64) })).rejects.toMatchObject({
      code: "not_recorded",
      message: "この証憑の記録済みの応答がありません（開発用の読み取り）",
    });
    await expect(reader.read({ ...entry, mime: "text/csv" })).rejects.toMatchObject({
      code: "unsupported_mime",
    });
  });

  it("checks the recording file", () => {
    expect(() => parseRecordingFile({ model: "x", note: "", responses: { abc: {} } })).toThrow(
      ReaderError,
    );
    const dir = mkdtempSync(join(tmpdir(), "reader-recordings-"));
    const path = join(dir, "broken.json");
    writeFileSync(path, "{ not json");
    expect(() => loadRecordingFile(path)).toThrow(ReaderError);
    writeFileSync(path, JSON.stringify(recordings));
    expect(loadRecordingFile(path)).toEqual(recordings);
  });
});

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAnthropicReader } from "./anthropic";
import type { ReaderProvider } from "./provider";
import { createRecordedReader, loadRecordingFile } from "./recorded";

/**
 * Chooses the provider from the environment (20-reader §2.2). The key itself never leaves this
 * module: the configuration says only whether reading is on and with what.
 */

export const READER_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"] as const;
export type ReaderModel = (typeof READER_MODELS)[number];

/** Light and cheap; switch to `claude-sonnet-5-5` when the gold set says it reads too poorly. */
export const DEFAULT_READER_MODEL: ReaderModel = "claude-haiku-5-5";

const RECORDINGS_FROM_ROOT = "packages/reader/fixtures/receipts/recorded.json";

/**
 * The recorded answers for the gold set (`fixtures/receipts/recorded.json`), resolved from this
 * module's URL. When a bundler has rewritten that URL (the web app transpiles this package), the
 * file is looked for under the repository root above the working directory instead. Resolved on
 * use, so that importing the package never touches the file system.
 */
export function defaultRecordingsPath(): string {
  try {
    const url = new URL("../fixtures/receipts/recorded.json", import.meta.url);
    if (url.protocol === "file:" && existsSync(url)) return fileURLToPath(url);
  } catch {
    // Not a file URL: fall through to the working directory.
  }
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = join(dir, RECORDINGS_FROM_ROOT);
    if (existsSync(candidate) || dirname(dir) === dir) return candidate;
  }
}

export function isReaderModel(value: unknown): value is ReaderModel {
  return typeof value === "string" && (READER_MODELS as readonly string[]).includes(value);
}

export type ReaderConfig =
  | { status: "off" }
  /** A setting is wrong: reading is off and the screen says which variable. */
  | { status: "invalid"; reason: string }
  | {
      status: "on";
      provider: "anthropic" | "recorded";
      model: ReaderModel;
      recordingsPath?: string;
    };

function setting(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

export function readerConfig(env: NodeJS.ProcessEnv): ReaderConfig {
  const hasKey = setting(env, "ANTHROPIC_API_KEY") !== null;
  const provider = setting(env, "NIHO_FINANCE_READER_PROVIDER") ?? (hasKey ? "anthropic" : "off");
  if (provider === "off") return { status: "off" };
  if (provider !== "anthropic" && provider !== "recorded") {
    return {
      status: "invalid",
      reason: "読み取りの設定が正しくありません（NIHO_FINANCE_READER_PROVIDER）",
    };
  }
  // Recorded answers are for development only; without a key there is nothing to call.
  if (provider === "recorded" && env.NIHO_FINANCE_ENV === "prod") return { status: "off" };
  if (provider === "anthropic" && !hasKey) return { status: "off" };

  const model = setting(env, "NIHO_FINANCE_READER_MODEL") ?? DEFAULT_READER_MODEL;
  if (!isReaderModel(model)) {
    return {
      status: "invalid",
      reason: "読み取りの設定が正しくありません（NIHO_FINANCE_READER_MODEL）",
    };
  }
  if (provider === "recorded") {
    return {
      status: "on",
      provider,
      model,
      recordingsPath: setting(env, "NIHO_FINANCE_READER_RECORDINGS") ?? defaultRecordingsPath(),
    };
  }
  return { status: "on", provider, model };
}

/**
 * The provider for the environment, or `null` when reading is off or misconfigured. Not cached:
 * the caller keeps one per process. A recorded provider answers with the model of its file.
 */
export function createReader(env: NodeJS.ProcessEnv): ReaderProvider | null {
  const config = readerConfig(env);
  if (config.status !== "on") return null;
  if (config.provider === "recorded") {
    return createRecordedReader({
      recordings: loadRecordingFile(config.recordingsPath ?? defaultRecordingsPath()),
    });
  }
  const apiKey = setting(env, "ANTHROPIC_API_KEY");
  if (apiKey === null) return null;
  return createAnthropicReader({ apiKey, model: config.model });
}

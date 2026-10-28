import { readFileSync } from "node:fs";
import { z } from "zod";
import { assertReadable, ReaderError, type ProviderUsage, type ReaderProvider } from "./provider";

/**
 * Recorded answers by the file's SHA-256 (20-reader §2): the tests and the development screens
 * read documents without a key. Never used in production (`readerConfig`).
 */

export interface RecordedResponse {
  /** The gold set fixture the answer was recorded for (`r01`, …). */
  fixture: string;
  raw: unknown;
  usage: ProviderUsage;
}

export interface RecordingFile {
  /** The model that answered, or `synthetic` for hand-made answers. */
  model: string;
  note: string;
  /** SHA-256 (lower-case hex) of the file → the answer. */
  responses: Record<string, RecordedResponse>;
}

const tokenCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const recordingFileSchema = z.object({
  model: z.string().min(1),
  note: z.string(),
  responses: z.record(
    z.string().regex(/^[0-9a-f]{64}$/),
    z.object({
      fixture: z.string(),
      raw: z.unknown(),
      usage: z.object({ inputTokens: tokenCount, outputTokens: tokenCount }),
    }),
  ),
});

export function parseRecordingFile(json: unknown): RecordingFile {
  const parsed = recordingFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new ReaderError("not_configured", "読み取りの記録ファイルの形式が正しくありません");
  }
  return parsed.data;
}

export function loadRecordingFile(path: string | URL): RecordingFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ReaderError("not_configured", "読み取りの記録ファイルを読めません");
  }
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    throw new ReaderError("not_configured", "読み取りの記録ファイルの形式が正しくありません");
  }
  return parseRecordingFile(json);
}

export function createRecordedReader(options: {
  recordings: RecordingFile;
  /** Defaults to the model of the recording file. */
  model?: string;
}): ReaderProvider {
  const { recordings } = options;
  return {
    provider: "recorded",
    model: options.model ?? recordings.model,
    read({ bytes, mime, sha256 }) {
      // Errors thrown in the executor reject the promise, as the API provider's would.
      return new Promise((resolve) => {
        assertReadable({ bytes, mime });
        const recorded = recordings.responses[sha256.toLowerCase()];
        if (!recorded) throw new ReaderError("not_recorded");
        resolve({ raw: structuredClone(recorded.raw), usage: { ...recorded.usage } });
      });
    },
  };
}

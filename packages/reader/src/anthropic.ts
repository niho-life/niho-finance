import Anthropic from "@anthropic-ai/sdk";
import type { ReaderModel } from "./config";
import { assertReadable, ReaderError, type ProviderUsage, type ReaderProvider } from "./provider";
import { READING_JSON_SCHEMA } from "./reading";

/**
 * The Anthropic API provider (20-reader §2.3): one Messages call per document with structured
 * output. Only the file itself is sent; no company data goes into the prompt. The only module
 * that imports the SDK.
 */

export const READER_MAX_TOKENS = 4096;
export const READER_TIMEOUT_MS = 60_000;

/** Fixed instructions. Kept free of any company data so that the prompt is the same for every file. */
export const READER_SYSTEM_PROMPT = [
  "あなたは日本の領収書・レシート・適格請求書・適格簡易請求書を読み取り、指定の JSON で答えます。",
  "- documentType: 領収書・レシートは receipt、請求書は invoice、それ以外は other。",
  "- issuerName: 発行者（売り手）の名称を印字どおりに。宛名（買い手）と取り違えない。",
  "- registrationNumber: 登録番号（T と 13 桁）を印字どおりに。なければ null。",
  "- transactionDate: 取引日を YYYY-MM-DD で。請求書で取引日がなければ請求日。",
  "- currency: ISO 4217 の通貨コード。円なら JPY。",
  "- totalAmount: 支払う合計（税込）を円の整数で。",
  "- rates: 税率ごとの対価を印字どおりに。amount が税込なら taxIncluded を true、税抜なら false。消費税額が印字されていれば taxAmount、なければ null。内訳の印字がなければ空の配列。",
  "- 読めない項目・書かれていない項目は null にする。推測や計算で埋めない。",
  "- legible: かすれ・切れ・ピンぼけで読めない部分があれば false。",
  "- description: 但し書きか、品目の要約を 60 字まで。",
].join("\n");

const READER_INSTRUCTION = "この証憑を読み取り、指定の JSON で答えてください。";

function sourceBlock(bytes: Uint8Array, mime: string): Anthropic.ContentBlockParam {
  const data = Buffer.from(bytes).toString("base64");
  if (mime === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
  }
  return {
    type: "image",
    source: { type: "base64", media_type: mime as Anthropic.Base64ImageSource["media_type"], data },
  };
}

/** SDK errors → `ReaderError("api")` with the HTTP status only (no body, no key, no URL). */
function wrapApiError(error: unknown): unknown {
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new ReaderError("api", "読み取りの API が時間内に応答しませんでした");
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ReaderError("api", "読み取りの API に接続できませんでした");
  }
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === "number" ? `（HTTP ${error.status}）` : "";
    return new ReaderError("api", `読み取りの API でエラーが起きました${status}`);
  }
  if (error instanceof Anthropic.AnthropicError) {
    return new ReaderError("not_configured", "読み取りの API の設定が正しくありません");
  }
  return error;
}

export function createAnthropicReader(options: {
  apiKey?: string;
  model: ReaderModel;
  /** Injected in tests; built from `apiKey` otherwise. */
  client?: Anthropic;
}): ReaderProvider {
  const client =
    options.client ??
    new Anthropic({
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      timeout: READER_TIMEOUT_MS,
    });
  const model = options.model;

  return {
    provider: "anthropic",
    model,
    async read({ bytes, mime }) {
      assertReadable({ bytes, mime });
      let message: Anthropic.Message;
      try {
        message = await client.messages.create(
          {
            model,
            max_tokens: READER_MAX_TOKENS,
            system: READER_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: [sourceBlock(bytes, mime), { type: "text", text: READER_INSTRUCTION }],
              },
            ],
            output_config: {
              effort: "medium",
              format: { type: "json_schema", schema: READING_JSON_SCHEMA },
            },
          },
          { timeout: READER_TIMEOUT_MS },
        );
      } catch (error) {
        throw wrapApiError(error);
      }

      const usage: ProviderUsage = {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      };
      if (message.stop_reason === "refusal") throw new ReaderError("refusal", undefined, usage);
      if (
        message.stop_reason === "max_tokens" ||
        message.stop_reason === "model_context_window_exceeded"
      ) {
        throw new ReaderError("truncated", undefined, usage);
      }
      const text = message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
      let raw: unknown;
      try {
        raw = JSON.parse(text) as unknown;
      } catch {
        throw new ReaderError("invalid_output", undefined, usage);
      }
      return { raw, usage };
    },
  };
}

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  createAnthropicReader,
  READER_MAX_TOKENS,
  READER_SYSTEM_PROMPT,
  READER_TIMEOUT_MS,
} from "../src/anthropic";
import { MAX_IMAGE_BYTES, ReaderError } from "../src/provider";
import { READING_JSON_SCHEMA } from "../src/reading";

/** A fictional key: it must never appear in a message. */
const API_KEY = "sk-ant-test-fictional-key";

const ANSWER = {
  documentType: "receipt",
  legible: true,
  issuerName: "架空食堂",
  registrationNumber: "T8999999999901",
  transactionDate: "2026-10-02",
  currency: "JPY",
  totalAmount: 2500,
  rates: [{ ratePercent: 10, amount: 2500, taxIncluded: true, taxAmount: 227 }],
  description: "飲食代",
};

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_test_01",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    container: null,
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: JSON.stringify(ANSWER), citations: null },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 1612,
      output_tokens: 412,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "request-id": "req_test" },
  });
}

/** A real SDK client whose transport is faked: the request body is what the SDK would send. */
function fakeClient(respond: () => Response | Promise<Response> = () => json(message())) {
  const bodies: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
    return respond();
  });
  const client = new Anthropic({ apiKey: API_KEY, fetch, maxRetries: 0 });
  return { client, bodies, fetch };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = new TextEncoder().encode("%PDF-1.4\n%fictional\n");
const SHA = "0".repeat(64);

async function rejection(promise: Promise<unknown>): Promise<ReaderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ReaderError) return error;
    throw error;
  }
  throw new Error("expected a ReaderError");
}

describe("createAnthropicReader (20-reader §2.3)", () => {
  it("sends an image block, the instruction and structured output, and returns raw and usage", async () => {
    const { client, bodies } = fakeClient();
    const reader = createAnthropicReader({ model: "claude-haiku-5-5", client });
    const result = await reader.read({ bytes: PNG, mime: "image/png", sha256: SHA });

    expect(reader).toMatchObject({ provider: "anthropic", model: "claude-haiku-5-5" });
    expect(result).toEqual({ raw: ANSWER, usage: { inputTokens: 1612, outputTokens: 412 } });
    expect(bodies).toHaveLength(1);
    const body = bodies[0] ?? {};
    expect(body).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: READER_MAX_TOKENS,
      system: READER_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: Buffer.from(PNG).toString("base64"),
              },
            },
            { type: "text", text: expect.any(String) as unknown },
          ],
        },
      ],
      output_config: {
        effort: "medium",
        format: {
          type: "json_schema",
          schema: JSON.parse(JSON.stringify(READING_JSON_SCHEMA)) as unknown,
        },
      },
    });
    // Rejected (400) by Haiku 5.5 / Sonnet 5.5, so never sent.
    for (const key of ["thinking", "temperature", "top_p", "top_k", "fallbacks"]) {
      expect(body).not.toHaveProperty(key);
    }
    expect(READER_MAX_TOKENS).toBe(4096);
    expect(READER_TIMEOUT_MS).toBe(60_000);
  });

  it("sends a PDF as a document block", async () => {
    const { client, bodies } = fakeClient();
    const reader = createAnthropicReader({ model: "claude-sonnet-5-5", client });
    await reader.read({ bytes: PDF, mime: "application/pdf", sha256: SHA });

    const [body] = bodies;
    expect(body?.model).toBe("claude-sonnet-5-5");
    expect((body?.messages as { content: unknown[] }[])[0]?.content[0]).toEqual({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: Buffer.from(PDF).toString("base64"),
      },
    });
  });

  it("keeps company data out of the prompt", () => {
    expect(READER_SYSTEM_PROMPT).not.toMatch(/架空|株式会社|T\d{13}/);
  });

  it("turns a refusal and a cut-off answer into errors that keep the usage", async () => {
    const refused = fakeClient(() =>
      json(
        message({
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: null, explanation: null },
          content: [],
        }),
      ),
    );
    const refusal = await rejection(
      createAnthropicReader({ model: "claude-haiku-5-5", client: refused.client }).read({
        bytes: PNG,
        mime: "image/png",
        sha256: SHA,
      }),
    );
    expect(refusal.code).toBe("refusal");
    expect(refusal.usage).toEqual({ inputTokens: 1612, outputTokens: 412 });

    const cut = fakeClient(() =>
      json(message({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"doc' }] })),
    );
    const truncated = await rejection(
      createAnthropicReader({ model: "claude-haiku-5-5", client: cut.client }).read({
        bytes: PNG,
        mime: "image/png",
        sha256: SHA,
      }),
    );
    expect(truncated.code).toBe("truncated");
    expect(truncated.usage).toEqual({ inputTokens: 1612, outputTokens: 412 });
  });

  it("turns an answer that is not JSON into invalid_output", async () => {
    const { client } = fakeClient(() =>
      json(message({ content: [{ type: "text", text: "読み取れませんでした", citations: null }] })),
    );
    const error = await rejection(
      createAnthropicReader({ model: "claude-haiku-5-5", client }).read({
        bytes: PNG,
        mime: "image/png",
        sha256: SHA,
      }),
    );
    expect(error.code).toBe("invalid_output");
    expect(error.usage).toEqual({ inputTokens: 1612, outputTokens: 412 });
  });

  it("wraps API errors with the HTTP status only — no body, key or URL", async () => {
    for (const status of [400, 401, 429, 500, 529]) {
      const { client } = fakeClient(() =>
        json(
          {
            type: "error",
            error: { type: "api_error", message: `secret detail ${API_KEY}` },
          },
          status,
        ),
      );
      const error = await rejection(
        createAnthropicReader({ model: "claude-haiku-5-5", client }).read({
          bytes: PNG,
          mime: "image/png",
          sha256: SHA,
        }),
      );
      expect(error.code).toBe("api");
      expect(error.message).toBe(`読み取りの API でエラーが起きました（HTTP ${status}）`);
      expect(error.usage).toBeNull();
    }
  });

  it("wraps a connection failure", async () => {
    const { client } = fakeClient(() =>
      Promise.reject(new TypeError(`connect ECONNREFUSED https://api.anthropic.com ${API_KEY}`)),
    );
    const error = await rejection(
      createAnthropicReader({ model: "claude-haiku-5-5", client }).read({
        bytes: PNG,
        mime: "image/png",
        sha256: SHA,
      }),
    );
    expect(error.code).toBe("api");
    expect(error.message).toBe("読み取りの API に接続できませんでした");
    expect(error.message).not.toContain(API_KEY);
  });

  it("rejects images over 5 MB and other formats without calling the API", async () => {
    const { client, fetch } = fakeClient();
    const reader = createAnthropicReader({ model: "claude-haiku-5-5", client });
    const large = await rejection(
      reader.read({ bytes: new Uint8Array(MAX_IMAGE_BYTES + 1), mime: "image/jpeg", sha256: SHA }),
    );
    expect(large.code).toBe("too_large");
    expect(large.message).toBe("画像が大きすぎます。5 MB 以下にして撮り直すか、PDF にしてください");
    for (const mime of ["image/heic", "text/csv", "image/gif"]) {
      expect((await rejection(reader.read({ bytes: PNG, mime, sha256: SHA }))).code).toBe(
        "unsupported_mime",
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

import { createHmac } from "node:crypto";
import type { GmoFetch } from "../../src/gmo-aozora/http";
import type {
  GmoAccount,
  GmoAozoraApi,
  GmoBalance,
  GmoTransactionsPage,
} from "../../src/gmo-aozora/types";
import { fixtureJson } from "./fixtures";

/** A fixture under `test/fixtures/gmo-aozora` (fictional answers of the bank API). */
export function gmoFixture<T = unknown>(name: string): T {
  return fixtureJson(`gmo-aozora/${name}.json`) as T;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** A `fetch` that records each request and answers with `answer(request)`. */
export function fakeFetch(answer: (request: RecordedRequest) => Response | Promise<Response>): {
  fetch: GmoFetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetch: GmoFetch = async (url, init) => {
    const request: RecordedRequest = {
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? init.body : null,
    };
    requests.push(request);
    return answer(request);
  };
  return { fetch, requests };
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/** An ID Token signed as GMO signs them: HS256 with the client secret (fictional in tests). */
export function signIdToken(
  claims: Record<string, unknown>,
  secret: string,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): string {
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest();
  return `${signingInput}.${base64url(signature)}`;
}

/** The account API over fixture pages: `pages` answer `listTransactions` in turn. */
export class FakeGmoApi implements GmoAozoraApi {
  readonly calls: Parameters<GmoAozoraApi["listTransactions"]>[0][] = [];
  private index = 0;

  constructor(
    private readonly pages: readonly GmoTransactionsPage[],
    private readonly accounts: readonly GmoAccount[] = [],
    private readonly balances: readonly GmoBalance[] = [],
  ) {}

  listAccounts(): Promise<GmoAccount[]> {
    return Promise.resolve([...this.accounts]);
  }

  getBalance(accountId: string): Promise<GmoBalance | null> {
    return Promise.resolve(this.balances.find((item) => item.accountId === accountId) ?? null);
  }

  listTransactions(
    params: Parameters<GmoAozoraApi["listTransactions"]>[0],
  ): Promise<GmoTransactionsPage> {
    this.calls.push(params);
    const page = this.pages[Math.min(this.index, this.pages.length - 1)];
    this.index += 1;
    if (page === undefined) return Promise.reject(new Error("no pages"));
    return Promise.resolve(page);
  }
}

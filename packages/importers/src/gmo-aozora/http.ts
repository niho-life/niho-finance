/** `fetch` as the bank calls use it: Node's own by default, a fake in tests. */
export type GmoFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Each call to the bank gives up after 30 seconds (19-bank-api §6.2). */
export const GMO_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Sends one request. Redirects are not followed (a token never goes to another URL); the caller
 * sees the 3xx answer. Throws what `fetch` throws (network failure, timeout).
 */
export function send(fetchFn: GmoFetch | undefined, url: string, init: RequestInit) {
  return (fetchFn ?? fetch)(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(GMO_REQUEST_TIMEOUT_MS),
  });
}

/** Whether `fetch` gave up on the timeout (as opposed to a network failure). */
export function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** The body as JSON, or `undefined` when it is empty or not JSON. */
export async function readJsonBody(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string field, or `null` when absent or of another type. */
export function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/** Collapses whitespace and cuts a text from the bank to one short line. */
export function oneLine(text: string, max = 200): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

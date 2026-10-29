import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

/*
 * `public/sw.js` (10 §1.1) run in a `node:vm` context with a fake worker scope: listeners, an
 * in-memory Cache Storage and a fake `fetch` (Node's Request / Response). It caches 接続がない画面
 * and nothing else, answers only GET navigations, and replaces a response only when the
 * connection failed.
 */

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const source = readFileSync(path.join(publicDir, "sw.js"), "utf8");
const offlineHtml = readFileSync(path.join(publicDir, "offline.html"), "utf8");

/** A fictional origin: the worker's relative URLs resolve against it. */
const ORIGIN = "https://finance.example.test";
const CACHE_NAME = "niho-finance-offline-v1";
const OFFLINE_URL = `${ORIGIN}/offline.html`;

/** Node's Request, with the worker's relative URLs (`/offline.html`) resolved against ORIGIN. */
class WorkerRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, ORIGIN) : input, init);
  }
}

const urlOf = (input: RequestInfo | URL) =>
  typeof input === "string"
    ? new URL(input, ORIGIN).href
    : input instanceof URL
      ? input.href
      : input.url;

type Fetch = (input: Request) => Promise<Response>;

class MemoryCache {
  readonly entries = new Map<string, Response>();

  constructor(
    private readonly fetcher: Fetch,
    private readonly writes: string[],
  ) {}

  async add(request: Request): Promise<void> {
    const response = await this.fetcher(request);
    if (!response.ok) throw new TypeError(`Cache.add: ${response.status}`);
    await this.put(request, response);
  }

  put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.writes.push(urlOf(request));
    this.entries.set(urlOf(request), response);
    return Promise.resolve();
  }

  match(request: RequestInfo | URL): Promise<Response | undefined> {
    return Promise.resolve(this.entries.get(urlOf(request))?.clone());
  }
}

class MemoryCacheStorage {
  readonly caches = new Map<string, MemoryCache>();
  /** Every URL ever written to any cache. */
  readonly writes: string[] = [];

  constructor(private readonly fetcher: Fetch) {}

  open(name: string): Promise<MemoryCache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new MemoryCache(this.fetcher, this.writes);
      this.caches.set(name, cache);
    }
    return Promise.resolve(cache);
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.caches.keys()]);
  }

  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.caches.delete(name));
  }

  async match(
    request: RequestInfo | URL,
    options: { cacheName?: string } = {},
  ): Promise<Response | undefined> {
    const names = options.cacheName ? [options.cacheName] : [...this.caches.keys()];
    for (const name of names) {
      const found = await this.caches.get(name)?.match(request);
      if (found) return found;
    }
    return undefined;
  }
}

interface ExtendableEvent {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent {
  request: Request;
  preloadResponse: Promise<Response | undefined>;
  respondWith(response: Promise<Response>): void;
}

/** Loads sw.js. `network` answers the worker's `fetch` (the offline page is served by default). */
function loadWorker(options: { network?: Fetch; navigationPreload?: boolean } = {}) {
  const network: Fetch =
    options.network ?? (() => Promise.reject(new TypeError("Failed to fetch")));
  const fetch = vi.fn<Fetch>((request) =>
    request.url === OFFLINE_URL
      ? Promise.resolve(new Response(offlineHtml, { headers: { "content-type": "text/html" } }))
      : network(request),
  );
  const listeners = new Map<string, (event: unknown) => void>();
  const navigationPreload =
    options.navigationPreload === false ? undefined : { enable: vi.fn(() => Promise.resolve()) };
  const worker = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    },
    skipWaiting: vi.fn(() => Promise.resolve()),
    registration: { navigationPreload },
    clients: { claim: vi.fn(() => Promise.resolve()) },
  };
  const caches = new MemoryCacheStorage(fetch);
  vm.runInContext(
    source,
    vm.createContext({ self: worker, caches, fetch, Request: WorkerRequest, Response, URL }),
    { filename: "sw.js" },
  );

  async function extendable(type: "install" | "activate"): Promise<void> {
    const pending: Promise<unknown>[] = [];
    const event: ExtendableEvent = { waitUntil: (promise) => void pending.push(promise) };
    listeners.get(type)?.(event);
    await Promise.all(pending);
  }

  /** Dispatches `fetch`; the promise given to `respondWith`, or `null` when it was not called. */
  function dispatchFetch(
    request: Request,
    preloadResponse: Promise<Response | undefined> = Promise.resolve(undefined),
  ): Promise<Response> | null {
    let responded: Promise<Response> | null = null;
    const event: FetchEvent = {
      request,
      preloadResponse,
      respondWith: (response) => {
        responded = response;
      },
    };
    listeners.get("fetch")?.(event);
    return responded;
  }

  return {
    worker,
    caches,
    fetch,
    navigationPreload,
    install: () => extendable("install"),
    activate: () => extendable("activate"),
    dispatchFetch,
  };
}

/** A request as the browser makes it. Node's Request cannot be built with `mode: "navigate"`. */
function request(pathname: string, init: { mode?: RequestMode; method?: string } = {}): Request {
  const { mode = "navigate", method = "GET" } = init;
  const value = new Request(new URL(pathname, ORIGIN), { method });
  Object.defineProperty(value, "mode", { value: mode });
  return value;
}

async function installed(options?: Parameters<typeof loadWorker>[0]) {
  const sw = loadWorker(options);
  await sw.install();
  await sw.activate();
  sw.fetch.mockClear();
  return sw;
}

describe("install", () => {
  it("caches /offline.html alone, from the network, then takes over at once", async () => {
    const sw = loadWorker();
    await sw.install();

    expect([...sw.caches.caches.keys()]).toEqual([CACHE_NAME]);
    expect([...(sw.caches.caches.get(CACHE_NAME)?.entries.keys() ?? [])]).toEqual([OFFLINE_URL]);
    expect(sw.fetch).toHaveBeenCalledTimes(1);
    expect(sw.fetch.mock.calls[0]?.[0].cache).toBe("reload");
    expect(sw.worker.skipWaiting).toHaveBeenCalledTimes(1);
    expect(sw.fetch.mock.invocationCallOrder[0]).toBeLessThan(
      sw.worker.skipWaiting.mock.invocationCallOrder[0] ?? 0,
    );
  });
});

describe("activate", () => {
  it("deletes every other cache, enables navigation preload and claims the pages", async () => {
    const sw = loadWorker();
    await sw.caches.open("niho-finance-offline-v0");
    await sw.caches.open("something-else");
    await sw.install();
    await sw.activate();

    expect(await sw.caches.keys()).toEqual([CACHE_NAME]);
    expect(sw.navigationPreload?.enable).toHaveBeenCalledTimes(1);
    expect(sw.worker.clients.claim).toHaveBeenCalledTimes(1);
  });

  it("claims the pages without navigation preload too", async () => {
    const sw = loadWorker({ navigationPreload: false });
    await sw.install();
    await sw.activate();
    expect(sw.worker.clients.claim).toHaveBeenCalledTimes(1);
  });
});

describe("fetch", () => {
  it("leaves everything but GET navigations to the browser", async () => {
    const sw = await installed();
    // RSC and fetch() (cors), images and scripts (no-cors), a Server Action's POST, a form POST.
    expect(sw.dispatchFetch(request("/documents?_rsc=1", { mode: "cors" }))).toBeNull();
    expect(sw.dispatchFetch(request("/icons/icon-192.png", { mode: "no-cors" }))).toBeNull();
    expect(sw.dispatchFetch(request("/api/documents/prepare", { mode: "same-origin" }))).toBeNull();
    expect(sw.dispatchFetch(request("/entries/new", { mode: "cors", method: "POST" }))).toBeNull();
    expect(sw.dispatchFetch(request("/entries/new", { method: "POST" }))).toBeNull();
    expect(sw.fetch).not.toHaveBeenCalled();
  });

  it("answers a navigation with the network's response as it is, and caches nothing", async () => {
    const page = new Response("<p>ホーム</p>", { headers: { "content-type": "text/html" } });
    const sw = await installed({ network: () => Promise.resolve(page) });
    const navigation = request("/statements");

    const response = await sw.dispatchFetch(navigation);

    expect(response).toBe(page);
    expect(sw.fetch).toHaveBeenCalledWith(navigation);
    expect(sw.caches.writes).toEqual([OFFLINE_URL]);
  });

  it("uses the navigation preload response when there is one", async () => {
    const preloaded = new Response("<p>明細</p>");
    const sw = await installed({ network: () => Promise.resolve(new Response("not this")) });

    const response = await sw.dispatchFetch(request("/statements"), Promise.resolve(preloaded));

    expect(response).toBe(preloaded);
    expect(sw.fetch).not.toHaveBeenCalled();
  });

  it("shows 接続がない画面 only when the connection failed", async () => {
    const sw = await installed({
      network: () => Promise.reject(new TypeError("Failed to fetch")),
    });

    const response = await sw.dispatchFetch(request("/documents"));

    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe(offlineHtml);
    expect(sw.caches.writes).toEqual([OFFLINE_URL]);
  });

  it("shows 接続がない画面 when the navigation preload failed", async () => {
    const sw = await installed();
    const preload = Promise.reject<Response | undefined>(new TypeError("Failed to fetch"));

    const response = await sw.dispatchFetch(request("/"), preload);

    expect(await response?.text()).toBe(offlineHtml);
  });

  it("passes HTTP errors and redirects (IAP's sign-in) through unchanged", async () => {
    const failing = new Response("error", { status: 500 });
    const signIn = Response.redirect("https://sign-in.example.test/", 302);
    const serverError = await installed({ network: () => Promise.resolve(failing) });
    const redirect = await installed({ network: () => Promise.resolve(signIn) });

    expect(await serverError.dispatchFetch(request("/reports"))).toBe(failing);
    expect(await redirect.dispatchFetch(request("/reports"))).toBe(signIn);
    expect(serverError.caches.writes).toEqual([OFFLINE_URL]);
    expect(redirect.caches.writes).toEqual([OFFLINE_URL]);
  });

  it("returns a network error when 接続がない画面 is not cached either", async () => {
    const sw = loadWorker();
    const response = await sw.dispatchFetch(request("/"));
    expect(response?.type).toBe("error");
  });
});

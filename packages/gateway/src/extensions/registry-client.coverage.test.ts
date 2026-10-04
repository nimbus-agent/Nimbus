import { afterEach, describe, expect, jest, test } from "bun:test";

import { createPublisherKeyFetcher, createRegistryClient } from "./registry-client.ts";

/**
 * Edge coverage for the registry client: the non-2xx-but-below-400 publisher-key answer, a body
 * of the right LENGTH that decodes to the wrong number of bytes, non-`Error` rejections, the
 * defaulted global `fetch`, both abort paths (the client's own timeout and the caller's signal),
 * and the manifest/latest response shapes the main suite leaves out. Timeouts run on a fake
 * clock, so nothing here waits on real time.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = realFetch;
});

const VALID_MANIFEST = {
  id: "com.example.a",
  version: "1.1.0",
  updateChannel: "stable",
  publisher: { id: "pub", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
  signature: `${"A".repeat(86)}==`,
  permissions: { network: [], filesystem: { read: [], write: [] } },
};

function respondWith(make: () => Response, urls: string[] = []): typeof fetch {
  return (async (url: unknown) => {
    urls.push(String(url));
    return make();
  }) as unknown as typeof fetch;
}

/** A fetch that never answers on its own and rejects only once its signal aborts. */
function hangingFetch(signals: AbortSignal[]): typeof fetch {
  return ((_url: unknown, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    if (signal) signals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted by signal")));
    });
  }) as unknown as typeof fetch;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * Yields microtasks until `done()` holds (bounded), never waiting on a timer. A test on the fake
 * clock must check that its request SETTLED this way before awaiting it: under fake timers bun's
 * per-test timeout never fires, so awaiting a request whose abort timer did not fire would hang the
 * whole test process instead of failing this test.
 */
async function flushUntil(done: () => boolean): Promise<void> {
  for (let i = 0; i < 1_000 && !done(); i++) await Promise.resolve();
}

describe("PublisherKeyFetcher — edge answers", () => {
  test("a non-ok status below 400 (304) is a registry_error, not a key", async () => {
    const f = createPublisherKeyFetcher({
      baseUrl: "https://reg.example",
      retries: 0,
      fetchFn: respondWith(() => new Response(null, { status: 304 })),
    });
    expect(await f.fetch("pub")).toEqual({
      kind: "registry_error",
      statusCode: 304,
      message: "HTTP 304",
    });
  });

  test("a 44-char body that decodes to 31 bytes is refused as a wrong-size key", async () => {
    const body = `${"A".repeat(42)}==`;
    expect(body).toHaveLength(44);
    const f = createPublisherKeyFetcher({
      baseUrl: "https://reg.example",
      fetchFn: respondWith(() => new Response(body, { status: 200 })),
    });
    const out = await f.fetch("pub");
    expect(out).toEqual({
      kind: "registry_error",
      statusCode: 200,
      message: "publisher key body did not decode to 32 bytes",
    });
  });

  test("a non-Error rejection is a transient failure carrying its String() form", async () => {
    let calls = 0;
    const f = createPublisherKeyFetcher({
      baseUrl: "https://reg.example",
      retries: 0,
      fetchFn: (() => {
        calls += 1;
        return Promise.reject("socket hang up");
      }) as unknown as typeof fetch,
    });
    expect(await f.fetch("pub")).toEqual({ kind: "transient", message: "socket hang up" });
    expect(calls).toBe(1);
  });

  test("without fetchFn it uses the global fetch, at <baseUrl>/publishers/<id>.key", async () => {
    const urls: string[] = [];
    globalThis.fetch = respondWith(() => new Response("", { status: 404 }), urls);
    const f = createPublisherKeyFetcher({ baseUrl: "https://reg.example/" });
    expect(await f.fetch("acme")).toEqual({ kind: "not_found" });
    expect(urls).toEqual(["https://reg.example/publishers/acme.key"]);
  });

  test("an attempt that outlives timeoutMs is aborted and surfaces as transient", async () => {
    jest.useFakeTimers();
    const signals: AbortSignal[] = [];
    const f = createPublisherKeyFetcher({
      baseUrl: "https://reg.example",
      timeoutMs: 2_000,
      retries: 0,
      fetchFn: hangingFetch(signals),
    });
    let settled = false;
    const pending = f.fetch("slow").finally(() => {
      settled = true;
    });

    jest.advanceTimersByTime(1_999);
    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(signals[0]?.aborted).toBe(false);

    jest.advanceTimersByTime(1);
    await flushUntil(() => settled);
    expect(settled).toBe(true);
    expect(await pending).toEqual({ kind: "transient", message: "aborted by signal" });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe("createRegistryClient — fetchLatestVersion shapes", () => {
  test("accepts the beta channel and requests it explicitly", async () => {
    const urls: string[] = [];
    const client = createRegistryClient({
      baseUrl: "https://r",
      fetchFn: respondWith(
        () =>
          new Response(JSON.stringify({ version: "2.0.0-beta.1", channel: "beta" }), {
            status: 200,
          }),
        urls,
      ),
    });
    const res = await client.fetchLatestVersion("com.ex/a", "beta", new AbortController().signal);
    expect(res).toEqual({ version: "2.0.0-beta.1", channel: "beta" });
    expect(urls).toEqual(["https://r/v1/extensions/com.ex%2Fa/latest?channel=beta"]);
  });

  test("rejects a non-string version even when the channel is valid", async () => {
    const client = createRegistryClient({
      baseUrl: "https://r",
      fetchFn: respondWith(
        () => new Response(JSON.stringify({ version: 3, channel: "stable" }), { status: 200 }),
      ),
    });
    await expect(
      client.fetchLatestVersion("com.example.a", "stable", new AbortController().signal),
    ).rejects.toThrow('registry latest schema invalid: {"version":3,"channel":"stable"}');
  });

  test("rejects a channel that is neither stable nor beta", async () => {
    const client = createRegistryClient({
      baseUrl: "https://r",
      fetchFn: respondWith(
        () =>
          new Response(JSON.stringify({ version: "1.0.0", channel: "nightly" }), { status: 200 }),
      ),
    });
    await expect(
      client.fetchLatestVersion("com.example.a", "stable", new AbortController().signal),
    ).rejects.toThrow(/registry latest schema invalid: .*nightly/);
  });

  test("without fetchFn it uses the global fetch", async () => {
    const urls: string[] = [];
    globalThis.fetch = respondWith(() => new Response("gone", { status: 404 }), urls);
    const client = createRegistryClient({ baseUrl: "https://r/" });
    expect(
      await client.fetchLatestVersion("com.example.a", "stable", new AbortController().signal),
    ).toBeNull();
    expect(urls).toEqual(["https://r/v1/extensions/com.example.a/latest?channel=stable"]);
  });

  test("a caller abort reaches the in-flight request through the client's own signal", async () => {
    // On the fake clock the client's OWN timeout can never fire, so only the forwarded caller abort
    // can end this request. On the real clock the client's 10 s timer ends it anyway, so the same
    // test would pass (just slowly) with the forwarding removed.
    jest.useFakeTimers();
    const signals: AbortSignal[] = [];
    const client = createRegistryClient({ baseUrl: "https://r", fetchFn: hangingFetch(signals) });
    const caller = new AbortController();
    let rejection: unknown;
    let settled = false;
    void client.fetchLatestVersion("com.example.a", "stable", caller.signal).then(
      () => {
        settled = true;
      },
      (e: unknown) => {
        rejection = e;
        settled = true;
      },
    );

    expect(signals).toHaveLength(1);
    // The request carries the client's LOCAL signal, not the caller's — the caller's abort
    // is forwarded to it.
    expect(signals[0]).not.toBe(caller.signal);
    expect(signals[0]?.aborted).toBe(false);
    caller.abort();
    expect(signals[0]?.aborted).toBe(true);
    await flushUntil(() => settled);
    expect(settled).toBe(true);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe("aborted by signal");
  });

  test("a request that outlives timeoutMs is aborted by the client itself", async () => {
    jest.useFakeTimers();
    const signals: AbortSignal[] = [];
    const client = createRegistryClient({
      baseUrl: "https://r",
      timeoutMs: 500,
      fetchFn: hangingFetch(signals),
    });
    const caller = new AbortController();
    const pending = client.fetchLatestVersion("com.example.a", "stable", caller.signal);
    let settled = false;
    void pending
      .catch(() => {})
      .finally(() => {
        settled = true;
      });

    jest.advanceTimersByTime(499);
    await flushMicrotasks();
    expect(settled).toBe(false);

    jest.advanceTimersByTime(1);
    await flushUntil(() => settled);
    expect(settled).toBe(true);
    await expect(pending).rejects.toThrow("aborted by signal");
    expect(caller.signal.aborted).toBe(false);
  });
});

describe("createRegistryClient — fetchManifest shapes", () => {
  test("a 404 is a hard 'manifest not found' error naming id@version", async () => {
    const client = createRegistryClient({
      baseUrl: "https://r",
      fetchFn: respondWith(() => new Response("nope", { status: 404 })),
    });
    await expect(
      client.fetchManifest("com.example.a", "9.9.9", new AbortController().signal),
    ).rejects.toThrow("registry manifest not found: com.example.a@9.9.9");
  });

  test("a non-numeric tarballSizeBytes is dropped rather than passed through", async () => {
    const client = createRegistryClient({
      baseUrl: "https://r",
      fetchFn: respondWith(
        () =>
          new Response(
            JSON.stringify({
              manifest: VALID_MANIFEST,
              manifestHash: "d".repeat(64),
              entryHash: "e".repeat(64),
              tarballUrl: "https://r/a-1.1.0.tar.gz",
              tarballSizeBytes: "4242",
            }),
            { status: 200 },
          ),
      ),
    });
    const res = await client.fetchManifest("com.example.a", "1.1.0", new AbortController().signal);
    expect(res.manifest.id).toBe("com.example.a");
    expect(res.entryHash).toBe("e".repeat(64));
    expect("tarballSizeBytes" in res).toBe(false);
  });
});

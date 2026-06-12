import { describe, expect, test } from "bun:test";
import { Anonymous, BearerPat, QueryStringToken } from "./auth.ts";
import { ConnectorHttpClient, ConnectorHttpError } from "./http.ts";
import { GithubStyleHeaders, NoopObserver } from "./rate-limit-observer.ts";

describe("ConnectorHttpClient", () => {
  test("applies BearerPat auth", async () => {
    let captured: Headers | undefined;
    const client = new ConnectorHttpClient({
      auth: new BearerPat(async () => "tok"),
      observer: new NoopObserver(),
      fetch: async (_url, init) => {
        captured = new Headers(init?.headers);
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await client.get("https://api/x");
    expect(captured?.get("Authorization")).toBe("Bearer tok");
  });

  test("applies QueryStringToken to URL", async () => {
    let capturedUrl: string | undefined;
    const client = new ConnectorHttpClient({
      auth: new QueryStringToken("api_token", async () => "secret"),
      observer: new NoopObserver(),
      fetch: async (url) => {
        capturedUrl = url.toString();
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await client.get("https://api/x");
    expect(capturedUrl).toContain("api_token=secret");
  });

  test("returns parsed JSON body and headers", async () => {
    const client = new ConnectorHttpClient({
      auth: new Anonymous(),
      observer: new NoopObserver(),
      fetch: async () =>
        new Response(JSON.stringify({ items: [1, 2] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const resp = await client.get<{ items: number[] }>("https://api/x");
    expect(resp.body).toEqual({ items: [1, 2] });
    expect(resp.status).toBe(200);
  });

  test("invokes rate-limit observer", async () => {
    const obs = new GithubStyleHeaders();
    const client = new ConnectorHttpClient({
      auth: new Anonymous(),
      observer: obs,
      fetch: async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "5",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 10),
          },
        }),
    });
    const resp = await client.get("https://api/x");
    expect(resp.rateLimit?.remaining).toBe(5);
  });

  test("throws on non-2xx with response body in error", async () => {
    const client = new ConnectorHttpClient({
      auth: new Anonymous(),
      observer: new NoopObserver(),
      fetch: async () => new Response("not found", { status: 404 }),
    });
    await expect(client.get("https://api/x")).rejects.toThrow(/404/);
  });

  // --- Additional branch coverage ---

  test("returns text body when content-type is not application/json", async () => {
    const client = new ConnectorHttpClient({
      auth: new Anonymous(),
      observer: new NoopObserver(),
      fetch: async () =>
        new Response("plain text response", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    });
    const resp = await client.get<string>("https://api/x");
    expect(resp.body).toBe("plain text response");
    expect(resp.status).toBe(200);
  });

  test("returns text body when content-type header is absent (null ?? '')", async () => {
    const client = new ConnectorHttpClient({
      auth: new Anonymous(),
      observer: new NoopObserver(),
      fetch: async () =>
        new Response("raw body", {
          status: 200,
          // No content-type header — exercises the ?? "" branch
        }),
    });
    const resp = await client.get<string>("https://api/x");
    expect(resp.body).toBe("raw body");
  });

  test("passes custom init.method through to fetch", async () => {
    let capturedMethod: string | undefined;
    const client = new ConnectorHttpClient({
      auth: new Anonymous(),
      observer: new NoopObserver(),
      fetch: async (_url, init) => {
        capturedMethod = init?.method;
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await client.get("https://api/x", { method: "POST" });
    expect(capturedMethod).toBe("POST");
  });

  test("defaults init.method to GET when not provided", async () => {
    let capturedMethod: string | undefined;
    const client = new ConnectorHttpClient({
      auth: new Anonymous(),
      observer: new NoopObserver(),
      fetch: async (_url, init) => {
        capturedMethod = init?.method;
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await client.get("https://api/x");
    expect(capturedMethod).toBe("GET");
  });

  test("passes additional init headers to auth.apply", async () => {
    let captured: Headers | undefined;
    const client = new ConnectorHttpClient({
      auth: new BearerPat(async () => "mytoken"),
      observer: new NoopObserver(),
      fetch: async (_url, init) => {
        captured = new Headers(init?.headers);
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await client.get("https://api/x", {
      headers: { "X-Custom-Header": "custom-value" },
    });
    // Auth header is applied on top of the provided headers
    expect(captured?.get("Authorization")).toBe("Bearer mytoken");
    expect(captured?.get("X-Custom-Header")).toBe("custom-value");
  });

  test("ConnectorHttpError includes status, url, and bodyText properties", async () => {
    const client = new ConnectorHttpClient({
      auth: new Anonymous(),
      observer: new NoopObserver(),
      fetch: async () => new Response("unauthorized error body", { status: 401 }),
    });
    let caught: unknown;
    try {
      await client.get("https://api/protected");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConnectorHttpError);
    const httpErr = caught as ConnectorHttpError;
    expect(httpErr.status).toBe(401);
    expect(httpErr.url).toContain("https://api/protected");
    expect(httpErr.bodyText).toBe("unauthorized error body");
    expect(httpErr.message).toContain("401");
    expect(httpErr.message).toContain("https://api/protected");
  });

  test("ConnectorHttpError truncates bodyText to 200 chars in message", async () => {
    const longBody = "x".repeat(300);
    const client = new ConnectorHttpClient({
      auth: new Anonymous(),
      observer: new NoopObserver(),
      fetch: async () => new Response(longBody, { status: 500 }),
    });
    let caught: unknown;
    try {
      await client.get("https://api/x");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConnectorHttpError);
    const httpErr = caught as ConnectorHttpError;
    // bodyText stores the full text; the message truncates to 200
    expect(httpErr.bodyText).toBe(longBody);
    // message is built with bodyText.slice(0, 200) so it won't contain all 300 chars
    expect(httpErr.message.length).toBeLessThan(longBody.length);
    expect(httpErr.message).toContain("x".repeat(200));
    // but the message should NOT contain the 201st character's segment as extra
    expect(httpErr.message).not.toContain("x".repeat(201));
  });

  test("uses globalThis.fetch when no fetch option provided", async () => {
    const originalFetch = globalThis.fetch;
    let globalFetchCalled = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
      globalFetchCalled = true;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const client = new ConnectorHttpClient({
        auth: new Anonymous(),
        observer: new NoopObserver(),
        // No fetch option — exercises the ?? globalThis.fetch branch
      });
      const resp = await client.get<{ ok: boolean }>("https://api/x");
      expect(globalFetchCalled).toBe(true);
      expect(resp.body).toEqual({ ok: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("ConnectorHttpError", () => {
  test("message includes status, url, and truncated body", () => {
    const err = new ConnectorHttpError(403, "https://example.com/api", "Forbidden");
    expect(err.status).toBe(403);
    expect(err.url).toBe("https://example.com/api");
    expect(err.bodyText).toBe("Forbidden");
    expect(err.message).toBe("HTTP 403 from https://example.com/api: Forbidden");
  });

  test("message body is truncated at 200 characters", () => {
    const longBody = "A".repeat(300);
    const err = new ConnectorHttpError(500, "https://example.com/api", longBody);
    expect(err.bodyText).toBe(longBody);
    expect(err.message).toBe(`HTTP 500 from https://example.com/api: ${"A".repeat(200)}`);
  });
});

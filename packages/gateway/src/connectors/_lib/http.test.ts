import { describe, expect, test } from "bun:test";
import { Anonymous, BearerPat, QueryStringToken } from "./auth.ts";
import { ConnectorHttpClient } from "./http.ts";
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
});
